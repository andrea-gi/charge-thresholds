#!/bin/bash
# Installs or removes the Cinnamon applet for the current user (no sudo).
#   ./install-applet.sh install     # symlink into ~/.local/share/cinnamon/applets
#   ./install-applet.sh uninstall
# The applet is symlinked, so edits in this repo take effect after a reload.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
UUID=$(basename "$HERE"/applet/*@*)   # the applet folder name is its UUID
SRC=$HERE/applet/$UUID
DEST_DIR=$HOME/.local/share/cinnamon/applets
DEST=$DEST_DIR/$UUID

[[ $EUID -ne 0 ]] || { echo "Run this as your normal user, not with sudo." >&2; exit 1; }

reload() {
    dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon \
        org.Cinnamon.ReloadXlet string:"$UUID" string:'APPLET' 2>/dev/null || true
}

case ${1:-} in
    install)
        mkdir -p "$DEST_DIR"
        ln -sfn "$SRC" "$DEST"
        reload
        echo "Linked $DEST -> $SRC"
        echo "Add it via: right-click panel -> Applets -> \"Battery Charge Limit\"."
        ;;
    uninstall)
        rm -f "$DEST"
        echo "Removed $DEST (remove it from the panel too if it is still shown)."
        ;;
    *) echo "Usage: $0 install|uninstall" >&2; exit 2 ;;
esac
