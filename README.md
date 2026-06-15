# opencode-mistral-multiauth

An [OpenCode](https://opencode.ai) plugin that transparently rotates between multiple Mistral API keys.

When a key gets rate-limited (429), rejected (401/403), or hits a 5xx, the plugin automatically swaps to the next healthy key and retries — without surfacing the failure to the model or the user. Visual toast notifications announce which key is in use and why a switch happened.

Ported architecture from [`opencode-antigravity-auth`](https://github.com/NoeFabris/opencode-antigravity-auth) (health scoring, token bucket, hybrid selection) and slimmed down for plain Bearer-token APIs.

## Features

- **Three scheduling modes**: `round-robin` (cycle every request), `sticky` (only switch on failure), `hybrid` (health-score + token-bucket scoring with stickiness).
- **Crash-safe shared state**: keys, last-used timestamps, and rate-limit reset windows persisted to `~/.config/opencode/mistral-accounts.json` with [`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) cross-process locking and atomic temp-file rename writes (0600 perms).
- **Health scoring**: per-key health score decays on failures, recovers over time, and gates selection below `min_usable`.
- **Token bucket**: client-side rate-limit prediction (`max_tokens` burst, `regeneration_rate_per_minute` sustained) avoids hitting server-side 429s.
- **Jittered exponential backoff**: same-key retry waits grow `1s → 2s → 4s → 8s` with `±30%` jitter; cross-key swaps fire immediately.
- **Toast notifications**: one toast per request showing the selected key (alias + 8-char keyHash), plus one per rotation with the failure reason.
- **Key aliases**: human-readable labels so you don't have to memorize hashes.
- **File-only logging**: writes to `~/.config/opencode/mistral.log` (auto-rotated at 5 MiB); never touches stdout/stderr so it can't corrupt the OpenCode TUI.

## Installation

```bash
git clone https://github.com/schlambos/opencode-mistral-multiauth.git ~/mistral
cd ~/mistral
npm install
npm run build
```

Then add the built entry point to your `~/.config/opencode/opencode.jsonc` plugin list:

```jsonc
{
  "plugin": [
    // ... your other plugins
    "file:///Users/YOU/mistral/dist/index.js"
  ]
}
```

Restart OpenCode. The plugin attaches to the `mistral` provider that OpenCode already ships via `@ai-sdk/mistral` — no provider config needed.

## Configuration

Create `~/.config/opencode/mistral.json` (or `mistral.json` in your project directory; the project file overrides the global one):

```jsonc
{
  "scheduling_mode": "round-robin",
  "log_level": "info",
  "api_keys": [
    { "alias": "personal", "key": "YOUR_KEY_1" },
    { "alias": "work",     "key": "YOUR_KEY_2" },
    "YOUR_KEY_3_NO_ALIAS"
  ]
}
```

`chmod 600 ~/.config/opencode/mistral.json` is recommended since it contains raw keys.

### All options

| Key | Default | Notes |
|---|---|---|
| `scheduling_mode` | `"hybrid"` | `"sticky"` \| `"round-robin"` \| `"hybrid"` |
| `api_keys` | `[]` | Each entry is either a raw string or `{ "alias": "...", "key": "..." }` |
| `api_keys_env` | – | Env var name whose value (comma- or whitespace-separated) is used if `api_keys` is empty |
| `provider_id` | `"mistral"` | Set if you've remapped OpenCode's mistral provider to a custom id |
| `log_level` | `"info"` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"silent"` |
| `health_score` | (see below) | Health scoring parameters |
| `token_bucket` | (see below) | Client-side rate-limit bucket parameters |
| `retry` | (see below) | Per-request retry / backoff parameters |

If `api_keys` is empty, the plugin falls back to `process.env.MISTRAL_API_KEY` (split on commas/whitespace) or whatever env var you name in `api_keys_env`.

### `health_score` defaults

```jsonc
{
  "initial": 70,              // starting score for a new key
  "success_reward": 1,        // points per OK response
  "rate_limit_penalty": -10,  // points per 429
  "failure_penalty": -20,     // points per 401 / 5xx / network error
  "recovery_rate_per_hour": 2,// passive recovery
  "min_usable": 50,           // below this, key is filtered out of selection
  "max_score": 100            // cap
}
```

### `token_bucket` defaults

```jsonc
{
  "max_tokens": 50,                  // burst size
  "regeneration_rate_per_minute": 6, // sustained rate
  "initial_tokens": 50
}
```

### `retry` defaults

```jsonc
{
  "max_attempts_per_request": 10,
  "same_key_initial_delay_ms": 1000,
  "same_key_max_delay_ms": 8000,
  "same_key_backoff_factor": 2,
  "cross_key_delay_ms": 50,
  "jitter_factor": 0.3
}
```

## Scheduling modes — what to pick

| Mode | Behavior | When to use |
|---|---|---|
| `round-robin` | Each request goes to the next key in the list (skipping rate-limited ones). | Even wear across keys; antigravity-style bouncing. |
| `sticky` | Stays on the current key until it gets 429/401/5xx. | Long-running tasks where you want prompt-cache hits to land on one key. |
| `hybrid` | Score-based selection with 150-point stickiness bonus; switches only when another key beats current by 100+ points or current degrades. | Best of both worlds at the cost of less predictability. |

## Toast notifications

Every request emits a toast naming the selected key. When the plugin rotates mid-request due to a failure, an additional toast describes the reason.

```
[info]    Mistral: using personal (a3f8c1b2)
          initial selection

[warning] Mistral: switched to work (7d4e9f01)
          rate-limited (429) on personal (a3f8c1b2)

[error]   Mistral: switched to work (7d4e9f01)
          rejected (401) on personal (a3f8c1b2)
```

(The 8-character identifier in parentheses is a truncated sha256 of the key, never the key itself — safe to share in screenshots.)

Toasts within 800 ms targeting the same key are debounced to one (tweak `TOAST_DEBOUNCE_MS` in `src/plugin.ts`).

## State and logs

| File | Contents |
|---|---|
| `~/.config/opencode/mistral-accounts.json` | Per-key `lastUsed`, `status`, `rateLimitResetTime`, `consecutiveFailures`. **Stores sha256-truncated key hashes, never raw keys.** 0600 perms. |
| `~/.config/opencode/mistral.log` | Plugin's structured log (auto-rotates to `.log.1` at 5 MiB). Override path with `MISTRAL_PLUGIN_LOG=/path/to/log`. |

To watch rotation live: `tail -f ~/.config/opencode/mistral.log`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # produces dist/
```

The test suite covers rotation algorithms (sticky / round-robin / hybrid), AccountManager state transitions, disk persistence roundtrips, fetch interceptor behavior across 200 / 429 / 401 / 5xx / network-error paths, and the `onSwitch` event lifecycle.

Source layout:

```
src/
  index.ts        # plugin entry — exports only MistralRotationPlugin
  api.ts          # secondary exports for programmatic consumers
  plugin.ts      # OpenCode Plugin factory + toast wiring
  config.ts      # Zod schema + file/env loading
  accounts.ts    # AccountManager: in-memory pool synced to disk
  rotation.ts    # HealthScoreTracker, TokenBucketTracker, selection algos
  request.ts     # Fetch interceptor with retry/backoff and SwitchEvent emission
  storage.ts     # Atomic disk persistence with proper-lockfile
  logger.ts      # File-only logger (no stdout writes)
```

## License

MIT
