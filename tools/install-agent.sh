#!/bin/sh
set -eu
BASE=/var/opt/mgu-chatgpt-bridge
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "${1:-install}" in
  install)
    [ "$(id -u)" = 0 ] || { echo 'Root required'; exit 1; }
    command -v node >/dev/null
    command -v systemctl >/dev/null
    mkdir -p "$BASE/releases/0.1.0/agent" "$BASE/releases/0.1.0/shared" "$BASE/data"
    chmod 700 "$BASE/data"
    cp "$SOURCE/agent/agent.js" "$SOURCE/agent/executor.js" "$SOURCE/agent/network-worker.js" "$BASE/releases/0.1.0/agent/"
    cp "$SOURCE/shared/protocol.js" "$BASE/releases/0.1.0/shared/"
    cp "$SOURCE/native/chatgpt-bridge/mgu-chatgpt-bridge" "$BASE/releases/0.1.0/"
    cp "$SOURCE/agent/config.example.json" "$BASE/releases/0.1.0/"
    chmod 755 "$BASE" "$BASE/releases" "$BASE/releases/0.1.0" "$BASE/releases/0.1.0/agent" "$BASE/releases/0.1.0/shared" "$BASE/releases/0.1.0/mgu-chatgpt-bridge"
    chmod 644 "$BASE/releases/0.1.0/agent/"*.js "$BASE/releases/0.1.0/shared/"*.js
    if [ ! -f "$BASE/config.json" ]; then cp "$SOURCE/agent/config.example.json" "$BASE/config.json"; fi
    chmod 600 "$BASE/config.json"
    ln -sfn "$BASE/releases/0.1.0" "$BASE/current"
    cp "$SOURCE/native/chatgpt-bridge/mgu-chatgpt-bridge.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable mgu-chatgpt-bridge.service
    systemctl restart mgu-chatgpt-bridge.service
    echo 'Installed. Pair from your private portal; config.json is preserved on reinstall.'
    ;;
  uninstall)
    systemctl stop mgu-chatgpt-bridge.service || true
    systemctl disable mgu-chatgpt-bridge.service || true
    rm -f /etc/systemd/system/mgu-chatgpt-bridge.service
    systemctl daemon-reload
    echo 'Service removed. Private configuration and results remain in /var/opt/mgu-chatgpt-bridge for deliberate cleanup.'
    ;;
  *) echo 'Usage: sh tools/install-agent.sh install|uninstall'; exit 2;;
esac
