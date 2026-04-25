# Scenery Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a moat/river water system, bridges over crossings, vegetation (trees, bushes, grass tufts), and rocks/boulders to the ClaudeVille isometric world, plus walkability-aware agent pathing so agents cross water via bridges.

**Architecture:** A new `SceneryEngine` module owns all new scenery generation and rendering, driven by authored data in `config/scenery.js` (water polylines, bridge crossings, tree clusters, boulders). The engine produces tile sets (water/deepWater/shore/bridge/bush/grassTuft/smallRock) and Y-sorted prop lists (trees, boulders) plus a walkability grid. `IsometricRenderer` instantiates the engine, replaces its inline `_generateWater`, and inserts new render passes at the right z-order points. A new `Pathfinder` runs BFS over the walkability grid and returns waypoints; `AgentSprite` consumes waypoints to navigate around water via bridges.

**Tech Stack:** Vanilla ES modules, Canvas 2D, no build step. Verification via `node --check`, Playwright MCP screenshots, and browser console inspection — this repo has no test runner.

---

## Verification Primitives (this repo has no test runner)

Each task verifies one or more of these:

- **Syntax check:** `node --check <file>` (must exit 0).
- **Server smoke:** `npm run dev` and reach `http://localhost:4000` without errors. The dev server may already be running — check with `curl -fsS http://localhost:4000/api/providers >/dev/null` before starting another instance.
- **Visual smoke (Playwright MCP):** navigate to `http://localhost:4000`, wait for `networkidle`, take a screenshot of the world canvas. Compare against the baseline captured in Task 0.
- **Console clean check:** read browser console messages; no new errors after the change.
- **Pre-edit hygiene:** `git status --short` before editing, before committing, before final response. Preserve unrelated edits (other agents share this checkout).

Use the `playwright` MCP for screenshots/console (not `claude-in-chrome`) — proper `waitForLoadState('networkidle')` matters here because terrain renders progressively.

---

## File Structure

**Create:**

- `claudeville/src/config/scenery.js` — authored data: `WATER_POLYLINES`, `BRIDGE_HINTS`, `TREE_CLUSTERS`, `BOULDERS`, `BUSH_DENSITY`, `GRASS_TUFT_DENSITY`. Pure data, no logic.
- `claudeville/src/presentation/character-mode/SceneryEngine.js` — generates and renders water, shores, bridges, trees, bushes, grass tufts, small rocks, and boulders. Exposes `getWalkabilityGrid()`. ~600 lines target; if it grows past ~900 split out a `WaterRasterizer.js` helper.
- `claudeville/src/presentation/character-mode/Pathfinder.js` — BFS over walkability grid; `findPath(fromTile, toTile, grid) -> Array<{tileX, tileY}>` (empty array when no path).

**Modify:**

- `claudeville/src/config/theme.js` — add `deepWater`, `bridgeWood`, `treeFoliage`, `treeTrunk`, `bushFoliage`, `rock` palette entries.
- `claudeville/src/presentation/character-mode/IsometricRenderer.js` — instantiate `SceneryEngine`, delegate water generation, hook bridge / tree / bush / rock render passes at correct z-order, pass new layers to `Minimap`.
- `claudeville/src/presentation/character-mode/Minimap.js` — accept `bridgeTiles`, `treeTiles` in `layers`; extend static-layer cache key.
- `claudeville/src/presentation/character-mode/AgentSprite.js` — add waypoint queue; when a target is set, ask `Pathfinder` for waypoints if straight line crosses non-walkable tiles.

**Do not modify:** building rendering, agent rendering visuals, dashboard mode, server, adapters, widget.

---

## Coordinate / Tile Conventions

- Map is `MAP_SIZE = 40` × 40, `TILE_WIDTH = 64`, `TILE_HEIGHT = 32` (`claudeville/src/config/constants.js:1-3`).
- Tile keys are strings: `` `${tileX},${tileY}` ``.
- Screen coords for tile center: `screenX = (tileX - tileY) * 32`, `screenY = (tileX + tileY) * 16`.
- Existing pattern: `terrainSeed` precomputed via `_tileNoise(x, y)` for deterministic per-tile randomness. Reuse this — do not introduce `Math.random()` in generation paths or geography will change between reloads.

---

## Task 0: Branch + baseline screenshots

**Files:**
- Read only: existing world for baseline visual reference.

- [ ] **Step 1: Verify clean working tree (or note pre-existing modifications)**

Run: `git status --short`

Expected: a list of pre-existing untracked / modified files (the user has CSS and JS edits from other agents — do not touch those). Record the list so you can confirm later you did not disturb it.

- [ ] **Step 2: Create a feature branch**

Run: `git checkout -b feature/scenery-engine`

Expected: switched to new branch. If the user prefers a worktree, use `git worktree add ../claude-ville-scenery feature/scenery-engine` instead and `cd` there.

- [ ] **Step 3: Confirm dev server is reachable**

Run: `curl -fsS http://localhost:4000/api/providers >/dev/null && echo OK || echo START_SERVER`

If `START_SERVER`, run `npm run dev` (background it in the executor's preferred way). Wait until `curl http://localhost:4000` returns HTML.

- [ ] **Step 4: Capture baseline screenshots via Playwright MCP**

Use `mcp__plugin_playwright_playwright__browser_navigate` to `http://localhost:4000`, then `browser_wait_for` for `networkidle`, then `browser_take_screenshot` and save as `output/scenery-baseline-world.png`. Pan / zoom is not necessary; a default-zoom screenshot is enough.

Then capture a minimap-only crop or zoom-out screenshot for layout reference (`output/scenery-baseline-overview.png`).

- [ ] **Step 5: Commit baseline marker (no code yet)**

```bash
git status --short
# Expect: only output/scenery-baseline-*.png as new untracked, plus pre-existing.
git add docs/superpowers/plans/2026-04-25-scenery-engine.md output/scenery-baseline-*.png
git commit -m "docs(scenery): add implementation plan and visual baseline"
```

---

## Task 1: Theme palette additions

**Files:**
- Modify: `claudeville/src/config/theme.js:1-16`

- [ ] **Step 1: Read the existing theme file**

It's 16 lines today (`grass`, `path`, `plaza`, `water` palettes plus accent colors).

- [ ] **Step 2: Append new palette entries**

Edit `claudeville/src/config/theme.js` to add — in the same `THEME` object, after `water`:

```js
    deepWater: ['#0a2336', '#0e2c44', '#103456'],
    bridgeWood: {
        deck: '#5a3f24',
        deckLight: '#74532f',
        plankLine: 'rgba(28, 18, 8, 0.42)',
        rail: '#3a2917',
        railLight: '#553b21',
    },
    treeFoliage: ['#1f4a26', '#28552d', '#316336', '#264e29', '#2d5a32'],
    treeTrunk: '#3b2715',
    treeTrunkLight: '#52391f',
    bushFoliage: ['#2d5a30', '#345f33', '#3a6b3a', '#2c5429'],
    rock: {
        base: '#52524a',
        light: '#6c6c63',
        dark: '#36352f',
        moss: 'rgba(54, 84, 38, 0.55)',
    },
```

- [ ] **Step 3: Syntax check**

Run: `node --check claudeville/src/config/theme.js`

Expected: exit code 0, no output.

- [ ] **Step 4: Reload the dashboard, confirm no regression**

Use Playwright MCP to navigate / refresh `http://localhost:4000`, take a screenshot. Compare to `output/scenery-baseline-world.png` — should be visually identical (we only added unused palette entries).

Read browser console messages — must be clean.

- [ ] **Step 5: Commit**

```bash
git status --short
git add claudeville/src/config/theme.js
git commit -m "feat(theme): add deepWater, bridgeWood, foliage, rock palettes"
```

---

## Task 2: Authored scenery data file

**Files:**
- Create: `claudeville/src/config/scenery.js`

This file is **pure data, no logic**. Coordinates are tile-grid integers (or floats for prop positions). Coordinates target the partial-moat layout: SW + NE corner moat segments connected by a NW→SE diagonal river that passes through the city. The existing northern stream and SW pond from `_generateWater` are preserved by reusing equivalent polylines.

- [ ] **Step 1: Write the file**

Create `claudeville/src/config/scenery.js`:

```js
// Authored scenery data for the ClaudeVille world.
// All tile coordinates are 0..MAP_SIZE-1 (40-tile grid).
// Polylines are arrays of [tileX, tileY] control points; rasterization is
// performed by SceneryEngine (Bresenham-thickened or quadratic-eased).

// Water polylines. `width` is the half-width in tiles around the centerline.
// `kind` controls visual depth: 'river' is shallow, 'moat' is deeper.
export const WATER_POLYLINES = [
    // Preserved: northern curved stream (replaces inline pond+stream from
    // IsometricRenderer._generateWater).
    {
        kind: 'river',
        width: 1.4,
        points: [[2, 5], [8, 4], [14, 6], [20, 5], [22, 6]],
    },
    // Preserved: SW pond reframed as a wider river-end basin.
    {
        kind: 'river',
        width: 2.2,
        points: [[3, 33], [6, 32], [8, 33]],
    },
    // SW partial moat: short corner segment.
    {
        kind: 'moat',
        width: 1.6,
        points: [[1, 28], [1, 38], [10, 38]],
    },
    // NE partial moat: short corner segment.
    {
        kind: 'moat',
        width: 1.6,
        points: [[28, 1], [38, 1], [38, 11]],
    },
    // Diagonal river through the city, connecting the two moat ends.
    // Width tapers via per-segment control if needed; for v1 it's uniform.
    // Routed to avoid every building footprint per BUILDING_DEFS — in
    // particular it bends north of Code Forge (28..31, 15..17) and Sky
    // Watchtower (34..36, 10..14). DO NOT shorten back to (28,16) etc. —
    // that point is inside Code Forge and will silently corrupt water and
    // bridge generation.
    {
        kind: 'river',
        width: 1.3,
        points: [[10, 38], [16, 32], [22, 24], [26, 19], [30, 13], [34, 8], [38, 5]],
    },
];

// Bridge hints: explicit tile positions where a deck must exist.
// SceneryEngine will also auto-place bridges where the river polyline
// intersects pathTiles, but these guarantee the gameplay-critical crossings
// even if the river drifts during tuning. `orientation` is optional;
// when omitted the engine derives it from neighbor water tiles.
export const BRIDGE_HINTS = [
    { tileX: 5, tileY: 38, orientation: 'NS' },   // SW gate
    { tileX: 38, tileY: 5, orientation: 'EW' },   // NE gate
    { tileX: 16, tileY: 32 },                     // diagonal crossing #1
    { tileX: 22, tileY: 24 },                     // central crossing (S of Command Center)
    { tileX: 30, tileY: 13 },                     // crossing N of Code Forge
    { tileX: 34, tileY: 8 },                      // crossing N of Watchtower
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
export const TREE_CLUSTERS = [
    { centerX: 4, centerY: 4, radius: 5, density: 0.55 },
    { centerX: 4, centerY: 35, radius: 4, density: 0.45 },
    { centerX: 35, centerY: 4, radius: 4, density: 0.5 },
    { centerX: 36, centerY: 36, radius: 5, density: 0.55 },
    // Inland thickets between buildings — sparser.
    { centerX: 12, centerY: 28, radius: 3, density: 0.32 },
    { centerX: 28, centerY: 32, radius: 3, density: 0.32 },
    { centerX: 14, centerY: 10, radius: 2.5, density: 0.28 },
];

// Static large boulders. Drawn Y-sorted (occlude behind agents).
export const BOULDERS = [
    { tileX: 7.4, tileY: 14.2, scale: 1.1, variant: 'a' },
    { tileX: 31.6, tileY: 28.8, scale: 0.95, variant: 'b' },
    { tileX: 18.2, tileY: 31.4, scale: 1.05, variant: 'a' },
    { tileX: 25.7, tileY: 12.3, scale: 0.9, variant: 'b' },
    { tileX: 11.5, tileY: 22.8, scale: 0.85, variant: 'a' },
    { tileX: 33.4, tileY: 21.5, scale: 1.0, variant: 'b' },
    { tileX: 9.1, tileY: 9.4, scale: 0.85, variant: 'a' },
    { tileX: 30.3, tileY: 36.2, scale: 1.0, variant: 'b' },
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.34 };
```

- [ ] **Step 2: Syntax check**

Run: `node --check claudeville/src/config/scenery.js`

Expected: exit 0.

- [ ] **Step 3: Verify no existing code references this file (it's brand new)**

Run: `rg -n "config/scenery" claudeville/`

Expected: empty (no existing imports).

- [ ] **Step 4: Commit**

```bash
git status --short
git add claudeville/src/config/scenery.js
git commit -m "feat(scenery): add authored data file for water, bridges, trees, boulders"
```

---

## Task 3: SceneryEngine skeleton + polyline rasterization

**Files:**
- Create: `claudeville/src/presentation/character-mode/SceneryEngine.js`

This task delivers a SceneryEngine that:
- Accepts `{ world, terrainSeed, mapSize, tileNoise }` in its constructor.
- Builds `waterTiles`, `deepWaterTiles`, `shoreTiles` from `WATER_POLYLINES`.
- Excludes building footprints from water.
- Exposes nothing renderable yet — render methods come in later tasks.

Rasterization algorithm: for each polyline, walk every tile in the bounding box around the polyline; compute distance from tile center to the nearest segment; mark as water if `distance <= width`. Mark as `deepWater` if `kind === 'moat' && distance <= width * 0.5` (interior of the moat is darker).

- [ ] **Step 1: Write the skeleton**

Create `claudeville/src/presentation/character-mode/SceneryEngine.js`:

```js
import { MAP_SIZE } from '../../config/constants.js';
import {
    WATER_POLYLINES,
    BRIDGE_HINTS,
    TREE_CLUSTERS,
    BOULDERS,
    BUSH_DENSITY,
    GRASS_TUFT_DENSITY,
} from '../../config/scenery.js';

const CARDINAL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class SceneryEngine {
    constructor({ world, terrainSeed, tileNoise }) {
        this.world = world;
        this.terrainSeed = terrainSeed;
        this.tileNoise = tileNoise; // (x, y) -> [0, 1]

        this.waterTiles = new Set();
        this.deepWaterTiles = new Set();
        this.shoreTiles = new Set();
        this.bridgeTiles = new Map(); // key -> { orientation: 'NS' | 'EW' }
        this.bushTiles = new Map();    // key -> { variant: 0..2 }
        this.grassTuftTiles = new Map();
        this.smallRockTiles = new Set();
        this.treeProps = [];           // { tileX, tileY, variant, scale }
        this.boulderProps = [];        // { tileX, tileY, variant, scale }

        this._buildingFootprints = this._collectBuildingFootprints();

        this._generateWater();
        this._generateShorelines();
        // Bridges, vegetation, rocks come in later tasks; left empty for now.
    }

    // --- Public accessors -------------------------------------------------

    getWaterTiles() { return this.waterTiles; }
    getDeepWaterTiles() { return this.deepWaterTiles; }
    getShoreTiles() { return this.shoreTiles; }
    getBridgeTiles() { return this.bridgeTiles; }

    // --- Generation -------------------------------------------------------

    _collectBuildingFootprints() {
        const set = new Set();
        if (!this.world?.buildings) return set;
        for (const b of this.world.buildings.values()) {
            const x0 = Math.floor(b.position.tileX);
            const y0 = Math.floor(b.position.tileY);
            for (let dx = 0; dx < b.width; dx++) {
                for (let dy = 0; dy < b.height; dy++) {
                    set.add(`${x0 + dx},${y0 + dy}`);
                }
            }
        }
        return set;
    }

    _generateWater() {
        for (const poly of WATER_POLYLINES) {
            this._rasterizePolyline(poly);
        }
    }

    _rasterizePolyline({ kind, width, points }) {
        if (!points || points.length < 2) return;
        const deepRatio = kind === 'moat' ? 0.5 : 0;

        // Bounding box (inclusive), padded by width.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [px, py] of points) {
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        const pad = Math.ceil(width) + 1;
        const x0 = Math.max(0, Math.floor(minX - pad));
        const x1 = Math.min(MAP_SIZE - 1, Math.ceil(maxX + pad));
        const y0 = Math.max(0, Math.floor(minY - pad));
        const y1 = Math.min(MAP_SIZE - 1, Math.ceil(maxY + pad));

        for (let ty = y0; ty <= y1; ty++) {
            for (let tx = x0; tx <= x1; tx++) {
                const key = `${tx},${ty}`;
                if (this._buildingFootprints.has(key)) continue;
                const d = this._distanceToPolyline(tx + 0.5, ty + 0.5, points);
                // Soften edges with per-tile noise so the bank isn't too clean.
                const noise = this.tileNoise(tx + 53, ty + 19);
                const localWidth = width + (noise - 0.5) * 0.45;
                if (d <= localWidth) {
                    this.waterTiles.add(key);
                    if (deepRatio && d <= localWidth * deepRatio) {
                        this.deepWaterTiles.add(key);
                    }
                }
            }
        }
    }

    _distanceToPolyline(x, y, points) {
        let best = Infinity;
        for (let i = 0; i < points.length - 1; i++) {
            const d = this._distanceToSegment(x, y, points[i], points[i + 1]);
            if (d < best) best = d;
        }
        return best;
    }

    _distanceToSegment(x, y, [ax, ay], [bx, by]) {
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(x - ax, y - ay);
        let t = ((x - ax) * dx + (y - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        return Math.hypot(x - cx, y - cy);
    }

    _generateShorelines() {
        for (const key of this.waterTiles) {
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            for (const [dx, dy] of CARDINAL_DIRS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
                const nKey = `${nx},${ny}`;
                if (!this.waterTiles.has(nKey)) {
                    this.shoreTiles.add(nKey);
                }
            }
        }
    }
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check claudeville/src/presentation/character-mode/SceneryEngine.js`

Expected: exit 0.

- [ ] **Step 3: Standalone smoke test**

Create a throwaway one-liner to verify the engine produces a sensible water set without depending on the world. Run from repo root:

```bash
node --input-type=module -e "
import { SceneryEngine } from './claudeville/src/presentation/character-mode/SceneryEngine.js';
const fakeWorld = { buildings: new Map() };
const seed = new Array(40 * 40).fill(0).map((_, i) => (i * 9301 + 49297) % 233280 / 233280);
const noise = (x, y) => seed[((y % 40) * 40 + (x % 40) + 1600) % 1600];
const eng = new SceneryEngine({ world: fakeWorld, terrainSeed: seed, tileNoise: noise });
console.log('water tiles:', eng.getWaterTiles().size);
console.log('deep water tiles:', eng.getDeepWaterTiles().size);
console.log('shore tiles:', eng.getShoreTiles().size);
"
```

Expected: water tiles between 80 and 250, deep water > 0, shore tiles > 0. If all zero, the rasterization is broken — debug `_distanceToSegment` first. Do not proceed until counts look plausible.

- [ ] **Step 4: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/SceneryEngine.js
git commit -m "feat(scenery): add SceneryEngine skeleton with polyline water rasterization"
```

---

## Task 4: Wire SceneryEngine into IsometricRenderer

Replace the inline `_generateWater()` and `_generateShorelines()` with delegation to `SceneryEngine`. Add a `deepWater` rendering branch in `_drawTile`. Keep the existing pond/stream visuals close enough that the village still reads the same.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:1-216` (imports, constructor, water generation)
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:761-829` (`_drawTile` water branch)

- [ ] **Step 1: Add the import**

At the top of `IsometricRenderer.js`, after the existing imports (line 9):

```js
import { SceneryEngine } from './SceneryEngine.js';
```

- [ ] **Step 2: Replace water + shoreline generation in the constructor**

In `IsometricRenderer.js:92-96`, replace:

```js
        // Water tiles
        this.waterTiles = new Set();
        this._generateWater();
        this.shoreTiles = new Set();
        this._generateShorelines();
```

with:

```js
        // Scenery (water, shorelines, bridges, vegetation, rocks)
        this.scenery = new SceneryEngine({
            world: this.world,
            terrainSeed: this.terrainSeed,
            tileNoise: (x, y) => this._tileNoise(x, y),
        });
        this.waterTiles = this.scenery.getWaterTiles();
        this.shoreTiles = this.scenery.getShoreTiles();
        this.deepWaterTiles = this.scenery.getDeepWaterTiles();
```

- [ ] **Step 3: Delete the now-orphaned `_generateWater` and `_generateShorelines` methods**

Delete `IsometricRenderer.js:185-230` entirely (the two methods). The existing call sites have already been replaced; no other code calls them.

Verify with: `rg -n "_generateWater\|_generateShorelines" claudeville/`. Expected: no matches.

- [ ] **Step 4: Add a deep-water tint branch in `_drawTile`**

In `_drawTile` (`IsometricRenderer.js:768-770`), replace:

```js
        if (this.waterTiles.has(key)) {
            const waterIdx = Math.floor(seed * THEME.water.length);
            fillColor = THEME.water[waterIdx];
        }
```

with:

```js
        if (this.waterTiles.has(key)) {
            const palette = this.deepWaterTiles.has(key) ? THEME.deepWater : THEME.water;
            const waterIdx = Math.floor(seed * palette.length);
            fillColor = palette[waterIdx];
        }
```

- [ ] **Step 5: Syntax check**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: exit 0.

- [ ] **Step 6: Coordinate sanity check (assert no building footprint overlaps water)**

Run from repo root:

```bash
node --input-type=module -e "
import { SceneryEngine } from './claudeville/src/presentation/character-mode/SceneryEngine.js';
import { BUILDING_DEFS } from './claudeville/src/config/buildings.js';
const buildings = new Map();
for (const b of BUILDING_DEFS) {
    buildings.set(b.type, { type: b.type, position: { tileX: b.x, tileY: b.y }, width: b.width, height: b.height });
}
const seed = new Array(40 * 40).fill(0).map((_, i) => (i * 9301 + 49297) % 233280 / 233280);
const noise = (x, y) => {
    const i = ((y % 40) * 40 + (x % 40) + 1600) % 1600;
    return seed[i];
};
const eng = new SceneryEngine({ world: { buildings }, terrainSeed: seed, tileNoise: noise });
let collisions = 0;
for (const b of BUILDING_DEFS) {
    for (let dx = 0; dx < b.width; dx++) {
        for (let dy = 0; dy < b.height; dy++) {
            const k = \`\${b.x + dx},\${b.y + dy}\`;
            if (eng.getWaterTiles().has(k)) { console.log('COLLISION:', b.type, 'at', k); collisions++; }
        }
    }
}
console.log(collisions === 0 ? 'OK: no building submerged' : 'FAIL: ' + collisions);
"
```

Expected: `OK: no building submerged`. If `FAIL`, reroute the offending polyline in `claudeville/src/config/scenery.js` and re-run. Do not proceed to visual smoke until this prints OK.

- [ ] **Step 7: Visual smoke**

Reload `http://localhost:4000` via Playwright MCP. Take screenshot `output/scenery-task4-water.png`.

Expected:
- The northern stream and SW pond are still visible (they're preserved in `WATER_POLYLINES`).
- A new diagonal river runs NW→SE through the city, bending around the Code Forge and Watchtower.
- SW and NE corner moats appear.
- Moat interiors are visibly darker than the river/stream.
- Console is clean.

- [ ] **Step 8: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(scenery): delegate water generation to SceneryEngine, add deep-water tint"
```

---

## Task 5: Bridge generation

Bridges are placed at:
1. Every tile from `BRIDGE_HINTS`.
2. Every tile where the river polyline intersects a tile already in `pathTiles` (auto-placement).

Auto-placement requires `pathTiles`. The renderer generates paths in its constructor before the SceneryEngine, so SceneryEngine needs `pathTiles` injected after construction. Solution: split `SceneryEngine.generateBridges(pathTiles)` as a second-stage method that the renderer calls after `_generatePaths()` completes.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SceneryEngine.js`
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js` (constructor)

- [ ] **Step 1: Add `generateBridges` to SceneryEngine**

In `SceneryEngine.js`, append a new method (before the closing `}`):

```js
    generateBridges(pathTiles) {
        // 1. Authored hints — always placed if the tile is water.
        for (const hint of BRIDGE_HINTS) {
            const key = `${hint.tileX},${hint.tileY}`;
            if (!this.waterTiles.has(key)) continue;
            this.bridgeTiles.set(key, {
                orientation: hint.orientation || this._inferOrientation(hint.tileX, hint.tileY),
            });
        }
        // 2. Auto-place where any path tile lies on water.
        for (const key of pathTiles) {
            if (!this.waterTiles.has(key)) continue;
            if (this.bridgeTiles.has(key)) continue;
            const comma = key.indexOf(',');
            const tileX = Number(key.slice(0, comma));
            const tileY = Number(key.slice(comma + 1));
            this.bridgeTiles.set(key, {
                orientation: this._inferOrientation(tileX, tileY),
            });
        }
        // Ensure the bridge tile itself is treated as walkable path so the
        // road classifier (in IsometricRenderer) styles it correctly. The
        // caller adds keys back to pathTiles after this returns.
    }

    _inferOrientation(tileX, tileY) {
        // EW bridge if water extends left/right; NS if it extends up/down.
        const eastWater = this.waterTiles.has(`${tileX + 1},${tileY}`);
        const westWater = this.waterTiles.has(`${tileX - 1},${tileY}`);
        const northWater = this.waterTiles.has(`${tileX},${tileY - 1}`);
        const southWater = this.waterTiles.has(`${tileX},${tileY + 1}`);
        const ew = (eastWater ? 1 : 0) + (westWater ? 1 : 0);
        const ns = (northWater ? 1 : 0) + (southWater ? 1 : 0);
        return ew >= ns ? 'EW' : 'NS';
    }
```

- [ ] **Step 2: Wire it into the renderer constructor**

In `IsometricRenderer.js`, the constructor currently calls `_generatePaths()` at line 90, the SceneryEngine setup from Task 4 at lines 92-100 (replacing the old water gen), and `_generateTerrainFeatures()` at line 98.

**CRITICAL ORDERING:** `_generateTerrainFeatures` checks `this.pathTiles` to skip path tiles when seeding flowers/stones/etc. — but bridge tiles will not be in `pathTiles` yet at that line. To prevent stale terrain features being seeded onto tiles that *become* bridges, **move `this._generateTerrainFeatures()` from line 98 to after the bridge block below**.

After the `this.scenery = new SceneryEngine(...)` block from Task 4, and after deleting the old `this._generateTerrainFeatures()` call at line 98, add:

```js
        this.scenery.generateBridges(this.pathTiles);
        this.bridgeTiles = this.scenery.getBridgeTiles();
        // Treat bridges as walkable path so road classification draws them
        // correctly (planking will replace shimmer in _drawTile).
        for (const key of this.bridgeTiles.keys()) {
            this.pathTiles.add(key);
        }
        // Now that bridges are in pathTiles, generate terrain features so
        // bridges don't get tagged with reeds/flowers/stones/mushrooms.
        this.featureTiles = new Map();
        this._generateTerrainFeatures();
```

The new `featureTiles` re-init is required because the original line 97 (`this.featureTiles = new Map();`) is still in place above; we keep that and just call `_generateTerrainFeatures()` later. **Sanity check: after this edit, `_generateTerrainFeatures` should be called exactly once. Run `rg -n "_generateTerrainFeatures\\(\\)" claudeville/src/presentation/character-mode/IsometricRenderer.js` and expect exactly one match.**

The constructor flow becomes: paths → scenery (water/shores) → bridges → re-classify roads → terrain features. **Important:** if `_classifyRoadMaterials` was already called inside `_generatePaths` (line 136), call it again after bridges are added so they get road styling:

After the bridge block above, add:

```js
        // Re-classify so newly-pathified bridge tiles inherit avenue style.
        // CRITICAL: _classifyRoadMaterials *adds* to mainAvenueTiles and
        // dirtPathTiles without clearing them, and the new pass would
        // re-evaluate every tile and could place a tile in BOTH sets, which
        // breaks _drawTile's mutually-exclusive styling. Clear first.
        this.mainAvenueTiles.clear();
        this.dirtPathTiles.clear();
        const command = this._getCommandBuilding();
        const plazaHub = command
            ? {
                x: Math.floor(command.position.tileX + command.width / 2),
                y: Math.floor(command.position.tileY + command.height + 2),
            }
            : { x: 20, y: 22 };
        this._classifyRoadMaterials(plazaHub.x, plazaHub.y);
```

(This duplicates the plazaHub computation from `_generatePaths`. Acceptable — refactoring `_generatePaths` to expose plazaHub is out of scope.)

- [ ] **Step 3: Add `getBridgeTiles` accessor**

`SceneryEngine.getBridgeTiles()` was already declared in Task 3's skeleton; no change needed if so. If absent, add:

```js
    getBridgeTiles() { return this.bridgeTiles; }
```

- [ ] **Step 4: Syntax check**

```bash
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Expected: both exit 0.

- [ ] **Step 5: Visual smoke**

Reload page. The bridge tiles will currently render as **path-styled water** (because we added them to `pathTiles` but `_drawTile` checks water first). This will look ugly until Task 6 adds dedicated bridge rendering — that's expected. Take screenshot `output/scenery-task5-bridges-pathified.png` and confirm:
- Bridge tiles are still water-colored (water check wins).
- No console errors.
- Road classification didn't crash.

- [ ] **Step 6: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/SceneryEngine.js claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(scenery): generate bridge tiles from hints + path/water intersections"
```

---

## Task 6: Bridge rendering

Render a wooden deck on every bridge tile, replacing the water shimmer. Z-order: bridge decks must paint over the water tile but under any agents that walk on them. Easiest place: inside `_drawTile`, when `this.bridgeTiles.has(key)` is true, **skip** the water shimmer block and draw the bridge instead.

Visuals: brown deck filling the diamond, three plank lines perpendicular to orientation, two thin rails along the long edges.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:761-829`

- [ ] **Step 1: Add the bridge-render branch in `_drawTile`**

In `IsometricRenderer.js`, find the water shimmer block at lines 821-828:

```js
        // Water shimmer effect
        if (this.waterTiles.has(key)) {
            const shimmer = this.motionScale ? Math.sin(this.waterFrame * 2 + tileX * 0.5 + tileY * 0.3) * 0.055 + 0.055 : STATIC_WATER_SHIMMER;
            ctx.fillStyle = `rgba(185, 229, 224, ${shimmer})`;
            ctx.fill();
            this._drawWaterDetail(ctx, screenX, screenY, seed, tileX, tileY);
            this._drawWaterEdge(ctx, screenX, screenY, seed, tileX, tileY);
        }
```

Replace it with:

```js
        // Water shimmer / bridge deck
        if (this.bridgeTiles?.has(key)) {
            this._drawBridgeDeck(ctx, screenX, screenY, seed, key);
        } else if (this.waterTiles.has(key)) {
            const shimmer = this.motionScale ? Math.sin(this.waterFrame * 2 + tileX * 0.5 + tileY * 0.3) * 0.055 + 0.055 : STATIC_WATER_SHIMMER;
            ctx.fillStyle = `rgba(185, 229, 224, ${shimmer})`;
            ctx.fill();
            this._drawWaterDetail(ctx, screenX, screenY, seed, tileX, tileY);
            this._drawWaterEdge(ctx, screenX, screenY, seed, tileX, tileY);
        }
```

Also: the path-detail block earlier in `_drawTile` (lines 800-808) runs because we added bridges to `pathTiles`. We do **not** want that — bridges should not get cobblestone detail painted on them. Just before the `if (this.pathTiles.has(key))` block at line 800, add:

```js
        if (this.bridgeTiles?.has(key)) {
            // Bridge deck handles its own detail; skip the path/town-square detail pass.
        } else if (this.pathTiles.has(key)) {
```

Carefully restructure the existing `if (this.pathTiles.has(key)) { ... } else if (!this.waterTiles.has(key)) { ... }` chain (lines 800-815) so it becomes:

```js
        if (this.bridgeTiles?.has(key)) {
            // No path/grass detail under a bridge.
        } else if (this.pathTiles.has(key)) {
            if (this.townSquareTiles.has(key)) {
                this._drawTownSquareDetail(ctx, screenX, screenY, seed, tileX, tileY);
            } else {
                this._drawPathDetail(ctx, screenX, screenY, seed, tileX, tileY);
            }
            if (this.commandCenterRoadTiles.has(key)) {
                this._drawCommandApproachRoadDetail(ctx, screenX, screenY, seed, tileX, tileY);
            }
        } else if (!this.waterTiles.has(key)) {
            this._drawGrassDetail(ctx, screenX, screenY, seed, tileX, tileY);
            this._drawTerrainFeature(ctx, screenX, screenY, seed, key);
            if (this.shoreTiles.has(key)) {
                this._drawShoreDetail(ctx, screenX, screenY, seed, tileX, tileY);
            }
        }
```

- [ ] **Step 2: Implement `_drawBridgeDeck`**

Add the new method anywhere among the `_draw*` helpers in `IsometricRenderer.js` (suggested location: just before `_drawTerrainFeature` at line 1405):

```js
    _drawBridgeDeck(ctx, screenX, screenY, seed, key) {
        const info = this.bridgeTiles.get(key);
        const orientation = info?.orientation || 'EW';
        const wood = THEME.bridgeWood;

        // Deck fill (covers the diamond — the water fill is already painted under it).
        ctx.fillStyle = wood.deck;
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        ctx.closePath();
        ctx.fill();

        // Subtle highlight band based on seed.
        ctx.fillStyle = wood.deckLight;
        ctx.globalAlpha = 0.35 + seed * 0.15;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Three plank lines, perpendicular to orientation. EW = planks run NS.
        ctx.strokeStyle = wood.plankLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (orientation === 'EW') {
            // Planks run between NW and SW corners (a series of NS-ish lines).
            for (let i = 1; i <= 3; i++) {
                const t = i / 4;
                const x = screenX - TILE_WIDTH / 2 + t * TILE_WIDTH;
                const dyEdge = (1 - Math.abs(2 * t - 1)) * TILE_HEIGHT / 2;
                ctx.moveTo(x, screenY - dyEdge);
                ctx.lineTo(x, screenY + dyEdge);
            }
        } else {
            for (let i = 1; i <= 3; i++) {
                const t = i / 4;
                const y = screenY - TILE_HEIGHT / 2 + t * TILE_HEIGHT;
                const dxEdge = (1 - Math.abs(2 * t - 1)) * TILE_WIDTH / 2;
                ctx.moveTo(screenX - dxEdge, y);
                ctx.lineTo(screenX + dxEdge, y);
            }
        }
        ctx.stroke();

        // Rails along the two outer edges (perpendicular to traffic flow).
        ctx.strokeStyle = wood.rail;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (orientation === 'EW') {
            // Rails on the NW and SE diamond edges.
            ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
            ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
            ctx.moveTo(screenX, screenY + TILE_HEIGHT / 2);
            ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        } else {
            ctx.moveTo(screenX - TILE_WIDTH / 2, screenY);
            ctx.lineTo(screenX, screenY - TILE_HEIGHT / 2);
            ctx.moveTo(screenX + TILE_WIDTH / 2, screenY);
            ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        }
        ctx.stroke();

        // Rail highlight.
        ctx.strokeStyle = wood.railLight;
        ctx.lineWidth = 0.75;
        ctx.stroke();
    }
```

- [ ] **Step 3: Syntax check**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: exit 0.

- [ ] **Step 4: Visual smoke**

Reload page. Take screenshot `output/scenery-task6-bridges.png`. Expected:
- Bridges visible at SW gate, NE gate, and 4 diagonal river crossings.
- Wooden deck color, plank lines, rails clearly visible.
- Water on either side of each bridge is uninterrupted.
- Console clean.
- Click an agent — selection still works (bridges are not hit-tested, click passes through to agents/buildings as before).

- [ ] **Step 5: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(scenery): render wooden bridge decks at water/path crossings"
```

---

## Task 7: Bushes + grass tufts (flat features)

Extend `_generateTerrainFeatures` and `_drawTerrainFeature` to add `'bush'` and `'grassTuft'` types. Bushes use noise band `BUSH_DENSITY`, grass tufts use `GRASS_TUFT_DENSITY`. Trees come in Task 8 (Y-sorted, different mechanism).

Approach: have `SceneryEngine` populate `bushTiles` and `grassTuftTiles` Maps. `IsometricRenderer._generateTerrainFeatures` skips tiles already claimed by these. The existing per-tile feature drawing dispatches to a helper.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SceneryEngine.js`
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

- [ ] **Step 1: Add `_generateFlatVegetation` to SceneryEngine**

Append to `SceneryEngine.js`:

```js
    generateFlatVegetation(pathTiles, bridgeTiles) {
        // pathTiles already includes bridges; we still rely on waterTiles/shoreTiles.
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                if (this.waterTiles.has(key)) continue;
                if (this.shoreTiles.has(key)) continue;
                if (pathTiles.has(key)) continue;
                if (bridgeTiles.has(key)) continue;
                if (this._buildingFootprints.has(key)) continue;

                const noise = this.tileNoise(x + 109, y + 67);
                if (noise >= BUSH_DENSITY.min && noise < BUSH_DENSITY.max) {
                    const variant = Math.floor(this.tileNoise(x + 7, y + 13) * 3);
                    this.bushTiles.set(key, { variant });
                } else if (noise >= GRASS_TUFT_DENSITY.min && noise < GRASS_TUFT_DENSITY.max) {
                    this.grassTuftTiles.set(key, { variant: Math.floor(this.tileNoise(x + 21, y + 5) * 2) });
                }
            }
        }
    }

    getBushTiles() { return this.bushTiles; }
    getGrassTuftTiles() { return this.grassTuftTiles; }
```

- [ ] **Step 2: Call it from the renderer constructor**

In `IsometricRenderer.js` constructor, after the moved `_generateTerrainFeatures()` call from Task 5, add:

```js
        this.scenery.generateFlatVegetation(this.pathTiles, this.bridgeTiles);
        this.bushTiles = this.scenery.getBushTiles();
        this.grassTuftTiles = this.scenery.getGrassTuftTiles();
```

The constructor order is: paths → scenery (water/shores) → bridges → re-classify → terrain features → flat vegetation. (Bridges are already in `pathTiles` and `_generateTerrainFeatures` checks `pathTiles`, so the existing terrain features already skip bridges. The new flat vegetation also skips bridges via the explicit `bridgeTiles.has(key)` check inside `generateFlatVegetation`.)

- [ ] **Step 3: Render bushes and grass tufts in `_drawTile`**

In `_drawTile`, the grass/feature branch (after Task 6 it looks like):

```js
        } else if (!this.waterTiles.has(key)) {
            this._drawGrassDetail(ctx, screenX, screenY, seed, tileX, tileY);
            this._drawTerrainFeature(ctx, screenX, screenY, seed, key);
            if (this.shoreTiles.has(key)) {
                this._drawShoreDetail(ctx, screenX, screenY, seed, tileX, tileY);
            }
        }
```

Add bush and tuft drawing **inside** that branch, after `_drawTerrainFeature` and before the shore detail:

```js
            this._drawTerrainFeature(ctx, screenX, screenY, seed, key);
            if (this.bushTiles?.has(key)) {
                this._drawBush(ctx, screenX, screenY, seed, this.bushTiles.get(key));
            }
            if (this.grassTuftTiles?.has(key)) {
                this._drawGrassTuft(ctx, screenX, screenY, seed, this.grassTuftTiles.get(key));
            }
```

- [ ] **Step 4: Implement `_drawBush` and `_drawGrassTuft`**

Add these methods near `_drawTerrainFeature` in `IsometricRenderer.js`:

```js
    _drawBush(ctx, screenX, screenY, seed, info) {
        const palette = THEME.bushFoliage;
        const color = palette[(info?.variant ?? 0) % palette.length];
        const ox = (seed - 0.5) * 6;
        const oy = (seed - 0.5) * 2 - 1;

        // Three overlapping circles for a fluffy silhouette.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(screenX + ox - 3, screenY + oy + 1, 4, 3, 0, 0, Math.PI * 2);
        ctx.ellipse(screenX + ox + 3, screenY + oy + 1, 4, 3, 0, 0, Math.PI * 2);
        ctx.ellipse(screenX + ox, screenY + oy - 1, 5, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Highlight on top.
        ctx.fillStyle = 'rgba(168, 199, 134, 0.35)';
        ctx.beginPath();
        ctx.ellipse(screenX + ox - 1, screenY + oy - 2, 3, 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawGrassTuft(ctx, screenX, screenY, seed, info) {
        ctx.strokeStyle = 'rgba(96, 138, 64, 0.7)';
        ctx.lineWidth = 1;
        const ox = (seed - 0.5) * 8;
        const oy = (seed - 0.5) * 4;
        ctx.beginPath();
        ctx.moveTo(screenX + ox, screenY + oy + 3);
        ctx.lineTo(screenX + ox - 2, screenY + oy - 3);
        ctx.moveTo(screenX + ox + 1, screenY + oy + 3);
        ctx.lineTo(screenX + ox + 1, screenY + oy - 4);
        ctx.moveTo(screenX + ox + 2, screenY + oy + 3);
        ctx.lineTo(screenX + ox + 4, screenY + oy - 2);
        ctx.stroke();
    }
```

- [ ] **Step 5: Syntax check**

```bash
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Both exit 0.

- [ ] **Step 6: Visual smoke**

Reload. Take screenshot `output/scenery-task7-vegetation.png`. Expected:
- Small green bushes scattered on grass tiles (no bushes on path / water / shore).
- Grass tufts appear as tiny strokes on a noticeable fraction of grass tiles.
- Density doesn't visually overwhelm — if it does, lower the band sizes in `scenery.js`.
- Console clean.

- [ ] **Step 7: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/SceneryEngine.js claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(scenery): add bushes and grass tufts as flat features"
```

---

## Task 8: Trees as Y-sorted props

Trees must occlude / be occluded by agents based on screen Y. The cleanest hook is to add tree props to the same Y-sort pass agent sprites use. `IsometricRenderer._snapshotSortedSprites()` (called at line 715) builds the sorted list. We'll teach it to merge in scenery props.

Each tree prop has world coordinates (tileX, tileY → screen) and a `draw(ctx, zoom)` method matching the AgentSprite duck-type so the existing loop can call them uniformly.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SceneryEngine.js`
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

- [ ] **Step 1: Generate tree props in SceneryEngine**

Append to `SceneryEngine.js`:

```js
    generateTrees(pathTiles, bridgeTiles) {
        for (const cluster of TREE_CLUSTERS) {
            const r = cluster.radius;
            const r2 = r * r;
            for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
                for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
                    const tx = cluster.centerX + dx;
                    const ty = cluster.centerY + dy;
                    if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) continue;
                    if (dx * dx + dy * dy > r2) continue;
                    const key = `${tx},${ty}`;
                    if (this.waterTiles.has(key)) continue;
                    if (this.shoreTiles.has(key)) continue;
                    if (pathTiles.has(key)) continue;
                    if (bridgeTiles.has(key)) continue;
                    if (this._buildingFootprints.has(key)) continue;
                    if (this.bushTiles.has(key)) continue;

                    const noise = this.tileNoise(tx + 251, ty + 137);
                    if (noise > 1 - cluster.density) {
                        // Sub-tile jitter for natural placement.
                        const jx = (this.tileNoise(tx + 11, ty + 3) - 0.5) * 0.6;
                        const jy = (this.tileNoise(tx + 5, ty + 19) - 0.5) * 0.6;
                        const variant = Math.floor(this.tileNoise(tx + 41, ty + 91) * 3);
                        const scale = 0.85 + this.tileNoise(tx + 17, ty + 71) * 0.4;
                        this.treeProps.push({ tileX: tx + 0.5 + jx, tileY: ty + 0.5 + jy, variant, scale });
                    }
                }
            }
        }
    }

    getTreeProps() { return this.treeProps; }
```

- [ ] **Step 2: Build a tree-prop "sprite" wrapper**

Inside `IsometricRenderer.js`, near the top after the constants block (around line 48), define a small adapter that exposes the same `draw` shape used by `_snapshotSortedSprites`:

```js
class StaticPropSprite {
    constructor({ tileX, tileY, drawFn }) {
        this.tileX = tileX;
        this.tileY = tileY;
        this.x = (tileX - tileY) * TILE_WIDTH / 2;
        this.y = (tileX + tileY) * TILE_HEIGHT / 2;
        this.drawFn = drawFn;
    }
    draw(ctx, zoom) {
        this.drawFn(ctx, this.x, this.y, zoom);
    }
}
```

(Imports `TILE_WIDTH`, `TILE_HEIGHT` are already in scope.)

- [ ] **Step 3: Generate trees in the constructor and add them to the prop pool**

In the constructor, after `generateFlatVegetation` from Task 7, add:

```js
        this.scenery.generateTrees(this.pathTiles, this.bridgeTiles);
        this.treePropSprites = this.scenery.getTreeProps().map((t) => new StaticPropSprite({
            tileX: t.tileX,
            tileY: t.tileY,
            drawFn: (ctx, x, y) => this._drawTree(ctx, x, y, t),
        }));
```

- [ ] **Step 4: Merge tree props into the Y-sort**

Find `_snapshotSortedSprites()` in `IsometricRenderer.js` (search: `rg -n "_snapshotSortedSprites" claudeville/src/presentation/character-mode/IsometricRenderer.js`). Modify it so it includes both agent sprites and tree props in the sort:

If the current implementation looks like:

```js
    _snapshotSortedSprites() {
        if (this._spritesNeedSort) {
            this._sortedSprites = Array.from(this.agentSprites.values());
            this._sortedSprites.sort((a, b) => a.y - b.y);
            this._spritesNeedSort = false;
        }
        return this._sortedSprites;
    }
```

Change it to:

```js
    _snapshotSortedSprites() {
        if (this._spritesNeedSort) {
            const agents = Array.from(this.agentSprites.values());
            const trees = this.treePropSprites || [];
            this._sortedSprites = [...agents, ...trees];
            this._sortedSprites.sort((a, b) => a.y - b.y);
            this._spritesNeedSort = false;
        }
        return this._sortedSprites;
    }
```

Read the actual current implementation before editing — line numbers may differ. The principle: trees are sorted with agents by their world `y` (screen y).

**Cache invalidation note:** the existing `_spritesNeedSort` flag is flipped each time an agent moves enough to change its tile-Y position (currently around `IsometricRenderer.js:651-656`). Resorting after Task 8 sorts `agents + trees + boulders` together — that's roughly 5–6× the current cost per re-sort, *not* per frame, because the flag only flips when an agent moves. With ~150-200 props and ~5-10 agents, this is still well under 1ms per re-sort.

If profiling (Task 13) shows it matters: keep `treePropSprites` and `boulderPropSprites` as a separately maintained, **already-sorted-by-Y** array (sort once at construction). Each frame, merge-sort it with the freshly sorted agents list. Skip this optimization unless the profile says you need it.

- [ ] **Step 5: Implement `_drawTree`**

Add to `IsometricRenderer.js` (near the other `_draw*` helpers):

```js
    _drawTree(ctx, screenX, screenY, info) {
        const palette = THEME.treeFoliage;
        const foliage = palette[(info.variant ?? 0) % palette.length];
        const trunkColor = THEME.treeTrunk;
        const trunkLight = THEME.treeTrunkLight;
        const s = info.scale ?? 1;

        // Shadow under canopy.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
        ctx.beginPath();
        ctx.ellipse(screenX, screenY + 3, 12 * s, 4 * s, 0, 0, Math.PI * 2);
        ctx.fill();

        // Trunk.
        const trunkH = 14 * s;
        const trunkW = 3 * s;
        ctx.fillStyle = trunkColor;
        ctx.fillRect(screenX - trunkW / 2, screenY - trunkH, trunkW, trunkH);
        ctx.fillStyle = trunkLight;
        ctx.fillRect(screenX - trunkW / 2, screenY - trunkH, 1, trunkH);

        // Canopy: 3 overlapping ellipses.
        ctx.fillStyle = foliage;
        ctx.beginPath();
        ctx.ellipse(screenX, screenY - trunkH - 3 * s, 11 * s, 9 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(screenX - 6 * s, screenY - trunkH + 1, 7 * s, 6 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(screenX + 6 * s, screenY - trunkH + 1, 7 * s, 6 * s, 0, 0, Math.PI * 2);
        ctx.fill();

        // Highlight on the sun side.
        ctx.fillStyle = 'rgba(208, 232, 174, 0.32)';
        ctx.beginPath();
        ctx.ellipse(screenX - 3 * s, screenY - trunkH - 6 * s, 5 * s, 3 * s, 0, 0, Math.PI * 2);
        ctx.fill();
    }
```

- [ ] **Step 6: Syntax check**

```bash
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Both exit 0.

- [ ] **Step 7: Visual smoke**

Reload. Take screenshot `output/scenery-task8-trees.png`. Expected:
- Tree clusters visible at all four corners + 3 inland thickets.
- When an agent walks behind a tree, the tree's canopy partially occludes the agent.
- When an agent stands in front of a tree, agent renders on top.
- Frame rate looks smooth (use Playwright `browser_run_code` with `performance.now()` if needed; subjective check is fine for v1).
- Console clean.

If trees appear in front of buildings even when behind them: that's a known limitation of this simple Y-sort vs. building Y bounds. Leave it for a possible v2 — it's not a regression.

- [ ] **Step 8: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/SceneryEngine.js claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(scenery): add Y-sorted tree props with agent occlusion"
```

---

## Task 9: Boulders + small rock variation

Boulders are authored static props (Y-sorted, mirroring the `ANCIENT_RUINS` pattern). Small rocks are noise-driven additions to the existing `'stones'` feature.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SceneryEngine.js`
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

- [ ] **Step 1: Generate boulder props in SceneryEngine**

Append to `SceneryEngine.js`:

```js
    generateBoulders(pathTiles, bridgeTiles) {
        for (const b of BOULDERS) {
            const tx = Math.floor(b.tileX);
            const ty = Math.floor(b.tileY);
            const key = `${tx},${ty}`;
            if (this.waterTiles.has(key)) continue;
            if (pathTiles.has(key)) continue;
            if (bridgeTiles.has(key)) continue;
            if (this._buildingFootprints.has(key)) continue;
            this.boulderProps.push({ ...b });
        }
    }

    getBoulderProps() { return this.boulderProps; }
```

- [ ] **Step 2: Wire boulders into the constructor + Y-sort**

In `IsometricRenderer.js` constructor, after `generateTrees`:

```js
        this.scenery.generateBoulders(this.pathTiles, this.bridgeTiles);
        this.boulderPropSprites = this.scenery.getBoulderProps().map((b) => new StaticPropSprite({
            tileX: b.tileX,
            tileY: b.tileY,
            drawFn: (ctx, x, y) => this._drawBoulder(ctx, x, y, b),
        }));
```

Update `_snapshotSortedSprites` to include boulders too. Replace:

```js
            const agents = Array.from(this.agentSprites.values());
            const trees = this.treePropSprites || [];
            this._sortedSprites = [...agents, ...trees];
```

with:

```js
            const agents = Array.from(this.agentSprites.values());
            const trees = this.treePropSprites || [];
            const boulders = this.boulderPropSprites || [];
            this._sortedSprites = [...agents, ...trees, ...boulders];
```

- [ ] **Step 3: Implement `_drawBoulder`**

Add to `IsometricRenderer.js`:

```js
    _drawBoulder(ctx, screenX, screenY, info) {
        const s = info.scale ?? 1;
        const r = THEME.rock;

        // Shadow.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
        ctx.beginPath();
        ctx.ellipse(screenX, screenY + 4, 12 * s, 4 * s, 0, 0, Math.PI * 2);
        ctx.fill();

        // Boulder body.
        ctx.fillStyle = r.base;
        ctx.beginPath();
        if (info.variant === 'b') {
            ctx.ellipse(screenX, screenY - 5 * s, 11 * s, 8 * s, 0, 0, Math.PI * 2);
        } else {
            ctx.ellipse(screenX, screenY - 4 * s, 13 * s, 7 * s, -0.15, 0, Math.PI * 2);
        }
        ctx.fill();

        // Highlight.
        ctx.fillStyle = r.light;
        ctx.beginPath();
        ctx.ellipse(screenX - 3 * s, screenY - 7 * s, 5 * s, 2.5 * s, -0.2, 0, Math.PI * 2);
        ctx.fill();

        // Shadow side.
        ctx.fillStyle = r.dark;
        ctx.beginPath();
        ctx.ellipse(screenX + 4 * s, screenY - 2 * s, 4 * s, 2 * s, 0.1, 0, Math.PI * 2);
        ctx.fill();

        // Moss patch (only on variant 'a').
        if (info.variant === 'a') {
            ctx.fillStyle = r.moss;
            ctx.beginPath();
            ctx.ellipse(screenX - 4 * s, screenY - 6 * s, 4 * s, 1.5 * s, -0.3, 0, Math.PI * 2);
            ctx.fill();
        }
    }
```

- [ ] **Step 4: (Optional) Improve small rocks via `featureTiles`**

The existing `'stones'` feature already produces small rocks. Skip changes here unless visual smoke shows them are too sparse. To increase density, lower `0.948` to `0.93` in `_generateTerrainFeatures` (`IsometricRenderer.js:242`). **Default: leave unchanged.**

- [ ] **Step 5: Syntax check + visual smoke**

```bash
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Reload, take `output/scenery-task9-boulders.png`. Confirm 8 visible boulders distributed across the map; agents Y-sort correctly against them.

- [ ] **Step 6: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/SceneryEngine.js claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(scenery): add Y-sorted boulder props"
```

---

## Task 10: Minimap integration

The minimap needs to render bridges (so the map looks coherent) and reflect new water shape. Static-layer cache key must include the new sizes or the minimap won't refresh.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Minimap.js:159-217`
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:732-736`

- [ ] **Step 1: Pass new layers from the renderer**

In `IsometricRenderer.js:732`, the current call is:

```js
        this.minimap.draw(this.world, this.camera, canvas, {
            pathTiles: this.pathTiles,
            waterTiles: this.waterTiles,
            selectedAgent: this.selectedAgent,
        });
```

Extend it:

```js
        this.minimap.draw(this.world, this.camera, canvas, {
            pathTiles: this.pathTiles,
            waterTiles: this.waterTiles,
            bridgeTiles: this.bridgeTiles,
            selectedAgent: this.selectedAgent,
        });
```

(We do not pass trees — they'd visually clutter the minimap. Boulders are also too small.)

- [ ] **Step 2: Update Minimap cache key + render**

In `Minimap.js:159-217`, modify `_ensureStaticLayer` to include bridges in the cache key and draw them on top of water:

Replace lines 161-163:

```js
        const buildingsSignature = this._snapshotBuildings(world);
        const waterSize = layers.waterTiles?.size || 0;
        const pathSize = layers.pathTiles?.size || 0;
        const key = `${waterSize}|${pathSize}|${buildingsSignature}`;
```

with:

```js
        const buildingsSignature = this._snapshotBuildings(world);
        const waterSize = layers.waterTiles?.size || 0;
        const pathSize = layers.pathTiles?.size || 0;
        const bridgeSize = layers.bridgeTiles?.size || 0;
        const key = `${waterSize}|${pathSize}|${bridgeSize}|${buildingsSignature}`;
```

After line 196 (the path layer draw), add:

```js
        if (layers.bridgeTiles) {
            this._drawTileLayer(staticCtx, layers.bridgeTiles, '#b3854c', 1.4);
        }
```

`_drawTileLayer` accepts a `Map` or a `Set` for the tile collection. If it only accepts Sets, the code must adapt. Read `_drawTileLayer` (`rg -n "_drawTileLayer" claudeville/src/presentation/character-mode/Minimap.js`) and confirm. If it iterates with `for (const key of layer)` then a Map iterates entries, not keys. To make this safe regardless:

In `_ensureStaticLayer`, just before the call above, convert to a key set if needed:

```js
        if (layers.bridgeTiles) {
            const bridgeKeys = layers.bridgeTiles instanceof Map
                ? new Set(layers.bridgeTiles.keys())
                : layers.bridgeTiles;
            this._drawTileLayer(staticCtx, bridgeKeys, '#b3854c', 1.4);
        }
```

- [ ] **Step 3: Syntax check + visual smoke**

```bash
node --check claudeville/src/presentation/character-mode/Minimap.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Reload, take `output/scenery-task10-minimap.png`. Confirm:
- Minimap shows the new river / moat layout in blue.
- Tan dots / segments indicate bridges where the river crosses paths.
- Refresh the page — minimap is consistent (cache key worked).

- [ ] **Step 4: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/Minimap.js claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(scenery): show bridges on minimap and refresh cache key"
```

---

## Task 11: Walkability grid + Pathfinder

Walkability rules (per tile):
- Water (excluding bridge tiles): **not walkable**.
- Building footprints: **not walkable**.
- Everything else (grass, paths, plaza, shore, bridges, vegetation tiles): **walkable**.

Bridges are walkable because we added them to `pathTiles` AND removed water-walkability for bridge tiles only when not on a bridge. The grid is a flat `Uint8Array` of size `MAP_SIZE * MAP_SIZE` for cache efficiency: `1 = walkable, 0 = blocked`.

`Pathfinder.findPath` uses BFS (no diagonals; cardinal-4 movement) — A* is overkill for a 40×40 grid with uniform cost. Returns a list of tile waypoints from `from` to `to` (excluding `from`, including `to`). Empty array if unreachable.

To save waypoints, the path is **simplified**: only keep direction-change tiles, plus mandatory waypoints over each bridge tile (so agents trace the bridge cleanly even on long straight runs).

**Files:**
- Create: `claudeville/src/presentation/character-mode/Pathfinder.js`
- Modify: `claudeville/src/presentation/character-mode/SceneryEngine.js` (add `getWalkabilityGrid`)
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js` (build grid, expose to AgentSprite)

- [ ] **Step 1: Add walkability grid to SceneryEngine**

Append to `SceneryEngine.js`:

```js
    getWalkabilityGrid(pathTiles) {
        const grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                const idx = y * MAP_SIZE + x;
                if (this._buildingFootprints.has(key)) continue; // 0
                if (this.waterTiles.has(key) && !this.bridgeTiles.has(key)) continue; // 0
                grid[idx] = 1;
            }
        }
        return grid;
    }
```

- [ ] **Step 2: Create Pathfinder.js**

Create `claudeville/src/presentation/character-mode/Pathfinder.js`:

```js
import { MAP_SIZE } from '../../config/constants.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Pathfinder {
    constructor(grid) {
        this.grid = grid; // Uint8Array, 1 = walkable
    }

    setGrid(grid) {
        this.grid = grid;
    }

    isWalkable(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return false;
        return this.grid[tileY * MAP_SIZE + tileX] === 1;
    }

    // Returns an array of {tileX, tileY} waypoints from `from` exclusive to `to` inclusive.
    // Empty array if unreachable. If straight-line works (no obstacles between centers
    // sampled at tile granularity), returns the single waypoint [to].
    findPath(from, to, bridgeTiles) {
        const fx = Math.round(from.tileX);
        const fy = Math.round(from.tileY);
        const tx = Math.round(to.tileX);
        const ty = Math.round(to.tileY);
        if (!this.isWalkable(tx, ty)) return [];

        // Guard: if the start tile is unwalkable (e.g., agent currently
        // straddling a shore tile due to floating-point drift), search the
        // 4 cardinal neighbors for a walkable foothold and recurse from
        // there. Prevents agents from getting permanently stuck.
        if (!this.isWalkable(fx, fy)) {
            for (const [dx, dy] of DIRS) {
                const nx = fx + dx;
                const ny = fy + dy;
                if (!this.isWalkable(nx, ny)) continue;
                const sub = this.findPath({ tileX: nx, tileY: ny }, to, bridgeTiles);
                if (sub.length > 0) return [{ tileX: nx, tileY: ny }, ...sub];
            }
            return [];
        }

        // Fast path: if a tile-step line from `from` to `to` never crosses a blocked tile,
        // skip BFS entirely.
        if (this._lineWalkable(fx, fy, tx, ty)) {
            return [{ tileX: to.tileX, tileY: to.tileY }];
        }

        // BFS.
        const N = MAP_SIZE;
        const visited = new Uint8Array(N * N);
        const parent = new Int32Array(N * N).fill(-1);
        const queue = [fy * N + fx];
        visited[fy * N + fx] = 1;
        let found = false;
        while (queue.length) {
            const cur = queue.shift();
            if (cur === ty * N + tx) { found = true; break; }
            const cx = cur % N;
            const cy = (cur - cx) / N;
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                const idx = ny * N + nx;
                if (visited[idx]) continue;
                if (!this.isWalkable(nx, ny)) continue;
                visited[idx] = 1;
                parent[idx] = cur;
                queue.push(idx);
            }
        }
        if (!found) return [];

        // Reconstruct path from to -> from.
        const tiles = [];
        let cur = ty * N + tx;
        while (cur !== -1 && cur !== fy * N + fx) {
            tiles.push({ tileX: cur % N, tileY: (cur - (cur % N)) / N });
            cur = parent[cur];
        }
        tiles.reverse();
        return this._simplify(tiles, bridgeTiles);
    }

    _lineWalkable(x0, y0, x1, y1) {
        // Bresenham-ish: step along the longer axis and require every passed tile to be walkable.
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        let cx = x0;
        let cy = y0;
        while (true) {
            if (!this.isWalkable(cx, cy)) return false;
            if (cx === x1 && cy === y1) return true;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; cx += sx; }
            if (e2 < dx) { err += dx; cy += sy; }
        }
    }

    _simplify(tiles, bridgeTiles) {
        if (tiles.length <= 1) return tiles;
        const out = [];
        let prev = tiles[0];
        let prevDir = null;
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            const next = tiles[i + 1];
            const onBridge = bridgeTiles?.has(`${t.tileX},${t.tileY}`);
            if (!next) {
                out.push(t); // always include final destination
                break;
            }
            const dir = `${Math.sign(next.tileX - t.tileX)},${Math.sign(next.tileY - t.tileY)}`;
            if (onBridge || dir !== prevDir) {
                out.push(t);
            }
            prev = t;
            prevDir = dir;
        }
        return out;
    }
}
```

- [ ] **Step 3: Build the grid in IsometricRenderer and expose it**

In `IsometricRenderer.js` constructor, after `generateBoulders`:

```js
        this.walkabilityGrid = this.scenery.getWalkabilityGrid(this.pathTiles);
        this.pathfinder = new Pathfinder(this.walkabilityGrid);
```

Add the import at the top:

```js
import { Pathfinder } from './Pathfinder.js';
```

- [ ] **Step 4: Inject pathfinder + bridgeTiles into AgentSprite**

There is exactly one `AgentSprite` construction site: `IsometricRenderer.js:537`, inside `_addAgentSprite(agent)`:

```js
const sprite = new AgentSprite(agent);
```

Change it to:

```js
const sprite = new AgentSprite(agent, {
    pathfinder: this.pathfinder,
    bridgeTiles: this.bridgeTiles,
});
```

Then change the `AgentSprite` constructor signature (`AgentSprite.js:60`) to accept the options bag. The current signature is `constructor(agent)`. Replace with:

```js
constructor(agent, { pathfinder = null, bridgeTiles = null } = {}) {
```

Inside the constructor body, alongside the existing field assignments, add (just before the closing brace, before `this._pickTarget()` if present):

```js
        this.pathfinder = pathfinder;
        this.bridgeTiles = bridgeTiles;
        this.waypoints = [];
        this._lastPathTileKey = null;
```

- [ ] **Step 5: Syntax check**

```bash
node --check claudeville/src/presentation/character-mode/Pathfinder.js
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
node --check claudeville/src/presentation/character-mode/AgentSprite.js
```

All exit 0.

- [ ] **Step 6: Smoke test the pathfinder in isolation**

Run from repo root:

```bash
node --input-type=module -e "
import { Pathfinder } from './claudeville/src/presentation/character-mode/Pathfinder.js';
const N = 40;
const grid = new Uint8Array(N * N).fill(1);
// Block a diagonal river: y == x for x in [10, 30]
for (let x = 10; x <= 30; x++) grid[x * N + x] = 0;
// Bridge at (20, 20)
grid[20 * N + 20] = 1;
const pf = new Pathfinder(grid);
const path = pf.findPath({ tileX: 5, tileY: 25 }, { tileX: 25, tileY: 5 }, new Map([['20,20', {}]]));
console.log('path length:', path.length, 'first waypoint:', path[0], 'last waypoint:', path[path.length - 1]);
console.log(path.length > 0 ? 'OK' : 'FAIL: no path');
"
```

Expected: a non-empty path that includes a waypoint at or near (20, 20). If output is `FAIL`, the pathfinder is broken.

- [ ] **Step 7: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/Pathfinder.js claudeville/src/presentation/character-mode/SceneryEngine.js claudeville/src/presentation/character-mode/IsometricRenderer.js claudeville/src/presentation/character-mode/AgentSprite.js
git commit -m "feat(scenery): add walkability grid and BFS pathfinder"
```

---

## Task 12: AgentSprite waypoint consumption

Today, `AgentSprite.update()` moves toward `(targetX, targetY)` in screen space and stops when within ε. We add a `waypoints` queue (in **screen** coords). When the queue is non-empty, `targetX/Y` come from the head; when reached, pop and load the next. When the entire queue empties, fall back to the agent's natural target.

When a new target is set (e.g., agent visiting a building), we ask the pathfinder for tile waypoints and convert them to screen waypoints. If the path is just the destination, the sprite behaves exactly as before.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js`

- [ ] **Step 1: Locate the actual target-assignment site**

The target is set inside `AgentSprite._pickTarget()` (`AgentSprite.js:91`), NOT in `update()`. The two assignments to read are at `AgentSprite.js:117-118` and `AgentSprite.js:132-133`. They look like:

```js
this.targetX = screen.x;
this.targetY = screen.y;
```

`_pickTarget` is invoked from multiple sites (lines 88, 211, 218, 224, 255, 263) — confirm with `rg -n "_pickTarget" claudeville/src/presentation/character-mode/AgentSprite.js`. We do not change those callers; we only change `_pickTarget` itself.

- [ ] **Step 2: Waypoint queue field already added in Task 11 Step 4**

The fields `this.waypoints = []` and `this._lastPathTileKey = null` were added to the constructor in Task 11 Step 4. No new edit needed here. (Skip this step; proceed to Step 3.)

- [ ] **Step 3: Replace the target-setting with a wrapper**

Add a private method to `AgentSprite`:

```js
_assignTarget(targetScreenX, targetScreenY, targetTileX, targetTileY) {
    // If pathfinder is unavailable, fall through to direct assignment.
    if (!this.pathfinder) {
        this.targetX = targetScreenX;
        this.targetY = targetScreenY;
        this.waypoints = [];
        return;
    }
    const fromTile = this._screenToTile(this.x, this.y);
    const tileKey = `${Math.round(targetTileX)},${Math.round(targetTileY)}`;
    if (tileKey === this._lastPathTileKey && this.waypoints.length > 0) {
        // Same destination, keep existing path.
        return;
    }
    this._lastPathTileKey = tileKey;
    const tilePath = this.pathfinder.findPath(
        fromTile,
        { tileX: targetTileX, tileY: targetTileY },
        this.bridgeTiles,
    );
    if (tilePath.length === 0) {
        // No path — give up cleanly and just sit still at current position.
        this.waypoints = [];
        this.targetX = this.x;
        this.targetY = this.y;
        return;
    }
    this.waypoints = tilePath.map((t) => ({
        x: (t.tileX - t.tileY) * TILE_WIDTH / 2,
        y: (t.tileX + t.tileY) * TILE_HEIGHT / 2,
    }));
    const head = this.waypoints[0];
    this.targetX = head.x;
    this.targetY = head.y;
}

_screenToTile(x, y) {
    // Inverse of (tileX - tileY) * TILE_WIDTH / 2, (tileX + tileY) * TILE_HEIGHT / 2
    const tileX = (x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) / 2;
    const tileY = (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) / 2;
    return { tileX, tileY };
}
```

(Imports: `TILE_WIDTH`, `TILE_HEIGHT` from `'../../config/constants.js'` — check existing imports at top of `AgentSprite.js` and add if missing.)

- [ ] **Step 4: Replace the two existing target assignments inside `_pickTarget`**

In `_pickTarget` at `AgentSprite.js:91-136`, replace each occurrence of:

```js
this.targetX = screen.x;
this.targetY = screen.y;
```

with:

```js
this._assignTarget(screen.x, screen.y, this.agent.position.tileX, this.agent.position.tileY);
```

`Position` (verified at `claudeville/src/domain/value-objects/Position.js:1-26`) exposes `tileX` and `tileY` directly — no defensive fallback needed.

The chat-partner-target lines at `AgentSprite.js:94-95` and `AgentSprite.js:202-203` deal with screen-only targets relative to another sprite — leave them as direct screen assignments, but add `this.waypoints = []` immediately after each to clear any stale path so the agent doesn't oscillate when entering chat mode.

- [ ] **Step 5: Pop waypoints in the movement loop**

Find the movement step in `update()` (lines 228-241 per earlier grep):

```js
const dx = this.targetX - this.x;
const dy = this.targetY - this.y;
// ...
const dist = Math.hypot(dx, dy);
if (dist < someEpsilon) {
    // currently: stop / mark arrived
}
// ...
this.x += (dx / dist) * speed;
this.y += (dy / dist) * speed;
```

Read the actual code carefully and find the "arrived at target" branch. When the sprite arrives at the current waypoint and `this.waypoints.length > 1`, pop the head and load the next:

```js
const dist = Math.hypot(dx, dy);
const speed = this._speedForState();
if (dist < speed) {
    // Arrived at this waypoint.
    this.x = this.targetX;
    this.y = this.targetY;
    if (this.waypoints.length > 0) {
        this.waypoints.shift();
        if (this.waypoints.length > 0) {
            this.targetX = this.waypoints[0].x;
            this.targetY = this.waypoints[0].y;
        }
    }
    return;
}
this.x += (dx / dist) * speed;
this.y += (dy / dist) * speed;
```

The exact integration depends on the existing flow — the goal is: when the sprite reaches `targetX/Y`, advance to the next waypoint if any.

- [ ] **Step 6: Syntax check**

Run: `node --check claudeville/src/presentation/character-mode/AgentSprite.js`

Expected: exit 0.

- [ ] **Step 7: Visual smoke (this is the big one)**

Reload `http://localhost:4000`. Take screenshot `output/scenery-task12-pathing.png`.

Watch for at least 30 seconds: when an agent's destination is on the other side of the river, the agent should detour via a bridge instead of walking through water. Specifically:

1. Pick an agent visible in the world.
2. Wait for it to switch buildings (you can force this faster by switching providers or by stub-injecting an agent move via the browser console: `eventBus.emit('agent:updated', {...})` — optional).
3. Confirm the path visibly bends toward a bridge before crossing.
4. Confirm the agent never appears to walk on a water tile (other than bridge tiles).
5. Confirm sprites don't oscillate / get stuck.

If agents appear stuck: log the path output. Add `console.log(this.waypoints)` temporarily inside `_assignTarget`, reload, watch the console.

- [ ] **Step 8: Commit**

```bash
git status --short
git add claudeville/src/presentation/character-mode/AgentSprite.js
git commit -m "feat(scenery): route agents around water via bridge waypoints"
```

---

## Task 13: Final polish + smoke

A wrap-up task: capture final screenshots, verify the full validation checklist from `claudeville/CLAUDE.md` passes, and tidy up.

**Files:**
- No new code edits expected. If the smoke pass surfaces a small visual nit (a tree clipping through a building corner, a bridge that misses water on one tile), fix it in-place by tuning `claudeville/src/config/scenery.js` only.

- [ ] **Step 1: Run the syntax checklist from CLAUDE.md**

```bash
node --check claudeville/server.js
find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check
node --check claudeville/src/config/scenery.js
node --check claudeville/src/config/theme.js
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/Pathfinder.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
node --check claudeville/src/presentation/character-mode/AgentSprite.js
node --check claudeville/src/presentation/character-mode/Minimap.js
```

All exit 0.

- [ ] **Step 2: Run the runtime smoke checklist**

- Visit `http://localhost:4000` and confirm both World and Dashboard modes load.
- Select an agent, confirm the right activity panel opens.
- Deselect, confirm it closes.
- Resize the browser, confirm canvas still fills `.content`.
- Open `http://localhost:4000/api/providers` and `http://localhost:4000/api/sessions` — both return JSON.
- Browser console clean.

- [ ] **Step 3: Run the docs locale check**

```bash
rg -n -P "\\p{Hangul}" $(rg --files -g '*.md' --glob '!node_modules')
```

Expected: no matches.

- [ ] **Step 4: Capture final screenshots**

- `output/scenery-final-world.png` (full world, default zoom)
- `output/scenery-final-river.png` (zoomed onto the diagonal river crossing)
- `output/scenery-final-moat.png` (zoomed onto SW or NE corner moat)

- [ ] **Step 5: Confirm git status is clean and scoped**

```bash
git status --short
```

Expected: only the files this plan intended to touch — plus any pre-existing modifications from other agents. Do not stage / commit / revert pre-existing files.

- [ ] **Step 6: Final commit and merge guidance**

If small visual fixes were made in Step 4, commit:

```bash
git add claudeville/src/config/scenery.js
git commit -m "tune(scenery): final coordinate adjustments after visual smoke"
```

The branch `feature/scenery-engine` is now ready for review / merge per the user's preferred workflow (per `AGENTS.md`, the user owns merge decisions; do not push without explicit ask).

---

## Self-Review Notes

**Spec coverage:**
- Water (moat + river): Tasks 2, 3, 4 ✓
- Bridges: Tasks 5, 6 ✓
- Vegetation: Tasks 7 (bushes/grass), 8 (trees) ✓
- Rocks: Task 9 ✓
- Minimap consistency: Task 10 ✓
- Agent pathing across bridges: Tasks 11, 12 ✓
- New scenery engine module: Task 3+ ✓
- Authored polylines: Task 2 ✓

**Type consistency:**
- `bridgeTiles` is consistently a `Map<string, {orientation}>` across SceneryEngine, IsometricRenderer, Minimap, Pathfinder.
- `getWalkabilityGrid()` returns `Uint8Array(MAP_SIZE * MAP_SIZE)`; index = `y * MAP_SIZE + x`. Pathfinder consumes the same shape.
- `findPath` returns `Array<{tileX, tileY}>`; AgentSprite converts to screen-space `{x, y}` waypoints.
- `THEME` palette names match exactly: `deepWater`, `bridgeWood`, `treeFoliage`, `treeTrunk`, `treeTrunkLight`, `bushFoliage`, `rock`.

**Open risks captured for the executor:**
- Pre-existing modifications in other files (CSS / topbar / Minimap etc.) belong to other agents — do not stage them. When Task 13 Step 5 says "git status clean and scoped," ignore the pre-existing entries recorded in Task 0 Step 1.
- The constructor wiring in `IsometricRenderer.js` (Tasks 4, 5, 7, 8, 9, 11) accumulates state in a specific order: paths → scenery (water/shores) → bridges → re-classify roads (after clearing `mainAvenueTiles`/`dirtPathTiles`) → terrain features → flat vegetation → trees → boulders → walkability + pathfinder. If a step is skipped or reordered, later tasks will see undefined sets or stale data. Verify with `rg -n "this\\.scenery\\." claudeville/src/presentation/character-mode/IsometricRenderer.js` after each task.
- `Position` exposes `tileX`/`tileY` directly (`Position.js:1-26`); use those rather than reverse-projecting from screen coords.
- Agent waypoint pathing has a known fail-stuck mode if an agent's current tile is unwalkable. Task 11's `findPath` includes a guard that walks one cardinal step to a walkable neighbor; if you see agents stuck in place near a shore, log `_lastPathTileKey` and `from` to the console to confirm the guard fired.
- BFS direction order (`DIRS` constant) is deterministic — same destination always picks the same route. That's intended (no save state means visual reproducibility is good); flag it if route monotony becomes ugly during smoke.
- Bridges painted inside `_drawTile` render *under* agents who walk on them. Rails are simple line strokes near the diamond perimeter, so the loss of "rails-in-front" occlusion is cosmetically acceptable for v1.
- The full plan's render cost is dominated by Y-sort growth and per-tile feature draws. If frame rate drops noticeably after Task 8, the optimization in Task 8's "Cache invalidation note" is the lever. Also consider lowering `TREE_CLUSTERS` densities in `claudeville/src/config/scenery.js`.
