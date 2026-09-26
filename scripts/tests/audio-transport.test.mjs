import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TRANSPORT_HORIZON_SEC,
    Transport,
    WORK_HORIZON_SEC,
    renewalProcess,
} from '../../claudeville/src/presentation/shared/audio/Transport.js';

// A stepped audio clock, a wall clock and a manual interval queue.
function rig() {
    const engine = { context: { currentTime: 10 } };
    let wallMs = 0;
    const timers = {
        live: new Map(),
        created: 0,
        nextId: 1,
        setInterval(fn) {
            const id = this.nextId++;
            this.live.set(id, fn);
            this.created++;
            return id;
        },
        clearInterval(id) { this.live.delete(id); },
    };
    const transport = new Transport(engine, { timers, clock: () => wallMs });
    // One interval firing `lateMs` after it was due, audio time advancing with it.
    const tick = (lateMs = 0) => {
        const stepMs = 250 + lateMs;
        wallMs += stepMs;
        engine.context.currentTime += stepMs / 1000;
        for (const fn of [...timers.live.values()]) fn();
    };
    return { engine, timers, transport, tick };
}

function recorder(name, horizon) {
    const windows = [];
    return { name, horizon, windows, schedule(from, to) { windows.push([from, to]); } };
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('windows tile the audio clock: no gap, no overlap, each process at its own horizon', () => {
    const { engine, transport, tick } = rig();
    const music = transport.register(recorder('music'));
    const work = transport.register(recorder('work', WORK_HORIZON_SEC));
    const greedy = transport.register(recorder('greedy', 30));

    // Registration commits the first window at once.
    assert.deepEqual(music.windows, [[10, 10 + TRANSPORT_HORIZON_SEC]]);
    for (let i = 0; i < 8; i++) tick();

    for (const proc of [music, work, greedy]) {
        for (let i = 1; i < proc.windows.length; i++) {
            assert.ok(close(proc.windows[i][0], proc.windows[i - 1][1]), `${proc.name} windows are contiguous`);
        }
    }
    const now = engine.context.currentTime;
    assert.ok(close(music.windows.at(-1)[1], now + TRANSPORT_HORIZON_SEC));
    assert.ok(close(work.windows.at(-1)[1], now + WORK_HORIZON_SEC), 'work commits ≤ 350 ms ahead');
    assert.ok(close(greedy.windows.at(-1)[1], now + TRANSPORT_HORIZON_SEC), 'no process looks past 1.5 s');

    const diagnostics = transport.diagnostics();
    assert.equal(diagnostics.underruns, 0);
    assert.ok(diagnostics.aheadSec <= TRANSPORT_HORIZON_SEC + 1e-9);
    const byName = Object.fromEntries(diagnostics.processes.map((p) => [p.name, p]));
    assert.ok(byName.work.maxAheadSec <= WORK_HORIZON_SEC + 1e-9);
});

test('a stall past the horizon drops the missed events and counts them, never smears them onto now', () => {
    const { engine, transport, tick } = rig();
    const heard = [];
    transport.register(renewalProcess({
        name: 'crickets',
        first: () => 0.1,
        gap: () => 0.1,
        emit: (t) => heard.push({ t, committedAt: engine.context.currentTime }),
    }));
    tick();
    const before = heard.length;
    // The main thread blocks for 2.5 s: the 1.5 s commitment runs out.
    tick(2500);

    const diagnostics = transport.diagnostics();
    assert.equal(diagnostics.underruns, 1);
    assert.ok(diagnostics.lateDropped >= 8, `missed events counted (${diagnostics.lateDropped})`);
    assert.equal(diagnostics.maxStallMs, 2500);
    for (const { t, committedAt } of heard) {
        assert.ok(t >= committedAt - 1e-9, 'nothing is placed in the past');
    }
    // The events after the stall keep the renewal grid (0.1 s steps from
    // 10.1), they are not shifted to the moment the tick finally ran.
    for (const { t } of heard.slice(before)) {
        const steps = (t - 10.1) / 0.1;
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `event at ${t} stays on its grid`);
    }
});

test('pause stops the waking; resume re-arms from now with no catch-up and no underrun', () => {
    const { engine, timers, transport, tick } = rig();
    const heard = [];
    let rearmedAt = null;
    const proc = renewalProcess({
        name: 'birds',
        first: () => 0.5,
        gap: () => 0.2,
        emit: (t) => heard.push(t),
    });
    const rearm = proc.rearm;
    proc.rearm = (now) => {
        rearmedAt = now;
        rearm(now);
    };
    transport.register(proc);
    tick();
    transport.pause();
    assert.equal(timers.live.size, 0, 'no interval while paused');
    tick();
    const committed = heard.length;

    // A context that kept running while paused (no suspend): 120 s pass.
    engine.context.currentTime += 120;
    transport.resume();
    const now = engine.context.currentTime;
    assert.equal(rearmedAt, now);
    const fresh = heard.slice(committed);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((t) => t >= now + 0.5 - 1e-9), 'the first event is drawn from now, nothing missed is replayed');
    assert.equal(transport.diagnostics().underruns, 0);
    assert.equal(transport.diagnostics().lateDropped, 0);
    assert.equal(timers.live.size, 1);
});

test('a suspended clock resumes where it stopped: committed events stay, none repeat', () => {
    const { engine, transport, tick } = rig();
    const music = transport.register(recorder('music'));
    tick();
    transport.pause();
    // suspend() froze the audio clock.
    transport.resume();
    const [from, to] = music.windows.at(-1);
    assert.ok(close(from, music.windows.at(-2)[1]), 'the next window continues the committed one');
    assert.ok(close(to, engine.context.currentTime + TRANSPORT_HORIZON_SEC));
});

test('one interval, only while there is something to wake', () => {
    const { timers, transport } = rig();
    const a = transport.register(recorder('a'));
    const b = transport.register(recorder('b'));
    transport.register(a);
    assert.equal(timers.live.size, 1);
    assert.equal(timers.created, 1);
    transport.unregister(a);
    assert.equal(timers.live.size, 1);
    transport.unregister(b);
    assert.equal(timers.live.size, 0);
    transport.register(recorder('c'));
    transport.destroy();
    assert.equal(timers.live.size, 0);
    transport.register(recorder('d'));
    assert.equal(timers.live.size, 0, 'a destroyed transport never wakes again');
});
