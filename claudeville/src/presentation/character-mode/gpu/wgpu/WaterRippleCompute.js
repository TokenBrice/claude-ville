// Wave 5-A — WebGPU 30 Hz Shallow-Water Compute Ripple Pass (Spec 01 §1, §3, §5).
//
// Self-contained modular WebGPU compute pass (`{ prepare, encode, release,
// queueImpulse, stepAccumulator, getDiagnostics }`) plus exact pure-JS CPU
// wave-equation stepper (`stepRippleFieldCpu`) for deterministic verification.
//
// Resource budget (Spec 01 §3 / §5):
//   Ping-pong state pair : 2 x 256 x 256 rgba16float = 1,048,576 B (1.0 MiB)
//   Static flow/boundary : 1 x 256 x 256 rgba8unorm  =   262,144 B (256 KiB)
//   Total texture budget :                             1,310,720 B
//
// Pipeline layout (Spec 01 §1):
//   group 0 binding 0 : uniform RippleParams
//   group 0 binding 1 : sampled previous state (texture_2d<f32>, rgba16float)
//   group 0 binding 2 : write-only next state (texture_storage_2d<rgba16float, write>)
//   group 0 binding 3 : static boundary/forcing field (texture_2d<f32>, rgba8unorm)
//   group 0 binding 4 : read-only sparse impulses (storage buffer, up to 64/step)
//   Previous and next state textures are strictly disjoint via two prebuilt
//   ping-pong bind groups (`[0 -> 1]` and `[1 -> 0]`).
//
// Simulation invariants:
//   - Fixed simulation step dt = 1/30 s (30 Hz).
//   - Courant number c * dt / dx strictly clamped <= 0.5 (c^2 <= 0.25).
//   - Solid walls (boundary.r < 0.5) enforce homogeneous Neumann zero-normal
//     flow (`dh/dn = 0`) by mirroring neighbor heights to hC.
//   - Catch-up strictly capped at 2 steps per frame.
//   - Visibility return resets the step accumulator to 0.
//   - `reducedMotion` freezes displacement (0 compute steps dispatched).
import { createUniformViews, uniformLayout, writeUniforms } from '../wgsl/common.js';

export const RIPPLE_GRID_WIDTH = 256;
export const RIPPLE_GRID_HEIGHT = 256;
export const RIPPLE_STATE_FORMAT = 'rgba16float';
export const RIPPLE_BOUNDARY_FORMAT = 'rgba8unorm';

export const RIPPLE_STATE_BYTES_PER_TEXEL = 8;
export const RIPPLE_BOUNDARY_BYTES_PER_TEXEL = 4;
export const RIPPLE_PINGPONG_BYTES = 2 * RIPPLE_GRID_WIDTH * RIPPLE_GRID_HEIGHT * RIPPLE_STATE_BYTES_PER_TEXEL;
export const RIPPLE_BOUNDARY_BYTES = RIPPLE_GRID_WIDTH * RIPPLE_GRID_HEIGHT * RIPPLE_BOUNDARY_BYTES_PER_TEXEL;
export const RIPPLE_TOTAL_TEXTURE_BYTES = RIPPLE_PINGPONG_BYTES + RIPPLE_BOUNDARY_BYTES;

export const RIPPLE_HZ = 30;
export const RIPPLE_FIXED_DT = 1 / RIPPLE_HZ;
export const RIPPLE_MAX_COURANT = 0.5;
export const RIPPLE_DEFAULT_COURANT = 0.42;
export const RIPPLE_DEFAULT_DAMPING = 0.985;
export const RIPPLE_MAX_AMPLITUDE = 4.0;
export const RIPPLE_MAX_STEPS_PER_FRAME = 2;
export const RIPPLE_WORKGROUP_SIZE = 8;

export const RIPPLE_MAX_IMPULSES = 64;
export const RIPPLE_IMPULSE_STRIDE_BYTES = 32; // 2 x vec4f per impulse
export const RIPPLE_IMPULSE_BUFFER_BYTES = RIPPLE_MAX_IMPULSES * RIPPLE_IMPULSE_STRIDE_BYTES;

export const RIPPLE_IMPULSE_KINDS = Object.freeze({
    wake: 1,
    boat: 2,
    spillway: 3,
    rain: 4,
});

// Match the rain vertex shader (wgsl/rain.js) so each CPU-queued storm impulse
// lands at its exact drop's ground coordinate and hash order.
export function rainCellHash(value) {
    let x = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Computes the tight wet-cell AABB inside the ripple grid from an RGBA8
 * boundary buffer (`boundary[4 * cell] > 0` = water). Used to clip storm
 * rain-cell iteration in O(1) before hashing any cell.
 */
export function computeWetRippleBounds(boundary, width = RIPPLE_GRID_WIDTH, height = RIPPLE_GRID_HEIGHT) {
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    if (boundary && width > 0 && height > 0) {
        const limit = Math.min(width * height, Math.floor(boundary.length / 4));
        for (let cell = 0; cell < limit; cell++) {
            if (!boundary[cell * 4]) continue;
            const y = Math.floor(cell / width);
            const x = cell - y * width;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    const empty = maxX < minX || maxY < minY;
    return Object.freeze({ minX, maxX, minY, maxY, empty });
}

/**
 * Intersects the viewport rain-cell rect `[ox, ox + cols) x [oy, oy + rows)`
 * with the ripple grid (or its tighter wet AABB) before hashing cells.
 * Any rain cell outside the returned half-open range `[startX, endX) x
 * [startY, endY)` can never produce a ground coordinate inside the active
 * ripple grid, so skipping it preserves exact cell coordinates and hash order.
 */
export function intersectRainCellsWithRippleGrid({
    ox = 0,
    oy = 0,
    cols = 0,
    rows = 0,
    cellSize = 32,
    rippleOrigin = [0, 0],
    rippleScale = 1,
    gridWidth = RIPPLE_GRID_WIDTH,
    gridHeight = RIPPLE_GRID_HEIGHT,
    wetBounds = null,
} = {}) {
    if (!(cols > 0) || !(rows > 0) || !(cellSize > 0) || !(rippleScale > 0)
        || !(gridWidth > 0) || !(gridHeight > 0)) {
        return { startX: 0, endX: 0, startY: 0, endY: 0, empty: true };
    }
    if (wetBounds?.empty) {
        return { startX: 0, endX: 0, startY: 0, endY: 0, empty: true };
    }
    const gMinX = wetBounds ? Math.max(0, wetBounds.minX) : 0;
    const gMaxX = wetBounds ? Math.min(gridWidth - 1, wetBounds.maxX) : gridWidth - 1;
    const gMinY = wetBounds ? Math.max(0, wetBounds.minY) : 0;
    const gMaxY = wetBounds ? Math.min(gridHeight - 1, wetBounds.maxY) : gridHeight - 1;
    if (gMaxX < gMinX || gMaxY < gMinY) {
        return { startX: 0, endX: 0, startY: 0, endY: 0, empty: true };
    }

    // For a cell cx, integer ground coordinate rx lies in [cx*cellSize, (cx+1)*cellSize - 1].
    // Mapping into ripple grid is gx = floor((rx - originX) * scale).
    // gx >= gMinX requires rx >= originX + gMinX / scale (conservatively floored by 1 cell margin).
    // gx <= gMaxX requires rx < originX + (gMaxX + 1) / scale (conservatively ceiled by +1).
    const invScale = 1 / rippleScale;
    const worldMinX = rippleOrigin[0] + gMinX * invScale;
    const worldMaxX = rippleOrigin[0] + (gMaxX + 1) * invScale;
    const worldMinY = rippleOrigin[1] + gMinY * invScale;
    const worldMaxY = rippleOrigin[1] + (gMaxY + 1) * invScale;

    const startX = Math.max(ox, Math.floor(worldMinX / cellSize));
    const endX = Math.min(ox + cols, Math.floor(worldMaxX / cellSize) + 1);
    const startY = Math.max(oy, Math.floor(worldMinY / cellSize));
    const endY = Math.min(oy + rows, Math.floor(worldMaxY / cellSize) + 1);
    const empty = startX >= endX || startY >= endY;
    return { startX, endX, startY, endY, empty };
}

/**
 * Evaluates storm rain-drop impacts over the ripple-grid intersection in exact
 * row-major `(cy, cx)` hash order and calls `onImpulse(rx, ry)` for each drop
 * that crossed its impact phase since `previousPhases`.
 */
export function collectRainRippleImpulses({
    uniforms,
    rainInstances = 0,
    previousPhases = null,
    cellSize = 32,
    layerCuts = null,
    rippleOrigin = [0, 0],
    rippleScale = 1,
    gridWidth = RIPPLE_GRID_WIDTH,
    gridHeight = RIPPLE_GRID_HEIGHT,
    wetBounds = null,
    onImpulse = null,
} = {}) {
    if (!uniforms || !rainInstances || !previousPhases || typeof onImpulse !== 'function') {
        return { scannedCells: 0, emitted: 0 };
    }
    const ox = uniforms[0];
    const oy = uniforms[1];
    const cols = uniforms[2];
    if (!(cols > 0)) return { scannedCells: 0, emitted: 0 };
    const rows = Math.ceil(rainInstances / cols);
    const range = intersectRainCellsWithRippleGrid({
        ox, oy, cols, rows, cellSize, rippleOrigin, rippleScale, gridWidth, gridHeight, wetBounds,
    });
    if (range.empty) return { scannedCells: 0, emitted: 0 };

    const seedSalt = uniforms[3];
    const density = uniforms[4];
    const phase0 = uniforms[8];
    const phase1 = uniforms[9];
    const phase2 = uniforms[10];
    const prev0 = previousPhases[0];
    const prev1 = previousPhases[1];
    const prev2 = previousPhases[2];
    const cut0 = layerCuts?.cut0 ?? 0.34;
    const cut1 = layerCuts?.cut1 ?? 0.72;
    const invU32 = 1 / 4294967296;

    let emitted = 0;
    const scannedCells = (range.endY - range.startY) * (range.endX - range.startX);
    for (let cy = range.startY; cy < range.endY; cy++) {
        const yTerm = Math.imul(cy + 32768, 0xd8163841) ^ seedSalt;
        const baseY = cy * cellSize;
        for (let cx = range.startX; cx < range.endX; cx++) {
            const seed = rainCellHash(Math.imul(cx + 32768, 0x8da6b343) ^ yTerm);
            if (seed * invU32 >= density) continue;
            const pick = rainCellHash(seed ^ 0x68e31da4) * invU32;
            let phase;
            let previous;
            if (pick < cut0) {
                phase = phase0;
                previous = prev0;
            } else if (pick < cut1) {
                phase = phase1;
                previous = prev1;
            } else {
                phase = phase2;
                previous = prev2;
            }
            if (previous == null) continue;
            const impact = 1 - rainCellHash(seed + 3) * invU32;
            if (!((phase >= previous) ? impact > previous && impact <= phase : impact > previous || impact <= phase)) continue;
            const rx = cx * cellSize + Math.floor(rainCellHash(seed + 1) * invU32 * cellSize);
            const ry = baseY + Math.floor(rainCellHash(seed + 2) * invU32 * cellSize);
            onImpulse(rx, ry);
            emitted++;
        }
    }
    return { scannedCells, emitted };
}

export const RIPPLE_COMPUTE_BINDING = Object.freeze({
    params: 0,
    previousState: 1,
    nextState: 2,
    boundaryField: 3,
    impulses: 4,
});

export const RIPPLE_PARAMS_LAYOUT = uniformLayout('RippleParams', [
    ['gridSize', 'vec2u'], ['impulseCount', 'u32'], ['reducedMotion', 'u32'],
    ['dt', 'f32'], ['courant', 'f32'], ['damping', 'f32'], ['maxAmplitude', 'f32'],
    ['flowScale', 'f32'], ['revision', 'u32'], ['pad0', 'u32'], ['pad1', 'u32'],
]);

// ---------------------------------------------------------------- WGSL kernel

export const WATER_RIPPLE_COMPUTE_WGSL = /* wgsl */ `
${RIPPLE_PARAMS_LAYOUT.wgsl}

struct RippleImpulse {
  posRadiusStrength: vec4f, // x, y (grid px), radius, strength
  impulseInfo: vec4f,              // kind, vx, vy, reserved
}

@group(0) @binding(${RIPPLE_COMPUTE_BINDING.params}) var<uniform> params: RippleParams;
@group(0) @binding(${RIPPLE_COMPUTE_BINDING.previousState}) var prevState: texture_2d<f32>;
@group(0) @binding(${RIPPLE_COMPUTE_BINDING.nextState}) var nextState: texture_storage_2d<rgba16float, write>;
@group(0) @binding(${RIPPLE_COMPUTE_BINDING.boundaryField}) var boundaryField: texture_2d<f32>;
@group(0) @binding(${RIPPLE_COMPUTE_BINDING.impulses}) var<storage, read> impulses: array<RippleImpulse>;

const MAX_COURANT: f32 = ${RIPPLE_MAX_COURANT.toFixed(2)};

fn isWaterCell(coord: vec2i, dims: vec2i) -> bool {
  if (coord.x < 0 || coord.y < 0 || coord.x >= dims.x || coord.y >= dims.y) { return false; }
  return textureLoad(boundaryField, coord, 0).r >= 0.5;
}

// Homogeneous Neumann zero-normal-flow lookup: solid walls and grid borders
// reflect neighbor height to hC so dh/dn == 0 across every wall face.
fn sampleNeighborHeight(coord: vec2i, dims: vec2i, hCenter: f32) -> f32 {
  if (!isWaterCell(coord, dims)) { return hCenter; }
  return textureLoad(prevState, coord, 0).r;
}

@compute @workgroup_size(${RIPPLE_WORKGROUP_SIZE}, ${RIPPLE_WORKGROUP_SIZE}, 1)
fn waterRippleMain(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2i(params.gridSize);
  let p = vec2i(gid.xy);
  if (p.x >= dims.x || p.y >= dims.y) { return; }

  let prev = textureLoad(prevState, p, 0);
  if (params.reducedMotion != 0u) {
    textureStore(nextState, p, prev);
    return;
  }

  let boundary = textureLoad(boundaryField, p, 0);
  if (boundary.r < 0.5) {
    textureStore(nextState, p, vec4f(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let hC = prev.r;
  let hP = prev.g;
  let hL = sampleNeighborHeight(p + vec2i(-1, 0), dims, hC);
  let hR = sampleNeighborHeight(p + vec2i(1, 0), dims, hC);
  let hU = sampleNeighborHeight(p + vec2i(0, -1), dims, hC);
  let hD = sampleNeighborHeight(p + vec2i(0, 1), dims, hC);

  let lap = (hL + hR + hU + hD) - 4.0 * hC;
  let courant = clamp(params.courant, 0.0, MAX_COURANT);
  let c2 = courant * courant;

  // Optional static flow drift (encoded [-1, 1] in boundary.gb), bounded so
  // total propagation stays well within Courant stability.
  let flow = (boundary.gb * 2.0 - vec2f(1.0)) * clamp(params.flowScale, 0.0, 0.15);
  let advX = select(hR - hC, hC - hL, flow.x >= 0.0);
  let advY = select(hD - hC, hC - hU, flow.y >= 0.0);
  let advection = -(flow.x * advX + flow.y * advY);

  let localDamp = clamp(params.damping * (0.92 + 0.08 * boundary.a), 0.0, 1.0);
  var hNext = (2.0 * hC - hP + c2 * lap + advection) * localDamp;

  let count = min(params.impulseCount, ${RIPPLE_MAX_IMPULSES}u);
  let pf = vec2f(p) + vec2f(0.5);
  for (var i = 0u; i < count; i++) {
    let imp = impulses[i].posRadiusStrength;
    let r = max(0.5, imp.z);
    let d = pf - imp.xy;
    let dist2 = dot(d, d);
    let r2 = r * r;
    if (dist2 < r2) {
      let falloff = 1.0 - dist2 / r2;
      hNext += imp.w * falloff * falloff;
    }
  }

  let amp = max(0.01, params.maxAmplitude);
  hNext = clamp(hNext, -amp, amp);
  let dhDx = 0.5 * (hR - hL);
  let dhDy = 0.5 * (hD - hU);
  textureStore(nextState, p, vec4f(hNext, hC, dhDx, dhDy));
}
`;

// ------------------------------------------------------------ Pure CPU stepper

/**
 * Allocates a pure-JS ripple simulation field matching the GPU ping-pong
 * `rgba16float` pair and `rgba8unorm` boundary/flow grid.
 * Boundary defaults to open water (R=255), zero flow (G=128, B=128), full
 * open damping weight (A=255).
 */
export function createRippleFieldCpu(width = RIPPLE_GRID_WIDTH, height = RIPPLE_GRID_HEIGHT) {
    const count = width * height;
    const prev = new Float32Array(count * 4);
    const next = new Float32Array(count * 4);
    const boundary = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
        const o = i * 4;
        boundary[o] = 255;     // water mask (>= 128 = water, < 128 = solid wall)
        boundary[o + 1] = 128; // flow X = 0
        boundary[o + 2] = 128; // flow Y = 0
        boundary[o + 3] = 255; // local damping weight = 1.0
    }
    return {
        width,
        height,
        prev,
        next,
        boundary,
        stepCount: 0,
    };
}

export function setBoundaryWallCpu(field, x, y, solid = true) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= field.width || iy >= field.height) return;
    const o = (iy * field.width + ix) * 4;
    field.boundary[o] = solid ? 0 : 255;
    if (solid) {
        field.prev[o] = 0;
        field.prev[o + 1] = 0;
        field.prev[o + 2] = 0;
        field.prev[o + 3] = 0;
    }
}

export function setBoundaryFlowCpu(field, x, y, flowX = 0, flowY = 0, dampingWeight = 1) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= field.width || iy >= field.height) return;
    const o = (iy * field.width + ix) * 4;
    field.boundary[o + 1] = Math.max(0, Math.min(255, Math.round((Math.max(-1, Math.min(1, flowX)) * 0.5 + 0.5) * 255)));
    field.boundary[o + 2] = Math.max(0, Math.min(255, Math.round((Math.max(-1, Math.min(1, flowY)) * 0.5 + 0.5) * 255)));
    field.boundary[o + 3] = Math.max(0, Math.min(255, Math.round(Math.max(0, Math.min(1, dampingWeight)) * 255)));
}

export function normalizeImpulse(impulse = {}) {
    const x = Number(impulse.x);
    const y = Number(impulse.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const radius = Math.max(0.5, Math.min(16, Number.isFinite(Number(impulse.radius)) ? Number(impulse.radius) : 2.0));
    const strength = Math.max(-2.0, Math.min(2.0, Number.isFinite(Number(impulse.strength)) ? Number(impulse.strength) : 0.25));
    const kindName = typeof impulse.kind === 'string' ? impulse.kind : '';
    const kind = Number.isFinite(Number(impulse.kind))
        ? Number(impulse.kind)
        : (RIPPLE_IMPULSE_KINDS[kindName] || RIPPLE_IMPULSE_KINDS.wake);
    const vx = Number.isFinite(Number(impulse.vx)) ? Number(impulse.vx) : 0;
    const vy = Number.isFinite(Number(impulse.vy)) ? Number(impulse.vy) : 0;
    return { x, y, radius, strength, kind, vx, vy };
}

/**
 * Computes total discrete wave energy, max |h|, and NaN presence on a CPU field.
 */
export function computeRippleEnergyCpu(field, courant = RIPPLE_DEFAULT_COURANT) {
    const { width, height, prev, boundary } = field;
    const c = Math.max(0, Math.min(RIPPLE_MAX_COURANT, Number(courant) || 0));
    const c2 = c * c;
    let energy = 0;
    let maxAbsHeight = 0;
    let hasNaN = false;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            if (boundary[o] < 128) continue;
            const hC = prev[o];
            const hP = prev[o + 1];
            const dhDx = prev[o + 2];
            const dhDy = prev[o + 3];
            if (!Number.isFinite(hC) || !Number.isFinite(hP) || !Number.isFinite(dhDx) || !Number.isFinite(dhDy)) {
                hasNaN = true;
                continue;
            }
            const absH = Math.abs(hC);
            if (absH > maxAbsHeight) maxAbsHeight = absH;
            const vel = hC - hP;
            energy += 0.5 * (vel * vel + c2 * (dhDx * dhDx + dhDy * dhDy));
        }
    }
    return { energy, maxAbsHeight, hasNaN };
}

/**
 * Pure-JS reference wave stepper matching `WATER_RIPPLE_COMPUTE_WGSL`
 * equation-for-equation:
 *   - Enforces Courant <= 0.5 (`c^2 <= 0.25`)
 *   - Enforces zero normal flow across solid walls & borders (Neumann BC)
 *   - Freezes displacement under `reducedMotion` (0 steps, state untouched)
 *   - Ping-pongs `field.prev` and `field.next` after each step
 */
export function stepRippleFieldCpu(field, {
    impulses = [],
    courant = RIPPLE_DEFAULT_COURANT,
    damping = RIPPLE_DEFAULT_DAMPING,
    maxAmplitude = RIPPLE_MAX_AMPLITUDE,
    flowScale = 0,
    reducedMotion = false,
} = {}) {
    if (reducedMotion) {
        const stats = computeRippleEnergyCpu(field, courant);
        return { stepped: false, ...stats };
    }

    const { width, height, prev, next, boundary } = field;
    const c = Math.max(0, Math.min(RIPPLE_MAX_COURANT, Number.isFinite(courant) ? courant : RIPPLE_DEFAULT_COURANT));
    const c2 = c * c;
    const baseDamp = Math.max(0, Math.min(1, Number.isFinite(damping) ? damping : RIPPLE_DEFAULT_DAMPING));
    const amp = Math.max(0.01, Number.isFinite(maxAmplitude) ? maxAmplitude : RIPPLE_MAX_AMPLITUDE);
    const fScale = Math.max(0, Math.min(0.15, Number.isFinite(flowScale) ? flowScale : 0));

    const validImpulses = [];
    if (Array.isArray(impulses)) {
        for (let i = 0; i < impulses.length && validImpulses.length < RIPPLE_MAX_IMPULSES; i++) {
            const norm = normalizeImpulse(impulses[i]);
            if (norm) validImpulses.push(norm);
        }
    }

    const isWater = (nx, ny) => (
        nx >= 0 && ny >= 0 && nx < width && ny < height && boundary[(ny * width + nx) * 4] >= 128
    );

    let maxAbsHeight = 0;
    let hasNaN = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            if (boundary[o] < 128) {
                next[o] = 0;
                next[o + 1] = 0;
                next[o + 2] = 0;
                next[o + 3] = 0;
                continue;
            }
            const hC = prev[o];
            const hP = prev[o + 1];
            const hL = isWater(x - 1, y) ? prev[(y * width + (x - 1)) * 4] : hC;
            const hR = isWater(x + 1, y) ? prev[(y * width + (x + 1)) * 4] : hC;
            const hU = isWater(x, y - 1) ? prev[((y - 1) * width + x) * 4] : hC;
            const hD = isWater(x, y + 1) ? prev[((y + 1) * width + x) * 4] : hC;

            const lap = (hL + hR + hU + hD) - 4 * hC;
            let advection = 0;
            if (fScale > 0) {
                const fx = ((boundary[o + 1] / 255) * 2 - 1) * fScale;
                const fy = ((boundary[o + 2] / 255) * 2 - 1) * fScale;
                const advX = fx >= 0 ? (hC - hL) : (hR - hC);
                const advY = fy >= 0 ? (hC - hU) : (hD - hC);
                advection = -(fx * advX + fy * advY);
            }

            const localDamp = Math.max(0, Math.min(1, baseDamp * (0.92 + 0.08 * (boundary[o + 3] / 255))));
            let hNext = (2 * hC - hP + c2 * lap + advection) * localDamp;

            if (validImpulses.length > 0) {
                const px = x + 0.5;
                const py = y + 0.5;
                for (let k = 0; k < validImpulses.length; k++) {
                    const imp = validImpulses[k];
                    const dx = px - imp.x;
                    const dy = py - imp.y;
                    const dist2 = dx * dx + dy * dy;
                    const r2 = imp.radius * imp.radius;
                    if (dist2 < r2) {
                        const falloff = 1 - dist2 / r2;
                        hNext += imp.strength * falloff * falloff;
                    }
                }
            }

            if (!Number.isFinite(hNext)) {
                hasNaN = true;
                hNext = 0;
            } else {
                hNext = Math.max(-amp, Math.min(amp, hNext));
            }
            const dhDx = 0.5 * (hR - hL);
            const dhDy = 0.5 * (hD - hU);

            next[o] = hNext;
            next[o + 1] = hC;
            next[o + 2] = dhDx;
            next[o + 3] = dhDy;

            const absH = Math.abs(hNext);
            if (absH > maxAbsHeight) maxAbsHeight = absH;
        }
    }

    // Strict ping-pong swap
    field.prev = next;
    field.next = prev;
    field.stepCount++;

    const stats = computeRippleEnergyCpu(field, c);
    return {
        stepped: true,
        energy: stats.energy,
        maxAbsHeight: Math.max(maxAbsHeight, stats.maxAbsHeight),
        hasNaN: hasNaN || stats.hasNaN,
    };
}

// ------------------------------------------------------------ WebGPU Pass class

function gpuTextureUsage() {
    return globalThis.GPUTextureUsage || {
        COPY_SRC: 0x01,
        COPY_DST: 0x02,
        TEXTURE_BINDING: 0x04,
        STORAGE_BINDING: 0x08,
    };
}

function gpuBufferUsage() {
    return globalThis.GPUBufferUsage || {
        STORAGE: 0x80,
        UNIFORM: 0x40,
        COPY_DST: 0x08,
    };
}

function gpuShaderStage() {
    return globalThis.GPUShaderStage || {
        COMPUTE: 0x4,
    };
}

async function compileComputeModule(device, code, label) {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo?.();
    const errors = (info?.messages || []).filter(msg => msg.type === 'error');
    if (errors.length) {
        const lines = code.split('\n');
        const detail = errors.slice(0, 8).map(msg => (
            `${label}:${msg.lineNum}:${msg.linePos} ${msg.message}\n    ${lines[msg.lineNum - 1]?.trim() ?? ''}`
        )).join('\n');
        throw new Error(`WGSL compute compilation failed (${errors.length} errors)\n${detail}`);
    }
    return module;
}

export class WaterRippleCompute {
    constructor({
        width = RIPPLE_GRID_WIDTH,
        height = RIPPLE_GRID_HEIGHT,
        courant = RIPPLE_DEFAULT_COURANT,
        damping = RIPPLE_DEFAULT_DAMPING,
        maxAmplitude = RIPPLE_MAX_AMPLITUDE,
        flowScale = 0,
    } = {}) {
        this.width = width;
        this.height = height;
        this.courant = Math.max(0, Math.min(RIPPLE_MAX_COURANT, Number(courant) || RIPPLE_DEFAULT_COURANT));
        this.damping = Math.max(0, Math.min(1, Number(damping) || RIPPLE_DEFAULT_DAMPING));
        this.maxAmplitude = Math.max(0.01, Number(maxAmplitude) || RIPPLE_MAX_AMPLITUDE);
        this.flowScale = Math.max(0, Math.min(0.15, Number(flowScale) || 0));

        this.device = null;
        this.ready = false;

        this.pingPongTextures = [null, null];
        this.pingPongViews = [null, null];
        this.boundaryTexture = null;
        this.boundaryView = null;
        this.paramsBuffer = null;
        this.impulseBuffer = null;

        this.bindGroupLayout = null;
        this.pipelineLayout = null;
        this.pipeline = null;
        // Strictly disjoint ping-pong bind groups:
        //   bindGroups[0]: reads pingPong[0] (binding 1), writes pingPong[1] (binding 2)
        //   bindGroups[1]: reads pingPong[1] (binding 1), writes pingPong[0] (binding 2)
        this.bindGroups = [null, null];

        this._readIndex = 0;
        this._accumulatorSec = 0;
        this._stepsExecuted = 0;
        this._visibilityResets = 0;
        this._clampedFrames = 0;
        this._frozen = false;
        this._revision = 0;
        this._allocatedBytes = 0;
        this._impulses = [];
        this._paramsViews = createUniformViews(RIPPLE_PARAMS_LAYOUT.size);
        this._impulseStaging = new Float32Array(RIPPLE_MAX_IMPULSES * 8);
    }

    async prepare(device, { boundaryData = null } = {}) {
        if (!device) throw new Error('WaterRippleCompute.prepare requires a WebGPU device');
        this.release();
        this.device = device;

        const tu = gpuTextureUsage();
        const bu = gpuBufferUsage();
        const computeStage = gpuShaderStage().COMPUTE;

        const stateUsage = tu.TEXTURE_BINDING | tu.STORAGE_BINDING | tu.COPY_DST | tu.COPY_SRC;
        for (let i = 0; i < 2; i++) {
            const tex = device.createTexture({
                label: `water-ripple-state-${i}`,
                size: [this.width, this.height, 1],
                format: RIPPLE_STATE_FORMAT,
                usage: stateUsage,
            });
            this.pingPongTextures[i] = tex;
            this.pingPongViews[i] = tex.createView();
        }

        this.boundaryTexture = device.createTexture({
            label: 'water-ripple-boundary-flow',
            size: [this.width, this.height, 1],
            format: RIPPLE_BOUNDARY_FORMAT,
            usage: tu.TEXTURE_BINDING | tu.COPY_DST,
        });
        this.boundaryView = this.boundaryTexture.createView();

        // Seed default open-water boundary if caller did not provide one.
        if (boundaryData) {
            this.uploadBoundaryField(boundaryData);
        } else {
            const init = new Uint8Array(this.width * this.height * 4);
            for (let i = 0; i < init.length; i += 4) {
                init[i] = 255;
                init[i + 1] = 128;
                init[i + 2] = 128;
                init[i + 3] = 255;
            }
            this.uploadBoundaryField(init);
        }

        this.paramStride = Math.ceil(RIPPLE_PARAMS_LAYOUT.size / (device.limits?.minUniformBufferOffsetAlignment || 256)) * (device.limits?.minUniformBufferOffsetAlignment || 256);
        this.paramsBuffer = device.createBuffer({
            label: 'water-ripple-params',
            size: this.paramStride * RIPPLE_MAX_STEPS_PER_FRAME,
            usage: bu.UNIFORM | bu.COPY_DST,
        });
        this.impulseBuffer = device.createBuffer({
            label: 'water-ripple-impulses',
            size: RIPPLE_IMPULSE_BUFFER_BYTES,
            usage: bu.STORAGE | bu.COPY_DST,
        });

        const B = RIPPLE_COMPUTE_BINDING;
        this.bindGroupLayout = device.createBindGroupLayout({
            label: 'water-ripple-compute-bgl',
            entries: [
                { binding: B.params, visibility: computeStage, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: RIPPLE_PARAMS_LAYOUT.size } },
                { binding: B.previousState, visibility: computeStage, texture: { sampleType: 'float' } },
                { binding: B.nextState, visibility: computeStage, storageTexture: { access: 'write-only', format: RIPPLE_STATE_FORMAT } },
                { binding: B.boundaryField, visibility: computeStage, texture: { sampleType: 'float' } },
                { binding: B.impulses, visibility: computeStage, buffer: { type: 'read-only-storage', minBindingSize: RIPPLE_IMPULSE_STRIDE_BYTES } },
            ],
        });

        this.pipelineLayout = device.createPipelineLayout({
            label: 'water-ripple-compute-layout',
            bindGroupLayouts: [this.bindGroupLayout],
        });

        const module = await compileComputeModule(device, WATER_RIPPLE_COMPUTE_WGSL, 'water-ripple.wgsl');
        this.pipeline = await device.createComputePipelineAsync({
            label: 'water-ripple-compute-pipeline',
            layout: this.pipelineLayout,
            compute: { module, entryPoint: 'waterRippleMain' },
        });

        // Two strictly disjoint bind groups so the storage output is NEVER
        // simultaneously bound as a sampled texture.
        for (let readIdx = 0; readIdx < 2; readIdx++) {
            const writeIdx = readIdx ^ 1;
            this.bindGroups[readIdx] = device.createBindGroup({
                label: `water-ripple-bg-${readIdx}-to-${writeIdx}`,
                layout: this.bindGroupLayout,
                entries: [
                    { binding: B.params, resource: { buffer: this.paramsBuffer, size: RIPPLE_PARAMS_LAYOUT.size } },
                    { binding: B.previousState, resource: this.pingPongViews[readIdx] },
                    { binding: B.nextState, resource: this.pingPongViews[writeIdx] },
                    { binding: B.boundaryField, resource: this.boundaryView },
                    { binding: B.impulses, resource: { buffer: this.impulseBuffer } },
                ],
            });
        }

        this._readIndex = 0;
        this._allocatedBytes = (
            2 * this.width * this.height * RIPPLE_STATE_BYTES_PER_TEXEL
            + this.width * this.height * RIPPLE_BOUNDARY_BYTES_PER_TEXEL
        );
        this.ready = true;
        return this;
    }

    uploadBoundaryField(rgba8Bytes) {
        if (!this.device || !this.boundaryTexture) return false;
        const expected = this.width * this.height * RIPPLE_BOUNDARY_BYTES_PER_TEXEL;
        if (!rgba8Bytes || rgba8Bytes.byteLength !== expected) {
            throw new Error(`Boundary field byte length ${rgba8Bytes?.byteLength} !== expected ${expected}`);
        }
        const view = rgba8Bytes instanceof Uint8Array
            ? rgba8Bytes
            : new Uint8Array(rgba8Bytes.buffer, rgba8Bytes.byteOffset, rgba8Bytes.byteLength);
        this.device.queue.writeTexture(
            { texture: this.boundaryTexture, origin: { x: 0, y: 0, z: 0 } },
            view,
            { offset: 0, bytesPerRow: this.width * RIPPLE_BOUNDARY_BYTES_PER_TEXEL, rowsPerImage: this.height },
            { width: this.width, height: this.height, depthOrArrayLayers: 1 },
        );
        return true;
    }

    queueImpulse(impulse) {
        const normalized = normalizeImpulse(impulse);
        if (!normalized) return false;
        if (this._impulses.length >= RIPPLE_MAX_IMPULSES) {
            this._impulses.shift();
        }
        this._impulses.push(normalized);
        return true;
    }

    resetAccumulator() {
        this._accumulatorSec = 0;
        this._visibilityResets++;
    }

    onVisibilityChange(hidden) {
        if (!hidden) this.resetAccumulator();
    }

    /**
     * Advances the 30 Hz fixed-step accumulator:
     * - Visibility return resets accumulator to 0 and runs 0 steps.
     * - `reducedMotion` freezes displacement and runs 0 steps.
     * - Catch-up is strictly capped at 2 steps per frame.
     */
    stepAccumulator(dtSec, { reducedMotion = false, visibilityReturned = false } = {}) {
        if (visibilityReturned) {
            this.resetAccumulator();
            this._frozen = Boolean(reducedMotion);
            return 0;
        }
        if (reducedMotion) {
            this._frozen = true;
            return 0;
        }
        this._frozen = false;
        const dt = Number(dtSec);
        if (!Number.isFinite(dt) || dt <= 0) return 0;

        this._accumulatorSec += dt;
        const rawSteps = Math.floor(this._accumulatorSec / RIPPLE_FIXED_DT);
        if (rawSteps <= 0) return 0;

        if (rawSteps > RIPPLE_MAX_STEPS_PER_FRAME) {
            this._clampedFrames++;
            this._accumulatorSec = 0;
            return RIPPLE_MAX_STEPS_PER_FRAME;
        }
        this._accumulatorSec -= rawSteps * RIPPLE_FIXED_DT;
        return rawSteps;
    }

    getReadTexture() {
        return this.pingPongTextures[this._readIndex];
    }

    getReadView() {
        return this.pingPongViews[this._readIndex];
    }

    /**
     * Encodes 0..2 fixed 30 Hz compute ripple steps on `encoder`.
     * Under `reducedMotion`, dispatches 0 steps and freezes displacement.
     */
    encode(encoder, {
        dtSec = 0,
        reducedMotion = false,
        visibilityReturned = false,
        courant = this.courant,
        damping = this.damping,
        flowScale = this.flowScale,
    } = {}) {
        const steps = this.stepAccumulator(dtSec, { reducedMotion, visibilityReturned });
        if (reducedMotion) {
            this._impulses.length = 0;
            return { encoded: false, steps: 0, frozen: true, readIndex: this._readIndex };
        }
        if (!this.ready || !this.device || !encoder || steps <= 0) {
            return { encoded: false, steps: 0, frozen: this._frozen, readIndex: this._readIndex };
        }

        const safeCourant = Math.max(0, Math.min(RIPPLE_MAX_COURANT, Number.isFinite(courant) ? courant : this.courant));
        const safeDamping = Math.max(0, Math.min(1, Number.isFinite(damping) ? damping : this.damping));
        const safeFlow = Math.max(0, Math.min(0.15, Number.isFinite(flowScale) ? flowScale : this.flowScale));
        this.courant = safeCourant;
        this.damping = safeDamping;
        this.flowScale = safeFlow;

        const impulseCount = Math.min(this._impulses.length, RIPPLE_MAX_IMPULSES);
        if (impulseCount > 0) {
            const staging = this._impulseStaging;
            for (let i = 0; i < impulseCount; i++) {
                const imp = this._impulses[i];
                const base = i * 8;
                staging[base] = imp.x;
                staging[base + 1] = imp.y;
                staging[base + 2] = imp.radius;
                staging[base + 3] = imp.strength;
                staging[base + 4] = imp.kind;
                staging[base + 5] = imp.vx;
                staging[base + 6] = imp.vy;
                staging[base + 7] = 0;
            }
            this.device.queue.writeBuffer(this.impulseBuffer, 0, staging.buffer, 0, impulseCount * RIPPLE_IMPULSE_STRIDE_BYTES);
            this._impulses.length = 0;
        }

        const groupsX = Math.ceil(this.width / RIPPLE_WORKGROUP_SIZE);
        const groupsY = Math.ceil(this.height / RIPPLE_WORKGROUP_SIZE);

        for (let step = 0; step < steps; step++) {
            const stepImpulses = step === 0 ? impulseCount : 0;
            this._revision = (this._revision + 1) >>> 0;
            writeUniforms(RIPPLE_PARAMS_LAYOUT, this._paramsViews, {
                gridSize: [this.width, this.height],
                impulseCount: stepImpulses,
                reducedMotion: 0,
                dt: RIPPLE_FIXED_DT,
                courant: safeCourant,
                damping: safeDamping,
                maxAmplitude: this.maxAmplitude,
                flowScale: safeFlow,
                revision: this._revision,
                pad0: 0,
                pad1: 0,
            });
            this.device.queue.writeBuffer(this.paramsBuffer, step * this.paramStride, this._paramsViews.buffer);

            const pass = encoder.beginComputePass({ label: `water-ripple-step-${step}` });
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.bindGroups[this._readIndex], [step * this.paramStride]);
            pass.dispatchWorkgroups(groupsX, groupsY, 1);
            pass.end();

            this._readIndex ^= 1;
            this._stepsExecuted++;
        }

        return {
            encoded: true,
            steps,
            frozen: false,
            readIndex: this._readIndex,
            revision: this._revision,
        };
    }

    release() {
        for (let i = 0; i < 2; i++) {
            this.pingPongTextures[i]?.destroy?.();
            this.pingPongTextures[i] = null;
            this.pingPongViews[i] = null;
            this.bindGroups[i] = null;
        }
        this.boundaryTexture?.destroy?.();
        this.paramsBuffer?.destroy?.();
        this.impulseBuffer?.destroy?.();
        this.boundaryTexture = null;
        this.boundaryView = null;
        this.paramsBuffer = null;
        this.impulseBuffer = null;
        this.bindGroupLayout = null;
        this.pipelineLayout = null;
        this.pipeline = null;
        this.device = null;
        this.ready = false;
        this._allocatedBytes = 0;
        this._impulses.length = 0;
    }

    getDiagnostics() {
        return {
            ready: this.ready,
            width: this.width,
            height: this.height,
            stateFormat: RIPPLE_STATE_FORMAT,
            boundaryFormat: RIPPLE_BOUNDARY_FORMAT,
            pingPongBytes: 2 * this.width * this.height * RIPPLE_STATE_BYTES_PER_TEXEL,
            boundaryBytes: this.width * this.height * RIPPLE_BOUNDARY_BYTES_PER_TEXEL,
            totalTextureBytes: (
                2 * this.width * this.height * RIPPLE_STATE_BYTES_PER_TEXEL
                + this.width * this.height * RIPPLE_BOUNDARY_BYTES_PER_TEXEL
            ),
            allocatedBytes: this._allocatedBytes,
            hz: RIPPLE_HZ,
            fixedDt: RIPPLE_FIXED_DT,
            maxCourant: RIPPLE_MAX_COURANT,
            courant: this.courant,
            damping: this.damping,
            maxStepsPerFrame: RIPPLE_MAX_STEPS_PER_FRAME,
            stepsExecuted: this._stepsExecuted,
            accumulatorSec: this._accumulatorSec,
            visibilityResets: this._visibilityResets,
            clampedFrames: this._clampedFrames,
            queuedImpulses: this._impulses.length,
            readIndex: this._readIndex,
            writeIndex: this._readIndex ^ 1,
            revision: this._revision,
            frozen: this._frozen,
        };
    }
}

export function createWaterRippleCompute(options = {}) {
    return new WaterRippleCompute(options);
}
