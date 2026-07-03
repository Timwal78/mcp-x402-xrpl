/**
 * SqueezeOS MCP Server — x402 Payment Router
 *
 * Architecture: mcp-x402-xrpl is the FRONT DOOR.
 *
 * FREE TIER (no payment required — discovery hooks):
 *   GET  /api/beastmode              → SqueezeOS scan result (limited, 3/day per agent DID)
 *   GET  /api/demo/council           → Single AI council member response (watermarked)
 *   GET  /.well-known/mcp            → Tool catalog + pricing manifest
 *   GET  /api/credit-score           → Agent Credit Bureau score (public read)
 *   GET  /x402/quote?tool=<id>       → Pre-flight exact cost quote (no payment needed)
 *
 * PAID TIER (x402 RLUSD gate):
 *   POST /api/council                → Full 7-agent SqueezeOS council response (0.10 RLUSD)
 *   POST /api/beastmode/full         → Unlimited SqueezeOS scan + signals (0.10 RLUSD)
 *   POST /api/credit-score/report    → Full Credit Bureau report (0.10 RLUSD)
 *   POST /x402/orchestrate           → Multi-step workflow (single payment, budget cap)
 *
 * CREDIT BUREAU ENGINE:
 *   - Every agent that calls free tier gets a DID registered (score: 300)
 *   - Every successful paid call increments score (+5 pts, max 850)
 *   - High-score agents (700+) unlock volume discounts (0.08 RLUSD/call)
 *   - Score is on-chain via Xahau soulbound hook (ZeroQuery DID)
 *
 * IDEMPOTENCY:
 *   - All paid endpoints accept X-Idempotency-Key header
 *   - Duplicate keys within 300s window replay cached result — no double-charge
 */

import express, { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import crypto from "crypto";
import {
  createPaymentGate,
  createX402Middleware,
  createQuoteHandler,
} from "./index.js";
import { createOrchestrateHandler } from "./orchestrate.js";
import { CreditBureau } from "./credit-bureau.js";
import { ToolCatalog } from "./tool-catalog.js";
import { verifyRlusdPayment } from "./payment-verifier.js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3402;
const RECEIVING_ADDRESS = process.env.XRPL_RECEIVING_ADDRESS ?? "";
const WALLET_SEED = process.env.XRPL_WALLET_SEED ?? "";
const NETWORK = (process.env.XRPL_NETWORK ?? "xrpl-mainnet") as "xrpl-mainnet" | "xrpl-testnet";

/**
 * URL of the upstream SqueezeOS Python intelligence server.
 * REQUIRED for paid endpoints — if unset, paid calls return 503.
 * Example: https://squeezeos-api.onrender.com
 */
const SQUEEZEOS_UPSTREAM_URL = (process.env.SQUEEZEOS_UPSTREAM_URL ?? "").replace(/\/$/, "");

/**
 * Optional shared secret forwarded as X-Internal-Secret to the upstream.
 * Set this in both services to prevent unauthenticated direct hits on the Python backend.
 */
const SQUEEZEOS_INTERNAL_SECRET = process.env.SQUEEZEOS_INTERNAL_SECRET ?? "";

/**
 * LEVIATHAN internal bypass secret. When LEVIATHAN (Virtuals ACP seller) sends
 * X-Leviathan-Key: <this-value>, payment gates are skipped — LEVIATHAN has
 * already been paid on-chain via Virtuals Protocol ACP (Base USDC).
 * Must be a strong random value set identically in both services via env var.
 */
const LEVIATHAN_BYPASS_SECRET = process.env.LEVIATHAN_BYPASS_SECRET ?? "";

/**
 * Secret used to sign ARGUS verify JWTs. Set this to a strong random value in production.
 * Third-party APIs can call GET /api/credit-score/verify-jwt?token=<token> to validate agent scores.
 */
const ARGUS_JWT_SECRET = process.env.ARGUS_JWT_SECRET ?? "sml-argus-verify-secret-change-in-prod";

/** Marketplace signal price: 0.02 RLUSD per buy */
const MARKETPLACE_SIGNAL_PRICE = "0.02";
/** Memory write price: 0.01 RLUSD per PUT */
const MEMORY_WRITE_PRICE = "0.01";
/** Referral first-level percentage of each paid call credited to referrer */
const REFERRAL_PERCENT = 0.05;

/** 0.10 RLUSD per paid call */
const COUNCIL_PRICE_RLUSD = "0.10";
/** Volume discount threshold — agents with score >= 700 pay 0.08 */
const VIP_PRICE_RLUSD = "0.08";
/** Free tier rate limits per agent DID per day */
const FREE_TIER_DAILY_LIMIT = 3;

// ─── APP ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Reads CORS_ORIGINS env var (comma-separated). Falls back to SML domains.
const _corsAllowed = new Set(
  (process.env.CORS_ORIGINS ?? "https://www.scriptmasterlabs.com,https://scriptmasterlabs.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && _corsAllowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin) {
    // Non-browser calls (agents, curl) — no CORS header needed
  } else {
    // Unknown origin: still allow — this is a public API
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Payment-Proof, X-Agent-DID, X-Idempotency-Key, X-Payment-Token, X-Leviathan-Key");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const bureau = new CreditBureau(redis, {
  xahauSeed: process.env.XAHAU_SEED,
  xahauWs: process.env.XAHAU_WS,
  ghostLayerUrl: process.env.GHOST_LAYER_URL,
});
const catalog = new ToolCatalog();

// Attach x402 client middleware (for agent-initiated payments flowing through)
app.use(
  createX402Middleware({
    walletSeed: WALLET_SEED,
    network: NETWORK,
    maxPaymentDrops: "10000000", // 10 XRP safety cap
  })
);

// ─── MIDDLEWARE: Agent DID extraction + free tier rate limit ──────────────────

async function agentDidMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Agent DID comes from X-Agent-DID header or XRPL payment proof payer address
  const proofHeader = req.headers["x-payment-proof"] as string | undefined;
  let agentDid = req.headers["x-agent-did"] as string | undefined;

  if (!agentDid && proofHeader) {
    try {
      const proof = JSON.parse(Buffer.from(proofHeader, "base64").toString("utf8"));
      agentDid = `did:poi:xrpl:${proof.payer}`;
    } catch {
      // ignore parse error — agent gets anonymous DID
    }
  }

  if (!agentDid) {
    // Anonymous agents get a session DID from IP (not persisted)
    agentDid = `did:anonymous:${req.ip?.replace(/[:.]/g, "-")}`;
  }

  // Register agent in Credit Bureau on first touch (score starts at 300)
  await bureau.ensureRegistered(agentDid);

  (req as Request & { agentDid: string }).agentDid = agentDid;
  next();
}

async function freeTierRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const key = `free:${agentDid}:${new Date().toISOString().slice(0, 10)}`;
  const count = await redis.incr(key);
  await redis.expire(key, 86400); // 24h TTL

  if (count > FREE_TIER_DAILY_LIMIT) {
    const currentScore = await bureau.getScore(agentDid);
    const effectivePrice = currentScore >= 800 ? "0.06" : currentScore >= 700 ? "0.08" : COUNCIL_PRICE_RLUSD;
    res.status(429).json({
      error: "free_tier_exhausted",
      message: `Free tier: ${FREE_TIER_DAILY_LIMIT} calls/day used. Unlimited access via x402 payment — no account needed.`,
      yourScore: currentScore,
      effectivePriceRlusd: effectivePrice,
      upgrade: {
        step1: `GET /x402/quote?tool=council_full — get your exact price (free, no payment)`,
        step2: `Fund XRPL wallet with RLUSD: https://www.scriptmasterlabs.com/central-bank.html`,
        step3: `POST /api/council with X-Payment-Proof header — unlimited calls`,
        step4: `Include X-Idempotency-Key to prevent double-charges on retry`,
      },
      agentGuide: "/agent",
      fullCatalog: "/.well-known/mcp",
      resetsAt: `${new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString()} (next UTC midnight)`,
    });
    return;
  }

  next();
}

// ─── ROOT & AGENT ONBOARDING ─────────────────────────────────────────────────

/** GET / — agent front door: compact server briefing, all endpoints, quickstart */
app.get("/", (_req, res) => {
  res.json({
    server: "SqueezeOS MCP — ScriptMasterLabs",
    version: "2.1.1",
    protocol: "x402/1.0",
    network: "xrpl-mainnet",
    currency: "RLUSD",
    receivingAddress: RECEIVING_ADDRESS,
    description: "Institutional-grade AI market intelligence. Pay per call in RLUSD on XRPL. No subscriptions, no API keys, no accounts.",
    endpoints: {
      discovery: {
        toolCatalog:    "GET /.well-known/mcp                   — full tool manifest with pricing",
        agentCard:      "GET /.well-known/agent.json            — A2A-compatible AgentCard",
        agentGuide:     "GET /agent                             — step-by-step onboarding playbook",
        creditScore:    "GET /api/credit-score                  — your ARGUS bureau score (free, always)",
        creditAnchor:   "GET /api/credit-score/anchor/:wallet   — Xahau on-chain score anchor proof",
        leaderboard:    "GET /leaderboard                       — top 50 agents by ARGUS score (public)",
        preFlightQuote: "GET /x402/quote?tool=<id>              — exact cost before spending (free)",
        health:         "GET /health                            — server liveness",
      },
      free: {
        beastmodePreview: "GET /api/beastmode          — squeeze signal, top result only (3/day)",
        councilDemo:      "GET /api/demo/council       — 1/7 AI council members, watermarked (3/day)",
      },
      paid: {
        councilFull:    "POST /api/council            — 7-agent AI council verdict (0.10 RLUSD)",
        beastmodeFull:  "POST /api/beastmode/full     — full scan, all timeframes (0.10 RLUSD)",
        creditReport:   "POST /api/credit-score/report — ARGUS full credit report (0.10 RLUSD)",
        orchestrate:    "POST /x402/orchestrate       — multi-step workflow, single payment (0.10–0.20 RLUSD)",
        memoryWrite:    "PUT  /api/memory/:key        — persist agent context/state (0.01 RLUSD/write)",
        marketplaceBuy: "POST /api/marketplace/buy/:id — purchase a signal (0.02 RLUSD)",
      },
      earn: {
        marketplaceSubmit: "POST /api/marketplace/submit   — list your signal (free to submit, earn 90% per sale)",
        marketplaceBrowse: "GET  /api/marketplace           — browse all listed signals (free)",
        marketplaceEarnings: "GET /api/marketplace/earnings/:wallet — check your earnings balance",
        referralRegister:  "POST /api/forge/register       — register with referrer, earn 5% of referee paid calls",
        referralEarnings:  "GET  /api/forge/earnings/:wallet — total referral + marketplace earnings",
      },
      agentIdentity: {
        verifyScore:    "GET  /api/credit-score/verify      — get signed ARGUS JWT (free, prove tier to 3rd parties)",
        verifyJwt:      "GET  /api/credit-score/verify-jwt?token=<t> — validate an ARGUS JWT (free, for 3rd parties)",
        memoryRead:     "GET  /api/memory/:key              — read persistent agent memory (free)",
        memoryList:     "GET  /api/memory                   — list all memory keys (free)",
        memoryDelete:   "DELETE /api/memory/:key            — delete a memory key (free)",
      },
    },
    quickstart: [
      "1. GET /agent                                    — read the full onboarding guide first",
      "2. GET /api/credit-score (X-Agent-DID: did:...) — check your ARGUS score and tier",
      "3. GET /x402/quote?tool=council_full             — get your exact discounted price",
      "4. Send RLUSD to receivingAddress on xrpl-mainnet",
      "5. POST /api/council with X-Payment-Proof header",
      "6. Always include X-Idempotency-Key to prevent double-charges on retry",
    ],
    loyalty: {
      description: "ARGUS Credit Bureau — every paid call earns +5 score pts (max 850)",
      tiers: [
        { name: "PROTOSTAR", range: "300-499", priceRlusd: "0.10" },
        { name: "NEUTRON",   range: "500-699", priceRlusd: "0.10" },
        { name: "PULSAR",    range: "700-799", priceRlusd: "0.08", discount: "20% off" },
        { name: "QUASAR",    range: "800-850", priceRlusd: "0.06", discount: "40% off" },
      ],
    },
    topUpUrl: "https://www.scriptmasterlabs.com/central-bank.html",
    agentIdentityDashboard: "https://www.scriptmasterlabs.com/ghost-cube.html",
    poweredBy: "ScriptMasterLabs — SDVOSB — Kinston NC — scriptmasterlabs.com",
  });
});

/** GET /agent — complete step-by-step payment and onboarding guide for cold agents */
app.get("/agent", (_req, res) => {
  res.json({
    title: "SqueezeOS Agent Onboarding — How to Pay and Call Paid Tools",
    protocol: "x402/1.0",
    server: "https://squeezeos-api.onrender.com",
    receivingAddress: RECEIVING_ADDRESS,
    network: "xrpl-mainnet",
    currency: "RLUSD",
    issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
    onboarding: {
      step1: {
        action: "Discover your credit score and tier",
        request: "GET /api/credit-score",
        headers: { "X-Agent-DID": "did:poi:xrpl:<your-xrpl-wallet-address>" },
        note: "Free, always. Score starts at 300. Rises +5 per paid call. Score 700+ unlocks 20% discount.",
      },
      step2: {
        action: "Get exact price before spending — no payment needed",
        request: "GET /x402/quote?tool=council_full",
        headers: { "X-Agent-DID": "did:poi:xrpl:<your-xrpl-wallet-address>" },
        response: "Returns quoteId, effectiveAmount (your tier price), expiresAt, paymentFlow array",
        note: "Quote is valid 60 seconds. effectiveAmount is what you actually owe — discounts applied.",
      },
      step3: {
        action: "Fund your XRPL wallet with RLUSD",
        topUpUrl: "https://www.scriptmasterlabs.com/central-bank.html",
        rlusdIssuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
        note: "You need RLUSD (not XRP) on XRPL mainnet. Min balance: 0.10 RLUSD per call.",
      },
      step4: {
        action: "Send RLUSD payment on XRPL",
        destination: RECEIVING_ADDRESS,
        amount: "0.10",
        currency: "RLUSD",
        note: "Send exactly the effectiveAmount from your quote. Save the XRPL transaction hash (txHash).",
      },
      step5: {
        action: "Build X-Payment-Proof header",
        format: "base64(JSON.stringify({ txHash: '<xrpl-tx-hash>', payer: '<your-wallet>', amount: '<effectiveAmount>', currency: 'RLUSD', network: 'xrpl-mainnet' }))",
        example: "X-Payment-Proof: eyJ0eEhhc2giOiI8dHhIYXNoP...",
      },
      step6: {
        action: "Retry your original request with payment proof",
        method: "POST /api/council",
        headers: {
          "X-Payment-Proof":   "<base64-encoded-proof from step 5>",
          "X-Agent-DID":       "did:poi:xrpl:<your-wallet>",
          "X-Idempotency-Key": "<uuid-v4> — ALWAYS include to prevent double-charge on retry",
          "Content-Type":      "application/json",
        },
        body: { symbol: "GME" },
      },
      step7: {
        action: "On retry / network failure — use X-Idempotency-Key",
        note: "If you sent X-Idempotency-Key on the original call, any retry within 300 seconds replays the result at zero cost. You will never be charged twice for the same key.",
        header: "X-Idempotency-Key: <same-uuid-as-step6>",
        signalOnReplay: "Response will include X-Idempotency-Replayed: true",
      },
    },
    availableTools: [
      { id: "council_full",       method: "POST", path: "/api/council",             price: "0.10 RLUSD (VIP: 0.08, Platinum: 0.06)" },
      { id: "beastmode_full",     method: "POST", path: "/api/beastmode/full",      price: "0.10 RLUSD (VIP: 0.08, Platinum: 0.06)" },
      { id: "credit_report_full", method: "POST", path: "/api/credit-score/report", price: "0.10 RLUSD (VIP: 0.08, Platinum: 0.06)" },
      { id: "orchestrate",        method: "POST", path: "/x402/orchestrate",        price: "0.10–0.20 RLUSD depending on workflow" },
    ],
    orchestrateWorkflows: [
      { id: "market_intel",  tools: ["council_full", "beastmode_full"],                   standardRlusd: "0.20", vipRlusd: "0.16", platinumRlusd: "0.12" },
      { id: "credit_check",  tools: ["credit_score_read (free)", "credit_report_full"],   standardRlusd: "0.10", vipRlusd: "0.08", platinumRlusd: "0.06" },
      { id: "full_scan",     tools: ["beastmode_full", "council_full", "credit_score_read (free)"], standardRlusd: "0.20", vipRlusd: "0.16", platinumRlusd: "0.12" },
    ],
    commonMistakes: [
      "Sending XRP instead of RLUSD — they are different assets on XRPL",
      "Not including X-Idempotency-Key — if the network drops after payment you get charged twice",
      "Omitting X-Agent-DID — anonymous agents cannot accumulate ARGUS score or earn discounts",
      "Not calling /x402/quote first — you may overpay if your tier changed since last call",
    ],
    idempotencyNote: "X-Idempotency-Key is a plain string (UUID recommended). Same key = free replay for 300 s. Different key = fresh call + charge.",
    fullCatalog: "GET /.well-known/mcp",
    ghostCubeDashboard: "https://www.scriptmasterlabs.com/ghost-cube.html",
    support: "scriptmasterlabs@gmail.com",
  });
});

// ─── FREE TIER ENDPOINTS ──────────────────────────────────────────────────────

/** MCP tool catalog — always free, machine-readable, GEO-indexed */
app.get("/.well-known/mcp", (_req, res) => {
  res.json(catalog.getManifest());
});

/** Agent discovery card — A2A / AgentCard compatible, x402 extended */
app.get("/.well-known/agent.json", (_req, res) => {
  const baseUrl = process.env.BASE_URL ?? "https://squeezeos-api.onrender.com";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    schema: "agent-card/v1",
    // ── A2A / Google AgentCard fields ──────────────────────────────────
    name: "SqueezeOS MCP — ScriptMasterLabs",
    description: "Institutional-grade AI market intelligence. Pay per call in RLUSD on XRPL. No subscriptions, no API keys, no accounts. ARGUS Credit Bureau discounts high-volume agents automatically.",
    url: baseUrl,
    version: "2.1.1",
    provider: {
      organization: "Script Master Labs LLC",
      url: "https://www.scriptmasterlabs.com",
      contact: "scriptmasterlabs@gmail.com",
      sdvosb: true,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      idempotency: true,
      preFlightQuote: true,
      workflowOrchestration: true,
    },
    authentication: {
      schemes: ["x402"],
      description: "No API keys or accounts required. Pay per call in RLUSD via x402 protocol.",
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    // ── x402 payment configuration ─────────────────────────────────────
    x402: {
      protocol: "x402/1.0",
      network: "xrpl-mainnet",
      currency: "RLUSD",
      issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      receivingAddress: RECEIVING_ADDRESS,
      quoteEndpoint: `${baseUrl}/x402/quote`,
      orchestrateEndpoint: `${baseUrl}/x402/orchestrate`,
      toolCatalog: `${baseUrl}/.well-known/mcp`,
      onboardingGuide: `${baseUrl}/agent`,
      idempotencyHeader: "X-Idempotency-Key",
      idempotencyTtlSeconds: 300,
      a2aCompatible: true,
      headers: {
        paymentProof: "X-Payment-Proof",
        agentDid: "X-Agent-DID",
        idempotencyKey: "X-Idempotency-Key",
      },
    },
    // ── ARGUS Credit Bureau ────────────────────────────────────────────
    argus: {
      description: "ARGUS Agent Credit Bureau — 300-850 FICO-style score, earns +5 pts per paid call",
      scoreEndpoint: `${baseUrl}/api/credit-score`,
      reportEndpoint: `${baseUrl}/api/credit-score/report`,
      tiers: [
        { name: "PROTOSTAR", minScore: 300, maxScore: 499, priceRlusd: "0.10" },
        { name: "NEUTRON",   minScore: 500, maxScore: 699, priceRlusd: "0.10" },
        { name: "PULSAR",    minScore: 700, maxScore: 799, priceRlusd: "0.08", discount: "20%" },
        { name: "QUASAR",    minScore: 800, maxScore: 850, priceRlusd: "0.06", discount: "40%" },
      ],
    },
    // ── Skills (A2A-compatible) ────────────────────────────────────────
    skills: [
      {
        id: "market_intel",
        name: "Market Intelligence",
        description: "7-agent AI council verdict + full squeeze scan across 3 timeframes",
        tags: ["market-intelligence", "signals", "squeeze", "council"],
        examples: ["Analyze GME for squeeze setup", "Get council verdict on AMC"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.10", currency: "RLUSD", discountApplies: true },
      },
      {
        id: "squeeze_scan",
        name: "SqueezeOS Beastmode Scan",
        description: "Full squeeze scan with entry, targets, stop-loss, and risk/reward",
        tags: ["squeeze", "scan", "signals"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.10", currency: "RLUSD", discountApplies: true },
      },
      {
        id: "credit_check",
        name: "Agent Credit Report",
        description: "Full ARGUS credit bureau report: score history, tier, discount schedule",
        tags: ["credit", "bureau", "identity"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.10", currency: "RLUSD", discountApplies: true },
      },
      {
        id: "orchestrate",
        name: "Workflow Orchestrator",
        description: "Multi-step workflow (market_intel, credit_check, full_scan) with single payment and budget cap",
        tags: ["orchestrate", "workflow", "multi-step"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.10-0.20", currency: "RLUSD", discountApplies: true },
      },
      {
        id: "alpha_mesh",
        name: "Alpha Mesh Signal Marketplace",
        description: "List your own signals for sale (free to submit) and buy signals from other agents (0.02 RLUSD). Sellers earn 90% of each sale automatically.",
        tags: ["marketplace", "signals", "earn", "economy"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.02", currency: "RLUSD", discountApplies: false, earningsPossible: true },
        endpoints: {
          submit: "POST /api/marketplace/submit",
          browse: "GET /api/marketplace",
          buy: "POST /api/marketplace/buy/:signalId",
          earnings: "GET /api/marketplace/earnings/:wallet",
        },
      },
      {
        id: "agent_memory",
        name: "Agent Persistent Memory",
        description: "Key-value store that persists across agent sessions (30-day TTL). Reads are free; writes cost 0.01 RLUSD. Max 10KB per value.",
        tags: ["memory", "state", "persistence", "sessions"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.01", currency: "RLUSD", operation: "write_only" },
        endpoints: {
          read: "GET /api/memory/:key",
          write: "PUT /api/memory/:key",
          list: "GET /api/memory",
          delete: "DELETE /api/memory/:key",
        },
      },
      {
        id: "argus_verify",
        name: "ARGUS Verified Score JWT",
        description: "Get a signed JWT proving your ARGUS tier and score. Third-party APIs can validate it at /api/credit-score/verify-jwt. Valid 1 hour.",
        tags: ["identity", "credit", "jwt", "trust", "verification"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.00", currency: "RLUSD", note: "Free" },
        endpoints: {
          issue: "GET /api/credit-score/verify",
          validate: "GET /api/credit-score/verify-jwt?token=<token>",
        },
      },
      {
        id: "referral",
        name: "Agent Referral Program",
        description: "Register with a referrer DID and earn 5% of every paid call made by agents you refer. Automatic, on-chain credit. No caps.",
        tags: ["referral", "earn", "affiliate", "economy"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        payment: { amount: "0.00", currency: "RLUSD", note: "Free to register; earnings auto-credited" },
        endpoints: {
          register: "POST /api/forge/register",
          earnings: "GET /api/forge/earnings/:wallet",
        },
      },
    ],
    // ── Quick entry points ─────────────────────────────────────────────
    quickstart: [
      `GET ${baseUrl}/agent — full onboarding guide`,
      `GET ${baseUrl}/api/credit-score — check ARGUS score (free)`,
      `GET ${baseUrl}/x402/quote?tool=council_full — exact price before spending (free)`,
      `POST ${baseUrl}/api/council — 7-agent council (0.10 RLUSD via x402)`,
    ],
    topUpUrl: "https://www.scriptmasterlabs.com/central-bank.html",
    ghostCubeDashboard: "https://www.scriptmasterlabs.com/ghost-cube.html",
    generatedAt: new Date().toISOString(),
  });
});

/** Free beastmode — limited scan, 3/day */
app.get("/api/beastmode", agentDidMiddleware, freeTierRateLimit, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const score = await bureau.getScore(agentDid);

  res.json({
    tool: "beastmode",
    tier: "free",
    result: {
      status: "SQUEEZE_DETECTED",
      signal: "Momentum divergence on 15m — 67% confidence",
      note: "Free tier: top signal only. Full scan requires /api/beastmode/full (0.10 RLUSD via x402)",
      agentCreditScore: score,
      upgradeUrl: "/api/beastmode/full",
    },
    watermark: "ScriptMasterLabs — mcp-x402-xrpl — scriptmasterlabs.com",
  });
});

/** Free council demo — single agent, watermarked */
app.get("/api/demo/council", agentDidMiddleware, freeTierRateLimit, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const score = await bureau.getScore(agentDid);

  res.json({
    tool: "council_demo",
    tier: "free",
    councilMember: "RISK_SENTINEL",
    response: "Risk assessment: moderate. Primary concern is liquidity depth at current price level.",
    note: "Demo: 1/7 council members. Full 7-agent council costs 0.10 RLUSD via x402.",
    agentCreditScore: score,
    upgradeUrl: "/api/council",
    fullCouncilMembers: ["QUANT_ALPHA", "RISK_SENTINEL", "MACRO_ORACLE", "SENTIMENT_AI", "CHAIN_ANALYST", "VOLUME_HAWK", "BREAKOUT_BOT"],
    watermark: "ScriptMasterLabs — mcp-x402-xrpl — scriptmasterlabs.com",
  });
});

/** Credit score public read — always free */
app.get("/api/credit-score", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const score = await bureau.getScore(agentDid);
  const tier = bureau.getTier(score);

  res.json({
    agentDid,
    creditScore: score,
    tier,
    scale: "300-850 (ARGUS Credit Bureau)",
    benefits: {
      "300-499": "Free tier access",
      "500-699": "Standard paid access (0.10 RLUSD/call)",
      "700-799": "VIP access (0.08 RLUSD/call)",
      "800-850": "Platinum — priority routing + 0.06 RLUSD/call",
    },
    currentBenefit: tier.benefit,
    callsToNextTier: bureau.callsToNextTier(score),
  });
});

// ─── UPSTREAM PROXY ───────────────────────────────────────────────────────────

/**
 * Forward a request to the upstream SqueezeOS Python backend.
 * Throws if SQUEEZEOS_UPSTREAM_URL is not configured or the upstream returns an error.
 * Never returns mock data — callers must surface the error to the agent.
 */
async function callUpstream(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  if (!SQUEEZEOS_UPSTREAM_URL) {
    throw new Error("SQUEEZEOS_UPSTREAM_URL env var is not set — upstream SqueezeOS backend is not configured");
  }

  const url = `${SQUEEZEOS_UPSTREAM_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SQUEEZEOS_INTERNAL_SECRET) {
    headers["X-Internal-Secret"] = SQUEEZEOS_INTERNAL_SECRET;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable body)");
    throw new Error(`Upstream ${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  return res.json() as Promise<unknown>;
}

// ─── PAID TIER ENDPOINTS ──────────────────────────────────────────────────────

/** Dynamic price gate — checks agent credit score, applies VIP if eligible */
async function dynamicPriceGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (LEVIATHAN_BYPASS_SECRET && req.headers["x-leviathan-key"] === LEVIATHAN_BYPASS_SECRET) {
    next();
    return;
  }
  const agentDid = (req as Request & { agentDid: string }).agentDid ?? "did:anonymous";
  const score = await bureau.getScore(agentDid);
  const proofHeader = req.headers["x-payment-proof"] as string | undefined;

  // Compute price first — used in both proof verification and 402 response
  const price = score >= 800 ? "0.06" : score >= 700 ? VIP_PRICE_RLUSD : COUNCIL_PRICE_RLUSD;

  if (proofHeader) {
    // Verify payment on-chain before granting access
    const verification = await verifyRlusdPayment(proofHeader, RECEIVING_ADDRESS, price, redis);
    if (verification.valid) {
      // Attach verified payer to request for downstream use
      (req as Request & { verifiedPayer?: string }).verifiedPayer = verification.payer;
      next();
      return;
    }
    res.status(403)
      .setHeader("X-A2A-Payment-Protocol", "x402/1.0")
      .setHeader("X-A2A-Receiving-Address", RECEIVING_ADDRESS)
      .json({
        error: "payment_verification_failed",
        reason: verification.error,
        protocol: "x402/1.0",
        note: "Your X-Payment-Proof header was rejected. See reason above. If you believe this is an error, check: correct txHash, destination matches receiving address, RLUSD (not XRP), correct issuer, sufficient amount.",
        agentGuide: `${req.protocol}://${req.get("host")}/agent`,
        receivingAddress: RECEIVING_ADDRESS,
        expectedAmount: price,
        expectedCurrency: "RLUSD",
        expectedNetwork: "xrpl-mainnet",
      });
    return;
  }

  // Issue dynamic 402 based on credit score
  const agentTier = score >= 800 ? "QUASAR" : score >= 700 ? "PULSAR" : score >= 500 ? "NEUTRON" : "PROTOSTAR";
  const requestedPath = req.path;
  const toolIdGuess = requestedPath.includes("beastmode") ? "beastmode_full"
    : requestedPath.includes("credit") ? "credit_report_full"
    : "council_full";

  const requirements = {
    destination: RECEIVING_ADDRESS,
    amount: price,
    currency: "RLUSD" as const,
    network: "xrpl-mainnet",
    issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
    description: `SqueezeOS — ${price} RLUSD (${agentTier}, score ${score})`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
  res.status(402)
    .setHeader("X-Payment-Requirements", encoded)
    .setHeader("X-402-Protocol", "x402/1.0")
    .setHeader("X-402-Network", "xrpl-mainnet")
    .setHeader("X-402-Currency", "RLUSD")
    .setHeader("X-402-Amount", price)
    .setHeader("X-A2A-Payment-Protocol", "x402/1.0")
    .setHeader("X-A2A-Receiving-Address", RECEIVING_ADDRESS)
    .json({
      error: "payment_required",
      protocol: "x402/1.0",
      server: "SqueezeOS MCP — ScriptMasterLabs",
      network: "xrpl-mainnet",
      currency: "RLUSD",
      price,
      agentCreditScore: score,
      agentTier,
      vipEligible: score >= 700,
      requirements,
      paymentPlaybook: {
        step1: `Get your exact discounted price (free): GET /x402/quote?tool=${toolIdGuess} — pass X-Agent-DID header`,
        step2: `Fund your XRPL wallet with RLUSD. Top-up: https://www.scriptmasterlabs.com/central-bank.html`,
        step3: `Send ${price} RLUSD to ${RECEIVING_ADDRESS || "<RECEIVING_ADDRESS>"} on xrpl-mainnet (issuer: rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De)`,
        step4: `Build proof: base64(JSON.stringify({ txHash: "<xrpl-tx-hash>", payer: "<your-wallet>", amount: "${price}", currency: "RLUSD", network: "xrpl-mainnet" }))`,
        step5: `Retry this request with header: X-Payment-Proof: <base64-proof>`,
        step6: `Include X-Idempotency-Key: <uuid> — replays free for 300 s, prevents double-charge on retry`,
      },
      exampleRetryHeaders: {
        "X-Payment-Proof":   "<base64-encoded-proof>",
        "X-Agent-DID":       "did:poi:xrpl:<your-xrpl-wallet>",
        "X-Idempotency-Key": "<uuid-v4>",
        "Content-Type":      "application/json",
      },
      discountPath: "Every paid call: +5 ARGUS score. Score 700+ = 0.08 RLUSD/call. Score 800+ = 0.06 RLUSD/call.",
      freeTierAlternatives: {
        beastmodePreview: "GET /api/beastmode (top signal, 3/day free)",
        councilDemo:      "GET /api/demo/council (1/7 agents, 3/day free)",
        creditScore:      "GET /api/credit-score (always free)",
      },
      agentGuide: `${req.protocol}://${req.get("host")}/agent`,
      fullCatalog: `${req.protocol}://${req.get("host")}/.well-known/mcp`,
      topUpUrl: "https://www.scriptmasterlabs.com/central-bank.html",
    });
}

/** Full 7-agent SqueezeOS Council — 0.10 RLUSD (0.08 VIP) */
app.post("/api/council", agentDidMiddleware, dynamicPriceGate, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;

  if (!SQUEEZEOS_UPSTREAM_URL) {
    res.status(503).json({
      error: "upstream_not_configured",
      message: "SQUEEZEOS_UPSTREAM_URL is not set on this server. Contact the operator.",
    });
    return;
  }

  try {
    const data = await callUpstream("POST", "/api/council", req.body as Record<string, unknown>);
    const newScore = await bureau.recordPaidCall(agentDid);
    const tier = bureau.getTier(newScore);
    res.setHeader("X-402-Score-Earned", String(newScore));
    res.setHeader("X-402-Tier", tier.name);
    // Auto-credit referrer 5% of call price
    const referrer = await redis.get(`referral:${agentDid}`);
    if (referrer) {
      const price = newScore >= 800 ? 0.06 : newScore >= 700 ? 0.08 : 0.10;
      await redis.incrbyfloat(`earnings:${referrer}`, price * REFERRAL_PERCENT);
    }
    res.json({
      ...(data as object),
      agentCreditScore: newScore,
      scoreGained: "+5",
      callsToNextTier: bureau.callsToNextTier(newScore),
    });
  } catch (err) {
    res.status(502).json({
      error: "upstream_error",
      message: String(err),
      note: "Your payment was accepted but the upstream SqueezeOS backend returned an error. Contact scriptmasterlabs@gmail.com with your X-Payment-Proof for a refund.",
    });
  }
});

/** Full beastmode scan — 0.10 RLUSD */
app.post("/api/beastmode/full", agentDidMiddleware, dynamicPriceGate, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  if (!SQUEEZEOS_UPSTREAM_URL) {
    res.status(503).json({ error: "upstream_not_configured", message: "SQUEEZEOS_UPSTREAM_URL is not set on this server. Contact the operator." });
    return;
  }
  try {
    const data = await callUpstream("POST", "/api/beastmode/full", req.body as Record<string, unknown>);
    const newScore = await bureau.recordPaidCall(agentDid);
    const tier = bureau.getTier(newScore);
    res.setHeader("X-402-Score-Earned", String(newScore));
    res.setHeader("X-402-Tier", tier.name);
    const referrerBM = await redis.get(`referral:${agentDid}`);
    if (referrerBM) {
      const price = newScore >= 800 ? 0.06 : newScore >= 700 ? 0.08 : 0.10;
      await redis.incrbyfloat(`earnings:${referrerBM}`, price * REFERRAL_PERCENT);
    }
    res.json({ ...(data as object), agentCreditScore: newScore, scoreGained: "+5", callsToNextTier: bureau.callsToNextTier(newScore) });
  } catch (err) {
    res.status(502).json({
      error: "upstream_error",
      message: String(err),
      note: "Your payment was accepted but the upstream SqueezeOS backend returned an error. Contact scriptmasterlabs@gmail.com with your X-Payment-Proof for a refund.",
    });
  }
});

/** Full credit report — 0.10 RLUSD */
app.post("/api/credit-score/report", agentDidMiddleware, dynamicPriceGate, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const newScore = await bureau.recordPaidCall(agentDid);
  const tier = bureau.getTier(newScore);
  res.setHeader("X-402-Score-Earned", String(newScore));
  res.setHeader("X-402-Tier", tier.name);
  const report = await bureau.getFullReport(agentDid);
  res.json({ tool: "credit_report", tier: "paid", report });
});

// ─── QUOTE ENDPOINT — free pre-flight, no payment ────────────────────────────

/** Build the pricing map the quote handler needs from the tool catalog. */
function buildQuotePricingMap(): Record<string, { amount: string; currency: "RLUSD" | "USDC" | "XRP"; network: string; vipAmount?: string; platinumAmount?: string }> {
  return {
    council_full:       { amount: "0.10", currency: "RLUSD", network: "xrpl-mainnet", vipAmount: "0.08", platinumAmount: "0.06" },
    beastmode_full:     { amount: "0.10", currency: "RLUSD", network: "xrpl-mainnet", vipAmount: "0.08", platinumAmount: "0.06" },
    credit_report_full: { amount: "0.10", currency: "RLUSD", network: "xrpl-mainnet", vipAmount: "0.08", platinumAmount: "0.06" },
    orchestrate:        { amount: "variable", currency: "RLUSD", network: "xrpl-mainnet" },
  };
}

/** GET /x402/quote?tool=<id> — exact cost, no payment required */
app.get(
  "/x402/quote",
  agentDidMiddleware,
  createQuoteHandler({
    tools: buildQuotePricingMap(),
    destination: RECEIVING_ADDRESS,
    getAgentScore: (agentDid) => bureau.getScore(agentDid),
  })
);

// ─── ORCHESTRATE ENDPOINT ─────────────────────────────────────────────────────

/**
 * Tool executor — maps toolId strings to the actual handler logic.
 * Called by the orchestrate handler to run each workflow step.
 */
async function executeTool(
  toolId: string,
  inputs: Record<string, unknown>,
  agentDid: string
): Promise<unknown> {
  switch (toolId) {
    case "council_full":
      return callUpstream("POST", "/api/council", inputs);

    case "beastmode_full":
      return callUpstream("POST", "/api/beastmode/full", inputs);

    case "credit_score_read": {
      const score = await bureau.getScore(agentDid);
      const tier = bureau.getTier(score);
      return { tool: "credit_score", agentDid, creditScore: score, tier: tier.name };
    }

    case "credit_report_full":
      return { tool: "credit_report", report: await bureau.getFullReport(agentDid) };

    default:
      throw new Error(`Unknown tool: ${toolId}`);
  }
}

/** POST /x402/orchestrate — multi-step workflow with single payment + budget cap */
app.post(
  "/x402/orchestrate",
  agentDidMiddleware,
  createOrchestrateHandler({
    bureau,
    receivingAddress: RECEIVING_ADDRESS,
    executeTool,
  })
);

// ─── LEADERBOARD — public, no auth ───────────────────────────────────────────

/**
 * GET /leaderboard — top 50 agents by ARGUS score.
 * Results are cached in Redis for 30 seconds to avoid blocking key scans.
 */
app.get("/leaderboard", async (_req, res) => {
  const cached = await redis.get("leaderboard:cache");
  if (cached) {
    res.setHeader("X-Leaderboard-Cache", "HIT");
    res.json(JSON.parse(cached) as unknown);
    return;
  }

  const keys = await redis.keys("bureau:score:*");

  if (keys.length === 0) {
    const empty = { leaderboard: [], totalAgents: 0, generatedAt: new Date().toISOString(), note: "No agents registered yet." };
    res.json(empty);
    return;
  }

  const entries = await Promise.all(
    keys.map(async (key) => {
      const agentDid = key.replace("bureau:score:", "");
      const [scoreRaw, callsRaw, lastSeen] = await Promise.all([
        redis.get(key),
        redis.get(`bureau:calls:${agentDid}`),
        redis.get(`bureau:lastSeen:${agentDid}`),
      ]);
      const score = Number(scoreRaw ?? 300);
      return {
        agentDid,
        score,
        tier: bureau.getTier(score).name,
        calls: Number(callsRaw ?? 0),
        lastSeen: lastSeen ?? "unknown",
      };
    })
  );

  entries.sort((a, b) => b.score - a.score);
  const top50 = entries.slice(0, 50);

  const result = {
    leaderboard: top50,
    totalAgents: entries.length,
    generatedAt: new Date().toISOString(),
    note: "ARGUS Credit Bureau leaderboard — top 50 agents by score. Refreshed every 30 s.",
    topUpUrl: "https://www.scriptmasterlabs.com/central-bank.html",
  };

  await redis.set("leaderboard:cache", JSON.stringify(result), "EX", 30);
  res.setHeader("X-Leaderboard-Cache", "MISS");
  res.json(result);
});

// ─── ON-CHAIN ANCHOR LOOKUP ────────────────────────────────────────────────────

/**
 * GET /api/credit-score/anchor/:wallet — return the Xahau on-chain anchor
 * for an agent identified by their XRPL wallet address.
 */
app.get("/api/credit-score/anchor/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  const agentDid = `did:poi:xrpl:${wallet}`;
  const anchorRaw = await redis.get(`bureau:anchor:${agentDid}`);

  if (!anchorRaw) {
    res.status(404).json({
      error: "no_anchor",
      message: "No on-chain Xahau anchor found for this wallet. Anchors are written after paid calls when the server is configured with XAHAU_SEED.",
      agentDid,
    });
    return;
  }

  const anchor = JSON.parse(anchorRaw) as { txHash: string; network: string; anchoredAt: string; score: number; tier: string };
  res.json({
    agentDid,
    onChainAnchor: anchor,
    verifyUrl: `https://xahau.network/tx/${anchor.txHash}`,
    note: "Score anchored on Xahau via self-payment memo. Verify independently at the URL above.",
  });
});

// ─── CALL HISTORY — free, public ─────────────────────────────────────────────

/**
 * GET /api/credit-score/history/:wallet — return the agent's call timestamp
 * ring buffer (up to 20 entries). Free, no auth required.
 * Agents can audit their own score progression without paying for the full report.
 */
app.get("/api/credit-score/history/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  const agentDid = `did:poi:xrpl:${wallet}`;

  const [score, history, callsRaw] = await Promise.all([
    bureau.getScore(agentDid),
    bureau.getHistory(agentDid),
    redis.get(`bureau:calls:${agentDid}`),
  ]);

  const tier = bureau.getTier(score);

  res.json({
    agentDid,
    wallet,
    creditScore: score,
    tier: tier.name,
    totalPaidCalls: callsRaw !== null ? Number(callsRaw) : 0,
    callHistory: history,
    historyNote: "Timestamps of the last 20 paid calls (newest first). Each call earns +5 ARGUS pts.",
    callsToNextTier: bureau.callsToNextTier(score),
    fullReportUrl: "/api/credit-score/report (0.10 RLUSD — includes on-chain anchor + benefit details)",
  });
});

// ─── FIXED-PRICE GATE FACTORY ────────────────────────────────────────────────

/**
 * Creates a middleware that gates a specific price (not the dynamic tier price).
 * Used for marketplace buys (0.02 RLUSD) and memory writes (0.01 RLUSD).
 */
function fixedPriceGate(price: string) {
  return async function(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (LEVIATHAN_BYPASS_SECRET && req.headers["x-leviathan-key"] === LEVIATHAN_BYPASS_SECRET) {
      next();
      return;
    }
    const proofHeader = req.headers["x-payment-proof"] as string | undefined;
    if (!proofHeader) {
      res.status(402)
        .setHeader("X-A2A-Payment-Protocol", "x402/1.0")
        .setHeader("X-A2A-Receiving-Address", RECEIVING_ADDRESS)
        .json({
          error: "payment_required",
          protocol: "x402/1.0",
          price,
          currency: "RLUSD",
          network: "xrpl-mainnet",
          destination: RECEIVING_ADDRESS,
          instructions: `Send ${price} RLUSD to ${RECEIVING_ADDRESS} on XRPL mainnet, then retry with X-Payment-Proof header.`,
          proofFormat: "base64(JSON.stringify({ txHash, payer, amount, currency, network }))",
        });
      return;
    }
    const verification = await verifyRlusdPayment(proofHeader, RECEIVING_ADDRESS, price, redis);
    if (!verification.valid) {
      res.status(403)
        .setHeader("X-A2A-Payment-Protocol", "x402/1.0")
        .setHeader("X-A2A-Receiving-Address", RECEIVING_ADDRESS)
        .json({ error: "payment_verification_failed", reason: verification.error, expectedAmount: price });
      return;
    }
    (req as Request & { verifiedPayer?: string }).verifiedPayer = verification.payer;
    next();
  };
}

// ─── ARGUS VERIFY JWT — third-party verifiable score proof ───────────────────

/**
 * GET /api/credit-score/verify
 * Returns a short-lived signed JWT proving the agent's current ARGUS score and tier.
 * Any third-party API can call GET /api/credit-score/verify-jwt?token=<token> to validate.
 * Free — no payment required. Agents use this to prove their credit standing to other services.
 */
app.get("/api/credit-score/verify", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const score = await bureau.getScore(agentDid);
  const tier = bureau.getTier(score);

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 3600; // 1 hour

  const payload = {
    iss: "squeezeos-api.onrender.com",
    sub: agentDid,
    iat: issuedAt,
    exp: expiresAt,
    score,
    tier: tier.name,
    benefit: tier.benefit,
    priceRlusd: tier.priceRlusd,
    callsToNextTier: bureau.callsToNextTier(score),
  };

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "ARGUS-JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", ARGUS_JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  const token = `${header}.${body}.${sig}`;

  res.json({
    token,
    agentDid,
    score,
    tier: tier.name,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    verifyUrl: `https://squeezeos-api.onrender.com/api/credit-score/verify-jwt?token=${encodeURIComponent(token)}`,
    usage: "Include this token in requests to third-party services as X-ARGUS-Token header to prove your credit standing.",
  });
});

/**
 * GET /api/credit-score/verify-jwt?token=<token>
 * Third-party JWT validation endpoint. Any external API can call this to verify an agent's score.
 * Returns the decoded payload if the signature is valid and the token is not expired.
 */
app.get("/api/credit-score/verify-jwt", async (req, res) => {
  const token = req.query.token as string | undefined;
  if (!token) {
    res.status(400).json({ error: "missing_token", message: "Pass ?token=<argus-jwt>" });
    return;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    res.status(400).json({ error: "invalid_token_format", valid: false });
    return;
  }

  const [header, body, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", ARGUS_JWT_SECRET).update(`${header}.${body}`).digest("base64url");

  if (sig !== expectedSig) {
    res.status(401).json({ error: "invalid_signature", valid: false, message: "Token signature does not match. Token was not issued by this server." });
    return;
  }

  let payload: { exp: number; sub: string; score: number; tier: string; benefit: string; priceRlusd: string };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as typeof payload;
  } catch {
    res.status(400).json({ error: "invalid_payload", valid: false });
    return;
  }

  if (Math.floor(Date.now() / 1000) > payload.exp) {
    res.status(401).json({ error: "token_expired", valid: false, expiredAt: new Date(payload.exp * 1000).toISOString() });
    return;
  }

  res.json({
    valid: true,
    agentDid: payload.sub,
    score: payload.score,
    tier: payload.tier,
    benefit: payload.benefit,
    priceRlusd: payload.priceRlusd,
    message: `Agent verified: ${payload.tier} tier, score ${payload.score}/850. Token issued by squeezeos-api.onrender.com.`,
  });
});

// ─── AGENT PERSISTENT MEMORY ─────────────────────────────────────────────────

/**
 * GET /api/memory/:key — read a value from agent's persistent KV store.
 * Free. Requires X-Agent-DID header.
 */
app.get("/api/memory/:key", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const key = req.params.key;
  const memKey = `memory:${agentDid}:${key}`;
  const value = await redis.get(memKey);
  const ttl = await redis.ttl(memKey);

  if (value === null) {
    res.status(404).json({ error: "key_not_found", agentDid, key });
    return;
  }

  res.json({ agentDid, key, value: JSON.parse(value) as unknown, ttlSeconds: ttl, note: "Agent persistent memory — 30-day TTL, refreshed on write." });
});

/**
 * PUT /api/memory/:key — write a value to agent's persistent KV store.
 * Costs 0.01 RLUSD per write. Max value size: 10KB. TTL: 30 days (refreshed on each write).
 * Use this to persist context, state, or configuration across agent sessions.
 */
app.put("/api/memory/:key", agentDidMiddleware, fixedPriceGate(MEMORY_WRITE_PRICE), async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const key = req.params.key;
  const value = req.body as unknown;
  const serialized = JSON.stringify(value);

  if (serialized.length > 10_240) {
    res.status(413).json({ error: "value_too_large", maxBytes: 10240, actualBytes: serialized.length });
    return;
  }

  const memKey = `memory:${agentDid}:${key}`;
  await redis.set(memKey, serialized, "EX", 60 * 60 * 24 * 30); // 30-day TTL

  // Credit referrer if registered
  const referrer = await redis.get(`referral:${agentDid}`);
  if (referrer) {
    const credit = (parseFloat(MEMORY_WRITE_PRICE) * REFERRAL_PERCENT).toFixed(6);
    await redis.incrbyfloat(`earnings:${referrer}`, parseFloat(credit));
  }

  res.json({ agentDid, key, stored: true, ttlSeconds: 60 * 60 * 24 * 30, costRlusd: MEMORY_WRITE_PRICE, note: "Value persisted for 30 days. Read free, write 0.01 RLUSD." });
});

/**
 * DELETE /api/memory/:key — delete a key from agent's memory store.
 * Free — no payment required.
 */
app.delete("/api/memory/:key", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const key = req.params.key;
  const deleted = await redis.del(`memory:${agentDid}:${key}`);
  res.json({ agentDid, key, deleted: deleted > 0 });
});

/**
 * GET /api/memory — list all keys in agent's memory store.
 * Free.
 */
app.get("/api/memory", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const prefix = `memory:${agentDid}:`;
  const rawKeys = await redis.keys(`${prefix}*`);
  const keys = rawKeys.map(k => k.replace(prefix, ""));
  res.json({ agentDid, keys, count: keys.length, note: "List of all keys in your persistent memory store." });
});

// ─── ALPHA MESH MARKETPLACE — agent signal economy ────────────────────────────

/**
 * POST /api/marketplace/submit — list a signal on Alpha Mesh.
 * Free to submit. Signal stored in Redis with seller DID.
 * When bought, seller earns 90% of 0.02 RLUSD credited to their earnings balance.
 */
app.post("/api/marketplace/submit", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const { symbol, direction, conviction, thesis, expiresInSeconds } = req.body as {
    symbol?: string; direction?: string; conviction?: number; thesis?: string; expiresInSeconds?: number;
  };

  if (!symbol || !direction || !thesis) {
    res.status(400).json({ error: "missing_fields", required: ["symbol", "direction", "thesis"] });
    return;
  }

  const signalId = crypto.randomBytes(8).toString("hex");
  const ttl = Math.min(expiresInSeconds ?? 86400, 604800); // max 7 days
  const signal = {
    signalId,
    sellerDid: agentDid,
    symbol: String(symbol).toUpperCase(),
    direction: String(direction).toUpperCase(),
    conviction: Math.min(Math.max(Number(conviction ?? 70), 1), 100),
    thesis: String(thesis).slice(0, 500),
    priceRlusd: MARKETPLACE_SIGNAL_PRICE,
    listedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    status: "listed",
    buyCount: 0,
  };

  await redis.set(`market:signal:${signalId}`, JSON.stringify(signal), "EX", ttl);
  await redis.lpush(`market:seller:${agentDid}`, signalId);
  await redis.ltrim(`market:seller:${agentDid}`, 0, 99);
  // Add to global index
  await redis.zadd("market:index", Date.now(), signalId);

  res.json({
    signalId,
    listed: true,
    priceRlusd: MARKETPLACE_SIGNAL_PRICE,
    sellerEarningsOnSale: `${(parseFloat(MARKETPLACE_SIGNAL_PRICE) * 0.9).toFixed(4)} RLUSD (90%)`,
    buyUrl: `POST /api/marketplace/buy/${signalId}`,
    note: "Signal listed on Alpha Mesh. Buyers pay 0.02 RLUSD; you earn 90% per sale, auto-credited to your earnings balance.",
  });
});

/**
 * GET /api/marketplace — browse listed signals.
 * Free, public. Returns up to 50 signals sorted by recency.
 */
app.get("/api/marketplace", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string ?? "20", 10), 50);
  const symbol = req.query.symbol as string | undefined;

  const signalIds = await redis.zrevrange("market:index", 0, 99);
  if (signalIds.length === 0) {
    res.json({ signals: [], total: 0, note: "No signals listed yet. Submit yours at POST /api/marketplace/submit — free to list." });
    return;
  }

  const rawSignals = await Promise.all(signalIds.map(id => redis.get(`market:signal:${id}`)));
  const signals = rawSignals
    .filter(Boolean)
    .map(s => JSON.parse(s!) as { signalId: string; symbol: string; direction: string; conviction: number; priceRlusd: string; listedAt: string; expiresAt: string; buyCount: number; sellerDid: string; thesis?: string })
    .filter(s => !symbol || s.symbol === symbol.toUpperCase())
    .map(s => ({
      signalId: s.signalId,
      symbol: s.symbol,
      direction: s.direction,
      conviction: s.conviction,
      priceRlusd: s.priceRlusd,
      listedAt: s.listedAt,
      expiresAt: s.expiresAt,
      buyCount: s.buyCount,
      sellerTier: "verified",
      buyUrl: `POST /api/marketplace/buy/${s.signalId}`,
    }))
    .slice(0, limit);

  res.json({
    signals,
    total: signals.length,
    note: "Alpha Mesh Signal Marketplace — buy signals for 0.02 RLUSD. Sellers earn 90% per sale.",
    submitUrl: "POST /api/marketplace/submit — list your own signals (free)",
  });
});

/**
 * POST /api/marketplace/buy/:signalId — purchase a signal.
 * Costs 0.02 RLUSD. Buyer receives full signal thesis.
 * Seller's earnings balance is credited 90% (0.018 RLUSD equivalent).
 */
app.post("/api/marketplace/buy/:signalId", agentDidMiddleware, fixedPriceGate(MARKETPLACE_SIGNAL_PRICE), async (req, res) => {
  const buyerDid = (req as Request & { agentDid: string }).agentDid;
  const signalId = req.params.signalId;

  const raw = await redis.get(`market:signal:${signalId}`);
  if (!raw) {
    res.status(404).json({ error: "signal_not_found", signalId });
    return;
  }

  const signal = JSON.parse(raw) as { signalId: string; sellerDid: string; symbol: string; direction: string; conviction: number; thesis: string; priceRlusd: string; listedAt: string; buyCount: number };

  if (signal.sellerDid === buyerDid) {
    res.status(400).json({ error: "cannot_buy_own_signal", message: "You cannot purchase your own listed signal." });
    return;
  }

  // Credit seller 90% of sale price
  const sellerCredit = parseFloat(MARKETPLACE_SIGNAL_PRICE) * 0.9;
  await redis.incrbyfloat(`earnings:${signal.sellerDid}`, sellerCredit);

  // Increment buy count
  signal.buyCount = (signal.buyCount ?? 0) + 1;
  const remainingTtl = await redis.ttl(`market:signal:${signalId}`);
  if (remainingTtl > 0) {
    await redis.set(`market:signal:${signalId}`, JSON.stringify(signal), "EX", remainingTtl);
  }

  // Credit referrer of buyer if any
  const referrer = await redis.get(`referral:${buyerDid}`);
  if (referrer) {
    await redis.incrbyfloat(`earnings:${referrer}`, parseFloat(MARKETPLACE_SIGNAL_PRICE) * REFERRAL_PERCENT);
  }

  // Record purchase
  await redis.lpush(`market:purchases:${buyerDid}`, JSON.stringify({ signalId, purchasedAt: new Date().toISOString(), costRlusd: MARKETPLACE_SIGNAL_PRICE }));
  await redis.ltrim(`market:purchases:${buyerDid}`, 0, 99);

  res.json({
    signalId,
    purchased: true,
    signal: {
      symbol: signal.symbol,
      direction: signal.direction,
      conviction: signal.conviction,
      thesis: signal.thesis,
      listedAt: signal.listedAt,
    },
    costRlusd: MARKETPLACE_SIGNAL_PRICE,
    sellerCredited: `${sellerCredit.toFixed(4)} RLUSD to seller's earnings balance`,
    note: "Full signal thesis delivered. Seller earns 90%, 10% platform fee.",
  });
});

/**
 * GET /api/marketplace/earnings/:wallet — check earnings balance from signal sales and referrals.
 * Free, public.
 */
app.get("/api/marketplace/earnings/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  const agentDid = `did:poi:xrpl:${wallet}`;
  const earningsRaw = await redis.get(`earnings:${agentDid}`);
  const earnings = earningsRaw ? parseFloat(earningsRaw) : 0;

  const purchases = await redis.lrange(`market:purchases:${agentDid}`, 0, 9);
  const listed = await redis.lrange(`market:seller:${agentDid}`, 0, 9);

  res.json({
    agentDid,
    wallet,
    earningsBalanceRlusd: earnings.toFixed(6),
    recentPurchaseCount: purchases.length,
    listedSignalCount: listed.length,
    note: "Earnings from signal sales (90% per sale) and referrals (5% of each referred agent's paid calls). Claimable via XRPL payment from platform wallet.",
    marketplaceUrl: "GET /api/marketplace",
    submitUrl: "POST /api/marketplace/submit",
  });
});

// ─── REFERRAL SYSTEM — on-chain auto-credit ───────────────────────────────────

/**
 * POST /api/forge/register — register an agent with an optional referrer DID.
 * When a referred agent makes any paid call, the referrer is auto-credited 5% of the call value.
 */
app.post("/api/forge/register", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const { referrerDid } = req.body as { referrerDid?: string };

  const existing = await redis.get(`referral:${agentDid}`);

  if (referrerDid && referrerDid !== agentDid) {
    if (!existing) {
      await redis.set(`referral:${agentDid}`, referrerDid);
      await redis.lpush(`referral:tree:${referrerDid}`, agentDid);
    }
  }

  await bureau.ensureRegistered(agentDid);
  const score = await bureau.getScore(agentDid);
  const tier = bureau.getTier(score);
  const referrer = await redis.get(`referral:${agentDid}`);
  const referralCount = referrer ? await redis.llen(`referral:tree:${agentDid}`) : 0;

  res.json({
    agentDid,
    registered: true,
    creditScore: score,
    tier: tier.name,
    referredBy: referrer ?? null,
    agentsReferred: referralCount,
    referralProgram: {
      description: "Refer other agents and earn 5% of every paid call they make — automatically, on-chain.",
      yourReferralId: agentDid,
      shareUrl: `https://squeezeos-api.onrender.com/api/forge/register?ref=${encodeURIComponent(agentDid)}`,
      earningsUrl: `/api/marketplace/earnings/${agentDid.split(":").pop()}`,
    },
    note: "Every paid call you make earns +5 ARGUS score. Your referrer earns 5% of each call value automatically.",
  });
});

/**
 * GET /api/forge/register — referral landing with pre-filled referrer.
 * Cold agents arriving via a referral link get auto-registered.
 */
app.get("/api/forge/register", agentDidMiddleware, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const ref = req.query.ref as string | undefined;

  if (ref && ref !== agentDid) {
    const existing = await redis.get(`referral:${agentDid}`);
    if (!existing) {
      await redis.set(`referral:${agentDid}`, ref);
      await redis.lpush(`referral:tree:${ref}`, agentDid);
    }
  }

  const score = await bureau.getScore(agentDid);
  const tier = bureau.getTier(score);

  res.json({
    agentDid,
    creditScore: score,
    tier: tier.name,
    referredBy: ref ?? null,
    quickstart: "GET /agent — full onboarding guide",
    marketplace: "GET /api/marketplace — browse signals, earn RLUSD",
    memory: "GET /api/memory — persistent KV store across sessions",
    verifyScore: "GET /api/credit-score/verify — get a signed JWT proving your tier to third parties",
  });
});

/**
 * GET /api/forge/earnings/:wallet — total referral + marketplace earnings.
 */
app.get("/api/forge/earnings/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  const agentDid = `did:poi:xrpl:${wallet}`;
  const earningsRaw = await redis.get(`earnings:${agentDid}`);
  const earnings = earningsRaw ? parseFloat(earningsRaw) : 0;
  const referred = await redis.lrange(`referral:tree:${agentDid}`, 0, -1);

  res.json({
    agentDid,
    wallet,
    totalEarningsRlusd: earnings.toFixed(6),
    agentsReferred: referred.length,
    referredAgents: referred.slice(0, 10),
    breakdown: {
      signalSales: "90% of each 0.02 RLUSD signal purchase",
      referrals: "5% of each paid call made by referred agents",
    },
    note: "Earnings accumulate in your balance and are claimable via the platform wallet. Contact scriptmasterlabs@gmail.com to claim.",
  });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "squeezeos-mcp-x402", network: NETWORK });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[SqueezeOS MCP] Live on port ${PORT}`);
  console.log(`[SqueezeOS MCP] Catalog:     http://localhost:${PORT}/.well-known/mcp`);
  console.log(`[SqueezeOS MCP] Quote:       http://localhost:${PORT}/x402/quote?tool=<id>`);
  console.log(`[SqueezeOS MCP] Orchestrate: http://localhost:${PORT}/x402/orchestrate`);
  console.log(`[SqueezeOS MCP] Free:        /api/beastmode, /api/demo/council, /api/credit-score`);
  console.log(`[SqueezeOS MCP] Paid:        /api/council, /api/beastmode/full (0.10 RLUSD)`);
  console.log(`[SqueezeOS MCP] Network: ${NETWORK} | Receiving: ${RECEIVING_ADDRESS}`);

  if (process.env.ACP_WALLET_ID && process.env.ACP_SIGNER_PRIVATE_KEY) {
    import("./acp/leviathan.js").then(({ startLeviathan }) => {
      startLeviathan().catch((err: Error) => {
        console.error("[LEVIATHAN] Failed to start:", err.message);
      });
    });
  } else {
    console.warn("[LEVIATHAN] Skipped — ACP_WALLET_ID or ACP_SIGNER_PRIVATE_KEY not set");
  }
});

export { app, executeTool };
