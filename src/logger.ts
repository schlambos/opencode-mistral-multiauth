import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type Level = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let currentLevel: Level = "info";

/** Hard cap on log file size before rotation (5 MiB). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function getLogPath(): string {
  if (process.env["MISTRAL_PLUGIN_LOG"]) {
    return process.env["MISTRAL_PLUGIN_LOG"];
  }
  if (process.env["OPENCODE_CONFIG_DIR"]) {
    return join(process.env["OPENCODE_CONFIG_DIR"], "mistral.log");
  }
  const xdg = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(xdg, "opencode", "mistral.log");
}

let initialized = false;
function ensureInit(path: string): void {
  if (initialized) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // ignore
  }
  initialized = true;
}

function rotateIfNeeded(path: string): void {
  try {
    const stat = statSync(path);
    if (stat.size > MAX_LOG_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // file may not exist yet
  }
}

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function emit(
  level: Exclude<Level, "silent">,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const path = getLogPath();
  ensureInit(path);
  const ts = new Date().toISOString();
  const metaStr =
    meta && Object.keys(meta).length > 0 ? " " + safeStringify(meta) : "";
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} [mistral:${scope}] ${message}${metaStr}\n`;
  try {
    rotateIfNeeded(path);
    appendFileSync(path, line, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Last-resort: swallow. We do NOT fall back to stdout because that
    // corrupts opencode's TUI buffer.
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit("debug", scope, m, meta),
    info: (m, meta) => emit("info", scope, m, meta),
    warn: (m, meta) => emit("warn", scope, m, meta),
    error: (m, meta) => emit("error", scope, m, meta),
  };
}

export function getLogPathForDisplay(): string {
  return getLogPath();
}
