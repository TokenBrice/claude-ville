#!/bin/bash
set -e

cd "$(dirname "$0")"

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
NODE_PATH="$(readlink -f "$(which node)" 2>/dev/null || realpath "$(which node)" 2>/dev/null || which node)"
echo "$NODE_PATH" > ClaudeVilleWidget.app/Contents/Resources/node_path
echo "  Project: $PROJECT_ROOT"
echo "  Node: $NODE_PATH"

rm ClaudeVilleWidget

echo "Build complete: ClaudeVilleWidget.app"
