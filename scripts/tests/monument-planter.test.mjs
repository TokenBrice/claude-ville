import test from 'node:test';
import assert from 'node:assert/strict';
import { ChronicleDressingLedger, MonumentPlanter, MonumentRules, chronicleDressingFrame } from '../../claudeville/src/application/MonumentRules.js';

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
    assert.deepEqual(planter.dressing.counts, { release: 1, featFix: 0, commits: 0, records: 1 });

    planter.seen.clear();
    assert.deepEqual(await planter.processEvents([commit, verified, next], context), []);
    assert.equal(records.size, 3, 'persisted dedup still holds after seen eviction');
    assert.equal(emitted.length, 3);
});

// D3 — every verified commit leaves a mark, whatever its subject's style.
test('a verified commit with an untyped subject plants a minor Forge record', () => {
    const rules = new MonumentRules();
    const base = { type: 'commit', project: '/work/pharosville', sha: 'c0ffee', ts: 1_800_000_000_000 };
    for (const subject of ['golden: refresh the sweep', 'signals: quieter bells', 'release: v1.2.0', 'Tidy the docs']) {
        const record = rules.buildRecord({ ...base, subject, success: true });
        assert.equal(record?.kind, 'commit', subject);
        assert.equal(record.district, 'forge');
        assert.equal(record.weight, 'minor');
        assert.equal(record.label, subject);
        assert.match(record.lore, /committed to pharosville/);
    }
    // No evidence the commit landed, a failed commit or `style:`: nothing.
    assert.equal(rules.buildRecord({ ...base, subject: 'golden: unverified' }), null);
    assert.equal(rules.buildRecord({ ...base, subject: 'golden: failed', success: false }), null);
    assert.equal(rules.buildRecord({ ...base, subject: 'golden: exit 1', exitCode: 1 }), null);
    assert.equal(rules.buildRecord({ ...base, subject: 'style: tabs', success: true }), null);
    // A conventional subject keeps its own district.
    assert.equal(rules.buildRecord({ ...base, subject: 'feat: new hall', success: true }).district, 'forge');
    assert.equal(rules.buildRecord({ ...base, subject: 'fix: door', success: true }).district, 'taskboard');
});

test('untyped commit records stand below typed stones and dedupe on the commit', async () => {
    const rules = new MonumentRules();
    const ts = 1_800_000_000_000;
    const plain = rules.buildRecord({ type: 'commit', project: '/r', sha: 'a1', subject: 'golden: x', success: true, ts: ts + 10 });
    const feat = rules.buildRecord({ type: 'commit', project: '/r', sha: 'b2', subject: 'feat: y', ts });
    const { visible } = MonumentRules.applyDistrictCap([plain, feat], 1);
    assert.equal(visible[0].kind, 'feature', 'a newer untyped commit never displaces a feature');

    const records = new Map();
    const store = {
        async get(_s, id) { return records.get(id); },
        async put(_s, record) { records.set(record.id, record); },
    };
    const planter = new MonumentPlanter({ store, rules, eventTarget: { emit() {} } });
    const event = { type: 'commit', project: '/r', sha: 'a1', subject: 'golden: x', success: true, ts };
    await planter.processEvents([event, { ...event, id: 'twin' }], { now: ts });
    await planter.processEvents([{ ...event }], { now: ts + 1000 });
    assert.equal(records.size, 1);
    assert.deepEqual(planter.dressing.counts, { release: 0, featFix: 0, commits: 1, records: 1 });
});

test('the billet rack counts every verified commit and keeps a feat/fix tier earned before', async () => {
    assert.equal(chronicleDressingFrame({ commits: 9 }, 'forge', 'billetRack'), null);
    assert.equal(chronicleDressingFrame({ commits: 10 }, 'forge', 'billetRack'), 0);
    const ledger = new ChronicleDressingLedger();
    await ledger.load({ async getMeta() { return { release: 0, featFix: 12, records: 30, ids: [] }; } });
    assert.equal(ledger.counts.commits, 12);
    assert.equal(ledger.frameFor('forge', 'billetRack'), 0);
});
