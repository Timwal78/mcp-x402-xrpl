# SML Autonomous Software Corporation (ASC) — implementation map

This maps the ASC blueprint's four components (capital layer, sovereign
gateway, payment core, sandboxed pipeline) to what actually exists in this
repo after this change, and — just as important — what doesn't yet.

## What's real after this change

| Blueprint component | File(s) | Status |
|---|---|---|
| Capital layer (SMLYieldBond / Factory) | `asc-contracts/contracts/*.sol` | Compiles, has a Hardhat test suite. **Not deployed to any network.** |
| Swarm message routing (CEO/CFO/CTO/QA) | `src/asc/SMLAgentSwarmOrchestrator.ts` | Real in-memory routing logic. Two modes — see "BYOK real agent reasoning" below. |
| Real agent reasoning (BYOK) | `src/asc/llm-agent.ts` | Real Claude API calls (your own key) replace string-matching when configured. See below for exactly what this does and doesn't change. |
| Autonomous "set and forget" loop | `SMLAgentSwarmOrchestrator.startAutonomousCeoLoop()` | Real periodic loop reading on-chain bond state + message history and deciding via the CEO's LLM reasoning. Requires the BYOK key above — there's no deterministic equivalent. **Not started anywhere** — it's a method you call, not something running yet. |
| CFO → on-chain revenue split | same file, `handleCFOMessage` | Real `ethers` call to `processRevenue()` — but only works once a bond is deployed and funded (see above). The amount sent on-chain always comes from the verified triggering message, never from LLM-generated text, in both modes. |
| Legacy system bridge | `src/bridges/SMLGhostLegacyBridge.ts` | Real `execFile`-based whitelist bridge. No legacy binaries (`query_legacy_db`, etc.) are on any host yet — those are what a specific legacy integration would provide. |
| Cloudflare Worker deploy | `wrangler.toml`, `src/asc/worker-entry.ts` | Config exists; nothing has been deployed via it yet (needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets). Note: the autonomous loop cannot run here — Workers don't keep a process alive between requests, so `setInterval` doesn't survive. Message-triggered LLM mode works fine on Workers; the always-on loop is Render-only (or a separate Cron Trigger, not implemented). |
| Render persistent-service deploy | `render.yaml`, `src/asc/render-entry.ts` | **The `sml-asc-orchestrator` block was removed from `render.yaml`** after it crash-looped in production with no env vars set (see git history). Re-add it only once `BASE_RPC_URL`/`ORCHESTRATOR_PRIVATE_KEY`/`BOND_CONTRACT_ADDRESS` are actually ready — this repo is a connected Render Blueprint, so adding that block provisions a real service immediately, not just documentation. |
| Sandboxed QA patch review | `SMLAgentSwarmOrchestrator.evaluatePatch()` (deterministic mode) / LLM-mode QA handler | Deterministic mode is **explicitly a placeholder** — it only checks the numeric metric the CTO agent claims, no compile/lint/dry-run. LLM mode is a real improvement (Claude actually reads and reasons about the proposed change description) but is still text-based code review, not sandboxed execution — the blueprint's "ephemeral runtime sandbox" (Cloudflare Workers/containers actually running the code) is still not implemented in either mode. |

## Compliance framing (read before funding anything)

`SMLYieldBond` now exposes a public `INSTRUMENT_TYPE` constant — anyone can
read it straight off the deployed contract, no docs required:

> Capped revenue-factoring / royalty agreement. NOT equity. NOT a pooled
> investment fund. No voting rights. No ownership interest. Return capped
> at repaymentCapMultiplier. Non-custodial, autonomous execution — operator
> / protocol never hold funds between calls. Not legal advice; consult
> securities counsel in your jurisdiction before investing.

That last sentence is load-bearing. Structuring something as a capped,
non-equity revenue share is a reasonable starting posture, but whether it
actually falls outside securities law depends on facts (how it's marketed,
who buys it, jurisdiction) that code can't settle. **Get real securities
counsel before any investor outside your own testing deposits real
USDC/RLUSD into a deployed bond.**

## Autonomy & who gets paid

This is designed to be set-and-forget, not something you operate bond by
bond:

- `fund()` automatically closes funding and splits the raise (protocol fee
  + operator capital) the instant the target is hit — no one has to call
  anything to "finalize" a raise.
- `processRevenue()` automatically computes each investor's pro-rata share,
  caps it at their `repaymentCapMultiplier`, and pays the remainder to the
  operator — every time it's called, with no per-call configuration.
- **The only money the protocol operator (you) ever receives is
  `protocolFeeBasisPoints` — 0.5%, hardcoded in the factory, identical on
  every bond.** It is paid once, automatically, at `_closeFunding()`. There
  is no code path where the protocol takes a cut of ongoing revenue,
  and no per-bond discretion to change that number after deployment.
- The trade-off for that hands-off design: nothing here manages *which*
  bonds get deployed, sets sane funding targets, or checks that an ASC's
  revenue can actually support its repayment cap. That judgment still has
  to happen before `deployBond()` is called — the contract enforces the
  terms once they're set, it doesn't evaluate whether they're wise.

## BYOK real agent reasoning (`src/asc/llm-agent.ts`)

This closes the gap this doc used to flag: the CEO/CFO/CTO/QA "agents" were
originally just `if (payload.includes("OPTIMIZE"))`-style string matching —
no actual judgment, no LLM anywhere. Now, if `ANTHROPIC_API_KEY` is set,
each handler asks a real Claude call (with a role-specific system prompt)
to decide what to do, instead of pattern-matching.

**BYOK, literally** — `ANTHROPIC_API_KEY` is read directly from the
environment where the orchestrator runs (e.g. the Render service's env
vars) and billed to that key's own Anthropic account. There is no shared
or platform key anywhere in this code.

**What changed and what didn't:**
- No `ANTHROPIC_API_KEY` set → identical deterministic behavior to before
  (this is what the test suite runs against, so CI needs no real key).
- `ANTHROPIC_API_KEY` set → every message-triggered handler call becomes a
  real, billed API call. There is currently no caching/batching — a busy
  message bus means proportionally more API spend. Size your expectations
  accordingly before turning this on.
- The CFO handler's on-chain amount is **never** taken from LLM output in
  either mode — it's parsed from the verified triggering message before the
  LLM is even asked. The LLM in CFO mode is strictly a yes/no gate on
  whether to proceed, not a source of the number that gets sent to
  `processRevenue()`. This is deliberate: a hallucinated dollar amount is a
  much worse failure mode than a hallucinated "should I optimize" opinion.

**The autonomous loop** (`startAutonomousCeoLoop(intervalMs)`) is the actual
"set it and forget it" piece — it requires `ANTHROPIC_API_KEY` (there's no
deterministic version; a timer with nothing to pattern-match would do
nothing every tick) and is wired into `render-entry.ts` behind
`ASC_AUTONOMOUS=true`. Every tick reads real on-chain bond state
(`isFundingClosed`, `totalRaised`) plus recent message history and asks the
CEO agent to decide if anything needs doing. **It is not running anywhere**
— turning it on requires deploying the Render service with real env vars,
which hasn't happened (see the removed `render.yaml` block above).

Required/optional env vars for this, on top of what `render-entry.ts`
already needed:

| Var | Required | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | For LLM mode at all | Your own key, billed directly. Unset = fully deterministic, zero API cost. |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-5`. |
| `ASC_AUTONOMOUS` | No | `true` starts the always-on CEO loop. Requires `ANTHROPIC_API_KEY` — throws at startup otherwise. |
| `ASC_CEO_INTERVAL_MS` | No | Defaults to 600000 (10 min). Every tick is a billed API call — this is the actual cost knob. |

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
7. (Optional) Add `ANTHROPIC_API_KEY` to enable real agent reasoning instead
   of deterministic pattern-matching; add `ASC_AUTONOMOUS=true` on top of
   that to start the always-on CEO loop. Neither requires re-doing steps
   1–6, but neither does anything without them either — an autonomous CEO
   with no deployed bond to read has nothing real to reason about.

None of steps 2–7 have been done as part of this change.
