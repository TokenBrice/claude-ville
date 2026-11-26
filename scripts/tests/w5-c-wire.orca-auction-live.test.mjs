import test from 'node:test';
import assert from 'node:assert/strict';

import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { DIRECTIONS } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import VisitTileAllocator, { FIXTURE_FEET } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';
import {
    ORCA_AGENT_RADIUS,
    ORCA_SWING_RADIUS,
    ORCA_TAU,
    ORCA_Y_SCALE,
} from '../../claudeville/src/presentation/character-mode/CrowdOrca.js';
import {
    OVERLAY_GRID_CELL,
    OVERLAY_LAYER_ATTENTION,
    OVERLAY_LAYER_PLAQUE,
    OverlayOccupancyGrid,
} from '../../claudeville/src/presentation/character-mode/SlotAuction.js';
import {
    attentionScreenRects,
    layoutAttentionPlates,
} from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';
import { InspectionGlass } from '../../claudeville/src/presentation/character-mode/InspectionGlass.js';
import { MarkGovernor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

function createOrcaHost({ isWalkable = null, disableStaticFixtures = true } = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.agentSprites = new Map();
    renderer.gateTransits = new Map();
    renderer._laneTiles = new Map();
    renderer._movingSprites = [];
    renderer._disableStaticOrcaFixtures = disableStaticFixtures;
    renderer._markSpritesDirty = () => {};
    renderer._isSpritePositionWalkable = isWalkable
        ? (sprite, x, y) => isWalkable(sprite, x, y)
        : () => true;
    renderer._isSpriteStandable = (sprite, x, y) => renderer._isSpritePositionWalkable(sprite, x, y);
    renderer._isGateTransit = () => false;
    renderer._isGateChannelTransit = () => false;
    renderer._localAvoidanceMetrics = {
        laneCorrections: 0,
        separationPushes: 0,
        zeroDistancePairs: 0,
        progressClamps: 0,
        orcaFrames: 0,
        orcaLines: 0,
        strideAdjustments: 0,
        walkClamps: 0,
        waypointAdvances: 0,
    };
    return renderer;
}

function makeCircleAgents(count, radius, speed = 55) {
    const sprites = [];
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        sprites.push({
            agent: { id: `orca-${String(i).padStart(3, '0')}` },
            x,
            y,
            targetX: -x,
            targetY: -y,
            moving: true,
            chatting: false,
            gaitSpeed: speed,
            radius: ORCA_AGENT_RADIUS,
            surfaceTier: 0,
            _followGap: false,
            _followYield: false,
        });
    }
    return sprites;
}

function makeMockSpeaker(id, x, y, text, { selected = false, hovered = false, displayUntil = 10_000 } = {}) {
    const thread = [{ text, kind: 'tool', ts: displayUntil }];
    return {
        agent: {
            id,
            name: id,
            displayName: id,
            status: AgentStatus.WORKING,
        },
        x,
        y,
        selected,
        hovered,
        _dialogueDisplayUntil: displayUntil,
        _thoughtAnchorX: x,
        _activityThread: () => thread,
        _shouldUseLongWaitClock: () => false,
        thoughtRepoAccent: () => false,
        thoughtSpeakerTag: () => id.slice(0, 3).toUpperCase(),
        _headTopY: () => y - 42,
        _labelTopY: (top) => top - 6,
    };
}

function makeOverlayHost({ width = 1280, height = 720, zoom = 1 } = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.camera = {
        zoom,
        worldToScreen: (wx, wy) => ({ x: wx * zoom + width * 0.5, y: wy * zoom + height * 0.5 }),
        screenToWorld: (sx, sy) => ({ x: (sx - width * 0.5) / zoom, y: (sy - height * 0.5) / zoom }),
    };
    renderer._screenViewport = () => ({ width, height });
    renderer.agentSprites = new Map();
    renderer.markGovernor = new MarkGovernor();
    renderer.getReadMode = () => false;
    renderer.theatreMode = false;
    renderer._overlayPrioritizedSprites = [];
    renderer._overlayBubbleSprites = [];
    renderer._overlayBubbleOrder = [];
    renderer._overlayBubbleBaseRects = [];
    renderer._overlayBubbleClusters = [];
    renderer._overlayBubbleClusterCount = 0;
    renderer._overlayBubbleGroups = new Map();
    renderer._overlayRegionCounts = new Map();
    renderer._attentionWorldRects = [];
    renderer._overlayNameRects = [];
    renderer._overlayReservedRects = [];
    renderer._overlayBubbleOccupiedRects = [];
    renderer._overlayNameGrid = renderer._createRectGrid();
    renderer._overlayBubbleGrid = renderer._createRectGrid();
    renderer._overlayClusterGrid = renderer._createRectGrid();
    renderer._agentVisibleOnScreen = () => true;
    renderer._noteLabelToolChange = () => {};
    renderer._agentLabelPriority = (sp) => (sp.selected ? 1000 : sp.hovered ? 500 : 10);
    renderer._spriteWantsBubble = (sp) => Boolean(sp._activityThread?.().length);
    renderer._bubbleMergeKey = (sp) => sp._activityThread?.()?.[0]?.text || null;
    renderer._foldRoutineClusterNames = () => {};
    return renderer;
}

function rectsOverlapStrict(a, b) {
    const al = a.left !== undefined ? a.left : a.x;
    const at = a.top !== undefined ? a.top : a.y;
    const ar = a.right !== undefined ? a.right : (al + a.w);
    const ab = a.bottom !== undefined ? a.bottom : (at + a.h);
    const bl = b.left !== undefined ? b.left : b.x;
    const bt = b.top !== undefined ? b.top : b.y;
    const br = b.right !== undefined ? b.right : (bl + b.w);
    const bb = b.bottom !== undefined ? b.bottom : (bt + b.h);
    return al < br && ar > bl && at < bb && ab > bt;
}

// ---------------------------------------------------------------------------
// 1. Live 2D ORCA Crowd Solver through IsometricRenderer
// ---------------------------------------------------------------------------

test('W5-C live ORCA: 24-agent and 100-agent dense swarms have 0 stacks < 3px, 0 stalls > 1.5s, and zero pool churn', () => {
    // Perimeter spacing clears 2*ORCA_AGENT_RADIUS / ORCA_Y_SCALE = 35.94 px
    // (R >= N * 36 / (2*pi): 24 -> 180, 100 -> 600).
    for (const [count, radius, maxSteps] of [[24, 180, 360], [100, 600, 920]]) {
        const renderer = createOrcaHost({ disableStaticFixtures: true });
        const sprites = makeCircleAgents(count, radius, 56);
        const dtMs = 50;
        const dtSec = dtMs / 1000;
        const stallTime = new Float64Array(count);
        let maxStall = 0;
        let stacksUnder3px = 0;

        // Warm frame 1 so pool reaches steady-state capacity for `count`.
        renderer._applyLocalAvoidance(sprites, dtMs);
        const pools = renderer._orcaPools;
        const steadyCapacity = pools.pool.length;
        const initialRefs = pools.pool.slice(0, count);

        for (let step = 0; step < maxSteps; step++) {
            renderer._applyLocalAvoidance(sprites, dtMs);

            // Zero per-frame descriptor reallocation check.
            assert.equal(pools.pool.length, steadyCapacity, `${count}-agent pool must not grow in steady state`);
            for (let i = 0; i < count; i++) {
                assert.equal(pools.pool[i], initialRefs[i], 'descriptor reference must be reused across frames');
            }

            let remaining = 0;
            for (let i = 0; i < count; i++) {
                const a = sprites[i];
                const distGoal = Math.hypot(a.targetX - a.x, a.targetY - a.y);
                if (distGoal > 4) remaining++;
                if (distGoal > 12) {
                    const spd = Math.hypot(a._orcaVx || 0, a._orcaVy || 0);
                    if (spd < 2.0) {
                        stallTime[i] += dtSec;
                        if (stallTime[i] > maxStall) maxStall = stallTime[i];
                    } else {
                        stallTime[i] = 0;
                    }
                }
                for (let j = i + 1; j < count; j++) {
                    const b = sprites[j];
                    const d = Math.hypot(a.x - b.x, a.y - b.y);
                    if (d < 3.0) stacksUnder3px++;
                }
            }
            if (remaining === 0) break;
        }

        let arrived = 0;
        for (let i = 0; i < count; i++) {
            if (Math.hypot(sprites[i].targetX - sprites[i].x, sprites[i].targetY - sprites[i].y) <= 10) {
                arrived++;
            }
        }

        const diag = renderer.getDiagnostics();
        assert.equal(stacksUnder3px, 0, `${count}-agent live ORCA must have 0 stacks < 3px`);
        assert.ok(maxStall <= 1.5, `${count}-agent live ORCA max stall ${maxStall.toFixed(2)}s must stay <= 1.5s`);
        assert.equal(arrived, count, `${count}-agent swarm must reach targets cleanly (${arrived}/${count})`);
        assert.equal(diag.orca.tau, ORCA_TAU);
        assert.equal(diag.orca.yScale, ORCA_Y_SCALE);
        assert.ok(diag.orca.frames >= 2);
        assert.ok(diag.orca.totalLines > 0);
        assert.equal(diag.orca.poolCapacity, steadyCapacity);
    }
});

test('W5-C live ORCA preserves V7 stride lock, walkability boundaries, planted immobility, strike arcs, wildlife discs, and surfaceTier', () => {
    // Unwalkable water channel at y > 40 (walkable only for y <= 40).
    const waterLineY = 40;
    const renderer = createOrcaHost({
        disableStaticFixtures: false,
        isWalkable: (_sprite, _x, y) => y <= waterLineY,
    });

    // Planted villager sitting near the shore edge (must never move).
    const planted = {
        agent: { id: 'planted-1' },
        x: 60,
        y: 25,
        moving: false,
        planted: true,
        surfaceTier: 0,
        _poseCell: { source: 'strip', group: 'strike' },
        direction: 'west',
        swingRadius: ORCA_SWING_RADIUS,
    };
    renderer.agentSprites.set('planted-1', planted);

    // Live wildlife pose right in front of the corridor.
    renderer.wildlifeRenderer = {
        _livestockPoses: [
            { route: 'pasture', alpha: 1, x: 110, y: 12 },
        ],
        _deerPose: null,
    };

    // Walker with V7 stride lock (`steeredPosition`) walking east along y = 25.
    const strideLen = 1.5;
    const walker = {
        agent: { id: 'walker-v7' },
        x: 10,
        y: 25,
        targetX: 180,
        targetY: 25,
        moving: true,
        _gaitSpeed: 1.5,
        _stepStartX: 8.5,
        _stepStartY: 25,
        _stepLength: strideLen,
        surfaceTier: 0,
        steeredPosition(nx, ny) {
            const dx = nx - this._stepStartX;
            const dy = ny - this._stepStartY;
            const d = Math.hypot(dx, dy);
            if (!(d > 1e-6)) return null;
            return {
                x: this._stepStartX + (dx / d) * this._stepLength,
                y: this._stepStartY + (dy / d) * this._stepLength,
            };
        },
    };

    // Wave 6 E2 tier-2 elevated walker directly over planted tier-0 villager: zero deflection.
    const tier2Walker = {
        agent: { id: 'tier2-bridge' },
        x: 56,
        y: 25,
        targetX: 160,
        targetY: 25,
        moving: true,
        gaitSpeed: 60,
        surfaceTier: 2,
    };

    renderer.agentSprites.set('walker-v7', walker);
    renderer.agentSprites.set('tier2-bridge', tier2Walker);

    for (let step = 0; step < 90; step++) {
        // Simulate AgentSprite's V7 stride origin update each tick.
        walker._stepStartX = walker.x;
        walker._stepStartY = walker.y;
        const dx = walker.targetX - walker.x;
        const dy = walker.targetY - walker.y;
        const dist = Math.hypot(dx, dy);
        if (dist > strideLen) {
            walker.x += (dx / dist) * strideLen;
            walker.y += (dy / dist) * strideLen;
        }

        renderer._applyLocalAvoidance([walker, tier2Walker], 16.67);

        // V7 stride length strictly preserved (or clamped to start if blocked).
        const actualStep = Math.hypot(walker.x - walker._stepStartX, walker.y - walker._stepStartY);
        assert.ok(
            actualStep < 1e-6 || Math.abs(actualStep - strideLen) < 1e-6,
            `V7 stride must stay exact (${actualStep} vs ${strideLen})`,
        );

        // Water boundary strictly respected: never steps into y > 40.
        assert.ok(walker.y <= waterLineY + 1e-6, `walker stepped into water y=${walker.y}`);
        assert.ok(tier2Walker.y <= waterLineY + 1e-6, `tier2Walker stepped into water y=${tier2Walker.y}`);

        // Planted body never moves or acquires velocity.
        assert.equal(planted.x, 60);
        assert.equal(planted.y, 25);
        assert.equal(planted._orcaVx, 0);
        assert.equal(planted._orcaVy, 0);
    }

    // Tier-2 bridge walker crossed straight over tier-0 planted body without tier-0 deflection
    // (compare against solo reference on tier 2: zero delta!).
    const refRenderer = createOrcaHost({
        disableStaticFixtures: false,
        isWalkable: (_sprite, _x, y) => y <= waterLineY,
    });
    const tier2Ref = {
        agent: { id: 'tier2-bridge' },
        x: 56,
        y: 25,
        targetX: 160,
        targetY: 25,
        moving: true,
        gaitSpeed: 60,
        surfaceTier: 2,
    };
    refRenderer.agentSprites.set('tier2-bridge', tier2Ref);
    for (let step = 0; step < 90; step++) {
        refRenderer._applyLocalAvoidance([tier2Ref], 16.67);
    }
    assert.ok(
        Math.hypot(tier2Walker.x - tier2Ref.x, tier2Walker.y - tier2Ref.y) < 1e-6,
        `tier2 walker must match solo trajectory identically (delta=${Math.hypot(tier2Walker.x - tier2Ref.x, tier2Walker.y - tier2Ref.y)})`,
    );

    // Live wildlife pose is included in ORCA obstacles (road-edge FIXTURE_FEET
    // restrict standing places only, so walkers pass lanterns/stalls/bridge
    // posts freely), plus the active strike swing arc is counted.
    const diag = renderer.getCrowdOrcaDiagnostics();
    assert.equal(diag.obstacles, 1);
    assert.equal(diag.swingArcs, 1);
});

test('W5-C ORCA never rewinds a walking sprite or shoves it backwards on wall edges / narrow bridges', () => {
    const renderer = createOrcaHost({
        isWalkable: (_sprite, x, y) => Math.abs(y) <= 6 && x >= 0,
    });

    const walker = {
        agent: { id: 'bridge-walker' },
        x: 3.5,
        y: 0,
        targetX: 80,
        targetY: 0,
        moving: true,
        chatting: false,
        gaitSpeed: 45,
        radius: ORCA_AGENT_RADIUS,
        surfaceTier: 0,
        _stepStartX: -1,
        _stepStartY: 0,
        _stepLength: 4.5,
        steeredPosition(px, py) {
            const dx = px - this._stepStartX;
            const dy = py - this._stepStartY;
            const len = Math.hypot(dx, dy);
            if (!(len > 1e-6)) return null;
            const s = this._stepLength / len;
            return { x: this._stepStartX + dx * s, y: this._stepStartY + dy * s };
        },
    };

    const blocker = {
        agent: { id: 'bridge-planted' },
        x: 8,
        y: 0,
        targetX: 8,
        targetY: 0,
        moving: false,
        planted: true,
        radius: ORCA_AGENT_RADIUS,
        surfaceTier: 0,
    };
    renderer.agentSprites.set(walker.agent.id, walker);
    renderer.agentSprites.set(blocker.agent.id, blocker);

    renderer._applyLocalAvoidance([walker], 16.67);

    // Must make forward progress along the bridge (never rewound to -1 or pushed backwards!)
    assert.ok(walker.x > 0, `walker must advance forward off wall/bridge edge, got x=${walker.x}`);
    assert.ok(Math.hypot(walker.x - (-1), walker.y - 0) >= 4.4, 'walker must preserve its stride length');
});

// ---------------------------------------------------------------------------
// 2. Glass 300ms Dwell Cutaway Hook & W5-A substrateRevision
// ---------------------------------------------------------------------------

test('W5-C Glass 300ms dwell cutaway forwards target to buildingRenderer.setGlassCutawayTarget and clears on exit', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    const glass = new InspectionGlass({ enabled: true });
    glass.isActive = () => glass.enabled;
    glass.getCenter = () => ({ x: 400, y: 300 });
    renderer.inspectionGlass = glass;
    renderer.camera = { zoom: 2.5, screenToWorld: (x, y) => ({ x, y }) };

    const targetLog = [];
    let hoveredBuilding = { type: 'forge' };
    renderer.buildingRenderer = {
        _selectedBuildingType: null,
        _zoom: 2.5,
        hitTest: () => hoveredBuilding,
        supportsCutaway: (type) => type === 'forge' || type === 'harbor',
        getApertureModel: () => null,
        _updateInspection: () => {},
        setGlassCutawayTarget: (buildingType, opts) => {
            targetLog.push({ buildingType, opts });
        },
    };

    // Frame 1 (t = 1000): starts dwell timer — cutaway not open yet.
    renderer._updateGlassCutaway(1000);
    assert.equal(targetLog.at(-1).buildingType, null);
    assert.equal(targetLog.at(-1).opts?.resolved, true);

    // Frame 2 (t = 1250, 250 ms < 300 ms): still dwelling.
    renderer._updateGlassCutaway(1250);
    assert.equal(targetLog.at(-1).buildingType, null);

    // Frame 3 (t = 1350, 350 ms >= 300 ms): dwell reached -> triggers 'forge'.
    renderer._updateGlassCutaway(1350);
    assert.equal(targetLog.at(-1).buildingType, 'forge');
    assert.equal(targetLog.at(-1).opts?.resolved, true);

    // Frame 4 (t = 1500, glass disabled): cleanly clears target to null.
    glass.setEnabled(false);
    renderer._updateGlassCutaway(1500);
    assert.equal(targetLog.at(-1).buildingType, null);

    // W5-A coordination check: `_persistedTerrainInputs` safely exposes `substrateRevision`.
    renderer._lastAtmosphere = null;
    renderer.atmosphereState = null;
    renderer._groundState = null;
    renderer.assets = { assetVersion: 'test' };
    assert.equal(renderer._persistedTerrainInputs({ x: 0, y: 0 }, 1, 'spring').substrateRevision, 0);
    renderer.gpuWorld = { substrateRevision: 7 };
    assert.equal(renderer._persistedTerrainInputs({ x: 0, y: 0 }, 1, 'spring').substrateRevision, 7);
});

// ---------------------------------------------------------------------------
// 3. VisitTileAllocator Hungarian (<= 12) & ε-Auction (> 12) + 15% Hysteresis + Squads
// ---------------------------------------------------------------------------

test('W5-C VisitTileAllocator batch Hungarian picks min canal-aware flow cost and enforces 15% hysteresis', () => {
    const allocator = new VisitTileAllocator();
    // Canal-aware pathfinder: slotA at (10,10) is cheap (cost 2) for sink 0, expensive (cost 14) for sink 1;
    // slotB at (14,10) is expensive (cost 12) for sink 0, cheap (cost 3) for sink 1.
    let flowCosts = {
        '0:10,10': 2,
        '0:14,10': 12,
        '1:10,10': 14,
        '1:14,10': 3,
    };
    const pathfinder = {
        isWalkable: () => true,
        sinkIdAt: (tx) => (tx <= 8 ? 0 : 1),
        sinkCostAt: (sink, tx, ty) => flowCosts[`${sink}:${tx},${ty}`] ?? 20,
    };
    const workshop = {
        type: 'custom-workshop',
        visitCapacity: 4,
        visitTiles: [
            { tileX: 10, tileY: 10, slotId: 'slotA', facing: 'south-east' },
            { tileX: 14, tileY: 10, slotId: 'slotB', facing: 'south-west' },
        ],
    };
    allocator.updateContext({ buildings: [workshop], agentSprites: [], pathfinder });

    const a1 = { id: 'agent-1', position: { tileX: 5, tileY: 10 } };
    const a2 = { id: 'agent-2', position: { tileX: 20, tileY: 10 } };

    const first = allocator.allocateBatch([
        { agent: a1, building: workshop },
        { agent: a2, building: workshop },
    ], { now: 1000 });

    assert.equal(first[0].slotId, 'slotA');
    assert.equal(first[1].slotId, 'slotB');
    assert.equal(first[0].solver, 'hungarian');
    assert.equal(allocator.metrics.hungarianSolves, 1);

    // Now test 15% hysteresis on a1 alone between slotA (current) and slotB (alternative):
    allocator.release('agent-2');
    // Case A: slotB improves flow cost by only 10% (slotA = 10 -> cost 40, slotB = 9 -> cost 36).
    // With 15% hysteresis discount (-0.15 * 36 = -5.4), slotA costs 34.6 < 36 -> a1 MUST HOLD slotA!
    flowCosts = { '0:10,10': 10, '0:14,10': 9 };
    const held = allocator.allocateBatch([{ agent: a1, building: workshop }], { now: 2000 });
    assert.equal(held[0].slotId, 'slotA', '10% improvement must hold current slot via 15% hysteresis');
    assert.equal(held[0].hysteresisHeld, true);
    assert.ok(allocator.metrics.hysteresisHolds >= 1);

    // Case B: slotB improves flow cost by 25% (slotA = 10 -> cost 40, slotB = 7.5 -> cost 30).
    // With 15% hysteresis discount (-0.15 * 30 = -4.5), slotA costs 35.5 > 30 -> a1 MUST SWITCH to slotB!
    flowCosts = { '0:10,10': 10, '0:14,10': 7.5 };
    const switched = allocator.allocateBatch([{ agent: a1, building: workshop }], { now: 3000 });
    assert.equal(switched[0].slotId, 'slotB', '25% improvement must switch cleanly to better slot');
    assert.equal(switched[0].hysteresisHeld, false);
});

test('W5-C VisitTileAllocator batch > 12 runs deterministic ε-auction and clusters squads together', () => {
    // 1. > 12 deterministic ε-auction (16 agents x 20 slots).
    const makeAuctionCase = () => {
        const allocator = new VisitTileAllocator();
        const slots = [];
        for (let i = 0; i < 20; i++) {
            slots.push({ tileX: 2 + i, tileY: 8, slotId: `hall:${i}` });
        }
        const hall = { type: 'guild-hall', visitCapacity: 20, visitTiles: slots };
        allocator.updateContext({
            buildings: [hall],
            agentSprites: [],
            pathfinder: { isWalkable: () => true },
        });
        const requests = [];
        for (let i = 0; i < 16; i++) {
            requests.push({
                agent: { id: `worker-${String(i).padStart(2, '0')}`, position: { tileX: 2 + (i * 7) % 20, tileY: 14 } },
                building: hall,
            });
        }
        return { allocator, results: allocator.allocateBatch(requests, { now: 5000 }) };
    };

    const run1 = makeAuctionCase();
    const run2 = makeAuctionCase();
    const slotIds1 = run1.results.map(r => r.slotId);
    const slotIds2 = run2.results.map(r => r.slotId);
    assert.deepEqual(slotIds1, slotIds2, '> 12 ε-auction assignment must be 100% deterministic');
    assert.equal(new Set(slotIds1).size, 16, 'all 16 agents must get unique slots');
    assert.equal(run1.results[0].solver, 'auction');
    assert.equal(run1.allocator.metrics.auctionSolves, 1);

    // 2. Squad formation grouping: two separated wing clusters (west wing x=2..4, east wing x=16..18).
    const squadAlloc = new VisitTileAllocator();
    const wingBuilding = {
        type: 'council-wings',
        visitCapacity: 6,
        visitTiles: [
            { tileX: 2, tileY: 10, slotId: 'w0' },
            { tileX: 3, tileY: 10, slotId: 'w1' },
            { tileX: 4, tileY: 10, slotId: 'w2' },
            { tileX: 16, tileY: 10, slotId: 'e0' },
            { tileX: 17, tileY: 10, slotId: 'e1' },
            { tileX: 18, tileY: 10, slotId: 'e2' },
        ],
    };
    squadAlloc.updateContext({
        buildings: [wingBuilding],
        agentSprites: [],
        pathfinder: { isWalkable: () => true },
    });
    // Squad Alpha approaches slightly west of center; Squad Beta slightly east of center.
    const squadRes = squadAlloc.allocateBatch([
        { agent: { id: 'a1', teamName: 'alpha', position: { tileX: 7, tileY: 14 } }, building: wingBuilding },
        { agent: { id: 'a2', teamName: 'alpha', position: { tileX: 10, tileY: 14 } }, building: wingBuilding },
        { agent: { id: 'b1', teamName: 'beta', position: { tileX: 13, tileY: 14 } }, building: wingBuilding },
        { agent: { id: 'b2', teamName: 'beta', position: { tileX: 10, tileY: 14 } }, building: wingBuilding },
    ], { now: 6000 });

    const alphaSpread = Math.abs(squadRes[0].tileX - squadRes[1].tileX);
    const betaSpread = Math.abs(squadRes[2].tileX - squadRes[3].tileX);
    const crossDist = Math.abs(squadRes[0].tileX - squadRes[2].tileX);
    assert.ok(alphaSpread <= 2, `Squad Alpha must group tightly (spread=${alphaSpread})`);
    assert.ok(betaSpread <= 2, `Squad Beta must group tightly (spread=${betaSpread})`);
    assert.ok(crossDist >= 10, `Distinct squads must separate across wings (dist=${crossDist})`);
});

// ---------------------------------------------------------------------------
// 4. Shared-Grid Overlay Label & Attention Auction (20 Speakers + Plaques + Attention)
// ---------------------------------------------------------------------------

test('W5-C shared-grid overlay auction places 20 speakers + plaques + attention plates with 0 overlaps and sticky stability', () => {
    const renderer = makeOverlayHost({ width: 1280, height: 720, zoom: 1 });

    // 4 painted building plaques at roofline world coords (Layer 1).
    const plaques = [
        { left: -260, top: -225, right: -160, bottom: -203 },
        { left: -40, top: -230, right: 70, bottom: -208 },
        { left: 170, top: -220, right: 275, bottom: -198 },
        { left: -140, top: 60, right: -30, bottom: 82 },
    ];
    renderer.buildingRenderer = { plaqueWorldRects: plaques };

    // 3 attention agents (Layer 2) + 20 distinct speakers (Layer 3).
    const attentionSprites = [
        { agent: { id: 'attn-1', name: 'ForgeWatch', status: AgentStatus.WAITING_ON_USER, pendingSince: 1000 }, x: -200, y: -90 },
        { agent: { id: 'attn-2', name: 'HarborErr', status: AgentStatus.ERRORED, pendingSince: 1000 }, x: 20, y: -80 },
        { agent: { id: 'attn-3', name: 'LimitBot', status: AgentStatus.RATE_LIMITED, pendingSince: 1000 }, x: 210, y: -70 },
    ];

    const speakers = [];
    for (let i = 0; i < 20; i++) {
        const col = i % 5;
        const row = Math.floor(i / 5);
        const x = -280 + col * 140 + (row % 2) * 28;
        const y = -110 + row * 72;
        speakers.push(makeMockSpeaker(
            `spk-${String(i).padStart(2, '0')}`,
            x,
            y,
            `Step ${i}: verifying module ${col}`,
            { displayUntil: 20_000 - i * 10 },
        ));
    }

    for (const s of [...attentionSprites, ...speakers]) {
        renderer.agentSprites.set(s.agent.id, s);
    }

    // Reserve Layer 1 plaques + Layer 2 AttentionPlates in the shared 96 px world grid.
    const occ = renderer._ensureOverlayAuctionPools();
    const sharedGrid = occ.grid;
    const attnGrid = occ.attentionGrid;
    assert.equal(sharedGrid.cellSize, OVERLAY_GRID_CELL);

    const screenPlaques = plaques.map((p) => {
        const tl = renderer.camera.worldToScreen(p.left, p.top);
        const br = renderer.camera.worldToScreen(p.right, p.bottom);
        return { left: tl.x, top: tl.y, right: br.x, bottom: br.y };
    });

    const measuredWords = [];
    const mockCtx = {
        font: '',
        measureText: (str) => {
            measuredWords.push(String(str));
            return { width: String(str).length * 6 };
        },
    };

    const runFrame = (nowMs) => {
        attnGrid.beginFrame();
        for (let i = 0; i < screenPlaques.length; i++) {
            const sp = screenPlaques[i];
            attnGrid.reserve(sp.left, sp.top, sp.right, sp.bottom, OVERLAY_LAYER_PLAQUE, i);
        }
        const attnLayout = layoutAttentionPlates(mockCtx, {
            sprites: attentionSprites,
            camera: renderer.camera,
            viewport: { width: 1280, height: 720 },
            avoid: screenPlaques,
            occupancyGrid: attnGrid,
            now: nowMs,
            dwellNow: nowMs,
        });
        const attnWorldRects = attentionScreenRects(attnLayout)
            .map((r) => renderer._screenRectToWorld(r))
            .filter(Boolean);

        sharedGrid.beginFrame();
        for (let i = 0; i < plaques.length; i++) {
            const p = plaques[i];
            sharedGrid.reserve(p.left, p.top, p.right, p.bottom, OVERLAY_LAYER_PLAQUE, i);
        }
        for (let i = 0; i < attnWorldRects.length; i++) {
            const a = attnWorldRects[i];
            sharedGrid.reserve(a.x, a.y, a.x + a.w, a.y + a.h, OVERLAY_LAYER_ATTENTION, i);
        }

        renderer._assignAgentBubbleSlots(speakers, 1, [], sharedGrid, nowMs, { budget: 24 });
        return { attnLayout, attnWorldRects };
    };

    const frame1 = runFrame(10_000);
    assert.equal(frame1.attnLayout.plates.length, 3, 'all 3 attention plates placed');
    assert.equal(frame1.attnLayout.beacons.length, 3, 'all 3 attention beacons placed');
    assert.equal(frame1.attnWorldRects.length, 6, 'all 3 plates + 3 beacons reserved in world grid');
    assert.equal(
        measuredWords.some((w) => w === 'NEEDS YOU' || w === 'ERROR' || w === 'LIMIT'),
        false,
        'status word widths must use O(1) lookup table without ctx.measureText',
    );

    const placedSpeakers = speakers.filter((s) => s.bubbleSlot != null);
    assert.equal(placedSpeakers.length, 20, `all 20 speakers must be placed cleanly (got ${placedSpeakers.length})`);

    // Verify 0 overlap pairs across ALL plaques, attention plates, and placed thought columns!
    const allRects = [
        ...plaques.map((p, i) => ({ kind: `plaque-${i}`, rect: p })),
        ...frame1.attnWorldRects.map((a, i) => ({ kind: `attn-${i}`, rect: a })),
        ...placedSpeakers.map((s) => ({ kind: `thought-${s.agent.id}`, rect: s._thoughtRects.body })),
    ];
    let overlaps = 0;
    for (let i = 0; i < allRects.length; i++) {
        for (let j = i + 1; j < allRects.length; j++) {
            if (rectsOverlapStrict(allRects[i].rect, allRects[j].rect)) {
                overlaps++;
            }
        }
    }
    assert.equal(overlaps, 0, 'zero overlaps permitted across plaques, attention plates, and 20 thought columns');

    // Verify shared OccupancyGrid & candidate pool reuse + sticky stability across frames with slight jitter.
    const candidateSnapshot1 = speakers.map((s) => s._bubbleCandidate);
    const gridRefBefore = renderer._overlayOccupancyGrid;
    const poolRefBefore = renderer._thoughtCandidatePool;

    for (const s of speakers) {
        s.x += 1;
        s.y -= 1;
    }
    runFrame(10_050);

    assert.equal(renderer._overlayOccupancyGrid, gridRefBefore, 'OverlayOccupancyGrid must be reused across frames');
    assert.equal(renderer._thoughtCandidatePool, poolRefBefore, 'ThoughtCandidatePool must be reused across frames');

    const candidateSnapshot2 = speakers.map((s) => s._bubbleCandidate);
    let unchanged = 0;
    for (let i = 0; i < speakers.length; i++) {
        if (candidateSnapshot1[i] === candidateSnapshot2[i]) unchanged++;
    }
    assert.ok(unchanged >= 18, `sticky prior must prevent frame-to-frame bubble thrash (${unchanged}/20 held)`);

    const labelDiag = renderer.getLabelAuctionDiagnostics();
    assert.equal(labelDiag.placed, 20);
    assert.equal(labelDiag.filtered, 0);
    assert.ok(labelDiag.frames >= 2);
});

// ---------------------------------------------------------------------------
// 5. W5-Fix-C Live Integration & Council Fix Verification
// ---------------------------------------------------------------------------

test('W5-Fix-C P0-1: IsometricRenderer._updateVisitSystems dispatches VisitTileAllocator.allocateBuildingBatch live', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    const allocator = new VisitTileAllocator();
    const forge = {
        type: 'forge',
        visitCapacity: 4,
        visitTiles: [
            { tileX: 10, tileY: 10, slotId: 'forge:0', facing: 'south-east' },
            { tileX: 11, tileY: 10, slotId: 'forge:1', facing: 'south-east' },
            { tileX: 14, tileY: 10, slotId: 'forge:2', facing: 'south-west' },
            { tileX: 15, tileY: 10, slotId: 'forge:3', facing: 'south-west' },
        ],
    };
    const archive = {
        type: 'archive',
        visitCapacity: 2,
        visitTiles: [
            { tileX: 22, tileY: 8, slotId: 'archive:0' },
            { tileX: 23, tileY: 8, slotId: 'archive:1' },
        ],
    };
    const agentsMap = new Map([
        ['a1', { id: 'a1', status: AgentStatus.WORKING, teamName: 'alpha', position: { tileX: 9, tileY: 13 } }],
        ['a2', { id: 'a2', status: AgentStatus.WORKING, teamName: 'alpha', position: { tileX: 10, tileY: 13 } }],
        ['a3', { id: 'a3', status: AgentStatus.WORKING, position: { tileX: 16, tileY: 13 } }],
        ['a4', { id: 'a4', status: AgentStatus.WORKING, position: { tileX: 21, tileY: 11 } }],
    ]);
    const intents = new Map([
        ['a1', { id: 'int-1', building: 'forge', source: 'tool', priority: 80 }],
        ['a2', { id: 'int-2', building: 'forge', source: 'tool', priority: 80 }],
        ['a3', { id: 'int-3', building: 'forge', source: 'tool', priority: 80 }],
        ['a4', { id: 'int-4', building: 'archive', source: 'tool', priority: 80 }],
    ]);
    renderer.world = {
        agents: agentsMap,
        buildings: new Map([['forge', forge], ['archive', archive]]),
        applyVisitLoads: () => {},
    };
    renderer.pathfinder = { isWalkable: () => true };
    renderer.agentSprites = new Map();
    for (const agent of agentsMap.values()) {
        const w = tileToWorld(agent.position.tileX, agent.position.tileY);
        renderer.agentSprites.set(agent.id, {
            agent,
            x: w.x,
            y: w.y,
            moving: false,
            waitTimer: 0,
            _lastIntentId: null,
            _lastBuildingType: null,
            isArrivalPending: () => false,
        });
    }
    renderer.visitIntentManager = {
        reconcile: () => {},
        getIntentForAgent: (id) => intents.get(id) || null,
    };
    renderer.visitTileAllocator = allocator;

    const batchCalls = [];
    const origBatch = allocator.allocateBuildingBatch.bind(allocator);
    allocator.allocateBuildingBatch = (buildingType, requests, opts) => {
        batchCalls.push({ buildingType, count: requests.length });
        return origBatch(buildingType, requests, opts);
    };

    let greedyCalls = 0;
    const origAllocate = allocator.allocate.bind(allocator);
    allocator.allocate = (req) => {
        greedyCalls++;
        return origAllocate(req);
    };

    const baseNow = Date.now();
    renderer._updateVisitSystems(baseNow);

    // Must group by target building and dispatch through allocateBuildingBatch!
    assert.equal(batchCalls.length, 2, 'must dispatch one batch per target building (forge + archive)');
    const forgeBatch = batchCalls.find((c) => c.buildingType === 'forge');
    const archiveBatch = batchCalls.find((c) => c.buildingType === 'archive');
    assert.equal(forgeBatch?.count, 3, 'forge batch must contain all 3 forge agents');
    assert.equal(archiveBatch?.count, 1, 'archive batch must contain the archive agent');
    assert.equal(allocator.metrics.batchSolves, 2);
    assert.equal(allocator.metrics.hungarianSolves, 2);

    // When AgentSprite calls `_allocateVisitTile`, it consumes the batch result without calling greedy `allocate()`.
    const a1Alloc = renderer._allocateVisitTile({
        agent: agentsMap.get('a1'),
        sprite: renderer.agentSprites.get('a1'),
        building: forge,
        intent: intents.get('a1'),
    });
    assert.ok(a1Alloc && a1Alloc.solver === 'hungarian', 'cached batch result must carry hungarian solver metadata');
    assert.equal(greedyCalls, 0, 'consuming live batch allocation must not fall back to greedy allocate()');

    // Single ad-hoc caller (not cached) still works via `_allocateVisitTile`.
    const adhoc = renderer._allocateVisitTile({
        agent: { id: 'adhoc-1', position: { tileX: 12, tileY: 12 } },
        building: forge,
    });
    assert.ok(adhoc && adhoc.slotId, 'ad-hoc single caller still succeeds through _allocateVisitTile');
    assert.equal(greedyCalls, 1);

    // Second slow tick on dwell end exercises 15% hysteresis hold live through _updateVisitSystems.
    renderer._updateVisitSystems(baseNow + 1000);
    assert.ok(allocator.metrics.hysteresisHolds >= 1, 'live slow-tick batch must exercise 15% hysteresis');
});

test('W5-Fix-C P1-1: 2-second joint Glass cutaway test opens once at 300ms, 0 blinks for 2000ms, yields immediately to selection', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    const glass = new InspectionGlass({ enabled: true });
    glass.onPointerMove(400, 300);
    glass.onKeyDown('KeyG');
    renderer.inspectionGlass = glass;
    renderer.camera = { zoom: 2.5, screenToWorld: (x, y) => ({ x, y }) };

    let lensOverBuilding = 'forge';
    const statefulBuildings = {
        _selectedBuildingType: null,
        _glassCutawayTarget: null,
        _apertureModel: null,
        _zoom: 2.5,
        hitTest: () => (lensOverBuilding ? { type: lensOverBuilding } : null),
        supportsCutaway: (type) => type === 'forge' || type === 'archive',
        setGlassCutawayTarget(type, opts) {
            this._glassCutawayTarget = type ? { type, resolved: Boolean(opts?.resolved) } : null;
        },
        _updateInspection() {
            if (this._selectedBuildingType) {
                this._apertureModel = { buildingType: this._selectedBuildingType, trigger: 'selection', source: 'visit' };
                return;
            }
            if (this._glassCutawayTarget?.type && this._glassCutawayTarget.resolved) {
                this._apertureModel = { buildingType: this._glassCutawayTarget.type, trigger: 'glass', source: 'glass' };
                return;
            }
            this._apertureModel = null;
        },
        getApertureModel() {
            return this._apertureModel;
        },
    };
    renderer.buildingRenderer = statefulBuildings;

    let openTransitions = 0;
    let closeTransitions = 0;
    let openedAtMs = null;
    let wasOpen = false;
    const stepMs = 16.67;

    // Run 0..2350ms (full 2000ms after opening at 300ms).
    for (let t = 0; t <= 2350; t += stepMs) {
        const now = Math.round(t);
        statefulBuildings._updateInspection();
        renderer._updateGlassCutaway(now);
        const model = statefulBuildings.getApertureModel();
        const isOpen = Boolean(model && model.buildingType === 'forge' && model.trigger === 'glass');

        // `_selectedBuildingType` must NEVER be overwritten by Glass.
        assert.equal(statefulBuildings._selectedBuildingType, null);

        if (isOpen && !wasOpen) {
            openTransitions++;
            if (openedAtMs === null) openedAtMs = now;
        } else if (!isOpen && wasOpen) {
            closeTransitions++;
        }
        wasOpen = isOpen;
    }

    assert.ok(openedAtMs !== null && openedAtMs >= 300 && openedAtMs <= 320, `expected open at ~300ms, got ${openedAtMs}ms`);
    assert.equal(openTransitions, 1, 'cutaway must open exactly once');
    assert.equal(closeTransitions, 0, 'cutaway must have 0 blinks over the entire 2000ms hold');
    assert.equal(statefulBuildings.getApertureModel()?.trigger, 'glass');

    // Real user selection immediately takes priority and resets Glass cutaway!
    statefulBuildings._selectedBuildingType = 'archive';
    statefulBuildings._updateInspection();
    renderer._updateGlassCutaway(2400);
    assert.equal(statefulBuildings.getApertureModel()?.buildingType, 'archive');
    assert.equal(statefulBuildings.getApertureModel()?.trigger, 'selection');
    assert.equal(glass.cutawayBuildingId, null, 'Glass must yield immediately when real selection opens');
    assert.equal(statefulBuildings._glassCutawayTarget, null);

    // Clear selection, re-dwell 300ms, then move lens off and verify 400ms exit dwell.
    statefulBuildings._selectedBuildingType = null;
    statefulBuildings._updateInspection();
    renderer._updateGlassCutaway(2500);
    renderer._updateGlassCutaway(2800);
    assert.equal(statefulBuildings.getApertureModel()?.buildingType, 'forge');
    lensOverBuilding = null;
    renderer._updateGlassCutaway(2810);
    renderer._updateGlassCutaway(3190); // 380ms < 400ms -> still open
    assert.equal(statefulBuildings.getApertureModel()?.buildingType, 'forge');
    renderer._updateGlassCutaway(3220); // 410ms >= 400ms -> cleanly closed
    assert.equal(statefulBuildings.getApertureModel(), null);
});

test('W5-Fix-C P1-2 & P1-4: live-path AgentSprite stepping across open crossings, narrow corridors, bridge landing, and gate mouth', () => {
    function makeRealStepSprite(id, x, y, waypoints, { speedPxPerFrame = 2.0, surfaceTier = 0 } = {}) {
        const wps = waypoints.map((wp) => ({ x: wp.x, y: wp.y }));
        return {
            agent: { id },
            x,
            y,
            waypoints: wps,
            targetX: wps[0].x,
            targetY: wps[0].y,
            moving: true,
            chatting: false,
            motionScale: 1,
            frame: 0,
            walkFrame: 0,
            animState: 'walk',
            _strideDistance: 0,
            _stridePhase: 0,
            _baseSpeed: speedPxPerFrame,
            _gaitSpeed: speedPxPerFrame,
            _stepStartX: NaN,
            _stepStartY: NaN,
            _stepLength: 0,
            _followGap: false,
            _followYield: false,
            _followYieldMs: 0,
            _followKnotMs: 0,
            surfaceTier,
            radius: ORCA_AGENT_RADIUS,
            steeredPosition: AgentSprite.prototype.steeredPosition,
            _yieldToLeader: AgentSprite.prototype._yieldToLeader,
            _crossingTiles: () => new Map(),
            _isScreenSegmentWalkable: () => true,
            stepTick(dtMs) {
                if (!this.moving) return;
                if (this._yieldToLeader(dtMs)) {
                    return;
                }
                this._gaitSpeed = this._baseSpeed;
                this._stepStartX = this.x;
                this._stepStartY = this.y;
                const step = this._gaitSpeed * (dtMs / 16.67);
                const dx = this.targetX - this.x;
                const dy = this.targetY - this.y;
                const dist = Math.hypot(dx, dy);
                if (dist <= step) {
                    this.x = this.targetX;
                    this.y = this.targetY;
                    this._stepLength = dist;
                    this.waypoints.shift();
                    if (this.waypoints.length > 0) {
                        this.targetX = this.waypoints[0].x;
                        this.targetY = this.waypoints[0].y;
                    } else {
                        this.moving = false;
                    }
                } else {
                    this.x += (dx / dist) * step;
                    this.y += (dy / dist) * step;
                    this._stepLength = step;
                }
            },
        };
    }

    // 1. Open crossing (4 diagonal crossers) — measures REAL displaced positions & realized velocity.
    {
        const renderer = createOrcaHost({ disableStaticFixtures: true });
        const sprites = [
            makeRealStepSprite('c-nw', -90, -90, [{ x: 90, y: 90 }]),
            makeRealStepSprite('c-se', 90, 90, [{ x: -90, y: -90 }]),
            makeRealStepSprite('c-ne', 90, -90, [{ x: -90, y: 90 }]),
            makeRealStepSprite('c-sw', -90, 90, [{ x: 90, y: -90 }]),
        ];
        for (const s of sprites) renderer.agentSprites.set(s.agent.id, s);

        let minDist = Infinity;
        for (let step = 0; step < 300; step++) {
            const dtMs = 16.67;
            for (const s of sprites) s.stepTick(dtMs);
            const moving = sprites.filter((s) => s.moving);
            if (!moving.length) break;
            renderer._applyLocalAvoidance(moving, dtMs);
            for (const s of moving) {
                if (Number.isFinite(s._stepStartX)) {
                    const expectedVx = (s.x - s._stepStartX) / (dtMs / 1000);
                    const expectedVy = (s.y - s._stepStartY) / (dtMs / 1000);
                    assert.ok(Math.abs(s._orcaVx - expectedVx) < 1e-6, 'realized _orcaVx must equal actual displacement / dt');
                    assert.ok(Math.abs(s._orcaVy - expectedVy) < 1e-6, 'realized _orcaVy must equal actual displacement / dt');
                }
            }
            for (let i = 0; i < sprites.length; i++) {
                for (let j = i + 1; j < sprites.length; j++) {
                    const d = Math.hypot(sprites[i].x - sprites[j].x, sprites[i].y - sprites[j].y);
                    if (d < minDist) minDist = d;
                }
            }
        }
        assert.ok(minDist >= 14, `open 4-way crossing min real separation must stay >= 14px, got ${minDist.toFixed(2)}px`);
        assert.ok(sprites.every((s) => !s.moving), 'all 4 crossers must reach their waypoints cleanly');
    }

    // 2. Narrow corridor (|y| <= 2) overtaking: fast walker yields behind slow walker cleanly (no pass-through, no walk-in-place).
    {
        const renderer = createOrcaHost({
            disableStaticFixtures: true,
            isWalkable: (_s, _x, y) => Math.abs(y) <= 2,
        });
        const slow = makeRealStepSprite('slow', 40, 0, [{ x: 240, y: 0 }], { speedPxPerFrame: 1.0 });
        const fast = makeRealStepSprite('fast', 0, 0, [{ x: 240, y: 0 }], { speedPxPerFrame: 2.6 });
        renderer.agentSprites.set(slow.agent.id, slow);
        renderer.agentSprites.set(fast.agent.id, fast);

        let minDist = Infinity;
        let yieldFrames = 0;
        for (let step = 0; step < 260; step++) {
            const dtMs = 16.67;
            slow.stepTick(dtMs);
            fast.stepTick(dtMs);
            const moving = [slow, fast].filter((s) => s.moving);
            if (!moving.length) break;
            renderer._applyLocalAvoidance(moving, dtMs);
            if (fast._followYield) yieldFrames++;
            const d = Math.hypot(slow.x - fast.x, slow.y - fast.y);
            if (d < minDist) minDist = d;
        }
        assert.ok(yieldFrames > 0, 'fast walker must engage contact-frame _followYield in 2px corridor');
        assert.ok(minDist >= 16, `narrow-corridor overtaking must maintain separation >= 16px (no pass-through!), got ${minDist.toFixed(2)}px`);
        assert.equal(slow.moving, false, 'slow walker reaches corridor exit cleanly');
    }

    // 3. Narrow corridor (|y| <= 2) opposing walkers: hold cleanly on contact frame (no immediate pass-through), then knot timeout breaks deadlock!
    {
        const renderer = createOrcaHost({
            disableStaticFixtures: true,
            isWalkable: (_s, _x, y) => Math.abs(y) <= 2,
        });
        const east = makeRealStepSprite('opp-e', 0, 0, [{ x: 160, y: 0 }], { speedPxPerFrame: 2.0 });
        const west = makeRealStepSprite('opp-w', 100, 0, [{ x: -60, y: 0 }], { speedPxPerFrame: 2.0 });
        renderer.agentSprites.set(east.agent.id, east);
        renderer.agentSprites.set(west.agent.id, west);

        let knotYieldSeen = false;
        let minDistBeforeTimeout = Infinity;
        for (let step = 0; step < 360; step++) {
            const dtMs = 16.67;
            east.stepTick(dtMs);
            west.stepTick(dtMs);
            const moving = [east, west].filter((s) => s.moving);
            if (!moving.length) break;
            renderer._applyLocalAvoidance(moving, dtMs);
            if (east._followYield === 'knot' || west._followYield === 'knot') knotYieldSeen = true;
            if (step < 100) {
                const d = Math.hypot(east.x - west.x, east.y - west.y);
                if (d < minDistBeforeTimeout) minDistBeforeTimeout = d;
            }
        }
        assert.equal(knotYieldSeen, true, 'opposing walkers in 2px corridor must enter bounded knot yield');
        assert.ok(minDistBeforeTimeout >= 16, `opposing walkers must hold separation >= 16px during knot yield, got ${minDistBeforeTimeout.toFixed(2)}px`);
        assert.ok(!east.moving && !west.moving, 'bounded knot timeout must prevent permanent opposing deadlock');
    }

    // 4. Bridge landing (wide plazas at x < 40 and x > 100, narrow bridge |y| <= 2 for 40 <= x <= 100):
    // Walker crossing bridge meets walker at landing — landing walker yields/peels cleanly and both finish!
    {
        const renderer = createOrcaHost({
            disableStaticFixtures: true,
            isWalkable: (_s, x, y) => (x < 40 || x > 100) ? Math.abs(y) <= 80 : Math.abs(y) <= 2,
        });
        const onBridge = makeRealStepSprite('on-bridge', 55, 0, [{ x: 110, y: 0 }, { x: 150, y: 0 }], { speedPxPerFrame: 2.0 });
        const atLanding = makeRealStepSprite('at-landing', 112, 0, [{ x: 95, y: 0 }, { x: 20, y: 0 }], { speedPxPerFrame: 2.0 });
        renderer.agentSprites.set(onBridge.agent.id, onBridge);
        renderer.agentSprites.set(atLanding.agent.id, atLanding);

        let minDist = Infinity;
        for (let step = 0; step < 300; step++) {
            const dtMs = 16.67;
            onBridge.stepTick(dtMs);
            atLanding.stepTick(dtMs);
            const moving = [onBridge, atLanding].filter((s) => s.moving);
            if (!moving.length) break;
            renderer._applyLocalAvoidance(moving, dtMs);
            const d = Math.hypot(onBridge.x - atLanding.x, onBridge.y - atLanding.y);
            if (d < minDist) minDist = d;
        }
        assert.ok(minDist >= 14, `bridge landing crossing must maintain >= 14px clearance, got ${minDist.toFixed(2)}px`);
        assert.ok(!onBridge.moving && !atLanding.moving, 'both bridge-landing walkers must reach their targets');
    }

    // 5. Gate mouth & departing villager (Opus P1-3):
    // Departing villager participates in ORCA across the village, switches to gate-channel
    // transit only inside the gate channel zone, and acts as a solid ORCA obstacle inside it.
    {
        const renderer = createOrcaHost({ disableStaticFixtures: true });
        renderer._isGateChannelTransit = IsometricRenderer.prototype._isGateChannelTransit;
        renderer._isInGateChannelZone = IsometricRenderer.prototype._isInGateChannelZone;
        renderer._isGateTransit = IsometricRenderer.prototype._isGateTransit;

        const midVillage = tileToWorld(18, 25);
        const insideGate = tileToWorld(19.0, 38.2);
        const departer = makeRealStepSprite('dep-1', midVillage.x, midVillage.y, [{ x: insideGate.x, y: insideGate.y }]);
        renderer.gateTransits.set('dep-1', { type: 'departure', since: Date.now() });
        renderer.agentSprites.set('dep-1', departer);

        assert.equal(renderer._isGateChannelTransit(departer), false, 'departing villager mid-village must stay in ORCA');

        // Move departing villager into the physical gate channel zone (tile 19, 38.2).
        departer.x = insideGate.x;
        departer.y = insideGate.y;
        assert.equal(renderer._isGateChannelTransit(departer), true, 'departing villager inside gate channel switches to gate-channel transit');

        // Approaching crowd walker headed directly toward the gate-channel walker must steer around it (solid obstacle!).
        const approacher = makeRealStepSprite('app-1', insideGate.x - 40, insideGate.y, [{ x: insideGate.x + 60, y: insideGate.y }]);
        renderer.agentSprites.set('app-1', approacher);

        let minGateDist = Infinity;
        for (let step = 0; step < 90; step++) {
            approacher.stepTick(16.67);
            // Only approacher is in movingSprites (departer is excluded by _isGateChannelTransit),
            // yet departer MUST still be registered as a solid ORCA obstacle inside _stepOrcaCrowd!
            renderer._applyLocalAvoidance([approacher], 16.67);
            const d = Math.hypot(approacher.x - departer.x, approacher.y - departer.y);
            if (d < minGateDist) minGateDist = d;
        }
        assert.equal(departer.x, insideGate.x, 'gate-channel walker must not be displaced by approaching crowd');
        assert.ok(minGateDist >= 14, `approaching walker must steer around gate-channel walker (>= 14px), got ${minGateDist.toFixed(2)}px`);
    }
});

test('W5-Fix-C P1-5: strike-swing clearance disc points in the exact direction on all 8 SpriteSheet.DIRECTIONS indices', () => {
    const expectedVectors = {
        s: [0, 1],
        se: [Math.SQRT1_2, Math.SQRT1_2],
        e: [1, 0],
        ne: [Math.SQRT1_2, -Math.SQRT1_2],
        n: [0, -1],
        nw: [-Math.SQRT1_2, -Math.SQRT1_2],
        w: [-1, 0],
        sw: [-Math.SQRT1_2, Math.SQRT1_2],
    };

    for (let dirIdx = 0; dirIdx < DIRECTIONS.length; dirIdx++) {
        const dirName = DIRECTIONS[dirIdx];
        const [ux, uy] = expectedVectors[dirName];
        const renderer = createOrcaHost({ disableStaticFixtures: true });
        const pools = renderer._ensureOrcaPools();
        const desc = renderer._acquireOrcaDescriptor(pools, 0);

        const striker = {
            agent: { id: `striker-${dirIdx}` },
            x: 100,
            y: 100,
            moving: false,
            planted: true,
            surfaceTier: 0,
            direction: dirIdx, // numeric SpriteSheet.DIRECTIONS index 0..7!
            _poseCell: { source: 'strip', group: 'strike' },
            swingRadius: ORCA_SWING_RADIUS,
        };
        renderer._fillOrcaDescriptor(desc, striker, true, 1 / 60, 0);
        assert.equal(desc.direction, dirName, `index ${dirIdx} must map to short facing '${dirName}'`);

        // Place probes at scaled distance 25 px from the striker's body center
        // (strictly outside striker body clearance 23 px, and well inside the front
        // strike-swing clearance disc which reaches 29.18..33.5 px in scaled space).
        const isoFactor = Math.hypot(ux, uy * ORCA_Y_SCALE);
        const probeDist = 25 / isoFactor;
        const fx0 = 100 + ux * probeDist;
        const fy0 = 100 + uy * probeDist;
        const bx0 = 100 - ux * probeDist;
        const by0 = 100 - uy * probeDist;
        const frontProbe = {
            agent: { id: `front-${dirIdx}` },
            x: fx0,
            y: fy0,
            targetX: fx0 - uy * 80,
            targetY: fy0 + ux * 80,
            moving: true,
            gaitSpeed: 45,
            surfaceTier: 0,
        };
        const backProbe = {
            agent: { id: `back-${dirIdx}` },
            x: bx0,
            y: by0,
            targetX: bx0 - uy * 80,
            targetY: by0 + ux * 80,
            moving: true,
            gaitSpeed: 45,
            surfaceTier: 0,
        };

        const rFront = createOrcaHost({ disableStaticFixtures: true });
        rFront.agentSprites.set(striker.agent.id, striker);
        rFront.agentSprites.set(frontProbe.agent.id, frontProbe);
        rFront._applyLocalAvoidance([frontProbe], 50);

        const rBack = createOrcaHost({ disableStaticFixtures: true });
        rBack.agentSprites.set(striker.agent.id, striker);
        rBack.agentSprites.set(backProbe.agent.id, backProbe);
        rBack._applyLocalAvoidance([backProbe], 50);

        // Front walker must be repelled outward along +u by the swing disc, while back walker is unaffected.
        const frontPush = (frontProbe.x - fx0) * ux + (frontProbe.y - fy0) * uy;
        const backPush = (backProbe.x - bx0) * (-ux) + (backProbe.y - by0) * (-uy);
        assert.ok(
            frontPush > backPush + 0.15,
            `facing ${dirIdx} ('${dirName}'): swing disc must repel front side (${frontPush.toFixed(3)}) more than back (${backPush.toFixed(3)})`,
        );
    }
});

test('W5-Fix-C P1-6: 150ms thought hold never overlaps Layer 1 plaques or Layer 2 attention/names, and T2/T4 names avoid plaques', () => {
    const renderer = makeOverlayHost({ width: 1280, height: 720, zoom: 2 });
    const sp = makeMockSpeaker('spk-hold', 0, 0, 'Checking forge state', { displayUntil: 20_000 });
    renderer.agentSprites.set('spk-hold', sp);

    const occ = renderer._ensureOverlayAuctionPools();
    const grid = occ.grid;

    // Frame 1 (t = 1000): speaker commits candidate 0 with no blockers.
    grid.beginFrame();
    renderer._assignAgentBubbleSlots([sp], 2, [], grid, 1000, { budget: 8 });
    assert.equal(sp._bubbleCandidate, 0);
    const homeBody = { ...sp._thoughtRects.body };

    // Frame 2 (t = 1050, 50ms < 150ms): a Layer 1 building plaque lands right on candidate 0!
    // MUST NOT hold on top of Layer 1 plaque — must immediately move to a non-overlapping candidate!
    grid.beginFrame();
    grid.reserve(homeBody.x, homeBody.y, homeBody.x + homeBody.w, homeBody.y + homeBody.h, OVERLAY_LAYER_PLAQUE, 0);
    renderer._assignAgentBubbleSlots([sp], 2, [], grid, 1050, { budget: 8 });
    assert.notEqual(sp._bubbleCandidate, 0, 'thought must NEVER hold over a Layer 1 building plaque');
    assert.equal(rectsOverlapStrict(sp._thoughtRects.body, homeBody), false);

    // Frame 3: re-commit at candidate 0, then block with a Layer 2 attention plate -> MUST NOT hold!
    sp._bubbleCandidate = null;
    grid.beginFrame();
    renderer._assignAgentBubbleSlots([sp], 2, [], grid, 2000, { budget: 8 });
    assert.equal(sp._bubbleCandidate, 0);
    grid.beginFrame();
    grid.reserve(homeBody.x, homeBody.y, homeBody.x + homeBody.w, homeBody.y + homeBody.h, OVERLAY_LAYER_ATTENTION, 0);
    renderer._assignAgentBubbleSlots([sp], 2, [], grid, 2050, { budget: 8 });
    assert.notEqual(sp._bubbleCandidate, 0, 'thought must NEVER hold over a Layer 2 attention plate / name');

    // Frame 4: re-commit at candidate 0, then block ONLY by a strictly lower-priority Layer 3 thought:
    // MUST hold for < 150ms (t = 3050, 3140) and release at >= 150ms (t = 3150)!
    sp._bubbleCandidate = null;
    grid.beginFrame();
    renderer._assignAgentBubbleSlots([sp], 2, [], grid, 3000, { budget: 8 });
    assert.equal(sp._bubbleCandidate, 0);
    grid.beginFrame();
    grid.reserve(homeBody.x, homeBody.y, homeBody.x + homeBody.w, homeBody.y + homeBody.h, 3 /* OVERLAY_LAYER_THOUGHT */, 1);
    renderer._assignAgentBubbleSlots([sp], 2, [], grid, 3050, { budget: 8 });
    assert.equal(sp._bubbleCandidate, 0, 'thought holds cleanly within 150ms when blocked only by lower-priority thought');
    grid.beginFrame();
    grid.reserve(homeBody.x, homeBody.y, homeBody.x + homeBody.w, homeBody.y + homeBody.h, 3 /* OVERLAY_LAYER_THOUGHT */, 1);
    renderer._assignAgentBubbleSlots([sp], 2, [], grid, 3210, { budget: 8 });
    assert.notEqual(sp._bubbleCandidate, 0, 'thought re-searches once 150ms hold elapses');

    // T4 routine name and T2 identity plate against Layer 1 building plaque in _assignAgentOverlaySlots:
    const overlayHost = makeOverlayHost({ width: 1280, height: 720, zoom: 2 });
    overlayHost.overlayCtx = { font: '', measureText: (str) => ({ width: String(str).length * 7 }) };
    const t4 = {
        agent: { id: 't4-agent', name: 'RoutineBot', status: AgentStatus.WORKING },
        x: 0,
        y: 0,
        selected: false,
        hovered: false,
        gpuWorldEnabled: true,
        _activityThread: () => [],
    };
    const t2 = {
        agent: { id: 't2-agent', name: 'FocusBot', status: AgentStatus.WORKING },
        x: 120,
        y: 0,
        selected: true,
        hovered: false,
        gpuWorldEnabled: true,
        _activityThread: () => [],
    };
    overlayHost.selectedAgent = t2.agent;
    overlayHost.agentSprites.set('t4-agent', t4);
    overlayHost.agentSprites.set('t2-agent', t2);
    // Compute exact world rects of t4 slot 0 and t2 slot 0, and place Layer 1 building plaques on both!
    const t4Slot0 = overlayHost._agentIdentityRect(t4, 0);
    t2.labelPlate = true;
    const t2Slot0 = overlayHost._agentIdentityRect(t2, 0);
    t2.labelPlate = false;
    overlayHost.buildingRenderer = {
        plaqueWorldRects: [
            { left: t4Slot0.x, top: t4Slot0.y, right: t4Slot0.x + t4Slot0.w, bottom: t4Slot0.y + t4Slot0.h },
            { left: t2Slot0.x, top: t2Slot0.y, right: t2Slot0.x + t2Slot0.w, bottom: t2Slot0.y + t2Slot0.h },
        ],
    };
    overlayHost._assignAgentOverlaySlots([t4, t2], 2);
    assert.equal(t4.overlaySlot, null, 'T4 routine name overlapping a Layer 1 building plaque must be dropped');
    assert.ok(t2.overlaySlot >= 1, `T2 focused identity plate must step off overlapping Layer 1 building plaque (got slot ${t2.overlaySlot})`);
});

test('W5-Fix-C P1-6 (Fable P2): HarborTraffic caps simultaneous Maiden Voyage christening banners to 2 with stagger', () => {
    const emitted = [];
    const off = eventBus.on('harbor:repo-christened', (payload) => emitted.push(payload));
    const harbor = new HarborTraffic();
    try {
        // Reconcile 6 distinct brand-new repos in a single burst at t = 10_000.
        const agents = [];
        for (let i = 0; i < 6; i++) {
            agents.push({
                id: `h-agent-${i}`,
                projectPath: `/repos/voyage-${i}`,
                status: AgentStatus.WORKING,
                lastSessionActivity: 10_000,
                gitEvents: [{
                    id: `commit-${i}`,
                    type: 'commit',
                    project: `/repos/voyage-${i}`,
                    branch: 'main',
                    sha: `abc000${i}`,
                    timestamp: 10_000,
                }],
            });
        }
        harbor.reconcile(agents, 10_000, { force: true });
        assert.equal(emitted.length, 1, 'initial multi-repo burst must emit 1 banner immediately, never 5-6 stacked');

        // After 1800ms stagger, a 2nd banner may emit (capped at 2 simultaneous).
        harbor._flushChristeningQueue(11_850);
        assert.equal(emitted.length, 2, '2nd staggered banner emits after 1800ms');

        // At 14_000ms (both active within 6000ms TTL): cap holds at 2!
        harbor._flushChristeningQueue(14_000);
        assert.equal(emitted.length, 2, 'must never exceed 2 simultaneous Maiden Voyage banners');

        // At 16_050ms (first banner expired after 6000ms): 3rd banner emits cleanly!
        harbor._flushChristeningQueue(16_050);
        assert.equal(emitted.length, 3, 'queued christening emits once an active banner expires');
    } finally {
        off?.();
        harbor.dispose();
    }
});

test('W5-Fix-C P2: x = 0 centerline origX preservation, origX before crab fallback, and zero-alloc lane/fan helpers', () => {
    // 1. Sprite stepping onto exact x = 0 centerline (`tileX === tileY`): origX must stay 0, never revert to baseX!
    const renderer = createOrcaHost({ disableStaticFixtures: true });
    const pools = renderer._ensureOrcaPools();
    const desc = renderer._acquireOrcaDescriptor(pools, 0);
    const centerlineSprite = {
        agent: { id: 'center-0' },
        x: 0,
        y: 0,
        _stepStartX: -2,
        _stepStartY: -2,
        _stepLength: Math.hypot(2, 2),
        targetX: 40,
        targetY: 40,
        moving: true,
        steeredPosition: AgentSprite.prototype.steeredPosition,
    };
    renderer._fillOrcaDescriptor(desc, centerlineSprite, false, 1 / 60, 0);
    assert.equal(desc.origX, 0, 'origX must preserve exact 0 on tileX === tileY centerline');
    assert.equal(desc.origY, 0, 'origY must preserve exact 0');

    // 2. strideSteer tries desc.origX/desc.origY BEFORE screen-axis sideways keptX/keptY crab fallbacks.
    // Diagonal corridor along x === y (walkable when |x - y| <= 0.25) plus a narrow x-axis strip (|y| <= 0.05):
    // Walker steps cleanly from (0, 0) to (2, 2) while ORCA deflects to (2.77, 0.55) (unwalkable!).
    // Screen-axis keptX = (2.828, 0) IS walkable on |y| <= 0.05, so crab fallback would pick (2.828, 0),
    // whereas trying orig (2, 2) FIRST keeps the walker dead on the diagonal!
    const diagRenderer = createOrcaHost({
        disableStaticFixtures: true,
        isWalkable: (_s, x, y) => Math.abs(x - y) <= 0.25 || Math.abs(y) <= 0.05,
    });
    const diagWalker = {
        agent: { id: 'diag-walker' },
        x: 2,
        y: 2,
        _stepStartX: 0,
        _stepStartY: 0,
        _stepLength: Math.hypot(2, 2),
        targetX: 60,
        targetY: 60,
        moving: true,
        steeredPosition: AgentSprite.prototype.steeredPosition,
    };
    diagRenderer.agentSprites.set('diag-walker', diagWalker);
    const diagPools = diagRenderer._ensureOrcaPools();
    const dDesc = diagRenderer._acquireOrcaDescriptor(diagPools, 0);
    diagRenderer._fillOrcaDescriptor(dDesc, diagWalker, false, 1 / 60, 0);
    diagPools.agents = [dDesc];
    diagPools.activeCount = 1;
    const steered = diagPools.stepOptions.strideSteer(dDesc, 2.77, 0.55);
    assert.ok(steered, 'strideSteer must return a valid position');
    assert.ok(Math.abs(steered.x - 2) < 1e-6 && Math.abs(steered.y - 2) < 1e-6, 'must prefer origX/origY before sideways keptX/keptY crabbing');

    // 3. _laneInfoForSprite uses integer tile lookup and _fanStopOf reuses scratch object.
    const lanePos = tileToWorld(12, 14);
    const laneEntry = { tileKey: '12,14', tileX: 12, tileY: 14, tangentX: 1, tangentY: 0, perpX: 0, perpY: 1, laneOffset: 4 };
    renderer._laneTiles.set('12,14', laneEntry);
    assert.equal(renderer._laneInfoForSprite({ x: lanePos.x, y: lanePos.y }), laneEntry);

    const stopA = renderer._fanStopOf({ x: 0, y: 0, targetX: 5, targetY: 0, waypoints: [{ x: 5, y: 0 }] });
    const stopB = renderer._fanStopOf({ x: 0, y: 0, targetX: 8, targetY: 0, waypoints: [{ x: 8, y: 0 }] });
    assert.equal(stopA, stopB, '_fanStopOf must reuse its scratch object without per-call heap allocations');
    assert.equal(stopB.reach, 8);
});
