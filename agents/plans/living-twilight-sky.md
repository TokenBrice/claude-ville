# Living Twilight Sky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dark void around the isometric world with a painted Festival-Lantern-Night sky — warm plum-to-ember gradient, sparse warm stars, demoted star-cluster halos, a crescent moon, and 2 layers of slow-drifting pixel-art clouds.

**Architecture:** Screen-space sky drawn first thing in `IsometricRenderer._render()`, before `camera.applyTransform()`. A new `SkyRenderer` module owns it. The static plate (gradient + halos + stars) caches to an offscreen canvas keyed by viewport size. Clouds and moon draw on top each frame with horizontal parallax tied to `camera.x` plus a slow time-based drift. Respects `prefers-reduced-motion`.

**Tech Stack:** Vanilla ES modules, Canvas 2D, no build step. Pixellab MCP for cloud + moon sprite generation. Playwright MCP for visual smoke screenshots.

**Why no TDD:** This project has no app test runner (`AGENTS.md` / `CLAUDE.md`). Verification per task is `node --check` for syntax, `npm run sprites:validate` after manifest changes, and a visual smoke at `http://localhost:4000` (playwright-driven where possible).

**Style note:** All new code goes in English; no semantic encoding in the sky (decision per design review).

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `claudeville/src/presentation/character-mode/SkyRenderer.js` | Owns sky painting: cached gradient/halo/star plate + per-frame clouds and moon |
| Create | `claudeville/assets/sprites/atmosphere/atmosphere.cloud.cumulus.png` | Pixellab-generated cloud sprite (64×64, transparent bg) |
| Create | `claudeville/assets/sprites/atmosphere/atmosphere.cloud.wisp.png` | Pixellab-generated wisp cloud (64×64, transparent bg) |
| Create | `claudeville/assets/sprites/atmosphere/atmosphere.moon.crescent.png` | Pixellab-generated crescent moon (64×64, transparent bg) |
| Modify | `claudeville/assets/sprites/manifest.yaml` | Add 3 entries to `atmosphere:` block; bump `style.assetVersion` |
| Modify | `claudeville/src/presentation/character-mode/IsometricRenderer.js` | Instantiate `SkyRenderer` in constructor; in `_render()`, replace `THEME.bg` `fillRect` with `skyRenderer.draw(...)`; invalidate sky cache on resize |

`AssetManager._pathFor()` already maps `atmosphere.*` IDs to `assets/sprites/atmosphere/*.png` (see `claudeville/src/presentation/character-mode/AssetManager.js:153`), so no AssetManager changes are needed.

---

## Task 1: Stub SkyRenderer Module

**Files:**
- Create: `claudeville/src/presentation/character-mode/SkyRenderer.js`

**Why this is a stub:** We want the wiring in Task 2 to compile and run before any art exists. The stub fills the canvas with a single magenta sentinel color so a successful Task 2 visibly proves the integration without any other variables in play.

- [ ] **Step 1: Create the file with a minimal class shell**

```javascript
// claudeville/src/presentation/character-mode/SkyRenderer.js
//
// Drawn first thing in IsometricRenderer._render() before the camera
// transform — viewport-fixed.

export class SkyRenderer {
    constructor({ assets } = {}) {
        this.assets = assets || null;
        this.cache = null;
        this.cacheKey = '';
        this._cloudOffset = 0;
    }

    draw(ctx, canvas) {
        ctx.fillStyle = '#ff00ff'; // sentinel magenta — replaced in Task 3
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
}
```

The `cache` / `cacheKey` fields are exercised in Task 3; `_cloudOffset` is exercised in Task 6. They're declared up front so each later task is a pure-additive edit.

- [ ] **Step 2: Syntax check**

Run: `node --check claudeville/src/presentation/character-mode/SkyRenderer.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add claudeville/src/presentation/character-mode/SkyRenderer.js
git commit -m "feat(sky): stub SkyRenderer module with sentinel fill"
```

---

## Task 2: Wire SkyRenderer into IsometricRenderer

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js` (import + constructor + `_render` clear block + `_loop` → `_render` plumbing)
- Modify: `claudeville/src/presentation/App.js` (drop the now-redundant inline `canvas.style.background`)

Confirm line numbers with `grep -n` before editing — the file is 3000+ lines and unrelated edits may have shifted them. Line numbers below were verified at plan-write time but treat them as approximate.

- [ ] **Step 1: Add the import**

Find the existing imports near the top of `IsometricRenderer.js` (the `SpriteRenderer` import is the natural neighbor). Add:

```javascript
import { SkyRenderer } from './SkyRenderer.js';
```

- [ ] **Step 2: Instantiate in constructor**

The constructor is at `IsometricRenderer.js:98` (`constructor(world, options = {}) { ... }`). Add this line near the other renderer instantiations (`this.compositor` at line 103, `this.particleSystem` at 107, `this.harborTraffic` at 111):

```javascript
        this.skyRenderer = new SkyRenderer({ assets: this.assets });
```

- [ ] **Step 3: Pass `dt` from `_loop` to `_render`, then replace the THEME.bg fillRect**

`_loop()` is at line 795 and currently calls `this._render()` with no arguments. Update the call site to pass `dt`:

```javascript
    _loop() {
        if (!this.running) return;
        const now = performance.now();
        const dt = this._lastFrameTime ? Math.min(50, now - this._lastFrameTime) : 16;
        this._lastFrameTime = now;
        this._update(dt);
        this._render(dt);
        this.frameId = requestAnimationFrame(() => this._loop());
    }
```

(Only the `this._render(dt);` line changes — keep the rest as-is.)

Then update `_render()`'s signature at line 973 from `_render() {` to `_render(dt = 16) {`.

The `THEME.bg` clear block sits at `IsometricRenderer.js:980–984`:

```javascript
        // Clear
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
        ctx.fillStyle = THEME.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
```

Replace the `ctx.fillStyle = THEME.bg; ctx.fillRect(...)` pair with one call:

```javascript
        // Clear
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
        this.skyRenderer.draw(ctx, this.camera, canvas, dt, this.motionScale);
```

`this.motionScale` already exists (`IsometricRenderer.js:126`). `THEME.bg` is no longer referenced in `_render`; verify with `grep -n "THEME\.bg" claudeville/src/presentation/character-mode/IsometricRenderer.js`. If that grep returns no matches after the edit, leave the `THEME` import alone — the rest of `THEME` is still used.

- [ ] **Step 4: Drop `App.js`'s inline `canvas.style.background`**

`claudeville/src/presentation/App.js` near line 193 sets `canvas.style.background` to a dark CSS gradient. With the sky renderer painting the full canvas every frame, this CSS gradient is forever obscured — but it would briefly show during initial canvas mount. Either is acceptable, but the existing inline-style assignment is dead weight. Locate the line with `grep -n "canvas\.style\.background" claudeville/src/presentation/App.js` and delete it. Leave any neighboring `box-shadow` / `border-radius` styles alone unless they are the same statement.

If you cannot find a clean single-line removal (the assignment may be folded into a larger expression), skip this step and add `// TODO: remove dead canvas.style.background` to the surrounding line — flag for follow-up rather than risk an unrelated regression.

The cache in SkyRenderer is keyed by `${canvas.width}x${canvas.height}` (Task 3), so on browser resize the cache rebuilds automatically the next frame. No explicit invalidation hook is needed.

- [ ] **Step 5: Syntax check**

Run:
```bash
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
node --check claudeville/src/presentation/App.js
```
Expected: no output, exit 0 for each.

- [ ] **Step 6: Visual smoke**

Start the dev server and confirm the sentinel magenta replaces the dark void:

```bash
npm run dev
```

Open `http://localhost:4000` in the browser (or use playwright MCP to navigate and screenshot). The diamond-shaped island should still render correctly; the area outside the world should now be **bright magenta** instead of near-black. If the magenta covers the world too, the draw order is wrong — the sky must run before `camera.applyTransform`.

- [ ] **Step 7: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js \
        claudeville/src/presentation/App.js
git commit -m "feat(sky): wire SkyRenderer into IsometricRenderer clear path"
```

---

## Task 3: Implement Painted Cached Plate

Replace the magenta sentinel with the actual gradient + halos + stars. This is the static portion of the sky — cached once per viewport size.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SkyRenderer.js`

- [ ] **Step 1: Implement the painted plate**

Replace the entire contents of `SkyRenderer.js` with:

```javascript
// claudeville/src/presentation/character-mode/SkyRenderer.js
//
// Drawn first thing in IsometricRenderer._render() before the camera
// transform — viewport-fixed.

const PALETTE = {
    zenith: '#1e0f08',
    upperBand: '#3d1c0c',
    midBand: '#7a3a14',
    horizon: '#c85a18',
    starWarm: '#f5e8c0',
    starHot: '#f5c84a',
};

// Demoted distant glow rather than UI-looking discs: large radii, low alphas.
const HALO_POSITIONS = [
    { fx: 0.18, fy: 0.22, radiusPx: 110, color: '245, 144, 26', alpha: 0.16 },
    { fx: 0.74, fy: 0.30, radiusPx: 90,  color: '245, 200, 74', alpha: 0.13 },
];

const STAR_COUNT = 80;
const STAR_CEILING_FRAC = 0.58;

export class SkyRenderer {
    constructor({ assets } = {}) {
        this.assets = assets || null;
        this.cache = null;
        this.cacheKey = '';
        this._cloudOffset = 0;
    }

    draw(ctx, camera, canvas) {
        const cached = this._getCachedBackground(canvas);
        ctx.drawImage(cached, 0, 0);
        // Cloud + moon overlays added in Task 6.
    }

    _getCachedBackground(canvas) {
        const key = `${canvas.width}x${canvas.height}`;
        if (this.cache && this.cacheKey === key) return this.cache;
        const off = document.createElement('canvas');
        off.width = canvas.width;
        off.height = canvas.height;
        const o = off.getContext('2d');
        this._paintGradient(o, canvas);
        this._paintHalos(o, canvas);
        this._paintStars(o, canvas);
        this.cache = off;
        this.cacheKey = key;
        return off;
    }

    _paintGradient(ctx, canvas) {
        const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
        g.addColorStop(0.00, PALETTE.zenith);
        g.addColorStop(0.45, PALETTE.upperBand);
        g.addColorStop(0.78, PALETTE.midBand);
        g.addColorStop(1.00, PALETTE.horizon);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _paintHalos(ctx, canvas) {
        for (const halo of HALO_POSITIONS) {
            const cx = halo.fx * canvas.width;
            const cy = halo.fy * canvas.height;
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, halo.radiusPx);
            grad.addColorStop(0, `rgba(${halo.color}, ${halo.alpha})`);
            grad.addColorStop(1, `rgba(${halo.color}, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }

    _paintStars(ctx, canvas) {
        // Tiny LCG keeps the star field identical across reloads / resizes.
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        let seed = 12345;
        const next = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };
        for (let i = 0; i < STAR_COUNT; i++) {
            const x = Math.round(next() * canvas.width);
            const y = Math.round(next() * ceilingY);
            const hot = next() < 0.18;
            const size = hot ? 2 : 1;
            ctx.fillStyle = hot ? PALETTE.starHot : PALETTE.starWarm;
            ctx.fillRect(x, y, size, size);
        }
    }
}
```

Note: `IsometricRenderer._render` calls `this.skyRenderer.draw(ctx, this.camera, canvas, dt, this.motionScale)` (Task 2). The two trailing args are ignored at this stage — `draw()` signature accepts only `(ctx, camera, canvas)` for now and JS quietly drops the extras. They're consumed when Task 6 widens the signature.

- [ ] **Step 2: Syntax check**

Run: `node --check claudeville/src/presentation/character-mode/SkyRenderer.js`
Expected: no output, exit 0.

- [ ] **Step 3: Visual smoke**

Reload `http://localhost:4000`. Confirm:
- The void around the world now shows a deep-plum-to-ember vertical gradient.
- Two faint warm halos are visible in the upper-left and upper-right areas — they should look like distant glow, NOT like UI buttons or selected indicators.
- A sparse field of warm pinpoint stars sits in the upper half.
- The world (terrain, agents, buildings, lanterns) renders unchanged on top.

If the halos look too disc-like or too saturated, reduce their `alpha` values in `HALO_POSITIONS`. Polish in Task 7.

Optional: capture a screenshot via playwright MCP for the record.

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/character-mode/SkyRenderer.js
git commit -m "feat(sky): paint cached gradient, halos, and star field"
```

---

## Task 4: Add Manifest Entries and Bump assetVersion

The runtime degrades gracefully when sprites are missing (Task 6's draw code is `if (!img) return;`), so this manifest edit can land before the PNGs exist. The validator in Task 5 will then confirm the PNGs match the manifest.

**Files:**
- Modify: `claudeville/assets/sprites/manifest.yaml` (atmosphere block + style.assetVersion)

- [ ] **Step 1: Bump `style.assetVersion`**

In `claudeville/assets/sprites/manifest.yaml:2`, change:

```yaml
  assetVersion: "2026-04-27-codex-weapons-sonnet-scout-v1"
```

to:

```yaml
  assetVersion: "2026-04-27-living-twilight-sky-v1"
```

(Format: keep the YYYY-MM-DD-<slug>-vN convention used by prior bumps.)

- [ ] **Step 2: Append three entries to the `atmosphere:` block**

Find the `atmosphere:` block (currently around `manifest.yaml:675`; locate exactly with `grep -n "^atmosphere:" claudeville/assets/sprites/manifest.yaml`). After the existing `atmosphere.light.lantern-glow` entry and BEFORE the commented-out `atmosphere.aurora`, insert these three entries. The three `atmosphere.light.*` entries already use `tool: isometric_tile, size: 64` for flat overlays with transparent backgrounds — these new entries match that proven pattern. (Note: `atmosphere.deep-sea` uses `tool: tileset` and is unrelated — it's a tiled water surface, not a flat overlay sprite.)

```yaml
  - id: atmosphere.cloud.cumulus
    tool: isometric_tile
    prompt: "low-poly pixel-art fantasy cloud silhouette, warm rust and burnt-umber tones edged with amber rim light, fluffy stratocumulus shape, painterly RPG sky, transparent background"
    size: 64

  - id: atmosphere.cloud.wisp
    tool: isometric_tile
    prompt: "thin pixel-art cirrus wisp, pale ember and dusky rose, drawn-out streak shape, warm twilight sky, transparent background"
    size: 64

  - id: atmosphere.moon.crescent
    tool: isometric_tile
    prompt: "pixel-art crescent moon, warm gold rim with darker amber inner shadow, no face, painterly RPG night sky, transparent background"
    size: 64
```

- [ ] **Step 3: Sanity-check YAML parse**

Run:
```bash
node -e "const fs = require('fs'); const y = require('./node_modules/js-yaml'); y.load(fs.readFileSync('claudeville/assets/sprites/manifest.yaml','utf8')); console.log('ok');"
```
Expected: `ok`.

If `js-yaml` is missing, run `npm install` first (per `CLAUDE.md` validation checklist).

- [ ] **Step 4: Commit**

```bash
git add claudeville/assets/sprites/manifest.yaml
git commit -m "feat(sky): add cloud and moon manifest entries; bump assetVersion"
```

Note: `npm run sprites:validate` will fail at this point because the PNGs don't exist. That's expected — Task 5 fixes it.

---

## Task 5: Generate Cloud and Moon Sprites via Pixellab

Use the existing pixellab MCP runbook (`scripts/sprites/generate.md` + `docs/pixellab-reference.md`) to produce three 64×64 transparent-background PNGs.

**Files:**
- Create: `claudeville/assets/sprites/atmosphere/atmosphere.cloud.cumulus.png`
- Create: `claudeville/assets/sprites/atmosphere/atmosphere.cloud.wisp.png`
- Create: `claudeville/assets/sprites/atmosphere/atmosphere.moon.crescent.png`

- [ ] **Step 1: Confirm pixellab MCP is available**

Run: `claude mcp list`
Expected: `pixellab` listed and connected.

If absent, follow the setup in `scripts/sprites/generate.md` ("Setup" section).

- [ ] **Step 2: Generate the three sprites**

For each entry, call the `mcp__pixellab__create_isometric_tile` tool with the manifest's `prompt` (Task 4) and `size: 64`. Poll via `mcp__pixellab__get_isometric_tile` until ready, then save the resulting PNG to the path under "Files" above.

If you're driving this from Claude Code, the agent can issue the three tool calls directly. The style anchor at the top of `manifest.yaml` is already concatenated into prompts by the runbook, so prompts here only carry per-sprite descriptors.

- [ ] **Step 3: Confirm files exist with the right dimensions**

```bash
ls -la claudeville/assets/sprites/atmosphere/atmosphere.cloud.cumulus.png \
       claudeville/assets/sprites/atmosphere/atmosphere.cloud.wisp.png \
       claudeville/assets/sprites/atmosphere/atmosphere.moon.crescent.png
file   claudeville/assets/sprites/atmosphere/atmosphere.cloud.*.png \
       claudeville/assets/sprites/atmosphere/atmosphere.moon.crescent.png
```
Expected: each file is 64×64 PNG, RGBA.

- [ ] **Step 4: Run sprite validator**

```bash
npm run sprites:validate
```
Expected: pass. Manifest ↔ PNG bidirectional check should accept the three new entries and find no orphans.

If it fails on missing local `js-yaml`, fall back to manifest/code inspection plus the `file` dimensions check above (per the prior-learnings note in `CLAUDE.md`).

- [ ] **Step 5: Visual smoke**

Reload `http://localhost:4000`. The new sprites are NOT yet drawn (Task 6 wires them in). Browser console should be clean — `AssetManager` should load the three PNGs without errors. If the network tab shows 404s for any of the three, fix the path before continuing.

- [ ] **Step 6: Commit**

```bash
git add claudeville/assets/sprites/atmosphere/atmosphere.cloud.cumulus.png \
        claudeville/assets/sprites/atmosphere/atmosphere.cloud.wisp.png \
        claudeville/assets/sprites/atmosphere/atmosphere.moon.crescent.png
git commit -m "feat(sky): generate cloud and crescent moon sprites via pixellab"
```

---

## Task 6: Render Cloud Parallax and Moon

Now wire the sprites into the per-frame draw path in `SkyRenderer`.

**Files:**
- Modify: `claudeville/src/presentation/character-mode/SkyRenderer.js`

- [ ] **Step 1: Add the cloud-layer constants block**

Near the top of `SkyRenderer.js`, immediately after `STAR_CEILING_FRAC`, add:

```javascript
const CLOUD_LAYERS = [
    { id: 'atmosphere.cloud.cumulus', fy: 0.16, parallax: 0.04, driftMul: 0.4, alpha: 0.85, count: 4 },
    { id: 'atmosphere.cloud.wisp',    fy: 0.30, parallax: 0.08, driftMul: 0.7, alpha: 0.55, count: 5 },
];

const CLOUD_DRIFT_PX_PER_MS = 0.004;
const MOON_FX = 0.78;
const MOON_FY = 0.10;
```

- [ ] **Step 2: Widen `draw()` and add cloud + moon helpers**

Replace the existing `draw()` method body with:

```javascript
    draw(ctx, camera, canvas, dt = 16, motionScale = 1) {
        const cached = this._getCachedBackground(canvas);
        ctx.drawImage(cached, 0, 0);
        this._cloudOffset = (this._cloudOffset + dt * CLOUD_DRIFT_PX_PER_MS * motionScale) % canvas.width;
        this._drawClouds(ctx, camera, canvas);
        this._drawMoon(ctx, canvas);
    }
```

Add these private methods immediately after `_paintStars()`:

```javascript
    _drawClouds(ctx, camera, canvas) {
        if (!this.assets) return;
        const camX = camera?.x || 0;
        for (const layer of CLOUD_LAYERS) {
            const img = this.assets.get(layer.id);
            if (!img) continue;
            const dims = this.assets.getDims(layer.id);
            const w = dims?.w ?? img.width ?? 64;
            const spacing = canvas.width / layer.count;
            // Tile period is `spacing`, not canvas.width — wrap the offset into
            // [0, spacing) so neighbouring clouds always abut without a gap.
            const rawOffset = -camX * layer.parallax + this._cloudOffset * layer.driftMul;
            const baseOffset = ((rawOffset % spacing) + spacing) % spacing;
            const y = layer.fy * canvas.height;
            ctx.save();
            ctx.globalAlpha = layer.alpha;
            // Draw count + 2 instances (one leading off-screen each side) so a
            // sprite is always feeding in as another walks out.
            for (let i = -1; i <= layer.count; i++) {
                const x = i * spacing + baseOffset - w / 2;
                ctx.drawImage(img, Math.round(x), Math.round(y));
            }
            ctx.restore();
        }
    }

    _drawMoon(ctx, canvas) {
        if (!this.assets) return;
        const moon = this.assets.get('atmosphere.moon.crescent');
        if (!moon) return;
        const dims = this.assets.getDims('atmosphere.moon.crescent');
        const w = dims?.w ?? moon.width ?? 64;
        const x = canvas.width * MOON_FX - w / 2;
        const y = canvas.height * MOON_FY;
        ctx.drawImage(moon, Math.round(x), Math.round(y));
    }
```

Notes:
- `assets.get(id)` and `assets.getDims(id)` are the AssetManager public API (`AssetManager.js:234` and the dim accessor it exposes alongside). The early `if (!this.assets) return` already guards the only realistic null case, so no optional chaining is needed on the call.
- `camera.x` is the horizontal pan in pixel units (`IsometricRenderer.js:664`).
- `parallax` is fractional and used with a negative sign relative to camera — the sky drifts opposite to camera pan so it reads as far away.
- `_cloudOffset` is now bounded to `[0, canvas.width)` by the modulo in `draw()`, so floats stay precise across long sessions.
- Reduced motion: `motionScale === 0` zeroes the time-drift term but leaves camera-pan parallax active. This is intentional — `prefers-reduced-motion` targets autonomous animation; user-driven panning is fine. If a future a11y review wants pan parallax also frozen, gate `parallax` on `motionScale` too.

- [ ] **Step 2: Syntax check**

Run: `node --check claudeville/src/presentation/character-mode/SkyRenderer.js`
Expected: no output, exit 0.

- [ ] **Step 3: Visual smoke — clouds and moon visible**

Reload `http://localhost:4000`. Confirm:
- A crescent moon is visible in the upper-right of the sky.
- Two cloud bands are visible (lower wisps + higher cumulus). They should sit clearly in the sky above the world.
- Pan the camera left/right (drag the canvas). Clouds should drift slightly opposite the world's motion (parallax). If they move 1:1 with the world the parallax math is wrong (check the sign on `pixelOffset`).
- Wait ~10 seconds without panning. Clouds should drift slowly horizontally on their own.
- Browser console: clean.

- [ ] **Step 4: Visual smoke — reduced motion**

In Chrome DevTools: open the Rendering tab → "Emulate CSS media feature prefers-reduced-motion" → "reduce". Reload.
Expected: clouds stop drifting (stay at the position they were at on load). Camera-driven parallax still works (motion-reduce only stops *time-based* drift, not user-triggered motion).

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/SkyRenderer.js
git commit -m "feat(sky): cloud parallax drift and crescent moon overlay"
```

---

## Task 7: Polish and Final Smoke

Tune values, verify edge cases, capture a record screenshot.

**Files:**
- Possibly modify: `claudeville/src/presentation/character-mode/SkyRenderer.js` (constants only)

- [ ] **Step 1: Palette and position tuning pass**

With the dev server running, iterate on these values in `SkyRenderer.js` until the look matches the brief:

- `PALETTE.*` color stops — if zenith feels too black, lighten `#1e0f08` toward `#241410`. If horizon clashes with the warm earth tones below, push it slightly redder (`#a9461a`) or warmer (`#d8631c`).
- `HALO_POSITIONS[*].alpha` — keep both ≤ 0.18 to avoid the "UI button" risk flagged in design review. If they read as too prominent at certain viewport sizes, reduce.
- `STAR_COUNT` — 80 is a starting point; 60–120 is the legibility band.
- Cloud `alpha` values — wisps especially should feel like haze, not opaque sprites. If clouds compete with the world for attention, drop their alphas by 0.15.
- Moon position `0.78, 0.10` — if it overlaps a cloud band, shift to `0.82, 0.08` or move clouds.

There's no automated test here — just eyeball it at zoom 1, 2, and 3, and at a couple of pan positions.

- [ ] **Step 2: Confirm `_drawAtmosphere` vignette still composes well**

The screen-space vignette at `IsometricRenderer.js:2895` (`_drawAtmosphere()`) and `_getAtmosphereVignette()` (a few methods below it) draws ON TOP of the world AFTER the camera transform is reset. It will tint the new sky too. Quickly confirm this doesn't muddy the sky:

- The vignette's `skyWash` gradient (around `IsometricRenderer.js:2942–2945`) uses low alphas (0.14, 0, 0.28). On the new plum sky it should add a subtle warm bloom at the top and warmth at the bottom — a feature, not a bug.
- If the vignette darkens the new sky too aggressively, do NOT remove the vignette. Instead, consider lowering the vignette's bottom-stop alpha. Out of scope for this task — flag for follow-up.

- [ ] **Step 3: Verify world legibility**

Specific checks:
- Agents and lanterns silhouette cleanly against the sky at all zoom levels (the warm sky has decent contrast with parchment-gold sprite outlines, but verify).
- Selected-agent ring and chat bubbles still pop.
- Minimap (vector parchment art, out of scope) still renders normally.
- Dashboard mode (CSS background, separate path) still renders normally.

- [ ] **Step 4: Capture a baseline screenshot**

```bash
mkdir -p agents/research
```

Then use playwright MCP to navigate to `http://localhost:4000`, wait for `networkidle`, and capture a full-page screenshot. Save to `agents/research/sky-after.png` for the record.

- [ ] **Step 5: Final visual diff (optional but recommended)**

If sprite-baseline tooling is set up (`npm run sprites:capture-fresh` and `npm run sprites:visual-diff`), run it. The world canvas changes substantially (the void → a sky), so there will be diffs — confirm they're confined to the void area and don't affect terrain/agent/building rendering.

- [ ] **Step 6: Final commit**

```bash
git add claudeville/src/presentation/character-mode/SkyRenderer.js \
        agents/research/sky-after.png
git commit -m "chore(sky): tune palette and capture baseline screenshot"
```

---

## Validation Checklist

Before declaring done:

- [ ] `node --check claudeville/src/presentation/character-mode/SkyRenderer.js` passes.
- [ ] `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js` passes.
- [ ] `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check` passes (regression sweep).
- [ ] `npm run sprites:validate` passes (or fallback inspection if `js-yaml` is missing locally).
- [ ] `http://localhost:4000` loads cleanly; sky visible; world unchanged.
- [ ] `http://localhost:4000/api/sessions` and `/api/providers` return normally (rendering changes shouldn't touch backend, but confirm).
- [ ] Browser console is clean across World mode and Dashboard mode toggle.
- [ ] Reduced-motion preference disables cloud drift but the sky still paints.
- [ ] At zoom 1, 2, 3: sky reads as intended; world legibility unchanged.
- [ ] Agent select / deselect still opens / closes the activity panel.
- [ ] Resize browser: sky cache rebuilds (no stale-size artifacts).

## Out of Scope (deliberate cuts from the design review)

- **Wall-clock 4-mood cycle** (dawn/noon/dusk/night). Skipped per Path 2; pinned single mood. Adding moods later is constants-only work — only `PALETTE` and one method on `SkyRenderer` change.
- **Shooting-star-on-commit particle.** Polish, slot in later. Would hook into the existing `gitEvents` adapter pipeline.
- **Separate stacked sky canvas (Approach 3).** Would require switching the world canvas to `alpha:true` and auditing for transparency bleed. Not needed for this pass; the screen-space approach inside the main canvas works fine.
- **Adjusting `_drawAtmosphere`'s `skyWash`** to harmonize with the new sky. Flagged in Task 7 as a follow-up; only worth touching if the vignette demonstrably muddies the result.
