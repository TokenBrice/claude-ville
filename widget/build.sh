#!/bin/bash
set -e

cd "$(dirname "$0")"

resolve_path() {
  local target="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$target"
  elif command -v perl >/dev/null 2>&1; then
    perl -MCwd=realpath -e 'print realpath($ARGV[0])' "$target"
  elif command -v realpath >/dev/null 2>&1; then
    realpath "$target"
  else
    printf '%s\n' "$target"
  fi
}

echo "Starting ClaudeVille Widget build..."

# Compile Swift
swiftc Sources/main.swift \
  -framework Cocoa -framework WebKit \
  -o ClaudeVilleWidget

# Remove existing .app
rm -rf ClaudeVilleWidget.app

# Create .app bundle
mkdir -p ClaudeVilleWidget.app/Contents/MacOS
mkdir -p ClaudeVilleWidget.app/Contents/Resources
cp ClaudeVilleWidget ClaudeVilleWidget.app/Contents/MacOS/
cp Info.plist ClaudeVilleWidget.app/Contents/
cp Resources/* ClaudeVilleWidget.app/Contents/Resources/

# Record project and node paths for automatic server startup
PROJECT_ROOT="$(cd .. && pwd)"
echo "$PROJECT_ROOT" > ClaudeVilleWidget.app/Contents/Resources/project_path
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "widget: node not found on PATH" >&2
  exit 1
fi
NODE_PATH="$(resolve_path "$NODE_BIN")"
echo "$NODE_PATH" > ClaudeVilleWidget.app/Contents/Resources/node_path
echo "  Project: $PROJECT_ROOT"
echo "  Node: $NODE_PATH"

rm ClaudeVilleWidget

echo "Build complete: ClaudeVilleWidget.app"
