import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SplitPaperBroker, type SplitOrderReport } from "./split-paper-broker.ts";
import { SplitOrderStrategy, defaultSplitOrderConfig, type SplitOrderConfig } from "./split-order-strategy.ts";
import { resolveWinner } from "./simulate-live-btc5m.ts";
import { sendDiscordNotificationToChannel } from "../strategy/discord-notifier.ts";
import type { MarketSide, MarketSnapshot } from "./types.ts";

type GammaMarket = {
  slug?: string;
  closed?: boolean;
  endDate?: string;
  end_date_iso?: string;
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
};

type GammaEvent = {
  markets?: GammaMarket[];
};

type BookLevel = {
  price: string;
  size: string;
};

type OrderBook = {
  bids?: BookLevel[];
  asks?: BookLevel[];
};

type TokenPrices = {
  buy: number;
  sell: number;
};

const gammaApiUrl = "https://gamma-api.polymarket.com";
const clobApiUrl = "https://clob.polymarket.com";
const splitDiscordChannelId = process.env.DISCORD_SPLIT_CHANNEL_ID || "1498963560460718101";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(): { cycles: number; pollMs: number; config: SplitOrderConfig } {
  const args = new Map<string, string>();
  for (const raw of process.argv.slice(2)) {
    const [key, value = "true"] = raw.replace(/^--/, "").split("=");
    args.set(key, value);
  }

  const pollMs = Number(args.get("poll-ms") ?? 5000);
  const hours = args.has("hours") ? Number(args.get("hours")) : null;
  const cycles = hours && hours > 0
    ? Math.ceil((hours * 60 * 60 * 1000) / pollMs)
    : Number(args.get("cycles") ?? 60);
  const takeProfitPct = Number(args.get("take-profit-pct") ?? defaultSplitOrderConfig.takeProfitPct);

  if (takeProfitPct < 0.2 || takeProfitPct > 0.3) {
    throw new Error("--take-profit-pct must be between 0.20 and 0.30 for this split-order strategy");
  }

  return {
    cycles,
    pollMs,
    config: {
      ...defaultSplitOrderConfig,
      initialBalance: Number(args.get("initial-balance") ?? defaultSplitOrderConfig.initialBalance),
      stakePerSide: Number(args.get("stake-per-side") ?? defaultSplitOrderConfig.stakePerSide),
      takeProfitPct,
    },
  };
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function fetchJson<T>(url: string): Promise<T | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch (error) {
      if (attempt === 3) {
        console.warn(`fetch failed after ${attempt} attempts: ${url}`, error);
        return null;
      }
      await sleep(250 * attempt);
    }
  }
  return null;
}

async function fetchEventMarket(slug: string): Promise<GammaMarket | null> {
  const events = await fetchJson<GammaEvent[]>(`${gammaApiUrl}/events?slug=${encodeURIComponent(slug)}`);
  return events?.[0]?.markets?.[0] ?? null;
}

async function fetchAnyEventMarket(slug: string): Promise<GammaMarket | null> {
  const market = await fetchEventMarket(slug);
  if (market) return market;

  const markets = await fetchJson<GammaMarket[]>(`${gammaApiUrl}/markets?slug=${encodeURIComponent(slug)}`);
  return markets?.[0] ?? null;
}

async function findCurrentBtc5mMarket(): Promise<GammaMarket | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(nowSec / 300) * 300;
  const candidates = [
    currentWindow - 600,
    currentWindow - 300,
    currentWindow,
    currentWindow + 300,
  ];

  for (const startTs of candidates) {
    const market = await fetchEventMarket(`btc-updown-5m-${startTs}`);
    if (!market || market.closed) continue;

    const endTime = market.endDate ?? market.end_date_iso;
    if (!endTime) continue;
    if (new Date(endTime).getTime() > Date.now()) return market;
  }

  return null;
}

function getTimeRemaining(market: GammaMarket): number {
  const endTime = market.endDate ?? market.end_date_iso;
  if (!endTime) return 999;
  return Math.max(0, Math.floor((new Date(endTime).getTime() - Date.now()) / 1000));
}

async function fetchBookPrice(tokenId: string): Promise<TokenPrices | null> {
  const params = new URLSearchParams({ token_id: tokenId });
  const book = await fetchJson<OrderBook>(`${clobApiUrl}/book?${params.toString()}`);
  const asks = (book?.asks ?? []).map((level) => Number(level.price)).filter(Number.isFinite);
  const bids = (book?.bids ?? []).map((level) => Number(level.price)).filter(Number.isFinite);

  if (asks.length === 0 && bids.length === 0) return null;

  const buy = asks.length > 0 ? Math.min(...asks) : Math.max(...bids);
  const sell = bids.length > 0 ? Math.max(...bids) : buy;
  return { buy, sell };
}

async function buildSnapshots(market: GammaMarket): Promise<{ entry: MarketSnapshot; exit: MarketSnapshot } | null> {
  const tokenIds = parseArray(market.clobTokenIds);
  if (tokenIds.length < 2 || !market.slug) return null;

  const [upBook, downBook] = await Promise.all([
    fetchBookPrice(tokenIds[0]),
    fetchBookPrice(tokenIds[1]),
  ]);

  let upBuy = upBook?.buy;
  let downBuy = downBook?.buy;
  let upSell = upBook?.sell;
  let downSell = downBook?.sell;

  const fallbackPrices = parseArray(market.outcomePrices).map(Number);
  if (!Number.isFinite(upBuy) || !Number.isFinite(downBuy)) {
    if (fallbackPrices.length < 2) return null;
    upBuy = fallbackPrices[0];
    downBuy = fallbackPrices[1];
    upSell = upBuy;
    downSell = downBuy;
  }

  const base = {
    marketId: market.slug,
    timestamp: new Date().toISOString(),
    secondsToClose: getTimeRemaining(market),
  };

  return {
    entry: { ...base, upPrice: Number(upBuy), downPrice: Number(downBuy) },
    exit: { ...base, upPrice: Number(upSell ?? upBuy), downPrice: Number(downSell ?? downBuy) },
  };
}

async function settleIfResolved(broker: SplitPaperBroker, marketId: string, cycleLabel: string): Promise<boolean> {
  if (!broker.hasOpenMarket()) return false;

  const market = await fetchAnyEventMarket(marketId);
  const winner = market ? resolveSplitWinner(market) : null;
  if (!winner) return false;

  broker.settleMarket(marketId, new Date().toISOString(), winner);
  console.log(`[${cycleLabel}] SETTLED ${marketId} winner=${winner}`);
  await notifyRoundSummary(broker, marketId);
  return true;
}

function resolveSplitWinner(market: GammaMarket): MarketSide | null {
  const resolved = resolveWinner(market);
  if (resolved) return resolved;

  const prices = parseArray(market.outcomePrices).map(Number);
  if (market.closed && prices.length >= 2 && Number.isFinite(prices[0]) && Number.isFinite(prices[1])) {
    if (prices[0] === prices[1]) return null;
    return prices[0] > prices[1] ? "UP" : "DOWN";
  }

  return null;
}

async function notifyDiscord(message: string): Promise<void> {
  await sendDiscordNotificationToChannel(`[拆單策略] ${message}`, splitDiscordChannelId);
}

async function notifyRoundSummary(broker: SplitPaperBroker, marketId: string): Promise<void> {
  const report = broker.report();
  const roundLegs = report.legs.filter((leg) => leg.marketId === marketId);
  if (roundLegs.length === 0 || roundLegs.some((leg) => leg.status === "OPEN")) return;

  const roundPnl = roundLegs.reduce((sum, leg) => sum + (leg.pnl ?? 0), 0);
  const buyLines = roundLegs.map((leg) =>
    `${leg.side}：${leg.entryPrice.toFixed(3)}，金額 $${leg.stake.toFixed(2)}`
  );
  const exitLines = roundLegs.map((leg) => {
    const pnl = leg.pnl ?? 0;
    const exit = leg.exitPrice === undefined ? "-" : leg.exitPrice.toFixed(3);
    const label = leg.status === "TAKE_PROFIT"
      ? "停利賣出"
      : leg.status === "WIN"
        ? "結算獲勝"
        : "結算失敗";
    return `${leg.side} ${label}：出場 ${exit} / 獲利 $${pnl.toFixed(2)}`;
  });

  await notifyDiscord(
    [
      "本輪交易紀錄",
      `市場：${marketId}`,
      "",
      "買入：",
      ...buyLines,
      "",
      "出場：",
      ...exitLines,
      "",
      `本輪獲利：$${roundPnl.toFixed(2)}`,
      `總獲利：$${report.pnl.toFixed(2)}`,
      `當前總金額：$${report.finalBalance.toFixed(2)}`,
    ].join("\n")
  );
}

function formatSnapshot(snapshot: MarketSnapshot): string {
  return `${snapshot.marketId} T-${snapshot.secondsToClose}s UP=${snapshot.upPrice.toFixed(3)} DOWN=${snapshot.downPrice.toFixed(3)}`;
}

function formatReport(report: SplitOrderReport): string {
  const lines = [
    "# BTC 5m Split Order Paper Report",
    "",
    `Initial balance: $${report.initialBalance.toFixed(2)}`,
    `Final balance: $${report.finalBalance.toFixed(2)}`,
    `PnL: $${report.pnl.toFixed(2)}`,
    `ROI: ${report.roiPct.toFixed(2)}%`,
    `Rounds: ${report.rounds}`,
    `Closed legs: ${report.closedLegs}`,
    `Take profits: ${report.takeProfits}`,
    `Wins: ${report.wins}`,
    `Losses: ${report.losses}`,
    `Open legs: ${report.openLegs}`,
    "",
    "| Market | Side | Entry | Exit | Stake | Status | PnL | Opened | Closed |",
    "|---|---|---:|---:|---:|---|---:|---|---|",
    ...report.legs.map((leg) =>
      `| ${leg.marketId} | ${leg.side} | ${leg.entryPrice.toFixed(3)} | ${leg.exitPrice?.toFixed(3) ?? ""} | $${leg.stake.toFixed(2)} | ${leg.status} | ${leg.pnl?.toFixed(2) ?? ""} | ${leg.openedAt} | ${leg.closedAt ?? ""} |`
    ),
    "",
  ];

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main(): Promise<void> {
  const { cycles, pollMs, config } = parseArgs();
  const strategy = new SplitOrderStrategy(config);
  const broker = new SplitPaperBroker(config);
  let activeMarketId: string | null = null;
  const tradedMarketIds = new Set<string>();

  console.log("BTC 5m split-order live paper simulator");
  console.log(`cycles=${cycles} pollMs=${pollMs}`);
  console.log(`initialBalance=$${config.initialBalance.toFixed(2)} stakePerSide=$${config.stakePerSide.toFixed(2)} takeProfit=${(config.takeProfitPct * 100).toFixed(1)}%`);
  console.log("No real orders will be placed.\n");
  await notifyDiscord(
    `模擬啟動\n本金：$${config.initialBalance.toFixed(2)}\n每邊金額：$${config.stakePerSide.toFixed(2)}\n停利：+${(config.takeProfitPct * 100).toFixed(1)}%\n模式：紙上交易，不會真實下單`
  );

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const market = await findCurrentBtc5mMarket();
    if (!market) {
      if (activeMarketId) {
        const settled = await settleIfResolved(broker, activeMarketId, `${cycle}/${cycles}`);
        if (settled) activeMarketId = null;
      }
      console.log(`[${cycle}/${cycles}] No active BTC 5m market found.`);
      await sleep(pollMs);
      continue;
    }

    if (activeMarketId && activeMarketId !== market.slug) {
      await settleIfResolved(broker, activeMarketId, `${cycle}/${cycles}`);
      if (broker.hasOpenMarket()) {
        console.log(`[${cycle}/${cycles}] Waiting for previous split round to settle: ${activeMarketId}`);
        if (cycle < cycles) await sleep(pollMs);
        continue;
      }
    }
    activeMarketId = market.slug ?? null;

    const snapshots = await buildSnapshots(market);
    if (!snapshots) {
      console.log(`[${cycle}/${cycles}] Could not build market snapshot for ${market.slug}.`);
      await sleep(pollMs);
      continue;
    }

    for (const leg of broker.getOpenLegs()) {
      if (leg.marketId !== snapshots.exit.marketId) continue;
      const decision = strategy.decideExit(snapshots.exit, leg);
      if (decision.action === "SELL") {
        const closed = broker.sell(snapshots.exit, decision.side, decision.price);
        if (closed) {
          console.log(`[${cycle}/${cycles}] SELL ${closed.side} exit=${closed.exitPrice?.toFixed(3)} target=${decision.targetPrice.toFixed(3)} pnl=$${closed.pnl?.toFixed(2)} profit=${(decision.profitPct * 100).toFixed(1)}%`);
          await notifyRoundSummary(broker, closed.marketId);
        }
      }
    }

    const alreadyTradedThisMarket = snapshots.entry.marketId
      ? tradedMarketIds.has(snapshots.entry.marketId)
      : false;
    const entryDecision = alreadyTradedThisMarket
      ? { action: "SKIP" as const, reason: "already entered this market" }
      : strategy.decideEntry(snapshots.entry, broker.hasOpenMarket());
    if (entryDecision.action === "BUY_BOTH") {
      const round = broker.buyBoth(snapshots.entry, { up: snapshots.entry.upPrice, down: snapshots.entry.downPrice });
      if (round) {
        tradedMarketIds.add(snapshots.entry.marketId);
        const up = round.legs.find((leg) => leg.side === "UP");
        const down = round.legs.find((leg) => leg.side === "DOWN");
        console.log(`[${cycle}/${cycles}] BUY_BOTH UP=${up?.entryPrice.toFixed(3)} DOWN=${down?.entryPrice.toFixed(3)} stake=$${config.stakePerSide.toFixed(2)} each cash=$${broker.getCashBalance().toFixed(2)}`);
      }
    } else {
      console.log(`[${cycle}/${cycles}] ${entryDecision.action} ${entryDecision.reason} | ${formatSnapshot(snapshots.entry)}`);
    }

    if (cycle < cycles) await sleep(pollMs);
  }

  if (activeMarketId) {
    await settleIfResolved(broker, activeMarketId, `${cycles}/${cycles}`);
  }

  const report = broker.report();
  const output = formatReport(report);
  const reportPath = resolve(rootDir, "reports", `live-paper-btc5m-split-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, output);

  console.log("\n" + output);
  console.log(`Report written to ${reportPath}`);
  await notifyDiscord(
    `模擬結束\n總獲利：$${report.pnl.toFixed(2)}\n當前總金額：$${report.finalBalance.toFixed(2)}\n已停利：${report.takeProfits} 筆\n未結束持倉：${report.openLegs} 筆`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
