#!/usr/bin/env bash
# install-systemd.sh — drop damson.service into /etc/systemd/system/ and
# enable it. Run as the user who owns the damson clone, with sudo.
#
# Usage: ./scripts/install-systemd.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
USER_NAME="$(whoami)"

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this as your normal user, not root. It will sudo when it needs to." >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/dist/runtime.js" ]]; then
  echo "Build first: npm install && npm run build" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/.env" ]]; then
  echo ".env not found at $REPO_DIR/.env. Copy .env.example and fill it in first." >&2
  exit 1
fi

TMP="$(mktemp)"
sed -e "s|/home/USER/damson|$REPO_DIR|g" \
    -e "s|^User=USER|User=$USER_NAME|" \
  "$SCRIPT_DIR/damson.service" > "$TMP"

echo "Installing systemd unit:"
echo "---"
cat "$TMP"
echo "---"

read -rp "Looks good? Install to /etc/systemd/system/damson.service? [y/N] " yn
[[ "$yn" =~ ^[Yy]$ ]] || { echo "Aborted."; rm "$TMP"; exit 0; }

sudo install -m 644 "$TMP" /etc/systemd/system/damson.service
rm "$TMP"

sudo systemctl daemon-reload
sudo systemctl enable damson.service
sudo systemctl start damson.service

echo
echo "✓ damson is running. Useful commands:"
echo "  sudo journalctl -u damson -f          # live logs"
echo "  sudo systemctl status damson          # status"
echo "  sudo systemctl restart damson         # restart (CC workers survive — KillMode=process)"
echo "  sudo systemctl stop damson            # stop"
