import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
    ORCA_MAX_NEIGHBORS,
    ORCA_MAX_LINES,
    ORCA_TAU,
    ORCA_TAU_OBST,
    ORCA_Y_SCALE,
    ORCA_INV_Y_SCALE,
    ORCA_AGENT_RADIUS,
    ORCA_SWING_RADIUS,
    ORCA_BRIDGE_PASS_RADIUS,
    DIR_X,
    DIR_Y,
    sharesAvoidancePlane,
    isOpposingTwoWayBridgePair,
    computePreferredVelocity,
    linearProgram1,
    linearProgram2,
    linearProgram3,
    solveOrcaVelocity,
    stepCrowdOrca,
} from '../../claudeville/src/presentation/character-mode/CrowdOrca.js';

import {
    SLOT_HUNGARIAN_MAX,
    SLOT_AUCTION_EPSILON,
    OVERLAY_GRID_CELL,
    OVERLAY_LAYER_PLAQUE,
    OVERLAY_LAYER_ATTENTION,
    OVERLAY_LAYER_THOUGHT,
    ATTENTION_GROUP_RADIUS,
    LABEL_MAX_SPEAKERS,
    LABEL_MAX_CANDIDATES,
    LABEL_AUCTION_EPSILON,
    LABEL_AUCTION_MAX_ITERS,
    LABEL_STICKY_BONUS,
    LABEL_BOUNDS_PENALTY,
    buildVisitSlotCost,
    solveSlotAssignment,
    computeAssignmentCost,
    OverlayOccupancyGrid,
    getAttentionWordWidth,
    computeAttentionPlateWidth,
    clusterAttentionBeacons,
    reserveAttentionPlates,
    solveLabelAuction,
} from '../../claudeville/src/presentation/character-mode/SlotAuction.js';

// Deterministic Mulberry32 PRNG for reproducible tests.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Exact brute-force optimal sum for small rectangular m x n matrices (m, n <= 7).
function bruteForceOptimalCost(matrix, m, n) {
    const transposed = m > n;
    const rows = transposed ? n : m;
    const cols = transposed ? m : n;
    const used = new Uint8Array(cols);
    let best = Infinity;

    function dfs(r, sum) {
        if (r === rows) {
            if (sum < best) best = sum;
            return;
        }
        for (let c = 0; c < cols; c++) {
            if (used[c]) continue;
            used[c] = 1;
            const cost = transposed ? matrix[c * n + r] : matrix[r * n + c];
            dfs(r + 1, sum + cost);
            used[c] = 0;
        }
    }
    dfs(0, 0);
    return best;
}

function rectsStrictlyOverlap(a, b, pad = 0) {
    return a.left < b.right + pad && a.right + pad > b.left && a.top < b.bottom + pad && a.bottom + pad > b.top;
}

// ---------------------------------------------------------------------------
// 1. Exported Constants & Exact LP Primitives
// ---------------------------------------------------------------------------

test('CrowdOrca exports exact §3.2 constants and 8 compass unit vectors', () => {
    assert.equal(ORCA_MAX_NEIGHBORS, 8);
    assert.equal(ORCA_MAX_LINES, 16);
    assert.equal(ORCA_TAU, 0.8);
    assert.equal(ORCA_TAU_OBST, 0.45);
    assert.equal(ORCA_Y_SCALE, 0.64);
    assert.equal(ORCA_INV_Y_SCALE, 1 / 0.64);
    assert.equal(ORCA_AGENT_RADIUS, 11.5);
    assert.equal(ORCA_SWING_RADIUS, 10.0);
    assert.equal(DIR_X.length, 8);
    assert.equal(DIR_Y.length, 8);
    for (let d = 0; d < 8; d++) {
        assert.ok(Math.abs(Math.hypot(DIR_X[d], DIR_Y[d]) - 1) < 1e-12);
    }
});

test('linearProgram1/2/3 solve feasible and infeasible 2D half-plane systems exactly', () => {
    // Feasible: v.x <= 5 (dir=(0,1), p=(5,0)) and v.y >= 3 (dir=(1,0), p=(0,3)).
    const px = new Float64Array([5, 0, 0]);
    const py = new Float64Array([0, 3, -3]);
    const dx = new Float64Array([0, 1, -1]);
    const dy = new Float64Array([1, 0, 0]);
    const out = new Float64Array(2);

    const ok1 = linearProgram1(px, py, dx, dy, 1, 20, 10, 0, false, out);
    assert.equal(ok1, true);
    assert.ok(Math.abs(out[0] - 5) < 1e-9);
    assert.ok(Math.abs(out[1] - 3) < 1e-9);

    const ok2 = linearProgram2(px, py, dx, dy, 2, 20, 10, 0, false, out);
    assert.equal(ok2, 2);
    assert.ok(Math.abs(out[0] - 5) < 1e-9);
    assert.ok(Math.abs(out[1] - 3) < 1e-9);

    // Infeasible: line 1 wants v.y >= 3, line 2 wants v.y <= -3.
    // linearProgram3 minimizes max violation => v.y === 0 (violation 3 on both).
    const failAt = linearProgram2(px, py, dx, dy, 3, 20, 10, 0, false, out);
    assert.equal(failAt, 2);
    linearProgram3(px, py, dx, dy, 3, 0, failAt, 20, out);
    assert.ok(Math.abs(out[1]) < 1e-6, `expected minimax v.y ~= 0, got ${out[1]}`);
    assert.ok(Math.hypot(out[0], out[1]) <= 20 + 1e-6);
});

// ---------------------------------------------------------------------------
// 2. CrowdOrca Scenarios (Head-On, Planted, Strike Swing, Static Discs, E2 Tier)
// ---------------------------------------------------------------------------

test('head-on 2-agent corridor: clean right-hand peel without deadlock or < 3 px stack', () => {
    const agents = [
        { id: 'east', x: 0, y: 100, vx: 45, vy: 0, targetX: 160, targetY: 100, gaitSpeed: 45, surfaceTier: 0 },
        { id: 'west', x: 160, y: 100, vx: -45, vy: 0, targetX: 0, targetY: 100, gaitSpeed: 45, surfaceTier: 0 },
    ];

    const dt = 1 / 30;
    let minDist = Infinity;
    let maxEastY = -Infinity;
    let minWestY = Infinity;

    for (let step = 0; step < 240; step++) {
        stepCrowdOrca(agents, dt);
        const dist = Math.hypot(agents[0].x - agents[1].x, agents[0].y - agents[1].y);
        if (dist < minDist) minDist = dist;
        if (agents[0].y > maxEastY) maxEastY = agents[0].y;
        if (agents[1].y < minWestY) minWestY = agents[1].y;
    }

    // Both reach their opposite corridor ends cleanly.
    assert.ok(Math.hypot(agents[0].x - 160, agents[0].y - 100) < 4, `east agent reached target, got (${agents[0].x}, ${agents[0].y})`);
    assert.ok(Math.hypot(agents[1].x - 0, agents[1].y - 100) < 4, `west agent reached target, got (${agents[1].x}, ${agents[1].y})`);
    // Right-hand (starboard) peel in +X east / +Y south: eastbound peels +Y, westbound peels -Y.
    assert.ok(maxEastY > 106, `expected eastbound walker to peel starboard (+Y > 106), got ${maxEastY}`);
    assert.ok(minWestY < 94, `expected westbound walker to peel starboard (-Y < 94), got ${minWestY}`);
    // Never stacks < 3 px (in fact clears body ellipse well beyond 14 px).
    assert.ok(minDist >= 14, `expected clean corridor clearance >= 14 px, minDist=${minDist}`);
});

test('moving walker vs planted villager: planted velocity stays 0 and walker clears smoothly', () => {
    const walker = { id: 'walker', x: 0, y: 100, vx: 45, vy: 0, targetX: 160, targetY: 100, gaitSpeed: 45, planted: false };
    const planted = { id: 'smith', x: 80, y: 100, vx: 0, vy: 0, planted: true };
    const agents = [walker, planted];
    const dt = 1 / 30;
    let minDist = Infinity;

    for (let step = 0; step < 240; step++) {
        stepCrowdOrca(agents, dt);
        assert.equal(planted.vx, 0, 'planted villager vx must stay 0');
        assert.equal(planted.vy, 0, 'planted villager vy must stay 0');
        assert.equal(planted.x, 80, 'planted villager x must never drift');
        assert.equal(planted.y, 100, 'planted villager y must never drift');
        const dist = Math.hypot(walker.x - planted.x, walker.y - planted.y);
        if (dist < minDist) minDist = dist;
    }

    assert.ok(Math.hypot(walker.x - 160, walker.y - 100) < 4, `walker reached target, got (${walker.x}, ${walker.y})`);
    assert.ok(minDist >= 16, `walker cleared planted villager smoothly, minDist=${minDist}`);
});

test('moving walker respects active strike swing arc (ORCA_SWING_RADIUS) and static wildlife/fixture discs (ORCA_TAU_OBST)', () => {
    // 1. Active strike swing arc directly in the walker's path.
    const striker = {
        id: 'striker',
        x: 90,
        y: 120,
        vx: 0,
        vy: 0,
        planted: true,
        swingActive: true,
        swingOffsetX: 0,
        swingOffsetY: -22, // Swing contact arc reaches up to y = 98, directly on walker's lane!
    };
    const walkerA = { id: 'wA', x: 10, y: 98, vx: 45, vy: 0, targetX: 170, targetY: 98, gaitSpeed: 45 };
    const swingX = striker.x + striker.swingOffsetX;
    const swingY = striker.y + striker.swingOffsetY;
    let minSwingScaledDist = Infinity;

    const dt = 1 / 30;
    for (let step = 0; step < 240; step++) {
        stepCrowdOrca([walkerA, striker], dt);
        assert.equal(striker.vx, 0);
        assert.equal(striker.vy, 0);
        const sDist = Math.hypot(walkerA.x - swingX, (walkerA.y - swingY) * ORCA_Y_SCALE);
        if (sDist < minSwingScaledDist) minSwingScaledDist = sDist;
    }

    assert.ok(Math.hypot(walkerA.x - 170, walkerA.y - 98) < 4, 'walker passed around active swing arc');
    // Scaled clearance should honor walker radius + ORCA_SWING_RADIUS (= 21.5 px, allow tiny discretization slack).
    assert.ok(
        minSwingScaledDist >= ORCA_AGENT_RADIUS + ORCA_SWING_RADIUS - 2.0,
        `expected swing arc scaled clearance >= ${ORCA_AGENT_RADIUS + ORCA_SWING_RADIUS - 2}, got ${minSwingScaledDist}`,
    );

    // Verify inactive strike pose (poseFrame far from contactFrame) does NOT emit swing disc.
    const idleStriker = {
        id: 'idle-striker',
        x: 90,
        y: 145,
        vx: 0,
        vy: 0,
        planted: true,
        activePose: 'strike',
        poseFrame: 0,
        contactFrame: 3,
        swingOffsetX: 0,
        swingOffsetY: -47,
    };
    const activePoseStriker = { ...idleStriker, poseFrame: 2 };
    // Approaching swing contact (90, 98) off-center at (60, 103) inside ORCA_TAU_OBST horizon:
    // active strike emits swing half-plane and deflects walker both in speed and laterally.
    const probe = { id: 'probe', x: 60, y: 103, vx: 45, vy: 0, maxSpeed: 45 };
    const prefInactive = new Float64Array(2);
    const prefActive = new Float64Array(2);
    computePreferredVelocity(probe, 45, 0, 45, [idleStriker], null, prefInactive);
    computePreferredVelocity(probe, 45, 0, 45, [activePoseStriker], null, prefActive);
    const velInactive = new Float64Array(2);
    const velActive = new Float64Array(2);
    const linesInactive = solveOrcaVelocity(probe, prefInactive[0], prefInactive[1], [idleStriker], null, velInactive);
    const linesActive = solveOrcaVelocity(probe, prefActive[0], prefActive[1], [activePoseStriker], null, velActive);
    assert.ok(linesActive > linesInactive, 'active strike contactFrame ± 1 must add swing half-plane');
    const deflection = Math.hypot(velActive[0] - velInactive[0], velActive[1] - velInactive[1]);
    assert.ok(deflection > 10, `active strike swing must strongly deflect walker, got delta=${deflection.toFixed(2)}`);
    assert.ok(Math.abs(velActive[1]) > Math.abs(velInactive[1]) + 1, 'active strike swing must produce lateral deflection');

    // 2. Static wildlife + FIXTURE_FEET obstacle discs (ORCA_TAU_OBST = 0.45).
    const obstacles = [
        { kind: 'wildlife', x: 80, y: 100, radius: 10, tau: ORCA_TAU_OBST },
        { x: 145, y: 102, xPx: 30, frontPx: 60 }, // FIXTURE_FEET shape: half = 30 - 16 = 14 px
    ];
    const walkerB = { id: 'wB', x: 0, y: 100, vx: 45, vy: 0, targetX: 220, targetY: 100, gaitSpeed: 45 };
    let minWildDist = Infinity;
    let minFixDist = Infinity;

    for (let step = 0; step < 300; step++) {
        stepCrowdOrca([walkerB], dt, obstacles);
        const wd = Math.hypot(walkerB.x - 80, (walkerB.y - 100) * ORCA_Y_SCALE);
        const fd = Math.hypot(walkerB.x - 145, (walkerB.y - 102) * ORCA_Y_SCALE);
        if (wd < minWildDist) minWildDist = wd;
        if (fd < minFixDist) minFixDist = fd;
    }
    assert.ok(Math.hypot(walkerB.x - 220, walkerB.y - 100) < 4, 'walker reached goal past wildlife and fixture');
    assert.ok(minWildDist >= ORCA_AGENT_RADIUS + 10 - 2.0, `wildlife clearance failed: ${minWildDist}`);
    assert.ok(minFixDist >= ORCA_AGENT_RADIUS + 14 - 2.0, `FIXTURE_FEET clearance failed: ${minFixDist}`);
});

test('Wave 6 E2 surfaceTier isolation: tier 0 and tier 2 agents pass over each other with zero deflection', () => {
    const ground = { id: 'canal', x: 0, y: 100, vx: 45, vy: 0, targetX: 140, targetY: 100, gaitSpeed: 45, surfaceTier: 0 };
    const bridge = { id: 'deck', x: 140, y: 100, vx: -45, vy: 0, targetX: 0, targetY: 100, gaitSpeed: 45, surfaceTier: 2 };
    const outVel = new Float64Array(2);

    // Direct solveOrcaVelocity check: 0 half-planes generated across different tiers.
    const lineCountGround = solveOrcaVelocity(ground, 45, 0, [bridge], null, outVel);
    assert.equal(lineCountGround, 0);
    assert.ok(Math.abs(outVel[0] - 45) < 1e-9);
    assert.ok(Math.abs(outVel[1]) < 1e-9);

    const lineCountBridge = solveOrcaVelocity(bridge, -45, 0, [ground], null, outVel);
    assert.equal(lineCountBridge, 0);
    assert.ok(Math.abs(outVel[0] + 45) < 1e-9);
    assert.ok(Math.abs(outVel[1]) < 1e-9);

    // Full pass-through simulation: both cross exact center (70, 100) with zero deflection.
    const dt = 1 / 30;
    let minDist = Infinity;
    for (let step = 0; step < 120; step++) {
        stepCrowdOrca([ground, bridge], dt, null, { contextSteering: false });
        assert.ok(Math.abs(ground.y - 100) < 1e-9, `ground deflected to y=${ground.y}`);
        assert.ok(Math.abs(bridge.y - 100) < 1e-9, `bridge deflected to y=${bridge.y}`);
        const d = Math.hypot(ground.x - bridge.x, ground.y - bridge.y);
        if (d < minDist) minDist = d;
    }
    assert.ok(minDist < 2.0, `expected tier 0 and tier 2 agents to pass directly over each other, minDist=${minDist}`);
    assert.ok(Math.hypot(ground.x - 140, ground.y - 100) < 2);
    assert.ok(Math.hypot(bridge.x - 0, bridge.y - 100) < 2);
});

test('100-agent dense circle swap: 0 stacks < 3 px, 0 stalls > 1.5 s, avg frame < 1.0 ms (target < 0.4 ms)', () => {
    const N = 100;
    // Radius chosen so adjacent perimeter targets clear 2*ORCA_AGENT_RADIUS (23 px)
    // even along Y after ORCA_Y_SCALE = 0.64 (2*pi*R / 100 >= 23 / 0.64 = 35.94 px).
    const radius = 600;
    const speed = 56;
    const dt = 1 / 20; // 50 ms sim step -> 20 steps/s

    const agents = [];
    for (let i = 0; i < N; i++) {
        const theta = (2 * Math.PI * i) / N;
        const x = Math.cos(theta) * radius;
        const y = Math.sin(theta) * radius;
        agents.push({
            id: `a${String(i).padStart(3, '0')}`,
            x,
            y,
            vx: -Math.cos(theta) * speed,
            vy: -Math.sin(theta) * speed,
            targetX: -x,
            targetY: -y,
            gaitSpeed: speed,
            surfaceTier: 0,
            _stallSec: 0,
            _maxStallSec: 0,
        });
    }

    // Warm up JIT cleanly on a separate clone before measuring frame timings.
    const warmup = agents.map(a => ({ ...a }));
    for (let w = 0; w < 40; w++) stepCrowdOrca(warmup, dt);

    const totalSteps = 920; // 46 simulated seconds (unobstructed trip = 1200 / 56 = 21.4 s)
    let solveMsTotal = 0;
    let solveCpuUsTotal = 0;
    let measuredSteps = 0;
    let minPairDistDuringSim = Infinity;

    for (let step = 0; step < totalSteps; step++) {
        const cpuBefore = process.cpuUsage();
        const t0 = performance.now();
        stepCrowdOrca(agents, dt);
        const elapsed = performance.now() - t0;
        const cpuDelta = process.cpuUsage(cpuBefore);
        solveMsTotal += elapsed;
        solveCpuUsTotal += cpuDelta.user + cpuDelta.system;
        measuredSteps++;

        for (let i = 0; i < N; i++) {
            const a = agents[i];
            const rem = Math.hypot(a.targetX - a.x, a.targetY - a.y);
            if (rem > 12) {
                const spd = Math.hypot(a.vx, a.vy);
                if (spd < 2.0) {
                    a._stallSec += dt;
                    if (a._stallSec > a._maxStallSec) a._maxStallSec = a._stallSec;
                } else {
                    a._stallSec = 0;
                }
            }
        }
    }

    let stackedFinal = 0;
    let minFinalDist = Infinity;
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            const d = Math.hypot(agents[i].x - agents[j].x, agents[i].y - agents[j].y);
            if (d < minFinalDist) minFinalDist = d;
            if (d < 3.0) stackedFinal++;
        }
    }
    minPairDistDuringSim = minFinalDist;

    let stalledOverLimit = 0;
    let maxStallSeen = 0;
    let arrivedCount = 0;
    for (let i = 0; i < N; i++) {
        if (agents[i]._maxStallSec > maxStallSeen) maxStallSeen = agents[i]._maxStallSec;
        if (agents[i]._maxStallSec > 1.5) stalledOverLimit++;
        if (Math.hypot(agents[i].targetX - agents[i].x, agents[i].targetY - agents[i].y) < 10) arrivedCount++;
    }

    const avgFrameMs = solveMsTotal / measuredSteps;
    const avgCpuFrameMs = (solveCpuUsTotal / 1000) / measuredSteps;
    console.log(
        `[W5-C ORCA 100-agent circle swap] avgWall=${avgFrameMs.toFixed(4)} ms/frame `
        + `avgCpu=${avgCpuFrameMs.toFixed(4)} ms/frame `
        + `arrived=${arrivedCount}/${N} minFinalDist=${minPairDistDuringSim.toFixed(2)}px `
        + `stacked<3px=${stackedFinal} maxStall=${maxStallSeen.toFixed(2)}s`,
    );

    assert.equal(stackedFinal, 0, `expected 0 bodies stacked < 3 px, got ${stackedFinal} (minDist=${minFinalDist.toFixed(2)})`);
    assert.equal(stalledOverLimit, 0, `expected 0 deadlock stalls > 1.5 s, got ${stalledOverLimit} (maxStall=${maxStallSeen.toFixed(2)}s)`);
    assert.equal(arrivedCount, N, `expected all 100 agents to complete circle swap, got ${arrivedCount}/${N}`);
    assert.ok(avgCpuFrameMs < 1.0, `expected avg 100-agent CPU solve < 1.0 ms/frame, got ${avgCpuFrameMs.toFixed(4)} ms (wall=${avgFrameMs.toFixed(4)} ms)`);
});

// ---------------------------------------------------------------------------
// 3. SlotAuction — Exact Hungarian, > 12 ε-Auction & 15% Hysteresis
// ---------------------------------------------------------------------------

test('buildVisitSlotCost matches exact §3.2 formula and 15% hysteresis prevents slot thrash', () => {
    const base = buildVisitSlotCost({
        flowCost: 5,
        overflow: false,
        relatedClusterBonus: 4,
        facingMatchBonus: 2,
        isCurrentSlot: false,
        bestAltCost: 14,
    });
    assert.equal(base, 5 * 4.0 + 0 - 4 - 2);

    const overflowCost = buildVisitSlotCost({
        flowCost: 5,
        overflow: true,
        relatedClusterBonus: 0,
        facingMatchBonus: 0,
        isCurrentSlot: false,
        bestAltCost: 20,
    });
    assert.equal(overflowCost, 5 * 4.0 + 35);

    // 15% hysteresis anti-thrash test:
    // Agent A holds slot 0 (flowCost 10 -> raw 40); slot 1 opens with slightly
    // better flowCost 9 (raw 36, only 10% better < 15% hysteresis threshold).
    // Agent A MUST stay locked on slot 0. When slot 1 improves to flowCost 7
    // (raw 28, 30% better > 15% threshold), Agent A cleanly switches to slot 1!
    const altSlight = buildVisitSlotCost({ flowCost: 9, isCurrentSlot: false }); // 36
    const holdSlight = buildVisitSlotCost({ flowCost: 10, isCurrentSlot: true, bestAltCost: altSlight }); // 40 - 0.15*36 = 34.6
    const assign = new Int32Array(1);
    solveSlotAssignment(new Float64Array([holdSlight, altSlight]), 1, 2, assign);
    assert.equal(assign[0], 0, `expected 15% hysteresis to keep current slot 0 (${holdSlight} < ${altSlight})`);

    const altBig = buildVisitSlotCost({ flowCost: 7, isCurrentSlot: false }); // 28
    const holdBig = buildVisitSlotCost({ flowCost: 10, isCurrentSlot: true, bestAltCost: altBig }); // 40 - 0.15*28 = 35.8
    solveSlotAssignment(new Float64Array([holdBig, altBig]), 1, 2, assign);
    assert.equal(assign[0], 1, `expected drastic improvement (${altBig} < ${holdBig}) to switch to slot 1`);
});

test('Hungarian solver is exact against brute-force optimal sum on 100 random m x n matrices (m, n <= 7)', () => {
    const rng = mulberry32(0x5c0ca510);
    const out = new Int32Array(7);

    for (let trial = 0; trial < 100; trial++) {
        const m = 1 + Math.floor(rng() * 7);
        const n = 1 + Math.floor(rng() * 7);
        const costs = new Float64Array(m * n);
        for (let k = 0; k < m * n; k++) {
            // Mix positive, zero, and negative costs (including fractional values).
            costs[k] = Math.round((rng() * 140 - 30) * 4) / 4;
        }

        solveSlotAssignment(costs, m, n, out);
        const expectedMin = bruteForceOptimalCost(costs, m, n);
        const actualCost = computeAssignmentCost(costs, m, n, out);

        // Verify valid 1-to-1 matching of size min(m, n).
        const seenSlots = new Set();
        let matched = 0;
        for (let i = 0; i < m; i++) {
            if (out[i] !== -1) {
                assert.ok(out[i] >= 0 && out[i] < n, `invalid slot index ${out[i]}`);
                assert.ok(!seenSlots.has(out[i]), `duplicate slot ${out[i]} on trial ${trial}`);
                seenSlots.add(out[i]);
                matched++;
            }
        }
        assert.equal(matched, Math.min(m, n), `expected ${Math.min(m, n)} matched pairs on trial ${trial}`);
        assert.ok(
            Math.abs(actualCost - expectedMin) < 1e-6,
            `trial ${trial} (${m}x${n}): Hungarian=${actualCost} != bruteForce=${expectedMin}`,
        );
    }
});

test('> 12 deterministic ε-auction (ε = 0.5) matches cleanly, deterministically, and near-optimally', () => {
    assert.equal(SLOT_HUNGARIAN_MAX, 12);
    assert.equal(SLOT_AUCTION_EPSILON, 0.5);

    const rng = mulberry32(0x91a7b3c5);
    const cases = [
        { m: 16, n: 16 },
        { m: 14, n: 20 },
        { m: 20, n: 14 },
    ];

    for (const { m, n } of cases) {
        const costs = new Float64Array(m * n);
        const trueMinPerm = new Int32Array(Math.min(m, n));
        // Build a matrix with a clear planted low-cost diagonal/matching plus noise.
        for (let i = 0; i < m; i++) {
            for (let j = 0; j < n; j++) {
                costs[i * n + j] = 40 + rng() * 60;
            }
        }
        const pairs = Math.min(m, n);
        for (let k = 0; k < pairs; k++) {
            const slot = (k * 5 + 3) % n;
            const agent = (k * 3 + 1) % m;
            // Construct injective planted assignment only when indices are distinct:
            trueMinPerm[k] = k;
            costs[k * n + k] = 2 + rng() * 3;
            void slot;
            void agent;
        }

        const outA = new Int32Array(m);
        const outB = new Int32Array(m);
        solveSlotAssignment(costs, m, n, outA);
        solveSlotAssignment(costs, m, n, outB);

        // Strictly deterministic across identical runs.
        assert.deepEqual(Array.from(outA), Array.from(outB));

        // Valid 1-to-1 matching of size min(m, n).
        const used = new Set();
        let matched = 0;
        for (let i = 0; i < m; i++) {
            if (outA[i] !== -1) {
                assert.ok(outA[i] >= 0 && outA[i] < n);
                assert.ok(!used.has(outA[i]));
                used.add(outA[i]);
                matched++;
            }
        }
        assert.equal(matched, pairs);

        // Total cost stays within Bertsekas' min(m, n) * epsilon bound of planted optimum.
        let plantedCost = 0;
        for (let k = 0; k < pairs; k++) plantedCost += costs[k * n + k];
        const auctionCost = computeAssignmentCost(costs, m, n, outA);
        assert.ok(
            auctionCost <= plantedCost + pairs * SLOT_AUCTION_EPSILON + 1e-6,
            `${m}x${n} auction cost ${auctionCost} exceeded planted+n*eps ${plantedCost + pairs * SLOT_AUCTION_EPSILON}`,
        );
    }
});

// ---------------------------------------------------------------------------
// 4. Shared-Grid Overlay Label Auction (96 px Grid, AttentionPlates, ThoughtColumn)
// ---------------------------------------------------------------------------

test('AttentionPlates precomputed width lookup and sweep-line union-find clustering within 96 px', () => {
    assert.equal(OVERLAY_GRID_CELL, 96);
    assert.equal(ATTENTION_GROUP_RADIUS, 96);
    assert.equal(LABEL_MAX_SPEAKERS, 24);
    assert.equal(LABEL_MAX_CANDIDATES, 30);
    assert.equal(LABEL_AUCTION_EPSILON, 1);
    assert.equal(LABEL_AUCTION_MAX_ITERS, 40);
    assert.equal(LABEL_STICKY_BONUS, -2);
    assert.equal(LABEL_BOUNDS_PENALTY, 1000);

    // Precomputed widths increase cleanly for ageTier >= 1 (age notch cell = 6 px).
    const w0 = getAttentionWordWidth('NEEDS YOU', 0);
    const w1 = getAttentionWordWidth('NEEDS YOU', 1);
    assert.equal(w0, 9 * 8 + 8);
    assert.equal(w1, w0 + 6);
    assert.ok(computeAttentionPlateWidth('NEEDS YOU', 'Atlas 1m', 1) > computeAttentionPlateWidth('ERROR', 'B 5s', 0));

    // Sweep-line union-find within GROUP_RADIUS = 96 px:
    // Beacons 0, 1, 2 form a same-kind chain within 96 px; beacon 3 is different kind at same spot;
    // beacon 4 is same kind but > 96 px away.
    const beacons = [
        { x: 100, y: 200, kind: 'waiting_on_user' },
        { x: 180, y: 210, kind: 'waiting_on_user' }, // dist from 0 = sqrt(6400+100) = 80.6 <= 96
        { x: 260, y: 200, kind: 'waiting_on_user' }, // dist from 1 = 80.6 <= 96 -> transitive chain
        { x: 105, y: 200, kind: 'errored' },         // different kind -> separate cluster
        { x: 420, y: 200, kind: 'waiting_on_user' }, // 160 px away -> separate cluster
    ];
    const clusterIds = new Int32Array(beacons.length);
    const count = clusterAttentionBeacons(beacons, beacons.length, clusterIds);

    assert.equal(count, 3);
    assert.equal(clusterIds[0], clusterIds[1]);
    assert.equal(clusterIds[1], clusterIds[2]);
    assert.notEqual(clusterIds[3], clusterIds[0]);
    assert.notEqual(clusterIds[4], clusterIds[0]);
    assert.notEqual(clusterIds[3], clusterIds[4]);
});

test('Shared-grid label auction: 20 speakers + 6 static plaques + 3 attention plates => 0 overlaps, deterministic, sticky prior prevents oscillation', () => {
    const grid = new OverlayOccupancyGrid({ cellSize: OVERLAY_GRID_CELL });
    const viewport = { left: 8, top: 8, right: 1272, bottom: 712 };

    // Layer 1: 6 static building plaques / Carved Motifs.
    const plaques = [
        { left: 180, top: 140, right: 300, bottom: 162 },
        { left: 460, top: 150, right: 590, bottom: 172 },
        { left: 760, top: 160, right: 890, bottom: 182 },
        { left: 260, top: 380, right: 390, bottom: 402 },
        { left: 600, top: 390, right: 730, bottom: 412 },
        { left: 920, top: 360, right: 1050, bottom: 382 },
    ];

    // Layer 2: 3 AttentionPlates.
    const attentionPlates = [
        { anchorX: 340, tip: 250, word: 'NEEDS YOU', text: 'Atlas 1m', tier: 1 },
        { anchorX: 620, tip: 270, word: 'ERROR', text: 'Forge 12s', tier: 0 },
        { anchorX: 860, tip: 280, word: 'LIMIT', text: 'Scout 4m', tier: 2 },
    ];

    // Layer 3: 20 crowded ThoughtColumn speakers clustered around the plaques and attention plates.
    const speakers = [];
    for (let i = 0; i < 20; i++) {
        const col = i % 5;
        const row = Math.floor(i / 5);
        speakers.push({
            id: `sp-${String(i).padStart(2, '0')}`,
            anchorX: 220 + col * 190 + ((i % 3) - 1) * 28,
            baseY: 220 + row * 95 + ((i % 2) * 14),
            width: 112 + (i % 4) * 14,
            height: 26,
            side: (i % 2 === 0) ? 1 : -1,
            priorCandidate: -1,
        });
    }

    function runFrame(speakerList, outAssign, outThoughtRects, outPlateRects, stats) {
        grid.beginFrame();
        for (let i = 0; i < plaques.length; i++) {
            grid.reserveRect(plaques[i], OVERLAY_LAYER_PLAQUE, i);
        }
        reserveAttentionPlates(grid, attentionPlates, viewport, outPlateRects, 2);
        return solveLabelAuction(grid, speakerList, outAssign, {
            viewport,
            pad: 2,
            outRects: outThoughtRects,
            outStats: stats,
        });
    }

    const assign1 = new Int32Array(20);
    const rects1 = new Float64Array(20 * 4);
    const plateRects1 = new Float64Array(3 * 4);
    const stats1 = { iterations: 0, placed: 0, filtered: 0 };
    const placed1 = runFrame(speakers, assign1, rects1, plateRects1, stats1);

    const assign2 = new Int32Array(20);
    const rects2 = new Float64Array(20 * 4);
    const plateRects2 = new Float64Array(3 * 4);
    const stats2 = { iterations: 0, placed: 0, filtered: 0 };
    const placed2 = runFrame(speakers, assign2, rects2, plateRects2, stats2);

    // 1. Strictly deterministic across identical runs.
    assert.equal(placed1, placed2);
    assert.deepEqual(Array.from(assign1), Array.from(assign2));
    assert.deepEqual(Array.from(rects1), Array.from(rects2));
    assert.equal(placed1, 20, `expected all 20 speakers placed cleanly, got ${placed1}`);
    assert.ok(stats1.iterations <= LABEL_AUCTION_MAX_ITERS, `iterations=${stats1.iterations} exceeded 40`);

    // 2. Collect ALL reserved labels (6 plaques + 3 attention plates + placed speakers) and assert 0 overlap pairs!
    const allRects = [];
    for (let i = 0; i < plaques.length; i++) allRects.push({ kind: `plaque:${i}`, ...plaques[i] });
    for (let i = 0; i < 3; i++) {
        allRects.push({
            kind: `plate:${i}`,
            left: plateRects1[i * 4],
            top: plateRects1[i * 4 + 1],
            right: plateRects1[i * 4 + 2],
            bottom: plateRects1[i * 4 + 3],
        });
    }
    for (let i = 0; i < 20; i++) {
        if (assign1[i] === -1) continue;
        allRects.push({
            kind: `thought:${i}`,
            left: rects1[i * 4],
            top: rects1[i * 4 + 1],
            right: rects1[i * 4 + 2],
            bottom: rects1[i * 4 + 3],
        });
    }

    let overlapPairs = 0;
    for (let i = 0; i < allRects.length; i++) {
        for (let j = i + 1; j < allRects.length; j++) {
            if (rectsStrictlyOverlap(allRects[i], allRects[j], 0)) {
                overlapPairs++;
            }
        }
    }
    assert.equal(overlapPairs, 0, `expected 0 label-overlap pairs across 29 labels, got ${overlapPairs}`);

    // 3. Sticky prior (-2 bonus) prevents oscillation under small frame-to-frame cost/position jitter.
    const stickyGrid = new OverlayOccupancyGrid({ cellSize: OVERLAY_GRID_CELL });
    stickyGrid.beginFrame();
    const stickyAssign = new Int32Array(1);
    const jitterSpeaker = [{
        id: 'jitter',
        priorCandidate: 1,
        candidates: [
            { left: 200, top: 200, right: 300, bottom: 224, cost: 3.0 }, // cheaper by 1.2 without sticky
            { left: 200, top: 172, right: 300, bottom: 196, cost: 4.2 }, // priorCandidate => 4.2 - 2 = 2.2 < 3.0!
        ],
    }];
    solveLabelAuction(stickyGrid, jitterSpeaker, stickyAssign, { viewport });
    assert.equal(stickyAssign[0], 1, 'sticky prior -2 bonus must hold candidate 1 against minor jitter');

    // Without sticky prior, candidate 0 wins.
    stickyGrid.beginFrame();
    jitterSpeaker[0].priorCandidate = -1;
    solveLabelAuction(stickyGrid, jitterSpeaker, stickyAssign, { viewport });
    assert.equal(stickyAssign[0], 0, 'without prior bonus, cheaper candidate 0 must win');

    // 4. Bounds violation penalty (* 1000) keeps boxes strictly inside viewport over cheaper clipped boxes.
    stickyGrid.beginFrame();
    const edgeSpeaker = [{
        id: 'edge',
        priorCandidate: -1,
        candidates: [
            { left: -40, top: 100, right: 60, bottom: 124, cost: 0 },   // 48*24 = 1152 px^2 outside => +1.15M penalty
            { left: 20, top: 100, right: 120, bottom: 124, cost: 12 },  // cleanly inside viewport
        ],
    }];
    solveLabelAuction(stickyGrid, edgeSpeaker, stickyAssign, { viewport });
    assert.equal(stickyAssign[0], 1, 'boundsViolation * 1000 must reject clipped candidate in favor of in-bounds box');
});

test('W5-Fix-C: CrowdOrca coast plane push uses (r - d) / tau without clamping at 0', () => {
    // Agent 20 px from coast (outside radius 11.5, inside CONTEXT_COAST_MARGIN = 28):
    // Coast normal points inland (+X = 1, 0), agent wants to walk toward coast (-X = -12 px/s).
    // Allowed inward approach speed is (20 - 11.5) / 0.45 = 18.89 px/s, so -12 px/s MUST be feasible!
    // (The old Math.max(0, ...) bug forced vx >= 0 at 20 px away like an invisible wall.)
    const agent = { id: 'coastal', x: 20, y: 100, vx: -12, vy: 0, maxSpeed: 45, radius: ORCA_AGENT_RADIUS };
    const outVel = new Float64Array(2);
    const lines = solveOrcaVelocity(agent, -12, 0, null, null, outVel, {
        coastDist: 20,
        coastNormalX: 1,
        coastNormalY: 0,
        maxSpeed: 45,
    });
    assert.equal(lines, 1);
    assert.ok(outVel[0] < -10, `expected unclamped (r - d)/tau to allow approaching coast at -12 px/s, got vx=${outVel[0]}`);

    // When penetrating (coastDist = 5 < radius 11.5), coast plane actively pushes inland (+X > 0).
    const penVel = new Float64Array(2);
    solveOrcaVelocity(agent, -12, 0, null, null, penVel, {
        coastDist: 5,
        coastNormalX: 1,
        coastNormalY: 0,
        maxSpeed: 45,
    });
    assert.ok(penVel[0] >= (ORCA_AGENT_RADIUS - 5) / ORCA_TAU_OBST - 1e-3, `expected positive inland push, got vx=${penVel[0]}`);
});

test('W5-Fix-C: solveLabelAuction enforces strict priority so lower-priority speakers never evict higher-priority holders', () => {
    const grid = new OverlayOccupancyGrid({ cellSize: OVERLAY_GRID_CELL });
    grid.beginFrame();
    const viewport = { left: 0, top: 0, right: 800, bottom: 600 };

    // Selected speaker (priority 30000) has two nearly-tied candidates (small bid price ~1.1).
    // Normal speaker (priority 100) has ONLY one cheap candidate overlapping selected's cand 0,
    // and an expensive candidate 1 (creating a huge bid increment ~50 if eviction were allowed!).
    const speakers = [
        {
            id: 'selected-speaker',
            priority: 30000,
            priorCandidate: -1,
            candidates: [
                { left: 200, top: 200, right: 300, bottom: 220, cost: 0 },
                { left: 200, top: 170, right: 300, bottom: 190, cost: 0.1 },
            ],
        },
        {
            id: 'normal-speaker',
            priority: 100,
            priorCandidate: -1,
            candidates: [
                { left: 205, top: 202, right: 305, bottom: 222, cost: 0 },   // overlaps selected cand 0
                { left: 320, top: 200, right: 420, bottom: 220, cost: 80 }, // free alternative
            ],
        },
    ];
    const assign = new Int32Array(2);
    const placed = solveLabelAuction(grid, speakers, assign, { viewport, pad: 2 });
    assert.equal(placed, 2);
    assert.equal(assign[0], 0, 'selected speaker must keep its winning candidate 0 and never be evicted');
    assert.equal(assign[1], 1, 'lower-priority speaker must treat higher-priority overlap as ineligible and pick candidate 1');

    // Also test when lower-priority speaker has NO alternative at all: must stay unplaced (-1) rather than evict selected!
    grid.beginFrame();
    const singleCand = [
        speakers[0],
        {
            id: 'blocked-normal',
            priority: 100,
            priorCandidate: -1,
            candidates: [
                { left: 205, top: 202, right: 305, bottom: 222, cost: 0 },
            ],
        },
    ];
    const assign2 = new Int32Array(2);
    const placed2 = solveLabelAuction(grid, singleCand, assign2, { viewport, pad: 2 });
    assert.equal(placed2, 1);
    assert.equal(assign2[0], 0, 'selected speaker must never be evicted even when lower-priority speaker has no other slot');
    assert.equal(assign2[1], -1, 'lower-priority speaker with only higher-priority overlapping slot must stay unplaced');
});

// ---------------------------------------------------------------------------
// 5. Design C — Hybrid Bridge Circulation (Same-Span Plane & Two-Way Lanes)
// ---------------------------------------------------------------------------

test('Design C: ORCA_BRIDGE_PASS_RADIUS === 5.0, same-span sharesAvoidancePlane ignores arch supportH, and isOpposingTwoWayBridgePair gates strictly', () => {
    assert.equal(ORCA_BRIDGE_PASS_RADIUS, 5.0);

    // Same bridge span & same surfaceTier => true even with 20 px arch-lift delta.
    const archLow = { surfaceTier: 2, supportH: 4, bridgeSpanId: 'central-river-bridge' };
    const archHigh = { surfaceTier: 2, supportH: 24, bridgeSpanId: 'central-river-bridge' };
    assert.equal(sharesAvoidancePlane(archLow, archHigh), true);
    assert.equal(sharesAvoidancePlane(archHigh, archLow), true);

    // Same bridge span but different surfaceTier => still isolated (false).
    const underDeck = { surfaceTier: 0, supportH: 4, bridgeSpanId: 'central-river-bridge' };
    assert.equal(sharesAvoidancePlane(archLow, underDeck), false);

    // Absent or different bridgeSpanId => preserves strict |supportH_a - supportH_b| < 12 check.
    const noSpanLow = { surfaceTier: 2, supportH: 4, bridgeSpanId: null };
    const noSpanHigh = { surfaceTier: 2, supportH: 24, bridgeSpanId: null };
    const otherSpanHigh = { surfaceTier: 2, supportH: 24, bridgeSpanId: 'west-footbridge' };
    assert.equal(sharesAvoidancePlane(noSpanLow, noSpanHigh), false);
    assert.equal(sharesAvoidancePlane(archLow, noSpanHigh), false);
    assert.equal(sharesAvoidancePlane(archLow, otherSpanHigh), false);
    assert.equal(sharesAvoidancePlane({ surfaceTier: 0, supportH: 0 }, { surfaceTier: 0, supportH: 20 }), false);
    assert.equal(sharesAvoidancePlane({ surfaceTier: 0, supportH: 0 }, { surfaceTier: 0, supportH: 11 }), true);

    // isOpposingTwoWayBridgePair gate checks.
    const north = {
        bridgeSpanId: 'central-river-bridge',
        bridgeMode: 'two-way',
        bridgeDir: 1,
        bridgeZone: 'deck',
        planted: false,
    };
    const south = {
        bridgeSpanId: 'central-river-bridge',
        bridgeMode: 'two-way',
        bridgeDir: -1,
        bridgeZone: 'landing',
        planted: false,
    };
    assert.equal(isOpposingTwoWayBridgePair(north, south), true);
    assert.equal(isOpposingTwoWayBridgePair(south, north), true);
    assert.equal(isOpposingTwoWayBridgePair(north, { ...south, bridgeZone: 'deck' }), true);
    assert.equal(isOpposingTwoWayBridgePair({ ...north, bridgeZone: 'landing' }, south), true);
    assert.equal(isOpposingTwoWayBridgePair(north, { ...south, bridgeDir: 1 }), false);
    assert.equal(isOpposingTwoWayBridgePair(north, { ...south, bridgeDir: 0 }), false);
    assert.equal(isOpposingTwoWayBridgePair({ ...north, bridgeDir: null }, { ...south, bridgeDir: 0 }), false);
    assert.equal(isOpposingTwoWayBridgePair(north, { ...south, bridgeMode: 'platoon' }), false);
    assert.equal(isOpposingTwoWayBridgePair(north, { ...south, bridgeSpanId: 'other-span' }), false);
    assert.equal(isOpposingTwoWayBridgePair(north, { ...south, bridgeZone: 'approach' }), false);
    assert.equal(isOpposingTwoWayBridgePair(north, { ...south, planted: true }), false);
});

test('Design C: two-way NS bridge opposing lanes (±8 px) pass at full gait speed without lateral blowout, while same-direction walkers keep full 23 px headway', () => {
    // 2:1 isometric NS bridge axis (along +tileY, perp +tileX):
    // 16 world px across perp = 11.6227 px in ORCA-scaled space (10.904 px perpendicular to along_s).
    const invSqrt5 = 1 / Math.sqrt(5);
    const alongX = -2 * invSqrt5;
    const alongY = 1 * invSqrt5;
    const perpX = 1 * invSqrt5;
    const perpY = 2 * invSqrt5;

    const toWorld = (s, offset) => ({
        x: s * alongX + offset * perpX,
        y: s * alongY + offset * perpY,
    });
    const crossOffsetOf = (agent) => agent.x * perpX + agent.y * perpY;

    // Verify exact 16 world px -> ~11.62 px ORCA-scaled lane spacing.
    const laneNeg = toWorld(0, -8);
    const lanePos = toWorld(0, 8);
    const laneScaledSep = Math.hypot(lanePos.x - laneNeg.x, (lanePos.y - laneNeg.y) * ORCA_Y_SCALE);
    assert.ok(Math.abs(laneScaledSep - 11.6227) < 0.01, `expected 11.62 px ORCA-scaled lane separation, got ${laneScaledSep}`);

    // 1. Two opposing walkers in dedicated ±8 px lanes on a two-way NS bridge.
    const speed = 45;
    const startA = toWorld(-90, -8);
    const targetA = toWorld(90, -8);
    const startB = toWorld(90, 8);
    const targetB = toWorld(-90, 8);

    const walkerA = {
        id: 'bridge-southbound',
        x: startA.x,
        y: startA.y,
        vx: alongX * speed,
        vy: alongY * speed,
        targetX: targetA.x,
        targetY: targetA.y,
        gaitSpeed: speed,
        surfaceTier: 2,
        supportH: 6,
        bridgeSpanId: 'central-river-bridge',
        bridgeMode: 'two-way',
        bridgeDir: 1,
        bridgeZone: 'deck',
        bridgePerpX: perpX,
        bridgePerpY: perpY,
        bridgeCrossOffset: -8,
    };
    const walkerB = {
        id: 'bridge-northbound',
        x: startB.x,
        y: startB.y,
        vx: -alongX * speed,
        vy: -alongY * speed,
        targetX: targetB.x,
        targetY: targetB.y,
        gaitSpeed: speed,
        surfaceTier: 2,
        supportH: 22, // 16 px arch delta still shares avoidance plane on same bridgeSpanId
        bridgeSpanId: 'central-river-bridge',
        bridgeMode: 'two-way',
        bridgeDir: -1,
        bridgeZone: 'deck',
        bridgePerpX: perpX,
        bridgePerpY: perpY,
        bridgeCrossOffset: 8,
    };

    const dt = 1 / 30;
    let minAbsCross = Infinity;
    let maxAbsCross = -Infinity;
    let minActiveSpeed = Infinity;
    let minScaledDist = Infinity;

    for (let step = 0; step < 180; step++) {
        walkerA.bridgeCrossOffset = crossOffsetOf(walkerA);
        walkerB.bridgeCrossOffset = crossOffsetOf(walkerB);
        stepCrowdOrca([walkerA, walkerB], dt);

        const absA = Math.abs(crossOffsetOf(walkerA));
        const absB = Math.abs(crossOffsetOf(walkerB));
        if (absA < minAbsCross) minAbsCross = absA;
        if (absB < minAbsCross) minAbsCross = absB;
        if (absA > maxAbsCross) maxAbsCross = absA;
        if (absB > maxAbsCross) maxAbsCross = absB;

        if (Math.hypot(walkerA.targetX - walkerA.x, walkerA.targetY - walkerA.y) > 12) {
            const spdA = Math.hypot(walkerA.vx, walkerA.vy);
            if (spdA < minActiveSpeed) minActiveSpeed = spdA;
        }
        if (Math.hypot(walkerB.targetX - walkerB.x, walkerB.targetY - walkerB.y) > 12) {
            const spdB = Math.hypot(walkerB.vx, walkerB.vy);
            if (spdB < minActiveSpeed) minActiveSpeed = spdB;
        }
        const sDist = Math.hypot(walkerA.x - walkerB.x, (walkerA.y - walkerB.y) * ORCA_Y_SCALE);
        if (sDist < minScaledDist) minScaledDist = sDist;
    }

    assert.ok(Math.hypot(walkerA.x - targetA.x, walkerA.y - targetA.y) < 4, `walkerA reached far end, got (${walkerA.x.toFixed(1)}, ${walkerA.y.toFixed(1)})`);
    assert.ok(Math.hypot(walkerB.x - targetB.x, walkerB.y - targetB.y) < 4, `walkerB reached far end, got (${walkerB.x.toFixed(1)}, ${walkerB.y.toFixed(1)})`);
    assert.ok(minAbsCross >= 6 && maxAbsCross <= 11, `expected |crossOffset| inside [6, 11] px without lateral blowout, got [${minAbsCross.toFixed(2)}, ${maxAbsCross.toFixed(2)}]`);
    assert.ok(minActiveSpeed >= speed - 2.0, `expected full gait speed passing with zero stall (>= ${speed - 2}), got minSpeed=${minActiveSpeed.toFixed(2)}`);
    assert.ok(minScaledDist >= ORCA_BRIDGE_PASS_RADIUS * 2 - 0.5, `expected clean scaled passing margin, got minScaledDist=${minScaledDist.toFixed(2)}`);

    // 2. Two same-direction walkers on the same lane keep full 2 * ORCA_AGENT_RADIUS (23 px) headway.
    const leaderStart = toWorld(-10, -8);
    const followerStart = toWorld(-50, -8);
    const sameTarget = toWorld(140, -8);
    const leader = {
        id: 'bridge-leader',
        x: leaderStart.x,
        y: leaderStart.y,
        vx: alongX * 18,
        vy: alongY * 18,
        targetX: sameTarget.x,
        targetY: sameTarget.y,
        gaitSpeed: 18,
        surfaceTier: 2,
        supportH: 8,
        bridgeSpanId: 'central-river-bridge',
        bridgeMode: 'two-way',
        bridgeDir: 1,
        bridgeZone: 'deck',
        bridgePerpX: perpX,
        bridgePerpY: perpY,
        bridgeCrossOffset: -8,
    };
    const follower = {
        id: 'bridge-follower',
        x: followerStart.x,
        y: followerStart.y,
        vx: alongX * speed,
        vy: alongY * speed,
        targetX: sameTarget.x,
        targetY: sameTarget.y,
        gaitSpeed: speed,
        surfaceTier: 2,
        supportH: 20,
        bridgeSpanId: 'central-river-bridge',
        bridgeMode: 'two-way',
        bridgeDir: 1,
        bridgeZone: 'deck',
        bridgePerpX: perpX,
        bridgePerpY: perpY,
        bridgeCrossOffset: -8,
    };

    let minSameDirScaledDist = Infinity;
    for (let step = 0; step < 150; step++) {
        leader.bridgeCrossOffset = crossOffsetOf(leader);
        follower.bridgeCrossOffset = crossOffsetOf(follower);
        stepCrowdOrca([leader, follower], dt, null, { contextSteering: false });
        const sDist = Math.hypot(leader.x - follower.x, (leader.y - follower.y) * ORCA_Y_SCALE);
        if (sDist < minSameDirScaledDist) minSameDirScaledDist = sDist;
    }

    assert.ok(
        minSameDirScaledDist >= ORCA_AGENT_RADIUS * 2 - 1.0,
        `expected same-direction bridge walkers to keep full 23 px scaled headway, got minScaledDist=${minSameDirScaledDist.toFixed(2)}`,
    );
});
