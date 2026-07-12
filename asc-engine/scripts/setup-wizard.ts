#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Interactive quickstart: walks through the two real deploy stages (contracts,
 * then orchestrator) and writes both .env files for you. It does not deploy
 * anything itself — it only prepares the exact commands and env vars needed,
 * so a buyer can go from "cloned this repo" to "ready to deploy" without
 * reading the whole README first.
 */
async function main() {
  const rl = readline.createInterface({ input, output });
  console.log("\nASC Engine setup — this prepares .env files, it does not deploy anything.\n");

  const network = (await rl.question("Deploy contracts to which network? [base-sepolia (testnet, recommended first) / base (mainnet)]: ")).trim() || "base-sepolia";

  const treasury = await rl.question("Your protocol treasury address (receives the 0.5% fee on every bond funded through your factory): ");
  const rpcUrl = await rl.question(
    `RPC URL for ${network} [press enter for the public default]: `
  );
  const deployerKey = await rl.question("Deployer private key (pays gas — NOT stored anywhere but your local .env, never sent anywhere by this script): ");

  const contractsEnv = [
    `DEPLOYER_PRIVATE_KEY=${deployerKey}`,
    `SEPOLIA_RPC_URL=`,
    `BASE_SEPOLIA_RPC_URL=${network === "base-sepolia" && rpcUrl ? rpcUrl : "https://sepolia.base.org"}`,
    `BASE_MAINNET_RPC_URL=${network === "base" && rpcUrl ? rpcUrl : "https://mainnet.base.org"}`,
    `ETHERSCAN_API_KEY=`,
    `BASESCAN_API_KEY=`,
    `PROTOCOL_TREASURY_ADDRESS=${treasury}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(process.cwd(), "contracts", ".env"), contractsEnv);
  console.log("\nWrote contracts/.env");

  console.log(
    `\nNext, deploy the factory:\n` +
      `  cd contracts && npm install && npm run compile\n` +
      `  npm run deploy:${network}\n` +
      `\nThen deploy your first bond (fill in funding params first — these are\n` +
      `business terms, deliberately not asked here):\n` +
      `  npm run deploy-bond:${network}\n` +
      `\nRecord the resulting bond address — you'll need it below.\n`
  );

  const bondAddress = await rl.question("Bond contract address (paste the address from the deploy-bond output above, or press enter to fill in later): ");
  const anthropicKey = await rl.question("Anthropic API key for real agent reasoning (optional, press enter to skip — deterministic mode works with no key): ");

  const rootEnv = [
    `BASE_RPC_URL=${network === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org"}`,
    `ORCHESTRATOR_PRIVATE_KEY=${deployerKey}`,
    `BOND_CONTRACT_ADDRESS=${bondAddress}`,
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    `ANTHROPIC_MODEL=claude-sonnet-5`,
    `ASC_AUTONOMOUS=false`,
    `ASC_CEO_INTERVAL_MS=600000`,
    `PORT=3404`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(process.cwd(), ".env"), rootEnv);
  console.log("\nWrote .env");

  console.log(
    "\nRun the orchestrator locally with:\n  npm install && npm run start:server\n" +
      "\nThen POST a message to try it:\n" +
      `  curl -X POST http://localhost:3404/message -H 'content-type: application/json' \\\n` +
      `    -d '{"sender":"CFO","recipient":"CEO","payload":"INSUFFICIENT_FUNDS_FOR_HOSTING"}'\n` +
      "\nSee README.md for production deploy options (Render, Cloudflare Workers).\n"
  );

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
