export type BtcSide = "UP" | "DOWN";

export interface BtcEdgeSignal {
    side: BtcSide;
    modelProbability: number;
    marketProbability: number;
    edge: number;
    upProbability: number;
    downProbability: number;
    currentPrice: number;
    candleOpen: number;
    volatility5m: number;
    momentumScore: number;
    reason: string;
    timestamp: number;
}

interface BinanceKline {
    openTime: number;
    open: number;
    close: number;
    closeTime: number;
}

const DEFAULT_BINANCE_API_URL = "https://api.binance.com";

let cachedSignal: BtcEdgeSignal | null = null;
let cachedAt = 0;
let inFlight: Promise<BtcEdgeSignal | null> | null = null;

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

export function externalSignalEnabled(): boolean {
    return (process.env.USE_EXTERNAL_SIGNAL || "true").toLowerCase() !== "false";
}

export function externalSignalFailOpen(): boolean {
    return (process.env.EXTERNAL_SIGNAL_FAIL_OPEN || "false").toLowerCase() === "true";
}

function normalCdf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * absX);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
    return 0.5 * (1 + erf);
}

function clampProbability(value: number): number {
    return Math.min(0.995, Math.max(0.005, value));
}

function stddev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

function parseKline(raw: any[]): BinanceKline {
    return {
        openTime: Number(raw[0]),
        open: Number(raw[1]),
        close: Number(raw[4]),
        closeTime: Number(raw[6]),
    };
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json() as T;
    } finally {
        clearTimeout(timeout);
    }
}

async function buildSignal(prices: { up: number; down: number }, timeRemaining: number): Promise<BtcEdgeSignal | null> {
    const apiUrl = process.env.BINANCE_API_URL || DEFAULT_BINANCE_API_URL;
    const symbol = process.env.BINANCE_SYMBOL || "BTCUSDT";
    const lookback = Math.max(30, Math.floor(envNumber("EXTERNAL_SIGNAL_LOOKBACK", 120)));
    const timeoutMs = Math.max(500, Math.floor(envNumber("EXTERNAL_SIGNAL_TIMEOUT_MS", 2500)));
    const momentumWeight = envNumber("EXTERNAL_SIGNAL_MOMENTUM_WEIGHT", 0.12);

    const [klinesRaw, ticker] = await Promise.all([
        fetchJson<any[][]>(`${apiUrl}/api/v3/klines?symbol=${symbol}&interval=5m&limit=${lookback + 1}`, timeoutMs),
        fetchJson<{ price: string }>(`${apiUrl}/api/v3/ticker/price?symbol=${symbol}`, timeoutMs),
    ]);

    const klines = klinesRaw.map(parseKline).filter(k => Number.isFinite(k.open) && Number.isFinite(k.close));
    if (klines.length < 20) return null;

    const currentKline = klines[klines.length - 1];
    const completed = klines.slice(0, -1);
    const returns = completed
        .slice(1)
        .map((kline, index) => Math.log(kline.close / completed[index].close))
        .filter(Number.isFinite);

    const volatility5m = stddev(returns);
    if (!Number.isFinite(volatility5m) || volatility5m <= 0) return null;

    const currentPrice = Number(ticker.price);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || currentKline.open <= 0) return null;

    const remainingFraction = Math.max(0.05, Math.min(1, timeRemaining / 300));
    const distanceFromOpen = Math.log(currentPrice / currentKline.open);
    const recentReturns = returns.slice(-3);
    const momentum = recentReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, recentReturns.length);
    const momentumScore = momentum / volatility5m;
    const z = (distanceFromOpen / (volatility5m * Math.sqrt(remainingFraction))) + (momentumWeight * momentumScore);
    const upProbability = clampProbability(normalCdf(z));
    const downProbability = 1 - upProbability;

    const upEdge = upProbability - prices.up;
    const downEdge = downProbability - prices.down;
    const side: BtcSide = upEdge >= downEdge ? "UP" : "DOWN";
    const modelProbability = side === "UP" ? upProbability : downProbability;
    const marketProbability = side === "UP" ? prices.up : prices.down;
    const edge = modelProbability - marketProbability;

    return {
        side,
        modelProbability,
        marketProbability,
        edge,
        upProbability,
        downProbability,
        currentPrice,
        candleOpen: currentKline.open,
        volatility5m,
        momentumScore,
        reason: `${symbol} model ${side}: model=${(modelProbability * 100).toFixed(2)}%, market=${(marketProbability * 100).toFixed(2)}%, edge=${(edge * 100).toFixed(2)}%`,
        timestamp: Date.now(),
    };
}

export async function getBtcEdgeSignal(
    prices: { up: number; down: number },
    timeRemaining: number
): Promise<BtcEdgeSignal | null> {
    const cacheMs = Math.max(250, Math.floor(envNumber("EXTERNAL_SIGNAL_CACHE_MS", 2000)));
    const now = Date.now();

    if (cachedSignal && now - cachedAt <= cacheMs) return cachedSignal;
    if (inFlight) return inFlight;

    inFlight = buildSignal(prices, timeRemaining)
        .then(signal => {
            cachedSignal = signal;
            cachedAt = Date.now();
            return signal;
        })
        .catch(() => null)
        .finally(() => {
            inFlight = null;
        });

    return inFlight;
}
