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
// Cost: layout is O(n²) over on-screen action-needed agents only (usually
// 0–10); drawing is ≤ 8 fills + 2 fillText per plate and one cached stamp
// blit per beacon. Static: no motion, so reduced motion is identical.

import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { waitAnchor } from '../../domain/services/SignalLedger.js';
import { STATUS_VISUALS, WORLD_BODY_FONT_11, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { elapsedTickNow, formatElapsed } from '../shared/Formatters.js';
import { LABEL_INK, drawOutlinedMotif, fitLabelText, measureLabelText } from './WorldLabelKit.js';

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

function plateWidths(ctx, word, text) {
    ctx.font = WORLD_DISPLAY_FONT_8;
    const wordCell = measureLabelText(ctx, word) + WORD_PAD * 2;
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
 * @returns {{ plates: object[], beacons: object[], count: number, offscreen: number }}
 */
export function layoutAttentionPlates(ctx, { sprites, camera, viewport, reserved = null, now = elapsedTickNow() } = {}) {
    const layout = { plates: [], beacons: [], count: 0, offscreen: 0 };
    if (!ctx || !camera?.worldToScreen || !viewport?.width) return layout;
    if (reserved?.length) viewport = { ...viewport, reserved };
    const items = [];
    const edgeItems = [];
    for (const sprite of sprites || []) {
        const status = sprite?.agent?.status;
        const kind = KIND[status];
        if (!kind || sprite.isArrivalPending?.() || sprite.agent?.isDeparted || sprite._archiveAnim) continue;
        if (!Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
        const headY = typeof sprite._labelTopY === 'function' && typeof sprite._headTopY === 'function'
            ? sprite._labelTopY(sprite._headTopY())
            : sprite.y - 64;
        const head = camera.worldToScreen(sprite.x, headY);
        const x = Math.round(head.x);
        const beaconBottom = Math.round(head.y) - BEACON_GAP;
        const beacon = {
            kind,
            left: x - BEACON_SIZE / 2,
            top: beaconBottom - BEACON_SIZE,
            right: x + BEACON_SIZE / 2,
            bottom: beaconBottom,
        };
        const item = {
            sprite,
            kind,
            x,
            y: Math.round(head.y),
            beacon,
            since: statusSince(sprite),
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
    if (!layout.count) return layout;

    // Oldest first: it keeps the natural slot; unknown ages sort last.
    const byAge = (a, b) => ((a.since ?? Infinity) - (b.since ?? Infinity)) || a.id.localeCompare(b.id);
    items.sort(byAge);
    edgeItems.sort(byAge);

    for (const item of [...items, ...edgeItems]) {
        item.text = fitName(ctx, item.name);
        item.age = ageText(item.since, now);
        item.widths = plateWidths(ctx, item.kind.word, item.age ? `${item.text} ${item.age}` : item.text);
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
    return layout;
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
        widths: plateWidths(ctx, kind.word, age ? `${text} ${age}` : text),
        anchorX: Math.round(sumX / members.length),
        tip,
        members: members.length,
        since: oldest.since,
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

// Screen rects of every plate and beacon, for plaque/name reservations.
export function attentionScreenRects(layout) {
    const out = [];
    for (const plate of layout?.plates || []) out.push(plate.rect);
    for (const beacon of layout?.beacons || []) out.push(beacon);
    return out;
}

/** Draws a layout from layoutAttentionPlates. `ctx` must be in CSS-pixel screen space. */
export function drawAttentionPlates(ctx, layout) {
    if (!ctx || !layout?.count) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = 'transparent';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const plate of layout.plates) drawLeader(ctx, plate);
    for (const beacon of layout.beacons) {
        drawOutlinedMotif(ctx, beacon.kind.motif, beacon.left + 1, beacon.top + 1, {
            step: BEACON_STEP,
            color: beacon.kind.color,
            outline: LABEL_INK.plateOutline,
        });
    }
    for (const plate of layout.plates) drawPlate(ctx, plate);
    ctx.restore();
}

function notchX(plate) {
    const { rect } = plate;
    return Math.max(rect.left + 4, Math.min(rect.right - 5, plate.anchorX));
}

// A displaced plate keeps a one-pixel elbow back to its beacon: vertical from
// the notch, then horizontal to the anchor column. Axis-aligned only.
function drawLeader(ctx, plate) {
    if (plate.side) return;
    const nx = notchX(plate);
    const fromY = plate.rect.bottom + NOTCH_ROWS;
    const toY = plate.tip;
    if (toY - fromY < 1 && nx === plate.anchorX) return;
    ctx.fillStyle = LABEL_INK.plateOutline;
    const top = Math.min(fromY, toY);
    ctx.fillRect(nx - 1, top, 3, Math.abs(toY - fromY) + 1);
    if (nx !== plate.anchorX) {
        const left = Math.min(nx, plate.anchorX);
        ctx.fillRect(left - 1, toY - 1, Math.abs(plate.anchorX - nx) + 3, 3);
    }
    ctx.fillStyle = plate.color;
    ctx.fillRect(nx, top, 1, Math.abs(toY - fromY) + 1);
    if (nx !== plate.anchorX) {
        ctx.fillRect(Math.min(nx, plate.anchorX), toY, Math.abs(plate.anchorX - nx) + 1, 1);
    }
}

function drawPlate(ctx, plate) {
    const { rect, widths } = plate;
    const left = rect.left;
    const top = rect.top;
    const width = rect.right - rect.left;
    ctx.fillStyle = LABEL_INK.plateOutline;
    ctx.fillRect(left, top, width, PLATE_H);
    ctx.fillStyle = plate.color;
    ctx.fillRect(left + 1, top + 1, widths.wordCell, PLATE_H - 2);
    ctx.fillStyle = LABEL_INK.plate;
    ctx.fillRect(left + 1 + widths.wordCell, top + 1, widths.textCell, PLATE_H - 2);

    if (plate.side) {
        drawEdgeArrow(ctx, plate);
    } else {
        // Notch: three stepped rows under the plate in the status colour,
        // with a dark outline, pointing down at the beacon.
        const nx = notchX(plate);
        const bottom = top + PLATE_H;
        ctx.fillStyle = LABEL_INK.plateOutline;
        ctx.fillRect(nx - 3, bottom, 7, 1);
        ctx.fillRect(nx - 2, bottom + 1, 5, 1);
        ctx.fillRect(nx - 1, bottom + 2, 3, 1);
        ctx.fillStyle = plate.color;
        ctx.fillRect(nx - 2, bottom - 1, 5, 1);
        ctx.fillRect(nx - 1, bottom, 3, 1);
        ctx.fillRect(nx, bottom + 1, 1, 1);
    }

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

// Edge plate arrow: a 7×7 pixel arrow in plate ink at the head of the status
// cell, pointing past the frame toward the agent (the authored down arrow,
// flipped or transposed for the other sides).
function drawEdgeArrow(ctx, plate) {
    const { rect, side } = plate;
    const x0 = rect.left + 1 + WORD_PAD;
    const y0 = rect.top + 5;
    const size = EDGE_ARROW_DOWN.length;
    ctx.fillStyle = LABEL_INK.plate;
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const filled = side === 'bottom' ? EDGE_ARROW_DOWN[row][col]
                : side === 'top' ? EDGE_ARROW_DOWN[size - 1 - row][col]
                    : side === 'right' ? EDGE_ARROW_DOWN[col][row]
                        : EDGE_ARROW_DOWN[size - 1 - col][row];
            if (filled === '#') ctx.fillRect(x0 + col, y0 + row, 1, 1);
        }
    }
}
