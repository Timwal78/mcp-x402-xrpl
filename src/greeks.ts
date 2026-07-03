/**
 * @scriptmasterlabs/mcp-x402
 *
 * greeks.ts — Self-contained Black-Scholes option Delta.
 *
 * Delta is computed locally from spot, strike, time-to-expiry, and implied
 * volatility rather than trusted from a vendor's pre-computed greeks field —
 * this keeps the options Delta heatmap correct even against data providers
 * whose tier doesn't return greeks.
 */

export type OptionType = "call" | "put";

export interface DeltaInputs {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  /** Annualized implied volatility, e.g. 0.35 for 35%. */
  volatility: number;
  /** Annualized risk-free rate. Defaults to 0.05. */
  riskFreeRate?: number;
  optionType: OptionType;
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17 approximation, |error| < 7.5e-8). */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Black-Scholes delta. Degenerates to the intrinsic-value sign at/after
 * expiry (timeToExpiryYears <= 0) rather than dividing by zero.
 */
export function blackScholesDelta(inputs: DeltaInputs): number {
  const { spot, strike, timeToExpiryYears, volatility, riskFreeRate = 0.05, optionType } = inputs;

  if (spot <= 0 || strike <= 0 || timeToExpiryYears <= 0 || volatility <= 0) {
    const inTheMoney = optionType === "call" ? spot > strike : spot < strike;
    if (!inTheMoney) return 0;
    return optionType === "call" ? 1 : -1;
  }

  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + (volatility * volatility) / 2) * timeToExpiryYears) /
    (volatility * Math.sqrt(timeToExpiryYears));

  const nd1 = normalCdf(d1);
  return optionType === "call" ? nd1 : nd1 - 1;
}
