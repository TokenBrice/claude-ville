// Wave 10 — the WGSL twin of GpuWorldRenderer PARTICLE_VERTEX/PARTICLE_FRAGMENT
// (0.6): every live world particle in one instanced strip draw, depth-tested
// less-equal against the painter depth and never writing it. The instance is
// GpuWorldPolicy's 28-byte layout (ParticleSystem.packGpuInstances): rect
// float32x4 @0, straight RGBA unorm8x4 @16, (shape, flags, motif, 0) uint8x4
// @20, depth key uint16 @24 (read as uint16x2, .x). The grade, the core energy,
// the camera and the cloud courses come from the frame block (group 0).
import {
    GPU_PARTICLE_FLAGS,
    GPU_PARTICLE_INSTANCE_BYTES,
    GPU_PARTICLE_MOTIF_SIZE,
    GPU_PARTICLE_SHAPES,
    SMOKE_PUFF_LIT_GAIN,
    SMOKE_PUFF_SHADE_GAIN,
} from '../GpuWorldPolicy.js';
import { PARTICLE_EMISSION } from '../GpuWorldRenderer.js';
export const PARTICLE_VERTEX_LAYOUT = Object.freeze({
    arrayStride: GPU_PARTICLE_INSTANCE_BYTES,
    stepMode: 'instance',
    attributes: Object.freeze([
        Object.freeze({ shaderLocation: 0, offset: 0, format: 'float32x4' }),
        Object.freeze({ shaderLocation: 1, offset: 16, format: 'unorm8x4' }),
        Object.freeze({ shaderLocation: 2, offset: 20, format: 'uint8x4' }),
        Object.freeze({ shaderLocation: 3, offset: 24, format: 'uint16x2' }),
    ]),
});

const gains = list => list.map(gain => gain.toFixed(5)).join(', ');

export const PARTICLE_WGSL = /* wgsl */ `
struct ParticleOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) world: vec2f,
  @location(2) @interpolate(flat) color: vec4f,
  @location(3) @interpolate(flat) shape: vec4u,
  @location(4) @interpolate(flat) size: vec2i,
}
@vertex fn particleVs(
  @builtin(vertex_index) vi: u32,
  @location(0) rect: vec4f,
  @location(1) color: vec4f,
  @location(2) shape: vec4u,
  @location(3) depth: vec2u,
) -> ParticleOut {
  let corner = vec2f(select(0.0, 1.0, (vi & 1u) == 1u), select(0.0, 1.0, vi >= 2u));
  let world = rect.xy + corner * rect.zw;
  let screen = (world + frame.cameraXy) * frame.cameraScale;
  let clip = vec2f(
    screen.x / max(1.0, frame.resolution.x) * 2.0 - 1.0,
    1.0 - screen.y / max(1.0, frame.resolution.y) * 2.0
  );
  var out: ParticleOut;
  // The scene target holds GL's rows (scene.js): draw mirrored (clip y
  // negated) like sceneVs. WebGPU clip depth is [0, 1]: GL's
  // (1 - key / 65535) * 2 - 1 lands here.
  out.position = vec4f(clip.x, -clip.y, 1.0 - f32(depth.x) / 65535.0, 1.0);
  out.local = corner * rect.zw;
  out.world = world;
  out.color = color;
  out.shape = shape;
  out.size = vec2i(rect.zw + 0.5);
  return out;
}
struct ParticleTargets {
  @location(0) color: vec4f,
  @location(1) emission: vec4f,
}
@fragment fn particleFs(in: ParticleOut) -> ParticleTargets {
  let cell = clamp(vec2i(floor(in.local)), vec2i(0), in.size - 1);
  var rgb = in.color.rgb;
  let shape = in.shape.x;
  if (shape == ${GPU_PARTICLE_SHAPES.smoke}u) {
    let radius = in.size.x / 2;
    let limit = 4 * radius * radius;
    let d = cell * 2 + 1 - 2 * radius;
    if (d.x * d.x + d.y * d.y > limit) { discard; }
    let lit = d - 2;
    let shade = d + select(4, 6, radius >= 4);
    if (lit.x * lit.x + lit.y * lit.y > limit) {
      rgb = min(vec3f(1.0), floor(rgb * 255.0 * vec3f(${gains(SMOKE_PUFF_LIT_GAIN)}) + 0.5) / 255.0);
    } else if (shade.x * shade.x + shade.y * shade.y > limit) {
      rgb = floor(rgb * 255.0 * vec3f(${gains(SMOKE_PUFF_SHADE_GAIN)}) + 0.5) / 255.0;
    }
  } else if (shape == ${GPU_PARTICLE_SHAPES.blob}u) {
    let edgeX = cell.x == 0 || cell.x == in.size.x - 1;
    let edgeY = cell.y == 0 || cell.y == in.size.y - 1;
    if (edgeX && edgeY) { discard; }
  } else if (shape == ${GPU_PARTICLE_SHAPES.wings}u) {
    if (cell.x == (in.size.x - 1) / 2) { rgb = floor(floor(rgb * 255.0 + 0.5) * 0.5) / 255.0; }
  } else if (shape == ${GPU_PARTICLE_SHAPES.motif}u) {
    let texel = vec2i(cell.x, i32(in.shape.z) * ${GPU_PARTICLE_MOTIF_SIZE} + cell.y);
    if (textureLoad(motifs, texel, 0).r < 0.5) { discard; }
  }
  let alpha = in.color.a;
  if ((in.shape.y & ${GPU_PARTICLE_FLAGS.graded}u) != 0u) {
    // In GL row order @builtin(position) is gl_FragCoord verbatim.
    rgb = applyGradeVignette(applyTimeGrade(rgb, true), vec2f(in.position.x, frame.resolution.y - in.position.y), frame.resolution);
  }
  var emission = vec3f(0.0);
  if ((in.shape.y & ${GPU_PARTICLE_FLAGS.emits}u) != 0u) {
    emission = rgb * ${PARTICLE_EMISSION.toFixed(2)} * frame.coreEnergy;
  }
  let artCell = floor(in.world);
  let shaded = applyAtmosphereCourses(rgb, artCell, bayer4(artCell), (artCell.y + 0.5 + frame.cameraXy.y) * frame.cameraScale, false);
  var out: ParticleTargets;
  out.color = vec4f(shaded * alpha, alpha);
  out.emission = vec4f(emission * alpha, alpha);
  return out;
}
`;
