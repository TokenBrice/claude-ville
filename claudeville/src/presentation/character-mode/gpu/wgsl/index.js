// Wave 10 (10.1 Stage A) — the WGSL module registry: every WebGPU shader
// module is assembled here from ordered includes, each a JS template over the
// same constants as its GLSL twin (contract §1.1). The frame/batch uniform
// layouts and writers live in common.js and are re-exported so a caller needs
// one import. WGSL resolves module-scope names in any order; the include order
// only keeps each module readable beside its GLSL twin.
//
// Include owners: common/grade/bloom/particle/debugLoad/composite (Core);
// scene.js (SceneA: the vertex stage, the surface and light chain); fatTaps,
// atmosphere, seam, water, beam, material, cueRun, openSea, radiance (SceneB).
// The `*_SCENE_WGSL` halves read scene-only bindings and scene.js's private
// varyings, so only the scene module takes them.
import {
    BATCH_BINDINGS_WGSL,
    COMPOSITE_BINDINGS_WGSL,
    FRAME_BINDINGS_WGSL,
    FULLSCREEN_WGSL,
    WGSL_COMMON,
} from './common.js';
import { GRADE_WGSL } from './grade.js';
import { COMPOSITE_MAIN_WGSL, COMPOSITE_ROLES_BINDINGS_WGSL, COMPOSITE_ROLES_MAIN_WGSL, DISPLAY_COLOR_WGSL } from './composite.js';
import { PARTICLE_WGSL } from './particle.js';
import { FAT_TAPS_WGSL } from './fatTaps.js';
import { ATMOSPHERE_SCENE_WGSL, ATMOSPHERE_WGSL } from './atmosphere.js';
import { SEAM_WGSL } from './seam.js';
import { WATER_SCENE_WGSL, WATER_WGSL } from './water.js';
import { BEAM_WGSL } from './beam.js';
import { MATERIAL_WGSL } from './material.js';
import { RADIANCE_WGSL } from './radiance.js';
import { CUE_RUN_WGSL } from './cueRun.js';
import { OPEN_SEA_WGSL } from './openSea.js';
import { SCENE_WGSL } from './scene.js';

export {
    BATCH_UNIFORM_LAYOUT,
    BATCH_UNIFORM_STRIDE,
    FRAME_UNIFORM_LAYOUT,
    createUniformViews,
    writeBatchUniforms,
    writeFrameUniforms,
} from './common.js';
export { BLOOM_BINDING, BLOOM_WGSL } from './bloom.js';
export { DEBUG_LOAD_BINDING, DEBUG_LOAD_WGSL } from './debugLoad.js';
export { PARTICLE_VERTEX_LAYOUT } from './particle.js';

// Wave 10 S5 / T1 — the mark pass fragment (GpuWorldRenderer MARK_FRAGMENT)
// over the scene vertex stage: a mark record's albedo texel, premultiplied.
const MARK_WGSL = /* wgsl */ `
@fragment fn markFs(in: VsOut) -> @location(0) vec4f {
  let texel = textureSampleLevel(albedo, albedoSampler, clamp(in.uv, in.uvClamp.xy, in.uvClamp.zw), 0.0);
  return vec4f(texel.rgb * texel.a, texel.a);
}
`;

// 10.2 / 10.3 — the mark fragment on an HDR or P3 screen: an action-needed
// record (flag actionMark, §7.1 role 2) gains the mark gain in linear light
// and, on P3, its role chroma; every texel becomes P3 numbers under P3. Only
// the roles scene module (`assembleScene({ markRoles: true })`) carries it.
const MARK_ROLES_WGSL = /* wgsl */ `
@fragment fn markRolesFs(in: VsOut) -> @location(0) vec4f {
  let texel = textureSampleLevel(albedo, albedoSampler, clamp(in.uv, in.uvClamp.xy, in.uvClamp.zw), 0.0);
  let mark = (in.flags & RECORD_FLAG_ACTION_MARK) != 0u;
  let gain = select(1.0, frame.hdrMarkGain, mark && frame.hdrEnabled != 0u);
  var rgb = texel.rgb;
  if (frame.p3Enabled != 0u || gain != 1.0) {
    var lin = srgbEotf(rgb);
    if (frame.p3Enabled != 0u) {
      if (mark) { lin = p3RoleChroma(lin); } else { lin = SRGB_TO_P3 * lin; }
    }
    rgb = srgbOetf(lin * gain);
  }
  return vec4f(rgb * texel.a, texel.a);
}
`;

/**
 * The scene module: record vertex stage `sceneVs`, the MRT fragment `sceneFs`
 * and the mark fragment `markFs`, over group 0 (frame) and group 1 (batch).
 * `radiance: false` is the only mode Stage A ships (the 2.10 solve is not
 * ported; the reader stays bound to a 1x1 stand-in with radianceGrid.w 0).
 */
export function assembleScene({ radiance = false, markRoles = false } = {}) {
    if (radiance) throw new Error('WebGPU radiance solve is not ported (declared exclusion)');
    return [
        'diagnostic(off, derivative_uniformity);',
        WGSL_COMMON,
        FRAME_BINDINGS_WGSL,
        BATCH_BINDINGS_WGSL,
        GRADE_WGSL,
        FAT_TAPS_WGSL,
        ATMOSPHERE_WGSL,
        ATMOSPHERE_SCENE_WGSL,
        SEAM_WGSL,
        WATER_WGSL,
        WATER_SCENE_WGSL,
        BEAM_WGSL,
        MATERIAL_WGSL,
        RADIANCE_WGSL,
        CUE_RUN_WGSL,
        SCENE_WGSL,
        MARK_WGSL,
        ...(markRoles ? [DISPLAY_COLOR_WGSL, MARK_ROLES_WGSL] : []),
    ].join('\n');
}

/**
 * The composite module: `fullscreenVs` + `compositeFs` (scene, open sea,
 * flash, bloom). `roles: true` builds the HDR/P3 module instead, whose
 * `compositeRolesFs` also reads the emission attachment (10.2, 10.3).
 */
export function assembleComposite({ roles = false } = {}) {
    return [
        WGSL_COMMON,
        FRAME_BINDINGS_WGSL,
        COMPOSITE_BINDINGS_WGSL,
        ...(roles ? [COMPOSITE_ROLES_BINDINGS_WGSL, DISPLAY_COLOR_WGSL] : []),
        FULLSCREEN_WGSL,
        GRADE_WGSL,
        FAT_TAPS_WGSL,
        ATMOSPHERE_WGSL,
        SEAM_WGSL,
        WATER_WGSL,
        BEAM_WGSL,
        OPEN_SEA_WGSL,
        roles ? COMPOSITE_ROLES_MAIN_WGSL : COMPOSITE_MAIN_WGSL,
    ].join('\n');
}

/** The particle module: `particleVs` + `particleFs` over group 0. */
export function assembleParticle() {
    return [WGSL_COMMON, FRAME_BINDINGS_WGSL, GRADE_WGSL, ATMOSPHERE_WGSL, PARTICLE_WGSL].join('\n');
}
