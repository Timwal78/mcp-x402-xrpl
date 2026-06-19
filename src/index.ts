/**
 * @scriptmasterlabs/mcp-x402 — Public API barrel
 *
 * Everything a consumer needs is exported from this single file.
 */

export { createX402Middleware, createPaymentGate } from "./x402-middleware.js";
export type { X402MiddlewareOptions, PaymentGateOptions, PaymentRequirements, PaymentProof } from "./x402-middleware.js";

export { XrplFacilitator } from "./xrpl-facilitator.js";
export type { XrplFacilitatorOptions, XrplNetwork } from "./xrpl-facilitator.js";

export { wrapMcpServer } from "./mcp-wrapper.js";
export type { McpTool, McpToolWithPricing, McpServerOptions } from "./mcp-wrapper.js";
