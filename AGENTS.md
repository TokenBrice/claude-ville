# Agent Notes

`AGENTS.md` is the canonical agent-context file for this repo, mirrored byte-for-byte (after the heading) by `CLAUDE.md` so Claude Code's auto-loader sees the same content. When the two diverge, `AGENTS.md` wins; edit both together.

## Agent Harness Map

| Harness | Auto-loads | Notes |
| --- | --- | --- |
| Codex CLI | `AGENTS.md` (root) | Canonical source. Nested `claudeville/CLAUDE.md` is also worth reading for in-app work. |
| Claude Code | `CLAUDE.md` (root) plus nested `claudeville/CLAUDE.md` | Auto-walks the parent CLAUDE.md chain. |
| Other agents | Start at `AGENTS.md`, then `claudeville/CLAUDE.md`. | |

This repo is agent-first: arriving agents should treat the root `AGENTS.md`/`CLAUDE.md` and the in-app `claudeville/CLAUDE.md` as the ground truth before reading code.

## Agent Artifacts

- Plans, scratch notes, and handover memos written by agents go under `/agents/` and are committed.
- Use `/agents/plans/<slug>.md` for implementation plans and `/agents/handover/<slug>.md` for handovers.
- `docs/plans/` is gitignored personal scratch — do not put shared work there.

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
- Runtime has no install step, bundler, transpiler, or app test runner. Run `npm install` only when development scripts need declared dev dependencies (`sprites:validate`, sprite visual diffs, or Playwright capture helpers).

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
- `scripts/sprites/` contains sprite manifest validation, screenshot capture, and visual-diff helpers.
- `widget/` contains the optional macOS menu bar app; `Sources/main.swift` polls `/api/sessions` and `/api/usage`, renders the native popover inline, and can launch the server. `Resources/` contains static widget HTML/CSS served by `server.js` and copied into the app bundle.
- For deeper implementation context inside `claudeville/`, see [`claudeville/CLAUDE.md`](claudeville/CLAUDE.md).

## Server And APIs

- Static assets are served from `claudeville/`; `/widget.html` and `/widget.css` are served from `widget/Resources/`.
- REST endpoints: `GET /api/sessions`, `GET /api/session-detail?sessionId=&project=&provider=`, `GET /api/teams`, `GET /api/tasks`, `GET /api/providers`, `GET /api/usage`.
- WebSocket updates are served from `ws://localhost:4000`.
- The server watches detected provider paths; a 2-second interval also runs unconditionally, and its broadcast is a no-op when no clients are connected.
- `claudeville/adapters/index.js` applies short TTL caches to session lists and session details to protect the 2-second poll path and coalesce duplicate Dashboard/Activity Panel detail fetches.

## Known Pitfalls And Prior Learnings

- If the UI is blank but port `4000` is open, test `http://127.0.0.1:4000/api/sessions` and time adapter work before touching canvas rendering. A prior outage looked like a black canvas but was caused by slow backend session discovery.
- Before trusting curl/browser results, confirm there is only one listener on port `4000` with `ss -ltnp '( sport = :4000 )'`. Stale `node claudeville/server.js` listeners previously made root-route debugging inconsistent.
- For startup/API hangs, benchmark `getAllSessions(120000)` and each provider adapter. The previous slow path was `claudeville/adapters/claude.js` scanning all `~/.claude/projects/*` subagent trees; narrowing the scan to active session IDs restored first-call latency from seconds to roughly 100ms.
- A hanging `/` with readable `claudeville/index.html` and eventually healthy `/api/providers` usually points at the static route/handler path, not missing assets. The root handler should strip query strings, map `/` to `index.html`, and serve text assets without leaving stalled streams.
- For renderer hardening, known worthwhile follow-ups are `worldCanvas` mount retry logic in `App.js`, idempotent `IsometricRenderer.show()`, shared in-flight session-detail dedupe, sprite sort caching, and minimap/static-layer caching.
- For Pixellab work, prove the MCP path with a minimal asset before broad sprite edits. Direct JSON-RPC over HTTP works: `initialize` -> `tools/list` -> `tools/call` for `create_isometric_tile` -> poll `get_isometric_tile` -> download with `curl --fail`.
- `scripts/sprites/generate.md` is the sprite-generation runbook, while `claudeville/assets/sprites/manifest.yaml` is the prompt/size source of truth. `AssetManager._pathFor()` defines where each manifest ID must land on disk.
- Do not treat current `736x920` character sheets as invalid just because they are not `64x64`; `SpriteSheet.js` uses `DEFAULT_CELL = 92` with an 8-column by 10-row layout.
- The strongest sprite-regeneration candidates are manifest/renderer contract mismatches and globally visible UI assets. Prior high-signal targets included `overlay.status.selected`, then `size: 32` props checked in as larger files such as `prop.lantern` and `prop.signpost`.
- If `npm run sprites:validate` fails because local `js-yaml` is missing, fall back to manifest/code inspection plus `file` dimension checks instead of blocking the whole pass.

## Data Adapter Contracts

- Provider roots are read-only inputs: Claude Code `~/.claude/`, Codex CLI `~/.codex/sessions/`, Gemini CLI `~/.gemini/tmp/`.
- A machine may have any subset of providers installed. Empty provider lists and missing watch paths can be normal.
- Each adapter is registered in `claudeville/adapters/index.js` and must expose `name`, `provider`, `homeDir`, `isAvailable()`, `getWatchPaths()`, `getActiveSessions(activeThresholdMs)`, and `getSessionDetail(sessionId, project)`.
- Session objects must keep stable normalized fields used by `AgentManager`: `sessionId`, `provider`, `agentId`, `project`, `model`, `status`, `lastActivity`, `lastTool`, `lastToolInput`, `lastMessage`, and `tokenUsage`/`tokens`/`usage`.
- Sessions may include `gitEvents`, extracted from provider tool logs by `claudeville/adapters/gitEvents.js`. Events are backend-observed `commit`/`push` commands only; dry-runs are omitted, and provider support for completion metadata varies.
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
- World mode is sprite-based pixel-art Canvas 2D isometric rendering. `character-mode/IsometricRenderer.js` owns render loop orchestration; `Camera.js` manages pan/zoom (clamped to integer steps {1,2,3}), follow behavior; `AgentSprite.js` manages state and animation; `BuildingSprite.js`, `TerrainTileset.js`, `SpriteRenderer.js`, `Compositor.js`, and `SpriteSheet.js` handle sprite blits and asset composition.
- Dashboard mode is DOM/card rendering in `dashboard-mode/DashboardRenderer.js`.
- `docs/visual-experience-crafting.md` captures the transferable design logic behind the RPG world metaphor. Read it before doing major visual representation work here or adapting this approach elsewhere.
- Keep layout inside the existing flex structure: `body` full-height column, `header.topbar` fixed-height top, `.main__body` containing `aside.sidebar`, `.content`, and optional `aside#activityPanel`.
- `#activityPanel` is 320px wide and shrinks the content area when open. Do not use `position: fixed` for normal panels; modal and toast overlays are the exceptions.
- World mode canvas should fill the remaining `.content` area. Dashboard mode scrolls vertically.
- Pixel-art sprites are generated via the pixellab MCP server; the asset manifest at `claudeville/assets/sprites/manifest.yaml` is the single source of truth. `claudeville/assets/sprites/palettes.yaml` mirrors the manifest palette block for tooling and must stay in sync when palettes change.
- `Minimap.js` uses intentionally vector parchment art and is out of scope for the pixel-art migration.

## Browser Automation

Two browser tools are available. Pick the right one:

- **`playwright` MCP** — isolated Chromium with proper wait primitives (`waitForLoadState`, networkidle). Use for design/build loops, screenshots, inspecting rendered output, and any flow where page-load reliability matters.
- **`claude-in-chrome`** — bridges to the user's real Chrome via extension. Use when you need authenticated sessions, existing tab context, or to look at a page the user already has open.

## Copy And Locale Policy

- Use English for new or edited UI copy, docs, comments, and agent-facing text.
- Do not add or expand non-English strings unless the task explicitly requests localization work.

## Sprite Generation

Pixel-art sprites are generated through the [pixellab MCP server](https://mcpservers.org/servers/pixellab-code/pixellab-mcp). The asset manifest at `claudeville/assets/sprites/manifest.yaml` is the single source of truth — every sprite the renderer references must have a corresponding manifest entry, and every PNG on disk must correspond to a manifest entry.

Workflow:

1. User installs the pixellab MCP server with their API token (`claude mcp add --transport http pixellab https://api.pixellab.ai/mcp --header "Authorization: Bearer YOUR_TOKEN"`).
2. Claude Code session reads `manifest.yaml`, calls the appropriate MCP tool per entry (`mcp__pixellab__create_character`, `mcp__pixellab__animate_character`, `mcp__pixellab__create_topdown_tileset`, `mcp__pixellab__create_isometric_tile`).
3. Resulting PNGs are saved to the manifest-implied path (see `AssetManager._pathFor` for the mapping).
4. Run `npm run sprites:validate` to confirm every manifest entry resolves to a real PNG and no orphan PNGs exist.

The `style.anchor` field at the top of `manifest.yaml` is concatenated into every prompt at generation time, locking the visual tone across all assets.
The `style.assetVersion` field is used as a cache-busting query string by `AssetManager`; bump it when changing sprite PNGs that browsers may cache.

For pixellab tool selection, parameter enums, animation templates, async lifecycle, and pitfalls, see [`docs/pixellab-reference.md`](docs/pixellab-reference.md).

For full asset generation steps see `scripts/sprites/generate.md`.

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
- Asset validation:
  - `npm install` first if `node_modules/` is missing and asset validation is in scope.
  - `npm run sprites:validate` — manifest ↔ PNG bidirectional check.
  - `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` — pixelmatch baseline comparison.
- Widget changes require macOS validation:
  - `npm run widget:build`
  - `npm run widget`
  - Confirm the menu bar app can reach port `4000`.
- For docs-only process edits, a diff review plus `git status --short` is sufficient.
- For changes to the root agent docs (`AGENTS.md` or `CLAUDE.md`), confirm parity with `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` — output should be empty.

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
