import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { SPEED_RUNGS, snapBodyPx } from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

// V7 (plan 0.4 / 0.5): one placement value, whole speed rungs, one facing
// writer, and work facing. These drive the real AgentSprite in Node.

function sprite(status = AgentStatus.WORKING) {
    const agent = { id: `v7-${status}`, name: 'V7', status, model: 'claude-sonnet-4-6', provider: 'claude', position: { tileX: 10, tileY: 10 } };
    const s = new AgentSprite(agent, {});
    s.motionScale = 1;
    s._lastBuildingType = 'forge';
    s.behavior = { arrive() {}, transition() {}, finishVisit() {}, cooldownUntil: 0 };
    s._pickTarget = () => {};
    s._renewVisitReservation = () => {};
    s._snapToNearestWalkable = () => false;
    s._advanceIdleStopAndLook = () => false;
    return s;
}

function walk(s, legs, start = { x: 400, y: 300 }) {
    let x = start.x;
    let y = start.y;
    s.x = x; s.y = y;
    s.waypoints = legs.map(([dx, dy]) => ({ x: (x += dx), y: (y += dy) }));
    s.targetX = s.waypoints[0].x; s.targetY = s.waypoints[0].y;
    s.moving = true; s.waitTimer = 0;
}

test('placement: a resting body sits on a whole texel; a walker rides the backing grid only at a whole k', () => {
    assert.equal(snapBodyPx(100.4, false, 3, 1), 100);
    assert.equal(snapBodyPx(100.6, true, 1.7, 1), 101, 'fractional k falls back to whole texels');
    for (const [zoom, dpr] of [[3, 1], [1.5, 2], [2, 2]]) {
        const k = zoom * dpr;
        const v = snapBodyPx(100.43, true, zoom, dpr);
        assert.ok(Math.abs(v * k - Math.round(v * k)) < 1e-9, `k=${k} lands on a backing pixel`);
        assert.ok(Math.abs(v - 100.43) <= 0.5 / k + 1e-9);
    }
});

test('a working walker holds every walk frame for whole refreshes and steps evenly at k = 3', () => {
    for (const [hz, hold] of [[60, 3], [120, 6]]) {
        const s = sprite();
        walk(s, Array.from({ length: 10 }, () => [32, 16]));
        const period = 1000 / hz;
        let t = 0; let seed = 7;
        const rows = [];
        for (let i = 1; i <= hz * 4; i++) {
            seed = (seed * 1103515245 + 12345) >>> 0;
            const next = i * period + ((seed / 4294967296) * 2 - 1); // ±1 ms timestamp jitter
            s.update(null, next - t); t = next;
            rows.push({ frame: s.frame, x: s.x, y: s.y, px: snapBodyPx(s.x, s.moving, 3, 1), py: snapBodyPx(s.y, s.moving, 3, 1), walk: s.animState === 'walk' });
        }
        assert.equal(s._gaitSpeed, SPEED_RUNGS.at(-1));
        const holds = []; let run = 0; let counting = false;
        for (let i = 1; i < rows.length; i++) {
            if (rows[i].frame !== rows[i - 1].frame) { if (counting) holds.push(run); run = 1; counting = rows[i].walk; } else run += 1;
            const step = Math.hypot(rows[i].px - rows[i - 1].px, rows[i].py - rows[i - 1].py) * 3;
            if (rows[i].x !== rows[i - 1].x) assert.ok(step > 0, `${hz} Hz: a walking body never stalls on screen`);
        }
        assert.ok(holds.length > 10);
        assert.ok(holds.slice(1).every((h) => h === hold), `${hz} Hz holds: ${holds}`);
    }
});

test('speed rungs keep urgency order, move one rung for temperament, and cap the chat approach', () => {
    const speed = (status, extra = {}) => { const s = sprite(status); Object.assign(s, extra); return s._speedForState(); };
    assert.equal(speed(AgentStatus.WORKING), 1.5);
    assert.equal(speed(AgentStatus.WAITING), 1.125);
    assert.equal(speed(AgentStatus.IDLE), 0.75);
    assert.equal(speed(AgentStatus.IDLE, { _lastBuildingType: 'ambient:harbor-rail' }), 0.5625);
    const tired = sprite(AgentStatus.WORKING); tired.agent.mood = { type: 'tired', intensity: 1 };
    assert.equal(tired._speedForState(), 1.125, 'a tired worker drops exactly one rung');
    const anxious = sprite(AgentStatus.WAITING); anxious.agent.mood = { type: 'anxious', intensity: 1 };
    assert.ok(anxious._speedForState() < 1.5, 'only WORKING walks the top rung');
    assert.equal(speed(AgentStatus.IDLE, { chatPartner: {} }), 1.5);
    assert.ok([AgentStatus.WORKING, AgentStatus.WAITING, AgentStatus.IDLE].every((st) => SPEED_RUNGS.includes(speed(st))));
});

test('facing turns one column per refresh, reverses through the camera side, and snaps under reduced motion', () => {
    const s = sprite();
    s.direction = 2; // E
    s._setFacingGoal(6); // W
    const seen = [];
    for (let i = 0; i < 20 && s._facingGoal != null; i++) { s._advanceFacing(1000 / 60); seen.push(s.direction); }
    const path = seen.filter((d, i) => d !== seen[i - 1]);
    assert.deepEqual(path, [1, 0, 7, 6], 'E → SE → S → SW → W');
    const still = sprite();
    still.motionScale = 0; still.direction = 2;
    still._setFacingGoal(6);
    assert.equal(still.direction, 6);
});

test('work facing turns backs into profiles within 67.5° of the building and fidgets stay out of back columns', () => {
    const s = sprite();
    assert.equal(s._workFacing(4, 12), 3, 'N with the door to the right → NE');
    assert.equal(s._workFacing(4, -12), 5, 'N with the door to the left → NW');
    assert.equal(s._workFacing(3), 2, 'NE → E');
    assert.equal(s._workFacing(5), 6, 'NW → W');
    for (const d of [0, 1, 2, 6, 7]) assert.equal(s._workFacing(d), d);
    s.direction = 2; s._facingGoal = null; s._workBearing = -Math.PI / 4; // building to the NE
    for (const sign of [1, -1]) {
        const glance = s._fidgetGlance(sign);
        assert.ok(glance == null || ![3, 4, 5].includes(glance));
    }
});
