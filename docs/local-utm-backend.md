# Local UTM computer backend

Set `HQ_VM=1` to keep the ZoeyBot server on the Mac while running desktop commands and files in a dedicated Linux guest. Cloud Orgo behavior remains the default. `HQ_LOCAL=1` and `HQ_VM=1` are mutually exclusive.

## Configuration

- `HQ_VM_HOST=127.0.0.1` (loopback only)
- `HQ_VM_PORT=2222`
- `HQ_VM_USER=bot`
- `HQ_VM_KEY=/Users/thehound/.ssh/zoeybot-utm` (default is the current user's home plus `.ssh/zoeybot-utm`)
- `SESSION_SECRET` is still required. Cloud keys and `ORGO_COMPUTER_ID` are not.

The internal computer identifier is `utm-local`; it is never submitted to Orgo. `HQ_VM=1` forces server binding to `127.0.0.1`, enables local dev-email login, and rejects non-loopback Host/Origin headers on HTTP and screen WebSocket requests. Session authentication and watch-mode input filtering still apply. Do not expose SSH forwards or the app through a public reverse proxy.

SSH requires a dedicated guest account with passwordless `sudo`. Commands run through `sudo -n env -i ... bash --noprofile --norc -s` as **guest root**, with only a minimal Linux environment and per-screen `DISPLAY`. Mac credentials and environment variables are not copied. Existing `/opt/hq` scripts and `/root/zoeybot` desktop profiles/Library files therefore continue working without path migration. This backend does not install or configure the VM itself.

## Guest dependencies

The VM provisioner must install Python 3, bash, Xvfb, x11vnc, websockify, openbox, xdotool, xclip, x11-utils (`xdpyinfo`), ImageMagick (`import`), and a working ARM64 Chromium/Chrome. Existing desktop dressing installs/checks its additional packages through `server/box/hq-screen.py`.

`server/box/vm-desktop.py` is sent over SSH for each operation; no HTTP control service is installed. It creates/adopts display `:99` and creates additional displays `:100`–`:102` on demand, at 1440×900. X11 TCP listening is disabled, x11vnc is localhost-only, and websockify binds `127.0.0.1`. Managed processes/logs and allocation markers are under `/run/zoeybot`, with a file lock serializing lifecycle changes. They survive app/SSH disconnects and are recreated lazily after guest reboot. App screen leases remain in its database.

## Persistent SSH forwards required on the Mac

Provisioning/start scripts must keep these **loopback-to-loopback** forwards alive:

| Display | Screen ID | Guest raw VNC | Host → guest websockify | Host → guest Chrome CDP |
|---|---|---:|---:|---:|
| :99 | default | 5999 | 6099 → 6099 | 9299 → 9299 |
| :100 | screen-100 | 6000 | 6100 → 6100 | 9300 → 9300 |
| :101 | screen-101 | 6001 | 6101 → 6101 | 9301 → 9301 |
| :102 | screen-102 | 6002 | 6102 → 6102 | 9302 → 9302 |

Example forwarding argument: `-L 127.0.0.1:6099:127.0.0.1:6099`. Forwarding to a service that has not started yet is allowed. Do not forward raw VNC to the LAN; the guest's loopback VNC uses RFB None security and the app supplies the authenticated relay. `PRIMARY_CDP_URL`, if set, still overrides the primary bot's managed browser; leave it empty to manage the primary browser in the VM.

## Features and verification

- Screenshots, pointer/key/Unicode clipboard input, shell execution, and desktop dressing route to the VM through the existing `orgo` compatibility interface and `box` abstraction.
- Library listings use the guest shell. Downloads use authenticated local URLs and bounded guest reads (16 MiB), with realpath confinement; no cloud export or hosting is involved.
- Orgo workspace/export operations explicitly report unavailable. The app never suspends the VM; use UTM.
- Missing Composio credentials do not fail module imports; app-connection operations return explicit HTTP 503 errors. Local voice is a separate adapter owned by the voice implementation.

Run backend regressions with `node --import tsx --test tests/vm-backend.test.ts`, guest logic tests with `python3 tests/vm-desktop-test.py`, and project validation with `npm run typecheck && npm run build`. Transport fixture tests exercise real subprocess shell/file handling but are **not** an end-to-end VM test. A real smoke test must connect to the provisioned guest, create/list screens, capture/decode a screenshot, confirm CDP and VNC handshakes through forwards, and exercise the UI before claiming VM readiness.
