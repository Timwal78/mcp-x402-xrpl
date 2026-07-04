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
  // ── SqueezeOS proprietary signals (squeezeos-api, X-API-Key) ───────────────
  "squeezeos_council_7_agent_ai": { price: 0.10, description: "Full 7-agent AI council verdict for an equity symbol. Req: { symbol: string }" },
  "squeezeos_beastmode_full_scan": { price: 0.10, description: "BeastMode multi-engine full scan for an equity symbol. Req: { symbol: string }" },
  "squeezeos_triple_lock_signal": { price: 0.05, description: "SML Triple Lock three-engine consensus (LOCKED BULL / LOCKED BEAR / FORMING / UNLOCKED). Req: { symbol: string }" },
  "squeezeos_squeeze_signal_741_ema": { price: 0.02, description: "741-EMA stack alignment signal with squeeze_alert flag. Req: { symbol: string }" },
  "squeezeos_full_scanner": { price: 0.05, description: "Full composite signal — 741 + 365 + TripleLock in one verdict. Req: { symbol: string }" },
  "squeezeos_max_conviction_rare_signal": { price: 0.25, description: "TRIPLE_LOCK_VERDICT — BULL/BEAR only when macro stretch, dark-pool kinetics, and ribbon harmonics all agree; else NO_TRIPLE_LOCK. Req: { symbol: string }" },
  "squeezeos_oracle_directive": { price: 0.15, description: "Aggregated oracle directive across all SqueezeOS engines for a symbol. Req: { symbol: string }" },
  // ── SEC / EDGAR (mcp-x402 /x402 routes, X-Leviathan-Key bypass) ────────────
  "sec_insider_trade_intel": { price: 0.20, description: "SEC Form 4 insider trading activity for any ticker. Req: { ticker: string }" },
  "sec_8k_real_time_filings": { price: 0.25, description: "Real-time SEC 8-K material event filings for any ticker. Req: { ticker: string }" },
  "sec_13f_institutional_holdings": { price: 0.25, description: "SEC 13F institutional holdings. Req: { cik: string } or { name: string }" },
  "sec_13dg_activist_filings": { price: 0.20, description: "SEC 13D/G activist stake filings for a ticker. Req: { ticker: string }" },
  "sec_10q_quarterly_filing": { price: 0.15, description: "SEC 10-Q quarterly filings for a ticker. Req: { ticker: string }" },
  "sec_10k_annual_filing": { price: 0.20, description: "SEC 10-K annual filings for a ticker. Req: { ticker: string }" },
  // ── FDA / health (openFDA + CMS) ──────────────────────────────────────────
  "fda_drug_recall_alert": { price: 0.08, description: "FDA drug recall enforcement reports via openFDA. Req: { drug: string, limit?: number }" },
  "fda_adverse_events_report": { price: 0.08, description: "FDA FAERS adverse events for a drug. Req: { drug: string }" },
  "fda_warning_letters": { price: 0.10, description: "FDA warning letters issued to a company. Req: { company: string }" },
  "cms_medicare_provider_data": { price: 0.10, description: "CMS Medicare provider enrollment data. Req: { name: string }" },
  // ── Regulatory / compliance / federal transparency ────────────────────────
  "entity_compliance_check": { price: 0.35, description: "SAM.gov registration + exclusion flag + set-asides + NAICS. Req: { uei: string } or { cage: string }" },
  "epa_environmental_violations": { price: 0.12, description: "EPA ECHO environmental violations for a facility. Req: { facility: string }" },
  "osha_inspection_records": { price: 0.10, description: "OSHA workplace inspection records. Req: { establishment: string } or { naics: string }" },
  "lobbying_disclosures": { price: 0.15, description: "Senate/House lobbying disclosures. Req: { client: string } or { registrant: string }" },
  "fec_campaign_finance": { price: 0.10, description: "FEC campaign finance records. Req: { name: string }" },
  "finra_brokercheck": { price: 0.15, description: "FINRA BrokerCheck firm/individual records. Req: { name: string }" },
  "patent_search": { price: 0.10, description: "USPTO patent search. Req: { assignee: string } or { query: string }" },
  "ai_fact_check": { price: 0.15, description: "Grounding oracle — fact-checks a claim against live government/FDA/SEC/Treasury data. Req: { claim: string, domain?: string }" },
  "agent_credit_score": { price: 0.20, description: "AI agent FICO-style reputation score (300–850). Req: { agent_id: string, action?: \"get\"|\"report\" }" },
  "market_intelligence_feed": { price: 0.30, description: "Federal contract market intelligence by NAICS (USAspending). Req: { naics: string, years?: number }" },
  "corporate_filings_search": { price: 0.08, description: "SAM.gov set-aside firm finder by NAICS. Req: { naics: string, state?: string, set_aside?: string }" },
  // ── FTD / dark-pool mechanics (SqueezeOS FTD engine) ──────────────────────
  "ftd_ratio": { price: 0.03, description: "FTD-to-volume ratio for a symbol. Req: { symbol: string }" },
  "ftd_threshold_list": { price: 0.02, description: "Current Reg SHO threshold securities list. Req: {}" },
  "ftd_time_series": { price: 0.02, description: "FTD time series for a symbol. Req: { symbol: string, limit?: number }" },
  "ftd_etf_basket_concentration": { price: 0.05, description: "FTD concentration across an ETF basket. Req: { etf: string }" },
  "ftd_settlement_cycle": { price: 0.05, description: "Settlement-cycle FTD pressure for a symbol. Req: { symbol: string }" },
  // ── Options / signals / trust ─────────────────────────────────────────────
  "options_flow_intelligence": { price: 0.05, description: "Institutional options flow — sweeps, whale detection, unusual volume, dark-pool prints. Req: { symbol?: string }" },
  "cascade_accumulator_signal": { price: 0.25, description: "CASCADE ACCUMULATOR directive — ACCUMULATE/PYRAMID/EXIT/STOP for a symbol. Req: { symbol: string }" },
  "iam_inevitable_action_model": { price: 0.05, description: "Inevitable Action Model — obligation committee verdict + Truth Layer state for a symbol. Req: { symbol: string }" },
  "content_wallet_trust_score": { price: 0.01, description: "Content misinformation trust scoring + on-chain wallet trust ledger. Req: { content: string, sender_wallet?: string }" },
  // ── Bank compliance swarm (higher-value institutional) ────────────────────
  "compliance_anomaly_report": { price: 5.00, description: "Submit a bank compliance anomaly to the Leviathan Matrix swarm for scoring. Req: { bank_id, agent_id, trigger, detail, severity? }" },
  "compliance_bank_audit": { price: 5.00, description: "Full Leviathan Matrix compliance audit cycle for a bank. Req: { bank_id: string }" },
  "compliance_regulator_query": { price: 2.50, description: "Real-time regulator compliance dashboard query for a bank. Req: { bank_id: string }" },
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

  const q = (obj: Record<string, string | number | undefined>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== "") out[k] = String(v);
    return out;
  };

  switch (offering) {
    // ── SqueezeOS signals — squeezeos-api host, X-API-Key ─────────────────────
    case "squeezeos_triple_lock_signal":
      return callSqueezeOS(`/api/signals/triplelock/${sym(req.symbol)}`);
    case "squeezeos_squeeze_signal_741_ema":
      return callSqueezeOS(`/api/signals/741/${sym(req.symbol)}`);
    case "squeezeos_full_scanner":
      return callSqueezeOS(`/api/signals/full/${sym(req.symbol)}`);
    case "squeezeos_oracle_directive":
      return callSqueezeOS(`/api/oracle/${sym(req.symbol)}`);

    // ── SqueezeOS council/beastmode — mcp-x402 /api, bypass ───────────────────
    case "squeezeos_council_7_agent_ai":
      return callBackend("POST", "/api/council", { symbol: sym(req.symbol) });
    case "squeezeos_beastmode_full_scan":
      return callBackend("POST", "/api/beastmode/full", { symbol: sym(req.symbol) });

    // ── SqueezeOS proprietary /x402 signals (POST symbol), bypass ─────────────
    case "squeezeos_max_conviction_rare_signal":
      return callBackend("POST", "/x402/max-conviction-signal", { symbol: sym(req.symbol) });
    case "cascade_accumulator_signal":
      return callBackend("POST", "/x402/cascade-signal", { symbol: sym(req.symbol) });
    case "iam_inevitable_action_model":
      return callBackend("GET", "/x402/iam-model", undefined, { symbol: sym(req.symbol) });
    case "options_flow_intelligence":
      return callBackend("GET", "/x402/options-flow", undefined, q({ symbol: req.symbol }));

    // ── SEC / EDGAR — mcp-x402 /x402, bypass ──────────────────────────────────
    case "sec_insider_trade_intel":
      return callBackend("GET", "/x402/insider-trades", undefined, { ticker: sym(req.ticker) });
    case "sec_8k_real_time_filings":
      return callBackend("GET", "/x402/sec-8k", undefined, { ticker: sym(req.ticker) });
    case "sec_13f_institutional_holdings":
      return callBackend("GET", "/x402/sec-13f", undefined, q({ cik: req.cik, name: req.name }));
    case "sec_13dg_activist_filings":
      return callBackend("GET", "/x402/sec-13dg", undefined, { ticker: sym(req.ticker) });
    case "sec_10q_quarterly_filing":
      return callBackend("GET", "/x402/sec-10q", undefined, q({ ticker: req.ticker, limit: req.limit }));
    case "sec_10k_annual_filing":
      return callBackend("GET", "/x402/sec-10k", undefined, q({ ticker: req.ticker, limit: req.limit }));

    // ── FDA / CMS ─────────────────────────────────────────────────────────────
    case "fda_drug_recall_alert":
      return callBackend("GET", "/x402/drug-recall", undefined, q({ drug: req.drug, limit: req.limit }));
    case "fda_adverse_events_report":
      return callBackend("GET", "/x402/drug-adverse-events", undefined, { drug: str(req.drug) });
    case "fda_warning_letters":
      return callBackend("GET", "/x402/fda-warnings", undefined, { company: str(req.company) });
    case "cms_medicare_provider_data":
      return callBackend("GET", "/x402/cms-providers", undefined, { name: str(req.name) });

    // ── Regulatory / federal transparency ─────────────────────────────────────
    case "entity_compliance_check":
      return callBackend("GET", "/x402/entity-compliance", undefined, q({ uei: req.uei, cage: req.cage }));
    case "epa_environmental_violations":
      return callBackend("GET", "/x402/epa-violations", undefined, { facility: str(req.facility) });
    case "osha_inspection_records":
      return callBackend("GET", "/x402/osha", undefined, q({ establishment: req.establishment, naics: req.naics }));
    case "lobbying_disclosures":
      return callBackend("GET", "/x402/lobbying", undefined, q({ client: req.client, registrant: req.registrant }));
    case "fec_campaign_finance":
      return callBackend("GET", "/x402/fec-finance", undefined, { name: str(req.name) });
    case "finra_brokercheck":
      return callBackend("GET", "/x402/finra-broker", undefined, { name: str(req.name) });
    case "patent_search":
      return callBackend("GET", "/x402/patents", undefined, q({ assignee: req.assignee, query: req.query }));
    case "ai_fact_check":
      return callBackend("GET", "/x402/fact-check", undefined, q({ claim: req.claim, domain: req.domain }));
    case "agent_credit_score":
      return callBackend("GET", "/x402/agent-score", undefined, q({ agent_id: req.agent_id ?? req.agentDid, action: req.action }));
    case "market_intelligence_feed":
      return callBackend("GET", "/x402/market", undefined, q({ naics: req.naics, years: req.years }));
    case "corporate_filings_search":
      return callBackend("GET", "/x402/firms", undefined, q({ naics: req.naics, state: req.state, set_aside: req.set_aside }));

    // ── FTD engine ────────────────────────────────────────────────────────────
    case "ftd_ratio":
      return callBackend("GET", "/x402/ftd-ratio", undefined, { symbol: sym(req.symbol) });
    case "ftd_threshold_list":
      return callBackend("GET", "/x402/ftd-threshold-list");
    case "ftd_time_series":
      return callBackend("GET", "/x402/ftd-time-series", undefined, q({ symbol: sym(req.symbol), limit: req.limit }));
    case "ftd_etf_basket_concentration":
      return callBackend("GET", "/x402/ftd-etf-basket", undefined, { etf: sym(req.etf, "SPY") });
    case "ftd_settlement_cycle":
      return callBackend("GET", "/x402/ftd-settlement-cycle", undefined, { symbol: sym(req.symbol) });

    // ── Content trust ─────────────────────────────────────────────────────────
    case "content_wallet_trust_score":
      return callBackend("POST", "/x402/content-trust-score", q({ content: req.content, sender_wallet: req.sender_wallet }));

    // ── Bank compliance swarm ─────────────────────────────────────────────────
    case "compliance_anomaly_report":
      return callBackend("POST", "/x402/compliance-anomaly", q({
        bank_id: req.bank_id, agent_id: req.agent_id, trigger: req.trigger, detail: req.detail, severity: req.severity,
      }));
    case "compliance_bank_audit":
      return callBackend("POST", "/x402/compliance-audit", { bank_id: str(req.bank_id) });
    case "compliance_regulator_query":
      return callBackend("GET", "/x402/compliance-regulator-query", undefined, { bank_id: str(req.bank_id) });

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
