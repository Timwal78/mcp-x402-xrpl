#!/usr/bin/env node
/**
 * local-compile.cjs — offline-sandbox-only compile helper.
 *
 * `npx hardhat compile` downloads the solc binary from
 * binaries.soliditylang.org, which is blocked by this session's egress
 * policy. This script uses the same solc version through the official
 * `solc` npm package (installed from the permitted npm registry — it's the
 * real Solidity compiler shipped as WASM, not a substitute) and writes
 * Hardhat-format artifacts directly, so `npx hardhat test --no-compile` can
 * run against them locally. Not part of the normal build — `npm run
 * compile` / `npx hardhat compile` is still the documented path once this
 * runs somewhere with normal network access.
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");

function findImports(importPath) {
  const candidates = [
    path.join(CONTRACTS_DIR, importPath),
    path.join(ROOT, "node_modules", importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

function listSolFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSolFiles(full));
    } else if (entry.name.endsWith(".sol")) {
      out.push(full);
    }
  }
  return out;
}

const solFiles = listSolFiles(CONTRACTS_DIR);
const sources = {};
for (const file of solFiles) {
  const sourceName = "contracts/" + path.relative(CONTRACTS_DIR, file).split(path.sep).join("/");
  sources[sourceName] = { content: fs.readFileSync(file, "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    viaIR: true,
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
for (const err of output.errors || []) {
  if (err.severity === "error") {
    hasError = true;
    console.error(err.formattedMessage);
  } else {
    console.warn(err.formattedMessage);
  }
}
if (hasError) {
  process.exit(1);
}

for (const [sourceName, fileContracts] of Object.entries(output.contracts || {})) {
  for (const [contractName, contract] of Object.entries(fileContracts)) {
    const outDir = path.join(ARTIFACTS_DIR, sourceName);
    fs.mkdirSync(outDir, { recursive: true });
    const artifact = {
      _format: "hh-sol-artifact-1",
      contractName,
      sourceName,
      abi: contract.abi,
      bytecode: "0x" + contract.evm.bytecode.object,
      deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
      linkReferences: {},
      deployedLinkReferences: {},
    };
    fs.writeFileSync(path.join(outDir, `${contractName}.json`), JSON.stringify(artifact, null, 2));
  }
}

console.log(`Compiled ${solFiles.length} source file(s) via solc-js (local sandbox path).`);
