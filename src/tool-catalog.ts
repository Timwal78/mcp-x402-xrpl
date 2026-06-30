/**
 * @scriptmasterlabs/mcp-x402
 *
 * tool-catalog.ts — Machine-readable tool manifest for /.well-known/mcp
 *
 * Returns a structured catalog of every tool exposed by the SqueezeOS MCP
 * server: name, description, pricing, payment requirements, rate limits, and
 * idempotency support. This is the pre-flight discovery contract an agent
 * reads before spending any funds.
 *
 * Schema: compatible with MCP server-card v1 and AgentCard tool manifest.
 * Pricing facts sourced from: DEVELOPER_MANIFESTO.md (ScriptMasterLabs).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolPricing {
  amount: string;
  currency: "RLUSD" | "USDC" | "XRP" | "free";
  network: "xrpl-mainnet" | "base" | "none";
  vipAmount?: string;
  platinumAmount?: string;
  discountCurve: "ARGUS_BUREAU" | "none";
}

export interface ToolRateLimit {
  windowSeconds: number;
  requestsPerWindow: number;
  tier: "free" | "paid" | "vip" | "platinum";
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: "GET" | "POST";
  tier: "free" | "paid";
  pricing: ToolPricing;
  idempotent: boolean;
  idempotencyKeyHeader?: string;
  quotePath?: string;
  rateLimits: ToolRateLimit[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tags: string[];
}

export interface ToolCatalogManifest {
  schema: "mcp-server-card/v1";
  server: string;
  version: string;
  generatedAt: string;
  paymentProtocol: "x402";
  primaryNetwork: "xrpl-mainnet";
  receivingAddress: string;
  quoteEndpoint: string;
  orchestrateEndpoint: string;
  tools: ToolDefinition[];
  loyalty: {
    bureau: string;
    tiers: Array<{ name: string; minScore: number; priceRlusd: string; benefit: string }>;
  };
}

// ─── ToolCatalog ─────────────────────────────────────────────────────────────

export class ToolCatalog {
  private readonly receivingAddress: string;
  private readonly baseUrl: string;

  constructor(
    receivingAddress: string = process.env.XRPL_RECEIVING_ADDRESS ?? "",
    baseUrl: string = process.env.BASE_URL ?? "https://squeezeos-api.onrender.com"
  ) {
    this.receivingAddress = receivingAddress;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getManifest(): ToolCatalogManifest {
    return {
      schema: "mcp-server-card/v1",
      server: "@scriptmasterlabs/mcp-x402 — SqueezeOS Signal OS",
      version: "2.1.1",
      generatedAt: new Date().toISOString(),
      paymentProtocol: "x402",
      primaryNetwork: "xrpl-mainnet",
      receivingAddress: this.receivingAddress,
      quoteEndpoint: `${this.baseUrl}/x402/quote`,
      orchestrateEndpoint: `${this.baseUrl}/x402/orchestrate`,
      tools: this.buildTools(),
      loyalty: {
        bureau: "ARGUS Agent Credit Bureau (300–850)",
        tiers: [
          { name: "PROTOSTAR", minScore: 300, priceRlusd: "0.10", benefit: "Free tier access" },
          { name: "NEUTRON",   minScore: 500, priceRlusd: "0.10", benefit: "Standard paid access" },
          { name: "PULSAR",    minScore: 700, priceRlusd: "0.08", benefit: "VIP — 20% discount" },
          { name: "QUASAR",    minScore: 800, priceRlusd: "0.06", benefit: "Platinum — 40% discount + priority routing" },
        ],
      },
    };
  }

  private buildTools(): ToolDefinition[] {
    return [
      // ── Free tools ────────────────────────────────────────────────────────
      {
        id: "beastmode_preview",
        name: "SqueezeOS Beastmode Preview",
        description: "Free limited squeeze scan — top signal only, 3 calls/day per agent DID. Watermarked.",
        endpoint: "/api/beastmode",
        method: "GET",
        tier: "free",
        pricing: { amount: "0", currency: "free", network: "none", discountCurve: "none" },
        idempotent: true,
        rateLimits: [{ windowSeconds: 86400, requestsPerWindow: 3, tier: "free" }],
        tags: ["squeeze", "signals", "free", "market-intelligence"],
      },
      {
        id: "council_demo",
        name: "SqueezeOS Council Demo",
        description: "Single AI council member response (RISK_SENTINEL), watermarked. Free, 3/day.",
        endpoint: "/api/demo/council",
        method: "GET",
        tier: "free",
        pricing: { amount: "0", currency: "free", network: "none", discountCurve: "none" },
        idempotent: true,
        rateLimits: [{ windowSeconds: 86400, requestsPerWindow: 3, tier: "free" }],
        tags: ["council", "ai", "free", "market-intelligence"],
      },
      {
        id: "credit_score_read",
        name: "Agent Credit Score",
        description: "Public read of this agent DID's ARGUS credit score (300–850). Always free.",
        endpoint: "/api/credit-score",
        method: "GET",
        tier: "free",
        pricing: { amount: "0", currency: "free", network: "none", discountCurve: "none" },
        idempotent: true,
        rateLimits: [{ windowSeconds: 60, requestsPerWindow: 60, tier: "free" }],
        tags: ["credit", "bureau", "free", "identity"],
      },
      // ── Paid tools ────────────────────────────────────────────────────────
      {
        id: "council_full",
        name: "SqueezeOS Full Council (7-Agent)",
        description: "Full 7-agent AI council verdict. Price determined by agent ARGUS credit score. Idempotent within 60s window.",
        endpoint: "/api/council",
        method: "POST",
        tier: "paid",
        pricing: {
          amount: "0.10",
          currency: "RLUSD",
          network: "xrpl-mainnet",
          vipAmount: "0.08",
          platinumAmount: "0.06",
          discountCurve: "ARGUS_BUREAU",
        },
        idempotent: true,
        idempotencyKeyHeader: "X-Idempotency-Key",
        quotePath: "/x402/quote?tool=council_full",
        rateLimits: [
          { windowSeconds: 60,    requestsPerWindow: 60,  tier: "paid" },
          { windowSeconds: 60,    requestsPerWindow: 120, tier: "vip" },
          { windowSeconds: 60,    requestsPerWindow: 200, tier: "platinum" },
        ],
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Ticker symbol (e.g. GME, AMC, XRP)" },
          },
        },
        tags: ["council", "ai", "paid", "market-intelligence", "signals"],
      },
      {
        id: "beastmode_full",
        name: "SqueezeOS Beastmode Full Scan",
        description: "Unlimited squeeze scan across all timeframes with entry/target/stop levels.",
        endpoint: "/api/beastmode/full",
        method: "POST",
        tier: "paid",
        pricing: {
          amount: "0.10",
          currency: "RLUSD",
          network: "xrpl-mainnet",
          vipAmount: "0.08",
          platinumAmount: "0.06",
          discountCurve: "ARGUS_BUREAU",
        },
        idempotent: true,
        idempotencyKeyHeader: "X-Idempotency-Key",
        quotePath: "/x402/quote?tool=beastmode_full",
        rateLimits: [
          { windowSeconds: 60, requestsPerWindow: 30, tier: "paid" },
          { windowSeconds: 60, requestsPerWindow: 60, tier: "vip" },
        ],
        tags: ["squeeze", "scan", "paid", "signals", "market-intelligence"],
      },
      {
        id: "credit_report_full",
        name: "Agent Credit Bureau Full Report",
        description: "Full ARGUS credit report including history, tier, discount schedule, and call log.",
        endpoint: "/api/credit-score/report",
        method: "POST",
        tier: "paid",
        pricing: {
          amount: "0.10",
          currency: "RLUSD",
          network: "xrpl-mainnet",
          vipAmount: "0.08",
          platinumAmount: "0.06",
          discountCurve: "ARGUS_BUREAU",
        },
        idempotent: true,
        idempotencyKeyHeader: "X-Idempotency-Key",
        quotePath: "/x402/quote?tool=credit_report_full",
        rateLimits: [{ windowSeconds: 3600, requestsPerWindow: 10, tier: "paid" }],
        tags: ["credit", "bureau", "paid", "identity", "report"],
      },
      {
        id: "orchestrate",
        name: "x402 Workflow Orchestrator",
        description: "Execute a multi-step tool workflow with a single payment and budget cap. Chains internal tools in order, returns unified result.",
        endpoint: "/x402/orchestrate",
        method: "POST",
        tier: "paid",
        pricing: {
          amount: "variable",
          currency: "RLUSD",
          network: "xrpl-mainnet",
          discountCurve: "ARGUS_BUREAU",
        },
        idempotent: true,
        idempotencyKeyHeader: "X-Idempotency-Key",
        quotePath: "/x402/quote?tool=orchestrate",
        rateLimits: [{ windowSeconds: 60, requestsPerWindow: 10, tier: "paid" }],
        inputSchema: {
          type: "object",
          required: ["workflow", "budget_cap"],
          properties: {
            workflow: {
              type: "string",
              enum: ["market_intel", "credit_check", "full_scan"],
              description: "Named workflow to execute",
            },
            inputs: { type: "object", description: "Workflow-specific inputs (e.g. symbol, agentDid)" },
            budget_cap: { type: "string", description: "Max RLUSD spend for this workflow (e.g. '0.50')" },
          },
        },
        tags: ["orchestrate", "workflow", "paid", "multi-step"],
      },
    ];
  }
}
