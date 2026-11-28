// Wave 5-D (Astra #4) — WebGPU 20 Hz Compute Wind/Mist Field + GPU Decorative Embers.
//
// Self-contained compute pass exposing `{ prepare, encode, release,
// stepAccumulator, setWindForcing, getDiagnostics }`.
//
// Contract (specs/01 §1 & §4 D7 addenda, specs/03 Wave 5-D):
// - 128 x 128 rgba16float ping-pong pair (R=vx, G=vy, B=gustScalar, A=mistDensity):
//   2 * 128 * 128 * 8 B = 262,144 B.
// - 128 x 128 rgba8unorm static obstacle/shelter field (R=solidity, G=shelter,
//   B=dampForcing, A=terrainDrag): 65,536 B.
// - Optional GPU decorative ember storage buffer (default 256 x 32 B = 8,192 B,
//   hard cap 4,096 x 32 B = 131,072 B): strictly decorative, zero gameplay/truth state.
// - Separate compute pipeline layout (group 0):
//     binding 0: uniform WindFieldParams
//     binding 1: sampled previous state (texture_2d<f32>)
//     binding 2: write-only next state (texture_storage_2d<rgba16float, write>)
//     binding 3: static obstacle/forcing texture (texture_2d<f32>)
//     binding 4: read-only sparse gust/hearth emitters (storage, read)
// - Fixed simulation step dt = 1/20 s (20 Hz), catch-up capped at 2 steps,
//   resets accumulator on visibility return, freezes under reducedMotion.
// - Geographic semi-Lagrangian gust propagation across the village diamond with
//   leeward building shelter damping (never a global instant blink).
// - Frontier feature mask bit 3 (1 << 3 = 8).

import { BUILDING_DEFS } from '../../../../config/buildings.js';
import { tileToWorld } from '../../Projection.js';
import { baseWindX, gustinessFor, GUST_GAIN } from '../../Wind.js';
import { createUniformViews, uniformLayout, writeUniforms } from '../wgsl/common.js';

export const WIND_FIELD_SIZE = 128;
export const WIND_FIELD_FORMAT = 'rgba16float';
export const WIND_FIELD_TEXEL_BYTES = 8;
export const WIND_FIELD_PINGPONG_BYTES = 2 * WIND_FIELD_SIZE * WIND_FIELD_SIZE * WIND_FIELD_TEXEL_BYTES; // 262,144 B

export const WIND_OBSTACLE_FORMAT = 'rgba8unorm';
export const WIND_OBSTACLE_TEXEL_BYTES = 4;
export const WIND_OBSTACLE_BYTES = WIND_FIELD_SIZE * WIND_FIELD_SIZE * WIND_OBSTACLE_TEXEL_BYTES; // 65,536 B

export const WIND_EMBER_DEFAULT_CAPACITY = 256;
export const WIND_EMBER_MAX_CAPACITY = 4096;
export const WIND_EMBER_STRIDE_BYTES = 32;
export const WIND_EMBER_DEFAULT_BYTES = WIND_EMBER_DEFAULT_CAPACITY * WIND_EMBER_STRIDE_BYTES; // 8,192 B
export const WIND_EMBER_MAX_BYTES = WIND_EMBER_MAX_CAPACITY * WIND_EMBER_STRIDE_BYTES; // 131,072 B

export const WIND_EMITTER_CAPACITY = 16;
export const WIND_EMITTER_STRIDE_BYTES = 32;
export const WIND_EMITTER_BUFFER_BYTES = WIND_EMITTER_CAPACITY * WIND_EMITTER_STRIDE_BYTES; // 512 B

export const WIND_STEP_HZ = 20;
export const WIND_FIXED_DT_S = 1 / WIND_STEP_HZ;
export const WIND_FIXED_DT_MS = 1000 / WIND_STEP_HZ;
export const WIND_MAX_CATCHUP_STEPS = 2;
export const WIND_WORKGROUP_SIZE = 8;
export const WIND_EMBER_WORKGROUP_SIZE = 64;
// Maximum decorative ember lifetime in WIND_EMBER_COMPUTE_WGSL is 0.9 + 1.4 = 2.3 s.
// Add 1 extra dispatch after max life so the last live ember explicitly writes heat = 0.
export const WIND_EMBER_MAX_LIFE_S = 2.3;
export const WIND_EMBER_COOLDOWN_DISPATCHES = Math.ceil(WIND_EMBER_MAX_LIFE_S / WIND_FIXED_DT_S) + 1;

export const WIND_FRONTIER_MASK_BIT = 1 << 3; // 8 (FrameUniforms.frontier.x bit 3)

// Village diamond world art bounds (40 tiles of 64x32 -> [-1280..1280] x [-16..1264]).
export const WIND_WORLD_BOUNDS = Object.freeze({
    originX: -1280,
    originY: -16,
    width: 2560,
    height: 1280,
});

// Shared physical constants (identical between WGSL compute shader and CPU reference).
export const WIND_SIM_CONSTANTS = Object.freeze({
    velocityClamp: 3.0,
    maxTraceSpeed: 2.0,
    maxAdvectCells: 2.0,
    advectCellsPerSec: 20.0,
    gustDecayPerSec: 0.35,
    mistDecayPerSec: 0.22,
    velRelaxPerSec: 4.0,
    mistRelaxPerSec: 1.8,
    gustGain: GUST_GAIN,
    shelterVelDamp: 0.75,
    shelterGustDamp: 0.40,
    dragVelDamp: 0.25,
    wakeWeights: Object.freeze([0.85, 0.65, 0.45]),
});

export const WIND_EMITTER_FLAGS = Object.freeze({
    gust: 1,
    hearth: 2,
});

export const WIND_COMPUTE_BINDINGS = Object.freeze({
    params: 0,
    prevField: 1,
    nextField: 2,
    obstacleField: 3,
    emitters: 4,
});

export const WIND_EMBER_BINDINGS = Object.freeze({
    params: 0,
    windField: 1,
    embers: 2,
    emitters: 3,
});

export const WIND_PARAMS_LAYOUT = uniformLayout('WindFieldParams', [
    ['gridSize', 'vec2u'],
    ['emitterCount', 'u32'],
    ['emberCount', 'u32'],
    ['baseWind', 'vec2f'],
    ['dt', 'f32'],
    ['gustiness', 'f32'],
    ['mistAmbient', 'f32'],
    ['advectRate', 'f32'],
    ['gustDecay', 'f32'],
    ['mistDecay', 'f32'],
    ['worldOrigin', 'vec2f'],
    ['worldExtent', 'vec2f'],
    ['timeSec', 'f32'],
    ['stepIndex', 'u32'],
    ['reducedMotion', 'u32'],
    ['flags', 'u32'],
]);

const C = WIND_SIM_CONSTANTS;
const f4 = (value) => Number(value).toFixed(4);

// Separate compute kernel WGSL for 128x128 20 Hz geographic wind & mist advection.
export const WIND_FIELD_COMPUTE_WGSL = /* wgsl */ `
${WIND_PARAMS_LAYOUT.wgsl}
struct WindEmitter {
  posRadiusGust: vec4f, // x=cellX, y=cellY, z=radiusCells, w=gustStrength
  dirMistFlags: vec4f,  // x=dirX, y=dirY, z=mistStrength, w=flags
}

@group(0) @binding(${WIND_COMPUTE_BINDINGS.params}) var<uniform> params: WindFieldParams;
@group(0) @binding(${WIND_COMPUTE_BINDINGS.prevField}) var prevField: texture_2d<f32>;
@group(0) @binding(${WIND_COMPUTE_BINDINGS.nextField}) var nextField: texture_storage_2d<rgba16float, write>;
@group(0) @binding(${WIND_COMPUTE_BINDINGS.obstacleField}) var obstacleField: texture_2d<f32>;
@group(0) @binding(${WIND_COMPUTE_BINDINGS.emitters}) var<storage, read> emitters: array<WindEmitter>;

const WIND_VEL_CLAMP: f32 = ${f4(C.velocityClamp)};
const WIND_MAX_TRACE: f32 = ${f4(C.maxTraceSpeed)};
const WIND_MAX_ADVECT: f32 = ${f4(C.maxAdvectCells)};
const WIND_VEL_RELAX: f32 = ${f4(C.velRelaxPerSec)};
const WIND_MIST_RELAX: f32 = ${f4(C.mistRelaxPerSec)};
const WIND_GUST_GAIN: f32 = ${f4(C.gustGain)};
const WIND_SHELTER_VEL_DAMP: f32 = ${f4(C.shelterVelDamp)};
const WIND_SHELTER_GUST_DAMP: f32 = ${f4(C.shelterGustDamp)};
const WIND_DRAG_VEL_DAMP: f32 = ${f4(C.dragVelDamp)};

fn clampVecLen(v: vec2f, maxLen: f32) -> vec2f {
  let lenSq = dot(v, v);
  if (lenSq <= maxLen * maxLen || lenSq <= 1e-12) {
    return v;
  }
  return v * (maxLen / sqrt(lenSq));
}

fn loadPrevClamped(ix: i32, iy: i32, maxCoord: vec2i) -> vec4f {
  let p = clamp(vec2i(ix, iy), vec2i(0), maxCoord);
  return textureLoad(prevField, p, 0);
}

fn loadObstacleClamped(ix: i32, iy: i32, maxCoord: vec2i) -> vec4f {
  let p = clamp(vec2i(ix, iy), vec2i(0), maxCoord);
  return textureLoad(obstacleField, p, 0);
}

fn samplePrevBilinear(pos: vec2f, maxCoord: vec2i) -> vec4f {
  let clamped = clamp(pos, vec2f(0.0), vec2f(maxCoord));
  let x0 = i32(floor(clamped.x));
  let y0 = i32(floor(clamped.y));
  let x1 = min(x0 + 1, maxCoord.x);
  let y1 = min(y0 + 1, maxCoord.y);
  let fx = clamped.x - f32(x0);
  let fy = clamped.y - f32(y0);
  let c00 = loadPrevClamped(x0, y0, maxCoord);
  let c10 = loadPrevClamped(x1, y0, maxCoord);
  let c01 = loadPrevClamped(x0, y1, maxCoord);
  let c11 = loadPrevClamped(x1, y1, maxCoord);
  let top = mix(c00, c10, fx);
  let bot = mix(c01, c11, fx);
  return mix(top, bot, fy);
}

fn sampleObstacleSolidity(pos: vec2f, maxCoord: vec2i) -> f32 {
  let clamped = clamp(pos, vec2f(0.0), vec2f(maxCoord));
  let ix = i32(floor(clamped.x + 0.5));
  let iy = i32(floor(clamped.y + 0.5));
  return loadObstacleClamped(ix, iy, maxCoord).r;
}

@compute @workgroup_size(${WIND_WORKGROUP_SIZE}, ${WIND_WORKGROUP_SIZE}, 1)
fn windFieldCs(@builtin(global_invocation_id) gid: vec3u) {
  let size = params.gridSize;
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let coord = vec2i(i32(gid.x), i32(gid.y));
  let maxCoord = vec2i(i32(size.x) - 1, i32(size.y) - 1);
  let prevSelf = textureLoad(prevField, coord, 0);

  if (params.reducedMotion != 0u) {
    textureStore(nextField, coord, prevSelf);
    return;
  }

  let obs = textureLoad(obstacleField, coord, 0);
  let solidity = obs.r;
  let staticShelter = obs.g;
  let dampSource = obs.b;
  let drag = obs.a;

  if (solidity >= 0.5) {
    let solidMist = clamp(prevSelf.a * 0.5, 0.0, 1.0);
    textureStore(nextField, coord, vec4f(0.0, 0.0, 0.0, solidMist));
    return;
  }

  let pos = vec2f(f32(coord.x), f32(coord.y));
  let baseWind = params.baseWind;
  let windMag = length(baseWind);
  let windDir = select(vec2f(1.0, 0.0), baseWind / max(windMag, 1e-4), windMag > 1e-4);

  // Leeward wake shelter cast downwind behind solid buildings.
  let s1 = sampleObstacleSolidity(pos - windDir * 1.0, maxCoord);
  let s2 = sampleObstacleSolidity(pos - windDir * 2.0, maxCoord);
  let s3 = sampleObstacleSolidity(pos - windDir * 3.0, maxCoord);
  let wakeShelter = clamp(max(max(s1 * ${f4(C.wakeWeights[0])}, s2 * ${f4(C.wakeWeights[1])}), s3 * ${f4(C.wakeWeights[2])}), 0.0, 1.0);
  let shelter = clamp(max(staticShelter, wakeShelter), 0.0, 1.0);

  let shelterFactor = 1.0 - WIND_SHELTER_VEL_DAMP * shelter;
  let dragFactor = 1.0 - WIND_DRAG_VEL_DAMP * drag;
  let localBase = baseWind * shelterFactor * dragFactor;

  // Semi-Lagrangian geographic advection backtrace (strictly bounded per step).
  let traceVel = clampVecLen(mix(localBase, prevSelf.xy, 0.5), WIND_MAX_TRACE);
  let disp = clampVecLen(traceVel * (params.dt * params.advectRate), WIND_MAX_ADVECT);
  let adv = samplePrevBilinear(pos - disp, maxCoord);

  var emitGust: f32 = 0.0;
  var emitMist: f32 = 0.0;
  var emitVel: vec2f = vec2f(0.0);
  let count = min(params.emitterCount, ${WIND_EMITTER_CAPACITY}u);
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let em = emitters[i];
    let radius = max(em.posRadiusGust.z, 0.001);
    let dist = length(pos - em.posRadiusGust.xy);
    if (dist <= radius) {
      let w = 1.0 - dist / radius;
      let flags = u32(em.dirMistFlags.w + 0.5);
      if ((flags & ${WIND_EMITTER_FLAGS.gust}u) != 0u) {
        emitGust = max(emitGust, em.posRadiusGust.w * w);
        emitVel = emitVel + em.dirMistFlags.xy * (em.posRadiusGust.w * w);
      }
      emitMist = max(emitMist, em.dirMistFlags.z * w);
    }
  }

  let gustDecay = exp(-params.gustDecay * params.dt);
  let advectedGust = adv.z * gustDecay * (1.0 - WIND_SHELTER_GUST_DAMP * shelter);
  let nextGust = clamp(max(advectedGust, emitGust), 0.0, 1.0);

  let targetVel = localBase * (1.0 + WIND_GUST_GAIN * nextGust) + emitVel * shelterFactor;
  let velRelax = clamp(WIND_VEL_RELAX * params.dt * (1.0 + shelter), 0.0, 1.0);
  let blendedVel = mix(adv.xy, targetVel, velRelax);
  let nextVel = clampVecLen(blendedVel * (1.0 - 0.08 * drag), WIND_VEL_CLAMP);

  let mistDecay = exp(-params.mistDecay * params.dt);
  let baseMistForcing = params.mistAmbient * (0.25 + 0.75 * dampSource);
  let mistTarget = clamp(max(baseMistForcing, emitMist), 0.0, 1.0);
  let mistRelax = clamp(WIND_MIST_RELAX * params.dt, 0.0, 1.0);
  let nextMist = clamp(mix(adv.w * mistDecay, mistTarget, mistRelax) + emitMist * 0.35, 0.0, 1.0);

  textureStore(nextField, coord, vec4f(nextVel.x, nextVel.y, nextGust, nextMist));
}
`;

// Strictly decorative GPU ember advection kernel (zero gameplay or truth state).
export const WIND_EMBER_COMPUTE_WGSL = /* wgsl */ `
${WIND_PARAMS_LAYOUT.wgsl}
struct WindEmitter {
  posRadiusGust: vec4f,
  dirMistFlags: vec4f,
}
struct DecorativeEmber {
  posVel: vec4f,   // x=worldX, y=worldY, z=vx, w=vy
  lifeHeat: vec4f, // age, lifetime, heat, projected ground foot
}

@group(0) @binding(${WIND_EMBER_BINDINGS.params}) var<uniform> params: WindFieldParams;
@group(0) @binding(${WIND_EMBER_BINDINGS.windField}) var windField: texture_2d<f32>;
@group(0) @binding(${WIND_EMBER_BINDINGS.embers}) var<storage, read_write> embers: array<DecorativeEmber>;
@group(0) @binding(${WIND_EMBER_BINDINGS.emitters}) var<storage, read> emitters: array<WindEmitter>;

fn emberHash(v: u32) -> f32 {
  var x = v;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return f32(x >> 8u) / 16777216.0;
}

@compute @workgroup_size(${WIND_EMBER_WORKGROUP_SIZE}, 1, 1)
fn windEmberCs(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.emberCount || params.reducedMotion != 0u) {
    return;
  }

  var ember = embers[idx];
  var age = ember.lifeHeat.x + params.dt;
  var life = max(ember.lifeHeat.y, 0.5);
  var pos = ember.posVel.xy;
  var vel = ember.posVel.zw;
  var heat = ember.lifeHeat.z;
  var footY = ember.lifeHeat.w;

  let sizeF = vec2f(f32(params.gridSize.x), f32(params.gridSize.y));
  let maxCoord = vec2i(i32(params.gridSize.x) - 1, i32(params.gridSize.y) - 1);

  if (age >= life || heat <= 0.01) {
    // Respawn from a hearth emitter when present; otherwise hold inactive.
    let count = min(params.emitterCount, ${WIND_EMITTER_CAPACITY}u);
    var hearthIdx: i32 = -1;
    var found: u32 = 0u;
    for (var i: u32 = 0u; i < count; i = i + 1u) {
      let flags = u32(emitters[i].dirMistFlags.w + 0.5);
      if ((flags & ${WIND_EMITTER_FLAGS.hearth}u) != 0u && emitters[i].posRadiusGust.w > 0.05) {
        if (found == (idx % max(1u, count)) || hearthIdx < 0) {
          hearthIdx = i32(i);
        }
        found = found + 1u;
      }
    }
    // Rotate births through the entire pool, one per emitter per fixed tick.
    let births = max(count, 1u);
    let cohort = params.stepIndex % ((params.emberCount + births - 1u) / births);
    if (hearthIdx >= 0 && idx / births == cohort) {
      let em = emitters[hearthIdx];
      let h0 = emberHash(((idx + 1u) * 73856093u) ^ (params.stepIndex * 19349663u));
      let h1 = emberHash(((idx + 1u) * 83492791u) ^ (params.stepIndex * 2971215073u));
      let origin = params.worldOrigin + em.posRadiusGust.xy / sizeF * params.worldExtent;
      pos = origin + (vec2f(h0, h1) - vec2f(0.5)) * 3.0;
      footY = origin.y + f32(u32(em.dirMistFlags.w + 0.5) >> 2u) / 16.0;
      vel = vec2f((h0 - 0.5) * 8.0, -14.0 - h1 * 12.0);
      age = 0.0;
      life = 0.9 + h0 * 1.4;
      heat = clamp(em.posRadiusGust.w, 0.2, 1.0);
    } else {
      heat = 0.0;
      age = life;
    }
  } else {
    let norm = clamp((pos - params.worldOrigin) / max(params.worldExtent, vec2f(1.0)), vec2f(0.0), vec2f(1.0));
    let cell = clamp(vec2i(floor(norm * sizeF)), vec2i(0), maxCoord);
    let field = textureLoad(windField, cell, 0);
    let windPush = field.xy * (26.0 + 18.0 * field.z);
    let buoyancy = vec2f(0.0, -10.0 * heat);
    vel = clamp(mix(vel, windPush + buoyancy, clamp(3.0 * params.dt, 0.0, 1.0)), vec2f(-96.0), vec2f(96.0));
    pos = pos + vel * params.dt;
    heat = clamp(1.0 - age / life, 0.0, 1.0);
  }

  ember.posVel = vec4f(pos.x, pos.y, vel.x, vel.y);
  ember.lifeHeat = vec4f(age, life, heat, footY);
  embers[idx] = ember;
}
`;

function finite(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

function clampVecLen2(x, y, maxLen) {
    const lenSq = x * x + y * y;
    if (lenSq <= maxLen * maxLen || lenSq <= 1e-12) return [x, y];
    const scale = maxLen / Math.sqrt(lenSq);
    return [x * scale, y * scale];
}

/** Convert world art coordinates `(worldX, worldY)` to continuous grid cell coordinates. */
export function worldToWindCell(worldX, worldY, bounds = WIND_WORLD_BOUNDS, size = WIND_FIELD_SIZE) {
    const u = (finite(worldX) - bounds.originX) / Math.max(1, bounds.width);
    const v = (finite(worldY) - bounds.originY) / Math.max(1, bounds.height);
    return {
        x: clamp(u * size, 0, size - 1),
        y: clamp(v * size, 0, size - 1),
    };
}

/** Convert continuous grid cell coordinates `(cellX, cellY)` back to world art coordinates. */
export function windCellToWorld(cellX, cellY, bounds = WIND_WORLD_BOUNDS, size = WIND_FIELD_SIZE) {
    return {
        x: bounds.originX + (finite(cellX) / Math.max(1, size)) * bounds.width,
        y: bounds.originY + (finite(cellY) / Math.max(1, size)) * bounds.height,
    };
}

/** Allocate CPU reference wind/mist simulation buffers (`128 x 128`). */
export function createWindFieldState(size = WIND_FIELD_SIZE) {
    const texels = size * size;
    return {
        size,
        current: new Float32Array(texels * 4),
        next: new Float32Array(texels * 4),
        obstacle: new Uint8Array(texels * 4),
    };
}

/**
 * Rasterize building footprints into the `128 x 128` `rgba8unorm` obstacle/shelter field.
 * R = solidity (255 inside building), G = static shelter around perimeter,
 * B = damp/mist source weight, A = terrain surface drag.
 */
export function buildWindObstacleField(buildings = BUILDING_DEFS, {
    size = WIND_FIELD_SIZE,
    bounds = WIND_WORLD_BOUNDS,
    shelterMarginCells = 1,
    dampForcing = 0,
} = {}) {
    const out = new Uint8Array(size * size * 4);
    const baseDamp = Math.round(clamp(dampForcing, 0, 1) * 255);
    if (baseDamp > 0) {
        for (let i = 0; i < size * size; i++) out[i * 4 + 2] = baseDamp;
    }

    for (const building of buildings || []) {
        if (!building) continue;
        let minCx;
        let maxCx;
        let minCy;
        let maxCy;
        if (Number.isFinite(building.cellX) && Number.isFinite(building.cellY)) {
            const cw = Math.max(1, finite(building.cellW, 2));
            const ch = Math.max(1, finite(building.cellH, 2));
            minCx = Math.floor(building.cellX);
            maxCx = Math.ceil(building.cellX + cw - 1);
            minCy = Math.floor(building.cellY);
            maxCy = Math.ceil(building.cellY + ch - 1);
        } else {
            const tx = finite(building.x, finite(building.position?.tileX, 0));
            const ty = finite(building.y, finite(building.position?.tileY, 0));
            const tw = Math.max(1, finite(building.width, 3));
            const th = Math.max(1, finite(building.height, 3));
            const corners = [
                tileToWorld(tx, ty),
                tileToWorld(tx + tw, ty),
                tileToWorld(tx, ty + th),
                tileToWorld(tx + tw, ty + th),
            ].map(pt => worldToWindCell(pt.x, pt.y, bounds, size));
            minCx = Math.floor(Math.min(...corners.map(c => c.x)));
            maxCx = Math.ceil(Math.max(...corners.map(c => c.x)));
            minCy = Math.floor(Math.min(...corners.map(c => c.y)));
            maxCy = Math.ceil(Math.max(...corners.map(c => c.y)));
        }

        const solidMinX = clamp(minCx, 0, size - 1);
        const solidMaxX = clamp(maxCx, 0, size - 1);
        const solidMinY = clamp(minCy, 0, size - 1);
        const solidMaxY = clamp(maxCy, 0, size - 1);

        // Static shelter halo around perimeter + solid core.
        const pad = Math.max(0, Math.floor(shelterMarginCells));
        const haloMinX = clamp(solidMinX - pad, 0, size - 1);
        const haloMaxX = clamp(solidMaxX + pad, 0, size - 1);
        const haloMinY = clamp(solidMinY - pad, 0, size - 1);
        const haloMaxY = clamp(solidMaxY + pad, 0, size - 1);

        for (let cy = haloMinY; cy <= haloMaxY; cy++) {
            for (let cx = haloMinX; cx <= haloMaxX; cx++) {
                const idx = (cy * size + cx) * 4;
                const inside = cx >= solidMinX && cx <= solidMaxX && cy >= solidMinY && cy <= solidMaxY;
                if (inside) {
                    out[idx] = 255;
                    out[idx + 1] = 255;
                    out[idx + 3] = 255;
                } else {
                    out[idx + 1] = Math.max(out[idx + 1], 112);
                    out[idx + 3] = Math.max(out[idx + 3], 96);
                }
            }
        }
    }
    return out;
}

function normalizeEmitters(emitters = [], bounds = WIND_WORLD_BOUNDS, size = WIND_FIELD_SIZE) {
    const list = [];
    for (const raw of Array.isArray(emitters) ? emitters : []) {
        if (!raw || list.length >= WIND_EMITTER_CAPACITY) break;
        let cellX = finite(raw.cellX, NaN);
        let cellY = finite(raw.cellY, NaN);
        if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) {
            const mapped = worldToWindCell(finite(raw.worldX, 0), finite(raw.worldY, 0), bounds, size);
            cellX = mapped.x;
            cellY = mapped.y;
        }
        const radius = Math.max(0.5, finite(raw.radiusCells, finite(raw.radius, 3.0)));
        const gustStrength = clamp(finite(raw.gustStrength, finite(raw.strength, 0)), 0, 1);
        const mistStrength = clamp(finite(raw.mistStrength, 0), 0, 1);
        const dirX = clamp(finite(raw.dirX, 0), -WIND_SIM_CONSTANTS.velocityClamp, WIND_SIM_CONSTANTS.velocityClamp);
        const dirY = clamp(finite(raw.dirY, 0), -WIND_SIM_CONSTANTS.velocityClamp, WIND_SIM_CONSTANTS.velocityClamp);
        let flags = finite(raw.flags, 0) | 0;
        if (flags === 0) {
            if (gustStrength > 0 || dirX !== 0 || dirY !== 0) flags |= WIND_EMITTER_FLAGS.gust;
            if (raw.hearth === true || raw.kind === 'hearth') flags |= WIND_EMITTER_FLAGS.hearth;
        }
        const height16 = clamp(Math.round(finite(raw.height, 0) * 16), 0, 65535);
        list.push({ cellX, cellY, radius, gustStrength, mistStrength, dirX, dirY, flags, height16 });
    }
    return list;
}

/**
 * Pure CPU reference stepper matching `WIND_FIELD_COMPUTE_WGSL` cell-for-cell.
 * Used by Node unit tests to verify geographic downwind gust propagation,
 * leeward building shelter damping, bounded velocity/mist over 200+ steps,
 * and reduced-motion freeze without requiring a GPU context.
 */
export function stepWindFieldCpu(prevField, nextField, obstacleField, params = {}, emitters = []) {
    const size = Math.max(1, Math.floor(finite(params.size, WIND_FIELD_SIZE)));
    const expectedLen = size * size * 4;
    if (!prevField || prevField.length < expectedLen) {
        throw new Error(`stepWindFieldCpu: prevField requires ${expectedLen} floats`);
    }
    if (!nextField || nextField.length < expectedLen) {
        throw new Error(`stepWindFieldCpu: nextField requires ${expectedLen} floats`);
    }

    const reducedMotion = Boolean(params.reducedMotion);
    if (reducedMotion) {
        nextField.set(prevField.subarray(0, expectedLen));
        let maxSpeed = 0;
        let maxGust = 0;
        let maxMist = 0;
        for (let i = 0; i < expectedLen; i += 4) {
            const spd = Math.hypot(nextField[i], nextField[i + 1]);
            if (spd > maxSpeed) maxSpeed = spd;
            if (nextField[i + 2] > maxGust) maxGust = nextField[i + 2];
            if (nextField[i + 3] > maxMist) maxMist = nextField[i + 3];
        }
        return { stepped: false, maxSpeed, maxGust, maxMist };
    }

    const dt = clamp(finite(params.dt, WIND_FIXED_DT_S), 1e-4, 0.25);
    const baseVx = clamp(finite(params.baseWindX, finite(params.baseWind?.[0], 0.55)), -C.velocityClamp, C.velocityClamp);
    const baseVy = clamp(finite(params.baseWindY, finite(params.baseWind?.[1], 0)), -C.velocityClamp, C.velocityClamp);
    const mistAmbient = clamp(finite(params.mistAmbient, 0), 0, 1);
    const advectRate = Math.max(0, finite(params.advectRate, C.advectCellsPerSec));
    const gustDecayRate = Math.max(0, finite(params.gustDecay, C.gustDecayPerSec));
    const mistDecayRate = Math.max(0, finite(params.mistDecay, C.mistDecayPerSec));
    const bounds = params.worldBounds || WIND_WORLD_BOUNDS;
    const normEmitters = normalizeEmitters(emitters, bounds, size);

    const maxC = size - 1;
    const windMag = Math.hypot(baseVx, baseVy);
    const windDirX = windMag > 1e-4 ? baseVx / windMag : 1;
    const windDirY = windMag > 1e-4 ? baseVy / windMag : 0;
    const gustDecay = Math.exp(-gustDecayRate * dt);
    const mistDecay = Math.exp(-mistDecayRate * dt);
    const mistRelax = clamp(C.mistRelaxPerSec * dt, 0, 1);

    const obsScale = obstacleField instanceof Uint8Array ? 1 / 255 : 1;
    const obsAt = (ix, iy, channel) => {
        if (!obstacleField) return 0;
        const cx = clamp(ix, 0, maxC);
        const cy = clamp(iy, 0, maxC);
        return obstacleField[(cy * size + cx) * 4 + channel] * obsScale;
    };
    const obsSolidity = (px, py) => {
        const ix = Math.floor(clamp(px, 0, maxC) + 0.5);
        const iy = Math.floor(clamp(py, 0, maxC) + 0.5);
        return obsAt(ix, iy, 0);
    };

    const samplePrev = (px, py, out) => {
        const clampedX = clamp(px, 0, maxC);
        const clampedY = clamp(py, 0, maxC);
        const x0 = Math.floor(clampedX);
        const y0 = Math.floor(clampedY);
        const x1 = Math.min(x0 + 1, maxC);
        const y1 = Math.min(y0 + 1, maxC);
        const fx = clampedX - x0;
        const fy = clampedY - y0;
        const i00 = (y0 * size + x0) * 4;
        const i10 = (y0 * size + x1) * 4;
        const i01 = (y1 * size + x0) * 4;
        const i11 = (y1 * size + x1) * 4;
        for (let ch = 0; ch < 4; ch++) {
            const top = prevField[i00 + ch] + (prevField[i10 + ch] - prevField[i00 + ch]) * fx;
            const bot = prevField[i01 + ch] + (prevField[i11 + ch] - prevField[i01 + ch]) * fx;
            out[ch] = top + (bot - top) * fy;
        }
    };

    const adv = [0, 0, 0, 0];
    let maxSpeed = 0;
    let maxGust = 0;
    let maxMist = 0;

    for (let cy = 0; cy < size; cy++) {
        for (let cx = 0; cx < size; cx++) {
            const idx = (cy * size + cx) * 4;
            const prevVx = prevField[idx];
            const prevVy = prevField[idx + 1];
            const prevMist = prevField[idx + 3];

            const solidity = obsAt(cx, cy, 0);
            const staticShelter = obsAt(cx, cy, 1);
            const dampSource = obsAt(cx, cy, 2);
            const drag = obsAt(cx, cy, 3);

            if (solidity >= 0.5) {
                const solidMist = clamp(prevMist * 0.5, 0, 1);
                nextField[idx] = 0;
                nextField[idx + 1] = 0;
                nextField[idx + 2] = 0;
                nextField[idx + 3] = solidMist;
                if (solidMist > maxMist) maxMist = solidMist;
                continue;
            }

            const s1 = obsSolidity(cx - windDirX * 1.0, cy - windDirY * 1.0);
            const s2 = obsSolidity(cx - windDirX * 2.0, cy - windDirY * 2.0);
            const s3 = obsSolidity(cx - windDirX * 3.0, cy - windDirY * 3.0);
            const wakeShelter = clamp(
                Math.max(s1 * C.wakeWeights[0], s2 * C.wakeWeights[1], s3 * C.wakeWeights[2]),
                0,
                1,
            );
            const shelter = clamp(Math.max(staticShelter, wakeShelter), 0, 1);

            const shelterFactor = 1 - C.shelterVelDamp * shelter;
            const dragFactor = 1 - C.dragVelDamp * drag;
            const localBaseX = baseVx * shelterFactor * dragFactor;
            const localBaseY = baseVy * shelterFactor * dragFactor;

            const [traceX, traceY] = clampVecLen2(
                localBaseX + (prevVx - localBaseX) * 0.5,
                localBaseY + (prevVy - localBaseY) * 0.5,
                C.maxTraceSpeed,
            );
            const [dispX, dispY] = clampVecLen2(
                traceX * dt * advectRate,
                traceY * dt * advectRate,
                C.maxAdvectCells,
            );
            samplePrev(cx - dispX, cy - dispY, adv);

            let emitGust = 0;
            let emitMist = 0;
            let emitVelX = 0;
            let emitVelY = 0;
            for (let e = 0; e < normEmitters.length; e++) {
                const em = normEmitters[e];
                const dist = Math.hypot(cx - em.cellX, cy - em.cellY);
                if (dist <= em.radius) {
                    const w = 1 - dist / Math.max(em.radius, 0.001);
                    if ((em.flags & WIND_EMITTER_FLAGS.gust) !== 0) {
                        const g = em.gustStrength * w;
                        if (g > emitGust) emitGust = g;
                        emitVelX += em.dirX * g;
                        emitVelY += em.dirY * g;
                    }
                    const m = em.mistStrength * w;
                    if (m > emitMist) emitMist = m;
                }
            }

            const advectedGust = adv[2] * gustDecay * (1 - C.shelterGustDamp * shelter);
            const nextGust = clamp(Math.max(advectedGust, emitGust), 0, 1);

            const targetVx = localBaseX * (1 + C.gustGain * nextGust) + emitVelX * shelterFactor;
            const targetVy = localBaseY * (1 + C.gustGain * nextGust) + emitVelY * shelterFactor;
            const velRelax = clamp(C.velRelaxPerSec * dt * (1 + shelter), 0, 1);
            const blendVx = adv[0] + (targetVx - adv[0]) * velRelax;
            const blendVy = adv[1] + (targetVy - adv[1]) * velRelax;
            const [nextVx, nextVy] = clampVecLen2(
                blendVx * (1 - 0.08 * drag),
                blendVy * (1 - 0.08 * drag),
                C.velocityClamp,
            );

            const baseMistForcing = mistAmbient * (0.25 + 0.75 * dampSource);
            const mistTarget = clamp(Math.max(baseMistForcing, emitMist), 0, 1);
            const nextMist = clamp(
                (adv[3] * mistDecay) + (mistTarget - adv[3] * mistDecay) * mistRelax + emitMist * 0.35,
                0,
                1,
            );

            nextField[idx] = nextVx;
            nextField[idx + 1] = nextVy;
            nextField[idx + 2] = nextGust;
            nextField[idx + 3] = nextMist;

            const spd = Math.hypot(nextVx, nextVy);
            if (spd > maxSpeed) maxSpeed = spd;
            if (nextGust > maxGust) maxGust = nextGust;
            if (nextMist > maxMist) maxMist = nextMist;
        }
    }

    return { stepped: true, maxSpeed, maxGust, maxMist };
}

function emberHashCpu(v) {
    let x = v >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return (x >>> 8) / 16777216;
}

/**
 * Pure CPU reference stepper for GPU decorative embers (32 B = 8 floats/ember).
 * Strictly decorative — carries zero gameplay/truth state.
 */
export function stepEmbersCpu(embers, windField, params = {}, emitters = []) {
    const count = Math.floor(embers.length / 8);
    if (params.reducedMotion) return { stepped: false, activeCount: count };
    const size = Math.max(1, Math.floor(finite(params.size, WIND_FIELD_SIZE)));
    const dt = clamp(finite(params.dt, WIND_FIXED_DT_S), 1e-4, 0.25);
    const stepIndex = Math.max(0, Math.floor(finite(params.stepIndex, 0))) >>> 0;
    const bounds = params.worldBounds || WIND_WORLD_BOUNDS;
    const normEmitters = normalizeEmitters(emitters, bounds, size);
    const maxC = size - 1;
    let activeCount = 0;

    for (let idx = 0; idx < count; idx++) {
        const off = idx * 8;
        let x = embers[off];
        let y = embers[off + 1];
        let vx = embers[off + 2];
        let vy = embers[off + 3];
        let age = embers[off + 4] + dt;
        let life = Math.max(embers[off + 5], 0.5);
        let heat = embers[off + 6];

        if (age >= life || heat <= 0.01) {
            let hearth = null;
            let found = 0;
            for (let i = 0; i < normEmitters.length; i++) {
                const em = normEmitters[i];
                if ((em.flags & WIND_EMITTER_FLAGS.hearth) !== 0 && em.gustStrength > 0.05) {
                    if (found === (idx % Math.max(1, normEmitters.length)) || !hearth) hearth = em;
                    found++;
                }
            }
            const births = Math.max(1, normEmitters.length);
            if (hearth && Math.floor(idx / births) === stepIndex % Math.ceil(count / births)) {
                const h0 = emberHashCpu(Math.imul(idx + 1, 73856093) ^ Math.imul(stepIndex, 19349663));
                const h1 = emberHashCpu(Math.imul(idx + 1, 83492791) ^ Math.imul(stepIndex, 2971215073));
                const origin = windCellToWorld(hearth.cellX, hearth.cellY, bounds, size);
                x = origin.x + (h0 - 0.5) * 3;
                y = origin.y + (h1 - 0.5) * 3;
                embers[off + 7] = origin.y + hearth.height16 / 16;
                vx = (h0 - 0.5) * 8;
                vy = -14 - h1 * 12;
                age = 0;
                life = 0.9 + h0 * 1.4;
                heat = clamp(hearth.gustStrength, 0.2, 1);
            } else {
                heat = 0;
                age = life;
            }
        } else {
            const u = clamp((x - bounds.originX) / Math.max(1, bounds.width), 0, 1);
            const v = clamp((y - bounds.originY) / Math.max(1, bounds.height), 0, 1);
            const cx = clamp(Math.floor(u * size), 0, maxC);
            const cy = clamp(Math.floor(v * size), 0, maxC);
            const fIdx = (cy * size + cx) * 4;
            const fx = windField ? windField[fIdx] : 0;
            const fy = windField ? windField[fIdx + 1] : 0;
            const fg = windField ? windField[fIdx + 2] : 0;
            const pushX = fx * (26 + 18 * fg);
            const pushY = fy * (26 + 18 * fg) - 10 * heat;
            const k = clamp(3 * dt, 0, 1);
            vx = clamp(vx + (pushX - vx) * k, -96, 96);
            vy = clamp(vy + (pushY - vy) * k, -96, 96);
            x += vx * dt;
            y += vy * dt;
            heat = clamp(1 - age / life, 0, 1);
        }

        embers[off] = x;
        embers[off + 1] = y;
        embers[off + 2] = vx;
        embers[off + 3] = vy;
        embers[off + 4] = age;
        embers[off + 5] = life;
        embers[off + 6] = heat;
        if (heat > 0.01) activeCount++;
    }
    return { stepped: true, activeCount };
}

async function compileComputeModule(device, code, label) {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo?.();
    const errors = (info?.messages || []).filter(msg => msg.type === 'error');
    if (errors.length) {
        const detail = errors.slice(0, 6).map(m => `${label}:${m.lineNum}:${m.linePos} ${m.message}`).join('\n');
        throw new Error(`WGSL compute compilation failed (${errors.length} errors)\n${detail}`);
    }
    return module;
}

function gpuUsage(name, fallback) {
    return globalThis.GPUBufferUsage?.[name] ?? fallback;
}

function texUsage(name, fallback) {
    return globalThis.GPUTextureUsage?.[name] ?? fallback;
}

function stageCompute() {
    return globalThis.GPUShaderStage?.COMPUTE ?? 4;
}

export class WindFieldCompute {
    constructor({
        gridSize = WIND_FIELD_SIZE,
        emberCapacity = WIND_EMBER_DEFAULT_CAPACITY,
        worldBounds = WIND_WORLD_BOUNDS,
        buildings = BUILDING_DEFS,
    } = {}) {
        this.gridSize = Math.max(8, Math.floor(finite(gridSize, WIND_FIELD_SIZE)));
        this.emberCapacity = clamp(Math.floor(finite(emberCapacity, WIND_EMBER_DEFAULT_CAPACITY)), 0, WIND_EMBER_MAX_CAPACITY);
        this.worldBounds = Object.freeze({ ...WIND_WORLD_BOUNDS, ...worldBounds });
        this._device = null;
        this._prepared = false;

        this._windPipeline = null;
        this._windLayout = null;
        this._windPipelineLayout = null;
        this._windBindGroups = null;

        this._emberPipeline = null;
        this._emberLayout = null;
        this._emberPipelineLayout = null;
        this._emberBindGroups = null;

        this._fieldTextures = null;
        this._fieldViews = null;
        this._obstacleTexture = null;
        this._obstacleView = null;
        this._paramsBuffer = null;
        this._emitterBuffer = null;
        this._emberBuffer = null;

        this._paramsViews = createUniformViews(WIND_PARAMS_LAYOUT.size);
        this._emitterStaging = new Float32Array(WIND_EMITTER_CAPACITY * 8);
        this._obstacleBytes = buildWindObstacleField(buildings, { size: this.gridSize, bounds: this.worldBounds });
        this._obstacleDirty = true;
        this._emittersDirty = true;

        this._readIndex = 0;
        this._accumulator = 0;
        this._stepCount = 0;
        this._revision = 0;
        this._lastDispatchedSteps = 0;
        this._reducedMotion = false;
        this._emberCooldownDispatches = 0;

        this._forcing = {
            baseWindX: 0.35,
            baseWindY: 0.0,
            gustiness: gustinessFor(0.35),
            mistAmbient: 0.0,
            timeSec: 0.0,
            emitters: [],
        };
    }

    /** Reset the fixed-step accumulator (e.g., on visibility return). */
    resetAccumulator() {
        this._accumulator = 0;
    }

    /**
     * Advance the 20 Hz fixed-step accumulator.
     * - Caps catch-up strictly at `WIND_MAX_CATCHUP_STEPS` (2).
     * - Resets accumulator on `visibilityReturned: true`.
     * - Freezes completely under `reducedMotion: true`.
     */
    stepAccumulator(dtSeconds, {
        reducedMotion = this._reducedMotion,
        visibilityReturned = false,
        documentHidden = false,
    } = {}) {
        this._reducedMotion = Boolean(reducedMotion);
        if (visibilityReturned || documentHidden) {
            this._accumulator = 0;
            return 0;
        }
        if (this._reducedMotion) {
            return 0;
        }
        const dt = Number(dtSeconds);
        if (!Number.isFinite(dt) || dt <= 0) {
            return 0;
        }
        this._accumulator += dt;
        const rawSteps = Math.floor((this._accumulator + 1e-9) / WIND_FIXED_DT_S);
        if (rawSteps <= 0) {
            return 0;
        }
        if (rawSteps > WIND_MAX_CATCHUP_STEPS) {
            // Drop excess lag debt so tab hiccups never spiral into sustained catch-up.
            this._accumulator = 0;
            return WIND_MAX_CATCHUP_STEPS;
        }
        this._accumulator = Math.max(0, this._accumulator - rawSteps * WIND_FIXED_DT_S);
        return rawSteps;
    }

    /** Update base wind, mist forcing, reducedMotion flag, and sparse gust/hearth emitters. */
    setWindForcing(forcing = {}) {
        if (!forcing || typeof forcing !== 'object') return;
        if (forcing.weather && typeof forcing.weather === 'object') {
            const wx = baseWindX(forcing.weather);
            this._forcing.baseWindX = clamp(wx, -C.velocityClamp, C.velocityClamp);
            this._forcing.gustiness = gustinessFor(wx);
        }
        if (forcing.baseWindX !== undefined) {
            this._forcing.baseWindX = clamp(finite(forcing.baseWindX, this._forcing.baseWindX), -C.velocityClamp, C.velocityClamp);
            if (forcing.gustiness === undefined) {
                this._forcing.gustiness = gustinessFor(this._forcing.baseWindX);
            }
        }
        if (forcing.baseWindY !== undefined) {
            this._forcing.baseWindY = clamp(finite(forcing.baseWindY, this._forcing.baseWindY), -C.velocityClamp, C.velocityClamp);
        }
        if (forcing.gustiness !== undefined) {
            this._forcing.gustiness = clamp(finite(forcing.gustiness, this._forcing.gustiness), 0, 1);
        }
        if (forcing.mistAmbient !== undefined) {
            this._forcing.mistAmbient = clamp(finite(forcing.mistAmbient, this._forcing.mistAmbient), 0, 1);
        }
        if (forcing.timeSec !== undefined) {
            this._forcing.timeSec = finite(forcing.timeSec, this._forcing.timeSec);
        }
        if (forcing.reducedMotion !== undefined) {
            this._reducedMotion = Boolean(forcing.reducedMotion);
        }
        if (Array.isArray(forcing.emitters)) {
            this._forcing.emitters = normalizeEmitters(forcing.emitters, this.worldBounds, this.gridSize);
            this._packEmitters();
            this._emittersDirty = true;
        }
    }

    /** Replace the static `128 x 128` `rgba8unorm` obstacle/shelter field. */
    setObstacleField(bytes) {
        const expected = this.gridSize * this.gridSize * 4;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected) {
            throw new Error(`WindFieldCompute.setObstacleField expects Uint8Array(${expected})`);
        }
        this._obstacleBytes = bytes;
        this._obstacleDirty = true;
    }

    _packEmitters() {
        this._emitterStaging.fill(0);
        const list = this._forcing.emitters;
        for (let i = 0; i < list.length && i < WIND_EMITTER_CAPACITY; i++) {
            const em = list[i];
            const off = i * 8;
            this._emitterStaging[off] = em.cellX;
            this._emitterStaging[off + 1] = em.cellY;
            this._emitterStaging[off + 2] = em.radius;
            this._emitterStaging[off + 3] = em.gustStrength;
            this._emitterStaging[off + 4] = em.dirX;
            this._emitterStaging[off + 5] = em.dirY;
            this._emitterStaging[off + 6] = em.mistStrength;
            this._emitterStaging[off + 7] = (em.height16 << 2) | em.flags;
        }
    }

    async prepare(device, { obstacleBytes = null } = {}) {
        if (!device) throw new Error('WindFieldCompute.prepare requires a GPUDevice');
        this.release();
        const resources = this.resources;
        try {
            return await this._prepare(device, resources, obstacleBytes);
        } catch (error) {
            if (resources === this.resources) this.release();
            throw error;
        }
    }

    async _prepare(device, resources, obstacleBytes) {
        this._device = device;
        if (obstacleBytes) this.setObstacleField(obstacleBytes);

        const computeStage = stageCompute();
        const windLayout = device.createBindGroupLayout({
            label: 'w5d-wind-compute-layout',
            entries: [
                {
                    binding: WIND_COMPUTE_BINDINGS.params,
                    visibility: computeStage,
                    buffer: { type: 'uniform', minBindingSize: WIND_PARAMS_LAYOUT.size },
                },
                {
                    binding: WIND_COMPUTE_BINDINGS.prevField,
                    visibility: computeStage,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: WIND_COMPUTE_BINDINGS.nextField,
                    visibility: computeStage,
                    storageTexture: { access: 'write-only', format: WIND_FIELD_FORMAT, viewDimension: '2d' },
                },
                {
                    binding: WIND_COMPUTE_BINDINGS.obstacleField,
                    visibility: computeStage,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: WIND_COMPUTE_BINDINGS.emitters,
                    visibility: computeStage,
                    buffer: { type: 'read-only-storage', minBindingSize: WIND_EMITTER_BUFFER_BYTES },
                },
            ],
        });
        const windPipelineLayout = device.createPipelineLayout({
            label: 'w5d-wind-compute-pipeline-layout',
            bindGroupLayouts: [windLayout],
        });

        const emberLayout = device.createBindGroupLayout({
            label: 'w5d-wind-ember-layout',
            entries: [
                {
                    binding: WIND_EMBER_BINDINGS.params,
                    visibility: computeStage,
                    buffer: { type: 'uniform', minBindingSize: WIND_PARAMS_LAYOUT.size },
                },
                {
                    binding: WIND_EMBER_BINDINGS.windField,
                    visibility: computeStage,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: WIND_EMBER_BINDINGS.embers,
                    visibility: computeStage,
                    buffer: { type: 'storage', minBindingSize: Math.max(WIND_EMBER_STRIDE_BYTES, this.emberCapacity * WIND_EMBER_STRIDE_BYTES) },
                },
                {
                    binding: WIND_EMBER_BINDINGS.emitters,
                    visibility: computeStage,
                    buffer: { type: 'read-only-storage', minBindingSize: WIND_EMITTER_BUFFER_BYTES },
                },
            ],
        });
        const emberPipelineLayout = device.createPipelineLayout({
            label: 'w5d-wind-ember-pipeline-layout',
            bindGroupLayouts: [emberLayout],
        });

        const [windModule, emberModule] = await Promise.all([
            compileComputeModule(device, WIND_FIELD_COMPUTE_WGSL, 'w5d-wind-field.wgsl'),
            compileComputeModule(device, WIND_EMBER_COMPUTE_WGSL, 'w5d-wind-embers.wgsl'),
        ]);
        const [windPipeline, emberPipeline] = await Promise.all([
            device.createComputePipelineAsync({
                label: 'w5d-wind-field-pipeline',
                layout: windPipelineLayout,
                compute: { module: windModule, entryPoint: 'windFieldCs' },
            }),
            device.createComputePipelineAsync({
                label: 'w5d-wind-ember-pipeline',
                layout: emberPipelineLayout,
                compute: { module: emberModule, entryPoint: 'windEmberCs' },
            }),
        ]);

        if (resources !== this.resources) return this.getDiagnostics();
        const fieldUsage = texUsage('TEXTURE_BINDING', 4)
            | texUsage('STORAGE_BINDING', 8)
            | texUsage('COPY_DST', 2)
            | texUsage('COPY_SRC', 1);
        const fieldA = device.createTexture({
            label: 'w5d-wind-field-a',
            size: [this.gridSize, this.gridSize],
            format: WIND_FIELD_FORMAT,
            usage: fieldUsage,
        });
        resources.push(fieldA);
        const fieldB = device.createTexture({
            label: 'w5d-wind-field-b',
            size: [this.gridSize, this.gridSize],
            format: WIND_FIELD_FORMAT,
            usage: fieldUsage,
        });
        resources.push(fieldB);
        const obstacleTexture = device.createTexture({
            label: 'w5d-wind-obstacle',
            size: [this.gridSize, this.gridSize],
            format: WIND_OBSTACLE_FORMAT,
            usage: texUsage('TEXTURE_BINDING', 4) | texUsage('COPY_DST', 2),
        });
        resources.push(obstacleTexture);

        const paramsBuffer = device.createBuffer({
            label: 'w5d-wind-params',
            size: WIND_PARAMS_LAYOUT.size,
            usage: gpuUsage('UNIFORM', 64) | gpuUsage('COPY_DST', 8),
        });
        resources.push(paramsBuffer);
        const emitterBuffer = device.createBuffer({
            label: 'w5d-wind-emitters',
            size: WIND_EMITTER_BUFFER_BYTES,
            usage: gpuUsage('STORAGE', 128) | gpuUsage('COPY_DST', 8),
        });
        resources.push(emitterBuffer);
        const emberBytes = Math.max(WIND_EMBER_STRIDE_BYTES, this.emberCapacity * WIND_EMBER_STRIDE_BYTES);
        const emberBuffer = device.createBuffer({
            label: 'w5d-wind-embers',
            size: emberBytes,
            usage: gpuUsage('STORAGE', 128) | gpuUsage('COPY_DST', 8) | gpuUsage('COPY_SRC', 4) | gpuUsage('VERTEX', 32),
        });
        resources.push(emberBuffer);

        const fieldViews = [fieldA.createView(), fieldB.createView()];
        const obstacleView = obstacleTexture.createView();

        // Ping-pong bind groups keep the written storage texture unbound as sampled.
        const windBindGroups = [0, 1].map((readIdx) => device.createBindGroup({
            label: `w5d-wind-bg-${readIdx}`,
            layout: windLayout,
            entries: [
                { binding: WIND_COMPUTE_BINDINGS.params, resource: { buffer: paramsBuffer } },
                { binding: WIND_COMPUTE_BINDINGS.prevField, resource: fieldViews[readIdx] },
                { binding: WIND_COMPUTE_BINDINGS.nextField, resource: fieldViews[readIdx ^ 1] },
                { binding: WIND_COMPUTE_BINDINGS.obstacleField, resource: obstacleView },
                { binding: WIND_COMPUTE_BINDINGS.emitters, resource: { buffer: emitterBuffer } },
            ],
        }));

        const emberBindGroups = [0, 1].map((readIdx) => device.createBindGroup({
            label: `w5d-wind-ember-bg-${readIdx}`,
            layout: emberLayout,
            entries: [
                { binding: WIND_EMBER_BINDINGS.params, resource: { buffer: paramsBuffer } },
                { binding: WIND_EMBER_BINDINGS.windField, resource: fieldViews[readIdx] },
                { binding: WIND_EMBER_BINDINGS.embers, resource: { buffer: emberBuffer } },
                { binding: WIND_EMBER_BINDINGS.emitters, resource: { buffer: emitterBuffer } },
            ],
        }));

        this._windLayout = windLayout;
        this._windPipelineLayout = windPipelineLayout;
        this._windPipeline = windPipeline;
        this._windBindGroups = windBindGroups;

        this._emberLayout = emberLayout;
        this._emberPipelineLayout = emberPipelineLayout;
        this._emberPipeline = emberPipeline;
        this._emberBindGroups = emberBindGroups;

        this._fieldTextures = [fieldA, fieldB];
        this._fieldViews = fieldViews;
        this._obstacleTexture = obstacleTexture;
        this._obstacleView = obstacleView;
        this._paramsBuffer = paramsBuffer;
        this._emitterBuffer = emitterBuffer;
        this._emberBuffer = emberBuffer;

        this._readIndex = 0;
        this._accumulator = 0;
        this._stepCount = 0;
        this._revision = 0;
        this._lastDispatchedSteps = 0;
        this._emberCooldownDispatches = 0;
        this._obstacleDirty = true;
        this._emittersDirty = true;
        this._prepared = true;

        this._uploadDirtyResources();
        return this.getDiagnostics();
    }

    _uploadDirtyResources() {
        if (!this._device) return;
        if (this._obstacleDirty && this._obstacleTexture) {
            this._device.queue.writeTexture(
                { texture: this._obstacleTexture },
                this._obstacleBytes,
                { offset: 0, bytesPerRow: this.gridSize * WIND_OBSTACLE_TEXEL_BYTES, rowsPerImage: this.gridSize },
                { width: this.gridSize, height: this.gridSize, depthOrArrayLayers: 1 },
            );
            this._obstacleDirty = false;
        }
        if (this._emittersDirty && this._emitterBuffer) {
            this._device.queue.writeBuffer(this._emitterBuffer, 0, this._emitterStaging);
            this._emittersDirty = false;
        }
    }

    _writeStepUniforms() {
        writeUniforms(WIND_PARAMS_LAYOUT, this._paramsViews, {
            gridSize: [this.gridSize, this.gridSize],
            emitterCount: this._forcing.emitters.length,
            emberCount: this.emberCapacity,
            baseWind: [this._forcing.baseWindX, this._forcing.baseWindY],
            dt: WIND_FIXED_DT_S,
            gustiness: this._forcing.gustiness,
            mistAmbient: this._forcing.mistAmbient,
            advectRate: C.advectCellsPerSec,
            gustDecay: C.gustDecayPerSec,
            mistDecay: C.mistDecayPerSec,
            worldOrigin: [this.worldBounds.originX, this.worldBounds.originY],
            worldExtent: [this.worldBounds.width, this.worldBounds.height],
            timeSec: this._forcing.timeSec,
            stepIndex: this._stepCount,
            reducedMotion: this._reducedMotion ? 1 : 0,
            flags: WIND_FRONTIER_MASK_BIT,
        }, 0);
        this._device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsViews.buffer);
    }

    getCurrentFieldView() {
        return this._fieldViews ? this._fieldViews[this._readIndex] : null;
    }

    getEmberBuffer() {
        return this._emberBuffer;
    }

    /** True when at least one active emitter meets the WGSL hearth spawn threshold. */
    hasActiveHearthEmitter() {
        const list = this._forcing.emitters;
        const count = Math.min(list.length, WIND_EMITTER_CAPACITY);
        for (let i = 0; i < count; i++) {
            const em = list[i];
            if ((em.flags & WIND_EMITTER_FLAGS.hearth) !== 0 && em.gustStrength > 0.05) {
                return true;
            }
        }
        return false;
    }

    /**
     * True while an active hearth can spawn embers or previously spawned embers
     * have not yet completed their full `WIND_EMBER_COOLDOWN_DISPATCHES` fade-out.
     */
    hasLiveEmbers() {
        return this.emberCapacity > 0 && (this.hasActiveHearthEmitter() || this._emberCooldownDispatches > 0);
    }

    /**
     * Encode 0..2 fixed 20 Hz compute steps of the wind/mist field (plus
     * decorative embers) onto `encoder`. Pass `embers: 'auto'` to suspend the
     * ember compute pass once all active hearths are off and the last live
     * ember has expired and been zeroed.
     */
    encode(encoder, {
        dtSeconds = 0,
        forcing = null,
        reducedMotion = this._reducedMotion,
        visibilityReturned = false,
        documentHidden = false,
        enabled = true,
        embers = true,
        timestampWrites = undefined,
    } = {}) {
        if (!this._prepared || !encoder || !enabled) {
            this._lastDispatchedSteps = 0;
            return {
                dispatchedSteps: 0,
                readIndex: this._readIndex,
                revision: this._revision,
                fieldView: this.getCurrentFieldView(),
                emberBuffer: this._emberBuffer,
                hasLiveEmbers: this.hasLiveEmbers(),
                emberDispatched: false,
            };
        }

        if (forcing) this.setWindForcing(forcing);
        this._uploadDirtyResources();

        const steps = this.stepAccumulator(dtSeconds, {
            reducedMotion,
            visibilityReturned,
            documentHidden,
        });
        this._lastDispatchedSteps = steps;

        const hearthActive = this.hasActiveHearthEmitter();
        let emberDispatched = false;
        if (steps > 0) {
            const groups = Math.ceil(this.gridSize / WIND_WORKGROUP_SIZE);
            for (let s = 0; s < steps; s++) {
                this._writeStepUniforms();
                const pass = encoder.beginComputePass(
                    s === 0 && timestampWrites ? { label: 'w5d-wind-field', timestampWrites } : { label: 'w5d-wind-field' },
                );
                pass.setPipeline(this._windPipeline);
                pass.setBindGroup(0, this._windBindGroups[this._readIndex]);
                pass.dispatchWorkgroups(groups, groups, 1);
                pass.end();
                this._readIndex ^= 1;
                this._stepCount++;
                this._revision++;
            }

            const shouldRunEmbers = embers === 'auto'
                ? (hearthActive || this._emberCooldownDispatches > 0)
                : Boolean(embers);
            if (shouldRunEmbers && this.emberCapacity > 0 && this._emberPipeline) {
                const emberGroups = Math.ceil(this.emberCapacity / WIND_EMBER_WORKGROUP_SIZE);
                const pass = encoder.beginComputePass({ label: 'w5d-wind-embers' });
                pass.setPipeline(this._emberPipeline);
                pass.setBindGroup(0, this._emberBindGroups[this._readIndex]);
                pass.dispatchWorkgroups(emberGroups, 1, 1);
                pass.end();
                emberDispatched = true;
                if (hearthActive) this._emberCooldownDispatches = WIND_EMBER_COOLDOWN_DISPATCHES;
                else if (this._emberCooldownDispatches > 0) this._emberCooldownDispatches--;
            }
        }

        return {
            dispatchedSteps: steps,
            readIndex: this._readIndex,
            revision: this._revision,
            fieldView: this.getCurrentFieldView(),
            emberBuffer: this._emberBuffer,
            hasLiveEmbers: this.hasLiveEmbers(),
            emberDispatched,
        };
    }

    release() {
        for (const resource of this.resources || []) resource.destroy();
        this.resources = [];

        this._device = null;
        this._prepared = false;
        this._emberCooldownDispatches = 0;
        this._windPipeline = null;
        this._windLayout = null;
        this._windPipelineLayout = null;
        this._windBindGroups = null;
        this._emberPipeline = null;
        this._emberLayout = null;
        this._emberPipelineLayout = null;
        this._emberBindGroups = null;
        this._fieldTextures = null;
        this._fieldViews = null;
        this._obstacleTexture = null;
        this._obstacleView = null;
        this._paramsBuffer = null;
        this._emitterBuffer = null;
        this._emberBuffer = null;
    }

    getDiagnostics() {
        const fieldPingPong = 2 * this.gridSize * this.gridSize * WIND_FIELD_TEXEL_BYTES;
        const obstacle = this.gridSize * this.gridSize * WIND_OBSTACLE_TEXEL_BYTES;
        const embers = this.emberCapacity * WIND_EMBER_STRIDE_BYTES;
        const emitters = WIND_EMITTER_BUFFER_BYTES;
        const uniforms = WIND_PARAMS_LAYOUT.size;
        return {
            ready: this._prepared,
            gridSize: this.gridSize,
            format: WIND_FIELD_FORMAT,
            stepHz: WIND_STEP_HZ,
            fixedDt: WIND_FIXED_DT_S,
            maxCatchupSteps: WIND_MAX_CATCHUP_STEPS,
            frontierMaskBit: WIND_FRONTIER_MASK_BIT,
            stepCount: this._stepCount,
            revision: this._revision,
            readIndex: this._readIndex,
            accumulator: this._accumulator,
            lastDispatchedSteps: this._lastDispatchedSteps,
            reducedMotion: this._reducedMotion,
            frozen: this._reducedMotion,
            emberCapacity: this.emberCapacity,
            emberCooldownDispatches: this._emberCooldownDispatches,
            hasLiveEmbers: this.hasLiveEmbers(),
            activeEmitters: this._forcing.emitters.length,
            forcing: {
                baseWindX: this._forcing.baseWindX,
                baseWindY: this._forcing.baseWindY,
                gustiness: this._forcing.gustiness,
                mistAmbient: this._forcing.mistAmbient,
            },
            memoryBytes: {
                fieldPingPong,
                obstacle,
                embers,
                emitters,
                uniforms,
                total: fieldPingPong + obstacle + embers + emitters + uniforms,
            },
        };
    }
}

export function createWindFieldCompute(options = {}) {
    return new WindFieldCompute(options);
}
