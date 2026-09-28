import { ART_RAMPS } from '../../config/artPalette.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { StaticPropSprite } from './StaticPropDrawables.js';
import { canvasMapPixelCount, releaseCanvasMap } from './CanvasBudget.js';
import { baseWindX, windAt } from './Wind.js';
import { snowBucketOf } from './GroundState.js';

// Trees: one shared image per (sprite, canopy variant, season, lean frame),
// drawn at 1× on one pixel grid (contract C3) by both backends.
//
// Canopy (plan items 5.1 and 5.3 of
// agents/plans/claudeville-opus55-xhigh-visual-plan.md): canopy pixels are
// remapped by luminance rank onto a C1 ramp from `ART_RAMPS` — variant 1 onto
// `foliageDeep`, variant 2 onto `foliageSun`, autumn oaks onto `canopyRusset`
// / `canopyOchre` (variant 0 turns only its upper leaf clumps), autumn willows
// onto `willowGold`, `blossom` clusters on spring's sunlit oaks. Partial
// recolours pick whole leaf clumps (`canopyClumps`, a watershed of the
// canopy's luminance), so a colour boundary runs along a shadow crease. Variant
// 0 keeps the authored art; pines keep their colours through the seasons.
//
// Woodland scale and winter states (plan 5.5): `size: 'tall'` records (placed
// only inside TREE_CLUSTERS woodlands, SceneryEngine `_promoteWoodlandTrees`)
// draw the tall sheets. In winter every deciduous sheet swaps to its authored
// bare sheet (`bare`); a pine carries snow only while the village's own snow
// lies on the ground (`GroundState` snowCover, M9), never from the calendar,
// stepped with the snow bucket: quarters 1–3 lay the top 1–3 rows of each
// snow cap of its snow-laden sheet (`snow`) onto the leafy pine
// (`dustPineCanopy`), a full cover draws the laden sheet itself. Bare and snow
// sheets carry no canopy remap (`canopy: false`), so one image per state
// serves every variant.
//
// Lean frames (plan 0.7): per canopy image, frames by whole-texel row shear
// with the trunk planted (`lean` = A texels at the crown top, `planted` = the
// unmoved bottom share), padded LEAN_PAD px on both sides, each shear step
// bridged so the outline stays continuous (`leanFrameImage`). `swayFrame` picks a
// tree's frame from the one wind (`Wind.js`) on the one motion clock: upright
// below a breeze, the {0, +1, 0, −1} cycle only while a gust crosses the tree
// in a breeze, a downwind rest lean every tree cycles around in a real wind,
// quantized in 300–600 ms per-tree holds; reduced motion holds the rest lean.
// The Canvas path and the resident GPU records draw the same frame images
// (`tree:${sprite}|${variant}|${season}|${frame}` textures), so trunks never
// slide and nothing is cached per tree.

// The PNGs are plinth-free since the foliage pass
// (`scripts/sprites/foliage-pass.mjs`); `height` is the trunk-base row + 1, so
// the crop drops the empty rows below the roots and the anchor sits on the
// lowest root pixel.
export const TREE_SPRITES = Object.freeze({
    'oak.large': Object.freeze({ id: 'veg.tree.oak.large', width: 64, height: 51, lean: 1, planted: 0.3, bare: 'oak.large.bare' }),
    'oak.small': Object.freeze({ id: 'veg.tree.oak.small', width: 32, height: 28, lean: 1, planted: 0.3, bare: 'oak.small.bare' }),
    // A pine bends higher up: at 0.3 its crown shears off the trunk top.
    'pine.large': Object.freeze({ id: 'veg.tree.pine.large', width: 64, height: 52, lean: 1, planted: 0.4, snow: 'pine.large.snow' }),
    'willow.large': Object.freeze({ id: 'veg.tree.willow.large', width: 64, height: 53, lean: 2, planted: 0.3, bare: 'willow.large.bare' }),
    'willow.small': Object.freeze({ id: 'veg.tree.willow.small', width: 32, height: 27, lean: 2, planted: 0.3, bare: 'willow.small.bare' }),
    // Woodland sheets (plan 5.5), about 1.4–2.2× the villager-scale trees.
    // `crown`: the leaf mass's screen box around the anchor (half width, and
    // its lowest row above the trunk base), the occluder SceneryEngine keeps
    // clear of every walkable tile behind a tall tree.
    'oak.tall': Object.freeze({ id: 'veg.tree.oak.tall', width: 112, height: 112, lean: 2, planted: 0.3, bare: 'oak.tall.bare', crown: Object.freeze({ halfWidth: 46, bottom: 35 }) }),
    'pine.tall': Object.freeze({ id: 'veg.tree.pine.tall', width: 64, height: 102, lean: 1, planted: 0.4, snow: 'pine.tall.snow', crown: Object.freeze({ halfWidth: 18, bottom: 31 }) }),
    'willow.tall': Object.freeze({ id: 'veg.tree.willow.tall', width: 88, height: 107, lean: 2, planted: 0.3, bare: 'willow.tall.bare', crown: Object.freeze({ halfWidth: 32, bottom: 2 }) }),
    // Winter states: the same canvas and trunk base as their leafy sheet.
    'oak.large.bare': Object.freeze({ id: 'veg.tree.oak.large.bare', width: 64, height: 51, lean: 1, planted: 0.3, canopy: false }),
    'oak.small.bare': Object.freeze({ id: 'veg.tree.oak.small.bare', width: 32, height: 28, lean: 1, planted: 0.3, canopy: false }),
    'pine.large.snow': Object.freeze({ id: 'veg.tree.pine.large.snow', width: 64, height: 52, lean: 1, planted: 0.4, canopy: false }),
    'willow.large.bare': Object.freeze({ id: 'veg.tree.willow.large.bare', width: 64, height: 53, lean: 2, planted: 0.3, canopy: false }),
    'willow.small.bare': Object.freeze({ id: 'veg.tree.willow.small.bare', width: 32, height: 27, lean: 2, planted: 0.3, canopy: false }),
    'oak.tall.bare': Object.freeze({ id: 'veg.tree.oak.tall.bare', width: 112, height: 112, lean: 2, planted: 0.3, canopy: false }),
    'pine.tall.snow': Object.freeze({ id: 'veg.tree.pine.tall.snow', width: 64, height: 102, lean: 1, planted: 0.4, canopy: false }),
    'willow.tall.bare': Object.freeze({ id: 'veg.tree.willow.tall.bare', width: 88, height: 107, lean: 2, planted: 0.3, canopy: false }),
});
const TREE_SPECIES = Object.freeze(['oak', 'pine', 'willow']);
export const CANOPY_VARIANTS = Object.freeze([0, 1, 2]);
export const CANOPY_SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
const LEAN_PAD = 2;

// Resolve a tree record to its leafy sprite key. Pines have no small sheet, so
// a small pine draws the large one.
function treeSpriteKey(tree) {
    const species = TREE_SPECIES.includes(tree?.species) ? tree.species : 'oak';
    const size = tree?.size === 'tall' ? 'tall' : tree?.size === 'small' && species !== 'pine' ? 'small' : 'large';
    return `${species}.${size}`;
}

// The sheet a leafy sprite shows now: bare in winter (deciduous), snow-laden
// while snow lies on the ground (pines, `snowBucket` > 0), else itself.
export function treeStateKey(spriteKey, season, snowBucket) {
    const sprite = TREE_SPRITES[spriteKey];
    if (season === 'winter' && sprite?.bare) return sprite.bare;
    if (snowBucket > 0 && sprite?.snow) return sprite.snow;
    return spriteKey;
}

function canopyVariantOf(tree) {
    const variant = Number(tree?.variant);
    return CANOPY_VARIANTS.includes(variant) ? variant : 0;
}

// ---- canopy remap ------------------------------------------------------------

const hexRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const lumOf = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

// A ramp prepared for rank remaps, optionally cut to its darkest `stops`.
function prepareRamp(key, stops = ART_RAMPS[key].length) {
    const rgb = ART_RAMPS[key].slice(0, stops).map(hexRgb);
    const lum = rgb.map(([r, g, b]) => lumOf(r, g, b));
    const lo = lum[0];
    const span = lum[lum.length - 1] - lo || 1;
    return Object.freeze({ key, rgb, norm: lum.map((l) => (l - lo) / span) });
}

const _preparedRamps = new Map();
function canopyRamp(key, stops) {
    const id = `${key}:${stops || 0}`;
    let ramp = _preparedRamps.get(id);
    if (!ramp) {
        ramp = prepareRamp(key, stops || undefined);
        _preparedRamps.set(id, ramp);
    }
    return ramp;
}

// The stop whose normalized luminance is nearest `t` (0 dark .. 1 light), so
// the authored value order survives and the ramp's own spacing is kept.
function rankStop(ramp, t) {
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < ramp.norm.length; j++) {
        const d = Math.abs(ramp.norm[j] - t);
        if (d < bestD) { bestD = d; best = j; }
    }
    return best;
}

// A canopy pixel: opaque, green-dominant, above the outline value, and above
// the root rows (some sheets keep a dark ground speck at the roots).
export function isCanopyPixel(data, index, y, height) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    return data[index + 3] > 200 && y < height - 2 && g > r + 4 && g >= b - 6 && lumOf(r, g, b) >= 20;
}

const plan = (fields) => Object.freeze({ ramp: null, stops: 0, shift: 0, turning: null, blossom: false, ...fields });
const PLAN_DEEP = plan({ ramp: 'foliageDeep' });
const PLAN_SUN = plan({ ramp: 'foliageSun' });
// A sunlit pine stops short of the two yellow highlight stops: conifers stay
// green, never straw-tipped.
const PLAN_PINE_SUN = plan({ ramp: 'foliageSun', stops: 6 });
const PLAN_SUN_BLOSSOM = plan({ ramp: 'foliageSun', blossom: true });
const PLAN_RUSSET = plan({ ramp: 'canopyRusset' });
const PLAN_OCHRE = plan({ ramp: 'canopyOchre' });
const PLAN_TURNING = plan({ turning: 'canopyOchre' });
const PLAN_WILLOW_GOLD = plan({ ramp: 'willowGold' });
const PLAN_WILLOW_GOLD_LIT = plan({ ramp: 'willowGold', shift: 1 });

// How a canopy is recoloured; null keeps the authored pixels. Autumn oaks turn
// russet (deep), ochre (sunlit) or only at the crown (authored); willows go
// gold except the deep ones, which hold their green; sunlit oaks blossom in
// spring; pines never change with the season.
export function canopyPlan(species, variant, season) {
    if (species === 'pine') return variant === 1 ? PLAN_DEEP : variant === 2 ? PLAN_PINE_SUN : null;
    if (season === 'autumn') {
        if (species === 'willow') return variant === 1 ? PLAN_DEEP : variant === 2 ? PLAN_WILLOW_GOLD_LIT : PLAN_WILLOW_GOLD;
        return variant === 1 ? PLAN_RUSSET : variant === 2 ? PLAN_OCHRE : PLAN_TURNING;
    }
    if (variant === 1) return PLAN_DEEP;
    if (variant === 2) return species === 'oak' && season === 'spring' ? PLAN_SUN_BLOSSOM : PLAN_SUN;
    return null;
}

function pixelHash(x, y, salt) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Crown clumps: a watershed of the canopy's smoothed luminance. Each lit leaf
// puff floods down from its highlight until it meets a neighbour in a shadow
// crease; puffs whose crease is shallower than CLUMP_PERSIST (luminance) merge.
// Seasonal recolours that act on part of a crown pick whole clumps, so a
// boundary always runs along a crease, never through a puff or down a column.
const CLUMP_PERSIST = 14;
const CLUMP_MIN_PX = 16;

/**
 * Labels the canopy pixels `indices` (RGBA byte offsets) of one image by leaf
 * clump. Returns `{ label, clumps }`: `label` maps pixel index -> clump id,
 * `clumps[id]` = `{ x, y, size }` (x, y = the centroid).
 */
export function canopyClumps(data, width, height, indices) {
    const n = width * height;
    const lum = new Float32Array(n).fill(-1);
    for (const i of indices) lum[i >> 2] = lumOf(data[i], data[i + 1], data[i + 2]);
    const smooth = new Float32Array(n);
    const pixels = indices.map((i) => i >> 2);
    for (const p of pixels) {
        const x = p % width;
        const y = (p - x) / width;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const l = lum[ny * width + nx];
                if (l >= 0) { sum += l; count++; }
            }
        }
        smooth[p] = sum / count;
    }
    pixels.sort((a, b) => smooth[b] - smooth[a] || a - b);
    const parent = new Int32Array(n).fill(-1);
    const peak = new Float32Array(n);
    const find = (p) => {
        while (parent[p] !== p) { parent[p] = parent[parent[p]]; p = parent[p]; }
        return p;
    };
    const roots = [];
    for (const p of pixels) {
        const x = p % width;
        roots.length = 0;
        if (x > 0 && parent[p - 1] >= 0) roots.push(find(p - 1));
        if (x < width - 1 && parent[p + 1] >= 0) roots.push(find(p + 1));
        if (p >= width && parent[p - width] >= 0) roots.push(find(p - width));
        if (p < n - width && parent[p + width] >= 0) roots.push(find(p + width));
        if (!roots.length) { parent[p] = p; peak[p] = smooth[p]; continue; }
        let best = roots[0];
        for (const r of roots) if (peak[r] > peak[best]) best = r;
        parent[p] = best;
        for (const r of roots) {
            if (r !== best && find(r) !== best && peak[r] - smooth[p] < CLUMP_PERSIST) parent[r] = best;
        }
    }
    // Specks below CLUMP_MIN_PX join the neighbouring clump they touch most.
    const size = new Map();
    for (const p of pixels) { const r = find(p); size.set(r, (size.get(r) || 0) + 1); }
    for (const p of pixels) {
        const r = find(p);
        if (size.get(r) >= CLUMP_MIN_PX) continue;
        const x = p % width;
        for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
            if (q < 0 || q >= n || parent[q] < 0) continue;
            const s = find(q);
            if (s !== r && size.get(s) >= CLUMP_MIN_PX) {
                parent[r] = s;
                size.set(s, size.get(s) + size.get(r));
                size.set(r, Infinity);
                break;
            }
        }
    }
    const label = new Map();
    const ids = new Map();
    const clumps = [];
    for (const p of pixels) {
        const r = find(p);
        let id = ids.get(r);
        if (id === undefined) {
            id = clumps.length;
            ids.set(r, id);
            clumps.push({ x: 0, y: 0, size: 0 });
        }
        const c = clumps[id];
        c.x += p % width;
        c.y += Math.floor(p / width);
        c.size++;
        label.set(p, id);
    }
    for (const c of clumps) { c.x /= c.size; c.y /= c.size; }
    return { label, clumps };
}

// The turning crown: clumps whose centre sits above a line 35–65 % down the
// canopy (hashed per clump) take the turning ramp, so the crown turns in
// whole leaf clumps from the top.
const turnedClump = (clump, top, bottom) => (clump.y - top) / Math.max(1, bottom - top)
    < 0.35 + 0.3 * pixelHash(Math.round(clump.x), Math.round(clump.y), 5);
// Blossom: the lit pixels (rank from BLOSSOM_FROM) of a sunlit oak flower in
// hashed 2×2 cells, so petals sit in small clusters on the lit side of the
// puffs; about half the clumps are in full bloom (cell share BLOSSOM_FULL),
// the rest open (BLOSSOM_OPEN), so the crown flowers unevenly, by puff.
const BLOSSOM_FROM = 0.3;
const BLOSSOM_FULL = 0.8;
const BLOSSOM_OPEN = 0.35;
const BLOSSOM_CLUMPS = 0.55;
// Blossom cells are bricked (odd cell rows shift a pixel) so clusters never
// line up into a grid.
const blossomCell = (x, y) => pixelHash((x + ((y >> 1) & 1)) >> 1, y >> 1, 7);
const ISLET_PX = 24;

// Per-pixel turning mask (1 turned, 0 kept, 255 not canopy) from the clump
// decisions; any 4-connected islet under ISLET_PX (a puff fragment the
// watershed split off) takes its surround's decision, so no green fleck sits
// in a turned puff and no gold drip in a green one.
function turningMask(width, height, indices, label, turned) {
    const mask = new Uint8Array(width * height).fill(255);
    for (const i of indices) mask[i >> 2] = turned[label.get(i >> 2)] ? 1 : 0;
    const seen = new Uint8Array(width * height);
    const stack = [];
    const component = [];
    for (const i of indices) {
        const start = i >> 2;
        if (seen[start]) continue;
        const value = mask[start];
        component.length = 0;
        stack.push(start);
        seen[start] = 1;
        while (stack.length) {
            const p = stack.pop();
            component.push(p);
            const x = p % width;
            for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
                if (q < 0 || q >= mask.length || seen[q] || mask[q] !== value) continue;
                seen[q] = 1;
                stack.push(q);
            }
        }
        if (component.length < ISLET_PX) for (const p of component) mask[p] = 1 - value;
    }
    return mask;
}

/**
 * Recolours the canopy of one RGBA tree image in place (pure; Node-safe for
 * `art:analyze`). Every pixel it writes is a stop of the plan's ramps.
 * Returns the number of canopy pixels.
 */
export function recolorCanopy(data, width, height, canopy) {
    if (!canopy) return 0;
    const indices = [];
    let lo = Infinity;
    let hi = -Infinity;
    let top = height;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (!isCanopyPixel(data, i, y, height)) continue;
            indices.push(i);
            const l = lumOf(data[i], data[i + 1], data[i + 2]);
            if (l < lo) lo = l;
            if (l > hi) hi = l;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    const span = hi - lo || 1;
    const ramp = canopy.ramp ? canopyRamp(canopy.ramp, canopy.stops) : null;
    const turning = canopy.turning ? canopyRamp(canopy.turning) : null;
    const blossom = canopy.blossom ? canopyRamp('blossom') : null;
    const clumps = turning || blossom ? canopyClumps(data, width, height, indices) : null;
    const turned = turning ? turningMask(width, height, indices, clumps.label, clumps.clumps.map((c) => turnedClump(c, top, bottom))) : null;
    const flowering = blossom ? clumps.clumps.map((c) => (pixelHash(Math.round(c.x), Math.round(c.y), 8) < BLOSSOM_CLUMPS ? BLOSSOM_FULL : BLOSSOM_OPEN)) : null;
    const ranks = indices.map((i) => (lumOf(data[i], data[i + 1], data[i + 2]) - lo) / span);
    const set = (i, rgb) => { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; };
    indices.forEach((i, k) => {
        const p = i >> 2;
        const x = p % width;
        const y = (p - x) / width;
        const t = ranks[k];
        if (ramp) {
            const j = Math.max(0, Math.min(ramp.rgb.length - 1, rankStop(ramp, t) + canopy.shift));
            set(i, ramp.rgb[j]);
        }
        if (turned && turned[p] === 1) set(i, turning.rgb[rankStop(turning, t)]);
        if (flowering && t >= BLOSSOM_FROM && blossomCell(x, y) < flowering[clumps.label.get(p)]) {
            set(i, blossom.rgb[rankStop(blossom, (t - BLOSSOM_FROM) / (1 - BLOSSOM_FROM))]);
        }
    });
    return indices.length;
}

// A snow pixel of a laden sheet: light, near-neutral, never warmer than blue.
function isSnowPixel(data, i) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    return data[i + 3] > 200 && Math.min(r, g, b) >= 150 && Math.max(r, g, b) - Math.min(r, g, b) <= 32 && b >= r;
}

/**
 * Lays a partial snow load on a leafy pine in place (pure; Node-safe): the top
 * `depth` rows of every snow cap in the same-canvas `laden` sheet, down each
 * column, wherever the pine is opaque. Snow thickens from its upper edge as
 * the snow bucket steps 1 → 3, and every written pixel is an authored snow
 * pixel.
 */
export function dustPineCanopy(data, laden, width, height, depth) {
    for (let x = 0; x < width; x++) {
        let run = 0;
        for (let y = 0; y < height; y++) {
            const i = (y * width + x) * 4;
            run = isSnowPixel(laden, i) ? run + 1 : 0;
            if (run === 0 || run > depth || data[i + 3] === 0) continue;
            data[i] = laden[i]; data[i + 1] = laden[i + 1]; data[i + 2] = laden[i + 2]; data[i + 3] = laden[i + 3];
        }
    }
}

// ---- lean frames -------------------------------------------------------------

// Whole-texel shear of row `y` for a sprite whose opaque rows span [top, base]:
// k = max(0, (f − planted)/(1 − planted)), dx = round(A·k²(3 − 2k)), symmetric
// in the sign of A.
function leanShift(y, top, base, amp, planted) {
    if (!amp) return 0;
    const f = (base - y) / Math.max(1, base - top);
    const k = Math.min(1, Math.max(0, (f - planted) / (1 - planted)));
    return Math.sign(amp) * Math.round(Math.abs(amp) * k * k * (3 - 2 * k));
}

/**
 * The lean frame `amp` of one RGBA tree image (pure; Node-safe): rows sheared
 * by `leanShift` into an image LEAN_PAD px wider on both sides. A shear step
 * slides a row off the row it stood on; wherever that opens sky between two
 * pixels that touched in the source (the silhouette edge, the 1-px outline, a
 * hanging strand), the row that moved away is stretched back by the step with
 * a copy of its own neighbouring pixel. Every edge then turns the step as a
 * pixel-art corner, never a notch, and no colour is invented.
 */
export function leanFrameImage(data, width, height, amp, planted) {
    let top = height;
    let base = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] === 0) continue;
            if (y < top) top = y;
            base = y;
            break;
        }
    }
    const out = width + LEAN_PAD * 2;
    const pixels = new Uint8ClampedArray(out * height * 4);
    const shift = new Int32Array(height);
    for (let y = 0; y < height; y++) {
        shift[y] = LEAN_PAD + leanShift(y, top, base, amp, planted);
        pixels.set(data.subarray(y * width * 4, (y + 1) * width * 4), (y * out + shift[y]) * 4);
    }
    const opaque = (x, y) => x >= 0 && x < out && pixels[(y * out + x) * 4 + 3] !== 0;
    const wasOpaque = (sx, y) => sx >= 0 && sx < width && data[(y * width + sx) * 4 + 3] !== 0;
    const bridges = [];
    for (let y = top; y < base; y++) {
        const step = shift[y] - shift[y + 1];
        if (!step) continue;
        // [row that opened, the row it stood against, its drift from it]
        for (const [row, other, drift] of [[y, y + 1, step], [y + 1, y, -step]]) {
            for (let x = 0; x < out; x++) {
                if (opaque(x, row) || !opaque(x, other)) continue;
                if (wasOpaque(x - shift[other], row)) bridges.push(x, row, x + drift);
            }
        }
    }
    for (let k = 0; k < bridges.length; k += 3) {
        const from = (bridges[k + 1] * out + bridges[k + 2]) * 4;
        pixels.copyWithin((bridges[k + 1] * out + bridges[k]) * 4, from, from + 4);
    }
    return { width: out, height, data: pixels };
}

// ---- sway --------------------------------------------------------------------

const SWAY_CYCLE = Object.freeze([0, 1, 0, -1]);
// Below a breeze trees stand upright; from a real wind they rest leaning
// downwind and may use their full amplitude (below it, one texel).
const SWAY_CALM = 0.15;
const SWAY_WINDY = 0.6;
const SWAY_HOLD_MS = 300;
const SWAY_HOLD_SPAN_MS = 300;

function swaySeed(tree) {
    const n = Math.sin((Number(tree?.tileX) || 0) * 12.9898 + (Number(tree?.tileY) || 0) * 78.233
        + Math.max(0, TREE_SPECIES.indexOf(tree?.species)) * 7.131) * 43758.5453;
    return n - Math.floor(n);
}

// A tree in the depth pass. Its cached image is the shared lean frame of the
// moment, so the Canvas fast path, the painted path and the GPU record builder
// (`recordForProp`) all draw the same pixels, and back/front halves of one
// tree always take the same frame.
class TreePropSprite extends StaticPropSprite {
    constructor(foliage, tree) {
        super({
            tileX: tree.tileX,
            tileY: tree.tileY,
            id: 'fantasy.tree',
            bounds: foliage.fantasyTreePropBounds(tree),
            splitForOcclusion: true,
            drawFn: null,
        });
        this.foliage = foliage;
        this.tree = tree;
        this.swaySeed = swaySeed(tree);
        this._leanFrame = { canvas: null, x: 0, y: 0, textureKey: '' };
    }

    draw(ctx) {
        const frame = this._getCachedCanvas();
        if (!frame) return;
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(frame.canvas, frame.x, frame.y);
        ctx.restore();
    }

    _getCachedCanvas() {
        return this.foliage.leanFrameFor(this, this._leanFrame);
    }
}

// Owns the shared tree images and picks each tree's frame. The host supplies
// only the live atmosphere, motion clock and assets shared with the world
// frame (never agent state).
export class FoliageRenderer {
    constructor(host) {
        this.host = host;
        // Lean frames (canvases) and the recoloured canopies they shear from
        // (ImageData), both for the current season and snow state only.
        this.cache = new Map();
        this._canopies = new Map();
        this.season = 'summer';
        this._snowBucket = 0;
        this._wind = { x: 0, gust: 0 };
    }

    clear() {
        this.releaseCache();
    }

    releaseCache() {
        releaseCanvasMap(this.cache);
        this._canopies.clear();
    }

    getRetainedPixels() {
        return canvasMapPixelCount(this.cache);
    }

    get cacheSize() {
        return this.cache.size;
    }

    // The renderer's calendar season (`_currentSeasonToken`); a change drops
    // every tree image so the next draw rebuilds them once for the new season.
    setSeason(season) {
        const next = CANOPY_SEASONS.includes(season) ? season : 'summer';
        if (next === this.season) return;
        this.season = next;
        this.releaseCache();
    }

    createTreeProps(trees) {
        return (trees || []).map((tree) => new TreePropSprite(this, tree));
    }

    fantasyTreePropBounds(tree) {
        const sprite = TREE_SPRITES[treeSpriteKey(tree)];
        const anchorX = sprite.width / 2;
        const anchorY = sprite.height - 1;
        return {
            left: -anchorX,
            right: sprite.width - anchorX,
            top: -anchorY,
            bottom: sprite.height - anchorY,
            splitY: -anchorY + Math.round(sprite.height * 0.58),
        };
    }

    /**
     * The signed lean frame (texels at the crown top) a tree prop shows at
     * motion time `tMs`. Below a breeze every tree stands upright (fog is
     * still). In a breeze a tree runs the {0, +1, 0, −1} cycle only while a
     * gust of the wind field crosses it, so gust patches travel through a
     * wood. From |windX| 0.6 every tree rests one texel downwind and cycles
     * around that rest; a gust lets it reach its species amplitude (a willow
     * bends two texels), otherwise it stays within one. Each step holds
     * 300–600 ms on the tree's own phase, so neighbours never move in
     * lockstep. Reduced motion holds the rest lean.
     */
    swayFrame(prop, tMs) {
        const weather = this.host._lastAtmosphere?.weather;
        const base = baseWindX(weather);
        const speed = Math.abs(base);
        if (speed < SWAY_CALM) return 0;
        const sign = base < 0 ? -1 : 1;
        const windy = speed >= SWAY_WINDY;
        const rest = windy ? sign : 0;
        if (!((this.host.motionScale ?? 1) > 0)) return rest;
        const gusting = windAt(prop.x, prop.y, tMs, weather, this._wind).gust > 0;
        if (!windy && !gusting) return 0;
        const hold = SWAY_HOLD_MS + SWAY_HOLD_SPAN_MS * prop.swaySeed;
        const step = Math.floor((tMs + prop.swaySeed * 4 * hold) / hold);
        const amp = windy && gusting ? TREE_SPRITES[treeSpriteKey(prop.tree)].lean : 1;
        return Math.max(-amp, Math.min(amp, rest + SWAY_CYCLE[step & 3] * sign));
    }

    // Fills `out` with the frame a tree sprite shows now: the shared image, its
    // world top-left and its GPU texture key. Null until the sheet has loaded.
    leanFrameFor(sprite, out) {
        this._syncSnow();
        const frame = this.swayFrame(sprite, this.host.motionTimeMs || 0);
        const cached = this._frame(sprite.tree, frame);
        if (!cached) return null;
        out.canvas = cached.canvas;
        out.x = Math.round(sprite.x) - cached.anchorX;
        out.y = Math.round(sprite.y) - cached.anchorY;
        out.textureKey = cached.textureKey;
        return out;
    }

    // Pines carry snow only while the village's own snow lies on the ground
    // (`renderer._groundState`, the same bucket the ground snow rebakes on);
    // a bucket change drops every tree image once, like a season change.
    _syncSnow() {
        const bucket = snowBucketOf(this.host._groundState?.snowCover);
        if (bucket === this._snowBucket) return;
        this._snowBucket = bucket;
        this.releaseCache();
    }

    _frame(tree, frame) {
        const leafy = treeSpriteKey(tree);
        const state = treeStateKey(leafy, this.season, this._snowBucket);
        // Snow quarters 1–3 dust the leafy pine; a full cover draws the laden
        // sheet. A state sheet still loading shows the leafy sheet meanwhile.
        const dust = state === TREE_SPRITES[leafy].snow && this._snowBucket < 4 ? this._snowBucket : 0;
        const shown = dust ? leafy : state;
        return this._frameOf(shown, tree, frame, dust) || (shown !== leafy || dust ? this._frameOf(leafy, tree, frame) : null);
    }

    _frameOf(spriteKey, tree, frame, dust = 0) {
        const sprite = TREE_SPRITES[spriteKey];
        const variant = sprite.canopy === false ? 0 : canopyVariantOf(tree);
        const canopyKey = `${spriteKey}|${variant}|${this.season}${dust ? `|snow${dust}` : ''}`;
        const key = `${canopyKey}|${frame}`;
        const existing = this.cache.get(key);
        if (existing) return existing;
        const canopy = this._canopy(spriteKey, variant, canopyKey, dust);
        if (!canopy) return null;
        const lean = leanFrameImage(canopy.data, canopy.width, canopy.height, frame, sprite.planted);
        const canvas = document.createElement('canvas');
        canvas.width = lean.width;
        canvas.height = lean.height;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(lean.width, lean.height);
        image.data.set(lean.data);
        ctx.putImageData(image, 0, 0);
        const cached = {
            canvas,
            anchorX: sprite.width / 2 + LEAN_PAD,
            anchorY: sprite.height - 1,
            textureKey: `tree:${key}`,
        };
        this.cache.set(key, cached);
        return cached;
    }

    // One sheet's authored pixels (ImageData at its crop), or null while it
    // loads.
    _sheetPixels(spriteKey) {
        const sprite = TREE_SPRITES[spriteKey];
        const source = this.host.assets?.get?.(sprite.id);
        if (!source || typeof document === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = sprite.width;
        canvas.height = sprite.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(source, 0, 0, sprite.width, sprite.height, 0, 0, sprite.width, sprite.height);
        return ctx.getImageData(0, 0, sprite.width, sprite.height);
    }

    // The recoloured canopy image (ImageData) of one sprite/variant for this
    // season (and snow dusting), which every lean frame shears from.
    _canopy(spriteKey, variant, canopyKey, dust = 0) {
        const existing = this._canopies.get(canopyKey);
        if (existing) return existing;
        const sprite = TREE_SPRITES[spriteKey];
        const image = this._sheetPixels(spriteKey);
        const laden = dust ? this._sheetPixels(sprite.snow) : null;
        if (!image || (dust && !laden)) return null;
        const species = spriteKey.slice(0, spriteKey.indexOf('.'));
        const plan = sprite.canopy === false ? null : canopyPlan(species, variant, this.season);
        recolorCanopy(image.data, sprite.width, sprite.height, plan);
        if (laden) dustPineCanopy(image.data, laden.data, sprite.width, sprite.height, dust);
        this._canopies.set(canopyKey, image);
        return image;
    }
}
