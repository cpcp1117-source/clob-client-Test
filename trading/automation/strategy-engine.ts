import type { StrategyConfig } from "./config.ts";
import type { MarketSide, MarketSnapshot, StrategyDecision } from "./types.ts";

type ConfirmationState = {
  side: MarketSide | null;
  count: number;
  marketId: string | null;
};

export class StrategyEngine {
  private confirmation: ConfirmationState = {
    side: null,
    count: 0,
    marketId: null,
  };

  constructor(private readonly config: StrategyConfig) {}

  decide(snapshot: MarketSnapshot, hasOpenPosition: boolean): StrategyDecision {
    if (hasOpenPosition) {
      return { action: "HOLD", reason: "position already open" };
    }

    if (snapshot.secondsToClose < this.config.minSecondsBeforeClose) {
      this.reset(snapshot.marketId);
      return { action: "SKIP", reason: "too close to settlement" };
    }

    if (snapshot.secondsToClose > this.config.maxSecondsBeforeClose) {
      this.reset(snapshot.marketId);
      return { action: "SKIP", reason: "too early for configured entry window" };
    }

    const candidate = this.getCandidate(snapshot);
    if (!candidate) {
      this.reset(snapshot.marketId);
      return { action: "SKIP", reason: "no side above probability threshold" };
    }

    if (this.confirmation.marketId !== snapshot.marketId || this.confirmation.side !== candidate.side) {
      this.confirmation = {
        side: candidate.side,
        count: 1,
        marketId: snapshot.marketId,
      };
    } else {
      this.confirmation.count += 1;
    }

    if (this.confirmation.count < this.config.confirmationTicks) {
      return {
        action: "HOLD",
        reason: `waiting for confirmation ${this.confirmation.count}/${this.config.confirmationTicks}`,
      };
    }

    this.reset(snapshot.marketId);
    return {
      action: "BUY",
      side: candidate.side,
      price: candidate.price,
      reason: "threshold confirmed",
    };
  }

  private getCandidate(snapshot: MarketSnapshot): { side: MarketSide; price: number } | null {
    const side = snapshot.upPrice >= snapshot.downPrice ? "UP" : "DOWN";
    const price = side === "UP" ? snapshot.upPrice : snapshot.downPrice;
    const gap = Math.abs(snapshot.upPrice - snapshot.downPrice);

    if (price < this.config.probabilityThreshold) {
      return null;
    }

    if (price > this.config.maxEntryPrice) {
      return null;
    }

    if (gap < this.config.minPriceGap) {
      return null;
    }

    return { side, price };
  }

  private reset(marketId: string): void {
    this.confirmation = {
      side: null,
      count: 0,
      marketId,
    };
  }
}
