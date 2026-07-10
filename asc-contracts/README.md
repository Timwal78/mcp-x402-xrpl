# SML ASC Contracts

Standalone Hardhat project for the SML Autonomous Software Corporation (ASC)
yield-bond funding layer. Kept separate from the parent package's `src/`
because it needs CommonJS + Hardhat's toolchain, while the parent package is
an ESM `tsx`-run Express service — mixing the two module systems in one
`tsconfig.json` causes more problems than a subdirectory does.

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

## Deploying

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
