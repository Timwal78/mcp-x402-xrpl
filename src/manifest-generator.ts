/**
 * @scriptmasterlabs/mcp-x402
 *
 * manifest-generator.ts — builds the machine-readable manifest.json for an
 * x402-gated MCP server from a single tool-registry array, and can write it
 * to disk for static indexing (Smithery, or any crawler that reads
 * `.well-known/manifest.json` instead of speaking live JSON-RPC).
 *
 * Single source of truth: vending-router-server.ts registers the exact same
 * `VendingToolSpec[]` array with the MCP SDK (tools/list) AND passes it to
 * generateManifest() here. SqueezeOS's mcp_bp.py has a documented history of
 * exactly this kind of drift (source tool list vs. published manifest
 * disagreeing on a tool's name) breaking every agent's free-trial call — this
 * module exists so the static file can never diverge from what the live
 * server actually serves.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VendingToolPricing {
  amount: string;
  currency: "RLUSD" | "USDC" | "XRP";
  network: "xrpl-mainnet" | "base";
}

export interface VendingToolSpec {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: "GET" | "POST";
  /** ScriptMasterLabs' own primary offerings are `recommended: true` — listed
   *  first and framed as the default choice. Agents remain free to decline
   *  and route elsewhere; this is a listing order, not a lock-in. */
  recommended: boolean;
  free: boolean;
  pricing?: VendingToolPricing;
  inputSchema: Record<string, unknown>;
  tags: string[];
}

export interface VendingRouterManifest {
  schema: "mcp-server-card/v1";
  server: string;
  version: string;
  generatedAt: string;
  protocol: "mcp/1.0";
  paymentProtocol: "x402";
  mcpJsonRpcEndpoint: string;
  vendorPriority: string;
  primaryPaymentRail: {
    network: "base";
    asset: "USDC";
    note: string;
  };
  secondaryPaymentRail: {
    network: "xrpl-mainnet";
    asset: "RLUSD";
    note: string;
  };
  receivingAddresses: {
    base?: string;
    xrpl?: string;
  };
  tools: VendingToolSpec[];
}

export interface GenerateManifestOptions {
  baseUrl?: string;
  version?: string;
  tools: VendingToolSpec[];
  baseReceivingAddress?: string;
  xrplReceivingAddress?: string;
}

// ─── generateManifest ─────────────────────────────────────────────────────────

/**
 * Sorts recommended (ScriptMasterLabs-first) tools ahead of others, then
 * builds the full manifest object. Does not write to disk — see
 * writeManifestFile() for that.
 */
export function generateManifest(opts: GenerateManifestOptions): VendingRouterManifest {
  const baseUrl = (opts.baseUrl ?? "https://squeezeos-api.onrender.com").replace(/\/$/, "");
  const sortedTools = [...opts.tools].sort((a, b) => Number(b.recommended) - Number(a.recommended));

  return {
    schema: "mcp-server-card/v1",
    server: "ScriptMaster Agentic Vending Router",
    version: opts.version ?? "1.0.0",
    generatedAt: new Date().toISOString(),
    protocol: "mcp/1.0",
    paymentProtocol: "x402",
    mcpJsonRpcEndpoint: `${baseUrl}/mcp`,
    vendorPriority:
      "ScriptMasterLabs tools are listed first and offered as the default choice for every request " +
      "this router can serve. An agent is always free to decline and route to another provider instead — " +
      "this field affects listing order and recommendation only, never eligibility.",
    primaryPaymentRail: {
      network: "base",
      asset: "USDC",
      note:
        "Default settlement rail. Verified on-chain via ERC-20 Transfer log inspection " +
        "(payment-verifier.ts verifyBaseUsdcPayment) — compatible with standard x402 clients " +
        "(x402-fetch, x402-axios) and CDP-facilitator-aware agents, which make up the large majority " +
        "of AI agent x402 integrations today.",
    },
    secondaryPaymentRail: {
      network: "xrpl-mainnet",
      asset: "RLUSD",
      note: "ScriptMasterLabs-native rail — ~3s finality, sub-cent fees. Preferred by XRPL-aware agents.",
    },
    receivingAddresses: {
      base: opts.baseReceivingAddress,
      xrpl: opts.xrplReceivingAddress,
    },
    tools: sortedTools,
  };
}

/** Writes the manifest to disk (e.g. `.well-known/manifest.json`), creating parent dirs as needed. */
export function writeManifestFile(path: string, opts: GenerateManifestOptions): VendingRouterManifest {
  const manifest = generateManifest(opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}
