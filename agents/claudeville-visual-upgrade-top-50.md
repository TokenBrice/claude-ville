# ClaudeVille Visual Upgrade — The Definitive Top 50

## Vision / North Star

**ClaudeVille is one lit place, breathing with its fleet — and every pixel of motion or color is a true word about a real session.** The island already has a sky that lives, a sea that glints, and villagers that walk to where the work is. What it lacks is *coherence under pressure*: a single color authority so World and Dashboard read as two windows onto the same town; a value hierarchy so the one errored agent is never lost in a crowd of twenty-four; and follow-through on promises the engine already makes — `puddleAlpha`, `roofGlintAlpha`, `nightReflection`, `beaconIntensity`, `eventInfluence` are all computed and then thrown away. We pursue the Maximalist's ambition (a 3D island resting in a real sea, cinematic hero moments, a sky that storms when the fleet struggles) **only on top of** the Art Director's discipline (one palette, three pulse bands, a mark budget that culls noise). The order is non-negotiable: make the busy scene legible and the surfaces cohesive *first*, wire the dormant state-pathways *second*, then earn the spectacle. Awe must always resolve into legibility, or it is just noise on a parchment.

## How to read this

Each item carries an **axis badge**: `Epic · Lively · Compelling · Lovely` (judge scores 0–5) plus **effort** (S ≤1 day, M ~2–4 days, L ~1 week, XL multi-week) and **risk** (low/med/high).

- **Epic** = scale, grandeur, cinematic framing, hero moments.
- **Lively** = honest motion, ambient life, the world reacting to real events.
- **Compelling** = every visual maps to true session state; you watch because it *tells* you something.
- **Lovely** = warmth, craft, polish, cohesion, the details people adore.

Priority blends composite score, debate consensus (elevate − cut), axis balance across tiers, and dependency order. Foundations that multiply everything downstream (palette, value hierarchy, clutter triage) outrank higher-scoring ornaments that depend on them. Every motion item names its **reduced-motion static fallback** — it is part of "done," not a follow-up.

## Phased Roadmap

- **Tier 0 — Foundations & Quick Wins** *(cheap, compounding; build these first or everything downstream fragments)*: #1, #2, #3, #4, #5, #6, #7, #8
- **Tier 1 — High-Impact Core** *(the world breathes with real state; the busy scene becomes legible)*: #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20
- **Tier 2 — Epic Centerpieces** *(framed hero moments — only once Tier 0/1 land)*: #21, #22, #23, #24, #25, #26, #27, #28
- **Tier 3 — Polish, Charm & Cohesion** *(the slow-gaze details and the idle hour)*: #29 … #50

---

## THE TOP 50

### #1 — The House Palette: one tokenized color system across every surface
`Epic 2.0 · Lively 1.0 · Compelling 3.0 · Lovely 4.5 | effort M · risk med`
**What:** Promote `theme.js` to the single source of color — one named ramp: 9 building accents, the 5-status set (`STATUS_VISUALS`), a 3-step parchment/neutral, one provider hue per CLI. Make `VillageDirectorOverlay.BUILDING_COLORS`, `AvatarCanvas`, `DashboardRenderer`, `CouncilRing`, and `HarborTraffic` all import from it instead of their private RGB tables.
**Why it matters:** Lovely + Coherence. The screenshots show a cyan director ring that ignores dusk, dashboard greens that don't match world greens. This is the spine — every later overlay reads better once one palette exists, and it directly heals the "two products" wound.
**Implementation:** `src/config/theme.js` as authority; replace the standalone tables in `VillageDirectorOverlay.js`, `CouncilRing.js`, `HarborTraffic.js`, `AvatarCanvas.js`, `DashboardRenderer.js`. No motion. Pure refactor — verify with a full World+Dashboard pass.
**Dependencies:** Build FIRST. Hard prerequisite for #2, #3, #29, #30, #31, #37.

### #2 — Value-hierarchy contract: PRIMARY / SECONDARY / AMBIENT marks
`Epic 2.0 · Lively 2.0 · Compelling 4.5 · Lovely 3.0 | effort M · risk med`
**What:** Define three draw tiers in `theme.js`/a small policy module: PRIMARY (errored, waiting-on-user, selected) always full alpha; SECONDARY (working glow, tethers, rings) capped; AMBIENT (motes, ground tints, banners) first to dim. A central per-frame **mark governor** caps how many SECONDARY/AMBIENT marks draw per screen region and culls by tier.
**Why it matters:** Compelling. The busy-day screenshot is the problem this solves: a crowd where you cannot find the stuck agent. This is the systemic counterpart to the motion budget — a *mark* budget.
**Implementation:** Small arbiter consulted in `IsometricRenderer` collect/draw phase and by `AgentSprite`, `CouncilRing`, `VillageDirectorOverlay`. Reduced-motion: governor is static (alpha caps only).
**Dependencies:** Pairs with #1; enables #14, #15, #16, #19, #25.

### #3 — Grade authority: plumb `atmosphere.grade` into every overlay
`Epic 2.25 · Lively 1.75 · Compelling 3.0 · Lovely 4.75 | effort M · risk med`
**What:** A single `gradeColor()` lerp toward `atmosphere.grade.worldTint` applied at draw time to VillageDirector halos, CouncilRing tethers, HarborTraffic anchorage glows, and talk arcs.
**Why it matters:** Lovely + Coherence. Today overlays float "day-cold" above a dusk scene. One lerp makes cyan rings belong to golden hour.
**Implementation:** `AtmosphereState` already exposes `grade`; add `gradeColor(hex, grade)` helper, call it in `VillageDirectorOverlay.js`, `CouncilRing.js`, `HarborTraffic.js`. No new motion.
**Dependencies:** After #1. Synergy with #10, #11.

### #4 — Waiting-on-user amber beacon pillar
`Epic 2.75 · Lively 3.0 · Compelling 5.0 · Lovely 3.0 | effort S · risk low`
**What:** A tall pulsing amber light-pillar / `!` pennant above any `WAITING_ON_USER` agent, rising above the crowd, scaling height/brightness with wait duration.
**Why it matters:** Compelling. The single highest-value, lowest-cost read — the action-demanding state must be visible from across the map even when buried in a cluster (exactly the busy-day failure).
**Implementation:** `AgentSprite.js` — screen-composite vertical gradient above the sprite, `pulseAlpha` (medium band, but PRIMARY tier so it never culls). Reduced-motion: static amber pillar at fixed height.
**Dependencies:** PRIMARY tier from #2. Synergy with #14.

### #5 — Building beacons breathe with `beaconIntensity`
`Epic 2.0 · Lively 3.0 · Compelling 3.0 · Lovely 4.0 | effort S · risk low`
**What:** Scale forge/harbor/portal/taskboard emitter brightness and window warmth to `atmosphere.lighting.beaconIntensity` so every beacon dims/brightens in unison as night deepens or a storm rolls in.
**Why it matters:** Lovely + Coherence. Highest awe-per-line: the value is already computed and only feeds the moon corona. Makes the whole village breathe as one lit object.
**Implementation:** `BuildingSprite.js` reads `beaconIntensity` in `_spawnEmittersFor`/window-warmth; data in `BuildingVisualRegistry.js`. Slow band; reduced-motion: static mid-intensity.
**Dependencies:** Foundation for #10, #11, #12. Pairs with #8.

### #6 — God-rays on clear events + daytime push/subagent sky rewards
`Epic 3.5 · Lively 3.0 · Compelling 3.5 · Lovely 3.5 | effort S · risk low`
**What:** Loosen `SkyRenderer`'s `sunWarmth > 0.18` gate so god-rays break through on a clearing transition; add daytime counterparts to the night-only aurora/shooting-star rewards — a golden sky-flare on daytime `git:pushed`, a sun-ray glint on daytime `subagent:completed`.
**Why it matters:** Epic. Today push/subagent rewards are invisible in daytime sessions (most sessions). Equivalent hero moments across all phases.
**Implementation:** `SkyRenderer.js` god-ray gate + new daytime event branches mirroring `_drawAurora`/`_drawShootingStars`; `AtmosphereState` cloud-cover gate. Reduced-motion: static brief brightening, no rays.
**Dependencies:** Low-risk standalone. Synergy with #8, #24.

### #7 — Atmosphere reactions on the ground: puddles, roof glint, water warmth
`Epic 2.25 · Lively 3.0 · Compelling 3.0 · Lovely 5.0 | effort M · risk med`
**What:** Read the already-computed `reactions` (`puddleAlpha`, `roofGlintAlpha`, `waterRippleScale`, `warmGlint`, `nightReflection`) in `SceneryEngine` and `BuildingSprite` so after rain cobble glistens, roofs catch a warm rim-light at golden hour, and the lagoon warms at dusk.
**Why it matters:** Lovely. Weather currently exists only in the sky. This makes the day physically present below it — the cheapest, highest-cohesion charm in the pool.
**Implementation:** `SceneryEngine.js` (puddle/ripple overlays), `BuildingSprite.js` (`_drawAtmosphereBuildingReactions` roof glint), `IsometricRenderer.js` water warmth. Bake what you can; per-frame only the wet-shimmer. Reduced-motion: static wet sheen.
**Dependencies:** Pairs with #5, #10. Foundation for #8.

### #8 — Session-health weather: wire the dormant `eventInfluence` pathway
`Epic 3.0 · Lively 3.25 · Compelling 5.0 · Lovely 3.0 | effort M · risk med`
**What:** Aggregate live agent statuses in `VillageDirector` and feed real `storminess`/`clearing` into the already-built `applyWeatherEventInfluence`, so many errored agents cloud the sky and a clean fleet clears to gold.
**Why it matters:** Compelling + Epic. Turns the entire canopy into an honest fleet-health gauge — the most COMPELLING-meets-EPIC moment available, and the pathway is already built but unsourced.
**Implementation:** `VillageDirector.js` computes aggregate health → `AtmosphereState.update({eventInfluence})`; `WeatherRenderer` already consumes. Bucket floats before they hit `cacheKey`. Reduced-motion: weather still shifts color, no precipitation motion.
**Dependencies:** Feeds #7, #22, #23, #24. The trunk of the storm stack.

---

### #9 — Activity glyph badge replaces the always-dark name pill
`Epic 2.0 · Lively 2.25 · Compelling 5.0 · Lovely 4.0 | effort M · risk med`
**What:** Replace the compact name pill with a small ~9×9 illuminated tool-category emblem (feather=edit, lens=search, gear=bash, globe=web, pickaxe=mine) colored by agent status; full pills reserved for the selected agent and zoom 3.
**Why it matters:** Compelling. The busy-day screenshot's pill-soup is overlapping *text rectangles*. Glyphs turn the world into a constellation of glowing trade-icons that never overlap into mush.
**Implementation:** `AgentSprite.js` compact path + a tiny `ToolIdentity` classifier (shares RitualConductor's tool→category map). Reduced-motion: glyphs are static.
**Dependencies:** Needs #1 (status colors), #2 (tiering). Core of the clutter-triage stack with #14, #16, #19.

### #10 — Night water light reflections: building fire bleeds into the lagoon
`Epic 3.0 · Lively 3.0 · Compelling 3.0 · Lovely 5.0 | effort M · risk med`
**What:** Extend `drawBuildingLightReflections` so forge glow, harbor torches, and lighthouse fire cast wavering vertical reflection columns onto adjacent water tiles at dusk/night, scaled by `nightReflection` and `buildingGlowScale`, shimmering on the water-glint cadence.
**Why it matters:** Lovely. The night screenshot has lit windows but dead-black water beside them. Reflections complete the "one lit object" story and reuse the proven screen-composite light path.
**Implementation:** `IsometricRenderer.js` `drawBuildingLightReflections` (extend to water tiles), reads `AtmosphereState.reactions.nightReflection`. Per-frame but tiny (water already redraws). Reduced-motion: static reflection columns, no shimmer.
**Dependencies:** After #5, #7. Lighting cluster with #11, #38, #40.

### #11 — Forge molten-glow spill onto the cobble yard at night
`Epic 2.0 · Lively 3.0 · Compelling 3.25 · Lovely 5.0 | effort S · risk low`
**What:** Widen `_drawForgeHeatBloom` to stamp a flickering warm light pool on the cobble apron via the screen-composite light path when `_forgeGlow` is high and atmosphere is dark; spill brightness signals actual smithing activity.
**Why it matters:** Lovely + Compelling. The forge in the night screenshot glows internally but throws no light. Real ground light tied to real activity.
**Implementation:** `BuildingSprite.js` `_drawForgeHeatBloom`, `IsometricRenderer.js` light path. Reduced-motion: steady glow pool, no flicker.
**Dependencies:** Lighting cluster with #10, #38. Pairs with #36 (smoke).

### #12 — Archive doorway lamplight spill on high read-intensity
`Epic 2.0 · Lively 2.75 · Compelling 3.0 · Lovely 5.0 | effort S · risk low`
**What:** Spill warm lamplight out the archive doorway onto entrance steps via the screen-blend light path and drift `archiveMote` dust in the shaft when `_archiveReadIntensity` is high.
**Why it matters:** Lovely. The most beautiful building's interior activity finally bleeds outside, and the spill *means* reading is happening.
**Implementation:** `BuildingSprite.js` `_drawArchiveEnhancement`, `IsometricRenderer.js`. Reduced-motion: static shaft, no dust.
**Dependencies:** Lighting cluster with #10, #11.

### #13 — Distinct mood postures: distressed hunches, tired slumps, proud uprights
`Epic 2.0 · Lively 3.75 · Compelling 4.5 · Lovely 5.0 | effort M · risk low`
**What:** Give the three computed moods real body language beyond a ±0.6px bob: distressed = head-down with a slow fret mote, tired = deeper slump with a held eye-shut frame, proud = upright with a slow rising sparkle.
**Why it matters:** Lovely + Compelling. `_moodPostureCue`/`MOOD_ACCENTS` are computed and nearly invisible. Distress should read instantly without a ring.
**Implementation:** `AgentSprite.js` posture offsets + idle-frame selection; `ParticleSystem.js` fret/sparkle. Reduced-motion: posture offset only (static), no motes.
**Dependencies:** Synergy with #4, #40. One medium pulse per agent — don't stack on working-glow.

### #14 — Building-anchored occupant roster: fold pills into a status tally
`Epic 2.0 · Lively 1.75 · Compelling 5.0 · Lovely 3.5 | effort M · risk low`
**What:** When agents are parked at a building visitTile at zoom < 1.5, suppress individual name tags and fold them into a compact status-tally chip under the building label (working/waiting/errored counts in status colors).
**Why it matters:** Compelling. This is the *direct* cure for the Tasks/Forge pill-soup in the busy-day shot — busy buildings become legible at a glance.
**Implementation:** `BuildingSprite.js` (tally chip), `AgentSprite.js` (suppress under threshold), `IsometricRenderer.js` (occupant query). Reduced-motion: chips static.
**Dependencies:** Clutter stack with #9, #16, #19. Needs #1, #2.

### #15 — Working rituals extended to all 9 buildings with gesture animations
`Epic 2.5 · Lively 5.0 · Compelling 4.0 · Lovely 4.5 | effort L · risk med`
**What:** Extend `RitualConductor` pose injection from 3 to all 9 buildings with a small repeated work gesture each (hammer-tick at forge, page-turn at archive, pick-swing at mine, scroll-unfurl at taskboard), each paired with a one-shot particle on the downbeat.
**Why it matters:** Lively. Villagers visibly *work* at their buildings — the strongest "things are always happening" signal, and it maps to real tool activity.
**Implementation:** `RitualConductor.js` `RITUAL_POSE_BY_BUILDING` expansion, `AgentSprite.js` pose overlay, `ParticleSystem.js`. Respect `MAX_CONCURRENT_RITUALS=6`. Reduced-motion: static posed frame, no particle.
**Dependencies:** Synergy with #36, #41. Honor #2 mark budget in crowds.

### #16 — Distance-based label fade: calm overview at zoom 1, full names at zoom 3
`Epic 2.25 · Lively 2.0 · Compelling 5.0 · Lovely 4.0 | effort M · risk med`
**What:** Implement `_agentLabelAlpha` as a real zoom-and-density-aware fade: at zoom 1 in dense regions pills approach 0 (glyphs #9 + cluster banners #19 carry the read); at zoom 3 full names show.
**Why it matters:** Compelling. A satisfying semantic-zoom gradient that removes the text wall at the most-used overview zoom.
**Implementation:** `IsometricRenderer.js` label-alpha computation using `_crowdStats`, `AgentSprite.js`, `CrowdClusters.js`. Static (no motion).
**Dependencies:** Clutter stack with #9, #14, #19. Choose ONE coherent label system across these.

### #17 — Pharos rotating searchlight beam: session distress barometer
`Epic 5.0 · Lively 4.0 · Compelling 4.0 · Lovely 3.0 | effort M · risk med`
**What:** Draw a soft rotating wedge from the lighthouse `lanternFire` anchor, composited `screen`, sweeping faster and shifting amber→red when errored/rate-limited agents route to the watchtower.
**Why it matters:** Epic + Compelling. The tallest landmark gets a cinematic, real-time health read visible across the whole island — and the rotation rate *means* fleet trouble.
**Implementation:** `BuildingSprite.js` (`_drawWatchtowerFire` companion), reuses `OBSERVATORY_SPIN` rotation pattern; clip above building Y; anchor in `BuildingVisualRegistry.js`. Slow/variable band via `PulsePolicy`. Reduced-motion: static directional glow wedge.
**Dependencies:** Reads #8 fleet health. Pairs with #40 distress arc.

### #18 — Harbor buoys bob, sparkle when active, droop on failed push, christening on new repos
`Epic 2.0 · Lively 4.0 · Compelling 4.0 · Lovely 5.0 | effort M · risk low`
**What:** Phase-offset vertical bob on repo anchorage buoys, a torch particle when the repo has active agents, a drooping failed-push tint, and a maiden-banner christening the first time a repo ever appears.
**Why it matters:** Lively + Lovely. The v0.16 anchorages are static 2D chips; this makes Home Waters alive and turns first-contact into a small ceremony.
**Implementation:** `HarborTraffic.js` `_repoAnchorageDrawables`, `ParticleSystem.js`, `ChronicleMonuments.js` (christening banner). Reduced-motion: static buoy, no bob/sparkle.
**Dependencies:** After #1, #3. Harbor cluster with #35.

### #19 — Cluster guild banner: status histogram for dense overflows
`Epic 2.0 · Lively 2.0 · Compelling 5.0 · Lovely 3.0 | effort M · risk low`
**What:** Extend the crowd-cluster badge into a heraldic standard showing total count plus up to 3 status pips (working/waiting/errored) so hidden overflow agents are summarized rather than silently dropped.
**Why it matters:** Compelling. Closes the gap where overflow pills just vanish — the crowd is now *summarized*, not lost.
**Implementation:** `CrowdClusterOverlay.js`, `CrowdClusters.js`, `IsometricRenderer.js`. Static.
**Dependencies:** Clutter stack with #9, #14, #16.

### #20 — Dashboard reskin to village house style
`Epic 2.25 · Lively 2.0 · Compelling 3.75 · Lovely 5.0 | effort M · risk low`
**What:** Restyle `DashboardRenderer` cards with `THEME.bg` warm-dark field, parchment panels, building-token district washes, gilt-border world-pill treatment, and status-color left rails matching `STATUS_VISUALS`.
**Why it matters:** Lovely + Coherence. The dashboard screenshot is a dark terminal log beside a painterly game. This is the single biggest cohesion wound.
**Implementation:** `DashboardRenderer.js`, `AvatarCanvas.js`, `css/dashboard.css`, tokens from #1. No motion.
**Dependencies:** Hard-needs #1. Surface-cohesion cluster with #30, #31, #37.

---

### #21 — EPIC CENTERPIECE: Director-driven cinematic camera with art-directed grade
`Epic 5.0 · Lively 3.0 · Compelling 4.0 · Lovely 4.0 | effort L · risk med`
**What:** Wire `VillageDirector` snapshot events into a `CameraDirector` that triggers named glides (harbor for release parade, incident cluster for errors, new agent for arrival) — time-boxed cubic-ease moves that **abort instantly on any user input**, paired with a momentary vignette/worldTint grade.
**Why it matters:** Epic. Spectacle is wasted if nobody is framed on it. The camera is the prerequisite for the parade and distress arc landing.
**Implementation:** `Camera.js` (glide state machine, clear `_userAdjusted` only for the move's duration), `IsometricRenderer.js`, `VillageDirector.js`, `WorldFrameRenderer.js` grade pass. Reduced-motion: cut directly to framed view, no glide.
**Dependencies:** Build BEFORE #24, #40, #46. Abort-on-input is mandatory.

### #22 — Storm centerpiece: forked lightning, traveling rain curtains, session-driven intensity
`Epic 5.0 · Lively 4.0 · Compelling 4.0 · Lovely 3.0 | effort L · risk med`
**What:** Add a procedural jagged-polyline bolt to `_drawStormFlash`, 2–3 denser drifting rain curtains, and couple storm intensity to aggregate session health via #8.
**Why it matters:** Epic. A troubled fleet triggers genuine weather drama over the lighthouse — the storm-as-fleet-health payoff.
**Implementation:** `WeatherRenderer.js` (`_drawStormFlash` bolt geometry, curtains via `weatherLegibilityGate`), `SkyRenderer.js`, `AtmosphereState.js`. Reduced-motion: static darkened overcast + single still flash frame suppressed.
**Dependencies:** Needs #8. Pairs with #23, #17. Honor sky budget — gate behind #6/#24 cache.

### #23 — Animated surf wash on the coastline
`Epic 3.0 · Lively 4.0 · Compelling 3.0 · Lovely 4.0 | effort M · risk med`
**What:** 2–3 staggered alpha foam-line bands along shore tiles pulsing in/out via `PulsePolicy`, crest brightness scaling by `stormRoughness`.
**Why it matters:** Lively + Epic. The island visibly sits in *moving* water, and troubled sessions get heavier surf — a true read on a beautiful element.
**Implementation:** `IsometricRenderer.js` (shore-tile pass), `SceneryEngine.js` (`shoreTiles`), `AtmosphereState.js`. Slow band. Reduced-motion: static foam line.
**Dependencies:** Reads #8 `stormRoughness`. Pairs with #25 island-edge.

### #24 — Cloud-shadow parallax layer drifting over the terrain
`Epic 3.0 · Lively 4.25 · Compelling 2.0 · Lovely 4.0 | effort M · risk med`
**What:** Draw 2–3 feathered dark ellipses (~12% alpha) over the baked terrain whose world-X moves with `windX` at a fractional parallax rate, so cloud shadows visibly slide across the village.
**Why it matters:** Lively + Epic. Gives the flat iso plane depth under a real sky for very little cost.
**Implementation:** `WorldFrameRenderer.js` (between terrain and sprites), reads `SkyRenderer` cloud descriptors + `AtmosphereState.windX`. Slow band. Reduced-motion: static soft shadows or none.
**Dependencies:** Should ride the sky-cache; fund alongside #6/#22 budget.

### #25 — Island-edge void dissolution: stacked haze bands + coastal cliff shelf
`Epic 4.0 · Lively 2.0 · Compelling 2.25 · Lovely 4.0 | effort M · risk med`
**What:** Extend `_drawDistantSeaHorizon` with 3–4 staggered fog/haze gradient bands keyed to `fogIntensity` and `worldTint`, and bake a sand/cliff face along the iso diamond perimeter so the hard void boundary melts into atmospheric distance.
**Why it matters:** Epic. The flat-plane "void" at the diamond edge is the renderer's biggest tell — this is the decomposed, shippable cure.
**Implementation:** `IsometricRenderer.js` `_drawDistantSeaHorizon` + perimeter cliff bake, `SceneryEngine.js`, `SkyRenderer.js`. Mostly baked. Reduced-motion: static bands.
**Dependencies:** Pairs with #26, #23.

### #26 — Atmospheric perspective bake: far tiles recede, near tiles vivid
`Epic 4.0 · Lively 1.0 · Compelling 2.0 · Lovely 4.0 | effort M · risk med`
**What:** Bake a faint top-to-bottom cool-lighter wash into the terrain cache so far rows (low tileY) read hazier than near rows.
**Why it matters:** Epic. The painterly "distant things recede" trick at *zero per-frame cost* — the world feels deep and large.
**Implementation:** `IsometricRenderer.js` terrain bake pass, `TerrainTileset.js`, `AtmosphereState.js` (fold into `terrainCacheKey`). No motion.
**Dependencies:** Diorama cluster with #25. Both bake-time only.

### #27 — Speech bubbles with real intent: tool glyphs and topic chips
`Epic 2.0 · Lively 4.0 · Compelling 5.0 · Lovely 4.0 | effort M · risk med`
**What:** Replace the bare ellipsis in `_drawChatEffect` with a small parchment speech-scroll showing the live tool-category glyph or a short topic chip, plus a travelling mote along talk arcs.
**Why it matters:** Compelling + Lively. Agent conversations currently read as decorative dots; this makes them topically meaningful and shows which conversation is *live*.
**Implementation:** `AgentSprite.js` `_drawChatEffect`, `CouncilRing.js` `drawTalkArcs` (travelling mote), `VillageDirectorOverlay.js`, shared `ToolIdentity` from #9. Reduced-motion: static glyph, no mote.
**Dependencies:** Reuses #9 glyphs. Pairs with #42 gossip clusters.

### #28 — Handoff as a walked baton with terminal landing flash
`Epic 2.75 · Lively 4.0 · Compelling 4.5 · Lovely 4.0 | effort M · risk med`
**What:** Parent agents briefly walk toward the child, pass a glowing scroll mote hand-to-hand at the arc terminus, child gives an acknowledgement bob, and a terminal spark fires when `progress` reaches 1.
**Why it matters:** Compelling + Lively. Closes the visual loop the current floating dot leaves open — handoffs become a readable event.
**Implementation:** `VillageDirector.js` (handoff snapshot), `VillageDirectorOverlay.js` `drawHandoffs`, `AgentSprite.js`. Reduced-motion: static arc + endpoint dot, no walk/spark.
**Dependencies:** Share ONE terminal-flash impl with #27's mote system.

---

### #29 — Weather-coupled sky palette: bruised storm zenith
`Epic 4.0 · Lively 2.0 · Compelling 3.0 · Lovely 4.0 | effort M · risk med`
**What:** After `blendPalette()`, lerp zenith toward purple-grey and horizon toward olive on storm/rain using `cloudCover`; expose the shifted `worldTint` so ground/water/overlays agree.
**Why:** Epic. Sky and ground finally agree on the kind of day. **Files:** `AtmosphereState.js`, `SkyRenderer.js`, theme via #1. Reduced-motion: color only.
**Synergy:** #8, #22, #3.

### #30 — Dashboard cards carry their World building identity
`Epic 2.0 · Lively 2.0 · Compelling 4.0 · Lovely 4.0 | effort M · risk low`
**What:** Derive each agent's building from tool/role (RitualConductor classification), set a CSS prop for a faint district radial wash + 14px building-emblem glyph (Archive = cool blue, Forge = ember).
**Why:** Compelling + Coherence. **Files:** `DashboardRenderer.js`, `AgentPresentation.js`, `css/dashboard.css`. **Synergy:** #20, #1.

### #31 — Selection echo: one accent halo across panel, card, sidebar
`Epic 2.0 · Lively 2.5 · Compelling 3.75 · Lovely 4.0 | effort M · risk low`
**What:** On selection, set `--cv-selected-accent` on `body`; apply a breathing halo to the dashboard card, a left-rail glow on the sidebar row, and a top accent bar on the panel header.
**Why:** Lovely + Coherence. "The one you're watching" is unmistakable everywhere. **Files:** `AgentSelection.js`, `css/dashboard.css`, `css/sidebar.css`, `css/activity-panel.css`. Reduced-motion: static halo.

### #32 — Arrival and departure ceremonies
`Epic 2.0 · Lively 4.0 · Compelling 3.0 · Lovely 4.0 | effort S · risk low`
**What:** ~300ms scale-up with portal-rune shimmer + dust puff on arrival; soft upward dissolve on non-archive departure, synced to the VillageDirector lifecycle rings that already fire.
**Why:** Lively. **Files:** `AgentSprite.js`, `ParticleSystem.js`, `VillageDirector.js`. Reduced-motion: instant appear/fade.

### #33 — Volumetric chimney smoke reads forge heat, wind, presence
`Epic 2.0 · Lively 4.0 · Compelling 4.0 · Lovely 4.25 | effort M · risk low`
**What:** Replace the single smoke emitter with a rising column whose density/color/drift track `_forgeGlow` and `windX`, scaled by `PRESENCE_TIER_TABLE`; same for mine dust and harbor cookfire.
**Why:** Lively. **Files:** `BuildingSprite.js`, `ParticleSystem.js`, `AtmosphereState.js`. Reduced-motion: thin static wisp. **Synergy:** #11.

### #34 — Token-flow motes rising from working agents to their building
`Epic 2.0 · Lively 4.75 · Compelling 4.0 · Lovely 4.0 | effort M · risk low`
**What:** Tiny `archiveMote`/`beaconMote` particles rise off WORKING agents and drift toward their bound building, density proportional to recent token burn.
**Why:** Lively + Compelling — token burn becomes ambient visible life. **Files:** `LandmarkActivity.js`, `ParticleSystem.js`, `AgentSprite.js`. Honor #2 budget. Reduced-motion: none.

### #35 — Commit ship wake foam scaled by hull class
`Epic 2.25 · Lively 4.0 · Compelling 4.0 · Lovely 4.0 | effort M · risk low`
**What:** Short-lived white foam trail behind moving ships scaled by class (skiff faint, dreadnought broad), V-shaped bow ripple, widening foam ring on force-push sinks.
**Why:** Compelling — push size becomes viscerally readable. **Files:** `HarborTraffic.js`, `ParticleSystem.js`. Reduced-motion: static stern foam dab. **Synergy:** #18.

### #36 — Context-pressure as a filling gauge ring with strain body language
`Epic 2.0 · Lively 3.0 · Compelling 5.0 · Lovely 3.25 | effort M · risk low`
**What:** Convert `_drawContextPressureRing` into a thin radial arc sweeping 0→100% in amber→red, a `78%` chip on the selected agent, sweat-drops + tremble bob at 0.85+.
**Why:** Compelling. **Files:** `AgentSprite.js`, `ParticleSystem.js`. Reduced-motion: static arc + chip, no tremble. **Synergy:** #13.

### #37 — Directional agent shadows that lengthen at dawn and dusk
`Epic 3.5 · Lively 2.75 · Compelling 2.0 · Lovely 5.0 | effort M · risk med`
**What:** Render a skewed sprite-shaped shadow along `shadowAngleRad` (from atmosphere, shared with buildings) instead of a plain ellipse; overlapping contact shadows pool darker in crowds.
**Why:** Lovely + Epic — sunset scenes become cinematic. **Files:** `AgentSprite.js` `_drawGrounding`. Reduced-motion: static skew at current angle (no animation).

### #38 — Idle gossip clusters: spontaneous chat knots between loiterers
`Epic 2.0 · Lively 5.0 · Compelling 3.0 · Lovely 5.0 | effort M · risk med`
**What:** When 2–3 IDLE agents share a scenic point, form a standing chat circle (face each other, topic-glyph bubbles) for a few seconds, then disperse — reusing `chatPartner` machinery.
**Why:** Lively + Lovely — quiet periods feel like a town square. **Files:** `AgentSprite.js`, `CouncilRing.js`, `RelationshipState.js`. Reduced-motion: static facing, no bubbles. **Synergy:** #27, #46.

### #39 — Seabirds with behavioral intent
`Epic 2.0 · Lively 5.0 · Compelling 3.0 · Lovely 5.0 | effort M · risk low`
**What:** Gulls fold and dive toward water then climb; songbirds flutter-pause on rooftops; a celebratory gull scatter fires on harbor push-success.
**Why:** Lively + Lovely. **Files:** `SeasonalAmbience.js`, `scenery.js`, `IsometricRenderer.js`. Reduced-motion: static perched birds. Must suppress decorative ambient when real git events are live.

### #40 — Error agent distress arc: storms to Pharos, triage, recovery
`Epic 4.0 · Lively 4.0 · Compelling 5.0 · Lovely 4.0 | effort L · risk med`
**What:** Errored agents take a distinct distressed walk to the lighthouse, stand under the lantern with a red incident ring and the beam flaring, then fire a relief spark and straighten on recovery; persistent incidents escalate `stormRoughness`-linked rings.
**Why:** Compelling + Epic — failure-and-recovery becomes a legible, emotional story. **Files:** `AgentSprite.js`, `VillageDirector.js`, `VillageDirectorOverlay.js`, `BuildingSprite.js`, `ParticleSystem.js`. Reduced-motion: static posed tableau. **Synergy:** #17, #21, #13.

### #41 — Scenic-point storytelling props + context loiter postures
`Epic 2.0 · Lively 3.0 · Compelling 3.0 · Lovely 5.0 | effort M · risk low`
**What:** Bake authored detail props at the 12 `AMBIENT_SCENIC_POINTS` (rope coil at harbor-rail, open books at archive-alcove, mossy bench at forest-edge); give idle arrivals a place-specific posture.
**Why:** Lovely — the village feels inhabited. **Files:** `scenery.js`, `IsometricRenderer.js`, `AgentSprite.js`, `RitualConductor.js`, `manifest.yaml` (bump `assetVersion`). No motion (baked). **Synergy:** #15.

### #42 — Terrain-aware footfall particles
`Epic 1.25 · Lively 4.0 · Compelling 2.25 · Lovely 5.0 | effort S · risk low`
**What:** Footfall particle type matches the tile class under each agent (dirt→dust, cobble→scuff+spark, grass→motes, shallow→splash), at stride frames for WORKING agents.
**Why:** Lovely. **Files:** `AgentSprite.js`, `ParticleSystem.js`. Reduced-motion: none.

### #43 — Sidebar rows: live status glow + repo-tint left rail
`Epic 1.0 · Lively 3.0 · Compelling 3.75 · Lovely 4.0 | effort S · risk low`
**What:** Status dots become a slow breathing glow for working rows; a working-caret spinner; left border colored by repo from `RepoColor.js`.
**Why:** Lively + Compelling. **Files:** `Sidebar.js`, `css/sidebar.css`. Reduced-motion: static glow. **Synergy:** #31, #20.

### #44 — Project section as district panel with health pulse-bar (Dashboard)
`Epic 2.0 · Lively 3.0 · Compelling 5.0 · Lovely 3.25 | effort M · risk low`
**What:** Section headers gain a 2px composite health bar sized by working/waiting/errored counts, a project accent left-edge, and a single 600ms red edge-flash when an errored card arrives.
**Why:** Compelling — one-glance project triage. **Files:** `DashboardRenderer.js`, `css/dashboard.css`. Reduced-motion: static bar, no flash. **Synergy:** #20, #30.

### #45 — Opening establishing shot on first World paint
`Epic 5.0 · Lively 2.0 · Compelling 3.0 · Lovely 5.0 | effort M · risk low`
**What:** Replace the instant `centerOnMap` with a one-shot cinematic intro: island-wide `fitToWorldBox` held ~1.2s, then a cubic-ease glide+zoom settling on the active cluster over ~2.8s.
**Why:** Epic + Lovely — the island rises into view as a place. **Files:** `Camera.js`, `IsometricRenderer.js`. Reduced-motion: instant center (current behavior). **Synergy:** #21.

### #46 — Activity Panel hero portrait: large pixel avatar with effort aura
`Epic 2.0 · Lively 2.0 · Compelling 3.0 · Lovely 5.0 | effort M · risk low`
**What:** A 96×96 integer-scaled pixelated `AvatarCanvas` of the selected agent as the panel header, framed by effort-aura color and a status ground ellipse.
**Why:** Lovely — meeting the villager, not reading a dossier. **Files:** `ActivityPanel.js`, `AvatarCanvas.js`, `css/activity-panel.css`. **Synergy:** #31, #20.

### #47 — Director scene-log narrative ribbon in the Activity Panel
`Epic 2.75 · Lively 3.25 · Compelling 5.0 · Lovely 4.0 | effort L · risk med`
**What:** A live Chronicle feed in `ActivityPanel` consuming the full `village:director` snapshot: "Handoff — Aria → Bren", "Parade — v0.16.0 sets sail", each with a kind-colored tick and relative timestamp.
**Why:** Compelling — the world's story as scrolling narrative. **Files:** `ActivityPanel.js`, `VillageDirector.js`, `css/activity-panel.css`. No motion. **Synergy:** #20, #46.

### #48 — Connection-loss as a felt chrome event with recovery sweep
`Epic 2.0 · Lively 2.75 · Compelling 4.0 · Lovely 4.0 | effort S · risk low`
**What:** On WS disconnect, desaturate the topbar and drop dashboard cards to a muted frozen opacity with a "reconnecting…" shimmer; on reconnect, one warm gold sweep restores color.
**Why:** Compelling — connection health is felt, not alarmed. **Files:** `TopBar.js`, `css/topbar.css`, `css/dashboard.css`. Reduced-motion: instant state swap, no sweep.

### #49 — Topbar living activity rail: world heartbeat in the chrome
`Epic 2.0 · Lively 3.25 · Compelling 3.0 · Lovely 3.5 | effort M · risk low`
**What:** A 2px strip along the topbar bottom whose brightness/hue derives from world-wide status mix (mostly-working → warm gold shimmer; errored present → slow red bleed from the left).
**Why:** Lively. **Files:** `TopBar.js`, `css/topbar.css` (animated `background-position`). Reduced-motion: static gradient. **Synergy:** #43, #8.

### #50 — Inertial idle drift: Ken-Burns breathing when nothing happens
`Epic 2.25 · Lively 3.25 · Compelling 2.0 · Lovely 5.0 | effort S · risk med`
**What:** After ~45s fully idle, an extremely slow sub-pixel pan along a small bounded Lissajous path, cancelled instantly on any input.
**Why:** Lovely — a monitor-left-open ClaudeVille feels alive, not frozen. **Files:** `Camera.js`, `IsometricRenderer.js`. Reduced-motion: no drift (fully static). **Synergy:** the idle-state charm pairs with the empty-village tour (runner-up #54).

---

## Cross-cutting art-direction principles

1. **One palette, one authority.** All color flows from `theme.js` (#1). No file invents its own RGB tables. New status/building/provider colors are added there and nowhere else.
2. **Three pulse bands, named owners.** Use `PulsePolicy.js` (`pulseValue`/`pulseAlpha`); declare slow (>1s) / medium (~600ms) / fast (<300ms). **One medium pulse per entity** — an agent with working-glow gets no second medium pulse.
3. **Reduced-motion is part of done.** Every motion feature ships a *static* `prefers-reduced-motion` fallback in the same PR (`motionScale` is binary 0/1). A parade with no still frame is a broken parade.
4. **Pixel-art integrity is sacred.** `SpriteRenderer.js` is the sole blit path: `imageSmoothingEnabled=false`, integer-snapped coords, integer zoom {1,2,3}. No fractional zoom, no WebGL/shaders. Sky/overlay sprites replicate these settings.
5. **Bake, don't redraw.** Terrain is baked into a cache canvas; new ground detail (#7 partial, #25, #26, #41) goes into the bake path and folds into `terrainCacheKey`. Per-frame terrain cost stays zero. Respect `CANVAS_BUDGET` (25M renderer / 7M world / 1.25M light px).
6. **Mark budget = motion budget's twin.** The #2 governor caps secondary/ambient marks per region and culls by tier. Awe must resolve into legibility: PRIMARY (errored/waiting/selected) never culls; AMBIENT dims first.
7. **Manifest-driven sprites.** Any new PNG (#41 props, christening banners) gets a `manifest.yaml` entry and a `style.assetVersion` bump; generated via PixelLab against the harmonized v0.15 palette so cohesion holds.
8. **Legibility floor & desktop-only.** Departure Mono for dense data, Press Start 2P for display only, 10px floor. Viewports ≥1280px, no media queries, English-only copy, port 4000.

## Runners-up (#51–#60)

- **#51 — Familiar motes with species/personality** (owl for Gemini, ember-sprite for Codex): charming model identity via shaped particle blits + night ground light pools.
- **#52 — Observatory dome aperture opens at night + result burst**: searching→done payoff at the dome apex.
- **#53 — Occupancy banners/pennants on hero buildings**: roofline standards tinted to the dominant team — guild-territory read.
- **#54 — Empty-village dusk vignette + slow world tour**: the lovely idle screensaver; yields gracefully to the first arrival (pairs with #50, #45).
- **#55 — Ground fog at dawn / over water**: low-lying volumetric ribbons drifting on `windX`; coast reads as real atmosphere.
- **#56 — River flow direction from `flowX/flowY`**: visible current; the central river runs to the sea, lagoon stays glassy.
- **#57 — Building activity footprint upgraded to a glowing dais ring**: occupancy reads by intensity from across the map.
- **#58 — FLIP-style dashboard reorder + "Needs Attention" triage section**: status changes visibly float errored/waiting cards up.
- **#59 — Arrival camera drop-focus**: a brief framed beat per new agent (batches 3+ arrivals); needs #21's abort-on-input.
- **#60 — ChronicleMonuments sprite set**: replace primitive polygons with PixelLab minor/medium/major monument variants for craft cohesion.

## Closing note on sequencing

**Build the foundations before any spectacle.** Tier 0 (#1 palette, #2 value hierarchy, #3 grade) and the clutter-triage core (#9, #14, #16, #19) are the *gate*: a cinematic parade over a pill-soup, void-edged island is lipstick on clutter, and a beam/storm/cloud-shadow stack drawn without a budget governor will cross the 25M renderer-pixel guard and tank FPS on exactly the busy scenes that most need to look good. Sequence: (1) palette + hierarchy + grade refactor; (2) wire the dormant state-pathways (#5, #7, #8) — highest awe-per-line, near-zero architectural risk; (3) clutter triage and surface cohesion (#9, #14, #16, #19, #20); (4) only then the camera director (#21) and the hero scenes it frames (#40, then #22, the parade as a later centerpiece). The biggest single risk is the camera: every director-driven move MUST abort instantly on user input or the cinema becomes a fight for control. Add a tiny per-layer-ms / renderer-pixel dev overlay (gated like `DebugOverlay`) before the sky/light/water stack lands, so the ambitious "lively" additions can be measured against the budget instead of guessed.
