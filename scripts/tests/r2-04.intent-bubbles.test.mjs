// Villager speech is provenance-tagged model text only. These tests defend the
// three properties that the previous preset-pool system violated: intents no
// longer manufacture words, stale text never masquerades as current work, and
// nothing falls back to a canned or harness-derived line.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { DIALOGUE_STALE_MS } from '../../claudeville/src/config/dialogue.js';

function dialogue(overrides = {}) {
    return {
        text: 'Checking git state and largest files',
        full: null,
        kind: 'intent',
        source: 'omp.tool.i',
        fidelity: 'verbatim',
        redacted: false,
        observedAt: Date.now(),
        actionId: 'call-1',
        ...overrides,
    };
}

test('visit intents drive routing without manufacturing speech', () => {
    const now = Date.now();
    const agent = new Agent({
        id: 'intent-agent',
        provider: 'codex',
        status: 'working',
        currentTool: 'Edit',
        currentToolInput: 'forge.js',
    });
    const manager = new VisitIntentManager({ now: () => now });
    manager.reconcile([agent], now);

    agent.currentTool = 'Bash';
    agent.currentToolInput = 'npm test';
    manager.reconcile([agent], now + 1_000);

    // The intent still exists and still carries its structured reason.
    const intent = manager.getIntentForAgent(agent.id, now + 1_000);
    assert.equal(intent.reason, 'validate-after-edit');
    // But it puts no words in the agent's mouth.
    assert.equal(agent.visitIntentBubble, undefined);
    assert.equal(agent.speech(now + 1_000), null);
    manager.dispose();
});

test('an agent with no dialogue is silent rather than reciting a tool label', () => {
    const agent = new Agent({
        id: 'silent-agent',
        status: 'working',
        currentTool: 'Edit',
        currentToolInput: 'forge.js',
        lastMessage: 'Implemented R2-12 in the forge',
    });

    // Both a live tool and an assistant message are present; neither is speech.
    assert.equal(agent.speech(), null);
});

test('speech carries the model text verbatim with its provenance', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'speaking-agent',
        status: 'working',
        dialogue: dialogue({ observedAt: now - 5_000 }),
    });

    const speech = agent.speech(now);
    assert.equal(speech.text, 'Checking git state and largest files');
    assert.equal(speech.source, 'omp.tool.i');
    assert.equal(speech.fidelity, 'verbatim');
    assert.equal(speech.redacted, false);
    assert.equal(speech.observedAt, now - 5_000);
    // Intent is quotable: it renders as a tailed speech bubble.
    assert.equal(speech.shape, 'bubble');
    // No 24-character cap: the renderer truncates by measured pixel width, so
    // a real 36-character intent phrase survives the domain layer intact.
    assert.equal(speech.text.length > 24, true);
    assert.equal(speech.text.endsWith('files'), true);
});

test('reasoning renders as a chip, never as a quote', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'thinking-agent',
        status: 'working',
        dialogue: dialogue({
            kind: 'thinking',
            source: 'grok.thought.chunk',
            fidelity: 'excerpt',
            text: 'The user wants me to execute a research procedure for mint-bridge…',
            full: 'The user wants me to execute a research procedure for mint-bridge-boundary analysis.',
            observedAt: now - 1_000,
        }),
    });

    const speech = agent.speech(now);
    assert.equal(speech.shape, 'chip');
    assert.equal(speech.fidelity, 'excerpt');
    // The untrimmed text survives for the narration panel.
    assert.match(speech.full, /boundary analysis/);
});

test('stale dialogue falls silent instead of asserting finished work', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'stale-agent',
        status: 'working',
        dialogue: dialogue({ observedAt: now - DIALOGUE_STALE_MS - 1 }),
    });

    assert.equal(agent.speech(now), null);
    // One millisecond inside the window still speaks.
    agent.dialogue = dialogue({ observedAt: now - DIALOGUE_STALE_MS + 1 });
    assert.equal(agent.speech(now).text, 'Checking git state and largest files');
});

test('departed villagers stay silent', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'departed-agent',
        status: 'completed',
        departedAt: now - 1_000,
        dialogue: dialogue({ observedAt: now - 1_000 }),
    });

    assert.equal(agent.isDeparted, true);
    assert.equal(agent.speech(now), null);
});

test('malformed dialogue is silence, not a guess', () => {
    const now = 1_800_000_000_000;
    for (const broken of [
        dialogue({ text: '' }),
        dialogue({ observedAt: null }),
        dialogue({ observedAt: 'yesterday' }),
    ]) {
        const agent = new Agent({ id: 'broken-agent', status: 'working', dialogue: broken });
        assert.equal(agent.speech(now), null);
    }
});

test('Round 1 biography identity still determines appearance', () => {
    const first = new Agent({ id: 'session-one', name: 'Ada', provider: 'claude' });
    const returning = new Agent({ id: 'session-two', name: 'Ada', provider: 'claude' });

    assert.equal(AgentBiography.identityKeyFor(first), AgentBiography.identityKeyFor(returning));
    assert.deepEqual(first.appearance, returning.appearance);
});
