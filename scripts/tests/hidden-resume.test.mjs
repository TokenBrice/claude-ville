// VB-4 — a hidden or sleeping tab must not replay its departures and arrivals
// when shown. The first frame after a gap of over 10 s settles the world at
// once: long-over departures leave with no walk or fade, unseen arrivals stand
// at their destination, and departures in their first 30 s still walk out.
import test from 'node:test';
import assert from 'node:assert/strict';

import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

const WALL = 1_800_000_000_000;

function rendererWith(sprites, { lastFrameAt = 1_000, agents = [] } = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.agentSprites = new Map(sprites.map(sprite => [sprite.agent.id, sprite]));
    renderer.gateTransits = new Map();
    renderer.world = { agents: new Map(agents.map(agent => [agent.id, agent])) };
    renderer._lastLoopFrameTime = lastFrameAt;
    renderer._worldSpritesDirty = false;
    renderer.motionScale = 1;
    renderer.selectedAgent = null;
    renderer.visitTileAllocator = { release() {} };
    renderer._gateEntryQueue = [];
    renderer.arrivalDeparture = { arrivals: new Map(), dispatches: new Map() };
    renderer._markSpritesDirty = () => {};
    return renderer;
}

function sprite(id, { addedAt = 0, pending = false, leaving = false, departedAt = undefined } = {}) {
    return {
        agent: { id, departedAt, get isDeparted() { return Number.isFinite(this.departedAt); } },
        addedAt,
        leaving,
        settled: 0,
        released: 0,
        isArrivalPending() { return pending; },
        settleAtDestination() { this.settled++; pending = false; },
        releaseRenderResources() { this.released++; },
    };
}

test('a short gap replays nothing', t => {
    t.mock.method(Date, 'now', () => WALL);
    const late = sprite('late', { addedAt: 5_000, pending: true });
    const renderer = rendererWith([late], { agents: [late.agent] });
    renderer._settleAfterFrameGap(1_000 + 9_000);
    assert.equal(late.settled, 0);
});

test('after a long gap, old departures vanish, unseen arrivals settle, live departures walk', t => {
    t.mock.method(Date, 'now', () => WALL);
    const gone = sprite('gone', { leaving: true });
    gone.agent.departedAt = WALL - 45_000;
    const removed = sprite('removed', { leaving: true });
    const recent = sprite('recent', { leaving: true });
    recent.agent.departedAt = WALL - 5_000;
    const late = sprite('late', { addedAt: 5_000, pending: true });
    const resident = sprite('resident', { addedAt: 0 });
    const settled = sprite('settled', { addedAt: 0 });
    const renderer = rendererWith([gone, removed, recent, late, resident, settled], {
        agents: [gone.agent, recent.agent, late.agent, resident.agent, settled.agent],
    });
    renderer.gateTransits.set('gone', { type: 'departure', since: WALL - 45_000 });
    renderer.gateTransits.set('recent', { type: 'departure', since: WALL - 5_000 });
    renderer.gateTransits.set('late', { type: 'arrival', gate: true, since: WALL - 2_000 });
    renderer.gateTransits.set('resident', { type: 'arrival', since: WALL - 40_000 });
    renderer._gateEntryQueue.push({ agent: late.agent, sprite: late });

    renderer._settleAfterFrameGap(1_000 + 20_000);

    assert.equal(renderer.agentSprites.has('gone'), false, 'departed 45 s ago: no walk, no fade');
    assert.equal(gone.released, 1);
    assert.equal(renderer.agentSprites.has('removed'), false, 'removed while unseen, time unknown: gone');
    assert.equal(renderer.agentSprites.has('recent'), true, 'a departure in its first 30 s still walks');
    assert.equal(renderer.gateTransits.get('recent')?.type, 'departure');
    assert.equal(late.settled, 1, 'an unseen arrival stands at its destination');
    assert.equal(renderer.gateTransits.has('late'), false);
    assert.deepEqual(renderer._gateEntryQueue, []);
    assert.equal(resident.settled, 1, 'a walk-in nobody watched finishes at once');
    assert.equal(renderer.gateTransits.size, 1, 'only the live departure keeps a gate transit');
    assert.equal(settled.settled, 0, 'a body already at its work stays put');
});
