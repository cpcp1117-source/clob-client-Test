export type MarketSide = "UP" | "DOWN";

export type MarketSnapshot = {
  marketId: string;
  timestamp: string;
  secondsToClose: number;
  upPrice: number;
  downPrice: number;
};

export type StrategyDecision =
  | {
      action: "BUY";
      side: MarketSide;
      price: number;
      reason: string;
    }
  | {
      action: "HOLD" | "SKIP";
      reason: string;
    };

export type PaperPosition = {
  marketId: string;
  side: MarketSide;
  entryPrice: number;
  signalEntryPrice: number;
  entryFee: number;
  stake: number;
  shares: number;
  openedAt: string;
};

export type TradeResult = "WIN" | "LOSS" | "STOP_LOSS";

export type TradeRecord = {
  marketId: string;
  side: MarketSide;
  entryPrice: number;
  signalEntryPrice: number;
  exitPrice: number;
  exitFee: number;
  stake: number;
  shares: number;
  result: TradeResult;
  pnl: number;
  balanceAfter: number;
  openedAt: string;
  closedAt: string;
};

export type BacktestReport = {
  initialBalance: number;
  finalBalance: number;
  pnl: number;
  roiPct: number;
  tradeCount: number;
  wins: number;
  losses: number;
  stopLosses: number;
  winRatePct: number;
  maxDrawdownPct: number;
  trades: TradeRecord[];
};
