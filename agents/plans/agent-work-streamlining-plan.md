# Agent Work Streamlining Plan

Date: 2026-04-29
Status: ready for implementation planning
Baseline HEAD: `34237bfc0aae1da34455c128d761b8f48217ecb1`
Initial `git status --short`: clean
Final expected `git status --short`: `?? agents/plans/agent-work-streamlining-plan.md`

## Purpose

This plan consolidates a read-only swarm audit of the current ClaudeVille implementation and repository. It focuses on changes that make future agent work faster, safer, and easier to validate:

- code maintainability, deduplication, and performance visibility
- documentation and agent-facing resource gaps
- scripts and tooling that reduce repeated manual checks
- procedures for adding or maintaining providers, models, sprites, widgets, and world features

No implementation changes were made by the audit. This artifact is the only intended output.

## Swarm Inputs

Read-only audit slices:

- Server, adapters, services, infrastructure, and application flow.
- World mode canvas, sprite manifest, and rendering architecture.
- Frontend shell, dashboard mode, shared UI, CSS, and browser data flow.
- Documentation, agent artifacts, onboarding, and swarm procedure.
- Tooling, scripts, widget surfaces, package scripts, and validation workflows.

Existing baseline artifacts reviewed:

- `agents/plans/code-health-remediation-plan.md`
- `agents/handover/p0-p1-p2-remediation-handover.md`
- `agents/plans/post-p0-p2-follow-up-plan.md`

Those earlier artifacts already handled or tracked many P0-P2 issues. This plan focuses on what remains after that work and on workflow improvements for future agents.

Supersession note:

- Some items from `post-p0-p2-follow-up-plan.md` are already implemented at this baseline and should not be reopened from the older plan without a fresh code check. Confirmed examples include realpath static containment in `claudeville/server.js`, recursive watch fallback baseline state in `claudeville/server.js`, and Codex provider perf stats in `claudeville/adapters/codex.js`.
- Still-relevant overlapping themes are carried forward here only where the current audit found remaining agent-work friction, such as extending existing perf diagnostics for git enrichment rather than adding `/api/perf` from scratch.

## Priority Summary

Critical:

- None found in this pass.

High:

- Provider registration has multiple sources of truth.
- Git enrichment sits on the hot `/api/sessions` path without enough service boundaries or diagnostics.
- No end-to-end runbook for adding a provider, model, or agent visual identity.
- Ignored generated widget bundle can drift from widget source and mislead agents.
- Widget pricing/model/status logic is duplicated across browser, Swift, static widget HTML, and KDE QML.
- `IsometricRenderer.js` remains the main World mode bottleneck.
- `BuildingSprite.js` building behavior is too conditional and hand-anchored.
- Status normalization is inconsistent between domain stats and presentation surfaces.
- `App.js` lacks a teardown path for tests, reload helpers, and future hot reboots.

Medium:

- Adapter helper code is duplicated and adapter behavior is not executable through fixtures.
- Runtime API return shapes are not normalized at the registry boundary.
- Agent artifact directories lack an index, status taxonomy, templates, or retirement policy.
- Swarm SOP is comprehensive but heavy for common read-only audits.
- Presentation selection, project grouping, provider/status/tool views, and tool-history rendering are duplicated.
- Session-detail cache/timer behavior lacks a debug surface.
- CSS files contain late override layers that obscure source of truth.
- Runtime sprite IDs are scattered and not audited against `manifest.yaml`.
- Legacy/static sprite generation scripts still conflict with the manifest-first workflow.
- `AgentSprite.js` mixes behavior, movement, composition, equipment, and labels.
- Cheap validation scripts exist but are not exposed through `package.json`.

Low and easy-low:

- Adapter diagnostics are uneven.
- `usageQuota.js` is Claude-specific but presented as generic usage.
- Several docs have small drift from implementation details.
- `innerHTML` remains available in shared primitives and static dashboard templates.
- Language setting and English-only policy need an explicit decision.
- Frontend scoped docs should repeat the desktop-only validation constraint.
- `WorldFrameRenderer` still reaches into renderer internals.
- Motion pulse policy is documented but not mechanically enforced.
- Terrain cache construction temporarily mutates renderer-wide motion state.
- `demo-server.js` appears stale and project-mismatched.
- Some comments and generated-output workflows can mislead future agents.

## Phase 1: Agent Onboarding And Source-Of-Truth Resources

Goal: reduce repeated context gathering before agents touch code.

### 1.1 Add an end-to-end provider/model/agent addition runbook

Priority: High
Owner surfaces:

- `docs/agent-provider-addition.md` or `claudeville/adapters/README.md`
- `claudeville/src/presentation/shared/README.md`
- `README.md`

Problem:

Adapter docs describe backend registration, and shared UI docs describe model visual identity, but no single checklist ties together adapter fields, `AgentManager`, visual identity, World sprites, Dashboard cards, Activity Panel detail, widget impact, docs updates, and validation.

Plan:

1. Create a runbook with three tracks:
   - new provider
   - new model for an existing provider
   - new visual identity or sprite variant for an existing agent/model
2. Include required fields and fallbacks:
   - `provider`, `sessionId`, `project`, `model`, `status`, `lastActivity`, `lastTool`, `lastMessage`, `tokenUsage`, `gitEvents`
   - explicit null/empty defaults for unsupported features
3. Include edit matrix:
   - adapter and registry
   - `AgentManager`
   - `ModelVisualIdentity`
   - sprite manifest and validator
   - Dashboard, Sidebar, Activity Panel checks
   - browser widget, Swift widget, KDE widget pricing/model impacts
4. Include validation:
   - `node --check` for touched backend files
   - `/api/providers`, `/api/sessions`, `/api/session-detail`
   - World + Dashboard browser smoke at desktop viewport only
   - widget checks when pricing/model labels change

Validation:

- Docs-only diff review.
- `git status --short`.

### 1.2 Index and classify agent artifacts

Priority: Medium
Owner surfaces:

- `agents/README.md`
- `agents/plans/*.md`
- `agents/handover/*.md`

Problem:

`agents/plans/` is useful but large and mixed-status. Some plans are historical, some are active, and some are superseded. Future agents can mistake old plans for current implementation instructions.

Plan:

1. Add `agents/README.md` with a table:
   - artifact path
   - status: `active`, `ready`, `historical`, `superseded`, `deferred`, `reference`
   - last verified date and HEAD
   - source-of-truth replacement, if superseded
   - safe to execute: yes/no
   - validation notes
2. Start with current high-value artifacts:
   - `code-health-remediation-plan.md`
   - `p0-p1-p2-remediation-handover.md`
   - `post-p0-p2-follow-up-plan.md`
   - visual/world enhancement plans that are still relevant
3. Add a short rule to README: check `agents/README.md` before using any old plan as implementation input.

Validation:

- Docs-only diff review.
- `git status --short`.

### 1.3 Add reusable agent artifact templates

Priority: Medium
Owner surfaces:

- `agents/templates/plan.md`
- `agents/templates/research.md`
- `agents/templates/handover.md`
- `docs/swarm-orchestration-procedure.md`
- `AGENTS.md` and `CLAUDE.md` parity

Problem:

The swarm SOP has inline assignment templates, but committed artifacts do not have reusable plan/research/handover skeletons. New agents copy inconsistent historical patterns.

Plan:

1. Add templates with required metadata:
   - status
   - date
   - baseline HEAD
   - initial and final `git status --short`
   - owned paths and read-only paths
   - source docs
   - findings by priority
   - execution readiness
   - validation run or validation required
   - residual risks
   - supersession policy
2. Link templates from root docs and the swarm SOP.
3. Keep templates short enough for agents to use without turning every task into ceremony.

Validation:

- `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)`.
- Docs-only diff review.

### 1.4 Add a quick swarm mode section

Priority: Medium
Owner surface:

- `docs/swarm-orchestration-procedure.md`

Problem:

The SOP is complete but heavy for read-only audits and common narrow work. Agents spend time extracting the light-swarm packet every time.

Plan:

1. Add a top-level "Quick Modes" section:
   - direct single-owner task
   - read-only light swarm
   - full implementation swarm
2. Include copyable packets:
   - read-only audit agent
   - implementation worker
   - reviewer
   - handover
3. Keep the existing detailed SOP below as the authoritative expanded procedure.

Validation:

- Docs-only diff review.

## Phase 2: No-Install Validation And Diagnostic Tooling

Goal: give agents cheap commands before they need private provider data, `npm install`, or a running browser.

### 2.1 Add no-install validation scripts

Priority: Medium
Owner surfaces:

- `package.json`
- `scripts/check-git-events.cjs`
- optional new scripts under `scripts/`

Problem:

Useful checks exist, but `package.json` does not expose them. Agents repeatedly reconstruct manual `node --check` commands.

Plan:

1. Add scripts that use Node built-ins only:
   - `check:server`
   - `check:adapters`
   - `check:services`
   - `check:frontend-syntax`
   - `check:scripts`
   - `check:git-events`
   - `validate:quick`
2. Keep dev-dependency checks separate:
   - `sprites:validate`
   - `sprites:capture-*`
   - `sprites:visual-diff`
3. Update README validation section to prefer `npm run validate:quick` for broad non-visual changes.

Validation:

- Run every new no-install script.
- Confirm `npm run dev` remains unchanged.

### 2.2 Add adapter fixtures and a fixture runner

Priority: Medium
Owner surfaces:

- `claudeville/adapters/`
- `scripts/adapters/`
- `claudeville/adapters/README.md`

Problem:

Adapter behavior is documented with mini-fixtures, but not executable. Future agents rely on private provider homes for parser validation.

Plan:

1. Add sanitized fixtures for:
   - Claude main session
   - Claude subagent/team member
   - Codex rollout with metadata, tool calls, messages, token counts, and git events
   - Gemini chat with tool calls and missing token usage
   - malformed JSON/JSONL lines
2. Add `scripts/adapters/validate-fixtures.cjs` that exercises parser helpers or adapter fixture seams.
3. If current parser helpers are private, extract pure parsing helpers first with no behavior change.
4. Assert normalized session/detail output shapes, not exact timestamps where brittle.

Validation:

- `node scripts/adapters/validate-fixtures.cjs`.
- `node --check` for touched adapter files.

### 2.3 Normalize adapter output at the registry boundary

Priority: Medium
Owner surfaces:

- `claudeville/adapters/index.js`
- `claudeville/adapters/README.md`
- `claudeville/src/application/AgentManager.js`

Problem:

Claude and Codex return `tokenUsage` in details, while Gemini often omits it. Client code compensates with fallback aliases, which spreads provider variance upward.

Plan:

1. Add registry-level `normalizeSession(session)` and `normalizeDetail(detail, context)` helpers.
2. Ensure explicit defaults:
   - `tokenUsage: null`
   - `gitEvents: []`
   - `toolHistory: []`
   - `messages: []`
   - `agentName: null`
3. Keep provider-specific parsing in adapters, but make the registry the final API-shape gate.
4. Update docs to call the registry normalization the source of truth.

Validation:

- Adapter fixture runner.
- `curl /api/sessions`.
- `curl /api/session-detail?...` for available providers.

### 2.4 Add adapter and git enrichment perf diagnostics

Priority: High
Owner surfaces:

- `claudeville/adapters/index.js`
- `claudeville/adapters/gitEvents.js`
- `claudeville/server.js`

Problem:

Git enrichment runs on the hot session-list path and can call multiple git commands. Current broadcast timings only show aggregate cost.

Plan:

1. Instrument git enrichment first so current cost is visible before changing cache behavior.
2. Extend the existing `/api/perf` provider/debug plumbing with git-enrichment counters:
   - projects scanned
   - git command count
   - time spent
   - timeouts/errors
   - cache hits
3. Add a config/debug flag to disable enrichment for diagnosis without changing provider parsing.
4. Extract git enrichment into a named service/module boundary, even if it remains inside `adapters/` initially.
5. Add per-project/head caches where instrumentation shows they are useful.
6. Keep current git-event behavior unchanged before optimizing matching or harbor visuals.

Validation:

- `node --check claudeville/adapters/index.js claudeville/adapters/gitEvents.js claudeville/server.js`.
- `curl http://localhost:4000/api/perf` on a running server.

## Phase 3: Provider And Runtime Maintainability

Goal: reduce hidden registration and service-coupling traps.

### 3.1 Derive allowed providers from the adapter registry

Priority: High
Owner surfaces:

- `claudeville/adapters/index.js`
- `claudeville/server.js`
- `claudeville/adapters/README.md`

Problem:

Adapters are registered in `adapters/index.js`, but `server.js` also hard-codes `ALLOWED_SESSION_PROVIDERS`. A new provider can appear in `/api/providers` yet fail detail routes until another constant is updated.

Plan:

1. Export adapter metadata:
   - provider id
   - display name
   - supports detail
   - supports watch paths
2. Derive detail-provider validation from registry metadata.
3. Represent synthetic `git` sessions explicitly:
   - `supportsDetail: false`, or
   - a synthetic detail provider returning empty detail with a clear reason
4. Update the add-provider runbook after implementation.

Validation:

- `node --check claudeville/server.js claudeville/adapters/index.js`.
- `/api/providers`.
- `/api/session-detail` for valid, unsupported, and unknown providers.

### 3.2 Extract shared adapter utilities

Priority: Medium
Owner surfaces:

- `claudeville/adapters/`
- optional `claudeville/adapters/shared/`

Problem:

Claude, Codex, Gemini, and usage code duplicate bounded reads, JSONL parsing, stat signatures, token field normalization, and LRU trimming.

Plan:

1. Extract only stable low-level helpers first:
   - bounded head/tail line reading
   - JSON/JSONL parse with error counters
   - stat signature
   - LRU map trim
   - token number alias reader
2. Migrate one adapter at a time.
3. Add fixture coverage before or during each migration.
4. Avoid changing active-session semantics while extracting.

Validation:

- Adapter fixture runner.
- `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`.

### 3.3 Rename or wrap Claude-specific usage service

Priority: Low
Owner surfaces:

- `claudeville/services/usageQuota.js`
- `claudeville/server.js`
- README and troubleshooting docs

Problem:

`usageQuota.js` reads Claude credentials/history and Anthropic quota data, but `/api/usage` is generic. Future provider work can confuse account usage with provider-neutral session usage.

Plan:

1. Either rename internally to `ClaudeUsageService` or wrap response as `{ provider: 'claude', ... }`.
2. Document that credentials are optional and not required for session support.
3. Keep `/api/usage` route stable unless a broader multi-provider usage API is designed.

Validation:

- `node --check claudeville/services/usageQuota.js claudeville/server.js`.
- `/api/usage` smoke.

## Phase 4: Frontend State, Detail Flow, And UI Maintainability

Goal: make shared UI state easier for agents to reason about and change.

### 4.1 Normalize status at the domain boundary

Priority: High
Owner surfaces:

- `claudeville/src/application/AgentManager.js`
- `claudeville/src/domain/entities/Agent.js`
- `claudeville/src/domain/entities/World.js`
- `claudeville/src/presentation/shared/Formatters.js`

Problem:

Presentation normalizes `active` to `working`, but `World.getStats()` counts raw statuses. The top bar can disagree with cards when adapters return `active`.

Plan:

1. Define the raw-provider-status to `AgentStatus` contract at the ingestion boundary, including `active -> working` and explicit fallback behavior for unknown statuses.
2. Update `AgentManager` to apply that contract before constructing/updating domain agents.
3. Move any reusable normalization helper out of presentation if domain/application code needs it.
4. Ensure `Agent.status`, `Agent.isWorking`, and `World.getStats()` use one normalized status.
5. Leave display labels in presentation helpers.

Validation:

- Frontend browser smoke with active agents.
- `find claudeville/src -name '*.js' -print0 | xargs -0 -n1 node --check`.

### 4.2 Add an App teardown path

Priority: High
Owner surface:

- `claudeville/src/presentation/App.js`

Problem:

`App` creates intervals, observers, event listeners, renderers, and components but has no `destroy()`. This complicates browser tests, reload helpers, and future hot-reboot work.

Plan:

1. Store all event handler references that need removal.
2. Implement `App.destroy()`:
   - clear chronicle prune interval
   - cancel pending animation frames
   - disconnect resize observer
   - remove window/document/canvas listeners
   - call `destroy()`/`hide()`/`dispose()` on owned components where available
3. Expose a debug-only `window.__claudeVilleApp?.destroy()` if helpful for tests.

Validation:

- Browser smoke: load, destroy through console, reload/construct if a helper exists.
- Check World/Dashboard mode switching after normal boot.

### 4.3 Centralize selection ownership

Priority: Medium
Owner surfaces:

- `claudeville/src/presentation/App.js`
- `claudeville/src/presentation/shared/Sidebar.js`
- `claudeville/src/presentation/shared/ActivityPanel.js`
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`

Problem:

Sidebar toggles selected rows, Dashboard cards always emit select, Activity Panel owns deselect, and App bridges renderer follow. No single module owns selection semantics.

Plan:

1. Add a small `SelectionController` or documented shared contract.
2. Decide repeated Dashboard card click behavior.
3. Add visible selected-card state.
4. Ensure World empty click, Sidebar row click, Dashboard card click, and panel close all follow the same rules.

Validation:

- Select/deselect from World, Dashboard, and Sidebar.
- Switch modes with panel open.

### 4.4 Extract shared presentation helpers

Priority: Medium
Owner surfaces:

- `claudeville/src/presentation/shared/`
- `DashboardRenderer.js`
- `Sidebar.js`
- `ActivityPanel.js`

Problem:

Project grouping, provider/status/tool views, and tool-history rows are duplicated across Dashboard, Sidebar, and Activity Panel.

Plan:

1. Add shared helpers for:
   - `groupAgentsByProject`
   - provider badge data
   - status view data
   - current-tool view data
   - tool-history row DOM construction
2. Keep DOM construction safe by default through `DomSafe`.
3. Migrate one surface at a time.

Validation:

- Dashboard cards, Sidebar rows, and Activity Panel detail rendering.

### 4.5 Add SessionDetailsService debug counters

Priority: Medium
Owner surface:

- `claudeville/src/presentation/shared/SessionDetailsService.js`

Problem:

The service dedupes and caches requests, but future agents cannot see cache hits, stale returns, inflight keys, or timer owners without network-panel archaeology.

Plan:

1. Add optional debug snapshot:
   - cache size
   - inflight count
   - hit/miss/stale counters
   - last batch size
   - last failure sample
2. Expose as `window.__claudeVilleDetails` in browser sessions.
3. Document expected Activity Panel + Dashboard polling cadence.

Validation:

- Browser console snapshot while Dashboard and Activity Panel are active.

### 4.6 Collapse CSS refinement layers

Priority: Medium
Owner surfaces:

- `claudeville/css/dashboard.css`
- `claudeville/css/activity-panel.css`
- `claudeville/css/sidebar.css`
- `claudeville/css/topbar.css`
- `claudeville/css/reset.css`

Problem:

Several CSS files define base selectors and later override them in refinement blocks. This slows future styling work because source of truth is visually distant from the original selector.

Plan:

1. Move repeated colors/shadows/radii into tokens.
2. Collapse each component selector to one canonical declaration where practical.
3. Preserve desktop-only layout assumptions.
4. Avoid broad visual redesign.

Validation:

- Browser smoke in World and Dashboard at `>=1280px`.
- Check Activity Panel open/close and Sidebar states.

## Phase 5: World Mode Architecture And Sprite Workflow

Goal: make world feature additions less likely to require risky edits in very large files.

### 5.1 Define a shared drawable contract before splitting files further

Priority: High
Owner surfaces:

- `claudeville/src/presentation/character-mode/`

Problem:

`IsometricRenderer` still adapts multiple drawable shapes and remains the central edit target for terrain, props, agents, buildings, harbor, overlays, and hit testing.

Plan:

1. Define a stable drawable shape:
   - `kind`
   - `sortY`
   - `draw(ctx, zoom, context)`
   - optional `hitArea`
   - optional `payload`
2. Add adapters for existing building, prop, agent, harbor, landmark, chronicle, and chronicler drawables.
3. Replace manual draw dispatch only after adapters preserve behavior.
4. Keep `IsometricRenderer` as lifecycle/event glue.

Validation:

- `find claudeville/src/presentation/character-mode -name '*.js' -print0 | xargs -0 -n1 node --check`.
- World smoke: nonblank canvas, hover, selection, minimap, Dashboard switch.
- Sprite visual diff if available.

### 5.2 Extract World mode layers after drawable contract lands

Priority: High
Owner surfaces:

- `IsometricRenderer.js`
- new modules under `character-mode/`
- `src/config/`

Problem:

`IsometricRenderer.js` owns lifecycle, events, terrain/scenery generation, visit allocation, gate animation, cache management, water/weather layers, and procedural render helpers.

Plan:

1. Extract in this order:
   - `ViewportCacheManager`
   - `TerrainLayer`
   - `WaterLayer`
   - `GateAndWallLayer`
   - `VisitSystemBridge`
   - optional `WildlifeLayer`
2. Move static water/gull/gate constants into config modules.
3. Keep public constructor and `App.js` integration stable.
4. Avoid visual changes in the extraction commits.

Validation:

- Same as 5.1.

### 5.3 Add a `buildingVisuals` registry

Priority: High
Owner surfaces:

- `BuildingSprite.js`
- `src/config/buildings.js`
- new `src/config/buildingVisuals.js` or similar

Problem:

`BuildingSprite.js` switches per building type for overlays, reactions, rituals, emitters, labels, lights, and local coordinates. Adding a building requires touching too many branches.

Plan:

1. Introduce a registry keyed by building type:
   - label accent/emblem
   - light sources
   - emitter specs
   - overlay anchors
   - split-pass rules
   - ritual hooks by named renderer
2. Migrate data-only behavior first.
3. Keep truly custom procedural drawing behind named functions.
4. Update the add-building section in `character-mode/README.md`.

Validation:

- World smoke with all buildings visible.
- `npm run sprites:validate` only if manifest/assets change.

### 5.4 Split `AgentSprite` responsibilities

Priority: Medium
Owner surfaces:

- `AgentSprite.js`
- new character-mode modules
- sprite manifest/equipment metadata

Problem:

`AgentSprite` mixes movement, behavior state, sprite composition, equipment rendering, labels, status UI, and Codex-specific gear.

Plan:

1. Extract movement/targeting into `AgentMovementController`.
2. Extract visual identity/equipment decisions into `AgentVisualProfile`.
3. Extract Codex gear drawing into `AgentEquipmentRenderer`.
4. Prefer manifest-sourced equipment anchors over hardcoded `CODEX_WEAPON_ASSETS` duplication.

Validation:

- World smoke with Codex model variants and Claude/Gemini base sprites.
- Equipment-focused sprite captures if available.

### 5.5 Add runtime sprite ID audit

Priority: Medium
Owner surfaces:

- `scripts/sprites/`
- `claudeville/assets/sprites/manifest.yaml`
- `claudeville/src/`

Problem:

Runtime sprite IDs are hardcoded across source/config. The manifest validator starts from manifest entries, so newly hardcoded unknown IDs can fail only visually.

Plan:

1. Add a read-only script that scans source/config for sprite ID literals matching known prefixes:
   - `agent.`
   - `building.`
   - `prop.`
   - `veg.`
   - `terrain.`
   - `bridge.`
   - `dock.`
   - `equipment.`
   - `overlay.`
   - `atmosphere.`
2. Compare against manifest IDs and allowed dynamic patterns.
3. Expose as `npm run sprites:audit-ids`.

Validation:

- `npm run sprites:audit-ids`.
- `npm run sprites:validate` when dependencies are installed.

### 5.6 Enforce manifest-first sprite generation

Priority: Medium
Owner surfaces:

- `scripts/sprites/generate-pixellab-revamp.mjs`
- `scripts/sprites/generate-character-mcp.mjs`
- `scripts/sprites/generate.md`

Problem:

Legacy generation scripts carry static inventories and style anchors while docs say the manifest is canonical.

Plan:

1. Make legacy static generator fail unless `--ids=` is provided.
2. Add a manifest-backed `sprites:plan` dry run:
   - selected IDs
   - expected paths
   - tool choice
   - dimensions
   - prompt with style anchor
3. Factor manifest path/style loading into a shared helper.
4. Keep live PixelLab calls explicit and reviewed.

Validation:

- `node --check scripts/sprites/*.mjs`.
- `npm run sprites:plan -- --ids=<known-id>` once script exists.

### 5.7 Add a motion/pulse helper

Priority: Low
Owner surfaces:

- `docs/motion-budget.md`
- `character-mode/`

Problem:

Motion policy exists, but feature modules still hand-roll sine pulses and cadence. This makes pulse density hard to review.

Plan:

1. Add a small `PulseClock` or `MotionBudget` helper with named pulse bands.
2. Require new motion features to request a band and honor `motionScale`.
3. Update docs with examples.

Validation:

- World smoke with normal and reduced motion.

### 5.8 Apply easy-low World cleanup

Priority: Easy-low
Owner surfaces:

- `IsometricRenderer.js`
- `BuildingSprite.js`
- `WorldFrameRenderer.js`

Plan:

1. Update the misleading drawables cache comment in `BuildingSprite.js`.
2. Wrap terrain cache `motionScale` mutation in `try/finally` or pass an explicit static render flag.
3. Create a follow-up note for reducing `WorldFrameRenderer` private-state coupling after layer extraction.

Validation:

- `node --check` for touched files.
- World smoke.

## Phase 6: Widget And Generated Output Safety

Goal: stop generated bundles and duplicated widget logic from misleading agents.

### 6.1 Add widget bundle drift checks

Priority: High
Owner surfaces:

- `widget/`
- `package.json`
- new script under `scripts/widget/`

Problem:

The ignored `widget/ClaudeVilleWidget.app` can exist locally and drift from source. Agents may inspect or launch it without rebuilding.

Plan:

1. Add `widget:verify-bundle`:
   - if bundle does not exist, report skipped
   - compare `widget/Resources/*` and `widget/Info.plist` to bundle copies
   - report stale bundle with clear rebuild instruction
2. Add `widget:check` for non-mutating validation:
   - source file presence
   - `swiftc` availability
   - bundle drift when present
3. Update README and AGENTS/CLAUDE to state only `widget/Resources/*`, `widget/Sources/*`, `widget/Info.plist`, and KDE package files are source.

Validation:

- `npm run widget:check`.
- Do not run mutating `npm run widget:build` unless widget validation is explicitly in scope.

### 6.2 Centralize widget pricing/model/status data

Priority: High
Owner surfaces:

- `claudeville/src/domain/value-objects/TokenUsage.js`
- `widget/Sources/main.swift`
- `widget/Resources/widget.html`
- `widget/kde/claudeville/contents/ui/main.qml`
- new shared metadata file

Problem:

Pricing, model labels, status colors, and token estimation are duplicated across browser, Swift, static widget HTML, and KDE.

Plan:

1. Create a small source-of-truth metadata file, likely JSON:
   - model match keys
   - input/output/cache rates
   - provider/model labels where useful
   - status colors if cross-surface stable
2. Add a checker/generator:
   - first pass can assert platform tables contain all source keys
   - later pass can generate JS/Swift/QML constants
3. Keep runtime no-dependency constraints intact.

Validation:

- `npm run widget:pricing-check`.
- Browser cost display smoke.
- Widget checks on macOS/KDE when platform is available.

### 6.3 Add KDE widget check

Priority: Low
Owner surfaces:

- `widget/kde/`
- `package.json`

Problem:

KDE install/uninstall scripts mutate the local Plasma applet registry, but there is no non-mutating validation.

Plan:

1. Add `widget:kde:check`:
   - required files exist
   - metadata ID consistency
   - referenced image assets exist
   - QML config files exist
   - `kpackagetool6` availability is reported but not required to pass source checks
2. Add KDE validation to root docs if agents own KDE maintenance.

Validation:

- `npm run widget:kde:check`.
- No install/uninstall during check.

### 6.4 Decide what to do with `demo-server.js`

Priority: Easy-low
Owner surface:

- `demo-server.js`
- README if retained

Problem:

The file appears project-mismatched and user-specific. It can confuse agents auditing server behavior.

Plan:

1. Decide whether it is historical, useful, or removable.
2. If useful, replace hardcoded paths with repo-relative paths and document its purpose.
3. If historical, move it under an explicit artifact/reference path or remove it in a dedicated cleanup.

Validation:

- `node --check demo-server.js` if retained.
- Docs-only review if only documenting.

## Phase 7: Low-Risk Documentation And Comment Fixes

Goal: take easy wins that reduce future mistakes.

Tasks:

1. Refresh Codex adapter docs to match current metadata scan limits and add-provider gating behavior.
2. Add desktop-only notes to `dashboard-mode/README.md` and `shared/README.md`.
3. Decide whether the language selector is legacy. Either remove it in a scoped UI change or document that visible copy remains English-only.
4. Rename `Modal.open()` or add a node-based safe method if HTML input remains intentionally unsafe.
5. Update AGENTS/CLAUDE widget scope to include KDE if agents are expected to maintain it.
6. Add a small note to future artifact templates: docs-only validation is diff review plus `git status --short`.

Validation:

- Docs-only diff review.
- AGENTS/CLAUDE parity check if root docs are edited.

## Suggested Implementation Order

1. Agent artifact templates and `agents/README.md`.
2. End-to-end provider/model/agent addition runbook.
3. No-install `package.json` validation scripts.
4. Widget bundle drift check and docs clarification.
5. Provider registry metadata and allowed-provider derivation.
6. Adapter fixture runner and registry output normalization.
7. Git enrichment service boundary and perf stats.
8. Status normalization at domain boundary.
9. App teardown path.
10. Selection controller and shared presentation helpers.
11. Sprite ID audit and manifest-first generation planner.
12. Drawable contract, then World mode layer extraction.
13. Building visuals registry and `AgentSprite` responsibility split.
14. Widget pricing/model metadata source of truth.
15. CSS refinement collapse and remaining easy-low docs/comment fixes.

## Parallelization Plan

Good light-swarm slices:

- Docs/resources: runbook, templates, artifact index, SOP quick modes.
- No-install validation scripts and package aliases.
- Widget non-mutating checks.
- Adapter fixture design.
- Runtime sprite ID audit.

Good full-swarm slices after baselines:

- Provider registry metadata and output normalization.
- Status normalization plus frontend selection ownership.
- World drawable contract and layer extraction.
- Building visuals registry.
- Widget pricing/model metadata consolidation.

Avoid parallel edits across:

- `IsometricRenderer.js` and any new World layer extraction files.
- `BuildingSprite.js` and `buildingVisuals` migration.
- `TokenUsage.js`, widget Swift, widget HTML, and KDE pricing files unless one owner coordinates the metadata source.
- `AGENTS.md` and `CLAUDE.md`; maintain parity in the same slice.

## Validation Matrix

Docs-only:

- Diff review.
- `git status --short`.
- Root parity when editing AGENTS/CLAUDE:
  `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)`.

Backend/adapters/services:

- `node --check claudeville/server.js`
- `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`
- fixture runner once added
- `/api/providers`, `/api/sessions`, `/api/perf`

Frontend/shared UI:

- `find claudeville/src -name '*.js' -print0 | xargs -0 -n1 node --check`
- Browser smoke at `http://localhost:4000`
- World + Dashboard mode switch
- agent select/deselect from World, Sidebar, Dashboard
- Activity Panel detail refresh

Sprites/world visuals:

- `npm run sprites:validate`
- `npm run sprites:audit-ids` once added
- sprite capture and visual diff when visual output changes
- reduced-motion smoke for motion features

Widget:

- `npm run widget:check` once added
- `npm run widget:verify-bundle` once added
- macOS only: `npm run widget:build`, then `npm run widget`
- KDE only: `npm run widget:kde:check`, install only when explicitly in scope

## Residual Risks

- Some recommendations overlap earlier follow-up plans. The supersession note near the top identifies older P1 follow-ups already implemented at this baseline; before using any older plan, verify it against current code and prefer this artifact for remaining agent-work streamlining scope.
- World mode refactors are high-touch despite being maintainability work. Land contracts and diagnostics before splitting large files.
- Widget Swift and KDE validation remain platform-dependent. Non-mutating source checks reduce risk but do not replace platform smoke tests.
- Adapter fixtures must avoid private provider data. Use sanitized synthetic records only.
- Generated visual assets require human visual review; validators can catch missing files and dimensions, not art quality.
