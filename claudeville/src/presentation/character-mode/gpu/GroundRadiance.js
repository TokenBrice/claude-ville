// 2.10 (LGI-8, M6 pilot) — ground-plane radiance cascades and one warm bounce.
//
// A 2D radiance-cascade solve on the world ground plane (never the iso screen:
// flatland RC on the screen treats every facade as a wall between a window
// and its own street). The plane is the island in iso ground space (world x,
// world y doubled, so a tile is a square and distances match the resident
// light loop), covered by the 2.2 footprint field's rect:
//
//   scene     RADIANCE_CELL (8) ground units per texel, 352 x 384 RGBA16F:
//             rgb = emitted radiance per ground unit, a = the openings' share
//             (luma), a < 0 = opaque: the footprint field's buildings and
//             tall props (2.2); water neither emits nor blocks. Emitted = one
//             bounce, the ground's ungraded albedo (the terrain bake) x the
//             irradiance the light loop's own ground falloff lays there
//             (every standing aperture and fixture on the island, with 2.2's
//             march), plus each ground-level opening (2.4 blob span) lit at
//             the back of a slot cut into its wall, so it leaves as a fan.
//   cascades  4 cascades over probes every RADIANCE_PROBE (16) ground units,
//             4 rays at cascade 0 (x4 per cascade, a 2^(i+1) square block per
//             probe, so every cascade texture is 352 x 384 RGBA16F), intervals
//             RADIANCE_BASE_INTERVAL x (4^i - 1) / 3 (x4 per cascade), merged
//             top-down with Osborne & Sannikov's bilinear fix: each ray of
//             cascade i is cast to each of the 4 bilinear cascade-(i+1) probes'
//             own interval start and merged with that probe's children, then
//             weighted, so light never leaks round a wall between probes.
//   result    3 panels of the 176 x 192 cascade-0 probes, RGBA16F, filtered:
//             [ fluence (mean of 4 rays) | light arriving from the SW | from
//             the SE ]. Ground receivers read the openings' fans at their
//             foot; a landmark wall reads the bounce in the ray bin its face
//             looks along, just in front of its foot (the 4 cascade-0 rays
//             point exactly along the two visible face normals).
//
// The resident scene pass samples it on V9 unit 15 (RADIANCE_SCENE_GLSL) and
// lands at most course 1 where no direct light lays a course (see the scene
// shader). Solved only when the light state changes (quantized, de-flickered
// emitters; footprint, terrain or coast revision), at most every
// RADIANCE_MIN_SOLVE_MS, so the field never animates.

import { footprintFieldRect } from '../FootprintField.js';
import { fireBreath, fireBreathDepth } from '../LightSourceRegistry.js';
import { LIGHT_ROLE_CODES } from './GpuWorldPolicy.js';

export const RADIANCE_CELL = 8;
export const RADIANCE_PROBE = 16;
export const RADIANCE_CASCADES = 4;
export const RADIANCE_BASE_RAYS = 4;
export const RADIANCE_BASE_INTERVAL = 8;
// 4 Hz: a gate that opens re-lights the bounce within a quarter second.
export const RADIANCE_MIN_SOLVE_MS = 250;
export const RADIANCE_MAX_EMITTERS = 256;
const RADIANCE_EMITTER_ROWS = 4;
// Field heights above this (world px) are opaque on the plane.
const RADIANCE_OCCLUDER_HEIGHT = 8;
// Radiance lost per ground unit travelled: the flatland 1/r falloff alone
// carries a lit plaza's bounce across half the village.
export const RADIANCE_EXTINCTION = 1 / 80;
// Emitted radiance per ground unit: the bounce (albedo x irradiance) and a
// ground-level opening (colour x intensity).
export const RADIANCE_BOUNCE_GAIN = 1;
export const RADIANCE_APERTURE_GAIN = 1;
// The opening's slot: how deep it is cut into its wall (ground units); the
// back cell emits, so the light leaves through the span as a fan.
const RADIANCE_APERTURE_DEPTH = 40;
// Only an opening this low on its wall (world px: a door, the Forge arch, a
// ground-floor spill) lays a fan; an upper window's light reaches the street
// through the direct loop's spill, never from its wall base.
const RADIANCE_OPENING_HEIGHT = 24;
// Albedo where no terrain bake is resident.
const RADIANCE_DEFAULT_ALBEDO = [0.3, 0.28, 0.24];
// Quantization of the emitter key (intensity steps per unit).
const KEY_INTENSITY_STEPS = 32;
// 2.4's registry clearance: a registry aperture takes the span of the blob it
// stands in for.
const APERTURE_SPAN_REACH = 30;

/** The solve's grid in ground units (world x, world y x 2) over the footprint rect. */
export function radianceGrid(rect = footprintFieldRect()) {
    const worldW = rect.width * rect.cell;
    const worldH = rect.height * rect.cell;
    const block = RADIANCE_PROBE << (RADIANCE_CASCADES - 1);
    const probesX = Math.ceil(worldW / block) * (block / RADIANCE_PROBE);
    const probesY = Math.ceil((worldH * 2) / block) * (block / RADIANCE_PROBE);
    return Object.freeze({
        originX: rect.originX,
        originY: rect.originY * 2,
        probesX,
        probesY,
        sceneW: probesX * (RADIANCE_PROBE / RADIANCE_CELL),
        sceneH: probesY * (RADIANCE_PROBE / RADIANCE_CELL),
        cascadeW: probesX * 2,
        cascadeH: probesY * 2,
    });
}

const GRID = radianceGrid();
const HALF_BYTES = 8;
/** Resident bytes of the pilot's GL resources (scene, 2 cascades, result, emitters). */
export const RADIANCE_BYTES = GRID.sceneW * GRID.sceneH * HALF_BYTES
    + 2 * GRID.cascadeW * GRID.cascadeH * HALF_BYTES
    + 3 * GRID.probesX * GRID.probesY * HALF_BYTES
    + RADIANCE_MAX_EMITTERS * RADIANCE_EMITTER_ROWS * 16;

function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

const COLOR_CACHE = new Map();
function hexRgb(color) {
    const key = String(color || '#ffcc66');
    let rgb = COLOR_CACHE.get(key);
    if (rgb) return rgb;
    rgb = [1, 0.8, 0.4];
    if (/^#[0-9a-f]{6}$/i.test(key)) rgb = [1, 3, 5].map(at => parseInt(key.slice(at, at + 2), 16) / 255);
    else {
        const match = key.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (match) rgb = [+match[1] / 255, +match[2] / 255, +match[3] / 255];
    }
    if (COLOR_CACHE.size >= 128) COLOR_CACHE.clear();
    COLOR_CACHE.set(key, rgb);
    return rgb;
}

const SPANS = new WeakMap();
/**
 * Every landmark emitter blob (2.4 `ApertureLights.templates`) placed in the
 * world: `[{ building, x, y, span }]`, `span` its width in world px. Registry
 * apertures stand within 30 px of the blob they light, so both kinds find
 * their opening here. Cached per template revision.
 */
export function radianceApertureSpans(buildingRenderer) {
    const lights = buildingRenderer?.apertureLights;
    const buildings = buildingRenderer?.buildings;
    if (!lights || !Array.isArray(buildings)) return null;
    const key = `${lights.revision}|${buildings.length}`;
    const cached = SPANS.get(buildingRenderer);
    if (cached?.key === key) return cached.spans;
    const spans = [];
    for (const building of buildings) {
        const templates = lights.templates(building.type);
        if (!templates?.length) continue;
        const anchor = buildingRenderer.assets?.getAnchor?.(`building.${building.type}`);
        const centre = buildingRenderer._buildingScreenCenter?.(building);
        if (!anchor || !centre) continue;
        for (const template of templates) {
            spans.push({
                building,
                x: centre.x - anchor[0] + template.cx,
                y: centre.y - anchor[1] + template.cy,
                span: template.x1 - template.x0 + 1,
            });
        }
    }
    SPANS.set(buildingRenderer, { key, spans });
    return spans;
}

function apertureSpan(light, spans) {
    if (!spans || !light.building) return 0;
    const x = finite(light.x ?? light.origin?.x, NaN);
    const y = finite(light.y ?? light.origin?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let best = 0;
    let bestD = APERTURE_SPAN_REACH;
    for (const entry of spans) {
        if (entry.building !== light.building) continue;
        const d = Math.hypot(entry.x - x, entry.y - y);
        if (d < bestD) {
            bestD = d;
            best = entry.span;
        }
    }
    return best;
}

function isAttention(light) {
    return Boolean(light?.attention) || light?.role === 'attention' || String(light?.id || '').startsWith('attention:');
}

/**
 * CPU: the solve's emitter records from the renderer's island-wide light list
 * (`_frameLightSources.ambient`, before any viewport cull, so a pan never
 * changes the field): the standing lights only, V5 apertures (windows,
 * doors, the Forge and Archive spills) and fixtures (lanterns, braziers,
 * lamps). Omni `point` lights (ritual sparks, motes, arrival columns) move
 * with the agents and would re-solve the field every quarter
 * second; attention lights (2.5) never light a neighbour; the water-only
 * Lighthouse column lights nothing on land. Each keeps its fire breath
 * divided out (2.6: the bounce holds still) and its intensity x the
 * envelope's spill share. Writes the RGBA32F block `out` (256 x 4 texels,
 * rows: foot x, foot y, radius, intensity / height, nx, ng, role / rgb,
 * aperture half-span in ground units / landmark id) and returns
 * `{ count, key }`, `key` a hash of the quantized state (0 = no emitters).
 */
export function buildRadianceEmitters({ sources = null, spans = null, motionTimeMs = 0, motionScale = 1 } = {}, spill = 1, out) {
    const rowStride = RADIANCE_MAX_EMITTERS * 4;
    let count = 0;
    let key = 2166136261;
    const mix = (value) => {
        key = Math.imul(key ^ (value | 0), 16777619);
    };
    for (const light of sources || []) {
        if (count >= RADIANCE_MAX_EMITTERS) break;
        if (!light || isAttention(light) || light.waterOnly === true) continue;
        if (light.role !== 'aperture' && light.role !== 'fixture') continue;
        const footX = finite(light.ground?.x, finite(light.x, NaN));
        const footY = finite(light.ground?.y, finite(light.y, NaN));
        if (!Number.isFinite(footX) || !Number.isFinite(footY)) continue;
        let intensity = Math.max(0, finite(light.intensity, 1));
        if (light.fire) {
            const breath = fireBreath(motionTimeMs, light.fireGroup || light.id, motionScale, fireBreathDepth(light.radius));
            if (breath > 0) intensity /= breath;
        }
        intensity = Math.round(Math.min(3, intensity * Math.max(0, spill)) * KEY_INTENSITY_STEPS) / KEY_INTENSITY_STEPS;
        if (intensity <= 0) continue;
        const radius = Math.max(1, Math.round(finite(light.radius, 64)));
        const height = Math.max(0, Math.round(finite(light.height, 0)));
        const normal = Array.isArray(light.normal) ? light.normal : null;
        const role = LIGHT_ROLE_CODES[light.role] ?? LIGHT_ROLE_CODES.point;
        const rgb = hexRgb(light.color);
        const facade = role === LIGHT_ROLE_CODES.aperture && normal;
        // A world-x span along the face is span x sqrt(2) ground units; a
        // slot is never narrower than 1.5 cells, so a small door still cuts one.
        const span = facade && height <= RADIANCE_OPENING_HEIGHT ? apertureSpan(light, spans) : 0;
        const halfSpan = span > 0 ? Math.max(span * Math.SQRT1_2, RADIANCE_CELL * 0.75) : 0;
        const offset = count * 4;
        out[offset] = Math.round(footX);
        out[offset + 1] = Math.round(footY);
        out[offset + 2] = radius;
        out[offset + 3] = intensity;
        out[rowStride + offset] = height;
        out[rowStride + offset + 1] = normal ? finite(normal[0]) : 0;
        out[rowStride + offset + 2] = normal ? finite(normal[1]) : 0;
        out[rowStride + offset + 3] = role;
        out[2 * rowStride + offset] = rgb[0];
        out[2 * rowStride + offset + 1] = rgb[1];
        out[2 * rowStride + offset + 2] = rgb[2];
        out[2 * rowStride + offset + 3] = halfSpan;
        out[3 * rowStride + offset] = Math.max(0, Math.round(finite(light.landmarkId, 0)));
        out[3 * rowStride + offset + 1] = 0;
        out[3 * rowStride + offset + 2] = 0;
        out[3 * rowStride + offset + 3] = 0;
        mix(out[offset]);
        mix(out[offset + 1]);
        mix(radius);
        mix(intensity * KEY_INTENSITY_STEPS);
        mix(height);
        mix(role);
        mix(Math.round(halfSpan));
        mix((rgb[0] * 255) << 16 | (rgb[1] * 255) << 8 | rgb[2] * 255);
        mix(normal ? Math.round(finite(normal[0]) * 8) + 16 : 0);
        count++;
    }
    return { count, key: count > 0 ? (key >>> 0) || 1 : 0 };
}

const PASS_VERTEX = `#version 300 es
void main() {
    vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

function emitFragment(apertureSpill) {
    return `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_emitters;
uniform int u_emitterCount;
uniform sampler2D u_footprint;
uniform vec3 u_footprintRect;
uniform ivec2 u_footprintSize;
uniform sampler2D u_terrain;
uniform vec4 u_terrainRect;
uniform sampler2D u_coast;
uniform vec4 u_coastRect;
uniform vec3 u_grid;
uniform vec2 u_emit;
out vec4 outColor;

float fieldAt(vec2 world, out uint landmark) {
    landmark = 0u;
    ivec2 cell = ivec2(floor((world - u_footprintRect.xy) / u_footprintRect.z));
    if (u_footprintRect.z <= 0.0 || any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, u_footprintSize))) return 0.0;
    vec2 field = texelFetch(u_footprint, cell, 0).rg;
    landmark = uint(field.g * 255.0 + 0.5);
    return field.r * 255.0;
}

// 2.2's march from a ground point (height 0) to a light's foot.
float blockedFrom(vec2 from, vec2 to, float toH, uint lightLandmark, bool fixture) {
    for (int s = 1; s <= 8; s++) {
        float t = float(s) / 9.0;
        vec2 p = mix(from, to, t);
        if (fixture && distance(p, to) < 10.0) continue;
        uint landmark;
        float h = fieldAt(p, landmark);
        if (landmark != 0u && landmark == lightLandmark) continue;
        if (h > toH * t + 2.0) return 1.0;
    }
    return 0.0;
}

vec3 albedoAt(vec2 world) {
    if (u_terrainRect.z <= 0.0) return vec3(${RADIANCE_DEFAULT_ALBEDO.map(v => v.toFixed(3)).join(', ')});
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        vec2 at = world + vec2(float(i & 1) * 4.0 - 2.0, float(i >> 1) * 2.0 - 1.0);
        vec4 texel = texture(u_terrain, (at - u_terrainRect.xy) / u_terrainRect.zw);
        sum += texel.rgb * texel.a;
    }
    return sum * 0.25;
}

void main() {
    vec2 ground = u_grid.xy + (floor(gl_FragCoord.xy) + 0.5) * u_grid.z;
    vec2 world = vec2(ground.x, ground.y * 0.5);
    // Water takes no pool and bounces nothing; light crosses it.
    if (u_coastRect.z > 0.0) {
        ivec2 cell = ivec2(floor((world - u_coastRect.xy) * 0.5));
        if (all(greaterThanEqual(cell, ivec2(0))) && cell.x < int(u_coastRect.z) && cell.y < int(u_coastRect.w)
            && texelFetch(u_coast, cell, 0).r * 255.0 > 128.5) {
            outColor = vec4(0.0);
            return;
        }
    }
    uint own;
    bool solid = fieldAt(world, own) > ${RADIANCE_OCCLUDER_HEIGHT.toFixed(1)};
    bool slot = false;
    vec3 irradiance = vec3(0.0);
    vec3 opening = vec3(0.0);
    for (int i = 0; i < ${RADIANCE_MAX_EMITTERS}; i++) {
        if (i >= u_emitterCount) break;
        vec4 light = texelFetch(u_emitters, ivec2(i, 0), 0);
        vec4 shape = texelFetch(u_emitters, ivec2(i, 1), 0);
        float lightH = shape.x;
        float role = shape.w;
        bool facade = role > 0.5 && role < 1.5 && dot(shape.yz, shape.yz) > 0.25;
        vec2 toGround = vec2(world.x - light.x, (world.y - light.y) * 2.0);
        // The resident loop's ground falloff (V5, 2.4 spill and lobe).
        float spill = facade ? ${apertureSpill.toFixed(2)} : 1.0;
        float lampBand = max(0.0, lightH - 24.0) * spill;
        float reach = sqrt(light.z * light.z + lampBand * lampBand);
        vec4 color = texelFetch(u_emitters, ivec2(i, 2), 0);
        if (facade && color.w > 0.0) {
            // 2.4 — a ground-level opening, recessed: a slot of its own span
            // cut RADIANCE_APERTURE_DEPTH into its wall, lit at the back. The
            // jambs stay opaque, so the light leaves as a fan in front of the
            // face, never along the wall.
            float out_ = dot(toGround, shape.yz);
            float along = abs(dot(toGround, vec2(shape.z, -shape.y)));
            if (out_ < 0.0 && out_ >= -${RADIANCE_APERTURE_DEPTH.toFixed(1)} && along <= color.w) {
                slot = true;
                if (out_ < ${(RADIANCE_CELL - RADIANCE_APERTURE_DEPTH).toFixed(1)}) opening += color.rgb * light.w;
            }
        }
        if (solid) continue;
        float falloffD = length(vec3(toGround, lampBand));
        if (falloffD >= reach) continue;
        float falloff = 1.0 - smoothstep(0.0, reach, falloffD);
        if (facade) falloff *= clamp(0.30 + 1.4 * dot(shape.yz, toGround) / max(length(toGround), 1.0), 0.0, 1.0);
        vec4 meta = texelFetch(u_emitters, ivec2(i, 3), 0);
        float blocked = blockedFrom(world, light.xy, lightH, uint(meta.x + 0.5), role > 1.5 && role < 2.5);
        irradiance += color.rgb * light.w * falloff * (1.0 - blocked * 0.92);
    }
    // Opaque: a < 0 (the fan channel is never negative).
    if (solid && !slot) {
        outColor = vec4(0.0, 0.0, 0.0, -1.0);
        return;
    }
    // rgb: everything this cell emits (bounce + opening); a: the opening's
    // luma alone, so the ground can read the fans and a wall the bounce.
    vec3 fan = opening * u_emit.y;
    vec3 bounce = solid ? vec3(0.0) : albedoAt(world) * irradiance * u_emit.x;
    outColor = vec4(bounce + fan, dot(fan, vec3(0.2126, 0.7152, 0.0722)));
}`;
}

const CASCADE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_scene;
uniform highp sampler2D u_upper;
uniform int u_cascade;
uniform bool u_hasUpper;
uniform ivec2 u_probes;
// cell, probe spacing, base interval, extinction (ground units)
uniform vec4 u_march;
out vec4 outColor;
const float TAU = 6.28318530718;

// Radiance gathered from 'from' to 'to' (ground units from the grid origin)
// through the emitting plane (rgb everything, a the openings' fans alone),
// and in 'transmit' what is left of the light beyond (0 once an opaque
// texel is hit). Cascades 2 and 3 step two cells at a time.
vec4 march(vec2 from, vec2 to, out float transmit) {
    ivec2 size = textureSize(u_scene, 0);
    vec2 delta = to - from;
    float len = length(delta);
    float stepLen = u_march.x * (u_cascade >= 2 ? 2.0 : 1.0);
    int steps = max(1, int(ceil(len / stepLen)));
    float ds = len / float(steps);
    float keep = exp(-u_march.w * ds);
    vec4 radiance = vec4(0.0);
    transmit = 1.0;
    for (int s = 0; s < 64; s++) {
        if (s >= steps) break;
        vec2 p = from + delta * ((float(s) + 0.5) / float(steps));
        ivec2 cell = ivec2(floor(p / u_march.x));
        if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, size))) {
            transmit *= keep;
            continue;
        }
        vec4 texel = texelFetch(u_scene, cell, 0);
        if (texel.a < -0.5) {
            transmit = 0.0;
            return radiance;
        }
        radiance += transmit * texel * ds;
        transmit *= keep;
    }
    return radiance;
}

void main() {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    int block = 2 << u_cascade;
    ivec2 probe = texel / block;
    ivec2 inBlock = texel - probe * block;
    int ray = inBlock.y * block + inBlock.x;
    int rays = block * block;
    float spacing = u_march.y * float(1 << u_cascade);
    vec2 centre = (vec2(probe) + 0.5) * spacing;
    float fourI = float(1 << (2 * u_cascade));
    float t0 = u_march.z * (fourI - 1.0) / 3.0;
    float t1 = u_march.z * (fourI * 4.0 - 1.0) / 3.0;
    float transmit;
    if (!u_hasUpper) {
        float angle = (float(ray) + 0.5) * TAU / float(rays);
        vec2 dir = vec2(cos(angle), sin(angle));
        outColor = march(centre + dir * t0, centre + dir * t1, transmit);
        return;
    }
    // Bilinear fix: one ray to each of the 4 upper probes around this one,
    // merged with that probe's own 4 child rays, then weighted.
    int upperBlock = block * 2;
    int upperRays = rays * 4;
    float upperSpacing = spacing * 2.0;
    ivec2 upperProbes = u_probes >> (u_cascade + 1);
    vec2 at = centre / upperSpacing - 0.5;
    ivec2 base = ivec2(floor(at));
    vec2 f = at - vec2(base);
    vec4 sum = vec4(0.0);
    for (int q = 0; q < 4; q++) {
        ivec2 corner = ivec2(q & 1, q >> 1);
        ivec2 upper = clamp(base + corner, ivec2(0), upperProbes - 1);
        float weight = (corner.x == 1 ? f.x : 1.0 - f.x) * (corner.y == 1 ? f.y : 1.0 - f.y);
        if (weight <= 0.0) continue;
        vec2 upperCentre = (vec2(upper) + 0.5) * upperSpacing;
        vec4 merged = vec4(0.0);
        for (int c = 0; c < 4; c++) {
            int child = ray * 4 + c;
            float angle = (float(child) + 0.5) * TAU / float(upperRays);
            vec2 dir = vec2(cos(angle), sin(angle));
            vec4 hit = march(centre + dir * t0, upperCentre + dir * t1, transmit);
            merged += hit + transmit * texelFetch(u_upper, upper * upperBlock + ivec2(child % upperBlock, child / upperBlock), 0);
        }
        sum += weight * merged * 0.25;
    }
    outColor = sum;
}`;

const RESOLVE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_cascade0;
uniform ivec2 u_probes;
out vec4 outColor;
void main() {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    int panel = texel.x / u_probes.x;
    ivec2 base = ivec2(texel.x - panel * u_probes.x, texel.y) * 2;
    // Cascade-0 rays (ground space, y down the screen): 0 at 45 deg looks
    // SE, 1 at 135 deg SW, 2 NW, 3 NE. A ray looking SW gathers the light
    // arriving from the SW: what a SW-facing (left) wall receives.
    vec4 se = texelFetch(u_cascade0, base, 0);
    vec4 sw = texelFetch(u_cascade0, base + ivec2(1, 0), 0);
    vec4 nw = texelFetch(u_cascade0, base + ivec2(0, 1), 0);
    vec4 ne = texelFetch(u_cascade0, base + ivec2(1, 1), 0);
    outColor = panel == 0 ? (se + sw + nw + ne) * 0.25 : (panel == 1 ? sw : se);
}`;

// Display (SCENE_FRAGMENT): a receiver's raw value — on the ground the fans'
// luma x RADIANCE_FAN_GAIN plus the bounce's x RADIANCE_GROUND_GAIN, on a
// wall the bounce's x RADIANCE_WALL_GAIN — is steepened round course 1's
// threshold (0.12) by RADIANCE_CONTRAST, so a slow field still turns over in
// a narrow ordered dither band instead of a wide stipple, and capped under
// course 2's (0.40 minus the dither's 0.04). A wall's shape is then faded
// out over its first RADIANCE_WALL_REACH world px, capped first, so a strong
// bounce still lays its one course at the wall base only. The course adds
// the field's hue x its strength (x poolWeight(1)) to the pools, and a pixel
// lit by it alone lands with RADIANCE_LAND of the pools' warm C1 landing.
export const RADIANCE_FAN_GAIN = 0.8;
// The ground's own bounce is shown only by override: at any gain that reads
// it merges neighbouring pools into wider discs (killed: bigger pool radii).
export const RADIANCE_GROUND_GAIN = 0;
export const RADIANCE_WALL_GAIN = 0.1;
export const RADIANCE_GROUND_STRENGTH = 0.5;
export const RADIANCE_WALL_STRENGTH = 0.5;
export const RADIANCE_CONTRAST = 8;
export const RADIANCE_WALL_REACH = 32;
export const RADIANCE_LAND = 0.45;
// A wall reads the field this far in front of its foot (ground units).
export const RADIANCE_WALL_OFFSET = 14;

/**
 * The scene pass's reader (SCENE_FRAGMENT, unit 15). `u_radianceGrid` =
 * (ground origin x, y, probe spacing, 1 = a solved field is bound);
 * `radianceAt(world, panel)`: panel 0 the fluence, 1 the light arriving from
 * the SW, 2 from the SE; rgb everything (bounce + openings), a the openings'
 * fans alone (luma).
 */
export const RADIANCE_SCENE_GLSL = `
uniform sampler2D u_radiance;
uniform vec4 u_radianceGrid;
// fan gain, ground bounce gain, wall gain; course strength ground, wall
uniform vec4 u_radianceGain;
uniform vec2 u_radianceStrength;
const float RADIANCE_LAND = ${RADIANCE_LAND.toFixed(2)};
vec4 radianceAt(vec2 world, int panel) {
    vec2 size = vec2(${GRID.probesX}.0, ${GRID.probesY}.0);
    vec2 p = clamp((vec2(world.x, world.y * 2.0) - u_radianceGrid.xy) / u_radianceGrid.z, vec2(0.5), size - 0.5);
    return texture(u_radiance, vec2((float(panel) * size.x + p.x) / (size.x * 3.0), p.y / size.y));
}
// The shape a receiver's course is stepped on (0 = none) and the light it
// adds (hue x strength): a ground point reads the fans and the bounce at its
// foot, a wall (face normal in ground space) the bounce arriving along its
// normal.
float radianceShape(vec2 foot, vec2 normal, float height, bool wall, out vec3 light) {
    int panel = wall ? (normal.x < 0.0 ? 1 : 2) : 0;
    vec2 at = wall ? foot + vec2(normal.x, normal.y * 0.5) * ${RADIANCE_WALL_OFFSET.toFixed(1)} : foot;
    vec4 field = radianceAt(at, panel);
    float fieldY = dot(field.rgb, vec3(0.2126, 0.7152, 0.0722));
    float bounceY = max(0.0, fieldY - field.a);
    float raw = wall ? bounceY * u_radianceGain.z : field.a * u_radianceGain.x + bounceY * u_radianceGain.y;
    float shape = min(0.12 + (raw - 0.12) * ${RADIANCE_CONTRAST.toFixed(1)}, 0.355);
    if (wall) shape *= clamp(1.0 - height / ${RADIANCE_WALL_REACH.toFixed(1)}, 0.0, 1.0);
    light = field.rgb / max(fieldY, 1e-4) * (wall ? u_radianceStrength.y : u_radianceStrength.x);
    return shape;
}
`;

/**
 * GL owner of the solve. `supported` needs EXT_color_buffer_float (RGBA16F
 * targets). Resources are created on the first solve and released whenever
 * the effect is off (`release`), so a shed level keeps no bytes.
 */
export class GroundRadiance {
    constructor(gl, { createProgram, unit, apertureSpill = 0.35 } = {}) {
        this.gl = gl;
        this.unit = unit;
        this.createProgram = createProgram;
        this.apertureSpill = apertureSpill;
        this.supported = Boolean(gl?.getExtension?.('EXT_color_buffer_float'));
        this.grid = GRID;
        this.tuning = {
            extinction: RADIANCE_EXTINCTION,
            bounceGain: RADIANCE_BOUNCE_GAIN,
            apertureGain: RADIANCE_APERTURE_GAIN,
            fanGain: RADIANCE_FAN_GAIN,
            groundGain: RADIANCE_GROUND_GAIN,
            wallGain: RADIANCE_WALL_GAIN,
            groundStrength: RADIANCE_GROUND_STRENGTH,
            wallStrength: RADIANCE_WALL_STRENGTH,
        };
        this.emitters = new Float32Array(RADIANCE_MAX_EMITTERS * RADIANCE_EMITTER_ROWS * 4);
        this.emitterCount = 0;
        this.solvedKey = null;
        this.pendingKey = null;
        this.lastSolveMs = -Infinity;
        this.solves = 0;
        this.solveCpuMs = 0;
        this.ready = false;
        this._res = null;
    }

    get bytes() {
        return this._res ? RADIANCE_BYTES : 0;
    }

    _texture(width, height, internalFormat, format, type, filter) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
        return texture;
    }

    _target(width, height, filter) {
        const gl = this.gl;
        const texture = this._texture(width, height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, filter);
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!complete) {
            gl.deleteFramebuffer(framebuffer);
            gl.deleteTexture(texture);
            throw new Error('radiance target incomplete');
        }
        return { texture, framebuffer, width, height };
    }

    _ensure() {
        if (this._res) return this._res;
        const gl = this.gl;
        const grid = this.grid;
        const uniforms = (program, names) => Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)]));
        const emit = this.createProgram(gl, PASS_VERTEX, emitFragment(this.apertureSpill));
        const cascade = this.createProgram(gl, PASS_VERTEX, CASCADE_FRAGMENT);
        const resolve = this.createProgram(gl, PASS_VERTEX, RESOLVE_FRAGMENT);
        this._res = {
            vao: gl.createVertexArray(),
            emit,
            emitUniforms: uniforms(emit, ['u_emitters', 'u_emitterCount', 'u_footprint', 'u_footprintRect', 'u_footprintSize',
                'u_terrain', 'u_terrainRect', 'u_coast', 'u_coastRect', 'u_grid', 'u_emit']),
            cascade,
            cascadeUniforms: uniforms(cascade, ['u_scene', 'u_upper', 'u_cascade', 'u_hasUpper', 'u_probes', 'u_march']),
            resolve,
            resolveUniforms: uniforms(resolve, ['u_cascade0', 'u_probes']),
            emitterTexture: this._texture(RADIANCE_MAX_EMITTERS, RADIANCE_EMITTER_ROWS, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST),
            scene: this._target(grid.sceneW, grid.sceneH, gl.NEAREST),
            cascades: [this._target(grid.cascadeW, grid.cascadeH, gl.NEAREST), this._target(grid.cascadeW, grid.cascadeH, gl.NEAREST)],
            result: this._target(grid.probesX * 3, grid.probesY, gl.LINEAR),
        };
        return this._res;
    }

    /**
     * Per frame, before the scene pass. `enabled` false (shed level, day,
     * unsupported) releases everything; otherwise re-solves when `key`
     * (the caller's hash of emitters + field revisions) moved and the last
     * solve is at least RADIANCE_MIN_SOLVE_MS old. `inputs` =
     * `{ footprint: { texture, rect }, terrain: { texture, rect } | null,
     * coast: { texture, rect } | null }`. Returns whether a field is ready.
     */
    update({ enabled = false, key = 0, count = 0, nowMs = 0, inputs = null } = {}) {
        if (!enabled || !this.supported || !count || !inputs?.footprint?.texture) {
            if (this._res) this.release();
            this.ready = false;
            this.solvedKey = null;
            return false;
        }
        const tuningKey = this._tuningKey();
        const fullKey = `${key}|${tuningKey}`;
        if (fullKey === this.solvedKey && this.ready) return true;
        if (this.ready && nowMs - this.lastSolveMs < RADIANCE_MIN_SOLVE_MS) return true;
        const started = performance.now();
        this._solve(count, inputs);
        this.solveCpuMs = performance.now() - started;
        this.lastSolveMs = nowMs;
        this.solvedKey = fullKey;
        this.solves++;
        this.ready = true;
        return true;
    }

    _tuningKey() {
        const t = this.tuning;
        return `${t.extinction},${t.bounceGain},${t.apertureGain}`;
    }

    _solve(count, { footprint, terrain = null, coast = null }) {
        const gl = this.gl;
        const res = this._ensure();
        const grid = this.grid;
        const tuning = this.tuning;
        // The scene program's units 12-15 carry this pass's inputs; the
        // scene pass rebinds every unit it reads each frame, and these four
        // are restored for the other programs anyway.
        const units = [12, 13, 14, 15];
        const saved = units.map((unit) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            return [gl.getParameter(gl.TEXTURE_BINDING_2D), gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY)];
        });
        const bind = (unit, texture) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
        };
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.bindVertexArray(res.vao);

        // Emitters (RGBA32F, texelFetch only).
        gl.activeTexture(gl.TEXTURE0 + units[0]);
        gl.bindTexture(gl.TEXTURE_2D, res.emitterTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, RADIANCE_MAX_EMITTERS, RADIANCE_EMITTER_ROWS, gl.RGBA, gl.FLOAT, this.emitters);

        // 1 — the emitting plane.
        gl.bindFramebuffer(gl.FRAMEBUFFER, res.scene.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, grid.sceneW, grid.sceneH);
        gl.useProgram(res.emit);
        const eu = res.emitUniforms;
        gl.uniform1i(eu.u_emitters, units[0]);
        gl.uniform1i(eu.u_emitterCount, count);
        bind(units[1], footprint.texture);
        gl.uniform1i(eu.u_footprint, units[1]);
        gl.uniform3f(eu.u_footprintRect, footprint.rect.originX, footprint.rect.originY, footprint.rect.cell);
        gl.uniform2i(eu.u_footprintSize, footprint.rect.width, footprint.rect.height);
        bind(units[2], terrain?.texture || null);
        gl.uniform1i(eu.u_terrain, units[2]);
        if (terrain?.texture) gl.uniform4f(eu.u_terrainRect, terrain.rect.x, terrain.rect.y, terrain.rect.w, terrain.rect.h);
        else gl.uniform4f(eu.u_terrainRect, 0, 0, 0, 0);
        bind(units[3], coast?.texture || null);
        gl.uniform1i(eu.u_coast, units[3]);
        if (coast?.texture) gl.uniform4f(eu.u_coastRect, coast.rect.x, coast.rect.y, coast.rect.cols, coast.rect.rows);
        else gl.uniform4f(eu.u_coastRect, 0, 0, 0, 0);
        gl.uniform3f(eu.u_grid, grid.originX, grid.originY, RADIANCE_CELL);
        gl.uniform2f(eu.u_emit, tuning.bounceGain, tuning.apertureGain);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // 2 — cascades top-down, ping-ponging the two cascade targets.
        gl.useProgram(res.cascade);
        const cu = res.cascadeUniforms;
        gl.viewport(0, 0, grid.cascadeW, grid.cascadeH);
        bind(units[0], res.scene.texture);
        gl.uniform1i(cu.u_scene, units[0]);
        gl.uniform1i(cu.u_upper, units[1]);
        gl.uniform2i(cu.u_probes, grid.probesX, grid.probesY);
        gl.uniform4f(cu.u_march, RADIANCE_CELL, RADIANCE_PROBE, RADIANCE_BASE_INTERVAL, tuning.extinction);
        let upper = null;
        for (let cascade = RADIANCE_CASCADES - 1; cascade >= 0; cascade--) {
            const target = res.cascades[cascade % 2];
            bind(units[1], upper ? upper.texture : null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
            gl.uniform1i(cu.u_cascade, cascade);
            gl.uniform1i(cu.u_hasUpper, upper ? 1 : 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            upper = target;
        }

        // 3 — the three panels the scene pass reads.
        gl.bindFramebuffer(gl.FRAMEBUFFER, res.result.framebuffer);
        gl.viewport(0, 0, res.result.width, res.result.height);
        gl.useProgram(res.resolve);
        bind(units[1], null);
        bind(units[0], upper.texture);
        gl.uniform1i(res.resolveUniforms.u_cascade0, units[0]);
        gl.uniform2i(res.resolveUniforms.u_probes, grid.probesX, grid.probesY);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        units.forEach((unit, index) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, saved[index][0]);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, saved[index][1]);
        });
    }

    /** Binds the field (or `fallback`) on the scene program's unit and sets its uniforms. */
    bind(uniforms, fallback) {
        const gl = this.gl;
        const on = this.ready && this._res;
        gl.activeTexture(gl.TEXTURE0 + this.unit);
        gl.bindTexture(gl.TEXTURE_2D, on ? this._res.result.texture : fallback);
        gl.uniform1i(uniforms.u_radiance, this.unit);
        const grid = this.grid;
        gl.uniform4f(uniforms.u_radianceGrid, grid.originX, grid.originY, RADIANCE_PROBE, on ? 1 : 0);
        const t = this.tuning;
        gl.uniform4f(uniforms.u_radianceGain, t.fanGain, t.groundGain, t.wallGain, 0);
        gl.uniform2f(uniforms.u_radianceStrength, t.groundStrength, t.wallStrength);
    }

    /** Debug readback of the result panel texel under a world point (tuning, captures). */
    sample(worldX, worldY) {
        if (!this.ready || !this._res) return null;
        const gl = this.gl;
        const grid = this.grid;
        const px = Math.floor((worldX - grid.originX) / RADIANCE_PROBE);
        const py = Math.floor((worldY * 2 - grid.originY) / RADIANCE_PROBE);
        if (px < 0 || py < 0 || px >= grid.probesX || py >= grid.probesY) return null;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._res.result.framebuffer);
        const out = [];
        const texel = new Float32Array(4);
        for (let panel = 0; panel < 3; panel++) {
            gl.readPixels(panel * grid.probesX + px, py, 1, 1, gl.RGBA, gl.FLOAT, texel);
            out.push([texel[0], texel[1], texel[2], texel[3]].map(v => +v.toFixed(4)));
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { fluence: out[0], fromSW: out[1], fromSE: out[2] };
    }

    getDiagnostics() {
        return {
            supported: this.supported,
            ready: this.ready,
            emitters: this.emitterCount,
            solves: this.solves,
            solveCpuMs: +this.solveCpuMs.toFixed(3),
            bytes: this.bytes,
            grid: `${this.grid.probesX}x${this.grid.probesY} probes, ${RADIANCE_CASCADES} cascades`,
        };
    }

    release() {
        const gl = this.gl;
        const res = this._res;
        this._res = null;
        this.ready = false;
        this.solvedKey = null;
        if (!res || !gl || gl.isContextLost?.()) return;
        for (const target of [res.scene, res.result, ...res.cascades]) {
            gl.deleteFramebuffer(target.framebuffer);
            gl.deleteTexture(target.texture);
        }
        gl.deleteTexture(res.emitterTexture);
        gl.deleteVertexArray(res.vao);
        gl.deleteProgram(res.emit);
        gl.deleteProgram(res.cascade);
        gl.deleteProgram(res.resolve);
    }

    /** Context loss: every handle is already dead. */
    abandon() {
        this._res = null;
        this.ready = false;
        this.solvedKey = null;
    }
}
