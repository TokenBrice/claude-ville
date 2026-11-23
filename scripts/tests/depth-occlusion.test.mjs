import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { REST_SEATS, REST_STANDS } from '../../claudeville/src/config/townPlan.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { ChimneySmoke } from '../../claudeville/src/presentation/character-mode/ChimneySmoke.js';
import {
    appendDepthSortedDrawables,
    isWorldOccluderPropId,
    updateAgentWorldOcclusion,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import { FoliageRenderer } from '../../claudeville/src/presentation/character-mode/FoliageRenderer.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { StaticPropSprite, buildStaticPropDrawables } from '../../claudeville/src/presentation/character-mode/StaticPropDrawables.js';
import { buildTavernArcadeSprites } from '../../claudeville/src/presentation/character-mode/TavernArcade.js';

const MOCK_BUILDING_METRICS = Object.freeze({
    command: { w: 360, h: 240, anchor: [199, 164] },
    taskboard: { w: 256, h: 208, anchor: [128, 152] },
    forge: { w: 256, h: 232, anchor: [128, 169] },
    mine: { w: 256, h: 240, anchor: [128, 164] },
    archive: { w: 328, h: 256, anchor: [164, 180] },
    tavern: { w: 296, h: 288, anchor: [158, 218] },
    portal: { w: 304, h: 248, anchor: [152, 174] },
    watchtower: { w: 288, h: 336, anchor: [144, 240] },
    harbor: { w: 384, h: 288, anchor: [192, 198] },
});

function makeBuildingRenderer(buildings) {
    const renderer = Object.create(BuildingSprite.prototype);
    renderer.buildings = buildings;
    renderer._drawablesCache = null;
    renderer.assets = {
        getEntry: (id) => ({ id }),
        getDims: (id) => {
            const m = MOCK_BUILDING_METRICS[id.slice('building.'.length)];
            return m ? { w: m.w, h: m.h } : null;
        },
        getAnchor: (id) => MOCK_BUILDING_METRICS[id.slice('building.'.length)]?.anchor || null,
    };
    return renderer;
}

test('Item 1: behindSplit stays bounded to the building footprint and confirms opaque hitTest', () => {
    const command = new Building(BUILDING_DEFS.find((d) => d.type === 'command'));
    const entry = { id: 'building.command' };
    const center = tileToWorld(command.position.tileX + command.width / 2, command.position.tileY + command.height / 2);
    const buildingDrawables = [
        { kind: 'building-back', building: command, entry, wx: center.x, wy: center.y, horizonY: 120, sortY: center.y - 120 },
        { kind: 'building-front', building: command, entry, wx: center.x, wy: center.y, horizonY: 120, sortY: center.y + 80 },
    ];
    const assets = {
        getDims: () => ({ w: 360, h: 240 }),
        getAnchor: () => [199, 164],
        getMask: () => new Uint8Array(360 * 240).fill(1),
    };
    // A villager far away in another building's yard (tile 5, 22 has smaller x & y in tile space
    // than command x1/y1, and falls between backSortY and frontSortY in screen Y) must NOT be stolen.
    const neighbourYard = { ...tileToWorld(5, 22) };
    const target = [];
    appendDepthSortedDrawables(target, {
        buildingDrawables,
        agentSprites: [neighbourYard],
        assets,
        sprites: { assets, hitTest: () => false },
    });
    assert.equal(neighbourYard._behindBuilding, false, 'neighbouring yard villager is never stolen');
    assert.equal(neighbourYard._depthSortY, neighbourYard.y, 'neighbouring yard sortY stays untouched');

    // A villager standing inside the transparent sprite margin (hitTest === false) is not lowered.
    const behindMargin = { ...tileToWorld(14, 13) };
    const targetTransparent = [];
    appendDepthSortedDrawables(targetTransparent, {
        buildingDrawables,
        agentSprites: [behindMargin],
        assets,
        sprites: { assets, hitTest: () => false },
    });
    assert.equal(behindMargin._behindBuilding, false, 'transparent margin does not trigger behindSplit');
    assert.equal(behindMargin._depthSortY, behindMargin.y);

    // Same villager with confirmed opaque overlap IS lowered before building-back.
    const behindOpaque = { ...tileToWorld(14, 13) };
    const targetOpaque = [];
    appendDepthSortedDrawables(targetOpaque, {
        buildingDrawables,
        agentSprites: [behindOpaque],
        assets,
        sprites: { assets, hitTest: () => true },
    });
    assert.equal(behindOpaque._behindBuilding, true, 'confirmed opaque overlap behind footprint sets _behindBuilding');
    assert.ok(behindOpaque._depthSortY < buildingDrawables[0].sortY, 'confirmed behindSplit lowers sortY before building-back');
});

test('Item 2: all 9 buildings emit 16 px sloped occlusion columns sorting every walkable neighbour cleanly', () => {
    const buildings = BUILDING_DEFS.map((def) => new Building(def));
    const byType = new Map(buildings.map((b) => [b.type, b]));
    const renderer = makeBuildingRenderer(buildings);
    const drawables = renderer.enumerateDrawables();

    for (const b of buildings) {
        const cols = drawables.filter((d) => d.building === b);
        assert.ok(cols.length > 10, `${b.type} emits vertical occlusion columns`);
        assert.ok(cols.every((d) => d.kind === 'building-column' && d.column.sw >= 1 && d.column.sw <= 16),
            `${b.type} columns are <= 16 px wide`);
    }

    // Forge gable: ambient slot (25, 28) behind Forge sorts behind its columns,
    // while front work slot (25, 31) sorts in front.
    const forge = byType.get('forge');
    const forgeCols = drawables.filter((d) => d.building === forge);
    const behindForge = tileToWorld(25, 28);
    const inFrontForge = tileToWorld(25, 31);
    for (const col of forgeCols) {
        if (col.column.worldRight > behindForge.x - 12 && col.column.worldLeft < behindForge.x + 12) {
            assert.ok(behindForge.y < col.sortY, 'Forge back slot (25,28) sorts behind overlapping Forge gable columns');
        }
        if (col.column.worldRight > inFrontForge.x - 12 && col.column.worldLeft < inFrontForge.x + 12) {
            assert.ok(inFrontForge.y > col.sortY, 'Forge front slot (25,31) sorts in front of overlapping Forge columns');
        }
    }

    // _anchorSortY stays at SE footprint corner even when back-side visit tiles exist (Forge/Mine).
    for (const type of ['forge', 'mine']) {
        const b = byType.get(type);
        const seY = tileToWorld(b.position.tileX + b.width - 1, b.position.tileY + b.height - 1).y;
        assert.equal(renderer._anchorSortY(b), seY, `${type} _anchorSortY is not dragged back by back-side visit tiles`);
    }

    // Tavern openFloor: patrons on bar stools/stands paint IN FRONT of Tavern base columns
    // and BEHIND TavernArcade; Building.isOpenFloor floors fractional coordinates cleanly.
    const tavern = byType.get('tavern');
    assert.equal(tavern.isOpenFloor(21.9, 17.9), true, 'isOpenFloor uses floor so 17.9 stays on open floor');
    assert.equal(tavern.isOpenFloor(21.9, 18.0), false, 'isOpenFloor excludes row 18');
    const tavernCols = drawables.filter((d) => d.building === tavern);
    const [arcade] = buildTavernArcadeSprites({
        building: tavern,
        assets: {
            get: () => ({ width: 296, height: 288 }),
            getAnchor: () => [158, 218],
            getEntry: () => ({ materialClass: 'stone' }),
        },
    });
    for (const seat of REST_SEATS.filter((s) => s.occluder === 'stool')) {
        const p = tileToWorld(seat.tileX, seat.tileY);
        for (const col of tavernCols) {
            if (col.column.worldRight > p.x - 12 && col.column.worldLeft < p.x + 12) {
                assert.ok(p.y > col.sortY, `Tavern stool ${seat.id} paints in front of recessed Tavern base column`);
            }
        }
        const arcadeCol = arcade.occlusionColumns.find((c) => p.x - arcade.x >= c.left && p.x - arcade.x < c.right);
        assert.ok(arcadeCol && p.y < arcadeCol.sortY, `Tavern stool ${seat.id} paints behind TavernArcade`);
    }
    for (const stand of REST_STANDS.tavern.tiles.filter((t) => tavern.isOpenFloor(t.tileX, t.tileY))) {
        const p = tileToWorld(stand.tileX, stand.tileY);
        for (const col of tavernCols) {
            if (col.column.worldRight > p.x - 12 && col.column.worldLeft < p.x + 12) {
                assert.ok(p.y > col.sortY, `Tavern bar stand (${stand.tileX},${stand.tileY}) paints in front of recessed base column`);
            }
        }
    }
});

test('Item 4: trees and boulders sort whole with no zoom/proximity split toggle, while wide column props stay sliced', () => {
    const foliage = new FoliageRenderer({ assets: null, sprites: null });
    const [tree] = foliage.createTreeProps([{ tileX: 10, tileY: 10, species: 'oak', variant: 'a', scale: 1 }]);
    assert.equal(tree.splitForOcclusion, false, 'trees sort whole at their foot');

    const renderer = Object.create(IsometricRenderer.prototype);
    const wholeProp = new StaticPropSprite({ tileX: 12, tileY: 12, id: 'veg.boulder.mossy.large', splitForOcclusion: false, drawFn() {} });
    const colProp = new StaticPropSprite({
        tileX: 18,
        tileY: 38,
        id: 'prop.villageGate',
        occlusionColumns: [
            { index: 0, left: -Infinity, right: 0, sortY: 900 },
            { index: 1, left: 0, right: Infinity, sortY: 910 },
        ],
        drawFn() {},
    });
    renderer._staticPropSprites = [wholeProp, colProp];
    renderer._staticPropFastDrawables = renderer._buildStaticPropFastDrawables();
    renderer._staticPropFastFrameDrawables = [];
    renderer._screenViewport = () => null;
    const fast = renderer._enumerateFastPropDrawables();
    assert.equal(fast.filter((d) => d.payload.sprite === wholeProp).length, 1, 'whole prop stays unsplit in fast path');
    assert.equal(fast.filter((d) => d.payload.sprite === colProp).length, 2, 'column prop keeps all columns in fast path');
});

test('Item 5 & 6: _occludedByWorld tracks buildings/gate/walls, hides overlays, and Canvas hoists selected nameplates', () => {
    assert.equal(isWorldOccluderPropId('prop.villageGate'), true);
    assert.equal(isWorldOccluderPropId('village.wall.west.0'), true);
    assert.equal(isWorldOccluderPropId('prop.villageWallSeaTower'), true);
    assert.equal(isWorldOccluderPropId('tavern-arcade'), false);
    assert.equal(isWorldOccluderPropId('fantasy.tree'), false);

    // Building occlusion sets _occludedByWorld and suppresses GPU overlay unless selected.
    const forge = new Building(BUILDING_DEFS.find((d) => d.type === 'forge'));
    const buildingRenderer = makeBuildingRenderer([forge]);
    const buildingDrawables = buildingRenderer.enumerateDrawables();
    const dims = MOCK_BUILDING_METRICS.forge;
    const solidMask = new Uint8Array(dims.w * dims.h).fill(1);
    const assets = {
        ...buildingRenderer.assets,
        get: () => ({ width: dims.w, height: dims.h }),
        getMask: () => solidMask,
    };
    const hidden = { ...tileToWorld(25, 28), _depthSortY: tileToWorld(25, 28).y, selected: false };
    const visible = { ...tileToWorld(25, 31), _depthSortY: tileToWorld(25, 31).y, selected: false };
    updateAgentWorldOcclusion({
        agentSprites: [hidden, visible],
        buildingDrawables,
        propDrawables: [],
        assets,
        sprites: { assets, hitTest: () => true },
    });
    assert.equal(hidden._occludedByWorld, true, 'villager behind Forge gable is occluded');
    assert.ok(hidden._worldOccluders.length === 1, 'occluder list records Forge');
    assert.equal(visible._occludedByWorld, false, 'villager in front of Forge is not occluded');

    // Right-half building columns arrive in descending worldLeft order when sorted by sortY;
    // clipRanges must merge all overlapping columns across the villager's full horizontal box.
    const command = new Building(BUILDING_DEFS.find((d) => d.type === 'command'));
    const cmdRenderer = makeBuildingRenderer([command]);
    const cmdDrawables = cmdRenderer.enumerateDrawables();
    const cmdDims = MOCK_BUILDING_METRICS.command;
    const cmdAssets = {
        ...cmdRenderer.assets,
        get: () => ({ width: cmdDims.w, height: cmdDims.h }),
        getMask: () => new Uint8Array(cmdDims.w * cmdDims.h).fill(1),
    };
    const behindRightHalf = { ...tileToWorld(15.2, 14.8), _depthSortY: tileToWorld(15.2, 14.8).y, selected: true };
    updateAgentWorldOcclusion({
        agentSprites: [behindRightHalf],
        buildingDrawables: cmdDrawables,
        propDrawables: [],
        assets: cmdAssets,
        sprites: { assets: cmdAssets, hitTest: () => true },
    });
    assert.equal(behindRightHalf._occludedByWorld, true, 'villager behind Command right half is occluded');
    const [range] = behindRightHalf._worldOccluders[0].clipRanges;
    assert.ok(range[0] <= behindRightHalf.x - 10 && range[1] >= behindRightHalf.x + 10,
        `clipRanges covers full villager width across zig-zagged columns, got [${range}] around x=${behindRightHalf.x}`);

    // Village gate occlusion also sets _occludedByWorld.
    const gateWorld = tileToWorld(18, 38);
    const gateMask = new Uint8Array(120 * 120).fill(1);
    const gateProp = new StaticPropSprite({
        tileX: 18,
        tileY: 38,
        id: 'prop.villageGate',
        occlusionColumns: [{ index: 0, left: -60, right: 60, sortY: gateWorld.y + 40 }],
        drawFn() {},
    });
    gateProp.getAlphaMask = () => ({ canvas: { width: 120, height: 120 }, x: gateWorld.x - 60, y: gateWorld.y - 100, w: 120, h: 120, mask: gateMask });
    const behindGate = { x: gateWorld.x, y: gateWorld.y - 4, _depthSortY: gateWorld.y - 4, selected: false };
    updateAgentWorldOcclusion({
        agentSprites: [behindGate],
        buildingDrawables: [],
        propDrawables: buildStaticPropDrawables([gateProp]),
        assets: null,
    });
    assert.equal(behindGate._occludedByWorld, true, 'villager behind village gate is occluded');

    // AgentGpuOverlayRenderer skips occluded unselected agents, keeps occluded selected ones.
    let drew = 0;
    const makeHost = (selected) => ({
        gpuWorldEnabled: true,
        _occludedByWorld: true,
        _behindBuilding: true,
        selected,
        agent: { status: AgentStatus.WORKING },
        _gpuFrameRecord: { contentTopY: 10 },
        _headTopY: () => 10,
        _labelTopY: (y) => y - 6,
        _drawSelectionChevron: () => { drew++; },
        _drawStatusEmote: () => {},
        _drawPlanModeGlyph: () => {},
        _drawRetryGlyph: () => {},
        _drawNameTag: () => { drew++; },
    });
    new AgentGpuOverlayRenderer(makeHost(false)).draw({}, 2, 'full');
    assert.equal(drew, 0, 'occluded unselected agent skips GPU overlay marks and name');
    new AgentGpuOverlayRenderer(makeHost(true)).draw({}, 2, 'full');
    assert.equal(drew, 2, 'occluded selected agent keeps chevron and name plate');

    // Canvas selected nameplate hoist via drawDeferredNameTag.
    let hoisted = 0;
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        selected: true,
        _onOpenFloor: false,
        gpuWorldEnabled: false,
        withBridgeLift: (fn) => fn(),
        _drawNameTag: () => { hoisted++; },
    });
    sprite.drawDeferredNameTag({});
    assert.equal(hoisted, 1, 'Canvas hoists selected nameplate onto deferred overlay');
    sprite.gpuWorldEnabled = true;
    sprite.drawDeferredNameTag({});
    assert.equal(hoisted, 1, 'GPU path skips Canvas deferred nameplate');
});

test('Item 2 alpha trimming: empty edge columns are skipped once sprite masks load', () => {
    const watchtower = new Building(BUILDING_DEFS.find((d) => d.type === 'watchtower'));
    const dims = MOCK_BUILDING_METRICS.watchtower;
    let maskReady = false;
    const mask = new Uint8Array(dims.w * dims.h);
    // Mark only middle columns [64..192) as opaque.
    for (let y = 20; y < dims.h - 10; y++) {
        for (let x = 64; x < 192; x++) {
            mask[y * dims.w + x] = 1;
        }
    }
    const renderer = Object.create(BuildingSprite.prototype);
    renderer.buildings = [watchtower];
    renderer._drawablesCache = null;
    renderer.assets = {
        getEntry: (id) => ({ id }),
        getDims: () => ({ w: dims.w, h: dims.h }),
        getAnchor: () => dims.anchor,
        getMask: () => (maskReady ? mask : null),
    };
    const beforeMask = renderer.enumerateDrawables();
    assert.equal(beforeMask.length, Math.ceil(dims.w / 16), 'before masks load, emits full width columns');
    maskReady = true;
    const afterMask = renderer.enumerateDrawables();
    assert.equal(afterMask.length, 8, 'after mask loads, rebuilds cache and trims transparent edge columns');
    const byIndex = afterMask.slice().sort((a, b) => a.column.index - b.column.index);
    assert.equal(byIndex[0].column.index, 0, 'first emitted column is re-indexed to 0');
    assert.equal(byIndex[byIndex.length - 1].column.last, true, 'rightmost emitted column sets last=true');
    assert.equal(afterMask[afterMask.length - 1].column.primary, true, 'frontmost painted column sets primary=true');
    assert.ok(afterMask.every((d) => d.column.sx >= 64 && d.column.sx + d.column.sw <= 192), 'only opaque columns remain');
    assert.ok(afterMask.every((d) => d.poolKey === `building-column:${d.column.index}`),
        'building-column drawables precompute poolKey once on bake');
});

function makeMockCanvas(width = 64, height = 64) {
    const ops = [];
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const ctx = {
        imageSmoothingEnabled: true,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '#000',
        save() {},
        restore() {},
        translate() {},
        scale() {},
        setTransform() {},
        beginPath() {},
        rect() {},
        clip() {},
        clearRect() {},
        fillRect() {},
        drawImage(...args) { ops.push(['drawImage', ...args]); },
        getImageData(x, y, w, h) {
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
        },
        putImageData() {},
    };
    return {
        width,
        height,
        ops,
        getContext() { return ctx; },
    };
}

test('Depth fix 1: Canvas budget impostor keeps _bodyBox mutable across hover, select, status change, and return to full', () => {
    const noopCtx = makeMockCanvas(128, 128).getContext();
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        x: 120,
        y: 240,
        _placeX: 120,
        _placeY: 240,
        _placeDpr: 1,
        _zoom: 1,
        _bodyBox: null,
        _lastStatus: null,
        _lastWaitReason: null,
        _onOpenFloor: false,
        _occludedByWorld: false,
        _behindBuilding: false,
        selected: false,
        hovered: false,
        gpuWorldEnabled: false,
        motionScale: 1,
        compositor: null,
        agent: { id: 'budget-1', status: AgentStatus.WORKING, provider: 'claude', model: 'sonnet' },
        isArrivalPending: () => false,
        _archiveFadeProgress: () => 0,
        _drawBudgetImpostor: () => {},
        _drawNameTag: () => {},
        withBridgeLift: (fn) => fn(),
        _currentBridgeLift: () => 0,
    });

    // Draw once in Canvas budget mode (compact, >= 80 villagers)
    sprite.draw(noopCtx, 1, 'compact');
    assert.ok(sprite._bodyBox && !Object.isFrozen(sprite._bodyBox),
        'Canvas budget impostor must store a mutable _bodyBox, never the frozen constant');
    assert.equal(sprite._bodyBox.left, -8);
    assert.equal(sprite._bodyBox.bottom, 3);

    // Subsequent _setBodyBox (triggered by hover, select, waiting-on-user, or returning to full) must not throw TypeError.
    assert.doesNotThrow(() => {
        sprite.hovered = true;
        sprite._setBodyBox(120, 240, 102, 190, 138, 244);
    }, 'hovering a budget impostor and updating _bodyBox must not throw');
    assert.deepEqual(sprite._bodyBox, { left: -18, right: 18, top: -50, bottom: 4 });

    // Dropping back into budget mode and then selecting/changing status also stays mutable.
    sprite.hovered = false;
    sprite.draw(noopCtx, 1, 'minimal');
    assert.equal(Object.isFrozen(sprite._bodyBox), false);
    assert.doesNotThrow(() => {
        sprite.selected = true;
        sprite._setBodyBox(120, 240, 104, 188, 136, 243);
        sprite.selected = false;
        sprite.agent.status = AgentStatus.WAITING_ON_USER;
        sprite._setBodyBox(120, 240, 105, 189, 135, 242);
    });
});

test('Depth fix 2: low-zoom impostor (< 1) skips x-ray instead of blitting a stale _poseCell', () => {
    const outCanvas = makeMockCanvas(128, 128);
    const outCtx = outCanvas.getContext();
    const staleCanvas = makeMockCanvas(92, 92);
    const prevDoc = globalThis.document;
    globalThis.document = { createElement: () => makeMockCanvas(92, 92) };
    try {
        const sprite = Object.assign(Object.create(AgentSprite.prototype), {
            x: 200,
            y: 420,
            _placeX: 200,
            _placeY: 420,
            _zoom: 1,
            selected: false,
            gpuWorldEnabled: false,
            spriteCanvas: staleCanvas,
            _budgetImpostorXray: false,
            _lowZoomImpostor: false,
            _poseCell: { canvas: staleCanvas, sx: 0, sy: 0, sw: 92, sh: 92, dx: -44, dy: 242, drawScale: 1 },
            withBridgeLift: (fn) => fn(),
            _currentBridgeLift: () => 0,
        });

        // At zoom < 1 (low-zoom impostor), x-ray must skip instead of blitting stale (-44, 242).
        sprite._zoom = 0.5;
        sprite._lowZoomImpostor = true;
        sprite.drawXraySilhouette(outCtx, 'working', []);
        assert.equal(outCanvas.ops.length, 0, 'low-zoom impostor must not blit a stale x-ray cell');

        // At zoom >= 1 with fresh pose, x-ray draws normally.
        sprite._zoom = 1;
        sprite._lowZoomImpostor = false;
        sprite.drawXraySilhouette(outCtx, 'working', []);
        assert.equal(outCanvas.ops.length, 1, 'normal zoom >= 1 x-ray blits its silhouette');
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
});

test('Depth fix 3: off-screen sprites reset occlusion flags and arrival-pending sprites stay unoccluded', () => {
    // 1) updateAgentWorldOcclusion resets and skips arrival-pending sprites.
    const forge = new Building(BUILDING_DEFS.find((d) => d.type === 'forge'));
    const buildingRenderer = makeBuildingRenderer([forge]);
    const buildingDrawables = buildingRenderer.enumerateDrawables();
    const dims = MOCK_BUILDING_METRICS.forge;
    const assets = {
        ...buildingRenderer.assets,
        get: () => ({ width: dims.w, height: dims.h }),
        getMask: () => new Uint8Array(dims.w * dims.h).fill(1),
    };
    const pending = {
        ...tileToWorld(25, 28),
        _depthSortY: tileToWorld(25, 28).y,
        _occludedByWorld: true,
        _behindBuilding: true,
        _worldOccluders: [{ kind: 'building' }],
        isArrivalPending: () => true,
    };
    updateAgentWorldOcclusion({
        agentSprites: [pending],
        buildingDrawables,
        assets,
        sprites: { assets, hitTest: () => true },
    });
    assert.equal(pending._occludedByWorld, false, 'arrival-pending sprite clears _occludedByWorld');
    assert.equal(pending._behindBuilding, false, 'arrival-pending sprite clears _behindBuilding');
    assert.equal(pending._worldOccluders.length, 0, 'arrival-pending sprite clears _worldOccluders');

    // 2) _snapshotSortedSprites resets occlusion flags when a sprite leaves the viewport.
    const onScreen = { x: 100, y: 100, _occludedByWorld: true, _behindBuilding: true, _behindBuildingDrawable: {}, _worldOccluders: [{}] };
    const leftScreen = { x: 9999, y: 9999, _occludedByWorld: true, _behindBuilding: true, _behindBuildingDrawable: {}, _worldOccluders: [{}] };
    const iso = Object.create(IsometricRenderer.prototype);
    iso.agentSprites = new Map([['a', onScreen], ['b', leftScreen]]);
    iso._visibleSpriteCandidates = new Set();
    iso._visibleSortedSprites = [onScreen, leftScreen];
    iso._screenViewport = () => ({ width: 1280, height: 720 });
    iso._agentVisibleOnScreen = (s) => s === onScreen;
    const sorted = iso._snapshotSortedSprites();
    assert.deepEqual(sorted, [onScreen]);
    assert.equal(leftScreen._occludedByWorld, false, 'off-screen sprite resets _occludedByWorld');
    assert.equal(leftScreen._behindBuilding, false, 'off-screen sprite resets _behindBuilding');
    assert.equal(leftScreen._behindBuildingDrawable, null, 'off-screen sprite clears _behindBuildingDrawable');
    assert.equal(leftScreen._worldOccluders.length, 0, 'off-screen sprite clears _worldOccluders');
});

test('Depth fix 4: silhouette cache evicts single LRU entry with cap >= 12 and releases in releaseRenderResources', () => {
    const created = [];
    const prevDoc = globalThis.document;
    globalThis.document = {
        createElement: () => {
            const c = makeMockCanvas(32, 32);
            created.push(c);
            return c;
        },
    };
    try {
        const sheet = makeMockCanvas(320, 32);
        const sprite = Object.assign(Object.create(AgentSprite.prototype), {
            _resourceOwnerKey: 'xray-cache-test',
            _frozenTintCellCache: new Map(),
            _cellBoundsCache: new Map(),
            _xraySilhouetteCache: null,
            _releaseProfileOwnership: () => {},
        });
        // 10 action-strip frames must all stay cached with zero evictions.
        for (let f = 0; f < 10; f++) {
            sprite._getXraySilhouetteCanvas({ canvas: sheet, sx: f * 32, sy: 0, sw: 32, sh: 32 }, 32, 32, 'working');
        }
        assert.equal(sprite._xraySilhouetteCache.size, 10, '10-frame action strip fits in cache without eviction');
        const createdAfter10 = created.length;
        // Replaying all 10 frames hits cache every time.
        for (let f = 0; f < 10; f++) {
            sprite._getXraySilhouetteCanvas({ canvas: sheet, sx: f * 32, sy: 0, sw: 32, sh: 32 }, 32, 32, 'working');
        }
        assert.equal(created.length, createdAfter10, '10-frame loop has 100% cache hit rate');

        // Fill up to cap (16) and trigger 1 eviction: only the single oldest entry is evicted, not clear-all.
        for (let f = 10; f < 17; f++) {
            sprite._getXraySilhouetteCanvas({ canvas: sheet, sx: f * 32, sy: 0, sw: 32, sh: 32 }, 32, 32, 'working');
        }
        assert.equal(sprite._xraySilhouetteCache.size, 16, 'cache evicts one entry at cap 16 instead of clearing all');
        assert.equal(created[0].width, 0, 'evicted silhouette canvas releases its backing store');
        assert.ok(created[1].width > 0, 'non-evicted silhouette canvas remains intact');

        // releaseRenderResources releases every cached silhouette canvas and clears the map.
        sprite.releaseRenderResources();
        assert.equal(sprite._xraySilhouetteCache.size, 0, 'releaseRenderResources clears silhouette cache');
        assert.ok(created.every((c) => c.width === 0 && c.height === 0),
            'releaseRenderResources zeroes every silhouette canvas backing store');
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
});

test('Depth fix 6: Canvas building-column pass draws functional and atmosphere overlays once per building on primary column', () => {
    const forge = new Building(BUILDING_DEFS.find((d) => d.type === 'forge'));
    const dims = MOCK_BUILDING_METRICS.forge;
    const renderer = makeBuildingRenderer([forge]);
    renderer.assets.get = () => ({ width: dims.w, height: dims.h });
    renderer.hovered = null;
    renderer._drawRoofWeather = () => {};
    renderer._drawManifestLayers = () => {};
    renderer._drawOccupancyPennant = () => {};
    renderer._drawAttentionBannerBoard = () => {};
    let functionalCalls = 0;
    let atmosphereCalls = 0;
    let functionalColumnArg = 'unset';
    renderer._drawFunctionalOverlay = (_ctx, _b, _e, _wx, _wy, splitPass, _h, col) => {
        functionalCalls++;
        functionalColumnArg = { splitPass, col };
    };
    renderer._drawAtmosphereBuildingReactions = () => {
        atmosphereCalls++;
    };
    const drawables = renderer.enumerateDrawables();
    assert.ok(drawables.length > 10, 'Forge emits multiple building columns');
    const ctx = makeMockCanvas(512, 512).getContext();
    for (const d of drawables) renderer.drawDrawable(ctx, d);
    assert.equal(functionalCalls, 1, 'Canvas runs _drawFunctionalOverlay once per building, not per column');
    assert.equal(atmosphereCalls, 1, 'Canvas runs _drawAtmosphereBuildingReactions once per building, not per column');
    assert.deepEqual(functionalColumnArg, { splitPass: 'whole', col: null },
        'primary column draws building overlays unclipped to a single 16 px strip');
});

test('Depth fix 8a: ChimneySmoke forwards localX to sortYFor so puffs take their own column depth', () => {
    const forge = new Building(BUILDING_DEFS.find((d) => d.type === 'forge'));
    const dims = MOCK_BUILDING_METRICS.forge;
    const buildingRenderer = makeBuildingRenderer([forge]);
    const smoke = new ChimneySmoke();
    const assets = {
        has: (id) => id === 'building.forge',
        getAnchor: () => dims.anchor,
    };
    const seen = [];
    const particleSystem = {
        motionEnabled: true,
        particles: [],
        countTagged: () => 0,
        spawn: (_type, _x, _y, _count, options) => {
            seen.push(options.sortY);
            particleSystem.particles.push({ tag: options.tag });
        },
    };
    const sortCalls = [];
    smoke.update({
        now: 1000,
        timeMs: 1000,
        buildings: [forge],
        assets,
        presence: new Map([['forge', { count: 2, tier: 'occupied' }]]),
        particleSystem,
        atmosphere: { phase: 'day', clock: { minuteOfDay: 720 }, weather: { type: 'clear' } },
        sortYFor: (building, localY, localX) => {
            sortCalls.push({ building, localY, localX });
            return buildingRenderer.particleSortY(building, localY, localX);
        },
    });
    assert.ok(sortCalls.length > 0, 'ChimneySmoke emits at least one chimney puff');
    for (const call of sortCalls) {
        assert.ok(Number.isFinite(call.localX), 'ChimneySmoke passes finite localX to sortYFor');
        const withX = buildingRenderer.particleSortY(call.building, call.localY, call.localX);
        const withoutX = buildingRenderer.particleSortY(call.building, call.localY);
        assert.equal(seen[0], withX, 'puff sortY matches the chimney column depth');
        assert.ok(withX <= withoutX, 'column depth is at or behind the frontmost fallback depth');
    }
});

test('Depth fix 5: updateAgentWorldOcclusion reuses per-sprite hit pool and clipRanges across frames', () => {
    const command = new Building(BUILDING_DEFS.find((d) => d.type === 'command'));
    const cmdRenderer = makeBuildingRenderer([command]);
    const cmdDrawables = cmdRenderer.enumerateDrawables();
    const cmdDims = MOCK_BUILDING_METRICS.command;
    const cmdAssets = {
        ...cmdRenderer.assets,
        get: () => ({ width: cmdDims.w, height: cmdDims.h }),
        getMask: () => new Uint8Array(cmdDims.w * cmdDims.h).fill(1),
    };
    const sprite = { ...tileToWorld(15.2, 14.8), _depthSortY: tileToWorld(15.2, 14.8).y, selected: true };
    updateAgentWorldOcclusion({
        agentSprites: [sprite],
        buildingDrawables: cmdDrawables,
        propDrawables: [],
        assets: cmdAssets,
        sprites: { assets: cmdAssets, hitTest: () => true },
    });
    const firstHit = sprite._worldOccluders[0];
    const firstRanges = firstHit.clipRanges;
    const firstPair = firstRanges[0];
    updateAgentWorldOcclusion({
        agentSprites: [sprite],
        buildingDrawables: cmdDrawables,
        propDrawables: [],
        assets: cmdAssets,
        sprites: { assets: cmdAssets, hitTest: () => true },
    });
    assert.equal(sprite._worldOccluders[0], firstHit, 'hit entry is reused across frames');
    assert.equal(sprite._worldOccluders[0].clipRanges, firstRanges, 'clipRanges array is reused across frames');
    assert.equal(sprite._worldOccluders[0].clipRanges[0], firstPair, 'clip range pair is reused across frames');
});
