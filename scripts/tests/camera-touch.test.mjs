import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../claudeville/src/presentation/character-mode/Camera.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

function harness() {
    const captures = new Set();
    const canvas = {
        _claudeVilleCssWidth: 412,
        _claudeVilleCssHeight: 800,
        _claudeVilleDpr: 2,
        style: {},
        getBoundingClientRect: () => ({ left: 10, top: 40, width: 412, height: 800 }),
        setPointerCapture: id => captures.add(id),
        hasPointerCapture: id => captures.has(id),
        releasePointerCapture: id => captures.delete(id),
    };
    const camera = new Camera(canvas);
    camera.x = 200;
    camera.y = -350;
    camera.zoom = 1;
    const event = (pointerId, clientX, clientY, pointerType = 'touch') => ({
        pointerId, clientX, clientY, pointerType, button: 0,
        preventDefault() { this.defaultPrevented = true; },
    });
    const down = (id, x, y, type) => {
        camera._onWindowPointerDown();
        const e = event(id, x, y, type);
        camera._onPointerDown(e);
        return e;
    };
    const move = (id, x, y) => camera._onPointerMove(event(id, x, y));
    const up = id => camera._onPointerUp(event(id, 0, 0));
    const click = (pointerType = 'touch', target = canvas) => {
        const e = {
            pointerType, target,
            preventDefault() { this.defaultPrevented = true; },
            stopImmediatePropagation() { this.stopped = true; },
        };
        camera._onTouchClick(e);
        return e;
    };
    return { camera, canvas, captures, down, move, up, click };
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test('pinch keeps the live midpoint world point, pans it, then settles on a crisp rung', () => {
    const h = harness();
    const c = h.camera;
    const worldX = 200 / c.zoom - c.x;
    const worldY = 210 / c.zoom - c.y;
    h.down(1, 160, 250);
    h.down(2, 260, 250);
    h.move(1, 130, 265);
    h.move(2, 330, 265);
    assert.ok(c.zoom > 1);
    close(220 / c.zoom - c.x, worldX);
    close(225 / c.zoom - c.y, worldY);
    const continuous = c.zoom;
    h.up(1);
    h.up(2);
    assert.equal(c._momentum, null, 'a pinch never flings');
    c.update(200);
    assert.ok(c.zoomSteps.includes(c.zoom));
    assert.ok(Math.abs(c.zoom - continuous) <= 0.25);
    close(220 / c.zoom - c.x, worldX);
    close(225 / c.zoom - c.y, worldY);
    assert.equal(c._userAdjusted, true);
    assert.equal(h.click().stopped, true);
});

test('two-to-one rebases pan without jumping and the remaining finger never flings', () => {
    const h = harness();
    h.down(1, 160, 250);
    h.down(2, 260, 250);
    h.move(2, 290, 250);
    h.up(2);
    const { x, y, zoom } = h.camera;
    h.move(1, 170, 260);
    close(h.camera.x, x + 10 / zoom);
    close(h.camera.y, y + 10 / zoom);
    h.up(1);
    assert.equal(h.camera._momentum, null);
});

test('a tap leaves follow and ownership alone; a pan consumes only a recent world touch click', () => {
    const h = harness();
    const following = {};
    h.camera.followTarget = following;
    const epoch = h.camera.inputEpoch;
    assert.equal(h.down(1, 100, 200).defaultPrevented, true);
    h.move(1, 105, 204);
    h.up(1);
    assert.equal(h.camera.followTarget, following);
    assert.equal(h.camera.inputEpoch, epoch);
    assert.equal(h.click().stopped, undefined);
    h.down(1, 100, 200);
    h.move(1, 140, 220);
    h.up(1);
    assert.equal(h.camera.followTarget, null);
    assert.equal(h.camera.dragging, false);
    assert.equal(h.click().stopped, true);
    assert.equal(h.click('mouse').stopped, undefined);
    assert.equal(h.click('touch', {}).stopped, undefined, 'chrome is never swallowed');
    h.camera._touchClickUntil = performance.now() - 1;
    assert.equal(h.click().stopped, undefined, 'an expired gesture cannot swallow a click');
    h.camera._touchClickUntil = performance.now() + 650;
    h.down(2, 140, 220);
    h.up(2);
    assert.equal(h.click().stopped, undefined, 'a fresh tap clears the consumed mark');
});

test('mouse pointers never enter the gesture map or cancel camera motion', () => {
    const h = harness();
    const follow = {};
    h.camera.followTarget = follow;
    const e = h.down(1, 100, 200, 'mouse');
    assert.equal(e.defaultPrevented, undefined);
    assert.equal(h.camera._touchPointers.size, 0);
    assert.equal(h.camera._touchGesture, null);
    assert.equal(h.camera.followTarget, follow);
});

test('cancellation releases every captured pointer and suppresses activation', () => {
    for (const cancel of ['_onPointerCancel', '_onLostPointerCapture', '_onTouchBlur']) {
        const h = harness();
        h.down(1, 100, 200);
        h.camera[cancel]({ pointerId: 1 });
        assert.equal(h.camera._touchGesture, null);
        assert.equal(h.camera._touchPointers.size, 0);
        assert.equal(h.captures.size, 0);
        assert.equal(h.click().stopped, true);
    }
});

test('long-press consumes activation even when the world has no information to show', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const info of [false, true]) {
        const h = harness();
        let shows = 0;
        h.camera.onTouchLongPress = (x, y) => {
            assert.deepEqual([x, y], [100, 200]);
            shows++;
            return info;
        };
        h.down(1, 100, 200);
        t.mock.timers.tick(500);
        assert.equal(shows, 1);
        h.up(1);
        assert.equal(h.click().stopped, true);
    }
});

test('touch expands a missed body hit but never steals exact scenery hits or selects arrivals', () => {
    const sprite = {
        x: 100, y: 200, _placeX: 100, _placeY: 200,
        _bodyBox: { left: -10, right: 10, top: -30, bottom: 4 },
        agent: { id: 'resident' }, selected: false,
        hitTest: (x, y) => x > 87 && x < 113 && y > 167 && y < 207,
        isArrivalPending: () => false,
    };
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.agentSprites = new Map([['resident', sprite]]);
    renderer._invalidateIdleFrame = () => {};
    renderer._isGateTransit = () => false;
    renderer.camera = { zoom: 2, followAgent() {}, stopFollow() {} };
    let selected = null;
    renderer.onAgentSelect = agent => { selected = agent?.id || null; };
    renderer.buildingRenderer = { hitTest: () => null };
    renderer._handleClick(119, 185, false);
    assert.equal(selected, null, 'the mouse still misses outside the body');
    renderer._handleClick(119, 185, true);
    assert.equal(selected, 'resident', '18 CSS px from the body is inside the margin');
    renderer._handleClick(123, 185, true);
    assert.equal(selected, null, '26 CSS px from the body is outside the margin');
    renderer.buildingRenderer.hitTest = () => ({ type: 'forge' });
    renderer._handleClick(119, 185, true);
    assert.equal(selected, null, 'an exact building hit wins over a nearby villager');
    renderer.buildingRenderer.hitTest = () => null;
    sprite.isArrivalPending = () => true;
    renderer._handleClick(119, 185, true);
    assert.equal(selected, null, 'pending arrivals are not selectable');
});

test('reduced-motion pinch release cuts to its nearest rung without an animation', () => {
    const h = harness();
    h.camera._reducedMotion = true;
    h.down(1, 160, 250);
    h.down(2, 260, 250);
    h.move(2, 320, 250);
    assert.equal(h.camera.zoom, 1.6);
    h.up(1);
    h.up(2);
    assert.equal(h.camera.zoom, 1.5);
    assert.equal(h.camera._zoomAnimation, null);
    assert.equal(h.camera._momentum, null);
});
