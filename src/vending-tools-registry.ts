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
];
