import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationModeForPressure, calculateScenePressure, MarkGovernor, MarkTier, salienceTierFor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { operatorStatusLabel, sortAttentionAgents } from '../../claudeville/src/presentation/shared/SemanticTriage.js';
import { AgentAction, resolveAgentAction } from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';

test('semantic tiers preserve primary ordering and vocabulary', () => {
    assert.equal(salienceTierFor({ status: 'waiting_on_user' }), MarkTier.PRIMARY);
    assert.equal(salienceTierFor({ recent: true }), MarkTier.RECENT);
    assert.equal(salienceTierFor({ status: 'working' }), MarkTier.WORKING);
    assert.equal(operatorStatusLabel('waiting_on_user'), 'Needs you');
    assert.equal(operatorStatusLabel('idle'), 'Visiting');
});

test('primary reservations reject overlapping routine labels', () => {
    const governor = new MarkGovernor();
    governor.beginFrame();
    assert.equal(governor.reserve({ x: 10, y: 10, w: 80, h: 20 }, MarkTier.PRIMARY, 'hero'), true);
    assert.equal(governor.reserve({ x: 20, y: 12, w: 30, h: 10 }, MarkTier.WORKING, 'routine'), false);
    assert.deepEqual(governor.admit(MarkTier.PRIMARY, 10, 10), { draw: true, alpha: 1 });
});

test('pressure transitions are deterministic and hysteretic', () => {
    const sprites = Array.from({ length: 36 }, () => ({}));
    const pressure = calculateScenePressure({ sprites, viewport: { width: 1000, height: 700 }, overlayArea: 140000, collisions: 18 });
    assert.ok(pressure > .42);
    assert.notEqual(annotationModeForPressure(pressure), 'full');
    assert.equal(annotationModeForPressure(.39, 'compact'), 'compact');
});

test('attention queue sorts human intervention before errors and waits', () => {
    const sorted = sortAttentionAgents([{ id: 'w', status: 'waiting' }, { id: 'e', status: 'errored' }, { id: 'n', status: 'waiting_on_user' }]);
    assert.deepEqual(sorted.map(item => item.id), ['n', 'e', 'w']);
});

test('five-action vocabulary maps semantic work without provider branches', () => {
    assert.equal(resolveAgentAction({ status: 'working', currentTool: 'Read' }), AgentAction.READ);
    assert.equal(resolveAgentAction({ status: 'working', currentTool: 'exec' }), AgentAction.WORK);
    assert.equal(resolveAgentAction({ status: 'waiting', currentTool: 'plan' }), AgentAction.THINK);
    assert.equal(resolveAgentAction({ status: 'working', currentTool: 'SendMessage' }), AgentAction.TALK);
    assert.equal(resolveAgentAction({ status: 'completed' }), AgentAction.CELEBRATE);
});
