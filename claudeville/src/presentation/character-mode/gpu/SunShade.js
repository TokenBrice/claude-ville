// SD-2 (the Sundial, look `sd2`) — receivers take the sun's shade.
//
// The scene fragment reads the world-locked shade field (ShadeField.js, its
// four-byte `texels`) at each sprite fragment's own receiver point and steps
// the authored sun band down one course where another mass's shadow falls on
// it (cast shade). A lit face takes nothing, and neither does a face turned
// from the sun: the art already paints that side darker, and a face with no
// sun has none to lose, so no texel takes a step that never moves with the
// sun. The step multiplies the surface before the C2 grade, so shade takes
// the hour's tint, and an emitting texel keeps its light (it is exempt in
// proportion to its emission). Attention keeps all of its light: a record
// flagged `shadeExempt` (an action-needed villager's body, a petitioner's
// candle) is never stepped, like the screen-space marks. The ground itself
// keeps the slice-1 layer (`ground:shade`): ground-self records (terrain,
// casts, marks, cues) are never stepped here, so no texel is darkened twice.
//
// Receivers (the classes the light loop uses, read again here so that loop
// is untouched):
//   a landmark's right wall (surface face 2, or right of an analytic front
//   corner)
//       the authored sun stands screen-left all day, so a right face is
//       turned from it: never stepped.
//   a landmark's left wall, roof or raised deck (surface face 1, 3, or a
//   raised face 0)
//       takes the massing's verdict at its drawn position (texel A): lit, in
//       another mass's cast shade, or turned from the sun (a roof pitch, a
//       round wall past its terminator). A turned
//       surface takes no step; the verdict is what keeps it out of the cast
//       test, which its own mass would always answer. ShadeField ran that
//       test with the massing's own heights and normals, so a roof texel is
//       judged at its true height and no wall is under its own mass. Where
//       the massing draws nothing there, a wall is tested SHADE_WALL_CLEAR
//       px outside its own foot and a deck at its own point; a roof (whose
//       surface code stands it on the front wall plane) stays lit.
//   a landmark's ground texel (an apron)
//       the ground's own rule (coverage against the cell's Bayer threshold),
//       so it joins the layer around it.
//   a landmark part: one drawn over its base (a door, a cycled strip)
//       carries the base's surface code and shades like the texels it
//       replaces; an added one (a lamp, a pennant, a signal banner) is never
//       stepped. A prop with a mass of its own (PROP_MASSING, V9 flag
//       `sunSelf`) takes the massing's verdict alone.
//   a body, a prop
//       the ceiling at its foot (moved SHADE_FOOT_CLEAR px toward the sun, so
//       a figure against a sunlit wall is not under that wall), at the
//       fragment's own height above the foot: a body walks into shade and
//       the edge crosses it; no pop. A body is also tested against the
//       trees' canopies (texel B) where the sun's ray through each of its
//       texels meets the ground. Trees and props write no ceiling
//       and read no canopy, so no sprite shades itself. One that stands on a mass (a
//       deck, a quay, a terrace: the massing draws a top or a sunward wall
//       under its feet) is not under it, and takes that surface's verdict.
// A ground stamp flagged `sunSelf` (a villager's sun trail) is hidden
// wherever the field already shades the ground, so trail and shade never add.
//
// SD-3 (look `sd3`): a texel the field calls lit takes the sun's lift
// (`sunLift`) right after its step: the ground by the ground rule, a
// receiver whose verdict is lit (a landmark's left wall, roof or deck, a
// prop). Never a body, a right wall, a face turned from the sun, a texel in
// cast shade, water (SEA-1 lifts the sea) or anything the step skips.
//
// One block of GLSL and its WGSL twin, expression for expression; the scene
// shaders interpolate them and call `sunShadeStep` after the authored band.

import { GPU_RECORD_FLAGS } from './GpuWorldPolicy.js';
import {
    SHADE_CEILING_STEP,
    SHADE_FOOT_CLEAR,
    SHADE_GRAZE,
    SHADE_RECEIVER_BIAS,
    SHADE_SURFACE_STEP,
    SHADE_WALL_CLEAR,
} from '../ShadeField.js';

const CEILING = (255 * SHADE_CEILING_STEP).toFixed(1);
const BIAS = SHADE_RECEIVER_BIAS.toFixed(1);
const WALL_CLEAR = SHADE_WALL_CLEAR.toFixed(1);
const FOOT_CLEAR = SHADE_FOOT_CLEAR.toFixed(1);
const SURFACE_SCALE = (255 / SHADE_SURFACE_STEP).toFixed(5);
// The grazing limit against the left wall's normal (-1, 1) / sqrt 2.
const GRAZE = (SHADE_GRAZE * Math.SQRT2).toFixed(5);
// Never stepped: marks, reflections, and attention (an action-needed body,
// a petitioner's candle).
const SKIP_FLAGS = GPU_RECORD_FLAGS.screenSpace | GPU_RECORD_FLAGS.reflect | GPU_RECORD_FLAGS.shadeExempt;
// A left wall's outward normal on the ground, in world px (y at half scale).
const LEFT_WALL_OUT = 'vec2(-0.70710678, 0.35355339)';
// SD-3 — a lifted texel's luma stops here unless it already stood above it
// (lifted snow keeps its value): under the waiting candle's 192 and the NEEDS
// YOU bell's 207 after the brightest noon grade.
export const SUN_LIFT_CEILING = 0.68;
const LIFT_CEILING = SUN_LIFT_CEILING.toFixed(4);

// u_shadeField (unit 2): the field's RGBA8 texels. u_shadeRect = (origin x,
// origin y, cell w, cell h) in world px; cell h 0 = no field (the look off,
// MINIMAL, night, not yet built). u_shade = (cast step, SD-3 lift, the
// sweep x, y: world px of shadow per px of height): the step is a
// multiplier, 1 = none; the lift a gain over 1, 0 = none.
export const SUN_SHADE_GLSL = `
uniform sampler2D u_shadeField;
uniform vec4 u_shadeRect;
uniform vec4 u_shade;
// SD-3 — sunShadeStep's verdict on this texel: -1 not a receiver, else 0 or
// 1 lit, 2 in cast shade, 3 turned (sunLift reads it).
float sunVerdict = -1.0;

vec4 shadeFieldAt(vec2 world, out vec2 cell) {
    cell = floor((world - u_shadeRect.xy) / u_shadeRect.zw);
    vec2 size = vec2(textureSize(u_shadeField, 0));
    if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= size.x || cell.y >= size.y) return vec4(0.0);
    return texelFetch(u_shadeField, ivec2(cell), 0);
}

// The ground rule (ShadeField.shadeGroundAt) at a world point.
bool shadeGroundAt(vec2 world) {
    vec2 cell = vec2(0.0);
    vec4 field = shadeFieldAt(world, cell);
    return field.g * 255.0 > (bayer4(cell) + 0.03125) * 255.0;
}

// A sunSelf ground stamp (a sun trail) where the field already shades the ground.
bool sunTrailHidden() {
    return (v_flags & ${GPU_RECORD_FLAGS.sunSelf}u) != 0u && v_receiver.x < -0.5 && shadeGroundAt(v_world);
}

// Is the point h px over this ground point under a mass's shade ceiling?
bool shadeCeilingOver(vec2 ground, float h) {
    vec2 cell = vec2(0.0);
    vec4 field = shadeFieldAt(ground, cell);
    return field.r * ${CEILING} > h + ${BIAS};
}

// How the sun finds the massing's surface drawn at this art point: 0 no
// surface, 1 lit, 2 in cast shade, 3 turned from the sun (ShadeField
// SHADE_SURFACE). \`kind\` (out): 0 a top, 1 a wall, 2 a flat wall turned.
float shadeSurfaceAt(vec2 artPoint, out float kind) {
    vec2 cell = vec2(0.0);
    float code = floor(shadeFieldAt(artPoint, cell).a * ${SURFACE_SCALE} + 0.5);
    kind = 1.0;
    if (code < 0.5) return 0.0;
    if (code > 6.5) {
        kind = 2.0;
        return 3.0;
    }
    if (code > 3.5) {
        kind = 0.0;
        return code - 3.0;
    }
    return code;
}

// The step this fragment takes under the sun's shade: u_shade.x in cast
// shade, 1 lit or turned from the sun. \`lit\` is the texel's own emission
// share.
float sunShadeStep(vec4 geometry, bool surfaceCoded, float lit) {
    if (v_receiver.x < -0.5 || (v_flags & ${SKIP_FLAGS}u) != 0u) return 1.0;
    vec2 artPoint = floor(v_world - v_originFrac) + v_originFrac + 0.5;
    bool landmark = v_identity.y != 0u;
    bool cornered = v_receiver.z > -0.5;
    // 0 or 1 lit, 2 in cast shade, 3 turned (shadeSurfaceAt's verdicts).
    float verdict = 0.0;
    if (landmark || surfaceCoded || (v_flags & ${GPU_RECORD_FLAGS.sunSelf}u) != 0u) {
        // The texel's face (0 up, 1 left wall, 2 right wall, 3 roof; -1 none)
        // and height: its surface code (a part drawn over its base carries
        // the base's), else the analytic landmark geometry: above the front
        // edges a wall on its side of the front corner, before them ground.
        float face = -1.0;
        float h = 0.0;
        if (geometry.a > 0.0 && (surfaceCoded || (landmark && !cornered))) {
            face = floor(floor(geometry.b * 255.0 + 0.5) / 64.0);
            h = floor(geometry.r * 255.0 + 0.5);
        } else if (landmark && cornered) {
            float edgeY = v_receiver.z - abs(artPoint.x - v_receiver.y) * 0.5;
            face = 0.0;
            if (artPoint.y < edgeY - 1.0) {
                face = 2.0;
                if (artPoint.x < v_receiver.y) face = 1.0;
                h = edgeY - artPoint.y;
            }
        }
        if (face > 2.5 || (face < 1.5 && (face > -0.5 || !landmark))) {
            // A right wall (face 2) is turned from the authored sun all day
            // and takes nothing. Every other texel takes the massing's
            // verdict (a landmark's added part, with no face, is a lamp, a
            // pennant, a signal banner: never stepped). Where the massing
            // draws nothing there (or, for a left wall, a turned roof
            // behind its parapet or a flat turned wall: the art's own
            // corner line stands) the texel is tested itself: a left wall
            // just outside its own foot, a deck at its own point, ground
            // by the ground's rule. A roof has no true height of its own
            // and stays lit.
            sunVerdict = 0.0;
            float kind = 0.0;
            float seen = shadeSurfaceAt(artPoint, kind);
            bool leftWall = face > 0.5 && face < 1.5;
            vec2 ground = vec2(artPoint.x, artPoint.y + h);
            if (seen > 0.5 && !(leftWall && (kind > 1.5 || (kind < 0.5 && seen > 2.5)))) {
                verdict = seen;
            } else if (leftWall) {
                // A sun that only grazes the wall throws no cast shade on it.
                vec2 along = vec2(u_shade.z, u_shade.w * 2.0);
                if (along.y - along.x < -${GRAZE} * length(along)
                    && shadeCeilingOver(ground + ${LEFT_WALL_OUT} * ${WALL_CLEAR}, h)) verdict = 2.0;
            } else if (face > -0.5 && face < 0.5) {
                if (h < 0.5) {
                    if (shadeGroundAt(artPoint)) verdict = 2.0;
                } else if (shadeCeilingOver(ground, h)) {
                    verdict = 2.0;
                }
            }
        }
    } else {
        sunVerdict = 0.0;
        bool body = v_identity.x != 0u;
        float h = max(0.0, v_receiver.x - artPoint.y);
        vec2 foot = vec2(artPoint.x, v_receiver.x);
        // A body or prop standing on a mass (a deck, a quay, a terrace) is
        // not under it: it takes what the sun does to the surface drawn
        // under its feet (a body's at its axis). A turned wall there says
        // nothing about it, so the ceiling is asked.
        float kind = 0.0;
        float under = shadeSurfaceAt(vec2(body ? v_receiver.y : artPoint.x, v_receiver.x), kind);
        if (!body) foot.y = max(v_receiver.x, artPoint.y);
        if (under > 0.5 && (kind < 0.5 || under < 2.5)) {
            if (under > 1.5 && under < 2.5) verdict = 2.0;
        } else if (shadeCeilingOver(foot - normalize(u_shade.zw) * ${FOOT_CLEAR}, h)) {
            verdict = 2.0;
        } else if (body) {
            // The trees' canopies stand over a body: tested where the sun's
            // ray through this texel meets the ground.
            vec2 cell = vec2(0.0);
            if (shadeFieldAt(foot + u_shade.zw * h, cell).b > 0.5) verdict = 2.0;
        }
    }
    if (sunVerdict > -0.5) sunVerdict = verdict;
    if (verdict > 1.5 && verdict < 2.5) return mix(u_shade.x, 1.0, lit);
    return 1.0;
}

// SD-3 — the sun's lift on a texel the field calls lit (\`ground\`: a
// ground-self terrain texel, by the ground rule; else sunShadeStep's
// verdict, never a body): \`lift\` less the texel's emission share \`lit\`,
// held under the ceiling luma unless the texel already stood above it.
vec3 sunLift(vec3 color, bool ground, float lift, float lit) {
    bool sunlit = ground ? !shadeGroundAt(v_world) : sunVerdict > -0.5 && sunVerdict < 1.5 && v_identity.x == 0u;
    if (!sunlit) return color;
    float luma = dot(color, GRADE_LUMA);
    float gain = 1.0 + lift * (1.0 - lit);
    return color * min(gain, max(1.0, ${LIFT_CEILING} / max(luma, 0.0001)));
}
`;

// The WGSL twin: frame.shadeRect / frame.shade (common.js FRAME_UNIFORM_LAYOUT)
// and the \`shadeField\` frame binding.
export const SUN_SHADE_WGSL = `
// SD-3 — sunShadeStep's verdict on this texel: -1 not a receiver, else 0 or
// 1 lit, 2 in cast shade, 3 turned (sunLift reads it).
var<private> sunVerdict: f32 = -1.0;

fn shadeFieldAt(world: vec2f, cell: ptr<function, vec2f>) -> vec4f {
  *cell = floor((world - frame.shadeRect.xy) / frame.shadeRect.zw);
  let size = vec2f(textureDimensions(shadeField));
  if ((*cell).x < 0.0 || (*cell).y < 0.0 || (*cell).x >= size.x || (*cell).y >= size.y) { return vec4f(0.0); }
  return textureLoad(shadeField, vec2i(*cell), 0);
}

// The ground rule (ShadeField.shadeGroundAt) at a world point.
fn shadeGroundAt(world: vec2f) -> bool {
  var cell = vec2f(0.0);
  let field = shadeFieldAt(world, &cell);
  return field.g * 255.0 > (bayer4(cell) + 0.03125) * 255.0;
}

// A sunSelf ground stamp (a sun trail) where the field already shades the ground.
fn sunTrailHidden() -> bool {
  return (v_flags & ${GPU_RECORD_FLAGS.sunSelf}u) != 0u && v_receiver.x < -0.5 && shadeGroundAt(v_world);
}

// Is the point h px over this ground point under a mass's shade ceiling?
fn shadeCeilingOver(ground: vec2f, h: f32) -> bool {
  var cell = vec2f(0.0);
  let field = shadeFieldAt(ground, &cell);
  return field.r * ${CEILING} > h + ${BIAS};
}

// How the sun finds the massing's surface drawn at this art point: 0 no
// surface, 1 lit, 2 in cast shade, 3 turned from the sun (ShadeField
// SHADE_SURFACE). \`kind\` (out): 0 a top, 1 a wall, 2 a flat wall turned.
fn shadeSurfaceAt(artPoint: vec2f, kind: ptr<function, f32>) -> f32 {
  var cell = vec2f(0.0);
  let code = floor(shadeFieldAt(artPoint, &cell).a * ${SURFACE_SCALE} + 0.5);
  *kind = 1.0;
  if (code < 0.5) { return 0.0; }
  if (code > 6.5) {
    *kind = 2.0;
    return 3.0;
  }
  if (code > 3.5) {
    *kind = 0.0;
    return code - 3.0;
  }
  return code;
}

// The step this fragment takes under the sun's shade: frame.shade.x in cast
// shade, 1 lit or turned from the sun. \`lit\` is the texel's own emission
// share.
fn sunShadeStep(geometry: vec4f, surfaceCoded: bool, lit: f32) -> f32 {
  if (v_receiver.x < -0.5 || (v_flags & ${SKIP_FLAGS}u) != 0u) { return 1.0; }
  let artPoint = floor(v_world - v_originFrac) + v_originFrac + 0.5;
  let landmark = v_identity.y != 0u;
  let cornered = v_receiver.z > -0.5;
  // 0 or 1 lit, 2 in cast shade, 3 turned (shadeSurfaceAt's verdicts).
  var verdict = 0.0;
  if (landmark || surfaceCoded || (v_flags & ${GPU_RECORD_FLAGS.sunSelf}u) != 0u) {
    // The texel's face (0 up, 1 left wall, 2 right wall, 3 roof; -1 none)
    // and height: its surface code (a part drawn over its base carries
    // the base's), else the analytic landmark geometry: above the front
    // edges a wall on its side of the front corner, before them ground.
    var face = -1.0;
    var h = 0.0;
    if (geometry.a > 0.0 && (surfaceCoded || (landmark && !cornered))) {
      face = floor(floor(geometry.b * 255.0 + 0.5) / 64.0);
      h = floor(geometry.r * 255.0 + 0.5);
    } else if (landmark && cornered) {
      let edgeY = v_receiver.z - abs(artPoint.x - v_receiver.y) * 0.5;
      face = 0.0;
      if (artPoint.y < edgeY - 1.0) {
        face = 2.0;
        if (artPoint.x < v_receiver.y) { face = 1.0; }
        h = edgeY - artPoint.y;
      }
    }
    if (face > 2.5 || (face < 1.5 && (face > -0.5 || !landmark))) {
      // A right wall (face 2) is turned from the authored sun all day
      // and takes nothing. Every other texel takes the massing's
      // verdict (a landmark's added part, with no face, is a lamp, a
      // pennant, a signal banner: never stepped). Where the massing
      // draws nothing there (or, for a left wall, a turned roof
      // behind its parapet or a flat turned wall: the art's own
      // corner line stands) the texel is tested itself: a left wall
      // just outside its own foot, a deck at its own point, ground
      // by the ground's rule. A roof has no true height of its own
      // and stays lit.
      sunVerdict = 0.0;
      var kind = 0.0;
      let seen = shadeSurfaceAt(artPoint, &kind);
      let leftWall = face > 0.5 && face < 1.5;
      let ground = vec2f(artPoint.x, artPoint.y + h);
      if (seen > 0.5 && !(leftWall && (kind > 1.5 || (kind < 0.5 && seen > 2.5)))) {
        verdict = seen;
      } else if (leftWall) {
        // A sun that only grazes the wall throws no cast shade on it.
        let along = vec2f(frame.shade.z, frame.shade.w * 2.0);
        if (along.y - along.x < -${GRAZE} * length(along)
          && shadeCeilingOver(ground + ${LEFT_WALL_OUT.replace('vec2(', 'vec2f(')} * ${WALL_CLEAR}, h)) { verdict = 2.0; }
      } else if (face > -0.5 && face < 0.5) {
        if (h < 0.5) {
          if (shadeGroundAt(artPoint)) { verdict = 2.0; }
        } else if (shadeCeilingOver(ground, h)) {
          verdict = 2.0;
        }
      }
    }
  } else {
    sunVerdict = 0.0;
    let body = v_identity.x != 0u;
    let h = max(0.0, v_receiver.x - artPoint.y);
    var foot = vec2f(artPoint.x, v_receiver.x);
    // A body or prop standing on a mass (a deck, a quay, a terrace) is
    // not under it: it takes what the sun does to the surface drawn
    // under its feet (a body's at its axis). A turned wall there says
    // nothing about it, so the ceiling is asked.
    var kind = 0.0;
    let under = shadeSurfaceAt(vec2f(select(artPoint.x, v_receiver.y, body), v_receiver.x), &kind);
    if (!body) { foot.y = max(v_receiver.x, artPoint.y); }
    if (under > 0.5 && (kind < 0.5 || under < 2.5)) {
      if (under > 1.5 && under < 2.5) { verdict = 2.0; }
    } else if (shadeCeilingOver(foot - normalize(frame.shade.zw) * ${FOOT_CLEAR}, h)) {
      verdict = 2.0;
    } else if (body) {
      // The trees' canopies stand over a body: tested where the sun's
      // ray through this texel meets the ground.
      var cell = vec2f(0.0);
      if (shadeFieldAt(foot + frame.shade.zw * h, &cell).b > 0.5) { verdict = 2.0; }
    }
  }
  if (sunVerdict > -0.5) { sunVerdict = verdict; }
  if (verdict > 1.5 && verdict < 2.5) { return mix(frame.shade.x, 1.0, lit); }
  return 1.0;
}

// SD-3 — the sun's lift on a texel the field calls lit (\`ground\`: a
// ground-self terrain texel, by the ground rule; else sunShadeStep's
// verdict, never a body): \`lift\` less the texel's emission share \`lit\`,
// held under the ceiling luma unless the texel already stood above it.
fn sunLift(color: vec3f, ground: bool, lift: f32, lit: f32) -> vec3f {
  let sunlit = select(sunVerdict > -0.5 && sunVerdict < 1.5 && v_identity.x == 0u, !shadeGroundAt(v_world), ground);
  if (!sunlit) { return color; }
  let luma = dot(color, GRADE_LUMA);
  let gain = 1.0 + lift * (1.0 - lit);
  return color * min(gain, max(1.0, ${LIFT_CEILING} / max(luma, 0.0001)));
}
`;

/**
 * This frame's sun-shade uniforms from the feed (`feed.sunShade`:
 * RakingLight `frameSunShade()`, already null when the look is off, the
 * ladder has shed it, or the field is not built). Fills and returns `out`:
 * `texture` (the typed upload, or null), `rect` (u_shadeRect) and `steps`
 * (u_shade).
 */
export function resolveSunShade(feed, out = {}) {
    const shade = feed?.sunShade;
    const texture = shade?.texture?.data ? shade.texture : null;
    const rect = out.rect || (out.rect = new Float32Array(4));
    const steps = out.steps || (out.steps = new Float32Array(4));
    out.texture = texture;
    rect[0] = texture ? texture.origin[0] : 0;
    rect[1] = texture ? texture.origin[1] : 0;
    rect[2] = texture ? texture.cell[0] : 0;
    rect[3] = texture ? texture.cell[1] : 0;
    steps[0] = texture ? shade.cast : 1;
    // SD-3 — the sun's lift (0 = off).
    steps[1] = texture ? Math.max(0, Number(shade.lift) || 0) : 0;
    steps[2] = texture ? shade.sweepX : 0;
    steps[3] = texture ? shade.sweepY : 0;
    return out;
}
