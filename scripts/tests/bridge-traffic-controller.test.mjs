import test from 'node:test';
import assert from 'node:assert/strict';

import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import {
    BridgeTrafficController,
    PLATOON_MAX_HOLD_MS,
    PLATOON_MAX_WAVE,
    PLATOON_ENTRY_ZONE_TILES,
    PLATOON_EXIT_CLEAR_TILES,
    PLATOON_STALL_TIMEOUT_MS,
    TWO_WAY_COURTESY_MAX_MS,
} from '../../claudeville/src/presentation/character-mode/BridgeTrafficController.js';

function createLiveBridgeTiles() {
    const scenery = new SceneryEngine({
        world: null,
        terrainSeed: 1,
        tileNoise: () => 0.5,
    });
    scenery.generateBridges();
    return scenery.getBridgeTiles();
}

function makeAgent(id, tileX, tileY, targetTileX, targetTileY, options = {}) {
    const pos = tileToWorld(tileX, tileY);
    const hasTarget = Number.isFinite(targetTileX) && Number.isFinite(targetTileY);
    const target = hasTarget ? tileToWorld(targetTileX, targetTileY) : { x: NaN, y: NaN };
    const waypoints = Array.isArray(options.waypointTiles)
        ? options.waypointTiles.map(([wx, wy]) => tileToWorld(wx, wy))
        : (hasTarget ? [{ x: target.x, y: target.y }] : []);

    const sprite = options.sprite === null
        ? null
        : {
            moving: options.moving ?? true,
            waypoints,
            _bridgeHoldMs: options.holdMs ?? 0,
            ...(options.sprite || {}),
        };

    const offsetPx = options.crossOffsetPx || 0;
    const span = options.span || null;
    const x = pos.x + (span ? span.perpX * offsetPx : 0);
    const y = pos.y + (span ? span.perpY * offsetPx : 0);

    return {
        id,
        x,
        y,
        targetX: target.x + (span ? span.perpX * offsetPx : 0),
        targetY: target.y + (span ? span.perpY * offsetPx : 0),
        vx: options.vx ?? 0,
        vy: options.vy ?? 0,
        planted: options.planted ?? false,
        sprite,
    };
}

function setAgentTile(desc, tileX, tileY, targetTileX, targetTileY, span = null, crossOffsetPx = 0) {
    const pos = tileToWorld(tileX, tileY);
    desc.x = pos.x + (span ? span.perpX * crossOffsetPx : 0);
    desc.y = pos.y + (span ? span.perpY * crossOffsetPx : 0);
    if (Number.isFinite(targetTileX) && Number.isFinite(targetTileY)) {
        const target = tileToWorld(targetTileX, targetTileY);
        desc.targetX = target.x + (span ? span.perpX * crossOffsetPx : 0);
        desc.targetY = target.y + (span ? span.perpY * crossOffsetPx : 0);
        if (desc.sprite) {
            if (desc.sprite.waypoints?.length === 1) {
                desc.sprite.waypoints[0].x = desc.targetX;
                desc.sprite.waypoints[0].y = desc.targetY;
            } else {
                desc.sprite.waypoints = [{ x: desc.targetX, y: desc.targetY }];
            }
        }
    }
}

test('discovers live village spans from SceneryEngine.getBridgeTiles and skips harbor docks', () => {
    const bridgeTiles = createLiveBridgeTiles();
    const controller = new BridgeTrafficController({ bridgeTiles });

    assert.equal(controller.spans.length, 4, 'must discover all 4 walkable village crossings');

    const central = controller.getSpan('central-river-bridge');
    assert.ok(central);
    assert.equal(central.orientation, 'NS');
    assert.equal(central.kind, 'landmark');
    assert.equal(central.circulationMode, 'two-way');
    assert.equal(central.minAlong, 23);
    assert.equal(central.maxAlong, 25);
    assert.equal(central.centerCross, 18);
    assert.equal(central.halfCrossWidth, 0.55);
    assert.equal(central.laneOffsetPx, 8);
    assert.equal(central.landingLaneOffsetPx, 4);
    assert.ok(Math.abs(Math.hypot(central.tangentX, central.tangentY) - 1) < 1e-9);
    assert.ok(Math.abs(central.tangentX * central.perpX + central.tangentY * central.perpY) < 1e-9);

    const west = controller.getSpan('west-river-plank');
    assert.ok(west);
    assert.equal(west.orientation, 'NS');
    assert.equal(west.kind, 'landmark');
    assert.equal(west.circulationMode, 'platoon');
    assert.equal(west.minAlong, 23);
    assert.equal(west.maxAlong, 26);
    assert.equal(west.centerCross, 7);
    assert.equal(west.laneOffsetPx, 6);
    assert.equal(west.landingLaneOffsetPx, 0);

    const pond = controller.getSpan('command-pond-plank');
    assert.ok(pond);
    assert.equal(pond.orientation, 'EW');
    assert.equal(pond.kind, 'plank');
    assert.equal(pond.circulationMode, 'platoon');
    assert.equal(pond.minAlong, 16);
    assert.equal(pond.maxAlong, 17);
    assert.equal(pond.centerCross, 22);

    const farm = controller.getSpan('north-farm-bridge');
    assert.ok(farm);
    assert.equal(farm.orientation, 'NS');
    assert.equal(farm.kind, 'plank');
    assert.equal(farm.circulationMode, 'platoon');
    assert.equal(farm.minAlong, 5);
    assert.equal(farm.maxAlong, 10);
    assert.equal(farm.centerCross, 3);

    // Tile lookups match walkable deck tiles and ignore decorative wings and harbor docks.
    assert.equal(controller.getSpanForTile(18, 24), central);
    assert.equal(controller.getSpanForTile(17, 24), null, 'non-walkable wing must be ignored');
    assert.equal(controller.getSpanForTile(19, 24), null, 'non-walkable wing must be ignored');
    assert.equal(controller.getSpanForTile(7, 25), west);
    assert.equal(controller.getSpanForTile(17, 22), pond);
    assert.equal(controller.getSpanForTile(3, 7), farm);
    assert.equal(controller.getSpanForTile(29, 20), null, 'harbor docks must be skipped');
    assert.equal(controller.getSpanForTile(30, 19), null, 'harbor docks must be skipped');

    // Fallback id when bridgeId is absent.
    const customTiles = new Map([
        ['10,12', { orientation: 'EW', kind: 'plank', walkable: true }],
        ['11,12', { orientation: 'EW', kind: 'plank', walkable: true }],
        ['20,20', { orientation: 'EW', kind: 'dock', walkable: true }],
    ]);
    const customCtrl = new BridgeTrafficController({ bridgeTiles: customTiles });
    assert.equal(customCtrl.spans.length, 1);
    assert.equal(customCtrl.spans[0].id, 'plank:EW:10,12');
    assert.equal(customCtrl.spans[0].circulationMode, 'platoon');
});

test('central-river-bridge allows simultaneous two-way traffic on opposing lanes without holding', () => {
    const controller = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const central = controller.getSpan('central-river-bridge');
    const offset = central.laneOffsetPx;

    const southWalker = makeAgent('south', 18, 23.4, 18, 26, { span: central, crossOffsetPx: offset });
    const northWalker = makeAgent('north', 18, 24.6, 18, 22, { span: central, crossOffsetPx: -offset });
    const southApproacher = makeAgent('south-app', 18, 22.0, 18, 26, { span: central, crossOffsetPx: 0 });
    const northApproacher = makeAgent('north-app', 18, 26.0, 18, 22, { span: central, crossOffsetPx: 0 });
    const agents = [southWalker, northWalker, southApproacher, northApproacher];

    controller.update(agents, agents.length, 16.67);

    assert.equal(southWalker.bridgeSpanId, 'central-river-bridge');
    assert.equal(southWalker.bridgeMode, 'two-way');
    assert.equal(southWalker.bridgeDir, 1);
    assert.equal(southWalker.bridgeZone, 'deck');
    assert.equal(southWalker.bridgeLaneOffset, central.laneOffsetPx);
    assert.equal(southWalker.bridgeHold, false);
    assert.ok(southWalker.bridgeCrossOffset > 0);
    assert.ok(southWalker.bridgeProgress > 0 && southWalker.bridgeProgress < 1);

    assert.equal(northWalker.bridgeSpanId, 'central-river-bridge');
    assert.equal(northWalker.bridgeMode, 'two-way');
    assert.equal(northWalker.bridgeDir, -1);
    assert.equal(northWalker.bridgeZone, 'deck');
    assert.equal(northWalker.bridgeLaneOffset, central.laneOffsetPx);
    assert.equal(northWalker.bridgeHold, false);
    assert.ok(northWalker.bridgeCrossOffset < 0);
    assert.ok(northWalker.bridgeProgress > 0 && northWalker.bridgeProgress < 1);

    assert.equal(southApproacher.bridgeZone, 'landing');
    assert.equal(southApproacher.bridgeLaneOffset, central.landingLaneOffsetPx);
    assert.equal(southApproacher.bridgeHold, false);
    assert.equal(northApproacher.bridgeZone, 'landing');
    assert.equal(northApproacher.bridgeLaneOffset, central.landingLaneOffsetPx);
    assert.equal(northApproacher.bridgeHold, false);
    assert.equal(central.straddleNeg, false);
    assert.equal(central.straddlePos, false);

    // If a northbound walker exiting at the north stair mouth straddles into the
    // southbound lane, the southbound approacher yields briefly up to TWO_WAY_COURTESY_MAX_MS.
    const straddler = makeAgent('straddler', 18, 23.0, 18, 21, { span: central, crossOffsetPx: 6 });
    const enteringSouth = makeAgent('enter-south', 18, 21.8, 18, 26);
    const straddlePair = [straddler, enteringSouth];

    controller.update(straddlePair, straddlePair.length, 200);
    assert.equal(central.exitingNeg, true);
    assert.equal(central.straddleNeg, true);
    assert.equal(enteringSouth.bridgeHold, true);
    assert.equal(enteringSouth.sprite._bridgeHoldMs, 200);

    // Advance past TWO_WAY_COURTESY_MAX_MS; hold must cap and stay released without oscillating.
    for (let step = 0; step < 5; step++) {
        controller.update(straddlePair, straddlePair.length, 200);
    }
    assert.equal(enteringSouth.sprite._bridgeHoldMs, TWO_WAY_COURTESY_MAX_MS);

    controller.update(straddlePair, straddlePair.length, 200);
    assert.equal(enteringSouth.bridgeHold, false, 'courtesy hold must release after TWO_WAY_COURTESY_MAX_MS');
    assert.equal(enteringSouth.sprite._bridgeHoldMs, 0);

    controller.update(straddlePair, straddlePair.length, 200);
    assert.equal(enteringSouth.bridgeHold, false, 'courtesy hold must not oscillate back on');
});

test('west-river-plank enforces platoon lock, admits same-direction followers, drains against starvation, and flips fairly', () => {
    const controller = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const west = controller.getSpan('west-river-plank');

    // 1. First southbound walker claims direction +1; opposing northbound approacher holds.
    const southLead = makeAgent('south-lead', 7, 23.2, 7, 27);
    const northWaiter = makeAgent('north-wait', 7, 27.2, 7, 22);
    const southFollower = makeAgent('south-follow', 7, 22.0, 7, 27);
    const agents = [southLead, northWaiter, southFollower];

    controller.update(agents, agents.length, 100);
    assert.equal(west.activeDir, 1);
    assert.equal(southLead.bridgeZone, 'deck');
    assert.equal(southLead.bridgeHold, false);
    assert.equal(southFollower.bridgeHold, false, 'same-direction follower joins active platoon');
    assert.equal(northWaiter.bridgeHold, true, 'opposing approacher must hold');
    assert.equal(northWaiter.sprite._bridgeHoldMs, 100);

    // Simulate renderer pausing the held walker (`planted: true` while `sprite.moving: true`).
    northWaiter.planted = true;
    controller.update(agents, agents.length, 100);
    assert.equal(northWaiter.bridgeHold, true, 'held moving walker must remain held');
    assert.equal(west.waitingNeg, 1, 'held moving walker must stay counted as waiting');

    // 2. Anti-starvation: advance leader slowly on deck past PLATOON_MAX_HOLD_MS.
    const stepMs = 500;
    let y = 23.4;
    for (let elapsed = 200; elapsed < PLATOON_MAX_HOLD_MS; elapsed += stepMs) {
        y += 0.25;
        setAgentTile(southLead, 7, y, 7, 27);
        controller.update(agents, agents.length, stepMs);
    }
    assert.equal(west.draining, true, 'span must enter draining once PLATOON_MAX_HOLD_MS elapses');
    assert.equal(southLead.bridgeHold, false, 'walker already on deck must NEVER be held');
    assert.equal(southFollower.bridgeHold, true, 'new same-direction approacher must hold during drain');
    assert.equal(northWaiter.bridgeHold, true, 'opposing waiter holds until deck clears');

    // 3. Departing walker within PLATOON_EXIT_CLEAR_TILES of deck end (26.5) has not cleared yet.
    setAgentTile(southLead, 7, 26.5 + PLATOON_EXIT_CLEAR_TILES * 0.5, 7, 28);
    controller.update(agents, agents.length, 100);
    assert.equal(west.activeDir, 1, 'departing walker inside exit-clear margin still holds deck');
    assert.equal(southLead.bridgeHold, false);
    assert.equal(northWaiter.bridgeHold, true);

    // 4. Once leader clears past PLATOON_EXIT_CLEAR_TILES, deck empties and flips to -1!
    setAgentTile(southLead, 7, 26.5 + PLATOON_EXIT_CLEAR_TILES + 0.15, 7, 29);
    controller.update(agents, agents.length, 100);
    assert.equal(west.activeCount, 0);
    assert.equal(west.draining, false);
    assert.equal(west.activeDir, -1, 'span must flip to waiting opposing direction');
    assert.equal(west.lastActiveDir, -1);
    assert.equal(northWaiter.bridgeHold, false, 'opposing waiter is released to cross');
    assert.equal(southFollower.bridgeHold, true, 'south follower now waits for the -1 wave');

    // 5. While released northWaiter walks from approach onto deck (empty deck for several frames),
    // direction must stay stable (-1) instead of strobing back to +1.
    northWaiter.planted = false;
    setAgentTile(northWaiter, 7, 27.0, 7, 22);
    controller.update(agents, agents.length, 16.67);
    assert.equal(west.activeDir, -1, 'must not strobe direction while granted walker walks onto deck');
    assert.equal(northWaiter.bridgeHold, false);

    // 6. Strict fairness alternation: northWaiter crosses and clears -> flips back to +1!
    setAgentTile(northWaiter, 7, 24.5, 7, 22);
    controller.update(agents, agents.length, 100);
    assert.equal(west.deckCountNeg, 1);
    const northFollower = makeAgent('north-follow', 7, 27.3, 7, 22);
    agents.push(northFollower);

    setAgentTile(northWaiter, 7, 21.8, 7, 20);
    controller.update(agents, agents.length, 100);
    assert.equal(west.activeDir, 1, 'must alternate back to -lastActiveDir (+1) when both sides wait');
    assert.equal(southFollower.bridgeHold, false);
    assert.equal(northFollower.bridgeHold, true);
});

test('platoon wave cap and stall failsafe trigger draining to prevent deadlocks', () => {
    const controller = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const west = controller.getSpan('west-river-plank');

    // Wave cap: PLATOON_MAX_WAVE simultaneous walkers on deck + 1 opposing waiter -> draining immediately.
    const waveAgents = [];
    for (let i = 0; i < PLATOON_MAX_WAVE; i++) {
        waveAgents.push(makeAgent(`w-${i}`, 7, 23 + i * 0.65, 7, 28));
    }
    const follower = makeAgent('w-follow', 7, 22.0, 7, 28);
    const opposing = makeAgent('w-opp', 7, 27.2, 7, 22);
    waveAgents.push(follower, opposing);

    controller.update(waveAgents, waveAgents.length, 50);
    assert.equal(west.deckCountPos, PLATOON_MAX_WAVE);
    assert.equal(west.admittedInWave, PLATOON_MAX_WAVE);
    assert.equal(west.draining, true, 'reaching PLATOON_MAX_WAVE while opposing waits must drain');
    assert.equal(follower.bridgeHold, true);
    assert.equal(opposing.bridgeHold, true);

    // Stall failsafe on north-farm-bridge: one stuck walker making zero progress for PLATOON_STALL_TIMEOUT_MS.
    const farm = controller.getSpan('north-farm-bridge');
    const stuck = makeAgent('stuck', 3, 7.0, 3, 11);
    const behind = makeAgent('behind', 3, 4.0, 3, 11);
    const stallGroup = [stuck, behind];

    // First frame establishes baseline progressSum.
    controller.update(stallGroup, stallGroup.length, 100);
    assert.equal(farm.draining, false);
    assert.equal(behind.bridgeHold, false);

    // Advance without moving `stuck` until PLATOON_STALL_TIMEOUT_MS elapses.
    const steps = Math.ceil(PLATOON_STALL_TIMEOUT_MS / 500);
    for (let s = 0; s < steps; s++) {
        controller.update(stallGroup, stallGroup.length, 500);
    }
    assert.equal(farm.draining, true, 'zero forward progress past PLATOON_STALL_TIMEOUT_MS must trigger draining');
    assert.equal(stuck.bridgeHold, false, 'deck walker is never held');
    assert.equal(behind.bridgeHold, true, 'approacher holds while stalled span drains');
});

test('bystanders walking parallel along the riverbank are never falsely held, and junctions resolve by route axis', () => {
    const controller = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const west = controller.getSpan('west-river-plank');

    // Northbound walker actively occupies west-river-plank so southbound approaches must hold.
    const crossingNorth = makeAgent('cross-north', 7, 24.5, 7, 22);
    // Bystander 1: walks straight east-west across the north bank right over (7, 22).
    const bankWalker = makeAgent('bank-ew', 7, 22.0, 12, 22.0);
    // Bystander 2: walks slightly diagonally along the north bank near the approach band without entering the deck.
    const diagBystander = makeAgent('bank-diag', 6.2, 21.6, 10.5, 22.2);
    // Real southbound approacher turning from (6.2, 22.0) onto the bridge via waypoints.
    const turningCrosser = makeAgent('turn-cross', 6.2, 22.0, 7, 22, {
        waypointTiles: [[7, 22], [7, 23], [7, 26], [7, 27]],
    });

    const agents = [crossingNorth, bankWalker, diagBystander, turningCrosser];
    controller.update(agents, agents.length, 100);

    assert.equal(west.activeDir, -1);
    assert.equal(bankWalker.bridgeHold, false, 'east-west bank pedestrian must never be held');
    assert.equal(bankWalker.bridgeSpanId, null);
    assert.equal(diagBystander.bridgeHold, false, 'diagonal riverbank bystander must never be held');
    assert.equal(diagBystander.bridgeSpanId, null);
    assert.equal(turningCrosser.bridgeSpanId, 'west-river-plank');
    assert.equal(turningCrosser.bridgeZone, 'approach');
    assert.equal(turningCrosser.bridgeDir, 1);
    assert.equal(turningCrosser.bridgeHold, true, 'actual turning crosser must hold for opposing platoon');
    assert.equal(west.waitingPos, 1, 'only the true crosser should be counted as waitingPos');

    // Multi-span junction at (18, 22): shared by central-river-bridge and command-pond-plank.
    const turningWestOntoPond = makeAgent('junc-west', 18, 22, 17, 22, {
        waypointTiles: [[17, 22], [16, 22], [15, 22]],
    });
    const headingSouthOntoCentral = makeAgent('junc-south', 18, 22, 18, 23, {
        waypointTiles: [[18, 23], [18, 24], [18, 26]],
    });
    const onPondDeckTurningSouth = makeAgent('pond-deck-turn', 17, 22, 18, 22, {
        waypointTiles: [[18, 22], [18, 23], [18, 26]],
    });
    const juncAgents = [turningWestOntoPond, headingSouthOntoCentral, onPondDeckTurningSouth];

    controller.update(juncAgents, juncAgents.length, 16.67);
    assert.equal(turningWestOntoPond.bridgeSpanId, 'command-pond-plank');
    assert.equal(turningWestOntoPond.bridgeZone, 'landing');
    assert.equal(turningWestOntoPond.bridgeDir, -1);

    assert.equal(headingSouthOntoCentral.bridgeSpanId, 'central-river-bridge');
    assert.equal(headingSouthOntoCentral.bridgeZone, 'landing');
    assert.equal(headingSouthOntoCentral.bridgeDir, 1);

    assert.equal(onPondDeckTurningSouth.bridgeSpanId, 'command-pond-plank');
    assert.equal(onPondDeckTurningSouth.bridgeZone, 'deck', 'deck must beat approach on another span');
    assert.equal(onPondDeckTurningSouth.bridgeHold, false);
});

test('command-pond-plank eastbound approachers yield briefly to northbound central-river-bridge exits', () => {
    const controller = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const central = controller.getSpan('central-river-bridge');
    const pond = controller.getSpan('command-pond-plank');

    const centralNorthExit = makeAgent('central-exit', 18, 23.0, 18, 21.0);
    const pondEastLanding = makeAgent('pond-east-land', 15.0, 22.0, 19.0, 22.0);
    const pondEastApproach = makeAgent('pond-east-app', 15.5 - PLATOON_ENTRY_ZONE_TILES + 0.1, 22.0, 19.0, 22.0);
    const pondOnDeck = makeAgent('pond-on-deck', 16.5, 22.0, 19.0, 22.0);
    const agents = [centralNorthExit, pondEastLanding, pondEastApproach];

    // Step 1: central northbound exit sets exitingNeg -> eastbound pond approachers yield.
    controller.update(agents, agents.length, 300);
    assert.equal(central.exitingNeg, true);
    assert.equal(pond.activeDir, 1);
    assert.equal(pondEastLanding.bridgeHold, true, 'eastbound approacher at landing yields at T-junction');
    assert.equal(pondEastApproach.bridgeHold, true, 'eastbound approacher in entry zone yields at T-junction');
    assert.equal(pondEastLanding.sprite._bridgeHoldMs, 300);

    // Walker already on command-pond-plank deck must NEVER be held.
    controller.update([centralNorthExit, pondOnDeck], 2, 100);
    assert.equal(pondOnDeck.bridgeZone, 'deck');
    assert.equal(pondOnDeck.bridgeHold, false);

    // Step up to TWO_WAY_COURTESY_MAX_MS (total 1200ms).
    controller.update(agents, agents.length, 300);
    controller.update(agents, agents.length, 300);
    controller.update(agents, agents.length, 300);
    assert.equal(pondEastLanding.bridgeHold, true);
    assert.equal(pondEastLanding.sprite._bridgeHoldMs, TWO_WAY_COURTESY_MAX_MS);

    // Next tick exceeds TWO_WAY_COURTESY_MAX_MS -> courtesy releases cleanly and stays released.
    controller.update(agents, agents.length, 100);
    assert.equal(pondEastLanding.bridgeHold, false, 'T-junction courtesy must cap at TWO_WAY_COURTESY_MAX_MS');
    assert.equal(pondEastApproach.bridgeHold, false);
    assert.equal(pondEastLanding.sprite._bridgeHoldMs, 0);

    controller.update(agents, agents.length, 100);
    assert.equal(pondEastLanding.bridgeHold, false, 'courtesy must not re-trigger while same exit persists');

    // A brief 100ms gap in the exit stream must NOT re-arm courtesy (prevents
    // continuous-stream starvation after 1-frame gaps).
    setAgentTile(centralNorthExit, 18, 20.0, 18, 18.0);
    controller.update(agents, agents.length, 100);
    assert.equal(central.exitingNeg, false);

    setAgentTile(centralNorthExit, 18, 23.0, 18, 21.0);
    controller.update(agents, agents.length, 100);
    assert.equal(central.exitingNeg, true);
    assert.equal(pondEastLanding.bridgeHold, false, 'brief gap must not immediately re-arm courtesy');

    // Once the exit remains continuously clear for TWO_WAY_COURTESY_MAX_MS, courtesy re-arms.
    setAgentTile(centralNorthExit, 18, 20.0, 18, 18.0);
    for (let step = 0; step < 6; step++) {
        controller.update(agents, agents.length, 200);
    }
    assert.equal(central.exitingNeg, false);

    setAgentTile(centralNorthExit, 18, 23.0, 18, 21.0);
    controller.update(agents, agents.length, 100);
    assert.equal(central.exitingNeg, true);
    assert.equal(pondEastLanding.bridgeHold, true, 'courtesy re-arms after continuous clear cooldown');
});

test('idle planted deck body never holds platoon lock, wave cap counts cumulative admissions, courtesy clock stays isolated, and reverse T-junction drains', () => {
    const controller = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const west = controller.getSpan('west-river-plank');
    const pond = controller.getSpan('command-pond-plank');
    const central = controller.getSpan('central-river-bridge');

    // 1. Idle planted agent on west-river-plank deck with stale target across the bridge.
    const idleOnDeck = makeAgent('idle-deck', 7, 24.0, 7, 28.0, { planted: true, moving: false });
    const activeNorth = makeAgent('active-north', 7, 27.2, 7, 22.0);
    controller.update([idleOnDeck, activeNorth], 2, 100);
    assert.equal(idleOnDeck.bridgeDir, 0, 'idle planted deck body must have neutral bridgeDir');
    assert.equal(west.deckCountPos, 0, 'idle planted deck body must not count toward deckCountPos');
    assert.equal(west.activeCount, 0);
    assert.equal(west.activeDir, -1, 'active northbound walker claims empty platoon span immediately');
    assert.equal(activeNorth.bridgeHold, false, 'active walker is never held by idle planted deck body');

    // 2. Cumulative PLATOON_MAX_WAVE admissions on short 2-tile command-pond-plank
    // (staggered 1-by-1 so simultaneous deckCountPos never exceeds 1).
    const pondCtrl = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const pondSpan = pondCtrl.getSpan('command-pond-plank');
    const oppWest = makeAgent('opp-west', 18.5, 22.0, 14.0, 22.0);
    const waveWalkers = [];
    for (let i = 0; i < PLATOON_MAX_WAVE; i++) {
        waveWalkers.push(makeAgent(`p-${i}`, 15.0, 22.0, 19.0, 22.0));
    }
    const extraEast = makeAgent('p-extra', 15.0, 22.0, 19.0, 22.0);

    // Keep first walker clearing slowly while staggered followers enter/exit deck one by one.
    setAgentTile(waveWalkers[0], 16.2, 22.0, 19.0, 22.0);
    pondCtrl.update([waveWalkers[0], oppWest], 2, 100);
    assert.equal(pondSpan.activeDir, 1);
    assert.equal(pondSpan.admittedInWave, 1);
    for (let i = 1; i < PLATOON_MAX_WAVE; i++) {
        setAgentTile(waveWalkers[i], 16.5, 22.0, 19.0, 22.0);
        pondCtrl.update([waveWalkers[0], waveWalkers[i], extraEast, oppWest], 4, 100);
        // Move previous staggered walker off deck so deck occupancy stays <= 2.
        setAgentTile(waveWalkers[i], 19.2, 22.0, 20.0, 22.0);
        pondCtrl.update([waveWalkers[0], waveWalkers[i], extraEast, oppWest], 4, 50);
    }
    assert.equal(pondSpan.admittedInWave, PLATOON_MAX_WAVE, 'admittedInWave must count cumulative wave entries');
    assert.equal(pondSpan.draining, true, 'cumulative PLATOON_MAX_WAVE must trigger draining even on short 2-tile plank');
    assert.equal(extraEast.bridgeHold, true, 'extra follower holds once cumulative wave cap hits');

    // 3. Separate courtesy clock: a 2s platoon hold must NOT consume T-junction courtesy budget.
    const tjCtrl = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const tjPond = tjCtrl.getSpan('command-pond-plank');
    const westBlocker = makeAgent('wb', 16.5, 22.0, 14.0, 22.0);
    const eastWaiter = makeAgent('ew', 15.0, 22.0, 19.0, 22.0);
    const centralExiter = makeAgent('ce', 18.0, 23.0, 18.0, 21.0);
    // Hold eastWaiter for 2000ms (> TWO_WAY_COURTESY_MAX_MS) waiting on westbound platoon.
    for (let k = 0; k < 10; k++) {
        tjCtrl.update([westBlocker, eastWaiter], 2, 200);
    }
    assert.equal(eastWaiter.bridgeHold, true);
    assert.equal(eastWaiter.sprite._bridgeHoldMs, 2000);
    // Westbound clears and central northbound exiter arrives -> flips to +1, courtesy MUST still fire!
    setAgentTile(westBlocker, 13.0, 22.0, 12.0, 22.0);
    tjCtrl.update([westBlocker, eastWaiter, centralExiter], 3, 200);
    assert.equal(tjPond.activeDir, 1);
    assert.equal(eastWaiter.bridgeHold, true, 'T-junction courtesy must fire even after a >1.2s platoon hold');

    // 4. Reverse T-junction drain: westbound pond waiter standing on central north mouth (18,22).
    const revCtrl = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const revPond = revCtrl.getSpan('command-pond-plank');
    const eastOnPond = makeAgent('ep', 16.5, 22.0, 19.0, 22.0);
    const westAtCentralMouth = makeAgent('wcm', 18.0, 22.0, 15.0, 22.0);
    revCtrl.update([eastOnPond, westAtCentralMouth], 2, 100);
    assert.equal(revPond.activeDir, 1);
    assert.equal(revPond.draining, true, 'westbound waiter on central north mouth (18,22) must trigger immediate pond drain');

    // 5. Stall failsafe release: prolonged zero-progress stall lifts bridgeHold to prevent permanent lock.
    const stallCtrl = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const stallFarm = stallCtrl.getSpan('north-farm-bridge');
    const stuckDeck = makeAgent('sd', 3, 7.0, 3, 11.0);
    const waitingOpp = makeAgent('wo', 3, 11.2, 3, 4.0);
    stallCtrl.update([stuckDeck, waitingOpp], 2, 100);
    assert.equal(waitingOpp.bridgeHold, true);
    let released = false;
    for (let step = 0; step < 15; step++) {
        stallCtrl.update([stuckDeck, waitingOpp], 2, 500);
        if (!waitingOpp.bridgeHold) {
            released = true;
            break;
        }
    }
    assert.equal(stallFarm.draining, true);
    assert.equal(released, true, 'prolonged zero-progress stall must open a release window so deadlocks break');
    assert.ok(pond && central);
});

test('hot-path update() runs 200,000 frames cleanly with minimal heap growth', () => {
    const controller = new BridgeTrafficController({ bridgeTiles: createLiveBridgeTiles() });
    const central = controller.getSpan('central-river-bridge');

    const agents = [
        makeAgent('a0', 18, 24.0, 18, 26, { span: central, crossOffsetPx: 6 }),
        makeAgent('a1', 18, 24.5, 18, 22, { span: central, crossOffsetPx: -6 }),
        makeAgent('a2', 7, 24.0, 7, 27),
        makeAgent('a3', 7, 27.1, 7, 22),
        makeAgent('a4', 15.0, 22.0, 19.0, 22.0),
        makeAgent('a5', 3, 7.5, 3, 11.0),
        makeAgent('a6', 10.0, 22.0, 14.0, 22.0),
        makeAgent('a7', 25.0, 15.0, 28.0, 15.0),
    ];

    // Warmup JIT and internal buffers.
    for (let i = 0; i < 5000; i++) {
        controller.update(agents, agents.length, 16.67);
    }

    if (typeof globalThis.gc === 'function') globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const iterations = 200_000;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
        controller.update(agents, agents.length, 16.67);
    }
    const elapsedMs = performance.now() - t0;

    if (typeof globalThis.gc === 'function') globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);

    const diag = controller.getDiagnostics();
    assert.equal(diag.frames, iterations + 5000);
    assert.equal(diag.spanCount, 4);
    assert.ok(diag.totalHolds > 0, 'platoon holds should be recorded');
    assert.ok(heapDeltaMb < 8, `expected minimal heap growth over 200k frames, got ${heapDeltaMb.toFixed(2)} MiB`);
    assert.ok(elapsedMs < 5000, `expected 200k frames to complete swiftly, took ${elapsedMs.toFixed(1)} ms`);
});
