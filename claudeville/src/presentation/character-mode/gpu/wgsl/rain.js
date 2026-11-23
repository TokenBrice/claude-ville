// RN-1 — the WGSL twin of GpuWorldRenderer RAIN_VERTEX / RAIN_FRAGMENT (look
// `rn1`, WeatherRenderer `gpuRainField`): the world rain in one instanced
// draw of two quads per ground cell (the streak, then its splash), depth
// tested less-equal against the painter depth and never writing it. No
// vertex buffers: the field is the cell grid hashed in the vertex stage. The
// camera and resolution come from the frame block (group 0); the rain's own
// uniforms and the open-ground splash mask are group 1.
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../../../config/constants.js';
import { GPU_DEPTH_KEY_MAX, GPU_DEPTH_KEY_STEPS_PER_PX, GPU_DEPTH_SORT_Y_MIN } from '../GpuWorldPolicy.js';
import {
    RAIN_LAYER_TABLE as RT,
    RAIN_SPLASH_BITS,
    rainFrameChoice,
    rainLayerChoice,
} from '../GpuWorldRenderer.js';
import { RAIN_DRIFT_SLOPE, RAIN_GROUND_CELL, RAIN_UNIFORM_FLAGS } from '../../WeatherRenderer.js';
import { FRAME_BINDINGS_WGSL, WGSL_COMMON } from './common.js';

export const RAIN_BINDING = Object.freeze({ rain: 0, mask: 1 });
export const RAIN_UNIFORM_BYTES = 64;
const f5 = value => value.toFixed(5);
const choice = values => rainLayerChoice(values, true);

export const RAIN_WGSL = /* wgsl */ `
struct RainUniforms {
  view: vec4f,
  fall: vec4f,
  phase: vec4f,
  splash: vec4f,
}
@group(1) @binding(${RAIN_BINDING.rain}) var<uniform> rain: RainUniforms;
@group(1) @binding(${RAIN_BINDING.mask}) var rainMask: texture_2d<f32>;
struct RainOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
  @location(2) @interpolate(flat) shape: vec4i,
  @location(3) @interpolate(flat) lean: f32,
}
fn rainHash(v: u32) -> u32 {
  var x = v;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
fn rainU01(h: u32) -> f32 {
  return f32(h >> 8u) / 16777216.0;
}
@vertex fn rainVs(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> RainOut {
  let quad = i32(vertexIndex) / 6;
  let vi = i32(vertexIndex) - quad * 6;
  let corner = vec2f(select(0.0, 1.0, vi == 1 || vi >= 4), select(0.0, 1.0, vi == 2 || vi == 3 || vi == 5));
  let cols = max(1, i32(rain.view.z));
  let cx = i32(rain.view.x) + i32(instanceIndex) % cols;
  let cy = i32(rain.view.y) + i32(instanceIndex) / cols;
  let h = rainHash((u32(cx + 32768) * 0x8da6b343u) ^ (u32(cy + 32768) * 0xd8163841u) ^ u32(rain.view.w));
  let flags = u32(rain.splash.w + 0.5);
  let still = (flags & ${RAIN_UNIFORM_FLAGS.static}u) != 0u;
  let pick = rainU01(rainHash(h ^ 0x68e31da4u));
  let layer = select(select(select(2, 1, pick < ${f5(RT.cut1)}), 0, pick < ${f5(RT.cut0)}), 1, still);
  let ground = vec2f(f32(cx), f32(cy)) * ${RAIN_GROUND_CELL}.0
    + floor(vec2f(rainU01(rainHash(h + 1u)), rainU01(rainHash(h + 2u))) * ${RAIN_GROUND_CELL}.0);
  let phase = select(select(rain.phase.z, rain.phase.y, layer == 1), rain.phase.x, layer == 0);
  let fall = fract(phase + rainU01(rainHash(h + 3u)));
  let streak = rainU01(h) < rain.fall.x;
  var origin = vec2f(0.0);
  var size = vec2f(0.0);
  var color = vec4f(0.0);
  var shape = vec4i(-1, 0, 0, 0);
  var leanOut = 0.0;
  if (quad == 0 && streak) {
    let windMul = ${choice(RT.windMul)};
    let lean = clamp(rain.fall.w * 0.8 * windMul, -1.5, 1.5);
    let minCells = ${choice(RT.minCells)};
    let maxCells = ${choice(RT.maxCells)};
    let cells = minCells + i32(floor(rainU01(rainHash(h + 4u)) * f32(maxCells - minCells + 1)));
    let height = rain.fall.y * (1.0 - fall);
    let bottomY = floor(ground.y - height);
    let bottomX = floor(ground.x - height * rain.fall.z * windMul * ${f5(RAIN_DRIFT_SLOPE)});
    let tail = floor(f32(cells - 1) * lean + 0.5);
    let left = min(0.0, tail);
    origin = vec2f(bottomX - tail + left, bottomY - f32(cells - 1));
    size = vec2f(abs(tail) + 1.0, f32(cells));
    color = vec4f(${choice(RT.rgb.map(rgb => `vec3f(${rgb})`))}, ${choice(RT.alpha)} * rain.phase.w);
    shape = vec4i(0, i32(left), ${choice(RT.dashed)}, 0);
    leanOut = lean;
  } else if (quad == 1 && (flags & ${RAIN_UNIFORM_FLAGS.mask}u) != 0u
    && rainU01(rainHash(h + 5u)) < rain.splash.x) {
    let speedMul = ${choice(RT.speedMul)};
    let frame = select(i32(floor(fall / max(rain.splash.y * speedMul, 0.000001))), 2, still);
    let iso = vec2f(ground.x / ${TILE_WIDTH / 2}.0 + ground.y / ${TILE_HEIGHT / 2}.0, ground.y / ${TILE_HEIGHT / 2}.0 - ground.x / ${TILE_WIDTH / 2}.0) * 0.5;
    let tile = vec2i(floor(iso + 0.5));
    if (frame < 3 && tile.x >= 0 && tile.y >= 0 && tile.x < ${MAP_SIZE} && tile.y < ${MAP_SIZE}) {
      if (textureLoad(rainMask, tile, 0).r > 0.5) {
        origin = ground - vec2f(3.0, 3.0);
        size = vec2f(7.0, 4.0);
        color = vec4f(0.0, 0.0, 0.0, rain.splash.z);
        shape = vec4i(1, frame, 0, 0);
      }
    }
  }
  var out: RainOut;
  out.local = corner * size;
  out.color = color;
  out.shape = shape;
  out.lean = leanOut;
  if (shape.x < 0) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let world = origin + corner * size;
  let screen = (world + frame.cameraXy) * frame.cameraScale;
  let clip = vec2f(
    screen.x / max(1.0, frame.resolution.x) * 2.0 - 1.0,
    1.0 - screen.y / max(1.0, frame.resolution.y) * 2.0
  );
  let key = clamp(floor((ground.y - (${GPU_DEPTH_SORT_Y_MIN}.0)) * ${GPU_DEPTH_KEY_STEPS_PER_PX}.0 + 0.5), 0.0, ${GPU_DEPTH_KEY_MAX}.0);
  // The scene target holds GL's rows (scene.js): drawn mirrored (clip y
  // negated); WebGPU clip depth is [0, 1].
  out.position = vec4f(clip.x, -clip.y, 1.0 - key / ${GPU_DEPTH_KEY_MAX}.0, 1.0);
  return out;
}
struct RainTargets {
  @location(0) color: vec4f,
  @location(1) emission: vec4f,
}
@fragment fn rainFs(in: RainOut) -> RainTargets {
  let cell = vec2i(floor(in.local));
  var rgb = in.color.rgb;
  if (in.shape.x == 0) {
    if (cell.x != i32(floor(f32(cell.y) * in.lean + 0.5)) - in.shape.y) { discard; }
    if (in.shape.z != 0 && (cell.y & 1) == 1) { discard; }
  } else {
    let frame = in.shape.y;
    let bit = 1u << u32(cell.y * 7 + cell.x);
    if ((${rainFrameChoice(RAIN_SPLASH_BITS.light, true)} & bit) != 0u) {
      rgb = vec3f(${RT.light});
    } else if ((${rainFrameChoice(RAIN_SPLASH_BITS.dim, true)} & bit) != 0u) {
      rgb = vec3f(${RT.dim});
    } else {
      discard;
    }
  }
  var out: RainTargets;
  out.color = vec4f(rgb * in.color.a, in.color.a);
  out.emission = vec4f(0.0);
  return out;
}
`;

/** The rain module: `rainVs` + `rainFs` over group 0 (frame) and group 1 (rain). */
export function assembleRain() {
    return [WGSL_COMMON, FRAME_BINDINGS_WGSL, RAIN_WGSL].join('\n');
}
