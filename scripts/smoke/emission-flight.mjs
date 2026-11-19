// EN-1. Read the scene attachment while the same pane crosses a backing pixel.
import assert from 'node:assert/strict';
import { gpuLaunchArgs, launchChromium } from './support/chromium.mjs';
import { startIsolatedServer } from './support/isolated-server.mjs';

async function sweep({ backend, reference }) {
  const dir = '/src/presentation/character-mode/';
  const canvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
  const target = canvas(32, 32);
  let world;
  if (backend === 'webgl') {
    const { createGpuWorldRenderer } = await import(dir + 'gpu/GpuWorldRenderer.js');
    world = createGpuWorldRenderer({ canvas: target });
  } else {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const { WEBGPU_RAISED_LIMITS } = await import(dir + 'gpu/wgpu/GpuDeviceManager.js');
    const requiredLimits = Object.fromEntries(WEBGPU_RAISED_LIMITS.map(k => [k, adapter.limits[k]]));
    const device = await adapter.requestDevice({ requiredLimits });
    const { createGpuWorldRendererWebGPU } = await import(dir + 'gpu/GpuWorldRendererWebGPU.js');
    world = createGpuWorldRendererWebGPU({ canvas: target, device, adapter });
    if (!await world?.ready) throw Error(world?.initError || 'WebGPU initialization failed');
  }
  if (!world?.isActive()) throw Error(backend + ' unavailable');
  world.resize(32, 32);
  world.qualityLadder.setOverride(0);
  const { createAtmosphereSnapshot } = await import(dir + 'AtmosphereState.js');
  const a = createAtmosphereSnapshot({ now: new Date(2026, 8, 22, 22), weatherOverride: { type: 'clear' } });
  const feed = { timeMs: 10000, atmosphere: a, lighting: a.lighting, weather: a.weather, motionScale: 0,
    lights: [{ id: 'fixed', x: 14, y: 14, footX: 6, footY: 6, height: 8, radiusWorld: 16,
      radius: 40, intensity: 1, night: true, r: 255, g: 180, b: 100, priority: 2 }] };
  const camera = { zoom: 2.5, _dpr: () => 1, renderOffsetGpuX: 0, renderOffsetGpuY: 0 };
  const gl = world.gl;
  function read(framebuffer, attachment) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.readBuffer(attachment);
    const bytes = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    if (gl.getError()) throw Error('WebGL2 readback failed');
    return bytes;
  }
  async function capture(record) {
    if (!world.render({ records: [record], camera, feed, forceFreshOutput: true })) throw Error('render failed');
    if (!gl) return world.debugCaptureTargets();
    const fb = world.sceneTarget.framebuffer;
    const emission = read(fb, gl.COLOR_ATTACHMENT1);
    const scene = read(fb, gl.COLOR_ATTACHMENT0);
    return { emission, scene, composite: read(null, gl.BACK) };
  }
  const results = {};
  for (const name of ['pane', 'edge', 'closed', 'atlas', 'command']) {
    const source = canvas(16, 16);
    const side = canvas(name === 'atlas' ? 8 : 16, 16);
    const art = source.getContext('2d');
    const emit = side.getContext('2d');
    art.fillStyle = '#343840';
    // A partly transparent pane surrounded by invisible art with a green emitter.
    if (name === 'edge') {
      art.globalAlpha = 0.5;
      art.fillRect(8, 8, 1, 1);
    } else {
      art.fillRect(4, 4, 8, 8);
    }
    emit.fillStyle = '#00ff00';
    emit.fillRect(0, 0, side.width, 16);
    if (name !== 'edge') emit.clearRect(side.width / 4, 4, side.width / 2, 8);
    // On the half-width sidecar this texel covers the last two columns before the gutter.
    const paneX = name === 'atlas' ? 5 : 8;
    emit.clearRect(paneX, 8, 1, 1);
    emit.fillStyle = '#a0000080';
    emit.fillRect(paneX, 8, 1, 1);
    if (name === 'command') {
      // The tip of Command's first dome pane, with its authored colour and contribution.
      for (const [ctx, file] of [[art, 'base.png'], [emit, 'base.emissive.png']]) {
        const img = new Image();
        img.src = '/assets/sprites/buildings/building.command/' + file;
        await img.decode();
        ctx.clearRect(0, 0, 16, 16);
        ctx.drawImage(img, 142, 94, 3, 3, 7, 7, 3, 3);
      }
    }
    const record = { id: name, source, sourceWidth: 16, sourceHeight: 16, sx: 4, sy: 4, sw: 8, sh: 8,
      x: 2, y: 2, width: 8, height: 8, alpha: 1, material: 1, emissiveGate: name === 'closed' ? 0 : 0.5,
      emissiveSource: side, textureKey: name, sidecarKey: name };
    const red = [], green = [], hashes = [];
    const poses = [{ zoom: 2, phase: 0 }];
    if (!reference) {
      for (let i = 0; i <= 8; i++) poses.push({ zoom: 2.5, phase: i / 8 });
    }
    poses.push({ zoom: 3, phase: 0 });
    for (const { zoom, phase } of poses) {
      Object.assign(camera, { zoom, renderOffsetGpuX: phase, renderOffsetGpuY: 1 - phase });
      const sample = await capture(record);
      if (![sample.scene, sample.emission, sample.composite].every(bytes => bytes?.length === 32 * 32 * 4)) {
        throw Error(backend + ': missing readback target');
      }
      let r = 0, g = 0;
      for (let i = 0; i < sample.emission.length; i += 4) {
        r += sample.emission[i];
        g += sample.emission[i + 1];
      }
      red.push(r);
      green.push(g);
      if (zoom !== 2.5) {
        if (world.fatPixelsFrame) throw Error('integer pose took the flight path');
        const frame = new Blob([sample.scene, sample.emission, sample.composite]);
        const hash = await crypto.subtle.digest('SHA-256', await frame.arrayBuffer());
        hashes.push(Array.from(new Uint8Array(hash)));
      } else if (!world.fatPixelsFrame) throw Error('fractional pose missed the flight path');
    }
    results[name] = { red, green, hashes };
  }
  world.dispose();
  return results;
}

const server = await startIsolatedServer();
let browser;
try {
  browser = await launchChromium({ args: gpuLaunchArgs() });
  // Compile the previous one-fetch expression as an independent resting-frame reference.
  const referencePage = await browser.newPage();
  for (const [file, call, nearest] of [
    ['GpuWorldRenderer.js', 'sampleEmission(uv, albedo.a)', 'textureLod(u_emissiveMap, uv, 0.0)'],
    ['wgsl/scene.js', 'sampleEmission(uv, albedoRgba.a)', 'textureSampleLevel(emissiveMap, albedoSampler, uv, 0.0)'],
  ]) {
    await referencePage.route('**/gpu/' + file, async route => {
      const response = await route.fetch();
      const src = await response.text();
      assert.ok(src.includes(call), 'missing authored emission call in ' + file);
      await route.fulfill({ response, body: src.replace(call, nearest) });
    });
  }
  const page = await browser.newPage();
  for (const p of [page, referencePage]) {
    await p.route('**/emission-test', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await p.goto(server.baseUrl + '/emission-test');
  }
  for (const backend of ['webgl', 'webgpu']) {
    const rows = await page.evaluate(sweep, { backend, reference: false });
    if (!rows) {
      console.log(backend, 'skipped (no adapter)');
      continue;
    }
    const nearest = await referencePage.evaluate(sweep, { backend, reference: true });
    for (const [name, { red, green, hashes }] of Object.entries(rows)) {
      assert.deepEqual(hashes, nearest[name].hashes, backend + ' ' + name + ': integer frame changed');
      console.log(backend, name, 'red flux', red.join(', '));
      if (name !== 'command') assert.equal(Math.max(...green), 0, name + ': light from a gutter or transparent texel');
      if (name === 'closed') assert.equal(Math.max(...red), 0);
      else {
        const perTexel = red[0] / 4;
        assert.ok(perTexel > 0, name + ': no emission');
        assert.ok(Math.abs(red.at(-1) / 9 - perTexel) < 1, name + ': endpoint flux');
        // Rasterization clips the outer quad at pixel centres. Its last painted
        // column can occupy one extra half-pixel even with exact internal coverage.
        const tolerance = name === 'atlas' ? perTexel : 5;
        for (const flux of red.slice(1, -1)) {
          assert.ok(Math.abs(flux - perTexel * 2.5 ** 2) <= tolerance, name + ': ' + red.join(', '));
        }
      }
    }
  }
} finally {
  await browser?.close();
  await server.stop();
}
