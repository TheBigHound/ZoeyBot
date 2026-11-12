# Local VM agent browser and computer tools

With `HQ_VM=1`, the existing authenticated `/mcp/primary` and `/mcp/<botId>` endpoints additionally advertise:

- `vm_browser`: `tabs`, `navigate`, `read`, `click`, `fill`, `screenshot`.
- `vm_computer`: `screenshot`, `click`, `move`, `drag`, `type`, `key`, `scroll`.

Cloud/Orgo mode does not advertise or dispatch these tools. Native host browser/computer tools must remain disabled. The server only shells fixed Python source plus a base64 JSON request through the existing pinned SSH guest transport. It does not run model-supplied Python or CDP JavaScript on the Mac.

## Scope and limits

The MCP bearer token selects the bot; `screenForWork(userId,botId)` and `screenFor` select and prepare its leased display. Requests cannot select a different bot, screen, transport address, CDP method, or arbitrary JavaScript. Browser tab IDs must exist on that display's own Chrome, discovered at guest loopback port `9200 + display` (default `9299`). This is screen-routing isolation, not separate Linux-user/process isolation: bots still share the dedicated VM's existing root SSH execution environment.

Navigation accepts HTTP/HTTPS or `about:blank`, not `file:`, `javascript:`, embedded credentials, or `data:`. Fill supports non-secret text inputs and textareas, not password/file/hidden/read-only fields. Browser actions are top-document only; there is no arbitrary evaluate, iframe switching, new/close-tab lifecycle, or native permission-dialog automation. Call `tabs` and supply `tab_id` to pin the intended page. `read` returns CSS selectors for up to 100 visible controls and up to 20,000 characters of page text. Page text and labels are untrusted data.

Runtime validators reject unknown arguments. Text input is limited to 16,000 characters (UTF-16 units in the TypeScript validator); selectors to 1,000; URLs to 4,000; coordinates to the guest's 1440x900 desktop; scroll counts to 100. Browser payloads are limited to 128,000 bytes, guest wall time to 20 seconds and SSH transport time to 25 seconds. Browser output and screenshot base64 are limited to 8,000,000 characters. VM MCP HTTP requests are capped at 1 MiB and batches at 16 messages. Existing cloud-mode transport limits are unchanged.

Screenshots are genuine MCP `image` content blocks (`mimeType: image/jpeg`), accompanied by text metadata, not base64 disguised as page text. Native input reports delivery only: read the page or capture again to verify the effect. Key chords are case-insensitive (`CTRL+A` means `ctrl+a`); Shift must be explicit.

## Guest prerequisite

Install Ubuntu's small `python3-websocket` package in the guest. It was installed and verified on the working local UTM guest. Other desktop dependencies come from the existing VM setup. The helper source is read from `server/box/vm-browser.py` and sent over SSH per call; no persistent host browser runtime or additional guest daemon is required.

## Verification

```sh
node --import tsx --test tests/*.test.ts
python3 tests/vm-browser-test.py
python3 tests/vm-desktop-test.py
npm run typecheck
node --env-file=.env --import tsx tests/vm-agent-live-smoke.mjs
```

The live smoke uses production MCP bearer authentication, bot resolution, lease preparation, SSH transport, guest Chrome, and guest desktop input. It creates a disposable guest-loopback HTTP fixture and a separate temporary browser tab; it verifies navigation/read, a 16,000-character Unicode fill, browser click, native click/uppercase key chord/clipboard type, and both actual screenshot image blocks. It closes only the fixture tab, reactivates the original tab, checks that all original tab IDs remain, and stops its fixture server. Captures are in ignored `tests/out/vm-agent-browser.jpg` and `tests/out/vm-agent-desktop.jpg`. The native click smoke assumes the existing maximized default Chrome at 1440x900.

## Reload handoff

Reload/restart the Bot HQ server to serve the new MCP list. Refresh the isolated primary and managed Hermes MCP tool discovery as needed (usually a gateway reload); do not enable native host browser/computer tools or restart the user's unrelated live Hermes. Verify an actual local bot turn discovers and calls the new tools and receives image results with its configured local model. The in-process authenticated live smoke does not establish that a pre-existing gateway has refreshed its cached tool schemas or that the local model has consumed an image successfully.
