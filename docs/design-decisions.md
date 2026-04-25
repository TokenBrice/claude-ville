# Design Decisions

Short decision records for load-bearing constraints in ClaudeVille. Each entry states what was decided, why, the code reference, and what to update if the decision changes.

## Port 4000 is hardcoded

`claudeville/server.js:22` defines `const PORT = 4000;`. The widget hardcodes the same port at `widget/Sources/main.swift:41-42, 408` and `widget/Resources/widget.html:77, 303`. The README, both `CLAUDE.md` files, and `AGENTS.md` reference it as fixed.

The local-first design assumes one user, one machine, one server. Making the port configurable would force the widget, the embedded `widget.html`, and the docs to learn how to discover it. A constant is simpler and matches user muscle memory.

If you change this, update: `claudeville/server.js`, `widget/Sources/main.swift`, `widget/Resources/widget.html`, README, both `CLAUDE.md` files, and `docs/troubleshooting.md`.

## Zero npm dependencies, no build step

`package.json` declares no `dependencies` and no `devDependencies`. The server uses only Node built-ins (`http`, `fs`, `path`, `crypto`, `https`, `child_process`, `os`). The frontend is plain HTML, CSS, and ES modules served as-is.

This makes the project clone-and-run on any machine with Node 18+. There is nothing to install, no lockfile drift, no transitive CVEs to chase, and no bundler config to maintain. The cost is real: no JSX, no TypeScript, no module aliasing, and a typo in any module breaks page boot at runtime.

If you change this, update: `claudeville/CLAUDE.md` ("no npm dependency install step"), `docs/troubleshooting.md` (the syntax-check guidance), and add the relevant install/build steps to README and the widget script.

## Vanilla ES modules in the browser

The frontend uses `<script type="module">` and relative-path `import`s. There is no bundler.

Same rationale as the previous entry. The constraint this places on the frontend: no JSX, no path aliases, no automatic vendoring of third-party libraries. If a third-party module is needed, vendor a single ES-module file under `claudeville/src/` and import it relatively.

If you change this, update: `claudeville/CLAUDE.md` and the boot path described in `src/presentation/App.js`.

## Read-only adapter contract

The provider session files in `~/.claude/`, `~/.codex/sessions/`, and `~/.gemini/tmp/` are owned by the upstream CLIs. ClaudeVille adapters open them for reading only. `claudeville/CLAUDE.md` states: "Treat all provider session files as read-only inputs" and "Do not mutate local CLI session files."

The CLIs append to these files concurrently and may change their format in any release. Writing back would create races and version drift. The dashboard's correctness depends on never being a second writer.

If you change this, update: every adapter under `claudeville/adapters/`, `claudeville/CLAUDE.md`, and add a clear ownership story in README.

## 2-second polling on top of `fs.watch`

`claudeville/server.js:499-502` runs `setInterval(broadcastUpdate, 2000)` while WebSocket clients are connected. The broadcast no-ops when `wsClients.size === 0` (`claudeville/server.js:450`).

`fs.watch` events are unreliable across platforms (missing events, coalesced events, or no events at all on some filesystems). Polling is the backstop. Two seconds is short enough to feel live and long enough to avoid unnecessary work when the page is open but idle.

If you change this, update: `claudeville/CLAUDE.md` and `docs/troubleshooting.md`.

## `ACTIVE_THRESHOLD_MS` is 2 minutes

`claudeville/server.js:24` defines `const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;`. Sessions older than this are excluded from `/api/sessions`.

Two minutes makes the dashboard feel like "what is happening right now" rather than a session log. Longer windows fill the world with stale agents that no longer reflect anything the user is doing; shorter windows make the world flicker as the upstream CLI pauses between steps.

If you change this, update: `docs/troubleshooting.md` (the empty-sessions diagnosis).

## Static, duplicated pricing tables

Pricing tables live in two places: `claudeville/src/domain/entities/Agent.js:57-75` (used for `agent.cost`) and `claudeville/src/presentation/shared/ActivityPanel.js:215-233` (used by the activity panel). They are static lookups keyed by a substring match on the model name.

The dashboard does not have a billing API key or an authoritative price feed. Hardcoded estimates are good enough for the "is this run getting expensive?" question this UI answers. Prices change rarely.

If a price changes, update both tables. There is no shared source of truth on purpose: the activity panel is a presentation-layer module and the domain entity should not import from `presentation/`.

## Cache token normalization

Different providers report cache hits differently. The adapters normalize them into `cacheRead` and `cacheCreate` fields:

- Claude adapter (`claudeville/adapters/claude.js:215-242`) reads `cache_read_input_tokens` and `cache_creation_input_tokens` from each turn's `usage` and sums them.
- Codex adapter (`claudeville/adapters/codex.js:228-296`) reads `cache_read_input_tokens` / `cacheReadInputTokens` and `cache_creation_input_tokens`. Codex has no separate cache-create concept in some payloads, so `cacheCreate` is set to 0 in those branches.
- Gemini does not currently report cache tokens; the field is left at 0.

If a provider format changes, update only the relevant adapter. The frontend keeps using the normalized shape.

## English-only documentation and UI

The user-facing app exposes a language setting, but project policy keeps documentation and UI strings English. `claudeville/CLAUDE.md:198` defines the validation:

```bash
rg -n -P "\\p{Hangul}" README.md claudeville/CLAUDE.md
```

The Hangul scan exists because earlier revisions of the codebase mixed Korean and English. The rule is now uniform English. Run the scan after edits that touch user-visible copy.

If you change this, update: `claudeville/CLAUDE.md`, `AGENTS.md`, and `docs/swarm-orchestration-procedure.md` ("Visible docs or locale-sensitive copy changes").

## Hand-written WebSocket framing

`claudeville/server.js:267-414` implements RFC 6455 directly: the handshake (`handleWebSocketUpgrade`), frame parser (`handleWebSocketFrame`), and frame builder (`createWebSocketFrame`).

The zero-dependency rule rules out `ws` and similar packages. Browser clients only need text frames, ping/pong, and clean close, so a couple of hundred lines of framing code is cheaper than a transitive dependency.

If you change this, audit close handling, masking, and the 64-bit length path before swapping in a library.

## Multi-agent shared checkout

The repo is meant to be edited by several agents in parallel. `claudeville/CLAUDE.md` calls this out and `docs/swarm-orchestration-procedure.md` defines the workflow. The discipline:

- Run `git status --short` before and after edits.
- Do not revert or absorb unrelated changes.
- Do not run destructive git or shell commands without explicit approval.

This avoids accidental rollback when one agent integrates work and another is mid-edit.

If you change this, update: `claudeville/CLAUDE.md`, `AGENTS.md`, `docs/swarm-orchestration-procedure.md`.

## macOS-only widget

`widget/Sources/main.swift` builds a Cocoa `NSStatusItem` with a `WKWebView` popover and is compiled by `swiftc`. `widget/build.sh` produces a `.app` bundle.

A status-bar app is the most native, lowest-friction surface for "is the dashboard alive?" on macOS. A cross-platform widget would mean Electron or Tauri, which would break the no-dependencies rule and add a build pipeline. Linux and Windows users open the dashboard at `http://localhost:4000` directly; that path is fully supported.

If you add a Linux or Windows widget, expect a parallel implementation under `widget-linux/` or similar; do not couple it to the Swift code.

## Polling cadence: 2s server, 2s panel, 3s widget

- Server broadcast: every 2 seconds when clients are connected (`claudeville/server.js:499-502`).
- Activity panel detail fetch: every 2 seconds for the selected agent (`claudeville/src/presentation/shared/ActivityPanel.js:99`).
- Widget HTTP poll: every 3 seconds (`widget/Sources/main.swift:35`).

Server and panel match because both serve the live dashboard. The widget is a glance surface, so it polls less often to save battery and CPU.

If you change any of these, also revisit `ACTIVE_THRESHOLD_MS` (the active-session window must stay strictly larger than the slowest poll, or sessions will visibly flicker in and out).

## Domain layer must not import from presentation

`Agent.js` lives at `claudeville/src/domain/entities/`. It imports from `value-objects/` and `config/i18n.js` only. The presentation-layer pricing duplication exists because the alternative would be a domain entity importing from `src/presentation/`, which would invert the layering.

If you refactor pricing into a single source, place it under `src/domain/` (for example `src/domain/pricing.js`) and let the presentation layer import from there.
