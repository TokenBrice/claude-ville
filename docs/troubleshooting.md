# Troubleshooting

This guide covers the failure modes a new contributor or first-time user is most likely to hit during the first hour with ClaudeVille. Each entry names the symptom, gives the underlying cause, and either points at a fix or notes that the behavior is expected.

The dashboard observes local AI CLI session files. It writes nothing back to those CLIs. Most "missing data" symptoms therefore come from the upstream CLI not having produced data yet, not from a ClaudeVille bug.

## "No providers detected" / `/api/providers` returns `[]`

At least one provider home directory must exist: `~/.claude/`, `~/.codex/`, or `~/.gemini/`. The adapters in `claudeville/adapters/index.js` register providers by home-directory presence, not by whether session subdirectories already contain data. A fresh machine with none of these CLIs installed correctly returns an empty list.

Server log on startup will say:

```
[!] No active providers
    One of ~/.claude/, ~/.codex/, or ~/.gemini/ is required
```

Fix: install at least one of Claude Code, Codex, or Gemini and run a session so the provider home and session files are created. Then restart the server.

## Providers detected, but `/api/sessions` is empty

Only sessions whose last activity is within `ACTIVE_THRESHOLD_MS` are returned. The constant is defined in `claudeville/server.js` and is currently `2 * 60 * 1000` (two minutes). If you have not used the CLI in the last two minutes, the dashboard correctly shows nothing active.

Confirm by running a CLI command in a real session, then refresh `/api/sessions` within two minutes.

Provider scan windows also matter:

- Claude uses recent `history.jsonl` entries to find active sessions, then checks recent project/session files.
- Codex scans recent date folders under `~/.codex/sessions/YYYY/MM/DD/` and filters by file activity.
- Codex and Gemini detail lookup can search a wider window than the active-session list, so a detail URL may work for a session that no longer appears as active.

## WebSocket never connects / port 4000 collision (`EADDRINUSE`)

The port is hardcoded at `claudeville/server.js` (`const PORT = 4000;`). On startup, `server.on('error', ...)` prints `Port 4000 is already in use.` and the process stays up but cannot serve.

Find and stop the other process holding port 4000:

```bash
lsof -i :4000
# or
ss -ltnp | grep 4000
```

The widget, README, both `CLAUDE.md` files, and `widget/Resources/widget.html` all assume port 4000. See `docs/design-decisions.md` for why it is hardcoded.

If the browser shows a blank page but the port is open, first confirm there is only one listener:

```bash
ss -ltnp '( sport = :4000 )'
```

Stale `node claudeville/server.js` processes can make repeated curl/browser tests disagree. Do not kill a listener in a shared checkout unless ownership is clear and the user has approved process cleanup.

## Port is open, but `/` or `/api/sessions` hangs

Treat zero-byte HTTP timeouts as backend evidence before debugging canvas rendering:

```bash
curl -v -m 3 http://127.0.0.1:4000/
curl -v -m 3 http://127.0.0.1:4000/api/sessions
curl -v -m 3 http://127.0.0.1:4000/api/providers
```

If `/api/sessions` hangs, time adapter aggregation. The previous expensive path was Claude subagent discovery scanning broad `~/.claude/projects/*` trees. Benchmark `getAllSessions(120000)` and each adapter before changing frontend code.

If `/` hangs while `claudeville/index.html` is readable and `/api/providers` eventually returns JSON, inspect the static route handler in `server.js`. The root route should strip query strings, map `/` to `index.html`, stay inside the `claudeville/` static directory, and avoid stalled response streams.

## `/api/usage` returns nulls or partial data

`claudeville/services/usageQuota.js` pulls data from four sources:

1. `~/.claude/.credentials.json` for subscription metadata.
2. `~/.claude/stats-cache.json` and `~/.claude/history.jsonl` for activity counts.
3. `claude auth status` (run once at server startup) for the account email.
4. `https://api.anthropic.com/api/oauth/usage` for the 5h/7d quota figures.

Source 4 is documented as "currently unavailable; retry periodically" (`claudeville/services/usageQuota.js:8`). When it fails, the response still returns with `quota: { fiveHour: null, sevenDay: null }` and `quotaAvailable: false`. The other fields keep working. This is expected and non-fatal.

Credential and activity sources are cached briefly, and quota checks are best-effort. Missing local files, failed `claude auth status`, or failed Anthropic quota calls should return partial/null fields rather than breaking `/api/usage`.

## Cost numbers look wrong

Cost is computed locally from token counts in the session files multiplied by static per-million-token rates. The shared pricing and token normalization logic lives in `claudeville/src/domain/value-objects/TokenUsage.js`. The numbers are estimates, not billing truth, and they only cover models whose name contains a known substring (`opus`, `sonnet`, `haiku`, `gpt-5`, `gpt-5.3`, `gpt-5.4`, `gpt-5.5`). Unknown models fall back to a Sonnet- or `gpt-5`-shaped default.

If a model is missing or its price has changed, update `TokenUsage.js`, `widget/Sources/main.swift`, and `widget/Resources/widget.html`; then verify browser and widget cost displays. `Agent` and `ActivityPanel` both call `TokenUsage.estimateCost(...)` in the browser app.

## Widget shows "offline"

The Swift widget polls `http://localhost:4000/api/sessions` and `/api/usage` every five seconds. It can also auto-launch the server using two paths recorded in the bundle at build time:

- `ClaudeVilleWidget.app/Contents/Resources/project_path`
- `ClaudeVilleWidget.app/Contents/Resources/node_path`

Both are written by `widget/build.sh:25-27`. If you moved the repo or upgraded Node after building, those values are stale. Rebuild:

```bash
npm run widget:build
```

`widget/build.sh` recreates `widget/ClaudeVilleWidget.app`, so treat widget builds as generated-output changes in the shared checkout. Do not delete or rebuild the app bundle unless widget validation is in scope.

There are two widget HTML surfaces. The native menu-bar popover is generated inline in `widget/Sources/main.swift`; `widget/Resources/widget.html` is a static resource served by the local server and copied into the bundle. Editing `widget.html` alone may not change the native popover.

Before launching Node, the widget checks `http://localhost:4000/api/providers` and verifies the response looks like ClaudeVille. It only terminates a server process that it started itself.

## Desktop graphics reset or compositor crash while ClaudeVille is open

First distinguish an app crash from a system graphics-stack reset. On Linux/KWin/amdgpu systems, collect recent warning-level evidence:

```bash
journalctl -b --no-pager -p warning..alert | rg -i 'amdgpu|drm|gpu|reset|GL_CONTEXT|kwin|Xwayland|chrome|chromium|oom|killed process'
watch -n 1 'free -h; ps -eo pid,comm,%cpu,%mem,rss --sort=-rss | head -n 15'
```

ClaudeVille exposes lightweight browser/server counters for manual checks:

```js
window.__claudeVillePerf.canvasBudget()
```

```bash
curl http://localhost:4000/api/perf
```

If the journal shows GPU ring timeouts, compositor `GL_CONTEXT_LOST`, or Xwayland/browser core dumps without OOM-killer entries, treat it as a graphics-stack reset. ClaudeVille should reduce load by pausing World mode in Dashboard, releasing renderer-owned canvas caches, and capping canvas backing-store pixels, but driver/compositor resets can still originate below the app.

## Widget will not build

The widget is macOS only. `widget/build.sh` invokes `swiftc`, which requires the Xcode Command Line Tools. On Linux or Windows the build script will fail at the first compile step. There is no fallback for those platforms.

## Browser console errors after editing

There is no transpiler, bundler, or app test runner. A typo in any module aborts page startup with a console error pointing at the failing module. Run a server-side syntax check first:

```bash
node --check claudeville/server.js
find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check
```

For frontend modules, open the browser devtools console. There is no build step that would catch the error earlier.

## Sprite validation scripts fail with missing packages

Runtime does not require installed npm packages, but sprite validation and visual-diff scripts do. If `npm run sprites:validate`, `sprites:capture-*`, or `sprites:visual-diff` fails with `ERR_MODULE_NOT_FOUND`, run `npm install` when dependency installation is in scope.

If installing dependencies is out of scope, fall back to:

- Inspect `claudeville/assets/sprites/manifest.yaml` and `AssetManager._pathFor()`.
- Use `file` on touched PNGs to confirm dimensions and file type.
- Check for checkerboard placeholders in the browser, which indicate a missing/invalid sprite path.

`AssetManager` also loads `claudeville/assets/sprites/palettes.yaml`; keep it aligned with the `palettes` block in `manifest.yaml`. Bump `style.assetVersion` after changing PNGs if browser cache is suspected.

## Agent display name keeps changing

Names are deterministic from the agent ID hash via `Agent.generateNameForLang` (`claudeville/src/domain/entities/Agent.js:284`). Switching the UI language regenerates the displayed name from the same hash. Names assigned by a team are preserved because `_customName` is set when the agent is constructed with an explicit name (`claudeville/src/domain/entities/Agent.js:103`, honored in `claudeville/src/presentation/App.js:290` and `claudeville/src/application/AgentManager.js:114`).

If you renamed an agent in code and the rename was overwritten, check that the constructor received `name` and `_customName` is true on that instance.

## Server starts but the page fails to load static assets

`server.js` resolves the request URL inside `STATIC_DIR` and rejects anything outside that directory with `403 Forbidden`. Do not add symlinks pointing outside `claudeville/`; they will be refused.

## Required runtime: Node 18+, no Windows path support in adapters

The server uses `fs.watch({ recursive: true })`, `Buffer.readBigUInt64BE`, and built-in `URL`. Node 18+ is the practical floor.

The adapters target POSIX path conventions and have no `process.platform === 'win32'` branches. Linux and macOS are tested. Windows path normalization is not implemented today.

## "Empty array of providers" but `~/.claude/` exists

Provider activation is decided by directory existence, not by file content. If `~/.claude/` is present but empty, the Claude adapter still registers, and `/api/providers` will list it. `/api/sessions` will be empty because there are no JSONL files to read. Generate a session in the upstream CLI to populate it.
