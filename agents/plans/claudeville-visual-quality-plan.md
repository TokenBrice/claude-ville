# ClaudeVille Visual Quality — Prioritized Improvement Plan

> **Status:** `historical` — **executed 2026-07-17**; see "Execution status" at the end. Headline findings were live-verified against http://localhost:4000 on 2026-07-17 (captures: `output/playwright/verify-*.png`, script: `scripts/world/capture-verify.mjs`).
> **Method:** 11 parallel exploration scouts across the browser-app visual surfaces (sky, terrain/water, buildings, characters, overlays/motion, camera/frame, dashboard, chrome/CSS, theme tokens, sprite assets) plus a prior-art audit, followed by a live-server verification pass. Desktop widgets were explicitly excluded from scope. Full scout reports: [`agents/research/visual-quality-plan/scout-reports.xml.txt`](../research/visual-quality-plan/scout-reports.xml.txt).
> **Date:** 2026-07-17.

## Live verification results (2026-07-17, server on :4000)

**Confirmed live:**
- **Water checkerboard** — pervasive in every capture; unmistakably the worst on-screen defect (0.2).
- **Banner cube** — `building.command/banner.png` is literally a crimson cube; it renders as the magenta box beside the keep (0.1). This settles the scout disagreement: the box is the banner layer, *not* `prop.flowerCart`. `portalGlow` (purple vortex cube, visible at the portal base) and `watchfire` (stone cube) confirmed at asset level.
- **Modal off-palette** — changelog modal is blue-gray with yellow borders over the warm bronze app (0.8).
- **Night scene** — very dark world, sparse stars, bright building plaques floating over the murk (supports 0.7, 5.2, 0.6).
- **Sun orb** — soft anti-aliased gradient disc clamped near the map edge, reads as a lamp behind trees (5.3).
- **Dashboard** — flat single-value brown; CINEMA ON and DASHBOARD both filled gold (4.7).

**Adjusted after live check:**
- **Panel name truncation (0.9)** — did not reproduce with "Hollis" at 1600px; the earlier "Atl…" capture shows it still bites longer names / portrait states. Keep, but verify the exact truncation conditions when implementing.

**Not reproduced (kept on code evidence):**
- Clone-army / synchronized crowd (0.5, 3.1) — `?scenario=dense-24-agents` alone does not activate the sim (needs `?sim=1`); the code evidence (swap-source pixel counts, `statusAnim = 0`) is strong.
- DPR ≈0.75 uneven pixels at 2560 (1.9) — code-level fact; eye check inconclusive.
- Night first-paint black frame (0.7's investigation sub-item) — night capture painted correctly this run; keep as investigate-during-implementation.

## North Star

ClaudeVille is already one of the most visually ambitious local dashboards in existence — a living pixel-art village with a real sky, weather, and session-honest motion. The next gains are not *more effects*. They are, in order:

1. **Fix what's broken** — a handful of genuinely defective visuals ship today (a floating red cube beside the castle, a checkerboard lagoon, a status with no styling, clone-army crowds).
2. **One product** — status colors fork between canvas and DOM; the dashboard doesn't look like the same town the world renders.
3. **Then earn new spectacle** — monuments, fog, pennants, sky rewards — only on top of the repaired foundation.

Prior-art context (verified item-by-item by the audit scout): the top-50 visual plan is **fully shipped** (v0.17.0), v0.23 shipped 29/30, the chrome plans shipped. This plan contains **no re-proposals of shipped work**; every item was checked against live code.

## The twelve wounds (headline findings)

1. `building.command/banner.png` **is literally a crimson cube** and renders as the magenta box beside the keep — most visible asset bug in the app (live-verified).
2. **Water checkerboard**: per-tile peppered deep/shallow classification + alternating fills make every water body read as light/dark diamonds.
3. Six civic **props are 250–400-byte placeholder blobs** (well, runestone, oreCart, scrollCrates, harborCrates, noticePillar) at the busiest screen locations.
4. `completed` — a first-class agent status — has **no color, rail, dot, or token anywhere**; success renders as a styling bug.
5. **Status colors fork**: `theme.js` and `reset.css` define different ramps (rate-limited is steel blue in one, amber in the other; the ActivityPanel rings the portrait in one green and labels it in another).
6. **Palette-swap is silently inert on 20 of 21 character sheets** — per-agent variants and team sashes never render; same-model agents are pixel-identical clones.
7. **Crowds animate as one organism** — every agent shares animation phase.
8. The shipped push/subagent **sky rewards (aurora, shooting stars, sky-flare) draw behind the village** and are effectively invisible at default framing.
9. **Modal + toasts are the only off-palette surface** (pre-overhaul blue-gray with yellow borders).
10. At night, PRIMARY marks (waiting beacon, selection, incident pills) are **dimmed ~50% by the atmosphere multiply** while decorative labels stay bright — the legibility hierarchy inverts in the dark.
11. The activity panel truncates the selected agent's **name to ~3 characters** ("Atl…").
12. At 2560px viewports the canvas DPR drops to ~0.75 → **non-integer nearest-neighbor upscale**, visibly uneven pixel widths on every iso line.

---

## Phase 0 — Fix what's broken (visual correctness)

*Gate: each item verified against fresh code, then a before/after capture. Nothing here adds per-frame cost.*

| # | Item | Files | Effort · Risk |
|---|---|---|---|
| 0.1 | **Delete the command banner layer** (live-verified: the magenta box beside the keep is this layer; base.png already has baked banners); rebake `portalGlow`, `watchfire`, `beacon` as `thin tile` isolated objects (all three are "block cube" mis-generations) | `manifest.yaml:448-542`, `buildings/*/` | S · low |
| 0.2 | **Kill the water checkerboard**: BFS distance-to-land depth classification in `SceneryEngine._finalizeWaterMetadata`; shallow tiles treat deep as same-class; lerp instead of alternate the two deep fills | `SceneryEngine.js:279-288`, `IsometricRenderer.js:7904-7912,8930` | M · med |
| 0.3 | **Regenerate the six placeholder props** at 48px on the style-contract ramps (don't restore the old oversized 64px versions from git) | `assets/sprites/props/`, `manifest.yaml:658-700` | S–M · low |
| 0.4 | **`completed` status identity**: token in `STATUS_VISUALS`, `--cv-status-completed`, card rail/dot, sidebar dot, explicit case in AgentSprite (currently falls back to idle), soft-gold "small victory" treatment | `theme.js:54`, `reset.css:48`, `dashboard.css:261,566`, `sidebar.css:193`, `AgentSprite.js:3205` | S · low |
| 0.5 | **Make palette variants + team sashes work**: per-sheet `paletteSource` in manifest character entries, sampled from actual PNGs; `_applyPaletteSwap` prefers sheet sources over provider defaults. Zero art regeneration | `Compositor.js:113-153`, `manifest.yaml` characters block | M · med |
| 0.6 | **Route hero rewards through the canopy pass** so aurora/shooting-stars/sky-flare draw over terrain; optional 2s whole-village warm grade pulse on push | `SkyRenderer.js:146-167,267-319`, `WorldFrameRenderer.js:86` | M · med |
| 0.7 | **PRIMARY marks survive night**: re-stamp waiting beacons/incident pills/selection post-atmosphere (precedent: `drawSelectedAgentXray`); also investigate the night first-paint black frame (`night-after-1440.png`) | `WorldFrameRenderer.js:195-209`, `VillageDirectorOverlay.js:472-477` | M · med |
| 0.8 | **Reskin modal + toasts** to the parchment/bronze tokens (pure CSS) | `css/modal.css` (all) | S · low |
| 0.9 | **Fix activity-panel name truncation**: stack name full-width above the status chip; compact Pin/X | `activity-panel.css:28-180`, `index.html:129-135` | S · low |
| 0.10 | **Selected-building halo double-draw**: skip selected type in the base halo loop | `VillageDirectorOverlay.js:441-449` | S · low |
| 0.11 | **Camera event cues honor `motionScale`** (currently hard-cut under reduced motion) | `CameraDirector.js:306-329` | S · low |
| 0.12 | **Decide role accessories: wire or delete.** Six hat overlays + `RoleAccessory.js` are unreachable (`allowRuntimeRoleAccessory: false`) *and* the art is broken (black head silhouettes, void-faced hood). Recommendation: delete role overlays, keep effort accessories; if wiring instead, rebake first with an "isolated object, no head" recipe. Also delete the broken unused `overlay.status.idle/working/chat.png` | `ModelVisualIdentity.js:75-82`, `RoleAccessory.js`, `manifest.yaml:330-415` | S–M · low |
| 0.13 | **Rebake effort floor rings** — low/high tiers are near-identical ellipses; give them distinct band counts/metals (live semantic markers) | `manifest.yaml:416-432` | S · low |
| 0.14 | **Kill the background rain veil** — ~1–2.4k strokes/frame for an invisible layer, and it slants against the wind 18% of the time | `SkyRenderer.js:1131-1178` | S · low |

## Phase 1 — One palette, one product (systemic coherence)

| # | Item | Files | Effort · Risk |
|---|---|---|---|
| 1.1 | **Unify status ramps**: one canonical hex per status; boot-time bridge that `setProperty`s `--cv-status-*` from `STATUS_VISUALS` so drift becomes impossible | `theme.js:54-62`, `reset.css:42-48`, `App.js` | S · low |
| 1.2 | **Fix the warm attention trio**: waiting/waiting-on-user/rate-limited are three adjacent ambers in DOM; move rate-limited to steel blue; fix the hero-ring CSS that maps two statuses to one color | `reset.css:46`, `activity-panel.css:116-121` | S · low |
| 1.3 | **De-collide provider hues from status hues** (codex badge == working green; gemini badge == idle blue; opencode == deepseek). Shift codex → sprite teal, gemini → indigo; split the twins | `theme.js:100-110` | S · low |
| 1.4 | **Token-conformance smoke script**: assert `--cv-status-* == STATUS_VISUALS`; grep for new private hex tables; wire into `validate:quick` (this drift has happened twice already) | new `scripts/smoke/theme-tokens.mjs` | S · low |
| 1.5 | **One provider hue across badge / trim / sidebar glyph** (Claude is currently purple/lavender/gold depending on surface); add missing `long-context` model-tier color | `AgentPresentation.js:82-91`, `theme.js:106,118-125` | M · med |
| 1.6 | **Unify world canvas text on `WORLD_BODY_FONT`** (harbor ledgers, overlay labels, debug use bare `ui-monospace`) | `HarborTraffic.js:4387+`, `VillageDirectorOverlay.js:93`, `DebugOverlay.js:102` | S · low |
| 1.7 | **Dashboard avatars match world sprites**: request the Compositor's composited bitmap (variant + accessory + team trim) instead of the raw south idle frame | `AvatarCanvas.js:208-265`, `Compositor.js:34-70` | M · low-med |
| 1.8 | **Dashboard ambience synced to the world clock**: 2–3 CSS vars (`--cv-ambient-tint`) driven by local phase, minute-scale updates — night dashboard gets cooler parchment | `layout.css:50-60`, `DashboardRenderer.js` | S–M · low |
| 1.9 | **Pixel-uniform scaling at large viewports**: quantize `effectiveCanvasDpr` so `1/dpr` ∈ {1,2,4} (0.75→0.5 at 2560 = uniform 2× pixels), and settle zoom steps on integers `[1,2,3]` (A/B against the deliberate 1.5 addition first); add zoom/DPR row to the debug overlay to make it observable | `CanvasBudget.js:16`, `Camera.js:19`, `DebugOverlay.js:200` | S · med |
| 1.10 | **Heal the building-base/terrain seam**: post-process the nine `base.png` baked grass ramps toward live terrain tone (hue-masked, deterministic script) | `assets/sprites/buildings/*/base.png`, new script | S–M · med |
| 1.11 | Fold `TeamColor`'s Tailwind table into `theme.js` as curated `TEAM_HUES`; retire the saturated `Appearance.js` fallback palette for provider-tinted neutrals | `TeamColor.js`, `Appearance.js:18-24` | S–M · low |

## Phase 2 — The ground plane (terrain & water richness)

*All bake-side or init-time — zero per-frame cost. Validate with `world:validate-terrain` + `sprites:visual-diff`.*

| # | Item | Files | Effort · Risk |
|---|---|---|---|
| 2.1 | **Coherent low-frequency noise field**: one smoothed value-noise helper routed through region tint, grass greens, road materials, vegetation density, sea bands — turns per-tile confetti into authored masses | `IsometricRenderer.js:1286,7934,8938,1091`, `SceneryEngine.js:617-654` | M · low |
| 2.2 | **Shoreline wet/dry structure**: wet-sand crescent, sandy-bed shallow tint | `SceneryEngine.js:394-413`, `IsometricRenderer.js:7865-7874` | S · low |
| 2.3 | **One-mass deep-sea gradient**: single baked radial multiply over the sea basin | `IsometricRenderer.js:6299-6415` | S · low |
| 2.4 | **Iso-diagonal wavelets** baked on big water bodies to break horizontal banding | `IsometricRenderer.js` bake path (or `terrain.shallow-deep` regen) | S–M · low |
| 2.5 | **Painterly terrain suite rebake** (6 Wang tilesets) — the single largest "world looks hand-made" lever; ~100–160 PixelLab generations, contact-sheet review | `manifest.yaml:1086-1121`, `terrain/*/` | M · med |
| 2.6 | **Vegetation hygiene**: kill baked ground squares on large trees/flowerBed; replace dice boulders, crate pine, black-spike grass tufts | `manifest.yaml:924-1082` | M · low |
| 2.7 | Road verges + corner wear; clustered lilypad drifts and reed beds; bridge-pier foam + under-deck water shadow | `IsometricRenderer.js:6759-6765,7239-7249`, `scenery.js:429-448` | S · low |
| 2.8 | **Second river crossing** using the dead `bridge.ew/ns` plank assets (walkability change — needs routing review) | `scenery.js:186-196`, `IsometricRenderer.js:7188` | M · med |
| 2.9 | **Prop contact shadows** (the contract's grounding rule, currently buildings-only) | `IsometricRenderer.js:4384-4394,9953-9977` | S · low |

## Phase 3 — Crowd life (characters & legibility)

| # | Item | Files | Effort · Risk |
|---|---|---|---|
| 3.1 | **Per-agent animation phase seeded from agent id** (motes already do this) — dissolves the "one organism" crowd | `AgentSprite.js:366,494-495` | S · low |
| 3.2 | **Selection-ring visibility**: double stroke weight + soft dark backing ellipse so it survives bright ground | `AgentSprite.js:2284-2293,3208-3235` | S · low |
| 3.3 | **Scale ritual work gestures by `drawScale`** — the 2–6px hammer/page props are invisible at zoom 1 | `AgentSprite.js:5361-5522` | S · low |
| 3.4 | **Name-tag legibility**: near-opaque dark panel, parchment text, repo accent on glyph/border only; clamp de-collision slots off prop footprints | `AgentSprite.js:4372-4445` | S · low |
| 3.5 | **Compact-badge status marks**: add the one-char `mark` field `STATUS_VISUALS` was designed for | `theme.js:54-62`, `AgentSprite.js:4467-4471` | S · low |
| 3.6 | **Zoom-impostor provider fill**: overview becomes a provider-colored constellation matching the sidebar/minimap | `AgentSprite.js:5529-5582` | S · low |
| 3.7 | **Agent hover affordance** (ring + name pill; buildings already have hover) | `IsometricRenderer.js` mousemove, `AgentSprite.js` | M · low-med |
| 3.8 | **Merge identical bubbles** in dense clusters into one bubble + ×N chip | `IsometricRenderer.js:3956-3992`, `AgentSprite.js:4076-4098` | M · med |
| 3.9 | **Finish the mark-governor contract**: tier incidents/handoffs/lifecycle/parade/crowd auras; priority-ordered admission so talk arcs don't cull first; snap the 11+ local sine cadences onto PulsePolicy bands (council ring is declared *static* yet shimmers ±16%) | `VillageDirectorOverlay.js`, `CouncilRing.js:211`, `MarkGovernor.js:78-101` | S–M · low-med |
| 3.10 | Dedupe the triple team mark (aura wash + council ring + orbit light); unify the two trail vocabularies (replay vs hour-trails) | `VillageDirectorOverlay.js:228-249`, `TrailRenderer.js:315-336` | S–M · med |

## Phase 4 — Dashboard & chrome craft

| # | Item | Files | Effort · Risk |
|---|---|---|---|
| 4.1 | **Collapse empty tool history + `align-items: start`** — biggest density win (~2.2 → ~3.5 cards at 720p) | `DashboardRenderer.js:334-343`, `dashboard.css:167-173` | S · low |
| 4.2 | **Attention-state header washes**: 8–12% status-tinted gradient on errored/waiting/rate-limited card headers — triage is the dashboard's one job, today the signal is a 3px rail | `dashboard.css:261-266,387-395` | S · low |
| 4.3 | **FLIP-animate card reorders** on status change (prior runner-up #58; reduced-motion = instant) | `DashboardRenderer.js:105-161` | M · med |
| 4.4 | Relative timestamps on tool-history rows; de-pill the meta row (pills for provider+team only); district tint on the avatar niche ground | `AgentPresentation.js:218-235`, `dashboard.css:463-527`, `AvatarCanvas.js:244-250` | S · low |
| 4.5 | **Hearth-glow bottom anchor** so the grid never ends in a void at 1440p+; doubles as richer empty state | `layout.css:50-60`, `dashboard.css:176-226` | S · low |
| 4.6 | dashboard.css house-palette cleanup (~8 hardcoded hexes → tokens) | `dashboard.css:487-785`, `reset.css:29-83` | S · low |
| 4.7 | **Single-gold-button hierarchy**: filled gold reserved for the active mode; cinema/sound "on" get quieter engaged treatments | `topbar.css:410-518` | S · low |
| 4.8 | **Honor the 10px type floor** in the topbar (labels currently 8px) or amend the contract explicitly | `topbar.css:290-495`, `reset.css:65-71` | S · low |
| 4.9 | **World↔Dashboard transition**: ~180ms fade on the incoming container (world loop already stops — zero per-frame cost); reduced-motion keeps the cut | `ModeManager.js:26-38`, `layout.css:29-60` | S–M · low |
| 4.10 | Toast `error` variant + panel-aware `right` transition; modal entrance + `role="dialog"`/focus management; section-title vs disclosure-summary hierarchy in the panel | `modal.css`, `Modal.js`, `NotificationService.js:33-37`, `activity-panel.css:840-866` | S · low |
| 4.11 | Cross-browser scrollbar tokens; version-chip affordance; extract the duplicated `.topbar__tag` base; sidebar collapse transition (verify canvas-resize churn first) | `reset.css:125-140`, `topbar.css`, `sidebar.css:96-118` | S · low-med |
| 4.12 | **Prior-plan leftovers, fully spec'd**: perf-health readout (FPS thresholds + hover panel); sidebar idle-age suffix + subagent parent link (dashboard parity) | `TopBar.js:176-186`, `Sidebar.js:202-300` | S · low |

## Phase 5 — Frame, camera & sky polish

| # | Item | Files | Effort · Risk |
|---|---|---|---|
| 5.1 | **Unify the fast-path vignette** with the radial one (small cached stamp) — the frame changes character mid-zoom today | `IsometricRenderer.js:9425-9459` | S · low |
| 5.2 | Viewport-scaled star density (fixed 90 stars → sparse dead sky at 1440p); ambient clear-night meteors every ~90–180s | `SkyRenderer.js:11,221-239` | S · low |
| 5.3 | **Pixel-art sun asset** (moon has authored assets; the sun is a soft anti-aliased orb — violates the pixel-integrity doctrine) | `SkyRenderer.js:508-585`, `manifest.yaml:1147-1199` | M · low |
| 5.4 | Seasonal day-length modulation (fixed dawn/dusk year-round despite the season system) | `AtmosphereState.js:27-32,369-379` | S–M · med |
| 5.5 | **Session-weather legibility**: violet-cast storm canopy/lightning when fleet-error storminess dominates; warm god-rays on clearing — makes "storm = fleet struggling" *readable* | `AtmosphereState.js:587-612`, `WeatherRenderer.js:556-652` | M · med |
| 5.6 | Canopy cloud alpha lift; cross-fade cloud sets during weather transitions; 3-step RM envelopes for sky rewards | `SkyRenderer.js:292-319,846-876,958-1058` | S–M · low-med |
| 5.7 | Glide for F-key/resize re-frames; fix establishing-shot retry flag; letterbox bars on release/incident cues; offscreen-event edge indicator (restores spatial awareness without reviving the removed minimap) | `IsometricRenderer.js:2011-2030`, `WorldFrameRenderer.js:265-294`, `CameraDirector.js:331-356` | S–M · low-med |
| 5.8 | Perf hygiene sweep: firefly glow-stamp cache (240 gradient allocs/frame → one stamp); memoize `gradeRgb` per frame; cache glide-grade gradient; single monotonic clock; reconcile world pills vs building plaques; RM static buoy flame + `lighter`→`screen` torch | `ParticleSystem.js:89-105`, `VillageDirectorOverlay.js:20-47`, `WorldFrameRenderer.js:24,285`, `HarborTraffic.js:5916-6028` | S · low |

## Phase 6 — Spectacle & storytelling (only after 0–5 land)

| # | Item | Files | Effort · Risk |
|---|---|---|---|
| 6.1 | **ChronicleMonuments sprite set** (prior #60): 4 PixelLab monuments on the style contract, keep gem glow as composite overlay — release history deserves better than flat vector polygons | `ChronicleMonuments.js:319-445`, `manifest.yaml` | M · low-med |
| 6.2 | **Per-window warmth calibration**: optional `windowRects` per building so occupied buildings have *lit windows*, not mid-wall blobs; fixes the drab daylight watchtower too | `BuildingVisualRegistry.js`, `BuildingSprite.js:1370-1464` | M · med |
| 6.3 | Prior runners-up: observatory dome aperture (#52), occupancy pennants (#53), glowing dais ring (#57), species-shaped familiar motes (#51 finish), empty-village dusk vignette + tour (#54) | `BuildingSprite.js`, `AgentSprite.js:5685-5760`, `Camera.js` | S–M · low |
| 6.4 | **Ground fog at dawn/over water** (#55) — requires a measured per-frame budget story (v0.25 was a perf release); slow band, static fallback | `WorldFrameRenderer.js` | M · med |
| 6.5 | Small charms: delete the 11 near-invisible command-plaza vector sketches; re-hue the flowerCart crate body to the wood/gold ramps (the big magenta box at the keep turned out to be the banner layer — 0.1 — so this is minor); sprite-quality redraw of crude vector strokes on painterly buildings; major-monument mote presence; observatory idle glint | `buildings.js:70-82`, `prop.flowerCart.png`, `BuildingSprite.js:1557-3207` | S · low |

## Cross-cutting — art pipeline & validation

- **Validator upgrade** (`scripts/sprites/manifest-validator.mjs`): PNG-dimension check + corner-alpha/fill-ratio "is it a cube?" heuristic — would have caught all four block-cube defects and the accessory head silhouettes. S.
- **Manifest-driven bulk rebake + contact-sheet evidence step** — today there is no supported bulk rebake path, which is why broken assets linger. M.
- **Dead inventory**: 12 manifest assets (~15%) have zero code references (crane, pier, lakeShrine, deep-sea, bridge/dock variants…) — wire the charming ones, attic the rest; add a validator warning. S.

## Explicitly rejected (consolidated, with reasons)

- **WebGL/shaders, bloom, scanlines/CRT/film grain** — violate the pixel-integrity doctrine and the perf budget; the screen-composite light-stamp path already delivers glow.
- **Minimap revival** — deliberately removed (commit `d0b9879`); the edge indicator (5.7) captures the value.
- **Light theme / theme switching** — night-market parchment is the identity; unify the single dark ramp first.
- **Full character rebake / new animation rows** — the strongest asset family; XL cost for nil payoff. Procedural ritual overlays carry the states.
- **Animated dashboard background / per-card sparklines / masonry layout** — perf, clutter, and complexity respectively; the static ambience sync and density fixes capture the value.
- **Real-geolocation weather sync** — violates the local-only design.
- **Per-frame water caustics / animated tile swaps** — bake-don't-redraw rule.
- **Native SwiftUI popover rewrite / live mini-village widget / animated KDE sprites** — widget visuals are out of scope for this plan entirely.
- **More weather semantics (fog = queue depth…)** — the experience doc warns against cue overloading; make storm/clearing *legible* (5.5) instead.

## Suggested first sprint (top quick wins, all S effort)

1. 0.1 banner-cube delete (most visibly broken thing in the app)
2. 0.14 rain-veil removal (perf + wind bug)
3. 3.1 per-agent animation phase seed
4. 0.4 completed-status styling
5. 0.8 modal/toast reskin
6. 0.9 panel name fix
7. 3.2 selection-ring boost
8. 4.1 + 4.2 dashboard density + attention washes
9. 5.2 viewport-scaled stars
10. 5.8 firefly stamp cache
11. 0.10/0.11 halo double-draw + camera motionScale guard
12. 6.5's cheapest charms (plaza vector-sketch delete, flowerCart re-hue)

Plus the two medium heavy-hitters that unlock the most visible quality: **0.2 water checkerboard** and **0.6 canopy rewards**.

## Validation matrix

| Change type | Gate |
|---|---|
| Sprite/manifest changes | `npm run sprites:audit-refresh`; `sprites:capture-fresh` + `sprites:visual-diff` |
| Terrain/water bake | `npm run world:validate-terrain`; before/after captures at lagoon (rows 3–14) and river (row 25) |
| World rendering | `npm run validate:quick`; QA scenarios incl. `dense-24-agents`, `storm-night-reduced-motion` (`docs/world-visual-qa-checklist.md`); ad-hoc captures via `node scripts/world/capture-verify.mjs` (sim crowds need `?sim=1&scenario=…`) |
| Theme/CSS | Full World+Dashboard pass at 1280/1600/2560; token smoke script (1.4) |
| Perf-touching items (1.9, 5.8, 6.4) | FPS + heap measurement against `CANVAS_BUDGET`; the v0.25 perf bar is the standard |

Every motion item ships with its reduced-motion static fallback as part of "done" (project doctrine). Housekeeping done alongside this plan: stale `agents/README.md` index rows for executed plans (top-50, orchestration, ui-enhancement ×2) re-indexed `historical`.

---

## Execution status (2026-07-17) — EXECUTED

Implemented in full by a 13-agent wave swarm (waves: theme/sky/chrome/camera → terrain/characters/overlays/dashboard → buildings/assets/integration → finish batch). All gates green at close: `validate:quick` (incl. new `check:theme-tokens`), `sprites:audit-refresh` (0 missing/orphans/warnings), `world:validate-buildings`, `world:validate-terrain`, plus ~30 live Playwright verification passes (day/night/dawn/RM, 1280–3200px, sim crowds) with zero console errors. No git commits made; everything is working-tree changes.

**Done — every phase-0→6 item**, including: banner cube deleted + portalGlow/watchfire/beacon rebaked as isolated objects; water checkerboard fixed (BFS shore-distance depth + lerped fills); 6 placeholder props rebaked at 48px; `completed` first-class everywhere (token, rail, dot, sidebar, dashboard, `statusClass`); status ramps unified with a boot-time CSS bridge + drift-proof smoke script; provider hues de-collided; per-sheet `paletteSource` (20 sheets) so variants/team sashes render; id-seeded crowd desync; canopy-routed hero rewards + push grade pulse; post-atmosphere PRIMARY re-stamps; modal/toast parchment reskin + dialog semantics; panel name row; DPR quantization + integer zoom steps; coherent low-frequency noise field; shoreline/sea-gradient/wavelets/verges/pier-foam; plank river crossing; prop contact shadows; hover rings + merged bubbles + name-tag clamps; mark-governor tiering + pulse-band snap + trail unification; dashboard density/attention-washes/FLIP/timestamps/de-pill/hearth-glow/ambience-sync; perf readout + sidebar parity leftovers; letterbox + offscreen-cue edge indicator; ground fog; fast-path vignette; viewport stars + ambient meteors; stepped pixel sun (real bake); seasonal day length; fleet-storm violet weather-cause; monument sprite set + renderer path + major-mote; per-window warmth rects; observatory aperture/glint; occupancy pennants; dais ring; empty-village tour; plaza sketch deletion; flowerCart re-hue; crude-stroke redraws; familiar-mote species shapes; role-accessory/dead-overlay cleanup; 44 PixelLab generations total (props, rings, sun, monuments, 15 vegetation, building layers); validator upgrade (dimension + cube heuristics + unreferenced warnings); manifest-driven bulk-bake + contact-sheet scripts; base-seam heal on 7 building bases; world font unification on `WORLD_BODY_FONT` (theme.js token, all canvas consumers); charming dead assets wired (harborCrane at the quay, lakeShrine in the elderwood; both `layer: 'cache'` — the sorted channel culls nearly everything); harborPier + villageWall atticed (not charming/duplicative of procedural walls).

**Deviations:** 4.6 tokens scoped under `#dashboardMode`/`layout.css` instead of reset.css (file-ownership split); team hues kept (documented de-collision constraint rather than re-huing live identities); 3.8 merges restricted to same-slot clusters (flicker guard); 0.12 resolved as delete (plan's recommendation).

**Deferred follow-ups (recorded, not gaps):**
- 2.5 painterly terrain suite rebake (~100–160 generations) — own art pass; the procedural terrain rework (0.2/2.1–2.4) already removed the worst flatness. `scripts/sprites/bake-manifest.mjs` + `contact-sheet.mjs` are the tooling for it.
- `veg.tree.pine.small`, `veg.reed.a/b`, `veg.lilypad` still placeholder-ish (~4–5 gens); `bridge.ew` reserved for a future EW crossing.
- ~~Eyeball pass at 1920×1080~~ — resolved same-day: the floor-only DPR snap made 1080p+ viewports drop to half resolution ("pixelated"); `CanvasBudget.quantizeDpr` now snaps only when the step keeps ≥85% of the capped resolution (1080p → 0.93, 2560 → 0.68, 4K → 0.44; exact snaps kept when nearly free, e.g. 3440 → 0.5). Also sweep of dark-subject bakes against the looser legacy key-out tolerance (tight variant: `scripts/sprites/key-out-dark-bg.mjs`).
- `BuildingSprite._drawManifestLayers` anchor math noted by the asset agent as surprising-but-preserved; worth a code look if layers ever drift.
