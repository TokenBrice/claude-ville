import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import {
    CANONICAL_BAYER4_RANKS,
    FRESNEL_COURSE_WEIGHTS,
    MIRROR_SOURCE_FLAG,
    PLANAR_BED_MAX_BYTES,
    PLANAR_BED_MAX_STRIP_HEIGHT,
    PLANAR_BED_MIN_STRIP_HEIGHT,
    PLANAR_CLEAR_COLOR,
    PLANAR_CLEAR_DEPTH,
    PLANAR_COLOR_BYTES,
    PLANAR_COLOR_FORMAT,
    PLANAR_DEPTH_BYTES,
    PLANAR_DEPTH_FORMAT,
    PLANAR_HEIGHT,
    PLANAR_MIRROR_BYTES,
    PLANAR_MIRROR_CAPTURE_WGSL,
    PLANAR_WATER_RESOLVE_BINDING,
    PLANAR_WATER_RESOLVE_WGSL,
    PLANAR_WIDTH,
    SRGB8_TO_LINEAR16,
    WATER_RECEIVER_ENCODED_LUMA_MAX,
    WATER_RECEIVER_LINEAR_LUMA_MAX,
    PlanarWaterPass,
    alphaByteToWeight,
    applyWaterReceiverGuardByte,
    bayer4Rank,
    bayerCollarSelect,
    collarDistance,
    computeRippleShift,
    createPlanarWaterPass,
    filterMirrorRecords,
    fresnelWeightForCourse,
    geometricDepth,
    isMirrorAdmittedRecord,
    linear16ToSrgb8,
    mix256,
    mix256rgb,
    projectPlanarBasinRect,
    reflectWorldHeight,
    reflectWorldY,
    resolvePlanarWaterTexel,
    roundHalfAwayFromZero,
    selectPlanarBedStripHeight,
    skyCourseAt,
    srgb8ToLinear16,
    waterChannel,
} from '../../claudeville/src/presentation/character-mode/gpu/wgpu/PlanarWaterPass.js';
import {
    RIPPLE_BOUNDARY_BYTES,
    RIPPLE_BOUNDARY_FORMAT,
    RIPPLE_COMPUTE_BINDING,
    RIPPLE_DEFAULT_COURANT,
    RIPPLE_FIXED_DT,
    RIPPLE_GRID_HEIGHT,
    RIPPLE_GRID_WIDTH,
    RIPPLE_HZ,
    RIPPLE_IMPULSE_KINDS,
    RIPPLE_MAX_COURANT,
    RIPPLE_MAX_STEPS_PER_FRAME,
    RIPPLE_PINGPONG_BYTES,
    RIPPLE_STATE_FORMAT,
    RIPPLE_TOTAL_TEXTURE_BYTES,
    WATER_RIPPLE_COMPUTE_WGSL,
    WaterRippleCompute,
    collectRainRippleImpulses,
    computeRippleEnergyCpu,
    computeWetRippleBounds,
    createRippleFieldCpu,
    createWaterRippleCompute,
    intersectRainCellsWithRippleGrid,
    rainCellHash,
    setBoundaryWallCpu,
    stepRippleFieldCpu,
} from '../../claudeville/src/presentation/character-mode/gpu/wgpu/WaterRippleCompute.js';
import {
    HARBOR_BASE_PATH,
    HARBOR_UNDERSIDE_META,
    HARBOR_UNDERSIDE_PATH,
    inspectUndersidePng,
} from '../sprites/bake-harbor-underside.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function createMockWebGpuDevice() {
    const textures = [];
    const buffers = [];
    const bindGroups = [];
    const renderPasses = [];
    const computePasses = [];
    const writes = [];

    const device = {
        textures,
        buffers,
        bindGroups,
        renderPasses,
        computePasses,
        writes,
        createTexture(desc) {
            const tex = {
                ...desc,
                destroyed: false,
                createView(viewDesc = {}) {
                    return { texture: tex, ...viewDesc };
                },
                destroy() {
                    this.destroyed = true;
                },
            };
            textures.push(tex);
            return tex;
        },
        createBuffer(desc) {
            const buf = {
                ...desc,
                destroyed: false,
                destroy() {
                    this.destroyed = true;
                },
            };
            buffers.push(buf);
            return buf;
        },
        createSampler(desc) {
            return { ...desc };
        },
        createBindGroupLayout(desc) {
            return { ...desc };
        },
        createPipelineLayout(desc) {
            return { ...desc };
        },
        createShaderModule(desc) {
            return {
                ...desc,
                async getCompilationInfo() {
                    return { messages: [] };
                },
            };
        },
        async createRenderPipelineAsync(desc) {
            return { kind: 'render', ...desc };
        },
        async createComputePipelineAsync(desc) {
            return { kind: 'compute', ...desc };
        },
        createBindGroup(desc) {
            const bg = { ...desc };
            bindGroups.push(bg);
            return bg;
        },
        queue: {
            writeBuffer(buffer, offset, data, dataOffset, size) {
                writes.push({ kind: 'buffer', buffer, offset, size: size ?? data?.byteLength ?? 0 });
            },
            writeTexture(dst, data, layout, size) {
                writes.push({ kind: 'texture', dst, byteLength: data?.byteLength ?? 0, layout, size });
            },
        },
    };

    const encoder = {
        beginRenderPass(desc) {
            const pass = {
                desc,
                pipelines: [],
                bindGroups: [],
                draws: [],
                scissors: [],
                ended: false,
                setPipeline(p) { this.pipelines.push(p); },
                setBindGroup(slot, bg) { this.bindGroups.push({ slot, bg }); },
                setVertexBuffer() {},
                setScissorRect(x, y, w, h) { this.scissors.push([x, y, w, h]); },
                setViewport() {},
                draw(...args) { this.draws.push(args); },
                end() { this.ended = true; },
            };
            renderPasses.push(pass);
            return pass;
        },
        beginComputePass(desc) {
            const pass = {
                desc,
                pipelines: [],
                bindGroups: [],
                dispatches: [],
                ended: false,
                setPipeline(p) { this.pipelines.push(p); },
                setBindGroup(slot, bg) { this.bindGroups.push({ slot, bg }); },
                dispatchWorkgroups(x, y, z) { this.dispatches.push([x, y, z]); },
                end() { this.ended = true; },
            };
            computePasses.push(pass);
            return pass;
        },
    };

    return { device, encoder };
}

function assertBalancedDelimiters(source, label) {
    let curly = 0;
    let paren = 0;
    let bracket = 0;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') curly++;
        else if (ch === '}') curly--;
        else if (ch === '(') paren++;
        else if (ch === ')') paren--;
        else if (ch === '[') bracket++;
        else if (ch === ']') bracket--;
        assert.ok(curly >= 0, `${label}: unexpected '}' at ${i}`);
        assert.ok(paren >= 0, `${label}: unexpected ')' at ${i}`);
        assert.ok(bracket >= 0, `${label}: unexpected ']' at ${i}`);
    }
    assert.equal(curly, 0, `${label}: unbalanced '{' / '}'`);
    assert.equal(paren, 0, `${label}: unbalanced '(' / ')'`);
    assert.equal(bracket, 0, `${label}: unbalanced '[' / ']'`);
}

// ------------------------------------------------------------ Spec 01 §5 oracle

test('W5-A: Spec 01 §5 oracle — memory budgets, Bayer collar d=0..8, mix256 & waterChannel across all 4 courses', () => {
    // Exact memory budgets
    assert.equal(PLANAR_WIDTH, 1024);
    assert.equal(PLANAR_HEIGHT, 512);
    assert.equal(PLANAR_COLOR_FORMAT, 'rgba8unorm');
    assert.equal(PLANAR_DEPTH_FORMAT, 'depth32float');
    assert.equal(PLANAR_COLOR_BYTES, 2_097_152);
    assert.equal(PLANAR_DEPTH_BYTES, 2_097_152);
    assert.equal(PLANAR_MIRROR_BYTES, 4_194_304);
    assert.equal(2 * (1024 * 512 * 4), PLANAR_MIRROR_BYTES);

    assert.equal(RIPPLE_GRID_WIDTH, 256);
    assert.equal(RIPPLE_GRID_HEIGHT, 256);
    assert.equal(RIPPLE_STATE_FORMAT, 'rgba16float');
    assert.equal(RIPPLE_BOUNDARY_FORMAT, 'rgba8unorm');
    assert.equal(RIPPLE_PINGPONG_BYTES, 1_048_576);
    assert.equal(2 * (256 * 256 * 8), RIPPLE_PINGPONG_BYTES);
    assert.equal(RIPPLE_BOUNDARY_BYTES, 262_144);
    assert.equal(RIPPLE_TOTAL_TEXTURE_BYTES, 1_310_720);

    // Canonical Bayer ranks
    assert.deepEqual(
        Array.from(CANONICAL_BAYER4_RANKS),
        [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5],
    );
    assert.deepEqual(Array.from(FRESNEL_COURSE_WEIGHTS), [128, 112, 96, 80]);
    for (let k = 0; k < 4; k++) {
        assert.equal(fresnelWeightForCourse(k), 128 - 16 * k);
    }

    // Spec 01 §5 lines 283-289: exact integer mix256 identities
    for (const f of [80, 96, 112, 128]) {
        const bed = 9000;
        const sky = 45000;
        const hit = 20000;
        assert.equal(mix256(bed, mix256(sky, hit, 0), f), mix256(bed, sky, f));
        assert.equal(mix256(bed, mix256(sky, hit, 256), f), mix256(bed, hit, f));
        assert.equal(mix256(bed, mix256(bed, hit, 0), f), bed);
    }

    // Spec 01 §5 lines 306-317: Bayer collar & waterChannel across all 16 ranks and 4 courses
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            const rank = bayer4Rank(x, y);
            const expectedRank = CANONICAL_BAYER4_RANKS[y * 4 + x];
            assert.equal(rank, expectedRank);
            assert.equal(bayerCollarSelect(0, x, y), false);
            assert.equal(bayerCollarSelect(8, x, y), true);
            for (let d = 0; d <= 8; d++) {
                assert.equal(bayerCollarSelect(d, x, y), (2 * rank + 1) < (4 * d));
            }
            for (const f of [80, 96, 112, 128]) {
                const resolve = (contact, live, d, w = 256) => (
                    waterChannel(9000, 45000, w, contact, live, bayerCollarSelect(d, x, y), f)
                );
                assert.equal(resolve([20000, 255], [30000, 255], 0), mix256(9000, 20000, f));
                assert.equal(resolve([20000, 255], [30000, 255], 8), mix256(9000, 30000, f));
                assert.equal(resolve([20000, 255], [30000, 0], 8), mix256(9000, 45000, f));
                assert.equal(resolve([20000, 255], [30000, 0], 8, 0), 9000);
            }
        }
    }

    // Collar pass counts strictly increase by 2 ranks per texel across d = 0..8
    for (let d = 0; d <= 8; d++) {
        let passes = 0;
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                if (bayerCollarSelect(d, x, y)) passes++;
            }
        }
        assert.equal(passes, d * 2, `collar d=${d} should select ${d * 2}/16 Bayer ranks`);
    }

    // sRGB8 <-> linear Q16 exact 256-entry round-trip + alphaByteToWeight
    assert.equal(SRGB8_TO_LINEAR16.length, 256);
    assert.equal(SRGB8_TO_LINEAR16[0], 0);
    assert.equal(SRGB8_TO_LINEAR16[255], 65535);
    for (let byte = 0; byte < 256; byte++) {
        assert.equal(linear16ToSrgb8(srgb8ToLinear16(byte)), byte, `round-trip byte ${byte}`);
    }
    assert.equal(alphaByteToWeight(0), 0);
    assert.equal(alphaByteToWeight(255), 256);
    assert.deepEqual(mix256rgb([9000, 12000, 15000], [45000, 30000, 15000], 128), [27000, 21000, 15000]);
});

// -------------------------------------------------- Reflected geometry & filter

test('W5-A: reflected geometry H\'=2Z-H, sy\'=sy+2(H-Z) & mirror admission filter', () => {
    // Foot at waterline maps to itself
    assert.equal(reflectWorldHeight(0, 0), 0);
    assert.equal(reflectWorldY(200, 0, 0), 200);
    assert.equal(reflectWorldHeight(-6, -6), -6);
    assert.equal(reflectWorldY(200, -6, -6), 200);

    // Pier deck 12 px above water Z = 0 shifts reflected position +24 px downward
    assert.equal(reflectWorldHeight(12, 0), -12);
    assert.equal(reflectWorldY(160, 12, 0), 184);
    assert.equal(reflectWorldHeight(16, -2), -20);
    assert.equal(reflectWorldY(160, 16, -2), 196);

    // Geometric depth stays strictly inside (0, 1)
    const dFar = geometricDepth(-1000);
    const dNear = geometricDepth(1000);
    assert.ok(dNear < dFar && dNear > 0 && dFar < 1);

    // Mirror admission filter: ONLY bit 19 (524288), never recursive reflect/marks/labels/cues
    assert.equal(MIRROR_SOURCE_FLAG, 524288);
    assert.equal(GPU_RECORD_FLAGS.mirrorSource, 524288);

    const candidates = [
        { id: 'harbor-pier', flags: MIRROR_SOURCE_FLAG, basinId: 1 },
        { id: 'boat-hull', reflectMirror: true, basinId: 1 },
        { id: 'villager', mirrorSource: true, basinId: 1 },
        { id: 'other-basin', flags: MIRROR_SOURCE_FLAG, basinId: 2 },
        { id: 'legacy-reflect', flags: MIRROR_SOURCE_FLAG | GPU_RECORD_FLAGS.reflect },
        { id: 'reflect-prop', reflect: 2, flags: MIRROR_SOURCE_FLAG },
        { id: 'screen-mark', flags: MIRROR_SOURCE_FLAG | GPU_RECORD_FLAGS.screenSpace },
        { id: 'action-mark', flags: MIRROR_SOURCE_FLAG | GPU_RECORD_FLAGS.actionMark },
        { id: 'cue-run', flags: MIRROR_SOURCE_FLAG | GPU_RECORD_FLAGS.cueRun },
        { id: 'label', flags: MIRROR_SOURCE_FLAG, kind: 'label' },
        { id: 'hud', flags: MIRROR_SOURCE_FLAG, role: 'hud' },
        { id: 'additive-glow', flags: MIRROR_SOURCE_FLAG, blend: 'add' },
        { id: 'unflagged-building', flags: GPU_RECORD_FLAGS.writesDepth },
    ];

    const admitted = filterMirrorRecords(candidates, { basinId: 1 });
    assert.deepEqual(admitted.map(r => r.id), ['harbor-pier', 'boat-hull', 'villager']);
    assert.equal(isMirrorAdmittedRecord({ flags: GPU_RECORD_FLAGS.reflect }), false);
    assert.equal(isMirrorAdmittedRecord(null), false);
});

// ------------------------------------------------- Synthetic piling mirror test

test('W5-A: synthetic piling mirror test — edge ring, live-hit, live-empty sky, W=0 night, ripple shift & role 0 guard', () => {
    // Spec 01 §3 synthetic fixture:
    //   - 1px white piling at x = 120 in live mirror
    //   - Black backdrop bed [0, 0, 0]
    //   - Solid magenta sky [255, 0, 255]
    //   - Transparent hole (alpha = 0) everywhere else in live mirror
    //   - Red authored contact [255, 0, 0] (alpha = 255)
    //   - Mirror tile rect crossing open water: left=100, top=100, width=64, height=48
    const rect = { left: 100, top: 100, width: 64, height: 48 };
    const blackBed = [0, 0, 0];
    const magentaSky = [255, 0, 255];
    const redContact = [255, 0, 0];
    const whitePiling = [255, 255, 255];
    const pilingX = 120;

    const liveSampleAt = (x, _y) => (
        x === pilingX
            ? { rgb8: whitePiling, alphaByte: 255 }
            : { rgb8: [0, 0, 0], alphaByte: 0 }
    );

    // 1. Edge ring (d = 0) equals authored fallback bit-for-bit around entire perimeter
    const borderPoints = [
        [rect.left, rect.top],
        [rect.left + 17, rect.top],
        [rect.left + rect.width - 1, rect.top],
        [rect.left, rect.top + 19],
        [rect.left + rect.width - 1, rect.top + 23],
        [rect.left, rect.top + rect.height - 1],
        [rect.left + 20, rect.top + rect.height - 1],
        [rect.left + rect.width - 1, rect.top + rect.height - 1],
    ];
    for (const [bx, by] of borderPoints) {
        assert.equal(collarDistance(bx, by, rect), 0);
        const withMirror = resolvePlanarWaterTexel({
            x: bx, y: by,
            bedRgb8: blackBed,
            skyFarRgb8: magentaSky,
            skyShare: 1,
            contactRgb8: redContact,
            contactAlpha: 255,
            liveSampleAt,
            planarRect: rect,
            mirrorAvailable: true,
            applyGuard: false,
        });
        const fallbackOnly = resolvePlanarWaterTexel({
            x: bx, y: by,
            bedRgb8: blackBed,
            skyFarRgb8: magentaSky,
            skyShare: 1,
            contactRgb8: redContact,
            contactAlpha: 255,
            liveSampleAt: null,
            planarRect: rect,
            mirrorAvailable: false,
            applyGuard: false,
        });
        assert.equal(withMirror.useLive, false);
        assert.deepEqual(withMirror.rgb8, fallbackOnly.rgb8);
        assert.deepEqual(withMirror.linear16, fallbackOnly.linear16);
    }

    // 2. Interior (d >= 8) live-hit on 1px white piling supersedes red contact & magenta sky
    const hitY = rect.top + 16;
    assert.ok(collarDistance(pilingX, hitY, rect) >= 8);
    const liveHit = resolvePlanarWaterTexel({
        x: pilingX, y: hitY,
        bedRgb8: blackBed,
        skyFarRgb8: magentaSky,
        skyShare: 1,
        contactRgb8: redContact,
        contactAlpha: 255,
        liveSampleAt,
        planarRect: rect,
        courseOverride: 0, // F = 128/256 = 0.5
        applyGuard: false,
    });
    assert.equal(liveHit.useLive, true);
    const expectedWhiteHalf = mix256(0, 65535, 128);
    assert.deepEqual(liveHit.linear16, [expectedWhiteHalf, expectedWhiteHalf, expectedWhiteHalf]);
    assert.equal(liveHit.rgb8[0], liveHit.rgb8[1]);
    assert.equal(liveHit.rgb8[1], liveHit.rgb8[2]);

    // 3. Interior transparent hole (live-empty alpha=0) falls back to magenta sky, NOT red contact!
    const holeX = pilingX + 5;
    const liveHole = resolvePlanarWaterTexel({
        x: holeX, y: hitY,
        bedRgb8: blackBed,
        skyFarRgb8: magentaSky,
        skyShare: 1,
        contactRgb8: redContact,
        contactAlpha: 255,
        liveSampleAt,
        planarRect: rect,
        courseOverride: 0,
        applyGuard: false,
    });
    assert.equal(liveHole.useLive, true);
    assert.deepEqual(liveHole.linear16, [expectedWhiteHalf, 0, expectedWhiteHalf], 'transparent live texel must sample sky, not red authored contact');

    // 4. Deep night W = 0 preserves bed bit-for-bit on live-empty texel
    const nightBed = [28, 45, 58];
    const deepNight = resolvePlanarWaterTexel({
        x: holeX, y: hitY,
        bedRgb8: nightBed,
        skyFarRgb8: magentaSky,
        skyShare: 0,
        contactRgb8: redContact,
        contactAlpha: 255,
        liveSampleAt,
        planarRect: rect,
        courseOverride: 1,
        applyGuard: false,
    });
    assert.equal(deepNight.useLive, true);
    assert.deepEqual(deepNight.rgb8, nightBed, 'W = 0 deep night must preserve clean bed on empty live ray');

    // 5. Ripple horizontal shift clamping, contact-row damping, basin/rect rejection & reducedMotion freeze
    assert.equal(roundHalfAwayFromZero(0.5), 1);
    assert.equal(roundHalfAwayFromZero(-0.5), -1);
    assert.equal(computeRippleShift({ slopeX: 2.0, contactRow: 0, x: 120, y: 120, rect }), 0);
    assert.equal(computeRippleShift({ slopeX: 2.0, contactRow: 1, x: 120, y: 120, rect }), 1);
    assert.equal(computeRippleShift({ slopeX: -2.0, contactRow: 2, x: 120, y: 120, rect }), -1);
    assert.equal(computeRippleShift({ slopeX: 5.0, contactRow: 5, x: 120, y: 120, rect }), 2);
    assert.equal(computeRippleShift({ slopeX: -5.0, contactRow: 5, x: 120, y: 120, rect }), -2);
    // Reject outside valid rect -> retries unshifted (0)
    assert.equal(computeRippleShift({ slopeX: -2.0, contactRow: 5, x: rect.left, y: 120, rect }), 0);
    // Reject cross-basin shift -> retries unshifted (0)
    assert.equal(
        computeRippleShift({
            slopeX: 2.0,
            contactRow: 5,
            x: 120,
            y: 120,
            rect,
            basinId: 1,
            basinAt: (sx) => (sx > 120 ? 2 : 1),
        }),
        0,
    );
    // Reduced motion freezes displacement to 0
    assert.equal(computeRippleShift({ slopeX: 2.0, contactRow: 5, x: 120, y: 120, rect, reducedMotion: true }), 0);

    // 6. Strict role 0 receiver guard enforces emission=0, roleAlpha=0, linearLuma<=0.70, encodedY<=0.74
    for (const [r, g, b] of [[255, 255, 255], [255, 0, 255], [255, 240, 120], [10, 250, 250]]) {
        const guarded = applyWaterReceiverGuardByte([r, g, b], 0.44);
        assert.deepEqual(guarded.emission, [0, 0, 0]);
        assert.equal(guarded.roleAlpha, 0);
        assert.ok(guarded.linearLuma <= WATER_RECEIVER_LINEAR_LUMA_MAX + 1e-6, `linearLuma ${guarded.linearLuma} > 0.70`);
        assert.ok(guarded.encodedLuma <= WATER_RECEIVER_ENCODED_LUMA_MAX + 1e-6, `encodedLuma ${guarded.encodedLuma} > 0.74`);
        assert.ok(guarded.hsvS <= 0.44 + 1e-6, `hsvS ${guarded.hsvS} > 0.44`);
    }

    // Sky course monotonicity from offshore horizon to near map
    assert.equal(skyCourseAt(0, -144), 0);
    assert.equal(skyCourseAt(0, 1264), 3);
});

// -------------------------------------------------- WaterRippleCompute tests

test('W5-A: WaterRippleCompute — 300-step stability, Courant bound, zero-normal wall reflection, catch-up cap & reducedMotion', () => {
    // 1. 300-step stability on a 48x48 basin with multiple impulses and over-Courant input clamped to 0.5
    const field = createRippleFieldCpu(48, 48);
    // Add solid stone wall across x = 40
    for (let y = 0; y < 48; y++) setBoundaryWallCpu(field, 40, y, true);

    const impulses = [
        { x: 24, y: 24, radius: 3, strength: 0.8, kind: RIPPLE_IMPULSE_KINDS.boat },
        { x: 12, y: 16, radius: 2, strength: 0.5, kind: RIPPLE_IMPULSE_KINDS.rain },
        { x: 30, y: 32, radius: 4, strength: 0.6, kind: RIPPLE_IMPULSE_KINDS.spillway },
    ];

    const first = stepRippleFieldCpu(field, { impulses, courant: 0.99, damping: 0.985 });
    assert.equal(first.stepped, true);
    assert.equal(first.hasNaN, false);
    assert.ok(first.energy > 0);
    const peakInitialEnergy = first.energy;

    let maxHeightSeen = first.maxAbsHeight;
    let lastStats = first;
    for (let step = 1; step < 300; step++) {
        // Requesting courant > 0.5 must clamp strictly to <= 0.5 and stay stable
        lastStats = stepRippleFieldCpu(field, { courant: 0.99, damping: 0.985 });
        assert.equal(lastStats.hasNaN, false, `NaN detected at step ${step}`);
        assert.ok(Number.isFinite(lastStats.energy), `non-finite energy at step ${step}`);
        assert.ok(lastStats.maxAbsHeight <= 4.0, `unbounded height ${lastStats.maxAbsHeight} at step ${step}`);
        if (lastStats.maxAbsHeight > maxHeightSeen) maxHeightSeen = lastStats.maxAbsHeight;
    }
    assert.ok(lastStats.energy < peakInitialEnergy * 0.25, `wave energy should damp cleanly over 300 steps (start=${peakInitialEnergy}, end=${lastStats.energy})`);
    // Solid wall cells must remain strictly zero throughout
    for (let y = 0; y < 48; y++) {
        const o = (y * 48 + 40) * 4;
        assert.equal(field.prev[o], 0, `solid wall leaked non-zero height at y=${y}`);
        assert.equal(field.prev[o + 2], 0, `solid wall leaked non-zero slope at y=${y}`);
    }

    // 2. Zero-normal wall reflection (Neumann BC: positive wave reflects with positive sign, zero leakage through wall)
    const wallField = createRippleFieldCpu(24, 16);
    for (let y = 0; y < 16; y++) setBoundaryWallCpu(wallField, 14, y, true);
    stepRippleFieldCpu(wallField, {
        impulses: [{ x: 11.5, y: 8.5, radius: 2.0, strength: 1.0, kind: 'wake' }],
        courant: RIPPLE_DEFAULT_COURANT,
        damping: 1.0, // undamped to inspect pure Neumann reflection
    });
    let hitWallAdjacent = false;
    for (let step = 0; step < 25; step++) {
        const res = stepRippleFieldCpu(wallField, { courant: RIPPLE_DEFAULT_COURANT, damping: 1.0 });
        assert.equal(res.hasNaN, false);
        const hAdj = wallField.prev[(8 * 24 + 13) * 4];
        const hWall = wallField.prev[(8 * 24 + 14) * 4];
        const hBehind = wallField.prev[(8 * 24 + 15) * 4];
        assert.equal(hWall, 0, 'wall cell must remain zero');
        assert.equal(hBehind, 0, 'wave must not penetrate across solid wall');
        if (hAdj > 0.1) hitWallAdjacent = true;
    }
    assert.equal(hitWallAdjacent, true, 'positive wave crest must reflect off Neumann solid wall');

    // 3. Reduced motion freezes CPU stepper bit-for-bit
    const snapshot = new Float32Array(wallField.prev);
    const frozenRes = stepRippleFieldCpu(wallField, {
        impulses: [{ x: 6, y: 6, radius: 2, strength: 1.0 }],
        reducedMotion: true,
    });
    assert.equal(frozenRes.stepped, false);
    assert.deepEqual(wallField.prev, snapshot);

    // 4. Accumulator: 30 Hz cadence, catch-up cap <= 2, visibility reset, reducedMotion freeze
    const sim = createWaterRippleCompute();
    assert.equal(RIPPLE_HZ, 30);
    assert.equal(RIPPLE_MAX_COURANT, 0.5);
    assert.equal(RIPPLE_MAX_STEPS_PER_FRAME, 2);
    assert.equal(sim.stepAccumulator(RIPPLE_FIXED_DT * 0.5), 0);
    assert.equal(sim.stepAccumulator(RIPPLE_FIXED_DT * 0.6), 1);
    // Huge frame hitch (5 seconds) must cap strictly at 2 steps and drop backlog
    assert.equal(sim.stepAccumulator(5.0), 2);
    assert.equal(sim.getDiagnostics().clampedFrames, 1);
    assert.equal(sim.getDiagnostics().accumulatorSec, 0);
    // Visibility return resets accumulator and runs 0 steps
    assert.equal(sim.stepAccumulator(RIPPLE_FIXED_DT * 0.9), 0);
    assert.equal(sim.stepAccumulator(RIPPLE_FIXED_DT * 1.5, { visibilityReturned: true }), 0);
    assert.equal(sim.getDiagnostics().accumulatorSec, 0);
    assert.equal(sim.getDiagnostics().visibilityResets, 1);
    // Reduced motion freezes displacement (0 steps)
    assert.equal(sim.stepAccumulator(1.0, { reducedMotion: true }), 0);
    assert.equal(sim.getDiagnostics().frozen, true);
    // Sanity check computeRippleEnergyCpu helper
    const energy = computeRippleEnergyCpu(wallField);
    assert.equal(energy.hasNaN, false);
    assert.ok(energy.energy > 0);
});

// -------------------------------------------------- Mock WebGPU lifecycle tests

test('W5-A: WebGPU mock lifecycle for PlanarWaterPass & WaterRippleCompute (disjoint ping-pong, clear-to-transparent, release)', async () => {
    const { device, encoder } = createMockWebGpuDevice();

    // PlanarWaterPass prepare -> encode -> diagnostics -> release
    const planar = createPlanarWaterPass();
    assert.ok(planar instanceof PlanarWaterPass);
    await planar.prepare(device);
    const pDiag = planar.getDiagnostics();
    assert.equal(pDiag.ready, true);
    assert.equal(pDiag.allocatedBytes, 4_194_304);

    const encRes = planar.encode(encoder, {
        planarRect: [100, 100, 320, 240],
        waterZ: 0,
        basinId: 1,
        records: [
            { id: 'pier', flags: MIRROR_SOURCE_FLAG, basinId: 1 },
            { id: 'reflect-copy', flags: MIRROR_SOURCE_FLAG | GPU_RECORD_FLAGS.reflect, basinId: 1 },
            { id: 'mark', flags: MIRROR_SOURCE_FLAG | GPU_RECORD_FLAGS.screenSpace, basinId: 1 },
        ],
    });
    assert.equal(encRes.encoded, true);
    assert.equal(encRes.admitted, 1);
    assert.equal(encRes.rejected, 2);
    assert.equal(device.renderPasses.length, 1);
    assert.deepEqual(device.renderPasses[0].desc.colorAttachments[0].clearValue, PLANAR_CLEAR_COLOR);
    assert.equal(device.renderPasses[0].desc.depthStencilAttachment.depthClearValue, PLANAR_CLEAR_DEPTH);

    planar.release();
    assert.equal(planar.getDiagnostics().ready, false);
    assert.equal(planar.getDiagnostics().allocatedBytes, 0);

    // WaterRippleCompute prepare -> queueImpulse -> encode -> disjoint ping-pong -> reducedMotion -> release
    const ripple = createWaterRippleCompute();
    assert.ok(ripple instanceof WaterRippleCompute);
    await ripple.prepare(device);
    const rDiag = ripple.getDiagnostics();
    assert.equal(rDiag.ready, true);
    assert.equal(rDiag.pingPongBytes, 1_048_576);
    assert.equal(rDiag.boundaryBytes, 262_144);
    assert.equal(rDiag.allocatedBytes, 1_310_720);

    // Verify strictly disjoint ping-pong bind groups (binding 1 sampled !== binding 2 storage write)
    for (let i = 0; i < 2; i++) {
        const entries = ripple.bindGroups[i].entries;
        const prevEntry = entries.find(e => e.binding === RIPPLE_COMPUTE_BINDING.previousState);
        const nextEntry = entries.find(e => e.binding === RIPPLE_COMPUTE_BINDING.nextState);
        assert.notEqual(prevEntry.resource, nextEntry.resource, 'previous and next ripple views must be strictly disjoint');
    }

    assert.equal(ripple.queueImpulse({ x: 64, y: 64, radius: 3, strength: 0.4, kind: 'wake' }), true);
    const stepRes = ripple.encode(encoder, { dtSec: 0.25 }); // > 2 steps -> capped at 2!
    assert.equal(stepRes.encoded, true);
    assert.equal(stepRes.steps, 2);
    assert.equal(device.computePasses.length, 2);
    assert.deepEqual(device.computePasses[0].dispatches[0], [32, 32, 1]);

    // Reduced motion dispatches 0 compute passes
    const frozenStep = ripple.encode(encoder, { dtSec: 0.25, reducedMotion: true });
    assert.equal(frozenStep.steps, 0);
    assert.equal(frozenStep.frozen, true);
    assert.equal(device.computePasses.length, 2);

    ripple.release();
    assert.equal(ripple.getDiagnostics().ready, false);
    assert.equal(ripple.getDiagnostics().allocatedBytes, 0);
});

// ----------------------------------------- Harbor underside proxy & WGSL checks

test('W5-A: Harbor underside baker (--help, --check), PNG invariants (384x284, zero semi-alpha, dark luma) & WGSL syntax', () => {
    const helpRun = spawnSync(process.execPath, ['scripts/sprites/bake-harbor-underside.mjs', '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    assert.equal(helpRun.status, 0, helpRun.stderr);
    assert.match(helpRun.stdout, /--check/);

    const checkRun = spawnSync(process.execPath, ['scripts/sprites/bake-harbor-underside.mjs', '--check'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    assert.equal(checkRun.status, 0, `bake-harbor-underside --check failed:\n${checkRun.stderr}\n${checkRun.stdout}`);

    const underside = PNG.sync.read(readFileSync(HARBOR_UNDERSIDE_PATH));
    const base = PNG.sync.read(readFileSync(HARBOR_BASE_PATH));
    assert.equal(underside.width, 384);
    assert.equal(underside.height, 284);
    assert.deepEqual(Array.from(HARBOR_UNDERSIDE_META.anchor), [131, 154]);

    const stats = inspectUndersidePng(underside);
    assert.equal(stats.semiAlphaPixels, 0, 'underside.png must have zero semi-alpha pixels');
    assert.equal(stats.offPalettePixels, 0, 'underside.png must use strict ART_RAMPS timber/ashlar + #060402 palette');
    assert.ok(stats.uniqueColors > 0 && stats.uniqueColors <= 16, `expected <= 16 colors, got ${stats.uniqueColors}`);
    assert.ok(stats.opaquePixels > 10000, `expected full pier+quay underside coverage, got ${stats.opaquePixels} px`);
    assert.ok(stats.maxLinearLuma <= 0.20, `underside linear luminance ${stats.maxLinearLuma} must stay dark (zero bright highlights)`);
    assert.ok(stats.maxEncodedLuma <= 0.45, `underside encoded luma ${stats.maxEncodedLuma} must stay dark`);

    // Pixel-exact alignment: every opaque underside pixel must stay strictly inside base.png silhouette
    let outsideBase = 0;
    for (let i = 0; i < underside.data.length; i += 4) {
        if (underside.data[i + 3] > 0 && base.data[i + 3] === 0) outsideBase++;
    }
    assert.equal(outsideBase, 0, 'underside.png must align strictly within building.harbor/base.png footprint');

    // WGSL syntax & contract structure checks
    assertBalancedDelimiters(PLANAR_MIRROR_CAPTURE_WGSL, 'PLANAR_MIRROR_CAPTURE_WGSL');
    assertBalancedDelimiters(PLANAR_WATER_RESOLVE_WGSL, 'PLANAR_WATER_RESOLVE_WGSL');
    assertBalancedDelimiters(WATER_RIPPLE_COMPUTE_WGSL, 'WATER_RIPPLE_COMPUTE_WGSL');

    assert.match(PLANAR_MIRROR_CAPTURE_WGSL, /@vertex\s+fn\s+planarMirrorVs/);
    assert.match(PLANAR_MIRROR_CAPTURE_WGSL, /@fragment\s+fn\s+planarMirrorFs/);
    assert.match(PLANAR_MIRROR_CAPTURE_WGSL, /sy \+ 2\.0 \* \(h - z\)/);

    assert.match(PLANAR_WATER_RESOLVE_WGSL, /fn\s+mix256rgb\s*\(x:\s*vec3u,\s*y:\s*vec3u,\s*w:\s*u32\)\s*->\s*vec3u/);
    assert.match(PLANAR_WATER_RESOLVE_WGSL, /fn\s+bayerCollarSelect\s*\(/);
    assert.match(PLANAR_WATER_RESOLVE_WGSL, /\(2u \* bayer4RankAt\(p\) \+ 1u\) < \(4u \* dc\)/);
    assert.match(PLANAR_WATER_RESOLVE_WGSL, /out\.emission\s*=\s*vec4f\(0\.0,\s*0\.0,\s*0\.0,\s*0\.0\)/);
    assert.match(PLANAR_WATER_RESOLVE_WGSL, /@fragment\s+fn\s+planarWaterResolveFs/);
    for (const binding of Object.values(PLANAR_WATER_RESOLVE_BINDING)) {
        assert.match(PLANAR_WATER_RESOLVE_WGSL, new RegExp(`@group\\(1\\)\\s+@binding\\(${binding}\\)`));
    }

    assert.match(WATER_RIPPLE_COMPUTE_WGSL, /@compute\s+@workgroup_size\(8,\s*8,\s*1\)/);
    assert.match(WATER_RIPPLE_COMPUTE_WGSL, /fn\s+waterRippleMain/);
    assert.match(WATER_RIPPLE_COMPUTE_WGSL, /texture_storage_2d<rgba16float,\s*write>/);
    for (const binding of Object.values(RIPPLE_COMPUTE_BINDING)) {
        assert.match(WATER_RIPPLE_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${binding}\\)`));
    }
});

test('W5-A P3: storm rain impulse intersection matches brute-force cell coordinates and hash order bit-for-bit', () => {
    const boundary = new Uint8Array(RIPPLE_GRID_WIDTH * RIPPLE_GRID_HEIGHT * 4);
    for (let y = 30; y < 140; y++) {
        for (let x = 20; x < 180; x++) {
            boundary[(y * RIPPLE_GRID_WIDTH + x) * 4] = 255;
        }
    }
    const wetBounds = computeWetRippleBounds(boundary);
    assert.deepEqual(wetBounds, { minX: 20, maxX: 179, minY: 30, maxY: 139, empty: false });

    const rippleOrigin = [-896, 96];
    const rippleScale = 256 / 2176;
    const cellSize = 32;
    const layerCuts = { cut0: 0.34, cut1: 0.72 };

    const bruteForce = (uniforms, rainInstances, prevPhases) => {
        const out = [];
        const [ox, oy, cols] = uniforms;
        const rows = Math.ceil(rainInstances / cols);
        for (let cy = oy; cy < oy + rows; cy++) {
            for (let cx = ox; cx < ox + cols; cx++) {
                const seed = rainCellHash(Math.imul(cx + 32768, 0x8da6b343) ^ Math.imul(cy + 32768, 0xd8163841) ^ uniforms[3]);
                if (seed / 4294967296 >= uniforms[4]) continue;
                const pick = rainCellHash(seed ^ 0x68e31da4) / 4294967296;
                const layer = pick < layerCuts.cut0 ? 0 : pick < layerCuts.cut1 ? 1 : 2;
                const phase = uniforms[8 + layer];
                const impact = 1 - rainCellHash(seed + 3) / 4294967296;
                const previous = prevPhases?.[layer];
                if (previous == null || !((phase >= previous) ? impact > previous && impact <= phase : impact > previous || impact <= phase)) continue;
                const rx = cx * cellSize + Math.floor(rainCellHash(seed + 1) / 4294967296 * cellSize);
                const ry = cy * cellSize + Math.floor(rainCellHash(seed + 2) / 4294967296 * cellSize);
                const gx = Math.floor((rx - rippleOrigin[0]) * rippleScale);
                const gy = Math.floor((ry - rippleOrigin[1]) * rippleScale);
                if (gx < 0 || gy < 0 || gx >= RIPPLE_GRID_WIDTH || gy >= RIPPLE_GRID_HEIGHT) continue;
                if (!boundary[(gy * RIPPLE_GRID_WIDTH + gx) * 4]) continue;
                out.push([rx, ry, gx, gy]);
            }
        }
        return out;
    };

    const cases = [
        // Wide storm spanning well outside the ripple grid on all 4 sides, normal phase step
        { ox: -80, oy: -40, cols: 160, rows: 120, prev: new Float32Array([0.1, 0.2, 0.3]), cur: [0.35, 0.45, 0.55] },
        // Phase wrap-around across 1.0 -> 0.0
        { ox: -60, oy: -20, cols: 130, rows: 90, prev: new Float32Array([0.88, 0.92, 0.95]), cur: [0.12, 0.08, 0.05] },
        // Completely off the ripple grid (inland zoomed away from water)
        { ox: -120, oy: -80, cols: 24, rows: 20, prev: new Float32Array([0.1, 0.2, 0.3]), cur: [0.5, 0.5, 0.5] },
        // First rain frame (no previousPhases): zero cells scanned, zero impulses
        { ox: -60, oy: -20, cols: 120, rows: 80, prev: null, cur: [0.2, 0.3, 0.4] },
    ];

    for (const c of cases) {
        const u = new Float32Array(16);
        u[0] = c.ox;
        u[1] = c.oy;
        u[2] = c.cols;
        u[3] = 4242;
        u[4] = 0.45;
        u[8] = c.cur[0];
        u[9] = c.cur[1];
        u[10] = c.cur[2];
        const instances = c.cols * c.rows;
        const expected = bruteForce(u, instances, c.prev);
        const actual = [];
        const stats = collectRainRippleImpulses({
            uniforms: u,
            rainInstances: instances,
            previousPhases: c.prev,
            cellSize,
            layerCuts,
            rippleOrigin,
            rippleScale,
            wetBounds,
            onImpulse: (rx, ry) => {
                const gx = Math.floor((rx - rippleOrigin[0]) * rippleScale);
                const gy = Math.floor((ry - rippleOrigin[1]) * rippleScale);
                if (gx < 0 || gy < 0 || gx >= RIPPLE_GRID_WIDTH || gy >= RIPPLE_GRID_HEIGHT) return;
                if (!boundary[(gy * RIPPLE_GRID_WIDTH + gx) * 4]) return;
                actual.push([rx, ry, gx, gy]);
            },
        });
        assert.deepEqual(actual, expected, `exact impulse coordinates & hash order must match for ox=${c.ox}`);
        if (c.prev) {
            assert.ok(stats.scannedCells < instances, `expected intersection (${stats.scannedCells}) < full viewport (${instances})`);
        } else {
            assert.equal(stats.scannedCells, 0, 'first frame without previous phases must scan 0 cells');
        }
    }

    // Empty boundary yields empty wetBounds and 0 scanned cells
    const emptyBounds = computeWetRippleBounds(new Uint8Array(64));
    assert.equal(emptyBounds.empty, true);
    assert.equal(intersectRainCellsWithRippleGrid({ ox: 0, oy: 0, cols: 50, rows: 50, wetBounds: emptyBounds }).empty, true);
});

test('W5-A P3: projected basin visibility, mirror staleness on pan-back, and bounded bed strip height', async () => {
    const basin = [150, 710, 820, 388];
    // Centered on basin -> visible
    const inView = projectPlanarBasinRect(basin, [-100, -600], 1, 1920, 1080);
    assert.equal(inView.visible, true);
    assert.ok(inView.w > 0 && inView.h > 0);
    // Panned far northwest (inland) -> completely off-screen
    assert.equal(projectPlanarBasinRect(basin, [-2500, -600], 1, 1920, 1080).visible, false);
    assert.equal(projectPlanarBasinRect(basin, [2500, -600], 1, 1920, 1080).visible, false);
    assert.equal(projectPlanarBasinRect(basin, [-100, -2500], 1, 1920, 1080).visible, false);
    assert.equal(projectPlanarBasinRect(basin, [-100, 1500], 1, 1920, 1080).visible, false);
    assert.equal(projectPlanarBasinRect([0, 0, 0, 0], [0, 0], 1, 1920, 1080).visible, false);

    // Strip height pricing bounds: strictly within [64, 256] (capped by viewport) and <= 1 MiB when width permits
    for (const [bedW, vpH] of [[822, 1080], [1872, 1080], [2560, 1440], [3440, 1440], [640, 48]]) {
        const h = selectPlanarBedStripHeight(bedW, vpH);
        assert.ok(h <= vpH && h <= PLANAR_BED_MAX_STRIP_HEIGHT);
        assert.ok(h >= Math.min(PLANAR_BED_MIN_STRIP_HEIGHT, vpH));
        if (bedW * PLANAR_BED_MIN_STRIP_HEIGHT * 4 <= PLANAR_BED_MAX_BYTES) {
            assert.ok(bedW * h * 4 <= PLANAR_BED_MAX_BYTES, `bedW=${bedW} h=${h} exceeded 1 MiB budget`);
        }
    }

    // Mirror staleness & skipped mirror uniform write when captureMirror is false
    const { device, encoder } = createMockWebGpuDevice();
    const planar = createPlanarWaterPass();
    await planar.prepare(device);
    assert.equal(planar.needsMirrorCapture(), true, 'freshly prepared mirror needs initial capture');

    const writesBefore = device.writes.length;
    planar.encode(encoder, { planarRect: basin, basinId: 1, captureMirror: false });
    assert.equal(device.writes.length, writesBefore, 'captureMirror=false must skip unused mirror uniform write');
    assert.equal(device.renderPasses.length, 0);
    assert.equal(planar.needsMirrorCapture(), true, 'still stale until captured');

    planar.encode(encoder, { planarRect: basin, basinId: 1, captureMirror: true, admittedCount: 3 });
    assert.equal(device.renderPasses.length, 1);
    assert.equal(planar.needsMirrorCapture(), false, 'cleared after live mirror capture');
    assert.equal(planar.getDiagnostics().admittedRecords, 3);

    planar.markMirrorStale();
    assert.equal(planar.needsMirrorCapture(), true, 'marking stale off-screen forces capture on pan-back');
    planar.release();
    assert.equal(planar.needsMirrorCapture(), true, 'release resets stale flag for recovery');
});

test('W5-A P3: _waterBed scratch is counted in Frontier diagnostics, renderer accounting, and unified GPU budget ledger', async () => {
    const { GpuWorldRendererWebGPU } = await import('../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js');
    const { gpuResourceAccounting } = await import('../../claudeville/src/presentation/character-mode/CanvasBudget.js');

    const bedWidth = 1872;
    const bedHeight = selectPlanarBedStripHeight(bedWidth, 1080);
    const expectedBedBytes = bedWidth * bedHeight * 4;
    assert.equal(bedHeight, 140);
    assert.equal(expectedBedBytes, 1_048_320);

    const stub = Object.assign(Object.create(GpuWorldRendererWebGPU.prototype), {
        frontierConfig: { enabled: true },
        _frontierMask: 1,
        _mirrorBufferBytes: 480,
        _waterBed: { width: bedWidth, height: bedHeight },
        sceneTarget: { width: 1920, height: 1080, depthFormat: 'depth32float', emission: null, emissionFormat: 'rgba8unorm' },
        width: 1920,
        height: 1080,
        presentFormat: 'bgra8unorm',
        bloomA: null,
        bloomB: null,
        _textureEntries: new Map(),
        _frontierPasses: new Map(),
        _albedoPage: null,
        _particleBuffer: null,
        _lightRecordBuffer: null,
        _recordBufferBytes: 0,
        _markRecordBufferBytes: 0,
        gpuMsP95: 2.0,
        _frontierPolicy: null,
        suspended: false,
        contextHealthy: true,
        frames: 1,
    });

    const frontierDiag = stub._frontierDiagnostics();
    assert.equal(frontierDiag.waterBedBytes, expectedBedBytes);
    assert.equal(frontierDiag.passOwnedBytes, expectedBedBytes + 480);
    assert.ok(frontierDiag.logicalBytes >= expectedBedBytes + 480);

    const accounting = stub.getResourceAccounting();
    assert.equal(accounting.frontierBytes, expectedBedBytes + 480);
    assert.equal(accounting.textures.frontier, expectedBedBytes + 480);
    assert.equal(
        accounting.totalBytes,
        accounting.pinnedBytes + accounting.evictableBytes,
        'renderer accounting total must not double-count frontierBytes',
    );

    const unifiedGpu = gpuResourceAccounting({
        textures: accounting.textures,
        attachments: accounting.attachments,
        buffers: accounting.buffers,
    });
    assert.equal(unifiedGpu.textures.frontier, expectedBedBytes + 480);
    assert.equal(unifiedGpu.pinnedBytes, accounting.pinnedBytes);
    assert.equal(unifiedGpu.totalBytes, accounting.totalBytes);
});
