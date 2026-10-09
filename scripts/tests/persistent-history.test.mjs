import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import {
    AgentBiographyService,
    BIOGRAPHY_CACHE_LIMIT,
} from '../../claudeville/src/application/AgentBiographyService.js';
import {
    RelationshipAffinityService,
    AFFINITY_CACHE_LIMIT,
} from '../../claudeville/src/application/RelationshipAffinityService.js';
import { affinityPairKey, PairAffinity } from '../../claudeville/src/domain/value-objects/PairAffinity.js';
import { MoodService } from '../../claudeville/src/application/MoodService.js';
import { Mood } from '../../claudeville/src/domain/value-objects/AgentMood.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { ChronicleStore } from '../../claudeville/src/infrastructure/ChronicleStore.js';

function biographyStore() {
    const biographies = new Map();
    let founding = null;
    return {
        biographies,
        channel: null,
        async getBiography(key) { return biographies.get(key) || null; },
        async putBiographies(records) {
            for (const record of records) biographies.set(record.identityKey, structuredClone(record));
            return records.length;
        },
        async getFounding() { return founding; },
        async recordFounding(record) {
            founding ||= structuredClone(record);
            return founding;
        },
        async queryRange() { return []; },
    };
}

function affinityStore() {
    const affinities = new Map();
    return {
        affinities,
        channel: null,
        async getAllAffinities({ limit = Infinity } = {}) {
            return [...affinities.values()]
                .sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)
                .slice(0, limit)
                .map(record => structuredClone(record));
        },
        async getAffinity(key) { return affinities.get(key) || null; },
        async putAffinities(records) {
            for (const record of records) affinities.set(record.pairKey, structuredClone(record));
            return records.length;
        },
    };
}

function agent(id, extra = {}) {
    return {
        id,
        name: id,
        agentName: id,
        provider: 'claude',
        projectPath: '/work/demo',
        status: 'working',
        tokens: { input: 0, output: 0 },
        gitEvents: [],
        sendMessages: [],
        ...extra,
    };
}

test('biography event memory is backward-compatible and bounded', () => {
    const biography = AgentBiography.fromRecord({
        identityKey: 'villager:claude:ada',
        schemaVersion: 2,
        commitsPushed: 4,
    });
    assert.ok(biography);
    for (let index = 0; index < 140; index++) {
        assert.equal(biography.rememberPushEvent(`push-${index}`, index + 1), true);
    }
    const record = biography.toRecord();
    assert.equal(record.schemaVersion, 4);
    assert.equal(record.extensions.biographyEvents.recentPushKeys.length, 96);
    assert.equal(record.extensions.biographyEvents.pushWatermarkAt, 140);
    assert.equal(biography.rememberPushEvent('push-139', 140), false);
    assert.equal(biography.rememberPushEvent('push-0', 1), false);
});

test('biography identities prioritize names, then unnamed project leads, then anonymous sessions', () => {
    const main = agent('day-one', { agentName: null, agentType: 'main', provider: 'omp' });
    assert.equal(AgentBiography.identityKeyFor(main), 'project:omp:demo');
    assert.equal(AgentBiography.identityKeyFor({ ...main, id: 'day-two', name: 'Generated' }), 'project:omp:demo');
    assert.equal(AgentBiography.identityKeyFor({ ...main, agentName: 'Ada' }), 'named:omp:ada');
    assert.equal(AgentBiography.identityKeyFor({ ...main, _customName: true, name: 'Bess' }), 'named:omp:bess');
    assert.equal(AgentBiography.identityKeyFor({ ...main, provider: 'codex' }), 'project:codex:demo');
    assert.equal(AgentBiography.identityKeyFor({ ...main, projectPath: 'C:\\work\\Demo\\' }), 'project:omp:demo');
    assert.equal(AgentBiography.identityKeyFor({ ...main, projectPath: '' }), 'anonymous:omp:day-one');
    assert.equal(AgentBiography.identityKeyFor({ ...main, agentType: 'sub-agent' }), 'anonymous:omp:day-one');
    assert.equal(AgentBiography.identityKeyFor({ ...main, parentSessionId: 'parent' }), 'anonymous:omp:day-one');
});

test('v4 lazily imports old mains once while retaining historical rows by their original keys', async () => {
    const store = biographyStore();
    const main = agent('old-main', { agentName: null, agentType: 'main', provider: 'omp' });
    const oldKey = AgentBiography.sessionIdentityKeyFor(main);
    const oldRecord = {
        identityKey: oldKey, schemaVersion: 3, firstSeenAt: 100, lastSeenAt: 200,
        sessionsCompleted: 2, commitsPushed: 3, lifetimeTokens: 40, errorsRecovered: 1,
        milestones: [{ id: 'nickname-sessionsCompleted-25', at: 150, nickname: 'the Veteran' }],
        extensions: { lifeEpisodes: [{ id: 'old-arrival', kind: 'arrived', at: 100 }] },
    };
    store.biographies.set(oldKey, oldRecord);
    store.biographies.set('anonymous:omp:unattributed', { ...oldRecord, identityKey: 'anonymous:omp:unattributed' });
    const first = new AgentBiographyService({ store }).start();
    eventBus.emit('agent:added', main);
    await first.stop();
    const projectKey = AgentBiography.identityKeyFor(main);
    const imported = store.biographies.get(projectKey);
    assert.equal(imported.schemaVersion, 4);
    assert.equal(imported.sessionsCompleted, 2);
    assert.equal(imported.commitsPushed, 3);
    assert.equal(imported.lifetimeTokens, 40);
    assert.equal(imported.errorsRecovered, 1);
    assert.equal(imported.firstSeenAt, 100);
    assert.equal(imported.extensions.lifeEpisodes[0].id, 'old-arrival');
    assert.equal(imported.milestones.some(entry => entry.nickname === 'the Veteran'), true);
    assert.equal(store.biographies.get(oldKey).extensions.projectIdentity.migratedTo, projectKey);

    const second = new AgentBiographyService({ store }).start();
    assert.equal((await second.getBiography(oldKey)).sessionsCompleted, 2);
    assert.equal((await second.getBiography('anonymous:omp:unattributed')).lifetimeTokens, 40);
    eventBus.emit('agent:added', main);
    eventBus.emit('agent:updated', { ...main, tokens: { input: 10, output: 0 } });
    eventBus.emit('agent:added', { ...main, id: 'new-day' });
    await second.stop();
    assert.equal(store.biographies.get(projectKey).sessionsCompleted, 2);
    assert.equal(store.biographies.get(projectKey).lifetimeTokens, 50);
});

test('concurrent project mains merge old session biographies without replacing project memory', async () => {
    const store = biographyStore();
    const mains = ['one', 'two'].map(id => agent(id, { agentName: null, agentType: 'main' }));
    const projectKey = AgentBiography.identityKeyFor(mains[0]);
    store.biographies.set(projectKey, { identityKey: projectKey, schemaVersion: 4, lifetimeTokens: 100 });
    for (const main of mains) {
        const identityKey = AgentBiography.sessionIdentityKeyFor(main);
        store.biographies.set(identityKey, { identityKey, schemaVersion: 3, lifetimeTokens: 10 });
    }
    const service = new AgentBiographyService({ store }).start();
    for (const main of mains) eventBus.emit('agent:added', main);
    for (const main of mains) eventBus.emit('agent:updated', { ...main, tokens: { input: 5 } });
    await service.stop();
    assert.equal(store.biographies.get(projectKey).lifetimeTokens, 130);
});

test('clean parent-recorded subagent returns count once across listener orders and reloads', async () => {
    const store = biographyStore();
    const parent = agent('parent');
    const child = agent('worker', { agentType: 'sub-agent', parentSessionId: parent.id, status: 'completed' });
    const key = AgentBiography.identityKeyFor(child);
    for (const returnFirst of [true, false, true]) {
        const service = new AgentBiographyService({ store }).start();
        eventBus.emit('agent:added', parent);
        eventBus.emit('agent:added', child);
        if (returnFirst) eventBus.emit('subagent:completed', { parentId: parent.id, childId: child.id });
        eventBus.emit('agent:removed', child);
        eventBus.emit('subagent:completed', { parentId: parent.id, childId: child.id });
        eventBus.emit('subagent:completed', { parentId: parent.id, childId: child.id });
        await service.stop();
        assert.equal(store.biographies.get(key).sessionsCompleted, 1);
    }
});

test('absence, failed children, wrong parents, and missing parents never imply a clean return', async () => {
    const store = biographyStore();
    const service = new AgentBiographyService({ store }).start();
    eventBus.emit('agent:added', agent('parent'));
    const children = [
        agent('absent', { parentSessionId: 'parent', status: 'completed' }),
        agent('working', { parentSessionId: 'parent' }),
        agent('failed', { parentSessionId: 'parent', status: 'errored', sessionEndedAt: Date.now() }),
        agent('limited', { parentSessionId: 'parent', status: 'rate_limited', turnState: 'awaiting_input' }),
        agent('wrong-parent', { parentSessionId: 'other', status: 'completed' }),
        agent('no-parent', { parentSessionId: 'missing', status: 'completed' }),
    ];
    for (const child of children) {
        eventBus.emit('agent:added', child);
        eventBus.emit('agent:removed', child);
        if (child.id !== 'absent') {
            eventBus.emit('subagent:completed', {
                parentId: child.id === 'no-parent' ? 'missing' : 'parent',
                childId: child.id,
            });
        }
    }
    await service.stop();
    for (const child of children) {
        assert.equal(store.biographies.get(AgentBiography.identityKeyFor(child)).sessionsCompleted, 0, child.id);
    }
});

test('completion dedupe survives serialization and stays within the event-memory bound', () => {
    let biography = AgentBiography.create('named:omp:worker', 1);
    biography.recordSessionCompleted(2, 'anonymous:omp:child-one');
    biography = AgentBiography.fromRecord(biography.toRecord());
    assert.deepEqual(biography.recordSessionCompleted(3, 'anonymous:omp:child-one'), []);
    assert.equal(biography.sessionsCompleted, 1);
    for (let index = 0; index < 140; index++) {
        biography.recordSessionCompleted(index + 4, `anonymous:omp:child-${index + 2}`);
    }
    const record = biography.toRecord();
    assert.equal(record.extensions.biographyEvents.recentCompletedSessionKeys.length, 96);
    assert.equal(record.sessionsCompleted, 141);
});

test('distinct clean children sharing a name each complete the durable worker biography', async () => {
    const store = biographyStore();
    const service = new AgentBiographyService({ store }).start();
    const parent = agent('parent');
    eventBus.emit('agent:added', parent);
    const children = [
        agent('one', { agentName: 'worker', parentSessionId: parent.id, turnState: 'awaiting_input' }),
        agent('two', { agentName: 'worker', parentSessionId: parent.id, sessionEndedAt: Date.now() }),
    ];
    for (const child of children) {
        eventBus.emit('agent:added', child);
        eventBus.emit('agent:removed', child);
        eventBus.emit('subagent:completed', { parentId: parent.id, childId: child.id });
    }
    await service.stop();
    assert.equal(store.biographies.get(AgentBiography.identityKeyFor(children[0])).sessionsCompleted, 2);
});

test('reloading the same push telemetry does not increment biography totals', async () => {
    const store = biographyStore();
    const firstPush = { id: 'push-1', type: 'push', ts: 1_000 };
    const secondPush = { id: 'push-2', type: 'push', ts: 2_000 };

    const first = new AgentBiographyService({ store }).start();
    eventBus.emit('agent:added', agent('Ada', { gitEvents: [firstPush] }));
    eventBus.emit('agent:updated', agent('Ada', { gitEvents: [firstPush, secondPush] }));
    await first.stop();

    const identityKey = first.identityKeyFor(agent('Ada'));
    assert.equal(store.biographies.get(identityKey).commitsPushed, 1);

    const reloaded = new AgentBiographyService({ store }).start();
    eventBus.emit('agent:added', agent('Ada', { gitEvents: [firstPush, secondPush] }));
    await reloaded.stop();
    assert.equal(store.biographies.get(identityKey).commitsPushed, 1);
});

test('affinity interactions remain idempotent across reload and shared telemetry', async () => {
    const store = affinityStore();
    const oldTs = Date.now() - 1_000;
    const oldGit = { id: 'git-old', type: 'commit', ts: oldTs };
    const oldChat = { recipient: 'Bess', messageType: 'message', summary: 'hello', ts: oldTs };

    const first = new RelationshipAffinityService({ store }).start();
    await first._ready;
    const ada = agent('Ada', { gitEvents: [oldGit], sendMessages: [oldChat] });
    const bess = agent('Bess');
    first._handleAgentSeen(ada);
    first._handleAgentSeen(bess);

    const observedAt = first._roster.get('Ada').observedAt;
    const chatOne = { ...oldChat, ts: observedAt + 1 };
    const chatTwo = { ...oldChat, ts: observedAt + 2 };
    const sharedGit = { id: 'git-shared', type: 'push', ts: observedAt + 3 };
    first._handleAgentSeen({
        ...ada,
        currentTool: null,
        sendMessages: [oldChat, chatOne, chatTwo],
        gitEvents: [oldGit, sharedGit],
    });
    first._handleAgentSeen({ ...bess, gitEvents: [sharedGit] });
    await first.stop();

    const pairKey = affinityPairKey(
        AgentBiography.identityKeyFor(ada),
        AgentBiography.identityKeyFor(bess),
    );
    const recorded = store.affinities.get(pairKey);
    assert.equal(recorded.meetings, 1);
    assert.equal(recorded.chats, 2, 'timestamped completed chats should be consumed');
    assert.equal(recorded.sharedCommits, 1, 'one git identity should count once per pair');

    const reloaded = new RelationshipAffinityService({ store }).start();
    await reloaded._ready;
    reloaded._handleAgentSeen({
        ...ada,
        sendMessages: [oldChat, chatOne, chatTwo],
        gitEvents: [oldGit, sharedGit],
    });
    reloaded._handleAgentSeen({ ...bess, gitEvents: [sharedGit] });
    await reloaded.stop();

    const afterReload = store.affinities.get(pairKey);
    assert.equal(afterReload.meetings, 1);
    assert.equal(afterReload.chats, 2);
    assert.equal(afterReload.sharedCommits, 1);
    assert.ok(afterReload.recentInteractionKeys.length <= 192);
});

test('settled biography reads use a bounded cache and clear on stop', async () => {
    const store = biographyStore();
    const service = new AgentBiographyService({ store });
    for (let index = 0; index < BIOGRAPHY_CACHE_LIMIT + 80; index++) {
        await service.getBiography(`villager:claude:cache-${index}`);
    }
    assert.ok(service._biographies.size <= BIOGRAPHY_CACHE_LIMIT);
    await service.stop();
    assert.equal(service._biographies.size, 0);
});

test('affinity preload is bounded to the newest retained pairs and clears on stop', async () => {
    const store = affinityStore();
    const now = Date.now();
    for (let index = 0; index < AFFINITY_CACHE_LIMIT + 200; index++) {
        const affinity = PairAffinity.create(
            `villager:claude:a-${index}`,
            `villager:claude:b-${index}`,
            now - index,
        );
        store.affinities.set(affinity.pairKey, affinity.toRecord());
    }
    const service = new RelationshipAffinityService({ store }).start();
    await service._ready;
    assert.equal(service._affinities.size, AFFINITY_CACHE_LIMIT);
    await service.stop();
    assert.equal(service._affinities.size, 0);
});

test('live affinity bursts respect the hard cache bound', () => {
    const service = new RelationshipAffinityService();
    service._accepting = true;
    service._scheduleFlush = () => {};
    const source = { identityKey: 'villager:claude:source' };
    for (let index = 0; index < AFFINITY_CACHE_LIMIT + 200; index++) {
        service._mutatePair(
            source,
            { identityKey: `villager:claude:peer-${index}` },
            'meeting',
            `meeting:source:peer-${index}`,
        );
    }
    assert.equal(service._affinities.size, AFFINITY_CACHE_LIMIT);
    assert.equal(service._dirty.size, AFFINITY_CACHE_LIMIT);
    assert.equal(service._capacityDrops, 200);
});

test('same-project meeting bursts bound both affinity and session-pair state', () => {
    const service = new RelationshipAffinityService();
    service._accepting = true;
    service._scheduleFlush = () => {};
    for (let index = 0; index < 100; index++) {
        service._handleAgentSeen({
            id: `session-${index}`,
            provider: 'claude',
            agentId: `agent-${index}`,
            projectPath: '/tmp/shared-project',
            gitEvents: [],
            sendMessages: [],
        });
    }
    assert.equal(service._affinities.size, AFFINITY_CACHE_LIMIT);
    assert.equal(service._metSessionPairs.size, AFFINITY_CACHE_LIMIT);
    assert.ok(service._capacityDrops > 0);
    const capacityDrops = service._capacityDrops;
    for (const entry of service._roster.values()) {
        service._handleAgentSeen(entry.agent);
    }
    assert.equal(
        service._capacityDrops,
        capacityDrops,
        'unchanged agent updates must not retry the saturated meeting working set',
    );
});

test('chat churn cannot evict meeting or git dedupe identities', () => {
    const affinity = PairAffinity.create('villager:claude:ada', 'villager:claude:bess', 1);
    assert.equal(affinity.recordInteraction('meeting', 2, 'meeting:session-a:session-b'), true);
    assert.equal(affinity.recordInteraction('sharedCommit', 3, 'git:shared-commit'), true);

    for (let index = 0; index < 300; index++) {
        assert.equal(affinity.recordInteraction('chat', index + 4, `chat:event-${index}`), true);
    }

    assert.ok(affinity.recentInteractionKeys.length <= 192);
    assert.equal(affinity.recordInteraction('meeting', 400, 'meeting:session-a:session-b'), false);
    assert.equal(affinity.recordInteraction('sharedCommit', 401, 'git:shared-commit'), false);
    assert.equal(affinity.meetings, 1);
    assert.equal(affinity.sharedCommits, 1);

    const mixed = PairAffinity.create('villager:claude:cat', 'villager:claude:dan', 1);
    mixed.recordInteraction('meeting', 2, 'meeting:session-c:session-d');
    for (let index = 0; index < 191; index++) {
        mixed.recordInteraction('chat', index + 3, `chat:mixed-${index}`);
    }
    mixed.recordInteraction('sharedCommit', 300, 'git:first-mixed-commit');
    const reloaded = PairAffinity.fromRecord(mixed.toRecord());
    assert.equal(reloaded.recordInteraction('meeting', 301, 'meeting:session-c:session-d'), false);
    assert.equal(reloaded.recordInteraction('sharedCommit', 302, 'git:first-mixed-commit'), false);
});

test('historical git events do not create a current mood streak', () => {
    const service = new MoodService();
    const now = Date.now();
    const villager = agent('Mood', {
        gitEvents: [
            { id: 'old-1', type: 'commit', ts: now - 60 * 60_000 },
            { id: 'old-2', type: 'push', ts: now - 59 * 60_000 },
        ],
    });
    service._handleAgentSeen(villager);
    assert.equal(villager.mood.type, Mood.NEUTRAL);
    assert.equal(service._records.get(villager.id).countedStreakKeys.size, 0);
});

test('mood uses git timestamps and bounds remembered event identities', () => {
    const service = new MoodService();
    const now = Date.now();
    const villager = agent('Mood', {
        gitEvents: [
            { id: 'recent-1', type: 'commit', ts: now - 2_000 },
            { id: 'recent-2', type: 'push', ts: now - 1_000 },
        ],
    });
    service._handleAgentSeen(villager);
    const record = service._records.get(villager.id);
    assert.equal(villager.mood.type, Mood.PROUD);
    assert.deepEqual(record.pushTimestamps, [now - 2_000, now - 1_000]);

    villager.gitEvents = Array.from({ length: 300 }, (_, index) => ({
        id: `burst-${index}`,
        type: 'commit',
        ts: now - 500 + index,
    }));
    service._handleAgentSeen(villager);
    assert.ok(record.countedStreakKeys.size <= 256);
    assert.ok(record.pushTimestamps.length <= 256);
});

test('unchanged telemetry discovers late aliases and project peers, including returning residents', () => {
    const service = new RelationshipAffinityService();
    service._accepting = true;
    service._scheduleFlush = () => {};
    const ada = agent('Ada', { projectPath: '/one' });
    let bess = agent('Bess', { agentName: 'NotYet', projectPath: '/two' });
    service._handleAgentSeen(ada);
    const at = service._roster.get('Ada').observedAt + 1;
    ada.sendMessages = [{ recipient: 'FutureAlias', ts: at, summary: 'hello' }];
    ada.gitEvents = [{ id: 'late-peer', type: 'commit', ts: at }];
    service._handleAgentSeen(ada);
    service._handleAgentSeen(bess);
    const pair = () => service.getAffinity(
        AgentBiography.identityKeyFor(ada), AgentBiography.identityKeyFor(bess),
    );
    assert.equal(pair(), null, 'cross-project, unresolved telemetry has no recipient');
    bess = { ...bess, agentName: 'FutureAlias', projectPath: '/one' };
    service._handleAgentSeen(bess);
    assert.equal(pair().chats, 1);
    assert.equal(pair().sharedCommits, 1);
    service._handleAgentSeen({ ...bess, isDeparted: true });
    ada.gitEvents.push({ id: 'while-away', type: 'push', ts: at + 1 });
    service._handleAgentSeen(ada);
    assert.equal(pair().sharedCommits, 1);
    service._handleAgentSeen(bess);
    assert.equal(pair().sharedCommits, 2, 'returning peer receives retained new commits once');
    for (let index = 0; index < 4; index++) {
        service._handleAgentSeen({ ...ada, tokens: { output: index } });
        service._handleAgentSeen(bess);
    }
    assert.equal(pair().chats, 1);
    assert.equal(pair().sharedCommits, 2);
    service._handleAgentRemoved(bess);
    service._handleAgentSeen(bess);
    assert.equal(pair().meetings, 1, 'persisted session-key dedup is unchanged on re-arrival');
    assert.equal(pair().sharedCommits, 2);
});

for (const kind of ['biography', 'affinity']) {
    test(`${kind} bulk snapshot survives abort and mutations made during commit`, async () => {
        const store = kind === 'biography' ? biographyStore() : affinityStore();
        const service = kind === 'biography'
            ? new AgentBiographyService({ store })
            : new RelationshipAffinityService({ store });
        const value = kind === 'biography'
            ? AgentBiography.create('villager:claude:ada')
            : PairAffinity.create('villager:claude:ada', 'villager:claude:bess', 1000);
        const key = kind === 'biography' ? value.identityKey : value.pairKey;
        const cache = kind === 'biography' ? service._biographies : service._affinities;
        const records = kind === 'biography' ? store.biographies : store.affinities;
        const method = kind === 'biography' ? 'putBiographies' : 'putAffinities';
        cache.set(key, kind === 'biography' ? Promise.resolve(value) : value);
        service._dirty.add(key);
        let release;
        let entered;
        const started = new Promise(resolve => { entered = resolve; });
        store[method] = async snapshot => {
            entered(snapshot);
            await new Promise((resolve, reject) => { release = { resolve, reject }; });
            for (const record of snapshot) records.set(key, structuredClone(record));
        };
        const first = service.flush();
        const snapshot = await started;
        if (kind === 'biography') value.addLifetimeTokens(7, 2000);
        else value.recordInteraction('chat', 2000, 'chat:new');
        service._dirty.add(key);
        assert.notDeepEqual(value.toRecord(), snapshot[0], 'the in-flight record is an immutable snapshot');
        release.reject(new Error('transaction aborted'));
        await first;
        assert.equal(records.has(key), false, 'an aborted batch publishes no partial durable state');
        assert.equal(service._dirty.has(key), true);
        let finishCommit;
        let enteredCommit;
        let delay = true;
        const committing = new Promise(resolve => { enteredCommit = resolve; });
        store[method] = async batch => {
            if (delay) {
                delay = false;
                enteredCommit();
                await new Promise(resolve => { finishCommit = resolve; });
            }
            for (const record of batch) records.set(key, structuredClone(record));
        };
        const second = service.flush();
        await committing;
        if (kind === 'biography') value.addLifetimeTokens(11, 3000);
        else value.recordInteraction('chat', 3000, 'chat:during-successful-commit');
        service._dirty.add(key);
        const stopped = service.stop();
        finishCommit();
        await second;
        await stopped;
        assert.deepEqual(records.get(key), value.toRecord(), 'stop retries the latest mutation before clearing caches');
    });
}

test('bulk record invalidations are published only after a successful atomic commit', async () => {
    for (const [method, storeName, keyField, type] of [
        ['putBiographies', 'biographies', 'identityKey', 'biography-updated'],
        ['putAffinities', 'affinities', 'pairKey', 'affinity-updated'],
    ]) {
        const messages = [];
        let tx;
        const durable = new Map();
        const store = Object.create(ChronicleStore.prototype);
        store.open = async () => {};
        store.channel = { postMessage: message => messages.push(message) };
        store.db = {
            transaction(name, mode) {
                assert.equal(name, storeName);
                assert.equal(mode, 'readwrite');
                const staged = [];
                tx = {
                    objectStore: () => ({ put: record => staged.push(structuredClone(record)) }),
                    complete() {
                        for (const record of staged) durable.set(record[keyField], record);
                        this.oncomplete();
                    },
                    abort() { this.error = new Error('abort'); this.onabort(); },
                };
                return tx;
            },
        };
        const batch = [{ [keyField]: 'one', schemaVersion: 2 }, { [keyField]: 'two', schemaVersion: 2 }];
        const committed = store[method](batch);
        await Promise.resolve();
        assert.deepEqual(messages, []);
        assert.equal(durable.has('one'), false);
        tx.complete();
        await committed;
        assert.deepEqual([...durable.values()], batch);
        assert.deepEqual(messages, batch.map(record => ({ type, [keyField]: record[keyField], schemaVersion: 2 })));
        const aborted = store[method]([{ [keyField]: 'three', schemaVersion: 2 }]);
        await Promise.resolve();
        tx.abort();
        await assert.rejects(aborted);
        assert.equal(durable.has('three'), false);
        assert.equal(messages.some(message => message[keyField] === 'three'), false);
    }
});

test('git pair admission retries after durability frees the cache, even on another resident update', async () => {
    const store = affinityStore();
    const service = new RelationshipAffinityService({ store }).start();
    service._scheduleFlush = () => {};
    await service._ready;
    const ada = agent('Ada');
    const bess = agent('Bess');
    service._handleAgentSeen(ada);
    for (let index = 0; index < AFFINITY_CACHE_LIMIT; index++) {
        service._mutatePair(
            { identityKey: 'villager:claude:capacity-source' },
            { identityKey: `villager:claude:capacity-${index}` },
            'meeting', `meeting:capacity-${index}`,
        );
    }
    const at = service._roster.get('Ada').observedAt + 1;
    ada.gitEvents = [{ id: 'awaiting-admission', type: 'commit', ts: at }];
    service._handleAgentSeen(ada);
    service._handleAgentSeen(bess);
    const pair = () => service.getAffinity(
        AgentBiography.identityKeyFor(ada), AgentBiography.identityKeyFor(bess),
    );
    assert.equal(pair(), null, 'dirty capacity refuses new pair admission');
    await service.flush();
    service._handleAgentSeen(agent('Unrelated', { projectPath: '/another-project' }));
    assert.equal(pair().sharedCommits, 1, 'retained telemetry is not consumed by a failed admission');
    await service.stop();
});

test('unchanged git history cannot cycle the durable dedup window and recount commits', () => {
    const service = new RelationshipAffinityService();
    service._accepting = true;
    service._scheduleFlush = () => {};
    const ada = agent('Ada');
    const bess = agent('Bess');
    service._handleAgentSeen(ada);
    service._handleAgentSeen(bess);
    const at = service._roster.get('Ada').observedAt + 1;
    ada.gitEvents = Array.from({ length: 65 }, (_, index) => ({
        id: `history-${index}`, type: 'commit', ts: at,
    }));
    service._handleAgentSeen(ada);
    const affinity = service.getAffinity(
        AgentBiography.identityKeyFor(ada), AgentBiography.identityKeyFor(bess),
    );
    assert.equal(affinity.sharedCommits, 65);
    service._handleAgentSeen({ ...ada, tokens: { output: 100 } });
    service._handleAgentSeen(bess);
    assert.equal(affinity.sharedCommits, 65, 'unrelated updates do not replay unchanged history');
});
