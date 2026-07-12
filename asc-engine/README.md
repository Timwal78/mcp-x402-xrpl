# ASC Engine

Deploy a small software business that funds itself, pays its investors
automatically, and runs its own executive loop — without you holding
anyone's money.

**ASC** = Autonomous Software Corporation: a capped, non-custodial on-chain
revenue bond (`SMLYieldBond`) paired with an agent swarm (CEO / CFO / CTO /
QA) that reads real on-chain state and message history and decides what the
business needs, with no human in the loop unless you want one.

## What's actually real here (read this before anything else)

- **The contracts are real, tested Solidity**, not a mockup. `contracts/`
  has a full Hardhat test suite covering funding close-out, pro-rata
  revenue splits, per-investor repayment caps (including under repeated
  revenue events), and the on-chain compliance disclosure. Run `npm test`
  inside `contracts/` yourself.
- **The agent swarm is real routing logic**, not a chatbot demo. It runs in
  two modes: deterministic pattern-matching (zero cost, zero API key) or
  real Claude reasoning per role if you bring your own `ANTHROPIC_API_KEY`.
- **The on-chain amount the CFO agent sends is never LLM-generated.** It's
  parsed from the verified triggering message before any LLM is even
  asked. The LLM only ever gets a yes/no gate on whether to proceed — a
  hallucinated dollar amount reaching `processRevenue()` is architecturally
  impossible, not just discouraged.
- **What's explicitly NOT real yet**: the QA agent's "sandboxed patch
  review" is text-based reasoning about a change description, not actual
  compilation or execution of code. The always-on autonomous CEO loop only
  runs on a persistent host, not on edge/Workers deploys. Full details in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — we'd rather tell you
  what's not finished than have you find out after you've deployed real
  money against it.

## Quickstart

```bash
git clone <this-repo>
cd asc-engine
npm install
npm run setup      # interactive wizard — writes contracts/.env and .env
```

The wizard walks you through deploying to Base Sepolia (testnet) first,
then Base mainnet once you've verified it. It does not deploy anything
itself or transmit your keys anywhere — it only writes local `.env` files
and prints the exact commands to run next.

Manual path, if you'd rather not use the wizard: see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#deploying-for-real-in-order).

## Run the orchestrator

```bash
npm run start:server          # persistent host (Render, a VM, etc.)
# or deploy src/worker.ts to Cloudflare Workers via wrangler.toml
```

```bash
curl -X POST http://localhost:3404/message \
  -H 'content-type: application/json' \
  -d '{"sender":"CFO","recipient":"CEO","payload":"INSUFFICIENT_FUNDS_FOR_HOSTING"}'
```

## Why you'd deploy your own instead of using someone else's

Whoever deploys the `SMLYieldBondFactory` becomes its `protocolTreasury` —
every bond raised through *your* factory pays *you* 0.5%, forever,
automatically, with no code change needed per bond. That's the entire
economic point of running your own ASC rather than renting someone else's.

## Before you fund anything with real money

`SMLYieldBond` exposes a public `INSTRUMENT_TYPE` constant on-chain:
a capped revenue-factoring/royalty agreement, not equity, no voting
rights, no ownership interest — but that framing is a reasonable starting
posture, not a legal opinion. **Get real securities counsel in your own
jurisdiction before any investor besides you deposits real funds into a
bond you deploy.** See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
the full compliance framing.

## License

Business Source License 1.1 — free to clone, run, and self-host for
development, evaluation, and single-instance production use. Commercial
licensing required beyond that. See [`LICENSE`](LICENSE).

## Structure

```
contracts/          Solidity contracts + Hardhat deploy/test scripts
src/SwarmOrchestrator.ts   Agent message routing + on-chain revenue calls
src/llm-agent.ts           BYOK Claude reasoning layer
src/server.ts              Persistent-host entry point (Render, VMs)
src/worker.ts               Cloudflare Workers entry point
scripts/setup-wizard.ts    Interactive .env setup
docs/ARCHITECTURE.md       Full technical + compliance writeup
```
