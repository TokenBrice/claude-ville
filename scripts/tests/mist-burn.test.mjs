import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIST_BURN, NIGHT_MIST_LAND_SHARE, NIGHT_MIST_SHARE, mistBurnFor, mistDensity } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { MIST, mistTopAt, resolveMistBurn } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { MIST_HALO, mistHaloAirFog, mistHaloEligible, mistHaloFor } from '../../claudeville/src/presentation/character-mode/MistHalos.js';
import { FRAME_UNIFORM_LAYOUT } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
const CLEAR = { type: 'clear', intensity: 0 };
const FOG = { type: 'fog', intensity: 0.85, fog: 0.89 };
const morning = (elevationDeg, extra = {}) => ({
    weather: CLEAR, phase: elevationDeg < 0 ? 'dawn' : 'day', phaseProgress: 0.8,
    clock: { minuteOfDay: 480 + elevationDeg * 10 }, solar: { elevationDeg, solarNoonMinute: 720 }, ...extra,
});

test('MS-2: at look 0 the density and top are MS-1\'s, burn shares 1', () => {
    try {
        // mistDensity reads ms2 itself: MS-1's density is the density at ms2 0.
        setLookStrength('ms2', 0);
        for (const atmosphere of [morning(-2, { phase: 'dawn', phaseProgress: 0.4 }), morning(8), { weather: FOG, phase: 'night' }]) {
            const burn = mistBurnFor(atmosphere, 0);
            assert.equal(burn.land, 1);
            assert.equal(burn.sea, 1);
            assert.equal(burn.density, mistDensity(atmosphere));
        }
        assert.deepEqual(Array.from(resolveMistBurn({ mistBurn: [0.2, 0.5] }, Float32Array.from([0.5, 0, 0, 0]))), [1, 1], 'mist off: no burn');
    } finally {
        resetLookStrengths();
    }
});

test('MS-2: the land clears first, the water and the low shore last, stepped in eighths', () => {
    // The mist's top over land and water is density x share (r2: the share
    // absorbs the density's eighths, so compare the tops, not the shares).
    let lastLand = 1;
    let lastSea = 1;
    let landGoneAt = null;
    let seaGoneAt = null;
    for (let e = 0; e <= MIST_BURN.fullDeg; e += 0.5) {
        const burn = mistBurnFor(morning(e), 1);
        const land = burn.density * burn.land;
        const sea = burn.density * burn.sea;
        assert.ok(land <= lastLand + 1e-9 && sea <= lastSea + 1e-9, `monotone at ${e} deg`);
        assert.equal(burn.land * MIST_BURN.steps % 1, 0);
        assert.equal(burn.sea * MIST_BURN.steps % 1, 0);
        if (land === 0 && landGoneAt === null) landGoneAt = e;
        if (sea === 0 && seaGoneAt === null) seaGoneAt = e;
        lastLand = land;
        lastSea = sea;
    }
    assert.ok(landGoneAt !== null && seaGoneAt !== null && landGoneAt < seaGoneAt, `land ${landGoneAt} before sea ${seaGoneAt}`);
    assert.equal(mistBurnFor(morning(MIST_BURN.fullDeg), 1).density, 0, 'fully burnt off: no mist at all');
    // Before sunrise the dawn mist holds full, nothing burnt.
    const dawn = mistBurnFor(morning(-1, { phase: 'dawn', phaseProgress: 0.7 }), 1);
    assert.equal(dawn.land, dawn.sea, 'nothing burnt: land and water alike');
    assert.ok(dawn.density * dawn.land > 0.25);
});

test('MS-2: fog weather keeps its density and the water, holding fogLandKeep and fogInland over land; dawn and night unchanged', async () => {
    const { evaluateGrade } = await import('../../claudeville/src/presentation/character-mode/GradeEvaluator.js');
    const fog = mistBurnFor(morning(12, { weather: FOG }), 1);
    assert.equal(fog.sea, 1);
    assert.equal(fog.land, Math.round(MIST_BURN.fogLandKeep * MIST_BURN.steps) / MIST_BURN.steps);
    assert.ok(MIST_BURN.fogLandKeep >= 0.8, 'real fog holds land shroud at noon');
    assert.equal(fog.density, mistBurnFor(morning(12, { weather: FOG }), 0).density);
    const night = mistBurnFor({ weather: FOG, phase: 'night', solar: { elevationDeg: -30 } }, 1);
    assert.deepEqual([night.land, night.sea], [1, 1]);
    // Real fog lifts inland share via resolveMistBurn; dawn radiation mist keeps MIST.inland.
    const mist = Float32Array.from([fog.density, 0, 0, 1]);
    const fogBurn = resolveMistBurn({ atmosphere: { weather: FOG }, mistBurn: [fog.land, fog.sea] }, mist);
    const dawnBurn = resolveMistBurn({ atmosphere: { weather: CLEAR }, mistBurn: [1, 1] }, mist);
    assert.ok(fogBurn[0] > 2, 'real fog lifts inland mist share');
    assert.equal(dawnBurn[0], 1, 'dawn radiation mist keeps MIST.inland');
    assert.ok(mistTopAt({ x: 100, y: 300 }, 0, mist, fogBurn) > 12, 'daytime fog exceeds one mist course inland');
    // Fog suppresses sunny cloud shadows in GradeEvaluator.
    assert.equal(evaluateGrade({ minuteOfDay: 12 * 60, weather: FOG }).cloudShadow, 0);
});

test('MS-2: the mist top\'s burn shares are twins and the CPU top follows them', () => {
    const glsl = read('gpu/GpuWorldRenderer.js');
    const wgsl = read('gpu/wgsl/atmosphere.js');
    assert.ok(glsl.includes('mix(${mistNumber(MIST.inland)} * u_mistBurn.x, u_mistBurn.y, near)'));
    assert.ok(wgsl.includes('mix(${mistNumber(MIST.inland)} * frame.mistBurn.x, frame.mistBurn.y, near)'));
    assert.ok(FRAME_UNIFORM_LAYOUT.fields.some(field => field.name === 'mistBurn'));
    const mist = Float32Array.from([1, 0, 0, 1]);
    const ground = { x: 100, y: 300 };
    const full = mistTopAt(ground, 0, mist, [1, 1]);
    assert.ok(full > 0 && full <= MIST.inland * (MIST.topBase + MIST.topSwell) + 1e-9);
    assert.equal(mistTopAt(ground, 0, mist, [0, 1]), 0, 'a cleared land has no top');
    assert.ok(mistTopAt(ground, 1, mist, [0, 1]) > full, 'the water keeps its mist');
});

test('MS-2: a halo only for a lit lamp standing in the mist, never an attention light or the Lighthouse', () => {
    const night = { core: 1, halo: 1 };
    const lamp = { x: 0, y: 0, height: 8, intensity: 1, color: '#ffcc66', role: 'fixture' };
    assert.equal(mistHaloFor(lamp, 30, 0, night), null, 'look 0');
    assert.equal(mistHaloFor(lamp, 6, 1, night), null, 'above the mist top');
    assert.equal(mistHaloFor(lamp, 30, 1, { core: 0.14, halo: 0.72 }), null, 'daylight');
    const halo = mistHaloFor(lamp, 30, 1, night);
    assert.ok(halo && halo.radius >= MIST_HALO.radius[0] && halo.radius <= MIST_HALO.radius[1]);
    assert.ok(halo.alpha <= MIST_HALO.alpha && halo.alpha * 8 === Math.round(halo.alpha * 8));
    const deeper = mistHaloFor(lamp, 60, 1, night);
    assert.ok(deeper.radius > halo.radius || deeper.radius === MIST_HALO.radius[1]);
    assert.equal(mistHaloEligible({ ...lamp, role: 'attention', attention: 'waiting' }), false);
    assert.equal(mistHaloEligible({ ...lamp, buildingType: 'watchtower' }), false);
    // r2 — a carried lantern's light sits on its carrier's foot: no halo.
    assert.equal(mistHaloEligible({ ...lamp, id: 'carried-lantern:a1' }), false);
    // Half the look, half the glow (stepped).
    assert.ok(mistHaloFor(lamp, 60, 0.5, night).alpha < deeper.alpha);
});

test('MS-2: fog weather\'s air lights a halo above the layer; a clear dawn mist does not', async () => {
    const { mistHaloAirFog } = await import('../../claudeville/src/presentation/character-mode/MistHalos.js');
    const night = { core: 1, halo: 1 };
    const tall = { x: 0, y: 0, height: 90, intensity: 1, role: 'fixture' };
    assert.equal(mistHaloAirFog({ type: 'clear', fog: 0.02 }), 0);
    assert.equal(mistHaloFor(tall, 10, 1, night, mistHaloAirFog({ type: 'clear', fog: 0.02 })), null);
    const inFog = mistHaloFor(tall, 10, 1, night, mistHaloAirFog({ type: 'fog', fog: 0.89 }));
    assert.ok(inFog && inFog.radius < MIST_HALO.radius[1], 'smaller than a flame deep in the layer');
});

test('MS-2: only flames glow: a lit pane or board, a spark, a beam take no halo', () => {
    const base = { x: 0, y: 0, height: 4, intensity: 1 };
    assert.equal(mistHaloEligible({ ...base, role: 'aperture' }), false, 'a lit window or board');
    assert.equal(mistHaloEligible({ ...base, role: 'aperture', fire: true }), true, 'a lit door');
    assert.equal(mistHaloEligible({ ...base, role: 'fixture', kind: 'spark' }), false);
    assert.equal(mistHaloEligible({ ...base, role: 'point', kind: 'beam' }), false);
    assert.equal(mistHaloEligible({ ...base, role: 'fixture', kind: 'point' }), true);
});

test('MS-2: a halo takes its lamp\'s painter position, so everything nearer paints over it', async () => {
    const { insertMistHaloRecords } = await import('../../claudeville/src/presentation/character-mode/MistHalos.js');
    const records = [
        { id: 'terrain:static' }, { id: 'ground:cue' },
        { id: 'tavern', depthSortY: 300 }, { id: 'tree', depthSortY: 420 },
        { id: 'villager-front', depthSortY: 505 }, { id: 'wall', depthSortY: 900 },
    ];
    const halos = [{ id: 'halo-brazier', depthSortY: 500 }, { id: 'halo-behind-tavern', depthSortY: 250 }, { id: 'halo-sea', depthSortY: 2000 }];
    const ids = insertMistHaloRecords(records, halos).map(r => r.id);
    assert.deepEqual(ids, ['terrain:static', 'ground:cue', 'halo-behind-tavern', 'tavern', 'tree', 'halo-brazier', 'villager-front', 'wall', 'halo-sea']);
    // Every record after a halo lies nearer the camera than its lamp; every
    // painter record before it lies farther (or level).
    for (const [i, id] of ids.entries()) {
        if (!id.startsWith('halo')) continue;
        const line = halos.find(h => h.id === id).depthSortY;
        for (const r of records.slice(0, i)) if (r.depthSortY != null && !r.id.startsWith('halo')) assert.ok(r.depthSortY <= line, `${r.id} before ${id}`);
        for (const r of records.slice(i + 1)) if (r.depthSortY != null && !r.id.startsWith('halo')) assert.ok(r.depthSortY > line, `${r.id} after ${id}`);
    }
});

// r2 (D2) — whole days in 10-minute steps: the mist's top over land and
// over water never jumps between samples (a thin
// bank day, fog rising through the day, lat 58 on 21 Dec, a clear summer
// day), and a thin bank never reappears at solar noon. Bound: three
// sixteenths per 10 minutes.
test('MS-2: whole days walk the burn-off without a jump', async () => {
    const A = await import('../../claudeville/src/presentation/character-mode/AtmosphereState.js');
    const days = [
        ['thin bank, 13 Nov', { lat: 48.9, lon: 2.3 }, [2026, 10, 13], () => ({ type: 'partly-cloudy', intensity: 0.48, precipitation: 0, fog: 0.3, cloudCover: 0.42 })],
        ['rising fog, 13 Nov', { lat: 48.9, lon: 2.3 }, [2026, 10, 13], m => ({ type: m > 600 ? 'fog' : 'overcast', intensity: 0.6, precipitation: 0, fog: Math.min(0.9, 0.05 + m / 1440), cloudCover: 0.7 })],
        ['clear, lat 58, 21 Dec', { lat: 58, lon: 18 }, [2026, 11, 21], () => ({ type: 'clear', intensity: 0.18, precipitation: 0, fog: 0, cloudCover: 0.1 })],
        ['clear summer, 21 Jun', { lat: 48.9, lon: 2.3 }, [2026, 5, 21], () => ({ type: 'clear', intensity: 0.18, precipitation: 0, fog: 0, cloudCover: 0.1 })],
    ];
    try {
        for (const [label, site, ymd, weatherAt] of days) {
            A.setSolarSite(site);
            let prev = null;
            let worst = 0;
            let worstAt = '';
            for (let m = 0; m < 1440; m += 10) {
                const now = new Date(ymd[0], ymd[1], ymd[2], Math.floor(m / 60), m % 60, 0);
                const snap = A.createAtmosphereSnapshot({ now, weatherOverride: weatherAt(m), solarSite: site });
                const b = mistBurnFor(snap, 1);
                const tops = [b.density * b.land, b.density * b.sea];
                if (prev) {
                    const jump = Math.max(Math.abs(tops[0] - prev[0]), Math.abs(tops[1] - prev[1]));
                    if (jump > worst) { worst = jump; worstAt = `${Math.floor(m / 60)}:${m % 60}`; }
                }
                prev = tops;
            }
            // The old switch jumped a full 0.25 (thin bank at solar noon,
            // lat 58 at noon); a burn step is at most 0.16 here.
            assert.ok(worst <= 0.1875 + 1e-9, `${label}: the top jumps ${worst} at ${worstAt}`);
        }
    } finally {
        A.setSolarSite(null);
    }
});

test('NE v0.67.1 M: clear nights spawn water-only radiation mist (land 0.08, sea 1.0) and waterfront/rain MistHalos; day and fog unchanged', () => {
    assert.equal(NIGHT_MIST_SHARE, 0.32);
    assert.equal(NIGHT_MIST_LAND_SHARE, 0.08);
    const clearNightMid = mistBurnFor({ weather: CLEAR, phase: 'night', phaseProgress: 0.5, solar: { elevationDeg: -25 } }, 1);
    const expectedDensity = Math.round(NIGHT_MIST_SHARE * MIST_BURN.steps) / MIST_BURN.steps;
    assert.equal(clearNightMid.density, expectedDensity);
    assert.equal(clearNightMid.sea, 1);
    assert.equal(clearNightMid.land, Math.round(NIGHT_MIST_LAND_SHARE * MIST_BURN.steps) / MIST_BURN.steps);
    assert.ok(clearNightMid.land <= 0.1, 'inland share stays near zero so villagers remain crisp');
    // Smooth ease at night edges so dusk/dawn transitions never jump.
    assert.equal(mistBurnFor({ weather: CLEAR, phase: 'night', phaseProgress: 0, solar: { elevationDeg: -6 } }, 1).density, 0);
    assert.equal(mistBurnFor({ weather: CLEAR, phase: 'night', phaseProgress: 1, solar: { elevationDeg: -6 } }, 1).density, 0);
    const partlyNight = mistBurnFor({ weather: { type: 'partly-cloudy', intensity: 0.2 }, phase: 'night', phaseProgress: 0.5, solar: { elevationDeg: -25 } }, 1);
    assert.equal(partlyNight.density, expectedDensity);
    assert.equal(partlyNight.sea, 1);
    // Day stays clear (0 mist) and fog night keeps full [1, 1].
    assert.equal(mistBurnFor({ weather: CLEAR, phase: 'day', phaseProgress: 0.5, solar: { elevationDeg: 40 } }, 1).density, 0);
    const fogNight = mistBurnFor({ weather: FOG, phase: 'night', phaseProgress: 0.5, solar: { elevationDeg: -25 } }, 1);
    assert.deepEqual([fogNight.land, fogNight.sea], [1, 1]);
    // Waterfront MistHalos: flames above clear-night water mist glow only at waterfront (near > 0.45, top > 4), never inland or by day.
    const nightEnergy = { core: 1, halo: 1 };
    const lamp = { x: 0, y: 0, height: 18, intensity: 1, color: '#ffcc66', role: 'fixture' };
    assert.equal(mistHaloFor(lamp, 10, 1, nightEnergy, 0, 0.2), null, 'inland lamp above mist top gets no halo');
    assert.equal(mistHaloFor(lamp, 3, 1, nightEnergy, 0, 0.8), null, 'waterfront below topMin gets no halo');
    assert.equal(mistHaloFor(lamp, 10, 1, { core: 0.14, halo: 0.72 }, 0, 0.8), null, 'daytime gets no halo');
    const waterfrontHalo = mistHaloFor(lamp, 10, 1, nightEnergy, 0, 0.8);
    assert.ok(waterfrontHalo && waterfrontHalo.alpha > 0 && waterfrontHalo.radius >= MIST_HALO.radius[0], 'waterfront lamp gets clear-night halo');
    // Rain/storm wet air also produces MistHalos above the low layer.
    assert.ok(mistHaloAirFog({ type: 'rain', fog: 0.25 }) > 0);
    assert.ok(mistHaloAirFog({ type: 'storm', fog: 0.35 }) > mistHaloAirFog({ type: 'rain', fog: 0.25 }));
    assert.ok(mistHaloFor(lamp, 0, 1, nightEnergy, mistHaloAirFog({ type: 'storm', fog: 0.35 }), 0), 'storm wet air lights lamp halo');
});
