---
name: verify-widget-build
description: Verify macOS menu bar widget builds correctly and app bundle structure is valid. Trigger after any changes to widget/ directory files (main.swift, build.sh, Info.plist, widget.html, widget.css).
---

# Widget Build Verification

Verify the ClaudeVille macOS menu bar widget compiles, produces a valid .app bundle, and all required resources are present.

## Prerequisites

- Xcode Command Line Tools installed (`xcode-select -p`)
- Node.js available (for server dependency)

## Check Items

### 1. Swift Compilation

Run the widget build script and verify it compiles without errors:

```bash
cd widget && bash build.sh
```

- **PASS**: Exit code 0, "Build complete: ClaudeVilleWidget.app" message printed
- **FAIL**: Compilation errors or non-zero exit code

### 2. App Bundle Structure

Verify the .app bundle contains all required files:

```
widget/ClaudeVilleWidget.app/
├── Contents/
│   ├── MacOS/ClaudeVilleWidget    (executable, must be executable)
│   ├── Info.plist                  (must contain LSUIElement=true)
│   └── Resources/
│       ├── widget.html
│       ├── widget.css
│       ├── project_path           (must contain valid path)
│       └── node_path              (must contain valid node binary path)
```

- **PASS**: All files exist with correct content
- **WARN**: project_path or node_path points to non-existent location
- **FAIL**: Missing executable, Info.plist, or HTML/CSS resources

### 3. Info.plist Validity

Parse Info.plist and verify required keys:

- `LSUIElement` = true (menu bar app, no Dock icon)
- `CFBundleExecutable` = "ClaudeVilleWidget"
- `NSHighResolutionCapable` = true
- `NSAppTransportSecurity.NSAllowsLocalNetworking` = true

- **PASS**: All keys present and correct
- **FAIL**: Missing or incorrect key values

### 4. Node Path Resolution

Verify the recorded node_path is a real binary (not an fnm temp symlink):

```bash
cat widget/ClaudeVilleWidget.app/Contents/Resources/node_path
```

- **PASS**: Path exists AND does NOT contain `fnm_multishells` (permanent path)
- **WARN**: Path exists but contains `fnm_multishells` (temporary, will break on restart)
- **FAIL**: Path does not exist

### 5. Port Configuration Consistency

Verify port 4000 is used consistently across all files:

- `claudeville/server.js`: `const PORT = 4000`
- `widget/Sources/main.swift`: all localhost references use port 4000
- `widget/Resources/widget.html`: WS_URL uses port 4000

- **PASS**: All files use port 4000
- **FAIL**: Any file uses a different port (e.g., 3000)
