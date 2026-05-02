# Design Notes

This repository uses an Orchestra workflow for the BTC 5 minute strategy.

## Agent Roles

Antigravity is the coordinating research agent:

- writes research and parameter proposals under `trading/research/`
- updates this design file when assumptions change
- delegates implementation or review tasks to Codex through `.agent/skills/codex-system/scripts/ask_codex.ps1`

Codex is the implementation and review specialist:

- owns scoped changes under `trading/strategy/`
- reviews Antigravity outputs for reproducibility and trading risk
- runs TypeScript verification before handing changes back

## Safety Position

The BTC 5 minute strategy is not treated as guaranteed arbitrage. Every proposed edge must survive:

- out-of-sample backtesting
- slippage and spread assumptions
- no-fill assumptions
- drawdown and loss-clustering checks
- stale data and API outage behavior

## Current Strategy Direction

The current direction is to compare Polymarket prices with an independent BTC candle probability model. A trade should only pass when the model-implied probability exceeds the market-implied price after safety margins.

## Shared Files

- `trading/docs/antigravity-strategy-handoff.md`
- `trading/docs/btc-5m-strategy-spec.md`
- `trading/docs/antigravity-assignment.md`
- `.agent/skills/codex-system/delegation-triggers.md`
- `.codex/skills/orchestra-btc-strategy/SKILL.md`
