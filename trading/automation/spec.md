# Polymarket Automation Spec

## Objective

Build an automated Polymarket strategy workflow that can move from strategy definition to architecture, implementation, functional tests, and backtests without enabling live trading by default.

This project treats all strategy output as research and simulation until a separate live-trading adapter is explicitly wired and reviewed.

## Default Strategy

Initial target:

- Market type: binary Polymarket markets.
- Signal: follow the side with the higher probability only when it is above a configured threshold.
- Confirmation: require repeated confirmations before entry.
- Risk: cap stake per trade by balance percentage and absolute max order size.
- Exit: simulated stop loss if the selected side price falls by a configured percentage.
- Settlement: simulated payout is `shares * 1.00` when the selected side wins, otherwise `0`.

## Non Goals

- No automatic live order placement in this module.
- No private key handling.
- No financial advice or guaranteed-profit assumptions.
- No strategy optimization against future data.

## Safety Gates

- Backtest and simulator use in-memory paper balances.
- Live trading must be implemented through a separate adapter with an explicit environment flag.
- Tests must pass before using new strategy rules.
- Backtest report must include trade count, win rate, PnL, ROI, and max drawdown.

