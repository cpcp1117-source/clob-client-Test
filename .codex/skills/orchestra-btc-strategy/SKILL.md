# Orchestra BTC Strategy

Use this skill when Codex is delegated a BTC 5 minute strategy task by Antigravity.

## Role

Codex is the implementation and review specialist.

- Keep live trading defaults conservative.
- Treat Antigravity research as proposals until reproduced.
- Prefer deterministic backtests before live-trading changes.
- Do not read or print `.env`.
- Do not claim stable profit. Report expected value, drawdown, sample size, and failure modes.

## Shared Context

Read these files first:

- `docs/DESIGN.md`
- `trading/docs/antigravity-strategy-handoff.md`
- `trading/docs/antigravity-assignment.md`
- `trading/strategy/btc-edge-signal.ts`
- `trading/strategy/btc-trading-simulator.ts`
- `trading/strategy/btc-trading-live.ts`

## Delegated Task Output

When implementing code, keep changes scoped and run:

```powershell
npm run check:types
```

When reviewing Antigravity output, lead with risks and cite files. Focus on:

- lookahead bias
- data leakage
- slippage and no-fill assumptions
- overfitting parameter sweeps
- market/API source mismatch
- missing kill-switch behavior

## Completion Format

End with:

```text
CODEX_ORCHESTRA_STATUS:
- completed:
- changed_files:
- verification:
- risks:
- next_antigravity_task:
```
