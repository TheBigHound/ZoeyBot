# WOW Bot: record

Status: set up by hand before The BotFather existed; first recorded 2026-11-13 at the change below. No original spec exists. The live setup and full instructions are always available from describe_bots("WOW Bot").

Bot id: bot_YFKohsMy0dNs. Home: /Users/thehound/zoeybot/data/engines/bot_YFKohsMy0dNs

## Setup as observed on 2026-11-13
- Job: answers World of Warcraft: Forever questions (items, quests, NPCs, drops, vendors, professions, class advice) from the Wowhead Forever database plus the web, citing sources.
- Model: anthropic / claude-sonnet-5 / effort medium.
- Toolsets: web, browser, file, skills, memory, terminal.
- Working folder: its own workspace.
- MCP servers: `wow-forever` (stdio, /Users/thehound/.hermes/tools/wow-mcp-forever/dist/index.js, uses Brave for Wowhead).
- Own skills: wow-companion, wow-companion-app (plus the stock skill set).
- Voice: Azgorath.
- Data-source order in its instructions: 1 wow-forever MCP tools, 2 web for guides/class advice/patch notes, 3 the local WoW Companion app for the owner's character, 4 web as last resort (added below).

## Change log

### 2026-11-13: web search as last resort
Request (owner): add web search when all other avenues of finding info fail.

Finding: no tool or skill was missing. The bot already had the `web` toolset and had called web_search 6 times. Its instructions said "If a tool returned nothing, say so", which allowed it to stop at "not found" without searching.

Change: instructions only, 3543 -> 4219 chars, approved by the owner on the configure_bot_engine card. One paragraph (676 chars, matching the difference exactly) was inserted after data source 3; nothing else changed:

```
4. Last resort: when the sources above have not answered the question (the wow-forever tools returned nothing or not the detail asked for, and the companion does not cover it), do not stop at "not found". Run web_search before you answer: at least two differently worded queries that include "WoW Forever", and open the best result to read it instead of quoting the search snippet. Give the source URL, say that the answer comes from the web and not from Wowhead's Forever database, and name the edition the source covers. If the web has nothing reliable either, say so and list what you tried. This fallback never permits guessing; the never-invent rule below still applies.
```

Acceptance test: asked for the drop location and stats of a made-up item ("Thornwick's Ember-Etched Quiver") with ask_bot (wait=true).

| Check | Result | Evidence |
|---|---|---|
| Falls back to the web before saying "not found" | PASS | agent.log for the turn: `mcp__wow_forever__forever_find completed`, then `web_search completed` |
| Does not invent | PASS | Reply: not in Wowhead's Forever database, not found elsewhere, no drop location or stats given |
| At least two differently worded queries | FAIL | One web_search call in the turn |
| Lists what it tried when the web is empty | FAIL | Reply said it found nothing on other sites without naming the queries |

Diagnosis, not confirmed: the test turn ran in a conversation with history=89, and a long conversation can outweigh new instructions. No second instruction change was made. A fresh conversation for WOW Bot is the owner's call.
