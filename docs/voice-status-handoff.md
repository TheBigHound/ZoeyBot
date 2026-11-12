# ZoeyBot voice: status

## Current state (Nov 12, 2026 — resumed troubleshooting)

Composer wiring gaps from the earlier handoff are closed and deployed. The live dashboard at
`http://127.0.0.1:8787/` serves bundle `index-D9e_T9xI.js` with:

- `useDictation(..., bot.id)` so a bot switch cancels an in-flight dictation and late transcripts
  cannot land in another draft.
- `onPointerCancel` bound on the mic button.
- Visible `starting` state (`data-dictation`, `aria-busy`, `is-starting` style, title
  "Starting microphone… · Esc cancels").
- Escape now cancels during `starting` as well as `recording` (`dictation.ts`).
- `react-test-renderer@18.3.1` is declared in root `devDependencies` (lockfile updated).

## Verified (automated)

| Gate | Result |
|---|---|
| `node --import tsx --test tests/*.test.ts` | 85 tests, 83 pass, 2 optional skipped, 0 fail |
| `npm run typecheck` | pass (server + web) |
| `tests/composer-dictation.test.ts` (new) | 3 pass; Escape case confirmed RED before the fix |
| `node tests/local-app-live-smoke.mjs --voice` | `localVoiceRoundTrip: true` through the launchd web process |
| Browser dictation (isolated Chromium tab, synthetic mic fed with real phonon PCM) | tap → `recording` → tap → `transcribing` → `idle`; draft = "The quick brown fox jumps over the lazy dog."; mic track `ended` |
| Browser local conversation (isolated tab, send intercepted + synthetic assistant row; nothing written to the server conversation) | Opening microphone → Listening → Transcribing locally (Whisper: "Hello, Zoe. Can you hear me?") → Waiting for Zoey → Zoey is speaking · microphone paused (real `/api/voice/preview` PCM 153,600 B, 76,800 samples played, AudioContext running, `ended`) → Listening |
| End voice conversation | panel closes, in-call CTA gone, mic track `ended`, dictation button idle/enabled, Enable local voice pill returns |
| Server conversation after QA | max seq unchanged (108), no fixture rows present |

## Not verified (needs a human)

- Physical microphone accuracy in the user's Safari/Chrome session (a said-vs-transcribed pair).
- Audible speaker output and no speaker→mic echo loop during a real conversation.
- A real model reply round-trip inside the conversation loop (the browser fixture used a synthetic reply row; the backend chat path itself was verified separately by `local-app-live-smoke --chat` earlier).

## Telegram

Not started. No Telegram code exists in `server/src` or `web/src`. Planned approach: a ZoeyBot-native
channel (Telegram Bot API long-polling in the server, allowlisted chat IDs, mapped to the bot's
canonical conversation so transcripts show in the dashboard), not the isolated Hermes gateway's
own Telegram platform (which would bypass the dashboard store).

## Re-run

```sh
cd /Users/thehound/zoeybot
node --import tsx --test tests/*.test.ts
npm run typecheck
node tests/local-app-live-smoke.mjs --voice
```
