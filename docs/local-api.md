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
| `GET /api/usage` | Usage, subscription, activity, and quota metadata. |
| `GET /api/perf` | Runtime counters: watchers, caches, adapter scan cost, event loop, memory. |
| `GET /api/changelog` | Raw `CHANGELOG.md` text for the in-app changelog modal. |
| `ws://localhost:4000/ws` | Same-origin snapshot, delta updates, and ping/pong heartbeats. |

Git identity on `/api/sessions` (all fields optional; a client keys a repository on `repoRoot || project`, so older servers still work):

- Sessions inside a repository carry `repoRoot` (its main worktree path, shared by every linked worktree and subdirectory) and `worktree: { name, path, isMain }`.
- Every git event carries `repoRoot`, `checkout`, `worktree` and `cwd` (where the command actually ran, after `cd` or `git -C`). Commits add `sha`, `branch` (frozen when first observed) or `detached`, `author`, `coAuthors` and `attribution` (`observed`: the session ran it; `scanned`: a repository scan found it). Pushes add `refs: [{ src, dst, status, sha? }]`, `status`, `reason` (first stderr line, at most 200 characters), `tag`/`tagsOnly`, `deleted`, `synthetic` (`transition` or `inferred`) and `landedShas`, the shas the server verified a remote-tracking ref now contains.
- `type: 'rewritten'` events (`oldShas`, optional `replacements: [{ oldSha, newSha }]`) report commits that left a branch without reaching a remote: an amend, a rebase or a reset.

The adapter contract has the extraction rules: [git event extraction](../claudeville/adapters/README.md#git-event-extraction).

The server does not enable CORS and rejects `OPTIONS` requests. Missing or invalid routes receive JSON error responses.

With `npm run dev` running, inspect provider detection and session discovery:

```bash
curl http://localhost:4000/api/providers
curl http://localhost:4000/api/sessions
```

These responses can contain private paths and session content; redact them before sharing.

For server ownership and lifecycle, see [the runtime guide](../claudeville/CLAUDE.md). For provider payloads and parsing, see [the adapter contract](../claudeville/adapters/README.md).
