---
name: verify-architecture
description: Verify ClaudeVille layer structure, adapter registration, zero-build runtime boundaries, CSS overlay allowlists, module conventions, and documented server configuration. Trigger after adding files, refactoring, or changing project structure.
---

# Architecture Verification

Verify the project against `AGENTS.md`, `claudeville/CLAUDE.md`, and the implementation sources named below.

## 1. Layer Structure

Confirm `claudeville/src/` contains `domain/`, `application/`, `infrastructure/`, `presentation/`, and `config/`. Presentation contains `character-mode/`, `dashboard-mode/`, and `shared/`; configuration includes `i18n.js`.

- **PASS**: Core layers exist and files match their responsibilities.
- **WARN**: A file appears misplaced or a non-core directory is unexpectedly empty.
- **FAIL**: A core layer is missing.

## 2. Zero-Build Runtime

Confirm `package.json` has no runtime `dependencies`. Development-only tooling may remain in `devDependencies`; Node tooling must not import `claudeville/vendor/*`.

- **PASS**: Runtime remains dependency-free vanilla JavaScript.
- **WARN**: Development dependencies changed; confirm they stay outside runtime paths.
- **FAIL**: A runtime dependency, framework, bundler, or required build step was introduced.

## 3. Adapter Registration

Read `claudeville/adapters/index.js` as the registry. It currently registers `claude.js`, `codex.js`, `gemini.js`, `grok.js`, `kimi.js`, `opencode.js`, and `omp.js`.

- **PASS**: All seven registry entries resolve to adapters with the expected interface and optional CLI detection.
- **WARN**: An adapter file is intentionally helper-only; confirm it is not a provider implementation.
- **FAIL**: A provider adapter is unregistered, missing, or hard-requires its CLI.

## 4. Fixed-Position CSS Allowlist

```bash
rg -n 'position:\s*fixed' claudeville/css
```

Allowed selectors are `.first-run-hint` and `.world-grammar` in `character.css`, `.toast-container` in `layout.css`, `.modal-overlay` in `modal.css`, and `.topbar__connection-panel` plus `.topbar__spend-panel` in `topbar.css`. These are intentional first-run/grammar overlays, toasts, modals, and connection/spend overlays.

- **PASS**: Every hit is one of the listed file/selector pairs.
- **WARN**: An intentional overlay needs a new fixed selector; document why before extending the allowlist.
- **FAIL**: Fixed positioning appears in ordinary page, world, dashboard, sidebar, or topbar layout.

## 5. Module Boundaries

Use `rg -n 'require\(|module\.exports' claudeville/src` to check that browser `src/` remains ES modules. CommonJS is expected in `server.js` and `adapters/`.

- **PASS**: Browser source uses `import`/`export`; Node CommonJS stays outside `src/`.
- **WARN**: A compatibility file has an explicit documented reason for different syntax.
- **FAIL**: Module systems are mixed accidentally in browser source.

## 6. Server Configuration

Confirm `claudeville/server.js` keeps the documented port constant and loopback binding, without starting or probing any server.

- **PASS**: Code and documentation agree on port 4000 and loopback-only access.
- **WARN**: An intentional configuration change needs matching documentation and smoke updates.
- **FAIL**: The implementation and documented server contract disagree.
