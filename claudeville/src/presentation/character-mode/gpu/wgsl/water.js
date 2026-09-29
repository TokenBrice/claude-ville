// Wave 10 (10.1 Stage A) — the WGSL twins of the water includes in
// GpuWorldRenderer: WATER_MOOD_GLSL, the swell half of SEA_SWELL_GLSL (the
// hash and seam/contour fields are wgsl/seam.js), SEA_WEATHER_GLSL and
// WATER_PALETTE_GLSL (WATER_WGSL, shared by the scene and the composite), and
// SCENE_FRAGMENT's water block from `sameColour` to `applyWaterState`
// (WATER_SCENE_WGSL, scene module only: it reads the coast lattice fields and
// the batch). Expression for expression the GLSL, every number interpolated
// from the same JS constants with the same formatting; GLSL `out` parameters
// are `ptr<function, T>`, GLSL uniforms are `frame.*` / `batch.*`
// (wgsl/common.js). Needs WGSL_COMMON (glslMod), SEAM_WGSL, ATMOSPHERE_WGSL
// (cloudNoiseAt, cloudSeamField) and BEAM_WGSL (lighthouseSheen).
import {
    COAST_FIELD_FLAGS,
    COAST_PALETTE,
    MIRROR_STORM,
    OPEN_SEA_DEEPEST,
    OPEN_SEA_LIGHT_REACH,
    OPEN_SEA_STOP_SEAM,
    WATER_CAST,
} from '../../CoastBake.js';
import {
    DEEP_CREST_RUN,
    DEEP_DASH_DENSITY,
    GLINT_DASH_DENSITY,
    GLINT_NOON_BASE,
    MOON_DASH_HOLD,
    NEAR_SHORE_DASH_DENSITY,
    NOON_GLINT_FULL_TEXEL,
    SEA_BODY_ROWS,
    SEA_KEY_REACH,
    SEA_KEY_SHIFT,
    SEA_KEY_SPAN,
    SEA_KEY_WOBBLE,
    SEA_PAW_CAP_BASE,
    SEA_PAW_CAP_GAIN,
    SEA_PAW_THRESHOLD,
    SWELL_AMP_FLOOR,
    SWELL_AMP_RUN,
    SWELL_AMP_SPAN,
    SWELL_CALM_TILES,
    SWELL_CAP_CELL,
    SWELL_CHOP_FLOOR,
    SWELL_CHOP_LIT_ROWS,
    SWELL_CHOP_PERIOD,
    SWELL_CHOP_RUN,
    SWELL_CHOP_TROUGH_ROWS,
    SWELL_CHOP_WARP,
    SWELL_CHOP_WARP_CELL,
    SWELL_CLUSTER_CAPS,
    SWELL_CLUSTER_CELL,
    SWELL_CREST_GAPS,
    SWELL_CREST_HEIGHT,
    SWELL_CREST_RISE,
    SWELL_CREST_ROWS,
    SWELL_CREST_RUN,
    SWELL_GAP_GAIN,
    SWELL_LIT_ROWS,
    SWELL_LONE_CAPS,
    SWELL_NEAR_FADE,
    SWELL_SET_GAIN,
    SWELL_SET_LEAD,
    SWELL_SET_NORMAL,
    SWELL_SET_PERIOD,
    SWELL_SET_SHARE,
    SWELL_SET_SHARE_OPEN,
    SWELL_SET_WARP,
    SWELL_SET_WARP_FINE,
    SWELL_SHORE_SD,
    SWELL_TROUGH_ROWS,
    SWELL_WARP_CELL,
    SWELL_WARP_FINE_CELL,
} from '../GpuWorldRenderer.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../../../config/constants.js';

// GpuWorldRenderer glslRgb / glslRgbArray, in WGSL spelling: the same
// channel / 255 at six decimals, so both dialects hold the same f32.
function wgslRgb(rgb) {
    return `vec3f(${rgb.map(channel => (channel / 255).toFixed(6)).join(', ')})`;
}
function wgslRgbArray(name, list) {
    return `const ${name} = array<vec3f, ${list.length}>(${list.map(wgslRgb).join(', ')});`;
}

const WATER_MOOD_WGSL = /* wgsl */ `
fn applyWaterMood(color0: vec3f) -> vec3f {
    var color = color0;
    if (frame.waterMood.y > 0.0) {
        let l = dot(color, vec3f(0.2126, 0.7152, 0.0722));
        color = mix(color, l * vec3f(0.90, 1.04, 0.97), frame.waterMood.y * 0.72);
    }
    if (frame.waterMood.x > 0.0) {
        let l = dot(color, vec3f(0.2126, 0.7152, 0.0722));
        color = mix(color, l * vec3f(0.78, 0.94, 1.10), frame.waterMood.x * 0.55);
        color *= 1.0 - frame.waterMood.x * 0.2;
    }
    return clamp(color, vec3f(0.0), vec3f(1.0));
}`;

const SEA_SWELL_WGSL = /* wgsl */ `
fn deepSwellLit(p: vec2f, tick: f32, storm: f32, density: f32) -> f32 {
    let cell = floor(floor(p) / vec2f(3.0, 1.0));
    if (waterHash12(cell) >= mix(density, 0.7, storm)) { return 0.0; }
    let o = cell * vec2f(3.0, 1.0);
    let wavelength = mix(22.0, 14.0, storm);
    let phase = dot(o, vec2f(${SWELL_SET_NORMAL[0].toFixed(2)}, 1.0)) / wavelength + 0.35 * sin(o.x * 0.031) + 0.2 * sin(o.y * 0.07 + o.x * 0.013);
    let wave = phase + tick / 16.0;
    let band = fract(wave);
    let lit = band < 0.0625 || (band < 0.125 && waterBayer4(floor(p)) >= 0.5);
    if (!lit) { return 0.0; }
    let run = vec2f(floor(wave), floor(dot(o, vec2f(1.0, -${SWELL_SET_NORMAL[0].toFixed(2)})) / ${DEEP_CREST_RUN.toFixed(1)}));
    if (waterHash12(run + vec2f(59.0, 11.0)) >= ${SWELL_SET_SHARE.toFixed(2)}) { return 0.0; }
    return select(1.0, 2.0, storm > 0.5 && waterHash12(cell + vec2f(17.0, 31.0)) < 0.25);
}
fn glintDash(p: vec2f, fragPx: vec2f, glint: vec4f, texelPx: f32, tick: f32) -> f32 {
    if (glint.z < 0.5 || glint.y <= 0.0) { return 0.0; }
    let moon = glint.z > 2.5;
    let pale = glint.z > 1.5 && !moon;
    let base = select(5.0, ${GLINT_NOON_BASE.toFixed(1)}, pale);
    let halfWidth = (base + fragPx.y * glint.w) * select(1.0, 0.7, moon);
    let weight = 1.0 - abs(fragPx.x - glint.x) / max(texelPx, 1e-3) / halfWidth;
    if (weight <= 0.0) { return 0.0; }
    if (moon) {
        let cell = floor(floor(p) / vec2f(6.0, 1.0));
        let life = floor((tick + floor(waterHash12(cell + vec2f(37.0, 5.0)) * ${MOON_DASH_HOLD.toFixed(1)})) / ${MOON_DASH_HOLD.toFixed(1)});
        return select(0.0, 1.0, waterHash12(cell + vec2f(life * 5.0, life * 2.0)) < ${(GLINT_DASH_DENSITY * 0.5).toFixed(3)} * glint.y * weight * weight);
    }
    let cell = floor(floor(p) / vec2f(3.0, 1.0));
    let density = ${GLINT_DASH_DENSITY.toFixed(2)} * select(1.0, min(1.0, ${NOON_GLINT_FULL_TEXEL.toFixed(1)} / max(texelPx, 1e-3)), pale);
    if (waterHash12(cell + vec2f(tick * 7.0, tick * 3.0)) >= density * glint.y * weight) { return 0.0; }
    return select(1.0, 2.0, waterHash12(cell + vec2f(5.0, tick * 11.0)) < weight);
}
fn seaPathCap(c: vec3f) -> vec3f {
    let l = 0.5 * (max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b)));
    if (l > 0.70) { return c * (0.70 / l); }
    return c;
}
fn islandExcess(w: vec2f) -> f32 {
    let uv = vec2f(w.y / ${TILE_HEIGHT.toFixed(1)} + w.x / ${TILE_WIDTH.toFixed(1)}, w.y / ${TILE_HEIGHT.toFixed(1)} - w.x / ${TILE_WIDTH.toFixed(1)});
    let edge = clamp(uv, vec2f(-0.44), vec2f(${(MAP_SIZE - 0.56).toFixed(2)}));
    return length(uv - edge);
}
fn seaNear(excess: f32) -> f32 {
    if (excess < 1.5) { return mix(0.6, 1.0, excess / 1.5); }
    return clamp(1.0 - (excess - 1.5) / ${SWELL_NEAR_FADE.toFixed(1)}, 0.0, 1.0);
}
fn swellPhase(p: vec2f) -> f32 {
    return dot(p, vec2f(${SWELL_SET_NORMAL[0].toFixed(2)}, 1.0)) / ${SWELL_SET_PERIOD.toFixed(1)}
        + ${SWELL_SET_WARP.toFixed(2)} * seaNoise(p / vec2f(${SWELL_WARP_CELL[0].toFixed(1)}, ${SWELL_WARP_CELL[1].toFixed(1)}) + vec2f(3.0, 11.0))
        + ${SWELL_SET_WARP_FINE.toFixed(2)} * seaNoise(p / vec2f(${SWELL_WARP_FINE_CELL[0].toFixed(1)}, ${SWELL_WARP_FINE_CELL[1].toFixed(1)}) + vec2f(29.0, 5.0));
}
fn swellHeight(along: f32, setId: f32) -> f32 {
    return clamp((seaNoise(vec2f(along / ${SWELL_AMP_RUN.toFixed(1)} + 17.0, setId * 7.3)) - ${SWELL_AMP_FLOOR.toFixed(2)}) / ${SWELL_AMP_SPAN.toFixed(2)}, 0.0, 1.0);
}
fn swellCrest(p: vec2f, s: f32) -> f32 {
    let rowsIn = fract(s) * ${SWELL_SET_PERIOD.toFixed(1)};
    if (rowsIn >= ${(SWELL_CREST_ROWS + 2).toFixed(1)}) { return 0.0; }
    let setId = floor(s);
    let along = dot(p, vec2f(1.0, -${SWELL_SET_NORMAL[0].toFixed(2)}));
    let jit = waterHash12(vec2f(setId, 5.0));
    let k = floor(along / ${SWELL_CREST_RUN.toFixed(1)} + jit);
    if (waterHash12(vec2f(k + 13.0, setId * 7.0 + 3.0)) < ${SWELL_CREST_GAPS.toFixed(2)}) { return 0.0; }
    let centre = (k - jit + 0.5) * ${SWELL_CREST_RUN.toFixed(1)};
    let halfLen = ${(SWELL_CREST_RUN * 0.5).toFixed(1)} * (0.55 + 0.45 * waterHash12(vec2f(k + 5.0, setId + 1.0)));
    let dx = abs(along - centre);
    if (dx >= halfLen || swellHeight(centre, setId) <= ${SWELL_CREST_HEIGHT.toFixed(2)}) { return 0.0; }
    let r = rowsIn - floor(max(0.0, dx - halfLen + 4.0) * 0.5);
    if (r < 0.0) { return 0.0; }
    if (r < 1.0) { return ${SWELL_CREST_RISE[0].toFixed(1)}; }
    if (r < ${SWELL_CREST_ROWS.toFixed(1)}) { return ${SWELL_CREST_RISE[1].toFixed(1)}; }
    return 0.0;
}
fn swellCap(p: vec2f, s: f32, near: f32, paw: f32) -> f32 {
    let crest = swellCrest(p, s);
    if (crest > 0.5) { return crest; }
    let row = floor(p.y / ${SWELL_CAP_CELL[1].toFixed(1)});
    let x = p.x + glslMod(row, 2.0) * ${(SWELL_CAP_CELL[0] * 0.5).toFixed(1)};
    let k = vec2f(floor(x / ${SWELL_CAP_CELL[0].toFixed(1)}), row);
    let centre = vec2f(k.x * ${SWELL_CAP_CELL[0].toFixed(1)} + ${(SWELL_CAP_CELL[0] * 0.5).toFixed(1)} - glslMod(row, 2.0) * ${(SWELL_CAP_CELL[0] * 0.5).toFixed(1)}, (row + 0.5) * ${SWELL_CAP_CELL[1].toFixed(1)});
    let inSet = fract(swellPhase(centre) + ${SWELL_SET_LEAD.toFixed(2)}) < ${SWELL_SET_SHARE_OPEN.toFixed(2)};
    let clusters = mix(0.10, 0.45, near) * select(mix(${SWELL_GAP_GAIN.toFixed(2)}, 1.0, near * near), ${SWELL_SET_GAIN.toFixed(2)}, inSet) + paw;
    let crow = floor(centre.y / ${SWELL_CLUSTER_CELL[1].toFixed(1)});
    let cx = centre.x + glslMod(crow, 2.0) * ${(SWELL_CLUSTER_CELL[0] * 0.5).toFixed(1)};
    let ck = vec2f(floor(cx / ${SWELL_CLUSTER_CELL[0].toFixed(1)}), crow);
    var inCluster = false;
    if (waterHash12(ck + vec2f(101.0, 7.0)) < clusters) {
        let at = (ck + 0.35 + 0.3 * vec2f(waterHash12(ck + vec2f(103.0, 9.0)), waterHash12(ck + vec2f(107.0, 3.0)))) * vec2f(${SWELL_CLUSTER_CELL[0].toFixed(1)}, ${SWELL_CLUSTER_CELL[1].toFixed(1)});
        let d = (vec2f(cx, centre.y) - at) / vec2f(${(SWELL_CLUSTER_CELL[0] * 0.5).toFixed(1)}, ${(SWELL_CLUSTER_CELL[1] * 0.5).toFixed(1)});
        inCluster = dot(d, d) < 1.0;
    }
    let presence = select(mix(${SWELL_LONE_CAPS[0].toFixed(2)}, ${SWELL_LONE_CAPS[1].toFixed(2)}, near), ${SWELL_CLUSTER_CAPS.toFixed(2)}, inCluster);
    if (waterHash12(k + vec2f(211.0, 17.0)) >= presence) { return 0.0; }
    let local = vec2f(x - k.x * ${SWELL_CAP_CELL[0].toFixed(1)}, p.y - row * ${SWELL_CAP_CELL[1].toFixed(1)});
    let len = 3.0 + floor(waterHash12(k + vec2f(223.0, 5.0)) * 5.0);
    let x0 = floor(waterHash12(k + vec2f(227.0, 41.0)) * (${SWELL_CAP_CELL[0].toFixed(1)} - len));
    let y0 = floor(waterHash12(k + vec2f(229.0, 83.0)) * ${(SWELL_CAP_CELL[1] - 1).toFixed(1)});
    if (local.y == y0 && local.x >= x0 && local.x < x0 + len) {
        return select(1.0, 2.0, inCluster || near > 0.8);
    }
    return select(0.0, 1.0, local.y == y0 + 1.0 && local.x >= x0 + 1.0 && local.x < x0 + len - 1.0);
}
fn seaKeyReach(p: vec2f) -> f32 {
    let d = vec2f(p.x + 0.5 - ${SEA_KEY_SHIFT[0].toFixed(1)}, (p.y + 0.5 - ${((MAP_SIZE - 1) * TILE_HEIGHT * 0.5 + SEA_KEY_SHIFT[1]).toFixed(1)}) * 2.0);
    return length(d) - ${SEA_KEY_REACH.toFixed(1)} + (seaNoise(p / vec2f(700.0, 350.0) + vec2f(5.0, 9.0)) - 0.5) * ${(2 * SEA_KEY_WOBBLE).toFixed(1)};
}
fn swellForm(rowsIn: f32, period: f32, crestRows: f32, lit: f32, trough: f32, order: f32) -> f32 {
    let tin = rowsIn - crestRows;
    if (tin >= 0.0 && tin < trough && (tin < trough * 0.5 || order >= (tin - trough * 0.5) / (trough * 0.5))) { return 1.0; }
    let lin = period - rowsIn;
    return select(0.0, -1.0, lin < lit && (lin < lit * 0.5 || order >= (lin - lit * 0.5) / (lit * 0.5)));
}
fn seaBodyStop(p: vec2f, s: f32, stop: f32, excess: f32, order: f32) -> f32 {
    if (clamp((p.y - OPEN_SEA_HORIZON_Y - ${SEA_BODY_ROWS[0].toFixed(1)}) / ${(SEA_BODY_ROWS[1] - SEA_BODY_ROWS[0]).toFixed(1)}, 0.0, 1.0) <= order) { return stop; }
    let key = clamp(0.5 - seaKeyReach(p) / ${SEA_KEY_SPAN.toFixed(1)}, 0.0, 1.0);
    let calm = clamp((excess - ${SWELL_CALM_TILES[0].toFixed(1)}) / ${(SWELL_CALM_TILES[1] - SWELL_CALM_TILES[0]).toFixed(1)}, 0.0, 1.0);
    let along = dot(p, vec2f(1.0, -${SWELL_SET_NORMAL[0].toFixed(2)}));
    let h = swellHeight(along, floor(s));
    var form = swellForm(fract(s) * ${SWELL_SET_PERIOD.toFixed(1)}, ${SWELL_SET_PERIOD.toFixed(1)}, ${SWELL_CREST_ROWS.toFixed(1)},
        mix(${SWELL_LIT_ROWS[0].toFixed(1)}, ${SWELL_LIT_ROWS[1].toFixed(1)}, key) * h,
        mix(${SWELL_TROUGH_ROWS[0].toFixed(1)}, ${SWELL_TROUGH_ROWS[1].toFixed(1)}, key) * h * calm, order);
    if (form == 0.0) {
        let c = dot(p, vec2f(${SWELL_SET_NORMAL[0].toFixed(2)}, 1.0)) / ${SWELL_CHOP_PERIOD.toFixed(1)}
            + ${SWELL_CHOP_WARP.toFixed(2)} * seaNoise(p / vec2f(${SWELL_CHOP_WARP_CELL[0].toFixed(1)}, ${SWELL_CHOP_WARP_CELL[1].toFixed(1)}) + vec2f(41.0, 23.0));
        let ch = clamp((seaNoise(vec2f(along / ${SWELL_CHOP_RUN.toFixed(1)} + 7.0, floor(c) * 5.1)) - ${SWELL_CHOP_FLOOR.toFixed(2)}) / ${SWELL_AMP_SPAN.toFixed(2)}, 0.0, 1.0);
        form = swellForm(fract(c) * ${SWELL_CHOP_PERIOD.toFixed(1)}, ${SWELL_CHOP_PERIOD.toFixed(1)}, 0.0,
            mix(${SWELL_CHOP_LIT_ROWS[0].toFixed(1)}, ${SWELL_CHOP_LIT_ROWS[1].toFixed(1)}, key) * ch,
            mix(${SWELL_CHOP_TROUGH_ROWS[0].toFixed(1)}, ${SWELL_CHOP_TROUGH_ROWS[1].toFixed(1)}, key) * ch * calm, order);
    }
    return clamp(stop + form, 0.0, 6.0);
}
const OPEN_SEA_REACH: f32 = ${OPEN_SEA_LIGHT_REACH.toFixed(1)};
const OPEN_SEA_DEEPEST: f32 = ${OPEN_SEA_DEEPEST.toFixed(1)};
const OPEN_SEA_SEAM: f32 = ${OPEN_SEA_STOP_SEAM.toFixed(5)};
fn openSeaDepth(cell: vec2f) -> f32 {
    return 2.0 + (OPEN_SEA_DEEPEST - 2.0) * clamp((cell.y + 0.5 + seaSeamRows(cell) - OPEN_SEA_HORIZON_Y) / OPEN_SEA_REACH, 0.0, 1.0);
}
fn openSeaStop(depth: f32, order: f32) -> f32 {
    var stop = floor(depth);
    let frac = depth - stop;
    if (stop < OPEN_SEA_DEEPEST && frac > 1.0 - OPEN_SEA_SEAM && (frac - (1.0 - OPEN_SEA_SEAM)) / OPEN_SEA_SEAM > order) { stop += 1.0; }
    return min(stop, OPEN_SEA_DEEPEST);
}`;

const SEA_WEATHER_WGSL = /* wgsl */ `
fn seaGustAt(cell: vec2f) -> f32 {
    if (frame.seaGustRect.z <= 0.0) { return 0.0; }
    let g = (cell + 0.5 - frame.seaGustRect.xy) / (frame.seaGustRect.zw * 128.0);
    if (any(g < vec2f(0.0)) || any(g >= vec2f(1.0))) { return 0.0; }
    return textureSampleLevel(seaGust, seaGustSampler, g, 0.0).r;
}
fn seaPawAt(cell: vec2f, gust: f32, order: f32) -> bool {
    if (gust <= 0.0) { return false; }
    let ruffle = textureSampleLevel(cloudTile, cloudSampler, fract((cell + vec2f(517.0, 229.0)) / vec2f(768.0, 256.0)), 0.0).r;
    return gust + (ruffle - 0.5) * 0.36 + (order - 0.5) * 0.06 > ${SEA_PAW_THRESHOLD.toFixed(2)};
}
fn seaPawCaps(cell: vec2f, order: f32) -> f32 {
    let gust = seaGustAt(cell);
    if (seaPawAt(cell, gust, order)) { return ${SEA_PAW_CAP_BASE.toFixed(2)} + ${SEA_PAW_CAP_GAIN.toFixed(2)} * gust; }
    return 0.0;
}`;

const WATER_PALETTE_WGSL = [
    wgslRgbArray('WATER_STOPS', COAST_PALETTE.stops),
    `const WATER_FOAM: vec3f = ${wgslRgb(COAST_PALETTE.foam)};`,
    `const WATER_FOAM_CREST: vec3f = ${wgslRgb(COAST_PALETTE.foamCrest)};`,
    `const WET_SAND: vec3f = ${wgslRgb(COAST_PALETTE.wetSand)};`,
    `const WET_SAND_DARK: vec3f = ${wgslRgb(COAST_PALETTE.wetSandDark)};`,
    wgslRgbArray('SEABED_SPECKS', COAST_PALETTE.seabedSpecks),
    wgslRgbArray('CAUSTICS', COAST_PALETTE.caustics),
    `const WATER_CAST: vec3f = vec3f(${WATER_CAST.join(', ')});`,
    `const WATER_TROUGH: vec3f = ${wgslRgb(COAST_PALETTE.trough)};`,
    // A const array indexed by a runtime value is legal WGSL; the accessor
    // keeps call sites that index by a computed stop readable.
    'fn waterStopRgb(i: i32) -> vec3f { return WATER_STOPS[i]; }',
    'fn seaStopRgb(stop: f32) -> vec3f { if (stop > 5.5) { return WATER_TROUGH; } return WATER_STOPS[i32(max(stop, 0.0))]; }',
].join('\n');

/** Shared by the scene and composite modules. */
export const WATER_WGSL = [WATER_MOOD_WGSL, SEA_SWELL_WGSL, SEA_WEATHER_WGSL, WATER_PALETTE_WGSL].join('\n');

/**
 * SCENE_FRAGMENT's water block (scene module only): the coast lattice reads,
 * the 3.7 row ripple, 3.6 swash, 3.9 rain rings, 3.10 caustics, the static
 * crest frame, 3.7's storm-broken mirrors and the resident water state.
 * Reads scene.js's `var<private>` varyings v_world / v_uvClamp.
 */
export const WATER_SCENE_WGSL = /* wgsl */ `
fn sameColour(a: vec3f, b: vec3f) -> bool {
    return all(abs(a - b) < vec3f(0.0019));
}
fn waterStopIndex(c: vec3f) -> i32 {
    for (var k = 0; k < ${COAST_PALETTE.stops.length}; k++) {
        if (sameColour(c, WATER_STOPS[k])) { return k; }
    }
    return -1;
}
fn waterStopForSd(sd: f32) -> i32 {
    return i32(step(0.30, sd) + step(0.78, sd) + step(1.38, sd) + step(2.15, sd));
}
fn coastFieldAt(world: vec2f, sd: ptr<function, f32>, flags: ptr<function, u32>) -> bool {
    *sd = 0.0;
    *flags = 0u;
    if (frame.coastRect.z <= 0.0) { return false; }
    let cell = vec2i(floor((world - frame.coastRect.xy) * 0.5));
    if (cell.x < 0 || cell.y < 0 || cell.x >= i32(frame.coastRect.z) || cell.y >= i32(frame.coastRect.w)) { return false; }
    let field = textureLoad(coastField, cell, 0).rg;
    *sd = (floor(field.r * 255.0 + 0.5) - 128.0) / 64.0;
    *flags = u32(field.g * 255.0 + 0.5);
    return true;
}
fn cycleOffsetAt(world: vec2f) -> f32 {
    if (frame.coastRect.z <= 0.0) { return 255.0; }
    let cell = vec2i(floor((world - frame.coastRect.xy) * 0.5));
    if (cell.x < 0 || cell.y < 0 || cell.x >= i32(frame.coastRect.z) || cell.y >= i32(frame.coastRect.w)) { return 255.0; }
    return floor(textureLoad(cycleOffset, cell, 0).r * 255.0 + 0.5);
}
fn reflectionRippleUv(uv: vec2f, uvStepX: f32) -> vec2f {
    var sd: f32;
    var flags: u32;
    if (!coastFieldAt(v_world, &sd, &flags) || (flags & 1u) == 0u) { return uv; }
    let row = floor(v_world.y);
    let phase = glslMod(floor(waterHash12(vec2f(row, 7.0)) * 8.0) + floor(frame.timeMs * 0.002 * frame.waterFx.x), 8.0);
    let dx = select(select(0.0, 1.0, abs(phase - 4.0) < 0.5), -1.0, phase < 0.5);
    if (dx == 0.0) { return uv; }
    var shiftedSd: f32;
    var shiftedFlags: u32;
    if (!coastFieldAt(v_world + vec2f(dx, 0.0), &shiftedSd, &shiftedFlags) || (shiftedFlags & 1u) == 0u) { return uv; }
    return vec2f(clamp(uv.x + dx * uvStepX, v_uvClamp.x, v_uvClamp.z), uv.y);
}
fn applyCoastSwash(color: vec3f, px: vec2f) -> vec3f {
    var sd: f32;
    var flags: u32;
    if (!coastFieldAt(px, &sd, &flags) || (flags & 2u) == 0u) { return color; }
    let cyc = glslMod(floor(frame.timeMs * 0.005 * frame.waterFx.x), 8.0);
    let reach = select(select(0.0, 6.0 - cyc, cyc < 7.0), cyc, cyc < 4.0);
    if (sd > 0.0) {
        if (waterStopIndex(color) < 0 && !sameColour(color, WATER_FOAM) && !sameColour(color, WATER_FOAM_CREST)) {
            return color;
        }
        let front = 0.05 + reach * 0.035;
        if (sd < front - 0.035) { return WATER_FOAM; }
        if (sd < front) { return WATER_FOAM_CREST; }
        if (sd < front + 0.06 && waterBayer4(floor(px)) < 0.5) { return WATER_FOAM; }
        return color;
    }
    let extent = select(3.0, cyc, cyc < 4.0);
    let darker = select(select(0.0, 1.0, cyc < 6.5), 2.0, cyc < 4.5);
    if (darker < 0.5 || sd <= -0.02 - extent * 0.035) { return color; }
    if (sameColour(color, WET_SAND_DARK)) { return color; }
    if (sameColour(color, WET_SAND)) { return WET_SAND_DARK; }
    let beach = color.r > color.b + 0.12 && color.r >= color.g && dot(color, vec3f(0.2126, 0.7152, 0.0722)) > 0.45;
    if (beach) { return select(WET_SAND, WET_SAND_DARK, darker > 1.5); }
    return color;
}
fn rainRingAt(p: vec2f, precipitation: f32, storm: f32, clock: f32) -> bool {
    let size = mix(vec2f(12.0, 6.0), vec2f(8.0, 4.0), storm);
    let cell = floor(p / size);
    let local = p - cell * size;
    let seed = waterHash12(cell + vec2f(41.0, 7.0));
    var stage = 2.0;
    var life = 0.0;
    if (clock > 0.0) {
        let s = floor(frame.timeMs * 0.007 * clock) + floor(seed * 5.0);
        life = floor(s / 5.0);
        stage = glslMod(s, 5.0);
        if (waterHash12(cell + vec2f(life * 1.7, 3.1)) >= 0.55 * precipitation) { return false; }
    } else if (seed >= min(0.20, 0.55 * precipitation)) {
        return false;
    }
    if (stage > 3.5 || (storm > 0.5 && stage > 2.5)) { return false; }
    let room = select(vec2f(4.0, 2.0), vec2f(2.0, 1.0), storm > 0.5);
    let jitter = vec2f(waterHash12(cell + vec2f(life, 13.0)), waterHash12(cell + vec2f(29.0, life)));
    let centre = room + floor(jitter * (size - room * 2.0));
    let d = abs(local - centre);
    if (stage < 0.5) { return d.x < 0.5 && d.y < 0.5; }
    if (stage < 1.5) { return d.y < 0.5 && abs(d.x - 1.0) < 0.5; }
    if (stage < 2.5) { return (abs(d.y - 1.0) < 0.5 && d.x < 1.5) || (d.y < 0.5 && abs(d.x - 2.0) < 0.5); }
    return (abs(d.y - 2.0) < 0.5 && d.x < 2.5) || (abs(d.y - 1.0) < 0.5 && abs(d.x - 3.0) < 0.5)
        || (d.y < 0.5 && abs(d.x - 4.0) < 0.5);
}
fn causticAt(p: vec2f, clock: f32) -> bool {
    let t8 = glslMod(floor(frame.timeMs * 0.004 * clock), 8.0) / 8.0;
    let a = (p.x * 0.5 + p.y) / 9.0 + 0.45 * sin((p.x * 0.5 - p.y) * 0.13) + t8;
    let b = (p.y - p.x * 0.5) / 13.0 + 0.45 * sin((p.x * 0.5 + p.y) * 0.09) - t8;
    return fract(a) >= 0.92 || fract(b) >= 0.92;
}
fn staticWaterDashes(color0: vec3f, px: vec2f) -> vec3f {
    let depthLuma = dot(color0, vec3f(0.2126, 0.7152, 0.0722));
    let color = applyWaterMood(color0);
    let storm = step(0.5, frame.weather.z);
    let cellSize = mix(vec2f(8.0, 4.0), vec2f(6.0, 3.0), storm);
    let cell = floor(px / cellSize);
    let local = floor(px) - cell * cellSize;
    let seed = fract(sin(dot(cell, vec2f(12.9898, 78.233))) * 43758.5453);
    let dashX = floor(seed * (cellSize.x - 2.0));
    let dashY = floor(fract(seed * 7.13) * cellSize.y);
    let present = step(fract(seed * 31.7), mix(0.30, 0.55, storm));
    let onDash = present * step(dashX, local.x) * step(local.x, dashX + 2.0) * (1.0 - step(0.5, abs(local.y - dashY)));
    let lit = 1.0 - step(0.5, glslMod(floor(seed * 4.0), 4.0));
    var contrast = mix(0.10, 0.16, storm);
    contrast = mix(contrast, min(contrast, 0.06), frame.overcast * (1.0 - storm));
    contrast *= clamp((depthLuma - 0.27) / 0.15, mix(0.15, 0.35, storm), 1.0);
    return color * WATER_CAST * (1.0 + contrast * onDash * lit);
}
fn mirrorBaseStop(world: vec2f) -> i32 {
    if (frame.coastRect.z <= 0.0) { return -1; }
    let texel = vec2i(floor(world - frame.coastRect.xy));
    let cell = texel >> vec2u(1u);
    if (cell.x < 0 || cell.y < 0 || cell.x >= i32(frame.coastRect.z) || cell.y >= i32(frame.coastRect.w)) { return -1; }
    let rows = textureLoad(coastField, cell, 0).ba;
    let packed = i32(select(rows.y, rows.x, (texel.y & 1) == 0) * 255.0 + 0.5);
    return (select(packed >> 4u, packed, (texel.x & 1) == 0) & 15) - 1;
}
fn mirrorStormDrop() -> f32 {
    let share = clamp((frame.weather.x - ${MIRROR_STORM.from.toFixed(2)}) / ${MIRROR_STORM.span.toFixed(2)}, 0.0, 1.0);
    return floor(share * ${MIRROR_STORM.steps.toFixed(1)} + 0.5) / ${MIRROR_STORM.steps.toFixed(1)};
}
fn mirrorStormColour(color: vec3f, px: vec2f, gone: ptr<function, bool>) -> vec3f {
    *gone = false;
    if (batch.terrainBatch == 0u || frame.weather.x <= ${MIRROR_STORM.from.toFixed(2)}) { return color; }
    let drop = mirrorStormDrop();
    if (drop <= 0.0 || waterBayer4(floor(px)) >= drop) { return color; }
    let stop = mirrorBaseStop(px);
    if (stop < 0) { return color; }
    *gone = true;
    return WATER_STOPS[stop];
}
fn applyWaterState(color0: vec3f, px: vec2f, seaPath: ptr<function, bool>) -> vec3f {
    *seaPath = false;
    var color = color0;
    if (color.b < color.r + 0.02 || color.g < color.r) {
        var sd: f32;
        var flags: u32;
        if (batch.terrainBatch != 0u && coastFieldAt(px, &sd, &flags) && (flags & 1u) != 0u) {
            return applyWaterMood(color) * WATER_CAST;
        }
        return color;
    }
    let stop = waterStopIndex(color);
    let clock = frame.waterFx.x;
    let p = floor(px);
    if (stop < 0) {
        if (clock <= 0.0) { return staticWaterDashes(color, px); }
        return applyWaterMood(color) * WATER_CAST;
    }
    let storm = step(0.5, frame.weather.z);
    let deepTick = floor(frame.timeMs * 0.006 * clock);
    let glint = glintDash(p, (p + 0.5 + frame.cameraXy) * frame.cameraScale, frame.glint, frame.cameraScale, deepTick);
    if (glint > 0.5) {
        *seaPath = true;
        return frame.glintStops[select(1, 0, glint > 1.5)].xyz;
    }
    let beam = lighthouseSheen(p);
    if (beam > 0.5) {
        *seaPath = true;
        lighthouseDash = true;
        return lighthouseStop(beam);
    }
    var base = stop;
    var cap = 0.0;
    var near = 0.0;
    if (stop >= 2) {
        let order = waterBayer4(p);
        let open = f32(stop) >= openSeaStop(openSeaDepth(p), order);
        var sd: f32;
        var flags: u32;
        let shelf = !open && coastFieldAt(p, &sd, &flags) && (flags & ${COAST_FIELD_FLAGS.sea}u) != 0u && sd > ${SWELL_SHORE_SD.toFixed(2)};
        if (open || shelf) {
            let excess = islandExcess(p + 0.5);
            let s = swellPhase(p);
            near = seaNear(excess);
            if (open) { base = i32(seaBodyStop(p, s, f32(stop), excess, order)); }
            if (open && frame.seaSunlit > 0.0 && cloudSeamField(p, cloudNoiseAt(p), order, frame.seaSunlit) < frame.seaSunlit) { base = max(base - 1, 0); }
            var paw = 0.0;
            if (open) { paw = seaPawCaps(p, order); }
            cap = swellCap(p, s, near, paw);
        }
    }
    if (base != stop) { color = seaStopRgb(f32(base)); }
    let lighter = max(base - 1, 0);
    var shallower = WATER_FOAM_CREST;
    if (base > 1) { shallower = WATER_STOPS[lighter]; }
    if (frame.waterFx.y > 0.0 && rainRingAt(p, frame.waterFx.y, storm, clock)) {
        if (base == 0) { return applyWaterMood(WATER_FOAM) * WATER_CAST; }
        return applyWaterMood(WATER_STOPS[lighter]) * WATER_CAST;
    }
    let shallows = stop <= 1;
    if (shallows && waterHash12(floor(p / vec2f(2.0, 1.0)) + vec2f(3.0, 71.0)) < 0.04) {
        return applyWaterMood(SEABED_SPECKS[stop]) * WATER_CAST;
    }
    if (cap > 0.5 && clock <= 0.0) { return applyWaterMood(WATER_STOPS[max(base - i32(cap), 0)]) * WATER_CAST; }
    if (clock <= 0.0) {
        if (shallows && frame.waterFx.z > 0.0 && causticAt(p, 0.0)) { return applyWaterMood(CAUSTICS[stop]) * WATER_CAST; }
        return staticWaterDashes(color, px);
    }
    let cell = floor(p / vec2f(3.0, 1.0));
    let origin = cell * vec2f(3.0, 1.0);
    let offset = cycleOffsetAt(origin);
    var course = 0.0;
    if (offset < 31.5) {
        if (waterHash12(cell) < mix(${NEAR_SHORE_DASH_DENSITY.toFixed(2)}, 0.7, storm)) {
            let entry = glslMod(glslMod(offset, 16.0) + floor(frame.timeMs * 0.004 * clock), 16.0);
            course = select(select(0.0, 2.0, entry > 13.5), 1.0, entry > 14.5);
            if (course > 0.0 && storm > 0.5 && waterHash12(cell + vec2f(17.0, 31.0)) < 0.25) { course = 3.0; }
        }
    } else if (stop >= 2) {
        var density = ${NEAR_SHORE_DASH_DENSITY.toFixed(2)};
        if (stop >= 3) { density = ${DEEP_DASH_DENSITY.toFixed(2)}; }
        let lit = deepSwellLit(p, deepTick, storm, density);
        course = select(lit, 3.0, lit > 1.5);
    }
    if (course > 2.5) { return applyWaterMood(WATER_FOAM) * WATER_CAST; }
    if (course > 1.5) { return applyWaterMood(shallower) * WATER_CAST; }
    var crestRise = 0;
    if (course > 0.5) { crestRise = select(1, 2, offset > 31.5 && near > 0.8); }
    let rise = max(i32(cap), crestRise);
    if (rise > 0) { return applyWaterMood(WATER_STOPS[max(base - rise, 0)]) * WATER_CAST; }
    if (shallows && frame.waterFx.z > 0.0 && causticAt(p, clock)) { return applyWaterMood(CAUSTICS[stop]) * WATER_CAST; }
    return applyWaterMood(color) * WATER_CAST;
}
`;
