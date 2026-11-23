import test from 'node:test';
import assert from 'node:assert/strict';
import { ChimneySmoke } from '../../claudeville/src/presentation/character-mode/ChimneySmoke.js';
import { ParticleSystem, SMOKE_PUFF_RADII, SMOKE_COLUMN_PX } from '../../claudeville/src/presentation/character-mode/ParticleSystem.js';
import { createMotionClock, advanceMotionClock } from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { MarkGovernor, MarkTier, setActiveMarkGovernor, getActiveMarkGovernor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { DEFAULT_LOOK_STRENGTHS } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { GROUND_WET, GROUND_WET_GLSL, GROUND_WET_MIRROR_GLSL, GROUND_WET_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/GroundWetShader.js';
import { SCENE_FRAGMENT } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { GpuWorldRendererWebGPU } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';
import { assembleScene } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/index.js';
import { WildlifeRenderer } from '../../claudeville/src/presentation/character-mode/WildlifeRenderer.js';
import * as GpuWorldPolicy from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import * as SunShade from '../../claudeville/src/presentation/character-mode/gpu/SunShade.js';

const atmo = (hour, windX = -0.65, minuteOverride = null) => ({
    clock: { minuteOfDay: minuteOverride ?? hour * 60 },
    season: 'autumn',
    phase: hour > 20 || hour < 5 ? 'night' : 'day',
    weather: { type: 'clear', windX },
});

test('C-06 smoke: real MotionClock cold boot (t=0, Frame 1 null atmo), single MarkGovernor slot, minute scrub, rewind, and single-puff mid-session activation', () => {
    assert.deepEqual([...SMOKE_PUFF_RADII], [3, 4, 5, 7]);
    assert.equal(SMOKE_COLUMN_PX, 78);

    const sources = [
        { key: 'forge:0', type: 'forge', x: 100, y: 200, hearth: true, building: {}, localY: 15 },
        { key: 'watchtower:0', type: 'watchtower', x: 500, y: 120, hearth: true, building: {}, localY: 50 },
    ];

    const prevGov = getActiveMarkGovernor();
    try {
        // 1. Real 60 Hz cold boot from createMotionClock() with active MarkGovernor:
        //    Frame 1 runs before first _render() (atmosphere === null); Frame 2 populates atmosphere
        //    at t = 33.3 ms (< interval) and must pre-seed 4 puffs each using only 1 ambient slot per chimney.
        const gov = new MarkGovernor();
        setActiveMarkGovernor(gov);
        const clock = createMotionClock();
        const coldSmoke = new ChimneySmoke();
        coldSmoke.sources = () => sources;
        const coldPs = new ParticleSystem();
        coldPs.motionEnabled = true;

        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        advanceMotionClock(clock, 1000 / 60, 1);
        coldSmoke.update({
            now: clock.elapsedMs,
            timeMs: clock.elapsedMs,
            atmosphere: null,
            particleSystem: coldPs,
            presence: new Map([['forge', { tier: 'busy' }]]),
        });
        assert.equal(coldPs.particles.length, 0, 'Frame 1 with null atmosphere waits without latching cold boot');

        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        advanceMotionClock(clock, 1000 / 60, 1);
        coldSmoke.update({
            now: clock.elapsedMs,
            timeMs: clock.elapsedMs,
            atmosphere: atmo(23),
            particleSystem: coldPs,
            presence: new Map([['forge', { tier: 'busy' }]]),
        });
        const coldForge = coldPs.particles.filter(p => p.tag === 'chimney:forge:0');
        const coldTower = coldPs.particles.filter(p => p.tag === 'chimney:watchtower:0');
        assert.equal(coldForge.length, 4, 'real 60 Hz cold boot busy Forge pre-seeds 1 mouth + 3 staggered puffs');
        assert.equal(coldTower.length, 4, 'real 60 Hz cold boot night Pharos pre-seeds 1 mouth + 3 staggered puffs');
        assert.equal(gov._region(100, 200).region.working, 1, 'pre-seed consumes only 1 MarkGovernor slot at Forge');
        assert.equal(gov._region(500, 120).region.working, 1, 'pre-seed consumes only 1 MarkGovernor slot at Pharos');
        // The top pre-seeded puff has aged 0.48 of a random life (104–131 frames)
        // at a random rise speed (0.46–0.54 px a frame), so it stands at least
        // 0.48 × 104 × 0.46 ≈ 22.96 px above the mouth and at most about 34 px.
        // Assert that floor, not one draw from the range.
        const heights = coldForge.map(p => 200 - p.y).sort((a, b) => a - b);
        assert.ok(heights[0] === 0 && heights[3] >= 22.9, `staggered column rises cleanly: ${heights.join(', ')}`);

        // 2. Booting empty at noon spawns 0 puffs; mid-session activation and live dusk
        //    transition each emit ONLY 1 mouth puff (never 4 at once — REVIEW.md:113).
        const liveClock = createMotionClock();
        const liveSmoke = new ChimneySmoke();
        liveSmoke.sources = () => sources;
        const livePs = new ParticleSystem();
        livePs.motionEnabled = true;

        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        advanceMotionClock(liveClock, 1000 / 60, 1);
        liveSmoke.update({
            now: liveClock.elapsedMs,
            timeMs: liveClock.elapsedMs,
            atmosphere: atmo(12),
            particleSystem: livePs,
            presence: new Map(),
        });
        assert.equal(livePs.particles.length, 0, 'no-agents noon spawns 0 smoke');

        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        advanceMotionClock(liveClock, 1000 / 60, 1);
        liveSmoke.update({
            now: liveClock.elapsedMs,
            timeMs: liveClock.elapsedMs,
            atmosphere: atmo(12),
            particleSystem: livePs,
            presence: new Map([['forge', { tier: 'busy' }]]),
        });
        assert.equal(livePs.particles.filter(p => p.tag === 'chimney:forge:0').length, 1, 'mid-session Forge activation emits 1 puff only');

        // 3. Held motion clock freezes workshop smoke even if wall-clock `now` jumps ahead.
        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        liveSmoke.update({
            now: 99999,
            timeMs: liveClock.elapsedMs,
            atmosphere: atmo(12),
            particleSystem: livePs,
            presence: new Map([['forge', { tier: 'busy' }]]),
        });
        assert.equal(livePs.particles.filter(p => p.tag === 'chimney:forge:0').length, 1, 'held timeMs freezes smoke');

        // 4. AtmosphereState.setHour minuteOfDay scrub (720 -> 1380) pre-seeds Watchtower (liveCount=0)
        //    without re-preseeding Forge (which already has a live puff).
        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        advanceMotionClock(liveClock, 1000 / 60, 1);
        liveSmoke.update({
            now: liveClock.elapsedMs,
            timeMs: liveClock.elapsedMs,
            atmosphere: atmo(23),
            particleSystem: livePs,
            presence: new Map([['forge', { tier: 'busy' }]]),
        });
        assert.equal(livePs.particles.filter(p => p.tag === 'chimney:watchtower:0').length, 4, 'minuteOfDay scrub pre-seeds night Pharos');
        assert.equal(livePs.particles.filter(p => p.tag === 'chimney:forge:0').length, 1, 'already-smoking Forge does not double-preseed');

        // 5. Rewind to t = 0 with empty live pool re-enables pre-seed cleanly even below interval.
        livePs.particles.length = 0;
        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        liveSmoke.update({
            now: 0,
            timeMs: 0,
            atmosphere: atmo(23),
            particleSystem: livePs,
            presence: new Map([['forge', { tier: 'occupied' }]]),
        });
        assert.equal(livePs.particles.filter(p => p.tag === 'chimney:forge:0').length, 4, 'rewind to t=0 pre-seeds Forge');
        assert.equal(livePs.particles.filter(p => p.tag === 'chimney:watchtower:0').length, 4, 'rewind to t=0 pre-seeds Pharos');

        // 6. Denied MarkGovernor admission (saturated region) does not advance _lastPuff, so recovery spawns immediately.
        const deniedSmoke = new ChimneySmoke();
        deniedSmoke.sources = () => sources;
        const deniedPs = new ParticleSystem();
        deniedPs.motionEnabled = true;
        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        for (let k = 0; k < 7; k++) gov.admit(MarkTier.SECONDARY, 100, 200);
        deniedSmoke.update({ now: 20, timeMs: 20, atmosphere: atmo(12), particleSystem: deniedPs, presence: new Map([['forge', { tier: 'busy' }]]) });
        assert.equal(deniedPs.particles.length, 0, 'denied under saturated MarkGovernor region spawns 0 puffs');
        gov.beginFrame({ regionSize: 200, motionScale: 1, pressureLevel: 0 });
        deniedSmoke.update({ now: 36, timeMs: 36, atmosphere: atmo(12), particleSystem: deniedPs, presence: new Map([['forge', { tier: 'busy' }]]) });
        assert.equal(deniedPs.particles.filter(p => p.tag === 'chimney:forge:0').length, 1, 'recovery after denial spawns immediately');
    } finally {
        setActiveMarkGovernor(prevGov);
    }
});

test('C-06 wet stripes & gw1: continuous cyan glint stripes retired in runtime GLSL & WGSL shaders; gw1=1 keeps main\'s applied sheen', () => {
    assert.equal(DEFAULT_LOOK_STRENGTHS.gw1, 1, 'gw1 ships at 1');
    // The applied sheen is GROUND_WET.sheen x gw1: main drew 0.35 x 0.5.
    assert.equal(GROUND_WET.sheen * DEFAULT_LOOK_STRENGTHS.gw1, 0.175, 'gw1 = 1 keeps main\'s applied wet sheen (0.175)');

    const wgslScene = assembleScene();
    for (const [label, src] of [['GLSL', SCENE_FRAGMENT], ['WGSL', wgslScene]]) {
        const start = src.indexOf('applyMaterialWeather(');
        assert.ok(start > 0, `${label} defines applyMaterialWeather`);
        const end = src.indexOf('\n}', start);
        const body = src.slice(start, end);
        assert.ok(!body.includes('0.031'), `${label} applyMaterialWeather removes 32px diagonal band factor 0.031`);
        assert.ok(!body.includes('phase * 0.07'), `${label} applyMaterialWeather removes sliding timeMs phase * 0.07`);
        assert.ok(!body.includes('glintShare'), `${label} applyMaterialWeather removes glintShare`);
    }
});

test('C-06 gull clock: watchtower gull locks to stepped host.motionTimeMs without moving other fauna', async () => {
    const host = { motionScale: 1, motionTimeMs: 12000 };
    const wildlife = Object.assign(Object.create(WildlifeRenderer.prototype), { host });
    const a = wildlife._watchtowerGullPosition();
    await new Promise((r) => setTimeout(r, 25));
    const b = wildlife._watchtowerGullPosition();
    assert.deepEqual(a, b, 'held motionTimeMs yields identical watchtower gull pose across wall-clock ticks');
    host.motionTimeMs = 15500;
    const c = wildlife._watchtowerGullPosition();
    assert.notEqual(a.x, c.x, 'advancing motionTimeMs advances the watchtower gull orbit');
});

test('C-06 cut discipline: PERF-03, _directFrame, sunbreak, and doorway mirrors remain absent', () => {
    assert.equal(GpuWorldPolicy.lightLaysGroundMirror, undefined, 'cut lightLaysGroundMirror absent');
    assert.equal(SunShade.SUN_SHADE_UNIFORMS_GLSL, undefined, 'cut SUN_SHADE_UNIFORMS_GLSL absent');
    assert.equal(GROUND_WET.sunbreakCap, undefined, 'cut sunbreakCap absent');
    assert.equal(GROUND_WET.doorGain, undefined, 'cut doorGain absent');
    assert.equal('_directFrame' in GpuWorldRendererWebGPU.prototype, false, 'cut _directFrame absent on WebGPU renderer');
    for (const chunk of [GROUND_WET_GLSL, GROUND_WET_MIRROR_GLSL, GROUND_WET_WGSL, SCENE_FRAGMENT, assembleScene()]) {
        assert.ok(!chunk.includes('applyLampMirror'), 'cut applyLampMirror absent');
        assert.ok(!chunk.includes('groundSunbreakAt'), 'cut groundSunbreakAt absent');
        assert.ok(!chunk.includes('groundCrownTop'), 'cut groundCrownTop absent');
    }
});
