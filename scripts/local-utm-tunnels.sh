#!/bin/bash
set -euo pipefail
VM_DIR="${BOT_HQ_VM_DIR:-$HOME/VirtualMachines/BotHQ}"
KEY="${HQ_VM_KEY:-$HOME/.ssh/bot-hq-utm}"
KNOWN="${HQ_VM_KNOWN_HOSTS:-$VM_DIR/ssh_known_hosts}"
args=(-NT -p 2222 -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o "UserKnownHostsFile=$KNOWN" -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=2)
for port in 6099 6100 6101 6102 9299 9300 9301 9302; do
  args+=(-L "127.0.0.1:$port:127.0.0.1:$port")
done
exec /usr/bin/ssh "${args[@]}" bot@127.0.0.1
