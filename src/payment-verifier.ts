/**
 * @scriptmasterlabs/mcp-x402
 *
 * payment-verifier.ts — On-chain RLUSD payment verification
 *
 * Decodes X-Payment-Proof, fetches the XRPL transaction, verifies:
 *   - TransactionResult == tesSUCCESS
 *   - Destination == expected receiving address
 *   - Currency == RLUSD (hex or string form)
 *   - Issuer == canonical RLUSD issuer on XRPL mainnet
 *   - Amount >= expected amount
 *   - txHash not already used (replay prevention via Redis, 24 h window)
 *
 * Falls back across three XRPL cluster nodes before returning failure.
 */

import { Client, convertStringToHex } from "xrpl";
import type Redis from "ioredis";

// ─── Constants ────────────────────────────────────────────────────────────────

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = convertStringToHex("RLUSD").padEnd(40, "0").toUpperCase();

const XRPL_NODES = [
  "wss://xrplcluster.com",
  "wss://s1.ripple.com",
  "wss://s2.ripple.com",
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
  const replayKey = `bureau:proof:${txHash}`;
  const alreadyUsed = await redis.exists(replayKey);
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

      const tx = txResponse.result as Record<string, unknown>;

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
      await redis.set(replayKey, onChainPayer, "EX", PROOF_REPLAY_TTL_SECONDS);

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
