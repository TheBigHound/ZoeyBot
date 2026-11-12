# Isolated local Hermes engine

Bot HQ's primary gateway uses `data/primary-hermes`, not the user's live `~/.hermes` configuration or a named Hermes profile. It listens on **127.0.0.1:8642** and defaults to installed **Ollama `qwen3.5:35b`** at `http://127.0.0.1:11434/v1` (Chat Completions). `phonon` is speech-only; `nomic-embed-text` is embeddings-only. Bot HQ filters the Ollama picker using `/api/show` completion capabilities.

## Dashboard environment

Set these in the dashboard launch environment (do not print the private gateway key):

```sh
HQ_VM=1
HQ_VM_KNOWN_HOSTS=/Users/thehound/VirtualMachines/BotHQ/ssh_known_hosts
HERMES_HOME_PRIMARY=/Users/thehound/bot-hq/data/primary-hermes
HERMES_URL=http://127.0.0.1:8642
HERMES_BIN=/Users/thehound/bot-hq/data/primary-hermes/runtime-hermes
```

The server reads `API_SERVER_KEY` from the isolated home's mode-0600 `.env`; `HERMES_KEY` need not be duplicated. `.env` contains credentials only (`API_SERVER_KEY`, `HQ_MCP_TOKEN`). Listener settings, model/provider, SSH settings, and MCP credential references are in config, created with the actual `hermes config set` CLI. Managed homes also use that CLI; refreshes preserve existing model/provider choices.

Restart **the Bot HQ dashboard backend only** after loading changed engine code or changing `HERMES_BIN`; do not restart or change the user's live Hermes. A dashboard that queried the engine before its key existed may still have the old cached empty key and show ready but no model/providers until this code is loaded. The new code retries discovery of an initially absent private key. The primary Bot HQ gateway is independently managed and the dashboard never restarts it.

## Primary gateway launch

The following starts only the private gateway. Stop an existing private gateway before deliberately starting another; do not use the user's default `hermes gateway restart`.

```sh
env -i HOME=/Users/thehound USER=thehound LANG=en_US.UTF-8 \
  PATH=/Users/thehound/bot-hq/data/primary-hermes/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  HERMES_HOME=/Users/thehound/bot-hq/data/primary-hermes \
  HERMES_GATEWAY_LOCK_DIR=/Users/thehound/bot-hq/data/primary-hermes/locks \
  BH_HOME=/Users/thehound/bot-hq/data/primary-hermes/browser-harness \
  /Users/thehound/bot-hq/data/primary-hermes/runtime-hermes gateway run --no-supervise
```

### Dependency-runtime caveat

The installed Hermes launcher tries to build a separate `[all]` dependency generation for each unfamiliar `HERMES_HOME`. The first private-home installs stalled downloading dependencies, including a retry with bounded UV HTTP settings; those installer processes were stopped, not mistaken for a successful gateway.

The private `runtime-hermes` adapter was generated from the installed launcher's `--print-runtime-command --module hermes_cli.main`. It bootstraps the **already committed dependency runtime only**, then sets the requested private `HERMES_HOME` before importing/running the official CLI. It disables lazy installs, never loads the live conversation, copies no credentials, and refuses an unset/private-home-equals-live-home target. The same adapter supports managed homes through `HERMES_BIN`. This is a local compatibility adapter, not a new Hermes configuration command. It depends on the current installed runtime/source location; regenerate and retest after a Hermes installation move or incompatible update.

## VM safety boundary

- Hermes terminal and file tools use the native SSH backend: `bot@127.0.0.1:2222`, dedicated key `/Users/thehound/.ssh/bot-hq-utm`, workspace `/home/bot`.
- The SSH/SCP wrappers prepend strict host verification and the independently pinned project-specific known-hosts file. They disable ControlMaster sockets: deep private-home scratch paths exceed macOS's Unix-domain-socket limit. No global `~/.ssh/known_hosts` writes or SSH host-config inheritance are needed.
- `HQ_VM_KNOWN_HOSTS` selects the pin file for the dashboard's VM transport. Without it the transport uses `data/vm-known-hosts` and fails closed until that file is independently provisioned; it never auto-enrolls a key.
- API toolsets are restricted to terminal, file, and todo (plus configured MCP tools). Native host browser, computer-use, Python code execution, delegation, and broad `hermes-api-server` bundles are not enabled.
- A remote CDP URL alone is **not** browser sandboxing: `browser_exec` runs arbitrary Python on the gateway host. Native browser/computer tools therefore remain disabled while the engine is host-side. Guest browser automation can use SSH with guest tools; a dedicated visual/native-browser guest adapter remains pending. The dashboard's VM desktop/viewer is a separate integration.
- VM-mode engine calls refuse unsafe primary config. Managed homes are rewritten to guest-only policy instead of adopting an unsafe healthy gateway. Host/cloud credentials are not silently inherited in VM mode.
- Existing provider login opens a host-home CLI in a bot desktop terminal; that is unsupported in VM mode and returns HTTP 409. Do not pretend a guest terminal can access the host home. Authenticate a future provider explicitly into the selected isolated home, then select its model in Engine settings. No cloud inference is necessary to validate persistence.

## Switching providers/models

The existing per-bot Engine settings API stores `provider` and `model` in the database; turns forward both to Hermes. Null values restore the isolated gateway's default. This remains configurable; Ollama is not hard-coded into the request loop. Provider switching/persistence and reset are regression-tested without contacting any cloud model. Cloud providers remain available as disconnected choices until explicitly configured; cloud login/inference is not verified by local smoke tests.

## Verified

- Ollama direct inference returned `LOCAL_QWEN_OK`.
- Private authenticated `/v1/responses` returned `HERMES_LOCAL_GATEWAY_OK`, model `qwen3.5:35b`, status `completed`.
- The actual gateway's terminal tool returned `bot-hq`, `bot`, `/home/bot` with exit code 0.
- The actual gateway's `read_file('/etc/hostname')` returned `bot-hq`, proving file operations reached the guest rather than the Mac.
- Private `/health`, `/v1/models`, `/api/model/options`, and Bot HQ `engineInfo` returned successfully; the resulting Ollama chat picker contains only `qwen3.5:35b`.
- A real managed-home CLI creation and refresh retained a deliberately changed model choice and the SSH/toolset policy; temporary smoke home removed afterward. No second managed gateway was left running.
- `tests/engine-local.test.ts` plus `tests/vm-backend.test.ts` and server typecheck pass. Test-runner Node deprecation warnings are environmental, not failed assertions.

Official references consulted: Hermes documentation pages `user-guide/configuration`, `integrations/providers`, `user-guide/features/api-server`, and the installed CLI, gateway, terminal-SSH, and configuration-guard sources. The local compatibility adapter and platform limits above are based on actual execution, not a claim that upstream provides a dedicated shared-runtime flag.
