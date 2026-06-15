import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { AccountManager } from "./accounts.js";
import { createInterceptingFetch, type SwitchEvent } from "./request.js";
import { setLogLevel, createLogger } from "./logger.js";

const log = createLogger("plugin");

export interface CreatePluginOptions {
  providerId?: string;
}

const TOAST_DEBOUNCE_MS = 800;

type ToastVariant = "info" | "warning" | "error";

function shortHash(h: string): string {
  return h.slice(0, 8);
}

function labelFor(alias: string | undefined, keyHash: string): string {
  if (alias) return `${alias} (${shortHash(keyHash)})`;
  return shortHash(keyHash);
}

function describeReason(reason: SwitchEvent["reason"], status?: number): string {
  switch (reason) {
    case "initial":
      return "initial selection";
    case "429":
      return "rate-limited (429)";
    case "401":
      return "rejected (401)";
    case "403":
      return "forbidden (403)";
    case "5xx":
      return `server error (${status ?? "5xx"})`;
    case "network-error":
      return "network error";
  }
}

function buildToast(event: SwitchEvent): { title: string; message: string; variant: ToastVariant } {
  const toLabel = labelFor(event.toAlias, event.toKeyHash);
  const detail = describeReason(event.reason, event.status);

  if (event.reason === "initial") {
    return {
      title: `Mistral: using ${toLabel}`,
      message: detail,
      variant: "info",
    };
  }

  const fromLabel = labelFor(event.fromAlias, event.fromKeyHash);
  const variant: ToastVariant =
    event.reason === "401" || event.reason === "403" ? "error" : "warning";
  return {
    title: `Mistral: switched to ${toLabel}`,
    message: `${detail} on ${fromLabel}`,
    variant,
  };
}

export function createMistralRotationPlugin(opts: CreatePluginOptions = {}): Plugin {
  return async ({ directory, client }) => {
    const config = await loadConfig(directory);
    setLogLevel(config.log_level);

    const providerId = opts.providerId ?? config.provider_id;

    if (config.api_keys.length === 0) {
      log.warn(
        "no Mistral API keys configured; plugin will pass requests through unchanged",
      );
    }

    const manager = await AccountManager.loadFromDisk(config);
    if (manager.getAccountCount() > 0) {
      manager.requestSaveToDisk();
    }

    let lastToastAt = 0;
    let lastToastKey: string | null = null;
    const onSwitch = (event: SwitchEvent): void => {
      const now = Date.now();
      const sameKeyAsLast = lastToastKey === event.toKeyHash;
      if (sameKeyAsLast && now - lastToastAt < TOAST_DEBOUNCE_MS) return;
      lastToastAt = now;
      lastToastKey = event.toKeyHash;

      const { title, message, variant } = buildToast(event);

      log.info(event.reason === "initial" ? "key selected" : "key switch", {
        from: event.fromKeyHash || undefined,
        to: event.toKeyHash,
        reason: event.reason,
        status: event.status,
      });

      const tui = (client as { tui?: { showToast?: (input: unknown) => Promise<unknown> } })?.tui;
      if (!tui?.showToast) return;
      void tui
        .showToast({
          body: { title, message, variant },
        })
        .catch((err: unknown) => {
          log.warn("showToast failed", { error: String(err) });
        });
    };

    const interceptingFetch = createInterceptingFetch({
      manager,
      retry: config.retry,
      onSwitch,
    });

    return {
      auth: {
        provider: providerId,
        loader: async () => {
          if (manager.getAccountCount() === 0) {
            return {};
          }
          const first = manager.getAccounts()[0];
          return {
            apiKey: first?.apiKey ?? "",
            fetch: interceptingFetch as typeof fetch,
          };
        },
        methods: [
          {
            type: "api",
            label: "Mistral (rotation managed by mistral.json)",
          },
        ],
      },
    };
  };
}

export const mistralRotationPlugin: Plugin = createMistralRotationPlugin();
