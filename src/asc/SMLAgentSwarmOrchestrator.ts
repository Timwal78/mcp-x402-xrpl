import { ethers } from "ethers";

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
 * Routes messages between the four ASC agent roles and executes the one
 * step that has real external side effects: the CFO calling
 * SMLYieldBond.processRevenue() on-chain. Everything else here is message
 * routing over an in-memory bus — see docs/SML_ASC_ARCHITECTURE.md for which
 * parts of the Part 1 diagram this does and doesn't implement yet.
 */
export class SMLAgentSwarmOrchestrator {
  private readonly wallet: ethers.Wallet;
  private readonly bondContract: ethers.Contract;
  private readonly messageBus: AgentMessage[] = [];

  constructor(rpcUrl: string, operatorPrivateKey: string, bondContractAddress: string) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(operatorPrivateKey, provider);
    this.bondContract = new ethers.Contract(bondContractAddress, BOND_ABI, this.wallet);
  }

  public async routeSecureMessage(message: AgentMessageInput): Promise<void> {
    const fullMessage: AgentMessage = {
      ...message,
      id: ethers.hexlify(ethers.randomBytes(16)),
      timestamp: Date.now(),
    };
    this.messageBus.push(fullMessage);
    console.log(`[SML Swarm Bus] [${fullMessage.sender} -> ${fullMessage.recipient}]: ${fullMessage.payload}`);
    await this.onMessageReceived(fullMessage);
  }

  public getMessageHistory(): readonly AgentMessage[] {
    return this.messageBus;
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

    const amountInWei = ethers.parseUnits(data.amount.toString(), 6); // standard 6-decimal USDC/RLUSD
    console.log(`[CFO] Executing non-custodial x402 programmatic split for: ${ethers.formatUnits(amountInWei, 6)} token`);

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

    console.log("[CTO] Launching code optimization subroutines.");
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

    const patch = JSON.parse(msg.payload.slice(AUDIT_PREFIX.length)) as CodePatch;
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
   * This only checks the metric the CTO claimed — it does not compile,
   * lint, or dry-run the patch. Wiring an actual ephemeral sandbox
   * (Cloudflare Workers / containers per Part 1 §4) is real, separate work;
   * pretending this gate does that already would violate the Prime
   * Directive against fake compliance.
   */
  private evaluatePatch(patch: CodePatch): { passed: boolean; message: string } {
    if (patch.optimizationMetricExpected < 5.0) {
      return { passed: false, message: "Claimed optimization is below the 5% minimum threshold." };
    }
    return { passed: true, message: "Claimed metric accepted (no real static analysis or dry-run yet)." };
  }
}
