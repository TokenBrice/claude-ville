// Wave 10 (10.1 Stage A) — the WGSL twin of GpuWorldRenderer's record vertex
// stage (`quadVertexSource`) and of SCENE_FRAGMENT's surface chain, light
// loop and landings (contract §6 S1). Transliterated expression for
// expression from the GLSL, with every number interpolated from the JS
// constant the GLSL interpolates (never copied): GLSL `mod` is `glslMod`,
// `texture()` is `textureSampleLevel(..., 0.0)` on the same sampler state,
// `texelFetch` is `textureLoad` (the light records' is a storage-buffer read,
// `lightRecord`), an `out`/`inout` parameter is a
// `ptr<function, T>`, and GLSL's conditional expressions become `select`
// only where both arms are pure and in range (else an if/else, as GLSL
// evaluates one arm). The water-state helpers (coastFieldAt, applyWaterState,
// applyCoastSwash, mirrorStormColour, reflectionRippleUv, the water palette,
// `lighthouseDash`), the fat-pixel taps, the atmosphere courses, the cue-run
// vertex and the radiance reader are the other includes' (wgsl/water.js,
// fatTaps.js, atmosphere.js, cueRun.js, radiance.js); the grade and pool
// landings are grade.js; bindings, uniform blocks and the record struct are
// common.js. `assembleScene` (wgsl/index.js) concatenates them.
//
// Parity hazards (contract §3.2) handled here:
// - P2: every derivative is taken at the top of the fragment entry, in
//   uniform control flow, before any discard (as the GLSL does); the entry
//   also carries @diagnostic(off, derivative_uniformity).
// - P3/P12: every texelFetch site keeps the GLSL's own bounds check before
//   the textureLoad, and every float->int conversion the GLSL's clamp.
// - P8: the max(..., eps) guards are kept verbatim; the colour is clamped at
//   0 before the write.
// - Y / rasterization: ANGLE on Metal draws a GL framebuffer object mirrored
//   (GL row 0, the bottom, is the texture's first row), so its rasterizer
//   sees every scene-pass triangle at mirrored window coordinates; the
//   interpolants it produces there differ from an unmirrored draw by an ulp,
//   enough to flip a NEAREST lookup whose pixel centre falls exactly on a
//   texel seam (a 32-texel prop drawn 48 px tall). `sceneVs` therefore
//   draws the scene target in GL row order too (clip y negated, exact): the
//   scene/emission targets hold GL's rows (row 0 = bottom, as GL's FBO), and
//   @builtin(position) in sceneFs IS the GLSL's gl_FragCoord, read verbatim.
//   Passes that read the scene target sample it GL-style; captures flip it.
//   `markVs` (the mark pass, drawn on the presented frame: GL's default
//   framebuffer, which ANGLE does not mirror) keeps WebGPU's orientation.
// - Depth: GL writes z_ndc = key*2-1 over [-1, 1]; WebGPU's NDC z is the
//   window depth itself, so the vertex writes 1 - key/65535 directly.
import {
    LIGHT_RECORD_FLAGS,
    LIGHT_ROLE_CODES,
    LIGHT_TILE_PX,
    LIGHT_TILE_STRIDE,
    MAX_LIGHT_RECORDS,
    WATER_COLUMN_REACH,
} from '../GpuWorldPolicy.js';
import {
    APERTURE_WALL_AHEAD,
    WATER_COLUMN_GLINT,
    WATER_COLUMN_ROW_FAR,
    WATER_COLUMN_ROW_HOLD,
    WATER_COLUMN_ROW_NEAR,
    WATER_COLUMN_TICK_RATE,
} from '../GpuWorldRenderer.js';
import { COAST_FIELD_FLAGS } from '../../CoastBake.js';
import { GROUND_CAST_WATER_SHARE } from '../../RakingLight.js';
import { APERTURE_SPILL } from '../../LightSourceRegistry.js';

const LIGHT_ROLE_ATTENTION = LIGHT_ROLE_CODES.attention;

export const SCENE_WGSL = /* wgsl */ `
// ---- The record vertex stage (quadVertexSource) ----------------------------
// The GLSL varyings, one location each except the four loc2 surface values
// (one vec4) and gate/ramp (one vec2): 13 locations. Interpolated fields keep
// GL's default (perspective, centre); per-record values are flat.
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec2f,
  // alpha, material, elevation, emissive (loc2)
  @location(2) surface: vec4f,
  // gate (loc3.y / 65535), ramp (loc3.z)
  @location(3) gateRamp: vec2f,
  // 4.6 / B.1b — the fat path's record-local texel position.
  @location(4) texel: vec2f,
  @location(5) @interpolate(flat) originFrac: vec2f,
  @location(6) @interpolate(flat) uvClamp: vec4f,
  @location(7) @interpolate(flat) receiver: vec3f,
  @location(8) @interpolate(flat) layer: f32,
  @location(9) @interpolate(flat) identity: vec2u,
  @location(10) @interpolate(flat) flags: u32,
  @location(11) @interpolate(flat) texelRect: vec4i,
  // 3.8 / 3.11 — a reflect record's mirror axis and rect height.
  @location(12) @interpolate(flat) reflectAxis: vec2f,
}

// glRows: draw in GL row order (the scene target), see the header.
fn sceneVertex(vi: u32, ii: u32, glRows: bool) -> VsOut {
  let r = recs[ii];
  let response = recordLoc3(r);
  let receiver = recordLoc4(r);
  // Strip corners (0,0) (1,0) (0,1) (1,1), each coordinate selected from the
  // staged rect. B.3 — a cue-run batch draws six vertices per dot.
  let flags = u32(response.w + 0.5);
  var corner = i32(vi);
  var rect = recordLoc0(r);
  var uvRect = recordLoc1(r);
  if (batch.cueRuns != 0u) { cueRunVertex(i32(vi), flags, &corner, &rect, &uvRect); }
  let right = (corner & 1) == 1;
  let bottom = corner >= 2;
  var world = vec2f(select(rect.x, rect.x + rect.z, right), select(rect.y, rect.y + rect.w, bottom));
  // 3.8 / 3.11 — a reflect record mirrors about its base.
  let mirrored = (flags & RECORD_FLAG_REFLECT) != 0u;
  let reflectBase = rect.y + rect.w;
  if (mirrored) { world.y = 2.0 * reflectBase - world.y; }
  var out: VsOut;
  out.reflectAxis = select(vec2f(0.0), vec2f(reflectBase, rect.w), mirrored);
  // V9 screenSpace (Wave 10 S5) — the rect is already in backing pixels
  // (top-left origin) and passes straight through.
  let screenSpace = (flags & RECORD_FLAG_SCREEN_SPACE) != 0u;
  var screen = world;
  if (!screenSpace) { screen = (world + frame.cameraXy) * frame.cameraScale; }
  var clip = vec2f(
    screen.x / max(1.0, frame.resolution.x) * 2.0 - 1.0,
    1.0 - screen.y / max(1.0, frame.resolution.y) * 2.0
  );
  if (glRows) { clip.y = -clip.y; }
  // 0.6 — the painter depth key (0 = far plane, 65535 = nearest).
  out.position = vec4f(clip, 1.0 - receiver.x / 65535.0, 1.0);
  out.uv = vec2f(select(uvRect.x, uvRect.z, right), select(uvRect.y, uvRect.w, bottom));
  out.world = world;
  out.surface = recordLoc2(r);
  out.gateRamp = vec2f(response.y / 65535.0, response.z);
  // PT-1 / M4 — a sprite record shades on its own origin's grid; ground-self
  // records (footY -1) and screen-space records keep the world grid.
  let worldGrid = screenSpace || receiver.y == RECEIVER_BIAS - 1.0;
  out.originFrac = select(fract(rect.xy), vec2f(0.0), worldGrid);
  // The record-rect clamp, inset half a texel but never past its centre.
  let uvLow = min(uvRect.xy, uvRect.zw);
  let uvHigh = max(uvRect.xy, uvRect.zw);
  let albedoTexels = vec2f(select(textureDimensions(albedo), textureDimensions(albedoPage), batch.albedoPaged != 0u));
  let inset = min(0.5 / albedoTexels, (uvHigh - uvLow) * 0.5);
  out.uvClamp = vec4f(uvLow + inset, uvHigh - inset);
  let texRect = floor(uvRect * albedoTexels.xyxy + 0.5);
  let texOrigin = min(texRect.xy, texRect.zw);
  out.texel = vec2f(select(texRect.x, texRect.z, right), select(texRect.y, texRect.w, bottom)) - texOrigin;
  out.texelRect = vec4i(vec2i(texOrigin), vec2i(max(abs(texRect.zw - texRect.xy) - 1.0, vec2f(0.0))));
  out.receiver = receiver.yzw - RECEIVER_BIAS;
  out.identity = recordLoc5(r);
  out.flags = flags;
  out.layer = response.x;
  return out;
}

// The scene MRT pass (scene + emission targets in GL row order).
@vertex fn sceneVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  return sceneVertex(vi, ii, true);
}

// The T1 mark pass (Wave 10 S5), drawn on the presented frame.
@vertex fn markVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  return sceneVertex(vi, ii, false);
}

// ---- SCENE_FRAGMENT ---------------------------------------------------------
// The GLSL varyings, mirrored at the top of sceneFs so every helper reads them
// by their GLSL names (the water helpers read v_world and v_uvClamp).
var<private> v_uv: vec2f;
var<private> v_world: vec2f;
var<private> v_alpha: f32;
var<private> v_material: f32;
var<private> v_elevation: f32;
var<private> v_emissive: f32;
var<private> v_gate: f32;
var<private> v_ramp: f32;
var<private> v_originFrac: vec2f;
var<private> v_uvClamp: vec4f;
var<private> v_receiver: vec3f;
var<private> v_identity: vec2u;
var<private> v_flags: u32;
var<private> v_reflect: vec2f;
var<private> v_texel: vec2f;
var<private> v_texelRect: vec4i;
var<private> v_layer: f32;
// GLSL's gl_FragCoord: sceneFs's @builtin(position), the scene target being
// in GL row order (bottom-left origin, pixel centres).
var<private> glFragCoord: vec4f;

// B.1b — a paged record's albedo is its layer of the batch's page; the branch
// is uniform per batch.
fn albedoTexture(uv: vec2f) -> vec4f {
  if (batch.albedoPaged != 0u) { return textureSampleLevel(albedoPage, albedoSampler, uv, i32(v_layer), 0.0); }
  return textureSampleLevel(albedo, albedoSampler, uv, 0.0);
}
fn albedoTexel(texel: vec2i) -> vec4f {
  if (batch.albedoPaged != 0u) { return textureLoad(albedoPage, texel, i32(v_layer), 0); }
  return textureLoad(albedo, texel, 0);
}
fn albedoSize() -> vec2i {
  if (batch.albedoPaged != 0u) { return vec2i(textureDimensions(albedoPage)); }
  return vec2i(textureDimensions(albedo));
}

// 4.6 (PT-2, M4) — fat-pixel flight frames; footprints are taken at the top
// of the fragment entry.
var<private> fatOn: bool = false;
var<private> fatTexelFw: vec2f = vec2f(1.0);
var<private> fatWorldFw: vec2f = vec2f(1.0);
var<private> fatAlbedoPix: vec2f = vec2f(0.0);
var<private> fatAlbedoTaps: FatTaps;
var<private> fatTap: array<vec4f, 4>;
fn fatPremultiplied(c: vec4f) -> vec4f { return vec4f(c.rgb * c.a, c.a); }
fn sampleAlbedo(uv: vec2f) -> vec4f {
  if (!fatOn) { return albedoTexture(uv); }
  let hi = v_texelRect.zw;
  let edge = vec2f(hi) + 0.5;
  let shift = floor((uv - clamp(v_uv, v_uvClamp.xy, v_uvClamp.zw)) * vec2f(albedoSize()) + 0.5);
  fatAlbedoPix = clamp(clamp(v_texel, vec2f(0.5), edge) + shift, vec2f(0.5), edge);
  // A shift the clamp cut short rests on the edge texel's centre.
  fatAlbedoPix = mix(fatAlbedoPix, vec2f(0.5), vec2f(uv == v_uvClamp.xy));
  fatAlbedoPix = mix(fatAlbedoPix, edge, vec2f(uv == v_uvClamp.zw));
  let t = fatTaps(fatAlbedoPix, fatTexelFw);
  fatAlbedoTaps = t;
  let lo = vec2i(0);
  let origin = v_texelRect.xy;
  let b = vec2i(t.base);
  fatTap[0] = albedoTexel(origin + clamp(b, lo, hi));
  if (!fatSeam(t)) { return fatTap[0]; }
  fatTap[1] = albedoTexel(origin + clamp(b + vec2i(1, 0), lo, hi));
  fatTap[2] = albedoTexel(origin + clamp(b + vec2i(0, 1), lo, hi));
  fatTap[3] = albedoTexel(origin + clamp(b + vec2i(1, 1), lo, hi));
  let m = mix(
    mix(fatPremultiplied(fatTap[0]), fatPremultiplied(fatTap[1]), t.w.x),
    mix(fatPremultiplied(fatTap[2]), fatPremultiplied(fatTap[3]), t.w.x),
    t.w.y);
  if (m.a > 0.0) { return vec4f(m.rgb / m.a, m.a); }
  return vec4f(0.0);
}

fn materialNear(value: f32, goal: f32) -> f32 {
  return 1.0 - step(0.45, abs(value - goal));
}

// 2.2 — world-locked footprint occlusion (R4: a housed light skips the
// samples still inside its own housing).
fn footprintBlocked(fromPoint: vec2f, toPoint: vec2f, fromH: f32, toH: f32, ownLandmark: u32, lightLandmark: u32, fixture: bool) -> f32 {
  let steps = f32(frame.marchSteps);
  let lightCell = vec2i(floor((toPoint - frame.footprintRect.xy) / frame.footprintRect.z));
  var housed = frame.marchSteps > 0 && lightCell.x >= 0 && lightCell.y >= 0
    && lightCell.x < frame.footprintSize.x && lightCell.y < frame.footprintSize.y
    && textureLoad(footprint, lightCell, 0).r * 255.0 > toH + 2.0;
  for (var k = 0; k < 8; k++) {
    if (k >= frame.marchSteps) { break; }
    let s = frame.marchSteps - k;
    let t = f32(s) / (steps + 1.0);
    let p = mix(fromPoint, toPoint, t);
    if (fixture && distance(p, toPoint) < 10.0) { continue; }
    let cell = vec2i(floor((p - frame.footprintRect.xy) / frame.footprintRect.z));
    var occupied = false;
    if (cell.x >= 0 && cell.y >= 0 && cell.x < frame.footprintSize.x && cell.y < frame.footprintSize.y) {
      let field = textureLoad(footprint, cell, 0).rg;
      let landmark = u32(field.g * 255.0 + 0.5);
      occupied = !(landmark != 0u && (landmark == ownLandmark || landmark == lightLandmark))
        && field.r * 255.0 > mix(fromH, toH, t) + 2.0;
    }
    if (housed) {
      housed = occupied;
      continue;
    }
    if (occupied) { return 1.0; }
  }
  return 0.0;
}

fn orderedDither4(px: vec2f) -> f32 {
  return glslMod(floor(px.x) + 2.0 * floor(px.y), 4.0) / 3.0;
}

fn applyMaterialWeather(color0: vec3f, material: f32, px: vec2f) -> vec3f {
  var color = color0;
  let rain = frame.weather.x;
  let wetness = materialWetness(material);
  let reflection = materialReflection(material);
  let foliage = materialNear(material, 4.0);
  let phase = select(frame.timeMs * 0.001 * frame.motionScale, 0.37, frame.motionScale <= 0.0);
  let ordered = orderedDither4(px);
  // 3.2 — darkening follows the accumulated surface wetness.
  let wet = max(rain, frame.wetness) * wetness;
  color *= mix(1.0, 0.80, wet);
  color = mix(color, color * vec3f(0.82, 0.94, 1.08), wet * 0.24);
  let glintShare = select(1.0, 0.30, frame.wetReflectionCount > 0);
  let glint = step(0.86, fract((px.x + px.y * 0.5) * 0.031 + phase * 0.07 + ordered * 0.08));
  color += vec3f(0.22, 0.30, 0.34) * glint * wet * reflection * 0.16 * glintShare;
  color = mix(color, color * vec3f(0.86, 0.94, 0.82), rain * foliage * 0.12);
  return color;
}

fn puddleAt(cell: vec2i) -> f32 {
  if (cell.x < 0 || cell.y < 0 || cell.x >= i32(frame.puddleRect.z) || cell.y >= i32(frame.puddleRect.w)) { return 0.0; }
  let mask = textureLoad(puddleMask, cell, 0).r;
  return select(0.0, 1.0, mask > 0.0 && mask >= 1.0 - frame.puddles);
}

// 5.2 — a puddle reflects the graded sky in stepped opaque courses on the
// ground's own 2x1 texel grid.
fn applyPuddle(color: vec3f, world: vec2f) -> vec3f {
  let local = world - frame.puddleRect.xy;
  let cell = vec2i(i32(floor(local.x * 0.5)), i32(floor(local.y)));
  if (puddleAt(cell) < 0.5) { return color; }
  let groundLuma = dot(color, GRADE_LUMA);
  let cap = min(0.56, groundLuma * 1.30 + 0.06);
  var body = frame.puddleSky[0].xyz;
  let bodyLuma = dot(body, GRADE_LUMA);
  if (bodyLuma > cap) { body *= cap / max(bodyLuma, 1e-4); }
  body = mix(body, color, 0.28);
  if (puddleAt(cell + vec2i(0, -1)) < 0.5) { return color * 0.64; }
  if (puddleAt(cell + vec2i(0, 1)) < 0.5) {
    let glint = fract(sin(dot(vec2f(cell), vec2f(12.9898, 78.233))) * 43758.5453);
    if (glint < 0.42) {
      var edge = frame.puddleSky[1].xyz;
      let edgeLuma = dot(edge, GRADE_LUMA);
      let edgeCap = min(0.62, cap + 0.06);
      if (edgeLuma > edgeCap) { edge *= edgeCap / max(edgeLuma, 1e-4); }
      return edge;
    }
  }
  let depth = textureLoad(puddleMask, cell, 0).r - (1.0 - frame.puddles);
  if (depth < 0.12) { return mix(body, color, 0.5); }
  return body;
}

// 4.6 — a terrain pixel a world-texel seam crosses on a flight frame: the
// per-cell surface chain runs on each tap's own authored texel at that
// texel's world point, blended by coverage.
fn fatTerrainSurface(material: f32, waterMaterial: bool, waterHue: ptr<function, bool>, seaPath: ptr<function, bool>) -> vec3f {
  let t = fatAlbedoTaps;
  let worldPerTexel = fatWorldFw / fatTexelFw;
  let weather = frame.weather.x > 0.001 || frame.wetness > 0.001;
  var anyWater = waterMaterial;
  var surface = vec4f(0.0);
  var before = vec4f(0.0);
  var dominant = -1.0;
  var dominantPath = false;
  var dominantDash = false;
  for (var i = 0; i < 4; i++) {
    let w = fatTapWeight(t, i) * fatTap[i].a;
    if (w <= 0.0) { continue; }
    let world = v_world + (t.base + fatTapOffset(i) + 0.5 - fatAlbedoPix) * worldPerTexel;
    var c = fatTap[i].rgb;
    var gone = false;
    c = mirrorStormColour(c, world, &gone);
    let tapWater = waterMaterial || gone;
    anyWater = anyWater || gone;
    if (frame.waterFx.w > 0.0) { c = applyCoastSwash(c, world); }
    if (weather && !tapWater) { c = applyMaterialWeather(c, material, world); }
    before += vec4f(c, 1.0) * w;
    var tapPath = false;
    lighthouseDash = false;
    if (tapWater) { c = applyWaterState(c, world, &tapPath); }
    if (w > dominant) {
      dominant = w;
      dominantPath = tapPath;
      dominantDash = lighthouseDash;
    }
    surface += vec4f(c, 1.0) * w;
  }
  lighthouseDash = dominantDash;
  *seaPath = dominantPath;
  let pre = before.rgb / max(before.a, 1e-6);
  *waterHue = anyWater && !(pre.b < pre.r + 0.02 || pre.g < pre.r);
  if (surface.a > 0.0) { return surface.rgb / surface.a; }
  return pre;
}

fn applyAuthoredSunBand(color: vec3f, material: f32) -> vec3f {
  var response = 0.36;
  response = mix(response, 0.62, materialNear(material, 1.0));
  response = mix(response, 0.48, materialNear(material, 2.0));
  response = mix(response, 0.82, materialNear(material, 3.0));
  response = mix(response, 0.56, materialNear(material, 4.0));
  response = mix(response, 0.42, materialNear(material, 5.0));
  response = mix(response, 0.58, materialNear(material, 7.0));
  response = mix(response, 0.24, materialNear(material, 8.0));
  let keyFacing = clamp(0.5 + (-frame.sun.x - frame.sun.y) * 0.25, 0.0, 1.0);
  let rawBand = 0.84 + response * (0.12 + keyFacing * 0.12);
  let quantized = select(1.0, 0.86, rawBand < 0.93);
  return color * mix(1.0, quantized, clamp(frame.sun.w, 0.0, 1.0));
}

// 2.9 — one light's water column at the art cell: how many water stops the
// texel is lifted (0 = no column texel, 1..5).
fn columnLift(cell: vec2f, footX: f32, along: f32, reach: f32, energy: f32, halfNear: f32, tick: f32) -> f32 {
  if (along < 0.0 || along >= reach) { return 0.0; }
  let t = along / reach;
  let row = vec2f(cell.y, floor(footX));
  let hold = ${WATER_COLUMN_ROW_HOLD.toFixed(1)};
  let life = floor((tick + floor(waterHash12(row + vec2f(3.0, 17.0)) * hold)) / hold);
  let present = mix(${WATER_COLUMN_ROW_NEAR.toFixed(2)}, ${WATER_COLUMN_ROW_FAR.toFixed(2)}, t);
  if (waterHash12(row + vec2f(life * 7.0 + 11.0, life * 3.0 + 29.0)) >= present) { return 0.0; }
  let dx = cell.x - floor(footX) - floor(1.5 * sin(cell.y * 0.7 + tick));
  let halfWidth = floor(mix(halfNear, 1.0, t) + 0.5);
  let lo = -max(0.0, halfWidth + floor(waterHash12(row + vec2f(life * 5.0 + 41.0, 13.0)) * 3.0) - 1.0);
  let hi = max(0.0, halfWidth + floor(waterHash12(row + vec2f(life * 13.0 + 47.0, 19.0)) * 3.0) - 1.0);
  if (dx < lo || dx > hi) { return 0.0; }
  let spark = waterHash12(row + vec2f(life * 17.0 + 61.0, 23.0));
  if (hi - lo >= 4.0 && spark < 0.55 && dx == select(hi - 1.0, lo + 1.0, spark < 0.275)) { return 0.0; }
  let q = mix(0.8, 0.3, t) * energy + (waterHash12(row + vec2f(life * 19.0 + 71.0, 31.0)) - 0.5) * 0.3;
  var lift = step(0.12, q) * (1.0 + step(0.35, q) + step(0.75, q) + step(1.15, q));
  if (lift < 0.5) { return 0.0; }
  if (hi > lo && (dx == lo || dx == hi)) { return lift - 1.0; }
  if (abs(dx - 0.5 * (lo + hi)) < 0.75) { lift += 1.0; }
  if (t < 0.5 && waterHash12(row + vec2f(life * 11.0 + 53.0, 7.0)) < ${WATER_COLUMN_GLINT.toFixed(2)}) { lift += 1.0; }
  return min(lift, 5.0);
}

// 2.9 — the luma lift stops above the local water stop on the water ramp.
fn columnRampLuma(stop: i32, lift: f32) -> f32 {
  let i = stop - i32(lift + 0.5);
  var c = WATER_FOAM_CREST;
  if (i >= 0) {
    c = waterStopRgb(i);
  } else if (i == -1) {
    c = WATER_FOAM;
  }
  return dot(c, GRADE_LUMA);
}

// What the surface half of main() hands the light half.
struct SurfaceSample {
  uv: vec2f,
  uvStepX: f32,
  reflectRecord: bool,
  albedo: vec4f,
  alpha: f32,
  material: f32,
  emissive: f32,
  emissionColor: vec3f,
  geometry: vec4f,
  surfaceCoded: bool,
  elevation: f32,
  color: vec3f,
  waterMaterial: bool,
  poolAlbedo: vec3f,
  emitterWeight: f32,
  receiverLuma: f32,
}

// main() up to the receiver knee's floor: the sampled, weathered, water-state
// and graded surface.
fn sceneSurface() -> SurfaceSample {
  // V9 — sample inside the record's own source rect.
  var uv = clamp(v_uv, v_uvClamp.xy, v_uvClamp.zw);
  // 2.1 — one source texel along world +x, before any non-uniform branch.
  let uvStepX = select(1.0, -1.0, dpdx(v_uv.x) < 0.0) / f32(albedoSize().x);
  // 4.6 — flight-frame footprints, in uniform control flow.
  fatTexelFw = max(fwidth(v_texel), vec2f(1e-5));
  fatWorldFw = max(fwidth(v_world), vec2f(1e-5));
  fatOn = batch.fatPixels != 0u && (v_flags & RECORD_FLAG_FAT_OPT_OUT) == 0u;
  // 3.8 / 3.11 — reflect records.
  let reflectRecord = (v_flags & RECORD_FLAG_REFLECT) != 0u;
  var reflectRow = 0.0;
  var reflectSd = 0.0;
  var rowKeep = 1.0;
  if (reflectRecord) {
    reflectRow = floor(v_world.y - v_reflect.x);
    var reflectTaps = FatTaps(vec2f(0.0, reflectRow), vec2f(0.0));
    if (fatOn) { reflectTaps = fatTaps(v_world - vec2f(0.0, v_reflect.x), fatWorldFw); }
    rowKeep = mix(step(glslMod(reflectTaps.base.y, 5.0), 3.5), step(glslMod(reflectTaps.base.y + 1.0, 5.0), 3.5), reflectTaps.w.y);
    if (rowKeep <= 0.0) { discard; }
    var reflectFlags = 0u;
    if (!coastFieldAt(v_world, &reflectSd, &reflectFlags) || (reflectFlags & 4u) == 0u) { discard; }
    let tick = select(floor(frame.timeMs * 0.004 * frame.motionScale), 0.0, frame.motionScale <= 0.0);
    let ripple = clamp(floor(1.5 * sin(reflectRow * 0.9 + tick * 0.7)), -1.0, 1.0);
    uv.x = clamp(uv.x + ripple * uvStepX, v_uvClamp.x, v_uvClamp.z);
  }
  // 2.9 (WS) — a building or tree ground cast over painted water.
  var castOnWater = false;
  if ((v_flags & RECORD_FLAG_GROUND_CAST) != 0u) {
    var castSd = 0.0;
    var castFlags = 0u;
    castOnWater = coastFieldAt(v_world, &castSd, &castFlags)
      && (castFlags & ${COAST_FIELD_FLAGS.water}u) != 0u
      && (castFlags & ${COAST_FIELD_FLAGS.covered}u) == 0u;
    if (castOnWater) {
      let castRow = floor(v_world.y);
      let castTick = floor(frame.timeMs * ${WATER_COLUMN_TICK_RATE} * frame.waterFx.x);
      var castTaps = FatTaps(vec2f(0.0, castRow), vec2f(0.0));
      if (fatOn) { castTaps = fatTaps(v_world, fatWorldFw); }
      rowKeep = mix(step(glslMod(castTaps.base.y + castTick, 3.0), 1.5), step(glslMod(castTaps.base.y + 1.0 + castTick, 3.0), 1.5), castTaps.w.y);
      if (rowKeep <= 0.0) { discard; }
      let castWobble = floor(1.5 * sin(castRow * 0.7 + castTick));
      uv.x = clamp(uv.x - castWobble * uvStepX, v_uvClamp.x, v_uvClamp.z);
    }
  }
  if (batch.terrainBatch != 0u && frame.waterFx.x > 0.0) { uv = reflectionRippleUv(uv, uvStepX); }
  var albedoRgba = sampleAlbedo(uv);
  var alpha = albedoRgba.a * v_alpha * rowKeep * select(1.0, ${GROUND_CAST_WATER_SHARE.toFixed(2)}, castOnWater);
  if (alpha < 0.01) { discard; }
  if (reflectRecord) {
    let course = clamp(floor(reflectRow / max(1.0, v_reflect.y) * 3.0 + bayer4(floor(v_world)) - 0.5), 0.0, 2.0);
    alpha *= select(select(0.16, 0.28, course < 1.5), 0.42, course < 0.5);
    albedoRgba = vec4f(mix(albedoRgba.rgb, waterStopRgb(waterStopForSd(reflectSd)), 0.38), albedoRgba.a);
  }
  var sidecar = vec4f(0.0);
  if (batch.hasMaterialMap != 0u) { sidecar = textureSampleLevel(materialMap, albedoSampler, uv, 0.0); }
  var authoredEmission = vec4f(0.0);
  if (batch.hasEmissiveMap != 0u) { authoredEmission = textureSampleLevel(emissiveMap, albedoSampler, uv, 0.0); }
  let packedMap = (v_flags & RECORD_FLAG_PACKED_GEOMETRY) != 0u;
  let materialId = floor(sidecar.r * 255.0 + 0.5);
  let material = select(v_material, materialId, sidecar.a > 0.0 && !(packedMap && materialId > 254.5));
  var emissive = v_emissive;
  var emissionColor = albedoRgba.rgb;
  if (batch.hasEmissiveMap != 0u) {
    // The emissive channel owns both hue (RGB) and contribution (A).
    emissionColor = authoredEmission.rgb;
    emissive = authoredEmission.a * 2.0 * clamp(v_gate, 0.0, 1.0);
  } else if (batch.hasMaterialMap != 0u) {
    // A material map without an authored emissive channel is non-emissive.
    emissionColor = vec3f(0.0);
    emissive = 0.0;
  }
  // 3.1 — the reviewed emissive-core share.
  emissive *= frame.coreEnergy;
  var geometry = vec4f(0.0);
  if (packedMap) {
    if (frame.packedGeometry != 0u && sidecar.b > 0.0) { geometry = vec4f(sidecar.g, sidecar.b, 0.0, 1.0); }
  } else if (batch.hasOccluderMap != 0u) {
    geometry = textureSampleLevel(occluderMap, albedoSampler, uv, 0.0);
  }
  // 2.3 — a surface-coded landmark carries its true height in R.
  let surfaceCoded = geometry.a > 0.0 && (v_flags & RECORD_FLAG_SURFACE_CODE) != 0u;
  var elevation = v_elevation;
  if (geometry.a > 0.0) { elevation = select(geometry.r, min(1.0, geometry.r * 255.0 / 128.0), surfaceCoded); }
  let px = vec2f(glFragCoord.x, frame.resolution.y - glFragCoord.y);
  var color = albedoRgba.rgb;
  var waterMaterial = materialNear(material, 8.0) > 0.5;
  var seaPath = false;
  var waterHue = false;
  if (batch.terrainBatch != 0u && fatOn && fatSeam(fatAlbedoTaps)) {
    // 4.6 — a seam pixel on a flight frame runs the chain below per tap.
    color = fatTerrainSurface(material, waterMaterial, &waterHue, &seaPath);
  } else {
    // 3.7 — a mirror texel the rain gave back to the water is water.
    var mirrorGone = false;
    color = mirrorStormColour(color, v_world, &mirrorGone);
    waterMaterial = waterMaterial || mirrorGone;
    // 3.6 — the swash laps the baked shore before any weather darkening.
    if (batch.terrainBatch != 0u && frame.waterFx.w > 0.0) { color = applyCoastSwash(color, v_world); }
    if (!waterMaterial && (frame.weather.x > 0.001 || frame.wetness > 0.001)) { color = applyMaterialWeather(color, material, v_world); }
    waterHue = waterMaterial && !(color.b < color.r + 0.02 || color.g < color.r);
    if (waterMaterial) { color = applyWaterState(color, v_world, &seaPath); }
  }
  color = applyAuthoredSunBand(color, material);
  // 1.2 — the pools light the ungraded surface.
  let poolAlbedo = color;
  // 1.1 — C2 time-of-day and weather grade.
  color = applyTimeGrade(color, batch.additive == 0u);
  // V6 — graded water stays quiet; the 3.2 path is held at HSL L <= 0.70.
  if (waterHue) {
    if (seaPath) {
      color = seaPathCap(color);
    } else {
      color = capSaturation(color, WATER_MAX_SATURATION);
    }
  }
  // 2.7 — a Lighthouse-lit dash keeps its lampBeam stop.
  if (lighthouseDash) { color = poolAlbedo; }
  // 5.2 — puddles take the graded sky over the graded street.
  if (batch.puddleGround != 0u && frame.puddles > 0.0) { color = applyPuddle(color, v_world); }
  color = applyGradeVignette(color, px, frame.resolution);
  // 1.3 — emitters keep their own light.
  let emitterWeight = select(0.0, clamp(emissive, 0.0, 1.0), batch.hasEmissiveMap != 0u);
  color = mix(color, poolAlbedo, emitterWeight);
  var s: SurfaceSample;
  s.uv = uv;
  s.uvStepX = uvStepX;
  s.reflectRecord = reflectRecord;
  s.albedo = albedoRgba;
  s.alpha = alpha;
  s.material = material;
  s.emissive = emissive;
  s.emissionColor = emissionColor;
  s.geometry = geometry;
  s.surfaceCoded = surfaceCoded;
  s.elevation = elevation;
  s.color = color;
  s.waterMaterial = waterMaterial;
  s.poolAlbedo = poolAlbedo;
  s.emitterWeight = emitterWeight;
  // V5 — the receiver knee's floor: the graded value before any local light.
  s.receiverLuma = dot(color, GRADE_LUMA);
  return s;
}

// The GLSL's texelFetch(u_lightData, ivec2(i, row), 0): the same floats, from
// the light-record storage buffer (common.js).
fn lightRecord(i: i32, row: i32) -> vec4f {
  return lightData[row * ${MAX_LIGHT_RECORDS} + i];
}

// main() from the receiver classification on: the light loop, the radiance,
// column, ramp, pool and rim landings, fog, emission and the atmosphere
// courses. Returns the lit colour; the baked rim's night alpha is written
// back into the sample.
fn sceneLight(surf: ptr<function, SurfaceSample>) -> vec3f {
  let uv = (*surf).uv;
  let uvStepX = (*surf).uvStepX;
  let reflectRecord = (*surf).reflectRecord;
  let albedoRgba = (*surf).albedo;
  let material = (*surf).material;
  let geometry = (*surf).geometry;
  let waterMaterial = (*surf).waterMaterial;
  let poolAlbedo = (*surf).poolAlbedo;
  let receiverLuma = (*surf).receiverLuma;
  var color = (*surf).color;
  // 3.2 — the wet receiver is classified lazily.
  var wetReceiver = -1.0;
  let waterReceiver = materialNear(material, 8.0);
  // 3.5 — a pilot pixel collects the admitted light as one scalar.
  let rampPixel = frame.hasPaletteLut != 0u && v_ramp > 0.5;
  var admitted = 0.0;
  var rampHue = vec3f(0.0);
  var rampSteps = 0.0;
  // 1.2 — ambient light pools, accumulated and landed once after the loop.
  var poolLight = vec3f(0.0);
  var poolDepth = 0.0;
  var reflectionLight = vec3f(0.0);
  var attentionLight = vec3f(0.0);
  var attentionLuma = 0.0;
  var attentionDepth = 0.0;
  // PT-1 — courses quantize on the record's own texel grid.
  let artCell = floor(v_world - v_originFrac);
  var poolOrder = bayer4(artCell);
  let artTopLeftPx = (artCell + v_originFrac + 0.5 + frame.cameraXy) * frame.cameraScale;
  // V5 / V9 — the receiver: ground point, height, facing and class.
  let artPoint = artCell + v_originFrac + 0.5;
  var recvGround = artPoint;
  var recvH = 0.0;
  var recvNormal = vec2f(0.0, 1.0);
  var recvHalfWidth = 10.0;
  var recvClass = 0;
  var roofFace = false;
  let ownOwner = v_identity.x;
  let ownLandmark = v_identity.y;
  if (v_receiver.x > -0.5) {
    if ((*surf).surfaceCoded) {
      let code = floor(geometry.b * 255.0 + 0.5);
      let face = floor(code / 64.0);
      recvH = floor(geometry.r * 255.0 + 0.5);
      recvGround = vec2f(artPoint.x, artPoint.y + recvH);
      if (face > 0.5 && face < 2.5) {
        recvClass = 1;
        recvNormal = vec2f(select(0.70710678, -0.70710678, face < 1.5), 0.70710678);
      }
      roofFace = face > 2.5;
    } else if (ownLandmark != 0u && v_receiver.z > -0.5) {
      let edgeY = v_receiver.z - abs(artPoint.x - v_receiver.y) * 0.5;
      if (artPoint.y < edgeY - 1.0) {
        recvClass = 1;
        recvGround = vec2f(artPoint.x, edgeY);
        recvH = edgeY - artPoint.y;
        recvNormal = vec2f(select(0.70710678, -0.70710678, artPoint.x < v_receiver.y), 0.70710678);
      }
    } else {
      let axisProp = (v_flags & RECORD_FLAG_RECEIVER_AXIS) != 0u;
      recvClass = select(select(3, 4, axisProp), 2, ownOwner != 0u);
      recvGround = vec2f(artPoint.x, select(max(v_receiver.x, artPoint.y), v_receiver.x, recvClass == 2));
      recvH = max(0.0, v_receiver.x - artPoint.y);
      if (recvClass == 2 || recvClass == 4) {
        if (recvClass == 2) {
          recvHalfWidth = 10.0;
        } else {
          recvHalfWidth = max(8.0, 0.5 * (v_uvClamp.z - v_uvClamp.x) / abs(uvStepX));
        }
        let across = clamp((artPoint.x - v_receiver.y) / recvHalfWidth, -0.85, 0.85);
        recvNormal = vec2f(across, sqrt(1.0 - across * across));
      }
    }
  }
  // R3 — a wall or a raised face-0 landmark texel takes its courses per 2x2
  // art cell; an upright 3.5 ramp record the same cells about its own foot.
  let rampUpright = rampPixel && recvClass == 3;
  if (rampUpright || (ownLandmark != 0u && (recvClass == 1 || (recvClass == 0 && recvH > 0.5 && !rampPixel)))) {
    let cellShift = floor(artCell * 0.5) * 2.0 + 0.5 - artCell;
    poolOrder = bayer4(floor(artCell * 0.5));
    if (recvClass == 1) {
      let footShift = -sign(recvNormal.x) * 0.5 * cellShift.x;
      recvGround += vec2f(cellShift.x, footShift);
      recvH += footShift - cellShift.y;
    } else if (rampUpright) {
      let cellPoint = artPoint + cellShift;
      recvGround = vec2f(cellPoint.x, max(v_receiver.x, cellPoint.y));
      recvH = max(0.0, v_receiver.x - cellPoint.y);
    } else {
      recvGround += cellShift;
    }
  }
  // 2.5 / 2.1 — the baked 2.4 rim turns opaque as the lamps take the night.
  let bakedRim = recvClass != 0 && !reflectRecord && albedoRgba.a > 0.4 && albedoRgba.a < 0.6
    && max(albedoRgba.r, max(albedoRgba.g, albedoRgba.b)) < 0.16;
  let nightCarry = clamp((frame.poolGain - 0.15) / 1.05, 0.0, 1.0);
  // 2.1 — a backlit figure wears one rim.
  var backReach = 0.0;
  var rimReach = 0.0;
  var rimLight = vec3f(0.0);
  var rimSteps = 0.0;
  var rimInner = false;
  // 2.3 — a roof takes no local light; 2.4 — the clustered or flat walk.
  let clusteredLights = frame.lightTileGrid.z != 0;
  var lightTile = vec2i(0);
  var receiverLights = select(frame.lightCount, 0, roofFace || reflectRecord);
  if (clusteredLights && receiverLights > 0) {
    lightTile = clamp(
      vec2i(i32(glFragCoord.x) / ${LIGHT_TILE_PX}, i32(frame.resolution.y - glFragCoord.y) / ${LIGHT_TILE_PX}),
      vec2i(0),
      frame.lightTileGrid.xy - 1
    );
    receiverLights = i32(textureLoad(lightTiles, vec2i(lightTile.x * ${LIGHT_TILE_STRIDE}, lightTile.y), 0).r);
  }
  // 4.6 — the art cells a flight frame's seam pixel covers.
  var cellTaps = FatTaps(artCell, vec2f(0.0));
  if (fatOn) { cellTaps = fatTaps(v_world - v_originFrac, fatWorldFw); }
  let seamTaps = fatSeam(cellTaps);
  // 2.9 — only painted, uncovered terrain water takes a column.
  var columnSd = 0.0;
  var columnCoast = 0u;
  let columnReceiver = waterMaterial && batch.terrainBatch != 0u && receiverLights > 0
    && coastFieldAt(v_world, &columnSd, &columnCoast)
    && (columnCoast & ${COAST_FIELD_FLAGS.water}u) != 0u
    && (columnCoast & ${COAST_FIELD_FLAGS.covered}u) == 0u;
  let columnTick = floor(frame.timeMs * ${WATER_COLUMN_TICK_RATE} * frame.waterFx.x);
  var columnLight = vec3f(0.0);
  var columnTap = vec4f(0.0);
  // 4.6 — a flat ground receiver's pools per covered cell.
  let poolTaps = seamTaps && recvClass == 0 && recvH < 0.5 && !rampPixel && !waterMaterial && receiverLights > 0;
  var poolTapLight = array<vec3f, 4>(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  var poolTapDepth = vec4f(0.0);
  var attentionTapLight = array<vec3f, 4>(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  var attentionTapLuma = vec4f(0.0);
  var attentionTapDepth = vec4f(0.0);
  for (var n = 0; n < ${MAX_LIGHT_RECORDS}; n++) {
    if (n >= receiverLights) { break; }
    var i = n;
    if (clusteredLights) {
      i = i32(textureLoad(lightTiles, vec2i(lightTile.x * ${LIGHT_TILE_STRIDE} + 1 + n, lightTile.y), 0).r);
    }
    let light = lightRecord(i, 0);
    let lightShape = lightRecord(i, 1);
    let lightH = lightShape.x;
    let role = lightShape.w;
    let attention = role > ${(LIGHT_ROLE_ATTENTION - 0.5).toFixed(1)};
    var backlitRim = false;
    // 2.9 — water takes no diffuse pool and no attention light: an admitted
    // aperture or fixture lays a broken column of its own hue.
    if (waterMaterial) {
      if (!columnReceiver || attention) { continue; }
      let columnMeta = lightRecord(i, 3);
      let columnFlags = u32(columnMeta.z + 0.5);
      if ((columnFlags & ${LIGHT_RECORD_FLAGS.waterColumn}u) == 0u) { continue; }
      let columnStart = light.y + select(0.0, lightH, (columnFlags & ${LIGHT_RECORD_FLAGS.waterOnly}u) != 0u);
      let columnReach = light.z * ${WATER_COLUMN_REACH.toFixed(2)} * max(1.0, columnMeta.w);
      let columnAlong = artCell.y + 0.5 - columnStart;
      if (columnAlong < -1.0 || columnAlong >= columnReach + 1.0) { continue; }
      let columnColor = lightRecord(i, 2);
      let columnEnergy = light.w * columnColor.a;
      let halfNear = 2.0 + floor(light.z / 32.0);
      var lift = vec4f(0.0);
      for (var t = 0; t < 4; t++) {
        if (t > 0 && !seamTaps) { break; }
        if (fatTapWeight(cellTaps, t) <= 0.0) { continue; }
        let cell = cellTaps.base + fatTapOffset(t);
        lift[t] = columnLift(cell, light.x, cell.y + 0.5 - columnStart, columnReach, columnEnergy, halfNear, columnTick);
      }
      if (max(max(lift.x, lift.y), max(lift.z, lift.w)) < 0.5) { continue; }
      if (frame.marchSteps > 0 && footprintBlocked(recvGround, light.xy, 0.0, lightH, ownLandmark,
        u32(columnMeta.y + 0.5), role > 1.5 && role < 2.5) > 0.5) { continue; }
      columnTap = max(columnTap, lift);
      columnLight += columnColor.rgb * columnEnergy;
      continue;
    }
    // V5 — falloff in iso ground space; 2.4 — a facade aperture's height
    // counts at APERTURE_SPILL below it.
    let facadeAperture = role > 0.5 && role < 1.5 && dot(lightShape.yz, lightShape.yz) > 0.25;
    let spill = select(1.0, ${APERTURE_SPILL.toFixed(2)}, facadeAperture);
    let toReceiver = vec3f(recvGround.x - light.x, (recvGround.y - light.y) * 2.0, recvH - lightH);
    let d = length(toReceiver);
    let lampBand = max(0.0, lightH - 24.0) * spill;
    var falloffD = length(vec3f(toReceiver.xy, max(0.0, abs(recvH - lightH) - 24.0) * select(1.0, spill, recvH < lightH)));
    var falloffReach = sqrt(light.z * light.z + lampBand * lampBand);
    // A body takes one falloff for the whole figure.
    if (recvClass == 2) {
      falloffD = length(vec3f(v_receiver.y - light.x, (v_receiver.x - light.y) * 2.0,
        max(0.0, abs(20.0 - lightH) - 24.0) * select(1.0, spill, lightH > 20.0)));
      falloffReach *= 1.25;
    }
    if (falloffD >= falloffReach) { continue; }
    let lightMeta = lightRecord(i, 3);
    let lightFlags = u32(lightMeta.z + 0.5);
    // 2.9 — a water-only light lights nothing else.
    if ((lightFlags & ${LIGHT_RECORD_FLAGS.waterOnly}u) != 0u) { continue; }
    // 2.5 — an attention light lights its owner's ground and body only.
    if (attention && recvClass != 0 && (ownOwner == 0u || ownOwner != u32(lightMeta.x + 0.5))) { continue; }
    let lightColor = lightRecord(i, 2);
    var falloff = 1.0 - smoothstep(0.0, falloffReach, falloffD);
    // An aperture emits into its face's half-space; R3 — a wall takes a
    // window's light only across the street.
    let ahead = dot(lightShape.yz, toReceiver.xy);
    if (facadeAperture) {
      falloff *= clamp(0.30 + 1.4 * ahead / max(length(toReceiver.xy), 1.0), 0.0, 1.0);
      if (recvClass == 1 && (ahead < ${APERTURE_WALL_AHEAD.toFixed(1)} || recvH > lightH)) { falloff = 0.0; }
    }
    // Receiver response: up-facing, wall facing, body/hull Lambert + fill,
    // or the backlit two-texel rim.
    var response = 1.0;
    if (recvClass == 0) {
      response = select(0.0, 1.0, lightH + 12.0 >= recvH);
    } else {
      let facing = clamp(-dot(recvNormal, toReceiver.xy) / max(d, 1.0), -1.0, 1.0);
      if (recvClass == 2 || recvClass == 4) {
        let axisTo = vec2f(v_receiver.y - light.x, (v_receiver.x - light.y) * 2.0);
        let planar = length(axisTo);
        var front = 1.0;
        if (!(attention || planar < 2.0)) { front = -axisTo.y / planar; }
        if (front < -0.3) {
          response = 0.0;
          if (falloff > 0.12 && abs(axisTo.x) >= 0.8 * recvHalfWidth) {
            backReach = max(backReach, falloff);
            let rimStep = vec2f(select(-1.0, 1.0, axisTo.x < 0.0) * uvStepX, 0.0);
            let rimUv = uv + rimStep;
            let innerUv = uv + 2.0 * rimStep;
            let outer = any(rimUv < v_uvClamp.xy) || any(rimUv > v_uvClamp.zw)
              || albedoTexture(rimUv).a < 0.01;
            let inner = !outer && (any(innerUv < v_uvClamp.xy) || any(innerUv > v_uvClamp.zw)
              || albedoTexture(innerUv).a < 0.01);
            if ((outer || inner) && recvH <= lightH + 28.0 && falloff >= rimReach) {
              response = 0.95;
              backlitRim = true;
              rimInner = inner;
            }
          }
        } else {
          var fill = 0.0;
          if (falloff > 0.08) {
            fill = clamp(0.62 * falloff, 0.2, 0.36) * clamp((front + 0.4) / 0.1, 0.0, 1.0);
          }
          response = max(facing, fill / max(falloff, 0.01));
        }
      } else {
        response = clamp(select(0.15, 0.0, facadeAperture && recvClass == 1) + 0.85 * facing, 0.0, 1.0);
      }
    }
    var shape = falloff * response;
    // 4.6 — per covered cell (poolTaps, flat ground only).
    var tapShape = vec4f(0.0);
    var tapCourse = false;
    if (poolTaps) {
      let tapZ = max(0.0, abs(recvH - lightH) - 24.0) * select(1.0, spill, recvH < lightH);
      for (var t = 0; t < 4; t++) {
        if (fatTapWeight(cellTaps, t) <= 0.0) { continue; }
        let tapCell = cellTaps.base + fatTapOffset(t);
        let tapTo = toReceiver.xy + (tapCell - artCell) * vec2f(1.0, 2.0);
        var tapFalloff = 1.0 - smoothstep(0.0, falloffReach, length(vec3f(tapTo, tapZ)));
        if (facadeAperture) {
          tapFalloff *= clamp(0.30 + 1.4 * dot(lightShape.yz, tapTo) / max(length(tapTo), 1.0), 0.0, 1.0);
        }
        tapShape[t] = tapFalloff * response;
        tapCourse = tapCourse || poolSteps(tapShape[t], bayer4(tapCell)) > 0.5;
      }
    }
    // 2.2 — the footprint march, only where this light lays a course.
    var blocked = 0.0;
    if (!attention && frame.marchSteps > 0 && (poolSteps(shape, poolOrder) > 0.5 || tapCourse)) {
      blocked = footprintBlocked(recvGround, light.xy, recvH, lightH, ownLandmark, u32(lightMeta.y + 0.5),
        role > 1.5 && role < 2.5);
    }
    shape *= 1.0 - blocked * 0.92;
    tapShape *= 1.0 - blocked * 0.92;
    if (backlitRim) {
      rimReach = falloff;
      // One course for the whole rim (no Bayer order).
      rimSteps = poolSteps(shape, 0.5);
      rimLight = lightColor.rgb * light.w * lightColor.a;
      continue;
    }
    if (attention) {
      // The strongest action-needed course wins instead of summing.
      let attentionSteps = poolSteps(shape, poolOrder);
      let lit = lightColor.rgb * poolWeight(attentionSteps) * light.w * lightColor.a;
      let litLuma = dot(lit, GRADE_LUMA);
      if (litLuma > attentionLuma) {
        attentionLight = lit;
        attentionLuma = litLuma;
      }
      attentionDepth = max(attentionDepth, attentionSteps);
      if (poolTaps) {
        for (var t = 0; t < 4; t++) {
          if (fatTapWeight(cellTaps, t) <= 0.0) { continue; }
          let tapSteps = poolSteps(tapShape[t], bayer4(cellTaps.base + fatTapOffset(t)));
          let tapLit = lightColor.rgb * poolWeight(tapSteps) * light.w * lightColor.a;
          let tapLuma = dot(tapLit, GRADE_LUMA);
          if (tapLuma > attentionTapLuma[t]) {
            attentionTapLight[t] = tapLit;
            attentionTapLuma[t] = tapLuma;
          }
          attentionTapDepth[t] = max(attentionTapDepth[t], tapSteps);
        }
      }
      continue;
    }
    let steps = poolSteps(shape, poolOrder);
    if (rampPixel) {
      // 3.5 / 2.1 — a ramp pixel takes the strongest light's stepped course.
      let rampShare = steps * 0.15 * light.w * lightColor.a;
      if (rampShare > admitted) {
        admitted = rampShare;
        rampHue = lightColor.rgb;
        rampSteps = steps;
      }
    } else {
      poolLight += lightColor.rgb * poolWeight(steps) * light.w * lightColor.a;
      poolDepth = max(poolDepth, steps);
      if (poolTaps) {
        for (var t = 0; t < 4; t++) {
          if (fatTapWeight(cellTaps, t) <= 0.0) { continue; }
          let tapSteps = poolSteps(tapShape[t], bayer4(cellTaps.base + fatTapOffset(t)));
          poolTapLight[t] += lightColor.rgb * poolWeight(tapSteps) * light.w * lightColor.a;
          poolTapDepth[t] = max(poolTapDepth[t], tapSteps);
        }
      }
    }
    // The source's own hue lies on wet ground in front of its foot.
    if (recvClass == 0 && (lightFlags & ${LIGHT_RECORD_FLAGS.wetReflection}u) != 0u) {
      if (wetReceiver < 0.0) {
        wetReceiver = max(
          materialNear(material, 7.0),
          max(materialNear(material, 1.0), materialNear(material, 6.0))
        ) * frame.wetness * materialWetness(material);
      }
      if (wetReceiver > 0.01) {
        let drop = v_world.y - light.y;
        let footReach = step(0.0, drop) * (1.0 - smoothstep(0.0, light.z * 1.30, drop));
        let lateral = 1.0 - smoothstep(0.0, light.z * 0.26, abs(v_world.x - light.x));
        let wetCourse = step(0.55, fract((floor(v_world.x) + floor(v_world.y) * 0.5) * 0.125 + 0.37));
        reflectionLight += lightColor.rgb * wetReceiver * footReach * lateral * wetCourse
          * light.w * lightColor.a * (1.0 - blocked) * 0.22;
      }
    }
  }
  // 2.10 — the one warm bounce lands only where no direct light lays a
  // course, and at most as course 1.
  var bounceOnly = false;
  var directCourse = poolDepth < 0.5;
  if (rampPixel) { directCourse = admitted <= 0.0; }
  if (frame.radianceGrid.w > 0.5 && (recvClass == 0 || recvClass == 1) && !roofFace && !reflectRecord && (*surf).emitterWeight < 0.05
    && !waterMaterial && waterReceiver < 0.5 && directCourse) {
    var bounceLight = vec3f(0.0);
    let bounceShape = radianceShape(recvGround, recvNormal, recvH, recvClass == 1, &bounceLight);
    if (poolSteps(bounceShape, poolOrder) > 0.5) {
      poolLight += bounceLight * poolWeight(1.0);
      poolDepth = 1.0;
      bounceOnly = true;
      for (var t = 0; t < 4; t++) {
        if (!poolTaps || poolTapDepth[t] > 0.5) { continue; }
        poolTapLight[t] += bounceLight * poolWeight(1.0);
        poolTapDepth[t] = 1.0;
      }
    }
  }
  // 2.9 — the columns land once, emissive-exempt, on the water ramp.
  if (max(max(columnTap.x, columnTap.y), max(columnTap.z, columnTap.w)) > 0.5) {
    let columnHue = columnLight / max(dot(columnLight, GRADE_LUMA), 0.001);
    let columnWarm = clamp((columnHue.r - columnHue.b) * 1.25, 0.0, 1.0);
    let columnCool = mix(vec3f(1.0), columnHue, 0.7);
    let columnStop = waterStopForSd(columnSd);
    var columnLanded = vec3f(0.0);
    for (var t = 0; t < 4; t++) {
      let w = fatTapWeight(cellTaps, t);
      if (w <= 0.0) { continue; }
      let lift = columnTap[t];
      var tapOut = color;
      if (lift > 0.5) {
        let y = max(columnRampLuma(columnStop, lift), receiverLuma + 0.03 * lift);
        let stop = mix(columnCool, select(select(LAND_RIM, LAND_MID, lift > 2.5), LAND_CORE, lift > 3.5), columnWarm);
        tapOut = mix(color, onStop(stop, y), 0.88);
        tapOut = okCeiling(tapOut, color, RECEIVER_OKL_CEILING);
      }
      columnLanded += tapOut * w;
    }
    color = columnLanded;
  }
  // 3.5 — the authored ramp landing: two thresholds pick the course, and a
  // lit course lands on the strongest light's C1 stop.
  if (rampPixel && admitted > 0.0) {
    let course = step(0.14, admitted) + step(0.45, admitted);
    let ramp = textureSampleLevel(paletteLut, nearestSampler, vec2f(
      (material + 0.5) / 11.0,
      (course + 0.5) / 3.0
    ), 0.0);
    var rampLit = receiverKnee(
      color * (ramp.rgb * 2.0) + vec3f(ramp.a * 0.25) * step(0.14, admitted) + reflectionLight,
      receiverLuma
    );
    if (course > 0.5) {
      let hue = rampHue / max(dot(rampHue, GRADE_LUMA), 0.001);
      let warm = clamp((hue.r - hue.b) * 1.25, 0.0, 1.0);
      let stop = mix(mix(vec3f(1.0), hue, 0.7),
        select(select(LAND_CORE, LAND_MID, rampSteps < 2.5), LAND_RIM, rampSteps < 1.5), warm);
      let y = dot(rampLit, GRADE_LUMA);
      let share = select(select(LAND_SHARE.z, LAND_SHARE.y, rampSteps < 2.5), LAND_SHARE.x, rampSteps < 1.5);
      rampLit = okCeiling(mix(rampLit, onStop(stop, y), share), color, RECEIVER_OKL_CEILING);
    }
    color = rampLit;
    reflectionLight = vec3f(0.0);
  }
  // 1.2 / V5 — the pools land once, stepped (stepPool, grade.js).
  var bodyLift = vec3f(0.0);
  if (recvClass == 2) {
    bodyLift = poolLight * min(0.15 * frame.poolGain, 0.045 / max(dot(poolLight, GRADE_LUMA), 0.01));
  }
  // 2.10 — a pixel lit only by the bounce keeps more of its own colour.
  let poolLand = select(select(1.0, RADIANCE_LAND, bounceOnly), 0.4, recvClass == 2);
  if (poolTaps) {
    // 4.6 — each covered cell's pools land and blend by coverage; a cell
    // whose lights equal the previous cell's reuses that landing.
    var poolLanded = vec3f(0.0);
    var tapOut = color;
    var prev = -1;
    for (var t = 0; t < 4; t++) {
      let w = fatTapWeight(cellTaps, t);
      if (w <= 0.0) { continue; }
      if (prev < 0 || any(poolTapLight[t] != poolTapLight[prev]) || poolTapDepth[t] != poolTapDepth[prev]
        || any(attentionTapLight[t] != attentionTapLight[prev]) || attentionTapDepth[t] != attentionTapDepth[prev]) {
        tapOut = stepPool(color, poolTapLight[t], poolTapDepth[t], attentionTapLight[t], attentionTapDepth[t],
          poolAlbedo, reflectionLight + bodyLift, poolLand);
        prev = t;
      }
      poolLanded += tapOut * w;
    }
    color = poolLanded;
  } else {
    color = stepPool(color, poolLight, poolDepth, attentionLight, attentionDepth, poolAlbedo, reflectionLight + bodyLift,
      poolLand);
  }
  // 2.1 — a lit rim texel takes the lamp's own hue at a stepped value.
  if (rimReach > 0.0 && rimReach >= backReach - 0.001 && rimSteps > 0.5) {
    let rimCourse = select(rimSteps, rimSteps - 1.0, rimInner);
    let rimY = 0.26 + 0.1 * rimCourse;
    let rimHue = rimLight / max(dot(rimLight, GRADE_LUMA), 0.01);
    let rimStop = select(select(LAND_CORE, LAND_MID, rimCourse < 2.5), LAND_RIM, rimCourse < 1.5);
    let rim = receiverKnee(onStop(mix(rimHue, rimStop, 0.6), rimY), receiverLuma);
    if (dot(rim, GRADE_LUMA) > dot(color, GRADE_LUMA)) { color = rim; }
  }

  let fog = clamp(frame.weather.y, 0.0, 1.0);
  let groundFog = fog * (1.0 - (*surf).elevation * 0.72) * smoothstep(0.18, 0.98, glFragCoord.y / max(1.0, frame.resolution.y));
  // Fog veils toward the C2 haze colour but may raise luma by at most 0.06.
  var fogged = mix(color, frame.fogColor, groundFog * 0.48);
  let fogRise = dot(fogged - color, GRADE_LUMA);
  if (fogRise > 0.06) { fogged = mix(color, fogged, 0.06 / fogRise); }
  color = fogged;
  let emission = (*surf).emissionColor * (*surf).emissive;
  color += emission * 0.42;
  // 1.3 — hue-preserving protection after emission.
  color /= max(1.0, max(color.r, max(color.g, color.b)));
  // 1.4 + 1.6 — cloud courses and aerial haze on this record's own grid.
  if (seamTaps) {
    color = fatAtmosphereCourses(color, cellTaps, waterMaterial);
  } else {
    // On water the haze courses follow the sea's swell contours (N3).
    var contourPx = 0.0;
    if (waterMaterial) { contourPx = seaContourRows(artCell) * frame.cameraScale; }
    color = applyAtmosphereCourses(color, artCell, poolOrder, artTopLeftPx.y + contourPx, batch.additive != 0u);
  }
  if (bakedRim && batch.additive == 0u) {
    (*surf).alpha = mix((*surf).alpha, max((*surf).alpha, v_alpha), nightCarry);
  }
  return color;
}

// The emission target: exactly the GLSL's outEmission (alpha = coverage).
// 10.2/10.3 stage the §7.1 role in this alpha through the blend state, not
// here (GpuWgpuPipelines BLEND_*_ROLE: the batch's role is the pass's blend
// constant), so every display path runs this same fragment.
fn sceneEmission(surf: SurfaceSample) -> vec4f {
  let emission = surf.emissionColor * surf.emissive;
  return vec4f(emission * surf.alpha, select(0.0, 1.0, surf.alpha > 0.0));
}

struct SceneOut {
  @location(0) color: vec4f,
  @location(1) emission: vec4f,
}

@diagnostic(off, derivative_uniformity)
@fragment fn sceneFs(in: VsOut) -> SceneOut {
  glFragCoord = in.position;
  v_uv = in.uv;
  v_world = in.world;
  v_alpha = in.surface.x;
  v_material = in.surface.y;
  v_elevation = in.surface.z;
  v_emissive = in.surface.w;
  v_gate = in.gateRamp.x;
  v_ramp = in.gateRamp.y;
  v_originFrac = in.originFrac;
  v_uvClamp = in.uvClamp;
  v_receiver = in.receiver;
  v_identity = in.identity;
  v_flags = in.flags;
  v_reflect = in.reflectAxis;
  v_texel = in.texel;
  v_texelRect = in.texelRect;
  v_layer = in.layer;
  var surf = sceneSurface();
  let color = sceneLight(&surf);
  var out: SceneOut;
  out.color = vec4f(max(color, vec3f(0.0)) * surf.alpha, surf.alpha);
  out.emission = sceneEmission(surf);
  return out;
}
`;
