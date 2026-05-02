# Codex System Delegation

This Antigravity-facing skill delegates focused engineering or review tasks to Codex CLI.

## When To Use

Use this skill when a task needs:

- implementation review
- TypeScript strategy changes
- backtest harness design review
- root-cause analysis for failing tests
- safety review before live trading

## Command

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .agent/skills/codex-system/scripts/ask_codex.ps1 -Task "Review the BTC backtest spec and identify data leakage risks."
```

Optional context files:

```powershell
powershell -ExecutionPolicy Bypass -File .agent/skills/codex-system/scripts/ask_codex.ps1 -Task "Implement a deterministic BTC backtest CLI." -ContextFiles "trading/docs/antigravity-strategy-handoff.md","trading/research/backtest_spec.md"
```

Validate the wiring without invoking Codex:

```powershell
powershell -ExecutionPolicy Bypass -File .agent/skills/codex-system/scripts/ask_codex.ps1 -Task "Smoke test" -ContextFiles "docs/DESIGN.md" -DryRun
```

## Contract

- Do not pass `.env` or secret files.
- Ask Codex for one bounded task at a time.
- Put research artifacts under `trading/research/`.
- Put production strategy changes under `trading/strategy/`.
- Review Codex output before applying live-trading parameters.
