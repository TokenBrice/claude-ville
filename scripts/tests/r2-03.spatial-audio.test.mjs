import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioDirector } from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';
import { CueGovernor } from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';
import { CueKit } from '../../claudeville/src/presentation/shared/audio/cues/CueKit.js';
import { bellVoicingForProvider } from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

class FakeNode {
    constructor() {
        this.connections = [];
    }

    connect(node) {
        this.connections.push(node);
        return node;
    }

    disconnect() {}
}

function fakeAudioKit() {
    const voices = [];
    const param = value => ({
        value,
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
    });
    const context = {
        createBiquadFilter() {
            const node = new FakeNode();
            node.frequency = param(0);
            node.Q = param(0);
            node.gain = param(0);
            return node;
        },
        createOscillator() {
            const node = new FakeNode();
            node.frequency = param(0);
            node.start = () => {};
            node.stop = () => {};
            return node;
        },
        createGain() {
            const node = new FakeNode();
            node.gain = param(1);
            return node;
        },
    };
    const engine = {
        context,
        started: true,
        now: () => 0,
        bedLoudness: () => null,
        duck: () => ({ cancel() {} }),
        connectVoice(node, options) {
            voices.push({ node, level: node.gain.value, ...options });
            return { output: new FakeNode(), dispose() {} };
        },
    };
    const governor = new CueGovernor({ maxPerMinute: 6, minSpacingMs: 0 });
    return { kit: new CueKit(engine, governor), voices };
}

function captureDirectorCalls(world = null) {
    const engine = { context: null, started: false };
    const governor = new CueGovernor();
    const director = new AudioDirector({
        engine,
        world,
        cues: { kit: new CueKit(engine, governor), governor },
    });
    const calls = [];
    director.cueKit.play = (kind, payload) => {
        calls.push({ kind, payload });
        return true;
    };
    return { director, calls };
}

// Arrival and departure bells belong to a moving body: they wait out the
// current event dispatch so the renderer can declare its accent, then ring on
// it (CueScore.CUE_ACCENT_NOTE). One macrotask drains that wait.
const nextTick = () => new Promise(resolve => { setTimeout(resolve, 0); });

const near = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) <= epsilon;

test('a routine cue is placed once: pan within ±0.75, farther is duller, quieter and wetter', async () => {
    const centre = fakeAudioKit();
    centre.kit.play('arrival', { spot: { screenX: 0.5 }, provider: 'claude' });
    await nextTick();
    const edge = fakeAudioKit();
    edge.kit.play('arrival', { spot: { screenX: 0 }, provider: 'claude' });
    await nextTick();

    // One placed chain per cue, however many notes it strikes.
    assert.equal(centre.voices.length, 1);
    assert.equal(edge.voices.length, 1);
    const [c] = centre.voices;
    const [e] = edge.voices;
    assert.equal(c.bus, 'cue');
    assert.equal(c.pan, 0);
    assert.equal(c.lowpassHz, null);
    assert.ok(near(c.air, 0.18));
    assert.equal(e.pan, -0.75);
    assert.ok(e.lowpassHz < 9000);
    // The distance gain is on the direct path only; the send keeps the
    // cue's level (send × direct gain = the ENG-6 table value at d = 1).
    assert.ok(e.level < c.level);
    const directGain = e.level / c.level;
    assert.ok(near(e.air * directGain, 0.63, 1e-6));
});

test('signal cues stay close and dry: no distance gain or low-pass, |pan| ≤ 0.3, air ≤ 0.12', () => {
    const off = fakeAudioKit();
    off.kit.play('distress', { spot: { screenX: 4, screenY: 3 }, provider: 'codex' });
    const centre = fakeAudioKit();
    centre.kit.play('summons', { provider: 'gemini' });

    const [d] = off.voices;
    const [s] = centre.voices;
    assert.equal(d.pan, 0.3);
    assert.equal(d.lowpassHz, null);
    assert.ok(d.air <= 0.12);
    assert.equal(s.pan, 0);
    assert.ok(s.air <= 0.12);
});

test('scenery cues sound from the island with their fixed sends', () => {
    const bell = fakeAudioKit();
    bell.kit.play('hourBell', { spot: { screenX: 0 } });
    const [hour] = bell.voices;
    assert.equal(hour.pan, 0);
    assert.equal(hour.air, 0.45);
});

test('AudioDirector threads the scene position and provider, then places Dashboard cues on the island map', () => {
    const world = {
        agents: new Map([
            ['left-agent', {
                id: 'left-agent',
                provider: 'codex',
                position: { tileX: 2, tileY: 28 },
                lastKnownBuildingType: 'harbor',
            }],
            ['nowhere-agent', { id: 'nowhere-agent', provider: 'claude' }],
        ]),
    };
    const { director, calls } = captureDirectorCalls(world);
    try {
        eventBus.emit('village:scene', {
            kind: 'arrival',
            agentId: 'left-agent',
            screenX: 0.12,
        });
        assert.equal(calls[0].kind, 'arrival');
        assert.deepEqual(calls[0].payload.spot, { screenX: 0.12, viewportW: 1, viewportH: 1 });
        assert.equal(calls[0].payload.provider, 'codex');

        eventBus.emit('mode:changed', 'dashboard');
        eventBus.emit('attention:raised', {
            agentId: 'left-agent',
            agent: { id: 'left-agent', provider: 'codex', screenX: 0.04 },
        });
        assert.equal(calls[1].kind, 'summons');
        // Dashboard has no camera: the agent's building, never its old screen X.
        assert.deepEqual(calls[1].payload.spot, { building: 'harbor' });

        eventBus.emit('attention:raised', { agentId: 'nowhere-agent' });
        assert.equal(calls[2].payload.spot, null);
    } finally {
        director.destroy();
    }
});

test('tile position is a graceful World-mode placement fallback', () => {
    const world = {
        agents: new Map([
            ['left-agent', {
                id: 'left-agent',
                provider: 'gemini',
                position: { tileX: 1, tileY: 30 },
            }],
        ]),
    };
    const { director, calls } = captureDirectorCalls(world);
    try {
        eventBus.emit('village:scene', { kind: 'arrival', agentId: 'left-agent' });
        assert.ok(calls[0].payload.spot.screenX < 0.5);
    } finally {
        director.destroy();
    }
});

test('provider bell voicings are distinct and council bell count follows team size', () => {
    const providers = ['claude', 'codex', 'gemini', 'grok', 'kimi', 'omp', 'opencode', 'deepseek', 'zai'];
    const signatures = providers.map((provider) => JSON.stringify(bellVoicingForProvider(provider)));
    assert.equal(new Set(signatures).size, providers.length);
    assert.notEqual(bellVoicingForProvider('claude').register, bellVoicingForProvider('codex').register);

    const bellCount = (teamSize) => {
        const kit = new CueKit({
            context: { createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }) },
            started: true,
            now: () => 0,
            connectVoice: () => ({ dispose() {} }),
            bedLoudness: () => null,
            duck: () => ({ cancel() {} }),
        }, new CueGovernor({ maxPerMinute: 6, minSpacingMs: 0 }));
        const bells = [];
        kit._bell = (...args) => bells.push(args);
        kit.play('council', { teamSize });
        return bells.length;
    };

    assert.deepEqual([bellCount(1), bellCount(3), bellCount(5), bellCount(9)], [2, 3, 5, 5]);
});

test('team:gather forwards its member count without changing governor limits', () => {
    const { director, calls } = captureDirectorCalls();
    try {
        eventBus.emit('team:gather', { teamName: 'alpha', members: ['a', 'b', 'c', 'd'] });
        assert.equal(calls[0].kind, 'council');
        assert.equal(calls[0].payload.teamSize, 4);
        assert.equal(director.governor.maxPerMinute, 6);
        assert.equal(director.governor.minSpacingMs, 4000);
    } finally {
        director.destroy();
    }
});
