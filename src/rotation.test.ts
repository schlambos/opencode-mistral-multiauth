import { describe, it, expect } from "vitest";
import {
  HealthScoreTracker,
  TokenBucketTracker,
  selectHybridAccount,
  selectRoundRobin,
  selectSticky,
  sortByLruWithHealth,
  addJitter,
  type AccountWithMetrics,
} from "./rotation.js";

function metrics(
  override: Partial<AccountWithMetrics> & { index: number },
): AccountWithMetrics {
  return {
    lastUsed: 0,
    healthScore: 70,
    isRateLimited: false,
    ...override,
  };
}

describe("HealthScoreTracker", () => {
  it("returns default initial score for unknown account", () => {
    const t = new HealthScoreTracker();
    expect(t.getScore(0)).toBe(70);
  });

  it("rewards success and penalizes rate limit", () => {
    const t = new HealthScoreTracker();
    t.recordSuccess(0);
    expect(t.getScore(0)).toBe(71);
    t.recordRateLimit(0);
    expect(t.getScore(0)).toBe(61);
  });

  it("clamps score at maxScore", () => {
    const t = new HealthScoreTracker({ initial: 99, success_reward: 5, max_score: 100 });
    t.recordSuccess(0);
    expect(t.getScore(0)).toBe(100);
  });

  it("isUsable respects minUsable threshold", () => {
    const t = new HealthScoreTracker({ min_usable: 50, initial: 100 });
    expect(t.isUsable(0)).toBe(true);
    for (let i = 0; i < 10; i++) t.recordRateLimit(0);
    expect(t.isUsable(0)).toBe(false);
  });
});

describe("TokenBucketTracker", () => {
  it("starts with initial tokens", () => {
    const t = new TokenBucketTracker({ initial_tokens: 10, max_tokens: 10, regeneration_rate_per_minute: 0 });
    expect(t.getTokens(0)).toBe(10);
  });

  it("consumes and reports tokens", () => {
    const t = new TokenBucketTracker({ initial_tokens: 5, max_tokens: 5, regeneration_rate_per_minute: 0 });
    expect(t.consume(0, 2)).toBe(true);
    expect(t.getTokens(0)).toBe(3);
    expect(t.consume(0, 10)).toBe(false);
  });

  it("hasTokens returns false when empty", () => {
    const t = new TokenBucketTracker({ initial_tokens: 1, max_tokens: 1, regeneration_rate_per_minute: 0 });
    t.consume(0, 1);
    expect(t.hasTokens(0)).toBe(false);
  });
});

describe("selectSticky", () => {
  it("returns current if usable", () => {
    const accs = [metrics({ index: 0 }), metrics({ index: 1 })];
    expect(selectSticky(accs, 1)).toBe(1);
  });

  it("falls back to LRU if current is rate-limited", () => {
    const accs = [
      metrics({ index: 0, lastUsed: 100 }),
      metrics({ index: 1, lastUsed: 200, isRateLimited: true }),
    ];
    expect(selectSticky(accs, 1)).toBe(0);
  });

  it("returns null when nothing is usable", () => {
    const accs = [metrics({ index: 0, isRateLimited: true })];
    expect(selectSticky(accs, 0)).toBeNull();
  });
});

describe("selectRoundRobin", () => {
  it("rotates to next index", () => {
    const accs = [metrics({ index: 0 }), metrics({ index: 1 }), metrics({ index: 2 })];
    expect(selectRoundRobin(accs, 0)).toBe(1);
    expect(selectRoundRobin(accs, 1)).toBe(2);
    expect(selectRoundRobin(accs, 2)).toBe(0);
  });

  it("skips rate-limited accounts", () => {
    const accs = [
      metrics({ index: 0 }),
      metrics({ index: 1, isRateLimited: true }),
      metrics({ index: 2 }),
    ];
    expect(selectRoundRobin(accs, 0)).toBe(2);
  });

  it("returns first when no current", () => {
    const accs = [metrics({ index: 0 }), metrics({ index: 1 })];
    expect(selectRoundRobin(accs, null)).toBe(0);
  });
});

describe("selectHybridAccount", () => {
  it("prefers current account due to stickiness", () => {
    const tokens = new TokenBucketTracker({ initial_tokens: 50, max_tokens: 50 });
    const accs = [
      metrics({ index: 0, healthScore: 70, lastUsed: Date.now() - 100 }),
      metrics({ index: 1, healthScore: 75, lastUsed: Date.now() - 200 }),
    ];
    expect(selectHybridAccount(accs, tokens, 0)).toBe(0);
  });

  it("switches to clearly better account", () => {
    const tokens = new TokenBucketTracker({ initial_tokens: 50, max_tokens: 50 });
    const accs = [
      metrics({ index: 0, healthScore: 51, lastUsed: Date.now() }),
      metrics({ index: 1, healthScore: 100, lastUsed: Date.now() - 3_600_000 }),
    ];
    expect(selectHybridAccount(accs, tokens, 0)).toBe(1);
  });

  it("returns null when none have tokens", () => {
    const tokens = new TokenBucketTracker({ initial_tokens: 0, max_tokens: 0, regeneration_rate_per_minute: 0 });
    const accs = [metrics({ index: 0 })];
    expect(selectHybridAccount(accs, tokens, null)).toBeNull();
  });
});

describe("sortByLruWithHealth", () => {
  it("returns oldest-used first", () => {
    const accs = [
      metrics({ index: 0, lastUsed: 300 }),
      metrics({ index: 1, lastUsed: 100 }),
      metrics({ index: 2, lastUsed: 200 }),
    ];
    expect(sortByLruWithHealth(accs).map((a) => a.index)).toEqual([1, 2, 0]);
  });
});

describe("addJitter", () => {
  it("stays within bounds", () => {
    for (let i = 0; i < 100; i++) {
      const j = addJitter(1000, 0.3);
      expect(j).toBeGreaterThanOrEqual(700);
      expect(j).toBeLessThanOrEqual(1300);
    }
  });

  it("returns 0 for 0 input", () => {
    expect(addJitter(0, 0.3)).toBe(0);
  });
});
