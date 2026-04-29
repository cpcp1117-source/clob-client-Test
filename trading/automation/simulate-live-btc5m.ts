import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStrategyConfig, type StrategyConfig } from "./config.ts";
import { formatReport } from "./backtest.ts";
import { PaperBroker } from "./paper-broker.ts";
import { StrategyEngine } from "./strategy-engine.ts";
import type { MarketSide, MarketSnapshot } from "./types.ts";

type GammaMarket = {
  slug?: string;
  question?: string;
  closed?: boolean;
  endDate?: string;
  end_date_iso?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
};

type GammaEvent = {
  slug?: string;
  closed?: boolean;
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
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(): { cycles: number; pollMs: number; config: StrategyConfig } {
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

  return {
    cycles,
    pollMs,
    config: {
      ...defaultStrategyConfig,
      initialBalance: Number(args.get("initial-balance") ?? defaultStrategyConfig.initialBalance),
      minStake: Number(args.get("min-stake") ?? defaultStrategyConfig.minStake),
      maxStake: Number(args.get("max-stake") ?? defaultStrategyConfig.maxStake),
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
  const response = await fetch(url);
  if (!response.ok) return null;
  return (await response.json()) as T;
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

export function resolveWinner(market: Pick<GammaMarket, "outcomePrices">): MarketSide | null {
  const prices = parseArray(market.outcomePrices).map(Number);
  if (prices.length >= 2) {
    if (prices[0] >= 0.99) return "UP";
    if (prices[1] >= 0.99) return "DOWN";
  }
  return null;
}

async function settleIfResolved(broker: PaperBroker, marketId: string, cycleLabel: string): Promise<boolean> {
  if (!broker.hasOpenPosition()) return false;

  const position = broker.getOpenPosition();
  if (!position || position.marketId !== marketId) return false;

  const market = await fetchAnyEventMarket(marketId);
  const winner = market ? resolveWinner(market) : null;
  if (!winner) return false;

  broker.settleMarket(marketId, new Date().toISOString(), winner);
  console.log(`[${cycleLabel}] SETTLED ${marketId} winner=${winner}`);
  return true;
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

async function buildSnapshots(market: GammaMarket): Promise<{ decision: MarketSnapshot; exit: MarketSnapshot } | null> {
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
    decision: {
      ...base,
      upPrice: Number(upBuy),
      downPrice: Number(downBuy),
    },
    exit: {
      ...base,
      upPrice: Number(upSell ?? upBuy),
      downPrice: Number(downSell ?? downBuy),
    },
  };
}

function formatDecisionLine(snapshot: MarketSnapshot): string {
  const leader: MarketSide = snapshot.upPrice >= snapshot.downPrice ? "UP" : "DOWN";
  const leaderPrice = leader === "UP" ? snapshot.upPrice : snapshot.downPrice;
  return `${snapshot.marketId} T-${snapshot.secondsToClose}s UP=${snapshot.upPrice.toFixed(3)} DOWN=${snapshot.downPrice.toFixed(3)} leader=${leader}@${leaderPrice.toFixed(3)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main(): Promise<void> {
  const { cycles, pollMs, config } = parseArgs();
  const strategy = new StrategyEngine(config);
  const broker = new PaperBroker(config);
  let activeMarketId: string | null = null;

  console.log("BTC 5m live paper simulator");
  console.log(`cycles=${cycles} pollMs=${pollMs}`);
  console.log(`initialBalance=$${config.initialBalance.toFixed(2)} minStake=$${config.minStake.toFixed(2)} maxStake=$${config.maxStake.toFixed(2)}`);
  console.log(`feeRate=${(config.feeRate * 100).toFixed(3)}% slippageRate=${(config.slippageRate * 100).toFixed(3)}%`);
  console.log("No real orders will be placed.\n");

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const market = await findCurrentBtc5mMarket();
    if (!market) {
      if (activeMarketId && broker.hasOpenPosition()) {
        const settled = await settleIfResolved(broker, activeMarketId, `${cycle}/${cycles}`);
        if (settled) activeMarketId = null;
      }
      console.log(`[${cycle}/${cycles}] No active BTC 5m market found.`);
      await sleep(pollMs);
      continue;
    }

    if (activeMarketId && activeMarketId !== market.slug) {
      if (broker.hasOpenPosition()) {
        const settled = await settleIfResolved(broker, activeMarketId, `${cycle}/${cycles}`);
        if (!settled) {
          console.log(`Market changed from ${activeMarketId} to ${market.slug}. Open simulated position remains marked until settlement data is available.`);
        }
      }
    }
    activeMarketId = market.slug ?? null;

    const snapshots = await buildSnapshots(market);
    if (!snapshots) {
      console.log(`[${cycle}/${cycles}] Could not build market snapshot for ${market.slug}.`);
      await sleep(pollMs);
      continue;
    }

    broker.mark(snapshots.exit);
    const decision = strategy.decide(snapshots.decision, broker.hasOpenPosition());
    if (decision.action === "BUY") {
      const position = broker.buy(snapshots.decision, decision.side, decision.price);
      if (position) {
        console.log(`[${cycle}/${cycles}] BUY ${position.side} signal=${position.signalEntryPrice.toFixed(3)} execution=${position.entryPrice.toFixed(3)} stake=$${position.stake.toFixed(2)} fee=$${position.entryFee.toFixed(4)} shares=${position.shares.toFixed(4)}`);
      }
    } else {
      console.log(`[${cycle}/${cycles}] ${decision.action} ${decision.reason} | ${formatDecisionLine(snapshots.decision)}`);
    }

    if (cycle < cycles) await sleep(pollMs);
  }

  const report = broker.report();
  const output = formatReport(report);
  const reportPath = resolve(rootDir, "reports", `live-paper-btc5m-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, output);

  console.log("\n" + output);
  const openPosition = broker.getOpenPosition();
  if (openPosition) {
    console.log(`Open simulated position: ${openPosition.side} ${openPosition.marketId} entry=${openPosition.entryPrice.toFixed(3)} stake=$${openPosition.stake.toFixed(2)} shares=${openPosition.shares.toFixed(4)} cash=$${broker.getCashBalance().toFixed(2)}`);
  }
  console.log(`Report written to ${reportPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
