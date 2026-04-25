# Agent Notes

## Scope And Ownership

- Work from `/home/ahirice/Documents/git/claude-ville`.
- This repo is often edited by multiple agents. Check `git status --short` before changing files and do not revert or absorb unrelated edits.
- Keep changes narrowly scoped. If the task says to edit one file, edit only that file.
- Prefer `rg`/`rg --files` for discovery.

## Project Shape

- `package.json` has no install step and only three scripts: `dev`, `widget:build`, and `widget`.
- `claudeville/` is the browser dashboard and Node server.
  - `server.js` is a zero-dependency Node HTTP/WebSocket server.
  - `index.html` loads vanilla ES modules and CSS directly.
  - `adapters/` normalizes local CLI logs for Claude Code, Codex CLI, and Gemini CLI.
  - `services/usageQuota.js` provides account/quota data.
  - `src/config/` holds constants, theme, i18n, and building definitions.
  - `src/domain/` holds entities, value objects, and the event bus.
  - `src/application/` coordinates agents, modes, session watching, and notifications.
  - `src/infrastructure/` wraps REST/WebSocket access.
  - `src/presentation/` contains UI renderers and shared components.
- `widget/` is the optional macOS menu bar app.
  - `Sources/main.swift` polls `http://localhost:4000/api/sessions` and `/api/usage`.
  - `Resources/` contains the widget HTML/CSS served by `server.js`.
  - `build.sh` compiles the Swift app and writes local `project_path` and `node_path` into the app bundle.

## Run Commands

- Start the dashboard: `npm run dev`
- Open the app at `http://localhost:4000`.
- Build the macOS widget: `npm run widget:build`
- Launch the widget: `npm run widget`
- There is no package install, bundler, transpiler, or test runner in this repo today.

## Local Server Details

- The dashboard server is hardcoded to port `4000` in `claudeville/server.js`. Do not change it casually; the README, widget, and local workflow assume it.
- Static assets are served from `claudeville/`; `/widget.html` and `/widget.css` are served from `widget/Resources/`.
- API endpoints include:
  - `GET /api/sessions`
  - `GET /api/session-detail?sessionId=&project=&provider=`
  - `GET /api/teams`
  - `GET /api/tasks`
  - `GET /api/providers`
  - `GET /api/usage`
- WebSocket updates are served from `ws://localhost:4000`.
- The server watches detected provider paths and also broadcasts/polls every 2 seconds when clients are connected.

## Data Sources

- Claude Code: `~/.claude/`
- Codex CLI: `~/.codex/sessions/`
- Gemini CLI: `~/.gemini/tmp/`
- Adapter availability is automatic. A machine may have any subset of these providers installed, so empty provider lists can be normal.
- Treat local CLI session files as read-only input.

## Visual And Rendering Architecture

- Frontend is vanilla HTML/CSS/JavaScript with ES modules. Do not introduce a framework or build step for small changes.
- `claudeville/src/presentation/App.js` boots the world, data source, WebSocket client, managers, shared UI, and both render modes.
- World mode is Canvas 2D isometric rendering:
  - `character-mode/IsometricRenderer.js` owns the render loop, terrain, agent hit tests, minimap, and event subscriptions.
  - `Camera.js`, `AgentSprite.js`, `BuildingRenderer.js`, `ParticleSystem.js`, and `Minimap.js` are the rendering helpers.
  - Constants such as tile size, map size, refresh interval, and reconnect interval live in `src/config/constants.js`.
- Dashboard mode is DOM/card rendering in `dashboard-mode/DashboardRenderer.js`.
- Keep layout inside the existing flex structure:
  - `body` is a full-height column.
  - `header.topbar` is fixed-height at the top.
  - `.main__body` contains `aside.sidebar`, `.content`, and optional `aside#activityPanel`.
  - `#activityPanel` is 320px wide and shrinks the content area when open.
- Do not use `position: fixed` for normal UI panels. Modal and toast overlays are the exceptions.
- Character mode canvas should fill the remaining `.content` area. Dashboard mode scrolls vertically.

## Validation

- Basic syntax smoke:
  - `node --check claudeville/server.js`
  - `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`
- Runtime smoke:
  - Run `npm run dev`.
  - Visit `http://localhost:4000`.
  - Check `http://localhost:4000/api/providers` and `http://localhost:4000/api/sessions`.
  - Confirm the browser console is clean enough for the changed area.
- Visual smoke for rendering or layout changes:
  - Test both World and Dashboard modes.
  - Open/close the right activity panel by selecting/deselecting an agent if sessions exist.
  - Resize the browser and confirm the canvas still fills the content area.
- Widget changes require macOS validation:
  - `npm run widget:build`
  - `npm run widget`
  - Confirm the menu bar app can reach port `4000`.

## Git Hygiene

- Preserve unrelated local modifications. This checkout may already be dirty.
- Do not delete generated local app-bundle files or `.playwright-cli/` unless the task explicitly asks for cleanup.
- Do not run destructive git commands such as `git reset --hard` or `git checkout --` without explicit user approval.
- Before committing, re-run `git status --short` and ensure only intentional files are included.

