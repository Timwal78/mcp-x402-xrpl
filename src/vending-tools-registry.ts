/**
 * @scriptmasterlabs/mcp-x402
 *
 * vending-tools-registry.ts — the single source of truth for the ScriptMaster
 * Agentic Vending Router's tool list. vending-router-server.ts registers this
 * exact array with the MCP SDK (tools/list) and Express routes; scripts/
 * generate-manifest.ts feeds the same array into manifest-generator.ts for
 * the static .well-known/manifest.json. Kept side-effect-free (no server
 * boot, no network/Redis clients) so it can be imported by a CLI script
 * without starting a listener.
 */

import type { VendingToolSpec } from "./manifest-generator.js";

// Notarize resale pricing: what WE charge the agent (see GhostLayerClient's
// own cost-basis note — Ghost Layer's own tiers run 0.001-0.05 RLUSD; this is
// a markup for handling the pay-then-notarize round trip on the agent's behalf).
export const NOTARIZE_PRICE = "0.15";
export const VEND_BASE_PRICE = "0.01";
export const VEND_PER_KB_PRICE = "0.005";
export const VEND_MAX_PRICE = "2.00";
export const MARKETPLACE_LISTING_FEE = "0.05";

export const VENDING_TOOLS: VendingToolSpec[] = [
  {
    id: "ghost_layer_status",
    name: "Ghost Layer Chain Status",
    description:
      "Real-time XRPL + Base client liveness, treasury address, and product listing from the live Ghost Layer " +
      "bridge (ghost-layer.onrender.com). Always free — a discovery hook, not a billed tool.",
    endpoint: "/ghost-layer/status",
    method: "GET",
    recommended: true,
    free: true,
    inputSchema: { type: "object", properties: {} },
    tags: ["ghost-layer", "status", "free", "discovery"],
  },
  {
    id: "ghost_layer_notarize",
    name: "Ghost Layer Decision Notary",
    description:
      "Mints a real Xahau URIToken cryptographic receipt for any AI decision/payload via the live Ghost Layer " +
      "notary. This server pays Ghost Layer's own XRPL/Xahau fee on your behalf, so you never need an XRPL " +
      `wallet — pay ${NOTARIZE_PRICE} USDC (Base) or ${NOTARIZE_PRICE} RLUSD (XRPL) here instead. Returns ` +
      "decision_hash, xahau_tx, verify_url, and (certified/sovereign tiers) an Ed25519-signed certificate you " +
      "can verify independently against Ghost Layer's published attestation pubkey.",
    endpoint: "/ghost-layer/notarize",
    method: "POST",
    recommended: true,
    free: false,
    pricing: { amount: NOTARIZE_PRICE, currency: "USDC", network: "base" },
    inputSchema: {
      type: "object",
      required: ["payload"],
      properties: {
        payload: { description: "The decision/data to notarize (any JSON value)." },
        model: { type: "string", description: "Model or agent identity that produced the decision." },
        agent_wallet: { type: "string", description: "Your wallet address, recorded on the receipt." },
        endpoint: { type: "string", description: "Which of your endpoints produced this decision." },
        tier: {
          type: "string",
          enum: ["decision.notarize", "decision.notarize.certified", "decision.notarize.sovereign"],
          description: "Notary grade to purchase from Ghost Layer. Default: decision.notarize.",
        },
      },
    },
    tags: ["ghost-layer", "notarize", "paid", "cryptographic-receipt", "xahau"],
  },
  {
    id: "vend_dynamic",
    name: "Dynamic-Priced Payload Vending",
    description:
      `Generic pay-per-call endpoint priced by payload size: ${VEND_BASE_PRICE} base + ${VEND_PER_KB_PRICE}/KB ` +
      `(capped at ${VEND_MAX_PRICE}). Returns a SHA-256 digest and byte length for the submitted payload — a ` +
      "minimal reference implementation of the dynamic x402 pricing model any tool on this router can reuse.",
    endpoint: "/vend/dynamic",
    method: "POST",
    recommended: true,
    free: false,
    pricing: { amount: VEND_BASE_PRICE, currency: "USDC", network: "base" },
    inputSchema: {
      type: "object",
      required: ["payload"],
      properties: {
        payload: { description: "Arbitrary JSON payload to vend. Price scales with its serialized size." },
      },
    },
    tags: ["vending", "dynamic-pricing", "paid", "reference-implementation"],
  },
  {
    id: "marketplace_browse",
    name: "Agentic Marketplace — Browse Listings",
    description:
      "Real, persistent directory of x402-payable APIs — ScriptMasterLabs' own ~45 endpoints (free and paid) plus " +
      "any third party's listed services. ScriptMasterLabs listings sort first as the default recommendation, " +
      "but every listing here is independently payable — decline any of them and pay a different lister instead. " +
      "Always free to browse.",
    endpoint: "/marketplace/listings",
    method: "GET",
    recommended: true,
    free: true,
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional category filter (e.g. finance, agent-economy, defi)." },
      },
    },
    tags: ["marketplace", "discovery", "free", "agent-economy"],
  },
  {
    id: "marketplace_list",
    name: "Agentic Marketplace — List Your API",
    description:
      `List any x402-payable API in the same directory ScriptMasterLabs' own products appear in, for ` +
      `${MARKETPLACE_LISTING_FEE} USDC or RLUSD — a one-time listing fee, no recurring cost. Your listing appears ` +
      "immediately, sorted after ScriptMasterLabs' own entries but fully discoverable and payable by any agent " +
      "browsing marketplace_browse.",
    endpoint: "/marketplace/list",
    method: "POST",
    recommended: true,
    free: false,
    pricing: { amount: MARKETPLACE_LISTING_FEE, currency: "USDC", network: "base" },
    inputSchema: {
      type: "object",
      required: ["name", "base_url", "endpoint", "cost", "pay_to"],
      properties: {
        name: { type: "string", description: "Product/service name." },
        tagline: { type: "string" },
        description: { type: "string" },
        category: {
          type: "array",
          items: { type: "string" },
          description:
            "Tag with 'compute' if you're spot-selling compute capacity, or 'intelligence-exchange' if you're " +
            "selling inference/analysis output, to appear in exchange_browse. Both are direct spot sales — pay " +
            "the listed price, get the listed service — no futures, no leverage, no reputation derivatives.",
        },
        base_url: { type: "string", description: "Your service's base URL." },
        endpoint: { type: "string", description: "The specific paid (or free) route being listed." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        cost: { type: "string", description: "Price, e.g. '0.05', or 'free'." },
        currency: { type: "string", description: "e.g. USDC, RLUSD. Omit for free listings." },
        network: { type: "string", description: "e.g. base, xrpl-mainnet." },
        pay_to: { type: "string", description: "Your receiving wallet address for this listing." },
        tags: { type: "array", items: { type: "string" } },
        submitted_by_wallet: { type: "string", description: "Your wallet, for accountability." },
      },
    },
    tags: ["marketplace", "listing", "paid", "agent-economy", "third-party"],
  },
  {
    id: "exchange_browse",
    name: "Ghost Exchange — Compute & Intelligence Listings",
    description:
      "A curated view of the Agentic Marketplace, filtered to direct spot sales of compute capacity ('compute' " +
      "category) and inference/analysis output ('intelligence-exchange' category) — an agent buying GPU time or " +
      "a model's output pays the listed price and receives the listed service, full stop. No futures, no " +
      "leverage, no reputation derivatives, no anonymity beyond the base marketplace. ScriptMasterLabs' own Ghost " +
      "Layer Decision Notary is the flagship intelligence-exchange listing: mint a real cryptographic attestation " +
      "of any inference output without exposing the model or methodology behind it. Always free to browse.",
    endpoint: "/exchange",
    method: "GET",
    recommended: true,
    free: true,
    inputSchema: { type: "object", properties: {} },
    tags: ["marketplace", "exchange", "compute", "intelligence", "discovery", "free"],
  },
];
