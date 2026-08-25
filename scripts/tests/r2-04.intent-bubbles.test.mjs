import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { pickLoreLine } from '../../claudeville/src/config/loreDialogue.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import {
    INTENT_BUBBLE_WINDOW_MS,
    intentBubbleText,
} from '../../claudeville/src/presentation/character-mode/VisitIntentSemantics.js';

function agentIdWithoutLore(buildingType = 'forge') {
    for (let index = 0; index < 100; index++) {
        const id = `intent-fallback-${index}`;
        if (!pickLoreLine({ seedKey: id, buildingType })) return id;
    }
    throw new Error('Could not find deterministic non-lore agent id');
}

test('intent copy says why and rotates without adjacent repeats', () => {
    const intent = {
        id: 'agent-1:handoff:forge-taskboard',
        agentId: 'agent-1',
        reason: 'validate-after-edit',
        phase: 'testing',
    };
    const start = INTENT_BUBBLE_WINDOW_MS * 100;
    const lines = [0, 1, 2].map(offset => intentBubbleText(intent, {
        agentId: 'agent-1',
        now: start + offset * INTENT_BUBBLE_WINDOW_MS,
    }));

    assert.equal(lines[0].length <= 24, true);
    assert.equal(new Set(lines).size, 3);
    assert.equal(lines.includes('Validating after edit'), true);
    assert.equal(lines.some(line => /forge\.js|editing forge/i.test(line)), false);
});

test('manager publishes the prioritized active intent as transient bubble copy', () => {
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

    const intent = manager.getIntentForAgent(agent.id, now + 1_000);
    assert.equal(intent.reason, 'validate-after-edit');
    assert.equal(agent.visitIntentBubble.intentId, intent.id);
    assert.equal(agent.visitIntentBubble.reason, 'validate-after-edit');
    assert.equal(agent.bubbleText, agent.visitIntentBubble.text);
    assert.equal(agent.bubbleText.length <= 24, true);
    manager.dispose();
});

test('missing or stale intent copy gracefully falls back to the tool echo', () => {
    const id = agentIdWithoutLore();
    const agent = new Agent({
        id,
        status: 'working',
        currentTool: 'Edit',
        currentToolInput: 'forge.js',
    });

    assert.equal(agent.bubbleText, 'Editing forge.js');
    agent.setVisitIntentBubble({ text: 'Validating after edit', expiresAt: Date.now() - 1 });
    assert.equal(agent.bubbleText, 'Editing forge.js');
    agent.setVisitIntentBubble({ text: 'Validating after edit', expiresAt: Date.now() + 10_000 });
    assert.equal(agent.bubbleText, 'Validating after edit');
});

test('Round 1 biography identity still determines appearance', () => {
    const first = new Agent({ id: 'session-one', name: 'Ada', provider: 'claude' });
    const returning = new Agent({ id: 'session-two', name: 'Ada', provider: 'claude' });

    assert.equal(AgentBiography.identityKeyFor(first), AgentBiography.identityKeyFor(returning));
    assert.deepEqual(first.appearance, returning.appearance);
});
