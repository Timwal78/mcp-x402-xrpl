/**
 * @scriptmasterlabs/mcp-x402
 *
 * x402-middleware.ts — Express/Fastify-compatible middleware that intercepts
 * HTTP 402 Payment Required responses and fulfils them using an XRPL wallet.
 *
 * The middleware sits between the MCP client (AI agent) and any gated
 * MCP tool endpoint. When the upstream server returns 402, it:
 *   1. Parses the X-Payment-Requirements header
 *   2. Signs an XRPL / Xahau payment transaction
 *   3. Resubmits the original request with X-Payment proof header
 *   4. Passes the 200 response through to the agent
 *
 * Chain support:  XRPL mainnet · XRPL testnet · Xahau mainnet · Xahau testnet
 * Settlement:     XRP (native) · RLUSD (IOU) · XAH (native on Xahau)
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import { XrplFacilitator, PaymentRequirements, PaymentProof } from "./xrpl-facilitator.js";

export interface X402MiddlewareOptions {
  /** XRPL/Xahau wallet seed (family seed format, e.g. "sEdT...") */
  walletSeed: string;
  /** Network to settle on. Defaults to "xrpl-mainnet" */
  network?: "xrpl-mainnet" | "xrpl-testnet" | "xahau-mainnet" | "xahau-testnet";
  /** Maximum amount (in drops for XRP, or string for RLUSD/XAH) the middleware
   *  will auto-pay per request. Requests exceeding this are rejected. */
  maxPaymentDrops?: string;
  /** Optional logger. Defaults to console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export type { PaymentRequirements, PaymentProof };

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

  return async function x402Middleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Intercept only if the upstream already returned 402.
    // In proxy mode, call next() — the wrapper handles intercept.
    // In direct mode, the payment gate checks the header before calling next().
    const paymentRequirementsHeader = req.headers["x-payment-requirements"] as string | undefined;

    if (!paymentRequirementsHeader) {
      // No payment challenge — pass through
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

    // Safety cap check
    if (opts.maxPaymentDrops && BigInt(requirements.amountDrops ?? "0") > BigInt(opts.maxPaymentDrops)) {
      log.warn(`[mcp-x402] Payment request (${requirements.amountDrops} drops) exceeds maxPaymentDrops cap`);
      res.status(402).json({ error: "payment_exceeds_cap", requirements });
      return;
    }

    try {
      log.log(`[mcp-x402] Fulfilling x402 payment: ${requirements.amountDrops} drops → ${requirements.destination}`);
      const proof = await facilitator.pay(requirements);
      log.log(`[mcp-x402] Payment settled. TxHash: ${proof.txHash}`);

      // Attach proof header and allow the MCP server to verify
      req.headers["x-payment-proof"] = Buffer.from(JSON.stringify(proof)).toString("base64");
      // Clear the requirements header so the server doesn't loop
      delete req.headers["x-payment-requirements"];

      next();
    } catch (err) {
      log.error("[mcp-x402] Payment failed:", err);
      res.status(402).json({ error: "payment_failed", details: String(err) });
    }
  };
}

/**
 * createPaymentGate — wraps a route handler so that callers without a valid
 * X-Payment-Proof header receive a 402 challenge automatically.
 *
 * @example
 * ```ts
 * app.post(
 *   "/tools/premium-query",
 *   createPaymentGate({ amountDrops: "100000", currency: "XRP" }),
 *   myToolHandler
 * );
 * ```
 */
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
}

export function createPaymentGate(opts: PaymentGateOptions): RequestHandler {
  return function paymentGate(req: Request, res: Response, next: NextFunction): void {
    const proofHeader = req.headers["x-payment-proof"] as string | undefined;

    if (proofHeader) {
      // Proof attached — let the facilitator verify downstream, pass through
      next();
      return;
    }

    // No proof — issue the 402 challenge
    const requirements: PaymentRequirements = {
      destination: opts.destination,
      destinationTag: opts.destinationTag,
      amountDrops: opts.amountDrops,
      amount: opts.amount,
      currency: opts.currency ?? "XRP",
      network: "xrpl-mainnet",
      description: opts.description ?? "Payment required for MCP tool access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), // 60-second window
    };

    const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");

    res
      .status(402)
      .setHeader("X-Payment-Requirements", encoded)
      .json({
        error: "payment_required",
        protocol: "x402",
        network: "xrpl",
        requirements,
        paymentInstructions: "Attach X-Payment-Proof header with base64-encoded XRPL tx proof to retry.",
      });
  };
}
