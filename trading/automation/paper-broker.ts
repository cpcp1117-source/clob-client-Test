import type { StrategyConfig } from "./config.ts";
import type { BacktestReport, MarketSnapshot, PaperPosition, TradeRecord } from "./types.ts";

export class PaperBroker {
  private balance: number;
  private position: PaperPosition | null = null;
  private trades: TradeRecord[] = [];
  private peakEquity: number;
  private maxDrawdownPct = 0;

  constructor(private readonly config: StrategyConfig) {
    this.balance = config.initialBalance;
    this.peakEquity = config.initialBalance;
  }

  hasOpenPosition(): boolean {
    return this.position !== null;
  }

  getOpenPosition(): PaperPosition | null {
    return this.position ? { ...this.position } : null;
  }

  getCashBalance(): number {
    return this.balance;
  }

  buy(snapshot: MarketSnapshot, side: "UP" | "DOWN", price: number): PaperPosition | null {
    if (this.position) return null;

    const desiredStake = Math.max(this.balance * this.config.stakeBalanceRatio, this.config.minStake);
    const stake = Math.min(desiredStake, this.config.maxStake, this.balance);
    if (stake < this.config.minStake || price <= 0 || price >= 1) return null;

    const executionPrice = this.buyExecutionPrice(price);
    if (executionPrice <= 0 || executionPrice >= 1) return null;

    const entryFee = stake * this.config.feeRate;
    const netStake = stake - entryFee;
    const shares = netStake / executionPrice;

    this.balance -= stake;
    this.position = {
      marketId: snapshot.marketId,
      side,
      entryPrice: executionPrice,
      signalEntryPrice: price,
      entryFee,
      stake,
      shares,
      openedAt: snapshot.timestamp,
    };
    this.updateDrawdown();

    return this.position;
  }

  mark(snapshot: MarketSnapshot): void {
    if (!this.position || this.position.marketId !== snapshot.marketId) return;

    const currentPrice = this.position.side === "UP" ? snapshot.upPrice : snapshot.downPrice;
    const lossPct = (this.position.entryPrice - currentPrice) / this.position.entryPrice;

    if (lossPct >= this.config.stopLossPct) {
      this.close(snapshot, this.sellExecutionPrice(currentPrice), "STOP_LOSS");
    }
  }

  settleMarket(marketId: string, closedAt: string, winningSide: "UP" | "DOWN"): void {
    if (!this.position || this.position.marketId !== marketId) return;

    const exitPrice = this.position.side === winningSide ? 1 : 0;
    this.close({ marketId, timestamp: closedAt, secondsToClose: 0, upPrice: exitPrice, downPrice: 1 - exitPrice }, exitPrice, this.position.side === winningSide ? "WIN" : "LOSS");
  }

  report(): BacktestReport {
    const finalBalance = this.balance;
    const pnl = finalBalance - this.config.initialBalance;
    const wins = this.trades.filter((trade) => trade.result === "WIN").length;
    const stopLosses = this.trades.filter((trade) => trade.result === "STOP_LOSS").length;
    const losses = this.trades.length - wins - stopLosses;

    return {
      initialBalance: this.config.initialBalance,
      finalBalance,
      pnl,
      roiPct: (pnl / this.config.initialBalance) * 100,
      tradeCount: this.trades.length,
      wins,
      losses,
      stopLosses,
      winRatePct: this.trades.length > 0 ? (wins / this.trades.length) * 100 : 0,
      maxDrawdownPct: this.maxDrawdownPct,
      trades: [...this.trades],
    };
  }

  private close(snapshot: MarketSnapshot, exitPrice: number, result: "WIN" | "LOSS" | "STOP_LOSS"): void {
    if (!this.position) return;

    const grossPayout = this.position.shares * exitPrice;
    const exitFee = result === "STOP_LOSS" ? grossPayout * this.config.feeRate : 0;
    const payout = grossPayout - exitFee;
    this.balance += payout;
    const pnl = payout - this.position.stake;

    this.trades.push({
      marketId: this.position.marketId,
      side: this.position.side,
      entryPrice: this.position.entryPrice,
      signalEntryPrice: this.position.signalEntryPrice,
      exitPrice,
      exitFee,
      stake: this.position.stake,
      shares: this.position.shares,
      result,
      pnl,
      balanceAfter: this.balance,
      openedAt: this.position.openedAt,
      closedAt: snapshot.timestamp,
    });

    this.position = null;
    this.updateDrawdown();
  }

  private updateDrawdown(): void {
    this.peakEquity = Math.max(this.peakEquity, this.balance);
    const drawdownPct = this.peakEquity > 0 ? ((this.peakEquity - this.balance) / this.peakEquity) * 100 : 0;
    this.maxDrawdownPct = Math.max(this.maxDrawdownPct, drawdownPct);
  }

  private buyExecutionPrice(price: number): number {
    return Math.min(price * (1 + this.config.slippageRate), 0.999);
  }

  private sellExecutionPrice(price: number): number {
    return Math.max(price * (1 - this.config.slippageRate), 0.001);
  }
}
