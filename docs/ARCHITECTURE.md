# Architecture

A web app (`web/`) and a Node server (`server/`) sit in front of Hermes agents. Hermes owns each Bot's agent loop, history, memory and model. The server adds the things Hermes does not have: the chat interface, connected apps with approvals, routines, the Library, Telegram, and voice. Everything runs on the owner's Mac (`HQ_HOST=1`): one Hermes home per Bot, no VM and no remote computer.

```text
browser ── HTTP + SSE ──► server ── POST /v1/responses ──► Hermes gateway (one per Bot, on this Mac)
                            ▲                                   │
                            └──────── MCP: POST /mcp/<bot> ─────┘
```

## Components

| Piece | Where | What it does |
|---|---|---|
| API + realtime | `server/src/routes*.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream per user (`GET /api/events`) carrying row updates, live state and roster changes |
| Turns | `server/src/agent/loop.ts` | Per-Bot serial queue. A turn posts the message to the Bot's Hermes gateway (`/v1/responses`, streaming) and turns the event stream into rows (messages, tool calls) and live state (what the Bot is doing now) |
| Engines | `server/src/engine.ts` | Which Hermes runs which Bot. The **primary** engine is the gateway of `data/primary-hermes`, started by `scripts/local-services.py`; the app only calls its API. A **managed** engine is a Hermes home under `ENGINES_DIR/<botId>` with its own `hermes gateway run`, its own port (from 8650), credentials, model, working directory, toolset allowlist and browser helper (`BH_HOME`). Also: model and provider settings. Subscription sign-ins happen in the owner's own Terminal (`scripts/zoey-claude-login.sh`); the app only shows the command |
| App tools | `server/src/mcp.ts`, `agent/tools.ts` | An MCP endpoint per Bot (`POST /mcp/<botId>`, `POST /mcp/primary`; bearer token derived from `SESSION_SECRET`). Tools: `x_search`, `save_file`, routines, tasks, check-ins, `ask_bot`, group chats, `ask_user`, `request_app_connection`, plus the user's Composio tools |
| Memory | `server/src/engine-memory.ts` | Memory lives in each Bot's Hermes home (`memories/MEMORY.md`, `USER.md`). The app shows the entries and lets the user remove one |
| Library | `agent/tools.ts` (`save_file`, `libraryPath`), `routes-config.ts` (`/bots/:id/files*`) | Each Bot's deliverables live in `<Hermes home>/library` on this Mac (`data/primary-hermes/library` for Zoey). Every path is resolved inside that folder, links followed first; anything that lands outside is refused |
| Apps | `server/src/composio.ts`, `triggers.ts` | Catalog, per-user sessions, connect links, tool execution, and triggers for event routines. Sign-in uses a Composio-managed Google connection |
| Scheduling | `server/src/routines.ts`, `proactive.ts` | Cron routines, event routines, and check-ins for the primary Bot. Each run is a turn |
| Telegram | `server/src/telegram.ts`, `channels-status.ts`, `routes-channels.ts` | A ZoeyBot channel, not the engine's own Telegram platform. The server long-polls `getUpdates` (offset kept in the `kv` table) and accepts text only from chats listed in `TELEGRAM_ALLOWED_CHAT_IDS`; everything else is dropped silently. An allowed message is appended to Zoey's (the primary Bot's) conversation as a user row (`via: 'telegram'`), runs through the same turn queue as the web composer, and the reply of that turn goes back to the same chat. Outbound: when any Bot finishes a **routine** turn whose first non-empty line starts with `URGENT`, the reply is forwarded to every allowlisted chat as `⚠️ <Bot> · <routine>`; digests without that flag stay in the dashboard. Env: `TELEGRAM_BOT_TOKEN` (from @BotFather, never logged), `TELEGRAM_ALLOWED_CHAT_IDS` (comma list), `TELEGRAM_NOTIFICATIONS=0` turns the URGENT forwarding off (inbound chat still works). `GET /api/channels` reports configured/username/allowlist/polling without the token |
| Voice | `server/src/voice.ts`, `local-voice.ts`, `web/src/voice/*` | Local phonon TTS and Whisper STT in host mode (read-aloud and dictation). The xAI realtime path remains only when `XAI_API_KEY` is set and `VOICE_PROVIDER` is not `local` |
| UI | `web/src` | React + zustand. Sidebar, chat with a "thinking" chip that follows the Bot's activity, details panel (identity line with cwd and model, activity, tasks, Library, engine), settings, voice bar |

## The primary engine

The first Bot (Zoey) is bound to the gateway of `data/primary-hermes`, which `scripts/local-services.py` starts as its own launchd job. The rules:

- The app never restarts it, stops it, or writes its `config.yaml`; that home is configured with `runtime-hermes config set`. Its `mcp_servers.hq` entry points at `POST /mcp/primary`.
- Its other sessions (Telegram, cron) see the same tools. When one of those sessions calls a tool that needs approval, the card shows up in the app.

## Browsers

Hermes' browser tool finds its helper process under `BH_HOME`. Every managed gateway gets its own, otherwise all agents on the Mac would drive one browser. No bot uses the owner's signed-in Chrome profile (`browser.use_real_profile: false`).

Hermes can also run a private virtual screen ("Bot Desktop") for an agent's computer-use tool; the engine panel reports this and offers a button to switch it off.

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`. A streaming reply is the same row rewritten with a higher `updatedSeq`, so clients upsert by `seq`. A per-Bot `generation` counter starts a new conversation (and a new Hermes session).

Row kinds: `message` (user or assistant, optionally from another Bot or a voice call), `tool-call` (shown as an activity line and a collapsible step list), `card` (approval, question, connect, draft), `event`, `notice`.

The model's own history is Hermes' business; the app keeps only what it shows.

## Approvals

Approvals happen inside the MCP call, so they work the same for every engine:

- Composio tools that only read run at once.
- Anything else posts an **approval card** and the tool call waits. **Allow** runs it once, **Always allow** stores a per-tool policy, **Don't allow** returns a refusal that tells the agent not to retry.
- A new user message, or no answer in time, closes the card and the call returns "skipped".

Not covered: what a Bot does through its browser or shell, and Hermes' own prompts for risky commands.

## Bots working together

- **`ask_bot(bot_name, request, wait)`** is the one bot-to-bot tool. The request is posted into the target's conversation as a message from the asker and runs as a turn of its own (`Trigger` type `ask`), so the exchange shows in both chats.
  - `wait=true` (default; questions, quick jobs): the tool call blocks until the target's turn ends and returns what it wrote as the tool result. After 15 minutes the call returns anyway and the ask falls back to the `wait=false` path.
  - `wait=false` (long work): a task is created on the target (title = the request) and the call returns at once with the task id. When the target's turn ends, the server posts its reply into the asker's chat as a message from the target, marks the task done with the reply as note, and gives the asker a new turn (`Trigger` type `bot`). The model never has to remember to report back.
  - The target is told who asked and that its final reply is delivered by itself; it must not answer with `ask_bot` or call `stay_silent`.
  - Guards: no asking yourself or a group chat, at most 3 hops (each ask runs the target one hop deeper), and an ask that would wait on a bot that is itself waiting on you is queued as `wait=false` instead of deadlocking the two serial queues.
- **Group chats** are a Bot row with `kind='room'` and a member list. A user message goes to the @mentioned members, or to all of them (up to 3), who answer with `post_to_group`.
- **Subagents** are hidden child Bots that report back to their parent with `ask_bot(parent, result, wait=false)`.
- For work inside one task, Hermes' own delegation is used.

## Data

SQLite (`DB_PATH`, WAL): users and sessions, Bots, rows, approvals and policies, routines, tasks, skills, Composio session ids (the old `computers`/`screens` tables stay in the schema, unused). Each managed Bot's Hermes home, including its `library` folder and browser helper, is under `ENGINES_DIR`; Zoey's is `data/primary-hermes`. Deleting a managed Bot removes its gateway and its whole home.

Secrets live in `.env` on the server and in each Hermes home.

## External services

| Service | Used for |
|---|---|
| Hermes Agent | The agent loop, tools, memory and model access for every Bot (API keys or subscription sign-ins) |
| Composio | Sign-in, connectors, triggers |
| xAI (optional) | Research on X (`x_search`); the cloud voice path when local voice is not used |
