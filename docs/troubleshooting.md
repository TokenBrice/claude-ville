# Troubleshooting

This guide covers the failure modes a new contributor or first-time user is most likely to hit during the first hour with ClaudeVille. Each entry names the symptom, gives the underlying cause, and either points at a fix or notes that the behavior is expected.

The dashboard observes local AI CLI session files. It writes nothing back to those CLIs. Most "missing data" symptoms therefore come from the upstream CLI not having produced data yet, not from a ClaudeVille bug.

## "No providers detected" / `/api/providers` returns `[]`

At least one of `~/.claude/`, `~/.codex/sessions/`, or `~/.gemini/tmp/` must exist. The adapters in `claudeville/adapters/index.js` register only providers whose home directory is present. A fresh machine with none of these CLIs installed correctly returns an empty list.

Server log on startup will say:

```
[!] No active providers
    One of ~/.claude/, ~/.codex/, or ~/.gemini/ is required
```

Fix: install at least one of Claude Code, Codex, or Gemini and run a session so the directory is created. Then restart the server.

## Providers detected, but `/api/sessions` is empty

Only sessions whose last activity is within `ACTIVE_THRESHOLD_MS` are returned. The constant is defined at `claudeville/server.js:24` and is currently `2 * 60 * 1000` (two minutes). If you have not used the CLI in the last two minutes, the dashboard correctly shows nothing active.

Confirm by running a CLI command in a real session, then refresh `/api/sessions` within two minutes.

## WebSocket never connects / port 4000 collision (`EADDRINUSE`)

The port is hardcoded at `claudeville/server.js:22` (`const PORT = 4000;`). On startup, `server.on('error', ...)` (`claudeville/server.js:609-615`) prints `Port 4000 is already in use.` and the process stays up but cannot serve.

Find and stop the other process holding port 4000:

```bash
lsof -i :4000
# or
ss -ltnp | grep 4000
```

The widget, README, both `CLAUDE.md` files, `widget/Sources/main.swift:41-42, 408`, and `widget/Resources/widget.html:77, 303` all assume port 4000. See `docs/design-decisions.md` for why it is hardcoded.

## `/api/usage` returns nulls or partial data

`claudeville/services/usageQuota.js` pulls data from four sources:

1. `~/.claude/.credentials.json` for subscription metadata.
2. `~/.claude/stats-cache.json` and `~/.claude/history.jsonl` for activity counts.
3. `claude auth status` (run once at server startup) for the account email.
4. `https://api.anthropic.com/api/oauth/usage` for the 5h/7d quota figures.

Source 4 is documented as "currently unavailable; retry periodically" (`claudeville/services/usageQuota.js:8`). When it fails, the response still returns with `quota: { fiveHour: null, sevenDay: null }` and `quotaAvailable: false`. The other fields keep working. This is expected and non-fatal.

## Cost numbers look wrong

Cost is computed locally from token counts in the session files multiplied by static per-million-token rates. The tables live in `claudeville/src/domain/entities/Agent.js:57-75` and `claudeville/src/presentation/shared/ActivityPanel.js:215-233`. They are estimates, not billing truth, and they only cover models whose name contains a known substring (`opus`, `sonnet`, `haiku`, `gpt-5`, `gpt-5.3`, `gpt-5.4`, `gpt-5.5`). Unknown models fall back to a Sonnet- or `gpt-5`-shaped default.

If a model is missing or its price has changed, edit both tables. They are duplicated on purpose; see `docs/design-decisions.md`.

## Widget shows "offline"

The Swift widget polls `http://localhost:4000/api/sessions` and `/api/usage` every three seconds (`widget/Sources/main.swift:35`). It can also auto-launch the server using two paths recorded in the bundle at build time:

- `ClaudeVilleWidget.app/Contents/Resources/project_path`
- `ClaudeVilleWidget.app/Contents/Resources/node_path`

Both are written by `widget/build.sh:25-27`. If you moved the repo or upgraded Node after building, those values are stale. Rebuild:

```bash
npm run widget:build
```

## Widget will not build

The widget is macOS only. `widget/build.sh` invokes `swiftc`, which requires the Xcode Command Line Tools. On Linux or Windows the build script will fail at the first compile step. There is no fallback for those platforms.

## Browser console errors after editing

There is no transpiler, bundler, or test runner. A typo in any module aborts page startup with a console error pointing at the failing module. Run a server-side syntax check first:

```bash
node --check claudeville/server.js
find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check
```

For frontend modules, open the browser devtools console. There is no build step that would catch the error earlier.

## Agent display name keeps changing

Names are deterministic from the agent ID hash via `Agent.generateNameForLang` (`claudeville/src/domain/entities/Agent.js:122-130`). Switching the UI language regenerates the displayed name from the same hash. Names assigned by a team are preserved because `_customName` is set when the agent is constructed with an explicit name (`claudeville/src/domain/entities/Agent.js:15`, honored in `claudeville/src/presentation/App.js:233` and `claudeville/src/application/AgentManager.js:100`).

If you renamed an agent in code and the rename was overwritten, check that the constructor received `name` and `_customName` is true on that instance.

## Server starts but the page fails to load static assets

`server.js` resolves the request URL inside `STATIC_DIR` (`claudeville/server.js:217-222`) and rejects anything outside that directory with `403 Forbidden`. Do not add symlinks pointing outside `claudeville/`; they will be refused.

## Required runtime: Node 18+, no Windows path support in adapters

The server uses `fs.watch({ recursive: true })`, `Buffer.readBigUInt64BE`, and built-in `URL`. Node 18+ is the practical floor.

The adapters target POSIX path conventions and have no `process.platform === 'win32'` branches. Linux and macOS are tested. Windows path normalization is not implemented today.

## "Empty array of providers" but `~/.claude/` exists

Provider activation is decided by directory existence, not by file content. If `~/.claude/` is present but empty, the Claude adapter still registers, and `/api/providers` will list it. `/api/sessions` will be empty because there are no JSONL files to read. Generate a session in the upstream CLI to populate it.
