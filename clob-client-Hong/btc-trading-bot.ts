/**
 * 🤖 BTC 5分鐘預測市場自動交易機器人
 * 
 * 功能：
 * 1. 每秒監控當前 BTC Up/Down 市場的勝率
 * 2. 當某方向勝率達到閾值時自動買入
 * 3. 同時設定止損限價單
 * 
 * ⚠️ 風險警告：自動交易有風險，請謹慎使用！
 */

import { ethers } from "ethers";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { ClobClient, Chain, Side, OrderType, type ApiKeyCreds } from "./src/index.ts";

dotenvConfig({ path: resolve(import.meta.dirname, ".env") });

// ============================================
// 🎛️ 交易配置 - 根據你的需求調整
// ============================================
const CONFIG = {
    // 買入閾值: 當勝率達到這個值時買入 (0.97 = 97%)
    BUY_THRESHOLD: 0.97,
    
    // 止損百分比 (0.05 = 5%)
    STOP_LOSS_PERCENT: 0.05,
    
    // 每次買入金額 (USDC)
    BUY_AMOUNT: 10,
    
    // 最大持倉數量（防止重複買入）
    MAX_POSITIONS: 1,
    
    // 監控間隔 (毫秒) - 1000 = 1秒
    POLL_INTERVAL: 1000,
    
    // 市場類型配置
    TICK_SIZE: "0.01" as const,
    NEG_RISK: false,
    
    // 簽名類型: 0 = MetaMask, 1 = Magic/Email
    SIGNATURE_TYPE: 0,
    
    // 市場搜索關鍵字（可修改為其他市場類型）
    // 例如: "btc-updown-5m", "eth-updown", "trump", 等
    MARKET_SEARCH_KEYWORDS: ["btc-updown-5m"],
    
    // 或者直接指定一個市場 Slug（留空則自動根據時間計算）
    // 例如: "btc-updown-5m-1774720200"
    SPECIFIC_MARKET_SLUG: "",
};

// ============================================
// 🔧 狀態管理
// ============================================
interface BotState {
    isRunning: boolean;
    currentMarket: any | null;
    currentPosition: any | null;
    stopLossOrderId: string | null;
    lastPrices: { up: number; down: number };
}

const state: BotState = {
    isRunning: false,
    currentMarket: null,
    currentPosition: null,
    stopLossOrderId: null,
    lastPrices: { up: 0, down: 0 },
};

// ============================================
// 📊 獲取當前活躍的 BTC 5分鐘市場
// ============================================
async function getCurrentBTC5MinMarket(): Promise<any | null> {
    try {
        // 如果指定了特定市場
        if (CONFIG.SPECIFIC_MARKET_SLUG) {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets?slug=${CONFIG.SPECIFIC_MARKET_SLUG}`
            );
            const markets = await response.json();
            if (markets && markets.length > 0) {
                return markets[0];
            }
            return null;
        }
        
        // 自動計算當前時間窗口的 BTC 5分鐘市場
        const now = Math.floor(Date.now() / 1000);
        const currentWindow = Math.floor(now / 300) * 300; // 當前5分鐘窗口
        const nextWindow = currentWindow + 300; // 下一個5分鐘窗口
        
        // 嘗試獲取當前和下一個窗口的市場
        const windowsToTry = [currentWindow, nextWindow, currentWindow - 300];
        
        for (const timestamp of windowsToTry) {
            const slug = `btc-updown-5m-${timestamp}`;
            
            try {
                const response = await fetch(
                    `https://gamma-api.polymarket.com/markets?slug=${slug}`
                );
                const markets = await response.json();
                
                if (markets && markets.length > 0) {
                    const market = markets[0];
                    
                    // 只返回活躍且未關閉的市場
                    if (market.active && !market.closed) {
                        return market;
                    }
                }
            } catch {
                // 忽略單個請求失敗
            }
        }
        
        // 如果沒找到5分鐘市場，回退到一般搜索
        const response = await fetch(
            "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100"
        );
        const markets = await response.json();
        
        // 根據關鍵字過濾
        const matchedMarket = markets.find((m: any) => {
            if (!m.slug) return false;
            const slugLower = m.slug.toLowerCase();
            const questionLower = (m.question || "").toLowerCase();
            
            return CONFIG.MARKET_SEARCH_KEYWORDS.some(keyword => 
                slugLower.includes(keyword.toLowerCase()) || 
                questionLower.includes(keyword.toLowerCase())
            );
        });
        
        return matchedMarket || null;
    } catch (error) {
        console.error("❌ 獲取市場失敗:", error);
        return null;
    }
}

// ============================================
// 💹 獲取實時價格
// ============================================
async function getPrices(clobClient: ClobClient, tokenIds: { up: string; down: string }): Promise<{ up: number; down: number } | null> {
    try {
        const [upPrice, downPrice] = await Promise.all([
            clobClient.getPrice(tokenIds.up, Side.BUY),
            clobClient.getPrice(tokenIds.down, Side.BUY),
        ]);
        
        return {
            up: parseFloat(upPrice.price || "0"),
            down: parseFloat(downPrice.price || "0"),
        };
    } catch (error) {
        // 嘗試用另一種方式獲取
        try {
            const midpoints = await clobClient.getMidpoints([tokenIds.up, tokenIds.down]);
            return {
                up: parseFloat(midpoints[tokenIds.up] || "0"),
                down: parseFloat(midpoints[tokenIds.down] || "0"),
            };
        } catch {
            return null;
        }
    }
}

// ============================================
// 🎯 主要交易邏輯
// ============================================
async function executeTrade(
    clobClient: ClobClient,
    side: "UP" | "DOWN",
    tokenId: string,
    price: number
): Promise<boolean> {
    try {
        console.log(`\n🚀 執行買入: ${side} @ ${(price * 100).toFixed(2)}%`);
        
        // 計算買入數量
        const size = Math.floor(CONFIG.BUY_AMOUNT / price);
        
        // 下市價單買入
        const order = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: price,
                side: Side.BUY,
                size: size,
            },
            { tickSize: CONFIG.TICK_SIZE, negRisk: CONFIG.NEG_RISK },
            OrderType.GTC,
        );
        
        console.log(`✅ 買入成功:`, order);
        
        // 設定止損單
        const stopLossPrice = price * (1 - CONFIG.STOP_LOSS_PERCENT);
        console.log(`🛡️ 設定止損價: ${(stopLossPrice * 100).toFixed(2)}%`);
        
        const stopLossOrder = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: stopLossPrice,
                side: Side.SELL,
                size: size,
            },
            { tickSize: CONFIG.TICK_SIZE, negRisk: CONFIG.NEG_RISK },
            OrderType.GTC,
        );
        
        console.log(`✅ 止損單設定成功:`, stopLossOrder);
        
        state.currentPosition = { side, tokenId, price, size };
        state.stopLossOrderId = stopLossOrder.orderID || null;
        
        return true;
    } catch (error) {
        console.error(`❌ 交易失敗:`, error);
        return false;
    }
}

// ============================================
// 📺 顯示監控信息
// ============================================
function displayStatus(
    prices: { up: number; down: number }, 
    market: any,
    labels: { up: string; down: string } = { up: "Up", down: "Down" },
    timeRemaining: string = ""
) {
    const now = new Date().toLocaleTimeString("zh-TW");
    const upPercent = (prices.up * 100).toFixed(2);
    const downPercent = (prices.down * 100).toFixed(2);
    const threshold = (CONFIG.BUY_THRESHOLD * 100).toFixed(0);
    const positionStatus = state.currentPosition ? "持倉中" : "監控中";
    const timeInfo = timeRemaining ? ` | ⏱️ ${timeRemaining}` : "";
    
    // 清除上一行（同一行更新）
    process.stdout.write(`\r[${now}] 📊 ${labels.up}: ${upPercent}% | ${labels.down}: ${downPercent}% | 閾值: ${threshold}%${timeInfo} | ${positionStatus}    `);
    
    // 價格達到閾值時特別提示
    if (prices.up >= CONFIG.BUY_THRESHOLD) {
        console.log(`\n🔔 ${labels.up} 達到閾值 ${upPercent}% >= ${threshold}%!`);
    }
    if (prices.down >= CONFIG.BUY_THRESHOLD) {
        console.log(`\n🔔 ${labels.down} 達到閾值 ${downPercent}% >= ${threshold}%!`);
    }
}

// ============================================
// 🤖 主循環
// ============================================
async function runBot(clobClient: ClobClient, readOnly: boolean = true) {
    console.log("\n" + "=".repeat(60));
    console.log("🤖 BTC 5分鐘預測市場監控機器人啟動");
    console.log("=".repeat(60));
    console.log(`\n📋 配置:`);
    console.log(`   買入閾值: ${(CONFIG.BUY_THRESHOLD * 100).toFixed(0)}%`);
    console.log(`   止損: ${(CONFIG.STOP_LOSS_PERCENT * 100).toFixed(0)}%`);
    console.log(`   買入金額: $${CONFIG.BUY_AMOUNT} USDC`);
    console.log(`   監控間隔: ${CONFIG.POLL_INTERVAL}ms`);
    console.log(`   模式: ${readOnly ? "⚠️ 唯讀模式（只監控不交易）" : "✅ 交易模式"}`);
    console.log(`   搜索關鍵字: ${CONFIG.MARKET_SEARCH_KEYWORDS.join(", ")}`);
    if (CONFIG.SPECIFIC_MARKET_SLUG) {
        console.log(`   指定市場: ${CONFIG.SPECIFIC_MARKET_SLUG}`);
    }
    console.log("\n按 Ctrl+C 停止\n");
    
    state.isRunning = true;
    
    while (state.isRunning) {
        try {
            // 1. 獲取當前活躍市場
            const market = await getCurrentBTC5MinMarket();
            
            if (!market) {
                process.stdout.write(`\r⏳ [${new Date().toLocaleTimeString("zh-TW")}] 搜索中... 關鍵字: ${CONFIG.MARKET_SEARCH_KEYWORDS.join(", ")}                    `);
                await sleep(5000);
                continue;
            }
            
            // 檢查市場是否變更
            if (state.currentMarket?.id !== market.id) {
                const endTime = market.endDate || market.end_date_iso;
                console.log(`\n\n📌 新市場: ${market.question}`);
                console.log(`   Slug: ${market.slug}`);
                console.log(`   到期: ${endTime}`);
                state.currentMarket = market;
                state.currentPosition = null; // 重置持倉
            }
            
            // 計算距離市場結束的時間
            const endTime = market.endDate || market.end_date_iso;
            let timeRemaining = "";
            if (endTime) {
                const endDate = new Date(endTime);
                const now = new Date();
                const diffSeconds = Math.floor((endDate.getTime() - now.getTime()) / 1000);
                
                if (diffSeconds <= 0) {
                    // 市場已結束，等待下一個
                    process.stdout.write(`\r⏳ 市場已結束，搜索下一個...                                        `);
                    await sleep(2000);
                    state.currentMarket = null; // 重置以觸發新市場搜索
                    continue;
                }
                
                const mins = Math.floor(diffSeconds / 60);
                const secs = diffSeconds % 60;
                timeRemaining = `剩餘 ${mins}:${secs.toString().padStart(2, '0')}`;
            }
            
            // 2. 獲取 token IDs 和結果標籤
            let tokenIds: { up: string; down: string } | null = null;
            let outcomeLabels = { up: "選項1", down: "選項2" }; // 默認標籤
            
            // 先從 outcomes 獲取標籤
            if (market.outcomes) {
                try {
                    const outcomes = typeof market.outcomes === "string" 
                        ? JSON.parse(market.outcomes) 
                        : market.outcomes;
                    if (Array.isArray(outcomes) && outcomes.length >= 2) {
                        outcomeLabels = { up: outcomes[0], down: outcomes[1] };
                    }
                } catch {
                    // 忽略解析錯誤
                }
            }
            
            if (market.tokens && market.tokens.length >= 2) {
                // 嘗試匹配 Up/Down
                let upToken = market.tokens.find((t: any) => 
                    t.outcome?.toLowerCase() === "up" || t.ticker?.toLowerCase().includes("up")
                );
                let downToken = market.tokens.find((t: any) => 
                    t.outcome?.toLowerCase() === "down" || t.ticker?.toLowerCase().includes("down")
                );
                
                // 如果沒找到 Up/Down，嘗試 Yes/No
                if (!upToken || !downToken) {
                    upToken = market.tokens.find((t: any) => 
                        t.outcome?.toLowerCase() === "yes" || t.ticker?.toLowerCase().includes("yes")
                    );
                    downToken = market.tokens.find((t: any) => 
                        t.outcome?.toLowerCase() === "no" || t.ticker?.toLowerCase().includes("no")
                    );
                }
                
                // 如果還是沒找到，直接用前兩個 token
                if (!upToken || !downToken) {
                    upToken = market.tokens[0];
                    downToken = market.tokens[1];
                }
                
                if (upToken && downToken) {
                    tokenIds = { up: upToken.token_id, down: downToken.token_id };
                    // 更新標籤為 token 的 outcome
                    if (upToken.outcome && downToken.outcome) {
                        outcomeLabels = { up: upToken.outcome, down: downToken.outcome };
                    }
                }
            }
            
            // 如果沒有 token 信息，嘗試從 CLOB 獲取
            if (!tokenIds && market.conditionId) {
                try {
                    const clobMarket = await clobClient.getMarket(market.conditionId);
                    if (clobMarket.tokens && clobMarket.tokens.length >= 2) {
                        tokenIds = {
                            up: clobMarket.tokens[0].token_id,
                            down: clobMarket.tokens[1].token_id,
                        };
                    }
                } catch {
                    // 忽略錯誤
                }
            }
            
            // 使用 outcomePrices 作為價格來源（如果沒有 tokens）
            let prices: { up: number; down: number } | null = null;
            
            if (market.outcomePrices) {
                const outcomeP = JSON.parse(market.outcomePrices);
                prices = {
                    up: parseFloat(outcomeP[0] || "0"),
                    down: parseFloat(outcomeP[1] || "0"),
                };
            }
            
            // 如果有 tokenIds，嘗試獲取更準確的價格
            if (tokenIds) {
                const livePrices = await getPrices(clobClient, tokenIds);
                if (livePrices && (livePrices.up > 0 || livePrices.down > 0)) {
                    prices = livePrices;
                }
            }
            
            if (!prices || (prices.up === 0 && prices.down === 0)) {
                console.log("\r⏳ 等待價格數據...                                          ");
                await sleep(CONFIG.POLL_INTERVAL);
                continue;
            }
            
            // 3. 顯示狀態
            state.lastPrices = prices;
            displayStatus(prices, market, outcomeLabels, timeRemaining);
            
            // 4. 檢查是否達到買入條件（只在非唯讀模式）
            if (!readOnly && !state.currentPosition && tokenIds) {
                if (prices.up >= CONFIG.BUY_THRESHOLD) {
                    console.log(`\n🎯 ${outcomeLabels.up} 達到買入條件！`);
                    await executeTrade(clobClient, "UP", tokenIds.up, prices.up);
                } else if (prices.down >= CONFIG.BUY_THRESHOLD) {
                    console.log(`\n🎯 ${outcomeLabels.down} 達到買入條件！`);
                    await executeTrade(clobClient, "DOWN", tokenIds.down, prices.down);
                }
            }
            
            // 5. 等待下一個週期
            await sleep(CONFIG.POLL_INTERVAL);
            
        } catch (error) {
            console.error("\n❌ 循環錯誤:", error);
            await sleep(5000);
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// 🚀 啟動
// ============================================
async function main() {
    const chainId = parseInt(`${process.env.CHAIN_ID || 137}`) as Chain;
    const apiUrl = process.env.CLOB_API_URL || "https://clob.polymarket.com";
    const pk = process.env.PK || "";
    
    let clobClient: ClobClient;
    let readOnly = true;
    
    // 檢查是否有私鑰和 API 密鑰
    if (pk && pk.length === 66 && pk.startsWith("0x")) {
        const wallet = new ethers.Wallet(pk);
        const address = await wallet.getAddress();
        console.log(`\n🔑 錢包地址: ${address}`);
        
        // 檢查 API 密鑰
        if (process.env.CLOB_API_KEY && process.env.CLOB_SECRET && process.env.CLOB_PASS_PHRASE) {
            const creds: ApiKeyCreds = {
                key: process.env.CLOB_API_KEY,
                secret: process.env.CLOB_SECRET,
                passphrase: process.env.CLOB_PASS_PHRASE,
            };
            
            clobClient = new ClobClient(
                apiUrl,
                chainId,
                wallet,
                creds,
                CONFIG.SIGNATURE_TYPE
            );
            
            readOnly = false;
            console.log("✅ 交易模式已啟用");
        } else {
            console.log("⚠️  缺少 API 密鑰，使用唯讀模式");
            clobClient = new ClobClient(apiUrl, chainId, wallet);
        }
    } else {
        console.log("⚠️  未設置私鑰，使用唯讀模式（只監控不交易）");
        clobClient = new ClobClient(apiUrl, chainId);
    }
    
    // 處理中斷信號
    process.on("SIGINT", () => {
        console.log("\n\n🛑 停止機器人...");
        state.isRunning = false;
        process.exit(0);
    });
    
    // 啟動機器人
    await runBot(clobClient, readOnly);
}

main().catch(console.error);
