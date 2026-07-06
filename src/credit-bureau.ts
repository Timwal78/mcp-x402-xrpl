/**
 * @scriptmasterlabs/mcp-x402
 *
 * credit-bureau.ts — ARGUS Agent Credit Bureau
 *
 * FICO-style credit scoring for autonomous AI agents (300–850 scale).
 * Every agent DID is registered on first contact at score 300.
 * Paid x402 calls increment the score (+5 pts, cap 850).
 *
 * Tier schedule (matches squeezeos-server.ts dynamic price gate):
 *   300–499  PROTOSTAR   — free tier access only
 *   500–699  NEUTRON     — paid access, standard price
 *   700–799  PULSAR      — VIP price (20% discount)
 *   800–850  QUASAR      — Platinum price (40% discount)
 *
 * All state is stored in Redis. Keys:
 *   bureau:score:<agentDid>       → number (score)
 *   bureau:calls:<agentDid>       → number (total paid calls)
 *   bureau:firstSeen:<agentDid>   → ISO timestamp
 *   bureau:lastSeen:<agentDid>    → ISO timestamp
 *   bureau:history:<agentDid>     → list of last 20 call timestamps (LPUSH + LTRIM)
 *   bureau:anchor:<agentDid>      → JSON { txHash, anchoredAt, network, score, tier }
 *
 * On-chain anchor (optional — requires XAHAU_SEED env var):
 *   After each paid call the new score is anchored on Xahau via a self-payment
 *   with a Memo containing the score JSON. The txHash is stored in Redis so any
 *   caller can independently verify the score history on-chain.
 */

import type { Redis } from "ioredis";
import { Client, Wallet } from "xrpl";

// ─── Constants ────────────────────────────────────────────────────────────────

const SCORE_INITIAL = 300;
const SCORE_MAX = 850;
const SCORE_PER_PAID_CALL = 5;
const HISTORY_MAX = 20;
const XAHAU_DEFAULT_WS = "wss://xahau.network";

// ─── Tier definition ─────────────────────────────────────────────────────────

export interface AgentTier {
  name: string;
  minScore: number;
  maxScore: number;
  priceRlusd: string;
  benefit: string;
}

const TIERS: AgentTier[] = [
  { name: "PROTOSTAR", minScore: 300, maxScore: 499, priceRlusd: "0.10", benefit: "Free tier access" },
  { name: "NEUTRON",   minScore: 500, maxScore: 699, priceRlusd: "0.10", benefit: "Standard paid access" },
  { name: "PULSAR",    minScore: 700, maxScore: 799, priceRlusd: "0.08", benefit: "VIP access — 20% discount" },
  { name: "QUASAR",    minScore: 800, maxScore: 850, priceRlusd: "0.06", benefit: "Platinum — priority routing + 40% discount" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface XahauAnchorConfig {
  /** Xahau account seed for signing anchor transactions (base58 family seed) */
  xahauSeed?: string;
  /** Xahau WebSocket node (default: wss://xahau.network) */
  xahauWs?: string;
  /** Ghost Layer base URL for live cube broadcast after anchoring (e.g. https://ghost-layer.onrender.com) */
  ghostLayerUrl?: string;
}

export interface ScoreAnchor {
  txHash: string;
  network: string;
  anchoredAt: string;
  score: number;
  tier: string;
}

export interface AgentCreditReport {
  agentDid: string;
  creditScore: number;
  tier: AgentTier;
  totalPaidCalls: number;
  firstSeen: string;
  lastSeen: string;
  recentActivity: string[];
  callsToNextTier: number;
  priceRlusd: string;
  scale: "300-850 (ARGUS Credit Bureau)";
  benefits: Record<string, string>;
  /** Xahau on-chain anchor for this agent's latest score. null if not yet anchored. */
  onChainAnchor: ScoreAnchor | null;
}

// ─── CreditBureau ─────────────────────────────────────────────────────────────

export class CreditBureau {
  private readonly redis: Redis;
  private readonly xahauSeed: string | undefined;
  private readonly xahauWs: string;
  private readonly ghostLayerUrl: string | undefined;

  constructor(redis: Redis, anchorConfig?: XahauAnchorConfig) {
    this.redis = redis;
    this.xahauSeed = anchorConfig?.xahauSeed;
    this.xahauWs = anchorConfig?.xahauWs ?? XAHAU_DEFAULT_WS;
    this.ghostLayerUrl = anchorConfig?.ghostLayerUrl?.replace(/\/$/, "");
  }

  /** Register an agent DID if not already seen. Score initialises at 300. */
  async ensureRegistered(agentDid: string): Promise<void> {
    const scoreKey = this.key("score", agentDid);
    const exists = await this.redis.exists(scoreKey);
    if (!exists) {
      const now = new Date().toISOString();
      const pipeline = this.redis.pipeline();
      pipeline.set(scoreKey, SCORE_INITIAL);
      pipeline.set(this.key("calls", agentDid), 0);
      pipeline.set(this.key("firstSeen", agentDid), now);
      pipeline.set(this.key("lastSeen", agentDid), now);
      await pipeline.exec();
    }
  }

  /** Return the call timestamp ring buffer for an agent DID (up to 20 entries). */
  async getHistory(agentDid: string): Promise<string[]> {
    return this.redis.lrange(this.key("history", agentDid), 0, HISTORY_MAX - 1);
  }

  /**
   * Return the current score for an agent DID (default 300 if unseen).
   * Fails open to SCORE_INITIAL on Redis errors: this is called from the
   * payment-gate hot path before proof verification even begins, so an
   * uncaught rejection here would hang every paid request during a Redis
   * blip instead of just falling back to base pricing.
   */
  async getScore(agentDid: string): Promise<number> {
    try {
      const raw = await this.redis.get(this.key("score", agentDid));
      return raw !== null ? Number(raw) : SCORE_INITIAL;
    } catch (err) {
      console.error(`[credit-bureau] Redis getScore failed, failing open to ${SCORE_INITIAL}: ${String(err)}`);
      return SCORE_INITIAL;
    }
  }

  /**
   * Record a successful paid call: +5 pts (capped at 850), update lastSeen,
   * append to history ring buffer. Returns the new score.
   *
   * Kicks off an async Xahau anchor (fire-and-forget) if XAHAU_SEED is set.
   */
  async recordPaidCall(agentDid: string): Promise<number> {
    await this.ensureRegistered(agentDid);
    const scoreKey = this.key("score", agentDid);
    const current = await this.getScore(agentDid);
    const next = Math.min(current + SCORE_PER_PAID_CALL, SCORE_MAX);
    const tierName = this.getTier(next).name;
    const now = new Date().toISOString();

    const pipeline = this.redis.pipeline();
    pipeline.set(scoreKey, next);
    pipeline.incr(this.key("calls", agentDid));
    pipeline.set(this.key("lastSeen", agentDid), now);
    pipeline.lpush(this.key("history", agentDid), now);
    pipeline.ltrim(this.key("history", agentDid), 0, HISTORY_MAX - 1);
    await pipeline.exec();

    // Anchor on Xahau asynchronously — does not block the response
    if (this.xahauSeed) {
      this.anchorOnChain(agentDid, next, tierName).catch(() => {
        // Anchor failure is non-fatal; score is already persisted in Redis
      });
    }

    return next;
  }

  /** Resolve the tier object for a given score. */
  getTier(score: number): AgentTier {
    for (let i = TIERS.length - 1; i >= 0; i--) {
      if (score >= TIERS[i].minScore) return TIERS[i];
    }
    return TIERS[0];
  }

  /** How many more paid calls until the next tier threshold. */
  callsToNextTier(score: number): number {
    for (const tier of TIERS) {
      if (score < tier.minScore) {
        return Math.ceil((tier.minScore - score) / SCORE_PER_PAID_CALL);
      }
    }
    return 0; // already at max tier
  }

  /** Return a full credit report for an agent DID. */
  async getFullReport(agentDid: string): Promise<AgentCreditReport> {
    await this.ensureRegistered(agentDid);

    const [scoreRaw, callsRaw, firstSeen, lastSeen, history, anchorRaw] = await Promise.all([
      this.redis.get(this.key("score", agentDid)),
      this.redis.get(this.key("calls", agentDid)),
      this.redis.get(this.key("firstSeen", agentDid)),
      this.redis.get(this.key("lastSeen", agentDid)),
      this.redis.lrange(this.key("history", agentDid), 0, HISTORY_MAX - 1),
      this.redis.get(this.key("anchor", agentDid)),
    ]);

    const creditScore = scoreRaw !== null ? Number(scoreRaw) : SCORE_INITIAL;
    const tier = this.getTier(creditScore);
    const onChainAnchor: ScoreAnchor | null = anchorRaw ? (JSON.parse(anchorRaw) as ScoreAnchor) : null;

    return {
      agentDid,
      creditScore,
      tier,
      totalPaidCalls: callsRaw !== null ? Number(callsRaw) : 0,
      firstSeen: firstSeen ?? new Date().toISOString(),
      lastSeen: lastSeen ?? new Date().toISOString(),
      recentActivity: history,
      callsToNextTier: this.callsToNextTier(creditScore),
      priceRlusd: tier.priceRlusd,
      scale: "300-850 (ARGUS Credit Bureau)",
      benefits: Object.fromEntries(
        TIERS.map((t) => [`${t.minScore}–${t.maxScore} ${t.name}`, t.benefit])
      ),
      onChainAnchor,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private key(field: string, agentDid: string): string {
    return `bureau:${field}:${agentDid}`;
  }

  /**
   * Anchor an ARGUS score on the Xahau ledger.
   *
   * Submits a self-payment (1 drop XAH) with a Memo containing the score JSON.
   * The resulting txHash is stored in Redis under bureau:anchor:<agentDid>.
   * Anyone can verify the score history at https://xahau.network/tx/<txHash>.
   *
   * Only runs when xahauSeed is set. Throws on failure (caller should catch).
   */
  private async anchorOnChain(agentDid: string, score: number, tier: string): Promise<void> {
    const client = new Client(this.xahauWs);
    try {
      await client.connect();
      const wallet = Wallet.fromSeed(this.xahauSeed!);
      const now = new Date().toISOString();

      const memoType = Buffer.from("argus/score").toString("hex").toUpperCase();
      const memoData = Buffer.from(
        JSON.stringify({ agentDid, score, tier, anchoredAt: now })
      ).toString("hex").toUpperCase();

      const prepared = await client.autofill({
        TransactionType: "Payment",
        Account: wallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: "1",
        Memos: [{ Memo: { MemoType: memoType, MemoData: memoData } }],
      });

      const { tx_blob } = wallet.sign(prepared);
      const response = await client.submitAndWait(tx_blob);
      const txHash = String((response.result as unknown as Record<string, unknown>)["hash"] ?? "");

      if (txHash) {
        await this.redis.set(
          this.key("anchor", agentDid),
          JSON.stringify({ txHash, anchoredAt: now, network: "xahau-mainnet", score, tier }),
        );

        // Broadcast to Ghost Cube dashboard (fire-and-forget)
        if (this.ghostLayerUrl) {
          this.broadcastCubeEvent({
            event: "xahau_anchor",
            agentDid,
            score,
            tier,
            txHash,
            anchoredAt: now,
            network: "xahau-mainnet",
          }).catch(() => {
            // Non-fatal — cube update is best-effort
          });
        }
      }
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }

  /**
   * POST to Ghost Layer /internal/broadcast to push a live event to
   * all connected Ghost Cube WebSocket clients.
   */
  private async broadcastCubeEvent(payload: Record<string, unknown>): Promise<void> {
    const url = `${this.ghostLayerUrl!}/internal/broadcast`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}
