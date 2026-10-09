import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorTelemetry } from '../../claudeville/src/presentation/character-mode/BehaviorTelemetry.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { DebugOverlay } from '../../claudeville/src/presentation/character-mode/DebugOverlay.js';

function telemetry(options = {}) {
    return new BehaviorTelemetry({ buildingTypes: ['command', 'forge'], maxAgents: 4, maxDestinations: 8, ...options });
}

function sample(counter, now, agents, allocator = {}) {
    assert.equal(counter.beginSample(now, allocator), true);
    for (const agent of agents) counter.observeAgent(...agent);
    return counter.endSample();
}

function close(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('occupancy shares use agent-seconds, including truthful outside residence', () => {
    const counter = telemetry();
    sample(counter, 0, [['a', 'command', 'command', false], ['b', null, null, true]]);
    const metrics = sample(counter, 250, [['a', 'command', 'command', false], ['b', 'forge', 'forge', false]]);
    close(metrics.agentSeconds, 1);
    close(metrics.buildings.command.occupancyShare, 0.5);
    close(metrics.buildings.forge.occupancyShare, 0.25);
    close(metrics.buildings.outside.occupancyShare, 0.25);
    close(metrics.buildings.command.meanDwellSeconds, 0.5);
    close(metrics.buildings.forge.meanDwellSeconds, 0.25);
    close(metrics.movingSamplePercent, 25);
    assert.equal(metrics.distinctDestinationsByAgent.a, 1);
    assert.equal(metrics.distinctDestinationsByAgent.b, 1);
});

test('rollover clips ongoing dwells and expires agent identities and visit destinations', () => {
    const counter = telemetry({ windowMs: 1000 });
    sample(counter, 0, [['a', 'command', 'command', false], ['departed', 'forge', 'forge', false]]);
    sample(counter, 250, [['a', 'command', 'command', false]]);
    sample(counter, 500, [['a', 'forge', 'forge', false]]);
    sample(counter, 750, [['a', 'forge', 'forge', false]]);
    let metrics = sample(counter, 1000, [['a', 'forge', 'forge', false]]);
    assert.equal(metrics.distinctDestinationsByAgent.departed, undefined);
    assert.equal(metrics.trackedAgents, 1);
    assert.equal(metrics.agentSamples, 4);
    close(metrics.agentSeconds, 1);
    close(metrics.buildings.command.occupancyShare, 0.25);
    close(metrics.buildings.command.meanDwellSeconds, 0.25);
    close(metrics.buildings.forge.meanDwellSeconds, 0.75);
    assert.equal(metrics.distinctDestinationsByAgent.a, 2);
    metrics = sample(counter, 1250, [['a', 'forge', 'forge', false]]);
    assert.equal(metrics.distinctDestinationsByAgent.a, 1);
    assert.equal(metrics.buildings.command.dwellVisits, 0);
    close(metrics.buildings.command.occupancyShare, 0);
    close(metrics.buildings.forge.meanDwellSeconds, 1);
});

test('separate residence runs and window-edge partial intervals retain correct dwell means', () => {
    const counter = telemetry({ windowMs: 1000 });
    sample(counter, 0, [['a', 'command', 'command', false]]);
    sample(counter, 250, [['a', null, null, true]]);
    sample(counter, 500, [['a', 'command', 'command', false]]);
    let metrics = sample(counter, 750, [['a', 'command', 'command', false]]);
    assert.equal(metrics.buildings.command.dwellVisits, 2);
    close(metrics.buildings.command.meanDwellSeconds, 0.375);
    metrics = sample(counter, 1100, [['a', 'command', 'command', false]]);
    assert.equal(metrics.buildings.command.dwellVisits, 1);
    // The sample ending at 250 is clipped to the 150ms inside the window.
    close(metrics.buildings.outside.agentSeconds, 0.15);
    close(metrics.buildings.command.agentSeconds, 0.75);
    close(metrics.agentSeconds, 0.9);
});

test('cadence guards and hidden-tab gaps never invent samples or dwell', () => {
    const counter = telemetry({ windowMs: 1000 });
    sample(counter, 0, [['a', 'command', 'command', false]]);
    assert.equal(counter.beginSample(100), false);
    assert.equal(counter.metrics.agentSamples, 1);
    const metrics = sample(counter, 10_000, [['a', 'command', 'command', false]]);
    assert.equal(metrics.agentSamples, 1);
    close(metrics.agentSeconds, 0.25);
    close(metrics.buildings.command.meanDwellSeconds, 0.25);
    assert.equal(metrics.buildings.command.dwellVisits, 1);
});

test('allocation ratios use rolling over-capacity deltas, not overflow or lifetime counts', () => {
    const counter = telemetry({ windowMs: 1000 });
    sample(counter, 0, [], { allocations: 20, overCapacityAllocations: 10, overflowAllocations: 20 });
    let metrics = sample(counter, 250, [], { allocations: 24, overCapacityAllocations: 11, overflowAllocations: 24 });
    assert.equal(metrics.allocations, 4);
    assert.equal(metrics.overCapacityAllocations, 1);
    close(metrics.overCapacityAllocationRatio, 0.25);
    metrics = sample(counter, 1250, [], { allocations: 26, overCapacityAllocations: 12 });
    assert.equal(metrics.allocations, 2);
    assert.equal(metrics.overCapacityAllocations, 1);
    close(metrics.overCapacityAllocationRatio, 0.5);
    metrics = sample(counter, 1500, [], { allocations: 0, overCapacityAllocations: 0 });
    assert.equal(metrics.allocations, 2);
    assert.equal(metrics.overCapacityAllocations, 1);
});

test('bubble churn counts committed slot/lateral changes, never initial or absent placement', () => {
    const counter = telemetry({ windowMs: 1000 });
    sample(counter, 0, [['a', 'command', 'command', false, false, 0, 0]]);
    let metrics = sample(counter, 250, [['a', 'command', 'command', false, true, 0, 1]]);
    assert.equal(metrics.suppressedBubbleCount, 1);
    assert.equal(metrics.bubbleSlotChanges, 1);
    close(metrics.bubbleSlotChangesPerMinute, 120);
    sample(counter, 500, [['a', 'command', 'command', false, false, null, 0]]);
    metrics = sample(counter, 750, [['a', 'command', 'command', false, false, 2, 0]]);
    assert.equal(metrics.bubbleSlotChanges, 1);
    assert.equal(metrics.suppressedBubbleCount, 0);
    metrics = sample(counter, 1250, [['a', 'command', 'command', false, false, 2, 0]]);
    assert.equal(metrics.bubbleSlotChanges, 0);
});

test('five-minute ring wraps repeatedly without reallocating public results or sample buffers', () => {
    const counter = telemetry();
    const result = counter.metrics;
    const row = result.buildings.command;
    const ring = counter._occupancy;
    for (let tick = 0; tick < 2500; tick++) {
        sample(counter, tick * 250, [['a', 'command', 'command', false]]);
    }
    assert.equal(counter.capacity, 1201);
    assert.equal(counter.metrics, result);
    assert.equal(counter.metrics.buildings.command, row);
    assert.equal(counter._occupancy, ring);
    assert.equal(counter.metrics.windowSamples, 1200);
    assert.equal(counter.metrics.agentSamples, 1200);
    close(counter.metrics.agentSeconds, 300);
    close(row.occupancyShare, 1);
    close(row.meanDwellSeconds, 300);
    assert.equal(row.dwellVisits, 1);
});

test('capacity drops are explicit and expired identities can reuse fixed slots', () => {
    const counter = telemetry({ windowMs: 1000, maxAgents: 1, maxDestinations: 1 });
    let metrics = sample(counter, 0, [['a', 'command', 'command', false], ['b', 'forge', 'forge', false]]);
    assert.equal(metrics.droppedAgentSamples, 1);
    assert.equal(metrics.activeAgents, 1);
    metrics = sample(counter, 250, [['a', 'forge', 'forge', false]]);
    assert.equal(metrics.droppedDestinationSamples, 1);
    metrics = sample(counter, 1500, [['b', 'command', 'command', false]]);
    assert.equal(metrics.trackedAgents, 1);
    assert.equal(metrics.distinctDestinationsByAgent.a, undefined);
    assert.equal(metrics.distinctDestinationsByAgent.b, 1);
});

test('renderer cadence samples actual arrivals and reads absent suppression defensively', () => {
    const counter = telemetry();
    const host = Object.assign(Object.create(IsometricRenderer.prototype), {
        behaviorTelemetry: counter,
        visitTileAllocator: { metrics: { allocations: 0, overCapacityAllocations: 0 } },
        _isGateTransit: sprite => sprite.departing,
        agentSprites: new Map([
            ['a', { agent: { id: 'a' }, moving: false, behavior: { building: 'command', visitStartedAt: 1 }, bubbleSlot: 0, bubbleLateral: 0 }],
            ['b', { agent: { id: 'b' }, moving: true, behavior: { building: 'forge', visitStartedAt: null } }],
            ['c', { agent: { id: 'c' }, moving: false, behavior: { building: 'forge', visitStartedAt: null } }],
            ['d', { agent: { id: 'd' }, departing: true }],
            ['e', { agent: { id: 'e' }, isArrivalPending: () => true }],
        ]),
    });
    host._sampleBehaviorTelemetry(0);
    host._sampleBehaviorTelemetry(100);
    assert.equal(counter.metrics.activeAgents, 3);
    assert.equal(counter.metrics.agentSamples, 3);
    close(counter.metrics.buildings.command.occupancyShare, 1 / 3);
    close(counter.metrics.buildings.forge.occupancyShare, 0);
    assert.equal(counter.metrics.distinctDestinationsByAgent.b, 0);
    assert.equal(counter.metrics.distinctDestinationsByAgent.c, 0);
    assert.equal(counter.metrics.suppressedBubbleCount, 0);
});

test('Shift-D behaviour rows expose all metrics and cache by sampled tick', () => {
    const counter = telemetry();
    sample(counter, 0, [['a', 'command', 'command', false]]);
    const overlay = new DebugOverlay();
    const rows = overlay._behaviorRows(counter.metrics);
    assert.ok(rows.some(row => row.startsWith('behaviour: rolling 5 min')));
    assert.ok(rows.some(row => row.includes('moving samples: 0.0%')));
    assert.ok(rows.some(row => row.includes('over-capacity alloc: 0.0% (0/0)')));
    assert.ok(rows.some(row => row.includes('suppressed 0') && row.includes('slot changes 0.0/min')));
    assert.ok(rows.some(row => row.includes('destinations/agent: 1.0 mean') && row.includes('1×1')));
    assert.ok(rows.some(row => row.includes('residence command: 100.0%') && row.includes('dwell 0.3s')));
    assert.equal(overlay._behaviorRows(counter.metrics), rows);
    sample(counter, 250, [['a', 'forge', 'forge', false]]);
    assert.notEqual(overlay._behaviorRows(counter.metrics), rows);
});
