export type StrategyConfig = {
  initialBalance: number;
  probabilityThreshold: number;
  confirmationTicks: number;
  stakeBalanceRatio: number;
  maxStake: number;
  minStake: number;
  stopLossPct: number;
  minSecondsBeforeClose: number;
  maxSecondsBeforeClose: number;
  maxEntryPrice: number;
  minPriceGap: number;
  feeRate: number;
  slippageRate: number;
};

export const defaultStrategyConfig: StrategyConfig = {
  initialBalance: 100,
  probabilityThreshold: 0.6,
  confirmationTicks: 1,
  stakeBalanceRatio: 0.1,
  maxStake: 10,
  minStake: 1,
  stopLossPct: 0.08,
  minSecondsBeforeClose: 5,
  maxSecondsBeforeClose: 300,
  maxEntryPrice: 0.92,
  minPriceGap: 0.4,
  feeRate: 0.0072,
  slippageRate: 0.002,
};
