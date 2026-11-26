// W6.3 / W6-C-Wire — Evensong live wiring, the real lunar tide and the sky
// keys (spec 04 §5.5–5.6, master plan W6.3 and D8).
//
//   1. Evensong: the soft 21:00 chime queues the day's score on the Town
//      band's next breath (real Sequencer on a node-less audio graph), the
//      four-minute cap, silence on a day without verified work, lead + bass +
//      comp only at −3 dB with no percussion, and `audio:evensong`.
//   2. The lunar tide: the exact equilibrium formula, a spring and a neap
//      pinned at a fixed site, 0.1 of hysteresis, the −L hull lift, the
//      clamp(1 − L, 0, 3) quay wet course, the h ≤ −0.92 sandbar, and zero
//      cost at L = 0 (no overlay, no artifact field, the same hull list).
//   3. Lantern Night, the solstice alignment and the 2026–2027 eclipse keys,
//      and no change on ordinary or pinned capture dates.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import {
    ECLIPSE_SKY_KEYS,
    LANTERN_NIGHT_WINDOW_DAYS,
    PARTIAL_SOLAR_CAP,
    SYNODIC_MONTH_DAYS,
    eclipseSkyKeyAt,
    eclipseVisibilityCap,
    isLanternNight,
    moonAgeDaysAt,
    solsticeAlignmentAt,
    solsticeAlignmentDay,
} from '../../claudeville/src/config/villageCalendar.js';
import { BgmDirector } from '../../claudeville/src/presentation/shared/audio/BgmDirector.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';
import {
    BandEngine,
    EVENSONG_BREATH_SEC,
    EVENSONG_SEAT_OFFSET_DB,
    EVENSONG_TRIM,
    TOWN_BAND_TRIM,
    compileEvensongEvents,
    holdTownBand,
} from '../../claudeville/src/presentation/shared/audio/bgm/BandEngine.js';
import {
    EVENSONG_GAIN_DB,
    EVENSONG_QUEUE_CAP_MS,
    EVENSONG_VOICES,
    composeEvensong,
    createEvensongDayLedger,
    evensongDayKey,
} from '../../claudeville/src/presentation/shared/audio/bgm/Evensong.js';
import {
    AtmosphereState,
    LUNAR_TIDE_DESCRIPTION,
    LUNAR_TIDE_HYSTERESIS,
    LUNAR_TIDE_SANDBAR_H,
    NEUTRAL_LUNAR_TIDE,
    createAtmosphereSnapshot,
    lunarTideAt,
    lunarTideHeight,
    lunarTideLevel,
    lunarTideOverrideState,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import {
    TIDE_COURSE_STRIDE,
    TIDE_WET_COURSE_ZONES,
    WORLD_ASH_SANDBAR,
    captureCoastArtifact,
    getCoastField,
    quayDryStoneRgb,
    quayWaterlineFeet,
    quayWetCourseTexels,
    sampleTideCourse,
    tideOverlayLayers,
    tideOverlayTexels,
    tideWetCourseRows,
    validCoastArtifact,
    worldAshSandbarTexels,
} from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { hullGeometry, hullRecords, hullWaterlineY, tideOverlayRecord } from '../../claudeville/src/presentation/character-mode/HarborHulls.js';
import { DISTRICT_PROPS, WORLD_TREE } from '../../claudeville/src/config/scenery.js';
import { keyedSkyPalette } from '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js';
import { HARBOR_HULL_SCENE_CATEGORY, HarborTraffic, TIDE_OVERLAY_SORT_Y } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import {
    BLOOD_MOON_HEX,
    UMBRA_STOPS,
    eclipseStrength,
    skyKeyPalette,
    skyKeyToken,
} from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';

const HARNESS_SOURCE = new URL('../audio/evensong-harness.mjs', import.meta.url);

// ─── a node-less audio graph (scripts/audio/lib/music-sim.mjs) ──────────────

class FakeParam {
    constructor(value = 1) { this.value = value; this.target = null; }
    setValueAtTime(value) { this.value = value; return this; }
    setTargetAtTime(value) { this.target = value; return this; }
    linearRampToValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    setValueCurveAtTime() { return this; }
    cancelScheduledValues() { return this; }
    cancelAndHoldAtTime() { return this; }
}

class FakeNode {
    constructor(ctx) {
        this.context = ctx;
        for (const name of ['gain', 'pan', 'frequency', 'detune', 'Q', 'playbackRate', 'offset', 'delayTime']) this[name] = new FakeParam(1);
    }
    connect(node) { return node; }
    disconnect() {}
    setPeriodicWave() {}
    start() {}
    stop() {}
    addEventListener() {}
}

function makeEngine() {
    const ctx = {
        currentTime: 0,
        sampleRate: 48000,
        state: 'running',
        createPeriodicWave: () => ({}),
        createBuffer: (channels, length, sampleRate) => {
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            return { length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: c => data[c] };
        },
    };
    for (const f of ['createGain', 'createStereoPanner', 'createBiquadFilter', 'createOscillator', 'createBufferSource',
        'createDelay', 'createWaveShaper', 'createConstantSource', 'createConvolver', 'createChannelMerger', 'createChannelSplitter']) {
        ctx[f] = () => new FakeNode(ctx);
    }
    const procs = new Map();
    const transport = {
        register(proc) {
            if (!procs.has(proc)) procs.set(proc, { cursor: null });
            proc.rearm?.(ctx.currentTime);
            return proc;
        },
        unregister(proc) { procs.delete(proc); },
        pause() {},
        resume() {},
    };
    const node = () => new FakeNode(ctx);
    const engine = {
        context: ctx,
        started: true,
        musicClock: new MusicClock(),
        transport,
        now: () => ctx.currentTime,
        groupInput: node,
        stopGroup: () => ctx.currentTime,
        airSendFrom: node,
        wave: () => null,
        noiseSource: node,
        bank: null,
        fadeDirector: () => ctx.currentTime,
        setAttention() {},
        setAirPhase() {},
    };
    // The Transport: a tick every 0.25 s hands each process [cursor, now + 1.5 s).
    const runTo = (t) => {
        while (ctx.currentTime < t - 1e-9) {
            ctx.currentTime = Math.round((ctx.currentTime + 0.25) * 1e4) / 1e4;
            for (const [proc, entry] of [...procs]) {
                const from = entry.cursor ?? ctx.currentTime;
                const to = ctx.currentTime + 1.5;
                if (to > from) {
                    proc.schedule(from, to);
                    entry.cursor = to;
                }
            }
        }
    };
    return { engine, ctx, runTo, procs };
}

const DAY = '2026-11-26';
const at = (h, m = 0) => new Date(2026, 10, 26, h, m, 0).getTime();

function nightAtmosphere(hours, minutes = 0) {
    return {
        phase: 'night',
        clock: { hours, minutes, localDate: DAY, minuteOfDay: hours * 60 + minutes },
        weather: { type: 'clear' },
    };
}

// A Town band running on the fake graph with a stubbed wall clock; `wall`
// advances with each `step`.
function bandAt21({ events = null, provider = null } = {}) {
    setRngSeed(24301);
    const sim = makeEngine();
    const emitted = [];
    const offEvensong = eventBus.on('audio:evensong', e => emitted.push({ ...e, at: sim.ctx.currentTime }));
    const realNow = Date.now;
    let wall = at(20, 59);
    Date.now = () => wall;
    const director = new BgmDirector({ engine: sim.engine });
    for (const outcome of events || []) eventBus.emit('outcome:verified', outcome);
    if (provider) director.setDayEventsProvider(provider);
    director._atmosphere = nightAtmosphere(20, 59);
    director._atmosphereAt = wall;
    director.start();
    const marks = [];
    director.player.observe(mark => marks.push({ ...mark }));
    const setClock = (hours, minutes) => {
        director._atmosphere = nightAtmosphere(hours, minutes);
        director._atmosphereAt = wall;
    };
    const step = (seconds = 1) => {
        sim.runTo(sim.ctx.currentTime + seconds);
        wall += seconds * 1000;
        director._atmosphereAt = wall;
        director._tick();
    };
    const close = () => {
        director.destroy();
        offEvensong();
        Date.now = realNow;
    };
    return { sim, director, emitted, marks, setClock, step, close, advanceWall: ms => { wall += ms; } };
}

const WORK_DAY = [
    { kind: 'commit', project: '/work/alpha', agentId: 'agent-1', at: at(9, 10) },
    { kind: 'commit', project: '/work/beta', agentId: 'agent-2', at: at(11, 40) },
    { kind: 'push', project: '/work/alpha', agentId: 'agent-1', at: at(14, 5) },
    { kind: 'commit', project: '/work/gamma', agentId: 'agent-3', at: at(17, 30) },
];

// ─── 1. Evensong ─────────────────────────────────────────────────────────────

test('the day ledger keeps anonymous slots only and reads back in composeEvensong shape', () => {
    const ledger = createEvensongDayLedger();
    assert.equal(ledger.record({ kind: 'commit', repoSlot: 3, agentSlot: 17 }, at(9, 30)), true);
    assert.equal(ledger.record({ kind: 'commit', repoSlot: 3, agentSlot: 17 }, at(9, 30)), false, 'deduplicated');
    assert.equal(ledger.record({ kind: 'waiting', repoSlot: 1 }, at(10)), false, 'not a verified-work kind');
    ledger.record({ kind: 'push', repoSlot: 6 }, at(15, 15));
    ledger.record({ kind: 'commit', repoSlot: 1 }, new Date(2026, 10, 25, 22).getTime());
    const events = ledger.events(DAY);
    assert.deepEqual(events, [
        { kind: 'commit', minuteOfDay: 570, repoSlot: 3, agentSlot: 17 },
        { kind: 'push', minuteOfDay: 915, repoSlot: 6 },
    ]);
    assert.equal(evensongDayKey(new Date(at(21))), DAY);
    assert.ok(composeEvensong(events, { tonic: 'A', mode: 'minor' }));
});

test('the director ledger reduces repos and agents to slots the moment it hears them', () => {
    const director = new BgmDirector({ engine: makeEngine().engine });
    try {
        for (const outcome of WORK_DAY) eventBus.emit('outcome:verified', outcome);
        const events = director._dayLedger.events(DAY);
        assert.equal(events.length, 4);
        const text = JSON.stringify(events);
        for (const secret of ['alpha', 'beta', 'gamma', 'work', 'agent-']) assert.ok(!text.includes(secret), `no "${secret}" kept`);
        for (const event of events) {
            assert.ok(Number.isInteger(event.repoSlot) && event.repoSlot >= 0 && event.repoSlot < 8);
            assert.ok(Number.isInteger(event.agentSlot));
        }
    } finally {
        director.destroy();
    }
});

test('without the Chronicle the ledger numbers repos by first activity, the Chronicle order', () => {
    const director = new BgmDirector({ engine: makeEngine().engine });
    try {
        // Heard out of order: gamma's commit arrives first but happened last.
        const heard = [WORK_DAY[3], WORK_DAY[1], WORK_DAY[0], WORK_DAY[2]];
        for (const outcome of heard) eventBus.emit('outcome:verified', outcome);
        const events = director._dayLedger.events(DAY);
        assert.deepEqual(events.map(e => e.minuteOfDay), [550, 700, 845, 1050], 'time order');
        // alpha (09:10) → 0, beta (11:40) → 1, alpha's push → 0, gamma (17:30) → 2.
        assert.deepEqual(events.map(e => e.repoSlot), [0, 1, 0, 2]);
        // Exactly what composeEvensong would number from the Chronicle's rows.
        const chronicleRows = WORK_DAY.map(o => ({ kind: o.kind, repo: o.project, agentId: o.agentId, ts: o.at }));
        assert.deepEqual(
            composeEvensong(events, { tonic: 'A', mode: 'minor' }).melody,
            composeEvensong(chronicleRows, { tonic: 'A', mode: 'minor' }).melody,
            'the fallback and the Chronicle sing the same day',
        );
        // A repo key never collides with an explicit slot.
        const ledger = createEvensongDayLedger();
        ledger.record({ kind: 'commit', repoSlot: 0 }, at(8));
        ledger.record({ kind: 'commit', repoKey: 912345 }, at(9));
        assert.deepEqual(ledger.events(DAY).map(e => e.repoSlot), [0, 1]);
    } finally {
        director.destroy();
    }
});

test('an agent that leaves closes its open error in the ledger, as in the Chronicle', () => {
    const realNow = Date.now;
    Date.now = () => at(18);
    const director = new BgmDirector({ engine: makeEngine().engine });
    try {
        eventBus.emit('outcome:verified', WORK_DAY[0]);
        eventBus.emit('distress:watchtower', { kind: 'errored', agentId: 'agent-1', at: at(16) });
        let events = director._dayLedger.events(DAY);
        assert.equal(composeEvensong(events, { tonic: 'A', mode: 'minor' }).close.kind, 'suspension');
        eventBus.emit('agent:removed', { id: 'agent-1' });
        events = director._dayLedger.events(DAY);
        assert.equal(events.at(-1).kind, 'departed');
        assert.ok(!JSON.stringify(events).includes('agent-'), 'no agent string kept');
        assert.equal(composeEvensong(events, { tonic: 'A', mode: 'minor' }).close.kind, 'plagal');
        // A session that ended completes.
        eventBus.emit('agent:removed', { id: 'agent-2', sessionEndedAt: at(18, 30) });
        assert.equal(director._dayLedger.events(DAY).at(-1).kind, 'completed');
    } finally {
        director.destroy();
        Date.now = realNow;
    }
});

test('Evensong waits for the soft 21:00 chime, then plays in the breath after the current visit', () => {
    const band = bandAt21({ events: WORK_DAY });
    try {
        const { director, sim, emitted, marks } = band;
        band.step(2);
        assert.equal(director.snapshot().evensong.state, 'idle', '20:59 is not the chime');
        band.setClock(22, 0);
        band.step(1);
        assert.equal(director.snapshot().evensong.state, 'idle', '22:00 is not the soft chime');
        band.setClock(21, 0);
        band.step(1);
        const queued = director.snapshot().evensong;
        assert.equal(queued.state, 'queued');
        assert.equal(queued.day, DAY);
        assert.equal(emitted.length, 0, 'nothing announced while queued');
        for (let s = 0; s < 400 && director.snapshot().evensong.state !== 'done'; s++) band.step(1);
        const done = director.snapshot().evensong;
        assert.equal(done.state, 'done');
        assert.equal(done.reason, 'finished');

        // It started a breath after a visit's written end, and the band's next
        // visit opened a breath after its last bar.
        const visitEnd = marks.find(m => m.kind === 'end' && Math.abs(m.t + EVENSONG_BREATH_SEC - done.startsAt) < 1e-6);
        assert.ok(visitEnd, 'Evensong starts on the breath after a visit');
        const resumed = marks.find(m => m.kind === 'start' && m.t > done.startsAt);
        assert.ok(Math.abs(resumed.t - (done.endsAt + EVENSONG_BREATH_SEC)) < 1e-6, 'the band resumes a breath after Evensong');
        assert.ok(Math.abs(done.durationMs - (done.endsAt - done.startsAt) * 1000) <= 1);

        // The band itself is silent for Evensong's length (no notes, no percussion).
        const during = marks.filter(m => (m.kind === 'note' || m.kind === 'perc') && m.t >= done.startsAt && m.t < done.endsAt);
        assert.equal(during.length, 0);

        assert.deepEqual(emitted.map(e => e.active), [true, false]);
        assert.equal(emitted[0].durationMs, done.durationMs);
        assert.ok(emitted[0].at >= done.startsAt && emitted[0].at < done.startsAt + 1.01, 'announced as it starts');
        assert.ok(emitted[1].at >= done.endsAt, 'closed as it ends');
        assert.equal(emitted[1].reason, 'finished');
        assert.ok(sim.ctx.currentTime > done.endsAt);

        // Once a local day: the rest of the chime minute and a later 21:00 of
        // the same day ring nothing more.
        band.setClock(21, 0);
        band.step(1);
        assert.equal(director.snapshot().evensong.state, 'done');
        assert.equal(emitted.length, 2);
    } finally {
        band.close();
    }
});

test('Evensong sounds lead, bass and comp only, 3 dB under the Town band, with no percussion', () => {
    const band = bandAt21({ events: WORK_DAY });
    try {
        const { director } = band;
        band.setClock(21, 0);
        band.step(1);
        const engine = director._evensongBand;
        assert.ok(engine instanceof BandEngine);
        const played = [];
        const play = engine._play.bind(engine);
        engine._play = (t, ev) => {
            played.push(ev.seat);
            play(t, ev);
        };
        for (let s = 0; s < 400 && director.snapshot().evensong.state !== 'done'; s++) band.step(1);
        assert.ok(played.length > 20, 'the score sounded');
        assert.deepEqual([...new Set(played)].sort(), [...EVENSONG_VOICES].sort());
        assert.deepEqual(Object.keys(engine.snapshot().seats ?? {}).sort(), [...EVENSONG_VOICES].sort());

        // −3 dB: the same director level on a trim 3 dB under the band's.
        assert.equal(director.player.trim, TOWN_BAND_TRIM);
        assert.ok(Math.abs(20 * Math.log10(EVENSONG_TRIM / TOWN_BAND_TRIM) - EVENSONG_GAIN_DB) < 1e-9);
        assert.equal(EVENSONG_GAIN_DB, -3);
        assert.equal(engine.trim, EVENSONG_TRIM);
        assert.equal(engine.level, director.player.level);
    } finally {
        band.close();
    }
});

test('the compiled score holds only the three seats and the harness calibration is the live one', () => {
    const score = composeEvensong([
        { minuteOfDay: 9 * 60, kind: 'commit', repoSlot: 0 },
        { minuteOfDay: 12 * 60, kind: 'push', repoSlot: 2 },
        { minuteOfDay: 16 * 60, kind: 'release', repoSlot: 1 },
        { minuteOfDay: 19 * 60, kind: 'commit', repoSlot: 6 },
    ], { tonic: 'A', mode: 'minor' });
    assert.equal(score.percussion, null);
    const { events, totalSec } = compileEvensongEvents(score);
    assert.ok(events.length > 0);
    assert.ok(events.every(ev => EVENSONG_VOICES.includes(ev.seat)));
    assert.ok(events.every((ev, i) => i === 0 || events[i - 1].t <= ev.t));
    assert.ok(totalSec >= 16 * 4 * 60 / 72 - 1e-9, '16 bars at 72 bpm (plus the close ritard)');
    // The harness renders its pre-gate with these per-seat offsets: one
    // calibration for the listening gate and the village.
    const source = readFileSync(HARNESS_SOURCE, 'utf8');
    const match = /seatOffsetDb = payload\.family === 'night'\s*\?\s*(\{[^}]+\})\s*:\s*(\{[^}]+\})/.exec(source);
    assert.ok(match, 'the harness keeps its seat offsets');
    const parse = text => Object.fromEntries([...text.matchAll(/(\w+):\s*(-?[\d.]+)/g)].map(([, k, v]) => [k, Number(v)]));
    assert.deepEqual(parse(match[1]), { ...EVENSONG_SEAT_OFFSET_DB.night });
    assert.deepEqual(parse(match[2]), { ...EVENSONG_SEAT_OFFSET_DB.day });
    assert.match(source, /0\.536 \* 0\.9 \* dbToGain\(payload\.gainDb\)/, 'the harness trim is the band trim × band level × −3 dB');
});

test('a day without verified work stays completely silent', () => {
    const band = bandAt21({ events: [] });
    try {
        const { director, emitted } = band;
        eventBus.emit('distress:watchtower', { kind: 'errored', agentId: 'agent-9', at: at(13) });
        const ownPlan = Object.prototype.hasOwnProperty.call(director.player, '_planTownBand');
        band.setClock(21, 0);
        band.step(1);
        assert.equal(director.snapshot().evensong.state, 'silent');
        assert.equal(Object.prototype.hasOwnProperty.call(director.player, '_planTownBand'), ownPlan, 'the band is never held');
        assert.equal(director._evensongBand, null, 'no Evensong band is built');
        for (let s = 0; s < 240; s++) band.step(1);
        assert.equal(emitted.length, 0);
        assert.equal(director.snapshot().evensong.state, 'silent');
    } finally {
        band.close();
    }
});

test('a breath later than four minutes after the chime cancels that day', () => {
    const band = bandAt21({ events: WORK_DAY });
    try {
        const { director, emitted } = band;
        band.setClock(21, 0);
        band.step(1);
        assert.equal(director.snapshot().evensong.state, 'queued');
        // The cap in audio time: a hand-over past it is handed back to the band.
        const queuedAt = director._evensong.queuedAtAudio;
        assert.equal(director._onBandBreath(queuedAt + EVENSONG_QUEUE_CAP_MS / 1000 + 1), null);
        assert.equal(director.snapshot().evensong.state, 'cancelled');
        assert.equal(director.snapshot().evensong.reason, 'late');
        assert.deepEqual(emitted.map(e => [e.active, e.reason]), [[false, 'late']]);
        assert.equal(Object.prototype.hasOwnProperty.call(director.player, '_planTownBand'), false, 'the hold is released');
        band.setClock(21, 0);
        band.step(1);
        assert.equal(director.snapshot().evensong.state, 'cancelled', 'no second try that day');
    } finally {
        band.close();
    }

    const stalled = bandAt21({ events: WORK_DAY });
    try {
        stalled.setClock(21, 0);
        stalled.step(1);
        assert.equal(stalled.director.snapshot().evensong.state, 'queued');
        // The wall clock: a page that held the band (paused audio) past the cap.
        stalled.advanceWall(EVENSONG_QUEUE_CAP_MS + 1000);
        stalled.director._tick();
        assert.equal(stalled.director.snapshot().evensong.state, 'cancelled');
        assert.deepEqual(stalled.emitted.map(e => e.active), [false]);
    } finally {
        stalled.close();
    }
});

test('a paused band at 21:00 queues nothing, and the day provider replaces the ledger', async () => {
    const paused = bandAt21({ events: WORK_DAY });
    try {
        paused.director.pause();
        paused.setClock(21, 0);
        paused.director._tick();
        assert.equal(paused.director.snapshot().evensong.state, 'idle');
    } finally {
        paused.close();
    }

    const calls = [];
    const provided = bandAt21({
        events: [],
        provider: ({ day }) => {
            calls.push(day);
            return Promise.resolve([{ minuteOfDay: 600, kind: 'commit', repo: 'secret-repo' }]);
        },
    });
    try {
        provided.setClock(21, 0);
        provided.step(1);
        assert.deepEqual(calls, [DAY]);
        assert.equal(provided.director.snapshot().evensong.state, 'gathering');
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(provided.director.snapshot().evensong.state, 'queued');
        assert.ok(!JSON.stringify(provided.director._evensong.score).includes('secret-repo'));
    } finally {
        provided.close();
    }
});

test('holdTownBand delays the hand-over and restores the sequencer on release', () => {
    const calls = [];
    const sequencer = { _planTownBand(t) { calls.push(t); } };
    const release = holdTownBand(sequencer, t => (t === 10 ? { resumeAt: 70 } : null));
    sequencer._planTownBand(10);
    sequencer._planTownBand(80);
    assert.deepEqual(calls, [70, 80]);
    release();
    sequencer._planTownBand(5);
    assert.deepEqual(calls, [70, 80, 5]);
    assert.equal(holdTownBand({}, () => null), false);
});

// ─── 2. The lunar tide ───────────────────────────────────────────────────────

// A fixed site on the Greenwich meridian, its clock on UTC.
const GREENWICH = Object.freeze({ zone: 'greenwich', lat: 51.48, lon: 0, offsetMinutes: () => 0 });

test('the equilibrium tide is the spec formula', () => {
    // New moon: the bodies agree — high water at solar noon, low at 6 and 18.
    assert.ok(Math.abs(lunarTideHeight(12, 0) - 1) < 1e-12);
    assert.ok(Math.abs(lunarTideHeight(18, 0) + 1) < 1e-12);
    // First quarter: they oppose, |h| = 0.54 / 1.46.
    const quarter = SYNODIC_MONTH_DAYS / 4;
    assert.ok(Math.abs(lunarTideHeight(12, quarter) - (-0.54 / 1.46)) < 1e-12);
    // The general form, at an arbitrary instant.
    const hours = 7.3;
    const age = 11.2;
    const hSun = 2 * Math.PI * (hours - 12) / 24;
    const hMoon = hSun - 2 * Math.PI * age / 29.530588853;
    assert.ok(Math.abs(lunarTideHeight(hours, age) - (Math.cos(2 * hMoon) + 0.46 * Math.cos(2 * hSun)) / 1.46) < 1e-12);
    assert.equal(LUNAR_TIDE_SANDBAR_H, -0.92);
    assert.equal(LUNAR_TIDE_DESCRIPTION, "the lunar tide for the site's longitude, not a prediction for a real harbour");
});

test('a known spring pins L = ±2 and opens the sandbar; a known neap never leaves −1 … +1', () => {
    // 2026-11-09/10: the November 2026 new moon, at Greenwich.
    const low = lunarTideAt(new Date(2026, 10, 9, 17, 40), GREENWICH);
    assert.ok(low.moonAgeDays > 29 || low.moonAgeDays < 1, 'at new moon');
    assert.ok(low.h <= -0.92 && low.h >= -1);
    assert.equal(low.level, -2);
    assert.equal(low.sandbarExposed, true);
    assert.equal(low.longitude, 0);
    assert.equal(low.description, LUNAR_TIDE_DESCRIPTION);
    const high = lunarTideAt(new Date(2026, 10, 9, 11, 40), GREENWICH);
    assert.ok(high.h >= 0.92);
    assert.equal(high.level, 2);
    assert.equal(high.sandbarExposed, false);

    // 2026-11-02: last quarter (age 22.15) — a whole neap day.
    let maxAbs = 0;
    for (let minute = 0; minute < 24 * 60; minute += 5) {
        const tide = lunarTideAt(new Date(2026, 10, 2, 0, minute), GREENWICH);
        maxAbs = Math.max(maxAbs, Math.abs(tide.h));
        assert.ok(tide.level >= -1 && tide.level <= 1, `neap level ${tide.level}`);
        assert.equal(tide.sandbarExposed, false);
    }
    assert.ok(maxAbs < 0.38, `neap amplitude ${maxAbs}`);
    // At the quarter itself the amplitude is the spec's 0.37.
    const quarterNoon = lunarTideAt(new Date(2026, 10, 2, 12, 0), GREENWICH);
    assert.ok(Math.abs(quarterNoon.moonAgeDays - 3 * SYNODIC_MONTH_DAYS / 4) < 0.05);
    for (let minute = -180; minute <= 180; minute += 5) {
        assert.ok(Math.abs(lunarTideAt(new Date(2026, 10, 2, 12, minute), GREENWICH).h) <= 0.3723);
    }
});

test('two highs and two lows run every 24 h 50 min', () => {
    const levels = [];
    for (let minute = 0; minute <= 1490; minute += 10) levels.push(lunarTideAt(new Date(2026, 10, 9, 0, minute), GREENWICH).h);
    let peaks = 0;
    let troughs = 0;
    for (let i = 1; i < levels.length - 1; i++) {
        if (levels[i] > levels[i - 1] && levels[i] >= levels[i + 1]) peaks++;
        if (levels[i] < levels[i - 1] && levels[i] <= levels[i + 1]) troughs++;
    }
    assert.equal(peaks, 2);
    assert.equal(troughs, 2);
});

test('the level holds 0.1 of hysteresis on h', () => {
    assert.equal(LUNAR_TIDE_HYSTERESIS, 0.1);
    // No previous level: the plain rounding.
    assert.equal(lunarTideLevel(0.26), 1);
    assert.equal(lunarTideLevel(-0.8), -2);
    assert.equal(lunarTideLevel(1), 2);
    // Rising out of 0 needs h past 0.25 + 0.05; falling back needs 0.25 − 0.05.
    assert.equal(lunarTideLevel(0.29, 0), 0);
    assert.equal(lunarTideLevel(0.31, 0), 1);
    assert.equal(lunarTideLevel(0.21, 1), 1);
    assert.equal(lunarTideLevel(0.19, 1), 0);
    assert.equal(lunarTideLevel(0.79, 1), 1);
    assert.equal(lunarTideLevel(0.81, 1), 2);
    assert.equal(lunarTideLevel(-0.79, -1), -1);
    assert.equal(lunarTideLevel(-0.81, -1), -2);
    // A jump far past the band takes the raw level at once.
    assert.equal(lunarTideLevel(-0.9, 1), -2);

    // The class carries the level from one snapshot to the next.
    let now = new Date(2026, 10, 9, 0, 0);
    const state = new AtmosphereState({ nowProvider: () => now });
    let last = state.snapshot().lunarTide;
    let steps = 0;
    for (let minute = 1; minute < 24 * 60; minute++) {
        now = new Date(2026, 10, 9, 0, minute);
        const tide = state.snapshot().lunarTide;
        if (tide.level !== last.level) {
            steps++;
            assert.equal(Math.abs(tide.level - last.level), 1, 'one level at a time');
            const edge = (Math.min(tide.level, last.level) + 0.5) / 2;
            assert.ok(Math.abs(tide.h - edge) >= 0.05 - 0.002, 'a step lands only past the hysteresis band');
        }
        last = tide;
    }
    assert.ok(steps >= 12 && steps <= 20, `${steps} level steps on a spring day`);
    state.dispose();
});

test('the tide is level on every pinned clock and a QA override forces any state', () => {
    const live = createAtmosphereSnapshot({ now: new Date(2026, 10, 9, 17, 40), solarSite: GREENWICH });
    assert.equal(live.lunarTide.source, 'lunar');
    assert.equal(live.lunarTide.level, -2);
    for (const pinned of [
        createAtmosphereSnapshot({ now: new Date(2026, 10, 9, 17, 40), solarSite: GREENWICH, timelineMode: 'fixed' }),
        createAtmosphereSnapshot({ now: new Date(2026, 10, 9, 17, 40), solarSite: GREENWICH, hourOverride: 17.66 }),
        createAtmosphereSnapshot({ now: new Date(2026, 10, 9, 17, 40), solarSite: GREENWICH, lunarTide: { pinned: true } }),
    ]) {
        assert.equal(pinned.lunarTide, NEUTRAL_LUNAR_TIDE);
        assert.equal(pinned.lunarTide.level, 0);
        assert.equal(pinned.lunarTide.sandbarExposed, false);
    }

    const state = new AtmosphereState({ nowProvider: () => new Date(2026, 10, 2, 12, 0) });
    state.setTimelineMode('fixed');
    assert.equal(state.snapshot().lunarTide.level, 0);
    for (const level of [-2, -1, 0, 1, 2]) {
        const tide = state.setLunarTideOverride(level).lunarTide;
        assert.equal(tide.source, 'override');
        assert.equal(tide.level, level);
        assert.equal(tide.sandbarExposed, false);
    }
    const sandbar = state.setLunarTideOverride('sandbar').lunarTide;
    assert.deepEqual([sandbar.level, sandbar.sandbarExposed, sandbar.h], [-2, true, -1]);
    assert.equal(state.setLunarTideOverride({ h: -0.95 }).lunarTide.sandbarExposed, true);
    assert.equal(state.setLunarTideOverride({ h: -0.9 }).lunarTide.sandbarExposed, false);
    assert.equal(state.setLunarTideOverride(7).lunarTide.level, 0, 'an unknown override is ignored');
    assert.equal(state.setLunarTideOverride(null).lunarTide, NEUTRAL_LUNAR_TIDE);
    state.setLunarTideOverride(2);
    assert.equal(state.clear().lunarTide.source, 'lunar', 'clear() drops the override');
    assert.equal(lunarTideOverrideState('high'), null);
    state.dispose();
});

function fakeStrip() {
    return { image: { width: 200, height: 40 }, frameWidth: 40, frameHeight: 40, frameOffset: 0, anchorX: 20, anchorY: 30, key: 'hull.test', spriteId: 'hull.test' };
}

test('a moored hull rides −L texels in screen y, its reflection and collar with it', () => {
    const base = { id: 'ship-1', strip: fakeStrip(), frame: 2, x: 500, y: 300, bob: 1, sink: 0, alpha: 1, wake: null };
    const level = hullGeometry(base);
    assert.deepEqual(hullGeometry({ ...base, tide: 0 }), level, 'L = 0 moves nothing');
    for (const L of [-2, -1, 1, 2]) {
        const g = hullGeometry({ ...base, tide: L });
        assert.equal(g.y, level.y - L, `hull at L = ${L}`);
        assert.equal(g.reflectY, level.reflectY - L, `reflection at L = ${L}`);
        assert.equal(g.height, level.height);
        assert.equal(g.x, level.x);
    }
    const records = hullRecords({ ...base, tide: 2 });
    const reflection = records.find(r => r.reflect === true);
    const hull = records.find(r => r.id === 'harbor:hull:ship-1');
    assert.equal(hull.y, level.y - 2);
    assert.equal(reflection.y, level.reflectY - 2);
    assert.deepEqual(hullRecords({ ...base, tide: 0 }), hullRecords(base));
});

test('a moored hull and its mirror contact foot ride the same −L: zero separation at L = −2, 0, +2', () => {
    const base = { id: 'ship-2', strip: fakeStrip(), frame: 1, x: 640, y: 412, bob: 0, sink: 0, alpha: 1, wake: null };
    // The planar mirror reflects a record about its foot (mirrorFootY before
    // footY; GpuWorldRendererWebGPU): a hull row at screen y lands at 2·foot − y.
    const mirrorFoot = record => record.mirrorFootY ?? record.footY;
    const hullOf = records => records.find(r => r.id === 'harbor:hull:ship-2');
    const level = hullOf(hullRecords({ ...base, tide: 0 }));
    assert.equal('mirrorFootY' in level, false, 'L = 0: the record is the baseline record');
    assert.deepEqual(hullRecords({ ...base, tide: 0 }), hullRecords(base));
    const levelGap = level.y + level.height - mirrorFoot(level);
    for (const L of [-2, 0, 2]) {
        const records = hullRecords({ ...base, tide: L });
        const hull = hullOf(records);
        const reflection = records.find(r => r.reflect === true);
        assert.equal(hull.y, level.y - L, `hull y at L = ${L}`);
        assert.equal(mirrorFoot(hull), Math.round(base.y) - L, `mirror contact foot at L = ${L}`);
        assert.equal(mirrorFoot(hull), hullWaterlineY({ ...base, tide: L }));
        // The waterline row and the mirror foot keep their L = 0 offset: the
        // reflection never parts from (or overlaps) the hull.
        assert.equal(hull.y + hull.height - mirrorFoot(hull), levelGap, `zero separation at L = ${L}`);
        for (const row of [hull.y, hull.y + hull.height - 1]) {
            assert.equal(2 * mirrorFoot(hull) - row, (2 * mirrorFoot(level) - (row + L)) - L, `mirrored row at L = ${L}`);
        }
        // The Canvas/WebGL2 reflection twin rides the same lift.
        assert.equal(reflection.y, hullGeometry({ ...base, tide: 0 }).reflectY - L);
        // Painter order is untouched: footY stays the waterline anchor.
        assert.equal(hull.footY, Math.round(base.y));
    }
});

test('only moored ships take the tide lift, and it holds under reduced motion', () => {
    const harbor = new HarborTraffic({});
    try {
        harbor.setMotionScale?.(0);
        const docked = { id: 'a', status: 'docked', x: 10, y: 10 };
        const anchored = { id: 'b', status: 'anchored', x: 10, y: 10 };
        const departing = { id: 'c', status: 'departing', x: 10, y: 10, tailX: 0, tailY: 0, progress: 0.5 };
        harbor.setLunarTide({ level: 0 });
        assert.equal(harbor._shipBob(docked), 0);
        harbor.setLunarTide({ level: 2 });
        assert.equal(harbor._shipTideLift(docked), 2);
        assert.equal(harbor._shipTideLift(anchored), 2);
        assert.equal(harbor._shipTideLift(departing), 0);
        assert.equal(harbor._shipTideLift({ ...docked, storageTransfer: true }), 0);
        assert.equal(harbor._shipBob(docked), 2, 'marks ride the lift too');
        harbor.setLunarTide({ level: -2 });
        assert.equal(harbor._shipBob(anchored), -2);
        harbor.setLunarTide({ level: 9 });
        assert.equal(harbor._shipTideLift(docked), 2, 'clamped to ±2');
        harbor.setLunarTide(null);
        assert.equal(harbor._shipTideLift(docked), 0);
    } finally {
        harbor.dispose();
    }
});

test('the quay wet course is clamp(1 − L, 0, 3), drawn only above the baked course', () => {
    assert.deepEqual([2, 1, 0, -1, -2].map(tideWetCourseRows), [0, 0, 1, 2, 3]);
    // A 4×4-cell water field at (100, 200): one cell carries a foot code.
    const cycleOffset = new Uint8Array(16).fill(255);
    // texel 0 a foot (digit 1), texel 1 a second row (2), texel 2 a foot (1).
    cycleOffset[2 * 4 + 1] = 32 + 1 + 2 * 3 + 1 * 9;
    cycleOffset[0] = 7; // a swell band, not a foot
    cycleOffset[3] = 113; // an eddy, not a foot
    const waterFields = { cols: 4, rows: 4, x: 100, y: 200, cycleOffset };
    const quay = new Uint8Array(MAP_SIZE * MAP_SIZE).fill(2);
    const feet = quayWaterlineFeet(waterFields, quay);
    assert.deepEqual(feet, [{ x: 102, y: 204, zone: 2 }, { x: 102, y: 205, zone: 2 }]);
    for (const zone of [1, 5, 6]) {
        assert.deepEqual(quayWaterlineFeet(waterFields, new Uint8Array(MAP_SIZE * MAP_SIZE).fill(zone)), [], `zone ${zone} is not a quay`);
    }
    // Only tidal water: a river (cap 2) or a lagoon (cap 3) keeps no wet course.
    for (const cap of [2, 3]) {
        assert.deepEqual(quayWaterlineFeet(waterFields, quay, { caps: new Uint8Array(MAP_SIZE * MAP_SIZE).fill(cap) }), [], `cap ${cap}`);
    }
    assert.equal(quayWaterlineFeet(waterFields, quay, { caps: new Uint8Array(MAP_SIZE * MAP_SIZE).fill(5) }).length, 2, 'the sea and the Harbor');
    assert.deepEqual(TIDE_WET_COURSE_ZONES, [2, 3, 4]);

    const wetStone = new Set(ART_RAMPS.tideline.slice(0, 2));
    const hex = rgb => `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;
    assert.deepEqual(quayWetCourseTexels(feet, 0), [], 'nothing at L = 0');
    // High water: the baked course (foot.y − 1) alone, repainted dry.
    for (const L of [1, 2]) {
        const dry = quayWetCourseTexels(feet, L);
        assert.deepEqual(dry.map(t => [t.x, t.y]), feet.map(f => [f.x, f.y - 1]), `L = ${L}`);
        assert.ok(dry.every(t => t.dry === true && !wetStone.has(hex(t.rgb))), `no wet stone at L = ${L}`);
        assert.deepEqual(dry.map(t => t.rgb), feet.map(f => quayDryStoneRgb(f)), 'the face texel above the course');
    }
    const low = quayWetCourseTexels([{ x: 102, y: 204 }], -1);
    assert.deepEqual(low.map(t => [t.x, t.y]), [[102, 202]]);
    const lowest = quayWetCourseTexels([{ x: 102, y: 204 }], -2);
    assert.deepEqual(lowest.map(t => [t.x, t.y]), [[102, 202], [102, 201]]);
    assert.ok(lowest.every(t => wetStone.has(hex(t.rgb))));
});

// A coast-bake stand-in: the resident water field and the field the
// artifact carries, a quay foot every texel along a run of cells.
function fakeCoastRenderer() {
    const cols = 40;
    const rows = 8;
    const cycleOffset = new Uint8Array(cols * rows).fill(255);
    for (let c = 4; c < 36; c++) cycleOffset[4 * cols + c] = 32 + 1 + 1 * 3;
    const bankZone = new Uint8Array(MAP_SIZE * MAP_SIZE).fill(3);
    const waterFields = { cols, rows, x: 600, y: 320, cycleOffset, coastField: new Uint8Array(cols * rows * 2), mirrorStops: new Uint8Array(cols * rows * 2), key: 'k', revision: 'rev-1', bakeMs: 1 };
    const coast = { x: 600, y: 320, cols, rows, classes: new Uint8Array(cols * rows), depth: new Float32Array(cols * rows), caps: new Uint8Array(cols * rows), outer: new Uint8Array(cols * rows), bankZone, contactFoot: new Map(), mirrorAccents: [], baked: null };
    return {
        _coastBake: { coast, waterFields, key: 'k', fieldMs: 1, bakeMs: 1 },
        _coastField: { key: 'k', buildMs: 1, bankZone, caps: new Uint8Array(MAP_SIZE * MAP_SIZE).fill(5), signed: new Float32Array(4), signedDistance: () => 1, isWater: () => true, signedDistanceAtWorld: () => 1, depthCapAt: () => 4 },
        world: { buildings: new Map() },
    };
}

function withFakeDocument(fn) {
    const previous = globalThis.document;
    globalThis.document = {
        createElement() {
            return {
                width: 0,
                height: 0,
                getContext() {
                    return {
                        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                        putImageData() {},
                    };
                },
            };
        },
    };
    try {
        return fn();
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
}

test('a level tide costs nothing: no read, no overlay, no artifact byte, the same hull list', () => {
    // Nothing on the renderer is even read at L = 0 with the sandbar shut.
    const untouchable = new Proxy({}, { get(_target, key) { throw new Error(`read renderer.${String(key)} at L = 0`); } });
    assert.deepEqual(tideOverlayTexels(untouchable, { level: 0, sandbarExposed: false }), { wet: [], sandbar: [] });
    assert.deepEqual(tideOverlayLayers(untouchable, NEUTRAL_LUNAR_TIDE), []);
    assert.deepEqual(tideOverlayLayers(untouchable, null), []);

    // The coast artifact carries exactly the same fields and bytes whatever
    // the tide drew: the overlays live outside `_coastBake`.
    const renderer = fakeCoastRenderer();
    const before = captureCoastArtifact(renderer);
    const bytes = value => JSON.stringify(value, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v instanceof Map ? [...v] : v));
    withFakeDocument(() => {
        assert.ok(tideOverlayLayers(renderer, { level: -2, sandbarExposed: true }).length > 0);
    });
    const after = captureCoastArtifact(renderer);
    assert.equal(bytes(after), bytes(before));
    assert.deepEqual(Object.keys(after.bake).sort(), Object.keys(before.bake).sort());
    assert.ok(!('_tideOverlay' in renderer._coastBake));

    // The harbor-hulls category hands out its very own hull list at L = 0.
    const harbor = new HarborTraffic({});
    try {
        const scene = { ...fakeCoastRenderer(), harborTraffic: harbor, _lastAtmosphere: { lunarTide: NEUTRAL_LUNAR_TIDE } };
        const items = HARBOR_HULL_SCENE_CATEGORY.enumerate({ renderer: scene });
        assert.equal(items, harbor._hullItems);
        assert.equal(harbor._tideLift, 0);
    } finally {
        harbor.dispose();
    }
});

test('a low tide adds ground-band wet-course items under every hull', () => {
    withFakeDocument(() => {
        const harbor = new HarborTraffic({});
        try {
            const scene = { ...fakeCoastRenderer(), harborTraffic: harbor, _lastAtmosphere: { lunarTide: { level: -2, sandbarExposed: false } } };
            const items = HARBOR_HULL_SCENE_CATEGORY.enumerate({ renderer: scene });
            assert.ok(items.length > 0);
            assert.equal(harbor._tideLift, -2);
            for (const item of items) {
                assert.equal(item.sortY, TIDE_OVERLAY_SORT_Y);
                assert.ok(Number.isNaN(item.x), 'never re-sorted behind a split building');
                assert.ok(Number.isFinite(item.wx) && Number.isFinite(item.wy));
                assert.equal(item.records.length, 1);
                assert.ok(item.records[0].id.startsWith('ground:tide-wet:'), 'a ground-band record');
                assert.equal(item.records[0].alpha, 1);
            }
            // Pooled: the same items while the layers hold.
            assert.equal(HARBOR_HULL_SCENE_CATEGORY.enumerate({ renderer: scene })[0], items[0]);
            const texels = tideOverlayTexels(scene, { level: -2 });
            assert.equal(texels.wet.length, 32 * 2 * 2, 'two added rows over every foot texel');
            assert.deepEqual(texels.sandbar, [], 'the sandbar stays shut at h > −0.92');
        } finally {
            harbor.dispose();
        }
    });
    const record = tideOverlayRecord({ id: 'tide-sandbar', textureKey: 'k', canvas: {}, x: 1, y: 2, width: 3, height: 4, material: 'earth' });
    assert.deepEqual([record.id, record.x, record.y, record.width, record.height, record.alpha, record.occluder], ['ground:tide-sandbar', 1, 2, 3, 4, 1, 0]);
});

test('the World Ash sandbar opens only at h ≤ −0.92, opaque, on the sand and tideline ramps', () => {
    const renderer = fakeCoastRenderer();
    assert.deepEqual(tideOverlayTexels(renderer, { level: -2, sandbarExposed: false }).sandbar, []);
    const open = tideOverlayTexels(renderer, { level: -2, sandbarExposed: true }).sandbar;
    assert.ok(open.length > 150);
    const ramps = new Set([...ART_RAMPS.sand, ...ART_RAMPS.tideline]);
    const hex = rgb => `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;
    assert.ok(open.every(t => ramps.has(hex(t.rgb))), 'every texel on the sand or tideline ramp');
    assert.ok(open.every(t => Number.isInteger(t.x) && Number.isInteger(t.y)));
    assert.equal(new Set(open.map(t => `${t.x},${t.y}`)).size, open.length, 'one texel each, no blending');
    // The spit spans the channel between the mainland tongue and the islet.
    const ys = open.map(t => t.y);
    const [first, last] = [WORLD_ASH_SANDBAR.points[0], WORLD_ASH_SANDBAR.points.at(-1)];
    assert.ok(Math.max(...ys) >= first[1] - 2 && Math.min(...ys) <= last[1] + 2);
    // Only over water: a field of land paints nothing.
    assert.deepEqual(worldAshSandbarTexels(() => false), []);
    // At the sandbar's gate even a level-0 override draws the bar alone.
    withFakeDocument(() => {
        const layers = tideOverlayLayers(fakeCoastRenderer(), { level: 0, sandbarExposed: true });
        assert.deepEqual(layers.map(l => l.kind), ['sandbar']);
    });
});

test('high water repaints the baked wet course with the baked dry stone above it, and spares a covered course', () => {
    // Two feet; the bake sampled each one's foot.y − 2 (dry) and foot.y − 1
    // (wet) colours. The second foot's course is covered by a structure
    // (its "wet" sample is timber, off the tideline ramp).
    const feet = [{ x: 610, y: 330, zone: 2 }, { x: 611, y: 330, zone: 2 }];
    const tide = ART_RAMPS.tideline.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
    const ashlarDry = [118, 104, 112];
    const timber = [64, 42, 47];
    const pixels = new Map([
        ['610,328', ashlarDry], ['610,329', tide[1]],
        ['611,328', timber], ['611,329', timber],
    ]);
    const course = sampleTideCourse(feet, (x, y) => pixels.get(`${x},${y}`));
    assert.equal(course.length, feet.length * TIDE_COURSE_STRIDE);
    assert.deepEqual([...course.slice(0, 6)], [...ashlarDry, ...tide[1]]);

    // L = 0: nothing at all, not even a read.
    assert.deepEqual(quayWetCourseTexels(feet, 0, { course }), []);
    // L = +1, +2: zero wet rows. The intact course takes the dry stone baked
    // directly above it; the covered one is left as the bake drew it.
    for (const L of [1, 2]) {
        assert.equal(tideWetCourseRows(L), 0);
        const texels = quayWetCourseTexels(feet, L, { course });
        assert.deepEqual(texels, [{ x: 610, y: 329, rgb: ashlarDry, dry: true }], `L = ${L}`);
    }
    // L = −1, −2: one and two wet rows added above the intact course only.
    assert.deepEqual(quayWetCourseTexels(feet, -1, { course }).map(t => [t.x, t.y]), [[610, 328]]);
    assert.deepEqual(quayWetCourseTexels(feet, -2, { course }).map(t => [t.x, t.y]), [[610, 328], [610, 327]]);
    // A sample that does not match the feet is ignored (recomputed course).
    assert.equal(quayWetCourseTexels(feet, 2, { course: new Uint8Array(6) }).length, 2);

    // Through the renderer: the bake's own sample drives the overlay.
    const renderer = fakeCoastRenderer();
    const allFeet = quayWaterlineFeet(renderer._coastBake.waterFields, renderer._coastField.bankZone, { caps: renderer._coastField.caps });
    renderer._coastBake.tideCourse = sampleTideCourse(allFeet, (x, y) => (y === allFeet[0].y - 1 ? tide[0] : ashlarDry));
    const high = tideOverlayTexels(renderer, { level: 2 });
    assert.equal(high.wet.length, allFeet.length, 'one dry texel per foot');
    assert.ok(high.wet.every((t, i) => t.y === allFeet[i].y - 1 && t.rgb.join() === ashlarDry.join()));
    assert.deepEqual(high.sandbar, []);

    // The sample persists with the coast artifact: optional, whole records.
    const source = { world: { buildings: new Map() }, waterTiles: new Set(['0,0']), waterMeta: new Map([['0,0', { region: 'sea' }]]) };
    const field = getCoastField(source);
    source._coastBake = { key: field.key, fieldMs: field.buildMs, bakeMs: 1, coast: null, waterFields: null };
    const snapshot = captureCoastArtifact(source);
    assert.equal(validCoastArtifact(snapshot), true, 'an older bake without a sample');
    assert.equal(validCoastArtifact({ ...snapshot, bake: { ...snapshot.bake, tideCourse: new Uint8Array(12) } }), true);
    assert.equal(validCoastArtifact({ ...snapshot, bake: { ...snapshot.bake, tideCourse: new Uint8Array(5) } }), false, 'a torn record');
    assert.equal(validCoastArtifact({ ...snapshot, bake: { ...snapshot.bake, tideCourse: [1, 2, 3, 4, 5, 6] } }), false, 'not bytes');
});

test('the World Ash sandbar is a legible spit in open water, clear of the mossy shore boulder', () => {
    // The gate: only h ≤ −0.92 exposes it.
    assert.equal(LUNAR_TIDE_SANDBAR_H, -0.92);
    assert.equal(lunarTideOverrideState({ h: -0.91 }).sandbarExposed, false);
    assert.equal(lunarTideOverrideState({ h: -0.92 }).sandbarExposed, true);
    for (const L of [-2, -1, 1, 2]) assert.equal(lunarTideOverrideState(L).sandbarExposed, false, `a forced L = ${L} keeps it shut`);
    const renderer = fakeCoastRenderer();
    assert.deepEqual(tideOverlayTexels(renderer, lunarTideOverrideState({ h: -0.91 })).sandbar, []);
    const open = tideOverlayTexels(renderer, lunarTideOverrideState({ h: -0.92 })).sandbar;

    // The mossy boulder's footprint: its DISTRICT_PROPS tile and its 64 px
    // manifest sprite anchored at [32, 40] (claudeville/assets/sprites/manifest.yaml).
    const manifest = readFileSync(new URL('../../claudeville/assets/sprites/manifest.yaml', import.meta.url), 'utf8');
    const entry = /- id: veg\.boulder\.mossy\.large\n(?:\s{4}.*\n)*?\s{4}size: (\d+)\n\s{4}anchor: \[(\d+), (\d+)\]/.exec(manifest);
    assert.ok(entry, 'the boulder sprite has a size and an anchor');
    const [size, ax, ay] = entry.slice(1).map(Number);
    const boulders = DISTRICT_PROPS.filter(p => p.id === 'veg.boulder.mossy.large' && Math.hypot(p.tileX - WORLD_TREE.tileX, p.tileY - WORLD_TREE.tileY) < 4);
    assert.equal(boulders.length, 1, 'one mossy boulder on the World Ash shore');
    const [boulder] = boulders;
    const bx = (boulder.tileX - boulder.tileY) * TILE_WIDTH / 2 - ax;
    const by = (boulder.tileX + boulder.tileY) * TILE_HEIGHT / 2 - ay;
    const onBoulder = t => t.x >= bx && t.x < bx + size && t.y >= by && t.y < by + size;
    assert.equal(open.filter(onBoulder).length, 0, 'no sandbar texel inside the boulder sprite');
    assert.ok(WORLD_ASH_SANDBAR.keepClear.some(box => box.x0 <= bx && box.y0 <= by && box.x1 >= bx + size && box.y1 >= by + size),
        'the spit keeps the whole sprite box clear');
    // Even an all-water coast field never puts a texel on the rock.
    assert.equal(worldAshSandbarTexels(() => true).filter(onBoulder).length, 0);

    // Substantial and legible: well over a hundred texels in the open channel
    // between the islet's south sand (y ≈ 476 at x 420–445 on the live coast
    // field) and the mainland beach (y ≈ 510–520 there), on the sand and
    // tideline ramps, with a wet tideline lip and a sand crest.
    const visible = open.filter(t => t.y > 477 && t.y < 509 && t.x > 416);
    assert.ok(visible.length >= 100, `${visible.length} sandbar texels in the channel`);
    const hex = rgb => `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;
    const colours = new Set(open.map(t => hex(t.rgb)));
    assert.ok(colours.has(ART_RAMPS.tideline[2]), 'a wet edge');
    assert.ok(colours.has(ART_RAMPS.sand[2]) && colours.has(ART_RAMPS.sand[0]), 'a crest and a rim');
    // An organic contour: the spit's width changes along its length.
    const widths = new Map();
    for (const t of open) widths.set(t.y, (widths.get(t.y) || 0) + 1);
    assert.ok(new Set(widths.values()).size >= 4, 'the flanks bulge and pinch');

    // Never over what the terrain bake covered (a baked boulder or dock
    // over the water): a covered cell under the spit paints nothing.
    const covered = fakeCoastRenderer();
    const coast = covered._coastBake.coast;
    Object.assign(coast, { x: 400, y: 460, cols: 40, rows: 40 });
    coast.covered = new Uint8Array(coast.cols * coast.rows);
    const [cx, cy] = WORLD_ASH_SANDBAR.points[2];
    const cell = ((cy - coast.y) >> 1) * coast.cols + ((cx - coast.x) >> 1);
    coast.covered[cell] = 1;
    const spared = tideOverlayTexels(covered, { level: -2, sandbarExposed: true }).sandbar;
    assert.ok(spared.length > 0);
    assert.ok(!spared.some(t => ((t.x - coast.x) >> 1) === ((cx - coast.x) >> 1) && ((t.y - coast.y) >> 1) === ((cy - coast.y) >> 1)));
});

test('the tide overlay is a ground band under every scenery record on both backends', () => {
    withFakeDocument(() => {
        const layers = tideOverlayLayers(fakeCoastRenderer(), { level: -2, sandbarExposed: true });
        assert.ok(layers.length > 0);
        for (const layer of layers) {
            const record = tideOverlayRecord(layer);
            // GpuSceneBuilder orders every `ground:` record right after the
            // terrain and before every sprite; the Canvas category draws it
            // at TIDE_OVERLAY_SORT_Y, before every sorted sprite.
            assert.ok(record.id.startsWith('ground:'));
            assert.equal(record.occluder, 0);
            assert.equal(record.elevation, 0);
            assert.ok(TIDE_OVERLAY_SORT_Y < -1e5);
        }
    });
});

// ─── 3. Lantern Night, the solstice alignment and the eclipse keys ───────────

test('Lantern Night is a clear evening within a day of the full moon', () => {
    const full = SYNODIC_MONTH_DAYS / 2;
    const evening = { moonAgeDays: full, phase: 'night', minuteOfDay: 20 * 60, weatherType: 'clear', cloudCover: 0.1, precipitation: 0 };
    assert.equal(isLanternNight(evening), true);
    assert.equal(isLanternNight({ ...evening, moonAgeDays: full + LANTERN_NIGHT_WINDOW_DAYS + 0.01 }), false);
    assert.equal(isLanternNight({ ...evening, moonAgeDays: full - LANTERN_NIGHT_WINDOW_DAYS + 0.01 }), true);
    assert.equal(isLanternNight({ ...evening, weatherType: 'overcast' }), false);
    assert.equal(isLanternNight({ ...evening, cloudCover: 0.5 }), false);
    assert.equal(isLanternNight({ ...evening, precipitation: 0.2 }), false);
    assert.equal(isLanternNight({ ...evening, phase: 'day' }), false);
    assert.equal(isLanternNight({ ...evening, minuteOfDay: 2 * 60 }), false, 'after midnight is not the evening');

    const snapshot = createAtmosphereSnapshot({ now: new Date(2026, 10, 24, 20, 0), solarSite: GREENWICH, weatherOverride: { type: 'clear' } });
    assert.equal(snapshot.skyKeys.lanternNight, true);
    const keyed = skyKeyPalette(snapshot.sky.palette, snapshot.skyKeys);
    assert.notEqual(keyed.horizon, snapshot.sky.palette.horizon);
    assert.equal(keyed.zenith, snapshot.sky.palette.zenith, 'only the horizon courses warm');
});

test('the Solstice Belfry Alignment keys June 20–21 and December 21–22 at the real noon', () => {
    for (const [month, day, kind] of [[6, 20, 'june'], [6, 21, 'june'], [12, 21, 'december'], [12, 22, 'december']]) {
        assert.deepEqual(solsticeAlignmentDay({ month, day }), { kind, month, day });
    }
    for (const [month, day] of [[6, 19], [6, 22], [12, 20], [12, 23], [3, 20], [7, 15]]) {
        assert.equal(solsticeAlignmentDay({ month, day }), null);
    }
    assert.deepEqual(solsticeAlignmentAt({ month: 6, day: 21, minuteOfDay: 725, solarNoonMinute: 722 }), { kind: 'june', aligned: true });
    assert.deepEqual(solsticeAlignmentAt({ month: 6, day: 21, minuteOfDay: 800, solarNoonMinute: 722 }), { kind: 'june', aligned: false });
    assert.deepEqual(solsticeAlignmentAt({ month: 12, day: 22, minuteOfDay: 722, solarNoonMinute: 722, sunUp: false }), { kind: 'december', aligned: false });

    const noon = createAtmosphereSnapshot({ now: new Date(2026, 5, 21, 12, 0), solarSite: GREENWICH, weatherOverride: { type: 'clear' } });
    assert.deepEqual(noon.skyKeys.solstice, { kind: 'june', aligned: true });
    assert.notEqual(skyKeyPalette(noon.sky.palette, noon.skyKeys).midBand, noon.sky.palette.midBand);
    const evening = createAtmosphereSnapshot({ now: new Date(2026, 5, 21, 17, 0), solarSite: GREENWICH, weatherOverride: { type: 'clear' } });
    assert.deepEqual(evening.skyKeys.solstice, { kind: 'june', aligned: false });
    assert.equal(skyKeyPalette(evening.sky.palette, evening.skyKeys), evening.sky.palette, 'the flag alone changes nothing');
});

test('the 2026–2027 eclipse keys hold exactly their UTC windows', () => {
    const ids = ECLIPSE_SKY_KEYS.map(row => row.id);
    assert.deepEqual(ids, ['lunar-2026-03-03', 'solar-2026-08-12', 'lunar-2026-08-28', 'solar-2027-02-06', 'solar-2027-08-02']);
    const utc = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s);
    // 2027-02-06 annular (magnitude 0.928): antumbral U1 14:03:53 → greatest
    // 15:59:35 → U4 17:55:24 UT; never full, so it peaks at 0.75.
    assert.equal(eclipseSkyKeyAt(utc(2027, 2, 6, 14, 3, 52)), null);
    assert.deepEqual(eclipseSkyKeyAt(utc(2027, 2, 6, 14, 3, 53)), { id: 'solar-2027-02-06', body: 'sun', type: 'annular', strength: 0.25 });
    assert.equal(eclipseSkyKeyAt(utc(2027, 2, 6, 15, 59, 35)).strength, 0.75);
    assert.equal(eclipseSkyKeyAt(utc(2027, 2, 6, 17, 55, 23)).strength, 0.25);
    assert.equal(eclipseSkyKeyAt(utc(2027, 2, 6, 17, 55, 24)), null);
    // 2026-08-12 total solar: U1 16:58:06 → greatest 17:45:53 → U4 18:34:05 UTC.
    assert.equal(eclipseSkyKeyAt(utc(2026, 8, 12, 16, 58, 5)), null);
    assert.deepEqual(eclipseSkyKeyAt(utc(2026, 8, 12, 16, 58, 6)), { id: 'solar-2026-08-12', body: 'sun', type: 'total', strength: 0.25 });
    assert.equal(eclipseSkyKeyAt(utc(2026, 8, 12, 17, 45, 53)).strength, 1);
    assert.equal(eclipseSkyKeyAt(utc(2026, 8, 12, 18, 34, 4)).strength, 0.25);
    assert.equal(eclipseSkyKeyAt(utc(2026, 8, 12, 18, 34, 5)), null);
    // 2027-08-02 total solar: U1 08:23:16 → 10:06:29 → U4 11:49:44 UTC.
    assert.equal(eclipseSkyKeyAt(utc(2027, 8, 2, 8, 23, 15)), null);
    assert.equal(eclipseSkyKeyAt(utc(2027, 8, 2, 10, 6, 29)).strength, 1);
    assert.equal(eclipseSkyKeyAt(utc(2027, 8, 2, 11, 49, 44)), null);
    // 2026-03-03 total lunar: full through totality U2 11:04:26 → U3 12:02:45.
    assert.equal(eclipseSkyKeyAt(utc(2026, 3, 3, 9, 49, 59)), null);
    assert.equal(eclipseSkyKeyAt(utc(2026, 3, 3, 11, 4, 26)).strength, 1);
    assert.equal(eclipseSkyKeyAt(utc(2026, 3, 3, 12, 2, 45)).strength, 1);
    assert.equal(eclipseSkyKeyAt(utc(2026, 3, 3, 13, 17, 10)), null);
    // 2026-08-28 deep partial lunar (0.93): peaks a step short of totality.
    assert.equal(eclipseSkyKeyAt(utc(2026, 8, 28, 4, 12, 52)).strength, 0.75);
    assert.equal(eclipseSkyKeyAt(utc(2026, 8, 28, 2, 33, 47)), null);
    assert.equal(eclipseSkyKeyAt(utc(2026, 8, 28, 5, 51, 55)), null);
    // Every key steps in quarters.
    for (const row of ECLIPSE_SKY_KEYS) {
        for (let t = row.start; t < row.end; t += 60_000) {
            const { strength } = eclipseSkyKeyAt(t);
            assert.ok([0.25, 0.5, 0.75, 1].includes(strength));
        }
    }
});

test('an eclipse keys the sky only while its body is up: umbra over the sun, blood on the moon', () => {
    // 2026-08-12 greatest eclipse from inside the path of totality
    // (Reykjavik): the full umbra.
    const reykjavik = { zone: 'reykjavik', lat: 64.15, lon: -21.94, offsetMinutes: () => 0 };
    const solar = createAtmosphereSnapshot({ now: new Date(2026, 7, 12, 17, 45, 53), solarSite: reykjavik, weatherOverride: { type: 'clear' } });
    assert.equal(solar.sky.sun.visible, true);
    assert.deepEqual(solar.skyKeys.eclipse, { id: 'solar-2026-08-12', body: 'sun', type: 'total', strength: 1 });
    assert.equal(eclipseStrength(solar.skyKeys, 'sun'), 1);
    // Greenwich lies off the path: a partial, capped, never totality.
    const partial = createAtmosphereSnapshot({ now: new Date(2026, 7, 12, 17, 45, 53), solarSite: GREENWICH, weatherOverride: { type: 'clear' } });
    assert.equal(partial.sky.sun.visible, true);
    assert.deepEqual(partial.skyKeys.eclipse, { id: 'solar-2026-08-12', body: 'sun', type: 'total', strength: PARTIAL_SOLAR_CAP });
    const umbra = skyKeyPalette(solar.sky.palette, solar.skyKeys);
    const luma = hex => {
        const n = parseInt(hex.slice(1), 16);
        return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    assert.ok(luma(umbra.zenith) < luma(solar.sky.palette.zenith), 'the zenith darkens toward the void ramp');
    assert.ok(luma(umbra.zenith) - luma(UMBRA_STOPS.zenith) < luma(solar.sky.palette.zenith) - luma(UMBRA_STOPS.zenith));
    assert.match(skyKeyToken(solar.skyKeys), /^k.*sun1$/);

    // The same instant on the far side of the Earth (03:45 in Sydney): the
    // sun is down, no key.
    const sydney = { zone: 'sydney', lat: -33.9, lon: 151.2, offsetMinutes: () => 600 };
    const unseen = createAtmosphereSnapshot({ now: new Date(2026, 7, 13, 3, 45, 53), solarSite: sydney, weatherOverride: { type: 'clear' } });
    assert.equal(unseen.sky.sun.visible, false);
    assert.equal(unseen.skyKeys.eclipse, null);
    const pacificNight = { zone: 'pacific', lat: 21.3, lon: -157.8, offsetMinutes: () => -600 };

    // 2026-03-03 11:33 UTC: the full moon over the Pacific at 01:33 local.
    const blood = createAtmosphereSnapshot({ now: new Date(2026, 2, 3, 1, 33, 37), solarSite: pacificNight, weatherOverride: { type: 'clear' } });
    assert.equal(blood.sky.moon.visible, true);
    assert.equal(blood.skyKeys.eclipse.body, 'moon');
    assert.equal(eclipseStrength(blood.skyKeys, 'moon'), 1);
    assert.equal(eclipseStrength(blood.skyKeys, 'sun'), 0);
    assert.equal(BLOOD_MOON_HEX, ART_RAMPS.clothCrimson[1]);
    assert.ok(Math.abs(moonAgeDaysAt(Date.UTC(2026, 2, 3, 11, 33)) - SYNODIC_MONTH_DAYS / 2) < 1, 'the lunation clock agrees it is full');
});

test('a solar eclipse is seen only near its track; a lunar eclipse wherever the moon is up', () => {
    const utc = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s);
    const peak2026 = utc(2026, 8, 12, 17, 45, 53);
    const annularPeak = utc(2027, 2, 6, 15, 59, 35);
    const peak2027 = utc(2027, 8, 2, 10, 6, 29);
    const at = (t, lat, lon) => eclipseSkyKeyAt(t, { lat, lon })?.strength ?? null;
    // On the central path: full (the annular at its magnitude).
    assert.equal(at(peak2026, 43.26, -2.93), 1, 'Bilbao, totality');
    assert.equal(at(annularPeak, -38.72, -62.27), 0.75, 'Bahía Blanca, annularity');
    assert.equal(at(annularPeak, 5.6, -0.19), 0.75, 'Accra, annularity');
    assert.equal(at(peak2027, 25.69, 32.64), 1, 'Luxor, totality');
    assert.equal(at(peak2027, 36.72, -4.42), 1, 'Málaga, totality');
    // Near but off the path: the partial cap.
    assert.equal(at(peak2026, 41.39, 2.17), PARTIAL_SOLAR_CAP, 'Barcelona, partial');
    assert.equal(at(peak2026, 48.86, 2.35), PARTIAL_SOLAR_CAP, 'Paris, partial');
    assert.equal(at(annularPeak, -34.9, -56.16), PARTIAL_SOLAR_CAP, 'Montevideo, partial');
    assert.equal(at(annularPeak, 5.32, -4.03), PARTIAL_SOLAR_CAP, 'Abidjan, partial');
    assert.equal(at(peak2027, 48.86, 2.35), PARTIAL_SOLAR_CAP, 'Paris, partial');
    // Far from the track: no eclipse at all.
    assert.equal(at(peak2026, -22.9, -43.2), null, 'Rio, 2026');
    assert.equal(at(peak2026, -33.9, 151.2), null, 'Sydney, 2026');
    assert.equal(at(annularPeak, 40.71, -74.0), null, 'New York, 2027-02');
    assert.equal(at(peak2027, 40.71, -74.0), null, 'New York, 2027-08');
    // The cap never lifts a key: before the peak the partial site keys as the path does, up to its cap.
    assert.equal(at(utc(2026, 8, 12, 16, 58, 6), 48.86, 2.35), 0.25);
    // A lunar key is the same everywhere (the moon's own visibility decides).
    for (const [lat, lon] of [[51.48, 0], [-33.9, 151.2], [21.3, -157.8]]) {
        assert.equal(at(utc(2026, 3, 3, 11, 33, 37), lat, lon), 1);
    }
    for (const row of ECLIPSE_SKY_KEYS) {
        assert.equal(Boolean(row.visibility), row.body === 'sun', `${row.id}: only solar eclipses carry visibility boxes`);
        assert.equal(eclipseVisibilityCap(row, null), 1, 'no site: no geographic gate');
    }
    // The snapshot reads the site's real latitude, not the village's clamped one.
    const highNorth = createAtmosphereSnapshot({ now: new Date(2026, 7, 12, 17, 45, 53), solarSite: { zone: 'scoresby', lat: 75, lon: -26, offsetMinutes: () => 0 }, weatherOverride: { type: 'clear' } });
    if (highNorth.sky.sun.visible) assert.equal(highNorth.skyKeys.eclipse?.strength, 1, 'east Greenland stays on the path');
});

test('puddles mirror the keyed sky, and the plate palette itself on ordinary dates', () => {
    const base = createAtmosphereSnapshot({ now: new Date(2026, 6, 15, 12, 0), solarSite: GREENWICH, weatherOverride: { type: 'clear' } });
    const renderer = {};
    assert.equal(keyedSkyPalette(renderer, base), base.sky.palette, 'no key: the same palette object');
    const umbra = createAtmosphereSnapshot({ now: new Date(2026, 7, 12, 17, 45, 53), solarSite: { zone: 'reykjavik', lat: 64.15, lon: -21.94, offsetMinutes: () => 0 }, weatherOverride: { type: 'clear' } });
    const keyed = keyedSkyPalette(renderer, umbra);
    assert.deepEqual(keyed, skyKeyPalette(umbra.sky.palette, umbra.skyKeys));
    assert.notEqual(keyed.upperBand, umbra.sky.palette.upperBand, 'the eclipse darkens the mirrored sky');
    assert.equal(keyedSkyPalette(renderer, umbra), keyed, 'memoized: one upload per keyed sky');
    assert.equal(keyedSkyPalette(renderer, { sky: null, skyKeys: umbra.skyKeys }), null);
    // The resident feed carries it (WorldFrameRenderer's GPU branch).
    const source = readFileSync(new URL('../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js', import.meta.url), 'utf8');
    assert.match(source, /gpuFeed\.skyPalette = keyedSkyPalette\(renderer, atmosphere\)/);
});

test('ordinary dates and every pinned capture date leave the sky untouched', () => {
    const belgrade = { zone: 'Europe/Belgrade' };
    // scripts/visual/capture.mjs DEFAULT_SCENARIOS (and the parity pair).
    const captures = [
        ['2026-07-15', 12], ['2026-07-15', 22], ['2026-07-15', 19.75], ['2026-07-15', 18],
        ['2026-01-15', 12], ['2026-11-19', 12], ['2026-04-20', 12],
    ];
    for (const [date, hour] of captures) {
        const [y, m, d] = date.split('-').map(Number);
        const snapshot = createAtmosphereSnapshot({
            now: new Date(y, m - 1, d, 12, 0), hourOverride: hour, timelineMode: 'fixed',
            weatherOverride: { type: 'clear' }, solarSite: belgrade,
        });
        assert.equal(snapshot.skyKeys.active, false, `${date} ${hour}h`);
        assert.equal(skyKeyPalette(snapshot.sky.palette, snapshot.skyKeys), snapshot.sky.palette, `${date} ${hour}h palette`);
        assert.equal(skyKeyToken(snapshot.skyKeys), '');
        assert.equal(snapshot.lunarTide, NEUTRAL_LUNAR_TIDE, `${date} ${hour}h tide`);
        assert.ok(!snapshot.cacheKey.includes('tide') && !snapshot.cacheKey.includes('|k'), 'the cache key is the old one');
    }
    // A sweep of ordinary 2026 middays under cloud: no key ever.
    for (let day = 0; day < 365; day += 3) {
        const now = new Date(2026, 0, 1 + day, 12, 0);
        const snapshot = createAtmosphereSnapshot({ now, solarSite: GREENWICH, weatherOverride: { type: 'overcast' } });
        const solstice = solsticeAlignmentDay({ month: now.getMonth() + 1, day: now.getDate() });
        if (solstice) continue;
        assert.equal(snapshot.skyKeys.active, false, now.toDateString());
        assert.equal(skyKeyPalette(snapshot.sky.palette, snapshot.skyKeys), snapshot.sky.palette);
    }
    assert.equal(skyKeyPalette(null, { active: true, lanternNight: true }), null);
});

// The overlay geometry the CoastBake decoder and the bake share.
test('the zone probe reads the bank face above the foot', () => {
    const u = (200 - 4 - 0.5) / TILE_HEIGHT + (102 + 0.5) / TILE_WIDTH;
    const v = (200 - 4 - 0.5) / TILE_HEIGHT - (102 + 0.5) / TILE_WIDTH;
    const bankZone = new Uint8Array(MAP_SIZE * MAP_SIZE);
    bankZone[Math.round(v) * MAP_SIZE + Math.round(u)] = 4;
    const cycleOffset = new Uint8Array(4).fill(255);
    cycleOffset[0] = 33;
    const feet = quayWaterlineFeet({ cols: 2, rows: 2, x: 102, y: 200, cycleOffset }, bankZone);
    assert.deepEqual(feet, [{ x: 102, y: 200, zone: 4 }]);
});
