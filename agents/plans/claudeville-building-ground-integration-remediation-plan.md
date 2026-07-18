# ClaudeVille Building Ground-Integration Remediation Plan

> **Status:** historical
> **Prepared:** 2026-07-18
> **Baseline:** `v0.26.0`, commit `91816f7`, live server at `http://localhost:4000`
> **Scope:** all nine World-mode buildings
> **Implementation state:** executed 2026-07-18; retained as design provenance, not a current task list

## Execution Record

Implemented in full on the `v0.26.0` working baseline:

- Added validated grounding profiles for all nine buildings, including terrain aprons and named Portal/Lighthouse/Harbor exceptions.
- Moved land-site materials into the static terrain cache and replaced the universal beveled pad/full-canvas oval with tight pixel-stepped structural shadows.
- Preserved the original upper architecture of Archive, Task Board, Forge, Mine, and Observatory with manifest-declared runtime structure masks. Legacy lawn/slab/retaining pixels are removed before alpha hit masks and hover outlines are derived.
- Added explicit native dimensions and anchors for every building, grounding diagnostics to `Shift+D`, profile/mask/dimension validation, and revised generation/style/QA contracts.
- Replaced the stale five-pose visual suite with asserted, type-centered clear-day and clear-night coverage for all nine buildings plus overview captures (`20/20` deterministic diffs passing).

The original PNG source files remain available as lossless migration inputs. A generative Archive edit was evaluated and rejected because it changed the architecture and projection; deterministic runtime masks preserve pixel fidelity until native structure-only replacements are authored.

## Executive Assessment

The buildings are not literally rendered above a map elevation. ClaudeVille has no per-building Z/elevation value: each sprite is placed at the projected center of its declared tile footprint. The floating appearance is a composite visual failure across three layers:

1. **Several PNGs bake the building onto a complete, self-contained ground tile.** Archive, Task Board, Forge, Mine, and Observatory ground the structure to a slab, but do not ground the slab to the world. Task Board, Forge, Mine, and Observatory make the problem literal by including a visible retaining lip or brick face.
2. **The renderer adds another platform-like treatment below every building.** A full-footprint tinted pad, dark 4px southeast edge, highlighted northwest edges, broad oval shadow, and landmark ellipse are drawn before the sprite. Where the baked base is smaller or differently shaped than the configured footprint, this becomes a visible second ground plane.
3. **The map does not own the transition between building and site.** Roads reach entrance tiles, but land-building aprons are opaque sprite pixels. Terrain texture, road wear, plants, and district material cannot cross those pixels, so most sites read as placed objects rather than construction embedded in the village.

The existing style rule, "every building sits on a baked 2:1 isometric diamond base - nothing floats," is the central design error. A baked base is neither necessary nor sufficient for grounding. Command Center works because its flat, broken cobble/grass apron visually continues the map. Harbor works better because it has no filled lawn tile: pilings, posts, deck edges, and water ripples create direct physical contact. Portal and Lighthouse remain credible because their raised masonry has a functional reason to exist.

**Recommended direction:** use a hybrid terrain-first grounding model. Land aprons and site materials should be rendered as part of the static terrain layer; building sprites should contain the structure and only true structural footings. Keep contextual exceptions for Harbor (`water-pilings`), Lighthouse (`quay/seawall`), and Portal (`intentional-dais`).

## Audit Method And Baseline

The assessment combined:

- The six operator-supplied closeups.
- A live desktop audit at `1440x1000`, clear day, zoom 1 overview, zoom 2 closeups for all nine buildings, plus targeted clear-night checks.
- Direct inspection of all nine `base.png` files and their alpha/pixel bounds.
- Current building definitions, projection, sprite anchors, draw order, shadow/contact-pad code, manifest metadata, terrain/road configuration, generation scripts, and retained historical plans.
- Existing validators and visual-diff coverage.

Current structural checks all pass:

```text
npm run world:validate-buildings  -> 9 definitions passed
npm run world:validate-terrain    -> 9 buildings passed
npm run sprites:validate          -> 0 missing/orphan/invalid/warning results
```

This is therefore not a missing asset, invalid footprint, clipping, alpha-fringe, or manifest-integrity defect. It is a perceptual integration defect outside the current validation contract.

All base PNGs use binary alpha only (`0` or `255`), have adequate transparent canvas padding, and follow the correct 2:1 lower-edge projection. Pixel-art alpha is not the problem and should remain hard-edged. The useful distinction is **flat/contextual/broken ground contact** versus **uniform raised slab with a complete perimeter**.

Live-audit limitations: one normal runtime population (five active agents and one Harbor repository), no rain/fog/storm pass, and dynamic labels/rituals varied by frame. Day and night were sufficient to establish that lighting is secondary; night reduces edge contrast but does not remove the slab geometry.

## Current Placement And Draw Contract

1. Logical footprints and positions come from `BUILDING_DEFS` in `claudeville/src/config/buildings.js:70-353`.
2. `buildingCenterToWorld()` projects the center of that footprint to the world plane in `claudeville/src/presentation/character-mode/Projection.js:46-53`.
3. The sprite is drawn at that center and offset by its image anchor in `BuildingSprite.js:1387-1437`.
4. Only Watchtower, Harbor, and Archive declare explicit base anchors. The other six use `[width / 2, height * 7 / 8]` from `AssetManager.js:84-105`.
5. `horizonY` and `splitForOcclusion` divide a sprite around agents; they do not change its vertical placement. They are not the source of the float.
6. Terrain renders first, then building shadows/contact pads, then depth-sorted sprites (`WorldFrameRenderer.js:84-114,154-201`).
7. Roads and approach tiles are generated around every footprint and entrance (`IsometricRenderer.js:743-781`), but they cannot merge through an opaque baked base.

The technical placement is coherent. The visual contact model is not.

## Root Causes

### R1. The style contract confuses a base tile with ground integration

`docs/building-style-contract.md:12` requires a baked diamond and says this prevents floating. `manifest.yaml:441-445` repeats the claim, and land-building prompts ask for a "square isometric ... base tile" (`manifest.yaml:559,573,586`). The generator commonly interprets that phrase as an inventory-style map object: a complete diamond with a dark vertical edge.

The contract also names Archive and Observatory as gold standards (`docs/building-style-contract.md:3`), which is inaccurate specifically for terrain integration. Archive has the worst live result, and Observatory carries the same raised-lawn construction as the other offenders.

### R2. The baked base often has visible thickness and a complete perimeter

Grounded structures need weight at the structure-to-ground contact. The failing assets instead put the whole site on a portable platform:

- Task Board exposes almost the whole green slab because the structure is open.
- Forge and Mine have dark retaining faces below otherwise plausible yards.
- Observatory has a clear brick curb around a small lawn tile.
- Archive has no retaining face, but its oversized, uninterrupted dark flagstone rhombus and near-black perimeter behave like a separate plate.

Uniform material and a closed outline are more damaging than binary alpha. Command also has hard alpha, but irregular grass intrusions, mixed paving, plants, and a flat edge dissolve the boundary.

### R3. Visible base geometry and configured footprints are unconstrained

The projected footprint bounding span is `(width + height) * 32` by `(width + height) * 16` at the current `64x32` tile size. The current assets do not declare native dimensions, ground-plane bounds, or footprint tolerances.

| Building | Logical footprint | Projected span | PNG size | Visible span vs footprint | Anchor source |
|---|---:|---:|---:|---:|---|
| Command | `5x4` | `288x144` | `312x208` | `277px`, `-3.8%` | fallback `[156,182]` |
| Task Board | `4x3` | `224x112` | `256x232` | `190px`, `-15.2%` | fallback `[128,203]` |
| Forge | `4x3` | `224x112` | `256x232` | `224px`, exact | fallback `[128,203]` |
| Mine | `4x3` | `224x112` | `256x232` | `230px`, `+2.7%` | fallback `[128,203]` |
| Archive | `5x3` | `256x128` | `336x224` | `308px`, `+20.3%` | explicit `[168,196]` |
| Observatory | `4x4` | `256x128` | `256x288` | `188px`, `-26.6%` | fallback `[128,252]` |
| Portal | `4x4` | `256x128` | `312x208` | `201px`, `-21.5%` | fallback `[156,182]` |
| Lighthouse | `3x5` | `256x128` | `288x384` | `212px`, `-17.2%` | explicit `[144,320]` |
| Harbor | `5x4` | `288x144` | `352x224` | `302px`, `+4.9%` | explicit `[176,196]` |

The visible span is the alpha-bound width, used here as a reproducible proxy for the base/contact silhouette. It is not a complete geometric model, but the extremes match the live failures. Forge is an important counterexample: its span is exact and it still floats because the dark retaining lip and double-ground treatment are sufficient on their own.

### R4. The shared contact pad and shadow amplify the slab

`BuildingSprite.drawShadows()` draws a broad oval sized from the greater of the logical footprint and 70% of the entire sprite width (`BuildingSprite.js:469-500`). It is a full filled ellipse rather than a structure/contact-aware pixel shadow.

It then calls `_drawFootprintContactPad()` for every building (`BuildingSprite.js:500`). That method:

- fills the complete declared footprint;
- outlines the footprint;
- draws a 4px dark southeast/front edge;
- highlights the northwest/top edges (`BuildingSprite.js:4329-4365`).

All nine buildings are landmark-labelled, so the resting landmark ellipse at `BuildingSprite.js:502-517` also appears around every site. Activity can add another footprint ellipse/dais ring at `BuildingSprite.js:4184-4314`.

This means a failing land building can show, in order: map terrain, broad shadow, tinted beveled footprint, activity/landmark ring, and baked raised base. The redundant layers explain the visible air gap around Archive and Task Board and the doubled retaining edge around Forge and Mine.

### R5. Site materials stop at the sprite boundary

Road generation reaches building approaches, but there is no building-site material profile. The local result is:

- Archive: dark flagstone plate against a dirt/grass terrace, with no convincing ramp or material continuation.
- Task Board: road/plaza texture appears to pass behind or under the small green platform.
- Forge: approach pavement dead-ends at a prefab lawn/cobble edge.
- Mine: the paved entrance connects, but the mountain and rails sit on a green rectangular plinth rather than emerging from the mine yard.
- Observatory: the front path aligns, but it stops against an exposed brick curb.

Command has a bespoke-looking cobble/grass forecourt and surrounding props. Harbor has water, shoreline, dock traffic, pilings, and ripples. Their success is contextual, not a property of their projection alone.

### R6. The recent seam heal addresses hue only

`scripts/sprites/heal-base-seams.mjs:1-12,38-89` hue-shifts grass pixels toward a mean terrain grass sample. It does not change base size, vertical side faces, closed outlines, anchor alignment, material continuity, or renderer pads. Archive contains little relevant grass; Forge, Mine, Task Board, and Observatory retain their slab geometry after the hue correction.

### R7. Validation and visual baselines cannot catch this class of defect

- Building base PNGs carry no declared dimensions in the manifest.
- The validator explicitly says building bases carry no declared dimensions "by design" and excludes them from dimension checks (`manifest-validator.mjs:380-405`).
- The cube/filled-block heuristic also excludes building bases (`manifest-validator.mjs:409-441`).
- World validation checks logical bounds, relationships, and manifest IDs, not visible base geometry.
- `capture-baseline.mjs:29-35` defines only five poses, with named closeups for Command, Harbor, and Mine. Current fresh images are stale/misdirected: the Command pose frames water/labels, the Harbor pose frames Lighthouse, and the Mine pose frames Observatory. Six buildings have no named closeup, and none of the three named views reliably proves its target is centered.

This is why all gates can be green while the most visible land-building sites remain unreviewed.

## All-Building Assessment

### 1. Archive - Critical, first priority

**Observed:** worst holistic integration. Its `336x224` sprite contains a `308px`-wide dark-purple flagstone apron against a `256px` logical footprint. The apron is horizontally dominant, uninterrupted, and much darker than the bright terrain. The runtime contact diamond and oval shadow remain visible beyond/forward of it, creating a second plane.

**Disposition:** preserve the fortress/library structure, replace the site treatment. Remove the complete dark rhombus. Keep dark stone immediately under walls and steps, then let a terrain-native scholar terrace provide the full footprint with grass/cobble transitions, transparent edge bites, moss, scattered stones, and a clear continuation of `archive-walk` into the stair.

### 2. Task Board - Critical, first priority

**Observed:** clearest literal slab. The open frame exposes a small `190px` green/paver platform inside a `224px` logical footprint. Its black/teal curb sits over a road junction while the larger runtime pad protrudes around it.

**Disposition:** remove the continuous baked ground tile. Seat each post in a small stone footing; retain sparse stepping stones and wear beneath the board with transparency between them. The terrain layer should own the civic path junction. Recalibrate `horizonY`, lanterns, lights, particles, ritual paper positions, and hit/outline behavior after the base changes.

### 3. Mine - High

**Observed:** the rock and rail details are strong, but a natural mountain is placed on a bright green slab with a purple/brown retaining skirt. It reads as a movable geology tile. The entrance pavers help but do not bury the mountain shoulders into the site.

**Disposition:** retain the mountain/headframe, remove the lawn slab and retaining face. Use an irregular rubble/packed-dirt skirt, boulders partly embedded in terrain, and rails that visibly continue into the authored mine approach. A terrain-native mine-yard foundation should carry soot/dust/ore wear without a closed perimeter.

### 4. Forge - High

**Observed:** the cottage is coherent and its visible width matches the logical footprint exactly, but the complete grass/cobble diamond has a dark wine retaining face. The renderer adds another edge and shadow outside it. At zoom 2 it can be read as a low foundation; at normal zoom it reads suspended.

**Disposition:** retain the forge structure and size. Remove the retaining face and full lawn. Render a flat terrain-native work yard with irregular cobble, packed earth, soot, scorch, ash, and grass encroachment. Limit the cast/contact shadow to walls, chimney mass, anvil, and true objects rather than the whole yard.

### 5. Observatory - Medium-High

**Observed:** the most undersized land base (`188px` visible against `256px` logical span). It has the same baked lawn and visible brick fascia family as Forge/Mine, but its centered mass, aligned front path, and plausible civic terrace make the float less severe.

**Disposition:** remove the brick-curbed lawn and give the clock tower a terrain-native knowledge-district terrace. Preserve a small masonry footing if desired, but any real elevation must have a complete architectural explanation: connected steps/ramp, retaining edge, and path. Recalibrate the clock, aperture, windows, pennant, `horizonY`, emitters, and light anchors.

### 6. Lighthouse / Watchtower - Low-Medium, preserve unless renderer work exposes it

**Observed:** its `212px` navy quay is undersized against the `256px` logical span and has a hard black edge. It still reads credibly because a seawall/quay is allowed to be raised, the stair connects to land, and water gives the base a functional context. It lacks Harbor's richer pile/foam transition, so a mild mat-like read remains.

**Disposition:** do not regenerate in the first asset batch. Define it as a `quay/seawall` exception, suppress the generic land pad/oval, and re-evaluate. Add only localized foam, wet edge, rubble, or stair-to-road continuity if the renderer cleanup exposes a remaining seam.

### 7. Portal - Low, intentional elevation

**Observed:** the raised stone dais is visually obvious but architecturally justified by stairs, massive masonry, tonal match, and the arcane function. The main defect is the faint larger runtime pad/activity halo around a much smaller visible base.

**Disposition:** preserve the portal art and intentional dais. Give it a terrain-native outer arcane court of broken stones/runes, or suppress the pad outside the true dais. Treat deliberate elevation as an exception that must declare stairs/threshold and a transition into surrounding terrain.

### 8. Command Center - Pass, land reference

**Observed:** best land integration. The flat apron is near its configured footprint, uses the village's cobble/grass language, has irregular vegetation and stone breakup, meets the path at a stair, and is reinforced by surrounding props. The generic pad/ellipse is detectable at zoom 2 but does not dominate.

**Disposition:** do not regenerate. Use it as the land reference for material breakup and path continuity, not as proof that every building needs a baked diamond. Add an explicit anchor and grounding metadata, then verify that shared renderer cleanup does not regress it.

### 9. Harbor - Pass, best contextual reference

**Observed:** strongest integration overall. There is no lawn mat. Piers and posts terminate in water, pilings carry the deck, foam/ripple contacts break the boundary, and shoreline/dock traffic reinforces its function. Scale and projection fit the site.

**Disposition:** preserve the asset and define it as the `water-pilings` reference. Remove or specialize the generic oval/pad under it; water-contact effects should remain the physical grounding mechanism. Treat the dynamic ledger obscuring the adjacent Lighthouse contact as a separate readability concern, not a grounding fix.

## Target Grounding Contract

Replace the current "every sprite gets a baked diamond" rule with the following contract.

### 1. Ownership

- **Terrain renderer owns:** grass, dirt, roads, civic cobble, flat aprons, district wear, edge vegetation, and the connection from road to entrance.
- **Building sprite owns:** walls, roof, stairs attached to the structure, true masonry footings, posts, rails/headframes, and objects that must occlude agents.
- **Explicit structural exceptions own their platform:** Harbor deck/pilings, Lighthouse quay/seawall, Portal dais. Their transition into water/terrain must still be authored.

### 2. Geometry

- Ground material must follow the logical footprint parallelogram derived from `BUILDING_DEFS`, not a generic square inventory tile.
- A flat land apron must not show a vertical side face, retaining lip, or complete near-black perimeter.
- Flat edges remain hard pixel art, but must be broken by material variation, transparent bites, grass/soil intrusion, stones, wear, or terrain continuation.
- True elevation is allowed only when supported by steps/ramp, retaining geometry, and a coherent approach.
- Structure contact shadows start under walls/posts/rock mass, not at the outer apron edge.

### 3. Metadata

Extend the existing visual registry/manifest contract rather than adding type branches in the renderer. Recommended profile:

```js
grounding: {
    mode: 'terrain-apron' | 'intentional-dais' | 'quay' | 'water-pilings',
    material: 'civic-cobble' | 'knowledge-terrace' | 'workshop-yard' | 'mine-yard' | 'arcane-court',
    edgeTreatment: 'broken' | 'retained' | 'water-contact',
    shadow: 'structure-contact' | 'tower-cast' | 'none',
}
```

Also require every building manifest entry to declare:

- native `width` and `height`;
- explicit `anchor`;
- ground/contact bounds or a documented `grounding.mode` exception;
- `horizonY` when split for occlusion;
- all pixel-coupled emitter, light, overlay, window, ritual, and pennant anchors.

Do not duplicate the logical footprint in the manifest. Derive projected dimensions from `BUILDING_DEFS` and validate the visible contact model against it.

### 4. Runtime overlays

- Remove the passive beveled `_drawFootprintContactPad()` from normal resting rendering, or convert it to a terrain-cache foundation that has no selection/status meaning.
- Selection, hover, occupancy, and incident rings should appear only for their semantic state and should not simulate a permanent physical platform.
- Replace the universal full-sprite oval shadow with grounding-mode profiles. Land structures need tight, stepped contact/cast shadows; Harbor needs piling/deck water shadow; Portal can shadow its dais; Lighthouse can cast from the tower/quay.
- Keep foundation work static/cacheable. Do not move terrain-apron painting into the per-frame loop.

## Phased Remediation Plan

### Phase 0 - Establish a truthful baseline

**Owned paths:** `scripts/sprites/capture-baseline.mjs`, `scripts/sprites/visual-diff.mjs`, `DebugOverlay.js`, optional new read-only sprite metrics script.

1. Replace hard-coded stale world coordinates with building-type lookup and runtime centering derived from `BUILDING_DEFS`/`buildingCenterToWorld`.
2. Capture one deterministic daylight context crop for each of the nine buildings at zoom 2, plus overview and one night matrix.
3. Assert that each named target is near the capture center and visibly present before writing a baseline.
4. Add a debug grounding overlay showing logical footprint, sprite anchor, ground/contact bounds, entrance, `horizonY`, and shadow origin.
5. Record the current nine-building matrix before art or renderer changes.

**Gate:** every building has a correctly named, reproducible closeup; a reviewer can see footprint/pad/base alignment without guessing camera coordinates.

### Phase 1 - Fix the systemic renderer and data contract

**Owned paths:** `BuildingVisualRegistry.js`, `BuildingSprite.js`, `IsometricRenderer.js` or the static terrain-cache owner, `AssetManager.js`, `manifest.yaml`, `docs/building-style-contract.md`.

1. Add `grounding` profiles for all nine buildings.
2. Paint land foundations as static terrain/site material, including entrance continuity and irregular edge wear.
3. Remove the permanent beveled contact pad and resting landmark ellipse from physical grounding.
4. Replace universal whole-sprite shadows with grounding-mode shadows.
5. Add explicit anchors and native dimensions for all nine entries.
6. Update the style contract and generation prompt rules: forbid raised tile, plinth, retaining lip, complete base outline, baked shadow, and generic square ground tile for `terrain-apron` assets.

**Prototype gate:** implement only Archive and Task Board profiles first with temporary/current art. Confirm the terrain-first model improves both without regressing Command, Harbor, Portal, or Lighthouse before processing more assets.

### Phase 2 - Critical asset corrections

**Owned paths:** `building.archive/base.png`, `building.taskboard/base.png`, their manifest/registry anchors and overlays.

1. Archive: preserve upper architecture; remove/rebuild the oversized dark apron and wall foot contact.
2. Task Board: preserve the board/roof/lanterns; remove the slab and restore individual post footings.
3. Recalibrate anchors, `horizonY`, lights, emitters, windows, pennants, ritual effects, alpha hit masks, and hover outlines.
4. Verify road/entrance material continuity at normal zoom before accepting sprite-detail polish.

**Gate:** no visible second plane outside either sprite; no complete dark land-base perimeter; approach path reaches the physical threshold.

### Phase 3 - Remaining land offenders

**Owned paths:** Forge, Mine, Observatory assets and their coupled manifest/registry/runtime anchors.

1. Forge: flat workshop yard; no retaining lip; soot/cobble/earth transition.
2. Mine: irregular embedded rock/rubble skirt; rails continue into the mine-yard approach.
3. Observatory: terrain-native scholar terrace; no brick-curbed lawn; retain only justified masonry footings.
4. Recalibrate all per-building effects after each asset, not at the end of the batch.

**Gate:** each site reads as constructed in its district at zoom 1 and zoom 2, in day and night, both idle and active.

### Phase 4 - Preserve and specialize the references

**Owned paths:** grounding profiles for Command, Harbor, Lighthouse, Portal; asset changes only if post-renderer review requires them.

1. Command: keep art; make anchor/profile explicit; verify terrain foundation does not double its existing flat apron.
2. Harbor: keep art; use piling/water contacts, not a land pad or full oval.
3. Lighthouse: keep the quay; add only local water/shore transitions if the renderer cleanup reveals a seam.
4. Portal: keep the intentional dais; give it a deliberate outer arcane court or suppress the larger generic footprint pad.

**Gate:** the four current references remain at least as integrated as the baseline while sharing the new metadata contract.

### Phase 5 - Validation and documentation hardening

**Owned paths:** sprite/world validators, nine-building baselines, `docs/building-style-contract.md`, `docs/world-visual-qa-checklist.md`.

1. Validate native dimensions and explicit anchors for every building base.
2. Validate visible ground/contact span against projected footprint with a documented tolerance; exceptions must name `water-pilings`, `quay`, or `intentional-dais`.
3. Add warnings for a complete dark lower perimeter/retaining band on `terrain-apron` bases. Keep this heuristic reviewable rather than pretending it proves visual quality.
4. Run all nine closeups at fixed clear day, fixed night, idle/no-agents, and at least one active-building scenario.
5. Update the QA checklist with the acceptance criteria below.

## Acceptance Criteria

Every building must pass all applicable items:

- The logical footprint, sprite anchor, and visible contact plane align in the debug overlay.
- No land building shows a continuous dark or vertical perimeter around a flat apron.
- No shared renderer pad or shadow protrudes as a second platform.
- The road/path visibly meets the threshold, stair, rails, or posts; it does not pass under an opaque lawn tile or dead-end at a prefab edge.
- Terrain material reaches or transitions into the structure contact with broken, pixel-crisp edges.
- Shadows originate under structural mass and agree with time-of-day direction; they do not shadow the entire transparent canvas or flat apron.
- Intentional elevation has a named grounding mode and visible architectural reason.
- Hover, selection, occupancy, and incident effects communicate state without changing the apparent building elevation at rest.
- Split occlusion remains correct with an agent behind and in front of the building.
- Hit testing and hover outlines cover the structure without turning a terrain apron into an oversized click/outline block.
- Emitters, lights, windows, pennants, ritual overlays, bubbles, and labels remain calibrated.
- Day, night, and reduced-motion views remain legible at integer zoom 1, 2, and 3 on desktop viewports at least 1280px wide.
- `npm run sprites:audit-refresh`, `npm run world:validate-buildings`, `npm run world:validate-terrain`, and the rebuilt all-building visual diff pass.

## Risk Controls

- **Do not batch-regenerate all nine buildings.** Upper architecture is already strong; most work is base removal, site material, and renderer behavior.
- **Do not move logical building positions or footprints as a visual shortcut.** That would disturb pathfinding, visit tiles, water validation, scenery exclusions, and district layout.
- **Treat every sprite-base change as an anchor migration.** Re-measure `horizonY`, emitters, lights, overlay layers, window rectangles, ritual points, pennants, and special effects.
- **Preserve pixel-art alpha.** Do not introduce feathered/anti-aliased edges to hide seams. Use flat geometry, material continuity, and irregular pixel contours.
- **Keep foundations static.** Terrain-native aprons belong in cached terrain/site rendering; avoid new per-frame raster cost.
- **Review shared renderer changes against good exceptions first.** Removing the universal pad/shadow may expose missing contact under Lighthouse or Portal; solve that through their grounding profiles, not by restoring the global dais.
- **Separate state marks from physical ground.** Activity and selection rings can remain, but only when state warrants them and with a shape that does not masquerade as a foundation.

## Expected File Impact During Implementation

- `claudeville/src/presentation/character-mode/BuildingSprite.js`
- `claudeville/src/presentation/character-mode/BuildingVisualRegistry.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js` or the extracted static terrain foundation owner
- `claudeville/src/presentation/character-mode/AssetManager.js`
- `claudeville/assets/sprites/manifest.yaml`
- Targeted `claudeville/assets/sprites/buildings/building.*/base.png` files
- `scripts/sprites/capture-baseline.mjs`
- `scripts/sprites/visual-diff.mjs`
- `scripts/sprites/manifest-validator.mjs`
- `docs/building-style-contract.md`
- `docs/world-visual-qa-checklist.md`
- Intentional baseline images under `scripts/sprites/baselines/`

## Recommended Execution Order

1. Phase 0 capture/debug baseline.
2. Phase 1 metadata plus terrain-first prototype on Archive and Task Board.
3. Phase 2 final Archive and Task Board art/calibration.
4. Phase 3 Forge, Mine, then Observatory.
5. Phase 4 Command/Harbor/Lighthouse/Portal specialization and regression review.
6. Phase 5 validators, all-building baselines, and docs.

The priority order is driven by the live result, not by sprite style alone: **Archive -> Task Board -> Mine -> Forge -> Observatory -> Lighthouse -> Portal -> Command -> Harbor**. Command and Harbor are references to preserve, not regeneration targets.
