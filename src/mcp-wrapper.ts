/**
 * @scriptmasterlabs/mcp-x402
 *
 * mcp-wrapper.ts — Drop-in wrapper that adds x402 XRPL payment gating
 * to any existing MCP (Model Context Protocol) server.
 *
 * Usage:
 *   import { wrapMcpServer } from "@scriptmasterlabs/mcp-x402";
 *   const server = wrapMcpServer(myMcpServer, { ... });
 *
 * The wrapper intercepts tool calls, checks for payment proof,
 * and either issues a 402 challenge or passes through to the real handler.
 */

import { createPaymentGate, createX402Middleware, PaymentGateOptions, X402MiddlewareOptions } from "./x402-middleware.js";
import express, { Application, Router } from "express";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description: string;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface McpToolWithPricing extends McpTool {
  /** If omitted, the tool is free */
  pricing?: PaymentGateOptions;
}

export interface McpServerOptions {
  /** Port to listen on. Default: 3402 */
  port?: number;
  /** x402 middleware options (wallet seed, network, cap) */
  x402: X402MiddlewareOptions;
  /** Tools to register */
  tools: McpToolWithPricing[];
  /** Server name shown in MCP server manifest */
  serverName?: string;
  /** Server version */
  serverVersion?: string;
}

// ─── wrapMcpServer ────────────────────────────────────────────────────────────

/**
 * Spins up a lightweight MCP-compatible Express server with x402 payment
 * gating on any tools that have a `pricing` field.
 *
 * @example
 * ```ts
 * import { wrapMcpServer } from "@scriptmasterlabs/mcp-x402";
 *
 * const server = wrapMcpServer({
 *   x402: { walletSeed: process.env.XRPL_WALLET_SEED!, network: "xrpl-mainnet" },
 *   tools: [
 *     {
 *       name: "premium-market-data",
 *       description: "Real-time XRP/USD price feed",
 *       pricing: {
 *         destination: "rYourReceivingAddress",
 *         amountDrops: "100000",  // 0.1 XRP per call
 *         currency: "XRP",
 *         description: "0.1 XRP per market data query",
 *       },
 *       handler: async (params) => {
 *         return { price: 0.52, timestamp: Date.now() };
 *       },
 *     },
 *   ],
 * });
 *
 * server.listen();
 * ```
 */
export function wrapMcpServer(opts: McpServerOptions): { app: Application; listen: () => void } {
  const app = express();
  const port = opts.port ?? 3402;

  app.use(express.json());

  // Attach x402 client-side middleware (handles outbound 402 fulfillment)
  app.use(createX402Middleware(opts.x402));

  // MCP server manifest (GET /.well-known/mcp)
  app.get("/.well-known/mcp", (_req, res) => {
    res.json({
      name: opts.serverName ?? "mcp-x402-xrpl",
      version: opts.serverVersion ?? "0.1.0",
      protocol: "mcp/1.0",
      payment: {
        protocol: "x402",
        network: opts.x402.network ?? "xrpl-mainnet",
        currency: "XRP",
        info: "https://github.com/Timwal78/mcp-x402-xrpl",
      },
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.pricing ? { pricing: t.pricing } : {}),
      })),
    });
  });

  // Register tool routes
  const toolRouter = Router();

  for (const tool of opts.tools) {
    const handlers = [];

    // Gated tool — add payment gate middleware
    if (tool.pricing) {
      handlers.push(createPaymentGate(tool.pricing));
    }

    // Tool handler
    handlers.push(async (req: express.Request, res: express.Response) => {
      try {
        const result = await tool.handler(req.body as Record<string, unknown>);
        res.json({ result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    toolRouter.post(`/${tool.name}`, ...handlers);
  }

  app.use("/tools", toolRouter);

  return {
    app,
    listen: () => {
      app.listen(port, () => {
        console.log(`[mcp-x402] MCP server listening on http://localhost:${port}`);
        console.log(`[mcp-x402] Manifest: http://localhost:${port}/.well-known/mcp`);
        console.log(`[mcp-x402] Tools: ${opts.tools.map((t) => t.name).join(", ")}`);
      });
    },
  };
}
