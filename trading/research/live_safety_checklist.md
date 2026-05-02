# BTC 5m Live Safety Checklist

Status: Codex draft, pending Antigravity review.

Purpose: define live-trading blockers before any real-money BTC 5 minute deployment.

## Hard Blockers

Do not enable live trading until all are true:

- dataset schema is confirmed
- backtest includes spread, slippage, no-fill behavior, and stale data
- model beats market-implied baseline out of sample
- paper trading confirms fill assumptions
- max daily loss is configured
- manual kill switch is tested
- `.env` secrets are never passed to agents

## Required Runtime Guards

- live mode defaults to disabled
- fail closed when Binance data is stale
- fail closed when Polymarket data is stale
- fail closed when model call fails
- max single order size
- max open exposure
- max session loss
- max daily loss
- min cash reserve
- duplicate order protection by `window_id` and side
- order placement timeout
- logging for every skipped trade

## Paper Trading Requirements

Paper mode must record:

- signal timestamp
- chosen side
- model probability
- market implied probability
- intended entry price
- simulated fill status
- final resolved outcome
- expected PnL
- realized/simulated PnL
- skip reason when no trade is placed

## Manual Kill Switch

The operator must be able to stop trading without code changes.

Acceptable controls:

- environment variable such as `LIVE_TRADING_ENABLED=false`
- local kill-switch file checked before each order
- process shutdown procedure

## Promotion Policy

Move from paper to live-small only after:

- at least two non-overlapping market periods are reviewed
- no unresolved data freshness issue remains
- no unresolved order placement issue remains
- Codex review finds no critical safety issue
- operator explicitly accepts max loss limits

ANTIGRAVITY_STATUS:
- completed: Codex drafted live safety checklist.
- blocked: Needs operator-defined capital, daily loss, and exposure limits.
- recommended_next_codex_task: Add kill-switch file support if live code does not already have it.
