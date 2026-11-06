// Chat pairing keys on "this call messages another agent", not on Claude's
// literal `SendMessage`: Codex `send_message` / `send_input` and OMP
// `send_message` pair too, and a Codex sub-agent answers to its spawn-path leaf.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { isAgentMessageTool } from '../../claudeville/src/domain/services/ToolIdentity.js';
import { agentPathAlias, extractRecipientName } from '../../claudeville/src/domain/services/RecipientResolver.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { VILLAGE_GATE } from '../../claudeville/src/config/townPlan.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentSprite, ONE_SIDED_CHAT_GRACE_MS } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import VisitTileAllocator from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';

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

// AP-2 — a recipient only ever takes one sender: matching starts no second
// approach on a body that is already in (or promised to) a chat, and the
// claim holds across matching passes until the approach ends.
test('two senders naming the same recipient start one approach, not a pile', () => {
    const target = sprite({ id: 'lead', agentName: 'Lead', status: AgentStatus.WORKING, currentTool: 'Edit', currentToolInput: 'x' });
    const started = [];
    const senderFor = (id) => {
        const s = sprite({
            id, agentName: id, status: AgentStatus.WORKING,
            currentTool: 'SendMessage', currentToolInput: `{"to":"Lead","summary":"x"}`,
        });
        s.startChat = (t) => { started.push(id); s.chatPartner = t; };
        return s;
    };
    const a = senderFor('sender-a');
    const b = senderFor('sender-b');
    const renderer = {
        agentSprites: new Map([[a.agent.id, a], [b.agent.id, b], [target.agent.id, target]]),
        _isGateTransit: () => false,
    };
    IsometricRenderer.prototype._updateChatMatching.call(renderer);
    assert.deepEqual(started, ['sender-a'], 'exactly one approach starts for one recipient');

    // A later pass names the same recipient: the live approach still claims it.
    const late = senderFor('sender-late');
    renderer.agentSprites.set(late.agent.id, late);
    IsometricRenderer.prototype._updateChatMatching.call(renderer);
    assert.deepEqual(started, ['sender-a'], 'a target under approach is not free');

    // The approach ends (its sender moved on to other work): the claim dies
    // with it and the next sender may approach.
    a.agent.currentTool = 'Edit';
    a.agent.currentToolInput = 'src/a.js';
    a.chatPartner = null; // the cleanup pass released the approach
    IsometricRenderer.prototype._updateChatMatching.call(renderer);
    assert.deepEqual(started, ['sender-a', 'sender-b'], 'a freed recipient takes the next sender');
});

// AP-2 — a one-sided chat (the partner never pointed back) ends after the
// grace period and the body resumes its route.
test('a chat one-sided past the grace period ends in the cleanup pass', () => {
    const chatSinceMs = Date.now() - ONE_SIDED_CHAT_GRACE_MS - 1000;
    const ended = [];
    const chatter = {
        agent: { id: 'a', name: 'a', status: AgentStatus.WORKING, currentTool: 'SendMessage', currentToolInput: '{"to":"b"}' },
        chatPartner: null,
        chatting: true,
        chatSinceMs,
        startChat() {},
        endChat() { this.chatPartner = null; this.chatting = false; ended.push('a'); },
    };
    const other = {
        agent: { id: 'b', name: 'b', status: AgentStatus.WORKING, currentTool: 'Edit', currentToolInput: 'x' },
        chatPartner: null,
        chatting: false,
        startChat() {},
        endChat() { this.chatPartner = null; },
    };
    const someoneElse = { ...chatter };
    chatter.chatPartner = other;
    other.chatPartner = someoneElse; // b chats with someone else: a is one-sided
    const renderer = {
        agentSprites: new Map([[chatter.agent.id, chatter], [other.agent.id, other]]),
        _isGateTransit: () => false,
    };
    IsometricRenderer.prototype._updateChatMatching.call(renderer);
    assert.deepEqual(ended, ['a']);
    assert.equal(chatter.chatting, false);

    // A young one-sided chat keeps its grace, and a reciprocal pair never times out.
    const young = { ...chatter, chatSinceMs: Date.now() - 1000, chatPartner: other, chatting: true, endChat() { throw new Error('too early'); } };
    const pair = { ...chatter, chatSinceMs, chatPartner: other, endChat() { throw new Error('reciprocal chats do not time out'); } };
    const mutual = { ...other, chatPartner: pair };
    pair.chatPartner = mutual;
    const rendererTwo = {
        agentSprites: new Map([['young', young], ['pair', pair], ['mutual', mutual]]),
        _isGateTransit: () => false,
    };
    young.agent = { id: 'young', name: 'y', status: AgentStatus.WORKING, currentTool: 'SendMessage', currentToolInput: '{"to":"b"}' };
    pair.agent = { id: 'pair', name: 'p', status: AgentStatus.WORKING, currentTool: 'SendMessage', currentToolInput: '{"to":"b"}' };
    IsometricRenderer.prototype._updateChatMatching.call(rendererTwo);
});

// The real walk grid and routing options the full-handshake test below runs on.
function chatRoutingFixtures() {
    const noise = Object.create(IsometricRenderer.prototype);
    const terrainSeed = [];
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) terrainSeed.push(noise._tileNoise(x, y));
    const buildings = new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)]));
    const scenery = new SceneryEngine({
        world: { buildings },
        terrainSeed,
        tileNoise: (x, y) => noise._tileNoise(x, y),
        smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
    });
    scenery.generateBridges();
    const pathfinder = new Pathfinder(scenery.getWalkabilityGrid().slice());
    pathfinder.keepReachableFrom(VILLAGE_GATE.inside);
    const allocator = new VisitTileAllocator();
    allocator.updateContext({ buildings, agentSprites: [], pathfinder });
    const options = {
        pathfinder,
        bridgeTiles: scenery.getBridgeTiles(),
        getBuilding: (type) => buildings.get(type),
        allocateVisitTile: (request) => allocator.allocate({ ...request, building: request.building || buildings.get(request.intent?.building) }) || null,
        releaseVisitReservation: (id) => allocator.release?.(id),
        renewVisitReservation: (id) => allocator.renew?.(id),
        getRoadTiles: () => new Set(),
        getRoutingContext: () => ({ laneTiles: new Map(), ...allocator.getCongestionSnapshot() }),
        getDayHour: () => 15,
    };
    return options;
}

// AP-2 — the full handshake on real sprites: two senders approach the same
// recipient; exactly one chat forms, and the losing sender's approach ends at
// the pair and the body resumes its route.
test('two senders converging on one recipient form exactly one chat', () => {
    const options = chatRoutingFixtures();
    const agent = (id) => new Agent({
        id, name: id, provider: 'claude', model: 'claude-sonnet-4-5',
        status: 'working', currentTool: 'Edit', currentToolInput: { file_path: 'src/a.js' },
    });
    const recipient = new AgentSprite(agent('recipient'), options);
    recipient.setTilePosition(20, 34);
    const s1 = new AgentSprite(agent('sender-1'), options);
    s1.setTilePosition(20, 30);
    const s2 = new AgentSprite(agent('sender-2'), options);
    s2.setTilePosition(24, 34);
    const sprites = [recipient, s1, s2];

    // The pre-fix pile-on state: both senders walk at the same recipient.
    s1.startChat(recipient);
    s2.startChat(recipient);

    const dt = 1000 / 60;
    let frames = 0;
    while (frames++ < 4000) {
        for (const sprite of sprites) sprite.update(null, dt);
        const settled = (s) => s.chatting || !s.chatPartner;
        if (settled(s1) && settled(s2)) break;
    }
    const paired = [s1, s2].filter((s) => s.chatting && s.chatPartner === recipient);
    assert.equal(paired.length, 1, 'exactly one sender chats with the recipient');
    assert.equal(recipient.chatting, true);
    assert.equal(recipient.chatPartner, paired[0], 'the recipient points back at its one partner');
    const loser = paired[0] === s1 ? s2 : s1;
    assert.equal(loser.chatPartner, null, 'the losing approach ends instead of stacking one-sided');
    assert.equal(loser.chatting, false);
    // It resumes its route: the release re-picks a target and it walks again.
    let resumeFrames = 0;
    while (!loser.moving && resumeFrames++ < 600) loser.update(null, dt);
    assert.equal(loser.moving, true, 'the released sender walks again');
    assert.ok(
        Math.hypot(loser.targetX - recipient.x, loser.targetY - recipient.y) > 1,
        'the released sender no longer targets the recipient',
    );
});

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
