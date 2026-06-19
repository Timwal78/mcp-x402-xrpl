/**
 * examples/pay-per-tool.js
 *
 * End-to-end demo: XRPL testnet x402 payment for a gated MCP tool.
 *
 * Run with:  node examples/pay-per-tool.js
 *
 * What this demonstrates:
 *   1. A "server" process that exposes a premium MCP tool gated by x402
 *   2. A "client" process (AI agent) that discovers the 402 challenge,
 *      signs an XRPL testnet payment, and gets the tool result back
 *
 * No real money moves — this uses XRPL testnet (faucet wallets).
 *
 * XRPL testnet faucet: https://xrpl.org/xrp-testnet-faucet.html
 */

import express from "express";
import { createPaymentGate, createX402Middleware, XrplFacilitator } from "../dist/index.js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

// These are throwaway testnet seeds. Do NOT use on mainnet.
const SERVER_WALLET_SEED = "sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r"; // receives payments
const CLIENT_WALLET_SEED = "sEd7bBmPMuK67xPZuGNZmiJ9YeZ1DqF"; // pays

const SERVER_PORT = 3402;
const TOOL_PRICE_DROPS = "100000"; // 0.1 XRP per call

// ─── SERVER ───────────────────────────────────────────────────────────────────

const server = express();
server.use(express.json());

// Expose the premium tool — gated with a 402 payment requirement
server.post(
  "/tools/xrp-price",
  createPaymentGate({
    destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", // testnet receiving addr
    amountDrops: TOOL_PRICE_DROPS,
    currency: "XRP",
    description: "Real-time XRP price feed — 0.1 XRP per query",
  }),
  (_req, res) => {
    // In a real integration, call an actual price API here
    res.json({
      tool: "xrp-price",
      result: {
        xrpUsd: 0.5234,
        xrpEur: 0.4812,
        timestamp: new Date().toISOString(),
        source: "scriptmasterlabs-demo",
      },
    });
  }
);

// MCP manifest
server.get("/.well-known/mcp", (_req, res) => {
  res.json({
    name: "mcp-x402-xrpl-demo",
    version: "0.1.0",
    protocol: "mcp/1.0",
    payment: { protocol: "x402", network: "xrpl-testnet", currency: "XRP" },
    tools: [
      {
        name: "xrp-price",
        description: "Real-time XRP/USD and XRP/EUR price feed",
        pricing: { amountDrops: TOOL_PRICE_DROPS, currency: "XRP" },
      },
    ],
  });
});

// ─── CLIENT (AI AGENT SIMULATION) ─────────────────────────────────────────────

async function runAgentDemo() {
  // Step 1: Agent queries the tool without payment
  console.log("\n[agent] → POST /tools/xrp-price (no payment)");
  const probe = await fetch(`http://localhost:${SERVER_PORT}/tools/xrp-price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "xrp_price" }),
  });

  console.log(`[agent] ← ${probe.status} ${probe.statusText}`);
  const challenge = await probe.json();
  console.log("[agent] Challenge received:", JSON.stringify(challenge.requirements, null, 2));

  if (probe.status !== 402) {
    console.error("[agent] Expected 402, got", probe.status);
    return;
  }

  // Step 2: Agent fulfils the payment on XRPL testnet
  console.log("\n[agent] Connecting to XRPL testnet to pay...");
  const facilitator = new XrplFacilitator({
    walletSeed: CLIENT_WALLET_SEED,
    network: "xrpl-testnet",
  });

  let proof;
  try {
    proof = await facilitator.pay(challenge.requirements);
    console.log("[agent] ✅ Payment settled. TxHash:", proof.txHash);
  } catch (err) {
    console.error("[agent] ❌ Payment failed:", err);
    console.log("\n💡 Fund your testnet wallet at: https://xrpl.org/xrp-testnet-faucet.html");
    return;
  }

  // Step 3: Agent retries with payment proof
  console.log("\n[agent] → POST /tools/xrp-price (with payment proof)");
  const proofHeader = Buffer.from(JSON.stringify(proof)).toString("base64");

  const paid = await fetch(`http://localhost:${SERVER_PORT}/tools/xrp-price`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment-Proof": proofHeader,
    },
    body: JSON.stringify({ query: "xrp_price" }),
  });

  console.log(`[agent] ← ${paid.status} ${paid.statusText}`);
  const result = await paid.json();
  console.log("[agent] Tool result:", JSON.stringify(result, null, 2));
  console.log("\n✅ End-to-end x402 XRPL payment flow complete!");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const httpServer = server.listen(SERVER_PORT, () => {
  console.log(`[server] MCP server running on http://localhost:${SERVER_PORT}`);
  console.log(`[server] Manifest: http://localhost:${SERVER_PORT}/.well-known/mcp`);
  console.log(`[server] Tool: /tools/xrp-price (costs ${TOOL_PRICE_DROPS} drops = 0.1 XRP)\n`);

  // Give the server a moment to bind, then run the agent demo
  setTimeout(() => {
    runAgentDemo()
      .catch(console.error)
      .finally(() => {
        console.log("\n[demo] Done. Stopping server.");
        httpServer.close();
      });
  }, 500);
});
