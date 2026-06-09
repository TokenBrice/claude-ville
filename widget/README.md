# ClaudeVille Widgets

This directory holds the macOS menu-bar widget (this level) and the KDE Plasma widget ([`kde/README.md`](kde/README.md)). Full macOS build/run docs live in the root `README.md` § macOS Menu Bar Widget.

## Which file is the live macOS popover?

`widget/Resources/widget.html` is **not** the live macOS popover surface. There are two surfaces:

- **Native popover (live):** rendered by `buildHTML()` in `widget/Sources/main.swift` and loaded with `webView.loadHTMLString(...)`. To change what the menu-bar popover shows, edit `main.swift` and rebuild.
- **Static resource surface:** `widget/Resources/widget.html` and `widget.css` are served by `claudeville/server.js` at `/widget.html` and `/widget.css`, and are copied into the app bundle by `build.sh`. They are kept for the browser/WebKit smoke checks and the static WebSocket surface. Editing them does not change the native popover.

## Build and run (macOS)

```bash
npm run widget:build   # compiles Sources/main.swift into ClaudeVilleWidget.app
npm run widget         # build + open the app
npm run widget:check   # smoke check
npm run widget:verify-bundle
```
