/**
 * 🎮 BTC 5分鐘預測市場模擬交易系統
 * 
 * 基於 btc-trading-bot-v2.ts WebSocket 連接，執行模擬下單策略
 * 初始本金: $50 USDC
 */

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { WebSocket } from "ws";
import * as fs from "fs";

dotenvConfig({ path: resolve(import.meta.dirname, "../.env") });

// ============================================
// 🎛️ 策略配置
// ============================================
const CONFIG = {
    // 資金管理
    INITIAL_BALANCE: 50,           // 初始本金 $50
    STANDARD_MULTIPLIER: 1.0,      // 標準倉位 = 本金/5 * 1.0
    DEFENSIVE_MULTIPLIER: 0.5,     // 防禦倉位 = 本金/5 * 0.5 
    
    // 策略參數
    HIGH_PROB_THRESHOLD: 0.85,     // 85% 高勝率門檻
    CONSECUTIVE_HITS: 5,           // 連續達標次數
    MAX_LATENCY: 500,              // 最大延遲 ms
    
    // 停損機制
    STOP_LOSS_THRESHOLD: 0.13,     // 價格下跌 13% 觸發停損 (放寬以容忍波動)
    STOP_LOSS_CONFIRM_COUNT: 3,    // 需連續 N 次低於閾值才觸發停損
    STOP_LOSS_HOLD_SECONDS: 5,     // 最後 N 秒不執行停損（只保護最後5秒）
    REBUY_WAIT_UNTIL_SECONDS: 5,   // 停損後等到最後 N 秒才能重新下單
    MIN_REBUY_PROB: 0.85,          // 重新買入最低勝率 85%
    STABLE_PRICE_TOLERANCE: 0.02,  // 價格穩定容忍度
    MAX_REBUY_PER_ROUND: 1,        // 每輪最多重新下單次數
    
    // 時間視窗 (秒)
    MONITORING_START: 30,          // 監控期開始 (剩餘30秒)
    MONITORING_END: 15,            // 監控期結束 (剩餘15秒)
    FINAL_DECISION_TIME: 6,        // 最後決策時間點 (剩餘6秒)
    LOCK_TIME: 5,                  // 鎖定期 (剩餘5秒以下)
    
    // 結算
    SETTLEMENT_DELAY: 10000,       // 結算等待時間 ms
    
    // WebSocket
    WEBSOCKET_URL: process.env.WS_URL || "wss://ws-subscriptions-clob.polymarket.com",
    GAMMA_API_URL: "https://gamma-api.polymarket.com",
    
    // 快取
    MARKET_CACHE_TTL: 60000,
    WS_RECONNECT_DELAY: 1000,
    WS_PING_INTERVAL: 15000,
};

// ============================================
// 📊 狀態機定義
// ============================================
enum TradingState {
    WAITING = "WAITING",           // 等待新市場
    MONITORING = "MONITORING",     // 監控期 (60s → 15s)
    FINAL_DECISION = "FINAL_DECISION", // 最後決策期 (15s → 5s)
    LOCKED = "LOCKED",             // 鎖定期 (< 5s)
    ORDERED = "ORDERED",           // 已下單
    HOLDING = "HOLDING",           // 持倉中（監控停損）
    COOLDOWN = "COOLDOWN",         // 停損後冷卻期
    SKIPPED = "SKIPPED",           // 本輪跳過
    SETTLING = "SETTLING",         // 等待結算
}

interface SimulatorState {
    isRunning: boolean;
    tradingState: TradingState;
    balance: number;
    
    // 市場資訊
    currentMarket: any | null;
    lastMarketFetch: number;
    
    // 價格追蹤
    lastPrices: { up: number; down: number };
    wsConnected: boolean;
    priceUpdateCount: number;
    lastPriceUpdate: number;
    
    // 策略狀態
    consecutiveHighProb: { up: number; down: number };
    currentRoundOrder: SimulatedOrder | null;
    finalDecisionMade: boolean; // 本輪是否已做最後決策
    delayedEntry: boolean; // 是否為開盤勝率過高延遲進場
    delayedEntryMade: boolean; // 是否已執行延遲進場判斷
    
    // 停損相關
    currentPosition: { side: "UP" | "DOWN"; entryPrice: number; amount: number } | null;
    stopLossTriggered: boolean; // 本輪是否已觸發停損
    rebuyCount: number; // 本輪重新下單次數
    stopLossConfirmCount: number; // 連續低於停損閾值的次數
    
    // 統計
    totalRounds: number;
    wins: number;
    losses: number;
    skipped: number;
    stopLossCount: number; // 停損總次數
    stopLossTotalAmount: number; // 停損總金額
    totalWinAmount: number; // 總獲勝金額
}

interface SimulatedOrder {
    id: string;
    marketSlug: string;
    side: "UP" | "DOWN";
    price: number;
    amount: number;
    potentialReturn: number;
    orderType: "STANDARD" | "DEFENSIVE";
    timestamp: Date;
    timeRemaining: number;
    finalPrices?: { up: number; down: number }; // 市場結束時的最終價格
}

interface TradeRecord {
    round: number;
    marketSlug: string;
    side: "UP" | "DOWN";
    orderType: "STANDARD" | "DEFENSIVE";
    entryPrice: number;
    amount: number;
    result: "WIN" | "LOSS" | "PENDING";
    profit: number;
    balanceAfter: number;
    timestamp: Date;
}

// ============================================
// 🔧 全域狀態
// ============================================
const state: SimulatorState = {
    isRunning: false,
    tradingState: TradingState.WAITING,
    balance: CONFIG.INITIAL_BALANCE,
    
    currentMarket: null,
    lastMarketFetch: 0,
    
    lastPrices: { up: 0, down: 0 },
    wsConnected: false,
    priceUpdateCount: 0,
    lastPriceUpdate: 0,
    
    consecutiveHighProb: { up: 0, down: 0 },
    currentRoundOrder: null,
    finalDecisionMade: false,
    delayedEntry: false,
    delayedEntryMade: false,
    
    currentPosition: null,
    stopLossTriggered: false,
    rebuyCount: 0,
    stopLossConfirmCount: 0,
    
    totalRounds: 0,
    wins: 0,
    losses: 0,
    skipped: 0,
    stopLossCount: 0,
    stopLossTotalAmount: 0,
    totalWinAmount: 0,
};

const tradeHistory: TradeRecord[] = [];
let cachedTokenIds: { up: string; down: string } | null = null;
let outcomeLabels = { up: "Up", down: "Down" };

// 待結算訂單列表
let pendingSettlements: SimulatedOrder[] = [];
let settlementInProgress = false;

// WebSocket
let priceWebSocket: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let subscribedTokenIds: { up: string; down: string } | null = null;
let wsConnectionId = 0;
let globalOnPriceCallback: ((prices: { up: number; down: number }) => void) | null = null;

console.log("✅ 第 1 段：基礎架構載入完成");
console.log(`   初始本金: $${CONFIG.INITIAL_BALANCE}`);
console.log(`   高勝率門檻: ${CONFIG.HIGH_PROB_THRESHOLD * 100}%`);
console.log(`   連續達標: ${CONFIG.CONSECUTIVE_HITS} 次`);

// ============================================
// 📡 WebSocket 價格訂閱 (複製自 btc-trading-bot-v2)
// ============================================
function connectPriceWebSocket(
    tokenIds: { up: string; down: string },
    onPrice: (prices: { up: number; down: number }) => void,
    isReconnect: boolean = false
) {
    wsConnectionId++;
    const thisConnectionId = wsConnectionId;
    
    globalOnPriceCallback = onPrice;
    subscribedTokenIds = { ...tokenIds };
    
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    
    if (priceWebSocket) {
        const oldWs = priceWebSocket;
        priceWebSocket = null;
        try {
            // 先檢查連接狀態，避免在連接建立前關閉
            if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
                // 先加一個空的錯誤處理器避免未處理錯誤
                oldWs.on("error", () => {});
                oldWs.removeAllListeners("message");
                oldWs.removeAllListeners("open");
                oldWs.removeAllListeners("close");
                oldWs.close();
            }
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
        if (wsConnectionId !== thisConnectionId) return;
        
        if (!isReconnect) {
            console.log("✅ WebSocket 連接成功");
        }
        state.wsConnected = true;
        
        const subscribeMsg = {
            type: "market",
            assets_ids: [subscribedTokenIds!.up, subscribedTokenIds!.down],
            initial_dump: true,
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN && wsConnectionId === thisConnectionId) {
                ws.send("PING");
            }
        }, CONFIG.WS_PING_INTERVAL);
    });
    
    ws.on("message", (data: Buffer) => {
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
            }
            
            if (hasUpdate) {
                state.priceUpdateCount++;
                state.lastPriceUpdate = Date.now();
                globalOnPriceCallback(prices);
            }
        } catch {}
    });
    
    ws.on("error", () => {
        if (wsConnectionId !== thisConnectionId) return;
        state.wsConnected = false;
    });
    
    ws.on("close", () => {
        if (wsConnectionId !== thisConnectionId) return;
        state.wsConnected = false;
        
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
        
        if (state.isRunning && subscribedTokenIds && globalOnPriceCallback) {
            setTimeout(() => {
                if (state.isRunning && subscribedTokenIds && globalOnPriceCallback && wsConnectionId === thisConnectionId) {
                    connectPriceWebSocket(subscribedTokenIds, globalOnPriceCallback, true);
                }
            }, CONFIG.WS_RECONNECT_DELAY);
        }
    });
}

// ============================================
// 📊 獲取市場資訊
// ============================================
async function getCurrentBTC5MinMarket(): Promise<any | null> {
    const now = Date.now();
    if (state.currentMarket && (now - state.lastMarketFetch) < CONFIG.MARKET_CACHE_TTL) {
        const endTime = state.currentMarket.endDate || state.currentMarket.end_date_iso;
        if (endTime) {
            const endDate = new Date(endTime);
            if (endDate.getTime() > now) {
                return state.currentMarket;
            }
        }
    }
    
    try {
        const nowSec = Math.floor(now / 1000);
        const currentWindow = Math.floor(nowSec / 300) * 300;
        const nextWindow = currentWindow + 300;
        
        const slugs = [`btc-updown-5m-${currentWindow}`, `btc-updown-5m-${nextWindow}`];
        
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
// 🔄 提取 Token IDs
// ============================================
function extractTokenIds(market: any): { up: string; down: string } | null {
    if (market.clobTokenIds) {
        try {
            const tokenIds = typeof market.clobTokenIds === "string"
                ? JSON.parse(market.clobTokenIds)
                : market.clobTokenIds;
            
            if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                if (market.outcomes) {
                    try {
                        const outcomes = typeof market.outcomes === "string"
                            ? JSON.parse(market.outcomes)
                            : market.outcomes;
                        if (Array.isArray(outcomes) && outcomes.length >= 2) {
                            outcomeLabels = { up: outcomes[0], down: outcomes[1] };
                        }
                    } catch {}
                }
                return { up: tokenIds[0], down: tokenIds[1] };
            }
        } catch {}
    }
    
    if (market.tokens && market.tokens.length >= 2) {
        const upToken = market.tokens[0];
        const downToken = market.tokens[1];
        
        if (upToken?.token_id && downToken?.token_id) {
            if (upToken.outcome && downToken.outcome) {
                outcomeLabels = { up: upToken.outcome, down: downToken.outcome };
            }
            return { up: upToken.token_id, down: downToken.token_id };
        }
    }
    
    return null;
}

// ============================================
// 💰 計算下注金額
// ============================================
function calculateBetAmount(orderType: "STANDARD" | "DEFENSIVE"): number {
    const unit = state.balance / 5;
    const multiplier = orderType === "STANDARD" 
        ? CONFIG.STANDARD_MULTIPLIER 
        : CONFIG.DEFENSIVE_MULTIPLIER;
    return Math.round(unit * multiplier * 100) / 100;
}

// ============================================
// 🎯 模擬下單
// ============================================
function simulateOrder(
    side: "UP" | "DOWN",
    price: number,
    orderType: "STANDARD" | "DEFENSIVE",
    timeRemaining: number
): SimulatedOrder {
    // ============================================
    // 🌐 真實環境模擬機制 (Slippage & Taker Fees)
    // ============================================
    
    // 1. 模擬 Taker 滑點：市價吃單會比最新報價差。機率越極端，訂單簿越薄，可能遇到更大滑點
    const slippage = price >= 0.90 ? 0.003 : 0.001; 
    const executionPrice = Math.min(price + slippage, 0.999);

    // 2. 模擬 Taker 動態手續費 (Polymarket 新公式)
    // 最高手續費約為 1.56% (出現在 50% 勝率)，在極端勝率會對稱遞減近乎 0
    const peakFeeRate = 0.0156; 
    const dynamicFeeRate = peakFeeRate * 4 * executionPrice * (1 - executionPrice);
    
    const rawBudget = calculateBetAmount(orderType);
    const feeAmount = rawBudget * dynamicFeeRate;
    const amountAfterFee = rawBudget - feeAmount; // 扣除強制繳納的手續費
    const potentialReturn = amountAfterFee / executionPrice;
    
    const order: SimulatedOrder = {
        id: `SIM-${Date.now()}`,
        marketSlug: state.currentMarket?.slug || "unknown",
        side,
        price: executionPrice,
        amount: rawBudget, // 從帳戶中實際扣減的總保證金
        potentialReturn,
        orderType,
        timestamp: new Date(),
        timeRemaining,
    };
    
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🎯 模擬下單 [${orderType}] (真實環境已考慮)`);
    console.log(`   方向: ${side} (${outcomeLabels[side.toLowerCase() as "up" | "down"]})`);
    console.log(`   觸發價: ${(price * 100).toFixed(2)}% | 執行價(含滑點): ${(executionPrice * 100).toFixed(2)}%`);
    console.log(`   總資金: $${rawBudget.toFixed(2)} | 扣除手續費($${feeAmount.toFixed(4)}): $${amountAfterFee.toFixed(2)}`);
    console.log(`   預期回報: $${potentialReturn.toFixed(2)}`);
    console.log(`   剩餘時間: ${timeRemaining}s`);
    console.log(`${"=".repeat(50)}\n`);
    
    return order;
}

// ============================================
// 🚨 停損執行 (已廢棄，改由 processStrategy 直接處理)
// ============================================
// 此函數不再使用，停損邏輯已整合到 processStrategy 中

// ============================================
// 📈 結算處理
// ============================================
async function settleOrder(order: SimulatedOrder): Promise<void> {
    console.log(`\n⏳ 結算訂單: ${order.marketSlug.slice(-15)} (${order.side})`);
    
    let winner: "UP" | "DOWN" | null = null;
    
    // 方式 1: 優先使用記錄的最終價格判斷（最可靠）
    // 市場結束時，勝方價格會接近 1.0 (100%)
    if (order.finalPrices) {
        const { up, down } = order.finalPrices;
        console.log(`   使用最終價格判斷: Up=${(up * 100).toFixed(1)}% | Down=${(down * 100).toFixed(1)}%`);
        
        if (up >= 0.95) {
            winner = "UP";
        } else if (down >= 0.95) {
            winner = "DOWN";
        } else if (up > down && up >= 0.80) {
            // 如果沒有明確勝者但有明顯優勢
            winner = "UP";
            console.log(`   ⚠️ 價格未達 95% 但 Up 領先，判定 UP 獲勝`);
        } else if (down > up && down >= 0.80) {
            winner = "DOWN";
            console.log(`   ⚠️ 價格未達 95% 但 Down 領先，判定 DOWN 獲勝`);
        }
    }
    
    // 方式 2: 若最終價格無法判斷，嘗試查詢 Gamma API
    if (!winner) {
        const MAX_RETRIES = 2;
        const RETRY_DELAY = 3000;
        
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(
                    `${CONFIG.GAMMA_API_URL}/markets?slug=${order.marketSlug}`
                );
                const markets = await response.json();
                
                if (!markets || markets.length === 0) {
                    if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY);
                    continue;
                }
                
                const market = markets[0];
                
                // 從 outcome 欄位判斷
                if (market.outcome) {
                    const outcome = market.outcome.toLowerCase();
                    if (outcome === "up" || outcome === outcomeLabels.up.toLowerCase()) {
                        winner = "UP";
                    } else if (outcome === "down" || outcome === outcomeLabels.down.toLowerCase()) {
                        winner = "DOWN";
                    }
                }
                
                // 從 winningOutcome 判斷
                if (!winner && market.winningOutcome) {
                    const winOutcome = market.winningOutcome.toLowerCase();
                    if (winOutcome === "up" || winOutcome === outcomeLabels.up.toLowerCase()) {
                        winner = "UP";
                    } else if (winOutcome === "down" || winOutcome === outcomeLabels.down.toLowerCase()) {
                        winner = "DOWN";
                    }
                }
                
                // 從 outcomePrices 判斷（結算後勝方為 1.0）
                if (!winner && market.closed && market.outcomePrices) {
                    try {
                        const prices = typeof market.outcomePrices === "string" 
                            ? JSON.parse(market.outcomePrices) 
                            : market.outcomePrices;
                        if (parseFloat(prices[0]) >= 0.99) winner = "UP";
                        else if (parseFloat(prices[1]) >= 0.99) winner = "DOWN";
                    } catch {}
                }
                
                if (winner) {
                    console.log(`   ✅ API 確認結算完成`);
                    break;
                }
                
                if (attempt < MAX_RETRIES) {
                    console.log(`   [${attempt}/${MAX_RETRIES}] API 尚無結果，重試...`);
                    await sleep(RETRY_DELAY);
                }
                
            } catch (error) {
                if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY);
            }
        }
    }
    
    if (!winner) {
        console.log("   ⚠️ 無法判斷市場結果，記錄為待處理");
        tradeHistory.push({
            round: state.totalRounds,
            marketSlug: order.marketSlug,
            side: order.side,
            orderType: order.orderType,
            entryPrice: order.price,
            amount: order.amount,
            result: "PENDING",
            profit: 0,
            balanceAfter: state.balance,
            timestamp: order.timestamp,
        });
        return;
    }
    
    // 計算損益
    const isWin = order.side === winner;
    const profit = isWin 
        ? order.potentialReturn - order.amount  // 獲利 = 回報 - 本金
        : -order.amount;                         // 損失 = 全部下注金額
    
    // 更新餘額：勝利加獲利，失敗扣本金
    state.balance += profit;
    
    if (isWin) {
        state.wins++;
        state.totalWinAmount += profit; // 累加獲勝金額
        console.log(`   🎉 勝利！結果: ${winner} | 獲利 +$${profit.toFixed(2)}`);
    } else {
        state.losses++;
        console.log(`   😞 失敗！結果: ${winner} | 損失 -$${order.amount.toFixed(2)}`);
    }
    
    console.log(`   目前餘額: $${state.balance.toFixed(2)}`);
    
    // 記錄交易
    tradeHistory.push({
        round: state.totalRounds,
        marketSlug: order.marketSlug,
        side: order.side,
        orderType: order.orderType,
        entryPrice: order.price,
        amount: order.amount,
        result: isWin ? "WIN" : "LOSS",
        profit,
        balanceAfter: state.balance,
        timestamp: order.timestamp,
    });
}

// ============================================
// 📺 顯示狀態
// ============================================
function displayStatus(prices: { up: number; down: number }, timeRemaining: number) {
    const now = new Date().toLocaleTimeString("zh-TW");
    const upPercent = (prices.up * 100).toFixed(2);
    const downPercent = (prices.down * 100).toFixed(2);
    const wsStatus = state.wsConnected ? "🟢" : "🟡";
    const stateEmoji = {
        [TradingState.WAITING]: "⏳",
        [TradingState.MONITORING]: "👀",
        [TradingState.FINAL_DECISION]: "⚡",
        [TradingState.LOCKED]: "🔒",
        [TradingState.ORDERED]: "✅",
        [TradingState.HOLDING]: "📊",
        [TradingState.COOLDOWN]: "❄️",
        [TradingState.SKIPPED]: "⏭️",
        [TradingState.SETTLING]: "📊",
    };
    
    const mins = Math.floor(timeRemaining / 60);
    const secs = timeRemaining % 60;
    const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;
    
    process.stdout.write(
        `\r[${now}] ${wsStatus} | ${outcomeLabels.up}: ${upPercent}% | ${outcomeLabels.down}: ${downPercent}% | ⏱️ ${timeStr} | ${stateEmoji[state.tradingState]} ${state.tradingState} | 💰 $${state.balance.toFixed(2)}    `
    );
}

// ============================================
// 🎮 策略核心邏輯
// ============================================
function processStrategy(prices: { up: number; down: number }, timeRemaining: number) {
    state.lastPrices = prices;
    
    // 跳過或結算中，不處理
    if (state.tradingState === TradingState.SKIPPED ||
        state.tradingState === TradingState.SETTLING) {
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 🚨 持倉中 - 監控停損
    if (state.tradingState === TradingState.HOLDING && state.currentPosition) {
        const { side, entryPrice } = state.currentPosition;
        const currentPrice = side === "UP" ? prices.up : prices.down;
        const priceDrop = entryPrice - currentPrice;
        const dropPercent = priceDrop / entryPrice;
        
        // 🛡️ 最後 N 秒不執行停損（快結算時波動無意義）
        if (timeRemaining <= CONFIG.STOP_LOSS_HOLD_SECONDS) {
            // 重置連續確認計數
            state.stopLossConfirmCount = 0;
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 檢查是否低於停損閾值
        if (dropPercent >= CONFIG.STOP_LOSS_THRESHOLD) {
            // 增加連續確認計數
            state.stopLossConfirmCount++;
            
            // 需要連續 N 次才真正觸發停損
            if (state.stopLossConfirmCount < CONFIG.STOP_LOSS_CONFIRM_COUNT) {
                console.log(`\n⚠️ 停損警告 (${state.stopLossConfirmCount}/${CONFIG.STOP_LOSS_CONFIRM_COUNT}): ${side} 跌幅 ${(dropPercent * 100).toFixed(2)}%`);
                displayStatus(prices, timeRemaining);
                return;
            }
            
            // 執行停損計算
            const loss = (priceDrop / entryPrice) * state.currentPosition.amount;
            state.balance -= loss;
            state.stopLossConfirmCount = 0; // 重置
            state.stopLossCount++; // 統計停損次數
            state.stopLossTotalAmount += loss; // 統計停損金額
            
            console.log(`\n${"⚠️".repeat(15)}`);
            console.log(`🚨 觸發停損!`);
            console.log(`   方向: ${side} @ ${(entryPrice * 100).toFixed(2)}%`);
            console.log(`   觸發價: ${(currentPrice * 100).toFixed(2)}%`);
            console.log(`   跌幅: ${(dropPercent * 100).toFixed(2)}%`);
            console.log(`   損失: -$${loss.toFixed(2)}`);
            console.log(`   餘額: $${state.balance.toFixed(2)}`);
            
            // 清除持倉
            state.currentPosition = null;
            state.currentRoundOrder = null;
            state.stopLossTriggered = true;
            
            // 檢查是否達到本輪重買上限
            if (state.rebuyCount >= CONFIG.MAX_REBUY_PER_ROUND) {
                console.log(`   🚫 已達本輪重買上限，本輪不再入場`);
                state.tradingState = TradingState.SKIPPED;
            } else {
                // 等待最後5秒重新入場
                console.log(`   ⏳ 等待最後 ${CONFIG.REBUY_WAIT_UNTIL_SECONDS} 秒重新入場機會`);
                state.tradingState = TradingState.COOLDOWN;
            }
            console.log(`${"⚠️".repeat(15)}\n`);
            
            displayStatus(prices, timeRemaining);
            return;
        } else {
            // 價格回升，重置連續確認計數
            if (state.stopLossConfirmCount > 0) {
                state.stopLossConfirmCount = 0;
            }
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // ❄️ 冷卻期 - 等待最後5秒重新入場
    if (state.tradingState === TradingState.COOLDOWN) {
        // 等待到最後 N 秒才能重新入場
        if (timeRemaining > CONFIG.REBUY_WAIT_UNTIL_SECONDS) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 檢查是否已達到本輪重買上限
        if (state.rebuyCount >= CONFIG.MAX_REBUY_PER_ROUND) {
            console.log(`\n🚫 已達本輪重買上限 (${state.rebuyCount}次)，本輪不再入場`);
            state.tradingState = TradingState.SKIPPED;
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 到達最後5秒，檢查是否可以重新入場
        const higherPrice = Math.max(prices.up, prices.down);
        const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
        
        // 檢查是否達到重新入場條件 (勝率 >= 85%)
        if (higherPrice >= CONFIG.MIN_REBUY_PROB) {
            state.rebuyCount++;
            console.log(`\n♻️ 最後${CONFIG.REBUY_WAIT_UNTIL_SECONDS}秒重新入場: ${higherSide} @ ${(higherPrice * 100).toFixed(2)}% (重買第${state.rebuyCount}次)`);
            
            const order = simulateOrder(higherSide, higherPrice, "DEFENSIVE", timeRemaining);
            state.currentRoundOrder = order;
            state.currentPosition = {
                side: higherSide,
                entryPrice: higherPrice,
                amount: order.amount,
            };
            state.tradingState = TradingState.HOLDING;
        } else {
            // 價格不夠高，繼續等待或轉換到等待狀態
            console.log(`\n❄️ 冷卻結束，價格 ${(higherPrice * 100).toFixed(2)}% 未達 ${CONFIG.MIN_REBUY_PROB * 100}%，繼續等待`);
            
            // 根據時間決定轉換到哪個狀態
            if (timeRemaining <= CONFIG.MONITORING_END && timeRemaining >= CONFIG.LOCK_TIME) {
                state.tradingState = TradingState.FINAL_DECISION;
            } else if (timeRemaining <= CONFIG.MONITORING_START && timeRemaining > CONFIG.MONITORING_END) {
                state.tradingState = TradingState.MONITORING;
                state.consecutiveHighProb = { up: 0, down: 0 };
            } else {
                state.tradingState = TradingState.WAITING;
            }
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 已下單（但還沒設定持倉），轉換到持倉狀態
    if (state.tradingState === TradingState.ORDERED && state.currentRoundOrder && !state.currentPosition) {
        const order = state.currentRoundOrder;
        state.currentPosition = {
            side: order.side,
            entryPrice: order.price,
            amount: order.amount,
        };
        state.tradingState = TradingState.HOLDING;
        console.log(`\n📊 開始持倉監控`);
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 最後決策期 (15s ~ 0s) - 取消鎖定期限制
    if (timeRemaining <= CONFIG.MONITORING_END && timeRemaining >= 0) {
        if (state.tradingState !== TradingState.FINAL_DECISION) {
            state.tradingState = TradingState.FINAL_DECISION;
            console.log("\n⚡ 進入最後決策期");
        }
        
        // 延遲進場判斷 (T-10s)
        if (state.delayedEntry && !state.delayedEntryMade && timeRemaining <= 10) {
            state.delayedEntryMade = true;
            const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
            const higherPrice = Math.max(prices.up, prices.down);
            
            console.log(`\n🕒 T-${timeRemaining}s 延遲進場判斷: 當前較高為 ${higherSide} (${(higherPrice * 100).toFixed(1)}%)`);
            if (higherPrice >= CONFIG.HIGH_PROB_THRESHOLD) {
                const order = simulateOrder(higherSide, higherPrice, "STANDARD", timeRemaining);
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: higherSide,
                    entryPrice: higherPrice,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                state.finalDecisionMade = true; // 已經進場，略過後面的 finalDecision
                console.log(`📊 開始持倉監控`);
            } else {
                console.log(`   勝率不足 ${CONFIG.HIGH_PROB_THRESHOLD * 100}%，放棄延遲進場`);
            }
        }
        
        // 最後決策 (T-8s 到 T-0s 期間)
        if (!state.finalDecisionMade && timeRemaining <= CONFIG.FINAL_DECISION_TIME) {
            const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
            const higherPrice = Math.max(prices.up, prices.down);
            
            // 策略邏輯：
            // 1. 若勝率 >= 80%，提早觸發
            // 2. 若撐到最後 2 秒 (timeRemaining <= 2)，強制無條件選兩邊最高的
            if (higherPrice >= 0.80 || timeRemaining <= 2) {
                state.finalDecisionMade = true;
                
                if (higherPrice >= 0.80) {
                    console.log(`\n⚡ T-${timeRemaining}s 達到 80% 保底門檻，最後決策: ${higherSide} (${(higherPrice * 100).toFixed(2)}%)`);
                } else {
                    console.log(`\n⚡ T-${timeRemaining}s 等待極限，強制選擇勝率最高方: ${higherSide} (${(higherPrice * 100).toFixed(2)}%)`);
                }
                
                const order = simulateOrder(higherSide, higherPrice, "DEFENSIVE", timeRemaining);
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: higherSide,
                    entryPrice: higherPrice,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                console.log(`📊 開始持倉監控`);
            }
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 監控期 (60s ~ 15s)
    if (timeRemaining <= CONFIG.MONITORING_START && timeRemaining > CONFIG.MONITORING_END) {
        if (state.tradingState !== TradingState.MONITORING) {
            state.tradingState = TradingState.MONITORING;
            state.consecutiveHighProb = { up: 0, down: 0 };
            
            if (prices.up >= 0.90 || prices.down >= 0.90) {
                state.delayedEntry = true;
                const higherSide = prices.up >= prices.down ? "UP" : "DOWN";
                const higherPrice = Math.max(prices.up, prices.down);
                console.log(`\n👀 進入監控期，初始勝率過高 (${higherSide}: ${(higherPrice * 100).toFixed(1)}%)，延遲至最後10秒判斷`);
            } else {
                state.delayedEntry = false;
                console.log("\n👀 進入監控期");
            }
        }
        
        if (state.delayedEntry) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 檢查高勝率
        if (prices.up >= CONFIG.HIGH_PROB_THRESHOLD) {
            state.consecutiveHighProb.up++;
            state.consecutiveHighProb.down = 0;
            
            if (state.consecutiveHighProb.up >= CONFIG.CONSECUTIVE_HITS) {
                console.log(`\n🎯 UP 連續 ${state.consecutiveHighProb.up} 次達標！`);
                const order = simulateOrder("UP", prices.up, "STANDARD", timeRemaining);
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: "UP",
                    entryPrice: prices.up,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                console.log(`📊 開始持倉監控`);
            }
        } else if (prices.down >= CONFIG.HIGH_PROB_THRESHOLD) {
            state.consecutiveHighProb.down++;
            state.consecutiveHighProb.up = 0;
            
            if (state.consecutiveHighProb.down >= CONFIG.CONSECUTIVE_HITS) {
                console.log(`\n🎯 DOWN 連續 ${state.consecutiveHighProb.down} 次達標！`);
                const order = simulateOrder("DOWN", prices.down, "STANDARD", timeRemaining);
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: "DOWN",
                    entryPrice: prices.down,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                console.log(`📊 開始持倉監控`);
            }
        } else {
            state.consecutiveHighProb = { up: 0, down: 0 };
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 等待期 (> 60s)
    if (state.tradingState !== TradingState.WAITING) {
        state.tradingState = TradingState.WAITING;
    }
    displayStatus(prices, timeRemaining);
}

// ============================================
// 📝 匯出報告
// ============================================
function exportReport(): string {
    const now = new Date();
    const filename = `trading-report-${now.toISOString().slice(0, 10)}-${now.getHours()}${now.getMinutes()}.md`;
    
    let report = `# BTC 5分鐘預測市場模擬交易報告\n\n`;
    report += `**生成時間**: ${now.toLocaleString("zh-TW")}\n\n`;
    
    report += `## 📊 總結\n\n`;
    report += `| 項目 | 數值 |\n`;
    report += `|------|------|\n`;
    report += `| 初始本金 | $${CONFIG.INITIAL_BALANCE.toFixed(2)} |\n`;
    report += `| 最終餘額 | $${state.balance.toFixed(2)} |\n`;
    report += `| 總損益 | $${(state.balance - CONFIG.INITIAL_BALANCE).toFixed(2)} |\n`;
    report += `| 報酬率 | ${(((state.balance - CONFIG.INITIAL_BALANCE) / CONFIG.INITIAL_BALANCE) * 100).toFixed(2)}% |\n`;
    report += `| 總輪數 | ${state.totalRounds} |\n`;
    report += `| 勝 | ${state.wins} |\n`;
    report += `| 負 | ${state.losses} |\n`;
    report += `| 跳過 | ${state.skipped} |\n`;
    report += `| 勝率 | ${state.wins + state.losses > 0 ? ((state.wins / (state.wins + state.losses)) * 100).toFixed(1) : 0}% |\n\n`;
    
    report += `## 📜 交易記錄\n\n`;
    report += `| # | 市場 | 方向 | 類型 | 入場價 | 金額 | 結果 | 損益 | 餘額 |\n`;
    report += `|---|------|------|------|--------|------|------|------|------|\n`;
    
    for (const trade of tradeHistory) {
        report += `| ${trade.round} | ${trade.marketSlug.slice(-10)} | ${trade.side} | ${trade.orderType} | ${(trade.entryPrice * 100).toFixed(1)}% | $${trade.amount.toFixed(2)} | ${trade.result} | $${trade.profit.toFixed(2)} | $${trade.balanceAfter.toFixed(2)} |\n`;
    }
    
    report += `\n## ⚙️ 策略參數\n\n`;
    report += `- 高勝率門檻: ${CONFIG.HIGH_PROB_THRESHOLD * 100}%\n`;
    report += `- 連續達標次數: ${CONFIG.CONSECUTIVE_HITS}\n`;
    report += `- 標準倉位: 本金/${5 / CONFIG.STANDARD_MULTIPLIER}\n`;
    report += `- 防禦倉位: 本金/${5 / CONFIG.DEFENSIVE_MULTIPLIER}\n`;
    report += `- 停損閾值: ${CONFIG.STOP_LOSS_THRESHOLD * 100}%\n`;
    report += `- 最後N秒不停損: ${CONFIG.STOP_LOSS_HOLD_SECONDS} 秒\n`;
    report += `- 停損後等待重買: 最後 ${CONFIG.REBUY_WAIT_UNTIL_SECONDS} 秒\n`;
    report += `- 每輪重買上限: ${CONFIG.MAX_REBUY_PER_ROUND} 次\n`;
    report += `- 重新入場最低勝率: ${CONFIG.MIN_REBUY_PROB * 100}%\n`;
    
    return report;
}

// ============================================
// 🔧 工具函數
// ============================================
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getTimeRemaining(market: any): number {
    const endTime = market.endDate || market.end_date_iso;
    if (!endTime) return 999;
    
    const endDate = new Date(endTime);
    const now = new Date();
    return Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / 1000));
}

// ============================================
// 🚀 主循環
// ============================================
async function runSimulator() {
    console.log("\n" + "=".repeat(60));
    console.log("🎮 BTC 5分鐘預測市場模擬交易系統");
    console.log("=".repeat(60));
    console.log(`\n📋 策略配置:`);
    console.log(`   初始本金: $${CONFIG.INITIAL_BALANCE}`);
    console.log(`   高勝率門檻: ${CONFIG.HIGH_PROB_THRESHOLD * 100}%`);
    console.log(`   連續達標: ${CONFIG.CONSECUTIVE_HITS} 次`);
    console.log(`   標準倉位: $${(CONFIG.INITIAL_BALANCE / 5 * CONFIG.STANDARD_MULTIPLIER).toFixed(2)}`);
    console.log(`   防禦倉位: $${(CONFIG.INITIAL_BALANCE / 5 * CONFIG.DEFENSIVE_MULTIPLIER).toFixed(2)}`);
    console.log(`\n🚨 停損機制: ✅ 已啟用 (閾值: ${CONFIG.STOP_LOSS_THRESHOLD * 100}%)`);
    console.log("\n按 Ctrl+C 停止\n");
    
    state.isRunning = true;
    
    const onPriceUpdate = (prices: { up: number; down: number }) => {
        if (!state.currentMarket) return;
        
        const timeRemaining = getTimeRemaining(state.currentMarket);
        processStrategy(prices, timeRemaining);
    };
    
    while (state.isRunning) {
        try {
            const market = await getCurrentBTC5MinMarket();
            
            if (!market) {
                process.stdout.write(`\r⏳ [${new Date().toLocaleTimeString("zh-TW")}] 搜索市場中...                              `);
                await sleep(2000);
                continue;
            }
            
            // 新市場
            if (state.currentMarket?.id !== market.id) {
                // 將上一輪訂單加入待結算列表（不立即結算）
                if (state.currentRoundOrder && (state.tradingState === TradingState.ORDERED || state.tradingState === TradingState.HOLDING)) {
                    // 記錄市場結束時的最終價格（用於結算判斷）
                    state.currentRoundOrder.finalPrices = { ...state.lastPrices };
                    pendingSettlements.push(state.currentRoundOrder);
                    console.log(`\n📝 訂單加入待結算列表 (共 ${pendingSettlements.length} 筆)`);
                    console.log(`   最終價格: Up=${(state.lastPrices.up * 100).toFixed(1)}% | Down=${(state.lastPrices.down * 100).toFixed(1)}%`);
                } else if (state.totalRounds > 0) {
                    state.skipped++;
                    console.log(`\n⏭️ 第 ${state.totalRounds} 輪跳過（無下單）`);
                }
                
                // 重置狀態
                state.totalRounds++;
                state.currentMarket = market;
                state.tradingState = TradingState.WAITING;
                state.currentRoundOrder = null;
                state.consecutiveHighProb = { up: 0, down: 0 };
                state.finalDecisionMade = false;
                state.delayedEntry = false;
                state.delayedEntryMade = false;
                state.currentPosition = null;
                state.stopLossTriggered = false;
                state.rebuyCount = 0;
                state.stopLossConfirmCount = 0;
                
                console.log(`\n\n${"=".repeat(50)}`);
                console.log(`📌 第 ${state.totalRounds} 輪 - 新市場`);
                console.log(`   ${market.question}`);
                console.log(`   Slug: ${market.slug}`);
                console.log(`${"=".repeat(50)}`);
                
                const tokenIds = extractTokenIds(market);
                if (tokenIds) {
                    cachedTokenIds = tokenIds;
                    
                    if (market.outcomePrices) {
                        try {
                            const outcomeP = JSON.parse(market.outcomePrices);
                            state.lastPrices = {
                                up: parseFloat(outcomeP[0] || "0"),
                                down: parseFloat(outcomeP[1] || "0"),
                            };
                        } catch {}
                    }
                    
                    connectPriceWebSocket(tokenIds, onPriceUpdate);
                }
            }
            
            // 檢查市場是否過期
            const timeRemaining = getTimeRemaining(market);
            if (timeRemaining <= 0) {
                console.log(`\n⏳ 市場已結束，等待下一個...`);
                state.currentMarket = null;
                cachedTokenIds = null;
                
                if (priceWebSocket) {
                    try {
                        priceWebSocket.on("error", () => {});
                        priceWebSocket.close();
                    } catch {}
                    priceWebSocket = null;
                }
                
                await sleep(2000);
                continue;
            }
            
            // 延遲結算：在新市場剩餘 4 分鐘時觸發（上個市場已結束約 1 分鐘）
            // 由於使用最終價格判斷，不需等待太久
            if (timeRemaining <= 240 && timeRemaining > 200 && 
                pendingSettlements.length > 0 && !settlementInProgress) {
                settlementInProgress = true;
                console.log(`\n📊 開始處理待結算訂單 (${pendingSettlements.length} 筆)...`);
                
                for (const order of pendingSettlements) {
                    await settleOrder(order);
                }
                pendingSettlements = [];
                settlementInProgress = false;
            }
            
            await sleep(100);
            
        } catch (error) {
            console.error("\n❌ 循環錯誤:", error);
            await sleep(2000);
        }
    }
}

// ============================================
// 🚀 啟動
// ============================================
async function main() {
    process.on("SIGINT", async () => {
        console.log("\n\n🛑 停止模擬器...");
        state.isRunning = false;
        
        if (priceWebSocket) {
            try {
                priceWebSocket.on("error", () => {});
                priceWebSocket.close();
            } catch {}
        }
        if (pingInterval) {
            clearInterval(pingInterval);
        }
        
        console.log(`\n📊 交易統計:`);
        console.log(`   總輪數: ${state.totalRounds}`);
        console.log(`   勝: ${state.wins} | 負: ${state.losses} | 跳過: ${state.skipped}`);
        console.log(`   停損次數: ${state.stopLossCount} | 停損總額: -$${state.stopLossTotalAmount.toFixed(2)}`);
        console.log(`   總獲勝金額: +$${state.totalWinAmount.toFixed(2)} | 平均獲勝: +$${state.wins > 0 ? (state.totalWinAmount / state.wins).toFixed(2) : '0.00'}`);
        console.log(`   勝率: ${state.wins + state.losses > 0 ? ((state.wins / (state.wins + state.losses)) * 100).toFixed(1) : 0}%`);
        console.log(`   最終餘額: $${state.balance.toFixed(2)}`);
        console.log(`   總損益: $${(state.balance - CONFIG.INITIAL_BALANCE).toFixed(2)}`);
        console.log(`   報酬率: ${(((state.balance - CONFIG.INITIAL_BALANCE) / CONFIG.INITIAL_BALANCE) * 100).toFixed(2)}%`);
        
        if (tradeHistory.length > 0) {
            console.log(`\n📜 交易記錄:`);
            console.log(`   ${"-".repeat(70)}`);
            for (const trade of tradeHistory) {
                const resultEmoji = trade.result === "WIN" ? "🎉" : trade.result === "LOSS" ? "😞" : "⏳";
                console.log(`   ${resultEmoji} #${trade.round} | ${trade.side} @ ${(trade.entryPrice * 100).toFixed(1)}% | $${trade.amount.toFixed(2)} | ${trade.result} | ${trade.profit >= 0 ? "+" : ""}$${trade.profit.toFixed(2)} | 餘額 $${trade.balanceAfter.toFixed(2)}`);
            }
            console.log(`   ${"-".repeat(70)}`);
        }
        
        process.exit(0);
    });
    
    await runSimulator();
}

main().catch(console.error);
