#!/usr/bin/env bash
# Runs on your Mac: ships the committed code and node_modules to the VPS and
# (re)starts the service. Uncommitted changes are NOT shipped.
set -euo pipefail
HOST=${HOST:?set HOST=user@your-vps, e.g. HOST=root@1.2.3.4 ./deploy/push.sh}
KEY=${KEY:-$HOME/.ssh/meridian_vps}
SSH="ssh -i $KEY -o BatchMode=yes"
cd "$(dirname "$0")/.."

# Preflight: check the live settings against the new start-up rules before touching anything.
# On failure nothing is copied and the running version keeps serving.
git archive --format=tar HEAD lib/gate.js deploy/preflight.mjs | $SSH "$HOST" \
  'd=$(mktemp -d) && tar -x -C "$d" && node "$d/deploy/preflight.mjs" /etc/emisiq/env; r=$?; rm -rf "$d"; exit $r' \
  || { echo "Deploy stopped: fix /etc/emisiq/env on the server (see above). Nothing was changed."; exit 1; }

$SSH "$HOST" 'mkdir -p /opt/emisiq /etc/emisiq'
git archive --format=tar HEAD | $SSH "$HOST" 'tar -x -C /opt/emisiq'
[ -d node_modules ] && rsync -az --delete -e "$SSH" node_modules/ "$HOST:/opt/emisiq/node_modules/"
$SSH "$HOST" 'set -e
  install -m 644 /opt/emisiq/deploy/emisiq.service /etc/systemd/system/emisiq.service
  chown -R root:root /opt/emisiq && chmod -R a+rX /opt/emisiq
  [ -f /etc/emisiq/env ] && chown root:meridian /etc/emisiq/env && chmod 640 /etc/emisiq/env
  systemctl daemon-reload
  systemctl enable --now emisiq >/dev/null
  systemctl restart emisiq
  sleep 1
  systemctl is-active emisiq'
