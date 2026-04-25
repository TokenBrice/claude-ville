# ClaudeVille Agent Notes

This file is for agents working inside `claudeville/`. Keep it current when architecture, runtime behavior, or validation paths change.

## Scope

- Work from the repo root: `/home/ahirice/Documents/git/claude-ville`.
- This checkout may be edited by multiple agents. Run `git status --short` before changes and do not revert or absorb unrelated edits.
- For documentation-only tasks scoped to `README.md` and `claudeville/CLAUDE.md`, edit only those files.
- Prefer `rg` and `rg --files` for discovery.

## Project Shape

ClaudeVille is a local AI coding agent dashboard. It has no npm dependency install step, no bundler, no transpiler, and no test runner. The browser app is static HTML, CSS, and vanilla ES modules. The backend is `server.js` using only Node built-in modules.

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
- Updates are debounced on filesystem events and also polled every 2 seconds while WebSocket clients are connected.

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

Adapter availability is automatic. A machine can have any subset of providers installed, and empty provider output is not necessarily an error.

Treat all provider session files as read-only inputs.

## Frontend Boot Path

`src/presentation/App.js` owns startup:

1. Creates the domain `World`.
2. Adds buildings from `src/config/buildings.js`.
3. Creates `ClaudeDataSource` and `WebSocketClient`.
4. Creates shared UI: `Toast`, `Modal`, `TopBar`, `Sidebar`, and `ActivityPanel`.
5. Loads initial sessions through `AgentManager`.
6. Starts `SessionWatcher`.
7. Binds canvas resizing with `ResizeObserver`.
8. Loads `character-mode/IsometricRenderer.js`.
9. Loads `dashboard-mode/DashboardRenderer.js`.
10. Binds settings and i18n.

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

World mode is the current RPG visual direction. It is Canvas 2D isometric rendering under `src/presentation/character-mode/`.

Key files:

- `IsometricRenderer.js`: render loop, terrain, water, roads, minimap attachment, hit testing, event subscriptions.
- `Camera.js`: pan, zoom, centering, and selected-agent follow behavior.
- `AgentSprite.js`: sprite state, movement, selection, and chat animation.
- `BuildingRenderer.js`: building visuals, hover state, and effects.
- `ParticleSystem.js`: particles and ambient effects.
- `Minimap.js`: minimap rendering and navigation.

Current building concepts from `src/config/buildings.js`:

- Command Center: team status.
- Code Forge: code work.
- Token Mine: token usage.
- Task Board: task status.
- Chat Hall: messages.

Clicking an agent selects it, opens the right activity panel through domain events, and starts camera follow. Clicking empty world space clears selection. Agents using `SendMessage` can move toward a matched recipient and show chat state.

## Dashboard Mode

Dashboard mode is DOM/card rendering under `src/presentation/dashboard-mode/`.

- `DashboardRenderer.js` groups agents by project.
- Cards show avatar, provider badge, model, role, status, current tool, recent message, token usage, and fetched tool history.
- It listens for `agent:added`, `agent:updated`, `agent:removed`, and `mode:changed`.
- Detail fetching runs while Dashboard mode is active.

## Activity Panel

`src/presentation/shared/ActivityPanel.js` is the 320px right panel opened by `agent:selected` and closed by `agent:deselected`.

It polls session detail every 2 seconds for the selected agent and shows tool history, recent messages, and token usage when the provider adapter exposes those fields.

## Widget

The optional macOS widget lives outside `claudeville/` in `widget/`.

- `widget/Sources/main.swift` creates an `NSStatusItem` and a `WKWebView` popover.
- It polls `/api/sessions` and `/api/usage` every 3 seconds.
- It can start `claudeville/server.js` using the project path and Node path recorded in the app bundle.
- The dashboard menu/window opens `http://localhost:4000`.
- `widget/build.sh` compiles Swift, creates `ClaudeVilleWidget.app`, copies resources, and writes `project_path` and `node_path`.

Widget changes require macOS validation with:

```bash
npm run widget:build
npm run widget
```

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

Visual smoke for rendering or layout work:

- Open `http://localhost:4000`.
- Test both World and Dashboard modes.
- Select and deselect an agent if sessions exist.
- Open and close the right activity panel.
- Resize the browser and confirm the world canvas still fills `.content`.
- Check the browser console for errors related to the changed area.

Documentation validation:

```bash
rg -n -P "\\p{Hangul}" README.md claudeville/CLAUDE.md
```

That command should return no matches.

## Event Flow

- `agent:selected`: open the activity panel and start camera follow.
- `agent:deselected`: close the activity panel and clear camera follow.
- `agent:added`: create sprites/cards.
- `agent:updated`: refresh sprite/card/panel state.
- `agent:removed`: remove sprites/cards.
- `mode:changed`: toggle World and Dashboard behavior.

## Development Constraints

- Keep changes narrow and consistent with the existing no-build-step architecture.
- Do not introduce a frontend framework for small UI or documentation changes.
- Do not mutate local CLI session files.
- Do not delete generated app-bundle files or `.playwright-cli/` unless explicitly asked.
- Re-run `git status --short` before committing or handing off changed files.
