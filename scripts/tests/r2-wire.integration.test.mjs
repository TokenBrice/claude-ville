import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';

test('AgentSprite renders provenance-tagged speech and never recomposes tool copy', () => {
    const now = Date.now();
    const agent = new Agent({
        id: 'wire-dialogue-agent',
        provider: 'codex',
        status: 'working',
        currentTool: 'Bash',
        currentToolInput: 'npm test',
        lastMessage: 'Implemented R2-12 in the forge',
        dialogue: {
            text: 'Check vendor import path and JS syntax',
            full: null,
            kind: 'intent',
            source: 'claude.bash.description',
            fidelity: 'verbatim',
            redacted: false,
            observedAt: now,
            actionId: 'toolu_1',
        },
    });
    // A live intent must not put words in the agent's mouth any more.
    const manager = new VisitIntentManager({ now: () => now });
    manager.reconcile([agent], now);

    const spriteConsumer = {
        _providerTrimColor: () => '#7dd3fc',
        _statusVisualFor: () => ({ label: 'WORKING', color: '#7dd3fc' }),
    };
    const entry = AgentSprite.prototype._activityEntryForAgent.call(
        spriteConsumer,
        agent,
        now,
    );

    // The model's own sentence, untruncated by the domain layer.
    assert.equal(entry.text, 'Check vendor import path and JS syntax');
    assert.equal(entry.kind, 'intent');
    assert.equal(entry.shape, 'bubble');
    assert.equal(entry.source, 'claude.bash.description');
    assert.equal(entry.fidelity, 'verbatim');
    assert.ok(entry.badge, 'model-authored text carries a provenance badge');
    // The raw command and the assistant prose are both present on the agent and
    // must never be promoted into speech.
    assert.doesNotMatch(entry.text, /npm test|running bash|Implemented R2-12/i);

    // With no dialogue there is no entry at all: silence, not a status label
    // wearing bubble styling. Status stays visible through glyphs elsewhere.
    agent.dialogue = null;
    assert.equal(AgentSprite.prototype._activityEntryForAgent.call(spriteConsumer, agent, now), null);
    manager.dispose();
});
