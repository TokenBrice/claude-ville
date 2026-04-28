# Integration Troubleshooting

### macOS Menu Bar Widget WKWebView WebSocket Connection Failure [#1]

- **Symptom**: Loading `widget.html` in the NSPopover `WKWebView` and then connecting to `ws://localhost:4000` fails. Loading `http://localhost:4000` in the same app's NSWindow `WKWebView` works. The menu bar badge flickers from `* 3` to `* 0`.
- **Cause**:
  1. Out-of-process `WKWebView` rendering requires a `com.apple.security.network.client` entitlement.
  2. The single-file `swiftc` build does not use Xcode's entitlement system.
  3. `loadFileURL` from `file://` blocks `ws://`; `loadHTMLString(baseURL: localhost)` still blocks it.
  4. Adding `NSAllowsLocalNetworking` / `NSAllowsArbitraryLoadsInWebContent` to `Info.plist` did not fix the popover case.
  5. The JS-to-Swift badge bridge (`webkit.messageHandlers.badge`) overwrote Swift polling results with `0` after WebSocket failure.
- **Fix**: Use `WKWebView` as a render surface only and remove WebSocket use from the native popover:
  1. Call `/api/sessions` and `/api/usage` directly from Swift with `URLSession` on a timer.
  2. Build the HTML string in Swift from the response JSON (`buildHTML()`).
  3. Use `webView.loadHTMLString(html, baseURL: nil)`, with no network from the popover web content.
  4. Update the badge only from Swift.
  5. Keep `webkit.messageHandlers.openDashboard` only for the Open Dashboard button.
- **Files**: `widget/Sources/main.swift`, `widget/Info.plist`
- **Date**: 2026-02-23
- **Tags**: macOS, WKWebView, NSPopover, NSStatusItem, WebSocket, swiftc, entitlement, menu bar, widget

---

### Server Autostart Failure From Temporary fnm Node Path [#2]

- **Symptom**: The menu bar widget cannot autostart the server. The Node path recorded at build time no longer exists when the app is relaunched.
- **Cause**: `which node` returned an fnm temporary multishell path (`~/.local/state/fnm_multishells/{PID}_{TIMESTAMP}/bin/node`). That path changes per shell session, so recording it in the app bundle makes the next launch stale.
- **Fix**: `build.sh` records the resolved stable path with `readlink -f "$(which node)"`. Example stable path: `~/.local/share/fnm/node-versions/v20.20.0/installation/bin/node`. Swift also falls back to scanning `~/.local/share/fnm/node-versions/*/installation/bin/node`.
- **Files**: `widget/build.sh`, `widget/Sources/main.swift`
- **Date**: 2026-02-23
- **Tags**: fnm, node, readlink, symlink, macOS, autostart, build.sh

---

### `Process()` Running `lsof` Hangs Inside macOS App [#3]

- **Symptom**: In `applicationDidFinishLaunching`, running `/usr/bin/lsof -ti :4000` through `Process()` and then calling `waitUntilExit()` never returns.
- **Cause**: `lsof` can hang in the security context of an LSUIElement menu bar app launched from Finder or Spotlight.
- **Fix**: Remove the `lsof` port-check path. Let `server.js` report `EADDRINUSE` when a duplicate server start is attempted, and ignore the failed start attempt with the existing `try? proc.run()` pattern.
- **Files**: `widget/Sources/main.swift`
- **Date**: 2026-02-23
- **Tags**: macOS, Process, lsof, waitUntilExit, hang, LSUIElement
