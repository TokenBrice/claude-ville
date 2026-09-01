# scripts/tests/

Unit tests for signal and pure renderer-policy logic, run by `npm run test:unit` (part of
`npm run validate:quick`). They use Node's built-in `node:test` runner — no
dependency, no build step, consistent with the rest of the project.

The signal tests decide **what the village believes about an agent**. The
renderer-policy tests cover deterministic admission, resource accounting,
material records, atlas layout, and degradation without requiring Canvas or a
browser. Actual pixels stay covered by sprite/channel validation, visual diffs,
and World validators.

| File | Covers |
| --- | --- |
| `turn-state.test.mjs` | `adapters/turnState.js` — turn-state derivation, and the dwell/permission-mode rules that separate a pending permission prompt from a tool that is simply slow. |
| `status-resolver.test.mjs` | `src/domain/services/StatusResolver.js` — status priority, and the two regressions the module exists to prevent: a long-running tool decaying to WAITING, and a finished turn never producing COMPLETED. |
| `session-residency.test.mjs` | `services/sessionResidency.js` — unresolved-tool residency, completed-turn exclusion, TTL expiry, re-classification as a wait lengthens, and the resident cap. |
| `chronicle-log.test.mjs` | `src/application/ChronicleLog.js` — commit-subject extraction and the day rollup. |
| `spend-ledger.test.mjs` | `src/application/SpendLedger.js` — delta banking, cache-read separation, backwards counters, rate windowing, and midnight rollover. |
| `material-contract.test.mjs` | Semantic material defaults, nine-landmark metadata, Canvas-compatible drawable/GPU seams, SpriteRenderer placement parity, and deterministic atlas packing. |
| `postfx-ladder.test.mjs` | PostFX degradation/recovery hysteresis, timing-driver attribution, and sticky degradation reasons. |
| `postfx-feed.test.mjs` | Water-mask cache reuse, camera-pose rebuild diagnostics, and mask resource ownership. |
| `trail-render-policy.test.mjs` | Camera-motion classification, world-cache admission, and no-repaint pose transforms. |
| `canvas-budget.test.mjs` | Named GPU texture/attachment/buffer accounting and the unified Canvas/GPU byte ledger. |
| `render-baseline-manifest.test.mjs` | Required deterministic scenes, atmospheres, desktop sizes, renderer modes, camera declarations, and north-star coverage. |

## Conventions

- One behaviour per test, named as the claim it makes.
- Time is injected (`now` parameters), never `Date.now()` — these must not be
  flaky at midnight or under load.
- CommonJS modules under `adapters/` and `services/` load via `createRequire`;
  browser ES modules under `src/` are imported directly (Node detects the
  module type, which is why `NODE_NO_WARNINGS=1` is set on the script).

Frontend rendering, adapter fixture parsing, and watcher behaviour remain
covered by `scripts/smoke/` — see that directory's README.
