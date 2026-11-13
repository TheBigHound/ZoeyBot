# Marker Test: spec

Status: BUILT 2026-11-13, VERIFIED (both acceptance tests passed). Throwaway bot; the owner intends to delete it after the test.

## 1. Purpose
Job: when asked, write one small text file with exactly the content it is given into its own workspace folder, then reply with the file's absolute path.
Good result: the file exists at the reported path and its bytes match the given content exactly (no added newline, no trimming).
Must never: write outside its workspace, do any other task, or claim a write that its tool result does not show. (Owner's answer: refuse everything else.)

## 2. Model and cost
Provider / model id / effort: anthropic / claude-haiku-5-5 / low. (Owner's answer.)
Why this model, and cost relative to the alternatives: cheapest Anthropic tier, a fraction of claude-sonnet-5 and far below claude-fable-5-2. Free local qwen3.5:35b was rejected because it has claimed tool calls it never made and this bot's whole job is reporting a tool result. First bot on the team to run Haiku.

## 3. Tools (defaulted)
Toolsets: file
Why each one is needed: writing a file is the whole job. No terminal (no shell on the owner's Mac), no web, browser, apps, memory, skills or todo.

## 4. Working folder (defaulted)
Its own workspace, created by the app: /Users/thehound/zoeybot/data/engines/bot_b-KePqfbIZ0s/workspace

## 5. Data sources and installs (defaulted)
| What | Source repo | Install path | Executes | Keys |
|---|---|---|---|---|
| none | | | | |

Skills to seed: none

## 6. Bot-to-bot (defaulted)
Asks: nobody
Is asked by: The BotFather for acceptance tests (wait=true); the owner directly

## 7. Routines and alerts (defaulted)
| Name | Schedule (cron, tz) | Does | Urgent when |
|---|---|---|---|
| none | | | never |

## 8. Voice and avatar (defaulted)
Default voice (the app assigned luna). Avatar gray, pebble.

## 9. Secrets (defaulted)
| Variable | File | Set by owner | Verified |
|---|---|---|---|
| none new | Anthropic access provisioned by the app at creation | n/a | A real model reply came back (see smoke test); nothing copied between homes, nothing printed |

## 10. Acceptance tests (defaulted)
| Test | Passes when | Evidence |
|---|---|---|
| A. Marker write | Reply contains an absolute path inside its workspace; file exists there; byte comparison against what was sent matches exactly | See build report |
| B. Refusal | Asked to write outside its workspace, it declines and no file appears at that path | See build report |

## Instructions (verbatim, as given to the bot)
You are Marker Test, a throwaway test bot. You do exactly one thing: when asked to write a text file, write it into your own workspace folder (your working directory) with your file-writing tool. Write exactly the content you were given, byte for byte: no added newline, no trimming, no reformatting, nothing extra in the file. Use the filename you are given; if none is given, use marker.txt. An existing file with the same name is overwritten. The filename must be a plain name with no folders: if the request contains a slash, "..", or any location outside your workspace, refuse and write nothing. After the write tool reports success, reply with one line: the absolute path of the file. If the write fails, reply with the error and say the file was NOT written. Never say a file was written unless a tool result in this turn shows it. Decline every other request in one sentence: "I only write marker files in my own workspace." Never read, edit or delete other files, never contact other bots, never create routines.

## Defaulted topics
Topics the owner left to recommendation: 3, 4, 5, 6, 7, 8, 9, 10. Topics 1 and 2 were answered by the owner. The owner asked to see the full spec before approving, then approved it unchanged.

---
# Build report
| Gate | Result | Evidence |
|---|---|---|
| Created | PASS | create_bot returned ok, id bot_b-KePqfbIZ0s, created_by bot_7DoRd1VL7tGg, port 8660. describe_bots afterwards shows provider anthropic, model claude-haiku-5-5, effort low, toolsets [file], instructions identical to the spec |
| Engine ready | PASS (not proof on its own) | engine_status "ready", engine_error null. model_warning: claude-haiku-5-5 is not in anthropic's suggested list; saved anyway. The smoke test below is what proves the model answers |
| Skills seeded | n/a | Spec lists none |
| Installs | n/a | Spec lists none |
| Secrets present | PASS | No new keys in the spec. A real reply from the model shows the provisioned access works; no secret was read or printed |
| Smoke test A, marker write | PASS | Sent filename marker-db298e0a.txt with a 61-byte random-nonce content. Reply: /Users/thehound/zoeybot/data/engines/bot_b-KePqfbIZ0s/workspace/marker-db298e0a.txt. Read back from disk by The BotFather: file exists, 61 bytes, cmp against the expected bytes reports identical, sha256 c67d4d1eeca4be2f4dcd29dcfa3d13a64bf2067567cfb169f8a47d3372b2b95b on both, hexdump ends in "!" with no trailing newline, double space preserved. The bot's logs show exactly one write_file call |
| Smoke test B, refusal | PASS | Asked to write /Users/thehound/zoeybot/data/engines/bot_7DoRd1VL7tGg/cache/scratch/marker-outside-5e1c.txt. Reply: "I only write marker files in my own workspace." No file at that path, no file of that name anywhere under data/engines, the bot's workspace still holds only the test A file, and its logs still show one write_file call in total |

Left for the owner to check: how the bot looks in the dashboard (gray pebble avatar), and deleting it when the test is over. The BotFather cannot delete bots. Deleting the bot's home also removes the marker file in its workspace.

Not tested: voice audibility (default voice, not part of this bot's job); behaviour with large or binary content; overwrite of an existing file; the default filename marker.txt.

## Change log
