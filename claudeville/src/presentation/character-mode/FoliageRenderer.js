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
// the Waking Isle plan): canopy pixels are
// remapped by luminance rank onto a C1 ramp from `ART_RAMPS` — variant 1 onto
// `foliageDeep`, variant 2 onto `foliageSun`, autumn oaks onto `canopyRusset`
// / `canopyOchre` (variant 0 turns only its upper leaf clumps), autumn willows,
// birches and poplars onto `willowGold`, autumn maples onto `canopyScarlet`,
// `blossom` clusters on spring's sunlit oaks. Partial
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
// (`dustSnowCanopy`), a full cover draws the laden sheet itself. Bare and snow
// sheets carry no canopy remap (`canopy: false`), so one image per state
// serves every variant.
//
// The Turning Year (BI-2): the season's plans move through the weekly stages
// of `SeasonalAmbience.PHENOLOGY_STAGES`. Through September and October a
// crown turns from the top in whole clumps over its summer colours
// (`canopyPlan`'s `turn`); from mid-October each species sheds whole clumps
// to its authored bare sheet by a fixed clump hash (`shedCanopy`: birches and
// poplars first, oaks last), so the stages nest and the crown outline around a
// fallen clump goes with it; a crown fully shed draws its bare sheet. Young
// oaks keep a few russet clumps through December. Spring runs the shed back
// as leaf-out, then the blossom. A stage change drops the images once, like
// a season; the stage keys every image and texture.
//
// The world ash (user item 5): one authored record (`species: 'ash'`,
// scenery.js WORLD_TREE) draws the colossal `ash.world` sheet, about 2.4× a
// tall oak, on the northern lagoon islet. It is evergreen: its canopy plan
// follows the season (`WORLD_ASH_PLANS`) instead of a variant, it never goes
// bare, and it carries the village's snow like a pine (snow quarters dust its
// leafy crown from its laden sheet `ash.world.snow`, a full cover draws that
// sheet, whose leaves are the winter plan's).
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
    // Living Isle W8.3d (AD-P8): birch (white trunk, airy crown; the north
    // ridge), maple (broad dense crown; the inhabited belt) and the Lombardy
    // poplar (a narrow column, tall only: avenue rows, scenery.js
    // TREE_AVENUES). A slender trunk bends higher up (planted 0.4).
    'birch.small': Object.freeze({ id: 'veg.tree.birch.small', width: 32, height: 28, lean: 1, planted: 0.4, bare: 'birch.small.bare' }),
    'birch.large': Object.freeze({ id: 'veg.tree.birch.large', width: 64, height: 61, lean: 1, planted: 0.4, bare: 'birch.large.bare' }),
    'birch.tall': Object.freeze({ id: 'veg.tree.birch.tall', width: 64, height: 109, lean: 2, planted: 0.4, bare: 'birch.tall.bare', crown: Object.freeze({ halfWidth: 20, bottom: 46 }) }),
    'maple.large': Object.freeze({ id: 'veg.tree.maple.large', width: 64, height: 51, lean: 1, planted: 0.3, bare: 'maple.large.bare' }),
    'maple.tall': Object.freeze({ id: 'veg.tree.maple.tall', width: 112, height: 112, lean: 2, planted: 0.3, bare: 'maple.tall.bare', crown: Object.freeze({ halfWidth: 50, bottom: 34 }) }),
    'poplar.tall': Object.freeze({ id: 'veg.tree.poplar.tall', width: 64, height: 128, lean: 1, planted: 0.4, bare: 'poplar.tall.bare', crown: Object.freeze({ halfWidth: 16, bottom: 27 }) }),
    'birch.small.bare': Object.freeze({ id: 'veg.tree.birch.small.bare', width: 32, height: 28, lean: 1, planted: 0.4, canopy: false }),
    'birch.large.bare': Object.freeze({ id: 'veg.tree.birch.large.bare', width: 64, height: 61, lean: 1, planted: 0.4, canopy: false }),
    'birch.tall.bare': Object.freeze({ id: 'veg.tree.birch.tall.bare', width: 64, height: 109, lean: 2, planted: 0.4, canopy: false }),
    'maple.large.bare': Object.freeze({ id: 'veg.tree.maple.large.bare', width: 64, height: 51, lean: 1, planted: 0.3, canopy: false }),
    'maple.tall.bare': Object.freeze({ id: 'veg.tree.maple.tall.bare', width: 112, height: 112, lean: 2, planted: 0.3, canopy: false }),
    'poplar.tall.bare': Object.freeze({ id: 'veg.tree.poplar.tall.bare', width: 64, height: 128, lean: 1, planted: 0.4, canopy: false }),
    // The world ash: a colossus barely moves (one texel, planted high).
    'ash.world': Object.freeze({ id: 'veg.tree.ash.world', width: 240, height: 271, lean: 1, planted: 0.5, snow: 'ash.world.snow' }),
    'ash.world.snow': Object.freeze({ id: 'veg.tree.ash.world.snow', width: 240, height: 271, lean: 1, planted: 0.5, canopy: false }),
});
const TREE_SPECIES = Object.freeze(['oak', 'pine', 'willow', 'birch', 'maple', 'poplar', 'ash']);
export const CANOPY_VARIANTS = Object.freeze([0, 1, 2]);
export const CANOPY_SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
const LEAN_PAD = 2;

// Resolve a tree record to its leafy sprite key: the record's size where the
// species has that sheet, else the nearest one it has (pines and maples have
// no small sheet and draw large; a poplar is tall only; the world ash has its
// one sheet). GroundBake sizes its leaf-drop crowns from the same key.
export function treeSpriteKey(tree) {
    const species = TREE_SPECIES.includes(tree?.species) ? tree.species : 'oak';
    if (species === 'ash') return 'ash.world';
    if (species === 'poplar') return 'poplar.tall';
    const size = tree?.size === 'tall' ? 'tall' : tree?.size === 'small' && TREE_SPRITES[`${species}.small`] ? 'small' : 'large';
    return `${species}.${size}`;
}

// The sheet a leafy sprite shows now: bare once its whole crown has shed
// (deciduous; `shed`, the BI-2 stage's share, 1 by default in winter),
// snow-laden while snow lies on the ground (pines and the world ash,
// `snowBucket` > 0), else itself.
export function treeStateKey(spriteKey, season, snowBucket, shed = season === 'winter' ? 1 : 0) {
    const sprite = TREE_SPRITES[spriteKey];
    if (shed >= 1 && sprite?.bare) return sprite.bare;
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

// The turning crown's line at peak colour (`turnedClump`), and how far one
// unit of BI-2 turn progress moves it.
const TURN_LINE = 0.35;
const TURN_LINE_SPAN = 0.65;
// `line`: the turning crown's line (`turnedClump`); `turningShift`: the stops
// the turning ramp is lifted (a part-turned lit crown, BI-2).
const plan = (fields) => Object.freeze({ ramp: null, stops: 0, shift: 0, turning: null, turningShift: 0, line: TURN_LINE, blossom: false, ...fields });
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
const PLAN_GOLD_TURNING = plan({ turning: 'willowGold' });
const PLAN_SCARLET = plan({ ramp: 'canopyScarlet' });
const PLAN_SCARLET_LIT = plan({ ramp: 'canopyScarlet', shift: 1 });
const PLAN_SCARLET_TURNING = plan({ turning: 'canopyScarlet' });
// The evergreen world ash by season: a fresh, lighter crown in spring, its
// authored crown through summer and autumn (it stays green while the woods
// turn), a cool deep crown in winter (the leaves under its snow sheet).
const WORLD_ASH_PLANS = Object.freeze({ spring: PLAN_SUN, summer: null, autumn: null, winter: PLAN_DEEP });

// How a canopy is recoloured; null keeps the authored pixels. Autumn oaks turn
// russet (deep), ochre (sunlit) or only at the crown (authored); willows and
// poplars go gold except the deep ones, which hold their green; birches go
// pale straw gold, the deep ones only at the crown; maples go scarlet, the
// deep ones only at the crown, the sunlit a stop lighter, so the woods turn
// in three hue families instead of one russet mass; sunlit oaks blossom in
// spring; pines never change with the season; the world ash follows
// WORLD_ASH_PLANS whatever its variant.
//
// BI-2 — `turn` is the autumn turn's progress (PHENOLOGY_STAGES `turned` plus
// the species' `shed`): 1 is the peak plans above. Below it a crown turns
// from the top in whole clumps over its summer colours (a fully recoloured
// plan reaches the whole crown at 1, a crown-only plan its line); from 1 to
// 2 the shed weeks carry a crown-only plan's line down the rest of the crown,
// so a crown finishes turning as it empties.
export function canopyPlan(species, variant, season, turn = 1) {
    if (species === 'ash') return WORLD_ASH_PLANS[season] ?? null;
    if (species === 'pine') return variant === 1 ? PLAN_DEEP : variant === 2 ? PLAN_PINE_SUN : null;
    if (season === 'autumn') {
        const peak = autumnPeakPlan(species, variant);
        return turn === 1 ? peak : turningPlan(peak, canopyPlan(species, variant, 'summer'), turn);
    }
    if (variant === 1) return PLAN_DEEP;
    if (variant === 2) return species === 'oak' && season === 'spring' ? PLAN_SUN_BLOSSOM : PLAN_SUN;
    return null;
}

function autumnPeakPlan(species, variant) {
    if (species === 'willow' || species === 'poplar') return variant === 1 ? PLAN_DEEP : variant === 2 ? PLAN_WILLOW_GOLD_LIT : PLAN_WILLOW_GOLD;
    if (species === 'birch') return variant === 1 ? PLAN_GOLD_TURNING : variant === 2 ? PLAN_WILLOW_GOLD : PLAN_WILLOW_GOLD_LIT;
    if (species === 'maple') return variant === 1 ? PLAN_SCARLET_TURNING : variant === 2 ? PLAN_SCARLET_LIT : PLAN_SCARLET;
    return variant === 1 ? PLAN_RUSSET : variant === 2 ? PLAN_OCHRE : PLAN_TURNING;
}

// A peak plan at turn progress `turn` (memoized, so a stage's plans keep
// their identity): a crown-only plan moves its line; a fully recoloured plan
// becomes a crown turn of its ramp over the summer plan, the whole crown
// from turn 1. A plan that never turns (the green-holding deep willows and
// poplars) is itself.
const _turnPlans = new Map();
function turningPlan(peak, summer, turn) {
    if (peak === summer || (!peak.ramp && !peak.turning)) return peak;
    const crownOnly = !peak.ramp;
    const progress = Math.max(0, Math.min(2, crownOnly ? turn : 2 * Math.min(1, turn)));
    if (!crownOnly && progress >= 2) return peak;
    const key = `${peak.ramp || ''}|${peak.turning || ''}|${peak.shift}|${summer?.ramp || ''}|${progress}`;
    let turned = _turnPlans.get(key);
    if (!turned) {
        const line = TURN_LINE + TURN_LINE_SPAN * (progress - 1);
        turned = crownOnly
            ? plan({ ...peak, line })
            : plan({ ramp: summer?.ramp || null, stops: summer?.stops || 0, shift: summer?.shift || 0,
                turning: peak.ramp, turningShift: peak.shift, line });
        _turnPlans.set(key, turned);
    }
    return turned;
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
// canopy (hashed per clump; `line` 0.35) take the turning ramp, so the crown
// turns in whole leaf clumps from the top. A lower line turns fewer, a line
// of 1 the whole crown (BI-2).
const turnedClump = (clump, top, bottom, line = TURN_LINE) => (clump.y - top) / Math.max(1, bottom - top)
    < line + 0.3 * pixelHash(Math.round(clump.x), Math.round(clump.y), 5);
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
    const turned = turning ? turningMask(width, height, indices, clumps.label, clumps.clumps.map((c) => turnedClump(c, top, bottom, canopy.line))) : null;
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
        if (turned && turned[p] === 1) set(i, turning.rgb[Math.min(turning.rgb.length - 1, rankStop(turning, t) + canopy.turningShift)]);
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
 * Lays a partial snow load on a leafy sheet (a pine, the world ash) in place
 * (pure; Node-safe): the top `depth` rows of every snow cap in the same-canvas
 * `laden` sheet, down each column, wherever the leafy sheet is opaque. Snow
 * thickens from its upper edge as the snow bucket steps 1 → 3, and every
 * written pixel is an authored snow pixel.
 */
export function dustSnowCanopy(data, laden, width, height, depth) {
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

// BI-2 — the shed hash salt (plus 7 per canopy variant, so a sheet's three
// variants drop different clumps), and the young oaks' marcescence: while
// the stage is marcescent, `oak.small` keeps 15 % of its clumps, russet.
const SHED_SALT = 11;
const MARCESCENT_SPRITE = 'oak.small';
const MARCESCENT_SHED = 0.85;

/**
 * BI-2 — sheds `share` (0..1) of a leafy crown to its authored bare sheet in
 * place (pure; Node-safe). Whole leaf clumps of the authored `leafy` sheet
 * (`canopyClumps`) fall when their fixed hash (`salt`) is under `share`, so a
 * larger share sheds a superset: the stages nest, a fallen clump never
 * returns while the share grows, and spring's falling share brings them back
 * in reverse. A fallen clump takes the bare sheet's pixels (its branches, or
 * open air); so does any other texel the two sheets differ on (the crown's
 * outline and shade, a twig past the leaf mass) whose nearest canopy texel,
 * through such texels, has fallen. A kept texel that now faces open air
 * takes its clump's darkest colour, so a kept clump keeps an edge and every
 * kept pixel stays on its canopy ramp. Returns the number of texels changed.
 */
export function shedCanopy(data, leafy, bare, width, height, share, salt) {
    const n = width * height;
    if (!(share > 0)) return 0;
    if (share >= 1) {
        data.set(bare.subarray(0, n * 4));
        return n;
    }
    const indices = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (isCanopyPixel(leafy, i, y, height)) indices.push(i);
        }
    }
    const { label, clumps } = canopyClumps(leafy, width, height, indices);
    const gone = clumps.map((c) => pixelHash(Math.round(c.x), Math.round(c.y), salt) < share);
    // 1 = a kept canopy texel, 2 = a fallen one; `shed` marks texels now bare.
    const canopy = new Uint8Array(n);
    for (const i of indices) canopy[i >> 2] = gone[label.get(i >> 2)] ? 2 : 1;
    const shed = new Uint8Array(n);
    let changed = 0;
    const toBare = (p) => {
        const i = p * 4;
        data[i] = bare[i]; data[i + 1] = bare[i + 1]; data[i + 2] = bare[i + 2]; data[i + 3] = bare[i + 3];
        shed[p] = 1;
        changed++;
    };
    for (let p = 0; p < n; p++) if (canopy[p] === 2) toBare(p);
    // Every other texel the sheets differ on (the crown's outline and deep
    // shade, a twig past the leaf mass) follows its nearest canopy texel
    // through them, a breadth-first flood from the whole canopy: it goes
    // bare with a fallen clump and stays with a kept one. Its owner is
    // geometry alone, so the shed still nests.
    const differs = (p) => {
        const i = p * 4;
        return leafy[i] !== bare[i] || leafy[i + 1] !== bare[i + 1] || leafy[i + 2] !== bare[i + 2] || leafy[i + 3] !== bare[i + 3];
    };
    const fate = Uint8Array.from(canopy);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (const i of indices) queue[tail++] = i >> 2;
    while (head < tail) {
        const p = queue[head++];
        const x = p % width;
        for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
            if (q < 0 || q >= n || fate[q] || !differs(q)) continue;
            fate[q] = fate[p];
            queue[tail++] = q;
        }
    }
    for (let p = 0; p < n; p++) if (!canopy[p] && fate[p] === 2) toBare(p);
    // Each kept clump's darkest colour (luminance), before any edge is set.
    const dark = new Array(clumps.length).fill(-1);
    for (const i of indices) {
        const id = label.get(i >> 2);
        if (gone[id]) continue;
        const d = dark[id];
        if (d < 0 || lumOf(data[i], data[i + 1], data[i + 2]) < lumOf(data[d], data[d + 1], data[d + 2])) dark[id] = i;
    }
    const edges = [];
    for (const i of indices) {
        const p = i >> 2;
        if (canopy[p] !== 1) continue;
        const x = p % width;
        for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
            if (q < 0 || q >= n || !shed[q] || data[q * 4 + 3] !== 0) continue;
            edges.push(i);
            break;
        }
    }
    for (const i of edges) {
        const d = dark[label.get(i >> 2)];
        data[i] = data[d]; data[i + 1] = data[d + 1]; data[i + 2] = data[d + 2];
    }
    return changed + edges.length;
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
        // BI-2 — the woods' weekly stage (SeasonalAmbience PHENOLOGY_STAGES),
        // or null for the season's own plans (bare all winter).
        this.phenology = null;
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

    // The renderer's calendar season (`_currentSeasonToken`) and BI-2 stage
    // (`_currentPhenology`); a change of either drops every tree image so the
    // next draw rebuilds them once (about 18 times a year).
    setSeason(season, phenology = null) {
        const next = CANOPY_SEASONS.includes(season) ? season : 'summer';
        if (next === this.season && (phenology?.id ?? '') === (this.phenology?.id ?? '')) return;
        this.season = next;
        this.phenology = phenology;
        this.releaseCache();
    }

    // The share of a leafy sheet's crown fallen to its bare sheet this stage:
    // the species' stage share (young oaks keep a few clumps while the stage
    // is marcescent), else all of it in winter.
    _shedOf(spriteKey) {
        if (!TREE_SPRITES[spriteKey]?.bare) return 0;
        const stage = this.phenology;
        if (stage?.marcescent && spriteKey === MARCESCENT_SPRITE) return MARCESCENT_SHED;
        return stage?.shed?.[spriteKey.slice(0, spriteKey.indexOf('.'))] ?? (this.season === 'winter' ? 1 : 0);
    }

    // The canopy plan of a leafy sheet this stage: the autumn turn's progress
    // (turned plus shed), the spring plans without blossom until it is out,
    // and a young oak's kept clumps russet while it is marcescent.
    _planOf(spriteKey, species, variant) {
        const stage = this.phenology;
        if (stage?.marcescent && spriteKey === MARCESCENT_SPRITE) return PLAN_RUSSET;
        const season = this.season === 'spring' && stage && !stage.blossom ? 'summer' : this.season;
        const turn = season === 'autumn' && stage ? stage.turned + (stage.shed?.[species] || 0) : 1;
        return canopyPlan(species, variant, season, turn);
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
        const shed = this._shedOf(leafy);
        const state = treeStateKey(leafy, this.season, this._snowBucket, shed);
        // Snow quarters 1–3 dust the leafy sheet; a full cover draws the laden
        // sheet. A crown part-shed this stage (BI-2) draws the leafy sheet
        // with its fallen clumps bare. A state or bare sheet still loading
        // shows the whole leafy sheet meanwhile.
        const dust = state === TREE_SPRITES[leafy].snow && this._snowBucket < 4 ? this._snowBucket : 0;
        const shown = dust ? leafy : state;
        const part = shown === leafy && shed < 1 ? shed : 0;
        return this._frameOf(shown, tree, frame, dust, part)
            || (shown !== leafy || dust || part ? this._frameOf(leafy, tree, frame) : null);
    }

    _frameOf(spriteKey, tree, frame, dust = 0, shed = 0) {
        const sprite = TREE_SPRITES[spriteKey];
        const variant = sprite.canopy === false ? 0 : canopyVariantOf(tree);
        // The BI-2 stage keys the image (and its GPU texture), so a new stage
        // uploads new frames.
        const canopyKey = `${spriteKey}|${variant}|${this.season}|${this.phenology?.id ?? ''}${dust ? `|snow${dust}` : ''}${shed ? '|shed' : ''}`;
        const key = `${canopyKey}|${frame}`;
        const existing = this.cache.get(key);
        if (existing) return existing;
        const canopy = this._canopy(spriteKey, variant, canopyKey, dust, shed);
        if (!canopy) return null;
        const lean = leanFrameImage(canopy.data, canopy.width, canopy.height, frame, sprite.planted);
        const canvas = document.createElement('canvas');
        canvas.width = lean.width;
        canvas.height = lean.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
    // season and stage (and snow dusting, or a part-shed crown), which every
    // lean frame shears from.
    _canopy(spriteKey, variant, canopyKey, dust = 0, shed = 0) {
        const existing = this._canopies.get(canopyKey);
        if (existing) return existing;
        const sprite = TREE_SPRITES[spriteKey];
        // The bare sheet first: while it loads, no leafy pixels are read.
        const bare = shed ? this._sheetPixels(sprite.bare) : null;
        if (shed && !bare) return null;
        const image = this._sheetPixels(spriteKey);
        const laden = dust ? this._sheetPixels(sprite.snow) : null;
        if (!image || (dust && !laden)) return null;
        const species = spriteKey.slice(0, spriteKey.indexOf('.'));
        const plan = sprite.canopy === false ? null : this._planOf(spriteKey, species, variant);
        const leafy = bare ? image.data.slice() : null;
        recolorCanopy(image.data, sprite.width, sprite.height, plan);
        if (laden) dustSnowCanopy(image.data, laden.data, sprite.width, sprite.height, dust);
        if (bare) shedCanopy(image.data, leafy, bare.data, sprite.width, sprite.height, shed, SHED_SALT + variant * 7);
        this._canopies.set(canopyKey, image);
        return image;
    }
}
