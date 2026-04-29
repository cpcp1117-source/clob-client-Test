import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStrategyConfig } from "./config.ts";
import { PaperBroker } from "./paper-broker.ts";
import { StrategyEngine } from "./strategy-engine.ts";
import type { StrategyConfig } from "./config.ts";
import type { BacktestReport, MarketSnapshot } from "./types.ts";

export type BacktestInput = {
  snapshots: MarketSnapshot[];
  settlements: Record<string, "UP" | "DOWN">;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function loadBacktestInput(inputPath = resolve(rootDir, "data/backtest-sample.json")): Promise<BacktestInput> {
  return JSON.parse(await readFile(inputPath, "utf8")) as BacktestInput;
}

export function runBacktestInput(input: BacktestInput, config: StrategyConfig = defaultStrategyConfig): BacktestReport {
  const strategy = new StrategyEngine(config);
  const broker = new PaperBroker(config);
  let activeMarket: string | null = null;

  for (const snapshot of input.snapshots) {
    if (activeMarket && activeMarket !== snapshot.marketId) {
      const winner = input.settlements[activeMarket];
      if (winner) broker.settleMarket(activeMarket, snapshot.timestamp, winner);
    }
    activeMarket = snapshot.marketId;

    broker.mark(snapshot);
    const decision = strategy.decide(snapshot, broker.hasOpenPosition());
    if (decision.action === "BUY") {
      broker.buy(snapshot, decision.side, decision.price);
    }
  }

  if (activeMarket) {
    const lastTimestamp = input.snapshots.at(-1)?.timestamp ?? new Date().toISOString();
    const winner = input.settlements[activeMarket];
    if (winner) broker.settleMarket(activeMarket, lastTimestamp, winner);
  }

  return broker.report();
}

export async function runBacktest(inputPath = resolve(rootDir, "data/backtest-sample.json"), config: StrategyConfig = defaultStrategyConfig): Promise<BacktestReport> {
  const input = JSON.parse(await readFile(inputPath, "utf8")) as BacktestInput;
  return runBacktestInput(input, config);
}

export function formatReport(report: BacktestReport): string {
  const lines = [
    "# Backtest Report",
    "",
    `Initial balance: $${report.initialBalance.toFixed(2)}`,
    `Final balance: $${report.finalBalance.toFixed(2)}`,
    `PnL: $${report.pnl.toFixed(2)}`,
    `ROI: ${report.roiPct.toFixed(2)}%`,
    `Trades: ${report.tradeCount}`,
    `Wins: ${report.wins}`,
    `Losses: ${report.losses}`,
    `Stop losses: ${report.stopLosses}`,
    `Win rate: ${report.winRatePct.toFixed(2)}%`,
    `Max drawdown: ${report.maxDrawdownPct.toFixed(2)}%`,
    "",
    "| Market | Side | Entry | Exit | Stake | Result | PnL | Balance |",
    "|---|---|---:|---:|---:|---|---:|---:|",
    ...report.trades.map((trade) =>
      `| ${trade.marketId} | ${trade.side} | ${trade.entryPrice.toFixed(3)} | ${trade.exitPrice.toFixed(3)} | $${trade.stake.toFixed(2)} | ${trade.result} | $${trade.pnl.toFixed(2)} | $${trade.balanceAfter.toFixed(2)} |`
    ),
    "",
  ];

  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const report = await runBacktest(inputPath);
  const output = formatReport(report);
  const reportPath = resolve(rootDir, "reports", `backtest-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, output);

  console.log(output);
  console.log(`Report written to ${reportPath}`);
}
