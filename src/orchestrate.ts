/**
 * @scriptmasterlabs/mcp-x402
 *
 * orchestrate.ts — x402 Workflow Orchestrator
 *
 * POST /x402/orchestrate
 *
 * Executes a named multi-step tool workflow in a single request with a single
 * payment and a hard budget cap. The agent sends one request, one payment, and
 * receives a unified result — no round trips, no partial states to reconcile.
 *
 * Supported workflows (sourced from agent.md product graph):
 *   market_intel  — council + beastmode_full (2 tools, 0.20 RLUSD standard)
 *   credit_check  — credit_score + credit_report (1 free + 1 paid)
 *   full_scan     — beastmode_full + council + credit_score (3 tools)
 *
 * Budget cap: if estimated total cost exceeds budget_cap, the orchestrator
 * returns 402 with itemised cost breakdown before executing any tool.
 * This makes it safe to call from agents with finite budgets.
 *
 * Idempotency: pass X-Idempotency-Key — the orchestrator stores the full
 * result and replays it on duplicate keys within the 300s TTL window.
 */

import { Request, Response } from "express";
import { CreditBureau } from "./credit-bureau.js";

// ─── Workflow definitions ─────────────────────────────────────────────────────

interface WorkflowStep {
  toolId: string;
  name: string;
  costRlusd: string;
  isFree: boolean;
}

interface WorkflowDefinition {
  id: string;
  description: string;
  steps: WorkflowStep[];
  totalCostRlusd: string;
  vipTotalRlusd: string;
  platinumTotalRlusd: string;
}

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  market_intel: {
    id: "market_intel",
    description: "Full market intelligence: 7-agent council + complete squeeze scan",
    steps: [
      { toolId: "council_full",    name: "SqueezeOS Full Council", costRlusd: "0.10", isFree: false },
      { toolId: "beastmode_full",  name: "Beastmode Full Scan",    costRlusd: "0.10", isFree: false },
    ],
    totalCostRlusd:    "0.20",
    vipTotalRlusd:     "0.16",
    platinumTotalRlusd: "0.12",
  },
  credit_check: {
    id: "credit_check",
    description: "Agent credit check: public score + full ARGUS bureau report",
    steps: [
      { toolId: "credit_score_read",   name: "Credit Score",       costRlusd: "0.00", isFree: true },
      { toolId: "credit_report_full",  name: "Full Credit Report", costRlusd: "0.10", isFree: false },
    ],
    totalCostRlusd:    "0.10",
    vipTotalRlusd:     "0.08",
    platinumTotalRlusd: "0.06",
  },
  full_scan: {
    id: "full_scan",
    description: "Full intelligence package: beastmode + council + credit score",
    steps: [
      { toolId: "beastmode_full",     name: "Beastmode Full Scan",    costRlusd: "0.10", isFree: false },
      { toolId: "council_full",       name: "SqueezeOS Full Council", costRlusd: "0.10", isFree: false },
      { toolId: "credit_score_read",  name: "Credit Score",           costRlusd: "0.00", isFree: true },
    ],
    totalCostRlusd:    "0.20",
    vipTotalRlusd:     "0.16",
    platinumTotalRlusd: "0.12",
  },
};

// ─── Idempotency store (in-process) ──────────────────────────────────────────

interface OrchestrateRecord {
  result: unknown;
  cachedAt: number;
}

const orchestrateCache = new Map<string, OrchestrateRecord>();
const CACHE_TTL_MS = 300_000; // 300s

function getCached(key: string): unknown | undefined {
  const record = orchestrateCache.get(key);
  if (!record) return undefined;
  if (Date.now() - record.cachedAt > CACHE_TTL_MS) {
    orchestrateCache.delete(key);
    return undefined;
  }
  return record.result;
}

function setCached(key: string, result: unknown): void {
  orchestrateCache.set(key, { result, cachedAt: Date.now() });
}

// ─── Orchestrate request/response types ──────────────────────────────────────

export interface OrchestrateRequest {
  workflow: string;
  inputs?: Record<string, unknown>;
  budget_cap?: string;
}

// ─── Orchestrate handler factory ──────────────────────────────────────────────

export interface OrchestrateHandlerOptions {
  bureau: CreditBureau;
  receivingAddress: string;
  /** Execute a named tool and return its result. Wired to squeezeos-server handlers. */
  executeTool: (toolId: string, inputs: Record<string, unknown>, agentDid: string) => Promise<unknown>;
}

/**
 * createOrchestrateHandler — returns an Express-compatible async handler for
 * POST /x402/orchestrate.
 *
 * @example
 * ```ts
 * app.post("/x402/orchestrate", agentDidMiddleware, createOrchestrateHandler({ bureau, receivingAddress, executeTool }));
 * ```
 */
export function createOrchestrateHandler(opts: OrchestrateHandlerOptions) {
  return async function orchestrateHandler(req: Request, res: Response): Promise<void> {
    const { workflow, inputs = {}, budget_cap } = req.body as OrchestrateRequest;
    const agentDid = (req as Request & { agentDid?: string }).agentDid ?? "did:anonymous";
    const proofHeader = req.headers["x-payment-proof"] as string | undefined;
    const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;

    // ── Idempotency replay ────────────────────────────────────────────────
    if (idempotencyKey) {
      const cached = getCached(idempotencyKey);
      if (cached) {
        res.setHeader("X-Idempotency-Replayed", "true");
        res.setHeader("X-Idempotency-Key", idempotencyKey);
        res.json(cached);
        return;
      }
    }

    // ── Validate workflow ─────────────────────────────────────────────────
    const definition = WORKFLOWS[workflow];
    if (!definition) {
      res.status(400).json({
        error: "unknown_workflow",
        message: `Unknown workflow: ${workflow}`,
        availableWorkflows: Object.keys(WORKFLOWS).map((id) => ({
          id,
          description: WORKFLOWS[id].description,
          standardCostRlusd: WORKFLOWS[id].totalCostRlusd,
        })),
      });
      return;
    }

    // ── Resolve effective cost by credit score ────────────────────────────
    const agentScore = await opts.bureau.getScore(agentDid);
    let effectiveCost = definition.totalCostRlusd;
    if (agentScore >= 800) effectiveCost = definition.platinumTotalRlusd;
    else if (agentScore >= 700) effectiveCost = definition.vipTotalRlusd;

    // ── Budget cap check — pre-flight, no payment yet ─────────────────────
    if (budget_cap !== undefined) {
      const cap = parseFloat(budget_cap);
      const cost = parseFloat(effectiveCost);
      if (cost > cap) {
        res.status(402).json({
          error: "budget_cap_exceeded",
          workflow,
          effectiveCost,
          budgetCap: budget_cap,
          agentScore,
          breakdown: definition.steps.map((s) => ({
            tool: s.name,
            cost: s.isFree ? "0.00" : applyDiscount(s.costRlusd, agentScore),
          })),
          options: [
            `Increase budget_cap to at least ${effectiveCost} RLUSD`,
            `Earn more paid calls to raise credit score and reduce per-call cost`,
            `Use a simpler workflow: ${Object.keys(WORKFLOWS).filter((w) => parseFloat(WORKFLOWS[w].totalCostRlusd) <= cap).join(", ") || "none available at this budget"}`,
          ],
        });
        return;
      }
    }

    // ── Payment gate ──────────────────────────────────────────────────────
    if (!proofHeader) {
      const requirements = {
        destination: opts.receivingAddress,
        amount: effectiveCost,
        currency: "RLUSD" as const,
        network: "xrpl-mainnet",
        description: `x402 Orchestrate: ${definition.description}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");

      res
        .status(402)
        .setHeader("X-Payment-Requirements", encoded)
        .setHeader("X-402-Protocol", "x402/1.0")
        .json({
          error: "payment_required",
          protocol: "x402",
          workflow,
          effectiveCost,
          currency: "RLUSD",
          network: "xrpl-mainnet",
          agentScore,
          requirements,
          breakdown: definition.steps.map((s) => ({
            tool: s.name,
            cost: s.isFree ? "0.00 (free)" : `${applyDiscount(s.costRlusd, agentScore)} RLUSD`,
          })),
          idempotencyKeyHeader: "X-Idempotency-Key",
          idempotencyNote: "Include X-Idempotency-Key to prevent double-charges on retry.",
          topUpInstructions: {
            destination: opts.receivingAddress,
            amount: effectiveCost,
            currency: "RLUSD",
            network: "xrpl-mainnet",
            topUpUrl: "https://www.scriptmasterlabs.com/central-bank.html",
          },
          paymentInstructions: `Pay ${effectiveCost} RLUSD to ${opts.receivingAddress} on xrpl-mainnet, then retry with X-Payment-Proof header.`,
        });
      return;
    }

    // ── Execute workflow ──────────────────────────────────────────────────
    const stepResults: Record<string, unknown> = {};
    let totalSpent = 0;

    for (const step of definition.steps) {
      try {
        stepResults[step.toolId] = await opts.executeTool(step.toolId, inputs, agentDid);
        if (!step.isFree) totalSpent += parseFloat(applyDiscount(step.costRlusd, agentScore));
      } catch (err) {
        res.status(502).json({
          error: "workflow_step_failed",
          failedStep: step.toolId,
          completedSteps: Object.keys(stepResults),
          details: String(err),
          note: "Partial results are not charged. Payment was for the full workflow. Contact support if funds were debited.",
        });
        return;
      }
    }

    // Record paid calls for score — one per paid step executed
    const paidSteps = definition.steps.filter((s) => !s.isFree).length;
    let newScore = agentScore;
    for (let i = 0; i < paidSteps; i++) {
      newScore = await opts.bureau.recordPaidCall(agentDid);
    }

    const result = {
      workflow,
      status: "completed",
      stepsExecuted: definition.steps.length,
      totalSpentRlusd: totalSpent.toFixed(2),
      agentScore: newScore,
      scoreGained: `+${(newScore - agentScore)}`,
      results: stepResults,
      poweredBy: "ScriptMasterLabs x402 Orchestrator",
    };

    if (idempotencyKey) {
      setCached(idempotencyKey, result);
      res.setHeader("X-Idempotency-Key", idempotencyKey);
    }

    res.json(result);
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyDiscount(baseRlusd: string, agentScore: number): string {
  const base = parseFloat(baseRlusd);
  if (agentScore >= 800) return (base * 0.60).toFixed(2);
  if (agentScore >= 700) return (base * 0.80).toFixed(2);
  return baseRlusd;
}

export { WORKFLOWS };
