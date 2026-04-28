---
name: verify-architecture
description: Verify ClaudeVille follows its architectural rules - layer structure, adapter pattern, CLAUDE.md conventions, and file organization. Trigger after adding new files, refactoring, or modifying project structure.
---

# Architecture Verification

Verify the ClaudeVille project adheres to its documented architecture and conventions defined in CLAUDE.md.

## Check Items

### 1. Layer Structure

Verify `claudeville/src/` follows the defined layers:

```
src/
├── domain/          (entities, value-objects, events)
├── application/     (managers, services)
├── infrastructure/  (WebSocketClient, data sources)
├── presentation/    (renderers, UI components)
│   ├── character-mode/
│   ├── dashboard-mode/
│   └── shared/
└── config/          (constants, theme, i18n, buildings)
```

- **PASS**: All directories exist with appropriate files
- **WARN**: Empty directories or misplaced files
- **FAIL**: Missing core directories (domain, application, presentation)

### 2. No Framework Dependencies

Verify the project uses pure HTML/CSS/JS at runtime with no runtime npm dependencies:

- `package.json` should not have runtime `dependencies`
- `devDependencies` are allowed for sprite validation, visual diffs, and Playwright capture scripts
- All imports use relative paths or ES modules

- **PASS**: No runtime dependencies
- **WARN**: Dev dependencies changed; confirm they are still development-only
- **FAIL**: Runtime dependencies added without updating README and design decisions

### 3. Adapter Pattern Compliance

Verify `claudeville/adapters/` follows the multi-provider pattern:

- `index.js` exists and acts as registry
- Each adapter (`claude.js`, `codex.js`, `gemini.js`) exports consistent interface
- Adapters detect installed CLIs, not hard-require them

- **PASS**: All adapters present with consistent exports
- **WARN**: Adapter missing but referenced in index.js
- **FAIL**: index.js missing or broken adapter interface

### 4. CSS Convention

Verify no `position: fixed` in CSS files (except modal/toast as per CLAUDE.md rules):

```bash
grep -rn "position.*fixed" claudeville/css/ --include="*.css"
```

Allowed exceptions: `modal.css`, toast-related code

- **PASS**: No violations or only in allowed files
- **FAIL**: `position: fixed` in layout/sidebar/topbar CSS files

### 5. ES Module Consistency

Verify all JS files in `src/` use ES module syntax:

- Files should use `import`/`export`, not `require()`/`module.exports`
- Exception: `server.js` and `adapters/` (Node.js CommonJS)

- **PASS**: All src/ files use ES modules
- **FAIL**: Mixed module systems in src/

### 6. Port Configuration

Verify server port is 4000 as documented in CLAUDE.md:

- `claudeville/CLAUDE.md` mentions port 4000
- `claudeville/server.js` uses `const PORT = 4000`

- **PASS**: Port 4000 documented and configured
- **FAIL**: Port mismatch or not documented

### 7. Widget Integration

Verify widget directory follows the documented structure:

```
widget/
├── Sources/main.swift
├── Resources/
│   ├── widget.html
│   └── widget.css
├── Info.plist
└── build.sh          (must be executable)
```

- **PASS**: All files present, build.sh executable
- **WARN**: widget.html/css exist but are stale (widget uses Swift-generated HTML now)
- **FAIL**: Missing main.swift or build.sh
