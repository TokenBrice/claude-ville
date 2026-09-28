# Test catalog

ClaudeVille uses Node's built-in `node:test` runner. The fast unit suite needs the installed dev dependencies (`js-yaml` and `pngjs` for the manifest and sprite tests) but no build, browser, real provider home, or running server:

```sh
npm run test:unit
node --test scripts/tests/turn-state.test.mjs
node --test scripts/tests/turn-state.test.mjs --test-name-pattern "completed"
```

`test:unit` runs top-level `scripts/tests/*.test.mjs` files. Integration tests start an isolated production server on an ephemeral socket and run separately with `npm run test:integration`.

Set `CLAUDEVILLE_TEST_TMPDIR` to a writable directory when the normal temporary directory is unavailable. `support/tmp.mjs` and `support/tmp.cjs` create unique children beneath it, otherwise falling back to the OS temporary directory. `support/session-contract.mjs` holds the browser-facing session field contract the integration payload test asserts.

## Suite map

| Category | Files or prefixes | Covers |
| --- | --- | --- |
| Adapter and turn state | `turn-state*`, `claude-*`, `omp-adapter`, `r2-02.adapter-parity`, `r4-dialogue.contract`, `tool-results`, `status-resolver`, `execution-tree`, `o2-prompt-plan-mapping` | Provider parsing, normalized sessions, identity, projection, pending/completed turn rules, status resolution, bounded tool results, dialogue redaction, prompt/TodoWrite mapping, and task progress. |
| Pricing and registry | `r1-09.*`, `r1-15.*`, `r2-02.pricing`, `spend-ledger`, `model-registry`, `agent-signature` | Token normalization, pricing, the spend ledger and rollups, canonical model metadata, and model visual signatures. |
| Domain, application, and Chronicle | `r1-01.*`, `r1-02.*`, `r1-04.*`, `r1-17.*`, `r3-linger.*`, `w1-a.*`, `w1-contracts`, `w1-e.*`, `w1-j.*`, `w1-wire.integration`, `w5-a.*`, `w11-cache-ore-ratio`, `chronicle-log`, `fold-timeline`, `forge-events`, `monument-release-classify`, `causal-waterfall`, `building-instrument-model`, `persistent-history`, `simulation-isolation` | Agent identity, attention and notifications, mood, lingering and departure, link state, the signal ledger, cache cargo, biography and affinity history, Chronicle logging, folding, retention, the verified-release-tag rule, and simulation isolation, and the pure panel models. |
| World models and movement | `pathfinder`, `movement-*`, `static-prop-depth`, `observation-certainty`, `building-aperture`, `attention-framing`, `camera-shot-scales`, `camera-curves`, `scene-salience`, `event-shapes`, `dusk-exposure-contract`, `weather-truth`, `r1-10.*`, `r2-04.*`, `r2-06.*`, `r2-wire.integration`, `r3-pulse.*`, `r4-dialogue.rendering`, `w1-b.*`–`w1-d.*`, `w3-a.*`, `w3-d.*`, `w3-e.*`, `c10-*`, `o10-*`, `w5-bridge-lanterns` | Pathfinding, routing, steering, prop depth, observation certainty, the aperture, attention framing and plates, camera shot scales and the DPR-2 zoom rungs, the continuous-dolly glide contract (no pan/zoom plateau, exact landing, the duration formula), salience and verified outcomes, event shapes, Director overflow, visit intents, camera and motion-clock timing, solar shadows, the village's own weather (per-date timelines, no agent input, snow only when it precipitates, lightning quanta, the one wind), pulses, speech fitting, and the Task Board, Harbor ledger, and bridge-lantern plans. |
| Sprites and poses | `action-strip`, `astra-weapon-pose`, `codex-weapon-pose`, `sprite-manifest-rewrite`, `r3-01.*`, `render-baseline-manifest` | Action-strip resolution, authored weapon grips, manifest rewrites, the GPU overlay split, and the render-baseline manifest. |
| Renderer and GPU policy | `astra-render-refinement`, `material-*`, `r1-14.*`, `postfx-*`, `trail-*`, `canvas-budget`, `drawable-pass`, `paint-counts`, `p8-overlay-retention`, `orderedDither4`, `gpu-*`, `c16-*`, `roof-weather`, `w2-b.*`, `w3-b.*`, `w4-a.*`, `w4-b.building-windows`, `w4-c.*`, `w4-d.*`, `w4-f.*`, `w5-c.*` | Admission, resources, materials, trails, atlases, overlay retention, occupancy-gated night lighting, roof snow/wet slate on roof texels only (never walls, glass or openings; lit/shade pitches kept; scenery roofs inside their polygon), frame pressure, and degradation policy without Canvas. |
| DOM-stub UI | `frontend-reliability`, `ui-data-remediation`, `formatters`, `dashboard-observed-tape`, `r1-11.*`, `r1-16.*`, `r1-19.*`, `r2-05.*`, `r2-09.*`–`r2-11.*`, `r3-settings.*`, `w1-g.*`–`w1-i.*`, `w3-c.*`, `w4-e.*`, `w5-b.*` | Browser-facing code under small DOM, storage, audio, and canvas stubs. These are not browser/component tests. |
| Audio | `audio-*`, `cue-score`, `sound-*`, `r1-03.*`, `r2-03.*`, `r2-08.*`, `w3-f.*` | Pure audio models and tables without Web Audio (loudness registry, ladder, workshop model, spatial placement, sequencer, voicings and the songbook's score analyzer, caption policy, sound settings and the invite), node-graph logic under small audio stubs, and the probe's pure judges (`audio-probe-*`); the rendered gate is `audio:probe` below. |
| Server, hooks, and telemetry | `astra-runtime`, `agent-hooks`, `hook-overlay`, `release-changelog`, `catalog-check`, `session-residency`, `working-set`, `usage-quota`, `r1-12.*`, `r2-12.*`, `w1-f.*`, `w2-a.*`, `w4-b.client-perf` | Server state, hooks and the hook overlay, releases, catalogs, provider health, the Git worker, quota responses, and server/client perf telemetry. |
| Integration | `integration/*.test.mjs` | Real isolated-server HTTP/WebSocket contracts and replay pipelines; run only by `test:integration`. |

## Notable contract tests

| File | Contract |
| --- | --- |
| `model-registry.test.mjs` | Generated ESM/CJS resolver parity, presentation identity parity, and bidirectional registry/manifest completeness. |
| `simulation-isolation.test.mjs` | Simulator storage, cross-tab channels and writer leases remain separate from live history; simulated freshness is explicit. |
| `agent-hooks.test.mjs` | Destructive-command guards, fail-open input, syntax reports, session output, opt-in ingestion, and latency. |
| `release-changelog.test.mjs` | Release header parsing, exact extraction, version rejection, and read-only/write preparation behavior. |
| `catalog-check.test.mjs` | Smoke files, verification npm scripts, and `docs/*.md` files remain cataloged. |
| `o2-prompt-plan-mapping.test.mjs` | Prompt, TodoWrite, and branch payload bounds plus signature-driven live Agent updates. |
| `c10-taskboard-board.test.mjs` | Selected/pinned Task Board precedence, honest row shaping, overflow, and completed-only strikes. |
| `o10-stale-cargo-ledger.test.mjs` | Oldest commit merging, age-first harbor ordering, unknown-age honesty, and age formatting. |
| `w5-bridge-lanterns.test.mjs` | Command pond plank walkability plus capped, age-tiered bridge lantern plans and honest absence. |
| `integration/session-payload-contract.test.mjs` | HTTP sessions and WebSocket initialization satisfy the client payload contract. |
| `integration/r1-18.pipeline-replay.test.mjs` | A real multi-provider pipeline emits valid WebSocket delta and snapshot payloads. |

## Conventions

- Name tests as the behavior they prove and keep fixtures deterministic.
- Inject a fixed clock for exact boundaries. Some tests use `Date.now()` for unique import/IndexedDB names, fresh filesystem timestamps, or relative-time fixtures; wall-clock use is allowed when assertions do not depend on an exact instant.
- CommonJS adapter/service modules load via `createRequire`; browser ES modules import directly.
- Transcript fixtures are documented in `scripts/adapters/fixtures/README.md`; browser pixels and live lifecycle behavior belong to smoke and visual checks.

## Verification command index

| Area | Commands |
| --- | --- |
| Syntax/static contracts | `check:server`, `check:adapters`, `check:services`, `check:frontend-syntax`, `check:scripts`, `check:git-events`, `check:adapter-fixtures`, `check:theme-tokens`, `check:artifacts` |
| Tests | `test:unit`, `test:integration`, `test:e2e:replay` |
| Models | `models:generate`, `models:check`, `models:resolve` |
| Focused verification | `verify:architecture`, `verify:server`, `verify:render` |
| Gates | `validate:quick`, `validate:full`, `gate:release` |
| Release | `release:check`, `release:prepare`, `release:verify` |
| Audio (local maintainer gate) | `audio:probe` — the audio plan's staged gate (`PLAN_STAGE` 7): virtual-clock renders of the shipped controller (loudness, margins over the Town band and the Signals bed, the Town band's music, the Signals floor, the awakening, output/tone/soften) and realtime headless-Chromium checks of the live app through the real TopBar (must-nevers, envelope lint, the awakening's first onset, captions with sound off); run by the maintainer at the end of each audio wave, not part of `validate:quick`, `validate:full` or CI (see `scripts/audio/README.md`). Its pure judges are unit-tested in `audio-probe-*.test.mjs`; the sound control's UI acceptance lives in `verify:render` (`scripts/smoke/README.md`) |

The smoke catalog details focused runtime requirements. `validate:quick` is the deterministic pre-push loop; `validate:full` adds integration, server, World, and sprite validation; `gate:release` also verifies release metadata.
