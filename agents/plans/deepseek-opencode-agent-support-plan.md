# DeepSeek OpenCode Agent Support Plan

Date: 2026-05-17
Status: historical
Baseline HEAD: `9faa58b97463de936e756df6dc25d1971ba6a956`
Initial `git status --short`: empty
Final expected `git status --short`: implementation files plus this plan and `agents/README.md`

## Scope

Owned paths:

- `claudeville/adapters/opencode.js`
- `claudeville/adapters/index.js`
- `claudeville/adapters/README.md`
- `claudeville/src/presentation/shared/ModelVisualIdentity.js`
- `claudeville/src/presentation/shared/AgentPresentation.js`
- `claudeville/src/presentation/character-mode/AgentSprite.js`
- `claudeville/src/config/model-pricing.json`
- `claudeville/src/domain/value-objects/TokenUsage.js`
- `scripts/adapters/validate-fixtures.cjs`

Read-only paths:

- `claudeville/server.js`
- `claudeville/src/application/AgentManager.js`
- `claudeville/src/domain/entities/Agent.js`
- `~/.config/opencode/opencode.json`
- `~/.config/opencode/agents/*.md`
- `~/.local/share/opencode/opencode.db`

Source docs:

- `AGENTS.md`
- `claudeville/CLAUDE.md`
- `claudeville/adapters/README.md`
- `agents/templates/plan.md`

## Goal

Add ClaudeVille visibility for active DeepSeek-backed OpenCode sessions without changing the current server contract or introducing an install/build step. The implementation should surface OpenCode main sessions and subagents in World and Dashboard modes, with DeepSeek model labels, provider badging, current tool activity, session details, token usage, and parent-child relationships.

## Feasibility

Feasible. OpenCode persists enough local state in `~/.local/share/opencode/opencode.db`:

- `session` has `id`, `parent_id`, `directory`, `title`, `agent`, `model`, `cost`, token totals, and `time_updated`.
- `project` maps project ids to `worktree`.
- `message` has role, agent, model metadata, token/cost payloads, and timestamps.
- `part` has structured rows for `tool`, `text`, `reasoning`, `step-start`, and `step-finish`; `tool` parts include `tool`, `state.status`, `state.input`, command details for shell tools, output metadata, and timestamps.
- Local config currently defines DeepSeek models at `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash`, and custom OpenCode agents named `deepseekV4-pro` and `deepseekV4-flash`.

The existing adapter registry is the correct integration point. `claudeville/adapters/index.js` registers adapters once, normalizes session/detail payloads, validates detail providers from registry metadata, and feeds `/api/providers`, `/api/sessions`, `/api/session-detail`, WebSocket broadcasts, and polling. No server route changes are required.

## Design Decision

Implement this as an `OpenCodeAdapter`, not a `DeepSeekAdapter`.

Reason: the local data source is OpenCode, and the DB can contain DeepSeek, Anthropic, OpenAI, or other provider models in the same schema. Use `provider: 'opencode'` for the CLI/source adapter, set `model` to a displayable provider/model string such as `deepseek/deepseek-v4-pro`, and let frontend model identity render DeepSeek-specific labels/colors when `model` contains `deepseek`.

This preserves the existing meaning of `provider` as the local CLI adapter source while still making DeepSeek visually distinct.

## Findings By Priority

Critical:

- None.

High:

- Node engine is currently `>=18`, but the local machine has Node v26.1.0 with `node:sqlite`. A direct top-level `require('node:sqlite')` would break older Node 18 runtimes. The adapter must load SQLite support lazily and degrade to unavailable if neither `node:sqlite` nor an accepted fallback is available.
- The OpenCode DB is a live SQLite database with WAL files. Open it read-only, keep queries bounded, and close handles promptly to avoid interfering with the running CLI.

Medium:

- `claudeville/adapters/README.md` currently documents only Claude, Codex, Gemini, and partly Kimi. It must be updated so future adapter work does not reintroduce a server allowlist or misstate provider ids.
- `ModelVisualIdentity.js`, `AgentPresentation.js`, and `AgentSprite.js` know Claude/Codex/Gemini/Kimi/Git but not OpenCode or DeepSeek. Without frontend identity updates, sessions would work but fall back to default badges and sprites.
- DeepSeek pricing is not represented in `TokenUsage.js` or `model-pricing.json`. Runtime cost can use OpenCode's stored `cost`, but ClaudeVille's estimated-cost fallback should still be updated for consistent cards/widgets.

Low:

- A dedicated DeepSeek sprite asset is optional for first support. The lowest-risk visual path is to reuse an existing base sprite and add a DeepSeek palette/model identity; a bespoke sprite can be a follow-up because it requires manifest and asset validation.

## Implementation Plan

1. Add `claudeville/adapters/opencode.js`.
   - Define constants:
     - `OPENCODE_CONFIG_DIR = ~/.config/opencode`
     - `OPENCODE_STATE_DIR = ~/.local/share/opencode`
     - `OPENCODE_DB = ~/.local/share/opencode/opencode.db`
   - Export `OpenCodeAdapter`.
   - `name`: `OpenCode`
   - `provider`: `opencode`
   - `homeDir`: `OPENCODE_STATE_DIR`
   - `isAvailable()`: true only when the DB exists and a read strategy is available.

2. Add a small SQLite read layer inside `opencode.js`.
   - Prefer `node:sqlite` via a guarded lazy loader.
   - Open `OPENCODE_DB` read-only.
   - Do not write, migrate, vacuum, checkpoint, or attach.
   - Keep queries simple and indexed:
     - active sessions by `session.time_updated >= cutoff`
     - detail parts by `part.session_id`
     - detail messages by `message.session_id`
   - If SQLite loading/querying fails, return `[]` from session reads and empty detail payloads rather than throwing through the registry.

3. Normalize active OpenCode sessions.
   - Query recent sessions joined with `project`:
     - `session.id`
     - `session.parent_id`
     - `session.directory`
     - `session.title`
     - `session.agent`
     - `session.model`
     - `session.cost`
     - `session.tokens_input`
     - `session.tokens_output`
     - `session.tokens_reasoning`
     - `session.tokens_cache_read`
     - `session.tokens_cache_write`
     - `session.time_created`
     - `session.time_updated`
     - `project.worktree`
   - Prefix ids as `opencode-${session.id}`.
   - Set `agentId` to the raw OpenCode session id.
   - Set `agentName` to `session.agent` for custom agents such as `deepseekV4-pro`, falling back to `session.title`.
   - Set `agentType` to `sub-agent` when `parent_id` is present; otherwise `main`.
   - Set `parentSessionId` to `opencode-${parent_id}` when present.
   - Set `project` to `session.directory || project.worktree`.
   - Parse `session.model` JSON into `providerID` plus `id` or `modelID`, and format `model` as `providerID/<model-id>`, for example `deepseek/deepseek-v4-pro`.
   - Set `status: 'active'` and `lastActivity: session.time_updated`.
   - Map tokens to `{ input, output, cacheRead, cacheWrite, cacheCreate, totalInput, totalOutput, contextWindow, contextWindowMax, turnCount, reasoning, cost }`.

4. Extract current tool and recent message.
   - Query the newest relevant `part` rows for each active session, bounded to the last 100 rows.
   - For `data.type === 'tool'`, use:
     - `data.tool` as `lastTool`
     - `data.state.input.description`, `data.state.input.command`, or compact JSON input as `lastToolInput`
     - pending tools should count as current activity because their `time_created` updates the session.
   - For `data.type === 'text'`, use text content as `lastMessage`.
   - Ignore `reasoning` for `lastMessage` in the first implementation to avoid surfacing private chain-of-thought-like content in ordinary cards.

5. Implement session detail support.
   - `getSessionDetail(sessionId, project)` should strip the `opencode-` prefix and query `part`/`message`.
   - `toolHistory`: last 15 `tool` parts with `tool`, compact `detail`, and `ts`.
   - `messages`: last 5 user/assistant messages from `message.data` and text `part` rows, with `role`, `text`, and `ts`.
   - `tokenUsage`: session token totals.
   - Return `sessionId`, `project`, `provider: 'opencode'`, and `agentName`.
   - Do not include raw tool outputs in detail history; they can be huge and may contain sensitive command output.

6. Add git event extraction for OpenCode shell tools.
   - Reuse `dedupeGitEvents`, `extractGitEventsFromCommandSource`, and `stableHash` from `gitEvents.js`.
   - Treat `tool === 'bash'` and `tool === 'shell'` as shell-command sources.
   - Extract `data.state.input.command`.
   - Use `data.state.metadata.exit` or equivalent completion fields to attach `success`, `exitCode`, and `completedAt` when available.
   - Attach `gitEvents` to active session objects only, matching current adapter behavior.

7. Register the adapter.
   - Add `const { OpenCodeAdapter } = require('./opencode');` to `claudeville/adapters/index.js`.
   - Append `new OpenCodeAdapter()` to the `adapters` array.
   - Confirm `/api/providers` exposes it only when available.
   - Update server startup copy that currently says `~/.claude/, ~/.codex/, ~/.gemini/, or ~/.kimi/` to include OpenCode.

8. Add OpenCode and DeepSeek presentation identity.
   - In `AgentPresentation.js`, add `opencode` provider icon/color/badge.
   - In `ModelVisualIdentity.js`, add DeepSeek handling before the generic fallback:
     - `deepseek-v4-pro`: label `DeepSeek V4 Pro`, short label `DS V4 Pro`, tier `long-context`, context-aware color.
     - `deepseek-v4-flash`: label `DeepSeek V4 Flash`, short label `DS Flash`, tier `fast`.
     - `deepseek-reasoner`: label `DeepSeek Reasoner`, short label `DS Reasoner`.
   - Use an existing sprite for the initial pass, preferably `agent.kimi.base` with a new `paletteKey` only if a matching palette exists. Otherwise use `spriteId: null` and rely on current default rendering until a sprite is generated.
   - In `AgentSprite.js`, make `_providerKey()` return `opencode` for `provider.includes('opencode')` and return `deepseek` when `model.includes('deepseek')` if DeepSeek-specific trim/badge colors are added.

9. Add pricing support.
   - Add DeepSeek entries to `TokenUsage.js` pricing lookup:
     - `deepseek-v4-pro`
     - `deepseek-v4-flash`
     - `deepseek-reasoner`
   - Mirror those entries in `claudeville/src/config/model-pricing.json` if widget or external pricing checks require the JSON table.
   - Prefer OpenCode's stored `cost` for display only if current UI has an explicit path for provider-reported cost; otherwise keep estimated fallback consistent and leave reported cost as metadata for a later UI pass.

10. Update adapter docs.
    - Update `claudeville/adapters/README.md` purpose and provider-id tables to include OpenCode.
    - Add a mini-fixture for OpenCode's SQLite-backed rows:
      - `session.model` JSON
      - `part.data` tool/text JSON
      - parent subagent session example
    - Document that OpenCode support reads SQLite only and does not mutate provider files.

11. Add deterministic validation coverage.
    - Extend `scripts/adapters/validate-fixtures.cjs` for `normalizeSession`/`normalizeDetail` with `provider: 'opencode'`.
    - If practical without external deps, add a tiny temp SQLite fixture using `node:sqlite` when available and skip with a clear message when unavailable.
    - Validate parsing of:
      - DeepSeek main session
      - DeepSeek subagent with parent mapping
      - pending `todowrite` tool
      - completed `bash` tool with git command extraction
      - text message detail extraction

12. Manual smoke with the live OpenCode session.
    - Run `node --check claudeville/adapters/opencode.js`.
    - Run `npm run check:adapters`.
    - Use the maintained server at `http://localhost:4000`.
    - Confirm:
      - `curl http://localhost:4000/api/providers` includes OpenCode.
      - `curl http://localhost:4000/api/sessions` includes the active DeepSeek session from `/home/ahirice/Documents/git/pharos-watch`.
      - selected session details load through `/api/session-detail?provider=opencode&sessionId=...`.
      - World mode shows the OpenCode/DeepSeek agent as working while the DB updates.
      - Dashboard mode groups it under the correct project and shows model/tool/token data.

## Execution Readiness

Safe to execute: no. Implemented in the current worktree after this planning pass.

Required preflight:

- Re-run `git status --short`.
- Re-check owned paths for unrelated edits.
- Confirm local Node version and SQLite support with `node -p "process.version + ' sqlite=' + !!process.versions.sqlite"`.
- Confirm OpenCode DB path exists: `test -f ~/.local/share/opencode/opencode.db`.
- Reconfirm the current OpenCode schema with `.schema session message part project` before coding because OpenCode migrations may change column names.

## Validation

Validation required:

- `node --check claudeville/adapters/opencode.js`
- `npm run check:adapters`
- `npm run check:frontend-syntax`
- `curl http://localhost:4000/api/providers`
- `curl http://localhost:4000/api/sessions`
- `curl "http://localhost:4000/api/session-detail?provider=opencode&sessionId=<id>&project=<project>"`
- Browser smoke at `http://localhost:4000`: World mode, Dashboard mode, select/deselect DeepSeek/OpenCode agent.

Validation run:

- Not run; planning artifact only.

## Residual Risks

- `node:sqlite` is not available on every Node version allowed by `package.json`. The implementation must not break module loading on older Node.
- OpenCode schema is versioned by migrations and may change. Keep the adapter defensive and update docs with the observed OpenCode version.
- SQLite filesystem watch events may arrive through `opencode.db-wal` or `opencode.db-shm` rather than `opencode.db`. Watch the whole state directory with `.db`, `.db-wal`, and `.db-shm` handling or rely on the existing 2-second polling fallback.
- DeepSeek-specific sprite work is intentionally not required for first support. If bespoke assets are added later, run `npm run sprites:validate`.

## Supersession Policy

If this plan becomes stale, update `agents/README.md` with the replacement source of truth and mark this artifact `historical` or `superseded`.
