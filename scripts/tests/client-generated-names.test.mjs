import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { World } from '../../claudeville/src/domain/entities/World.js';

const LEGACY = 'claudeville.generatedAgentNames.v1';
const PREFIX = 'claudeville.generatedAgentName.v2:';
const ORDER = 'claudeville.generatedAgentName.order.v2';
const identity = id => AgentBiography.identityKeyFor({ id, provider: 'codex' });
const session = sessionId => ({ sessionId, provider: 'codex', turnState: 'working' });
// EN-2 (r2) — a stored row is `{"n": name, "t": lastUsedMs}`; a plain
// string row predates the timestamp.
const storedName = (values, identityKey) => {
    const raw = values.get(`${PREFIX}${identityKey}`);
    if (raw === undefined) return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.n === 'string') return parsed.n;
    } catch {
        // A legacy plain-string row stores the name verbatim.
    }
    return raw;
};

function storage(t, entries = []) {
    const previous = globalThis.localStorage;
    const values = new Map(entries);
    const store = {
        failWrites: false,
        get length() { return values.size; },
        key(index) { return [...values.keys()][index] ?? null; },
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) {
            if (this.failWrites) throw new Error('QuotaExceededError');
            values.set(key, String(value));
        },
        removeItem(key) { values.delete(key); },
    };
    globalThis.localStorage = store;
    t.after(() => {
        if (previous === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previous;
    });
    return { store, values };
}

function manager(t) {
    const world = new World();
    const manager = new AgentManager(world, null);
    t.after(() => manager.stop());
    return { world, manager };
}

test('legacy migration preserves every identity, duplicate precedence and existing v2 names', t => {
    const entries = [
        [identity('returning'), 'Ada'],
        ['named:codex:ada', 'Ada'],
        [identity('returning'), 'Wren'],
        ['named:codex:wren', 'Wren'],
        [identity('not-yet-seen'), 'Dove'],
        ['invalid', 3], null,
    ];
    const { values } = storage(t, [
        [LEGACY, JSON.stringify(entries)],
        [`${PREFIX}${identity('already-v2')}`, 'Cora'],
    ]);
    const { world, manager: first } = manager(t);
    // Startup does not hydrate history; migration happens synchronously when
    // the first anonymous resident actually needs a name.
    assert.equal(first._generatedNames.size, 0);
    assert.equal(values.has(LEGACY), true);
    first.handleWebSocketMessage({ sessions: [session('returning')] });
    assert.equal(world.agents.get('returning').name, 'Wren');
    assert.equal(values.has(LEGACY), false);
    assert.equal(storedName(values, identity('returning')), 'Wren');
    assert.equal(storedName(values, 'named:codex:ada'), 'Ada');
    assert.equal(storedName(values, 'named:codex:wren'), 'Wren');
    assert.equal(storedName(values, identity('not-yet-seen')), 'Dove');
    assert.equal(storedName(values, identity('already-v2')), 'Cora');
    assert.equal(values.has(`${PREFIX}invalid`), false);
    assert.equal(first._generatedNames.has(identity('not-yet-seen')), false);

    const returning = manager(t);
    returning.manager.handleWebSocketMessage({ sessions: [session('not-yet-seen'), session('returning'), session('already-v2')] });
    assert.deepEqual([...returning.world.agents.values()].map(agent => agent.name), ['Dove', 'Wren', 'Cora']);
});

test('per-identity names survive restart and changed roster order without rewriting historical records', t => {
    const { values } = storage(t, [[`${PREFIX}${identity('historical')}`, 'Verity']]);
    const first = manager(t);
    const raw = new Agent({ id: 'returning', provider: 'codex' });
    first.world.addAgent(new Agent({ id: 'blocker', name: raw.name, provider: 'codex' }));
    first.manager.handleWebSocketMessage({ sessions: [session('returning')] });
    const resident = first.world.agents.get('returning');
    assert.notEqual(resident.name, raw.name);
    assert.equal(storedName(values, identity('returning')), resident.name);
    const saved = new Map(values);

    const second = manager(t);
    second.manager.handleWebSocketMessage({ sessions: [session('new-arrival'), session('returning')] });
    assert.equal(second.world.agents.get('returning').name, resident.name);
    assert.deepEqual(second.world.agents.get('returning').appearance, resident.appearance);
    // EN-2 (r2) — the daily refresh throttle keeps every per-identity record
    // byte-for-byte what it was across a reload that reads it again.
    for (const [key, value] of saved) {
        assert.equal(values.get(key), value);
    }
    assert.equal(values.has(LEGACY), false);
    assert.equal(storedName(values, identity('new-arrival')), second.world.agents.get('new-arrival').name);
    assert.equal(second.manager._generatedNames.has(identity('historical')), false);
});

test('quota-limited migration keeps legacy names recoverable until a later successful migration', t => {
    const legacy = JSON.stringify([[identity('returning'), 'Hazel'], [identity('late'), 'Quill']]);
    const { store, values } = storage(t, [[LEGACY, legacy]]);
    store.failWrites = true;
    const limited = manager(t);
    limited.manager.handleWebSocketMessage({ sessions: [session('returning'), session('late')] });
    assert.deepEqual([...limited.world.agents.values()].map(agent => agent.name), ['Hazel', 'Quill']);
    assert.equal(values.get(LEGACY), legacy);

    store.failWrites = false;
    const recovered = manager(t);
    recovered.manager.handleWebSocketMessage({ sessions: [session('late'), session('returning')] });
    assert.deepEqual([...recovered.world.agents.values()].map(agent => agent.name), ['Quill', 'Hazel']);
    assert.equal(values.has(LEGACY), false);
    assert.equal(storedName(values, identity('late')), 'Quill');
    assert.equal(storedName(values, identity('returning')), 'Hazel');
});

test('unavailable storage keeps generated names stable within the manager', t => {
    const { store } = storage(t);
    store.getItem = () => { throw new Error('SecurityError'); };
    store.failWrites = true;
    const current = manager(t);
    current.manager.handleWebSocketMessage({ sessions: [session('restricted')] });
    const name = current.world.agents.get('restricted').name;
    const appearance = current.world.agents.get('restricted').appearance;
    current.world.removeAgent('restricted');
    current.manager.handleWebSocketMessage({ sessions: [session('restricted')] });
    assert.equal(current.world.agents.get('restricted').name, name);
    assert.deepEqual(current.world.agents.get('restricted').appearance, appearance);
    assert.equal(current.manager._generatedNames.get(identity('restricted')), name);
});

// EN-2 — the generated-name cache is bounded: past the cap the least
// recently remembered identity is evicted from memory and its per-identity
// localStorage row goes with it.
test('the generated-name cache evicts past its cap and drops the stored row', t => {
    const { values } = storage(t);
    const { manager: current } = manager(t);
    const total = 600;
    const keys = Array.from({ length: total }, (_, index) => `id-${index}`);
    for (const key of keys) {
        current._rememberGeneratedName(identity(key), `Name ${key}`);
    }
    assert.equal(current._generatedNames.size, 512);
    // The oldest identities left the cache and storage; the newest stayed.
    for (const key of keys.slice(0, total - 512)) {
        assert.equal(current._generatedNames.has(identity(key)), false, `${key} evicted from memory`);
        assert.equal(values.has(`${PREFIX}${identity(key)}`), false, `${key} evicted from storage`);
    }
    for (const key of keys.slice(total - 512)) {
        assert.equal(current._generatedNames.get(identity(key)), `Name ${key}`);
        assert.equal(storedName(values, identity(key)), `Name ${key}`);
    }
    // Re-remembering a cached identity refreshes its recency, not just its value.
    current._rememberGeneratedName(identity('id-0'), 'Name id-0 reborn');
    current._rememberGeneratedName(identity('extra'), 'Name extra');
    assert.equal(current._generatedNames.size, 512);
    assert.equal(current._generatedNames.get(identity('id-0')), 'Name id-0 reborn');
    assert.equal(current._generatedNames.has(identity(keys[total - 512])), false, 'the stale tail rolls off');
});

// VT-fix-3 — the cap holds on the read path too: a manager handed more
// persisted identities than the cache bound still loads them through the
// capped insert.
test('returning persisted identities obey the 512-entry memory cap', t => {
    storage(t, new Map(Array.from({ length: 600 }, (_, index) => [
        `${PREFIX}${identity(`id-${index}`)}`,
        `Name ${index}`,
    ])));
    const { manager: current } = manager(t);
    current.handleWebSocketMessage({ sessions: Array.from({ length: 600 }, (_, index) => session(`id-${index}`)) });
    assert.ok(current._generatedNames.size <= 512);
});

// VT-fix-3 — the persisted set is bounded across reloads: three fresh
// managers (page reloads) each naming a small roster leave at most the cap's
// worth of stored rows behind.
test('the persistent cap survives page reloads with small rosters', t => {
    const { values } = storage(t);
    for (let page = 0; page < 3; page++) {
        const { manager: current } = manager(t);
        current.handleWebSocketMessage({ sessions: Array.from({ length: 200 }, (_, index) => session(`page-${page}-id-${index}`)) });
        current.stop();
    }
    const count = [...values.keys()].filter((key) => key.startsWith(PREFIX)).length;
    assert.ok(count <= 512);
});

// VT-fix-3 — reading a cached name is a use: the hit refreshes recency, so a
// same-value remember cannot strand the identity at the cold end.
test('reading a cached name refreshes its LRU recency', t => {
    storage(t);
    const { manager: current } = manager(t);
    for (let index = 0; index < 512; index++) {
        current._rememberGeneratedName(identity(`id-${index}`), `Name ${index}`);
    }
    assert.equal(current._generatedNameFor(identity('id-0')), 'Name 0');
    current._rememberGeneratedName(identity('id-0'), 'Name 0');
    current._rememberGeneratedName(identity('extra'), 'New Name');
    assert.equal(current._generatedNames.has(identity('id-0')), true);
    assert.equal(current._generatedNames.has(identity('id-1')), false);
});

// EN-2 (r2) — the stored set is bounded against the real keys, so two tabs
// sharing one storage cannot orphan rows past the cap.
test('two tabs sharing one storage cannot orphan rows outside the cap', t => {
    const { values } = storage(t);
    const tabs = [manager(t), manager(t)];
    tabs[0].manager.handleWebSocketMessage({ sessions: [session('a-seed')] });
    tabs[1].manager.handleWebSocketMessage({ sessions: [session('b-seed')] });
    for (let index = 0; index < 600; index++) {
        tabs[index % 2].manager.handleWebSocketMessage({ sessions: [session(`churn-${index}`)] });
    }
    const count = [...values.keys()].filter((key) => key.startsWith(PREFIX)).length;
    assert.ok(count <= 512, `stored rows after two tabs churn: ${count}`);
});

// EN-2 (r2) — a failed write loses nothing already stored, and the reloaded
// tab still prunes once its writes push past the cap again.
test('a failed write followed by reload keeps the stored set bounded', t => {
    const { store, values } = storage(t);
    const first = manager(t);
    first.manager.handleWebSocketMessage({ sessions: Array.from({ length: 500 }, (_, index) => session(`seed-${index}`)) });
    store.failWrites = true;
    const quota = manager(t);
    quota.manager.handleWebSocketMessage({ sessions: [session('quota-newcomer')] });
    // The failed write left the name in memory but no row behind.
    assert.equal(quota.world.agents.get('quota-newcomer').name != null, true);
    assert.equal(storedName(values, identity('quota-newcomer')), undefined);
    store.failWrites = false;
    const recovered = manager(t);
    recovered.manager.handleWebSocketMessage({ sessions: Array.from({ length: 13 }, (_, index) => session(`recovered-${index}`)) });
    const count = [...values.keys()].filter((key) => key.startsWith(PREFIX)).length;
    assert.ok(count <= 512, `stored rows after recovery: ${count}`);
});

// EN-2 (r2) — pre-existing legacy plain-string rows read as never used
// (`t = 0`) and never break their names; the init prune caps them.
test('pre-existing legacy plain-string rows keep their names and obey the cap', t => {
    const { values } = storage(t, new Map(Array.from({ length: 600 }, (_, index) => [
        `${PREFIX}${identity(`old-${index}`)}`,
        `Old Name ${index}`,
    ])));
    const { manager: current, world } = manager(t);
    current.handleWebSocketMessage({ sessions: [session('old-599')] });
    assert.equal(world.agents.get('old-599').name, 'Old Name 599');
    const count = [...values.keys()].filter((key) => key.startsWith(PREFIX)).length;
    assert.ok(count <= 512, `stored rows after legacy return: ${count}`);
});

// EN-2 (r2) — eviction follows use, not write order: a recently used
// resident's row survives a newcomer that pushes past the cap, and the name
// is still there after a reload.
test('a recently used resident survives a newcomer and keeps its name across reload', t => {
    const { values } = storage(t, new Map(Array.from({ length: 512 }, (_, index) => [
        `${PREFIX}${identity(`id-${index}`)}`,
        `Saved Name ${index}`,
    ])));
    const current = manager(t);
    current.manager.handleWebSocketMessage({ sessions: [session('id-0')] });
    current.world.removeAgent('id-0');
    current.manager.handleWebSocketMessage({ sessions: [session('id-0')] });
    assert.equal(current.world.agents.get('id-0').name, 'Saved Name 0');
    current.manager.handleWebSocketMessage({ sessions: [session('id-0'), session('newcomer')] });
    assert.equal(values.has(`${PREFIX}${identity('id-0')}`), true, 'the used resident keeps its row');
    const reloaded = manager(t);
    reloaded.manager.handleWebSocketMessage({ sessions: [session('id-0')] });
    assert.equal(reloaded.world.agents.get('id-0').name, 'Saved Name 0');
});

// EN-2 (r3) — a roster batch protects every incoming identity before the
// first name write or prune, so a newcomer processed first in a snapshot
// cannot evict a returning resident that appears later in the same snapshot.
test('a returning resident survives a newcomer earlier in the same roster snapshot', t => {
    const { values } = storage(t, new Map(Array.from({ length: 512 }, (_, index) => [
        `${PREFIX}${identity(`id-${index}`)}`,
        JSON.stringify({ n: `Saved Name ${index}`, t: Date.now() - 1000 + index }),
    ])));
    const current = manager(t);
    current.manager.handleWebSocketMessage({ sessions: [session('newcomer'), session('id-0')] });
    assert.equal(current.world.agents.get('id-0').name, 'Saved Name 0');
    const count = [...values.keys()].filter((key) => key.startsWith(PREFIX)).length;
    assert.ok(count <= 512, `stored rows after the newcomer: ${count}`);
});
