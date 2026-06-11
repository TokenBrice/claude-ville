# ClaudeVille Agent Notes

## Scope

- Work from the repo root: `/home/ahirice/Documents/git/claude-ville`.
- This checkout may be edited by multiple agents. Run `git status --short` before changes and do not revert or absorb unrelated edits.
- For documentation-only tasks scoped to `README.md`, root `AGENTS.md`/`CLAUDE.md`, or `claudeville/CLAUDE.md`, edit only those files.
- Workflow, git hygiene, and multi-agent coordination are controlled by the root `AGENTS.md`.

## Project Shape

Static HTML/CSS/vanilla ES modules; `server.js` uses only Node built-ins; no bundler, transpiler, or app test runner. Dev dependencies exist only for sprite validation, Playwright capture, and pixelmatch diffs — run `npm install` only when those scripts are in scope. Dev server: `npm run dev` (node claudeville/server.js).

## Server

`server.js`: port hardcoded to `4000`; static files from `claudeville/`; `/widget.html` and `/widget.css` from `widget/Resources/`; watch paths come from active provider adapters; updates debounce on fs events plus a 2 s poll that no-ops with no WS clients.

API: `/api/sessions`; `/api/session-detail?sessionId=&project=&provider=`; POST `/api/session-details` (body max 256 KiB, up to 100 items read, invalid providers skipped); `/api/teams`; `/api/tasks`; `/api/providers`; `/api/usage` (from `services/usageQuota.js`); `/api/perf`; `ws://localhost:4000` (init payload, updates, ping/pong).

Do not change port `4000` casually. The README, widget, and local workflows assume it.

Cadence constants live in `src/config/constants.js`, `server.js`, `adapters/index.js`, `adapters/gitEvents.js`, and `widget/Sources/main.swift`.

Invariant: client poll fallback runs at 2 s; server cache TTL is 5 s; WS heartbeat is 30 s; widget poll is 5 s — never lower client poll under server cache TTL/2 or the cache becomes useless.

## Provider Adapters

In `adapters/`, registered by `adapters/index.js`.

- `claude.js`: `~/.claude/` — `history.jsonl`, `projects/`, `teams/`, `tasks/`; subagents under `subagents/`, workflow-tool subagents under `subagents/workflows/<wfRunId>/` (tagged `agentType: 'workflow-subagent'`), orphan/team-member project JSONL files.
- `codex.js`: `~/.codex/sessions/` — recent `rollout-*.jsonl` under `YYYY/MM/DD/`.
- `gemini.js`: `~/.gemini/tmp/` — `tmp/<project_hash>/chats/session-*.json`; reverse-maps project hashes to local paths.
- `kimi.js`: `~/.kimi/` — session wire/state files and config.
- `opencode.js`: `~/.local/share/opencode/opencode.db` — SQLite read-only; includes subagent parent links and git events from shell tools.
- `gitEvents.js`: parses git `commit`/`push` from provider tool logs (dry-runs omitted) into session `gitEvents`; the registry can synthesize repository-only `provider: 'git'` sessions. Scans default to `~/Documents/git`; tune `CLAUDEVILLE_REPOSITORY_SCAN_ROOT`/`CLAUDEVILLE_REPOSITORY_SCAN_MAX`; disable `CLAUDEVILLE_DISABLE_GIT_ENRICHMENT=1`.

Adapter availability is automatic; empty provider output is not necessarily an error. Treat all provider session files as read-only inputs. `adapters/index.js` caches lists and details for 5 s; detail failures return stale cache when present, else `{ toolHistory: [], messages: [] }`.

## Frontend

`src/presentation/App.js` owns startup. The app exposes English UI strings only. Documentation should also stay English.

Layout: `header.topbar` fixed-height; `aside.sidebar` fixed-width; `.content` takes remaining space (holds `section#characterMode`, `section#dashboardMode`); `#activityPanel` is 320px wide and shrinks `.content` when open. World canvas fills remaining content; Dashboard scrolls vertically. Do not use `position: fixed` for normal UI panels. Modals and toasts are the exceptions.

## World Mode

Sprite-based pixel-art Canvas 2D isometric rendering under `src/presentation/character-mode/`. Invariants: `Camera.js` zoom is clamped to integer steps {1,2,3} for pixel-perfect blits. `SpriteRenderer.js` is the sole entry point for sprite blits (integer snap, smoothing off); `AgentSprite.js` is state and animation only. `Minimap.js` is intentionally vector parchment art, out of scope for the pixel-art migration.

Buildings (nine) come from `src/config/buildings.js`. Agent clicks select, open the activity panel via domain events, and start camera follow; empty-space clicks clear selection and stop follow, but the panel closes only via its own close action or when the selected agent is removed.

Motion-bearing World mode work must follow `../docs/motion-budget.md`: check `motionScale` before allocating animation resources, declare a pulse band, and ship a static reduced-motion fallback.

## Sprite Generation

Via the PixelLab MCP server. `claudeville/assets/sprites/manifest.yaml` is the single source of truth — every sprite the renderer references must have a corresponding manifest entry, and every PNG on disk must correspond to a manifest entry. PNGs go to the manifest-implied path (`AssetManager._pathFor`). `AssetManager` cache-busts PNG loads with `style.assetVersion` and falls back to `assets/sprites/_placeholder/checker-64.png` for missing/invalid images. `style.anchor` is concatenated into every prompt; bump `style.assetVersion` when PNGs change and browser cache matters. The `palettes` block is mirrored in `claudeville/assets/sprites/palettes.yaml`; keep both in sync. Then run `npm run sprites:validate`. Steps: `scripts/sprites/generate.md`; PixelLab: `../docs/pixellab-reference.md`.

## Dashboard and Activity Panel

`src/presentation/dashboard-mode/DashboardRenderer.js` groups agents by project; listens for `agent:added`/`agent:updated`/`agent:removed`/`mode:changed`; detail fetching runs only while Dashboard mode is active; card clicks emit `agent:selected`. Details flow through `shared/SessionDetailsService.js` (dedupe + short-lived cache).

`src/presentation/shared/ActivityPanel.js`: `agent:selected` opens agent mode; `BUILDING_EVENTS.SELECTED` opens building mode and clears agent selection. Polls session detail every 2 s, building occupants every 5 s; renders only when detail signatures change.

## Widget

`widget/Sources/main.swift` polls `/api/sessions` and `/api/usage` every 5 s. The native popover is generated inline in Swift (`buildHTML()`); editing `widget/Resources/widget.html`/`widget.css` does not automatically change it. Widget changes require macOS validation: `npm run widget:build` then `npm run widget`.

## Validation

In-app (after rendering/layout/event-bus changes): open `http://localhost:4000`; switch World/Dashboard modes; select/deselect an agent — `agent:selected`/`agent:deselected` must open/close the activity panel and toggle camera follow; the world canvas must resize with `.content` (not `position: fixed`).

Assets (`npm install` first if `node_modules/` is missing): `npm run sprites:validate` (manifest ↔ PNG bidirectional check); `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` (pixelmatch baselines).

Docs (English-only; must return no matches):

```bash
rg -n -P "[\\x{1100}-\\x{11FF}\\x{3130}-\\x{318F}\\x{AC00}-\\x{D7AF}]" $(rg --files -g '*.md' --glob '!node_modules')
```

See `AGENTS.md` § Validation Checklist for the canonical syntax/runtime/widget smoke list.

## Event Bus

Singleton at `src/domain/events/DomainEvent.js`, exports `eventBus`; no replay or persistence; subscriptions are global. Events: `agent:added`/`agent:updated`/`agent:removed` (`Agent`, from `domain/entities/World.js`); `agent:selected` (`Agent`); `agent:deselected`; `mode:changed` (`'character' | 'dashboard'`, from `application/ModeManager.js`); `usage:updated`; `ws:connected`/`ws:disconnected`/`ws:init`/`ws:update`/`ws:message` (from `infrastructure/WebSocketClient.js`). `ws:message` currently has no subscribers.

## Development Constraints

- Keep changes narrow and consistent with the existing no-build-step architecture.
- Do not introduce a frontend framework for small UI or documentation changes.
- Do not mutate local CLI session files.
- Do not delete generated app-bundle files or `.playwright-cli/` unless explicitly asked.
- Re-run `git status --short` before committing or handing off changed files.
