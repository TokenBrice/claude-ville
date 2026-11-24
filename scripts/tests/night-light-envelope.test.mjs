// NE P2.2 / P2.3 — source-energy reach, gain, bloom and halo envelope contract,
// and single-pass scaling of non-attention records in `_computeFrameLightSources`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NEUTRAL_SOURCE_ENERGY,
    SOURCE_ENERGY_BUCKETS,
    sourceEnergyEnvelope,
    sourceEnergyFor,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

const ORDER = ['daylight', 'settling', 'lamplight', 'deep-night'];

function mockRenderer({ building = [], attention = [], fixtures = [], wetness = 0 } = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    Object.defineProperty(renderer, 'motionTimeMs', { value: 0, configurable: true });
    renderer.motionScale = 0;
    renderer._atmosphereReactions = { surfaceWetness: wetness };
    renderer.pathTiles = wetness > 0 ? new Set(['10,10']) : new Set();
    renderer.bridgeTiles = new Map();
    renderer.buildingRenderer = { getLightSources: () => building };
    renderer._attentionLightSources = () => attention;
    renderer._familiarMoteLightSources = () => [];
    renderer.arrivalDeparture = { getLightSources: () => [] };
    renderer._lanternGroundLightSources = () => fixtures;
    renderer._villageWallLanternLightSources = () => [];
    renderer.bridgeLanterns = { getLightSources: () => [] };
    renderer.harborTraffic = { lampLightSources: () => [] };
    renderer._carriedLanternLightSources = () => [];
    return renderer;
}

test('NE P2.2 / P2.3: reach and gain rise monotonically from daylight (1/1) to deep-night', () => {
    const buckets = ORDER.map(name => SOURCE_ENERGY_BUCKETS[name]);
    assert.equal(SOURCE_ENERGY_BUCKETS.daylight.reach, 1);
    assert.equal(SOURCE_ENERGY_BUCKETS.daylight.gain, 1);
    assert.equal(NEUTRAL_SOURCE_ENERGY.reach, 1);
    assert.equal(NEUTRAL_SOURCE_ENERGY.gain, 1);

    for (let i = 1; i < buckets.length; i++) {
        assert.ok(buckets[i].reach >= buckets[i - 1].reach, `${buckets[i].bucket} reach >= ${buckets[i - 1].bucket}`);
        assert.ok(buckets[i].gain >= buckets[i - 1].gain, `${buckets[i].bucket} gain >= ${buckets[i - 1].bucket}`);
        assert.ok(buckets[i].bloom >= buckets[i - 1].bloom, `${buckets[i].bucket} bloom >= ${buckets[i - 1].bucket}`);
        assert.ok(buckets[i].halo >= buckets[i - 1].halo, `${buckets[i].bucket} halo >= ${buckets[i - 1].bucket}`);
    }

    assert.deepEqual(
        {
            reach: SOURCE_ENERGY_BUCKETS.lamplight.reach,
            gain: SOURCE_ENERGY_BUCKETS.lamplight.gain,
            bloom: SOURCE_ENERGY_BUCKETS.lamplight.bloom,
            halo: SOURCE_ENERGY_BUCKETS.lamplight.halo,
        },
        { reach: 1.25, gain: 1.1, bloom: 0.55, halo: 1.15 },
    );
    assert.deepEqual(
        {
            reach: SOURCE_ENERGY_BUCKETS['deep-night'].reach,
            gain: SOURCE_ENERGY_BUCKETS['deep-night'].gain,
            bloom: SOURCE_ENERGY_BUCKETS['deep-night'].bloom,
            halo: SOURCE_ENERGY_BUCKETS['deep-night'].halo,
        },
        { reach: 1.5, gain: 1.2, bloom: 0.8, halo: 1.3 },
    );

    // sourceEnergyEnvelope and sourceEnergyFor pass reach and gain through verbatim.
    const deep = sourceEnergyEnvelope(22 * 60);
    assert.equal(deep.reach, 1.5);
    assert.equal(deep.gain, 1.2);
    assert.equal(sourceEnergyFor({ sourceEnergy: deep }).reach, 1.5);
    assert.equal(sourceEnergyFor({ sourceEnergy: deep }).gain, 1.2);
    assert.equal(sourceEnergyFor(null).reach, 1);
    assert.equal(sourceEnergyFor(null).gain, 1);
});

test('NE P2.2: _computeFrameLightSources scales non-attention records once and never touches attention records', () => {
    const buildingLight = { id: 'bldg:forge', kind: 'point', role: 'aperture', x: 0, y: 0, radius: 50, intensity: 0.8 };
    const lampLight = { id: 'village.lantern.6.22', kind: 'point', role: 'fixture', x: 0, y: 0, radius: 76, intensity: 0.82 };
    const attentionLight = {
        id: 'attention:needs_you:a1',
        kind: 'point',
        role: 'attention',
        attention: 'needs_you',
        x: 0,
        y: 0,
        radius: 44,
        intensity: 0.6,
    };

    const renderer = mockRenderer({
        building: [buildingLight],
        attention: [attentionLight],
        fixtures: [lampLight],
    });
    const deepAtm = { lighting: { sourceEnergy: SOURCE_ENERGY_BUCKETS['deep-night'] } };
    const { building, ambient } = renderer._computeFrameLightSources(deepAtm, 1000);

    // Building shares the same object references as ambient and must be scaled exactly once.
    assert.equal(building[0], buildingLight);
    assert.ok(ambient.includes(buildingLight));
    assert.ok(Math.abs(buildingLight.radius - 50 * 1.5) < 1e-9);
    assert.ok(Math.abs(buildingLight.intensity - 0.8 * 1.2) < 1e-9);
    assert.ok(Math.abs(lampLight.radius - 76 * 1.5) < 1e-9);
    assert.ok(Math.abs(lampLight.intensity - 0.82 * 1.2) < 1e-9);

    // Attention records stay completely untouched.
    assert.equal(attentionLight.radius, 44);
    assert.equal(attentionLight.intensity, 0.6);

    // Lamplight applies the intermediate 1.25 / 1.1 step.
    const duskLamp = { id: 'lamp:dusk', kind: 'point', role: 'fixture', x: 0, y: 0, radius: 66, intensity: 0.8 };
    const duskAttention = { id: 'attention:err:a2', kind: 'point', role: 'attention', attention: 'error', x: 0, y: 0, radius: 44, intensity: 0.6 };
    const duskRenderer = mockRenderer({ fixtures: [duskLamp], attention: [duskAttention] });
    duskRenderer._computeFrameLightSources({ lighting: { sourceEnergy: SOURCE_ENERGY_BUCKETS.lamplight } }, 1000);
    assert.ok(Math.abs(duskLamp.radius - 66 * 1.25) < 1e-9);
    assert.ok(Math.abs(duskLamp.intensity - 0.8 * 1.1) < 1e-9);
    assert.equal(duskAttention.radius, 44);
    assert.equal(duskAttention.intensity, 0.6);
});

test('NE P2.2: daylight and partial/neutral envelopes leave light records unchanged', () => {
    for (const lighting of [
        { sourceEnergy: SOURCE_ENERGY_BUCKETS.daylight },
        { sourceEnergy: NEUTRAL_SOURCE_ENERGY },
        { sourceEnergy: { core: 1 } },
        null,
    ]) {
        const lamp = { id: 'lamp', kind: 'point', role: 'fixture', x: 0, y: 0, radius: 66, intensity: 0.82 };
        const renderer = mockRenderer({ fixtures: [lamp] });
        renderer._computeFrameLightSources({ lighting }, 1000);
        assert.equal(lamp.radius, 66);
        assert.equal(lamp.intensity, 0.82);
    }
});
