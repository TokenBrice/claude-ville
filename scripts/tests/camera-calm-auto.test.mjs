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
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

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
    director.dispose();
});

test('mid-glide abort settles fractional zoom via _settleToRestingZoom, and mouse press keeps 8 px drag slop', () => {
    const startGlideAtFractional = (camera) => {
        camera.fatFlight = true;
        camera.zoom = 1;
        camera.x = 840;
        camera.y = -100;
        camera.glideToWorld({ minX: -100, maxX: 100, minY: 500, maxY: 700 }, { maxZoom: 2, minZoom: 1, owner: 'system' });
        for (let i = 0; i < 40; i++) {
            camera.update(25);
            if (camera._directorGlide && Math.abs(camera.zoom - Math.round(camera.zoom)) > 0.15) break;
        }
        assert.ok(Math.abs(camera.zoom - Math.round(camera.zoom)) > 0.15, `expected fractional zoom, got ${camera.zoom}`);
    };

    // 1) Plain click (<= 8 px) leaves glide and follow untouched.
    const camClick = new Camera(canvasOf(1680, 1032));
    startGlideAtFractional(camClick);
    camClick._onMouseDown({ button: 0, clientX: 500, clientY: 500 });
    camClick._onMouseMove({ clientX: 505, clientY: 504 });
    camClick._onMouseUp();
    assert.equal(camClick.isDirectorGliding(), true, 'click within 8 px slop does not abort glide');
    assert.equal(camClick.dragging, false);

    const followTarget = { x: 0, y: 500, moving: false };
    camClick.followTarget = followTarget;
    camClick._onMouseDown({ button: 0, clientX: 500, clientY: 500 });
    camClick._onMouseMove({ clientX: 504, clientY: 503 });
    camClick._onMouseUp();
    assert.equal(camClick.followTarget, followTarget, 'click within 8 px slop keeps follow');

    // 2) Drag (> 8 px) aborts glide, stops follow, and settles zoom to an integer rung within 150 ms.
    const camDrag = new Camera(canvasOf(1680, 1032));
    startGlideAtFractional(camDrag);
    camDrag._onMouseDown({ button: 0, clientX: 500, clientY: 500 });
    camDrag._onMouseMove({ clientX: 520, clientY: 510 });
    assert.equal(camDrag.dragging, true);
    assert.equal(camDrag.isDirectorGliding(), false);
    assert.ok(camDrag._zoomAnimation?.aboutCenter, 'drag abort starts resting-zoom settle ease');
    camDrag._onMouseMove({ clientX: 550, clientY: 520 });
    camDrag._onMouseUp();
    camDrag.update(200);
    assert.ok(camDrag.zoomSteps.includes(camDrag.zoom), `dragged camera settled on rung: ${camDrag.zoom}`);
    assert.equal(camDrag._zoomAnimation, null);

    // 3) claimOwner, _beginTouchMotion, and setReducedMotion all settle fractional zoom.
    const camClaim = new Camera(canvasOf(1680, 1032));
    startGlideAtFractional(camClaim);
    camClaim.claimOwner('ambient');
    camClaim.update(200);
    assert.ok(camClaim.zoomSteps.includes(camClaim.zoom), `claimOwner settled on rung: ${camClaim.zoom}`);

    const camTouch = new Camera(canvasOf(1680, 1032));
    startGlideAtFractional(camTouch);
    camTouch._touchGesture = { kind: 'pan', consumed: false };
    camTouch._beginTouchMotion();
    camTouch.update(200);
    assert.ok(camTouch.zoomSteps.includes(camTouch.zoom), `_beginTouchMotion settled on rung: ${camTouch.zoom}`);

    const camReduced = new Camera(canvasOf(1680, 1032));
    startGlideAtFractional(camReduced);
    camReduced.setReducedMotion(true);
    assert.ok(camReduced.zoomSteps.includes(camReduced.zoom), `setReducedMotion snapped immediately: ${camReduced.zoom}`);
    assert.equal(camReduced._zoomAnimation, null);
});

test('AUTO holds zoom 2 for 60 s at 1920×1080 and 1440×900, and never zooms in uninvited from z1 or past medium', () => {
    for (const [label, w, h] of [['1080p', 1680, 1032], ['1440x900', 1200, 852]]) {
        const camera = new Camera(canvasOf(w, h, 1));
        camera.fatFlight = true;
        const director = new CameraDirector(camera);
        const sprites = [
            ...Array.from({ length: 8 }, (_, i) => ({
                agent: { id: `forge-${i}`, status: 'working', currentTool: 'Edit' },
                x: 20 + (i % 4) * 38, y: 780 + Math.floor(i / 4) * 32,
                moving: false, isArrivalPending: () => false,
            })),
            ...Array.from({ length: 8 }, (_, i) => ({
                agent: { id: `cmd-${i}`, status: 'working', currentTool: 'Read' },
                x: -140 + (i % 4) * 42, y: 500 + Math.floor(i / 4) * 34,
                moving: false, isArrivalPending: () => false,
            })),
            ...Array.from({ length: 8 }, (_, i) => ({
                agent: { id: `far-${i}`, status: 'working', currentTool: 'Bash' },
                x: 420 + (i % 4) * 36, y: 740 + Math.floor(i / 4) * 30,
                moving: false, isArrivalPending: () => false,
            })),
        ];
        const start = performance.now() + 120000;
        camera._lastUserInputAt = start - 120000;
        camera._lastInputAt = start - 120000;
        camera._setCenter(0, 624, 2);
        camera._cameraOwner = 'system';
        camera._userAdjusted = false;
        for (let t = 0; t <= 65000; t += 100) {
            director.update({ now: start + t, dt: 100, agentSprites: sprites });
            camera.update(100, start + t);
            if (!camera.isDirectorGliding()) {
                assert.equal(camera.zoom, 2, `${label} held zoom 2 at ${t} ms (got ${camera.zoom})`);
            }
        }
        // At z1, AUTO never zooms in uninvited.
        camera._setCenter(450, 740, 1);
        camera._cameraOwner = 'system';
        camera._userAdjusted = false;
        director._lastMoveAt = -Infinity;
        director._lastScoreAt = -Infinity;
        for (let t = 0; t <= 10000; t += 100) {
            director.update({ now: start + 80000 + t, dt: 100, agentSprites: sprites });
            camera.update(100, start + 80000 + t);
        }
        assert.equal(camera.zoom, 1, `${label} AUTO never zooms in uninvited from z1`);
        director.dispose();
    }
});

test('follow settles on shotZoom(medium), keeps user zoom when switching at >= wide, and keyboard +/- eases while keeping follow', () => {
    const camera = new Camera(canvasOf(1680, 1032, 1));
    camera.setPresented(true);
    camera.zoom = 1;
    const alice = { x: 0, y: 550, moving: false };
    const bob = { x: 240, y: 620, moving: false };

    camera.followAgent(alice);
    assert.equal(camera._snapZoom?.toZoom, 2, 'follow targets medium (z2), not tier 3');
    camera.update(500);
    assert.equal(camera.zoom, 2);

    // Keyboard '-' eases over 150 ms to z1 and keeps follow active.
    assert.equal(camera.zoomByStep(-1), true);
    assert.equal(camera.followTarget, alice, 'keyboard zoom preserves follow');
    assert.ok(camera._zoomAnimation?.aboutCenter, 'keyboard zoom uses 150 ms ease');
    camera.update(75);
    assert.ok(camera.zoom > 1 && camera.zoom < 2, `mid-ease zoom ${camera.zoom}`);
    camera.update(100);
    assert.equal(camera.zoom, 1);
    assert.equal(camera.followTarget, alice);

    // Switching to another villager while following at wide (z1) preserves z1.
    camera.followAgent(bob);
    assert.equal(camera._snapZoom, null, 'switching followed villager at >= wide keeps user zoom');
    assert.equal(camera.zoom, 1);
    assert.equal(camera.followTarget, bob);

    // Keyboard '+' eases back up to z2 and keeps follow active.
    assert.equal(camera.zoomByStep(1), true);
    camera.update(200);
    assert.equal(camera.zoom, 2);
    assert.equal(camera.followTarget, bob);
});

test('_contentFrameBox excludes gate-entering walkers and _openingContentFrameBox frames the densest cluster at medium', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    const camera = new Camera(canvasOf(1680, 1032, 1));
    renderer.camera = camera;
    renderer.world = {
        buildings: new Map([
            ['forge', { type: 'forge', x: 24, y: 26, width: 4, height: 4 }],
            ['command', { type: 'command', x: 13, y: 14, width: 4, height: 4 }],
            ['portal', { type: 'portal', x: 2, y: 29, width: 4, height: 4 }],
        ]),
    };
    renderer.gateTransits = new Map([['gate-walker', { type: 'arrival', since: Date.now() }]]);
    renderer.villageDirector = { getSnapshot: () => ({ workCohorts: [], buildingSignals: [] }) };
    renderer.agentSprites = new Map([
        ['gate-walker', {
            x: -929, y: 952, moving: true,
            isArrivalPending: () => false,
            agent: { id: 'gate-walker', status: AgentStatus.WORKING, targetBuildingType: 'forge' },
        }],
        ['pending-walker', {
            x: 0, y: 1220, moving: false,
            isArrivalPending: () => true,
            agent: { id: 'pending-walker', status: AgentStatus.WORKING, targetBuildingType: 'forge' },
        }],
        ['settled-forge', {
            x: 32, y: 840, moving: false,
            isArrivalPending: () => false,
            agent: { id: 'settled-forge', status: AgentStatus.WORKING, targetBuildingType: 'forge' },
        }],
        ['settled-portal', {
            x: -820, y: 520, moving: false,
            isArrivalPending: () => false,
            agent: { id: 'settled-portal', status: AgentStatus.WORKING, targetBuildingType: 'portal' },
        }],
    ]);

    const contentBox = renderer._contentFrameBox();
    assert.ok(contentBox.minX > -900, `gate walker SW point excluded (minX=${contentBox.minX})`);
    assert.ok(contentBox.maxY < 1000, `pending gate point excluded (maxY=${contentBox.maxY})`);

    const openingBox = renderer._openingContentFrameBox();
    const pose = camera._poseForWorldBox(openingBox, { maxZoom: camera.shotTier('medium'), minZoom: camera.shotTier('wide'), owner: 'system' });
    assert.equal(pose.zoom, 2, `densest active cluster settles at medium z2 (got ${pose.zoom})`);
});

test('A attention frame includes pending/walking destinations, uses 32 px padding, caps transit at medium, and never recoils', () => {
    const camera = new Camera(canvasOf(1680, 1032, 1));
    camera.zoom = 1;
    const director = new CameraDirector(camera);
    const waitingAtGate = {
        x: 20, y: 1180,
        targetX: 20, targetY: 1180,
        moving: false,
        waypoints: [],
        isArrivalPending: () => true,
        agent: { id: 'moss', status: AgentStatus.WAITING_ON_USER, awaitingSince: 1000 },
    };
    const frame = director.frameAttention([waitingAtGate]);
    assert.ok(frame, 'attention frame created');
    assert.ok(frame.zoom <= 2, `transit attention shot capped at medium (got ${frame.zoom})`);
    // Simulate landing and agent now actively walking from gate toward Command queue.
    camera._directorGlide = null;
    camera.zoom = camera.tierZoom(frame.zoom);
    camera._cameraOwner = 'user';
    camera._userAdjusted = true;
    waitingAtGate.isArrivalPending = () => false;
    waitingAtGate.moving = true;
    waitingAtGate.waypoints = [{ x: -128, y: 544 }];
    const landedZoom = camera.zoom;
    director._followAttentionSet([waitingAtGate], 16);
    assert.equal(camera._snapZoom, null, 'no zoom recoil after landing when walking starts');
    assert.equal(camera.zoom, landedZoom);
    director.dispose();
});
