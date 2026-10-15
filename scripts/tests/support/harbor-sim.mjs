// Drives HarborTraffic through simulated time for the harbor motion tests:
// fake hull strips read from manifest.yaml (sizes, anchors, mastheads,
// bowFacing), agents whose gitEvents a plan appends, and a per-frame sample
// of every drawn hull (position, status, view, bow side, alpha, sink).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { HarborTraffic } from '../../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { worldToTile } from '../../../claudeville/src/presentation/character-mode/Projection.js';

const MANIFEST = fileURLToPath(new URL('../../../claudeville/assets/sprites/manifest.yaml', import.meta.url));

export function hullSprites() {
    const text = fs.readFileSync(MANIFEST, 'utf8');
    const meta = new Map();
    for (const match of text.matchAll(/- id: (prop\.harborShip\.\w+)\n([\s\S]*?)(?=\n\s*- id:|\n\S)/g)) {
        const body = match[2];
        const num = key => Number((body.match(new RegExp(`\\b${key}: (\\d+)`)) || [])[1]);
        const pair = key => {
            const found = body.match(new RegExp(`\\b${key}: \\[(\\d+), (\\d+)\\]`));
            return found ? [Number(found[1]), Number(found[2])] : null;
        };
        meta.set(match[1], {
            width: num('width'),
            height: num('height'),
            frames: num('frames'),
            anchor: pair('anchor'),
            masthead: pair('masthead'),
            bowFacing: (body.match(/\bbowFacing: (\w+)/) || [])[1],
            ...(body.match(/\bdirections: \[([\w, ]+)\]/) ? { directions: body.match(/\bdirections: \[([\w, ]+)\]/)[1].split(/,\s*/) } : {}),
            ...(body.match(/\bmastheads: \{ sw: \[(\d+), (\d+)\], nw: \[(\d+), (\d+)\] \}/) ? (() => {
                const m = body.match(/\bmastheads: \{ sw: \[(\d+), (\d+)\], nw: \[(\d+), (\d+)\] \}/).slice(1).map(Number);
                return { mastheads: { sw: [m[0], m[1]], nw: [m[2], m[3]] } };
            })() : {}),
        });
    }
    const images = new Map();
    return {
        meta,
        assets: {
            get(id) {
                const entry = meta.get(id);
                if (!entry) return null;
                if (!images.has(id)) images.set(id, { width: entry.width, height: entry.height });
                return images.get(id);
            },
            getEntry: id => meta.get(id),
            getAnchor: id => meta.get(id)?.anchor,
        },
    };
}

export const SIM_T0 = Date.parse('2026-10-15T12:00:00Z');

// `plan`: [{ at (ms), agent (index), event }]; `agents`: [{ project }].
// Returns the per-frame samples: Map id -> [{ t, x, y, tileX, tileY, status,
// direction, bowX, alpha, sink, pushEventId, horizon }].
export function simulateHarbor({ agents, plan, durationMs, dt = 33, reconcileMs = 2000 }) {
    const sprites = hullSprites();
    const harbor = new HarborTraffic({ sprites });
    const roster = agents.map((spec, index) => ({ id: `agent-${index}`, name: `Agent ${index}`, provider: 'claude', sessionId: `s-${index}`, projectPath: spec.project, gitEvents: [] }));
    const queue = [...plan].sort((a, b) => a.at - b.at);
    const tracks = new Map();
    let cursor = 0;
    let lastReconcile = -Infinity;
    for (let t = 0; t <= durationMs; t += dt) {
        const now = SIM_T0 + t;
        let changed = false;
        while (cursor < queue.length && queue[cursor].at <= t) {
            const { agent, event } = queue[cursor++];
            const target = roster[agent];
            target.gitEvents = [...target.gitEvents, { project: target.projectPath, timestamp: now, completedAt: now, ...event }];
            changed = true;
        }
        if (changed || t - lastReconcile >= reconcileMs) {
            harbor.reconcile(roster, now);
            lastReconcile = t;
        }
        harbor.advance(dt);
        const items = harbor.enumerateHullDrawables(now);
        const payloads = new Map();
        for (const drawable of harbor._drawableBuffer) if (drawable.payload?.type === 'ship') payloads.set(drawable.payload.id, drawable.payload);
        for (const item of items) {
            const payload = payloads.get(item.id) || {};
            const tile = worldToTile(item.x, item.y);
            const list = tracks.get(item.id) || [];
            list.push({
                t,
                x: item.x,
                y: item.y,
                tileX: tile.tileX,
                tileY: tile.tileY,
                status: payload.ghost ? 'ghost' : payload.relocating ? 'relocating' : payload.status,
                direction: item.pose.direction,
                bowX: item.pose.bowX,
                alpha: item.pose.alpha,
                sink: item.pose.sink,
                pushEventId: payload.pushEventId || '',
                horizon: payload.horizonProgress || 0,
                anchorage: payload.anchorageName || '',
            });
            tracks.set(item.id, list);
        }
    }
    return { harbor, tracks };
}

let shaSeq = 0;
export function commitEvent(id, branch = 'main') {
    shaSeq += 1;
    return { id, type: 'commit', branch, targetRef: branch, sha: shaSeq.toString(16).padStart(40, '0'), label: `commit ${id}`, success: true, status: 'success' };
}

export function pushEvent(id, status = 'success', branch = 'main') {
    const extra = status === 'rejected' ? { success: false, stderr: '! [rejected] main -> main (non-fast-forward)' }
        : status === 'cancelled' ? { status: 'cancelled' }
            : { success: true, exitCode: 0 };
    return { id, type: 'push', branch, targetRef: branch, ...extra };
}
