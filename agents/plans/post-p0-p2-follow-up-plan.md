# Post P0-P2 Follow-Up Implementation Plan

Date: 2026-04-28
Baseline HEAD: `13b8d45`
Primary input: `agents/handover/p0-p1-p2-remediation-handover.md`
Scope: remaining code-health and validation opportunities after the P0, P1, and P2 remediation work. Documentation updates remain out of scope unless explicitly called out as agent artifacts or implementation notes.

## Executive Summary

The P0-P2 remediation left the application in a materially better state, with no open P0/P1/P2 blocker recorded by the phase reviewers. A fresh handover review and repository scan still found several follow-up opportunities worth scheduling:

1. Close the remaining runtime-hardening gaps around static-file containment, recursive watch fallback detection, Codex scan cap visibility, and git-event merge confidence.
2. Turn the current sprite/widget validation improvements into repeatable, meaningful workflows instead of partially manual or host-dependent checks.
3. Reduce the remaining world-renderer maintenance risk by standardizing drawable contracts and splitting `IsometricRenderer.js` only after the contract is stable.

The work below is intentionally ordered from low-blast-radius correctness fixes to larger architecture cleanup.

## Findings From Handover And Re-Scan

- Static serving now checks a lexical resolved path boundary, but it does not verify realpath containment after symlink resolution. Current path check: `claudeville/server.js:341-366`.
- Recursive watch fallback metrics exist, but the first fallback scan establishes a baseline and does not mark dirty even if a change happened between watcher failure and baseline creation. Current branch: `claudeville/server.js:840-855` and `claudeville/server.js:911-932`.
- Codex rollout discovery is now bounded and newest-first, but cap hits are only internal counters and are not exposed to operators. Current caps and limits: `claudeville/adapters/codex.js:21-29`, `claudeville/adapters/codex.js:664-745`, and `claudeville/adapters/codex.js:760-805`.
- Git commit matching without SHA remains heuristic. This is acceptable behavior, but the matching rules need fixture coverage so future edits do not regress duplicate/synthetic event handling.
- Sprite visual-diff tooling fails closed without baselines and can skip with an explicit flag, but all five capture poses still use the same viewport because no camera hook exists. Current limitation: `scripts/sprites/capture-baseline.mjs:8-12` and `scripts/sprites/capture-baseline.mjs:50-58`.
- Duplicate sprite policy remains undefined for intentionally identical gull/watchtower PNG hashes. The manifest validator catches several asset classes, but duplicate-hash policy is not yet represented in the validator.
- Widget validation remains host-dependent. `npm run widget:build` compiles Swift through `widget/build.sh`, while this Linux host cannot verify Swift syntax/runtime. The build script also depends on `readlink -f` with a `realpath` fallback at `widget/build.sh:26`, which should be reviewed on macOS.
- The world rendering layer still carries large files and mixed drawable shapes. Current pressure points include `IsometricRenderer.js` at 6,575 lines, `BuildingRenderer.legacy.js` at 3,274 lines, `BuildingSprite.js` at 2,929 lines, and `AgentSprite.js` at 2,455 lines.
- `IsometricRenderer` still manually adapts several drawable shapes by `kind` during the depth-sorted pass. Current aggregation/draw dispatch: `claudeville/src/presentation/character-mode/IsometricRenderer.js:2240-2288`.
- `BuildingRenderer.legacy.js` is still documented as historical reference/fallback in `claudeville/src/presentation/character-mode/README.md:18`; removal or archival needs an explicit owner decision because it may still serve as visual parity reference.

## Phase A: Runtime Correctness Hardening

### A1. Realpath Static Containment

Priority: P1
Owner surface: `claudeville/server.js`

Implement a realpath-aware static containment helper:

- Resolve and cache the real static root with `fs.realpathSync.native` when available, falling back to `fs.realpathSync`.
- Decode and normalize the requested path exactly once, preserving current `index.html` behavior for `/` and directory requests.
- Check lexical containment before touching the filesystem, then check realpath containment after the target exists and before streaming it.
- For directories, realpath-check the resolved `index.html` target, not only the directory.
- Keep the fixed widget routes (`/widget.html` and `/widget.css`) separate unless deliberately extending the same helper there.

Validation:

- `node --check claudeville/server.js`
- Manual `curl` checks for `/`, a known asset, encoded traversal attempts, and a temporary symlink inside the static root pointing outside the root. The symlink escape should return `403`.
- `curl http://localhost:4000/api/providers` and `curl http://localhost:4000/api/sessions` after the server is running.
- Remove any temporary symlink fixture and re-run `git status --short` before staging.

Stop condition:

- Do not add dependency packages or a routing framework. This is a narrow helper-level hardening pass.

### A2. Recursive Watch Fallback First-Change Detection

Priority: P1
Owner surface: `claudeville/server.js`

Fix the first fallback-scan blind spot:

- When a recursive watcher setup fails, create the fallback record with a baseline signature immediately if the path exists.
- If immediate baseline capture fails, record the error and treat the first successful fallback scan as dirty if no watcher is active.
- Extend `/api/perf` fallback details with enough state to distinguish `baselinePending`, `lastSignatureAt`, and scan errors without dumping signatures.
- Keep the current bounded traversal constants unless profiling shows they are insufficient.

Validation:

- `node --check claudeville/server.js`
- Local fixture exercise: add a temporary recursive watch path, force fallback registration, mutate a matching file before the first scheduled scan, and confirm `fallbackChanges` increments plus provider dirtying is scoped.
- Prefer a small deterministic debug hook or fixture script over manual timing when forcing fallback registration.
- Manual `/api/perf` check to confirm fallback metadata remains compact.

Stop condition:

- Do not replace the dirty-driven scheduler or polling cadence. The fix should sit inside the existing watcher/fallback structure.

### A3. Codex Rollout Cap Visibility

Priority: P1
Owner surfaces: `claudeville/adapters/codex.js`, `claudeville/adapters/index.js`, `claudeville/server.js`

Expose bounded-scan state without returning to unbounded scans:

- Keep the current newest-first traversal caps.
- Store the most recent Codex rollout discovery stats: day directories scanned, rollout files scanned, cap-hit flag, result count, and timestamp.
- Surface those stats through the existing perf/debug path, preferably `/api/perf`, under a provider-scoped key.
- When caps are hit, include a compact warning string suitable for operator diagnosis but not user-facing UI noise.

Validation:

- `printf '%s\n' claudeville/adapters/codex.js claudeville/adapters/index.js claudeville/server.js | xargs -n1 node --check`
- Fixture or temporary directory check that artificially lowers caps or injects stats so cap-hit metadata appears without scanning an enormous history.
- Confirm normal `/api/sessions` output remains unchanged.

Stop condition:

- Do not make the active-session scan unbounded. The goal is visibility and diagnosability, not exhaustive cold scans at all costs.

### A4. Git Event Merge Fixture Coverage

Priority: P2
Owner surfaces: `claudeville/adapters/gitEvents.js`, `claudeville/src/presentation/shared/GitEventIdentity.js`, and any module-format-safe shared helper extracted from them

Add a no-framework fixture check for git-event merge behavior:

- Create a small script under `scripts/dev/` or `scripts/` that imports the pure matching helpers and runs deterministic fixture cases with Node.
- Cover SHA matches, command/time/text fallback matches, synthetic-only events, observed-only events, and near-miss events that must remain distinct.
- If helper exports are too presentation-specific or cross module formats awkwardly, first extract only the pure matching rules into a CommonJS/ESM-safe helper without changing behavior.

Validation:

- `node --check` for touched files.
- Run the fixture script directly with `node`.
- Confirm Dashboard and World still render git events through browser smoke after runtime changes are complete.

Stop condition:

- Do not add a test runner. Keep this as a targeted repository script consistent with the current no-build/no-CI constraint.

## Phase B: Validation And Tooling Completion

### B1. Deterministic Sprite Visual-Diff Camera Poses

Priority: P2
Owner surfaces: `claudeville/src/presentation/App.js`, `claudeville/src/presentation/character-mode/`, `scripts/sprites/capture-baseline.mjs`

Make sprite visual diffs meaningful:

- Expose a development-only `window.cameraSet({ x, y, zoom })` or equivalent route through the active World mode renderer.
- Ensure the hook is inert or absent outside local browser/debug usage if that matches existing style.
- Update `capture-baseline.mjs` to drive all five poses before screenshot capture.
- Generate reviewed baselines under `scripts/sprites/baselines/`; avoid committing `*-fresh.png` and `*-diff.png` unless they are intentional evidence artifacts.

Validation:

- `node --check` for any changed app files and sprite scripts.
- `npm run dev`
- `npm run sprites:capture-baseline`
- `npm run sprites:capture-fresh`
- `npm run sprites:visual-diff`
- Browser smoke at `http://localhost:4000` confirming World and Dashboard still work.

Stop condition:

- Do not make this responsive or mobile-oriented. Captures should stay at the desktop viewport already used by the tool.

### B2. Widget Build Portability And macOS Verification

Priority: P2
Owner surfaces: `widget/build.sh`, `widget/Sources/main.swift`, `widget/Resources/`

Finish the widget validation gap:

- Review `widget/build.sh` for macOS portability, especially `readlink -f` fallback behavior for resolving the Node binary.
- Prefer a small portable Node-path resolution helper using available shell tools or `python3` only if already present on target macOS machines.
- On a macOS host with Swift tooling, run `npm run widget:build` and `npm run widget`.
- If runtime issues are found, fix them in widget-owned files only.

Validation:

- Linux: syntax-review shell changes and avoid claiming Swift verification.
- macOS: `npm run widget:build`, then `npm run widget`.
- Check that generated app artifacts remain ignored and unstaged.

Stop condition:

- Do not introduce a package-manager install step for the widget.

### B3. Duplicate Sprite Hash Policy

Priority: P2
Owner surfaces: `claudeville/assets/sprites/manifest.yaml`, `scripts/sprites/manifest-validator.mjs`

Make duplicate PNG intent explicit:

- Add duplicate-hash detection to the manifest validator.
- Add a compact allowlist for intentional duplicates, initially covering known gull/watchtower duplicates if they are confirmed to be placeholders or aliases.
- Prefer manifest-level comments or validator allowlist entries over silent duplicate acceptance.
- Decide whether any duplicate should be regenerated rather than allowlisted.

Validation:

- `npm run sprites:validate`
- If sprites change visually, run the visual-diff workflow from B1.

Stop condition:

- Do not regenerate large asset sets as part of policy work unless the duplicate is confirmed to be unintended and visually user-facing.

## Phase C: World Renderer Maintainability

### C1. Shared Drawable Contract

Priority: P2
Owner surfaces: `claudeville/src/presentation/character-mode/`

Create a small shared drawable adapter before splitting the renderer:

- Define a stable shape for depth-sorted drawables, for example `{ kind, sortY, draw(ctx, zoom, context), hitArea?, payload? }`.
- Add adapter helpers for existing building, prop, agent, harbor, landmark, chronicle, and chronicler drawables.
- Keep behavior identical during the first commit: the goal is one draw loop and one sort contract, not visual redesign.
- Only after the shared contract exists, replace the manual `kind` dispatch in `IsometricRenderer`.

Validation:

- `find claudeville/src/presentation/character-mode -name '*.js' -print0 | xargs -0 -n1 node --check`
- Browser smoke: World nonblank canvas, Dashboard cards, agent select/deselect, hover behavior, minimap rendering.
- If B1 has landed, run sprite visual diff.

Stop condition:

- Do not split `IsometricRenderer.js` first. Without the contract, file movement will amplify the current shape mismatch.

### C2. IsometricRenderer Module Split

Priority: P3 after C1
Owner surface: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

Split only stable responsibility groups:

- Extract terrain/static prop construction.
- Extract render-pass orchestration around sky, world, drawable pass, overlays, and minimap.
- Extract hit-testing/selection only if the drawable contract can support it cleanly.
- Keep public constructor and lifecycle behavior stable for `App.js`.

Validation:

- Same checks as C1, plus targeted manual comparison against pre-split screenshots if visual-diff baselines are not ready.

Stop condition:

- Avoid broad renames, formatting churn, or simultaneous behavior changes.

### C3. Legacy Building Renderer Decision

Priority: P3
Owner surface: `claudeville/src/presentation/character-mode/BuildingRenderer.legacy.js`

Make an explicit archival/removal decision:

- Determine whether the legacy renderer is still needed as a visual parity reference.
- If retained, keep it read-only and exclude it from future feature ownership.
- If removed, first capture any useful parity notes or screenshots under `agents/research/`, then delete it in a dedicated commit.
- Update only the minimum local ownership note if the file is removed or renamed.

Validation:

- `rg "BuildingRenderer\\.legacy"` should show no runtime imports before deletion.
- Browser smoke after deletion.

Stop condition:

- Do not remove it merely because it is large; remove it only if its reference value is exhausted.

## Suggested Commit Order

1. `runtime: harden static realpath containment`
2. `runtime: improve recursive watch fallback detection`
3. `runtime: expose codex rollout scan caps`
4. `tooling: add git event merge fixtures`
5. `tooling: drive sprite visual diff camera poses`
6. `widget: improve build portability`
7. `sprites: define duplicate asset policy`
8. `world: normalize drawable contracts`
9. `world: split renderer responsibilities`
10. `world: archive legacy building renderer`

Each commit should keep its own validation evidence in the commit message or PR notes. If Phase C starts to overlap heavily with visual behavior, pause after C1 and re-run visual validation before splitting further.

## Validation Matrix

Minimum checks by touched area:

- Runtime server/adapters/services: `node --check` on touched files, then `npm run dev`, `curl http://localhost:4000/api/providers`, `curl http://localhost:4000/api/sessions`, and `/api/perf` inspection for runtime-metric changes.
- Frontend/world: `find claudeville/src/presentation/character-mode -name '*.js' -print0 | xargs -0 -n1 node --check`, browser smoke for Dashboard and World, agent selection/deselection, hover, and minimap.
- Sprite assets/tooling: `node --check` on touched scripts and `npm run sprites:validate`; add visual-diff workflow once camera poses are deterministic.
- Widget: `npm run widget:build` and `npm run widget` on macOS only; Linux validation must be reported as incomplete for Swift.
- Agent artifacts: `git diff --check` and final `git status --short`.

## Open Decisions

- Whether realpath containment should also cover the fixed widget routes (`/widget.html` and `/widget.css`) in the same pass or remain scoped to the main static root.
- Whether Codex cap metadata belongs only in `/api/perf` or should also be visible in an adapter-specific debug endpoint later.
- Whether duplicate sprite hashes are intentional aliases, placeholders to regenerate, or assets that should share one manifest ID.
- Whether `BuildingRenderer.legacy.js` should be retained as a parity reference until after the drawable contract and renderer split are complete.
