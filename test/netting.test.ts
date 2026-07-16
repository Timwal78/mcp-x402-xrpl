import { netPayments, validateTaskGraph } from "../src/settlement-router/netting.js";

const A = "0xAaaaAAaaAaAaAAAAAAaaAAAAaaAAaaaaAAaAaaAA";
const B = "0xBBbbBBbbbBBBbbbbbbBbbbbBbBbbbbBBbbBBBBbb";
const C = "0xCcccCCCCcCcccCCCCCCCcccccCCCCCCcCCCCCCc";

describe("netPayments", () => {
  it("computes correct signed balances for a simple triangle (PRD worked example: A->B $30, B->C $20, C->A $10)", () => {
    const result = netPayments([
      { from: A, to: B, amount: 30n },
      { from: B, to: C, amount: 20n },
      { from: C, to: A, amount: 10n },
    ]);

    // A: -30 (paid B) + 10 (received from C) = -20
    // B: +30 (from A) - 20 (paid C) = +10
    // C: +20 (from B) - 10 (paid A) = +10
    expect(result.balances.get(A)).toBe(-20n);
    expect(result.balances.get(B)).toBe(10n);
    expect(result.balances.get(C)).toBe(10n);

    expect(result.agents.sort()).toEqual([B, C].sort());
    expect(result.netPayouts.reduce((a, b) => a + b, 0n)).toBe(20n);
  });

  it("nets a chain down to zero net flow when it's a closed loop of equal amounts", () => {
    const result = netPayments([
      { from: A, to: B, amount: 15n },
      { from: B, to: C, amount: 15n },
      { from: C, to: A, amount: 15n },
    ]);
    expect(result.agents).toEqual([]);
    expect(result.netPayouts).toEqual([]);
  });

  it("rejects zero/negative amounts and self-payment edges", () => {
    expect(() => netPayments([{ from: A, to: B, amount: 0n }])).toThrow();
    expect(() => netPayments([{ from: A, to: A, amount: 5n }])).toThrow();
  });

  it("is case-insensitive on addresses but preserves original casing in output", () => {
    const result = netPayments([
      { from: A, to: B, amount: 5n },
      { from: A.toLowerCase(), to: B.toLowerCase(), amount: 5n },
    ]);
    // Both edges refer to the same A->B pair regardless of casing, so they
    // should net into a single balance entry per address, not four.
    expect(result.balances.size).toBe(2);
    expect(result.balances.get(A)).toBe(-10n);
    expect(result.balances.get(B)).toBe(10n);
  });
});

describe("validateTaskGraph", () => {
  it("passes when netPayouts + fee fit inside the task budget", () => {
    const result = validateTaskGraph([20n, 10n, 10n], 50n, 50n); // 0.5% fee
    expect(result.ok).toBe(true);
    expect(result.totalFlow).toBe(40n);
    expect(result.protocolFee).toBe(0n); // 40 * 50 / 10000 = 0 (integer division)
  });

  it("fails when totalFlow + fee exceeds the task budget", () => {
    const result = validateTaskGraph([1000n], 500n, 50n);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds taskBudget/);
  });

  it("rejects a protocol fee outside the on-chain 0-500 bps cap", () => {
    const result = validateTaskGraph([10n], 1000n, 501n);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside the on-chain 0-500 bps range/);
  });

  it("throws on a non-positive payout entry (netPayments never emits one, but defends the boundary anyway)", () => {
    expect(() => validateTaskGraph([10n, 0n], 1000n, 50n)).toThrow();
  });
});
