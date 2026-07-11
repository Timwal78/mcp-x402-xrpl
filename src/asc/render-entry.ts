import express from "express";
import { SMLAgentSwarmOrchestrator } from "./SMLAgentSwarmOrchestrator.js";
import { SMLGhostLegacyBridge } from "../bridges/SMLGhostLegacyBridge.js";
import { AnthropicAgentClient } from "./llm-agent.js";

/**
 * Persistent Node/Express entry for Render (see render.yaml's
 * sml-asc-orchestrator service — currently removed from render.yaml after
 * a crash-loop, since none of these env vars have been set on Render yet.
 * Re-add that service block only once they actually are). Unlike
 * src/asc/worker-entry.ts, this one also serves the Ghost legacy bridge,
 * since that needs a real filesystem and child_process — neither exists on
 * Cloudflare Workers.
 */
const PORT = Number(process.env.PORT ?? 3404);
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const ORCHESTRATOR_PRIVATE_KEY = process.env.ORCHESTRATOR_PRIVATE_KEY;
const BOND_CONTRACT_ADDRESS = process.env.BOND_CONTRACT_ADDRESS;
const LEGACY_BRIDGE_SANDBOX = process.env.LEGACY_BRIDGE_SANDBOX ?? "/tmp/sml-ghost-bridge-sandbox";

// BYOK — bring your own Anthropic API key. Unset by default: the swarm runs
// in deterministic (no real judgment, just pattern rules) mode until this is
// set. Never a shared/platform key — this is billed directly to whichever
// key is configured here.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || undefined;

// Fully autonomous "set it and forget it" loop: the CEO agent periodically
// reads real on-chain bond state and recent message history and decides
// whether anything needs doing, with no human triggering each cycle.
// Requires ANTHROPIC_API_KEY — there is no deterministic equivalent (a timer
// that pattern-matches nothing would do nothing every tick).
const ASC_AUTONOMOUS = (process.env.ASC_AUTONOMOUS ?? "false").toLowerCase() === "true";
// Every tick is a real, billed Claude API call. Default is deliberately
// slow (10 minutes) so this doesn't run up API cost by default — tune
// with real cost/benefit in mind, not just "faster is better."
const ASC_CEO_INTERVAL_MS = Number(process.env.ASC_CEO_INTERVAL_MS ?? 600_000);

if (!BASE_RPC_URL || !ORCHESTRATOR_PRIVATE_KEY || !BOND_CONTRACT_ADDRESS) {
  throw new Error(
    "Missing required env vars: BASE_RPC_URL, ORCHESTRATOR_PRIVATE_KEY, BOND_CONTRACT_ADDRESS. " +
      "Set them on the sml-asc-orchestrator Render service before starting."
  );
}

if (ASC_AUTONOMOUS && !ANTHROPIC_API_KEY) {
  throw new Error(
    "ASC_AUTONOMOUS=true requires ANTHROPIC_API_KEY to be set — autonomous mode has no " +
      "deterministic fallback. Set ANTHROPIC_API_KEY or unset ASC_AUTONOMOUS."
  );
}

const llmClient = ANTHROPIC_API_KEY
  ? new AnthropicAgentClient(ANTHROPIC_API_KEY, ANTHROPIC_MODEL)
  : undefined;

const orchestrator = new SMLAgentSwarmOrchestrator(
  BASE_RPC_URL,
  ORCHESTRATOR_PRIVATE_KEY,
  BOND_CONTRACT_ADDRESS,
  llmClient
);
const legacyBridge = new SMLGhostLegacyBridge(LEGACY_BRIDGE_SANDBOX);

if (ASC_AUTONOMOUS) {
  orchestrator.startAutonomousCeoLoop(ASC_CEO_INTERVAL_MS);
  console.log(`[SML ASC Orchestrator] Autonomous CEO loop started — every ${ASC_CEO_INTERVAL_MS}ms`);
} else if (llmClient) {
  console.log("[SML ASC Orchestrator] LLM mode active (message-triggered only — ASC_AUTONOMOUS not set)");
} else {
  console.log("[SML ASC Orchestrator] Deterministic mode (no ANTHROPIC_API_KEY set)");
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "sml-asc-orchestrator",
    llmMode: Boolean(llmClient),
    autonomous: ASC_AUTONOMOUS,
  });
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
