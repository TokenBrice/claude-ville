# Adapter + Server Stability Review — Reviewer Output

Verdict: approve-with-fixes
Baseline HEAD: 7b5a452

## Smoke Scripts

- `node scripts/smoke/adapters.mjs` → PASS (5/5)
  ```
  [adapters.mjs] fixture: /tmp/cv-smoke-claude-a6qk46
    PASS adapter reports availability for fixture HOME
    PASS getActiveSessions returns an array
    PASS main session from history.jsonl is present
    PASS subagent appears with parentSessionId linking to main
    PASS team-member session resolves teamName via teams/<team>/inboxes
  [adapters.mjs] PASS
  ```
- `node scripts/smoke/relationship.mjs` → PASS (7/7)
  ```
    PASS parentToChildren maps the parent to 3 subagent ids
    PASS childToParent inverts the parent->children mapping
    PASS teamToMembers resolves the team to its member id
    PASS membership cache: teamToMembers Map instance is preserved when not dirty
    PASS membership cache: inner team array reference is preserved when not dirty
    PASS membership cache: parentToChildren Set reference is preserved when not dirty
    PASS membership cache: marking dirty rebuilds the inner team array
  [relationship.mjs] PASS
  ```

Both scripts exit 0. A `[MODULE_TYPELESS_PACKAGE_JSON]` warning is emitted on the relationship script (ES module reparse) — cosmetic only, but noted in **Optional Improvements**.

## Adapter Parse Cases

All run via `node -e "..."` importing `claudeville/adapters/gitEvents.js`, with context `{ provider:'test', sessionId:'s1', project:'/tmp/repo', ts:1000 }`.

| Input | Expected | Actual | Status |
| --- | --- | --- | --- |
| `git push --force-with-lease=origin/main origin main` | type=push, force='lease', targetRef='main' | `{type:'push', force:'lease', dryRun:false, targetRef:'main'}` | PASS |
| `git push +refs/heads/feature/x --quiet` | type=push, force=true | `{type:'push', force:true, dryRun:false}` (no targetRef — see note) | PASS-with-note |
| `git pull --rebase origin main` | type=pull, remote='origin', targetRef='main' | `{type:'pull', remote:'origin', dryRun:false, targetRef:'main'}` | PASS |
| `git fetch --all --prune --tags` | type=fetch, flags=['--all','--prune','--tags'] | `{type:'fetch', flags:['--all','--prune','--tags'], dryRun:false}` | PASS |
| Heredoc commit `git commit -m "$(cat <<'EOF'\nfeat: x\n\nBody with && in it\nEOF\n)"` | commit with parseable subject | type=commit; `commitMessageFromCommand` → `'feat: x Body with && in it'`; `cleanCommitSubject` strips the `$(cat <<'EOF' ... EOF )` wrapper cleanly | PASS |
| `git push --dry-run origin main` (`ignoreDryRun:true`, default for command source) | NO event emitted | `[]` | PASS |
| `git push --dry-run origin main` (`ignoreDryRun:false`) | event with `dryRun:true` | `{type:'push', dryRun:true, targetRef:'main'}` | PASS |

Notes:
- Case 2 (`+refs/heads/feature/x`): the `+` prefix correctly sets `force: true`, but because `--force/+` parsing happens BEFORE the positional collector inside `pushPositionals`, and the leading `+` is also caught by `if (token.startsWith('+') && force === null) force = true` AFTER the positional was already skipped, the refspec itself is dropped from `positionals` (it starts with `+` but the prefix-skip falls through). Result: `targetRef` is `null`. The `force` flag is still surfaced correctly, and `targetRef` is later filled by `currentBranch(project)` when project is a real repo. This is documented behavior in `createGitEvent` (lines 461-466). Likely acceptable; flag for the harbor reviewer.
- Dry-runs are correctly suppressed by default (`extractGitEventsFromCommandSource` → `parseGitEventsFromCommand` with default `ignoreDryRun !== false`). No synthetic push or ship will be generated.

## Status Normalization

`normalizePushStatus` from `claudeville/src/presentation/shared/GitEventIdentity.js` (lines 78-115):

- `{ success:false, stderr:'failed to push some refs to ...' }` → `'rejected'` (matches stderr regex /failed to push some refs/) — OK
- `{ exitCode:1, stderr:'rate limit exceeded' }` → `'failed'` — OK
- `{ status:'cancelled' }` → `'cancelled'` — OK
- `{ success:false, stderr:'Connection timed out after 30s' }` → `'failed'` — **CLARIFY**

Smoke sanity checks (extra):
- `{ success:true }` → `'success'`
- `{ status:'success' }` → `'success'`
- `{ exitCode:0 }` → `'success'`
- `{ status:'rejected' }` → `'rejected'`
- `{ status:'timed_out' }` → `'cancelled'`

**Clarification needed (Case D, "Connection timed out after 30s"):** the stderr regex at line 84 only catches `/rejected|non-fast-forward|failed to push some refs/i`. A timeout reported via stderr-only (no `status` keyword and `success:false`) falls into the boolean branch and is classified as `'failed'`. Only when status text contains `cancelled|canceled|timed_out|timeout` is it surfaced as `'cancelled'`. The task brief asks to confirm intended classification — I lean toward **intended**: keeping stderr-only timeouts as `'failed'` avoids over-classifying transient network errors as soft "cancelled" returns. But if the harbor renderer is supposed to use the soft-return animation for timeouts, the stderr regex should also include `/timed? out|timeout|connection reset/i`. Recommend the harbor reviewer (R3?) decide which animation the user should see.

## SubAgent Payload

Confirmed via dynamic `eventBus.on('subagent:dispatched', ...)` capture (parent in world, child has `parentSessionId`, `agentType`, `agentName`, `subagent_type`). Payload:

```json
{
  "parentId": "parent-1",
  "childId": "subagent-x",
  "childAgentType": "general-purpose",
  "childAgentName": "R1: foo",
  "childSubagentType": "reviewer",
  "ts": 1779043625490
}
```

All Phase 0.3d fields present (`AgentEventStream.js` lines 264-266).

## Server Syntax / Behavior

- `node --check claudeville/server.js` → OK.
- `node --check` over all `claudeville/adapters/*.js` → OK (4 files).
- `cacheStampCounter` (defined at L718) bumps at:
  - L750 — `markProviderDataDirty()` (every watch event / fallback scan).
  - L767 — `getTeamsCached()` when `teamsDirty` flips to false (i.e., after first refresh).
- All session-list and detail invalidation paths go through `invalidateSessionCaches` which is called from `markProviderDataDirty` (L751), so the stamp gate is consistent with cache state.
- `broadcastUpdate` (L790-857) uses `stampAtCollect` captured right before payload collection, so a watch event that arrives mid-collect still triggers a fresh broadcast on the next tick. Good.
- `getWatchFallbackSignature` (L1019-1123): now scans root's immediate children (`projects/*`), per-dir cache keyed by `${provider}:${filter}:${childPath}`, total budget capped (`WATCH_FALLBACK_MAX_ENTRIES`). Skip path uses `cacheFresh || (cached && !isActive && dirIdle)`. Active dirs come from `getRecentlyActiveDirs()`. The fallback root walk on `readdirSync` failure still works (L1029-1038). Looks solid.

## WebSocket Reconnect

`claudeville/src/infrastructure/WebSocketClient.js`:

- `_scheduleReconnect` (L92-107):
  - Increments `reconnectAttempts`.
  - `backoff = min(WS_RECONNECT_INTERVAL * 2^(attempts-1), 15000)` — **15s cap confirmed**.
  - `delay = backoff + Math.random() * 500` — **jitter 0-500ms confirmed**.
  - Logs only after 3 attempts (good — avoids noise on healthy reload).
- `reconnectAttempts` reset:
  - L27 (`_clearReconnect()` only) on `onopen` — does NOT touch the counter.
  - L77 (`_handleMessage` case `'init'`) — **sets `reconnectAttempts = 0`**, matching the spec comment "Reset reconnect attempts only after server confirms a healthy session, so half-open TCPs that never deliver init keep backing off."

All three reconnect properties match the spec.

## Live Server Smoke

| Endpoint | HTTP | Notes |
| --- | --- | --- |
| `/api/providers` | 200 | 3 providers: claude, codex, kimi. Anomaly: Kimi reported as available with `homeDir:/home/ahirice/.kimi`, but the recent commit history shows only `claude/codex/gemini` adapters — verify whether `kimi` is intended. (See **Optional**.) |
| `/api/sessions` | 200 | Array of 9 sessions; first session is subagent with `parentSessionId`, 34 gitEvents, all expected fields present. |
| `/api/usage` | 200 | (not deep-inspected) |
| `/api/perf` | 200 | `gitEnrichment.gitCommandTimeouts=0`, `gitCommandErrors=0`, 8215 commands over 758 enrichment calls, 3429 cache hits — healthy. `recursiveWatchFallbacks=0`, `activeWatchPaths=39`. |
| `/api/teams` | 200 | (curl only, not body-parsed) |

Live perf indicates the in-process git enrichment is well within budget (~30s cumulative across 758 calls = ~40ms/call, capped at 750ms per git command).

## Blockers

None.

## Required Fixes

None for this scope. The "Connection timed out" stderr classification is a clarification, not a bug; behavior matches code.

## Optional Improvements

1. **Timeout-in-stderr coverage** — extend the stderr regex in `normalizePushStatus` (`GitEventIdentity.js:84`) to also match `/timed? out|timeout|connection reset/i` so that bare-success-false events with network-timeout stderr are surfaced as `'cancelled'` rather than `'failed'`. Defer until R3 confirms which harbor animation is appropriate.
2. **Force refspec `targetRef`** — when a `+refs/heads/...` refspec is the only positional, `extractTargetRef` currently misses it because `pushPositionals` skips tokens that `startsWith('+')` via the `force = true` branch but does not also push the stripped refspec onto `positionals`. Fix: when force is set from a `+`-prefixed token, still `positionals.push(token)` so `normalizeRefName` can strip the prefix. Low-risk; current behavior is masked by `currentBranch(project)` fallback for real repos.
3. **ES module package warning** — add `"type":"module"` (or rename ES-module files to `.mjs`) to silence `MODULE_TYPELESS_PACKAGE_JSON` reparse cost on `RelationshipState.js` and `GitEventIdentity.js`. Performance is negligible at this scale; cosmetic.
4. **Kimi adapter sanity** — `/api/providers` lists `kimi` as available, but it isn't referenced in the project map. Confirm it's intentional and that `adapters/kimi.js` is in scope.

## File / Line References

- `claudeville/adapters/gitEvents.js:339-377` — `pushPositionals` (force + refspec parsing).
- `claudeville/adapters/gitEvents.js:379-401` — `pullFetchPositionals` (flags array).
- `claudeville/adapters/gitEvents.js:437-480` — `createGitEvent` (stderr threading at L477).
- `claudeville/adapters/claude.js:516-555` — stderr capture per `tool_use_id`.
- `claudeville/adapters/codex.js:535-570` — stderr capture in completion path.
- `claudeville/adapters/gemini.js:293-303` — stderr stub on git events.
- `claudeville/src/presentation/shared/GitEventIdentity.js:78-115` — `normalizePushStatus` (rejected/cancelled/failed branches).
- `claudeville/src/presentation/character-mode/AgentEventStream.js:261-269` — `subagent:dispatched` payload enrichment.
- `claudeville/src/infrastructure/WebSocketClient.js:23-28, 73-90, 92-107` — onopen/init/_scheduleReconnect.
- `claudeville/server.js:718, 750, 767, 798-808, 1019-1123, 1137` — cacheStampCounter + getWatchFallbackSignature.

## Risk Severity

**Low.** All smoke scripts green, all 5 documented adapter parse cases pass, all 3 required status normalizations pass (timeout-via-stderr is the only ambiguity and is a UX-classification question, not a bug). Server runs cleanly with healthy perf counters. WebSocket reconnect spec satisfied (cap=15s, jitter=0-500ms, reset on init).
