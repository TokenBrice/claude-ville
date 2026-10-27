# Provider Adapters

Read-only readers that pull active session data from local CLI provider stores (`~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.grok/`, `~/.kimi/` and `~/.kimi-code/`, `~/.local/share/opencode/`, and `~/.omp/`) and normalize it into a single shape the rest of ClaudeVille consumes.

## Purpose

Each adapter wraps one provider's on-disk session format and exposes a small uniform contract. The server (`claudeville/server.js`) and the application layer never touch provider files directly; they go through `adapters/index.js`, which iterates available adapters and aggregates results.

Adapters never write. Provider session files are inputs; do not mutate them.

## Provider sources

- `claude.js`: `~/.claude/` history, projects, teams, tasks, subagents, and workflow subagents.
- `codex.js`: recent `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` transcripts and `session_index.jsonl` names.
- `gemini.js`: `~/.gemini/tmp/<project_hash>/chats/session-*.json`, with best-effort project-hash reversal.
- `grok.js`: `~/.grok/sessions/<url-encoded-cwd>/<session-id>/` summaries, updates, and chat history; `active_sessions.json` is optional.
- `kimi.js`: legacy `~/.kimi/` wire/state data and Kimi Code indexes, transcripts, state, and config under `~/.kimi-code/`.
- `opencode.js`: read-only `~/.local/share/opencode/opencode.db`, including parent links and shell-derived git events.
- `omp.js`: `~/.omp/agent/sessions/` parent and nested-agent JSONL transcripts. `workingSet` uses observed `read`/`write` tool-call `arguments.path` and successful `edit` tool-result `details.perFileResults[].path` (not patch or result prose). Read selectors are removed; URI/device/archive targets and directories are excluded. Like Claude, it retains the latest 64 path observations and returns at most 16 distinct canonical paths, newest first, with `{ path, op, at, source: 'transcript' }`; the latest observation wins for repeated paths. Relative paths resolve against the recorded session cwd; paths inside the project are project-relative and other home paths use `~/`. Calls describe observed access intent, not proof of successful file I/O. The redacted local-store shape fixture is `scripts/adapters/fixtures/omp/working-set.jsonl`.
- `turnState.js`: provider-neutral `working`, `tool_pending`, `awaiting_input`, and `unknown` derivation plus pending-tool classification.
- `gitEvents.js`: best-effort commit/push extraction and repository-only `provider: 'git'` synthesis.
- `dialogue.js`: provenance-tagged `dialogue` and `observedSources`; only model-written text, with trimming and redaction disclosed.
- `toolResults.js`: bounded, provider-reported `lastResults` (see "Command results").
- `hooks.js`: the transient in-memory overlay fed by `POST /api/ingest/hook`; it never writes to disk and never replaces transcript discovery.
- `sessionPresentation.js`: server-side model identity, display label, sprite id, token normalization, and cost estimate attached to every normalized session.
- `shared.js`: bounded JSONL tail readers, parse diagnostics, read-failure tracking, and shared detail/summary helpers.

Adapter availability is automatic; empty provider output is not necessarily an error. `adapters/index.js` caches lists for 2000 ms and details for 5000 ms. A detail failure returns stale cached data when available, otherwise an empty detail shape.

Registration and runtime metadata live in `claudeville/adapters/index.js`:

```js
const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
  new GrokAdapter(),
  new KimiAdapter(),
  new OpenCodeAdapter(),
  new OmpAdapter(),
];
```

`isAvailable()` is checked on every aggregation pass, so machines without a provider installed are silently skipped.
The registry also exposes provider metadata (`provider`, display `name`, `supportsDetail`, `supportsWatchPaths`) used by `server.js` for detail-route validation. Do not add a second provider allowlist in the server.

## Adapter registry behavior

`adapters/index.js` is the aggregation layer used by `server.js`; the server does not read provider files directly.

- `getAllSessions(activeThresholdMs)` skips unavailable adapters, isolates per-adapter failures, merges results, sorts by `lastActivity` descending, and caches the full list briefly.
- `getAllSessions(activeThresholdMs, { overlayOnly: true })` refolds hooks into the cached normalized, Git-enriched baseline even after list TTL expiry, preserving the original cache timestamp and provider freshness. Force, a missing baseline, or pending provider invalidation uses ordinary collection instead.
- `getCachedSessionsWithOverlays(activeThresholdMs)` refolds the last normalized observations for the matching active window, including while provider refreshes are pending. It returns `null` without matching observations and never consumes provider dirtiness, renews TTL, restamps freshness, or reads transcripts.
- `getSessionDetailByProvider(provider, sessionId, project)` dispatches to the matching adapter, caches successful detail payloads briefly, and returns stale cached details after an adapter error when possible. `getSessionDetailsBatch(items)` serves `POST /api/session-details` through the same path.
- `getAllWatchPaths({ sessions, activeThresholdMs })` passes each adapter its own current sessions, tags every returned path with the adapter's `provider`, and records watch failures in provider health instead of throwing.
- `getActiveProviders()` surfaces provider display names and home directories for `/api/providers`.
- `normalizeSession(session)` and `normalizeDetail(detail, context)` are the final API-shape gate. Adapters should still return the documented shape, but the registry supplies safe defaults for nullable fields before data reaches `server.js`.

The short caches are intentional. The browser, activity panel, dashboard mode, and WebSocket loop all poll near-live state, so the registry absorbs repeated identical reads without making the UI feel stale.

### JSONL parse diagnostics

The shared JSONL parser (`shared.js` `parseJsonLines` / `readJsonLines`) counts lines per adapter source: `parsedLines`, `skippedLines` (malformed lines mid-window — potential silent data loss), and `trailingPartials` (the benign partial final line of an actively-written file). Parsed tail records share the existing byte-bounded tail state, so unchanged polls reuse objects and safe appends parse only new lines. Counts plus the most recent skip (file, byte offset relative to the read window, line size) are exposed via `/api/perf` as `jsonlDiagnostics`; parsed-tail hit/reuse counters are under `tailCache.parsed`. The shared tail state holds 128 MiB (`CLAUDEVILLE_TAIL_STATE_CACHE_MAX_BYTES`), and Claude's parsed-tail entries and transcript aggregates hold 32 MiB each (`CLAUDEVILLE_CLAUDE_PARSED_TAIL_CACHE_MAX_BYTES`, `CLAUDEVILLE_CLAUDE_TRANSCRIPT_CACHE_MAX_BYTES`). Each override is a byte count read at server start; `/api/perf` reports the shared limit as `tailCache.byteLimit`. Set `CLAUDEVILLE_DEBUG_JSONL=1` before starting the server to additionally log every skipped line with its offset and a snippet.

## Contract

Each adapter class must expose the following getters and methods. Getters are JS class getters (no parentheses), not methods.

| Member | Kind | Returns | Consumer |
| --- | --- | --- | --- |
| `name` | getter | display string (e.g. `'Claude Code'`) | `getActiveProviders()`, surfaced via `/api/providers` |
| `provider` | getter | stable id (`'claude'` / `'codex'` / `'gemini'` / `'grok'` / `'kimi'` / `'opencode'` / `'omp'`) | Adapter dispatch and adapter-backed session objects |
| `homeDir` | getter | absolute path to the provider's source dir | `getActiveProviders()` |
| `isAvailable()` | method | `boolean` | Gates every registry iteration |
| `getActiveSessions(activeThresholdMs)` | method | `Session[]` (see below) | Called from `server.js` per request and per polling tick |
| `getSessionDetail(sessionId, project)` | method | `{ toolHistory, messages, tokenUsage?, sessionId }` | Served at `/api/session-detail` |
| `getWatchPaths()` | method | `WatchPath[]` (see below) | Consumed by `server.js` in `startFileWatcher()` |

Registry metadata treats adapter-backed providers as detail-capable when `getSessionDetail` exists. Synthetic providers must be declared in the registry metadata instead of hard-coded in `server.js`.

`toolHistory` items are `{ tool, detail, ts }` plus two optional failure fields where the provider payload carries them: `toolExitCode` (number; Codex `exec_command_end` events matched by `call_id`, Kimi Code `tool.result.result.isError` / `is_error` / exit fields, OpenCode `state.metadata.exit`) and `toolStderr` (string, truncated to 200 chars, only set on non-zero exits). The Activity Panel renders non-zero `toolExitCode` as a warning chip on the tool row.

### Claude-only optional methods

`ClaudeAdapter` additionally exposes:

| Member | Returns | Consumer |
| --- | --- | --- |
| `getTeams()` | array of team metadata from `~/.claude/teams/` | `/api/teams`, `AgentManager._buildTeamMembers` |
| `getTasks()` | array of task metadata from `~/.claude/tasks/` | `/api/tasks` |

`server.js` calls these only when `claudeAdapter` is present. Other adapters do not need to implement them.

## Normalized session object

`getActiveSessions(activeThresholdMs)` must return objects with these fields. `AgentManager` (`src/application/AgentManager.js`) consumes them.

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | string | Unique across providers. Codex, Gemini, Grok, Kimi, OpenCode, and OMP prefix with `codex-` / `gemini-` / `grok-` / `kimi-` / `opencode-` / `omp-`; Claude uses the raw uuid; subagents use `subagent-<agentId>`. Repository-only git sessions use `git-repo-<hash>`. |
| `provider` | `'claude' \| 'codex' \| 'gemini' \| 'grok' \| 'kimi' \| 'opencode' \| 'omp' \| 'git'` | Adapter-backed sessions use the CLI/source provider id. DeepSeek-backed OpenCode sessions still use `provider: 'opencode'` and expose DeepSeek through `model`. OMP sessions use `provider: 'omp'` and expose their underlying provider through `underlyingProvider` (z.AI GLM sessions carry `underlyingProvider: 'zai'` and `model` as either the prefixed `'zai/glm-5.3'` from `model_change` or the bare `'glm-5.3'` from later assistant messages; the registry resolves both). The registry can synthesize repository sessions with `provider: 'git'` for unpushed commit visibility. |
| `agentId` | string \| null | Provider-specific agent thread id; nullable for Gemini. |
| `agentType` | `'main' \| 'sub-agent' \| 'team-member' \| 'workflow-subagent' \| 'repository'` | Drives sprite/card grouping. Default `'main'`. Claude `Agent` launches always use `'sub-agent'`; their provider-specific kind is kept in `subagentKind`. Synthetic git sessions use `'repository'`. Workflow tool sub-agents use `'workflow-subagent'`. |
| `subagentKind` | string \| null | Claude-only kind supplied to an `Agent` launch (for example `'Explore'` or `'general-purpose'`), else the meta file's `spawnedAgentType` / `agentType`. It never replaces an `agentType` enum value. |
| `agentName` | string \| null | Human label when the provider exposes one (Codex `session_index.jsonl` `thread_name` with `agent_nickname` fallback, Claude team launch name). Claude subagents read `subagents/agent-<id>.meta.json` first (`name`, else the `Agent` launch description, else the meta `description`); the meta file is size-capped and malformed metadata is ignored. The `name` is the alias teammates address in `SendMessage`, so `sendMessages` edges resolve to bodies. |
| `agentPath` | string \| null | Codex-only. A spawned thread's `agent_path` (for example `'/root/composition'`); its last segment is the name the orchestrator's `send_message` `target` addresses, so the client uses it as a chat alias. |
| `teamName` | string \| null | Explicit team membership: Claude main sessions through `~/.claude/teams/` inboxes, Claude subagents and teammates through the meta file's `teamName`. Never inferred from paths. |
| `agentColor` | string \| null | Claude-only. The colour name Claude assigned a teammate in its meta file (for example `'cyan'`). Published for consumers; the client does not read it yet. |
| `project` | string \| null | Absolute working directory. Gemini may resolve this from a SHA-256 hash and return null on failure. |
| `model` | string | Free-form. UI strips `claude-` and `-2025…` suffixes for display. Claude never reports a `<…>` stub such as `<synthetic>` (Claude Code's API-error text, which never speaks as dialogue either); with no model in the tail window it reports none, normalization falls back to the provider id, and the context limit comes from the transcript's own latest model. |
| `status` | `'active'` | Currently always `'active'`; idle/terminated transitions are inferred client-side by `AgentManager`. |
| `lastActivity` | number (ms epoch) | Latest of file mtime and any in-file timestamp. Sort key. |
| `lastTool` | string \| null | Most recent tool name. |
| `lastToolInput` | string \| null | Compact summary of the tool's argument; truncated to ~60 chars. Shell `command`/`cmd` fields first drop leading `cd <dir> &&` / `cd <dir>;` hops and every `git -C <dir>` flag (`shared.js` `stripShellLocationPrefix`), so the summary carries the command, not the directory. |
| `lastMessage` | string \| null | Most recent assistant text; truncated. |
| `lastPrompt` | string \| null | Most recent user prompt, trimmed to 200 characters. Codex reads user rollout messages; OMP ignores system-reminder and advisory XML blocks. |
| `todos` | array | Current provider checklist, up to 64 `{ subject, status, phase }` items in declared order. Subjects are capped at 200 characters, statuses are `pending`, `in_progress`, or `completed`, and `phase` is either a label capped at 80 characters or `null`. Claude `TodoWrite` and Codex `update_plan` have no phase labels; OMP folds `todo` operations and preserves their phases. |
| `gitBranch` | string \| null | Provider-recorded git branch when present, capped at 256 characters. |
| `repoRoot` | string \| undefined | Added by git enrichment: the repository's main worktree path, shared by the main checkout, every linked worktree and every subdirectory session (see "Git event extraction"). Absent outside a repository. |
| `worktree` | `{ name, path, isMain }` \| undefined | Added by git enrichment with `repoRoot`: the checkout the session runs in; `isMain` is false for a linked worktree. |
| `tokenUsage` | object \| null | See "Token normalization" below. Registry normalization sets this to null when adapters omit token data. |
| `parentSessionId` | string \| null | Set on subagent / spawned-thread sessions. |
| `underlyingProvider` | string \| null | OMP-only. The hosted model provider (for example `'zai'`), from `model_change` records and assistant `message.provider`. |
| `reasoningEffort` | string \| null | Codex pulls it from `turn_context` / `event_msg`; OMP takes the latest `thinking_level_change` record (`low` / `medium` / `high` / `max`). Registry normalization sets this to null when adapters omit it. |
| `workflowId` | string \| null | Claude-only. Workflow run id (`wf_<id>`) for sub-agents spawned by the Workflow tool; null otherwise. |
| `workflowName` | string \| null | Claude-only. Human workflow name recovered from the persisted run-script filename; null otherwise. |
| `permissionMode` | string \| null | Claude-only. Latest `permissionMode` marker in the transcript tail window (`'default'` / `'plan'` / `'acceptEdits'` / `'bypassPermissions'`); `'plan'` means the session is in plan mode, anything else is act mode. Registry normalization sets this to null when adapters omit it. |
| `turnState` | string | What the session is doing, from its transcript: `'working'`, `'tool_pending'` (a tool call with no result yet), `'awaiting_input'` (the turn closed and the next move is the user's), or `'unknown'` when the adapter cannot tell. Derived via `turnState.js`; Claude, Codex, Kimi Code, OMP, and OpenCode populate it from their recorded lifecycle. Gemini tool calls/results and explicit finish markers, and Grok ACP tool calls/updates, provide narrower coverage; unrecognized records stay unknown. |
| `pendingTool` | string \| null | Name of the unanswered tool call, when `turnState` is `'tool_pending'`. |
| `pendingSince` | number \| null | ms epoch the pending call was issued. Orders unresolved calls; elapsed time never proves an approval prompt. |
| `waitReason` | string \| null | Why the session is blocked on a person: `'question'`, `'approval'`, or `'plan_review'`. Null when a pending tool is judged to be merely executing. |
| `awaitingSince` | number \| null | ms epoch the session started waiting on the user (or closed its turn). Orders the attention queue. |
| `turnStartedAt` | number \| null | ms epoch the current turn started, when the transcript records it. |
| `sessionEndedAt` | number \| null | Explicit session end, ms epoch; distinct from a completed turn. OMP reads `custom.session_exit`; Claude can receive an opt-in `SessionEnd` hook. A newer user/assistant message (OMP) or session/turn-start hook clears it on resume. Ends immediately remove village presence through the existing gate staging; mere roster absence still uses the 90-second grace. Other providers default to null. |
| `lastTurnDurationMs` | number \| null | Duration of the last completed turn. Claude reads `system` `turn_duration` records; Codex reads `task_complete` `duration_ms`, else the span from that turn's own `task_started` to its completion. A Codex `turn_aborted` neither sets nor clears it. Other providers default to null. |
| `resident` | boolean | True when the server is serving a frozen snapshot of a session that has left the active window (see `services/sessionResidency.js`). |
| `dialogue` | object \| null | Provenance-tagged speech built by `dialogue.js`: `{ text, full, kind, source, authorship, fidelity, redacted, observedAt, actionId }`. `kind` is `intent`, `plan`, `thinking`, or `assistant`; `text` is capped at 80 characters and `full` at 400. Only model-written text qualifies; lines older than 90 seconds are dropped. Null when nothing qualifies — the world stays silent rather than inventing a line. |
| `observedSources` | object | `{ toolIntent, planStep, thinkingPlaintext, assistantText }` booleans: what the bounded tail scan actually saw, not a capability claim. All `false` when omitted. |
| `workingSet` | array | Up to 16 `{ path, op, at, source }` file observations (`op` is `read` or `write`, `source` is `transcript` or `hook`), newest first. Claude, Codex, and OMP populate it; see the `omp.js` note above. `[]` when omitted. |
| `taskProgress` | object \| null | Claude-only `{ done, total, source }`: `source: 'exact'` from the `~/.claude/tasks/` group of the session, `'inferred'` from its child sessions. |
| `tasks` | array | Claude-only task summary, up to 12 `{ subject, status }` items. `[]` when omitted. |
| `sendMessages` | array | Claude-only sender→recipient edges from `SendMessage` tool calls; the carrying session is the sender. Up to 10 most recent edges of `{ recipient, messageType, summary, ts }`: `recipient` is the raw alias from the tool input (match against `agentName`/`name`/`agentId`), `messageType` is the tool input `type` (default `'message'`), `summary` is truncated to 80 chars or null, `ts` is the transcript entry timestamp. Edges without a resolvable recipient (e.g. `shutdown_response` replies keyed by `request_id`) are skipped. Registry normalization sets this to `[]` when adapters omit it. |
| `gitEvents` | array | Backend-extracted git `commit` / `push` events from raw tool records. Registry normalization sets this to `[]` when adapters omit it. Dry-run events are omitted. Events include `id`, `type`, `project`, `provider`, `sessionId`, `sourceId`, `ts`, and `commandHash`; `command`, `targetRef`, `success`, `exitCode`, and `completedAt` are optional metadata when the adapter can derive them. |
| `lastResults` | array | Up to 5 most recent provider-reported outcomes of calls that already finished, newest first: `{ id, tool, detail, exitCode, exitCodeSource, durationMs, completedAt, source }`. See "Command results" below. Registry normalization sets this to `[]` when adapters omit it. |

### Command results

`lastResults` answers a question invocation cannot: how a call ended. A record
exists only where the provider wrote one down.

- **Codex** — `item_completed` records of type `CommandExecution` (`codex.js`). `exit_code` may be absent on an interrupted command; `exitCode` is then `null` and the outcome stays explicitly unknown. Items carry `command` as argv (`[".../bash", "-lc", "<script>"]`); `detail`, `lastToolInput` and the tool-history row summarize the script past any `cd <dir> &&` hop, as Claude's `Bash` summaries do.
- **Kimi Code** — `tool.result` loop events carrying an exit code, or an explicit `isError`/`is_error`/`error` flag (`kimi.js`). A result that only carries output is not an outcome and produces nothing.
- **OpenCode** — tool parts with a numeric `state.metadata.exit` (`opencode.js`).
- **OMP** — `toolResult` records paired with their `toolCall` id inside the bounded transcript tail (`omp.js`). An explicit `isError` flag maps to exit 1 or 0; an absent flag leaves `exitCode: null`. Unpaired results and still-open calls are not published.
- **Claude** — `tool_result` blocks paired with their `tool_use` id inside the cached transcript tail (`claude.js` `getClaudeToolResults`, reusing `claudeToolCompletion`). Only an explicit `is_error` flag is a claim: `true` with `Exit code N` in the result text gives `N` (`exitCodeSource: 'exit'`), `true` without a code gives 1 and `false` gives 0 (both `'flag'`). A result with no `is_error` (most `Read`/`Edit`/`Agent` successes) claims nothing and produces no record. Background commands (`run_in_background`, `backgroundTaskId`) and async agent launches (`isAsync`) report only that something started, and interrupted (`toolUseResult.interrupted`) or user-rejected calls never ran to an end; none of them is published. Unpaired results and still-open calls are not published either.
- **Gemini, Grok** — no result record is published. Nothing downstream may synthesize one.

`exitCodeSource` says where the number came from: `'exit'` is a process exit status the provider wrote down (Codex `exit_code`, OpenCode `metadata.exit`, a Kimi Code exit code, Claude `Exit code N`); `'flag'` is derived from a boolean error flag (OMP `isError`, a Kimi Code error flag, Claude `is_error` without a code). It is `null` whenever `exitCode` is `null`. A consumer that must not mistake a harness refusal, a permission denial or an `Edit` miss for a failing command should require `'exit'` for the failure side.

`id` is derived from provider, session, and call identity in `toolResults.js`, so
re-reading the same transcript yields the same id and consumers deduplicate
across polls instead of stamping a completion twice. Providers without a call id
fall back to the recorded completion time plus the call's own shape — still read
from the record, never from receipt time. `durationMs` is the provider's own
duration or the span between the call and its result in the same transcript;
`completedAt` is required and an entry without one is dropped. `detail` is the
existing bounded tool-input summary (≤ 80 chars) and carries the classification
the world uses to place the result at a building. The list is capped at
`TOOL_RESULT_LIMIT` (5) per session, deduplicated by id and sorted newest first
by `normalizeToolResults`, so a busy session cannot grow the list payload.

A tool disappearing from a transcript tail is not a result, and neither is a
session leaving the roster. The client mirrors this cap in `Agent.lastResults`
and emits one `tool:result` event per newly observed id
(`character-mode/AgentEventStream.js`).

### Observation and signal certainty

Public `sessionId` remains the filename-derived dashboard identity. Hooks are keyed by provider and source ID; matching also considers `sourceSessionId`, `agentId`, and the unprefixed public ID. Gemini supplies its JSON `sessionId` as `sourceSessionId`; Codex retains its actual thread ID in `agentId`. Identical raw IDs from different providers never share overlays.

Sessions and details expose `freshness: { state, observedAt, ageMs }`. A successful provider scan is `fresh`; an actual empty result removes that provider slice. Failed discovery/read keeps the last good slice `stale` for at most 60 seconds, without changing its observation time. Detail failures use the same bound and then return `state: 'unavailable'`. Dirty-cache invalidation preserves this backup. A missing provider is unavailable, and successful recovery clears staleness. Residency never extends degraded provider retention; ordinary unresolved residents carry stale observation metadata.

`signalCertainty` is `observed`, `inferred`, or `unavailable`; `signalObservedAt` gives its timestamp and `signalStale` marks a last observation. A pending ordinary tool remains work however long it runs. Explicit question/review tools and approval hooks supply waiting evidence. Exact unanswered hook approvals remain last-observed waits after the 10-second fresh window, until a resolving hook/newer recorded turn or a bounded 30-minute expiry. Explicit `SessionEnd` hooks retain `sessionEndedAt` under the same bound until a session/turn-start hook or newer recorded turn, preventing ordinary overlay expiry from resurrecting an ended session. Other hook overlays stop merging after 10 seconds and expire after 30 seconds. Gemini text and Grok message chunks alone do not assert a completed turn.

Claude quota utilization is provider-qualified pressure, never evidence of enforcement. Session `rateLimit: { enforced: true }` carries an observed rejection (including Claude `stop_reason: 'rate_limited'`). Account-wide enforcement also requires matching provider and explicit account ID. An unanswered question/approval remains the primary status.

Codex account quota (SV-6, PV-7) is account data, never session data. `extractCodexRateLimits` reads each `token_count.rate_limits` in the 500-line token window: the `primary`/`secondary` windows (`used_percent`, `window_minutes`, `resets_at` in epoch seconds), `credits` (`balance` is a decimal string) and `rate_limit_reached_type`. The adapter keeps the newest observation per `session_meta.creator_account_id`, and the first scan also reads the newest rollout's tail once, so a server that boots with no live Codex session still knows the last observed quota. `getRateLimitObservation()` hands the newest observation to `services/usageQuota.js`, which serves it as `/api/usage.codex` ([local API](../../docs/local-api.md)). No session payload carries the account ID or the quota, and an account LIMIT never changes a villager's status (decision Q3).

### Git event extraction

`gitEvents.js` extracts only high-signal repository events from raw tool commands:

- `git commit`, `git push`, `git pull` and `git fetch` (plus `gh pr|issue|release create`, `gh pr merge`) are included. Dry-runs, help and commit status modes (`--short`, `--porcelain`, `--long`) are omitted.
- A command is parsed as a shell script: `&&`/`||`/`;`/`|` chains, subshells, `bash -c`/`sh -lc` wrappers, `env`/`time`/`timeout`/`command`/`nice`/`sudo` prefixes, redirections and heredocs (whose bodies are data, never commands). Each event records the directory it ran in (`cwd`, after `cd`, `git -C`, a tool `workdir`, Codex `item.cwd` or the Claude transcript's `cwd`) and the repository identity of that directory: `repoRoot` (the main worktree; one value for the main checkout, every linked worktree and every subdirectory), `checkout` and `worktree: { name, path, isMain }`. Sessions carry `repoRoot` and `worktree` too.
- The call's exit status belongs to the segment that ran last; a segment's own output (`[branch sha] subject`, `! [rejected] main -> main`) always wins, so `|| true` cannot launder a rejected push. A commit is emitted only when it can have been created: never for a failed exit, `nothing to commit` or a segment that did not run. Observed commits carry `sha`, `branch` (or `detached`), `label` and `attribution: 'observed'`.
- Pushes carry `refs: [{ src, dst, status, sha? }]` (source branch first; `HEAD` resolves to the branch checked out where the push ran), `status`, `reason`, `tagsOnly`/`tag` and `deleted`. Branch, worktree and tag state read at the first observation is frozen by event id, so re-parsing a transcript never re-labels an event.
- Completion data: Claude (`is_error`, `Exit code N`, `toolUseResult`), Codex (`item_completed` `CommandExecution`, older `exec_command_end`), OpenCode (`metadata.exit`) and Kimi Code report outcomes. Gemini, Grok, Kimi v1 and OMP carry no completion data; their events keep `confidence` 0.85 and no `success`. `stderr` is capped at 2 KB (push events keep only push output lines).
- A command whose directory cannot be known (a `cd`/`-C`/`--git-dir`/`workdir` target that is a shell variable or command substitution, `cd -`, or a path that does not exist or is not a repository) yields `unresolved: true` and no `repoRoot`; it is never attributed to the session's repository, and enrichment drops it from session output, as it does events whose repository has since disappeared.
- Parsing is best-effort and command-string based; do not treat events as an authoritative audit log.

Adapters attach `gitEvents` to active session objects. `/api/session-detail` and `POST /api/session-details` currently focus on tool history, messages, and tokens, so consumers that need git events should read them from the session list data.

Git enrichment scans each repository once (keyed by `repoRoot`, from any session, worktree or subdirectory in it, and from repositories an observed command ran in). One `for-each-ref` lists every branch and remote-tracking ref; one `git log --source <branches> --not --remotes` lists unpushed commits on the checked-out and recently committed branches (`source: 'git-upstream-status'`, `attribution: 'scanned'`, with `author` and `coAuthors` from `Co-authored-by` trailers, and `branches` listing every scanned local branch that contains the commit; detached-HEAD roots add commits on no branch with `detached: true`). The log is skipped while no tip moved, and a warm poll whose ref signature is unchanged launches no subprocess. Work that reached the default branch (`origin/HEAD`, else `origin/main` or `origin/master`) under other shas counts as landed and is never listed: a squash merge, when at some commit on the default branch's first-parent line since the merge base (its tip included) every file the branch changed read exactly as on the branch tip (one `diff --raw` for the branch's files and blobs, one pathspec-limited `log --first-parent --raw` replayed in order; so a pushed pull request squash-merged, edited on main later and pruned does not dock again), and a rebase merge or cherry-pick, per commit whose patch the default branch carries (`rev-list --cherry-mark`). Each branch is settled once per (branch tip, default tip). When commits leave the list, a remote-tracking ref containing the old tip, or that landing, makes it a push (`git-upstream-transition`, `synthetic: 'transition'`, `landedShas`, timed from the remote-tracking reflog); otherwise it is a `type: 'rewritten'` event (`oldShas`, `replacements` for amend/rebase). A reset is never a push. Recent `update by push` reflog entries also replay departures after a server restart (first scan after a start only). An observed successful push takes the `landedShas` of its matching transition; an observed commit that a remote already contains (or that landed as above), with no departure covering it, gets a `synthetic: 'inferred'` push. Observed commits that are not cargo retire as `rewritten` (with `oldIds`) and leave the session: shas no ref reaches (amended or reset away), shas the repository does not have, and sha-less commits that a later scan cannot match. There is no current-HEAD fallback. For a linked worktree, the server's git-state probe watches both the worktree's own git dir and the shared ref stores in its common dir, where a push from the worktree lands.

Repository identity (`resolveRepoIdentity`) reads the filesystem only (`.git` walk-up from the realpath, `commondir`, `core.worktree` for submodules) and launches no subprocess; a hit is cached and revalidated by the `.git` stamp, a miss is not cached. The subprocess budget: a warm poll launches none (`harbor-ingest-repos.test.mjs`), and a push costs about eight (ref listing, log, containment) plus at most three per unpushed branch when the default branch moved (the landing check).

Git enrichment diagnostics are exposed through `/api/perf` as `gitEnrichment`, including project counts, git command counts, elapsed time, cache hits, errors, and timeouts. Set `CLAUDEVILLE_DISABLE_GIT_ENRICHMENT=1` before starting the server to disable inferred git enrichment for diagnosis without changing provider parsing.

### Token normalization

Token data may appear under any of three keys depending on the call site:

- `tokenUsage` — canonical, set by adapters on `getActiveSessions` and `getSessionDetail`.
- `tokens` — alternate alias used by some session fixtures.
- `usage` — the raw provider field, kept as a fallback when `tokenUsage` is absent.

Within any of those, the consumer reads sub-fields under multiple aliases:

- input: `input_tokens` / `inputTokens` / `prompt_tokens` / `promptTokens` / `total_input_tokens`
- output: `output_tokens` / `outputTokens` / `completion_tokens` / `completionTokens` / `total_output_tokens`
- cacheRead: `cached_input_tokens` / `cache_read_input_tokens` / `cacheReadInputTokens`
- cacheCreate: `cache_creation_input_tokens` / `cacheCreationInputTokens`
- reasoningTokens: `reasoning` / `reasoning_tokens` / `reasoning_output_tokens` / `reasoningOutputTokens` / `tokens_reasoning`

Reasoning-token semantics differ per provider, so usage objects carry a `reasoningInOutput` boolean alongside `reasoningTokens`:

- OpenCode stores `tokens_reasoning` separately from `tokens_output` (message totals sum input + output + reasoning + cache), so reasoning is extra billable spend and `estimateCost` prices it at the model's output rate.
- Codex `output_tokens` already includes `reasoning_output_tokens` (`total_tokens` = input + output), so the Codex adapter sets `reasoningInOutput: true` and cost estimation skips reasoning to avoid double pricing; the field remains available as an output breakdown.

The fallback chain exists because providers rename fields between releases (Codex switched to cumulative `token_count` events; Gemini varies between camelCase and snake_case; OpenCode stores cumulative totals in SQLite columns). Adapters absorb the variance so the UI does not need provider-specific conditionals.

Normalized browser usage and server cost carry `availability: 'observed' | 'partial' | 'unavailable'`. Input and output observations, including explicit zero, are billable coverage; a missing split is partial, and missing usage is unavailable. Numeric DTO slots may remain zero for arithmetic compatibility, so availability must accompany totals. Grok context occupancy explicitly has unavailable billable usage. Unavailable estimated cost is `usd: null` / `estimatedCost: null`, while observed zero remains zero. Mixed totals must disclose missing or partial coverage. Provider-reported cost remains an observed cost even if token coverage is unavailable.

### Model identity and pricing

Adapters pass provider model strings into the canonical registry at `../src/config/models.json`. The committed `models.generated.cjs` supplies synchronous server-side resolution; never edit it directly. Identity, pricing, context window, and mood belong in the registry, while effort/accessory rendering policy remains in `../src/presentation/shared/ModelVisualIdentity.js` keyed by `modelClass`. Probe a raw string with `npm run models:resolve -- <provider> <model>` before and after changing the registry.

## `getWatchPaths()` shape

`getWatchPaths({ sessions, activeThresholdMs })` receives the adapter's current sessions and returns an array of:

```js
{
  type: 'file' | 'directory',
  path: string,
  filter?: string, filters?: string[],     // directory events: filename must end with one of these
  scope?: 'active' | 'recent' | 'discovery' | 'static', // default 'discovery'
  kind?: string, sessionId?: string, project?: string, // targets dirty-cache invalidation
  probe?: boolean,                         // also stat-probe this path every scheduler tick
  dynamic?: boolean,                       // default: true for active/recent scope
  priority?: number, activity?: number,    // order dynamic paths under the cap
}
```

`server.js` canonicalizes and merges descriptors per `type:path` in `canonicalizeWatchDescriptors()`, then:

- Every path gets a shallow `fs.watch`; `recursive` is ignored. Return the exact active files and their parent directories instead of a deep root.
- Stable (`discovery`/`static`) paths are always watched. Dynamic (`active`/`recent`) paths are watched only while a WebSocket client is connected, retire 15 seconds after the last one leaves, and are capped at 512 by priority, then activity (`CLAUDEVILLE_WATCH_DYNAMIC_CAP`).
- `probe: true` paths are compared by `stat` signature on every 2-second scheduler tick while a client is connected (cap 1024, `CLAUDEVILLE_WATCH_PROBE_CAP`); a change marks the matching provider data dirty.
- A missing path is retried with backoff (200 ms doubling to 5 s, eight attempts); a watcher that errors falls back to bounded signature scans.
- Directory events whose filename matches no filter are ignored; relevant events mark provider data dirty and trigger a debounced (100 ms) broadcast.

The 2-second scheduler in `startFileWatcher()` also runs git-state scans and a 30-second watch-topology reconciliation; it broadcasts only when WebSocket clients are connected.

## How to add a provider

1. Create `claudeville/adapters/<name>.js` exporting a class that implements the contract above. Use the existing adapters as templates — they all follow the same module-private parser helpers + adapter class layout.
2. Register the new instance in `claudeville/adapters/index.js`. Add the require and append to the `adapters` array.
3. Confirm the registry metadata exposes the provider's detail/watch support. `server.js` derives valid detail providers from the registry.
4. Confirm `isAvailable()` returns `true` only when the provider's home directory exists. Do not throw on missing files — return `false` or an empty array.
5. Confirm `getWatchPaths()` returns valid descriptors (shape above). Prefer exact active files and shallow directories with `filters` over deep roots or one watcher per historical file.
6. Add redacted synthetic fixtures under `scripts/adapters/fixtures/<name>/` and follow Track A in [`docs/agent-provider-addition.md`](../../docs/agent-provider-addition.md) for registry, identity, and doc surfaces.
7. Validate:
   - `node --check claudeville/adapters/<name>.js`
   - `npm run check:adapter-fixtures`
   - `npm run verify:server`
   - With the server running (`npm run dev`), `curl http://localhost:4000/api/providers` lists the provider and `curl http://localhost:4000/api/sessions` returns its normalized sessions.

## Per-provider mini-fixtures

These show the minimal shape each adapter's parser reads. Real files are longer; only the documented fields are required.

### Claude — `~/.claude/history.jsonl` (one line per turn)

```jsonc
// shape only — fields the adapter reads
{
  "sessionId": "8c8a3b4e-1f29-4a6b-9d31-7e0b3a2f9cda",
  "agentId": null,
  "agentType": "main",
  "model": "claude-sonnet-4-5",
  "project": "/Users/me/Documents/git/claude-ville",
  "timestamp": 1737567890123,
  "display": "Refactor the build script."
}
```

Subagent files at `~/.claude/projects/<encoded-project>/<sessionId>/subagents/agent-<id>.jsonl` follow the standard Claude message-event JSONL schema; the adapter reads `message.role`, `message.content`, and `usage` blocks from each line. Only `user` and `assistant` records are turns: the `api-request-blob` copies of API messages (a `message.role`, no timestamp and, in subagent files, no `isSidechain`) and the `api-request`/`api-request-shape` bookkeeping lines never contribute a message (`claude/api-request-blob*.jsonl`).

Workflow tool sub-agents use the same JSONL schema but live one level deeper, grouped per run id: `~/.claude/projects/<encoded-project>/<sessionId>/subagents/workflows/<wfRunId>/agent-<id>.jsonl`, each with a `agent-<id>.meta.json` sidecar (`{"agentType":"workflow-subagent"}`). The per-agent TUI label/phase shown in the Workflow runner is not persisted; only the workflow name is recoverable, from the run script at `<sessionId>/workflows/scripts/<workflowName>-<wfRunId>.js`. The adapter tags these sessions `agentType: 'workflow-subagent'` with `workflowId` / `workflowName`, and keeps a quiet orchestrator parent "active" off its (possibly nested) children's mtimes.

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (one line per record)

```jsonc
// shape only — fields the adapter reads
{"type":"session_meta","payload":{"id":"thr_01J9X...","cwd":"/Users/me/code/proj","model":"gpt-5","agent_nickname":"plan-bot","agent_role":"main"}}
{"type":"turn_context","payload":{"model":"gpt-5","effort":"medium"}}
{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"ls\"}"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12000,"output_tokens":340,"cached_input_tokens":8000},"last_token_usage":{"total_tokens":420},"model_context_window":200000},"rate_limits":{"primary":{"used_percent":100.0,"window_minutes":10080,"resets_at":1793600373},"secondary":null,"credits":{"has_credits":true,"unlimited":false,"balance":"2510.33"},"rate_limit_reached_type":null}}}
```

`session_meta` also carries `creator_account_id`, the key for the account quota above.

Renamed Codex sessions are read from `~/.codex/session_index.jsonl`:

```jsonc
{"id":"thr_01J9X...","thread_name":"plan-bot","updated_at":"2026-05-19T11:30:51.337Z"}
```

The adapter reads `session_meta` from the first metadata lines, prefers `session_index.jsonl` names when available, and reads tools/messages/usage from the last 50–500 lines.

### Gemini — `~/.gemini/tmp/<projectHash>/chats/session-*.json` (one JSON object per file)

```jsonc
// shape only — fields the adapter reads
{
  "sessionId": "8b3e1c92-...",
  "projectHash": "1f2c…",
  "messages": [
    { "type": "user", "content": "hello" },
    {
      "type": "gemini",
      "model": "gemini-2.5-flash",
      "content": "hi!",
      "toolCalls": [{ "name": "run_shell_command", "args": { "command": "ls" } }],
      "tokens": { "input": 200, "output": 12 },
      "timestamp": "2025-01-22T10:30:00.000Z"
    },
    { "type": "info", "content": "context loaded" }
  ]
}
```

`projectHash` is `sha256(cwd)`. The adapter attempts to reverse-map known candidate paths back to a real `project` string.

### Kimi legacy — `~/.kimi/sessions/<project_hash>/<session_uuid>/wire.jsonl`

```jsonc
// shape only — fields the adapter reads
{"timestamp":1737567890,"message":{"type":"ToolCall","payload":{"function":{"name":"Shell","arguments":"{\"command\":\"ls\"}"}}}}
{"timestamp":1737567891,"message":{"type":"ContentPart","payload":{"type":"text","text":"Done."}}}
{"timestamp":1737567892,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":100,"output":20,"input_cache_read":50,"input_cache_creation":0},"context_tokens":170,"max_context_tokens":262144}}}
```

The adapter resolves project hashes from `~/.kimi/kimi.json` and common local work directories, then reads `state.json` for a user-facing title when present.

### Kimi Code — `~/.kimi-code/sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl`

```jsonc
// shape only — fields the adapter reads
{"type":"context.append_loop_event","time":1737567890000,"event":{"type":"tool.call","name":"Bash","toolCallId":"call_123","args":{"command":"ls"}}}
{"type":"context.append_loop_event","time":1737567890500,"event":{"type":"tool.result","toolCallId":"call_123","result":{"output":"ok"}}}
{"type":"context.append_loop_event","time":1737567891000,"event":{"type":"content.part","part":{"type":"text","text":"Done."}}}
{"type":"context.append_message","time":1737567891500,"message":{"role":"user","content":[{"type":"text","text":"Continue."}]}}
{"type":"config.update","time":1737567891750,"cwd":"/repo/path","modelAlias":"kimi-code/kimi-for-coding","thinkingLevel":"high"}
{"type":"usage.record","time":1737567892000,"model":"kimi-code/kimi-for-coding","usage":{"inputOther":100,"output":20,"inputCacheRead":50,"inputCacheCreation":0}}
```

Kimi Code also writes `~/.kimi-code/session_index.jsonl` entries shaped like `{ "sessionId", "sessionDir", "workDir" }`. The adapter uses both the persisted id and root-validated `sessionDir`/basename keys so project mapping survives if Kimi's stored id differs from the folder name, and falls back to `state.json` top-level `workDir`, then agent `homedir`, then `config.update.cwd`, when the index is missing. Current Kimi Code builds persist the project root as `workDir`; on those builds agent `homedir` points inside the session store, so it only remains a last-resort fallback for older layouts. Detail responses use the same project resolution. The adapter scans every `agents/<agent>/wire.jsonl`: `main` remains a primary session, while numbered or named agent dirs become `sub-agent` sessions. `config.update.modelAlias` is used as an early model/context signal before `usage.record` lines exist, and usage token fields accept both camelCase and snake_case spellings. `tool.result.result.isError` / `is_error` and exit fields are paired back to shell tool calls by `toolCallId` / `uuid` / related call-id aliases, so git events and tool-history rows can distinguish successful and failed pushes/commits. Child rows use persisted `state.json` `agents.<agent>.parentAgentId` metadata for nested child-to-child lineage when that parent row is active, and otherwise fall back to the main Kimi session. If child wires are active while `main` is stale or absent, the parent stays visible with child-derived activity; parent detail lookups also fall back to the newest child wire when no `main` wire exists, so UI lineage is not orphaned.

### Grok — `~/.grok/sessions/<url-encoded-cwd>/<session-id>/`

```jsonc
// summary.json — fields the adapter reads
{
  "info": { "id": "019f46ac-...", "cwd": "/Users/me/code/proj" },
  "session_summary": "Implement the feature",
  "generated_title": "Implement the feature",
  "current_model_id": "grok-4.5",
  "agent_name": "grok-build-plan",
  "reasoning_effort": "high",
  "created_at": "2026-07-09T11:38:44.476Z",
  "updated_at": "2026-07-09T11:42:08.151Z",
  "last_active_at": "2026-07-09T11:42:08.151Z"
}

// updates.jsonl — ACP session update stream (one line per event)
{"timestamp":1783597308,"method":"session/update","params":{"sessionId":"019f46ac-...","update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"run_terminal_command","rawInput":{"command":"ls"}},"_meta":{"totalTokens":12000}}}
{"timestamp":1783597309,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done."}}}}

// chat_history.jsonl — raw model messages
{"type":"user","content":[{"type":"text","text":"Hello"}]}
{"type":"assistant","tool_calls":[{"id":"call-1","name":"run_terminal_command","arguments":"{\"command\":\"ls\"}"}],"model_id":"grok-4.5","reasoning_effort":"high"}
{"type":"tool_result","tool_call_id":"call-1","content":"..."}
```

The adapter discovers sessions under `~/.grok/sessions/`, uses `summary.json` for model/title/activity, prefers `updates.jsonl` for live tools and message chunks, and falls back to `chat_history.jsonl`. Session ids are prefixed `grok-`. `totalTokens` from ACP update metadata is mapped to `tokenUsage.contextWindow` when present (Grok does not yet expose a full input/output split on disk). Optional `~/.grok/active_sessions.json` is watched but not required for discovery.

### OpenCode — `~/.local/share/opencode/opencode.db` (SQLite)

```jsonc
// session row shape only — fields the adapter reads
{
  "id": "ses_123",
  "parent_id": null,
  "directory": "/Users/me/code/proj",
  "title": "Review data",
  "agent": "build",
  "model": "{\"id\":\"deepseek-v4-pro\",\"providerID\":\"deepseek\"}",
  "tokens_input": 1200,
  "tokens_output": 300,
  "tokens_cache_read": 40000,
  "tokens_cache_write": 0,
  "time_updated": 1737567890123
}

// part.data examples
{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"git commit -m init"},"metadata":{"exit":0}}}
{"type":"text","text":"Done.","time":{"start":1737567890123,"end":1737567891123}}
```

OpenCode support is SQLite read-only. It uses `node:sqlite` with read-only mode when available and falls back to `sqlite3 -readonly` when the CLI is present. It never mutates provider config files and does not issue writes, migrations, checkpoints, or vacuum commands against OpenCode's database. DeepSeek-backed sessions are represented as `provider: 'opencode'` with `model: 'deepseek/<model-id>'`, which lets the UI keep the source CLI distinct from the model family.

### OMP — `~/.omp/agent/sessions/<project>/<timestamp>_<uuid>.jsonl` (one line per record)

```jsonc
// shape only — fields the adapter reads
{"type":"session","id":"0f6c2a9e-...","cwd":"/Users/me/code/proj","title":"Refactor","timestamp":"2026-09-01T12:00:00.000Z"}
{"type":"model_change","model":"zai/glm-5.3"}
{"type":"thinking_level_change","thinkingLevel":"high"}
{"type":"message","timestamp":"2026-09-01T12:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Fix the parser."}]}}
{"type":"message","message":{"role":"assistant","provider":"zai","model":"glm-5.3","timestamp":1788264002000,"usage":{"input":1200,"output":80,"cacheRead":4000},"content":[{"type":"thinking","thinking":"..."},{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"src/parser.js","i":"Reading parser"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"call-1","toolName":"read","isError":false,"content":[]}}
{"type":"custom","customType":"session_exit"}
```

Session ids are prefixed `omp-`. Nested task agents live in a sibling directory named like the parent transcript, `<project>/<timestamp>_<uuid>/<agent-name>.jsonl`; the uuid suffix becomes `parentSessionId` and the file name the `agentName`. A tool call's `arguments.i` intent is a `dialogue` candidate; `todo` tool calls fold into `todos`. The adapter reads the first 32 and last 2,500 lines of each transcript (5,000 for details).

Topology discovery tracks at most 4,096 transcripts across 4,096 directories. It walks project directories first, then visits session trees in order of their `<timestamp>_` name, newest first; nested agent files rank with their parent session. When history exceeds the cap, the oldest sessions are dropped, never the live ones. Readdir order does not affect this.

OMP retains verified detail id-to-path mappings for every collected session across appends and active-window expiry, and revalidates the selected file on use. Cold lookup discovers only header identities, stopping at the match or at 512 header files / 2 MiB (4 KiB per file); hitting the bound returns the ordinary missing-detail shape, never unrelated historical tails. Filename-matching parents are verified first; other candidates are ordered newest-mtime-first using the shared topology's file stats. A genuinely cold topology populates missing metadata once (bounded by the 4,096-transcript cap), while subsequent discovery reuses metadata already observed by active passes or earlier lookups. Unknown ids are cached against the shared discovery generation. Listings are cached by directory identity/mtime; ordinary passes stat known active and exact dirty paths, with a 30-second full reconciliation for missed events, removals, rotation, and new nested directories. The watcher footprint remains unchanged. Signature-keyed reduced state is bounded to 512 entries / 32 MiB and contains timeless facts; dialogue freshness, active-window membership, and turn presentation are derived on every collection. Changed files retain the shared guarded-append / partial-UTF-8 tail handling and the same bounded token/detail windows. `/api/perf` reports reduced-cache, header-discovery, and cold-metadata diagnostics plus actual per-pass bytes read (including head reads), rather than head-read estimates on cache hits.

OMP transcript reads retry once when a concurrent append changes the file. Continued writes defer that transcript until the next pass without degrading the provider; uncertain detail reads retain the registry's stale cached detail.
