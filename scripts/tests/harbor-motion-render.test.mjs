import test from 'node:test';
import assert from 'node:assert/strict';

import { harborWaterField } from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import { commitEvent, pushEvent, simulateHarbor } from './support/harbor-sim.mjs';

// Phase 3 render motion, measured frame by frame (33 ms) over full
// lifecycles: no hull centre off water, no teleport, bow first, convoys
// spaced, departures leave over the horizon (the pathing harness gates).

const field = harborWaterField();
const MAX_STEP_PX = 6;

function scenario() {
    const plan = [];
    const agents = [];
    // Four repos: one moors at each pier berth first, then lagoon/coast.
    for (let r = 0; r < 6; r++) {
        agents.push({ project: `/w/motion-${r}` });
        const commits = [2, 4, 3, 6, 1, 3][r];
        for (let c = 0; c < commits; c++) plan.push({ at: 1000 + r * 400 + c * 2500, agent: r, event: commitEvent(`m-${r}-${c}`) });
    }
    plan.push({ at: 30_000, agent: 0, event: pushEvent('push-0') });
    plan.push({ at: 32_000, agent: 1, event: pushEvent('reject-1', 'rejected') });
    plan.push({ at: 34_000, agent: 2, event: pushEvent('cancel-2', 'cancelled') });
    plan.push({ at: 36_000, agent: 4, event: pushEvent('push-4') });
    plan.push({ at: 40_000, agent: 5, event: { id: 'pull-5', type: 'pull', remote: 'origin', branch: 'main', targetRef: 'main', refspec: 'main', success: true, exitCode: 0 } });
    // New commits mid-run launch off the slipway and reshuffle nothing.
    plan.push({ at: 50_000, agent: 0, event: commitEvent('m-0-late') });
    plan.push({ at: 52_000, agent: 1, event: commitEvent('m-1-late') });
    return { agents, plan };
}

const { tracks } = simulateHarbor({ ...scenario(), durationMs: 150_000 });

test('every hull centre stays on water in every frame', () => {
    for (const [id, track] of tracks) {
        for (const s of track) {
            if (s.alpha <= 0) continue;
            assert.ok(field.clearance(s.tileX, s.tileY) > 0.05, `${id} ${s.status} on land at (${s.tileX.toFixed(2)}, ${s.tileY.toFixed(2)}) t=${s.t}`);
        }
    }
});

test('no hull moves more than 6 px between frames, moored or sailing', () => {
    for (const [id, track] of tracks) {
        for (let i = 1; i < track.length; i++) {
            const a = track[i - 1];
            const b = track[i];
            if (b.t - a.t > 40) continue;
            const step = Math.hypot(b.x - a.x, b.y - a.y);
            assert.ok(step <= MAX_STEP_PX + 0.5, `${id} ${a.status}→${b.status} jumped ${step.toFixed(1)} px at t=${b.t}`);
        }
    }
});

test('hulls sail bow first: departing, arriving, boomerang and cancel', () => {
    const counts = {};
    for (const track of tracks.values()) {
        for (let i = 1; i < track.length; i++) {
            const a = track[i - 1];
            const b = track[i];
            if (b.t - a.t > 40 || !['departing', 'arriving', 'rejecting', 'cancelling'].includes(b.status)) continue;
            const vx = b.x - a.x;
            if (Math.hypot(vx, b.y - a.y) < 0.15) continue;
            const c = counts[b.status] ||= { n: 0, stern: 0 };
            c.n++;
            if (vx * b.bowX < -0.3) c.stern++;
        }
    }
    for (const status of ['departing', 'arriving', 'rejecting', 'cancelling']) {
        const c = counts[status];
        assert.ok(c?.n > 20, `no ${status} motion sampled`);
        assert.ok(c.stern / c.n < 0.05, `${status}: ${c.stern}/${c.n} stern-first`);
    }
});

test('a pushed convoy sails in line astern and leaves over the horizon', () => {
    const convoy = [...tracks.entries()].filter(([, track]) => track.some(s => s.pushEventId === 'push-0' && s.status === 'departing'));
    assert.ok(convoy.length >= 2);
    for (const [id, track] of convoy) {
        const last = track[track.length - 1];
        assert.ok(Math.max(...track.map(s => s.horizon)) > 0.9, `${id} never went over the horizon`);
        assert.ok(last.t < 140_000, `${id} is still drawn`);
        assert.ok(last.tileY < 2, `${id} faded at (${last.tileX.toFixed(1)}, ${last.tileY.toFixed(1)}), not out to sea`);
        assert.ok(track.some(s => s.sink > 0 && s.alpha > 0), `${id} vanished without sinking below the horizon`);
    }
    // Same-push hulls never sail within 20 px of each other.
    const byTime = new Map();
    for (const [id, track] of convoy) {
        for (const s of track) {
            if (s.status !== 'departing' || s.alpha < 0.5) continue;
            const list = byTime.get(s.t) || [];
            list.push({ id, ...s });
            byTime.set(s.t, list);
        }
    }
    for (const [t, list] of byTime) {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
                assert.ok(d >= 20, `${list[i].id} and ${list[j].id} ${d.toFixed(1)} px apart at t=${t}`);
            }
        }
    }
});

test('a rejected push sails out, turns and moors back where its fleet lies', () => {
    const rejected = [...tracks.entries()].filter(([, track]) => track.some(s => s.status === 'rejecting'));
    assert.ok(rejected.length > 0);
    for (const [id, track] of rejected) {
        const before = track.find(s => s.status === 'rejecting');
        const out = track.filter(s => s.status === 'rejecting');
        const far = Math.max(...out.map(s => Math.hypot(s.x - before.x, s.y - before.y)));
        assert.ok(far > 60, `${id} only stood ${far.toFixed(0)} px off`);
        const after = track[track.length - 1];
        assert.equal(after.status, 'docked');
        assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 60, `${id} redocked ${Math.hypot(after.x - before.x, after.y - before.y).toFixed(0)} px from where it left`);
    }
});

test('a pull sails in from the horizon to its fleet\'s slot', () => {
    const inbound = [...tracks.entries()].find(([id]) => id.startsWith('inbound:'));
    assert.ok(inbound, 'no inbound ship');
    const [, track] = inbound;
    assert.ok(track[0].tileY < 2 || track[0].alpha < 1, 'arrives from the open sea');
    const last = track[track.length - 1];
    assert.equal(last.status, 'docked');
});

test('a new commit slides off the slipway instead of popping in', () => {
    const late = tracks.get('m-0-late');
    assert.ok(late?.length);
    const first = late[0];
    const settled = late[late.length - 1];
    assert.ok(Math.hypot(settled.x - first.x, settled.y - first.y) > 40, 'did not launch');
    assert.ok(first.alpha < 1, 'did not fade in');
});
