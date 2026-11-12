#!/bin/bash
set -euo pipefail
sudo cloud-init status --wait
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y --no-install-recommends -o DPkg::Lock::Timeout=120 \
  xvfb x11vnc websockify openbox xdotool xclip x11-utils x11-xserver-utils imagemagick \
  python3 python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common wmctrl dbus-x11 \
  fonts-inter fonts-dejavu-core xterm pcmanfm curl ca-certificates chromium-browser
sudo mkdir -p /opt/hq /root/zoeybot/files
printf '\nGuest dependencies installed.\n'
command -v Xvfb x11vnc websockify openbox chromium-browser
chromium-browser --version
