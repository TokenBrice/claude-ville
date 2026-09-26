import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AudioDirector } from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';
import { BgmDirector } from '../../claudeville/src/presentation/shared/audio/BgmDirector.js';
import { CueGovernor } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import {
    URGENT_FALLBACK_TRIM_DB,
    URGENT_PEAK_MAX_DBFS,
    cueTrimDb,
    urgentTrimCapDb,
} from '../../claudeville/src/presentation/shared/audio/CueLevel.js';
import { DUCK_DEPTHS } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { CueKit } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';

// --- cueTrimDb: S2 trim rules per class --------------------------------------

test('an urgent cue aims at its floor + 2 LU and is never trimmed below 0 dB', () => {
    // needs-you over a Village bed: floor +10, aim +12.
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -36, bedLufs: -45 }), 3);
    // Over music the floor is +8, so the same bed asks 2 dB less.
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -36, bedLufs: -45, bed: 'music' }), 1);
    // A near-silent bed would ask for a cut; urgent cues never take one.
    assert.equal(cueTrimDb({ lane: 'error', nominalLufsM: -36, bedLufs: -70 }), 0);
    // A loud bed lifts to the +12 dB ceiling and no further.
    assert.equal(cueTrimDb({ lane: 'limit', nominalLufsM: -36, bedLufs: -20 }), 12);
});

test('an urgent lift stops where the limiter would take it back, never below 0 dB', () => {
    // The predicted peak (nominal + trim + PLR) stays within the urgent GR
    // budget at the limiter input.
    const cap = URGENT_PEAK_MAX_DBFS - (-40 + 8);
    assert.ok(cap > 0 && cap < 12);
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -40, plr: 8, bedLufs: -30 }), cap);
    assert.equal(urgentTrimCapDb(-40, 8), cap);
    // A lift under the cap is untouched; a peak already over it keeps 0 dB.
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -40, plr: 8, bedLufs: -50 }), 2);
    assert.equal(cueTrimDb({ lane: 'error', nominalLufsM: -20, plr: 20, bedLufs: -20 }), 0);
    // The cap also holds a wake's remembered trim, and routine cues are uncapped.
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -40, plr: 8, bedLufs: null, recentUrgentTrims: [12] }), cap);
    assert.equal(cueTrimDb({ lane: 'routine', nominalLufsM: -40, plr: 20, bedLufs: -30 }), 12);
});

test('with no bed to read, an urgent cue takes the median recent trim, else +6 dB', () => {
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -36, bedLufs: null, recentUrgentTrims: [9, 2, 4] }), 4);
    assert.equal(cueTrimDb({ lane: 'error', nominalLufsM: -36, bedLufs: null, recentUrgentTrims: [2, 5] }), 3.5);
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -36, bedLufs: null }), URGENT_FALLBACK_TRIM_DB);
    assert.equal(URGENT_FALLBACK_TRIM_DB, 6);
    // Recent trims only stand in for a missing bed; a real read wins.
    assert.equal(cueTrimDb({ lane: 'needsYou', nominalLufsM: -36, bedLufs: -45, recentUrgentTrims: [12, 12] }), 3);
});

test('routine and Medium/Major outcomes move within -6…+12 dB; unknown beds leave them at 0', () => {
    // routine floor +3, aim +5.
    assert.equal(cueTrimDb({ lane: 'routine', nominalLufsM: -38, bedLufs: -44 }), -1);
    assert.equal(cueTrimDb({ lane: 'routine', nominalLufsM: -38, bedLufs: -70 }), -6);
    assert.equal(cueTrimDb({ lane: 'routine', nominalLufsM: -38, bedLufs: -20 }), 12);
    // Major outcome floor +4, aim +5.
    assert.equal(cueTrimDb({ lane: 'outcomeMajor', nominalLufsM: -38, bedLufs: -40 }), 3);
    assert.equal(cueTrimDb({ lane: 'outcomeMedium', nominalLufsM: -38, bedLufs: -70 }), -6);
    assert.equal(cueTrimDb({ lane: 'routine', nominalLufsM: -38, bedLufs: null, recentUrgentTrims: [9] }), 0);
});

test('Minor outcomes, scenery and thunder are never lifted', () => {
    for (const lane of ['outcomeMinor', 'scenery', 'thunder']) {
        assert.equal(cueTrimDb({ lane, nominalLufsM: -34, bedLufs: -20 }), 0, `${lane} over a loud bed`);
        assert.equal(cueTrimDb({ lane, nominalLufsM: -34, bedLufs: -70 }), -6, `${lane} over a quiet bed`);
    }
    // Scenery floor 0, aim +1: a -33.5 bell over a -40 bed comes down 5.5 dB.
    assert.equal(cueTrimDb({ lane: 'scenery', nominalLufsM: -33.5, bedLufs: -40 }), -5.5);
    // A Minor outcome aims 3 LU under its floor: the knock sits under the bed.
    assert.equal(cueTrimDb({ lane: 'outcomeMinor', nominalLufsM: -43, bedLufs: -45 }), -5);
});

// --- CueKit: note-timed ducks that leave with their cue -----------------------

function fakeParam(value = 1) {
    return {
        value,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
        setTargetAtTime() {},
        cancelScheduledValues() {},
    };
}

function fakeNode(extra = {}) {
    return { connect: node => node, disconnect() {}, ...extra };
}

function soundingEngine({ now = 0, bedLufs = -45 } = {}) {
    const ducks = [];
    const engine = {
        clock: now,
        started: true,
        now: () => engine.clock,
        connectVoice: () => ({ output: fakeNode(), dispose() {} }),
        bedLoudness: () => bedLufs,
        releaseVoice() {},
        noiseSource: () => fakeNode({ playbackRate: fakeParam(1), start() {}, stop() {} }),
        duck(window) {
            const record = { ...window, cancelled: false };
            ducks.push(record);
            return { cancel() { record.cancelled = true; } };
        },
        context: {
            currentTime: now,
            createGain: () => fakeNode({ gain: fakeParam() }),
            createBiquadFilter: () => fakeNode({
                type: 'lowpass',
                frequency: fakeParam(350),
                Q: fakeParam(1),
                gain: fakeParam(0),
            }),
            createStereoPanner: () => fakeNode({ pan: fakeParam(0) }),
            createOscillator: () => fakeNode({ frequency: fakeParam(440), type: 'sine', start() {}, stop() {} }),
            createBufferSource: () => fakeNode({ playbackRate: fakeParam(1), start() {}, stop() {} }),
        },
    };
    return { engine, ducks };
}

const nextTick = () => new Promise(resolve => { setTimeout(resolve, 0); });
const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

test('a prepared routine cue pre-empted by an urgent one takes its duck with it', async () => {
    const { engine, ducks } = soundingEngine();
    const governor = new CueGovernor({ minSpacingMs: 0, aggregationWindowMs: 50 });
    const kit = new CueKit(engine, governor);
    try {
        assert.equal(kit.play('arrival', { agentId: 'ada' }), true);
        await nextTick(); // arrival waits out the dispatch before it schedules
        assert.equal(ducks.length, 1);
        assert.equal(ducks[0].depths, DUCK_DEPTHS.village);
        assert.ok(ducks[0].from > engine.now(), 'the prepared bell is still ahead of the clock');

        assert.equal(kit.play('summons', { agentId: 'bram' }), true);
        assert.equal(ducks.length, 2);
        assert.equal(ducks[0].cancelled, true, 'the pre-empted cue leaves no dip');
        assert.equal(ducks[1].cancelled, false);
        assert.equal(ducks[1].depths, DUCK_DEPTHS.urgent);
        assert.ok(ducks[1].until > ducks[1].from, 'the duck holds past the last note');
    } finally {
        governor.destroy();
    }
});

test('a withdrawn cue whose first note already sounded keeps its duck', async () => {
    const { engine, ducks } = soundingEngine();
    const governor = new CueGovernor({ minSpacingMs: 0, aggregationWindowMs: 50 });
    const kit = new CueKit(engine, governor);
    try {
        kit.play('recovery', { agentId: 'ada' });
        assert.equal(ducks.length, 1);
        engine.clock = ducks[0].from + 0.01;
        governor.clearRoutine();
        assert.equal(ducks[0].cancelled, false);
    } finally {
        governor.destroy();
    }
});

test('Town band cues duck the band, and thunder ducks nothing', async () => {
    const { engine, ducks } = soundingEngine();
    const governor = new CueGovernor({ minSpacingMs: 0, aggregationWindowMs: 5 });
    const kit = new CueKit(engine, governor);
    try {
        kit.play('hourBell', { preset: 'townBand' });
        await wait(20);
        assert.equal(ducks.length, 1);
        assert.equal(ducks[0].depths, DUCK_DEPTHS.townBand);

        kit.play('thunder', { intensity: 1 });
        await wait(20);
        assert.equal(ducks.length, 1, 'thunder is weather; it carves no room');
    } finally {
        governor.destroy();
    }
});

// --- One arbiter across a preset switch ---------------------------------------

test('a summons, a preset switch, then the same agent within 45 s is rejected', () => {
    const engine = { context: null, started: false };
    const governor = new CueGovernor();
    const cues = { kit: new CueKit(engine, governor), governor };
    const heard = [];
    const unsubscribe = eventBus.on('audio:cue-played', cue => heard.push(cue));
    const raise = agentId => eventBus.emit('attention:raised', {
        agentId,
        status: 'waiting_on_user',
        agent: { id: agentId, name: agentId, status: 'waiting_on_user' },
    });
    const village = new AudioDirector({ engine, cues });
    let band = null;
    try {
        raise('agent-ada');
        assert.deepEqual(heard.map(cue => `${cue.kind}:${cue.agentId}`), ['summons:agent-ada']);

        village.destroy();
        band = new BgmDirector({ engine, cues });
        band.running = true;
        band._subscribe();

        raise('agent-ada');
        assert.equal(heard.length, 1, 'the cooldown outlives the director that spent it');
        raise('agent-bram');
        assert.deepEqual(heard.map(cue => `${cue.kind}:${cue.agentId}`), [
            'summons:agent-ada',
            'summons:agent-bram',
        ]);
    } finally {
        unsubscribe();
        band?.stop();
        village.destroy();
        governor.destroy();
    }
});
