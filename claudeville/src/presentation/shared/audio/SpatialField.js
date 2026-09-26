// One placement for every located discrete sound (plan S5, SIG-5).
//
// `place(target, { kind })` turns where a sound comes from into how it is
// heard: a pan, a direct-path gain and low-pass, and an Island Air send. The
// listener is the camera centre. `target` is a screen point
// `{ screenX, screenY, viewportW, viewportH }` (pixels, or viewport-normalized
// 0..1 when the viewport size is omitted) or `{ building }`, which always
// places on the fixed island map (Dashboard has no camera to project with).
// Discrete sounds are placed once, at schedule time; nothing here runs per
// frame.
//
// Signal cues (needs-you, error, rate limit) are about the listener, not the
// world: no distance gain, no distance low-pass, |pan| ≤ 0.3, air ≤ 0.12.
//
// `resolveCueSpot` is the one reader of the renderer: it finds the target
// for an agent cue from the event payload, the live sprite, or a cached
// position, and is called by both directors when a cue is raised.

import { BUILDING_DEFS, normalizeBuildingType } from '../../../config/buildings.js';
import { MAP_SIZE, TILE_WIDTH } from '../../../config/constants.js';

const WORLD_PAN_LIMIT = 0.75;
const SIGNAL_PAN_LIMIT = 0.3;
const PAN_PER_OFFSET = 0.85;
// Iso vertical compression: a screen-height step reads farther than a width step.
const DEPTH_WEIGHT = 1.3;
// Direct gain: 1 inside NEAR_DISTANCE, then (NEAR/d)^1.2, never below the floor
// (off-screen stays faintly present: peripheral, not hidden).
const NEAR_DISTANCE = 0.6;
const GAIN_EXPONENT = 1.2;
const GAIN_FLOOR = 0.12;
// Direct low-pass: 9 kHz·2^(−1.6·(d − 0.5)) beyond d = 0.5, floor 900 Hz.
const LOWPASS_KNEE = 0.5;
const LOWPASS_TOP_HZ = 9000;
const LOWPASS_OCTAVES_PER_UNIT = 1.6;
const LOWPASS_FLOOR_HZ = 900;
// Air send: 0.12 + 0.30·clamp01((d − 0.5)/2).
const AIR_BASE = 0.12;
const AIR_SPAN = 0.3;
export const SIGNAL_AIR_MAX = 0.12;
// SIG-5 step 6: a building on the island map sends this much (rs 0.18).
const MAP_AIR = 0.18;

const TILE_SPAN = Math.max(1, MAP_SIZE - 1);
const WORLD_SCREEN_X_HALF_SPAN = TILE_SPAN * (TILE_WIDTH / 2);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clamp01 = value => clamp(value, 0, 1);
const finite = value => (value == null || value === '' ? NaN : Number(value));
const round3 = value => Math.round(value * 1000) / 1000;

// SIG-5 step 6: each building's side of the island (tile x − y is the iso
// screen axis) × 1.2, scaled so the widest building sits at the pan limit
// (the portal at −0.83 → −0.75). Fixed: Dashboard places stop moving but
// keep their side.
function buildIslandMap() {
    const raw = BUILDING_DEFS.map(def => {
        const centreX = def.x + def.width / 2;
        const centreY = def.y + def.height / 2;
        return [def.type, ((centreX - centreY) / TILE_SPAN) * 1.2];
    });
    const widest = Math.max(...raw.map(([, pan]) => Math.abs(pan)));
    const scale = widest > WORLD_PAN_LIMIT ? WORLD_PAN_LIMIT / widest : 1;
    return Object.freeze(Object.fromEntries(raw.map(([type, pan]) => [type, round3(pan * scale)])));
}

export const ISLAND_MAP = buildIslandMap();

// Viewport-normalized offset from the listener: dx, dy ∈ [−1, 1] on screen,
// beyond it off-screen. No screenY means "on the listener's row".
function screenOffset(target) {
    const x = finite(target?.screenX);
    if (!Number.isFinite(x)) return null;
    const width = finite(target.viewportW);
    const height = finite(target.viewportH);
    const w = Number.isFinite(width) && width > 0 ? width : 1;
    const h = Number.isFinite(height) && height > 0 ? height : 1;
    const y = finite(target.screenY);
    return {
        dx: (x - w / 2) / (w / 2),
        dy: Number.isFinite(y) ? (y - h / 2) / (h / 2) : 0,
    };
}

export function distanceGain(distance) {
    if (!(distance > NEAR_DISTANCE)) return 1;
    return Math.max(GAIN_FLOOR, Math.pow(NEAR_DISTANCE / distance, GAIN_EXPONENT));
}

// Null inside the knee: a near voice keeps its own tone and needs no node.
export function distanceLowpassHz(distance) {
    if (!(distance > LOWPASS_KNEE)) return null;
    return Math.max(
        LOWPASS_FLOOR_HZ,
        LOWPASS_TOP_HZ * Math.pow(2, -LOWPASS_OCTAVES_PER_UNIT * (distance - LOWPASS_KNEE)),
    );
}

export function distanceAir(distance) {
    return AIR_BASE + AIR_SPAN * clamp01((Math.max(0, distance) - LOWPASS_KNEE) / 2);
}

/**
 * Where a sound sits. `kind` 'signal' keeps it dry, central and at full
 * level; 'world' carries distance. `dashboard` places on the island map only
 * (a screen point there has no camera behind it and falls to the centre).
 * Returns `{ pan, gain, lowpassHz, air, distance }`; `gain` and `lowpassHz`
 * belong to the direct path, `air` is the send at the voice's level.
 */
export function place(target = null, { kind = 'world', dashboard = false } = {}) {
    const signal = kind === 'signal';
    const building = normalizeBuildingType(target?.building);
    const onMap = Boolean(building) || dashboard;
    let pan = 0;
    let distance = 0;
    if (onMap) {
        pan = ISLAND_MAP[building] ?? 0;
    } else {
        const offset = screenOffset(target);
        if (offset) {
            pan = clamp(PAN_PER_OFFSET * offset.dx, -WORLD_PAN_LIMIT, WORLD_PAN_LIMIT);
            distance = Math.hypot(offset.dx, DEPTH_WEIGHT * offset.dy);
        }
    }
    if (signal) {
        return {
            pan: pan * (SIGNAL_PAN_LIMIT / WORLD_PAN_LIMIT),
            gain: 1,
            lowpassHz: null,
            air: SIGNAL_AIR_MAX,
            distance,
        };
    }
    return {
        pan,
        gain: distanceGain(distance),
        lowpassHz: distanceLowpassHz(distance),
        air: onMap ? MAP_AIR : distanceAir(distance),
        distance,
    };
}

// ---------------------------------------------------------------------------
// Cue targets. Everything below reads payloads and the live renderer; the
// placement above stays pure.

// A payload value is viewport-normalized when it lies in 0..1; otherwise it
// is pixels over the width beside it. Off-screen values are kept (they carry
// distance).
function normalizedScreenValue(value, size = 0) {
    const n = finite(value);
    if (!Number.isFinite(n)) return null;
    if (n >= 0 && n <= 1) return n;
    const span = finite(size);
    if (Number.isFinite(span) && span > 1) return n / span;
    return null;
}

function normalizedWorldX(worldX) {
    const x = finite(worldX);
    if (!Number.isFinite(x)) return null;
    return clamp01((x + WORLD_SCREEN_X_HALF_SPAN) / (WORLD_SCREEN_X_HALF_SPAN * 2));
}

function normalizedTileX(position) {
    if (!position || typeof position !== 'object') return null;
    const tileX = finite(position.tileX ?? position.x);
    const tileY = finite(position.tileY ?? position.y);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return clamp01((tileX - tileY + TILE_SPAN) / (TILE_SPAN * 2));
}

const normalizedSpot = (screenX, screenY = null) => (screenX == null ? null : {
    screenX,
    ...(screenY == null ? {} : { screenY }),
    viewportW: 1,
    viewportH: 1,
});

/** A screen point the payload states itself (normalized), or null. */
export function explicitSpot(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const width = payload.viewportWidth || payload.screenWidth;
    const height = payload.viewportHeight || payload.screenHeight;
    const agent = payload.agent;
    const candidates = [
        [payload.screenX, width, payload.screenY, height],
        [payload.normalizedScreenX, 0, payload.normalizedScreenY, 0],
        [payload.screenPosition?.x, payload.screenPosition?.width || width,
            payload.screenPosition?.y, payload.screenPosition?.height || height],
        [agent?.screenX, agent?.viewportWidth || width, agent?.screenY, agent?.viewportHeight || height],
        [agent?.normalizedScreenX, 0, agent?.normalizedScreenY, 0],
        [agent?.position?.screenX, agent?.position?.viewportWidth || width,
            agent?.position?.screenY, agent?.position?.viewportHeight || height],
        [payload.position?.screenX, payload.position?.viewportWidth || width,
            payload.position?.screenY, payload.position?.viewportHeight || height],
    ];
    for (const [x, w, y, h] of candidates) {
        const nx = normalizedScreenValue(x, w);
        if (nx != null) return normalizedSpot(nx, normalizedScreenValue(y, h));
    }
    return null;
}

/** The building an agent or payload is at (the Dashboard map key), or null. */
export function buildingOf(subject) {
    if (!subject || typeof subject !== 'object') return null;
    return normalizeBuildingType(
        subject.building
        ?? subject.buildingType
        ?? subject.lastKnownBuildingType
        ?? subject.agent?.building
        ?? subject.agent?.lastKnownBuildingType,
    );
}

function currentApp() {
    return globalThis.window?.__claudeVilleApp ?? null;
}

// The live sprite through the camera, in pixels (off-screen kept).
function rendererSpot(renderer, agentId) {
    if (agentId == null || !renderer) return null;
    const sprite = renderer.agentSprites?.get?.(agentId);
    const camera = renderer.camera;
    if (!sprite || !camera?.worldToScreen) return null;
    const x = finite(sprite.x);
    const y = finite(sprite.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const screen = camera.worldToScreen(x, y);
    const viewportW = camera._viewportWidth?.() || renderer.canvas?.clientWidth || renderer.canvas?.width;
    const viewportH = camera._viewportHeight?.() || renderer.canvas?.clientHeight || renderer.canvas?.height;
    if (!(viewportW > 0) || !(viewportH > 0)) return null;
    if (!Number.isFinite(screen?.x) || !Number.isFinite(screen?.y)) return null;
    return { screenX: screen.x, screenY: screen.y, viewportW, viewportH };
}

/**
 * The place() target for a cue about `agentId`: in World the stated screen
 * point, the live sprite, the world x, a tile, then the remembered agent; in
 * Dashboard the agent's building on the island map. Null when unknown (the
 * cue sounds from the centre). `dashboard` defaults to the app's mode.
 */
export function resolveCueSpot(payload, {
    agentId = null,
    dashboard = currentApp()?.modeManager?.getCurrentMode?.() === 'dashboard',
    world = null,
    remembered = null,
    renderer = currentApp()?.renderer ?? null,
} = {}) {
    const agent = agentId != null ? world?.agents?.get?.(agentId) ?? null : null;
    if (dashboard) {
        const building = buildingOf(payload) ?? remembered?.building ?? buildingOf(agent);
        return building ? { building } : null;
    }
    return explicitSpot(payload)
        ?? rendererSpot(renderer, agentId)
        ?? normalizedSpot(normalizedWorldX(payload?.worldX ?? payload?.agent?.worldX ?? payload?.center?.x))
        ?? normalizedSpot(normalizedTileX(payload?.agent?.position || payload?.position || payload?.lastTile))
        ?? remembered?.spot
        ?? normalizedSpot(normalizedTileX(remembered?.position))
        ?? explicitSpot(agent)
        ?? normalizedSpot(normalizedTileX(agent?.position))
        ?? null;
}
