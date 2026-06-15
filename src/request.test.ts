import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "./accounts.js";
import { configSchema } from "./config.js";
import { createInterceptingFetch, isMistralRequest, type SwitchEvent } from "./request.js";

let tempDir: string;
let realFetch: typeof fetch;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mistral-req-"));
  process.env["OPENCODE_CONFIG_DIR"] = tempDir;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  delete process.env["OPENCODE_CONFIG_DIR"];
  rmSync(tempDir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});

describe("isMistralRequest", () => {
  it("matches api.mistral.ai", () => {
    expect(isMistralRequest("https://api.mistral.ai/v1/chat/completions")).toBe(true);
  });
  it("matches codestral.mistral.ai", () => {
    expect(isMistralRequest("https://codestral.mistral.ai/v1/chat/completions")).toBe(true);
  });
  it("rejects other hosts", () => {
    expect(isMistralRequest("https://api.openai.com/v1/chat/completions")).toBe(false);
  });
});

describe("createInterceptingFetch", () => {
  it("passes non-Mistral requests through unchanged", async () => {
    const mgr = await AccountManager.loadFromDisk(
      configSchema.parse({ api_keys: ["k1"] }),
    );
    const wrapped = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = wrapped as unknown as typeof fetch;

    const f = createInterceptingFetch({
      manager: mgr,
      retry: configSchema.parse({ api_keys: ["k1"] }).retry,
    });
    const res = await f("https://api.openai.com/v1/foo");
    expect(res.status).toBe(200);
    expect(wrapped).toHaveBeenCalledTimes(1);
    const call = wrapped.mock.calls[0]!;
    expect(call[0]).toBe("https://api.openai.com/v1/foo");
  });

  it("injects Bearer token for Mistral requests", async () => {
    const cfg = configSchema.parse({ api_keys: ["secret-key"] });
    const mgr = await AccountManager.loadFromDisk(cfg);
    let captured: Headers | null = null;
    globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
      captured = new Headers(init?.headers ?? undefined);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const f = createInterceptingFetch({ manager: mgr, retry: cfg.retry });
    const res = await f("https://api.mistral.ai/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.get("Authorization")).toBe("Bearer secret-key");
  });

  it("rotates on 429 and succeeds on a different key", async () => {
    const cfg = configSchema.parse({
      api_keys: ["k1", "k2"],
      scheduling_mode: "round-robin",
      retry: {
        max_attempts_per_request: 4,
        same_key_initial_delay_ms: 0,
        same_key_max_delay_ms: 0,
        same_key_backoff_factor: 1,
        cross_key_delay_ms: 0,
        jitter_factor: 0,
      },
    });
    const mgr = await AccountManager.loadFromDisk(cfg);

    const seenAuth: string[] = [];
    let callCount = 0;
    globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
      const headers = new Headers(init?.headers ?? undefined);
      seenAuth.push(headers.get("Authorization") ?? "");
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const f = createInterceptingFetch({ manager: mgr, retry: cfg.retry });
    const res = await f("https://api.mistral.ai/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(seenAuth[0]).not.toBe(seenAuth[1]);
  });

  it("rotates on 401 (invalid key) without retrying same key", async () => {
    const cfg = configSchema.parse({
      api_keys: ["bad", "good"],
      scheduling_mode: "round-robin",
      retry: {
        max_attempts_per_request: 4,
        same_key_initial_delay_ms: 0,
        same_key_max_delay_ms: 0,
        same_key_backoff_factor: 1,
        cross_key_delay_ms: 0,
        jitter_factor: 0,
      },
    });
    const mgr = await AccountManager.loadFromDisk(cfg);

    let callCount = 0;
    globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
      const headers = new Headers(init?.headers ?? undefined);
      callCount++;
      if (headers.get("Authorization") === "Bearer bad") {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const f = createInterceptingFetch({ manager: mgr, retry: cfg.retry });
    const res = await f("https://api.mistral.ai/v1/chat/completions");
    expect(res.status).toBe(200);
    expect(callCount).toBeLessThanOrEqual(3);
  });

  it("throws when no keys are configured", async () => {
    const cfg = configSchema.parse({ api_keys: [] });
    const mgr = await AccountManager.loadFromDisk(cfg);
    const f = createInterceptingFetch({ manager: mgr, retry: cfg.retry });
    await expect(f("https://api.mistral.ai/v1/chat/completions")).rejects.toThrow(/No Mistral API keys/);
  });

  it("fires onSwitch with from/to keyHashes when rotating after 429", async () => {
    const cfg = configSchema.parse({
      api_keys: ["k1", "k2"],
      scheduling_mode: "round-robin",
      retry: {
        max_attempts_per_request: 4,
        same_key_initial_delay_ms: 0,
        same_key_max_delay_ms: 0,
        same_key_backoff_factor: 1,
        cross_key_delay_ms: 0,
        jitter_factor: 0,
      },
    });
    const mgr = await AccountManager.loadFromDisk(cfg);
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "60" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const events: Array<{ from: string; to: string; reason: string; status?: number }> = [];
    const f = createInterceptingFetch({
      manager: mgr,
      retry: cfg.retry,
      onSwitch: (e) =>
        events.push({
          from: e.fromKeyHash,
          to: e.toKeyHash,
          reason: e.reason,
          status: e.status,
        }),
    });
    const res = await f("https://api.mistral.ai/v1/chat/completions");
    expect(res.status).toBe(200);
    const rotation = events.find((e) => e.reason === "429");
    expect(rotation).toBeDefined();
    expect(rotation?.status).toBe(429);
    expect(rotation?.from).not.toBe(rotation?.to);
  });

  it("fires onSwitch with 401 reason after invalid key", async () => {
    const cfg = configSchema.parse({
      api_keys: ["bad", "good"],
      scheduling_mode: "sticky",
      retry: {
        max_attempts_per_request: 4,
        same_key_initial_delay_ms: 0,
        same_key_max_delay_ms: 0,
        same_key_backoff_factor: 1,
        cross_key_delay_ms: 0,
        jitter_factor: 0,
      },
    });
    const mgr = await AccountManager.loadFromDisk(cfg);
    globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
      const headers = new Headers(init?.headers ?? undefined);
      if (headers.get("Authorization") === "Bearer bad") {
        return new Response("", { status: 401 });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const events: Array<{ reason: string; status?: number }> = [];
    const f = createInterceptingFetch({
      manager: mgr,
      retry: cfg.retry,
      onSwitch: (e) => events.push({ reason: e.reason, status: e.status }),
    });
    const res = await f("https://api.mistral.ai/v1/chat/completions");
    expect(res.status).toBe(200);
    expect(events.some((e) => e.reason === "401")).toBe(true);
  });

  it("fires an 'initial' event on first key selection", async () => {
    const cfg = configSchema.parse({
      api_keys: ["k1"],
      retry: configSchema.parse({ api_keys: ["k1"] }).retry,
    });
    const mgr = await AccountManager.loadFromDisk(cfg);
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const events: SwitchEvent[] = [];
    const f = createInterceptingFetch({
      manager: mgr,
      retry: cfg.retry,
      onSwitch: (e) => events.push(e),
    });
    await f("https://api.mistral.ai/v1/chat/completions");
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("initial");
    expect(events[0]?.fromKeyHash).toBe("");
    expect(events[0]?.toKeyHash).not.toBe("");
  });

  it("fires initial THEN switch when first key 429s", async () => {
    const cfg = configSchema.parse({
      api_keys: ["k1", "k2"],
      scheduling_mode: "round-robin",
      retry: {
        max_attempts_per_request: 4,
        same_key_initial_delay_ms: 0,
        same_key_max_delay_ms: 0,
        same_key_backoff_factor: 1,
        cross_key_delay_ms: 0,
        jitter_factor: 0,
      },
    });
    const mgr = await AccountManager.loadFromDisk(cfg);
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      if (n === 1) return new Response("", { status: 429, headers: { "Retry-After": "1" } });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const events: SwitchEvent[] = [];
    const f = createInterceptingFetch({
      manager: mgr,
      retry: cfg.retry,
      onSwitch: (e) => events.push(e),
    });
    await f("https://api.mistral.ai/v1/chat/completions");
    expect(events.map((e) => e.reason)).toEqual(["initial", "429"]);
  });

  it("returns 4xx non-auth/rate-limit response unmodified", async () => {
    const cfg = configSchema.parse({ api_keys: ["k1"] });
    const mgr = await AccountManager.loadFromDisk(cfg);
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;
    const f = createInterceptingFetch({ manager: mgr, retry: cfg.retry });
    const res = await f("https://api.mistral.ai/v1/chat/completions");
    expect(res.status).toBe(400);
    expect(callCount).toBe(1);
  });
});
