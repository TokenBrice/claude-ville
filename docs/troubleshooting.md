# Troubleshooting

This guide covers the failure modes a new contributor or first-time user is most likely to hit during the first hour with ClaudeVille. Each entry names the symptom, gives the underlying cause, and either points at a fix or notes that the behavior is expected.

The dashboard observes local AI CLI session files. It writes nothing back to those CLIs. Most "missing data" symptoms therefore come from the upstream CLI not having produced data yet, not from a ClaudeVille bug.

## "No providers detected" / `/api/providers` returns `[]`

At least one provider source must exist and be readable: `~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.grok/`, `~/.kimi/`, or `~/.local/share/opencode/opencode.db`. Most adapters register by home-directory presence, not by whether session subdirectories already contain data. OpenCode is stricter: the database must exist and either Node's `node:sqlite` support or the `sqlite3` CLI must be available for read-only access. A fresh machine with none of these CLIs installed correctly returns an empty list.

Server log on startup will say:

```
[!] No active providers
    One of ~/.claude/, ~/.codex/, ~/.gemini/, ~/.grok/, ~/.kimi/, or ~/.local/share/opencode/ is required
```

Fix: install at least one supported CLI and run a session so the provider home and session files are created. Then restart the server.

## Providers detected, but `/api/sessions` is empty

Only sessions whose last activity is within `ACTIVE_THRESHOLD_MS` are returned. The constant is defined in `claudeville/server.js` and is currently `2 * 60 * 1000` (two minutes). If you have not used the CLI in the last two minutes, the dashboard correctly shows nothing active.

Confirm by running a CLI command in a real session, then refresh `/api/sessions` within two minutes.

Provider scan windows also matter:

- Claude uses recent `history.jsonl` entries to find active sessions, then checks recent project/session files.
- Codex scans recent date folders under `~/.codex/sessions/YYYY/MM/DD/` and filters by file activity.
- Gemini reads recent chat JSON files under `~/.gemini/tmp/<project_hash>/chats/`.
- Kimi reads recent legacy `~/.kimi/sessions/<project_hash>/<session_uuid>/wire.jsonl` data and resolves project hashes from Kimi config and common local work directories. Kimi Code sessions are read from `~/.kimi-code/sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl` and mapped back to projects through `~/.kimi-code/session_index.jsonl`.
- OpenCode reads recent rows from `~/.local/share/opencode/opencode.db` in read-only mode.
- Some detail lookups can search a wider window than the active-session list, so a detail URL may work for a session that no longer appears as active.

Repository-only `git` sessions can also appear when git enrichment detects unpushed or pushed GitHub repository activity outside a live provider session. That scan defaults to `~/Documents/git`, can be narrowed with `CLAUDEVILLE_REPOSITORY_SCAN_ROOT`, capped with `CLAUDEVILLE_REPOSITORY_SCAN_MAX`, and disabled with `CLAUDEVILLE_DISABLE_GIT_ENRICHMENT=1`. Synthetic git session detail returns a reason string rather than a provider transcript.

## Permission prompts are inferred or arrive late

Transcript parsing remains the default and requires no configuration. An elapsed tool duration never proves a permission prompt: long builds remain work, while explicit question/review tools and approval hooks provide waiting evidence. The route accepts the normalized schema `{ provider, sessionId, cwd, ts, kind, tool, input, decision? }` at `POST /api/ingest/hook`, keeps at most 256 sessions in memory, and never persists or logs request bodies. `kind` must be a supported lifecycle event such as `PreToolUse`, `PostToolUse`, or `Stop`. `input` may contain only operator-facing command/path context; displayed detail is secret-stripped and capped at 200 characters. This is the canonical payload schema; other documentation should link here instead of duplicating it.

All examples use `curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook` and, where supported, an asynchronous hook so a stopped dashboard does not block the CLI. They require `jq`. If ClaudeVille runs with `CLAUDEVILLE_INGEST_TOKEN`, export the same value into the CLI environment; the helpers always send it in `X-ClaudeVille-Ingest-Token` (an empty value is harmless when the server token is unset).

This repository dogfoods Claude Code ingestion through the committed `.claude/settings.json`. It is inert unless Claude Code is launched with `CLAUDEVILLE_DOGFOOD_HOOKS=1`; if the server requires authentication, also export `CLAUDEVILLE_INGEST_TOKEN`. The hook maps `session_id` to `sessionId`, preserves the accepted `hook_event_name` as `kind`, and forwards only `tool_name`, `cwd`, a reception-time `ts`, and the first available `tool_input.command`, `file_path`, `pattern`, or `description`. Prompts, transcript paths, file contents, tool results, and all other input fields are discarded before the request. The built-in request times out after 150 ms and always fails open, so a stopped dashboard cannot block Claude Code.

For Codex CLI lifecycle hooks, save the analogous executable helper as `~/.config/claudeville/ingest-codex-hook`:

```sh
#!/bin/sh
jq -c '{
  provider: "codex",
  sessionId: .session_id,
  cwd: .cwd,
  ts: (now * 1000 | floor),
  kind: .hook_event_name,
  tool: (.tool_name // null),
  input: ((.tool_input.command? // .tool_input.file_path? // .tool_input.path? // .tool_input.description? // null) | if type == "string" then .[0:200] else . end),
  decision: (.permission_mode // null)
}' | curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook \
  -H 'Content-Type: application/json' \
  -H "X-ClaudeVille-Ingest-Token: ${CLAUDEVILLE_INGEST_TOKEN:-}" \
  --data-binary @- >/dev/null 2>&1 || true
```

Add these Bash lifecycle entries to your own `~/.codex/hooks.json`; Codex only emits `PreToolUse`/`PostToolUse` for Bash in the verified CLI payload, while `PermissionRequest` is the exact approval signal.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }],
    "PermissionRequest": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }],
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }]
  }
}
```

Codex's legacy `notify` setting is a different interface: it passes one argv JSON object with kebab-case keys. Save this executable helper as `~/.config/claudeville/ingest-codex-notify`; it maps `thread-id` to `sessionId` and `type` to `kind` without sending `input-messages` or assistant text:

```sh
#!/bin/sh
printf '%s' "$1" | jq -c '{
  provider: "codex",
  sessionId: ."thread-id",
  cwd: .cwd,
  ts: (now * 1000 | floor),
  kind: .type,
  tool: null,
  input: null,
  decision: null
}' | curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook \
  -H 'Content-Type: application/json' \
  -H "X-ClaudeVille-Ingest-Token: ${CLAUDEVILLE_INGEST_TOKEN:-}" \
  --data-binary @- >/dev/null 2>&1 || true
```

Point the legacy `notify` array in your own `~/.codex/config.toml` at that helper, using its absolute path (Codex appends the one JSON argument):

```toml
notify = ["/bin/sh", "/home/YOU/.config/claudeville/ingest-codex-notify"]
```

Its verified `approval-requested` type produces an exact wait signal, but it has no verified tool input, so it cannot add command/path detail by itself.

Gemini CLI's verified [`BeforeTool` and `AfterTool` hooks](https://geminicli.com/docs/hooks/reference/) carry `session_id`, `cwd`, `hook_event_name`, `tool_name`, and `tool_input`. Save this executable helper as `~/.config/claudeville/ingest-gemini-hook`:

```sh
#!/bin/sh
jq -c '{
  provider: "gemini",
  sessionId: .session_id,
  cwd: .cwd,
  ts: (now * 1000 | floor),
  kind: .hook_event_name,
  tool: (.tool_name // null),
  input: ((.tool_input.command? // .tool_input.file_path? // .tool_input.path? // .tool_input.query? // .tool_input.pattern? // .tool_input.description? // null) | if type == "string" then .[0:200] else . end),
  decision: null
}' | curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook \
  -H 'Content-Type: application/json' \
  -H "X-ClaudeVille-Ingest-Token: ${CLAUDEVILLE_INGEST_TOKEN:-}" \
  --data-binary @- >/dev/null 2>&1 || true
```

Add both events to your own Gemini CLI `settings.json`. Gemini hook timeouts are milliseconds, so `1000` matches the curl cap:

```json
{
  "hooks": {
    "BeforeTool": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-gemini-hook", "timeout": 1000 }]
    }],
    "AfterTool": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-gemini-hook", "timeout": 1000 }]
    }]
  }
}
```

`BeforeTool` maps to a transient `tool_pending` overlay with the sanitized command/path detail. `AfterTool` clears that pending state back to working.

If the overlay does not appear, POST one normalized fixture with `curl`, confirm a `202` response, and fetch `/api/sessions` immediately. A `401` means the token header does not match; `403`/`421` means the Origin/Host is not local; `400` means the provider, event, session id, or JSON is invalid. Match the returned public session, not just the HTTP acceptance: Codex hook thread IDs and Gemini payload session IDs can differ from dashboard filename IDs, and matching is provider-qualified. Ordinary overlays stop merging after 10 seconds and expire after 30 seconds. Exact unanswered approvals instead become last-observed waits after 10 seconds; a resolving hook/newer recorded turn clears them, and a 30-minute bound prevents indefinite retention.

## WebSocket never connects / port 4000 collision (`EADDRINUSE`)

The port is hardcoded at `claudeville/server.js` (`const PORT = 4000;`). On startup, `server.on('error', ...)` prints `Port 4000 is already in use.` and the process stays up but cannot serve.

Find and stop the other process holding port 4000:

```bash
lsof -i :4000
# or
ss -ltnp | grep 4000
```

The README and both `CLAUDE.md` files assume port 4000. See `docs/design-decisions.md` for why it is hardcoded.

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

Cost is computed locally from token counts in session files multiplied by static per-million-token rates. `claudeville/src/config/models.json` is the canonical source for pricing, model aliases, and provider defaults; generated ESM and CommonJS resolvers keep browser and server estimates aligned. The numbers are estimates, not billing truth. DeepSeek-backed OpenCode sessions still use `provider: "opencode"` but resolve DeepSeek rates from the model string. OMP sessions backed by z.AI keep `provider: "omp"` but resolve GLM 5.3 / GLM 5.3 Flash rates and the `zai` identity from the model string, which surfaces as `zai/glm-*` from the `model_change` record or as the bare `glm-*` id once assistant messages arrive. Grok sessions currently surface cumulative `contextWindow` occupancy from ACP metadata rather than a full input/output split, so estimated cost often stays near zero until richer usage is written on disk. An unmatched model uses its provider's `defaults` entry.

If a model is missing or its price has changed, update one row in `claudeville/src/config/models.json`, run `npm run models:generate`, inspect it with `npm run models:resolve <provider> <model>`, and run the model registry and pricing tests before verifying browser and `/api/sessions` cost displays.

## World looks flatter than the screenshots, runs the Canvas renderer, or you need a different GPU backend

ClaudeVille picks the World backend once per page load. In Chrome and other Chromium browsers with a hardware GPU it draws the WebGPU world; in Safari and Firefox, and in Chrome whenever WebGPU cannot start (no adapter, a failed device or pipeline), it draws the resident WebGL2 world. Both draw the same picture on an SDR screen. The first boot after a browser, driver or ClaudeVille shader update may open on WebGL2 while the WebGPU shaders compile and switch to WebGPU a few seconds later; nothing on screen changes.

ClaudeVille draws a GPU world only on a hardware rasterizer. When the browser's WebGL2 runs on a software rasterizer, or its only WebGPU adapter is a fallback (software) one, the World uses the Canvas renderer instead. Software rasterizers include SwiftShader (hardware acceleration off, a blocklisted GPU, headless Chromium, many VMs and remote desktops), llvmpipe/lavapipe (Linux without a GPU driver) and the Microsoft Basic Render Driver. On a software rasterizer the resident shaders stall the first frame for seconds and then hold the page at a few frames per second. To check which backend is active and why:

```js
window.__claudeVilleApp.renderer.worldRendererMode    // 'webgpu', 'webgl' or 'canvas'
window.__claudeVilleApp.renderer.worldBackendReason   // e.g. 'default · webgpu ready · webgl2 hardware'
```

The same selection opens the Shift-D overlay as short rows: `world backend: <mode> · <selection>`, then `session: …` when a session policy overrode the selection (the GPU-crash Canvas world below), `webgpu: …` and `webgl2: …`; the console logs the full line once per change (`[IsometricRenderer] world backend: …`). Under the GPU world's rows, `display:` names HDR, P3 and the dynamic range, `canvas:` the configured canvas format, colour space and tone mapping, and `gpu errors outside the frame: N` counts GPU errors the World did not cause (the browser's own work on the device, such as its copy of the canvas for a page readback): they are logged, never a World failure.

If the WebGPU world fails while running (a frame throws, its own frame work raises a validation or out-of-memory error, or its device is destroyed or cannot be rebuilt), the World switches to a fresh WebGL2 world and the reason reads `webgpu failed in frame: <stage>: <message>`. A failure found between frames (a validation error, a destroyed device) holds the last presented frame for about half a second while the WebGL2 world builds and the terrain re-bakes off the frame, then switches; a frame that throws is drawn again on WebGL2 in the same task. Nothing black or half-drawn is presented either way. Without WebGL2 it stays on the Canvas world (`… · WebGL2 unavailable`). A plain WebGPU device loss the browser causes (`reason: 'unknown'`) rebuilds the device in place instead.

To force a backend, add a URL flag (an explicit flag always wins):

- `?renderer=webgl` forces the WebGL2 world on any WebGL2 browser (slow on a software rasterizer). Use it if the WebGPU world misbehaves in Chrome.
- `?renderer=canvas` forces the Canvas world; `?postfx=0` gives the Canvas world with no GPU layer at all.
- `?renderer=webgpu` forces the WebGPU world where it can start (the opt-in in Safari); if it cannot start, the World falls back to WebGL2, then Canvas.

To confirm the rasterizer, open `chrome://gpu`: look for "WebGL: Software only", "WebGPU: Disabled" or a SwiftShader renderer. Turning on "Use graphics acceleration when available" (Chrome settings, System) and restarting the browser brings the GPU world back. Headless Playwright captures get a GPU world only with `--use-angle=metal --ignore-gpu-blocklist --enable-gpu-rasterization` (macOS; `GPU_LAUNCH_ARGS` in `scripts/smoke/support/world-bench.mjs`), which gives WebGPU by default, or with `?renderer=webgl`; plain headless Chromium has no WebGPU adapter and captures the Canvas world.

**Settings → HDR highlights by backend.** Only the WebGPU world presents HDR. On WebGPU the row is live: on an HDR screen (`(dynamic-range: high)`) Subtle or Full lets lamps, fires, action-needed marks and release moments glow brighter than white (lamp halos are dropped while HDR shows), and on an SDR screen it says the screen gets the standard picture; the copy follows the screen while Settings is open. Safari's opt-in WebGPU has no extended canvas tone mapping: after its first HDR attempt the row is disabled with "This browser cannot show HDR on a web page". On WebGL2 (Safari, Firefox, `?renderer=webgl`, or Chrome while WebGPU cannot start) and on Canvas the row is disabled with "Needs the WebGPU renderer": those renderers always show the standard picture. A disabled row stays in the tab order (`aria-disabled`, its reason as the description) so keyboard and screen-reader users hear why. A Display P3 screen gets the wider-gamut status and lamp colours on either GPU world, and the overlay's reserved inks drop back to sRGB when the window moves to an sRGB screen.

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

**A GPU-process crash** (the browser's GPU process restarting: a driver reset, a GPU switch on some laptops, `chrome://gpucrash`) blanks every GPU-backed canvas in the page, including the sprite, terrain and avatar caches no renderer can rebuild on its own. ClaudeVille therefore reloads the page once; the village state comes from the server, so nothing is lost but the camera pose and open panels. It remembers the reload for the tab (`sessionStorage` key `cv-gpu-crash-reload-at`): a second crash within two minutes does not reload again (no reload loop) but drops to the Canvas world and rebuilds its resources in place, and Shift-D's `session:` row reads `GPU process crashed twice in 2 min: Canvas world, no reload`. Some cached art can then stay blank until you reload by hand; repeated crashes point at the driver or GPU, so check `chrome://gpu` and the system log above. A WebGPU device or WebGL2 context lost on its own (the 2D canvases survive) never reloads: the GPU world rebuilds and the World resumes.

## Linux reports an out-of-memory kill

Do not infer the victim from the notification text or virtual-memory size. Match ClaudeVille's current PID to the kernel OOM table and compare resident/anonymous memory:

```bash
curl -fsS http://localhost:4000/api/perf
journalctl -k -b --no-pager | rg -i 'out of memory|oom-kill|killed process'
RUNTIME_PID=12345 # replace with runtime.pid from /api/perf
ps -o pid,ppid,comm,rss,vsz,etime -p "$RUNTIME_PID"
rg '^(Rss|Pss|Pss_Anon|Private_Dirty|Swap):' "/proc/$RUNTIME_PID/smaps_rollup"
```

`/api/perf.runtime.memory.rss` covers the Node server. Browser canvas, decoded-image, compositor, and GPU allocations belong to the browser process and must be recorded separately with `window.__claudeVillePerf.canvasBudget()` and the browser task manager. A kernel table showing another process with materially larger anonymous RSS is evidence against attributing the system OOM to ClaudeVille.

## Sound does not come back

Sound is off by default and browsers only start audio after a click or key press, so first read the sound note in the top bar (`#topbarSoundToggle`). Its tooltip and `data-sound-state` name the state; the chevron beside it (`#topbarSoundMenu`) opens the SOUND popover, whose now line says what is happening.

| State | What it means | What to do |
| --- | --- | --- |
| `off` | The preset is *Off*. | Click the note (it turns the last preset back on) or press `M`. A profile's very first click on the note opens the presets instead; pick one. |
| `armed` | Sound is on but not heard yet: the browser is waiting for a gesture, or the page is away. The popover says `Waiting for a click — browsers start sound on your first click`. | Click the note or press `M`. Until sound has started once in this page, any click or key press on the page starts it. |
| `hushed` | `HUSH FOR 1 HOUR` or SET *Quiet hours* is active; sound drops to Signals only (quiet hours also a little softer) until the time the tooltip names. | `RESUME NOW` in the popover, the *Hush* row in SET, or change *Quiet hours*. |
| `playing` | Sound is running. | If it still seems silent, see below. |

`M` works anywhere except in a text field or while a modal is open. The tooltip `Sound unavailable in this browser` means the browser has no Web Audio.

Silent or quiet on purpose while `playing`:

- **Signals** plays only when an agent needs you, errors or hits a limit; between calls it is silent, and other events are captioned instead.
- **Town band** is continuous music with a breath of about 1.4 s between pieces; after 30 s with nobody working only the tune and the bass play. The popover's now line names the piece and its players (`Now · <title> · <lead> & <counter>`), or `Now · between tunes`.
- **Volume** is kept per preset: each preset has one Volume slider, in the popover and in SET; step 0 is silent.
- **A lost feed** rings the link-lost cue once and pauses reminders; stale agents make no sound and no longer move the band's percussion or working band.
- **A blurred window** (ClaudeVille visible, another app focused) follows SET *In the background*: *Keep playing* (default) lowers the Town band 3 dB, restored on focus; *Signals only* pauses as a hidden tab does.

A hidden tab pauses in place and suspends the audio context; needs-you, error and limit calls still wake it to ring. Showing the tab again resumes the same piece within about a second (after more than 10 minutes away, or across day and night, the band restarts instead). If it stays `armed` after returning, the browser refused to resume without a new gesture: click the note or press `M`.

For a readout, open the browser console. `window.__claudevilleAudio` exists once the sound controller is built, at most about 4 seconds after page load; before that it is `undefined`.

```js
const a = window.__claudevilleAudio?.();
a && { enabled: a.enabled, available: a.available, contextState: a.contextState, running: a.running,
  soundState: a.soundState, preset: a.preset, mode: a.mode, storedMode: a.storedMode, nowLine: a.nowLine,
  userActivated: a.userActivated, paused: a.paused, blurred: a.blurred, background: a.background,
  quietMix: a.quietMix, hushedUntil: a.hushedUntil, quietActive: a.quietActive, volumeStep: a.volumeStep,
  nowPlaying: a.nowPlaying, section: a.section, link: a.link };
```

- `contextState` other than `running` with `enabled: true`: the context is waiting for a gesture (`userActivated: false`) or the page is away (`paused: true` while hidden).
- `mode: 'signals'` while `storedMode` is `bgm`: a hush (`hushedUntil`) or quiet hours (`quietActive`) are in force.
- `quietMix: { active: true, preset: 'bgm' }`: the blurred-window quiet mix is lowering the Town band.
- `volumeStep`: the current preset's stored step (0 is silent).
- The rest of the readout is the playing director's `snapshot()`. In Town band: `nowPlaying` (the piece, its `title`, its `lead` and `counter` instruments; `null` between tunes), `section` (the working band applied, requested and pending, with its counts), `voice` and `percussion`. In Signals: `link` (the feed's health) and `audible.waiting`.
- The returned object also carries handles: `a.setPreset('townBand')`, `a.resumeFromHush()`, `a.testCall('summons')` (the needs-you bell at the current volume, only while sound plays), and `a.meters({ enable: true })` for loudness readings. They go through the same controller as the UI; a browser that has not seen a click on the page may still refuse to start the context.

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

Names are deterministic from the agent ID hash via `Agent.generateNameForLang` (`claudeville/src/domain/entities/Agent.js`). Names assigned by a team are preserved because `_customName` is set when the agent is constructed with an explicit name (the `Agent` constructor, honored by `AgentManager`, which never renames an agent whose `_customName` is set).

If you renamed an agent in code and the rename was overwritten, check that the constructor received `name` and `_customName` is true on that instance.

## Server starts but the page fails to load static assets

`server.js` resolves the request URL inside `STATIC_DIR` and rejects anything outside that directory with `403 Forbidden`. Do not add symlinks pointing outside `claudeville/`; they will be refused.

## Required runtime: Node 22.7+, no Windows path support in adapters

`package.json` declares `"node": ">=22.7.0"` and CI runs Node 22 and 24. The server alone uses only Node built-ins, but the browser modules are `.js` ES modules, so the syntax checks and the unit suite need Node's unflagged module-syntax detection (22.7+).

The adapters target POSIX path conventions and have no `process.platform === 'win32'` branches. Linux and macOS are tested. Windows path normalization is not implemented today.

## Checkerboard placeholders in World mode

A checkerboard pattern means `AssetManager` could not load a sprite and fell back to the placeholder.

Common causes:

1. **Missing PNG** - the manifest references an ID with no file on disk.
2. **Wrong path** - the manifest ID does not map to the path `AssetManager._pathFor()` expects.
3. **Stale cache** - the browser cached an old 404 response. Bump `style.assetVersion` in `manifest.yaml` and hard-refresh.
4. **Orphan PNG** - a file exists but has no manifest entry.

Diagnosis:

```bash
npm run sprites:validate
file claudeville/assets/sprites/path/to/suspect.png
```

Inspect `manifest.yaml`, `AssetManager._pathFor()`, and the browser devtools Network tab for 404s.

## "Empty array of providers" but `~/.claude/` exists

Provider activation is decided by directory existence, not by file content. If `~/.claude/` is present but empty, the Claude adapter still registers, and `/api/providers` will list it. `/api/sessions` will be empty because there are no JSONL files to read. Generate a session in the upstream CLI to populate it.
