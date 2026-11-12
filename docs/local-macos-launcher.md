# Bot HQ: explicit one-click macOS launcher

## Installed artifact and commands

- App: `/Users/thehound/Applications/Bot HQ.app`
- Source/orchestrator: `scripts/BotHQLauncher.swift`, `scripts/local-services.py`
- Private generated state: `data/launchd/` (0700); `config.json` and four `com.thehound.bothq.*.plist` files (0600).
- Private executable helpers: `data/launchd/start.command`, `data/launchd/stop.command` (0700).
- Private logs: `data/logs/` (0700), `launcher.log`, `{engine,tunnels,web,ollama}.{out,err}.log` (0600).
- Regression suite: `tests/local-services-test.py` (offline; no real launchd writes).

Open **Bot HQ.app** to check/start the existing UTM VM and services, then open `http://127.0.0.1:8787`. A native progress window remains until ready; failures show an alert and a Show Logs button. The app then quits; launchd owns the services, not the app process. Quitting the browser does not stop Bot HQ.

```sh
cd /Users/thehound/bot-hq
/usr/bin/python3 scripts/local-services.py start --open-browser
/usr/bin/python3 scripts/local-services.py status --check
/usr/bin/python3 scripts/local-services.py status --check --require-managed
/usr/bin/python3 scripts/local-services.py stop
# Only when VM shutdown is explicitly wanted:
/usr/bin/python3 scripts/local-services.py stop --shutdown-vm
```

`stop` unloads **only** the four owned launchd labels. Healthy externally launched components are reused by `start`, not adopted, restarted, or stopped. Default stop leaves the VM running. `--shutdown-vm` requests a graceful shutdown of this exact UUID and verifies it stopped; it never force-powers-off a guest.

## No login autostart or VM creation

Plists live in the project, **not** `~/Library/LaunchAgents`, system LaunchDaemons, or login items. Installation only generates files and compiles/ad-hoc signs the native app. The explicit `start` action bootstraps jobs into `gui/<uid>`. `RunAtLoad` applies to that explicit bootstrap, not a future login. `KeepAlive` restarts a loaded job if it exits; `bootout` removes it. Start Bot HQ explicitly again after login/reboot. Nothing registers or creates a VM, modifies VM shares, enrolls SSH host keys, installs models, or changes the user's live Hermes.

The fixed existing VM is `A1CE5F16-4C0F-42F6-BD61-742708F09212`. Startup opens the installed UTM.app in the background, uses `utmctl status` and, only if stopped/suspended/paused, `utmctl start --hide UUID`. Guest identity must match `bot-hq`, `bot`, `/home/bot` through pinned dedicated-key SSH. The launcher does not add host-folder sharing.

## Owned jobs and process handles

Use `gui/$(id -u)/<label>` as the persistent process handle, **not** a remembered numeric PID:

| Label | Listener(s) | Process | Working directory |
|---|---|---|---|
| `com.thehound.bothq.engine` | 127.0.0.1:8642 | private `runtime-hermes gateway run --no-supervise` | project root |
| `com.thehound.bothq.tunnels` | 127.0.0.1:6099–6102,9299–9302 | foreground dedicated SSH tunnel | project root |
| `com.thehound.bothq.web` | 127.0.0.1:8787 | installed absolute Node binary, `dist/index.js` | `server/` |
| `com.thehound.bothq.ollama` | 127.0.0.1:11434 | installed Ollama, `serve` | project root |

The Ollama job is optional: the existing healthy Ollama.app listener is normally reused, and its process is never stopped by the helper. No model is pulled. Reasoning model/provider switching remains in existing Engine settings; this launcher does not rewrite that selection. Phonon/Zoey remains the existing local voice adapter, not a second inference service.

All job commands begin `/usr/bin/env -i`. The engine receives only explicit private-home, lock, browser-harness, HOME, PATH, LANG, USER, and private TMPDIR settings. No live Hermes conversation/profile or inherited cloud keys are passed through. The dashboard reads `.env`, then optional `.env.local`, using Node's env-file flags; credentials are not copied into plist files or commands. Node, Ollama TTS, FFmpeg, and the Hermes runtime-discovery executable for local Whisper are pinned to absolute paths captured at installation. Reinstall after moving/updating those executable paths; shell-only PATH entries otherwise disappear in launchd and can silently disable dictation or PCM speech.

Startup order is Ollama → SSH tunnels → web → private engine. The engine discovers the web server's authenticated HQ MCP tools at boot; starting it before web parks that discovery and leaves the bot without browser/computer/app tools even if both health endpoints later answer. The native bundle includes `NSAppleEventsUsageDescription` for UTM Automation; do not remove it when rebuilding. If macOS asks for permission to control UTM, the user must approve it explicitly.

## Initial migration reference (completed; do not repeat on a healthy setup)

The initial manual-process migration has been exercised through the actual installed native app. Verification returned `ready: true`, `managed: true`; reopening the app preserved all listener PIDs. Owned stop/start was exercised without stopping the VM or existing Ollama. Real Zoey turns called the guest terminal, browser tabs, and screenshot tool and described the returned image. `node tests/local-app-live-smoke.mjs --voice` also verified real 24kHz PCM synthesis followed by local Whisper transcription through the running launchd dashboard. These checks do not claim physical microphone capture or speaker audibility.

The steps below document the original transition and gates for a future equivalent migration, not instructions to kill today's managed services. Discover current ownership afresh. The active installation now uses the stable launchd labels above rather than the retired tracked-process handles.

1. Wait for all source-editing workers to finish. Build the final production application while the old components remain up:

   ```sh
   cd /Users/thehound/bot-hq
   export PATH="/Users/thehound/.hermes/tools/node-26.12.1-darwin-arm64/bin:$PATH"
   npm run build
   /usr/bin/python3 tests/local-services-test.py -v
   /usr/bin/python3 scripts/local-services.py preflight
   /usr/bin/python3 scripts/local-services.py status --check
   ```

   `preflight` checks files, credential permissions, plist consistency and the GUI launchd domain, without reading credential contents or changing services. It checks build existence, not source freshness; the final `npm run build` above is mandatory.

2. For a future manual-to-launchd transition, use the owning session's tracked-process tool to stop only its confirmed **dashboard**, **private engine**, and **tunnels**. First run `process_manage(action="list")` and confirm commands, PIDs, owner and working directory. Original handles `proc_591fd8209523`, `proc_dc85e1834142`, and `proc_60a8fe5025e1` were deliberately stopped during the completed migration; they are historical, not current stop targets. Leave any independently running Ollama.app listener alone.

   Do not run broad `pkill`, kill by port, stop the user's live Hermes, or unload unrelated jobs. The initial gateway may belong to an earlier parent-owned session and not appear in a child-scoped list; resolve that in the owning parent rather than guessing a replacement PID.

3. Verify every migration port is free before starting. **No rows** is the expected result (`lsof` returns 1 when none exist):

   ```sh
   /usr/sbin/lsof -nP -iTCP:8642 -iTCP:8787 -iTCP:6099 -iTCP:6100 -iTCP:6101 -iTCP:6102 -iTCP:9299 -iTCP:9300 -iTCP:9301 -iTCP:9302 -sTCP:LISTEN
   ```

   If anything still listens, identify it and stop only its verified parent-owned tracked process. Do not proceed by killing an unknown listener. VM and existing Ollama must remain running.

4. Start through the actual installed app and wait for the progress window to close:

   ```sh
   /usr/bin/open '/Users/thehound/Applications/Bot HQ.app'
   ```

   Then verify the exact managed targets and health:

   ```sh
   cd /Users/thehound/bot-hq
   /usr/bin/python3 scripts/local-services.py status --check --require-managed
   /bin/launchctl print "gui/$(id -u)/com.thehound.bothq.engine"
   /bin/launchctl print "gui/$(id -u)/com.thehound.bothq.tunnels"
   /bin/launchctl print "gui/$(id -u)/com.thehound.bothq.web"
   /usr/bin/curl --fail --silent --show-error http://127.0.0.1:8642/health
   /usr/bin/curl --fail --silent --show-error http://127.0.0.1:8787/api/health
   ```

   All three required jobs must be loaded, with stable running PIDs in `launchctl print` and matching listener ownership in `status`. `status` must say `ready: true`, `managed: true`; required service actions should be `keep`, Ollama normally `reuse`. Optional Ollama job need not be loaded. `open` returning 0 is **not** the acceptance gate.

5. Exercise actual application behavior and repeat-launch idempotence:

   ```sh
   node tests/local-app-live-smoke.mjs --chat
   # Guest desktop smoke creates/deletes one temporary second screen:
   node --env-file=.env --import tsx tests/local-utm-live-smoke.mjs
   /usr/bin/open '/Users/thehound/Applications/Bot HQ.app'
   /usr/bin/python3 scripts/local-services.py status --check --require-managed
   ```

   Verify required listener PIDs did not change on the second successful app launch. In the browser verify real guest desktop, a local Qwen chat/tool turn, model picker/provider persistence, local Zoey playback and microphone dictation separately. Launcher health does not establish model generation, physical audio playback, or guest-tool isolation by itself. Use the isolated-engine gates in `docs/local-hermes-engine.md`; do not perform cloud inference.

6. Parent may test stop/start after that first acceptance. Stop must remove only owned jobs; default VM and Ollama remain running. Verify `launchctl print` cannot find the three required job targets, and verify migration ports are free, before opening the app again. Do **not** test `--shutdown-vm` unless VM shutdown is separately authorized.

## Readiness and failure behavior

- Identifies listeners by process command, working directory, the exact dedicated SSH key/pin configuration, and expected forward set. Unknown listeners or non-loopback binds cause a clear failure, even if the URL returns HTTP200.
- Plans all components before VM/launchd changes. Healthy recognized external listeners are reused; unhealthy or incomplete external components fail closed instead of being replaced. Existing owned-but-not-ready jobs are waited on, not kicked/restarted blindly.
- Pins SSH host checking and verifies actual guest identity; key mismatch fails immediately. VM/SSH waits are bounded to approximately180 seconds each; service waits approximately120 seconds each plus individual bounded probes. A cold start can take several minutes.
- Tunnels require all eight forwarding listeners from one dedicated SSH process, actual primary CDP browser identity, and a valid WebSocket upgrade plus real `RFB 003.*` greeting on6099. Secondary guest screen targets need not be up before their bots exist.
- Engine health requires `status=ok`, `platform=hermes-agent` on8642. Dashboard requires `ok=true`, `engine=hermes` on8787 **and** built HTML/script delivery at `/`. Ollama requires a valid local model catalog response.
- Start/stop/install share a nonblocking exclusive file lock; a simultaneous lifecycle operation gets a clear retry-later error. Newly started jobs are rolled back in reverse order on downstream startup failure; preexisting jobs/external processes and the VM are not stopped as rollback. Inspect logs if rollback itself fails.
- Stop verifies the target job is actually unloaded before reporting success. VM shutdown, when explicitly requested, is verified separately. Job removal is not a substitute for the listener/process checks in the parent acceptance steps.

## Rebuild/reinstall and non-disruptive verification

```sh
cd /Users/thehound/bot-hq
# Generates private files, compiles Swift and ad-hoc signs; does NOT load jobs:
/usr/bin/python3 scripts/local-services.py install
/usr/bin/python3 tests/local-services-test.py -v
/usr/bin/plutil -lint data/launchd/*.plist '/Users/thehound/Applications/Bot HQ.app/Contents/Info.plist'
/usr/bin/codesign --verify --deep --strict --verbose=2 '/Users/thehound/Applications/Bot HQ.app'
'/Users/thehound/Applications/Bot HQ.app/Contents/MacOS/BotHQLauncher' --self-test
/bin/bash -n data/launchd/start.command data/launchd/stop.command
/usr/bin/python3 scripts/local-services.py status --check
```

Native executable `--self-test` prints the embedded launcher/root paths without UI, VM access or service changes. Local ad-hoc signing is not Developer ID notarization or a portable distribution installer. The app is installed for this Mac/user and points to this checkout. Source changes to the Python orchestrator are picked up on the next launch; Swift changes require `install` again. Replacing plist files does not change already-loaded jobs: stop/start only the owned jobs explicitly when applying such changes.
