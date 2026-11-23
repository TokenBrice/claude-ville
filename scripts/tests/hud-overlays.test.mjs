import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { ChronicleMonuments } from '../../claudeville/src/presentation/character-mode/ChronicleMonuments.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import {
    attentionScreenRects,
    layoutAttentionPlates,
} from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';
import {
    getReservedRect,
    getReservedRects,
    publishReservedBox,
    unpublishReservedRect,
} from '../../claudeville/src/presentation/shared/ReservedRects.js';
import { Toast } from '../../claudeville/src/presentation/shared/Toast.js';

function rendererWithViewport(width = 1200, height = 800, zoom = 1) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.camera = {
        zoom,
        worldToScreen: (x, y) => ({ x: x * zoom, y: y * zoom }),
        screenToWorld: (x, y) => ({ x: x / zoom, y: y / zoom }),
    };
    renderer._screenViewport = () => ({ width, height });
    renderer._overlayBubbleOrder = [];
    renderer._overlayBubbleBaseRects = [];
    renderer._overlayBubbleOccupiedRects = [];
    renderer._overlayBubbleClusters = [];
    renderer._overlayBubbleClusterCount = 0;
    renderer._overlayBubbleGroups = new Map();
    renderer._overlayBubbleGrid = renderer._createRectGrid();
    renderer._overlayClusterGrid = renderer._createRectGrid();
    renderer._agentLabelHitRects = [];
    renderer._attentionWorldRects = [];
    renderer.buildingRenderer = { identityWorldRects: [] };
    return renderer;
}

function speaker(id, x, y, text = 'Inspecting left-edge viewport clamping', extra = {}) {
    const entry = { text, accent: '#f2d36b', confidence: null, shape: 'speech', badge: '' };
    return {
        agent: { id, name: id, status: AgentStatus.WORKING },
        x,
        y,
        selected: false,
        addedAt: -60_000,
        _dialogueDisplayUntil: extra.fresh ?? 1000,
        _activitySnapshot: entry,
        _activityThread: () => [entry],
        _shouldUseLongWaitClock: () => false,
        thoughtRepoAccent: () => '#77aa88',
        thoughtSpeakerTag: () => id.slice(0, 3).toUpperCase(),
        _providerTrimColor: () => '#ffffff',
        _statusVisual: () => ({ color: '#f2d36b' }),
        ...extra,
    };
}

test('offscreen speakers skip thought slots and do not consume THOUGHT_BUDGET', () => {
    const renderer = rendererWithViewport(1200, 800, 1);
    const offscreen = Array.from({ length: 8 }, (_, i) =>
        speaker(`off-${i}`, -200 - i * 40, 400, `Offscreen ${i}`, { fresh: 9000 + i }));
    const onscreen = speaker('visible', 500, 400, 'Visible speaker', { fresh: 100 });
    renderer._assignAgentBubbleSlots([...offscreen, onscreen], 1, [], false, 1000);
    for (const sprite of offscreen) {
        assert.equal(sprite.bubbleSlot, null, `${sprite.agent.id} should not claim a slot offscreen`);
    }
    assert.notEqual(onscreen.bubbleSlot, null, 'visible speaker still gets a thought slot');
});

test('near-edge speakers stay inside [8, width-8] preferring inward lateral slots then horizontal clamping', () => {
    const renderer = rendererWithViewport(1200, 800, 1);
    // Speaker at x=25: slot 0 overflows left; inward lateral (+1) puts left >= 25 >= 8.
    const nearLeft = speaker('near-left', 25, 400, 'Inspecting left-edge viewport clamping');
    renderer._assignAgentBubbleSlots([nearLeft], 1, [], false, 1000);
    assert.notEqual(nearLeft.bubbleSlot, null);
    assert.ok(nearLeft._thoughtRects.body.x >= 8, `left ${nearLeft._thoughtRects.body.x} >= 8`);
    assert.ok(nearLeft._thoughtRects.body.x + nearLeft._thoughtRects.body.w <= 1200 - 8);
    assert.equal(nearLeft.bubbleClampX, 0, 'inward lateral slot fits without clamping');

    // Speaker right on the left edge (x=2) with all inward lateral slots blocked:
    // must clamp horizontally while keeping the leader anchored to the speaker.
    const edgeSpeaker = speaker('edge-clamp', 2, 400, 'Inspecting left-edge viewport clamping', { selected: true });
    renderer._assignAgentBubbleSlots([edgeSpeaker], 1, [], false, 2000);
    assert.notEqual(edgeSpeaker.bubbleSlot, null);
    const body = edgeSpeaker._thoughtRects.body;
    assert.ok(body.x >= 8, `clamped left ${body.x} >= 8`);
    assert.ok(body.x + body.w <= 1200 - 8, `clamped right ${body.x + body.w} <= 1192`);
    assert.equal(edgeSpeaker._thoughtRects.leader, true, 'clamped bubble draws leader to speaker');
});

test('thought placement avoids reserved chrome rects and passes placed thoughts into plaque collision list', () => {
    const renderer = rendererWithViewport(1200, 800, 1);
    publishReservedBox('test-chrome', { left: 900, top: 340, right: 1190, bottom: 440 });
    try {
        const sprite = speaker('under-chrome', 1050, 410, 'Checking chrome avoidance');
        renderer._assignAgentBubbleSlots([sprite], 1, [], false, 1000);
        assert.notEqual(sprite.bubbleSlot, null);
        const body = sprite._thoughtRects.body;
        const hitsChrome = body.x < 1190 && body.x + body.w > 900 && body.y < 440 && body.y + body.h > 340;
        assert.equal(hitsChrome, false, 'placed thought clears reserved chrome');

        const hitRects = renderer._collectAgentLabelHitRects([sprite]);
        assert.ok(hitRects.includes(body), 'placed thought body is forwarded to buildingRenderer.identityWorldRects');
        assert.equal(renderer.buildingRenderer.identityWorldRects, hitRects);
    } finally {
        publishReservedBox('test-chrome', null);
    }
});

test('Harbor beginPlateFrame and _drawRepoAnchorage clamp plates inside the viewport', () => {
    const harbor = Object.create(HarborTraffic.prototype);
    harbor._plateBoxes = [];
    harbor._leadPlateLift = new Map();
    harbor._plateCharWidthPx = 7;
    harbor._houseHit = null;
    harbor.motionScale = 0;
    harbor._markerFade = () => 1;
    harbor._plateBase = () => -24;
    harbor._hasShipBadge = () => false;
    harbor._plateSpec = () => ({ lead: true, text: 'pharos-watch · 6 br', count: 6, failed: false });
    const ship = { id: 'lead-1', x: 1190, y: 500, laneLead: true, repoFleetLead: true, status: 'docked' };
    harbor._packedDockedEntries = [{ drawable: { payload: ship } }];
    const camera = { worldToScreen: (x, y) => ({ x, y }) };
    const viewport = { width: 1200, height: 852 };

    harbor.beginPlateFrame(1, camera, viewport);
    const place = harbor._leadPlateLift.get('lead-1');
    assert.ok(place, 'lead plate placed');
    const box = harbor._plateBoxes[0];
    assert.ok(box.x1 <= viewport.width - 6, `lead plate right ${box.x1} clamped inside viewport`);
    assert.ok(box.x0 >= 6, `lead plate left ${box.x0} clamped inside viewport`);

    // _drawRepoAnchorage clamps plate and text inside viewport.
    const fills = [];
    const texts = [];
    const ctx = {
        font: '', fillStyle: '', globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic',
        save() {}, restore() {}, translate() {}, scale() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 1190, f: 500 }),
        measureText: text => ({ width: String(text).length * 7 }),
        fillRect(x, y, w, h) { fills.push({ x, y, w, h }); },
        fillText(text, x, y) { texts.push({ text, x, y }); },
    };
    harbor._fillReadableText = (c, text, x, y) => c.fillText(text, x, y);
    harbor._drawRepoAnchorage(ctx, {
        x: 1190, y: 500, project: '/w/pharos-watch', repoName: 'pharos-watch',
        docked: 6, laneCount: 2, present: true, lively: true,
        profile: { accent: '#80e8ff', glow: 'rgba(128,232,255,0.3)', panel: '#141e22' },
    }, 2);
    assert.ok(texts.length > 0, 'repo anchorage label drew');
    const plateFill = fills.find(r => r.h === 14 && r.w >= 40);
    assert.ok(plateFill, 'repo plate rect drawn');
    assert.ok(1190 + plateFill.x + plateFill.w <= viewport.width - 8, 'anchorage plate right edge clamped');
    assert.equal(texts[0].x, plateFill.x + Math.round(plateFill.w / 2), 'text stays centered in clamped plate');
});

test('Toast publishes toast-container while non-empty and unpublishes when cleared', () => {
    const container = {
        isConnected: true,
        children: [],
        appendChild(el) { el.parentNode = this; this.children.push(el); },
        removeChild(el) {
            const i = this.children.indexOf(el);
            if (i >= 0) this.children.splice(i, 1);
            el.parentNode = null;
        },
        getClientRects: () => [{ width: 280, height: 44 }],
        getBoundingClientRect: () => ({ left: 1380, top: 800, right: 1660, bottom: 844, width: 280, height: 44 }),
    };
    const frame = {
        getBoundingClientRect: () => ({ left: 240, top: 48, right: 1920, bottom: 1080, width: 1680, height: 1032 }),
    };
    const doc = {
        getElementById: id => (id === 'toastContainer' ? container : id === 'characterMode' ? frame : null),
        createElement: () => ({
            className: '', textContent: '', dataset: {},
            classList: { add() {} },
            setAttribute() {},
        }),
    };
    const toast = new Toast({ eventTarget: { on: () => () => {} }, documentRef: doc });
    try {
        assert.equal(getReservedRect('toast-container'), null, 'empty toast container publishes nothing');
        const entry = toast.show('Saved', 'info', { dismissMs: null });
        const rect = getReservedRect('toast-container');
        assert.ok(rect, 'non-empty toast container publishes reserved rect');
        assert.deepEqual({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, {
            left: 1140, top: 752, right: 1420, bottom: 796,
        });
        toast._remove(entry);
        assert.equal(getReservedRect('toast-container'), null, 'dismissing last toast unpublishes reserved rect');
    } finally {
        toast.destroy();
        unpublishReservedRect('toast-container');
    }
});

test('bottom tally docks at EDGE_MARGIN, yields to caption-band and plaques, and stays out of attentionScreenRects', () => {
    const ctx = { font: '', measureText: text => ({ width: String(text).length * 7 }) };
    const camera = { worldToScreen: (x, y) => ({ x, y }) };
    const viewport = { width: 1600, height: 900 };
    const silent = [{ x: 400, y: 1200, agent: { id: 'below', name: 'Below', status: AgentStatus.WORKING } }];

    const plain = layoutAttentionPlates(ctx, { sprites: silent, camera, viewport, now: 1000 });
    assert.equal(plain.tallies.length, 1);
    assert.equal(plain.tallies[0].side, 'bottom');
    assert.equal(viewport.height - plain.tallies[0].rect.bottom, 8, 'bottom tally docks at EDGE_MARGIN=8, not 100px');
    assert.deepEqual(attentionScreenRects(plain), [], 'tallies excluded from hard attentionScreenRects by default');
    assert.equal(attentionScreenRects(plain, { includeTallies: true }).length, 1);

    // With caption-band reserved rect, bottom tally lifts cleanly above it.
    const caption = { left: 200, top: 820, right: 800, bottom: 892 };
    const withCaption = layoutAttentionPlates(ctx, { sprites: silent, camera, viewport, reserved: [caption], now: 1000 });
    assert.equal(withCaption.tallies.length, 1);
    assert.ok(withCaption.tallies[0].rect.bottom <= caption.top - 8, 'lifts above active caption-band');

    // Tallies yield to visible building plaques passed via `avoid`.
    const plaque = { left: 340, top: 870, right: 460, bottom: 896 };
    const avoided = layoutAttentionPlates(ctx, { sprites: silent, camera, viewport, avoid: [plaque], now: 1000 });
    assert.equal(avoided.tallies.length, 1);
    const t = avoided.tallies[0].rect;
    const hitsPlaque = t.left < plaque.right && t.right > plaque.left && t.top < plaque.bottom && t.bottom > plaque.top;
    assert.equal(hitsPlaque, false, 'tally slides clear of visible building plaque');
});

test('AttentionPlates applies 14px hysteresis and 500ms dwell to offscreenSide and T1 grouping', () => {
    const ctx = { font: '', measureText: text => ({ width: String(text).length * 7 }) };
    const camera = { worldToScreen: (x, y) => ({ x, y }) };
    const viewport = { width: 1600, height: 900 };
    const state = {};

    // 1. offscreenSide hysteresis (14 px) + dwell (500 ms)
    const walker = { x: 4, y: 400, agent: { id: 'edge-1', name: 'Moss', status: AgentStatus.WAITING_ON_USER, statusSince: 100 } };
    // First frame: beacon left = 4 - 9 = -5 < 0 -> docked left
    const f0 = layoutAttentionPlates(ctx, { sprites: [walker], camera, viewport, state, dwellNow: 1000, now: 1000 });
    assert.equal(f0.plates[0].side, 'left');
    // Step 10 px inward (beacon left = +5, inside 14 px hysteresis band): stays left even past 500 ms.
    walker.x = 14;
    const f1 = layoutAttentionPlates(ctx, { sprites: [walker], camera, viewport, state, dwellNow: 2000, now: 2000 });
    assert.equal(f1.plates[0].side, 'left', 'within 14 px hysteresis band stays docked');
    // Step 20 px past edge (beacon left = +15 > 14): holds for 500 ms dwell, then undocks.
    walker.x = 24;
    const f2 = layoutAttentionPlates(ctx, { sprites: [walker], camera, viewport, state, dwellNow: 2200, now: 2200 });
    assert.equal(f2.plates[0].side, 'left', 'starts dwell timer');
    const f3 = layoutAttentionPlates(ctx, { sprites: [walker], camera, viewport, state, dwellNow: 2600, now: 2600 });
    assert.equal(f3.plates[0].side, 'left', 'still inside 500 ms dwell');
    const f4 = layoutAttentionPlates(ctx, { sprites: [walker], camera, viewport, state, dwellNow: 2700, now: 2700 });
    assert.equal(f4.plates[0].side, undefined, 'undocks cleanly after 500 ms dwell');

    // 2. T1 grouping hysteresis (14 px) + dwell (500 ms) for 3 waiting agents near GROUP_RADIUS (96 px)
    const gState = {};
    const a = { x: 400, y: 400, agent: { id: 'g-a', name: 'Moss', status: AgentStatus.WAITING_ON_USER, statusSince: 100 } };
    const b = { x: 490, y: 400, agent: { id: 'g-b', name: 'Juniper', status: AgentStatus.WAITING_ON_USER, statusSince: 200 } };
    const c = { x: 580, y: 400, agent: { id: 'g-c', name: 'Fern', status: AgentStatus.WAITING_ON_USER, statusSince: 300 } };
    const g0 = layoutAttentionPlates(ctx, { sprites: [a, b, c], camera, viewport, state: gState, dwellNow: 1000, now: 1000 });
    assert.equal(g0.plates.length, 1, 'starts grouped at 90 px spacing');
    // Drift apart to 104 px (> 96 px GROUP_RADIUS, < 96+14=110 px hysteresis): stays grouped!
    b.x = 504;
    c.x = 608;
    const g1 = layoutAttentionPlates(ctx, { sprites: [a, b, c], camera, viewport, state: gState, dwellNow: 2000, now: 2000 });
    assert.equal(g1.plates.length, 1, 'holds group inside 14 px hysteresis band');
    // Move well past hysteresis and natural plate width (220 px apart): holds
    // during 500 ms dwell, splits after 500 ms.
    b.x = 620;
    c.x = 840;
    const g2 = layoutAttentionPlates(ctx, { sprites: [a, b, c], camera, viewport, state: gState, dwellNow: 2100, now: 2100 });
    assert.equal(g2.plates.length, 1, 'holds group at dwell start');
    const g3 = layoutAttentionPlates(ctx, { sprites: [a, b, c], camera, viewport, state: gState, dwellNow: 2599, now: 2599 });
    assert.equal(g3.plates.length, 1, 'holds group through 499 ms dwell');
    const g4 = layoutAttentionPlates(ctx, { sprites: [a, b, c], camera, viewport, state: gState, dwellNow: 2600, now: 2600 });
    assert.equal(g4.plates.length, 3, 'splits cleanly after 500 ms dwell');
});

test('Chronicle banners render on drawMoments (not enumerateDrawables), stacked vertically and clamped, and skip postcards', () => {
    const monuments = new ChronicleMonuments({ eventTarget: { on: () => () => {}, emit() {} } });
    const now = 5000;
    monuments._activeBanners = [
        { id: 'b1', tier: 'maiden', tileX: 35, tileY: 22, startedAt: now - 1000, expiresAt: now + 5000, text: 'Maiden Voyage - alpha' },
        { id: 'b2', tier: 'maiden', tileX: 35, tileY: 22, startedAt: now - 1000, expiresAt: now + 5000, text: 'Maiden Voyage - beta' },
        { id: 'b3', tier: 'maiden', tileX: 35, tileY: 22, startedAt: now - 1000, expiresAt: now + 5000, text: 'Maiden Voyage - gamma' },
    ];
    // Never emitted as depth drawables (invisible on WebGPU/WebGL2, water-warped on Canvas).
    assert.equal(monuments.enumerateDrawables(now).filter(d => d.kind === 'chronicle-banner').length, 0);

    const drawn = [];
    const stack = [];
    let tx = 0;
    let ty = 0;
    const ctx = {
        canvas: { width: 1200, height: 800, _claudeVilleCssWidth: 1200, _claudeVilleCssHeight: 800, _claudeVilleDpr: 1 },
        font: '', fillStyle: '', globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic',
        save() { stack.push([tx, ty]); },
        restore() { [tx, ty] = stack.pop(); },
        translate(x, y) { tx += x; ty += y; },
        scale() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }),
        measureText: text => ({ width: String(text).length * 8 }),
        fillRect() {},
        fillText(text, x, y) { drawn.push({ text, sx: tx + x, sy: ty + y }); },
    };
    monuments.drawMoments(ctx, 1, now);
    assert.equal(drawn.length, 3, 'all 3 banners drawn via drawMoments');
    // Vertically stacked without overlapping and clamped inside viewport.
    const ys = drawn.map(d => d.sy).sort((a, b) => a - b);
    assert.ok(ys[1] - ys[0] >= 22, `banner spacing ${ys[1] - ys[0]} >= 22`);
    assert.ok(ys[2] - ys[1] >= 22, `banner spacing ${ys[2] - ys[1]} >= 22`);
    for (const item of drawn) {
        assert.ok(item.sx >= 8 && item.sx <= 1200 - 8, `banner x=${item.sx} inside viewport`);
        assert.ok(item.sy >= 8 && item.sy <= 800 - 8, `banner y=${item.sy} inside viewport`);
    }

    // Postcard frame draws no banners.
    drawn.length = 0;
    withPostcardFrame(() => monuments.drawMoments(ctx, 1, now));
    assert.equal(drawn.length, 0, 'postcard frame suppresses banners');
    monuments.dispose();
});
