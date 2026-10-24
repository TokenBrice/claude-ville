// Chat pairing keys on "this call messages another agent", not on Claude's
// literal `SendMessage`: Codex `send_message` / `send_input` and OMP
// `send_message` pair too, and a Codex sub-agent answers to its spawn-path leaf.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { isAgentMessageTool } from '../../claudeville/src/domain/services/ToolIdentity.js';
import { agentPathAlias, extractRecipientName } from '../../claudeville/src/domain/services/RecipientResolver.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

test('messaging tools from every harness are recognized; others are not', () => {
    for (const tool of ['SendMessage', 'send_message', 'functions.send_input', 'send_input']) {
        assert.equal(isAgentMessageTool(tool, 'x'), true, tool);
    }
    for (const tool of ['Bash', 'spawn_agent', 'wait_agent', 'Agent', 'TeamCreate', null, '']) {
        assert.equal(isAgentMessageTool(tool, 'x'), false, String(tool));
    }
});

test('recipients resolve from Codex targets, Claude `to`, and Codex spawn paths', () => {
    assert.equal(extractRecipientName('{"target":"composition"}'), 'composition');
    assert.equal(extractRecipientName('{"to":"lane-04","summary":"x"}'), 'lane-04');
    assert.equal(extractRecipientName('lane-04'), 'lane-04');
    assert.equal(agentPathAlias({ agentPath: '/root/composition' }), 'composition');
    assert.equal(agentPathAlias({ agentPath: '/root' }), 'root');
    assert.equal(agentPathAlias({}), null);
});

function sprite(agent) {
    return {
        agent,
        chatPartner: null,
        startChat(target) { this.chatPartner = target; target.chatPartner = this; },
        endChat() { this.chatPartner = null; },
    };
}

test('a Codex orchestrator messaging a sub-agent pairs the two bodies', () => {
    const lead = sprite({
        id: 'codex-lead', agentName: 'Lead', status: AgentStatus.WORKING,
        currentTool: 'send_message', currentToolInput: '{"target":"composition"}',
    });
    const child = sprite({
        id: 'codex-child', agentName: 'Harvey', agentPath: '/root/composition', status: AgentStatus.WORKING,
        currentTool: 'exec', currentToolInput: 'npm test',
    });
    const bystander = sprite({ id: 'codex-other', agentName: 'Ivy', status: AgentStatus.WORKING, currentTool: 'exec', currentToolInput: 'ls' });
    const renderer = {
        agentSprites: new Map([[lead.agent.id, lead], [child.agent.id, child], [bystander.agent.id, bystander]]),
        _isGateTransit: () => false,
    };
    IsometricRenderer.prototype._updateChatMatching.call(renderer);
    assert.equal(lead.chatPartner, child);
    assert.equal(child.chatPartner, lead);
    assert.equal(bystander.chatPartner, null);

    // When the lead stops messaging, the pair releases.
    lead.agent.currentTool = 'exec';
    IsometricRenderer.prototype._updateChatMatching.call(renderer);
    assert.equal(lead.chatPartner, null);
    assert.equal(child.chatPartner, null);
});
