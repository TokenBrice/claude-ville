# Local Server API

The server is hardcoded to port `4000` and the IPv4 loopback interface. Requests with a non-local `Host` or a cross-origin browser `Origin` are rejected; origin-less local CLI requests remain supported.

| Endpoint | Description |
| --- | --- |
| `GET /api/sessions` | Live sessions and retained observations from available providers, with a shared git-event table and scan state. `force=1`, `force=true`, or `force=yes` bypasses the session-list cache. |
| `GET /api/session-detail?sessionId=&project=&provider=` | Tool history, recent messages, and token usage where available. |
| `POST /api/session-details` | Batch detail fetch. Body: `{ "items": [{ "key", "sessionId", "project", "provider" }] }`; max 256 KiB, first 100 items, invalid providers skipped; `count` is the number of returned detail payloads. |
| `POST /api/ingest/hook` | Opt-in lifecycle events from local CLI hooks (loopback, in memory, expiring). Set `CLAUDEVILLE_INGEST_TOKEN` to require a matching `X-ClaudeVille-Ingest-Token` header. Hook stanzas: [docs/troubleshooting.md](troubleshooting.md#permission-prompts-are-inferred-or-arrive-late). |
| `GET /api/teams` | Claude Code team metadata from `~/.claude/teams/`. |
| `GET /api/tasks` | Claude Code task groups from `~/.claude/tasks/`. Diagnostic; the UI does not fetch it. |
| `GET /api/providers` | Detected providers, home directories, and per-provider health. |
| `GET /api/usage` | Claude subscription, activity and quota, plus the Codex account quota ([fields](#usage-and-quota)). |
| `GET /api/perf` | Runtime counters: watchers, caches, adapter scan cost, event loop, memory. |
| `GET /api/changelog` | Raw `CHANGELOG.md` text for the in-app changelog modal. |
| `ws://localhost:4000/ws` | Same-origin snapshot, delta updates, and ping/pong heartbeats. |

Git identity on `/api/sessions` (all fields optional; a client keys a repository on `repoRoot || project`, so older servers still work):

- Sessions inside a repository carry `repoRoot` (its main worktree path, shared by every linked worktree and subdirectory) and `worktree: { name, path, isMain }`.
- Every git event carries `repoRoot`, `checkout`, `worktree` and `cwd` (where the command actually ran, after `cd` or `git -C`). Commits add `sha`, `branch` (frozen when first observed) or `detached`, `author`, `coAuthors` and `attribution` (`observed`: the session ran it; `scanned`: a repository scan found it). Pushes add `refs: [{ src, dst, status, sha? }]`, `status`, `reason` (first stderr line, at most 200 characters), `tag`/`tagsOnly`, `deleted`, `synthetic` (`transition` or `inferred`) and `landedShas`, the shas the server verified a remote-tracking ref now contains.
- `type: 'rewritten'` events (`oldShas`, optional `replacements: [{ oldSha, newSha }]`) report commits that left a branch without reaching a remote: an amend, a rebase or a reset.

The adapter contract has the extraction rules: [git event extraction](../claudeville/adapters/README.md#git-event-extraction).

## Usage and quota

`GET /api/usage` returns the same object that rides on every WebSocket `init` and `update` as `usage`. Clients feature-detect the newer fields, which older servers omit.

- `provider: 'claude'`, `account: { subscriptionType, rateLimitTier }` and `activity: { today, thisWeek }`, each `{ messages, sessions }` from `~/.claude/history.jsonl`.
- `quota`: the Claude windows as 0–1 ratios, `fiveHour` and `sevenDay`, with `fiveHourResetsAt` and `sevenDayResetsAt` in epoch ms. Every field is null while `quotaAvailable` is false: before the first good check, once the snapshot is 30 minutes old, or after a 401.
- `quotaError`: `{ status, at }` while the last quota check failed with 401 (the stored token expired; running `claude` refreshes it) or 429 (the check is throttled and backs off), where `at` is when the failure began. Otherwise null.
- `codex`: the Codex account's quota from the newest `token_count.rate_limits` in its rollouts, or null when none was observed. It is `{ usedPercent, windowMinutes, resetsAt, credits: { balance, hasCredits, unlimited }, limitReached, observedAt }`:
  - `usedPercent` (0–100) and `resetsAt` (epoch ms) describe the binding window, the highest among windows that have not reset. Once its `resetsAt` passes, both are null: unknown, never 0 %.
  - `limitReached` is true at `usedPercent >= 100`, or whenever Codex reports `rate_limit_reached_type`. It drives account surfaces only (the Hourglass Belfry's lavender cord in the World and the Dashboard quota card) and never a session's status.
  - `observedAt` is the record's own time, so it can be hours old when no Codex session is live.

## WebSocket messages

`/ws` sends JSON text frames. A full frame, `init` (on connect and on resync) or `update`, carries `sessions`, the git-event tables, `collisions`, `teams`, `usage`, `seq`, `scanning`, `staleAt` and `timestamp`. A client that sent `{ type: 'hello', deltas: true, deltaVersion: 2 }` also receives `update-delta` patches between full frames ([framing and sequencing](design-decisions.md#hand-written-websocket-framing)).

- `server: { version, bootId }` rides on every full frame, never on a delta. It holds the `package.json` version and a random id minted at boot. `WebSocketClient` remembers the first identity it sees and emits `ws:server-changed` `{ from, to, versionChanged }` once per new identity, so a long-lived tab can offer a reload after a restart (`versionChanged: false`) or an upgrade.
- `{ type: 'resync' }` asks for a fresh baseline, answered by an `init`. If the fresh collection fails, the retained baseline comes back as an `init` with `scanning: true`; before any baseline exists, the reply is `{ type: 'snapshot-error', code: 'snapshot-unavailable' }`. The client re-sends an unanswered resync after 10 s and drops the socket for a reconnect after a second miss.
- `{ type: 'ping' }` is answered with `{ type: 'pong', timestamp }`, and `WebSocketClient` sends one every 20 s. A quiet, healthy village receives no broadcasts (unchanged payloads are skipped), so liveness keys on the last message of any kind, never on snapshot age. No message within 10 s of a ping sets `stale: true` and `lastErrorCode: 'link-silent'` on `ws:state` (which also carries `lastMessageAt`), and a second unanswered ping drops the socket for a reconnect. The server's own 30-second heartbeat (protocol ping frames) closes a client silent for 90 s, except on the first tick after the server process itself was paused.

The server does not enable CORS and rejects `OPTIONS` requests. Missing or invalid routes receive JSON error responses. Static routes serve only the client: `/` and `/m` (the shell), its manifests and icons, and `src/`, `css/`, `assets/`, `vendor/` and `tools/`. Server source and agent docs under `claudeville/` return 404.

With `npm run dev` running, inspect provider detection and session discovery:

```bash
curl http://localhost:4000/api/providers
curl http://localhost:4000/api/sessions
```

These responses can contain private paths and session content; redact them before sharing.

For server ownership and lifecycle, see [the runtime guide](../claudeville/CLAUDE.md). For provider payloads and parsing, see [the adapter contract](../claudeville/adapters/README.md).
