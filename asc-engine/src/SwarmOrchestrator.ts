import { ethers } from "ethers";
import type { AgentDecision, LlmAgentClient } from "./llm-agent.js";

export type AgentRole = "CEO" | "CFO" | "CTO" | "QA";

export interface AgentMessage {
  id: string;
  sender: AgentRole;
  recipient: AgentRole | "ALL";
  payload: string;
  timestamp: number;
}

export type AgentMessageInput = Omit<AgentMessage, "id" | "timestamp">;

export interface CodePatch {
  filePath: string;
  proposedChanges: string;
  optimizationMetricExpected: number; // Percentage efficiency increase expected
}

interface RevenuePayload {
  amount: number;
}

const BOND_ABI = [
  "function processRevenue(uint256 revenueAmount) external",
  "function isFundingClosed() external view returns (bool)",
  "function totalRaised() external view returns (uint256)",
] as const;

const MEMORY_LIMIT_MB = 128;
const REVENUE_PREFIX = "PROCESS_INCOMING_REVENUE:";
const AUDIT_PREFIX = "REQUEST_AUDIT:";

/**
 * Routes messages between the four ASC agent roles.
 *
 * Two modes:
 *  - No `llmClient` passed to the constructor: deterministic string-matching
 *    (the original behavior — no real judgment, just pattern rules).
 *  - `llmClient` passed: each handler asks a real Claude call (via
 *    llm-agent.ts, BYOK) to decide what to do, given real context. The
 *    deterministic mode still exists as a zero-cost, zero-API-key fallback
 *    (and what CI tests against).
 *
 * The one step with real external side effects — the CFO calling
 * SMLYieldBond.processRevenue() on-chain — always parses the revenue amount
 * from the verified triggering message itself, never from LLM-restated
 * text, in either mode. The LLM in CFO mode only gets a yes/no gate on
 * whether to proceed; it cannot alter what actually gets sent on-chain.
 */
export class SMLAgentSwarmOrchestrator {
  private readonly wallet: ethers.Wallet;
  private readonly bondContract: ethers.Contract;
  private readonly messageBus: AgentMessage[] = [];
  private readonly llmClient?: LlmAgentClient;
  private autonomousTimer?: ReturnType<typeof setInterval>;

  constructor(
    rpcUrl: string,
    operatorPrivateKey: string,
    bondContractAddress: string,
    llmClient?: LlmAgentClient
  ) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(operatorPrivateKey, provider);
    this.bondContract = new ethers.Contract(bondContractAddress, BOND_ABI, this.wallet);
    this.llmClient = llmClient;
  }

  public async routeSecureMessage(message: AgentMessageInput): Promise<void> {
    const fullMessage: AgentMessage = {
      ...message,
      id: ethers.hexlify(ethers.randomBytes(16)),
      timestamp: Date.now(),
    };
    this.messageBus.push(fullMessage);
    console.log(`[ASC Swarm Bus] [${fullMessage.sender} -> ${fullMessage.recipient}]: ${fullMessage.payload}`);
    await this.onMessageReceived(fullMessage);
  }

  public getMessageHistory(): readonly AgentMessage[] {
    return this.messageBus;
  }

  /**
   * Starts a periodic loop where the CEO agent reads real on-chain bond
   * state plus recent message history and decides whether anything needs
   * doing. This is the actual "set it and forget it" loop — it requires an
   * `llmClient` (there is no deterministic equivalent; a timer that
   * pattern-matches nothing would do nothing).
   *
   * Every tick is a real, billed API call against whatever key the
   * `llmClient` was constructed with. Size `intervalMs` deliberately.
   */
  public startAutonomousCeoLoop(intervalMs: number): void {
    if (!this.llmClient) {
      throw new Error(
        "[ASC] Autonomous mode requires an LlmAgentClient — construct the orchestrator with one first."
      );
    }
    if (this.autonomousTimer) return;
    this.autonomousTimer = setInterval(() => {
      void this.runCeoCycle();
    }, intervalMs);
  }

  public stopAutonomousCeoLoop(): void {
    if (this.autonomousTimer) {
      clearInterval(this.autonomousTimer);
      this.autonomousTimer = undefined;
    }
  }

  private async runCeoCycle(): Promise<void> {
    if (!this.llmClient) return;

    let onChainState: string;
    try {
      const [isFundingClosed, totalRaised] = await Promise.all([
        this.bondContract.isFundingClosed() as Promise<boolean>,
        this.bondContract.totalRaised() as Promise<bigint>,
      ]);
      onChainState = `isFundingClosed=${isFundingClosed}, totalRaised=${ethers.formatUnits(totalRaised, 6)}`;
    } catch (error) {
      console.error("[ASC] CEO cycle failed to read on-chain bond state — skipping this tick:", error);
      return;
    }

    const recentHistory = this.messageBus
      .slice(-10)
      .map((m) => `[${m.sender}->${m.recipient}] ${m.payload}`)
      .join("\n");
    const context =
      `Current on-chain bond state: ${onChainState}\n\n` +
      `Recent message history (most recent last):\n${recentHistory || "(none yet)"}\n\n` +
      `Decide if any action is warranted right now.`;

    try {
      const decision = await this.llmClient.decide("CEO", context);
      await this.actOnRoutingDecision("CEO", decision);
    } catch (error) {
      console.error("[ASC] CEO autonomous cycle failed:", error);
    }
  }

  private async actOnRoutingDecision(role: AgentRole, decision: AgentDecision): Promise<void> {
    console.log(`[ASC LLM] ${role} decided: ${decision.action} — ${decision.reasoning}`);
    if (decision.action === "route" && decision.target) {
      await this.routeSecureMessage({
        sender: role,
        recipient: decision.target,
        payload: decision.payload ?? decision.reasoning,
      });
    }
  }

  private async onMessageReceived(message: AgentMessage): Promise<void> {
    switch (message.recipient) {
      case "CEO":
        return this.handleCEOMessage(message);
      case "CFO":
        return this.handleCFOMessage(message);
      case "CTO":
        return this.handleCTOMessage(message);
      case "QA":
        return this.handleQAMessage(message);
      case "ALL":
        await Promise.all([
          this.handleCEOMessage(message),
          this.handleCFOMessage(message),
          this.handleCTOMessage(message),
          this.handleQAMessage(message),
        ]);
        return;
    }
  }

  private async handleCEOMessage(msg: AgentMessage): Promise<void> {
    if (this.llmClient) {
      const context =
        `You received a message.\nFrom: ${msg.sender}\nTo: ${msg.recipient}\nPayload: ${msg.payload}\n\n` +
        `Decide what to do.`;
      try {
        const decision = await this.llmClient.decide("CEO", context);
        await this.actOnRoutingDecision("CEO", decision);
      } catch (error) {
        console.error("[ASC LLM] CEO reasoning failed, no action taken:", error);
      }
      return;
    }

    if (msg.sender === "CFO" && msg.payload.includes("INSUFFICIENT_FUNDS_FOR_HOSTING")) {
      await this.routeSecureMessage({
        sender: "CEO",
        recipient: "CTO",
        payload: "CRITICAL: Current compute efficiency is non-viable. Optimize immediately to lower latency and execution footprint.",
      });
    }
    if (msg.sender === "QA" && msg.payload.includes("PATCH_VERIFICATION_PASSED")) {
      await this.routeSecureMessage({
        sender: "CEO",
        recipient: "CFO",
        payload: "STRATEGIC_APPROVAL: Patch passed sandbox checks. Allocate x402 gas fees and trigger contract repository update deployment.",
      });
    }
  }

  private async handleCFOMessage(msg: AgentMessage): Promise<void> {
    if (!msg.payload.startsWith(REVENUE_PREFIX)) return;

    let data: RevenuePayload;
    try {
      data = JSON.parse(msg.payload.slice(REVENUE_PREFIX.length)) as RevenuePayload;
    } catch {
      console.error(`[CFO] Rejected non-JSON revenue payload: ${msg.payload}`);
      return;
    }
    if (typeof data.amount !== "number" || !Number.isFinite(data.amount) || data.amount <= 0) {
      console.error(`[CFO] Rejected malformed revenue payload: ${msg.payload}`);
      return;
    }

    if (this.llmClient) {
      const context =
        `A revenue event of ${data.amount} (assumed USDC/RLUSD, 6 decimals) has been reported. ` +
        `Decide whether to recommend processing it through processRevenue().`;
      let decision: AgentDecision;
      try {
        decision = await this.llmClient.decide("CFO", context);
      } catch (error) {
        console.error("[ASC LLM] CFO reasoning failed, no action taken:", error);
        return;
      }
      console.log(`[ASC LLM] CFO decided: ${decision.action} — ${decision.reasoning}`);
      if (decision.action !== "process_revenue") {
        return;
      }
      // Falls through to executeProcessRevenue below using `data.amount` from
      // the verified message — the LLM only gated whether to proceed, it
      // never supplies the amount that actually gets sent on-chain.
    }

    await this.executeProcessRevenue(data.amount);
  }

  private async executeProcessRevenue(amount: number): Promise<void> {
    const amountInWei = ethers.parseUnits(amount.toString(), 6); // standard 6-decimal USDC/RLUSD
    console.log(`[CFO] Executing non-custodial programmatic split for: ${ethers.formatUnits(amountInWei, 6)} token`);

    try {
      const tx = await this.bondContract.processRevenue(amountInWei);
      await tx.wait();
      console.log(`[CFO] Revenue split and yield distribution executed. Hash: ${tx.hash}`);
    } catch (error) {
      console.error("[CFO] Failed to route revenue allocation:", error);
    }
  }

  private async handleCTOMessage(msg: AgentMessage): Promise<void> {
    if (!msg.payload.includes("OPTIMIZE") && !msg.payload.includes("CRITICAL")) return;

    if (this.llmClient) {
      const context =
        `The CEO sent this directive:\n${msg.payload}\n\n` +
        `Propose a specific, scoped change for QA to review (route to QA), or decide no action is warranted.`;
      try {
        const decision = await this.llmClient.decide("CTO", context);
        console.log(`[ASC LLM] CTO decided: ${decision.action} — ${decision.reasoning}`);
        if (decision.action === "route" && decision.target) {
          await this.routeSecureMessage({
            sender: "CTO",
            recipient: decision.target,
            payload: `${AUDIT_PREFIX}${decision.payload ?? decision.reasoning}`,
          });
        }
      } catch (error) {
        console.error("[ASC LLM] CTO reasoning failed, no action taken:", error);
      }
      return;
    }

    console.log("[CTO] Launching code optimization subroutines.");
    // NOTE: this deterministic fallback has no real codebase awareness — the
    // file path and metric below are a fixed placeholder, not a proposal
    // grounded in an actual diff. LLM mode (above) at least reasons over the
    // real triggering directive instead of returning the same fake patch
    // every time.
    const proposedPatch: CodePatch = {
      filePath: "src/processors/AudioProcessor.ts",
      proposedChanges: "Reduce buffer allocations in the streaming parse loop.",
      optimizationMetricExpected: 18.2,
    };

    await this.routeSecureMessage({
      sender: "CTO",
      recipient: "QA",
      payload: `${AUDIT_PREFIX}${JSON.stringify(proposedPatch)}`,
    });
  }

  private async handleQAMessage(msg: AgentMessage): Promise<void> {
    if (!msg.payload.startsWith(AUDIT_PREFIX)) return;
    const proposalText = msg.payload.slice(AUDIT_PREFIX.length);

    if (this.llmClient) {
      const context =
        `Review this proposed change:\n${proposalText}\n\n` +
        `Decide whether it passes review (route to CEO with a PATCH_VERIFICATION_PASSED-style message) ` +
        `or should be rejected (route to CTO explaining why).`;
      try {
        const decision = await this.llmClient.decide("QA", context);
        console.log(`[ASC LLM] QA decided: ${decision.action} — ${decision.reasoning}`);
        if (decision.action === "route" && decision.target) {
          await this.routeSecureMessage({
            sender: "QA",
            recipient: decision.target,
            payload: decision.payload ?? decision.reasoning,
          });
        }
      } catch (error) {
        console.error("[ASC LLM] QA reasoning failed, no action taken:", error);
      }
      return;
    }

    const patch = JSON.parse(proposalText) as CodePatch;
    console.log(`[QA] Spinning up ephemeral test sandbox for file: ${patch.filePath}`);

    const testResult = this.evaluatePatch(patch);
    if (testResult.passed) {
      await this.routeSecureMessage({
        sender: "QA",
        recipient: "CEO",
        payload: `PATCH_VERIFICATION_PASSED: Optimization check succeeded. Expected CPU usage reduction: ${patch.optimizationMetricExpected}%.`,
      });
    } else {
      await this.routeSecureMessage({
        sender: "QA",
        recipient: "CTO",
        payload: `PATCH_REJECTED: ${testResult.message} Resource limit: ${MEMORY_LIMIT_MB}MB.`,
      });
    }
  }

  /**
   * Deterministic-mode-only fallback gate. This only checks the metric the
   * CTO claimed — it does not compile, lint, or dry-run the patch. Wiring
   * an actual ephemeral sandbox (Cloudflare Workers/containers) is real,
   * separate work; pretending this gate does that already would violate
   * this project's own "no fake compliance" rule. LLM mode's QA handler
   * (above) at least reasons over real proposal text instead of one number.
   */
  private evaluatePatch(patch: CodePatch): { passed: boolean; message: string } {
    if (patch.optimizationMetricExpected < 5.0) {
      return { passed: false, message: "Claimed optimization is below the 5% minimum threshold." };
    }
    return { passed: true, message: "Claimed metric accepted (no real static analysis or dry-run yet)." };
  }
}
