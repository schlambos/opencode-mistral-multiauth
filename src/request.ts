import { AccountManager } from "./accounts.js";
import { addJitter } from "./rotation.js";
import type { RetrySettings } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("request");

const MISTRAL_HOSTS = new Set([
  "api.mistral.ai",
  "codestral.mistral.ai",
]);

export function isMistralRequest(input: RequestInfo | URL): boolean {
  let urlStr: string;
  if (typeof input === "string") urlStr = input;
  else if (input instanceof URL) urlStr = input.toString();
  else if (input instanceof Request) urlStr = input.url;
  else return false;

  try {
    const url = new URL(urlStr);
    return MISTRAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function injectAuthHeader(init: RequestInit | undefined, apiKey: string): RequestInit {
  const headers = new Headers(init?.headers ?? undefined);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return { ...(init ?? {}), headers };
}

function rebuildRequest(input: RequestInfo | URL, apiKey: string): RequestInfo | URL {
  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    return new Request(input, { headers });
  }
  return input;
}

function parseRetryAfter(response: Response): number | null {
  const ms = response.headers.get("retry-after-ms");
  if (ms) {
    const parsed = Number.parseInt(ms, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const sec = response.headers.get("retry-after");
  if (sec) {
    const parsed = Number.parseInt(sec, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type SwitchReason = "initial" | "429" | "401" | "403" | "5xx" | "network-error";

export interface SwitchEvent {
  /** Empty string when reason === "initial" (no prior key in this request). */
  fromKeyHash: string;
  toKeyHash: string;
  fromAlias?: string;
  toAlias?: string;
  reason: SwitchReason;
  status?: number;
}

export interface InterceptorDeps {
  manager: AccountManager;
  retry: RetrySettings;
  onSwitch?: (event: SwitchEvent) => void;
}

export function createInterceptingFetch(deps: InterceptorDeps) {
  const { manager, retry, onSwitch } = deps;

  // Pinned active key: chosen once at first call, reused on every subsequent
  // fetch until it fails. Avoids per-call selection overhead.
  let pinnedIndex: number | null = null;
  let pinnedAnnounced = false;

  return async function interceptingFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (!isMistralRequest(input)) {
      return fetch(input, init);
    }

    if (manager.getAccountCount() === 0) {
      throw new Error(
        "No Mistral API keys configured. Set MISTRAL_API_KEY or add keys to mistral.json.",
      );
    }

    const abortSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    let attempt = 0;
    let sameKeyAttempt = 0;
    let lastIndex: number | null = null;
    let lastKeyHash: string | null = null;
    let lastAlias: string | undefined;
    let pendingSwitchReason: SwitchReason | null = null;
    let pendingSwitchStatus: number | undefined;
    let lastResponse: Response | null = null;
    let lastError: Error | null = null;

    while (attempt < retry.max_attempts_per_request) {
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error("Aborted");
      }

      let account =
        pinnedIndex !== null ? manager.peekUsable(pinnedIndex) : null;
      if (!account) {
        account = manager.getActiveAccount();
        if (account) {
          pinnedIndex = account.index;
        }
      }
      if (!account) {
        const earliest = manager.getEarliestResetTime();
        if (earliest !== null) {
          const waitMs = Math.max(1000, earliest - Date.now()) + addJitter(250, retry.jitter_factor);
          log.warn("all keys rate-limited, waiting for soonest reset", { waitMs });
          await sleep(Math.min(waitMs, 60_000), abortSignal);
          continue;
        }
        throw new Error("All Mistral API keys are invalid or disabled");
      }

      const sameKey = lastIndex === account.index;
      if (!sameKey) {
        if (onSwitch) {
          try {
            if (!pinnedAnnounced) {
              onSwitch({
                fromKeyHash: "",
                toKeyHash: account.keyHash,
                toAlias: account.alias,
                reason: "initial",
              });
              pinnedAnnounced = true;
            } else if (pendingSwitchReason !== null) {
              onSwitch({
                fromKeyHash: lastKeyHash ?? "",
                toKeyHash: account.keyHash,
                fromAlias: lastAlias,
                toAlias: account.alias,
                reason: pendingSwitchReason,
                status: pendingSwitchStatus,
              });
            }
          } catch (err) {
            log.warn("onSwitch handler threw", { error: String(err) });
          }
        }
        pendingSwitchReason = null;
        pendingSwitchStatus = undefined;
        sameKeyAttempt = 0;
        if (lastIndex !== null && retry.cross_key_delay_ms > 0) {
          await sleep(addJitter(retry.cross_key_delay_ms, retry.jitter_factor), abortSignal);
        }
      } else {
        sameKeyAttempt++;
        const base = Math.min(
          retry.same_key_initial_delay_ms *
            Math.pow(retry.same_key_backoff_factor, sameKeyAttempt - 1),
          retry.same_key_max_delay_ms,
        );
        await sleep(addJitter(base, retry.jitter_factor), abortSignal);
      }
      lastIndex = account.index;
      lastKeyHash = account.keyHash;
      lastAlias = account.alias;

      const requestInput =
        input instanceof Request ? rebuildRequest(input, account.apiKey) : input;
      const requestInit =
        input instanceof Request ? undefined : injectAuthHeader(init, account.apiKey);

      let response: Response;
      const fetchStart = Date.now();
      try {
        response = await fetch(requestInput, requestInit);
        log.debug("fetch returned", {
          keyHash: account.keyHash,
          status: response.status,
          waitMs: Date.now() - fetchStart,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn("fetch failed", {
          keyHash: account.keyHash,
          error: lastError.message,
        });
        manager.markFailure(account.index);
        pinnedIndex = null;
        pendingSwitchReason = "network-error";
        pendingSwitchStatus = undefined;
        attempt++;
        continue;
      }

      if (response.ok) {
        manager.noteSuccess(account.index);
        return response;
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response);
        const resetAt = Date.now() + (retryAfterMs ?? 30_000);
        manager.markRateLimited(account.index, resetAt, "429");
        pinnedIndex = null;
        lastResponse = response;
        pendingSwitchReason = "429";
        pendingSwitchStatus = 429;
        attempt++;
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        manager.markInvalid(account.index, `http-${response.status}`);
        pinnedIndex = null;
        lastResponse = response;
        pendingSwitchReason = response.status === 401 ? "401" : "403";
        pendingSwitchStatus = response.status;
        attempt++;
        continue;
      }

      if (response.status >= 500 && response.status < 600) {
        manager.markFailure(account.index);
        pinnedIndex = null;
        lastResponse = response;
        pendingSwitchReason = "5xx";
        pendingSwitchStatus = response.status;
        attempt++;
        continue;
      }

      // 4xx other than 401/403/429 — non-retryable client error.
      return response;
    }

    if (lastResponse) {
      log.error("exhausted retries, returning last response", {
        status: lastResponse.status,
        attempts: attempt,
      });
      return lastResponse;
    }
    throw lastError ?? new Error("Exhausted retries with no response");
  };
}
