#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "ClaudeVille Widget 빌드 시작..."

# Swift 컴파일
swiftc Sources/main.swift \
  -framework Cocoa -framework WebKit \
  -o ClaudeVilleWidget

# 기존 .app 제거
rm -rf ClaudeVilleWidget.app

# .app 번들 생성
mkdir -p ClaudeVilleWidget.app/Contents/MacOS
mkdir -p ClaudeVilleWidget.app/Contents/Resources
cp ClaudeVilleWidget ClaudeVilleWidget.app/Contents/MacOS/
cp Info.plist ClaudeVilleWidget.app/Contents/
cp Resources/* ClaudeVilleWidget.app/Contents/Resources/

# 프로젝트 경로 + node 경로 기록 (서버 자동 시작용)
PROJECT_ROOT="$(cd .. && pwd)"
echo "$PROJECT_ROOT" > ClaudeVilleWidget.app/Contents/Resources/project_path
NODE_PATH="$(readlink -f "$(which node)" 2>/dev/null || realpath "$(which node)" 2>/dev/null || which node)"
echo "$NODE_PATH" > ClaudeVilleWidget.app/Contents/Resources/node_path
echo "  프로젝트: $PROJECT_ROOT"
echo "  Node: $NODE_PATH"

rm ClaudeVilleWidget

echo "빌드 완료: ClaudeVilleWidget.app"
