/**
 * @scriptmasterlabs/mcp-x402
 *
 * payment-verifier.ts — On-chain payment verification, XRPL/RLUSD + Base/USDC
 *
 * This used to be XRPL-only despite Base/USDC being advertised everywhere
 * (sml_discover lists "base (USDC — preferred, <3s)" first) — any agent that
 * paid in USDC on Base had a payment that succeeded on-chain but could never
 * be verified, because verifyRlusdPayment rejected non-XRPL proofs and the
 * server had no Base verification path at all. verifyPayment() below is the
 * single entry point now: it looks at whether txHash has a "0x" prefix (EVM
 * convention; XRPL hashes never do) and dispatches to the matching verifier.
 *
 * XRPL path — decodes X-Payment-Proof, fetches the XRPL transaction, verifies:
 *   - TransactionResult == tesSUCCESS
 *   - Destination == expected receiving address
 *   - Currency == RLUSD (hex or string form)
 *   - Issuer == canonical RLUSD issuer on XRPL mainnet
 *   - Amount >= expected amount
 *   - txHash not already used (replay prevention via Redis, 24 h window)
 * Falls back across three XRPL cluster nodes before returning failure.
 *
 * Base path — fetches the transaction receipt via public Base RPC, verifies:
 *   - receipt.status == success
 *   - a USDC Transfer log exists with `to` == expected receiving address
 *   - transferred amount (6 decimals) >= expected amount
 *   - txHash not already used (replay prevention via Redis, 24 h window)
 * Falls back across public Base RPC nodes before returning failure.
 */

import { Client, convertStringToHex } from "xrpl";
import type Redis from "ioredis";

// ─── Constants ────────────────────────────────────────────────────────────────

export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = convertStringToHex("RLUSD").padEnd(40, "0").toUpperCase();

const XRPL_NODES = [
  "wss://xrplcluster.com",
  "wss://s1.ripple.com",
  "wss://s2.ripple.com",
];

// Canonical native USDC contract on Base mainnet.
export const USDC_BASE_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event topic0
const ERC20_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const BASE_RPC_NODES = [
  "https://mainnet.base.org",
  "https://base.publicnode.com",
  "https://base-rpc.publicnode.com",
];

const PROOF_REPLAY_TTL_SECONDS = 86_400; // 24 h

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaymentProofClaim {
  txHash: string;
  payer?: string;
  amount?: string;
  currency?: string;
  network?: string;
}

export interface VerificationResult {
  valid: boolean;
  /** Set when valid === false */
  error?: string;
  /** On-chain payer wallet address (Account field) */
  payer?: string;
  /** Actual RLUSD amount paid (string, e.g. "0.10") */
  amount?: string;
  /** Canonical uppercase txHash */
  txHash?: string;
}

// ─── verifyRlusdPayment ───────────────────────────────────────────────────────

/**
 * Verify that a base64-encoded X-Payment-Proof header represents a valid,
 * unspent RLUSD payment on XRPL mainnet to the expected destination.
 *
 * On success: marks the txHash as used in Redis (prevents replay).
 * On failure: returns { valid: false, error: "<reason>" }.
 *
 * @param proofHeader    Raw value of X-Payment-Proof header (base64 JSON)
 * @param expectedDest   XRPL address that must appear as Destination
 * @param expectedAmount Minimum RLUSD amount required (e.g. "0.10")
 * @param redis          Ioredis client for replay prevention
 */
export async function verifyRlusdPayment(
  proofHeader: string,
  expectedDest: string,
  expectedAmount: string,
  redis: Redis,
): Promise<VerificationResult> {
  // ── 1. Decode and parse proof ───────────────────────────────────────────
  let claim: PaymentProofClaim;
  try {
    const raw = Buffer.from(proofHeader, "base64").toString("utf8");
    claim = JSON.parse(raw) as PaymentProofClaim;
  } catch {
    return { valid: false, error: "invalid_proof_encoding: cannot base64-decode or parse proof JSON" };
  }

  if (!claim.txHash || typeof claim.txHash !== "string") {
    return { valid: false, error: "invalid_proof: missing txHash field" };
  }

  const txHash = claim.txHash.toUpperCase().replace(/^0X/i, "");
  if (!/^[0-9A-F]{64}$/.test(txHash)) {
    return { valid: false, error: `invalid_proof: txHash must be 64 hex chars, got ${txHash.length} chars` };
  }

  // ── 2. Replay prevention — Redis check before hitting XRPL ─────────────
  // Fails OPEN on Redis errors: enableOfflineQueue:false means a Redis blip
  // rejects immediately rather than hanging, and with no global Express
  // error handler an uncaught rejection here would hang the request forever
  // (indistinguishable from a dead server to the paying agent). A brief
  // Redis outage should degrade replay-prevention, not block payment.
  const replayKey = `bureau:proof:${txHash}`;
  let alreadyUsed = 0;
  try {
    alreadyUsed = await redis.exists(replayKey);
  } catch (err) {
    console.error(`[payment-verifier] Redis replay-check failed, failing open: ${String(err)}`);
  }
  if (alreadyUsed) {
    return { valid: false, error: "proof_replayed: this txHash has already been used for payment" };
  }

  // ── 3. Verify on-chain (try nodes in order) ─────────────────────────────
  let lastError = "xrpl_unreachable: all cluster nodes failed";

  for (const wsUrl of XRPL_NODES) {
    const client = new Client(wsUrl);
    try {
      await client.connect();

      let txResponse: Awaited<ReturnType<typeof client.request>>;
      try {
        txResponse = await client.request({ command: "tx", transaction: txHash });
      } catch (rpcErr) {
        lastError = `xrpl_rpc_error on ${wsUrl}: ${String(rpcErr)}`;
        continue;
      }

      const tx = (txResponse as unknown as { result: Record<string, unknown> }).result;

      // ── 4. Check tesSUCCESS ─────────────────────────────────────────────
      const meta = tx["meta"] as Record<string, unknown> | undefined;
      const txResult = String(meta?.["TransactionResult"] ?? "unknown");
      if (txResult !== "tesSUCCESS") {
        return { valid: false, error: `tx_failed: TransactionResult=${txResult}` };
      }

      // ── 5. Check destination ────────────────────────────────────────────
      const onChainDest = String(tx["Destination"] ?? "");
      if (onChainDest !== expectedDest) {
        return {
          valid: false,
          error: `wrong_destination: tx sent to ${onChainDest}, expected ${expectedDest}`,
        };
      }

      // ── 6. Check currency, issuer, amount ───────────────────────────────
      const amount = tx["Amount"] as Record<string, string> | string | undefined;

      if (typeof amount !== "object" || amount === null) {
        return { valid: false, error: "wrong_currency: payment is XRP drops, not RLUSD IOU" };
      }

      const currencyField = String(amount["currency"] ?? "").toUpperCase();
      const isRlusd = currencyField === RLUSD_HEX || currencyField === "RLUSD";
      if (!isRlusd) {
        return { valid: false, error: `wrong_currency: expected RLUSD (${RLUSD_HEX}), got ${currencyField}` };
      }

      const onChainIssuer = String(amount["issuer"] ?? "");
      if (onChainIssuer !== RLUSD_ISSUER) {
        return { valid: false, error: `wrong_issuer: expected ${RLUSD_ISSUER}, got ${onChainIssuer}` };
      }

      const paidAmount = parseFloat(String(amount["value"] ?? "0"));
      const requiredAmount = parseFloat(expectedAmount);
      if (Number.isNaN(paidAmount) || paidAmount < requiredAmount) {
        return {
          valid: false,
          error: `insufficient_amount: paid ${paidAmount} RLUSD, required ${requiredAmount} RLUSD`,
        };
      }

      const onChainPayer = String(tx["Account"] ?? "");

      // ── 7. Mark txHash as used (replay prevention) ──────────────────────
      // Best-effort: a write failure here shouldn't fail a payment that
      // already verified successfully on-chain.
      try {
        await redis.set(replayKey, onChainPayer, "EX", PROOF_REPLAY_TTL_SECONDS);
      } catch (err) {
        console.error(`[payment-verifier] Redis replay-write failed (payment still valid): ${String(err)}`);
      }

      return {
        valid: true,
        payer: onChainPayer,
        amount: String(amount["value"]),
        txHash,
      };
    } catch (err) {
      lastError = `node_error on ${wsUrl}: ${String(err)}`;
    } finally {
      try { await client.disconnect(); } catch { /* ignore disconnect errors */ }
    }
  }

  return { valid: false, error: lastError };
}

// ─── verifyBaseUsdcPayment ─────────────────────────────────────────────────────

async function baseRpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/**
 * Verify that a base64-encoded X-Payment-Proof header represents a valid,
 * unspent USDC payment on Base mainnet to the expected destination.
 *
 * On success: marks the txHash as used in Redis (prevents replay).
 * On failure: returns { valid: false, error: "<reason>" }.
 *
 * @param proofHeader    Raw value of X-Payment-Proof header (base64 JSON)
 * @param expectedDest   Base (0x...) address that must appear as a USDC Transfer recipient
 * @param expectedAmount Minimum USDC amount required (e.g. "0.10")
 * @param redis          Ioredis client for replay prevention
 */
export async function verifyBaseUsdcPayment(
  proofHeader: string,
  expectedDest: string,
  expectedAmount: string,
  redis: Redis,
): Promise<VerificationResult> {
  let claim: PaymentProofClaim;
  try {
    const raw = Buffer.from(proofHeader, "base64").toString("utf8");
    claim = JSON.parse(raw) as PaymentProofClaim;
  } catch {
    return { valid: false, error: "invalid_proof_encoding: cannot base64-decode or parse proof JSON" };
  }

  if (!claim.txHash || typeof claim.txHash !== "string") {
    return { valid: false, error: "invalid_proof: missing txHash field" };
  }

  const txHash = claim.txHash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    return { valid: false, error: `invalid_proof: not a valid Base/EVM tx hash: ${claim.txHash}` };
  }

  const replayKey = `bureau:proof:base:${txHash}`;
  let alreadyUsed = 0;
  try {
    alreadyUsed = await redis.exists(replayKey);
  } catch (err) {
    console.error(`[payment-verifier] Redis replay-check failed, failing open: ${String(err)}`);
  }
  if (alreadyUsed) {
    return { valid: false, error: "proof_replayed: this txHash has already been used for payment" };
  }

  const destLower = expectedDest.toLowerCase();
  let lastError = "base_rpc_unreachable: all Base RPC nodes failed";

  for (const url of BASE_RPC_NODES) {
    try {
      const receipt = await baseRpcCall(url, "eth_getTransactionReceipt", [txHash]) as
        | { status?: string; logs?: Array<{ address: string; topics: string[]; data: string }> }
        | null;

      if (!receipt) {
        lastError = `tx_not_found: ${txHash} not found on Base (via ${url})`;
        continue;
      }

      if (receipt.status !== "0x1") {
        return { valid: false, error: `tx_failed: Base tx status=${receipt.status ?? "unknown"}` };
      }

      let totalTransferred = 0n;
      let payer = "";

      for (const log of receipt.logs ?? []) {
        if (String(log.address).toLowerCase() !== USDC_BASE_CONTRACT.toLowerCase()) continue;
        if (!Array.isArray(log.topics) || log.topics[0] !== ERC20_TRANSFER_TOPIC0) continue;
        if (log.topics.length < 3) continue;

        const toAddr = `0x${String(log.topics[2]).slice(-40)}`;
        if (toAddr.toLowerCase() !== destLower) continue;

        const fromAddr = `0x${String(log.topics[1]).slice(-40)}`;
        totalTransferred += BigInt(log.data);
        payer = fromAddr;
      }

      if (totalTransferred === 0n) {
        return {
          valid: false,
          error: `wrong_destination_or_currency: no USDC Transfer to ${expectedDest} found in tx ${txHash}`,
        };
      }

      const paidAmount = Number(totalTransferred) / 1_000_000; // USDC has 6 decimals
      const requiredAmount = parseFloat(expectedAmount);
      if (Number.isNaN(paidAmount) || paidAmount < requiredAmount) {
        return {
          valid: false,
          error: `insufficient_amount: paid ${paidAmount} USDC, required ${requiredAmount} USDC`,
        };
      }

      try {
        await redis.set(replayKey, payer, "EX", PROOF_REPLAY_TTL_SECONDS);
      } catch (err) {
        console.error(`[payment-verifier] Redis replay-write failed (payment still valid): ${String(err)}`);
      }

      return { valid: true, payer, amount: paidAmount.toFixed(6), txHash };
    } catch (err) {
      lastError = `base_rpc_error on ${url}: ${String(err)}`;
    }
  }

  return { valid: false, error: lastError };
}

// ─── verifyPayment ──────────────────────────────────────────────────────────────

/**
 * Single entry point — dispatches to the XRPL or Base verifier based on the
 * proof's txHash format. EVM/Base tx hashes are always "0x" + 64 hex chars;
 * XRPL tx hashes never carry a "0x" prefix. This is checked on the raw,
 * undecoded hash before either verifier's own normalization runs.
 */
export async function verifyPayment(
  proofHeader: string,
  destinations: { xrpl: string; base: string },
  expectedAmount: string,
  redis: Redis,
): Promise<VerificationResult> {
  const claim = decodeProofHeader(proofHeader);
  if (!claim || !claim.txHash || typeof claim.txHash !== "string") {
    return { valid: false, error: "invalid_proof: missing or unparseable txHash field" };
  }

  const isEvmHash = /^0x[0-9a-fA-F]{64}$/.test(claim.txHash);
  if (isEvmHash) {
    return verifyBaseUsdcPayment(proofHeader, destinations.base, expectedAmount, redis);
  }
  return verifyRlusdPayment(proofHeader, destinations.xrpl, expectedAmount, redis);
}

// ─── decodeProofHeader ────────────────────────────────────────────────────────

/**
 * Decode the raw X-Payment-Proof base64 header into a PaymentProofClaim.
 * Returns null if the header is absent, malformed, or not base64 JSON.
 * Safe to call before full verification.
 */
export function decodeProofHeader(header: string | undefined): PaymentProofClaim | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentProofClaim;
  } catch {
    return null;
  }
}
