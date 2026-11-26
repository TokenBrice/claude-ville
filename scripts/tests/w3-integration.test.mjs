import test from 'node:test';
import assert from 'node:assert/strict';

import { forecastKnot, forecastKnotsByDate } from '../../claudeville/src/presentation/character-mode/VillageWeather.js';
import { resolveFreezingState, normalizeTimelineKnots } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { agentLayerRecords } from '../../claudeville/src/presentation/character-mode/AgentLayerRecords.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { shouldSuppressToolGlyphForArtifact } from '../../claudeville/src/presentation/character-mode/CarriedArtifact.js';
import { MarkGovernor, MarkTier, setActiveMarkGovernor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { ArrivalDepartureController } from '../../claudeville/src/presentation/character-mode/ArrivalDeparture.js';
import { GROUND_CLASS } from '../../claudeville/src/presentation/character-mode/GroundBake.js';
import { MendLedger } from '../../claudeville/src/presentation/character-mode/OutcomeMends.js';
import { RelationshipState } from '../../claudeville/src/presentation/character-mode/RelationshipState.js';
import { CAIRN_DOOR_ZONE_CAP, CAIRN_VIEW_CAP } from '../../claudeville/src/presentation/character-mode/CarriedArtifact.js';
import { DIRECTIONS } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { repoProfile } from '../../claudeville/src/presentation/shared/RepoColor.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { REST_SEATS } from '../../claudeville/src/config/townPlan.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

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
    const mock = { motionScale: 1, _watchtowerChecksFlash: false };
    BuildingSprite.prototype.triggerWatchtowerChecksFlash.call(mock);
    assert.equal(mock._watchtowerChecksFlash, true);

    const reduced = { motionScale: 0, _watchtowerChecksFlash: false };
    BuildingSprite.prototype.triggerWatchtowerChecksFlash.call(reduced);
    assert.equal(reduced._watchtowerChecksFlash, false);
});

test('W3 Integration: One-of rule suppresses floating tool glyph while walking at z >= 2 with carried artifact', () => {
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 2, hasArtifact: true }), true);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: false, zoom: 2, hasArtifact: true }), false);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 1.5, hasArtifact: true }), false);
    assert.equal(shouldSuppressToolGlyphForArtifact({ walking: true, zoom: 2, hasArtifact: false }), false);
});

function makeWave3Renderer(overrides = {}) {
    return Object.assign(Object.create(IsometricRenderer.prototype), {
        world: { buildings: new Map(), agents: new Map() },
        agentSprites: new Map(),
        camera: { zoom: 2, x: 0, y: 0, canvas: { _claudeVilleCssWidth: 1280, _claudeVilleCssHeight: 720 } },
        motionScale: 1,
        _motionClock: { elapsedMs: 5_000 },
        _lastAtmosphere: { weather: { type: 'clear' }, lightGrade: { cacheKey: 'night-grade' } },
        _nicknames: new Map(),
        _patinaByIdentity: new Map(),
        _benchClaimsByIdentity: new Map(),
        _benchPatinaBySeat: new Map(),
        _restSeatBackProps: new Map(),
        _seatedSeatByAgent: new Map(),
        _allyNodCooldowns: new Map(),
        _childTrimById: new Map(),
        _workflowRibbons: { byAgentId: new Map(), byParentId: new Map() },
        _compactionsPrimedOnce: false,
        _invalidateIdleFrame() { this._idleInvalidations = (this._idleInvalidations || 0) + 1; },
        ...overrides,
    });
}

test('W3 Integration: _syncWave3LiveSystems drives observeAgentCompactions with wallNow only and expires on monotonic clock', () => {
    const wallNow = 1_764_121_000_000;
    const ctrl = new ArrivalDepartureController({ motionScale: 1 });
    const calls = [];
    const origObserve = ctrl.observeAgentCompactions.bind(ctrl);
    ctrl.observeAgentCompactions = (agent, sprite, opts) => {
        calls.push({ agentId: agent.id, opts });
        return origObserve(agent, sprite, opts);
    };

    const archive = { position: { tileX: 8, tileY: 16 }, width: 4, height: 4 };
    const agent = {
        id: 'claude-lead',
        provider: 'claude',
        status: AgentStatus.WORKING,
        compactions: [
            { at: wallNow - 10_000, trigger: 'auto', preTokens: 320_000, postTokens: 32_000, durationMs: 4000 },
        ],
    };
    const sprite = { agent, x: 100, y: 120, moving: false, selected: false };
    const renderer = makeWave3Renderer({
        world: { buildings: new Map([['archive', archive]]), agents: new Map([[agent.id, agent]]) },
        agentSprites: new Map([[agent.id, sprite]]),
        arrivalDeparture: ctrl,
    });

    // Tick 1: primes initial compaction history without throwing or playing backfill.
    assert.doesNotThrow(() => {
        IsometricRenderer.prototype._syncWave3LiveSystems.call(renderer, [agent], [sprite], wallNow);
    });
    assert.equal(ctrl.compactions.size, 0);
    assert.equal(calls.length, 0);

    // Tick 2: new live compaction arrives -> calls observeAgentCompactions({ archivePoint, wallNow }) with NO epoch `now`.
    const liveAt = wallNow + 1_000;
    agent.compactions = [
        ...agent.compactions,
        { at: liveAt - 500, trigger: 'manual', preTokens: 412_300, postTokens: 38_100, durationMs: 5000 },
    ];
    assert.doesNotThrow(() => {
        IsometricRenderer.prototype._syncWave3LiveSystems.call(renderer, [agent], [sprite], liveAt);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentId, 'claude-lead');
    assert.equal(calls[0].opts.wallNow, liveAt);
    assert.ok(calls[0].opts.archivePoint && Number.isFinite(calls[0].opts.archivePoint.x));
    assert.equal('now' in calls[0].opts, false, 'must not pass epoch wallNow as monotonic animation clock');
    assert.equal(ctrl.compactions.size, 1);

    const [rite] = [...ctrl.compactions.values()];
    assert.equal(rite.chit, '412K → 38K');
    assert.ok(rite.startedAt < 1e11, 'rite startedAt uses monotonic clock, not epoch ms');

    // Advancing ArrivalDeparture on monotonic performance.now() clock expires the rite cleanly.
    ctrl.update(rite.startedAt + rite.duration + 100);
    assert.equal(ctrl.compactions.size, 0);
});

test('W3 Integration: _trailSurfaceAt maps numeric GROUND_CLASS and _coastField.signedDistanceAtWorld', () => {
    let clsValue = GROUND_CLASS.GRASS;
    let coastDist = -1.5;
    let coastCalls = 0;
    const renderer = makeWave3Renderer({
        groundField: {
            CLASS: GROUND_CLASS,
            classAt: () => clsValue,
        },
        _coastField: {
            signedDistanceAtWorld: () => {
                coastCalls += 1;
                return coastDist;
            },
        },
    });

    clsValue = GROUND_CLASS.WATER;
    assert.equal(IsometricRenderer.prototype._trailSurfaceAt.call(renderer, 10, 20), 'water');
    assert.equal(coastCalls, 0, 'water exits without coast distance sampling');

    clsValue = GROUND_CLASS.SAND;
    coastDist = -0.15;
    assert.equal(IsometricRenderer.prototype._trailSurfaceAt.call(renderer, 10, 20), 'wet-shore');
    coastDist = 0.4;
    assert.equal(IsometricRenderer.prototype._trailSurfaceAt.call(renderer, 10, 20), 'wet-shore');
    coastDist = -1.2;
    assert.equal(IsometricRenderer.prototype._trailSurfaceAt.call(renderer, 10, 20), 'sand');
    coastDist = 1.5;
    assert.equal(IsometricRenderer.prototype._trailSurfaceAt.call(renderer, 10, 20), 'sand');
    assert.equal(coastCalls, 4);

    for (const landClass of [GROUND_CLASS.GRASS, GROUND_CLASS.DIRT, GROUND_CLASS.ROAD, GROUND_CLASS.PLAZA, GROUND_CLASS.NONE]) {
        clsValue = landClass;
        assert.equal(IsometricRenderer.prototype._trailSurfaceAt.call(renderer, 10, 20), 'land');
    }
});

test('W3 Integration: _admitFrameReportCairns handles retained squads, outstanding-only leads, DIRECTIONS, trims alignment, and view/door caps', () => {
    const gov = new MarkGovernor();
    gov.beginFrame({ regionSize: 200 });
    const commandDoor = { type: 'command', entrance: { tileX: 15, tileY: 19 }, position: { tileX: 15, tileY: 16 }, width: 4, height: 4 };
    const forgeDoor = { type: 'forge', entrance: { tileX: 25, tileY: 30 }, position: { tileX: 24, tileY: 27 }, width: 4, height: 4 };
    const archiveDoor = { type: 'archive', entrance: { tileX: 9, tileY: 17 }, position: { tileX: 8, tileY: 14 }, width: 4, height: 4 };
    const harborDoor = { type: 'harbor', entrance: { tileX: 28, tileY: 20 }, position: { tileX: 28, tileY: 18 }, width: 4, height: 4 };
    const buildings = new Map([
        ['command', commandDoor],
        ['forge', forgeDoor],
        ['archive', archiveDoor],
        ['harbor', harborDoor],
    ]);

    // 1. Lead with 2 returned (null trim at idx 0, green trim at idx 1) + 1 outstanding child,
    //    facing west (DIRECTIONS[6] === 'w') -> trailing cairn sits east (+17..+22).
    const leadAgent = { id: 'lead-main', status: AgentStatus.WORKING };
    const child0 = { id: 'c0', parentSessionId: 'lead-main', status: AgentStatus.COMPLETED };
    const child1 = { id: 'c1', parentSessionId: 'lead-main', status: AgentStatus.COMPLETED };
    const child2 = { id: 'c2', parentSessionId: 'lead-main', status: AgentStatus.WORKING };
    const cmdPos = tileToWorld(15, 19);
    const leadSprite = {
        agent: leadAgent,
        x: cmdPos.x,
        y: cmdPos.y,
        direction: DIRECTIONS.indexOf('w'),
        moving: false,
        _cairnSpec: { stale: true },
    };
    const c0Sprite = { agent: child0, x: cmdPos.x + 40, y: cmdPos.y, moving: false, _providerTrimColor: () => null };
    const c1Sprite = { agent: child1, x: cmdPos.x + 60, y: cmdPos.y, moving: false, _providerTrimColor: () => '#4ade80' };
    const c2Sprite = { agent: child2, x: cmdPos.x + 80, y: cmdPos.y, moving: false };

    // 2. Lead whose only child already departed (retained in RelationshipState._returnedByParent, no live child).
    const world = new World();
    const retainedLead = { id: 'lead-retained', status: AgentStatus.IDLE };
    const departedChild = { id: 'c-departed', parentSessionId: 'lead-retained', status: AgentStatus.COMPLETED };
    world.agents.set(leadAgent.id, leadAgent);
    world.agents.set(child0.id, child0);
    world.agents.set(child1.id, child1);
    world.agents.set(child2.id, child2);
    world.agents.set(retainedLead.id, retainedLead);
    world.agents.set(departedChild.id, departedChild);
    const relationshipState = new RelationshipState(world);
    try {
        world.agents.delete(departedChild.id);
        eventBus.emit('agent:removed', departedChild);
        relationshipState.reconcile({ agentSprites: new Map(), now: 1000 });

        const forgePos = tileToWorld(25, 30);
        const retainedSprite = {
            agent: retainedLead,
            x: forgePos.x,
            y: forgePos.y,
            direction: DIRECTIONS.indexOf('e'),
            moving: false,
            hasLiveSubagents: () => false,
        };

        // 3. Lead with outstanding-only child (0 returned, 1 out).
        const outOnlyLead = { id: 'lead-out-only', status: AgentStatus.WORKING };
        const outChild = { id: 'c-out', parentSessionId: 'lead-out-only', status: AgentStatus.WORKING };
        world.agents.set(outOnlyLead.id, outOnlyLead);
        world.agents.set(outChild.id, outChild);
        const archPos = tileToWorld(9, 17);
        const outOnlySprite = {
            agent: outOnlyLead,
            x: archPos.x,
            y: archPos.y,
            direction: DIRECTIONS.indexOf('e'),
            moving: false,
        };

        const renderer = makeWave3Renderer({
            world: { buildings, agents: world.agents },
            agentSprites: new Map([
                [leadAgent.id, leadSprite],
                [child0.id, c0Sprite],
                [child1.id, c1Sprite],
                [child2.id, c2Sprite],
                [retainedLead.id, retainedSprite],
                [outOnlyLead.id, outOnlySprite],
            ]),
            relationshipState,
            markGovernor: gov,
        });

        const admitted = IsometricRenderer.prototype._admitFrameReportCairns.call(
            renderer,
            [leadSprite, retainedSprite, outOnlySprite],
            2,
        );
        assert.equal(admitted.length, 3);

        // Index-aligned returnedTrims: unit 0 gets gold fallback, unit 1 keeps '#4ade80', unit 2 is outstanding.
        assert.equal(leadSprite._cairnSpec.returned, 2);
        assert.equal(leadSprite._cairnSpec.outstanding, 1);
        assert.equal(leadSprite._cairnSpec.units[0].trim, ART_RAMPS.trimGold[1]);
        assert.equal(leadSprite._cairnSpec.units[1].trim, '#4ade80');
        assert.equal(leadSprite._cairnSpec.units[2].state, 'outstanding');
        // West-facing (DIRECTIONS[6]) trailing slot is east of footX (+17..+22).
        assert.equal(leadSprite._cairnSpec.rect.x, Math.round(cmdPos.x + 17));

        // Retained departed child keeps its cairn even when hasLiveSubagents() is false.
        assert.equal(retainedSprite._cairnSpec.returned, 1);
        assert.equal(retainedSprite._cairnSpec.outstanding, 0);
        assert.equal(retainedSprite._cairnSpec.label, '1 back');
        // East-facing (DIRECTIONS[2]) trailing slot is west of footX (-22..-17).
        assert.equal(retainedSprite._cairnSpec.rect.x, Math.round(forgePos.x - 22));

        // Outstanding-only lead gets its cairn.
        assert.equal(outOnlySprite._cairnSpec.returned, 0);
        assert.equal(outOnlySprite._cairnSpec.outstanding, 1);
        assert.equal(outOnlySprite._cairnSpec.label, '1 out');

        // Below ARTIFACT_MIN_ZOOM (1.6) clears all cairn specs cleanly.
        IsometricRenderer.prototype._admitFrameReportCairns.call(
            renderer,
            [leadSprite, retainedSprite, outOnlySprite],
            1.5,
        );
        assert.equal(leadSprite._cairnSpec, null);
        assert.equal(retainedSprite._cairnSpec, null);
        assert.equal(outOnlySprite._cairnSpec, null);
    } finally {
        relationshipState.dispose();
    }

    // 4. Enforce CAIRN_DOOR_ZONE_CAP = 2 per nearest building entrance AND CAIRN_VIEW_CAP = 6 overall.
    gov.beginFrame({ regionSize: 200 });
    const capAgents = new Map();
    const capSprites = [];
    const doorCoords = [
        tileToWorld(15, 19), // command (3 leads -> max 2 admitted)
        tileToWorld(25, 30), // forge   (2 leads -> 2 admitted)
        tileToWorld(9, 17),  // archive (2 leads -> 2 admitted -> hits view cap 6)
        tileToWorld(28, 20), // harbor  (1 lead  -> rejected by view cap 6)
    ];
    const layout = [
        { id: 'cmd-1', pos: doorCoords[0], dx: 0 },
        { id: 'cmd-2', pos: doorCoords[0], dx: 40 },
        { id: 'cmd-3', pos: doorCoords[0], dx: 80 },
        { id: 'forge-1', pos: doorCoords[1], dx: 0 },
        { id: 'forge-2', pos: doorCoords[1], dx: 40 },
        { id: 'arch-1', pos: doorCoords[2], dx: 0 },
        { id: 'arch-2', pos: doorCoords[2], dx: 40 },
        { id: 'harbor-1', pos: doorCoords[3], dx: 0 },
    ];
    for (const item of layout) {
        const parent = { id: item.id, status: AgentStatus.WORKING };
        const child = { id: `${item.id}-child`, parentSessionId: item.id, status: AgentStatus.COMPLETED };
        capAgents.set(parent.id, parent);
        capAgents.set(child.id, child);
        capSprites.push({
            agent: parent,
            x: item.pos.x + item.dx,
            y: item.pos.y,
            direction: DIRECTIONS.indexOf('e'),
            moving: false,
        });
    }
    const capRenderer = makeWave3Renderer({
        world: { buildings, agents: capAgents },
        agentSprites: new Map(capSprites.map(s => [s.agent.id, s])),
        markGovernor: gov,
    });
    const capped = IsometricRenderer.prototype._admitFrameReportCairns.call(capRenderer, capSprites, 2);
    assert.equal(CAIRN_DOOR_ZONE_CAP, 2);
    assert.equal(CAIRN_VIEW_CAP, 6);
    assert.equal(capped.length, CAIRN_VIEW_CAP);
    assert.ok(capSprites[0]._cairnSpec, 'cmd-1 admitted');
    assert.ok(capSprites[1]._cairnSpec, 'cmd-2 admitted');
    assert.equal(capSprites[2]._cairnSpec, null, 'cmd-3 blocked by CAIRN_DOOR_ZONE_CAP = 2');
    assert.ok(capSprites[3]._cairnSpec, 'forge-1 admitted');
    assert.ok(capSprites[4]._cairnSpec, 'forge-2 admitted');
    assert.ok(capSprites[5]._cairnSpec, 'arch-1 admitted');
    assert.ok(capSprites[6]._cairnSpec, 'arch-2 admitted');
    assert.equal(capSprites[7]._cairnSpec, null, 'harbor-1 blocked by CAIRN_VIEW_CAP = 6');
});

test('W3 Integration: _syncWave3LiveSystems wires mendLedger brokenProof notches, casualStroll suppression, workflowRibbon, clock/grade, and live ally nod', () => {
    const now = 1_764_121_000_000;
    const mends = new MendLedger();
    for (let i = 0; i < 3; i++) {
        mends.observe({
            id: `fail-${i}`,
            agentId: 'broken-1',
            project: '/repo/demo',
            tool: 'Bash',
            detail: 'npm test',
            exitCode: 1,
            exitCodeSource: 'exit',
            completedAt: now - (3 - i) * 1000,
        });
    }

    const brokenAgent = {
        id: 'broken-1',
        name: 'Alpha',
        provider: 'claude',
        projectPath: '/repo/demo',
        status: AgentStatus.WORKING,
        workflowId: 'wf-alpha',
        workflowName: 'Audit Wave 3',
        parentSessionId: 'lead-1',
        lastResults: [{ exitCode: 1, exitCodeSource: 'exit', completedAt: now - 500 }],
    };
    const strollerAgent = {
        id: 'stroll-1',
        name: 'Beta',
        provider: 'codex',
        projectPath: '/repo/demo',
        status: AgentStatus.WORKING,
        currentTool: 'Edit',
    };
    const idleWalkerAgent = {
        id: 'idle-walk-1',
        name: 'Gamma',
        provider: 'gemini',
        projectPath: '/repo/demo',
        status: AgentStatus.IDLE,
        currentTool: 'Edit',
    };

    const nodTimes = { broken: [], stroller: [] };
    const brokenSprite = {
        agent: brokenAgent,
        x: 100,
        y: 100,
        moving: true,
        selected: false,
        visitRole: 'work',
        triggerAllyNod(t) { nodTimes.broken.push(t); },
    };
    const strollerSprite = {
        agent: strollerAgent,
        x: 112,
        y: 100,
        moving: false,
        selected: false,
        visitRole: 'stroll',
        triggerAllyNod(t) { nodTimes.stroller.push(t); },
    };
    const idleWalkerSprite = {
        agent: idleWalkerAgent,
        x: 500,
        y: 500,
        moving: true,
        selected: false,
        visitRole: null,
        triggerAllyNod() { throw new Error('distant sprite must not nod'); },
    };

    const keyBroken = AgentBiography.identityKeyFor(brokenAgent);
    const keyStroller = AgentBiography.identityKeyFor(strollerAgent);
    const affinityQueries = [];
    const renderer = makeWave3Renderer({
        _motionClock: { elapsedMs: 12_345 },
        _lastAtmosphere: { weather: { type: 'rain', precipitation: 0.4 }, lightGrade: { cacheKey: 'dusk-grade' } },
        agentSprites: new Map([
            [brokenAgent.id, brokenSprite],
            [strollerAgent.id, strollerSprite],
            [idleWalkerAgent.id, idleWalkerSprite],
        ]),
        agentEventStream: { _mends: mends },
        _allyNodCooldowns: new Map([['expired|pair', now - 1]]),
        affinityService: {
            collaboratorsFor(key, at) {
                affinityQueries.push({ key, at });
                if (key === keyBroken) return [{ identityKey: keyStroller, tier: 'allies' }];
                return [];
            },
        },
    });

    IsometricRenderer.prototype._syncWave3LiveSystems.call(
        renderer,
        [brokenAgent, strollerAgent, idleWalkerAgent],
        [brokenSprite, strollerSprite, idleWalkerSprite],
        now,
    );

    // 3-failure streak produces 3-notch brokenProof; casualStroll & idleWalk suppress artifacts.
    assert.deepEqual(brokenSprite.carriedArtifact, { kind: 'brokenProof', notches: 3 });
    assert.equal(strollerSprite.carriedArtifact, null, 'casualStroll suppresses carried artifact');
    assert.equal(idleWalkerSprite.carriedArtifact, null, 'idleWalk suppresses carried artifact');

    // workflowRibbon wired from _workflowRibbons.byAgentId (null when not in a workflow).
    assert.ok(brokenSprite.workflowRibbon);
    assert.equal(brokenSprite.workflowRibbon.key, 'wf-alpha');
    assert.equal(brokenSprite.workflowRibbon.slot, 0);
    assert.equal(strollerSprite.workflowRibbon, null);

    // Deterministic clock & lightGrade propagation onto live sprites.
    assert.equal(brokenSprite._motionTimeMs, 12_345);
    assert.deepEqual(brokenSprite.overlayLightGrade, { cacheKey: 'dusk-grade' });
    assert.equal(brokenSprite._weather.type, 'rain');

    // Expired cooldown pruned; live affinity queried ONLY for nearby pair and nods triggered on motionTimeMs.
    assert.equal(renderer._allyNodCooldowns.has('expired|pair'), false);
    assert.equal(affinityQueries.length, 1);
    assert.equal(affinityQueries[0].key, keyBroken);
    assert.deepEqual(nodTimes.broken, [12_345]);
    assert.deepEqual(nodTimes.stroller, [12_345]);
});

test('W3 Integration: _cachePatina deterministically keeps 50-sit rune over 1-sit claim, invalidates back prop cache, and reload baseline avoids double-counting sits', () => {
    const seat = REST_SEATS.find(s => s.occluder === 'tavern');
    assert.ok(seat, 'tavern seat exists');
    let invalidations = 0;
    const backProp = { invalidateCache() { invalidations += 1; } };
    const renderer = makeWave3Renderer({
        _restSeatBackProps: new Map([[seat.id, backProp]]),
    });

    const bio50 = { extensions: { seats: { [seat.id]: 50 }, seatRepoColors: { [seat.id]: 4 } } };
    const bio1 = { extensions: { seats: { [seat.id]: 1 }, seatRepoColors: { [seat.id]: 2 } } };

    // 50-sit rune first -> invalidates cache once.
    IsometricRenderer.prototype._cachePatina.call(renderer, 'id:veteran', bio50);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).rune, true);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).sits, 50);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).repoColorIndex, 4);
    assert.equal(invalidations, 1);

    // Competing 1-sit claim arrives later -> MUST NOT overwrite 50-sit rune or spuriously invalidate.
    IsometricRenderer.prototype._cachePatina.call(renderer, 'id:newcomer', bio1);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).rune, true);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).sits, 50);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).repoColorIndex, 4);
    assert.equal(invalidations, 1);

    // Dropping the 50-sit claim resolves back to the 1-sit newcomer and invalidates cache.
    IsometricRenderer.prototype._cachePatina.call(renderer, 'id:veteran', null);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).rune, false);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).sits, 1);
    assert.equal(invalidations, 2);

    // Reverse order (1-sit already present, then 50-sit arrives) upgrades deterministically and invalidates.
    IsometricRenderer.prototype._cachePatina.call(renderer, 'id:veteran', bio50);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).rune, true);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).sits, 50);
    assert.equal(invalidations, 3);

    // Equal tier & equal sits break deterministically by lexicographic identityKey.
    const bio50Alt = { extensions: { seats: { [seat.id]: 50 }, seatRepoColors: { [seat.id]: 1 } } };
    IsometricRenderer.prototype._cachePatina.call(renderer, 'id:alpha', bio50Alt);
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).repoColorIndex, 1, 'id:alpha < id:veteran wins tie');
    assert.equal(invalidations, 4);

    // Pruning over NICKNAME_CACHE_LIMIT drops non-live patina & bench claims and invalidates changed seat.
    const liveAgent = { id: 'live-1', name: 'Live', provider: 'claude' };
    const liveKey = AgentBiography.identityKeyFor(liveAgent);
    renderer.agentSprites = new Map([[liveAgent.id, { agent: liveAgent }]]);
    IsometricRenderer.prototype._cachePatina.call(renderer, liveKey, bio1);
    for (let i = 0; i < 260; i++) {
        renderer._patinaByIdentity.set(`stale:${i}`, { mendedStitches: 1, saltCuff: false, theirBench: { seatId: null, sits: 0, hollow: false, rune: false, repoColorIndex: 0 } });
        renderer._benchClaimsByIdentity.set(`stale:${i}`, { seatId: seat.id, sits: 1, hollow: false, rune: false, repoColorIndex: 0 });
    }
    IsometricRenderer.prototype._pruneNicknameCache.call(renderer);
    assert.ok(renderer._patinaByIdentity.size <= 256);
    assert.ok(renderer._benchClaimsByIdentity.size <= 256);
    assert.equal(renderer._patinaByIdentity.has(liveKey), true, 'live identity retained');
    assert.equal(renderer._benchClaimsByIdentity.has('id:alpha'), false, 'oldest non-live bench claim evicted');
    assert.equal(renderer._benchPatinaBySeat.get(seat.id).rune, false, 'seat patina rebuilt after eviction');
    assert.equal(invalidations, 5);

    // Reload baseline guard + repoProfile().pennantIndex on genuine sit transitions.
    const seatObservations = [];
    const sitterAgent = { id: 'sitter-1', projectPath: '/repo/bench-alpha', status: AgentStatus.IDLE };
    let currentSeat = seat;
    const sitterSprite = {
        agent: sitterAgent,
        x: 50,
        y: 50,
        moving: false,
        _seatedSeat: () => currentSeat,
    };
    const sitRenderer = makeWave3Renderer({
        agentSprites: new Map([[sitterAgent.id, sitterSprite]]),
        biographyService: {
            observeRestSeat(agent, seatId, repoColorIndex) {
                seatObservations.push({ agentId: agent.id, seatId, repoColorIndex });
            },
        },
    });

    // Tick 1: already seated at reload -> baseline recorded, observeRestSeat NOT called.
    IsometricRenderer.prototype._syncWave3LiveSystems.call(sitRenderer, [sitterAgent], [sitterSprite], 10_000);
    assert.equal(seatObservations.length, 0);
    assert.equal(sitRenderer._seatedSeatByAgent.get(sitterAgent.id), seat.id);

    // Tick 2: stands up -> observeRestSeat(agent, null, pennantIndex).
    currentSeat = null;
    IsometricRenderer.prototype._syncWave3LiveSystems.call(sitRenderer, [sitterAgent], [sitterSprite], 11_000);
    assert.equal(seatObservations.length, 1);
    assert.equal(seatObservations[0].seatId, null);

    // Tick 3: sits down again -> observeRestSeat(agent, seat.id, repoProfile.pennantIndex).
    currentSeat = seat;
    const expectedPennant = repoProfile(sitterAgent.projectPath).pennantIndex;
    IsometricRenderer.prototype._syncWave3LiveSystems.call(sitRenderer, [sitterAgent], [sitterSprite], 12_000);
    assert.equal(seatObservations.length, 2);
    assert.deepEqual(seatObservations[1], {
        agentId: sitterAgent.id,
        seatId: seat.id,
        repoColorIndex: expectedPennant,
    });
});
