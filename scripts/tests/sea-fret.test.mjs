import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { SEA_FRET_LAND_SHARE, seaFretLandShare } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
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
