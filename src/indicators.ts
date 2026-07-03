/**
 * @scriptmasterlabs/mcp-x402
 *
 * indicators.ts — Self-contained technical indicator math.
 *
 * No upstream dependency: given a series of closing prices, computes RSI
 * using Wilder's smoothing (the standard TA-Lib definition). Used to build
 * the equities RSI heatmap.
 */

/**
 * Wilder's RSI over a closing-price series.
 * Returns null if there isn't enough history (needs period + 1 closes).
 */
export function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}
