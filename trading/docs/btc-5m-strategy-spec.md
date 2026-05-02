# BTC 5m Strategy Development Spec

Purpose: define the build plan for a BTC 5 minute Polymarket strategy that can be researched, backtested, reviewed, and only then considered for small live deployment.

This strategy must not be described as guaranteed arbitrage. The working goal is to find a reproducible positive expected value edge after spread, slippage, fees, no-fill behavior, and loss clustering.

## Objective

Build a BTC 5 minute strategy pipeline with four stages:

1. Collect and normalize historical Polymarket + Binance data.
2. Backtest independent signal models against market prices.
3. Select conservative parameters that survive out-of-sample periods.
4. Run paper/live-small mode with strict kill switches.

## Strategy Thesis

Polymarket BTC 5 minute markets price whether BTC closes above or below the 5 minute candle open. The strategy should only trade when:

- an independent BTC model estimates a materially different probability than Polymarket implied price
- expected value remains positive after execution costs
- liquidity and spread allow realistic fill assumptions
- risk limits allow a new position

The current external signal in `trading/strategy/btc-edge-signal.ts` is a baseline model, not final alpha.

## Data Requirements

### Polymarket Data

For each 5 minute market window:

- market slug/id
- start time and end time
- UP token id and DOWN token id
- best bid/ask snapshots for both sides
- last trade price if available
- order book depth near entry price
- final resolved outcome
- timestamp of each snapshot

### Binance Data

For each matching BTCUSDT 5 minute window:

- candle open time
- open/high/low/close
- volume
- current price at candidate entry timestamps
- rolling realized volatility
- short momentum features

### Derived Fields

Each dataset row should include:

- `window_id`
- `timestamp`
- `seconds_to_close`
- `binance_open`
- `binance_current`
- `binance_close`
- `distance_from_open`
- `realized_volatility_lookback`
- `momentum_feature`
- `polymarket_up_bid`
- `polymarket_up_ask`
- `polymarket_down_bid`
- `polymarket_down_ask`
- `chosen_side`
- `model_probability`
- `market_implied_probability`
- `edge_before_costs`
- `edge_after_costs`
- `filled`
- `entry_price`
- `exit_value`
- `pnl`
- `resolved_side`

## Model Candidates

Antigravity should research and compare these models.

### Baseline Normal Model

Current implementation:

- uses distance from candle open
- estimates volatility from completed 5 minute candles
- converts distance to close-above/open probability
- applies a momentum adjustment

Risks:

- normal approximation can overstate confidence during high volatility
- momentum may double-count information already priced by Polymarket
- Binance source may differ from Polymarket resolution source

### Empirical Calibration Model

Bucket historical rows by:

- seconds to close
- distance from open
- recent realized volatility
- trend/momentum bucket

Estimate empirical probability from past outcomes. Require minimum sample size per bucket.

### Market-Aware Edge Model

Use Polymarket price as the baseline probability and only trade residual edge when external features historically improve calibration.

Required output:

- calibration curve
- Brier score
- log loss
- profit after costs
- out-of-sample performance

## Entry Rules

A trade may be considered only when all gates pass:

- market has a valid UP/DOWN pair
- time to close is within approved entry window
- order book data is fresh
- Binance data is fresh
- model probability is above side threshold
- `model_probability - market_implied_probability >= MIN_MODEL_EDGE`
- expected value after costs is positive
- entry price is below `MAX_ENTRY_PRICE`
- spread is below max spread
- open exposure is below limit
- daily/session loss is below limit

Default stance: skip when uncertain.

## Exit Rules

Primary exit is settlement at resolution.

Optional defensive exit may be researched but must be proven separately:

- stop loss when model probability deteriorates
- exit when external data becomes stale
- exit when opposite side becomes clearly mispriced

Any active exit rule must include slippage/no-fill assumptions and cannot rely on perfect fill.

## Backtest Requirements

Backtests must be deterministic and data-driven.

Required metrics:

- net PnL
- gross PnL
- max drawdown
- average trade PnL
- median trade PnL
- win rate
- expected value per trade
- skipped markets
- filled vs no-fill count
- largest loss
- largest win
- longest loss streak
- profit concentration
- out-of-sample performance
- performance by volatility regime
- performance by seconds-to-close bucket

Required anti-overfitting checks:

- train/test split by time, not random rows
- at least two non-overlapping out-of-sample periods
- reject parameter sets where one trade contributes more than 30% of total profit
- reject parameter sets with unacceptable drawdown even if net PnL is positive

## Parameter Search

Initial conservative sweep:

- `MIN_MODEL_EDGE`: `0.02, 0.03, 0.04, 0.05, 0.07`
- `MAX_ENTRY_PRICE`: `0.88, 0.90, 0.92, 0.94`
- `MAX_SPREAD`: `0.02, 0.03, 0.05`
- `ENTRY_SECONDS_MIN`: `20, 30, 45`
- `ENTRY_SECONDS_MAX`: `120, 180, 240`
- `HIGH_PROB_THRESHOLD`: `0.84, 0.86, 0.88, 0.90`
- `STOP_LOSS_THRESHOLD`: `0.06, 0.08, 0.10, 0.12`
- `STANDARD_RATIO`: `0.01, 0.02, 0.03`
- `DEFENSIVE_RATIO`: `0.005, 0.01, 0.02`

The winning parameter set is the most robust set, not the highest headline return.

## Risk Management

Live mode must default to disabled until explicitly enabled.

Required controls:

- max single order size
- max open exposure
- max daily loss
- max session loss
- min cash reserve
- stale Binance data fail-closed
- stale Polymarket data fail-closed
- order placement timeout
- duplicate order protection
- manual kill switch
- paper mode before live mode

Suggested starting live-small policy after research passes:

- paper trade first
- then very small order size
- stop after first unexpected API/execution behavior
- no parameter increase until multiple sessions are reviewed

## Multi-Agent Workflow

### Antigravity Owns

- research design
- data schema
- data collection blockers
- backtest specification
- parameter sweeps
- model critique
- recommended implementation tickets

### Codex Owns

- TypeScript implementation
- strategy module refactoring
- deterministic backtest CLI
- test/typecheck verification
- reviewing Antigravity research for leakage/overfit risk

### Operator Owns

- final live enablement decision
- capital limit
- API key and wallet safety
- accepting or rejecting parameter recommendations

## Antigravity Deliverables

Create these first:

- `trading/research/btc_5m_dataset_schema.md`
- `trading/research/backtest_spec.md`
- `trading/research/model_candidate_plan.md`
- `trading/research/live_safety_checklist.md`

Then, if data access works:

- `trading/research/sample_btc_5m_dataset.csv`
- `trading/research/parameter_sweep_results.csv`
- `trading/research/parameter_sweep_summary.md`
- `trading/research/model_critique.md`

Every Antigravity report must end with:

```text
ANTIGRAVITY_STATUS:
- completed:
- blocked:
- recommended_next_codex_task:
```

## Promotion Criteria

Do not promote to live trading unless all are true:

- dataset schema is complete
- backtest harness includes costs and no-fill behavior
- model beats market-implied baseline out of sample
- drawdown is acceptable under operator-defined limits
- paper trading confirms execution assumptions
- Codex review finds no critical leakage or safety issue

## Immediate Next Task

Antigravity should start with:

1. Read this spec and `trading/docs/antigravity-strategy-handoff.md`.
2. Produce AG-001 and AG-002 deliverables.
3. Use the Orchestra script to ask Codex for review after creating the research files.
