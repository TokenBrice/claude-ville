// 3.8 — Harbor hulls at art resolution, as resident records.
//
// Every hull class ships as a 5-frame roll strip baked offline at scale 1
// (`scripts/sprites/bake-harbor-hulls.mjs`: -3°, -1.5°, 0, +1.5°, +3° with
// cleanEdge, frame 2 = the authored sprite, a 1-px waterline lip on the
// contact row). The runtime picks a view, a frame and a whole-texel
// position; it never rotates or scales a hull.
//
// Phase 3.5 — directional hulls. A hull faces one of four diagonals (SW, SE,
// NW, NE: the strip is `[direction][roll]`). The manifest lists the views a
// strip authors (`directions`, five roll frames each, in strip order;
// default the one view its `bowFacing` names: west = SW, east = SE); every
// other view is the mirror of its partner (SW ↔ SE, NW ↔ NE) or, while the
// art has no view for that side, the authored view nearest it. Mirrored
// strips are baked once into cached canvases with their anchor, mastheads
// and livery/reflection caches keyed by direction. On the resident path a hull is a V9 record
// (painter depth, the scene grade, lamp light, footprint occlusion) with a
// `reflect` twin in the ground band and a V-wake stamp record under it; the
// Canvas fallback draws the same frames, graded through cached tinted
// canvases when it lands on the ungraded overlay (the WildlifeRenderer
// pattern), plus a cached mirrored reflection.

import { ART_RAMPS } from '../../config/artPalette.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { materialClassId } from './MaterialRegistry.js';
import { wakeV } from './EffectStamps.js';

export const HULL_ROLL_FRAMES = 5;
export const HULL_ROLL_STEP_DEG = 1.5;
const HULL_ROLL_CENTRE = 2;
const TIMBER = materialClassId('timber');
// Wake foam is matter on the water, not a water stop: the water shader's
// stop cycle would swallow a foam-coloured texel, so it grades as unlit foam.
const FOAM_MATERIAL = materialClassId('unlit');
// Canvas reflection: the same three alpha courses 3.7's baked statics use,
// every fifth row dropped, 38 % toward the local (mid shallow) water stop.
const REFLECTION_ALPHAS = Object.freeze([0.42, 0.28, 0.16]);
const REFLECTION_STOP = hexRgb(ART_RAMPS.shallowWater[1]);
const REFLECTION_TOWARD_STOP = 0.38;
const WAKE_FOAM = ART_RAMPS.shallowWater[2];
// CoastBake FOAM_CREST (foam lifted 45 % toward the crest white).
const WAKE_CREST = '#b5cabf';
const GRADE_PROBES = Object.freeze([[0.92, 0.94, 0.95], [0.5, 0.5, 0.5], [0.45, 0.62, 0.8]]);
const LIVERY_CACHE_LIMIT = 48;
const WAKE_CACHE_LIMIT = 96;
const BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

function hexRgb(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// `roll` in degrees → strip frame index (2 = upright).
export function rollFrameIndex(rollDeg) {
    const step = Math.max(-2, Math.min(2, Math.round((Number(rollDeg) || 0) / HULL_ROLL_STEP_DEG)));
    return step + HULL_ROLL_CENTRE;
}

export const HULL_DIRECTIONS = Object.freeze(['sw', 'se', 'nw', 'ne']);
const MIRROR_DIRECTION = Object.freeze({ sw: 'se', se: 'sw', nw: 'ne', ne: 'nw' });
const SAME_SIDE_DIRECTION = Object.freeze({ sw: 'nw', nw: 'sw', se: 'ne', ne: 'se' });
const WEST_DIRECTIONS = new Set(['sw', 'nw']);
// Screen angle (world px, y down) of travel along each tile diagonal.
const DIRECTION_ANGLES = Object.freeze({
    se: Math.atan2(16, 32),
    sw: Math.atan2(16, -32),
    nw: Math.atan2(-16, -32),
    ne: Math.atan2(-16, 32),
});
const HEADING_HYSTERESIS = 20 * Math.PI / 180;

function angleBetween(a, b) {
    const d = Math.abs(a - b) % (Math.PI * 2);
    return d > Math.PI ? Math.PI * 2 - d : d;
}

// Screen travel (world px) → the hull view nearest it. The current view
// holds until another is HEADING_HYSTERESIS nearer, so a weaving course never
// flickers it.
export function hullHeadingDirection(vx, vy, current = null) {
    const angle = Math.atan2(vy, vx);
    let best = 'sw';
    let bestDistance = Infinity;
    for (const direction of HULL_DIRECTIONS) {
        const distance = angleBetween(angle, DIRECTION_ANGLES[direction]);
        if (distance < bestDistance) {
            best = direction;
            bestDistance = distance;
        }
    }
    if (current && current !== best && DIRECTION_ANGLES[current] !== undefined
        && angleBetween(angle, DIRECTION_ANGLES[current]) - bestDistance < HEADING_HYSTERESIS) return current;
    return best;
}

// The views a manifest entry authors, in strip order.
export function hullAuthoredDirections(entry = {}) {
    const listed = Array.isArray(entry?.directions)
        ? entry.directions.map(item => String(item).toLowerCase()).filter(item => MIRROR_DIRECTION[item])
        : [];
    if (listed.length) return listed;
    return [String(entry?.bowFacing || 'west').toLowerCase() === 'east' ? 'se' : 'sw'];
}

// How `direction` is drawn: from which authored view, mirrored or not.
export function hullDirectionSource(entry, direction = 'sw') {
    const authored = hullAuthoredDirections(entry);
    const wanted = MIRROR_DIRECTION[direction] ? direction : 'sw';
    const candidates = [
        [wanted, false],
        [MIRROR_DIRECTION[wanted], true],
        [SAME_SIDE_DIRECTION[wanted], false],
        [MIRROR_DIRECTION[SAME_SIDE_DIRECTION[wanted]], true],
    ];
    for (const [source, mirrored] of candidates) {
        const index = authored.indexOf(source);
        if (index >= 0) return { source, mirrored, index, count: authored.length };
    }
    return { source: authored[0], mirrored: false, index: 0, count: authored.length };
}

const _stripMeta = new WeakMap();

// The resident strip for a hull sprite id in one direction: { image,
// frameWidth, frameHeight, frameOffset, anchorX, anchorY, mastheads,
// direction, bowX, key } (anchor = the waterline pivot, frame-local;
// mastheads = per roll frame, the frame-local top of the tallest mast where
// the repo flag hoists, from the manifest `masthead` (or the view's
// `mastheads[view]`) of the upright frame turned about the pivot like the
// bake turned the art; bowX = the screen side the bow points, -1 west, +1
// east), or null while the asset is missing or is not a roll strip.
export function hullStrip(assets, spriteId, direction = 'sw') {
    const image = assets?.get?.(spriteId);
    if (!image?.width || !image?.height) return null;
    let byDirection = _stripMeta.get(image);
    if (!byDirection) {
        byDirection = new Map();
        _stripMeta.set(image, byDirection);
    }
    const dir = MIRROR_DIRECTION[direction] ? direction : 'sw';
    if (byDirection.has(dir)) return byDirection.get(dir);
    const meta = buildStripMeta(assets, spriteId, image, dir);
    byDirection.set(dir, meta);
    return meta;
}

function buildStripMeta(assets, spriteId, image, direction) {
    const entry = assets.getEntry?.(spriteId);
    const frames = Number(entry?.frames) || 0;
    const view = hullDirectionSource(entry, direction);
    if (frames !== HULL_ROLL_FRAMES * view.count) return null;
    const frameWidth = Math.floor(image.width / frames);
    const anchor = (Array.isArray(entry?.anchors?.[view.source]) && entry.anchors[view.source])
        || assets.getAnchor?.(spriteId) || [frameWidth / 2, image.height - 1];
    const anchorX = Math.round(anchor[0]);
    const anchorY = Math.round(anchor[1]);
    const authoredMasthead = Array.isArray(entry?.mastheads?.[view.source])
        ? entry.mastheads[view.source]
        : entry?.masthead;
    const masthead = Array.isArray(authoredMasthead) ? authoredMasthead.map(Number) : [anchorX, 0];
    const mastheads = Array.from({ length: HULL_ROLL_FRAMES }, (_, frame) => rollPoint(masthead, anchorX, anchorY, (frame - HULL_ROLL_CENTRE) * HULL_ROLL_STEP_DEG));
    const sourceBow = WEST_DIRECTIONS.has(view.source) ? -1 : 1;
    const meta = {
        spriteId,
        key: `${spriteId}@${direction}`,
        direction,
        image,
        frameWidth,
        frameHeight: image.height,
        frameOffset: view.index * HULL_ROLL_FRAMES,
        sourceFrameOffset: view.index * HULL_ROLL_FRAMES,
        anchorX,
        anchorY,
        mastheads,
        bowX: view.mirrored ? -sourceBow : sourceBow,
        mirrored: view.mirrored,
        revision: 0,
    };
    if (!view.mirrored) return meta;
    // A mirrored view: each roll frame flipped in place (frame order kept),
    // anchor and mastheads mirrored with it. Without a canvas (node) the
    // geometry still mirrors so poses and bounds stay true.
    const flip = (x) => frameWidth - 1 - x;
    meta.anchorX = flip(anchorX);
    meta.mastheads = mastheads.map(([x, y]) => [flip(x), y]);
    const canvas = flippedFrames(image, frameWidth, meta.frameOffset);
    if (!canvas) return meta;
    meta.image = canvas;
    meta.frameOffset = 0;
    return meta;
}

// The five roll frames of one view (from `frameOffset`), each flipped in
// place by texel copy: no canvas transform ever touches a hull.
function flippedFrames(image, frameWidth, frameOffset) {
    const canvas = canvasOf(frameWidth * HULL_ROLL_FRAMES, image.height);
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, frameOffset * frameWidth, 0, canvas.width, image.height, 0, 0, canvas.width, image.height);
    const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const flipped = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const frame = Math.floor(x / frameWidth);
            const sx = frame * frameWidth + (frameWidth - 1 - (x - frame * frameWidth));
            const si = (y * canvas.width + sx) * 4;
            const di = (y * canvas.width + x) * 4;
            flipped.data[di] = source.data[si];
            flipped.data[di + 1] = source.data[si + 1];
            flipped.data[di + 2] = source.data[si + 2];
            flipped.data[di + 3] = source.data[si + 3];
        }
    }
    ctx.putImageData(flipped, 0, 0);
    return canvas;
}

// ─── Lamps: the emissive sidecar (5.3 night lamps) ───────────────────────────
//
// `prop.harborShip.<id>.emissive.png` (manifest `emissiveSidecar: true`) is
// the strip's twin, frame for frame: masthead and stern lanterns per authored
// view and roll. A strip's lamps are that sidecar laid out exactly like its
// albedo (a mirrored view mirrored the same way), so one source rect samples
// both. Cached per view and source image; null until the sidecar has loaded
// (the AssetManager companion request retries) or for a hull without one.
const _lampStrips = new Map();
const _lampSidecars = new Map();
const HULL_LAMP_STRENGTH = 0.8;

// The sidecar image: the AssetManager companion (loaded with the material
// channels), else, where those are off (the Canvas world), the `.emissive.png`
// beside the strip, fetched once (EmitterCuts.emissiveSidecarFor's rule).
function lampSidecar(assets, id) {
    const companion = assets.getCompanion?.(id, 'emissive');
    if (companion?.width) return companion;
    const key = `${assets.assetVersion || ''}|${id}`;
    const cached = _lampSidecars.get(key);
    if (cached !== undefined) return cached === 'loading' ? null : cached;
    const src = typeof assets.get?.(id)?.src === 'string' ? assets.get(id).src : '';
    if (!src || typeof Image === 'undefined') {
        _lampSidecars.set(key, null);
        return null;
    }
    const image = new Image();
    _lampSidecars.set(key, 'loading');
    image.onload = () => _lampSidecars.set(key, image);
    image.onerror = () => _lampSidecars.set(key, null);
    image.src = src.replace(/\.png(?=([?#]|$))/, '.emissive.png');
    return null;
}

export function hullLampStrip(assets, strip) {
    if (!strip?.spriteId) return null;
    const entry = assets?.getEntry?.(strip.spriteId);
    if (entry?.emissiveSidecar !== true) return null;
    const source = lampSidecar(assets, strip.spriteId);
    if (!source?.width) return null;
    const key = `${strip.spriteId}@${strip.direction || 'sw'}`;
    const hit = _lampStrips.get(key);
    if (hit && hit.source === source) return hit.lamps;
    const image = strip.mirrored
        ? flippedFrames(source, strip.frameWidth, strip.sourceFrameOffset || 0)
        : source;
    if (!image) return null;
    const lamps = {
        image,
        key: `harbor-hull-lamps:${key}`,
        strength: Math.max(0, Math.min(1, Number(entry.emissive?.strength) || HULL_LAMP_STRENGTH)),
    };
    _lampStrips.set(key, { source, lamps });
    return lamps;
}

// A frame-local point of the upright frame turned `deg` clockwise about the
// waterline pivot's texel centre (the bake's cleanEdge roll), whole texels.
function rollPoint([x, y], anchorX, anchorY, deg) {
    const a = deg * Math.PI / 180;
    const dx = x - anchorX; const dy = y - anchorY;
    return [
        Math.round(anchorX + dx * Math.cos(a) - dy * Math.sin(a)),
        Math.round(anchorY + dx * Math.sin(a) + dy * Math.cos(a)),
    ];
}

// World position of a pose's masthead (its frame, bob and sink included).
export function hullMasthead(pose) {
    const g = hullGeometry(pose);
    const [mx, my] = pose.strip.mastheads[pose.frame] || pose.strip.mastheads[HULL_ROLL_CENTRE];
    return { x: g.x + mx, y: g.y + my };
}

// ─── Livery: repo-accent gunwale stripe (skiffs) ─────────────────────────────

const _livery = new Map();

function canvasOf(width, height) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function touch(cache, key, value, limit) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    return value;
}

// A copy of the strip with a 1-texel accent stripe `stripeRow` texels above
// the waterline, painted only on dark timber texels of the hull, so the
// stripe follows each rolled frame's own planks and never floats in the air.
export function liveryStrip(strip, accent, stripeRow) {
    const key = `${strip.key || strip.spriteId}|${accent}|${stripeRow}`;
    const hit = _livery.get(key);
    if (hit && hit.source === strip.image) return touch(_livery, key, hit, LIVERY_CACHE_LIMIT).strip;
    const canvas = canvasOf(strip.image.width, strip.image.height);
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx) return strip;
    ctx.drawImage(strip.image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    const [ar, ag, ab] = hexRgb(accent || '#c9a04a');
    const y = strip.anchorY - stripeRow;
    if (y > 0) {
        for (let frame = 0; frame < HULL_ROLL_FRAMES; frame++) {
            for (let x = 0; x < strip.frameWidth; x++) {
                const i = ((y * canvas.width) + ((strip.frameOffset || 0) + frame) * strip.frameWidth + x) * 4;
                if (px[i + 3] < 128) continue;
                const lum = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
                // Timber, not sail cloth or outline.
                if (lum < 28 || lum > 120 || px[i] < px[i + 2]) continue;
                px[i] = ar; px[i + 1] = ag; px[i + 2] = ab;
            }
        }
    }
    ctx.putImageData(data, 0, 0);
    const liveried = { ...strip, image: canvas, liveryKey: key };
    touch(_livery, key, { source: strip.image, strip: liveried }, LIVERY_CACHE_LIMIT);
    return liveried;
}

// ─── Pose → records ──────────────────────────────────────────────────────────

// `pose`: { id, strip, frame, x, y (waterline anchor, world px), bob (whole
// texels, up), sink (whole texels, down), alpha (quantized), wake: null |
// { dirX, dirY, length } }. Every value is already whole-texel; the records
// sit on the world texel grid.
export function hullGeometry(pose) {
    const { strip } = pose;
    const x0 = Math.round(pose.x) - strip.anchorX;
    const top = Math.round(pose.y) - strip.anchorY - (pose.bob | 0) + (pose.sink | 0);
    // A sinking hull loses the rows that pass below its waterline.
    const visible = Math.max(1, strip.anchorY + 1 - (pose.sink | 0));
    return {
        sx: ((strip.frameOffset || 0) + pose.frame) * strip.frameWidth,
        x: x0,
        y: top,
        width: strip.frameWidth,
        height: visible,
        // The reflection keeps the full hull through the lip row and mirrors
        // about the row under it (the record base).
        reflectY: Math.round(pose.y) - strip.anchorY - (pose.bob | 0),
        reflectHeight: strip.anchorY + 1,
    };
}

export function hullRecords(pose, out = []) {
    out.length = 0;
    const { strip } = pose;
    const g = hullGeometry(pose);
    const textureKey = `harbor-hull:${strip.liveryKey || strip.key || strip.spriteId}`;
    const common = {
        stableKey: pose.id,
        textureKey,
        source: strip.image,
        sourceWidth: strip.image.width,
        sourceHeight: strip.image.height,
        sx: g.sx,
        sy: 0,
        sw: strip.frameWidth,
        material: TIMBER,
        elevation: 0.34,
        emissive: 0,
        textureRevision: 0,
    };
    const wake = pose.wake ? wakeRecord(pose) : null;
    if (wake) out.push(wake);
    if (pose.reflect !== false) {
        out.push({
            ...common,
            id: `ground:reflect:hull:${pose.id}`,
            sh: g.reflectHeight,
            x: g.x,
            y: g.reflectY,
            width: g.width,
            height: g.reflectHeight,
            alpha: pose.alpha,
            occluder: 0,
            reflect: true,
            footY: -1,
        });
    }
    // The hull is a receiver with a vertical axis (V5): its waterline centre
    // (the roll pivot) and foot row, so a lamp beside it lights the lamp
    // side of the planking, with no owner slot (never an attention target).
    out.push({
        ...common,
        id: `harbor:hull:${pose.id}`,
        sh: g.height,
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
        alpha: pose.alpha,
        occluder: 0.4,
        writesDepth: pose.alpha >= 1,
        footY: Math.round(pose.y),
        frontCornerX: Math.round(pose.x),
        frontCornerY: -1,
        receiverAxis: true,
        // 5.3 — lit lamps: the sidecar is the record's emissive channel (same
        // source rect as the albedo), so they bloom and skip the grade like
        // a building's windows; its gate is the lamp strength (the record's
        // alpha already carries a hull's fade and hull-down sink). The
        // reflection twin above takes none.
        ...(pose.lamps ? {
            emissiveSource: pose.lamps.image,
            sidecarKey: pose.lamps.key,
            sidecarRevision: pose.lamps.key,
            emissiveGate: pose.lamps.strength,
        } : null),
    });
    return out;
}

// The world points a lit pose's lamps shine from: its lamp texels in its
// frame grouped into lamps (texels within 2 of each other), each lamp's
// centre, lowest first (the stern lantern or deck lamp before the masthead).
// Read back once per lamp image and frame; [] where pixels cannot be read
// (node) or the frame carries no lamp.
const _lampPoints = new WeakMap();
const NO_LAMPS = Object.freeze([]);

export function hullLampPoints(pose) {
    const lamps = pose?.lamps;
    if (!lamps?.image) return NO_LAMPS;
    let byFrame = _lampPoints.get(lamps.image);
    if (!byFrame) {
        byFrame = new Map();
        _lampPoints.set(lamps.image, byFrame);
    }
    const g = hullGeometry(pose);
    if (!byFrame.has(g.sx)) {
        const groups = [];
        const canvas = canvasOf(g.width, pose.strip.frameHeight);
        const ctx = canvas?.getContext('2d', { willReadFrequently: true });
        if (ctx) {
            ctx.drawImage(lamps.image, g.sx, 0, g.width, canvas.height, 0, 0, g.width, canvas.height);
            const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let y = 0; y < canvas.height; y++) {
                for (let x = 0; x < canvas.width; x++) {
                    if (px[(y * canvas.width + x) * 4 + 3] < 64) continue;
                    const group = groups.find(item => Math.abs(item.x / item.n - x) <= 2 && Math.abs(item.y / item.n - y) <= 2);
                    if (group) {
                        group.x += x; group.y += y; group.n += 1;
                    } else groups.push({ x, y, n: 1 });
                }
            }
        }
        byFrame.set(g.sx, groups
            .map(group => ({ x: group.x / group.n, y: group.y / group.n }))
            .sort((a, b) => b.y - a.y));
    }
    const local = byFrame.get(g.sx);
    if (!local.length) return NO_LAMPS;
    // The texels sit `sink` lower while the hull sinks (hullGeometry crops
    // rows, it does not move the texels it keeps); a sunk lamp is gone.
    const top = Math.round(pose.y) - pose.strip.anchorY - (pose.bob | 0) + (pose.sink | 0);
    const out = [];
    for (const point of local) {
        if (point.y >= g.height) continue;
        out.push({ x: g.x + point.x, y: top + point.y });
    }
    return out;
}

// Canvas: a lit pose's lamp texels on the ungraded overlay (world
// transform applied), the way EmitterCuts draws a building's lit panes.
export function drawHullLamps(ctx, pose, alpha = 1) {
    if (!pose?.lamps || !(alpha > 0.02)) return;
    const g = hullGeometry(pose);
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(pose.lamps.image, g.sx, 0, g.width, g.height, g.x, g.y, g.width, g.height);
}

// ─── V wake stamps ───────────────────────────────────────────────────────────

const _wakes = new Map();
const WAKE_HEADINGS = 32;

// One cached stamp canvas per (heading bucket, length, fresh span): the bow
// sits at the canvas centre.
function wakeStamp(dirX, dirY, length, hold = 0) {
    const angle = Math.atan2(dirY * 2, dirX);
    const bucket = ((Math.round(angle / (Math.PI * 2) * WAKE_HEADINGS) % WAKE_HEADINGS) + WAKE_HEADINGS) % WAKE_HEADINGS;
    const len = Math.max(8, Math.round(length / 4) * 4);
    const fresh = Math.max(0, Math.round(hold / 4) * 4);
    const key = `${bucket}|${len}|${fresh}`;
    const hit = _wakes.get(key);
    if (hit) return touch(_wakes, key, hit, WAKE_CACHE_LIMIT);
    const size = len * 2 + 4;
    const canvas = canvasOf(size, size);
    const ctx = canvas?.getContext('2d');
    if (!ctx) return null;
    const a = bucket / WAKE_HEADINGS * Math.PI * 2;
    wakeV(ctx, size / 2, size / 2, Math.cos(a), Math.sin(a) / 2, { length: len, hold: fresh, color: WAKE_FOAM, crest: WAKE_CREST, thick: 2 });
    const stamp = { canvas, half: size / 2, key: `harbor-wake:${key}` };
    return touch(_wakes, key, stamp, WAKE_CACHE_LIMIT);
}

function wakeRecord(pose) {
    const { wake, strip } = pose;
    const stamp = wakeStamp(wake.dirX, wake.dirY, wake.length, wake.hold);
    if (!stamp) return null;
    const bow = wakeBow(pose);
    const size = stamp.canvas.width;
    return {
        id: `ground:wake:${pose.id}`,
        stableKey: pose.id,
        textureKey: stamp.key,
        source: stamp.canvas,
        sourceWidth: size,
        sourceHeight: size,
        sx: 0,
        sy: 0,
        sw: size,
        sh: size,
        x: bow.x - stamp.half,
        y: bow.y - stamp.half,
        width: size,
        height: size,
        alpha: pose.alpha,
        material: FOAM_MATERIAL,
        elevation: 0,
        emissive: 0,
        occluder: 0,
        footY: -1,
        textureRevision: 0,
        strip,
    };
}

// The bow: 0.4 of the frame width ahead of the waterline pivot along the
// heading, on the waterline.
function wakeBow(pose) {
    const { wake, strip } = pose;
    const len = Math.hypot(wake.dirX, wake.dirY * 2) || 1;
    const reach = strip.frameWidth * 0.4;
    return {
        x: Math.round(pose.x + wake.dirX / len * reach),
        y: Math.round(pose.y + wake.dirY / len * reach),
    };
}

// ─── Canvas fallback ─────────────────────────────────────────────────────────

const _tint = { key: '', grade: null, cache: new Map() };

// Grade bucket for the ungraded overlay (null = draw the authored art).
function prepareTint(lightGrade) {
    if (!lightGrade?.gain || !lightGrade?.purkinje) {
        _tint.grade = null;
        return;
    }
    let key = '';
    for (const probe of GRADE_PROBES) {
        const out = applyGradeToRgb(probe, lightGrade);
        key += `${Math.round(out[0] * 32)},${Math.round(out[1] * 32)},${Math.round(out[2] * 32)};`;
    }
    _tint.grade = lightGrade;
    if (key === _tint.key) return;
    _tint.key = key;
    _tint.cache.clear();
}

function tinted(key, image) {
    const grade = _tint.grade;
    if (!grade) return image;
    const hit = _tint.cache.get(key);
    if (hit && hit.source === image) return hit.canvas;
    const canvas = canvasOf(image.width, image.height);
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx) return image;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    const memo = new Map();
    const rgb = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        const packed = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
        let out = memo.get(packed);
        if (out === undefined) {
            rgb[0] = px[i] / 255; rgb[1] = px[i + 1] / 255; rgb[2] = px[i + 2] / 255;
            const g = applyGradeToRgb(rgb, grade);
            out = (Math.round(g[0] * 255) << 16) | (Math.round(g[1] * 255) << 8) | Math.round(g[2] * 255);
            memo.set(packed, out);
        }
        px[i] = (out >> 16) & 255; px[i + 1] = (out >> 8) & 255; px[i + 2] = out & 255;
    }
    ctx.putImageData(data, 0, 0);
    _tint.cache.set(key, { source: image, canvas });
    return canvas;
}

const _reflections = new Map();

// The Canvas twin of the resident `reflect` record: the frame's rows through
// the lip, mirrored by row copy (no transform), every fifth row dropped,
// three alpha courses (ordered at their seams) and 38 % toward the water stop.
function reflectionCanvas(strip, frame) {
    const key = `${strip.liveryKey || strip.key || strip.spriteId}|${frame}`;
    const hit = _reflections.get(key);
    if (hit && hit.source === strip.image) return touch(_reflections, key, hit, LIVERY_CACHE_LIMIT).canvas;
    const w = strip.frameWidth;
    const h = strip.anchorY + 1;
    const canvas = canvasOf(w, h);
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(strip.image, ((strip.frameOffset || 0) + frame) * w, 0, w, h, 0, 0, w, h);
    const src = ctx.getImageData(0, 0, w, h);
    const out = ctx.createImageData(w, h);
    for (let r = 0; r < h; r++) {
        if (r % 5 === 4) continue;
        const sy = h - 1 - r;
        const course = r / h * 3;
        for (let x = 0; x < w; x++) {
            const si = (sy * w + x) * 4;
            if (src.data[si + 3] < 128) continue;
            const threshold = (BAYER4[(r & 3) * 4 + (x & 3)] + 0.5) / 16;
            const level = Math.min(2, Math.floor(course + threshold - 0.5));
            const di = (r * w + x) * 4;
            for (let c = 0; c < 3; c++) {
                out.data[di + c] = Math.round(src.data[si + c] + (REFLECTION_STOP[c] - src.data[si + c]) * REFLECTION_TOWARD_STOP);
            }
            out.data[di + 3] = Math.round(255 * REFLECTION_ALPHAS[Math.max(0, level)]);
        }
    }
    ctx.putImageData(out, 0, 0);
    touch(_reflections, key, { source: strip.image, canvas }, LIVERY_CACHE_LIMIT);
    return canvas;
}

// Draws the wake, the reflection and the hull of one pose with plain
// whole-pixel `drawImage` (no rotate, no scale).
export function drawHullFallback(ctx, pose, { ungradedOverlay = false, lightGrade = null } = {}) {
    const { strip } = pose;
    const g = hullGeometry(pose);
    prepareTint(ungradedOverlay ? lightGrade : null);
    ctx.save();
    ctx.globalAlpha = pose.alpha;
    if (pose.wake) {
        const stamp = wakeStamp(pose.wake.dirX, pose.wake.dirY, pose.wake.length, pose.wake.hold);
        if (stamp) {
            const bow = wakeBow(pose);
            ctx.drawImage(tinted(stamp.key, stamp.canvas), bow.x - stamp.half, bow.y - stamp.half);
        }
    }
    if (pose.reflect !== false) {
        const reflection = reflectionCanvas(strip, pose.frame);
        if (reflection) {
            ctx.drawImage(tinted(`${strip.liveryKey || strip.key || strip.spriteId}|r${pose.frame}`, reflection), g.x, g.reflectY + g.reflectHeight);
        }
    }
    const image = tinted(strip.liveryKey || strip.key || strip.spriteId, strip.image);
    ctx.drawImage(image, g.sx, 0, g.width, g.height, g.x, g.y, g.width, g.height);
    ctx.restore();
}
