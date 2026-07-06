#!/usr/bin/env -S npx tsx
/**
 * Regenerates .well-known/manifest.json for the ScriptMaster Agentic Vending
 * Router from the same VENDING_TOOLS registry vending-router-server.ts
 * registers with the MCP SDK — run this after adding/changing a tool so the
 * static file served to crawlers (Smithery, etc.) never drifts from what the
 * live /mcp JSON-RPC endpoint actually serves.
 *
 * Usage: npm run generate:manifest
 */

import { writeManifestFile } from "../src/manifest-generator.js";
import { VENDING_TOOLS } from "../src/vending-tools-registry.js";

const outPath = new URL("../.well-known/manifest.json", import.meta.url).pathname;

const manifest = writeManifestFile(outPath, {
  baseUrl: process.env.PUBLIC_BASE_URL ?? "https://squeezeos-api.onrender.com",
  tools: VENDING_TOOLS,
  baseReceivingAddress: process.env.BASE_RECEIVING_ADDRESS,
  xrplReceivingAddress: process.env.XRPL_RECEIVING_ADDRESS,
});

console.log(`Wrote ${manifest.tools.length} tools to ${outPath}`);
