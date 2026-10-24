import test from 'node:test';
import assert from 'node:assert/strict';
import { MonumentPlanter, MonumentRules } from '../../claudeville/src/application/MonumentRules.js';

test('replayed events skip placement while new and newly verified events keep their records', async () => {
    const rules = new MonumentRules();
    const records = new Map();
    const emitted = [];
    let probes = 0;
    let reads = 0;
    const store = {
        async get(_store, id) { reads++; return records.get(id); },
        async put(_store, record) { records.set(record.id, record); },
    };
    const planter = new MonumentPlanter({ store, rules, eventTarget: { emit: (...args) => emitted.push(args) } });
    const context = {
        now: 1_800_000_000_000,
        monuments: [{ tileX: 20, tileY: 20 }],
        blockedTiles: { has() { probes++; return false; } },
    };
    const commit = { type: 'commit', project: '/repo', sha: 'a', subject: 'feat: first', ts: context.now };
    const push = { type: 'push', project: '/repo', targetRef: 'refs/tags/v1.2.0', ts: context.now };
    const verified = { ...push, success: true };
    const next = { ...commit, sha: 'b', subject: 'fix: second' };
    const expected = [commit, verified, next].map(event => rules.buildRecord(event, context));

    assert.deepEqual(await planter.processEvents([commit, push], context), [expected[0]]);
    assert.ok(probes > 0);
    probes = 0;
    assert.deepEqual(await planter.processEvents([{ ...commit }, { ...push }], { ...context, now: context.now + 1000 }), []);
    assert.equal(probes, 0, 'duplicates must never enter placement');
    assert.equal(reads, 1);

    assert.deepEqual(await planter.processEvents([commit, verified, next], context), expected.slice(1));
    assert.ok(probes > 0);
    probes = 0;
    assert.deepEqual(await planter.processEvents([commit, verified, next], context), []);
    assert.equal(probes, 0);
    assert.equal(reads, 3);
    assert.deepEqual([...records.values()], expected);
    assert.deepEqual(emitted, expected.map(record => ['chronicle:milestone', record]));
    assert.deepEqual(planter.dressing.counts, { release: 1, featFix: 0, records: 1 });

    planter.seen.clear();
    assert.deepEqual(await planter.processEvents([commit, verified, next], context), []);
    assert.equal(records.size, 3, 'persisted dedup still holds after seen eviction');
    assert.equal(emitted.length, 3);
});
