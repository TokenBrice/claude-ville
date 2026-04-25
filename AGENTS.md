# Agent Notes

## Scope And Purpose

- Work from `/home/ahirice/Documents/git/claude-ville`.
- Claude Ville is a local, zero-build dashboard for watching AI coding CLI sessions as a browser "village" plus an optional macOS menu bar widget.
- Only edit files needed for the requested task. If ownership is limited to one file, touch only that file.
- This checkout is shared with other agents. Start with `git status --short`, preserve unrelated edits, and prefer `rg`/`rg --files` for discovery.

## Commands

- Start dashboard: `npm run dev` (`node claudeville/server.js`)
- Open dashboard: `http://localhost:4000`
- Build widget: `npm run widget:build` (`cd widget && bash build.sh`)
- Launch widget: `npm run widget` (`open widget/ClaudeVilleWidget.app`)
- There is no install step, bundler, transpiler, or test runner in this repo today.

## Swarm-Workflow Procedure

- For work that is truly multi-part (at least two independent workstreams) or explicitly requested as a swarm workflow, use the standard procedure in [docs/swarm-orchestration-procedure.md](docs/swarm-orchestration-procedure.md).
- If a task is single-file and single-owner, use direct execution unless the user explicitly requests subagents.
- When the SOP applies, first produce a scope split and assignment packets before editing.
- For shared-checkout work, the SOP's ownership, baseline, destructive-command, and commit/push gates are mandatory.
- Use the SOP for spawn, review, merge, and handoff decisions before coding.

## Project Map

- `claudeville/server.js` is the zero-dependency Node HTTP/WebSocket server. Port `4000` is hardcoded and assumed by docs, widget, and local workflow.
- `claudeville/index.html` loads vanilla ES modules and CSS directly.
- `claudeville/adapters/` normalizes Claude Code, Codex CLI, and Gemini CLI session logs.
- `claudeville/services/usageQuota.js` reads Claude account/activity/quota sources.
- `claudeville/src/config/` contains constants, theme, i18n, and building definitions.
- `claudeville/src/domain/` contains entities, value objects, and the event bus.
- `claudeville/src/application/` coordinates agents, modes, session watching, and notifications.
- `claudeville/src/infrastructure/` wraps REST and WebSocket access.
- `claudeville/src/presentation/` contains UI renderers and shared components.
- `widget/` contains the optional macOS menu bar app; `Sources/main.swift` polls `/api/sessions` and `/api/usage`, while `Resources/` contains widget HTML/CSS served by `server.js`.

## Server And APIs

- Static assets are served from `claudeville/`; `/widget.html` and `/widget.css` are served from `widget/Resources/`.
- REST endpoints: `GET /api/sessions`, `GET /api/session-detail?sessionId=&project=&provider=`, `GET /api/teams`, `GET /api/tasks`, `GET /api/providers`, `GET /api/usage`.
- WebSocket updates are served from `ws://localhost:4000`.
- The server watches detected provider paths and also broadcasts/polls every 2 seconds while clients are connected.

## Data Adapter Contracts

- Provider roots are read-only inputs: Claude Code `~/.claude/`, Codex CLI `~/.codex/sessions/`, Gemini CLI `~/.gemini/tmp/`.
- A machine may have any subset of providers installed. Empty provider lists and missing watch paths can be normal.
- Each adapter is registered in `claudeville/adapters/index.js` and must expose `name`, `provider`, `homeDir`, `isAvailable()`, `getWatchPaths()`, `getActiveSessions(activeThresholdMs)`, and `getSessionDetail(sessionId, project)`.
- Session objects must keep stable normalized fields used by `AgentManager`: `sessionId`, `provider`, `agentId`, `project`, `model`, `status`, `lastActivity`, `lastTool`, `lastToolInput`, `lastMessage`, and `tokenUsage`/`tokens`/`usage`.
- Token data is normalized to `input`, `output`, `cacheRead`, and `cacheCreate`. Preserve adapter-specific fallbacks because Claude, Codex, and Gemini logs use different field names and file formats.
- Detail responses should degrade to `{ toolHistory: [], messages: [] }` on missing data or adapter errors.

## Cost, Token, And Quota Caveats

- Cost display is an estimate from local token logs and static pricing tables in `Agent` and `ActivityPanel`; do not present it as billing truth.
- Cache-read/cache-create semantics differ by provider. Codex token counts may be cumulative `token_count` events or older per-turn usage payloads.
- Claude quota data comes from local files plus an Anthropic OAuth quota endpoint attempt in `usageQuota.js`; quota can be unavailable and must not break `/api/usage`.
- If pricing, quota, or provider log formats change, update code and notes together with a validation sample from the affected provider.

## Visual And Rendering Architecture

- Frontend is vanilla HTML/CSS/JavaScript with ES modules. Do not introduce a framework or build step for small changes.
- `claudeville/src/presentation/App.js` boots the world, data source, WebSocket client, managers, shared UI, and both render modes.
- World mode is Canvas 2D isometric rendering. `character-mode/IsometricRenderer.js` owns the render loop, terrain, agent hit tests, minimap, and event subscriptions; `Camera.js`, `AgentSprite.js`, `BuildingRenderer.js`, `ParticleSystem.js`, and `Minimap.js` are helpers.
- Dashboard mode is DOM/card rendering in `dashboard-mode/DashboardRenderer.js`.
- `docs/visual-experience-crafting.md` captures the transferable design logic behind the RPG world metaphor. Read it before doing major visual representation work here or adapting this approach elsewhere.
- Keep layout inside the existing flex structure: `body` full-height column, `header.topbar` fixed-height top, `.main__body` containing `aside.sidebar`, `.content`, and optional `aside#activityPanel`.
- `#activityPanel` is 320px wide and shrinks the content area when open. Do not use `position: fixed` for normal panels; modal and toast overlays are the exceptions.
- Character mode canvas should fill the remaining `.content` area. Dashboard mode scrolls vertically.

## Copy And Locale Policy

- Use English for new or edited UI copy, docs, comments, and agent-facing text.
- Do not add or expand non-English strings unless the task explicitly requests localization work.

## Validation Checklist

- Syntax smoke for server/adapters/services:
  - `node --check claudeville/server.js`
  - `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`
- Runtime smoke when server/API behavior changes:
  - Run `npm run dev`.
  - Visit `http://localhost:4000`.
  - Check `http://localhost:4000/api/providers` and `http://localhost:4000/api/sessions`.
  - Confirm the browser console is clean enough for the changed area.
- Visual smoke for rendering or layout changes:
  - Test both World and Dashboard modes.
  - Select/deselect an agent if sessions exist to open/close the right activity panel.
  - Resize the browser and confirm the canvas still fills the content area.
- Widget changes require macOS validation:
  - `npm run widget:build`
  - `npm run widget`
  - Confirm the menu bar app can reach port `4000`.
- For docs-only process edits, a diff review plus `git status --short` is sufficient.

## GitHub And Remotes

- `origin` is the working fork: `https://github.com/TokenBrice/claude-ville.git` for fetch and push.
- `upstream` is the source repo: `https://github.com/honorstudio/claude-ville.git` for fetch; push is disabled.
- Do not change remotes, branches, or fork workflow unless the task explicitly asks.

## Git Hygiene

- Re-run `git status --short` before editing, before committing, and before final response.
- Preserve unrelated local modifications and untracked files. Do not revert, stage, commit, delete, or format files outside the task scope.
- Do not delete generated local app-bundle files or `.playwright-cli/` unless explicitly asked.
- Do not run destructive commands such as `git reset --hard`, `git checkout --`, `git restore`, `git clean`, `rm -rf`, `git stash drop`, `git stash clear`, bulk formatters outside scope, `kill`, `pkill`, `killall`, or port-killing pipelines without explicit approval.
- Before committing, inspect the diff and ensure only intentional paths are included.
