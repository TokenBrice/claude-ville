# Adapter transcript fixtures

These synthetic JSONL transcripts test parser contracts without reading real provider history. They contain no real prompts, credentials, usernames, repository paths, or provider identifiers.

| Provider | File | Purpose |
| --- | --- | --- |
| Claude | `claude/all-records.jsonl` | Broad projection: tools/results, tokens/cost, branch/effort, todos, changes, duration, hooks, and bounded text. |
| Claude | `claude/minimal.jsonl` | Completed turn proving defaults and estimated cost without richer records. |
| Claude | `claude/git-outcomes.jsonl` | Git calls with outcomes: an `is_error` hook rejection, a chained commit with `[branch sha]` output, a rejected push behind `|| true`, and a push from a subdirectory `cwd`. |
| Claude | `claude/shell-prefix.jsonl` | Bash calls behind `cd <dir> &&`, `cd <dir>;` and `git -C <dir>`; the summary must keep the command. |
| Claude | `claude/tool-results.jsonl` | Flagged results (`Exit code 1`, a codeless error, an `Edit` miss, an explicit success), plus an unflagged read, a background command, an async agent launch, an interrupted and a rejected call, and one pending call: only the four flagged outcomes publish. |
| Claude | `claude/agent-launch.jsonl` | Parent transcript with an `Agent` launch and declared child identity. |
| Claude | `claude/agent-child.jsonl` | Paired child transcript proving parent/subagent identity linkage. |
| Claude | `claude/teammate-child.jsonl` + `.meta.json` | Teammate transcript whose `<teammate-message>` prompt matches no launch, with the sibling meta file carrying name, team, colour and kind. |
| Claude | `claude/api-request-blob.jsonl` + `-child.jsonl` | Current transcript shape: `api-request`, `api-request-shape` and timestamp-less `api-request-blob` copies interleaved with a parent's `Agent` launch, a `SendMessage` and a closed turn, and a subagent child whose unflagged copies trail a pending `Bash`. Only `user`/`assistant` records are turns. |
| Codex | `codex/abort-after-pending.jsonl` | Pending tools followed by `turn_aborted`; pending state must clear. |
| Codex | `codex/full-auto-pending.jsonl` | Old pending command under full-auto remains working, not permission-blocked. |
| Codex | `codex/item-completed.jsonl` | Ordered file changes and a failed argv command (`bash -lc` behind a `cd` hop) with duration, stderr, and exit status; every summary is the bare script. |
| Codex | `codex/long-running-turn.jsonl` | Old active turn with token events remains running rather than decaying idle. |
| Codex | `codex/turn-durations.jsonl` | A completed turn with `duration_ms`, an aborted turn, then a completed turn without one: the last completed turn's span is the duration. |
| Codex | `codex/tool-results.jsonl` | Command completions with exit 0, exit 1, an unknown exit, and one invocation that never completes. |
| Codex | `codex/git-commit-push.jsonl` | Current rollout shape: `custom_tool_call` plus `item_completed` `CommandExecution` (command array, `file://` cwd) for a commit, a nothing-to-commit failure, a `push -u origin HEAD \| tail` and a `git -C` commit in a nested repository. |
| Kimi Code | `kimi/tool-results.jsonl` | Wire loop events: a passing and a failing command result, plus a result carrying only output (no outcome). |
| OpenCode | `opencode/tool-results.jsonl` | Normalized tool parts with `metadata.exit` 0 and 1, plus a part with no exit at all. |
| OMP | `omp/tool-results-session-exit.jsonl` | Paired success, failure, and unknown results; an unpaired result and an unfinished call; explicit `session_exit`. |

## Redaction rule

Author fixtures synthetic-first. If derived from provider output, replace every prompt/message, absolute path, account or session identifier, repository/remote, command output, secret, and token-like value. Preserve only required shape, ordering, types, and harmless numeric relationships. Use placeholders such as `__PROJECT__` and `__NOW__`; never commit a lightly edited real transcript.

## Consumers

`rg -l 'adapters/fixtures' scripts` identifies the direct consumers:

- `scripts/tests/claude-identity.test.mjs` uses Claude launch, child, teammate-with-meta, and minimal records.
- `scripts/tests/claude-projection.test.mjs` uses broad, minimal and `api-request-blob` Claude records (it resolves the fixture root without spelling the full search string).
- `scripts/tests/turn-state.test.mjs` copies the Codex fixture directory into a synthetic provider home.
- `scripts/tests/integration/session-payload-contract.test.mjs` replays the broad Claude fixture through an isolated server.
- `scripts/tests/tool-results.test.mjs` materializes the Codex and Kimi Code result transcripts in a synthetic home, replays the OpenCode parts through `buildOpenCodeSession`, replays the Claude outcome fixture, and uses the broad Claude record as the no-flag, no-result control.
- `scripts/tests/harbor-ingest-adapters.test.mjs` materializes the Claude and Codex git fixtures over a temporary repository and checks outcomes, identity and per-segment status.
- `scripts/tests/shell-location-prefix.test.mjs` replays the Claude shell-prefix fixture and pins the stripped summary.
- `scripts/tests/living-isle-outcomes.test.mjs` replays the OMP outcomes/session-exit fixture, including explicit departure and resumed-session behavior.

`npm run check:adapter-fixtures` is a broad executable adapter contract. It creates synthetic ClaudeVille, Codex, Kimi, OpenCode, and OMP state and checks normalization, detail dispatch, discovery, fixture-backed turn states, and OMP outcomes/session ends. Unit fixtures are narrower named `node:test` cases run by `npm run test:unit`; the integration consumer runs only under `npm run test:integration`.
