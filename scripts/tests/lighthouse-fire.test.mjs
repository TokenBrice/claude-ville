import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
    BuildingSprite,
    LIGHTHOUSE_COLUMN_COLOR,
    LIGHTHOUSE_COLUMN_FLASH_GAINS,
    PHAROS_FLASH_PERIOD_STEPS,
    PHAROS_FLASH_STEP_MS,
    pharosFlashCourseAt,
} from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { ChimneySmoke } from '../../claudeville/src/presentation/character-mode/ChimneySmoke.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { fireBreath } from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';

const root = new URL('../../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const atmosphere = (hour, weather = { type: 'clear', fog: 0 }) => ({
    clock: { minuteOfDay: hour * 60 },
    season: 'autumn',
    phase: hour > 20 || hour < 5 ? 'night' : 'day',
    weather,
    lighting: hour > 20 || hour < 5 ? { sourceEnergy: { core: 0.95, halo: 1.3, spill: 1, bloom: 0.8 } } : { sourceEnergy: { core: 0, halo: 1, spill: 0, bloom: 0 } },
});
function beacon(hour, { weather = { type: 'clear', fog: 0 }, watching = 0 } = {}) {
    return Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: atmosphere(hour, weather),
        buildings: [{ type: 'watchtower' }],
        assets: { getEntry: () => ({ id: 'building.watchtower' }), getAnchor: () => [144, 320] },
        partGates: { workingCount: (type) => (type === 'watchtower' ? watching : 0) },
        _buildingScreenCenter: () => ({ x: 1000, y: 1000 }),
        _staticLightSources: () => [{ id: 'wt', buildingType: 'watchtower', building: { type: 'watchtower' }, x: 596, y: 401, ground: { x: 598, y: 628 }, radius: 200, role: 'fixture' }],
        _lighthouseMirrorDrop: () => 100,
    });
}

test('pharosFlashCourseAt gives Fl 6 s at rest, Fl(2) 6 s while watched, and 0 under reduced motion', () => {
    assert.equal(PHAROS_FLASH_STEP_MS, 140);
    assert.equal(PHAROS_FLASH_PERIOD_STEPS, 43);
    const steps = watched => Array.from({ length: 43 }, (_, i) => pharosFlashCourseAt(i * 140 + 70, watched));
    assert.deepEqual(steps(false).slice(0, 7), [1, 2, 3, 3, 2, 1, 0]);
    assert.equal(steps(false).filter(Boolean).length, 6, 'one 840 ms pass per 6.02 s');
    assert.deepEqual(steps(true).slice(0, 16), [1, 2, 3, 3, 2, 1, 0, 0, 0, 1, 2, 3, 3, 2, 1, 0]);
    assert.equal(steps(true).filter(Boolean).length, 12, 'a working watcher adds the second pass at step 9');
    assert.equal(pharosFlashCourseAt(43 * 140 + 300, false), pharosFlashCourseAt(300, false), 'period 43 steps (6.02 s)');
    assert.equal(pharosFlashCourseAt(141, false), pharosFlashCourseAt(279, false), 'held within a 140 ms step');
    for (const step of [0, 1, 2, 3, 9, 11]) {
        assert.equal(pharosFlashCourseAt(step * 140 + 10, true, 0), 0, 'reduced motion returns 0');
    }
    assert.equal(fireBreath(1000, 'fire:watchtower', 0), 1);
});

test('water column uses warm beaconFire[4] hue and moderate flash gains in step with the lantern; null by day', () => {
    assert.equal(LIGHTHOUSE_COLUMN_COLOR, ART_RAMPS.beaconFire[4]);
    assert.deepEqual([...LIGHTHOUSE_COLUMN_FLASH_GAINS], [1, 1.15, 1.3, 1.45]);
    for (const hour of [12, 19]) assert.equal(beacon(hour).lighthouseColumnSource(), null);

    const sprite = beacon(23, { watching: 1 });
    sprite.motionScale = 1;
    const sample = (step) => {
        sprite._partClockMs = () => step * 140 + 10;
        return sprite.lighthouseColumnSource();
    };
    const rest = sample(20);
    const c1 = sample(0);
    const c2 = sample(1);
    const c3 = sample(2);
    const pass2Peak = sample(11);
    assert.equal(rest.color, ART_RAMPS.beaconFire[4]);
    assert.equal(rest.columnReach, 1.2);
    for (const [col, mult] of [[c1, 1.15], [c2, 1.3], [c3, 1.45]]) {
        assert.ok(Math.abs(col.intensity - rest.intensity * mult) < 1e-9, `gain ×${mult}`);
        assert.equal(col.columnReach, 1.2);
    }
    assert.equal(pass2Peak.intensity, c3.intensity, 'watched second pass flashes column in lockstep');

    // Unwatched watchtower stays at rest during step 11.
    const idle = beacon(23, { watching: 0 });
    idle.motionScale = 1;
    idle._partClockMs = () => 11 * 140 + 10;
    assert.equal(idle.lighthouseColumnSource().intensity, rest.intensity);

    // Reduced motion holds rest gain even during a flash step.
    sprite.motionScale = 0;
    assert.equal(sample(2).intensity, rest.intensity, 'reduced motion holds steady column');
});

test('obsolete beam pipeline and shaders are removed across all three backends', () => {
    assert.equal('lampBeam' in ART_RAMPS, false);
    assert.deepEqual(ART_RAMPS.beaconFire.slice(3), ['#c8743a', '#f0a850', '#ffd88a', '#fff4d6']);
    assert.equal(existsSync(new URL('claudeville/src/presentation/character-mode/gpu/wgsl/beam.js', root)), false);
    const building = source('claudeville/src/presentation/character-mode/BuildingSprite.js');
    assert.doesNotMatch(building, /_fillBeaconShaft|_fillPixelWedge|_fillLanternFan|lighthouseBeam|searchlightAngleAt|BEAM_NEAR_HALF_WIDTH|WATCHTOWER_SEARCHLIGHT/);
    for (const rel of [
        'claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js',
        'claudeville/src/presentation/character-mode/gpu/wgsl/index.js',
        'claudeville/src/presentation/character-mode/gpu/wgsl/common.js',
        'claudeville/src/presentation/character-mode/gpu/wgsl/water.js',
        'claudeville/src/presentation/character-mode/gpu/wgsl/openSea.js',
        'claudeville/src/presentation/character-mode/gpu/wgsl/scene.js',
    ]) {
        assert.doesNotMatch(source(rel), /lighthouseSheen|LIGHTHOUSE_BEAM|u_beam|BEAM_WGSL|lighthouseDash/, rel);
    }
    const canvas = source('claudeville/src/presentation/character-mode/CanvasWaterState.js');
    assert.doesNotMatch(canvas, /rebuildBeam|beamBayer|beamLive/);
});

test('watchtower crown smokes by lamps clock, not working occupancy; workshops unchanged', () => {
    const smoke = new ChimneySmoke();
    smoke.sources = () => [{ key: 'watchtower:0', type: 'watchtower', x: 0, y: 0, hearth: true, building: {}, localY: 35 }, { key: 'forge:0', type: 'forge', x: 1, y: 0 }];
    const spawned = [];
    const particles = { motionEnabled: true, countTagged: () => 0, spawn: (...args) => spawned.push(args) };
    smoke.update({ now: 1000, atmosphere: atmosphere(12), particleSystem: particles, presence: new Map() });
    assert.equal(spawned.length, 0);
    smoke.update({ now: 2000, timeMs: 2000, atmosphere: atmosphere(23), particleSystem: particles, presence: new Map() });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0][0], 'smoke');
    assert.equal(spawned[0][4].tag, 'chimney:watchtower:0');
    smoke.update({ now: 10000, timeMs: 2000, atmosphere: atmosphere(23), particleSystem: particles, presence: new Map() });
    assert.equal(spawned.length, 1, 'held motion clock spawns no new crown puff');
    smoke.update({ now: 3000, atmosphere: atmosphere(12), particleSystem: particles, presence: new Map([['forge', { tier: 'occupied' }], ['watchtower', { tier: 'busy' }]]) });
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1][4].tag, 'chimney:forge:0');
    smoke.update({ now: 25000, timeMs: 3000, atmosphere: atmosphere(12), particleSystem: particles, presence: new Map([['forge', { tier: 'occupied' }]]) });
    assert.equal(spawned.length, 2, 'held motion clock spawns no new workshop puff despite wall-clock advance');
    smoke.update({ now: 26000, timeMs: 1400, atmosphere: atmosphere(23), particleSystem: particles, presence: new Map([['forge', { tier: 'occupied' }]]) });
    assert.equal(spawned.length, 4, 'rewound motion clock spawns fresh puffs for both active chimneys');
});

test('LM-04: pre-seed populates 3 staggered puffs on real MotionClock cold boot and scrubs, never on mid-session activation', async () => {
    const { ParticleSystem, SMOKE_PUFF_RADII, SMOKE_COLUMN_PX } = await import('../../claudeville/src/presentation/character-mode/ParticleSystem.js');
    const { createMotionClock, advanceMotionClock } = await import('../../claudeville/src/presentation/character-mode/MotionClock.js');
    assert.deepEqual([...SMOKE_PUFF_RADII], [3, 4, 5, 7]);
    assert.equal(SMOKE_COLUMN_PX, 78);

    const sources = [
        { key: 'forge:0', type: 'forge', x: 100, y: 200, hearth: true, building: {}, localY: 15 },
        { key: 'watchtower:0', type: 'watchtower', x: 500, y: 120, hearth: true, building: {}, localY: 50 },
    ];

    const coldClock = createMotionClock();
    const coldSmoke = new ChimneySmoke();
    coldSmoke.sources = () => sources;
    const coldPs = new ParticleSystem();
    coldPs.motionEnabled = true;
    advanceMotionClock(coldClock, 1000 / 60, 1);
    coldSmoke.update({ now: coldClock.elapsedMs, timeMs: coldClock.elapsedMs, atmosphere: null, particleSystem: coldPs, presence: new Map([['forge', { tier: 'busy' }]]) });
    assert.equal(coldPs.particles.length, 0, 'Frame 1 before first _render waits for atmosphere');
    advanceMotionClock(coldClock, 1000 / 60, 1);
    coldSmoke.update({
        now: coldClock.elapsedMs,
        timeMs: coldClock.elapsedMs,
        atmosphere: { ...atmosphere(23), weather: { type: 'clear', windX: -0.65 } },
        particleSystem: coldPs,
        presence: new Map([['forge', { tier: 'busy' }]]),
    });
    const forgePuffs = coldPs.particles.filter(p => p.tag === 'chimney:forge:0');
    const towerPuffs = coldPs.particles.filter(p => p.tag === 'chimney:watchtower:0');
    assert.equal(forgePuffs.length, 4, '1 mouth + 3 staggered puffs on real 60 Hz cold busy Forge');
    assert.equal(towerPuffs.length, 4, '1 mouth + 3 staggered puffs on real 60 Hz cold night Pharos');
    const forgeHeights = forgePuffs.map(p => 200 - p.y).sort((a, b) => a - b);
    assert.ok(forgeHeights[0] === 0 && forgeHeights[3] >= 22, `staggered column heights: ${forgeHeights.join(', ')}`);

    const liveClock = createMotionClock();
    const liveSmoke = new ChimneySmoke();
    liveSmoke.sources = () => sources;
    const livePs = new ParticleSystem();
    livePs.motionEnabled = true;
    advanceMotionClock(liveClock, 1000 / 60, 1);
    liveSmoke.update({ now: liveClock.elapsedMs, timeMs: liveClock.elapsedMs, atmosphere: atmosphere(12), particleSystem: livePs, presence: new Map() });
    assert.equal(livePs.particles.length, 0, 'no-agents noon has 0 smoke');
    advanceMotionClock(liveClock, 1000 / 60, 1);
    liveSmoke.update({
        now: liveClock.elapsedMs,
        timeMs: liveClock.elapsedMs,
        atmosphere: { ...atmosphere(12), weather: { type: 'clear', windX: -0.65 } },
        particleSystem: livePs,
        presence: new Map([['forge', { tier: 'busy' }]]),
    });
    assert.equal(livePs.particles.filter(p => p.tag === 'chimney:forge:0').length, 1, 'mid-session Forge activation emits 1 puff only');
    advanceMotionClock(liveClock, 1000 / 60, 1);
    liveSmoke.update({
        now: liveClock.elapsedMs,
        timeMs: liveClock.elapsedMs,
        atmosphere: { ...atmosphere(23), weather: { type: 'clear', windX: -0.65 } },
        particleSystem: livePs,
        presence: new Map([['forge', { tier: 'busy' }]]),
    });
    assert.equal(livePs.particles.filter(p => p.tag === 'chimney:watchtower:0').length, 4, 'minuteOfDay scrub pre-seeds night Pharos');
    assert.equal(livePs.particles.filter(p => p.tag === 'chimney:forge:0').length, 1, 'active Forge keeps its 1 puff');
});

test('fire overlay flashes with edge-on horizontal flare lengthened in fog, Fl(2) only when watched, steady under reduced motion, off by day', () => {
    const sprite = beacon(23);
    sprite.motionScale = 1;
    sprite.partGates = null;
    sprite._visitorStatusByType = new Map();
    const halos = [];
    const flares = [];
    sprite._fillDitheredCircle = (ctx, x, y, radius, share, alpha) => halos.push({ kind: 'dither', radius, share, alpha });
    sprite._fillPixelCircle = (ctx, x, y, radius) => halos.push({ kind: 'solid', radius, alpha: ctx.globalAlpha });
    const ctx = { save() {}, restore() {}, globalAlpha: 1, fillStyle: '', fillRect: (...args) => flares.push(args) };

    // Rest between passes: 4 halo courses (2 Bayer-dithered outer, 2 solid inner), zero flare.
    sprite._partClockMs = () => 20 * 140 + 10;
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.equal(halos.length, 4);
    assert.deepEqual(halos.map(h => h.kind), ['dither', 'dither', 'solid', 'solid']);
    assert.equal(flares.length, 0, 'no flare between passes');
    assert.ok(halos[0].radius >= 27 && halos[2].radius >= 9, 'halo keeps LO radii');

    // Peak of first pass (course 3): brighter core, edge-on flare at lamp height, no diagonal ticks.
    sprite._partClockMs = () => 3 * 140 + 10;
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.ok(halos[7].alpha > halos[3].alpha, 'the pass brightens the core');
    assert.ok(flares.length > 40, 'peak flare leaves the glass');
    assert.ok(flares.every(([x, y]) => Math.abs(y - 100) <= 1 || x === 100), 'strictly horizontal rows ±1 plus vertical spike only (no diagonal ticks)');
    assert.ok(flares.every(([, y]) => Math.abs(y - 100) <= 7), 'flare stays at lamp height (spike ±7 max)');
    const clearRow = flares.filter(([, y]) => y === 100).map(([x]) => x);
    const clearReach = Math.max(...clearRow) - 100;
    assert.ok(clearReach >= 40 && 100 - Math.min(...clearRow) >= 40, 'clear peak flare reaches both sides (~44 texels)');

    // Fog / storm lengthens the horizontal flare by (1 + 1.5 * fog).
    flares.length = 0;
    sprite.atmosphereState = atmosphere(23, { type: 'storm', fog: 0.34 });
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    const fogRow = flares.filter(([, y]) => y === 100).map(([x]) => x);
    const fogReach = Math.max(...fogRow) - 100;
    assert.ok(fogReach > clearReach + 15, `fog lengthens flare (${clearReach} -> ${fogReach})`);
    assert.ok(flares.every(([x, y]) => Math.abs(y - 100) <= 1 || x === 100), 'fog adds no descending shaft or separate plumes');
    sprite.atmosphereState = atmosphere(23);

    // Second pass (step 12): silent when unwatched, fires when watchtower has a working visitor.
    flares.length = 0;
    sprite._partClockMs = () => 12 * 140 + 10;
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.equal(flares.length, 0, 'unwatched: one pass only');
    sprite._visitorStatusByType = new Map([['watchtower', { working: 1 }]]);
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.ok(flares.length > 40, 'a working watcher adds the second pass');

    // Reduced motion: steady lamp only (no flash, no flare).
    flares.length = 0;
    sprite.motionScale = 0;
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.equal(flares.length, 0, 'reduced motion: steady lamp with no flare');

    // Daylight draws nothing.
    sprite.motionScale = 1;
    const beforeDay = halos.length;
    sprite.atmosphereState = atmosphere(12);
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.equal(halos.length, beforeDay, 'no daylight halo or flash');

    // Embers remain clock-only and freeze under reduced motion.
    const sparks = [];
    sprite._spawnBuildingParticle = (...args) => sparks.push(args);
    sprite._workingVisitorCountFor = () => { throw new Error('embers must not read work'); };
    sprite._partClockMs = () => 1000;
    sprite.atmosphereState = atmosphere(12);
    sprite._spawnEmittersFor(sprite.buildings[0], 16);
    assert.equal(sparks.length, 0);
    sprite.atmosphereState = atmosphere(2);
    sprite._spawnEmittersFor(sprite.buildings[0], 16);
    assert.equal(sparks.length, 1);
    sprite._spawnEmittersFor(sprite.buildings[0], 1000);
    assert.equal(sparks.length, 1, 'held motion clock spawns no new ember');
    assert.equal(sparks[0][1], 'forgeEmber');
    sprite.motionScale = 0;
    sprite._spawnEmittersFor(sprite.buildings[0], 16);
    assert.equal(sparks.length, 1);
});
