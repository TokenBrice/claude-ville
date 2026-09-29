// 5.2 roofs and 6.6 — roof snowcaps, wet slate and eave drips.
//
// Weather on the landmarks' roofs, from the village's own weather only (V3):
// the C-W2 ground state (`GroundState.groundStateAt`: snowCover, wetness) and
// the live precipitation of the timeline. Nothing here reads agent, mood or
// director state.
//
// Where it lies. A landmark's roof is its 2.3 surface channel's face class 3
// (occluder B >> 6, docs/material-channel-contract.md) where the albedo
// agrees it is roof material — slate, metal, or the ink between them — so a
// mis-tagged stone wall never takes snow; minus lit glass (the emissive
// sidecar), fabric, rune glass and fire (the material sidecar), and trim:
// metal on a slate roof (ribs, rings, finials; a mostly-metal roof, the
// Lighthouse's bronze cap, keeps it and snows as one sheet from its ridge
// down each column, its finial above the ridge and any 1-2 texel run bare)
// and any face-3 texel of another colour (the Observatory's maroon cornice).
// Trim stays bare and uncapped but is still roof to the eave. A face-tag
// speck wholly inside a roof is roof; a deep course-shadow line inside it is
// buried like a joint. A landmark without a surface channel gets none. A
// prop's roof (PropWinter) is the slate colour rule the surface bake classes
// roofs by (HSV hue 186-242, S >= 0.2; the well) or its authored polygon.
// Silhouette tops — texels with open sky straight above whose neighbour tops
// lie within one row (crenels, ridges, sills, the arch and the rock) or two
// (a steep shoulder, one row thinner) — take a cap under their 1-px ink
// outline, never cloth, gold, flame, trim or glass. Doors, banners and
// pennants are manifest parts drawn after this layer, and status marks are
// overlays, so none takes snow.
//
// Snow (5.2). Per snow bucket (`snowBucketOf`, quarters of cover) the slate
// courses fill from their sky-facing lip downward: 1, 2 and 3 rows of each
// course for buckets 1-3, or the same share of a smooth pitch's run (a sheet
// roof takes a cap growing down from the ridge); the next row is an ordered
// 2x2 dither, so the edge is ragged, never a smooth fade. At 4 the whole roof
// lies under snow and the thin joints (at most two texels thick between
// slates) sit three stops down, so the courses still read; darker regions
// wider than that (porthole glass, cupola openings) stay bare. The eave rows
// keep their slate so the roof keeps its thickness. Colour is the `snow`
// ramp by pitch: a texel's pitch light is the mean slate rank around it, the
// roof's lit pitch takes the top stop and a shaded pitch one stop per 0.15
// darker (at most two), so the upper-left key survives a full cover; a
// texel's own highlight or shadow line steps one stop. Silhouette caps are
// 1, 2, 3, 3 rows by bucket. The pines' snow (FoliageRenderer.dustPineCanopy)
// thickens by the same bucket, 1 → 3 rows, then the laden sheet.
//
// Wet slate (6.6). `roofEdge`: the roof's own upper-left-facing edges — a
// slate texel whose upper or left neighbour is off the roof or the roof's
// outline (the ridge, the verge, a hip against sky or wall); the joints
// between slates are not edges, so the course is one line. While the roof is
// wet those texels take a 1-art-px course on the `wetSlate` ramp (#5a6c8c →
// #8fa3c0), one stop per wetness quantum (4 quanta), and from quantum 2 the
// lit pitch's course lips under the ridge catch the sky in every other
// 2-texel cell, a band 4, 7, 10 rows deep that narrows as it dries. Winter
// precipitation is snow and never wets a roof. Clear, dry weather draws
// nothing.
//
// Drips (6.6). While it rains, 3-4 eave points per landmark (the lowest roof
// or trim texel of evenly spaced columns) shed a 1-px drip on a 12-step
// cycle of 90 ms on the MotionClock: a bead swells under the eave to the lit
// stop, falls and is gone, each point on its own phase; every drawn head has
// a dark slate texel under it so it reads on any wall. Hidden under reduced
// motion; the wet course stays.
//
// Both backends draw the same canvases: the Canvas building pass blits them
// after the landmark, the resident scene pass draws them as records right
// after the landmark record (GpuSceneBuilder `roofPatchRecord` /
// `roofDripRecord`) with the roof texels' own material and surface-code crops,
// so snow and the wet course shade exactly like the slate under them.

import { ART_RAMPS } from '../../config/artPalette.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { isWinterMonth, PRECIPITATING, snowBucketOf } from './GroundState.js';

export const ROOF_WET_QUANTA = 4;
export const ROOF_DRIP_FRAMES = 12;
export const ROOF_DRIP_STEP_MS = 90;
// Below this wetness a roof reads dry (the ground state's own dry floor).
const WET_FLOOR = 0.02;

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const SNOW = ART_RAMPS.snow.map(hexRgb);
const WET = ART_RAMPS.wetSlate.map(hexRgb);
// The deepest slate stop: the shadow side of a drip under its lit head.
const DRIP_SHADE = hexRgb(ART_RAMPS.slate[0]);

// Material ids (MaterialRegistry.MATERIAL_CLASS_NAMES) that never hold snow.
const NO_SNOW_MATERIALS = new Set([4 /* foliage */, 5 /* fabric */, 9 /* glass-rune */, 10 /* fire */]);

const NONE = 0;
const SLATE = 1;
const JOINT = 2;

// Snow rows per course by bucket (Infinity: the whole course).
const COURSE_DEPTH = Object.freeze([0, 1, 2, 3, Infinity]);
// Cap rows under a silhouette top by bucket (a steep shoulder one fewer).
const CAP_DEPTH = Object.freeze([0, 1, 2, 3, 3]);
const CAP_STEEP = 8;
// An outline texel: its brightest channel under this value.
const INK_VALUE = 72;
// Luminance step (0-255) that separates a slate from the joint or the course
// above it; below SHADOW_RANK (of the roof's own luminance span) a texel is
// the deepest course shadow, and below WET_MIN_RANK it never takes the wet
// course.
const JOINT_STEP = 12;
const SHADOW_RANK = 0.06;
const WET_MIN_RANK = 0.12;
// A pitch's own light: the mean rank of the slate within PLANE_RADIUS
// texels (the baked upper-left key), so a lit pitch and a shaded one take
// different snow stops. A texel DETAIL_RANK above or below its pitch is its
// own highlight or shadow line (a ridge highlight, a slate's shaded foot).
const PLANE_RADIUS = 3;
const DETAIL_RANK = 0.25;
// One snow stop per PLANE_STEP of pitch light under the roof's lit pitch.
const PLANE_STEP = 0.15;
// A buried joint finds slate within JOINT_REACH texels on both sides along
// one axis (a joint line up to two texels thick). A dark region wider than
// that both ways — a porthole's glass, a cupola opening — is no joint and
// stays bare.
const JOINT_REACH = 2;
// `thin` of a lone dark texel with slate on all eight sides: a speck in the
// slate, buried flush under a full cover rather than left as a dark dot.
const LONE = 2;
// A knot of wide joint texels (a crossing) buried like a thin joint.
const JOINT_KNOT = 4;
// A longer knot that is a line inside the roof (a deep course shadow) is
// buried too while at most this share of its sides lies off the roof.
const LINE_OFF_ROOF = 0.25;
// A face-tag speck inside a roof: at most this many texels.
const ROOF_SPECK = 8;
// 6.6 wet sheen: a lit pitch's course lips (every third row of a smooth
// pitch) within WET_SHEEN[q] rows under the roof's top catch the sky in
// every other 2-texel cell, a band along the ridge that narrows as it dries.
const WET_SHEEN = Object.freeze([0, 0, 4, 7, 10]);

const DRIP_FALL = Object.freeze([
    // [dy, stop, tail] per frame; null = nothing drawn. dy is below the eave
    // texel; a falling drop trails `tail` texels of the lit wet stop. Every
    // drawn head has a dark texel under it, so a 1-px bead reads on any wall.
    [1, 1, 0], [1, 2, 0], [1, 3, 0], [1, 3, 0], [1, 3, 0], [1, 3, 0], [2, 3, 1], [4, 3, 1], [7, 3, 1], null, null, null,
]);
const DRIP_REACH = 8;
const DRIP_MIN_PITCH = 8;
// A full bead and a falling drop catch the sky: the `snow` ramp's lit stop,
// the swelling bead climbs the `wetSlate` stops to it.
const DRIP_BEAD = hexRgb(ART_RAMPS.snow[3]);

function hsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max / 255 };
}

const lumAt = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

function isSlateColour(data, i) {
    const { h, s, v } = hsv(data[i], data[i + 1], data[i + 2]);
    return h >= 186 && h <= 242 && s >= 0.2 && v >= 0.12;
}

// A prop's roof tiles inside its authored roof region: slate from teal (the
// sea tower's, its glints down to sea green) to indigo (the gate towers').
function isTileColour(data, i) {
    const { h, s, v } = hsv(data[i], data[i + 1], data[i + 2]);
    return h >= 130 && h <= 262 && s >= 0.2 && v >= 0.12;
}

// Cloth, gold, flame and copper: saturated and not slate blue.
function isVividColour(data, i) {
    const { h, s, v } = hsv(data[i], data[i + 1], data[i + 2]);
    return s > 0.42 && v > 0.3 && !(h >= 186 && h <= 242);
}

// Gold, brass and bronze (dome ribs, rings, finials, a bronze cap) and their
// pale glints — never the warm-grey masonry (S <= 0.16, V < 0.85).
function isMetalColour(data, i) {
    const { h, s, v } = hsv(data[i], data[i + 1], data[i + 2]);
    return v > 0.3 && h >= 20 && h <= 70 && (s >= 0.2 || (s >= 0.1 && v >= 0.85));
}

// Ink: the outline, the joints and the openings — dark and not slate.
function isInkColour(data, i) {
    return Math.max(data[i], data[i + 1], data[i + 2]) < 77 && !isSlateColour(data, i);
}

// A metal roof's shaded facet: dark bronze (warm, saturated), never its
// black ink.
function isMetalShade(data, i) {
    const { h, s, v } = hsv(data[i], data[i + 1], data[i + 2]);
    return v >= 0.15 && h >= 5 && h <= 70 && s >= 0.3;
}

// A metal roof's spire (its finial, pole and collar): per 4-connected piece
// of `cls` (non-zero: roof or trim), the rows above its ridge (the first row
// at least SPIRE_RIDGE_SHARE of the piece's widest row), and any horizontal
// run of at most SPIRE_THIN texels (a thin vertical run). Returns a 0/1 mask
// or null.
const SPIRE_RIDGE_SHARE = 1 / 3;
const SPIRE_THIN = 2;
function metalSpire(cls, width) {
    const n = cls.length;
    const spire = new Uint8Array(n);
    const seen = new Uint8Array(n);
    const piece = [];
    let any = false;
    for (let start = 0; start < n; start++) {
        if (!cls[start] || seen[start]) continue;
        piece.length = 0;
        piece.push(start);
        seen[start] = 1;
        for (let k = 0; k < piece.length; k++) {
            const p = piece[k];
            const x = p % width;
            for (const [q, inside] of [[p - 1, x > 0], [p + 1, x + 1 < width], [p - width, p >= width], [p + width, p + width < n]]) {
                if (inside && cls[q] && !seen[q]) {
                    seen[q] = 1;
                    piece.push(q);
                }
            }
        }
        const rows = new Map();
        for (const p of piece) {
            const y = Math.floor(p / width);
            rows.set(y, (rows.get(y) || 0) + 1);
        }
        const widest = Math.max(...rows.values());
        let ridge = Infinity;
        for (const [y, count] of rows) if (count >= widest * SPIRE_RIDGE_SHARE && y < ridge) ridge = y;
        for (const p of piece) {
            const x = p % width;
            const y = (p - x) / width;
            let left = x;
            while (left > 0 && cls[p - (x - left) - 1]) left--;
            let right = x;
            while (right + 1 < width && cls[p + (right - x) + 1]) right++;
            if (y < ridge || right - left + 1 <= SPIRE_THIN) {
                spire[p] = 1;
                any = true;
            }
        }
    }
    return any ? spire : null;
}

// Ordered 2x2 (Bayer [[0, 2], [3, 1]]) threshold in [-0.375, 0.375].
const BAYER2 = Object.freeze([0, 2, 3, 1]);
const bayer2 = (x, y) => (BAYER2[((y & 1) << 1) | (x & 1)] - 1.5) / 4;

function hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Pure (Node-safe): the roof weather map of one sprite from its RGBA byte
 * arrays (all `width × height`). `occluder` carries the 2.3 surface code;
 * `region` (a prop's authored roof mask, 1 = roof) stands in for it where a
 * sprite has none, and `sheet` marks that region as one smooth sheet (cloth:
 * no joints, no courses, one light). With neither, roofs go by the slate
 * colour rule, and no silhouette caps unless `caps`. Returns null when
 * nothing can take weather.
 */
export function roofWeatherMap({ width, height, albedo, occluder = null, region = null, sheet = false, material = null, emissive = null, caps = occluder != null }) {
    if (!albedo || !(width > 0) || !(height > 0)) return null;
    const n = width * height;
    const cls = new Uint8Array(n);
    const rank = new Float32Array(n);
    const plane = new Float32Array(n);
    const row = new Int16Array(n).fill(-1);
    const cap = new Int8Array(n).fill(-1);
    const edge = new Uint8Array(n);
    const thin = new Uint8Array(n);
    // Texels of the roof class that are no roof material (a mis-tagged
    // wall, the Observatory's maroon cornice, gold trim): bare and never
    // capped, but still roof to the eave, so the snow runs down to them.
    const trimmed = new Uint8Array(n);
    const opaque = (x, y) => x >= 0 && y >= 0 && x < width && y < height && albedo[(y * width + x) * 4 + 3] >= 128;
    const blocked = (p) => (emissive && emissive[p * 4 + 3] > 25)
        || (material && material[p * 4 + 3] > 0 && NO_SNOW_MATERIALS.has(material[p * 4]));
    let lums = [];
    let metal = 0;
    let roofs = 0;
    for (let p = 0; p < n; p++) {
        const i = p * 4;
        if (albedo[i + 3] < 128 || blocked(p)) continue;
        let roof;
        if (occluder) {
            if (!(occluder[i + 3] > 0 && (occluder[i + 2] >> 6) === 3)) continue;
            // The face class says roof; the colour must agree (slate, metal
            // or the ink between them), so a mis-tag never snows a wall.
            roof = isSlateColour(albedo, i) || isMetalColour(albedo, i) || isInkColour(albedo, i);
        } else if (region) {
            if (!region[p]) continue;
            // Inside the authored roof its tiles, ink and pale glints are
            // roof; only vivid trim (a gold finial) stays bare, so no glint
            // is left as a speck in the snow.
            roof = sheet || isTileColour(albedo, i) || isInkColour(albedo, i) || !isVividColour(albedo, i);
        } else if (!isSlateColour(albedo, i)) {
            continue;
        } else {
            roof = true;
        }
        if (!roof) {
            trimmed[p] = 1;
            continue;
        }
        cls[p] = SLATE;
        roofs++;
        if (isMetalColour(albedo, i)) metal++;
    }
    // A face-tag speck: a small 4-connected knot of opaque texels the surface
    // channel tagged wall (or no face) lying wholly inside the roof, bordered
    // by roof on every side (never glass, fabric or fire). It is roof, so the
    // snow closes over it instead of leaving a hole and a false eave above.
    const speck = new Uint8Array(n);
    if (occluder) {
        const seen = new Uint8Array(n);
        const knot = [];
        for (let start = 0; start < n; start++) {
            if (cls[start] || trimmed[start] || seen[start] || albedo[start * 4 + 3] < 128) continue;
            knot.length = 0;
            knot.push(start);
            seen[start] = 1;
            let inside = true;
            for (let k = 0; k < knot.length; k++) {
                const p = knot[k];
                const x = p % width;
                const y = (p - x) / width;
                if (blocked(p)) inside = false;
                for (const [q, qx, qy] of [[p - 1, x - 1, y], [p + 1, x + 1, y], [p - width, x, y - 1], [p + width, x, y + 1]]) {
                    if (!opaque(qx, qy) || trimmed[q]) {
                        inside = false;
                    } else if (!cls[q] && !seen[q]) {
                        seen[q] = 1;
                        knot.push(q);
                    }
                }
            }
            if (!inside || knot.length > ROOF_SPECK) continue;
            for (const p of knot) {
                cls[p] = SLATE;
                speck[p] = 1;
                roofs++;
            }
        }
    }
    // Metal trim on a slate roof (ribs, rings, finials) is too steep and thin
    // to hold snow and stays bare; a roof that is mostly metal (the
    // Lighthouse's bronze cap) is the roof itself and takes it.
    const metalTrim = metal > 0 && metal < 0.3 * roofs;
    const metalRoof = metal > 0 && !metalTrim;
    for (let p = 0; p < n; p++) {
        if (!cls[p]) continue;
        if (metalTrim && isMetalColour(albedo, p * 4)) {
            cls[p] = NONE;
            trimmed[p] = 1;
        }
    }
    // A metal roof's finial is no roof: its spire (the rows above the cap's
    // ridge) and any thin vertical run, trim included, stay bare and
    // uncapped, and the cap's columns start under them.
    const spire = metalRoof ? metalSpire(cls.map((c, p) => (c || trimmed[p] ? 1 : 0)), width) : null;
    for (let p = 0; p < n; p++) {
        if (spire?.[p]) {
            cls[p] = NONE;
            trimmed[p] = 0;
        } else if (cls[p]) {
            lums.push(lumAt(albedo, p * 4));
        }
    }
    const lum = new Float32Array(n);
    if (lums.length) {
        lums.sort((a, b) => a - b);
        const lo = lums[Math.floor(lums.length * 0.03)];
        const hi = lums[Math.min(lums.length - 1, Math.floor(lums.length * 0.97))];
        const span = Math.max(1, hi - lo);
        // A sheet is one smooth lit plane: one luminance, so no joints or
        // courses inside it.
        for (let p = 0; p < n; p++) {
            if (cls[p]) lum[p] = sheet ? 255 : lumAt(albedo, p * 4);
        }
        // Darker than a roof neighbour on both sides by a joint step.
        const darker = (p, a, b) => cls[a] && cls[b] && lum[p] < lum[a] - JOINT_STEP && lum[p] < lum[b] - JOINT_STEP;
        for (let p = 0; p < n; p++) {
            if (!cls[p]) continue;
            const x = p % width;
            const y = (p - x) / width;
            rank[p] = sheet ? 0.75 : Math.max(0, Math.min(1, (lum[p] - lo) / span));
            // The roof's own outline (a texel touching open sky), ink, the
            // darkest shadow, and the 1-px joint lines between slates and
            // courses are joints; everything else is slate. A metal roof is
            // one smooth sheet in its own light: only its black ink lines
            // are joints, its dark bronze facets are the shaded pitch.
            if (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1)) cls[p] = JOINT;
            else if (sheet) continue;
            else if (metalRoof) {
                if (isInkColour(albedo, p * 4) && !isMetalShade(albedo, p * 4)) cls[p] = JOINT;
            } else if (isInkColour(albedo, p * 4) || rank[p] < SHADOW_RANK
                || (y > 0 && y + 1 < height && darker(p, p - width, p + width))
                || (x > 0 && x + 1 < width && darker(p, p - 1, p + 1))) cls[p] = JOINT;
        }
    }
    lums = null;
    // Each texel's pitch light: the mean slate rank in its window (a
    // summed-area table of slate rank and count).
    const sw = width + 1;
    const sumRank = new Float64Array(sw * (height + 1));
    const sumCount = new Uint32Array(sw * (height + 1));
    for (let y = 0; y < height; y++) {
        let rowRank = 0;
        let rowCount = 0;
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (cls[p] === SLATE) {
                rowRank += rank[p];
                rowCount++;
            }
            const s = (y + 1) * sw + x + 1;
            sumRank[s] = sumRank[s - sw] + rowRank;
            sumCount[s] = sumCount[s - sw] + rowCount;
        }
    }
    // Texels from a joint to the first slate along (dx, dy) over joint
    // texels only (Infinity: none within JOINT_REACH).
    const slateAt = (x, y, dx, dy) => {
        for (let d = 1; d <= JOINT_REACH; d++) {
            const nx = x + dx * d;
            const ny = y + dy * d;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) return Infinity;
            const c = cls[ny * width + nx];
            if (c === SLATE) return d;
            if (c !== JOINT) return Infinity;
        }
        return Infinity;
    };
    // A joint line at most JOINT_REACH texels thick between slates.
    const across = (x, y, dx, dy) => slateAt(x, y, -dx, -dy) + slateAt(x, y, dx, dy) - 1 <= JOINT_REACH;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!cls[p]) continue;
            const ax = Math.max(0, x - PLANE_RADIUS);
            const ay = Math.max(0, y - PLANE_RADIUS);
            const bx = Math.min(width, x + PLANE_RADIUS + 1);
            const by = Math.min(height, y + PLANE_RADIUS + 1);
            const count = sumCount[by * sw + bx] - sumCount[ay * sw + bx] - sumCount[by * sw + ax] + sumCount[ay * sw + ax];
            const total = sumRank[by * sw + bx] - sumRank[ay * sw + bx] - sumRank[by * sw + ax] + sumRank[ay * sw + ax];
            plane[p] = count ? total / count : rank[p];
            if (cls[p] === JOINT) {
                thin[p] = across(x, y, 1, 0) || across(x, y, 0, 1) ? 1 : 0;
                let lone = x > 0 && y > 0 && x + 1 < width && y + 1 < height;
                for (let k = 0; k < 9 && lone; k++) lone = k === 4 || cls[p + (Math.floor(k / 3) - 1) * width + (k % 3) - 1] === SLATE;
                if (lone) thin[p] = LONE;
            }
        }
    }
    // Where joint lines cross or thicken for a texel or two, the knot is too
    // wide along both axes yet no opening: a 4-connected knot of at most
    // JOINT_KNOT such joints, held all round by slate or thin joint, is thin
    // too, so a full cover shows no dark dots at the corners. So is a longer
    // knot that is a line, not an opening (no 3x3 of it all joint), inside
    // the roof (never against the sky, at most LINE_OFF_ROOF of its sides
    // on a wall or a mis-tagged texel): a deep course shadow, buried like a
    // joint rather than left as a black hole in the snow. A porthole or an
    // opening (3x3 and up) is larger and stays bare, and a ring around glass
    // is half on the glass.
    const seen = new Uint8Array(n);
    const knot = [];
    const inKnot = new Uint8Array(n);
    for (let start = 0; start < n; start++) {
        if (cls[start] !== JOINT || thin[start] || seen[start]) continue;
        knot.length = 0;
        knot.push(start);
        seen[start] = 1;
        let held = true;
        let sky = 0;
        let off = 0;
        let sides = 0;
        for (let k = 0; k < knot.length; k++) {
            const p = knot[k];
            const x = p % width;
            const y = (p - x) / width;
            for (const [q, inside, qx, qy] of [[p - 1, x > 0, x - 1, y], [p + 1, x + 1 < width, x + 1, y], [p - width, p >= width, x, y - 1], [p + width, p + width < n, x, y + 1]]) {
                if (!inside || cls[q] === NONE) {
                    held = false;
                    sides++;
                    if (!opaque(qx, qy)) sky++;
                    else if (!speck[q]) off++;
                } else if (cls[q] === JOINT && !thin[q] && !seen[q]) {
                    seen[q] = 1;
                    knot.push(q);
                } else if (!(cls[q] === JOINT && !thin[q])) {
                    sides++;
                }
            }
        }
        let line = occluder != null && sky === 0 && off <= LINE_OFF_ROOF * sides;
        if (line) {
            for (const p of knot) inKnot[p] = 1;
            for (const p of knot) {
                const x = p % width;
                if (x < 1 || x + 1 >= width || p < width || p + width >= n) continue;
                let core = true;
                for (let k = 0; k < 9 && core; k++) core = inKnot[p + (Math.floor(k / 3) - 1) * width + (k % 3) - 1] === 1;
                if (core) {
                    line = false;
                    break;
                }
            }
            for (const p of knot) inKnot[p] = 0;
        }
        if ((held && knot.length <= JOINT_KNOT) || line) for (const p of knot) thin[p] = 1;
    }
    // The roof's lit pitch: the 90th percentile of the slate's pitch light.
    const lights = [];
    for (let p = 0; p < n; p++) if (cls[p] === SLATE) lights.push(plane[p]);
    lights.sort((a, b) => a - b);
    const planeTop = lights.length ? lights[Math.floor(lights.length * 0.9)] : 1;
    // A slate texel lit clearly brighter than the one above starts a course
    // (a slate): its upper edge faces the sky.
    const stepUp = (p) => cls[p - width] !== SLATE || lum[p] - lum[p - width] > JOINT_STEP;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    const grow = (x, y) => {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
    };
    // Rows down each slate course, from its sky-facing lip, the course's run
    // length (lip to its last row) in that column, and the rows under the
    // roof's top. A metal roof (one sheet, no courses) counts its rows from
    // the column's top, over trim too, so its cap is one piece.
    const columns = metalRoof;
    const run = new Int16Array(n);
    const fromTop = new Int16Array(n);
    const inPitch = (q) => cls[q] !== NONE || trimmed[q] === 1;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const p = y * width + x;
            if (columns && inPitch(p)) row[p] = y > 0 && inPitch(p - width) ? row[p - width] + 1 : 0;
            if (cls[p] === NONE) continue;
            fromTop[p] = y > 0 && cls[p - width] !== NONE ? fromTop[p - width] + 1 : 0;
            if (!columns && cls[p] === SLATE) row[p] = y > 0 && !stepUp(p) ? row[p - width] + 1 : 0;
        }
        for (let y = height - 1; y >= 0; y--) {
            const p = y * width + x;
            if (columns ? !inPitch(p) : cls[p] !== SLATE) continue;
            const next = y + 1 < height && (columns ? inPitch(p + width) : cls[p + width] === SLATE) && row[p + width] === row[p] + 1;
            run[p] = next ? run[p + width] : row[p] + 1;
        }
    }
    // roofEdge: the upper-left-facing edges of the roof itself — a slate
    // texel whose upper or left neighbour is off the roof or the roof's own
    // outline (the ridge, the verge, a hip against the sky or a wall). The
    // joints between slates are not edges, so the course stays one line.
    const offRoof = (q, x, y) => x < 0 || y < 0 || cls[q] === NONE || (cls[q] === JOINT && (
        x === 0 || y === 0 || x + 1 >= width || y + 1 >= height
        || cls[q - 1] === NONE || cls[q + 1] === NONE || cls[q - width] === NONE || cls[q + width] === NONE));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (cls[p] === NONE) continue;
            grow(x, y);
            if (cls[p] !== SLATE) continue;
            if (offRoof(p - width, x, y - 1) || offRoof(p - 1, x - 1, y)) edge[p] = 1;
        }
    }
    // Silhouette caps: texels with open sky above whose neighbour tops lie
    // within one row (a ledge: crenels, ridges, sills) or two (a steep rock
    // shoulder, one row thinner). The 1-px ink outline stays on top of the
    // snow; the cap is the next rows down. `cap` = row under the outline
    // (+ CAP_STEEP on a steep shoulder).
    if (caps) {
        const top = new Uint8Array(n);
        const capOk = (p) => albedo[p * 4 + 3] >= 128 && !blocked(p) && !trimmed[p] && !spire?.[p] && !isVividColour(albedo, p * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                if (albedo[p * 4 + 3] >= 128 && !opaque(x, y - 1)) top[p] = 1;
            }
        }
        // |dy| to the nearest neighbour top in column x (3 when none within 2).
        const topRise = (x, y) => {
            if (x < 0 || x >= width) return 3;
            for (let d = 0; d <= 2; d++) {
                if ((y - d >= 0 && top[(y - d) * width + x]) || (y + d < height && top[(y + d) * width + x])) return d;
            }
            return 3;
        };
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                if (!top[p]) continue;
                const rise = Math.max(topRise(x - 1, y), topRise(x + 1, y));
                if (rise > 2) continue;
                const i = p * 4;
                const ink = Math.max(albedo[i], albedo[i + 1], albedo[i + 2]) < INK_VALUE;
                const start = ink ? y + 1 : y;
                for (let k = 0; k < 3 && start + k < height; k++) {
                    const q = p + (start - y + k) * width;
                    if (!capOk(q) || cls[q] !== NONE || cap[q] >= 0) break;
                    cap[q] = k + (rise === 2 ? CAP_STEEP : 0);
                    grow(x, start + k);
                }
            }
        }
    }
    // Drip points: the lowest roof texel (trim included: a cornice's lip) of
    // evenly spaced eave columns, on a pitch at least DRIP_MIN_PITCH rows
    // deep (a main roof's eave, never the tip of a spire or a finial).
    const onRoof = (q) => cls[q] !== NONE || trimmed[q] === 1;
    const eaves = [];
    for (let x = 0; x < width; x++) {
        for (let y = height - 1; y >= 0; y--) {
            const p = y * width + x;
            if (!onRoof(p)) continue;
            let pitch = 0;
            while (y - pitch >= 0 && onRoof(p - pitch * width)) pitch++;
            if (y + 1 < height && !onRoof(p + width) && pitch >= DRIP_MIN_PITCH) eaves.push({ x, y });
            break;
        }
    }
    const drips = [];
    const count = eaves.length >= 48 ? 4 : eaves.length >= 12 ? 3 : 0;
    for (let k = 1; k <= count; k++) {
        const pick = eaves[Math.min(eaves.length - 1, Math.floor((eaves.length * k) / (count + 1)))];
        drips.push({ x: pick.x, y: pick.y, phase: hash2(pick.x, pick.y) % ROOF_DRIP_FRAMES });
    }
    if (x1 < 0) return null;
    return { width, height, left: x0, top: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pitch: columns, cls, rank, plane, planeTop, row, run, fromTop, cap, edge, thin, trimmed, drips };
}

/** Wetness → wet-course quantum 0 (dry) … ROOF_WET_QUANTA. */
export function roofWetQuantum(wetness) {
    const wet = Number(wetness) || 0;
    if (wet <= WET_FLOOR) return 0;
    return Math.max(1, Math.min(ROOF_WET_QUANTA, Math.ceil(wet * ROOF_WET_QUANTA - 1e-9)));
}

// The snow stop of a texel on a pitch whose light (mean slate rank) is
// `plane`: the roof's lit pitch (`top`) at the top stop, one stop down per
// PLANE_STEP darker to at most two stops down, 2x2-dithered only right at
// the step, so the planes of a full cover keep the baked upper-left key.
function planeStop(plane, top, x, y) {
    return Math.max(2, Math.min(4, 4 - Math.round((top - plane) / PLANE_STEP + bayer2(x, y) * 0.3)));
}

/**
 * Pure: paints the weather of `map` at (`bucket`, `wetQ`) into `out`, an
 * RGBA byte array of the map's bounding box (map.w × map.h), transparent
 * where nothing lies. Returns the texels written.
 */
export function paintRoofWeather(map, albedo, out, { bucket = 0, wetQ = 0 } = {}) {
    const depth = COURSE_DEPTH[Math.max(0, Math.min(4, bucket | 0))];
    const capDepth = CAP_DEPTH[Math.max(0, Math.min(4, bucket | 0))];
    const q = Math.max(0, Math.min(ROOF_WET_QUANTA, wetQ | 0));
    const wet = q > 0 ? WET[q - 1] : null;
    const sheen = WET_SHEEN[q];
    const { width, cls, rank, plane, planeTop, row, run, fromTop, cap, edge, thin, trimmed } = map;
    const share = Math.max(0, Math.min(4, bucket | 0)) / 4;
    // The eave is where the roof ends on a wall or open sky; trim (a
    // cornice, a gold ring) is still roof, so the snow runs down to it.
    const offRoof = (y, p) => y >= map.height || (cls[p] === NONE && !trimmed[p]);
    let written = 0;
    const put = (x, y, c) => {
        const o = ((y - map.top) * map.w + (x - map.left)) * 4;
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = 255;
        written++;
    };
    for (let y = map.top; y < map.top + map.h; y++) {
        for (let x = map.left; x < map.left + map.w; x++) {
            const p = y * width + x;
            const c = cls[p];
            if (depth && c !== NONE) {
                // The eave keeps its slate: roof texels with no roof one or
                // two rows below.
                const below1 = y + 1 < map.height ? cls[p + width] : NONE;
                const eave = offRoof(y + 1, p + width) || offRoof(y + 2, p + 2 * width);
                if (!eave) {
                    // The pitch's stop, dithered 2x2 where two pitches meet,
                    // one stop up or down on the texel's own highlight or
                    // shadow line.
                    let stop = planeStop(plane[p], map.planeTop, x, y);
                    // A slate course fills `depth` rows from its lip; a long
                    // smooth pitch fills the same share of its run, so a
                    // sheet roof takes a cap that grows down from the ridge,
                    // and so does every column of a metal roof (`map.pitch`),
                    // joints and all. The next row is an ordered 2x2 dither.
                    let lies = false;
                    if (c === SLATE || (map.pitch && thin[p])) {
                        const reach = Math.max(depth, Math.floor(run[p] * share));
                        lies = row[p] < reach || (row[p] === reach && ((x + y) & 1) === 0);
                    }
                    if (c === SLATE && lies) {
                        if (rank[p] > plane[p] + DETAIL_RANK) stop += 1;
                        else if (rank[p] < plane[p] - DETAIL_RANK) stop -= 1;
                        // A full cover: the texel over a joint steps down for thickness.
                        if (depth === Infinity && below1 === JOINT) stop -= 1;
                        put(x, y, SNOW[Math.max(0, Math.min(4, stop))]);
                        continue;
                    }
                    if (c === JOINT && thin[p] && (depth === Infinity || lies)) {
                        // A buried joint, three stops under its pitch, so the
                        // courses still read through the cover; a lone speck
                        // lies flush with it. Only thin joints: glass and
                        // openings stay bare.
                        put(x, y, SNOW[Math.max(0, thin[p] === LONE ? stop : stop - 3)]);
                        continue;
                    }
                }
            }
            if (capDepth && cap[p] >= 0) {
                const k = cap[p] & (CAP_STEEP - 1);
                const reach = cap[p] >= CAP_STEEP ? capDepth - 1 : capDepth;
                if (k < reach) {
                    // The sky-facing row is the lit stop, the rows under it
                    // step down for thickness.
                    put(x, y, SNOW[4 - Math.min(2, k)]);
                    continue;
                }
            }
            if (!wet || c !== SLATE || rank[p] < WET_MIN_RANK) continue;
            if (edge[p]) {
                put(x, y, wet);
            } else if (fromTop[p] < sheen && row[p] % 3 === 0 && plane[p] >= planeTop - PLANE_STEP && (((x >> 1) + y) & 1) === 0) {
                // Sky caught on a lit pitch's course lips under the ridge, in 2-texel cells.
                put(x, y, WET[3]);
            }
        }
    }
    return written;
}

/**
 * Pure: the drip strip of `map` — ROOF_DRIP_FRAMES frames side by side, each
 * `box.w × box.h`, every point at its own phase. Returns `{ data, box }` or
 * null when the roof has no drip points.
 */
export function paintRoofDrips(map) {
    if (!map?.drips?.length) return null;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const d of map.drips) {
        x0 = Math.min(x0, d.x);
        x1 = Math.max(x1, d.x);
        y0 = Math.min(y0, d.y + 1);
        y1 = Math.max(y1, d.y + DRIP_REACH);
    }
    const box = { left: x0, top: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const stripW = box.w * ROOF_DRIP_FRAMES;
    const data = new Uint8ClampedArray(stripW * box.h * 4);
    const set = (x, y, c) => {
        if (y < 0 || y >= box.h) return;
        const o = (y * stripW + x) * 4;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = 255;
    };
    for (let f = 0; f < ROOF_DRIP_FRAMES; f++) {
        for (const d of map.drips) {
            const step = DRIP_FALL[(f + d.phase) % ROOF_DRIP_FRAMES];
            if (!step) continue;
            const x = f * box.w + d.x - box.left;
            const head = d.y + step[0] - box.top;
            // The head, its tail texel(s) above it (never up into the eave),
            // and the dark texel under it.
            set(x, head, step[1] === 3 ? DRIP_BEAD : WET[step[1]]);
            for (let t = 1; t <= step[2] && step[0] - t > 0; t++) set(x, head - t, WET[3]);
            set(x, head + 1, DRIP_SHADE);
        }
    }
    return { data, box };
}

/**
 * Pure: snow on a prop's roof, in place. Returns the texels changed. Used by
 * PropWinter for props with a `roof`: `true` (the well: the slate colour
 * rule) or `{ poly | polys, sheet, caps }` — the roof's polygon (or several:
 * the gatehouse's two cones) in sprite px (tile colours and ink inside it
 * are roof; a `sheet` takes all of it as one smooth cloth; no polygon, no
 * roof texels), and `caps` for silhouette caps on crenels and copings.
 */
export function roofSnowPixels(data, width, height, bucket, roof = true) {
    if (!(bucket > 0) || !roof) return 0;
    const spec = roof === true ? null : roof;
    const region = spec ? polygonMask(spec.polys || (spec.poly ? [spec.poly] : []), width, height) : null;
    const map = roofWeatherMap({ width, height, albedo: data, region, sheet: spec?.sheet === true, caps: spec?.caps === true });
    if (!map) return 0;
    const out = new Uint8ClampedArray(map.w * map.h * 4);
    const written = paintRoofWeather(map, data, out, { bucket });
    for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
            const o = (y * map.w + x) * 4;
            if (!out[o + 3]) continue;
            const i = ((y + map.top) * width + x + map.left) * 4;
            data[i] = out[o];
            data[i + 1] = out[o + 1];
            data[i + 2] = out[o + 2];
        }
    }
    return written;
}

// 1 on the texels whose centres lie inside any of `polys` ([[[x, y], …]],
// sprite px).
function polygonMask(polys, width, height) {
    const mask = new Uint8Array(width * height);
    for (const poly of polys) {
        for (let y = 0; y < height; y++) {
            const py = y + 0.5;
            for (let x = 0; x < width; x++) {
                const px = x + 0.5;
                let inside = false;
                for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                    const [xi, yi] = poly[i];
                    const [xj, yj] = poly[j];
                    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
                }
                if (inside) mask[y * width + x] = 1;
            }
        }
    }
    return mask;
}

function readPixels(image, w, h) {
    if (!image || typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;
    return data;
}

function sidecarUrl(albedo, suffix) {
    const src = typeof albedo?.src === 'string' ? albedo.src : '';
    return src ? src.replace(/\.png(?=([?#]|$))/, `.${suffix}.png`) : '';
}

function loadImage(url) {
    return new Promise((resolve) => {
        if (!url || typeof Image === 'undefined') {
            resolve(null);
            return;
        }
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

function canvasOf(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
}

/**
 * The per-renderer roof weather: `sync` once a frame after the ground state;
 * `patch(type)` answers the landmark's snow/wet canvas for the current state
 * and `drip(type)` its drip strip frame, or null (clear weather draws
 * nothing, so a dry roof is the authored sprite).
 */
export class RoofWeather {
    constructor(assets) {
        this.assets = assets;
        this.bucket = 0;
        this.wetQ = 0;
        this.raining = false;
        this.dripFrame = 0;
        this._maps = new Map();
        this._patches = new Map();
        this._drips = new Map();
    }

    get key() {
        return `${this.bucket}|${this.wetQ}`;
    }

    /**
     * `atmosphere` (its `effectiveDate` and `weather.precipitation`), the
     * C-W2 `ground` state, the renderer's motion scale and MotionClock time.
     */
    sync(atmosphere, ground, motionScale = 1, motionTimeMs = 0) {
        const date = atmosphere?.effectiveDate;
        const winter = date instanceof Date && !Number.isNaN(date.getTime()) && isWinterMonth(date.getMonth());
        const precipitation = Number(atmosphere?.weather?.precipitation) || 0;
        const raining = !winter && precipitation > PRECIPITATING;
        // Live rain wets the slate at once; the ground state keeps it wet
        // after (the same rule as the street's `_surfaceWetness`).
        const wetness = winter ? Number(ground?.wetness) || 0 : Math.max(raining ? precipitation : 0, Number(ground?.wetness) || 0);
        this.bucket = snowBucketOf(ground?.snowCover);
        this.wetQ = roofWetQuantum(wetness);
        this.raining = raining && motionScale > 0;
        this.dripFrame = Math.floor(Math.max(0, Number(motionTimeMs) || 0) / ROOF_DRIP_STEP_MS) % ROOF_DRIP_FRAMES;
    }

    // The weather map of `type`, loading its sidecars on first use (null
    // until ready and for landmarks with nothing that takes weather).
    map(type) {
        const cached = this._maps.get(type);
        if (cached !== undefined) return cached === 'loading' ? null : cached;
        const id = `building.${type}`;
        const albedo = this.assets?.get?.(id);
        const dims = this.assets?.getDims?.(id);
        const entry = this.assets?.getEntry?.(id);
        if (!albedo || !dims || typeof document === 'undefined') return null;
        this._maps.set(type, 'loading');
        const version = this.assets.assetVersion || '';
        const companion = (channel, flag) => {
            if (entry?.[flag] !== true) return Promise.resolve(null);
            const image = this.assets.getCompanion?.(id, channel);
            return image ? Promise.resolve(image) : loadImage(sidecarUrl(albedo, channel));
        };
        Promise.all([
            entry?.surfaceCode === true ? companion('occluder', 'occluderSidecar') : Promise.resolve(null),
            companion('material', 'materialSidecar'),
            companion('emissive', 'emissiveSidecar'),
        ]).then(([occluderImage, materialImage, emissiveImage]) => {
            if ((this.assets.assetVersion || '') !== version) {
                this._maps.delete(type);
                return;
            }
            const width = dims.w;
            const height = dims.h;
            const sized = (image) => (image && image.width === width && image.height === height ? image : null);
            const pixels = readPixels(albedo, width, height);
            const occluder = sized(occluderImage);
            // A landmark with no surface channel has no roof class: nothing
            // lies on it until 2.3 covers it.
            const map = occluder
                ? roofWeatherMap({
                    width,
                    height,
                    albedo: pixels,
                    occluder: readPixels(occluder, width, height),
                    material: sized(materialImage) ? readPixels(materialImage, width, height) : null,
                    emissive: sized(emissiveImage) ? readPixels(emissiveImage, width, height) : null,
                })
                : null;
            if (map) {
                map.albedo = pixels;
                const crop = (image) => {
                    if (!sized(image)) return null;
                    const canvas = canvasOf(map.w, map.h);
                    canvas.getContext('2d').drawImage(image, map.left, map.top, map.w, map.h, 0, 0, map.w, map.h);
                    return canvas;
                };
                map.channels = { material: crop(materialImage), occluder: crop(occluder) };
            }
            this._maps.set(type, map);
        });
        return null;
    }

    /**
     * The snow / wet-course patch of `type`: `{ canvas, left, top, w, h, key,
     * revision, channels }` in sprite texels, or null in clear, dry weather.
     */
    patch(type) {
        if (!this.bucket && !this.wetQ) return null;
        const map = this.map(type);
        if (!map?.albedo) return null;
        const key = this.key;
        let entry = this._patches.get(type);
        if (entry?.key === key) return entry.empty ? null : entry;
        if (!entry) {
            entry = { canvas: canvasOf(map.w, map.h), left: map.left, top: map.top, w: map.w, h: map.h, key: '', revision: 0, channels: map.channels, empty: false };
            this._patches.set(type, entry);
        }
        const ctx = entry.canvas.getContext('2d');
        const image = ctx.createImageData(map.w, map.h);
        const written = paintRoofWeather(map, map.albedo, image.data, { bucket: this.bucket, wetQ: this.wetQ });
        ctx.putImageData(image, 0, 0);
        entry.key = key;
        entry.empty = written === 0;
        entry.revision++;
        return entry.empty ? null : entry;
    }

    /**
     * The drip strip of `type` while it rains (never under reduced motion):
     * `{ canvas, left, top, w, h, sx, frames }` (the frame at `sx`), or null.
     */
    drip(type) {
        if (!this.raining) return null;
        const map = this.map(type);
        if (!map?.drips?.length) return null;
        let entry = this._drips.get(type);
        if (!entry) {
            const strip = paintRoofDrips(map);
            if (!strip) return null;
            const canvas = canvasOf(strip.box.w * ROOF_DRIP_FRAMES, strip.box.h);
            const ctx = canvas.getContext('2d');
            const image = ctx.createImageData(canvas.width, canvas.height);
            image.data.set(strip.data);
            ctx.putImageData(image, 0, 0);
            entry = { canvas, ...strip.box, sx: 0, frames: ROOF_DRIP_FRAMES };
            this._drips.set(type, entry);
        }
        entry.sx = this.dripFrame * entry.w;
        return entry;
    }

    release() {
        for (const entry of this._patches.values()) releaseCanvasBackingStore(entry.canvas);
        for (const entry of this._drips.values()) releaseCanvasBackingStore(entry.canvas);
        this._patches.clear();
        this._drips.clear();
        this._maps.clear();
    }
}
