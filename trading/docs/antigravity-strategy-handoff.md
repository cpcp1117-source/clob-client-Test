# BTC 5m Strategy Handoff

Purpose: give Codex, Antigravity, and the operator one shared checklist for tuning the BTC 5 minute Polymarket strategy.

Primary strategy specification: `trading/docs/btc-5m-strategy-spec.md`.

## Multi-Agent Operating Model

Use this file as the shared contract between agents.

### Orchestra CLI Wiring

Antigravity can delegate focused work to Codex CLI with:

```powershell
npm run orchestra:codex -- -Task "Review the latest trading/research outputs for overfitting and data leakage." -ContextFiles "docs/DESIGN.md","trading/docs/antigravity-strategy-handoff.md"
```

The underlying script is `.agent/skills/codex-system/scripts/ask_codex.ps1`.

- Antigravity-facing skill: `.agent/skills/codex-system/SKILL.md`
- Codex-facing skill: `.codex/skills/orchestra-btc-strategy/SKILL.md`
- Trigger examples: `.agent/skills/codex-system/delegation-triggers.md`
- Shared design notes: `docs/DESIGN.md`
- Strategy spec: `trading/docs/btc-5m-strategy-spec.md`

The script refuses to pass `.env` or secret-like context files.

### Codex Responsibilities

- Own production code changes in `trading/strategy`.
- Keep live-trading safety gates conservative by default.
- Convert Antigravity research output into typed strategy modules.
- Run `npm run check:types` before handing changes back.
- Never promote simulator-only assumptions into live trading without explicit evidence.

### Antigravity Responsibilities

- Own research, data collection design, backtesting, and parameter sweeps.
- Challenge strategy assumptions instead of optimizing for headline win rate.
- Produce reproducible outputs in Markdown/CSV/JSON under `trading/research/`.
- Flag any parameter set that improves return by increasing tail risk.
- Recommend code changes as small tickets, not broad rewrites.

### Operator Responsibilities

- Decide maximum live capital, max daily loss, and whether live mode is enabled.
- Keep `.env` secrets private.
- Review Antigravity's recommended parameter set before live use.

## Antigravity Work Queue

### AG-001 Historical Data Collector

Goal: collect enough Polymarket and Binance data to test whether the external BTC model has predictive edge.

Inputs:
- `trading/strategy/btc-edge-signal.ts`
- `trading/strategy/btc-trading-simulator.ts`
- Binance `BTCUSDT` 5m candles
- Polymarket BTC 5m UP/DOWN prices and final outcomes

Deliverables:
- `trading/research/btc_5m_dataset_schema.md`
- `trading/research/sample_btc_5m_dataset.csv`
- A short note listing missing fields or API blockers.

Acceptance:
- Each row should include timestamp/window, Binance open/current/close, Polymarket UP/DOWN prices, chosen side, edge, and resolved result.
- Data format must be stable enough for Codex to write a backtester against it.

### AG-002 Backtest Harness Design

Goal: specify a deterministic backtest that does not depend on live WebSocket timing.

Deliverables:
- `trading/research/backtest_spec.md`
- Suggested CLI shape, for example `npm run backtest:btc -- --input ... --params ...`
- Metrics list: net PnL, max drawdown, Sharpe-like ratio, win rate, skipped rounds, average edge, loss clustering, largest loss streak.

Acceptance:
- Must separate signal generation from execution simulation.
- Must include slippage, spread, fee estimate, and no-fill assumptions.

### AG-003 Parameter Sweep

Goal: test conservative ranges without curve-fitting.

Suggested ranges:
- `MIN_MODEL_EDGE`: `0.02, 0.03, 0.04, 0.05, 0.07`
- `MAX_ENTRY_PRICE`: `0.90, 0.92, 0.94, 0.96`
- `HIGH_PROB_THRESHOLD`: `0.84, 0.86, 0.88, 0.90`
- `FINAL_PROB_THRESHOLD`: `0.88, 0.90, 0.92, 0.94`
- `STOP_LOSS_THRESHOLD`: `0.06, 0.08, 0.10, 0.12`
- `STANDARD_RATIO`: `0.02, 0.03, 0.05`
- `DEFENSIVE_RATIO`: `0.01, 0.02, 0.03`

Deliverables:
- `trading/research/parameter_sweep_results.csv`
- `trading/research/parameter_sweep_summary.md`

Acceptance:
- Top recommendations must survive at least two non-overlapping time periods.
- Reject any set where one trade contributes more than 30% of total profit.

### AG-004 Model Critique

Goal: find weaknesses in `btc-edge-signal.ts`.

Questions:
- Does the normal approximation overstate confidence in high-volatility periods?
- Does momentum improve or degrade results?
- Should probability be calibrated using empirical bins?
- Is Binance current ticker close enough to the Polymarket resolution source?
- Does market price already contain the same information, making edge illusory?

Deliverable:
- `trading/research/model_critique.md`

Acceptance:
- Must include at least three concrete recommended changes, ranked by expected impact.

### AG-005 Live Safety Checklist

Goal: define conditions before enabling real money.

Deliverable:
- `trading/research/live_safety_checklist.md`

Acceptance:
- Include max daily loss, max open exposure, minimum sample size, stale-data behavior, API outage behavior, and manual kill-switch procedure.

## What Changed

- Live trading no longer buys automatically in the final seconds.
- Entry is blocked unless price passes all risk filters:
  - minimum probability threshold
  - maximum entry price
  - minimum potential net return
  - minimum usable cash after reserve
  - per-order max size
  - session loss limit
- Simulator uses the same tunable environment variables as live trading.
- Added npm scripts:
  - `npm run simulate:btc`
  - `npm run trade:btc`
  - `npm run check:types`

## Tunable Variables

Put these in `.env` when testing. Defaults are conservative.

```env
SIM_INITIAL_BALANCE=50
STANDARD_RATIO=0.05
DEFENSIVE_RATIO=0.03
MAX_BET_AMOUNT=5
MIN_CASH_RESERVE=2
MAX_SESSION_LOSS_RATIO=0.15

HIGH_PROB_THRESHOLD=0.88
FINAL_PROB_THRESHOLD=0.90
REBUY_PROB_THRESHOLD=0.90
CONSECUTIVE_HITS=6
MAX_ENTRY_PRICE=0.96
MIN_NET_RETURN_RATIO=0.04
MIN_MODEL_EDGE=0.03
USE_EXTERNAL_SIGNAL=true
EXTERNAL_SIGNAL_FAIL_OPEN=false
EXTERNAL_SIGNAL_LOOKBACK=120
EXTERNAL_SIGNAL_CACHE_MS=2000
EXTERNAL_SIGNAL_TIMEOUT_MS=2500
EXTERNAL_SIGNAL_MOMENTUM_WEIGHT=0.12
BINANCE_API_URL=https://api.binance.com
BINANCE_SYMBOL=BTCUSDT

STOP_LOSS_THRESHOLD=0.10
STOP_LOSS_CONFIRM_COUNT=4
MIN_REBUY_PROB=0.90
```

## Implemented External Signal

`trading/strategy/btc-edge-signal.ts` estimates fair UP/DOWN probability from Binance `BTCUSDT` 5 minute candles:

- Uses the current 5 minute candle open and current BTC price.
- Estimates recent 5 minute volatility from historical completed candles.
- Converts distance from candle open into a probability of closing above/below open.
- Adds a small momentum adjustment.
- Allows a trade only when model probability exceeds Polymarket's implied price by `MIN_MODEL_EDGE`.

This is still a lightweight model, not a guarantee. Treat it as a first filter that prevents blind chasing.

## Antigravity Tasks

1. Run parameter sweeps on simulator-only mode first.
2. Compare profit, max drawdown, average profit per trade, skipped rounds, and loss clustering.
3. Reject parameter sets that rely on one or two lucky high-impact rounds.
4. Only promote a parameter set to live after at least several full sessions across different market conditions.
5. Upgrade the external model with collected historical Polymarket + Binance data before increasing size.

## Important Caveat

This is not true arbitrage yet. It is still a directional prediction strategy using Polymarket prices as the signal. For a real edge, the next major upgrade should compare Polymarket prices against an independent BTC/Binance candle model and only trade when model probability exceeds market-implied probability after spread, fees, and slippage.
