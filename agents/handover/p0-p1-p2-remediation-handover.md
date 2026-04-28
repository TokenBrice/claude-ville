# P0+P1+P2 Remediation Handover

Date: 2026-04-28
Role: handover-manager-5.5.high
Baseline HEAD: `d01f400976a268da7a28630e546d6fe64381755a`
Plan source: `agents/plans/code-health-remediation-plan.md`

## Current State

- Handover status: P0, P1, and P2 reviewer reports incorporated.
- Scope covered: P0, P1, and P2 remediation swarm completion notes.
- Edit boundary: this handover artifact only.

## P0 Completion Notes

Reviewer verdict: approve. No P0 must-fix issues.

Completed fixes:

- Codex active session discovery now scans all session date directories and filters by file `mtimeMs`, addressing missed long-running sessions in older day directories.
- Claude token usage now reads full sessions and exposes summed totals through both `input`/`output` and `totalInput`/`totalOutput`.
- Oversized JSON bodies now return `413` instead of destroying the request.
- Static path serving now checks resolved static root plus path separator boundary.
- Boot, sidebar, and activity unsafe dynamic HTML sinks were removed via DOM construction in `claudeville/src/presentation/shared/DomSafe.js`.
- Minimap now receives live `agentSprites` and converts sprite coordinates back to tile coordinates.
- Composed building cell misses now throw instead of silently rendering placeholders.
- Widget launch now builds before opening, widget artifacts are ignored, and sprite visual-diff baselines moved under `scripts/`.

Follow-up implications:

- Track Codex session scanning performance if local historical session trees become very large.
- Static serving still relies on lexical root containment rather than realpath symlink containment; reviewer did not consider this P0-blocking.

Open issues: none for P0.

## P1 Completion Notes

Reviewer verdict: approve after fixes. No remaining P1 must-fix issues.

Completed fixes:

- `/api/perf` now exposes watcher failures, recursive watch fallbacks, fallback scan counts, and fallback-triggered changes. Recursive watch setup/runtime failures receive a bounded stat fallback.
- WebSocket parsing now buffers split/coalesced frames and enforces a max payload guard.
- Cache behavior was simplified: `cacheControlFor` collapsed to the current no-cache behavior, `teamsCache.signature` was removed, watch paths are tagged with provider identity, and detail/adapter invalidation is provider-scoped where known with global fallback for unknown changes.
- Codex active rollout discovery remains file-mtime based with bounded cold/warm traversal caps, while ordinary provider invalidations preserve rollout discovery metadata.
- Synthetic unpushed git commit events are merged with observed commit events instead of replacing them, using SHA and heuristic command/time/text fallback matching.
- Usage quota local-day boundaries now use local midnight rather than UTC date strings.
- Domain event listener failures are isolated and logged without blocking later listeners.
- TopBar quota UI now hides/resets bars when quota data is unavailable, avoiding stale percentages.
- Avatar canvases track sprite asset versions and redraw when manifest-resolved versions differ.
- Dashboard card visibility/detail selection and avatar cleanup were hardened for removed or destroyed cards.

Follow-up implications:

- Recursive watch fallback only marks dirty after an initial fallback signature exists; the first missed change may wait for normal full discovery cadence.
- Git commit matching without SHA remains heuristic.
- Codex cold discovery is bounded by generous caps, preferring newest-first partial discovery over unbounded scans if caps are exceeded.

Open issues: none for P1.

## P2 Completion Notes

Reviewer verdict: approve after one must-fix.

Must-fix resolved:

- `ToolIdentity` was moved from presentation/shared to `claudeville/src/domain/services/ToolIdentity.js` after `Agent.js` imported it from the domain layer. `Agent` now imports `../services/ToolIdentity.js`, presentation callers import from `../../domain/services/ToolIdentity.js`, no presentation/shared `ToolIdentity` import path remains, and targeted `node --check` passed.

Completed fixes:

- Shared semantics were extracted into `Formatters.js`, `ToolIdentity.js`, and `GitEventIdentity.js`, replacing duplicated row hashing, status normalization, formatting, truncation, path shortening, tool classification, building targeting, and browser-side git event normalization across dashboard, shared panels, domain agent logic, and world activity surfaces.
- Dead dashboard detail/signature code was removed.
- Projection math was extracted into `Projection.js` and migrated across safe world/canvas call sites while preserving the `Camera` API.
- Renderer teardown now disposes `buildingRenderer`, particle/building emitter chances are elapsed-time based, reflection/atmosphere passes reuse frame light-source snapshots, and one per-frame allocation was reduced.
- CSS cleanup removed legacy/dead selectors and duplicate minimap refinement blocks, while duplicate `pulse-dot` keyframes were namespaced.
- Confirmed unused `Task.js` and `TokenMetrics.js` were removed, and unused methods/exports were trimmed from data source, settings, rendering, color, and policy modules. `Modal.destroy` remains with a lifecycle comment.
- Sprite tooling gained manifest preflight/dry-run guardrails, `--allow-unmanifested`, Pixellab `--skip-api` without secret requirements, safer MCP unzip args, orphan PNG failure unless allowlisted, and manifest/palette parity checks.
- Vendored `js-yaml` was refreshed via `vendor:refresh-js-yaml`.
- Widget static resource badge handling was registered, Swift/static surfaces were documented, generated widget bundle artifacts were removed from the Git index and ignored, and root proof PNGs moved under `agents/research/code-health-artifacts`.

Follow-up implications:

- Larger drawable contract work and the broader `IsometricRenderer` split remain deferred architecture work.
- Duplicate sprite policy remains deferred for identical gull/watchtower PNG hashes.
- Swift syntax remains unverified because the host is Linux without the macOS/Swift toolchain.

Open issues: none remaining for P2.

## Validation Summary

P0, P1, and P2 evidence received.

- Server/API checks: P0 `node --check` passed for reviewed JS/MJS files and `package.json` parsed. P1 `node --check claudeville/server.js` and all requested P1 JS files passed. P2 `find claudeville/src -name '*.js' -print0 | xargs -0 -n1 node --check` passed, and adapters/services/server `node --check` passed.
- Diff hygiene: P1 `git diff --check` for requested paths passed. P2 `git diff --check` passed.
- Frontend smoke checks: P0 reviewer confirmed boot/sidebar/activity DOM-safety changes and minimap live-position wiring by code review. P1 UI worker browser smoke opened Dashboard, rendered 6 cards/avatars, hid quota section with `--` values, returned `200` from `/api/session-details`, and produced no console errors/warnings. P2 Playwright smoke rendered Dashboard cards and a nonblank World canvas at 1040x666 with 25/25 nonblank samples and 0 console errors.
- Runtime/API smoke checks: P2 `curl /`, `/api/providers`, and `/api/sessions` returned `200`.
- Sprite/widget/script checks: P0 visual diff failed closed without baselines and passed with explicit missing-baseline skips. P2 touched sprite/vendor scripts passed `node --check`; `npm run sprites:validate` passed with expected 146, missing 0, orphan PNGs 0, invalid palette mirrors 0. Widget build was not run because the host is Linux without a Swift toolchain.
- Docs/artifact checks: widget artifact handling, sprite baseline relocation, widget static/Swift surface notes, and proof PNG relocation under `agents/research/code-health-artifacts` were reviewed through the P0/P2 reports.

## Residual Risks

P0, P1, and P2 residual risks captured.

- Known behavior risks: Codex session discovery now uses bounded newest-first traversal; very large histories may return partial newest-first results after caps. Recursive watch fallback may miss one change until the normal full discovery cadence if no fallback signature exists yet.
- Data matching risks: git commit matching without SHA remains heuristic.
- Validation gaps: static file containment is lexical and does not resolve symlink realpaths. Swift syntax and widget runtime remain unverified on this Linux host.
- Deferred cleanup: phase 6.2/6.3 drawable contract work and the larger `IsometricRenderer` split remain deferred; duplicate sprite policy remains deferred for identical gull/watchtower PNG hashes.

## Next Steps After Full Completion

All phase reviewer reports have been reflected.

- Reconcile final `git status --short` against expected swarm artifacts before staging/commit decisions.
- On macOS with Swift available, run `npm run widget:build` and `npm run widget` to verify widget syntax/runtime.
- Decide whether to address deferred architecture cleanup now or track separately: drawable contract, larger `IsometricRenderer` split, duplicate sprite policy, and realpath-based static containment.
- Preserve the reviewed validation evidence with the remediation branch or PR notes.
