/**
 * @scriptmasterlabs/mcp-x402
 *
 * ai-swarm.ts — Real LLM-backed analyst swarm.
 *
 * Each persona is an independent Claude call reasoning over the same
 * heatmap data; a coordinator call then synthesizes all verdicts into one
 * final read. This is genuine multi-agent LLM inference (not a rule-based
 * mock), so it requires a valid ANTHROPIC_API_KEY and costs one API call
 * per persona plus one synthesis call per swarm run.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface SwarmPersona {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface SwarmMemberResult {
  id: string;
  name: string;
  verdict: string;
}

export interface SwarmResult {
  members: SwarmMemberResult[];
  synthesis: string;
  model: string;
  generatedAt: string;
}

export interface SwarmOptions {
  apiKey: string;
  model?: string;
  maxTokensPerAgent?: number;
}

async function callClaude(
  apiKey: string,
  model: string,
  system: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable body)");
    throw new Error(`Anthropic API → HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/**
 * Run every persona in parallel against the same market context, then run a
 * coordinator pass that merges their independent verdicts into one final read.
 */
export async function runSwarm(
  personas: SwarmPersona[],
  marketContext: string,
  opts: SwarmOptions,
): Promise<SwarmResult> {
  if (!opts.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured — the AI swarm requires a valid Anthropic API key");
  }

  const model = opts.model ?? "claude-sonnet-4-5";
  const maxTokens = opts.maxTokensPerAgent ?? 300;

  const members = await Promise.all(
    personas.map(async (persona): Promise<SwarmMemberResult> => {
      const verdict = await callClaude(opts.apiKey, model, persona.systemPrompt, marketContext, maxTokens);
      return { id: persona.id, name: persona.name, verdict };
    }),
  );

  const synthesisPrompt = [
    "You are coordinating independent specialist analysts who each reviewed the same market data below.",
    "Synthesize their verdicts into one final read: overall bias, confidence, and the single biggest risk to that view.",
    "Be concrete and concise (3-5 sentences). Do not repeat each analyst verbatim.",
    "",
    ...members.map((m) => `[${m.name}]: ${m.verdict}`),
  ].join("\n");

  const synthesis = await callClaude(
    opts.apiKey,
    model,
    "You are SWARM_COORDINATOR, merging multiple specialist AI analysts into one actionable verdict.",
    synthesisPrompt,
    400,
  );

  return { members, synthesis, model, generatedAt: new Date().toISOString() };
}

// ─── Default personas ─────────────────────────────────────────────────────────

export const EQUITIES_SWARM_PERSONAS: SwarmPersona[] = [
  {
    id: "momentum_quant",
    name: "MOMENTUM_QUANT",
    systemPrompt:
      "You are MOMENTUM_QUANT, a technical analyst specializing in RSI-based momentum reads. Given a grouped RSI heatmap of equities, identify which names or groups are overbought (RSI>=70), oversold (RSI<=30), or turning. Reason only from the numbers given — never invent facts not present in the data. Respond in 2-4 sentences.",
  },
  {
    id: "sector_rotation",
    name: "SECTOR_ROTATION",
    systemPrompt:
      "You are SECTOR_ROTATION, focused on cross-sectional positioning. Given a grouped RSI heatmap, comment on relative strength/weakness across the groups and what that implies about rotation. Reason only from the numbers given. Respond in 2-4 sentences.",
  },
  {
    id: "risk_sentinel",
    name: "RISK_SENTINEL",
    systemPrompt:
      "You are RISK_SENTINEL, focused on downside risk. Given a grouped RSI heatmap, flag the names most exposed to mean-reversion risk and note position-sizing caution. Reason only from the numbers given. Respond in 2-4 sentences.",
  },
  {
    id: "macro_oracle",
    name: "MACRO_ORACLE",
    systemPrompt:
      "You are MACRO_ORACLE. Given a grouped RSI heatmap of equities, note how broad-based the overbought/oversold readings are (breadth) and what that typically signals about market regime. Reason only from the numbers given. Respond in 2-4 sentences.",
  },
];

export const OPTIONS_SWARM_PERSONAS: SwarmPersona[] = [
  {
    id: "greeks_analyst",
    name: "GREEKS_ANALYST",
    systemPrompt:
      "You are GREEKS_ANALYST. Given a grouped Delta heatmap for an options chain (delta normalized 0-100, higher = deeper in-the-money), explain what the distribution implies about directional exposure across strikes. Reason only from the numbers given. Respond in 2-4 sentences.",
  },
  {
    id: "iv_skew_hunter",
    name: "IV_SKEW_HUNTER",
    systemPrompt:
      "You are IV_SKEW_HUNTER. Given implied volatility and delta data per strike group, comment on any skew or richness/cheapness pattern visible in the numbers. If IV data is missing for a contract, say so rather than guessing. Respond in 2-4 sentences.",
  },
  {
    id: "gamma_watch",
    name: "GAMMA_WATCH",
    systemPrompt:
      "You are GAMMA_WATCH, focused on where delta changes fastest — near-the-money strikes. Given the delta heatmap groups, identify the strikes most likely to see rapid delta change on a spot move. Reason only from the numbers given. Respond in 2-4 sentences.",
  },
  {
    id: "options_risk_sentinel",
    name: "RISK_SENTINEL",
    systemPrompt:
      "You are RISK_SENTINEL. Given a grouped options Delta heatmap, flag the contracts carrying the most directional/assignment risk and note hedging considerations. Reason only from the numbers given. Respond in 2-4 sentences.",
  },
];
