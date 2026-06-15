import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccounts, saveAccounts, hashKey, type AccountStorage } from "./storage.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mistral-store-"));
  process.env["OPENCODE_CONFIG_DIR"] = tempDir;
});

afterEach(() => {
  delete process.env["OPENCODE_CONFIG_DIR"];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("storage", () => {
  it("returns empty storage when no file exists", async () => {
    const s = await loadAccounts();
    expect(s.accounts).toEqual([]);
    expect(s.activeIndex).toBe(0);
  });

  it("roundtrips through save and load", async () => {
    const storage: AccountStorage = {
      version: 1,
      accounts: [
        {
          keyHash: hashKey("k1"),
          addedAt: 100,
          lastUsed: 200,
          status: "active",
          consecutiveFailures: 0,
        },
      ],
      activeIndex: 0,
    };
    await saveAccounts(storage);
    const loaded = await loadAccounts();
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0]?.keyHash).toBe(storage.accounts[0]?.keyHash);
  });

  it("clamps activeIndex to valid range", async () => {
    const storage: AccountStorage = {
      version: 1,
      accounts: [
        { keyHash: "a", addedAt: 0, lastUsed: 0, status: "active" },
      ],
      activeIndex: 99,
    };
    await saveAccounts(storage);
    const loaded = await loadAccounts();
    expect(loaded.activeIndex).toBe(0);
  });

  it("hashKey returns 16-char hex", () => {
    const h = hashKey("some-secret-api-key");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashKey is deterministic", () => {
    expect(hashKey("k")).toBe(hashKey("k"));
  });
});
