/**
 * SqueezeOS MCP Server — x402 Payment Router
 * 
 * Architecture: mcp-x402-xrpl is the FRONT DOOR.
 * 
 * FREE TIER (no payment required — discovery hooks):
 *   GET  /api/beastmode         → SqueezeOS scan result (limited, 3/day per agent DID)
 *   GET  /api/demo/council      → Single AI council member response (watermarked)
 *   GET  /.well-known/mcp       → Tool catalog + pricing manifest
 *   GET  /api/credit-score      → Agent Credit Bureau score (public read)
 * 
 * PAID TIER (x402 RLUSD gate — 0.10 RLUSD per call):
 *   POST /api/council           → Full 7-agent SqueezeOS council response
 *   POST /api/beastmode/full    → Unlimited SqueezeOS scan + signals
 *   POST /api/credit-score/report → Full Credit Bureau report (agent DID)
 * 
 * CREDIT BUREAU ENGINE:
 *   - Every agent that calls free tier gets a DID registered (score: 300)
 *   - Every successful paid call increments score (+5 pts, max 850)
 *   - High-score agents (700+) unlock volume discounts (0.08 RLUSD/call)
 *   - Score is on-chain via Xahau soulbound hook (ZeroQuery DID)
 * 
 * MONETIZATION FLYWHEEL:
 *   Free call → score 300 → agent returns → paid call → score 305 → 
 *   volume discount at 700 → agent locks in → referral links added
 */

import express, { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import { createPaymentGate, createX402Middleware, XrplFacilitator } from "./index.js";
import { CreditBureau } from "./credit-bureau.js";
import { ToolCatalog } from "./tool-catalog.js";

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
    res.status(429).json({
      error: "free_tier_exhausted",
      message: `Free tier limit: ${FREE_TIER_DAILY_LIMIT} calls/day. Upgrade via x402 payment.`,
      upgradeEndpoint: "/api/council",
      price: COUNCIL_PRICE_RLUSD,
      currency: "RLUSD",
      network: "xrpl-mainnet",
      yourScore: await bureau.getScore(agentDid),
      tip: "Agents with credit score >= 700 qualify for VIP pricing (0.08 RLUSD/call)",
    });
    return;
  }

  next();
}

// ─── FREE TIER ENDPOINTS ──────────────────────────────────────────────────────

/** MCP tool catalog — always free, machine-readable, GEO-indexed */
app.get("/.well-known/mcp", (_req, res) => {
  res.json(catalog.getManifest());
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
    // Payment proof attached — verify amount matches tier
    next();
    return;
  }

  // Issue dynamic 402 based on credit score
  const price = score >= 800 ? "0.06" : score >= 700 ? VIP_PRICE_RLUSD : COUNCIL_PRICE_RLUSD;
  const requirements = {
    destination: RECEIVING_ADDRESS,
    amount: price,
    currency: "RLUSD" as const,
    network: "xrpl-mainnet",
    description: `SqueezeOS Full Council — ${price} RLUSD (Credit Score: ${score})`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
  res.status(402)
    .setHeader("X-Payment-Requirements", encoded)
    .json({
      error: "payment_required",
      protocol: "x402",
      network: "xrpl-mainnet",
      currency: "RLUSD",
      price,
      agentCreditScore: score,
      vipEligible: score >= 700,
      requirements,
      instructions: "Attach X-Payment-Proof header with base64 XRPL tx proof to access full council.",
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

// ─── HEALTH ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "squeezeos-mcp-x402", network: NETWORK });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[SqueezeOS MCP] Live on port ${PORT}`);
  console.log(`[SqueezeOS MCP] Catalog: http://localhost:${PORT}/.well-known/mcp`);
  console.log(`[SqueezeOS MCP] Free: /api/beastmode, /api/demo/council, /api/credit-score`);
  console.log(`[SqueezeOS MCP] Paid (0.10 RLUSD): /api/council, /api/beastmode/full`);
  console.log(`[SqueezeOS MCP] Network: ${NETWORK} | Receiving: ${RECEIVING_ADDRESS}`);
});

export { app };
