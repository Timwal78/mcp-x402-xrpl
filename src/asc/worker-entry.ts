import { SMLAgentSwarmOrchestrator, type AgentMessageInput } from "./SMLAgentSwarmOrchestrator.js";

/**
 * Cloudflare Worker entry for the ASC orchestrator's message-routing +
 * on-chain payment path only. It deliberately does NOT expose
 * SMLGhostLegacyBridge — Workers has no child_process, even with
 * `nodejs_compat`, so the legacy bridge can only run on the Render/Node
 * entry point (see src/asc/render-entry.ts).
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

    const orchestrator = new SMLAgentSwarmOrchestrator(env.BASE_RPC_URL, env.ORCHESTRATOR_PRIVATE_KEY, env.BOND_CONTRACT_ADDRESS);

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
