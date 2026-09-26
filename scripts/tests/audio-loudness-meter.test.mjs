import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LoudnessMeterState,
    kWeightingCoefficients,
} from '../../claudeville/src/presentation/shared/audio/AudioEngine.js';

const BLOCK_SEC = 0.1;

// Stateful direct-form IIR, the same maths an IIRFilterNode runs per channel.
function iir({ feedforward: [b0, b1, b2], feedback: [, a1, a2] }) {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    return (x) => {
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
    };
}

// Feeds `seconds` of a stereo sine (same signal on both channels) through
// K-weighting in 100 ms blocks, as the meter worklet reports them.
function feedSine(state, { sampleRate, hz, dbfs, seconds, phase = { n: 0 } }) {
    const { shelf, highpass } = kWeightingCoefficients(sampleRate);
    const head = iir(shelf);
    const rlb = iir(highpass);
    const amp = Math.pow(10, dbfs / 20);
    const blockLen = Math.round(sampleRate * BLOCK_SEC);
    const blocks = Math.round(seconds / BLOCK_SEC);
    for (let b = 0; b < blocks; b++) {
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < blockLen; i++) {
            const x = amp * Math.sin(2 * Math.PI * hz * phase.n++ / sampleRate);
            const k = rlb(head(x));
            sum += 2 * k * k;
            peak = Math.max(peak, Math.abs(x));
        }
        state.push(sum, blockLen, peak);
    }
}

// Feeds blocks whose K-weighted loudness is exactly `lufs`.
function feedLevel(state, lufs, seconds) {
    const samples = 4800;
    const meanSquare = Math.pow(10, (lufs + 0.691) / 10);
    for (let b = 0; b < Math.round(seconds / BLOCK_SEC); b++) state.push(meanSquare * samples, samples, 0);
}

for (const sampleRate of [48000, 44100]) {
    test(`a 1 kHz stereo sine at -23 dBFS reads -23 LUFS at ${sampleRate} Hz (EBU Tech 3341 case 1)`, () => {
        const state = new LoudnessMeterState();
        feedSine(state, { sampleRate, hz: 1000, dbfs: -23, seconds: 20 });
        const reading = state.read();
        assert.ok(Math.abs(reading.momentary + 23) <= 0.1, `momentary ${reading.momentary}`);
        assert.ok(Math.abs(reading.shortTerm + 23) <= 0.1, `short-term ${reading.shortTerm}`);
        assert.ok(Math.abs(reading.integrated + 23) <= 0.1, `integrated ${reading.integrated}`);
        assert.ok(Math.abs(reading.peak + 23) <= 0.05, `peak ${reading.peak}`);
    });
}

test('the relative gate drops quiet passages from the integrated value (Tech 3341 case 3)', () => {
    const state = new LoudnessMeterState();
    feedLevel(state, -36, 10);
    feedLevel(state, -23, 60);
    feedLevel(state, -36, 10);
    assert.ok(Math.abs(state.read().integrated + 23) <= 0.1, `integrated ${state.read().integrated}`);
});

test('the absolute gate ignores blocks at or below -70 LUFS (Tech 3341 case 4)', () => {
    const state = new LoudnessMeterState();
    feedLevel(state, -72, 10);
    feedLevel(state, -36, 10);
    feedLevel(state, -23, 60);
    feedLevel(state, -36, 10);
    feedLevel(state, -72, 10);
    assert.ok(Math.abs(state.read().integrated + 23) <= 0.1, `integrated ${state.read().integrated}`);
});

test('momentary follows the last 400 ms while short-term still holds 3 s', () => {
    const state = new LoudnessMeterState();
    feedLevel(state, -20, 5);
    for (let i = 0; i < 5; i++) state.push(0, 4800, 0);
    const reading = state.read();
    assert.equal(reading.momentary, null);
    // 25 of the 30 short-term blocks are still at -20 LUFS.
    assert.ok(Math.abs(reading.shortTerm - (-20 + 10 * Math.log10(25 / 30))) <= 1e-9, `short-term ${reading.shortTerm}`);
});

test('a silent meter reports no loudness rather than a number', () => {
    const state = new LoudnessMeterState();
    assert.deepEqual(state.read(), { momentary: null, shortTerm: null, integrated: null, peak: null });
    feedLevel(state, -80, 2);
    assert.equal(state.read().integrated, null);
});
