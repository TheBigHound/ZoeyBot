#!/bin/bash
# Signs Zoey's private engine (data/primary-hermes) in to a Claude Pro/Max subscription.
# This does NOT touch your main Hermes (~/.hermes). Paste the code from claude.ai when prompted.
H=/Users/thehound/zoeybot/data/primary-hermes
exec env -i HOME="$HOME" USER="$USER" LANG=en_US.UTF-8 TERM="${TERM:-xterm}" \
  PATH="$H/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  HERMES_HOME="$H" "$H/runtime-hermes" auth add anthropic --type oauth --timeout 600
