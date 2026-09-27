import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ACCENT_CAP_PER_MIN,
    BUILDINGS,
    BUILDING_IDS,
    accentRateFor,
    buildWorkshopState,
    createWorkshopMemory,
} from '../../claudeville/src/presentation/shared/audio/WorkshopModel.js';

const NOW = 1_790_000_000_000;

function agent(id, tool, input, extra = {}) {
    return {
        id,
        status: 'working',
        currentTool: tool,
        currentToolInput: input,
        signalObservedAt: NOW,
        tokens: { input: 0, output: 0 },
        ...extra,
    };
}

const forgeEdit = (id, file, extra) => agent(id, 'Edit', { file_path: `src/${file}.js` }, extra);

function silent(state) {
    assert.equal(state.total, 0);
    for (const id of BUILDING_IDS) {
        const b = state.buildings[id];
        assert.equal(b.working, 0, id);
        assert.equal(b.accentRate, 0, id);
        assert.deepEqual(b.slots, [], id);
    }
}

// Observe `polls` polls, 2 s apart; each agent opens a new file every `every` polls.
function observeEdits(memory, ids, polls, { every = 1 } = {}) {
    let state;
    for (let p = 0; p < polls; p++) {
        const agents = ids.map(id => forgeEdit(id, `f${Math.floor(p / every)}`, { signalObservedAt: NOW + p * 2000 }));
        state = buildWorkshopState({ agents, now: NOW + p * 2000, memory });
    }
    return state;
}

test('stale agents, a lost link and an idle village produce an empty work stratum', () => {
    const memory = createWorkshopMemory();
    silent(buildWorkshopState({ agents: [forgeEdit('a', 'x', { signalStale: true }), forgeEdit('b', 'y', { freshness: { state: 'stale' } })], now: NOW, memory }));
    silent(buildWorkshopState({ agents: [forgeEdit('a', 'x'), forgeEdit('b', 'y')], now: NOW, linkOk: false, memory }));
    silent(buildWorkshopState({ agents: [forgeEdit('a', 'x', { status: 'idle' }), forgeEdit('b', 'y', { status: 'waiting' })], now: NOW, memory }));
    silent(buildWorkshopState({ agents: [], now: NOW, memory }));
    // an observation older than staleMs is stale too
    silent(buildWorkshopState({ agents: [forgeEdit('a', 'x', { signalObservedAt: NOW - 90_000 })], now: NOW, staleMs: 60_000 }));
});

test('two agents at the forge hold two distinct slot pitches, stable while they stay', () => {
    const memory = createWorkshopMemory();
    let state = observeEdits(memory, ['smith-a', 'smith-b'], 5);
    const forge = state.buildings.forge;
    assert.equal(forge.working, 2);
    const pitches = forge.slots.map(slot => slot.pitchIndex);
    assert.equal(new Set(pitches).size, 2);
    assert.ok(pitches.every(p => p >= 0 && p < BUILDINGS.forge.pitches));
    // A third arrival never takes a pitch already sounding.
    const before = new Map(forge.slots.map(s => [s.agentId, s.pitchIndex]));
    state = buildWorkshopState({ agents: [forgeEdit('smith-a', 'z'), forgeEdit('smith-b', 'z'), forgeEdit('smith-c', 'z')], now: NOW + 12_000, memory });
    const after = new Map(state.buildings.forge.slots.map(s => [s.agentId, s.pitchIndex]));
    assert.equal(after.get('smith-a'), before.get('smith-a'));
    assert.equal(after.get('smith-b'), before.get('smith-b'));
    assert.equal(new Set(after.values()).size, 3);
});

test('the accent rate rises with tool-start density, saturates, and is never one per call', () => {
    let previous = 0;
    for (const starts of [0.5, 1, 2, 5, 10, 30, 60, 120, 600, 6000]) {
        const rate = accentRateFor(starts);
        assert.ok(rate > previous, `rate grows at ${starts}/min`);
        assert.ok(rate < starts, `rate ${rate} stays under ${starts} starts/min`);
        assert.ok(rate <= ACCENT_CAP_PER_MIN);
        previous = rate;
    }
    assert.equal(accentRateFor(0), 0);

    // Through the model: a busier forge has a higher rate, still under its starts.
    const slow = observeEdits(createWorkshopMemory(), ['a'], 30, { every: 5 }).buildings.forge;
    const fast = observeEdits(createWorkshopMemory(), ['a'], 30).buildings.forge;
    const crowd = observeEdits(createWorkshopMemory(), ['a', 'b', 'c', 'd'], 30).buildings.forge;
    assert.ok(slow.accentRate < fast.accentRate && fast.accentRate < crowd.accentRate);
    for (const b of [slow, fast, crowd]) assert.ok(b.accentRate < b.startsPerMin);

    // An unchanged tool is not a new start: a long call adds no density.
    const memory = createWorkshopMemory();
    let state;
    for (let p = 0; p < 20; p++) state = buildWorkshopState({ agents: [forgeEdit('a', 'same')], now: NOW + p * 2000, memory });
    assert.equal(state.buildings.forge.startsPerMin, 1);
});

test('an agent whose starts stopped carries no density while its neighbour keeps it', () => {
    const memory = createWorkshopMemory();
    let state;
    for (let p = 0; p < 40; p++) {
        const now = NOW + p * 2000;
        state = buildWorkshopState({ agents: [forgeEdit('busy', `f${p}`), forgeEdit('stuck', 'one-long-call')], now, memory });
    }
    const forge = state.buildings.forge;
    assert.equal(forge.working, 2);
    assert.equal(forge.slots.find(s => s.agentId === 'stuck').weight, 0);
    assert.ok(forge.slots.find(s => s.agentId === 'busy').weight > 0);
    assert.equal(forge.startsPerMin, forge.slots.find(s => s.agentId === 'busy').weight);
});

test('the mine works from token burn, and focus follows the selected agent', () => {
    const memory = createWorkshopMemory();
    const read = (tokens, now) => agent('reader', 'Read', { file_path: 'docs/x.md' }, { tokens: { input: tokens, output: 0 }, signalObservedAt: now });
    buildWorkshopState({ agents: [read(1000, NOW)], now: NOW, memory });
    let state = buildWorkshopState({ agents: [read(5000, NOW + 2000)], now: NOW + 2000, memory, selectedAgentId: 'reader' });
    assert.equal(state.buildings.archive.working, 1);
    assert.equal(state.buildings.mine.working, 1);
    assert.equal(state.total, 1);
    assert.ok(state.buildings.archive.focused && state.buildings.mine.focused);
    assert.ok(state.buildings.archive.slots[0].focused);
    // no burn for longer than the mine window: the mine falls quiet
    state = buildWorkshopState({ agents: [read(5000, NOW + 20_000)], now: NOW + 20_000, memory });
    assert.equal(state.buildings.mine.working, 0);
    assert.equal(state.buildings.archive.working, 1);
});
