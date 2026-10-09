import { VILLAGE_GATE, VILLAGE_GATE_GEOMETRY } from '../../config/townPlan.js';

const SUPPORTED_KINDS = new Set(['point', 'beam', 'spark', 'arc', 'orbit']);
// V5 — what a light is in the 2.5D model, beside its drawing `kind`: an omni
// `point` (effects, motes), a facade `aperture` (window or door, emitting into
// its face's half-space), a free-standing `fixture` (lantern, brazier, lamp)
// and an action-needed `attention` light (its owner's ground and body only).
const SUPPORTED_ROLES = new Set(['point', 'aperture', 'fixture', 'attention']);

function finitePoint(point) {
    if (Array.isArray(point)) {
        return Number.isFinite(point[0]) && Number.isFinite(point[1]) ? { x: point[0], y: point[1] } : null;
    }
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
}

function faceNormal(normal) {
    if (!Array.isArray(normal) || normal.length < 2) return null;
    const nx = Number(normal[0]);
    const ng = Number(normal[1]);
    const length = Math.hypot(nx, ng);
    return Number.isFinite(length) && length > 1e-6 ? [nx / length, ng / length] : null;
}

/**
 * The one light record (V5). `{ x, y }` is the emitter in world px (what
 * screen-space consumers draw at); `ground { x, y }` is its foot on the ground
 * plane and `height` the emitter's world px above that foot, so the resident
 * loop, Canvas pool stamps, wet reflections and lamp casts all measure from the
 * foot, never the emitter's screen position. `normal [nx, ng]` is a facade
 * aperture's ground-plane face normal (ng on the iso depth axis) or null for
 * an omni light; `ownerId` names the agent an attention light belongs to;
 * `landmarkId` (GPU_LANDMARK_IDS) the building a light is mounted on, so the
 * footprint march never shadows a light with its own building. `kind` keeps
 * its drawing meaning for its readers. 2.9: every aperture and fixture lays
 * a broken column on the water in front of its foot; `columnReach` scales
 * that column's length (the Lighthouse lamp: 1.2) and `waterOnly` marks a
 * light that lights nothing but that column (the lamp high on its tower,
 * whose column starts at its mirror point, `height` below the foot).
 */
export function normalizeLightSource(source = {}, defaults = {}) {
    const kind = SUPPORTED_KINDS.has(source.kind) ? source.kind : 'point';
    const origin = source.origin || (
        Number.isFinite(source.x) && Number.isFinite(source.y)
            ? { x: source.x, y: source.y }
            : null
    );
    const priority = Number(source.priority);
    const defaultPriority = Number(defaults.priority);
    const x = origin?.x ?? source.x;
    const y = origin?.y ?? source.y;
    const ground = finitePoint(source.ground) || (Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null);
    const height = Number(source.height);
    const role = SUPPORTED_ROLES.has(source.role)
        ? source.role
        : SUPPORTED_ROLES.has(defaults.role) ? defaults.role : 'point';
    const landmarkId = Number(source.landmarkId ?? defaults.landmarkId);
    return {
        id: source.id || defaults.id || `${defaults.buildingType || 'light'}:${kind}:${Math.round(origin?.x || 0)},${Math.round(origin?.y || 0)}`,
        kind,
        role,
        origin,
        x,
        y,
        ground,
        height: Number.isFinite(height) && height > 0 ? height : 0,
        normal: faceNormal(source.normal),
        ownerId: source.ownerId ?? defaults.ownerId ?? null,
        landmarkId: Number.isFinite(landmarkId) && landmarkId > 0 ? Math.round(landmarkId) : 0,
        fire: source.fire === true,
        // 2.6 — the fire a flame light belongs to: every light of one fire
        // (the Forge door light and its hearth spill) breathes on one beat.
        fireGroup: source.fireGroup
            || (source.fire === true && (source.buildingType || defaults.buildingType)
                ? `fire:${source.buildingType || defaults.buildingType}`
                : null),
        waterOnly: source.waterOnly === true,
        columnReach: Number.isFinite(source.columnReach) && source.columnReach > 0 ? source.columnReach : 1,
        endpoints: Array.isArray(source.endpoints) ? source.endpoints : undefined,
        controlPoint: source.controlPoint,
        parent: source.parent,
        color: source.color || defaults.color || '#ffcc66',
        radius: Number.isFinite(source.radius) ? source.radius : defaults.radius || 64,
        length: source.length,
        width: source.width,
        alpha: Number.isFinite(source.alpha) ? source.alpha : defaults.alpha,
        priority: Number.isFinite(priority)
            ? priority
            : Number.isFinite(defaultPriority) ? defaultPriority : 0,
        ttl: source.ttl ?? null,
        createdAt: source.createdAt,
        buildingType: source.buildingType || defaults.buildingType || null,
        building: source.building || defaults.building || null,
        intensity: Number.isFinite(source.intensity) ? source.intensity : defaults.intensity ?? 1,
        overlay: source.overlay || defaults.overlay || null,
    };
}

// V5 — a light's height above the ground in SCENE_FRAGMENT's ground course
// (a receiver on the ground under a raised lamp): height counts only beyond
// LIGHT_HEIGHT_BAND world px, and below a facade aperture (a window or door
// on a wall: role `aperture` with a face normal) at APERTURE_SPILL (2.4: a
// window's light spills down its own face to the street). The Canvas pool
// stamps and the hybrid pools step their ground course on it.
export const LIGHT_HEIGHT_BAND = 24;
export const APERTURE_SPILL = 0.35;
export function groundCourseHeight(light) {
    const band = Math.max(0, (Number(light?.height) || 0) - LIGHT_HEIGHT_BAND);
    const n = Array.isArray(light?.normal) ? light.normal : null;
    const facade = light?.role === 'aperture' && n && (Number(n[0]) || 0) ** 2 + (Number(n[1]) || 0) ** 2 > 0.25;
    return facade ? band * APERTURE_SPILL : band;
}

// 2.5 — V9's integer owner slot for an agent id: records and attention lights
// compare this integer (instance loc5.x), never a float hash, which would
// collide beyond 2^24. Slots are stable for the page's life; 0 means none.
const OWNER_SLOTS = new Map();
let nextOwnerSlot = 1;

export function ownerSlotFor(ownerId) {
    if (ownerId == null || ownerId === '') return 0;
    const key = String(ownerId);
    let slot = OWNER_SLOTS.get(key);
    if (slot) return slot;
    if (nextOwnerSlot > 65535) {
        OWNER_SLOTS.clear();
        nextOwnerSlot = 1;
    }
    slot = nextOwnerSlot++;
    OWNER_SLOTS.set(key, slot);
    return slot;
}

export function lightSourceCacheKey(source, phaseBucket = 'fallback') {
    return [
        source.id || '',
        source.kind || 'point',
        Math.round(source.x ?? source.origin?.x ?? 0),
        Math.round(source.y ?? source.origin?.y ?? 0),
        Math.round(source.radius || 0),
        source.color || '',
        phaseBucket,
    ].join('|');
}

// 2.6 — fire breathes in stepped quanta, never a continuous sine: each fire
// holds one of three intensity steps for a 140 ms beat, picked by a hash of
// (beat, fire key) on the one motion clock. Pass a light's `fireGroup` (else
// its id), so the lights of one fire share one step and their overlap still
// takes three states. `depth` scales the step (fireBreathDepth): a large pool
// breathes shallower, so the Forge door pool and the walls it reaches shift
// a few levels per beat instead of swinging a whole block. Windows, lamps and
// attention lights never call this; reduced motion holds 1.
export const FIRE_BREATH_QUANTA = Object.freeze([0.86, 0.94, 1.0]);
export const FIRE_BREATH_BEAT_MS = 140;
// Pools up to this ground radius (world px) breathe the full quanta; a wider
// pool breathes in proportion, never under FIRE_BREATH_MIN_DEPTH.
const FIRE_BREATH_FULL_RADIUS = 34;
const FIRE_BREATH_MIN_DEPTH = 0.4;
const FIRE_ID_HASHES = new Map();

function fireIdHash(id) {
    const key = String(id ?? '');
    let hash = FIRE_ID_HASHES.get(key);
    if (hash !== undefined) return hash;
    hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    hash >>>= 0;
    if (FIRE_ID_HASHES.size >= 512) FIRE_ID_HASHES.clear();
    FIRE_ID_HASHES.set(key, hash);
    return hash;
}

export function fireBreathDepth(radius) {
    const r = Number(radius);
    if (!(r > FIRE_BREATH_FULL_RADIUS)) return 1;
    return Math.max(FIRE_BREATH_MIN_DEPTH, FIRE_BREATH_FULL_RADIUS / r);
}

export function fireBreath(motionTimeMs, sourceId, motionScale = 1, depth = 1) {
    if (!(Number(motionScale) > 0)) return 1;
    const beat = Math.floor(Math.max(0, Number(motionTimeMs) || 0) / FIRE_BREATH_BEAT_MS);
    let h = Math.imul(fireIdHash(sourceId) ^ Math.imul(beat, 0x9e3779b1), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return 1 - (1 - FIRE_BREATH_QUANTA[(h >>> 0) % 3]) * Math.min(1, Math.max(0, Number(depth) || 0));
}

// W6.9 (AW-P12) — honest warmth for an empty town. Hearth lights stand only
// in non-work structures — the gatehouse guard rooms' lit glass (the
// `lit: true` tower window, VILLAGE_GATE_GEOMETRY.towerWindows) and the lake
// shrine's candle — and on the `lamps` clock gate alone, like the Command
// braziers and the Lighthouse lens: they never read occupancy, so the nine
// work buildings keep the midnight-oil rule (one lit room per working
// occupant). The tone is warmer and dimmer than glass and never breathes.
// The renderer adds the dressing fires it owns (the midsummer bonfire, the
// W7.8 ledger lamp) through `extra`.
export const HEARTH_TONE = '#ff9248';
const HEARTH_RADIUS = 30;
const HEARTH_INTENSITY = 0.46;

function gatehouseHearths() {
    const glass = VILLAGE_GATE_GEOMETRY.towerWindows.find((win) => win.lit);
    if (!glass) return [];
    const r = VILLAGE_GATE_GEOMETRY.towerR;
    const height = Math.round((glass.z0 + glass.z1) / 2);
    return VILLAGE_GATE_GEOMETRY.towerX.map((towerX, side) => Object.freeze({
        id: `hearth.gatehouse.${side ? 'east' : 'west'}`,
        site: 'gatehouse',
        tileX: VILLAGE_GATE.tileX + towerX + Math.cos(glass.angle) * r,
        tileY: VILLAGE_GATE.tileY + Math.sin(glass.angle) * r,
        height,
        intensity: HEARTH_INTENSITY,
    }));
}

export const HEARTH_FIXTURES = Object.freeze([
    ...gatehouseHearths(),
    // The shrine's candle on its low altar (scenery.js prop.lakeShrine).
    Object.freeze({ id: 'hearth.lakeShrine', site: 'lakeShrine', tileX: 6.9, tileY: 27.3, height: 9, intensity: 0.36, radius: 22 }),
]);

/**
 * The hearth fixtures as V5 light records while the village lamps are lit
 * (`lampsLit`, BuildingSprite.lampsLitAt), else none. `core` is the source
 * energy bucket's core (AtmosphereState.sourceEnergyFor), so a hearth spends
 * inside the lamplight / deep-night buckets like every other fixture.
 * `extra` rows `{ id, tileX, tileY, height, intensity?, radius?, color?,
 * fire? }` join on the same gate. No argument carries agent state.
 */
export function hearthLightSources({ lampsLit = false, core = 1, extra = [], fixtures = HEARTH_FIXTURES } = {}) {
    if (!lampsLit) return [];
    const out = [];
    for (const row of [...fixtures, ...extra]) {
        if (!Number.isFinite(row?.tileX) || !Number.isFinite(row?.tileY)) continue;
        const foot = { x: (row.tileX - row.tileY) * 32, y: (row.tileX + row.tileY) * 16 };
        const height = Math.max(0, Number(row.height) || 0);
        out.push(normalizeLightSource({
            id: row.id,
            kind: 'point',
            role: 'fixture',
            x: foot.x,
            y: foot.y - height,
            ground: foot,
            height,
            fire: row.fire === true,
            color: row.color || HEARTH_TONE,
            radius: row.radius || HEARTH_RADIUS,
            intensity: (Number(row.intensity) || HEARTH_INTENSITY) * core,
        }));
    }
    return out;
}
