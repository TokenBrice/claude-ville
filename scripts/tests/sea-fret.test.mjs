import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { SEA_FRET_LAND_SHARE, SEA_FRET_THIN_FOG, seaFretLandShare, seaFretMistShare } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { GPU_RECORD_FLAGS, assignGpuRecordV9Fields } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');

// LA-7 — sea fret: the fog banks lie full on the water and thin over land.
// At look strength 0 the banks are today's (share 1, no flag); at 1 the land
// keeps SEA_FRET_LAND_SHARE of them.
test('the sea fret thins the banks over land by the la7 strength, and only then', () => {
    try {
        setLookStrength('la7', 0);
        assert.equal(seaFretLandShare(), 1);
        setLookStrength('la7', 0.5);
        assert.ok(Math.abs(seaFretLandShare() - (1 + SEA_FRET_LAND_SHARE) / 2) < 1e-9);
        setLookStrength('la7', 1);
        assert.equal(seaFretLandShare(), SEA_FRET_LAND_SHARE);
        assert.ok(SEA_FRET_LAND_SHARE > 0 && SEA_FRET_LAND_SHARE < 1, 'the land keeps some fog: thinned, never cleared');
    } finally {
        resetLookStrengths();
    }
});

// Every overcast knot carries fog 0.06–0.10 (preset 0.08 × 0.78–1.22), which
// laid the lowest bucket of banks over the open sea as camouflage blotches.
// With the sea fret on, that thin mist fades out; real fog keeps its banks.
test('the thin overcast mist fades out under la7 while real fog keeps its banks', () => {
    const overcast = { type: 'overcast', fog: 0.08 };
    try {
        setLookStrength('la7', 0);
        for (const weather of [overcast, { type: 'overcast', fog: 0.02 }, { type: 'rain', fog: 0.14 }, { type: 'fog', fog: 0.78 }]) {
            assert.equal(seaFretMistShare(weather), 1, `${weather.type} ${weather.fog}: today's banks at strength 0`);
        }
        setLookStrength('la7', 1);
        assert.equal(seaFretMistShare(overcast), 0);
        assert.equal(seaFretMistShare({ type: 'overcast', fog: 0.0976 }), 0, 'the thickest overcast knot is still mist');
        assert.equal(seaFretMistShare({ type: 'overcast', fog: 0 }), 0, 'a dry overcast mist too');
        assert.equal(seaFretMistShare({ type: 'rain', fog: 0.109 }), 1, 'the thinnest rain knot keeps its banks');
        assert.equal(seaFretMistShare({ type: 'storm', fog: 0.18 }), 1);
        assert.equal(seaFretMistShare({ type: 'fog', fog: 0.05 }), 1, 'fog weather always lays banks');
        assert.ok(SEA_FRET_THIN_FOG < 0.14 * 0.78 && SEA_FRET_THIN_FOG >= 0.08 * 1.22, 'the line falls between the overcast and rain presets');
        setLookStrength('la7', 0.5);
        assert.equal(seaFretMistShare(overcast), 0.5);
    } finally {
        resetLookStrengths();
    }
});

test('a sea-fret fog record packs its own flag bit, and an even bank packs none', () => {
    assert.equal(GPU_RECORD_FLAGS.seaFret, 1024);
    assert.equal(new Set(Object.values(GPU_RECORD_FLAGS)).size, Object.keys(GPU_RECORD_FLAGS).length, 'one bit per meaning');
    const fret = assignGpuRecordV9Fields({}, { id: 'ground:fog', seaFret: true }, 0.4, 'normal');
    assert.equal(fret.flags, GPU_RECORD_FLAGS.seaFret);
    const even = assignGpuRecordV9Fields({}, { id: 'ground:fog', seaFret: false }, 1, 'normal');
    assert.equal(even.flags, 0);
});

// All three paths cut the same land: the coast field's `water` and not
// `covered` cells keep the full bank; the lattice's outside is the sea.
test('the GLSL, WGSL and Canvas fog passes share one sea-fret mask', () => {
    const glsl = read('gpu/GpuWorldRenderer.js');
    assert.match(glsl, /float seaFretAlpha\(vec2 world, float landShare\) \{\n\s+float sd;\n\s+uint flags;\n\s+if \(!coastFieldAt\(world, sd, flags\)\) return 1\.0;/);
    assert.match(glsl, /\(v_flags & \$\{GPU_RECORD_FLAGS\.seaFret\}u\) != 0u \? seaFretAlpha\(v_world, v_alpha\) : v_alpha/);
    const wgsl = read('gpu/wgsl/scene.js');
    assert.match(wgsl, /fn seaFretAlpha\(world: vec2f, landShare: f32\) -> f32 \{/);
    assert.match(wgsl, /if \(\(v_flags & RECORD_FLAG_SEA_FRET\) != 0u\) \{ recordAlpha = seaFretAlpha\(v_world, v_alpha\); \}/);
    for (const source of [glsl, wgsl]) {
        assert.match(source, /\(flags & \$\{COAST_FIELD_FLAGS\.water\}u\) != 0u && \(flags & \$\{COAST_FIELD_FLAGS\.covered\}u\) == 0u/);
    }
    const frame = read('WorldFrameRenderer.js');
    assert.match(frame, /record\.alpha = layer\.landShare;\n\s+record\.seaFret = layer\.landShare < 1;/);
    assert.match(frame, /fctx\.globalCompositeOperation = 'destination-out';\n\s+fctx\.globalAlpha = 1 - layer\.landShare;\n\s+fctx\.drawImage\(groundMaskFor\(fields\)/);
    // The Canvas cut is the pool mask's ground: every cell but open water.
    assert.match(read('CanvasPoolMask.js'), /if \(\(flags & COAST_FIELD_FLAGS\.water\) && !\(flags & COAST_FIELD_FLAGS\.covered\)\) continue;/);
});
