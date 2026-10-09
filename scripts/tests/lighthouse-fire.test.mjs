import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { ChimneySmoke } from '../../claudeville/src/presentation/character-mode/ChimneySmoke.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { fireBreath } from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';
import { resolveBeam, BEAM_NEAR_HALF_WIDTH } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { BEAM_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/beam.js';

const root = new URL('../../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const atmosphere = hour => ({ clock: { minuteOfDay: hour * 60 }, season: 'autumn', phase: hour > 20 || hour < 5 ? 'night' : 'day', weather: { type: 'clear' } });
function beacon(hour) {
    return Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: atmosphere(hour), buildings: [{ type: 'watchtower' }],
        assets: { getEntry: () => ({ id: 'building.watchtower' }), getAnchor: () => [144, 320] },
        _buildingScreenCenter: () => ({ x: 1000, y: 1000 }),
    });
}

test('one stepped 0.2 rad/s shaft lands 35 percent out and only at full lamplight', () => {
    for (const hour of [12, 19]) assert.equal(beacon(hour).lighthouseBeam(0), null);
    for (const hour of [23, 2]) {
        const sprite = beacon(hour);
        const a = { ...sprite.lighthouseBeam(0), foot: { ...sprite.lighthouseBeam(0).foot } };
        assert.equal(a.length, 520 * 0.65);
        assert.equal(a.foot.x, Math.round(1001 + Math.cos(a.angle) * 182));
        assert.equal(a.foot.y, Math.round(996 + Math.sin(a.angle) * 91));
        assert.equal(sprite.lighthouseBeam(100).angle, a.angle, 'angle holds within one 140 ms step');
        const b = sprite.lighthouseBeam(1000);
        assert.ok(Math.abs(b.angle - a.angle - 0.196) < 1e-10);
        assert.equal(resolveBeam({ beam: b }).shape[1], BEAM_NEAR_HALF_WIDTH);
        assert.equal(fireBreath(1000, 'fire:watchtower', 0), 1);
    }
});

test('warm receiver stops stay subordinate; obsolete twin, blades and palette are gone', () => {
    assert.equal('lampBeam' in ART_RAMPS, false);
    assert.deepEqual(ART_RAMPS.beaconFire.slice(3), ['#c8743a', '#f0a850', '#ffd88a', '#fff4d6']);
    for (const hex of ART_RAMPS.beaconFire.slice(0, 3)) {
        const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
        const hi = Math.max(...rgb), lo = Math.min(...rgb);
        assert.ok((hi - lo) / (1 - Math.abs(hi + lo - 1)) < 0.4);
        const linear = rgb.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        const [r, g, b] = linear;
        const L = 0.2104542553 * Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b)
            + 0.793617785 * Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b)
            - 0.0040720468 * Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
        assert.ok(L <= 0.83, `${hex} receiver okL ${L}`);
    }
    const building = source('claudeville/src/presentation/character-mode/BuildingSprite.js');
    assert.doesNotMatch(building, /_fillPixelWedge|_fillLanternFan|LANTERN_FAN_STEPS|angle \+ Math\.PI/);
    const glsl = source('claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js');
    for (const shader of [glsl, BEAM_WGSL]) {
        assert.match(shader, /swellCrest\(cell, swellPhase\(cell\)\)/);
        assert.match(shader, /deepSwellLit\(cell, tick/);
        assert.doesNotMatch(shader, /lighthouseFan\(g, -dir/);
        assert.match(shader, /BEACON_WATER_STOPS/);
    }
    const canvas = source('claudeville/src/presentation/character-mode/CanvasWaterState.js');
    assert.match(canvas, /const beaconOut = hex => u32Of\(hexRgb01\(hex\)/, 'warm receivers are not clipped by the night inverse grade');
    assert.match(canvas, /drawCarvedTerrainLayer\(overlayCtx, renderer, state\.beam\)/, 'warm glints land after grade and stay terrain-carved');
    assert.match(canvas, /state\.beamLive = Boolean\(beam\)/, 'no retained daytime beam');
    assert.match(canvas, /path\.u32\[py \* path\.canvas\.width \+ px\] !== 0/, 'sun and moon path texels keep precedence');
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
});

test('fire overlay and embers are clock-only, rear shaft suppressed, reduced motion rests', () => {
    const sprite = beacon(23);
    sprite.motionScale = 1;
    sprite._partClockMs = () => 0;
    const shafts = [];
    const halos = [];
    sprite._fillBeaconShaft = (...args) => shafts.push(args);
    sprite._fillPixelCircle = (...args) => halos.push({ radius: args[3], alpha: ctx.globalAlpha });
    const ctx = { save() {}, restore() {} };
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.equal(shafts.length, 1, 'held heading points toward visible sea');
    assert.equal(halos.length, 4);
    assert.ok(halos[0].radius >= 27 && halos[2].radius >= 9, 'halo reads at island zoom');
    sprite._partClockMs = () => 1000;
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.ok(halos[4].alpha > halos[0].alpha, 'camera-facing mirror brightens one held halo course');
    sprite._partClockMs = () => 23000;
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.equal(shafts.length, 2, 'rear arc never paints through the tower');
    sprite.atmosphereState = atmosphere(12);
    sprite._drawWatchtowerFire(ctx, { x: 100, y: 100 });
    assert.equal(halos.length, 12, 'no daylight halo');
    const sparks = [];
    sprite._spawnBuildingParticle = (...args) => sparks.push(args);
    sprite._workingVisitorCountFor = () => { throw new Error('fire must not read work'); };
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
