import {
  loadAccounts,
  saveAccounts,
  hashKey,
  type AccountRecord,
  type AccountStatus,
  type AccountStorage,
} from "./storage.js";
import {
  HealthScoreTracker,
  TokenBucketTracker,
  selectHybridAccount,
  selectRoundRobin,
  selectSticky,
  type AccountWithMetrics,
} from "./rotation.js";
import { normalizeApiKey } from "./config.js";
import type { MistralConfig, SchedulingMode } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("accounts");

export interface ManagedAccount {
  index: number;
  keyHash: string;
  apiKey: string;
  alias?: string;
  addedAt: number;
  lastUsed: number;
  status: AccountStatus;
  rateLimitResetTime?: number;
  lastSwitchReason?: AccountRecord["lastSwitchReason"];
  consecutiveFailures: number;
  lastFailureTime?: number;
}

/** Display label for an account: alias if set, otherwise short keyHash. */
export function accountLabel(account: { alias?: string; keyHash: string }): string {
  return account.alias ?? account.keyHash.slice(0, 8);
}

interface ManagerState {
  accounts: ManagedAccount[];
  activeIndex: number;
}

const SAVE_DEBOUNCE_MS = 500;

export class AccountManager {
  private state: ManagerState = { accounts: [], activeIndex: 0 };
  private readonly health: HealthScoreTracker;
  private readonly tokens: TokenBucketTracker;
  private readonly mode: SchedulingMode;
  private readonly minHealth: number;
  private saveTimer: NodeJS.Timeout | null = null;
  private savingPromise: Promise<void> | null = null;

  constructor(private readonly config: MistralConfig) {
    this.health = new HealthScoreTracker(config.health_score);
    this.tokens = new TokenBucketTracker(config.token_bucket);
    this.mode = config.scheduling_mode;
    this.minHealth = config.health_score.min_usable;
  }

  static async loadFromDisk(config: MistralConfig): Promise<AccountManager> {
    const mgr = new AccountManager(config);
    await mgr.hydrate();
    return mgr;
  }

  private async hydrate(): Promise<void> {
    const stored = await loadAccounts();
    const now = Date.now();

    const recordByHash = new Map<string, AccountRecord>();
    for (const rec of stored.accounts) {
      recordByHash.set(rec.keyHash, rec);
    }

    const seen = new Set<string>();
    const accounts: ManagedAccount[] = [];
    let idx = 0;
    for (const entry of this.config.api_keys) {
      const { key: apiKey, alias } = normalizeApiKey(entry);
      const keyHash = hashKey(apiKey);
      if (seen.has(keyHash)) continue;
      seen.add(keyHash);
      const rec = recordByHash.get(keyHash);
      const resetTime =
        rec?.rateLimitResetTime && rec.rateLimitResetTime > now
          ? rec.rateLimitResetTime
          : undefined;
      let status: AccountStatus = "active";
      if (rec?.status === "invalid") {
        status = "invalid";
      } else if (rec?.status === "disabled") {
        status = "disabled";
      } else if (rec?.status === "rate_limited" && resetTime !== undefined) {
        status = "rate_limited";
      }
      const account: ManagedAccount = {
        index: idx,
        keyHash,
        apiKey,
        ...(alias ? { alias } : {}),
        addedAt: rec?.addedAt ?? now,
        lastUsed: rec?.lastUsed ?? 0,
        status,
        rateLimitResetTime: resetTime,
        lastSwitchReason: rec?.lastSwitchReason,
        consecutiveFailures: rec?.consecutiveFailures ?? 0,
        lastFailureTime: rec?.lastFailureTime,
      };
      accounts.push(account);
      idx++;
    }

    let activeIndex = stored.activeIndex;
    if (accounts.length === 0) {
      activeIndex = 0;
    } else {
      activeIndex = Math.max(0, Math.min(activeIndex, accounts.length - 1));
    }

    this.state = { accounts, activeIndex };
    log.info("hydrated", {
      total: accounts.length,
      active: activeIndex,
      mode: this.mode,
    });
  }

  getAccountCount(): number {
    return this.state.accounts.length;
  }

  getAccounts(): readonly ManagedAccount[] {
    return this.state.accounts;
  }

  getActiveAccount(): ManagedAccount | null {
    const idx = this.pickIndex();
    if (idx === null) return null;
    if (idx !== this.state.activeIndex) {
      this.state.activeIndex = idx;
      this.requestSaveToDisk();
    }
    const account = this.state.accounts[idx];
    if (!account) return null;
    account.lastUsed = Date.now();
    this.tokens.consume(idx);
    return account;
  }

  /**
   * Fast-path: return the account at `idx` if it is currently usable
   * (active, healthy, not rate-limited). No selection logic, no disk save,
   * no metric build. Used by the interceptor to bypass per-call evaluation
   * when the pinned key is still good.
   */
  peekUsable(idx: number): ManagedAccount | null {
    const account = this.state.accounts[idx];
    if (!account) return null;
    if (account.status === "invalid" || account.status === "disabled") return null;
    if (account.status === "rate_limited") {
      const reset = account.rateLimitResetTime;
      if (reset !== undefined && reset > Date.now()) return null;
      // Reset window expired — flip to active inline.
      account.status = "active";
      account.rateLimitResetTime = undefined;
    }
    if (this.health.getScore(idx) < this.minHealth) return null;
    account.lastUsed = Date.now();
    return account;
  }

  /**
   * Lightweight success acknowledgement: skip disk write and health-score
   * updates unless the account was previously in a degraded state. Healthy
   * keys do not need bookkeeping on every successful call.
   */
  noteSuccess(idx: number): void {
    const account = this.state.accounts[idx];
    if (!account) return;
    if (
      account.status === "rate_limited" ||
      account.consecutiveFailures > 0
    ) {
      this.markSuccess(idx);
    }
  }

  private buildMetrics(): AccountWithMetrics[] {
    const now = Date.now();
    return this.state.accounts.map((a) => {
      const rateLimited =
        a.status === "rate_limited" &&
        a.rateLimitResetTime !== undefined &&
        a.rateLimitResetTime > now;
      const isUsable = a.status !== "invalid" && a.status !== "disabled";
      return {
        index: a.index,
        lastUsed: a.lastUsed,
        healthScore: isUsable ? this.health.getScore(a.index) : 0,
        isRateLimited: !isUsable || rateLimited,
      };
    });
  }

  private pickIndex(): number | null {
    if (this.state.accounts.length === 0) return null;
    this.refreshExpiredRateLimits();
    const metrics = this.buildMetrics();
    const current = this.state.activeIndex;

    if (this.mode === "sticky") {
      return selectSticky(metrics, current, this.minHealth);
    }
    if (this.mode === "round-robin") {
      return selectRoundRobin(metrics, current, this.minHealth);
    }
    return selectHybridAccount(metrics, this.tokens, current, this.minHealth);
  }

  private refreshExpiredRateLimits(): void {
    const now = Date.now();
    let changed = false;
    for (const a of this.state.accounts) {
      if (a.status === "rate_limited" && (!a.rateLimitResetTime || a.rateLimitResetTime <= now)) {
        a.status = "active";
        a.rateLimitResetTime = undefined;
        changed = true;
      }
    }
    if (changed) this.requestSaveToDisk();
  }

  /**
   * Returns the soonest rate-limit reset time across all accounts, or null
   * if no account is currently waiting on a reset.
   */
  getEarliestResetTime(): number | null {
    const now = Date.now();
    let earliest: number | null = null;
    for (const a of this.state.accounts) {
      if (
        a.status === "rate_limited" &&
        a.rateLimitResetTime !== undefined &&
        a.rateLimitResetTime > now
      ) {
        if (earliest === null || a.rateLimitResetTime < earliest) {
          earliest = a.rateLimitResetTime;
        }
      }
    }
    return earliest;
  }

  /**
   * True if every account is either invalid/disabled or currently
   * within its rate-limit window.
   */
  allUnavailable(): boolean {
    if (this.state.accounts.length === 0) return true;
    const now = Date.now();
    return this.state.accounts.every(
      (a) =>
        a.status === "invalid" ||
        a.status === "disabled" ||
        (a.status === "rate_limited" &&
          a.rateLimitResetTime !== undefined &&
          a.rateLimitResetTime > now),
    );
  }

  hasUsableAccounts(): boolean {
    return !this.allUnavailable();
  }

  markSuccess(index: number): void {
    const account = this.state.accounts[index];
    if (!account) return;
    account.consecutiveFailures = 0;
    account.lastFailureTime = undefined;
    if (account.status === "rate_limited") {
      account.status = "active";
      account.rateLimitResetTime = undefined;
    }
    this.health.recordSuccess(index);
    this.requestSaveToDisk();
  }

  markRateLimited(index: number, resetAtMs: number, reason: string = "rate-limit"): void {
    const account = this.state.accounts[index];
    if (!account) return;
    account.status = "rate_limited";
    account.rateLimitResetTime = resetAtMs;
    account.lastSwitchReason = "rate-limit";
    account.consecutiveFailures = (account.consecutiveFailures ?? 0) + 1;
    account.lastFailureTime = Date.now();
    this.health.recordRateLimit(index);
    log.warn("account rate-limited", {
      keyHash: account.keyHash,
      resetInMs: resetAtMs - Date.now(),
      reason,
    });
    this.requestSaveToDisk();
  }

  markInvalid(index: number, reason: string = "auth-failure"): void {
    const account = this.state.accounts[index];
    if (!account) return;
    account.status = "invalid";
    account.lastSwitchReason = "auth-failure";
    account.consecutiveFailures = (account.consecutiveFailures ?? 0) + 1;
    account.lastFailureTime = Date.now();
    this.health.recordFailure(index);
    log.error("account marked invalid", { keyHash: account.keyHash, reason });
    this.requestSaveToDisk();
  }

  markFailure(index: number): void {
    const account = this.state.accounts[index];
    if (!account) return;
    account.consecutiveFailures = (account.consecutiveFailures ?? 0) + 1;
    account.lastFailureTime = Date.now();
    this.health.recordFailure(index);
    this.requestSaveToDisk();
  }

  rotate(reason: AccountRecord["lastSwitchReason"] = "rotation"): ManagedAccount | null {
    const next = this.pickIndex();
    if (next === null) return null;
    if (next !== this.state.activeIndex) {
      const account = this.state.accounts[next];
      if (account) account.lastSwitchReason = reason;
      this.state.activeIndex = next;
    }
    this.requestSaveToDisk();
    const account = this.state.accounts[next];
    return account ?? null;
  }

  toSnapshot(): AccountStorage {
    return {
      version: 1,
      accounts: this.state.accounts.map((a) => ({
        keyHash: a.keyHash,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        status: a.status,
        rateLimitResetTime: a.rateLimitResetTime,
        lastSwitchReason: a.lastSwitchReason,
        consecutiveFailures: a.consecutiveFailures,
        lastFailureTime: a.lastFailureTime,
      })),
      activeIndex: this.state.activeIndex,
    };
  }

  requestSaveToDisk(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
  }

  async saveNow(): Promise<void> {
    if (this.savingPromise) {
      await this.savingPromise;
      return;
    }
    const snapshot = this.toSnapshot();
    this.savingPromise = saveAccounts(snapshot)
      .catch((err) => {
        log.error("failed to save accounts", { error: String(err) });
      })
      .finally(() => {
        this.savingPromise = null;
      });
    await this.savingPromise;
  }

  async shutdown(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveNow();
  }
}
