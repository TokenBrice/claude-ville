#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${baseUrl}/astra-height-probe`, route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    await page.goto(`${baseUrl}/astra-height-probe`);
    const result = await page.evaluate(async () => {
        const { GpuWorldRenderer } = await import('/src/presentation/character-mode/gpu/GpuWorldRenderer.js');
        const source = (color) => {
            const c = document.createElement('canvas'); c.width = c.height = 1;
            c.getContext('2d').fillStyle = color; c.getContext('2d').fillRect(0, 0, 1, 1); return c;
        };
        const albedo = source('#555555');
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 64;
        document.body.append(canvas);
        const renderer = new GpuWorldRenderer(canvas);
        const camera = { x: 0, y: 0, zoom: 1, _dpr: () => 1 };
        // 2.2 — a ground receiver (world x 16) and a lamp foot (world x 144,
        // 24 px up) with the RG8 footprint field between them.
        const feed = { lighting: { ambientLight: 0, beaconIntensity: 1 }, reducedMotion: true,
            lights: [{ id: 'probe', x: 144, y: 32, footX: 144, footY: 32, radiusWorld: 180, height: 24,
                radius: 180, intensity: 2, r: 255, g: 210, b: 150 }] };
        const sample = (blockHeight) => {
            const data = new Uint8Array(40 * 16 * 2);
            for (let y = 0; y < 16; y++) for (let x = 16; x <= 20; x++) data[(y * 40 + x) * 2] = blockHeight;
            feed.footprint = { originX: 0, originY: 0, cell: 4, width: 40, height: 16, data, revision: `block-${blockHeight}` };
            renderer.qualityLadder.reset(0);
            const ok = renderer.render({ camera, feed, records: [
                { id: 'ground', source: albedo, x: 0, y: 0, width: 160, height: 64 },
            ] });
            const gl = renderer.gl;
            const pixel = new Uint8Array(4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.sceneTarget.framebuffer);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.readPixels(16, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            return { ok, receiver: [...pixel], error: gl.getError() };
        };
        const open = sample(0);
        const low = sample(4);
        const tall = sample(200);
        const materialSample = (opaque) => {
            const material = source(opaque ? 'rgb(0,0,0)' : 'rgba(0,0,0,0)');
            renderer.qualityLadder.reset(0);
            renderer.render({ camera, feed: { lighting: { ambientLight: 1 }, reducedMotion: true }, records: [
                { id: 'material', source: albedo, materialSource: material, material: 3,
                    width: 160, height: 64, x: 0, y: 0 },
            ] });
            const gl = renderer.gl;
            const pixel = new Uint8Array(4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.sceneTarget.framebuffer);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.readPixels(80, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            return [...pixel];
        };
        const authoredUnlit = materialSample(true);
        const fallbackMetal = materialSample(false);
        renderer.dispose();
        return { open, low, tall, authoredUnlit, fallbackMetal };
    });
    assert.deepEqual(errors, []);
    for (const frame of [result.open, result.low, result.tall]) { assert.equal(frame.ok, true); assert.equal(frame.error, 0); }
    // 2.2 — a footprint taller than the ray shadows the ground receiver; one
    // lower than the ray (a short prop under a raised lamp) does not.
    assert.ok(result.open.receiver[0] > result.tall.receiver[0] + 5, JSON.stringify(result));
    assert.deepEqual(result.low.receiver, result.open.receiver);
    assert.ok(result.authoredUnlit[0] < result.fallbackMetal[0] - 5, JSON.stringify(result));
    console.log(JSON.stringify(result));
} finally { await browser.close(); }
