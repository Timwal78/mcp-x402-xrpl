/**
 * @scriptmasterlabs/mcp-x402 — Public API barrel
 *
 * Everything a consumer needs is exported from this single file.
 */

export { createX402Middleware, createPaymentGate, createQuoteHandler } from "./x402-middleware.js";
export type {
  X402MiddlewareOptions,
  PaymentGateOptions,
  PaymentRequirements,
  PaymentProof,
  QuoteConfig,
  QuoteToolSpec,
} from "./x402-middleware.js";

export { XrplFacilitator } from "./xrpl-facilitator.js";
export type { XrplFacilitatorOptions, XrplNetwork } from "./xrpl-facilitator.js";

export { wrapMcpServer } from "./mcp-wrapper.js";
export type { McpTool, McpToolWithPricing, McpServerOptions } from "./mcp-wrapper.js";

export { CreditBureau } from "./credit-bureau.js";
export type { AgentTier, AgentCreditReport, XahauAnchorConfig, ScoreAnchor } from "./credit-bureau.js";

export { ToolCatalog } from "./tool-catalog.js";
export type { ToolDefinition, ToolCatalogManifest, ToolPricing } from "./tool-catalog.js";

export { createOrchestrateHandler, WORKFLOWS } from "./orchestrate.js";
export type { OrchestrateRequest, OrchestrateHandlerOptions } from "./orchestrate.js";

export { verifyRlusdPayment, decodeProofHeader } from "./payment-verifier.js";
export type { PaymentProofClaim, VerificationResult } from "./payment-verifier.js";

export { startLeviathan, OFFERINGS } from "./acp/leviathan.js";
