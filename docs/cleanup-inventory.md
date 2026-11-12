# Cleanup inventory: VM / Orgo / screen code paths

Taken before removing the dead execution modes. One line per module; "removed" means deleted in this cleanup, "trimmed" means the dead branch was cut and the host-mode part kept.

| Module | What the hits were for | Action |
| --- | --- | --- |
| `server/src/env.ts` | `HQ_VM`/`HQ_LOCAL` mode flags, mutual-exclusion checks, `vmHost/vmPort/vmUser/vmKey/vmKnownHosts`, `orgoKey`, `orgoComputerId`, `localBox`, `primaryCdpUrl`, `maxBots` | trimmed: `hostMode` stays; `xaiKey`/`composioKey` optional |
| `server/src/engine.ts` | `vmBox`/`localBox` branches in `botCwd`, `executionMode`, `effectiveSettings`, `writeHome` (screen/CDP/ssh wrappers), `homeSafe` SSH policy, credential-inheritance gate | trimmed: `execution` is always `'host'` |
| `server/src/engine-runtime.ts` | `vmEngineSettings`, `sshWrapper`, `VmEngineTarget` | trimmed |
| `server/src/computer.ts` | Orgo computer lifecycle, screen leases, `screenFor`/`readyScreen`/`screenForWork`, `forgetBotFiles` | removed |
| `server/src/box.ts` | shell/file access to the shared computer (local, SSH to UTM guest, or Orgo API); `displayFor` | removed (library writes are plain `fs` now) |
| `server/src/desk.ts`, `server/box/*`, `server/scripts/desk-test.ts` | dressing an X screen (wallpaper, dock, Chrome, home page) on the computer | removed |
| `server/src/orgo.ts`, `server/src/vm-desktop.ts` | Orgo REST client and its UTM-guest stand-in | removed |
| `server/src/vm.ts` | SSH transport to the UTM guest, `isLocalRequest` guard (only applied under `HQ_VM`), `vncUrlFor` | removed |
| `server/src/vm-agent-tools.ts` | VM-only MCP tools (desktop/browser actions over SSH) | removed |
| `server/src/vnc.ts`, `server/src/lib/des.ts` | noVNC WebSocket relay and RFB DES auth | removed |
| `server/src/idle.ts` | viewer counting for the VNC relay and the (already disabled) Orgo hibernation watcher | removed |
| `server/src/mcp.ts` | `VM_AGENT_TOOLS` merge, VM body limit and batch cap | trimmed |
| `server/src/agent/loop.ts` | `screenForWork` before each turn, `handback_at` screen note | trimmed |
| `server/src/agent/prompt.ts` | VM execution-rules branch and shared-screen paragraph | trimmed: host text unchanged |
| `server/src/agent/tools.ts` | `LIBRARY_ROOT=/root/zoeybot/files`, `save_file` via `box.writeFile` | rewritten: per-bot `<Hermes home>/library` |
| `server/src/routes.ts` | `/computer*`, `/bots/:id/screenshot`, redress on rename, screen release on delete, `maxBots` cap | trimmed |
| `server/src/routes-config.ts` | library over `box.bash`/Orgo export, `/computer/details`, screen reset, handback, sign-in terminal on the screen | trimmed: library reads the host directory |
| `server/src/index.ts` | VNC relay, DES self-test, `isLocalRequest` under `HQ_VM`, idle watcher | trimmed |
| `server/src/local-voice.ts` | `HQ_VM=1` implied local voice | trimmed: `HQ_HOST=1` implies local voice |
| `server/src/types.ts` | `ComputerState`, `execution: 'vm' \| 'orgo'`, `computer` SSE event | trimmed |
| `web/src/components/ComputerViewer.tsx`, `styles/viewer.css`, `lib/computer.ts`, `novnc.d.ts` | noVNC viewer, screen frame, status text | removed |
| `web/src/components/DetailsPanel.tsx` | non-host branch (screen card, pop-out button, `computerStatusText`) | trimmed |
| `web/src/components/EngineSettings.tsx` | viewer-driven sign-in flow, `ownScreen` notice, `vm`/`orgo` labels | trimmed |
| `web/src/components/config/AppSettings.tsx` | "Computer" settings section (wake/sleep/screens) | removed section |
| `web/src/components/config/LibraryTab.tsx` | "computer asleep" gating | trimmed |
| `web/src/store.ts`, `App.tsx`, `ChatView.tsx`, `lib/api.ts`, `lib/configApi.ts`, `lib/events.ts` | `computer` state, `viewer*` state, "Open computer" menu item, computer endpoints | trimmed |
| `web/vite.config.ts`, `web/package.json` | noVNC top-level-await note, `@novnc/novnc` dependency | trimmed |
| `scripts/local-utm-*.{sh,mjs}`, `scripts/install-on-computer.sh`, `scripts/add-hq-to-hermes.py`, `scripts/pack.sh` | UTM bootstrap/tunnels/desktop prep, Orgo computer install and packing | removed |
| `scripts/local-services.py`, `tests/local-services-test.py` | `LEGACY_CONFIG_KEYS` tolerance for old `vm_uuid`/`utmctl` config, forbids `HQ_VM=1`/`HQ_LOCAL=1` in `.env` | kept (contract: `HQ_HOST=1` required, old config loads) |
| `tests/vm-*.{ts,py,mjs}`, `tests/local-utm-live-smoke.mjs`, `tests/box-desktop-test.py` | VM/Orgo-only suites and smokes | removed |
| `tests/engine-local.test.ts`, `tests/local-execution-prompt.test.ts`, `tests/local-voice.test.ts`, `tests/composio-google-auth.test.ts`, `tests/ask-bot.test.ts`, `tests/telegram.test.ts`, `tests/details-panel.test.ts`, `tests/engine-host.test.ts` | fixtures set `HQ_VM`, `ORGO_API_KEY`, `execution: 'vm'`, `screenForWork` | updated to host mode |
| `docs/local-utm-backend.md`, `docs/local-vm-agent-tools.md`, `docs/orgo-builder-guide.md` | guides for the removed modes | removed |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/local-hermes-engine.md`, `docs/local-macos-launcher.md`, `.env.example` | mentions of Orgo/UTM/VNC/`HQ_VM`/`HQ_LOCAL` | edited |
| `server/src/agent/tools.ts` `xSearch`, `env.xaiKey` | xAI X search (still used when a key is present) | kept |
| `server/src/db.ts` `computers`/`screens` tables, `bots.handback_at` | schema for the removed features | kept (no destructive migration; unused) |
