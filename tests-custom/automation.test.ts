import test from "node:test";
import assert from "node:assert/strict";
import { defaultStrategyConfig } from "../trading/automation/config.ts";
import { PaperBroker } from "../trading/automation/paper-broker.ts";
import { StrategyEngine } from "../trading/automation/strategy-engine.ts";
import { SplitPaperBroker } from "../trading/automation/split-paper-broker.ts";
import { defaultSplitOrderConfig, SplitOrderStrategy } from "../trading/automation/split-order-strategy.ts";
import { runBacktest } from "../trading/automation/backtest.ts";
import { resolveWinner } from "../trading/automation/simulate-live-btc5m.ts";

test("strategy waits for confirmation before buying", () => {
  const engine = new StrategyEngine({
    ...defaultStrategyConfig,
    probabilityThreshold: 0.85,
    confirmationTicks: 3,
    maxEntryPrice: 0.95,
  });
  const snapshot = {
    marketId: "m1",
    timestamp: "2026-01-01T00:00:00.000Z",
    secondsToClose: 60,
    upPrice: 0.86,
    downPrice: 0.14,
  };

  assert.equal(engine.decide(snapshot, false).action, "HOLD");
  assert.equal(engine.decide({ ...snapshot, timestamp: "2026-01-01T00:00:01.000Z" }, false).action, "HOLD");

  const decision = engine.decide({ ...snapshot, timestamp: "2026-01-01T00:00:02.000Z" }, false);
  assert.equal(decision.action, "BUY");
  if (decision.action === "BUY") {
    assert.equal(decision.side, "UP");
    assert.equal(decision.price, 0.86);
  }
});

test("paper broker stops out a losing position", () => {
  const broker = new PaperBroker(defaultStrategyConfig);
  const entry = {
    marketId: "m1",
    timestamp: "2026-01-01T00:00:00.000Z",
    secondsToClose: 60,
    upPrice: 0.86,
    downPrice: 0.14,
  };

  broker.buy(entry, "UP", 0.86);
  broker.mark({ ...entry, timestamp: "2026-01-01T00:00:10.000Z", upPrice: 0.70, downPrice: 0.30 });

  const report = broker.report();
  assert.equal(report.tradeCount, 1);
  assert.equal(report.stopLosses, 1);
  assert.equal(report.trades[0].result, "STOP_LOSS");
});

test("paper broker applies fee and slippage on paper fills", () => {
  const broker = new PaperBroker({
    ...defaultStrategyConfig,
    feeRate: 0.01,
    slippageRate: 0.01,
  });
  const entry = {
    marketId: "m1",
    timestamp: "2026-01-01T00:00:00.000Z",
    secondsToClose: 60,
    upPrice: 0.8,
    downPrice: 0.2,
  };

  const position = broker.buy(entry, "UP", 0.8);

  assert.ok(position);
  assert.equal(position.entryPrice, 0.808);
  assert.equal(position.entryFee, 0.1);
  assert.equal(position.shares < 12.5, true);
});

test("backtest produces a deterministic report", async () => {
  const report = await runBacktest();

  assert.equal(report.tradeCount, 2);
  assert.equal(report.wins, 1);
  assert.equal(report.stopLosses, 1);
  assert.equal(report.finalBalance > 90, true);
});

test("live simulator resolves settled outcome prices", () => {
  assert.equal(resolveWinner({ outcomePrices: "[\"1\", \"0\"]" }), "UP");
  assert.equal(resolveWinner({ outcomePrices: "[\"0\", \"1\"]" }), "DOWN");
  assert.equal(resolveWinner({ outcomePrices: "[\"0.5\", \"0.5\"]" }), null);
});

test("split order strategy buys both sides and takes profit independently", () => {
  const config = {
    ...defaultSplitOrderConfig,
    initialBalance: 10,
    stakePerSide: 1,
    takeProfitPct: 0.2,
    feeRate: 0,
    slippageRate: 0,
  };
  const strategy = new SplitOrderStrategy(config);
  const broker = new SplitPaperBroker(config);
  const entry = {
    marketId: "m1",
    timestamp: "2026-01-01T00:00:00.000Z",
    secondsToClose: 60,
    upPrice: 0.4,
    downPrice: 0.6,
  };

  const entryDecision = strategy.decideEntry(entry, broker.hasOpenMarket());
  assert.equal(entryDecision.action, "BUY_BOTH");
  broker.buyBoth(entry, { up: entry.upPrice, down: entry.downPrice });

  const upLeg = broker.getOpenLegs().find((leg) => leg.side === "UP");
  assert.ok(upLeg);
  const exitDecision = strategy.decideExit({ ...entry, timestamp: "2026-01-01T00:00:10.000Z", upPrice: 0.48, downPrice: 0.52 }, upLeg);

  assert.equal(exitDecision.action, "SELL");
  if (exitDecision.action === "SELL") {
    broker.sell({ ...entry, timestamp: "2026-01-01T00:00:10.000Z", upPrice: 0.48, downPrice: 0.52 }, exitDecision.side, exitDecision.price);
  }

  const report = broker.report();
  assert.equal(report.takeProfits, 1);
  assert.equal(report.openLegs, 1);
  assert.equal(report.legs.find((leg) => leg.side === "UP")?.status, "TAKE_PROFIT");
});

test("split order strategy skips entries with impossible take profit room", () => {
  const strategy = new SplitOrderStrategy({
    ...defaultSplitOrderConfig,
    takeProfitPct: 0.2,
  });
  const decision = strategy.decideEntry({
    marketId: "m1",
    timestamp: "2026-01-01T00:00:00.000Z",
    secondsToClose: 60,
    upPrice: 0.01,
    downPrice: 0.99,
  }, false);

  assert.equal(decision.action, "SKIP");
});

test("split paper broker does not sell a leg with another market price", () => {
  const config = {
    ...defaultSplitOrderConfig,
    initialBalance: 10,
    stakePerSide: 1,
    feeRate: 0,
    slippageRate: 0,
  };
  const broker = new SplitPaperBroker(config);
  const entry = {
    marketId: "m1",
    timestamp: "2026-01-01T00:00:00.000Z",
    secondsToClose: 60,
    upPrice: 0.4,
    downPrice: 0.6,
  };

  broker.buyBoth(entry, { up: entry.upPrice, down: entry.downPrice });
  const closed = broker.sell({ ...entry, marketId: "m2", timestamp: "2026-01-01T00:00:10.000Z", upPrice: 0.8 }, "UP", 0.8);

  assert.equal(closed, null);
  assert.equal(broker.report().closedLegs, 0);
});
