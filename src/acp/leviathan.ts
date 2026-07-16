/**
 * LEVIATHAN — Virtuals Protocol ACP Seller Agent
 * ScriptMasterLabs | @scriptmasterlabs/mcp-x402
 *
 * STALE / NOT DEPLOYED — this repo's Render service (`scriptmaster-vending-router`,
 * see render.yaml) runs `start:vending-router` → src/vending-router-server.ts,
 * which never imports this file. The only wiring for this file is
 * src/squeezeos-server.ts (`npm start`), which is not what Render actually runs.
 * The live LEVIATHAN agent is SML_Portfolio/mcp-x402/src/server/acp/leviathan.ts
 * (Render service `mcp-x402`, wallet 0x0f035c36c4ce65a6f1bf4370f779bac722d59004,
 * 54 offerings, Title-Case job names) — see SqueezeOS/CLAUDE.md,
 * "LEVIATHAN / Virtuals ACP Marketplace" section, for the full investigation.
 * Do not treat the wallet default, offering count, or snake_case job names
 * below as current.
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
// SqueezeOS signal endpoints (/api/signals/*) live on a separate host and
// authenticate with X-API-Key (the SqueezeOS OPERATOR_API_KEY), not the
// x402 bypass header used for the mcp-x402 federal-data routes.
const SQUEEZEOS_BASE = (
  process.env.SQUEEZEOS_API_BASE ?? "https://squeezeos-api.onrender.com"
).replace(/\/$/, "");
const SML_API_KEY = process.env.SML_API_KEY ?? "";

// ─── OFFERINGS CATALOG ───────────────────────────────────────────────────────

interface Offering {
  price: number;
  description: string;
}

// Keys are the EXACT snake_case job names registered on the Virtuals ACP
// marketplace — the seller matches session.job.description against these, so
// they must be byte-for-byte identical to the registered "Job Name". Prices
// mirror the registered price so budget negotiation matches. Only jobs backed
// by a real, live backend route appear here; anything else would require
// fabricating data, which is prohibited.
export const OFFERINGS: Record<string, Offering> = {
  // ── SqueezeOS proprietary signals (squeezeos-api.onrender.com, X-API-Key) ──
  "squeezeos_council_7_agent_ai": {
    price: 0.10,
    description:
      "Full 7-agent AI council verdict for an equity symbol. Req: { symbol: string }",
  },
  "squeezeos_beastmode_full_scan": {
    price: 0.10,
    description:
      "BeastMode multi-engine full scan for an equity symbol. Req: { symbol: string }",
  },
  "squeezeos_triple_lock_signal": {
    price: 0.05,
    description:
      "SML Triple Lock three-engine consensus (LOCKED BULL / LOCKED BEAR / FORMING / UNLOCKED). " +
      "Req: { symbol: string }",
  },
  "squeezeos_squeeze_signal_741_ema": {
    price: 0.02,
    description:
      "741-EMA stack alignment signal with squeeze_alert flag " +
      "(BULLISH HIGHWAY / BEARISH HIGHWAY / CONSOLIDATION). Req: { symbol: string }",
  },
  "squeezeos_full_scanner": {
    price: 0.05,
    description:
      "Full composite signal — 741 + 365 + TripleLock in one verdict. Req: { symbol: string }",
  },
  // ── Federal / regulatory data (mcp-x402 x402 routes, X-Leviathan-Key bypass) ─
  "sec_insider_trade_intel": {
    price: 0.20,
    description: "SEC Form 4 insider trading activity for any ticker. Req: { ticker: string }",
  },
  "sec_8k_real_time_filings": {
    price: 0.25,
    description: "Real-time SEC 8-K material event filings for any ticker. Req: { ticker: string }",
  },
  "fda_drug_recall_alert": {
    price: 0.08,
    description:
      "FDA drug recall enforcement reports via openFDA. Req: { drug: string, limit?: number }",
  },
  "fda_adverse_events_report": {
    price: 0.08,
    description: "FDA FAERS adverse events for a drug. Req: { drug: string }",
  },
  "ai_fact_check": {
    price: 0.15,
    description:
      "Grounding oracle — fact-checks a claim against live government/FDA/SEC/Treasury data. " +
      "Req: { claim: string, domain?: string }",
  },
  "entity_compliance_check": {
    price: 0.35,
    description:
      "SAM.gov registration status + exclusion flag + set-aside types + NAICS. " +
      "Req: { uei: string } or { cage: string }",
  },
  "agent_credit_score": {
    price: 0.20,
    description:
      "AI agent FICO-style reputation score (300–850). " +
      "Req: { agent_id: string, action?: \"get\"|\"report\" }",
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

// SqueezeOS signal endpoints — separate host, X-API-Key auth, symbol in path.
async function callSqueezeOS(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (SML_API_KEY) headers["X-API-Key"] = SML_API_KEY;

  const res = await fetch(`${SQUEEZEOS_BASE}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable body)");
    throw new Error(`SqueezeOS GET ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// Ticker/symbol sanitizer for path segments.
const sym = (v: string | number | undefined, fallback = "SPY"): string =>
  (v !== undefined ? String(v) : fallback).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || fallback;

async function routeOffering(offering: string, req: Requirement): Promise<unknown> {
  const str = (v: string | number | undefined, fallback = ""): string =>
    v !== undefined ? String(v) : fallback;

  switch (offering) {
    // ── SqueezeOS proprietary signals (squeezeos-api, X-API-Key) ─────────────
    case "squeezeos_council_7_agent_ai":
      return callBackend("POST", "/api/council", { symbol: sym(req.symbol) });

    case "squeezeos_beastmode_full_scan":
      return callBackend("POST", "/api/beastmode/full", { symbol: sym(req.symbol) });

    case "squeezeos_triple_lock_signal":
      return callSqueezeOS(`/api/signals/triplelock/${sym(req.symbol)}`);

    case "squeezeos_squeeze_signal_741_ema":
      return callSqueezeOS(`/api/signals/741/${sym(req.symbol)}`);

    case "squeezeos_full_scanner":
      return callSqueezeOS(`/api/signals/full/${sym(req.symbol)}`);

    // ── Federal / regulatory data (mcp-x402 x402 routes, bypass header) ──────
    case "sec_insider_trade_intel":
      return callBackend("GET", "/x402/insider-trades", undefined, { ticker: sym(req.ticker) });

    case "sec_8k_real_time_filings":
      return callBackend("GET", "/x402/sec-8k", undefined, { ticker: sym(req.ticker) });

    case "fda_drug_recall_alert":
      return callBackend("GET", "/x402/drug-recall", undefined, {
        drug: str(req.drug),
        ...(req.limit ? { limit: str(req.limit) } : {}),
      });

    case "fda_adverse_events_report":
      return callBackend("GET", "/x402/drug-adverse-events", undefined, { drug: str(req.drug) });

    case "ai_fact_check":
      return callBackend("GET", "/x402/fact-check", undefined, {
        claim: str(req.claim),
        ...(req.domain ? { domain: str(req.domain) } : {}),
      });

    case "entity_compliance_check":
      return callBackend("GET", "/x402/entity-compliance", undefined, {
        ...(req.uei ? { uei: str(req.uei) } : {}),
        ...(req.cage ? { cage: str(req.cage) } : {}),
      });

    case "agent_credit_score":
      return callBackend("GET", "/x402/agent-score", undefined, {
        agent_id: str(req.agent_id ?? req.agentDid),
        ...(req.action ? { action: str(req.action) } : {}),
      });

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

// Resolve the Virtuals job name to an OFFERINGS key. Exact match first (the
// registered names are clean snake_case), then a case-insensitive fallback so
// a minor casing drift on the marketplace side still routes instead of rejects.
function resolveOffering(raw: string): string | undefined {
  if (OFFERINGS[raw]) return raw;
  const norm = raw.trim().toLowerCase();
  for (const key of Object.keys(OFFERINGS)) {
    if (key.toLowerCase() === norm) return key;
  }
  return undefined;
}

async function handleEntry(session: JobSession, entry: JobRoomEntry): Promise<void> {
  if (entry.kind === "system") {
    switch (entry.event.type) {
      case "job.funded": {
        const offering = resolveOffering(session.job?.description ?? "");
        if (!offering) {
          await session.reject(`LEVIATHAN does not offer: ${session.job?.description ?? ""}`);
          break;
        }
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
    const offering = resolveOffering(session.job?.description ?? "");
    if (!offering) {
      await session.reject(`LEVIATHAN does not offer: ${session.job?.description ?? ""}`);
      return;
    }
    const spec = OFFERINGS[offering]!;
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

  if (!SML_API_KEY) {
    console.warn(
      "[LEVIATHAN] SML_API_KEY is not set — squeezeos_* signal jobs will fail auth"
    );
  }

  await seller.start(() => {
    console.log(`LEVIATHAN online — ${Object.keys(OFFERINGS).length} offerings on Virtuals ACP marketplace`);
    console.log(`  wallet  : ${WALLET_ADDRESS}`);
    console.log(`  backend : ${BASE_URL}`);
    console.log(`  squeeze : ${SQUEEZEOS_BASE}`);
    console.log(`  bypass  : ${BYPASS_SECRET ? "configured" : "WARNING: not set"}`);
    console.log(`  apikey  : ${SML_API_KEY ? "configured" : "WARNING: not set"}`);
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
