export type OrderSide = "BUY" | "SELL";
export type OrderbookSide = "ask" | "bid";

export interface OrderbookLevel {
    price: number | string;
    size: number | string;
}

export interface NormalizedOrderbookLevel {
    price: number;
    size: number;
}

export interface VWAPResult {
    requestedSize: number;
    filledSize: number;
    vwap: number;
    totalCost: number;
    fullyFilled: boolean;
    levelsConsumed: readonly NormalizedOrderbookLevel[];
}

export interface ComplementArbitrageCheck {
    size: number;
    up: VWAPResult;
    down: VWAPResult;
    combinedVwap: number;
    grossEdge: number;
    requiredEdge: number;
    passes: boolean;
    reason: string;
}

export interface BinaryBuyArbitrageCheck extends ComplementArbitrageCheck {
    executable: boolean;
    expectedProfitPerShare: number;
}

export interface OrderbookSnapshot {
    bids?: readonly OrderbookLevel[];
    asks?: readonly OrderbookLevel[];
}

export interface SimulatedOrderbookSnapshot {
    bids?: readonly NormalizedOrderbookLevel[];
    asks?: readonly NormalizedOrderbookLevel[];
}

export interface ComplementArbitrageOptions {
    minProfit?: number;
    slippageBuffer?: number;
}

export interface CLOBOrderbook {
    bids?: readonly OrderbookLevel[];
    asks?: readonly OrderbookLevel[];
}

export interface TwoLegArbitrageCheck {
    executable: boolean;
    expectedProfitPerShare: number;
    requiredProfitPerShare: number;
    up: VWAPResult;
    down: VWAPResult;
    reason: "PASS" | "INSUFFICIENT_LIQUIDITY" | "EDGE_BELOW_BUFFER";
}

const DEFAULT_MIN_PROFIT = 0.03;
const DEFAULT_SLIPPAGE_BUFFER = 0.02;

function assertPositiveFinite(name: string, value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
}

function parseLevel(level: OrderbookLevel): NormalizedOrderbookLevel | null {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
        return null;
    }
    return { price, size };
}

function sortLevels(levels: readonly NormalizedOrderbookLevel[], side: OrderSide): NormalizedOrderbookLevel[] {
    return [...levels].sort((a, b) => side === "BUY" ? a.price - b.price : b.price - a.price);
}

export class VWAPCalculator {
    public calculate(
        levels: readonly OrderbookLevel[],
        targetSize: number,
        side: OrderSide = "BUY"
    ): VWAPResult {
        assertPositiveFinite("targetSize", targetSize);

        const orderedLevels = sortLevels(levels.map(parseLevel).filter(level => level !== null), side);
        let remaining = targetSize;
        let filledSize = 0;
        let totalCost = 0;
        const levelsConsumed: NormalizedOrderbookLevel[] = [];

        for (const level of orderedLevels) {
            if (remaining <= 0) break;

            const size = Math.min(remaining, level.size);
            filledSize += size;
            totalCost += size * level.price;
            remaining -= size;
            levelsConsumed.push({ price: level.price, size });
        }

        return {
            requestedSize: targetSize,
            filledSize,
            vwap: filledSize > 0 ? totalCost / filledSize : Number.POSITIVE_INFINITY,
            totalCost,
            fullyFilled: filledSize >= targetSize,
            levelsConsumed,
        };
    }

    public simulateFill(
        levels: readonly OrderbookLevel[],
        targetSize: number,
        side: OrderSide = "BUY"
    ): NormalizedOrderbookLevel[] {
        assertPositiveFinite("targetSize", targetSize);

        let remaining = targetSize;
        const orderedLevels = sortLevels(levels.map(parseLevel).filter(level => level !== null), side);
        const result: NormalizedOrderbookLevel[] = [];

        for (const level of orderedLevels) {
            if (remaining >= level.size) {
                remaining -= level.size;
                continue;
            }
            if (remaining > 0) {
                result.push({ price: level.price, size: level.size - remaining });
                remaining = 0;
                continue;
            }
            result.push(level);
        }

        return result;
    }

    public simulateConsume(
        orderbook: CLOBOrderbook,
        side: OrderbookSide,
        targetSize: number
    ): CLOBOrderbook {
        const levels = side === "ask" ? orderbook.asks ?? [] : orderbook.bids ?? [];
        const remainingLevels = this.simulateFill(levels, targetSize, side === "ask" ? "BUY" : "SELL");

        return side === "ask"
            ? { ...orderbook, asks: remainingLevels }
            : { ...orderbook, bids: remainingLevels };
    }

    public checkComplementArbitrage(
        upAsks: readonly OrderbookLevel[],
        downAsks: readonly OrderbookLevel[],
        size: number,
        options: ComplementArbitrageOptions = {}
    ): ComplementArbitrageCheck {
        assertPositiveFinite("size", size);

        const minProfit = options.minProfit ?? DEFAULT_MIN_PROFIT;
        const slippageBuffer = options.slippageBuffer ?? DEFAULT_SLIPPAGE_BUFFER;
        if (!Number.isFinite(minProfit) || minProfit < 0) throw new Error("minProfit must be non-negative");
        if (!Number.isFinite(slippageBuffer) || slippageBuffer < 0) throw new Error("slippageBuffer must be non-negative");

        const up = this.calculate(upAsks, size, "BUY");
        const down = this.calculate(downAsks, size, "BUY");
        const combinedVwap = up.vwap + down.vwap;
        const grossEdge = 1 - combinedVwap;
        const requiredEdge = minProfit + slippageBuffer;
        const passes = up.fullyFilled && down.fullyFilled && grossEdge >= requiredEdge;

        let reason = "VWAP edge clears configured buffers";
        if (!up.fullyFilled || !down.fullyFilled) {
            reason = "insufficient displayed depth for requested size";
        } else if (!passes) {
            reason = "VWAP edge does not clear configured buffers";
        }

        return {
            size,
            up,
            down,
            combinedVwap,
            grossEdge,
            requiredEdge,
            passes,
            reason,
        };
    }

    public checkBinaryBuyArbitrage(
        upAsks: readonly OrderbookLevel[],
        downAsks: readonly OrderbookLevel[],
        targetSize: number,
        options: ComplementArbitrageOptions = {}
    ): TwoLegArbitrageCheck {
        const check = this.checkComplementArbitrage(upAsks, downAsks, targetSize, options);
        let reason: TwoLegArbitrageCheck["reason"] = "PASS";
        if (!check.up.fullyFilled || !check.down.fullyFilled) {
            reason = "INSUFFICIENT_LIQUIDITY";
        } else if (!check.passes) {
            reason = "EDGE_BELOW_BUFFER";
        }

        return {
            executable: check.passes,
            expectedProfitPerShare: Math.round(check.grossEdge * 1e12) / 1e12,
            requiredProfitPerShare: check.requiredEdge,
            up: check.up,
            down: check.down,
            reason,
        };
    }

}
