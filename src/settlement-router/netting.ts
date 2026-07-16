/**
 * @scriptmasterlabs/mcp-x402
 *
 * settlement-router/netting.ts — Off-chain payment graph netting engine.
 *
 * Sits in front of asc-contracts/contracts/settlement-router/SettlementRouter.sol.
 * A multi-agent task produces a gross payment graph (agent A owes agent B
 * for a sub-task, B owes C, etc.); instead of settling every edge as its own
 * on-chain transaction, this module nets the graph down to one balance per
 * agent and hands the result to SettlementRouterClient.settleTask(), which
 * submits it as a single on-chain transaction.
 *
 * This module does no chain I/O and holds no keys — it is pure arithmetic
 * over bigints, deliberately kept side-effect-free so it can be unit tested
 * without a provider and reused from any orchestrator (see
 * settlement-router-adapter.ts for the HTTP surface an external orchestrator
 * like SqueezeOS's hiring board calls).
 */

export interface PaymentEdge {
  from: string;
  to: string;
  /** Smallest token unit (e.g. USDC has 6 decimals — pass raw integer units, not dollars). */
  amount: bigint;
}

export interface NetResult {
  /** Agents with a strictly positive net balance, in stable insertion order. */
  agents: string[];
  /** netPayouts[i] corresponds to agents[i]. Always > 0. */
  netPayouts: bigint[];
  /** Every address that appeared in the input graph, net balance included (can be negative). */
  balances: Map<string, bigint>;
}

/**
 * Sums inflows minus outflows per address, then keeps only the strictly
 * positive balances — those are the only addresses TaskEscrow.settle() pays
 * out to. Addresses are compared case-insensitively (checksummed on the way
 * out using whatever casing first appeared) since Ethereum addresses aren't
 * case sensitive but bigint map keys need a canonical string form.
 */
export function netPayments(edges: PaymentEdge[]): NetResult {
  const balances = new Map<string, bigint>();
  const canonicalCasing = new Map<string, string>();

  const touch = (address: string): string => {
    const key = address.toLowerCase();
    if (!canonicalCasing.has(key)) {
      canonicalCasing.set(key, address);
      balances.set(key, 0n);
    }
    return key;
  };

  for (const edge of edges) {
    if (edge.amount <= 0n) {
      throw new Error(`netPayments: edge amount must be positive (from=${edge.from} to=${edge.to})`);
    }
    if (edge.from.toLowerCase() === edge.to.toLowerCase()) {
      throw new Error(`netPayments: self-payment edge is not allowed (${edge.from})`);
    }
    const fromKey = touch(edge.from);
    const toKey = touch(edge.to);
    balances.set(fromKey, (balances.get(fromKey) ?? 0n) - edge.amount);
    balances.set(toKey, (balances.get(toKey) ?? 0n) + edge.amount);
  }

  const agents: string[] = [];
  const netPayouts: bigint[] = [];
  const outputBalances = new Map<string, bigint>();

  for (const [key, balance] of balances.entries()) {
    const original = canonicalCasing.get(key)!;
    outputBalances.set(original, balance);
    if (balance > 0n) {
      agents.push(original);
      netPayouts.push(balance);
    }
  }

  return { agents, netPayouts, balances: outputBalances };
}

export interface ValidationResult {
  ok: boolean;
  totalFlow: bigint;
  protocolFee: bigint;
  reason?: string;
}

/**
 * TaskGraphValidator — the off-chain half of the budget pre-flight check.
 * TaskEscrow.settle() re-checks this on-chain too (see
 * SettlementRouter.sol's NatSpec), so a bug here fails safe as an on-chain
 * revert rather than a silent shortfall — but checking here first avoids
 * spending gas on a settlement that was always going to revert.
 */
export function validateTaskGraph(
  netPayouts: bigint[],
  taskBudget: bigint,
  protocolFeeBps: bigint
): ValidationResult {
  if (protocolFeeBps < 0n || protocolFeeBps > 500n) {
    return { ok: false, totalFlow: 0n, protocolFee: 0n, reason: "protocolFeeBps outside the on-chain 0-500 bps range" };
  }

  const totalFlow = netPayouts.reduce((sum, payout) => {
    if (payout <= 0n) {
      throw new Error("validateTaskGraph: netPayouts must all be strictly positive");
    }
    return sum + payout;
  }, 0n);

  const protocolFee = (totalFlow * protocolFeeBps) / 10000n;
  const totalOut = totalFlow + protocolFee;

  if (totalOut > taskBudget) {
    return {
      ok: false,
      totalFlow,
      protocolFee,
      reason: `netPayouts (${totalFlow}) + protocolFee (${protocolFee}) = ${totalOut} exceeds taskBudget (${taskBudget})`,
    };
  }

  return { ok: true, totalFlow, protocolFee };
}
