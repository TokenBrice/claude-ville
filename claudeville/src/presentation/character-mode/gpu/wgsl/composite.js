// Wave 10 — the WGSL twin of GpuWorldRenderer COMPOSITE_FRAGMENT: the scene
// target, the open sea under every scene.a < 1 pixel below the horizon (4.6
// fat-pixel coverage on a flight frame), the lightning flash as an exposure
// step, then the bloom add. The composite draws the canvas unmirrored, so
// `in.position.xy` is GL's (gl_FragCoord.x, u_resolution.y - gl_FragCoord.y)
// exactly; the scene target holds GL's rows (scene.js), so the texel GL's
// nearest v_uv read picks is row H - 1 - y, and `in.uv` is GL's bottom-left
// v_uv for the bloom result (also GL rows, bloom.js). The open sea
// (`shadeOpenSea`, wgsl/openSea.js) and the fat taps (wgsl/fatTaps.js) are
// SceneB's.
//
// 10.2 / 10.3 (contract §7.2, §7.5) — `compositeRolesFs` is a separate entry
// point in a separate module (index.js `assembleComposite({ roles: true })`),
// built only on an HDR or P3 screen: `compositeFs` below stays the shipped
// SDR shader, so an SDR screen never runs a single extra instruction.
import { FULLSCREEN_WGSL } from './common.js';
import {
    columnMajor,
    EMISSION_LUMA,
    HDR_EMITTER_COURSE_LUMA,
    LINEAR_SRGB_FROM_OKLAB_LMS,
    LMS_CBRT_FROM_OKLAB,
    OKLAB_FROM_LMS_CBRT,
    OKLAB_LMS_FROM_LINEAR_SRGB,
    P3_LUMA,
    P3_ROLE_CHROMA,
    SRGB_LUMA,
    SRGB_TO_P3,
} from '../../DisplayColor.js';

const COMPOSITE_SCENE_WGSL = /* wgsl */ `
  let scene = textureLoad(sceneColor, vec2i(i32(in.position.x), i32(textureDimensions(sceneColor).y) - 1 - i32(in.position.y)), 0);
  var bloomRgb = vec3f(0.0);
  if (frame.bloomStrength != 0.0) {
    bloomRgb = textureSampleLevel(bloomColor, linearSampler, clamp(in.uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  }
  var color = scene.rgb;
  var alpha = scene.a;
  if (frame.seaOn != 0u && alpha < 1.0) {
    let world = in.position.xy / frame.cameraScale - frame.cameraXy;
    var taps = FatTaps(floor(world), vec2f(0.0));
    if (frame.fatPixels != 0u) { taps = fatTaps(world, vec2f(1.0 / frame.cameraScale)); }
    if (fatSeam(taps)) {
      var sea = vec4f(0.0);
      for (var i = 0; i < 4; i++) {
        let w = fatTapWeight(taps, i);
        let cell = taps.base + fatTapOffset(i);
        if (w > 0.0 && cell.y >= OPEN_SEA_HORIZON_Y) { sea += vec4f(shadeOpenSea(cell), 1.0) * w; }
      }
      color += sea.rgb * (1.0 - alpha);
      alpha += sea.a * (1.0 - alpha);
    } else if (world.y >= OPEN_SEA_HORIZON_Y) {
      color += shadeOpenSea(floor(world)) * (1.0 - alpha);
      alpha = 1.0;
    }
  }
  color *= vec3f(1.0) + frame.flash;`;

export const COMPOSITE_MAIN_WGSL = /* wgsl */ `
@fragment fn compositeFs(in: FullscreenOut) -> @location(0) vec4f {${COMPOSITE_SCENE_WGSL}
  return vec4f(color + bloomRgb * frame.bloomStrength, alpha);
}
`;

// The sRGB transfer pair, the sRGB → Display P3 matrix, OKLab and the role
// constants, generated from DisplayColor.js (shared by the roles composite
// and the roles mark fragment).
export const DISPLAY_COLOR_WGSL = /* wgsl */ `
const SRGB_TO_P3 = mat3x3f(${columnMajor(SRGB_TO_P3)});
const OKLAB_LMS = mat3x3f(${columnMajor(OKLAB_LMS_FROM_LINEAR_SRGB, 10)});
const OKLAB_LAB = mat3x3f(${columnMajor(OKLAB_FROM_LMS_CBRT, 10)});
const OKLAB_LMS_INV = mat3x3f(${columnMajor(LMS_CBRT_FROM_OKLAB, 10)});
const OKLAB_RGB = mat3x3f(${columnMajor(LINEAR_SRGB_FROM_OKLAB_LMS, 10)});
const EMISSION_LUMA = vec3f(${EMISSION_LUMA.join(', ')});
const EMITTER_COURSE_LUMA = vec3f(${HDR_EMITTER_COURSE_LUMA.map(value => value.toFixed(2)).join(', ')});
const P3_ROLE_CHROMA = ${P3_ROLE_CHROMA.toFixed(2)};
const SRGB_LUMA = vec3f(${SRGB_LUMA.map(value => value.toFixed(9)).join(', ')});
const P3_LUMA = vec3f(${P3_LUMA.map(value => value.toFixed(9)).join(', ')});
fn srgbEotf(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn srgbOetf(c: vec3f) -> vec3f { return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3f(0.0031308)); }
fn oklabFromLinearSrgb(c: vec3f) -> vec3f {
  let lms = OKLAB_LMS * c;
  return OKLAB_LAB * (sign(lms) * pow(abs(lms), vec3f(1.0 / 3.0)));
}
fn p3FromOklab(lab: vec3f) -> vec3f {
  let lms = OKLAB_LMS_INV * lab;
  return SRGB_TO_P3 * (OKLAB_RGB * (lms * lms * lms));
}
fn outsideUnit(c: vec3f) -> bool { return any(c < vec3f(-1e-4)) || any(c > vec3f(1.0 + 1e-4)); }
// 10.3 — a role pixel (linear sRGB in) as linear Display P3 with its OKLab
// chroma x P3_ROLE_CHROMA at the same OKLab lightness and hue, the stretch
// bisected down until it fits the P3 gamut (never below the pixel itself).
fn p3RoleChroma(lin: vec3f) -> vec3f {
  let lab = oklabFromLinearSrgb(lin);
  var p3 = p3FromOklab(vec3f(lab.x, lab.yz * P3_ROLE_CHROMA));
  if (outsideUnit(p3)) {
    p3 = SRGB_TO_P3 * lin;
    var lo = 1.0;
    var hi = P3_ROLE_CHROMA;
    for (var i = 0; i < 8; i++) {
      let mid = 0.5 * (lo + hi);
      let t = p3FromOklab(vec3f(lab.x, lab.yz * mid));
      if (outsideUnit(t)) { hi = mid; } else { lo = mid; p3 = t; }
    }
  }
  return clamp(p3, vec3f(0.0), vec3f(1.0));
}
`;

// The roles composite reads the emission attachment too (alpha = role 1 for
// a building/prop emitter batch, rgb = its emission) at the scene texel.
export const COMPOSITE_ROLES_BINDING = Object.freeze({ sceneEmission: 2 });
export const COMPOSITE_ROLES_BINDINGS_WGSL = /* wgsl */ `
@group(1) @binding(${COMPOSITE_ROLES_BINDING.sceneEmission}) var sceneEmission: texture_2d<f32>;
`;

// A role-1 pixel is an emitter batch's top fragment with emission luma on a
// course. HDR (frame.hdrEnabled; the canvas is rgba16float/extended) gains
// its linear light by the course's gain — oetf(eotf(c) * gain), so its
// chromaticity is exact — up to the mode's emitter cap: the gain stops where
// the pixel's luminance (in the canvas's own primaries) would reach
// frame.hdrEmitterCap, just under the NEEDS YOU mark at the mark gain. The
// cap is at least SDR white (DisplayColor), so no gain drops below 1. Every
// other pixel holds the 8-bit step the SDR canvas would store, so nothing
// but role pixels moves. P3 (frame.p3Enabled; the canvas is display-p3)
// converts every pixel to P3 numbers and stretches role pixels' chroma.
// Bloom strength is 0 under HDR.
export const COMPOSITE_ROLES_MAIN_WGSL = /* wgsl */ `
@fragment fn compositeRolesFs(in: FullscreenOut) -> @location(0) vec4f {${COMPOSITE_SCENE_WGSL}
  let rgb = color + bloomRgb * frame.bloomStrength;
  let emission = textureLoad(sceneEmission, vec2i(i32(in.position.x), i32(textureDimensions(sceneEmission).y) - 1 - i32(in.position.y)), 0);
  let lum = dot(emission.rgb, EMISSION_LUMA);
  let course = u32(lum >= EMITTER_COURSE_LUMA.x) + u32(lum >= EMITTER_COURSE_LUMA.y) + u32(lum >= EMITTER_COURSE_LUMA.z);
  let role = emission.a >= 0.5 && course > 0u;
  // While the lamps are out the emitter gains are 1: a role pixel is then an
  // ordinary pixel (no eotf/oetf round trip).
  let gain = select(1.0, frame.hdrEmitterGain[max(course, 1u) - 1u], frame.hdrEnabled != 0u && role);
  let hdr = gain != 1.0;
  if (frame.p3Enabled == 0u && !hdr) {
    return vec4f(round(clamp(rgb, vec3f(0.0), vec3f(1.0)) * 255.0) / 255.0, round(clamp(alpha, 0.0, 1.0) * 255.0) / 255.0);
  }
  let a = clamp(alpha, 0.0, 1.0);
  var lin = srgbEotf(clamp(rgb, vec3f(0.0), vec3f(1.0)) / max(a, 1.0 / 255.0));
  if (frame.p3Enabled != 0u) {
    if (role) { lin = p3RoleChroma(lin); } else { lin = SRGB_TO_P3 * lin; }
  }
  if (hdr) { lin *= min(gain, frame.hdrEmitterCap / max(dot(lin, select(SRGB_LUMA, P3_LUMA, frame.p3Enabled != 0u)), 1e-6)); }
  return vec4f(srgbOetf(lin) * a, a);
}
`;

// 0.3 / 10.2 — the presented HDR frame (rgba16float/extended) as the SDR
// bytes a 2D canvas can read: the nearest canvas texel at each target pixel
// centre (the reveal bands' point samples), highlights clamped to white.
// Chrome cannot copy an rgba16float swap chain into its BGRA8 raster image
// (a drawImage of the HDR canvas raises a validation error on our device),
// so the reveal bands read this small SDR surface instead.
export const HDR_READOUT_WGSL = /* wgsl */ `
${FULLSCREEN_WGSL}
@group(0) @binding(0) var presented: texture_2d<f32>;
@fragment fn hdrReadoutFs(in: FullscreenOut) -> @location(0) vec4f {
  let size = textureDimensions(presented);
  let texel = min(vec2u(vec2f(in.uv.x, 1.0 - in.uv.y) * vec2f(size)), size - vec2u(1u));
  let c = textureLoad(presented, texel, 0);
  let a = clamp(c.a, 0.0, 1.0);
  return vec4f(clamp(c.rgb, vec3f(0.0), vec3f(a)), a);
}
`;
