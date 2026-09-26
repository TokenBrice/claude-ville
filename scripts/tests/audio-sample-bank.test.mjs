import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BankLedger,
    LANE_SEPARATION_SEC,
    NOISE_ICC,
    NOISE_POOL,
    NoiseBuild,
    SampleBank,
    bufferBytes,
    laneMargin,
    loopDistance,
    pickLane,
} from '../../claudeville/src/presentation/shared/audio/SampleBank.js';
import { MEMORY_BUDGET } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { rngStream, setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';

const BUDGET = { totalBytes: 100, air: 30, noise: 60, workshop: 50 };

test('the noise pool fits the noise budget and every buffer loops beyond the 20 s repetition window', () => {
    let bytes = 0;
    for (const spec of Object.values(NOISE_POOL)) {
        for (const frames of spec.frames) {
            bytes += bufferBytes(frames, 2);
            assert.ok(frames / spec.sampleRate > 20, 'loop period must exceed the 0.5–20 s check');
        }
    }
    assert.ok(bytes <= MEMORY_BUDGET.noise, `${bytes} > ${MEMORY_BUDGET.noise}`);
});

test('an admitted entry evicts the least recently used entry of its own client first', () => {
    const ledger = new BankLedger(BUDGET);
    ledger.admit('w1', 'workshop', 20);
    ledger.admit('w2', 'workshop', 20);
    ledger.touch('w1');
    assert.deepEqual(ledger.admit('w3', 'workshop', 20), ['w2']);
    assert.equal(ledger.clientBytes('workshop'), 40);
    assert.equal(ledger.evictions, 1);
    assert.ok(ledger.has('w1') && ledger.has('w3') && !ledger.has('w2'));
});

test('the total budget evicts across clients but never a pinned entry', () => {
    const ledger = new BankLedger(BUDGET);
    ledger.admit('air', 'air', 30, { pinned: true });
    ledger.admit('n1', 'noise', 30);
    ledger.admit('w1', 'workshop', 30);
    // 90 used; 45 more workshop bytes need w1 out of the workshop budget
    // (75 > 50), then 105 > 100 total: air is pinned, so n1 goes.
    assert.deepEqual(ledger.admit('w2', 'workshop', 45), ['w1', 'n1']);
    assert.equal(ledger.totalBytes, 75);
    assert.ok(ledger.has('air'));
});

test('an entry that cannot fit changes nothing', () => {
    const ledger = new BankLedger(BUDGET);
    ledger.admit('air', 'air', 30, { pinned: true });
    assert.equal(ledger.admit('big', 'air', 31), null);
    assert.equal(ledger.admit('air2', 'air', 10), null, 'the pinned entry fills the air budget');
    assert.equal(ledger.totalBytes, 30);
    assert.throws(() => ledger.admit('x', 'nobody', 1), /Unknown SampleBank client/);
});

test('replacing a key frees its old bytes before planning', () => {
    const ledger = new BankLedger(BUDGET);
    ledger.admit('w1', 'workshop', 40);
    assert.deepEqual(ledger.admit('w1', 'workshop', 45), []);
    assert.equal(ledger.clientBytes('workshop'), 45);
    assert.equal(ledger.totalBytes, 45);
});

function fakeOffline(channels, length, sampleRate) {
    return {
        length,
        startRendering: () => Promise.resolve({ length, numberOfChannels: channels, sampleRate }),
    };
}

test('bakes run one per idle slice, never before, and resolve false when over budget', async () => {
    const idle = [];
    const bank = new SampleBank(null, {
        budget: BUDGET,
        idle: (fn) => { idle.push(fn); return idle.length; },
        cancelIdle: () => {},
        createOffline: fakeOffline,
    });
    let rendered = 0;
    const render = () => { rendered++; };
    const a = bank.bake('a', { client: 'workshop', seconds: 5, channels: 1, sampleRate: 1, render });
    const b = bank.bake('b', { client: 'workshop', seconds: 20, channels: 1, sampleRate: 1, render });
    assert.equal(bank.bake('a', { client: 'workshop', seconds: 5, sampleRate: 1, render }), a, 'one job per key');
    assert.equal(rendered, 0, 'nothing renders outside an idle slice');
    assert.equal(bank.has('a'), false);
    idle.shift()({});
    assert.equal(await a, true);
    assert.equal(bank.has('a'), true);
    assert.equal(bank.stats().residentBytes, 20);
    idle.shift()({});
    assert.equal(await b, false, '80 bytes exceed the 50-byte workshop budget');
    assert.equal(rendered, 1, 'an entry that cannot fit is never rendered');
    assert.equal(bank.stats().failed, 1);
});

test('destroy cancels pending bakes', async () => {
    const bank = new SampleBank(null, { budget: BUDGET, idle: () => 1, cancelIdle: () => {}, createOffline: fakeOffline });
    const pending = bank.bake('a', { client: 'air', seconds: 1, sampleRate: 1, render: () => {} });
    bank.destroy();
    assert.equal(await pending, false);
    assert.equal(bank.stats().pending, 0);
});

test('lane margins follow both heads over their shared life', () => {
    const P = 20;
    // Same rate: the gap never changes.
    assert.equal(laneMargin({ offset: 12, start: 0, rate: 1, end: Infinity }, { offset: 3, start: 0, rate: 1, end: Infinity }, P), 9);
    // A one-shot starting 1 s from a live head is 1 s clear at best, whatever its drift.
    const thunder = { offset: 12, start: 10, rate: 0.7, end: 18 };
    const wind = { offset: 3, start: 0, rate: 1, end: Infinity };
    assert.ok(Math.abs(laneMargin(thunder, wind, P) - 1.0) < 1e-9, 'at t = 10 the wind head is at 13, 1 s from the thunder head');
    // Different rates on two open-ended lives eventually meet.
    assert.equal(laneMargin({ ...wind, rate: 1.01 }, wind, P), 0);
    // Lives that never overlap never collide.
    assert.equal(laneMargin({ ...thunder, start: 0, end: 1 }, { ...thunder, start: 2, end: 3 }, P), Infinity);
    assert.equal(loopDistance(1, 20.3, 21.3), 2);
});

test('continuous lanes take their own buffers; a one-shot keeps 5 s clear for its whole life', () => {
    const rng = rngStream('test.lanes');
    const periods = [22.05, 22.61, 23.17];
    const lanes = [];
    for (let i = 0; i < 3; i++) {
        const lane = { start: 0, rate: 1, end: Infinity, oneShot: false };
        lanes.push({ ...lane, ...pickLane(rng, periods, lanes, lane) });
    }
    assert.deepEqual(lanes.map(l => l.index).sort(), [0, 1, 2]);
    for (let k = 0; k < 40; k++) {
        const shot = { start: 30, rate: 0.65, end: 30 + 8 / 0.65, oneShot: true };
        const { index, offset } = pickLane(rng, periods, lanes, shot);
        const placed = { ...shot, index, offset };
        for (const other of lanes.filter(l => l.index === index)) {
            assert.ok(laneMargin(placed, other, periods[index]) >= LANE_SEPARATION_SEC);
        }
    }
});

test('a pool build is deterministic per seed, seamless at the loop and carries the stereo correlation', () => {
    setRngSeed('pool-test');
    const one = new NoiseBuild('white', 0, rngStream('noise.pool.white:0')).finish();
    const two = new NoiseBuild('white', 0, rngStream('noise.pool.white:0')).finish();
    setRngSeed(null);
    assert.deepEqual(one[0].subarray(0, 64), two[0].subarray(0, 64));
    const [L, R] = one;
    assert.equal(L.length, NOISE_POOL.white.frames[0]);
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < L.length; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
    assert.ok(Math.abs(lr / Math.sqrt(ll * rr) - NOISE_ICC) < 0.01);

    // Brown: a one-pole low-pass, so neighbouring samples barely move — the
    // loop seam (end → start) must be no bigger a step than the body's steps.
    const [bL] = new NoiseBuild('brown', 1, rngStream('noise.pool.brown:1')).finish();
    let maxStep = 0;
    for (let i = 1; i < bL.length; i++) maxStep = Math.max(maxStep, Math.abs(bL[i] - bL[i - 1]));
    assert.ok(Math.abs(bL[0] - bL[bL.length - 1]) <= maxStep * 1.2);
    let sum = 0;
    for (const v of bL) sum += v * v;
    assert.ok(Math.abs(Math.sqrt(sum / bL.length) - NOISE_POOL.brown.rms) < 0.02, 'brown keeps today\'s RMS');
});
