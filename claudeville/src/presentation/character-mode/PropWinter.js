import { ART_RAMPS } from '../../config/artPalette.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { snowBucketOf } from './GroundState.js';
import { roofSnowPixels } from './RoofWeather.js';

// Winter states for district flora props (5.2): planters, flower beds, wild
// flower clumps, the lily pads (the pond's clump under Command's steps and the
// lagoon drifts), the hedge, mossy stones and boulders, the lake shrine's moss,
// the root arch's crown, and the moss and flower clumps on the landmark
// bridge's abutments. Like the trees (FoliageRenderer), one derived image per
// (prop, season, snow bucket), shared by Canvas and the GPU records (the
// prop's cached canvas, or the terrain bake for `layer: 'cache'` props), and
// dropped when the state changes: the C-W2 snow bucket steps at most four
// times a day, the season four times a year.
//
// Only plant pixels change: green leaf and moss, and bloom pixels sitting in
// green. Wood, stone, soil, flames, doors and banners never take snow, and
// the dark 1-px outline is not a plant pixel, so it stays. In winter a
// flowering plant (`plant`) goes dormant, its whole mass remapped by
// luminance rank onto the dry `willowGold` stops; on the bridge (`bloom`)
// only the flower heads go dormant and the moss stays green. Evergreen props
// (hedge, moss) keep their colour. Snow then lies where the mass faces the
// sky (see `winterPropPixels`), in the `snow` ramp chosen by the pixel's own
// luminance rank, so the lit side stays lit. A `round` mass (hedge, boulder
// moss, a crown) takes a cap 1-3 rows deep as the bucket steps 1 → 3 and six
// at 4; a `flat` bed (flower beds, planter tops, the bridge's grass pads, the
// shrine's islet) faces the sky all over, so its cap runs twice as deep and
// buries the whole bed at a full cover.
export const WINTER_PROPS = Object.freeze({
    'veg.planter': { dormancy: 'plant', surface: 'flat' },
    'veg.flowerBed': { dormancy: 'plant', surface: 'flat' },
    'veg.flower.a': { dormancy: 'plant', surface: 'flat' },
    'veg.flower.b': { dormancy: 'plant', surface: 'flat' },
    'veg.flower.c': { dormancy: 'plant', surface: 'flat' },
    'prop.flowerCart': { dormancy: 'plant', surface: 'flat' },
    'veg.lilypad': { dormancy: 'plant', surface: 'flat' },
    'bridge.landmark.civic.ns': { dormancy: 'bloom', surface: 'pad' },
    'prop.lakeShrine': { dormancy: 'evergreen', surface: 'flat' },
    'veg.hedge': { dormancy: 'evergreen', surface: 'round' },
    'veg.boulder.mossy.large': { dormancy: 'evergreen', surface: 'round' },
    'veg.boulder.mossy.small': { dormancy: 'evergreen', surface: 'round' },
    'veg.standingStone.mossy': { dormancy: 'evergreen', surface: 'round' },
    'veg.root.arch': { dormancy: 'evergreen', surface: 'round' },
    'prop.mangroveRoot.twisted': { dormancy: 'evergreen', surface: 'round' },
    'prop.mangroveRoot.arch': { dormancy: 'evergreen', surface: 'round' },
    // Roofed props: the roof takes the landmarks' course snow
    // (RoofWeather.roofSnowPixels), the tufts the round plant cap. The well
    // goes by the slate colour rule; the scenery's roof is its polygon in
    // sprite px (their stone shares the slate's blue), the stall's awning
    // one smooth cloth sheet, and the gate arch's crenels and copings take
    // silhouette caps only. The gate towers draw at 0.72, where 1-row course
    // lips resample to static, so their roof snows down from the ridge by
    // pitch (joints buried as it goes).
    'prop.well': { dormancy: 'evergreen', surface: 'round', roof: true },
    'prop.villageGateTower': { dormancy: 'evergreen', surface: 'round', roof: { poly: [[60, 18], [112, 30], [112, 50], [96, 100], [38, 78]], pitch: true } },
    'prop.villageWallSeaTower': { dormancy: 'evergreen', surface: 'round', roof: { poly: [[96, 28], [154, 58], [152, 64], [96, 90], [38, 58], [40, 52]] } },
    'prop.marketStall': { dormancy: 'evergreen', surface: 'round', roof: { poly: [[30, 5], [62, 20], [60, 26], [33, 38], [5, 19]], sheet: true } },
    'prop.villageGateArch': { dormancy: 'evergreen', surface: 'round', roof: { caps: true } },
});

// The village wall's walk (the procedural cap of IsometricRenderer
// `_drawVillageWallSegment`): the snow bucket's quarter share of the walk's
// depth from its front lip lies under the `snow` ramp's lit-plane stop; null
// on a bare walk.
export function wallWalkSnow(bucket) {
    const b = Math.max(0, Math.min(4, bucket | 0));
    return b ? { share: b / 4, body: ART_RAMPS.snow[3] } : null;
}

// Snow rows per bucket and surface: a dusting that thickens a quarter at a
// time, then a cap (a flat bed's full cap runs until its mass ends).
const SNOW_DEPTH = Object.freeze({
    round: Object.freeze([0, 1, 2, 3, 6]),
    flat: Object.freeze([0, 2, 5, 10, 256]),
    pad: Object.freeze([0, 2, 5, 10, 256]),
});
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const SNOW = ART_RAMPS.snow.map(hexRgb);
const DORMANT = ART_RAMPS.willowGold.slice(0, 6).map(hexRgb);
const STEM = ART_RAMPS.willowGold.slice(1, 4).map(hexRgb);

const LEAF = 1;
const BLOOM = 2;
const SHADE = 3;

function hsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return { h, s: max ? d / max : 0, v: max / 255 };
}

function isLeaf(r, g, b) {
    const { h, s, v } = hsv(r, g, b);
    return h >= 65 && h <= 170 && s >= 0.28 && v >= 0.16;
}

// A flower head: saturated red, pink, violet or blue; hot orange or yellow;
// or near-white petals. Wood and soil (low-value oranges) never qualify.
// `floor` lowers the value gate for the shaded side of a head already found.
function isBloomColour(r, g, b, floor = 0.45) {
    const { h, s, v } = hsv(r, g, b);
    if (s <= 0.2) return v >= 0.85;
    if (s < 0.35 || v < floor) return false;
    if (h < 15 || h >= 180) return true;
    if (h < 40) return s >= 0.7 && v >= floor + 0.4;
    return h < 65 && v >= floor + 0.3;
}

const lumOf = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
const isDark = (data, i) => Math.max(data[i], data[i + 1], data[i + 2]) < 56;

// Per-pixel plant class (0 none, LEAF, BLOOM, SHADE). A bloom seed needs at
// least three leaf pixels in its 5x5 neighbourhood (so a flame on a post or a
// painted cart stays itself) and then grows through its own head. SHADE is a
// dark pixel inside the plant mass (between leaves), never the silhouette's
// 1-px outline, which touches transparency.
export function plantMask(data, width, height) {
    const n = width * height;
    const mask = new Uint8Array(n);
    const opaque = (p) => data[p * 4 + 3] >= 128;
    for (let p = 0; p < n; p++) {
        const i = p * 4;
        if (opaque(p) && isLeaf(data[i], data[i + 1], data[i + 2])) mask[p] = LEAF;
    }
    const stack = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const i = p * 4;
            if (mask[p] || !opaque(p) || !isBloomColour(data[i], data[i + 1], data[i + 2])) continue;
            let leaves = 0;
            for (let dy = -2; dy <= 2 && leaves < 3; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -2; dx <= 2; dx++) {
                    const xx = x + dx;
                    if (xx >= 0 && xx < width && mask[yy * width + xx] === LEAF) leaves++;
                }
            }
            if (leaves >= 3) stack.push(p);
        }
    }
    // A head grows at most five pixels from its seed: a flower, never a deck.
    let ring = stack.splice(0);
    for (const p of ring) mask[p] = BLOOM;
    for (let step = 0; step < 5 && ring.length; step++) {
        const next = [];
        for (const p of ring) {
            const x = p % width;
            const y = (p - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    const yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
                    const q = yy * width + xx;
                    const i = q * 4;
                    if (mask[q] || !opaque(q) || !isBloomColour(data[i], data[i + 1], data[i + 2], 0.3)) continue;
                    mask[q] = BLOOM;
                    next.push(q);
                }
            }
        }
        ring = next;
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (mask[p] || !opaque(p) || !isDark(data, p * 4) || isOutline(data, width, height, x, y)) continue;
            let plant = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    const yy = y + dy;
                    if (xx >= 0 && yy >= 0 && xx < width && yy < height && (mask[yy * width + xx] === LEAF || mask[yy * width + xx] === BLOOM)) plant++;
                }
            }
            if (plant >= 2) mask[p] = SHADE;
        }
    }
    return mask;
}

// A silhouette outline pixel: dark and 4-adjacent to transparency (or the
// image edge).
function isOutline(data, width, height, x, y) {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 128 || !isDark(data, i)) return false;
    const clear = (xx, yy) => xx < 0 || yy < 0 || xx >= width || yy >= height || data[(yy * width + xx) * 4 + 3] < 128;
    return clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1);
}

/**
 * The winter state of one RGBA prop image, in place (pure; Node-safe).
 * `dormancy` and `surface` come from WINTER_PROPS; `winter` is the calendar
 * season; `bucket` the C-W2 snow bucket 0-4. Returns the pixels changed.
 */
export function winterPropPixels(data, width, height, { dormancy, surface = 'round', winter = false, bucket = 0, roof = false }) {
    const depth = (SNOW_DEPTH[surface] || SNOW_DEPTH.round)[Math.max(0, Math.min(4, bucket | 0))];
    const dormant = winter && (dormancy === 'plant' || dormancy === 'bloom');
    if (!depth && !dormant) return 0;
    // The slate roof first: its snow texels are never plant pixels.
    const roofed = roof ? roofSnowPixels(data, width, height, bucket, roof) : 0;
    const mask = plantMask(data, width, height);
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = 0; p < mask.length; p++) {
        if (!mask[p] || mask[p] === SHADE) continue;
        const l = lumOf(data, p * 4);
        if (l < lo) lo = l;
        if (l > hi) hi = l;
    }
    if (lo === Infinity) return roofed;
    const span = Math.max(1, hi - lo);
    const rank = (i) => (lumOf(data, i) - lo) / span;
    const pick = (ramp, t) => ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
    const set = (i, c) => { data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; };
    // Ranks are read from the authored pixels before any write.
    const ranks = new Float32Array(mask.length);
    for (let p = 0; p < mask.length; p++) if (mask[p] && mask[p] !== SHADE) ranks[p] = rank(p * 4);
    // The silhouette rim: a non-plant pixel touching transparency (the 1-px
    // outline, a planter's back rim) or a dark outline pixel under one (a
    // 2-px outline), read before any write.
    const rim = new Uint8Array(mask.length);
    const clear = (x, y) => x < 0 || y < 0 || x >= width || y >= height || data[(y * width + x) * 4 + 3] < 128;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (mask[p] || clear(x, y)) continue;
            if (clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1)) rim[p] = 1;
            else if (y > 0 && rim[p - width] && isDark(data, p * 4)) rim[p] = 1;
        }
    }
    let changed = roofed;
    if (dormant) {
        for (let p = 0; p < mask.length; p++) {
            if (!mask[p] || mask[p] === SHADE) continue;
            if (mask[p] === BLOOM) set(p * 4, pick(STEM, ranks[p]));
            else if (dormancy === 'plant') set(p * 4, pick(DORMANT, ranks[p]));
            else continue;
            changed++;
        }
    }
    if (!depth) return changed;
    // Snow lies only where the mass faces the sky: down each column, a cap
    // starts at a mass pixel whose upper neighbour is transparency or the
    // silhouette rim and covers the next `depth` rows of mass, stepping
    // over gaps of at most two non-mass pixels (the speckle of a planter's
    // top). Mass under wood, stone or soil (a vine on a crate face, moss under
    // a bridge deck) never starts a cap and stays bare, except on a `pad`,
    // whose grass lies flat around what stands on it. A 1-px stem (mass with
    // no mass beside it) ends the cap: snow sits on heads, not down stalks.
    const pad = surface === 'pad';
    const massAt = (x, y) => x >= 0 && x < width && mask[y * width + x] !== 0;
    for (let x = 0; x < width; x++) {
        let start = -1;
        let gap = 0;
        for (let y = 0; y < height; y++) {
            const p = y * width + x;
            if (!mask[p]) {
                if (start >= 0 && ++gap > 2) start = -1;
                continue;
            }
            gap = 0;
            if (start < 0) {
                if (!(y === 0 || data[(p - width) * 4 + 3] < 128 || rim[p - width] || (pad && !mask[p - width]))) continue;
                start = y;
            }
            const row = y - start;
            if (row >= depth) continue;
            if (row > 0 && !massAt(x - 1, y) && !massAt(x + 1, y)) {
                start = -1;
                continue;
            }
            // Lit pixels take the top snow stops, shaded ones the lower; the
            // last row of a deep cap steps one stop down for thickness.
            let stop = mask[p] === SHADE ? 1 : ranks[p] >= 0.62 ? 4 : ranks[p] >= 0.3 ? 3 : 2;
            if (depth > 1 && row === depth - 1) stop = Math.max(0, stop - 1);
            set(p * 4, SNOW[stop]);
            changed++;
        }
    }
    return changed;
}

// The per-renderer cache: `sync` once per frame after the ground state;
// `image(id)` answers the derived canvas for the current state, or null to
// draw the authored sprite (summer, not a flora prop, or its sheet loading).
// The renderer's `assets` is read at use, since it may arrive after the
// renderer is built.
export class PropWinter {
    constructor(host) {
        this.host = host;
        this.season = 'summer';
        this.bucket = 0;
        this._images = new Map();
    }

    get key() {
        return `${this.season === 'winter' ? 'w' : ''}${this.bucket}`;
    }

    // True when the state changed (callers repaint their flora prop caches).
    sync(season, snowCover) {
        const next = season || 'summer';
        const bucket = snowBucketOf(snowCover);
        if (next === this.season && bucket === this.bucket) return false;
        const was = this.key;
        this.season = next;
        this.bucket = bucket;
        if (this.key === was) return false;
        this.release();
        return true;
    }

    image(id) {
        const kind = WINTER_PROPS[id];
        if (!kind) return null;
        const winter = this.season === 'winter';
        if (!this.bucket && !(winter && kind.dormancy !== 'evergreen')) return null;
        if (this._images.has(id)) return this._images.get(id);
        const source = this.host?.assets?.get?.(id);
        const width = source?.naturalWidth || source?.width || 0;
        const height = source?.naturalHeight || source?.height || 0;
        if (!width || !height || typeof document === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, 0, 0);
        const image = ctx.getImageData(0, 0, width, height);
        winterPropPixels(image.data, width, height, { ...kind, winter, bucket: this.bucket });
        ctx.putImageData(image, 0, 0);
        this._images.set(id, canvas);
        return canvas;
    }

    release() {
        for (const canvas of this._images.values()) releaseCanvasBackingStore(canvas);
        this._images.clear();
    }
}
