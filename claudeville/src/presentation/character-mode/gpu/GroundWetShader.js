// GW-1 / GW-2 — wet ground you can read, and lamps in puddles: the scene
// fragment's reading of the ground weather field (GroundWeatherField.js),
// written once per dialect side by side so the WebGL2 and WebGPU twins stay
// expression for expression (`scripts/tests/ground-wet-shader.test.mjs`).
//
// The field rides the puddle unit (WebGL2 unit 11, WebGPU frame binding 10)
// in place of the R8 puddle mask while either look is on and the ground is
// wet or puddled (GpuFrameState.resolveGroundWeather). Its A is the puddle
// byte, so the puddle courses read A there and R otherwise (`puddleByte`).
// u_groundWeather / frame.groundWeather = (gw1, gw2, field bound, wet level).
//
//   wet      a terrain texel on land is wet when the wet level passes its
//            drying order (level ≥ 1 − B) and its shelter (G) keeps under
//            GROUND_WET.shelter, both on a 2×2 ordered seam over the field's
//            own texel grid. The level is the ground history's wetness only
//            (0 under drizzle and in winter), which steps per 10-minute
//            bucket, so the street wets and dries along the drying order:
//            eaves and crowns keep dry aprons, streets dry sun side first and
//            joints last, and the edge never moves per frame.
//   step     a wet texel steps one stop down its own C1 ramp
//            (GROUND_WET_STEPS, by surface and stop), on palette; gw1 keeps (1 − gw1) of the old uniform darkening on top.
//   sheen    a wet paving top (surfaces 3–6, stop ≥ 3) takes one course of the
//            graded sky after the grade (GROUND_WET.sheen × gw1), the sky
//            capped at GROUND_WET.sheenCap × the wet top's value.
//   mirror   GW-2: on a puddle texel (full) or, with gw1 on, any wet paving
//            texel (GROUND_WET.mirrorSheen) each wet-reflection light lays a short broken column
//            of its own hue straight below its foot, as long as the lamp
//            stands high: the post course, then its head's image at full
//            (× gw2 × GROUND_WET.mirrorGain). The strongest lamp's mirror
//            at a texel lands after the pools as one course of its own hue
//            (`applyGroundMirror`): its value rises to GROUND_WET.mirrorLift
//            × the lit ground's plus GROUND_WET.mirrorValue × its energy,
//            never past GROUND_WET.mirrorPeak (or the ground's own value
//            above it), mixed GROUND_WET.mirrorShare in its hue, and
//            okCeiling keeps it under the receiver ceiling, so a mirror reads
//            inside a lit pool and never outshines an attention mark.
import { GROUND_WET_STEPS } from '../GroundWeatherField.js';

export const GROUND_WET = Object.freeze({
    seam: 0.06,
    shelter: 0.5,
    sheen: 0.35,
    // The sky a wet top takes is capped at this × the wet top's own graded
    // luma, so a sheen never lifts wet paving back to its dry value.
    sheenCap: 1.15,
    mirrorSheen: 0.6,
    mirrorGain: 0.8,
    mirrorPost: 0.45,
    mirrorWiden: 12,
    // The column runs from the foot to mirrorStretch × the lamp's height
    // (at least mirrorMinHead) + 4 px: the post, then the head's image and
    // its wet drag at full.
    mirrorMinHead: 12,
    mirrorStretch: 1.6,
    mirrorValue: 0.5,
    mirrorLift: 1.4,
    // The mirror's value never rises past this scene luma, nor lowers a
    // ground already brighter: on screen it peaks at 186/255 at zoom 1–3
    // (WebGL2 and WebGPU), under the NEEDS YOU bell's 207.
    mirrorPeak: 0.62,
    mirrorShare: 0.8,
});

const f = (v) => v.toFixed(4);
const stepsGlsl = GROUND_WET_STEPS.map(c => `vec3(${c.map(f).join(', ')})`).join(',\n    ');
const stepsWgsl = GROUND_WET_STEPS.map(c => `vec3f(${c.map(f).join(', ')})`).join(',\n  ');
const N = GROUND_WET_STEPS.length;

export const GROUND_WET_UNIFORMS_GLSL = `
// GW-1 / GW-2 — (gw1, gw2, field bound on u_puddleMask, wet level).
uniform vec4 u_groundWeather;
const int GROUND_WET_STEP_COUNT = ${N};
const vec3 GROUND_WET_STEPS[${N}] = vec3[${N}](
    ${stepsGlsl}
);`;

export const GROUND_WET_GLSL = `
bool groundFieldOn() {
    return u_terrainBatch && u_groundWeather.z > 0.5;
}
ivec2 groundFieldCell(vec2 world) {
    vec2 local = world - u_puddleRect.xy;
    return ivec2(floor(local.x * 0.5), floor(local.y));
}
vec4 groundFieldTexel(ivec2 cell) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= int(u_puddleRect.z) || cell.y >= int(u_puddleRect.w)) return vec4(1.0, 0.0, 0.5, 0.0);
    return texelFetch(u_puddleMask, cell, 0);
}
bool groundLand(vec4 field) {
    return field.r < 0.999;
}
float groundCode(vec4 field) {
    return floor(field.r * 255.0 + 0.5);
}
bool groundPaving(vec4 field) {
    float surface = floor(groundCode(field) / 16.0);
    return surface > 2.5 && surface < 6.5;
}
bool groundSheenTop(vec4 field) {
    float code = groundCode(field);
    float surface = floor(code / 16.0);
    return surface > 2.5 && surface < 6.5 && code - surface * 16.0 > 2.5;
}
bool groundWetAt(vec4 field, ivec2 cell) {
    float level = u_groundWeather.w;
    if (level <= 0.0) return false;
    float seam = (bayer2(vec2(cell)) - 0.375) * ${f(GROUND_WET.seam)};
    if (field.g + seam > ${f(GROUND_WET.shelter)}) return false;
    return level >= 1.0 || level + seam > 1.0 - field.b;
}
vec3 groundWetStep(vec4 field) {
    float code = groundCode(field);
    float surface = floor(code / 16.0);
    int index = int(surface) * 5 + int(min(code - surface * 16.0, 4.0));
    return index < GROUND_WET_STEP_COUNT ? GROUND_WET_STEPS[index] : vec3(1.0);
}
// rgb: the colour, a wet terrain texel one stop down; a: the share of the
// uniform darkening it keeps.
vec4 applyGroundWet(vec3 color, vec2 world) {
    if (!groundFieldOn() || u_groundWeather.x <= 0.0) return vec4(color, 1.0);
    ivec2 cell = groundFieldCell(world);
    vec4 field = groundFieldTexel(cell);
    if (!groundLand(field)) return vec4(color, 1.0);
    vec3 wet = groundWetAt(field, cell) ? color * groundWetStep(field) : color;
    return vec4(wet, 1.0 - u_groundWeather.x);
}
// The puddle byte: the field's A while it is bound, else the R8 mask.
float puddleByte(ivec2 cell) {
    vec4 texel = texelFetch(u_puddleMask, cell, 0);
    return u_groundWeather.z > 0.5 ? texel.a : texel.r;
}
vec3 applyWetSheen(vec3 color, vec2 world) {
    if (!groundFieldOn() || u_groundWeather.x <= 0.0) return color;
    ivec2 cell = groundFieldCell(world);
    vec4 field = groundFieldTexel(cell);
    if (!groundLand(field) || !groundSheenTop(field) || !groundWetAt(field, cell)) return color;
    float cap = min(0.56, dot(color, GRADE_LUMA) * ${f(GROUND_WET.sheenCap)});
    vec3 sky = u_puddleSky[0];
    float skyLuma = dot(sky, GRADE_LUMA);
    if (skyLuma > cap) sky *= cap / max(skyLuma, 1e-4);
    return mix(color, sky, ${f(GROUND_WET.sheen)} * u_groundWeather.x);
}`;

export const GROUND_WET_MIRROR_GLSL = `
float groundMirrorAt(vec2 world) {
    ivec2 cell = groundFieldCell(world);
    vec4 field = groundFieldTexel(cell);
    if (!groundLand(field)) return 0.0;
    if (u_puddles > 0.0 && field.a > 0.0 && field.a >= 1.0 - u_puddles) return 1.0;
    return u_groundWeather.x > 0.0 && groundPaving(field) && groundWetAt(field, cell) ? ${f(GROUND_WET.mirrorSheen)} : 0.0;
}
float groundMirrorColumn(vec2 foot, float lightH, vec2 world) {
    float drop = world.y - foot.y;
    float head = max(lightH, ${f(GROUND_WET.mirrorMinHead)});
    if (drop < 0.0 || drop > head * ${f(GROUND_WET.mirrorStretch)} + 4.0) return 0.0;
    float halfWidth = 1.0 + floor(drop / ${f(GROUND_WET.mirrorWiden)});
    if (abs(floor(world.x * 0.5) - floor(foot.x * 0.5)) > halfWidth) return 0.0;
    if (mod(floor(world.y * 0.5) + floor(foot.x), 3.0) > 1.5) return 0.0;
    return (drop > head - 6.0 ? 1.0 : ${f(GROUND_WET.mirrorPost)}) * ${f(GROUND_WET.mirrorGain)};
}
vec3 applyGroundMirror(vec3 color, vec3 mirror) {
    float energy = dot(mirror, GRADE_LUMA);
    if (energy <= 0.0) return color;
    float base = dot(color, GRADE_LUMA);
    float y = max(base, min(${f(GROUND_WET.mirrorPeak)}, base * ${f(GROUND_WET.mirrorLift)} + energy * ${f(GROUND_WET.mirrorValue)}));
    vec3 lit = mix(color, onStop(mirror / energy, y), ${f(GROUND_WET.mirrorShare)});
    return okCeiling(lit, color, RECEIVER_OKL_CEILING);
}`;

export const GROUND_WET_WGSL = `
const GROUND_WET_STEP_COUNT: i32 = ${N};
const GROUND_WET_STEPS = array<vec3f, ${N}>(
  ${stepsWgsl}
);
fn groundFieldOn() -> bool {
  return batch.terrainBatch != 0u && frame.groundWeather.z > 0.5;
}
fn groundFieldCell(world: vec2f) -> vec2i {
  let local = world - frame.puddleRect.xy;
  return vec2i(i32(floor(local.x * 0.5)), i32(floor(local.y)));
}
fn groundFieldTexel(cell: vec2i) -> vec4f {
  if (cell.x < 0 || cell.y < 0 || cell.x >= i32(frame.puddleRect.z) || cell.y >= i32(frame.puddleRect.w)) { return vec4f(1.0, 0.0, 0.5, 0.0); }
  return textureLoad(puddleMask, cell, 0);
}
fn groundLand(field: vec4f) -> bool {
  return field.r < 0.999;
}
fn groundCode(field: vec4f) -> f32 {
  return floor(field.r * 255.0 + 0.5);
}
fn groundPaving(field: vec4f) -> bool {
  let surface = floor(groundCode(field) / 16.0);
  return surface > 2.5 && surface < 6.5;
}
fn groundSheenTop(field: vec4f) -> bool {
  let code = groundCode(field);
  let surface = floor(code / 16.0);
  return surface > 2.5 && surface < 6.5 && code - surface * 16.0 > 2.5;
}
fn groundWetAt(field: vec4f, cell: vec2i) -> bool {
  let level = frame.groundWeather.w;
  if (level <= 0.0) { return false; }
  let seam = (bayer2(vec2f(cell)) - 0.375) * ${f(GROUND_WET.seam)};
  if (field.g + seam > ${f(GROUND_WET.shelter)}) { return false; }
  return level >= 1.0 || level + seam > 1.0 - field.b;
}
fn groundWetStep(field: vec4f) -> vec3f {
  let code = groundCode(field);
  let surface = floor(code / 16.0);
  let index = i32(surface) * 5 + i32(min(code - surface * 16.0, 4.0));
  if (index < GROUND_WET_STEP_COUNT) { return GROUND_WET_STEPS[index]; }
  return vec3f(1.0);
}
fn applyGroundWet(color: vec3f, world: vec2f) -> vec4f {
  if (!groundFieldOn() || frame.groundWeather.x <= 0.0) { return vec4f(color, 1.0); }
  let cell = groundFieldCell(world);
  let field = groundFieldTexel(cell);
  if (!groundLand(field)) { return vec4f(color, 1.0); }
  let wet = select(color, color * groundWetStep(field), groundWetAt(field, cell));
  return vec4f(wet, 1.0 - frame.groundWeather.x);
}
fn puddleByte(cell: vec2i) -> f32 {
  let texel = textureLoad(puddleMask, cell, 0);
  return select(texel.r, texel.a, frame.groundWeather.z > 0.5);
}
fn applyWetSheen(color: vec3f, world: vec2f) -> vec3f {
  if (!groundFieldOn() || frame.groundWeather.x <= 0.0) { return color; }
  let cell = groundFieldCell(world);
  let field = groundFieldTexel(cell);
  if (!groundLand(field) || !groundSheenTop(field) || !groundWetAt(field, cell)) { return color; }
  let cap = min(0.56, dot(color, GRADE_LUMA) * ${f(GROUND_WET.sheenCap)});
  var sky = frame.puddleSky[0].xyz;
  let skyLuma = dot(sky, GRADE_LUMA);
  if (skyLuma > cap) { sky *= cap / max(skyLuma, 1e-4); }
  return mix(color, sky, ${f(GROUND_WET.sheen)} * frame.groundWeather.x);
}
fn groundMirrorAt(world: vec2f) -> f32 {
  let cell = groundFieldCell(world);
  let field = groundFieldTexel(cell);
  if (!groundLand(field)) { return 0.0; }
  if (frame.puddles > 0.0 && field.a > 0.0 && field.a >= 1.0 - frame.puddles) { return 1.0; }
  return select(0.0, ${f(GROUND_WET.mirrorSheen)}, frame.groundWeather.x > 0.0 && groundPaving(field) && groundWetAt(field, cell));
}
fn groundMirrorColumn(foot: vec2f, lightH: f32, world: vec2f) -> f32 {
  let drop = world.y - foot.y;
  let head = max(lightH, ${f(GROUND_WET.mirrorMinHead)});
  if (drop < 0.0 || drop > head * ${f(GROUND_WET.mirrorStretch)} + 4.0) { return 0.0; }
  let halfWidth = 1.0 + floor(drop / ${f(GROUND_WET.mirrorWiden)});
  if (abs(floor(world.x * 0.5) - floor(foot.x * 0.5)) > halfWidth) { return 0.0; }
  if (glslMod(floor(world.y * 0.5) + floor(foot.x), 3.0) > 1.5) { return 0.0; }
  return select(${f(GROUND_WET.mirrorPost)}, 1.0, drop > head - 6.0) * ${f(GROUND_WET.mirrorGain)};
}
fn applyGroundMirror(color: vec3f, mirror: vec3f) -> vec3f {
  let energy = dot(mirror, GRADE_LUMA);
  if (energy <= 0.0) { return color; }
  let base = dot(color, GRADE_LUMA);
  let y = max(base, min(${f(GROUND_WET.mirrorPeak)}, base * ${f(GROUND_WET.mirrorLift)} + energy * ${f(GROUND_WET.mirrorValue)}));
  let lit = mix(color, onStop(mirror / energy, y), ${f(GROUND_WET.mirrorShare)});
  return okCeiling(lit, color, RECEIVER_OKL_CEILING);
}`;
