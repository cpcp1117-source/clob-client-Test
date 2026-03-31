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
// 🎛️ 策略配置 (2024/03/31 優化版)
// ============================================
const CONFIG = {
    // 資金管理
    INITIAL_BALANCE: 50,           // 初始本金 $50
    STANDARD_MULTIPLIER: 0.8,      // 標準倉位 = 本金/5 * 0.8 (降低單筆風險)
    DEFENSIVE_MULTIPLIER: 0.3,     // 防禦倉位 = 本金/5 * 0.3 (更保守)
    
    // 策略參數 - 核心優化
    HIGH_PROB_THRESHOLD: 0.86,     // 86% 勝率門檻（避免剛好 85% 的邊界情況）
    MAX_PROB_THRESHOLD: 0.94,      // ⚠️ 新增：最高入場門檻（>94% 不入場，風險報酬比太差）
    CONSECUTIVE_HITS: 4,           // 連續達標次數（4次更快進場但仍有確認）
    MAX_LATENCY: 500,              // 最大延遲 ms
    
    // 價格穩定性檢查 - 防止在波動中入場
    PRICE_STABILITY_CHECK: true,   // ⚠️ 新增：啟用價格穩定性檢查
    MAX_PRICE_VOLATILITY: 0.03,    // ⚠️ 新增：3秒內波動超過3%則跳過
    
    // 停損機制
    STOP_LOSS_THRESHOLD: 0.1,     // 價格下跌 10% 觸發停損 (例: 100% → 90%)
    COOLDOWN_MS: 3000,             // 停損後冷卻時間 3 秒
    MIN_REBUY_PROB: 0.85,          // 冷卻後重新買入最低勝率
    STABLE_PRICE_TOLERANCE: 0.02,  // 價格穩定容忍度
    MAX_STOP_LOSS_PER_ROUND: 1,    // 每輪最多停損次數（超過後本輪不再入場）
    
    // 對沖機制 - 優化版
    HEDGE_ENABLED: true,           // 啟用對沖
    HEDGE_BASE_RATIO: 0.15,        // 基準對沖比例 (15%，降低成本)
    HEDGE_MIN_RATIO: 0.05,         // 最小對沖比例 (5%)
    HEDGE_MAX_RATIO: 0.25,         // 最大對沖比例 (25%，降低上限)
    HEDGE_DISABLE_ABOVE: 0.92,     // ⚠️ 新增：價格 >92% 時停用對沖（對沖方成本太高）
    
    // 時間視窗 (秒) - 優化版
    MONITORING_START: 40,          // 監控期開始 (剩餘40秒) - 稍微延後，讓價格更穩定
    MONITORING_END: 12,            // 監控期結束 (剩餘12秒)
    FINAL_DECISION_TIME: 6,        // 最後決策時間點 (剩餘6秒) - 更保守
    LOCK_TIME: 4,                  // 鎖定期 (剩餘4秒以下)
    
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
    
    // 價格歷史（用於波動性計算）
    priceHistory: Array<{ up: number; down: number; timestamp: number }>;
    
    // 策略狀態
    consecutiveHighProb: { up: number; down: number };
    currentRoundOrder: SimulatedOrder | null;
    finalDecisionMade: boolean; // 本輪是否已做最後決策
    
    // 停損相關
    currentPosition: { side: "UP" | "DOWN"; entryPrice: number; amount: number } | null;
    cooldownUntil: number; // 冷卻結束時間戳
    stopLossCount: number; // 本輪停損次數
    
    // 統計
    totalRounds: number;
    wins: number;
    losses: number;
    skipped: number;
}

interface HedgeOrder {
    id: string;
    side: "UP" | "DOWN";
    price: number;
    amount: number;
    potentialReturn: number;
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
    hedgeOrder?: HedgeOrder;       // 對沖訂單
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
    
    priceHistory: [], // 價格歷史（最近 3 秒）
    
    consecutiveHighProb: { up: 0, down: 0 },
    currentRoundOrder: null,
    finalDecisionMade: false,
    
    currentPosition: null,
    cooldownUntil: 0,
    stopLossCount: 0,
    
    totalRounds: 0,
    wins: 0,
    losses: 0,
    skipped: 0,
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
// � 計算價格波動性（最近 3 秒）
// ============================================
function calculateVolatility(side: "UP" | "DOWN"): number {
    if (!CONFIG.PRICE_STABILITY_CHECK) return 0;
    
    const now = Date.now();
    const recentHistory = state.priceHistory.filter(p => now - p.timestamp < 3000);
    
    if (recentHistory.length < 2) return 0;
    
    const prices = recentHistory.map(p => side === "UP" ? p.up : p.down);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    
    // 計算波動幅度（相對於均價）
    const avgPrice = (maxPrice + minPrice) / 2;
    if (avgPrice === 0) return 0;
    
    return (maxPrice - minPrice) / avgPrice;
}

// ============================================
// 🔍 檢查是否適合入場
// ============================================
function shouldEnterTrade(price: number, side: "UP" | "DOWN"): { ok: boolean; reason?: string } {
    // 檢查價格上限（風險報酬比太差）
    if (price > CONFIG.MAX_PROB_THRESHOLD) {
        return { ok: false, reason: `價格 ${(price * 100).toFixed(1)}% > ${CONFIG.MAX_PROB_THRESHOLD * 100}% 上限` };
    }
    
    // 檢查價格下限
    if (price < CONFIG.HIGH_PROB_THRESHOLD) {
        return { ok: false, reason: `價格 ${(price * 100).toFixed(1)}% < ${CONFIG.HIGH_PROB_THRESHOLD * 100}% 門檻` };
    }
    
    // 檢查波動性
    if (CONFIG.PRICE_STABILITY_CHECK) {
        const volatility = calculateVolatility(side);
        if (volatility > CONFIG.MAX_PRICE_VOLATILITY) {
            return { ok: false, reason: `波動過大 ${(volatility * 100).toFixed(1)}% > ${CONFIG.MAX_PRICE_VOLATILITY * 100}%` };
        }
    }
    
    return { ok: true };
}

// ============================================
// 🔄 計算動態對沖比例
// ============================================
function calculateHedgeRatio(mainPrice: number): number {
    if (!CONFIG.HEDGE_ENABLED) return 0;
    
    // ⚠️ 高價格時停用對沖（對沖方成本太高，划不來）
    if (mainPrice > CONFIG.HEDGE_DISABLE_ABOVE) return 0;
    
    // 價格差距 = |主倉價格 - 對沖價格| = |mainPrice - (1-mainPrice)| = |2*mainPrice - 1|
    const priceDiff = Math.abs(2 * mainPrice - 1);
    
    // 差距越大 → 對沖比例越低
    // 差距 0.7 (85% vs 15%) → 對沖 = 15% * (1 - 0.7) = 4.5%
    // 差距 0.2 (60% vs 40%) → 對沖 = 15% * (1 - 0.2) = 12%
    let hedgeRatio = CONFIG.HEDGE_BASE_RATIO * (1 - priceDiff);
    
    // 限制在最小/最大範圍內
    hedgeRatio = Math.max(CONFIG.HEDGE_MIN_RATIO, Math.min(CONFIG.HEDGE_MAX_RATIO, hedgeRatio));
    
    return hedgeRatio;
}

// ============================================
// 🎯 模擬下單 (含對沖)
// ============================================
function simulateOrder(
    side: "UP" | "DOWN",
    price: number,
    orderType: "STANDARD" | "DEFENSIVE",
    timeRemaining: number,
    prices: { up: number; down: number }
): SimulatedOrder {
    const totalAmount = calculateBetAmount(orderType);
    const hedgeRatio = calculateHedgeRatio(price);
    
    // 計算主倉和對沖金額
    const mainAmount = Math.round(totalAmount * (1 - hedgeRatio) * 100) / 100;
    const hedgeAmount = Math.round(totalAmount * hedgeRatio * 100) / 100;
    
    const potentialReturn = mainAmount / price;
    
    const order: SimulatedOrder = {
        id: `SIM-${Date.now()}`,
        marketSlug: state.currentMarket?.slug || "unknown",
        side,
        price,
        amount: mainAmount,
        potentialReturn,
        orderType,
        timestamp: new Date(),
        timeRemaining,
    };
    
    // 建立對沖訂單
    if (CONFIG.HEDGE_ENABLED && hedgeAmount > 0) {
        const hedgeSide: "UP" | "DOWN" = side === "UP" ? "DOWN" : "UP";
        const hedgePrice = side === "UP" ? prices.down : prices.up;
        
        order.hedgeOrder = {
            id: `HEDGE-${Date.now()}`,
            side: hedgeSide,
            price: hedgePrice,
            amount: hedgeAmount,
            potentialReturn: hedgeAmount / hedgePrice,
        };
    }
    
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🎯 模擬下單 [${orderType}] ${CONFIG.HEDGE_ENABLED ? "+ 對沖" : ""}`);
    console.log(`   📈 主倉: ${side} @ ${(price * 100).toFixed(2)}% | $${mainAmount.toFixed(2)}`);
    if (order.hedgeOrder) {
        console.log(`   📉 對沖: ${order.hedgeOrder.side} @ ${(order.hedgeOrder.price * 100).toFixed(2)}% | $${hedgeAmount.toFixed(2)}`);
        console.log(`   📊 比例: ${((1-hedgeRatio)*100).toFixed(0)}:${(hedgeRatio*100).toFixed(0)}`);
    }
    console.log(`   💰 總金額: $${totalAmount.toFixed(2)}`);
    console.log(`   ⏱️ 剩餘時間: ${timeRemaining}s`);
    console.log(`${"=".repeat(50)}\n`);
    
    return order;
}

// ============================================
// � 停損執行
// ============================================
function executeStopLoss(currentPrice: number): void {
    if (!state.currentPosition) return;
    
    const { side, entryPrice, amount } = state.currentPosition;
    
    // 計算損失: 價格下跌比例 * 下注金額
    const priceDrop = entryPrice - currentPrice;
    const loss = (priceDrop / entryPrice) * amount;
    
    state.balance -= loss;
    state.stopLossCount++;
    state.cooldownUntil = Date.now() + CONFIG.COOLDOWN_MS;
    
    console.log(`\n${"⚠️".repeat(15)}`);
    console.log(`🚨 觸發停損!`);
    console.log(`   方向: ${side}`);
    console.log(`   入場價: ${(entryPrice * 100).toFixed(2)}%`);
    console.log(`   當前價: ${(currentPrice * 100).toFixed(2)}%`);
    console.log(`   價格跌幅: ${((priceDrop / entryPrice) * 100).toFixed(2)}%`);
    console.log(`   損失: -$${loss.toFixed(2)}`);
    console.log(`   餘額: $${state.balance.toFixed(2)}`);
    console.log(`   冷卻: ${CONFIG.COOLDOWN_MS / 1000}秒`);
    console.log(`${"⚠️".repeat(15)}\n`);
    
    // 清除持倉
    state.currentPosition = null;
    state.currentRoundOrder = null;
    state.tradingState = TradingState.COOLDOWN;
}

// ============================================
// �📈 結算處理
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
    
    // 計算損益（含對沖）
    const isMainWin = order.side === winner;
    let profit = 0;
    
    // 主倉損益
    if (isMainWin) {
        profit += order.potentialReturn - order.amount;
    } else {
        profit -= order.amount;
    }
    
    // 對沖損益
    if (order.hedgeOrder) {
        const isHedgeWin = order.hedgeOrder.side === winner;
        if (isHedgeWin) {
            profit += order.hedgeOrder.potentialReturn - order.hedgeOrder.amount;
        } else {
            profit -= order.hedgeOrder.amount;
        }
    }
    
    // 更新餘額
    state.balance += profit;
    
    const totalAmount = order.amount + (order.hedgeOrder?.amount || 0);
    
    if (profit > 0) {
        state.wins++;
        console.log(`   🎉 獲利！結果: ${winner} | 淨利 +$${profit.toFixed(2)}`);
    } else {
        state.losses++;
        console.log(`   😞 虧損！結果: ${winner} | 淨損 -$${Math.abs(profit).toFixed(2)}`);
    }
    
    console.log(`   目前餘額: $${state.balance.toFixed(2)}`);
    
    // 記錄交易
    tradeHistory.push({
        round: state.totalRounds,
        marketSlug: order.marketSlug,
        side: order.side,
        orderType: order.orderType,
        entryPrice: order.price,
        amount: order.amount + (order.hedgeOrder?.amount || 0),
        result: profit > 0 ? "WIN" : "LOSS",
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
    
    // 記錄價格歷史（用於波動性計算）
    const now = Date.now();
    state.priceHistory.push({ up: prices.up, down: prices.down, timestamp: now });
    // 只保留最近 5 秒的歷史
    state.priceHistory = state.priceHistory.filter(p => now - p.timestamp < 5000);
    
    // 跳過或結算中，不處理
    if (state.tradingState === TradingState.SKIPPED ||
        state.tradingState === TradingState.SETTLING) {
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 🚨 持倉中 - 監控停損 (已註解)
    if (state.tradingState === TradingState.HOLDING && state.currentPosition) {
        // 停損功能已停用，直接等待結算
        displayStatus(prices, timeRemaining);
        return;
        
        /* 停損郏輯註解開始
        const { side, entryPrice } = state.currentPosition;
        const currentPrice = side === "UP" ? prices.up : prices.down;
        const priceDrop = entryPrice - currentPrice;
        const dropPercent = priceDrop / entryPrice;
        
        // 檢查是否觸發停損
        if (dropPercent >= CONFIG.STOP_LOSS_THRESHOLD) {
            // 執行停損計算
            const loss = (priceDrop / entryPrice) * state.currentPosition.amount;
            state.balance -= loss;
            state.stopLossCount++;
            
            console.log(`\n${"⚠️".repeat(15)}`);
            console.log(`🚨 觸發停損!`);
            console.log(`   方向: ${side} @ ${(entryPrice * 100).toFixed(2)}%`);
            console.log(`   觸發價: ${(currentPrice * 100).toFixed(2)}%`);
            console.log(`   跌幅: ${(dropPercent * 100).toFixed(2)}%`);
            console.log(`   損失: -$${loss.toFixed(2)}`);
            console.log(`   餘額: $${state.balance.toFixed(2)}`);
            console.log(`   本輪停損次數: ${state.stopLossCount}/${CONFIG.MAX_STOP_LOSS_PER_ROUND}`);
            
            // 清除持倉
            state.currentPosition = null;
            state.currentRoundOrder = null;
            
            // 檢查是否達到本輪停損上限
            if (state.stopLossCount >= CONFIG.MAX_STOP_LOSS_PER_ROUND) {
                console.log(`   🚫 已達本輪停損上限，本輪不再入場`);
                state.tradingState = TradingState.SKIPPED;
            } else if (timeRemaining < CONFIG.LOCK_TIME) {
                // 鎖定期停損後不再重新入場
                console.log(`   🔒 鎖定期停損，本輪不再入場`);
                state.tradingState = TradingState.SKIPPED;
            } else {
                // 非鎖定期且未達上限，進入冷卻期
                console.log(`   ❄️ 進入冷卻期 ${CONFIG.COOLDOWN_MS / 1000} 秒`);
                state.cooldownUntil = Date.now() + CONFIG.COOLDOWN_MS;
                state.tradingState = TradingState.COOLDOWN;
            }
            console.log(`${"⚠️".repeat(15)}\n`);
            
            displayStatus(prices, timeRemaining);
            return;
        }
        
        displayStatus(prices, timeRemaining);
        return;
        停損郏輯註解結束 */
    }
    
    // ❄️ 冷卻期 - 等待後重新入場 (已註解 - 停損功能停用)
    /* COOLDOWN 處理註解開始
    if (state.tradingState === TradingState.COOLDOWN) {
        const now = Date.now();
        
        // 冷卻尚未結束
        if (now < state.cooldownUntil) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 檢查是否已達到本輪停損上限
        if (state.stopLossCount >= CONFIG.MAX_STOP_LOSS_PER_ROUND) {
            console.log(`\n🚫 已達本輪停損上限 (${state.stopLossCount}次)，本輪不再入場`);
            state.tradingState = TradingState.SKIPPED;
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 冷卻結束，檢查是否可以重新入場
        const higherPrice = Math.max(prices.up, prices.down);
        const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
        
        // 鎖定期不允許重新入場
        if (timeRemaining < CONFIG.LOCK_TIME) {
            state.tradingState = TradingState.LOCKED;
            console.log("\n❄️ 冷卻結束但已進入鎖定期，本輪不再入場");
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 檢查是否達到重新入場條件
        if (higherPrice >= CONFIG.MIN_REBUY_PROB) {
            console.log(`\n♻️ 冷卻結束，重新入場: ${higherSide} @ ${(higherPrice * 100).toFixed(2)}%`);
            
            const order = simulateOrder(higherSide, higherPrice, "DEFENSIVE", timeRemaining, prices);
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
    COOLDOWN 處理註解結束 */
    
    // 已下單（但還沒設定持倉），轉換到持倉狀態
    if (state.tradingState === TradingState.ORDERED && state.currentRoundOrder && !state.currentPosition) {
        const order = state.currentRoundOrder;
        state.currentPosition = {
            side: order.side,
            entryPrice: order.price,
            amount: order.amount,
        };
        state.tradingState = TradingState.HOLDING;
        console.log(`\n📊 開始持倉監控 (停損已停用)`);
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 鎖定期 (< 5s)
    if (timeRemaining < CONFIG.LOCK_TIME) {
        if (state.tradingState !== TradingState.LOCKED) {
            state.tradingState = TradingState.LOCKED;
            console.log("\n🔒 進入鎖定期，禁止下單");
        }
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 最後決策期 (12s ~ 4s)
    if (timeRemaining <= CONFIG.MONITORING_END && timeRemaining >= CONFIG.LOCK_TIME) {
        if (state.tradingState !== TradingState.FINAL_DECISION) {
            state.tradingState = TradingState.FINAL_DECISION;
            console.log("\n⚡ 進入最後決策期");
        }
        
        // T-6s 或更早時執行最後決策（只執行一次）
        if (!state.finalDecisionMade && timeRemaining <= CONFIG.FINAL_DECISION_TIME) {
            state.finalDecisionMade = true;
            const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
            const higherPrice = Math.max(prices.up, prices.down);
            
            // ⚠️ 檢查是否適合入場
            const entryCheck = shouldEnterTrade(higherPrice, higherSide);
            
            if (!entryCheck.ok) {
                console.log(`\n⚠️ T-${timeRemaining}s 跳過入場: ${entryCheck.reason}`);
                state.tradingState = TradingState.SKIPPED;
                displayStatus(prices, timeRemaining);
                return;
            }
            
            console.log(`\n⚡ T-${timeRemaining}s 最後決策: ${higherSide} (${(higherPrice * 100).toFixed(2)}%)`);
            
            const order = simulateOrder(higherSide, higherPrice, "DEFENSIVE", timeRemaining, prices);
            state.currentRoundOrder = order;
            state.currentPosition = {
                side: higherSide,
                entryPrice: higherPrice,
                amount: order.amount,
            };
            state.tradingState = TradingState.HOLDING;
            console.log(`📊 開始持倉監控 (停損已停用)`);
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 監控期 (40s ~ 12s)
    if (timeRemaining <= CONFIG.MONITORING_START && timeRemaining > CONFIG.MONITORING_END) {
        if (state.tradingState !== TradingState.MONITORING) {
            state.tradingState = TradingState.MONITORING;
            state.consecutiveHighProb = { up: 0, down: 0 };
            console.log("\n👀 進入監控期");
        }
        
        // 檢查高勝率（需要在範圍內：86% ~ 94%）
        const upCheck = shouldEnterTrade(prices.up, "UP");
        const downCheck = shouldEnterTrade(prices.down, "DOWN");
        
        if (upCheck.ok) {
            state.consecutiveHighProb.up++;
            state.consecutiveHighProb.down = 0;
            
            if (state.consecutiveHighProb.up >= CONFIG.CONSECUTIVE_HITS) {
                console.log(`\n🎯 UP 連續 ${state.consecutiveHighProb.up} 次達標！(${(prices.up * 100).toFixed(1)}%)`);
                const order = simulateOrder("UP", prices.up, "STANDARD", timeRemaining, prices);
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: "UP",
                    entryPrice: prices.up,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                console.log(`📊 開始持倉監控 (停損已停用)`);
            }
        } else if (downCheck.ok) {
            state.consecutiveHighProb.down++;
            state.consecutiveHighProb.up = 0;
            
            if (state.consecutiveHighProb.down >= CONFIG.CONSECUTIVE_HITS) {
                console.log(`\n🎯 DOWN 連續 ${state.consecutiveHighProb.down} 次達標！(${(prices.down * 100).toFixed(1)}%)`);
                const order = simulateOrder("DOWN", prices.down, "STANDARD", timeRemaining, prices);
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: "DOWN",
                    entryPrice: prices.down,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                console.log(`📊 開始持倉監控 (停損已停用)`);
            }
        } else {
            // 重置連續計數（價格不在有效範圍內）
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
    
    report += `\n## ⚙️ 策略參數 (優化版 v2)\n\n`;
    report += `- 入場範圍: ${CONFIG.HIGH_PROB_THRESHOLD * 100}% ~ ${CONFIG.MAX_PROB_THRESHOLD * 100}%\n`;
    report += `- 連續達標次數: ${CONFIG.CONSECUTIVE_HITS}\n`;
    report += `- 標準倉位乘數: ${CONFIG.STANDARD_MULTIPLIER} (本金/5 * ${CONFIG.STANDARD_MULTIPLIER})\n`;
    report += `- 防禦倉位乘數: ${CONFIG.DEFENSIVE_MULTIPLIER} (本金/5 * ${CONFIG.DEFENSIVE_MULTIPLIER})\n`;
    report += `- 對沖停用價格: >${CONFIG.HEDGE_DISABLE_ABOVE * 100}%\n`;
    report += `- 價格穩定性檢查: ${CONFIG.PRICE_STABILITY_CHECK ? "啟用" : "停用"}\n`;
    report += `- 最大波動容忍: ${CONFIG.MAX_PRICE_VOLATILITY * 100}%\n`;
    report += `- 停損閾值: ${CONFIG.STOP_LOSS_THRESHOLD * 100}% (已停用)\n`;
    
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
    console.log("🎮 BTC 5分鐘預測市場模擬交易系統 (優化版 v2)");
    console.log("=".repeat(60));
    console.log(`\n📋 策略配置:`);
    console.log(`   初始本金: $${CONFIG.INITIAL_BALANCE}`);
    console.log(`   入場範圍: ${CONFIG.HIGH_PROB_THRESHOLD * 100}% ~ ${CONFIG.MAX_PROB_THRESHOLD * 100}%`);
    console.log(`   連續達標: ${CONFIG.CONSECUTIVE_HITS} 次`);
    console.log(`   標準倉位: $${(CONFIG.INITIAL_BALANCE / 5 * CONFIG.STANDARD_MULTIPLIER).toFixed(2)}`);
    console.log(`   防禦倉位: $${(CONFIG.INITIAL_BALANCE / 5 * CONFIG.DEFENSIVE_MULTIPLIER).toFixed(2)}`);
    console.log(`   對沖停用價格: >${CONFIG.HEDGE_DISABLE_ABOVE * 100}%`);
    console.log(`   價格穩定性檢查: ${CONFIG.PRICE_STABILITY_CHECK ? "啟用" : "停用"}`);
    console.log(`\n🚨 停損機制: ⚠️ 已停用`);
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
                state.currentPosition = null;
                state.cooldownUntil = 0;
                state.stopLossCount = 0;
                state.priceHistory = []; // 清空價格歷史
                
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
