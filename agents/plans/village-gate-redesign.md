# Village Gate Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the procedural village gate with a stone-on-wood hybrid gatehouse, route a real cobble road through the threshold, transition the adjacent walls into stone footing, and add a binary closed/open door state hooked into the existing agent gate-transit infrastructure.

**Architecture:** Procedural Canvas2D rewrite of four gate-drawing methods plus one wall-overlay extension in `IsometricRenderer.js`, plus one new road in `townPlan.js`. No new sprites, no manifest bump, no new event types — door state reads from the already-tracked `gateTransits` Map. The gate lantern registers with `LightSourceRegistry` via a new method called from `_computeFrameLightSources`.

**Tech Stack:** Vanilla ES modules, Canvas 2D, Node 20+ for `node --check`. Browser smoke at `http://localhost:4000` via `npm run dev`. No app test runner — validation is `node --check` + visual smoke + optional `npm run sprites:capture-fresh` / `sprites:visual-diff`.

**Design spec:** [`agents/plans/village-gate-redesign-design.md`](./village-gate-redesign-design.md).

**Sequencing:** Each task ends with a commit. Order is chosen so the world stays renderable after every commit — the road comes in first so when we strip the threshold patch later, there's already cobble underneath.

---

## File Structure

| Path | Action | Owner Task |
|---|---|---|
| `claudeville/src/config/townPlan.js` | Modify (append road, possibly tweak `VILLAGE_GATE.inside.tileX`, possibly tweak `VILLAGE_GATE_BOUNDS`) | Tasks 1, 6, 10 |
| `claudeville/src/presentation/character-mode/IsometricRenderer.js` | Modify (add palette + state; rewrite gate-drawing methods; extend wall segment) | Tasks 2-9 |

No new files. The whole rewrite stays inside the two files that currently own the gate.

---

## Task 1: Add `gate-avenue` road in `townPlan.js`

**Files:**
- Modify: `claudeville/src/config/townPlan.js` (append entry to `TOWN_ROAD_ROUTES`)

**Why first:** the road must exist before we strip the threshold patch (Task 5), otherwise the gate would briefly render with grass underneath instead of cobble.

- [ ] **Step 1: Open the file and find `TOWN_ROAD_ROUTES`**

```bash
sed -n '48,98p' claudeville/src/config/townPlan.js
```

You should see `export const TOWN_ROAD_ROUTES = Object.freeze([...])` containing 8 entries: `north-bank-promenade`, `production-row`, `west-production-road`, `central-river-bridge`, `archive-walk`, `clock-walk`, `lighthouse-quay`, `harbor-berths`.

- [ ] **Step 2: Append the new entry inside the array**

Insert this entry as the last element of the `TOWN_ROAD_ROUTES` array (just before the closing `])`):

```js
    {
        id: 'gate-avenue',
        material: 'avenue',
        width: 1,
        points: [[18, 27], [18, 32], [19, 36], [19, 39]],
    },
```

The route branches off the existing `central-river-bridge` spine where it turns east at (18, 27), runs ~12 tiles south through open ground (passing west of Task Board at (21, 31)), and arrives at the gate threshold (19, 39).

- [ ] **Step 3: Verify syntax**

Run: `node --check claudeville/src/config/townPlan.js`

Expected: no output (success).

- [ ] **Step 4: Visual smoke**

Run: `npm run dev` (if not already running). Open `http://localhost:4000`, switch to World mode, pan/zoom to the south edge of the map. The cobble road should now extend from the existing central-river-bridge spine all the way down to the gate.

The threshold patch you saw before will still be there (we strip it in Task 5) — that's expected. The new road sits underneath it.

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/config/townPlan.js
git commit -m "$(cat <<'EOF'
townPlan: add gate-avenue connecting civic spine to south gate

Branches off central-river-bridge at (18, 27) and runs south to the
gate threshold at (19, 39), giving the gate a real road to thread
through. Sets up the threshold patch removal in a later step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `VILLAGE_STONE_PALETTE` constant

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:346-362`

- [ ] **Step 1: Locate the existing `VILLAGE_WOOD_PALETTE` block**

Run: `grep -n "VILLAGE_WOOD_PALETTE = Object.freeze" claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected output: `346:const VILLAGE_WOOD_PALETTE = Object.freeze({`. The block runs from line 346 to line 362 (closing `});` followed by a blank line).

- [ ] **Step 2: Insert the new palette directly below the existing one**

Add this block between the `});` of `VILLAGE_WOOD_PALETTE` and the next constant `VILLAGE_WALL_SEA_TOWER_SPRITE_ID`:

```js
const VILLAGE_STONE_PALETTE = Object.freeze({
    light: '#cfc6b3',
    mid: '#bdb6a8',
    shadow: '#a59e8d',
    mortar: '#5b574e',
    moss: '#4f7b3d',
    outline: '#1b1009',
});
```

- [ ] **Step 3: Verify syntax**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "$(cat <<'EOF'
gate: add VILLAGE_STONE_PALETTE for hybrid gatehouse

Stone tones (light/mid/shadow + mortar) for the new gate towers'
foundations and the wall stone-footing transition. Reuses the
existing outline color and the village's moss green so it sits
inside the same pixel-art language.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite `_drawVillageGateTower`

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:2719-2870`

The new tower is hybrid: stone foundation (lower ~64px) + wood-frame upper (~42px) + teal pitched roof (~40px). Total height ~150px (was ~150px including the old roof).

- [ ] **Step 1: Locate the existing method**

Run: `grep -n "_drawVillageGateTower(ctx, x, y, side" claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: `2719:    _drawVillageGateTower(ctx, x, y, side = 1) {`. The body runs through `2870:    }`.

- [ ] **Step 2: Replace the entire method body with the hybrid version**

Replace lines 2719-2870 (the full `_drawVillageGateTower` method) with:

```js
    _drawVillageGateTower(ctx, x, y, side = 1) {
        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const w = 64;
        const hStone = 64;
        const hWood = 42;
        const roofH = 36;
        const outward = side >= 0 ? 1 : -1;
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Foot shadow (single ellipse, integrated with threshold)
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = stone.outline;
        ctx.beginPath();
        ctx.ellipse(Math.round(x), Math.round(y + 14), w / 2 + 14, 12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Side face peek (3D depth on outward side, stone material)
        const sideDepth = 14 * outward;
        const sideDrop = 8;
        const stoneTop = y - hStone;
        const trace = (...points) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (const p of points.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };

        if (outward > 0) {
            trace(
                { x: x + w / 2, y: stoneTop },
                { x: x + w / 2 + sideDepth, y: stoneTop + sideDrop },
                { x: x + w / 2 + sideDepth, y: y + sideDrop },
                { x: x + w / 2, y },
            );
        } else {
            trace(
                { x: x - w / 2 + sideDepth, y: stoneTop + sideDrop },
                { x: x - w / 2, y: stoneTop },
                { x: x - w / 2, y },
                { x: x - w / 2 + sideDepth, y: y + sideDrop },
            );
        }
        ctx.fillStyle = stone.shadow;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Stone foundation front face — solid base with mortared courses
        const stoneLeft = x - w / 2;
        const stoneRight = x + w / 2;
        ctx.fillStyle = stone.mid;
        ctx.fillRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);

        // Mottled stone blocks (light/mid alternation)
        const courseH = 16;
        for (let row = 0; row < 4; row++) {
            const rowY = stoneTop + row * courseH;
            const offset = row % 2 ? 12 : 0;
            for (let col = -offset; col < w; col += 24) {
                const sx = stoneLeft + col;
                const ex = Math.min(stoneLeft + col + 24, stoneRight);
                if (ex <= stoneLeft) continue;
                const seed = this._tileNoise(row * 13 + 7, col + side * 31);
                ctx.fillStyle = seed > 0.55 ? stone.light : stone.shadow;
                ctx.fillRect(Math.round(Math.max(stoneLeft, sx)), Math.round(rowY),
                             Math.round(ex - Math.max(stoneLeft, sx)), courseH);
            }
        }

        // Mortar lines (horizontal courses)
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        for (let row = 1; row < 4; row++) {
            const rowY = stoneTop + row * courseH;
            ctx.beginPath();
            ctx.moveTo(Math.round(stoneLeft), Math.round(rowY));
            ctx.lineTo(Math.round(stoneRight), Math.round(rowY));
            ctx.stroke();
        }

        // Mortar verticals (offset per course for brick-like pattern)
        for (let row = 0; row < 4; row++) {
            const rowY1 = stoneTop + row * courseH;
            const rowY2 = rowY1 + courseH;
            const offset = row % 2 ? 12 : 0;
            for (let col = 24 - offset; col < w; col += 24) {
                const cx = stoneLeft + col;
                ctx.beginPath();
                ctx.moveTo(Math.round(cx), Math.round(rowY1));
                ctx.lineTo(Math.round(cx), Math.round(rowY2));
                ctx.stroke();
            }
        }

        // Re-stroke perimeter to keep outline crisp
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);

        // Archer slit centered on stone front
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 4), Math.round(stoneTop + hStone / 2 - 11), 8, 22);

        // Moss tuft at base
        ctx.fillStyle = stone.moss;
        ctx.fillRect(Math.round(stoneRight - 18), Math.round(y - 4), 14, 4);
        ctx.fillRect(Math.round(stoneLeft + 4), Math.round(y - 4), 10, 3);

        // Floor band — visible structural transition between stone and wood
        const woodTop = stoneTop - hWood;
        const bandH = 6;
        ctx.fillStyle = wood.deep;
        ctx.fillRect(Math.round(stoneLeft - 2), Math.round(stoneTop - bandH), w + 4, bandH);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(stoneLeft - 2), Math.round(stoneTop - bandH), w + 4, bandH);

        // Wood-frame upper — vertical planks matching wall plank rule
        ctx.fillStyle = wood.mid;
        ctx.fillRect(Math.round(stoneLeft), Math.round(woodTop), w, hWood - bandH);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(woodTop), w, hWood - bandH);

        // Plank lines (vertical)
        ctx.strokeStyle = '#2c190d';
        ctx.lineWidth = 1;
        for (let plank = stoneLeft + 8; plank < stoneRight; plank += 12) {
            ctx.beginPath();
            ctx.moveTo(Math.round(plank), Math.round(woodTop + 4));
            ctx.lineTo(Math.round(plank), Math.round(stoneTop - bandH - 2));
            ctx.stroke();
        }

        // Highlight planks (subtle warm streaks)
        ctx.strokeStyle = 'rgba(214, 151, 78, 0.4)';
        for (let plank = stoneLeft + 14; plank < stoneRight; plank += 24) {
            ctx.beginPath();
            ctx.moveTo(Math.round(plank), Math.round(woodTop + 4));
            ctx.lineTo(Math.round(plank), Math.round(stoneTop - bandH - 2));
            ctx.stroke();
        }

        // Narrow window slit in wood
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 4), Math.round(woodTop + 10), 8, 16);

        // Eave shadow under roof
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(Math.round(stoneLeft), Math.round(woodTop), w, 3);

        // Teal pitched roof — front gable
        const roofLeft = stoneLeft - 8;
        const roofRight = stoneRight + 8;
        const ridgeY = woodTop - roofH;
        trace(
            { x: roofLeft, y: woodTop },
            { x: x, y: ridgeY },
            { x: roofRight, y: woodTop },
        );
        ctx.fillStyle = wood.teal;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Roof shadow side (the half away from the light)
        const lightSide = outward > 0 ? -1 : 1; // light comes from the inward side
        if (lightSide < 0) {
            trace(
                { x: roofLeft, y: woodTop },
                { x: x, y: ridgeY },
                { x: x, y: woodTop },
            );
        } else {
            trace(
                { x: x, y: ridgeY },
                { x: roofRight, y: woodTop },
                { x: x, y: woodTop },
            );
        }
        ctx.fillStyle = 'rgba(20, 63, 67, 0.46)';
        ctx.fill();

        // Ridge highlight
        ctx.strokeStyle = wood.tealLight;
        ctx.lineWidth = 1;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(Math.round(x), Math.round(ridgeY + 2));
            ctx.lineTo(Math.round(x + i * 8), Math.round(woodTop - 4));
            ctx.stroke();
        }

        // Ridge cap accent
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 2), Math.round(ridgeY - 4), 4, 6);

        ctx.restore();
    }
```

- [ ] **Step 3: Verify syntax**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: no output.

- [ ] **Step 4: Visual smoke**

Refresh `http://localhost:4000`, pan to the gate. Towers should now render as stone (lower) + wood (upper) + teal pitched roof. The floating threshold patch from the OLD threshold method is still there underneath — that's fine; we strip it in Task 5.

If the towers are clipped at the canvas edge or look misaligned with the wall, note that for Task 6 (bounds check).

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "$(cat <<'EOF'
gate: rewrite tower as stone-on-wood hybrid with teal roof

Replaces the slabby crosshatch tower front with a mossy stone
foundation (mottled courses, mortar, archer slit), a wood-frame
upper (plank infill matching wall planks, narrow window slit), and
the village's signature teal pitched roof so the gate towers read
as part of the same architectural family as every other building.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite `_drawVillageGateArch`

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:2872-2961` (existing arch method)

The new arch is a carved timber lintel with iron straps + plaque + hanging iron lantern. Doors are NOT rendered yet (Task 8 adds them).

- [ ] **Step 1: Locate the existing method**

Run: `grep -n "_drawVillageGateArch(ctx, leftBase" claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: `2872:    _drawVillageGateArch(ctx, leftBase, rightBase) {`. The body ends at the matching `}` (around line 2961 after the previous edit).

- [ ] **Step 2: Replace the entire method body**

Replace the full `_drawVillageGateArch` method with:

```js
    _drawVillageGateArch(ctx, leftBase, rightBase) {
        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const dx = rightBase.x - leftBase.x;
        const dy = rightBase.y - leftBase.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        const lintelInset = 22;
        const lintelHeight = 26;
        const start = { x: leftBase.x + ux * lintelInset, y: leftBase.y + uy * lintelInset - 110 };
        const end = { x: rightBase.x - ux * lintelInset, y: rightBase.y - uy * lintelInset - 110 };
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Lintel main beam
        const trace = (...points) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (const p of points.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };
        trace(
            { x: start.x, y: start.y },
            { x: end.x, y: end.y },
            { x: end.x, y: end.y + lintelHeight },
            { x: start.x, y: start.y + lintelHeight },
        );
        ctx.fillStyle = wood.mid;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Top edge highlight
        ctx.strokeStyle = wood.cut;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(start.x), Math.round(start.y + 1));
        ctx.lineTo(Math.round(end.x), Math.round(end.y + 1));
        ctx.stroke();

        // Bottom shadow line
        ctx.strokeStyle = '#3f2412';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(start.x), Math.round(start.y + lintelHeight - 1));
        ctx.lineTo(Math.round(end.x), Math.round(end.y + lintelHeight - 1));
        ctx.stroke();

        // Iron straps (two evenly spaced)
        ctx.fillStyle = '#2c190d';
        for (const t of [0.32, 0.68]) {
            const sx = start.x + (end.x - start.x) * t;
            const sy = start.y + (end.y - start.y) * t;
            ctx.fillRect(Math.round(sx - 1.5), Math.round(sy), 3, lintelHeight);
        }

        // Corbel brackets at each end (carved support pieces)
        for (const corbel of [
            { x: start.x, dir: 1 },
            { x: end.x, dir: -1 },
        ]) {
            const cy = start.y + lintelHeight;
            trace(
                { x: corbel.x, y: cy },
                { x: corbel.x, y: cy + 12 },
                { x: corbel.x + corbel.dir * 12, y: cy },
            );
            ctx.fillStyle = wood.deep;
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Plaque mounted on the lintel
        const plaqueWidth = Math.min(96, length * 0.42);
        const plaqueHeight = 14;
        const plaqueY = start.y + lintelHeight + 2;
        ctx.fillStyle = wood.deep;
        ctx.fillRect(Math.round(mid.x - plaqueWidth / 2), Math.round(plaqueY), plaqueWidth, plaqueHeight);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(mid.x - plaqueWidth / 2), Math.round(plaqueY), plaqueWidth, plaqueHeight);
        // Plaque text
        ctx.fillStyle = wood.cut;
        ctx.font = '700 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('CLAUDEVILLE', Math.round(mid.x), Math.round(plaqueY + plaqueHeight / 2 + 1));

        // Hanging chain
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(mid.x), Math.round(plaqueY + plaqueHeight));
        ctx.lineTo(Math.round(mid.x), Math.round(plaqueY + plaqueHeight + 14));
        ctx.stroke();

        // Iron lantern body
        const lanternX = mid.x;
        const lanternY = plaqueY + plaqueHeight + 14;
        ctx.fillStyle = '#2c190d';
        ctx.fillRect(Math.round(lanternX - 7), Math.round(lanternY), 14, 16);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.round(lanternX - 7), Math.round(lanternY), 14, 16);
        // Lantern flame core
        ctx.fillStyle = wood.lantern;
        ctx.fillRect(Math.round(lanternX - 4), Math.round(lanternY + 3), 8, 10);
        // Lantern bars
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(lanternX), Math.round(lanternY));
        ctx.lineTo(Math.round(lanternX), Math.round(lanternY + 16));
        ctx.moveTo(Math.round(lanternX - 7), Math.round(lanternY + 8));
        ctx.lineTo(Math.round(lanternX + 7), Math.round(lanternY + 8));
        ctx.stroke();
        // Glow halo
        ctx.fillStyle = wood.glow;
        ctx.beginPath();
        ctx.ellipse(Math.round(lanternX), Math.round(lanternY + 8), 22, 12, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }
```

- [ ] **Step 3: Verify syntax**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: no output.

- [ ] **Step 4: Visual smoke**

Refresh the browser and pan to the gate. Confirm:
- Carved timber lintel between the two towers, not the rope-strapped beam.
- Two iron straps cross the lintel.
- A wood plaque hangs below it reading **CLAUDEVILLE**.
- An iron lantern hangs below the plaque with a warm glow halo.
- The corbel brackets meet the lintel at each tower.

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "$(cat <<'EOF'
gate: rewrite arch as carved timber lintel + plaque + iron lantern

Replaces the rope-strapped plank beam with a chunky timber lintel
(iron strapping, corbel brackets, edge highlight + shadow line), a
wood plaque reading CLAUDEVILLE, and a hanging iron lantern with a
warm glow halo. Doors land in a later step; this commit is purely
the arch geometry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Strip `_drawVillageGateThreshold` to a single tower-base shadow

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js:2625-2717` (existing threshold method)

Now that the road threads through the gate (Task 1) and the tower draws its own integrated foot shadow (Task 3), the threshold patch is redundant — its job is done. The existing method drew a quadrilateral, cobblestone ellipses, and a floating dark ellipse. We replace it with a no-op (or a faint integrated tinting strip if desired). The "random shape" disappears.

- [ ] **Step 1: Locate the existing method**

Run: `grep -n "_drawVillageGateThreshold(ctx, leftBase" claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: `2625:    _drawVillageGateThreshold(ctx, leftBase, rightBase) {`. The body runs through the matching closing `}`.

- [ ] **Step 2: Replace the body with a minimal no-op stub**

Keep the method (it's still called from `_drawVillageGatehouse`) but reduce it to nothing. Replace the entire method with:

```js
    _drawVillageGateThreshold(ctx, leftBase, rightBase) {
        // Threshold is now painted by the road tile renderer via the gate-avenue
        // route in townPlan.js. Tower foot shadows are drawn inside
        // _drawVillageGateTower. This method is intentionally a no-op; the
        // call site in _drawVillageGatehouse is kept for future hooks.
    }
```

- [ ] **Step 3: Verify syntax**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: no output.

- [ ] **Step 4: Visual smoke**

Refresh the browser and pan to the gate. The floating cobblestone-on-grass patch and the dark floating ellipse should be gone; the cobble road from Task 1 threads cleanly under the arch.

- [ ] **Step 5: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "$(cat <<'EOF'
gate: drop floating threshold patch — road now threads through

Reduces _drawVillageGateThreshold to a no-op stub. The cobble road
underneath the gate is now painted by the road tile renderer via
the new gate-avenue route. Tower foot shadows are integrated into
the tower drawer. Removes the disconnected grey shape that used to
float in front of the gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Verify and update `VILLAGE_GATE_BOUNDS`

**Files:**
- Modify: `claudeville/src/config/townPlan.js:23-29`

The new tower geometry is taller than the old one (stone+wood+roof = ~142px above base vs. ~106+42=148 before — close enough that bounds may already be fine, but we verify). Bounds are used for occlusion-split and culling.

- [ ] **Step 1: Read the current bounds**

Run: `sed -n '23,29p' claudeville/src/config/townPlan.js`

Expected:
```js
export const VILLAGE_GATE_BOUNDS = Object.freeze({
    left: -236,
    right: 236,
    top: -180,
    bottom: 96,
    splitY: -42,
});
```

- [ ] **Step 2: Compute new geometry top**

The new tower's highest point above the base is `hStone + hWood + roofH = 64 + 42 + 36 = 142` px. The roof apex sits at `y - 142` (where `y` is the tower base). The lintel adds a hanging lantern + glow halo extending below the lintel. The lintel sits ~110-130 px above the base; its halo extends downward and stays well within the bounds.

`top: -180` already accommodates `-142`. **Bounds do not need to change for height.**

If the visual smoke at zoom 1 / 2 / 3 in Task 3 showed any clipping at the top of the gate (e.g., roof being culled when only the gate is in view), bump `top` to `-200`. Otherwise leave as-is.

- [ ] **Step 3: Concrete clipping test, then decide**

In the browser at `http://localhost:4000`, zoom to level 3 (max) and pan so only the gate is in view (no other buildings around it). Confirm both tower roof apexes are fully visible — i.e., neither roof tip is cut off at the top of the canvas, AND when an agent approaches the gate from the north side, no part of either roof disappears as the static-prop occlusion split kicks in.

If both roofs render fully in all camera positions you can reach: skip the file edit. Leave bounds untouched.

If either roof tip is clipped or flickers as the camera moves: change `top: -180` to `top: -200` in `VILLAGE_GATE_BOUNDS`.

- [ ] **Step 4: Verify syntax (only if changed)**

Run: `node --check claudeville/src/config/townPlan.js`

Expected: no output.

- [ ] **Step 5: Commit (only if changed)**

```bash
git add claudeville/src/config/townPlan.js
git commit -m "$(cat <<'EOF'
townPlan: lift VILLAGE_GATE_BOUNDS top to fit new gate geometry

The hybrid tower's teal pitched roof reaches further up than the old
slab tower; bumping the bounds prevents the roof from being culled
when only the gate is in view at high zoom.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no change was needed, skip the commit and proceed to Task 7.

---

## Task 7: Add wall stone footing on gate-adjacent segments

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`
  - `_drawVillageWallSegment` signature gets a new `footingExtent` parameter.
  - `_buildVillageWallSprites` passes `footingExtent` for the gate-adjacent segments.
  - New helper method `_drawVillageWallStoneFooting` is added.

- [ ] **Step 1: Locate `_drawVillageWallSegment`**

Run: `grep -n "_drawVillageWallSegment(ctx" claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected lines around 2614, 2615, 2963, plus the corresponding gate-internal calls. The method definition is at line 2963.

- [ ] **Step 2: Add the new parameter to the method signature and call the footing helper**

In the method definition (currently `_drawVillageWallSegment(ctx, originX, originY, start, end, phase = 0)`), add a new parameter and call the helper just BEFORE the watchpost loop (the loop starting `for (let d = 32 + offset; d < length - 12; d += 72)`).

Change the signature line:

```js
    _drawVillageWallSegment(ctx, originX, originY, start, end, phase = 0, footingExtent = null) {
```

Then, find the watchpost loop (search for `for (let d = 32 + offset; d < length - 12; d += 72)`). Just BEFORE that loop, insert:

```js
        if (footingExtent) {
            this._drawVillageWallStoneFooting(ctx, x1, y1, x2, y2, ux, uy, nx, ny, length, footingExtent);
        }
```

This places footing UNDER the watchposts in draw order, which is correct: watchposts will sit on top of the footing visually.

- [ ] **Step 3: Add the new helper method `_drawVillageWallStoneFooting`**

Insert this method right after `_drawVillageWallSegment` ends:

```js
    _drawVillageWallStoneFooting(ctx, x1, y1, x2, y2, ux, uy, nx, ny, length, extent) {
        const stone = VILLAGE_STONE_PALETTE;
        // Footing is painted as a strip at the wall base on the side closest to the gate.
        const fullDist = Math.min(extent.distance ?? 30, length - 32); // stay clear of the last watchpost
        const ditherDist = extent.dither ?? 32;
        if (fullDist <= 0) return;

        // Determine which end of the segment is gate-adjacent.
        const fromEnd = extent.side === 'end';
        const startD = fromEnd ? length - fullDist : 0;
        const endD = fromEnd ? length : fullDist;
        const ditherStartD = fromEnd ? startD - ditherDist : endD;
        const ditherEndD = fromEnd ? startD : endD + ditherDist;

        const footingHeight = 18; // px, drops below the wall face
        const stoneY = (d) => ({
            x: x1 + ux * d,
            y: y1 + uy * d,
        });

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Full footing block
        const a = stoneY(startD);
        const b = stoneY(endD);
        ctx.fillStyle = stone.mid;
        ctx.beginPath();
        ctx.moveTo(Math.round(a.x), Math.round(a.y));
        ctx.lineTo(Math.round(b.x), Math.round(b.y));
        ctx.lineTo(Math.round(b.x), Math.round(b.y + footingHeight));
        ctx.lineTo(Math.round(a.x), Math.round(a.y + footingHeight));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Mortar line across the middle of the footing
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(a.x), Math.round(a.y + footingHeight / 2));
        ctx.lineTo(Math.round(b.x), Math.round(b.y + footingHeight / 2));
        ctx.stroke();

        // Vertical mortar joints (offset between courses)
        for (let d = startD + 16; d < endD; d += 24) {
            const p = stoneY(d);
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x), Math.round(p.y));
            ctx.lineTo(Math.round(p.x), Math.round(p.y + footingHeight / 2));
            ctx.stroke();
        }
        for (let d = startD + 28; d < endD; d += 24) {
            const p = stoneY(d);
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x), Math.round(p.y + footingHeight / 2));
            ctx.lineTo(Math.round(p.x), Math.round(p.y + footingHeight));
            ctx.stroke();
        }

        // Moss tufts on top edge of footing (only inside the full block)
        ctx.fillStyle = stone.moss;
        for (let d = startD + 8; d < endD; d += 28) {
            const p = stoneY(d);
            ctx.fillRect(Math.round(p.x - 4), Math.round(p.y - 2), 8, 3);
        }

        // Dither cubes — fade out over half a tile
        const cubeCount = 4;
        for (let i = 0; i < cubeCount; i++) {
            const t = (i + 1) / (cubeCount + 1);
            const d = fromEnd ? startD - t * ditherDist : endD + t * ditherDist;
            const size = Math.max(2, Math.round(footingHeight * (1 - t)));
            const p = stoneY(d);
            ctx.fillStyle = stone.mid;
            ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y + footingHeight - size), size, size);
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 0.8;
            ctx.strokeRect(Math.round(p.x - size / 2), Math.round(p.y + footingHeight - size), size, size);
        }

        ctx.restore();
    }
```

- [ ] **Step 4: Update `_buildVillageWallSprites` to pass `footingExtent`**

Locate the method:

```bash
grep -n "_buildVillageWallSprites()" claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Expected line: `2463`. Inside the inner loop (`for (let i = 0; i < route.points.length - 1; i++)`), find this `out.push(...)` block (currently around line 2480-2488 of `IsometricRenderer.js`):

```js
                out.push(new StaticPropSprite({
                    tileX: midTile.tileX,
                    tileY: midTile.tileY,
                    id: `village.wall.${route.id}.${i}`,
                    bounds: wallBounds,
                    splitForOcclusion: false,
                    sortY: Math.max(start.y, end.y) - 14,
                    drawFn: (ctx, x, y) => this._drawVillageWallSegment(ctx, x, y, localStart, localEnd, i),
                }));
```

Replace ONLY the `drawFn` line so the block becomes:

```js
                    drawFn: (ctx, x, y) => {
                        const isLastSegment = i === route.points.length - 2;
                        const isFirstSegment = i === 0;
                        let footingExtent = null;
                        if (route.id === 'west' && isLastSegment) {
                            footingExtent = { side: 'end', distance: 30, dither: 32 };
                        } else if (route.id === 'east' && isFirstSegment) {
                            footingExtent = { side: 'start', distance: 24, dither: 32 };
                        }
                        this._drawVillageWallSegment(ctx, x, y, localStart, localEnd, i, footingExtent);
                    },
```

The wall routes in `townPlan.js` are `west` (ends at 14.5,39.1, near gate) and `east` (starts at 23.5,39.1, near gate). Each route has 2 points → 1 segment. The "gate-adjacent end" is therefore:
- west: segment 0's END (i = route.points.length - 2 = 0).
- east: segment 0's START (i = 0).

- [ ] **Step 5: Verify syntax**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: no output.

- [ ] **Step 6: Visual smoke**

Refresh and pan to the gate. The wall on each side should now have a stone-footing strip at its gate-adjacent end (~half a tile wide), with mortar courses, a few moss tufts, and 3-4 dither cubes thinning out into pure wood palisade. The watchposts on the gate-adjacent end (if any) still sit on top of the footing.

- [ ] **Step 7: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "$(cat <<'EOF'
gate: stone-footing transition where walls meet the gate

Adds an optional footingExtent parameter to _drawVillageWallSegment
that paints a stone-footing strip at the gate-adjacent end of each
wall (a half-tile of mortared stone with a few moss tufts) and
fades out via dither cubes back into pure wood palisade. Wired up
in _buildVillageWallSprites so only the west-route end and the
east-route start get footing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Door state machine + render closed/open variants

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`
  - Add `gateDoorsOpen` boolean and `_gateDoorsOpenUntilMs` grace timer in the constructor block where `gateTransits` is initialized (around line 468).
  - Add `_updateGateDoorState()` method that runs each frame.
  - Add `_hasAgentNearGate()` helper.
  - Add `_drawVillageGateDoors(ctx, midX, archY, opening, mid, ux, uy)` method.
  - Call `_drawVillageGateDoors` from `_drawVillageGatehouse` after the arch but before any post-arch drawing, and call `_updateGateDoorState()` once per frame in the main render loop.

- [ ] **Step 1: Find the constructor area where `gateTransits` is initialized**

Run: `grep -n "gateTransits = new Map" claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: line 468.

- [ ] **Step 2: Add door state alongside gateTransits**

Just below `this.gateTransits = new Map();`, add:

```js
        this.gateDoorsOpen = false;
        this._gateDoorsOpenUntilMs = 0;
```

- [ ] **Step 3: Add `_updateGateDoorState` and `_hasAgentNearGate`**

Add these two methods inside the IsometricRenderer class, near the other gate-related methods (e.g., right after `_isGateTransit`):

```js
    _updateGateDoorState(now = performance.now()) {
        const wantOpen = this.gateTransits.size > 0 || this._hasAgentNearGate();
        if (wantOpen) {
            this.gateDoorsOpen = true;
            this._gateDoorsOpenUntilMs = now + 1500; // 1.5s grace timer
            return;
        }
        if (now < this._gateDoorsOpenUntilMs) {
            this.gateDoorsOpen = true;
            return;
        }
        this.gateDoorsOpen = false;
    }

    // Note: when motionScale=0, _beginAgentGateArrival short-circuits BEFORE
    // adding to gateTransits, so doors stay closed during reduced-motion
    // spawns. This mirrors the no-walk policy: if the agent doesn't visibly
    // walk in, the doors don't visibly open.
    _hasAgentNearGate() {
        const minTileX = 17;
        const maxTileX = 21;
        const minTileY = 38;
        const maxTileY = 39.5;
        for (const sprite of this.agentSprites.values()) {
            if (!sprite) continue;
            const tile = worldToTile(sprite.x, sprite.y);
            if (tile.tileX >= minTileX && tile.tileX <= maxTileX
                && tile.tileY >= minTileY && tile.tileY <= maxTileY) {
                return true;
            }
        }
        return false;
    }

```

- [ ] **Step 4: Wire `_updateGateDoorState` into the per-frame loop**

The per-frame entry is `renderWorldFrame(renderer, dt)` in `claudeville/src/presentation/character-mode/WorldFrameRenderer.js` (line 5). Locate the line `renderer._frameLightSources = renderer._computeFrameLightSources(atmosphere, perfNow);` (around line 26) and add a call to `_updateGateDoorState` immediately after it:

```js
    renderer._frameLightSources = renderer._computeFrameLightSources(atmosphere, perfNow);
    renderer._updateGateDoorState?.(perfNow);
    const viewport = renderer._screenViewport();
```

This places the door-state update before any draw happens — once per frame, regardless of whether the gate is visible. The optional-chaining `?.` keeps the call safe if the method ever moves.

Verify: `grep -n "_updateGateDoorState" claudeville/src/presentation/character-mode/WorldFrameRenderer.js` — expect 1 match.

- [ ] **Step 5: Add `_drawVillageGateDoors` method**

Insert this method after `_drawVillageGateArch`:

```js
    _drawVillageGateDoors(ctx, leftBase, rightBase) {
        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const dx = rightBase.x - leftBase.x;
        const dy = rightBase.y - leftBase.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        const lintelInset = 22;
        const lintelLevel = -110; // matches arch start.y offset
        const doorTop = lintelLevel + 26 + 2; // just under the lintel
        const doorBottom = 14; // a few pixels above the ground
        const doorHalfWidth = (length - 2 * lintelInset) / 2;
        const mid = { x: (leftBase.x + rightBase.x) / 2, y: (leftBase.y + rightBase.y) / 2 };

        const open = this.gateDoorsOpen;

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        if (open) {
            // Open state: leaves tucked flat against the inner jambs (slim vertical strips).
            const tucked = 6;
            const leafW = 7;
            for (const dir of [-1, 1]) {
                const baseX = mid.x + dir * (doorHalfWidth - leafW / 2 - tucked);
                ctx.fillStyle = '#2c190d';
                ctx.fillRect(Math.round(baseX - leafW / 2), Math.round(mid.y + doorTop), leafW, doorBottom + Math.abs(doorTop));
                ctx.strokeStyle = stone.outline;
                ctx.lineWidth = 1.2;
                ctx.strokeRect(Math.round(baseX - leafW / 2), Math.round(mid.y + doorTop), leafW, doorBottom + Math.abs(doorTop));
            }
            // Warm interior glow spilling onto the road
            ctx.fillStyle = wood.glow;
            ctx.beginPath();
            ctx.ellipse(Math.round(mid.x), Math.round(mid.y + doorBottom), doorHalfWidth + 8, 18, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 212, 142, 0.32)';
            ctx.beginPath();
            ctx.ellipse(Math.round(mid.x), Math.round(mid.y + doorBottom - 6), doorHalfWidth - 4, 10, 0, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Closed state: two leaves shut across the opening.
            const totalH = doorBottom - doorTop;
            for (const dir of [-1, 1]) {
                const leafX = mid.x + dir * (doorHalfWidth / 2);
                ctx.fillStyle = '#3f2412';
                ctx.fillRect(Math.round(leafX - doorHalfWidth / 2), Math.round(mid.y + doorTop),
                             doorHalfWidth, totalH);
                ctx.strokeStyle = stone.outline;
                ctx.lineWidth = 1.5;
                ctx.strokeRect(Math.round(leafX - doorHalfWidth / 2), Math.round(mid.y + doorTop),
                               doorHalfWidth, totalH);
                // Plank lines
                ctx.strokeStyle = '#2c190d';
                ctx.lineWidth = 0.6;
                for (let p = 0; p < 3; p++) {
                    const px = leafX - doorHalfWidth / 2 + (p + 1) * (doorHalfWidth / 4);
                    ctx.beginPath();
                    ctx.moveTo(Math.round(px), Math.round(mid.y + doorTop + 2));
                    ctx.lineTo(Math.round(px), Math.round(mid.y + doorBottom - 2));
                    ctx.stroke();
                }
            }
            // Iron bands (top and bottom)
            ctx.fillStyle = '#2c190d';
            ctx.fillRect(Math.round(mid.x - doorHalfWidth), Math.round(mid.y + doorTop + 12), doorHalfWidth * 2, 3);
            ctx.fillRect(Math.round(mid.x - doorHalfWidth), Math.round(mid.y + doorBottom - 14), doorHalfWidth * 2, 3);
            // Center seam
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(mid.x), Math.round(mid.y + doorTop));
            ctx.lineTo(Math.round(mid.x), Math.round(mid.y + doorBottom));
            ctx.stroke();
            // Ring handles
            for (const dir of [-1, 1]) {
                ctx.fillStyle = '#9aa0a6';
                ctx.beginPath();
                ctx.arc(Math.round(mid.x + dir * 4), Math.round(mid.y + (doorTop + doorBottom) / 2), 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        ctx.restore();
    }
```

- [ ] **Step 6: Call `_drawVillageGateDoors` from `_drawVillageGatehouse`**

Find `_drawVillageGatehouse` and add the door draw call. The current orchestrator (after Task 5) ends with `_drawVillageGateArch`. Add the door call AFTER the arch:

```js
    _drawVillageGatehouse(ctx, originX, originY) {
        this._updateGateDoorState();
        const centerTileX = VILLAGE_GATE.tileX;
        const tileY = VILLAGE_GATE.tileY;
        const halfWidth = VILLAGE_GATE.widthTiles / 2;
        const towerHalf = 3.18;
        const sideStubInset = 0.3;
        const center = this._tileToWorld(centerTileX, tileY);
        const localPoint = (tileX) => {
            const p = this._tileToWorld(tileX, tileY);
            return { x: p.x - center.x, y: p.y - center.y };
        };
        const leftEnd = localPoint(centerTileX - halfWidth);
        const leftInner = localPoint(centerTileX - towerHalf - sideStubInset);
        const rightInner = localPoint(centerTileX + towerHalf + sideStubInset);
        const rightEnd = localPoint(centerTileX + halfWidth);
        const leftTower = localPoint(centerTileX - towerHalf);
        const rightTower = localPoint(centerTileX + towerHalf);

        this._drawVillageWallSegment(ctx, originX, originY, leftEnd, leftInner, 0);
        this._drawVillageWallSegment(ctx, originX, originY, rightInner, rightEnd, 1);

        const leftBase = { x: originX + leftTower.x, y: originY + leftTower.y };
        const rightBase = { x: originX + rightTower.x, y: originY + rightTower.y };
        this._drawVillageGateThreshold(ctx, leftBase, rightBase);
        this._drawVillageGateTower(ctx, leftBase.x, leftBase.y, -1);
        this._drawVillageGateTower(ctx, rightBase.x, rightBase.y, 1);
        this._drawVillageGateArch(ctx, leftBase, rightBase);
        this._drawVillageGateDoors(ctx, leftBase, rightBase);
    }
```

- [ ] **Step 7: Verify syntax**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: no output.

- [ ] **Step 8: Visual smoke — closed default**

Refresh the browser, pan to the gate, confirm the doors render CLOSED by default (two dark wood leaves with iron bands and ring handles).

- [ ] **Step 9: Visual smoke — open on agent spawn**

Trigger an agent spawn (start a new Claude Code session, or use any provider that creates a new agent). Watch the gate: the doors should snap from closed to open as the agent appears at `VILLAGE_GATE.outside`, stay open as the agent walks through, and snap back to closed ~1.5s after the agent leaves the gate proximity tiles.

If doors don't open: the spawn might not trigger `_addAgentSprite` → `_beginAgentGateArrival`. Check that `gateTransits.size > 0` after spawn via the browser console. Add `console.log('gate transits', this.gateTransits.size)` inside `_updateGateDoorState` temporarily for diagnostics, then remove before commit.

- [ ] **Step 10: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "$(cat <<'EOF'
gate: binary closed/open doors driven by gateTransits + proximity

Adds gateDoorsOpen boolean computed each frame from
gateTransits.size > 0 OR any agent within the gate's threshold tiles
(17-21 x 38-39.5), with a 1.5s grace timer to hold open across the
gap between back-to-back transits. New _drawVillageGateDoors
renders either two iron-bound leaves shut across the arch (default)
or jamb-tucked leaves with a warm interior glow spill on the road.

No tweening. No new event subscriptions. Reuses the existing
_beginAgentGateArrival flow via gateTransits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Register gate lantern with `LightSourceRegistry`

**Files:**
- Modify: `claudeville/src/presentation/character-mode/IsometricRenderer.js`
  - Import `normalizeLightSource` from `./LightSourceRegistry.js`.
  - Add `_villageGateLightSources(lighting)` method.
  - Call it from `_computeFrameLightSources` so the gate lantern feeds into the existing ambient halo pass.

- [ ] **Step 1: Add the import**

Locate the existing import:

```bash
grep -n "lightSourceCacheKey } from './LightSourceRegistry.js'" claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Expected: line 36. Update the import to also pull `normalizeLightSource`:

```js
import { lightSourceCacheKey, normalizeLightSource } from './LightSourceRegistry.js';
```

- [ ] **Step 2: Add the `_villageGateLightSources` method**

Insert this method near `_computeFrameLightSources`:

```js
    _villageGateLightSources(lighting = null) {
        if (!VILLAGE_GATE) return [];
        const center = this._tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY);
        const lanternX = center.x;
        // The lantern hangs ~96 px above the threshold (matches the arch math:
        // lintel start.y is base.y - 110; lantern sits below the plaque at
        // base.y - 110 + 26 + 2 + 14 + 8 ≈ base.y - 60 from the lintel base).
        const lanternY = center.y - 96;
        const phaseBoost = Math.max(0.6, lighting?.lightBoost ?? 1);
        return [normalizeLightSource({
            id: 'gate.lantern',
            kind: 'point',
            x: lanternX,
            y: lanternY,
            radius: 84,
            color: '#ffd56a',
            intensity: phaseBoost,
            buildingType: 'village.gate',
        })];
    }
```

- [ ] **Step 3: Call it from `_computeFrameLightSources`**

Locate `_computeFrameLightSources`:

```bash
grep -n "_computeFrameLightSources" claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Expected: line ~5733. Inside the method, the `ambient` array is built from several sources. Add the gate lantern to it:

```js
    _computeFrameLightSources(atmosphere = null, now = performance.now()) {
        const lighting = atmosphere?.lighting || null;
        const building = this.buildingRenderer?.getLightSources?.(lighting) || [];
        const ambient = [
            ...building,
            ...relationshipLightSources({
                relationship: this.relationshipState,
                agentSprites: this.agentSprites,
                lighting,
            }),
            ...this._familiarMoteLightSources(lighting),
            ...(this.arrivalDeparture?.getLightSources?.({ now }) || []),
            ...this._villageGateLightSources(lighting),
        ];
        return { building, ambient };
    }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

Expected: no output.

- [ ] **Step 5: Visual smoke — night phase**

Refresh and (if there's a way to force a phase) cycle to night, or wait until atmosphere phase advances naturally. The gate lantern should contribute a warm halo visible under the arch, blending with the existing village ambient lighting at dusk/night.

If a phase-set helper exists (look for `setAtmospherePhase`, `forcePhase`, or similar in the renderer), use it: `window.atmosphereSet?.({ phase: 'night' })` or similar.

- [ ] **Step 6: Commit**

```bash
git add claudeville/src/presentation/character-mode/IsometricRenderer.js
git commit -m "$(cat <<'EOF'
gate: register lantern with LightSourceRegistry for night ambience

New _villageGateLightSources contributes a warm point light at the
arch lantern's apex (radius 84, color #ffd56a, intensity scaled by
the atmosphere lighting boost). Plumbed into _computeFrameLightSources
alongside the existing building / relationship / familiar / arrival
sources so the same ambient halo pass picks it up — same code path
as every other village lantern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Walk-test pathfinding and (optionally) tighten `VILLAGE_GATE.inside.tileX`

**Files:**
- Modify: `claudeville/src/config/townPlan.js:14-21` (only if the walk-test shows agents straying off the avenue).

- [ ] **Step 1: Spawn an agent and observe the path**

With `npm run dev` running, start a fresh agent session. Watch the agent appear at `VILLAGE_GATE.outside` (just south of the gate) and walk inward.

- [ ] **Step 2: Decide whether the path uses the avenue**

Acceptable: the agent reaches the gate-avenue (any tile on the route `[18, 27], [18, 32], [19, 36], [19, 39]`) within at most 1 full tile of grass-cutting from the spawn at `outside`. The agent should be visibly on cobble for the bulk of its inward walk.

Unacceptable: the agent cuts more than 1 tile of grass before joining the avenue, OR heads east toward `VILLAGE_GATE.inside` at tileX 20.5 and never touches the avenue.

If acceptable → skip Step 3 and Step 4.

- [ ] **Step 3: (Conditional) Tighten `VILLAGE_GATE.inside.tileX` to 19.0**

Edit `claudeville/src/config/townPlan.js`. Change:

```js
    inside: { tileX: 20.5, tileY: 37.85 },
```

to:

```js
    inside: { tileX: 19.0, tileY: 37.85 },
```

This places the post-spawn target directly on the gate-avenue (the avenue runs at tileX 18-19 inside the village).

- [ ] **Step 4: (Conditional) Verify and commit**

Run: `node --check claudeville/src/config/townPlan.js`

Run another spawn, confirm the agent walks the avenue.

Commit:

```bash
git add claudeville/src/config/townPlan.js
git commit -m "$(cat <<'EOF'
townPlan: align VILLAGE_GATE.inside with gate-avenue spine

Moves the post-spawn arrival target from tileX 20.5 (1.5 tiles east
of the gate center) to tileX 19.0 so spawning agents land on the
new gate-avenue and walk it inward instead of cutting east across
grass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no change was needed, skip the commit and proceed to the final validation.

---

## Final validation

- [ ] **Open `http://localhost:4000`** and pan to the south gate.

- [ ] **Visual confirm:**
  - [ ] Stone-foundation + wood-frame + teal-roof towers (Task 3).
  - [ ] Carved timber lintel with two iron straps, "CLAUDEVILLE" plaque, and a hanging iron lantern (Task 4).
  - [ ] No floating cobblestone-on-grass patch in front of the gate; cobble road threads under the arch (Tasks 1, 5).
  - [ ] Stone footing at each gate-adjacent wall end, fading via dither cubes into pure wood palisade (Task 7).
  - [ ] Doors closed by default; open when an agent is in the gate area (Task 8).
  - [ ] Warm light halo at the gate lantern visible at dusk/night (Task 9).
  - [ ] Watchposts on the south wall still rendered with their existing cadence; no overlap conflict with the footing.

- [ ] **`npm run sprites:validate`** — should pass unchanged (no PNG/manifest changes).

- [ ] **(Optional) Capture and diff a baseline** if your branch uses the visual-diff workflow:
  ```bash
  npm run sprites:capture-fresh
  npm run sprites:visual-diff
  ```

- [ ] **`git log --oneline -12`** — review the commit chain. Each commit should describe a single coherent change.

If any of the visual checks fails, the offending task's commit is the natural rollback point — revert that one commit and re-do the step.

---

## Self-review checklist (already run during plan authoring)

- **Spec coverage:** Every section of `agents/plans/village-gate-redesign-design.md` has a corresponding task. New road → Task 1. Stone palette → Task 2. Tower / arch / threshold rewrites → Tasks 3, 4, 5. Bounds check → Task 6. Wall footing → Task 7. Doors (binary state, triggers, grace timer) → Task 8. Lantern + LightSourceRegistry → Task 9. Pathfinder walk-test + optional inside.tileX → Task 10.
- **Placeholder scan:** No "TBD", no "implement later", no "similar to Task N", no "add appropriate error handling". Every code-bearing step contains the actual code.
- **Type consistency:** `VILLAGE_STONE_PALETTE` keys (`light/mid/shadow/mortar/moss/outline`) are referenced consistently across Tasks 3, 4, 7. `gateDoorsOpen`, `_gateDoorsOpenUntilMs`, `_updateGateDoorState`, `_hasAgentNearGate`, `_drawVillageGateDoors`, `_villageGateLightSources` all named identically across the tasks they appear in. `footingExtent = { side, distance, dither }` shape consistent between Task 7 Step 2 and Step 4.
