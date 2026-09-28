// 6.7 — chimney smoke from real chimneys. Every building whose registry entry
// names a `smokeTop` (where a column leaves the cap) or `chimney` effect anchor
// gets a column of pixel puffs, and only while the building is occupied or
// busy: smoke says someone is working inside, so an empty building never
// smokes. Puffs sort just in front of the chimney's own building half (0.6),
// so a nearer tower hides them on both backends and their own roof never does.
//
// Weather: the one wind (C-W3, `windAt` at each chimney mouth, gusts
// included) leans the column — fog barely tilts it, a storm lays it flat —
// and rain and storm flatten and shorten it further. A hearth building's soot
// warms with its fire (#33), and at dusk and night its first puff carries the
// fire-lit underside.
// Reduced motion: one static three-puff wisp per smoking chimney.
import { getBuildingEffectAnchor } from './BuildingVisualRegistry.js';
import { SMOKE_COOL_COLORS, SMOKE_WARM_COLORS } from './ParticleSystem.js';
import { buildingCenterToWorld } from './Projection.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { smokeWindDrift } from './AtmosphereState.js';

// Spawn cadence per occupancy tier. With puffs living 1.5–2.3 s this keeps
// about 5 (occupied) to 8 (busy) puffs per chimney; a hard cap holds the
// ≤10 budget whatever the frame rate.
const PUFF_INTERVAL_MS = Object.freeze({ occupied: 420, busy: 260 });
const MAX_PUFFS_PER_CHIMNEY = 10;
// Buildings whose smoke rises off a live fire.
const HEARTH_TYPES = new Set(['forge']);
const HEARTH_UNDERSIDE = '#9a5a36';
// After dark the column must stay the palest thing over the dark roofs and
// lawns: moonlit soot. The Canvas frame is graded after the fact, so the
// authored albedo sits high; a backend that grades particles itself (the
// resident GPU draw) wears the grade's own response to that soot, held to a
// luminance floor by mixing toward cool moonlight so the column reads pale
// but never white (see `moonlitTones`).
const MOONLIT_SOOT = Object.freeze(['#a9aeb8', '#bec3cb', '#d3d6dc']);
const MOONLIT_FLOOR = Object.freeze([0.44, 0.51, 0.58]);
const MOONLIGHT = Object.freeze([0.70, 0.76, 0.86]);
const STATIC_WISP = Object.freeze([
    Object.freeze({ dx: 0, dy: -2, size: 3, alpha: 0.5 }),
    Object.freeze({ dx: -1, dy: -7, size: 4, alpha: 0.36 }),
    Object.freeze({ dx: -3, dy: -13, size: 4, alpha: 0.2 }),
]);
const STATIC_TONE = '#8d919a';

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
            const at = getBuildingEffectAnchor(building.type, 'smokeTop', null)
                || getBuildingEffectAnchor(building.type, 'chimney', null);
            if (!Array.isArray(at)) continue;
            const id = `building.${building.type}`;
            if (!assets.has(id)) return [];
            const anchor = assets.getAnchor(id);
            const center = buildingCenterToWorld(building);
            out.push(Object.freeze({
                type: building.type,
                building,
                localY: at[1],
                x: Math.round(center.x - anchor[0] + at[0]),
                y: Math.round(center.y - anchor[1] + at[1]),
                hearth: HEARTH_TYPES.has(building.type),
            }));
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
            const tier = presence?.get?.(source.type)?.tier;
            const interval = PUFF_INTERVAL_MS[tier];
            if (!interval) continue;
            const last = this._lastPuff.get(source.type) || 0;
            if (now - last < interval) continue;
            this._lastPuff.set(source.type, now);
            const tag = `chimney:${source.type}`;
            if (particleSystem.countTagged(tag) >= MAX_PUFFS_PER_CHIMNEY) continue;
            const options = {
                tag,
                spread: [1, 1],
                windX: smokeWindDrift(atmosphere, source.x, source.y, timeMs) * (wet ? 1.8 : 1),
                sortY: sortYFor ? sortYFor(source.building, source.localY) : null,
            };
            if (wet) {
                options.life = [48, 80];
                options.speed = [0.12, 0.2];
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
    // after the fact.
    drawStatic(ctx, { buildings, assets, presence, lightGrade = null } = {}) {
        const tone = !lightGrade ? STATIC_TONE
            : Number(lightGrade.night) > 0.35 ? moonlitTones(lightGrade)[1]
                : gradedHex(STATIC_TONE, lightGrade);
        for (const source of this.sources(buildings, assets)) {
            const tier = presence?.get?.(source.type)?.tier;
            if (!PUFF_INTERVAL_MS[tier]) continue;
            ctx.save();
            ctx.fillStyle = tone;
            for (const puff of STATIC_WISP) {
                ctx.globalAlpha = puff.alpha;
                const left = source.x + puff.dx - (puff.size >> 1);
                const top = source.y + puff.dy - (puff.size >> 1);
                ctx.fillRect(left + 1, top, puff.size - 2, puff.size);
                ctx.fillRect(left, top + 1, 1, puff.size - 2);
                ctx.fillRect(left + puff.size - 1, top + 1, 1, puff.size - 2);
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

function warmSoot(warmth) {
    let colors = warmSootCache.get(warmth);
    if (!colors) {
        colors = SMOKE_COOL_COLORS.map((cool, i) => mixHex(cool, SMOKE_WARM_COLORS[i] || cool, warmth * 0.85));
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
