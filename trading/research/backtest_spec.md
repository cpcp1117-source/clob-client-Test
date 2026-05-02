# BTC 5m Backtest Spec

Status: Codex draft, pending Antigravity review.

Purpose: define a deterministic backtest harness for BTC 5 minute strategy research.

## CLI Shape

Proposed command:

```powershell
npm run backtest:btc -- --input trading/research/sample_btc_5m_dataset.csv --params trading/research/params.default.json --out trading/research/backtest_results.json
```

## Core Rules

- Backtest reads rows sorted by `timestamp`.
- Signal generation may only use pre-trade columns.
- Post-trade labels are only used after the simulated decision.
- Each `window_id` may have at most one open position unless a strategy explicitly allows scaling.
- If required data is stale or missing, the action is `SKIP`.

## Execution Model

The first implementation should support three fill modes:

1. `strict_top_of_book`: fill only if ask size is enough at `intended_entry_price`.
2. `slippage_bps`: fill with configurable slippage from best ask.
3. `no_fill_on_spread`: skip if spread exceeds `MAX_SPREAD`.

Required assumptions:

- no perfect fills
- configurable spread/slippage
- configurable stale data threshold
- configurable max order size
- no use of future order book information

## Strategy Inputs

Parameter file should include:

```json
{
  "minModelEdge": 0.03,
  "maxEntryPrice": 0.92,
  "maxSpread": 0.03,
  "entrySecondsMin": 30,
  "entrySecondsMax": 180,
  "highProbThreshold": 0.88,
  "maxOrderSize": 5,
  "maxSessionLossRatio": 0.15,
  "minCashReserve": 2,
  "fillMode": "strict_top_of_book"
}
```

## Metrics

Backtest output must include:

- net PnL
- gross PnL
- total trades
- skipped rows
- filled orders
- no-fill count
- win rate
- average trade PnL
- median trade PnL
- expected value per trade
- max drawdown
- largest win
- largest loss
- longest loss streak
- profit concentration from top 1 trade
- profit concentration from top 5 trades
- performance by time-to-close bucket
- performance by volatility regime
- train/test split summary

## Anti-Leakage Requirements

Reject a backtest implementation if:

- `binance_close` is used before decision time
- `resolved_side` is used before settlement
- rows are randomly split across time
- parameters are selected on the same period used for final reporting
- fill logic uses future prices or future liquidity

## Acceptance Criteria

The first Codex implementation is acceptable when:

- it can read the schema from `btc_5m_dataset_schema.md`
- it runs from npm script
- it produces deterministic JSON and CSV summary outputs
- it includes at least one test or fixture proving label columns are not used as features
- `npm run check:types` passes

ANTIGRAVITY_STATUS:
- completed: Codex drafted deterministic backtest specification.
- blocked: Needs Antigravity confirmation of available data fields and fill assumptions.
- recommended_next_codex_task: Add `npm run backtest:btc` after the sample dataset format is confirmed.
