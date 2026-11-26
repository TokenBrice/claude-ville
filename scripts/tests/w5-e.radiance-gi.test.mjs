import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDistrictRadianceCompute, DISTRICT_MEMORY_BYTES, DISTRICT_ORIGIN,
    evaluateDistrictRadianceReference, GI_FRONTIER_MASK_BIT,
} from '../../claudeville/src/presentation/character-mode/gpu/wgpu/DistrictRadianceCompute.js';
import {
    DISTRICT_RADIANCE_WGSL, DISTRICT_RECEIVER_WGSL, RADIANCE_INTERVALS, RADIANCE_STRATA_H,
} from '../../claudeville/src/presentation/character-mode/gpu/wgsl/radiance.js';
import { FRONTIER_SHED_ORDER, resolveFrontierPolicy } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

function pilot() {
    const slabs = new Uint16Array(256 * 256 * 4);
    const fluxOpacity = new Uint8Array(256 * 256 * 4 * 3);
    function source(x0, y0, x1, y1, layer, color) {
        for (let y = y0 / 4; y < y1 / 4; y++) {
            for (let x = x0 / 4; x < x1 / 4; x++) fluxOpacity.set(color, ((layer * 256 + y) * 256 + x) * 4);
        }
    }
    function wall(x0, y0, x1, y1, intervals = [0, 180, 1, 0]) {
        for (let y = y0 / 4; y < y1 / 4; y++) {
            for (let x = x0 / 4; x < x1 / 4; x++) {
                const k = (y * 256 + x) * 4;
                slabs.set(intervals, k);
                fluxOpacity[k + 3] = 255;
            }
        }
    }
    source(900, 820, 928, 860, 0, [250, 90, 12]);
    source(40, 160, 72, 208, 1, [50, 10, 180]);
    wall(940, 0, 944, 1024);
    function at(x, y, height, options) {
        return evaluateDistrictRadianceReference({ slabs, fluxOpacity }, {
            x: x + DISTRICT_ORIGIN[0], y: y + DISTRICT_ORIGIN[1], height, ...options,
        });
    }
    return { slabs, fluxOpacity, wall, at };
}

test('district shader uses four bounded cascades and separate sampled and storage bindings', () => {
    assert.deepEqual(RADIANCE_INTERVALS, [0, 8, 32, 128, 512]);
    assert.deepEqual(RADIANCE_STRATA_H, [4, 28, 76]);
    assert.deepEqual(DISTRICT_ORIGIN, [-928, 944]);
    assert.match(DISTRICT_RADIANCE_WGSL, /@binding\(1\) var slabs: texture_2d<u32>/);
    assert.match(DISTRICT_RADIANCE_WGSL, /@binding\(2\).*texture_storage_2d_array<rgba8uint, write>/);
    for (const name of ['districtCascade','districtResolve']) assert.match(DISTRICT_RADIANCE_WGSL,new RegExp('fn '+name+'\\('));
    assert.doesNotMatch(DISTRICT_RADIANCE_WGSL + DISTRICT_RECEIVER_WGSL,/smoothstep|textureSample/);
    assert.match(DISTRICT_RECEIVER_WGSL,/role != 0u/);
    assert.match(DISTRICT_RECEIVER_WGSL,/dot\(rgb,weights\) <= \.74/);
    assert.match(DISTRICT_RECEIVER_WGSL,/dot\(districtLinear\(rgb\),weights\) <= \.70/);
    assert.equal(GI_FRONTIER_MASK_BIT, 32);
});

test('Forge hearth illuminates air-side stone and arch, with zero leakage across one masonry cell', () => {
    const { at, fluxOpacity } = pilot();
    assert.deepEqual(at(936, 840, 4).bounce, [24, 10, 4]);
    assert.deepEqual(at(936, 840, 76).bounce, [12, 5, 2]);
    for (const height of RADIANCE_STRATA_H) assert.deepEqual(at(952, 840, height).bounce, [0, 0, 0]);
    for (let row = 0; row < 256; row++) fluxOpacity[(row * 256 + 235) * 4 + 3] = 128;
    assert.equal(at(952, 840, 4).course, 1);
    // A rear-face texel in the same 16 px probe footprint as the warm front.
    const split = pilot();
    split.fluxOpacity.fill(0);
    split.fluxOpacity.set([250, 90, 12], (210 * 256 + 234) * 4);
    split.wall(932, 0, 936, 1024);
    assert.ok(split.at(936, 840, 4).course > 0);
    assert.deepEqual(split.at(929, 840, 4).bounce, [0, 0, 0]);
    assert.deepEqual(at(-1, 840, 4).bounce, [0, 0, 0]);
});

test('Portal violet reaches feet and arch via pitched rays and travels beyond the third interval', () => {
    const { at, wall } = pilot();
    const receivers = RADIANCE_STRATA_H.map(h => at(88, 184, h));
    assert.deepEqual(receivers.map(r => r.stratum), [4, 28, 76]);
    assert.deepEqual(receivers.map(r => r.course), [1, 2, 1]);
    assert.deepEqual(receivers.map(r => r.bounce), [[8, 3, 13], [16, 6, 26], [8, 3, 13]]);
    assert.deepEqual(at(240, 184, 28).bounce, [8, 3, 13]);
    // An elevated deck across the scene cuts every pitched arch-to-torso connection.
    wall(0, 0, 256, 320, [1, 0, 48, 49]);
    assert.deepEqual(at(88, 184, 76).bounce, [0, 0, 0]);
    assert.deepEqual(at(88, 184, 28).bounce, [16, 6, 26]);
});

test('eight azimuth bins distinguish the open plaza, an open-ended alley, and the arch above it', () => {
    const { at, wall } = pilot();
    assert.deepEqual(at(328, 392, 4).skyBins, Array(8).fill(1));
    wall(312, 240, 316, 548, [0, 48, 72, 74]);
    wall(340, 240, 344, 548, [0, 48, 72, 74]);
    const alley = at(328, 392, 4);
    assert.deepEqual(alley.skyBins, [0, 0, 1, 0, 0, 0, 1, 0]);
    assert.ok(alley.skyOpenness < 0.4);
    assert.equal(at(328, 392, 76).skyOpenness, 1);
});

test('Role 0 final sRGB bytes respect both luminance ceilings and saturation after landing', () => {
    const { at } = pilot();
    const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    for (const base of [[1, 1, 1], [0.9, 0.02, 0.01], [0, 1, 1], [0.99, 0.83, 0.24], [0.07, 0.09, 0.13]]) {
        const { encoded, emission, course } = at(936, 840, 4, { base });
        assert.equal(course, 2);
        assert.ok(luminance(encoded) <= 0.74);
        assert.ok(luminance(encoded.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) <= 0.70);
        const v = Math.max(...encoded);
        if (v >= 0.5) assert.ok(1 - Math.min(...encoded) / v <= 0.65);
        assert.deepEqual(emission, [0, 0, 0, 0]);
        for (const role of [1, 2]) {
            const protectedFace = at(936, 840, 4, { base, role });
            assert.deepEqual(protectedFace.encoded, base);
            assert.deepEqual(protectedFace.bounce, [0, 0, 0]);
            assert.deepEqual(protectedFace.emission, [0, 0, 0, 0]);
        }
    }
});

function mockGpu() {
    const allocations = [], passes = [], uploads = [];
    function resource(bytes) {
        const res = { bytes, destroyed: 0, destroy() { this.destroyed++; } };
        allocations.push(res);
        return res;
    }
    const device = {
        createBindGroupLayout: desc => desc,
        createPipelineLayout: desc => desc,
        createShaderModule: desc => desc,
        createComputePipelineAsync: async desc => desc.compute.entryPoint,
        createBindGroup: desc => desc.entries.map(e => e.resource),
        createTexture({ size, format }) {
            const [w, h, d] = size;
            const tex = resource(w * h * d * (format === 'rgba16uint' ? 8 : 4));
            tex.createView = () => ({ texture: tex });
            return tex;
        },
        createBuffer: ({ size }) => resource(size),
        queue: {
            writeBuffer(buffer, offset, data) { buffer.data = new Uint32Array(data).slice(); },
            writeTexture(...args) { uploads.push(args); },
        },
    };
    const encoder = {
        beginComputePass(descriptor) {
            const dispatches = [];
            passes.push({ descriptor, dispatches });
            let pipeline, bindings;
            return {
                setPipeline(p) { pipeline = p; },
                setBindGroup(slot, b) { assert.equal(slot, 0); bindings = b; },
                dispatchWorkgroups(...size) {
                    assert.notEqual(bindings[2].texture, bindings[3].texture);
                    dispatches.push({ size, pipeline, bindings, level: bindings[0].buffer.data[0] });
                },
                end() {},
            };
        },
    };
    return { device, encoder, passes, allocations, uploads };
}

test('only complete 4 Hz generations are published, and kill/release return every allocated byte', async () => {
    const { device, encoder, passes, allocations, uploads } = mockGpu();
    const compute = createDistrictRadianceCompute();
    await compute.prepare(device);
    assert.equal(compute.encode(encoder), null);
    assert.equal(allocations.length, 0);
    const district = pilot();
    await compute.prepare(device, { enabled: true, district });
    assert.equal(uploads.length, 2);
    const bytes = allocations.reduce((n, r) => n + r.bytes, 0);
    assert.equal(bytes, DISTRICT_MEMORY_BYTES.total);
    assert.equal(bytes, compute.getDiagnostics().residentBytes);
    assert.ok(bytes <= Math.min(5740000, 5.47 * 1024 ** 2));
    assert.equal(compute.getCurrentFieldView(), null);
    const timestamps = { querySet: {}, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    const first = compute.encode(encoder, { timestampWrites: timestamps });
    assert.equal(passes[0].descriptor.timestampWrites, timestamps);
    assert.ok(first);
    const jobs = passes[0].dispatches;
    assert.deepEqual(jobs.map(j => j.level), [3, 2, 1, 0, 0]);
    assert.deepEqual(jobs.map(j => j.pipeline), [...Array(4).fill('districtCascade'),'districtResolve']);
    assert.deepEqual(jobs.map(j => j.size), [...Array(4).fill([32, 16, 3]), [8, 8, 3]]);
    for (let i = 1; i < 5; i++) assert.equal(jobs[i].bindings[3], jobs[i - 1].bindings[2]);
    assert.equal(first, jobs.at(-1).bindings[2]);
    assert.equal(compute.encode(encoder, { dtSeconds: 0.249 }), first);
    assert.equal(passes.length, 1);
    const second = compute.encode(encoder, { dtSeconds: 0.001 });
    assert.notEqual(second, first);
    assert.equal(compute.encode(encoder, { dtSeconds: 2, reducedMotion: true }), second);
    assert.equal(passes.length, 2);
    compute.setDistrict(district);
    assert.equal(compute.getCurrentFieldView(), null);
    assert.equal(compute.encode(encoder, { reducedMotion: true }), first);
    assert.equal(compute.encode(encoder, { enabled: false }), null);
    assert.equal(compute.getDiagnostics().residentBytes, 0);
    assert.equal(compute.getDiagnostics().frontierMaskBit, 0);
    compute.release();
    assert.ok(allocations.every(r => r.destroyed === 1));
    assert.equal(passes.length, 3);
});

test('failed and superseded preparation cannot publish resources', async () => {
    const { device, allocations } = mockGpu();
    const compute = createDistrictRadianceCompute({ enabled: true });
    const preparing = compute.prepare(device);
    compute.release();
    await preparing;
    assert.equal(allocations.length, 0);
    device.queue.writeBuffer = () => { throw new Error('upload failed'); };
    await assert.rejects(compute.prepare(device), /upload failed/);
    assert.equal(compute.getDiagnostics().residentBytes, 0);
    assert.ok(allocations.every(r => r.destroyed === 1));
    await assert.rejects(compute.prepare(device, { district: {} }), /Expected 256/);
});

test('each over-budget p95 sample sheds exactly one enabled feature in order', () => {
    assert.deepEqual(FRONTIER_SHED_ORDER, ['shafts','gi','mirrorCadence','windRippleDensity']);
    assert.ok(Object.isFrozen(FRONTIER_SHED_ORDER));
    for (const [ultrawide, frameCeilingMs] of [[false, 8.50], [true, 12.90]]) {
        const options = { backend: 'webgpu', qualityTier: 'FULL', giEvidencePromoted: true, ultrawide,
            frontierFlags: { surfaceDepth: true, waterlineContact: true } };
        let policy = resolveFrontierPolicy({ ...options, frameTimeMs: frameCeilingMs });
        assert.equal(policy.shed, null);
        assert.equal(policy.frameCeilingMs, frameCeilingMs);
        for (const key of FRONTIER_SHED_ORDER) {
            const prev = policy.frontierFlags;
            policy = resolveFrontierPolicy({ ...options, frontierFlags: prev, frameTimeMs: frameCeilingMs + 0.01 });
            assert.equal(policy.shed, key);
            assert.deepEqual(policy.frontierFlags, { ...prev, [key]: false });
            assert.ok(policy.depthCorrectness && policy.waterlineContact);
            assert.ok(policy.frontierFlags.surfaceDepth && policy.frontierFlags.waterlineContact);
        }
    }
    const webgpu = { backend: 'webgpu' };
    assert.equal(resolveFrontierPolicy(webgpu).frontierFlags.gi, false);
    assert.equal(resolveFrontierPolicy({ ...webgpu, frontierFlags: { gi: true }, giEvidencePromoted: false }).frontierFlags.gi, false);
    assert.equal(resolveFrontierPolicy({ ...webgpu, frontierFlags: { giPilot: true } }).frontierFlags.gi, true);
    assert.equal(resolveFrontierPolicy({ ...webgpu, frontierFlags: { gi: false, giPilot: true } }).frontierFlags.gi, false);
    for (const backend of ['canvas','webgl']) {
        assert.equal(resolveFrontierPolicy({ backend, giEvidencePromoted: true }).frontierFlags.gi, false);
    }
    assert.equal(resolveFrontierPolicy({ ...webgpu, qualityTier: 'REDUCED', giEvidencePromoted: true }).frontierFlags.gi, false);
    assert.equal(resolveFrontierPolicy({ ...webgpu, reducedMotion: true }).frontierFlags.mirrorCadence, false);
});
