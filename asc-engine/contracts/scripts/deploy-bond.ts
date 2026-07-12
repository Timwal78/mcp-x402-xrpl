import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Deploys a single SMLYieldBond instance from an already-deployed
 * SMLYieldBondFactory. Run scripts/deploy.ts first (or pass FACTORY_ADDRESS
 * directly) — this script does not deploy the factory itself.
 *
 * Required env vars:
 *   PAYMENT_TOKEN_ADDRESS        ERC-20 investors fund/get repaid in (e.g. USDC)
 *   PAYMENT_TOKEN_DECIMALS       decimals for that token (USDC = 6)
 *   FUNDING_TARGET               human-readable amount, e.g. "250" for 250 USDC
 *   REPAYMENT_CAP_MULTIPLIER_BPS basis points, e.g. "12000" = 120%
 *   REPAYMENT_SPLIT_BASIS_POINTS basis points of each revenue payment routed
 *                                to investors until the cap is hit, e.g. "8000" = 80%
 *
 * Optional:
 *   FACTORY_ADDRESS              skip reading deployments/<network>.json
 */
async function main() {
  const paymentToken = process.env.PAYMENT_TOKEN_ADDRESS;
  const decimalsRaw = process.env.PAYMENT_TOKEN_DECIMALS;
  const fundingTargetRaw = process.env.FUNDING_TARGET;
  const capMultiplierRaw = process.env.REPAYMENT_CAP_MULTIPLIER_BPS;
  const splitBpsRaw = process.env.REPAYMENT_SPLIT_BASIS_POINTS;

  if (!paymentToken) throw new Error("PAYMENT_TOKEN_ADDRESS is required.");
  if (!decimalsRaw) throw new Error("PAYMENT_TOKEN_DECIMALS is required.");
  if (!fundingTargetRaw) throw new Error("FUNDING_TARGET is required.");
  if (!capMultiplierRaw) throw new Error("REPAYMENT_CAP_MULTIPLIER_BPS is required.");
  if (!splitBpsRaw) throw new Error("REPAYMENT_SPLIT_BASIS_POINTS is required.");

  const outDir = path.join(__dirname, "..", "deployments");
  let factoryAddress = process.env.FACTORY_ADDRESS;
  if (!factoryAddress) {
    const factoryFile = path.join(outDir, `${network.name}.json`);
    if (!fs.existsSync(factoryFile)) {
      throw new Error(
        `No FACTORY_ADDRESS given and no deployment record at ${factoryFile}. Deploy the factory first (scripts/deploy.ts).`
      );
    }
    factoryAddress = JSON.parse(fs.readFileSync(factoryFile, "utf-8")).factoryAddress;
  }

  const [signer] = await ethers.getSigners();
  console.log(`Deploying bond via factory ${factoryAddress} on ${network.name} from ${signer.address}`);

  const factory = await ethers.getContractAt("SMLYieldBondFactory", factoryAddress!);

  const fundingTarget = ethers.parseUnits(fundingTargetRaw, Number(decimalsRaw));
  const capMultiplier = BigInt(capMultiplierRaw);
  const splitBps = BigInt(splitBpsRaw);

  const tx = await factory.deployBond(paymentToken, fundingTarget, capMultiplier, splitBps);
  const receipt = await tx.wait();

  const event = receipt!.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "BondDeployed");

  if (!event) {
    throw new Error("BondDeployed event not found in transaction receipt — deployment may have failed.");
  }

  const bondAddress = event.args.bondAddress as string;
  console.log(`SMLYieldBond deployed at ${bondAddress}`);
  console.log(`  Payment token: ${paymentToken}`);
  console.log(`  Funding target: ${fundingTargetRaw} (raw: ${fundingTarget.toString()})`);
  console.log(`  Repayment cap multiplier: ${capMultiplierRaw} bps`);
  console.log(`  Investor split until cap: ${splitBpsRaw} bps`);

  const record = {
    network: network.name,
    factoryAddress,
    bondAddress,
    operator: signer.address,
    paymentToken,
    fundingTarget: fundingTargetRaw,
    fundingTargetRaw: fundingTarget.toString(),
    repaymentCapMultiplierBps: capMultiplierRaw,
    repaymentSplitBasisPoints: splitBpsRaw,
    deployedAt: new Date().toISOString(),
    txHash: tx.hash,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-bond-1.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`Bond deployment record written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
