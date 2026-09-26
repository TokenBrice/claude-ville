import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ACK_QUIET_MS,
    FOCUS_IDLE_MS,
    REMINDER_CAPS,
    isOperatorLooking,
    next,
} from '../../claudeville/src/presentation/shared/audio/UrgencyLadder.js';

const MIN = 60_000;
const T0 = 1_000_000_000;

function waiting(id, since, status = 'waiting_on_user') {
    return { id, name: id, status, awaitingSince: since };
}

// Drives the ladder once per second like the controller's signal route:
// plays every reminder the moment it is due and records it.
function simulate({ agents, minutes, acks = new Map(), settings = {}, onTick = null }) {
    const history = [];
    const played = [];
    for (let now = T0; now <= T0 + minutes * MIN; now += 1000) {
        onTick?.(now, acks);
        const r = next(now, agents(now), acks, settings, history);
        if (r.level > 0 && r.due <= now) {
            history.push({ at: now, level: r.level });
            played.push({ min: (now - T0) / MIN, level: r.level, family: r.family, count: r.count });
        }
    }
    return played;
}

test('needs-you climbs at 2, 6, 15 and 30 min, then one L2 every 30 min', () => {
    const played = simulate({ agents: () => [waiting('a', T0)], minutes: 125 });
    assert.deepEqual(played.map(p => [p.min, p.level]), [
        [2, 2], [6, 3], [15, 4], [30, 4], [60, 2], [90, 2], [120, 2],
    ]);
});

test('no reminder is closer than 120 s to another and none exceeds 12 per hour', () => {
    // A new agent every 90 s keeps re-anchoring nothing (oldest stays), but
    // mixed waits and answers must still respect the caps.
    const agents = (now) => {
        const list = [];
        for (let i = 0; i < 40; i++) {
            const since = T0 + i * 3 * MIN;
            // Each agent is answered 7 minutes after it started waiting.
            if (now >= since && now < since + 7 * MIN) list.push(waiting(`a${i}`, since));
        }
        return list;
    };
    const played = simulate({ agents, minutes: 120 });
    assert.ok(played.length > 12, `expected a busy ladder, got ${played.length}`);
    for (let i = 1; i < played.length; i++) {
        assert.ok((played[i].min - played[i - 1].min) * MIN >= REMINDER_CAPS.minGapMs);
    }
    for (const p of played) {
        const inHour = played.filter(q => q.min <= p.min && p.min - q.min < 60).length;
        assert.ok(inHour <= REMINDER_CAPS.perHour);
    }
});

test('errors hold at L3; quota stops after one L2', () => {
    const errors = simulate({ agents: () => [waiting('e', T0, 'errored')], minutes: 61 });
    assert.deepEqual(errors.map(p => [p.min, p.level]), [[2, 2], [6, 3], [15, 3], [30, 3], [60, 2]]);
    const quota = simulate({ agents: () => [waiting('q', T0, 'rate_limited')], minutes: 120 });
    assert.deepEqual(quota.map(p => [p.min, p.level]), [[2, 2]]);
});

test('the most urgent family present chooses the voice and its cap', () => {
    const agents = () => [waiting('q', T0, 'rate_limited'), waiting('n', T0 + MIN)];
    const played = simulate({ agents, minutes: 16 });
    // Anchored on the oldest (the quota agent), voiced and capped as needs-you.
    assert.deepEqual(played.map(p => [p.min, p.level, p.family, p.count]), [
        [2, 2, 'needsYou', 2], [6, 3, 'needsYou', 2], [15, 4, 'needsYou', 2],
    ]);
});

test('an acknowledgement quiets the wait for 10 min and consumes the steps inside it', () => {
    const played = simulate({
        agents: () => [waiting('a', T0)],
        minutes: 31,
        onTick: (now, acks) => { if (now === T0 + 3 * MIN) acks.set('a', now); },
    });
    // L3 at 6 fell inside the quiet window (3→13): no catch-up at 13.
    assert.deepEqual(played.map(p => [p.min, p.level]), [[2, 2], [15, 4], [30, 4]]);
    assert.ok(!played.some(p => p.min > 3 && p.min < 3 + ACK_QUIET_MS / MIN));
});

test('an acknowledged oldest agent hands the ladder to the next unacknowledged one', () => {
    const acks = new Map([['a', T0 + MIN]]);
    const r = next(T0 + 8 * MIN, [waiting('a', T0), waiting('b', T0 + 2 * MIN)], acks, {}, []);
    assert.equal(r.agentId, 'b');
    assert.equal(r.level, 3);
    assert.equal(r.count, 2);
    assert.equal(r.oldestMs, 6 * MIN);
    // Everyone acknowledged: nothing pending.
    acks.set('b', T0 + 7 * MIN);
    assert.equal(next(T0 + 8 * MIN, [waiting('a', T0), waiting('b', T0 + 2 * MIN)], acks).level, 0);
});

test('an acknowledgement from an earlier wait does not quiet a new one', () => {
    const acks = new Map([['a', T0 - 5 * MIN]]);
    const r = next(T0 + 2 * MIN, [waiting('a', T0)], acks, {}, []);
    assert.equal(r.level, 2);
    assert.equal(r.due, T0 + 2 * MIN);
});

test('focus defers a due reminder until input has been idle 15 s', () => {
    const now = T0 + 2 * MIN;
    const looking = { visible: true, focused: true, lastInputAt: now - 5000 };
    const r = next(now, [waiting('a', T0)], new Map(), { presence: looking }, []);
    assert.equal(r.level, 2);
    assert.equal(r.due, looking.lastInputAt + FOCUS_IDLE_MS);
    // Hidden or unfocused windows are not looking.
    assert.equal(next(now, [waiting('a', T0)], new Map(), { presence: { ...looking, focused: false } }).due, now);
    assert.equal(isOperatorLooking({ ...looking, visible: false }, now), false);
    assert.equal(isOperatorLooking(looking, now), true);
});

test('Gentle plays every step as L2; Off plays nothing', () => {
    const gentle = simulate({ agents: () => [waiting('a', T0)], minutes: 61, settings: { reminders: 'gentle' } });
    assert.deepEqual(gentle.map(p => [p.min, p.level]), [[2, 2], [6, 2], [15, 2], [30, 2], [60, 2]]);
    const off = simulate({ agents: () => [waiting('a', T0)], minutes: 61, settings: { reminders: 'off' } });
    assert.deepEqual(off, []);
});

test('a step spent inside an urgent guard is not replayed and does not count toward the caps', () => {
    const history = [{ at: T0 + 2 * MIN, level: 2, dropped: true }];
    const r = next(T0 + 2 * MIN + 1000, [waiting('a', T0)], new Map(), {}, history);
    assert.equal(r.level, 3);
    assert.equal(r.due, T0 + 6 * MIN);
});

test('agents without a wait anchor or with a non-actionable status never ring', () => {
    assert.equal(next(T0, [{ id: 'x', status: 'waiting_on_user' }]).level, 0);
    assert.equal(next(T0 + 10 * MIN, [waiting('w', T0, 'working')]).level, 0);
    assert.equal(next(T0 + 10 * MIN, []).level, 0);
});
