// Spend ledger: today's observed tokens, banked from deltas.
//
// The failure this guards against is a scary wrong number in the most
// prominent slot in the UI — a session's lifetime total dumped into "today",
// or a ten-second burst extrapolated into an alarming hourly rate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SpendLedger } from '../../claudeville/src/application/SpendLedger.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { World } from '../../claudeville/src/domain/entities/World.js';

const T = 1_700_000_000_000;

function worldOf(agents) {
    return { agents: new Map(agents.map((a) => [a.id, a])) };
}

// `cost` is a getter on the real Agent; a plain field is equivalent here.
function agent(id, { input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0 } = {}) {
    return { id, tokens: { input, output, cacheRead, cacheCreate }, cost };
}

function countingStore() {
    const records = [];
    return {
        records,
        async get() { return null; },
        async put(_name, record) {
            records.push(structuredClone(record));
            return record;
        },
    };
}

function liveAgent(id, { input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0 } = {}) {
    return new Agent({
        id,
        projectPath: '/work/shared',
        provider: 'claude',
        tokens: { input, output, cacheRead, cacheCreate },
        cost: { usd: cost, source: 'provider' },
    });
}

async function startedLedger(t, world, store = countingStore()) {
    const ledger = new SpendLedger(world, { store });
    t.after(() => ledger.stop());
    await ledger.start();
    return { ledger, store };
}

// Let the event cohort and its store promises settle without forcing flush().
function settleEvents() {
    return new Promise(resolve => setImmediate(resolve));
}

test('a session first seen mid-flight contributes nothing retroactively', () => {
    const world = worldOf([agent('a', { input: 5_000_000, output: 200_000, cost: 40 })]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);
    assert.equal(ledger.today.tokens, 0);
    assert.equal(ledger.today.cost, 0);
});

test('only growth after the baseline is banked', () => {
    const one = agent('a', { input: 1000, output: 500, cost: 1 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 1400, output: 700, cacheRead: 0, cacheCreate: 0 };
    one.cost = 1.5;
    ledger.sample(T + 1000);

    assert.equal(ledger.today.tokens, 600);
    assert.equal(ledger.today.cost, 0.5);
});

test('cache reads are tracked apart from new tokens', () => {
    // Cache reads re-read the same prompt every turn; counting them as new
    // tokens made the headline an accounting artifact rather than a measure of
    // work done.
    const one = agent('a', { input: 100, cacheRead: 1_000_000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 200, output: 0, cacheRead: 3_000_000, cacheCreate: 0 };
    ledger.sample(T + 1000);

    assert.equal(ledger.today.tokens, 100);
    assert.equal(ledger.today.cacheRead, 2_000_000);
});

test('a counter that goes backwards re-baselines instead of banking a negative', () => {
    const one = agent('a', { input: 5000, cost: 3 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 };
    one.cost = 0.1;
    ledger.sample(T + 1000);
    assert.equal(ledger.today.tokens, 0);
    assert.equal(ledger.today.cost, 0);

    one.tokens = { input: 400, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 2000);
    assert.equal(ledger.today.tokens, 300);
});

test('the burn rate says nothing until the window is wide enough', () => {
    const one = agent('a', { input: 1000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);

    one.tokens = { input: 2000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 10_000);
    assert.equal(ledger.burnRate(T + 10_000), null, 'a ten-second burst is not an hourly rate');

    one.tokens = { input: 3000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 180_000);
    const rate = ledger.burnRate(T + 180_000);
    assert.ok(rate, 'a three-minute window is enough');
    // 2000 new tokens over the 170s between the first and last sample.
    assert.ok(rate.tokensPerHour > 40_000 && rate.tokensPerHour < 45_000, `got ${rate.tokensPerHour}`);
});

test('a new local day starts the ledger over', () => {
    const one = agent('a', { input: 1000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);
    one.tokens = { input: 2000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 1000);
    assert.equal(ledger.today.tokens, 1000);

    const tomorrow = new Date(T);
    tomorrow.setDate(tomorrow.getDate() + 1);
    one.tokens = { input: 2500, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(tomorrow.getTime());
    // The rollover clears the day but keeps the baseline, so only the 500
    // tokens spent after midnight land on the new day.
    assert.equal(ledger.today.tokens, 500);
});

test('a departed agent keeps its banked spend but loses its baseline', () => {
    const one = agent('a', { input: 1000 });
    const world = worldOf([one]);
    const ledger = new SpendLedger(world);
    ledger.sample(T);
    one.tokens = { input: 3000, output: 0, cacheRead: 0, cacheCreate: 0 };
    ledger.sample(T + 1000);
    assert.equal(ledger.today.tokens, 2000);

    world.agents.delete('a');
    ledger.sample(T + 2000);
    assert.equal(ledger.today.tokens, 2000, 'spend already observed is not unwound');
});

test('synchronous World updates persist once per microtask cohort', async (t) => {
    t.mock.method(Date, 'now', () => T);
    const world = new World();
    const agents = Array.from({ length: 8 }, (_, index) => liveAgent(`a${index}`, {
        input: 100, output: 20, cacheCreate: 10, cacheRead: 200, cost: 1,
    }));
    for (const one of agents) world.addAgent(one);
    const { ledger, store } = await startedLedger(t, world);

    const fanOut = (cohort) => {
        for (const [index, one] of agents.entries()) {
            const growth = (index + 1) * cohort;
            world.updateAgent(one.id, {
                tokens: {
                    input: 100 + growth,
                    output: 20 + 2 * growth,
                    cacheCreate: 10 + growth,
                    cacheRead: 200 + 5 * growth,
                },
                cost: { usd: 1 + growth / 8, source: 'provider' },
            });
        }
    };
    // UI-12: agent i grows by (i + 1) per cohort, so the last is costliest.
    const sessionsAfter = (cohorts) => agents.map((one, index) => ({
        key: one.id,
        tokens: 4 * (index + 1) * cohorts,
        cacheRead: 5 * (index + 1) * cohorts,
        cost: ((index + 1) * cohorts) / 8,
        name: one.displayName,
        project: '/work/shared',
        provider: 'claude',
    })).reverse();
    fanOut(1);
    assert.deepEqual(ledger.today, { tokens: 144, cacheRead: 180, cost: 4.5 });
    assert.equal(store.records.length, 0, 'writes wait until the fan-out has finished');
    await settleEvents();
    assert.equal(store.records.length, 1);
    assert.deepEqual(store.records[0].value, {
        tokens: 144, cacheRead: 180, cost: 4.5,
        coverageSince: T,
        projects: [{ key: '/work/shared', tokens: 144, cacheRead: 180, cost: 4.5 }],
        providers: [{ key: 'claude', tokens: 144, cacheRead: 180, cost: 4.5 }],
        sessions: sessionsAfter(1),
    });

    fanOut(2);
    assert.equal(store.records.length, 1);
    await settleEvents();
    assert.equal(store.records.length, 2, 'the next cohort gets its own snapshot');
    assert.deepEqual(store.records[1].value, {
        tokens: 288, cacheRead: 360, cost: 9,
        coverageSince: T,
        projects: [{ key: '/work/shared', tokens: 288, cacheRead: 360, cost: 9 }],
        providers: [{ key: 'claude', tokens: 288, cacheRead: 360, cost: 9 }],
        sessions: sessionsAfter(2),
    });
});

test('World events across midnight persist the old day before banking the new day', async (t) => {
    let now = new Date(2025, 0, 2, 23, 59, 59, 998).getTime();
    t.mock.method(Date, 'now', () => now);
    const world = new World();
    const one = liveAgent('a', { input: 100, cacheRead: 1000, cost: 10 });
    world.addAgent(one);
    const { ledger, store } = await startedLedger(t, world);

    now = new Date(2025, 0, 2, 23, 59, 59, 999).getTime();
    world.updateAgent(one.id, {
        tokens: { input: 130, cacheRead: 1200 },
        cost: { usd: 10.5, source: 'provider' },
    });
    // No microtask boundary: rollover itself must drain the old day's cohort.
    now = new Date(2025, 0, 3, 0, 0, 0, 1).getTime();
    world.updateAgent(one.id, {
        tokens: { input: 140, cacheRead: 1250 },
        cost: { usd: 10.75, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 10, cacheRead: 50, cost: 0.25 });
    await settleEvents();
    assert.deepEqual(store.records, [{
        key: 'usageLedger:2025-01-02',
        value: {
            tokens: 30, cacheRead: 200, cost: 0.5,
            // UI-15: the day's coverage began when the ledger started.
            coverageSince: new Date(2025, 0, 2, 23, 59, 59, 998).getTime(),
            projects: [{ key: '/work/shared', tokens: 30, cacheRead: 200, cost: 0.5 }],
            providers: [{ key: 'claude', tokens: 30, cacheRead: 200, cost: 0.5 }],
            sessions: [{
                key: 'a', tokens: 30, cacheRead: 200, cost: 0.5,
                name: one.displayName, project: '/work/shared', provider: 'claude',
            }],
        },
    }, {
        key: 'usageLedger:2025-01-03',
        value: {
            tokens: 10, cacheRead: 50, cost: 0.25,
            // Watching across midnight covers the new day from its start.
            coverageSince: new Date(2025, 0, 3).getTime(),
            projects: [{ key: '/work/shared', tokens: 10, cacheRead: 50, cost: 0.25 }],
            providers: [{ key: 'claude', tokens: 10, cacheRead: 50, cost: 0.25 }],
            sessions: [{
                key: 'a', tokens: 10, cacheRead: 50, cost: 0.25,
                name: one.displayName, project: '/work/shared', provider: 'claude',
            }],
        },
    }]);
});

test('World events baseline identities and recounts while splitting tokens, cache reads and cost', async (t) => {
    t.mock.method(Date, 'now', () => T);
    const world = new World();
    const { ledger, store } = await startedLedger(t, world);
    const one = liveAgent('a', { input: 1000, output: 200, cacheCreate: 100, cacheRead: 10_000, cost: 10 });
    world.addAgent(one);
    assert.deepEqual(ledger.today, { tokens: 0, cacheRead: 0, cost: 0 }, 'first sight is not backfill');

    world.updateAgent(one.id, {
        tokens: { input: 1100, output: 225, cacheCreate: 125, cacheRead: 10_500 },
        cost: { usd: 10.5, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 150, cacheRead: 500, cost: 0.5 });
    world.updateAgent(one.id, {
        projectPath: '/work/new',
        tokens: { input: 5000, output: 1000, cacheCreate: 500, cacheRead: 20_000 },
        cost: { usd: 20, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 150, cacheRead: 500, cost: 0.5 }, 'project changes re-baseline');
    world.updateAgent(one.id, {
        tokens: { input: 5020, output: 1010, cacheCreate: 510, cacheRead: 20_100 },
        cost: { usd: 20.25, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 190, cacheRead: 600, cost: 0.75 });
    world.updateAgent(one.id, {
        provider: 'codex',
        tokens: { input: 9000, output: 2000, cacheCreate: 1000, cacheRead: 30_000 },
        cost: { usd: 30, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 190, cacheRead: 600, cost: 0.75 }, 'provider changes re-baseline');
    world.updateAgent(one.id, {
        tokens: { input: 9020, output: 2010, cacheCreate: 1010, cacheRead: 30_100 },
        cost: { usd: 30.5, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 230, cacheRead: 700, cost: 1.25 });
    world.updateAgent(one.id, {
        tokens: { input: 10, cacheRead: 20 },
        cost: { usd: 1, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 230, cacheRead: 700, cost: 1.25 }, 'a recount never unwinds spend');
    world.updateAgent(one.id, {
        tokens: { input: 30, output: 5, cacheCreate: 5, cacheRead: 70 },
        cost: { usd: 1.25, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 260, cacheRead: 750, cost: 1.5 }, 'growth uses the recounted baseline');
    world.updateAgent(one.id, {
        tokens: { input: 10, cacheRead: 90 },
        cost: { usd: 1.5, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 260, cacheRead: 770, cost: 1.75 }, 'only the token counter recounted');
    world.updateAgent(one.id, {
        tokens: { input: 20, cacheRead: 10 },
        cost: { usd: 0.5, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 270, cacheRead: 770, cost: 1.75 }, 'cache and cost recount independently');
    world.updateAgent(one.id, {
        tokens: { input: 25, cacheRead: 15 },
        cost: { usd: 0.75, source: 'provider' },
    });
    assert.deepEqual(ledger.today, { tokens: 275, cacheRead: 775, cost: 2 });
    assert.deepEqual(ledger.rollups(), {
        projects: [
            { key: '/work/new', tokens: 125, cacheRead: 275, cost: 1.5, activeSessions: 1, burnRate: null },
            { key: '/work/shared', tokens: 150, cacheRead: 500, cost: 0.5, activeSessions: 0, burnRate: null },
        ],
        providers: [
            { key: 'codex', tokens: 85, cacheRead: 175, cost: 1.25, activeSessions: 1, burnRate: null },
            { key: 'claude', tokens: 190, cacheRead: 600, cost: 0.75, activeSessions: 0, burnRate: null },
        ],
        sessions: [{
            key: 'a', tokens: 275, cacheRead: 775, cost: 2,
            name: one.displayName, project: '/work/new', provider: 'codex', live: true,
        }],
    });
    await settleEvents();
    assert.deepEqual(store.records[0].value, {
        tokens: 275, cacheRead: 775, cost: 2,
        coverageSince: T,
        projects: [
            { key: '/work/shared', tokens: 150, cacheRead: 500, cost: 0.5 },
            { key: '/work/new', tokens: 125, cacheRead: 275, cost: 1.5 },
        ],
        providers: [
            { key: 'claude', tokens: 190, cacheRead: 600, cost: 0.75 },
            { key: 'codex', tokens: 85, cacheRead: 175, cost: 1.25 },
        ],
        sessions: [{
            key: 'a', tokens: 275, cacheRead: 775, cost: 2,
            name: one.displayName, project: '/work/new', provider: 'codex',
        }],
    });
});

test('stop drains a pending World event cohort and waits for delayed storage', async (t) => {
    t.mock.method(Date, 'now', () => T);
    let releaseWrite;
    const records = [];
    const store = {
        async get() { return null; },
        async put(_name, record) {
            await new Promise(resolve => { releaseWrite = resolve; });
            records.push(record);
            return record;
        },
    };
    const world = new World();
    const one = liveAgent('a', { input: 1000 });
    world.addAgent(one);
    const ledger = new SpendLedger(world, { store });
    t.after(() => {
        releaseWrite?.();
        return ledger.stop();
    });
    await ledger.start();
    world.updateAgent(one.id, { tokens: { input: 2000 } });
    const stopped = ledger.stop();
    assert.strictEqual(ledger.stop(), stopped);
    let drained = false;
    stopped.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    releaseWrite();
    await stopped;
    world.updateAgent(one.id, { tokens: { input: 3000 } });
    await settleEvents();
    assert.equal(records.length, 1);
    assert.equal(records[0].value.tokens, 1000);
    assert.equal(ledger.today.tokens, 1000, 'stopped ledgers no longer observe World events');
});

test('a ledger stopped while it loads never subscribes', async () => {
    const { eventBus } = await import('../../claudeville/src/domain/events/DomainEvent.js');
    let releaseLoad;
    const store = {
        get() { return new Promise(resolve => { releaseLoad = () => resolve(null); }); },
        async put(_name, record) { return record; },
    };
    const counts = () => ['agent:added', 'agent:updated', 'agent:removed']
        .map(name => eventBus.listeners.get(name)?.size || 0);
    const before = counts();
    const ledger = new SpendLedger(worldOf([]), { store });
    const started = ledger.start();
    const stopped = ledger.stop();
    releaseLoad();
    await started;
    await stopped;
    assert.equal(ledger.running, false);
    assert.deepEqual(counts(), before, 'an app destroyed during boot leaves no ledger listener');
});

test('unchanged World telemetry banks no spend and writes no ledger record', async (t) => {
    t.mock.method(Date, 'now', () => T);
    const world = new World();
    const one = liveAgent('a', { input: 1000, output: 200, cacheRead: 5000, cacheCreate: 100, cost: 1 });
    world.addAgent(one);
    const { ledger, store } = await startedLedger(t, world);
    for (let index = 0; index < 8; index++) {
        world.updateAgent(one.id, {
            tokens: { ...one.tokens },
            cost: { usd: 1, source: 'provider' },
            currentTool: index % 2 ? 'Read' : 'Edit',
        });
    }
    await settleEvents();
    assert.deepEqual(ledger.today, { tokens: 0, cacheRead: 0, cost: 0 });
    assert.deepEqual(store.records, []);
    await ledger.stop();
    assert.deepEqual(store.records, [], 'stop does not manufacture an unchanged snapshot');
});

test('coverage says when today\'s observation began, restored across reloads (UI-15)', async (t) => {
    t.mock.method(Date, 'now', () => T);
    const storeWith = (value) => ({ ...countingStore(), async get() { return value ? { value } : null; } });
    const fresh = (await startedLedger(t, new World())).ledger;
    assert.equal(fresh.coverage(T).since, T, 'a day with no record starts now');

    const restored = (await startedLedger(t, new World(), storeWith({ tokens: 5, coverageSince: T - 3_600_000 }))).ledger;
    assert.equal(restored.coverage(T).since, T - 3_600_000, 'a reload keeps the first look');
    assert.equal(restored.today.tokens, 5);

    const legacy = (await startedLedger(t, new World(), storeWith({ tokens: 5 }))).ledger;
    assert.equal(legacy.coverage(T).since, null, 'a stored day without the field is unknown, never guessed');
});

test('sessions rank by today\'s spend, keep a departed row, and survive a reload (UI-12)', async (t) => {
    t.mock.method(Date, 'now', () => T);
    const world = new World();
    const cheap = liveAgent('cheap', { input: 100, cost: 1 });
    const dear = liveAgent('dear', { input: 100, cost: 1 });
    const wordy = liveAgent('wordy', { input: 100, cost: 1 });
    for (const one of [cheap, dear, wordy]) world.addAgent(one);
    const { ledger, store } = await startedLedger(t, world);
    world.updateAgent(cheap.id, { tokens: { input: 150 }, cost: { usd: 1.25, source: 'provider' } });
    world.updateAgent(dear.id, { tokens: { input: 120 }, cost: { usd: 3, source: 'provider' } });
    // Same cost as `cheap`, more new tokens: tokens break the tie.
    world.updateAgent(wordy.id, { tokens: { input: 900 }, cost: { usd: 1.25, source: 'provider' } });
    world.removeAgent(dear.id);

    const sessions = ledger.rollups().sessions;
    assert.deepEqual(sessions.map(row => [row.key, row.tokens, row.cost, row.live]), [
        ['dear', 20, 2, false],
        ['wordy', 800, 0.25, true],
        ['cheap', 50, 0.25, true],
    ], 'a session that left keeps its banked spend, no longer live');
    assert.equal(sessions[0].name, dear.displayName, 'it keeps the name it wore');

    await settleEvents();
    const stored = store.records.at(-1).value;
    const reloaded = (await startedLedger(t, new World(), { ...countingStore(), async get() { return { value: stored }; } })).ledger;
    assert.deepEqual(
        reloaded.rollups().sessions.map(row => [row.key, row.name, row.cost, row.live]),
        [['dear', dear.displayName, 2, false], ['wordy', wordy.displayName, 0.25, false], ['cheap', cheap.displayName, 0.25, false]],
        'a reload restores the day\'s sessions by name',
    );
});

test('the stored day keeps its 50 costliest sessions (UI-12)', async (t) => {
    t.mock.method(Date, 'now', () => T);
    const world = new World();
    const agents = Array.from({ length: 60 }, (_, index) => liveAgent(`s${index}`, { input: 10, cost: 1 }));
    for (const one of agents) world.addAgent(one);
    const { ledger, store } = await startedLedger(t, world);
    agents.forEach((one, index) => world.updateAgent(one.id, { tokens: { input: 20 }, cost: { usd: 1 + (index + 1) / 64, source: 'provider' } }));
    assert.equal(ledger.rollups().sessions.length, 60, 'the page keeps every session');
    await settleEvents();
    const stored = store.records.at(-1).value.sessions;
    assert.equal(stored.length, 50);
    assert.deepEqual([stored[0].key, stored.at(-1).key], ['s59', 's10'], 'the quietest ten stay only in the totals');
});
