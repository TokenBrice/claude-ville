import test from 'node:test';
import assert from 'node:assert/strict';

import { REST_SEATS } from '../../claudeville/src/config/townPlan.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { getWorldScenario } from '../../claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js';

const DIR = { s: 0, se: 1, e: 2, ne: 3, n: 4, nw: 5, w: 6, sw: 7 };
const planted = (status, extra = {}) => {
    const sprite = new AgentSprite({ id: `distress-${status}`, status, provider: 'claude', model: 'claude-opus-5-5', ...extra }, {});
    sprite.moving = false;
    sprite.chatting = false;
    sprite.chatPartner = null;
    return sprite;
};

// AG-6 — one held pose per incident state, from the observed status alone.

test('AG-6: a planted errored body turns its back; a rate-limited one sits on the ground', () => {
    assert.equal(planted(AgentStatus.ERRORED)._distressPose(), 'errored');
    assert.equal(planted(AgentStatus.RATE_LIMITED)._distressPose(), 'limited');
    for (const status of [AgentStatus.WORKING, AgentStatus.WAITING, AgentStatus.WAITING_ON_USER, AgentStatus.COMPLETED, AgentStatus.IDLE]) {
        assert.equal(planted(status)._distressPose(), null, status);
    }
    // Walking keeps the hunched gait; a chat or a seat owns the body.
    const walking = planted(AgentStatus.ERRORED);
    walking.moving = true;
    assert.equal(walking._distressPose(), null);
    const chatting = planted(AgentStatus.RATE_LIMITED);
    chatting.chatting = true;
    assert.equal(chatting._distressPose(), null);
    const seated = planted(AgentStatus.RATE_LIMITED);
    seated._seatedSeat = () => REST_SEATS[0];
    assert.equal(seated._distressPose(), null);
    const departed = planted(AgentStatus.ERRORED, { isDeparted: true });
    assert.equal(departed._distressPose(), null);
});

test('AG-6: the errored back faces N, the column no resting body holds; the sitter faces the camera side', () => {
    const errored = planted(AgentStatus.ERRORED);
    assert.equal(errored._distressFacing(), DIR.n);
    const limited = planted(AgentStatus.RATE_LIMITED);
    limited._workBearing = 0; // building to the east
    assert.equal(limited._distressFacing(), DIR.se);
    limited._workBearing = Math.PI; // building to the west
    assert.equal(limited._distressFacing(), DIR.sw);
    assert.equal(planted(AgentStatus.WORKING)._distressFacing(), null);
    // No work facing, fidget or glance turns a held pose off its column;
    // reduced motion snaps straight onto it.
    errored.motionScale = 0;
    errored.direction = DIR.se;
    errored._setFacingGoal(DIR.e);
    assert.equal(errored.direction, DIR.se, 'another writer is refused');
    errored._setFacingGoal(errored._distressFacing());
    assert.equal(errored.direction, DIR.n);
    errored.moving = true;
    errored._setFacingGoal(DIR.e);
    assert.equal(errored.direction, DIR.e, 'a walking body faces its path');
});

test('AG-6: the sitter holds the sit row, the errored back the plain body; waiting-on-you keeps its raised hand', () => {
    assert.equal(planted(AgentStatus.RATE_LIMITED).actionStripGroup(), 'sit');
    assert.equal(planted(AgentStatus.ERRORED, { currentTool: 'Read' }).actionStripGroup(), null);
    assert.equal(planted(AgentStatus.WAITING_ON_USER).actionStripGroup(), 'wait');
    const sitter = planted(AgentStatus.RATE_LIMITED);
    sitter.motionScale = 1;
    assert.equal(sitter._actionStripFrame({ groups: { sit: { rows: [7, 8], hold: 8 } } }, 'sit'), 'hold', 'static');
});

test('AG-6: the ground sitter lands its seat line on the ground, else drops its idle body', () => {
    const sprite = planted(AgentStatus.RATE_LIMITED);
    sprite.direction = DIR.se;
    const pose = { group: 'sit', strip: { meta: { groups: { sit: { seatLine: { 'south-east': 65, 'south-west': 64 } } } } } };
    const anchor = { maxY: 75 };
    assert.equal(sprite._groundSitBodyY(pose, anchor, 100), 100 + 1 - 65);
    sprite.direction = DIR.sw;
    assert.equal(sprite._groundSitBodyY(pose, anchor, 100), 100 + 1 - 64);
    // A profile without a sit strip: the standing body 8 texels lower.
    assert.equal(sprite._groundSitBodyY(null, anchor, 100), 100 - 75 + 2 + 8);
    // Lower than a seated Tavern patron's slump (4, J39) and than standing.
    assert.ok(sprite._groundSitBodyY(null, anchor, 100) > 100 - 75 + 2 + 4);
    // VQ-11 — the clip: the fallback at the ground, a robed sit strip whole,
    // an armoured one at its seat line (the shins no longer hang below it).
    assert.equal(sprite._groundSitClipLine(null, 100), 102);
    sprite._spriteIdentity = { spriteId: 'agent.claude.opus' };
    assert.equal(sprite._groundSitClipLine(pose, 100), null);
    for (const spriteId of ['agent.codex.gpt56luna', 'agent.codex.gpt56luna.b', 'agent.codex.gpt56sol', 'agent.codex.gpt56sol.b']) {
        sprite._spriteIdentity = { spriteId };
        assert.equal(sprite._groundSitClipLine(pose, 100), 101, spriteId);
    }
});

// AG-5 — a lead waiting on its subagents stands up for a blocked child.

test('AG-5: a pint lead at its place rises only while the renderer reports a blocked child', () => {
    const child = { x: -200, y: 40, agent: { id: 'child', status: AgentStatus.WAITING_ON_USER } };
    let blocked = child;
    const asked = [];
    const lead = new AgentSprite({ id: 'lead', status: AgentStatus.WORKING, provider: 'claude', model: 'claude-opus-5-5' }, {
        getBlockedChild: (id) => { asked.push(id); return blocked; },
    });
    lead.visitRole = 'rest';
    lead.moving = false;
    lead._subagentWait = { since: 1, seenAt: 2, pint: true };
    assert.equal(lead._risenForChild(), child);
    assert.deepEqual(asked, ['lead']);
    blocked = null;
    assert.equal(lead._risenForChild(), null, 'sits back once the child clears');
    blocked = child;
    lead._subagentWait = { since: 1, seenAt: 2, pint: false };
    assert.equal(lead._risenForChild(), null, 'a wind-down drinker has no squad to watch');
    lead._subagentWait = { since: 1, seenAt: 2, pint: true };
    lead.moving = true;
    assert.equal(lead._risenForChild(), null, 'only at its place');
    lead.moving = false;
    // Seated: the risen lead stands on the plain body instead of the sit row.
    const seat = REST_SEATS.find((candidate) => candidate.building === 'tavern');
    lead._seatedSeat = () => seat;
    assert.equal(lead.actionStripGroup(), null);
    blocked = null;
    assert.equal(lead.actionStripGroup(), 'sit');
});

test('AG-5: the risen lead faces its child in profile, never its back, then faces its seat again', () => {
    const seat = REST_SEATS.find((candidate) => candidate.id === 'tavern-yard-w');
    let blocked = null;
    const lead = new AgentSprite({ id: 'lead-face', status: AgentStatus.WORKING, provider: 'claude', model: 'claude-opus-5-5', position: { tileX: seat.tileX, tileY: seat.tileY } }, {
        getBlockedChild: () => blocked,
    });
    lead.motionScale = 0;
    lead.visitRole = 'rest';
    lead.moving = false;
    lead._restSeat = seat;
    lead._subagentWait = { since: 1, seenAt: 2, pint: true };
    lead._seatedSeat = () => seat;
    lead._renewVisitReservation = () => {};
    lead._markCrowdArrival = () => {};
    // Command lies up-left of the Tavern: a true NW bearing turns to W.
    blocked = { x: lead.x - 300, y: lead.y - 300, agent: { status: AgentStatus.WAITING_ON_USER } };
    lead._holdRestPlace(0);
    assert.equal(lead.direction, DIR.w);
    // The Pharos lies to the east.
    blocked = { x: lead.x + 300, y: lead.y + 10, agent: { status: AgentStatus.ERRORED } };
    lead._holdRestPlace(0);
    assert.equal(lead.direction, DIR.e);
    blocked = null;
    lead._holdRestPlace(0);
    assert.equal(lead.direction, DIR.sw, 'back to the seat facing');
});

test('AG-5: the renderer reports only a live child observed waiting on you or errored', () => {
    const agents = new Map();
    const sprites = new Map();
    const add = (id, status, extra = {}) => {
        agents.set(id, { id, status, ...extra });
        sprites.set(id, { agent: agents.get(id), x: 0, y: 0, leaving: false });
    };
    const renderer = {
        relationshipState: { parentToChildren: new Map([['lead', ['a', 'b', 'c', 'd']]]) },
        world: { agents },
        agentSprites: sprites,
    };
    const blocked = () => IsometricRenderer.prototype._blockedChildSprite.call(renderer, 'lead');
    add('a', AgentStatus.WORKING);
    add('b', AgentStatus.RATE_LIMITED);
    add('c', AgentStatus.COMPLETED);
    add('d', AgentStatus.IDLE);
    assert.equal(blocked(), null, 'working, limited, finished and idle children never raise the lead');
    agents.get('b').status = AgentStatus.ERRORED;
    assert.equal(blocked(), sprites.get('b'));
    agents.get('b').isDeparted = true;
    assert.equal(blocked(), null, 'a departed child is gone');
    agents.get('d').status = AgentStatus.WAITING_ON_USER;
    assert.equal(blocked(), sprites.get('d'));
    sprites.get('d').leaving = true;
    assert.equal(blocked(), null);
    assert.equal(IsometricRenderer.prototype._blockedChildSprite.call(renderer, 'nobody'), null);
});

test('squad-distress scenario: two blocked children, two control squads, and a solo errored and limited pair', () => {
    const scenario = getWorldScenario('squad-distress');
    assert.equal(scenario.id, 'squad-distress');
    const byId = new Map(scenario.agents.map((agent) => [agent.id, agent]));
    const childOf = (lead) => scenario.agents.find((agent) => agent.parentId === lead);
    assert.equal(childOf('squad-lead-1').status, AgentStatus.WAITING_ON_USER);
    assert.equal(childOf('squad-lead-2').status, AgentStatus.ERRORED);
    assert.equal(childOf('squad-lead-3').status, AgentStatus.RATE_LIMITED);
    assert.equal(childOf('squad-lead-4').status, AgentStatus.WORKING);
    assert.equal(byId.get('squad-solo-errored').status, AgentStatus.ERRORED);
    assert.equal(byId.get('squad-solo-limited').status, AgentStatus.RATE_LIMITED);
});
