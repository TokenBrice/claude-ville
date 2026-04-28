#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="com.honorstudio.claudeville.kde"

KPACKAGETOOL="${KPACKAGETOOL:-$(command -v kpackagetool6 || true)}"
if [ -z "$KPACKAGETOOL" ]; then
  echo "kpackagetool6 was not found. Install KDE Plasma package tools first." >&2
  exit 1
fi

"$KPACKAGETOOL" --type Plasma/Applet --remove "$PLUGIN_ID"
echo "ClaudeVille Plasma widget removed."
