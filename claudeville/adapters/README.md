# Provider Adapters

Read-only readers that pull active session data from the local CLI provider directories (`~/.claude/`, `~/.codex/`, `~/.gemini/`) and normalize it into a single shape the rest of ClaudeVille consumes.

## Purpose

Each adapter wraps one provider's on-disk session format and exposes a small uniform contract. The server (`claudeville/server.js`) and the application layer never touch provider files directly; they go through `adapters/index.js`, which iterates available adapters and aggregates results.

Adapters never write. Provider session files are inputs; do not mutate them.

Registration happens in `claudeville/adapters/index.js`:

```js
const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
];
```

`isAvailable()` is checked on every aggregation pass, so machines without a provider installed are silently skipped.

## Adapter registry behavior

`adapters/index.js` is the aggregation layer used by `server.js`; the server does not read provider files directly.

- `getAllSessions(activeThresholdMs)` skips unavailable adapters, isolates per-adapter failures, merges results, sorts by `lastActivity` descending, and caches the full list briefly.
- `getSessionDetailByProvider(provider, sessionId, project)` dispatches to the matching adapter, caches successful detail payloads briefly, and returns stale cached details after an adapter error when possible.
- `getAllWatchPaths()` merges active adapter watch paths and ignores adapter watch-path errors.
- `getActiveProviders()` surfaces provider display names and home directories for `/api/providers`.

The short caches are intentional. The browser, activity panel, dashboard mode, WebSocket loop, and widget all poll near-live state, so the registry absorbs repeated identical reads without making the UI feel stale.

## Contract

Each adapter class must expose the following getters and methods. Getters are JS class getters (no parentheses), not methods.

| Member | Kind | Returns | Consumer |
| --- | --- | --- | --- |
| `name` | getter | display string (e.g. `'Claude Code'`) | `getActiveProviders()`, surfaced via `/api/providers` |
| `provider` | getter | stable id (`'claude'` / `'codex'` / `'gemini'`) | Adapter dispatch and adapter-backed session objects |
| `homeDir` | getter | absolute path to the provider's source dir | `getActiveProviders()` |
| `isAvailable()` | method | `boolean` | Gates every registry iteration |
| `getActiveSessions(activeThresholdMs)` | method | `Session[]` (see below) | Called from `server.js` per request and per polling tick |
| `getSessionDetail(sessionId, project)` | method | `{ toolHistory, messages, tokenUsage?, sessionId }` | Served at `/api/session-detail` |
| `getWatchPaths()` | method | `WatchPath[]` (see below) | Consumed by `server.js` in `startFileWatcher()` |

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
| `sessionId` | string | Unique across providers. Codex and Gemini prefix with `codex-` / `gemini-`; Claude uses the raw uuid; subagents use `subagent-<agentId>`. Repository-only git sessions use `git-repo-<hash>`. |
| `provider` | `'claude' \| 'codex' \| 'gemini' \| 'git'` | Adapter-backed sessions use `claude`, `codex`, or `gemini`. The registry can synthesize repository sessions with `provider: 'git'` for unpushed commit visibility. |
| `agentId` | string \| null | Provider-specific agent thread id; nullable for Gemini. |
| `agentType` | `'main' \| 'sub-agent' \| 'team-member'` | Drives sprite/card grouping. Default `'main'`. |
| `agentName` | string \| null | Human label when the provider exposes one (Codex `agent_nickname`, Claude team launch name). |
| `project` | string \| null | Absolute working directory. Gemini may resolve this from a SHA-256 hash and return null on failure. |
| `model` | string | Free-form. UI strips `claude-` and `-2025…` suffixes for display. |
| `status` | `'active'` | Currently always `'active'`; idle/terminated transitions are inferred client-side by `AgentManager`. |
| `lastActivity` | number (ms epoch) | Latest of file mtime and any in-file timestamp. Sort key. |
| `lastTool` | string \| null | Most recent tool name. |
| `lastToolInput` | string \| null | Compact summary of the tool's argument; truncated to ~60 chars. |
| `lastMessage` | string \| null | Most recent assistant text; truncated. |
| `tokenUsage` | object \| null | See "Token normalization" below. Some adapters omit this. |
| `parentSessionId` | string \| null | Set on subagent / spawned-thread sessions. |
| `reasoningEffort` | string \| null | Codex-only. Pulled from `turn_context` / `event_msg`. |
| `gitEvents` | array | Backend-extracted git `commit` / `push` events from raw tool records. Dry-run events are omitted. Events include `id`, `type`, `project`, `provider`, `sessionId`, `sourceId`, `ts`, and `commandHash`; `command`, `targetRef`, `success`, `exitCode`, and `completedAt` are optional metadata when the adapter can derive them. |

### Git event extraction

`gitEvents.js` extracts only high-signal repository events from raw tool commands:

- `git commit` and `git push` commands are included.
- Dry-runs are omitted.
- Push `targetRef` is inferred when a refspec is visible.
- Codex can sometimes attach completion metadata from command-end events (`success`, `exitCode`, `completedAt`).
- Parsing is best-effort and command-string based; do not treat events as an authoritative audit log.

Adapters attach `gitEvents` to active session objects. `/api/session-detail` and `POST /api/session-details` currently focus on tool history, messages, and tokens, so consumers that need git events should read them from the session list data.

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

The fallback chain exists because providers rename fields between releases (Codex switched to cumulative `token_count` events; Gemini varies between camelCase and snake_case). Adapters absorb the variance so the UI does not need provider-specific conditionals.

## `getWatchPaths()` shape

Returns an array of:

```js
{ type: 'file' | 'directory', path: string, recursive?: boolean, filter?: string }
```

`server.js` consumes the array in `startFileWatcher()` as follows:

- `type === 'file'`: `fs.watch(path)` is attached; any `change` event triggers a debounced broadcast.
- `type === 'directory'`: `fs.watch(path, { recursive })` is attached; `filter` (if provided) requires the changed filename to end with that suffix (e.g. `.jsonl`, `.json`).
- Missing paths are silently skipped (`fs.existsSync` guard).
- Watch errors are swallowed so a single broken path does not prevent other watchers from registering.

The 2-second polling interval in `startFileWatcher` is independent of these watches and runs even if no path could be attached; the broadcast itself no-ops when no WebSocket clients are connected.

## How to add a provider

1. Create `claudeville/adapters/<name>.js` exporting a class that implements the contract above. Use the existing adapters as templates — they all follow the same module-private parser helpers + adapter class layout.
2. Register the new instance in `claudeville/adapters/index.js`. Add the require and append to the `adapters` array.
3. Confirm `isAvailable()` returns `true` only when the provider's home directory exists. Do not throw on missing files — return `false` or an empty array.
4. Confirm `getWatchPaths()` returns valid `{ type, path, recursive?, filter? }` entries. Prefer `type: 'directory'` with a `filter` over watching every file individually.
5. Validate:
   - `node --check claudeville/adapters/<name>.js`
   - `npm run dev`
   - `curl http://localhost:4000/api/providers` — confirm the new provider appears.
   - `curl http://localhost:4000/api/sessions` — confirm normalized session objects come through.

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

Subagent files at `~/.claude/projects/<encoded-project>/<sessionId>/subagents/agent-<id>.jsonl` follow the standard Claude message-event JSONL schema; the adapter reads `message.role`, `message.content`, and `usage` blocks from each line.

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (one line per record)

```jsonc
// shape only — fields the adapter reads
{"type":"session_meta","payload":{"id":"thr_01J9X...","cwd":"/Users/me/code/proj","model":"gpt-5","agent_nickname":"plan-bot","agent_role":"main"}}
{"type":"turn_context","payload":{"model":"gpt-5","effort":"medium"}}
{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"ls\"}"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12000,"output_tokens":340,"cached_input_tokens":8000},"last_token_usage":{"total_tokens":420},"model_context_window":200000}}}
```

The adapter reads `session_meta` from the first 5 lines and tools/messages/usage from the last 50–500 lines.

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
