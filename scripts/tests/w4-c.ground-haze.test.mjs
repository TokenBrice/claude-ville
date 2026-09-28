import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    PRESSURE_LEVELS,
    PRESSURE_PROTECTED,
    PRESSURE_SHED_ORDER,
} from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { weatherEmbellishmentAllowed } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import {
    HAZE_ALPHA_CAP,
    HAZE_COURSE_ALPHA,
    WETNESS_ATTACK_MS,
    WETNESS_RELEASE_MS,
    advanceSurfaceWetness,
    applySurfaceWetnessToReactions,
    bakeHazeField,
    collectDampMarks,
    collectHazeAnchors,
    collectRoadCarvePoints,
    dampMarkAlpha,
    dampMaterialMultiplier,
    groundHazeStrength,
    hazeOccupancyAtWorld,
    hazePlanForPressure,
    isoFromTile,
} from '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js';

const CHARACTER_MODE = '../../claudeville/src/presentation/character-mode/';

function readSource(file) {
    return readFileSync(new URL(CHARACTER_MODE + file, import.meta.url), 'utf8');
}

function waterAnchors(keys = ['2,2']) {
    return collectHazeAnchors({
        waterTiles: keys,
        lowlandPoints: [{ x: 40, y: 220 }],
    }).anchors;
}

test('haze occupancy follows water and lowland world inputs', () => {
    const anchors = waterAnchors(['2,2']);
    const water = isoFromTile(2, 2);
    const occupancyAtWater = hazeOccupancyAtWorld(water.x, water.y, { anchors });
    const occupancyFar = hazeOccupancyAtWorld(water.x + 800, water.y + 800, { anchors });
    assert.ok(occupancyAtWater > 0.8, 'water tile must seed the field');
    assert.ok(occupancyFar < 0.08, 'far land stays clear of water haze');
    assert.ok(hazeOccupancyAtWorld(40, 220, { anchors }) > 0.5, 'lowland anchors must also seed the field');
    const roadCarved = hazeOccupancyAtWorld(water.x, water.y, { anchors, roads: [{ x: water.x, y: water.y }] });
    assert.ok(roadCarved < occupancyAtWater * 0.25, 'a road opens the haze');
    const roads = collectRoadCarvePoints({ pathTiles: ['8,8', '9,8', '10,8', '11,8'], stride: 1 });
    assert.ok(roads.some(point => point.key === '8,8'));
});

test('the baked ground haze is stepped courses under the cap, never a gradient', () => {
    const anchors = waterAnchors(['2,2', '3,2', '2,3']);
    const bounds = { x: -400, y: -100, w: 800, h: 400 };
    const field = bakeHazeField({ anchors, bounds });
    const allowed = new Set([0, ...HAZE_COURSE_ALPHA.map(share => Math.round(share * HAZE_ALPHA_CAP * 255))]);
    const seen = new Set();
    for (let i = 3; i < field.data.length; i += 4) seen.add(field.data[i]);
    for (const alpha of seen) assert.ok(allowed.has(alpha), `alpha ${alpha} is not a course`);
    assert.ok(seen.size >= 3, 'the field shows more than one course');
    assert.ok(Math.max(...seen) <= Math.ceil(HAZE_ALPHA_CAP * 255));
    // World-locked: the same inputs bake the same field; there is no camera.
    assert.deepEqual(bakeHazeField({ anchors, bounds }).data, field.data);
    // It fades to nothing inside its own margin.
    const edgeRow = field.data.subarray(0, field.width * 4);
    assert.ok(edgeRow.every((value, index) => index % 4 !== 3 || value === 0));
});

test('ground haze lies at dawn and in fog only, in stepped strengths', () => {
    const steps = new Set();
    for (let p = 0; p <= 1; p += 0.01) {
        const strength = groundHazeStrength({ phase: 'dawn', phaseProgress: p, weather: { type: 'clear', fog: 0 } });
        steps.add(strength);
        assert.equal(strength * 8, Math.round(strength * 8));
    }
    assert.ok(steps.size > 2 && steps.size <= 9);
    assert.ok(groundHazeStrength({ phase: 'day', weather: { type: 'fog', fog: 0.8 } }) > 0.9);
    assert.equal(groundHazeStrength({ phase: 'day', weather: { type: 'rain', fog: 0.14, precipitation: 0.9 } }), 0);
    assert.equal(groundHazeStrength({ phase: 'day', weather: { type: 'overcast', fog: 0.08 } }), 0);
});

test('surface wetness rises under precipitation and decays deterministically to zero', () => {
    let wetness = 0;
    wetness = advanceSurfaceWetness(wetness, {
        precipitation: 1,
        dt: WETNESS_ATTACK_MS,
        weatherType: 'rain',
    });
    assert.ok(wetness >= 0.99);

    wetness = advanceSurfaceWetness(wetness, {
        precipitation: 0,
        dt: WETNESS_RELEASE_MS,
        weatherType: 'clear',
    });
    assert.ok(wetness <= 1e-9);

    wetness = advanceSurfaceWetness(0.4, {
        precipitation: 0,
        dt: WETNESS_RELEASE_MS,
        weatherType: 'clear',
    });
    assert.equal(wetness, 0);

    const reactions = applySurfaceWetnessToReactions({ puddleAlpha: 0, roofGlintAlpha: 0 }, 0.8);
    assert.equal(reactions.surfaceWetness, 0.8);
    assert.ok(reactions.puddleAlpha > 0);
    assert.ok(reactions.roofGlintAlpha > 0);
});

test('fire and emissive materials receive exactly zero wetness response', () => {
    assert.equal(dampMaterialMultiplier('fire'), 0);
    assert.equal(dampMaterialMultiplier('emissive'), 0);
    assert.equal(dampMarkAlpha(1, 'fire', 1), 0);
    assert.equal(dampMarkAlpha(1, 'emissive', 1), 0);
    const marks = collectDampMarks({
        roofs: [{ x: 4, y: 8, seed: 1 }],
        wetness: 1,
        layer: 'all',
    });
    assert.ok(marks.every((mark) => mark.material !== 'fire' && mark.material !== 'emissive'));
    assert.ok(dampMaterialMultiplier('roof') > 0);
    assert.ok(dampMaterialMultiplier('dock') > 0);
    assert.ok(dampMaterialMultiplier('stone') > 0);
    assert.ok(dampMaterialMultiplier('road') > 0);
});

test('pressure rung 1 sheds haze density before any semantic element', () => {
    assert.equal(PRESSURE_SHED_ORDER[0], 'ambient-weather-embellishment');
    assert.ok(!PRESSURE_PROTECTED.includes('ambient-weather-embellishment'));
    assert.equal(weatherEmbellishmentAllowed(PRESSURE_LEVELS.WEATHER_FAUNA), false);
    const full = hazePlanForPressure(PRESSURE_LEVELS.FULL, 1);
    const shed = hazePlanForPressure(PRESSURE_LEVELS.WEATHER_FAUNA, 1);
    assert.ok(shed.density < full.density);
    assert.ok(groundHazeStrength({ phase: 'day', weather: { type: 'fog', fog: 0.8 } }, shed.density)
        < groundHazeStrength({ phase: 'day', weather: { type: 'fog', fog: 0.8 } }, full.density));
});

test('no blur filter is introduced and haze draws in the ground stage, not the sky canopy', () => {
    for (const name of ['WorldFrameRenderer.js', 'SkyRenderer.js', 'WeatherRenderer.js', 'IsometricRenderer.js']) {
        const source = readSource(name);
        assert.doesNotMatch(source, /ctx\.filter/, name);
        assert.doesNotMatch(source, /filter\s*[:=]\s*['"`]?blur/i, name);
    }
    const worldSource = readSource('WorldFrameRenderer.js');
    const renderFn = worldSource.slice(
        worldSource.indexOf('export function renderWorldFrame'),
        worldSource.indexOf('function drawPrimaryMarksPostAtmosphere'),
    );
    assert.ok(renderFn.indexOf('drawGroundHaze') > 0);
    assert.ok(renderFn.indexOf('drawGroundHaze') < renderFn.indexOf('_drawSkyCanopy'));
});
