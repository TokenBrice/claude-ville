import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ChronicleEventKind,
    ChronicleLog,
    DuskLedger,
    DUSK_LEDGER_META_KEY,
    duskLedgerDue,
    rollupDayLedger,
} from '../../claudeville/src/application/ChronicleLog.js';
import { HEARTH_FIXTURES, hearthLightSources } from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';

const K = ChronicleEventKind;

function fakeStore(events = [], meta = {}) {
    const rows = new Map(Object.entries(meta).map(([key, value]) => [key, { key, value }]));
    return {
        rows,
        puts: 0,
        async queryRange(_name, { lower, upper }) {
            return events.filter((event) => event.ts >= lower && event.ts <= upper);
        },
        async get(name, key) {
            return name === 'meta' ? rows.get(key) || null : null;
        },
        async put(name, record) {
            if (name === 'meta') { rows.set(record.key, record); this.puts++; }
        },
    };
}

const dayMs = (h, m = 0) => new Date(2026, 9, 9, h, m).getTime();

const EVENTS = [
    { kind: K.COMMIT, ts: dayMs(9), subject: 'fix(world): clamp the plaza pool' },
    { kind: K.COMMIT, ts: dayMs(10), subject: 'feat: dusk ledger' },
    { kind: K.COMMIT, ts: dayMs(11), subject: 'fix: reload gate' },
    { kind: K.COMMIT, ts: dayMs(11, 30), subject: 'fixup the docs' }, // not a conventional fix
    { kind: K.WAITING, ts: dayMs(12) },
    { kind: K.WAITING, ts: dayMs(13) },
    { kind: K.RESOLVED, ts: dayMs(13, 5), waitedMs: 300000 },
    { kind: K.ARRIVED, ts: dayMs(8) },
    { kind: K.COMPLETED, ts: dayMs(15) },
    { kind: K.PUSH, ts: dayMs(16) },
    // Yesterday's records never count today.
    { kind: K.COMMIT, ts: new Date(2026, 9, 8, 22).getTime(), subject: 'fix: yesterday' },
    { kind: K.WAITING, ts: new Date(2026, 9, 8, 23).getTime() },
];

test('the rollup is exact: shipped commits, conventional fixes, waits, observed tokens', () => {
    const today = EVENTS.filter((event) => new Date(event.ts).getDate() === 9);
    assert.deepEqual({ ...rollupDayLedger(today, { dateKey: '2026-10-09', tokens: 1234567.9 }) }, {
        dateKey: '2026-10-09', shipped: 4, mended: 2, waited: 2, tokens: 1234567,
    });
    assert.deepEqual({ ...rollupDayLedger([]) }, { dateKey: null, shipped: 0, mended: 0, waited: 0, tokens: 0 });
});

test('todayRollup folds only the local day and reads the day spend', async () => {
    const store = fakeStore(EVENTS, { 'usageLedger:2026-10-09': { tokens: 98765, cost: 1.2 } });
    const log = new ChronicleLog({ store });
    const rollup = await log.todayRollup(dayMs(19));
    assert.deepEqual({ ...rollup }, { dateKey: '2026-10-09', shipped: 4, mended: 2, waited: 2, tokens: 98765 });
});

test('the stone is due only at the dusk lamp course, once a local day', () => {
    assert.equal(duskLedgerDue({ lampsLit: true, minuteOfDay: 19 * 60, dateKey: '2026-10-09' }), true);
    assert.equal(duskLedgerDue({ lampsLit: false, minuteOfDay: 19 * 60, dateKey: '2026-10-09' }), false);
    // The pre-dawn lamps of a new day never set its ledger.
    assert.equal(duskLedgerDue({ lampsLit: true, minuteOfDay: 4 * 60, dateKey: '2026-10-09' }), false);
    assert.equal(duskLedgerDue({ lampsLit: true, minuteOfDay: 19 * 60, dateKey: '2026-10-09', stone: { dateKey: '2026-10-09' } }), false);
});

test('a reload at dusk does not re-fire; the next dusk retires the stone', async () => {
    const store = fakeStore(EVENTS, { 'usageLedger:2026-10-09': { tokens: 500 } });
    const log = new ChronicleLog({ store });
    const ledger = new DuskLedger({ store });
    assert.equal(await ledger.evaluate(dayMs(11), { lampsLit: false, minuteOfDay: 11 * 60, chronicleLog: log }), null);
    const stone = await ledger.evaluate(dayMs(19), { lampsLit: true, minuteOfDay: 19 * 60, chronicleLog: log });
    assert.equal(stone.dateKey, '2026-10-09');
    assert.deepEqual([stone.shipped, stone.mended, stone.waited, stone.tokens], [4, 2, 2, 500]);
    assert.equal(store.rows.get(DUSK_LEDGER_META_KEY).value.dateKey, '2026-10-09');
    assert.equal(await ledger.evaluate(dayMs(19, 30), { lampsLit: true, minuteOfDay: 19 * 60 + 30, chronicleLog: log }), null);

    // Reload: a fresh ledger on the same store finds today's stone and holds it.
    const reloaded = new DuskLedger({ store });
    assert.equal(await reloaded.evaluate(dayMs(20), { lampsLit: true, minuteOfDay: 20 * 60, chronicleLog: log }), null);
    assert.equal(reloaded.stone.dateKey, '2026-10-09');
    assert.equal(store.puts, 1);

    // Held through the next morning, replaced at the next dusk.
    const nextMorning = new Date(2026, 9, 10, 9).getTime();
    assert.equal(await reloaded.evaluate(nextMorning, { lampsLit: false, minuteOfDay: 9 * 60, chronicleLog: log }), null);
    assert.equal(reloaded.stone.dateKey, '2026-10-09');
    const next = await reloaded.evaluate(new Date(2026, 9, 10, 19).getTime(), { lampsLit: true, minuteOfDay: 19 * 60, chronicleLog: log });
    assert.equal(next.dateKey, '2026-10-10');
    assert.deepEqual([next.shipped, next.mended, next.waited, next.tokens], [0, 0, 0, 0]);
    assert.equal(store.puts, 2);
});

test('hearths stand outside every work building and light only on the lamps gate', () => {
    assert.ok(HEARTH_FIXTURES.length >= 3);
    for (const hearth of HEARTH_FIXTURES) {
        for (const def of BUILDING_DEFS) {
            const inside = hearth.tileX >= def.x && hearth.tileX < def.x + def.width
                && hearth.tileY >= def.y && hearth.tileY < def.y + def.height;
            assert.ok(!inside, `${hearth.id} inside ${def.type}`);
        }
        assert.ok(!BUILDING_DEFS.some((def) => hearth.id.includes(def.type)), hearth.id);
    }
    // No agent input exists: an empty village at night lights exactly the hearths.
    assert.deepEqual(hearthLightSources({ lampsLit: false }), []);
    const lit = hearthLightSources({ lampsLit: true, core: 1 });
    assert.deepEqual(lit.map((light) => light.id), HEARTH_FIXTURES.map((row) => row.id));
    for (const light of lit) {
        assert.equal(light.role, 'fixture');
        assert.equal(light.fire, false);
    }
});
