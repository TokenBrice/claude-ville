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

if "$KPACKAGETOOL" --type Plasma/Applet --list 2>/dev/null | grep -Fq "$PLUGIN_ID"; then
  "$KPACKAGETOOL" --type Plasma/Applet --upgrade "$PACKAGE_DIR"
else
  "$KPACKAGETOOL" --type Plasma/Applet --install "$PACKAGE_DIR"
fi

echo "ClaudeVille Plasma widget installed. Add it from Plasma's Add Widgets panel."
