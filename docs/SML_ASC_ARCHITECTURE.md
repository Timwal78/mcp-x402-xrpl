# SML Autonomous Software Corporation (ASC) — implementation map

This maps the ASC blueprint's four components (capital layer, sovereign
gateway, payment core, sandboxed pipeline) to what actually exists in this
repo after this change, and — just as important — what doesn't yet.

## What's real after this change

| Blueprint component | File(s) | Status |
|---|---|---|
| Capital layer (SMLYieldBond / Factory) | `asc-contracts/contracts/*.sol` | Compiles, has a Hardhat test suite. **Not deployed to any network.** |
| Swarm message routing (CEO/CFO/CTO/QA) | `src/asc/SMLAgentSwarmOrchestrator.ts` | Real in-memory routing logic. |
| CFO → on-chain revenue split | same file, `handleCFOMessage` | Real `ethers` call to `processRevenue()` — but only works once a bond is deployed and funded (see above). |
| Legacy system bridge | `src/bridges/SMLGhostLegacyBridge.ts` | Real `execFile`-based whitelist bridge. No legacy binaries (`query_legacy_db`, etc.) are on any host yet — those are what a specific legacy integration would provide. |
| Cloudflare Worker deploy | `wrangler.toml`, `src/asc/worker-entry.ts` | Config exists; nothing has been deployed via it yet (needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets). |
| Render persistent-service deploy | `render.yaml` (`sml-asc-orchestrator`), `src/asc/render-entry.ts` | Config exists; the Render service itself still needs to be created and its env vars filled in before it starts (it throws on missing `BASE_RPC_URL`/`ORCHESTRATOR_PRIVATE_KEY`/`BOND_CONTRACT_ADDRESS` rather than silently no-oping). |
| Sandboxed QA patch review | `SMLAgentSwarmOrchestrator.evaluatePatch()` | **Explicitly a placeholder.** It only checks the numeric metric the CTO agent claims — it does not compile, lint, or dry-run anything. The blueprint's "ephemeral runtime sandbox" (Cloudflare Workers/containers) is not implemented. |

## Why contracts live in `asc-contracts/` instead of `src/`

The parent package (`@scriptmasterlabs/mcp-x402`) is ESM, built with `tsc`
and run with `tsx`. Hardhat's toolchain (and `hardhat-toolbox`) assumes
CommonJS. Rather than fighting that mismatch in one `tsconfig.json`,
`asc-contracts/` is a self-contained project with its own `package.json` —
`npm install` there separately from the repo root.

## Deploying for real, in order

1. `cd asc-contracts && npm install`, fill in `.env` from `.env.example`.
2. `npm run deploy:base-sepolia` — verify the factory + a test bond on a
   testnet before touching mainnet funds.
3. `npm run deploy:base` once that's verified. Record the resulting
   `factoryAddress`.
4. Call `factory.deployBond(...)` with the real funding parameters for this
   ASC instance (funding target, repayment cap, revenue split) — deliberately
   a manual step, not scripted, since those are business terms.
5. Set `BOND_CONTRACT_ADDRESS` (the resulting bond, not the factory) plus
   `BASE_RPC_URL` and `ORCHESTRATOR_PRIVATE_KEY` on the `sml-asc-orchestrator`
   Render service (or as Worker secrets, if deploying there instead).
6. Only then does `handleCFOMessage` have anything real to call.

None of steps 2–6 have been done as part of this change.
