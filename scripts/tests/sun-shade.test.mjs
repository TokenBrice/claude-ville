import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    SHADE_CANOPY_MIN,
    SHADE_CEILING_STEP,
    SHADE_CELL_H,
    SHADE_CELL_W,
    SHADE_FOOT_CLEAR,
    SHADE_GRAZE,
    SHADE_MASSING_REVISION,
    SHADE_RECEIVER_BIAS,
    SHADE_SURFACE,
    SHADE_SURFACE_STEP,
    SHADE_WALL_CLEAR,
    buildShadeField,
    createShadeFieldBuild,
    createShadeViewBuild,
    latheStamp,
    paintLitCells,
    shadeCeilingAt,
    shadeCoverageAt,
    shadeFieldTexture,
    shadeSelfProp,
    solidFacets,
} from '../../claudeville/src/presentation/character-mode/ShadeField.js';
import { SUN_LIFT_CANDLE, SUN_LIFT_CEILING, SUN_LIFT_GRADED_CEILING, SUN_SHADE_GLSL, SUN_SHADE_WGSL, resolveSunShade } from '../../claudeville/src/presentation/character-mode/gpu/SunShade.js';
import { EFFECT_BUDGET, GPU_RECORD_FLAGS, assignGpuRecordV9Fields, effectBudgetMode } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { resolveOccluderChannel } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { FRAME_BINDING, FRAME_BINDINGS_WGSL, FRAME_UNIFORM_LAYOUT } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { SCENE_SAMPLER_UNITS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import {
    SHADE_RECEIVER_CAST,
    SUN_LIFT,
    canvasSunLiftRgb,
    canvasSunLiftSteps,
    castLightingFor,
    frameSunShade,
    setFrameCastLighting,
    sunLiftFor,
    sundialShadeFor,
    villagerCastLighting,
} from '../../claudeville/src/presentation/character-mode/RakingLight.js';
import { applyGradeToRgb, evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { frostShadeKey } from '../../claudeville/src/presentation/character-mode/FrostMelt.js';
import { terrainArtifactKey } from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { PROP_MASSING } from '../../claudeville/src/config/landmarkMassing.js';
import { massingReport } from '../sprites/massing.mjs';

// SD-2 — receivers take the sun's shade: the field's four-byte texels (the
// massing's verdict per drawn position, the canopies), the GLSL / WGSL twins
// and their wiring, and the looks that drive them.

const RECT = Object.freeze({ originX: 0, originY: 0, cellW: SHADE_CELL_W, cellH: SHADE_CELL_H, cols: 200, rows: 220 });
const plain = (tx, ty) => [tx, ty];
const S = SHADE_SURFACE;
const WALLS = [S.wallLit, S.wallCast, S.wallTurned, S.flatTurned];

// A whole receivers' field over RECT, and a texel reader at a world point.
function texelsFor({ sweep, facets = [], lathes = [] }) {
    const view = createShadeViewBuild({ rect: RECT, facets });
    view.step();
    const field = buildShadeField({ rect: RECT, sweep, facets, lathes, texels: new Uint8Array(RECT.cols * RECT.rows * 4), view: view.view });
    const at = (x, y) => {
        const i = (Math.floor(y) * RECT.cols + Math.floor(x / SHADE_CELL_W)) * 4;
        return { ceiling: field.texels[i] * SHADE_CEILING_STEP, cover: field.texels[i + 1], canopy: field.texels[i + 2], surface: field.texels[i + 3] / SHADE_SURFACE_STEP };
    };
    return { field, at };
}

const box = (x0, y0, x1, y1, top, base) => solidFacets({ kind: 'box', at: [x0, y0, x1, y1], top, base }, plain);

test('the texels carry the two field bytes and what the massing shows at each drawn position', () => {
    // A 40-px box; the sun in front and to the left (the shadow runs up-right).
    const { field, at } = texelsFor({ sweep: { sx: 1, sy: -0.5 }, facets: box(60, 100, 100, 140, 40) });
    assert.equal(field.texels.length, RECT.cols * RECT.rows * 4);
    assert.equal(at(80, 120).ceiling, shadeCeilingAt(field, 80, 120));
    assert.equal(at(80, 120).cover, 255);
    assert.equal(at(80, 120).cover / 255, shadeCoverageAt(field, 80, 120));
    // Its top draws 40 px up; its front wall (the edge y = 140) below that.
    assert.equal(at(80, 80).surface, S.topLit, 'the top, seen at its drawn position');
    assert.equal(at(80, 125).surface, S.wallLit, 'the sunward front wall');
    assert.equal(at(80, 150).surface, S.none, 'open ground before it');
    assert.equal(at(30, 80).surface, S.none);
    const texture = shadeFieldTexture(field);
    assert.equal(texture.format, 'rgba8');
    assert.equal(texture.data, field.texels);
});

test('another mass up-sun puts a top and a sunward wall in cast shade; their own mass never does', () => {
    const low = box(60, 100, 100, 140, 40);
    const tall = box(10, 130, 50, 170, 120);
    const alone = texelsFor({ sweep: { sx: 1, sy: -0.5 }, facets: low });
    const shaded = texelsFor({ sweep: { sx: 1, sy: -0.5 }, facets: [...low, ...tall] });
    for (let x = 62; x < 100; x += 4) {
        for (let y = 62; y < 100; y += 4) assert.equal(alone.at(x, y).surface, S.topLit, `own top at ${x},${y}`);
        for (let y = 104; y < 138; y += 4) assert.equal(alone.at(x, y).surface, S.wallLit, `own wall at ${x},${y}`);
    }
    assert.equal(shaded.at(80, 80).surface, S.topCast);
    assert.equal(shaded.at(80, 120).surface, S.wallCast);
    // The tall box's own top, above every ceiling, stays lit.
    assert.equal(shaded.at(30, 30).surface, S.topLit);
});

test('a flat wall turned from the sweep is told from a round one; a wall the sun grazes takes no cast shade', () => {
    // The shadow runs down-right: the front wall faces away from the sun.
    const turned = texelsFor({ sweep: { sx: 1, sy: 0.5 }, facets: box(60, 100, 100, 140, 40) });
    assert.equal(turned.at(80, 125).surface, S.flatTurned);
    assert.equal(turned.at(80, 80).surface, S.topLit, 'a flat top is never turned');
    // A cylinder: lit on the sun's side, turned (round) past its terminator.
    const drum = solidFacets({ kind: 'cylinder', centre: [100, 110], radius: 30, top: 50 }, plain);
    const round = texelsFor({ sweep: { sx: 2, sy: 0 }, facets: drum });
    assert.equal(round.at(78, 115).surface, S.wallLit);
    assert.equal(round.at(122, 115).surface, S.wallTurned);
    // Straight along the front wall (cosine 0 < SHADE_GRAZE): lit, untested,
    // even with a tall mass standing up-sun of it.
    assert.ok(SHADE_GRAZE > 0 && SHADE_GRAZE < 0.5);
    const grazed = texelsFor({ sweep: { sx: 2, sy: 0 }, facets: [...box(60, 100, 100, 140, 40), ...box(10, 100, 40, 160, 150)] });
    assert.equal(grazed.at(80, 125).surface, S.wallLit);
    assert.equal(grazed.at(80, 80).surface, S.topCast, 'its top is under the tall mass all the same');
});

test('a pitch turned from the sun is told from a lit one; two pitches meet with no wall between them', () => {
    // Ridge along x at y = 120, 40 px high over 30-px eaves; a low sun in front.
    const gable = solidFacets({ kind: 'gable', at: [60, 100, 100, 140], eave: 30, ridge: 40, axis: 'x' }, plain);
    const { at } = texelsFor({ sweep: { sx: 0, sy: -2.5 }, facets: gable });
    assert.equal(at(80, 75).surface, S.topTurned, 'the far pitch');
    assert.equal(at(80, 95).surface, S.topLit, 'the near pitch');
    for (let y = 71; y < 110; y++) assert.ok(!WALLS.includes(at(80, y).surface), `no wall on the roof at row ${y}`);
});

test('a round top turns about its axis, not gore by gore', () => {
    const dome = solidFacets({ kind: 'dome', centre: [100, 120], radius: 40, eave: 20, apex: 60 }, plain);
    for (const f of dome.slice(0, -1)) assert.deepEqual(Array.from(f.axis), [100, 120]);
    const { at } = texelsFor({ sweep: { sx: 2.5, sy: 0 }, facets: dome });
    // Along each drawn row of the dome's top the surface flips from lit to
    // turned once (the sun stands to the left), with no island of either.
    let rows = 0;
    for (let y = 70; y <= 100; y += 3) {
        let flips = 0;
        let last = null;
        for (let x = 62; x < 140; x += 2) {
            const surface = at(x, y).surface;
            if (surface !== S.topLit && surface !== S.topTurned) continue;
            if (last !== null && surface !== last) flips++;
            last = surface;
        }
        assert.ok(flips <= 1, `row ${y} flips ${flips} times`);
        rows += flips;
    }
    assert.ok(rows >= 6, 'the terminator crosses the dome');
});

test('a raised solid lets the sun under it and shades only the ground its shadow reaches', () => {
    const sweep = { sx: 2, sy: 0 };
    const solid = buildShadeField({ rect: RECT, sweep, facets: box(60, 100, 100, 110, 60) });
    const raised = buildShadeField({ rect: RECT, sweep, facets: box(60, 100, 100, 110, 60, 40) });
    assert.equal(shadeCoverageAt(solid, 110, 105), 1);
    assert.equal(shadeCoverageAt(raised, 62, 105), 0, 'under its up-sun edge');
    assert.equal(shadeCoverageAt(raised, 130, 105), 0, 'the gap between the posts\' line and its shadow');
    assert.equal(shadeCoverageAt(raised, 150, 105), 1);
    assert.equal(shadeCeilingAt(raised, 150, 105), shadeCeilingAt(solid, 150, 105), 'where it shades, as the solid does');
    assert.equal(shadeCoverageAt(raised, 226, 105), 0, 'past the tip');
    // The eye sees its faces from the underside up, and nothing under it.
    const { at } = texelsFor({ sweep, facets: box(60, 100, 100, 110, 60, 40) });
    assert.ok(WALLS.includes(at(80, 58).surface));
    assert.equal(at(80, 90).surface, S.none);
});

test('a tree\'s canopy is written apart from its trunk, and only for a receivers\' field', () => {
    const profile = { slabs: [{ z0: 0, z1: 30, r: 3, cx: 0, cov: 1 }, { z0: SHADE_CANOPY_MIN + 10, z1: SHADE_CANOPY_MIN + 40, r: 16, cx: 0, cov: 1 }], height: SHADE_CANOPY_MIN + 40 };
    assert.equal(latheStamp(profile, { sx: 2, sy: 0 }).canopy, null);
    const stamp = latheStamp(profile, { sx: 2, sy: 0 }, undefined, SHADE_CANOPY_MIN);
    assert.ok(stamp.canopy.some(value => value > 0));
    const lathe = { x: 40, y: 110, profile, key: 'oak', canopy: true };
    const { at } = texelsFor({ sweep: { sx: 2, sy: 0 }, lathes: [lathe] });
    const crown = 40 + (SHADE_CANOPY_MIN + 25) * 2;
    assert.ok(at(crown, 110).canopy > 128 && at(crown, 110).cover > 128, 'under the crown\'s shadow');
    assert.ok(at(40 + 30, 110).cover > 0, 'the trunk shades the ground');
    assert.equal(at(40 + 30, 110).canopy, 0, 'but stands over nobody');
    assert.equal(at(crown, 110).ceiling, 0, 'and a lathe still raises no ceiling');
    // A prop's lathe (no canopy flag) writes none.
    assert.equal(texelsFor({ sweep: { sx: 2, sy: 0 }, lathes: [{ ...lathe, canopy: false }] }).at(crown, 110).canopy, 0);
});

test('a sliced receivers\' build is the build run at once', () => {
    const facets = [...box(60, 100, 100, 140, 40), ...solidFacets({ kind: 'cone', centre: [150, 120], radius: 20, eave: 30, apex: 70 }, plain)];
    const whole = texelsFor({ sweep: { sx: 1.5, sy: 0.25 }, facets });
    const view = createShadeViewBuild({ rect: RECT, facets });
    let guard = 0;
    while (!view.step(0) && guard++ < 100000);
    const job = createShadeFieldBuild({ rect: RECT, sweep: { sx: 1.5, sy: 0.25 }, facets, texels: new Uint8Array(RECT.cols * RECT.rows * 4), view: view.view });
    while (!job.step(0) && guard++ < 200000);
    assert.ok(job.done && guard > 4, 'it yielded on the way');
    assert.deepEqual(job.field.texels, whole.field.texels);
});

test('the GLSL and WGSL twins carry the same functions, constants and tests', () => {
    const functions = (source, re) => [...source.matchAll(re)].map(match => match[1]);
    const names = ['shadeFieldAt', 'shadeGroundAt', 'sunTrailHidden', 'shadeCeilingOver', 'shadeSurfaceAt', 'sunShadeStep', 'sunLift', 'sunLiftGraded', 'sunLiftFinal'];
    assert.deepEqual(functions(SUN_SHADE_GLSL, /^(?:bool|vec3|vec4|float)\s+(\w+)\(/gm), names);
    assert.deepEqual(functions(SUN_SHADE_WGSL, /^fn\s+(\w+)\(/gm), names);
    const numbers = source => (source.match(/(?<![\w.])\d+\.\d+/g) || []).join(' ');
    assert.equal(numbers(SUN_SHADE_GLSL), numbers(SUN_SHADE_WGSL), 'every constant, in order');
    // The same comparisons and connectives in the same order (the WGSL
    // return arrows and pointer types are not comparisons).
    const logic = source => (source.replace(/\/\/.*$/gm, '').replace(/->|ptr<function, \w+>|var<private>/g, '').match(/&&|\|\||[<>!=]=|[<>]/g) || []).join(' ');
    assert.equal(logic(SUN_SHADE_GLSL), logic(SUN_SHADE_WGSL));
    assert.ok(logic(SUN_SHADE_GLSL).split(' ').length > 60);
    for (const source of [SUN_SHADE_GLSL, SUN_SHADE_WGSL]) {
        for (const value of [SHADE_RECEIVER_BIAS, SHADE_WALL_CLEAR, SHADE_FOOT_CLEAR]) assert.ok(source.includes(`${value.toFixed(1)}`));
        assert.ok(source.includes((255 * SHADE_CEILING_STEP).toFixed(1)), 'the ceiling byte in world px');
        assert.ok(source.includes((255 / SHADE_SURFACE_STEP).toFixed(5)), 'the surface code');
        assert.ok(source.includes(`${GPU_RECORD_FLAGS.sunSelf}u`));
        // One step only, for cast shade (bodies softened to ~0.82): a turned
        // verdict takes nothing, so no constant step rides every right wall and far pitch.
        assert.equal(source.split('return mix(').length, 2, 'one stepped return');
        assert.ok(/if \(v_identity\.x != 0u\) \{? ?stepVal = mix\(1\.0, (?:u_shade|frame\.shade)\.x, 0\.52\);/.test(source), 'body cast shade softened');
        assert.ok(source.includes('return mix(stepVal, 1.0, lit);'));
        assert.ok(!/shade\.y/.test(source) && !/verdict = 3\.0/.test(source), 'no attached step, no right wall forced to one');
    }
});

test('attention loses nothing in shade: an action-needed body and a candle are never stepped', () => {
    assert.equal(GPU_RECORD_FLAGS.shadeExempt, 8192);
    assert.equal(assignGpuRecordV9Fields({}, { shadeExempt: true }, 1, 'normal').flags & 8192, 8192);
    assert.equal(assignGpuRecordV9Fields({}, {}, 1, 'normal').flags & 8192, 0);
    // Both twins leave such a record (and marks, and reflections) before any read.
    const skip = GPU_RECORD_FLAGS.screenSpace | GPU_RECORD_FLAGS.reflect | GPU_RECORD_FLAGS.shadeExempt;
    assert.ok(SUN_SHADE_GLSL.includes(`float sunShadeStep(vec4 geometry, bool surfaceCoded, float lit) {\n    if (v_receiver.x < -0.5 || (v_flags & ${skip}u) != 0u) return 1.0;`));
    assert.ok(SUN_SHADE_WGSL.includes(`fn sunShadeStep(geometry: vec4f, surfaceCoded: bool, lit: f32) -> f32 {\n  if (v_receiver.x < -0.5 || (v_flags & ${skip}u) != 0u) { return 1.0; }`));
    // The body's record carries the flag for the three action-needed statuses alone.
    const source = { width: 16, height: 16 };
    const bodyFor = (status, isDeparted = false) => {
        const host = { gpuWorldEnabled: true, spriteCanvas: source, _gpuBaseSpriteCanvas: source, agent: { id: 'a', provider: 'claude', status, isDeparted }, assets: {} };
        new AgentGpuOverlayRenderer(host).setFrameRecord({ cell: { sx: 0, sy: 0, sw: 8, sh: 8 }, dx: 0, dy: 0, drawScale: 1, profileKey: 'p', spriteId: 's' });
        return host._gpuFrameRecord;
    };
    for (const status of [AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED]) {
        assert.equal(bodyFor(status).shadeExempt, true, status);
        assert.equal(assignGpuRecordV9Fields({}, bodyFor(status), 1, 'normal').flags & 8192, 8192);
    }
    for (const status of [AgentStatus.WORKING, AgentStatus.WAITING, AgentStatus.IDLE, AgentStatus.COMPLETED]) assert.equal(bodyFor(status).shadeExempt, false, status);
    assert.equal(bodyFor(AgentStatus.WAITING_ON_USER, true).shadeExempt, false, 'a departed tableau asks for nothing');
    // What lies on that body, and the wait's own candle, carry it too.
    const sprite = readFileSync(new URL('../../claudeville/src/presentation/character-mode/AgentSprite.js', import.meta.url), 'utf8');
    assert.ok(/this\._candleRecord = \{[^}]*shadeExempt: true \}/.test(sprite), 'the petitioner\'s candle');
    assert.ok(/this\._frostGpuRecord = \{[^}]*shadeExempt: true,?\s*\}/.test(sprite), 'the rate-limited frost tint');
    assert.ok(sprite.includes('record.shadeExempt = body.shadeExempt;'), 'the snow course on a body');
});

test('both scene shaders wire the step the same way: after the sun band, before the grade, never on an additive batch', () => {
    const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
    const glsl = read('gpu/GpuWorldRenderer.js');
    const wgsl = read('gpu/wgsl/scene.js');
    assert.ok(glsl.includes('${SUN_SHADE_GLSL}\nvec3 applyAuthoredSunBand('));
    assert.ok(wgsl.includes('${SUN_SHADE_WGSL}\nfn applyAuthoredSunBand('));
    for (const [source, band, guard, call, grade] of [
        [glsl, 'color = applyAuthoredSunBand(color, material);', 'if (u_shadeRect.w > 0.0 && !u_additive) {',
            'color *= sunShadeStep(geometry, surfaceCoded, u_hasEmissiveMap ? clamp(emissive, 0.0, 1.0) : 0.0);', 'color = applyTimeGrade('],
        [wgsl, 'color = applyAuthoredSunBand(color, material);', 'if (frame.shadeRect.w > 0.0 && batch.additive == 0u) {',
            'color *= sunShadeStep(geometry, surfaceCoded, select(0.0, clamp(emissive, 0.0, 1.0), batch.hasEmissiveMap != 0u));', 'color = applyTimeGrade('],
    ]) {
        const at = [band, guard, 'sunTrailHidden()', call, grade].map(text => source.indexOf(text, source.indexOf(band)));
        assert.ok(at.every(index => index >= 0), 'every line is there');
        assert.deepEqual(at, at.slice().sort((a, b) => a - b), 'in this order');
        assert.equal(source.split('sunShadeStep(geometry').length, 2, 'one call site');
    }
    // The field's unit, binding and frame fields.
    assert.equal(SCENE_SAMPLER_UNITS.shadeField, 2);
    assert.equal(new Set(Object.values(SCENE_SAMPLER_UNITS)).size, Object.keys(SCENE_SAMPLER_UNITS).length, 'no unit is shared');
    assert.equal(FRAME_BINDING.shadeField, 17);
    assert.equal(new Set(Object.values(FRAME_BINDING)).size, Object.keys(FRAME_BINDING).length);
    assert.ok(FRAME_BINDINGS_WGSL.includes('@group(0) @binding(17) var shadeField: texture_2d<f32>;'));
    const fields = FRAME_UNIFORM_LAYOUT.fields.map(field => field.name);
    assert.deepEqual(fields.slice(fields.indexOf('mistBurn') + 1, fields.indexOf('mistBurn') + 3), ['shadeRect', 'shade']);
    assert.ok(glsl.includes("'u_shadeField', 'u_shadeRect', 'u_shade',"));
});

test('resolveSunShade binds nothing until the frame hands it a built field', () => {
    const off = resolveSunShade({});
    assert.equal(off.texture, null);
    assert.deepEqual(Array.from(off.rect), [0, 0, 0, 0], 'a zero rect: no fragment reads the field');
    assert.deepEqual(Array.from(off.steps), [1, 0, 0, 0]);
    const texture = { width: 4, height: 2, format: 'rgba8', data: new Uint8Array(32), revision: 3, origin: [-1408, -128], cell: [2, 1] };
    const on = resolveSunShade({ sunShade: { texture, cast: 0.6875, sweepX: 1.5, sweepY: -0.25 } }, off);
    assert.equal(on, off, 'the caller\'s scratch object');
    assert.equal(on.texture, texture);
    assert.deepEqual(Array.from(on.rect), [-1408, -128, 2, 1]);
    assert.deepEqual(Array.from(on.steps), [0.6875, 0, 1.5, -0.25], 'the cast step, an unused slot, the sweep');
    assert.equal(resolveSunShade({ sunShade: { texture: { ...texture, data: null } } }).texture, null);
    // The texels' reader needs each texel's face by day.
    assert.equal(resolveOccluderChannel({ lighting: null, sunShade: null }), false);
    assert.equal(resolveOccluderChannel({ lighting: null, sunShade: { texture } }), true);
});

test('the record flag and the budget row', () => {
    assert.equal(GPU_RECORD_FLAGS.sunSelf, 4096);
    assert.equal(new Set(Object.values(GPU_RECORD_FLAGS)).size, Object.keys(GPU_RECORD_FLAGS).length);
    assert.equal(assignGpuRecordV9Fields({}, { sunSelf: true }, 1, 'normal').flags & 4096, 4096);
    assert.equal(assignGpuRecordV9Fields({}, {}, 1, 'normal').flags & 4096, 0);
    assert.deepEqual([0, 1, 2].map(level => effectBudgetMode('sundial-receivers', level)), ['on', 'on', 'off']);
    assert.equal(EFFECT_BUDGET['sundial-receivers'].canvas, 'ground-layer-only');
    assert.equal(EFFECT_BUDGET['sundial-receivers'].cost.bytes, 1408 * 1536 * 4);
    assert.equal(shadeSelfProp('prop.windmill'), true);
    assert.equal(shadeSelfProp('prop.lantern'), false);
});

const atmosphere = ({ rake = 0, sunBand = 1, angle = 0.28, elevation = 30 } = {}) => ({
    lightGrade: { rake, sunBand, daylight: 1, night: 0 },
    lighting: { shadowAngleRad: angle, shadowAlpha: 0.28, shadowLength: 1 },
    solar: { elevationDeg: elevation },
});

test('sd2 at 0 asks for nothing; above 0 it scales the cast step and follows the sun out', () => {
    try {
        setLookStrength('sd1', 1);
        setLookStrength('sd2', 0);
        setLookStrength('sd3', 0);
        assert.equal(castLightingFor(atmosphere()).shade.receivers, null, 'sd2 0');
        setLookStrength('sd2', 1);
        const noon = castLightingFor(atmosphere()).shade.receivers;
        assert.deepEqual(noon, { cast: 1 - Math.round(SHADE_RECEIVER_CAST * 64) / 64, lift: 0 }, 'one step: a face turned from the sun takes none');
        const low = castLightingFor(atmosphere({ rake: 1, elevation: 5 })).shade.receivers;
        assert.equal(low.cast, noon.cast, 'a raking sun is a weaker light: cast shade gains no weight');
        setLookStrength('sd2', 0.5);
        const half = castLightingFor(atmosphere()).shade.receivers;
        assert.ok(half.cast > noon.cast && half.cast < 1);
        setLookStrength('sd2', 1);
        const fading = castLightingFor(atmosphere({ sunBand: 0.5 })).shade.receivers;
        assert.ok(fading.cast > noon.cast && fading.cast < 1, 'half a sun, half a step');
        assert.equal(castLightingFor(atmosphere({ sunBand: 0.1 })).shade, null, 'overcast: no shade, no steps');
        assert.equal(castLightingFor(atmosphere({ rake: 1, elevation: -1 })).shade, null, 'a set sun: no shade, no step');
        setLookStrength('sd1', 0);
        assert.equal(castLightingFor(atmosphere()).shade, null, 'sd2 needs sd1');
    } finally {
        resetLookStrengths();
    }
});

test('without a built field the frame binds nothing and a villager keeps the slice-1 twin', () => {
    resetLookStrengths();
    setLookStrength('sd1', 1);
    setLookStrength('sd2', 1);
    const cast = castLightingFor(atmosphere());
    // No document here, so no field can be built: the look is asked for and absent.
    setFrameCastLighting(cast, { _lastAtmosphere: atmosphere() });
    assert.equal(frameSunShade(), null);
    const twin = villagerCastLighting(10, 20);
    assert.equal(twin.trail, cast.shade);
    assert.equal(twin.clip, undefined, 'no clip twin until the shader can clip it');
    setFrameCastLighting(null);
    resetLookStrengths();
});

test('a melting frost keys on the sundial only while that look is on', () => {
    const inputs = { assetVersion: 'v', configHash: 'c', season: 'winter', sceneryRevision: 0, snowBucket: 0, bounds: { x: 0, y: 0, w: 8, h: 8 }, dpr: 1, phenology: 'bare' };
    try {
        setLookStrength('sd1', 0);
        const before = [0, 1, 2, 3, 4].map(frost => terrainArtifactKey({ ...inputs, frost }));
        for (const frost of [0, 1, 2, 3, 4]) assert.equal(frostShadeKey(frost), '', 'sd1 0: today\'s keys');
        setLookStrength('sd1', 1);
        setLookStrength('sd1len', 0.5);
        assert.equal(frostShadeKey(0), '');
        assert.equal(frostShadeKey(4), '', 'the whole rime reads no shade');
        assert.equal(frostShadeKey(2), `s0.5m${SHADE_MASSING_REVISION}`);
        const during = [0, 1, 2, 3, 4].map(frost => terrainArtifactKey({ ...inputs, frost }));
        assert.equal(during[0], before[0]);
        assert.equal(during[4], before[4]);
        for (const frost of [1, 2, 3]) assert.notEqual(during[frost], before[frost]);
        setLookStrength('sd1len', 1);
        assert.notEqual(terrainArtifactKey({ ...inputs, frost: 2 }), during[2], 'the length cap moves the shade');
        // The bake's shade does not follow the resident ladder.
        assert.ok(sundialShadeFor(atmosphere()), 'the sundial\'s shade');
        setLookStrength('sd1', 0);
        assert.equal(sundialShadeFor(atmosphere()), null, 'sd1 0: no sundial shade');
        assert.deepEqual([0, 1, 2, 3, 4].map(frost => terrainArtifactKey({ ...inputs, frost })), before, 'sd1 0 again: today\'s keys');
    } finally {
        resetLookStrengths();
    }
});

test('a prop with a mass of its own passes the same fitting check as a landmark', () => {
    for (const type of Object.keys(PROP_MASSING)) {
        const report = massingReport(type);
        assert.equal(report.fitted, true);
        assert.equal(report.pass, true, `${type}: ${report.failures.join('; ')}`);
        assert.ok(report.numbers.spill <= 4, 'inside its sprite\'s canvas');
    }
});

// SD-3 — the sun lifts what it reaches: the lift's ladder, the twins'
// wiring, the ceiling under attention, and the Canvas tier.

test('sd3 at 0 lifts nothing; above 0 the lift follows the sun\'s height and the clear sky', () => {
    assert.equal(sunLiftFor(0, 1, 68, 0.1), 0, 'strength 0');
    assert.equal(sunLiftFor(1, 0, 68, 0.1), 0, 'no sun share (night, overcast)');
    assert.equal(sunLiftFor(1, 1, 68, 0.1), SUN_LIFT, 'a high clear sun: one whole step');
    const july = sunLiftFor(1, 1, 68, 0.1);
    const november = sunLiftFor(1, 1, 24, 0.1);
    const golden = sunLiftFor(1, 1, 9, 0.1);
    assert.ok(july > november && november > golden && golden > 0, `${july} > ${november} > ${golden}`);
    assert.ok(sunLiftFor(1, 1, 24, 0.42) < november, 'partly cloudy lifts less');
    assert.equal(sunLiftFor(1, 1, 24, 0.86), 0, 'overcast lifts nothing');
    assert.equal(sunLiftFor(1, 1, -2, 0.1), 0, 'a set sun lifts nothing');
    assert.equal(sunLiftFor(0.5, 1, 68, 0.1), SUN_LIFT / 2, 'the strength scales it');
    for (const value of [july, november, golden, sunLiftFor(0.5, 0.625, 31, 0.3)]) assert.equal(value * 64, Math.round(value * 64), 'in 1/64');
    try {
        setLookStrength('sd1', 1);
        setLookStrength('sd2', 0);
        setLookStrength('sd3', 0);
        assert.equal(castLightingFor(atmosphere()).shade.receivers, null, 'sd2 0 and sd3 0: no receivers, today\'s frame');
        setLookStrength('sd3', 1);
        const lifted = castLightingFor(atmosphere({ elevation: 50 })).shade.receivers;
        assert.deepEqual(lifted, { cast: 1, lift: SUN_LIFT }, 'the lift alone asks for the texels, and steps nothing');
        assert.equal(castLightingFor({ ...atmosphere({ elevation: 50 }), sky: { cloudCover: 0.86 } }).shade.receivers, null, 'a covered sky: no lift');
    } finally {
        resetLookStrengths();
    }
    // The bound lift: steps[1] (u_shade.y / frame.shade.y), 0 without a field.
    const texture = { width: 4, height: 2, format: 'rgba8', data: new Uint8Array(32), revision: 3, origin: [0, 0], cell: [2, 1] };
    assert.equal(resolveSunShade({ sunShade: { texture, cast: 1, lift: 0.0625, sweepX: 1, sweepY: 0 } }).steps[1], 0.0625);
    assert.equal(resolveSunShade({ sunShade: { texture: null, cast: 1, lift: 0.0625 } }).steps[1], 0);
});

test('both scene shaders lift after the step and before the grade, off at 0, never water', () => {
    const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
    for (const [source, step, call, grade] of [
        [read('gpu/GpuWorldRenderer.js'), 'color *= sunShadeStep(geometry',
            'if (u_shade.y > 0.0 && !waterMaterial) color = sunLift(color, u_terrainBatch && v_receiver.x < -0.5, u_shade.y,', 'color = applyTimeGrade('],
        [read('gpu/wgsl/scene.js'), 'color *= sunShadeStep(geometry',
            'if (frame.shade.y > 0.0 && !waterMaterial) { color = sunLift(color, batch.terrainBatch != 0u && v_receiver.x < -0.5, frame.shade.y,', 'color = applyTimeGrade('],
    ]) {
        const at = [step, call, grade].map(text => source.indexOf(text));
        assert.ok(at.every(index => index >= 0), 'every line is there');
        assert.deepEqual(at, at.slice().sort((a, b) => a - b), 'in this order');
        assert.equal(source.split('sunLift(color').length, 2, 'one call site');
    }
    for (const source of [SUN_SHADE_GLSL, SUN_SHADE_WGSL]) {
        // Ground by the ground rule; lit receivers including sunlit bodies (0.5x head-weighted).
        assert.ok(/sunlit = sunVerdict > -0\.5 && sunVerdict < 1\.5;/.test(source));
        assert.ok(source.includes('!ground && v_identity.x != 0u'), 'body lift branch');
        assert.ok(source.includes('1.12, 0.99, 0.76'), 'warm sunlit lift tint');
        assert.ok(source.includes('!shadeGroundAt(v_world)'));
        assert.ok(source.includes(SUN_LIFT_CEILING.toFixed(4)), 'the ceiling');
        assert.equal(source.split('sunVerdict = 0.0;').length, 3, 'two receiver branches');
    }
});

test('a lifted texel never outshines the waiting candle or the NEEDS YOU bell, and snow keeps its value', () => {
    // The scene shaders' warm sunLift + sunLiftGraded on the CPU.
    const luma = rgb => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const WARM = [1.12, 0.99, 0.76];
    const lift = (rgb, gain, ceil = SUN_LIFT_CEILING) => {
        const l = luma(rgb);
        if (l >= ceil || gain <= 0) return rgb.slice();
        const delta = rgb.map((channel, i) => channel * gain * WARM[i]);
        const rise = luma(delta);
        if (rise <= 0) return rgb.slice();
        const k = Math.min(1, (ceil - l) / rise);
        return rgb.map((channel, i) => channel + delta[i] * k);
    };
    // Exact CPU mirror of SunShade.js `sunLiftGraded`: keep only non-negative
    // channel lift and hold under the graded ceiling.
    const holdGraded = (lifted, base, cap = SUN_LIFT_GRADED_CEILING) => {
        const baseLuma = luma(base);
        if (baseLuma >= cap) return base;
        const delta = lifted.map((c, i) => Math.max(0, c - base[i]));
        const rise = luma(delta);
        if (rise <= 0) return base;
        const k = Math.min(1, (cap - baseLuma) / rise);
        return base.map((c, i) => c + delta[i] * k);
    };
    const CANDLE = 192; // CarriedLantern: a waiting candle lands 192-207, the bell 207
    let worstOpen = 0;
    let worstBody = 0;
    for (let minute = 6 * 60; minute <= 19 * 60; minute += 30) {
        const grade = evaluateGrade({ minuteOfDay: minute });
        for (let r = 0; r <= 20; r++) for (let g = 0; g <= 20; g++) for (let b = 0; b <= 20; b += 2) {
            const rgb = [r / 20, g / 20, b / 20];
            const base = applyGradeToRgb(rgb, grade);
            if (luma(rgb) < SUN_LIFT_CEILING) {
                const lifted = lift(rgb, SUN_LIFT, SUN_LIFT_CEILING);
                if (Math.max(...lifted) <= 1) {
                    const held = holdGraded(applyGradeToRgb(lifted, grade), base);
                    if (luma(held) > luma(base) + 1e-9) worstOpen = Math.max(worstOpen, luma(held) * 255);
                }
                // Sunlit bodies reach 0.6x lift at head height (0.5 * (0.4 + 0.8)).
                const liftedBody = lift(rgb, SUN_LIFT * 0.6, SUN_LIFT_CEILING);
                if (Math.max(...liftedBody) <= 1) {
                    const heldBody = holdGraded(applyGradeToRgb(liftedBody, grade), base);
                    if (luma(heldBody) > luma(base) + 1e-9) worstBody = Math.max(worstBody, luma(heldBody) * 255);
                }
            }
        }
    }
    assert.ok(worstOpen < CANDLE, `brightest open lifted texel ${worstOpen.toFixed(1)} under the candle's ${CANDLE}`);
    assert.ok(worstBody < CANDLE, `brightest lifted body texel (0.6x) ${worstBody.toFixed(1)} under the candle's ${CANDLE}`);
    // A texel already above the ceiling (snow, a lamp's glass) is not lifted at all.
    for (const snow of [[0.9, 0.93, 0.96], [0.7, 0.72, 0.7]]) assert.deepEqual(lift(snow, SUN_LIFT), snow);
    // And one under it never passes it.
    assert.ok(luma(lift([0.6, 0.62, 0.6], SUN_LIFT)) <= SUN_LIFT_CEILING + 1e-9);
});

test('Canvas takes the lift in whole steps on confirmed lit land, held under the ceiling per channel', () => {
    assert.equal(canvasSunLiftSteps(0), 0);
    assert.equal(canvasSunLiftSteps(SUN_LIFT * 0.4), 0, 'under half a step: none');
    assert.equal(canvasSunLiftSteps(SUN_LIFT * 0.5), 1);
    assert.equal(canvasSunLiftSteps(SUN_LIFT), 1);
    // Shaded, shaded, lit land, open water, and a lit cell the lattice does not reach.
    const field = { cols: 5, rows: 1, originX: 0, originY: 0, cellW: 2, cellH: 1, data: new Uint8Array([0, 255, 0, 255, 0, 0, 0, 0, 0, 0]) };
    const water = { fields: { x: 0, y: 0, cols: 4, rows: 1, coastField: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]) }, waterBit: 1, coveredBit: 2 };
    const out = new Uint8Array(20);
    paintLitCells(field, out, [35, 35, 35], water);
    assert.deepEqual([3, 7, 11, 15, 19].map(i => out[i]), [0, 0, 255, 0, 0], 'shade, shade, lit land, open water, unclassified');
    assert.equal(out[8], 35);
    paintLitCells(field, out, [35, 35, 35], null);
    assert.ok([3, 7, 11, 15, 19].every(i => out[i] === 0), 'no coast lattice: nothing is lit');
    // The composite chain (dodge, darken to the ceiling, lighten the unlifted
    // frame): each channel rises at most one step, never past the ceiling
    // unless it already stood there, so snow keeps its value.
    for (const snow of [[230, 237, 245], [176, 180, 190]]) assert.deepEqual(canvasSunLiftRgb(snow), snow);
    const lum30 = rgb => 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];
    const lifted = canvasSunLiftRgb([90, 120, 60]);
    assert.ok(lifted.every((v, i) => v > [90, 120, 60][i]), 'every channel rises');
    assert.ok(Math.abs(lum30(lifted) / lum30([90, 120, 60]) - (1 + SUN_LIFT)) < 0.01, 'one step of luminosity');
    assert.ok(Math.abs(lum30(canvasSunLiftRgb([120, 130, 110])) - Math.round(255 * SUN_LIFT_CEILING * 0.78)) < 0.01, 'held at the ceiling');
    const luma = rgb => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let worst = 0;
    for (let minute = 6 * 60; minute <= 19 * 60; minute += 30) {
        const grade = evaluateGrade({ minuteOfDay: minute });
        for (let r = 0; r <= 255; r += 15) for (let g = 0; g <= 255; g += 15) for (let b = 0; b <= 255; b += 30) {
            const before = luma(applyGradeToRgb([r / 255, g / 255, b / 255], grade)) * 255;
            const after = luma(applyGradeToRgb(canvasSunLiftRgb([r, g, b]).map(v => v / 255), grade)) * 255;
            if (after > before + 1e-9) worst = Math.max(worst, after);
        }
    }
    assert.ok(worst < 192, `brightest lifted Canvas pixel ${worst.toFixed(1)} under the candle's 192`);
});

test('the sun\'s lift alone never clips a villager\'s sun trail (that is SD-2\'s)', () => {
    try {
        setLookStrength('sd1', 1);
        setLookStrength('sd2', 0);
        setLookStrength('sd3', 1);
        const cast = castLightingFor(atmosphere({ elevation: 50 }));
        assert.ok(cast.shade.receivers.lift > 0, 'the lift asks for the texels');
        setFrameCastLighting(cast, { _lastAtmosphere: atmosphere({ elevation: 50 }) });
        assert.equal(villagerCastLighting(10, 20)?.clip, undefined);
    } finally {
        setFrameCastLighting(null);
        resetLookStrengths();
    }
});

test('the lit mask is the sea fret\'s land: an unclassified cell off the map grid is sea', () => {
    // One lattice row at world y 1: cell 0 sits on the map's north vertex
    // (land), cell 1 far west of the diamond (off the grid, no flags).
    const field = { cols: 2, rows: 1, originX: 0, originY: 0, cellW: 2, cellH: 1, data: new Uint8Array(4) };
    const offshore = { cols: 2, rows: 1, originX: -4000, originY: 0, cellW: 2, cellH: 1, data: new Uint8Array(4) };
    const lattice = x => ({ fields: { x, y: 0, cols: 2, rows: 1, coastField: new Uint8Array(4) }, waterBit: 1, coveredBit: 2 });
    const out = new Uint8Array(8);
    paintLitCells(field, out, [1, 1, 1], lattice(0));
    assert.equal(out[3], 255, 'on the grid, no water flag: land');
    paintLitCells(offshore, out, [1, 1, 1], lattice(-4000));
    assert.deepEqual([out[3], out[7]], [0, 0], 'off the grid: unclassified shelf, not land');
    const covered = lattice(-4000);
    covered.fields.coastField[1] = 2 | 1;
    paintLitCells(offshore, out, [1, 1, 1], covered);
    assert.equal(out[3], 255, 'a covered cell (a dock) is land wherever it lies');
});

test('both scene shaders hold a lifted texel after the grade, and a bright one keeps its unlifted value', () => {
    const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
    for (const [source, grade, hold] of [
        [read('gpu/GpuWorldRenderer.js'), 'color = applyTimeGrade(color, !u_additive);', 'if (sunLifted) color = sunLiftGraded(color, applyTimeGrade(sunBase, true));'],
        [read('gpu/wgsl/scene.js'), 'color = applyTimeGrade(color, batch.additive == 0u);', 'if (sunLifted) { color = sunLiftGraded(color, applyTimeGrade(sunBase, true)); }'],
    ]) {
        const at = source.indexOf(grade);
        assert.ok(at > 0 && source.indexOf(hold) > at && source.indexOf(hold) - at < 200, 'right after the grade');
    }
    for (const source of [SUN_SHADE_GLSL, SUN_SHADE_WGSL]) {
        assert.ok(source.includes(`if (baseLuma >= ${SUN_LIFT_GRADED_CEILING.toFixed(4)})`), 'graded ceiling wired and bright keeps unlifted value');
        assert.ok(source.includes(`luma <= ${SUN_LIFT_CANDLE.toFixed(4)}`), 'final candle hold wired');
    }
    assert.ok(SUN_LIFT_GRADED_CEILING <= SUN_LIFT_CANDLE && SUN_LIFT_GRADED_CEILING * 255 < 192,
        'graded ceiling stays under the waiting candle (192) and NEEDS YOU bell (207)');
});
