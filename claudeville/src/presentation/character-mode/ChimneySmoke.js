// 6.4 — smoke that reads, from every real chimney. Every building whose
// registry entry names `smokeTop` anchors (where a column leaves a cap; the
// Harbor has one per stack) or a `chimney` effect anchor gets a column of
// round three-tone puffs (ParticleSystem shape 'smoke': radius 2 -> 5 art px
// over life, lit `#d3d6dc` / body `#a9aeb8` / shade `#787c86`, four alpha
// quanta by height, gone at 60 world px). Workshops require working visitors
// (V8); the watchtower crown alone burns on full lamplight's clock gate.
// Puffs sort just in front of the chimney's own building half (0.6),
// so nearer buildings hide them on both backends; their own roof never does.
//
// Weather: the one wind (C-W3, `windAt` at each chimney mouth, gusts
// included) leans the column — fog barely tilts it, a storm lays it flat —
// and rain and storm flatten and shorten it further. A hearth building's soot
// warms with its fire (#33), and at dusk and night its first puff carries the
// fire-lit underside.
// Reduced motion: one static three-puff wisp per smoking chimney, the same
// puffs at the same scale, leaning with the knot wind.
import { getBuildingEffectAnchor } from './BuildingVisualRegistry.js';
import { drawSmokePuff, smokePuffAlpha, SMOKE_COOL_COLORS, SMOKE_WARM_COLORS } from './ParticleSystem.js';
import { buildingCenterToWorld } from './Projection.js';
import { applyGradeToRgb, lampCourseAt } from './GradeEvaluator.js';
import { seasonShiftFor, smokeWindDrift } from './AtmosphereState.js';
import { seasonTokenForAtmosphere } from './SeasonalAmbience.js';
import { baseWindX } from './Wind.js';

// Spawn cadence per occupancy tier. With puffs living 1.7–2.2 s this keeps
// about 4–5 (occupied) to 7–8 (busy) puffs per chimney; a hard cap holds the
// ≤10 budget whatever the frame rate.
const PUFF_INTERVAL_MS = Object.freeze({ occupied: 420, busy: 260 });
const MAX_PUFFS_PER_CHIMNEY = 10;
// Rain and storm flatten the column: slower, shorter-lived puffs that the
// wind lays over (about half the dry column's height).
const WET_LIFE = Object.freeze([70, 92]);
const WET_SPEED = Object.freeze([0.32, 0.38]);
// Buildings whose smoke rises off a live fire.
const HEARTH_TYPES = new Set(['forge', 'watchtower']);
const HEARTH_UNDERSIDE = '#9a5a36';
// After dark the column must stay the palest thing over the dark roofs and
// lawns: moonlit soot. The Canvas frame is graded after the fact, so the
// authored albedo sits high; a backend that grades particles itself (the
// resident GPU draw) wears the grade's own response to that body tone, held
// to a luminance floor by mixing toward cool moonlight so the column reads
// pale but never white (see `moonlitTones`); its rims step from that body.
const MOONLIT_SOOT = Object.freeze(['#a9aeb8']);
const MOONLIT_FLOOR = Object.freeze([0.5]);
const MOONLIGHT = Object.freeze([0.70, 0.76, 0.86]);
// Reduced motion: the live column's first three life steps, frozen at the
// heights where they would be (dy world px above the mouth, dx downwind).
const STATIC_WISP = Object.freeze([
    Object.freeze({ dx: 0, dy: -3, radius: 2 }),
    Object.freeze({ dx: 2, dy: -16, radius: 3 }),
    Object.freeze({ dx: 5, dy: -31, radius: 4 }),
]);
const STATIC_TONE = SMOKE_COOL_COLORS[0];

// Registry chimney mouths of one building: `smokeTop` may be one point or a
// list (one per stack); `chimney` is the fallback.
function chimneyAnchors(type) {
    const top = getBuildingEffectAnchor(type, 'smokeTop', null) || getBuildingEffectAnchor(type, 'chimney', null);
    if (!Array.isArray(top)) return [];
    return Array.isArray(top[0]) ? top.filter(Array.isArray) : [top];
}

function smokeInterval(source, presence, atmosphere) {
    if (source.type !== 'watchtower') return PUFF_INTERVAL_MS[presence?.get?.(source.type)?.tier] || 0;
    const minute = Number(atmosphere?.clock?.minuteOfDay);
    return Number.isFinite(minute)
        && lampCourseAt(minute, seasonShiftFor(seasonTokenForAtmosphere(atmosphere))) >= 2 ? 700 : 0;
}

export class ChimneySmoke {
    constructor() {
        this._sources = null;
        this._lastPuff = new Map();
    }

    // World-space chimney mouths, resolved once every building's art anchor
    // is known (a chimney is art-coupled: sprite-local px from the registry).
    sources(buildings, assets) {
        if (this._sources) return this._sources;
        if (!buildings || !assets?.has) return [];
        const out = [];
        for (const building of buildings.values ? buildings.values() : buildings) {
            const anchors = chimneyAnchors(building.type);
            if (!anchors.length) continue;
            const id = `building.${building.type}`;
            if (!assets.has(id)) return [];
            const anchor = assets.getAnchor(id);
            const center = buildingCenterToWorld(building);
            anchors.forEach((at, index) => {
                out.push(Object.freeze({
                    key: `${building.type}:${index}`,
                    type: building.type,
                    building,
                    localY: at[1],
                    x: Math.round(center.x - anchor[0] + at[0]),
                    y: Math.round(center.y - anchor[1] + at[1]),
                    hearth: HEARTH_TYPES.has(building.type),
                }));
            });
        }
        this._sources = out;
        return out;
    }

    // `heatFor(type)` (0..1) warms a hearth's soot toward the ember ramp in
    // four steps: a hot forge pushes browner smoke than a banked one.
    // `timeMs` is the motion-clock time the wind's gusts run on.
    // `sortYFor(building, localY)` is the owner half's painter sortY + 1.
    update({ now, timeMs = 0, buildings, assets, presence, particleSystem, atmosphere, heatFor = null, sortYFor = null } = {}) {
        if (!particleSystem?.motionEnabled) return;
        const weather = atmosphere?.weather?.type;
        const wet = weather === 'rain' || weather === 'storm';
        const dark = Number(atmosphere?.lightGrade?.night) > 0.35
            || atmosphere?.phase === 'night' || atmosphere?.phase === 'dusk';
        for (const source of this.sources(buildings, assets)) {
            const interval = smokeInterval(source, presence, atmosphere);
            if (!interval) continue;
            // Only the atmosphere fire uses stepped motion time for cadence;
            // workshop smoke keeps its existing work-presence scheduling.
            const stamp = source.type === 'watchtower' ? Math.floor(timeMs / 140) * 140 : now;
            const last = this._lastPuff.get(source.key) || 0;
            if (stamp - last < interval) continue;
            this._lastPuff.set(source.key, stamp);
            const tag = `chimney:${source.key}`;
            if (particleSystem.countTagged(tag) >= MAX_PUFFS_PER_CHIMNEY) continue;
            const options = {
                tag,
                spread: [0, 0],
                windX: smokeWindDrift(atmosphere, source.x, source.y, timeMs) * (wet ? 1.8 : 1),
                sortY: sortYFor ? sortYFor(source.building, source.localY) : null,
            };
            if (wet) {
                options.life = WET_LIFE;
                options.speed = WET_SPEED;
            }
            if (dark) {
                options.colors = MOONLIT_SOOT;
                const tones = moonlitTones(atmosphere?.lightGrade);
                if (tones) options.gradedColors = tones;
            }
            if (source.hearth) {
                if (dark) options.baseColor = HEARTH_UNDERSIDE;
                const heat = heatFor ? Number(heatFor(source.type)) || 0 : 0;
                const warmth = Math.round(Math.max(0, Math.min(1, heat)) * 3) / 3;
                if (warmth > 0 && !dark) options.colors = warmSoot(warmth);
            }
            particleSystem.spawn('smoke', source.x, source.y, 1, options);
        }
    }

    // Reduced motion: a static wisp stands in for each live column. On the
    // ungraded resident overlay pass the C2 `lightGrade` so it takes the
    // scene's light (moonlit soot after dark); the Canvas frame is graded
    // after the fact. The wisp leans with the knot wind (never a gust).
    drawStatic(ctx, { buildings, assets, presence, atmosphere = null, lightGrade = null, weather = null } = {}) {
        const tone = !lightGrade ? STATIC_TONE
            : Number(lightGrade.night) > 0.35 ? moonlitTones(lightGrade)[0]
                : gradedHex(STATIC_TONE, lightGrade);
        const lean = baseWindX(weather) < 0 ? -1 : 1;
        for (const source of this.sources(buildings, assets)) {
            if (!smokeInterval(source, presence, atmosphere)) continue;
            ctx.save();
            for (const puff of STATIC_WISP) {
                drawSmokePuff(ctx, source.x + puff.dx * lean, source.y + puff.dy, puff.radius, tone, smokePuffAlpha(-puff.dy));
            }
            ctx.restore();
        }
    }
}

const warmSootCache = new Map();
let moonlitCache = { key: null, tones: null };

// The overlay tones of MOONLIT_SOOT under `grade`: the grade's own response,
// lifted toward moonlight until each tone clears its floor. Memoized per
// grade course.
function moonlitTones(grade) {
    if (!grade) return null;
    const key = grade.cacheKey ?? null;
    if (key != null && moonlitCache.key === key) return moonlitCache.tones;
    const tones = MOONLIT_SOOT.map((hex, i) => {
        const n = Number.parseInt(hex.slice(1), 16);
        const graded = applyGradeToRgb([((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255], grade);
        const have = luma(graded);
        const floor = MOONLIT_FLOOR[i];
        const t = have >= floor ? 0 : Math.min(1, (floor - have) / Math.max(0.01, luma(MOONLIGHT) - have));
        const out = graded.map((c, k) => c + (MOONLIGHT[k] - c) * t);
        return `rgb(${out.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(', ')})`;
    });
    moonlitCache = { key, tones };
    return tones;
}

function luma(rgb) {
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function gradedHex(hex, grade) {
    const n = Number.parseInt(hex.slice(1), 16);
    const out = applyGradeToRgb([((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255], grade);
    return `rgb(${Math.round(out[0] * 255)}, ${Math.round(out[1] * 255)}, ${Math.round(out[2] * 255)})`;
}

// A hot hearth only tints its soot (at most 30 % toward the ember brown): the
// column must stay the plan's grey three-tone puff, which is what separates
// it from the plaza stone and warm roofs behind it.
function warmSoot(warmth) {
    let colors = warmSootCache.get(warmth);
    if (!colors) {
        colors = SMOKE_COOL_COLORS.map((cool, i) => mixHex(cool, SMOKE_WARM_COLORS[i] || cool, warmth * 0.3));
        warmSootCache.set(warmth, colors);
    }
    return colors;
}

function mixHex(a, b, t) {
    const from = Number.parseInt(a.slice(1), 16);
    const to = Number.parseInt(b.slice(1), 16);
    const channel = (shift) => {
        const start = (from >> shift) & 0xff;
        return Math.round(start + (((to >> shift) & 0xff) - start) * t);
    };
    return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`;
}
