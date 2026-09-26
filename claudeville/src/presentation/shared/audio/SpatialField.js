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
// Continuous emitters (workshops, the harbor and the coast: plan 5.8, D8)
// follow the camera instead: on `atmosphere:updated` (~2 Hz) the director
// takes a `cameraSnapshot`, and `placeFromCamera` / `placeCoastFromCamera`
// turn it into the same `{ pan, lowpassHz, gain, air }` for a persistent
// chain. They are pure and rounded, so a still camera returns identical
// values (`samePlacement`) and the caller writes nothing.
//
// Signal cues (needs-you, error, rate limit) are about the listener, not the
// world: no distance gain, no distance low-pass, |pan| ≤ 0.3, air ≤ 0.12.
//
// `resolveCueSpot` is the one reader of the renderer: it finds the target
// for an agent cue from the event payload, the live sprite, or a cached
// position, and is called by both directors when a cue is raised.

import { BUILDING_DEFS, normalizeBuildingType } from '../../../config/buildings.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../../config/constants.js';

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
// Camera placement of continuous emitters (5.8). The listener is the camera
// centre, raised above the ground by a height that shrinks as the camera
// zooms in: the survey shot hears the whole island from above (every
// emitter a little soft and wet), and zoomed in on a building its voice is
// present and dry while the far ones soften.

// Largest pan move per update: a camera cut glides across the field.
export const CAMERA_PAN_STEP = 0.2;
// A moving camera's pan aims a quarter of an update ahead (extrapolated from
// the previous update's aim), so the ~2 Hz sampling and τ 0.25 s do not
// leave the pan trailing a crossing by a whole update. A still camera leads
// nothing; a stop costs one correction of at most a quarter of the last move.
const PAN_LEAD = 0.25;
// A persistent chain's low-pass needs a number: this is "open".
export const OPEN_LOWPASS_HZ = 16000;
// Listener height at tier 1 (viewport-normalized), divided by the tier.
const LISTENER_HEIGHT = 0.35;
const TIER_RANGE = [0.25, 4];
// The shore surrounds the listener and the surf carries: its distance counts
// half, its direct path never falls more than 6 dB, nor its low-pass below
// the foam band's floor.
const COAST_REACH = 2;
const COAST_GAIN_FLOOR = 0.5;
const COAST_LOWPASS_FLOOR_HZ = 2000;
// Shore samples along the map's edge (per side), and how steeply the near
// ones outweigh the far in the coast's pan (distance gain cubed: from inside
// a convex shore a plain average would lean away from the nearest beach).
const COAST_SAMPLES_PER_SIDE = 16;
const COAST_PAN_WEIGHT_POWER = 3;

const HALF_W = TILE_WIDTH / 2;
const HALF_H = TILE_HEIGHT / 2;
const tileToWorld = (tileX, tileY) => ({ x: (tileX - tileY) * HALF_W, y: (tileX + tileY) * HALF_H });

/** Building centres in world pixels (the renderer's projection of the island map). */
export const BUILDING_WORLD = Object.freeze(Object.fromEntries(BUILDING_DEFS.map(def => [
    def.type,
    Object.freeze(tileToWorld(def.x + def.width / 2, def.y + def.height / 2)),
])));

// The map's edge, where the surf is drawn: a diamond of tile corners.
const COAST_POINTS = (() => {
    const max = TILE_SPAN;
    const corners = [[0, 0], [max, 0], [max, max], [0, max]].map(([x, y]) => tileToWorld(x, y));
    const points = [];
    for (let side = 0; side < 4; side++) {
        const a = corners[side];
        const b = corners[(side + 1) % 4];
        for (let k = 0; k < COAST_SAMPLES_PER_SIDE; k++) {
            const f = (k + 0.5) / COAST_SAMPLES_PER_SIDE;
            points.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
        }
    }
    return Object.freeze(points);
})();

/**
 * The camera as the listener, read once per update from a live `Camera`:
 * `{ x, y, zoom, viewportW, viewportH, unitZoom }`. The idle drift is left
 * out (its base pose is used), so a resting camera is a still listener.
 * Null when the camera has no size yet.
 */
export function cameraSnapshot(camera) {
    if (!camera) return null;
    const drift = camera._idleDrift;
    const snapshot = {
        x: finite(drift?.baseX ?? camera.x),
        y: finite(drift?.baseY ?? camera.y),
        zoom: finite(camera.zoom),
        viewportW: finite(typeof camera._viewportWidth === 'function' ? camera._viewportWidth() : camera.viewportW),
        viewportH: finite(typeof camera._viewportHeight === 'function' ? camera._viewportHeight() : camera.viewportH),
        unitZoom: finite(camera._displayPixelZoomScale ?? camera.unitZoom ?? 1),
    };
    return cameraView(snapshot) ? snapshot : null;
}

// Centre (world px), half extents (world px) and tier of a camera snapshot.
function cameraView(camera) {
    if (!camera) return null;
    const zoom = finite(camera.zoom);
    const w = finite(camera.viewportW);
    const h = finite(camera.viewportH);
    const x = finite(camera.x);
    const y = finite(camera.y);
    if (!(zoom > 0) || !(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const unit = finite(camera.unitZoom);
    const tier = clamp(zoom / (unit > 0 ? unit : 1), TIER_RANGE[0], TIER_RANGE[1]);
    return {
        cx: w / (2 * zoom) - x,
        cy: h / (2 * zoom) - y,
        halfW: w / (2 * zoom),
        halfH: h / (2 * zoom),
        height: LISTENER_HEIGHT / tier,
    };
}

function worldPoint(worldPos) {
    const building = typeof worldPos === 'string' ? worldPos : worldPos?.building;
    if (building != null) return BUILDING_WORLD[normalizeBuildingType(building)] ?? null;
    const x = finite(worldPos?.x);
    const y = finite(worldPos?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

// The screen offset of a world point and its distance from the raised listener.
function viewOffset(point, view) {
    const dx = (point.x - view.cx) / view.halfW;
    const dy = (point.y - view.cy) / view.halfH;
    return { dx, distance: Math.hypot(dx, DEPTH_WEIGHT * dy, view.height) };
}

// distanceLowpassHz, continuous for a persistent filter: it keeps rising
// inside the knee up to "open" instead of switching the filter out.
export function cameraLowpassHz(distance) {
    return clamp(
        LOWPASS_TOP_HZ * Math.pow(2, -LOWPASS_OCTAVES_PER_UNIT * (Math.max(0, distance) - LOWPASS_KNEE)),
        LOWPASS_FLOOR_HZ,
        OPEN_LOWPASS_HZ,
    );
}

// Rounded, the pan led by the camera's motion and moved at most
// CAMERA_PAN_STEP from the previous one. `aim` is the unled, unstepped pan:
// the next update's lead reads it.
function settle({ pan, lowpassHz, gain, air }, previous) {
    const aim = round3(pan) + 0;
    const prevAim = finite(previous?.aim);
    const led = Number.isFinite(prevAim) ? aim + PAN_LEAD * (aim - prevAim) : aim;
    const prev = finite(previous?.pan);
    const stepped = Number.isFinite(prev)
        ? prev + clamp(led - prev, -CAMERA_PAN_STEP, CAMERA_PAN_STEP)
        : led;
    return {
        pan: round3(clamp(stepped, -WORLD_PAN_LIMIT, WORLD_PAN_LIMIT)) + 0,
        lowpassHz: Math.round(lowpassHz),
        gain: round3(gain),
        air: round3(air),
        aim,
    };
}

/**
 * Where a continuous emitter sits for this camera: `worldPos` is a building
 * id, `{ building }` or a world-pixel `{ x, y }`; `camera` a `cameraSnapshot`.
 * Pass the emitter's last placement as `previous` (it bounds the pan step
 * and carries the lead). Returns `{ pan, lowpassHz, gain, air, aim }`
 * (direct gain and low-pass, air send at the voice's level; `aim` is
 * bookkeeping, not a parameter), or null when either is unknown.
 */
export function placeFromCamera(worldPos, camera, previous = null) {
    const point = worldPoint(worldPos);
    const view = cameraView(camera);
    if (!point || !view) return null;
    const { dx, distance } = viewOffset(point, view);
    return settle({
        pan: clamp(PAN_PER_OFFSET * dx, -WORLD_PAN_LIMIT, WORLD_PAN_LIMIT),
        lowpassHz: cameraLowpassHz(distance),
        gain: distanceGain(distance),
        air: distanceAir(distance),
    }, previous);
}

/**
 * The shore around the island for this camera. Each sample of the map's
 * edge weighs in by its distance gain: the pan leans toward the near shore
 * (centred when the whole coast is in view), and the nearest sample, at
 * half its distance, sets the brightness, level (never below −6 dB) and air.
 */
export function placeCoastFromCamera(camera, previous = null) {
    const view = cameraView(camera);
    if (!view) return null;
    let weights = 0;
    let panSum = 0;
    let nearest = Infinity;
    for (const point of COAST_POINTS) {
        const { dx, distance } = viewOffset(point, view);
        const w = Math.pow(distanceGain(distance), COAST_PAN_WEIGHT_POWER);
        weights += w;
        panSum += w * clamp(PAN_PER_OFFSET * dx, -WORLD_PAN_LIMIT, WORLD_PAN_LIMIT);
        nearest = Math.min(nearest, distance / COAST_REACH);
    }
    return settle({
        pan: panSum / weights,
        lowpassHz: Math.max(COAST_LOWPASS_FLOOR_HZ, cameraLowpassHz(nearest)),
        gain: COAST_GAIN_FLOOR + (1 - COAST_GAIN_FLOOR) * distanceGain(nearest),
        air: distanceAir(nearest),
    }, previous);
}

/** A continuous emitter on the fixed island map (Dashboard: no camera). */
export function mapPlacement(building) {
    return {
        pan: ISLAND_MAP[normalizeBuildingType(building)] ?? 0,
        lowpassHz: OPEN_LOWPASS_HZ,
        gain: 1,
        air: MAP_AIR,
    };
}

/** True when two placements would write the same parameters. */
export function samePlacement(a, b) {
    if (!a || !b) return a === b;
    return a.pan === b.pan && a.lowpassHz === b.lowpassHz && a.gain === b.gain && a.air === b.air;
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
