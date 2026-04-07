/**
 * 🤖 BTC 5分鐘預測市場自動交易機器人 (2026/02 新規優化版)
 * 
 * 功能：
 * 1. 【新增】整合 WebSocket 即時行情串流，取代慢速 REST 輪詢，實現毫秒級捕捉
 * 2. 【新增】動態手續費 (Taker Fee Rate) 感知與預扣計算，防止資產不足
 * 3. 達閾值時自動買入 (消除 500ms 延遲後的新版高頻執行)
 * 4. 同時設定止損限價單
 * 
 * ⚠️ 風險警告：自動交易有風險，請謹慎使用！
 */

import { ethers } from "ethers";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import WebSocket from "ws";
import { ClobClient, Chain, Side, OrderType, type ApiKeyCreds } from "@polymarket/clob-client";

dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

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
    
    // 監控間隔 (毫秒) - 用於 UI 顯示刷新與 REST 備援
    POLL_INTERVAL: 1000,
    
    // 市場類型配置
    TICK_SIZE: "0.01" as const,
    NEG_RISK: false,
    
    // 簽名類型: 0 = MetaMask, 1 = Magic/Email
    SIGNATURE_TYPE: 0,
    
    // 市場搜索關鍵字
    MARKET_SEARCH_KEYWORDS: ["btc-updown-5m"],
    
    // 指定一個市場 Slug
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

// WebSocket 客戶端實例
let wsClient: WebSocket | null = null;
let currentSubscribedTokens: { up: string, down: string } | null = null;

// ============================================
// 📊 獲取當前活躍的 BTC 5分鐘市場
// ============================================
async function getCurrentBTC5MinMarket(): Promise<any | null> {
    try {
        if (CONFIG.SPECIFIC_MARKET_SLUG) {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets?slug=${CONFIG.SPECIFIC_MARKET_SLUG}`
            );
            const markets = await response.json();
            if (markets && markets.length > 0) return markets[0];
            return null;
        }
        
        const now = Math.floor(Date.now() / 1000);
        const currentWindow = Math.floor(now / 300) * 300; 
        const nextWindow = currentWindow + 300; 
        
        const windowsToTry = [currentWindow, nextWindow, currentWindow - 300];
        
        for (const timestamp of windowsToTry) {
            const slug = `btc-updown-5m-${timestamp}`;
            try {
                const response = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
                const markets = await response.json();
                if (markets && markets.length > 0) {
                    const market = markets[0];
                    if (market.active && !market.closed) {
                        return market;
                    }
                }
            } catch { } // 忽略失敗
        }
        
        const response = await fetch(
            "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100"
        );
        const markets = await response.json();
        
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
// 💹 實時價格判定與 WS 訂閱 (2026 新增)
// ============================================
function subscribeToMarket(clobClient: ClobClient, tokenIds: { up: string, down: string }, outcomeLabels: any, readOnly: boolean) {
    if (wsClient) {
        wsClient.close();
    }
    
    currentSubscribedTokens = tokenIds;
    wsClient = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    
    wsClient.on("open", () => {
        wsClient?.send(JSON.stringify({
            assets_ids: [tokenIds.up, tokenIds.down],
            type: "market"
        }));
    });
    
    wsClient.on("message", async (data) => {
        try {
            const msgs = JSON.parse(data.toString());
            let updated = false;
            
            if (Array.isArray(msgs)) {
                for (const msg of msgs) {
                    if (msg.asset_id === tokenIds.up && msg.price) {
                        state.lastPrices.up = parseFloat(msg.price);
                        updated = true;
                    } else if (msg.asset_id === tokenIds.down && msg.price) {
                        state.lastPrices.down = parseFloat(msg.price);
                        updated = true;
                    }
                }
            }
            
            // WS 收到最新價格時立刻審查是否達成買入閾值
            if (updated && !readOnly && !state.currentPosition) {
                if (state.lastPrices.up >= CONFIG.BUY_THRESHOLD) {
                    console.log(`\n⚡ [WebSocket] ${outcomeLabels.up} 極速觸發買單！`);
                    await executeTrade(clobClient, "UP", tokenIds.up, state.lastPrices.up);
                } else if (state.lastPrices.down >= CONFIG.BUY_THRESHOLD) {
                    console.log(`\n⚡ [WebSocket] ${outcomeLabels.down} 極速觸發買單！`);
                    await executeTrade(clobClient, "DOWN", tokenIds.down, state.lastPrices.down);
                }
            }
        } catch (e) {
            // 忽略解析異常
        }
    });

    wsClient.on("close", () => { wsClient = null; });
    wsClient.on("error", () => { wsClient = null; });
}

// REST 備援獲取價格
async function getPricesREST(clobClient: ClobClient, tokenIds: { up: string; down: string }): Promise<{ up: number; down: number } | null> {
    try {
        const [upPrice, downPrice] = await Promise.all([
            clobClient.getPrice(tokenIds.up, Side.BUY),
            clobClient.getPrice(tokenIds.down, Side.BUY),
        ]);
        return {
            up: parseFloat(upPrice.price || "0"),
            down: parseFloat(downPrice.price || "0"),
        };
    } catch {
        return null;
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
    // 避免重複執行
    if (state.currentPosition) return false;
    // 先標註為鎖定
    state.currentPosition = { status: "pending" };

    try {
        console.log(`\n🚀 準備買入: ${side} @ ${(price * 100).toFixed(2)}%`);
        
        // 1. 獲取動態手續費 (Polymarket 2026/02 新規)
        let feeRateBps = 0;
        try {
            feeRateBps = await clobClient.getFeeRateBps(tokenId);
            console.log(`💰 當前市場 Taker 手續費率: ${(feeRateBps / 100).toFixed(4)}%`);
        } catch (e) {
            console.warn("⚠️ 獲取手續費率失敗，SDK 稍後會自動嘗試處理");
        }
        
        // 2. 扣除預估手續費，計算安全買入數量 (防止錢包餘額在扣除手續費後不足)
        const usableAmount = CONFIG.BUY_AMOUNT * (1 - (feeRateBps / 10000));
        const size = Math.floor(usableAmount / price);
        
        if (size <= 0) {
            console.error("❌ 計算出的可購買數量 <= 0，餘額或手續費不符要求");
            state.currentPosition = null;
            return false;
        }
        
        // 3. 下市價單買入 (Taker 取流動性，已取消 500ms 延遲)
        const order = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: price,
                side: Side.BUY,
                size: size,
                feeRateBps: feeRateBps > 0 ? feeRateBps : undefined, 
            },
            { tickSize: CONFIG.TICK_SIZE, negRisk: CONFIG.NEG_RISK },
            OrderType.GTC,
        );
        
        console.log(`✅ 買入成功:`, order);
        
        // 4. 設定止損單
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
        state.currentPosition = null;
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
    const positionStatus = state.currentPosition ? (state.currentPosition.status === "pending" ? "下單中" : "持倉中") : "監聽 WS 報價中";
    const timeInfo = timeRemaining ? ` | ⏱️ ${timeRemaining}` : "";
    
    process.stdout.write(`\r[${now}] 📊 ${labels.up}: ${upPercent}% | ${labels.down}: ${downPercent}% | 閾: ${threshold}%${timeInfo} | ${positionStatus}    `);
}

// ============================================
// 🤖 主循環
// ============================================
async function runBot(clobClient: ClobClient, readOnly: boolean = true) {
    console.log("\n" + "=".repeat(60));
    console.log("🤖 BTC 5分鐘預測市場監控機器人啟動 (WS+Fee-Aware 優化版)");
    console.log("=".repeat(60));
    console.log(`\n📋 配置:`);
    console.log(`   買入閾值: ${(CONFIG.BUY_THRESHOLD * 100).toFixed(0)}%`);
    console.log(`   止損: ${(CONFIG.STOP_LOSS_PERCENT * 100).toFixed(0)}%`);
    console.log(`   買入金額: $${CONFIG.BUY_AMOUNT} USDC`);
    console.log(`   UI 更新頻率: ${CONFIG.POLL_INTERVAL}ms`);
    console.log(`   模式: ${readOnly ? "⚠️ 唯讀模式（只監控不交易）" : "✅ 交易模式"}`);
    console.log(`   搜索關鍵字: ${CONFIG.MARKET_SEARCH_KEYWORDS.join(", ")}`);
    console.log("\n按 Ctrl+C 停止\n");
    
    state.isRunning = true;
    
    while (state.isRunning) {
        try {
            const market = await getCurrentBTC5MinMarket();
            
            if (!market) {
                process.stdout.write(`\r⏳ [${new Date().toLocaleTimeString("zh-TW")}] 搜索中... 關鍵字: ${CONFIG.MARKET_SEARCH_KEYWORDS.join(", ")}                    `);
                await sleep(5000);
                continue;
            }
            
            if (state.currentMarket?.id !== market.id) {
                const endTime = market.endDate || market.end_date_iso;
                console.log(`\n\n📌 新市場: ${market.question}`);
                console.log(`   到期: ${endTime}`);
                state.currentMarket = market;
                state.currentPosition = null;
                
                // 更換市場時強制重連 WS
                if (wsClient) {
                    wsClient.close();
                    wsClient = null;
                }
            }
            
            let timeRemaining = "";
            const endTime = market.endDate || market.end_date_iso;
            if (endTime) {
                const endDate = new Date(endTime);
                const diffSeconds = Math.floor((endDate.getTime() - new Date().getTime()) / 1000);
                
                if (diffSeconds <= 0) {
                    process.stdout.write(`\r⏳ 市場已結束，搜索下一個...                                        `);
                    await sleep(2000);
                    state.currentMarket = null;
                    continue;
                }
                const mins = Math.floor(diffSeconds / 60);
                const secs = diffSeconds % 60;
                timeRemaining = `剩餘 ${mins}:${secs.toString().padStart(2, '0')}`;
            }
            
            let tokenIds: { up: string; down: string } | null = null;
            let outcomeLabels = { up: "選項1", down: "選項2" };
            
            if (market.outcomes) {
                try {
                    const outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes;
                    if (Array.isArray(outcomes) && outcomes.length >= 2) outcomeLabels = { up: outcomes[0], down: outcomes[1] };
                } catch {}
            }
            
            if (market.tokens && market.tokens.length >= 2) {
                tokenIds = { up: market.tokens[0].token_id, down: market.tokens[1].token_id };
                if (market.tokens[0].outcome && market.tokens[1].outcome) {
                    outcomeLabels = { up: market.tokens[0].outcome, down: market.tokens[1].outcome };
                }
            } else if (market.conditionId) {
                try {
                    const clobMarket = await clobClient.getMarket(market.conditionId);
                    if (clobMarket.tokens && clobMarket.tokens.length >= 2) {
                        tokenIds = { up: clobMarket.tokens[0].token_id, down: clobMarket.tokens[1].token_id };
                    }
                } catch {}
            }
            
            if (tokenIds && (!wsClient || currentSubscribedTokens?.up !== tokenIds.up)) {
                subscribeToMarket(clobClient, tokenIds, outcomeLabels, readOnly);
            }
            
            // 如果 WS 尚未獲得報價，使用 REST 備援推動
            if (tokenIds && state.lastPrices.up === 0 && state.lastPrices.down === 0) {
                const livePrices = await getPricesREST(clobClient, tokenIds);
                if (livePrices && (livePrices.up > 0 || livePrices.down > 0)) {
                    state.lastPrices = livePrices;
                }
            }
            
            displayStatus(state.lastPrices, market, outcomeLabels, timeRemaining);
            
            // REST Backup trigger (防止 WS 異常未捕獲)
            if (!readOnly && !state.currentPosition && tokenIds) {
                if (state.lastPrices.up >= CONFIG.BUY_THRESHOLD) {
                    await executeTrade(clobClient, "UP", tokenIds.up, state.lastPrices.up);
                } else if (state.lastPrices.down >= CONFIG.BUY_THRESHOLD) {
                    await executeTrade(clobClient, "DOWN", tokenIds.down, state.lastPrices.down);
                }
            }
            
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
    
    if (pk && pk.length === 66 && pk.startsWith("0x")) {
        const wallet = new ethers.Wallet(pk);
        const address = await wallet.getAddress();
        console.log(`\n🔑 錢包地址: ${address}`);
        
        if (process.env.CLOB_API_KEY && process.env.CLOB_SECRET && process.env.CLOB_PASS_PHRASE) {
            const creds: ApiKeyCreds = {
                key: process.env.CLOB_API_KEY,
                secret: process.env.CLOB_SECRET,
                passphrase: process.env.CLOB_PASS_PHRASE,
            };
            clobClient = new ClobClient(apiUrl, chainId, wallet, creds, CONFIG.SIGNATURE_TYPE);
            readOnly = false;
            console.log("✅ 交易模式已啟用");
        } else {
            clobClient = new ClobClient(apiUrl, chainId, wallet);
        }
    } else {
        clobClient = new ClobClient(apiUrl, chainId);
    }
    
    process.on("SIGINT", () => {
        console.log("\n🛑 停止機器人...");
        state.isRunning = false;
        if (wsClient) wsClient.close();
        process.exit(0);
    });
    
    await runBot(clobClient, readOnly);
}

main().catch(console.error);
