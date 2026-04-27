# Chronicle — Implementation Plan

Generated: 2026-04-28

ClaudeVille is excellent at "now" and amnesiac about "yesterday." This plan adds visible memory: harbor manifests, founding stones, day-trails, a Chronicler NPC, and a thresholded aurora. It also introduces a previously-absent client-side persistence layer — the single highest-risk piece of this effort.

This plan rides on top of `agents/plans/world-enhancement-plan.md` and assumes Tier 0 has landed, especially T0.2 (LightingState), T0.3 (LightSourceRegistry), T0.4 (HiDPI), T0.5 (viewport tile bounds), and T0.6 (motion-budget policy). Where the existing plan already addresses something — empty-state visual (#37), pulse-cue ownership (#36), prop split-horizon (#33) — this plan cites by ID and does not re-document.

---

## Goal

Make the village accumulate visible memory. Past commits, milestones, and agent paths leave durable, decaying traces in the world. The village reads as inhabited at zero agents, deepening the empty-state story (#37) and giving "I just opened the dashboard" some narrative weight without pulling the user into a separate history view.

## Non-goals

- No server-side history store. `claudeville/server.js` stays HTTP+WS only (see `docs/design-decisions.md` § Hand-written WebSocket framing).
- No new runtime dependencies. IndexedDB is a browser built-in; no library on top.
- No git replay across machines, no cross-tab sync of mutating state.
- No reading or writing of provider session files for archival purposes — the read-only adapter contract stays intact.
- No Replay Theater ship/build in this plan; sketch only (Sprint E).
- No commit-graph reconstruction. The chronicle is a sparse record of what passed through ClaudeVille while it watched, not a `git log`.
- No new event-bus events beyond what's required for the Chronicler and modal flow.

## User-visible outcomes

- Each commit observed during a push leaves a weathering plank on the harbor pier with the commit subject; clicking opens a small modal.
- Selected milestones (release tags, merged-style commits, big test runs) plant a small stone in the matching district; obelisks visibly age over weeks.
- Each agent leaves a faint trail of where it has been over the last hour, stratified by morning/afternoon/night; selected agent's trail brightens.
- A Chronicler NPC walks a slow loop near the Lore Archive whether or not any agent is online — the empty-state visual gains a body (closes #37 from the world plan).
- At most once per local day, a real release / quota rollover / large milestone triggers a brief aurora in the existing sky.
- Village state survives reload. Closing the tab and reopening shows recent memory.

## Data dependencies

- `claudeville/adapters/gitEvents.js`: `parseGitEventsFromCommand`, `extractGitEventsFromCommandSource`, `inferPushedGitEventsForSessions`, `inferUnpushedGitEventsForSessions`. Event shape: `{ id, type: 'commit'|'push', command, project, provider, sessionId, sourceId, ts, commandHash, dryRun, success?, exitCode?, completedAt?, targetRef?, label?, sha?, inferred? }`. Manifests and monuments derive from this shape and are keyed by `id` for idempotency.
- `claudeville/adapters/{claude,codex,gemini}.js`: each session carries `gitEvents`. The chronicle reads from session payloads on the frontend, not from raw provider files.
- `claudeville/src/presentation/character-mode/HarborTraffic.js`: precedent for git-event reactive entities. `normalizeGitEvent`, `collectGitEventsFromAgents`, push status normalization (`success | failed | unknown`) is reused; `commitMessageFromCommand` (line 193) is reused for plank labels.
- `claudeville/src/presentation/character-mode/LandmarkActivity.js`: precedent for keeping district-attached transient items with TTL maps and `expiresAt`/`createdAt` fields. The persistence layer extends this pattern from "transient" to "durable."
- `claudeville/services/usageQuota.js`: `fetchUsage()` returns `{ quota: { fiveHour, sevenDay }, quotaAvailable }`. The aurora trigger detects rollover by sampling and noticing a downward step in either field.
- `claudeville/src/presentation/character-mode/AtmosphereState.js`: `phase`, `phaseProgress`, `dayProgress`, `lighting.beaconIntensity`, `lighting.lightBoost`, `clock.localDate`. Trails read `dayProgress` at sample time to band by phase. Aurora attaches to `SkyRenderer.draw` after `_drawClouds` and modulates with `lighting.beaconIntensity`.
- `claudeville/src/domain/entities/Agent.js`: `agent.position` (Position with `tileX`, `tileY`), `agent.id`, `agent.provider`, `agent.model`. Sample the canonical `agent.position` (domain) rather than `AgentSprite` interpolated screen coordinates — the domain position is the persistable truth.
- `claudeville/src/domain/events/DomainEvent.js`: existing `eventBus`. The chronicle adds two events: `chronicle:milestone` (emitted when a monument is planted) and `chronicle:aurora` (emitted when the daily aurora fires). Both are local broadcast only.

## Architectural prerequisites

The chronicle introduces one large new piece of architecture (persistence) plus three smaller ones. Number them `CH0.x` to keep them distinct from `T0.x` in the world-enhancement plan.

### CH0.1 IndexedDB persistence layer (`infrastructure/ChronicleStore.js`)

**Domain:** Infrastructure · **File:** `claudeville/src/infrastructure/ChronicleStore.js` (new) · **Effort:** L · **Impact:** High (gates everything below)

Single ES-module wrapper around `window.indexedDB`. No dependency. Fits the no-bundler, no-lib stance in `docs/design-decisions.md` § "Dependency-free runtime, no build step." Choice rationale: trail samples can run to ~36 KB per agent per hour at 1 Hz × 10 agents × 1 hour ≈ 360 KB; IndexedDB is the only built-in store that handles this without paying JSON parse cost on every page load. localStorage is rejected — synchronous, 5 MB ceiling, no key range queries.

Database name: `claudeville-chronicle`. Single bumpable version constant. Object stores:

| Store | Key | Indexes | Notes |
| --- | --- | --- | --- |
| `manifests` | `id` (gitEvent.id) | `byProject` (project), `byTs` (ts) | One row per observed commit ship. Persists ~24h; click-pinned rows extend to 7d. |
| `monuments` | `id` (deterministic hash, see CH0.2) | `byDistrict` (district), `byPlantedAt` (plantedAt) | Persists ~30d, capped per district. |
| `trailSamples` | auto-increment | `byAgent` (agentId), `byTs` (ts) | One row per (agent, second). Persists ~24h. Compound index unnecessary — `byAgent` + range over `byTs` does the work. |
| `auroraLog` | `localDate` (YYYY-MM-DD) | n/a | One row per day-fired aurora. Existence-of-row is the rate-limit. |
| `meta` | `key` | n/a | Singleton rows: `schemaVersion`, `lastQuotaSnapshot` (for rollover detection). |

API surface (deliberately small):

```text
ChronicleStore.open() -> Promise<this>
  // creates DB, runs migrations, returns once ready

ChronicleStore.put(storeName, value)
ChronicleStore.bulkPut(storeName, values)
ChronicleStore.get(storeName, key)
ChronicleStore.deleteKey(storeName, key)
ChronicleStore.queryRange(storeName, indexName, lower, upper, opts) -> AsyncIterable
ChronicleStore.deleteRange(storeName, indexName, lower, upper)
ChronicleStore.count(storeName, indexName?, range?)
```

Eviction: a single `ChronicleStore.prune(now)` method, called every 5 minutes (visibility-aware), runs three deletions:

- `manifests`: delete where `ts < now - 24h && !pinned`.
- `monuments`: delete where `plantedAt < now - 30d`. Per-district cap is enforced at write time, not here.
- `trailSamples`: delete where `ts < now - 24h`.

Schema migration: integer `schemaVersion` in `meta`. On `onupgradeneeded`, switch on `oldVersion → newVersion`. v1 ships the schema above. Subsequent versions add stores or indexes without dropping data; if a destructive change is needed, the field is renamed and a one-shot migration copies forward. This stays simple while we have one writer.

Tab/multi-window behavior: ClaudeVille is a single-user single-machine dashboard but multiple tabs are possible. Election is light-touch:

- Every tab opens the DB read/write.
- Writes are idempotent (manifests and monuments are content-addressed; trail samples are append-only with a per-agent monotonic `ts`).
- Trail capture is gated by a `BroadcastChannel('claudeville-chronicle')` lease: the tab that has been visible most recently holds the lease and is the only one writing trails. Other tabs read-only.
- Manifests, monuments, and aurora are written by any tab on first observation — last-write-wins; deduped by `id`.
- No `storage` event fallback. BroadcastChannel is supported in every browser ClaudeVille already requires for `prefers-reduced-motion`, ResizeObserver, and ES modules.

Server-side persistence is explicitly not pursued. The architectural cost (new on-disk store, schema migrations in Node, read API for the dashboard, sync semantics) violates the no-build-step / no-runtime-deps stance in `docs/design-decisions.md`. The trade is: chronicles are tied to a browser profile. The user accepts that on the upside of a clean architecture.

### CH0.2 Monument detection rules (`application/MonumentRules.js`)

**Domain:** Application · **File:** `claudeville/src/application/MonumentRules.js` (new) · **Effort:** S · **Impact:** Medium

Pure module. Input: a normalized git event (already passed through `HarborTraffic.normalizeGitEvent`) plus optional context (project repo info, current build/test signal). Output: `{ kind, district, weight, label, dedupKey } | null`.

Rule set v1, ranked first-match-wins:

1. **Release stone (Harbor district).** `event.type === 'push' && event.targetRef matches /^v?\d+\.\d+/`. Tag-shaped refs only; pushes to feature branches do not qualify. `dedupKey = "release:${project}:${targetRef}"`.
2. **Feature stone (district by tool category).** `event.type === 'commit' && event.success !== false && commitMessageFromCommand(command) matches /^(feat|fix|refactor|perf)(\(.+\))?:/`. District from a small map: `feat` → Code Forge plaza, `fix` → Task Board, `refactor` → Lore Archive, `perf` → Token Mine. `dedupKey = "commit:${project}:${sha || commandHash}"`. Plain "minor commit" subjects without conventional prefix are explicitly excluded — heuristic-shaped but cheap.
3. **Verified stone (Task Board).** Most recent commit on `event.project` is followed within 90s by a tool-input matching `LandmarkActivity.isTaskCommand` (line 82) AND that tool returned exit code 0. Captured by stitching together `LandmarkActivity` signals with the next `agent:updated` carrying `lastTool` matching the verify pattern. `dedupKey = "verify:${project}:${commandHash}"`. Low confidence; gate with a feature flag for v1.
4. **Otherwise:** no monument. Many events stay as harbor manifests only.

`dedupKey → id` is `stableHash(dedupKey)` reusing `gitEvents.stableHash` already exported. Idempotent across reloads.

**Per-district cap.** Hard cap of 6 monuments visible per district. When a 7th would be planted, the *oldest* monument in that district is upgraded into a *Founding Layer* (group sprite) and the count restarts. The reader sees a denser stone garden, not a graveyard. Enforced in `ChronicleStore.put('monuments', ...)`.

### CH0.3 Trail capture & overlay canvas (`presentation/character-mode/TrailRenderer.js`)

**Domain:** World render · **File:** `claudeville/src/presentation/character-mode/TrailRenderer.js` (new) · **Effort:** M · **Impact:** Medium · **Depends on:** T0.4 (HiDPI), T0.6 (motion-budget)

Captures and renders agent trails. Two phases:

- **Capture (1 Hz, lease-holding tab only).** A `setInterval(captureTick, 1000)` driven by `document.visibilityState`. On each tick, iterate `world.agents`, push `{ agentId, ts, tileX, tileY, dayProgress, phase }` rows into an in-memory ring buffer per agent (cap 3600 rows = 1 hour). Bulk-flush every 30s to `trailSamples` via `ChronicleStore.bulkPut`. Skip flush if the page is hidden — coalesce on visibility return.
- **Render (low cadence, every 2s on a separate offscreen canvas).** Build a single `OffscreenCanvas` (or `<canvas>`) sized at `viewport.width × viewport.height × dpr` (T0.4). Repaint when (a) trail data changed, (b) camera moved more than 4 px or 0.05 zoom step, or (c) selected agent changed. Reuse the resulting bitmap by `drawImage` every frame in the render loop — close to free.

Render strategy:

- For each agent's trail, draw a polyline from oldest sample to newest. Color is keyed by `phase` (banded): morning warm yellow, afternoon neutral, dusk amber, night cool blue. Alpha gradient by age, capped at `0.18` for non-selected and `0.5` for selected.
- Line width: 1 px logical for non-selected, 2 px for selected. Snap to integers per T0.4.
- Per-frame draw cap: skip agents whose entire trail is offscreen (use `Camera.getViewportTileBounds` from T0.5).
- Reduced-motion (T0.6): repaint only when data changes; do not animate fade-out. The trail is static under reduced motion.

### CH0.4 Privacy redaction toggle (settings)

**Domain:** Application · **File:** `claudeville/src/application/Settings.js` or wherever the language toggle lives, `claudeville/src/presentation/shared/TopBar.js` for the UI surface · **Effort:** S · **Impact:** Low (defensive)

Off by default. When enabled, manifest plank labels and monument hover labels are replaced by `"[redacted commit]"` (and `[redacted release]`, etc.). The underlying records keep raw data — toggling back restores. Persisted in `localStorage` (small string, immediate read on boot, fits the existing language-setting pattern).

This is shipped because commit subjects can carry sensitive information and a "I want to demo this without revealing my work" affordance is one short module away. Not surfaced as a question.

---

## Phases / sprints

5 sprints. Each ends demoable. ~12 work items.

### Sprint A — Persistence foundation (Demoable: round-trip a row)

**A1. ChronicleStore module + schema v1.**
Domain: Infrastructure · File: `claudeville/src/infrastructure/ChronicleStore.js` (new), `claudeville/src/presentation/App.js:32-50` (boot) · Effort: L · Impact: High · Depends on: —

Implement CH0.1. Wire `await ChronicleStore.open()` at the top of `App.js` boot, before any other chronicle module loads. Write a smoke test path: a hidden global helper `window.__chronicle.put('manifests', { id: 'test', ... })` that subsequent code can `get`. Ship with no chronicle UI yet; verify in DevTools → Application → IndexedDB.

**A2. BroadcastChannel lease for capture.**
Domain: Infrastructure · File: `ChronicleStore.js` · Effort: S · Impact: Medium · Depends on: A1

Helper `ChronicleStore.acquireCaptureLease()` that returns true if this tab should own writes. Heartbeats every 2s, releases on `pagehide`. Other tabs hear the lease holder's heartbeats and stay readers. Required before any sprint-B writer ships.

**A3. Periodic prune.**
Domain: Infrastructure · File: `ChronicleStore.js`, `App.js` · Effort: S · Impact: Medium · Depends on: A1

`ChronicleStore.prune(now)` runs every 5 minutes via `setInterval` (gated by `document.visibilityState === 'visible'`) and on first boot. Manifests/monuments/trail samples cleaned per the eviction rules in CH0.1. Logs single line `[chronicle] prune: -X manifests, -Y monuments, -Z trail samples`.

### Sprint B — Harbor manifests (Demoable: planks appear on commit ships)

**B1. ManifestPlank entity and pier layout.**
Domain: World render · File: `claudeville/src/presentation/character-mode/ChronicleManifests.js` (new), tile coordinates near existing `BERTHS` in `HarborTraffic.js:21-34` · Effort: M · Impact: High · Depends on: A1

Module mirroring `HarborTraffic` shape — a class with `update(events, now)`, `enumerateDrawables(now)`, `draw(ctx, drawable, zoom)`. On each unseen `gitEvent.type === 'commit'`, create a plank entry rooted at a free pier tile (a small grid of 3×8 tiles directly south of the harbor's `walkExclusion`, defined in this module — does not need to live in `townPlan.js`). Persist via `bulkPut('manifests', planks)`.

Sprite: small wood plank (manifest entry, 24×8 px, share existing wood palette). Etched commit subject drawn via `ctx.fillText` at tiny size (similar to existing pennant code at `HarborTraffic.js:1242`). Reuse `commitMessageFromCommand` (line 193) for the label.

Weathering: plank alpha decays linearly from 1.0 at age=0 to 0.3 at age=24h. After 24h, prune deletes the row and the drawable disappears.

Drawables go into `IsometricRenderer._render` next to `harborDrawables` at line 1354 — same kind hook (`'harbor-traffic'` or new `'chronicle-manifest'`). Sort order: behind ships when ships are at berth, in front when ships have departed (sortY uses tile center + 4 px offset, mirroring the existing repo-dock logic at line 805).

**B2. Plank click → modal.**
Domain: World render + DOM · File: `IsometricRenderer.js:1060-1095` (existing hit test path), `Modal.js`, new `ChronicleManifestModal.js` · Effort: S · Impact: Medium · Depends on: B1

Extend the existing click hit-test to test plank rectangles after agent and building hits. On hit, open `Modal.open('Manifest', html)` with a small panel: subject line, repo, sha (if available), provider, push status, "pin" button. Pinning sets `pinned: true` + `pinnedAt: now`; pinned planks survive the 24h prune. Pinning is also the implicit "I care about this" signal — stay loose, don't grow it into a star system.

**B3. Late-arriving commit handling.**
Domain: World render · File: `ChronicleManifests.js` · Effort: S · Impact: Medium · Depends on: B1

When `gitEvents` brings a commit whose `ts` is older than 60s, insert into the store at the correct timestamp but do not animate the plank "drop." It appears, weathered to its age. Recent (<60s) planks animate the drop. Threshold matches the harbor's own `RECENT_PUSH_REPLAY_MS` discipline at `HarborTraffic.js:14`.

### Sprint C — Founding stones (Demoable: a release plants a stone)

**C1. MonumentRules + planter.**
Domain: Application · File: `claudeville/src/application/MonumentRules.js` (new), `App.js` (wiring) · Effort: S · Impact: Medium · Depends on: A1

Implement CH0.2. A `MonumentPlanter` driver subscribes to `agent:updated` (and the merged event stream feeding `HarborTraffic`) and walks new git events through `MonumentRules.classify(event, ctx)`. On match, computes a placement tile (see C2), writes via `put('monuments', record)`, emits `chronicle:milestone` on the bus.

**C2. Placement algorithm.**
Domain: Application · File: `MonumentRules.js` · Effort: S · Impact: Medium · Depends on: C1

For a given district, compute the building footprint, expand outward in tile rings, and select the first tile that satisfies: not in `walkExclusion`, not in `visitTiles`, not in `waterTiles`, and at least 2 tiles from any other monument. Inputs come from `claudeville/src/config/buildings.js` (district map) and the live `walkabilityGrid` exposed by `IsometricRenderer`. Tile choice is deterministic from `dedupKey` so reloads land in the same spot.

**C3. Monument sprites and weathering.**
Domain: World render · File: `claudeville/src/presentation/character-mode/ChronicleMonuments.js` (new), `claudeville/assets/sprites/manifest.yaml` (3 new sprite IDs) · Effort: M · Impact: High · Depends on: C1, C2

Three small obelisk variants in `monument.<kind>` namespace: `monument.release`, `monument.feature`, `monument.verified`. Generated through pixellab using existing workflow (`scripts/sprites/generate.md`). Weathering is alpha-only for v1 — alpha decays from 1.0 (fresh, age < 1d) to 0.55 (1mo). Optional second pass adds moss tint via `Compositor` palette swap, but defer.

Drawables flow into `IsometricRenderer._render`:`drawables` array as `'chronicle-monument'`. Sort by Y like existing district props. Enable `splitForOcclusion` for monuments large enough to overlap walking agents — tied to T0.5/T0.4 / world plan #33 (prop split-horizon).

**C4. Hover tooltip.**
Domain: World render · File: `ChronicleMonuments.js`, `IsometricRenderer.js:898` (hover hook) · Effort: S · Impact: Medium · Depends on: C3

Hover shows: monument kind, repo name, label, planted-at relative time, age in days. Reuses existing tooltip plumbing — same pattern as building hover.

**C5. Minimap monument dots.**
Domain: World render · File: `Minimap.js:213-229` (static layer build) · Effort: S · Impact: Low · Depends on: C3

In `_ensureStaticLayer`, after buildings are drawn, fetch all monuments via `ChronicleStore.queryRange` once at cache-build time and stipple them as 1×1 stipple dots colored by `kind`. Cache key bumps include monument set hash so adds/removes invalidate. Out of the live frame budget.

### Sprint D — Day-trails and Chronicler (Demoable: trails persist; NPC walks)

**D1. TrailRenderer module.**
Domain: World render · File: `TrailRenderer.js` (new), `IsometricRenderer.js` (mount + draw call) · Effort: M · Impact: Medium · Depends on: A1, A2, T0.4, T0.5, T0.6

Implements CH0.3. Mount in `IsometricRenderer.constructor` near line 305 (next to `landmarkActivity`). `update(world.agents, now)` runs the 1 Hz capture (lease-gated). `draw(ctx, camera)` blits the cached overlay below the agent draw layer. Layer placement: between bridges/roads (terrain) and prop drawables (stage 1.5), so trails are *under* sprites but *over* ground tiles. Reuse `_resetScreenTransform` / `camera.applyTransform` patterns.

**D2. Chronicler NPC.**
Domain: World render · File: `claudeville/src/presentation/character-mode/Chronicler.js` (new), `manifest.yaml` (one new character sprite) · Effort: M · Impact: High (closes #37) · Depends on: T0.6

Standalone NPC (does not use the Agent path — the Chronicler is not a session). Walks a deterministic Hamiltonian-ish loop between three landmarks: Lore Archive entrance → Command Center plaza → Lore Archive entrance, with a random pause at each. Speed: 0.018 tiles/frame (third the AGENT_SPEED constant at `constants.js:AGENT_SPEED`). Pauses ~6s.

Replaces the placeholder ellipse in `_drawEmptyStateWorldCue` (`IsometricRenderer.js:3810-3834`) with an actual sprite. Visible at all agent counts, not just at zero or one — the Chronicler is durable presence, not a fallback. Animation: shared 4-frame walk on the existing 92-px character sheet pattern. Sprite generated through pixellab (one new character: `character.chronicler`, scribe hood + book accessory).

Motion budget (T0.6): on `motionScale = 0`, the Chronicler stops at the nearest waypoint and stays still. Don't allocate animation phases.

**D3. Selected-agent trail brighten.**
Domain: World render · File: `TrailRenderer.js` · Effort: S · Impact: Low · Depends on: D1

Subscribe to `agent:selected`/`agent:deselected` and bump the selected agent's per-trail alpha. Bump invalidates the cached trail bitmap and triggers a repaint on the next 2-second cadence.

### Sprint E — Aurora + Replay sketch (Demoable: aurora fires once)

**E1. Aurora trigger gate.**
Domain: Application · File: `claudeville/src/application/AuroraGate.js` (new), `App.js` · Effort: S · Impact: Medium · Depends on: A1, services/usageQuota

Pure module: `AuroraGate.evaluate(now, signals)` returns `'fire' | 'skip'`. Fires when:

- Today's `auroraLog` row is missing, AND
- One of: (a) a `release` monument was planted in the last 5 minutes, (b) `services/usageQuota.fetchUsage()` shows the 5h or 7d quota dropping by ≥ 50% relative to the last cached `meta.lastQuotaSnapshot` (rollover signal), (c) a `verified` monument was planted with `weight === 'major'` (e.g., a sprites:validate or full sprite-visual-diff run signal).

After firing, write today's row to `auroraLog`. The row's existence is the rate-limit. No polling beyond what `ws:update` and `usage:updated` already deliver.

Quota rollover detection: store `lastQuotaSnapshot = { fiveHour, sevenDay, ts }` in `meta`. Compare on each `usage:updated` event (already wired into `App.js:71`). Negative delta beyond threshold triggers.

**E2. Aurora layer in SkyRenderer.**
Domain: Sky · File: `SkyRenderer.js:46` (after `_drawClouds`), new `_drawAurora` method · Effort: M · Impact: High · Depends on: T0.2, E1

Single ribbon of three soft gradients painted between cloud and weather layers. Modulated by `lighting.beaconIntensity` and a 12s lifecycle (fade-in ~2s, hold ~6s, fade-out ~4s). Ribbon path is two cosine bands across the sky width; alpha capped at 0.22; composition `'screen'` to match the sun glow path. Reduced-motion (T0.6): hold a single still frame at peak alpha for the full 12s rather than animating.

State lives in `SkyRenderer` instance; `App.js` (or the renderer) calls `skyRenderer.triggerAurora(now)` when `AuroraGate.evaluate` returns `'fire'`. After the cycle ends, no draw cost.

**E3. Replay theater sketch (deferred build, document only).**
Domain: World render · File: this plan file (sketch only); future home `claudeville/src/presentation/character-mode/ReplayTheater.js` · Effort: L (when built) · Impact: Medium · Depends on: full chronicle data

Sketch: clicking the Lore Archive's entrance tile when no agent is being followed opens a modal showing a small inline canvas. Inside: a 30-second time-lapse of the last 6 hours of village life — ships, planks, monuments planted, agent trails redrawn at 200× speed. Implementation strategy notes (do not build now):

- Reuse `TrailRenderer` with a virtual clock that ticks `now` faster.
- Reuse harbor manifest renderer with the same.
- Don't reuse `HarborTraffic` for replay — its state is now-bound and reducing it from history is the part that's actually expensive. The sketch is the deliverable for this sprint.

---

## Risks & tradeoffs

- **Persistence layer is the highest risk.** It introduces a new failure mode (corrupt or evicted IndexedDB) into a stack that has no other state. Mitigations: idempotent writes, deterministic ids, treat the store as a cache (work degrades gracefully on empty store; chronicle features read empty-state if the DB is dead).
- **Browser-tied storage**. Open ClaudeVille in a different browser profile and the chronicle is empty. This is acceptable for a local-first dashboard. Document in README; do not surface as a fix.
- **Monument pollution.** Conventional-commit detection misclassifies sometimes. Per-district cap (CH0.2) bounds visual damage; user can disable a category via the redaction toggle (CH0.4) for visual silence without throwing data away.
- **Aurora spam.** Strict gate (one per local day, requires real signal). Tested by toggling `meta.lastQuotaSnapshot` in DevTools.
- **Trail render cost.** Worst case: 10 agents × 3600 samples × 60 fps. Cache mitigates: trails are repainted on a 2s cadence on a separate canvas, then `drawImage`d each frame. The repaint cost is the only one that grows with samples; cap at 600 visible samples per agent (last 10 minutes) when zoom < 1.5; render the older 50 minutes only when zoomed in.
- **Pulse band collision.** Monument freshness should not pulse — that band belongs to working status (#36 of the world plan). Monuments use alpha decay only.
- **Late-arriving events.** Mid-window late commits show up "weathered to age" without animation. The user does not see a fake "drop" for an event that's hours old.
- **Empty store on first run.** No bootstrap of historic gitEvents. The chronicle starts the day the user first opens the dashboard. Acceptable; documented in non-goals.

---

## Validation

Per-sprint, aligned with `AGENTS.md` § Validation matrix.

- **Sprint A.** `node --check` is irrelevant (frontend modules, no runtime in Node). Browser smoke: open `http://localhost:4000`, run `await window.__chronicle.put('manifests', { id: 't', project: 'x', ts: Date.now() })` and `await window.__chronicle.get('manifests', 't')` in DevTools. Confirm round-trip. Open a second tab; confirm only one tab logs `[chronicle] capture lease acquired`. Watch `[chronicle] prune` log appear after 5 minutes (or call `window.__chronicle.prune(Date.now())` directly).
- **Sprint B.** Run `git commit -m "chore: test chronicle"` in a project an agent is watching. Confirm a plank appears on the harbor pier within 2s, click → modal with subject; reload page → plank still there with reduced alpha; pin → reload → plank survives without alpha decay reset.
- **Sprint C.** Run `git commit -m "feat: test"` and confirm a stone planted near Code Forge. Reload; same stone same tile. Plant 7 stones rapidly; confirm 6 visible + 1 Founding Layer cluster sprite. Hover → tooltip. Minimap dot present.
- **Sprint D.** With no agents online, open the world; the Chronicler walks. Open DevTools → Application → IndexedDB → trailSamples; rows appear at ~1 Hz. Select an agent; trail brightens. Set `prefers-reduced-motion` and confirm Chronicler stops, trails render static.
- **Sprint E.** Force aurora via `window.__chronicle.put('auroraLog', { localDate: '2099-01-01' })` (clear today's row), force a quota drop in DevTools-overridden `/api/usage`, confirm aurora animates once. Repeat same trigger same day; confirm no second fire.

Cross-cutting checks (do for every sprint):

- Browser console: `rg --files | grep '\.md$'` for Hangul (English-only policy from `claudeville/CLAUDE.md`).
- `git status --short` is clean of unrelated files before and after each commit.
- World mode resize during active aurora and active trails. Aurora canvas re-allocs at new DPR per T0.4.

Persistence smoke-test (sprint A acceptance):

```text
1. Open ClaudeVille, do a commit, observe a plank.
2. Close browser tab.
3. Reopen ClaudeVille within 24h.
4. Verify the plank is still there with reduced alpha.
5. Wait 24h+1 min; reload.
6. Verify the plank is gone (the prune fired) and the modal returns "manifest not found" if linked directly.
```

---

## Open questions

These need user input before implementation.

1. **Pin retention.** Currently sketched as 7d for pinned manifests. Should it instead promote to monument? Pro: monuments are how the village "remembers important things." Con: pinning is currently described as low-friction; auto-promotion may surprise. Recommendation: keep pinned manifests as 7d and resist auto-promotion in v1.
2. **Verified-stone confidence.** Rule 3 in CH0.2 is heuristic (commit + verify command exit-zero within 90s). Worth shipping behind a feature flag in v1, with the option to remove if false-positive rate is high. Confirm OK to ship gated, or skip rule entirely until evidence accumulates.
3. **Replay theater entry tile.** Sprint E sketches the Archive entrance as the entry. Alternative: a "TIME" button on the topbar. The world-grammar argument favors the Archive (interaction-on-canvas matches the "village" metaphor); the discoverability argument favors the topbar. Pick one before implementation.
4. **Sprite generation budget.** New sprites: 3 monument variants + 1 Chronicler character + 1 manifest plank = 5 pixellab calls. OK to spend?

---

## Cumulative cost note

Per-frame additions vs. today, assuming Sprints A–D ship as written:

- Trail overlay: 1 `drawImage` of a cached canvas. Repaint every 2s, off-frame. Net per-frame: trivial.
- Manifest planks: `n_planks × (one rect + one text)`. Cap at ~36 visible (3 berths × 12 piers); ~36 fillRects + 36 fillTexts on every frame. Comparable to existing harbor-traffic overlay; no new allocation.
- Monuments: small prop blits, sorted by Y once into the existing drawables array. Cap 6/district × ~5 districts = 30 max. Roughly tree-prop budget; fits.
- Chronicler: one agent-shaped sprite blit. Trivial.
- Aurora: active only ~12s/day; off-frame budget when idle.
- IndexedDB: writes batched at 30s for trails, immediate-but-rare for manifests/monuments. Reads are transaction-batched and cached in module-local memory; cold reads only on (a) boot, (b) prune (every 5 min). No measurable per-frame cost.

Sprint E aurora at peak: one extra `'screen'` gradient pass, ~480 ms per phase across 12s. Within the existing sun/moon glow budget.

Tier-4 Replay theater is left unbuilt; revisit only after measuring Sprints A–D.
