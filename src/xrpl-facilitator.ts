/**
 * @scriptmasterlabs/mcp-x402
 *
 * xrpl-facilitator.ts — XRPL/Xahau payment facilitator.
 *
 * Responsibilities:
 *  - Connect to the correct XRPL / Xahau network
 *  - Sign and submit payment transactions (XRP drops, RLUSD IOU, XAH)
 *  - Return a PaymentProof that the receiving MCP server can verify on-ledger
 *  - Verify incoming PaymentProof objects (server-side gate)
 *
 * This is the ONLY component that touches private key material.
 * Never log walletSeed. Never expose wallet.privateKey downstream.
 */

import { Client, Wallet, Payment, TxResponse, convertStringToHex } from "xrpl";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PaymentRequirements {
  /** Receiving XRPL address */
  destination: string;
  /** Optional destination tag */
  destinationTag?: number;
  /** XRP amount in drops (string to avoid BigInt precision issues) */
  amountDrops?: string;
  /** Human-readable amount for non-XRP currencies */
  amount?: string;
  /** Currency code */
  currency?: "XRP" | "RLUSD" | "XAH";
  /** Network identifier */
  network?: string;
  /** Human-readable description of the tool / service */
  description?: string;
  /** ISO timestamp — proof must be submitted before this */
  expiresAt?: string;
}

export interface PaymentProof {
  /** Transaction hash (hex) on XRPL/Xahau ledger */
  txHash: string;
  /** Ledger index where the tx was validated */
  ledgerIndex: number;
  /** Paying wallet address (public, safe to expose) */
  payer: string;
  /** The destination address paid */
  destination: string;
  /** Amount in drops or human-readable string */
  amount: string;
  /** Currency code */
  currency: string;
  /** Network the payment was submitted on */
  network: string;
  /** ISO timestamp of settlement */
  settledAt: string;
}

export type XrplNetwork = "xrpl-mainnet" | "xrpl-testnet" | "xahau-mainnet" | "xahau-testnet";

export interface XrplFacilitatorOptions {
  walletSeed: string;
  network: XrplNetwork;
}

// ─── Network WebSocket endpoints ─────────────────────────────────────────────

const NETWORK_URLS: Record<XrplNetwork, string> = {
  "xrpl-mainnet": "wss://xrplcluster.com",
  "xrpl-testnet": "wss://s.altnet.rippletest.net:51233",
  "xahau-mainnet": "wss://xahau.network",
  "xahau-testnet": "wss://xahau-test.net",
};

// ─── XrplFacilitator ─────────────────────────────────────────────────────────

export class XrplFacilitator {
  private readonly wallet: Wallet;
  private readonly network: XrplNetwork;
  private readonly wsUrl: string;

  constructor(opts: XrplFacilitatorOptions) {
    if (!opts.walletSeed) throw new Error("[mcp-x402] walletSeed is required");
    this.wallet = Wallet.fromSeed(opts.walletSeed);
    this.network = opts.network;
    this.wsUrl = NETWORK_URLS[opts.network];
  }

  /** Public address of the paying wallet (safe to log/expose) */
  get payerAddress(): string {
    return this.wallet.address;
  }

  /**
   * pay() — fulfil a PaymentRequirements challenge.
   * Connects, submits, waits for validation, disconnects.
   * Returns a PaymentProof the server can verify on-ledger.
   */
  async pay(req: PaymentRequirements): Promise<PaymentProof> {
    // Expiry guard
    if (req.expiresAt && new Date(req.expiresAt) < new Date()) {
      throw new Error("[mcp-x402] Payment requirements have expired");
    }

    const client = new Client(this.wsUrl);
    await client.connect();

    try {
      const tx = await this.buildPaymentTx(req);
      const result = await client.submitAndWait(tx, { wallet: this.wallet });

      return this.extractProof(result, req);
    } finally {
      await client.disconnect();
    }
  }

  /**
   * verify() — server-side: confirm that a PaymentProof actually exists on-ledger
   * and matches the expected requirements.
   */
  async verify(proof: PaymentProof, expected: PaymentRequirements): Promise<boolean> {
    const client = new Client(this.wsUrl);
    await client.connect();

    try {
      const tx = await client.request({
        command: "tx",
        transaction: proof.txHash,
      });

      const ledgerTx = tx.result as unknown as Record<string, unknown>;

      // Check destination
      if (ledgerTx["Destination"] !== expected.destination) return false;

      // Check amount
      if (expected.currency === "XRP" || !expected.currency) {
        const onChainAmt = ledgerTx["Amount"];
        if (typeof onChainAmt !== "string") return false;
        if (BigInt(onChainAmt) < BigInt(expected.amountDrops ?? "0")) return false;
      }

      // Check destination tag if specified
      if (expected.destinationTag !== undefined && ledgerTx["DestinationTag"] !== expected.destinationTag) {
        return false;
      }

      // Check tx was validated (not just submitted)
      const meta = ledgerTx["meta"] as Record<string, unknown> | undefined;
      if (meta?.["TransactionResult"] !== "tesSUCCESS") return false;

      return true;
    } catch {
      return false;
    } finally {
      await client.disconnect();
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async buildPaymentTx(req: PaymentRequirements): Promise<Payment> {
    const currency = req.currency ?? "XRP";

    let amount: Payment["Amount"];

    if (currency === "XRP") {
      if (!req.amountDrops) throw new Error("[mcp-x402] amountDrops required for XRP payments");
      amount = req.amountDrops; // string of drops
    } else if (currency === "RLUSD") {
      if (!req.amount) throw new Error("[mcp-x402] amount required for RLUSD payments");
      amount = {
        currency: convertStringToHex("RLUSD").padEnd(40, "0"),
        value: req.amount,
        // RLUSD issuer on XRPL mainnet
        issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      };
    } else if (currency === "XAH") {
      // XAH is native on Xahau — treated as drops there
      if (!req.amountDrops) throw new Error("[mcp-x402] amountDrops required for XAH payments");
      amount = req.amountDrops;
    } else {
      throw new Error(`[mcp-x402] Unsupported currency: ${currency}`);
    }

    const tx: Payment = {
      TransactionType: "Payment",
      Account: this.wallet.address,
      Destination: req.destination,
      Amount: amount,
      ...(req.destinationTag !== undefined ? { DestinationTag: req.destinationTag } : {}),
    };

    return tx;
  }

  private extractProof(result: TxResponse, req: PaymentRequirements): PaymentProof {
    const tx = result.result as unknown as Record<string, unknown>;
    const meta = tx["meta"] as Record<string, unknown> | undefined;

    if (meta?.["TransactionResult"] !== "tesSUCCESS") {
      throw new Error(`[mcp-x402] Transaction failed: ${String(meta?.["TransactionResult"])}`);
    }

    return {
      txHash: String(tx["hash"]),
      ledgerIndex: Number(tx["ledger_index"] ?? tx["inLedger"]),
      payer: this.wallet.address,
      destination: req.destination,
      amount: req.amountDrops ?? req.amount ?? "0",
      currency: req.currency ?? "XRP",
      network: this.network,
      settledAt: new Date().toISOString(),
    };
  }
}
