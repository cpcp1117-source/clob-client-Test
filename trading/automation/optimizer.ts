import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStrategyConfig, type StrategyConfig } from "./config.ts";
import { formatReport, runBacktestInput, type BacktestInput } from "./backtest.ts";

type Candidate = {
  config: StrategyConfig;
  trainPnl: number;
  testPnl: number;
  trainRoiPct: number;
  testRoiPct: number;
  trainTrades: number;
  testTrades: number;
  testMaxDrawdownPct: number;
  score: number;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function marketIds(input: BacktestInput): string[] {
  return [...new Set(input.snapshots.map((snapshot) => snapshot.marketId))];
}

function filterInput(input: BacktestInput, ids: Set<string>): BacktestInput {
  return {
    snapshots: input.snapshots.filter((snapshot) => ids.has(snapshot.marketId)),
    settlements: Object.fromEntries(Object.entries(input.settlements).filter(([id]) => ids.has(id))),
  };
}

function splitInput(input: BacktestInput, trainRatio = 0.7): { train: BacktestInput; test: BacktestInput } {
  const ids = marketIds(input);
  const splitIndex = Math.max(1, Math.floor(ids.length * trainRatio));
  const trainIds = new Set(ids.slice(0, splitIndex));
  const testIds = new Set(ids.slice(splitIndex));

  return {
    train: filterInput(input, trainIds),
    test: filterInput(input, testIds.size > 0 ? testIds : trainIds),
  };
}

function* configGrid(): Generator<StrategyConfig> {
  const thresholds = [0.6, 0.65, 0.7, 0.75, 0.78, 0.8, 0.82, 0.85, 0.88, 0.9];
  const confirmations = [1, 2, 3];
  const stopLosses = [0.08, 0.12, 0.16, 0.2, 1.0];
  const minSeconds = [5, 10, 15, 20];
  const maxSeconds = [45, 60, 120, 300];
  const maxEntryPrices = [0.78, 0.85, 0.88, 0.92, 0.95, 0.98, 1.0];
  const minGaps = [0, 0.1, 0.2, 0.3, 0.4, 0.5];

  for (const probabilityThreshold of thresholds) {
    for (const confirmationTicks of confirmations) {
      for (const stopLossPct of stopLosses) {
        for (const minSecondsBeforeClose of minSeconds) {
          for (const maxSecondsBeforeClose of maxSeconds) {
            if (minSecondsBeforeClose >= maxSecondsBeforeClose) continue;
            for (const maxEntryPrice of maxEntryPrices) {
              if (maxEntryPrice < probabilityThreshold) continue;
              for (const minPriceGap of minGaps) {
                yield {
                  ...defaultStrategyConfig,
                  probabilityThreshold,
                  confirmationTicks,
                  stopLossPct,
                  minSecondsBeforeClose,
                  maxSecondsBeforeClose,
                  maxEntryPrice,
                  minPriceGap,
                  stakeBalanceRatio: 0.1,
                  maxStake: 10,
                  minStake: 1,
                  feeRate: 0,
                  slippageRate: 0,
                };
              }
            }
          }
        }
      }
    }
  }
}

export async function optimize(inputPath = resolve(rootDir, "data", "btc-5m-history.json")): Promise<Candidate[]> {
  const input = JSON.parse(await readFile(inputPath, "utf8")) as BacktestInput;
  const { train, test } = splitInput(input);
  const candidates: Candidate[] = [];

  for (const config of configGrid()) {
    const trainReport = runBacktestInput(train, config);
    const testReport = runBacktestInput(test, config);

    if (trainReport.tradeCount < 1 || testReport.tradeCount < 1) continue;

    const score = testReport.pnl - testReport.maxDrawdownPct * 0.1 + Math.min(trainReport.pnl, 0);
    candidates.push({
      config,
      trainPnl: trainReport.pnl,
      testPnl: testReport.pnl,
      trainRoiPct: trainReport.roiPct,
      testRoiPct: testReport.roiPct,
      trainTrades: trainReport.tradeCount,
      testTrades: testReport.tradeCount,
      testMaxDrawdownPct: testReport.maxDrawdownPct,
      score,
    });
  }

  return candidates.sort((a, b) => {
    const aPositive = a.trainPnl > 0 && a.testPnl > 0 ? 1 : 0;
    const bPositive = b.trainPnl > 0 && b.testPnl > 0 ? 1 : 0;
    if (aPositive !== bPositive) return bPositive - aPositive;
    return b.score - a.score;
  });
}

function formatCandidate(candidate: Candidate, rank: number): string {
  return [
    `## #${rank}`,
    "",
    `Train PnL: $${candidate.trainPnl.toFixed(2)} (${candidate.trainRoiPct.toFixed(2)}%)`,
    `Test PnL: $${candidate.testPnl.toFixed(2)} (${candidate.testRoiPct.toFixed(2)}%)`,
    `Train trades: ${candidate.trainTrades}`,
    `Test trades: ${candidate.testTrades}`,
    `Test max drawdown: ${candidate.testMaxDrawdownPct.toFixed(2)}%`,
    "",
    "```json",
    JSON.stringify(candidate.config, null, 2),
    "```",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2] ? resolve(process.argv[2]) : resolve(rootDir, "data", "btc-5m-history.json");
  const candidates = await optimize(inputPath);
  const positive = candidates.filter((candidate) => candidate.trainPnl > 0 && candidate.testPnl > 0);
  const best = positive[0] ?? candidates[0];
  const outputPath = resolve(rootDir, "reports", `optimizer-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);

  const backtestInput = JSON.parse(await readFile(inputPath, "utf8")) as BacktestInput;
  const bestReport = best ? runBacktestInput(backtestInput, best.config) : null;
  const lines = [
    "# Strategy Optimization Report",
    "",
    `Input: ${inputPath}`,
    `Candidates tested: ${candidates.length}`,
    `Positive train/test candidates: ${positive.length}`,
    "",
    "Note: A positive backtest is not a live-trading guarantee. Validate with more markets, spread-aware fills, and paper trading before enabling any live adapter.",
    "",
    ...(best ? [formatCandidate(best, 1)] : ["No tradable candidate found.", ""]),
    ...(bestReport ? ["# Full-Sample Backtest For Selected Candidate", "", formatReport(bestReport)] : []),
    "# Top Candidates",
    "",
    ...candidates.slice(0, 10).map(formatCandidate),
  ];

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, lines.join("\n"));

  if (!best) {
    console.log("No tradable candidate found.");
    process.exit(1);
  }

  console.log(lines.slice(0, 35).join("\n"));
  console.log(`Report written to ${outputPath}`);
}
