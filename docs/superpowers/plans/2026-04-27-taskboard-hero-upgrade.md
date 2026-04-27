# Task Board Hero Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat single-tile Task Board sprite with a hero-scale Arcane Rune Chronicle Court: twin stone towers flanking an amber-glowing rune tablet, composed from a 3×2 grid of tiles with an animated runeGlow overlay.

**Architecture:** The manifest drives everything — update `manifest.yaml` to declare the hero building, generate 7 PNGs via the PixelLab MCP, then delete the old single tile. `AssetManager._loadComposedBuilding` stitches 6 independent 64px tiles into a 312×208 canvas automatically (each tile is generated separately — they're not slices of one render; PixelLab generates each as its own isometric crop of the same building description, and the stitched composite reads as a larger hero structure). No renderer code changes needed. `visualTier` in `buildings.js` is metadata only (not read by the renderer), but update it for correctness.

**Tech Stack:** PixelLab MCP (`mcp__pixellab__create_isometric_tile`, `mcp__pixellab__get_isometric_tile`), Node.js `--check` for syntax, `npm run sprites:validate` (manifest-validator.mjs), browser smoke at `http://localhost:4000`.

---

## File Map

| File | Change |
|---|---|
| `claudeville/assets/sprites/manifest.yaml` | Replace single-tile `building.taskboard` entry with hero `composeGrid: [3,2]` entry |
| `claudeville/src/config/buildings.js` | `visualTier: 'major'` → `'hero'` for taskboard |
| `claudeville/assets/sprites/buildings/building.taskboard/base-0-0.png` | **Create** — grid cell col 0 row 0 |
| `claudeville/assets/sprites/buildings/building.taskboard/base-0-1.png` | **Create** — grid cell col 0 row 1 |
| `claudeville/assets/sprites/buildings/building.taskboard/base-1-0.png` | **Create** — grid cell col 1 row 0 (center top) |
| `claudeville/assets/sprites/buildings/building.taskboard/base-1-1.png` | **Create** — grid cell col 1 row 1 (center bottom) |
| `claudeville/assets/sprites/buildings/building.taskboard/base-2-0.png` | **Create** — grid cell col 2 row 0 |
| `claudeville/assets/sprites/buildings/building.taskboard/base-2-1.png` | **Create** — grid cell col 2 row 1 |
| `claudeville/assets/sprites/buildings/building.taskboard/runeGlow.png` | **Create** — animated overlay (amber rune pulse) |
| `claudeville/assets/sprites/buildings/building.taskboard/base.png` | **Delete** — replaced by grid cells |

---

## Task 1: Update manifest and buildings.js

**Files:**
- Modify: `claudeville/assets/sprites/manifest.yaml` (lines ~349–353)
- Modify: `claudeville/src/config/buildings.js` (line ~29)

- [ ] **Step 1: Replace the taskboard manifest entry**

In `claudeville/assets/sprites/manifest.yaml`, find and remove:

```yaml
  - id: building.taskboard
    tool: isometric_tile
    prompt: "epic task board hall, open-sided pavilion with carved stone pillars, scrolls and parchment notices pinned to boards, guild pennant flying, isometric"
    size: 64
    displaySize: 112
```

Replace with:

```yaml
  # ── HERO: Task Board (Arcane Rune Chronicle Court) ──
  - id: building.taskboard
    composeGrid: [3, 2]
    splitForOcclusion: true
    horizonY: 130
    layers:
      base:
        tool: isometric_tile
        prompt: "epic arcane rune chronicle court, twin ancient crenellated stone watchtowers with amber torch sconces flanking a massive central inscribed tablet, rune-carved stone face with horizontal amber glowing inscription lines, burnished gold arcane seal at top center, stone plinth base with guild relief, warm golden firelight, heroic isometric RPG landmark"
        size: 64
        displaySize: 104
      runeGlow:
        tool: isometric_tile
        prompt: "pulsing warm amber rune glow radiating from carved stone tablet surface, horizontal glowing inscription lines, burnished gold arcane energy, transparent background, isometric"
        size: 64
        anchor: [156, 80]
        animation: pulse
    emitters:
      torch:  [52, 148]
      torch2: [260, 148]
      sparkle:  [156, 74]
      sparkle2: [156, 30]
    lightSource: [156, 80]
    lightColor: '#ffb347'
    lightRadius: 80
    lightOverlay: 'atmosphere.light.fire-glow'
```

- [ ] **Step 2: Update visualTier in buildings.js**

In `claudeville/src/config/buildings.js`, find the taskboard entry (around line 29) and change one field:

```js
// before
visualTier: 'major',

// after
visualTier: 'hero',
```

- [ ] **Step 3: Syntax check**

```bash
node --check claudeville/server.js
```

Expected: no output (clean).

- [ ] **Step 4: Confirm validate FAILS (expected red state)**

```bash
npm install && npm run sprites:validate 2>&1 | tail -20
```

Expected output includes:
```
MISSING: buildings/building.taskboard/base-0-0.png
MISSING: buildings/building.taskboard/base-0-1.png
MISSING: buildings/building.taskboard/base-1-0.png
MISSING: buildings/building.taskboard/base-1-1.png
MISSING: buildings/building.taskboard/base-2-0.png
MISSING: buildings/building.taskboard/base-2-1.png
MISSING: buildings/building.taskboard/runeGlow.png
ORPHAN: buildings/building.taskboard/base.png
```

This is the intended failing state before sprite generation.

- [ ] **Step 5: Commit config changes**

```bash
git add claudeville/assets/sprites/manifest.yaml claudeville/src/config/buildings.js
git commit -m "feat: upgrade task board to hero composeGrid[3,2] arcane rune court"
```

---

## Task 2: Smoke test — generate first base cell

Before bulk generation, prove the PixelLab pipeline works with one cell.

**Files:**
- Create: `claudeville/assets/sprites/buildings/building.taskboard/base-1-0.png`

- [ ] **Step 1: Load PixelLab tool schemas**

```
ToolSearch: select:mcp__pixellab__create_isometric_tile,mcp__pixellab__get_isometric_tile
```

- [ ] **Step 2: Call create_isometric_tile for cell base-1-0**

Call `mcp__pixellab__create_isometric_tile` with these parameters:
- `description`: `"epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks, epic arcane rune chronicle court, twin ancient crenellated stone watchtowers with amber torch sconces flanking a massive central inscribed tablet, rune-carved stone face with horizontal amber glowing inscription lines, burnished gold arcane seal at top center, stone plinth base with guild relief, warm golden firelight, heroic isometric RPG landmark"`
- `size`: `64`
- `detail`: `"highly detailed"`
- `shading`: `"detailed shading"`

Save the returned `tile_id` (UUID string).

- [ ] **Step 3: Poll until complete**

Call `mcp__pixellab__get_isometric_tile` with `tile_id` set to the UUID from Step 2. Repeat until `status` is `"completed"`. If `status` is `"failed"`, read the `error` field and stop. The completed result contains a `download_url` field (the URL to the PNG) and a `url` or base64 field — use whichever contains the image URL.

- [ ] **Step 4: Download and save**

```bash
curl --fail -o claudeville/assets/sprites/buildings/building.taskboard/base-1-0.png "<DOWNLOAD_URL>"
```

Replace `<DOWNLOAD_URL>` with the URL from Step 3.

- [ ] **Step 5: Verify the PNG is valid**

```bash
file claudeville/assets/sprites/buildings/building.taskboard/base-1-0.png
```

Expected: output contains `PNG image data, 64 x 64`.

If the output says `JSON data` or `ASCII text`, the download URL was fetched before completion — re-poll and re-download.

- [ ] **Step 6: Confirm the sprite style looks right**

If the server is running (`npm run dev`), open `http://localhost:4000` in World mode. The Task Board will show checkerboard on most tiles but the center-top cell should reveal the building style. If the style looks wrong (no stone towers, wrong palette), adjust the description before generating the remaining 5 cells.

---

## Task 3: Generate remaining 5 base grid cells

**Files:**
- Create: `claudeville/assets/sprites/buildings/building.taskboard/base-0-0.png`
- Create: `claudeville/assets/sprites/buildings/building.taskboard/base-0-1.png`
- Create: `claudeville/assets/sprites/buildings/building.taskboard/base-1-1.png`
- Create: `claudeville/assets/sprites/buildings/building.taskboard/base-2-0.png`
- Create: `claudeville/assets/sprites/buildings/building.taskboard/base-2-1.png`

Each cell is an independent 64×64 isometric tile generated with the same description. When stitched into the 3×2 canvas (312×208 total), the six independent tiles create the hero building composite. Use the same `description`, `size`, `detail`, and `shading` parameters as Task 2 Step 2. For each cell: call `create_isometric_tile`, save the `tile_id`, poll `get_isometric_tile` until `status` is `"completed"`, then download using `curl --fail`.

- [ ] **Step 1: Generate base-0-0**

Call `mcp__pixellab__create_isometric_tile` (same parameters as Task 2 Step 2). Poll until `status` is `"completed"`. Download:

```bash
curl --fail -o claudeville/assets/sprites/buildings/building.taskboard/base-0-0.png "<DOWNLOAD_URL>"
```

- [ ] **Step 2: Generate base-0-1**

Call, poll, download:

```bash
curl --fail -o claudeville/assets/sprites/buildings/building.taskboard/base-0-1.png "<DOWNLOAD_URL>"
```

- [ ] **Step 3: Generate base-1-1**

Call, poll, download:

```bash
curl --fail -o claudeville/assets/sprites/buildings/building.taskboard/base-1-1.png "<DOWNLOAD_URL>"
```

- [ ] **Step 4: Generate base-2-0**

Call, poll, download:

```bash
curl --fail -o claudeville/assets/sprites/buildings/building.taskboard/base-2-0.png "<DOWNLOAD_URL>"
```

- [ ] **Step 5: Generate base-2-1**

Call, poll, download:

```bash
curl --fail -o claudeville/assets/sprites/buildings/building.taskboard/base-2-1.png "<DOWNLOAD_URL>"
```

- [ ] **Step 6: Verify all 6 cells are valid PNGs**

```bash
file claudeville/assets/sprites/buildings/building.taskboard/base-*.png
```

Expected: all 6 lines show `PNG image data, 64 x 64`. If any line shows `JSON data`, re-poll that tile and re-download.

- [ ] **Step 7: Commit base grid tiles**

```bash
git add claudeville/assets/sprites/buildings/building.taskboard/base-*.png
git commit -m "feat: add task board hero base grid tiles (6 cells)"
```

---

## Task 4: Generate runeGlow overlay

**Files:**
- Create: `claudeville/assets/sprites/buildings/building.taskboard/runeGlow.png`

- [ ] **Step 1: Call create_isometric_tile for runeGlow**

Call `mcp__pixellab__create_isometric_tile` with:
- `description`: `"epic high-fantasy pixel art, dramatic lighting, painterly palette, crisp pixel edges, no anti-aliasing, heroic silhouettes, faint magical glow on landmarks, pulsing warm amber rune glow radiating from carved stone tablet surface, horizontal glowing inscription lines, burnished gold arcane energy, transparent background, isometric"`
- `size`: `64`
- `detail`: `"highly detailed"`
- `shading`: `"detailed shading"`

Save the returned `tile_id`. Poll `get_isometric_tile` until `status` is `"completed"`. Download:

```bash
curl --fail -o claudeville/assets/sprites/buildings/building.taskboard/runeGlow.png "<DOWNLOAD_URL>"
```

- [ ] **Step 2: Verify the PNG**

```bash
file claudeville/assets/sprites/buildings/building.taskboard/runeGlow.png
```

Expected: `PNG image data, 64 x 64`.

- [ ] **Step 3: Commit overlay**

```bash
git add claudeville/assets/sprites/buildings/building.taskboard/runeGlow.png
git commit -m "feat: add task board runeGlow animated overlay"
```

---

## Task 5: Finalize — remove old sprite, bump assetVersion, validate

**Files:**
- Delete: `claudeville/assets/sprites/buildings/building.taskboard/base.png`
- Modify: `claudeville/assets/sprites/manifest.yaml` (assetVersion, line 2)

- [ ] **Step 1: Delete the old single-tile sprite**

```bash
git rm claudeville/assets/sprites/buildings/building.taskboard/base.png
```

This removes the file and stages the deletion in git simultaneously.

- [ ] **Step 2: Bump assetVersion in manifest.yaml**

In `claudeville/assets/sprites/manifest.yaml`, change line 2:

```yaml
# before
  assetVersion: "2026-04-27-harbor-dock-cleanup-v1"

# after
  assetVersion: "2026-04-27-taskboard-hero-v1"
```

- [ ] **Step 3: Verify all 7 new PNGs are valid**

```bash
file claudeville/assets/sprites/buildings/building.taskboard/base-0-0.png \
     claudeville/assets/sprites/buildings/building.taskboard/base-0-1.png \
     claudeville/assets/sprites/buildings/building.taskboard/base-1-0.png \
     claudeville/assets/sprites/buildings/building.taskboard/base-1-1.png \
     claudeville/assets/sprites/buildings/building.taskboard/base-2-0.png \
     claudeville/assets/sprites/buildings/building.taskboard/base-2-1.png \
     claudeville/assets/sprites/buildings/building.taskboard/runeGlow.png
```

Expected: all 7 lines show `PNG image data, 64 x 64`. Fix any that do not before proceeding.

- [ ] **Step 4: Run sprites:validate — expect PASS**

```bash
npm run sprites:validate
```

Expected final line: `expected: <N>  missing: 0  orphan PNGs: 0  invalid character sheets: 0`

If `missing: N` still appears, one or more PNGs were not saved correctly — run the `file` check in Step 3 to identify them.

- [ ] **Step 5: Syntax check after manifest edit**

```bash
node --check claudeville/server.js
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add claudeville/assets/sprites/manifest.yaml
git commit -m "feat: finalize task board hero upgrade — remove old tile, bump assetVersion"
```

---

## Task 6: Visual smoke test

- [ ] **Step 1: Start the server**

```bash
npm run dev &
```

Wait 2 seconds, then open `http://localhost:4000` in the browser.

- [ ] **Step 2: Verify Task Board renders as hero building**

In World mode, locate the Task Board (center-south area of the map, labeled "TASK BOARD"). Confirm:
- It renders at hero scale (significantly larger than before, comparable to Command Center)
- Amber/gold rune glow visible on the tablet face
- `runeGlow` overlay pulses (animates on the board face)
- No checkerboard placeholders on any of the 6 cells

If any cell shows checkerboard: inspect browser DevTools console for `[AssetManager] missing asset:` lines and re-download the missing cell.

- [ ] **Step 3: Verify emitters and light**

Torch emitters at coordinates `[52, 148]` and `[260, 148]` (tower bases) should emit amber particles. The `fire-glow` atmosphere overlay should tint nearby ground tiles warm amber. If the scene has a time-of-day cycle, advance it to dusk/night to see the full light halo.

- [ ] **Step 4: Select an agent near the Task Board**

Click an agent sprite near the Task Board. Confirm the right activity panel opens and closes normally.

- [ ] **Step 5: Check browser console is clean**

Open DevTools → Console. Confirm no errors or warnings related to `building.taskboard` or `AssetManager`.
