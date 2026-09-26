import test from 'node:test';
import assert from 'node:assert/strict';

import {
    INSTRUMENTS,
    ROOT_STEP,
    bakeSpecs,
    createInstrument,
    hzOf,
    liveHarmonics,
    renderBake,
    rootFor,
} from '../../claudeville/src/presentation/shared/audio/music/Instruments.js';
import { MEMORY_BUDGET } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';

const NAMES = Object.keys(INSTRUMENTS);
const cents = (a, b) => 1200 * Math.log2(a / b);

// The fundamental of a take: the peak of a Hann-windowed DFT swept ±5 ct
// around the root in 0.05 ct steps, over 0.05–1.05 s.
function fundamental(x, sr, f0) {
    const a = Math.floor(0.05 * sr);
    const n = Math.min(x.length - a, sr);
    let best = -1;
    let bestHz = f0;
    for (let c = -100; c <= 100; c++) {
        const f = f0 * 2 ** (c * 0.05 / 1200);
        const w = 2 * Math.PI * f / sr;
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
            const v = x[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
            re += v * Math.cos(w * i);
            im += v * Math.sin(w * i);
        }
        const m = re * re + im * im;
        if (m > best) { best = m; bestHz = f; }
    }
    return bestHz;
}

test('every pitch in an instrument range plays from a root within ±1.5 semitones', () => {
    for (const name of NAMES) {
        const row = INSTRUMENTS[name];
        if (!row.roots.length) continue;
        const [lo, hi] = row.range;
        for (let semi = lo - 0.5; semi <= hi + 0.5; semi += 0.25) {
            const { root, rate } = rootFor(name, semi);
            assert.ok(Math.abs(semi - root) <= ROOT_STEP / 2 + 1e-9, `${name} ${semi} → root ${root}`);
            assert.ok(Math.abs(hzOf(root) * rate - hzOf(semi)) < 1e-9 * hzOf(semi), `${name} ${semi} rate`);
        }
    }
});

test('music bakes: unique keys, shared noise takes, and the whole set inside MEMORY_BUDGET.music', () => {
    setRngSeed('instruments-test');
    const seen = new Map();
    let bytes = 0;
    for (const name of NAMES) {
        for (const spec of bakeSpecs(name)) {
            const known = seen.get(spec.key);
            if (known) {
                // A take two instruments share is one bake at one rate.
                assert.equal(known.sampleRate, spec.sampleRate, spec.key);
                assert.equal(known.take, spec.take, spec.key);
                continue;
            }
            seen.set(spec.key, spec);
            assert.ok(spec.sampleRate <= 32000, `${spec.key} stored at ${spec.sampleRate} Hz`);
            bytes += renderBake(spec).length * 4;
        }
    }
    assert.ok(bytes <= MEMORY_BUDGET.music, `${(bytes / 1048576).toFixed(2)} MiB resident with every instrument baked`);
});

test('every baked take peaks at 1 and ends at least 60 dB under its peak (S8 declick)', () => {
    setRngSeed('instruments-test');
    for (const name of NAMES) {
        for (const spec of bakeSpecs(name)) {
            if (spec.take === 'swish') continue; // a loop, shaped by the note
            const x = renderBake(spec);
            let peak = 0;
            for (const v of x) peak = Math.max(peak, Math.abs(v));
            assert.ok(Math.abs(peak - 1) < 1e-6, `${spec.key} peak ${peak}`);
            const tail = Math.max(...Array.from(x.subarray(-8), Math.abs));
            assert.ok(tail <= 1e-3, `${spec.key} ends at ${(20 * Math.log10(tail)).toFixed(1)} dB`);
        }
    }
});

test('Karplus–Strong strings are tuned within 1 cent at every root', () => {
    setRngSeed('instruments-test');
    for (const name of ['lute', 'harp', 'upright']) {
        for (const spec of bakeSpecs(name)) {
            const x = renderBake(spec);
            const f = fundamental(x, spec.sampleRate, hzOf(spec.root));
            assert.ok(Math.abs(cents(f, hzOf(spec.root))) <= 1, `${spec.key} ${cents(f, hzOf(spec.root)).toFixed(2)} ct`);
        }
    }
});

test('a live wave keeps its seat low-pass: harmonics above the corner fall away', () => {
    const low = liveHarmonics('chipBass', 110, { lp: () => [800, Math.SQRT1_2] });
    const high = liveHarmonics('chipBass', 440, { lp: () => [800, Math.SQRT1_2] });
    // The 3rd harmonic of A4 (1320 Hz) is past 800 Hz, that of A2 (330 Hz) is not.
    assert.ok(high[3] / high[1] < 0.5 * (low[3] / low[1]));
    const dark = liveHarmonics('pulse25', 440, { bright: 0.5 });
    const plain = liveHarmonics('pulse25', 440);
    assert.ok(Math.abs(dark[5] / dark[1]) < Math.abs(plain[5] / plain[1]));
});

// ---------------------------------------------------------------- nodes

function fakeContext() {
    const created = [];
    const param = (value = 0) => ({
        value,
        setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
        setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {},
    });
    const node = (kind, extra = {}) => {
        const n = { kind, connect: to => to, disconnect() {}, ...extra };
        created.push(n);
        return n;
    };
    const source = kind => node(kind, { start() {}, stop() {}, playbackRate: param(1), frequency: param(440), detune: param(0) });
    return {
        created,
        currentTime: 0,
        sampleRate: 48000,
        createGain: () => node('gain', { gain: param(1) }),
        createOscillator: () => source('osc'),
        createBufferSource: () => source('buffer'),
        createBiquadFilter: () => node('biquad', { frequency: param(350), Q: param(1) }),
        createStereoPanner: () => node('panner', { pan: param(0) }),
        createPeriodicWave: () => ({}),
        createBuffer: (channels, length, sampleRate) => ({ length, sampleRate, duration: length / sampleRate, numberOfChannels: channels, copyToChannel() {} }),
    };
}

// A bank whose every bake is resident (the buffers are stand-ins).
function residentBank(ctx) {
    return {
        has: () => true,
        get: key => ctx.createBuffer(1, 32000, 16000, key),
        slice: () => () => {},
    };
}

test('no note builds more than 4 nodes, nor more than its row declares, in any option', () => {
    const variants = [{}, { bright: 0.4 }, { soft: 1 }, { pan: -0.5 }, { bright: 0.3, soft: 0.5, pan: 0.7 }];
    for (const baked of [true, false]) {
        for (const name of NAMES) {
            const row = INSTRUMENTS[name];
            assert.ok(row.nodesPerNote <= 4, `${name} declares ${row.nodesPerNote}`);
            const ctx = fakeContext();
            const engine = { context: ctx, bank: baked ? residentBank(ctx) : null, noiseSource: () => ctx.createBufferSource() };
            const inst = createInstrument(engine, name, { dest: ctx.createGain(), rng: () => 0.3 });
            for (const opts of variants) {
                for (const dur of [0.2, 1.5, Infinity]) {
                    const before = ctx.created.length;
                    const hadBreath = Boolean(inst._breath);
                    const end = inst.note(1, row.kind === 'perc' ? 0 : 440, dur, 1, opts);
                    let built = ctx.created.length - before;
                    // The whistle's breath lane is per instrument, not per note.
                    if (!hadBreath && inst._breath) built -= 3;
                    if (end == null) continue;
                    assert.ok(built <= row.nodesPerNote, `${name} ${JSON.stringify(opts)} dur ${dur}: ${built} nodes`);
                }
            }
        }
    }
});

test('pitched voices sound before their bake; percussion waits for its take', () => {
    const ctx = fakeContext();
    const engine = { context: ctx, bank: null };
    for (const name of NAMES) {
        const inst = createInstrument(engine, name, { dest: ctx.createGain(), rng: () => 0.5 });
        const end = inst.note(1, INSTRUMENTS[name].kind === 'perc' ? 0 : 220, 0.5, 1);
        if (INSTRUMENTS[name].kind === 'perc') assert.equal(end, null, name);
        else assert.ok(end > 1, `${name} → ${end}`);
    }
});
