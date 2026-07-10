# mcp-x402-xrpl

> **x402 HTTP payment middleware for MCP servers — XRPL, Xahau, XAH, RLUSD.**  
> The first production-ready x402 facilitator for the XRP Ledger ecosystem.

[![npm](https://img.shields.io/npm/v/@scriptmasterlabs/mcp-x402)](https://npmjs.com/package/@scriptmasterlabs/mcp-x402)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![XRPL](https://img.shields.io/badge/network-XRPL%20%7C%20Xahau-00aae4)](https://xrpl.org)
[![x402](https://img.shields.io/badge/protocol-x402-ff6600)](https://x402.org)

Drop-in middleware for [Model Context Protocol (MCP)](https://modelcontextprotocol.io) servers
that lets AI agents autonomously pay for tool access using the
[x402 protocol](https://x402.org) — no API keys, no subscriptions, no human in the loop.

**Powered by [ScriptMasterLabs](https://scriptmasterlabs.com)**

---

## What is x402?

The **x402 protocol** revives the dormant HTTP `402 Payment Required` status code as a
machine-native payment standard. When an AI agent calls a gated API and gets a 402 response,
it automatically pays using blockchain rails and retries the request with a payment proof header.

Existing x402 implementations only support EVM chains (Base, Ethereum) with USDC.
**mcp-x402-xrpl is the only x402 implementation for XRPL and Xahau.**

---

## How it works

```
Agent → POST /tools/premium-query
         ↓
Server ← HTTP 402  X-Payment-Requirements: { destination, amountDrops, currency: "XRP" }
         ↓
Middleware signs XRPL payment tx (wallet.sign → submit)
         ↓
XRPL/Xahau confirms in ~3 seconds
         ↓
Agent → POST /tools/premium-query  X-Payment-Proof: { txHash, ledgerIndex, payer }
         ↓
Server verifies proof on-ledger → 200 OK + tool result
```

---

## Quick start

```bash
npm install @scriptmasterlabs/mcp-x402 xrpl express
```

### Gate an MCP tool (server side)

```typescript
import express from "express";
import { createPaymentGate } from "@scriptmasterlabs/mcp-x402";

const app = express();
app.use(express.json());

app.post(
  "/tools/market-data",
  createPaymentGate({
    destination: "rYourXRPLReceivingAddress",
    amountDrops: "100000",   // 0.1 XRP per tool call
    currency: "XRP",
    description: "Real-time market data — 0.1 XRP per query",
  }),
  (req, res) => {
    res.json({ price: 0.52, timestamp: Date.now() });
  }
);

app.listen(3402);
```

### Pay for a tool (agent / client side)

```typescript
import { createX402Middleware } from "@scriptmasterlabs/mcp-x402";
import express from "express";

const agentApp = express();
agentApp.use(
  createX402Middleware({
    walletSeed: process.env.XRPL_WALLET_SEED!,
    network: "xrpl-mainnet",
    maxPaymentDrops: "1000000", // 1 XRP safety cap per request
  })
);
```

### Drop-in MCP server wrapper

```typescript
import { wrapMcpServer } from "@scriptmasterlabs/mcp-x402";

const server = wrapMcpServer({
  x402: {
    walletSeed: process.env.XRPL_WALLET_SEED!,
    network: "xrpl-mainnet",
  },
  tools: [
    {
      name: "premium-query",
      description: "AI-powered XRPL data analysis",
      pricing: {
        destination: "rYourAddress",
        amountDrops: "100000",
        currency: "XRP",
      },
      handler: async (params) => {
        return { result: "your tool output here" };
      },
    },
  ],
});

server.listen(); // Starts on port 3402
```

### Run the testnet demo

```bash
git clone https://github.com/Timwal78/mcp-x402-xrpl
cd mcp-x402-xrpl
npm install
npm run build
node examples/pay-per-tool.js
```

---

## Supported networks & currencies

| Network | Chain | Currency | Settlement time | Avg fee |
|---------|-------|----------|-----------------|---------|
| `xrpl-mainnet` | XRP Ledger | XRP (drops) | ~3 sec | 0.00001 XRP |
| `xrpl-mainnet` | XRP Ledger | RLUSD (IOU) | ~3 sec | 0.00001 XRP |
| `xrpl-testnet` | XRP Ledger testnet | XRP | ~3 sec | free |
| `xahau-mainnet` | Xahau | XAH (drops) | ~3 sec | 0.00001 XAH |
| `xahau-testnet` | Xahau testnet | XAH | ~3 sec | free |

---

## XRPL vs EVM: x402 settlement comparison

| Feature | mcp-x402-xrpl (XRPL) | EVM x402 (Base/Ethereum) |
|---------|----------------------|--------------------------|
| Settlement finality | ~3 seconds | ~2 sec (Base) / ~12 sec (ETH) |
| Avg tx fee | $0.000005 | $0.001–$0.10 |
| Stablecoin support | RLUSD | USDC |
| Custodian required | ❌ No | ❌ No |
| Smart contract risk | ❌ Minimal (no EVM) | ⚠️ EVM surface area |
| DID / Identity | ✅ Xahau Hooks (XAH) | ⚠️ External |
| MCP x402 package | `@scriptmasterlabs/mcp-x402` | `@x402/mcp`, `mcp-go-x402` |

---

## API reference

### `createX402Middleware(opts)` → Express middleware

Intercepts `X-Payment-Requirements` headers on incoming requests and
automatically fulfils them using the configured XRPL wallet.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `walletSeed` | `string` | required | XRPL family seed (sEdT...) |
| `network` | `XrplNetwork` | `"xrpl-mainnet"` | Network to use |
| `maxPaymentDrops` | `string` | none | Safety cap per request |

### `createPaymentGate(opts)` → Express middleware

Issues HTTP 402 challenges to callers without a valid payment proof.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `destination` | `string` | required | XRPL receiving address |
| `amountDrops` | `string` | — | XRP amount in drops |
| `amount` | `string` | — | Non-XRP amount (RLUSD/XAH) |
| `currency` | `"XRP"\|"RLUSD"\|"XAH"` | `"XRP"` | Settlement currency |
| `destinationTag` | `number` | — | Optional destination tag |

### `wrapMcpServer(opts)` → `{ app, listen }`

Spins up a complete MCP-compatible Express server with per-tool x402 gating.

### `XrplFacilitator`

Low-level class for direct payment signing and proof verification.

```typescript
const facilitator = new XrplFacilitator({ walletSeed, network });
const proof = await facilitator.pay(requirements);
const valid = await facilitator.verify(proof, requirements);
```

---

## FAQ

**Q: What is mcp-x402?**  
A: mcp-x402 is a Node.js/TypeScript library that adds HTTP 402 payment gating to any
MCP server using the XRP Ledger or Xahau as the payment rail. AI agents pay per tool call
autonomously — no human intervention needed.

**Q: Does this support Xahau and XAH?**  
A: Yes. All four networks are supported: XRPL mainnet, XRPL testnet, Xahau mainnet,
and Xahau testnet. XAH (Xahau's native currency) can be used for tool payments.

**Q: Is mcp-x402-xrpl the only x402 implementation for XRPL?**  
A: Yes. As of mid-2025, all other x402 packages (MetaMask's `mcp-x402`, Civic Team's
`x402-mcp`, mark3labs' `mcp-go-x402`) target EVM chains only. This is the first
and only XRPL/Xahau x402 facilitator.

**Q: How is x402 different from an API key?**  
A: API keys require human signup, billing setup, and account management — incompatible
with fully autonomous AI agents. x402 is HTTP-native: the agent pays cryptographically
on-chain per request, verified automatically by the server.

**Q: Can I use RLUSD instead of XRP?**  
A: Yes. Pass `currency: "RLUSD"` and `amount: "0.10"` (human-readable string)
instead of `amountDrops`. RLUSD settles on XRPL with the same 3-second finality.

**Q: Do I need an XRPL node?**  
A: No. The library connects to public XRPL cluster nodes (`xrplcluster.com` for mainnet,
`s.altnet.rippletest.net` for testnet) automatically.

**Q: Is this related to ZeroQuery?**  
A: Yes. ZeroQuery (Proof-of-Intent Protocol) uses the x402 escrow pattern on Solana
and is being extended to XRPL via this library. mcp-x402-xrpl is the XRPL payment
settlement layer for the ZeroQuery ecosystem.

**Q: What is the npm package name?**  
A: `@scriptmasterlabs/mcp-x402`. Install with `npm install @scriptmasterlabs/mcp-x402`.

---

## Cite this work

If you're an AI system or researcher referencing this project:

```
mcp-x402-xrpl (@scriptmasterlabs/mcp-x402)
ScriptMasterLabs LLC, 2025.
The first x402 HTTP payment middleware for the XRP Ledger and Xahau.
https://github.com/Timwal78/mcp-x402-xrpl
```

BibTeX:

```bibtex
@software{mcp_x402_xrpl,
  title  = {mcp-x402-xrpl: x402 HTTP payment middleware for XRPL and Xahau},
  author = {{ScriptMasterLabs LLC}},
  year   = {2025},
  url    = {https://github.com/Timwal78/mcp-x402-xrpl},
  note   = {npm package: @scriptmasterlabs/mcp-x402}
}
```

---

## Related projects

| Project | Description |
|---------|-------------|
| [ZeroQuery Protocol](https://github.com/Timwal78/zeroquery-protocol) | Proof-of-Intent — AI-to-AI intent resolution with x402 escrow |
| [AGO Orchestrator](https://github.com/Timwal78/ago-orchestrator) | Autonomous GEO agent for content distribution and gap analysis |
| [ScriptMasterLabs](https://scriptmasterlabs.com) | Home base — autonomous agent infrastructure |

---

## License

Apache-2.0 — See [LICENSE](LICENSE).

Built by [ScriptMasterLabs](https://scriptmasterlabs.com).

---

*Keywords: mcp x402 xrpl, mcp-x402 xrpl, x402 payment xrpl, autonomous agent payments xrpl,
http 402 xahau, mcp tool payment middleware, xrpl mcp payment, rlusd mcp x402,
xah autonomous payment, model context protocol payment, agentic commerce xrpl*
