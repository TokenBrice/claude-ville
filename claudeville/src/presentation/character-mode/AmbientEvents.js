// claudeville/src/presentation/character-mode/AmbientEvents.js
//
// W6.2 — the island's ambient rhythm. One deterministic schedule of small,
// non-agent events per local date, seeded from `localDateKey` exactly like
// `buildWeatherTimeline`, so a day is reproducible, survives a reload and can
// be pinned for QA. Three tiers, at most one event active in each:
//
//   frequent    a slot every 2–6 min   (a lone cloud pass, a gull fishing run,
//                                       a far gull wisp, a distant shower)
//   occasional  a slot every 20–60 min (a heron relocation)
//   rare        0–3 slots a day        (a whale spout, a dolphin pod)
//
// A slot's kind is the first kind in its seeded preference order that the
// clock, the calendar and the village's own weather allow this minute (V3:
// nothing agent-, mood-, director- or attention-derived reaches it; the
// output is identical for any agent roster). Every tier holds at
// motionScale <= 0, the fauna kinds hold when `ornamentPlan()` sheds fauna
// cadence under frame pressure, the weather kinds when it sheds weather
// embellishment, and an operator `calmGate=quiet` holds the occasional and
// rare set-pieces (the frequent tier is the quietest life there is).
//
// The scheduler never moves the camera, emits a cue, raises attention or
// claims a C4 Major: consumers only read which event is live and draw it.
// `ambientEventsAt` is memoized per 10 s bucket (and per gate signature), so
// a frame that changes nothing allocates nothing; the returned record is
// shared until the bucket moves, and consumers must not keep it across
// buckets. Within a bucket a consumer times its own pose from `startMs` /
// `endMs` (wall clock), drawing nothing outside that window.

import { hashString, localDateKey, buildWeatherTimeline } from './AtmosphereState.js';
import { squallApproach, distantShowerFront } from './CoastBake.js';
import { cloudCoveredShare, effectBudgetMode } from './gpu/GpuWorldPolicy.js';
import { ornamentPlan, readCalmGateOverride, sampleFramePressure, PRESSURE_LEVELS } from './MarkGovernor.js';
import { seasonTokenForAtmosphere, seasonalDriftCap, monthIndexForAtmosphere } from './SeasonalAmbience.js';
import { songbirdBudget, fireflyBudget, ashMoteBudget, dragonflyBudget, livestockBudget } from './WildlifeRenderer.js';
import { CALM_WATER_FAUNA, SHORE_FAUNA } from '../../config/scenery.js';
import { horizonLifeStats, liveHorizonEvents } from './HorizonLife.js';

export const AMBIENT_TIERS = Object.freeze(['frequent', 'occasional', 'rare']);
export const AMBIENT_BUCKET_MS = 10000;
// Start-to-start gaps (seconds); a slot ends at least SLOT_TAIL_S before the
// next one starts, so a tier never runs two events at once.
const TIER_GAPS_S = Object.freeze({
    frequent: Object.freeze([120, 360]),
    occasional: Object.freeze([1200, 3600]),
});
const RARE_PER_DAY_MAX = 3;
const SLOT_TAIL_S = 15;
// The lowest cloud cover that can honestly cast a lone shadow: below it the
// sky is cloudless and the island stays in full sun.
export const LONE_CLOUD_MIN_COVER = 0.08;

// `eligible(gates)` reads only the gates this module resolves from the
// clock, the calendar and the timeline weather. `shed` names the
// `ornamentPlan()` field that must read 'on' for the kind to run. `live:
// false` declares a kind whose consumer has not landed: it is listed so its
// batch plugs straight in, but never scheduled (an event nothing draws would
// make the audit lie).
export const AMBIENT_EVENT_KINDS = Object.freeze([
    Object.freeze({
        id: 'lone-cloud',
        tier: 'frequent',
        weight: 3,
        durationS: Object.freeze([110, 200]),
        shed: 'ambientWeatherEmbellishment',
        consumer: 'CloudShadowCourses',
        live: true,
        eligible: gates => gates.phase === 'day' && gates.loneSky && !gates.approach,
    }),
    Object.freeze({
        id: 'gull-fishing-run',
        tier: 'frequent',
        weight: 2,
        durationS: Object.freeze([45, 80]),
        shed: 'faunaCadence',
        consumer: 'WildlifeRenderer',
        live: true,
        eligible: gates => gates.phase !== 'night' && !gates.wet && !gates.approach,
    }),
    // W6.5: a heron flies to another shallow and back (WildlifeRenderer).
    Object.freeze({
        id: 'heron-relocation',
        tier: 'occasional',
        weight: 1,
        durationS: Object.freeze([24, 40]),
        shed: 'faunaCadence',
        consumer: 'WildlifeRenderer',
        live: true,
        eligible: gates => gates.phase !== 'night' && gates.type !== 'storm',
    }),
    // W8.4a (AW-P15): a stag steps out of the treeline north of the lagoon
    // at dawn, grazes and walks back (WildlifeRenderer). Dawn spans one or
    // two occasional slots, shared with the heron: some mornings, never more.
    Object.freeze({
        id: 'deer-at-dawn',
        tier: 'occasional',
        weight: 1,
        durationS: Object.freeze([80, 140]),
        shed: 'faunaCadence',
        consumer: 'WildlifeRenderer',
        live: true,
        eligible: gates => gates.phase === 'dawn' && !gates.wet,
    }),
    // W6.7: horizon life on the far sea (HorizonLife). No sails or hulls.
    Object.freeze({
        id: 'far-gull-wisp',
        tier: 'frequent',
        weight: 2,
        durationS: Object.freeze([6, 10]),
        shed: 'faunaCadence',
        consumer: 'HorizonLife',
        live: true,
        eligible: gates => gates.phase !== 'night' && !gates.wet && gates.type !== 'fog',
    }),
    Object.freeze({
        id: 'distant-shower',
        tier: 'frequent',
        weight: 3,
        durationS: Object.freeze([90, 180]),
        shed: 'ambientWeatherEmbellishment',
        consumer: 'HorizonLife',
        live: true,
        eligible: gates => gates.showerFront,
    }),
    Object.freeze({
        id: 'whale-spout',
        tier: 'rare',
        weight: 2,
        perDayMax: 2,
        durationS: Object.freeze([40, 90]),
        shed: 'faunaCadence',
        consumer: 'HorizonLife',
        live: true,
        eligible: gates => gates.phase === 'day' && gates.calmSea,
    }),
    Object.freeze({
        id: 'dolphin-pod',
        tier: 'rare',
        weight: 1,
        perDayMax: 2,
        durationS: Object.freeze([30, 60]),
        shed: 'faunaCadence',
        consumer: 'HorizonLife',
        live: true,
        eligible: gates => gates.phase !== 'night' && gates.calmSea,
    }),
]);

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function lerp(range, t) {
    return range[0] + (range[1] - range[0]) * t;
}

// Weighted order without replacement over the tier's live kinds.
function slotOrder(random, kinds) {
    const pool = kinds.slice();
    const order = [];
    while (pool.length) {
        let total = 0;
        for (const kind of pool) total += kind.weight;
        let roll = random() * total;
        let pick = 0;
        while (pick < pool.length - 1 && roll >= pool[pick].weight) {
            roll -= pool[pick].weight;
            pick++;
        }
        order.push(pool[pick]);
        pool.splice(pick, 1);
    }
    return Object.freeze(order);
}

function slot(tier, index, startMs, capMs, random, kinds) {
    return Object.freeze({
        tier,
        index,
        startMs,
        capMs,
        durationRoll: random(),
        seed: random(),
        order: slotOrder(random, kinds),
    });
}

function midnightOf(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The day's slots per tier for `date` (a Date): `{ dateKey, dayStartMs,
 * dayEndMs, frequent, occasional, rare }`, each tier a start-sorted array
 * of frozen `{ tier, index, startMs, capMs, durationRoll, seed, order }`.
 */
export function buildAmbientSchedule(date, kinds = AMBIENT_EVENT_KINDS) {
    const dateKey = localDateKey(date);
    const dayStartMs = midnightOf(date);
    const dayEndMs = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const random = mulberry32(hashString(`${dateKey}|ambient-events`));
    const tierKinds = tier => kinds.filter(kind => kind.live && kind.tier === tier);
    const schedule = { dateKey, dayStartMs, dayEndMs };
    for (const tier of ['frequent', 'occasional']) {
        const live = tierKinds(tier);
        const gaps = TIER_GAPS_S[tier];
        const slots = [];
        let start = dayStartMs + lerp(gaps, random()) * 1000 * random();
        while (start < dayEndMs) {
            const gapMs = lerp(gaps, random()) * 1000;
            const capMs = Math.min(dayEndMs, start + gapMs - SLOT_TAIL_S * 1000);
            slots.push(slot(tier, slots.length, Math.round(start), Math.round(capMs), random, live));
            start += gapMs;
        }
        schedule[tier] = Object.freeze(slots);
    }
    const rareLive = tierKinds('rare');
    const rareCount = Math.min(RARE_PER_DAY_MAX, Math.floor(random() * (RARE_PER_DAY_MAX + 1)));
    const rareStarts = [];
    for (let i = 0; i < rareCount; i++) rareStarts.push(Math.round(dayStartMs + random() * (dayEndMs - dayStartMs)));
    rareStarts.sort((a, b) => a - b);
    // A kind with `perDayMax` stays in at most that many of the day's rare
    // slot orders (any slot it could play counts), so the cap holds whatever
    // the weather lets through.
    const offered = new Map();
    schedule.rare = Object.freeze(rareStarts.map((startMs, index) => {
        const record = slot(
            'rare',
            index,
            startMs,
            Math.max(startMs, (rareStarts[index + 1] ?? dayEndMs) - SLOT_TAIL_S * 1000),
            random,
            rareLive,
        );
        const order = record.order.filter(kind => !(kind.perDayMax >= 0) || (offered.get(kind.id) || 0) < kind.perDayMax);
        for (const kind of order) offered.set(kind.id, (offered.get(kind.id) || 0) + 1);
        return order.length === record.order.length ? record : Object.freeze({ ...record, order: Object.freeze(order) });
    }));
    return Object.freeze(schedule);
}

/**
 * The weather/phase gates a kind's `eligible` reads, resolved once per call.
 * `loneSky`: a fair-weather sky whose cloud field casts no courses of its
 * own (cover below 0.15) but still holds cloud (cover >= 0.08).
 * `showerFront`: the distant shower's window (CoastBake.distantShowerFront).
 * `calmSea`: a fair, settled sea (clear or partly cloudy, no front coming).
 */
export function ambientGates(ctx = {}, out = {}) {
    const weather = ctx.weather || null;
    const type = weather?.type || 'clear';
    const cover = Number(weather?.cloudCover);
    out.type = type;
    out.phase = ctx.phase || 'day';
    out.season = ctx.season || '';
    out.wet = type === 'rain' || type === 'storm';
    out.approach = squallApproach(weather);
    out.loneSky = (type === 'clear' || type === 'partly-cloudy')
        && Number.isFinite(cover)
        && cover >= LONE_CLOUD_MIN_COVER
        && cloudCoveredShare(cover) <= 0;
    out.showerFront = distantShowerFront(weather);
    out.calmSea = (type === 'clear' || type === 'partly-cloudy') && !out.approach && !out.showerFront;
    return out;
}

function findSlot(slots, t) {
    let lo = 0;
    let hi = slots.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (slots[mid].startMs <= t) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

function firstEligible(order, gates) {
    for (const kind of order) if (kind.eligible(gates)) return kind;
    return null;
}

function eventEndMs(slotRecord, kind) {
    return Math.min(slotRecord.capMs, slotRecord.startMs + Math.round(lerp(kind.durationS, slotRecord.durationRoll) * 1000));
}

function holdReason(tier, kind, plan, ctx) {
    if (!(Number(ctx.motionScale) > 0)) return 'reduced-motion';
    if (ctx.calm && tier !== 'frequent') return 'calm';
    if (plan[kind.shed] !== 'on') return 'pressure';
    return null;
}

/**
 * Build a scheduler over `kinds` (the default is AMBIENT_EVENT_KINDS; tests
 * and batch-2 work may pass their own table). `at(date, ctx)` resolves the
 * live events for the 10 s bucket holding `date` (a Date or epoch ms) under
 * `ctx = { weather, phase, season, motionScale, level, calm }`:
 *
 *   { dateKey, bucketMs,
 *     frequent | occasional | rare: { kind, tier, index, startMs, endMs, seed } | null,
 *     held: { <tier>: null | 'reduced-motion' | 'no-live-kinds' | 'calm' | 'pressure' | 'weather' | 'between' },
 *     next: { <tier>: { kind | null, startMs } | null } }
 */
export function createAmbientScheduler(kinds = AMBIENT_EVENT_KINDS) {
    const schedules = new Map();
    const gates = {};
    let memo = null;
    let memoBucket = NaN;
    let memoType = '';
    let memoPhase = '';
    let memoSeason = '';
    let memoBits = -1;
    let memoLevel = NaN;

    function scheduleFor(date) {
        const key = localDateKey(date);
        let schedule = schedules.get(key);
        if (!schedule) {
            schedule = buildAmbientSchedule(date, kinds);
            if (schedules.size >= 3) schedules.delete(schedules.keys().next().value);
            schedules.set(key, schedule);
        }
        return schedule;
    }

    function at(dateOrMs, ctx = {}) {
        const t = dateOrMs instanceof Date ? dateOrMs.getTime() : Number(dateOrMs);
        if (!Number.isFinite(t)) return null;
        const bucketMs = Math.floor(t / AMBIENT_BUCKET_MS) * AMBIENT_BUCKET_MS;
        ambientGates(ctx, gates);
        const bits = (Number(ctx.motionScale) > 0 ? 1 : 0)
            | (ctx.calm ? 2 : 0)
            | (gates.wet ? 4 : 0)
            | (gates.approach ? 8 : 0)
            | (gates.loneSky ? 16 : 0)
            | (gates.showerFront ? 32 : 0)
            | (gates.calmSea ? 64 : 0);
        const level = Number(ctx.level) || 0;
        if (memo && bucketMs === memoBucket && bits === memoBits && level === memoLevel
            && gates.type === memoType && gates.phase === memoPhase && gates.season === memoSeason) {
            return memo;
        }
        memoBucket = bucketMs;
        memoBits = bits;
        memoLevel = level;
        memoType = gates.type;
        memoPhase = gates.phase;
        memoSeason = gates.season;

        const schedule = scheduleFor(new Date(bucketMs));
        const plan = ornamentPlan({ level, motionScale: ctx.motionScale, calm: Boolean(ctx.calm) });
        const bucketEnd = bucketMs + AMBIENT_BUCKET_MS;
        const out = { dateKey: schedule.dateKey, bucketMs, frequent: null, occasional: null, rare: null, held: {}, next: {} };
        for (const tier of AMBIENT_TIERS) {
            const slots = schedule[tier];
            const index = findSlot(slots, bucketEnd - 1);
            const current = index >= 0 ? slots[index] : null;
            // Why the tier is quiet this bucket: the strongest gate first.
            let held = !(Number(ctx.motionScale) > 0) ? 'reduced-motion'
                : !kinds.some(kind => kind.live && kind.tier === tier) ? 'no-live-kinds'
                    : 'between';
            if (held === 'between' && current && current.capMs > bucketMs) {
                const kind = firstEligible(current.order, gates);
                if (!kind) {
                    held = 'weather';
                } else {
                    const endMs = eventEndMs(current, kind);
                    if (endMs > bucketMs) {
                        held = holdReason(tier, kind, plan, ctx);
                        if (!held) {
                            out[tier] = Object.freeze({
                                kind: kind.id,
                                tier,
                                index: current.index,
                                startMs: current.startMs,
                                endMs,
                                seed: current.seed,
                            });
                        }
                    }
                }
            }
            out.held[tier] = out[tier] ? null : held;
            const upcoming = slots[index + 1] || null;
            out.next[tier] = upcoming
                ? Object.freeze({ kind: firstEligible(upcoming.order, gates)?.id || null, startMs: upcoming.startMs })
                : null;
        }
        Object.freeze(out.held);
        Object.freeze(out.next);
        memo = Object.freeze(out);
        return memo;
    }

    return { at, scheduleFor, kinds };
}

const defaultScheduler = createAmbientScheduler();

/** The live ambient events for `date` (see createAmbientScheduler). */
export function ambientEventsAt(date, ctx = {}) {
    return defaultScheduler.at(date, ctx);
}

/**
 * Progress through a live event at `nowMs` in [0, 1], or -1 outside it.
 */
export function ambientEventProgress(event, nowMs) {
    if (!event) return -1;
    const span = event.endMs - event.startMs;
    if (!(span > 0) || nowMs < event.startMs || nowMs >= event.endMs) return -1;
    return (nowMs - event.startMs) / span;
}

// The renderer's call: the atmosphere's own clock (so a QA-pinned hour pins
// the events too) and weather, the motion scale, frame pressure and the
// operator calm override, sampled once per bucket. Never the agent roster,
// attention or the director (V3); `resolveCalmGate()` is not consulted
// because its hints are agent-derived.
const hostCtx = { weather: null, phase: 'day', season: '', motionScale: 1, level: 0, calm: false };
let hostBucket = NaN;

export function ambientEventsForHost(host, nowMs = Date.now()) {
    const atmosphere = host?._lastAtmosphere || null;
    const date = atmosphere?.effectiveDate;
    const t = date instanceof Date ? date.getTime() : nowMs;
    const bucket = Math.floor(t / AMBIENT_BUCKET_MS);
    if (bucket !== hostBucket) {
        hostBucket = bucket;
        hostCtx.season = seasonTokenForAtmosphere(atmosphere);
        hostCtx.level = Number(sampleFramePressure()?.level) || 0;
        hostCtx.calm = readCalmGateOverride() === 'quiet';
    }
    hostCtx.weather = atmosphere?.weather || null;
    hostCtx.phase = atmosphere?.phase || atmosphere?.clock?.phase || 'day';
    hostCtx.motionScale = Number(host?.motionScale ?? 1);
    installAmbientDebugHelper();
    return withForcedEvent(ambientEventsAt(t, hostCtx), t, hostCtx.motionScale);
}

// QA only: `window.__claudeVilleAmbient.force(kind, seconds?)` runs one live
// kind now in its tier (its own duration range's midpoint unless `seconds`
// is given), replacing that tier's slot until it ends; `clear()` drops it.
// It advances on the wall clock even while QA pins the hour (a pinned
// atmosphere clock would hold its pose), re-anchored to the atmosphere
// clock each call. Reduced motion still holds it. Never reachable from
// agent, mood or director state (V3).
let forceRequest = null;
let forced = null;
let debugHelperInstalled = false;

function installAmbientDebugHelper() {
    if (debugHelperInstalled || typeof window === 'undefined') return;
    debugHelperInstalled = true;
    window.__claudeVilleAmbient = {
        force(kind, seconds) {
            const known = AMBIENT_EVENT_KINDS.find(item => item.id === kind && item.live);
            if (!known) return false;
            forceRequest = { kind: known, seconds: Number(seconds) };
            return true;
        },
        clear() {
            forceRequest = null;
            forced = null;
        },
        kinds: () => ambientEventKindRows(),
    };
}

function withForcedEvent(events, t, motionScale) {
    const wall = Date.now();
    if (forceRequest) {
        const { kind, seconds } = forceRequest;
        forceRequest = null;
        const spanMs = Math.round((seconds > 0 ? seconds : lerp(kind.durationS, 0.5)) * 1000);
        forced = { kind: kind.id, tier: kind.tier, wallStart: wall, spanMs, seed: (wall % 997) / 997 };
    }
    if (!forced) return events;
    const elapsed = wall - forced.wallStart;
    if (elapsed >= forced.spanMs) {
        forced = null;
        return events;
    }
    if (!(motionScale > 0) || !events) return events;
    const record = Object.freeze({ kind: forced.kind, tier: forced.tier, index: -1, startMs: t - elapsed, endMs: t - elapsed + forced.spanMs, seed: forced.seed });
    return Object.freeze({ ...events, [forced.tier]: record, held: Object.freeze({ ...events.held, [forced.tier]: null }) });
}

/** Every kind with its tier, consumer and whether it is scheduled yet. */
export function ambientEventKindRows(kinds = AMBIENT_EVENT_KINDS) {
    return kinds.map(kind => ({ id: kind.id, tier: kind.tier, consumer: kind.consumer, live: kind.live }));
}

/** One on-demand snapshot shared by Shift-D and the perf helper, never agent-derived. */
export function ambientDebugSnapshot(renderer) {
    const atmosphere = renderer?._lastAtmosphere || {};
    const weather = atmosphere.weather || {};
    const phase = atmosphere.phase || atmosphere.clock?.phase || 'day';
    const zoom = renderer?.camera?.zoom ?? 1;
    const motionScale = renderer?.motionScale ?? 1;
    const gates = ambientGates({ weather, phase });
    const wildlife = renderer?.wildlifeRenderer;
    const drawn = wildlife?._drawn || {};
    const gulls = wildlife?.lastGullStats || {};
    const context = { zoom, motionScale, phase, weatherType: weather.type || 'clear', month: monthIndexForAtmosphere(atmosphere), approach: gates.approach };
    const songbirds = songbirdBudget(context);
    const pressure = Number(sampleFramePressure()?.level) || 0;
    const fireflies = fireflyBudget({ ...context, level: pressure });
    const ashMotes = ashMoteBudget({ ...context, level: pressure });
    const dragonflies = dragonflyBudget({ ...context, level: pressure, calm: readCalmGateOverride() === 'quiet' });
    const livestock = livestockBudget({ ...context, level: pressure, calm: readCalmGateOverride() === 'quiet' });
    const driftCap = seasonalDriftCap(zoom);
    const driftReason = !(motionScale > 0) ? 'reduced-motion'
        : !driftCap ? 'zoom'
            : pressure >= PRESSURE_LEVELS.PARTICLES ? 'pressure'
                : phase === 'night' ? 'phase'
                    : !renderer?.seasonalAmbience?._driftSeason?.() ? 'weather/season' : null;
    const events = renderer?.ambientEvents;
    const date = atmosphere.effectiveDate || atmosphere.clock?.date;
    const knots = atmosphere.timeline?.knots || weather.timeline
        || (date instanceof Date ? buildWeatherTimeline(date, atmosphere.timeline?.seedOverride).knots : []);
    const loneKind = AMBIENT_EVENT_KINDS.find(kind => kind.id === 'lone-cloud');
    const cloudLevel = renderer?.worldRendererMode === 'canvas' ? 0 : renderer?.gpuWorld?.qualityLadder?.getLevel?.() || 0;
    const loneGate = !(motionScale > 0) ? 'reduced-motion'
        : !loneKind?.eligible(gates) ? 'weather/phase'
            : effectBudgetMode('cloud-courses', cloudLevel) === 'off' ? 'minimal'
                : ornamentPlan({ level: pressure, motionScale, calm: false }).ambientWeatherEmbellishment !== 'on' ? 'pressure' : null;
    const loneActive = !loneGate && Boolean(renderer?.ambientLoneCloud?.active);
    const tiers = {};
    for (const tier of AMBIENT_TIERS) {
        tiers[tier] = { kind: events?.[tier]?.kind || null, reason: events?.held?.[tier] || null, next: events?.next?.[tier] || null };
    }
    return {
        dateKey: events?.dateKey || null,
        actors: {
            gulls: { live: (gulls.visible || 0) + (gulls.roosting || 0), cap: gulls.cap || 0, reason: gulls.mode === 'flying' ? null : gulls.mode || 'not-drawn' },
            songbirds: { live: drawn.songbirds || 0, cap: songbirds.cap, reason: wildlife?._songbirdsSettling ? 'squall-settling' : songbirds.reason },
            fireflies: { live: drawn.fireflies || 0, cap: fireflies.cap, reason: fireflies.reason },
            'ash motes': { live: drawn.ashMotes || 0, cap: ashMotes.cap, reason: ashMotes.reason },
            'seasonal drift': { live: renderer?.particleSystem?.countTagged?.('seasonal-drift') || 0, cap: driftReason ? 0 : driftCap, reason: driftReason },
            'ducks/herons': { live: (drawn.ducks || 0) + (drawn.herons || 0), cap: (weather.type === 'storm' ? 0 : CALM_WATER_FAUNA.length) + SHORE_FAUNA.length, reason: weather.type === 'storm' ? 'storm-cover' : gates.wet || gates.approach ? 'cover' : !(motionScale > 0) ? 'reduced-motion' : null },
            dragonflies: { live: drawn.dragonflies || 0, cap: dragonflies.cap, reason: dragonflies.reason },
            // W8.4a — paddock, hens, dog and cat (standing while `reason` is set).
            livestock: { live: drawn.livestock || 0, cap: livestock.cap, reason: livestock.reason },
            deer: { live: drawn.deer || 0, cap: tiers.occasional.kind === 'deer-at-dawn' ? 1 : 0, reason: !(motionScale > 0) ? 'reduced-motion' : tiers.occasional.kind === 'deer-at-dawn' ? null : 'no-deer-event' },
            'lone cloud': { live: loneActive ? 1 : 0, cap: loneGate ? 0 : 1, reason: loneGate || (loneActive ? null : tiers.frequent.reason || 'other-event') },
            // W6.7 — the far-sea events (at most one per tier: frequent + rare).
            'horizon life': {
                live: horizonLifeStats.kinds.length,
                cap: liveHorizonEvents(renderer).length,
                reason: !(motionScale > 0) ? 'reduced-motion' : horizonLifeStats.kinds.length ? null : 'no-horizon-event',
            },
        },
        tiers,
        weatherKnots: knots.map(knot => ({ minute: knot.minute, type: knot.type })),
    };
}

// W6.8 (AW-P11, without the boat and townsfolk beats) — the day-part beats:
// the town's clock shown, not told. Unlike the slot tiers above they are
// clock-fixed (one window a day at the same atmosphere minute, so a pinned
// `setHour` pins them too) and read only the clock (V3). Each consumer holds
// a static frame at motionScale <= 0 and plays its beat once per window:
//   dawn-rise  sunrise .. +3 min  the roosting gulls rise in one wave
//                                 (WildlifeRenderer); the ground haze lifts
//                                 through the same dawn on its own course
//                                 (WorldFrameRenderer.groundHazeStrength)
//   noon-bell  12:00 .. 12:01     the Archive bell louvre swings 3 stepped
//                                 frames once (BuildingSprite fixture part,
//                                 gate `clock.noon-bell`)
// Fixture beats, never work parts: no beat reads occupancy, so `no-agents`
// still shows no work effects.
export const DAY_PART_BEATS = Object.freeze([
    Object.freeze({ id: 'dawn-rise', anchor: 'sunrise', durationMin: 3, consumer: 'WildlifeRenderer' }),
    Object.freeze({ id: 'noon-bell', anchor: 'noon', durationMin: 1, consumer: 'BuildingSprite' }),
]);
const NOON_MINUTE = 12 * 60;

/**
 * Whether day-part beat `id` is live at `minuteOfDay` (the atmosphere's
 * clock). `sunriseMinute` is the day's sunrise key (the grade's, with its
 * season shift) for the dawn beat.
 */
export function dayPartBeatLive(id, minuteOfDay, { sunriseMinute = 360 } = {}) {
    const beat = DAY_PART_BEATS.find((row) => row.id === id);
    const minute = Number(minuteOfDay);
    if (!beat || !Number.isFinite(minute)) return false;
    const start = beat.anchor === 'noon' ? NOON_MINUTE : Number(sunriseMinute);
    if (!Number.isFinite(start)) return false;
    const m = ((minute % 1440) + 1440) % 1440;
    return m >= start && m < start + beat.durationMin;
}

/** The day-part beats live at `minuteOfDay`, in table order. */
export function dayPartBeatsAt(minuteOfDay, opts = {}) {
    return DAY_PART_BEATS.filter((beat) => dayPartBeatLive(beat.id, minuteOfDay, opts)).map((beat) => beat.id);
}
