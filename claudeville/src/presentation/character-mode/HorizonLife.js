// claudeville/src/presentation/character-mode/HorizonLife.js
//
// W6.7 (AW-P7 + AD-P13, no sails) — life on the far sea. Four AmbientEvents
// kinds draw here, each a tiny hand-authored pixel stamp on the art grid
// (1 world px = 1 texel), in two or three low-contrast sea tones, opaque and
// flat (never additive, never a status hue):
//
//   whale-spout     rare, calm day: a dark back breaks the surface and blows
//                   a 3-frame stepped plume, two or three times, drifting
//   dolphin-pod     rare, calm sea: three dark arcs leaping in turn as the
//                   pod travels along the coast
//   far-gull-wisp   frequent: 2–4 one-pixel birds in a V crossing (<= 10 s)
//   distant-shower  frequent while a front comes in (CoastBake
//                   .distantShowerFront): a faint dithered column on the
//                   upwind horizon, never rain on the island
//
// The whale, the pod and the gulls surface at FAR_SEA_STATIONS: the open
// ocean the whole-island frame shows on its right, past the island's
// north-east shore (beyond the Lighthouse) and its south-east shore (beyond
// the Harbor quay), four to twelve tiles outside the map, where no ship lane,
// anchorage or the release slip reaches (they all lie inside the map) and no
// landmark stands. They move along their coast (never toward the island) by
// at most FAR_SEA_TRAVEL_PX. The shower stays a horizon weather mark: it
// lies inside HORIZON_BAND_ROWS below the sea horizon and the draw clips it
// to that band. No ship, hull or sail is ever drawn (hulls are a git
// channel). The layer sorts under every world drawable. It reads the
// scheduler's live events, the atmosphere clock and the knot wind only
// (V3); the scheduler already holds it under reduced motion, frame pressure
// and the quiet gate.

import { ART_RAMPS } from '../../config/artPalette.js';
import { OCEAN_HORIZON_WORLD_Y } from './CoastBake.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { tileToWorld } from './Projection.js';

/** Rows below the horizon line the distant shower may use (first row is +1). */
export const HORIZON_BAND_ROWS = 22;
/**
 * Where the whale, the pod and the gulls surface (tile coords, outside the
 * map) and the coast each one runs along: `ne` travels on tile x (parallel to
 * the north-east shore), `se` on tile y (parallel to the south-east shore).
 * All lie in world x 500..1200, so the whole-island frame (the east vertex
 * at its right edge) shows every one: three north-east of the Lighthouse
 * and the world ash, three south-east of the Harbor and its outer fairway.
 */
export const FAR_SEA_STATIONS = Object.freeze([
    Object.freeze({ tileX: 20, tileY: -8, coast: 'ne' }),
    Object.freeze({ tileX: 25, tileY: -6, coast: 'ne' }),
    Object.freeze({ tileX: 29, tileY: -4, coast: 'ne' }),
    Object.freeze({ tileX: 45, tileY: 11, coast: 'se' }),
    Object.freeze({ tileX: 47, tileY: 17, coast: 'se' }),
    Object.freeze({ tileX: 47, tileY: 25, coast: 'se' }),
]);
/** The farthest a far-sea event moves from its station along its coast (world px). */
export const FAR_SEA_TRAVEL_PX = 130;
export const HORIZON_LIFE_KINDS = Object.freeze(['whale-spout', 'dolphin-pod', 'far-gull-wisp', 'distant-shower']);
const KIND_SET = new Set(HORIZON_LIFE_KINDS);
// World px per px of travel along each coast (the iso tile axes, 2:1).
const COAST_AXIS = Object.freeze({
    ne: Object.freeze([2 / Math.sqrt(5), 1 / Math.sqrt(5)]),
    se: Object.freeze([-2 / Math.sqrt(5), 1 / Math.sqrt(5)]),
});
const STATION_WORLD = FAR_SEA_STATIONS.map(s => ({ ...tileToWorld(s.tileX, s.tileY), axis: COAST_AXIS[s.coast] }));
// Tones: the open sea's own ramp. Against the far water (about deepWater[1]
// once graded) the backs sit two to three steps darker (`back`, the void
// ramp's sea-toned top), the plume, the splashes and the birds two to three
// steps lighter (`light`, `crest`); `mid` is the shower's streak and a
// dolphin's wet sheen. Measured on the zoom-1 frame: sea #2d3e48, a
// deepWater[1] back read as #314149 — invisible — hence the wider steps.
const TONES = Object.freeze({
    back: ART_RAMPS.void[2],
    mid: ART_RAMPS.deepWater[2],
    light: ART_RAMPS.shallowWater[1],
    crest: ART_RAMPS.shallowWater[2],
});
const SHOWER_ALPHA = Object.freeze([0.12, 0.2, 0.28]);

const TOP = OCEAN_HORIZON_WORLD_Y + 1;
const BOTTOM = OCEAN_HORIZON_WORLD_Y + HORIZON_BAND_ROWS;

function unit(seed, salt) {
    const s = Math.sin((Number(seed) || 0) * 12.9898 * 1000 + salt * 78.233) * 43758.5453;
    return s - Math.floor(s);
}

// A band stamp (the shower): rows clamped to the horizon band.
function pushBand(out, x, y, w, h, tone, alpha = 1) {
    const top = Math.max(TOP, Math.round(y));
    const bottom = Math.min(BOTTOM, Math.round(y) + h);
    if (bottom <= top || w <= 0) return;
    out.push({ x: Math.round(x), y: top, w, h: bottom - top, tone, alpha });
}

function push(out, x, y, w, h, tone) {
    out.push({ x: Math.round(x), y: Math.round(y), w, h, tone, alpha: 1 });
}

// The seeded far-sea point of an event that has come `distance` px along its
// station's coast in `heading` (±1) (from a seeded start within ±30 px, the
// total held to FAR_SEA_TRAVEL_PX), and the screen-x sign of that heading for
// mirroring a stamp.
const farPoint = { x: 0, y: 0, facing: 1 };
function farSeaPoint(seed, salt, heading, distance) {
    const station = STATION_WORLD[Math.min(STATION_WORLD.length - 1, Math.floor(unit(seed, salt) * STATION_WORLD.length))];
    const start = Math.round((unit(seed, salt + 0.5) - 0.5) * 60);
    const d = Math.max(-FAR_SEA_TRAVEL_PX, Math.min(FAR_SEA_TRAVEL_PX, start + heading * distance));
    farPoint.x = Math.round(station.x + station.axis[0] * d);
    farPoint.y = Math.round(station.y + station.axis[1] * d);
    farPoint.facing = station.axis[0] * heading < 0 ? -1 : 1;
    return farPoint;
}

// The whale: up to three blows across the event; each surfaces a long low
// back for 3.8 s and steps the plume low → tall → full puff → drifting
// (V4 stepped), the blowhole toward the head (the way it swims).
function whaleStamps(event, t, span, out) {
    const blows = 2 + Math.floor(unit(event.seed, 1) * 2);
    const dir = unit(event.seed, 2) < 0.5 ? -1 : 1;
    // Swims ~1 px every 2 s along its coast.
    const whale = farSeaPoint(event.seed, 3, dir, Math.floor(t / 2000));
    const wx = whale.x;
    const wy = whale.y;
    const at = lx => wx + lx * whale.facing;
    const span1 = (a, b, y, tone) => push(out, Math.min(at(a), at(b)), y, Math.abs(b - a) + 1, 1, tone);
    for (let i = 0; i < blows; i++) {
        const blowAt = span * (0.15 + 0.7 * (i / Math.max(1, blows - 1)));
        const local = t - blowAt;
        if (local < -1200 || local >= 2600) continue;
        // The back: a long low hump rising toward the head, a foam texel
        // where it meets the water at either end.
        span1(-6, 5, wy, 'back');
        span1(-3, 3, wy - 1, 'back');
        push(out, at(-7), wy, 1, 1, 'light');
        push(out, at(6), wy, 1, 1, 'light');
        if (local < 0) continue;
        const frame = local < 250 ? 0 : local < 700 ? 1 : local < 1500 ? 2 : 3;
        const hole = at(2);
        if (frame === 0) {
            // The first jet.
            push(out, hole, wy - 4, 1, 3, 'light');
        } else if (frame === 1) {
            // Tall and narrow, its tip already white.
            push(out, hole, wy - 7, 1, 6, 'light');
            push(out, hole, wy - 8, 1, 1, 'crest');
        } else if (frame === 2) {
            // The bloom: a soft spray, white at its core, on a thinning stem.
            push(out, hole, wy - 6, 1, 5, 'light');
            push(out, hole - 1, wy - 7, 1, 1, 'light');
            push(out, hole, wy - 7, 1, 1, 'crest');
            push(out, hole + 1, wy - 7, 1, 1, 'light');
            push(out, hole - 2, wy - 8, 1, 1, 'light');
            push(out, hole - 1, wy - 8, 3, 1, 'crest');
            push(out, hole + 2, wy - 8, 1, 1, 'light');
            push(out, hole - 1, wy - 9, 1, 1, 'light');
            push(out, hole + 1, wy - 9, 1, 1, 'light');
        } else {
            // The mist hangs and breaks into a dithered cloud, the stem gone.
            push(out, hole - 1, wy - 7, 1, 1, 'light');
            push(out, hole + 1, wy - 7, 1, 1, 'light');
            push(out, hole - 2, wy - 8, 1, 1, 'light');
            push(out, hole, wy - 8, 1, 1, 'crest');
            push(out, hole + 2, wy - 8, 1, 1, 'light');
            push(out, hole - 1, wy - 9, 1, 1, 'light');
            push(out, hole + 1, wy - 9, 1, 1, 'light');
            push(out, hole, wy - 10, 1, 1, 'light');
        }
    }
}

// The pod: three dolphins leap in turn on a 2.4 s cycle as the pod travels
// ~3 px/s along its coast. Each leap: rise, arch, dive, a splash crown.
const DOLPHIN_PERIOD_MS = 2400;
const DOLPHINS = Object.freeze([[0, 0], [-10, 0.22], [10, 0.45]]);
function dolphinStamps(event, t, out) {
    const along = unit(event.seed, 5) < 0.5 ? -1 : 1;
    const pod = farSeaPoint(event.seed, 6, along, Math.floor(t / 333));
    const dir = pod.facing;
    const wy = pod.y;
    for (const [dx, offset] of DOLPHINS) {
        const phase = ((t / DOLPHIN_PERIOD_MS + offset) % 1 + 1) % 1;
        const x = Math.round(pod.x + dx);
        // Mirror the stamp to the direction of travel.
        const at = (lx) => x + lx * dir;
        const span1 = (a, b, y, tone) => push(out, Math.min(at(a), at(b)), y, Math.abs(b - a) + 1, 1, tone);
        if (phase < 0.12) {
            span1(0, 1, wy, 'back');
            push(out, at(1), wy - 1, 1, 1, 'back');
            push(out, at(-1), wy, 1, 1, 'light');
        } else if (phase < 0.3) {
            span1(0, 1, wy - 3, 'back');
            span1(-1, 2, wy - 2, 'back');
            push(out, at(1), wy - 3, 1, 1, 'mid');
            push(out, at(-2), wy - 1, 1, 1, 'back');
            push(out, at(3), wy - 1, 1, 1, 'back');
        } else if (phase < 0.42) {
            push(out, at(3), wy - 1, 1, 1, 'back');
            span1(2, 3, wy, 'back');
        } else if (phase < 0.52) {
            push(out, at(3), wy - 1, 1, 1, 'crest');
            push(out, at(2), wy, 1, 1, 'light');
            push(out, at(4), wy, 1, 1, 'light');
        }
    }
}

// 2–4 gulls in a V crossing along the coast at ~12 px/s, each a three-texel
// "v" whose wings lift a texel on its own 0.5 s beat.
function gullWispStamps(event, t, out) {
    const count = 2 + Math.floor(unit(event.seed, 8) * 3);
    const along = unit(event.seed, 9) < 0.5 ? -1 : 1;
    // The flock crosses its station: 60 px short of it to 60 px past (10 s).
    const leader = farSeaPoint(event.seed, 10, along, Math.floor(t / 83) - 60);
    const dir = leader.facing;
    // The flock flies a few rows above the water it crosses.
    const lead = leader.x;
    const gy = leader.y - 8 - Math.floor(unit(event.seed, 11) * 5);
    const beat = Math.floor(t / 500);
    for (let i = 0; i < count; i++) {
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 0 ? 1 : -1;
        const bx = lead - dir * rank * 5;
        const by = gy + side * rank * 2;
        const lift = (beat + i) % 2 === 0 ? -1 : 0;
        push(out, bx - 1, by + lift, 1, 1, 'light');
        push(out, bx + 1, by + lift, 1, 1, 'light');
        push(out, bx, by + 1 + lift, 1, 1, 'light');
    }
}

// A faint dithered column on the upwind horizon, filling in and thinning in
// three alpha steps, its streak texels stepping down every 0.5 s.
function showerStamps(event, t, span, windX, out) {
    const sign = Number(windX) < 0 ? -1 : 1;
    const x0 = Math.round(-sign * (300 + unit(event.seed, 12) * 800));
    const width = 18 + Math.floor(unit(event.seed, 13) * 14);
    // Drifts downwind ~1 px every 4 s.
    const cx = x0 + sign * Math.floor(t / 4000);
    const p = span > 0 ? t / span : 0;
    const step = p < 0.1 || p > 0.9 ? 0 : p < 0.2 || p > 0.8 ? 1 : 2;
    const alpha = SHOWER_ALPHA[step];
    const fall = Math.floor(t / 500) % 3;
    for (let lx = 0; lx < width; lx++) {
        // Ragged foot: the column reaches 12–17 rows down, deepest mid-span.
        const edge = Math.min(lx, width - 1 - lx);
        const depth = 12 + Math.min(5, edge >> 1) - ((lx * 7) % 3 === 0 ? 1 : 0);
        if ((lx * 5) % 3 === 1) continue;
        for (let ly = (lx + fall) % 3; ly < depth; ly += 3) {
            pushBand(out, cx + lx, TOP + ly, 1, 2, 'mid', alpha);
        }
    }
}

/**
 * The stamps a live horizon event draws at atmosphere clock `clockMs`:
 * `[{ x, y, w, h, tone, alpha }]` in integer world px, every one inside the
 * band below the sea horizon. Empty outside the event or for any other kind.
 */
export function horizonLifeStamps(event, clockMs, { windX = 0 } = {}, out = []) {
    out.length = 0;
    if (!event || !KIND_SET.has(event.kind)) return out;
    const span = event.endMs - event.startMs;
    const t = clockMs - event.startMs;
    if (!(span > 0) || !(t >= 0) || t >= span) return out;
    if (event.kind === 'whale-spout') whaleStamps(event, t, span, out);
    else if (event.kind === 'dolphin-pod') dolphinStamps(event, t, out);
    else if (event.kind === 'far-gull-wisp') gullWispStamps(event, t, out);
    else showerStamps(event, t, span, windX, out);
    return out;
}

/** The live horizon events (frequent and rare tiers) of a renderer (a shared array). */
const LIVE = [];
export function liveHorizonEvents(renderer) {
    const events = renderer?.ambientEvents;
    LIVE.length = 0;
    for (const tier of ['rare', 'frequent']) {
        const event = events?.[tier];
        if (event && KIND_SET.has(event.kind)) LIVE.push(event);
    }
    return LIVE;
}

const stamps = [];
const graded = new Map();
let gradedFor = null;
/** What the last frame drew (Shift-D / perf), never agent-derived. */
export const horizonLifeStats = { kinds: [], stamps: 0 };

function toneColor(tone, grade) {
    const color = TONES[tone] || TONES.mid;
    if (!grade) return color;
    if (gradedFor !== grade) {
        gradedFor = grade;
        graded.clear();
    }
    let out = graded.get(color);
    if (out) return out;
    const n = Number.parseInt(color.slice(1), 16);
    const rgb = applyGradeToRgb([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], grade);
    const c = v => Math.round(Math.max(0, Math.min(1, v)) * 255);
    out = `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
    graded.set(color, out);
    return out;
}

/**
 * Draw the live horizon events in world space (camera transform applied).
 * On the resident overlay (ungraded) the tones wear the C2 grade; the Canvas
 * world pass draws the authored tones and is graded after the fact. The far
 * sea stamps lie outside the map by construction; the shower is clipped to
 * the horizon band.
 */
export function drawHorizonLife(ctx, renderer) {
    horizonLifeStats.kinds.length = 0;
    horizonLifeStats.stamps = 0;
    const live = liveHorizonEvents(renderer);
    if (!live.length || !(Number(renderer?.motionScale ?? 1) > 0)) return;
    const atmosphere = renderer._lastAtmosphere;
    const clock = atmosphere?.effectiveDate?.getTime?.() ?? Date.now();
    const grade = ctx === renderer.overlayCtx && atmosphere?.lightGrade?.gain ? atmosphere.lightGrade : null;
    ctx.save();
    for (const event of live) {
        horizonLifeStamps(event, clock, { windX: atmosphere?.weather?.windX }, stamps);
        if (!stamps.length) continue;
        horizonLifeStats.kinds.push(event.kind);
        horizonLifeStats.stamps += stamps.length;
        const banded = event.kind === 'distant-shower';
        if (banded) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(-1e5, TOP, 2e5, BOTTOM - TOP);
            ctx.clip();
        }
        for (const s of stamps) {
            ctx.globalAlpha = s.alpha;
            ctx.fillStyle = toneColor(s.tone, grade);
            ctx.fillRect(s.x, s.y, s.w, s.h);
        }
        if (banded) ctx.restore();
    }
    ctx.restore();
}

const HORIZON_LIFE_SCENE_ITEMS = Object.freeze([
    Object.freeze({
        sourceCategory: 'horizon-life',
        stableKey: 'horizon-life:far-sea',
        sortY: -2000000,
    }),
]);
const NO_ITEMS = Object.freeze([]);

// Overlay-safe like wildlife: the Canvas world pass draws it first of all
// drawables (under the island); the resident path replays it on the overlay
// ahead of every other overlay band.
export const HORIZON_LIFE_SCENE_CATEGORY = Object.freeze({
    id: 'horizon-life',
    sortBand: 5,
    enumerate({ renderer } = {}) {
        return liveHorizonEvents(renderer).length ? HORIZON_LIFE_SCENE_ITEMS : NO_ITEMS;
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        if (context.renderer) drawHorizonLife(ctx, context.renderer);
    },
    unsupported: 'overlay-safe',
    overlayBand: 5,
});
