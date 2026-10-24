import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAP_SIZE, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { openSeaSquall, RAIN_START_PRECIPITATION, SHOWER_STRENGTH, SQUALL_HALF_WIDTH } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    SWELL_DRIFT_STEP_MS,
    SWELL_DRIFT_WRAP_ROWS,
    createWaterFx,
    resolveWaterFx,
    swellDriftRows,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';

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

// E2-05 — the swash at the cliff's foot breaks over the cliff's mirror too,
// in all three swash copies.
test('the cliff-foot swash flag reaches the GLSL, WGSL and Canvas swash', () => {
    assert.match(read('gpu/GpuWorldRenderer.js'), /if \(\(flags & 32u\) == 0u && waterStopIndex\(color\) < 0/);
    assert.match(read('gpu/wgsl/water.js'), /if \(\(flags & \$\{COAST_FIELD_FLAGS\.cliffSurf\}u\) == 0u && waterStopIndex\(color\) < 0/);
    assert.match(read('CanvasWaterState.js'), /swashCode\(k, sd, cyc, x, y, \(flags & COAST_FIELD_FLAGS\.cliffSurf\) !== 0\)/);
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
