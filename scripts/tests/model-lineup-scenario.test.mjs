import test from 'node:test';
import assert from 'node:assert/strict';

import { getWorldScenario, listWorldScenarios } from '../../claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js';
import { getModelVisualIdentity } from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';

// `?sim=1&scenario=model-lineup` is the sprite review fixture. An unknown id
// silently falls back to the default scenario, so pin the registration and
// the bodies it is meant to show.
test('model-lineup is registered and shows every reviewed body', () => {
    assert.ok(listWorldScenarios().some((scenario) => scenario.id === 'model-lineup'));
    const scenario = getWorldScenario('model-lineup');
    assert.equal(scenario.id, 'model-lineup');
    const bodies = new Set(scenario.agents.map((agent) => (
        getModelVisualIdentity(agent.model, agent.effort ?? null, agent.provider, agent.id).spriteId
    )));
    for (const spriteId of [
        'agent.claude.opus', 'agent.claude.fable', 'agent.claude.sonnet', 'agent.claude.haiku',
        'agent.zai.glm', 'agent.zai.glm.b', 'agent.zai.flash',
        'agent.deepseek.flash', 'agent.deepseek.flash.high', 'agent.deepseek.flash.xhigh',
        'agent.codex.gpt56luna',
    ]) {
        assert.ok(bodies.has(spriteId), `lineup shows ${spriteId}`);
    }
});
