import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChronicleScenario, loadChronicleScenario } from '../../claudeville/src/application/ChronicleScenario.js';
import { dayBounds } from '../../claudeville/src/application/ChronicleLog.js';
import { VILLAGE_GATE } from '../../claudeville/src/config/townPlan.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { releaseShadeField } from '../../claudeville/src/presentation/character-mode/ShadeField.js';
import { setFrameCastLighting, releaseFrameShade, stampCastFor } from '../../claudeville/src/presentation/character-mode/RakingLight.js';
import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import AgentSimulator from '../../claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js';

const bounds = dayBounds('2026-11-17');
const time = minute => bounds.lower + minute * 60_000;
const dayRows = {
    events: [
        { id: 'a0', ts: time(-1), kind: 'arrived', agentId: 'yesterday' },
        { id: 'a1', ts: time(1), kind: 'arrived', agentId: 'one', agentName: 'Reed', project: 'village' },
        { id: 'turn', ts: time(4), kind: 'completed', agentId: 'one' },
        { id: 'a2', ts: time(5), kind: 'waiting', agentId: 'two', provider: 'claude', lastMessage: 'never stored' },
        { id: 'a3', ts: time(8), kind: 'commit', agentId: 'git-repo', provider: 'git', project: 'village', sha: 'a123bde' },
        { id: 'a4', ts: time(10), kind: 'completed', sessionEndedAt: time(10), agentId: 'one' },
        { id: 'a5', ts: time(11), kind: 'push', agentId: 'one', project: 'village', outcome: 'rejected' },
        { id: 'a6', ts: time(100), kind: 'arrived', agentId: 'one', provider: 'codex' },
        { id: 'a7', ts: time(110), kind: 'departed', agentId: 'one' },
        { id: 'a8', ts: time(1440), kind: 'arrived', agentId: 'tomorrow' },
    ],
    samples: [
        { ts: time(6), agentId: 'one', tileX: 21, tileY: 20, model: 'gpt-6-sol' },
        { ts: time(3), agentId: 'one', tileX: 18, tileY: 19, model: 'gpt-6-astra' },
        { ts: time(2), agentId: 'one', tileX: 17, tileY: 19, model: 'gpt-6-astra', provider: 'codex' },
        { ts: time(12), agentId: 'one', tileX: 24, tileY: 24 }, // retained grace-period sample
        { ts: time(3), agentId: 'trail-only', provider: 'gemini', tileX: 2, tileY: 9 },
    ],
};

test('recorded day keeps observed positions and lifecycle, independent harbor events and silence', () => {
    const scenario = buildChronicleScenario(bounds, dayRows);
    assert.deepEqual(Object.keys(scenario), ['agents', 'timeline']);
    assert.deepEqual(scenario.agents, []);
    assert.doesNotMatch(JSON.stringify(scenario), /lastMessage|tomorrow|yesterday/);
    const world = new World();
    const sim = new AgentSimulator({ world, recordedDay: { ...bounds, scenario } });
    sim.start();
    const minute = sim.replayClock.duration * 60_000 / (bounds.upper - bounds.lower);
    sim.advanceReplay(1.5 * minute, false);
    assert.equal(world.agents.size, 1);
    assert.deepEqual({ ...world.agents.get('one').position }, VILLAGE_GATE.inside);
    assert.equal(world.agents.get('one').model, 'gpt-6-astra');
    assert.equal(world.agents.get('one').provider, 'codex');
    sim.advanceReplay(2 * minute, false);
    assert.deepEqual({ ...world.agents.get('one').position }, { tileX: 17, tileY: 19 });
    assert.equal(world.agents.get('one').model, 'gpt-6-astra');
    assert.equal(world.agents.get('trail-only').provider, 'gemini');
    sim.advanceReplay(5 * minute, false);
    assert.deepEqual(world.agents.get('one').position, { tileX: 21, tileY: 20 });
    assert.equal(world.agents.get('one').model, 'gpt-6-sol');
    assert.equal(world.agents.get('one').status, 'completed');
    const gate = world.agents.get('two');
    assert.equal(gate.status, 'waiting_on_user');
    assert.deepEqual({ ...gate.position }, VILLAGE_GATE.inside);
    assert.equal(gate.lastPrompt, null);
    assert.deepEqual(gate.messages, []);
    assert.equal(gate.projectPath, null);
    assert.equal(gate.isRecorded, true);
    assert.deepEqual(sim.pendingGit.map(e => e.type), ['commit']);
    assert.ok(!world.agents.has('git-repo'));
    sim.advanceReplay(4 * minute, false);
    assert.ok(!world.agents.has('one'));
    assert.equal(sim.pendingGit[1].status, 'rejected');
    assert.equal(sim.pendingGit[1].success, undefined);
    sim.advanceReplay(90 * minute, false);
    assert.deepEqual({ ...world.agents.get('one').position }, VILLAGE_GATE.inside);
    assert.equal(world.agents.get('one').model, 'unknown');
    sim.advanceReplay(90000, false);
    assert.equal(sim.replayClock.now, bounds.upper);
    assert.ok(!world.agents.has('one'));
    sim.stop();
    assert.equal(world.agents.size, 0);
});

test('reduced playhead holds both the authored timeline and sky, resumes without rewinding and stops at night', () => {
    const world = new World();
    const sim = new AgentSimulator({ world, timelapse: true, scenario: {
        agents: [], timeline: [{ ts: 2000, event: 'agent:add', agent: { id: 'arrival' } }],
    } });
    sim.start();
    const clock = sim.replayClock;
    assert.equal(sim._timers.length, 0);
    sim.advanceReplay(2999, true);
    assert.equal(clock.now, clock.start);
    assert.equal(world.agents.size, 0);
    sim.advanceReplay(1, true);
    assert.ok(clock.now > clock.start);
    assert.equal(world.agents.size, 1);
    sim.advanceReplay(200, false);
    const prior = clock.now;
    sim.advanceReplay(200, true);
    assert.equal(clock.now, prior);
    sim.advanceReplay(60_000, true);
    assert.equal(clock.now, clock.end);
    assert.ok(new Date(clock.end).getHours() >= 22);
    sim.stop();
});

test('the accelerated sun lets a shade job finish and admits at most one new direction a second', t => {
    const clock = { playhead: 0 };
    const renderer = { replay: { replayClock: clock } };
    globalThis.document = {};
    globalThis.requestIdleCallback = () => 1;
    t.after(() => {
        releaseFrameShade(renderer);
        releaseShadeField(renderer);
        delete globalThis.document;
        delete globalThis.requestIdleCallback;
    });
    const a = { shade: { key: 'dawn', color: [0, 1, 2] } };
    const b = { shade: { key: 'day', color: [2, 1, 0] } };
    setFrameCastLighting(a, renderer);
    const state = renderer._shadeFieldState;
    clock.playhead = 999;
    setFrameCastLighting(b, renderer);
    assert.equal(stampCastFor(b), a);
    assert.equal(state.want.shade, a.shade);
    clock.playhead = 1001;
    state.job = {};
    setFrameCastLighting(b, renderer);
    assert.equal(state.want.shade, a.shade);
    state.job = null;
    setFrameCastLighting(b, renderer);
    assert.equal(state.want.shade, b.shade);
    assert.equal(stampCastFor(a), b);
});

test('a recorded commit stays docked between sparse batches and sails on its recorded push', () => {
    const harbor = new HarborTraffic({});
    const feed = (events, ts) => harbor.reconcile([{ gitEvents: events }], ts, { incremental: true });
    const t = time(3);
    feed([{ id: 'c1', type: 'commit', sha: 'a123bde', project: 'village', timestamp: t }], t);
    const [id] = harbor.state.ships.keys();
    assert.ok(id);
    feed([], t + 500);
    assert.equal(harbor.state.ships.get(id)?.status, 'docked');
    feed([{ id: 'p1', type: 'push', success: true, project: 'village', timestamp: t + 1000 }], t + 1000);
    assert.equal(harbor.state.ships.get(id)?.status, 'departing');
    harbor.dispose();
});

test('rejects invalid dates before opening the Chronicle', async () => {
    for (const date of ['2026-02-30', '2026-00-00', '2026-1-1', '']) {
        await assert.rejects(loadChronicleScenario(date), { code: 'retold-date-invalid' });
    }
});

test('25 agents at 1 Hz for 24 hours produce at most one position per five minutes per agent', t => {
    function* samples() {
        for (let second = 0; second < 86_400; second++) {
            for (let i = 0; i < 25; i++) {
                yield { ts: bounds.lower + second * 1000, agentId: ids[i], tileX: i, tileY: second % 19, provider: 'codex' };
            }
        }
    }
    const ids = Array.from({ length: 25 }, (_, i) => 'session-' + i);
    const started = performance.now();
    const scenario = buildChronicleScenario(bounds, { events: [], samples: samples() });
    const elapsed = performance.now() - started;
    const bytes = Buffer.byteLength(JSON.stringify(scenario));
    t.diagnostic(`2,160,000 synthetic samples in ${Math.round(elapsed)} ms, ${scenario.timeline.length} steps, ${bytes} serialized bytes`);
    assert.equal(scenario.timeline.length, 25 * 288);
    assert.ok(bytes < 1024 * 1024);
});
