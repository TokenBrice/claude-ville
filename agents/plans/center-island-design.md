# Center Island Design

Date: 2026-05-01
Status: ready
Baseline HEAD: `7a0b65bffa9760818cb9723c2c4c5c7eaaa6a3d3`
Initial `git status --short`: clean
Final expected `git status --short`: changes only in owned paths plus the new koi sprite asset and manifest entry.

## Scope

Owned paths:

- `claudeville/src/config/scenery.js`
- `claudeville/src/config/townPlan.js`
- `claudeville/assets/sprites/manifest.yaml`
- `claudeville/assets/sprites/prop/fishSchoolKoi.png` (new file)

Read-only paths:

- `claudeville/src/presentation/character-mode/SceneryEngine.js`
- `claudeville/src/presentation/character-mode/Pathfinder.js`
- `claudeville/src/presentation/character-mode/TerrainTileset.js`
- `claudeville/src/config/buildings.js`
- `claudeville/assets/sprites/palettes.yaml`
- `claudeville/assets/sprites/prop/fishSchoolTeal.png` (template reference)

Source docs:

- `claudeville/CLAUDE.md`
- `docs/pixellab-reference.md`
- `scripts/sprites/generate.md`
- `docs/motion-budget.md`

## Goal

Convert the visually empty central plaza (City Center, civic district `[16, 22]`) into a luxuriantly overgrown tropical island interior with a small chatoyant lagoon pool as the focal centerpiece, closing the broken-shore reading between the lighthouse promontory and the portal causeway. Match the inspiration's density-and-shimmer character using existing sprite assets plus one new koi school sprite, with no engine or renderer code changes.

## Non-Goals

- No new building footprints or building moves.
- No engine, renderer, pathfinder, or atmosphere code changes.
- No `TOWN_DISTRICTS` changes in `townPlan.js`; the civic district stays semantically centered at `[16, 22]` even though it visually becomes a grove. Road waypoint edits to `TOWN_ROAD_ROUTES` in the same file are in scope.
- No widget changes.
- No motion-budget changes; new motion (koi school + lagoon ripple) is within existing patterns already used in the lagoon.
- No localization changes.
- No new sprite types beyond the koi school. The hanging-vine drape prop was explicitly deferred.

## Findings By Priority

Critical:

- None.

High:

- The central plaza reads as empty because three systems align to suppress scenery there: no `FOREST_FLOOR_REGIONS` covers it, no `TREE_CLUSTERS` overlaps it, and `SCENERY_CLEARINGS` `north-bank-civic` (centered `[20, 22]`, radius 6.4, strength 0.23) plus `command-skyline` (centered `[20.4, 16]`, radius 4.4, strength 0.22) actively flatten any density that would otherwise appear. All three must change in coordination or the canopy will not render.
- The shore gap between the lighthouse promontory and the portal causeway (highlighted by the user in the source image) is a *land* problem, not a *water* problem. The fix is to add a continuous vegetated bluff across the gap, not to add a new water connection.
- `central-river-bridge` road waypoints `[18, 22]` and `[18, 25]` (`townPlan.js:71`) currently pass through the proposed pool location. They must be re-routed before agents will path correctly.

Medium:

- The chatoyant character of the inspiration comes from many small light-breaking elements packed close together over a still water surface (lily pads, fish flicker, mossy roots, mangrove arches). The composition must use multiple existing surface props together; a bare water basin will not read as chatoyant on its own.
- The existing `prop.fishSchoolTeal` reads as ocean fish; a still inland pool wants warm-palette koi/jewel fish for the canonical chatoyant reading. One new sprite is justified by visual payoff and is low generation risk because it shares the existing teal-school template.
- `SceneryEngine` already excludes path tiles, water tiles, building footprints, and shore tiles from tree placement, so adding tree clusters over a road centerline is safe; the engine carves the road as a clearing automatically. Narrow `SCENERY_CLEARINGS` over the new road bends only need to widen that clearing slightly so the road remains visually readable through dense canopy.

Low:

- The existing `prop.runeFountain` placement at `[16.2, 22.0]` (`scenery.js:334`) is in the path of the new pool. It should be moved a short distance west onto a small vegetated outcrop where it reads as a shrine overlooking the pool rather than sitting in it.

## Plan

### 1. Generate the koi sprite first

Generate `prop.fishSchoolKoi` via `mcp__pixellab__create_isometric_tile` (matching the existing `prop.fishSchoolTeal` manifest entry's `tool: isometric_tile`), `size: 32`, `anchor: [16, 18]`. Prompt: warm orange and white koi silhouettes just below dark green pond water surface, subtle sparkle, transparent background only, no water tile, no square base, empty transparent corners. Save the PNG to `claudeville/assets/sprites/prop/fishSchoolKoi.png`.

Add the corresponding `prop.fishSchoolKoi` entry to `claudeville/assets/sprites/manifest.yaml`, mirroring the existing `prop.fishSchoolTeal` entry's structure exactly: `tool: isometric_tile`, `size: 32`, `anchor: [16, 18]`, with the koi-specific prompt text.

Run `npm run sprites:validate`. The check must pass before any config edit lands.

### 2. Edit `claudeville/src/config/scenery.js`

`WATER_BASINS` — add one entry:

```js
{
    kind: 'river',
    region: 'lagoon',
    surface: 'current',
    weatherProfile: 'lagoon',
    centerX: 17,
    centerY: 22,
    radiusX: 1.6,
    radiusY: 1.2,
    edgeNoise: 0.14,
}
```

`FOREST_FLOOR_REGIONS` — add one entry:

```js
{ name: 'central-isle', centerX: 17, centerY: 22, radiusX: 7, radiusY: 6, base: '#2c5a32', accent: '#6c9a48', strength: 0.95 },
```

`TREE_CLUSTERS` — add three entries:

```js
{ centerX: 14, centerY: 21, radiusX: 4.6, radiusY: 4.0, density: 0.78, palmBias: 0.55 },
{ centerX: 20, centerY: 22, radiusX: 4.4, radiusY: 4.0, density: 0.74, palmBias: 0.50 },
{ centerX: 17, centerY: 19, radiusX: 5.2, radiusY: 3.4, density: 0.70, palmBias: 0.48 },
```

The third cluster (centered `[17, 19]`) deliberately spans the shore-gap bluff and ties it visually into the central canopy.

`TROPICAL_PALMS` — add five entries spread around the pool perimeter at varied scale and seed values, biased to the south and east edges to avoid collision with the rerouted `north-bank-promenade`. Suggested anchors:

- `{ tileX: 14.6, tileY: 23.4, scale: 1.22, seed: 0.34 }`
- `{ tileX: 19.4, tileY: 23.6, scale: 1.18, seed: 0.61 }`
- `{ tileX: 18.5, tileY: 24.6, scale: 1.20, seed: 0.27 }`
- `{ tileX: 15.4, tileY: 20.2, scale: 1.16, seed: 0.82 }`
- `{ tileX: 19.8, tileY: 20.6, scale: 1.24, seed: 0.45 }`

`TROPICAL_BROADLEAF_TREES` — add four entries to give hand-authored silhouettes the noise-driven clusters miss:

- `{ tileX: 13.8, tileY: 22.8, scale: 1.20, seed: 0.18 }`
- `{ tileX: 20.6, tileY: 21.4, scale: 1.16, seed: 0.55 }`
- `{ tileX: 17.6, tileY: 24.4, scale: 1.18, seed: 0.71 }`
- `{ tileX: 22.5, tileY: 13.8, scale: 1.14, seed: 0.39 }` (anchors the shore-gap bluff)

`BOULDERS` — add five entries:

- `{ tileX: 22.0, tileY: 14.0, scale: 1.05, variant: 'b' }` (shore-gap bluff)
- `{ tileX: 23.2, tileY: 13.2, scale: 0.95, variant: 'b' }` (shore-gap bluff)
- `{ tileX: 18.6, tileY: 23.2, scale: 0.90, variant: 'a' }` (south pool edge)
- `{ tileX: 19.0, tileY: 22.4, scale: 1.00, variant: 'a' }` (east pool edge)
- `{ tileX: 16.4, tileY: 23.4, scale: 0.85, variant: 'a' }` (south pool edge)

`MARINE_FISH_SCHOOLS` — add one entry for the koi:

```js
{ tileX: 17.0, tileY: 22.0, id: 'prop.fishSchoolKoi', radius: 0.20, phase: 1.4 },
```

`DISTRICT_PROPS` — modify and add:

- Move the existing `runeFountain` at `[16.2, 22.0]` to `{ tileX: 15.4, tileY: 21.6, id: 'prop.runeFountain', layer: 'cache', district: 'civic' }`.
- Add `{ tileX: 15.0, tileY: 22.4, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' }`.
- Add `{ tileX: 15.6, tileY: 21.0, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' }`.
- Add `{ tileX: 15.2, tileY: 22.2, id: 'prop.runeBrazier', layer: 'cache', district: 'civic' }`.
- Add five `veg.lilypad` entries on the pool surface (e.g. `[17.2, 21.6]`, `[16.6, 22.2]`, `[17.6, 22.4]`, `[17.0, 21.4]`, `[16.8, 22.6]`), `layer: 'cache'`, `district: 'civic'`.
- Add `{ tileX: 17.4, tileY: 22.7, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'civic' }`.
- Add `{ tileX: 16.4, tileY: 21.4, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' }`.
- Add `{ tileX: 16.2, tileY: 22.4, id: 'prop.mangroveRoot.arch', layer: 'sorted', district: 'civic' }`.
- Add `{ tileX: 17.8, tileY: 21.4, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' }`.
- Add `{ tileX: 17.6, tileY: 22.8, id: 'prop.driftwood.log', layer: 'cache', district: 'civic' }`.

`SCENERY_CLEARINGS` — modify and add:

- Delete the `north-bank-civic` entry (currently `centerX: 20, centerY: 22, radius: 6.4, strength: 0.23`).
- Shrink `command-skyline` from `radius: 4.4, strength: 0.22` to `radius: 2.8, strength: 0.15`.
- Add `{ name: 'isle-promenade-bend', centerX: 14, centerY: 21, radius: 1.6, strength: 0.5 }`.
- Add `{ name: 'isle-bridge-bend', centerX: 20, centerY: 23, radius: 1.8, strength: 0.5 }`.

### 3. Edit `claudeville/src/config/townPlan.js`

`north-bank-promenade` — insert one waypoint at `[14, 21]` between `[10, 20]` and `[16, 20]`:

```js
points: [[7, 23], [10, 20], [14, 21], [16, 20], [23, 18], [28, 16], [29, 13]],
```

`central-river-bridge` — re-route the pool-crossing segment east of the pool:

```js
points: [[16, 20], [19, 21], [20, 23], [19, 26], [18, 27], [24, 31], [24, 37]],
```

The downstream segment from `[18, 27]` onward is unchanged so the river-bridge crossing and the gate-avenue connection at `[18, 27]` are preserved.

`gate-avenue` — unchanged.

### 4. Validate

Run the validation steps in the order listed below.

## Execution Readiness

Safe to execute: partial. Sprite generation is the only step with meaningful variance; if the koi sprite quality is unacceptable after a small number of regeneration attempts, downgrade by reusing `prop.fishSchoolTeal` for the central pool school and ship the rest of the design as-is (the chatoyant composition still works, just with cooler-toned fish).

Required preflight:

- Re-run `git status --short`.
- Re-check owned paths for unrelated edits.
- Confirm `claudeville/assets/sprites/prop/fishSchoolTeal.png` still exists and matches its manifest entry.
- Confirm civic district anchor in `townPlan.js:6` is still `[16, 22]` (used as the pool centerline reference).
- Confirm `north-bank-civic` and `command-skyline` clearing entries still exist in `scenery.js` (otherwise their delete/shrink steps are no-ops or wrong).

## Validation

Validation required:

1. `npm run sprites:validate` — manifest ↔ PNG bidirectional integrity, run after koi sprite generation and manifest entry add.
2. `node --check claudeville/src/config/scenery.js && node --check claudeville/src/config/townPlan.js` — syntax check after config edits.
3. `npm run dev`, then in browser at `http://localhost:4000`:
   - Confirm pool renders with lily pads, koi, and ripple at the central island.
   - Confirm canopy density at the central island matches the inspiration vibe (compare against the inspiration source image).
   - Confirm the shore-gap bluff between lighthouse and portal looks continuous (no broken-shore reading).
   - Pan an agent into the central island; confirm pathfinding routes around the pool and not through it.
   - Confirm lighthouse, portal, harbor master, command center, and other landmarks remain readable from default zoom.
4. `npm run sprites:capture-fresh && npm run sprites:visual-diff` — pixelmatch baseline snapshot.
5. Playwright screenshot of the central island region for side-by-side comparison with the source image.

Validation run:

- Not run; planning artifact only.

## Residual Risks

- Koi sprite generation may need 2-3 regeneration attempts to land on a usable result. Mitigation: time-box at 3 attempts; on failure, fall back to reusing the teal school for the central pool and keep the rest of the design unchanged.
- Removing `north-bank-civic` reduces clearing pressure across a 6.4-tile radius and may incidentally densify scenery near the Command Center silhouette. Mitigation: the shrunken `command-skyline` clearing still protects the building's vertical readability; verify in step 3 of validation.
- The third tree cluster centered at `[17, 19]` extends up toward the lighthouse promontory. If it visually crowds the lighthouse base on close zoom, reduce its `radiusY` to 2.8 or its `density` to 0.6.
- Lily pad count is a guess at five; if the pool surface looks too cluttered or too sparse on first render, adjust between three and seven without re-planning.

## Supersession Policy

If this plan becomes stale, update `agents/README.md` with the replacement source of truth and mark this artifact `historical` or `superseded`. Bump `assetVersion` in `manifest.yaml` if the koi sprite is regenerated after first integration.
