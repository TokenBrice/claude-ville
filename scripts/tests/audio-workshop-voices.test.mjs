import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PENTATONIC,
    WORKSHOP_BAKE_RATE,
    WORKSHOP_BANK_CLIENT,
    WORKSHOP_VOICES,
    bakeWorkshopTakes,
    measureTake,
    noteHz,
    renderTake,
    takeFor,
    takeInfo,
    takeSpec,
    tonalModes,
    workshopTakeSpecs,
} from '../../claudeville/src/presentation/shared/audio/WorkshopVoices.js';
import { MEMORY_BUDGET } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { SampleBank } from '../../claudeville/src/presentation/shared/audio/SampleBank.js';
import { setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';

// A mode still reads as A6 within a quarter-tone (take jitter is ≤ 1 %).
const UNDER_A6 = noteHz('A6') * Math.pow(2, -0.5 / 12);
const PHASES = [['day', false], ['night', true]];

// Semitones above A (mod 12) and the distance in cents to the nearest 12-TET note.
function degreeOf(hz) {
    const semis = 12 * Math.log2(hz / 440);
    const nearest = Math.round(semis);
    return { degree: ((nearest % 12) + 12) % 12, cents: Math.abs(semis - nearest) * 100 };
}

function phaseTones(b, phase) {
    const tones = [...(phase === 'night' ? b.accent.pitchesNight : b.accent.pitchesDay)];
    if (b.ghostPitch) tones.push(b.ghostPitch[phase]);
    for (const v of Object.values(b.voices)) if (v.fixedPitch) tones.push(v.fixedPitch[phase]);
    return tones;
}

test('every workshop tone is an A-major pentatonic degree by day and an A-minor one at night', () => {
    for (const [name, b] of Object.entries(WORKSHOP_VOICES)) {
        for (const [phase] of PHASES) {
            for (const hz of phaseTones(b, phase)) {
                const { degree, cents } = degreeOf(hz);
                assert.ok(cents < 0.5, `${name} ${phase} ${hz} Hz is ${cents.toFixed(2)} cents off 12-TET`);
                assert.ok(PENTATONIC[phase].includes(degree), `${name} ${phase} ${hz} Hz (degree ${degree}) is not in the ${phase} pentatonic`);
            }
        }
    }
});

test('at night the Forge slots flip C♯7→C7 and F♯7→G7 in place and the Portal ticks drop ×0.75', () => {
    const forge = WORKSHOP_VOICES.forge.accent;
    const flip = new Map([[noteHz('C#7'), noteHz('C7')], [noteHz('F#7'), noteHz('G7')]]);
    assert.deepEqual(forge.pitchesNight, forge.pitchesDay.map(hz => flip.get(hz) ?? hz));
    assert.equal(new Set(forge.pitchesDay).size, forge.pitchesDay.length, 'each Forge slot has its own pitch');
    const ghost = WORKSHOP_VOICES.forge.ghostPitch;
    assert.ok(!forge.pitchesDay.includes(ghost.day) && !forge.pitchesNight.includes(ghost.night), 'the ghost pitch is no slot pitch');
    const portal = WORKSHOP_VOICES.portal.accent;
    portal.pitchesDay.forEach((hz, i) => assert.ok(Math.abs(portal.pitchesNight[i] / hz - 0.75) < 0.002));
});

test('no tone sits in 500–700 Hz and no baked mode rings there beyond 150 ms', () => {
    for (const [phase, night] of PHASES) {
        for (const spec of workshopTakeSpecs({ night })) {
            assert.ok(spec.tone < 500 || spec.tone > 700, `${spec.key} tone ${spec.tone} Hz`);
            for (const m of tonalModes(spec.voice, spec.tone, { night })) {
                if (m.hi < 500 || m.lo > 700) continue;
                const t60 = 6.91 * m.tauMax;
                assert.ok(t60 <= 0.15, `${phase} ${spec.key}: mode ${Math.round(m.lo)}–${Math.round(m.hi)} Hz rings ${t60.toFixed(3)} s`);
            }
        }
    }
});

test('metal voices never ring below A6', () => {
    for (const [, night] of PHASES) {
        for (const spec of workshopTakeSpecs({ night })) {
            if (spec.voice !== 'ring' && spec.voice !== 'ratchet') continue;
            for (const m of tonalModes(spec.voice, spec.tone, { night })) {
                assert.ok(m.lo >= UNDER_A6, `${spec.key}: mode at ${Math.round(m.lo)} Hz`);
            }
        }
    }
});

test('round-robin variants are distinct takes and each take is reproducible', () => {
    setRngSeed(11);
    for (const [name, b] of Object.entries(WORKSHOP_VOICES)) {
        for (const kind of ['accent', 'ghost']) {
            const takes = [];
            for (let variant = 0; variant < b.variants; variant++) {
                const spec = takeSpec(name, { kind, variant });
                if (spec) takes.push({ spec, data: renderTake(spec) });
            }
            if (kind === 'ghost' && !b.ghostVoices.length) {
                assert.equal(takes.length, 0, `${name} has no ghosts`);
                continue;
            }
            assert.equal(new Set(takes.map(t => t.spec.key)).size, b.variants, `${name} ${kind}: one key per variant`);
            for (let i = 0; i < takes.length; i++) {
                for (let j = i + 1; j < takes.length; j++) {
                    const a = takes[i].data, c = takes[j].data;
                    let dot = 0, ea = 0, ec = 0;
                    for (let n = 0; n < Math.min(a.length, c.length); n++) { dot += a[n] * c[n]; ea += a[n] * a[n]; ec += c[n] * c[n]; }
                    const corr = dot / Math.sqrt(ea * ec);
                    assert.ok(corr < 0.98, `${name} ${kind} variants ${i}/${j} correlate ${corr.toFixed(3)}`);
                }
            }
            assert.deepEqual(renderTake(takes[0].spec), takes[0].data, `${name} ${kind}: same seed, same take`);
        }
    }
    setRngSeed(null);
});

test('every take peaks at 1, ends 60 dB down and reports its loud window inside its ring', () => {
    setRngSeed(3);
    for (const [, night] of PHASES) {
        for (const spec of workshopTakeSpecs({ night })) {
            const data = renderTake(spec);
            const m = measureTake(data);
            const seconds = data.length / WORKSHOP_BAKE_RATE;
            assert.ok(Math.abs(m.peak - 1) < 1e-6, `${spec.key} peak ${m.peak}`);
            assert.ok(m.truePeak >= m.peak && m.truePeak < Math.pow(10, 2 / 20), `${spec.key} true peak ${m.truePeak}`);
            assert.ok(Math.abs(data[data.length - 1]) < 1e-3, `${spec.key} ends at ${data[data.length - 1]}`);
            assert.ok(m.loudSec > 0 && m.loudSec <= m.ringSec && m.ringSec <= seconds, `${spec.key} loud ${m.loudSec} ring ${m.ringSec} of ${seconds}`);
        }
    }
    setRngSeed(null);
});

test('both phases of takes fit the workshop memory budget', () => {
    setRngSeed(5);
    const bytes = new Map();
    for (const [, night] of PHASES) {
        for (const spec of workshopTakeSpecs({ night })) bytes.set(spec.key, renderTake(spec).length * 4);
    }
    const total = [...bytes.values()].reduce((s, b) => s + b, 0);
    assert.ok(total <= MEMORY_BUDGET[WORKSHOP_BANK_CLIENT], `${(total / 1048576).toFixed(2)} MiB > ${MEMORY_BUDGET[WORKSHOP_BANK_CLIENT] / 1048576} MiB`);
    setRngSeed(null);
});

// A bank whose idle slices run when pumped, on a context that only makes buffers.
function testBank(budget) {
    const idle = [];
    const context = {
        createBuffer(channels, length, sampleRate) {
            let data = new Float32Array(length);
            return { numberOfChannels: channels, length, sampleRate, copyToChannel(d) { data = Float32Array.from(d); }, getChannelData: () => data };
        },
    };
    const bank = new SampleBank({ context }, {
        budget,
        idle: (fn) => { idle.push(fn); return idle.length; },
        cancelIdle: () => {},
    });
    const pump = () => { while (idle.length) idle.shift()({ timeRemaining: () => 50 }); };
    return { bank, pump };
}

test('the phase set bakes in idle slices; a take not yet baked is skipped and queued', async () => {
    setRngSeed(9);
    const { bank, pump } = testBank({ totalBytes: 64 * 1048576, workshop: 16 * 1048576 });
    const baked = bakeWorkshopTakes(bank, { night: false });
    assert.equal(takeFor(bank, 'forge', { kind: 'accent', pitchIndex: 1 }), null, 'nothing waits on a bake');
    pump();
    assert.equal(await baked, true);
    const specs = workshopTakeSpecs({ night: false });
    assert.ok(specs.every(s => bank.has(s.key)));
    assert.equal(await bakeWorkshopTakes(bank, { night: false }), true, 'a second call has nothing to do');

    const accent = takeInfo(bank, 'forge', { kind: 'accent', pitchIndex: 2, variant: 7 });
    assert.equal(accent.tone, noteHz('C#7'));
    assert.equal(accent.variant, 1, 'variants wrap');
    assert.equal(accent.buffer.sampleRate, WORKSHOP_BAKE_RATE);
    assert.equal(takeInfo(bank, 'forge', { kind: 'ghost', pitchIndex: 3 }).tone, noteHz('B6'), 'ghosts ignore the slot');
    assert.equal(takeInfo(bank, 'taskboard', { kind: 'accent', voice: 'chalk' }).voice, 'chalk');
    assert.equal(takeFor(bank, 'mine', { kind: 'ghost' }), null, 'the Mine strikes accents only');
    assert.equal(takeFor(bank, 'lighthouse', {}), null);

    // Night: a flipped slot is not resident until its phase bakes; asking queues it.
    assert.equal(takeFor(bank, 'forge', { kind: 'accent', pitchIndex: 3, night: true }), null);
    pump();
    assert.equal(takeInfo(bank, 'forge', { kind: 'accent', pitchIndex: 3, night: true }).tone, noteHz('G7'));
    setRngSeed(null);
});

test('under a tight budget the LRU evicts old takes; a miss is skipped and re-baked on demand', async () => {
    setRngSeed(9);
    const { bank, pump } = testBank({ totalBytes: 64 * 1048576, workshop: 512 * 1024 });
    const baked = bakeWorkshopTakes(bank, { night: false });
    pump();
    assert.equal(await baked, false, 'the phase set cannot all stay resident in 0.5 MiB');
    assert.ok(bank.ledger.clientBytes(WORKSHOP_BANK_CLIENT) <= 512 * 1024);
    const opts = { kind: 'accent', pitchIndex: 0, variant: 0 };
    assert.equal(bank.has(takeSpec('forge', opts).key), false, 'the least recently used take went first');
    assert.equal(takeFor(bank, 'forge', opts), null);
    pump();
    assert.ok(takeFor(bank, 'forge', opts));
    setRngSeed(null);
});
