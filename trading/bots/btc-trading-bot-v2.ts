/**
 * 🤖 BTC 5分鐘預測市場自動交易機器人 V2 - WebSocket 優化版
 * 
 * 優化點：
 * 1. WebSocket 實時連接 - 毫秒級價格更新
 * 2. 市場資訊快取 - 減少 Gamma API 請求
 * 3. 並行數據獲取 - 同時從多個來源獲取
 * 4. 備援機制 - WebSocket 斷線自動切換到輪詢
 * 
 * ⚠️ 風險警告：自動交易有風險，請謹慎使用！
 */

import { ethers } from "ethers";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { WebSocket } from "ws";
import { ClobClient, Chain, Side, OrderType, type ApiKeyCreds } from "../../clob-client-Hong/src/index.ts";

dotenvConfig({ path: resolve(import.meta.dirname, ".env") });

// ============================================
// 🎛️ 交易配置
// ============================================
const CONFIG = {
    // 買入閾值
    BUY_THRESHOLD: 0.97,
    
    // 止損百分比
    STOP_LOSS_PERCENT: 0.05,
    
    // 每次買入金額 (USDC)
    BUY_AMOUNT: 10,
    
    // 最大持倉數量
    MAX_POSITIONS: 1,
    
    // 市場配置
    TICK_SIZE: "0.01" as const,
    NEG_RISK: false,
    SIGNATURE_TYPE: 0,
    
    // 數據來源配置
    WEBSOCKET_URL: process.env.WS_URL || "wss://ws-subscriptions-clob.polymarket.com",
    GAMMA_API_URL: "https://gamma-api.polymarket.com",
    
    // 市場搜索
    MARKET_SEARCH_KEYWORDS: ["btc-updown-5m"],
    SPECIFIC_MARKET_SLUG: "",
    
    // 快取時間 (毫秒)
    MARKET_CACHE_TTL: 60000, // 60秒 - 避免頻繁請求
    
    // 輪詢間隔 (僅作為備援)
    FALLBACK_POLL_INTERVAL: 500,
    
    // WebSocket 配置
    WS_RECONNECT_DELAY: 1000,
    WS_PING_INTERVAL: 15000, // 15秒心跳
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
    wsConnected: boolean;
    lastMarketFetch: number;
    priceUpdateCount: number;
    lastPriceUpdate: number;
}

const state: BotState = {
    isRunning: false,
    currentMarket: null,
    currentPosition: null,
    stopLossOrderId: null,
    lastPrices: { up: 0, down: 0 },
    wsConnected: false,
    lastMarketFetch: 0,
    priceUpdateCount: 0,
    lastPriceUpdate: 0,
};

// Token IDs 快取
let cachedTokenIds: { up: string; down: string } | null = null;
let outcomeLabels = { up: "Up", down: "Down" };

// WebSocket 連接
let priceWebSocket: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let subscribedTokenIds: { up: string; down: string } | null = null;
let wsConnectionId = 0; // 連接序列號，用於避免舊連接干擾
let globalOnPriceCallback: ((prices: { up: number; down: number }) => void) | null = null;

// ============================================
// 📡 WebSocket 價格訂閱 - 毫秒級更新
// ============================================
function connectPriceWebSocket(tokenIds: { up: string; down: string }, onPrice: (prices: { up: number; down: number }) => void, isReconnect: boolean = false) {
    // 增加連接序列號
    wsConnectionId++;
    const thisConnectionId = wsConnectionId;
    
    // 更新全局回調和 token
    globalOnPriceCallback = onPrice;
    subscribedTokenIds = { ...tokenIds };
    
    // 清除舊心跳
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    
    // 關閉舊連接（移除事件監聽器避免干擾）
    if (priceWebSocket) {
        const oldWs = priceWebSocket;
        priceWebSocket = null;
        try {
            oldWs.removeAllListeners(); // 關鍵：移除所有事件監聽器
            oldWs.close();
        } catch {
            // 忽略關閉錯誤
        }
    }
    
    const wsUrl = `${CONFIG.WEBSOCKET_URL}/ws/market`;
    if (!isReconnect) {
        console.log(`\n📡 連接 WebSocket: ${wsUrl}`);
    }
    
    const ws = new WebSocket(wsUrl);
    priceWebSocket = ws;
    
    ws.on("open", () => {
        // 檢查是否是當前有效的連接
        if (wsConnectionId !== thisConnectionId) return;
        
        if (!isReconnect) {
            console.log("✅ WebSocket 連接成功");
        }
        state.wsConnected = true;
        
        // 訂閱 token
        const subscribeMsg = {
            type: "market",
            assets_ids: [subscribedTokenIds!.up, subscribedTokenIds!.down],
            initial_dump: true,
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        if (!isReconnect) {
            console.log(`📌 已訂閱 Token IDs: ${subscribedTokenIds!.up.slice(0, 20)}..., ${subscribedTokenIds!.down.slice(0, 20)}...`);
        }
        
        // 設定心跳
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN && wsConnectionId === thisConnectionId) {
                ws.send("PING");
            }
        }, CONFIG.WS_PING_INTERVAL);
    });
    
    ws.on("message", (data: Buffer) => {
        // 檢查是否是當前有效的連接
        if (wsConnectionId !== thisConnectionId) return;
        
        const msg = data.toString();
        if (msg === "PONG") return;
        if (!subscribedTokenIds || !globalOnPriceCallback) return;
        
        try {
            const parsed = JSON.parse(msg);
            const prices = { ...state.lastPrices };
            let hasUpdate = false;
            const currentTokens = subscribedTokenIds;
            
            if (parsed && Array.isArray(parsed)) {
                for (const item of parsed) {
                    const newPrice = parseFloat(item.price || item.mid || "0");
                    if (newPrice > 0) {
                        if (item.asset_id === currentTokens.up) {
                            prices.up = newPrice;
                            hasUpdate = true;
                        } else if (item.asset_id === currentTokens.down) {
                            prices.down = newPrice;
                            hasUpdate = true;
                        }
                    }
                }
            } else if (parsed.asset_id) {
                const newPrice = parseFloat(parsed.price || parsed.mid || "0");
                if (newPrice > 0) {
                    if (parsed.asset_id === currentTokens.up) {
                        prices.up = newPrice;
                        hasUpdate = true;
                    } else if (parsed.asset_id === currentTokens.down) {
                        prices.down = newPrice;
                        hasUpdate = true;
                    }
                }
            } else if (parsed.event === "book" || parsed.book) {
                const book = parsed.book || parsed;
                const assetId = parsed.asset_id || book.asset_id;
                
                if (book.bids && book.asks && assetId) {
                    const bestBid = book.bids[0]?.price ? parseFloat(book.bids[0].price) : 0;
                    const bestAsk = book.asks[0]?.price ? parseFloat(book.asks[0].price) : 0;
                    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
                    
                    if (mid > 0) {
                        if (assetId === currentTokens.up) {
                            prices.up = mid;
                            hasUpdate = true;
                        } else if (assetId === currentTokens.down) {
                            prices.down = mid;
                            hasUpdate = true;
                        }
                    }
                }
            }
            
            if (hasUpdate) {
                state.priceUpdateCount++;
                state.lastPriceUpdate = Date.now();
                globalOnPriceCallback(prices);
            }
        } catch (e) {
            // 忽略解析錯誤
        }
    });
    
    ws.on("error", (err) => {
        if (wsConnectionId !== thisConnectionId) return;
        state.wsConnected = false;
    });
    
    ws.on("close", (code, reason) => {
        // 只有當前有效的連接才處理重連
        if (wsConnectionId !== thisConnectionId) return;
        
        state.wsConnected = false;
        
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
        
        // 自動重連（使用全局回調）
        if (state.isRunning && subscribedTokenIds && globalOnPriceCallback) {
            const reconnectDelay = code === 1006 ? 2000 : CONFIG.WS_RECONNECT_DELAY;
            setTimeout(() => {
                // 再次檢查是否應該重連
                if (state.isRunning && subscribedTokenIds && globalOnPriceCallback && wsConnectionId === thisConnectionId) {
                    connectPriceWebSocket(subscribedTokenIds, globalOnPriceCallback, true);
                }
            }, reconnectDelay);
        }
    });
}

// ============================================
// 📊 獲取市場資訊（帶快取）
// ============================================
async function getCurrentBTC5MinMarket(): Promise<any | null> {
    // 檢查快取
    const now = Date.now();
    if (state.currentMarket && (now - state.lastMarketFetch) < CONFIG.MARKET_CACHE_TTL) {
        // 檢查市場是否仍有效
        const endTime = state.currentMarket.endDate || state.currentMarket.end_date_iso;
        if (endTime) {
            const endDate = new Date(endTime);
            if (endDate.getTime() > now) {
                return state.currentMarket;
            }
        }
    }
    
    try {
        // 計算當前時間窗口
        const nowSec = Math.floor(now / 1000);
        const currentWindow = Math.floor(nowSec / 300) * 300;
        const nextWindow = currentWindow + 300;
        
        // 同時請求多個可能的市場
        const slugs = CONFIG.SPECIFIC_MARKET_SLUG 
            ? [CONFIG.SPECIFIC_MARKET_SLUG]
            : [`btc-updown-5m-${currentWindow}`, `btc-updown-5m-${nextWindow}`];
        
        const promises = slugs.map(slug => 
            fetch(`${CONFIG.GAMMA_API_URL}/markets?slug=${slug}`)
                .then(r => r.json())
                .catch(() => [])
        );
        
        const results = await Promise.all(promises);
        
        for (const markets of results) {
            if (markets && markets.length > 0) {
                const market = markets[0];
                if (market.active && !market.closed) {
                    state.lastMarketFetch = now;
                    return market;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error("❌ 獲取市場失敗:", error);
        return null;
    }
}

// ============================================
// 💹 備援：輪詢獲取價格
// ============================================
async function getPricesFallback(clobClient: ClobClient, tokenIds: { up: string; down: string }): Promise<{ up: number; down: number } | null> {
    try {
        // 使用批量 API 減少請求
        const midpoints = await clobClient.getMidpoints([tokenIds.up, tokenIds.down]);
        return {
            up: parseFloat(midpoints[tokenIds.up] || "0"),
            down: parseFloat(midpoints[tokenIds.down] || "0"),
        };
    } catch {
        try {
            // 再試一次用 getPrice
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
}

// ============================================
// 🎯 交易執行
// ============================================
async function executeTrade(
    clobClient: ClobClient,
    side: "UP" | "DOWN",
    tokenId: string,
    price: number
): Promise<boolean> {
    try {
        console.log(`\n🚀 執行買入: ${side} @ ${(price * 100).toFixed(2)}%`);
        
        const size = Math.floor(CONFIG.BUY_AMOUNT / price);
        
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
        
        // 止損單
        const stopLossPrice = price * (1 - CONFIG.STOP_LOSS_PERCENT);
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
    timeRemaining: string = ""
) {
    const now = new Date().toLocaleTimeString("zh-TW");
    const upPercent = (prices.up * 100).toFixed(2);
    const downPercent = (prices.down * 100).toFixed(2);
    const positionStatus = state.currentPosition ? "持倉中" : "監控中";
    const connectionStatus = state.wsConnected ? "🟢 WS" : "🟡 Poll";
    
    process.stdout.write(
        `\r[${now}] ${connectionStatus} | ${outcomeLabels.up}: ${upPercent}% | ${outcomeLabels.down}: ${downPercent}% | ${timeRemaining} | ${positionStatus}    `
    );
}

// ============================================
// 🔄 提取 Token IDs
// ============================================
function extractTokenIds(market: any): { up: string; down: string } | null {
    // 方式 1: 從 clobTokenIds 獲取（Gamma API 格式）
    if (market.clobTokenIds) {
        try {
            const tokenIds = typeof market.clobTokenIds === "string" 
                ? JSON.parse(market.clobTokenIds) 
                : market.clobTokenIds;
            
            if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                // 獲取 outcomes 標籤
                if (market.outcomes) {
                    try {
                        const outcomes = typeof market.outcomes === "string"
                            ? JSON.parse(market.outcomes)
                            : market.outcomes;
                        if (Array.isArray(outcomes) && outcomes.length >= 2) {
                            outcomeLabels = { up: outcomes[0], down: outcomes[1] };
                        }
                    } catch {
                        // 使用默認標籤
                    }
                }
                
                console.log(`   Token IDs: ${tokenIds[0].slice(0, 20)}..., ${tokenIds[1].slice(0, 20)}...`);
                return { up: tokenIds[0], down: tokenIds[1] };
            }
        } catch (e) {
            console.log(`   ⚠️ 解析 clobTokenIds 失敗:`, e);
        }
    }
    
    // 方式 2: 從 tokens 陣列獲取（舊格式）
    if (market.tokens && market.tokens.length >= 2) {
        let upToken = market.tokens.find((t: any) => 
            t.outcome?.toLowerCase() === "up" || t.ticker?.toLowerCase().includes("up")
        );
        let downToken = market.tokens.find((t: any) => 
            t.outcome?.toLowerCase() === "down" || t.ticker?.toLowerCase().includes("down")
        );
        
        if (!upToken || !downToken) {
            upToken = market.tokens.find((t: any) => 
                t.outcome?.toLowerCase() === "yes" || t.ticker?.toLowerCase().includes("yes")
            );
            downToken = market.tokens.find((t: any) => 
                t.outcome?.toLowerCase() === "no" || t.ticker?.toLowerCase().includes("no")
            );
        }
        
        if (!upToken || !downToken) {
            upToken = market.tokens[0];
            downToken = market.tokens[1];
        }
        
        if (upToken?.token_id && downToken?.token_id) {
            if (upToken.outcome && downToken.outcome) {
                outcomeLabels = { up: upToken.outcome, down: downToken.outcome };
            }
            return { up: upToken.token_id, down: downToken.token_id };
        }
    }
    
    console.log(`   ⚠️ 無法提取 Token IDs`);
    return null;
}

// ============================================
// 🤖 主循環 - WebSocket 優先
// ============================================
async function runBot(clobClient: ClobClient, readOnly: boolean = true) {
    console.log("\n" + "=".repeat(60));
    console.log("🤖 BTC 交易機器人 V2 - WebSocket 優化版");
    console.log("=".repeat(60));
    console.log(`\n📋 配置:`);
    console.log(`   買入閾值: ${(CONFIG.BUY_THRESHOLD * 100).toFixed(0)}%`);
    console.log(`   止損: ${(CONFIG.STOP_LOSS_PERCENT * 100).toFixed(0)}%`);
    console.log(`   買入金額: $${CONFIG.BUY_AMOUNT} USDC`);
    console.log(`   模式: ${readOnly ? "⚠️ 唯讀模式" : "✅ 交易模式"}`);
    console.log(`   數據來源: WebSocket 優先，輪詢備援`);
    console.log(`   WebSocket URL: ${CONFIG.WEBSOCKET_URL}`);
    console.log("\n按 Ctrl+C 停止\n");
    
    state.isRunning = true;
    state.priceUpdateCount = 0;
    
    // 價格更新回調
    const onPriceUpdate = (prices: { up: number; down: number }) => {
        state.lastPrices = prices;
        
        // 計算剩餘時間
        let timeRemaining = "";
        if (state.currentMarket) {
            const endTime = state.currentMarket.endDate || state.currentMarket.end_date_iso;
            if (endTime) {
                const endDate = new Date(endTime);
                const now = new Date();
                const diffSeconds = Math.floor((endDate.getTime() - now.getTime()) / 1000);
                
                if (diffSeconds > 0) {
                    const mins = Math.floor(diffSeconds / 60);
                    const secs = diffSeconds % 60;
                    timeRemaining = `⏱️ ${mins}:${secs.toString().padStart(2, '0')}`;
                }
            }
        }
        
        displayStatus(prices, timeRemaining);
        
        // 檢查交易條件
        if (!readOnly && !state.currentPosition && cachedTokenIds) {
            if (prices.up >= CONFIG.BUY_THRESHOLD) {
                console.log(`\n🎯 ${outcomeLabels.up} 達到買入條件！`);
                executeTrade(clobClient, "UP", cachedTokenIds.up, prices.up);
            } else if (prices.down >= CONFIG.BUY_THRESHOLD) {
                console.log(`\n🎯 ${outcomeLabels.down} 達到買入條件！`);
                executeTrade(clobClient, "DOWN", cachedTokenIds.down, prices.down);
            }
        }
    };
    
    while (state.isRunning) {
        try {
            // 1. 獲取市場
            const market = await getCurrentBTC5MinMarket();
            
            if (!market) {
                process.stdout.write(`\r⏳ [${new Date().toLocaleTimeString("zh-TW")}] 搜索市場中...                                        `);
                await sleep(2000);
                continue;
            }
            
            // 檢查市場是否變更
            if (state.currentMarket?.id !== market.id) {
                console.log(`\n\n📌 新市場: ${market.question}`);
                console.log(`   Slug: ${market.slug}`);
                state.currentMarket = market;
                state.currentPosition = null;
                
                // 提取 token IDs
                const tokenIds = extractTokenIds(market);
                if (tokenIds) {
                    cachedTokenIds = tokenIds;
                    
                    // 先從市場數據獲取初始價格（避免顯示 0.00%）
                    if (market.outcomePrices) {
                        try {
                            const outcomeP = JSON.parse(market.outcomePrices);
                            state.lastPrices = {
                                up: parseFloat(outcomeP[0] || "0"),
                                down: parseFloat(outcomeP[1] || "0"),
                            };
                            console.log(`   初始價格: ${outcomeLabels.up} ${(state.lastPrices.up * 100).toFixed(1)}% | ${outcomeLabels.down} ${(state.lastPrices.down * 100).toFixed(1)}%`);
                        } catch {
                            // 忽略
                        }
                    }
                    
                    // 連接 WebSocket
                    connectPriceWebSocket(tokenIds, onPriceUpdate);
                }
            }
            
            // 檢查市場是否過期
            const endTime = market.endDate || market.end_date_iso;
            if (endTime) {
                const endDate = new Date(endTime);
                if (endDate.getTime() <= Date.now()) {
                    console.log(`\n⏳ 市場已結束，搜索下一個...`);
                    state.currentMarket = null;
                    cachedTokenIds = null;
                    
                    if (priceWebSocket) {
                        priceWebSocket.close();
                        priceWebSocket = null;
                    }
                    
                    await sleep(2000);
                    continue;
                }
            }
            
            // 如果 WebSocket 未連接，使用輪詢
            if (!state.wsConnected && cachedTokenIds) {
                const prices = await getPricesFallback(clobClient, cachedTokenIds);
                if (prices && (prices.up > 0 || prices.down > 0)) {
                    onPriceUpdate(prices);
                }
            }
            
            // 短暫等待（減輕 CPU）
            await sleep(state.wsConnected ? 100 : CONFIG.FALLBACK_POLL_INTERVAL);
            
        } catch (error) {
            console.error("\n❌ 循環錯誤:", error);
            await sleep(2000);
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
            console.log("⚠️  缺少 API 密鑰，使用唯讀模式");
            clobClient = new ClobClient(apiUrl, chainId, wallet);
        }
    } else {
        console.log("⚠️  未設置私鑰，使用唯讀模式");
        clobClient = new ClobClient(apiUrl, chainId);
    }
    
    // 處理中斷
    process.on("SIGINT", () => {
        console.log("\n\n🛑 停止機器人...");
        state.isRunning = false;
        
        if (priceWebSocket) {
            priceWebSocket.close();
        }
        if (pingInterval) {
            clearInterval(pingInterval);
        }
        
        process.exit(0);
    });
    
    await runBot(clobClient, readOnly);
}

main().catch(console.error);
