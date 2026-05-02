import type { SplitOrderConfig } from "./split-order-strategy.ts";
import type { MarketSide, MarketSnapshot } from "./types.ts";

export type SplitLegStatus = "OPEN" | "TAKE_PROFIT" | "WIN" | "LOSS";

export type SplitLeg = {
  marketId: string;
  side: MarketSide;
  entryPrice: number;
  signalEntryPrice: number;
  entryFee: number;
  stake: number;
  shares: number;
  openedAt: string;
  closedAt?: string;
  exitPrice?: number;
  exitFee?: number;
  pnl?: number;
  status: SplitLegStatus;
};

export type SplitRound = {
  marketId: string;
  openedAt: string;
  legs: SplitLeg[];
};

export type SplitOrderReport = {
  initialBalance: number;
  finalBalance: number;
  pnl: number;
  roiPct: number;
  rounds: number;
  closedLegs: number;
  takeProfits: number;
  wins: number;
  losses: number;
  openLegs: number;
  legs: SplitLeg[];
};

export class SplitPaperBroker {
  private balance: number;
  private activeRound: SplitRound | null = null;
  private closedLegs: SplitLeg[] = [];

  constructor(private readonly config: SplitOrderConfig) {
    this.balance = config.initialBalance;
  }

  getCashBalance(): number {
    return this.balance;
  }

  hasOpenMarket(): boolean {
    return this.activeRound !== null;
  }

  getOpenLegs(): SplitLeg[] {
    return this.activeRound?.legs.filter((leg) => leg.status === "OPEN").map((leg) => ({ ...leg })) ?? [];
  }

  buyBoth(snapshot: MarketSnapshot, prices: { up: number; down: number }): SplitRound | null {
    if (this.activeRound) return null;

    const totalStake = this.config.stakePerSide * 2;
    if (this.balance < totalStake) return null;

    const legs = [
      this.buildLeg(snapshot, "UP", prices.up),
      this.buildLeg(snapshot, "DOWN", prices.down),
    ];

    if (legs.some((leg) => !leg)) return null;

    this.balance -= totalStake;
    this.activeRound = {
      marketId: snapshot.marketId,
      openedAt: snapshot.timestamp,
      legs: legs as SplitLeg[],
    };
    return {
      marketId: this.activeRound.marketId,
      openedAt: this.activeRound.openedAt,
      legs: this.activeRound.legs.map((leg) => ({ ...leg })),
    };
  }

  sell(snapshot: MarketSnapshot, side: MarketSide, price: number): SplitLeg | null {
    const leg = this.activeRound?.legs.find((candidate) => candidate.side === side && candidate.status === "OPEN");
    if (!leg) return null;
    if (leg.marketId !== snapshot.marketId) return null;

    this.closeLeg(leg, snapshot.timestamp, this.sellExecutionPrice(price), "TAKE_PROFIT");
    this.closeRoundIfComplete();
    return { ...leg };
  }

  settleMarket(marketId: string, closedAt: string, winningSide: MarketSide): void {
    if (!this.activeRound || this.activeRound.marketId !== marketId) return;

    for (const leg of this.activeRound.legs) {
      if (leg.status !== "OPEN") continue;
      this.closeLeg(leg, closedAt, leg.side === winningSide ? 1 : 0, leg.side === winningSide ? "WIN" : "LOSS");
    }
    this.closeRoundIfComplete();
  }

  report(): SplitOrderReport {
    const openLegs = this.getOpenLegs();
    const legs = [...this.closedLegs, ...openLegs];
    const pnl = this.balance - this.config.initialBalance;
    const takeProfits = legs.filter((leg) => leg.status === "TAKE_PROFIT").length;
    const wins = legs.filter((leg) => leg.status === "WIN").length;
    const losses = legs.filter((leg) => leg.status === "LOSS").length;
    const roundIds = new Set(legs.map((leg) => leg.marketId));

    return {
      initialBalance: this.config.initialBalance,
      finalBalance: this.balance,
      pnl,
      roiPct: (pnl / this.config.initialBalance) * 100,
      rounds: roundIds.size,
      closedLegs: this.closedLegs.length,
      takeProfits,
      wins,
      losses,
      openLegs: openLegs.length,
      legs,
    };
  }

  private buildLeg(snapshot: MarketSnapshot, side: MarketSide, price: number): SplitLeg | null {
    if (price <= 0 || price >= 1) return null;

    const entryPrice = this.buyExecutionPrice(price);
    const entryFee = this.config.stakePerSide * this.config.feeRate;
    const netStake = this.config.stakePerSide - entryFee;
    const shares = netStake / entryPrice;

    return {
      marketId: snapshot.marketId,
      side,
      entryPrice,
      signalEntryPrice: price,
      entryFee,
      stake: this.config.stakePerSide,
      shares,
      openedAt: snapshot.timestamp,
      status: "OPEN",
    };
  }

  private closeLeg(leg: SplitLeg, closedAt: string, exitPrice: number, status: Exclude<SplitLegStatus, "OPEN">): void {
    const grossPayout = leg.shares * exitPrice;
    const exitFee = status === "TAKE_PROFIT" ? grossPayout * this.config.feeRate : 0;
    const payout = grossPayout - exitFee;

    this.balance += payout;
    leg.closedAt = closedAt;
    leg.exitPrice = exitPrice;
    leg.exitFee = exitFee;
    leg.pnl = payout - leg.stake;
    leg.status = status;
    this.closedLegs.push({ ...leg });
  }

  private closeRoundIfComplete(): void {
    if (!this.activeRound?.legs.some((leg) => leg.status === "OPEN")) {
      this.activeRound = null;
    }
  }

  private buyExecutionPrice(price: number): number {
    return Math.min(price * (1 + this.config.slippageRate), 0.999);
  }

  private sellExecutionPrice(price: number): number {
    return Math.max(price * (1 - this.config.slippageRate), 0.001);
  }
}
