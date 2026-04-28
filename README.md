# ClaudeVille

ClaudeVille is a local dashboard for AI coding agent activity. It reads session files from Claude Code, OpenAI Codex CLI, and Google Gemini CLI, normalizes them into a shared session model, and displays them in either an isometric RPG-style world or a dense monitoring dashboard.

The app is intentionally small: a zero-dependency Node.js HTTP/WebSocket server, static browser assets, vanilla ES modules, Canvas 2D rendering, and an optional macOS menu bar widget.

## Quick Start

```bash
npm run dev
```

Open `http://localhost:4000`.

Runtime is dependency-free: `npm run dev` uses only Node built-ins and static browser files. The repo also has a `package-lock.json` and dev dependencies for sprite validation, visual diffs, and Playwright-based capture scripts; run `npm install` only when those development scripts are needed.

`package.json` defines:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start `claudeville/server.js` on port `4000`. |
| `npm run widget:build` | Compile the optional macOS widget app. |
| `npm run widget` | Open `widget/ClaudeVilleWidget.app`. |
| `npm run sprites:validate` | Validate `assets/sprites/manifest.yaml` against PNG files and character-sheet shape. Requires dev dependencies. |
| `npm run sprites:capture-baseline` | Capture baseline world screenshots for sprite visual diffing. Requires the dev server and Playwright. |
| `npm run sprites:capture-fresh` | Capture fresh screenshots next to the baseline set. Requires the dev server and Playwright. |
| `npm run sprites:visual-diff` | Compare baseline and fresh sprite screenshots with `pixelmatch`. Requires dev dependencies. |

## Fast Onboarding Path

For an unfamiliar agent, read these first:

1. `README.md` for the app shape, commands, API surface, and docs map.
2. `AGENTS.md` or `CLAUDE.md` for repo workflow, shared-checkout rules, validation, and known pitfalls.
3. `claudeville/CLAUDE.md` for implementation-level architecture inside the app.
4. The area README for the slice you are editing:
   - `claudeville/adapters/README.md` for provider parsing and normalized session contracts.
   - `claudeville/src/presentation/character-mode/README.md` for World mode.
   - `claudeville/src/presentation/dashboard-mode/README.md` for Dashboard mode.
   - `claudeville/src/presentation/shared/README.md` for shared UI and detail fetches.
   - `scripts/sprites/generate.md` for sprite generation and validation.

## Requirements

- Desktop browser at 1280px wide or larger. Mobile and narrow viewports are out of scope.
- Node.js 18 or newer.
- `npm install` only for dev scripts that import packages (`js-yaml`, `pngjs`, `pixelmatch`, `playwright`). The server itself does not need installed packages.
- At least one local provider home directory:
  - Claude Code: `~/.claude/`
  - Codex CLI: `~/.codex/` (sessions are read from `~/.codex/sessions/`)
  - Gemini CLI: `~/.gemini/` (sessions are read from `~/.gemini/tmp/`)
- Widget only: macOS with the Xcode Command Line Tools available for `swiftc`.

Empty provider lists are normal on machines where no supported CLI has local session files yet.

## Project Layout

```text
claude-ville/
|-- claudeville/
|   |-- server.js                  # Node HTTP server and hand-written WebSocket support
|   |-- index.html                 # Browser entrypoint
|   |-- adapters/                  # Provider-specific local session parsers
|   |   |-- claude.js
|   |   |-- codex.js
|   |   |-- gemini.js
|   |   |-- gitEvents.js            # Git commit/push extraction from tool commands
|   |   `-- index.js               # Adapter registry
|   |-- assets/sprites/            # Pixel-art manifest and generated PNG assets
|   |-- services/
|   |   `-- usageQuota.js          # Usage, quota, and account metadata
|   |-- css/                       # Static CSS loaded directly by index.html
|   |-- vendor/                    # Browser-vendored helper libraries
|   `-- src/
|       |-- config/                # Constants, theme, i18n strings, building definitions
|       |-- domain/                # World, agents, buildings, tasks, events, value objects
|       |-- application/           # Agent, mode, session watcher, notification coordination
|       |-- infrastructure/        # REST data source and WebSocket client
|       `-- presentation/          # Shared UI plus world and dashboard renderers
|-- scripts/sprites/               # Manifest validation, sprite generation docs, visual diff helpers
|-- widget/
|   |-- Sources/main.swift         # macOS status item app
|   |-- Resources/                 # Widget HTML and CSS served by the Node server
|   `-- build.sh                   # Swift build and local path stamping
`-- package.json
```

## Runtime Architecture

`claudeville/server.js` serves static files from `claudeville/`, serves `/widget.html` and `/widget.css` from `widget/Resources/`, exposes JSON API endpoints, upgrades WebSocket clients at `ws://localhost:4000`, watches provider data paths, and broadcasts updates while clients are connected. Updates are debounced on filesystem events; a 2-second interval also runs unconditionally, with broadcasts becoming no-ops when no WebSocket clients are connected.

The frontend boot path is `claudeville/src/presentation/App.js`:

1. Domain: create `World` and add `BUILDING_DEFS` buildings.
2. Infrastructure: `ClaudeDataSource` and `WebSocketClient`.
3. Shared UI: `Toast`, `Modal`, `TopBar`, `Sidebar`.
4. Application services: `AgentManager`, `ModeManager`, `NotificationService`.
5. Load initial sessions and usage.
6. Start `SessionWatcher`.
7. Bind canvas `ResizeObserver`.
8. Dynamically load `IsometricRenderer` (World mode), then `DashboardRenderer`.
9. Create the right-side `ActivityPanel` and bind agent-follow.
10. Settings binding and i18n.

The layout is a full-height flex shell: fixed-height top bar, left sidebar, central content area, and an optional 320px right activity panel. World mode fills the content area with a canvas. Dashboard mode scrolls vertically.

## Local Server API

The server is hardcoded to port `4000`.

| Endpoint | Description |
| --- | --- |
| `GET /api/sessions` | Active sessions from all available providers. Accepts `force=1`, `force=true`, or `force=yes` to bypass the session-list cache. |
| `GET /api/session-detail?sessionId=&project=&provider=` | Tool history, recent messages, token usage where available. |
| `POST /api/session-details` | Batch detail fetch for visible or selected sessions. Body shape: `{ "items": [{ "key", "sessionId", "project", "provider" }] }`. |
| `GET /api/teams` | Claude Code team metadata from `~/.claude/teams/`. |
| `GET /api/tasks` | Claude Code task groups from `~/.claude/tasks/`. |
| `GET /api/providers` | Detected provider list and home directories. |
| `GET /api/usage` | Usage, subscription, activity, and quota metadata. |
| `GET /api/perf` | Lightweight runtime counters for manual performance checks. |
| `GET /widget.html` | Widget popover HTML from `widget/Resources/`. |
| `GET /widget.css` | Widget popover CSS from `widget/Resources/`. |
| `ws://localhost:4000` | Initial session payload, update broadcasts, and ping/pong. |

The server also responds to CORS preflight requests and sends JSON error responses for missing or invalid routes.

## Provider Adapters

Adapters live in `claudeville/adapters/` and are registered in `adapters/index.js`. Each adapter reports whether its local provider directory exists, returns active sessions, returns detail for one session, and provides watch paths for live updates.

| Provider | Directory | Session source | Notes |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/` | `history.jsonl`, `projects/*/*.jsonl`, subagent files, teams, tasks | Supports main sessions, subagents, orphan/team-member sessions, token usage, teams, tasks, and git commit/push extraction. |
| Codex CLI | `~/.codex/sessions/` | Recent `rollout-*.jsonl` files under date folders | Reads recent rollouts, session metadata, tools, messages, token count events, reasoning effort, and git commit/push extraction. |
| Gemini CLI | `~/.gemini/tmp/` | `tmp/<project_hash>/chats/session-*.json` | Reads recent chat JSON files, attempts to reverse-map project hashes to local paths, and extracts git commit/push events where commands are present. |

Only active adapters are used. Claude-only concepts such as teams and tasks are optional and return empty arrays when unavailable.

`claudeville/adapters/index.js` owns aggregation and short-lived caches: session lists and detail payloads are cached for 5 seconds to protect the 2-second scheduler, detail payloads have an LRU-style trim, and adapter failures degrade to an empty or stale cached detail response instead of breaking the app.

## UI Modes

### World Mode

World mode is the current RPG visual direction. It renders an isometric pixel village on Canvas 2D with terrain, roads, a small pond, buildings, particles, a minimap, and agent sprites. Current buildings (source of truth: `claudeville/src/config/buildings.js`):

- Command Center: team status.
- Task Board: task status.
- Code Forge: code work.
- Token Mine: token usage.
- Grand Lore Archive: reading and search.
- Research Observatory: external research.
- Portal Gate: browser and remote tools.
- Pharos Lighthouse: GitHub and deploy sea watch.
- Harbor Master: commit ships and push departures.

Agents can be selected on the canvas. Selection opens the activity panel and makes the camera follow the selected sprite until the selection clears or the user drags the camera. Agents using `SendMessage` can move toward a matched recipient and show chat animation state.

Rendering is sprite-first. `IsometricRenderer.js` orchestrates the draw loop and data flow; `SceneryEngine.js`, `TerrainTileset.js`, `BuildingSprite.js`, `HarborTraffic.js`, `AgentSprite.js`, `SpriteRenderer.js`, `Compositor.js`, `SpriteSheet.js`, and `AssetManager.js` do the specialized work.

### Dashboard Mode

Dashboard mode renders DOM cards grouped by project. Cards show provider badge, model, role, status, current tool, recent message, and fetched tool history. Dashboard mode is designed for scanning active sessions without the RPG world.

`DashboardRenderer.js` fetches session details only while Dashboard mode is active, reuses project sections/cards across updates, and emits the same selection events as the sidebar/canvas. It shares `SessionDetailsService.js` with the activity panel so duplicate detail requests can be coalesced and briefly cached.

## macOS Menu Bar Widget

The optional widget is a small Swift `NSStatusItem` app with a `WKWebView` popover. The native Swift widget polls these endpoints every 5 seconds:

- `http://localhost:4000/api/sessions`
- `http://localhost:4000/api/usage`

Build and run:

```bash
npm run widget:build
npm run widget
```

`widget/build.sh` compiles `widget/Sources/main.swift`, recreates `widget/ClaudeVilleWidget.app`, copies widget resources, and writes the current project path and Node binary path into the app bundle. The app can start `claudeville/server.js` itself if needed, and its dashboard button opens `http://localhost:4000` in a native window.

There are two widget surfaces:

- The native menu-bar popover is rendered by Swift (`buildHTML()` in `widget/Sources/main.swift`) with `webView.loadHTMLString(...)`.
- `widget/Resources/widget.html` and `widget.css` are static resources served by `server.js` at `/widget.html` and `/widget.css`, and are also copied into the app bundle. Editing them does not automatically change the native Swift-generated popover.

## Validation

Basic syntax smoke:

```bash
node --check claudeville/server.js
find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check
```

Runtime smoke:

```bash
npm run dev
curl http://localhost:4000/api/providers
curl http://localhost:4000/api/sessions
```

For rendering changes, open `http://localhost:4000`, test both World and Dashboard modes, resize the browser, and verify the activity panel opens and closes when an agent can be selected.

Asset validation, when dev dependencies are installed:

```bash
npm run sprites:validate
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

If dependencies are not installed and installing them is out of scope, fall back to manifest/code inspection plus `file claudeville/assets/sprites/**/*.png` checks for touched assets.

For widget changes, run `npm run widget:build`, then `npm run widget`, and confirm the app can reach port `4000`.

## Development Notes

- Keep provider session files read-only. ClaudeVille observes local CLI logs; it should not mutate them.
- Keep port `4000` unless all dependent docs, widget code, and local workflows are updated together.
- `DEBUG_STATIC=1` logs static file requests; `DEBUG_WATCH=1` logs watch-path refresh details.
- Keep small changes within the current vanilla JavaScript and CSS architecture. There is no framework, bundler, transpiler, or app test runner today.
- Do not edit generated sprite PNGs without also checking `claudeville/assets/sprites/manifest.yaml` and the sprite validation rules.
- This repo is often edited by multiple agents. Check `git status --short` before changes and preserve unrelated local edits.
- See `docs/visual-experience-crafting.md` for the transferable design method behind the RPG world model. It is intended as a handoff note for applying the same visual-representation logic to unrelated datasets.
- `demo-server.js` at the repo root is unused/abandoned and not wired into `package.json`; do not run it.

## Docs Map

| File | Audience | Purpose |
| --- | --- | --- |
| `README.md` | Everyone | Project overview, quick start, runtime architecture. |
| `AGENTS.md` | Codex CLI and any generic agent harness | Canonical agent-context file: harness map, `/agents/` artifact convention, project shape, conventions, validation, git hygiene. |
| `CLAUDE.md` | Claude Code | Byte-for-byte mirror of `AGENTS.md` (after the heading) so Claude Code's auto-loader sees the same content. `AGENTS.md` is canonical — when changing one, change both and run the parity diff in either file's Validation Checklist. |
| `claudeville/CLAUDE.md` | Agents working inside `claudeville/` | Implementation context: server, adapters, layout, event flow. |
| `claudeville/adapters/README.md` | Adapter work | Provider contract, normalized session fields, token and git-event extraction. |
| `claudeville/src/presentation/character-mode/README.md` | World mode work | Canvas renderer pipeline, selection lifecycle, sprite/world contracts. |
| `claudeville/src/presentation/dashboard-mode/README.md` | Dashboard work | DOM renderer lifecycle, detail polling, selection contract. |
| `claudeville/src/presentation/shared/README.md` | Shared UI work | Top bar/sidebar/activity panel, model identity, session-detail cache. |
| `docs/swarm-orchestration-procedure.md` | Multi-agent workflows | SOP for splitting work across subagents in a shared checkout. |
| `docs/design-decisions.md` | Maintainers | Load-bearing constraints and what to update if one changes. |
| `docs/troubleshooting.md` | Operators and agents | Common first-hour failures and diagnosis paths. |
| `docs/motion-budget.md` | World mode work | Motion, pulse-band, and reduced-motion policy. |
| `docs/visual-experience-crafting.md` | Visual/UX work | Transferable design method behind the RPG world model. |
| `scripts/sprites/generate.md` | Sprite work | Manifest-first Pixellab generation and asset validation runbook. |
| `docs/pixellab-reference.md` | Sprite work | Pixellab tool catalog, parameter enums, animation templates, async lifecycle, and pitfalls. |

## License

MIT
