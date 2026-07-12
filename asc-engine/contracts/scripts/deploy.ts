import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const protocolTreasury = process.env.PROTOCOL_TREASURY_ADDRESS;
  if (!protocolTreasury) {
    throw new Error("PROTOCOL_TREASURY_ADDRESS is required — set it in contracts/.env before deploying.");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deploying SMLYieldBondFactory to ${network.name} from ${deployer.address}`);

  const Factory = await ethers.getContractFactory("SMLYieldBondFactory");
  const factory = await Factory.deploy(protocolTreasury);
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  console.log(`SMLYieldBondFactory deployed at ${factoryAddress}`);
  console.log(`Protocol treasury registered: ${protocolTreasury}`);

  const deploymentRecord = {
    network: network.name,
    factoryAddress,
    protocolTreasury,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deploymentRecord, null, 2));
  console.log(`Deployment record written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
