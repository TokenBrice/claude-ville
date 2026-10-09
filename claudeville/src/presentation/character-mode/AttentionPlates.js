// T1 — one attention plate per action-needed agent, plus a body beacon
// (plan 5.1, contract C5).
//
// An agent that is waiting on the operator, errored, or rate-limited gets:
//   - a beacon: the authored 8×8 EventShapes motif at 2× over its head, in the
//     status colour with a one-pixel dark outline (T1b);
//   - a square plate above the beacon: the status word in 8 px Press Start 2P
//     on the status colour, then name and time-in-state in 11 px Departure
//     Mono on dark walnut, with a three-row notch pointing at the beacon.
//
// Truth rules. The plate is drawn from the sprite's LIVE status every frame
// at full strength for as long as the state holds — never from a Director
// incident's TTL, so a blocked agent cannot fade into looking resolved. It
// is screen-fixed (CSS pixels, whole-pixel geometry, never world-scaled),
// drawn once on the ungraded overlay (no night re-stamp), and never culled by
// the mark governor, decision focus, Ambient or crowd pressure. Plates stack
// without overlapping; three or more same-kind agents whose plates collide or
// whose beacons stand close collapse into a single group plate
// (`NEEDS YOU │ 9 · oldest Wait 1 13s`), and a plate is never pushed more
// than LEADER_MAX from its beacon — it groups instead. Every member keeps its
// own beacon, so each blocked agent stays individually visible.
// An agent outside the view is never clamped onto the frame as if it stood
// there: it gets an edge plate docked on the side it lies beyond, with a
// stepped arrow pointing out, and same-kind edge agents clustered along one
// side merge into one exact group. Nothing action-needed is culled for being
// offscreen.
//
// Wait age as size (Living Isle W5.4). Every mark steps on the one ladder
// `SignalLedger.waitAgeTier` (< 1 / 1–5 / 5–15 / >= 15 min), aged from the
// same instant the plate prints: the beacon is the 2× motif below 5 minutes,
// the 2× motif on a ringed dark medallion (a one-pixel status-colour ring) from
// 5 minutes, and the 3× motif from 15 minutes; the status cell carries one
// carved notch row per rung above the first. An unknown age claims no rung.
// State changes only — nothing blinks, so reduced motion is identical.
//
// Off-frame tally (W5.6). When a live, silent (not action-needed) agent
// stands wholly beyond the frame, one walnut tab docks on that side with a
// stepped arrow and the exact per-status counts (`4 working · 2 idle`):
// counts only, no names, no text from the agents. T1 plates take their slots
// first; a tab slides along its edge to a clear slot, or is not drawn.
//
// Cost: layout is O(n²) over on-screen action-needed agents only (usually
// 0–10); drawing is ≤ 8 fills + 2 fillText per plate and one cached stamp
// blit per beacon. Static: no motion, so reduced motion is identical.
//
// Resident WebGL2 path (Wave 10 S5, contract §7.4): the mark's graphical
// pixels — leader, beacon, plate rim, status cell, text cell, notch and edge
// arrow — are V9 mark records (`attentionMarkRecords`, flag `screenSpace`,
// rects in backing pixels) that the GPU draws above its composite, and the
// overlay keeps only the ink (`drawAttentionPlates(..., { inkOnly: true })`):
// at the plates' slot it clears each graphic's exact footprint, so nothing
// drawn earlier on the overlay covers a mark, then prints the word, name and
// time. Same geometry, same inks, same order: the page is byte-identical.
// Role 2 (§7.1, action-needed) rides the status-colour pixels — the status
// cell, the notch's status rows and the beacon's colour stamp (flag
// `actionMark`); rim, text cell, leader, the beacon's outline stamp and the
// edge arrow (plate ink) are role 0. Canvas and non-integer DPR keep the
// overlay plates.

import { AgentStatus, normalizeAgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { waitAgeTier, waitAnchor } from '../../domain/services/SignalLedger.js';
import { STATUS_VISUALS, WORLD_BODY_FONT_11, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { EFFECT_COLORS } from '../../config/artPalette.js';
import { elapsedTickNow, formatElapsed } from '../shared/Formatters.js';
import { LABEL_INK, WALNUT, drawOutlinedMotif, fitLabelText, measureLabelText, outlinedMotifStamp, paintWalnutBoard } from './WorldLabelKit.js';
import { GPU_RECORD_FLAGS } from './gpu/GpuWorldPolicy.js';

export const ATTENTION_STATUSES = Object.freeze([
    AgentStatus.WAITING_ON_USER,
    AgentStatus.ERRORED,
    AgentStatus.RATE_LIMITED,
]);

const KIND = Object.freeze({
    [AgentStatus.WAITING_ON_USER]: { word: 'NEEDS YOU', motif: 'needs-you', color: STATUS_VISUALS.waiting_on_user.color, rank: 1 },
    [AgentStatus.ERRORED]: { word: 'ERROR', motif: 'alert', color: STATUS_VISUALS.errored.color, rank: 0 },
    [AgentStatus.RATE_LIMITED]: { word: 'LIMIT', motif: 'limit-gate', color: STATUS_VISUALS.rate_limited.color, rank: 2 },
});

const BEACON_STEP = 2;
const BEACON_SIZE = 8 * BEACON_STEP + 2;
// W5.4 — the beacon from 5 minutes: the 2× motif centred on a dark medallion
// whose one-pixel status ring keeps a one-pixel dark rim, filling the same
// 26 px box the 3× motif fills from 15 minutes.
const BEACON_RING_BOX = 26;
const BEACON_RING_INSET = (BEACON_RING_BOX - BEACON_SIZE) / 2;
const BEACON_BIG_STEP = 3;
// The status cell's age notches: one 3×2 row per rung above the first,
// stacked up from the word's baseline, 3 px clear of the word.
const AGE_NOTCH_W = 3;
const AGE_NOTCH_GAP = 3;
const BEACON_GAP = 2;          // head (or chevron) top → beacon bottom
const PLATE_H = 17;
const NOTCH_ROWS = 3;
const PLATE_GAP = 1;           // notch tip → beacon top
const WORD_PAD = 4;
const TEXT_PAD = 5;
const NAME_MAX = 132;
const STACK_STEP = 20;
const EDGE_MARGIN = 8;
const GROUP_MIN = 3;
// Beacons this close (screen px, centre to centre) read as one knot of
// bodies: they share one group plate instead of a ladder of singles.
const GROUP_RADIUS = 96;
// A plate displaced further than this from its beacon is grouped instead —
// a long leader across other plates is ambiguous.
const LEADER_MAX = 24;
// Edge plates on one side whose anchors lie within this fraction of the
// edge length are one off-view cluster and share one plate.
const EDGE_CLUSTER_FRACTION = 0.25;
// Edge plates: the arrow cell in front of the status word (a 7×7 arrow plus
// a 4 px gap), and the band held clear above the bottom-left lower-third
// caption (its tallest reach, 24 px inset + 34 px replay reserve + 36 px
// strip + a gap) so the caption never covers a plate.
const EDGE_ARROW_CELL = 11;
const EDGE_ARROW_DOWN = Object.freeze(['..###..', '..###..', '..###..', '#######', '.#####.', '..###..', '...#...']);
const EDGE_SIDE_ORDER = Object.freeze(['top', 'bottom', 'left', 'right']);
const EDGE_MERGE_PAD = 32;
const CAPTION_CLEAR = 100;
// W5.6 off-frame tally tab: a walnut board as tall as a plate holding a 7×7
// arrow and the counts, sliding along its edge in TALLY_SLIDE steps to clear
// the T1 plates.
const TALLY_PAD = 5;
const TALLY_SLIDE = 24;
const TALLY_WORDS = Object.freeze([
    [AgentStatus.WORKING, 'working'],
    [AgentStatus.WAITING, 'waiting'],
    [AgentStatus.IDLE, 'idle'],
    [AgentStatus.COMPLETED, 'done'],
]);

export function isAttentionStatus(status) {
    return status === AgentStatus.WAITING_ON_USER
        || status === AgentStatus.ERRORED
        || status === AgentStatus.RATE_LIMITED;
}

function spriteName(sprite) {
    return String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
}

// Time in state. A wait is aged from the same anchor the SignalLedger (A key,
// sidebar) sorts by, so "oldest" means the same agent everywhere.
function statusSince(sprite) {
    const agent = sprite.agent;
    const since = agent?.status === AgentStatus.WAITING_ON_USER
        ? waitAnchor(agent) || Number(agent?.statusSince)
        : Number(agent?.statusSince);
    return Number.isFinite(since) && since > 0 ? since : null;
}

// Ages format from the shared 1 Hz tick (`elapsedTickNow`), the same clock
// the sidebar and the call card patch from, so a plate never reads a second
// ahead of the card beside it.
function ageText(since, now) {
    return since ? formatElapsed(Math.max(0, now - since)) : '';
}

function rectsOverlap(a, b, pad = 0) {
    return a.left < b.right + pad && a.right + pad > b.left && a.top < b.bottom + pad && a.bottom + pad > b.top;
}

// The ladder rung a mark shows for an age anchored at `since` (null: unknown).
function ageTier(since, now) {
    return since ? waitAgeTier(Math.max(0, now - since)) : null;
}

// Beacon geometry for a rung: the drawn box, the motif step, and whether the
// motif sits on the ringed medallion (inset by BEACON_RING_INSET).
function beaconForm(tier) {
    if (tier >= 3) return { size: 8 * BEACON_BIG_STEP + 2, step: BEACON_BIG_STEP, ring: false };
    if (tier === 2) return { size: BEACON_RING_BOX, step: BEACON_STEP, ring: true };
    return { size: BEACON_SIZE, step: BEACON_STEP, ring: false };
}

// Notch rows a status cell carries for a rung: one per rung above the first.
function notchRows(tier) {
    return tier > 0 ? tier : 0;
}

function plateWidths(ctx, word, text, tier = null) {
    ctx.font = WORLD_DISPLAY_FONT_8;
    const notchCell = notchRows(tier) ? AGE_NOTCH_GAP + AGE_NOTCH_W : 0;
    const wordCell = measureLabelText(ctx, word) + WORD_PAD * 2 + notchCell;
    ctx.font = WORLD_BODY_FONT_11;
    const textCell = measureLabelText(ctx, text) + TEXT_PAD * 2;
    return { wordCell, textCell, width: 1 + wordCell + textCell + 1 };
}

/**
 * Screen-space layout of every action-needed agent. An agent whose beacon
 * would not be fully in view is not clamped onto the frame: it gets an edge
 * plate docked on the side it lies beyond, with an arrow pointing there.
 * Edge plates on one side that would collide merge into one exact group.
 * V8 — `reserved` rects (chrome over the world, e.g. the World dock, in the
 * same canvas CSS px) are occluded screen: a beacon under one counts as
 * beyond the top edge, and no plate rect ever intersects one.
 * W5.6 — `tallies` are the off-frame walnut tabs, one per side holding at
 * least one live silent agent wholly beyond the frame.
 * @returns {{ plates: object[], beacons: object[], tallies: object[], count: number, offscreen: number }}
 */
export function layoutAttentionPlates(ctx, { sprites, camera, viewport, reserved = null, now = elapsedTickNow() } = {}) {
    const layout = { plates: [], beacons: [], tallies: [], count: 0, offscreen: 0 };
    if (!ctx || !camera?.worldToScreen || !viewport?.width) return layout;
    if (reserved?.length) viewport = { ...viewport, reserved };
    const items = [];
    const edgeItems = [];
    const silent = [];
    for (const sprite of sprites || []) {
        const status = sprite?.agent?.status;
        const kind = KIND[status];
        if (sprite?.isArrivalPending?.() || sprite?.agent?.isDeparted || sprite?._archiveAnim) continue;
        if (!sprite?.agent || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
        const headY = typeof sprite._labelTopY === 'function' && typeof sprite._headTopY === 'function'
            ? sprite._labelTopY(sprite._headTopY())
            : sprite.y - 64;
        const head = camera.worldToScreen(sprite.x, headY);
        if (!kind) {
            const tally = offFrameTallyItem(sprite, head, camera, viewport);
            if (tally) silent.push(tally);
            continue;
        }
        const x = Math.round(head.x);
        const beaconBottom = Math.round(head.y) - BEACON_GAP;
        const since = statusSince(sprite);
        const tier = ageTier(since, now);
        const form = beaconForm(tier);
        const beacon = {
            kind,
            step: form.step,
            ring: form.ring,
            left: x - form.size / 2,
            top: beaconBottom - form.size,
            right: x + form.size / 2,
            bottom: beaconBottom,
        };
        const item = {
            sprite,
            kind,
            x,
            y: Math.round(head.y),
            beacon,
            since,
            tier,
            name: spriteName(sprite),
            id: String(sprite.agent?.id || ''),
            // 7.2 — holds a place in the Command queue (a line slot or, for the
            // 13th onward, the plaza overflow).
            queued: sprite.visitRole === 'queue',
        };
        const side = offscreenSide(beacon, head.y, viewport);
        if (side) {
            item.side = side;
            edgeItems.push(item);
        } else {
            items.push(item);
        }
    }
    layout.count = items.length + edgeItems.length;
    layout.offscreen = edgeItems.length;
    if (!layout.count) {
        layout.tallies = layoutTallies(ctx, silent, viewport, layout.plates);
        return layout;
    }

    // Oldest first: it keeps the natural slot; unknown ages sort last.
    const byAge = (a, b) => ((a.since ?? Infinity) - (b.since ?? Infinity)) || a.id.localeCompare(b.id);
    items.sort(byAge);
    edgeItems.sort(byAge);

    for (const item of [...items, ...edgeItems]) {
        item.text = fitName(ctx, item.name);
        item.age = ageText(item.since, now);
        item.widths = plateWidths(ctx, item.kind.word, item.age ? `${item.text} ${item.age}` : item.text, item.tier);
    }

    // Edge plates are placed first: their slots are fixed by the frame, and
    // the in-view plates then avoid them.
    const placed = [];
    for (const plate of layoutEdgePlates(ctx, edgeItems, viewport, now, byAge)) {
        placed.push(plate);
        layout.plates.push(plate);
    }

    for (const item of items) {
        item.tip = item.beacon.top - PLATE_GAP;
        item.natural = naturalRect(item.x, item.tip, item.widths.width);
        layout.beacons.push(item.beacon);
    }

    // Collapse: union same-kind items whose natural plates collide or whose
    // beacons stand within GROUP_RADIUS; components of three or more become
    // one group plate. Every petitioner holding a place in the Command queue
    // is one knot however far the plaza overflow stands from the line (7.2),
    // so the group carries the exact total. Kinds never mix, so a group word
    // is always true of every member it counts.
    const parent = items.map((_, index) => index);
    const find = (index) => {
        while (parent[index] !== index) index = parent[index] = parent[parent[index]];
        return index;
    };
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            if (items[i].kind !== items[j].kind) continue;
            if ((items[i].queued && items[j].queued)
                || rectsOverlap(items[i].natural, items[j].natural, 2)
                || beaconsNear(items[i], items[j])) {
                parent[find(j)] = find(i);
            }
        }
    }
    const byRoot = new Map();
    items.forEach((item, index) => {
        const root = find(index);
        if (!byRoot.has(root)) byRoot.set(root, { members: [], grouped: false });
        byRoot.get(root).members.push(item);
    });
    const components = [...byRoot.values()];
    for (const component of components) component.grouped = component.members.length >= GROUP_MIN;

    // Place, then group any plate whose leader would run longer than
    // LEADER_MAX: a pair becomes an exact group of two; a lone plate or a
    // group joins its nearest same-kind neighbour. Each pass removes a
    // component or flips one to grouped, so this ends in ≤ 2n passes.
    let placedPlates = [];
    for (let pass = 0; pass <= items.length * 2; pass++) {
        placedPlates = placeComponents(ctx, components, placed, layout.beacons, viewport, now);
        let changed = false;
        for (const plate of placedPlates) {
            if (leaderLength(plate) <= LEADER_MAX) continue;
            const component = components.find(entry => entry.members.some(item => item.id === plate.ids[0]));
            if (!component) continue;
            if (!component.grouped && component.members.length > 1) {
                component.grouped = true;
                changed = true;
                break;
            }
            const neighbour = nearestComponent(component, components);
            if (!neighbour) continue;
            neighbour.members.push(...component.members);
            neighbour.members.sort(byAge);
            neighbour.grouped = true;
            components.splice(components.indexOf(component), 1);
            changed = true;
            break;
        }
        if (!changed) break;
    }
    for (const plate of placedPlates) layout.plates.push(plate);
    layout.tallies = layoutTallies(ctx, silent, viewport, [...layout.plates, ...layout.beacons]);
    return layout;
}

// W5.6 — a silent agent wholly beyond the frame: the side it lies beyond
// (largest overshoot of its head-to-feet column, like `offscreenSide`) and its
// live status. Null while any part of the body is in view.
function offFrameTallyItem(sprite, head, camera, viewport) {
    const feet = camera.worldToScreen(sprite.x, sprite.y);
    const top = Math.min(head.y, feet.y);
    const bottom = Math.max(head.y, feet.y);
    const over = {
        top: -bottom,
        bottom: top - viewport.height,
        left: -(feet.x + 8),
        right: feet.x - 8 - viewport.width,
    };
    let side = null;
    let best = 0;
    for (const key of EDGE_SIDE_ORDER) {
        if (over[key] > best) {
            best = over[key];
            side = key;
        }
    }
    if (!side) return null;
    return { side, status: normalizeAgentStatus(sprite.agent.status), x: feet.x, y: (top + bottom) / 2 };
}

// The exact per-status count text of one side's members, in a fixed order;
// every silent status has a word, so the parts always sum to the members.
export function offFrameTallyText(statuses) {
    const counts = new Map();
    for (const status of statuses) {
        const key = normalizeAgentStatus(status);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const parts = [];
    for (const [status, word] of TALLY_WORDS) {
        const count = counts.get(status);
        if (count) parts.push(`${count} ${word}`);
    }
    return parts.join(' · ');
}

// One tab per side, docked like an edge plate at the members' mean position
// along that edge, then slid in TALLY_SLIDE steps (nearest first) until it
// clears every T1 plate and beacon, every earlier tab and reserved chrome.
// No clear slot: the tab gives way and is not drawn.
function layoutTallies(ctx, silent, viewport, taken) {
    const tabs = [];
    if (!silent.length) return tabs;
    ctx.font = WORLD_BODY_FONT_11;
    for (const side of EDGE_SIDE_ORDER) {
        const horizontal = side === 'top' || side === 'bottom';
        const members = silent.filter(item => item.side === side);
        if (!members.length) continue;
        let sumX = 0;
        let sumY = 0;
        for (const item of members) {
            sumX += item.x;
            sumY += item.y;
        }
        const text = offFrameTallyText(members.map(item => item.status));
        const width = 1 + TALLY_PAD + 7 + TALLY_PAD + 1 + TALLY_PAD + measureLabelText(ctx, text) + TALLY_PAD + 1;
        const anchorX = sumX / members.length;
        const anchorY = sumY / members.length;
        const reach = Math.ceil((horizontal ? viewport.width : viewport.height) / TALLY_SLIDE);
        let rect = null;
        for (let step = 0; step <= reach * 2 && !rect; step++) {
            const shift = (step % 2 ? 1 : -1) * Math.ceil(step / 2) * TALLY_SLIDE;
            const candidate = edgeRect(side, anchorX + (horizontal ? shift : 0), anchorY + (horizontal ? 0 : shift), width, viewport);
            if (candidate.left < 0 || candidate.top < 0 || candidate.right > viewport.width || candidate.bottom > viewport.height) continue;
            if (taken.some(other => rectsOverlap(candidate, other.rect || other, 4))) continue;
            if (tabs.some(tab => rectsOverlap(candidate, tab.rect, 4))) continue;
            if (viewport.reserved?.some(chrome => rectsOverlap(candidate, chrome, 2))) continue;
            rect = candidate;
        }
        if (rect) tabs.push({ side, text, members: members.length, rect });
    }
    return tabs;
}

function beaconsNear(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy <= GROUP_RADIUS * GROUP_RADIUS;
}

function nearestComponent(component, components) {
    let best = null;
    let bestDistance = Infinity;
    for (const other of components) {
        if (other === component || other.members[0].kind !== component.members[0].kind) continue;
        for (const a of component.members) {
            for (const b of other.members) {
                const distance = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = other;
                }
            }
        }
    }
    return best;
}

function placeComponents(ctx, components, edgePlates, beacons, viewport, now) {
    const requests = [];
    for (const { members, grouped } of components) {
        if (grouped) requests.push(groupPlate(ctx, members, now));
        else for (const item of members) requests.push(singlePlate(item));
    }
    // Groups first (they speak for the most agents), then oldest singles.
    requests.sort((a, b) => (b.members - a.members) || ((a.since ?? Infinity) - (b.since ?? Infinity)));
    const placed = [...edgePlates];
    const out = [];
    for (const request of requests) {
        const plate = placePlate(request, placed, beacons, viewport);
        placed.push(plate);
        out.push(plate);
    }
    return out;
}

// Pixel length of the elbow drawLeader would draw for an in-view plate.
function leaderLength(plate) {
    const nx = notchX(plate);
    return Math.abs(plate.tip - (plate.rect.bottom + NOTCH_ROWS)) + Math.abs(plate.anchorX - nx);
}

// The side of the frame an agent lies beyond, or null when its whole beacon
// is in view. The largest overshoot wins at corners. A beacon under reserved
// chrome is not in view either: it docks on the top edge, below the chrome.
function offscreenSide(beacon, headY, viewport) {
    const over = {
        top: -beacon.top,
        bottom: headY - viewport.height,
        left: -beacon.left,
        right: beacon.right - viewport.width,
    };
    let side = null;
    let best = 0;
    for (const key of EDGE_SIDE_ORDER) {
        if (over[key] > best) {
            best = over[key];
            side = key;
        }
    }
    if (!side && viewport.reserved?.some(rect => rectsOverlap(beacon, rect, 0))) side = 'top';
    return side;
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(Math.max(min, max), value));
}

// Move a plate rect off every reserved rect it touches: below chrome that
// hangs in the upper half of the frame, above chrome in the lower half.
function clearReserved(rect, viewport) {
    for (const chrome of viewport.reserved || []) {
        if (!rectsOverlap(rect, chrome, 2)) continue;
        const height = rect.bottom - rect.top;
        const top = (chrome.top + chrome.bottom) / 2 < viewport.height / 2
            ? chrome.bottom + EDGE_MARGIN
            : chrome.top - EDGE_MARGIN - height;
        rect = { ...rect, top, bottom: top + height };
    }
    return rect;
}

// Plate rect docked on `side`, centred on the agent's projection along that
// edge. Side plates keep clear of the top/bottom bands, the caption band and
// reserved chrome.
function edgeRect(side, x, y, width, viewport) {
    const W = viewport.width;
    const H = viewport.height;
    if (side === 'top' || side === 'bottom') {
        const left = clampNumber(Math.round(x - width / 2), EDGE_MARGIN, W - EDGE_MARGIN - width);
        const top = side === 'top' ? EDGE_MARGIN : H - CAPTION_CLEAR - PLATE_H;
        return clearReserved({ left, top, right: left + width, bottom: top + PLATE_H }, viewport);
    }
    const bandTop = EDGE_MARGIN + PLATE_H + 4;
    const bandBottom = H - CAPTION_CLEAR - PLATE_H - 4;
    const top = clampNumber(Math.round(y) - Math.floor(PLATE_H / 2), bandTop, bandBottom - PLATE_H);
    const left = side === 'left' ? EDGE_MARGIN : W - EDGE_MARGIN - width;
    return clearReserved({ left, top, right: left + width, bottom: top + PLATE_H }, viewport);
}

// An edge plate carries its direction inside the status cell — an arrow in
// front of the word — and has no notch, so it can never be read as a plate
// pointing at a body standing under it.
function edgePlate(ctx, members, side, viewport, now, byAge) {
    const ordered = [...members].sort(byAge);
    const base = ordered.length === 1 ? singlePlate(ordered[0]) : groupPlate(ctx, ordered, now);
    let sumY = 0;
    for (const item of ordered) sumY += item.y;
    const anchorY = Math.round(sumY / ordered.length);
    const widths = {
        ...base.widths,
        wordCell: base.widths.wordCell + EDGE_ARROW_CELL,
        width: base.widths.width + EDGE_ARROW_CELL,
    };
    const rect = edgeRect(side, base.anchorX, anchorY, widths.width, viewport);
    return { ...base, widths, side, anchorY, rect, wordOffset: EDGE_ARROW_CELL };
}

// Per side and kind, sweep along the edge: agents whose anchors lie within
// EDGE_CLUSTER_FRACTION of the edge length (or whose plates would land within
// EDGE_MERGE_PAD) are one off-view cluster and share one group plate with the
// exact member count — off-view agents have no beacons to tell apart, so a
// ladder of near-identical edge plates would only be noise. Kinds never mix;
// plates of different kinds on one side step apart along the edge.
function layoutEdgePlates(ctx, edgeItems, viewport, now, byAge) {
    const plates = [];
    for (const side of EDGE_SIDE_ORDER) {
        const horizontal = side === 'top' || side === 'bottom';
        const along = item => (horizontal ? item.x : item.y);
        const reach = (horizontal ? viewport.width : viewport.height) * EDGE_CLUSTER_FRACTION;
        const sidePlates = [];
        for (const kind of Object.values(KIND)) {
            const list = edgeItems
                .filter(item => item.side === side && item.kind === kind)
                .sort((a, b) => (along(a) - along(b)) || byAge(a, b));
            const clusters = [];
            for (const item of list) {
                const last = clusters[clusters.length - 1];
                if (last && along(item) - last.start <= reach) {
                    last.members.push(item);
                    last.plate = edgePlate(ctx, last.members, side, viewport, now, byAge);
                } else {
                    clusters.push({ start: along(item), members: [item], plate: edgePlate(ctx, [item], side, viewport, now, byAge) });
                }
                while (clusters.length > 1
                    && rectsOverlap(clusters[clusters.length - 2].plate.rect, clusters[clusters.length - 1].plate.rect, EDGE_MERGE_PAD)) {
                    const tail = clusters.pop();
                    const prev = clusters[clusters.length - 1];
                    prev.members.push(...tail.members);
                    prev.plate = edgePlate(ctx, prev.members, side, viewport, now, byAge);
                }
            }
            for (const cluster of clusters) sidePlates.push(cluster.plate);
        }
        // Different kinds on one side: step apart along the edge, never overlap.
        sidePlates.sort((a, b) => (horizontal ? a.rect.left - b.rect.left : a.rect.top - b.rect.top));
        for (let i = 1; i < sidePlates.length; i++) {
            const prev = sidePlates[i - 1].rect;
            const rect = sidePlates[i].rect;
            if (!rectsOverlap(prev, rect, 4)) continue;
            const shift = horizontal ? prev.right + 4 - rect.left : prev.bottom + 4 - rect.top;
            sidePlates[i].rect = clearReserved(horizontal
                ? { ...rect, left: rect.left + shift, right: rect.right + shift }
                : { ...rect, top: rect.top + shift, bottom: rect.bottom + shift }, viewport);
        }
        plates.push(...sidePlates);
    }
    return plates;
}

function fitName(ctx, name) {
    ctx.font = WORLD_BODY_FONT_11;
    return fitLabelText(ctx, name, NAME_MAX);
}

function naturalRect(x, tip, width) {
    const bottom = tip - NOTCH_ROWS;
    const left = Math.round(x - width / 2);
    return { left, top: bottom - PLATE_H, right: left + width, bottom };
}

function singlePlate(item) {
    return {
        word: item.kind.word,
        color: item.kind.color,
        text: item.text,
        age: item.age,
        widths: item.widths,
        anchorX: item.x,
        tip: item.tip,
        members: 1,
        since: item.since,
        tier: item.tier,
        ids: [item.id],
    };
}

function groupPlate(ctx, members, now) {
    // Groups are single-kind (layout never unions across kinds).
    const kind = members[0].kind;
    const oldest = members[0];
    const age = ageText(oldest.since, now);
    const text = `${members.length} · oldest ${fitName(ctx, oldest.name)}`;
    let sumX = 0;
    let tip = Infinity;
    for (const item of members) {
        sumX += item.x;
        tip = Math.min(tip, item.tip);
    }
    return {
        word: kind.word,
        color: kind.color,
        text,
        age,
        widths: plateWidths(ctx, kind.word, age ? `${text} ${age}` : text, oldest.tier),
        anchorX: Math.round(sumX / members.length),
        tip,
        members: members.length,
        since: oldest.since,
        tier: oldest.tier,
        ids: members.map(item => item.id),
    };
}

function placePlate(request, placed, beacons, viewport) {
    const width = request.widths.width;
    const half = Math.round(width / 2) + 4;
    const candidates = [
        [0, 0], [0, -STACK_STEP], [-half, 0], [half, 0],
        [0, -STACK_STEP * 2], [-half, -STACK_STEP], [half, -STACK_STEP],
        [0, -STACK_STEP * 3], [-half * 2, 0], [half * 2, 0],
        [-half, -STACK_STEP * 2], [half, -STACK_STEP * 2], [0, -STACK_STEP * 4],
    ];
    let best = null;
    let bestHits = Infinity;
    for (const [dx, dy] of candidates) {
        const rect = clampRect(naturalRect(request.anchorX + dx, request.tip + dy, width), viewport);
        let hits = 0;
        for (const other of placed) if (rectsOverlap(rect, other.rect, 2)) hits += 2;
        for (const beacon of beacons) if (rectsOverlap(rect, beacon, 1)) hits += 1;
        if (hits < bestHits) {
            best = rect;
            bestHits = hits;
            if (hits === 0) break;
        }
    }
    return { ...request, rect: best };
}

function clampRect(rect, viewport) {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const left = Math.max(EDGE_MARGIN, Math.min(viewport.width - EDGE_MARGIN - width, rect.left));
    const top = Math.max(EDGE_MARGIN, Math.min(viewport.height - EDGE_MARGIN - height - NOTCH_ROWS, rect.top));
    return clearReserved({ left, top, right: left + width, bottom: top + height }, viewport);
}

// Screen rects of every plate, beacon and off-frame tally tab, for
// plaque/name reservations.
export function attentionScreenRects(layout) {
    const out = [];
    for (const plate of layout?.plates || []) out.push(plate.rect);
    for (const beacon of layout?.beacons || []) out.push(beacon);
    for (const tab of layout?.tallies || []) out.push(tab.rect);
    return out;
}

/**
 * Draws a layout from layoutAttentionPlates. `ctx` must be in CSS-pixel screen space.
 * `inkOnly` (the resident path, whose GPU drew `attentionMarkRecords` this
 * frame): clear every graphic's footprint instead of filling it, then print
 * the text — the overlay above the GPU marks carries only the ink. The W5.6
 * off-frame tally tabs are overlay-only walnut and draw whole either way.
 */
export function drawAttentionPlates(ctx, layout, { inkOnly = false } = {}) {
    if (!ctx || !(layout?.count || layout?.tallies?.length)) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = 'transparent';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const fill = inkOnly
        ? (ink, left, top, width, height) => ctx.clearRect(left, top, width, height)
        : (ink, left, top, width, height) => {
            ctx.fillStyle = ink;
            ctx.fillRect(left, top, width, height);
        };
    for (const plate of layout.plates) leaderFills(plate, fill);
    // A beacon stamp's opaque pixels erase exactly what they would cover.
    if (inkOnly) ctx.globalCompositeOperation = 'destination-out';
    for (const beacon of layout.beacons) {
        // The medallion's clears ignore the composite mode, so the ink-only
        // pass erases it before the stamp, in the GPU records' order.
        if (beacon.ring) beaconRingFills(beacon, fill);
        const inset = beacon.ring ? BEACON_RING_INSET : 0;
        drawOutlinedMotif(ctx, beacon.kind.motif, beacon.left + inset + 1, beacon.top + inset + 1, {
            step: beacon.step || BEACON_STEP,
            color: beacon.kind.color,
            outline: LABEL_INK.plateOutline,
        });
    }
    if (inkOnly) ctx.globalCompositeOperation = 'source-over';
    for (const plate of layout.plates) {
        plateFills(plate, fill);
        drawPlateText(ctx, plate);
    }
    for (const tab of layout.tallies || []) drawTallyTab(ctx, tab);
    ctx.restore();
}

// §7.1 roles a mark record carries: 2 = action-needed (the solid status-colour
// areas: status cell, notch status rows, the beacon's colour pixels), 0 = rim
// and plate ink (the beacon's dark outline and the edge arrow included), so
// 10.2's mark gain never lifts a dark ink.
const ROLE_RIM = 0;
const ROLE_MARK = 2;

// One texel per plate ink, sampled by the fill records (nearest, clamped to
// the texel, so every record is its ink's exact bytes). The C4 peak cream
// rides the same atlas for the verified-success peak frame (`inkMarkRecords`).
const MARK_INKS = Object.freeze([
    LABEL_INK.plateOutline,
    LABEL_INK.plate,
    ...Object.values(KIND).map(kind => kind.color),
    EFFECT_COLORS.peak,
]);
let markInkAtlas = null;

function markInks() {
    if (markInkAtlas) return markInkAtlas;
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = MARK_INKS.length;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const texel = new Map();
    MARK_INKS.forEach((ink, index) => {
        ctx.fillStyle = ink;
        ctx.fillRect(index, 0, 1, 1);
        texel.set(ink, index);
    });
    markInkAtlas = { canvas, texel };
    return markInkAtlas;
}

const MARK_RECORD_POOL = [];

function markRecord(index, source, textureKey, pool = MARK_RECORD_POOL) {
    const record = pool[index] || (pool[index] = {
        prenormalized: true,
        blend: 'normal',
        alpha: 1,
        material: 0,
        elevation: 0,
        emissive: 0,
        emissiveGate: 1,
        occluder: 0,
        paletteRamp: false,
        writesDepth: false,
        depthKey: 0,
        footY: -1,
        frontCornerX: 0,
        frontCornerY: -1,
        ownerSlot: 0,
        landmarkId: 0,
        pageLayer: -1,
        textureRevision: 0,
    });
    record.source = source;
    record.textureKey = textureKey;
    record.sourceWidth = source.width;
    record.sourceHeight = source.height;
    record.sequence = index;
    return record;
}

/**
 * T1 on the resident path (§7.4): the layout's graphical pixels as V9 mark
 * records in draw order — leaders, beacons, then each plate's fills — with
 * rects in backing pixels (`scale` = the overlay's integer device scale) and
 * flag `screenSpace` (+ `actionMark` for role 2). Returns `out` (emptied
 * first), or null when the layout cannot be expressed exactly (no DOM, an
 * ink or motif without a texel), in which case the overlay draws the plates.
 */
export function attentionMarkRecords(layout, { scale = 1, out = [] } = {}) {
    out.length = 0;
    if (!layout?.count) return out;
    const inks = markInks();
    if (!inks) return null;
    let complete = true;
    const fill = (ink, left, top, width, height, role) => {
        const sx = inks.texel.get(ink);
        if (sx === undefined) {
            complete = false;
            return;
        }
        const record = markRecord(out.length, inks.canvas, 'mark:inks');
        record.sx = sx;
        record.sy = 0;
        record.sw = 1;
        record.sh = 1;
        record.x = left * scale;
        record.y = top * scale;
        record.width = width * scale;
        record.height = height * scale;
        record.role = role;
        record.flags = GPU_RECORD_FLAGS.screenSpace | (role === ROLE_MARK ? GPU_RECORD_FLAGS.actionMark : 0);
        out.push(record);
    };
    for (const plate of layout.plates) leaderFills(plate, fill);
    for (const beacon of layout.beacons) {
        if (beacon.ring) beaconRingFills(beacon, fill);
        const step = beacon.step || BEACON_STEP;
        const inset = beacon.ring ? BEACON_RING_INSET : 0;
        // Two stamps, outline under colour: the silhouette in the outline
        // ink (role 0), then only the motif's colour pixels (role 2). Both
        // are opaque-or-empty, so together they are drawOutlinedMotif's
        // pixels exactly.
        const stamps = [
            [outlinedMotifStamp(beacon.kind.motif, { step, color: LABEL_INK.plateOutline, outline: LABEL_INK.plateOutline, scale }), ROLE_RIM],
            [outlinedMotifStamp(beacon.kind.motif, { step, color: beacon.kind.color, outline: 'transparent', scale }), ROLE_MARK],
        ];
        for (const [stamp, role] of stamps) {
            if (!stamp) return null;
            const record = markRecord(out.length, stamp.canvas, `mark:beacon:${stamp.key}`);
            record.sx = 0;
            record.sy = 0;
            record.sw = stamp.canvas.width;
            record.sh = stamp.canvas.height;
            // drawOutlinedMotif's device origin: one pixel up-left of the motif.
            record.x = Math.round((beacon.left + inset) * scale);
            record.y = Math.round((beacon.top + inset) * scale);
            record.width = stamp.canvas.width;
            record.height = stamp.canvas.height;
            record.role = role;
            record.flags = GPU_RECORD_FLAGS.screenSpace | (role === ROLE_MARK ? GPU_RECORD_FLAGS.actionMark : 0);
            out.push(record);
        }
    }
    for (const plate of layout.plates) plateFills(plate, fill);
    return complete ? out : null;
}

/**
 * 10.2 — other overlay marks the GPU draws in one mark ink (the C4
 * verified-success cream peak frame, EffectStamps `takePeakMarks`): each
 * backing-px `{ left, top, width, height }` as a role-2 (`actionMark`) V9
 * screen-space record on the ink atlas. `pool` is the caller's own record
 * pool: this module's pool holds the frame's T1 records, which the same late
 * pass draws again above these. Returns `out` (emptied first), or null when
 * the ink has no texel (no DOM, or not a mark ink).
 */
export function inkMarkRecords(rects, ink, { out = [], pool = [] } = {}) {
    out.length = 0;
    const inks = markInks();
    const sx = inks?.texel.get(ink);
    if (sx === undefined) return null;
    for (const rect of rects) {
        const record = markRecord(out.length, inks.canvas, 'mark:inks', pool);
        record.sx = sx;
        record.sy = 0;
        record.sw = 1;
        record.sh = 1;
        record.x = rect.left;
        record.y = rect.top;
        record.width = rect.width;
        record.height = rect.height;
        record.role = ROLE_MARK;
        record.flags = GPU_RECORD_FLAGS.screenSpace | GPU_RECORD_FLAGS.actionMark;
        out.push(record);
    }
    return out;
}

function notchX(plate) {
    const { rect } = plate;
    return Math.max(rect.left + 4, Math.min(rect.right - 5, plate.anchorX));
}

// A displaced plate keeps a one-pixel elbow back to its beacon: vertical from
// the notch, then horizontal to the anchor column. Axis-aligned only.
// `fill(ink, left, top, width, height, role)` in CSS px, in draw order.
function leaderFills(plate, fill) {
    if (plate.side) return;
    const nx = notchX(plate);
    const fromY = plate.rect.bottom + NOTCH_ROWS;
    const toY = plate.tip;
    if (toY - fromY < 1 && nx === plate.anchorX) return;
    elbowLeaderFills(fill, nx, fromY, plate.anchorX, toY, plate.color);
}

// The one leader grammar for every displaced world label (T1 plates here, the
// W3.1 thought column in AgentSprite): a one-pixel core in `ink` inside a
// three-pixel dark outline, vertical at `x` from `fromY` to `toY`, then
// horizontal along `toY` to `anchorX`. Whole CSS px, axis-aligned only.
export function elbowLeaderFills(fill, x, fromY, anchorX, toY, ink) {
    const top = Math.min(fromY, toY);
    const height = Math.abs(toY - fromY) + 1;
    fill(LABEL_INK.plateOutline, x - 1, top, 3, height, ROLE_RIM);
    if (x !== anchorX) {
        fill(LABEL_INK.plateOutline, Math.min(x, anchorX) - 1, toY - 1, Math.abs(anchorX - x) + 3, 3, ROLE_RIM);
    }
    fill(ink, x, top, 1, height, ROLE_RIM);
    if (x !== anchorX) {
        fill(ink, Math.min(x, anchorX), toY, Math.abs(anchorX - x) + 1, 1, ROLE_RIM);
    }
}

function plateFills(plate, fill) {
    const { rect, widths } = plate;
    const left = rect.left;
    const top = rect.top;
    const width = rect.right - rect.left;
    fill(LABEL_INK.plateOutline, left, top, width, PLATE_H, ROLE_RIM);
    fill(plate.color, left + 1, top + 1, widths.wordCell, PLATE_H - 2, ROLE_MARK);
    fill(LABEL_INK.plate, left + 1 + widths.wordCell, top + 1, widths.textCell, PLATE_H - 2, ROLE_RIM);
    // W5.4 — age notches: one carved 3×2 row per wait-age rung above the
    // first, in plate ink at the status cell's right end, stacked up from
    // the word's last glyph row.
    const notchLeft = left + 1 + widths.wordCell - WORD_PAD - AGE_NOTCH_W;
    for (let row = 0; row < notchRows(plate.tier); row++) {
        fill(LABEL_INK.plate, notchLeft, top + 11 - row * 3, AGE_NOTCH_W, 2, ROLE_RIM);
    }

    if (plate.side) {
        arrowFills(plate.side, rect.left + 1 + WORD_PAD, rect.top + 5, LABEL_INK.plate, fill);
    } else {
        // Notch: three stepped rows under the plate in the status colour,
        // with a dark outline, pointing down at the beacon.
        const nx = notchX(plate);
        const bottom = top + PLATE_H;
        fill(LABEL_INK.plateOutline, nx - 3, bottom, 7, 1, ROLE_RIM);
        fill(LABEL_INK.plateOutline, nx - 2, bottom + 1, 5, 1, ROLE_RIM);
        fill(LABEL_INK.plateOutline, nx - 1, bottom + 2, 3, 1, ROLE_RIM);
        fill(plate.color, nx - 2, bottom - 1, 5, 1, ROLE_MARK);
        fill(plate.color, nx - 1, bottom, 3, 1, ROLE_MARK);
        fill(plate.color, nx, bottom + 1, 1, 1, ROLE_MARK);
    }
}

function drawPlateText(ctx, plate) {
    const { rect, widths } = plate;
    const left = rect.left;
    const top = rect.top;
    ctx.font = WORLD_DISPLAY_FONT_8;
    ctx.fillStyle = LABEL_INK.plate;
    ctx.fillText(plate.word, left + 1 + WORD_PAD + (plate.wordOffset || 0), top + 13);
    ctx.font = WORLD_BODY_FONT_11;
    const textX = left + 1 + widths.wordCell + TEXT_PAD;
    ctx.fillStyle = LABEL_INK.text;
    ctx.fillText(plate.text, textX, top + 12);
    if (plate.age) {
        ctx.fillStyle = LABEL_INK.textDim;
        ctx.fillText(plate.age, textX + measureLabelText(ctx, `${plate.text} `), top + 12);
    }
}

// W5.4 — the 5–15 min beacon's medallion, in the beacon's 26 px box: a dark
// chamfered disc (role 0) carrying a one-pixel status-colour ring (role 2)
// one pixel inside its rim; the 2× motif then stamps on its centre.
function beaconRingFills(beacon, fill) {
    const x = beacon.left;
    const y = beacon.top;
    const n = BEACON_RING_BOX;
    const dark = LABEL_INK.plateOutline;
    fill(dark, x + 3, y, n - 6, 1, ROLE_RIM);
    fill(dark, x + 2, y + 1, n - 4, 1, ROLE_RIM);
    fill(dark, x + 1, y + 2, n - 2, 1, ROLE_RIM);
    fill(dark, x, y + 3, n, n - 6, ROLE_RIM);
    fill(dark, x + 1, y + n - 3, n - 2, 1, ROLE_RIM);
    fill(dark, x + 2, y + n - 2, n - 4, 1, ROLE_RIM);
    fill(dark, x + 3, y + n - 1, n - 6, 1, ROLE_RIM);
    const hue = beacon.kind.color;
    fill(hue, x + 3, y + 1, n - 6, 1, ROLE_MARK);
    fill(hue, x + 2, y + 2, 1, 1, ROLE_MARK);
    fill(hue, x + n - 3, y + 2, 1, 1, ROLE_MARK);
    fill(hue, x + 1, y + 3, 1, n - 6, ROLE_MARK);
    fill(hue, x + n - 2, y + 3, 1, n - 6, ROLE_MARK);
    fill(hue, x + 2, y + n - 3, 1, 1, ROLE_MARK);
    fill(hue, x + n - 3, y + n - 3, 1, 1, ROLE_MARK);
    fill(hue, x + 3, y + n - 2, n - 6, 1, ROLE_MARK);
}

// W5.6 — one off-frame tally tab: the T5 walnut board at plate height, the
// stepped edge arrow in walnut gold, a carved divider, then the counts in
// the plaque count ink. Overlay only; static.
function drawTallyTab(ctx, tab) {
    const { rect } = tab;
    paintWalnutBoard(ctx, rect.left, rect.top, rect.right - rect.left, PLATE_H);
    const fill = (ink, left, top, width, height) => {
        ctx.fillStyle = ink;
        ctx.fillRect(left, top, width, height);
    };
    arrowFills(tab.side, rect.left + 1 + TALLY_PAD, rect.top + 5, WALNUT.text, fill);
    const dividerX = rect.left + 1 + TALLY_PAD + 7 + TALLY_PAD;
    fill(WALNUT.divider, dividerX, rect.top + 2, 1, PLATE_H - 4);
    ctx.font = WORLD_BODY_FONT_11;
    ctx.fillStyle = WALNUT.count;
    ctx.fillText(tab.text, dividerX + 1 + TALLY_PAD, rect.top + 12);
}

// Edge arrow: a 7×7 pixel arrow with its top-left at (x0, y0), pointing past
// the frame on `side` (the authored down arrow, flipped or transposed for the
// other sides) — the edge plate's in plate ink, the tally tab's in walnut gold.
function arrowFills(side, x0, y0, ink, fill) {
    const size = EDGE_ARROW_DOWN.length;
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const filled = side === 'bottom' ? EDGE_ARROW_DOWN[row][col]
                : side === 'top' ? EDGE_ARROW_DOWN[size - 1 - row][col]
                    : side === 'right' ? EDGE_ARROW_DOWN[col][row]
                        : EDGE_ARROW_DOWN[size - 1 - col][row];
            if (filled === '#') fill(ink, x0 + col, y0 + row, 1, 1, ROLE_RIM);
        }
    }
}
