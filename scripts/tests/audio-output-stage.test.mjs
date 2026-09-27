import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HEADPHONE_WORLD_WIDTH,
    OUTPUT_MODES,
    narrowedIcc,
    outputSettings,
    toneDb,
    widthMatrix,
} from '../../claudeville/src/presentation/shared/audio/OutputStage.js';
import { CueGovernor } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { CueKit, softenThunderPlan, thunderPlan } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

test('the width matrix keeps the mid and scales the side', () => {
    for (const w of [0, 0.3, HEADPHONE_WORLD_WIDTH, 1]) {
        const { a, b } = widthMatrix(w);
        // L = 1, R = 1 (pure mid) passes unchanged; L = 1, R = −1 (pure side) scales by w.
        assert.ok(Math.abs(a + b - 1) < 1e-12);
        assert.ok(Math.abs(a - b - w) < 1e-12);
    }
    assert.deepEqual(widthMatrix(7), widthMatrix(1));
    assert.deepEqual(widthMatrix(-1), widthMatrix(0));
});

test('headphones narrow any world bed to a coherence of at least 0.4', () => {
    for (let c = 0; c <= 1.0001; c += 0.05) {
        assert.ok(narrowedIcc(c, HEADPHONE_WORLD_WIDTH) >= 0.4, `icc ${c.toFixed(2)}`);
        assert.ok(narrowedIcc(c, HEADPHONE_WORLD_WIDTH) >= c - 1e-12, 'narrowing never widens');
    }
    assert.ok(Math.abs(narrowedIcc(0.3, 1) - 0.3) < 1e-12, 'width 1 leaves the bed as made');
});

test('output modes: speakers as made, headphones narrower, mono folded and lifted; unknown is speakers', () => {
    assert.deepEqual([...OUTPUT_MODES], ['speakers', 'headphones', 'mono']);
    const speakers = outputSettings('speakers');
    assert.equal(speakers.panScale, 1);
    assert.equal(speakers.worldWidth, 1);
    assert.equal(speakers.mono, false);
    assert.equal(speakers.monoCompDb, 0);
    const phones = outputSettings('headphones');
    assert.ok(phones.panScale < 1 && phones.worldWidth < 1 && !phones.mono);
    const mono = outputSettings('mono');
    assert.ok(mono.mono && mono.monoCompDb > 0);
    assert.equal(outputSettings('surround').output, 'speakers');
});

test('tone maps −1…+1 to ±4 dB and clamps', () => {
    assert.equal(toneDb(0), 0);
    assert.equal(toneDb(1), 4);
    assert.equal(toneDb(-1), -4);
    assert.equal(toneDb(3), 4);
    assert.equal(toneDb('x'), 0);
});

test('softened thunder: a slower first attack, half the peak, no crack, no secondary bump', () => {
    let seed = 1;
    const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const plan = thunderPlan(1, rng);
    const soft = softenThunderPlan(plan);
    assert.ok(soft.rolls[0].attack >= 0.25);
    assert.ok(Math.abs(soft.amplitude - plan.amplitude / 2) < 1e-12);
    assert.equal(soft.crack.length, 0);
    for (const roll of soft.rolls.slice(1)) assert.ok(roll.peak <= 0.25 * soft.rolls[0].peak + 1e-12);
    assert.equal(plan.crack.length > 0, true, 'the original near strike keeps its crack');
});

// A sounding engine on a frozen clock that records ducks and attacks.
function soundingEngine({ softened = false } = {}) {
    const param = (value = 1) => ({
        value,
        setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
        setTargetAtTime() {}, cancelScheduledValues() {},
    });
    const node = (extra = {}) => ({ connect: n => n, disconnect() {}, ...extra });
    const ducks = [];
    const attacks = [];
    const engine = {
        started: true,
        softened,
        now: () => 10,
        connectVoice: () => ({ output: node(), dispose() {} }),
        bedLoudness: () => -45,
        releaseVoice() {},
        duck(window) { ducks.push(window); return { cancel() {} }; },
        context: {
            sampleRate: 48000,
            currentTime: 10,
            createGain: () => {
                const gain = param(1);
                const orig = gain.linearRampToValueAtTime;
                gain.linearRampToValueAtTime = (v, t) => { attacks.push(t); return orig(v, t); };
                return node({ gain });
            },
            createBiquadFilter: () => node({ type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) }),
            createOscillator: () => node({ frequency: param(440), type: 'sine', start() {}, stop() {} }),
        },
    };
    return { engine, ducks, attacks };
}

const kitFor = engine => new CueKit(engine, new CueGovernor({ maxPerMinute: 60, minSpacingMs: 0 }));

test('soften: 30 % shallower ducks for every cue but the needs-you call', () => {
    const plain = soundingEngine();
    kitFor(plain.engine)._playAccepted({ kind: 'distress', lane: 'errors' });
    const soft = soundingEngine({ softened: true });
    kitFor(soft.engine)._playAccepted({ kind: 'distress', lane: 'errors' });
    for (const [bus, db] of Object.entries(plain.ducks[0].depths)) {
        assert.ok(Math.abs(soft.ducks[0].depths[bus] - db * 0.7) < 1e-9, bus);
    }
    const call = soundingEngine({ softened: true });
    kitFor(call.engine)._playAccepted({ kind: 'summons', lane: 'needsYou' });
    const callPlain = soundingEngine();
    kitFor(callPlain.engine)._playAccepted({ kind: 'summons', lane: 'needsYou' });
    assert.deepEqual(call.ducks[0].depths, callPlain.ducks[0].depths);
});

test('the family line rides the next urgent cue that sounds, once; previews and announcements never take it', () => {
    const { engine } = soundingEngine();
    const kit = kitFor(engine);
    const heard = [];
    const off = eventBus.on('audio:cue-played', cue => heard.push(cue));
    try {
        kit.armFamilyLine({ summons: 'That call means an agent needs you', distress: 'e', limit: 'l' });
        assert.equal(kit.play('summons', { agentId: 'p', test: true }), true);
        assert.equal(heard.length, 0, 'a preview is not captioned');
        kit.play('arrival', { agentId: 'a', announceOnly: true });
        kit.play('summons', { agentId: 'b' });
        kit.play('summons', { agentId: 'c' });
        const calls = heard.filter(cue => cue.kind === 'summons');
        assert.equal(calls[0].familyLine, 'That call means an agent needs you');
        assert.equal(calls[1].familyLine, undefined);
        assert.ok(heard.every(cue => !('announceOnly' in cue) && !('test' in cue)));
    } finally {
        off();
    }
});

test('the awakening sounds with a running context and not without one', () => {
    const { engine } = soundingEngine();
    assert.equal(kitFor(engine).playAwaken({ phase: 'day' }), true);
    assert.equal(kitFor({ context: null, started: false }).playAwaken(), false);
});
