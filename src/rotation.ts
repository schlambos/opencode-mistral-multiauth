import type { HealthScoreSettings, TokenBucketSettings } from "./config.js";

export const DEFAULT_HEALTH_SCORE: HealthScoreSettings = {
  initial: 70,
  success_reward: 1,
  rate_limit_penalty: -10,
  failure_penalty: -20,
  recovery_rate_per_hour: 2,
  min_usable: 50,
  max_score: 100,
};

interface HealthState {
  score: number;
  lastUpdated: number;
  lastSuccess: number;
  consecutiveFailures: number;
}

export class HealthScoreTracker {
  private readonly scores = new Map<number, HealthState>();
  private readonly config: HealthScoreSettings;

  constructor(config: Partial<HealthScoreSettings> = {}) {
    this.config = { ...DEFAULT_HEALTH_SCORE, ...config };
  }

  getScore(idx: number): number {
    const state = this.scores.get(idx);
    if (!state) return this.config.initial;
    const hours = (Date.now() - state.lastUpdated) / (1000 * 60 * 60);
    const recovered = Math.floor(hours * this.config.recovery_rate_per_hour);
    return Math.min(this.config.max_score, state.score + recovered);
  }

  recordSuccess(idx: number): void {
    const now = Date.now();
    const current = this.getScore(idx);
    this.scores.set(idx, {
      score: Math.min(this.config.max_score, current + this.config.success_reward),
      lastUpdated: now,
      lastSuccess: now,
      consecutiveFailures: 0,
    });
  }

  recordRateLimit(idx: number): void {
    const now = Date.now();
    const state = this.scores.get(idx);
    const current = this.getScore(idx);
    this.scores.set(idx, {
      score: Math.max(0, current + this.config.rate_limit_penalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    });
  }

  recordFailure(idx: number): void {
    const now = Date.now();
    const state = this.scores.get(idx);
    const current = this.getScore(idx);
    this.scores.set(idx, {
      score: Math.max(0, current + this.config.failure_penalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    });
  }

  isUsable(idx: number): boolean {
    return this.getScore(idx) >= this.config.min_usable;
  }

  getConsecutiveFailures(idx: number): number {
    return this.scores.get(idx)?.consecutiveFailures ?? 0;
  }

  reset(idx: number): void {
    this.scores.delete(idx);
  }

  snapshot(): Map<number, { score: number; consecutiveFailures: number }> {
    const out = new Map<number, { score: number; consecutiveFailures: number }>();
    for (const [idx] of this.scores) {
      out.set(idx, {
        score: this.getScore(idx),
        consecutiveFailures: this.getConsecutiveFailures(idx),
      });
    }
    return out;
  }
}

export const DEFAULT_TOKEN_BUCKET: TokenBucketSettings = {
  max_tokens: 50,
  regeneration_rate_per_minute: 6,
  initial_tokens: 50,
};

interface BucketState {
  tokens: number;
  lastUpdated: number;
}

export class TokenBucketTracker {
  private readonly buckets = new Map<number, BucketState>();
  private readonly config: TokenBucketSettings;

  constructor(config: Partial<TokenBucketSettings> = {}) {
    this.config = { ...DEFAULT_TOKEN_BUCKET, ...config };
  }

  getTokens(idx: number): number {
    const state = this.buckets.get(idx);
    if (!state) return this.config.initial_tokens;
    const minutes = (Date.now() - state.lastUpdated) / (1000 * 60);
    const recovered = minutes * this.config.regeneration_rate_per_minute;
    return Math.min(this.config.max_tokens, state.tokens + recovered);
  }

  hasTokens(idx: number, cost: number = 1): boolean {
    return this.getTokens(idx) >= cost;
  }

  consume(idx: number, cost: number = 1): boolean {
    const current = this.getTokens(idx);
    if (current < cost) return false;
    this.buckets.set(idx, { tokens: current - cost, lastUpdated: Date.now() });
    return true;
  }

  refund(idx: number, amount: number = 1): void {
    const current = this.getTokens(idx);
    this.buckets.set(idx, {
      tokens: Math.min(this.config.max_tokens, current + amount),
      lastUpdated: Date.now(),
    });
  }

  getMaxTokens(): number {
    return this.config.max_tokens;
  }
}

export interface AccountWithMetrics {
  index: number;
  lastUsed: number;
  healthScore: number;
  isRateLimited: boolean;
}

export function addJitter(baseMs: number, jitterFactor: number = 0.3): number {
  const range = baseMs * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * range;
  return Math.max(0, Math.round(baseMs + jitter));
}

export function sortByLruWithHealth(
  accounts: AccountWithMetrics[],
  minHealthScore: number = 50,
): AccountWithMetrics[] {
  return accounts
    .filter((a) => !a.isRateLimited && a.healthScore >= minHealthScore)
    .sort((a, b) => {
      const diff = a.lastUsed - b.lastUsed;
      if (diff !== 0) return diff;
      return b.healthScore - a.healthScore;
    });
}

const STICKINESS_BONUS = 150;
const SWITCH_THRESHOLD = 100;

export function selectHybridAccount(
  accounts: AccountWithMetrics[],
  tokens: TokenBucketTracker,
  currentIndex: number | null = null,
  minHealthScore: number = 50,
): number | null {
  const candidates = accounts
    .filter(
      (a) =>
        !a.isRateLimited &&
        a.healthScore >= minHealthScore &&
        tokens.hasTokens(a.index),
    )
    .map((a) => ({ ...a, tokens: tokens.getTokens(a.index) }));

  if (candidates.length === 0) return null;

  const maxTokens = tokens.getMaxTokens();
  const scored = candidates
    .map((a) => {
      const base = scoreHybrid(a, maxTokens);
      const sticky = a.index === currentIndex ? STICKINESS_BONUS : 0;
      return {
        index: a.index,
        baseScore: base,
        score: base + sticky,
        isCurrent: a.index === currentIndex,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  const current = scored.find((s) => s.isCurrent);
  if (current && !best.isCurrent) {
    const advantage = best.baseScore - current.baseScore;
    if (advantage < SWITCH_THRESHOLD) {
      return current.index;
    }
  }
  return best.index;
}

interface ScoredAccount extends AccountWithMetrics {
  tokens: number;
}

function scoreHybrid(account: ScoredAccount, maxTokens: number): number {
  const health = account.healthScore * 2;
  const tokenFraction = maxTokens > 0 ? account.tokens / maxTokens : 0;
  const tokenComp = tokenFraction * 100 * 5;
  const secondsSinceUsed = (Date.now() - account.lastUsed) / 1000;
  const freshness = Math.min(secondsSinceUsed, 3600) * 0.1;
  return Math.max(0, health + tokenComp + freshness);
}

export function selectRoundRobin(
  accounts: AccountWithMetrics[],
  currentIndex: number | null,
  minHealthScore: number = 50,
): number | null {
  const usable = accounts.filter(
    (a) => !a.isRateLimited && a.healthScore >= minHealthScore,
  );
  if (usable.length === 0) return null;
  if (currentIndex === null) return usable[0]?.index ?? null;

  const sorted = [...usable].sort((a, b) => a.index - b.index);
  const currentPos = sorted.findIndex((a) => a.index === currentIndex);
  if (currentPos === -1) return sorted[0]?.index ?? null;
  const next = sorted[(currentPos + 1) % sorted.length];
  return next?.index ?? null;
}

export function selectSticky(
  accounts: AccountWithMetrics[],
  currentIndex: number | null,
  minHealthScore: number = 50,
): number | null {
  if (currentIndex !== null) {
    const current = accounts.find((a) => a.index === currentIndex);
    if (current && !current.isRateLimited && current.healthScore >= minHealthScore) {
      return current.index;
    }
  }
  const sorted = sortByLruWithHealth(accounts, minHealthScore);
  return sorted[0]?.index ?? null;
}
