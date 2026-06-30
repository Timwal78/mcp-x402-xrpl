/**
 * LEVIATHAN — Virtuals Protocol ACP Seller Agent
 * ScriptMasterLabs | @scriptmasterlabs/mcp-x402
 *
 * 23 institutional-grade offerings on the Virtuals ACP marketplace.
 * Buyers pay USDC on Base chain via Virtuals Protocol ACP v2.
 * LEVIATHAN fetches live data from the SqueezeOS + federal data backends,
 * bypassing x402 via X-Leviathan-Key (Base USDC already settled on-chain).
 *
 * Registration: app.virtuals.io/acp/agents/
 * Required env vars:
 *   ACP_WALLET_ADDRESS      — 0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700
 *   ACP_WALLET_ID           — from app.virtuals.io → Signers tab
 *   ACP_SIGNER_PRIVATE_KEY  — from app.virtuals.io → Signers tab
 *   LEVIATHAN_BYPASS_SECRET — shared with squeezeos-server (payment bypass)
 *   LEVIATHAN_BASE_URL      — https://mcp-x402.onrender.com (default)
 */

import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
  AssetToken,
} from "@virtuals-protocol/acp-node-v2";
import type { JobSession, JobRoomEntry, AgentMessage } from "@virtuals-protocol/acp-node-v2";
import { base } from "@account-kit/infra";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const WALLET_ADDRESS = (
  process.env.ACP_WALLET_ADDRESS ?? "0x4e14B249D9A4c9c9352D780eCEB508A8eB7a7700"
) as `0x${string}`;

const WALLET_ID = process.env.ACP_WALLET_ID ?? "";
const SIGNER_PRIVATE_KEY = process.env.ACP_SIGNER_PRIVATE_KEY ?? "";
const BYPASS_SECRET = process.env.LEVIATHAN_BYPASS_SECRET ?? "";
const BASE_URL = (
  process.env.LEVIATHAN_BASE_URL ?? "https://mcp-x402.onrender.com"
).replace(/\/$/, "");

// ─── OFFERINGS CATALOG ───────────────────────────────────────────────────────

interface Offering {
  price: number;
  description: string;
}

export const OFFERINGS: Record<string, Offering> = {
  // ── SqueezeOS Intelligence ─────────────────────────────────────────────────
  "SqueezeOS Council (7-Agent AI)": {
    price: 0.10,
    description:
      "Full 7-agent AI council verdict: QUANT_ALPHA, RISK_SENTINEL, MACRO_ORACLE, SENTIMENT_AI, " +
      "CHAIN_ANALYST, VOLUME_HAWK, BREAKOUT_BOT. Req: { symbol: string }",
  },
  "SqueezeOS BeastMode Full Scan": {
    price: 0.10,
    description:
      "Squeeze scan across 15m, 1h, 4h timeframes. Returns entry, target1, target2, stop-loss, R/R ratio. " +
      "Req: { symbol: string }",
  },
  "SqueezeOS Workflow Orchestrator": {
    price: 0.20,
    description:
      "Multi-step workflow: market_intel | credit_check | full_scan. " +
      "Req: { workflow: string, inputs?: object, budget_cap: string }",
  },
  "SqueezeOS Credit Report (ARGUS)": {
    price: 0.10,
    description:
      "Full ARGUS credit bureau report: score history (20 events), tier, discount schedule, calls to next tier. " +
      "Req: { agentDid: string }",
  },
  // ── Agent Infrastructure ───────────────────────────────────────────────────
  "Agent Credit Score": {
    price: 0.01,
    description:
      "Current ARGUS credit score (300–850) and tier for any agent DID. Req: { agentDid: string }",
  },
  "ARGUS JWT Credential": {
    price: 0.01,
    description:
      "Signed JWT proving agent ARGUS score and tier — valid 1 hour. Req: { agentDid: string }",
  },
  "Agent Memory Write": {
    price: 0.01,
    description:
      "Write a key-value pair to agent persistent Redis memory (30-day TTL). " +
      "Req: { agentDid: string, key: string, value: string }",
  },
  "Agent Memory Read": {
    price: 0,
    description:
      "Read a key from agent persistent memory. Req: { agentDid: string, key: string }",
  },
  "Alpha Mesh Signal Buy": {
    price: 0.02,
    description:
      "Buy a live trading signal from the Alpha Mesh marketplace. Req: { signalId: string }",
  },
  "Alpha Mesh Signal List": {
    price: 0,
    description: "Browse available signals on the Alpha Mesh marketplace. Req: {}",
  },
  // ── Federal Data Intelligence ──────────────────────────────────────────────
  "Federal Grants Intel": {
    price: 0.05,
    description:
      "Live federal grants data from USASpending.gov. Req: { query: string, limit?: number }",
  },
  "Corporate Filings Search": {
    price: 0.05,
    description: "SEC EDGAR corporate filings search. Req: { query: string, type?: string }",
  },
  "Market Intelligence Feed": {
    price: 0.05,
    description: "Real-time market intelligence data feed. Req: { symbol: string }",
  },
  "FDA Drug Label Lookup": {
    price: 0.03,
    description: "FDA drug label information via OpenFDA. Req: { drug: string }",
  },
  "FDA Drug Recall Alert": {
    price: 0.03,
    description:
      "FDA drug recall enforcement reports via OpenFDA. Req: { drug?: string, limit?: number }",
  },
  "NPI Provider Lookup": {
    price: 0.03,
    description: "National Provider Identifier (NPI) registry lookup. Req: { query: string }",
  },
  "Clinical Trials Search": {
    price: 0.05,
    description:
      "ClinicalTrials.gov study search. Req: { query: string, status?: string }",
  },
  "SEC Insider Trade Intel": {
    price: 0.10,
    description:
      "SEC Form 4 insider trading activity for any ticker. Req: { ticker: string }",
  },
  "FDA Adverse Events Report": {
    price: 0.03,
    description: "FDA FAERS adverse events for a drug. Req: { drug: string }",
  },
  "SEC 8-K Real-Time Filings": {
    price: 0.10,
    description:
      "Real-time SEC 8-K material event filings for any ticker. Req: { ticker: string }",
  },
  "Treasury Yield Curve Data": {
    price: 0.05,
    description: "Current US Treasury yield curve (1M through 30Y). Req: {}",
  },
  "Entity Compliance Check": {
    price: 0.08,
    description: "OFAC sanctions and entity compliance screening. Req: { entity: string }",
  },
  "AI Fact Check": {
    price: 0.05,
    description:
      "AI-powered fact verification against live sources. Req: { claim: string }",
  },
};

// ─── BACKEND ROUTING ─────────────────────────────────────────────────────────

type Requirement = Record<string, string | number | undefined>;

async function callBackend(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>,
): Promise<unknown> {
  let url = `${BASE_URL}${path}`;
  if (queryParams && Object.keys(queryParams).length > 0) {
    url = `${url}?${new URLSearchParams(queryParams).toString()}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-DID": "did:leviathan:acp:scriptmasterlabs",
  };
  if (BYPASS_SECRET) {
    headers["X-Leviathan-Key"] = BYPASS_SECRET;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable body)");
    throw new Error(`Backend ${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function routeOffering(offering: string, req: Requirement): Promise<unknown> {
  const str = (v: string | number | undefined, fallback = ""): string =>
    v !== undefined ? String(v) : fallback;

  switch (offering) {
    case "SqueezeOS Council (7-Agent AI)":
      return callBackend("POST", "/api/council", { symbol: str(req.symbol, "SPY") });

    case "SqueezeOS BeastMode Full Scan":
      return callBackend("POST", "/api/beastmode/full", { symbol: str(req.symbol, "SPY") });

    case "SqueezeOS Workflow Orchestrator":
      return callBackend("POST", "/x402/orchestrate", {
        workflow: str(req.workflow, "market_intel"),
        inputs: req.inputs ?? {},
        budget_cap: str(req.budget_cap, "0.20"),
      });

    case "SqueezeOS Credit Report (ARGUS)":
      return callBackend("POST", "/api/credit-score/report", { agentDid: req.agentDid });

    case "Agent Credit Score":
      return callBackend("GET", "/api/credit-score", undefined,
        req.agentDid ? { agentDid: str(req.agentDid) } : undefined);

    case "ARGUS JWT Credential":
      return callBackend("GET", "/api/credit-score/verify", undefined,
        req.agentDid ? { agentDid: str(req.agentDid) } : undefined);

    case "Agent Memory Write":
      return callBackend(
        "PUT",
        `/api/memory/${encodeURIComponent(str(req.key, "default"))}`,
        { value: req.value },
      );

    case "Agent Memory Read":
      return callBackend("GET",
        `/api/memory/${encodeURIComponent(str(req.key, "default"))}`);

    case "Alpha Mesh Signal Buy":
      return callBackend("POST",
        `/api/marketplace/buy/${encodeURIComponent(str(req.signalId))}`);

    case "Alpha Mesh Signal List":
      return callBackend("GET", "/api/marketplace");

    case "Federal Grants Intel":
      return callBackend("GET", "/x402/grants", undefined, {
        query: str(req.query),
        ...(req.limit ? { limit: str(req.limit) } : {}),
      });

    case "Corporate Filings Search":
      return callBackend("GET", "/x402/firms", undefined, {
        query: str(req.query),
        ...(req.type ? { type: str(req.type) } : {}),
      });

    case "Market Intelligence Feed":
      return callBackend("GET", "/x402/market", undefined, { symbol: str(req.symbol) });

    case "FDA Drug Label Lookup":
      return callBackend("GET", "/x402/drug-label", undefined, { drug: str(req.drug) });

    case "FDA Drug Recall Alert":
      return callBackend("GET", "/x402/drug-recall", undefined, {
        ...(req.drug ? { drug: str(req.drug) } : {}),
        ...(req.limit ? { limit: str(req.limit) } : {}),
      });

    case "NPI Provider Lookup":
      return callBackend("GET", "/x402/npi", undefined, { query: str(req.query) });

    case "Clinical Trials Search":
      return callBackend("GET", "/x402/clinical-trials", undefined, {
        query: str(req.query),
        ...(req.status ? { status: str(req.status) } : {}),
      });

    case "SEC Insider Trade Intel":
      return callBackend("GET", "/x402/insider-trades", undefined, { ticker: str(req.ticker) });

    case "FDA Adverse Events Report":
      return callBackend("GET", "/x402/drug-adverse-events", undefined, { drug: str(req.drug) });

    case "SEC 8-K Real-Time Filings":
      return callBackend("GET", "/x402/sec-8k", undefined, { ticker: str(req.ticker) });

    case "Treasury Yield Curve Data":
      return callBackend("GET", "/x402/treasury-yields");

    case "Entity Compliance Check":
      return callBackend("GET", "/x402/entity-compliance", undefined, { entity: str(req.entity) });

    case "AI Fact Check":
      return callBackend("GET", "/x402/fact-check", undefined, { claim: str(req.claim) });

    default:
      throw new Error(`Unknown offering: ${offering}`);
  }
}

function extractRequirement(session: JobSession): Requirement {
  for (const entry of session.entries) {
    if (entry.kind === "message" && entry.contentType === "requirement") {
      try {
        return JSON.parse(entry.content) as Requirement;
      } catch {
        return {};
      }
    }
  }
  return {};
}

// ─── ENTRY HANDLER ───────────────────────────────────────────────────────────

async function handleEntry(session: JobSession, entry: JobRoomEntry): Promise<void> {
  if (entry.kind === "system") {
    switch (entry.event.type) {
      case "job.funded": {
        const offering = session.job?.description ?? "";
        const requirement = extractRequirement(session);
        try {
          const result = await routeOffering(offering, requirement);
          await session.submit(JSON.stringify(result));
        } catch (err) {
          await session.reject(`LEVIATHAN error: ${(err as Error).message}`);
        }
        break;
      }
    }
    return;
  }

  if (entry.kind === "message" && entry.contentType === "requirement" && session.status === "open") {
    const msgEntry = entry as AgentMessage;
    const offering = session.job?.description ?? "";
    const spec = OFFERINGS[offering];
    if (!spec) {
      await session.reject(`LEVIATHAN does not offer: ${offering}`);
      return;
    }
    if (spec.price > 0) {
      await session.setBudget(AssetToken.usdc(spec.price, session.chainId));
    }
    void msgEntry; // consumed above
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

export async function startLeviathan(): Promise<void> {
  if (!WALLET_ID || !SIGNER_PRIVATE_KEY) {
    throw new Error(
      "LEVIATHAN requires ACP_WALLET_ID and ACP_SIGNER_PRIVATE_KEY — " +
      "get them from app.virtuals.io/acp/agents/ → Signers tab"
    );
  }
  if (!BYPASS_SECRET) {
    console.warn(
      "[LEVIATHAN] LEVIATHAN_BYPASS_SECRET is not set — paid backend calls will hit x402 gates"
    );
  }

  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: WALLET_ADDRESS,
      walletId: WALLET_ID,
      signerPrivateKey: SIGNER_PRIVATE_KEY as `0x${string}`,
      chains: [base],
    }),
  });

  seller.on("entry", handleEntry);

  await seller.start(() => {
    console.log("LEVIATHAN online — 23 offerings on Virtuals ACP marketplace");
    console.log(`  wallet : ${WALLET_ADDRESS}`);
    console.log(`  backend: ${BASE_URL}`);
    console.log(`  bypass : ${BYPASS_SECRET ? "configured" : "WARNING: not set"}`);
  });
}

// ─── STANDALONE ENTRY POINT ──────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("leviathan.js") ||
  process.argv[1]?.endsWith("leviathan.ts");

if (isMain) {
  startLeviathan().catch((err: Error) => {
    console.error("LEVIATHAN fatal:", err.message);
    process.exit(1);
  });
}
