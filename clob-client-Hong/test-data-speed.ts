/**
 * 🧪 數據更新速度測試工具
 * 
 * 比較不同數據獲取方式的延遲：
 * 1. Gamma API 輪詢
 * 2. CLOB API 輪詢
 * 3. WebSocket 實時
 */

import { WebSocket } from "ws";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { ClobClient, Chain, Side } from "./src/index.ts";

dotenvConfig({ path: resolve(import.meta.dirname, ".env") });

const TEST_DURATION = 10000; // 測試 10 秒

interface TestResult {
    method: string;
    updates: number;
    avgLatency: number;
    minLatency: number;
    maxLatency: number;
}

// ============================================
// 測試 1: Gamma API 輪詢
// ============================================
async function testGammaAPI(slug: string): Promise<TestResult> {
    console.log("\n📊 測試 Gamma API 輪詢...");
    
    const latencies: number[] = [];
    const startTime = Date.now();
    
    while (Date.now() - startTime < TEST_DURATION) {
        const fetchStart = Date.now();
        
        try {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets?slug=${slug}`
            );
            const data = await response.json();
            
            const latency = Date.now() - fetchStart;
            latencies.push(latency);
            
            if (data && data[0]?.outcomePrices) {
                process.stdout.write(`\rGamma: ${latency}ms    `);
            }
        } catch {
            // ignore
        }
        
        // 最快輪詢也需要一點間隔
        await sleep(100);
    }
    
    return {
        method: "Gamma API",
        updates: latencies.length,
        avgLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        minLatency: Math.min(...latencies),
        maxLatency: Math.max(...latencies),
    };
}

// ============================================
// 測試 2: CLOB API 輪詢
// ============================================
async function testClobAPI(tokenId: string, clobClient: ClobClient): Promise<TestResult> {
    console.log("\n📊 測試 CLOB API 輪詢...");
    
    const latencies: number[] = [];
    const startTime = Date.now();
    
    while (Date.now() - startTime < TEST_DURATION) {
        const fetchStart = Date.now();
        
        try {
            const price = await clobClient.getPrice(tokenId, Side.BUY);
            
            const latency = Date.now() - fetchStart;
            latencies.push(latency);
            
            process.stdout.write(`\rCLOB: ${latency}ms - ${price.price}    `);
        } catch {
            // ignore
        }
        
        await sleep(100);
    }
    
    return {
        method: "CLOB API",
        updates: latencies.length,
        avgLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        minLatency: Math.min(...latencies),
        maxLatency: Math.max(...latencies),
    };
}

// ============================================
// 測試 3: WebSocket 實時
// ============================================
async function testWebSocket(tokenId: string): Promise<TestResult> {
    console.log("\n📊 測試 WebSocket 實時...");
    
    return new Promise((resolve) => {
        const latencies: number[] = [];
        let lastUpdate = Date.now();
        let updates = 0;
        const startTime = Date.now();
        
        const wsUrl = process.env.WS_URL || "wss://ws-subscriptions-clob.polymarket.com";
        const ws = new WebSocket(`${wsUrl}/ws/market`);
        
        ws.on("open", () => {
            console.log("   WebSocket 已連接");
            
            ws.send(JSON.stringify({
                type: "market",
                assets_ids: [tokenId],
                initial_dump: true,
            }));
            
            // 心跳
            const pingInt = setInterval(() => ws.send("PING"), 30000);
            
            setTimeout(() => {
                clearInterval(pingInt);
                ws.close();
                
                resolve({
                    method: "WebSocket",
                    updates: updates,
                    avgLatency: latencies.length > 0 
                        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
                        : 0,
                    minLatency: latencies.length > 0 ? Math.min(...latencies) : 0,
                    maxLatency: latencies.length > 0 ? Math.max(...latencies) : 0,
                });
            }, TEST_DURATION);
        });
        
        ws.on("message", (data: Buffer) => {
            const msg = data.toString();
            if (msg === "PONG") return;
            
            try {
                const parsed = JSON.parse(msg);
                if (parsed) {
                    const now = Date.now();
                    const latency = now - lastUpdate;
                    lastUpdate = now;
                    
                    if (updates > 0) { // 跳過第一次
                        latencies.push(latency);
                    }
                    updates++;
                    
                    process.stdout.write(`\rWebSocket: 更新 #${updates} - 間隔 ${latency}ms    `);
                }
            } catch {
                // ignore
            }
        });
        
        ws.on("error", (err) => {
            console.error("   WebSocket 錯誤:", err.message);
        });
    });
}

// ============================================
// 主程序
// ============================================
async function main() {
    console.log("=".repeat(60));
    console.log("🧪 數據更新速度測試工具");
    console.log("=".repeat(60));
    console.log(`測試時長: ${TEST_DURATION / 1000} 秒/每種方法\n`);
    
    const chainId = parseInt(`${process.env.CHAIN_ID || 137}`) as Chain;
    const apiUrl = process.env.CLOB_API_URL || "https://clob.polymarket.com";
    const clobClient = new ClobClient(apiUrl, chainId);
    
    // 獲取一個活躍市場用於測試
    console.log("🔍 尋找測試市場...");
    
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(now / 300) * 300;
    const slug = `btc-updown-5m-${currentWindow}`;
    
    let market: any = null;
    let tokenId: string | null = null;
    
    // 嘗試幾個時間窗口
    for (const ts of [currentWindow, currentWindow + 300, currentWindow - 300]) {
        try {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`
            );
            const markets = await response.json();
            
            if (markets && markets.length > 0 && markets[0].active && !markets[0].closed) {
                market = markets[0];
                
                if (market.tokens && market.tokens.length > 0) {
                    tokenId = market.tokens[0].token_id;
                }
                break;
            }
        } catch {
            // continue
        }
    }
    
    if (!market || !tokenId) {
        console.log("❌ 找不到活躍的 BTC 5分鐘市場，嘗試其他市場...");
        
        // 找任何活躍市場
        try {
            const response = await fetch(
                "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10"
            );
            const markets = await response.json();
            
            for (const m of markets) {
                if (m.tokens && m.tokens.length > 0 && m.tokens[0].token_id) {
                    market = m;
                    tokenId = m.tokens[0].token_id;
                    break;
                }
            }
        } catch {
            console.log("❌ 無法獲取任何市場");
            return;
        }
    }
    
    if (!market || !tokenId) {
        console.log("❌ 無法找到可用的測試市場");
        return;
    }
    
    console.log(`✅ 測試市場: ${market.question || market.slug}`);
    console.log(`   Token ID: ${tokenId.slice(0, 30)}...`);
    console.log(`   Slug: ${market.slug}`);
    
    const results: TestResult[] = [];
    
    // 運行測試
    results.push(await testGammaAPI(market.slug));
    results.push(await testClobAPI(tokenId, clobClient));
    results.push(await testWebSocket(tokenId));
    
    // 顯示結果
    console.log("\n\n" + "=".repeat(60));
    console.log("📊 測試結果比較");
    console.log("=".repeat(60));
    console.log("\n");
    
    console.log("| 方法 | 更新次數 | 平均延遲 | 最小延遲 | 最大延遲 |");
    console.log("|------|---------|---------|---------|---------|");
    
    for (const r of results) {
        console.log(
            `| ${r.method.padEnd(10)} | ${r.updates.toString().padStart(7)} | ${r.avgLatency.toString().padStart(6)}ms | ${r.minLatency.toString().padStart(6)}ms | ${r.maxLatency.toString().padStart(6)}ms |`
        );
    }
    
    console.log("\n📈 結論:");
    const wsResult = results.find(r => r.method === "WebSocket");
    const gammaResult = results.find(r => r.method === "Gamma API");
    
    if (wsResult && gammaResult && wsResult.updates > gammaResult.updates) {
        const improvement = Math.round((wsResult.updates / gammaResult.updates - 1) * 100);
        console.log(`   WebSocket 比 Gamma API 快約 ${improvement}% (更新頻率)`);
    }
    
    console.log("\n💡 建議:");
    console.log("   - 使用 WebSocket 獲取實時價格（毫秒級延遲）");
    console.log("   - 使用 CLOB API 作為備援");
    console.log("   - Gamma API 適合獲取市場元數據（不需要頻繁刷新）");
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
