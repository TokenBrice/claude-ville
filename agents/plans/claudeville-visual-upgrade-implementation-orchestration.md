# ClaudeVille Visual Upgrade — Orchestration Plan (All 50 Items)

Source plan: [`agents/claudeville-visual-upgrade-top-50.md`](../claudeville-visual-upgrade-top-50.md)

## 1. The model & the honest parallelism ceiling

This build runs on **one shared working tree** on a dedicated branch (`visual-upgrade-build`), not one git worktree per item. Items concentrate on a handful of hot files (`AgentSprite.js` touched by 16 items, `IsometricRenderer.js` by 15, `BuildingSprite.js`, `ParticleSystem.js`), so git isolation buys nothing real — merging 16 worktrees back into one `AgentSprite.js` is the same serialization problem deferred to the end. Safety comes instead from **file-disjoint waves**: a serial **foundation** lands the three contracts every later item depends on (#1 palette authority in `theme.js`, #2 mark-governor, #3 grade authority), then **dependency-ordered waves** run where *every item in a wave edits a provably disjoint set of files*, so N implementers edit concurrently with zero collision. After each wave a single **verifier** runs `node --check` on changed files plus the matching smoke check, confirms `git diff --name-only` stayed inside the wave's locked file set (catching any agent that strayed out of its lane), then **commits the wave** as one clean rollback point. Each tier boundary adds a `npm run validate:quick` checkpoint.

The honest ceiling is **23 waves, max parallel width 5** — not "50 agents at once." That is a direct consequence of hot-file concentration: any two items that both must edit `AgentSprite.js` or `IsometricRenderer.js` internals are serialized across different waves, no matter how independent their *features* are. There is no way around this without the optional decouple-core pre-pass (Section 5), which trades an upfront refactor for shorter critical path. Roughly 36 items are **core-logic** (they must edit hot-file internals, not just add a new file); the rest are clean (new file or CSS/leaf only). We chose to ship more, smaller, guaranteed-safe waves over fewer, riskier, conflict-prone ones.

## 2. Execution model & safety invariants

**Branch.** All work on `visual-upgrade-build`, cut from `main`. Never edit `main`. One commit per completed wave; tag tier boundaries.

**File-disjointness rule (the core invariant).** The wave schedule in Section 3 is the authority on which files each item owns *in that wave*. Within a single wave, no file appears in two items' owned sets. An implementer may edit **only** the files its brief lists. If an implementer discovers it genuinely needs a file owned by a sibling in the same wave (footprint was wrong), it must **STOP and report** rather than edit it — the verifier re-plans that pair into separate waves. This is non-negotiable: it is the only thing preventing silent overwrite between concurrent agents.

**Per-wave verify + commit gate.** After the wave's implementers report, one verifier runs, in order:
1. `git diff --name-only` — every changed path MUST be in the wave's locked file set. A stray path halts the wave (report which agent, which file).
2. `node --check <each changed .js>` — syntax must pass. Convenience for many files: `find claudeville/src -name '*.js' -print0 | xargs -0 -n1 node --check` (or just the changed subset).
3. **Runtime sanity** when any runtime file changed: `npm run dev`, then `curl -s http://localhost:4000/api/sessions` returns 200 + JSON and `curl -s http://localhost:4000/api/providers` succeeds; browser console clean on World + Dashboard load.
4. **Sprites** when `manifest.yaml` or any PNG changed (only #41): `npm run sprites:audit-refresh` (id audit + manifest validation); confirm `style.assetVersion` bumped.
5. **World config** when terrain/building config changed: `npm run world:validate-buildings` / `world:validate-terrain` (relevant to #25, #26, #41).
6. Commit the wave with a message listing the item numbers landed.

**Tier checkpoints.** At the end of Foundation, Tier 0, Tier 1, Tier 2, Tier 3: run `npm run validate:quick` (full non-runtime regression) and a manual World+Dashboard pass (resize ≥1280px, agent select/deselect, World↔Dashboard toggle). A tier does not "close" until this is green.

**Reduced-motion fallback is part of done.** Per `docs/motion-budget.md`: every motion-bearing item MUST check `motionScale` before allocating animation state/particles/timers, declare its pulse band (`slow`/`medium`/`fast`/`static` — at most **one medium pulse per entity**), use `PulsePolicy.js` `pulseValue`/`pulseAlpha`, and ship a static `motionScale === 0` fallback **in the same wave**. A motion item with no static fallback fails verify and does not commit. CSS motion items ship a `@media (prefers-reduced-motion)` static rule.

**Hard platform constraints (apply to every item).** No build step / bundler / framework; vanilla ES modules only. Canvas-2D only — no WebGL/shaders. `SpriteRenderer.js` is the sole blit path (`imageSmoothingEnabled=false`, integer-snapped coords); zoom clamped to integer {1,2,3}. Terrain is baked into a cache canvas — push new ground detail into the bake and fold it into `terrainCacheKey`, never per-frame (#25, #26, #41, #7-partial). Sprites are `manifest.yaml`-driven. Desktop-only ≥1280px, no `@media` width queries, English-only copy, port 4000. Respect `CANVAS_BUDGET` (25M renderer / 7M world / 1.25M light px); the #2 mark governor exists to keep the Tier 2/3 light+storm stack under that guard.

## 3. The wave schedule

23 waves. `[N]` = parallel width. Files listed are the union locked for that wave; within a wave each file belongs to exactly one item (per-item ownership in Section 4). Paths abbreviated: world-mode = `claudeville/src/presentation/character-mode/`, shared = `…/presentation/shared/`, dashboard = `…/presentation/dashboard-mode/`, config = `claudeville/src/config/`, css = `claudeville/css/`, domain = `claudeville/src/domain/services/`.

### Foundation (serial — every later item builds on these contracts)

| Wave | Width | Items | Files locked |
| --- | --- | --- | --- |
| F.1 | 1 | #1 | theme.js · VillageDirectorOverlay.js · AgentSprite.js · AgentPresentation.js · AvatarCanvas.js · HarborTraffic.js · CouncilRing.js |
| F.1b | 1 | #3 | VillageDirectorOverlay.js · CouncilRing.js · HarborTraffic.js · WorldFrameRenderer.js · AtmosphereState.js |
| F.2 | 1 | #2 | IsometricRenderer.js · AgentSprite.js · CouncilRing.js · VillageDirectorOverlay.js · **new** MarkGovernor.js |

> F.1 → F.1b → F.2 run strictly serial: #3 depends on #1; #2 re-edits #1's files. (#1 and #3 share four files, so they cannot be the same wave.) **Tier-checkpoint after F.2.**

### Tier 0 — foundations & quick wins

| Wave | Width | Items | Files locked |
| --- | --- | --- | --- |
| T0.1 | 4 | #4 #6 #7 #8 | IsometricRenderer.js · BuildingSprite.js · SceneryEngine.js · AgentSprite.js · SkyRenderer.js · VillageDirector.js |
| T0.2 | 1 | #5 | BuildingSprite.js · BuildingVisualRegistry.js |

> T0.2 follows T0.1 because #5 and #7 both edit `BuildingSprite.js`. **Tier-checkpoint after T0.2.**

### Tier 1 — high-impact core / legibility

| Wave | Width | Items | Files locked |
| --- | --- | --- | --- |
| T1.1 | 3 | #14 #18 #20 | BuildingSprite.js · AgentSprite.js · IsometricRenderer.js · HarborTraffic.js · ChronicleMonuments.js · ParticleSystem.js · DashboardRenderer.js · AvatarCanvas.js · dashboard.css |
| T1.2 | 3 | #10 #15 #17 | RitualConductor.js · AgentSprite.js · ParticleSystem.js · BuildingSprite.js · BuildingVisualRegistry.js · WorldFrameRenderer.js · IsometricRenderer.js |
| T1.3 | 2 | #11 #13 | BuildingSprite.js · WorldFrameRenderer.js · AgentSprite.js · ParticleSystem.js |
| T1.4 | 2 | #9 #12 | BuildingSprite.js · WorldFrameRenderer.js · AgentSprite.js · **new** ToolGlyphBadge.js |
| T1.5 | 1 | #19 | CrowdClusterOverlay.js · IsometricRenderer.js |
| T1.6 | 1 | #16 | IsometricRenderer.js |

> Sequencing within Tier 1 is dictated by `AgentSprite.js`/`BuildingSprite.js`/`IsometricRenderer.js`/`ParticleSystem.js` collisions: #14/#18/#20 → #10/#15/#17 → #11/#13 → #9/#12 → #19 → #16. #16 last because it needs #9, #14, #19. **Tier-checkpoint after T1.6.**

### Tier 2 — epic centerpieces

| Wave | Width | Items | Files locked |
| --- | --- | --- | --- |
| T2.1 | 3 | #21 #22 #27 | Camera.js · IsometricRenderer.js · VillageDirector.js · WorldFrameRenderer.js · WeatherRenderer.js · SkyRenderer.js · AgentSprite.js · CouncilRing.js · **new** CameraDirector.js |
| T2.2 | 3 | #23 #24 #28 | VillageDirectorOverlay.js · AgentSprite.js · IsometricRenderer.js · WorldFrameRenderer.js |
| T2.3 | 1 | #25 | IsometricRenderer.js |
| T2.4 | 1 | #26 | IsometricRenderer.js |

> #25 and #26 each solo-own `IsometricRenderer.js` and both touch the terrain bake + cache key, so they cannot share a wave with each other or with #21/#23. **Tier-checkpoint after T2.4.**

### Tier 3 — polish, charm & cohesion

| Wave | Width | Items | Files locked |
| --- | --- | --- | --- |
| T3.1 | 5 | #29 #31 #39 #40 #49 | AtmosphereState.js · AgentSelection.js · dashboard.css · sidebar.css · activity-panel.css · IsometricRenderer.js · SeasonalAmbience.js · AgentSprite.js · VillageDirector.js · VillageDirectorOverlay.js · BuildingSprite.js · ParticleSystem.js · TopBar.js · topbar.css |
| T3.2 | 5 | #30 #33 #41 #43 #46 | scenery.js · IsometricRenderer.js · AgentSprite.js · RitualConductor.js · manifest.yaml · DashboardRenderer.js · AgentPresentation.js · dashboard.css · BuildingSprite.js · ParticleSystem.js · AtmosphereState.js · ActivityPanel.js · AvatarCanvas.js · activity-panel.css · Sidebar.js · sidebar.css |
| T3.3 | 4 | #32 #45 #47 #48 | AgentSprite.js · ParticleSystem.js · ArrivalDeparture.js · ActivityPanel.js · VillageDirector.js · activity-panel.css · TopBar.js · topbar.css · dashboard.css · Camera.js · IsometricRenderer.js |
| T3.4 | 3 | #34 #44 #50 | AgentSprite.js · ParticleSystem.js · LandmarkActivity.js · DashboardRenderer.js · dashboard.css · Camera.js · IsometricRenderer.js |
| T3.5 | 2 | #35 #38 | HarborTraffic.js · IsometricRenderer.js · ParticleSystem.js · AgentSprite.js · CouncilRing.js · RelationshipState.js |
| T3.6 | 1 | #42 | AgentSprite.js · ParticleSystem.js · IsometricRenderer.js |
| T3.7 | 1 | #36 | AgentSprite.js · ParticleSystem.js |
| T3.8 | 1 | #37 | AgentSprite.js |

> Tier 3 is the long tail: `AgentSprite.js` appears in 11 of these items, so it threads single-owner through T3.1→T3.8. CSS-only and leaf items piggyback for width. #40 needs #21 (T2.1, satisfied). **Tier-checkpoint + final `validate:quick` after T3.8.**

## 4. Per-item build briefs

Format: **#N** [class] · *wave* · owned files (+new) · approach · prereqs.

- **#1** [core-logic] · F.1 · theme.js, VillageDirectorOverlay.js, AgentSprite.js, AgentPresentation.js, AvatarCanvas.js, HarborTraffic.js, CouncilRing.js · Expand `theme.js` with 9 building accents, `STATUS_VISUALS`, per-provider hues; replace every private RGB/hex table (`BUILDING_COLORS`, `INCIDENT_COLORS`, `MOOD_ACCENTS`, `PROVIDER_COLORS`, `MODEL_TIER_COLORS`, `PROVIDER_BADGES`, inline hex in AvatarCanvas/HarborTraffic) with `theme.js` imports; add the missing `chatting` token import in CouncilRing. · prereqs: none.
- **#2** [core-logic] · F.2 · IsometricRenderer.js, AgentSprite.js, CouncilRing.js, VillageDirectorOverlay.js + **new** MarkGovernor.js · Per-frame region-bucketed mark counter, per-tier alpha caps (PRIMARY=1.0, SECONDARY/AMBIENT capped); instantiate+reset in IsometricRenderer, pass governor into AgentSprite/CouncilRing/VillageDirectorOverlay draws; reduced-motion = static caps, no region culling. · prereqs: 1.
- **#3** [core-logic] · F.1b · VillageDirectorOverlay.js, CouncilRing.js, HarborTraffic.js, WorldFrameRenderer.js, AtmosphereState.js · Add `gradeColor(hex, grade)` lerp to AtmosphereState; thread `atmosphere.grade` through WorldFrameRenderer into halo/tether/arc draw sites; no new motion. · prereqs: 1.
- **#4** [core-logic] · T0.1 · AgentSprite.js · `_drawWaitingOnUserBeacon(ctx, contentTopY)` before focus pillar when `WAITING_ON_USER`; screen-composite vertical gradient pillar, `pulseAlpha('alert',…)`; static fixed-alpha at `motionScale===0`. · prereqs: 2.
- **#5** [core-logic] · T0.2 · BuildingSprite.js, BuildingVisualRegistry.js · In `_spawnEmittersFor`/`getLightSources` scale emitter chance + glow radius by `atmosphereState.lighting.beaconIntensity`; add per-building `beaconBase` to registry; reduced-motion = static 0.5. · prereqs: none.
- **#6** [clean] · T0.1 · SkyRenderer.js · Lower `_drawGodrays` warmth gate (0.18→~0.08); daytime branches: `git:pushed` → golden sky-flare, `subagent:completed` → sun-ray glint; all motion guarded by `motionScale>0`, static brightening fallback. · prereqs: none.
- **#7** [core-logic] · T0.1 · IsometricRenderer.js, BuildingSprite.js, SceneryEngine.js · Extend water-warmth pass with shore puddle overlays via `reactions.puddleAlpha`; flesh `_drawAtmosphereBuildingReactions` roof rim-light via `reactions.roofGlintAlpha`; expose wet-cobble shore subset in SceneryEngine; reads existing reactions snapshot. · prereqs: none.
- **#8** [clean] · T0.1 · VillageDirector.js · Ensure `getWeatherInfluence()` is read fresh per frame (already wired via WorldFrameRenderer); add the bucket-float guard before `terrainCacheKey` inside `_weatherInfluence()` if missing. No other files. · prereqs: none.
- **#9** [core-logic] · T1.4 · AgentSprite.js + **new** ToolGlyphBadge.js · Replace `_drawCompactNameStatus` pill with `_drawToolGlyphBadge` blitting a ~9×9 illuminated glyph colored by status; pill kept only for selected/zoom≥1.5. · prereqs: 1, 2.
- **#10** [core-logic] · T1.2 · IsometricRenderer.js · Extend `drawBuildingLightReflections` to collect `BuildingSprite.getLightSources()`, project onto adjacent water, blit wavering screen-composite gradient columns scaled by `reactions.nightReflection`/`buildingGlowScale`; static columns under reduced-motion. · prereqs: 5, 7.
- **#11** [core-logic] · T1.3 · BuildingSprite.js, WorldFrameRenderer.js · Extend `_drawForgeHeatBloom` with a ground-level warm radial when `_forgeGlow` high and night; register cobble-apron pool as `'spark'` in `getLightSources`; reduced-motion = steady non-flickering fill. · prereqs: none.
- **#12** [core-logic] · T1.4 · BuildingSprite.js, WorldFrameRenderer.js · Extend `_drawArchiveEnhancement` with a doorway lamplight cone (screen composite) when `_archiveReadIntensity>0.4` + `archiveMote` dust; register doorway spill as `'spark'` light; reduced-motion = static shaft, no motes. · prereqs: none.
- **#13** [core-logic] · T1.3 · AgentSprite.js, ParticleSystem.js · Expand `_moodPostureCue()` (distressed head-drop, tired slump, proud lift) into bob; spawn `fretMote`/`sparkle` on cadence when `motionScale>0`; add `fretMote` preset; reduced-motion = posture offset only. · prereqs: none.
- **#14** [core-logic] · T1.1 · BuildingSprite.js, AgentSprite.js, IsometricRenderer.js · Accumulate per-building status counts in `_updateVisitorCounts` → `_visitorStatusByType`; `_drawStatusTallyChip` above building label; suppress name/overlay slots for building-occupant agents at `zoom<1.5` in `_assignAgentOverlaySlots`. · prereqs: 1, 2.
- **#15** [core-logic] · T1.2 · RitualConductor.js, AgentSprite.js, ParticleSystem.js · Expand `RITUAL_POSE_BY_BUILDING` to all 9 buildings; add pose branches in `_drawToolRitualOverlay`; one-shot downbeat particle per gesture peak; respect `MAX_CONCURRENT_RITUALS=6`; reduced-motion = static posed frame. · prereqs: none.
- **#16** [core-logic] · T1.6 · IsometricRenderer.js · Replace stub `_agentLabelAlpha(sprite, zoom)` with real impl reading `_crowdStats.congestedAgents` + zoom + cluster membership; lerp toward 0 at zoom 1 (dense) / 1 at zoom 3. AgentSprite already applies `labelAlpha`. · prereqs: 9, 14, 19.
- **#17** [core-logic] · T1.2 · BuildingSprite.js, BuildingVisualRegistry.js, WorldFrameRenderer.js · `_drawWatchtowerSearchlight(ctx, beacon, pulse, fleetHealthRatio)` after `_drawWatchtowerFire`; rotation+amber→red by fleet health; registry anchor; register beam as `'beam'` light routed via `_drawLighthouseBeam`; slow/variable band; reduced-motion = static wedge. · prereqs: 8.
- **#18** [clean] · T1.1 · HarborTraffic.js, ChronicleMonuments.js, ParticleSystem.js · In `_drawRepoAnchorage`: phase-offset bob via `frame`/`motionScale`, torch particle when `lively`, grey droop tint on `failed>0`, `_repoFirstSeen` Map → `maiden` christening event on ChronicleMonuments; static buoy at `motionScale===0`. · prereqs: 1, 3.
- **#19** [clean] · T1.5 · CrowdClusterOverlay.js, IsometricRenderer.js · Add `includeStatusCounts:true` to `summarizeCrowdClusterEntries` call; rewrite `drawCrowdClusterBadges` as a heraldic standard (total + up to 3 status pips via STATUS_AURA). Static. · prereqs: 9, 14, 16.
- **#20** [clean] · T1.1 · DashboardRenderer.js, AvatarCanvas.js, dashboard.css · Replace inline card bg/border with THEME tokens + parchment-panel class; dashboard.css warm-dark field, gilt borders, STATUS_VISUALS left rails; AvatarCanvas minor container tweak. No motion. · prereqs: 1.
- **#21** [core-logic] · T2.1 · Camera.js, IsometricRenderer.js, VillageDirector.js, WorldFrameRenderer.js + **new** CameraDirector.js · Named-glide state machine (cubic-ease, `_userAdjusted` guard, **abort-on-input mandatory**); Camera `glideToWorld(box,dur)`+`abort()`; renderer wires `update(dt)`; VillageDirector emits `harbor:release`/`incident:cluster`/`agent:arrival`; WorldFrameRenderer vignette/worldTint grade pass keyed to active glide. · prereqs: none (foundation for #24/#40/#46).
- **#22** [core-logic] · T2.1 · WeatherRenderer.js, SkyRenderer.js · Procedural jagged-polyline bolt in `_drawStormFlash` (midpoint displacement, 2–3 branches); 2–3 drifting rain-curtain passes in `_drawRain` gated by storm+intensity>0.7 + `weatherLegibilityGate`; SkyRenderer overcast zenith tint via `_paintStaticWeatherPlate`; reduced-motion = static overcast, no bolt. · prereqs: 8.
- **#23** [core-logic] · T2.2 · IsometricRenderer.js · `_drawSurfWashBands` over `scenery.getShoreTiles()`, 2–3 staggered foam arcs per shore tile (PulsePolicy slow band), crest by `reactions.stormRoughness`; hook after water, before sprites; static single line under reduced-motion. · prereqs: 8.
- **#24** [clean] · T2.2 · WorldFrameRenderer.js · `_drawCloudShadows(ctx, atmosphere)` after `_drawTerrain`: 2–3 feathered `multiply` ellipses (~12% alpha) advancing with `windX*perfNow*slowRate` at fractional parallax, count/size from `sky.cloudLayers`; static positions at `motionScale=0`. · prereqs: none.
- **#25** [core-logic] · T2.3 · IsometricRenderer.js · Extend `_drawDistantSeaHorizon` with 3–4 staggered radial fog bands lerping toward `sky.palette.horizon` by fogIntensity; `_bakePerimeterCliffShelf` in `_drawStaticTerrainSurface` (sand/cliff face along iso perimeter); add `'edge'` token to terrain cache key. · prereqs: none.
- **#26** [core-logic] · T2.4 · IsometricRenderer.js · In `_drawStaticTerrainSurface` append a top→bottom cool-lighter `multiply` linear wash (~8% at tileY=0 → 0 at MAP_SIZE) in world coords; add `'atmo-persp'` token to terrain cache key (line ~3636). No per-frame cost. · prereqs: none.
- **#27** [core-logic] · T2.1 · AgentSprite.js, CouncilRing.js · In `_drawChatEffect` replace ellipsis with a parchment-scroll shape holding the `toolCategory()` glyph via `ToolIdentity`; in `drawTalkArcs` add a travelling mote along the Bezier (`t=(now%period)/period`), skipped at `motionScale===0`. · prereqs: 9.
- **#28** [core-logic] · T2.2 · VillageDirectorOverlay.js, AgentSprite.js · `drawHandoffs()`: transient parent→child offset (read, don't mutate, sprite x/y) at arc 0–0.4, glowing scroll mote along arc, terminal spark at ~1 (reuse ArrivalDeparture's `drawSubagentCompletionCue`); AgentSprite `setHandoffAck(bool)` → 180ms child bob; reduced-motion = static arc+dot. · prereqs: none.
- **#29** [clean] · T3.1 · AtmosphereState.js · Extend `blendPalette()` to lerp zenith→`#3d3050`, horizon→`#8a8b5c` by `cloudCover*stormBias` under storm/rain; `buildGrade()` shifts `worldTint`→`rgba(60,45,80,0.28)`; flows through SkyRenderer + worldTint consumers automatically. · prereqs: none.
- **#30** [clean] · T3.2 · DashboardRenderer.js, AgentPresentation.js, dashboard.css · `buildingClassForAgent()` helper using RitualConductor's tool→category map; `_createCard()` sets `--cv-building` + 14px emblem glyph; dashboard.css `.dash-card[data-building]` radial wash + glyph rules. · prereqs: 1.
- **#31** [clean] · T3.1 · AgentSelection.js, dashboard.css, sidebar.css, activity-panel.css · Emit `--cv-selected-accent` on `body` on selection change; `.dash-card--selected` halo, `.sidebar__agent--selected` left-rail glow, panel-header top accent bar; `@media (prefers-reduced-motion)` static halo. · prereqs: 1.
- **#32** [core-logic] · T3.3 · AgentSprite.js, ParticleSystem.js, ArrivalDeparture.js · `_drawArrival()` ~300ms scale-up + portal-rune ring + dust-puff burst; departure dissolve via `_departureProgress` (set by renderer on `agent:removed`) fading globalAlpha + Y-shift in `draw()`; reduced-motion = instant appear/fade. · prereqs: none.
- **#33** [core-logic] · T3.2 · BuildingSprite.js, ParticleSystem.js, AtmosphereState.js · Enrich `smoke` preset with `windX` drift; scale forge/mine/harbor smoke rate/density/colour by `_forgeGlow`, `PRESENCE_TIER_TABLE`, `windX` (read from existing `atmosphereState.weather.windX`); reduced-motion = single static wisp. · prereqs: none.
- **#34** [core-logic] · T3.4 · AgentSprite.js, ParticleSystem.js, LandmarkActivity.js · In WORKING branch compute vector toward `_lastBuildingType` center, spawn `archiveMote`/`beaconMote` at token-burn rate (delta from `_observeTokens`); add directed drift velocity to presets; reduced-motion = no motes. · prereqs: 2.
- **#35** [core-logic] · T3.5 · HarborTraffic.js, IsometricRenderer.js, ParticleSystem.js · `enumerateWakeDescriptors` emits `bowRipple` (V ahead of bow) + `sinkRing` on force-push sinks; `_drawHarborWakeWaterDescriptors` renders diverging arcs by `wakeScale` + widening foam ellipse; white-foam particle burst on sink; static stern dab fallback. · prereqs: none.
- **#36** [core-logic] · T3.7 · AgentSprite.js, ParticleSystem.js · Replace `_drawContextPressureRing` ellipse with a thin radial arc 0→ratio amber→red; percentage chip for selected agent; sweat-drop particles + tremble X-offset in `_drawGrounding` at ratio≥0.85; reduced-motion = static arc+chip. · prereqs: none.
- **#37** [core-logic] · T3.8 · AgentSprite.js · In `_drawGrounding()` replace offset-ellipse shadow with a skewed 4-point parallelogram, offset `(cos(sunAngle)*9*sunLength, sin(sunAngle)*3.5*sunLength)`, width by `shadowRadiusX`; pooling via `globalCompositeOperation='multiply'`; reduced-motion = current fixed angle. · prereqs: none.
- **#38** [core-logic] · T3.5 · AgentSprite.js, CouncilRing.js, RelationshipState.js · `_rebuildChatPairs` detects 2–3 IDLE agents within ~30px of a scenic point → `gossipClusters` in snapshot; AgentSprite rotates to centroid + `chatting=true` w/ dispersal timer; `drawTalkArcs` 3-way triangle + topic-glyph bubbles; reduced-motion = face-each-other only. · prereqs: none.
- **#39** [core-logic] · T3.1 · IsometricRenderer.js, SeasonalAmbience.js · `_drawLandBirds` flutter-pause state machine (perch hold 1–3s); gull dive→climb arc in `_openSeaGullPositions`/`_drawGullSprite`; `harbor:push-success` subscriber → gull scatter (raise `GULL_MAX_ACTIVE_TARGET`); suppress decorative motion during live git events (`suppressDuringEvents` in SeasonalAmbience.update); static perched fallback. · prereqs: none.
- **#40** [core-logic] · T3.1 · AgentSprite.js, VillageDirector.js, VillageDirectorOverlay.js, BuildingSprite.js, ParticleSystem.js · VillageDirector emits `distress:watchtower` for errored agents; AgentSprite `_distressRoute` overrides target to watchtower + head-down gait; overlay draws red incident ring + relief spark on recovery; BuildingSprite intensifies watchtower beam during distress; add `distressRelief` preset; reduced-motion = static tableau. · prereqs: 21.
- **#41** [core-logic] · T3.2 · scenery.js, IsometricRenderer.js, AgentSprite.js, RitualConductor.js, manifest.yaml · Add authored `DISTRICT_PROPS` (rope-coil/open-book/mossy-bench keyed to `AMBIENT_SCENIC_POINTS`) with `layer:'cache'` folding into `_buildDistrictPropSprites` bake; manifest entries + `assetVersion` bump; `SCENIC_POINT_POSTURE` table in RitualConductor; no per-frame cost. · prereqs: none.
- **#42** [core-logic] · T3.6 · AgentSprite.js, ParticleSystem.js, IsometricRenderer.js · Add `getTileType` constructor callback wired at sprite construction (~line 2159) to a new `_surfaceMaterialAt(tx,ty)` helper (existing tile Sets); `_advanceWalkAnimation` dispatches by tile class; add `cobbleScuff`/`grassMote`/`shallowSplash` presets. · prereqs: none.
- **#43** [clean] · T3.2 · Sidebar.js, sidebar.css · `_buildAgentRow()` working-status class for dot breathe, working-caret spinner span, `--cv-repo-color` via `RepoColor.js` on left border; sidebar.css `@keyframes sidebar-dot-breathe` + spinner + prefers-reduced-motion static. · prereqs: none.
- **#44** [clean] · T3.4 · DashboardRenderer.js, dashboard.css · `_updateSectionHeader()` sets `--cv-health-bar-pct`/`--cv-health-color`; `_createSection()` adds 2px health-bar div; errored-card flash via `classList.add`+`setTimeout`; dashboard.css bar + flash keyframe + reduced-motion static. · prereqs: none.
- **#45** [core-logic] · T3.3 · Camera.js, IsometricRenderer.js · `frameContent()` (~line 1715): `_establishingShot` flag on first paint → `fitToWorldBox(fullIsland,{maxZoom:1})` then cubic-ease `glideToWorldBox(targetBox, 2.8s)` lerping zoom+pos, clearing `_userAdjusted` only for the move; reduced-motion = direct `fitToWorldBox`. · prereqs: none.
- **#46** [clean] · T3.2 · ActivityPanel.js, AvatarCanvas.js, activity-panel.css · 96×96 AvatarCanvas in panel header (created on open, destroyed on close); effort-aura color + status class on wrapper; AvatarCanvas `draw(size)` branch for 96px integer scale; CSS hero-portrait + hero-aura. · prereqs: none.
- **#47** [clean] · T3.3 · ActivityPanel.js, VillageDirector.js, activity-panel.css · Extend `_onVillageDirector` to accumulate a bounded ring-buffer `_directorFeed` (kind/label/ts); `_renderDirectorFeed()` scrolling narrative ribbon in chronicle section with kind-colored ticks + `formatRelative()`; scoped CSS. No motion. · prereqs: none.
- **#48** [clean] · T3.3 · TopBar.js, topbar.css, dashboard.css · `_setConnection(false)` adds body `cv-offline`; reconnect removes + one-shot gold-sweep class; topbar.css `.topbar--offline` desaturation + sweep keyframes; dashboard.css `.cv-offline .dash-card` muted + shimmer; reduced-motion = instant swap. · prereqs: none.
- **#49** [clean] · T3.1 · TopBar.js, topbar.css · `render()` computes status-mix ratio (working/errored) → `--cv-rail-hue`/`--cv-rail-alpha` on topbar; topbar.css animated `background-position` strip on `::before` (bottom 2px); reduced-motion = static gradient. · prereqs: none.
- **#50** [core-logic] · T3.4 · Camera.js, IsometricRenderer.js · Camera `_idleDrift`: track `_lastInputAt` in `_onMouseDown`/`_onWheel`; `update(dt)` after ~45s idle (and no active pan) adds sub-pixel Lissajous offset (~8 world-px); cancelled by any input setting `_userAdjusted=true`; renderer passes `renderNow` to `update()`; reduced-motion = skip entirely (`motionScale===0` guard). · prereqs: none.

## 5. Critical path & accelerators

**Bottleneck files.** `AgentSprite.js` (16 items) and `IsometricRenderer.js` (15) form the critical path; `BuildingSprite.js` and `ParticleSystem.js` are secondary chokepoints. They are why parallel width caps at 5 and why Tier 1 and Tier 3 stretch across 6 and 8 waves respectively — most of those waves are width-1 or width-2 *because the wide item is an AgentSprite/IsometricRenderer edit that nobody else can touch that wave*.

**Optional accelerator — the "decouple-core" pre-pass.** Before Tier 1, run a single refactor wave that converts per-feature draw calls inside `AgentSprite.js` and `IsometricRenderer.js` into a registry of `DrawablePass` adapters (each pass = a small object with `collect()`/`draw(ctx, governor)` consulted by the frame loop). Items that today must edit hot-file *internals* — e.g. #4 beacon pillar, #13 mood motes, #23 surf bands, #36 pressure ring, #39 birds, #42 footfall — would instead register a **new pass file**, becoming new-file-only and therefore freely parallelizable. This could collapse Tier 1's 6 waves and Tier 3's 8 waves toward ~3–4 each, plausibly cutting total waves from 23 to the mid-teens. **Trade-off:** the pre-pass is itself a serial, high-risk edit to the two most load-bearing files, and it must land *after* #2 (the governor signature the passes consume) but *before* any feature wave. Recommend it only if wall-clock matters more than the ~1-wave refactor risk; otherwise the 23-wave plan is the safe default. Do not attempt it speculatively — it violates "simplicity first" unless the parallelism payoff is explicitly wanted.

## 6. Risks & rollback

**Straying edits (top risk).** The whole safety model rests on agents touching only owned files. Mitigation: the verifier's `git diff --name-only` gate is mandatory and runs *before* `node --check`; any path outside the wave's locked set halts the wave and names the offending agent. Implementer prompts state the owned-file list verbatim and the "STOP and report, do not edit a sibling's file" rule.

**Core-logic items needing careful sequencing (must edit hot-file internals).** #1, #2, #3 (foundation contracts — everything depends on their signatures), #4, #7, #9, #10, #11, #12, #13, #14, #15, #16, #17, #21, #22, #23, #25, #26, #27, #28, #32, #33, #34, #35, #36, #37, #38, #39, #40, #41, #42, #45, #50. These are already serialized by the wave schedule; the live hazard is a signature drift in #2's `MarkGovernor` or #3's `gradeColor`/#21's `CameraDirector` that a later wave assumed — verify those three contracts at their tier checkpoints and freeze them.

**Uncertain footprints needing a look before their wave: none.** Every referenced file was confirmed present at the expected path during planning (theme.js, MarkGovernor/ToolGlyphBadge/CameraDirector are confirmed *new*, ToolIdentity.js confirmed at `domain/services/`, CrowdClusters.js confirmed). The two footprints to spot-check at wave start anyway, because they assume existing behavior rather than adding it: **#8** (claims `getWeatherInfluence()` is already wired per-frame via WorldFrameRenderer — confirm before declaring it a one-line guard) and **#16/#19** (assume `summarizeCrowdClusterEntries`/`_crowdStats.congestedAgents` already exist in CrowdClusters.js — verify the flag/field names before editing).

**Rollback.** Commit-per-wave gives a clean checkpoint after every wave. A failed wave (stray edit, `node --check` failure, server won't boot, broken World/Dashboard) **halts the run**: the in-progress wave is reverted to the previous wave's commit (`git reset` to the last wave tag — only with explicit approval per repo Git Hygiene), the footprint is corrected, the wave is re-planned (often by splitting a width-N wave into N width-1 waves), and the run resumes. No partial wave is ever committed; the tree is always at a verified state between waves.

## 7. How to run it

A runnable Workflow script accompanies this plan. It takes args to **gate by tier** (`--tier=foundation|0|1|2|3`, default: run all in order) and to **resume by wave** (`--from=T1.3`), so a halted run restarts at the failed wave without re-running committed ones (per the Subagent & Fleet Economy rule: resume cached runs, don't re-run).

Each wave executes as: **fan out parallel implementers** (one subagent per item in the wave, each prompted with only its owned-file list, its one-line approach, its pulse band, its reduced-motion fallback requirement, and a report cap of "under 60 words, no file dumps") → **barrier** (wait for all implementers in the wave) → **single verifier agent** runs the Section 2 gate (diff-name-only lane check → `node --check` → runtime curl/console when runtime files changed → `sprites:audit-refresh` when manifest/PNG touched → `world:validate-*` when terrain/building config touched) and, on green, commits the wave; on red, halts and reports. Tier-boundary waves additionally run `npm run validate:quick` and a manual World+Dashboard pass before the next tier is allowed to start. Mechanical/CSS-only items may run on a cheaper model; reserve the top model for the foundation contracts (#1/#2/#3), the camera (#21), and every verifier pass.
