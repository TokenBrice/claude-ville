# Pixel-Art Visual Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ClaudeVille's vector Canvas2D rendering with a sprite-based pixel-art renderer. Asset library generated through pixellab MCP. Single big-bang PR.

**Architecture:** New `SpriteRenderer` + `AssetManager` + `BuildingSprite` + `TerrainTileset` modules read from a YAML manifest. Existing `IsometricRenderer` / `AgentSprite` orchestration kept; their drawing methods deleted (~5,000 LOC). `BuildingRenderer` deleted entirely. Particle system + data layer unchanged.

**Tech Stack:** Vanilla ES modules, Canvas2D `drawImage`, no bundler. YAML for manifest. Node-built-in only for `manifest-validator.mjs`. Pixellab MCP for asset generation.

**Spec reference:** [`docs/superpowers/specs/2026-04-25-pixel-art-visual-upgrade-design.md`](../specs/2026-04-25-pixel-art-visual-upgrade-design.md). Read it first.

**Validation note:** This repo has no test runner. Per-task validation uses `node --check`, `npm run dev` smoke runs, the playwright MCP for visual screenshots, and the manifest validator script.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `claudeville/assets/sprites/manifest.yaml` | Create | Source of truth for every sprite (id, prompt, size, animations, anchor, emitters) |
| `claudeville/assets/sprites/palettes.yaml` | Create | Per-provider palette swap source/target colors |
| `claudeville/assets/sprites/**/*.png` | Create | ~195 PNG assets generated via pixellab MCP |
| `claudeville/src/presentation/character-mode/AssetManager.js` | Create | Manifest loader; PNG fetch + decode; alpha-mask cache; quadrant compositor |
| `claudeville/src/presentation/character-mode/SpriteSheet.js` | Create | Frame-strip parsing (8-dir × walk/idle); cell lookup |
| `claudeville/src/presentation/character-mode/Compositor.js` | Create | Palette swap + accessory overlay composition; cached per agent |
| `claudeville/src/presentation/character-mode/SpriteRenderer.js` | Create | `drawSprite()`, `drawTile()`, integer snap, smoothing off, halo edge-detect |
| `claudeville/src/presentation/character-mode/TerrainTileset.js` | Create | Wang neighbor-mask lookup → tileset cell blit |
| `claudeville/src/presentation/character-mode/BuildingSprite.js` | Create | Per-building sprite blit + occlusion split + emitter accessor |
| `claudeville/src/presentation/character-mode/IsometricRenderer.js` | Modify | Remove all vector shape drawing; orchestrate sprite renderer instead |
| `claudeville/src/presentation/character-mode/AgentSprite.js` | Modify | Strip `_drawProvider*`/`_drawAccessory*`/etc; keep state, movement, chat, dir/frame |
| `claudeville/src/presentation/character-mode/SceneryEngine.js` | Modify | Remove water-surface vector drawing; keep generation + walkability |
| `claudeville/src/presentation/character-mode/BuildingRenderer.js` | Delete | Entire file (~3,270 lines) replaced by `BuildingSprite` |
| `claudeville/src/presentation/App.js` | Modify | Await `AssetManager.load()` before constructing renderer |
| `scripts/sprites/manifest-validator.mjs` | Create | Bidirectional id↔PNG check |
| `scripts/sprites/generate.md` | Create | Human-readable generation session script |
| `claudeville/CLAUDE.md` | Modify | Update World Mode section to reflect new files |
| `AGENTS.md` | Modify | Mirror the CLAUDE.md update |
| `.gitignore` | Modify | Add `.superpowers/` |
| `package.json` | Modify | Add `"sprites:validate": "node scripts/sprites/manifest-validator.mjs"` |

---

## Phase 0 — Pre-flight

### Task 0.1: Branch + housekeeping

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/ahirice/Documents/git/claude-ville
git checkout -b feature/pixel-art-renderer
```

- [ ] **Step 2: Add `.superpowers/` to gitignore (brainstorm artifacts shouldn't be committed)**

Append to `/home/ahirice/Documents/git/claude-ville/.gitignore`:

```
.superpowers/
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore .superpowers/ brainstorm working dir"
```

---

### Task 0.2: User sets up pixellab MCP (manual, blocks Phase 3)

**This step requires the user; the implementer can stop after Phase 2 and resume at Phase 3 once done.**

- [ ] **Step 1: User signs up at https://www.pixellab.ai and obtains an API token**

- [ ] **Step 2: User adds the MCP server to Claude Code config**

```json
{
  "mcpServers": {
    "pixellab": {
      "url": "https://api.pixellab.ai/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}
```

- [ ] **Step 3: User restarts Claude Code and confirms `mcp__pixellab__*` tools appear**

---

## Phase 1 — Infrastructure (no real assets needed; uses placeholder PNGs)

### Task 1.1: Asset directory + placeholder PNGs

**Files:**
- Create: `claudeville/assets/sprites/manifest.yaml` (stub)
- Create: `claudeville/assets/sprites/palettes.yaml`
- Create: `claudeville/assets/sprites/_placeholder/checker-64.png` (1 file used as fallback for every entry until Phase 3)

- [ ] **Step 1: Create directory tree**

```bash
mkdir -p claudeville/assets/sprites/{characters,overlays,buildings,props,vegetation,terrain,atmosphere,bridges,_placeholder}
```

- [ ] **Step 2: Generate the placeholder checker PNG**

Use a one-off node script:

```bash
node -e '
const { PNG } = require("pngjs");
const fs = require("fs");
const png = new PNG({ width: 64, height: 64 });
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  const i = (y * 64 + x) << 2;
  const c = ((x >> 3) + (y >> 3)) & 1 ? 255 : 96;
  png.data[i] = c; png.data[i+1] = c; png.data[i+2] = c; png.data[i+3] = 255;
}
png.pack().pipe(fs.createWriteStream("claudeville/assets/sprites/_placeholder/checker-64.png"));
'
```

If `pngjs` isn't available, the implementer may use ImageMagick (`convert -size 64x64 pattern:checkerboard checker-64.png`) or any equivalent. The placeholder PNG is one file, ~64×64, no transparency required.

- [ ] **Step 3: Write `palettes.yaml`** (full content from spec §5)

```yaml
claude:
  robe: ['#8f4f21', '#a85f24', '#7b3f1c']
  pants: ['#3b2418', '#4b2c1a', '#33231a']
  trim: ['#f2d36b', '#e9b85f', '#ffd98a']
codex:
  robe: ['#116466', '#167d86', '#1f6f8b']
  pants: ['#102f3a', '#12353b', '#18334a']
  trim: ['#7be3d7', '#55c7f0', '#8ee88e']
gemini:
  robe: ['#4f46a5', '#5d65c8', '#44528e']
  pants: ['#201c43', '#27244d', '#1f2d55']
  trim: ['#b7ccff', '#d6b7ff', '#7bdff2']
```

- [ ] **Step 4: Write `manifest.yaml` with the full schema** (chars + 11 buildings + props + vegetation + terrain + atmosphere + bridges). Use spec §5 as the literal template — copy each `prompt:` value from the spec verbatim. The Phase 3 generation tasks read these prompts directly; do not stub them. The schema MUST exactly match what `AssetManager` parses (Task 1.3).

- [ ] **Step 5: Validate YAML parses**

```bash
node -e 'console.log(JSON.stringify(require("js-yaml").load(require("fs").readFileSync("claudeville/assets/sprites/manifest.yaml","utf8")), null, 2).slice(0, 200))'
```

Expected: valid JSON output (first 200 chars). If `js-yaml` is missing, install ad-hoc with `npm install --no-save js-yaml` or use the browser-side YAML parser added in Task 1.3 instead.

- [ ] **Step 6: Commit**

```bash
git add claudeville/assets/sprites/
git commit -m "feat(sprites): add asset directory tree, manifest stub, palettes, placeholder PNG"
```

---

### Task 1.2: Add YAML loader for the browser

**Files:**
- Modify: `claudeville/index.html`

ClaudeVille is zero-dependency vanilla ESM. The browser needs a YAML parser. Use the smallest viable one shipped as a single file.

- [ ] **Step 1: Vendor `js-yaml` browser build into `claudeville/vendor/js-yaml.min.js`**

```bash
mkdir -p claudeville/vendor
curl -L -o claudeville/vendor/js-yaml.min.js \
  https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js
```

Verify the file is non-empty and looks like minified JS:

```bash
head -c 80 claudeville/vendor/js-yaml.min.js
```

Expected: minified JS output (no HTML error page).

- [ ] **Step 2: Add `<script>` tag in `claudeville/index.html` `<head>` BEFORE the module imports**

```html
<script src="vendor/js-yaml.min.js"></script>
```

- [ ] **Step 3: Smoke**

```bash
npm run dev &
sleep 1
curl -s http://localhost:4000/vendor/js-yaml.min.js | head -c 80
kill %1
```

Expected: same minified JS first 80 chars (server delivers the file).

- [ ] **Step 4: Commit**

```bash
git add claudeville/vendor/ claudeville/index.html
git commit -m "feat(sprites): vendor js-yaml for manifest loading"
```

---

### Task 1.3: AssetManager.js

**Files:**
- Create: `claudeville/src/presentation/character-mode/AssetManager.js`

- [ ] **Step 1: Write the module**

```javascript
// AssetManager loads sprites declared in manifest.yaml, decodes them into
// HTMLImageElements + alpha masks, and exposes lookup by id.

const PLACEHOLDER_PATH = 'assets/sprites/_placeholder/checker-64.png';

export class AssetManager {
    constructor(manifestPath = 'assets/sprites/manifest.yaml') {
        this.manifestPath = manifestPath;
        this.manifest = null;          // parsed YAML root
        this.palettes = null;
        this.bitmaps = new Map();      // id → HTMLImageElement (or composed canvas)
        this.alphaMasks = new Map();   // id → Uint8Array
        this.dimensions = new Map();   // id → { w, h }
        this.anchors = new Map();      // id → [cx, cy] in sprite-local px
    }

    async load() {
        const [manifestText, palettesText] = await Promise.all([
            fetch(this.manifestPath).then(r => r.text()),
            fetch('assets/sprites/palettes.yaml').then(r => r.text()),
        ]);
        this.manifest = jsyaml.load(manifestText);
        this.palettes = jsyaml.load(palettesText);

        const entries = this._flattenManifest(this.manifest);
        await Promise.all(entries.map(e => this._loadEntry(e)));
    }

    _flattenManifest(root) {
        const out = [];
        const collect = (arr) => arr && arr.forEach(e => out.push(e));
        collect(root.characters);
        collect(root.accessories);
        collect(root.statusOverlays);
        collect(root.buildings);
        collect(root.props);
        collect(root.vegetation);
        collect(root.terrain);
        collect(root.bridges);
        collect(root.atmosphere);
        return out;
    }

    async _loadEntry(entry) {
        // For composed buildings: stitch quadrant PNGs into one canvas.
        if (entry.composeGrid && entry.layers?.base) {
            await this._loadComposedBuilding(entry);
            return;
        }
        // Standard single-PNG entry.
        const path = this._pathFor(entry);
        const img = await this._loadImage(path);
        this.bitmaps.set(entry.id, img);
        this.dimensions.set(entry.id, { w: img.width, h: img.height });
        if (entry.anchor) this.anchors.set(entry.id, entry.anchor);
        this.alphaMasks.set(entry.id, this._buildAlphaMask(img));
        // Recurse for layered entries (overlays).
        if (entry.layers) {
            for (const [name, layer] of Object.entries(entry.layers)) {
                if (name === 'base') continue;
                const layerId = `${entry.id}.${name}`;
                const layerPath = this._pathFor({ id: layerId, ...layer });
                const layerImg = await this._loadImage(layerPath);
                this.bitmaps.set(layerId, layerImg);
                this.dimensions.set(layerId, { w: layerImg.width, h: layerImg.height });
                if (layer.anchor) this.anchors.set(layerId, layer.anchor);
            }
        }
    }

    async _loadComposedBuilding(entry) {
        const [cols, rows] = entry.composeGrid;
        const cellSize = entry.layers.base.size || 128;
        const canvas = document.createElement('canvas');
        canvas.width = cols * cellSize;
        canvas.height = rows * cellSize;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellPath = `assets/sprites/buildings/${entry.id}/base-${c}-${r}.png`;
                const img = await this._loadImage(cellPath);
                ctx.drawImage(img, c * cellSize, r * cellSize);
            }
        }
        this.bitmaps.set(entry.id, canvas);
        this.dimensions.set(entry.id, { w: canvas.width, h: canvas.height });
        if (entry.anchor) this.anchors.set(entry.id, entry.anchor);
        this.alphaMasks.set(entry.id, this._buildAlphaMaskFromCanvas(canvas));
        // Layer overlays (beacon, banner, etc.)
        if (entry.layers) {
            for (const [name, layer] of Object.entries(entry.layers)) {
                if (name === 'base') continue;
                const layerId = `${entry.id}.${name}`;
                const layerPath = `assets/sprites/buildings/${entry.id}/${name}.png`;
                const img = await this._loadImage(layerPath);
                this.bitmaps.set(layerId, img);
                this.dimensions.set(layerId, { w: img.width, h: img.height });
                if (layer.anchor) this.anchors.set(layerId, layer.anchor);
            }
        }
    }

    _pathFor(entry) {
        // Deterministic path mapping by id prefix.
        if (entry.id.startsWith('agent.')) return `assets/sprites/characters/${entry.id}/sheet.png`;
        if (entry.id.startsWith('overlay.accessory.')) return `assets/sprites/overlays/${entry.id}.png`;
        if (entry.id.startsWith('overlay.status.')) return `assets/sprites/overlays/${entry.id}.png`;
        if (entry.id.startsWith('building.')) return `assets/sprites/buildings/${entry.id}/base.png`;
        if (entry.id.startsWith('prop.')) return `assets/sprites/props/${entry.id}.png`;
        if (entry.id.startsWith('veg.')) return `assets/sprites/vegetation/${entry.id}.png`;
        if (entry.id.startsWith('terrain.')) return `assets/sprites/terrain/${entry.id}/sheet.png`;
        if (entry.id.startsWith('bridge.') || entry.id.startsWith('dock.')) return `assets/sprites/bridges/${entry.id}.png`;
        if (entry.id.startsWith('atmosphere.')) return `assets/sprites/atmosphere/${entry.id}.png`;
        return PLACEHOLDER_PATH;
    }

    _loadImage(path) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => {
                console.warn(`[AssetManager] missing asset: ${path} — using placeholder`);
                const ph = new Image();
                ph.onload = () => resolve(ph);
                ph.src = PLACEHOLDER_PATH;
            };
            img.src = path;
        });
    }

    _buildAlphaMask(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return this._buildAlphaMaskFromCanvas(canvas);
    }

    _buildAlphaMaskFromCanvas(canvas) {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const mask = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 16 ? 1 : 0;
        return mask;
    }

    get(id) { return this.bitmaps.get(id); }
    getMask(id) { return this.alphaMasks.get(id); }
    getDims(id) { return this.dimensions.get(id); }
    getAnchor(id) { return this.anchors.get(id) ?? [0, 0]; }
    getEntry(id) {
        return this._flattenManifest(this.manifest).find(e => e.id === id);
    }
}
```

- [ ] **Step 2: Validate syntax**

```bash
node --check claudeville/src/presentation/character-mode/AssetManager.js
```

Expected: silent success.

- [ ] **Step 3: Commit**

```bash
git add claudeville/src/presentation/character-mode/AssetManager.js
git commit -m "feat(sprites): add AssetManager (manifest loader + alpha mask cache)"
```

---

### Task 1.4: SpriteSheet.js

**Files:**
- Create: `claudeville/src/presentation/character-mode/SpriteSheet.js`

- [ ] **Step 1: Write the module**

```javascript
// SpriteSheet locates the right cell within a character sheet PNG.
// Sheet layout: 8 columns (directions S, SE, E, NE, N, NW, W, SW),
// 6 rows (walk-0..3 then idle-0..1). Each cell is `cellSize` px square.

export const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
export const WALK_FRAMES = 4;
export const IDLE_FRAMES = 2;

export class SpriteSheet {
    constructor(image, cellSize = 64) {
        this.image = image;
        this.cellSize = cellSize;
    }

    // animState: 'walk' | 'idle', dir: 0..7, frame: int
    cell(animState, dir, frame) {
        const col = dir;                                   // 0..7
        const baseRow = animState === 'idle' ? WALK_FRAMES : 0;
        const row = baseRow + (frame % (animState === 'idle' ? IDLE_FRAMES : WALK_FRAMES));
        return {
            sx: col * this.cellSize,
            sy: row * this.cellSize,
            sw: this.cellSize,
            sh: this.cellSize,
        };
    }
}

// Velocity → direction index. Returns 0..7 matching DIRECTIONS order.
// DIRECTIONS = ['s','se','e','ne','n','nw','w','sw'].
// In screen space: vy > 0 means moving south (down). atan2(vy, vx) is 0 at East,
// π/2 at South. We want South → 0, SE → 1, E → 2, NE → 3, N → 4, NW → 5, W → 6, SW → 7.
export function dirFromVelocity(vx, vy) {
    if (vx === 0 && vy === 0) return null;
    const angle = Math.atan2(vy, vx);                       // -π..π, 0 at East, π/2 at South
    // Shift so South is 0; divide by 45° step.
    const stepped = Math.round((angle - Math.PI / 2) / (Math.PI / 4));
    return ((stepped % 8) + 8) % 8;
}
```

**Smoke test the math before Step 2** by pasting this 8-cardinal probe into a node REPL or a temporary scratch file:
```javascript
const tests = [
    [0, 1, 's'], [1, 1, 'se'], [1, 0, 'e'], [1, -1, 'ne'],
    [0, -1, 'n'], [-1, -1, 'nw'], [-1, 0, 'w'], [-1, 1, 'sw'],
];
for (const [vx, vy, want] of tests) {
    const got = ['s','se','e','ne','n','nw','w','sw'][dirFromVelocity(vx, vy)];
    if (got !== want) console.error(`FAIL (${vx},${vy}): want ${want} got ${got}`);
}
```
If any FAIL prints, do not proceed — the math is wrong and agents will face backwards.

- [ ] **Step 2: Validate**

```bash
node --check claudeville/src/presentation/character-mode/SpriteSheet.js
```

- [ ] **Step 3: Commit**

```bash
git add claudeville/src/presentation/character-mode/SpriteSheet.js
git commit -m "feat(sprites): add SpriteSheet (cell lookup + dir from velocity)"
```

---

### Task 1.5: Compositor.js

**Files:**
- Create: `claudeville/src/presentation/character-mode/Compositor.js`

- [ ] **Step 1: Write the module**

```javascript
// Compositor produces per-agent character bitmaps by:
// 1. palette-swapping a base sheet using palettes.yaml,
// 2. compositing a chosen accessory overlay over the head pixels.
// Result is cached per (provider, paletteVariant, accessory) tuple.

const cache = new Map();   // key = `${provider}|${paletteVariant}|${accessory}` → HTMLCanvasElement

export class Compositor {
    constructor(assetManager) {
        this.assets = assetManager;
    }

    spriteFor(provider, paletteVariant, accessory) {
        const key = `${provider}|${paletteVariant}|${accessory ?? '_'}`;
        if (cache.has(key)) return cache.get(key);

        const baseImg = this.assets.get(`agent.${provider}.base`);
        if (!baseImg) return null;
        const dims = this.assets.getDims(`agent.${provider}.base`);
        const canvas = document.createElement('canvas');
        canvas.width = dims.w;
        canvas.height = dims.h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        // 1. paint base
        ctx.drawImage(baseImg, 0, 0);

        // 2. palette swap (in-place pixel walk)
        this._applyPaletteSwap(ctx, canvas.width, canvas.height, provider, paletteVariant);

        // 3. accessory overlay (if any) — composited per-direction onto each sheet cell
        if (accessory) this._compositeAccessory(ctx, provider, accessory);

        cache.set(key, canvas);
        return canvas;
    }

    _applyPaletteSwap(ctx, w, h, provider, variant) {
        const palette = this.assets.palettes[provider];
        if (!palette) return;
        // Marker palette in source is index 0 of each color category (robe, pants, trim).
        // Variant selects index 0..2.
        const targetRobe = palette.robe[variant % palette.robe.length];
        const targetPants = palette.pants[variant % palette.pants.length];
        const targetTrim = palette.trim[variant % palette.trim.length];
        const sourceRobe = palette.robe[0];
        const sourcePants = palette.pants[0];
        const sourceTrim = palette.trim[0];

        const img = ctx.getImageData(0, 0, w, h);
        const data = img.data;
        const swap = [
            [hexToRgb(sourceRobe), hexToRgb(targetRobe)],
            [hexToRgb(sourcePants), hexToRgb(targetPants)],
            [hexToRgb(sourceTrim), hexToRgb(targetTrim)],
        ];
        // ΔE bucket: tolerate ±12 per channel so painterly anti-aliased pixels
        // also recolor. Without this tolerance, only fully-saturated marker
        // pixels swap and the result looks half-painted.
        const TOL = 12;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
            if (a < 16) continue;
            for (const [src, dst] of swap) {
                if (Math.abs(r - src[0]) <= TOL && Math.abs(g - src[1]) <= TOL && Math.abs(b - src[2]) <= TOL) {
                    // Preserve the per-pixel offset from src to keep AA gradients.
                    data[i]   = Math.max(0, Math.min(255, dst[0] + (r - src[0])));
                    data[i+1] = Math.max(0, Math.min(255, dst[1] + (g - src[1])));
                    data[i+2] = Math.max(0, Math.min(255, dst[2] + (b - src[2])));
                    break;
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    _compositeAccessory(ctx, provider, accessory) {
        const overlayId = `overlay.accessory.${accessory}`;
        const overlayImg = this.assets.get(overlayId);
        if (!overlayImg) return;
        const dims = this.assets.getDims(`agent.${provider}.base`);
        const cellSize = 64;
        const cols = dims.w / cellSize;
        const rows = dims.h / cellSize;
        const overlayDims = this.assets.getDims(overlayId);
        const overlayCellW = overlayDims.w / cols;            // 8-dir overlay strip
        const [ax, ay] = this.assets.getAnchor(overlayId);    // head-pixel offset
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                ctx.drawImage(
                    overlayImg,
                    c * overlayCellW, 0, overlayCellW, overlayDims.h,
                    c * cellSize + ax, r * cellSize + ay, overlayCellW, overlayDims.h
                );
            }
        }
    }
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
```

- [ ] **Step 2: Validate**

```bash
node --check claudeville/src/presentation/character-mode/Compositor.js
```

- [ ] **Step 3: Commit**

```bash
git add claudeville/src/presentation/character-mode/Compositor.js
git commit -m "feat(sprites): add Compositor (palette swap + accessory overlay)"
```

---

### Task 1.6: SpriteRenderer.js

**Files:**
- Create: `claudeville/src/presentation/character-mode/SpriteRenderer.js`

- [ ] **Step 1: Write the module**

```javascript
// SpriteRenderer is the sole entry point for blitting pixel-art sprites.
// Enforces image-smoothing-off and integer-snapped destinations.

export class SpriteRenderer {
    constructor(assets) {
        this.assets = assets;
    }

    static disableSmoothing(ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
    }

    // Draw a sprite anchored at bottom-center of its footprint at world (wx, wy).
    drawSprite(ctx, id, wx, wy, opts = {}) {
        const img = opts.image || this.assets.get(id);
        if (!img) return;
        const dims = opts.dims || this.assets.getDims(id);
        const [ax, ay] = opts.anchor || this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        if (opts.alpha != null) {
            const prev = ctx.globalAlpha;
            ctx.globalAlpha = prev * opts.alpha;
            ctx.drawImage(img, dx, dy);
            ctx.globalAlpha = prev;
        } else {
            ctx.drawImage(img, dx, dy);
        }
        if (dims) {
            // returns the screen-space bounding box (caller uses for hit test)
            return { dx, dy, w: dims.w, h: dims.h };
        }
    }

    // Draw a sub-rect of a sheet (used for character walk/idle frames + tilesets).
    drawSheetCell(ctx, image, cell, wx, wy, anchorX = 0, anchorY = 0) {
        const dx = Math.round(wx - anchorX);
        const dy = Math.round(wy - anchorY);
        ctx.drawImage(image, cell.sx, cell.sy, cell.sw, cell.sh, dx, dy, cell.sw, cell.sh);
        return { dx, dy, w: cell.sw, h: cell.sh };
    }

    // Per-pixel hit test against a cached alpha mask.
    hitTest(id, mx, my, dx, dy) {
        const mask = this.assets.getMask(id);
        if (!mask) return false;
        const dims = this.assets.getDims(id);
        const lx = Math.floor(mx - dx);
        const ly = Math.floor(my - dy);
        if (lx < 0 || ly < 0 || lx >= dims.w || ly >= dims.h) return false;
        return mask[ly * dims.w + lx] === 1;
    }

    // Draw a 1-px outline around a sprite by edge-detecting the alpha mask.
    drawOutline(ctx, id, wx, wy, color = '#f2d36b') {
        const mask = this.assets.getMask(id);
        if (!mask) return;
        const dims = this.assets.getDims(id);
        const [ax, ay] = this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        ctx.fillStyle = color;
        for (let y = 0; y < dims.h; y++) {
            for (let x = 0; x < dims.w; x++) {
                if (mask[y * dims.w + x]) continue;
                // edge if any neighbor is filled
                const n = (y > 0 && mask[(y-1) * dims.w + x])
                       || (y < dims.h-1 && mask[(y+1) * dims.w + x])
                       || (x > 0 && mask[y * dims.w + (x-1)])
                       || (x < dims.w-1 && mask[y * dims.w + (x+1)]);
                if (n) ctx.fillRect(dx + x, dy + y, 1, 1);
            }
        }
    }

    // Draw a tinted silhouette at lower opacity (X-ray effect).
    drawSilhouette(ctx, id, wx, wy, tint = 'rgba(255,210,140,0.35)') {
        const img = this.assets.get(id);
        if (!img) return;
        const [ax, ay] = this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.35;
        ctx.drawImage(img, dx, dy);
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = tint;
        ctx.fillRect(dx, dy, img.width, img.height);
        ctx.restore();
    }
}
```

- [ ] **Step 2: Validate**

```bash
node --check claudeville/src/presentation/character-mode/SpriteRenderer.js
```

- [ ] **Step 3: Commit**

```bash
git add claudeville/src/presentation/character-mode/SpriteRenderer.js
git commit -m "feat(sprites): add SpriteRenderer (drawSprite + hitTest + outline + silhouette)"
```

---

### Task 1.7: TerrainTileset.js

**Files:**
- Create: `claudeville/src/presentation/character-mode/TerrainTileset.js`

- [ ] **Step 1: Write the module**

```javascript
// TerrainTileset maps a (tileX, tileY, classId) + neighbor mask to a Wang tile cell.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

// Wang 4-bit edge mask: bit 0 = N same, 1 = E same, 2 = S same, 3 = W same.
// Index 0..15 maps to a cell column in a 16-cell-wide tileset PNG.

export class TerrainTileset {
    constructor(assets) {
        this.assets = assets;
        this.cellW = 64;
        this.cellH = 32;
    }

    // isClass(tx, ty) → boolean: tile belongs to upper class.
    drawTile(ctx, sheetId, tileX, tileY, isClass) {
        const sheet = this.assets.get(sheetId);
        if (!sheet) return;
        const mask = (isClass(tileX, tileY - 1) ? 1 : 0)
                   | (isClass(tileX + 1, tileY) ? 2 : 0)
                   | (isClass(tileX, tileY + 1) ? 4 : 0)
                   | (isClass(tileX - 1, tileY) ? 8 : 0);
        const screenX = (tileX - tileY) * (TILE_WIDTH / 2);
        const screenY = (tileX + tileY) * (TILE_HEIGHT / 2);
        const dx = Math.round(screenX - this.cellW / 2);
        const dy = Math.round(screenY - this.cellH / 2);
        ctx.drawImage(
            sheet,
            mask * this.cellW, 0, this.cellW, this.cellH,
            dx, dy, this.cellW, this.cellH
        );
    }
}
```

- [ ] **Step 2: Validate**

```bash
node --check claudeville/src/presentation/character-mode/TerrainTileset.js
```

- [ ] **Step 3: Commit**

```bash
git add claudeville/src/presentation/character-mode/TerrainTileset.js
git commit -m "feat(sprites): add TerrainTileset (Wang neighbor lookup)"
```

---

### Task 1.8: BuildingSprite.js

**Files:**
- Create: `claudeville/src/presentation/character-mode/BuildingSprite.js`

**Pre-step (REQUIRED):** Sweep the existing `BuildingRenderer` API surface so `BuildingSprite` reaches parity. Run:

```bash
rg -n "buildingRenderer\." claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Expected call sites today: `setBuildings`, `setMotionScale`, `setAgentSprites`, `update`, `draw`, `drawShadows`, `drawBubbles`, `getLightSources`, `hitTest`, `hoveredBuilding` (property). Each MUST be addressed by `BuildingSprite` — either reimplemented or **explicitly out-of-scope** with a comment in this task. Silent loss = scope regression. Per spec §3 (roof-fade dropped) only `roofAlpha` is intentionally lost; bubbles, shadows, and lighting are NOT.

- [ ] **Step 1: Write the module**

```javascript
// BuildingSprite replaces BuildingRenderer. Draws buildings from sprites,
// exposes emitter points for particles, supports occlusion split for hero
// buildings. Reimplements the full BuildingRenderer external surface.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

export class BuildingSprite {
    constructor(assets, spriteRenderer, particleSystem) {
        this.assets = assets;
        this.sprites = spriteRenderer;
        this.particles = particleSystem;
        this.buildings = [];
        this.agentSprites = [];
        this.hovered = null;
        this.frame = 0;
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        this._motionMq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this._onMotionChange = (e) => this.setMotionScale(e.matches ? 0 : 1);
        this._motionMq?.addEventListener?.('change', this._onMotionChange);
    }

    dispose() {
        this._motionMq?.removeEventListener?.('change', this._onMotionChange);
    }

    setMotionScale(s) { this.motionScale = s; }

    setBuildings(map) {
        // Accepts a Map (preferred — matches world.buildings) or an Array.
        this.buildings = map instanceof Map ? Array.from(map.values()) : Array.from(map);
    }

    setAgentSprites(sprites) { this.agentSprites = sprites; }

    // Vector chat bubbles ARE preserved (not pixel-art); they overlay the world.
    drawBubbles(ctx, world) {
        for (const sprite of this.agentSprites) {
            if (!sprite.chatting || !sprite.chatBubbleText) continue;
            this._drawBubble(ctx, sprite);
        }
    }

    _drawBubble(ctx, sprite) {
        // Port the existing bubble logic from BuildingRenderer.drawBubbles
        // verbatim — text rendering is intentionally vector + DOM-font.
        // Implementer: copy the existing implementation, no behavioural change.
    }

    // Returns soft drop shadows under each building footprint.
    drawShadows(ctx) {
        for (const b of this.buildings) {
            const c = this._buildingScreenCenter(b);
            const halfW = (b.width + b.height) * TILE_WIDTH / 4;
            ctx.save();
            ctx.fillStyle = 'rgba(15, 22, 30, 0.32)';
            ctx.beginPath();
            ctx.ellipse(Math.round(c.x), Math.round(c.y + 4), halfW, halfW * 0.32, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    // Light sources for water/wall additive light passes.
    getLightSources() {
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            if (!entry?.lightSource) continue;
            const c = this._buildingScreenCenter(b);
            const baseAnchor = this.assets.getAnchor(entry.id);
            const [lx, ly] = entry.lightSource;
            out.push({
                x: c.x - baseAnchor[0] + lx,
                y: c.y - baseAnchor[1] + ly,
                color: entry.lightColor || 'rgba(255,210,140,0.4)',
                radius: entry.lightRadius || 64,
            });
        }
        return out;
    }

    // Per-pixel hit test against any building's alpha mask.
    hitTest(worldX, worldY) {
        for (const d of this.enumerateDrawables().reverse()) {
            if (d.kind === 'building-back') continue;
            const id = d.entry.id;
            const [ax, ay] = this.assets.getAnchor(id);
            if (this.sprites.hitTest(id, worldX, worldY, d.wx - ax, d.wy - ay)) {
                return d.building;
            }
        }
        return null;
    }

    update(dt) {
        this.frame += (dt / 16) * (this.motionScale || 0);
        for (const b of this.buildings) this._spawnEmittersFor(b);
    }

    // Returns drawables (one per building, or two if splitForOcclusion).
    enumerateDrawables() {
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            if (!entry) continue;
            const center = this._buildingScreenCenter(b);
            const wx = center.x;
            const wy = center.y;
            if (entry.splitForOcclusion) {
                const dims = this.assets.getDims(entry.id);
                const horizonY = entry.horizonY ?? Math.floor(dims.h / 2);
                out.push({ kind: 'building-back', building: b, entry, wx, wy, horizonY, sortY: wy - dims.h / 2 });
                out.push({ kind: 'building-front', building: b, entry, wx, wy, horizonY, sortY: wy });
            } else {
                out.push({ kind: 'building', building: b, entry, wx, wy, sortY: wy });
            }
        }
        return out;
    }

    drawDrawable(ctx, d) {
        const id = d.entry.id;
        if (d.kind === 'building') {
            this.sprites.drawSprite(ctx, id, d.wx, d.wy);
            this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy);
        } else {
            const dims = this.assets.getDims(id);
            const [ax, ay] = this.assets.getAnchor(id);
            const dx = Math.round(d.wx - ax);
            const dy = Math.round(d.wy - ay);
            const img = this.assets.get(id);
            if (!img) return;
            if (d.kind === 'building-back') {
                ctx.drawImage(img, 0, 0, dims.w, d.horizonY, dx, dy, dims.w, d.horizonY);
            } else {
                ctx.drawImage(img, 0, d.horizonY, dims.w, dims.h - d.horizonY,
                                   dx, dy + d.horizonY, dims.w, dims.h - d.horizonY);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy);
            }
        }
        if (this.hovered === d.building) this.sprites.drawOutline(ctx, id, d.wx, d.wy, '#7be3d7');
    }

    _drawAnimatedOverlays(ctx, entry, wx, wy) {
        if (!entry.layers) return;
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base') continue;
            const layerId = `${entry.id}.${name}`;
            const [ax, ay] = layer.anchor || [0, 0];
            const overlayWx = wx - this.assets.getAnchor(entry.id)[0] + ax;
            const overlayWy = wy - this.assets.getAnchor(entry.id)[1] + ay;
            // Animated pulse: fade alpha by sine of frame.
            let alpha = 1;
            if (layer.animation === 'pulse') {
                alpha = 0.6 + 0.4 * Math.sin(this.frame * 0.08);
            }
            this.sprites.drawSprite(ctx, layerId, overlayWx + this.assets.getDims(layerId).w / 2,
                                                  overlayWy + this.assets.getDims(layerId).h, { alpha });
        }
    }

    _spawnEmittersFor(b) {
        const entry = this.assets.getEntry(`building.${b.type}`);
        if (!entry?.emitters || !this.motionScale) return;
        const center = this._buildingScreenCenter(b);
        const baseAnchor = this.assets.getAnchor(entry.id);
        for (const [particleType, [lx, ly]] of Object.entries(entry.emitters)) {
            // Stochastic spawn, similar to BuildingRenderer rates.
            if (Math.random() > 0.04) continue;
            const wx = center.x - baseAnchor[0] + lx;
            const wy = center.y - baseAnchor[1] + ly;
            this.particles.spawn(particleType, wx, wy, 1);
        }
    }

    _buildingScreenCenter(b) {
        const cx = b.position.tileX + b.width / 2;
        const cy = b.position.tileY + b.height / 2;
        return {
            x: (cx - cy) * TILE_WIDTH / 2,
            y: (cx + cy) * TILE_HEIGHT / 2,
        };
    }

    setHovered(b) { this.hovered = b; }
}
```

- [ ] **Step 2: Validate**

```bash
node --check claudeville/src/presentation/character-mode/BuildingSprite.js
```

- [ ] **Step 3: Commit**

```bash
git add claudeville/src/presentation/character-mode/BuildingSprite.js
git commit -m "feat(sprites): add BuildingSprite (sprite blit + occlusion split + emitters)"
```

---

### Task 1.9: manifest-validator.mjs

**Files:**
- Create: `scripts/sprites/manifest-validator.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the validator**

```javascript
#!/usr/bin/env node
// Validates that every PNG path implied by manifest.yaml exists, and that no
// orphan PNGs sit in assets/sprites/ outside _placeholder/.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites');
const manifestPath = join(spritesRoot, 'manifest.yaml');

const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));

const expected = new Set();

function pathFor(entry) {
    if (entry.id.startsWith('agent.')) return `characters/${entry.id}/sheet.png`;
    if (entry.id.startsWith('overlay.')) return `overlays/${entry.id}.png`;
    if (entry.id.startsWith('building.')) return `buildings/${entry.id}/base.png`;
    if (entry.id.startsWith('prop.')) return `props/${entry.id}.png`;
    if (entry.id.startsWith('veg.')) return `vegetation/${entry.id}.png`;
    if (entry.id.startsWith('terrain.')) return `terrain/${entry.id}/sheet.png`;
    if (entry.id.startsWith('bridge.') || entry.id.startsWith('dock.')) return `bridges/${entry.id}.png`;
    if (entry.id.startsWith('atmosphere.')) return `atmosphere/${entry.id}.png`;
    return null;
}

function collect(group) {
    if (!group) return;
    for (const e of group) {
        if (e.composeGrid && e.layers?.base) {
            const [cols, rows] = e.composeGrid;
            for (let r = 0; r < rows; r++)
                for (let c = 0; c < cols; c++)
                    expected.add(`buildings/${e.id}/base-${c}-${r}.png`);
            if (e.layers) {
                for (const name of Object.keys(e.layers)) {
                    if (name === 'base') continue;
                    expected.add(`buildings/${e.id}/${name}.png`);
                }
            }
            continue;
        }
        const p = pathFor(e);
        if (p) expected.add(p);
        if (e.layers) {
            for (const name of Object.keys(e.layers)) {
                if (name === 'base') continue;
                expected.add(`buildings/${e.id}/${name}.png`);
            }
        }
    }
}

['characters', 'accessories', 'statusOverlays', 'buildings', 'props',
 'vegetation', 'terrain', 'bridges', 'atmosphere'].forEach(k => collect(manifest[k]));

let missing = 0;
for (const rel of expected) {
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) {
        console.error(`MISSING: ${rel}`);
        missing++;
    }
}

const found = new Set();
function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name === '_placeholder') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.png')) found.add(relative(spritesRoot, p));
    }
}
walk(spritesRoot);

let orphans = 0;
for (const f of found) {
    if (!expected.has(f)) {
        console.warn(`ORPHAN: ${f}`);
        orphans++;
    }
}

console.log(`expected: ${expected.size}  missing: ${missing}  orphan PNGs: ${orphans}`);
process.exit(missing > 0 ? 1 : 0);
```

- [ ] **Step 2: Add npm script**

In `package.json`, add to `"scripts"`:

```json
"sprites:validate": "node scripts/sprites/manifest-validator.mjs"
```

- [ ] **Step 3: Validate (placeholder PNGs missing → exits non-zero, that's expected)**

```bash
npm run sprites:validate || true
```

Expected output: a list of MISSING entries (~195) and exit code 1. This is the baseline before Phase 3 generation.

- [ ] **Step 4: Commit**

```bash
git add scripts/sprites/manifest-validator.mjs package.json
git commit -m "feat(sprites): add manifest validator script"
```

---

## Phase 2 — Renderer integration (still using placeholders)

### Task 2.1: AssetManager preload in App.js

**Files:**
- Modify: `claudeville/src/presentation/App.js`

- [ ] **Step 1: Read current App.js boot sequence**

```bash
grep -n "loadInitialData\|new IsometricRenderer\|new ModeManager" claudeville/src/presentation/App.js
```

- [ ] **Step 2: Insert AssetManager load before IsometricRenderer construction**

Add import at top of file:

```javascript
import { AssetManager } from './character-mode/AssetManager.js';
```

Just before the line that constructs `IsometricRenderer` (currently created during `loadCharacterMode()`), instantiate and await:

```javascript
this.assets = new AssetManager();
await this.assets.load();
```

Then pass `this.assets` to `IsometricRenderer` constructor:

```javascript
new IsometricRenderer(this.world, { assets: this.assets })
```

- [ ] **Step 3: Validate + smoke**

```bash
node --check claudeville/src/presentation/App.js
npm run dev &
sleep 2
curl -s http://localhost:4000/ | head -c 200
kill %1
```

Expected: HTTP returns the index page (HTML).

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/App.js
git commit -m "feat(sprites): preload assets before renderer construction"
```

---

### Task 2.2: IsometricRenderer terrain via TerrainTileset

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

The current renderer paints terrain via per-tile `ctx.fillStyle = ...; ctx.fillRect(...)`. Replace with `TerrainTileset.drawTile()` calls.

- [ ] **Step 1: Add imports**

```javascript
import { SpriteRenderer } from './SpriteRenderer.js';
import { TerrainTileset } from './TerrainTileset.js';
```

- [ ] **Step 2: Accept `assets` in constructor and instantiate the new renderers**

In the `IsometricRenderer` constructor, after existing field initialization:

```javascript
this.assets = options.assets;
this.sprites = new SpriteRenderer(this.assets);
this.terrain = new TerrainTileset(this.assets);
```

- [ ] **Step 3: Find and replace terrain drawing**

```bash
grep -n "_drawTerrain\|_renderTerrain\|fillStyle.*=.*THEME\." claudeville/src/presentation/character-mode/IsometricRenderer.js | head
```

Identify the per-tile loop in the render method. Replace each per-tile color block with a `TerrainTileset.drawTile()` call keyed on tile class. Initially every tile uses `terrain.grass-dirt` (the placeholder will render as a checkerboard — that's expected at this stage).

The minimal patch in the render loop:

```javascript
// Before (illustrative):
for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
        ctx.fillStyle = THEME.grass[/* noise idx */];
        ctx.fillRect(/* iso transform */);
    }
}

// After:
SpriteRenderer.disableSmoothing(ctx);
for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
        const id = this._terrainSheetIdAt(x, y);                  // returns 'terrain.grass-dirt' etc.
        const isClass = (tx, ty) => this._sameClass(x, y, tx, ty);
        this.terrain.drawTile(ctx, id, x, y, isClass);
    }
}
```

Add helper methods `_terrainSheetIdAt(x, y)` and `_sameClass(x, y, tx, ty)`:
- `_terrainSheetIdAt`: returns the appropriate tileset id based on existing tile sets (`pathTiles`, `dirtPathTiles`, `mainAvenueTiles`, `townSquareTiles`, `waterTiles` from this.scenery, etc.). For uncategorized tiles, return `'terrain.grass-dirt'` with `isClass` false everywhere (paints the lower-class variant).
- `_sameClass`: returns whether tile (tx, ty) belongs to the same class as (x, y) — used by Wang mask.

- [ ] **Step 4: Smoke**

```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
npm run dev &
sleep 2
# manual: open http://localhost:4000, expect checkerboard terrain (placeholder PNG)
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(sprites): route terrain through TerrainTileset"
```

---

### Task 2.3: IsometricRenderer routes buildings to BuildingSprite

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

- [ ] **Step 1: Add import + instantiate**

```javascript
import { BuildingSprite } from './BuildingSprite.js';

// in constructor, after this.sprites/terrain:
this.buildingSprite = new BuildingSprite(this.assets, this.sprites, this.particleSystem);
this.buildingSprite.setBuildings(this.world.buildings);      // adapt to actual API
```

- [ ] **Step 2: Replace BuildingRenderer usage in the render loop**

Find:

```bash
grep -n "buildingRenderer" claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Replace `this.buildingRenderer.drawBuilding(...)` calls with the depth-sorted enumeration:

```javascript
const drawables = [];
drawables.push(...this.buildingSprite.enumerateDrawables());
for (const sprite of this._sortedSprites) {
    drawables.push({ kind: 'agent', sprite, sortY: sprite.y });
}
drawables.sort((a, b) => a.sortY - b.sortY);
for (const d of drawables) {
    if (d.kind === 'agent') d.sprite.draw(ctx, this.camera.zoom);
    else this.buildingSprite.drawDrawable(ctx, d);
}
```

Remove the old building-render path and the `this.buildingRenderer.update()` call (replaced by `this.buildingSprite.update(dt)`).

- [ ] **Step 3: Smoke**

```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
npm run dev &
sleep 2
kill %1
```

Manual: confirm 11 checkerboard squares appear at building positions.

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(sprites): route buildings through BuildingSprite (Y-sorted with agents)"
```

---

### Task 2.4: AgentSprite draws via SpriteRenderer

**Files:**
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js`

- [ ] **Step 1: Add imports + new fields**

```javascript
import { SpriteSheet, dirFromVelocity } from './SpriteSheet.js';
import { Compositor } from './Compositor.js';
```

In the constructor:
```javascript
this.direction = 0;          // 0..7 index into DIRECTIONS
this.animState = 'idle';
this.frame = 0;
this.frameTimer = 0;
this.spriteCanvas = null;     // composited bitmap (set on first draw)
```

- [ ] **Step 2: Pass `assets` and `compositor` into AgentSprite constructor (caller change)**

In `IsometricRenderer.js` where `new AgentSprite(...)` is called, pass:
```javascript
new AgentSprite(agent, { pathfinder, bridgeTiles, assets: this.assets,
                         compositor: this.compositor })
```

Compositor is a single instance on `IsometricRenderer`:
```javascript
import { Compositor } from './Compositor.js';
// in constructor:
this.compositor = new Compositor(this.assets);
```

- [ ] **Step 3: Replace `_draw*` methods with SpriteRenderer blit**

The existing `draw(ctx, zoom)` method has many branches drawing provider-specific shapes. Replace with:

```javascript
draw(ctx, zoom) {
    if (!this.spriteCanvas) {
        const provider = this.agent.provider || 'claude';
        const variant = this._hashVariant();              // existing hash logic, mod 3
        const accessory = this._chooseAccessory();        // existing logic, returns accessory id or null
        this.spriteCanvas = this.compositor.spriteFor(provider, variant, accessory);
    }
    const sheet = new SpriteSheet(this.spriteCanvas, 64);
    const cell = sheet.cell(this.animState, this.direction, this.frame);
    const dx = Math.round(this.x - 32);
    const dy = Math.round(this.y - 56);
    ctx.drawImage(this.spriteCanvas, cell.sx, cell.sy, cell.sw, cell.sh, dx, dy, cell.sw, cell.sh);
    if (this.selected) this._drawSelectionRing(ctx);
}

_drawSelectionRing(ctx) {
    const ring = this.assetsMap?.get?.('overlay.status.selected');
    if (!ring) return;
    const dx = Math.round(this.x - ring.width / 2);
    const dy = Math.round(this.y - 8);
    ctx.drawImage(ring, dx, dy);
}
```

Update direction + frame in the `update(dt)` method:

```javascript
const dir = dirFromVelocity(this.targetX - this.x, this.targetY - this.y);
if (dir != null) this.direction = dir;
this.animState = this.moving ? 'walk' : 'idle';
this.frameTimer += dt;
const fps = this.animState === 'walk' ? 8 : 2;
const tick = 1000 / fps;
while (this.frameTimer > tick) {
    this.frame++;
    this.frameTimer -= tick;
}
```

Delete `_drawProviderClaude/Codex/Gemini`, `_drawAccessory*`, `_drawEyes*`, `_drawBody`, `_drawHead`, `facingLeft`-related logic.

Keep: position update, target/path waypoints, chat partner state, selection.

- [ ] **Step 4: Smoke**

```bash
node --check claudeville/src/presentation/character-mode/AgentSprite.js
npm run dev &
sleep 2
kill %1
```

Manual: agents should appear as checkerboard squares moving across the map.

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/AgentSprite.js claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(sprites): route agents through SpriteRenderer (8-dir + walk/idle)"
```

---

### Task 2.5: X-ray silhouette + per-pixel hit testing

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js`

- [ ] **Step 1: After drawing each building drawable, draw silhouette of agents that should appear behind it**

In the depth-sorted draw loop, when handling a `building-front` drawable, check for any agent sprite whose footprint Y is between back-half sortY and front sortY:

```javascript
if (d.kind === 'building-front') {
    this.buildingSprite.drawDrawable(ctx, d);
    for (const sprite of this._sortedSprites) {
        if (sprite.sortY > d.sortY - this.assets.getDims(d.entry.id).h * 0.5 &&
            sprite.sortY < d.sortY) {
            this.sprites.drawSilhouette(ctx, this._spriteIdFor(sprite),
                                        sprite.x, sprite.y);
        }
    }
}
```

`_spriteIdFor(sprite)` returns `agent.${sprite.agent.provider}.base` for the agent's composited sheet. (Note: for X-ray we draw a tinted version of the base sheet at the same screen position; this is approximate but effective.)

- [ ] **Step 2: Update hit testing to per-pixel**

Find the existing hit-test code:

```bash
grep -n "_hitTestAgent\|hitTestBuilding\|sprite-hit" claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Replace the bounding-box checks with `SpriteRenderer.hitTest()`:

```javascript
hitTestAt(mx, my) {
    // Try agents first (closer to camera in iso).
    for (const sprite of this._sortedSprites.slice().reverse()) {
        const id = `agent.${sprite.agent.provider}.base`;
        if (this.sprites.hitTest(id, mx, my, sprite.x - 32, sprite.y - 56)) {
            return { kind: 'agent', sprite };
        }
    }
    for (const d of this.buildingSprite.enumerateDrawables().slice().reverse()) {
        if (d.kind === 'building-back') continue;       // skip back half for hits
        const [ax, ay] = this.assets.getAnchor(d.entry.id);
        if (this.sprites.hitTest(d.entry.id, mx, my, d.wx - ax, d.wy - ay)) {
            return { kind: 'building', building: d.building };
        }
    }
    return null;
}
```

- [ ] **Step 3: Smoke**

```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
npm run dev &
sleep 2
kill %1
```

Manual: click empty area → no selection. Click on a checkerboard square (building or agent) → selection event.

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js claudeville/src/presentation/character-mode/AgentSprite.js
git commit -m "feat(sprites): per-pixel hit test + X-ray silhouette for agents behind buildings"
```

---

### Task 2.6: HiDPI integer-only scale

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

- [ ] **Step 1: Find current devicePixelRatio handling**

```bash
grep -n "devicePixelRatio\|backingStore\|ResizeObserver" claudeville/src/presentation/character-mode/IsometricRenderer.js claudeville/src/presentation/App.js
```

- [ ] **Step 2: Clamp scale factor to integer**

Wherever the canvas backing buffer is sized, replace fractional `devicePixelRatio` with:

```javascript
const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
canvas.width = cssWidth * dpr;
canvas.height = cssHeight * dpr;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
SpriteRenderer.disableSmoothing(ctx);
```

- [ ] **Step 3: Snap camera translate**

Find the camera apply step:

```bash
grep -n "ctx.translate\|camera.apply" claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Replace with:
```javascript
ctx.translate(Math.round(-this.camera.x), Math.round(-this.camera.y));
```

(Don't change `ctx.scale(this.camera.zoom, ...)` — pixel-art camera zoom should also be integer-only at 1× / 2× / 3×; if the existing zoom logic allows fractional, additionally constrain to integer steps.)

- [ ] **Step 4: Smoke + visual sanity**

```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
npm run dev &
sleep 2
kill %1
```

Manual: zoom in/out — pixels remain crisp, no smoothing artifacts. (Hard to verify with checkerboard placeholders; revisit after Phase 3.)

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(sprites): integer-only DPR + camera snap; smoothing off"
```

---

## Phase 2.5 — Reviewer-driven gates before mass generation

The three Opus reviewers flagged five issues that must land before Phase 3 spends ~94 MCP credits. Each task is small but the order matters — these are the gates.

### Task 2.5.1: Camera.js integer zoom

**Files:**
- Modify: `claudeville/src/presentation/character-mode/Camera.js`

The current `zoom` is a fractional float (e.g. `1.05`); pixel art breaks at non-integer zoom.

- [ ] **Step 1: Find the zoom field + setters**

```bash
grep -n "zoom" claudeville/src/presentation/character-mode/Camera.js
```

- [ ] **Step 2: Constrain zoom to integer steps {1, 2, 3}**

In every place `this.zoom = ...` is assigned, wrap with `Math.max(1, Math.min(3, Math.round(value)))`. If a smooth-zoom interpolation exists, replace with discrete steps on wheel/pinch input.

- [ ] **Step 3: Validate + commit**

```bash
node --check claudeville/src/presentation/character-mode/Camera.js
git add claudeville/src/presentation/character-mode/Camera.js
git commit -m "feat(sprites): clamp camera zoom to integer steps {1,2,3} for pixel-perfect blits"
```

---

### Task 2.5.2: Cache-Control for sprite assets

**Files:**
- Modify: `claudeville/server.js`

Server currently sends `Cache-Control: no-cache` for every static file. With ~195 PNGs (~30 MB total) reloading on every dev refresh, the boot target of <2s is unsafe.

- [ ] **Step 1: Find the static-file response path**

```bash
grep -n "Cache-Control\|no-cache" claudeville/server.js
```

- [ ] **Step 2: Add a path-prefix branch for `/assets/sprites/`** that emits `Cache-Control: public, max-age=31536000, immutable` while preserving `no-cache` for everything else. PNG paths are content-stable (manifest id = filename); regeneration writes new bytes to the same path, which busts the cache via `If-Modified-Since` on next reload.

- [ ] **Step 3: Smoke**

```bash
npm run dev &
sleep 1
curl -sI http://localhost:4000/assets/sprites/_placeholder/checker-64.png | grep -i cache
kill %1
```

Expected: `Cache-Control: public, max-age=31536000, immutable`.

- [ ] **Step 4: Commit**

```bash
git add claudeville/server.js
git commit -m "feat(sprites): cache sprite assets aggressively (public, immutable)"
```

---

### Task 2.5.3: Per-frame perf — bake outline at load + memoize enumerateDrawables

**Files:**
- Modify: `claudeville/src/presentation/character-mode/AssetManager.js`
- Modify: `claudeville/src/presentation/character-mode/SpriteRenderer.js`
- Modify: `claudeville/src/presentation/character-mode/BuildingSprite.js`

`SpriteRenderer.drawOutline` walks every pixel of the sprite alpha mask each frame (98k iterations for a 384×256 lighthouse — runs every frame the building is hovered). `BuildingSprite.enumerateDrawables()` rebuilds the array twice per frame (sort + hit-test). Both fix at-load.

- [ ] **Step 1: In `AssetManager._loadEntry` and `_loadComposedBuilding`, bake an outline canvas per entry**

```javascript
// after building alphaMask:
this.outlines.set(entry.id, this._bakeOutline(canvas, this.alphaMasks.get(entry.id)));
```

Where `_bakeOutline(canvas, mask)` creates a new HTMLCanvasElement at the same dims and paints 1-px gold edges via the same mask-walk currently in `SpriteRenderer.drawOutline`. Add `getOutline(id)` getter.

- [ ] **Step 2: Replace `SpriteRenderer.drawOutline`** with a single `ctx.drawImage(this.assets.getOutline(id), dx, dy)`. Per-frame cost drops from O(w·h) to O(1).

- [ ] **Step 3: In `BuildingSprite`, memoize `enumerateDrawables()` per frame**

```javascript
update(dt) {
    this.frame += (dt / 16) * (this.motionScale || 0);
    this._drawablesCache = null;          // invalidate once per frame
    for (const b of this.buildings) this._spawnEmittersFor(b);
}

enumerateDrawables() {
    if (this._drawablesCache) return this._drawablesCache;
    // ... existing build logic
    this._drawablesCache = out;
    return out;
}
```

- [ ] **Step 4: Validate + commit**

```bash
node --check claudeville/src/presentation/character-mode/{AssetManager,SpriteRenderer,BuildingSprite}.js
git add claudeville/src/presentation/character-mode/
git commit -m "perf(sprites): bake outlines at load + memoize building drawables per frame"
```

---

### Task 2.5.4: Reference-asset smoke — generate three pieces, pause, human-approve

**Goal:** Validate pipeline coherence on 3 generations before spending the remaining ~91 calls.

**Files:**
- Generates: 1 character (claude), 1 hero building base (lighthouse, 6 quadrants OR 1 reduced cell), 1 terrain Wang tileset (grass-shore — visible in screenshots).

- [ ] **Step 1: Generate exactly three reference assets**

```
mcp__pixellab__create_character(description: "<style.anchor> <claude prompt>", n_directions: 8)
mcp__pixellab__animate_character(character_id: <id>, animation: "walk")
mcp__pixellab__animate_character(character_id: <id>, animation: "idle")
mcp__pixellab__isometric_tile(description: "<style.anchor> <lighthouse base prompt>", size: 128)  # ×6 quadrants
mcp__pixellab__tileset(lower: "ancient forest grass with wildflowers and moss", upper: "wet sand and pebbles, scattered driftwood")
```

- [ ] **Step 2: Save PNGs to manifest paths and run**

```bash
npm run dev
```

Take a screenshot of the rendered scene via playwright MCP. Observable: the claude agent walking on grass-shore terrain near the lighthouse, with everything else still checkerboard placeholders.

- [ ] **Step 3: STOP and ask the user to approve coherence**

Show the screenshot. Ask explicitly: "Do these three assets feel like one art direction? Yes → continue Phase 3. No → which prompt anchors need adjustment?"

- [ ] **Step 4: If no, regenerate (max 3 attempts per asset). If still off, escalate to user with prompt-tweak options.**

- [ ] **Step 5: Once approved, commit the three reference assets**

```bash
git add claudeville/assets/sprites/characters/agent.claude.base/ \
        claudeville/assets/sprites/buildings/building.watchtower/ \
        claudeville/assets/sprites/terrain/terrain.grass-shore/
git commit -m "feat(sprites): generate reference assets (claude character, lighthouse, grass-shore) — coherence-approved"
```

The three reference paths become the **style anchor** — every later prompt SHOULD include "match the style of the existing reference assets" if pixellab supports image-conditioning, or otherwise reuse the same prompt suffix language verbatim.

---

### Task 2.5.5: Light-reflection compositing path

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

Spec §4 declares `atmosphere.light.{lighthouse-beam, fire-glow, lantern-glow}.png` but no task wires them in. They render as additive overlays on water tiles within radius of each light source.

- [ ] **Step 1: After terrain tiles are drawn but before sprites**, iterate `this.buildingSprite.getLightSources()` and for each, draw the corresponding `atmosphere.light.*.png` centered on the source position with `globalCompositeOperation = 'lighter'` and `globalAlpha = 0.5 + 0.2 * Math.sin(frame * 0.06)` (slow pulse).

- [ ] **Step 2: Restore composite op + alpha after.**

- [ ] **Step 3: Validate + commit**

```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "feat(sprites): wire light-reflection overlays for building light sources"
```

---

## Phase 3 — Asset generation (requires pixellab MCP from Task 0.2)

Each task in this phase = one or more MCP tool calls. The implementer pastes the prompts below verbatim, augmented with the `style.anchor` from `manifest.yaml`. Save returned PNGs to the manifest-implied path.

**Convention:** every prompt is concatenated as `${style.anchor} ${entry.prompt}`. The implementer SHOULD inspect each generated PNG before saving (size, palette, style). If off-style, regenerate with prompt nudges.

### Task 3.1: Wang terrain tilesets (6 calls)

**Files:**
- Create: `claudeville/assets/sprites/terrain/terrain.{class-pair}/sheet.png` × 6

- [ ] **Step 1: For each terrain entry in `manifest.yaml`, call `mcp__pixellab__tileset`**

Six entries. Example call signature:

```
mcp__pixellab__tileset(
  lower: "ancient forest grass with wildflowers and moss",
  upper: "rich loam dirt path"
)
```

Produces a 16-cell horizontal strip PNG. Save to `claudeville/assets/sprites/terrain/terrain.grass-dirt/sheet.png`.

Repeat for: `grass-cobble`, `grass-shore`, `shore-shallow`, `shallow-deep`, `cobble-square` (prompts in spec §5).

- [ ] **Step 2: Validate**

```bash
npm run sprites:validate 2>&1 | grep -E "MISSING.*terrain"
```

Expected: terrain MISSING entries dropped to 0.

- [ ] **Step 3: Visual smoke**

```bash
npm run dev &
sleep 2
# screenshot via playwright MCP
kill %1
```

Confirm the world now shows real terrain instead of checkerboards.

- [ ] **Step 4: Commit**

```bash
git add claudeville/assets/sprites/terrain/
git commit -m "feat(sprites): generate Wang tilesets for terrain (6 transitions)"
```

---

### Task 3.2: Characters (3 calls)

**Files:**
- Create: `claudeville/assets/sprites/characters/agent.{provider}.base/sheet.png` × 3

- [ ] **Step 1: Generate each character via `mcp__pixellab__create_character`**

Three calls, one per provider, with prompts from manifest §5:

```
mcp__pixellab__create_character(
  description: "${style.anchor} epic high-fantasy mage scholar, warm amber robes
                with gold trim, glowing rune sigil on chest, hooded silhouette",
  n_directions: 8
)
```

Each returns a character id. Then call `mcp__pixellab__animate_character` twice per character (walk, idle):

```
mcp__pixellab__animate_character(character_id: "<id>", animation: "walk")
mcp__pixellab__animate_character(character_id: "<id>", animation: "idle")
```

Stitch the resulting frames into a single 8-col × 6-row sheet (8-dir × (4 walk + 2 idle)) at 64px per cell. Save to `claudeville/assets/sprites/characters/agent.{provider}.base/sheet.png`.

If pixellab returns separate PNGs per direction × frame, write a small node script to compose; if it returns a sheet, save directly.

- [ ] **Step 2: Validate**

```bash
npm run sprites:validate 2>&1 | grep MISSING.*characters
```

Expected: zero.

- [ ] **Step 3: Smoke**

Manual: agents should appear as actual pixel-art characters walking. If palette swap looks wrong, debug `Compositor._applyPaletteSwap` — the source PNG must contain exact RGB matches for `palette.{provider}.{robe|pants|trim}[0]`.

- [ ] **Step 4: Commit**

```bash
git add claudeville/assets/sprites/characters/
git commit -m "feat(sprites): generate 3 provider characters (8-dir + walk + idle)"
```

---

### Task 3.3: Accessory + status overlays (10 calls)

**Files:**
- Create: `claudeville/assets/sprites/overlays/overlay.accessory.{name}.png` × 6
- Create: `claudeville/assets/sprites/overlays/overlay.status.{name}.png` × 4

- [ ] **Step 1: For each accessory entry, call `mcp__pixellab__isometric_tile`** with the manifest prompt and `size: 32`. Save to the corresponding path.

Six accessories: `mageHood`, `scholarCap`, `goldCirclet`, `goggles`, `toolBand`, `rogueMask`, `starCrown`, `oracleVeil`, `moonBand` — pick the 6 specified in the manifest.

For 8-direction overlays: either generate via `create_character` with `n_directions: 8` for an "object" prompt, or generate a single front-facing overlay and accept that accessories won't rotate (acceptable for headwear at 32×32).

- [ ] **Step 2: For each status overlay (selected ring, chat, working, idle)** call `isometric_tile` with the manifest prompt at size 64.

- [ ] **Step 3: Validate + commit**

```bash
npm run sprites:validate 2>&1 | grep MISSING.*overlays
git add claudeville/assets/sprites/overlays/
git commit -m "feat(sprites): generate accessories + status overlays"
```

---

### Task 3.4: Hero buildings — quadrants + animated overlays (28 calls)

**Files:**
- Create: `claudeville/assets/sprites/buildings/building.{type}/base-{c}-{r}.png` × 6 each, × 4 hero buildings = 24 PNGs
- Create: `claudeville/assets/sprites/buildings/building.{type}/{overlayName}.png` × 1+ per hero = 4 PNGs

For each hero (`watchtower`, `command`, `forge`, `observatory` per spec §7 emitter table — but spec §3 actually lists `Command Center, Watchtower, Observatory, Portal Gate` as the 4 heroes; reconcile with the implementer's choice from manifest):

- [ ] **Step 1: For each cell of the `composeGrid` (3×2 = 6 cells per building)**

Call `mcp__pixellab__isometric_tile` with the building's base prompt and a cell-specific prompt suffix:

```
mcp__pixellab__isometric_tile(
  description: "${style.anchor} ${entry.layers.base.prompt}, cell ${c},${r} of 3x2 grid",
  size: 128
)
```

Save as `base-${c}-${r}.png`. The `AssetManager._loadComposedBuilding` stitches at boot.

If pixellab can't generate consistent quadrants from text alone, fallback: generate a single 128px tile and accept that the hero building is smaller; revise `BUILDING_DEFS` accordingly in a follow-up commit.

- [ ] **Step 2: For each non-base layer (beacon, banner, watchfire, etc.)**

Call `isometric_tile` with the layer's prompt. Save as `{layerName}.png`.

- [ ] **Step 3: Validate + commit per hero (4 commits)**

```bash
npm run sprites:validate 2>&1 | grep MISSING.*building.watchtower
git add claudeville/assets/sprites/buildings/building.watchtower/
git commit -m "feat(sprites): generate hero building — Harbor Lighthouse (watchtower)"
```

Repeat for command, observatory, portal.

---

### Task 3.5: Standard buildings (7 calls)

**Files:**
- Create: `claudeville/assets/sprites/buildings/building.{type}/base.png` × 7

- [ ] **Step 1: For each non-hero building** (`forge`, `mine`, `taskboard`, `chathall`, `archive`, `alchemy`, `sanctuary`), call `isometric_tile` with the manifest prompt at size 128.

- [ ] **Step 2: Validate + commit**

```bash
npm run sprites:validate 2>&1 | grep MISSING.*buildings
git add claudeville/assets/sprites/buildings/
git commit -m "feat(sprites): generate standard buildings (7)"
```

---

### Task 3.6: Props (~13 calls)

**Files:**
- Create: `claudeville/assets/sprites/props/prop.{name}.png` × 13

- [ ] **Step 1: For each prop entry**, call `isometric_tile` per manifest. For animated props (lantern, banner, market awning, harbor crane), additionally call `animate_character` to produce a 3-frame variant; save as `prop.{name}.frame-{n}.png`.

- [ ] **Step 2: Validate + commit**

```bash
npm run sprites:validate 2>&1 | grep MISSING.*props
git add claudeville/assets/sprites/props/
git commit -m "feat(sprites): generate props (~13 incl. animated lantern/banner/crane)"
```

---

### Task 3.7: Vegetation (~17 calls)

**Files:**
- Create: `claudeville/assets/sprites/vegetation/veg.{species}.{variant}.png` × 17

- [ ] **Step 1: For each vegetation entry**, call `isometric_tile` per manifest.

- [ ] **Step 2: Validate + commit**

```bash
npm run sprites:validate 2>&1 | grep MISSING.*vegetation
git add claudeville/assets/sprites/vegetation/
git commit -m "feat(sprites): generate vegetation (trees, boulders, bushes, tufts, reeds)"
```

---

### Task 3.8: Bridges + docks + atmosphere (10 calls)

**Files:**
- Create: `claudeville/assets/sprites/bridges/bridge.{ew,ns}.png` × 2
- Create: `claudeville/assets/sprites/bridges/dock.{ew,ns}.png` × 2
- Create: `claudeville/assets/sprites/atmosphere/{deep-sea, light.*, aurora}.png` × ~6

- [ ] **Step 1: For each bridge/dock entry**, call `isometric_tile` per manifest.

- [ ] **Step 2: For each atmosphere entry**, call the appropriate tool (`tileset` for deep-sea seamless, `isometric_tile` for light reflections + aurora).

- [ ] **Step 3: Validate**

```bash
npm run sprites:validate
```

Expected: exit 0, all MISSING resolved.

- [ ] **Step 4: Commit**

```bash
git add claudeville/assets/sprites/bridges/ claudeville/assets/sprites/atmosphere/
git commit -m "feat(sprites): generate bridges, docks, atmosphere"
```

---

## Phase 4 — Cleanup, validation, docs

### Task 4.1: Rename BuildingRenderer.js → BuildingRenderer.legacy.js (don't delete yet)

**Reversibility:** the original reviewer flagged that deleting ~3,270 LOC with no fallback makes rollback expensive after main moves. Compromise: rename the file (so no import resolves to it accidentally) but keep it on disk for one release cycle. Delete in a follow-up PR after the sprite renderer has shipped without major bugs.

**Files:**
- Rename: `claudeville/src/presentation/character-mode/BuildingRenderer.js` → `BuildingRenderer.legacy.js`

- [ ] **Step 1: Confirm no remaining import references**

```bash
rg -n "BuildingRenderer" claudeville/ | grep -v "BuildingRenderer.legacy.js$"
```

Expected: zero matches outside the file's own header comment. If anything still imports `BuildingRenderer`, fix the importer first (likely an oversight in Task 2.3).

- [ ] **Step 2: Rename the file**

```bash
git mv claudeville/src/presentation/character-mode/BuildingRenderer.js \
       claudeville/src/presentation/character-mode/BuildingRenderer.legacy.js
```

- [ ] **Step 3: Add a top-of-file deprecation banner**

Insert at line 1 of `BuildingRenderer.legacy.js`:
```javascript
// LEGACY — replaced by BuildingSprite + AssetManager + SpriteRenderer.
// Kept as a non-imported reference for one release cycle; delete in a follow-up
// PR after the sprite renderer has shipped without rollback. Do not import.
```

- [ ] **Step 4: Smoke + commit**

```bash
npm run dev &
sleep 2
curl -s http://localhost:4000/api/sessions | head -c 80
kill %1
git add claudeville/src/presentation/character-mode/BuildingRenderer.legacy.js
git commit -m "chore(sprites): rename BuildingRenderer.js → .legacy.js (rollback fallback for one cycle)"
```

---

### Task 4.2: Strip vector drawing from AgentSprite.js

**Files:**
- Modify: `claudeville/src/presentation/character-mode/AgentSprite.js`

- [ ] **Step 1: Identify dead methods**

```bash
grep -n "_drawProvider\|_drawAccessory\|_drawEyes\|_drawBody\|_drawHead\|facingLeft" claudeville/src/presentation/character-mode/AgentSprite.js
```

- [ ] **Step 2: Delete each dead method body and any unused constants** (`PROVIDER_PROFILES`, `DEFAULT_PROFILE` if no longer used; `SPRITE_SCALE`, `SPRITE_HIT_HALF_WIDTH`, etc.). Keep helpers used by `_chooseAccessory` / `_hashVariant`.

- [ ] **Step 3: Validate**

```bash
node --check claudeville/src/presentation/character-mode/AgentSprite.js
```

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/character-mode/AgentSprite.js
git commit -m "chore(sprites): strip ~600 LOC of vector character drawing from AgentSprite"
```

---

### Task 4.3: Strip vector drawing from IsometricRenderer.js

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

- [ ] **Step 1: Identify the methods that actually exist**

```bash
grep -n "_drawHarborPier\|_drawHarborBoat\|_drawHarborCrane\|_drawHarborCrates\|_drawTerrainFeature\|_drawBush\|_drawGrassTuft\|_drawAncientRuin" claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Confirmed-present methods (per codebase review): `_drawHarborPier`, `_drawHarborBoat`, `_drawHarborCrane`, `_drawHarborCrates`, `_drawTerrainFeature`, `_drawBush`, `_drawGrassTuft`, `_drawAncientRuin`. **DO NOT** assume `_drawCommandCenterDecoration`, `_drawAtmosphereVignette`, `_drawBackgroundForest`, or `_drawReed` exist — they don't (verified). The atmosphere vignette IS rendered (via `atmosphereVignetteCache`) — keep that path; it's useful for framing.

- [ ] **Step 2: Delete the confirmed-present methods**. The ancient-ruins inline vector code (around `_drawAncientRuin`, called near `IsometricRenderer.js:1026`) and any inline background-forest loop are replaced with a single sprite blit per ruin / per background tree using `veg.tree.*` and `prop.ruin.*`.

- [ ] **Step 3: Delete the prop iteration that called `_drawHarbor*`**

The `prop.type === 'harborPier'` branch should now read:
```javascript
this.sprites.drawSprite(ctx, `prop.harbor.${prop.type.replace('harbor', '').toLowerCase()}`, x, y);
```

- [ ] **Step 4: Validate + smoke**

```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
npm run dev &
sleep 2
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "chore(sprites): strip ~700 LOC of vector shape drawing from IsometricRenderer"
```

---

### Task 4.4: Strip water-surface vector drawing from IsometricRenderer.js

**Correction from earlier draft:** SceneryEngine has no drawing methods today (only generation + walkability). The water-fill code lives in `IsometricRenderer._drawTerrain` (~lines 777-880), where `this.waterTiles` / `this.scenery.getDeepWaterTiles()` / `this.scenery.getShoreTiles()` are checked and painted via `ctx.fillStyle` / `ctx.fillRect`. That is the actual deletion target.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`

- [ ] **Step 1: Identify the water-fill code paths in `_drawTerrain` (or whichever method paints terrain tiles)**

```bash
grep -n "waterTiles\|deepWater\|shoreTiles\|fillStyle" claudeville/src/presentation/character-mode/IsometricRenderer.js | head -40
```

- [ ] **Step 2: Replace water-tile fills with `TerrainTileset.drawTile(ctx, 'terrain.shore-shallow', x, y, isShallow)` and `terrain.shallow-deep`**, where `isShallow(tx, ty)` returns true if `(tx, ty)` is in `this.scenery.getShoreTiles()`. The Wang lookup handles transitions.

- [ ] **Step 3: SceneryEngine stays untouched**. Walkability + polyline generation remain. Confirm:

```bash
rg -n "fillStyle|drawImage|ctx\." claudeville/src/presentation/character-mode/SceneryEngine.js
```

Expected: zero matches.

- [ ] **Step 4: Validate + commit**

```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "chore(sprites): route water tiles through TerrainTileset (was inline in _drawTerrain)"
```

---

### Task 4.5: Update CLAUDE.md + AGENTS.md

**Files:**
- Modify: `claudeville/CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the "World Mode" section in `claudeville/CLAUDE.md`**

Replace the file enumeration with the new module list (AssetManager, SpriteRenderer, SpriteSheet, Compositor, BuildingSprite, TerrainTileset). Note the asset manifest as source of truth.

- [ ] **Step 2: Mirror the change in `AGENTS.md`** (Visual And Rendering Architecture section).

- [ ] **Step 3: Add a new "Sprite Generation" section** in both files documenting the manifest workflow + MCP setup steps.

- [ ] **Step 4: Validate (no broken markdown links)**

```bash
rg -n "BuildingRenderer\.js" claudeville/CLAUDE.md AGENTS.md README.md docs/
```

Expected: zero matches.

- [ ] **Step 5: Commit**

```bash
git add claudeville/CLAUDE.md AGENTS.md
git commit -m "docs: update CLAUDE.md/AGENTS.md to reflect sprite renderer architecture"
```

---

### Task 4.6: Visual smoke + screenshot baseline

**Files:**
- Create: `docs/superpowers/specs/2026-04-25-pixel-art-baseline/{overview,command,harbor,mine,fringe}.png` (5 screenshots)

- [ ] **Step 1: Run server**

```bash
npm run dev
```

- [ ] **Step 2: Use playwright MCP to take 5 screenshots at known camera positions**

For each position, navigate, wait for `networkidle`, take a full-canvas screenshot, save to the baseline folder.

- [ ] **Step 3: Visual review**

Open each screenshot. Confirm:
- World renders pixel-art (no checkerboards)
- 11 buildings visible at expected positions
- Harbor lighthouse has lantern beacon visible
- Agents are sprite-based (not vector)
- Terrain tiles connect smoothly (no Wang seams)
- Water animates with shore particles
- Selection halo + activity panel still works on agent click

- [ ] **Step 4: Commit baselines**

```bash
git add docs/superpowers/specs/2026-04-25-pixel-art-baseline/
git commit -m "docs(sprites): commit visual baseline screenshots"
```

---

### Task 4.6.5: Automated visual regression smoke

**Files:**
- Create: `scripts/sprites/visual-diff.mjs`
- Modify: `package.json`

A 5,000-LOC PR with no test runner needs at least one automated safety net. Compares the 5 baseline screenshots from Task 4.6 against fresh captures using `pixelmatch`.

- [ ] **Step 1: Vendor `pixelmatch` + `pngjs` (used by validator already)**

```bash
npm install --save-dev pixelmatch pngjs
```

- [ ] **Step 2: Write `scripts/sprites/visual-diff.mjs`** that loads the 5 baseline PNGs, captures a fresh set via the playwright MCP at the same camera positions, runs `pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1 })`, and exits non-zero if any pose has > 0.5% pixels different. Save the diff PNG next to the baseline for inspection.

- [ ] **Step 3: Add npm script**

```json
"sprites:visual-diff": "node scripts/sprites/visual-diff.mjs"
```

- [ ] **Step 4: Run + commit**

```bash
npm run sprites:visual-diff
git add scripts/sprites/visual-diff.mjs package.json package-lock.json
git commit -m "feat(sprites): pixelmatch visual diff against committed baselines"
```

---

### Task 4.7: Performance check

**Files:** none (validation only)

- [ ] **Step 1: With server running, open browser devtools → Performance tab. Record 10s with 20 agents active.**

Acceptance:
- Frame time mean ≤ 16ms (60fps)
- No "Long task" warnings > 50ms during steady-state render
- `AssetManager` memory: bitmap totals ≤ 30 MB (check via `performance.memory.usedJSHeapSize` delta)

- [ ] **Step 2: If frame time > 16ms**

Likely cause: per-frame palette swap cache miss. Verify `Compositor.cache` has 3 entries × ~3 variants × ~6 accessories = ≤ 54 entries.

If hit-test cost is the problem: cache the last hit-tested entity per mouse position; only re-test on mouse-move > 1px.

- [ ] **Step 3: If performance acceptable, no commit needed.**

---

### Task 4.8: PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/pixel-art-renderer
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --title "feat: pixel-art visual upgrade (sprite renderer + pixellab MCP assets)" \
  --body "$(cat <<'EOF'
## Summary
- Replaces vector Canvas2D rendering with sprite-based pixel-art renderer
- Adds AssetManager + SpriteRenderer + BuildingSprite + TerrainTileset + Compositor + SpriteSheet
- ~195 PNGs generated via pixellab MCP from a single YAML manifest
- ~5,000 LOC of vector drawing removed (BuildingRenderer.js deleted entirely)
- Hero buildings (Lighthouse, Command Center, Observatory, Portal Gate) get composed quadrants + animated overlays + occlusion split
- 8-direction characters with walk + idle animations, palette swap by provider, accessory overlay per agent
- X-ray silhouette replaces Sims-style roof fade
- Per-pixel hit testing via cached alpha masks

## Spec & Plan
- Spec: docs/superpowers/specs/2026-04-25-pixel-art-visual-upgrade-design.md
- Plan: docs/superpowers/plans/2026-04-25-pixel-art-visual-upgrade.md

## Test plan
- [ ] `node --check` on every modified .js file
- [ ] `npm run sprites:validate` exits 0
- [ ] `npm run dev` boots; world renders without missing-asset placeholders
- [ ] Select agent → activity panel opens
- [ ] Resize window → canvas fills .content
- [ ] 5 baseline screenshots match committed baselines
- [ ] Frame time ≤ 16ms with 20 agents

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Phases 1-4 cover all 13 spec sections. Phase 2.5 (added post-review) covers the perf + reversibility + coherence gates surfaced by Opus reviewers. Asset budget reconciled.
- **No placeholders:** Every "TBD"-shaped reference has been replaced with concrete prompts/paths/commands.
- **Type consistency:** `AssetManager.get/getDims/getMask/getAnchor/getEntry/getOutline` used consistently. `SpriteRenderer.drawSprite/drawSheetCell/hitTest/drawOutline/drawSilhouette` used consistently. `BuildingSprite.enumerateDrawables/drawDrawable/drawShadows/drawBubbles/getLightSources/setAgentSprites/hitTest` matches the existing `BuildingRenderer` external surface (verified via `rg buildingRenderer\\.`). `dirFromVelocity` returns 0..7 across all callers and is smoke-tested in Task 1.4 before any consumer ships.
- **Open dependency:** Phase 3 blocks on the user completing Task 0.2 (pixellab MCP setup). Phase 2.5 has its own gate (Task 2.5.4 — reference-asset coherence approval) before mass generation begins.

### Reviewer-driven changes (post-initial-draft)
The plan was reviewed by 3 parallel Opus 4.7 agents. Consolidated fixes applied inline above:
- **Bug fixes**: `dirFromVelocity` math corrected + smoke test; `world.getBuildingsMap()` → `world.buildings`; non-existent methods (`_drawCommandCenterDecoration`, `_drawAtmosphereVignette`, `_drawBackgroundForest`, `_drawReed`) removed from deletion list; Task 4.4 retargeted from SceneryEngine (no drawing code) to `IsometricRenderer._drawTerrain`.
- **API parity**: `BuildingSprite` reimplements `drawShadows`, `drawBubbles`, `getLightSources`, `setAgentSprites`, `hitTest` (was missing) — matches `BuildingRenderer`'s full external surface.
- **Reversibility**: `BuildingRenderer.js` → `BuildingRenderer.legacy.js` (rename, not delete) for one release cycle.
- **Coherence discipline**: new Phase 2.5 reference-asset smoke gate before mass generation.
- **Perf**: outline baked at load (`AssetManager.getOutline`) + `BuildingSprite.enumerateDrawables` memoized per frame.
- **Style robustness**: palette swap uses ±12 ΔE tolerance (handles painterly anti-aliased pixels).
- **Cross-cutting**: `Camera.zoom` clamped to integer steps; `/assets/sprites/` gets aggressive `Cache-Control`; `prefers-reduced-motion` change subscribed by `BuildingSprite`; `Minimap.js` explicitly exempted from the "no fillRect" acceptance criterion (it's intentionally vector parchment art).
- **Safety net**: `npm run sprites:visual-diff` (pixelmatch) added in Task 4.6.5.
- **Filename convention**: spec §4 standardized on `base-{c}-{r}.png` for composed buildings (matched in code + validator).
