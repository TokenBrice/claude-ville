// 1.5 — golden-hour and sunrise raking shadows, without normals.
//
// The low sun reads through the C2 grade: its split tone already warms the
// baked upper-left highlights; here the cast shadows lengthen and turn violet.
// `rake` comes from the same grade — the evaluator's authored per-key rake,
// gated here by how much direct sun is left — so it peaks at golden hour and
// at sunrise, sits at 0 through the middle of the day and at night, and
// flattens under overcast (the weather rows scale it down with the split).
//
// Every cast is a stepped stamp baked once per sun bucket (rake in eighths,
// shadow angle in 1/16 rad): flat alpha courses on the world texel grid,
// 2-texel rows, no gradients. Buildings, trees and villagers share the same
// cast language, and both backends blit the same canvases (the resident path
// uploads a stamp only when its bucket key changes). No per-frame shadow
// work beyond placing the cached stamps.
//
// SD-1 (the Sundial, look `sd1`). Above 0 the sun's shade leaves the stamps:
// buildings, the wall, trees and tall props throw it through the world-locked
// shade field (ShadeField.js) as ONE ground layer (`frameShadeLayer`), in the
// shapes of their masses, along the same authored direction fan but at the
// length the real sun's elevation gives (`cast.shade`). The stamps keep the
// contact course only (`cast.contact`, `stampCastFor`), and a villager in the
// sun throws a trail of the same length (`villagerCastLighting`). At 0 every
// function here returns what it did before the look existed.

import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { COAST_FIELD_FLAGS } from './CoastBake.js';
import { lookStrength, lookStrengthsVersion } from './LookStrengths.js';
import { shadeCoverageAt, shadeFieldFor, shadeFieldTexture } from './ShadeField.js';
import { effectBudgetMode } from './gpu/GpuWorldPolicy.js';
import { LANTERN_ID_PREFIX } from './CarriedLantern.js';

const COLD = [15, 22, 30];      // #0f161e — the midday contact shadow
const VIOLET = [42, 35, 70];    // #2a2346 — the golden-hour shadow
const ROW = 2;                  // stepped ellipse rows, in texels

// SD-1. One px of sprite height in ground px (world x; world y is half of
// it): the 2:1 view looks down at 30 degrees, so height draws at cos 30.
const HEIGHT_GROUND_PX = 2 / Math.sqrt(3);
// The longest shade, in ground px per px of a caster's height, at `sd1len`
// 0 and 1. The real length eases into it (real / (1 + (real / cap)^4)^(1/4)):
// a shadow under about half the cap is true, a low sun's stops growing.
export const SHADE_LENGTH_CAP = Object.freeze([1, 3.5]);
const SHADE_CAP_KNEE = 4;
// Buckets a field is built for: direction per radian, length per unit.
const SHADE_ANGLE_STEPS = 64;
const SHADE_LENGTH_STEPS = 32;
// The shade's density: a shadow that reads at tier 1 on lit grass and stone.
// It keeps that weight all day: a low sun is a weaker light, so its longer
// shade is no denser.
export const SHADE_ALPHA = 0.38;
// The grade's sun band at which the shade is whole, and gone.
const SHADE_SUN_FULL = 0.8;
const SHADE_SUN_NONE = 0.2;
// The real sun's elevation (degrees) from which its shade is whole. Under it
// the shade thins with the sun and is gone at the horizon: the grade's sun
// band outlasts the sun at both ends of the day, and its shade must not.
export const SHADE_SUN_RISEN_DEG = 4;
// SD-2 (look `sd2`) — what a receiver in cast shade gives up of its sun-band
// value at strength 1 (a wall, a roof or a body under another mass's shadow):
// about what the ground's own shade takes, so a shadow keeps its weight as it
// climbs a wall. A face turned from the sun gives up nothing: the art already
// paints that side darker.
export const SHADE_RECEIVER_CAST = 0.3;

let _castGrade = null;
let _castLighting = null;
let _castSolar = null;
let _castLooks = -1;
let _castTier = true;
let _cast = null;
// False while the resident ladder has shed the shade (EFFECT_BUDGET
// `sundial-shade`: MINIMAL): every cast is then the sun stamps' again.
let _shadeTier = true;
let _frameCast = null;
let _frameShade = null;
// SD-2 — the frame's receiver steps while the resident path reads the field
// (null: the look off, Canvas, MINIMAL, or the texels not built yet).
let _frameReceivers = null;
const _sunShadeFeed = { texture: null, cast: 1, sweepX: 0, sweepY: 0 };
// The field whose texels the scene pass holds (a newer one waits a frame).
let _sunShadeHeld = null;
let _villagerCastSource = null;
let _villagerCastClip = false;
let _villagerCast = null;

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** 0..1 in eighths: how raking the sun is under this grade. */
export function rakeForGrade(grade) {
    const direct = clamp(finite(grade?.daylight, 1) / 0.5);
    // The power keeps the long light to the last hours around the keys.
    return Math.round(Math.pow(clamp(finite(grade?.rake, 0)) * direct, 1.5) * 8) / 8;
}

/**
 * The cast state for one atmosphere snapshot, memoized on its grade and
 * lighting objects. `length` scales cast distance (0.72 at midday as before,
 * up to 2.3 at golden hour); at night the moon keeps the lighting model's
 * own length. `key` changes only when a baked stamp would change.
 *
 * SD-1 adds two fields, both null while `sd1` is 0:
 *   shade    the sun's shade for the shade field, or null with no sun to
 *            throw one (night, rain, overcast, a sun at or under the
 *            horizon): `{ strength, angle, length, sx, sy, alpha, color,
 *            key }`. `angle` is the same authored fan in 1/64 rad; `length`
 *            the ground px a px of height throws, from the real sun's
 *            elevation (`atmosphere.solar.elevationDeg`), eased into the
 *            `sd1len` cap, in 1/32; `sx`, `sy` that sweep in world px;
 *            `alpha` the layer's strength (`sd1` x SHADE_ALPHA x the sun's
 *            share, in 1/32: the grade's sun band times the real sun's
 *            height, whole from SHADE_SUN_RISEN_DEG up, in eighths); `key`
 *            moves only when the field must be rebuilt.
 *   contact  the cast the stamps bake instead while the sun's shade is the
 *            field's: the same colour and angle with no rake, no sun and the
 *            contact alpha alone, or null when this cast throws nothing along
 *            the sun anyway (a night's cast is its own contact).
 */
export function castLightingFor(atmosphere) {
    const grade = atmosphere?.lightGrade || null;
    const lighting = atmosphere?.lighting || null;
    const solar = atmosphere?.solar || null;
    const looks = lookStrengthsVersion();
    if (_cast && grade === _castGrade && lighting === _castLighting && solar === _castSolar && looks === _castLooks && _shadeTier === _castTier) return _cast;
    const rake = rakeForGrade(grade);
    const night = finite(grade?.night, 0) >= 0.5;
    const rawAngle = Number.isFinite(lighting?.shadowAngleRad) ? lighting.shadowAngleRad : 0.28;
    const angle = Math.round(rawAngle * 16) / 16;
    const length = night ? clamp(finite(lighting?.shadowLength, 1), 0.45, 2.4) : 0.72 + 1.6 * rake;
    const lengthBucket = Math.round(length * 8) / 8;
    const color = COLD.map((channel, index) => Math.round(channel + (VIOLET[index] - channel) * rake));
    // A thrown canopy shadow needs a visible sun: the grade's sun band is 0
    // at night and under rain/storm/overcast, which leave contact only.
    const sun = finite(grade?.sunBand, 1) >= 0.5;
    const contactAlpha = finite(lighting?.shadowAlpha, 0.22);
    const strength = _shadeTier ? lookStrength('sd1') : 0;
    const shade = strength > 0 ? shadeLightingFor(strength, grade, solar, rawAngle, color) : null;
    const restLength = night ? lengthBucket : Math.round(0.72 * 8) / 8;
    const contact = strength > 0 && (rake > 0 || sun)
        ? Object.freeze({
            rake: 0,
            angle,
            length: restLength,
            sun: false,
            alpha: Math.min(0.74, contactAlpha),
            color,
            // The colour still follows the rake, so the rake stays in the key.
            key: `c${rake}|${angle}|${restLength}`,
            contactOnly: true,
        })
        : null;
    _castGrade = grade;
    _castLighting = lighting;
    _castSolar = solar;
    _castLooks = looks;
    _castTier = _shadeTier;
    _cast = Object.freeze({
        rake,
        angle,
        length: lengthBucket,
        sun,
        // The low sun throws a denser cast: the lighting model's contact
        // alpha (0.12–0.42) gains up to 0.44 at full rake, so the long violet
        // courses still read on dark grass after the golden-hour grade.
        alpha: Math.min(0.74, contactAlpha + 0.44 * rake),
        color,
        key: `${rake}|${angle}|${lengthBucket}|${sun ? 's' : 'o'}`,
        shade,
        contact,
    });
    return _cast;
}

// SD-1 — the shade the sun throws under this grade, or null with no sun.
function shadeLightingFor(strength, grade, solar, rawAngle, color) {
    const elevation = finite(solar?.elevationDeg, 45);
    // The sun's share, in eighths: the grade's sun band times the real sun's
    // height, so a sun at or under the horizon throws no shade of any kind.
    const share = Math.round(clamp((finite(grade?.sunBand, 1) - SHADE_SUN_NONE) / (SHADE_SUN_FULL - SHADE_SUN_NONE))
        * clamp(elevation / SHADE_SUN_RISEN_DEG) * 8) / 8;
    const alpha = Math.round(SHADE_ALPHA * strength * share * 32) / 32;
    if (!(alpha > 0)) return null;
    const [short, long] = SHADE_LENGTH_CAP;
    const cap = short + (long - short) * clamp(lookStrength('sd1len'));
    // A sun on the horizon throws the cap.
    const real = HEIGHT_GROUND_PX / Math.tan(Math.max(1, elevation) * Math.PI / 180);
    const eased = real / Math.pow(1 + Math.pow(real / cap, SHADE_CAP_KNEE), 1 / SHADE_CAP_KNEE);
    const lengthBucket = Math.max(1, Math.round(eased * SHADE_LENGTH_STEPS));
    const angleBucket = Math.round(rawAngle * SHADE_ANGLE_STEPS);
    const length = lengthBucket / SHADE_LENGTH_STEPS;
    const angle = angleBucket / SHADE_ANGLE_STEPS;
    // SD-2 — the step a receiver in cast shade drops under this sun (a
    // multiplier, in 1/64).
    const receive = clamp(lookStrength('sd2')) * share;
    return Object.freeze({
        strength,
        angle,
        length,
        sx: Math.cos(angle) * length,
        sy: Math.sin(angle) * length * 0.5,
        alpha,
        color,
        key: `${angleBucket}|${lengthBucket}`,
        receivers: receive > 0 ? Object.freeze({ cast: 1 - Math.round(receive * SHADE_RECEIVER_CAST * 64) / 64 }) : null,
    });
}

/**
 * The cast a stamp is baked and drawn with: the cast itself, or its contact
 * twin while the shade field owns the sun's shade (SD-1).
 */
export function stampCastFor(cast) {
    return cast?.contact || cast;
}

/**
 * Called once per frame by the frame renderer; read by the villager marks.
 * SD-1 — with the `renderer` it also resolves the frame's shade layer. On
 * the Canvas backend (`canvas`) the layer is swapped whole, never shown
 * part-painted, and `water` (the coast bake's water fields) bakes the 2.9
 * over-water rule into it, which the resident shader applies live.
 * SD-2 — on the resident backends it also asks for the receivers' texels
 * while the ladder keeps them (EFFECT_BUDGET `sundial-receivers`).
 */
export function setFrameCastLighting(cast, renderer = null, canvas = false, water = null) {
    let receiverTier = false;
    if (renderer) {
        // The ladder level, as the frame's other budgeted looks read it.
        const level = renderer.gpuWorld?._compositeQualityLevel
            ?? (renderer.postFx?.isActive?.() === true ? (renderer.postFx?.ladder?.effectiveLevel ?? 0) : 0);
        const tier = effectBudgetMode('sundial-shade', level) === 'on';
        if (tier !== _shadeTier) {
            _shadeTier = tier;
            cast = castLightingFor(renderer._lastAtmosphere);
        }
        receiverTier = !canvas && effectBudgetMode('sundial-receivers', level) === 'on';
    }
    _frameCast = cast || null;
    _frameReceivers = null;
    const shade = cast?.shade || null;
    // No shade to resolve and no field to let go of: nothing to do.
    if (!renderer || (!shade && !renderer._shadeFieldState)) {
        _frameShade = null;
        return;
    }
    const receivers = receiverTier && shade?.receivers ? shade.receivers : null;
    _frameShade = shadeFieldFor(renderer, shade, {
        water: canvas && water
            ? { fields: water, waterBit: COAST_FIELD_FLAGS.water, coveredBit: COAST_FIELD_FLAGS.covered, share: GROUND_CAST_WATER_SHARE }
            : null,
        atomic: canvas,
        receivers: Boolean(receivers),
    });
    if (receivers && _frameShade?.field?.texels) _frameReceivers = receivers;
}

/**
 * SD-1 — the shade the sundial throws under this atmosphere whatever the
 * resident ladder holds, or null (the look off, no sun): the frost bake lies
 * in it (FrostMelt), and a bake must not follow the ladder.
 */
export function sundialShadeFor(atmosphere) {
    const cast = castLightingFor(atmosphere);
    const strength = lookStrength('sd1');
    if (cast.shade || !(strength > 0)) return cast.shade;
    const angle = atmosphere?.lighting?.shadowAngleRad;
    return shadeLightingFor(strength, atmosphere?.lightGrade || null, atmosphere?.solar || null,
        Number.isFinite(angle) ? angle : 0.28, cast.color);
}

/**
 * SD-2 — what the resident scene pass binds this frame (gpu/SunShade.js
 * `resolveSunShade`), or null: the field's typed texture (`texture`), the
 * `cast` step, and the field's own sweep (world px of shadow per px of
 * height).
 */
export function frameSunShade() {
    if (!_frameReceivers) {
        _sunShadeHeld = null;
        return null;
    }
    let field = _frameShade.field;
    // A field that has just landed uploads its ground layer on this frame; its
    // texels take the next, so the two 8.6 MB uploads never share a frame. The
    // pass keeps the texture it holds meanwhile (its revision has not moved).
    if (_sunShadeHeld && _sunShadeHeld !== field && _sunShadeHeld.texture && !field.texture) {
        field.texture = shadeFieldTexture(field);
        field = _sunShadeHeld;
    } else {
        _sunShadeHeld = field;
    }
    _sunShadeFeed.texture = field.texture || (field.texture = shadeFieldTexture(field));
    _sunShadeFeed.cast = _frameReceivers.cast;
    _sunShadeFeed.sweepX = field.sweep.sx;
    _sunShadeFeed.sweepY = field.sweep.sy;
    return _sunShadeFeed;
}

export function frameCastLighting() {
    return _frameCast;
}

/**
 * SD-1 — this frame's shade layer, or null: `{ field, canvas, revision }`
 * (ShadeField `shadeFieldFor`), the canvas one texel per field cell in the
 * cast colour, to be laid over the field's rect at `frameCastLighting()
 * .shade.alpha`. Null until the first field is built.
 */
export function frameShadeLayer() {
    return _frameCast?.shade ? _frameShade : null;
}

/** Canvas: the shade layer on the ground, in world space (the caller holds the camera transform). */
export function drawShadeLayer(ctx) {
    const layer = frameShadeLayer();
    if (!ctx || !layer) return;
    const { field, canvas } = layer;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = _frameCast.shade.alpha;
    ctx.drawImage(canvas, field.originX, field.originY, field.cols * field.cellW, field.rows * field.cellH);
    ctx.restore();
}

/**
 * SD-1 — the cast a villager's contact stamp is built from at world (x, y):
 * the frame's cast itself while `sd1` is 0. Above 0, the contact twin where
 * the field already shades the ground (a body in shade throws no shadow of
 * its own) or no sun is out, and otherwise a twin whose trail runs along the
 * shade's sweep at the shade's length and density.
 *
 * SD-2 — while the resident path reads the field (`frameSunShade`), every
 * body in the sun's hours gets the trail twin, marked `clip` with its contact
 * twin as `base`: the trail is then a record of its own, hidden per fragment
 * wherever the field already shades the ground, so it never darkens a
 * building's shade a second time and a body crossing a shade edge hands its
 * shadow over without a pop.
 */
export function villagerCastLighting(x, y, cast = _frameCast) {
    if (!cast?.contact) return cast;
    const shade = cast.shade;
    if (!shade) return cast.contact;
    const clip = cast === _frameCast && _frameReceivers !== null;
    if (!clip && shadeCoverageAt(_frameShade?.field, x, y) >= 0.5) return cast.contact;
    if (_villagerCastSource !== cast || _villagerCastClip !== clip) {
        _villagerCastSource = cast;
        _villagerCastClip = clip;
        // It keeps the frame's rake, so a raking sun still outranks the 2.8
        // lamp casts (`pointCastFor`).
        _villagerCast = Object.freeze({
            ...cast.contact,
            rake: cast.rake,
            trail: shade,
            key: `v${cast.contact.key}|${shade.key}|${Math.round(shade.alpha * 32)}`,
            ...(clip ? { clip: true, base: cast.contact } : null),
        });
    }
    return _villagerCast;
}

function makeCanvas(width, height) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    return canvas;
}

/**
 * Rasterise stepped ellipses `{ x, y, rx, ry, alpha }` (texel coordinates
 * relative to the anchor) into one canvas. Where stamps overlap the pixel
 * takes the strongest course instead of summing, so the cast reads as flat
 * courses. Returns `{ canvas, offsetX, offsetY }` — the canvas' top-left
 * relative to the anchor.
 */
export function rasterizeCourses(stamps, rgb) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of stamps) {
        minX = Math.min(minX, Math.floor(s.x - s.rx));
        maxX = Math.max(maxX, Math.ceil(s.x + s.rx));
        minY = Math.min(minY, Math.floor((s.y - s.ry) / ROW) * ROW - ROW);
        maxY = Math.max(maxY, Math.ceil((s.y + s.ry) / ROW) * ROW + ROW);
    }
    if (!Number.isFinite(minX)) return null;
    const width = maxX - minX;
    const height = maxY - minY;
    const canvas = makeCanvas(width, height);
    if (!canvas) return null;
    const alpha = new Uint8Array(width * height);
    for (const s of stamps) {
        const a = Math.round(clamp(s.alpha) * 255);
        const ry = Math.max(1, s.ry);
        for (let row = -Math.ceil(ry / ROW) * ROW; row <= ry; row += ROW) {
            const normalized = (row + ROW / 2) / ry;
            if (Math.abs(normalized) >= 1) continue;
            const half = s.rx * Math.sqrt(1 - normalized * normalized);
            const x0 = Math.round(s.x - half) - minX;
            const x1 = Math.round(s.x + half) - minX;
            // Rows share one even grid across stamps, so courses stack cleanly.
            const y0 = Math.round((s.y + row) / ROW) * ROW - minY;
            for (let y = y0; y < y0 + ROW; y++) {
                if (y < 0 || y >= height) continue;
                for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
                    const index = y * width + x;
                    if (alpha[index] < a) alpha[index] = a;
                }
            }
        }
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.createImageData(width, height);
    for (let index = 0; index < alpha.length; index++) {
        if (!alpha[index]) continue;
        const offset = index * 4;
        image.data[offset] = rgb[0];
        image.data[offset + 1] = rgb[1];
        image.data[offset + 2] = rgb[2];
        image.data[offset + 3] = alpha[index];
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, offsetX: minX, offsetY: minY };
}

// A trail of shrinking stepped ellipses from (0, 0) along the shadow angle.
// Iso ground: the y reach is squashed to 0.55 of the x reach.
function castTrail(cast, reach, rx, ry, count, alphaFrom, alphaTo, shrinkX = 0.6, shrinkY = 0.7) {
    const stamps = [];
    const dx = Math.cos(cast.angle);
    const dy = Math.sin(cast.angle) * 0.55;
    for (let index = 1; index <= count; index++) {
        const t = index / count;
        stamps.push({
            x: dx * reach * t,
            y: dy * reach * t,
            rx: Math.max(2, rx * (1 - t * shrinkX)),
            ry: Math.max(2, ry * (1 - t * shrinkY)),
            // Stepped courses: quantized to eighths so neighbours share values.
            alpha: Math.round((alphaFrom + (alphaTo - alphaFrom) * t) * 8) / 8,
        });
    }
    return stamps;
}

const _structureCasts = new Map();
// SD-1 — the contact twins keep caches of their own: the frost bake still
// reads the sun's stamps (FrostMelt), and one cache would evict the other's.
const _structureContactCasts = new Map();

/**
 * One building's ground cast: the structural contact ellipse, shifted along
 * the sun as before (0.3 → 0.3 + 0.9 x rake of the cast offset), plus a
 * raking trail — 0–3 extra courses for low buildings, 4–6 for tower casts
 * (towers throw theirs only under a visible sun). Anchored at the building's
 * contact centre (drawable world position + contact offset). Cached per
 * building and cast key.
 */
export function structureCast(buildingId, grounding, contact, cast) {
    if (!contact || !(contact.width > 0) || !(contact.depth > 0) || !cast) return null;
    const tower = grounding?.shadow === 'tower-cast' && contact.castLength > 0 && cast.sun;
    const key = `${cast.key}|${contact.width}|${contact.depth}|${contact.castLength || 0}|${tower ? 't' : 's'}`;
    const cache = cast.contactOnly ? _structureContactCasts : _structureCasts;
    const cached = cache.get(buildingId);
    if (cached?.key === key) return cached;
    const offsetScale = (tower ? 0.72 : 0.3) + 0.9 * cast.rake;
    const baseX = Math.cos(cast.angle) * 12 * cast.length * offsetScale;
    const baseY = Math.sin(cast.angle) * 7 * cast.length * offsetScale;
    const rx = contact.width / 2;
    const ry = contact.depth / 2;
    const stamps = [{ x: baseX, y: baseY, rx, ry, alpha: 1 }];
    if (tower) {
        const reach = contact.castLength * Math.max(0.45, cast.length);
        const count = 4 + Math.round(cast.rake * 2);
        for (const s of castTrail(cast, reach, rx, ry, count, 0.62, 0.18, 0.68, 0.76)) {
            stamps.push({ ...s, x: s.x + baseX, y: s.y + baseY });
        }
    } else if (cast.rake > 0) {
        const reach = Math.max(40, contact.depth * 2.4) * cast.rake * 1.4;
        const count = Math.max(1, Math.round(cast.rake * 3));
        for (const s of castTrail(cast, reach, rx, ry, count, 0.62, 0.3, 0.3, 0.35)) {
            stamps.push({ ...s, x: s.x + baseX, y: s.y + baseY });
        }
    }
    const raster = rasterizeCourses(stamps, cast.color);
    if (!raster) return null;
    const entry = { ...raster, key };
    if (cached) releaseCanvasBackingStore(cached.canvas);
    cache.set(buildingId, entry);
    return entry;
}

const _treeCasts = new Map();
const _treeContactCasts = new Map();
// Tree casts sit a touch lighter than structural contact.
export const TREE_CAST_ALPHA = 0.85;

/**
 * A tree's ground cast from its trunk base: a dense contact under the roots,
 * then — only under a visible sun — a trunk trail and the canopy's shadow
 * thrown along the sun as two flat courses (a denser core inside a lighter
 * rim): a short pool beside the tree at midday, a long violet cast of ~1.7x
 * the tree height at golden hour, contact only at night and under overcast.
 * `width` and `height` are the tree sprite's extent in texels. Cached per
 * size and cast key; the cache holds only the current key. `sizeKey` names
 * the stamp's tree size alone, so a GPU texture keyed by it re-uploads only
 * when the sun bucket changes (two sizes can share a canvas size).
 */
export function treeCast(width, height, cast) {
    if (!cast) return null;
    const w = Math.max(8, Math.round(width));
    const h = Math.max(8, Math.round(height));
    const key = `${cast.key}|${w}|${h}`;
    const cache = cast.contactOnly ? _treeContactCasts : _treeCasts;
    const hit = cache.get(key);
    if (hit) return hit;
    for (const [oldKey, entry] of cache) {
        if (oldKey.startsWith(`${cast.key}|`)) continue;
        releaseCanvasBackingStore(entry.canvas);
        cache.delete(oldKey);
    }
    const stamps = [{ x: 0, y: 0, rx: Math.max(3, w * 0.22), ry: Math.max(2, w * 0.09), alpha: 1 }];
    if (cast.sun) {
        const reach = h * (0.16 + 1.5 * cast.rake);
        const dx = Math.cos(cast.angle);
        const dy = Math.sin(cast.angle) * 0.55;
        // Trunk: a narrow band from the roots to where the canopy's shadow starts.
        const trunkEnd = reach * 0.45;
        const trunkSteps = Math.max(1, Math.round(trunkEnd / 4));
        for (let index = 1; index <= trunkSteps; index++) {
            const t = index / trunkSteps;
            stamps.push({ x: dx * trunkEnd * t, y: dy * trunkEnd * t, rx: Math.max(2, w * 0.06), ry: 2, alpha: 1 });
        }
        // Canopy: overlapping ellipses along the sun from 0.45 to 1.0 of the
        // reach, stretched with the rake; each lays a rim course and a core.
        const canopyRx = Math.max(4, w * 0.3);
        const canopyRy = Math.max(3, w * 0.14);
        const canopySteps = 1 + Math.round(cast.rake * 4);
        for (let index = 0; index < canopySteps; index++) {
            const t = canopySteps === 1 ? 1 : 0.45 + 0.55 * (index / (canopySteps - 1));
            const taper = 1 - 0.25 * (canopySteps === 1 ? 0 : index / (canopySteps - 1));
            const x = dx * reach * t;
            const y = dy * reach * t;
            stamps.push({ x, y, rx: canopyRx * taper, ry: canopyRy * taper, alpha: 0.75 });
            stamps.push({ x, y, rx: Math.max(2, canopyRx * taper - 4), ry: Math.max(2, canopyRy * taper - 2), alpha: 1 });
        }
    }
    const raster = rasterizeCourses(stamps, cast.color);
    if (!raster) return null;
    const entry = { ...raster, key, sizeKey: `${w}x${h}` };
    cache.set(key, entry);
    return entry;
}

// 2.9 (WS) — a raking cast over painted water keeps this share of its
// strength there and is broken by the water column's ripple rows (every row
// with mod(row + tick, 3) == 2 dropped, each row shifted by
// floor(1.5·sin(row·0.7 + tick)) texels), so a golden-hour cast never lies
// on the sea as a hard parallelogram. SCENE_FRAGMENT applies it per fragment
// on the live 4 Hz water tick (V9 record flag `groundCast`); Canvas bakes it
// at tick 0, the resident path's reduced-motion frame.
export const GROUND_CAST_WATER_SHARE = 0.35;

/**
 * Canvas: the cast `baked` (a structureCast / treeCast entry) placed with its
 * top-left at world (x, y), with every texel over painted water (3.6 coast
 * field flag `water`, not `covered`: a dock, pier deck, bridge span or
 * foundation keeps the land cast) held to GROUND_CAST_WATER_SHARE and broken
 * by the ripple rows at tick 0. Returns `baked.canvas` itself when no texel
 * lies on such water; cached on the entry per position and coast bake.
 */
export function castOverWater(baked, x, y, fields) {
    const canvas = baked?.canvas;
    if (!canvas || !fields?.cols || !fields.coastField) return canvas || null;
    if (baked.overWaterRevision !== fields.revision) {
        baked.overWater = new Map();
        baked.overWaterRevision = fields.revision;
    }
    const key = `${x},${y}`;
    const hit = baked.overWater.get(key);
    if (hit) return hit;
    const { width: w, height: h } = canvas;
    const water = new Uint8Array(w * h);
    let any = false;
    for (let j = 0; j < h; j++) {
        const r = Math.floor((y + j - fields.y) / 2);
        if (r < 0 || r >= fields.rows) continue;
        for (let i = 0; i < w; i++) {
            const c = Math.floor((x + i - fields.x) / 2);
            if (c < 0 || c >= fields.cols) continue;
            const flags = fields.coastField[(r * fields.cols + c) * 2 + 1];
            if ((flags & COAST_FIELD_FLAGS.water) && !(flags & COAST_FIELD_FLAGS.covered)) {
                water[j * w + i] = 1;
                any = true;
            }
        }
    }
    if (!any) {
        baked.overWater.set(key, canvas);
        return canvas;
    }
    const out = makeCanvas(w, h);
    if (!out) return canvas;
    const image = canvas.getContext('2d').getImageData(0, 0, w, h);
    const src = image.data;
    const dst = new Uint8ClampedArray(src);
    for (let j = 0; j < h; j++) {
        const row = y + j;
        const dropped = ((row % 3) + 3) % 3 === 2;
        const wobble = Math.floor(1.5 * Math.sin(row * 0.7));
        for (let i = 0; i < w; i++) {
            if (!water[j * w + i]) continue;
            const o = (j * w + i) * 4;
            const si = i - wobble;
            if (dropped || si < 0 || si >= w) {
                dst[o + 3] = 0;
                continue;
            }
            const so = (j * w + si) * 4;
            dst[o] = src[so];
            dst[o + 1] = src[so + 1];
            dst[o + 2] = src[so + 2];
            dst[o + 3] = Math.round(src[so + 3] * GROUND_CAST_WATER_SHARE);
        }
    }
    image.data.set(dst);
    out.getContext('2d').putImageData(image, 0, 0);
    baked.overWater.set(key, out);
    return out;
}

/**
 * Canvas fallback: blit the cached tree casts for the trees on screen, in
 * world space (the caller holds the camera transform), on the ground layer;
 * `waterFields` (the coast bake's resident fields) break them over water.
 */
export function drawTreeCasts(ctx, trees, cast, camera, viewport, waterFields = null) {
    cast = stampCastFor(cast);
    if (!ctx || !trees?.length || !cast || !camera?.worldToScreen) return;
    const margin = 160;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = cast.alpha * TREE_CAST_ALPHA;
    for (const tree of trees) {
        const p = camera.worldToScreen(tree.x, tree.y);
        if (p.x < -margin || p.y < -margin || p.x > viewport.width + margin || p.y > viewport.height + margin) continue;
        const bounds = tree.bounds || {};
        const baked = treeCast(finite(bounds.right) - finite(bounds.left), -finite(bounds.top), cast);
        if (!baked) continue;
        const x = Math.round(tree.x) + baked.offsetX;
        const y = Math.round(tree.y) + baked.offsetY;
        ctx.drawImage(castOverWater(baked, x, y, waterFields), x, y);
    }
    ctx.restore();
}

/**
 * The villager's raking trail (the contact shadow itself stays in
 * AgentGroundMarks): 0 below golden light, else a violet trail from the feet
 * along the sun, as long as ~1.2x the body at full rake. Its courses sit at
 * the contact core's density near the feet and step down to the outer one.
 *
 * SD-1 — a cast carrying a `trail` (`villagerCastLighting`: the frame's
 * shade) throws the body's shadow the way the field throws a building's
 * instead: along the shade's sweep, the body's height times its length, one
 * flat course at the shade's density, thinning over its last quarter.
 */
export function villagerCastStamps(contactWidth, cast) {
    if (cast?.trail) {
        const height = Math.max(24, contactWidth * 2.1);
        const tipX = height * cast.trail.sx;
        const tipY = height * cast.trail.sy;
        const count = Math.max(2, Math.round(Math.hypot(tipX, tipY) / 5));
        const stamps = [];
        for (let index = 1; index <= count; index++) {
            const t = index / count;
            stamps.push({
                x: tipX * t,
                y: tipY * t,
                rx: Math.max(2, contactWidth * 0.36 * (1 - t * 0.45)),
                ry: Math.max(2, contactWidth * 0.13 * (1 - t * 0.3)),
                // The last quarter (the head) lets go in two courses, as the
                // field's own tip dissolves.
                alpha: cast.trail.alpha * (t <= 0.75 ? 1 : t <= 0.875 ? 2 / 3 : 1 / 3),
            });
        }
        return stamps;
    }
    if (!cast || cast.rake <= 0) return [];
    const bodyHeight = Math.max(24, contactWidth * 2.1);
    const reach = bodyHeight * 1.2 * cast.rake;
    const count = Math.max(2, Math.round(reach / 6));
    return castTrail(cast, reach, contactWidth * 0.36, Math.max(2, contactWidth * 0.13), count, 0.25 + 0.3 * cast.rake, 0.3, 0.3, 0.2);
}

// 2.8 — night lamp casts (OE-2). With no raking sun, a body standing in a
// real lamp's pool throws a short stepped trail away from that lamp's foot
// (V5), in the Octopath / Sea of Stars way. Casts come from fixtures and
// building apertures only: attention lights and agent-carried motes never
// cast, so a waiting agent's own light adds no shadows.
export const POINT_CAST_RGB = [22, 16, 26];
const POINT_CAST_CACHE_MAX = 256;
// Crowd pressure: at most this many casts a frame, nearest the view centre.
export const POINT_CAST_CAP = 24;
// A body keeps its lamp until another is this much stronger at its feet.
const POINT_CAST_HYSTERESIS = 0.15;
const LOCAL_LIGHT_VISIBILITY_FLOOR = 0.04;
const CASTING_ROLES = new Set(['fixture', 'aperture']);
// The share of a lamp's radius its lit pool reaches on the ground (the
// resident loop's first dithered course, shape ~0.1, ends near 0.85 of it).
const POINT_CAST_POOL_RIM = 0.85;

const _pointCasts = new Map();

/**
 * One cached point-light trail: 3+ stepped ellipses from the feet along
 * `angleBucket / 16` rad (ground plane), `reachBucket * 4` texels long, the
 * first course at `alphaBucket / 8` stepping down to ~60 % of it in eighths.
 * LRU of POINT_CAST_CACHE_MAX keys; returns `{ canvas, offsetX, offsetY,
 * key }` relative to the feet.
 */
export function pointCastStamp(contactWidth, angleBucket, reachBucket, alphaBucket) {
    const w = Math.max(8, Math.round(finite(contactWidth, 20)));
    const key = `pc|${w}|${angleBucket}|${reachBucket}|${alphaBucket}`;
    const hit = _pointCasts.get(key);
    if (hit) {
        _pointCasts.delete(key);
        _pointCasts.set(key, hit);
        return hit;
    }
    const reach = reachBucket * 4;
    const alpha = alphaBucket / 8;
    const stamps = castTrail(
        { angle: angleBucket / 16 },
        reach,
        w * 0.36,
        Math.max(2, w * 0.13),
        Math.max(3, Math.round(reach / 6)),
        alpha,
        Math.round(alpha * 0.6 * 8) / 8,
        0.33,
        0.25,
    );
    const raster = rasterizeCourses(stamps, POINT_CAST_RGB);
    if (!raster) return null;
    const entry = { ...raster, key };
    while (_pointCasts.size >= POINT_CAST_CACHE_MAX) {
        const [oldKey, oldEntry] = _pointCasts.entries().next().value;
        releaseCanvasBackingStore(oldEntry.canvas);
        _pointCasts.delete(oldKey);
    }
    _pointCasts.set(key, entry);
    return entry;
}

// NL-3 (look `nl3`, LampSilhouette.js) — on the resident path, while the
// silhouette mode is on (set by the scene builder from the look and the
// `lamp-silhouettes` ladder row, read on the next frame), a body's lamp cast
// is its own silhouette instead of the stepped trail: `pointCastFor` records
// the pick here and returns no trail stamp, so a body never wears both.
// Silhouettes come from fixtures and low apertures (doors, a forge mouth:
// emitter at most LAMP_SILHOUETTE_MAX_HEIGHT px up); windows throw none.
export const LAMP_SILHOUETTE_MAX_HEIGHT = 40;
let _silhouetteMode = false;
const _silhouettes = new Map();

export function setLampSilhouetteMode(on) {
    _silhouetteMode = Boolean(on);
}

/** This frame's silhouette cast for a body (`pointCastFor`'s owner), or null. */
export function lampSilhouetteFor(owner) {
    return _silhouettes.get(owner) || null;
}

// Per-frame casting lights on the ground plane, and the crowd cap state.
const _castLights = [];
const _castMemory = new WeakMap();
let _castCentreX = 0;
let _castCentreY = 0;
let _castLimit = Infinity;
const _castDistances = [];

/**
 * Called once per frame by the frame renderer, after the frame's light list
 * and before any body lays out its ground marks. `lights` are normalized V5
 * records; `localLightPhase` is the grade's local-light phase; `centre` is
 * the view centre in world px (crowd cap ranking).
 */
export function setFramePointCastLights(lights, localLightPhase, centre = null) {
    // The crowd cap ranks by last frame's candidates: one frame of lag keeps
    // the nearest POINT_CAST_CAP bodies without a second layout pass.
    if (_castDistances.length > POINT_CAST_CAP) {
        _castDistances.sort((a, b) => a - b);
        _castLimit = _castDistances[POINT_CAST_CAP - 1];
    } else {
        _castLimit = Infinity;
    }
    _castDistances.length = 0;
    _castLights.length = 0;
    _silhouettes.clear();
    _castCentreX = finite(centre?.x, 0);
    _castCentreY = finite(centre?.y, 0);
    if (!(finite(localLightPhase, 0) > LOCAL_LIGHT_VISIBILITY_FLOOR) || !lights?.length) return;
    for (const light of lights) {
        if (!light || light.attention || !CASTING_ROLES.has(light.role)) continue;
        // NL-4 / NL-3 — a carried lantern casts no shadow, by rule: not on
        // its carrier (whose foot it stands on) nor on anyone else.
        if (String(light.id || '').startsWith(LANTERN_ID_PREFIX)) continue;
        const radius = finite(light.radius, 0);
        const intensity = finite(light.intensity, 0);
        if (radius <= 0 || intensity <= 0.02) continue;
        const foot = light.ground || light;
        const gx = finite(foot.x, NaN);
        const gy = finite(foot.y, NaN);
        if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
        const height = Math.max(0, finite(light.height, 0));
        const window = light.role === 'aperture' && height > LAMP_SILHOUETTE_MAX_HEIGHT;
        _castLights.push({ id: light.id, gx, gy, radius, intensity, height, window });
    }
}

/**
 * The point-light trail for one body this frame, or null: only while the
 * sun is not raking (`cast.rake === 0`) and a casting lamp's ground radius
 * contains the feet (iso distance from the lamp's foot). `owner` carries the
 * body's lamp choice between frames (hysteresis against flip-flopping).
 */
export function pointCastFor(owner, x, y, contactWidth, cast = _frameCast) {
    if (!_castLights.length || (cast && cast.rake > 0)) return null;
    const px = finite(x, NaN);
    const py = finite(y, NaN);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    const previous = owner ? _castMemory.get(owner) : null;
    // A walking body keeps its stepped trail: its silhouette would re-raster
    // every frame (measured 1.8 ms median, 8 ms p95 for six walkers at z2 on
    // a loaded host), so only a standing body's is drawn, from its cache.
    const silhouette = _silhouetteMode && owner?.gpuWorldEnabled === true && owner.moving !== true;
    let best = null;
    let bestStrength = 0;
    let kept = null;
    let keptStrength = 0;
    for (const light of _castLights) {
        if (silhouette && light.window) continue;
        const dx = px - light.gx;
        const dy = (py - light.gy) * 2;
        const d = Math.hypot(dx, dy);
        if (d >= light.radius || d < 2) continue;
        const strength = light.intensity * (1 - d / light.radius);
        if (strength > bestStrength) {
            best = { light, dx, dy, d };
            bestStrength = strength;
        }
        if (light.id === previous) {
            kept = { light, dx, dy, d };
            keptStrength = strength;
        }
    }
    const pick = kept && keptStrength + POINT_CAST_HYSTERESIS >= bestStrength ? kept : best;
    if (owner) {
        if (pick) _castMemory.set(owner, pick.light.id);
        else _castMemory.delete(owner);
    }
    if (!pick) return null;
    const centreDistance = Math.hypot(px - _castCentreX, py - _castCentreY);
    _castDistances.push(centreDistance);
    if (centreDistance > _castLimit) return null;
    const ratio = pick.d / pick.light.radius;
    const angleBucket = Math.round(Math.atan2(pick.dy, pick.dx) * 16);
    // The trail ends inside the lamp's lit pool (its last course sits at
    // POINT_CAST_POOL_RIM of the radius): a cast never darkens the unlit
    // ground past the rim. A body at the rim throws none.
    const room = pick.light.radius * POINT_CAST_POOL_RIM - pick.d - 2;
    if (silhouette) {
        // NL-3 — the scene builder lays the body's own silhouette down from
        // this pick (LampSilhouette.js); no trail.
        if (room >= 6) {
            _silhouettes.set(owner, {
                lightX: pick.light.gx,
                lightY: pick.light.gy,
                height: pick.light.height,
                dx: pick.dx,
                dy: pick.dy,
                distance: pick.d,
                room,
                ratio,
            });
        }
        return null;
    }
    const reach = Math.min(18 + 60 * ratio, room);
    if (reach < 8) return null;
    const reachBucket = Math.max(2, Math.min(14, Math.floor(reach / 4)));
    // Eighths 7 / 6 / 5: dense in the pool's core, lighter toward its rim;
    // a lamp's own light lands on the trail too, so it starts dark.
    const alphaBucket = ratio < 0.4 ? 7 : ratio < 0.75 ? 6 : 5;
    return pointCastStamp(contactWidth, angleBucket, reachBucket, alphaBucket);
}
