# BTC 5m Model Candidate Plan

Status: Codex draft, pending Antigravity review.

Purpose: define the first model candidates Antigravity should evaluate before Codex implements a production strategy module.

## Candidate A: Baseline Normal Model

Source: current `trading/strategy/btc-edge-signal.ts`.

Features:

- distance from current 5 minute candle open
- recent completed-candle volatility
- short momentum adjustment

Evaluation:

- Brier score
- calibration by probability bucket
- PnL after costs
- performance by volatility regime

Primary concern: normal approximation may be overconfident during fast markets.

## Candidate B: Empirical Bin Calibration

Features:

- seconds to close bucket
- distance from open bucket
- realized volatility bucket
- momentum bucket

Method:

- train empirical close-above/open probability by bucket
- require minimum sample size
- fallback to broader bucket when sample is too small

Evaluation:

- compare calibration curve against baseline normal model
- check out-of-sample stability by date range
- measure skipped trades due to insufficient sample size

Primary concern: sparse buckets and overfitting.

## Candidate C: Market-Aware Residual Model

Features:

- Polymarket implied probability
- external model probability
- spread
- seconds to close
- volatility regime

Method:

- treat market price as baseline
- trade only when historical residual edge is positive after costs

Evaluation:

- does the external model improve on market-implied probability?
- does edge survive after spread/slippage/no-fill?
- does edge disappear near close?

Primary concern: Polymarket may already price the same Binance movement.

## Required Antigravity Outputs

- recommended model candidate
- rejected candidates with reasons
- calibration plot or table
- out-of-sample metrics
- implementation ticket for Codex

ANTIGRAVITY_STATUS:
- completed: Codex drafted model candidate plan.
- blocked: Needs historical data to rank candidates.
- recommended_next_codex_task: None until Antigravity produces evaluation results.
