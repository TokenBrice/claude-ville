import test from 'node:test';
import assert from 'node:assert/strict';

import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
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
        setGlassCutawayTarget: (buildingType, now) => {
            targetLog.push({ buildingType, now });
        },
    };

    // Frame 1 (t = 1000): starts dwell timer — cutaway not open yet.
    renderer._updateGlassCutaway(1000);
    assert.equal(targetLog.at(-1).buildingType, null);

    // Frame 2 (t = 1250, 250 ms < 300 ms): still dwelling.
    renderer._updateGlassCutaway(1250);
    assert.equal(targetLog.at(-1).buildingType, null);

    // Frame 3 (t = 1350, 350 ms >= 300 ms): dwell reached -> triggers 'forge'.
    renderer._updateGlassCutaway(1350);
    assert.equal(targetLog.at(-1).buildingType, 'forge');

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
