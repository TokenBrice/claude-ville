# scripts/tests/

Unit tests for the signal layer, run by `npm run test:unit` (part of
`npm run validate:quick`). They use Node's built-in `node:test` runner — no
dependency, no build step, consistent with the rest of the project.

These cover the pure logic that decides **what the village believes about an
agent**. Everything the user sees — the bell, the beacon, the ATTN badge, the
attention cue, the dashboard header, the Chronicle — is downstream of these
functions, so a silent regression here misinforms every surface at once. They
are deliberately not renderer tests; canvas output stays covered by the sprite
visual diffs and the world validators.

| File | Covers |
| --- | --- |
| `turn-state.test.mjs` | `adapters/turnState.js` — turn-state derivation, and the dwell/permission-mode rules that separate a pending permission prompt from a tool that is simply slow. |
| `status-resolver.test.mjs` | `src/domain/services/StatusResolver.js` — status priority, and the two regressions the module exists to prevent: a long-running tool decaying to WAITING, and a finished turn never producing COMPLETED. |
| `session-residency.test.mjs` | `services/sessionResidency.js` — which sessions survive the active window, TTL expiry, re-classification as a wait lengthens, and the resident cap. |
| `chronicle-log.test.mjs` | `src/application/ChronicleLog.js` — commit-subject extraction and the day rollup. |
| `spend-ledger.test.mjs` | `src/application/SpendLedger.js` — delta banking, cache-read separation, backwards counters, rate windowing, and midnight rollover. |

## Conventions

- One behaviour per test, named as the claim it makes.
- Time is injected (`now` parameters), never `Date.now()` — these must not be
  flaky at midnight or under load.
- CommonJS modules under `adapters/` and `services/` load via `createRequire`;
  browser ES modules under `src/` are imported directly (Node detects the
  module type, which is why `NODE_NO_WARNINGS=1` is set on the script).

Frontend rendering, adapter fixture parsing, and watcher behaviour remain
covered by `scripts/smoke/` — see that directory's README.
