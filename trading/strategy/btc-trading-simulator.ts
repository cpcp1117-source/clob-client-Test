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
import { externalSignalEnabled, externalSignalFailOpen, getBtcEdgeSignal } from "./btc-edge-signal.ts";
import { sendDiscordNotificationNow } from "./discord-notifier.ts";

dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

// ============================================
// 🎛️ 策略配置
// ============================================
const CONFIG = {
    // 資金管理
    INITIAL_BALANCE: envNumber("SIM_INITIAL_BALANCE", 50),
    STANDARD_RATIO: envNumber("STANDARD_RATIO", 0.05),
    DEFENSIVE_RATIO: envNumber("DEFENSIVE_RATIO", 0.03),
    MAX_BET_AMOUNT: envNumber("MAX_BET_AMOUNT", 5),
    MIN_CASH_RESERVE: envNumber("MIN_CASH_RESERVE", 2),
    MAX_SESSION_LOSS_RATIO: envNumber("MAX_SESSION_LOSS_RATIO", 0.15),
    
    // 策略參數
    HIGH_PROB_THRESHOLD: envNumber("HIGH_PROB_THRESHOLD", 0.88),
    FINAL_PROB_THRESHOLD: envNumber("FINAL_PROB_THRESHOLD", 0.90),
    REBUY_PROB_THRESHOLD: envNumber("REBUY_PROB_THRESHOLD", 0.90),
    CONSECUTIVE_HITS: envNumber("CONSECUTIVE_HITS", 6),
    MAX_ENTRY_PRICE: envNumber("MAX_ENTRY_PRICE", 0.96),
    MIN_NET_RETURN_RATIO: envNumber("MIN_NET_RETURN_RATIO", 0.04),
    MIN_MODEL_EDGE: envNumber("MIN_MODEL_EDGE", 0.03),
    MAX_LATENCY: 500,              // 最大延遲 ms
    
    // 停損機制
    STOP_LOSS_THRESHOLD: envNumber("STOP_LOSS_THRESHOLD", 0.10),
    STOP_LOSS_CONFIRM_COUNT: envNumber("STOP_LOSS_CONFIRM_COUNT", 4),
    STOP_LOSS_HOLD_SECONDS: 5,     // 最後 N 秒不執行停損（只保護最後5秒）
    REBUY_WAIT_UNTIL_SECONDS: 5,   // 停損後等到最後 N 秒才能重新下單
    MIN_REBUY_PROB: envNumber("MIN_REBUY_PROB", envNumber("REBUY_PROB_THRESHOLD", 0.90)),
    MIN_PRICE_GAP: envNumber("MIN_PRICE_GAP", 0.40),
    MIN_ENTRY_SECONDS: envNumber("MIN_ENTRY_SECONDS", 5),
    MAX_ENTRY_SECONDS: envNumber("MAX_ENTRY_SECONDS", 300),
    STABLE_PRICE_TOLERANCE: 0.02,  // 價格穩定容忍度
    MAX_REBUY_PER_ROUND: 1,        // 每輪最多重新下單次數
    
    // 時間視窗 (秒)
    MONITORING_START: 300,         // 監控期開始 (完整 5 分鐘)
    MONITORING_END: 5,             // 最後 5 秒停止新進場
    FINAL_DECISION_TIME: 5,
    LOCK_TIME: 5,                  // 鎖定期 (剩餘5秒以下)
    SLIPPAGE_RATE: 0.002,          // 模擬滑點 0.20%
    TAKER_FEE_RATE: 0.0072,        // 模擬 taker fee 0.72%
    
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

interface RoundSummary {
    round: number;
    marketSlug: string;
    action: "WAITING" | "ORDER" | "SKIP";
    side?: "UP" | "DOWN";
    signalPrice?: number;
    executionPrice?: number;
    amount?: number;
    orderType?: "STANDARD" | "DEFENSIVE";
    stopLosses: number;
    pnl: number;
    result: "PENDING" | "WIN" | "LOSS" | "SKIPPED" | "STOP_LOSS";
    note?: string;
    notified: boolean;
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
let lastEventKey = "";
let lastNoMarketLogAt = 0;
let currentRoundSummary: RoundSummary | null = null;
const roundSummariesByOrderId = new Map<string, RoundSummary>();

// 待結算訂單列表
let pendingSettlements: SimulatedOrder[] = [];
let settlementInProgress = false;

function formatPriceLine(prices: { up: number; down: number }, timeRemaining: number): string {
    return `${outcomeLabels.up}=${(prices.up * 100).toFixed(2)}% ${outcomeLabels.down}=${(prices.down * 100).toFixed(2)}% T-${timeRemaining}s balance=$${state.balance.toFixed(2)}`;
}

function formatMoney(value: number): string {
    return `$${value.toFixed(2)}`;
}

function formatSignedMoney(value: number): string {
    return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function getWinRate(): string {
    const settledTrades = state.wins + state.losses;
    if (settledTrades === 0) return "0.0%";
    return `${((state.wins / settledTrades) * 100).toFixed(1)}%`;
}

function getResultText(result: RoundSummary["result"]): string {
    if (result === "WIN") return "獲勝";
    if (result === "LOSS") return "輸錢";
    if (result === "SKIPPED") return "跳過";
    if (result === "STOP_LOSS") return "停損";
    return "未結算";
}

function getRoundAction(summary: RoundSummary): string {
    if (summary.action === "ORDER" && summary.side && summary.signalPrice && summary.amount) {
        const execution = summary.executionPrice ? ` 成交${(summary.executionPrice * 100).toFixed(2)}%` : "";
        const rebuy = summary.orderType === "DEFENSIVE" ? " 再進場" : "";
        return `下單${summary.side}${rebuy} ${(summary.signalPrice * 100).toFixed(2)}% ${formatMoney(summary.amount)}${execution}`;
    }
    if (summary.action === "SKIP") return summary.note || "本輪跳過";
    return "本輪未下單";
}

function sendRoundDiscordSummary(summary: RoundSummary): void {
    if (summary.notified) return;
    summary.notified = true;

    sendDiscordNotificationNow(
        [
            `BTC 5m 第 ${summary.round} 輪總結`,
            `做了什麼：${getRoundAction(summary)}`,
            `結果：${getResultText(summary.result)} | 本輪盈虧：${formatSignedMoney(summary.pnl)}`,
            `目前金額：${formatMoney(state.balance)}`,
            `統計：贏 ${state.wins} / 輸 ${state.losses} / 跳過 ${state.skipped} / 停損 ${state.stopLossCount}`,
            `勝率：${getWinRate()} | 總盈虧：${formatSignedMoney(state.balance - CONFIG.INITIAL_BALANCE)}`,
            summary.stopLosses > 0 ? `本輪停損：${summary.stopLosses} 次` : null,
            summary.note ? `備註：${summary.note}` : null,
            "--------------------",
        ].filter(Boolean).join("\n")
    );
}

function startRoundSummary(round: number, marketSlug: string): void {
    currentRoundSummary = {
        round,
        marketSlug,
        action: "WAITING",
        stopLosses: 0,
        pnl: 0,
        result: "PENDING",
        notified: false,
    };
}

function markRoundSkipped(note: string): void {
    if (!currentRoundSummary) return;
    currentRoundSummary.action = "SKIP";
    currentRoundSummary.result = "SKIPPED";
    currentRoundSummary.note = note;
    currentRoundSummary.pnl = 0;
}

function logEvent(event: string, message: string, prices?: { up: number; down: number }, timeRemaining?: number) {
    const now = new Date().toLocaleString("zh-TW");
    const priceText = prices && typeof timeRemaining === "number"
        ? ` | ${formatPriceLine(prices, timeRemaining)}`
        : "";
    const key = `${event}:${message}:${priceText}`;
    if (key === lastEventKey) return;
    lastEventKey = key;
    const line = `[${now}] ${event} ${message}${priceText}`;
    console.log(line);
    if (event === "SKIP" && currentRoundSummary?.result !== "STOP_LOSS" && currentRoundSummary?.action !== "ORDER") {
        markRoundSkipped(message);
    }
}

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
    const ratio = orderType === "STANDARD" ? CONFIG.STANDARD_RATIO : CONFIG.DEFENSIVE_RATIO;
    const tradableBalance = Math.max(0, state.balance - CONFIG.MIN_CASH_RESERVE);
    const amount = Math.min(tradableBalance * ratio, CONFIG.MAX_BET_AMOUNT);
    if (amount < 1) return 0;
    return Math.round(amount * 100) / 100;
}

function sessionLossExceeded(): boolean {
    if (CONFIG.INITIAL_BALANCE <= 0) return false;
    const minBalance = CONFIG.INITIAL_BALANCE * (1 - CONFIG.MAX_SESSION_LOSS_RATIO);
    return state.balance <= minBalance;
}

function hasEnoughNetReturn(price: number): boolean {
    if (price <= 0) return false;
    const netReturnRatio = (1 / price) - 1;
    return netReturnRatio >= CONFIG.MIN_NET_RETURN_RATIO;
}

function shouldEnterTrade(
    side: "UP" | "DOWN",
    price: number,
    amount: number,
    minProbability: number,
    reason: string
): boolean {
    if (sessionLossExceeded()) {
        console.log(`\n🛑 跳過 ${reason}: 本次執行虧損已達 ${(CONFIG.MAX_SESSION_LOSS_RATIO * 100).toFixed(1)}% 風控線`);
        return false;
    }
    if (amount < 1) {
        console.log(`\n🛑 跳過 ${reason}: 可用下單金額不足 $1，保留現金 $${CONFIG.MIN_CASH_RESERVE.toFixed(2)}`);
        return false;
    }
    if (price < minProbability) {
        console.log(`\n⏭️ 跳過 ${reason}: ${side} ${(price * 100).toFixed(2)}% 未達 ${(minProbability * 100).toFixed(2)}%`);
        return false;
    }
    if (price > CONFIG.MAX_ENTRY_PRICE) {
        console.log(`\n⏭️ 跳過 ${reason}: 入場價 ${(price * 100).toFixed(2)}% 高於上限 ${(CONFIG.MAX_ENTRY_PRICE * 100).toFixed(2)}%`);
        return false;
    }
    if (!hasEnoughNetReturn(price)) {
        console.log(`\n⏭️ 跳過 ${reason}: 潛在淨報酬低於 ${(CONFIG.MIN_NET_RETURN_RATIO * 100).toFixed(2)}%`);
        return false;
    }
    return true;
}

async function passesExternalSignal(
    side: "UP" | "DOWN",
    prices: { up: number; down: number },
    timeRemaining: number,
    reason: string
): Promise<boolean> {
    if (!externalSignalEnabled()) return true;

    const signal = await getBtcEdgeSignal(prices, timeRemaining);
    if (!signal) {
        const action = externalSignalFailOpen() ? "允許" : "阻擋";
        console.log(`\n⚠️ 外部 BTC 訊號不可用，${action} ${reason}`);
        return externalSignalFailOpen();
    }

    console.log(`\n📡 ${signal.reason}`);

    if (signal.side !== side) {
        console.log(`   ⏭️ 跳過 ${reason}: 外部模型偏向 ${signal.side}，不是 ${side}`);
        return false;
    }
    if (signal.edge < CONFIG.MIN_MODEL_EDGE) {
        console.log(`   ⏭️ 跳過 ${reason}: 模型 edge ${(signal.edge * 100).toFixed(2)}% 低於 ${(CONFIG.MIN_MODEL_EDGE * 100).toFixed(2)}%`);
        return false;
    }
    return true;


function getOptimizedSignal(
    prices: { up: number; down: number },
    timeRemaining: number
): { side: "UP" | "DOWN"; price: number; gap: number } | null {
    if (timeRemaining < CONFIG.MIN_ENTRY_SECONDS || timeRemaining > CONFIG.MAX_ENTRY_SECONDS) {
        return null;
    }

    const side: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
    const price = side === "UP" ? prices.up : prices.down;
    const gap = Math.abs(prices.up - prices.down);

    if (price < CONFIG.HIGH_PROB_THRESHOLD) return null;
    if (price > CONFIG.MAX_ENTRY_PRICE) return null;
    if (gap < CONFIG.MIN_PRICE_GAP) return null;

    return { side, price, gap };
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
    const executionPrice = Math.min(price * (1 + CONFIG.SLIPPAGE_RATE), 0.999);

    // 2. 模擬 Taker 動態手續費 (Polymarket 新公式)
    // 最高手續費約為 1.56% (出現在 50% 勝率)，在極端勝率會對稱遞減近乎 0
    const dynamicFeeRate = CONFIG.TAKER_FEE_RATE;
    
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

    if (currentRoundSummary) {
        currentRoundSummary.action = "ORDER";
        currentRoundSummary.side = side;
        currentRoundSummary.signalPrice = price;
        currentRoundSummary.executionPrice = executionPrice;
        currentRoundSummary.amount = rawBudget;
        currentRoundSummary.orderType = orderType;
        currentRoundSummary.result = "PENDING";
        roundSummariesByOrderId.set(order.id, currentRoundSummary);
    }
    
    return order;
}

// ============================================
// 🚨 停損執行 (已廢棄，改由 processStrategy 直接處理)
// ============================================
// 此函數不再使用，停損邏輯已整合到 processStrategy 中

// ============================================
// 📈 結算處理
// ============================================
async function getGammaMarketBySlug(slug: string): Promise<any | null> {
    try {
        const marketResponse = await fetch(`${CONFIG.GAMMA_API_URL}/markets?slug=${slug}`);
        const markets = await marketResponse.json();
        if (markets && markets.length > 0) return markets[0];
    } catch {}

    try {
        const eventResponse = await fetch(`${CONFIG.GAMMA_API_URL}/events?slug=${slug}`);
        const events = await eventResponse.json();
        if (events && events.length > 0 && events[0].markets && events[0].markets.length > 0) {
            return events[0].markets[0];
        }
    } catch {}

    return null;
}

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
                const market = await getGammaMarketBySlug(order.marketSlug);
                
                if (!market) {
                    if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY);
                    continue;
                }
                
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
        logEvent("PENDING", `${order.marketSlug} ${order.side} result unavailable`);
        const summary = roundSummariesByOrderId.get(order.id);
        if (summary) {
            summary.result = "PENDING";
            summary.note = "市場結果尚未取得";
            sendRoundDiscordSummary(summary);
            roundSummariesByOrderId.delete(order.id);
        }
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
        logEvent("WIN", `${order.marketSlug} ${order.side} winner=${winner} profit=+$${profit.toFixed(2)} balance=$${state.balance.toFixed(2)}`);
    } else {
        state.losses++;
        console.log(`   😞 失敗！結果: ${winner} | 損失 -$${order.amount.toFixed(2)}`);
        logEvent("LOSS", `${order.marketSlug} ${order.side} winner=${winner} loss=-$${order.amount.toFixed(2)} balance=$${state.balance.toFixed(2)}`);
    }

    const summary = roundSummariesByOrderId.get(order.id);
    if (summary) {
        summary.result = isWin ? "WIN" : "LOSS";
        summary.pnl += profit;
        sendRoundDiscordSummary(summary);
        roundSummariesByOrderId.delete(order.id);
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
    state.lastPrices = prices;
}

// ============================================
// 🎮 策略核心邏輯
// ============================================
async function processStrategy(prices: { up: number; down: number }, timeRemaining: number) {
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
                logEvent("STOP_WARN", `${side} drop ${(dropPercent * 100).toFixed(2)}% (${state.stopLossConfirmCount}/${CONFIG.STOP_LOSS_CONFIRM_COUNT})`, prices, timeRemaining);
                displayStatus(prices, timeRemaining);
                return;
            }
            
            // 執行停損計算
            const loss = (priceDrop / entryPrice) * state.currentPosition.amount;
            state.balance -= loss;
            state.stopLossConfirmCount = 0; // 重置
            state.stopLossCount++; // 統計停損次數
            state.stopLossTotalAmount += loss; // 統計停損金額
            if (currentRoundSummary) {
                currentRoundSummary.stopLosses++;
                currentRoundSummary.pnl -= loss;
                currentRoundSummary.result = "STOP_LOSS";
                currentRoundSummary.note = `${side} 停損 ${(currentPrice * 100).toFixed(2)}%`;
            }
            
            logEvent("STOP_LOSS", `${side} entry ${(entryPrice * 100).toFixed(2)}% current ${(currentPrice * 100).toFixed(2)}% loss -$${loss.toFixed(2)}`, prices, timeRemaining);
            
            // 清除持倉
            state.currentPosition = null;
            state.currentRoundOrder = null;
            state.stopLossTriggered = true;
            
            // 檢查是否達到本輪重買上限
            if (state.rebuyCount >= CONFIG.MAX_REBUY_PER_ROUND) {
                logEvent("SKIP", "rebuy limit reached", prices, timeRemaining);
                state.tradingState = TradingState.SKIPPED;
            } else {
                // 等待最後5秒重新入場
                logEvent("COOLDOWN", `wait final ${CONFIG.REBUY_WAIT_UNTIL_SECONDS}s for rebuy`, prices, timeRemaining);
                state.tradingState = TradingState.COOLDOWN;
            }

            
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
            logEvent("SKIP", `rebuy limit reached (${state.rebuyCount})`, prices, timeRemaining);
            state.tradingState = TradingState.SKIPPED;
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 到達最後5秒，仍使用新策略條件檢查是否可以重新入場
        const signal = getOptimizedSignal(prices, timeRemaining);
        const higherPrice = signal?.price ?? Math.max(prices.up, prices.down);
        const higherSide: "UP" | "DOWN" = signal?.side ?? (prices.up >= prices.down ? "UP" : "DOWN");
        
        if (signal && higherPrice >= CONFIG.MIN_REBUY_PROB) {
            state.rebuyCount++;
            logEvent("REBUY", `${higherSide} @ ${(higherPrice * 100).toFixed(2)}% (#${state.rebuyCount})`, prices, timeRemaining);
            
            const order = simulateOrder(higherSide, higherPrice, "DEFENSIVE", timeRemaining);
            if (!shouldEnterTrade(higherSide, higherPrice, order.amount, CONFIG.MIN_REBUY_PROB, "rebuy")) {
                state.tradingState = TradingState.SKIPPED;
                displayStatus(prices, timeRemaining);
                return;
            }
            if (!(await passesExternalSignal(higherSide, prices, timeRemaining, "rebuy"))) {
                state.tradingState = TradingState.SKIPPED;
                displayStatus(prices, timeRemaining);
                return;
            }
            state.currentRoundOrder = order;
            state.currentPosition = {
                side: higherSide,
                entryPrice: order.price,
                amount: order.amount,
            };
            state.tradingState = TradingState.HOLDING;
        } else {
            // 價格不夠高，繼續等待或轉換到等待狀態
            logEvent("COOLDOWN", `no valid rebuy signal, best ${(higherPrice * 100).toFixed(2)}%`, prices, timeRemaining);
            
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
        logEvent("HOLDING", `resume ${order.side} @ ${(order.price * 100).toFixed(2)}%`, prices, timeRemaining);
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 最後決策期 (15s ~ 0s) - 取消鎖定期限制
    if (timeRemaining <= CONFIG.MONITORING_END && timeRemaining >= 0) {
        if (state.tradingState !== TradingState.FINAL_DECISION) {
            state.tradingState = TradingState.FINAL_DECISION;
            logEvent("FINAL", "enter final decision window", prices, timeRemaining);
        }
        
        // 延遲進場判斷 (T-10s)
        if (state.delayedEntry && !state.delayedEntryMade && timeRemaining <= 10) {
            state.delayedEntryMade = true;
            const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
            const higherPrice = Math.max(prices.up, prices.down);
            
            logEvent("DELAY_CHECK", `${higherSide} ${(higherPrice * 100).toFixed(1)}%`, prices, timeRemaining);
            if (higherPrice >= CONFIG.HIGH_PROB_THRESHOLD) {
                const order = simulateOrder(higherSide, higherPrice, "STANDARD", timeRemaining);
                if (!shouldEnterTrade(higherSide, higherPrice, order.amount, CONFIG.HIGH_PROB_THRESHOLD, "delayed entry")) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                if (!(await passesExternalSignal(higherSide, prices, timeRemaining, "delayed entry"))) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: higherSide,
                    entryPrice: higherPrice,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                state.finalDecisionMade = true; // 已經進場，略過後面的 finalDecision
                logEvent("HOLDING", `entered delayed ${higherSide} @ ${(order.price * 100).toFixed(2)}%`, prices, timeRemaining);
            } else {
                logEvent("SKIP", `delayed entry below threshold ${CONFIG.HIGH_PROB_THRESHOLD * 100}%`, prices, timeRemaining);
            }
        }
        
        // 最後決策：仍然使用新策略門檻，不做無條件追價
        if (!state.finalDecisionMade && timeRemaining <= CONFIG.FINAL_DECISION_TIME) {
            const signal = getOptimizedSignal(prices, timeRemaining);
            
            const higherPrice = signal?.price ?? Math.max(prices.up, prices.down);
            const higherSide: "UP" | "DOWN" = signal?.side ?? (prices.up >= prices.down ? "UP" : "DOWN");

            // 策略邏輯：只在達到最後決策門檻時進場；最後2秒也會再跑風控，不再無條件追價。
            if (higherPrice >= CONFIG.FINAL_PROB_THRESHOLD || timeRemaining <= 2) {
                state.finalDecisionMade = true;
                
                if (higherPrice >= CONFIG.FINAL_PROB_THRESHOLD) {
                    console.log(`\n⚡ T-${timeRemaining}s 達到最後決策門檻，最後決策: ${higherSide} (${(higherPrice * 100).toFixed(2)}%)`);
                } else {
                    console.log(`\n⚡ T-${timeRemaining}s 等待極限，檢查最高方是否通過風控: ${higherSide} (${(higherPrice * 100).toFixed(2)}%)`);
                }
                
                const order = simulateOrder(higherSide, higherPrice, "DEFENSIVE", timeRemaining);
                if (!shouldEnterTrade(higherSide, higherPrice, order.amount, CONFIG.FINAL_PROB_THRESHOLD, "final decision")) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                if (!(await passesExternalSignal(higherSide, prices, timeRemaining, "final decision"))) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: higherSide,
                    entryPrice: order.price,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                logEvent("HOLDING", `entered ${higherSide} @ ${(order.price * 100).toFixed(2)}%`, prices, timeRemaining);
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
            
            if (false && (prices.up >= 0.90 || prices.down >= 0.90)) {
                state.delayedEntry = true;
                const higherSide = prices.up >= prices.down ? "UP" : "DOWN";
                const higherPrice = Math.max(prices.up, prices.down);
                logEvent("MONITOR", `enter monitoring; high initial ${higherSide} ${(higherPrice * 100).toFixed(1)}%`, prices, timeRemaining);
            } else {
                state.delayedEntry = false;
                logEvent("MONITOR", "enter monitoring", prices, timeRemaining);
            }
        }
        
        if (state.delayedEntry) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 新策略：60% 以上、價差 40% 以上、價格不超過 92%
        const signal = getOptimizedSignal(prices, timeRemaining);
        if (signal?.side === "UP") {
            state.consecutiveHighProb.up++;
            state.consecutiveHighProb.down = 0;
            
            if (state.consecutiveHighProb.up >= CONFIG.CONSECUTIVE_HITS) {
                console.log(`\n🎯 UP 連續 ${state.consecutiveHighProb.up} 次達標！`);
                const order = simulateOrder("UP", prices.up, "STANDARD", timeRemaining);
                if (!shouldEnterTrade("UP", prices.up, order.amount, CONFIG.HIGH_PROB_THRESHOLD, "standard entry")) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                if (!(await passesExternalSignal("UP", prices, timeRemaining, "standard entry"))) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: "UP",
                    entryPrice: order.price,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                logEvent("HOLDING", `entered UP @ ${(order.price * 100).toFixed(2)}%`, prices, timeRemaining);
            }
        } else if (signal?.side === "DOWN") {
            state.consecutiveHighProb.down++;
            state.consecutiveHighProb.up = 0;
            
            if (state.consecutiveHighProb.down >= CONFIG.CONSECUTIVE_HITS) {
                console.log(`\n🎯 DOWN 連續 ${state.consecutiveHighProb.down} 次達標！`);
                const order = simulateOrder("DOWN", prices.down, "STANDARD", timeRemaining);
                if (!shouldEnterTrade("DOWN", prices.down, order.amount, CONFIG.HIGH_PROB_THRESHOLD, "standard entry")) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                if (!(await passesExternalSignal("DOWN", prices, timeRemaining, "standard entry"))) {
                    state.tradingState = TradingState.SKIPPED;
                    displayStatus(prices, timeRemaining);
                    return;
                }
                state.currentRoundOrder = order;
                state.currentPosition = {
                    side: "DOWN",
                    entryPrice: order.price,
                    amount: order.amount,
                };
                state.tradingState = TradingState.HOLDING;
                logEvent("HOLDING", `entered DOWN @ ${(order.price * 100).toFixed(2)}%`, prices, timeRemaining);
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
    report += `- 標準倉位比例: ${(CONFIG.STANDARD_RATIO * 100).toFixed(2)}%\n`;
    report += `- 防禦倉位比例: ${(CONFIG.DEFENSIVE_RATIO * 100).toFixed(2)}%\n`;
    report += `- 單筆上限: $${CONFIG.MAX_BET_AMOUNT.toFixed(2)}\n`;
    report += `- 最高入場價: ${(CONFIG.MAX_ENTRY_PRICE * 100).toFixed(2)}%\n`;
    report += `- 最低潛在淨報酬: ${(CONFIG.MIN_NET_RETURN_RATIO * 100).toFixed(2)}%\n`;
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
    console.log(`   標準倉位: ${(CONFIG.STANDARD_RATIO * 100).toFixed(2)}% / max $${CONFIG.MAX_BET_AMOUNT.toFixed(2)}`);
    console.log(`   防禦倉位: ${(CONFIG.DEFENSIVE_RATIO * 100).toFixed(2)}% / max $${CONFIG.MAX_BET_AMOUNT.toFixed(2)}`);
    console.log(`\n🚨 停損機制: ✅ 已啟用 (閾值: ${CONFIG.STOP_LOSS_THRESHOLD * 100}%)`);
    console.log("\n按 Ctrl+C 停止\n");
    
    state.isRunning = true;
    
    const onPriceUpdate = (prices: { up: number; down: number }) => {
        if (!state.currentMarket) return;
        
        const timeRemaining = getTimeRemaining(state.currentMarket);
        void processStrategy(prices, timeRemaining);
    };
    
    while (state.isRunning) {
        try {
            const market = await getCurrentBTC5MinMarket();
            
            if (!market) {
                if (Date.now() - lastNoMarketLogAt > 30000) {
                    lastNoMarketLogAt = Date.now();
                    logEvent("WAIT", "searching for BTC 5m market");
                }
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
                    logEvent("PENDING_SETTLEMENT", `${state.currentRoundOrder.marketSlug} ${state.currentRoundOrder.side} queued (${pendingSettlements.length})`);
                } else if (state.totalRounds > 0) {
                    console.log(`\n⏭️ 第 ${state.totalRounds} 輪跳過（無下單）`);
                    if (currentRoundSummary?.result === "STOP_LOSS") {
                        sendRoundDiscordSummary(currentRoundSummary);
                    } else {
                        state.skipped++;
                        markRoundSkipped("本輪無下單");
                        if (currentRoundSummary) sendRoundDiscordSummary(currentRoundSummary);
                        logEvent("SKIP", `round ${state.totalRounds} no order`);
                    }
                }
                
                // 重置狀態
                state.totalRounds++;
                state.currentMarket = market;
                startRoundSummary(state.totalRounds, market.slug);
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
                logEvent("NEW_MARKET", `round ${state.totalRounds}: ${market.slug}`);
                
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
                logEvent("SETTLEMENT", `processing ${pendingSettlements.length} pending order(s)`);
                
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
