import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';

// The action prop chip (read, work, think, talk, celebrate) is drawn for the
// Claude, Codex, DeepSeek and z.AI families only; Gemini, Kimi and Grok keep
// a bare body (model sprites pass 2).
function drawsActionProp(agent, state = {}) {
    let marks = 0;
    const ctx = {
        save() {}, restore() {}, translate() {}, scale() {},
        fillRect() { marks += 1; },
        fillStyle: '', strokeStyle: '', lineWidth: 1,
    };
    const sprite = {
        agent,
        moving: false,
        chatting: false,
        motionScale: 0,
        observation: null,
        _poseCell: null,
        _sealedSlipUntil: 0,
        _drawObservationSeal() {},
        _drawTurnSand() {},
        _providerKey: AgentSprite.prototype._providerKey,
        _providerTrimColor: () => '#ffffff',
        ...state,
    };
    const frameGeometry = { dx: 0, dy: 0, drawScale: 1, bounds: { minX: 0, maxX: 40, minY: 0, maxY: 60 } };
    AgentSprite.prototype._drawActionPoseOverlay.call(sprite, ctx, frameGeometry);
    return marks > 0;
}

const working = (provider, model) => ({ id: `${provider}-${model}`, provider, model, status: 'working', currentTool: 'Bash' });

test('DeepSeek and GLM agents (including omp-hosted ones) draw the action prop', () => {
    assert.equal(drawsActionProp(working('omp', 'glm-5.3')), true);
    assert.equal(drawsActionProp(working('zai', 'glm-5.3-flash')), true);
    assert.equal(drawsActionProp(working('omp', 'deepseek-flash')), true);
});

test('Claude and Codex keep the action prop', () => {
    assert.equal(drawsActionProp(working('claude', 'claude-sonnet-5')), true);
    assert.equal(drawsActionProp(working('codex', 'gpt-6-luna')), true);
});

test('Gemini, Kimi and Grok stay without the action prop', () => {
    assert.equal(drawsActionProp(working('gemini', 'gemini-3.1-pro')), false);
    assert.equal(drawsActionProp(working('kimi', 'kimi-for-coding')), false);
    assert.equal(drawsActionProp(working('grok', 'grok-4.5')), false);
});

// VQ-1a: a lead resting at the Tavern on its subagents makes no work claim of
// its own (the rest tableau and the plaque carry the crew's work); the same
// lead anywhere else, and every other claim, keeps its chip.
test('a resting Tavern patron waiting on its subagents wears no WORK chip', () => {
    const lead = { ...working('claude', 'claude-opus-5-5'), currentTool: 'Agent' };
    const patron = { _subagentWait: { pint: true }, visitRole: 'rest' };
    assert.equal(drawsActionProp(lead, patron), false);
    assert.equal(drawsActionProp(lead), true, 'a lead away from the Tavern keeps the chip');
    assert.equal(drawsActionProp(lead, { ...patron, visitRole: null }), true, 'not resting yet');
    assert.equal(drawsActionProp({ ...lead, currentTool: 'Read' }, patron), true, 'a read is its own claim');
});
