/**
 * @scriptmasterlabs/mcp-x402
 *
 * settlement-router/client.ts — thin ethers wrapper around the deployed
 * SettlementRouter contract (asc-contracts/contracts/settlement-router/).
 *
 * Mirrors the constructor shape SMLAgentSwarmOrchestrator.ts already uses
 * for the SMLYieldBond contract (rpcUrl + private key + contract address,
 * minimal inline ABI) rather than introducing a new on-chain access pattern.
 * The signing key here is the orchestrator's own — the same address passed
 * as `orchestrator` to SettlementRouterFactory.createRouter().
 */

import { ethers } from "ethers";
import { netPayments, validateTaskGraph, type PaymentEdge } from "./netting.js";

const SETTLEMENT_ROUTER_ABI = [
  "function createTask(bytes32 taskId, address[] agents, uint256[] expectedPayouts, uint256[] bondOverridesBps, uint256 deadline) external returns (address escrow)",
  "function settleTask(bytes32 taskId, address[] agents, uint256[] netPayouts) external",
  "function slashAgent(bytes32 taskId, address agent, uint256 amount, address recipient) external",
  "function taskEscrow(bytes32 taskId) external view returns (address)",
  "function token() external view returns (address)",
  "function feeRegistry() external view returns (address)",
  "event TaskCreated(bytes32 indexed taskId, address indexed escrow, uint256 totalPayout, uint256 deadline)",
  "event TaskSettled(bytes32 indexed taskId, address indexed escrow, uint256 totalFlow, uint256 protocolFee)",
  "event TaskSlashed(bytes32 indexed taskId, address indexed agent, uint256 amount, address recipient)",
] as const;

const TASK_ESCROW_ABI = [
  "function taskBudget() external view returns (uint256)",
  "function totalBonded() external view returns (uint256)",
  "function isSettled() external view returns (bool)",
  "function isCancelled() external view returns (bool)",
  "function bondRequired(address agent) external view returns (uint256)",
  "function bondDeposited(address agent) external view returns (uint256)",
  "function getAgents() external view returns (address[])",
] as const;

const FEE_REGISTRY_ABI = ["function protocolFeeBps() external view returns (uint256)"] as const;

export interface CreateTaskParams {
  taskId: string; // bytes32 hex, e.g. ethers.id("task-123")
  agents: string[];
  expectedPayouts: bigint[];
  bondOverridesBps?: bigint[]; // defaults to all-zero (oracle floor applies)
  deadline: number; // unix seconds
}

export interface SettleTaskFromGraphResult {
  taskId: string;
  agents: string[];
  netPayouts: bigint[];
  totalFlow: bigint;
  protocolFee: bigint;
  txHash: string;
}

export class SettlementRouterClient {
  private readonly wallet: ethers.Wallet;
  private readonly router: ethers.Contract;

  constructor(rpcUrl: string, orchestratorPrivateKey: string, routerAddress: string) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(orchestratorPrivateKey, provider);
    this.router = new ethers.Contract(routerAddress, SETTLEMENT_ROUTER_ABI, this.wallet);
  }

  async createTask(params: CreateTaskParams): Promise<{ escrow: string; txHash: string }> {
    const bondOverridesBps = params.bondOverridesBps ?? params.agents.map(() => 0n);
    const tx = await this.router.createTask(
      params.taskId,
      params.agents,
      params.expectedPayouts,
      bondOverridesBps,
      params.deadline
    );
    const receipt = await tx.wait();
    const escrow: string = await this.router.taskEscrow(params.taskId);
    return { escrow, txHash: receipt.hash };
  }

  /**
   * Nets `edges` off-chain, validates the result against the task's actual
   * on-chain budget and the router's current protocol fee, then submits the
   * single settleTask() transaction. Throws (without submitting anything)
   * if validateTaskGraph rejects the netted result — see netting.ts.
   */
  async settleTaskFromGraph(taskId: string, edges: PaymentEdge[]): Promise<SettleTaskFromGraphResult> {
    const escrowAddress: string = await this.router.taskEscrow(taskId);
    if (escrowAddress === ethers.ZeroAddress) {
      throw new Error(`settleTaskFromGraph: unknown taskId ${taskId} — createTask() was never called for it`);
    }

    const escrow = new ethers.Contract(escrowAddress, TASK_ESCROW_ABI, this.wallet.provider);
    const taskBudget: bigint = await escrow.taskBudget();

    const feeRegistryAddress: string = await this.router.feeRegistry();
    const feeRegistry = new ethers.Contract(feeRegistryAddress, FEE_REGISTRY_ABI, this.wallet.provider);
    const protocolFeeBps: bigint = await feeRegistry.protocolFeeBps();

    const { agents, netPayouts } = netPayments(edges);
    const validation = validateTaskGraph(netPayouts, taskBudget, protocolFeeBps);
    if (!validation.ok) {
      throw new Error(`settleTaskFromGraph: ${validation.reason}`);
    }

    const tx = await this.router.settleTask(taskId, agents, netPayouts);
    const receipt = await tx.wait();

    return {
      taskId,
      agents,
      netPayouts,
      totalFlow: validation.totalFlow,
      protocolFee: validation.protocolFee,
      txHash: receipt.hash,
    };
  }

  async slashAgent(taskId: string, agent: string, amount: bigint, recipient: string): Promise<string> {
    const tx = await this.router.slashAgent(taskId, agent, amount, recipient);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async getTaskEscrowAddress(taskId: string): Promise<string> {
    return this.router.taskEscrow(taskId);
  }

  async getTaskStatus(taskId: string) {
    const escrowAddress: string = await this.router.taskEscrow(taskId);
    if (escrowAddress === ethers.ZeroAddress) {
      return null;
    }
    const escrow = new ethers.Contract(escrowAddress, TASK_ESCROW_ABI, this.wallet.provider);
    const [taskBudget, totalBonded, isSettled, isCancelled, agents] = await Promise.all([
      escrow.taskBudget(),
      escrow.totalBonded(),
      escrow.isSettled(),
      escrow.isCancelled(),
      escrow.getAgents(),
    ]);
    return { escrowAddress, taskBudget, totalBonded, isSettled, isCancelled, agents };
  }
}
