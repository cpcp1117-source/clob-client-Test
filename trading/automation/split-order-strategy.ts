import type { MarketSide, MarketSnapshot } from "./types.ts";

export type SplitOrderConfig = {
  initialBalance: number;
  stakePerSide: number;
  takeProfitPct: number;
  minSecondsBeforeClose: number;
  maxSecondsBeforeClose: number;
  feeRate: number;
  slippageRate: number;
};

export type SplitEntryDecision =
  | {
      action: "BUY_BOTH";
      legs: Array<{ side: MarketSide; price: number }>;
      reason: string;
    }
  | {
      action: "HOLD" | "SKIP";
      reason: string;
    };

export type SplitExitDecision =
  | {
      action: "SELL";
      side: MarketSide;
      price: number;
      targetPrice: number;
      profitPct: number;
      reason: string;
    }
  | {
      action: "HOLD";
      reason: string;
    };

export type SplitPositionView = {
  side: MarketSide;
  entryPrice: number;
  shares: number;
};

export const defaultSplitOrderConfig: SplitOrderConfig = {
  initialBalance: 100,
  stakePerSide: 1,
  takeProfitPct: 0.25,
  minSecondsBeforeClose: 5,
  maxSecondsBeforeClose: 300,
  feeRate: 0.0072,
  slippageRate: 0.002,
};

export class SplitOrderStrategy {
  constructor(private readonly config: SplitOrderConfig) {}

  decideEntry(snapshot: MarketSnapshot, hasOpenMarket: boolean): SplitEntryDecision {
    if (hasOpenMarket) {
      return { action: "HOLD", reason: "split position already open" };
    }

    if (snapshot.secondsToClose < this.config.minSecondsBeforeClose) {
      return { action: "SKIP", reason: "too close to settlement" };
    }

    if (snapshot.secondsToClose > this.config.maxSecondsBeforeClose) {
      return { action: "SKIP", reason: "too early for configured entry window" };
    }

    if (!this.isTradablePrice(snapshot.upPrice) || !this.isTradablePrice(snapshot.downPrice)) {
      return { action: "SKIP", reason: "missing tradable UP/DOWN prices" };
    }

    if (!this.hasTakeProfitRoom(snapshot.upPrice) || !this.hasTakeProfitRoom(snapshot.downPrice)) {
      return { action: "SKIP", reason: "one side is too expensive to reach the configured take profit" };
    }

    return {
      action: "BUY_BOTH",
      legs: [
        { side: "UP", price: snapshot.upPrice },
        { side: "DOWN", price: snapshot.downPrice },
      ],
      reason: "split entry window active",
    };
  }

  decideExit(snapshot: MarketSnapshot, position: SplitPositionView): SplitExitDecision {
    const currentPrice = position.side === "UP" ? snapshot.upPrice : snapshot.downPrice;
    const targetPrice = position.entryPrice * (1 + this.config.takeProfitPct);

    if (!this.isTradablePrice(currentPrice)) {
      return { action: "HOLD", reason: `${position.side} has no tradable sell price` };
    }

    if (currentPrice < targetPrice) {
      return {
        action: "HOLD",
        reason: `${position.side} profit target not reached ${currentPrice.toFixed(3)}/${targetPrice.toFixed(3)}`,
      };
    }

    return {
      action: "SELL",
      side: position.side,
      price: currentPrice,
      targetPrice,
      profitPct: (currentPrice - position.entryPrice) / position.entryPrice,
      reason: `${position.side} reached ${(this.config.takeProfitPct * 100).toFixed(1)}% take profit`,
    };
  }

  private isTradablePrice(price: number): boolean {
    return Number.isFinite(price) && price > 0 && price < 1;
  }

  private hasTakeProfitRoom(price: number): boolean {
    return price * (1 + this.config.takeProfitPct) < 1;
  }
}
