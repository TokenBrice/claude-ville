import test from 'node:test';
import assert from 'node:assert/strict';

import {
    Camera,
    clampPadFor,
    islandAreaInWorldRect,
    landWeightSeaCap,
} from '../../claudeville/src/presentation/character-mode/Camera.js';
import {
    CameraDirector,
    frameShowsVillage,
    shareInInnerFrame,
} from '../../claudeville/src/presentation/character-mode/CameraDirector.js';

// The World canvas in CSS px (a 2540 × 1400 window less the 240 px sidebar and
// the 48 px top bar) at backing DPR 1.
const canvasOf = (w, h, dpr = 1) => ({
    _claudeVilleCssWidth: w,
    _claudeVilleCssHeight: h,
    _claudeVilleDpr: dpr,
    style: {},
    addEventListener() {},
    removeEventListener() {},
});
const ISLAND_CENTRE = { x: 0, y: 624 };
const ISLAND_AREA = islandAreaInWorldRect(-1e6, -1e6, 1e6, 1e6);
const centreOf = (camera, pose) => ({
    x: camera._viewportWidth() / (2 * pose.zoom) - pose.x,
    y: camera._viewportHeight() / (2 * pose.zoom) - pose.y,
});
const ordinaryOptions = (owner) => ({
    maxZoom: 1, minZoom: 1, paddingPx: 220, owner, composition: { x: 0.5, y: 0.55 }, preferPan: true, allowZoomIn: false,
});

test('automatic owners get the tight clamp pad; the operator and the release cue keep the generous one', () => {
    assert.deepEqual(clampPadFor('idle-auto', 2300, 1352, 1), { x: 2300 * 0.12, y: 1352 * 0.12 });
    assert.deepEqual(clampPadFor('director', 2300, 1352, 3), { x: 96, y: 96 });
    for (const owner of [null, 'user', 'cue:release']) {
        const pad = clampPadFor(owner, 2300, 1352, 1);
        assert.ok(Math.abs(pad.x - 2300 / 2.2) < 1e-9 && Math.abs(pad.y - 1352 / 2.2) < 1e-9, String(owner));
    }
    assert.deepEqual(clampPadFor('user', 1000, 600, 3), { x: 220, y: 160 });

    const camera = new Camera(canvasOf(2300, 1352));
    const far = { x: 4000, y: 624 };
    assert.equal(camera._clampedCenter(far.x, far.y, 1, 'cue:arrival').x, 1248 + 276);
    assert.equal(camera._clampedCenter(far.x, far.y, 1, 'cue:release').x, 1248 + 2300 / (1 * 2.2));
    assert.equal(camera._clampedCenter(far.x, far.y, 1).x, 1248 + 2300 / (1 * 2.2), 'the resting clamp is unchanged');
});

test('the sea cap is 30 % where the island fills the view and a reachable promise where it cannot', () => {
    assert.equal(landWeightSeaCap(1150, 676), 0.30);
    const viewW = 2300;
    const viewH = 1352;
    const cap = landWeightSeaCap(viewW, viewH);
    assert.ok(Math.abs(cap - (1 - ISLAND_AREA / (viewW * viewH) + 0.05)) < 1e-12);
    const centredSea = 1 - islandAreaInWorldRect(
        ISLAND_CENTRE.x - viewW / 2, ISLAND_CENTRE.y - viewH / 2,
        ISLAND_CENTRE.x + viewW / 2, ISLAND_CENTRE.y + viewH / 2,
    ) / (viewW * viewH);
    assert.ok(centredSea <= cap, `centred sea ${centredSea} reaches cap ${cap}`);
});

test('an automatic whole-island shot keeps the island centre within 10 % of the frame centre', () => {
    const camera = new Camera(canvasOf(2300, 1352));
    for (const cx of [-800, -500, 500, 800]) {
        for (const cy of [300, 624, 950]) {
            const box = { minX: cx - 300, maxX: cx + 300, minY: cy - 200, maxY: cy + 200 };
            const auto = centreOf(camera, camera._poseForWorldBox(box, ordinaryOptions('idle-auto')));
            assert.ok(Math.abs(auto.x - ISLAND_CENTRE.x) <= 2300 * 0.1 + 16, `x for box at ${cx},${cy}: ${auto.x}`);
            assert.ok(Math.abs(auto.y - ISLAND_CENTRE.y) <= 1352 * 0.1 + 16, `y for box at ${cx},${cy}: ${auto.y}`);
            const operator = centreOf(camera, camera._poseForWorldBox(box, ordinaryOptions('user')));
            assert.equal(operator.x, cx, 'an operator pose is never land-weighted');
        }
    }
});

test('the idle breath holds still at tier 1 and breathes on a closer rung', () => {
    const camera = new Camera(canvasOf(2300, 1352));
    const breathe = (zoom) => {
        camera.zoom = zoom;
        camera.x = 100;
        camera.y = 50;
        camera._idleDrift = null;
        camera._lastInputAt = 0;
        const seen = new Set();
        for (let t = 60000; t < 80000; t += 500) {
            camera._updateIdleDrift(500, t);
            seen.add(`${camera.x.toFixed(3)},${camera.y.toFixed(3)}`);
        }
        return seen.size;
    };
    assert.equal(breathe(camera.tierZoom(1)), 1);
    assert.ok(breathe(camera.tierZoom(2)) > 1);
});

test('a frame showing at least 80 % of the bodies in its inner 80 % counts as showing the village', () => {
    const identity = (x, y) => ({ x, y });
    const inside = Array.from({ length: 8 }, (_, i) => ({ x: 200 + i * 10, y: 300 }));
    const outside = [{ x: 5, y: 300 }, { x: 990, y: 300 }];
    assert.equal(shareInInnerFrame([...inside, ...outside], identity, 1000, 600), 0.8);
    assert.equal(frameShowsVillage([...inside, ...outside], identity, 1000, 600), true);
    assert.equal(frameShowsVillage([...inside.slice(1), ...outside, { x: 500, y: 10 }], identity, 1000, 600), false);
    assert.equal(frameShowsVillage([], identity, 1000, 600), false);
});

test('ordinary Auto widens its dead zone to 0.26; Ambient keeps 0.18 and cues 0.22', () => {
    const w = 1000;
    const h = 1000;
    const offset = 0.24 * w;
    const camera = {
        _viewportWidth: () => w,
        _viewportHeight: () => h,
        worldToScreen: (x, y) => ({ x, y }),
    };
    const cx = w / 2 + offset;
    const box = { minX: cx - 60, maxX: cx + 60, minY: 490, maxY: 610 };
    const director = { camera };
    assert.equal(CameraDirector.prototype._isFrameComfortable.call(director, box, { ordinary: true }), true);
    assert.equal(CameraDirector.prototype._isFrameComfortable.call(director, box), false);
    assert.equal(CameraDirector.prototype._isFrameComfortable.call(director, box, { event: true }), false);
});

test('a 10 minute Auto soak at the whole-island rung barely moves and keeps the island centred', () => {
    const camera = new Camera(canvasOf(2300, 1352));
    camera.fatFlight = true;
    const director = new CameraDirector(camera);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const spots = [[-80, 536], [-700, 640], [520, 560], [300, 860], [-300, 380], [700, 720], [40, 980], [-500, 820]];
    const place = (sprite) => {
        const [x, y] = spots[Math.floor(rand() * spots.length)];
        sprite.x = x + (rand() - 0.5) * 120;
        sprite.y = y + (rand() - 0.5) * 60;
    };
    const sprites = Array.from({ length: 24 }, (_, i) => {
        const sprite = { agent: { id: `a${i}`, status: 'working' }, moving: false, isArrivalPending: () => false };
        place(sprite);
        return sprite;
    });
    const start = performance.now() + 120000;
    camera._lastUserInputAt = start - 120000;
    camera._lastInputAt = start - 120000;
    camera.fitToWorldBox({ minX: -900, maxX: 900, minY: 300, maxY: 1000 }, { owner: 'system', maxZoom: 1, minZoom: 1 });
    let previous = null;
    let intervals = 0;
    let moving = 0;
    for (let t = 0; t <= 600000; t += 50) {
        if (t > 0 && t % 30000 === 0) for (let k = 0; k < 4; k++) place(sprites[Math.floor(rand() * sprites.length)]);
        director.update({ now: start + t, dt: 50, agentSprites: sprites });
        camera.update(50, start + t);
        if (t % 3500 !== 0) continue;
        const centre = camera.currentCenterWorld();
        assert.ok(Math.abs(centre.x - ISLAND_CENTRE.x) * camera.zoom <= 2300 * 0.1, `island centre at ${t} ms`);
        if (previous) {
            intervals += 1;
            if (Math.hypot(centre.x - previous.x, centre.y - previous.y) > 0.5) moving += 1;
        }
        previous = centre;
    }
    assert.ok(moving / intervals < 0.15, `${moving} of ${intervals} intervals moving`);
});
