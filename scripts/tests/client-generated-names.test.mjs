import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { World } from '../../claudeville/src/domain/entities/World.js';

const LEGACY = 'claudeville.generatedAgentNames.v1';
const PREFIX = 'claudeville.generatedAgentName.v2:';
const identity = id => AgentBiography.identityKeyFor({ id, provider: 'codex' });
const session = sessionId => ({ sessionId, provider: 'codex', turnState: 'working' });

function storage(t, entries = []) {
    const previous = globalThis.localStorage;
    const values = new Map(entries);
    const store = {
        failWrites: false,
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
    assert.equal(values.get(`${PREFIX}${identity('returning')}`), 'Wren');
    assert.equal(values.get(`${PREFIX}named:codex:ada`), 'Ada');
    assert.equal(values.get(`${PREFIX}named:codex:wren`), 'Wren');
    assert.equal(values.get(`${PREFIX}${identity('not-yet-seen')}`), 'Dove');
    assert.equal(values.get(`${PREFIX}${identity('already-v2')}`), 'Cora');
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
    assert.equal(values.get(`${PREFIX}${identity('returning')}`), resident.name);
    const saved = new Map(values);

    const second = manager(t);
    second.manager.handleWebSocketMessage({ sessions: [session('new-arrival'), session('returning')] });
    assert.equal(second.world.agents.get('returning').name, resident.name);
    assert.deepEqual(second.world.agents.get('returning').appearance, resident.appearance);
    for (const [key, value] of saved) assert.equal(values.get(key), value);
    assert.equal(values.has(LEGACY), false);
    assert.equal(values.get(`${PREFIX}${identity('new-arrival')}`), second.world.agents.get('new-arrival').name);
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
    assert.equal(values.get(`${PREFIX}${identity('late')}`), 'Quill');
    assert.equal(values.get(`${PREFIX}${identity('returning')}`), 'Hazel');
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
