// 6.4 — smoke that reads, from every real chimney. Every building whose
// registry entry names `smokeTop` anchors (where a column leaves a cap; the
// Harbor has one per stack) or a `chimney` effect anchor gets a column of
// round three-tone puffs (ParticleSystem shape 'smoke': radius 3 -> 7 art px
// over life, lit `#d3d6dc` / body `#a9aeb8` / shade `#787c86`, four alpha
// quanta by height, gone at 78 world px). Workshops require working visitors
// (V8); the watchtower crown alone burns on full lamplight's clock gate.
// Puffs sort just in front of the chimney's own building half (0.6),
// so nearer buildings hide them on both backends; their own roof never does.
// Cadence runs on the stepped motion clock (140 ms quanta), with a cold-boot
// and scrub-only pre-seed so already-active chimneys open with a staggered
// column while mid-session activations emit a single mouth puff.
//
// Weather: the one wind (C-W3, `windAt` at each chimney mouth, gusts
// included) leans the column — fog barely tilts it, a storm lays it flat —
// and rain and storm flatten and shorten it further. A hearth building's soot
// warms with its fire (#33), and at dusk and night its first puff carries the
// fire-lit underside.
// Reduced motion: one static three-puff wisp per smoking chimney, the same
// puffs at the same scale, leaning with the knot wind.
import { getBuildingEffectAnchor } from './BuildingVisualRegistry.js';
import { workerTier } from './BuildingPartGates.js';
import { drawSmokePuff, SMOKE_COLUMN_PX, smokePuffAlpha, SMOKE_COOL_COLORS, SMOKE_WARM_COLORS } from './ParticleSystem.js';
import { buildingCenterToWorld } from './Projection.js';
import { applyGradeToRgb, lampCourseAt } from './GradeEvaluator.js';
import { dayShiftFor, smokeWindDrift } from './AtmosphereState.js';
import { baseWindX } from './Wind.js';

// Spawn cadence per occupancy tier and worker-count tier (1, 2–4, 5+).
// A hard cap holds the puff budget whatever the frame rate.
const PUFF_INTERVAL_MS = Object.freeze({ occupied: 420, busy: 260 });
const WORKER_TIER_INTERVAL_MS = Object.freeze([0, 420, 280, 140]);
const MAX_PUFFS_PER_CHIMNEY = 10;
const MAX_PUFFS_TIER3 = 12;
const COLD_PRESEED_FRACS = Object.freeze([0.16, 0.32, 0.48]);
const SCRUB_JUMP_MS = 1000;
const SCRUB_MINUTE_JUMP = 30;
// Rain and storm flatten the column: slower, shorter-lived puffs that the
// wind lays over (about half the dry column's height).
const WET_LIFE = Object.freeze([84, 108]);
const WET_SPEED = Object.freeze([0.34, 0.40]);
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
    Object.freeze({ dx: 0, dy: -4, radius: 3 }),
    Object.freeze({ dx: 3, dy: -20, radius: 4 }),
    Object.freeze({ dx: 7, dy: -40, radius: 6 }),
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
    if (source.type === 'watchtower' && source.kind !== 'cottage') {
        const minute = Number(atmosphere?.clock?.minuteOfDay);
        return Number.isFinite(minute)
            && lampCourseAt(minute, dayShiftFor(atmosphere)) >= 2 ? 700 : 0;
    }
    const entry = presence?.get?.(source.type);
    if (!entry) return 0;
    if (Number.isFinite(entry.count) && entry.count > 0) {
        return WORKER_TIER_INTERVAL_MS[workerTier(entry.count)] || 0;
    }
    return PUFF_INTERVAL_MS[entry.tier] || 0;
}

function maxPuffsFor(source, presence) {
    if (source.type === 'watchtower' && source.kind !== 'cottage') return MAX_PUFFS_PER_CHIMNEY;
    const count = presence?.get?.(source.type)?.count;
    return Number.isFinite(count) && workerTier(count) >= 3 ? MAX_PUFFS_TIER3 : MAX_PUFFS_PER_CHIMNEY;
}

function minuteJump(a, b) {
    const diff = Math.abs(a - b) % 1440;
    return Math.min(diff, 1440 - diff);
}

export class ChimneySmoke {
    constructor() {
        this._sources = null;
        this._lastPuff = new Map();
        this._initialized = false;
        this._lastClockMs = null;
        this._lastMinuteOfDay = null;
    }

    // World-space chimney mouths, resolved once every building's art anchor
    // is known (a chimney is art-coupled: sprite-local px from the registry).
    sources(buildings, assets) {
        if (this._sources) return this._sources;
        if (!buildings || !assets?.has) return [];
        const out = [];
        for (const building of buildings.values ? buildings.values() : buildings) {
            const anchors = chimneyAnchors(building.type);
            const cottage = getBuildingEffectAnchor(building.type, 'cottageSmokeTop', null);
            if (!anchors.length && !Array.isArray(cottage)) continue;
            const id = `building.${building.type}`;
            if (!assets.has(id)) return [];
            const anchor = assets.getAnchor(id);
            const center = buildingCenterToWorld(building);
            anchors.forEach((at, index) => {
                out.push(Object.freeze({
                    key: `${building.type}:${index}`,
                    type: building.type,
                    kind: building.type === 'watchtower' ? 'crown' : 'workshop',
                    building,
                    localY: at[1],
                    x: Math.round(center.x - anchor[0] + at[0]),
                    y: Math.round(center.y - anchor[1] + at[1]),
                    hearth: HEARTH_TYPES.has(building.type),
                }));
            });
            if (Array.isArray(cottage)) {
                out.push(Object.freeze({
                    key: `${building.type}:cottage`,
                    type: building.type,
                    kind: 'cottage',
                    building,
                    localY: cottage[1],
                    x: Math.round(center.x - anchor[0] + cottage[0]),
                    y: Math.round(center.y - anchor[1] + cottage[1]),
                    hearth: false,
                }));
            }
        }
        this._sources = out;
        return out;
    }

    // `heatFor(type)` (0..1) warms a hearth's soot toward the ember ramp in
    // four steps: a hot forge pushes browner smoke than a banked one.
    // `timeMs` is the motion-clock time the wind's gusts run on.
    // `sortYFor(building, localY)` is the owner half's painter sortY + 1.
    update({ now, timeMs, buildings, assets, presence, particleSystem, atmosphere, heatFor = null, sortYFor = null } = {}) {
        if (!particleSystem?.motionEnabled) return;
        const sources = this.sources(buildings, assets);
        if (!sources.length) return;
        // Wait for the first real atmosphere frame before latching cold-boot
        // state: IsometricRenderer._loop runs _update() before _render()
        // populates _lastAtmosphere on Frame 1.
        if (!atmosphere) return;
        const clockMs = Number.isFinite(timeMs) ? timeMs : (Number(now) || 0);
        const stamp = Math.floor(clockMs / 140) * 140;
        const minute = Number(atmosphere?.clock?.minuteOfDay);
        const hasMinute = Number.isFinite(minute);
        const clockScrub = this._lastClockMs !== null
            && (clockMs < this._lastClockMs || (clockMs - this._lastClockMs) > SCRUB_JUMP_MS);
        const minuteScrub = hasMinute
            && this._lastMinuteOfDay !== null
            && minuteJump(minute, this._lastMinuteOfDay) > SCRUB_MINUTE_JUMP;
        const coldOrScrub = !this._initialized || clockScrub || minuteScrub;
        const weather = atmosphere?.weather?.type;
        const wet = weather === 'rain' || weather === 'storm';
        const dark = Number(atmosphere?.lightGrade?.night) > 0.35
            || atmosphere?.phase === 'night' || atmosphere?.phase === 'dusk';
        const livePool = Array.isArray(particleSystem.particles) ? particleSystem.particles : null;
        for (const source of sources) {
            const interval = smokeInterval(source, presence, atmosphere);
            if (!interval) {
                this._lastPuff.delete(source.key);
                continue;
            }
            const tag = `chimney:${source.key}`;
            const liveCount = particleSystem.countTagged(tag);
            let last = this._lastPuff.get(source.key);
            if (last !== undefined && (stamp < last || (coldOrScrub && livePool && liveCount === 0))) {
                this._lastPuff.delete(source.key);
                last = undefined;
            }
            const maxPuffs = maxPuffsFor(source, presence);
            if (last !== undefined && stamp - last < interval) continue;
            if (liveCount >= maxPuffs) continue;
            const preseed = Boolean(coldOrScrub && livePool && liveCount === 0);
            const wantCount = preseed
                ? Math.min(1 + COLD_PRESEED_FRACS.length, maxPuffs - liveCount)
                : 1;
            const options = {
                tag,
                spread: [0, 0],
                windX: smokeWindDrift(atmosphere, source.x, source.y, clockMs) * (wet ? 1.8 : 1),
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
            const tailBefore = livePool && livePool.length ? livePool[livePool.length - 1] : null;
            particleSystem.spawn('smoke', source.x, source.y, wantCount, options);
            if (livePool) {
                const added = [];
                for (let idx = livePool.length - 1; idx >= 0 && added.length < wantCount; idx--) {
                    const puff = livePool[idx];
                    if (puff === tailBefore) break;
                    if (puff.tag === tag) added.push(puff);
                }
                if (added.length === 0) continue;
                this._lastPuff.set(source.key, stamp);
                if (preseed && added.length > 1) {
                    added.reverse();
                    for (let k = 1; k < added.length && k - 1 < COLD_PRESEED_FRACS.length; k++) {
                        const puff = added[k];
                        const ageFrames = puff.maxLife * COLD_PRESEED_FRACS[k - 1];
                        puff.x += puff.vx * ageFrames;
                        puff.y = Math.max(puff.originY - SMOKE_COLUMN_PX + 3, puff.y + puff.vy * ageFrames);
                        puff.life = Math.max(1, puff.maxLife - ageFrames);
                    }
                }
            } else {
                this._lastPuff.set(source.key, stamp);
            }
        }
        this._initialized = true;
        this._lastClockMs = clockMs;
        if (hasMinute) this._lastMinuteOfDay = minute;
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
