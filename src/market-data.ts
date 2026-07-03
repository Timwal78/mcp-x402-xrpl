/**
 * @scriptmasterlabs/mcp-x402
 *
 * market-data.ts — Polygon.io client for equities bars and options chain
 * snapshots. Never returns mock data: a missing key or an upstream error
 * throws, matching the "never mock" contract used by the rest of the
 * SqueezeOS server.
 */

const POLYGON_BASE_URL = "https://api.polygon.io";

// ─── Equities ───────────────────────────────────────────────────────────────

export type EquityTimeframe = "1h" | "1d";

/**
 * Fetch up to `lookbackBars` closing prices for `ticker`, oldest first.
 * Timeframe "1h" pulls hourly aggregates, "1d" pulls daily aggregates.
 */
export async function fetchEquityCloses(
  ticker: string,
  timeframe: EquityTimeframe,
  apiKey: string,
  lookbackBars = 60,
): Promise<number[]> {
  if (!apiKey) throw new Error("Polygon API key is required — set POLYGON_API_KEY");

  const { multiplier, timespan, lookbackMs } =
    timeframe === "1d"
      ? { multiplier: 1, timespan: "day", lookbackMs: lookbackBars * 24 * 3600 * 1000 * 1.6 }
      : { multiplier: 1, timespan: "hour", lookbackMs: lookbackBars * 3600 * 1000 * 3 };

  const to = new Date();
  const from = new Date(to.getTime() - lookbackMs);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const url =
    `${POLYGON_BASE_URL}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/` +
    `${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&limit=${lookbackBars * 2}&apiKey=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable body)");
    throw new Error(`Polygon aggs ${ticker} → HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { results?: Array<{ c: number }> };
  const closes = (data.results ?? []).map((r) => r.c).filter((c) => typeof c === "number");
  return closes.slice(-lookbackBars);
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface OptionContractSnapshot {
  ticker: string;
  strike: number;
  expirationDate: string;
  contractType: "call" | "put";
  /** Annualized implied volatility as returned by Polygon, or null if unavailable. */
  impliedVolatility: number | null;
}

export interface OptionsChainSnapshot {
  underlying: string;
  underlyingPrice: number;
  contracts: OptionContractSnapshot[];
}

export interface OptionsChainQuery {
  expirationDate?: string;
  contractType?: "call" | "put";
  limit?: number;
}

/** Fetch a snapshot of an options chain (strikes/expirations/IV) for `underlying`. */
export async function fetchOptionsChainSnapshot(
  underlying: string,
  apiKey: string,
  query: OptionsChainQuery = {},
): Promise<OptionsChainSnapshot> {
  if (!apiKey) throw new Error("Polygon API key is required — set POLYGON_API_KEY");

  const params = new URLSearchParams({
    order: "asc",
    sort: "strike_price",
    limit: String(query.limit ?? 40),
    apiKey,
  });
  if (query.expirationDate) params.set("expiration_date", query.expirationDate);
  if (query.contractType) params.set("contract_type", query.contractType);

  const url = `${POLYGON_BASE_URL}/v3/snapshot/options/${encodeURIComponent(underlying)}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable body)");
    throw new Error(`Polygon options snapshot ${underlying} → HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    results?: Array<{
      details?: { contract_type?: string; expiration_date?: string; strike_price?: number; ticker?: string };
      implied_volatility?: number;
      underlying_asset?: { price?: number };
    }>;
  };

  const results = data.results ?? [];
  const underlyingPrice = results.find((r) => r.underlying_asset?.price)?.underlying_asset?.price ?? 0;

  const contracts: OptionContractSnapshot[] = results
    .filter((r) => r.details?.strike_price !== undefined && r.details?.expiration_date)
    .map((r) => ({
      ticker: r.details!.ticker ?? "",
      strike: r.details!.strike_price as number,
      expirationDate: r.details!.expiration_date as string,
      contractType: r.details!.contract_type === "put" ? "put" : "call",
      impliedVolatility: typeof r.implied_volatility === "number" ? r.implied_volatility : null,
    }));

  return { underlying: underlying.toUpperCase(), underlyingPrice, contracts };
}
