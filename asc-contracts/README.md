# SML ASC Contracts

Standalone Hardhat project for two things that share one Base-focused Hardhat
setup:

1. The SML Autonomous Software Corporation (ASC) yield-bond funding layer
   (`SMLYieldBond`, `SMLYieldBondFactory`).
2. The **x402 Settlement Router** — a non-custodial multi-agent payment
   netting layer (`contracts/settlement-router/`). See its own section below.

Kept separate from the parent package's `src/` because it needs CommonJS +
Hardhat's toolchain, while the parent package is an ESM `tsx`-run Express
service — mixing the two module systems in one `tsconfig.json` causes more
problems than a subdirectory does.

## Status

No contract from this directory has been deployed to any network yet
(mainnet, Base, or otherwise). `deployments/` will contain one JSON record
per network once `npm run deploy:*` is actually run against it.

## Setup

```bash
cd asc-contracts
npm install
cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY, RPC URLs, PROTOCOL_TREASURY_ADDRESS
npm run compile
npm test
```

### If `npx hardhat compile` fails to download the compiler

Some sandboxed environments block `binaries.soliditylang.org` entirely.
`npm run local-compile` (`scripts/local-compile.cjs`) compiles the same
sources through the official `solc` npm package instead (same compiler,
different — permitted — distribution channel) and writes Hardhat-format
artifacts directly, so `npx hardhat test --no-compile` still runs. This is a
local-sandbox fallback only; `npx hardhat compile` is still the documented
path anywhere with normal network access.

## Deploying (ASC yield bonds)

```bash
npm run deploy:base-sepolia   # testnet first
npm run deploy:base           # real funds after that's verified
```

`scripts/deploy.ts` deploys `SMLYieldBondFactory` only. Individual
`SMLYieldBond` instances are created per-ASC by calling
`factory.deployBond(paymentToken, fundingTarget, repaymentCapMultiplier, repaymentSplitBasisPoints)`
— there is deliberately no script that does this automatically, since those
parameters (funding target, repayment cap, revenue split) are a real business
decision per ASC instance, not a default to rubber-stamp.

---

## x402 Settlement Router

Non-custodial payment-graph netting for multi-agent tasks. Agents doing
sub-tasks for pay produce a gross payment graph (A owes B, B owes C, ...);
instead of settling every edge as its own on-chain transaction, the graph is
netted off-chain to one balance per agent and submitted as a single Base
transaction, taking a protocol fee capped at 5% (default 0.5%).

### Contracts (`contracts/settlement-router/`)

| Contract | Role |
|---|---|
| `FeeRegistry` | The only mutable piece — protocol fee (bps) + treasury address, hard-capped at 5%. Owner should be a Gnosis Safe multisig. |
| `IReputationOracle` / `ReputationOracle` | Bond-tier lookup. Mirrors the **real** ARGUS/402Proof credit score already live in this package (`src/credit-bureau.ts`, 300-850 FICO-style: PROTOSTAR/NEUTRON/PULSAR/QUASAR) rather than a fabricated scale. Scores are pushed by an off-chain updater (`scripts/update-reputation-oracle.ts`), not computed on-chain. |
| `TaskEscrow` | One per task, deployed as an ERC-1167 minimal proxy clone. Holds the task budget + every agent's bond. No admin key beyond a 7-day-timelocked `emergencyWithdraw()` for the orchestrator. |
| `SettlementRouter` | One per orchestrator. Deploys `TaskEscrow` clones, drives `settle()`/`slash()`. Immutable after construction. |
| `SettlementRouterFactory` | Singleton. Deploys `FeeRegistry`, `ReputationOracle`, the `TaskEscrow` clone template, and hands out one router per orchestrator. |

### Off-chain half (`../src/settlement-router/`)

- `netting.ts` — pure netting algorithm (`netPayments`) + budget pre-flight check (`validateTaskGraph`). No chain I/O, no keys.
- `client.ts` — ethers wrapper (`SettlementRouterClient`) that nets a payment graph and submits `settleTask()`.
- HTTP surface: `../src/vending-router-server.ts`'s `/settlement-router/tasks*` routes.
- Orchestrator hook: `SqueezeOS/core/api/settlement_router_bp.py` (separate repo) — off-chain task/edge bookkeeping that calls the HTTP surface above to actually create/settle on-chain.

### Deploying

```bash
npm run deploy-settlement-router:base-sepolia   # testnet first — deploys FeeRegistry + ReputationOracle + TaskEscrow impl + SettlementRouterFactory
npm run create-router:base-sepolia              # one router per orchestrator (ORCHESTRATOR_ADDRESS env var)
npm run update-reputation-oracle:base-sepolia   # push real ARGUS scores on-chain (needs an agentDid->address map, see .env.example)
```

Swap `base-sepolia` for `base` once verified. See `.env.example` for every
required variable — `PROTOCOL_TREASURY_ADDRESS` must be a multisig, and
`TOKEN_ADDRESS` defaults to canonical USDC on Base / Base Sepolia if unset
(verified against Circle's published contract address list).

### What's NOT done yet

- Not deployed to any network.
- No agentDid → Base-address mapping exists anywhere in this codebase (ARGUS is DID-keyed, `TaskEscrow` is address-keyed) — `scripts/update-reputation-oracle.ts` requires one to be supplied explicitly rather than guessing.
- Slashing is MVP-only: an orchestrator-signed call, not automated output-hash comparison or ARGUS score decay (both noted as future work in the PRD, not built).
- No priority-fee / queue-jump revenue stream (PRD "Stream 2") — only the core protocol fee (Stream 1) is implemented.
