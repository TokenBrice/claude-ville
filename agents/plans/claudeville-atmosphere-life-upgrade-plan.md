# ClaudeVille Atmosphere & Life Upgrade Plan

- **Status:** `completed` (executed 2026-06-15; shipped as the *Atmosphere & life* half of **v0.15.0 — _The Living Village_**, consolidated with the building harmonization)
- **Author:** Claude (Opus 4.8) — broad exploration + plan
- **Date:** 2026-06-15
- **Scope:** World-mode ambience — the *lived-in* ground between buildings, land/air/water fauna, and the village wall/gate/map-edge. Four workstreams, shipped as **one cohesive named release**.
- **Art approach (confirmed):** **Mix** — procedural ground detail baked into the terrain cache (zero credits, no per-frame cost) + new PixelLab sprites for plants and fauna, all on the existing building style contract.
- **Goal:** Make Claudeville feel *alive and tended* — break up the flat grass/cobble in the inhabited core, give the land and water their own small motion, and finish the wall/edge — without regressing readability (sightlines), the motion budget, or the building harmonization just shipped.

> **Line numbers below are hooks, not proof.** They come from a fresh exploration pass on large files (`IsometricRenderer.js` is ~8k lines). Re-confirm each `~line` against the live source before editing (per `agents/README.md`).

---

## Execution status (2026-06-15)

Shipped in **v0.15.0 — _The Living Village_** (the *Atmosphere & life* half, alongside the building harmonization). All four workstreams landed and verified live (`validate:quick`, `sprites:validate`, `world:validate-terrain`, `world:validate-buildings` all pass; 0 console errors; v0.16 chip live).

- **A1 ground micro-detail** — procedural decals (pebbles, soil flecks, cobble moss, leaf litter, worn-dirt road edges) + wildflower dabs, baked into the terrain cache (`IsometricRenderer._drawGroundDecals`). Zero per-frame cost.
- **A2/A3 flowers + cultivated plants** — `flowerTiles` scatter mirroring tufts/bushes, denser in a new `civic-meadow` district + `flowerBoost` levers; cultivated `veg.flowerBed/planter/hedge` placed via `DISTRICT_PROPS` (layer `sorted`, auto-culled off bad tiles).
- **B1 day/night insects** — `butterfly`/`dragonfly` ParticleSystem presets; `SeasonalAmbience._effectiveSeason` gates summer day→butterfly, night→firefly off `atmosphere.phase`.
- **B2/C fauna** — `_drawLandBirds` (songbirds on looping routes, reusing the gull polyline helpers) + `_drawWaterfowl` (lagoon ducks + wading herons), wired in `WorldFrameRenderer` beside the gull/fish passes; reduced-motion safe.
- **D3 distant-sea horizon** — per-frame `_drawDistantSeaHorizon` behind terrain, phase-tinted from the sky's own horizon colour; the south void is now a coastline.
- **D wall/gate (Decision 4 — see note)** — wall got mounted torches (flicker + glow), trailing ivy, and base shrubs; the gate got flanking fire-baskets, all in `_drawVillageWallSegment` / `_drawVillageGatehouse`.

**Deviation from Decision 4 (recorded):** the wall & gate are rendered **procedurally** (the `prop.villageGate`/`prop.villageWall` PNGs exist but are not blitted — the procedural path drives the *animated* gate doors). A static-sprite "regen" would have **lost the door animation**, so the art upgrade was done procedurally (torches/ivy/shrubs/braziers) to preserve it. If genuinely new sprite art for the gate/wall is wanted, that's a separate follow-up that must also re-home the animated doors.

**Minor notes / follow-ups:** one of four lagoon ducks sits on a bridge tile and is correctly skipped (3 render); herons wade on shallow-lagoon tiles (valid pose) rather than strict shore tiles. New sprites generated via PixelLab MCP (download is a `curl --fail` URL, not base64; `key-out-bg` found no residual matte). 11 new PNGs are untracked; the working tree also still carries the uncommitted v0.15.0 harmonization, so staging must be done deliberately.

---

## Decisions — confirmed 2026-06-15

| # | Decision | Choice |
| --- | --- | --- |
| 1 | **Focus areas** | All four workstreams (A ground, B land/air fauna, C water/shore life, D wall/gate/edge), one cohesive release. |
| 2 | **Art approach** | Mix — procedural ground/decals + PixelLab sprites for plants & fauna. |
| 3 | **Execution** | **Coordinated multi-agent pass** — serial Phase 0 foundation (shared files), then parallel workstream agents on disjoint, worktree-isolated ownership; integrate + QA. |
| 4 | **Wall & gate** | **Art upgrade / regenerate** — new gate hero sprite + recalibrated procedural door/tower overlay; new tiling wall-segment sprite replacing the repetitive planks; plus the decoration pass (torches/ivy/footing/approach road). Carries the harmonization §6.3 calibration cost. |
| 5 | **Map edge** | **Distant sea / horizon** — render a faded sea + horizon band beyond the diamond (island/coast read), not just mist. |
| 6 | **Version / name** | **v0.16.0** (major milestone — new fauna systems), working name *Birdsong & Bloom* (final name at rollout). |
| 7 | **Shore fauna** | Core = heron; frog optional. Other optional-tier items (rabbits, swans, crabs, banners, trellis, perimeter extension) default OUT; pulled in only if cheap. |

---

## 0. TL;DR

The world is **not missing environment systems** — it has 20 vegetation sprites, 19 atmosphere sprites, 6 terrain tilesets, 3 waterfalls, 5 fish schools, ~40 gulls across 6 flock routes, weather, sky, and seasonal particles. It reads "basic between buildings" for three structural reasons confirmed in config + live screenshots:

1. **The inhabited middle is cleared on purpose** (dense northern forest crown that thins hard through the core; `SCENERY_CLEARINGS` + per-building `scenery.excludePadding`). Good for sightlines, but the cost is bare ground.
2. **The ground has almost no micro-detail** — the only flat scatter is grass tufts + bushes. No flowers, clover, pebbles, worn dirt, moss, or leaf litter. Each grass diamond is a near-uniform fill.
3. **All the motion/life lives at the water's edge (N/NE)** — fish, gulls, waterfalls are all sea/lagoon. Over the inhabited land there is essentially **no fauna** (only abstract firefly dots in summer).

Plus the secondary asks: the **wall base/exterior is bare** and the **map edge ends in flat void**.

**The release** ("working name: *Birdsong & Bloom*") does four things, weighted to highest leverage:
- **A — Living ground layer:** procedural ground decals (worn dirt, moss, pebbles, leaf litter) + new flower/clover scatter + cultivated plant props (beds, planters, hedges, trellises) in the civic/workshop districts.
- **B — Land & air fauna:** butterflies (day) / fireflies (night) via ParticleSystem; songbirds flitting between trees via a clone of the gull system.
- **C — Water & shore life:** calm-water ducks/koi on the lagoon; frogs/heron on the shore — a clone of the fish-school system targeting different tile sets.
- **D — Wall, gate & map edges:** torches/banners/ivy/shrub footing along the wall, a worn approach road outside the gate, and a soft fog/mist band at the map boundary (reusing the unused `atmosphere.fog.wisp.low`).

Credits are small: most ground detail is procedural; fauna animation reuses the cheap 5-frame `map_object` pattern (like `prop.gullFlight.*`), not the expensive `create_character` + `animate` path. Estimated **< 30 PixelLab generations** total. The real cost is placement tuning + motion-budget/reduced-motion compliance + visual QA.

---

## 1. Diagnosis (exploration + live screenshots)

Three live captures (zoom 1–1.5, night): harbor/NE, south wall+gate, civic core. Saved under `agents/research/atmosphere-life-upgrade/`.

| Observation | Evidence |
| --- | --- |
| Inhabited core is flat grass + cobble diamonds; vegetation pushed to the periphery | civic screenshot; `SCENERY_CLEARINGS` (`scenery.js:376-390`) incl. `clock-skybreak` 0.95, `production-row`, `command-skyline`; building `scenery.excludePadding`/`sightline` (`buildings.js`) |
| Only ground scatter is tufts + bushes; no flowers/pebbles/moss/dirt/litter | `SceneryEngine` populates `grassTuftTiles`/`bushTiles` only; the "flowers/mushrooms densities" comment in `scenery.js:672` is **stale** — those types no longer exist |
| All fauna/motion is at the water (N/NE); land has none | `MARINE_FISH_SCHOOLS` all sea/lagoon (`scenery.js:661-667`); `OPEN_SEA_FLOCK_ROUTES` all sea/north (`scenery.js:571-659`); only `firefly` particle spots inland (`IsometricRenderer.js:1107,1114`) |
| Wall base/exterior bare; palisade repetitive | south screenshot; `_drawVillageWallSegment` (`IsometricRenderer.js:~4346`) repeats planks by phase only |
| Below the wall the world ends in flat blue void | south screenshot; `_drawWorldEdgeRim` (`IsometricRenderer.js:~5910`) draws only a dark rim; `atmosphere.fog.wisp.low` exists and is **unused** |
| Plants are all "wild forest," none cultivated | `DISTRICT_PROPS` (`scenery.js:412-464`) has braziers/wells/carts but no flower beds/planters/hedges/trellises |

**Conclusion:** the fix is to **densify + diversify the lived-in zone, give the land/water their own ambient life, and finish the wall/edge** — additive work on existing systems, not new architecture.

---

## 2. The Release — what's in, what's out

One named minor/major release (verify next version vs `package.json` + `index.html` at rollout). Each workstream has a **Core** (ships) and **Optional** (only if cheap) tier so the release stays bounded and shippable, mirroring the harmonization plan's phasing.

| WS | Core (ships) | Optional (if time/credits) |
| --- | --- | --- |
| **A · Ground** | Procedural decals (worn dirt at thresholds, moss in cobble, pebble/fleck noise, leaf litter under canopy); `veg.flower*`/`veg.clover*` scatter in lived-in districts; ~3 cultivated props (bed, planter, hedge) placed in civic/workshop | Vine trellis, garden plot rows, potted plants at thresholds |
| **B · Land/air fauna** | Butterflies (day) + fireflies (night) particle types, day/night-gated; songbird flit system (clone of gull) with 2–3 inland routes | Ground critters (rabbit), perched idle birds |
| **C · Water/shore** | Calm-water ducks/koi on lagoon; 1 shore fauna type (frog or heron) | Swans, crabs, second shore species |
| **D · Wall/edge** | **New gate hero sprite + recalibrated door overlay; new tiling wall-segment sprite**; wall torches + ivy/shrub footing; gate approach road + arch sconces; distant-sea/horizon edge | Hanging banners; extend wall perimeter routes |

Out of scope: weather changes, sky/cloud rework, **building** regen (wall/gate regen IS in scope), dashboard, widgets, mobile/responsive.

---

## 3. Workstream A — Living Ground Layer

**Why it's #1:** directly answers "the ground between buildings is basic."

### A1 · Procedural ground micro-detail (zero credits, baked into terrain cache)
Flat features (tufts/bushes) are drawn **into the terrain cache** inside `_drawTile()` (`IsometricRenderer.js:~5289-5326`), called from `_drawStaticTerrainSurface()` (`~3602`) during cache build (`~3594`). Add code-drawn decals here — no sprites:
- **Worn-dirt thresholds:** darker earth blend on grass tiles adjacent to building entrances and along high-traffic road edges (read `BUILDING_DEFS[].entrance` + `TOWN_ROAD_ROUTES`).
- **Moss in cobble joints:** green fleck overlay on `cobble`/`square` terrain tiles (low-alpha, noise-gated).
- **Pebble / soil fleck noise:** 1–2px tonal flecks per grass/dirt tile via `tileNoise()` so each diamond stops reading as a flat fill.
- **Leaf litter** under canopy: warm specks on grass tiles inside `FOREST_FLOOR_REGIONS`.

All gated by `tileNoise(x,y)` bands so they're deterministic and bake once. **No per-frame cost** (terrain cache). This is the cheapest, highest-impact lever and needs **no PixelLab credits**.

### A2 · Flower & clover scatter sprites (PixelLab)
Mirror the tuft/bush path exactly. In `SceneryEngine`: add `flowerTiles` / `cloverTiles` Maps (like `grassTuftTiles`, `SceneryEngine.js:31`), populate in the flat-vegetation pass (`~565`) with a density check + `_passesFlatPropSpacing(x,y,'grass')`. In `IsometricRenderer._drawTile()` (`~5317`) add the variant lookup + `sprites.drawSprite()` (bakes into cache).
- New sprites: `veg.flower.a/b/c`, `veg.clover.a/b` — `isometric_tile`, `size: 32`, `anchor: [16,16-18]`.
- Density config in `scenery.js`: add `FLOWER_DENSITY` + per-district `flowerBoost` on `VEGETATION_DISTRICTS` (`:355-362`), and a `flowerBoost` on `SHORELINE_VEGETATION` (`:366-371`).

### A3 · Cultivated plant props (PixelLab, placed)
Add to `DISTRICT_PROPS` (`scenery.js:412-464`) using the existing shape `{ tileX, tileY, id, layer, district }`:
- `veg.flowerBed.a/b` (`create_map_object`), `veg.planter` (isometric_tile), `veg.hedge.straight/corner` (isometric_tile), Optional `veg.vineTrellis` (map_object), `veg.gardenPlot` (map_object).
- Place in **civic** (Command↔Observatory promenade, plaza edges), **workshop** (Forge Row), **harbor** quay — the lived-in districts, *not* the wild forest. `layer: 'sorted'` for anything tall enough to occlude an agent; `layer: 'cache'` for flat beds.

### A · Sightline preservation (do not break the harmonization)
Raise lived-in density via `VEGETATION_DISTRICTS.*Boost` and the new `flowerBoost`, **not** by lowering `SCENERY_CLEARINGS.strength`. Keep building `scenery.excludePadding`/`sightline` rects intact. Ground decals (A1) are flat and never occlude, so they're sightline-safe by construction — push detail there first.

---

## 4. Workstream B — Land & Air Fauna

**Mirror the existing sea systems** so motion-budget/reduced-motion handling comes for free.

### B1 · Butterflies (day) + fireflies (night) — ParticleSystem
- Add `butterfly` and (optional) `dragonfly` presets next to `firefly` (`ParticleSystem.js:~83`): warmer/brighter colors, `gravity:false`, slow wander, longer `life`. `spawn()` already early-returns when `!motionEnabled` (`~232`), so reduced-motion is handled.
- Gate day vs night in `SeasonalAmbience.js` (which already feeds the pool): read the day/night phase from the atmosphere snapshot (`AtmosphereState` `phase` ∈ day/dusk/night/dawn; also exposed at `window.__claudeVilleAtmosphere`). Day → `butterfly`, night → `firefly`. Keep the existing seasonal logic as the base cadence; this just swaps the inland type by phase.
- Spawn over **grass/garden tiles in the lived-in zone** (bias toward the new flower scatter from A2), not over water.
- **Motion budget:** honor `docs/motion-budget.md` — check `motionScale` before allocating, declare a pulse band, ship the existing static fallback (`SeasonalAmbience` already draws a static set under reduced motion).

### B2 · Songbirds flitting between trees — clone of the gull system
The gull system is a reusable template: route interpolation `_pointOnGullRoute()` (`~6755`), flap frame cycle `Math.floor(now*…)%GULL_FLIGHT_FRAMES.length` (`~7092`), altitude/parallax (`y = worldY - altitudePx`), banking via tangent, reduced-motion static fallback (`~7070`), drawn **screen-space** in `WorldFrameRenderer.js` (`~67-69`) before agents.
- Add `_drawLandBirds()` and call it next to `_drawOpenSeaGulls` in `WorldFrameRenderer.js`.
- Config in `scenery.js`: `LAND_BIRD_ROUTES` (short hops between tree clusters in the inhabited belt) + frame constants, modeled on `OPEN_SEA_FLOCK_ROUTES`/`GULL_FLIGHT_FRAMES`. Smaller, slower, lower-altitude, 1–2 birds per route (songbirds, not flocks).
- Sprites: `prop.songbird.up/level/down/bank` + fallback `prop.songbird` — `map_object`, `size: 32`, `anchor: [16,18]` (**exact mirror of `prop.gullFlight.*`**; cheap, no `create_character`).

---

## 5. Workstream C — Water & Shore Life

**Clone of the fish-school system** (`_drawFishSchools`, `IsometricRenderer.js:~6661-6684`; config `MARINE_FISH_SCHOOLS`, `scenery.js:661-667`). Fish use sine/cos drift, `screen` blend, alpha 0.48, gated on `waterTiles`/`lagoonWaterTiles` minus `deepWaterTiles`/bridges.

### C1 · Calm-water fauna (ducks/koi) — lagoon
- New `_drawCalmWaterFauna()` (or extend `_drawFishSchools`) targeting `lagoonWaterTiles`, rejecting `deepWaterTiles`. Slower motion (halve the `1.4`/`0.9` rates), normal (non-`screen`) blend for ducks so they read on the surface.
- Config `CALM_WATER_FAUNA = [{ tileX, tileY, id, radius, phase }]` placed on the central lagoon/lily basin (around `17,22`) and NW lagoon.
- Sprites: `prop.duck` (+ optional `prop.duck.paddle`), reuse `prop.fishSchoolKoi` for koi.

### C2 · Shore fauna (frog or heron)
- Target `shoreTiles` (land adjacent to water, precomputed in `SceneryEngine`'s shoreline pass). Static-or-gently-bobbing placement (heron near reeds, frog on lilypads).
- Sprites: `prop.heron` (map_object 32–48px) or `prop.frog` (isometric_tile 32px). Core ships **one**; the other is optional.

---

## 6. Workstream D — Walls, Gate & Map Edges

**Confirmed: art upgrade (regen), not just polish — see Decision 4.** This is the heaviest workstream and carries the harmonization's calibration risk; budget the bulk of D's time here.

### D1 · Wall — new tiling sprite + decoration
- **Regen:** replace the repetitive procedural plank fill with a **new tiling wall-segment sprite** (`prop.villageWall.segment`, `create_map_object`, on the style contract) blitted along each route in `_buildVillageWallSprites()` (`~3659-3692`). Keep the procedural stone footing (`_drawVillageWallStoneFooting`, `~4533`) or fold it into the sprite — decide once the sprite exists.
- **Decorate:** mounted braziers/torches at fixed intervals (palette `lantern`/`glow`, `~198-222`), ivy/moss on stone footing (`~4570`, palette `moss`), low shrub footing reusing `veg.bush.*`. Add as child drawables in the `_buildVillageWallSprites` closure so they inherit occlusion sorting.
- **Calibration:** re-measure `sortY` and any emitter/light coords pinned to the old procedural geometry (torch glow positions).

### D2 · Gate — new hero sprite + recalibrated overlay + approach
- **Regen:** new **gate hero sprite** (`prop.villageGate`, `create_map_object` ≤400px, style contract, `key-out-bg.mjs`). Then **recalibrate** the procedural door/tower/arch overlay (`_drawVillageGatehouse` `~3823`, `_drawVillageGateArch` `~4068`, `_drawVillageGateDoors` `~4199`) to the new sprite — `VILLAGE_GATE_BOUNDS`/`splitY` (`townPlan.js:23-29`), animated-door anchors, and lantern/glow coords all pin to gate pixels (harmonization-style §6.3 checklist applies here).
- **Approach road:** worn dirt/cobble south of `VILLAGE_GATE.outside` (≈ `18.4,39.25`) — extend `TOWN_ROAD_ROUTES` (`townPlan.js:53-108`) with a short south stub (preferred, data-only) or paint in `_drawVillageGatehouse` before the wall calls.
- **Flanking:** arch sconces after the arch stroke (`~4102`); optional shrubs/banner posts beside the gate.

### D3 · Map edge — distant sea / horizon
- The void beyond the diamond is drawn by `_drawWorldEdgeRim()` (`~5910`), after the tile loop (`~3623`). Add `_drawMapBoundaryHorizon()` immediately after it (or extend the rim) to render a **faded sea + horizon band** so the world reads as a coast/island, not a cut-out:
  - A horizon gradient (sky → distant-sea) below/around the diamond, tuned per atmosphere `phase` (day/dusk/night/dawn) so it matches `SkyRenderer`'s palette; optional far-water shimmer reusing `atmosphere.deepSea`/foam sprites and/or the **unused** `atmosphere.fog.wisp.low` (`~1020`) as a low haze where sea meets sky.
  - Keep it behind the world-base shadow/rim so the diamond still sits "above" the sea. Honor reduced motion (static horizon) and existing blend conventions.
  - **Risk:** this paints into the background pass that every frame clears — verify it composites under terrain/water and doesn't fight the existing `_drawDioramaBackdrop`/`_drawWorldBaseShadow` (`~3606-3607`).

---

## 7. New sprite manifest (Core set)

All on `style.anchor` (epic high-fantasy pixel art…). Bump `style.assetVersion` once when PNGs land. Keep `palettes.yaml` parity if any palette block changes (none expected).

| ID | Tool | Size | Anchor | Notes |
| --- | --- | --- | --- | --- |
| `veg.flower.a/b/c` | isometric_tile | 32 | [16,17] | ground scatter (A2) |
| `veg.clover.a/b` | isometric_tile | 32 | [16,16] | ground scatter (A2) |
| `veg.flowerBed.a/b` | create_map_object | 32–48 | [16,24] | cultivated (A3); **run `key-out-bg.mjs`** |
| `veg.planter` | isometric_tile | 32 | [16,26] | cultivated (A3) |
| `veg.hedge.straight/corner` | isometric_tile | 32 | [16,22] | cultivated (A3) |
| `prop.songbird` (+ `.up/.level/.down/.bank`) | create_map_object | 32 | [16,18] | mirror `prop.gullFlight.*` (B2); key-out-bg |
| `prop.duck` (+ optional `.paddle`) | create_map_object | 32 | [16,18] | calm water (C1); key-out-bg |
| `prop.heron` *or* `prop.frog` | map_object / iso_tile | 32–48 | [16,22] | shore (C2) |
| `prop.villageGate` (regen) | create_map_object | ≤400 | (re-derive) | gate hero (D2); **key-out-bg + overlay recalibration** |
| `prop.villageWall.segment` | create_map_object | tiling | (re-derive) | wall tiling sprite (D1); key-out-bg |

Distant-sea/horizon (D3) needs **no new sprite** — it's a procedural gradient, optionally reusing `atmosphere.deepSea` / foam / the unused `atmosphere.fog.wisp.low`.

Optional set (only if in scope): `veg.vineTrellis`, `veg.gardenPlot`, `prop.dragonfly*`, `prop.swan`, `prop.crab`, `prop.rabbit`, wall `prop.wallBanner`.

Butterflies/fireflies need **no sprite** (ParticleSystem draws them). That keeps generation count low.

---

## 8. Art approach (Mix) + generation workflow

Per confirmed scope: **procedural for ground tone/decals (A1, parts of D), PixelLab for plants + fauna.** Per-sprite loop (`scripts/sprites/generate.md`):

1. Add manifest entry (`id`, `tool`, `prompt` = subject only; `style.anchor` is auto-prepended; `size`/`anchor`).
2. `npm run sprites:plan -- --ids=<id>` (dry run; confirms path + prompt).
3. Generate via PixelLab MCP: `create_isometric_tile` (use **thin tile** shape for flat ground detail to avoid depth clipping), `create_map_object` (props/fauna; transparent intent but MCP flattens on grey).
4. Save to the manifest-implied path; for every `create_map_object` output run `node scripts/sprites/key-out-bg.mjs <path>` (the grey-background fix).
5. `npm run sprites:validate` (manifest ↔ PNG bidirectional, no orphans/dupes, palette parity).
6. Bump `style.assetVersion` once for the batch.
7. `npm run sprites:capture-fresh` then `npm run sprites:visual-diff`; commit intentional new baselines.

`get_balance` once before the batch (well under the Tier-3 budget; < 30 gens).

---

## 9. Render integration hook table

| Change | File · hook (re-verify line) | Type |
| --- | --- | --- |
| Ground decals bake | `IsometricRenderer.js` `_drawTile` `~5289-5326` / `_drawStaticTerrainSurface` `~3602` | procedural, cache |
| Flower/clover scatter | `SceneryEngine.js` new Maps `~31` + flat pass `~565`; `IsometricRenderer._drawTile` `~5317` | sprite, cache |
| Cultivated props | `scenery.js` `DISTRICT_PROPS` `:412-464` (data only) | sprite, placed |
| Butterfly/firefly presets | `ParticleSystem.js` `~83`; gate in `SeasonalAmbience.js` | procedural |
| Songbird system | new `_drawLandBirds`; call in `WorldFrameRenderer.js` `~67-69`; config in `scenery.js` | sprite, screen-space |
| Calm-water / shore fauna | new `_drawCalmWaterFauna` near `_drawFishSchools` `~6661`; config in `scenery.js` | sprite, screen-space |
| Wall decoration | `IsometricRenderer.js` `_drawVillageWallSegment` `~4346` / `_buildVillageWallSprites` `~3659` / footing `~4533` | procedural + sprite |
| Gate approach + sconces | `_drawVillageGatehouse` `~3823` / `_drawVillageGateArch` `~4068`; `townPlan.js` `TOWN_ROAD_ROUTES` | procedural |
| Map-edge mist | new `_drawMapBoundaryMist` after `_drawWorldEdgeRim` `~5910`; reuse `atmosphere.fog.wisp.low` | sprite/procedural |

---

## 10. Risk register

| Risk | Mitigation |
| --- | --- |
| **Sightline regression** (densifying the core re-hides buildings the harmonization just cleared) | Push detail into flat ground decals (never occlude); raise density via `*Boost`, not by cutting `SCENERY_CLEARINGS`; keep `excludePadding`/`sightline`; QA each district at zoom 1–3. |
| **Motion budget blown** (butterflies + birds + ducks + existing gulls/fish) | Cap counts; reuse `motionScale`/pulse-band/reduced-motion patterns from gulls/fish/particles; verify under `prefers-reduced-motion` (static fallbacks). Follow `docs/motion-budget.md`. |
| **Terrain-cache cost** (decals inflate cache build) | Decals are baked once per cache rebuild, not per frame; keep them simple draws; watch the `terrainCache` limit warning path. |
| **`create_map_object` grey background** | Mandatory `key-out-bg.mjs` on every map_object PNG (the documented fix). |
| **Manifest ↔ PNG / assetVersion drift** | Add manifest entry + PNG in the same change; `sprites:validate`; bump `assetVersion` once; mirror `palettes.yaml` if touched. |
| **Occlusion / draw-order** | Tall placed plants use `layer:'sorted'`; flat decals `layer:'cache'`; fauna stay in the existing screen-space pass (above terrain, below agents). |
| **Night legibility** (captures were night; detail can wash out) | QA across day/dusk/night/dawn phases; tune decal alpha against `_drawDistrictAtmosphere` multiply wash. |

---

## 11. Execution — coordinated multi-agent pass (Decision 3)

`IsometricRenderer.js`, `manifest.yaml`, and `scenery.js` are touched by **all** workstreams, so they cannot be owned in parallel. Structure the swarm as **serial foundation → parallel build → serial integration** (the documented swarm pattern):

**Phase 0 — Serial foundation (one owner, no fan-out, no credits):**
- Add **every** new manifest entry (Appendix B) in one edit; bump `assetVersion` once.
- Add **all** config scaffolding: `scenery.js` (`FLOWER_DENSITY`, flower/clover Maps wiring, cultivated `DISTRICT_PROPS`, `LAND_BIRD_ROUTES`, `CALM_WATER_FAUNA`, shore fauna, fauna frame constants), `townPlan.js` (gate approach road stub).
- Stub the **owned draw-functions + call-sites** in `IsometricRenderer.js` / `WorldFrameRenderer.js`: ground-decal block in `_drawTile`, `_drawLandBirds`, `_drawCalmWaterFauna`, `_drawMapBoundaryHorizon`, wall-sprite blit hook. Each workstream then fills a **disjoint function body** — no two agents edit the same region.
- Commit the foundation. This is the synchronization barrier.

**Phase 1 — Parallel sprite generation (fan-out, worktree-isolated, writes only disjoint PNG paths):** one agent per sprite batch (ground veg / cultivated plants / fauna frames / gate+wall hero). `get_balance` first; each runs `key-out-bg.mjs` + `sprites:validate` on its own PNGs. PNG paths never collide.

**Phase 2 — Parallel implementation (fan-out by exclusive ownership, worktree-isolated):**
- **Agent A (ground):** `SceneryEngine.js` Maps + flat pass; fill `_drawTile` decal block + flower/clover scatter; cultivated-prop placement.
- **Agent B (fauna):** `ParticleSystem.js` presets; `SeasonalAmbience.js` day/night gate; fill `_drawLandBirds`.
- **Agent C (water):** fill `_drawCalmWaterFauna`; shore fauna.
- **Agent D (wall/gate/edge):** wall-segment sprite blit + decoration; gate overlay recalibration; fill `_drawMapBoundaryHorizon`. **D owns the most pixel-calibration risk — give it the §6.3 checklist and the most QA.**

**Phase 3 — Serial integration + QA (one owner):** merge worktrees, resolve any `manifest.yaml`/shared-file overlap, then the full §12 validation: World at zoom 1/2/3 across day/dusk/night/dawn, reduced-motion fallbacks, sightlines to all nine buildings, no FPS regression, `sprites:validate` + `visual-diff` baselines. Commit per workstream where clean; one integration commit for the shared wiring.

> **Human-in-the-loop:** sprite art acceptance, placement-density tuning, gate-overlay recalibration, and motion/day-night QA are inherently eyes-on (the harmonization plan flagged the same). The swarm drafts up to these gates; expect a review beat after Phase 2.

---

## 12. Validation gates

- `npm run sprites:validate` — after any manifest/PNG change.
- `npm run sprites:capture-fresh` + `npm run sprites:visual-diff` — intentional new baselines; commit them.
- `npm run world:validate-terrain` / `world:validate-buildings` — after scenery/placement edits.
- `node --check` any edited `.js` under `src/` is implicit (no app test runner); reload and watch the console for sprite-load warnings (missing PNG → checker fallback).
- In-app: World mode renders; new ground reads richer between buildings; fauna animate and fall back to static under `prefers-reduced-motion`; sightlines to all nine buildings intact; wall/gate/edge improved; no FPS regression (`fps:updated`).
- English-only copy gate for any new comments/docs.

---

## 13. Rollout

- Land per-workstream commits (each reviewable/revertible).
- **Before pushing:** prepend a `CHANGELOG.md` entry — **v0.16.0 — _Birdsong & Bloom_** (major milestone; final name negotiable) — and bump the version in `claudeville/index.html` `.topbar__version` (`v0.16`) and `package.json` (`0.16.0`). Current shipped version verified as **v0.15.0** (*The Stonemason's Charter*).
- Update the `agents/README.md` index row (Appendix C) and flip status `ready → historical` when executed.

---

## Appendix A — Source references
- Ground/terrain bake: `IsometricRenderer.js` `_drawStaticTerrainSurface` `~3602`, `_drawTile` `~5289-5326`; flat-feature gen `SceneryEngine.js` `~565`, Maps `~31`.
- Density/clearings: `scenery.js` `BUSH_DENSITY`/`GRASS_TUFT_DENSITY` `:673-674`, `VEGETATION_DISTRICTS` `:355-362`, `SCENERY_CLEARINGS` `:376-390`, `SHORELINE_VEGETATION` `:366-371`; building `scenery.excludePadding`/`sightline` in `buildings.js`.
- Props: `DISTRICT_PROPS` `scenery.js:412-464`, `AMBIENT_GROUND_PROPS` `:466-491`.
- Gull system: `IsometricRenderer.js` `_drawOpenSeaGulls` `~7008`, `_pointOnGullRoute` `~6755`, watchtower orbit `~7070`; config `scenery.js:508-659`.
- Fish system: `_drawFishSchools` `~6661-6684`; `MARINE_FISH_SCHOOLS` `scenery.js:661-667`.
- Particles: `ParticleSystem.js` `firefly` `~83`, `spawn`/`setMotionEnabled` `~225-303`; `SeasonalAmbience.js`; `AtmosphereState` `phase`.
- Walls/gate: `_drawVillageWallSegment` `~4346`, `_drawVillageWallStoneFooting` `~4533`, `_buildVillageWallSprites` `~3659`, `_drawVillageGatehouse` `~3823`, `_drawVillageGateArch` `~4068`, `_drawVillageGateDoors` `~4199`; palettes `~198-222`; `townPlan.js` `VILLAGE_GATE`/`VILLAGE_WALL_ROUTES` `:14-51`, `TOWN_ROAD_ROUTES` `:53-108`.
- Map edge: `_drawWorldEdgeRim` `~5910`; `atmosphere.fog.wisp.low` manifest `~1020` (unused).
- Draw order: `WorldFrameRenderer.js` `~54-207`; `DrawablePass.js` `KIND_ORDER`.
- Workflow: `scripts/sprites/generate.md`, `docs/pixellab-reference.md`, `scripts/sprites/key-out-bg.mjs`, `docs/motion-budget.md`, `docs/building-style-contract.md`.

## Appendix B — New manifest IDs (Core)
`veg.flower.a/b/c`, `veg.clover.a/b`, `veg.flowerBed.a/b`, `veg.planter`, `veg.hedge.straight/corner`, `prop.songbird[.up/.level/.down/.bank]`, `prop.duck[.paddle]`, `prop.heron`|`prop.frog`. (Particles: `butterfly`, `dragonfly` presets — no sprite.)

## Appendix C — agents/README.md index row
```
| [plans/claudeville-atmosphere-life-upgrade-plan.md](plans/claudeville-atmosphere-life-upgrade-plan.md) | ready | 2026-06-15 | live source + scenery.js/manifest.yaml + 3 baseline screenshots | After fresh baseline; phased §11 | sprites:validate, world:validate-terrain/buildings, capture/visual-diff; motion-budget + reduced-motion per item |
```
