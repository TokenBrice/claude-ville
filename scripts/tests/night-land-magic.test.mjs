import test from 'node:test';
import assert from 'node:assert/strict';
import { WildlifeRenderer, fireflyBudget, ashMoteBudget } from '../../claudeville/src/presentation/character-mode/WildlifeRenderer.js';
import { ambientDebugSnapshot } from '../../claudeville/src/presentation/character-mode/AmbientEvents.js';
import { drawMineCrystalGlow, drawCarvedBuildingLayer } from '../../claudeville/src/presentation/character-mode/EmitterCuts.js';

const NIGHT = { zoom: 1, phase: 'night', weatherType: 'clear', month: 6, motionScale: 1, level: 0 };
const bounds = { startX: -20, endX: 80, startY: -20, endY: 80 };
function context() {
    const fills = [];
    return { fills, save() {}, restore() {}, fillRect(...rect) { fills.push([this.fillStyle, ...rect]); } };
}
function wildlifeHost() {
    return {
        motionScale: 1, motionTimeMs: 1000, camera: { zoom: 1 },
        _lastAtmosphere: { phase: 'night', weather: { type: 'clear' }, effectiveDate: new Date(2026, 6, 15, 23) },
        _getVisibleTileBounds: () => bounds,
    };
}

test('fireflies admit twelve wide-shot lights and retain calendar/weather/motion/pressure gates', () => {
    assert.deepEqual(fireflyBudget(NIGHT), { cap: 12, reason: null });
    assert.equal(fireflyBudget({ ...NIGHT, zoom: 3 }).cap, 16);
    for (const [change, reason] of [[{ month: 0 }, 'month'], [{ month: 10 }, 'month'], [{ phase: 'day' }, 'phase'], [{ weatherType: 'rain' }, 'weather'], [{ weatherType: 'storm' }, 'weather'], [{ motionScale: 0 }, 'reduced-motion'], [{ level: 1 }, 'pressure'], [{ zoom: 0.5 }, 'zoom']]) {
        assert.deepEqual(fireflyBudget({ ...NIGHT, ...change }), { cap: 0, reason });
    }
    assert.equal(fireflyBudget({ ...NIGHT, month: 9 }).cap, 12);
});

test('firefly glow has two courses and follows motion time, not frame wall time', () => {
    const host = wildlifeHost();
    const wildlife = new WildlifeRenderer(host);
    wildlife._fireflyHomes = Array.from({ length: 16 }, (_, i) => ({ x: i * 10, y: 100, tileX: 10, tileY: 10, seed: 0 }));
    const a = context(); wildlife.drawFireflies(a, 10);
    assert.equal(wildlife._drawn.fireflies, 12);
    assert.ok(a.fills.some(([color, , , w]) => color === '#57553a' && w === 5));
    const b = context(); wildlife.drawFireflies(b, 100000000);
    assert.deepEqual(a.fills, b.fills);
    host.motionTimeMs += 50;
    const c = context(); wildlife.drawFireflies(c);
    assert.deepEqual(a.fills, c.fills, 'held inside 125 ms quantum');
    host._lastAtmosphere.phase = 'day';
    const day = context(); wildlife.drawFireflies(day);
    assert.deepEqual(day.fills, []);
});

test('ash motes are twelve year-round night spirits, held under reduced motion, shed as particles', () => {
    for (const month of [0, 3, 6, 9, 11]) assert.equal(ashMoteBudget({ ...NIGHT, month }).cap, 12);
    assert.deepEqual(ashMoteBudget({ ...NIGHT, motionScale: 0 }), { cap: 12, reason: 'reduced-motion' });
    assert.equal(ashMoteBudget({ ...NIGHT, level: 1 }).cap, 12);
    assert.deepEqual(ashMoteBudget({ ...NIGHT, level: 2 }), { cap: 0, reason: 'pressure' });
    for (const phase of ['day', 'dawn', 'dusk']) assert.deepEqual(ashMoteBudget({ ...NIGHT, phase }), { cap: 0, reason: 'phase' });
    assert.equal(ashMoteBudget({ ...NIGHT, weatherType: 'rain' }).cap, 12);
    assert.deepEqual(ashMoteBudget({ ...NIGHT, weatherType: 'storm' }), { cap: 0, reason: 'weather' });
    const host = wildlifeHost(); host.motionScale = 0;
    const wildlife = new WildlifeRenderer(host);
    const a = context(); wildlife.drawAshMotes(a);
    assert.equal(wildlife._drawn.ashMotes, 12);
    assert.ok(a.fills.some(([color, , , width]) => color === '#d1e3d8' && width === 2), 'bright two-texel cores');
    assert.ok(a.fills.some(([color, , , width]) => color === '#3e625e' && width === 5), 'dim outer glow course');
    assert.ok(a.fills.filter(([color, , y]) => (color === '#d1e3d8' || color === '#91b8aa') && y < 380).length >= 4, 'four spirits rise through trunk/canopy band');
    const b = context(); wildlife.drawAshMotes(b);
    assert.deepEqual(a.fills, b.fills);
    for (const [, ...rect] of a.fills) assert.ok(rect.every(Number.isInteger));
    host._lastAtmosphere.phase = 'day';
    const day = context(); wildlife.drawAshMotes(day); assert.equal(day.fills.length, 0);
});

test('ambient diagnostics report both night populations and reasons consistently', () => {
    const host = wildlifeHost();
    host.wildlifeRenderer = new WildlifeRenderer(host);
    const snapshot = ambientDebugSnapshot(host);
    assert.deepEqual(snapshot.actors.fireflies, { live: 0, cap: 12, reason: null });
    assert.deepEqual(snapshot.actors['ash motes'], { live: 0, cap: 12, reason: null });
    host.motionScale = 0;
    const held = ambientDebugSnapshot(host);
    assert.deepEqual(held.actors.fireflies, { live: 0, cap: 0, reason: 'reduced-motion' });
    assert.deepEqual(held.actors['ash motes'], { live: 0, cap: 12, reason: 'reduced-motion' });
});

test('Mine glow restores only existing cool crystal texels and caches its exact cut', () => {
    const previous = globalThis.document;
    const mask = { width: 3, height: 1, pixels: new Uint8ClampedArray([80, 190, 190, 255, 220, 160, 60, 255, 70, 95, 115, 0]) };
    const image = { width: 3, height: 1, pixels: new Uint8ClampedArray([80, 190, 190, 255, 220, 160, 60, 255, 70, 95, 115, 255]) };
    let built = 0;
    globalThis.document = { createElement() {
        built++;
        const canvas = { width: 0, height: 0, pixels: null };
        canvas.getContext = () => ({ drawImage(source) { canvas.pixels = source.pixels.slice(); }, clearRect() {}, getImageData() { return { data: canvas.pixels.slice() }; }, putImageData(art) { canvas.pixels = art.data; } });
        return canvas;
    } };
    try {
        const mine = { type: 'mine' };
        const drawable = { building: mine, entry: { id: 'building.mine' }, wx: 10, wy: 20, sortY: 20 };
        const renderer = {
            villageLampsLit: () => true, buildingRenderer: { enumerateDrawables: () => [drawable] },
            assets: { get: () => image, getCompanion: () => mask, getAnchor: () => [1, 1] },
        };
        const draws = [];
        const ctx = { save() {}, restore() {}, getTransform: () => ({ a: 1, b: 0 }), drawImage: (...args) => draws.push(args) };
        drawMineCrystalGlow(ctx, renderer);
        assert.deepEqual([...draws[1][0].pixels], [80, 190, 190, 255, 220, 160, 60, 0, 70, 95, 115, 0]);
        assert.deepEqual([...draws[0][0].pixels], [0, 0, 0, 0, 0, 0, 0, 0, 103, 190, 191, 76], 'cyan inner halo excludes warm emission and crystal core');
        assert.equal(ctx.globalAlpha, 0.65);
        drawMineCrystalGlow(ctx, renderer); assert.equal(built, 2, 'core and halo cached once each');
        renderer.villageLampsLit = () => false;
        drawMineCrystalGlow(ctx, renderer); assert.equal(draws.length, 4);
    } finally { globalThis.document = previous; }
});

test('building cut excludes its owner from occlusion', () => {
    const owner = { type: 'mine' };
    const canvas = { width: 4, height: 4 };
    const renderer = { assets: { get() { throw new Error('owner must not carve its own crystal'); } }, buildingRenderer: { enumerateDrawables: () => [{ building: owner, sortY: 100 }] } };
    const draws = [];
    const ctx = { getTransform: () => ({ a: 1, b: 0 }), drawImage: (...args) => draws.push(args) };
    drawCarvedBuildingLayer(ctx, renderer, { canvas, x: 0, y: 0 }, owner, 10);
    assert.deepEqual(draws, [[canvas, 0, 0]]);
});

test('building cut carves later body and landmark pixels, not earlier objects', () => {
    const previous = globalThis.document;
    const carvings = [];
    globalThis.document = { createElement() {
        const scratch = { width: 0, height: 0 };
        scratch.getContext = () => ({
            setTransform() {}, clearRect() {},
            drawImage(image) { if (this.globalCompositeOperation === 'destination-out') carvings.push(image.id); },
            fillRect() {},
        });
        return scratch;
    } };
    try {
        const owner = { type: 'mine' };
        const canvas = { width: 4, height: 4 };
        const front = { id: 'front', width: 4, height: 4 };
        const body = { id: 'body', width: 4, height: 4 };
        const renderer = {
            agentSprites: new Map([['body', { x: 0, y: 20, _depthSortY: 20, _placeX: 0, _placeY: 0, _bodyBox: { left: 0, top: 0, right: 4, bottom: 4 }, currentPoseCell: () => ({ canvas: body, dx: 0, dy: 0, sx: 0, sy: 0, sw: 4, sh: 4 }) }]]),
            assets: { get: () => front, getAnchor: () => [0, 0] },
            buildingRenderer: { enumerateDrawables: () => [
                { building: owner, sortY: 10 },
                { building: { type: 'behind' }, sortY: 5, entry: { id: 'behind' }, wx: 0, wy: 0 },
                { building: { type: 'front' }, sortY: 20, entry: { id: 'front' }, wx: 0, wy: 0 },
            ] },
        };
        const ctx = { getTransform: () => ({ a: 1, b: 0 }), drawImage() {} };
        drawCarvedBuildingLayer(ctx, renderer, { canvas, x: 0, y: 0 }, owner, 10);
        assert.deepEqual(carvings, ['body', 'front']);
    } finally { globalThis.document = previous; }
});
