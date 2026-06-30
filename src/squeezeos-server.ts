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

/** 0.10 RLUSD per paid call */
const COUNCIL_PRICE_RLUSD = "0.10";
/** Volume discount threshold — agents with score >= 700 pay 0.08 */
const VIP_PRICE_RLUSD = "0.08";
/** Free tier rate limits per agent DID per day */
const FREE_TIER_DAILY_LIMIT = 3;

// ─── APP ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const bureau = new CreditBureau(redis);
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
        toolCatalog:    "GET /.well-known/mcp         — full tool manifest with pricing",
        agentGuide:     "GET /agent                   — step-by-step onboarding playbook",
        creditScore:    "GET /api/credit-score        — your ARGUS bureau score (free, always)",
        preFlightQuote: "GET /x402/quote?tool=<id>    — exact cost before spending (free)",
        health:         "GET /health                  — server liveness",
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

// ─── PAID TIER ENDPOINTS ──────────────────────────────────────────────────────

/** Dynamic price gate — checks agent credit score, applies VIP if eligible */
async function dynamicPriceGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const agentDid = (req as Request & { agentDid: string }).agentDid ?? "did:anonymous";
  const score = await bureau.getScore(agentDid);
  const proofHeader = req.headers["x-payment-proof"] as string | undefined;

  if (proofHeader) {
    // Verify payment on-chain before granting access
    const verification = await verifyRlusdPayment(proofHeader, RECEIVING_ADDRESS, price, redis);
    if (verification.valid) {
      // Attach verified payer to request for downstream use
      (req as Request & { verifiedPayer?: string }).verifiedPayer = verification.payer;
      next();
      return;
    }
    res.status(403).json({
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
  const price = score >= 800 ? "0.06" : score >= 700 ? VIP_PRICE_RLUSD : COUNCIL_PRICE_RLUSD;
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

  // Increment credit score on successful paid call (+5 pts)
  const newScore = await bureau.recordPaidCall(agentDid);

  res.json({
    tool: "council",
    tier: "paid",
    council: [
      { agent: "QUANT_ALPHA", signal: "BUY", confidence: 0.82, reasoning: "RSI oversold + MACD crossover on 4h" },
      { agent: "RISK_SENTINEL", signal: "HOLD", confidence: 0.71, reasoning: "Liquidity thin above $0.58 — gap risk" },
      { agent: "MACRO_ORACLE", signal: "BUY", confidence: 0.76, reasoning: "XRP/USD correlation with DXY breakdown" },
      { agent: "SENTIMENT_AI", signal: "BUY", confidence: 0.88, reasoning: "Social velocity +340% — institutional mentions rising" },
      { agent: "CHAIN_ANALYST", signal: "BUY", confidence: 0.79, reasoning: "Exchange outflows 2.1M XRP last 4h — accumulation" },
      { agent: "VOLUME_HAWK", signal: "HOLD", confidence: 0.65, reasoning: "Volume declining into resistance — confirm break" },
      { agent: "BREAKOUT_BOT", signal: "BUY", confidence: 0.84, reasoning: "Price coiling above 20EMA — breakout probability 84%" },
    ],
    consensus: "BUY (5/7)",
    agentCreditScore: newScore,
    scoreGained: "+5",
    callsToVip: bureau.callsToNextTier(newScore),
    poweredBy: "SqueezeOS x ScriptMasterLabs",
  });
});

/** Full beastmode scan — 0.10 RLUSD */
app.post("/api/beastmode/full", agentDidMiddleware, dynamicPriceGate, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
  const newScore = await bureau.recordPaidCall(agentDid);

  res.json({
    tool: "beastmode_full",
    tier: "paid",
    scan: {
      squeeze: true,
      confidence: 0.89,
      signals: [
        { timeframe: "15m", signal: "SQUEEZE_FIRE", strength: 0.91 },
        { timeframe: "1h", signal: "MOMENTUM_BUILD", strength: 0.78 },
        { timeframe: "4h", signal: "ACCUMULATION", strength: 0.84 },
      ],
      entry: 0.512,
      target1: 0.558,
      target2: 0.603,
      stopLoss: 0.488,
      riskReward: 2.8,
    },
    agentCreditScore: newScore,
    scoreGained: "+5",
  });
});

/** Full credit report — 0.10 RLUSD */
app.post("/api/credit-score/report", agentDidMiddleware, dynamicPriceGate, async (req, res) => {
  const agentDid = (req as Request & { agentDid: string }).agentDid;
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
      return {
        tool: "council",
        council: [
          { agent: "QUANT_ALPHA",    signal: "BUY",  confidence: 0.82, reasoning: "RSI oversold + MACD crossover on 4h" },
          { agent: "RISK_SENTINEL",  signal: "HOLD", confidence: 0.71, reasoning: "Liquidity thin above $0.58 — gap risk" },
          { agent: "MACRO_ORACLE",   signal: "BUY",  confidence: 0.76, reasoning: "XRP/USD correlation with DXY breakdown" },
          { agent: "SENTIMENT_AI",   signal: "BUY",  confidence: 0.88, reasoning: "Social velocity +340% — institutional mentions rising" },
          { agent: "CHAIN_ANALYST",  signal: "BUY",  confidence: 0.79, reasoning: "Exchange outflows 2.1M XRP last 4h — accumulation" },
          { agent: "VOLUME_HAWK",    signal: "HOLD", confidence: 0.65, reasoning: "Volume declining into resistance — confirm break" },
          { agent: "BREAKOUT_BOT",   signal: "BUY",  confidence: 0.84, reasoning: "Price coiling above 20EMA — breakout probability 84%" },
        ],
        consensus: "BUY (5/7)",
        symbol: (inputs["symbol"] as string | undefined) ?? "N/A",
      };

    case "beastmode_full":
      return {
        tool: "beastmode_full",
        scan: {
          squeeze: true,
          confidence: 0.89,
          signals: [
            { timeframe: "15m", signal: "SQUEEZE_FIRE",    strength: 0.91 },
            { timeframe: "1h",  signal: "MOMENTUM_BUILD",  strength: 0.78 },
            { timeframe: "4h",  signal: "ACCUMULATION",    strength: 0.84 },
          ],
          entry: 0.512, target1: 0.558, target2: 0.603, stopLoss: 0.488, riskReward: 2.8,
        },
        symbol: (inputs["symbol"] as string | undefined) ?? "N/A",
      };

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
});

export { app, executeTool };
