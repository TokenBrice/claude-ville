import assert from 'node:assert/strict';
import test from 'node:test';

import { Camera } from '../../claudeville/src/presentation/character-mode/Camera.js';

const VIEW_W = 1200;
const VIEW_H = 800;

function createFollowCamera(sprite, { centerX = 400, centerY = 300 } = {}) {
    // Camera's module imports are pure. Avoid its browser-only constructor while
    // exercising the real updateFollow implementation without a DOM or canvas.
    const camera = Object.create(Camera.prototype);
    camera.zoom = 1;
    camera.followTarget = sprite;
    camera._reducedMotion = false;
    camera._followEase = null;
    camera._followSpring = { vx: 0, vy: 0 };
    camera._followTrack = null;
    camera._viewportWidth = () => VIEW_W;
    camera._viewportHeight = () => VIEW_H;
    camera._clampToBounds = () => {};
    camera.x = VIEW_W / 2 - centerX;
    camera.y = VIEW_H / 2 - centerY;
    return camera;
}

function simulate(dtMs, { durationMs = 1000, moving = false, speedPxPerMs = 0 } = {}) {
    const sprite = { x: 0, y: 0, moving };
    const camera = createFollowCamera(sprite);
    const steps = Math.round(durationMs / dtMs);
    for (let index = 0; index < steps; index++) {
        sprite.x += speedPxPerMs * dtMs;
        camera.updateFollow(dtMs);
    }
    return { camera, sprite, center: camera.currentCenterWorld() };
}

test('Camera follow relaxes to the same frame at 30, 60, and 120 Hz', () => {
    const at30 = simulate(1000 / 30).center;
    const at60 = simulate(1000 / 60).center;
    const at120 = simulate(1000 / 120).center;

    assert.ok(Math.abs(at30.x - at60.x) < 0.5);
    assert.ok(Math.abs(at30.y - at60.y) < 0.5);
    assert.ok(Math.abs(at120.x - at60.x) < 0.5);
    assert.ok(Math.abs(at120.y - at60.y) < 0.5);
});

test('Camera follow tracks a walking villager the same way at 30, 60, and 120 Hz', () => {
    const walk = { durationMs: 3000, moving: true, speedPxPerMs: 0.12 };
    const at30 = simulate(1000 / 30, walk).center;
    const at60 = simulate(1000 / 60, walk).center;
    const at120 = simulate(1000 / 120, walk).center;
    // Window-edge decisions are per frame, so rates may differ by less than
    // one 30 Hz frame of walking (4 px), never by a visible drift.
    const oneFrameOfWalk = walk.speedPxPerMs * (1000 / 30);

    assert.ok(Math.abs(at30.x - at60.x) < oneFrameOfWalk);
    assert.ok(Math.abs(at120.x - at60.x) < oneFrameOfWalk);
});

test('Camera follow keeps a steadily walking villager inside the composition window', () => {
    const { camera, sprite } = simulate(1000 / 60, { durationMs: 4000, moving: true, speedPxPerMs: 0.12 });
    const screen = camera.worldToScreen(sprite.x, sprite.y);
    const halfW = (VIEW_W * 0.28) / 2;

    // The spring matches the walking speed, so the villager rides the window
    // edge instead of trailing out of frame.
    assert.ok(Math.abs(screen.x - VIEW_W / 2) <= halfW + 4);
});

test('Camera follow does not scroll the world while the villager walks inside the window', () => {
    const sprite = { x: 0, y: 0, moving: true };
    const camera = createFollowCamera(sprite, { centerX: 0, centerY: -0.06 * VIEW_H });
    const before = camera.currentCenterWorld();
    for (let index = 0; index < 30; index++) {
        sprite.x += 2;
        camera.updateFollow(1000 / 60);
    }
    const after = camera.currentCenterWorld();

    assert.ok(Math.abs(after.x - before.x) < 1e-9);
    assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('Camera follow does not overshoot after a 5000 ms stall', () => {
    const sprite = { x: 0, y: 0, moving: false };
    const camera = createFollowCamera(sprite, { centerX: 400, centerY: 300 });
    const aimY = -0.06 * VIEW_H;

    camera.updateFollow(5000);
    const center = camera.currentCenterWorld();

    assert.ok(center.x >= 0 && center.x <= 400);
    assert.ok(center.y >= aimY && center.y <= 300);
});
