// MS-2 (look `ms2`) — lamps glow in the mist. A lit lamp (street lamp,
// brazier, bridge candle, lit door or window, carried lantern) whose flame
// stands below the resident low mist's top (MS-1, GpuFrameState.mistTopAt,
// the CPU twin of the shaders' top), or stands anywhere in fog weather's
// foggy air (MIST_HALO.air), gets a small halo in the air round its
// flame: three Bayer-dithered courses of its own colour (the ship lamps' halo
// vocabulary, HarborTraffic `_drawLampHalo`: glow in the pixel grid, never a
// wash) as a scene record at the lamp's own painter position, so whatever
// stands nearer the camera covers it (a building, tree, rail or villager in
// front), its colour carried as the record's emission (ungraded, into bloom,
// like a lantern's glass), tight (MIST_HALO.radius world px,
// growing with how deep in the mist the flame stands), its strength the
// look x the flame's own intensity (its stepped fire breath, no flicker of
// its own) x the dusk envelope's core and halo shares (AtmosphereState
// sourceEnergyFor: the halo spends the budget that already rations cores,
// spill and bloom). It adds no light: pools, walls and villagers are lit as
// before. Attention lights (a waiting villager's candle, the bell) and the
// Lighthouse (its own breathing halo and beam) take none, so the bell stays
// the brightest thing in a foggy night frame. Resident GPU paths only (the
// mist runs there); Canvas keeps today's frame (declared lower tier).
import { mistTopAt } from './gpu/GpuFrameState.js';
import { sourceEnergyFor } from './AtmosphereState.js';
import { lookStrength } from './LookStrengths.js';
import { materialClassId } from './gpu/GpuWorldPolicy.js';

export const MIST_HALO = Object.freeze({
    // Outer radius (world px) at a flame just under the top / one deep in it.
    radius: Object.freeze([10, 18]),
    // How deep (world px) below the top a flame stands for the full radius.
    depthFull: 24,
    // Course edges as shares of the radius, and the Bayer share (of 16) of
    // the texels each course lights: half, a quarter, an eighth.
    courses: Object.freeze([0.4, 0.7, 1]),
    texels: Object.freeze([8, 4, 2]),
    // Peak alpha of a lit texel at full look, a steady flame, deep night
    // (r2: with the flame head excluded, no halo texel reaches the bell's
    // luma 207: scene-target max 199–204 at zoom 1–3).
    alpha: 0.6,
    // The flame's own head (world px round its point) takes no halo texel.
    core: 3.5,
    // The dusk envelope's core must have reached the lamplight bucket.
    minCore: 0.4,
    // Fog weather fills the air at every height (MS-1's layer is the low
    // mist the town rises out of; the fog itself is the overlay's veil): a
    // flame above the layer still glows in a fog of `airFog` (the weather's
    // fog from `air[0]` to `air[1]`), at `airShare` of a deep flame's glow.
    air: Object.freeze([0.3, 0.7]),
    airShare: 0.6,
    // At most this many halos a frame (nearest the lamps' list order:
    // fixtures first, carried lanterns last, as the light feed ranks them).
    cap: 64,
});

const BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

function clamp01(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

/** Whether a light may glow in the mist: a flame (lamps, braziers, candles,
 * carried lanterns; a facade aperture only when it is fire, a lit door),
 * never an attention light, the Lighthouse, a water-only column, a beam, a
 * spark (spill and motes) or a lit pane or board. */
export function mistHaloEligible(light) {
    if (!light || light.attention || light.role === 'attention' || light.waterOnly) return false;
    if (light.kind === 'beam' || light.kind === 'spark' || light.buildingType === 'watchtower') return false;
    // r2 — a carried lantern's light sits on its carrier's foot, 14 px up,
    // not on the lantern stamp: a halo there would stipple the robe.
    if (String(light.id || '').startsWith('carried-lantern:')) return false;
    if (light.role === 'aperture' && !light.fire) return false;
    return Number.isFinite(light.x) && Number.isFinite(light.y);
}

/** How foggy the air itself is (fog weather only): 0..1 from the weather. */
export function mistHaloAirFog(weather) {
    if (weather?.type !== 'fog') return 0;
    return clamp01(((Number(weather.fog) || 0) - MIST_HALO.air[0]) / (MIST_HALO.air[1] - MIST_HALO.air[0]));
}

/**
 * The halo a light takes, or null: `top` the mist's top over its ground
 * point, `look` ms2, `energy` the envelope ({ core, halo }), `airFog` the
 * fog weather's air (mistHaloAirFog). A flame inside the low mist glows by
 * how deep it stands; above it, only in fog weather. Pure.
 */
export function mistHaloFor(light, top, look, energy, airFog = 0) {
    if (!(look > 0) || !mistHaloEligible(light)) return null;
    const core = clamp01(energy?.core);
    if (core < MIST_HALO.minCore) return null;
    const depth = top - (Number(light.height) || 0);
    const deep = Math.max(depth > 0 ? clamp01(depth / MIST_HALO.depthFull) : 0, MIST_HALO.airShare * clamp01(airFog));
    if (!(deep > 0)) return null;
    const radius = Math.round(MIST_HALO.radius[0] + (MIST_HALO.radius[1] - MIST_HALO.radius[0]) * deep);
    const alpha = MIST_HALO.alpha * clamp01(look) * Math.min(1, Number(light.intensity) || 0) * core
        * clamp01(energy?.halo ?? 1) * (0.5 + 0.5 * deep);
    // Stepped down to eighths (never past the cap), so a breathing flame
    // steps with its own quanta.
    const stepped = Math.floor(alpha * 8) / 8;
    return stepped > 0 ? { radius, alpha: stepped } : null;
}

// The nearness to water (1 water, 0 two tiles inland) at a world point from
// the coast bake's resident fields (CoastBake waterFields), the shaders' rule.
function nearAt(fields, x, y) {
    if (!fields?.coastField || !(fields.cols > 0)) return 0;
    const col = Math.floor((x - fields.x) * 0.5);
    const row = Math.floor((y - fields.y) * 0.5);
    if (col < 0 || row < 0 || col >= fields.cols || row >= fields.rows) return 1;
    const sd = (fields.coastField[(row * fields.cols + col) * 2] - 128) / 64;
    return clamp01((sd + 2) * 0.5);
}

const _stamps = new Map();

// One halo stamp per (radius, colour): the three courses' texels, dithered
// on the stamp's own grid (anchored to the lamp, so it holds still with it).
function haloStamp(radius, color) {
    const key = `${radius}|${color}`;
    let stamp = _stamps.get(key);
    if (stamp) return stamp;
    const size = radius * 2 + 1;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const d = Math.hypot(dx, dy) / radius;
            // r2 — clear of the flame itself (a lamp head is up to ~4 px):
            // the halo is the air round it, never more light on its core.
            if (d * radius < MIST_HALO.core || d > 1) continue;
            const course = d <= MIST_HALO.courses[0] ? 0 : d <= MIST_HALO.courses[1] ? 1 : 2;
            const x = dx + radius;
            const y = dy + radius;
            if (BAYER4[((y & 3) << 2) | (x & 3)] >= MIST_HALO.texels[course]) continue;
            ctx.fillRect(x, y, 1, 1);
        }
    }
    stamp = { canvas, radius };
    if (_stamps.size > 96) _stamps.clear();
    _stamps.set(key, stamp);
    return stamp;
}

// The halo's own emission (the scene shader's record `emissive`, times the
// core share there): the stamp's colour lands mostly as light, ungraded, like
// a lantern's glass, so the record reads as the overlay stamp did.
// r2: 2.0 (was 2.2, whose halo texels on the flame head reached luma
// 236–247; the head is now excluded, MIST_HALO.core).
export const MIST_HALO_EMISSIVE = 2.0;

/**
 * The frame's mist halos as V9 scene records (resident GPU paths), each at
 * its lamp's painter position: `depthSortY` the lamp's ground line, inserted
 * into the painter-ordered records by `insertMistHaloRecords`, so every
 * drawable nearer the camera (a building, tree, rail or villager in front)
 * paints over it, exactly as it would over a sprite standing there. Needs
 * the resident mist on (renderer.gpuWorld.mist) and ms2. `out` is reused.
 */
export function mistHaloRecords(renderer, atmosphere, out = []) {
    out.length = 0;
    const look = lookStrength('ms2');
    const mist = renderer?.gpuWorld?.mist;
    if (!(look > 0) || !mist || !(mist[0] > 0) || !(mist[3] > 0)) return out;
    const lights = renderer._frameLightSources?.ambient;
    if (!lights?.length || typeof document === 'undefined') return out;
    const burn = renderer.gpuWorld.mistBurn || [1, 1];
    const energy = sourceEnergyFor(atmosphere?.lighting);
    const fields = renderer._coastBake?.waterFields || null;
    const airFog = mistHaloAirFog(atmosphere?.weather);
    const pool = renderer._mistHaloRecordPool || (renderer._mistHaloRecordPool = []);
    for (const light of lights) {
        if (out.length >= MIST_HALO.cap) break;
        if (!mistHaloEligible(light)) continue;
        const ground = light.ground || { x: light.x, y: light.y };
        const top = mistTopAt(ground, nearAt(fields, ground.x, ground.y), mist, burn);
        const halo = mistHaloFor(light, top, look, energy, airFog);
        if (!halo) continue;
        const color = light.color || '#ffcc66';
        const stamp = haloStamp(halo.radius, color);
        const record = pool[out.length] || (pool[out.length] = {
            sx: 0, sy: 0, occluder: 0, emissiveGate: 1, elevation: 0.3,
            sourceKind: 'individual', pageable: false, writesDepth: false,
        });
        record.id = `mist-halo:${out.length}`;
        record.stableKey = record.id;
        record.textureKey = `mist-halo:${halo.radius}|${color}`;
        record.textureRevision = record.textureKey;
        record.source = stamp.canvas;
        record.sourceWidth = record.sw = record.width = stamp.canvas.width;
        record.sourceHeight = record.sh = record.height = stamp.canvas.height;
        record.x = Math.round(light.x) - halo.radius;
        record.y = Math.round(light.y) - halo.radius;
        record.alpha = halo.alpha;
        record.emissive = MIST_HALO_EMISSIVE;
        record.material = materialClassId('default');
        // The lamp's own painter line: its foot (an upright receiver there).
        record.depthSortY = Math.round(ground.y);
        record.footY = Math.round(ground.y);
        out.push(record);
    }
    return out;
}

/**
 * Insert `halos` into the painter-ordered `records`: each before the first
 * record whose painter line (`depthSortY`) lies nearer the camera than its
 * lamp's. Records without a painter line (terrain, ground, casts, cues) stay
 * under it. One merge pass; returns `records`.
 */
export function insertMistHaloRecords(records, halos) {
    if (!Array.isArray(records) || !halos?.length) return records;
    const sorted = halos.slice().sort((a, b) => a.depthSortY - b.depthSortY);
    const merged = [];
    let h = 0;
    for (const record of records) {
        const line = record?.depthSortY;
        if (line != null && Number.isFinite(line)) {
            while (h < sorted.length && sorted[h].depthSortY < line) merged.push(sorted[h++]);
        }
        merged.push(record);
    }
    while (h < sorted.length) merged.push(sorted[h++]);
    records.length = 0;
    for (const record of merged) records.push(record);
    return records;
}
