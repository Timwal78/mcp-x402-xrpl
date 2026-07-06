/**
 * @scriptmasterlabs/mcp-x402
 *
 * ghost-layer-client.ts — real HTTP client for the live Ghost Layer bridge
 * (Go service, `ghost-layer.onrender.com`, source in the SqueezeOS repo under
 * `ghost-layer/`). This module does not reimplement chain-reading logic — it
 * calls Ghost Layer's own endpoints and packages the *real* responses into a
 * typed, verifiable receipt. See ghost-layer/cmd/bridge/main.go for the
 * server-side route definitions this client depends on.
 *
 * Endpoints used (all real, already live):
 *   GET  /health                       — XRPL/Base client liveness
 *   GET  /api/config                   — treasury address, attestation pubkey, product listing
 *   GET  /v1/x402/attestation/pubkey   — Ed25519 public key used to sign decision certificates
 *   POST /v1/notarize                  — mints a Xahau URIToken decision receipt (x402-gated)
 *
 * Notarization pricing note: Ghost Layer's invoice `price_drops` field for
 * RLUSD-priced products is a fixed-point integer at 1,000,000 units per 1.0
 * RLUSD (the same scale XRP itself uses for drops, reused here for RLUSD —
 * see ghost-layer/internal/x402/invoice.go Issue() and the tier comment on
 * the /v1/notarize handler: "decision.notarize 0.001 RLUSD",
 * "decision.notarize.certified 0.010 RLUSD", "decision.notarize.sovereign
 * 0.050 RLUSD"). This client converts price_drops -> decimal RLUSD by
 * dividing by 1_000_000 before handing it to XrplFacilitator, which expects
 * a human-readable RLUSD amount string.
 */

import crypto from "crypto";
import { XrplFacilitator, type PaymentRequirements, type XrplNetwork } from "./xrpl-facilitator.js";

// ─── Types — mirrors of the real Go structs ───────────────────────────────────

export interface GhostLayerStatus {
  status: string;
  xrplClientStatus: unknown;
  baseClientStatus: unknown;
  xrplTreasury: string;
  totalBridges: number;
  x402Compliant: boolean;
  xrplEnabled: boolean;
  baseEnabled: boolean;
  attestationPubkeyHex: string;
  x402Endpoint: string;
  x402Products: unknown;
  fetchedAt: string;
}

export interface GhostLayerAttestationPubkey {
  publicKeyHex: string;
  alg: "ed25519";
  issuer: string;
}

/** Raw shape of Ghost Layer's Invoice struct (ghost-layer/internal/x402/invoice.go) */
interface RawInvoice {
  invoice_id: string;
  product_id: string;
  price_drops: number;
  currency: string;
  destination: string;
  memo_required: string;
  expires_at: number;
  agent_tier: string;
  tier_discount_pct: number;
  token: string;
}

/** Raw shape of Ghost Layer's DecisionCertificate struct (ghost-layer/internal/x402/notary.go) */
interface RawCertificate {
  certificate_id: string;
  nonce: string;
  decision_hash: string;
  xahau_tx: string;
  agent_wallet: string;
  model?: string;
  endpoint?: string;
  agent_tier: string;
  grade: "CERTIFIED" | "SOVEREIGN";
  issued_at: number;
  issuer: string;
  signature_alg: string;
  signature: string;
}

export interface GhostLayerDecisionCertificate {
  certificateId: string;
  nonce: string;
  decisionHash: string;
  xahauTx: string;
  agentWallet: string;
  model?: string;
  endpoint?: string;
  agentTier: string;
  grade: "CERTIFIED" | "SOVEREIGN";
  issuedAt: number;
  issuer: string;
  signatureAlg: string;
  signature: string;
}

export interface GhostLayerNotarizeReceipt {
  status: string;
  grade: "NOTARIZED" | "CERTIFIED" | "SOVEREIGN";
  decisionHash: string;
  xahauTx: string;
  agentWallet: string;
  agentTier: string;
  model?: string;
  endpoint?: string;
  timestamp: string;
  unixTs: number;
  verifyUrl: string;
  certificate?: GhostLayerDecisionCertificate;
}

export type NotarizeProduct = "decision.notarize" | "decision.notarize.certified" | "decision.notarize.sovereign";

export interface NotarizeInput {
  /** The decision/data to notarize. Serialized as-is into the memo. */
  payload: unknown;
  model?: string;
  agentWallet?: string;
  endpoint?: string;
  /** Which notary tier to purchase. Default: "decision.notarize" (cheapest, no certificate). */
  product?: NotarizeProduct;
}

export interface GhostLayerClientOptions {
  /** Ghost Layer base URL. Defaults to the canonical production instance. */
  baseUrl?: string;
  /** XRPL wallet seed used to pay notarize invoices. Required only for notarizeDecision(). */
  walletSeed?: string;
  network?: Extract<XrplNetwork, "xrpl-mainnet" | "xrpl-testnet">;
}

const DEFAULT_BASE_URL = "https://ghost-layer.onrender.com";
const RLUSD_MICRO_UNITS_PER_UNIT = 1_000_000;

// ─── GhostLayerClient ─────────────────────────────────────────────────────────

export class GhostLayerClient {
  private readonly baseUrl: string;
  private readonly facilitator?: XrplFacilitator;

  constructor(opts: GhostLayerClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    if (opts.walletSeed) {
      this.facilitator = new XrplFacilitator({
        walletSeed: opts.walletSeed,
        network: opts.network ?? "xrpl-mainnet",
      });
    }
  }

  /**
   * getStatus() — real, live chain + bridge status from GET /health and
   * GET /api/config. No caching, no synthetic fallback: a fetch failure
   * throws rather than returning fabricated "ok" data.
   */
  async getStatus(): Promise<GhostLayerStatus> {
    const [healthRes, configRes] = await Promise.all([
      fetch(`${this.baseUrl}/health`),
      fetch(`${this.baseUrl}/api/config`),
    ]);

    if (!healthRes.ok) throw new Error(`[ghost-layer-client] GET /health failed: ${healthRes.status}`);
    if (!configRes.ok) throw new Error(`[ghost-layer-client] GET /api/config failed: ${configRes.status}`);

    const health = (await healthRes.json()) as Record<string, unknown>;
    const config = (await configRes.json()) as Record<string, unknown>;

    return {
      status: String(health["status"] ?? "unknown"),
      xrplClientStatus: health["xrpl_client"],
      baseClientStatus: health["base_client"],
      xrplTreasury: String(health["xrpl_treasury"] ?? config["xrpl_treasury"] ?? ""),
      totalBridges: Number(health["total_bridges"] ?? config["total_bridges"] ?? 0),
      x402Compliant: Boolean(config["x402_compliant"]),
      xrplEnabled: Boolean(config["xrpl_enabled"]),
      baseEnabled: Boolean(config["base_enabled"]),
      attestationPubkeyHex: String(config["attestation_pubkey"] ?? ""),
      x402Endpoint: String(config["x402_endpoint"] ?? "/v1/x402"),
      x402Products: config["x402_products"],
      fetchedAt: new Date().toISOString(),
    };
  }

  /** getAttestationPubkey() — GET /v1/x402/attestation/pubkey, used to independently verify certificates. */
  async getAttestationPubkey(): Promise<GhostLayerAttestationPubkey> {
    const res = await fetch(`${this.baseUrl}/v1/x402/attestation/pubkey`);
    if (!res.ok) throw new Error(`[ghost-layer-client] GET /v1/x402/attestation/pubkey failed: ${res.status}`);
    const json = (await res.json()) as { public_key: string; alg: string; issuer: string };
    return { publicKeyHex: json.public_key, alg: "ed25519", issuer: json.issuer };
  }

  /**
   * notarizeDecision() — full pay-then-notarize flow against POST /v1/notarize:
   *   1. POST without a token -> Ghost Layer responds 402 with an Invoice in
   *      the X-Payment-Required header (destination, price, memo_required, token).
   *   2. Pay the invoice on XRPL mainnet with the required memo attached, so
   *      Ghost Layer's ledger watcher can correlate payment to invoice_id.
   *   3. Resubmit with X-Payment-Token: <invoice.token> -> Ghost Layer verifies
   *      the token (HMAC + expiry) and nonce consumption, mints a real Xahau
   *      URIToken via xahauClient.MintURIToken, and returns the receipt.
   *
   * Requires walletSeed to have been passed to the constructor.
   */
  async notarizeDecision(input: NotarizeInput): Promise<GhostLayerNotarizeReceipt> {
    if (!this.facilitator) {
      throw new Error("[ghost-layer-client] notarizeDecision requires walletSeed in GhostLayerClientOptions");
    }

    const requestBody = JSON.stringify({
      payload: input.payload,
      model: input.model,
      agent_wallet: input.agentWallet,
      endpoint: input.endpoint,
    });

    const challenge = await fetch(`${this.baseUrl}/v1/notarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    if (challenge.status !== 402) {
      throw new Error(
        `[ghost-layer-client] expected 402 payment challenge from POST /v1/notarize, got ${challenge.status}`
      );
    }

    const invoiceHeader = challenge.headers.get("x-payment-required");
    if (!invoiceHeader) {
      throw new Error("[ghost-layer-client] 402 response from /v1/notarize is missing X-Payment-Required header");
    }

    const invoice = JSON.parse(invoiceHeader) as RawInvoice;

    if (invoice.currency !== "RLUSD") {
      throw new Error(`[ghost-layer-client] unsupported invoice currency: ${invoice.currency}`);
    }

    const amountRlusd = (invoice.price_drops / RLUSD_MICRO_UNITS_PER_UNIT).toFixed(6);

    const paymentReq: PaymentRequirements = {
      destination: invoice.destination,
      amount: amountRlusd,
      currency: "RLUSD",
      network: "xrpl-mainnet",
      memo: invoice.memo_required,
      expiresAt: new Date(invoice.expires_at * 1000).toISOString(),
      description: `Ghost Layer notarize invoice ${invoice.invoice_id} (${invoice.product_id})`,
    };

    await this.facilitator.pay(paymentReq);

    const settled = await fetch(`${this.baseUrl}/v1/notarize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Token": invoice.token,
      },
      body: requestBody,
    });

    if (!settled.ok) {
      const errBody = await settled.text();
      throw new Error(`[ghost-layer-client] POST /v1/notarize failed after payment: ${settled.status} ${errBody}`);
    }

    const raw = (await settled.json()) as {
      status: string;
      grade: "NOTARIZED" | "CERTIFIED" | "SOVEREIGN";
      decision_hash: string;
      xahau_tx: string;
      agent_wallet: string;
      agent_tier: string;
      model?: string;
      endpoint?: string;
      timestamp: string;
      unix_ts: number;
      verify_url: string;
      certificate?: RawCertificate;
    };

    return {
      status: raw.status,
      grade: raw.grade,
      decisionHash: raw.decision_hash,
      xahauTx: raw.xahau_tx,
      agentWallet: raw.agent_wallet,
      agentTier: raw.agent_tier,
      model: raw.model,
      endpoint: raw.endpoint,
      timestamp: raw.timestamp,
      unixTs: raw.unix_ts,
      verifyUrl: raw.verify_url,
      certificate: raw.certificate ? normalizeCertificate(raw.certificate) : undefined,
    };
  }

  /**
   * verifyCertificate() — independently verifies a DecisionCertificate's
   * Ed25519 signature against Ghost Layer's published attestation pubkey.
   * Reproduces certCanonical() from ghost-layer/internal/x402/notary.go
   * byte-for-byte: each field, newline-separated, in the exact declared
   * order, with Signature excluded.
   */
  static verifyCertificate(cert: GhostLayerDecisionCertificate, attestationPubkeyHex: string): boolean {
    const canonical = certCanonical(cert);
    const publicKey = crypto.createPublicKey({
      key: ed25519SpkiDer(attestationPubkeyHex),
      format: "der",
      type: "spki",
    });
    const signature = Buffer.from(cert.signature, "hex");
    try {
      return crypto.verify(null, canonical, publicKey, signature);
    } catch {
      return false;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeCertificate(raw: RawCertificate): GhostLayerDecisionCertificate {
  return {
    certificateId: raw.certificate_id,
    nonce: raw.nonce,
    decisionHash: raw.decision_hash,
    xahauTx: raw.xahau_tx,
    agentWallet: raw.agent_wallet,
    model: raw.model,
    endpoint: raw.endpoint,
    agentTier: raw.agent_tier,
    grade: raw.grade,
    issuedAt: raw.issued_at,
    issuer: raw.issuer,
    signatureAlg: raw.signature_alg,
    signature: raw.signature,
  };
}

/** Mirrors certCanonical() in ghost-layer/internal/x402/notary.go exactly. */
function certCanonical(c: GhostLayerDecisionCertificate): Buffer {
  const parts = [
    c.certificateId,
    c.nonce,
    c.decisionHash,
    c.xahauTx,
    c.agentWallet,
    c.model ?? "",
    c.endpoint ?? "",
    c.agentTier,
    c.grade,
    String(c.issuedAt),
    c.issuer,
    c.signatureAlg,
  ];
  return Buffer.from(parts.map((p) => `${p}\n`).join(""), "utf8");
}

/**
 * Wraps a raw 32-byte Ed25519 public key in the fixed SPKI DER envelope Node's
 * crypto module requires for import. The 12-byte prefix
 * (302a300506032b6570032100) is the constant ASN.1 header for
 * "Ed25519 public key" — RFC 8410 — independent of the key material itself.
 */
function ed25519SpkiDer(publicKeyHex: string): Buffer {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) {
    throw new Error(`[ghost-layer-client] expected 32-byte Ed25519 public key, got ${raw.length} bytes`);
  }
  return Buffer.concat([prefix, raw]);
}
