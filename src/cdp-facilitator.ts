/**
 * @scriptmasterlabs/mcp-x402-xrpl
 *
 * cdp-facilitator.ts — Coinbase CDP x402 facilitator client (verify + settle).
 *
 * WHY THIS EXISTS: this repo already builds a fully valid, canonical x402
 * `accepts[0]` entry for Base/USDC (x402-middleware.ts's
 * buildCanonicalX402Accepts()) and a Bazaar discovery document
 * (/.well-known/x402 in vending-router-server.ts) — but until now nothing
 * here actually SPOKE the facilitator protocol. Real x402 clients (Coinbase's
 * own x402-fetch SDK, Agentic.Market's client tooling) respond to a 402 by
 * sending a standard `X-PAYMENT` header — a payment AUTHORIZATION for the
 * SERVER to submit via a facilitator, not a pre-executed transaction hash.
 * This codebase only ever read `X-Payment-Proof` / `X-PAYMENT-TX` (a hash the
 * agent already submitted itself), verified via direct on-chain RPC reads
 * (payment-verifier.ts's verifyBaseUsdcPayment()). A standards-compliant
 * client sending `X-PAYMENT` had no code path here that understood it at all.
 *
 * Consequence beyond "the payment fails": Coinbase's Bazaar/Agentic.Market
 * discovery mechanism only indexes a route the first time a REAL settle
 * succeeds through THEIR OWN CDP facilitator, carrying a `bazaar` extensions
 * metadata blob on that /settle call. Direct-RPC verification — however
 * correct — never touches the CDP facilitator, so it can never trigger
 * discovery. This module is what actually closes that gap: it gives the
 * server a real /verify + /settle path against api.cdp.coinbase.com,
 * matching the pattern already shipped and confirmed-in-production in the
 * sibling SqueezeOS Flask API (x402_flask.py), ported here since this
 * codebase is Node/TypeScript rather than Python.
 *
 * Auth: CDP Secret API Keys are Ed25519 (32-byte seed + 32-byte public key,
 * base64-encoded, 64 bytes total) — the JWT is signed EdDSA. Node has no
 * "import raw Ed25519 seed bytes" constructor, so the seed is wrapped in the
 * fixed RFC 8410 PKCS8 DER envelope for Ed25519 before handing it to
 * crypto.createPrivateKey(). Deliberately no new npm dependency (no
 * jsonwebtoken/jose) — Node 22's built-in `crypto` and `Buffer` do the whole
 * JWT (header.payload signature, base64url) by hand, mirroring exactly what
 * x402_flask.py does with PyJWT + `cryptography` on the Python side.
 */

import { createPrivateKey, createPublicKey, sign as cryptoSign, randomBytes, KeyObject } from "node:crypto";

// ── Config ───────────────────────────────────────────────────────────────────

export const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID ?? "";
export const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET ?? "";
export const CDP_CONFIGURED = Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET);

export const X402_NETWORK = (process.env.X402_NETWORK ?? "base").trim().toLowerCase();
export const FACILITATOR_BASE = (
  process.env.X402_FACILITATOR ??
  (CDP_CONFIGURED ? "https://api.cdp.coinbase.com/platform/v2/x402" : "https://x402.org/facilitator")
).replace(/\/$/, "");

const X402_VERSION = 2;

// RFC 8410 PKCS8 DER prefix for a raw Ed25519 private key (16 fixed bytes),
// followed by the 32-byte seed. Same fixed byte sequence every Ed25519 PKCS8
// wrapper uses — not something that can silently drift or need updating.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

let cachedPrivateKey: KeyObject | null = null;

/** Decodes CDP_API_KEY_SECRET (64 bytes: 32-byte seed + 32-byte pubkey),
 * wraps the seed half in PKCS8 DER, and verifies the derived public key
 * matches the embedded pubkey half — the same corruption check the Python
 * sibling (x402_flask.py's _cdp_ed25519_private_key()) performs, so a bad key
 * fails loudly at first use instead of producing silently-invalid JWTs. */
function cdpPrivateKey(): KeyObject {
  if (cachedPrivateKey) return cachedPrivateKey;

  const raw = Buffer.from(CDP_API_KEY_SECRET, "base64");
  if (raw.length !== 64) {
    throw new Error(`CDP_API_KEY_SECRET must decode to 64 bytes, got ${raw.length}`);
  }
  const seed = raw.subarray(0, 32);
  const expectedPub = raw.subarray(32, 64);

  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });

  // Derive the public key from the private key and compare — catches a
  // corrupted/truncated/wrong-format secret before it ever reaches Coinbase.
  // Node's asymmetricKeyDetails doesn't expose the raw point for Ed25519, so
  // derive via the public counterpart's SPKI export instead: fixed 12-byte
  // header followed by the raw 32-byte public key (same fixed-prefix
  // property as the PKCS8 wrapper above).
  const publicSpki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const derivedPub = publicSpki.subarray(publicSpki.length - 32);
  if (!derivedPub.equals(expectedPub)) {
    throw new Error("CDP_API_KEY_SECRET is corrupted — public-key half does not derive from the seed half");
  }

  cachedPrivateKey = privateKey;
  return privateKey;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Builds the Authorization header for a CDP-authenticated facilitator call.
 * Returns {} if CDP creds aren't configured — callers fall back to the
 * unauthenticated public testnet facilitator, same convention as the Python
 * sibling. */
export function cdpAuthHeaders(method: string, host: string, path: string): Record<string, string> {
  if (!CDP_CONFIGURED) return {};

  const privateKey = cdpPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");

  const header = { alg: "EdDSA", kid: CDP_API_KEY_ID, nonce, typ: "JWT" };
  const payload = {
    sub: CDP_API_KEY_ID,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri: `${method} ${host}${path}`,
  };

  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(
    Buffer.from(JSON.stringify(payload))
  )}`;
  // Ed25519 (EdDSA) signs the message directly — no pre-hash algorithm name,
  // per Node's documented convention for this key type.
  const signature = cryptoSign(null, Buffer.from(signingInput), privateKey);

  return { Authorization: `Bearer ${signingInput}.${base64url(signature)}` };
}

// ── Verify + settle ─────────────────────────────────────────────────────────

export interface CdpPaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string; // atomic USDC units (6 decimals), matches buildCanonicalX402Accepts()
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  resource: string;
  description: string;
  mimeType?: string;
}

export interface CdpSettleResult {
  success: boolean;
  payer?: string;
  txHash?: string;
  error?: string;
}

async function facilitatorPost(path: string, body: object): Promise<any> {
  const host = FACILITATOR_BASE.replace(/^https?:\/\//, "").split("/")[0];
  const headers = { "Content-Type": "application/json", ...cdpAuthHeaders("POST", host, path) };
  const res = await fetch(`${FACILITATOR_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { isValid: false, success: false, invalidReason: `facilitator ${res.status}: ${text.slice(0, 200)}` };
  }
}

/**
 * Verifies and settles a standard x402 `X-PAYMENT` payload against Coinbase's
 * CDP facilitator. This is the piece that was entirely missing: real x402
 * clients send this header in response to accepts[0] (already correctly
 * advertised); until this function existed, nothing here could process it.
 *
 * The Bazaar discoverable extension is attached on the /settle call only —
 * same convention as x402_flask.py's _facilitator(): omitting it means a
 * payment could clear on mainnet while the route stays permanently invisible
 * to Agent.market, a second, quieter way to look "paid up" but never surface.
 */
export async function verifyAndSettleViaCdp(
  paymentHeaderB64: string,
  requirements: CdpPaymentRequirements
): Promise<CdpSettleResult> {
  if (!paymentHeaderB64) {
    return { success: false, error: "missing_x_payment_header" };
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeaderB64, "base64").toString("utf8"));
  } catch (e) {
    return { success: false, error: `malformed_x_payment_header: ${(e as Error).message}` };
  }

  const verifyBody = { x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirements };
  const verifyRes = await facilitatorPost("/verify", verifyBody);
  if (!verifyRes?.isValid) {
    return { success: false, error: verifyRes?.invalidReason ?? "verify_failed" };
  }

  const settleBody: Record<string, unknown> = { ...verifyBody };
  settleBody.extensions = {
    bazaar: {
      discoverable: true,
      resource: requirements.resource,
      description: requirements.description,
      outputSchema: { type: "object", properties: {} },
    },
  };
  const settleRes = await facilitatorPost("/settle", settleBody);
  if (!settleRes?.success) {
    return { success: false, error: settleRes?.invalidReason ?? settleRes?.error ?? "settle_failed" };
  }

  return {
    success: true,
    payer: settleRes.payer ?? verifyRes.payer,
    txHash: settleRes.transaction ?? settleRes.txHash,
  };
}
