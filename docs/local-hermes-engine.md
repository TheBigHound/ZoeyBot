# Isolated local Hermes engine

ZoeyBot's primary gateway uses `data/primary-hermes`, not the user's live `~/.hermes` configuration or a named Hermes profile. It listens on **127.0.0.1:8642** and defaults to installed **Ollama `qwen3.5:35b`** at `http://127.0.0.1:11434/v1` (Chat Completions). `phonon` is speech-only; `nomic-embed-text` is embeddings-only. ZoeyBot filters the Ollama picker using `/api/show` completion capabilities.

## Dashboard environment

Set these in the dashboard launch environment (do not print the private gateway key):

```sh
HQ_HOST=1
HERMES_HOME_PRIMARY=/Users/thehound/zoeybot/data/primary-hermes
HERMES_URL=http://127.0.0.1:8642
HERMES_BIN=/Users/thehound/zoeybot/data/primary-hermes/runtime-hermes
```

The server reads `API_SERVER_KEY` from the isolated home's mode-0600 `.env`; `HERMES_KEY` need not be duplicated. `.env` contains credentials only (`API_SERVER_KEY`, `HQ_MCP_TOKEN`). Listener settings, model/provider, terminal cwd/toolsets, and MCP credential references are in config, created with the actual `hermes config set` CLI. Managed homes also use that CLI; refreshes preserve existing model/provider choices.

Restart **the ZoeyBot dashboard backend only** after loading changed engine code or changing `HERMES_BIN`; do not restart or change the user's live Hermes. A dashboard that queried the engine before its key existed may still have the old cached empty key and show ready but no model/providers until this code is loaded. The new code retries discovery of an initially absent private key. The primary ZoeyBot gateway is independently managed and the dashboard never restarts it.

## Primary gateway launch

The following starts only the private gateway. Stop an existing private gateway before deliberately starting another; do not use the user's default `hermes gateway restart`.

```sh
env -i HOME=/Users/thehound USER=thehound LANG=en_US.UTF-8 \
  PATH=/Users/thehound/zoeybot/data/primary-hermes/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  HERMES_HOME=/Users/thehound/zoeybot/data/primary-hermes \
  HERMES_GATEWAY_LOCK_DIR=/Users/thehound/zoeybot/data/primary-hermes/locks \
  BH_HOME=/Users/thehound/zoeybot/data/primary-hermes/browser-harness \
  /Users/thehound/zoeybot/data/primary-hermes/runtime-hermes gateway run --no-supervise
```

### Dependency-runtime caveat

The installed Hermes launcher tries to build a separate `[all]` dependency generation for each unfamiliar `HERMES_HOME`. The first private-home installs stalled downloading dependencies, including a retry with bounded UV HTTP settings; those installer processes were stopped, not mistaken for a successful gateway.

The private `runtime-hermes` adapter was generated from the installed launcher's `--print-runtime-command --module hermes_cli.main`. It bootstraps the **already committed dependency runtime only**, then sets the requested private `HERMES_HOME` before importing/running the official CLI. It disables lazy installs, never loads the live conversation, copies no credentials, and refuses an unset/private-home-equals-live-home target. The same adapter supports managed homes through `HERMES_BIN`. This is a local compatibility adapter, not a new Hermes configuration command. It depends on the current installed runtime/source location; regenerate and retest after a Hermes installation move or incompatible update.

## Safety boundary (host mode)

Bots run as the owner's user on this Mac, limited by their toolset allowlist and `cwd` (see "Host mode" below). The former VM/SSH boundary (UTM guest, pinned known-hosts, guest-only toolsets) was removed together with `HQ_VM`; its code no longer exists.

## Switching providers/models

The existing per-bot Engine settings API stores `provider` and `model` in the database; turns forward both to Hermes. Null values restore the isolated gateway's default. This remains configurable; Ollama is not hard-coded into the request loop. Provider switching/persistence and reset are regression-tested without contacting any cloud model. Cloud providers remain available as disconnected choices until explicitly configured; cloud login/inference is not verified by local smoke tests.

## Verified

- Ollama direct inference returned `LOCAL_QWEN_OK`.
- Private authenticated `/v1/responses` returned `HERMES_LOCAL_GATEWAY_OK`, model `qwen3.5:35b`, status `completed`.
- The actual gateway's terminal tool returned `zoeybot`, `bot`, `/home/bot` with exit code 0.
- The actual gateway's `read_file('/etc/hostname')` returned `zoeybot`, proving file operations reached the guest rather than the Mac.
- Private `/health`, `/v1/models`, `/api/model/options`, and ZoeyBot `engineInfo` returned successfully; the resulting Ollama chat picker contains only `qwen3.5:35b`.
- A real managed-home CLI creation and refresh retained a deliberately changed model choice and the toolset policy; temporary smoke home removed afterward. No second managed gateway was left running.
- `tests/engine-local.test.ts` plus `tests/engine-host.test.ts` and server typecheck pass. Test-runner Node deprecation warnings are environmental, not failed assertions.

Official references consulted: Hermes documentation pages `user-guide/configuration`, `integrations/providers`, `user-guide/features/api-server`, and the installed CLI, gateway, terminal-SSH, and configuration-guard sources. The local compatibility adapter and platform limits above are based on actual execution, not a claim that upstream provides a dedicated shared-runtime flag.

## Host mode (current)

The VM is gone. Every bot's Hermes gateway runs on the macOS host itself: one Hermes home per bot, each with its own working directory and its own tool allowlist. `scripts/local-services.py` now manages exactly three launchd jobs, started in this order: `ollama`, `web`, `engine`. There is no `tunnels` job, no UTM start, no SSH readiness check, and `stop --shutdown-vm` no longer exists. An older `data/launchd/config.json` that still carries `vm_uuid`/`utmctl`/`key`/`known_hosts` loads fine (the keys are ignored) so `install` can simply be re-run.

### Environment

| Variable | Meaning |
| --- | --- |
| `HQ_HOST=1` | Host mode, the only mode. Sets `env.hostMode` (loopback bind, dev login implied). `HQ_VM`/`HQ_LOCAL` are ignored; the code behind them is gone. |
| `HERMES_HOME_PRIMARY` | The primary bot's home (`data/primary-hermes`). Still managed outside the app: never rewritten or restarted by ZoeyBot. |
| `HERMES_BIN`, `HERMES_URL`, `ENGINES_DIR`, `ENGINE_PORT_BASE`, `MCP_BASE_URL` | Unchanged. Managed homes live under `ENGINES_DIR/<botId>`. |

In host mode the server binds `127.0.0.1`, `DEV_LOGIN` is implied, and `XAI_API_KEY`/`COMPOSIO_API_KEY` are optional. There are no screens; `writeHome` never touches a display or CDP. Each bot's Library is `<home>/library` (`save_file`, Library tab).

### Per-bot settings

Two nullable columns on `bots`: `cwd TEXT` and `toolsets TEXT` (a JSON array of Hermes toolset names). They are edited through `PATCH /api/bots/:id/engine` (the same route as `model`/`provider`) and read back on `GET /api/bots/:id/engine`, whose `EngineInfo` now also carries `home`, `cwd` (effective), `toolsets` (effective) and `execution: 'host'` (always; kept for the UI).

- `cwd` must be an absolute, existing directory; otherwise HTTP 400. Unset means `<home>/workspace` (created on write).
- `toolsets` must contain only known names: `terminal, file, web, browser, skills, todo, memory, vision, code_execution, delegation, chat_history_lookup, cronjob, image_gen, x_search` (`clarify` is rejected: useless over the API). An empty list clears back to the default `['terminal','file','web','browser','skills','todo','memory','vision']`.
- For a **managed** bot a change rewrites the home (`hermes config set --force …`) and restarts its gateway. For the **primary** bot the values are only stored and the response carries a `note` saying so; set that agent's config by hand.

What `writeHome` produces for a managed bot in host mode: `terminal: { backend: local, cwd }`, `platform_toolsets.api_server = <bot toolsets>`, `browser.use_real_profile = false`, the `hq` MCP server, the `api_server` platform on the bot's port, `.env` with `API_SERVER_KEY` and `HQ_MCP_TOKEN` plus the model credentials inherited from the primary home (`SHARED_ENV`: Anthropic/OpenAI/… keys, never messaging tokens), and `auth.json` copied from the primary home on first write so every bot can use the same subscription.

### No longer true

- Managed homes do **not** use the ssh terminal backend; no `bin/ssh`/`bin/scp` wrappers are written (stale ones are removed on the next write).
- Toolsets are **not** restricted to the guest-only `terminal, file, todo`; each bot has its own allowlist.
- `engineFor('primary')` no longer refuses a plain local config; the SSH-policy gate is gone.
- Credentials **are** inherited from the primary home (model keys only, never messaging tokens).
- `vmEngineSettings` / `sshWrapper`, `server/src/vm*.ts`, `box.ts`, `computer.ts`, `orgo.ts`, `vnc.ts` were deleted (see `docs/cleanup-inventory.md`).
