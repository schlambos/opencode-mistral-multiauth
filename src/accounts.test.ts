import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "./accounts.js";
import { configSchema, type MistralConfig } from "./config.js";

function makeConfig(overrides: Partial<MistralConfig> = {}): MistralConfig {
  return configSchema.parse({
    scheduling_mode: "round-robin",
    api_keys: ["key-aaaa", "key-bbbb", "key-cccc"],
    ...overrides,
  });
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mistral-test-"));
  process.env["OPENCODE_CONFIG_DIR"] = tempDir;
});

afterEach(() => {
  delete process.env["OPENCODE_CONFIG_DIR"];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AccountManager", () => {
  it("loads accounts from config api_keys", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig());
    expect(mgr.getAccountCount()).toBe(3);
  });

  it("deduplicates repeat keys", async () => {
    const mgr = await AccountManager.loadFromDisk(
      makeConfig({ api_keys: ["k1", "k1", "k2"] }),
    );
    expect(mgr.getAccountCount()).toBe(2);
  });

  it("returns an active account and tracks lastUsed", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig());
    const before = Date.now();
    const acc = mgr.getActiveAccount();
    expect(acc).not.toBeNull();
    expect(acc!.lastUsed).toBeGreaterThanOrEqual(before);
  });

  it("rotates round-robin", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig());
    const a = mgr.getActiveAccount();
    mgr.rotate();
    const b = mgr.getActiveAccount();
    mgr.rotate();
    const c = mgr.getActiveAccount();
    expect(new Set([a!.index, b!.index, c!.index]).size).toBe(3);
  });

  it("skips rate-limited accounts", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig());
    const first = mgr.getActiveAccount()!;
    mgr.markRateLimited(first.index, Date.now() + 60_000);
    const next = mgr.getActiveAccount();
    expect(next).not.toBeNull();
    expect(next!.index).not.toBe(first.index);
  });

  it("reports all unavailable when all rate-limited", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig());
    const future = Date.now() + 60_000;
    for (const a of mgr.getAccounts()) {
      mgr.markRateLimited(a.index, future);
    }
    expect(mgr.allUnavailable()).toBe(true);
    expect(mgr.getEarliestResetTime()).toBe(future);
  });

  it("re-activates an account after its reset time expires", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig());
    const first = mgr.getActiveAccount()!;
    mgr.markRateLimited(first.index, Date.now() - 1);
    const next = mgr.getActiveAccount();
    expect(next).not.toBeNull();
  });

  it("markInvalid prevents reselection", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig({ api_keys: ["k1", "k2"] }));
    const first = mgr.getActiveAccount()!;
    mgr.markInvalid(first.index);
    const next = mgr.getActiveAccount();
    expect(next).not.toBeNull();
    expect(next!.index).not.toBe(first.index);
  });

  it("persists state to disk and rehydrates", async () => {
    const cfg = makeConfig();
    const mgr1 = await AccountManager.loadFromDisk(cfg);
    const first = mgr1.getActiveAccount()!;
    mgr1.markRateLimited(first.index, Date.now() + 60_000);
    await mgr1.saveNow();

    const mgr2 = await AccountManager.loadFromDisk(cfg);
    const reloaded = mgr2.getAccounts()[first.index];
    expect(reloaded?.status).toBe("rate_limited");
  });

  it("sticky mode keeps the same account across calls", async () => {
    const mgr = await AccountManager.loadFromDisk(
      makeConfig({ scheduling_mode: "sticky" }),
    );
    const a = mgr.getActiveAccount()!;
    const b = mgr.getActiveAccount()!;
    const c = mgr.getActiveAccount()!;
    expect(a.index).toBe(b.index);
    expect(b.index).toBe(c.index);
  });

  it("hybrid mode picks something usable", async () => {
    const mgr = await AccountManager.loadFromDisk(
      makeConfig({ scheduling_mode: "hybrid" }),
    );
    expect(mgr.getActiveAccount()).not.toBeNull();
  });

  it("returns null when no keys configured", async () => {
    const mgr = await AccountManager.loadFromDisk(makeConfig({ api_keys: [] }));
    expect(mgr.getAccountCount()).toBe(0);
    expect(mgr.getActiveAccount()).toBeNull();
    expect(mgr.allUnavailable()).toBe(true);
  });
});
