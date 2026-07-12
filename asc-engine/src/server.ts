import express from "express";
import { SMLAgentSwarmOrchestrator, type AgentMessageInput } from "./SwarmOrchestrator.js";
import { AnthropicAgentClient } from "./llm-agent.js";

/**
 * Persistent Node/Express entry point for a long-running host (Render,
 * Fly.io, a plain VM, etc). For a stateless edge deploy instead, see
 * src/worker.ts (Cloudflare Workers).
 *
 * The process always starts and answers /health, and only the routes that
 * need chain config return 503 until it's actually set — a service that
 * throws at module load when env vars are missing will crash-loop under
 * most process managers (Render, PM2, systemd with restart=always) and
 * flood you with restart alerts. Always degrade gracefully instead.
 */
const PORT = Number(process.env.PORT ?? 3404);
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const ORCHESTRATOR_PRIVATE_KEY = process.env.ORCHESTRATOR_PRIVATE_KEY;
const BOND_CONTRACT_ADDRESS = process.env.BOND_CONTRACT_ADDRESS;

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

const chainConfigured = Boolean(BASE_RPC_URL && ORCHESTRATOR_PRIVATE_KEY && BOND_CONTRACT_ADDRESS);
if (!chainConfigured) {
  console.warn(
    "[ASC Orchestrator] Missing BASE_RPC_URL / ORCHESTRATOR_PRIVATE_KEY / BOND_CONTRACT_ADDRESS — " +
      "/message will return 503 until all three are set."
  );
}

const llmClient = ANTHROPIC_API_KEY
  ? new AnthropicAgentClient(ANTHROPIC_API_KEY, ANTHROPIC_MODEL)
  : undefined;

if (ASC_AUTONOMOUS && !ANTHROPIC_API_KEY) {
  console.warn(
    "[ASC Orchestrator] ASC_AUTONOMOUS=true but ANTHROPIC_API_KEY is unset — autonomous mode has " +
      "no deterministic fallback, so the CEO loop will NOT start until ANTHROPIC_API_KEY is set."
  );
}

const orchestrator = chainConfigured
  ? new SMLAgentSwarmOrchestrator(BASE_RPC_URL!, ORCHESTRATOR_PRIVATE_KEY!, BOND_CONTRACT_ADDRESS!, llmClient)
  : undefined;

if (ASC_AUTONOMOUS && orchestrator && llmClient) {
  orchestrator.startAutonomousCeoLoop(ASC_CEO_INTERVAL_MS);
  console.log(`[ASC Orchestrator] Autonomous CEO loop started — every ${ASC_CEO_INTERVAL_MS}ms`);
} else if (orchestrator && llmClient) {
  console.log("[ASC Orchestrator] LLM mode active (message-triggered only — ASC_AUTONOMOUS not set)");
} else if (orchestrator) {
  console.log("[ASC Orchestrator] Deterministic mode (no ANTHROPIC_API_KEY set)");
} else {
  console.log("[ASC Orchestrator] Idle — chain env vars not set, only /health responds");
}

function isAgentMessageInput(value: unknown): value is AgentMessageInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const roles = ["CEO", "CFO", "CTO", "QA"];
  return (
    typeof v.sender === "string" &&
    roles.includes(v.sender) &&
    typeof v.recipient === "string" &&
    (roles.includes(v.recipient) || v.recipient === "ALL") &&
    typeof v.payload === "string"
  );
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "asc-orchestrator",
    chainConfigured,
    llmMode: Boolean(llmClient),
    autonomous: ASC_AUTONOMOUS && chainConfigured && Boolean(llmClient),
  });
});

app.post("/message", async (req, res) => {
  if (!orchestrator) {
    res.status(503).json({
      error: "Chain env vars not configured — set BASE_RPC_URL, ORCHESTRATOR_PRIVATE_KEY, BOND_CONTRACT_ADDRESS.",
    });
    return;
  }
  if (!isAgentMessageInput(req.body)) {
    res.status(400).json({ error: "Body must be { sender, recipient, payload } with sender/recipient in CEO|CFO|CTO|QA (recipient may also be ALL)." });
    return;
  }
  try {
    await orchestrator.routeSecureMessage(req.body);
    res.status(202).json({ status: "routed" });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`[ASC Orchestrator] listening on :${PORT}`);
});
