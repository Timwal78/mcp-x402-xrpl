/**
 * @scriptmasterlabs/mcp-x402
 *
 * x402-middleware.ts — Express-compatible middleware that intercepts HTTP 402
 * Payment Required responses and fulfils them using an XRPL wallet.
 *
 * The middleware sits between the MCP client (AI agent) and any gated MCP
 * tool endpoint. When the upstream server returns 402, it:
 *   1. Parses the X-Payment-Requirements header
 *   2. Checks the idempotency key store — replays cached success if seen before
 *   3. Signs an XRPL / Xahau payment transaction
 *   4. Resubmits the original request with X-Payment-Proof header
 *   5. Passes the 200 response through to the agent
 *
 * Chain support:  XRPL mainnet · XRPL testnet · Xahau mainnet · Xahau testnet
 * Settlement:     XRP (native) · RLUSD (IOU) · XAH (native on Xahau)
 *
 * Agent-native features:
 *   - Idempotency keys (X-Idempotency-Key) — safe retries, no double-charge
 *   - Pre-flight quote endpoint (createQuoteHandler) — exact cost before spend
 *   - Cache-aware 402 metadata (X-402-Cache-TTL, X-402-Discounted-Price)
 *   - Graceful 402 degradation — always includes top-up instructions
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import { XrplFacilitator, PaymentRequirements, PaymentProof } from "./xrpl-facilitator.js";

export type { PaymentRequirements, PaymentProof };

// ─── Idempotency store ────────────────────────────────────────────────────────

interface IdempotencyRecord {
  proof: PaymentProof;
  cachedAt: number;
}

/**
 * In-process idempotency key → PaymentProof cache.
 * TTL defaults to 300s. Replace with Redis in multi-instance deployments.
 */
class IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;

  constructor(ttlSeconds: number = 300) {
    this.ttlMs = ttlSeconds * 1000;
  }

  get(key: string): PaymentProof | undefined {
    const record = this.store.get(key);
    if (!record) return undefined;
    if (Date.now() - record.cachedAt > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return record.proof;
  }

  set(key: string, proof: PaymentProof): void {
    this.store.set(key, { proof, cachedAt: Date.now() });
  }
}

// ─── Middleware options ───────────────────────────────────────────────────────

export interface X402MiddlewareOptions {
  /** XRPL/Xahau wallet seed (family seed format, e.g. "sEdT...") */
  walletSeed: string;
  /** Network to settle on. Defaults to "xrpl-mainnet" */
  network?: "xrpl-mainnet" | "xrpl-testnet" | "xahau-mainnet" | "xahau-testnet";
  /**
   * Maximum amount (in drops for XRP, or string for RLUSD/XAH) the middleware
   * will auto-pay per request. Requests exceeding this are rejected with a
   * structured error containing top-up instructions.
   */
  maxPaymentDrops?: string;
  /**
   * Idempotency key TTL in seconds. Duplicate requests within this window
   * carrying the same X-Idempotency-Key receive the cached proof without
   * a second payment. Default: 300s.
   */
  idempotencyTtlSeconds?: number;
  /** Optional logger. Defaults to console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

// ─── createX402Middleware ─────────────────────────────────────────────────────

/**
 * Factory — returns an Express-compatible middleware function.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createX402Middleware } from "@scriptmasterlabs/mcp-x402";
 *
 * const app = express();
 * app.use(createX402Middleware({
 *   walletSeed: process.env.XRPL_WALLET_SEED!,
 *   network: "xrpl-mainnet",
 *   maxPaymentDrops: "1000000", // 1 XRP cap per tool call
 * }));
 * ```
 */
export function createX402Middleware(opts: X402MiddlewareOptions): RequestHandler {
  const log = opts.logger ?? console;
  const facilitator = new XrplFacilitator({
    walletSeed: opts.walletSeed,
    network: opts.network ?? "xrpl-mainnet",
  });
  const idempotencyStore = new IdempotencyStore(opts.idempotencyTtlSeconds ?? 300);

  return async function x402Middleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const paymentRequirementsHeader = req.headers["x-payment-requirements"] as string | undefined;

    if (!paymentRequirementsHeader) {
      next();
      return;
    }

    let requirements: PaymentRequirements;
    try {
      requirements = JSON.parse(
        Buffer.from(paymentRequirementsHeader, "base64").toString("utf8")
      ) as PaymentRequirements;
    } catch {
      log.error("[mcp-x402] Failed to parse X-Payment-Requirements header");
      res.status(400).json({ error: "malformed_payment_requirements" });
      return;
    }

    // ── Idempotency check ─────────────────────────────────────────────────
    const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;
    if (idempotencyKey) {
      const cached = idempotencyStore.get(idempotencyKey);
      if (cached) {
        log.log(`[mcp-x402] Idempotency hit — replaying proof for key: ${idempotencyKey}`);
        req.headers["x-payment-proof"] = Buffer.from(JSON.stringify(cached)).toString("base64");
        delete req.headers["x-payment-requirements"];
        res.setHeader("X-Idempotency-Replayed", "true");
        res.setHeader("X-Idempotency-Key", idempotencyKey);
        next();
        return;
      }
    }

    // ── Safety cap check ──────────────────────────────────────────────────
    if (
      opts.maxPaymentDrops &&
      requirements.amountDrops &&
      BigInt(requirements.amountDrops) > BigInt(opts.maxPaymentDrops)
    ) {
      log.warn(
        `[mcp-x402] Payment request (${requirements.amountDrops} drops) exceeds maxPaymentDrops cap`
      );
      res.status(402).json({
        error: "payment_exceeds_cap",
        requirements,
        maxAllowed: opts.maxPaymentDrops,
        topUpInstructions: "Increase maxPaymentDrops in middleware config, or fund a higher-cap wallet.",
      });
      return;
    }

    // ── Expiry guard ──────────────────────────────────────────────────────
    if (requirements.expiresAt && new Date(requirements.expiresAt) < new Date()) {
      res.status(402).json({
        error: "payment_requirements_expired",
        expiredAt: requirements.expiresAt,
        instructions: "Retry the original request to receive a fresh payment challenge.",
      });
      return;
    }

    // ── Settle payment ────────────────────────────────────────────────────
    try {
      log.log(
        `[mcp-x402] Fulfilling x402: ${requirements.amountDrops ?? requirements.amount} ${requirements.currency ?? "XRP"} → ${requirements.destination}`
      );
      const proof = await facilitator.pay(requirements);
      log.log(`[mcp-x402] Settled. TxHash: ${proof.txHash}`);

      if (idempotencyKey) {
        idempotencyStore.set(idempotencyKey, proof);
        res.setHeader("X-Idempotency-Key", idempotencyKey);
      }

      req.headers["x-payment-proof"] = Buffer.from(JSON.stringify(proof)).toString("base64");
      delete req.headers["x-payment-requirements"];
      next();
    } catch (err) {
      log.error("[mcp-x402] Payment failed:", err);
      res.status(402).json({
        error: "payment_failed",
        details: String(err),
        requirements,
        topUpInstructions: {
          network: requirements.network ?? "xrpl-mainnet",
          destination: requirements.destination,
          amount: requirements.amountDrops ?? requirements.amount,
          currency: requirements.currency ?? "XRP",
          topUpUrl: "https://www.scriptmasterlabs.com/central-bank.html",
          note: "Ensure wallet is funded and destination address is correct before retrying.",
        },
      });
    }
  };
}

// ─── PaymentGateOptions ───────────────────────────────────────────────────────

export interface PaymentGateOptions {
  /** Amount in drops (1 XRP = 1,000,000 drops) for XRP payments */
  amountDrops?: string;
  /** For RLUSD or XAH: human-readable amount string e.g. "0.10" */
  amount?: string;
  /** Currency code. "XRP" | "RLUSD" | "XAH". Defaults to "XRP" */
  currency?: "XRP" | "RLUSD" | "XAH";
  /** Your XRPL receiving address */
  destination: string;
  /** Optional destination tag */
  destinationTag?: number;
  /** Description shown to the paying agent */
  description?: string;
  /**
   * Cache config. When the data behind this endpoint has a known refresh TTL,
   * expose it so agents can choose a stale-data discount intelligently.
   */
  cacheConfig?: {
    ttlSeconds: number;
    discountedAmount?: string;
  };
  /** Top-up page URL. Shown in 402 body for self-healing agents. */
  topUpUrl?: string;
}

// ─── createPaymentGate ────────────────────────────────────────────────────────

/**
 * Wraps a route handler so callers without a valid X-Payment-Proof header
 * receive a 402 challenge with full agent-native metadata.
 */
export function createPaymentGate(opts: PaymentGateOptions): RequestHandler {
  return function paymentGate(req: Request, res: Response, next: NextFunction): void {
    const proofHeader = req.headers["x-payment-proof"] as string | undefined;
    if (proofHeader) {
      next();
      return;
    }

    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const requirements: PaymentRequirements = {
      destination: opts.destination,
      destinationTag: opts.destinationTag,
      amountDrops: opts.amountDrops,
      amount: opts.amount,
      currency: opts.currency ?? "XRP",
      network: "xrpl-mainnet",
      description: opts.description ?? "Payment required for MCP tool access",
      expiresAt,
    };

    const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");

    const body: Record<string, unknown> = {
      error: "payment_required",
      protocol: "x402",
      network: "xrpl-mainnet",
      requirements,
      idempotencyKeyHeader: "X-Idempotency-Key",
      idempotencyNote: "Include a unique X-Idempotency-Key to prevent double-charges on retry.",
      topUpInstructions: {
        network: "xrpl-mainnet",
        destination: opts.destination,
        amount: opts.amountDrops ?? opts.amount,
        currency: opts.currency ?? "XRP",
        topUpUrl: opts.topUpUrl ?? "https://www.scriptmasterlabs.com/central-bank.html",
        note: "Fund your XRPL wallet with RLUSD, then retry with X-Payment-Proof header.",
      },
      paymentInstructions: "Attach X-Payment-Proof header with base64-encoded XRPL tx proof to retry.",
    };

    if (opts.cacheConfig) {
      res.setHeader("X-402-Cache-TTL", String(opts.cacheConfig.ttlSeconds));
      if (opts.cacheConfig.discountedAmount) {
        res.setHeader("X-402-Discounted-Price", opts.cacheConfig.discountedAmount);
        body.cacheDiscount = {
          note: `Cached data available (TTL: ${opts.cacheConfig.ttlSeconds}s). Pay ${opts.cacheConfig.discountedAmount} ${opts.currency ?? "XRP"} for the cached version.`,
          discountedAmount: opts.cacheConfig.discountedAmount,
          fullAmount: opts.amount ?? opts.amountDrops,
          cacheTtlSeconds: opts.cacheConfig.ttlSeconds,
        };
      }
    }

    res
      .status(402)
      .setHeader("X-Payment-Requirements", encoded)
      .setHeader("X-402-Protocol", "x402/1.0")
      .setHeader("X-402-Network", "xrpl-mainnet")
      .setHeader("X-402-Currency", opts.currency ?? "XRP")
      .json(body);
  };
}

// ─── Quote handler ────────────────────────────────────────────────────────────

export interface QuoteToolSpec {
  amount: string;
  currency: "RLUSD" | "USDC" | "XRP";
  network: string;
  vipAmount?: string;
  platinumAmount?: string;
}

export interface QuoteConfig {
  /** Map of tool id → pricing spec. Populated from ToolCatalog. */
  tools: Record<string, QuoteToolSpec>;
  /** Receiving address for the quote destination field */
  destination: string;
  /** Called with agentDid to look up their ARGUS credit score */
  getAgentScore?: (agentDid: string) => Promise<number>;
}

/**
 * createQuoteHandler — RequestHandler for GET /x402/quote
 *
 * Agents call this before spending funds to get exact cost for their tier,
 * upstream liveness, and a 60-second quote window with a unique quote ID.
 *
 * @example
 * ```ts
 * app.get("/x402/quote", createQuoteHandler({ tools: pricingMap, destination: addr, getAgentScore }));
 * ```
 */
export function createQuoteHandler(config: QuoteConfig): RequestHandler {
  return async function quoteHandler(req: Request, res: Response): Promise<void> {
    const toolId = req.query["tool"] as string | undefined;

    if (!toolId || !config.tools[toolId]) {
      res.status(400).json({
        error: "unknown_tool",
        message: `Unknown tool: ${toolId ?? "(none)"}. Check /.well-known/mcp for valid tool IDs.`,
        availableTools: Object.keys(config.tools),
      });
      return;
    }

    const tool = config.tools[toolId];
    const agentDid = (req.headers["x-agent-did"] as string | undefined) ?? "did:anonymous";
    let agentScore = 300;

    if (config.getAgentScore) {
      try {
        agentScore = await config.getAgentScore(agentDid);
      } catch {
        // Non-fatal — use default score of 300
      }
    }

    let effectiveAmount = tool.amount;
    if (agentScore >= 800 && tool.platinumAmount) {
      effectiveAmount = tool.platinumAmount;
    } else if (agentScore >= 700 && tool.vipAmount) {
      effectiveAmount = tool.vipAmount;
    }

    const quoteId = `qte_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    res
      .setHeader("X-402-Quote-ID", quoteId)
      .setHeader("X-402-Quote-Expires", expiresAt)
      .json({
        quoteId,
        tool: toolId,
        agentDid,
        agentScore,
        effectiveAmount,
        currency: tool.currency,
        network: tool.network,
        destination: config.destination,
        expiresAt,
        idempotencyKeyHeader: "X-Idempotency-Key",
        note: "Send payment with X-Idempotency-Key header to prevent double-charges on retry.",
        paymentFlow: [
          `1. Fund XRPL wallet with ${effectiveAmount} ${tool.currency}`,
          `2. POST to tool endpoint with X-Idempotency-Key: <unique-key>`,
          `3. On 402, pay ${effectiveAmount} ${tool.currency} to ${config.destination} on ${tool.network}`,
          "4. Retry with X-Payment-Proof: <base64-encoded-txproof>",
        ],
      });
  };
}
