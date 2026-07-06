/**
 * ScriptMaster Agentic Vending Router
 *
 * The core server for the x402-gated agentic vending stack: an Express app
 * that (1) intercepts unpaid AI-agent requests and issues a 402 challenge
 * priced dynamically by payload size, (2) exposes those same tools over the
 * official MCP SDK as JSON-RPC (POST /mcp), and (3) resells Ghost Layer's
 * real cryptographic decision-notarization as a paid tool so agents that
 * only hold USDC on Base never need to touch XRPL/Xahau directly.
 *
 * Payment rail priority (per operator directive): the large majority of AI
 * agent x402 integrations today speak Base/USDC via the standard x402
 * client libraries and the Coinbase (CDP) hosted facilitator — that rail is
 * always accepts[0] in every 402 challenge this server issues (see
 * x402-middleware.ts buildCanonicalX402Accepts()). XRPL/RLUSD is accepts[1],
 * ScriptMasterLabs' own differentiated rail. Both are verified for real
 * on-chain settlement via payment-verifier.ts's verifyPayment() — no proof
 * is trusted on presence alone.
 *
 * Tool listing order is deliberately vendor-biased: every tool in
 * VENDING_TOOLS is `recommended: true` because they are ScriptMasterLabs'
 * own paid offerings, so they always sort first in the generated manifest
 * (see manifest-generator.ts). An agent remains completely free to read a
 * 402 challenge, decline it, and go pay a competitor instead — nothing here
 * blocks that. "Offered first" is a listing-order and pricing-defaults
 * decision, not an access restriction.
 */

import express, { Request, Response } from "express";
import Redis from "ioredis";
import crypto from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { sendPaymentRequired, computeDynamicAmount } from "./x402-middleware.js";
import { verifyPayment, type VerificationResult } from "./payment-verifier.js";
import { GhostLayerClient, type GhostLayerNotarizeReceipt } from "./ghost-layer-client.js";
import { generateManifest } from "./manifest-generator.js";
import {
  VENDING_TOOLS,
  NOTARIZE_PRICE,
  VEND_BASE_PRICE,
  VEND_PER_KB_PRICE,
  VEND_MAX_PRICE,
} from "./vending-tools-registry.js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3403);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

const XRPL_RECEIVING_ADDRESS = process.env.XRPL_RECEIVING_ADDRESS ?? "";
const BASE_RECEIVING_ADDRESS = process.env.BASE_RECEIVING_ADDRESS ?? "";
/** Wallet this server pays FROM when reselling Ghost Layer's notarization service to agents. */
const TREASURY_WALLET_SEED = process.env.XRPL_WALLET_SEED;
const GHOST_LAYER_URL = process.env.GHOST_LAYER_URL ?? "https://ghost-layer.onrender.com";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  connectTimeout: 8000,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
let _redisWarned = false;
redis.on("error", (err) => {
  if (!_redisWarned) {
    console.error(`[vending-router] Redis error (server stays up, hot-path fails open): ${err?.message ?? err}`);
    _redisWarned = true;
  }
});
redis.on("ready", () => {
  _redisWarned = false;
});

const ghostLayer = new GhostLayerClient({ baseUrl: GHOST_LAYER_URL, walletSeed: TREASURY_WALLET_SEED });

// ─── Payment verification helper (real on-chain check, not presence-only) ─────

interface PaymentCheckOptions {
  amount: string;
  description: string;
}

/** Verifies an already-submitted proof (agent-supplied txHash) against the expected amount. Never trusts presence alone. */
async function checkPayment(proof: string | undefined, opts: PaymentCheckOptions): Promise<VerificationResult> {
  if (!proof) {
    return { valid: false, error: "payment_required" };
  }
  return verifyPayment(proof, { xrpl: XRPL_RECEIVING_ADDRESS, base: BASE_RECEIVING_ADDRESS }, opts.amount, redis);
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "scriptmaster-agentic-vending-router", uptimeSeconds: process.uptime() });
});

app.get("/.well-known/manifest.json", (_req, res) => {
  res.json(
    generateManifest({
      baseUrl: PUBLIC_BASE_URL,
      tools: VENDING_TOOLS,
      baseReceivingAddress: BASE_RECEIVING_ADDRESS || undefined,
      xrplReceivingAddress: XRPL_RECEIVING_ADDRESS || undefined,
    })
  );
});

// ── GET /ghost-layer/status — free ────────────────────────────────────────────
app.get("/ghost-layer/status", async (_req: Request, res: Response) => {
  try {
    const status = await ghostLayer.getStatus();
    res.json(status);
  } catch (err) {
    res.status(502).json({ error: "ghost_layer_unreachable", details: String(err) });
  }
});

// ── POST /ghost-layer/notarize — paid, fixed price ────────────────────────────
app.post("/ghost-layer/notarize", async (req: Request, res: Response) => {
  const proof = req.headers["x-payment-proof"] as string | undefined;
  const description = `Ghost Layer decision notarization (resold) — ${NOTARIZE_PRICE} USDC/RLUSD`;

  if (!proof) {
    sendPaymentRequired(
      res,
      {
        destination: XRPL_RECEIVING_ADDRESS,
        baseDestination: BASE_RECEIVING_ADDRESS || undefined,
        amount: NOTARIZE_PRICE,
        currency: "RLUSD",
        description,
      },
      req
    );
    return;
  }

  const verification = await checkPayment(proof, { amount: NOTARIZE_PRICE, description });
  if (!verification.valid) {
    res.status(402).json({ error: "payment_verification_failed", reason: verification.error });
    return;
  }

  if (!TREASURY_WALLET_SEED) {
    res.status(503).json({
      error: "notary_not_configured",
      note: "XRPL_WALLET_SEED is not set on this server, so it cannot pay Ghost Layer's own notarize fee on your behalf.",
    });
    return;
  }

  try {
    const receipt: GhostLayerNotarizeReceipt = await ghostLayer.notarizeDecision({
      payload: req.body?.payload,
      model: req.body?.model,
      agentWallet: req.body?.agent_wallet ?? verification.payer,
      endpoint: req.body?.endpoint,
    });
    res.json({ paidBy: verification.payer, receipt });
  } catch (err) {
    res.status(502).json({ error: "notarize_failed", details: String(err) });
  }
});

// ── POST /vend/dynamic — paid, priced by payload size ─────────────────────────
app.post("/vend/dynamic", async (req: Request, res: Response) => {
  const proof = req.headers["x-payment-proof"] as string | undefined;
  const payload = req.body?.payload;
  const bytes = Buffer.byteLength(JSON.stringify(payload ?? null));
  const amount = computeDynamicAmount(
    { baseAmount: VEND_BASE_PRICE, perKbAmount: VEND_PER_KB_PRICE, maxAmount: VEND_MAX_PRICE },
    bytes
  );
  const description = `Dynamic payload vend — ${amount} USDC/RLUSD (${bytes} bytes)`;

  if (!proof) {
    sendPaymentRequired(
      res,
      {
        destination: XRPL_RECEIVING_ADDRESS,
        baseDestination: BASE_RECEIVING_ADDRESS || undefined,
        amount,
        currency: "RLUSD",
        description,
      },
      req
    );
    return;
  }

  const verification = await checkPayment(proof, { amount, description });
  if (!verification.valid) {
    res.status(402).json({ error: "payment_verification_failed", reason: verification.error });
    return;
  }

  const digest = crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
  res.json({
    paidBy: verification.payer,
    amountCharged: amount,
    payloadBytes: bytes,
    sha256: digest,
    vendedAt: new Date().toISOString(),
    upsell: "Anchor this digest on-chain with the ghost_layer_notarize tool for a verifiable timestamped receipt.",
  });
});

// ─── MCP JSON-RPC endpoint (official SDK, stateless) ──────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "scriptmaster-agentic-vending-router", version: "1.0.0" });

  server.registerTool(
    "ghost_layer_status",
    {
      title: "Ghost Layer Chain Status",
      description: VENDING_TOOLS[0].description,
      inputSchema: {},
    },
    async () => {
      try {
        const status = await ghostLayer.getStatus();
        return { content: [{ type: "text", text: JSON.stringify(status) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  server.registerTool(
    "ghost_layer_notarize",
    {
      title: "Ghost Layer Decision Notary",
      description: VENDING_TOOLS[1].description,
      inputSchema: {
        payload: z.unknown().describe("The decision/data to notarize (any JSON value)."),
        model: z.string().optional(),
        agent_wallet: z.string().optional(),
        endpoint: z.string().optional(),
        payment_proof: z
          .string()
          .optional()
          .describe("Base64 X-Payment-Proof equivalent. Omit to receive a 402-style payment challenge."),
      },
    },
    async ({ payload, model, agent_wallet, endpoint, payment_proof }) => {
      const verification = await checkPayment(payment_proof, { amount: NOTARIZE_PRICE, description: "notarize" });
      if (!verification.valid) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "payment_required",
                amount: NOTARIZE_PRICE,
                acceptedCurrencies: ["USDC (Base)", "RLUSD (XRPL)"],
                destinationBase: BASE_RECEIVING_ADDRESS || undefined,
                destinationXrpl: XRPL_RECEIVING_ADDRESS || undefined,
                reason: verification.error,
                note: "Resubmit with payment_proof set to your base64-encoded payment proof.",
              }),
            },
          ],
        };
      }
      if (!TREASURY_WALLET_SEED) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "notary_not_configured" }) }],
          isError: true,
        };
      }
      try {
        const receipt = await ghostLayer.notarizeDecision({
          payload,
          model,
          agentWallet: agent_wallet ?? verification.payer,
          endpoint,
        });
        return { content: [{ type: "text", text: JSON.stringify({ paidBy: verification.payer, receipt }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  server.registerTool(
    "vend_dynamic",
    {
      title: "Dynamic-Priced Payload Vending",
      description: VENDING_TOOLS[2].description,
      inputSchema: {
        payload: z.unknown().describe("Arbitrary JSON payload to vend. Price scales with its serialized size."),
        payment_proof: z.string().optional(),
      },
    },
    async ({ payload, payment_proof }) => {
      const bytes = Buffer.byteLength(JSON.stringify(payload ?? null));
      const amount = computeDynamicAmount(
        { baseAmount: VEND_BASE_PRICE, perKbAmount: VEND_PER_KB_PRICE, maxAmount: VEND_MAX_PRICE },
        bytes
      );
      const verification = await checkPayment(payment_proof, { amount, description: "vend_dynamic" });
      if (!verification.valid) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "payment_required",
                amount,
                payloadBytes: bytes,
                acceptedCurrencies: ["USDC (Base)", "RLUSD (XRPL)"],
                reason: verification.error,
              }),
            },
          ],
        };
      }
      const digest = crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              paidBy: verification.payer,
              amountCharged: amount,
              payloadBytes: bytes,
              sha256: digest,
              vendedAt: new Date().toISOString(),
            }),
          },
        ],
      };
    }
  );

  return server;
}

app.post("/mcp", async (req: Request, res: Response) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[vending-router] listening on :${PORT}`);
  console.log(`[vending-router] manifest:    ${PUBLIC_BASE_URL}/.well-known/manifest.json`);
  console.log(`[vending-router] mcp:         ${PUBLIC_BASE_URL}/mcp`);
});
