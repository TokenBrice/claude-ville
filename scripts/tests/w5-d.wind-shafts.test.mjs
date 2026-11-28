import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WIND_COMPUTE_BINDINGS,
    WIND_EMBER_BINDINGS,
    WIND_EMBER_COMPUTE_WGSL,
    WIND_EMBER_COOLDOWN_DISPATCHES,
    WIND_EMBER_DEFAULT_BYTES,
    WIND_EMBER_DEFAULT_CAPACITY,
    WIND_EMBER_MAX_BYTES,
    WIND_EMBER_MAX_CAPACITY,
    WIND_EMBER_STRIDE_BYTES,
    WIND_EMITTER_BUFFER_BYTES,
    WIND_EMITTER_FLAGS,
    WIND_FIELD_COMPUTE_WGSL,
    WIND_FIELD_FORMAT,
    WIND_FIELD_PINGPONG_BYTES,
    WIND_FIELD_SIZE,
    WIND_FIXED_DT_S,
    WIND_FRONTIER_MASK_BIT,
    WIND_MAX_CATCHUP_STEPS,
    WIND_OBSTACLE_BYTES,
    WIND_OBSTACLE_FORMAT,
    WIND_PARAMS_LAYOUT,
    WIND_SIM_CONSTANTS,
    WIND_STEP_HZ,
    WindFieldCompute,
    buildWindObstacleField,
    createWindFieldCompute,
    createWindFieldState,
    stepEmbersCpu,
    stepWindFieldCpu,
} from '../../claudeville/src/presentation/character-mode/gpu/wgpu/WindFieldCompute.js';

import {
    BAYER_4X4,
    SHAFT_BINDINGS,
    SHAFT_DEPTH_INV_SPAN,
    SHAFT_DEPTH_MAX,
    SHAFT_DEPTH_MIN,
    SHAFT_DEPTH_RANGE,
    SHAFT_FRONTIER_MASK_BIT,
    SHAFT_INSTANCE_BUFFER_BYTES,
    SHAFT_INSTANCE_BYTES,
    SHAFT_KINDS,
    SHAFT_MAX_INSTANCES,
    SHAFT_PARAMS_LAYOUT,
    SHAFT_RECEIVER_HSV_SAT_MIN_V,
    SHAFT_RECEIVER_MAX_ENCODED_LUMA,
    SHAFT_RECEIVER_MAX_HSV_SAT,
    SHAFT_RECEIVER_MAX_LINEAR_LUMA,
    SHAFT_TERMINAL_SLICES,
    VOLUMETRIC_SHAFTS_WGSL,
    VolumetricShaftsPass,
    bayer4At,
    buildShaftInstances,
    clampReceiverColor,
    computeEncodedLuma,
    computeHsv,
    computeLinearLuma,
    createVolumetricShaftsPass,
    decodeShaftDepth,
    encodeShaftDepth,
    evaluateShaftPixelCpu,
} from '../../claudeville/src/presentation/character-mode/gpu/wgpu/VolumetricShaftsPass.js';

function createMockWebGpuDevice() {
    const log = {
        bindGroupLayouts: [],
        pipelineLayouts: [],
        shaderModules: [],
        computePipelines: [],
        renderPipelines: [],
        textures: [],
        buffers: [],
        bindGroups: [],
        writeBuffers: [],
        writeTextures: [],
        destroyed: [],
    };
    const trackDestroy = (obj) => {
        obj.destroy = () => {
            obj._destroyed = true;
            log.destroyed.push(obj.label || 'unnamed');
        };
        return obj;
    };
    const device = {
        log,
        queue: {
            writeBuffer(buffer, offset, data) {
                log.writeBuffers.push({ label: buffer.label, offset, byteLength: data?.byteLength ?? 0 });
            },
            writeTexture(dest, data, layout, size) {
                log.writeTextures.push({ label: dest.texture.label, bytesPerRow: layout.bytesPerRow, size });
            },
        },
        createBindGroupLayout(desc) {
            log.bindGroupLayouts.push(desc);
            return { label: desc.label, entries: desc.entries };
        },
        createPipelineLayout(desc) {
            log.pipelineLayouts.push(desc);
            return { label: desc.label, bindGroupLayouts: desc.bindGroupLayouts };
        },
        createShaderModule(desc) {
            log.shaderModules.push(desc);
            return { label: desc.label, code: desc.code, async getCompilationInfo() { return { messages: [] }; } };
        },
        async createComputePipelineAsync(desc) {
            log.computePipelines.push(desc);
            return { label: desc.label, desc };
        },
        async createRenderPipelineAsync(desc) {
            log.renderPipelines.push(desc);
            return { label: desc.label, desc };
        },
        createTexture(desc) {
            const tex = trackDestroy({
                label: desc.label,
                size: desc.size,
                format: desc.format,
                usage: desc.usage,
                createView() {
                    return { texture: tex, label: `${desc.label}:view` };
                },
            });
            log.textures.push(tex);
            return tex;
        },
        createBuffer(desc) {
            const buf = trackDestroy({ label: desc.label, size: desc.size, usage: desc.usage });
            log.buffers.push(buf);
            return buf;
        },
        createBindGroup(desc) {
            log.bindGroups.push(desc);
            return { label: desc.label, entries: desc.entries };
        },
    };
    return device;
}

function createMockEncoder() {
    const passes = [];
    return {
        passes,
        beginComputePass(desc = {}) {
            const rec = { kind: 'compute', label: desc.label, pipeline: null, bindGroups: [], dispatches: [], ended: false };
            passes.push(rec);
            return {
                setPipeline(p) { rec.pipeline = p; },
                setBindGroup(slot, bg) { rec.bindGroups.push({ slot, bg }); },
                dispatchWorkgroups(x, y = 1, z = 1) { rec.dispatches.push([x, y, z]); },
                end() { rec.ended = true; },
            };
        },
        beginRenderPass(desc = {}) {
            const rec = { kind: 'render', label: desc.label, desc, pipeline: null, bindGroups: [], draws: [], ended: false };
            passes.push(rec);
            return {
                setPipeline(p) { rec.pipeline = p; },
                setBindGroup(slot, bg) { rec.bindGroups.push({ slot, bg }); },
                draw(vc, ic, fv = 0, fi = 0) { rec.draws.push([vc, ic, fv, fi]); },
                end() { rec.ended = true; },
            };
        },
    };
}

// ---------------------------------------------------------------------------
// 1. Wind Field Compute: Geographic Propagation, Shelter, Stability & Budgets
// ---------------------------------------------------------------------------

test('wind field propagates gusts geographically downwind with positive delay and zero global instant blink', () => {
    const state = createWindFieldState(WIND_FIELD_SIZE);
    const row = 64;
    const upwindX = 24;
    const midX = 32;
    const farX = 40;

    // Seed a localized upwind gust patch (3-cell wide pulse) and zero elsewhere.
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const idx = ((row + dy) * WIND_FIELD_SIZE + (upwindX + dx)) * 4;
            state.current[idx] = 1.0;
            state.current[idx + 1] = 0.0;
            state.current[idx + 2] = 1.0;
        }
    }

    const params = {
        size: WIND_FIELD_SIZE,
        dt: WIND_FIXED_DT_S,
        baseWindX: 1.0,
        baseWindY: 0.0,
        mistAmbient: 0.1,
    };

    let midArrivalStep = -1;
    let farArrivalStep = -1;
    let midPeak = 0;
    let farPeak = 0;

    for (let step = 1; step <= 32; step++) {
        stepWindFieldCpu(state.current, state.next, state.obstacle, params);
        // Swap ping-pong buffers.
        const tmp = state.current;
        state.current = state.next;
        state.next = tmp;

        const midGust = state.current[(row * WIND_FIELD_SIZE + midX) * 4 + 2];
        const farGust = state.current[(row * WIND_FIELD_SIZE + farX) * 4 + 2];

        // Step 1 must NOT blink globally: cells 8 and 16 cells downwind remain strictly zero.
        if (step === 1) {
            assert.equal(midGust, 0, 'mid downwind cell must not receive instant global blink on step 1');
            assert.equal(farGust, 0, 'far downwind cell must not receive instant global blink on step 1');
        }
        if (midArrivalStep < 0 && midGust > 0.05) midArrivalStep = step;
        if (farArrivalStep < 0 && farGust > 0.05) farArrivalStep = step;
        if (midGust > midPeak) midPeak = midGust;
        if (farGust > farPeak) farPeak = farGust;
    }

    assert.ok(midArrivalStep > 2, `mid downwind cell should arrive with positive delay (got step ${midArrivalStep})`);
    assert.ok(farArrivalStep > midArrivalStep, `far cell (step ${farArrivalStep}) must arrive strictly after mid cell (step ${midArrivalStep})`);
    assert.ok(midPeak > 0.25, `mid downwind gust peak should remain substantial (got ${midPeak})`);
    assert.ok(farPeak > 0.10, `far downwind gust peak should propagate cleanly (got ${farPeak})`);
});

test('building obstacle field creates strictly lower wind velocity in sheltered lee than open meadow', () => {
    const state = createWindFieldState(WIND_FIELD_SIZE);
    // Place a single synthetic building block at cells [48..53, 60..67].
    const obstacle = buildWindObstacleField(
        [{ cellX: 48, cellY: 60, cellW: 6, cellH: 8 }],
        { size: WIND_FIELD_SIZE, shelterMarginCells: 1 },
    );

    const params = {
        size: WIND_FIELD_SIZE,
        dt: WIND_FIXED_DT_S,
        baseWindX: 1.1,
        baseWindY: 0.0,
        mistAmbient: 0.2,
    };

    for (let step = 0; step < 40; step++) {
        stepWindFieldCpu(state.current, state.next, obstacle, params);
        const tmp = state.current;
        state.current = state.next;
        state.next = tmp;
    }

    const interiorIdx = (64 * WIND_FIELD_SIZE + 50) * 4;
    const leeIdx1 = (64 * WIND_FIELD_SIZE + 54) * 4; // 1 cell downwind of east wall (x=53)
    const leeIdx2 = (64 * WIND_FIELD_SIZE + 55) * 4; // 2 cells downwind
    const openIdx = (20 * WIND_FIELD_SIZE + 54) * 4; // Open meadow far from building

    const interiorSpeed = Math.hypot(state.current[interiorIdx], state.current[interiorIdx + 1]);
    const leeSpeed1 = Math.hypot(state.current[leeIdx1], state.current[leeIdx1 + 1]);
    const leeSpeed2 = Math.hypot(state.current[leeIdx2], state.current[leeIdx2 + 1]);
    const openSpeed = Math.hypot(state.current[openIdx], state.current[openIdx + 1]);

    assert.equal(interiorSpeed, 0, 'solid building interior must have zero wind velocity');
    assert.ok(openSpeed > 0.9, `open meadow should reach prevailing flow (got ${openSpeed})`);
    assert.ok(leeSpeed1 < openSpeed * 0.5, `immediate lee cell (${leeSpeed1}) must be strongly sheltered vs open meadow (${openSpeed})`);
    assert.ok(leeSpeed2 < openSpeed * 0.75, `2-cell lee cell (${leeSpeed2}) must stay strictly slower than open meadow (${openSpeed})`);

    // Also verify default village BUILDING_DEFS rasterizes real solid cells.
    const villageObstacle = buildWindObstacleField();
    assert.equal(villageObstacle.byteLength, WIND_OBSTACLE_BYTES);
    let solidCells = 0;
    for (let i = 0; i < villageObstacle.length; i += 4) {
        if (villageObstacle[i] >= 128) solidCells++;
    }
    assert.ok(solidCells > 20, `default village buildings must stamp solid obstacle cells (got ${solidCells})`);
});

test('200-step storm stability, reducedMotion freeze, catch-up cap <= 2, visibility reset, and GPU memory budgets', () => {
    const state = createWindFieldState(WIND_FIELD_SIZE);
    const obstacle = buildWindObstacleField();
    const emitters = [
        { cellX: 20, cellY: 64, radiusCells: 6, gustStrength: 1.0, mistStrength: 0.8, dirX: 1.4, dirY: 0.2, flags: WIND_EMITTER_FLAGS.gust },
        { cellX: 70, cellY: 72, radiusCells: 4, gustStrength: 0.9, mistStrength: 0.1, dirX: 0.3, dirY: -0.2, flags: WIND_EMITTER_FLAGS.hearth },
    ];
    const embers = new Float32Array(WIND_EMBER_DEFAULT_CAPACITY * 8);

    const params = {
        size: WIND_FIELD_SIZE,
        dt: WIND_FIXED_DT_S,
        baseWindX: 1.4,
        baseWindY: 0.3,
        mistAmbient: 0.65,
        stepIndex: 0,
    };

    for (let step = 0; step < 200; step++) {
        params.stepIndex = step;
        const stats = stepWindFieldCpu(state.current, state.next, obstacle, params, emitters);
        assert.equal(stats.stepped, true);
        assert.ok(Number.isFinite(stats.maxSpeed) && stats.maxSpeed <= WIND_SIM_CONSTANTS.velocityClamp + 1e-5);
        assert.ok(Number.isFinite(stats.maxGust) && stats.maxGust >= 0 && stats.maxGust <= 1);
        assert.ok(Number.isFinite(stats.maxMist) && stats.maxMist >= 0 && stats.maxMist <= 1);

        const tmp = state.current;
        state.current = state.next;
        state.next = tmp;

        stepEmbersCpu(embers, state.current, params, emitters);
    }

    // Verify all 128x128x4 cells and all 256x8 ember floats are finite and bounded.
    for (let i = 0; i < state.current.length; i += 4) {
        const vx = state.current[i];
        const vy = state.current[i + 1];
        const g = state.current[i + 2];
        const m = state.current[i + 3];
        assert.ok(Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(g) && Number.isFinite(m));
        assert.ok(Math.hypot(vx, vy) <= WIND_SIM_CONSTANTS.velocityClamp + 1e-4);
        assert.ok(g >= 0 && g <= 1);
        assert.ok(m >= 0 && m <= 1);
    }
    let liveEmbers = 0;
    for (let i = 0; i < embers.length; i += 8) {
        for (let k = 0; k < 8; k++) assert.ok(Number.isFinite(embers[i + k]), 'decorative ember state must stay finite');
        if (embers[i + 6] > 0.01) liveEmbers++;
    }
    assert.ok(liveEmbers > 0, 'hearth emitter should spawn decorative embers');

    // Reduced-motion freeze must preserve field and embers bit-for-bit.
    const fieldSnapshot = state.current.slice();
    const emberSnapshot = embers.slice();
    const frozenWind = stepWindFieldCpu(state.current, state.next, obstacle, { ...params, reducedMotion: true }, emitters);
    const frozenEmbers = stepEmbersCpu(embers, state.current, { ...params, reducedMotion: true }, emitters);
    assert.equal(frozenWind.stepped, false);
    assert.equal(frozenEmbers.stepped, false);
    assert.deepEqual(state.next, fieldSnapshot, 'reducedMotion must freeze wind/mist field identically');
    assert.deepEqual(embers, emberSnapshot, 'reducedMotion must freeze decorative embers identically');

    // Fixed-step 20 Hz accumulator, catch-up <= 2, visibility reset, and reducedMotion freeze.
    const compute = createWindFieldCompute();
    assert.equal(WIND_STEP_HZ, 20);
    assert.equal(WIND_FIXED_DT_S, 0.05);
    assert.equal(WIND_MAX_CATCHUP_STEPS, 2);
    assert.equal(WIND_FRONTIER_MASK_BIT, 8);

    assert.equal(compute.stepAccumulator(0.025), 0);
    assert.equal(compute.stepAccumulator(0.025), 1);
    assert.equal(compute.stepAccumulator(0.10), 2);
    assert.equal(compute.stepAccumulator(5.0), 2, 'large frame hitch must be capped strictly at <= 2 catch-up steps');
    assert.equal(compute.stepAccumulator(0.01), 0, 'capped hitch must drop excess debt rather than spilling');
    assert.equal(compute.stepAccumulator(0.04), 1);
    assert.equal(compute.stepAccumulator(0.04), 0);
    assert.equal(compute.stepAccumulator(0.04, { visibilityReturned: true }), 0, 'visibility return resets accumulator');
    assert.equal(compute.stepAccumulator(0.02), 0, 'post-reset 20ms must not trigger stale accumulated step');
    assert.equal(compute.stepAccumulator(0.20, { reducedMotion: true }), 0, 'reducedMotion freezes accumulator');

    // Spec-exact GPU memory budget checks.
    assert.equal(WIND_FIELD_FORMAT, 'rgba16float');
    assert.equal(WIND_OBSTACLE_FORMAT, 'rgba8unorm');
    assert.equal(WIND_FIELD_PINGPONG_BYTES, 262_144);
    assert.equal(WIND_OBSTACLE_BYTES, 65_536);
    assert.equal(WIND_EMBER_DEFAULT_CAPACITY * WIND_EMBER_STRIDE_BYTES, 8_192);
    assert.equal(WIND_EMBER_DEFAULT_BYTES, 8_192);
    assert.equal(WIND_EMBER_MAX_CAPACITY * WIND_EMBER_STRIDE_BYTES, 131_072);
    assert.equal(WIND_EMBER_MAX_BYTES, 131_072);

    const diag = compute.getDiagnostics();
    assert.equal(diag.memoryBytes.fieldPingPong, 262_144);
    assert.equal(diag.memoryBytes.obstacle, 65_536);
    assert.equal(diag.memoryBytes.embers, 8_192);
    assert.equal(diag.memoryBytes.emitters, WIND_EMITTER_BUFFER_BYTES);
    assert.equal(diag.memoryBytes.uniforms, WIND_PARAMS_LAYOUT.size);
});

test('WindFieldCompute WebGPU lifecycle: prepare, encode ping-pong, diagnostics, release', async () => {
    const device = createMockWebGpuDevice();
    const pass = new WindFieldCompute();
    const prep = await pass.prepare(device);
    assert.equal(prep.ready, true);
    assert.equal(device.log.computePipelines.length, 2);
    assert.equal(device.log.bindGroupLayouts[0].entries.length, 5, 'wind compute group 0 must declare bindings 0..4');

    // Verify ping-pong bind groups never bind the same texture as both sampled and write-only storage.
    for (const bg of device.log.bindGroups.filter(b => b.label.startsWith('w5d-wind-bg-'))) {
        const prev = bg.entries.find(e => e.binding === WIND_COMPUTE_BINDINGS.prevField).resource;
        const next = bg.entries.find(e => e.binding === WIND_COMPUTE_BINDINGS.nextField).resource;
        assert.notEqual(prev, next, 'ping-pong prevField and nextField must refer to distinct textures');
    }

    pass.setWindForcing({
        baseWindX: 0.9,
        baseWindY: 0.1,
        mistAmbient: 0.3,
        emitters: [{ cellX: 16, cellY: 64, radiusCells: 5, gustStrength: 0.8, flags: WIND_EMITTER_FLAGS.gust }],
    });

    const encoder = createMockEncoder();
    const first = pass.encode(encoder, { dtSeconds: 0.12 }); // 2 steps (capped at 2)
    assert.equal(first.dispatchedSteps, 2);
    assert.equal(first.revision, 2);
    assert.equal(first.readIndex, 0, '2 ping-pong steps return readIndex to 0');
    assert.equal(encoder.passes.length, 3, '2 wind passes + 1 decorative ember pass');
    assert.deepEqual(encoder.passes[0].dispatches[0], [16, 16, 1]);
    assert.deepEqual(encoder.passes[2].dispatches[0], [4, 1, 1]);

    const second = pass.encode(encoder, { dtSeconds: 0.05 }); // 1 step
    assert.equal(second.dispatchedSteps, 1);
    assert.equal(second.readIndex, 1);
    assert.equal(second.revision, 3);

    const frozen = pass.encode(encoder, { dtSeconds: 0.10, reducedMotion: true });
    assert.equal(frozen.dispatchedSteps, 0);
    assert.equal(frozen.revision, 3);

    pass.release();
    assert.equal(pass.getDiagnostics().ready, false);
    assert.ok(device.log.destroyed.includes('w5d-wind-field-a'));
    assert.ok(device.log.destroyed.includes('w5d-wind-field-b'));
    assert.ok(device.log.destroyed.includes('w5d-wind-obstacle'));
    assert.ok(device.log.destroyed.includes('w5d-wind-embers'));
});

// ---------------------------------------------------------------------------
// 2. Volumetric Shafts Pass: Depth Clipping, Bayer 8-Slice, Gating, Role 0
// ---------------------------------------------------------------------------

test('volumetric shaft depth range encoding and lintel occlusion clipping (D_lintel > D_shaft)', () => {
    assert.deepEqual(SHAFT_DEPTH_RANGE, [-2048, 6144, 1 / 8192, 8]);
    assert.equal(SHAFT_DEPTH_MIN, -2048);
    assert.equal(SHAFT_DEPTH_MAX, 6144);
    assert.equal(SHAFT_DEPTH_INV_SPAN, 1 / 8192);
    assert.equal(SHAFT_TERMINAL_SLICES, 8);
    assert.equal(SHAFT_FRONTIER_MASK_BIT, 16);

    assert.equal(encodeShaftDepth(-2048), 1);
    assert.equal(encodeShaftDepth(6144), 0);
    assert.ok(Math.abs(decodeShaftDepth(encodeShaftDepth(1234)) - 1234) < 1e-6);

    const shafts = buildShaftInstances({
        hour: 10.5,
        daylight: 0.9,
        sunElevation: 0.65,
        cloudCover: 0.1,
        forgeActive: true,
        forgeGlow: 0.85,
    });
    const archiveShaft = shafts.find(s => s.kind === SHAFT_KINDS.archive);
    const forgeShaft = shafts.find(s => s.kind === SHAFT_KINDS.forge);
    assert.ok(archiveShaft, 'sunny daytime should emit Archive lancet shaft');
    assert.ok(forgeShaft, 'active Forge should emit open-bay hearth shaft');

    for (const shaft of [archiveShaft, forgeShaft]) {
        // Sample near the upper-middle centerline of the shaft prism.
        const sampleX = shaft.originX + shaft.reachX * 0.25;
        const sampleY = shaft.originY + shaft.reachY * 0.25;

        // Clear background (farther than shaft): must be visible.
        const unoccluded = evaluateShaftPixelCpu(shaft, sampleX, sampleY, {
            sceneDepthD: shaft.depthOriginD - 200,
        });
        assert.equal(unoccluded.visible, true, `${shaft.id} should be visible in front of background`);
        assert.equal(unoccluded.occluded, false);
        assert.ok(unoccluded.alpha > 0);

        // Closer lintel (D_lintel > D_shaft): must be rejected/occluded cleanly.
        const lintelD = unoccluded.shaftDepthD + 12;
        assert.ok(encodeShaftDepth(lintelD) < unoccluded.shaftDepthNdc, 'closer lintel has strictly smaller NDC depth');
        const behindLintel = evaluateShaftPixelCpu(shaft, sampleX, sampleY, {
            sceneDepthD: lintelD,
        });
        assert.equal(behindLintel.visible, false, `${shaft.id} pixel behind closer lintel must be rejected`);
        assert.equal(behindLintel.occluded, true);
        assert.equal(behindLintel.alpha, 0);
        assert.deepEqual(behindLintel.emission, [0, 0, 0, 0]);

        // Same test passing normalized sceneDepthNdc directly.
        const behindLintelNdc = evaluateShaftPixelCpu(shaft, sampleX, sampleY, {
            sceneDepthNdc: encodeShaftDepth(lintelD),
        });
        assert.equal(behindLintelNdc.visible, false);
        assert.equal(behindLintelNdc.occluded, true);

        // Pixel outside exact prism slit bounds must be clipped cleanly.
        const outside = evaluateShaftPixelCpu(shaft, shaft.originX - shaft.reachY * 3, shaft.originY + shaft.reachX * 3);
        assert.equal(outside.visible, false);
        assert.equal(outside.clipped, true);
        assert.equal(outside.alpha, 0);
    }
});

test('volumetric shafts enforce Bayer 4x4 8-slice quantization and integer world-texel snapping', () => {
    assert.deepEqual([...BAYER_4X4], [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

    const syntheticShaft = {
        id: 'test:quantized',
        kind: SHAFT_KINDS.archive,
        originX: 100,
        originY: 100,
        reachX: 0,
        reachY: 64,
        apertureHalfW: 12,
        spread: 8,
        depthOriginD: 500,
        depthEndD: 620,
        color: [0.74, 0.71, 0.63],
        maxAlpha: 0.32,
        intensity: 0.62,
        mistGain: 0.25,
    };

    // Integer texel snapping: sub-pixel offsets inside the same world texel must agree bit-for-bit.
    const pA = evaluateShaftPixelCpu(syntheticShaft, 102.05, 118.10);
    const pB = evaluateShaftPixelCpu(syntheticShaft, 102.95, 118.92);
    assert.deepEqual(pA, pB, 'fractional coordinates inside one integer art texel must snap identically');

    // Inspect a 4x4 Bayer tile inside the shaft: outputs must be strictly quantized to 1/8 steps & 0/1/2 courses.
    const levels = new Set();
    const courses = new Set();
    const alphas = new Set();
    const ranks = new Set();
    for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
            const tx = 100 + dx;
            const ty = 128 + dy; // slice 3 -> mid-shaft Bayer seam
            const res = evaluateShaftPixelCpu(syntheticShaft, tx, ty);
            ranks.add(res.bayerRank);
            assert.equal(res.bayerRank, bayer4At(tx, ty).rank);
            assert.ok(Number.isInteger(res.quantizedLevel) && res.quantizedLevel >= 0 && res.quantizedLevel <= SHAFT_TERMINAL_SLICES);
            assert.ok(res.airCourse === 0 || res.airCourse === 1 || res.airCourse === 2);
            const expectedAlpha = (res.quantizedLevel / SHAFT_TERMINAL_SLICES) * syntheticShaft.maxAlpha;
            assert.ok(Math.abs(res.alpha - expectedAlpha) < 1e-9, 'alpha must be an exact multiple of maxAlpha / 8');
            levels.add(res.quantizedLevel);
            courses.add(res.airCourse);
            alphas.add(res.alpha);
        }
    }
    assert.equal(ranks.size, 16, '4x4 block must cover all 16 Bayer ranks');
    assert.ok(levels.size >= 2 && levels.size <= 3, `Bayer dithering should step cleanly across adjacent slices (got ${levels.size} levels)`);
});

test('volumetric shaft time and activity gating: zero Archive at night, zero Forge when banked or cold', () => {
    // Deep night + banked Forge -> zero shafts total.
    const quietNight = buildShaftInstances({
        hour: 23,
        isNight: true,
        daylight: 0,
        sunElevation: -0.35,
        forgeBanked: true,
        forgeActive: false,
    });
    assert.equal(quietNight.length, 0, 'quiet night with banked Forge must emit zero shafts');

    // Night + active Forge -> Forge hearth shaft only, zero Archive sunbeams.
    const busyNight = buildShaftInstances({
        hour: 22.5,
        daylight: 0,
        sunElevation: -0.25,
        forgeActive: true,
        forgeBanked: false,
        forgeGlow: 0.9,
    });
    assert.equal(busyNight.filter(s => s.kind === SHAFT_KINDS.archive).length, 0, 'Archive must emit zero sunbeams at night');
    assert.equal(busyNight.filter(s => s.kind === SHAFT_KINDS.forge).length, 1, 'active Forge must emit open-bay hearth shaft at night');

    // Clear noon + cold/banked Forge -> 5 Archive lancets, zero Forge shafts.
    const sunnyBanked = buildShaftInstances({
        hour: 12.5,
        daylight: 0.95,
        sunElevation: 0.9,
        cloudCover: 0.1,
        forgeCold: true,
        forgeActive: false,
    });
    assert.equal(sunnyBanked.filter(s => s.kind === SHAFT_KINDS.archive).length, 5, 'Archive has 5 ground lancet sunbeams in clear daylight');
    assert.equal(sunnyBanked.filter(s => s.kind === SHAFT_KINDS.forge).length, 0, 'cold Forge must emit zero shafts');

    // Heavy overcast/storm daytime suppresses Archive sunbeams.
    const stormDay = buildShaftInstances({
        hour: 13,
        daylight: 0.85,
        sunElevation: 0.8,
        cloudCover: 0.96,
        overcast: 0.96,
        forgeBanked: true,
    });
    assert.equal(stormDay.filter(s => s.kind === SHAFT_KINDS.archive).length, 0, 'heavy storm/overcast suppresses Archive sunbeams');

    // Solar angle shifts Archive lancet beam direction from morning to afternoon.
    const morning = buildShaftInstances({ hour: 8, daylight: 0.65, sunElevation: 0.35, cloudCover: 0, forgeBanked: true });
    const afternoon = buildShaftInstances({ hour: 17, daylight: 0.65, sunElevation: 0.35, cloudCover: 0, forgeBanked: true });
    assert.notEqual(morning[0].reachX, afternoon[0].reachX, 'Archive sunbeam angle must track solar azimuth');
});

test('volumetric shafts obey strict role-0 receiver luminance, saturation, and zero-emission limits', () => {
    // Adversarial bright/saturated colors must all clamp safely inside specs/01 §3 limits.
    const adversarialColors = [
        [1.0, 1.0, 1.0],
        [1.0, 0.95, 0.0],
        [0.0, 1.0, 1.0],
        [1.0, 0.2, 0.0],
        [0.95, 0.85, 0.72],
    ];
    for (const raw of adversarialColors) {
        const clamped = clampReceiverColor(raw);
        const linY = computeLinearLuma(clamped);
        const encY = computeEncodedLuma(clamped);
        const { s, v } = computeHsv(clamped);
        assert.ok(linY <= SHAFT_RECEIVER_MAX_LINEAR_LUMA, `linear luma ${linY} exceeded 0.70 for ${raw}`);
        assert.ok(encY <= SHAFT_RECEIVER_MAX_ENCODED_LUMA, `encoded Y ${encY} exceeded 0.74 for ${raw}`);
        if (v >= SHAFT_RECEIVER_HSV_SAT_MIN_V) {
            assert.ok(s <= SHAFT_RECEIVER_MAX_HSV_SAT + 1e-6, `HSV S ${s} exceeded 0.65 at V=${v} for ${raw}`);
        }
    }

    // Evaluate live Archive (noon & golden) + Forge shafts at peak visibility.
    const scenarios = [
        { hour: 12, daylight: 1.0, sunElevation: 1.0, cloudCover: 0, forgeActive: true, forgeGlow: 1.0 },
        { hour: 18, daylight: 0.75, sunElevation: 0.16, cloudCover: 0, forgeActive: true, forgeGlow: 1.0 },
        { hour: 23, isNight: true, forgeActive: true, forgeGlow: 1.0 },
    ];
    for (const state of scenarios) {
        const shafts = buildShaftInstances(state);
        assert.ok(shafts.length > 0);
        for (const shaft of shafts) {
            assert.equal(shaft.role, 0);
            assert.deepEqual([...shaft.emission], [0, 0, 0, 0]);
            const res = evaluateShaftPixelCpu(shaft, shaft.originX + shaft.reachX * 0.15, shaft.originY + shaft.reachY * 0.15, {
                mistDensity: 1.0,
            });
            assert.equal(res.visible, true);
            assert.equal(res.role, 0);
            assert.deepEqual(res.emission, [0, 0, 0, 0]);
            assert.ok(res.linearLuma <= SHAFT_RECEIVER_MAX_LINEAR_LUMA, `linear luma ${res.linearLuma} > 0.70 on ${shaft.id}`);
            assert.ok(res.encodedLuma <= SHAFT_RECEIVER_MAX_ENCODED_LUMA, `encoded Y ${res.encodedLuma} > 0.74 on ${shaft.id}`);
            if (res.hsvValue >= SHAFT_RECEIVER_HSV_SAT_MIN_V) {
                assert.ok(res.hsvSaturation <= SHAFT_RECEIVER_MAX_HSV_SAT + 1e-6);
            }
        }
    }
});

test('VolumetricShaftsPass WebGPU lifecycle: prepare, depth-tested encode, diagnostics, release', async () => {
    const device = createMockWebGpuDevice();
    const pass = createVolumetricShaftsPass();
    const prep = await pass.prepare(device);
    assert.equal(prep.ready, true);
    assert.equal(prep.terminalSlices, 8);
    assert.equal(prep.role, 0);
    assert.equal(device.log.renderPipelines.length, 2, 'should prewarm MRT and color-only shaft pipelines');
    for (const rp of device.log.renderPipelines) {
        assert.equal(rp.depthStencil.depthWriteEnabled, false, 'volumetric shafts must never write depth');
        assert.equal(rp.depthStencil.depthCompare, 'less-equal', 'volumetric shafts must depth-test against scene depth');
    }

    // Encode via GPUCommandEncoder with explicit views.
    const encoder = createMockEncoder();
    const res = pass.encode(encoder, {
        sceneState: { hour: 11, daylight: 0.9, sunElevation: 0.7, cloudCover: 0.1, forgeActive: true, forgeGlow: 0.8 },
        colorView: { label: 'scene-color' },
        emissionView: { label: 'scene-emission' },
        depthView: { label: 'scene-depth' },
    });
    assert.equal(res.archiveShafts, 5);
    assert.equal(res.forgeShafts, 1);
    assert.equal(res.drawnShafts, 6);
    assert.equal(encoder.passes.length, 1);
    assert.deepEqual(encoder.passes[0].draws[0], [6, 6, 0, 0]);
    assert.equal(encoder.passes[0].desc.depthStencilAttachment.depthReadOnly, true);
    assert.equal(encoder.passes[0].desc.depthStencilAttachment.depthLoadOp, undefined);
    assert.equal(encoder.passes[0].desc.depthStencilAttachment.depthStoreOp, undefined);

    // Encode directly onto an active GPURenderPassEncoder (zero extra render pass).
    const activePassDraws = [];
    const inlinePass = {
        setPipeline() {},
        setBindGroup() {},
        draw(...args) { activePassDraws.push(args); },
    };
    const inlineRes = pass.encode(inlinePass, {
        sceneState: { hour: 23, isNight: true, forgeActive: true, forgeGlow: 0.9 },
    });
    assert.equal(inlineRes.archiveShafts, 0);
    assert.equal(inlineRes.forgeShafts, 1);
    assert.deepEqual(activePassDraws[0], [6, 1, 0, 0]);

    // Diagnostics & memory budget check.
    const diag = pass.getDiagnostics();
    assert.equal(diag.memoryBytes.instances, SHAFT_MAX_INSTANCES * SHAFT_INSTANCE_BYTES);
    assert.equal(diag.memoryBytes.instances, SHAFT_INSTANCE_BUFFER_BYTES);
    assert.equal(diag.memoryBytes.uniforms, SHAFT_PARAMS_LAYOUT.size);
    assert.ok(diag.memoryBytes.total < 4096, 'shaft pass GPU memory must stay tiny');

    pass.release();
    assert.equal(pass.getDiagnostics().ready, false);
    assert.ok(device.log.destroyed.includes('w5d-shafts-params'));
    assert.ok(device.log.destroyed.includes('w5d-shafts-instances'));
});

// ---------------------------------------------------------------------------
// 3. WGSL Shader Structural & Contract Checks
// ---------------------------------------------------------------------------

test('WGSL shaders satisfy entry points, group-0 bindings, storage format, role-0 emission, and zero smoothstep blur', () => {
    // Wind compute kernel structural checks (specs/01 §1 group 0 bindings 0..4).
    assert.match(WIND_FIELD_COMPUTE_WGSL, /@compute\s+@workgroup_size\(8,\s*8,\s*1\)\s+fn\s+windFieldCs\b/);
    assert.match(WIND_FIELD_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_COMPUTE_BINDINGS.params}\\)\\s+var<uniform>\\s+params`));
    assert.match(WIND_FIELD_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_COMPUTE_BINDINGS.prevField}\\)\\s+var\\s+prevField:\\s*texture_2d<f32>`));
    assert.match(WIND_FIELD_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_COMPUTE_BINDINGS.nextField}\\)\\s+var\\s+nextField:\\s*texture_storage_2d<rgba16float,\\s*write>`));
    assert.match(WIND_FIELD_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_COMPUTE_BINDINGS.obstacleField}\\)\\s+var\\s+obstacleField:\\s*texture_2d<f32>`));
    assert.match(WIND_FIELD_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_COMPUTE_BINDINGS.emitters}\\)\\s+var<storage,\\s*read>\\s+emitters`));
    assert.doesNotMatch(WIND_FIELD_COMPUTE_WGSL, /\bsmoothstep\s*\(/, 'wind compute WGSL must not use smoothstep');

    // Decorative ember compute kernel structural checks.
    assert.match(WIND_EMBER_COMPUTE_WGSL, /@compute\s+@workgroup_size\(64,\s*1,\s*1\)\s+fn\s+windEmberCs\b/);
    assert.match(WIND_EMBER_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_EMBER_BINDINGS.params}\\)\\s+var<uniform>`));
    assert.match(WIND_EMBER_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_EMBER_BINDINGS.windField}\\)\\s+var\\s+windField:\\s*texture_2d<f32>`));
    assert.match(WIND_EMBER_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_EMBER_BINDINGS.embers}\\)\\s+var<storage,\\s*read_write>`));
    assert.match(WIND_EMBER_COMPUTE_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${WIND_EMBER_BINDINGS.emitters}\\)\\s+var<storage,\\s*read>`));
    assert.doesNotMatch(WIND_EMBER_COMPUTE_WGSL, /\bsmoothstep\s*\(/);

    // Volumetric shafts WGSL structural checks.
    assert.match(VOLUMETRIC_SHAFTS_WGSL, /@vertex\s+fn\s+shaftVs\b/);
    assert.match(VOLUMETRIC_SHAFTS_WGSL, /@fragment\s+fn\s+shaftFs\b/);
    assert.match(VOLUMETRIC_SHAFTS_WGSL, /@fragment\s+fn\s+shaftColorFs\b/);
    assert.match(VOLUMETRIC_SHAFTS_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${SHAFT_BINDINGS.params}\\)\\s+var<uniform>`));
    assert.match(VOLUMETRIC_SHAFTS_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${SHAFT_BINDINGS.shafts}\\)\\s+var<storage,\\s*read>`));
    assert.match(VOLUMETRIC_SHAFTS_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${SHAFT_BINDINGS.sceneDepth}\\)\\s+var\\s+sceneDepthTex:\\s*texture_depth_2d`));
    assert.match(VOLUMETRIC_SHAFTS_WGSL, new RegExp(`@group\\(0\\)\\s+@binding\\(${SHAFT_BINDINGS.windField}\\)\\s+var\\s+windFieldTex:\\s*texture_2d<f32>`));
    assert.match(VOLUMETRIC_SHAFTS_WGSL, /\bBAYER_4X4\b/);
    assert.match(VOLUMETRIC_SHAFTS_WGSL, /\bSHAFT_SLICES\s*:\s*u32\s*=\s*8u\b/);
    assert.match(VOLUMETRIC_SHAFTS_WGSL, /out\.emission\s*=\s*vec4f\(\s*0\.0\s*,\s*0\.0\s*,\s*0\.0\s*,\s*0\.0\s*\)/);
    assert.doesNotMatch(VOLUMETRIC_SHAFTS_WGSL, /\bsmoothstep\b/i, 'volumetric shafts WGSL must have zero smoothstep blur violations');
    assert.doesNotMatch(VOLUMETRIC_SHAFTS_WGSL, /gaussian|radialGradient|linearGradient/i, 'volumetric shafts WGSL must contain zero smooth gradient blurs');
});

test('every partial wind and shaft allocation is released on preparation failure', async () => {
    for (const Pass of [WindFieldCompute, VolumetricShaftsPass]) {
        const count = Pass === WindFieldCompute ? 6 : 4;
        for (let failAfter = 1; failAfter < count; failAfter++) {
            const device = createMockWebGpuDevice();
            let allocations = 0;
            for (const key of ['createBuffer', 'createTexture']) {
                const allocate = device[key].bind(device);
                device[key] = desc => {
                    if (allocations++ === failAfter) throw Error('injected allocation failure');
                    return allocate(desc);
                };
            }
            const pass = new Pass();
            await assert.rejects(pass.prepare(device), /injected allocation/);
            pass.release();
            const allocated = [...device.log.textures, ...device.log.buffers].map(obj => obj.label);
            assert.deepEqual(device.log.destroyed.sort(), allocated.sort());
        }
    }
});

test('WindFieldCompute embers:auto suspends only after the last live ember expires and recovers cleanly', async () => {
    const device = createMockWebGpuDevice();
    const pass = new WindFieldCompute({ emberCapacity: 256 });
    await pass.prepare(device);

    // 1. Freshly zeroed buffer with no hearth emitter: 0 ember passes dispatched
    pass.setWindForcing({
        baseWindX: 0.4,
        emitters: [{ cellX: 16, cellY: 64, radiusCells: 4, gustStrength: 0.7, flags: WIND_EMITTER_FLAGS.gust }],
    });
    const encIdle = createMockEncoder();
    const idleRes = pass.encode(encIdle, { dtSeconds: 0.05, embers: 'auto' });
    assert.equal(idleRes.dispatchedSteps, 1);
    assert.equal(idleRes.hasLiveEmbers, false);
    assert.equal(idleRes.emberDispatched, false);
    assert.equal(encIdle.passes.filter(p => p.label === 'w5d-wind-embers').length, 0);

    // 2. Hearth emitter activates: ember pass runs and seeds exact cooldown
    const hearth = [{ cellX: 60, cellY: 60, radiusCells: 4, gustStrength: 0.8, flags: WIND_EMITTER_FLAGS.hearth }];
    pass.setWindForcing({ emitters: hearth });
    const encActive = createMockEncoder();
    const activeRes = pass.encode(encActive, { dtSeconds: 0.05, embers: 'auto' });
    assert.equal(activeRes.hasLiveEmbers, true);
    assert.equal(activeRes.emberDispatched, true);
    assert.equal(encActive.passes.filter(p => p.label === 'w5d-wind-embers').length, 1);
    assert.equal(pass.getDiagnostics().emberCooldownDispatches, WIND_EMBER_COOLDOWN_DISPATCHES);

    // 3. Cross-check against CPU ember stepper: after spawning for 10 steps then
    // extinguishing the hearth, every spawned ember has heat <= 0.01 by the time
    // WIND_EMBER_COOLDOWN_DISPATCHES elapses.
    const cpuEmbers = new Float32Array(256 * 8);
    const emptyWind = new Float32Array(WIND_FIELD_SIZE * WIND_FIELD_SIZE * 4);
    for (let s = 0; s < 10; s++) {
        stepEmbersCpu(cpuEmbers, emptyWind, { stepIndex: s, dt: WIND_FIXED_DT_S }, hearth);
    }
    let cpuAfterCooldown = null;
    for (let s = 0; s < WIND_EMBER_COOLDOWN_DISPATCHES; s++) {
        cpuAfterCooldown = stepEmbersCpu(cpuEmbers, emptyWind, { stepIndex: 10 + s, dt: WIND_FIXED_DT_S }, []);
    }
    assert.equal(cpuAfterCooldown.activeCount, 0, 'CPU stepper must have zero live embers after cooldown');

    // 4. Extinguish hearth on GPU pass: ember pass MUST keep running for the full cooldown
    pass.setWindForcing({ emitters: [] });
    for (let d = 0; d < WIND_EMBER_COOLDOWN_DISPATCHES; d++) {
        const enc = createMockEncoder();
        const res = pass.encode(enc, { dtSeconds: 0.05, embers: 'auto' });
        assert.equal(res.emberDispatched, true, `cooldown dispatch ${d + 1}/${WIND_EMBER_COOLDOWN_DISPATCHES} must still run`);
        assert.equal(enc.passes.filter(p => p.label === 'w5d-wind-embers').length, 1);
    }

    // 5. After cooldown completes, last live ember has expired -> suspends cleanly
    assert.equal(pass.hasLiveEmbers(), false);
    const encSuspended = createMockEncoder();
    const suspRes = pass.encode(encSuspended, { dtSeconds: 0.05, embers: 'auto' });
    assert.equal(suspRes.hasLiveEmbers, false);
    assert.equal(suspRes.emberDispatched, false);
    assert.equal(encSuspended.passes.filter(p => p.label === 'w5d-wind-embers').length, 0);

    // 6. Re-ignition resumes immediately, and release/prepare resets cooldown cleanly
    pass.setWindForcing({ emitters: hearth });
    const encResume = createMockEncoder();
    const resumeRes = pass.encode(encResume, { dtSeconds: 0.05, embers: 'auto' });
    assert.equal(resumeRes.hasLiveEmbers, true);
    assert.equal(resumeRes.emberDispatched, true);

    pass.release();
    assert.equal(pass.getDiagnostics().emberCooldownDispatches, 0);
    await pass.prepare(device);
    pass.setWindForcing({ emitters: [] });
    assert.equal(pass.hasLiveEmbers(), false);
    pass.release();
});
