# ClaudeVille Atmosphere Epic Ramp-Up

Date: 2026-04-27
Status: execution-ready plan, updated after specialist and reviewer feedback
Scope: world-mode decoration, vegetation, marine life, overlap prevention, sprite-generation workflow

## Baseline

Current `HEAD`: `db1a36497f6afd809625aa4593601bdc5c7d6b9f`

Current dirty state observed before planning:

```text
 M claudeville/assets/sprites/manifest.yaml
 M claudeville/src/presentation/shared/ModelVisualIdentity.js
?? .codex
?? claudeville/assets/sprites/characters/agent.codex.gpt55.high/
?? claudeville/assets/sprites/characters/agent.codex.gpt55.xhigh/
?? taskboard-hero-smoke.png
```

Treat these as pre-existing. Do not revert, stage, delete, or absorb them unless a later execution task explicitly takes ownership.

Pixellab smoke gate completed successfully with `create_isometric_tile` for an ancient rune fountain concept:

```text
tile_id: 5b8878ec-2a63-4eae-b357-c8551ea140e7
status: completed
size: 32x32
download: https://api.pixellab.ai/mcp/isometric-tile/5b8878ec-2a63-4eae-b357-c8551ea140e7/download
```

The output was not downloaded or saved to the repo. This proves tool reachability but not final asset quality. Any execution phase that writes PNGs must still complete the normal poll -> download with `curl --fail` -> `file` -> `npm run sprites:validate` loop.

## Strategic Diagnosis

The world already has a strong macro structure: authored water masses, forest regions, waterfalls, bridges, landmark buildings, particles, and light overlays. The weakest layer is not the hero buildings; it is the middle-distance decoration and ecology layer.

Current decoration reads as useful village props rather than epic RPG worldbuilding. Existing `prop.*` assets are mostly lanterns, signposts, runestones, crates, carts, wells, stalls, cargo, docks, boats, and cranes. They do not yet form district-specific scenes around each landmark.

Current vegetation has density and movement but not enough mythic specificity. Trees are mostly oak, pine, willow, palm, broadleaf, bush, tuft, reed, and boulder. Some large procedural trees are visually effective, but authored tropical trees can overlap buildings because they bypass the same placement exclusions used by generated trees.

Current sea atmosphere has good water rendering but limited life. Open-sea birds are five procedural V strokes. Boats are mostly semantic commit/push ships. Fish, reefs, idle boats, buoys, nets, shells, tide pools, and ambient marine motion are absent.

The biggest technical risk is overlap, not asset count. Tall tree sprites and procedural palms are point-sorted by anchor `y`; footprint-only exclusion does not protect a building's visual silhouette. A decoration ramp-up must fix placement safety first.

## Design Target

ClaudeVille should read as a small, inhabited epic-fantasy RPG settlement:

- Every landmark has a surrounding scene kit that tells its story before the label is read.
- Forests feel like elderwood, not generic green filler.
- The harbor feels alive even with no git events.
- Decorative props reinforce system meaning: command, research, archive, portal, forge, mine, harbor.
- High-silhouette props are Y-sorted or sightline-safe.
- Low props can stay in the terrain cache.
- Water life stays low contrast and never competes with agent status rings, building labels, or commit pennants.

## Execution Rules

Use the swarm SOP for implementation because this is multi-slice work. Keep active subagents at five or fewer.

Default ownership:

- Orchestrator: sequencing, status checks, integration, validation, final report.
- Placement worker: `claudeville/src/config/scenery.js`, `claudeville/src/config/buildings.js`, overlap/sightline logic.
- Renderer worker: `claudeville/src/presentation/character-mode/IsometricRenderer.js`, optional `DebugOverlay.js`.
- Manifest/asset worker: `claudeville/assets/sprites/manifest.yaml`, generated PNG paths.
- QA/reviewer: browser screenshots, sprite validation, overlap review.

Do not allow overlapping write ownership. If `manifest.yaml` remains dirty before execution, inspect its diff and either explicitly take ownership or defer manifest edits.

Before adding new sprite IDs, require one of these gates:

- clean/passing sprite baseline, or
- explicit ownership of the current dirty `manifest.yaml` changes and a documented decision to include them.

`npm run sprites:validate` fails on missing expected PNGs and invalid character sheets, but only warns on orphan PNGs. Treat orphan PNG warnings as a manual review gate for this work even if the script exits `0`.

## Phase 0: Contract And Baseline Audit

Goal: make the current state measurable before edits.

Read-only commands:

```bash
git status --short
git diff -- claudeville/assets/sprites/manifest.yaml claudeville/src/presentation/shared/ModelVisualIdentity.js
npm run sprites:validate
```

If `node_modules/` is absent and asset validation is in scope, run `npm install` first.

Also create contact sheets or image inventory for:

- `claudeville/assets/sprites/props/*.png`
- `claudeville/assets/sprites/vegetation/*.png`
- `claudeville/assets/sprites/bridges/*.png`
- `claudeville/assets/sprites/atmosphere/*.png`

Acceptance:

- Existing dirty changes are classified as in-scope or unrelated.
- Current missing/orphan sprite status is known.
- Weakest existing PNGs are ranked before any regeneration.
- The Pixellab smoke tile has either completed or is explicitly treated as unavailable.

## Phase 1: Fix Placement Safety Before Adding Decoration

Goal: stop decoration from covering buildings and entrances.

Files:

- `claudeville/src/domain/entities/Building.js` if metadata is stored on building instances
- `claudeville/src/config/buildings.js`
- `claudeville/src/config/scenery.js`
- `claudeville/src/presentation/character-mode/SceneryEngine.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `claudeville/src/presentation/character-mode/DebugOverlay.js`

Implementation:

1. Choose one metadata path and implement it fully:

- Option A: add per-building scenery safety metadata in `BUILDING_DEFS` and update `Building` to preserve it, because `SceneryEngine` reads `world.buildings`, not raw `BUILDING_DEFS`.
- Option B: keep building entities unchanged and add a separate scenery-safety config exported from `scenery.js`, keyed by building `type`, which `SceneryEngine` consumes directly.

Option A example:

```js
scenery: {
    excludePadding: { x: 1, y: 1 },
    sightline: { x0: 31, y0: 16, x1: 38, y1: 22 },
    tallPropClearance: 2,
}
```

Use conservative first-pass envelopes for:

- `harbor`: protect the north edge and entrance around `(31,20)`.
- `watchtower`: protect the lighthouse silhouette and beacon side.
- `archive`: replace the current archive-only custom rule with generic metadata.
- `command`: keep skyline and approach visible.
- `observatory`: keep tower and entrance clear.

2. Add shared scenery predicates in `SceneryEngine`:

- `isBlockedForFlatScenery(tileX, tileY, pathTiles, bridgeTiles)`
- `isBlockedForTallScenery(tileX, tileY, pathTiles, bridgeTiles, options)`
- `clearsBuildingSightlines(tileX, tileY, kindOrHeight)`

Replace existing call sites explicitly:

- `generateFlatVegetation()` should call `isBlockedForFlatScenery()`.
- `generateTrees()` should call `isBlockedForTallScenery()` before jitter and again after jittered anchor selection, so a trunk that moves into a sightline is rejected.
- `generateBoulders()` should call the appropriate flat/tall predicate based on boulder size.
- Authored `TROPICAL_PALMS` and `TROPICAL_BROADLEAF_TREES` should call `isBlockedForTallScenery()` in `IsometricRenderer` or be moved into `SceneryEngine` so all tall vegetation shares one placement path.

3. Apply the same tall-scenery predicate to authored `TROPICAL_PALMS` and `TROPICAL_BROADLEAF_TREES`. Today they only check water in `IsometricRenderer`, so they bypass path, bridge, footprint, and sightline exclusions.

4. Split tall props from low props:

- low cache props: flowers, tufts, small stones, reeds, small shell piles, tiny ripple sprites;
- tall Y-sorted props: trees, root arches, banner towers, pylons, large boulders, idle boats, high buoys.

5. Extend `DebugOverlay.js` to show building footprints, sightline envelopes, tree anchors, and optional tall-prop bounds. Keep it behind `Shift+D`. The current overlay only draws walkability, bridges, and agent waypoints, so this is a real implementation task, not optional polish.

Acceptance:

- The two screenshot failures are addressed: trees no longer cover Harbor Master or Command Center silhouettes.
- Generated forest density remains visually rich.
- All building entrances and `visitTiles` remain reachable.
- Agents do not path through non-walkable water or building footprints.

Validation:

```bash
node --check claudeville/src/config/buildings.js
node --check claudeville/src/config/scenery.js
node --check claudeville/src/domain/entities/Building.js
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
node --check claudeville/src/presentation/character-mode/DebugOverlay.js
npm run dev
```

Browser smoke:

- World mode at zoom `1`, `2`, `3`.
- Inspect all nine landmarks.
- Toggle debug overlay and verify envelopes match visible risk zones.
- Select/deselect an agent to ensure labels and activity panel still behave.

## Phase 2: Art Bible And Asset Taxonomy

Goal: freeze prompts and IDs before generating batches.

Rules:

- Reuse the manifest style anchor.
- Transparent standalone props must include: `transparent background only, isolated sprite, no ground tile, no square base, no platform, no baked shadow, empty transparent corners`.
- Favor silhouette-first assets over tiny texture detail.
- Avoid adding a new manifest section unless `AssetManager._flattenManifest()` and `_pathFor()` are updated. Prefer existing prefixes:
  - `prop.*` -> `assets/sprites/props/<id>.png`
  - `veg.*` -> `assets/sprites/vegetation/<id>.png`
  - `atmosphere.*` -> `assets/sprites/atmosphere/<id>.png`

District scene kits:

| District | Visual Story | Core Props |
| --- | --- | --- |
| Command | war council, routing, orders | `prop.warBannerTower`, `prop.runeBrazier`, upgraded guardposts |
| Archive | scholarly terrace, memory, lore | `prop.archiveLectern`, `prop.scrollCrates`, `atmosphere.archive.dustbeam` |
| Observatory | research instruments, external watch | `prop.starChartTripod`, `prop.arcanePylon`, pale motes |
| Portal | ritual grove, remote tools | `prop.portalOfferingAltar`, `veg.root.arch`, `atmosphere.portal.rune-drift` |
| Forge | heat, production, metalwork | `prop.forgeBellows`, `prop.emberCoalBin`, stronger fire glow |
| Mine | resource extraction, token cost | `prop.mineCrystalCluster`, `prop.oreCart`, `prop.mineLantern` |
| Harbor | living quay, lighthouse coast | `prop.harborBeaconBuoy`, `prop.fishingSkiff`, `prop.netRack`, reefs/fish |
| Elderwood | ancient nature, storybook edge | `veg.mushroom.giant`, `veg.stump.runes`, `veg.flower.mana` |

## Phase 3: Generate One Benchmark Asset Per Class

Goal: prove Pixellab quality before broad generation.

Benchmark assets:

1. `prop.runeBrazier`, `size: 32` or `48`.
2. `veg.root.arch`, `size: 64`.
3. `prop.fishSchoolTeal`, `size: 32`.
4. `prop.gullFlight`, `size: 32`.

Use `prop.*` for marine assets unless a later phase updates `AssetManager` for a dedicated `marine.*` prefix.

Example manifest entries:

```yaml
  - id: prop.runeBrazier
    tool: isometric_tile
    prompt: "ancient stone rune brazier, blue-gold magical flame, carved dragon feet, heroic fantasy RPG prop, transparent background only, isolated sprite, no ground tile, no square base, no platform, no baked shadow, empty transparent corners"
    size: 48
    anchor: [24, 38]

  - id: veg.root.arch
    tool: isometric_tile
    prompt: "ancient twisted tree-root arch, moss, hanging amber charms, readable elderwood fantasy silhouette, transparent background only, isolated sprite, no ground tile, no square base, no platform, no baked shadow, empty transparent corners"
    size: 64
    anchor: [32, 58]

  - id: prop.fishSchoolTeal
    tool: isometric_tile
    prompt: "small school of bright teal fish silhouettes just below clear tropical water surface, subtle sparkle, transparent background only, no water tile, no square base, empty transparent corners"
    size: 32
    anchor: [16, 18]

  - id: prop.gullFlight
    tool: isometric_tile
    prompt: "white sea gull in mid flight, wings spread, tiny readable fantasy pixel art silhouette, transparent background only, no sky tile, no square base, empty transparent corners"
    size: 32
    anchor: [16, 18]
```

Generation workflow:

1. Start with one asset.
2. Poll until completed.
3. Download with `curl --fail`.
4. Save to manifest-implied path.
5. Run `file <png>` and a dimension check.
6. Check transparent corners manually or with a small PNG script.
7. Run `npm run sprites:validate` and manually review orphan warnings.
8. Review in contact sheet and browser.
9. Only then batch the next class.

Acceptance:

- All benchmark PNGs match manifest dimensions.
- Corners are transparent.
- No base tile/platform is baked in.
- Each asset reads at zoom `1`.

## Phase 4: Implement District Decoration Placement

Goal: add story props around landmarks without clutter.

Files:

- `claudeville/src/config/scenery.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `claudeville/assets/sprites/manifest.yaml`
- generated PNGs under `claudeville/assets/sprites/props/`, `vegetation/`, `atmosphere/`

Add authored exports:

```js
export const DISTRICT_PROPS = [
    { tileX, tileY, id: 'prop.runeBrazier', layer: 'sorted', district: 'command' },
    { tileX, tileY, id: 'prop.archiveLectern', layer: 'cache', district: 'archive' },
];
```

Rendering rules:

- `layer: 'cache'`: draw into terrain cache after water/ground details and before world rim.
- `layer: 'sorted'`: do not silently mix into the agent/tree/boulder list unless every caller is audited. Prefer a separate `districtPropSprites` list and add explicit drawables with `kind: 'district-prop'` in the render loop, matching the existing `harbor-traffic` and `landmark-activity` pattern.
- High props must pass Phase 1 sightline predicates.
- Low props near paths can be decorative but must not hide road readability.

Suggested first placements:

- Command: two `prop.warBannerTower`, two `prop.runeBrazier`, one upgraded guardpost cluster.
- Archive: `prop.archiveLectern`, `atmosphere.archive.dustbeam`, scroll crates.
- Portal: `prop.portalOfferingAltar`, `veg.root.arch`, `veg.flower.mana`.
- Forge/Mine: `prop.forgeBellows`, `prop.mineCrystalCluster`, `prop.emberCoalBin`.
- Harbor: `prop.harborBeaconBuoy`, `prop.netRack`, `prop.fishingSkiff`, `prop.rowboat`.

Acceptance:

- Each landmark has one or two meaningful props, not blanket scattering.
- No prop occludes a landmark label, entrance, or agent status ring.
- The world still reads cleanly at zoom `1`.

## Phase 5: Marine Life And Sea Atmosphere

Goal: make the sea alive while preserving harbor semantics.

Manifest assets, using `prop.*` unless loader support is extended:

```yaml
prop.fishSchoolTeal
prop.fishSchoolGold
prop.coralReefA
prop.submergedReefRocks
prop.gullFlight
prop.gullShadow
prop.fishingSkiff
prop.rowboat
prop.netRack
prop.harborBeaconBuoy
prop.waterRippleRing
atmosphere.harbor.sea-sparkle
```

Static cached marine props:

- reefs at shallow/open edge water: around `(34.4,14.8)`, `(36.2,17.2)`, `(31.5,23.4)`, `(25.2,7.4)`, `(18.0,10.8)`;
- net racks and buoys around harbor shore and docks;
- low-contrast sparkle overlays on open water.

Dynamic marine pass:

- 8-12 fish schools in shallow non-deep water.
- 4-6 sprite gulls replacing the current V strokes.
- 2-3 idle boats, separate from `HarborTraffic` commit ships.
- Cap and skip based on `motionScale`.

Implementation touchpoints:

- Add authored marine exports in `scenery.js`.
- Import them in `IsometricRenderer.js`.
- Draw static reefs/shore props in terrain cache near existing water structure cache work.
- Replace `_drawOpenSeaGulls()` with `_drawOpenSeaBirds()` using sprite IDs and optional shadow.
- Add `_drawFishSchools()` after `_drawTerrain()` and before building sorting.
- Add idle boats as sorted drawables if they can overlap docks/buildings.
- Keep animated dust, rune drift, fish movement, and birds out of terrain-cache-only passes. The terrain cache is built with static motion behavior, so animated atmosphere should be drawn per frame or via particles.

Acceptance:

- Sea reads alive when there are zero commit ships.
- Commit ships, push departures, labels, and failure markers remain visually dominant.
- No high-contrast fish/bird effects near agent overlays or harbor labels.

## Phase 6: Vegetation Quality Pass

Goal: refine vegetation from naturalistic filler to mythic elderwood.

Targets:

- Regenerate existing bushes as underbrush with no baked ground tile.
- Consider larger `96x96` large tree sprites only after overlap safeguards are proven.
- Add new mythic vegetation:
  - `veg.root.arch`
  - `veg.flower.mana`
  - `veg.mushroom.giant`
  - `veg.stump.runes`
  - optional `veg.forest.fern.cluster`

Renderer:

- Keep small vegetation cached/flat.
- Y-sort root arches and giant mushrooms.
- Use district and shoreline placement, not uniform scattering.

Acceptance:

- Forest becomes more story-rich without becoming a wall over buildings.
- The north forest still has density but civic/harbor silhouettes stay readable.

## Phase 7: Existing Asset Regeneration

Goal: improve basic visible assets after new placement proves safe.

Candidates:

- `prop.lantern`: taller fantasy street relic.
- `prop.signpost`: guild crests and route markers.
- `prop.runestone`: larger silhouette and clearer glow.
- `bridge.ew`, `bridge.ns`: carved timber bridge with rune stone caps.
- `dock.ew`, `dock.ns`: brass lanterns, rope coils, shell/anchor motifs.
- `veg.bush.*`: richer underbrush.
- `veg.tree.*`: only if Phase 1 sightlines are in place.

Acceptance:

- Existing IDs keep paths and runtime references stable.
- `style.assetVersion` is bumped after changed PNGs.
- `manifest.yaml` and `palettes.yaml` remain in sync if palette keys change.

## Phase 8: Browser And Visual QA

Commands:

```bash
git status --short
node --check claudeville/server.js
find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check
find claudeville/src -name '*.js' -print0 | xargs -0 -n1 node --check
npm run sprites:validate
npm run dev
```

Manual asset gates:

- Confirm every touched non-character PNG matches manifest dimensions.
- Confirm transparent corners for standalone props, vegetation, overlays, and atmosphere assets.
- Treat orphan PNG warnings from `sprites:validate` as failures for this project slice unless intentionally documented.

Browser checks:

- `http://localhost:4000`
- World mode and Dashboard mode still switch correctly.
- World mode zoom `1`, `2`, `3`.
- Inspect all nine landmarks.
- Select/deselect an agent.
- Open/close activity panel.
- Resize the browser and confirm canvas fills content.
- Check browser console for changed area.

Visual regression:

```bash
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

If dependencies or baselines are missing, fall back to:

```bash
file claudeville/assets/sprites/path/to/touched.png
```

and manual browser screenshots.

## Review Notes From Specialist Subagents

Visual direction review:

- Macro atmosphere and hero buildings are already strong.
- The weak layer is district-specific middle decoration.
- Add scene kits around landmarks rather than generic prop scatter.
- Large vertical props must be sorted or sightline-safe.

Overlap/placement review:

- Highest-risk bug: authored tropical trees bypass building/path exclusions.
- Footprint-only exclusion is insufficient for tall prop silhouettes.
- Replace archive-only sightline logic with generic building sightline metadata.
- Add debug overlay support for footprints, sightlines, and tree anchors.

Marine review:

- Open-sea birds are procedural V strokes and should become sprites.
- Harbor boats are semantic git-event boats; add separate decorative idle boats.
- Add fish, reefs, buoys, nets, and low-contrast water life.
- Cache static marine props and cap dynamic fish/birds for performance.

Reviewer corrections incorporated:

- Building safety metadata must either be preserved by `Building.js` or loaded directly from config by `SceneryEngine`.
- Existing generated scenery, authored tropical trees, and jittered anchors need explicit shared-predicate migration.
- Sorted district props should have their own drawable kind instead of being implicitly treated like agents.
- Dirty manifest and orphan PNG warnings are hard gates for execution.
- Animated atmosphere should not be cache-only.

## Recommended First Implementation Cut

The first shippable slice should be deliberately small:

1. Phase 1 overlap/sightline fix.
2. One Pixellab benchmark asset: `prop.runeBrazier` or the already-started fountain concept if it completes cleanly.
3. Add 4-6 district props around Command and Harbor only.
4. Replace procedural gulls with `prop.gullFlight` only if the benchmark reads well.
5. Validate with browser screenshots.

This cut directly addresses the screenshots, proves the art pipeline, and creates a reusable pattern before broad sprite generation.
