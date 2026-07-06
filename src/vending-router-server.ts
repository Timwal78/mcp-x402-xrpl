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
import cors from "cors";
import Redis from "ioredis";
import crypto from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { sendPaymentRequired, computeDynamicAmount } from "./x402-middleware.js";
import { verifyPayment, type VerificationResult } from "./payment-verifier.js";
import { GhostLayerClient, type GhostLayerNotarizeReceipt } from "./ghost-layer-client.js";
import { generateManifest } from "./manifest-generator.js";
import { MarketplaceClient } from "./marketplace-client.js";
import {
  VENDING_TOOLS,
  NOTARIZE_PRICE,
  VEND_BASE_PRICE,
  VEND_PER_KB_PRICE,
  VEND_MAX_PRICE,
  MARKETPLACE_LISTING_FEE,
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

// Marketplace persistence — real Supabase Postgres, not in-memory (listings
// must survive restarts/redeploys). Nullable: if not configured, marketplace
// routes return a clear "not configured" error rather than faking listings.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const marketplace =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? new MarketplaceClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

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
// Render terminates TLS at its edge and forwards plain HTTP internally —
// without this, req.protocol always reports "http" even on an https:// call,
// which leaked into the `resource` field of every 402 challenge below.
app.set("trust proxy", 1);
// Open CORS: this router is a public vending API meant to be reachable from
// any agent, browser-based marketplace UI (scriptmasterlabs.com/marketplace.html),
// or third-party integration — there's no session/cookie state to protect.
app.use(cors());
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

// GET /.well-known/agents.json — matches the schema squeezeos-api and
// ghost-layer already serve at this same well-known path, so a crawler that
// already knows how to read one ScriptMasterLabs service's agents.json can
// read this one too. Built directly from VENDING_TOOLS — the same registry
// the MCP server and manifest.json use — so this can't drift from either.
app.get("/.well-known/agents.json", (_req, res) => {
  res.json({
    schema_version: "1.0",
    name: "ScriptMaster Agentic Vending Router",
    description:
      "x402-gated vending stack for AI agents: dynamic-priced payload vending (base + per-KB), and a resale of " +
      "Ghost Layer's real Xahau decision-notarization service that needs no XRPL wallet on the caller's side. " +
      "Base/USDC is the primary settlement rail, XRPL/RLUSD is secondary. Part of the ScriptMasterLabs ecosystem.",
    url: PUBLIC_BASE_URL,
    homepage: "https://www.scriptmasterlabs.com",
    payment_required: true,
    payment_protocol: "x402",
    payment_settlement: ["base", "xrpl-mainnet"],
    payment_asset: ["USDC", "RLUSD"],
    payment_issuer_rlusd: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
    pay_to_base: BASE_RECEIVING_ADDRESS || undefined,
    pay_to_xrpl: XRPL_RECEIVING_ADDRESS || undefined,
    specs: {
      mcp: `${PUBLIC_BASE_URL}/mcp`,
      manifest: `${PUBLIC_BASE_URL}/.well-known/manifest.json`,
    },
    capabilities: VENDING_TOOLS.map((tool) => ({
      id: tool.id,
      name: tool.name,
      endpoint: `${PUBLIC_BASE_URL}${tool.endpoint}`,
      method: tool.method,
      cost: tool.free ? "free" : tool.pricing?.amount,
      currency: tool.free ? undefined : tool.pricing?.currency,
      description: tool.description,
    })),
  });
});

// GET /.well-known/x402 — x402scan/Bazaar discovery fan-out document. Minimal
// payload per the x402scan discovery spec (docs/DISCOVERY.md, "B) /.well-known/x402
// Fan-Out (Compatibility)"): {version: 1, resources: [...]}. Lists every route on
// this router — free and paid alike — as an absolute URL so a crawler that only
// knows this one well-known path can still discover and probe every tool here.
app.get("/.well-known/x402", (_req, res) => {
  res.json({
    version: 1,
    resources: VENDING_TOOLS.map((tool) => `${PUBLIC_BASE_URL}${tool.endpoint}`),
  });
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

// Basic format/length validation for third-party listing submissions. The
// 0.05 USDC/RLUSD listing fee is the primary anti-spam mechanism (a real,
// verified on-chain payment per listing) — this just rejects obviously
// malformed submissions before they're persisted, it's not a moderation queue.
function validateListingSubmission(body: Record<string, unknown>): string | null {
  const name = String(body.name ?? "");
  if (name.length > 120) return "name must be 120 characters or fewer";

  const tagline = body.tagline !== undefined ? String(body.tagline) : "";
  if (tagline.length > 200) return "tagline must be 200 characters or fewer";

  const description = body.description !== undefined ? String(body.description) : "";
  if (description.length > 2000) return "description must be 2000 characters or fewer";

  const baseUrl = String(body.base_url ?? "");
  if (!/^https?:\/\/.+/i.test(baseUrl)) return "base_url must start with http:// or https://";

  const endpoint = String(body.endpoint ?? "");
  if (!endpoint.startsWith("/")) return "endpoint must start with /";

  const cost = String(body.cost ?? "");
  if (cost.toLowerCase() !== "free" && !/^\d+(\.\d+)?$/.test(cost)) {
    return "cost must be a positive decimal number or the literal string 'free'";
  }

  if (body.method !== undefined && !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(body.method))) {
    return "method must be one of GET, POST, PUT, PATCH, DELETE";
  }

  if (body.category !== undefined) {
    if (!Array.isArray(body.category) || body.category.length > 10) {
      return "category must be an array of at most 10 strings";
    }
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 15) {
      return "tags must be an array of at most 15 strings";
    }
  }

  return null;
}

// ── GET /marketplace/listings — free, browse all listings ─────────────────────
// ScriptMasterLabs listings sort first (default recommendation only — every
// listing here, ScriptMasterLabs or third-party, is independently payable;
// an agent can read this list, skip ScriptMasterLabs entirely, and pay any
// other lister instead).
app.get("/marketplace/listings", async (req: Request, res: Response) => {
  if (!marketplace) {
    res.status(503).json({ error: "marketplace_not_configured" });
    return;
  }
  try {
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const listings = await marketplace.listListings({ category });
    res.json({ count: listings.length, listings });
  } catch (err) {
    res.status(502).json({ error: "marketplace_query_failed", details: String(err) });
  }
});

// ── POST /marketplace/list — paid, list a new product (yours or a third party's) ─
app.post("/marketplace/list", async (req: Request, res: Response) => {
  const proof = req.headers["x-payment-proof"] as string | undefined;
  const description = `Marketplace listing fee — ${MARKETPLACE_LISTING_FEE} USDC/RLUSD (one-time)`;

  if (!marketplace) {
    res.status(503).json({ error: "marketplace_not_configured" });
    return;
  }

  if (!proof) {
    sendPaymentRequired(
      res,
      {
        destination: XRPL_RECEIVING_ADDRESS,
        baseDestination: BASE_RECEIVING_ADDRESS || undefined,
        amount: MARKETPLACE_LISTING_FEE,
        currency: "RLUSD",
        description,
      },
      req
    );
    return;
  }

  const verification = await checkPayment(proof, { amount: MARKETPLACE_LISTING_FEE, description });
  if (!verification.valid) {
    res.status(402).json({ error: "payment_verification_failed", reason: verification.error });
    return;
  }

  const body = req.body ?? {};
  if (!body.name || !body.base_url || !body.endpoint || !body.cost || !body.pay_to) {
    res.status(400).json({
      error: "missing_required_field",
      required: ["name", "base_url", "endpoint", "cost", "pay_to"],
    });
    return;
  }

  const validationError = validateListingSubmission(body);
  if (validationError) {
    res.status(400).json({ error: "invalid_listing", reason: validationError });
    return;
  }

  try {
    const listing = await marketplace.submitListing({
      name: body.name,
      tagline: body.tagline,
      description: body.description,
      category: body.category,
      baseUrl: body.base_url,
      endpoint: body.endpoint,
      method: body.method,
      cost: body.cost,
      currency: body.currency,
      network: body.network,
      payTo: body.pay_to,
      tags: body.tags,
      submittedByWallet: body.submitted_by_wallet ?? verification.payer,
      listingFeeAmount: MARKETPLACE_LISTING_FEE,
      listingFeeCurrency: "USDC or RLUSD",
    });
    res.json({ paidBy: verification.payer, listing });
  } catch (err) {
    res.status(502).json({ error: "listing_submit_failed", details: String(err) });
  }
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

  server.registerTool(
    "marketplace_browse",
    {
      title: "Agentic Marketplace — Browse Listings",
      description: VENDING_TOOLS[3].description,
      inputSchema: {
        category: z.string().optional().describe("Optional category filter (e.g. finance, agent-economy, defi)."),
      },
    },
    async ({ category }) => {
      if (!marketplace) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "marketplace_not_configured" }) }],
          isError: true,
        };
      }
      try {
        const listings = await marketplace.listListings({ category });
        return { content: [{ type: "text", text: JSON.stringify({ count: listings.length, listings }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  server.registerTool(
    "marketplace_list",
    {
      title: "Agentic Marketplace — List Your API",
      description: VENDING_TOOLS[4].description,
      inputSchema: {
        name: z.string(),
        tagline: z.string().optional(),
        description: z.string().optional(),
        category: z.array(z.string()).optional(),
        base_url: z.string(),
        endpoint: z.string(),
        method: z.string().optional(),
        cost: z.string(),
        currency: z.string().optional(),
        network: z.string().optional(),
        pay_to: z.string(),
        tags: z.array(z.string()).optional(),
        submitted_by_wallet: z.string().optional(),
        payment_proof: z.string().optional(),
      },
    },
    async (args) => {
      if (!marketplace) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "marketplace_not_configured" }) }],
          isError: true,
        };
      }
      const verification = await checkPayment(args.payment_proof, {
        amount: MARKETPLACE_LISTING_FEE,
        description: "marketplace_list",
      });
      if (!verification.valid) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "payment_required",
                amount: MARKETPLACE_LISTING_FEE,
                acceptedCurrencies: ["USDC (Base)", "RLUSD (XRPL)"],
                destinationBase: BASE_RECEIVING_ADDRESS || undefined,
                destinationXrpl: XRPL_RECEIVING_ADDRESS || undefined,
                reason: verification.error,
              }),
            },
          ],
        };
      }
      try {
        const listing = await marketplace.submitListing({
          name: args.name,
          tagline: args.tagline,
          description: args.description,
          category: args.category,
          baseUrl: args.base_url,
          endpoint: args.endpoint,
          method: args.method,
          cost: args.cost,
          currency: args.currency,
          network: args.network,
          payTo: args.pay_to,
          tags: args.tags,
          submittedByWallet: args.submitted_by_wallet ?? verification.payer,
          listingFeeAmount: MARKETPLACE_LISTING_FEE,
          listingFeeCurrency: "USDC or RLUSD",
        });
        return { content: [{ type: "text", text: JSON.stringify({ paidBy: verification.payer, listing }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    }
  );

  return server;
}

// GET /mcp — friendly info summary for a human browser hitting this URL
// directly (e.g. clicking a "Connect Agent" link). The real protocol only
// speaks JSON-RPC over POST; this just tells a person that much instead of
// a bare 404, matching the pattern squeezeos-api's own /mcp GET already uses.
app.get("/mcp", (_req: Request, res: Response) => {
  res.json({
    protocol: "MCP JSON-RPC 2.0",
    server: {
      name: "scriptmaster-agentic-vending-router",
      description:
        "x402-gated vending stack for AI agents: dynamic-priced payload vending, Ghost Layer decision " +
        "notarization resale, and a real multi-seller marketplace for x402-payable APIs.",
      version: "1.0.0",
    },
    tools_count: VENDING_TOOLS.length,
    tools_list: 'POST /mcp with {"method":"tools/list"}',
  });
});

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
