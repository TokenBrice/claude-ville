import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import {
    CLOUD_PLANE,
    CLOUD_SECOND_OCTAVE,
    CLOUD_TILE_SIZE,
    SEA_STATE,
    buildCloudShadowTile,
    cloudFieldAt,
    cloudNoiseIntAt,
    CLOUD_INT_CONSTANTS,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { createSeaState, resolveSeaState } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { COAST_WATER_STOPS, detectPilingTips, getCoastField, staticMirrorRgb } from '../../claudeville/src/presentation/character-mode/CoastBake.js';

const ASSET_ROOT = new URL('../../claudeville/assets/sprites/', import.meta.url);

// C-03 / PERF-01 — integer bilinear cloud noise must match the JS float
// reference `cloudFieldAt` across positive and negative coordinates, with
// `CLOUD_PLANE` both off and on, and must derive its constants from
// `CLOUD_PLANE` and `CLOUD_SECOND_OCTAVE` (not hardcoded [1, 2] or 0.72).
test('C-03: integer bilinear cloudNoiseIntAt matches cloudFieldAt with plane off and on', () => {
    const tile = buildCloudShadowTile(CLOUD_TILE_SIZE);
    // Constants derived from CLOUD_PLANE and CLOUD_SECOND_OCTAVE.
    assert.equal(CLOUD_INT_CONSTANTS.planeScale100[0], Math.round(CLOUD_PLANE[0] * CLOUD_INT_CONSTANTS.u16PerPx * 100));
    assert.equal(CLOUD_INT_CONSTANTS.planeScale100[1], Math.round(CLOUD_PLANE[1] * CLOUD_INT_CONSTANTS.u16PerPx * 100));
    assert.equal(CLOUD_INT_CONSTANTS.oct2WeightMilli, Math.round(CLOUD_SECOND_OCTAVE.weight * 1000));

    const drifts = [
        [0, 0],
        [137.5, 42.25],
        [3511.75, 6820.5],
        [7160.125, 19.875],
    ];
    const coords = [-4200, -1793, -513, -17, -1, 0, 1, 37, 512, 1791, 4880, 11200];

    for (const planeOn of [false, true]) {
        const sx = planeOn ? CLOUD_PLANE[0] : 1;
        const sy = planeOn ? CLOUD_PLANE[1] : 1;
        let maxDiff = 0;
        let samples = 0;
        for (const [dx, dy] of drifts) {
            for (const icy of coords) {
                for (const icx of coords) {
                    const ref = cloudFieldAt(tile, (icx + 0.5) * sx + dx, (icy + 0.5) * sy + dy, CLOUD_TILE_SIZE);
                    const got = cloudNoiseIntAt(tile, icx, icy, dx, dy, planeOn) / 16711680;
                    const diff = Math.abs(got - ref);
                    if (diff > maxDiff) maxDiff = diff;
                    samples++;
                }
            }
        }
        assert.ok(samples > 500);
        // 1/256 texel quantization + rounding of plane coordinates stays well under 0.005.
        assert.ok(maxDiff < 0.005, `planeOn=${planeOn}: maxDiff=${maxDiff} exceeded 0.005`);
    }
});

// C-03 / PERF-02 — single whitecap streak counter in GpuFrameState: wraps at
// SEA_STATE.streakWrap (98304, never 96), uses baseWindX(weather), and
// reproduces identical shift across fresh and warmed renderers when replaying
// a latched feed.
test('C-03: resolveSeaState wraps at SEA_STATE.streakWrap, reads baseWindX, and matches on frozen replay', () => {
    try {
        setLookStrength('sea3', 1);
        const state = createSeaState();
        // Weather omits explicit windX -> baseWindX uses WIND_SPEED_BY_TYPE.rain (+0.9 -> fresh, eastward).
        const weather = { type: 'rain' };
        let t = 0;
        resolveSeaState({ timeMs: t, atmosphere: { weather } }, POST_FX_LEVELS.FULL, 0, state);
        // Advance > 100 steps (past the buggy 96 wrap) in valid 8-step hops.
        for (let step = 0; step < 30; step++) {
            t += 2000; // 12 ticks = 6 streak steps per call
            resolveSeaState({ timeMs: t, atmosphere: { weather } }, POST_FX_LEVELS.FULL, 0, state);
        }
        assert.equal(state.uniform[1], 2, 'rain without windX is fresh sea');
        assert.equal(state.uniform[2], 180, 'accumulates past 96 without premature wrap');
        assert.ok(state.uniform[2] < SEA_STATE.streakWrap);

        // Frozen replay: latching the resolved shift onto the feed makes a fresh
        // renderer and the warmed app renderer emit the exact same uniform[2].
        const frozenFeed = { timeMs: t, atmosphere: { weather }, seaStreakShift: state.shift };
        const fresh = createSeaState();
        resolveSeaState(frozenFeed, POST_FX_LEVELS.FULL, 0, fresh);
        resolveSeaState(frozenFeed, POST_FX_LEVELS.FULL, 0, state);
        assert.equal(fresh.uniform[2], state.uniform[2]);
        assert.equal(fresh.uniform[2], 180);
    } finally {
        resetLookStrengths();
    }
});

// C-03 — staticMirrorRgb shifts warm building tones toward local water hue
// instead of creating muddy brown smears, and detectPilingTips finds the 14
// Harbor water pilings without false positives on the landmark bridges.
test('C-03: staticMirrorRgb retains cool water hue and detectPilingTips finds Harbor pilings cleanly', () => {
    const shallow = COAST_WATER_STOPS[1];
    const warmTimber = [176, 118, 64];
    const mirrored = staticMirrorRgb(shallow, warmTimber, 0.68, false);
    // Cool shallow water has B > R; water-tinted mirror must stay cool (B >= R - 6), not brown.
    assert.ok(mirrored[2] >= mirrored[0] - 6, `expected cool water-tinted mirror, got rgb(${mirrored.join(',')})`);
    // Lit reflections preserve warm lamp colour.
    const lit = staticMirrorRgb(shallow, [255, 192, 96], 0.68, true);
    assert.ok(lit[0] > lit[2] + 30, `expected warm lit reflection, got rgb(${lit.join(',')})`);

    const loadPng = (rel) => {
        const png = PNG.sync.read(readFileSync(new URL(rel, ASSET_ROOT)));
        return { w: png.width, h: png.height, data: png.data };
    };
    const harborTips = detectPilingTips(loadPng('buildings/building.harbor/base.png'));
    // 14 water-standing pier pilings + 1 dry quay lamp post (filtered by onWater in CoastBake).
    assert.equal(harborTips.length, 15, `expected 15 candidate tips on harbor, got ${harborTips.length}`);
    assert.equal(detectPilingTips(loadPng('bridges/bridge.landmark.civic.ns.png')).length, 0);
    assert.equal(detectPilingTips(loadPng('bridges/bridge.landmark.rustic.ns.png')).length, 0);
});

// C-03 — NW/NE back-shore ocean seeding must extend past MAP_SIZE in the
// padded coast field so no fake land edge shoots NW out of the SW bastion
// corner or NE out of the SE cliff.
test('C-03: coast field stays deep open water past SW bastion and SE corners', () => {
    const field = getCoastField({ world: { buildings: new Map() }, waterTiles: new Set() });
    // 2.5 tiles NW of the SW corner (v around MAP_SIZE - 0.5): must stay > 1.8 tiles from land.
    for (const v of [MAP_SIZE - 2, MAP_SIZE - 1, MAP_SIZE - 0.5, MAP_SIZE, MAP_SIZE + 1]) {
        const sd = field.signedDistance(-2.5, v);
        assert.ok(sd > 1.8, `expected open water off SW corner at (-2.5, ${v}), got sd=${sd}`);
    }
    // Symmetric check off the SE corner along v = -2.5.
    for (const u of [MAP_SIZE - 2, MAP_SIZE - 1, MAP_SIZE - 0.5, MAP_SIZE, MAP_SIZE + 1]) {
        const sd = field.signedDistance(u, -2.5);
        assert.ok(sd > 1.8, `expected open water off SE corner at (${u}, -2.5), got sd=${sd}`);
    }
});
