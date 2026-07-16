import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Deploys the x402 Settlement Router singleton: SettlementRouterFactory,
 * which in turn deploys FeeRegistry, ReputationOracle, and the TaskEscrow
 * clone implementation. Run once per chain — every orchestrator afterwards
 * gets its own router via scripts/create-router.ts against this factory.
 *
 * Required env vars:
 *   PROTOCOL_TREASURY_ADDRESS   FeeRegistry treasury. Must be a Gnosis Safe
 *                                multisig (2-of-3 or 3-of-5), not an EOA —
 *                                see PRD non-negotiable #6.
 *   REPUTATION_UPDATER_ADDRESS  Signer authorized to push ARGUS/402Proof
 *                                scores into ReputationOracle (the address
 *                                scripts/update-reputation-oracle.ts signs
 *                                with).
 *
 * Optional:
 *   TOKEN_ADDRESS       Settlement ERC-20. Defaults to canonical USDC for
 *                        the target network (Base mainnet / Base Sepolia).
 *                        No default on any other network — must be set.
 *   PROTOCOL_FEE_BPS    Initial protocol fee, basis points. Default 50 (0.5%).
 */

// Verified against Circle's official contract address list
// (https://developers.circle.com/stablecoins/usdc-contract-addresses) —
// do not edit without re-checking that page, these move real money.
const DEFAULT_USDC: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

async function main() {
  const treasury = process.env.PROTOCOL_TREASURY_ADDRESS;
  const reputationUpdater = process.env.REPUTATION_UPDATER_ADDRESS;
  const protocolFeeBps = BigInt(process.env.PROTOCOL_FEE_BPS ?? "50");

  if (!treasury) {
    throw new Error(
      "PROTOCOL_TREASURY_ADDRESS is required — set it in asc-contracts/.env. Must be a multisig, not an EOA."
    );
  }
  if (!reputationUpdater) {
    throw new Error("REPUTATION_UPDATER_ADDRESS is required — the signer scripts/update-reputation-oracle.ts uses.");
  }
  if (protocolFeeBps > 500n) {
    throw new Error("PROTOCOL_FEE_BPS exceeds the 5% (500 bps) hard cap enforced on-chain by FeeRegistry.");
  }

  const tokenAddress = process.env.TOKEN_ADDRESS ?? DEFAULT_USDC[network.name];
  if (!tokenAddress) {
    throw new Error(`TOKEN_ADDRESS is required on network "${network.name}" — no known default USDC address.`);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deploying SettlementRouterFactory to ${network.name} from ${deployer.address}`);
  console.log(`  token:               ${tokenAddress}`);
  console.log(`  treasury:            ${treasury}`);
  console.log(`  protocolFeeBps:      ${protocolFeeBps}`);
  console.log(`  reputationUpdater:   ${reputationUpdater}`);

  const Factory = await ethers.getContractFactory("SettlementRouterFactory");
  const factory = await Factory.deploy(tokenAddress, treasury, protocolFeeBps, reputationUpdater);
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  const feeRegistry = await factory.feeRegistry();
  const reputationOracle = await factory.reputationOracle();
  const escrowImplementation = await factory.escrowImplementation();

  console.log(`SettlementRouterFactory deployed at ${factoryAddress}`);
  console.log(`  FeeRegistry:          ${feeRegistry}`);
  console.log(`  ReputationOracle:     ${reputationOracle}`);
  console.log(`  TaskEscrow impl:      ${escrowImplementation}`);

  const record = {
    network: network.name,
    factoryAddress,
    feeRegistry,
    reputationOracle,
    escrowImplementation,
    token: tokenAddress,
    treasury,
    protocolFeeBps: protocolFeeBps.toString(),
    reputationUpdater,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-settlement-router.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`Deployment record written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
