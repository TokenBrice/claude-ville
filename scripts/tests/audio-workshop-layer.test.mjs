import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FLAM,
    FOCUS_DB,
    OVERLAP_GUARD_DB,
    STRIKE_CEILING_DB,
    WORK_BUDGET,
    admitStrike,
    clusterAccents,
    createArbiter,
    floorDue,
    floorTicks,
    overlapGuard,
    placeAccents,
    strikeGain,
} from '../../claudeville/src/presentation/shared/audio/layers/WorkshopLayer.js';

const BUILDINGS = ['forge', 'archive', 'mine', 'taskboard', 'observatory', 'portal', 'command', 'harbor'];
const dB = gain => 20 * Math.log10(gain);

function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('the arbiter never admits more than 3 strikes in any 1 s, however dense the demand', () => {
    const rng = mulberry(7);
    for (let run = 0; run < 50; run++) {
        const arbiter = createArbiter();
        const kept = [];
        let t = 0;
        for (let i = 0; i < 400; i++) {
            t += rng() * 0.12;
            const strike = {
                t,
                building: BUILDINGS[Math.floor(rng() * BUILDINGS.length)],
                kind: rng() < 0.4 ? 'accent' : 'ghost',
                priority: rng() < 0.2,
                flam: rng() < 0.05,
            };
            if (admitStrike(arbiter, strike) === null) kept.push(strike);
        }
        for (const s of kept) {
            const inWindow = kept.filter(k => k.t > s.t - WORK_BUDGET.globalWindowSec && k.t <= s.t).length;
            assert.ok(inWindow <= WORK_BUDGET.globalMax, `run ${run}: ${inWindow} strikes in the 1 s before ${s.t}`);
        }
        const byBuilding = new Map();
        for (const s of kept.filter(k => !k.flam)) {
            const last = byBuilding.get(s.building);
            if (last != null) assert.ok(s.t - last >= WORK_BUDGET.minIoiSec - 1e-9, `IOI ${s.t - last}`);
            byBuilding.set(s.building, s.t);
        }
    }
});

test('a plain ghost needs a quiet window; the liveness ghost and accents may fill it to 3', () => {
    const arbiter = createArbiter();
    assert.equal(admitStrike(arbiter, { t: 0, building: 'forge', kind: 'accent' }), null);
    assert.equal(admitStrike(arbiter, { t: 0.3, building: 'archive', kind: 'accent' }), null);
    assert.equal(admitStrike(arbiter, { t: 0.5, building: 'harbor', kind: 'ghost' }), 'global');
    assert.equal(admitStrike(arbiter, { t: 0.5, building: 'harbor', kind: 'ghost', priority: true }), null);
    assert.equal(admitStrike(arbiter, { t: 0.7, building: 'command', kind: 'accent' }), 'global');
    assert.equal(admitStrike(arbiter, { t: 1.05, building: 'command', kind: 'accent' }), null);
});

test('a strike yields one place in the window to a building whose liveness strike was refused', () => {
    const arbiter = createArbiter();
    assert.equal(admitStrike(arbiter, { t: 0, building: 'mine', kind: 'accent' }), null);
    assert.equal(admitStrike(arbiter, { t: 0.3, building: 'archive', kind: 'accent' }), null);
    assert.equal(admitStrike(arbiter, { t: 0.6, building: 'harbor', kind: 'accent', yieldSlot: true }), 'global');
    assert.equal(admitStrike(arbiter, { t: 0.7, building: 'forge', kind: 'ghost', priority: true }), null);
});

test('a building bucket refuses a burst beyond 0.8/s but lets a priority ghost through', () => {
    const arbiter = createArbiter();
    const at = t => ({ t, building: 'forge', kind: 'accent' });
    assert.equal(admitStrike(arbiter, at(0)), null);
    assert.equal(admitStrike(arbiter, at(0.25)), null);
    assert.equal(admitStrike(arbiter, at(0.5)), 'building');
    assert.equal(admitStrike(arbiter, { t: 0.5, building: 'forge', kind: 'ghost' }), 'building');
    // Refilled to the overdraw line by 1.05 s: the floor's ghost may take it.
    assert.equal(admitStrike(arbiter, { t: 1.3, building: 'forge', kind: 'ghost', priority: true }), null);
});

test('the overlap guard marks a strike that starts inside any earlier strike\'s loud window', () => {
    const guard = { loudUntil: -Infinity };
    assert.equal(overlapGuard(guard, 1.0, 0.15), false);
    assert.equal(overlapGuard(guard, 1.1, 0.05), true);
    // The longer earlier window still rules after a short guarded strike.
    assert.equal(overlapGuard(guard, 1.14, 0.2), true);
    assert.equal(overlapGuard(guard, 1.36, 0.1), false);
});

test('a strike never peaks over its ceiling; guarded strikes 6 dB lower; focus lifts exactly +4 dB', () => {
    for (const ceilingDb of [STRIKE_CEILING_DB, STRIKE_CEILING_DB - 14]) {
        const ceiling = 10 ** (ceilingDb / 20);
        for (const truePeak of [0.8, 1, 1.3]) {
            for (const airSend of [0, 0.1, 0.3]) {
                for (const level of [0.3, 1, 2]) {
                    const gain = strikeGain({ level, truePeak, airSend, ceilingDb });
                    assert.ok(gain * truePeak * (1 + airSend * 1.29) <= ceiling * (1 + 1e-9));
                }
                const full = strikeGain({ truePeak, airSend, ceilingDb });
                assert.ok(Math.abs(full * truePeak * (1 + airSend * 1.29) - ceiling) < ceiling * 1e-9, 'level 1 sits at the ceiling');
                const guarded = strikeGain({ truePeak, airSend, ceilingDb, guarded: true });
                assert.ok(Math.abs(dB(guarded / full) - OVERLAP_GUARD_DB) < 1e-9);
            }
        }
    }
    for (const level of [0.2, 1]) {
        const plain = strikeGain({ level, airSend: 0.1 });
        const focused = strikeGain({ level, airSend: 0.1, focused: true });
        assert.ok(Math.abs(dB(focused / plain) - FOCUS_DB) < 1e-9);
    }
});

test('World accents land exactly on drawn downbeats, the drawn agent first', () => {
    const slots = [
        { agentId: 'F1', slot: 0, pitchIndex: 0, verify: false },
        { agentId: 'F2', slot: 1, pitchIndex: 1, verify: false },
    ];
    const owed = [
        { agentId: 'F1', pitchIndex: 0, slot: 0, dueMs: 5000 },
        { agentId: 'F2', pitchIndex: 1, slot: 1, dueMs: 5100 },
    ];
    const accents = placeAccents({ owed, beats: [{ atMs: 4600, agentId: 'F2' }], fromMs: 4500, toMs: 4850, slots });
    assert.deepEqual(accents.map(a => [a.at, a.agentId, a.pitchIndex, a.downbeatMs]), [[4600, 'F2', 1, 4600]]);
    assert.deepEqual(owed.map(o => o.agentId), ['F1']);
});

test('a downbeat by an agent with nothing owed sounds that agent\'s pitch for the oldest owed accent', () => {
    const slots = [
        { agentId: 'F1', slot: 0, pitchIndex: 0 },
        { agentId: 'F3', slot: 2, pitchIndex: 2 },
    ];
    const owed = [{ agentId: 'F1', pitchIndex: 0, slot: 0, dueMs: 9000 }];
    const [accent] = placeAccents({ owed, beats: [{ atMs: 8000, agentId: 'F3' }], fromMs: 7900, toMs: 8200, slots });
    assert.deepEqual([accent.at, accent.agentId, accent.pitchIndex], [8000, 'F3', 2]);
    assert.equal(owed.length, 0);
});

test('owed accents without a downbeat strike on their grid tick when due; past-due ones are dropped', () => {
    const owed = [
        { agentId: 'A', pitchIndex: 0, slot: 0, dueMs: 900 },
        { agentId: 'B', pitchIndex: 1, slot: 1, dueMs: 1200 },
        { agentId: 'C', pitchIndex: 2, slot: 2, dueMs: 2000 },
    ];
    const accents = placeAccents({ owed, beats: [], fromMs: 1000, toMs: 1350, slots: [] });
    assert.deepEqual(accents.map(a => [a.agentId, a.at, a.downbeatMs]), [['B', 1200, null]]);
    assert.deepEqual(owed.map(o => o.agentId), ['C']);
    // A downbeat outside the window is ignored.
    assert.deepEqual(placeAccents({ owed, beats: [{ atMs: 5000, agentId: 'C' }], fromMs: 1350, toMs: 1700 }), []);
});

test('coincident accents flam 28 ms apart at the Forge (at most 3) and merge at unpitched buildings', () => {
    const at = ms => [0, 1, 2, 3].map(i => ({ at: ms, agentId: `F${i}`, pitchIndex: i }));
    const forge = clusterAccents(at(1000), 'forge');
    assert.deepEqual(forge.map(a => [a.at, a.flam]), [[1000, false], [1000 + FLAM.stepSec * 1000, true], [1000 + 2 * FLAM.stepSec * 1000, true]]);
    assert.deepEqual(forge.map(a => a.pitchIndex), [0, 1, 2]);
    assert.deepEqual(clusterAccents(at(1000), 'command').map(a => a.agentId), ['F0']);
    // Accents a stride apart are separate onsets.
    assert.equal(clusterAccents([{ at: 0 }, { at: 460 }], 'forge').every(a => !a.flam), true);
});

test('the liveness floor stands by on every grid tick once a building has been silent half its window', () => {
    assert.deepEqual(floorTicks(460, 1000, 2400), [1380, 1840, 2300]);
    assert.deepEqual(floorTicks(460, 1380, 1380), []);
    const L = 2760;
    assert.equal(floorDue(0, 1379, L), false);
    assert.equal(floorDue(0, 1380, L), true);
    // Refused at the first due tick, the floor is still due a gesture later.
    assert.equal(floorDue(0, 1840, L), true);
});
