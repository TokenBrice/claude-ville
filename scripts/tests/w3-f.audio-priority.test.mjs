import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CUE_LANES,
    CueGovernor,
    collapseCueBurst,
    compareCuePriority,
    cueLifecycleDecision,
} from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';

test('an urgent cue preempts a routine cue', () => {
    const urgent = { kind: 'summons', lane: CUE_LANES.NEEDS_YOU };
    const routine = { kind: 'arrival', lane: CUE_LANES.ROUTINE };

    assert.ok(compareCuePriority(urgent, routine) < 0);
    assert.equal([routine, urgent].sort(compareCuePriority)[0], urgent);
});

test('six routine cues in one aggregation window become one honest result', () => {
    const cues = Array.from({ length: 6 }, (_, index) => ({
        kind: 'arrival',
        lane: CUE_LANES.ROUTINE,
        agentId: `agent-${index}`,
        at: 1000 + index * 20,
    }));

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].eventKind, 'aggregate');
    assert.equal(collapsed[0].aggregateCount, 6);
    assert.equal(collapsed[0].agentId, null);
    assert.match(collapsed[0].label, /6 arrivals/);
});

test('urgent announcements never collapse (synthesis clusters in the governor)', () => {
    const cues = Array.from({ length: 6 }, (_, index) => ({
        kind: 'summons',
        lane: CUE_LANES.NEEDS_YOU,
        agentId: `agent-${index}`,
    }));

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 6);
    assert.ok(collapsed.every(cue => cue.kind === 'summons'));
});

test('provider-voiced council cues bypass burst aggregation', () => {
    const cues = [
        { kind: 'council', lane: CUE_LANES.ROUTINE, provider: 'claude', aggregate: false },
        { kind: 'council', lane: CUE_LANES.ROUTINE, provider: 'codex', aggregate: false },
    ];

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 2);
    assert.deepEqual(collapsed.map(cue => cue.provider), ['claude', 'codex']);
});

test('hidden lifecycle suppresses ambience but permits summons without a return backlog', () => {
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.SCENERY,
        hidden: true,
    }), 'suppress');
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.NEEDS_YOU,
        hidden: true,
    }), 'play');
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.ROUTINE,
        returning: true,
    }), 'discard');
    // The signal stratum's reminder lane rings through the wake; outcomes do not.
    assert.equal(cueLifecycleDecision({ lane: CUE_LANES.REMINDER, hidden: true }), 'play');
    assert.equal(cueLifecycleDecision({ lane: CUE_LANES.OUTCOME, hidden: true }), 'suppress');
});

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Short windows keep the timing real without slowing the suite: a 20 ms
// routine window and an 80 ms team hold stand in for 180 ms and 600 ms.
function recordingGovernor(options = {}) {
    const governor = new CueGovernor({
        maxPerMinute: 6,
        minSpacingMs: 4000,
        aggregationWindowMs: 20,
        teamHoldMs: 80,
        ...options,
    });
    const events = [];
    const play = (cue, stage = {}) => {
        if (stage.prepare) {
            events.push({ stage: 'prepare', kind: cue.kind });
            return () => events.push({ stage: 'cancel', kind: cue.kind });
        }
        events.push({
            stage: stage.announceOnly ? 'announce' : (cue.flock ? 'flock' : 'play'),
            kind: cue.eventKind || cue.kind,
            agentId: cue.agentId ?? null,
            label: cue.label ?? null,
            replaces: cue.replaces ?? null,
            ...(cue.flock ? { clusterIndex: cue.clusterIndex } : {}),
        });
        return true;
    };
    return { governor, events, play };
}

const arrival = (agentId, teamName = null) => ({
    kind: 'arrival',
    lane: CUE_LANES.ROUTINE,
    agentId,
    teamName,
    cooldownMs: 0,
});

const ceremony = (kind, supersedes, lane = CUE_LANES.ROUTINE) => ({
    kind,
    lane,
    cooldownMs: 0,
    aggregate: false,
    supersedes,
});

test('a team arrival burst is held until its gathering replaces it', async () => {
    const { governor, events, play } = recordingGovernor();
    governor.submit(arrival('a', 'blue'), play);
    governor.submit(arrival('b', 'blue'), play);
    await wait(40);
    assert.equal(events.some(event => event.stage === 'announce'), false, 'past the plain window, still held');

    assert.equal(governor.submit(ceremony('council', ['a', 'b']), play), true);
    await wait(100);

    assert.deepEqual(events.map(event => `${event.stage}:${event.kind}`), [
        'prepare:arrival',
        'cancel:arrival',
        'play:council',
    ]);
    assert.deepEqual(
        { count: events[2].replaces.count, parts: events[2].replaces.parts },
        { count: 2, parts: '2 arrivals' },
    );
    assert.equal(governor.snapshot().ceremonies.superseded, 1);
    governor.destroy();
});

test('a ceremony replaces a just-announced aggregate and releases its unsounded notes', async () => {
    const { governor, events, play } = recordingGovernor();
    governor.submit(arrival('a'), play);
    governor.submit(arrival('b'), play);
    await wait(40);
    assert.equal(events.at(-1).stage, 'announce');
    assert.equal(events.at(-1).kind, 'aggregate');

    // Inside the spacing window the council would be refused without supersedes.
    assert.equal(governor.submit(ceremony('council', ['a', 'b', 'c']), play), true);
    assert.deepEqual(events.slice(-2).map(event => `${event.stage}:${event.kind}`), [
        'cancel:arrival',
        'play:council',
    ]);
    assert.deepEqual(events.at(-1).replaces, {
        kind: 'aggregate',
        agentId: null,
        label: 'Routine activity: 2 arrivals',
        count: 2,
        parts: '2 arrivals',
    });
    governor.destroy();
});

test('a ceremony never absorbs parts that belong to someone else', async () => {
    const { governor, events, play } = recordingGovernor();
    governor.submit(arrival('a', 'blue'), play);
    governor.submit(arrival('stranger'), play);
    governor.submit(ceremony('council', ['a']), play);
    await wait(100);

    const council = events.find(event => event.kind === 'council');
    assert.equal(council.replaces, null);
    assert.equal(events.some(event => event.stage === 'cancel'), false);
    assert.equal(events.at(-1).stage, 'announce');
    governor.destroy();
});

test('a ceremony bypasses the spacing rule once but never the per-minute budget', () => {
    const { governor, events, play } = recordingGovernor({ maxPerMinute: 2, outcomeReservePerMinute: 0 });
    const scenery = (kind, extra = {}) => ({
        kind,
        lane: CUE_LANES.SCENERY,
        cooldownMs: 0,
        aggregate: false,
        ...extra,
    });
    assert.equal(governor.submit(scenery('hourBell'), play), true);
    assert.equal(governor.submit(scenery('aurora'), play), false, 'spacing refuses a plain cue');
    assert.equal(governor.submit(scenery('aurora', { supersedes: [] }), play), true);
    assert.equal(governor.submit(scenery('aurora', { supersedes: [] }), play), false, 'budget still applies');
    assert.deepEqual(events.map(event => event.kind), ['hourBell', 'aurora']);
    governor.destroy();
});

// Date.now() stands still inside `fn` except where the test moves it.
function withClock(fn) {
    const realNow = Date.now;
    const clock = { now: 1_000_000 };
    Date.now = () => clock.now;
    try { return fn(clock); } finally { Date.now = realNow; }
}

const urgent = (agentId, kind = 'summons', lane = CUE_LANES.NEEDS_YOU) => ({
    kind, lane, agentId, cooldownMs: 45000, guardMs: 2800,
});

test('six same-lane urgent raises are one call, four flock strikes and six captions', () => withClock((clock) => {
    const { governor, events, play } = recordingGovernor();
    for (let i = 0; i < 6; i++) {
        assert.equal(governor.submit(urgent(`a${i}`), play), true);
        clock.now += 30;
    }
    assert.deepEqual(events.map(event => event.stage), ['play', 'flock', 'flock', 'flock', 'flock', 'announce']);
    assert.deepEqual(events.filter(event => event.stage === 'flock').map(event => event.clusterIndex), [1, 2, 3, 4]);
    assert.deepEqual(events.map(event => event.agentId), ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    // Another lane is its own call; after the micro-window a new call leads.
    governor.submit(urgent('e0', 'distress', CUE_LANES.ERRORS), play);
    assert.equal(events.at(-1).stage, 'play');
    clock.now += 400;
    governor.submit(urgent('a6'), play);
    assert.equal(events.at(-1).stage, 'play');
    // The per-agent cooldown still holds inside a cluster.
    governor.submit(urgent('a6'), play);
    assert.equal(events.filter(event => event.agentId === 'a6').length, 1);
    governor.destroy();
}));

test('reminders are spent inside an urgent guard and capped at 120 s and 12 per hour', () => withClock((clock) => {
    const { governor, events, play } = recordingGovernor();
    const reminder = () => ({ kind: 'reminder', lane: CUE_LANES.REMINDER, cooldownMs: 0, level: 2 });
    governor.submit(urgent('a'), play);
    clock.now += 1000;
    assert.equal(governor.submit(reminder(), play), false, 'inside the entry guard');
    clock.now += 3000;
    assert.equal(governor.submit(reminder(), play), true);
    clock.now += 119_000;
    assert.equal(governor.submit(reminder(), play), false, 'closer than 120 s');
    let heard = 1;
    for (let i = 0; i < 20; i++) {
        clock.now += 120_000;
        if (clock.now - 1_004_000 >= 3_600_000) break;
        if (governor.submit(reminder(), play)) heard++;
    }
    assert.equal(heard, 12);
    // Other reminder-lane kinds (answered, link cues) are not ladder-capped.
    assert.equal(governor.submit({ kind: 'answered', lane: CUE_LANES.REMINDER, cooldownMs: 0 }, play), true);
    assert.equal(events.filter(event => event.kind === 'reminder').length, 12);
    governor.destroy();
}));

test('outcomes keep a reserve of the routine budget; one Major at a time', () => withClock((clock) => {
    const { governor, events, play } = recordingGovernor({ minSpacingMs: 0 });
    const routine = i => ({ kind: `r${i}`, lane: CUE_LANES.SCENERY, cooldownMs: 0, aggregate: false });
    const outcome = (kind, extra = {}) => ({ kind, lane: CUE_LANES.OUTCOME, cooldownMs: 0, ...extra });
    const accepted = [0, 1, 2, 3, 4].map(i => governor.submit(routine(i), play));
    assert.deepEqual(accepted, [true, true, true, true, false], 'routine stops at 6 − 2 per minute');
    assert.equal(governor.submit(outcome('release'), play), true);
    assert.equal(governor.submit(outcome('release', { cooldownKey: 'release:2' }), play), false, 'one Major active');
    clock.now += 2600;
    assert.equal(governor.submit(outcome('commit'), play), true);
    assert.equal(governor.submit(outcome('push'), play), false, 'the shared 6 per minute is spent');
    assert.deepEqual(events.map(event => event.kind), ['r0', 'r1', 'r2', 'r3', 'release', 'commit']);
    governor.destroy();
}));
