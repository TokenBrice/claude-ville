import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAP_SIZE, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { openSeaSquall, RAIN_START_PRECIPITATION, SHOWER_STRENGTH, SQUALL_HALF_WIDTH } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    SURF_GLOW_MONTHS,
    SWELL_DRIFT_STEP_MS,
    SWELL_DRIFT_WRAP_ROWS,
    createWaterFx,
    resolveSurfGlow,
    resolveWaterFx,
    surfGlowBloomNight,
    swellDriftRows,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { SWASH_PEEL_ROWS, SWASH_STEP_RATE } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
const RAIN = { type: 'rain', nextType: 'rain', transitionProgress: 1, precipitation: 0.9, windX: -0.4, intensity: 0.82, cloudCover: 0.92 };

// E2-04 — showers cross the sea while it rains: the squall's patch stays on
// the sea once the rain falls, weaker, carried by the cloud courses' drift.
test('a shower crosses the sea only while it rains, weaker than the squall', () => {
    assert.equal(openSeaSquall({ type: 'clear', nextType: 'clear', precipitation: 0 }, 1000), null);
    assert.equal(openSeaSquall({ ...RAIN, precipitation: RAIN_START_PRECIPITATION / 2 }, 2000), null);
    const shower = openSeaSquall(RAIN, 3000);
    assert.ok(shower, 'raining: a shower on the sea');
    assert.equal(shower.halfWidth, SQUALL_HALF_WIDTH);
    assert.equal(shower.strength, SHOWER_STRENGTH);
    const light = openSeaSquall({ ...RAIN, precipitation: 0.1 }, 3000);
    assert.ok(light.strength < shower.strength && light.strength > 0, 'light rain lays a thinner shower');
    assert.equal(Number.isInteger(shower.x), true, 'the patch steps whole world px');
});

test('the shower drifts downwind on the motion clock, wraps far off the island, and holds when the clock stops', () => {
    const reach = MAP_SIZE * TILE_WIDTH / 2 + SQUALL_HALF_WIDTH + 1400;
    let t = 10000;
    let last = openSeaSquall(RAIN, t);
    let wraps = 0;
    let moved = 0;
    for (let i = 0; i < 2400; i++) {
        t += 1000;
        const next = openSeaSquall(RAIN, t);
        assert.ok(Math.abs(next.x) <= reach, `x ${next.x} past the loop`);
        const dx = next.x - last.x;
        if (Math.abs(dx) > reach) {
            wraps++;
            // Wrapping happens only where the whole patch is off the island.
            assert.ok(Math.abs(last.x) > MAP_SIZE * TILE_WIDTH / 2 + SQUALL_HALF_WIDTH, `wrapped at ${last.x}`);
        } else {
            assert.ok(dx <= 0, 'a west wind carries it west');
            moved += -dx;
        }
        last = next;
    }
    assert.ok(moved > 1000 && wraps >= 1, `moved ${moved}, wraps ${wraps}`);
    const held = openSeaSquall(RAIN, t);
    assert.equal(openSeaSquall(RAIN, t).x, held.x, 'a stopped motion clock holds the shower');
});

// RG-5 — the shower's pass crosses the island row, so the in-map open water
// takes the squall's courses too (GLSL and WGSL, one helper with the open
// sea), and the WebGL scene program receives the squall uniforms.
test('the squall and shower reach the in-map open water on both GPU backends', () => {
    const glsl = read('gpu/GpuWorldRenderer.js');
    const water = read('gpu/wgsl/water.js');
    const scene = read('gpu/wgsl/scene.js');
    const atmosphere = read('gpu/wgsl/atmosphere.js');
    const openSea = read('gpu/wgsl/openSea.js');
    // One rule on the open sea and on open water.
    assert.match(glsl, /shade = max\(shade, squallShade\(cell, n, order\)\);/);
    assert.match(openSea, /shade = max\(shade, squallShade\(cell, n, order\)\);/);
    assert.match(glsl, /float edge = length\(d\) \+ \(n - 0\.5\) \* 0\.5 \+ \(order - 0\.5\) \* 3\.0 \/ u_squall\.z;/);
    assert.match(water, /let edge = length\(d\) \+ \(n - 0\.5\) \* 0\.5 \+ \(order - 0\.5\) \* 3\.0 \/ frame\.squall\.z;/);
    // Open terrain water (as deep as the open sea on its row) is flagged ...
    assert.match(glsl, /seaOpenWater = u_terrainBatch && u_squall\.w > 0\.0 && stop >= 2\s+&& float\(stop\) >= openSeaStop\(openSeaDepth\(p\), waterBayer4\(p\)\);/);
    assert.match(water, /seaOpenWater = batch\.terrainBatch != 0u && frame\.squall\.w > 0\.0 && stop >= 2\s+&& f32\(stop\) >= openSeaStop\(openSeaDepth\(p\), waterBayer4\(p\)\);/);
    // ... and takes the darker of the cloud and squall courses, resting and fat.
    assert.match(glsl, /color \*= vec3\(1\.0\) - max\(cloud, squall \* 0\.085\) \* vec3\(1\.0, 0\.96, 0\.84\);/);
    assert.match(atmosphere, /color0 \* \(vec3f\(1\.0\) - max\(cloud, squall \* 0\.085\) \* vec3f\(1\.0, 0\.96, 0\.84\)\)/);
    assert.match(glsl, /: applySeaCourses\(color, artCell, poolOrder,/);
    assert.match(scene, /color = applySeaCourses\(color, artCell, poolOrder,/);
    assert.match(glsl, /sum \+= applySeaCourses\(color, cell, bayer4\(cell\), rowPx, u_additive\) \* w;/);
    assert.match(atmosphere, /sum \+= applySeaCourses\(color, cell, bayer4\(cell\), rowPx, batch\.additive != 0u\) \* w;/);
    // WebGL: resolved once a frame, uploaded to both passes.
    assert.match(glsl, /const SEA_WEATHER_UNIFORM_NAMES = \['u_seaSunlit', 'u_seaGust', 'u_seaGustRect', 'u_squall', 'u_squallFall'\];/);
    assert.match(glsl, /frame\.squall = effectBudgetMode\('sea-weather', qualityLevel\) === 'on'/);
    // The pass the in-map rule exists for: the shower crosses the island row.
    const reach = MAP_SIZE * TILE_WIDTH / 2;
    let inside = 0;
    for (let t = 0; t < 4_000_000; t += 5000) {
        const shower = openSeaSquall(RAIN, t);
        if (Math.abs(shower.x) < reach) inside++;
    }
    assert.ok(inside > 0, 'the shower passes over the map, not only the open sea');
});

// E2-05 — the swash at the cliff's foot breaks over the cliff's mirror too,
// in all three swash copies.
test('the cliff-foot swash flag reaches the GLSL, WGSL and Canvas swash', () => {
    assert.match(read('gpu/GpuWorldRenderer.js'), /if \(\(flags & 32u\) == 0u && waterStopIndex\(color\) < 0/);
    assert.match(read('gpu/wgsl/water.js'), /if \(\(flags & \$\{COAST_FIELD_FLAGS\.cliffSurf\}u\) == 0u && waterStopIndex\(color\) < 0/);
    assert.match(read('CanvasWaterState.js'), /const cliff = \(flags & COAST_FIELD_FLAGS\.cliffSurf\) !== 0;/);
    assert.match(read('CanvasWaterState.js'), /swashCode\(k, sd, posMod\(step \+ band, SWASH_WAVE\), x, y, cliff, lagoon\)/);
    assert.match(read('CoastBake.js'), /cliffSurf: 32,/);
});

// E2-03 — rolling swell sets: one world row every SWELL_DRIFT_STEP_MS of the
// motion clock (a pure function of it, so a frozen clock holds the sea), the
// same drift added to every copy of swellPhase.
test('the swell drift steps one row per step of the motion clock, in every swellPhase', () => {
    assert.ok(SWELL_DRIFT_STEP_MS >= 2000 && SWELL_DRIFT_STEP_MS <= 3000, 'about one row every 2-3 s');
    assert.equal(swellDriftRows(0), 0);
    assert.equal(swellDriftRows(undefined), 0);
    assert.equal(swellDriftRows(SWELL_DRIFT_STEP_MS - 1), 0);
    assert.equal(swellDriftRows(SWELL_DRIFT_STEP_MS), 1);
    assert.equal(swellDriftRows(SWELL_DRIFT_STEP_MS * 41.5), 41);
    assert.equal(SWELL_DRIFT_WRAP_ROWS % 150, 0, 'wraps on whole set periods');
    assert.equal(swellDriftRows(SWELL_DRIFT_STEP_MS * (SWELL_DRIFT_WRAP_ROWS + 3)), 3);
    const fx = resolveWaterFx({ timeMs: SWELL_DRIFT_STEP_MS * 7, motionScale: 1, weather: { type: 'clear' } }, { zoom: 1 }, 0, { sunBand: 0, night: 0 }, 0, 1920, createWaterFx());
    assert.equal(fx.swellDrift, 7);
    assert.match(read('gpu/GpuWorldRenderer.js'), /return \(dot\(p, vec2\(\$\{SWELL_SET_NORMAL\[0\]\.toFixed\(2\)\}, 1\.0\)\) \+ u_swellDrift\) \//);
    assert.match(read('gpu/wgsl/water.js'), /return \(dot\(p, vec2f\(\$\{SWELL_SET_NORMAL\[0\]\.toFixed\(2\)\}, 1\.0\)\) \+ frame\.swellDrift\) \//);
    assert.match(read('CanvasWaterState.js'), /return \(x \* normal \+ y \+ drift\) \/ SWELL_SET_PERIOD/);
    assert.match(read('CanvasWaterState.js'), /swellDrift: swellDriftRows\(renderer\.motionTimeMs\)/);
});

// BI-3 — the surf peels along the shore: one 12-step wave (in 4, out 3, rest
// 5) whose step adds the texel's band of SWASH_PEEL_ROWS world rows, so the
// band below meets each wave one step first (the front runs north from the
// south point), every fourth wave of a set reaching one lattice step further
// at its peak; QW-4 — lagoon banks (coast flag 128, caps 3) lap at half
// reach. The same rule in all three swash copies.
test('the surf peels along the shore and lagoon banks lap at half reach, in all three swash copies', () => {
    assert.equal(1e6 * SWASH_STEP_RATE % 48, 0, 'the 1000 s shader-clock wrap holds whole 48-step sets');
    assert.ok(12 / SWASH_STEP_RATE >= 1000, 'a wave lasts more than a second (slow band)');
    assert.ok(SWASH_STEP_RATE * 1000 <= 12, 'its steps stay at 12 Hz or slower');
    const glsl = read('gpu/GpuWorldRenderer.js');
    const wgsl = read('gpu/wgsl/water.js');
    const canvas = read('CanvasWaterState.js');
    assert.match(glsl, /float swashStep = floor\(u_time \* \$\{SWASH_STEP_RATE\} \* u_waterFx\.x\) \+ floor\(px\.y \/ \$\{SWASH_PEEL_ROWS\.toFixed\(1\)\}\);/);
    assert.match(wgsl, /let swashStep = floor\(frame\.timeMs \* \$\{SWASH_STEP_RATE\} \* frame\.waterFx\.x\) \+ floor\(px\.y \/ \$\{SWASH_PEEL_ROWS\.toFixed\(1\)\}\);/);
    assert.match(canvas, /swashStep: Math\.floor\(t \* SWASH_STEP_RATE \* clock\)/);
    assert.match(canvas, /const band = Math\.floor\(y \/ SWASH_PEEL_ROWS\);/);
    assert.match(glsl, /\} else if \(mod\(floor\(swashStep \/ 12\.0\), 4\.0\) < 0\.5 && reach > 2\.5\) \{\n\s+reach \+= 1\.0;/);
    assert.match(wgsl, /\} else if \(glslMod\(floor\(swashStep \/ 12\.0\), 4\.0\) < 0\.5 && reach > 2\.5\) \{\n\s+reach \+= 1\.0;/);
    assert.match(canvas, /swashBig\[posMod\(3 - band, SWASH_SET\)\]\.push\(i, peak\)/);
    for (const source of [glsl, wgsl, canvas]) assert.match(source, /reach \*= 0\.5;\n\s+extent \*= 0\.5;/);
    assert.match(read('CoastBake.js'), /lagoon: 128,/);
    assert.match(read('CoastBake.js'), /if \(inMap && field\.caps\[tile\] === 3\) flags \|= COAST_FIELD_FLAGS\.lagoon;/);
});

// BI-8 (D6) — the summer surf glow is rare and clock-and-weather only: calm,
// moonless July-to-September nights of a seeded bloom, never by day, in rain
// or under a bright moon, nothing with the swash off or at look strength 0.
test('the summer surf glow fires on a few calm, moonless summer nights a year and nowhere else', () => {
    const glowAt = (date, patch = {}) => {
        const snap = createAtmosphereSnapshot({ now: date });
        const weather = patch.weather || snap.weather;
        return resolveSurfGlow(snap, weather, snap.lightGrade, patch.moonFill ?? snap.lighting.moonFill, patch.swash ?? true);
    };
    for (const year of [2026, 2027, 2028]) {
        const nights = [];
        for (let day = 0; day < 365; day++) {
            const evening = new Date(year, 0, 1 + day, 23, 30);
            const late = new Date(year, 0, 2 + day, 1, 0);
            if (Math.max(glowAt(evening), glowAt(late)) > 0) nights.push(evening);
            assert.equal(glowAt(new Date(year, 0, 1 + day, 13, 0)), 0, 'never by day');
        }
        assert.ok(nights.length >= 1 && nights.length <= 15, `${year}: ${nights.length} glow nights`);
        for (const night of nights) assert.ok(SURF_GLOW_MONTHS.includes(night.getMonth()), `${night.toDateString()} is a summer night`);
    }
    const night = new Date(2026, 6, 13, 1, 0);
    assert.ok(glowAt(night) > 0.9, 'a calm new-moon bloom night glows');
    assert.equal(surfGlowBloomNight(new Date(2026, 6, 12, 22, 0)), true, 'the night keeps its evening\'s bloom past midnight');
    assert.equal(glowAt(new Date(2026, 6, 12, 23, 30)), 0, 'the same night\'s partly cloudy breeze keeps it dark');
    assert.equal(glowAt(night, { swash: false }), 0, 'no swash, no glow (reduced motion, MINIMAL)');
    assert.equal(glowAt(night, { moonFill: 0.6 }), 0, 'a bright moon puts it out');
    assert.equal(glowAt(night, { weather: { type: 'clear', windX: 0.55 } }), 0, 'a breeze breaks it');
    assert.equal(glowAt(night, { weather: { type: 'rain', windX: 0.2, precipitation: 0.5 } }), 0, 'never in rain');
    try {
        setLookStrength('bi8', 0);
        assert.equal(glowAt(night), 0, 'look strength 0 is today\'s frame');
        setLookStrength('bi8', 0.5);
        const half = glowAt(night);
        resetLookStrengths();
        assert.ok(Math.abs(half - 0.5 * glowAt(night)) < 1e-9, 'half strength, half the glow');
    } finally {
        resetLookStrengths();
    }
});
