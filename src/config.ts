import { z } from "zod";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const healthScoreSchema = z
  .object({
    initial: z.number().int().min(0).max(100).default(70),
    success_reward: z.number().default(1),
    rate_limit_penalty: z.number().default(-10),
    failure_penalty: z.number().default(-20),
    recovery_rate_per_hour: z.number().default(2),
    min_usable: z.number().int().min(0).max(100).default(50),
    max_score: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const tokenBucketSchema = z
  .object({
    max_tokens: z.number().int().min(1).default(50),
    regeneration_rate_per_minute: z.number().min(0).default(6),
    initial_tokens: z.number().int().min(0).default(50),
  })
  .strict();

export const apiKeyEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      key: z.string().min(1),
      alias: z.string().min(1).optional(),
    })
    .strict(),
]);

export type ApiKeyEntry = z.infer<typeof apiKeyEntrySchema>;

export interface NormalizedApiKey {
  key: string;
  alias?: string;
}

export function normalizeApiKey(entry: ApiKeyEntry): NormalizedApiKey {
  if (typeof entry === "string") return { key: entry };
  return entry.alias ? { key: entry.key, alias: entry.alias } : { key: entry.key };
}

export const retrySchema = z
  .object({
    max_attempts_per_request: z.number().int().min(1).default(10),
    same_key_initial_delay_ms: z.number().int().min(0).default(1000),
    same_key_max_delay_ms: z.number().int().min(0).default(8000),
    same_key_backoff_factor: z.number().min(1).default(2),
    cross_key_delay_ms: z.number().int().min(0).default(50),
    jitter_factor: z.number().min(0).max(1).default(0.3),
  })
  .strict();

export const schedulingModeSchema = z.enum(["sticky", "round-robin", "hybrid"]);
export type SchedulingMode = z.infer<typeof schedulingModeSchema>;

export const configSchema = z
  .object({
    scheduling_mode: schedulingModeSchema.default("hybrid"),
    api_keys: z.array(apiKeyEntrySchema).default([]),
    api_keys_env: z.string().optional(),
    provider_id: z.string().default("mistral"),
    health_score: healthScoreSchema.default({}),
    token_bucket: tokenBucketSchema.default({}),
    retry: retrySchema.default({}),
    log_level: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  })
  .strict();

export type MistralConfig = z.infer<typeof configSchema>;
export type HealthScoreSettings = z.infer<typeof healthScoreSchema>;
export type TokenBucketSettings = z.infer<typeof tokenBucketSchema>;
export type RetrySettings = z.infer<typeof retrySchema>;

const CONFIG_FILENAMES = ["mistral.json", ".mistral.json"];

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const content = await fs.readFile(path, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function collectKeysFromEnv(envVarName: string | undefined): string[] {
  if (!envVarName) return [];
  const raw = process.env[envVarName];
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getOpencodeConfigDir(): string {
  if (process.env["OPENCODE_CONFIG_DIR"]) return process.env["OPENCODE_CONFIG_DIR"];
  const xdg = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(xdg, "opencode");
}

export async function loadConfig(directory: string): Promise<MistralConfig> {
  let raw: unknown = {};
  const searchDirs = [directory, getOpencodeConfigDir()];
  outer: for (const dir of searchDirs) {
    for (const name of CONFIG_FILENAMES) {
      const found = await readJsonIfExists(join(dir, name));
      if (found) {
        raw = found;
        break outer;
      }
    }
  }

  const parsed = configSchema.parse(raw);

  if (parsed.api_keys.length === 0 && parsed.api_keys_env) {
    parsed.api_keys = collectKeysFromEnv(parsed.api_keys_env);
  }
  if (parsed.api_keys.length === 0) {
    const envKey = process.env["MISTRAL_API_KEY"];
    if (envKey) {
      parsed.api_keys = envKey
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return parsed;
}
