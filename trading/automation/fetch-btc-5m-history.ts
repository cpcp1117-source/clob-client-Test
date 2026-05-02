import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BacktestInput } from "./backtest.ts";
import type { MarketSnapshot } from "./types.ts";

type GammaMarket = {
  id?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  end_date_iso?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  outcomePrices?: string | string[];
  outcome?: string;
};

type GammaEvent = {
  slug?: string;
  closed?: boolean;
  markets?: GammaMarket[];
};

type PricePoint = {
  t: number;
  p: number;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gammaApiUrl = "https://gamma-api.polymarket.com";
const clobApiUrl = "https://clob.polymarket.com";

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

function resolveWinner(market: GammaMarket): "UP" | "DOWN" | null {
  const outcome = String(market.outcome ?? "").toLowerCase();
  if (outcome === "up") return "UP";
  if (outcome === "down") return "DOWN";

  const prices = parseArray(market.outcomePrices).map(Number);
  if (prices.length >= 2) {
    if (prices[0] >= 0.99) return "UP";
    if (prices[1] >= 0.99) return "DOWN";
  }

  return null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  return (await response.json()) as T;
}

async function fetchMarket(slug: string): Promise<GammaMarket | null> {
  const markets = await fetchJson<GammaMarket[]>(`${gammaApiUrl}/markets?slug=${encodeURIComponent(slug)}`);
  if (markets?.[0]) return markets[0];

  const events = await fetchJson<GammaEvent[]>(`${gammaApiUrl}/events?slug=${encodeURIComponent(slug)}`);
  return events?.[0]?.markets?.[0] ?? null;
}

async function discoverSeedStarts(): Promise<number[]> {
  const queries = ["bitcoin 5m", "Bitcoin Up or Down"];
  const starts = new Set<number>();

  for (const query of queries) {
    const response = await fetchJson<any>(`${gammaApiUrl}/public-search?q=${encodeURIComponent(query)}`);
    const results = Array.isArray(response)
      ? response
      : [...(response?.events ?? []), ...(response?.markets ?? []), ...(response?.results ?? [])];

    for (const result of results) {
      const match = String(result.slug ?? "").match(/^btc-updown-5m-(\d+)$/);
      if (match) starts.add(Number(match[1]));
    }
  }

  return [...starts].sort((a, b) => b - a);
}

async function fetchHistory(tokenId: string, startTs: number, endTs: number): Promise<PricePoint[]> {
  const params = new URLSearchParams({
    market: tokenId,
    startTs: String(startTs),
    endTs: String(endTs),
    fidelity: "1",
  });
  const data = await fetchJson<{ history?: PricePoint[] }>(`${clobApiUrl}/prices-history?${params.toString()}`);
  return data?.history ?? [];
}

function buildSnapshots(marketId: string, endTs: number, upHistory: PricePoint[], downHistory: PricePoint[]): MarketSnapshot[] {
  const downByTs = new Map(downHistory.map((point) => [point.t, point.p]));

  return upHistory
    .filter((up) => downByTs.has(up.t))
    .map((up) => ({
      marketId,
      timestamp: new Date(up.t * 1000).toISOString(),
      secondsToClose: Math.max(0, endTs - up.t),
      upPrice: Number(up.p),
      downPrice: Number(downByTs.get(up.t)),
    }))
    .filter((snapshot) => Number.isFinite(snapshot.upPrice) && Number.isFinite(snapshot.downPrice))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export async function fetchBtc5mHistory(rounds = 144): Promise<BacktestInput> {
  const seedStarts = await discoverSeedStarts();
  const currentWindow = seedStarts[0] ?? Math.floor(Date.now() / 300000) * 300;
  const windows = new Set<number>();

  for (const seed of seedStarts) {
    const half = Math.floor(rounds / 2);
    for (let offset = -half; offset <= half; offset++) {
      windows.add(seed + offset * 300);
    }
  }

  if (windows.size === 0) {
    for (let i = rounds; i >= 1; i--) {
      windows.add(currentWindow - i * 300);
    }
  }

  const settlements: BacktestInput["settlements"] = {};
  const snapshots: MarketSnapshot[] = [];
  const sortedWindows = [...windows].filter((windowStart) => windowStart <= currentWindow).sort((a, b) => a - b).slice(-rounds);

  for (const windowStart of sortedWindows) {
    const slug = `btc-updown-5m-${windowStart}`;
    const market = await fetchMarket(slug);
    if (!market?.closed) continue;

    const tokenIds = parseArray(market.clobTokenIds);
    if (tokenIds.length < 2) continue;

    const winner = resolveWinner(market);
    if (!winner) continue;

    const endTs = Math.floor(new Date(market.endDate ?? market.end_date_iso ?? (windowStart + 300) * 1000).getTime() / 1000);
    const startTs = windowStart;
    const marketId = market.slug ?? slug;

    const [upHistory, downHistory] = await Promise.all([
      fetchHistory(tokenIds[0], startTs, endTs),
      fetchHistory(tokenIds[1], startTs, endTs),
    ]);

    const marketSnapshots = buildSnapshots(marketId, endTs, upHistory, downHistory);
    if (marketSnapshots.length < 3) continue;

    snapshots.push(...marketSnapshots);
    settlements[marketId] = winner;
  }

  return { snapshots, settlements };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rounds = Number(process.argv[2] ?? 144);
  const outputPath = resolve(rootDir, "data", "btc-5m-history.json");
  const data = await fetchBtc5mHistory(rounds);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(data, null, 2));

  console.log(`Fetched ${Object.keys(data.settlements).length} settled markets`);
  console.log(`Fetched ${data.snapshots.length} price snapshots`);
  console.log(`Wrote ${outputPath}`);
}
