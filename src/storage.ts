import { promises as fs } from "node:fs";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { createLogger } from "./logger.js";

const log = createLogger("storage");

export const GITIGNORE_ENTRIES = [
  ".gitignore",
  "mistral-accounts.json",
  "mistral-accounts.json.*.tmp",
];

export type AccountStatus = "active" | "rate_limited" | "invalid" | "disabled";

export interface AccountRecord {
  keyHash: string;
  addedAt: number;
  lastUsed: number;
  status: AccountStatus;
  rateLimitResetTime?: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation" | "auth-failure";
  consecutiveFailures?: number;
  lastFailureTime?: number;
}

export interface AccountStorage {
  version: 1;
  accounts: AccountRecord[];
  activeIndex: number;
}

export function hashKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function getConfigDir(): string {
  if (process.env["OPENCODE_CONFIG_DIR"]) {
    return process.env["OPENCODE_CONFIG_DIR"];
  }
  const xdgConfig = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

export function getStoragePath(): string {
  return join(getConfigDir(), "mistral-accounts.json");
}

export { getConfigDir };

const LOCK_OPTIONS = {
  stale: 10_000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2,
  },
};

async function ensureSecurePermissions(path: string): Promise<void> {
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // Best effort
  }
}

function emptyStorage(): AccountStorage {
  return { version: 1, accounts: [], activeIndex: 0 };
}

async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(emptyStorage(), null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(path);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        log.warn("failed to release lock", { error: String(err) });
      }
    }
  }
}

function isValidRecord(value: unknown): value is AccountRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["keyHash"] === "string" && typeof v["status"] === "string";
}

function normalizeStorage(parsed: unknown): AccountStorage {
  if (!parsed || typeof parsed !== "object") return emptyStorage();
  const obj = parsed as Record<string, unknown>;
  const accountsRaw = Array.isArray(obj["accounts"]) ? obj["accounts"] : [];
  const accounts: AccountRecord[] = accountsRaw.filter(isValidRecord);
  let activeIndex =
    typeof obj["activeIndex"] === "number" && Number.isFinite(obj["activeIndex"])
      ? (obj["activeIndex"] as number)
      : 0;
  if (accounts.length > 0) {
    activeIndex = Math.max(0, Math.min(activeIndex, accounts.length - 1));
  } else {
    activeIndex = 0;
  }
  return { version: 1, accounts, activeIndex };
}

export async function loadAccounts(): Promise<AccountStorage> {
  const path = getStoragePath();
  try {
    await ensureSecurePermissions(path);
    const content = await fs.readFile(path, "utf-8");
    return normalizeStorage(JSON.parse(content));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyStorage();
    }
    log.error("failed to load account storage", { error: String(error) });
    return emptyStorage();
  }
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(storage, null, 2);
    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // ignore
      }
      throw error;
    }
  });
}

export async function clearAccounts(): Promise<void> {
  try {
    await fs.unlink(getStoragePath());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("failed to clear account storage", { error: String(error) });
    }
  }
}

export async function ensureGitignore(configDir: string): Promise<void> {
  const gitignorePath = join(configDir, ".gitignore");
  try {
    let content = "";
    let existing: string[] = [];
    try {
      content = await fs.readFile(gitignorePath, "utf-8");
      existing = content.split("\n").map((l) => l.trim());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const missing = GITIGNORE_ENTRIES.filter((e) => !existing.includes(e));
    if (missing.length === 0) return;
    if (content === "") {
      await fs.writeFile(gitignorePath, missing.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await fs.appendFile(gitignorePath, suffix + missing.join("\n") + "\n", "utf-8");
    }
  } catch {
    // non-critical
  }
}

export function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");
  try {
    let content = "";
    let existing: string[] = [];
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existing = content.split("\n").map((l) => l.trim());
    }
    const missing = GITIGNORE_ENTRIES.filter((e) => !existing.includes(e));
    if (missing.length === 0) return;
    if (content === "") {
      writeFileSync(gitignorePath, missing.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, suffix + missing.join("\n") + "\n", "utf-8");
    }
  } catch {
    // non-critical
  }
}
