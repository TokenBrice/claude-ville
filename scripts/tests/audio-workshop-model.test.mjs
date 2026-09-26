import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ACCENT_CAP_PER_MIN,
    BUILDINGS,
    BUILDING_IDS,
    accentPlan,
    accentRateFor,
    buildWorkshopState,
    createWorkshopMemory,
    ghostPlan,
    quotaRumble,
} from '../../claudeville/src/presentation/shared/audio/WorkshopModel.js';
import { rngStream, setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';

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

test('an empty state plans no strikes', () => {
    const state = buildWorkshopState({ agents: [forgeEdit('a', 'x', { signalStale: true })], now: NOW });
    const rng = rngStream('work-test');
    for (const id of BUILDING_IDS) {
        const b = state.buildings[id];
        assert.deepEqual(accentPlan(b, rng, { fromMs: NOW, toMs: NOW + 60_000 }), []);
        assert.deepEqual(ghostPlan(b, rng, { fromMs: NOW, toMs: NOW + 60_000 }), []);
    }
});

test('two agents at the forge accent on two distinct slot pitches, stable while they stay', () => {
    const memory = createWorkshopMemory();
    let state = observeEdits(memory, ['smith-a', 'smith-b'], 5);
    const forge = state.buildings.forge;
    assert.equal(forge.working, 2);
    const pitches = forge.slots.map(slot => slot.pitchIndex);
    assert.equal(new Set(pitches).size, 2);
    assert.ok(pitches.every(p => p >= 0 && p < BUILDINGS.forge.pitches));

    // Every agent's accents sound its own pitch, and both are heard.
    setRngSeed('workshop-model');
    const accents = accentPlan(forge, rngStream('work-forge'), { fromMs: NOW, toMs: NOW + 120_000 });
    const heard = new Map(accents.map(a => [a.agentId, a.pitchIndex]));
    assert.equal(heard.size, 2);
    for (const slot of forge.slots) assert.equal(heard.get(slot.agentId), slot.pitchIndex);
    setRngSeed(null);

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

test('an agent whose starts stopped loses its accents while its neighbour keeps them', () => {
    const memory = createWorkshopMemory();
    let state;
    for (let p = 0; p < 40; p++) {
        const now = NOW + p * 2000;
        state = buildWorkshopState({ agents: [forgeEdit('busy', `f${p}`), forgeEdit('stuck', 'one-long-call')], now, memory });
    }
    const forge = state.buildings.forge;
    assert.equal(forge.working, 2);
    assert.equal(forge.slots.find(s => s.agentId === 'stuck').weight, 0);
    const accents = accentPlan(forge, rngStream('work-stall'), { fromMs: NOW, toMs: NOW + 120_000 });
    assert.ok(accents.length > 0);
    assert.ok(accents.every(a => a.agentId === 'busy'));
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

test('plans are deterministic for a seeded stream and sit on the building grid', () => {
    const forge = observeEdits(createWorkshopMemory(), ['a', 'b', 'c'], 10).buildings.forge;
    const run = () => {
        setRngSeed('determinism');
        const rng = rngStream('work-forge');
        const accents = accentPlan(forge, rng, { fromMs: NOW, toMs: NOW + 30_000 });
        const ghosts = ghostPlan(forge, rng, { fromMs: NOW, toMs: NOW + 30_000, accents });
        setRngSeed(null);
        return { accents, ghosts };
    };
    const first = run();
    assert.deepEqual(run(), first);
    const grid = BUILDINGS.forge.gridMs;
    for (const s of [...first.accents, ...first.ghosts]) assert.equal(s.at % grid, 0);
});

test('ghosts keep an active building alive within its liveness floor', () => {
    for (const id of ['forge', 'archive', 'observatory', 'harbor']) {
        const building = { ...buildWorkshopState({ agents: [], now: NOW }).buildings[id] };
        building.working = 1;
        building.slots = [{ agentId: 'a', slot: 0, pitchIndex: 0, weight: 0, focused: false, verify: false }];
        building.ghostP = 0.05; // nearly never by chance: the floor must carry it
        const ghosts = ghostPlan(building, rngStream(`work-live-${id}`), { fromMs: NOW, toMs: NOW + 120_000, lastStrikeMs: NOW });
        let last = NOW;
        for (const g of ghosts) {
            assert.ok(g.at - last <= building.livenessMs, `${id} gap ${g.at - last} ms`);
            last = g.at;
        }
        assert.ok(NOW + 120_000 - last <= building.livenessMs);
    }
});

test('quota rumble rises monotonically from 0.7 to 1.0 and is silent on stale data', () => {
    let previous = -1;
    for (let ratio = 0.7; ratio <= 1.0001; ratio += 0.01) {
        const { level } = quotaRumble(ratio);
        assert.ok(level >= previous);
        previous = level;
    }
    assert.equal(quotaRumble(0.7).level, 0);
    assert.equal(quotaRumble(1).level, 1);
    assert.ok(20 * Math.log10(quotaRumble(1).level / quotaRumble(0.75).level) >= 10);
    assert.equal(quotaRumble(0.95, true).level, 0);
    assert.equal(quotaRumble(null).level, 0);
    assert.equal(quotaRumble(Number.NaN).level, 0);
    assert.deepEqual(quotaRumble(0.9).band, [80, 160]);
});
