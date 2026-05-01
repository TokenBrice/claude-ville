# Center Island Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty central plaza with a luxurious tropical island interior centered on a chatoyant lily pool, plus close the lighthouse-portal shore gap with a vegetated bluff.

**Architecture:** Config-only change. Edits two files (`scenery.js`, `townPlan.js`) and adds one new sprite (`prop.fishSchoolKoi`). The `SceneryEngine` already excludes path/water/building tiles from tree placement, so adding tree clusters that overlap rerouted roads is safe. Chatoyant shimmer comes from layered surface props (lily pads + koi school + mangrove roots + buoy + lagoon weather profile) over a small `WATER_BASIN` — no engine changes needed.

**Tech Stack:** Vanilla ES modules. PixelLab MCP for sprite generation. No build step, no test runner.

**Source spec:** `agents/plans/center-island-design.md`

**Baseline HEAD:** `94632a5` (post-spec commit)

---

## File Structure

| File | Purpose | Change type |
| --- | --- | --- |
| `claudeville/assets/sprites/prop/fishSchoolKoi.png` | New koi school sprite, replacing teal in central pool | Create |
| `claudeville/assets/sprites/manifest.yaml` | Manifest entry for `prop.fishSchoolKoi` | Add one entry |
| `claudeville/src/config/scenery.js` | All vegetation, water, props, clearings | Add to multiple arrays; modify two existing entries |
| `claudeville/src/config/townPlan.js` | Road waypoints rerouted around the new pool | Modify two route entries |

Each task below is one logical commit boundary. Tasks within a phase can be batched in one commit if the engineer prefers; phase boundaries should always commit.

---

## Phase 1: Sprite generation (highest variance — do first)

### Task 1: Generate `prop.fishSchoolKoi` sprite

**Files:**
- Create: `claudeville/assets/sprites/prop/fishSchoolKoi.png`

- [ ] **Step 1: Verify the template sprite still exists**

```bash
ls -la claudeville/assets/sprites/prop/fishSchoolTeal.png
```

Expected: file exists with non-zero size.

- [ ] **Step 2: Call pixellab to generate the koi sprite**

Use `mcp__pixellab__create_isometric_tile` with these parameters:
- `prompt`: `"small school of bright orange and white koi silhouettes just below dark green pond water surface, subtle warm sparkle, transparent background only, no water tile, no square base, empty transparent corners"`
- `size`: `32`
- Save resulting PNG to `claudeville/assets/sprites/prop/fishSchoolKoi.png`

- [ ] **Step 3: Visually inspect the generated sprite**

Open the PNG. Verify: warm orange/white koi silhouettes are visible against transparent background; no baked-in water tile or square base; sprite reads at 32px.

If unacceptable, regenerate (time-box to 3 attempts total). If still unacceptable after 3 attempts, fall back: skip Task 2 and Task 6 (use `prop.fishSchoolTeal` for the central pool school instead).

### Task 2: Add manifest entry for `prop.fishSchoolKoi`

**Files:**
- Modify: `claudeville/assets/sprites/manifest.yaml` (insert after line 623, the existing `fishSchoolTeal` entry)

- [ ] **Step 1: Insert the manifest entry**

Insert this block immediately after the `prop.fishSchoolTeal` entry (after line 623, before the blank line and `prop.gullFlight`):

```yaml
  - id: prop.fishSchoolKoi
    tool: isometric_tile
    prompt: "small school of bright orange and white koi silhouettes just below dark green pond water surface, subtle warm sparkle, transparent background only, no water tile, no square base, empty transparent corners"
    size: 32
    anchor: [16, 18]
```

- [ ] **Step 2: Run sprite validation**

```bash
npm run sprites:validate
```

Expected: PASS — every manifest entry resolves to a real PNG and no orphan PNGs exist.

- [ ] **Step 3: Commit**

```bash
git add claudeville/assets/sprites/prop/fishSchoolKoi.png claudeville/assets/sprites/manifest.yaml
git commit -m "Add fishSchoolKoi sprite for central island pool"
```

---

## Phase 2: Scenery config edits (`claudeville/src/config/scenery.js`)

All Phase 2 edits land in one commit at the end. Use `node --check` after each task.

### Task 3: Add the central pool basin

**Files:**
- Modify: `claudeville/src/config/scenery.js` — append to `WATER_BASINS` array (line 68 onward, before the closing `];` at line 168)

- [ ] **Step 1: Insert the basin entry**

Insert this entry as the last element of the `WATER_BASINS` array (after the existing harbor basin at line 167, before the closing `];`):

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
    },
```

- [ ] **Step 2: Syntax check**

```bash
node --check claudeville/src/config/scenery.js
```

Expected: no output, exit code 0.

### Task 4: Add the central forest floor region

**Files:**
- Modify: `claudeville/src/config/scenery.js` — append to `FOREST_FLOOR_REGIONS` array (line 206)

- [ ] **Step 1: Insert the region entry**

Insert this as the last element of `FOREST_FLOOR_REGIONS` (after the `lighthouse-windbreak` entry at line 211):

```js
    { name: 'central-isle', centerX: 17, centerY: 22, radiusX: 7, radiusY: 6, base: '#2c5a32', accent: '#6c9a48', strength: 0.95 },
```

- [ ] **Step 2: Syntax check**

```bash
node --check claudeville/src/config/scenery.js
```

Expected: no output, exit code 0.

### Task 5: Add three central tree clusters

**Files:**
- Modify: `claudeville/src/config/scenery.js` — append to `TREE_CLUSTERS` array (line 220)

- [ ] **Step 1: Insert three entries**

Insert these three entries as the last elements of `TREE_CLUSTERS` (after the existing `centerX: 35, centerY: 15` entry at line 239):

```js
    { centerX: 14, centerY: 21, radiusX: 4.6, radiusY: 4.0, density: 0.78, palmBias: 0.55 },
    { centerX: 20, centerY: 22, radiusX: 4.4, radiusY: 4.0, density: 0.74, palmBias: 0.50 },
    { centerX: 17, centerY: 19, radiusX: 5.2, radiusY: 3.4, density: 0.70, palmBias: 0.48 },
```

- [ ] **Step 2: Syntax check**

```bash
node --check claudeville/src/config/scenery.js
```

Expected: no output, exit code 0.

### Task 6: Add palms, broadleaves, boulders, koi school

**Files:**
- Modify: `claudeville/src/config/scenery.js` — append to `TROPICAL_PALMS` (line 242), `TROPICAL_BROADLEAF_TREES` (line 260), `BOULDERS` (line 270), `MARINE_FISH_SCHOOLS` (line 357)

- [ ] **Step 1: Append five palms**

Insert these five entries as the last elements of `TROPICAL_PALMS` (after the existing `tileX: 24.8, tileY: 9.6` entry at line 257):

```js
    { tileX: 14.6, tileY: 23.4, scale: 1.22, seed: 0.34 },
    { tileX: 19.4, tileY: 23.6, scale: 1.18, seed: 0.61 },
    { tileX: 18.5, tileY: 24.6, scale: 1.20, seed: 0.27 },
    { tileX: 15.4, tileY: 20.2, scale: 1.16, seed: 0.82 },
    { tileX: 19.8, tileY: 20.6, scale: 1.24, seed: 0.45 },
```

- [ ] **Step 2: Append four broadleaves**

Insert these four entries as the last elements of `TROPICAL_BROADLEAF_TREES` (after the existing `tileX: 18.6, tileY: 10.8` entry at line 266):

```js
    { tileX: 13.8, tileY: 22.8, scale: 1.20, seed: 0.18 },
    { tileX: 20.6, tileY: 21.4, scale: 1.16, seed: 0.55 },
    { tileX: 17.6, tileY: 24.4, scale: 1.18, seed: 0.71 },
    { tileX: 22.5, tileY: 13.8, scale: 1.14, seed: 0.39 },
```

- [ ] **Step 3: Append five boulders**

Insert these five entries as the last elements of `BOULDERS` (after the existing `tileX: 32.8, tileY: 6.5` entry at line 283):

```js
    { tileX: 22.0, tileY: 14.0, scale: 1.05, variant: 'b' },
    { tileX: 23.2, tileY: 13.2, scale: 0.95, variant: 'b' },
    { tileX: 18.6, tileY: 23.2, scale: 0.90, variant: 'a' },
    { tileX: 19.0, tileY: 22.4, scale: 1.00, variant: 'a' },
    { tileX: 16.4, tileY: 23.4, scale: 0.85, variant: 'a' },
```

- [ ] **Step 4: Append koi school**

Insert this entry as the last element of `MARINE_FISH_SCHOOLS` (after the existing `tileX: 36.6, tileY: 24.0` entry at line 361):

```js
    { tileX: 17.0, tileY: 22.0, id: 'prop.fishSchoolKoi', radius: 0.20, phase: 1.4 },
```

If Task 1 fell back to using `fishSchoolTeal`, change `id` to `'prop.fishSchoolTeal'`.

- [ ] **Step 5: Syntax check**

```bash
node --check claudeville/src/config/scenery.js
```

Expected: no output, exit code 0.

### Task 7: Move runeFountain and add shrine props to DISTRICT_PROPS

**Files:**
- Modify: `claudeville/src/config/scenery.js` — `DISTRICT_PROPS` array (line 331)

- [ ] **Step 1: Move the existing runeFountain entry**

Replace this line (currently line 334):

```js
    { tileX: 16.2, tileY: 22.0, id: 'prop.runeFountain', layer: 'cache', district: 'civic' },
```

with:

```js
    { tileX: 15.4, tileY: 21.6, id: 'prop.runeFountain', layer: 'cache', district: 'civic' },
```

- [ ] **Step 2: Append shrine, pool surface, and pool edge props**

Insert these entries as the last elements of `DISTRICT_PROPS` (after the existing `prop.driftwood.log` entry at line 354):

```js
    // Central island shrine and lily pool composition.
    { tileX: 15.0, tileY: 22.4, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' },
    { tileX: 15.6, tileY: 21.0, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' },
    { tileX: 15.2, tileY: 22.2, id: 'prop.runeBrazier', layer: 'cache', district: 'civic' },
    { tileX: 17.2, tileY: 21.6, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 16.6, tileY: 22.2, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 17.6, tileY: 22.4, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 17.0, tileY: 21.4, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 16.8, tileY: 22.6, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 17.4, tileY: 22.7, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'civic' },
    { tileX: 16.4, tileY: 21.4, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' },
    { tileX: 16.2, tileY: 22.4, id: 'prop.mangroveRoot.arch', layer: 'sorted', district: 'civic' },
    { tileX: 17.8, tileY: 21.4, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' },
    { tileX: 17.6, tileY: 22.8, id: 'prop.driftwood.log', layer: 'cache', district: 'civic' },
```

- [ ] **Step 3: Syntax check**

```bash
node --check claudeville/src/config/scenery.js
```

Expected: no output, exit code 0.

### Task 8: Update SCENERY_CLEARINGS

**Files:**
- Modify: `claudeville/src/config/scenery.js` — `SCENERY_CLEARINGS` array (line 310)

- [ ] **Step 1: Shrink `command-skyline` clearing**

Replace this line (currently line 314):

```js
    { name: 'command-skyline', centerX: 20.4, centerY: 16.0, radius: 4.4, strength: 0.22 },
```

with:

```js
    { name: 'command-skyline', centerX: 20.4, centerY: 16.0, radius: 2.8, strength: 0.15 },
```

- [ ] **Step 2: Delete the `north-bank-civic` clearing**

Remove this entire line (currently line 316):

```js
    { name: 'north-bank-civic', centerX: 20, centerY: 22, radius: 6.4, strength: 0.23 },
```

- [ ] **Step 3: Append two new road-bend clearings**

Insert these entries as the last elements of `SCENERY_CLEARINGS` (after the existing `harbor-mouth` entry, currently line 322):

```js
    { name: 'isle-promenade-bend', centerX: 14, centerY: 21, radius: 1.6, strength: 0.5 },
    { name: 'isle-bridge-bend', centerX: 20, centerY: 23, radius: 1.8, strength: 0.5 },
```

- [ ] **Step 4: Syntax check**

```bash
node --check claudeville/src/config/scenery.js
```

Expected: no output, exit code 0.

### Task 9: Commit Phase 2

- [ ] **Step 1: Stage and commit all scenery edits**

```bash
git add claudeville/src/config/scenery.js
git commit -m "Convert central plaza to lush tropical island interior"
```

---

## Phase 3: Road reroutes (`claudeville/src/config/townPlan.js`)

### Task 10: Reroute `north-bank-promenade` and `central-river-bridge`

**Files:**
- Modify: `claudeville/src/config/townPlan.js:50-54` (`north-bank-promenade`) and `claudeville/src/config/townPlan.js:68-72` (`central-river-bridge`)

- [ ] **Step 1: Replace the `north-bank-promenade` points line**

Find this line (currently line 53):

```js
        points: [[7, 23], [10, 20], [16, 20], [23, 18], [28, 16], [29, 13]],
```

Replace with:

```js
        points: [[7, 23], [10, 20], [14, 21], [16, 20], [23, 18], [28, 16], [29, 13]],
```

- [ ] **Step 2: Replace the `central-river-bridge` points line**

Find this line (currently line 71):

```js
        points: [[16, 20], [18, 22], [18, 25], [18, 27], [24, 31], [24, 37]],
```

Replace with:

```js
        points: [[16, 20], [19, 21], [20, 23], [19, 26], [18, 27], [24, 31], [24, 37]],
```

- [ ] **Step 3: Syntax check**

```bash
node --check claudeville/src/config/townPlan.js
```

Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/config/townPlan.js
git commit -m "Reroute central roads around new island pool"
```

---

## Phase 4: Validation

### Task 11: Runtime smoke check

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected: server starts on port 4000, no errors logged.

- [ ] **Step 2: Open the world view in a browser**

Navigate to `http://localhost:4000`.

Expected:
- Pool renders at the central island with visible lily pads, koi flicker, and lagoon ripple animation.
- Canopy density at the central island reads as luxuriantly overgrown — multiple trees visible across the area, no large empty tile expanse.
- Shore-gap area between lighthouse and portal looks continuous (vegetated bluff with boulders + broadleaf, no broken-shore reading).
- The runeFountain reads as a small shrine on a vegetated outcrop just west of the pool, flanked by mossy standing stones and the runeBrazier.
- Lighthouse, portal, harbor master, command center are all still visible from default zoom.

If any of the above fails, see "Residual Risks" in `agents/plans/center-island-design.md` for specific tuning steps (lily pad count, tree cluster radius, etc.).

- [ ] **Step 3: Pathfinding check**

In the browser, click an agent to follow them. Watch them traverse the central area (or wait for one to). Confirm: agents route around the pool — none walk through the lily pads or get stuck in dense canopy.

- [ ] **Step 4: Stop the server**

Stop the `npm run dev` process.

### Task 12: Visual diff baseline

- [ ] **Step 1: Capture fresh sprite baseline**

```bash
npm run sprites:capture-fresh
```

- [ ] **Step 2: Run pixelmatch diff**

```bash
npm run sprites:visual-diff
```

Expected: report generated. Review for any unexpected sprite regressions (none expected since only one new sprite was added).

### Task 13: Side-by-side screenshot comparison

- [ ] **Step 1: Capture central island region**

Use Playwright (via `mcp__plugin_playwright_playwright__browser_take_screenshot`) to capture the central island area at default zoom. Save to a working location (not committed).

- [ ] **Step 2: Compare against the source `before` image**

Mentally compare against image 2 from the original conversation (the empty-plaza screenshot). Confirm:
- The center is no longer the lacklusting part of the composition.
- The pool reads as the chatoyant focal point.
- Density across the island matches the inspiration's "every square inch covered" feel.

If any visual goal is not met, return to Phase 2 and tune (specifically: tree cluster densities in Task 5, lily pad count in Task 7, or `command-skyline` clearing radius in Task 8).

---

## Self-review notes

Coverage check against `agents/plans/center-island-design.md`:

- Spec §Plan.1 (sprite gen) → Task 1, 2 ✓
- Spec §Plan.2 WATER_BASINS → Task 3 ✓
- Spec §Plan.2 FOREST_FLOOR_REGIONS → Task 4 ✓
- Spec §Plan.2 TREE_CLUSTERS → Task 5 ✓
- Spec §Plan.2 TROPICAL_PALMS, BROADLEAF, BOULDERS, MARINE_FISH_SCHOOLS → Task 6 ✓
- Spec §Plan.2 DISTRICT_PROPS (move runeFountain + add 13 props) → Task 7 ✓
- Spec §Plan.2 SCENERY_CLEARINGS (delete, shrink, add 2) → Task 8 ✓
- Spec §Plan.3 north-bank-promenade waypoint insert → Task 10 ✓
- Spec §Plan.3 central-river-bridge reroute → Task 10 ✓
- Spec §Plan.4 validation (sprites:validate, node --check, npm run dev, pathfinding, sprites:visual-diff, screenshot compare) → Tasks 2, 3-8, 11, 12, 13 ✓

No spec requirements are missing from the task list. No placeholders. Type/identifier consistency verified — `prop.fishSchoolKoi` is the same id across manifest, MARINE_FISH_SCHOOLS, and the fallback note. All file path line numbers match the current HEAD baseline.
