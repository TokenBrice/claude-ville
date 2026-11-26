import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisualBeat } from '../../claudeville/src/presentation/shared/audio/VisualBeat.js';
import { MusicClock } from '../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { AmbientAudioController } from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { RitualConductor, ritualDownbeat, ritualPhaseOffset } from '../../claudeville/src/presentation/character-mode/RitualConductor.js';
import { ChimneySmoke } from '../../claudeville/src/presentation/character-mode/ChimneySmoke.js';
import { ParticleSystem } from '../../claudeville/src/presentation/character-mode/ParticleSystem.js';
import { WildlifeRenderer } from '../../claudeville/src/presentation/character-mode/WildlifeRenderer.js';

function band(bpm = 88) {
    const ctx = Object.assign(new EventTarget(), { state: 'running', currentTime: 1 });
    const engine = { context: ctx, now: () => ctx.currentTime, musicClock: new MusicClock() };
    const listeners = new Set();
    const sequencer = { preset: 'townBand', observe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
    engine.musicClock.publish({
        source: 'townBand', originTime: 0.053, beatSec: 60 / bpm, beatsPerBar: 4,
        until: 200, chords: [{ time: 0, rootPc: 0, pcs: [0, 4, 7] }],
    });
    const perfNow = () => 5000 + ctx.currentTime * 1000;
    ctx.getOutputTimestamp = () => ({ contextTime: ctx.currentTime, performanceTime: perfNow() });
    return {
        ctx, engine, sequencer, listeners, perfNow,
        tap() { return createVisualBeat({ engine, sequencer, musicClock: engine.musicClock, perfNow }); },
        emit(t, building = 'forge', step = 0, kind = 'perc') {
            for (const fn of listeners) fn({ kind, t, building, voice: 'substituted-kit-voice', step });
        },
    };
}

for (const bpm of [56, 72, 88, 104, 126]) {
    test(`scheduled contacts and bar grid at ${bpm} bpm`, () => {
        const f = band(bpm);
        const beat = f.tap();
        const changes = [-80, -35, 0, 60, 250, 251, -81];
        const beatSec = 60 / bpm;
        let locked = 0;
        let maxErr = 0;
        for (const [i, shift] of changes.entries()) {
            const t = 2 + i * beatSec * 2;
            f.ctx.currentTime = t - 0.35;
            f.emit(t, 'forge', i);
            f.emit(t, 'watchtower');
            f.emit(t, 'tavern');
            f.emit(t, undefined, i, 'note');
            const hit = beat.nextHit('forge', f.perfNow());
            assert.equal(hit.step, i);
            const audible = 5000 + t * 1000;
            assert.equal(hit.ms, audible - 8);
            const natural = hit.ms - shift;
            const contact = beat.contactFor('forge', natural, f.perfNow());
            if (shift >= -80 && shift <= 250) {
                assert.equal(contact, hit.ms);
                locked++;
                maxErr = Math.max(maxErr, Math.abs(audible - contact));
            } else assert.equal(contact, natural);
            assert.ok(contact - natural >= -80 && contact - natural <= 250);
            for (const excluded of ['watchtower', 'tavern', 'substituted-kit-voice']) {
                assert.equal(beat.nextHit(excluded, f.perfNow()), null);
            }
        }
        assert.equal(locked, 5);
        assert.ok(maxErr <= 40);
        assert.deepEqual(beat.stats(), { hits: 7, locked, pulled: 2, held: 2, missed: 2, maxErrMs: maxErr });
        const bar = 5045 + 4 * beatSec * 1000;
        for (const delta of [-81, -79, 79, 81]) {
            assert.ok(Math.abs(beat.barAccent(bar + delta, f.perfNow()) - (Math.abs(delta) <= 80 ? bar : bar + delta)) < 1e-8);
        }
        const lock = beat.lockedPeriod(2000, f.perfNow());
        assert.ok(Math.abs(lock.periodMs - 2000) <= 250);
        assert.equal(lock.originMs, 5045);
        assert.equal(lock.periodMs, Math.round(2000 / (beatSec * 250)) * (beatSec * 250));
        assert.equal(beat.lockedPeriod(10, f.perfNow()), null);
        beat.dispose();
    });
}

test('six smiths take two assigned hits each, including after ring rollover', () => {
    const f = band();
    const beat = f.tap();
    for (let i = 0; i < 50; i++) f.emit(2 + i, 'forge', i);
    assert.equal(beat.nextHit('forge', 0).step, 18);
    const counts = Array(6).fill(0);
    for (let i = 38; i < 50; i++) {
        f.ctx.currentTime = 2 + i - 0.25;
        const hit = beat.nextHit('forge', f.perfNow());
        const shifts = counts.map((_, slot) => beat.contactFor('forge', hit.ms - 50, f.perfNow(), slot, 6) === hit.ms);
        assert.equal(shifts.filter(Boolean).length, 1);
        assert.ok(shifts[i % 6]);
        counts[i % 6]++;
    }
    assert.deepEqual(counts, [2, 2, 2, 2, 2, 2]);
    beat.dispose();
});

test('timestamps follow output latency, smooth small offsets, snap large offsets, and fall back on statechange', () => {
    const f = band();
    const beat = f.tap();
    f.emit(8);
    f.emit(8.8, null, null, 'cadence');
    f.emit(8.1, null, null, 'cadence');
    assert.equal(beat.nextHit('forge', 0).ms, 12992);
    f.ctx.getOutputTimestamp = () => ({ contextTime: 1, performanceTime: 6010 });
    f.ctx.currentTime += 0.9;
    assert.equal(beat.nextHit('forge', 0).ms, 12992);
    f.ctx.currentTime += 0.2;
    assert.equal(beat.nextHit('forge', 0).ms, 12993);
    f.ctx.getOutputTimestamp = () => ({ contextTime: 1, performanceTime: 6120 });
    f.ctx.dispatchEvent(new Event('statechange'));
    assert.equal(beat.nextHit('forge', 0).ms, 13112);
    f.ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: NaN });
    f.ctx.dispatchEvent(new Event('statechange'));
    assert.equal(beat.nextHit('forge', 0).ms, 12992);
    assert.equal(beat.cadenceNear(13000, 1000), 13092);
    assert.equal(beat.cadenceNear(13000, 50), null);
    f.ctx.state = 'suspended';
    assert.equal(beat.active(), false);
    f.ctx.state = 'running';
    f.engine.musicClock.clear('townBand');
    assert.equal(beat.active(), false);
    beat.dispose();
    assert.equal(f.listeners.size, 0);
    assert.equal(beat.active(), false);
});

function controller(f) {
    return Object.assign(Object.create(AmbientAudioController.prototype), {
        engine: f.engine, mode: 'signals', enabled: false, volumeStep: 5, hushedUntil: 0,
        directors: { bgm: { player: f.sequencer, running: true, paused: false } },
    });
}

test('controller allocates one observer only for a sounding and visible Town band', t => {
    const f = band();
    const audio = controller(f);
    const page = { hidden: false };
    globalThis.document = page;
    t.after(() => { delete globalThis.document; });
    assert.equal(audio.getVisualBeat(), null);
    audio.enabled = true;
    assert.equal(audio.getVisualBeat(), null);
    audio.mode = 'bgm';
    f.ctx.state = 'suspended';
    assert.equal(audio.getVisualBeat(), null);
    assert.equal(f.listeners.size, 0);
    f.ctx.state = 'running';
    for (const [obj, prop, disabled, restored] of [
        [audio, 'volumeStep', 0, 5], [audio, 'hushedUntil', Infinity, 0],
        [audio, '_reducedMotion', () => true, () => false], [page, 'hidden', true, false],
        [audio.directors.bgm, '_atmosphere', { motion: { particleEnabled: false } }, null],
        [audio.directors.bgm, 'paused', true, false], [audio.directors.bgm, 'running', false, true],
        [audio, 'mode', 'signals', 'bgm'], [audio, 'enabled', false, true],
    ]) {
        const beat = audio.getVisualBeat();
        assert.ok(beat?.active());
        assert.equal(audio.getVisualBeat(), beat);
        assert.equal(f.listeners.size, 1);
        obj[prop] = disabled;
        assert.equal(beat.active(), false, prop);
        assert.equal(audio.getVisualBeat(), null, prop);
        assert.equal(f.listeners.size, 0);
        obj[prop] = restored;
    }
});

// Both clocks start far apart. The frame loop receives scheduled marks 1.5 s
// ahead and observes actual gesture wraps and particle spawns at 60 Hz.
test('a minute of gestures and smoke keeps its count at all five tempi', t => {
    let elapsed = 0;
    const epoch = 1700000000000;
    t.mock.method(Date, 'now', () => epoch + elapsed);
    t.mock.method(performance, 'now', () => 6000 + elapsed);
    t.mock.method(Math, 'random', () => 0.5);

    function minute(bpm, sounding) {
        elapsed = 0;
        const f = band(bpm);
        const beat = sounding ? f.tap() : null;
        const conductor = new RitualConductor({ visualBeat: beat });
        const smoke = new ChimneySmoke({ visualBeat: beat });
        smoke.sources = () => [{ key: 'forge:0', type: 'forge', x: 10, y: 10 }];
        const puffs = [];
        const particles = new ParticleSystem();
        let peakPuffs = 0;
        const smokeFrame = {
            atmosphere: { phase: 'day', weather: { type: 'clear' } },
            presence: new Map([['forge', { count: 1 }]]),
            particleSystem: particles,
        };
        const ritual = conductor.enqueue({ building: 'forge', agentId: 'smith', tool: 'Edit' });
        ritual.remainingMs = 61000;
        const contacts = [];
        const snapped = [];
        const seed = ritualPhaseOffset('smith', 460);
        let lastIndex;
        let lastNow;
        let lastOffset;
        let scheduled = 0;
        const hits = [];
        try {
            for (let frame = 0; frame < 3600; frame++) {
                elapsed = Math.round(frame * 1000 / 60);
                f.ctx.currentTime = 1 + elapsed / 1000;
                while (scheduled * 60 / bpm < f.ctx.currentTime + 1.5) {
                    const at = scheduled++ * 60 / bpm;
                    f.emit(at);
                    hits.push(1000 * (at - 1));
                }
                conductor.update(1000 / 60);
                const now = Date.now();
                const offset = ritualPhaseOffset('smith', 460);
                const clock = now + offset;
                if (elapsed > 220) assert.equal(ritualPhaseOffset('smith', 460, lastNow), lastOffset);
                lastNow = now;
                lastOffset = offset;
                const index = Math.floor(clock / 460);
                if (index > lastIndex) {
                    assert.equal(index, lastIndex + 1);
                    contacts.push(elapsed);
                    // The stamp and sprite must agree on the current contact.
                    const stamp = ritualDownbeat(ritual, now);
                    if (stamp) assert.ok(Math.abs(stamp.age - 120 - (clock % 460)) < 0.01);
                    const natural = index * 460 - seed - epoch;
                    const hit = hits.find(ms => ms - 8 >= natural - 80 && ms - 8 <= natural + 250);
                    if (sounding && hit != null && natural > 1500) {
                        assert.ok(Math.abs(elapsed - hit) <= 40, `frame at ${elapsed}, heard ${hit}`);
                        snapped.push(Math.abs(elapsed - hit));
                    }
                }
                lastIndex = index;
                if (frame === 1800) smokeFrame.presence.get('forge').count = 5;
                particles.update(1000 / 60);
                const live = particles.particles.length;
                smoke.update({ ...smokeFrame, timeMs: elapsed });
                for (let i = live; i < particles.particles.length; i++) puffs.push(elapsed);
                peakPuffs = Math.max(peakPuffs, particles.particles.length);
            }
        } finally {
            conductor.dispose();
            beat?.dispose();
        }
        assert.equal(peakPuffs, 12);
        return { puffs, contacts, snapped };
    }

    const off = minute(88, false);
    for (const bpm of [56, 72, 88, 104, 126]) {
        const on = minute(bpm, true);
        assert.equal(on.contacts.length, off.contacts.length);
        assert.equal(on.puffs.length, off.puffs.length);
        assert.notDeepEqual(on.contacts, off.contacts);
        assert.notDeepEqual(on.puffs, off.puffs);
        assert.ok(on.snapped.length > 20);
        t.diagnostic(`${bpm} bpm: ${on.snapped.length} snapped, max frame error ${Math.max(...on.snapped).toFixed(2)} ms; ${on.contacts.length} gestures, ${on.puffs.length} puffs`);
    }
});

test('frozen Off and Signals consumers match the undriven gesture, smoke and firefly output', t => {
    const f = band();
    const audio = controller(f);
    t.mock.method(Date, 'now', () => 1700000000000);
    function frozen(beat) {
        const conductor = new RitualConductor();
        const smoke = new ChimneySmoke();
        const fauna = new WildlifeRenderer({
            motionTimeMs: 125, _getVisibleTileBounds: () => ({ startX: 0, startY: 0, endX: 2, endY: 2 }),
        });
        if (beat !== undefined) {
            for (const consumer of [conductor, smoke, fauna]) consumer.setVisualBeat(beat);
        }
        const ritual = conductor.enqueue({ agentId: 'smith', tool: 'Edit', building: 'forge' });
        conductor.update(185);
        const offset = ritualPhaseOffset('smith', 460);
        const stamp = ritualDownbeat(ritual, ritual.beatOrigin * 460 - offset);
        const draws = [];
        fauna.drawAshMotes = () => {};
        fauna._fireflyCap = () => 1;
        fauna._fireflyHomeTiles = () => [{ seed: 0, x: 10, y: 8, tileX: 1, tileY: 1 }];
        fauna.drawFireflies({
            save() {}, restore() {},
            fillRect(...rect) { draws.push([this.fillStyle, ...rect]); },
        }, 6000);
        const puffs = [];
        smoke.sources = () => [{ key: 'forge:0', type: 'forge', x: 10, y: 8 }];
        smoke.update({ timeMs: 125, atmosphere: {}, presence: new Map([['forge', { count: 1 }]]),
            particleSystem: { motionEnabled: true, countTagged: () => 0, spawn: (...args) => puffs.push(args) } });
        conductor.dispose();
        assert.ok(draws.length && puffs.length && stamp);
        return Buffer.from(JSON.stringify({ offset, stamp, draws, puffs }));
    }
    const baseline = frozen(undefined);
    for (const enabled of [false, true]) {
        audio.enabled = enabled;
        assert.deepEqual(frozen(audio.getVisualBeat()), baseline);
    }
    assert.notDeepEqual(frozen({ active: () => true, phaseBiasFor: () => 0, lockedPeriod: () => ({ periodMs: 2100, originMs: 5000 }) }), baseline);
});

test('conductor assigns sorted slots to admitted bodies and keeps the lighthouse on its own clock', () => {
    const calls = new Map();
    const conductor = new RitualConductor();
    conductor.setVisualBeat({
        active: () => true,
        phaseBiasFor(id, building, natural, now, slot, of) {
            calls.set(id, [building, slot, of]);
            return 0;
        },
    });
    try {
        const ids = ['f', 'a', 'd', 'b', 'e', 'c'];
        for (const id of ids) conductor.enqueue({ agentId: id, building: 'forge', tool: 'Edit-' + id });
        conductor.update(180);
        for (const id of ids) ritualPhaseOffset(id, 460);
        for (const [slot, id] of [...ids].sort().entries()) assert.deepEqual(calls.get(id), ['forge', slot, 6]);

        conductor.update(2000);
        conductor.enqueue({ agentId: 'lookout', building: 'watchtower', tool: 'Search' });
        conductor.update(180);
        ritualPhaseOffset('lookout', 1300);
        assert.equal(calls.has('lookout'), false);
    } finally {
        conductor.dispose();
    }
});

test('a pulled contact on the admission frame gives both readers the same phase', () => {
    const id = 'first-frame';
    const natural = 46000 - ritualPhaseOffset(id, 460);
    const conductor = new RitualConductor({ visualBeat: {
        active: () => true, phaseBiasFor: () => 8,
    } });
    try {
        conductor.enqueue({ agentId: id, tool: 'Edit', building: 'forge' });
        conductor.update(180);
        const now = natural - 2;
        const first = ritualPhaseOffset(id, 460, now);
        assert.equal(ritualPhaseOffset(id, 460, now), first);
        assert.equal((now + first) % 460, 6);
    } finally {
        conductor.dispose();
    }
});
