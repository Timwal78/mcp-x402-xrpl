# ASC Engine — architecture

This maps the ASC blueprint's components to what's actually in this repo,
and — just as important — what isn't, so you know exactly what you're
deploying before real money touches it.

## Components

| Component | File(s) | What it actually does |
|---|---|---|
| Capital layer (SMLYieldBond / Factory) | `contracts/contracts/*.sol` | Compiles, has a real Hardhat test suite (`npm test` inside `contracts/`). Not deployed anywhere until you run the deploy scripts yourself. |
| Swarm message routing (CEO/CFO/CTO/QA) | `src/SwarmOrchestrator.ts` | Real in-memory routing logic. Two modes — see below. |
| Real agent reasoning (BYOK) | `src/llm-agent.ts` | Real Claude API calls (your own key) replace string-matching when `ANTHROPIC_API_KEY` is set. |
| Autonomous "set and forget" loop | `SMLAgentSwarmOrchestrator.startAutonomousCeoLoop()` | Real periodic loop reading on-chain bond state + message history and deciding via the CEO's LLM reasoning. Requires the BYOK key — no deterministic equivalent exists (a timer with nothing to pattern-match would do nothing). Only runs on a persistent host (`src/server.ts`), not on Cloudflare Workers. |
| CFO → on-chain revenue split | `SwarmOrchestrator.ts`, `handleCFOMessage` | Real `ethers` call to `processRevenue()` — works once your bond is deployed and funded. The amount sent on-chain always comes from the verified triggering message, never from LLM-generated text, in both modes. |
| Persistent-host deploy | `render.yaml`, `src/server.ts` | Degrades gracefully — the process always starts and answers `/health` even with zero env vars set; only `/message` returns 503 until chain config is complete. |
| Edge deploy | `wrangler.toml`, `src/worker.ts` | Stateless per-request handler. No autonomous loop here (see above). |
| Sandboxed QA patch review | `evaluatePatch()` (deterministic mode) / LLM-mode QA handler | Deterministic mode is **explicitly a placeholder** — it only checks the numeric metric the CTO agent claims, no compile/lint/dry-run. LLM mode is a real improvement (an LLM actually reads and reasons about the proposed change description) but is still text-based review, not sandboxed execution. A true ephemeral runtime sandbox is not implemented in either mode. |

## Compliance framing — read before funding anything

`SMLYieldBond` exposes a public `INSTRUMENT_TYPE` constant — anyone can read
it straight off the deployed contract, no docs required:

> Capped revenue-factoring / royalty agreement. NOT equity. NOT a pooled
> investment fund. No voting rights. No ownership interest. Return capped
> at repaymentCapMultiplier. Non-custodial, autonomous execution — operator
> / protocol never hold funds between calls. Not legal advice; consult
> securities counsel in your jurisdiction before investing.

That last sentence is load-bearing, and it applies to **you as the deployer**,
not just to the original authors of this code. Structuring something as a
capped, non-equity revenue share is a reasonable starting posture, but
whether it actually falls outside securities law in your jurisdiction
depends on facts (how it's marketed, who buys it, where) that code can't
settle. **Get real securities counsel before any investor outside your own
testing deposits real funds into a bond you deploy.**

This applies regardless of where or how you distribute the *software* — the
legal question is about what the *deployed contract* does with real
investor money, not about this repo.

## Autonomy & who gets paid

This is designed to be set-and-forget, not something you operate bond by
bond:

- `fund()` automatically closes funding and splits the raise (protocol fee
  + operator capital) the instant the target is hit — no one has to call
  anything to "finalize" a raise.
- `processRevenue()` automatically computes each investor's pro-rata share,
  caps it at their `repaymentCapMultiplier`, and pays the remainder to the
  operator — every time it's called, with no per-call configuration.
- **The only money the protocol owner (you, once you deploy your own
  factory) ever receives is `protocolFeeBasisPoints` — 0.5%, hardcoded in
  the factory, identical on every bond deployed through it.** It is paid
  once, automatically, at `_closeFunding()`. There is no code path where the
  protocol takes a cut of ongoing revenue, and no per-bond discretion to
  change that number after deployment.
- The trade-off for that hands-off design: nothing here manages *which*
  bonds get deployed, sets sane funding targets, or checks that an ASC's
  revenue can actually support its repayment cap. That judgment still has
  to happen before `deployBond()` is called — the contract enforces the
  terms once they're set, it doesn't evaluate whether they're wise.

## BYOK real agent reasoning

The CEO/CFO/CTO/QA "agents" have two modes:
- No `ANTHROPIC_API_KEY` set → deterministic string-matching. Zero cost,
  zero external dependency. What the test suite runs against.
- `ANTHROPIC_API_KEY` set → every message-triggered handler call becomes a
  real, billed API call, reasoning with a role-specific system prompt over
  real context (on-chain state, recent messages). There is no
  caching/batching — a busy message bus means proportionally more spend.

`ANTHROPIC_API_KEY` is read directly from your own environment and billed
to your own account. There is no shared or platform key anywhere in this
code.

The CFO handler's on-chain amount is **never** taken from LLM output in
either mode — it's parsed from the verified triggering message before the
LLM is even asked. The LLM in CFO mode is strictly a yes/no gate on whether
to proceed, not a source of the number that gets sent to `processRevenue()`.
A hallucinated dollar amount is a much worse failure mode than a
hallucinated "should I optimize" opinion — the code is structured so the
former is architecturally impossible, not just unlikely.

## Deploying for real, in order

1. `npm run setup` (repo root) — interactive wizard, writes both `.env` files.
   Or do it by hand:
2. `cd contracts && npm install`, fill in `.env` from `.env.example`.
3. `npm run deploy:base-sepolia` — verify the factory + a test bond on a
   testnet before touching mainnet funds.
4. `npm run deploy:base` once that's verified. Record the resulting
   `factoryAddress`.
5. Call `factory.deployBond(...)` with the real funding parameters for this
   ASC instance (funding target, repayment cap, revenue split) — deliberately
   a manual step, not scripted, since those are business terms only you can set.
6. Set `BOND_CONTRACT_ADDRESS` (the resulting bond, not the factory) plus
   `BASE_RPC_URL` and `ORCHESTRATOR_PRIVATE_KEY` wherever you deploy the
   orchestrator (Render dashboard, Worker secrets, or your own `.env`).
7. Only then does the CFO handler have anything real to call.
8. (Optional) Add `ANTHROPIC_API_KEY` to enable real agent reasoning instead
   of deterministic pattern-matching; add `ASC_AUTONOMOUS=true` on a
   persistent host on top of that to start the always-on CEO loop. Watch
   message-triggered mode behave correctly first before flipping this on —
   it lets a real wallet act on an LLM's judgment with nobody approving
   each cycle.
