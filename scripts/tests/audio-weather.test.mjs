import test from 'node:test';
import assert from 'node:assert/strict';

import {
    THUNDER,
    thunderAir,
    thunderAmplitude,
    thunderPlan,
} from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import {
    WHISTLE_BEND,
    WHISTLE_HZ,
    gustPlan,
    whistleDrive,
    windCutoffHz,
} from '../../claudeville/src/presentation/shared/audio/layers/WindLayer.js';
import { rainMaterials } from '../../claudeville/src/presentation/shared/audio/layers/RainLayer.js';
import { rngStream } from '../../claudeville/src/presentation/shared/audio/Rng.js';

const INTENSITIES = [0, 0.1, 0.25, 0.4, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1];

// Plan 4.2: the thunder level is mapped monotonically from intensity.
test('thunder amplitude rises strictly with intensity and stays in (0, 1]', () => {
    for (let i = 1; i < INTENSITIES.length; i++) {
        assert.ok(thunderAmplitude(INTENSITIES[i]) > thunderAmplitude(INTENSITIES[i - 1]), `at ${INTENSITIES[i]}`);
    }
    assert.equal(thunderAmplitude(1), 1);
    assert.ok(thunderAmplitude(0) > 0);
    assert.equal(thunderAmplitude(7), 1, 'out-of-range intensity is clamped');
});

// Plan 4.2: a 5–8 s roll; its level is the first roll's, so the draw never
// makes a quieter strike out of a nearer one.
test('every strike is one 5–8 s roll whose first roll is its loudest and whose release ends on time', () => {
    const rng = rngStream('test.thunder');
    for (let k = 0; k < 200; k++) {
        const intensity = INTENSITIES[k % INTENSITIES.length];
        const plan = thunderPlan(intensity, rng);
        assert.ok(plan.lengthSec >= THUNDER.lengthSec[0] && plan.lengthSec <= THUNDER.lengthSec[1], `length ${plan.lengthSec}`);
        assert.equal(plan.rolls[0].peak, 1);
        for (const roll of plan.rolls.slice(1)) assert.ok(roll.peak < 1);
        for (let i = 1; i < plan.rolls.length; i++) assert.ok(plan.rolls[i].at > plan.rolls[i - 1].at);
        const last = plan.rolls[plan.rolls.length - 1];
        assert.ok(last.at + last.attack + last.hold <= plan.lengthSec - THUNDER.releaseSec + 1e-9);
        // The release reaches −60 dB by the strike's end (S8: no stop before it).
        assert.ok(Math.abs(plan.releaseAt + 6.9 * plan.releaseTau - plan.lengthSec) < 1e-9);
        assert.ok(plan.crackEndSec <= plan.lengthSec);
    }
});

test('a strike crosses the sky: its pan starts on one side and ends on the other', () => {
    const rng = rngStream('test.thunder.pan');
    for (let k = 0; k < 50; k++) {
        const { pan } = thunderPlan(0.8, rng);
        assert.ok(Math.abs(pan.from) >= 0.35 && Math.abs(pan.from) <= 0.6);
        assert.ok(Math.sign(pan.from) === -Math.sign(pan.to));
    }
});

// AMB-6: distance is heard as darkness, length, wetness and the missing crack;
// a near strike's clap dies fast where a far one smears (must-never 8: a call
// just into a near roll does not sit on a held rumble).
test('far strikes are duller, longer, wetter and never crack; near strikes crack and clap', () => {
    const near = thunderPlan(1, rngStream('test.thunder.near'));
    const far = thunderPlan(0.2, rngStream('test.thunder.far'));
    assert.ok(far.lp.fromHz < near.lp.fromHz / 3);
    assert.ok(far.rolls[0].attack > near.rolls[0].attack);
    assert.ok(near.rolls[0].fallTau < far.rolls[0].fallTau / 2);
    assert.ok(near.rolls[0].fallTau < Math.min(...near.rolls.slice(1).map(r => r.fallTau)));
    assert.ok(far.crack.length === 0);
    assert.ok(near.crack.length >= 8);
    assert.ok(thunderAir(0.2) > thunderAir(1));
    // Averaged over draws, the far roll is the longer one.
    const mean = (intensity) => {
        const rng = rngStream(`test.thunder.len.${intensity}`);
        let sum = 0;
        for (let k = 0; k < 40; k++) sum += thunderPlan(intensity, rng).lengthSec;
        return sum / 40;
    };
    assert.ok(mean(0.1) > mean(1) + 1.5);
});

test('the same stream draws the same strike (seeded, no Math.random)', () => {
    assert.deepEqual(thunderPlan(0.7, rngStream('test.same')), thunderPlan(0.7, rngStream('test.same')));
});

// S1: no world voice sustains a fundamental in 500–700 Hz.
test('the rigging whistles stay above 800 Hz at every bend', () => {
    for (let g = 0; g <= 1.0001; g += 0.05) {
        for (const hz of WHISTLE_HZ) {
            assert.ok(hz * (WHISTLE_BEND[0] + WHISTLE_BEND[1] * g) > 800, `${hz} at g ${g}`);
            assert.ok(hz * WHISTLE_BEND[0] > 800);
        }
    }
});

// AMB-4: the rigging sings only in real weather and real wind.
test('whistles are silent on a calm day and in still air, and grow with both', () => {
    assert.equal(whistleDrive({ strength: 0.1, wind: 1.4 }), 0, 'calm day, strong wind');
    assert.equal(whistleDrive({ strength: 0.3, wind: 0.3 }), 0, 'weather without wind');
    assert.ok(whistleDrive({ strength: 0.3, wind: 1.2 }) > 0);
    assert.ok(whistleDrive({ strength: 0.5, wind: 1.2 }) > whistleDrive({ strength: 0.3, wind: 1.2 }));
});

test('wind brightens with speed and strength and muffles in fog, never below 160 Hz', () => {
    assert.ok(windCutoffHz({ strength: 0.3, wind: 1 }) > windCutoffHz({ strength: 0.3, wind: 0.2 }));
    assert.ok(windCutoffHz({ strength: 0.8 }) > windCutoffHz({ strength: 0.1 }));
    assert.ok(windCutoffHz({ strength: 0.3, fog: 1 }) < windCutoffHz({ strength: 0.3 }));
    assert.equal(windCutoffHz({ strength: 0, wind: 0, fog: 5 }), 160);
});

test('gusts come more often in stronger weather, rise before they fall, and always swell', () => {
    const meanGap = (strength) => {
        const rng = rngStream(`test.gust.${strength}`);
        let sum = 0;
        for (let k = 0; k < 400; k++) {
            const plan = gustPlan(strength, rng);
            assert.ok(plan.gap >= plan.rise, 'the next gust never starts before this one peaks');
            assert.ok(plan.swell.every(s => s > 1));
            assert.ok(plan.trail >= 0.3 && plan.trail <= 0.9);
            sum += plan.gap;
        }
        return sum / 400;
    };
    assert.ok(meanGap(0.05) > meanGap(1) + 3);
});

test('rain materials are silent when dry and thicken with precipitation', () => {
    const dry = rainMaterials(0.01);
    assert.equal(dry.wash, 0);
    for (const k of ['leaf', 'roof', 'plink']) {
        assert.equal(dry[k].gain, 0);
        assert.equal(dry[k].density, 0);
    }
    let previous = rainMaterials(0.05);
    for (const p of [0.2, 0.5, 0.9]) {
        const m = rainMaterials(p);
        assert.ok(m.wash > previous.wash);
        for (const k of ['leaf', 'roof', 'plink']) {
            assert.ok(m[k].density > previous[k].density, `${k} density at ${p}`);
            assert.ok(m[k].gain > previous[k].gain, `${k} gain at ${p}`);
        }
        previous = m;
    }
    assert.equal(rainMaterials(0.5, 0).rumble, 0);
    assert.ok(rainMaterials(0, 1).rumble > rainMaterials(0, 0.5).rumble, 'the rumble follows the storm, not the rain');
});

// The worklet in Node: stub the AudioWorklet globals and load the module.
let processorClass = null;
async function loadProcessor() {
    if (processorClass) return processorClass;
    globalThis.sampleRate = 48000;
    globalThis.AudioWorkletProcessor = class { constructor() { this.port = {}; } };
    globalThis.registerProcessor = (_name, cls) => { processorClass = cls; };
    await import('../../claudeville/src/presentation/shared/audio/worklets/noise-processor.js');
    return processorClass;
}

// `density` is events/s, or a function of (quantum, sounded so far).
function renderQuanta(proc, density, quanta) {
    const L = new Float32Array(128 * quanta);
    const R = new Float32Array(128 * quanta);
    let sounded = false;
    for (let q = 0; q < quanta; q++) {
        const left = new Float32Array(128);
        const right = new Float32Array(128);
        const d = typeof density === 'function' ? density(q, sounded) : density;
        const alive = proc.process([], [[left, right]], { density: new Float32Array([d]) });
        if (left.some(v => v !== 0)) sounded = true;
        assert.equal(alive, true);
        L.set(left, q * 128);
        R.set(right, q * 128);
    }
    return { L, R };
}

// S1 physics: drops on water glide *up*.
test('a bubble (a drop on water) rises in pitch while it rings', async () => {
    const Processor = await loadProcessor();
    const proc = new Processor({ processorOptions: { kind: 'bubbles', seed: 7, fmin: 2000, fmax: 2000, tauMs: 30 } });
    // Events until the first bubble sounds, then let it ring out alone.
    const { L, R } = renderQuanta(proc, (_q, sounded) => (sounded ? 0 : 50), 400);
    const mid = L.map((v, i) => v + R[i]);
    const start = mid.findIndex(v => Math.abs(v) > 1e-4);
    assert.ok(start >= 0, 'a bubble sounded');
    const crossings = [];
    for (let i = start + 1; i < Math.min(mid.length, start + 2400); i++) {
        if (mid[i - 1] <= 0 && mid[i] > 0) crossings.push(i);
    }
    const period = (a, b) => (crossings[b] - crossings[a]) / (b - a);
    const early = period(0, 4);
    const late = period(crossings.length - 5, crossings.length - 1);
    assert.ok(early > late * 1.25, `period ${early.toFixed(2)} → ${late.toFixed(2)} samples`);
    // The glide stops at ×1.5, so the pitch never runs off towards Nyquist.
    assert.ok(late > 48000 / (2000 * 1.5) - 1);
});

test('the worklet is silent at zero density and stops on request', async () => {
    const Processor = await loadProcessor();
    for (const kind of ['dust', 'bubbles']) {
        const proc = new Processor({ processorOptions: { kind, seed: 3 } });
        const { L, R } = renderQuanta(proc, 0, 8);
        assert.ok(L.every(v => v === 0) && R.every(v => v === 0), kind);
        proc.port.onmessage({ data: 'stop' });
        assert.equal(proc.process([], [[new Float32Array(128), new Float32Array(128)]], { density: new Float32Array([100]) }), false);
    }
});

test('dust density sets the event rate', async () => {
    const Processor = await loadProcessor();
    // An onset is the first sound after ≥ 1 ms of true silence (a tick
    // under the worklet's floor outputs exact zeros).
    const onsetsPerSec = (density) => {
        const proc = new Processor({ processorOptions: { kind: 'dust', seed: 11, decayMs: 0.5 } });
        const { L, R } = renderQuanta(proc, density, 375 * 4);
        let count = 0;
        let zeros = 48;
        for (let i = 0; i < L.length; i++) {
            if (L[i] === 0 && R[i] === 0) { zeros++; continue; }
            if (zeros >= 48) count++;
            zeros = 0;
        }
        return count / 4;
    };
    const slow = onsetsPerSec(20);
    const fast = onsetsPerSec(100);
    assert.ok(slow > 12 && slow < 28, `~20/s → ${slow}`);
    assert.ok(fast > 2 * slow, `~100/s → ${fast}`);
});
