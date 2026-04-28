#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR/claudeville"
PLUGIN_ID="com.honorstudio.claudeville.kde"

KPACKAGETOOL="${KPACKAGETOOL:-$(command -v kpackagetool6 || true)}"
if [ -z "$KPACKAGETOOL" ]; then
  echo "kpackagetool6 was not found. Install KDE Plasma package tools first." >&2
  exit 1
fi

if "$KPACKAGETOOL" --type Plasma/Applet --show "$PLUGIN_ID" >/dev/null 2>&1; then
  "$KPACKAGETOOL" --type Plasma/Applet --upgrade "$PACKAGE_DIR"
else
  "$KPACKAGETOOL" --type Plasma/Applet --install "$PACKAGE_DIR"
fi

if ! "$KPACKAGETOOL" --type Plasma/Applet --show "$PLUGIN_ID" >/dev/null 2>&1; then
  echo "Installed package was not registered as $PLUGIN_ID." >&2
  exit 1
fi

echo "ClaudeVille Plasma widget installed. Add it from Plasma's Add Widgets panel."
echo "If the Add Widgets panel was already open, close and reopen it before searching for ClaudeVille."
