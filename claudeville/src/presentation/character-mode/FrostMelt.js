// BI-5 — frost mornings that melt from the sunny side.
//
// GroundState gives the night's rime in quarters (`frost` 4 → 0) on the real
// sun's clock. The whole rime (4) is GroundBake's grass-tip frost; at 3 and 2
// the open lawn's rime shrinks patch by patch on a world-locked order, at 1
// only the shade and its edges keep it, and through every step it holds where
// the ground lies in shade:
//
//   cast   the RakingLight ground casts exactly as both backends draw them
//          at the bake (`structureCast` per building, `treeCast` per tree,
//          for the frame's `castLightingFor` bucket): read from the cached
//          stamps, never re-derived, so the frost lies under the shadows the
//          viewer sees. The bake holds for its quarter while the sun moves
//          on, so the rime trails the shortening shadows as real frost does.
//   wall   the bake's contact AO hard against buildings, the village wall's
//          runs and props, which no cast reaches.
//   near   a coarse shelter field (the shaded share of each SHELTER_CELL
//          block, box-blurred), so the open lawn melts first far from any
//          shade and last at the shadows' edges: the sunny side goes first.
//
// Bake-time only (at most three shade fields per frosty morning, at the
// quarter steps 3, 2 and 1); nothing per frame.

import { getBuildingVisual } from './BuildingVisualRegistry.js';
import { buildingCenterToWorld } from './Projection.js';
import { castLightingFor, structureCast, treeCast } from './RakingLight.js';

export const FROST_SHADE = Object.freeze({ OPEN: 0, WALL: 1, CAST: 2 });
// A cast course this dense or denser is shade (its cores and trails).
const CAST_SHADE_ALPHA = 64;
// Contact AO (0–255) from which the ground counts as the lee of a wall.
const WALL_SHADE_AO = 96;
// Shelter blocks (texels) and their blur reach (blocks).
const SHELTER_CELL = 8;
// The open-lawn melt order's threshold per quarter: rime holds where the
// order is below it, about 70 % of the open lawn at 3 and 35 % at 2 (the
// order's 70th and 35th percentiles), none at 1 beyond the shade's edges.
const OPEN_KEEP = Object.freeze([0, 0, 0.44, 0.59, 1]);
// How strongly nearby shade holds the open lawn's rime back.
const SHELTER_PULL = 0.42;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * The shade field over the ground bake's texel grid (`cols` × `rows`, texels
 * `texelW` world px wide from world `x0`, `y0`): FROST_SHADE per texel, and
 * `shelter`, 0–1 per texel's block (how much shade stands near it).
 */
export function frostShadeField(renderer, { cols, rows, x0, y0, texelW = 2, aoBuf = null }) {
    const shade = new Uint8Array(cols * rows);
    if (aoBuf) for (let i = 0; i < shade.length; i++) if (aoBuf[i] >= WALL_SHADE_AO) shade[i] = FROST_SHADE.WALL;
    const cast = castLightingFor(renderer?._lastAtmosphere);
    const alphas = new Map();
    const stamp = (baked, left, top) => {
        const canvas = baked?.canvas;
        if (!canvas?.width || !canvas.height) return;
        let alpha = alphas.get(canvas);
        if (!alpha) {
            const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
            alpha = new Uint8Array(canvas.width * canvas.height);
            for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
            alphas.set(canvas, alpha);
        }
        const { width, height } = canvas;
        for (let j = 0; j < height; j++) {
            const row = top + j - y0;
            if (row < 0 || row >= rows) continue;
            for (let i = 0; i < width; i++) {
                if (alpha[j * width + i] < CAST_SHADE_ALPHA) continue;
                const col = Math.floor((left + i - x0) / texelW);
                if (col >= 0 && col < cols) shade[row * cols + col] = FROST_SHADE.CAST;
            }
        }
    };
    // The building casts, placed as BuildingSprite.drawShadows and the
    // resident `buildingShadowRecords` place them.
    for (const building of renderer?.world?.buildings?.values?.() || []) {
        const grounding = getBuildingVisual(building?.type)?.grounding;
        const contact = grounding?.contact;
        if (grounding?.shadow === 'none' || !(contact?.width > 0) || !(contact?.depth > 0)) continue;
        const baked = structureCast(building.type, grounding, contact, cast);
        if (!baked) continue;
        const centre = buildingCenterToWorld(building);
        stamp(baked, Math.round(centre.x + finite(contact.offsetX) + baked.offsetX), Math.round(centre.y + finite(contact.offsetY) + baked.offsetY));
    }
    // The tree casts, placed as drawTreeCasts and `treeCastRecords` place them.
    for (const tree of renderer?.treePropSprites || []) {
        const bounds = tree?.bounds || {};
        const baked = treeCast(finite(bounds.right) - finite(bounds.left), -finite(bounds.top), cast);
        if (!baked) continue;
        stamp(baked, Math.round(finite(tree.x)) + baked.offsetX, Math.round(finite(tree.y)) + baked.offsetY);
    }
    return { shade, shelter: shelterField(shade, cols, rows), cols, rows };
}

// The shaded share of each SHELTER_CELL block, blurred over its neighbours.
function shelterField(shade, cols, rows) {
    const bw = Math.ceil(cols / SHELTER_CELL);
    const bh = Math.ceil(rows / SHELTER_CELL);
    const share = new Float32Array(bw * bh);
    for (let row = 0; row < rows; row++) {
        const by = Math.floor(row / SHELTER_CELL) * bw;
        for (let col = 0; col < cols; col++) if (shade[row * cols + col]) share[by + Math.floor(col / SHELTER_CELL)] += 1;
    }
    const full = SHELTER_CELL * SHELTER_CELL;
    for (let i = 0; i < share.length; i++) share[i] = Math.min(1, share[i] / full * 3);
    const blurred = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
            let sum = 0;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= bh) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= bw) continue;
                    sum += share[yy * bw + xx];
                    n++;
                }
            }
            blurred[y * bw + x] = sum / n;
        }
    }
    return { blocks: blurred, bw };
}

/**
 * Whether a rimed grass texel keeps its frost at `quarter` (1–3): always in
 * a cast or a wall's lee; on the open lawn while its world-locked melt
 * `order` (0–1), drawn down by the shelter near it, stays under the
 * quarter's threshold.
 */
export function frostHolds(quarter, field, col, row, order) {
    if (quarter >= 4) return true;
    if (quarter <= 0 || !field) return false;
    const index = row * field.cols + col;
    if (field.shade[index]) return true;
    const { blocks, bw } = field.shelter;
    const near = blocks[Math.floor(row / SHELTER_CELL) * bw + Math.floor(col / SHELTER_CELL)] || 0;
    return order - SHELTER_PULL * near < OPEN_KEEP[quarter];
}
