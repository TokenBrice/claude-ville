# ClaudeVille

ClaudeVille is a local dashboard for AI coding agent activity. It reads session files from Claude Code, OpenAI Codex CLI, and Google Gemini CLI, normalizes them into a shared session model, and displays them in either an isometric RPG-style world or a dense monitoring dashboard.

The app is intentionally small: a zero-dependency Node.js HTTP/WebSocket server, static browser assets, vanilla ES modules, Canvas 2D rendering, and an optional macOS menu bar widget.

## Quick Start

```bash
npm run dev
```

Open `http://localhost:4000`.

There is no install step in this repo today. `package.json` only defines:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start `claudeville/server.js` on port `4000`. |
| `npm run widget:build` | Compile the optional macOS widget app. |
| `npm run widget` | Open `widget/ClaudeVilleWidget.app`. |

## Requirements

- Node.js 18 or newer.
- At least one local provider directory:
  - Claude Code: `~/.claude/`
  - Codex CLI: `~/.codex/sessions/`
  - Gemini CLI: `~/.gemini/tmp/`
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
|   |   `-- index.js               # Adapter registry
|   |-- services/
|   |   `-- usageQuota.js          # Usage, quota, and account metadata
|   |-- css/                       # Static CSS loaded directly by index.html
|   `-- src/
|       |-- config/                # Constants, theme, i18n strings, building definitions
|       |-- domain/                # World, agents, buildings, tasks, events, value objects
|       |-- application/           # Agent, mode, session watcher, notification coordination
|       |-- infrastructure/        # REST data source and WebSocket client
|       `-- presentation/          # Shared UI plus world and dashboard renderers
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
| `GET /api/sessions` | Active sessions from all available providers. |
| `GET /api/session-detail?sessionId=&project=&provider=` | Tool history, recent messages, token usage where available. |
| `GET /api/teams` | Claude Code team metadata from `~/.claude/teams/`. |
| `GET /api/tasks` | Claude Code task groups from `~/.claude/tasks/`. |
| `GET /api/providers` | Detected provider list and home directories. |
| `GET /api/usage` | Usage, subscription, activity, and quota metadata. |
| `GET /widget.html` | Widget popover HTML from `widget/Resources/`. |
| `GET /widget.css` | Widget popover CSS from `widget/Resources/`. |
| `ws://localhost:4000` | Initial session payload, update broadcasts, and ping/pong. |

The server also responds to CORS preflight requests and sends JSON error responses for missing or invalid routes.

## Provider Adapters

Adapters live in `claudeville/adapters/` and are registered in `adapters/index.js`. Each adapter reports whether its local provider directory exists, returns active sessions, returns detail for one session, and provides watch paths for live updates.

| Provider | Directory | Session source | Notes |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/` | `history.jsonl`, `projects/*/*.jsonl`, subagent files, teams, tasks | Supports main sessions, subagents, orphan/team-member sessions, token usage, teams, and tasks. |
| Codex CLI | `~/.codex/sessions/` | Recent `rollout-*.jsonl` files under date folders | Reads recent rollouts, session metadata, tools, messages, and token count events. |
| Gemini CLI | `~/.gemini/tmp/` | `tmp/<project_hash>/chats/session-*.json` | Reads recent chat JSON files and attempts to reverse-map project hashes to local paths. |

Only active adapters are used. Claude-only concepts such as teams and tasks are optional and return empty arrays when unavailable.

## UI Modes

### World Mode

World mode is the current RPG visual direction. It renders an isometric pixel village on Canvas 2D with terrain, roads, a small pond, buildings, particles, a minimap, and agent sprites. Current buildings are:

- Command Center: team status.
- Code Forge: code work.
- Token Mine: token usage.
- Task Board: task status.
- Chat Hall: messages.
- Research Observatory: external research.
- Lore Archive: reading and search.
- Portal Gate: browser and remote tools.
- Prompt Alchemy: notebook and prompt work.
- Idle Sanctuary: resting agents.
- Sky Watchtower: monitoring and status.

See `claudeville/src/config/buildings.js` for the source of truth.

Agents can be selected on the canvas. Selection opens the activity panel and makes the camera follow the selected sprite until the selection clears or the user drags the camera. Agents using `SendMessage` can move toward a matched recipient and show chat animation state.

### Dashboard Mode

Dashboard mode renders DOM cards grouped by project. Cards show provider badge, model, role, status, current tool, recent message, token usage, and fetched tool history. Dashboard mode is designed for scanning active sessions without the RPG world.

## macOS Menu Bar Widget

The optional widget is a small Swift `NSStatusItem` app with a `WKWebView` popover. It polls these endpoints every 3 seconds:

- `http://localhost:4000/api/sessions`
- `http://localhost:4000/api/usage`

Build and run:

```bash
npm run widget:build
npm run widget
```

`widget/build.sh` compiles `widget/Sources/main.swift`, creates `widget/ClaudeVilleWidget.app`, copies widget resources, and writes the current project path and Node binary path into the app bundle. The app can start `claudeville/server.js` itself if needed, and its dashboard button opens `http://localhost:4000` in a native window.

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

For widget changes, run `npm run widget:build`, then `npm run widget`, and confirm the app can reach port `4000`.

## Development Notes

- Keep provider session files read-only. ClaudeVille observes local CLI logs; it should not mutate them.
- Keep port `4000` unless all dependent docs, widget code, and local workflows are updated together.
- Keep small changes within the current vanilla JavaScript and CSS architecture. There is no framework, bundler, transpiler, package install, or test runner today.
- This repo is often edited by multiple agents. Check `git status --short` before changes and preserve unrelated local edits.
- See `docs/visual-experience-crafting.md` for the transferable design method behind the RPG world model. It is intended as a handoff note for applying the same visual-representation logic to unrelated datasets.
- `demo-server.js` at the repo root is unused/abandoned and not wired into `package.json`; do not run it.

## Docs Map

| File | Audience | Purpose |
| --- | --- | --- |
| `README.md` | Everyone | Project overview, quick start, runtime architecture. |
| `AGENTS.md` | Generic agent tools (Codex, etc.) | Project shape, conventions, validation, git hygiene. |
| `CLAUDE.md` | Claude Code | Mirror of `AGENTS.md`; kept byte-identical apart from the title. Claude Code auto-loads it; AGENTS.md is the canonical source — when changing one, change both. |
| `claudeville/CLAUDE.md` | Agents working inside `claudeville/` | Implementation context: server, adapters, layout, event flow. |
| `docs/swarm-orchestration-procedure.md` | Multi-agent workflows | SOP for splitting work across subagents in a shared checkout. |
| `docs/visual-experience-crafting.md` | Visual/UX work | Transferable design method behind the RPG world model. |

## License

MIT
