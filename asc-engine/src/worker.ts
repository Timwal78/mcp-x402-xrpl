import { SMLAgentSwarmOrchestrator, type AgentMessageInput } from "./SwarmOrchestrator.js";
import { AnthropicAgentClient } from "./llm-agent.js";

/**
 * Cloudflare Worker entry for the ASC orchestrator's message-routing +
 * on-chain payment path.
 *
 * Message-triggered BYOK LLM mode (set ANTHROPIC_API_KEY as a Worker secret)
 * works fine here, since it's just an API call per request. The always-on
 * autonomous CEO loop does NOT work here — Workers don't keep a process
 * alive between requests, so `setInterval` can't survive; that's the
 * persistent-host entry point only (src/server.ts), or would need a
 * separate Cron Trigger, which isn't implemented.
 *
 * A new orchestrator instance is created per request, so `messageBus`
 * history does not persist across requests or survive multi-hop agent
 * conversations. For that, back this with a Durable Object instead of a
 * stateless fetch handler — not implemented here.
 */
export interface Env {
  BASE_RPC_URL: string;
  ORCHESTRATOR_PRIVATE_KEY: string;
  BOND_CONTRACT_ADDRESS: string;
  // Optional — BYOK. Unset means deterministic (no real judgment) mode.
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "asc-orchestrator" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method !== "POST" || url.pathname !== "/message") {
      return new Response("Not Found", { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    if (!isAgentMessageInput(body)) {
      return new Response(JSON.stringify({ error: "Body must be { sender, recipient, payload }" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const llmClient = env.ANTHROPIC_API_KEY
      ? new AnthropicAgentClient(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL)
      : undefined;
    const orchestrator = new SMLAgentSwarmOrchestrator(
      env.BASE_RPC_URL,
      env.ORCHESTRATOR_PRIVATE_KEY,
      env.BOND_CONTRACT_ADDRESS,
      llmClient
    );

    try {
      await orchestrator.routeSecureMessage(body);
      return new Response(JSON.stringify({ status: "routed" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
