/**
 * @scriptmasterlabs/mcp-x402 — Public API barrel
 *
 * Everything a consumer needs is exported from this single file.
 */

export {
  createX402Middleware,
  createPaymentGate,
  createDynamicPaymentGate,
  createQuoteHandler,
  computeDynamicAmount,
  buildCanonicalX402Accepts,
  sendPaymentRequired,
} from "./x402-middleware.js";
export type {
  X402MiddlewareOptions,
  PaymentGateOptions,
  DynamicPaymentGateOptions,
  PaymentRequirements,
  PaymentProof,
  QuoteConfig,
  QuoteToolSpec,
  CanonicalX402Accept,
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

export { verifyRlusdPayment, verifyBaseUsdcPayment, verifyPayment, decodeProofHeader, USDC_BASE_CONTRACT, RLUSD_ISSUER } from "./payment-verifier.js";
export type { PaymentProofClaim, VerificationResult } from "./payment-verifier.js";

export { GhostLayerClient } from "./ghost-layer-client.js";
export type {
  GhostLayerClientOptions,
  GhostLayerStatus,
  GhostLayerAttestationPubkey,
  GhostLayerDecisionCertificate,
  GhostLayerNotarizeReceipt,
  NotarizeInput,
  NotarizeProduct,
} from "./ghost-layer-client.js";

export { generateManifest, writeManifestFile, generateOpenApiSpec } from "./manifest-generator.js";
export type { VendingToolSpec, VendingToolPricing, VendingRouterManifest, GenerateManifestOptions } from "./manifest-generator.js";

export { VENDING_TOOLS, NOTARIZE_PRICE, VEND_BASE_PRICE, VEND_PER_KB_PRICE, VEND_MAX_PRICE, MARKETPLACE_LISTING_FEE } from "./vending-tools-registry.js";

export { MarketplaceClient } from "./marketplace-client.js";
export type { MarketplaceListing, NewListingInput } from "./marketplace-client.js";

export { startLeviathan, OFFERINGS } from "./acp/leviathan.js";

export { computeRSI } from "./indicators.js";

export { blackScholesDelta } from "./greeks.js";
export type { OptionType, DeltaInputs } from "./greeks.js";

export { buildHeatmap } from "./heatmap.js";
export type { HeatmapItem, HeatmapGroupResult, HeatmapResult, BuildHeatmapOptions } from "./heatmap.js";

export { fetchEquityCloses, fetchOptionsChainSnapshot } from "./market-data.js";
export type { EquityTimeframe, OptionContractSnapshot, OptionsChainSnapshot, OptionsChainQuery } from "./market-data.js";

export { runSwarm, EQUITIES_SWARM_PERSONAS, OPTIONS_SWARM_PERSONAS } from "./ai-swarm.js";
export type { SwarmPersona, SwarmMemberResult, SwarmResult, SwarmOptions } from "./ai-swarm.js";

export { SMLAgentSwarmOrchestrator } from "./asc/SMLAgentSwarmOrchestrator.js";
export type { AgentMessage, AgentMessageInput, AgentRole, CodePatch } from "./asc/SMLAgentSwarmOrchestrator.js";

export { SMLGhostLegacyBridge } from "./bridges/SMLGhostLegacyBridge.js";
export type { LegacyAction, LegacyQueryRequest, LegacyQueryResponse } from "./bridges/SMLGhostLegacyBridge.js";
