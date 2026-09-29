// Wave 10 — the WGSL twin of GpuWorldRenderer DEBUG_LOAD_FRAGMENT (0.1): one
// composite-sized additive pass that adds exactly zero, so the passes stack
// real GPU load on the presented frame without changing a pixel.
import { FULLSCREEN_WGSL } from './common.js';

export const DEBUG_LOAD_BINDING = Object.freeze({ scene: 0, sampler: 1 });

export const DEBUG_LOAD_WGSL = /* wgsl */ `
${FULLSCREEN_WGSL}
@group(0) @binding(${DEBUG_LOAD_BINDING.scene}) var loadScene: texture_2d<f32>;
@group(0) @binding(${DEBUG_LOAD_BINDING.sampler}) var loadSampler: sampler;
@fragment fn debugLoadFs(in: FullscreenOut) -> @location(0) vec4f {
  let c = textureLoad(loadScene, vec2i(i32(in.position.x), i32(textureDimensions(loadScene).y) - 1 - i32(in.position.y)), 0).rgb;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  var g = mix(vec3f(l), c * vec3f(0.9, 0.95, 1.05) + vec3f(0.02), 0.7);
  g = pow(max(g, vec3f(0.0)), vec3f(1.08));
  return vec4f(max(g - vec3f(4.0), vec3f(0.0)), 0.0);
}
`;
