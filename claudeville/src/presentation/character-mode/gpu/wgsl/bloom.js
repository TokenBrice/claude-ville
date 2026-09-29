// Wave 10 — the WGSL twin of GpuWorldRenderer BLOOM_FRAGMENT: pass 1 a 3x3
// box downsample of the scene's emission target, pass 2 a 5-tap diagonal
// blur. The whole bloom chain runs in GL's row order (row 0 = the frame's
// bottom), like the scene targets it reads (scene.js draws them mirrored):
// WebGL2 samples bottom-up targets, and a nearest tap that lands exactly on a
// texel seam (every third bloom row at the 0.375 scale) resolves to the texel
// above the seam in GL's space, so only the same coordinates on the same row
// order pick the same texels. The bloom passes draw the triangle mirrored
// (`bloomVs`), so their target rows are GL's and their uv interpolates exactly
// as GL's v_uv; the composite samples the result with the unmirrored GL uv
// (common.js FULLSCREEN_WGSL).

export const BLOOM_BINDING = Object.freeze({ input: 0, sampler: 1, params: 2 });

export const BLOOM_WGSL = /* wgsl */ `
struct BloomOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn bloomVs(@builtin(vertex_index) vi: u32) -> BloomOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, 1.0), vec2f(3.0, 1.0), vec2f(-1.0, -3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
  var out: BloomOut;
  out.position = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}
struct BloomParams {
  texel: vec2f,
  blur: u32,
  pad: u32,
}
@group(0) @binding(${BLOOM_BINDING.input}) var bloomInput: texture_2d<f32>;
@group(0) @binding(${BLOOM_BINDING.sampler}) var bloomSampler: sampler;
@group(0) @binding(${BLOOM_BINDING.params}) var<uniform> bloom: BloomParams;
fn sampleAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(bloomInput, bloomSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}
@fragment fn bloomFs(in: BloomOut) -> @location(0) vec4f {
  if (bloom.blur == 0u) {
    var sum = vec4f(0.0);
    for (var x = -1; x <= 1; x++) {
      for (var y = -1; y <= 1; y++) {
        sum += sampleAt(in.uv + vec2f(f32(x), f32(y)) * bloom.texel * 2.0);
      }
    }
    return sum / 9.0;
  }
  var sum = sampleAt(in.uv) * 0.20;
  sum += sampleAt(in.uv + vec2f( 1.0, 1.0) * bloom.texel * 2.0) * 0.20;
  sum += sampleAt(in.uv + vec2f(-1.0, 1.0) * bloom.texel * 2.0) * 0.20;
  sum += sampleAt(in.uv + vec2f( 1.0,-1.0) * bloom.texel * 2.0) * 0.20;
  sum += sampleAt(in.uv + vec2f(-1.0,-1.0) * bloom.texel * 2.0) * 0.20;
  return sum;
}
`;
