# World Mode Renderer

World mode is the resident WebGL2 isometric view that ClaudeVille shows by default, with Canvas 2D fallback. This directory owns the render loop, sprites, camera, and particles. It reads from the domain `World` and listens to the event bus; it never mutates domain state.

The directory is named `character-mode/` for historical reasons. In prose, the user-facing surface is "World mode" (paired with "Dashboard mode" under `../dashboard-mode/`).

## File ownership

| File | Responsibility |
| --- | --- |
| `IsometricRenderer.js` | Render loop (`requestAnimationFrame`), terrain bake orchestration (`_terrainBakeKey`, registered bake passes, `invalidateTerrainBake()`), hit testing, click and hover handlers, event-bus subscriptions, selection plumbing, the name-admission pass (`_assignAgentOverlaySlots`), and the `world:first-frame` signal. |
| `WorldFrameRenderer.js` | One frame in order: backdrop, terrain, ground records, depth pass, GPU or Canvas grade, then the ungraded upper overlay (see draw order below). |
| `Camera.js` | Pan, zoom, projections, follow, and the tier ladder: nominal tiers `{1, 2, 3}` plus a survey tier (`SURVEY_TIER`, one backing pixel per world texel) only when the backing DPR is 2 or more. Owns glides (`glideToWorld`/`glideToPose` with a `motion` family and tier floors), the establishing shot (`establishingShot`), the follow composition window, and `resumeViewPose` for the World→Dashboard→World return. `DEFAULT_FRAME_TIER` is 3. |
| `CameraCurves.js` | Pure motion vocabulary for the camera: wheel/director/ambient curve families, log-space zoom, the glide duration formula, `planGlide`/`sampleGlide` (pan at a resting tier plus a zoom step of `ZOOM_STEP_MS` = 450 ms for every resting rung crossed, never shortened; the total is lengthened so every glide stays at least 75 % pixel-exact, and `restingLeadMs` lets a hold already spent at a resting tier count toward that share), and `criticalSpringStep` for the follow window. |
| `CameraDirector.js` | Automatic, cue, attention, and Ambient camera ownership. Automatic moves never rest above tier 1 (`AUTO_MAX_TIER`); the Ambient wide shot and the empty-village tour's first stop use the survey tier. |
| `CanvasBudget.js` | Effective DPR selection and backing-store guardrails for large desktop canvases. |
| `AgentSprite.js` | Per-agent sprite state: tile position, smoothed motion, hit testing against the laid-out body box (`_bodyBox` plus a 3 px pad), chat animation toward a target sprite, the turn-sand age text, wait-reason hand props, and C2 action-strip pose resolution with procedural-overlay fallback for characters without a strip. Bodies draw at integer 1:1 on whole world texels in the Canvas path, the GPU record, and the x-ray. Paints the T2 selected/hovered name plate and the T4 text-only routine name, the gold selection chevron, the low-zoom impostor stamp, and hosts the work downbeat. |
| `AgentGroundMarks.js` | Cached pixel ground stamps for villagers: one two-course contact shadow per body (with the golden-hour trail from `RakingLight`), 1-texel rings only for selected, hovered, waiting-on-user, errored, and rate-limited agents, and the selection chevron. Both backends paint the same canvases. `groundMarkDepth()` reports how far a body's marks reach below its feet so identity labels sit clear of them. |
| `AgentGpuOverlayRenderer.js` | Upper-overlay replay of per-agent marks for the resident WebGL path. Skips a body that `DrawablePass` sorted behind a building (`_behindBuilding`) unless it is selected. |
| `AgentBehaviorState.js` | Per-agent behavior and destination state used by movement/visit systems. |
| `VisitIntentManager.js`, `VisitTileAllocator.js` | Building capacity, visit reservations, and destination assignment. |
| `BuildingSprite.js` | Current building visuals, sprite blits, hover state, building-specific decoration/effects, occlusion split for hero buildings, and `hitTest` in world coordinates. Draws the T3 carved walnut plaques with an exact count folded in (`FORGE │ 8`): `_plaqueCountsByType` counts every live body once — at the building it is folded into, at its route target while it walks through another footprint, or at its assigned building — so the number means routed, queued, or inside, and the plaques of a dense scene sum to its agent count. A plaque whose building is in view is moved wholly inside the visible canvas; one whose building is off-frame is hidden. Building-face chits show only for the selected or hovered building or at zoom ≥ 3 (`_chitsVisible`), and instrument plates, ledgers and chits give way where they would cover a body, an identity label, or a T1 plate (`_rectHitsSignalOrBody`). Functional marks follow the pixel grammar (stepped pixel discs, `ringDots`, scanline courses, no anti-aliased ellipses or gradients) and take the C2 grade on the ungraded overlay through `gradeTone`; Command's hall panes light only at night while someone works inside. Also draws the C4 inspection aperture (Command's authored sectional interior with identity tokens and exact overflow), the occupied-room window slots, the Forge workload billets and result shelf, the Mine assay bench, and the `READY_EMPTY` banked rest state. |
| `TaskboardBoardModel.js` | Pure selected/pinned agent resolution plus phase-aware TodoWrite grouping, truthful full-list progress layouts for the inset slate chalk face at every zoom level (rows that do not fit collapse into one exact `+N more · +M phases` line, or `+(N+M) more` when that does not fit), and project-coloured plan tabs with `done/total` and an exact `+N plans` overflow. `BuildingSprite._paintTaskboardChalk` draws the chalk once onto whole device pixels, each glyph upright and stepped down the 2:1 slate slope by whole pixels, with 18 px rows (30 px for the doubled zoom-3 type) and a faint rule under each: 2 rows at zoom 1, 5 at zoom 2, 4 at zoom 3. Chalk is clipped to the slate shape of the current `base.png` (`TASKBOARD_SLATE`); headers and phase rows shorten their words but never their counts (`Wr… · 3/24`). Plan tabs use screen-fixed type, hang off the slate's left edge (registry `planTabs.at`), stack downward, and show only at zoom ≥ 3 or while the taskboard is hovered or selected. |
| `BuildingVisualRegistry.js` | Data-driven building visual profiles for labels, sprites, lights, emitter and chimney (`smokeTop`) anchors, overlays, split-pass rules, interior/aperture layer sets, window rects, optional workload benches, and taskboard plan-tab anchors. Registry anchors replace the old hard-coded building coordinates (Archive, Forge, Mine, Command). |
| `BuildingApertureModel.js` | Pure C4 aperture model and stable room-slot allocator. Presents assigned/visiting sessions as seats with tool labels and an exact overflow count — never the sprite's physical position — and only for selection at zoom ≥ `APERTURE_MIN_ZOOM` (2). |
| `NightOccupancyGate.js` | Pure night-window phase, live working-status, and reduced-motion-aware transition policy shared by Canvas and GPU building light paths. Building window light follows this gate; authored lit-window sidecars (`emissiveSidecar: true`) exist for Command, Observatory, Archive, Forge, Mine, Task board, Harbor, and the Lighthouse (`building.watchtower`). |
| `AssetManager.js` | Loads `manifest.yaml` and `palettes.yaml`, maps manifest IDs to PNG paths, cache-busts with `style.assetVersion`, and supplies placeholder/checker fallbacks. Material companions and deterministic atlases are opt-in and never use the checker fallback. Optional C2 action strips load lazily per resident model through the character demand path and never widen the base sheet. |
| `MaterialRegistry.js` | Stable material classes, authored upper-left key-light convention, safe channel defaults, companion-path rules, and semantic material normalization. |
| `SpriteRenderer.js` | Single entry point for PNG sprite blits; keeps pixel-art draws snapped and smoothing disabled. Also builds additive sprite-quad records and can draw optional companion channels for debugging. |
| `SpriteSheet.js` | Character sheet frame lookup and 8-direction velocity mapping. Character sheets are 8 columns × 10 rows of 92px cells. Optional per-character action strips resolve named groups (`read`) to strip cells via `resolveActionFrame` or return `null` so the procedural overlay stays in charge. |
| `Compositor.js` | Palette-swap and accessory overlay composition. Provider and team colour recolours only a sheet's declared `paletteSource.trim`; robes keep their authored colours. Bakes the shared 1-texel warm rim (`bakeSpriteOutline`) into the world body sheet and builds the 0.5× majority-vote crowd LOD sheet (`halfScaleSheet`). |
| `TerrainTileset.js` | Reads the land Wang sheets as luminance texture sources (`readTerrainCellLuma`) sampled in true 2:1 orientation by the ground bake; cells are no longer stamped per tile. |
| `GroundBake.js` | The land surface as one bake (terrain pass `ground-splat`): class field with organic edges, Wang luminance re-toned onto the C1 ground ramps, macro value/warmth drift, contact AO, worn door thresholds, district yard materials, and sparse decals. Cached per season/scenery/coast revision; publishes `renderer.groundField`. |
| `CoastBake.js` | The continuous coast field (`getCoastField`, signed distance to shore), the baked water ramp (wet sand, dithered foam lace, five depth stops), the land-only stratified cliff, baked landmark reflections, the outer ocean (`drawOuterOcean`), and night/storm water mood (`waterMoodFor`: a shader uniform on WebGL, a mood-recoloured copy on Canvas; a grade night weight below 0.15 is day water, so dawn and early evening keep the day sea). The sea horizon (`OCEAN_HORIZON_WORLD_Y`) sits four tiles above the island's north vertex, and the ocean fills every visible pixel below it at any zoom or pan: one quarter-resolution horizon band tiled sideways (lightening only with distance to the horizon, rebaked only when the quantized palette or fog changes), a sparse glitter column under the sun or moon, and one flat fill of the deepest stop below the band. The outer shelf and back beach continue past all four map edges on value-noise contours. |
| `SceneryEngine.js` | Water, shore, bridges, vegetation, boulders, and walkability data. Trees grow in clumps of 3–7 with species by biome (willow only within one tile of water); the shore distance treats the map edge as sea. |
| `FoliageRenderer.js` | Tree drawing at 1× from at most six cached sprite canvases; wind sway keyed per species. |
| `Pathfinder.js` | Grid pathfinding over the walkability map. |
| `AtmosphereState.js`, `SkyRenderer.js`, `WeatherRenderer.js` | Time/weather snapshots (including the memoized C2 `lightGrade` and the `sourceEnergyEnvelope` bucket), the stepped and dithered sky plate graded from the same evaluator (the sun and moon are held above the sea horizon, and stars, glare, moon and god rays are clipped to the sky), and foreground weather: pixel rain on the art grid, world-anchored splashes on open ground, stepped storm curtains, snow. |
| `GradeEvaluator.js` | Contract C2: the pure `evaluateGrade` over eight daily keyframes plus weather rows and the moon, `applyGradeToRgb` for CPU tints, and `lampCourseAt` for blue-hour sequencing. Night is moonlit, not grey: albedo keeps about 40 % of its colour (saturation 0.42, deep night 0.38) and the moonlight rides the split tone (indigo shadows, faint blue-green highlights), so grass stays green, stone reads slate-blue and water blue. The tested rule is night exposure below 0.8× noon, night saturation 0.5–0.85× noon, and night bluer than noon. Each key carries its own `rake` (cast length), and `GRADE_AMBIENT_FLOOR` keeps storm nights one course above black. Consumed by the resident scene shader, the hybrid PostFx pass, the Canvas fallback, the sky, the backdrop, water mood, fauna tint, and chimney smoke. |
| `CanvasGrade.js` | Canvas-fallback half of the grade: desaturation and lift fills, the cached multiply overlay, stepped colour-dodge pool stamps, and `ungradeRgb` (the preimage of a graded colour). |
| `BackdropGrade.js` | Grades the 2D backdrop (sky plate and outer ocean) like the island: vignette courses and aerial haze over the backdrop on WebGL, and the stepped screen-Y haze on Canvas. |
| `CloudShadowCourses.js` | Canvas parity for world-locked cloud shadows: three dithered courses from the same baked noise tile the resident composite samples. |
| `RakingLight.js` | Golden-hour and sunrise casts derived from the grade (`rakeForGrade`, `castLightingFor`): stepped building, tree, and villager cast stamps baked once per sun bucket and blitted by both backends. |
| `GroundCueRecords.js` | The resident path's live ground cues as native GPU records on the art-pixel grid, sampling one shared cue atlas that uploads only when a new colour appears. |
| `LightSourceRegistry.js` | Shared light-source records consumed by world grading and effects. |
| `HarborTraffic.js` | Harbor/ship motion and git-event-aware harbor activity, plus the failed-push broken bracket (one per repo, on the docked ship's hull, or on one of four jetty slip posts on the Harbor deck when no ship is docked). Glows, wakes, flares, rings and the whirlpool are stepped pixel discs, `ellipseArcDots` and `dottedCurve`s; the docked wake is static. The small flag and pennant decals still use anti-aliased path fills. |
| `BridgeLanterns.js` | Age-ordered pending-branch lantern plan, plank drawables, hover copy, and night light sources. |
| `LandmarkActivity.js` | Harbor/landmark event extraction and activity state updates tied to git-event streams. Its activity chits are snapped world-texel items (billet, note, sealed letter, handoff crate) on the ground one tile in front of the building's entrance, never on a face, tinted by C2, gated like building chits, and labelled `VERB · file.js` from `ToolIdentity.toolVerbLabel` (just the verb when that does not fit); a chit that would cover a body, a name, or a T1 plate steps up a row, then gives way. Chat and dispatch connections are dotted curves with a 3×3 terminal, drawn only while one endpoint is selected; dispatch lines start at the Command entrance. Owns the Mine assay bench's rolling 60 s token-class ledger (exact counts, provenance-aware cost window, `insufficient coverage` on resets) and the Forge workload state (`N edit calls · last 60s`, banked after a long idle). |
| `AgentEventStream.js` | Shared observer that derives tool, subagent, team, and chat semantic events from `agent:*` updates, and emits one `tool:result` per newly observed provider result record (the adapters' bounded `lastResults`). |
| `RelationshipState.js` | Debounced relationship snapshot for parent/child, team, arrival/departure, and chat-pair consumers. Reduces server-detected working-set overlaps (`agent.collisions`) to one peer edge plus exact per-building counts for the shared-file knot. |
| `ArrivalDeparture.js`, `TrailRenderer.js` | Relationship arrival/departure cues and movement trails. A top-level arrival plays the violet column at the gate (the body stays hidden and unnamed until the cream frame), then walks in; the cream peak frame is a 1-texel rim of the body, not a filled silhouette. Dispatch and merge fly as a comet whose head is the child's own idle crop; a dispatched child lands on a free tile 2–3.25 tiles from its parent (a building visit tile in that band first, else a walkable ring at 2.5, 2, then 3 tiles), reserves that tile, and moves off it if another body walked onto the spot during the flight. Returns are stone, never gold. Completions fold onto the parent as one stone miniature with an exact child count and one static receive beat. At most six arrivals play at once. |
| `EffectStamps.js` | Contract C4 effect kit: `fillRect`-only world-space stamps (`column`, `ringDots`, `comet`, `crown`, `crownSeal`, `bracket`, `diamond`, `chips`, `streak`, `runeNotch`), the pixel-grammar helpers every overlay uses instead of anti-aliased arcs and gradients (`fillPixelEllipse`, `ellipseArcDots`, `dottedCurve`, `pixelLine`, `fillConvex`, and `gradeTone`, which applies the C2 grade to an overlay colour), the `defineMoment`/`momentPhase` timing envelope, and the shared ledger (one Major moment at a time, success held back while a failure stands, Harbor gull suppression). |
| `Chronicler.js`, `ChronicleEvents.js`, `ChronicleMonuments.js` | Chronicle event capture and monument rendering, a selected monument's low stone ledger (last three real milestones, exact `+N recorded`), and the release crown above the Harbor plaque (one at a time; further releases add to its count). |
| `CouncilRing.js` | Team/council ring visuals around related agents, plus the gather roll call: on a real `team:gather` one notch lands at each gathered member's feet on the council cue's successive bells (`shared/audio/CueScore`), and a static `team · N` mark states the whole membership on the final one. One ceremony at a time, held 8s, drawn in the upper overlay; reduced motion and a silent village draw every mark at once. Talk arcs are dotted curves with a 2×2 mote stepped through 12 positions. |
| `CrowdClusterOverlay.js` | Crowd ground auras (a pixel pool with a `ringDots` rim) and the T5 `+N` tab, which counts exactly the members not already named. Known gap: a cluster hidden behind a building still gets a tab. |
| `AttentionPlates.js` | T1: one screen-fixed attention plate plus an 8×8 motif beacon per waiting-on-user, errored, or rate-limited agent, drawn from live status at full strength; plates stack without overlap, agents of the same kind group when their plates collide or their beacons are within 96 px, and a plate whose leader would exceed 24 px joins its nearest neighbour, so group plates of two or more carry the exact count while every member keeps its beacon. Kinds never mix, so a group's word is true of every member; plates of different kinds step apart. Agents outside the view get an edge plate with an outward arrow instead of being clamped onto the frame, and same-kind edge plates on one side merge when their anchors lie within 25 % of the edge length. Wait ages come from `SignalLedger.waitAnchor()`, so the plates and the sidebar agree on who is oldest. |
| `WorldLabelKit.js` | Contract C5 label materials in whole screen pixels: label ink, the carved walnut board (T3 plaques, T5 tabs), T2/T4 name geometry shared by painter and admission (`identityLabelTop(zoom, markDepth)` places the label below the body's own ground marks plus 2 px), outlined motifs, and text fitting. |
| `ToolGlyphBadge.js` | Tool/status glyphs drawn from the authored `shared/EventShapes.js` 8×8 motifs, never anti-aliased strokes. |
| `PulsePolicy.js` | Shared pulse-priority parser and defaults. |
| `ObservationCertainty.js` | Pure resolver turning provider freshness/`signalStale`/residency into `{ state, observedAt, ageMs }`. Stale observation suppresses new ritual motion and earns the last-observed seal; it never becomes an execution status. |
| `AttentionFraming.js` | Pure world-space fit for the `A` attention frame: ranks the complete action-needed set by real `awaitingSince` (unknown ages sort last), tries centered zooms 3→2→1 with a one-third bias only when nothing is excluded, and returns the exact excluded ids when no complete fit exists. |
| `SharedFileKnot.js` | The shared-file knot: at most one angular ground thread (suppressed under annotation pressure; dense load keeps the counts and drops the lines), a double-pencil knot for two writers, and one upper-overlay plate with exact counts. Static band; copy says `recent shared file` unless concurrency was actually observed. |
| `SpatialWorkScore.js` | The spatial work score: reduces the shared causal waterfall to at most 24 nodes placed at semantic building anchors (physical positions only where real replay samples exist), long-interval brackets for approvals, and gaps for unknown time. Publishes `work-score:request`/`work-score:state`; scrubbing reads a frozen row copy and never mutates domain state. |
| `DebugOverlay.js` | Shift-D debug overlay for renderer diagnostics; Shift-P pathfinding overlay (planned-path breadcrumbs and glowing destination tiles). Both off by default. |
| `RitualConductor.js` | Capped, reduced-motion-aware scheduler for tool ritual visuals: building rituals plus per-agent reading/typing/thinking pose records consumed by `AgentSprite`, and `ritualDownbeat`, which strikes a C4 Minor beat on the first beat of a playing ritual and every third after. |
| `WorkDownbeats.js` | Draws the work downbeat at each gesture's strike point (ember slashes, chips, a page flick, or a glint) with `fillRect` on integer texels, admitted at the mark governor's WORKING tier. |
| `ParticleSystem.js` | Particle emitters and ambient effects. Presets in `AIR_PARTICLE_PRESETS` (smoke, torch, buoy torch, forge embers, seasonal drift) ride the open-air layer that the resident path replays on the overlay; ground-level presets stay in the Canvas frame until GPU particle records exist. Honors `prefers-reduced-motion`. |
| `ChimneySmoke.js` | Chimney smoke only from registry `smokeTop`/`chimney` anchors and only while the building is occupied or busy; wind leans the column, rain flattens it, and after dark the puffs take a moonlit tone from the grade. |
| `AmbientGround.js` | Static per-host classification of where overlay-drawn ground life may land (rain splashes, fireflies): open walkable ground not covered by opaque building pixels. |
| `WildlifeRenderer.js`, `SeasonalAmbience.js` | Fauna and seasonal drift. Gulls fly in ten lanes (at most ten aloft, visible caps 8/5/3 by zoom, roosting in storms, only the lighthouse gull at night); fauna frames are tinted by the grade from cached canvases; fireflies (warm months, dusk and night, clear air, near water, at most 12 and only at zoom ≥ 3) draw on the ungraded overlay on both backends; seasonal drift spawns in world space at zoom ≥ 2. |
| `gpu/GpuWorldPolicy.js`, `gpu/GpuWorldRenderer.js`, `gpu/GpuSceneBuilder.js` | The resident WebGL2 world: `EFFECT_BUDGET` receipts and the quality ladder, `GRADE_GLSL` (C2 grade before the light loop, multiplicative stepped pools after it: 2:1 ground ellipses whose overlapping courses take the brightest rather than adding; attention lights use the same stepped courses at small radii and never spend a wet-reflection slot, `u_wetMask`), water as flat depth stops with sparse 2:1 ripple dashes (one 3×1 dash per 8×4 world-px cell, 6×3 in a storm, lit on one palette-cycle phase in four, brightening only, frozen under reduced motion), world-locked cloud courses and screen-Y aerial haze in the composite, and the scene records (terrain, ground casts, cue records, bodies, buildings). |
| `postfx/PostFx.js` | WebGL2 post-processing stage for the hybrid path: samples the finished 2D scene as a texture and applies the C2 grade, stepped light pools (`applyPools`, 2:1 ellipses), light glows, bloom, water displacement, god rays, heat haze, incident pulses, and grain. Displacement and grain are evaluated per art-pixel cell (`u_artOrigin`, `artCell()`), so they move whole art pixels. Owns context loss, timings, and diagnostics. |
| `postfx/PostFxLadder.js` | Pure hysteretic degradation ladder (FULL → REDUCED → MINIMAL → DISABLED). It sheds optional effects only; the direct GPU world holds a minimal resident scene at DISABLED so Canvas-only water/fauna layers cannot flicker through during recovery. Unit-tested in `scripts/tests/postfx-ladder.test.mjs`. |
| `postfx/PostFxFeed.js` | Allocation-light per-frame uniform feed: screen-space light list, quarter-res water mask (camera-pose cached, revision-counted), sun anchor, haze anchors, incident pulse envelope, motion state. |

## Data sources and draw order

World mode is driven by four source layers:

- Domain state from `World` (`agents` and `buildings`).
- Static config from `src/config/constants.js`, `buildings.js`, `townPlan.js`, `scenery.js`, and `theme.js`.
- Sprite metadata from `claudeville/assets/sprites/manifest.yaml` and `palettes.yaml`.
- Runtime provider state already normalized into `Agent` objects, including `gitEvents` for harbor activity.

The frame (`WorldFrameRenderer.renderWorldFrame`) draws in broad layers:

1. Backdrop on the 2D canvas: the stepped sky plate and the outer ocean (horizon band, sun/moon glitter, deep fill, reaching every edge of the view), painted in final C2 colours on WebGL (where `BackdropGrade` lays the scene's vignette courses and aerial haze over them) and in their preimage (`ungradeRgb`) on Canvas, whose frame grade then lands them on the same colours.
2. The terrain cache: the `ground-splat` bake, then the `coast` stage (baked water ramp, foam lace, land-only cliff, landmark reflections), bridges, foundations, and flat features. It carries no time of day.
3. Ground records: live ground cues, building and tree casts, and villager contact shadows and rings.
4. The depth-sorted pass: props, building bases and occlusion-aware hero pieces, agents, landmark activity, and building fronts. On the resident path the overlay-safe scene categories (landmark activity, Harbor traffic, wildlife) are skipped here and drawn once on the overlay. A body whose feet fall between a split building's back and front depths, behind its footprint, sorts before the back half so the whole building hides it.
5. The grade: on WebGL the scene pass grades each albedo fragment with C2 before the light loop, adds the stepped multiplicative pools and authored emission after it, and the composite applies world-locked cloud courses and screen-Y aerial haze; the Canvas fallback reproduces the same grade with composite fills (`CanvasGrade`).
6. The ungraded upper overlay, in order: weather foreground; open-air particles, reduced-motion chimney wisps, and functional building marks (WebGL only); talk arcs; crowd `+N` tabs; arrival, comet, crown, and bracket moments; Director overlays (ground rings only for the selected building and incidents, as static 1-texel pixel outlines; no team, lifecycle, or per-building signal halos); overlay-safe scene categories on WebGL, or fireflies on Canvas; the selection chevron re-strike; per-agent overlays and names; the selected x-ray; the shared-file plate; T3 plaques (which treat the lower-third caption strip as occupied); screen particles; the Harbor summary; the work score; offscreen cue edges; the glide grade and letterbox; T1 attention plates; the lower-third caption; debug.

World mode renders through a three-canvas stack inside `#characterMode`: `#worldCanvas` (the 2D scene, source of truth and mouse target), `#worldFxCanvas` (WebGL2 output, hidden whenever inactive), and `#worldOverlayCanvas` (2D UI: weather foreground, marks, labels, moments, screen particles, letterbox, debug — never graded or distorted). The canvases stay at opacity 0 until the renderer emits `world:first-frame`, then fade in (360 ms on boot, 220 ms back from Dashboard, no fade under reduced motion) over a stepped CSS sky painted from the live sky palette. Grading ownership is exclusive: when a GPU stage is active the 2D grade and pool stamps are skipped and the GPU grades from the same C2 `lightGrade`; when inactive (`?postfx=0`, no WebGL2, context loss, or ladder level 3) the Canvas fallback grades the finished frame itself. Shift-D shows post-FX level and timings. Resident WebGL replays only functional building marks and occupancy pennants on the upper Canvas in drawable depth order; authored manifest layers and atmospheric building reactions remain owned by the GPU path.

Ground semantic cues (Director routes/replay/halos, relationship rings/tethers, crowd auras, and short selected/action routes) share one set of ground painters. Canvas paints them all into the frame. The resident path splits them by how they change: cues that follow an agent or pulse (incidents, council rings, tethers, trails, the hovered or selected building's routes, the shared-file knot) are recorded each frame by `GroundCueRecorder` as native ground records on the art-pixel grid, so moving agents move records and never re-upload texels; tile-anchored crowd auras and transient or text-bearing washes (recoveries, the parade, replay, the work score) stay in one retained Canvas texture drawn at scale 1 or exactly 0.5 (`semanticGroundScale`) that re-renders only when their quantized state changes, plus an 8 Hz tick while a transient animates. Buildings and bodies occlude both. Talk arcs, counts, handoffs, lifecycle annotations, and selected x-ray silhouettes draw once on the upper Canvas in all backends.

Canvas, GPU, and camera hit projections share backing-pixel-snapped translation while logical pan and zoom stay continuous. Every world sprite draws at an integer multiple of the world texel (contract C3): villagers and trees at 1×, effects and glyphs on the art-pixel grid. The known exceptions are the Harbor ships, which `HarborTraffic` still scales by 0.64–0.90, and `prop.flowerCart` (manifest display size 0.5×). Under crowd pressure ordinary GPU bodies sample the baked 0.5× crowd LOD sheet at world scale 1 and skip the 1:1-sized stance and ritual gestures; selected, hovered, waiting, errored, and rate-limited agents keep full silhouettes. Labels follow the C5 tiers: T1 attention plates always, T2 plates for the selected and hovered agents, T3 district plaques, T4 routine names only at zoom ≥ 1.6 for the top three (six at zoom 3) most recent actors per 200 px screen region, dropped rather than offset on overlap, and the T5 `+N` tab for the unnamed rest of a dense group. An agent whose arrival is pending stays unnamed. T2 and T4 labels sit below the body's ground marks; a T4 name that would cross another body is dropped; a T2 plate is shifted wholly inside the canvas while any part of its body is visible and dropped when the body is entirely off-canvas (the T1 edge plate still names it). A body hidden behind a building draws no name, action marks, or bubbles unless it is selected, when it keeps the x-ray and its plate. The signature clasp shows only at zoom ≥ 3 or on the selected body. Automatic establishing and idle focus moves never rest above tier 1; explicit detail zoom remains available, and selection through the Sidebar, Dashboard, or keyboard agent cycling reveals an individual immediately.

Foliage draws oak, pine, and willow sprites at 1× from at most six cached canvases; their baked plinths were stripped offline (`scripts/sprites/foliage-pass.mjs`), and trees stand in clumps rather than a sprinkle. The material pilot uses exact palette overrides only for Terra, Sonnet, and Command; albedo and emission stay unchanged. Command's re-authored sidecars classify fire, glass, timber, crimson cloth, metal, and stone from reviewed colours, never from brightness. This is a small authored pilot, not a roster rollout.

Agent atlas slots normally refresh at 125 ms. A measured fast-turn sequence exposed a stale selected Codex body while attachments advanced; selected, hovered, action-needed, direction-changing, and tool-changing slots now refresh immediately. Other dirty animation slots retain the ambient cadence. GPU surface animation and foliage consume the public `motionTimeMs` visual clock. Existing zero-height character geometry masks remain flat; the renderer now honors their authored value instead of manufacturing anatomical height from a default floor.

When adding a visual feature, place it in the lowest layer that still communicates the state. Avoid adding per-frame work when it can be cached into terrain or static scenery.

## Depth drawable contract

World mode overlap rendering goes through `DrawablePass.js`. New overlap-aware visual systems should adapt their items to this shape before entering the shared sorted pass:

```js
{
  kind: '<stable-category>',
  sortY: <finite-world-y>,
  sortBand: <optional-order-band>,
  stableKey: '<optional-deterministic-key>',
  salience: 'primary' | 'recent' | 'working' | 'ambient',
  materialId: '<stable-material-source>',
  materialClass: '<known-class>',
  elevation: { base: 0, top: 0, unit: 'sprite-px' },
  emissive: { strength: 0, sources: [] },
  occluder: { mode: 'alpha-silhouette', strength: 1 },
  atlasFrame: null,
  drawFallback(ctx, zoom, context) {},
  buildGpuRecord(context) {},
  hitArea: null, // optional future hit-test metadata
  payload: <source-object>
}
```

`kind` should be stable enough for diagnostics and narrow special cases such as the selected-agent x-ray pass. Ordering is `sortY`, then `sortBand`, then `kind`, then `stableKey`, then insertion sequence. `createDepthDrawable()` assigns default bands for building backs, props, harbor traffic, agents, landmark activity, chronicle visuals, familiar motes, and building fronts; set `sortBand` only when a new category needs deterministic interleaving. Normalize missing or non-finite `sortY` before sorting. The legacy `draw()` property remains an alias of `drawFallback()`, so Canvas output is unchanged. `buildGpuRecordsFromDrawables()` converts the already-sorted stream and adds `drawOrder`; consumers may batch only consecutive compatible records. Avoid adding new manual draw switches in `WorldFrameRenderer.js` when an adapter in `DrawablePass.js` can preserve the existing behavior. Use `cullDepthSortedDrawables()` for large drawable sets that can be skipped outside the camera viewport.

Static props (`StaticPropSprite` in `StaticPropDrawables.js`: trees, boulders, district props, walls, the Village Gate) sort at their footprint world Y unless they pass an explicit finite `sortY`. A tall prop may `splitForOcclusion` into back and front halves so a villager can stand between them. A prop that is long along one tile axis cannot use one depth: the ends of the 9-tile gatehouse sit about 140 world px apart. Such a prop passes `occlusionColumns` from `lineOcclusionColumns()` instead. These are vertical slices of one cached image (16 px wide for the gate), and each slice sorts at the wall line's Y under its centre, so anything north of the wall paints first and anything south paints after. Both backends cut the slices with `columnSourceSpan()`. A column prop always draws from its cache, so a drawn-state change such as the gate doors must call `invalidateCache()`.

Material metadata is optional. Missing values normalize to unlit albedo, zero emissive contribution, a flat alpha-silhouette occluder, and no atlas frame. See [`../../../../docs/material-channel-contract.md`](../../../../docs/material-channel-contract.md) for manifest fields, stable material indices, atlas frame tags, channel encoding, and tooling.

`WorldFrameRenderer.js` still reaches into renderer private helpers for terrain, atmosphere, debug, labels, and post-processing. Treat that as a follow-up for layer extraction, not a reason to broaden a drawable-only change.

## Selection lifecycle

```
canvas click (IsometricRenderer._onClick)
  → camera.screenToWorld(x, y)
  → IsometricRenderer._handleClick(worldX, worldY)
      hit-test agentSprites
      ├── hit  → sprite.selected = true
      │         camera.followAgent(sprite)
      │         onAgentSelect(agent) → App.js emits 'agent:selected'
      │
      └── miss → camera.stopFollow()
                 onAgentSelect(null)
                 App.js does not emit 'agent:deselected' for this path,
                 so the ActivityPanel stays open until its close button
                 or the selected agent is removed.

eventBus 'agent:selected' (also emitted from Sidebar / DashboardRenderer)
  → App.js _bindAgentFollow → renderer.selectAgentById(agent.id)
  → ActivityPanel.show(agent), starts 2s detail polling

ActivityPanel close button or eventBus 'agent:removed' for current agent
  → ActivityPanel.hide() → eventBus.emit('agent:deselected')
  → App.js → renderer.selectAgentById(null) → camera.stopFollow()
```

`onAgentSelect` is wired in `App.js` after the renderer is created. The renderer keeps a single `selectedAgent` reference; clearing it deselects every sprite and stops camera follow.

## Map constants

From `src/config/constants.js`:

| Constant | Value | Used by |
| --- | --- | --- |
| `TILE_WIDTH` | `64` | iso projection in `Camera.js`, every tile draw. |
| `TILE_HEIGHT` | `32` | iso projection (half of width — standard 2:1 iso). |
| `MAP_SIZE` | `40` | square tile grid; terrain seed is `MAP_SIZE * MAP_SIZE`. |

The grid is `40 × 40` tiles. World-space origin is `(0, 0)` at the top corner of the diamond; tile `(x, y)` projects to screen `((x − y) · 32, (x + y) · 16)` before camera offset and zoom.

## Event-bus integration

`IsometricRenderer.show()` subscribes to domain events and stashes the unsubscribe functions in `_unsubscribers` for teardown:

| Event | Effect on the renderer |
| --- | --- |
| `agent:added` | `_addAgentSprite(agent)` creates an `AgentSprite` and inserts it into `agentSprites`. |
| `agent:removed` | Drops the entry from `agentSprites`. |
| `agent:updated` | Replaces `sprite.agent` so the sprite reads the latest status, tool, model. |

Selection events (`agent:selected`, `agent:deselected`) are bridged in `App.js`, not subscribed here directly. The renderer exposes `selectAgentById(id)` for that bridge to call.

`mode:changed` is consumed by `IsometricRenderer` to call `setWorldModeActive(mode !== 'dashboard')`. When Dashboard mode is active, the World render loop stops and volatile renderer caches are released; when World mode becomes active again, dirty sprite state is reconciled and the loop restarts. Browser visibility and canvas context loss/restoration also pause, resume, and rebuild canvas-owned caches. `App.js` captures the camera pose on the switch to Dashboard and restores it with `camera.resumeViewPose` on return instead of re-framing.

The renderer emits `world:first-frame` (`{ reason, sky }`) once per activation after it has actually presented a frame (`armFirstFrameSignal` / `_signalFirstFrame`); `App.js` reveals the world canvases on it. There is no timer fallback, so a renderer that never draws keeps the world hidden rather than revealing a black canvas.

`VillageDirector` emits `village:director`, `village:building-signal`, `village:scene`, and `village:replay` as read-only presentation signals. Canvas overlays use the snapshot for huddles, handoffs, incidents, replay trails, release parades, building hover previews, and selected-building route lines; DOM surfaces such as Activity Panel may consume the same events defensively. A sub-agent return (`subagent:completed`) queues a neutral lower-third caption under a `RETURNED` eyebrow (`Review → Prime`, stone accent, no success wording); returns and biography banners never fire the gold release camera cue, the narrative-feed parade entry, or parade arcs, and `AgentBiographyService` does not count a sub-agent's removal as a completed session.

Deterministic QA scenarios for these states are available at `?sim=1&scenario=<id>`; the most relevant Director fixtures are `waiting-on-user`, `quota-rate-limit`, `failed-push`, `release-parade`, and `building-inspection-replay`.

## Operator controls and cross-surface contracts

Four explicit controls own the frontier instruments. None is on a timer, and each leaves the default frame exactly as it found it:

- **READ (hold `B` or the top-bar button)** — while held, occupied-building plaques show work verbs translated from the canonical tool classifier (`FORGE` reads `WRITING · 8`), non-primary agents show their verb instead of routine names, and releasing restores names without changing selection (`IsometricRenderer.setReadMode`, `BuildingSprite.READ_VERBS`).
- **`A` attention frame** — frames the complete action-needed set ranked by real `awaitingSince` through `AttentionFraming.fitAttentionFrame`; when geometry cannot include everyone, the overlay states the exact excluded count instead of silently omitting agents, and each agent outside the view keeps an edge attention plate. Entering focus also quiets the room: ordinary speech rectangles and duplicate routine names yield while the chosen agent's body, name, reason, and every unresolved primary mark stay.
- **AMBIENT CAM** — the only way into Ambient ownership (C6): a wide shot of the active districts at the survey tier (tier 1 when the backing DPR is below 2), patient lateral glides on the ambient curve family to the busiest real work cohort, an earned incident chapter, and a return to the wide, with factual lower-third captions (`Forge · 4 working`) and 20–30 s holds. Any genuine input revokes the claim, the control enters its distinct resume state and waits to be asked again, and nothing re-arms on a timer; Auto's timers are untouched. Reduced motion holds one static overview with the same counts.
- **SCORE (Activity Panel)** — draws the selected run's last 20 minutes as the spatial work score with a scrub cursor and one playback pass over the kept span; reduced motion keeps the static diagram and never allocates the playback timer.

Camera behaviour the operator sees (`Camera.js`, `CameraCurves.js`):

- **Opening.** Boot fades in from the sky at the survey tier (tier 1 at DPR 1), holds 1600 ms, then dollies for at least 2400 ms (`OPENING_DOLLY_MS`, lengthened when the ladder has more rungs to cross) to the content at `DEFAULT_FRAME_TIER` (3, falling back to 2, then 1, for boxes that do not fit), stepping through the tiers so the move stays at least 75 % pixel-exact. Scenarios with a camera pose play the opening and settle on that pose unless their metadata sets `camera.opening: false`; `setCameraPose` cancels any glide in flight, so capture tools are never overwritten. Reduced motion cuts.
- **Glides and wheel.** The wheel is a 150 ms easeOutCubic tier step in log space. Director moves (cues, attention, re-frames, returns) use easeInOutCubic and Ambient/tour moves easeInOutSine, with duration `clamp(600 + 0.55·screenPx + 350·|log2 z1/z0|, 700, 2400)` ms (Ambient ×2.2, capped at 5 s). A glide that pans and zooms pans at a resting tier and zooms in steps of 450 ms per resting rung crossed, never squeezed; the whole glide is lengthened to at least four times its zoom time so it stays at least 75 % pixel-exact (`F` from tier 3 now takes about 3.6 s). Zooming in pans first, zooming out steps first; a pure tier change is one zoom step. `F` frames the content and uses the survey tier when the box spans at least 60 % of the island.
- **Follow.** A followed villager rides a 28 % × 22 % composition window aimed 6 % above it, on a critically damped spring (ω = 3.5/s back to the window edge, idle relax ω = 1.2/s) that also matches walking speed; the entry move is 500 ms and settles at tier 3. A follow that starts before the first presented frame snaps into place.

The frontier plan's cross-item contracts live at these owners: **C1** observation certainty (`ObservationCertainty.js`, consumed by `AgentSprite`, the C4 aperture, and panel copy), **C2** action strips (manifest `actionStrip` entries, resolved by `SpriteSheet`/`AgentSprite` with procedural fallback), **C3** effect budget receipts (`gpu/GpuWorldPolicy.js` `EFFECT_BUDGET`; key order is the shedding order and Shift-D prints what was shed), **C4** the inspection aperture (`BuildingApertureModel.js` + `BuildingSprite`), **C5** the shape grammar (`shared/EventShapes.js`), and **C6** Ambient camera ownership (`CameraDirector.setAmbient` plus `camera:owner` events).

The aesthetic plan ([`claudeville-opus55-aesthetic-plan.md`](../../../../agents/plans/claudeville-opus55-aesthetic-plan.md)) numbers its own contracts C1–C5; they are distinct from the frontier set above:

- **C1 master palette and value ladder** — `src/config/artPalette.js` (`ART_RAMPS`, `GROUND_RAMP_KEYS`, `PENNANT_PALETTE`, `EFFECT_COLORS`, the Tier A–D value budget). Status hues stay in `theme.js`; only unresolved status marks, the selected-agent ring, and authored emission at dusk/night may be Tier A. `npm run art:analyze` (`scripts/sprites/art-analyze.mjs`) is the advisory offline check: colour count, semi-alpha edges, Tier-A misuse, off-ramp terrain pixels, the pooled ground saturation band, and non-integer display scales. It always exits 0.
- **C2 one grade evaluator** — `GradeEvaluator.evaluateGrade`, memoized per atmosphere snapshot as `atmosphere.lightGrade`. The grade reads only the clock, the weather, the moon, and the season, never agent state.
- **C3 one pixel grid** — integer multiples of the world texel for bodies, trees, buildings, effects, and ground cues; the retained ground texture at scale 1 or 0.5; glides at least 75 % pixel-exact (`CameraCurves`). New per-frame cost is baked, substitutes for an existing cost, or carries an `EFFECT_BUDGET` receipt.
- **C4 effect language** — `EffectStamps.js`: shape says the family, colour says the outcome, timing says the weight (anticipation → one cream frame → four-step follow-through → optional static residue; Minor ≤ 400 ms, Medium ≤ 1.2 s plus residue, Major ≤ 2.5 s with one active). Success gold is for verified success only; sub-agent returns are stone.
- **C5 type grid and label hierarchy** — Press Start 2P at 8/16 px and Departure Mono at 11/22 px (`WORLD_DISPLAY_FONT_8/16`, `WORLD_BODY_FONT_11/22` in `theme.js`), no bold, no world-scaled text; tiers T1–T5 through `AttentionPlates.js` and `WorldLabelKit.js`.

## Adding a building

1. Add an entry to `BUILDING_DEFS` in `claudeville/src/config/buildings.js`. Copy a neighboring entry for the validated field shape:

   ```js
   {
     type: '<id>',
     x: <tileX>,
     y: <tileY>,
     width: <w>,
     height: <h>,
     label: '<UPPER CASE>',
     shortLabel: '<SHORT>',
     icon: '<glyph>',
     description: '<short>',
     district: '<district>',
     capacity: { work: <n>, ambient: <n>, overflow: <n> },
     visualTier: 'hero' | 'major' | 'minor',
     labelPriority: 'landmark' | 'standard' | 'low',
     entrance: { tileX: <tileX>, tileY: <tileY> },
     visitTiles: [workSlot(...), queueSlot(...), scenicSlot(...)],
     walkExclusion: [{ dx: <n>, dy: <n>, width: <n>, height: <n> }],
   }
   ```

   The local `workSlot`, `queueSlot`, and `scenicSlot` helpers create the visit-tile metadata expected by movement and occupancy systems. Tile coordinates must keep the footprint `(x..x+width-1, y..y+height-1)`, entrance, visit tiles, and walk exclusions within `0..MAP_SIZE-1` and not overlap water or another building footprint.

2. Add or reuse a `BuildingVisualRegistry.js` profile for label treatment, sprite IDs, decoration, emitters, lights, overlay anchors, and split-pass behavior. Keep procedural fallbacks in `BuildingSprite.js` narrow.

3. (Optional) If the building needs hover/click behavior beyond the default tooltip, subscribe in `IsometricRenderer.js` near the existing `_onMouseMoveMain` / `_onClick` handlers, or extend `BuildingSprite.hitTest`.

4. Run `npm run world:validate-buildings` and `npm run world:validate-terrain`, then reload the page. There is no build step; `App.js` adds buildings from `BUILDING_DEFS` on every boot.

Future building visual cleanup should expand the existing `BuildingVisualRegistry.js` coverage before adding custom procedural drawing. Good candidates are label accents/emblems, light sources, emitter specs, overlay anchors, and split-pass rules. Keep custom renderers behind named functions so adding a building usually changes config data rather than several distant `type` branches.

## Performance baselines and trail policy

Renderer comparisons use the manifest and runbook in [`../../../../docs/rendering-baselines.md`](../../../../docs/rendering-baselines.md). The matrix records WebGL, flattened PostFX, and allocation-free Canvas outputs from the same deterministic scene declaration, along with hardware, frame, upload/shader, resource-byte, and overlay-census evidence.

Persisted movement history is retained for diagnostics and replay but routine historical trails are not painted over the village. The selected agent and action-needed agents may draw only a short, bounded recent route. `TrailRenderer.getDiagnostics()` reports the active policy, confirms zero ambient cache ownership, and retains stationary/manual-pan/follow/director-glide timing buckets. Run `npm run world:benchmark-trails` after changing trails or camera invalidation.

Shift-D reports PostFX source upload, mask upload, setup CPU, shader CPU/GPU, ladder decision/degradation reason, named GPU resource bytes, mask rebuild causes, and trail camera-mode timing. On the resident GPU world it additionally prints the active quality level and reason, the C3 shed list (`shed (reason): id mode, …` from `EFFECT_BUDGET`, whose key order is the shedding order), per-pass GPU/CPU timings for `upload`, `occlusion`, `scene`, `bloom`, and `present` once `renderer.gpuWorld.setPassSamplingEnabled(true)` starts the one-pass-every-12-frames rotation (`EXT_disjoint_timer_query_webgl2`; disjoint samples discarded, unavailable never printed as zero), and pinned versus evictable texture bytes with the live body-atlas size. Only one backend's block is printed at a time so the inactive pipeline's zeroes cannot sit beside the active one's timings.

For World presentation changes, run `npm run verify:render` to capture deterministic screenshots and console evidence, then review the changed behavior on the operator-maintained server. Browser judgment remains manual; evidence capture does not.

## Frame and update notes

Astra carries Worldsplitter, her signature halberd, at every effort level. Effort reads through her distinct high-tier crests (the former effort floor rings and auras were removed with the other vector foot marks). Her armor and violet cape belong to the authored body and read strip; the halberd is composed separately through `AstraWeaponPose.js` with per-frame wrist coordinates. Read poses suppress equipment while both hands hold the book. Keep body, wrist profile, gauntlet palette, and portrait crop coherent when regenerating Astra.

- The render loop is plain `requestAnimationFrame`; one update tick per frame, no fixed timestep.
- Water shimmer advances from the shared visual elapsed clock and freezes when reduced motion is preferred. GPU water and wet-surface patterns use world coordinates, so camera movement does not drag the pattern across the surface.
- The terrain is baked into a `terrainCache` canvas by registered passes (`ground-splat`, `coast-field`, and the tile passes); only agents, effects, and weather redraw per frame. The bake key holds only what changes its pixels — cache bounds, asset availability, season, scenery revision, and each pass's revision — so a phase change or a zoom step reuses the cache; time of day and weather reach the ground and water through the grade and `waterMoodFor`. Adding terrain variation should register or extend a bake pass, not the per-frame path; call `invalidateTerrainBake()` when scenery changes.
- Event-bus subscriptions (`agent:added`, `agent:updated`, `agent:removed`) are stored in `_unsubscribers` and torn down in `hide()`. New subscriptions in this directory should follow the same pattern to avoid leaks across mode toggles.
- `ParticleSystem.setMotionEnabled(false)` is set when `(prefers-reduced-motion: reduce)` matches; respect this when adding new effects.
- New motion-bearing features must follow [`../../../../docs/motion-budget.md`](../../../../docs/motion-budget.md): check `motionScale` before allocating animation resources, declare a pulse band, and ship a static reduced-motion fallback.
- Use `PulsePolicy.js` helpers such as `pulseValue()` and `pulseAlpha()` before adding another repeating sine cadence. Local pulse math should be justified by a feature-specific need and still honor reduced-motion fallback values.
