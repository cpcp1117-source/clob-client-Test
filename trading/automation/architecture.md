# Polymarket Automation Architecture

## Flow

1. Specification
   - Strategy assumptions live in `trading/automation/spec.md`.
   - Runtime parameters are stored in `config.ts`.

2. Strategy Engine
   - `strategy-engine.ts` is pure logic.
   - It receives market snapshots and returns decisions.
   - It does not call Polymarket APIs and cannot place live orders.

3. Paper Broker
   - `paper-broker.ts` simulates fills, positions, stop loss, and settlement.
   - It tracks balance, equity, trade history, and drawdown.

4. Backtest Runner
   - `backtest.ts` loads historical/sample snapshots.
   - It runs the strategy over time and writes a report to `reports/`.

5. Functional Tests
   - `tests/automation.test.ts` validates entry, skip, stop loss, settlement, and report math.

## Live Trading Boundary

Live trading should be added only as a future adapter:

```text
Market data -> StrategyEngine -> RiskGate -> LiveBrokerAdapter
```

The current implementation stops at `PaperBroker`.

