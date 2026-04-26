# ClaudeVille Agent Notes

This file is for agents working inside `claudeville/`. Keep it current when architecture, runtime behavior, or validation paths change.

## Scope

- Work from the repo root: `/home/ahirice/Documents/git/claude-ville`.
- This checkout may be edited by multiple agents. Run `git status --short` before changes and do not revert or absorb unrelated edits.
- For documentation-only tasks scoped to `README.md`, root `AGENTS.md`/`CLAUDE.md`, or `claudeville/CLAUDE.md`, edit only those files.
- Prefer `rg` and `rg --files` for discovery.
- Workflow, git hygiene, and subagent orchestration are controlled by the root `AGENTS.md` and [docs/swarm-orchestration-procedure.md](../docs/swarm-orchestration-procedure.md); this file provides implementation context and validation details for `claudeville/`.

## Project Shape

ClaudeVille is a local AI coding agent dashboard. Runtime has no dependency install step, no bundler, no transpiler, and no app test runner. The browser app is static HTML, CSS, and vanilla ES modules. The backend is `server.js` using only Node built-in modules.

The repo does have `package-lock.json` and dev dependencies for sprite validation, Playwright screenshot capture, and pixelmatch visual diffs. Run `npm install` only when those development scripts are in scope.

Top-level scripts:

```bash
npm run dev           # node claudeville/server.js
npm run widget:build  # cd widget && bash build.sh
npm run widget        # open widget/ClaudeVilleWidget.app
```

## Server

`server.js` is the local HTTP/WebSocket server.

- Port is hardcoded to `4000`.
- Static files are served from `claudeville/`.
- `/widget.html` and `/widget.css` are served from `widget/Resources/`.
- WebSocket upgrades are handled directly with an RFC 6455 frame implementation.
- CORS headers are permissive for local tooling.
- Watch paths come from active provider adapters.
- Updates are debounced on filesystem events. A 2-second polling interval also runs continuously; the broadcast no-ops when no WebSocket clients are connected.

Current API surface:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/sessions` | Active sessions from every available provider. |
| `GET /api/session-detail?sessionId=&project=&provider=` | Tool history, messages, and token usage for one session when available. |
| `GET /api/teams` | Claude Code team metadata. |
| `GET /api/tasks` | Claude Code task metadata. |
| `GET /api/providers` | Active provider adapters. |
| `GET /api/usage` | Account, activity, and quota data from `services/usageQuota.js`. |
| `ws://localhost:4000` | Initial payload, update broadcasts, and ping/pong. |

Do not change port `4000` casually. The README, widget, and local workflows assume it.

## Provider Adapters

Adapters are in `adapters/` and registered by `adapters/index.js`.

- `claude.js`
  - Source: `~/.claude/`.
  - Reads `history.jsonl`, `projects/`, `teams/`, and `tasks/`.
  - Detects recent main sessions, subagents under `subagents/`, and orphan/team-member project JSONL files.
  - Provides token usage, last tool, last tool input, last message, teams, and tasks.
- `codex.js`
  - Source: `~/.codex/sessions/`.
  - Reads recent `rollout-*.jsonl` files under `YYYY/MM/DD/`.
  - Extracts session metadata, model, cwd, tool calls, messages, token count events, and usage fallbacks.
- `gemini.js`
  - Source: `~/.gemini/tmp/`.
  - Reads `tmp/<project_hash>/chats/session-*.json`.
  - Extracts model, tool calls, messages, and attempts to reverse-map project hashes to local paths.
- `gitEvents.js`
  - Shared parser for git `commit` and `push` commands seen in provider tool logs.
  - Dry-runs are omitted.
  - Events are attached to active session objects as `gitEvents`; detail payloads currently focus on tools/messages/tokens.

Adapter availability is automatic. A machine can have any subset of providers installed, and empty provider output is not necessarily an error.

Treat all provider session files as read-only inputs.

`adapters/index.js` also protects the live polling path with short TTL caches:

- Session lists are cached for 500ms.
- Session details are cached for 1250ms with a small LRU-style trim.
- Detail failures return the stale cached payload when one exists, otherwise `{ toolHistory: [], messages: [] }`.

## Frontend Boot Path

`src/presentation/App.js` owns startup:

1. Creates the domain `World` and adds buildings from `src/config/buildings.js`.
2. Creates `ClaudeDataSource` and `WebSocketClient`.
3. Creates shared UI: `Toast`, `Modal`, `TopBar`, `Sidebar`.
4. Creates application services: `AgentManager`, `ModeManager`, `NotificationService`.
5. Loads initial sessions through `AgentManager.loadInitialData()` and seeds usage data.
6. Starts `SessionWatcher`.
7. Binds canvas resizing with `ResizeObserver`.
8. Loads `character-mode/IsometricRenderer.js`, then `dashboard-mode/DashboardRenderer.js`.
9. Constructs `ActivityPanel` and binds agent-follow event handlers.
10. Binds the settings button.
11. Applies initial i18n.

The app still exposes a language setting, but the current visible strings are English. Documentation should also stay English.

## Layout Rules

The page shell is a full-height flex layout:

```text
body
  header.topbar
  div.main
    div.main__body
      aside.sidebar
      div.content
        section#characterMode
        section#dashboardMode
      aside#activityPanel
```

- `header.topbar` is fixed-height.
- `aside.sidebar` is fixed-width.
- `.content` takes remaining space.
- `#activityPanel` is 320px wide and shrinks `.content` when open.
- World mode canvas fills the remaining content area.
- Dashboard mode scrolls vertically.
- Do not use `position: fixed` for normal UI panels. Modals and toasts are the exceptions.

## World Mode

World mode is the current RPG visual direction. It is sprite-based pixel-art Canvas 2D isometric rendering under `src/presentation/character-mode/`.

Key files:

- `IsometricRenderer.js`: render loop orchestration; routes terrain, buildings, and agents through sprite renderers.
- `Camera.js`: pan, zoom (clamped to integer steps {1,2,3} for pixel-perfect blits), follow.
- `AgentSprite.js`: state and animation only; drawing delegated to `SpriteRenderer`, `Compositor`, and `SpriteSheet`.
- `BuildingSprite.js`: building sprite blits with occlusion split for hero buildings; replaces the legacy building renderer.
- `BuildingRenderer.legacy.js`: historical reference/fallback code, not the current render path.
- `ParticleSystem.js`: particles and ambient effects; emitter hooks now driven by manifest-declared coordinates.
- `Minimap.js`: intentionally vector parchment art, out of scope for the pixel-art migration.
- `AssetManager.js`: manifest loader, PNG cache, alpha mask + outline cache.
- `SpriteRenderer.js`: sole entry point for sprite blits; integer snap, smoothing off.
- `SpriteSheet.js`: frame strip lookup and 8-direction velocity-to-direction mapping.
- `Compositor.js`: palette swap with ΔE tolerance and accessory overlay compositing.
- `TerrainTileset.js`: Wang-tile neighbor mask lookup and isometric transform.
- `SceneryEngine.js`: authored and generated water, shore, bridges, vegetation, boulders, and walkability.
- `Pathfinder.js`: grid pathfinding over the walkability map.
- `HarborTraffic.js`: ship/harbor motion and git-event-aware harbor activity.

Buildings from `src/config/buildings.js` (eight total):

- Command Center: team status.
- Task Board: task status.
- Code Forge: code work.
- Token Mine: token usage.
- Grand Lore Archive: reading and search.
- Research Observatory: external research.
- Portal Gate: browser and remote tools.
- Pharos Lighthouse: GitHub and deploy sea watch.

Clicking an agent selects it, opens the right activity panel through domain events, and starts camera follow. Clicking empty world space clears renderer selection and stops follow, but the activity panel closes through its own close action or when the selected agent is removed. Agents using `SendMessage` can move toward a matched recipient and show chat state.

## Sprite Generation

Pixel-art sprites are generated through the [pixellab MCP server](https://mcpservers.org/servers/pixellab-code/pixellab-mcp). The asset manifest at `claudeville/assets/sprites/manifest.yaml` is the single source of truth — every sprite the renderer references must have a corresponding manifest entry, and every PNG on disk must correspond to a manifest entry.

`AssetManager` fetches `manifest.yaml` and `palettes.yaml`, appends `style.assetVersion` as a cache-busting query parameter for PNG loads, and falls back to `assets/sprites/_placeholder/checker-64.png` when an image is missing or invalid. If a renderer shows checkerboard assets, check the manifest ID, path mapping, and asset version first.

Workflow:

1. User installs the pixellab MCP server with their API token (`claude mcp add --transport http pixellab https://api.pixellab.ai/mcp --header "Authorization: Bearer YOUR_TOKEN"`).
2. Claude Code session reads `manifest.yaml`, calls the appropriate MCP tool per entry (`mcp__pixellab__create_character`, `mcp__pixellab__animate_character`, `mcp__pixellab__tileset`, `mcp__pixellab__isometric_tile`).
3. Resulting PNGs are saved to the manifest-implied path (see `AssetManager._pathFor` for the mapping).
4. Run `npm run sprites:validate` to confirm every manifest entry resolves to a real PNG and no orphan PNGs exist.

The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets. `style.assetVersion` should be bumped when PNGs change and browser cache behavior matters.
The `palettes` block in `manifest.yaml` is mirrored in `claudeville/assets/sprites/palettes.yaml`; keep both in sync if editing either.

For full asset generation steps see `scripts/sprites/generate.md`.

## Dashboard Mode

Dashboard mode is DOM/card rendering under `src/presentation/dashboard-mode/`.

- `DashboardRenderer.js` groups agents by project.
- Cards show avatar, provider badge, model, role, status, current tool, recent message, and fetched tool history.
- It listens for `agent:added`, `agent:updated`, `agent:removed`, and `mode:changed`.
- Detail fetching runs while Dashboard mode is active and stops when leaving Dashboard mode.
- Existing project sections and cards are reused across updates; stale cards and sections are removed after each render.
- Card clicks emit `agent:selected`, matching sidebar/canvas selection behavior.
- Session details flow through `shared/SessionDetailsService.js`, which dedupes in-flight requests and serves short-lived cached data.

## Activity Panel

`src/presentation/shared/ActivityPanel.js` is the 320px right panel opened by `agent:selected` and closed by `agent:deselected`.

It polls session detail every 2 seconds for the selected agent and shows tool history, recent messages, and token usage when the provider adapter exposes those fields.

The panel shares `SessionDetailsService.js` with Dashboard mode. It renders only when detail signatures change, so stale-looking output can be caused by cached detail data or an unchanged signature rather than a missed DOM update.

## Widget

The optional macOS widget lives outside `claudeville/` in `widget/`.

- `widget/Sources/main.swift` creates an `NSStatusItem` and a `WKWebView` popover.
- It polls `/api/sessions` and `/api/usage` every 3 seconds.
- The native menu popover is generated inline in Swift (`buildHTML()` and `loadHTMLString(...)`).
- `widget/Resources/widget.html` and `widget.css` are static resources served by `server.js` and copied into the app bundle, but editing them does not automatically change the native Swift-generated popover.
- It can start `claudeville/server.js` using the project path and Node path recorded in the app bundle.
- The dashboard menu/window opens `http://localhost:4000`.
- `widget/build.sh` compiles Swift, recreates `ClaudeVilleWidget.app`, copies resources, and writes `project_path` and `node_path`.

Widget changes require macOS validation with:

```bash
npm run widget:build
npm run widget
```

## Validation

In-app specifics (run after rendering/layout/event-bus changes):

- Open `http://localhost:4000`, switch between World and Dashboard modes.
- Select and deselect an agent to confirm `agent:selected`/`agent:deselected` open and close the right activity panel and toggle camera follow.
- Confirm the world canvas resizes with `.content` (not via `position: fixed`).

Asset validation:

- Run `npm install` first if `node_modules/` is missing and asset validation is in scope.
- `npm run sprites:validate` — manifest ↔ PNG bidirectional check.
- `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` — pixelmatch baseline comparison.

Documentation validation (project-wide, English-only):

```bash
rg -n -P "\\p{Hangul}" $(rg --files -g '*.md' --glob '!node_modules')
```

That command should return no matches.

See `AGENTS.md` § Validation Checklist for the canonical syntax/runtime/widget smoke list.

## Event Bus

The singleton bus lives at `src/domain/events/DomainEvent.js` and exports `eventBus`. It is a plain in-memory observer with `on/off/emit`; there is no replay or persistence. Modules import the same instance, so subscriptions are global.

| Event | Payload | Emitter (file:line) | Primary subscribers |
| --- | --- | --- | --- |
| `agent:added` | `Agent` | `domain/entities/World.js:12` | `IsometricRenderer.js:355`, `dashboard-mode/DashboardRenderer.js:44`, `shared/Sidebar.js:22`, `shared/TopBar.js:25`, `application/NotificationService.js:40` |
| `agent:updated` | `Agent` | `domain/entities/World.js:27` | `IsometricRenderer.js:357`, `DashboardRenderer.js:45`, `Sidebar.js:23`, `TopBar.js:26`, `shared/ActivityPanel.js:30` |
| `agent:removed` | `Agent` | `domain/entities/World.js:19` | `IsometricRenderer.js:356`, `DashboardRenderer.js:46`, `Sidebar.js:24`, `TopBar.js:27`, `ActivityPanel.js:38`, `NotificationService.js:41` |
| `agent:selected` | `Agent` | `presentation/App.js:119` (canvas hit), `Sidebar.js:69`, `DashboardRenderer.js:250` | `App.js:142` (renderer follow), `ActivityPanel.js:26` (panel open) |
| `agent:deselected` | none | `ActivityPanel.js:57` (panel close) | `App.js:149` (clear renderer follow) |
| `mode:changed` | `'character' \| 'dashboard'` | `application/ModeManager.js:31` | `DashboardRenderer.js:47`, `NotificationService.js:44` |
| `usage:updated` | usage object from `/api/usage` | `App.js:71` (initial fetch), `SessionWatcher.js:71`, `WebSocketClient.js:77,81` | `shared/TopBar.js:30` |
| `ws:connected` | none | `infrastructure/WebSocketClient.js:27` | `SessionWatcher.js:26`, `NotificationService.js:42` |
| `ws:disconnected` | none | `WebSocketClient.js:43` | `SessionWatcher.js:25`, `NotificationService.js:43` |
| `ws:init` | initial server payload (`sessions`, `teams`, `usage`) | `WebSocketClient.js:76` | `SessionWatcher.js:23` |
| `ws:update` | server update payload | `WebSocketClient.js:80` | `SessionWatcher.js:24` |
| `ws:message` | unknown WS message | `WebSocketClient.js:86` | (none currently — kept for future hooks) |

## Development Constraints

- Keep changes narrow and consistent with the existing no-build-step architecture.
- Do not introduce a frontend framework for small UI or documentation changes.
- Do not mutate local CLI session files.
- Do not delete generated app-bundle files or `.playwright-cli/` unless explicitly asked.
- Re-run `git status --short` before committing or handing off changed files.
