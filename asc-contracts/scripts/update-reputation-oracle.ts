import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Reads real ARGUS/402Proof scores from the live `GET /api/credit-score`
 * endpoint (src/squeezeos-server.ts) and pushes them into ReputationOracle.
 *
 * IMPORTANT GAP — not silently papered over: ARGUS scores are keyed by
 * `agentDid` (a DID string, read from the `X-Agent-DID` header), but
 * ReputationOracle.reportScore() is keyed by an EVM `address` (the same
 * address that deposits bonds and receives settlement payouts on Base).
 * Nothing in this codebase maps one to the other today. Until an
 * orchestrator-side agent registry provides that mapping, this script
 * requires it to be supplied explicitly via AGENT_DID_MAP_PATH — it will
 * not guess an address from a DID.
 *
 * AGENT_DID_MAP_PATH should point to a JSON file:
 *   [{ "agentDid": "did:key:z6Mk...", "agentAddress": "0xabc..." }, ...]
 *
 * Required env vars:
 *   AGENT_DID_MAP_PATH        see above
 *   REPUTATION_ORACLE_ADDRESS ReputationOracle to push into (or reuse
 *                              deployments/<network>-settlement-router.json)
 *
 * Required env vars (continued):
 *   SQUEEZEOS_MCP_BASE_URL    Base URL of the deployed src/squeezeos-server.ts
 *                              instance (the process that serves
 *                              GET /api/credit-score). No default is set
 *                              here deliberately: this repo's render.yaml
 *                              only defines services for
 *                              start:vending-router and start:asc-orchestrator
 *                              — squeezeos-server.ts (the `npm start`
 *                              default) is not listed there, so there is no
 *                              confirmed production URL to assume. Do not
 *                              guess one; find the real deployed URL first.
 */

interface AgentDidMapEntry {
  agentDid: string;
  agentAddress: string;
}

async function fetchScore(baseUrl: string, agentDid: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/credit-score`, {
    headers: { "X-Agent-DID": agentDid },
  });
  if (!res.ok) {
    throw new Error(`GET /api/credit-score for ${agentDid} failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { creditScore?: number };
  if (typeof body.creditScore !== "number") {
    throw new Error(`Unexpected /api/credit-score response for ${agentDid}: ${JSON.stringify(body)}`);
  }
  return body.creditScore;
}

async function main() {
  const mapPath = process.env.AGENT_DID_MAP_PATH;
  if (!mapPath) {
    throw new Error(
      "AGENT_DID_MAP_PATH is required — no agentDid-to-address mapping exists elsewhere in this codebase yet."
    );
  }

  const outDir = path.join(__dirname, "..", "deployments");
  let oracleAddress = process.env.REPUTATION_ORACLE_ADDRESS;
  if (!oracleAddress) {
    const factoryFile = path.join(outDir, `${network.name}-settlement-router.json`);
    if (!fs.existsSync(factoryFile)) {
      throw new Error(
        `No REPUTATION_ORACLE_ADDRESS given and no deployment record at ${factoryFile}. Deploy the factory first.`
      );
    }
    oracleAddress = JSON.parse(fs.readFileSync(factoryFile, "utf-8")).reputationOracle;
  }

  const baseUrl = process.env.SQUEEZEOS_MCP_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "SQUEEZEOS_MCP_BASE_URL is required — no confirmed deployed URL for squeezeos-server.ts exists in this repo's render.yaml, see comment above."
    );
  }
  const map: AgentDidMapEntry[] = JSON.parse(fs.readFileSync(mapPath, "utf-8"));

  console.log(`Updating ReputationOracle ${oracleAddress} on ${network.name} for ${map.length} agent(s)`);

  const agents: string[] = [];
  const scores: bigint[] = [];
  for (const entry of map) {
    const score = await fetchScore(baseUrl, entry.agentDid);
    console.log(`  ${entry.agentDid} -> ${entry.agentAddress}: ${score}`);
    agents.push(entry.agentAddress);
    scores.push(BigInt(score));
  }

  const [updater] = await ethers.getSigners();
  const oracle = await ethers.getContractAt("ReputationOracle", oracleAddress!);

  if (agents.length === 1) {
    const tx = await oracle.connect(updater).reportScore(agents[0], scores[0]);
    await tx.wait();
  } else {
    const tx = await oracle.connect(updater).reportScores(agents, scores);
    await tx.wait();
  }

  console.log(`Reported ${agents.length} score(s) to ReputationOracle.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
