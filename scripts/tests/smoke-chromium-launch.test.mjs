// Plan T6: the browser smokes launch on Linux. The per-platform GPU flags,
// the system Chrome fallback, and the integer water hash that keeps the
// WebGL2 and WebGPU seas bit-exact off Apple hardware.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { gpuLaunchArgs, systemChromePath } from '../smoke/support/chromium.mjs';
import { SEA_SWELL_GLSL } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { SEAM_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/seam.js';
import { WATER_SCENE_WGSL, WATER_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/water.js';

test('GPU flags: Metal ANGLE on macOS, Vulkan ANGLE with WebGPU on Linux, never Metal elsewhere', () => {
    assert.ok(gpuLaunchArgs('darwin').includes('--use-angle=metal'));
    const linux = gpuLaunchArgs('linux');
    assert.ok(linux.includes('--use-angle=vulkan'));
    assert.ok(linux.includes('--enable-features=Vulkan'));
    assert.ok(linux.includes('--enable-unsafe-webgpu'));
    assert.ok(!linux.some(arg => arg.includes('metal')));
    assert.ok(!gpuLaunchArgs('win32').some(arg => arg.includes('metal')));
    for (const platform of ['darwin', 'linux', 'win32']) assert.ok(gpuLaunchArgs(platform).includes('--ignore-gpu-blocklist'));
});

test('system Chrome fallback takes the first existing candidate for the platform', () => {
    const present = new Set(['/usr/bin/chromium']);
    assert.equal(systemChromePath({ platform: 'linux', exists: path => present.has(path) }), '/usr/bin/chromium');
    present.add('/usr/bin/google-chrome-stable');
    assert.equal(systemChromePath({ platform: 'linux', exists: path => present.has(path) }), '/usr/bin/google-chrome-stable');
    assert.equal(systemChromePath({ platform: 'linux', exists: () => false }), null);
    assert.equal(systemChromePath({ platform: 'plan9', exists: () => true }), null);
});

const GLSL_SOURCE = fs.readFileSync(new URL('../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js', import.meta.url), 'utf8');

function fnBody(source, header, next) {
    const start = source.indexOf(header);
    assert.ok(start >= 0, `missing ${header}`);
    const end = source.indexOf(next, start + header.length);
    return source.slice(start, end < 0 ? undefined : end);
}

test('seaNoise, swell caps and rain rings hash on the integer lattice in both dialects', () => {
    assert.match(SEA_SWELL_GLSL, /float waterLatticeHash\(vec2 p\)/);
    assert.match(SEAM_WGSL, /fn waterLatticeHash\(p: vec2f\) -> f32/);
    // The GLSL scene fragment defaults int to mediump: the hash must say highp.
    assert.match(fnBody(SEA_SWELL_GLSL, 'float waterLatticeHash', 'float waterBayer2'), /highp uint h/);
    const sites = [
        [SEA_SWELL_GLSL, 'float seaNoise(', 'float seaContourRows'],
        [SEAM_WGSL, 'fn seaNoise(', 'fn seaContourRows'],
        [SEA_SWELL_GLSL, 'float swellCap(', 'float seaKeyReach'],
        [WATER_WGSL, 'fn swellCap(', 'fn seaKeyReach'],
        [WATER_SCENE_WGSL, 'fn rainRingAt(', 'fn causticAt'],
        [GLSL_SOURCE, 'bool rainRingAt(', 'bool causticAt'],
    ];
    for (const [source, header, next] of sites) {
        const body = fnBody(source, header, next);
        assert.ok(body.includes('waterLatticeHash('), `${header} uses waterLatticeHash`);
        assert.ok(!body.includes('waterHash12('), `${header} has no float waterHash12`);
    }
});
