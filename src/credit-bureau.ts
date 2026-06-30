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
 */

import type { Redis } from "ioredis";

// ─── Constants ────────────────────────────────────────────────────────────────

const SCORE_INITIAL = 300;
const SCORE_MAX = 850;
const SCORE_PER_PAID_CALL = 5;
const HISTORY_MAX = 20;

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

// ─── Report type ──────────────────────────────────────────────────────────────

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
}

// ─── CreditBureau ─────────────────────────────────────────────────────────────

export class CreditBureau {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
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

  /** Return the current score for an agent DID (default 300 if unseen). */
  async getScore(agentDid: string): Promise<number> {
    const raw = await this.redis.get(this.key("score", agentDid));
    return raw !== null ? Number(raw) : SCORE_INITIAL;
  }

  /**
   * Record a successful paid call: +5 pts (capped at 850), update lastSeen,
   * append to history ring buffer. Returns the new score.
   */
  async recordPaidCall(agentDid: string): Promise<number> {
    await this.ensureRegistered(agentDid);
    const scoreKey = this.key("score", agentDid);
    const current = await this.getScore(agentDid);
    const next = Math.min(current + SCORE_PER_PAID_CALL, SCORE_MAX);
    const now = new Date().toISOString();

    const pipeline = this.redis.pipeline();
    pipeline.set(scoreKey, next);
    pipeline.incr(this.key("calls", agentDid));
    pipeline.set(this.key("lastSeen", agentDid), now);
    pipeline.lpush(this.key("history", agentDid), now);
    pipeline.ltrim(this.key("history", agentDid), 0, HISTORY_MAX - 1);
    await pipeline.exec();

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

    const [scoreRaw, callsRaw, firstSeen, lastSeen, history] = await Promise.all([
      this.redis.get(this.key("score", agentDid)),
      this.redis.get(this.key("calls", agentDid)),
      this.redis.get(this.key("firstSeen", agentDid)),
      this.redis.get(this.key("lastSeen", agentDid)),
      this.redis.lrange(this.key("history", agentDid), 0, HISTORY_MAX - 1),
    ]);

    const creditScore = scoreRaw !== null ? Number(scoreRaw) : SCORE_INITIAL;
    const tier = this.getTier(creditScore);

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
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private key(field: string, agentDid: string): string {
    return `bureau:${field}:${agentDid}`;
  }
}
