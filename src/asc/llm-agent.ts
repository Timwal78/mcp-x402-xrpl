import Anthropic from "@anthropic-ai/sdk";
import type { AgentRole } from "./SMLAgentSwarmOrchestrator.js";

/**
 * BYOK LLM reasoning layer for the ASC swarm. This is what actually makes an
 * agent "decide" something instead of matching a string in a payload — the
 * gap explicitly called out in docs/SML_ASC_ARCHITECTURE.md. Each role gets
 * its own system prompt and reasons over whatever context the orchestrator
 * gives it, returning a structured decision via forced tool use so the
 * orchestrator never has to parse free-form text.
 */
export interface AgentDecision {
  action: "route" | "process_revenue" | "no_action";
  target?: AgentRole | "ALL";
  payload?: string;
  reasoning: string;
}

export interface LlmAgentClient {
  decide(role: AgentRole, context: string): Promise<AgentDecision>;
}

const ROLE_SYSTEM_PROMPTS: Record<AgentRole, string> = {
  CEO: `You are the CEO agent of an SML Autonomous Software Corporation (ASC) — a small, \
self-operating software business funded by a capped, non-custodial revenue-factoring \
contract (SMLYieldBond). Your job is strategic: decide whether the business needs the CTO \
to optimize or extend the codebase, whether the CFO needs to route revenue, or whether no \
action is needed right now. You have no authority to spend money, sign transactions, or \
change contract terms — you can only route messages to other agents. Be conservative: when \
you're not confident action is warranted, choose no_action and explain why in your \
reasoning. You are reasoning over real operational context, not a hypothetical.`,

  CFO: `You are the CFO agent of an SML Autonomous Software Corporation (ASC). Your job is \
to decide whether incoming revenue should be routed through the SMLYieldBond contract's \
processRevenue() function. You do not decide the split — the contract enforces that \
mechanically and correctly regardless of what you decide. Your only real judgment call is \
whether the reported revenue figure looks legitimate and well-formed before recommending \
the on-chain call. If anything about the reported amount looks wrong (zero, negative, \
absurdly large relative to prior history, malformed), choose no_action and say why.`,

  CTO: `You are the CTO agent of an SML Autonomous Software Corporation (ASC). Your job is \
to propose narrow, justified code optimizations when the CEO flags a problem (e.g. rising \
compute cost, a specific bug report). You draft a proposed change description — you do not \
write or merge code yourself, and nothing you propose ever ships without the QA agent's \
review. Keep proposals scoped and concrete; vague proposals get rejected by QA.`,

  QA: `You are the QA agent of an SML Autonomous Software Corporation (ASC) — the safety \
gate between the CTO's proposals and anything going live. Review the proposed change \
description you're given on its merits: is the stated problem real, is the proposed fix \
plausible and scoped, does it introduce any obvious risk (security, correctness, cost)? \
You are reasoning over a text description only — you cannot compile, execute, or test any \
code yourself, so you must not claim to have verified behavior you cannot actually observe. \
If the description doesn't give you enough to responsibly judge, reject it and say what's \
missing rather than assuming it's fine.`,
};

const DECISION_TOOL: Anthropic.Tool = {
  name: "record_decision",
  description: "Record this agent's decision about how to respond to the current situation.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["route", "process_revenue", "no_action"],
        description: "route: send a message to another agent. process_revenue: recommend calling processRevenue() on-chain (CFO only). no_action: do nothing right now.",
      },
      target: {
        type: "string",
        enum: ["CEO", "CFO", "CTO", "QA", "ALL"],
        description: "Required when action is 'route' — which agent(s) to route the message to.",
      },
      payload: {
        type: "string",
        description: "The message payload to send when action is 'route', or the amount to process when action is 'process_revenue'.",
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of why this decision was made.",
      },
    },
    required: ["action", "reasoning"],
  },
};

export class AnthropicAgentClient implements LlmAgentClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model = "claude-sonnet-5") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async decide(role: AgentRole, context: string): Promise<AgentDecision> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: ROLE_SYSTEM_PROMPTS[role],
      messages: [{ role: "user", content: context }],
      tools: [DECISION_TOOL],
      tool_choice: { type: "tool", name: "record_decision" },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) {
      throw new Error(`[ASC LLM] ${role} agent returned no tool_use block`);
    }

    const decision = toolUse.input as AgentDecision;
    if (decision.action === "route" && !decision.target) {
      throw new Error(`[ASC LLM] ${role} agent chose action "route" without a target`);
    }
    return decision;
  }
}
