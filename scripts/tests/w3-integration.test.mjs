import test from 'node:test';
import assert from 'node:assert/strict';

import { forecastKnot, forecastKnotsByDate } from '../../claudeville/src/presentation/character-mode/VillageWeather.js';
import { resolveFreezingState, normalizeTimelineKnots } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { agentLayerRecords } from '../../claudeville/src/presentation/character-mode/AgentLayerRecords.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { shouldSuppressToolGlyphForArtifact } from '../../claudeville/src/presentation/character-mode/CarriedArtifact.js';
import { MarkGovernor, MarkTier, setActiveMarkGovernor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

test('W3 Integration: VillageWeather preserves temperature_2m and AtmosphereState applies 0.0/1.0C freezing hysteresis', () => {
    const knot = forecastKnot({
        minute: 480,
        code: 0,
        cloud: 10,
        mm: 0,
        snowfall: 0,
        visibility: 10000,
        windSpeed: 8,
        windDirection: 90,
        temperatureC: -1.5,
    });
    assert.equal(knot.temperatureC, -1.5);

    const normalized = normalizeTimelineKnots([knot]);
    assert.equal(normalized[0].temperatureC, -1.5);

    // 0.0 / 1.0 C hysteresis:
    let freezing = false;
    freezing = resolveFreezingState(0.5, freezing, false);
    assert.equal(freezing, false, '0.5 C from warm stays unfrozen');
    freezing = resolveFreezingState(0.0, freezing, false);
    assert.equal(freezing, true, '0.0 C enters freezing');
    freezing = resolveFreezingState(0.7, freezing, false);
    assert.equal(freezing, true, '0.7 C holds freezing hysteresis');
    freezing = resolveFreezingState(1.0, freezing, false);
    assert.equal(freezing, false, '1.0 C exits freezing');
    freezing = resolveFreezingState(null, true, false);
    assert.equal(freezing, false, 'missing temperature never guesses freezing');
    freezing = resolveFreezingState(null, false, true);
    assert.equal(freezing, true, 'active frozen precipitation enters freezing');

    // forecastKnotsByDate carries temperature_2m end-to-end
    const baseEpoch = Math.floor(new Date('2026-01-15T00:00:00').getTime() / 1000);
    const time = Array.from({ length: 24 }, (_, h) => baseEpoch + h * 3600);
    const days = forecastKnotsByDate({
        time,
        weather_code: Array(24).fill(0),
        cloud_cover: Array(24).fill(15),
        precipitation: Array(24).fill(0),
        snowfall: Array(24).fill(0),
        visibility: Array(24).fill(10000),
        wind_speed_10m: Array(24).fill(5),
        wind_direction_10m: Array(24).fill(45),
        temperature_2m: Array(24).fill(-2.2),
    });
    assert.ok(days && days['2026-01-15'], '2026-01-15 forecast day parsed');
    assert.equal(days['2026-01-15'][0].temperatureC, -2.2);
});

test('W3 Integration: AgentLayerRecords orders carried artifact at layer 5 between weaponFront and foreground props', () => {
    const body = { id: 'b' };
    const weaponFront = { id: 'wf' };
    const artifact = { id: 'art' };
    const lantern = { id: 'lan' };
    const list = agentLayerRecords({ body, weaponFront, artifact, lantern });
    assert.deepEqual(list.map(r => [r.id, r.layer]), [
        ['b', 2],
        ['wf', 5],
        ['art', 5],
        ['lan', 6],
    ]);
});

test('W3 Integration: AgentSprite._routineStatusGate delegates to routineStatusGate without spending governor slot on still-work', () => {
    const gov = new MarkGovernor();
    gov.beginFrame();
    setActiveMarkGovernor(gov);
    try {
        const now = Date.now();
        const mockSprite = {
            x: 100,
            y: 100,
            agent: {
                id: 'still-1',
                status: AgentStatus.WORKING,
                turnState: 'composing',
                turnStartedAt: now - 45_000,
                pendingTool: null,
            },
        };
        const gate = AgentSprite.prototype._routineStatusGate.call(mockSprite, AgentStatus.WORKING);
        assert.ok(gate && gate.draw === true);
        assert.equal(gate.alpha, 0.78);
        // Governor WORKING region count should remain 0 (slot unspent!)
        const second = gov.admit(MarkTier.WORKING, 100, 100);
        assert.equal(second.draw, true);
    } finally {
        setActiveMarkGovernor(null);
    }
});

test('W3 Integration: BuildingSprite.triggerWatchtowerChecksFlash honors reduced motion', () => {
    const mock = { motionScale: 1, _watchtowerChecksFlashUntil: 0 };
    BuildingSprite.prototype.triggerWatchtowerChecksFlash.call(mock, 10_000);
    assert.equal(mock._watchtowerChecksFlashUntil, 10_120);

    const reduced = { motionScale: 0, _watchtowerChecksFlashUntil: 0 };
    BuildingSprite.prototype.triggerWatchtowerChecksFlash.call(reduced, 10_000);
    assert.equal(reduced._watchtowerChecksFlashUntil, 0);
});

test('W3 Integration: One-of rule suppresses floating tool glyph while walking at z >= 2 with carried artifact', () => {
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 2, hasArtifact: true }), true);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: false, zoom: 2, hasArtifact: true }), false);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 1.5, hasArtifact: true }), false);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 2, hasArtifact: false }), false);
});
