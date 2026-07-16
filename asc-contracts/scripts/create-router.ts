import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Creates one SettlementRouter for a given orchestrator address against an
 * already-deployed SettlementRouterFactory. Run scripts/deploy-settlement-router.ts
 * first (or pass FACTORY_ADDRESS directly).
 *
 * Required env vars:
 *   ORCHESTRATOR_ADDRESS   the address SettlementRouter.onlyOrchestrator will
 *                          trust for createTask/settleTask/slashAgent — this
 *                          is the signer the off-chain netting engine
 *                          (src/settlement-router/) will sign transactions
 *                          with, not an end-user wallet.
 *
 * Optional:
 *   FACTORY_ADDRESS        skip reading deployments/<network>-settlement-router.json
 */
async function main() {
  const orchestrator = process.env.ORCHESTRATOR_ADDRESS;
  if (!orchestrator) {
    throw new Error("ORCHESTRATOR_ADDRESS is required.");
  }

  const outDir = path.join(__dirname, "..", "deployments");
  let factoryAddress = process.env.FACTORY_ADDRESS;
  if (!factoryAddress) {
    const factoryFile = path.join(outDir, `${network.name}-settlement-router.json`);
    if (!fs.existsSync(factoryFile)) {
      throw new Error(
        `No FACTORY_ADDRESS given and no deployment record at ${factoryFile}. Deploy the factory first (scripts/deploy-settlement-router.ts).`
      );
    }
    factoryAddress = JSON.parse(fs.readFileSync(factoryFile, "utf-8")).factoryAddress;
  }

  const [signer] = await ethers.getSigners();
  console.log(`Creating router for orchestrator ${orchestrator} via factory ${factoryAddress} on ${network.name}`);

  const factory = await ethers.getContractAt("SettlementRouterFactory", factoryAddress!);
  const tx = await factory.connect(signer).createRouter(orchestrator);
  const receipt = await tx.wait();

  const event = receipt!.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "RouterCreated");

  if (!event) {
    throw new Error("RouterCreated event not found in transaction receipt — router creation may have failed.");
  }

  const routerAddress = event.args.router as string;
  console.log(`SettlementRouter deployed at ${routerAddress}`);

  const record = {
    network: network.name,
    factoryAddress,
    orchestrator,
    routerAddress,
    deployedAt: new Date().toISOString(),
    txHash: tx.hash,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-router-${orchestrator.toLowerCase()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`Router record written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
