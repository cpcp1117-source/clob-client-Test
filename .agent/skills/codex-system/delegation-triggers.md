# Delegation Triggers

Use these triggers in Antigravity Agent Panel to call Codex CLI.

## Strategy Research Review

Trigger when Antigravity creates or updates any file under `trading/research/`.

Command:

```powershell
powershell -ExecutionPolicy Bypass -File .agent/skills/codex-system/scripts/ask_codex.ps1 -Task "Review the latest trading/research outputs for reproducibility, data leakage, overfitting, missing execution assumptions, and concrete implementation tickets." -ContextFiles "docs/DESIGN.md","trading/docs/antigravity-strategy-handoff.md","trading/docs/antigravity-assignment.md"
```

## Implementation Request

Trigger when a research output contains `recommended_next_codex_task`.

Command:

```powershell
powershell -ExecutionPolicy Bypass -File .agent/skills/codex-system/scripts/ask_codex.ps1 -Task "Implement the recommended_next_codex_task from Antigravity. Keep the patch scoped, preserve live-trading safety gates, and run npm run check:types." -ContextFiles "docs/DESIGN.md","trading/docs/antigravity-strategy-handoff.md"
```

## Failing Test Or Type Check

Trigger when `npm run check:types` or any strategy test fails.

Command:

```powershell
powershell -ExecutionPolicy Bypass -File .agent/skills/codex-system/scripts/ask_codex.ps1 -Task "Diagnose and fix the failing BTC strategy verification. Explain root cause and run the narrowest passing verification." -ContextFiles "docs/DESIGN.md","trading/docs/antigravity-strategy-handoff.md"
```

## Live Safety Gate

Trigger before enabling live trading or increasing capital.

Command:

```powershell
powershell -ExecutionPolicy Bypass -File .agent/skills/codex-system/scripts/ask_codex.ps1 -Task "Perform a live-trading safety review. Identify blockers before enabling real-money BTC 5m trading, with special attention to max loss, stale data, no-fill behavior, and kill-switch controls." -ContextFiles "docs/DESIGN.md","trading/docs/antigravity-strategy-handoff.md","trading/strategy/btc-trading-live.ts","trading/strategy/btc-edge-signal.ts"
```
