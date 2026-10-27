import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AttentionService,
    DESKTOP_ANNOUNCED_KEY,
    DESKTOP_SUMMARY_TAG,
} from '../../claudeville/src/application/AttentionService.js';

class FakeNotification {
    static permission = 'granted';
    static instances = [];

    constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closeCalls = 0;
        FakeNotification.instances.push(this);
    }

    close() {
        this.closeCalls++;
        this.onclose?.();
    }
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
    };
}

const MINUTE = 60_000;

function waiting(id, awaitingSince) {
    return { id, name: id, status: 'waiting_on_user', awaitingSince, projectPath: '/work/demo' };
}

function harness({ session = memoryStorage(), agents = [], clock = { now: 100 * MINUTE } } = {}) {
    const world = { agents: new Map(agents.map(agent => [agent.id, agent])) };
    const service = new AttentionService(world, {
        document: { title: '', visibilityState: 'hidden', querySelector: () => null },
        NotificationClass: FakeNotification,
        sessionStorage: session,
        now: () => clock.now,
    });
    service.desktopAlerts = true;
    return { world, service, session, clock };
}

test('nine standing waits at a hidden boot raise one summary under its own tag (UI-7)', () => {
    FakeNotification.instances = [];
    const agents = Array.from({ length: 9 }, (_, index) => waiting(`a${index}`, (100 - 9 + index) * MINUTE));
    const { service } = harness({ agents });
    service.refresh();
    assert.equal(FakeNotification.instances.length, 1, 'one OS notification, built once');
    const [summary] = FakeNotification.instances;
    assert.equal(summary.title, '9 agents need you');
    assert.equal(summary.options.body, 'oldest 9 min');
    assert.equal(summary.options.tag, DESKTOP_SUMMARY_TAG);
    service.destroy();
    assert.equal(summary.closeCalls, 1);
});

test('a reload never re-alerts a wait it already announced; a new wait still alerts', () => {
    FakeNotification.instances = [];
    const session = memoryStorage();
    const first = harness({ session, agents: [waiting('ada', 90 * MINUTE), waiting('bo', 95 * MINUTE)] });
    first.service.refresh();
    assert.equal(FakeNotification.instances.length, 2);
    assert.equal(JSON.parse(session.getItem(DESKTOP_ANNOUNCED_KEY)).length, 2);
    first.service.destroy();

    // The reload (the GPU-crash auto-reload included): same tab, same waits.
    FakeNotification.instances = [];
    const reload = harness({ session, agents: [waiting('ada', 90 * MINUTE), waiting('bo', 95 * MINUTE)] });
    reload.service.refresh();
    assert.equal(FakeNotification.instances.length, 0, 'standing waits stay quiet');

    // A genuinely new wait, and a new wait of a known agent, still speak up.
    reload.world.agents.set('cy', waiting('cy', 99 * MINUTE));
    reload.service.refresh();
    assert.deepEqual(FakeNotification.instances.map(note => note.title), ['cy is waiting for you']);
    reload.world.agents.get('ada').status = 'working';
    reload.service.refresh();
    reload.world.agents.set('ada', waiting('ada', 100 * MINUTE));
    reload.service.refresh();
    assert.equal(FakeNotification.instances.at(-1).title, 'ada is waiting for you');
    reload.service.destroy();
});

test('two alerts stay single; the third within a second folds them into the summary', () => {
    FakeNotification.instances = [];
    const clock = { now: 100 * MINUTE };
    const { world, service } = harness({ clock });
    const arrive = (id, at) => {
        clock.now = at;
        world.agents.set(id, waiting(id, at - MINUTE));
        service.refresh();
    };
    const t0 = 100 * MINUTE;
    arrive('a', t0);
    arrive('b', t0 + 200);
    const [a, b] = FakeNotification.instances;
    assert.deepEqual([a.title, b.title], ['a is waiting for you', 'b is waiting for you']);

    arrive('c', t0 + 400);
    assert.deepEqual([a.closeCalls, b.closeCalls], [1, 1], 'the singles fold into the summary');
    assert.equal(FakeNotification.instances.at(-1).title, '3 agents need you');
    arrive('d', t0 + 900);
    const summary = FakeNotification.instances.at(-1);
    assert.equal(summary.title, '4 agents need you');
    assert.equal(summary.options.tag, DESKTOP_SUMMARY_TAG, 'replaced in place by its tag');

    // After the burst a lone new wait is a single alert again.
    arrive('e', t0 + 5_000);
    assert.equal(FakeNotification.instances.at(-1).title, 'e is waiting for you');

    // The summary closes once every agent in it has been answered.
    for (const id of ['a', 'b', 'c']) world.agents.get(id).status = 'working';
    service.refresh();
    assert.equal(summary.closeCalls, 0, 'a partial clear neither closes nor re-alerts');
    world.agents.get('d').status = 'working';
    service.refresh();
    assert.equal(summary.closeCalls, 1);
    service.destroy();
});

test('a wait with no known anchor is never deduped across a reload', () => {
    FakeNotification.instances = [];
    const session = memoryStorage();
    const unknown = { id: 'x', name: 'x', status: 'waiting_on_user', projectPath: '/w' };
    harness({ session, agents: [unknown] }).service.refresh();
    harness({ session, agents: [{ ...unknown }] }).service.refresh();
    assert.equal(FakeNotification.instances.length, 2);
});
