/**
 * @scriptmasterlabs/mcp-x402
 *
 * heatmap.ts — Groups scored items (RSI, Delta, ...) into the "overbought /
 * oversold" heatmap shape: N groups, each with its members and avg/min/max,
 * plus the thresholds that define the overbought/oversold bands.
 */

export interface HeatmapItem {
  symbol: string;
  /** Indicator value on a 0-100 scale (RSI natively; Delta is pre-scaled by the caller). */
  value: number;
  meta?: Record<string, unknown>;
}

export interface HeatmapGroupResult {
  group: string;
  items: HeatmapItem[];
  avg: number;
  min: number;
  max: number;
}

export interface HeatmapResult {
  groups: HeatmapGroupResult[];
  overboughtThreshold: number;
  oversoldThreshold: number;
  scale: string;
  generatedAt: string;
}

export interface BuildHeatmapOptions {
  /** Number of groups to split items into. Defaults to 4 (Group A-D, matching the reference layout). */
  groupsOf?: number;
  overboughtThreshold?: number;
  oversoldThreshold?: number;
  scale?: string;
}

const GROUP_LETTERS = "ABCDEFGHIJ";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildHeatmap(items: HeatmapItem[], opts: BuildHeatmapOptions = {}): HeatmapResult {
  const groupsOf = Math.max(1, opts.groupsOf ?? 4);
  const overboughtThreshold = opts.overboughtThreshold ?? 70;
  const oversoldThreshold = opts.oversoldThreshold ?? 30;
  const scale = opts.scale ?? "0-100";

  const chunkSize = Math.max(1, Math.ceil(items.length / groupsOf));
  const groups: HeatmapGroupResult[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const values = chunk.map((c) => c.value);
    groups.push({
      group: `Group ${GROUP_LETTERS[groups.length] ?? String(groups.length + 1)}`,
      items: chunk,
      avg: round1(values.reduce((a, b) => a + b, 0) / values.length),
      min: round1(Math.min(...values)),
      max: round1(Math.max(...values)),
    });
  }

  return {
    groups,
    overboughtThreshold,
    oversoldThreshold,
    scale,
    generatedAt: new Date().toISOString(),
  };
}
