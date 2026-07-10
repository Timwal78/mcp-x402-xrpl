import express from "express";
import { SMLAgentSwarmOrchestrator } from "./SMLAgentSwarmOrchestrator.js";
import { SMLGhostLegacyBridge } from "../bridges/SMLGhostLegacyBridge.js";

/**
 * Persistent Node/Express entry for Render (see render.yaml's
 * sml-asc-orchestrator service). Unlike src/asc/worker-entry.ts, this one
 * also serves the Ghost legacy bridge, since that needs a real filesystem
 * and child_process — neither exists on Cloudflare Workers.
 */
const PORT = Number(process.env.PORT ?? 3404);
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const ORCHESTRATOR_PRIVATE_KEY = process.env.ORCHESTRATOR_PRIVATE_KEY;
const BOND_CONTRACT_ADDRESS = process.env.BOND_CONTRACT_ADDRESS;
const LEGACY_BRIDGE_SANDBOX = process.env.LEGACY_BRIDGE_SANDBOX ?? "/tmp/sml-ghost-bridge-sandbox";

if (!BASE_RPC_URL || !ORCHESTRATOR_PRIVATE_KEY || !BOND_CONTRACT_ADDRESS) {
  throw new Error(
    "Missing required env vars: BASE_RPC_URL, ORCHESTRATOR_PRIVATE_KEY, BOND_CONTRACT_ADDRESS. " +
      "Set them on the sml-asc-orchestrator Render service before starting."
  );
}

const orchestrator = new SMLAgentSwarmOrchestrator(BASE_RPC_URL, ORCHESTRATOR_PRIVATE_KEY, BOND_CONTRACT_ADDRESS);
const legacyBridge = new SMLGhostLegacyBridge(LEGACY_BRIDGE_SANDBOX);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "sml-asc-orchestrator" });
});

app.post("/message", async (req, res) => {
  try {
    await orchestrator.routeSecureMessage(req.body);
    res.status(202).json({ status: "routed" });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/legacy-bridge", async (req, res) => {
  const result = await legacyBridge.executeLegacyBridge(req.body);
  res.status(result.success ? 200 : 502).json(result);
});

app.listen(PORT, () => {
  console.log(`[SML ASC Orchestrator] listening on :${PORT}`);
});
