import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';
import { buildGpuWorldRecords } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { OverlayOccupancyGrid } from '../../claudeville/src/presentation/character-mode/SlotAuction.js';
import { scribeSpeaker } from '../../claudeville/src/presentation/character-mode/ThoughtColumn.js';

function makeThoughtRenderer({ zoom = 1, annotationMode = 'full', theatreMode = false, glassActive = false } = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.camera = {
        zoom,
        restZoom: zoom,
        worldToScreen: (x, y) => ({ x: x + 800, y: y + 500 }),
        screenToWorld: (x, y) => ({ x: x - 800, y: y - 500 }),
    };
    renderer._screenViewport = () => ({ width: 1600, height: 1000 });
    renderer._overlayBubbleOrder = [];
    renderer._overlayBubbleBaseRects = [];
    renderer._overlayBubbleOccupiedRects = [];
    renderer._overlayBubbleClusters = [];
    renderer._overlayBubbleClusterCount = 0;
    renderer._overlayBubbleGroups = new Map();
    renderer._overlayBubbleGrid = renderer._createRectGrid();
    renderer._overlayClusterGrid = renderer._createRectGrid();
    renderer._annotationMode = annotationMode;
    renderer.theatreMode = theatreMode;
    renderer.agentSprites = new Map();
    renderer.getReadMode = () => false;
    renderer.inspectionGlass = glassActive ? { isActive: () => true } : null;
    return renderer;
}

function makeSpeaker(id, text, { x = 100, y = 200, selected = false, hovered = false, fresh = 1000, clock = false, overlaySlot = null } = {}) {
    let threadCalls = 0;
    const thread = text ? [{ text, accent: '#f2d36b', confidence: null, shape: 'speech', badge: '' }] : [];
    return {
        agent: { id, name: `Agent ${id}`, status: 'working' },
        x, y,
        selected,
        hovered,
        overlaySlot,
        addedAt: -60000,
        _dialogueDisplayUntil: fresh,
        _activitySnapshot: thread[0] || null,
        _activityThread() { threadCalls++; return thread; },
        get threadCalls() { return threadCalls; },
        _shouldUseLongWaitClock: () => clock,
        thoughtRepoAccent: () => '#77aa88',
        thoughtSpeakerTag: () => id.slice(0, 3).toUpperCase(),
        _providerTrimColor: () => '#ffffff',
        _statusVisual: () => ({ color: '#f2d36b' }),
        _headTopY: () => y - 44,
        _labelTopY: (top) => top - 6,
    };
}

test('hidden/scribe thought fast path picks exact scribe speaker and bypasses ε-auction', () => {
    const renderer = makeThoughtRenderer({ zoom: 1 });
    const grid = new OverlayOccupancyGrid({ cellSize: 96 });
    const s0 = makeSpeaker('a', 'Fresh speaker', { x: 10, fresh: 5000 });
    const s1 = makeSpeaker('b', 'Clock only', { x: 20, selected: true, clock: true, fresh: 1000 });
    const s2 = makeSpeaker('c', 'Hovered speaker', { x: 30, hovered: true, fresh: 2000 });
    const s3 = makeSpeaker('d', 'Older speaker', { x: 40, fresh: 1000 });
    const speechPlan = { drawBubbles: false, useScribe: true, drawPip: true, overviewCompact: false };

    grid.beginFrame();
    renderer._assignAgentBubbleSlots([s0, s1, s2, s3], 1, [], grid, 1000, { speechPlan });

    // s1 is selected but clock-only, so scribe falls through to s2 (hovered > fresh).
    const picked = scribeSpeaker(renderer._overlayBubbleOrder);
    assert.equal(picked, s2);
    assert.equal(s2.bubbleSlot, 0);
    assert.equal(s2._thoughtAnchorX, 30);
    assert.equal(s2.bubbleBaseY, 200 - 44 - 6);
    assert.equal(s2._statusThread[0].text, 'Hovered speaker');
    // Non-scribe speakers must not call _activityThread or stay placed.
    assert.equal(s0.bubbleSlot, null);
    assert.equal(s1.bubbleSlot, null);
    assert.equal(s3.bubbleSlot, null);
    assert.equal(s0.threadCalls, 0);
    assert.equal(s3.threadCalls, 0);
    assert.equal(s2.threadCalls, 1);
    const diag = renderer.getLabelAuctionDiagnostics();
    assert.equal(diag.iterations, 0);
    assert.equal(diag.placed, 1);
    assert.equal(diag.speakers, 4);
});

test('hidden/scribe fast path falls back to full solver when InspectionGlass is active', () => {
    const renderer = makeThoughtRenderer({ zoom: 1, glassActive: true });
    const grid = new OverlayOccupancyGrid({ cellSize: 96 });
    const s0 = makeSpeaker('a', 'First', { x: 0, fresh: 5000 });
    const s1 = makeSpeaker('b', 'Second', { x: 200, fresh: 4000 });
    const speechPlan = { drawBubbles: false, useScribe: true, drawPip: true, overviewCompact: false };

    grid.beginFrame();
    renderer._assignAgentBubbleSlots([s0, s1], 1, [], grid, 1000, { speechPlan });

    assert.notEqual(s0.bubbleSlot, null);
    assert.notEqual(s1.bubbleSlot, null);
    assert.ok(renderer.getLabelAuctionDiagnostics().iterations >= 1);
});

test('hidden/scribe fast path falls back when close-zoom crowd has foldable routine names', () => {
    const renderer = makeThoughtRenderer({ zoom: 2, annotationMode: 'compact', theatreMode: false });
    const grid = new OverlayOccupancyGrid({ cellSize: 96 });
    const speakers = Array.from({ length: 7 }, (_, i) =>
        makeSpeaker(`s${i}`, `Line ${i}`, { x: 100 + i * 2, y: 200, fresh: 5000 - i, overlaySlot: 0 }));
    const speechPlan = { drawBubbles: false, useScribe: true, drawPip: true, overviewCompact: false };

    grid.beginFrame();
    renderer._assignAgentBubbleSlots(speakers, 2, [], grid, 1000, { speechPlan });

    assert.ok(renderer.getLabelAuctionDiagnostics().iterations >= 1);
});

test('resident GPU budgetMode skips hidden lower-canvas _drawBudgetImpostor while keeping LOD GPU record', () => {
    const sprite = Object.create(AgentSprite.prototype);
    const canvas = { width: 736, height: 920 };
    let budgetImpostorDraws = 0;
    let setGpuCalls = 0;
    Object.assign(sprite, {
        agent: { id: 'a1', name: 'Atlas', provider: 'claude', model: 'claude-sonnet-4-5', status: 'working' },
        x: 120, y: 240,
        direction: 0, animState: 'idle', frame: 0,
        selected: false, hovered: false,
        gpuWorldEnabled: true,
        motionScale: 1,
        compositor: { spriteFor: () => canvas },
        spriteCanvas: canvas,
        spriteSheet: { cellSize: 92, cell: () => ({ sx: 0, sy: 0, sw: 92, sh: 92 }) },
        _cellBoundsCache: new Map(),
        _spriteProfileKey: null,
        isArrivalPending: () => false,
        _archiveFadeProgress: () => 0,
        _providerKey: () => 'claude',
        _hashVariant: () => 0,
        signature: () => ({ key: 'sig' }),
        _runtimeHeadAccessory: () => null,
        _runtimeCodexEquipment: () => null,
        _shouldScrubBakedCodexWeapon: () => false,
        _teamTrimAccent: () => null,
        _syncProfileOwnership: () => {},
        _prepareSpriteCanvas: (c) => c,
        _updatePrivateDerivedEstimate: () => {},
        _risenForChild: () => false,
        _seatedSeat: () => null,
        _getCellContentBounds: () => ({ minX: 20, maxX: 70, minY: 16, maxY: 86 }),
        _stableFootAnchor: () => ({ cx2: 92, maxY: 86 }),
        _stableContentWidth: () => 50,
        _setBodyBox: () => {},
        _layoutGroundMarks: () => {},
        _setGpuFrameRecord: (rec) => { setGpuCalls++; sprite._gpuFrameRecord = rec; },
        _drawBudgetImpostor: () => { budgetImpostorDraws++; },
    });
    const ctx = { save() {}, restore() {}, canvas: { _claudeVilleDpr: 1 } };
    sprite._drawAtScreenPosition(ctx, 1, 'compact');

    assert.equal(setGpuCalls, 1, 'resident GPU budgetMode must still submit LOD GPU record');
    assert.equal(budgetImpostorDraws, 0, 'resident GPU budgetMode must not paint dead impostor onto hidden lower canvas');
});

test('resident GPU survey zoom renders regular body record at current position while Canvas keeps low-zoom impostor', () => {
    const sprite = Object.create(AgentSprite.prototype);
    const overlayRenderer = new AgentGpuOverlayRenderer(sprite);
    const lowerOps = [];
    const canvas = { width: 736, height: 920 };
    Object.assign(sprite, {
        agent: { id: 'survey-1', name: 'Nova', provider: 'claude', model: 'claude-sonnet-4-5', status: 'working', currentTool: 'Read' },
        x: 320, y: 180,
        direction: 0, animState: 'idle', frame: 0,
        selected: false, hovered: true,
        gpuWorldEnabled: true,
        gpuOverlayRenderer: overlayRenderer,
        motionScale: 0,
        compositor: { spriteFor: () => canvas },
        spriteCanvas: canvas,
        spriteSheet: { cellSize: 92, cell: () => ({ sx: 0, sy: 0, sw: 92, sh: 92 }) },
        _cellBoundsCache: new Map(),
        _frozenTintCellCache: new Map(),
        _xraySilhouetteCache: new Map(),
        // Simulate a stale z>=1 record left at old coordinates before zooming out to 0.5.
        _gpuFrameRecord: { id: 'agent:survey-1', x: -100, y: -100 },
        _occludedByWorld: false,
        _behindBuilding: false,
        isArrivalPending: () => false,
        _archiveFadeProgress: () => 0,
        _providerKey: () => 'claude',
        _hashVariant: () => 0,
        signature: () => ({ key: 'sig' }),
        _runtimeHeadAccessory: () => null,
        _runtimeCodexEquipment: () => null,
        _shouldScrubBakedCodexWeapon: () => false,
        _teamTrimAccent: () => null,
        _syncProfileOwnership: () => {},
        _prepareSpriteCanvas: (c) => c,
        _updatePrivateDerivedEstimate: () => {},
        _moodPostureCue: () => ({ staticDy: 0, bobScale: 1, idleFrame: null }),
        _scenicPostureCue: () => null,
        _risenForChild: () => false,
        _seatedSeat: () => null,
        _distressPose: () => null,
        _stillWorkSettled: () => false,
        _resolveActionPose: () => null,
        _getCellContentBounds: () => ({ minX: 20, maxX: 70, minY: 16, maxY: 86 }),
        _stableFootAnchor: () => ({ cx2: 92, maxY: 86 }),
        _stableContentWidth: () => 48,
        _setBodyBox: () => {},
        _layoutGroundMarks: () => {},
        _layoutLanternMark: () => {},
        _layoutArtifactMark: () => {},
        _layoutRibbonMark: () => {},
        _layoutCairnMark: () => {},
        _seatStoneStamps: () => null,
        _snowSettled: () => false,
        _drawLowZoomImpostor(target, z) {
            if (target === lowerCtx) lowerOps.push({ op: 'impostor', x: this._placeX, y: this._placeY, z });
        },
        _drawToolGlyphBadge(target) {
            if (target === lowerCtx) lowerOps.push({ op: 'glyph' });
        },
        _drawNameTag(target) {
            if (target === lowerCtx) lowerOps.push({ op: 'name' });
        },
    });
    const lowerCtx = { save() {}, restore() {}, canvas: { _claudeVilleDpr: 2 } };

    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');

    assert.equal(sprite._lowZoomImpostor, false, 'resident GPU renders regular body at survey zoom instead of hidden-canvas impostor');
    assert.equal(sprite._gpuFrameRecord?.id, 'agent:survey-1');
    assert.equal(sprite._gpuFrameRecord.x, 320 - 46, 'resident body updates to current coordinates (not stale -100)');
    assert.equal(sprite._gpuFrameRecord.y, 180 - 86 + 2);
    assert.equal(lowerOps.length, 0, 'resident GPU must not paint low-zoom impostor onto hidden lower canvas');

    // Moving sprite at survey zoom updates the resident body record to new coordinates.
    sprite.x = 380;
    sprite.y = 210;
    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');
    assert.equal(sprite._gpuFrameRecord.x, 380 - 46);
    assert.equal(sprite._gpuFrameRecord.y, 210 - 86 + 2);

    // Canvas path keeps its untouched depth-ordered survey impostor + tool glyph.
    sprite.gpuWorldEnabled = false;
    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');
    assert.equal(sprite._lowZoomImpostor, true);
    assert.equal(sprite._gpuFrameRecord, null);
    assert.deepEqual(lowerOps, [
        { op: 'impostor', x: 380, y: 210, z: 0.5 },
        { op: 'glyph' },
    ]);
    // Even if _onOpenFloor is true on Canvas, drawDeferredNameTag stays off during survey impostor mode.
    sprite._onOpenFloor = true;
    sprite.drawDeferredNameTag(lowerCtx);
    assert.equal(lowerOps.filter((o) => o.op === 'name').length, 0);
});

test('resident GPU skips Canvas-only wet reflection plan and computes lazily on fallback', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    let planCalls = 0;
    renderer.buildingRenderer = { getLightSources: () => [] };
    renderer._attentionLightSources = () => [];
    renderer._familiarMoteLightSources = () => [];
    renderer._lanternGroundLightSources = () => [{ id: 'lamp-1', kind: 'point', x: 0, y: 0, radius: 60, intensity: 1, color: '#ffc95e' }];
    renderer._villageWallLanternLightSources = () => [];
    renderer._carriedLanternLightSources = () => [];
    renderer.motionScale = 1;
    renderer._atmosphereReactions = { surfaceWetness: 0.9 };
    renderer._planWetSourceReflections = (sources) => {
        planCalls++;
        return { wetness: 0.9, entries: [{ light: sources[0], tiles: [] }] };
    };

    // Resident GPU frame: planWetReflections=false skips planning completely.
    renderer._computeFrameLightSources({ lighting: {} }, 1000, { planWetReflections: false });
    assert.equal(planCalls, 0);
    assert.equal(renderer._wetReflectionPlan, null);

    // Fallback frame calling _wetReflectionCovers computes lazily once.
    assert.equal(renderer._wetReflectionCovers(0, 0), true);
    assert.equal(planCalls, 1);
    assert.equal(renderer._wetReflectionCovers(0, 0), true);
    assert.equal(planCalls, 1, 'subsequent checks reuse the lazily built plan within the frame');

    // Canvas frame (default planWetReflections=true) computes eagerly.
    renderer._computeFrameLightSources({ lighting: {} }, 1000);
    assert.equal(planCalls, 2);
    assert.ok(renderer._wetReflectionPlan);
});

test('AgentGpuOverlayRenderer reuses live frame record and records array across normal frames while isolating stripProbe', () => {
    const host = {
        agent: { id: 'a1', provider: 'claude', status: 'working', currentTool: 'Read' },
        gpuWorldEnabled: true,
        spriteCanvas: { width: 736, height: 920 },
        spriteSheet: { cellSize: 92 },
        animState: 'idle',
        direction: 0,
        motionScale: 0,
        selected: false,
        hovered: false,
    };
    const overlay = new AgentGpuOverlayRenderer(host);
    const cell = { sx: 0, sy: 0, sw: 92, sh: 92 };
    overlay.setFrameRecord({ cell, dx: 10, dy: 20, drawScale: 1, profileKey: 'p', spriteId: 's' });
    const firstRec = host._gpuFrameRecord;
    const firstList = overlay.getRecords();

    overlay.setFrameRecord({ cell, dx: 30, dy: 40, drawScale: 1, profileKey: 'p', spriteId: 's' });
    assert.equal(host._gpuFrameRecord, firstRec, 'normal frame must reuse live frame record');
    assert.equal(host._gpuFrameRecord.x, 30);
    assert.equal(overlay.getRecords(), firstList, 'getRecords must reuse live array');

    // stripProbe must allocate a distinct object so _walkStripFor 6-cell arrays never alias.
    overlay.setFrameRecord({ cell, dx: 50, dy: 60, drawScale: 1, profileKey: 'p', spriteId: 's', stripProbe: true });
    assert.notEqual(host._gpuFrameRecord, firstRec);
});

test('_admitFrameReportCairns exits cleanly with zero cairns when no squads exist', () => {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.agentSprites = new Map([['a1', { agent: { id: 'a1' }, _cairnSpec: { stale: true } }]]);
    renderer.world = { agents: new Map([['a1', { id: 'a1' }]]) };
    renderer.relationshipState = { _returnedByParent: new Map(), getSquadRollups: () => [] };
    const sprites = [...renderer.agentSprites.values()];
    const admitted = renderer._admitFrameReportCairns(sprites, 2);
    assert.deepEqual(admitted, []);
    assert.equal(sprites[0]._cairnSpec, null);
});

test('buildGpuWorldRecords emits depth-ordered regular resident bodies and ground marks across close/survey transitions while preserving missing-body guards', () => {
    const sprite = Object.create(AgentSprite.prototype);
    const overlayRenderer = new AgentGpuOverlayRenderer(sprite);
    const sheetCanvas = { width: 736, height: 920, tag: 'sheet' };
    const shadowStamp = { width: 24, height: 9, __cvGroundKey: 'shadow:24x9' };
    const hoverStamp = { width: 32, height: 14, __cvGroundKey: 'hover:32x14' };
    const buildingCanvas = { width: 256, height: 232, tag: 'building.forge' };

    let arrivalPending = false;
    let archiveProgress = 0;

    Object.assign(sprite, {
        agent: { id: 'survey-1', name: 'Nova', provider: 'claude', model: 'claude-sonnet-4-5', status: 'working' },
        x: 320,
        y: 180,
        direction: 0,
        animState: 'idle',
        frame: 0,
        selected: false,
        hovered: true,
        gpuWorldEnabled: true,
        gpuOverlayRenderer: overlayRenderer,
        motionScale: 0,
        compositor: { spriteFor: () => sheetCanvas },
        spriteCanvas: sheetCanvas,
        spriteSheet: { cellSize: 92, cell: () => ({ sx: 0, sy: 0, sw: 92, sh: 92 }) },
        _cellBoundsCache: new Map(),
        _frozenTintCellCache: new Map(),
        _xraySilhouetteCache: new Map(),
        _occludedByWorld: false,
        _behindBuilding: false,
        isArrivalPending: () => arrivalPending,
        _archiveFadeProgress: () => archiveProgress,
        _providerKey: () => 'claude',
        _hashVariant: () => 0,
        signature: () => ({ key: 'sig' }),
        _runtimeHeadAccessory: () => null,
        _runtimeCodexEquipment: () => null,
        _shouldScrubBakedCodexWeapon: () => false,
        _teamTrimAccent: () => null,
        _syncProfileOwnership: () => {},
        _prepareSpriteCanvas: (c) => c,
        _updatePrivateDerivedEstimate: () => {},
        _moodPostureCue: () => ({ staticDy: 0, bobScale: 1, idleFrame: null }),
        _scenicPostureCue: () => null,
        _risenForChild: () => false,
        _seatedSeat: () => null,
        _distressPose: () => null,
        _stillWorkSettled: () => false,
        _resolveActionPose: () => null,
        _getCellContentBounds: () => ({ minX: 20, maxX: 70, minY: 16, maxY: 86 }),
        _stableFootAnchor: () => ({ cx2: 92, maxY: 86 }),
        _stableContentWidth: () => 48,
        _setBodyBox: () => {},
        _layoutLanternMark: () => {},
        _layoutArtifactMark: () => {},
        _layoutRibbonMark: () => {},
        _layoutCairnMark: () => {},
        _seatStoneStamps: () => null,
        _snowSettled: () => false,
        _drawLowZoomImpostor: () => {},
        _layoutGroundMarks() {
            const marks = [{ kind: 'shadow', stamp: shadowStamp, x: this._placeX - 12, y: this._placeY - 3, sunCast: false }];
            if (this.hovered) {
                marks.push({ kind: 'hover', stamp: hoverStamp, x: this._placeX - 16, y: this._placeY - 6, sunCast: false });
            }
            this._groundMarks = marks;
            return marks;
        },
    });

    const buildingAssets = {
        assetVersion: 'v1',
        get: (id) => (id === 'building.forge' ? buildingCanvas : null),
        getDims: (id) => (id === 'building.forge' ? { w: 256, h: 232 } : null),
        getAnchor: () => [128, 232],
        getEntry: (id) => (id === 'building.forge' ? { id } : null),
        getAtlasFrame: () => null,
        getSidecar: () => null,
        getMaterialSidecar: () => null,
        resolveMaterialChannels: () => ({ ready: true, origin: 'none' }),
    };
    const renderer = {
        assets: buildingAssets,
        camera: { zoom: 1.5, x: 0, y: 0 },
        _gpuAtlasResident: false,
    };
    const buildingDrawable = {
        kind: 'building',
        sortY: 190,
        payload: { kind: 'building', entry: { id: 'building.forge', material: {} }, building: { type: 'forge' }, wx: 320, wy: 190 },
    };
    const behindRoofDrawables = [{ kind: 'agent', sortY: 180, payload: sprite }, buildingDrawable];
    const frontDrawables = [buildingDrawable, { kind: 'agent', sortY: 220, payload: sprite }];
    const lowerCtx = { save() {}, restore() {}, canvas: { _claudeVilleDpr: 1 } };

    // 1. Close zoom (z = 1.5): emits ground marks + regular body record, ordered with ground before building.
    sprite._drawAtScreenPosition(lowerCtx, 1.5, 'full');
    assert.equal(sprite._lowZoomImpostor, false);
    assert.equal(sprite._gpuFrameRecord.id, 'agent:survey-1');
    assert.deepEqual(
        buildGpuWorldRecords(renderer, { drawables: frontDrawables }).map((r) => r.id),
        ['ground:survey-1:shadow', 'ground:survey-1:hover', 'building.forge:building', 'agent:survey-1'],
    );

    // 2. Close -> Survey transition (z = 0.5, unselected) behind roof:
    //    emits regular depth-ordered resident body + ground marks at current coordinates (no diamond token substitution,
    //    no stale position, building paints over covered body/ground pixels naturally).
    sprite.x = 360;
    sprite.y = 180;
    renderer.camera.zoom = 0.5;
    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');
    assert.equal(sprite._lowZoomImpostor, false);
    assert.equal(sprite._gpuFrameRecord.id, 'agent:survey-1');
    const surveyBehind = buildGpuWorldRecords(renderer, { drawables: behindRoofDrawables });
    assert.deepEqual(
        surveyBehind.map((r) => r.id),
        ['ground:survey-1:shadow', 'ground:survey-1:hover', 'agent:survey-1', 'building.forge:building'],
    );
    assert.equal(surveyBehind[0].x, 360 - 12);
    assert.equal(surveyBehind[1].x, 360 - 16);
    assert.equal(surveyBehind[2].x, 360 - 46);
    assert.equal(surveyBehind[2].width, 92);
    assert.equal(surveyBehind[2].height, 92);
    assert.notEqual(surveyBehind[0].writesDepth, true);
    assert.equal(surveyBehind[2].writesDepth, true);
    assert.equal(surveyBehind[2].depthSortY, 180);

    // 3. Survey agent in front of building (sortY 220 > 190): body sorts after building, ground stays before.
    assert.deepEqual(
        buildGpuWorldRecords(renderer, { drawables: frontDrawables }).map((r) => r.id),
        ['ground:survey-1:shadow', 'ground:survey-1:hover', 'building.forge:building', 'agent:survey-1'],
    );

    // 4. Arrival-pending, archive-complete, and missing-body guards suppress body and orphan ground marks at z=0.5.
    arrivalPending = true;
    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');
    assert.equal(sprite._gpuFrameRecord, null);
    assert.deepEqual(buildGpuWorldRecords(renderer, { drawables: behindRoofDrawables }).map((r) => r.id), ['building.forge:building']);
    assert.deepEqual(overlayRenderer.getGroundRecords(0), []);
    arrivalPending = false;

    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');
    archiveProgress = 1;
    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');
    assert.equal(sprite._gpuFrameRecord, null);
    assert.deepEqual(buildGpuWorldRecords(renderer, { drawables: behindRoofDrawables }).map((r) => r.id), ['building.forge:building']);
    assert.deepEqual(overlayRenderer.getGroundRecords(0), []);
    archiveProgress = 0;

    // 5. Survey -> Close transition keeps regular body + ground marks cleanly.
    renderer.camera.zoom = 0.5;
    sprite._drawAtScreenPosition(lowerCtx, 0.5, 'full');
    renderer.camera.zoom = 1.5;
    sprite._drawAtScreenPosition(lowerCtx, 1.5, 'full');
    assert.equal(sprite._lowZoomImpostor, false);
    assert.equal(sprite._gpuFrameRecord.id, 'agent:survey-1');
    assert.deepEqual(
        buildGpuWorldRecords(renderer, { drawables: frontDrawables }).map((r) => r.id),
        ['ground:survey-1:shadow', 'ground:survey-1:hover', 'building.forge:building', 'agent:survey-1'],
    );
});

test('releaseRenderResources clears pooled AgentSprite and AgentGpuOverlayRenderer sheet references and restores cleanly on resume', () => {
    const sprite = Object.create(AgentSprite.prototype);
    const overlayRenderer = new AgentGpuOverlayRenderer(sprite);
    const sheetV1 = { width: 736, height: 920, tag: 'decoded-v1' };
    const layerSheetV1 = { source: { width: 736, height: 920, tag: 'layer-v1' }, geometry: { width: 736, height: 920 }, emission: null, key: 'k1', x: 0, y: 0 };
    const hatV1 = { source: { width: 32, height: 32, tag: 'hat-v1' }, key: 'hat1', sx: 0, sy: 0, sw: 32, sh: 32, x: 0, y: 0 };
    const shadowStamp = { width: 24, height: 9, __cvGroundKey: 'shadow:24x9' };
    const walkCell = (frame) => ({ sx: 0, sy: frame * 92, sw: 92, sh: 92 });

    Object.assign(sprite, {
        agent: { id: 'leak-1', provider: 'claude', status: 'working', currentTool: 'Read' },
        gpuWorldEnabled: true,
        gpuOverlayRenderer: overlayRenderer,
        spriteCanvas: sheetV1,
        spriteSheet: { cellSize: 92, cell: (_anim, _dir, frame) => walkCell(frame) },
        animState: 'walk',
        direction: 0,
        motionScale: 1,
        selected: false,
        hovered: false,
        _frozenTintCellCache: new Map(),
        _xraySilhouetteCache: new Map(),
        _cellBoundsCache: new Map([['0,0', { minX: 0 }]]),
        _resourceOwnerKey: 'leak-1',
        _ownedProfileKey: null,
        _groundMarks: [{ kind: 'shadow', stamp: shadowStamp, x: 10, y: 20, sunCast: false }],
        _lowZoomImpostor: true,
        _poseCell: { canvas: sheetV1, sx: 0, sy: 0, sw: 92, sh: 92 },
        _frameGeometry: { cell: walkCell(0), markPose: { source: sheetV1 } },
        _layerCell: { sx: 0, sy: 0, sw: 92, sh: 92 },
        _layerFrameObj: { hat: hatV1, sheathed: false },
        _layerDesc: { sheet: layerSheetV1, cell: { sx: 0, sy: 0, sw: 92, sh: 92 }, palette: { key: 'p1', variant: 0 } },
    });
    sprite._gpuRecordArgs = {
        cell: walkCell(0),
        dx: 10,
        dy: 20,
        drawScale: 1,
        profileKey: 'p1',
        spriteId: 'agent.claude.base',
        frameGeometry: sprite._frameGeometry,
        layer: sprite._layerDesc,
        pose: { source: sheetV1 },
    };

    // Populate AgentGpuOverlayRenderer pools (live frame record, live records array, walk strip ref, ground records).
    overlayRenderer.setFrameRecord({
        cell: walkCell(0),
        dx: 10,
        dy: 20,
        drawScale: 1,
        profileKey: 'p1',
        spriteId: 'agent.claude.base',
    });
    assert.equal(overlayRenderer.getRecords().length, 1);
    assert.equal(overlayRenderer.getGroundRecords(0).length, 1);
    assert.equal(overlayRenderer._liveFrameRecord.source, sheetV1);
    assert.equal(overlayRenderer._liveRecords[0], overlayRenderer._liveFrameRecord);
    assert.ok(overlayRenderer._liveWalkStripRef?.cells?.length > 0);
    assert.ok(overlayRenderer._walkStrip?.cells?.length > 0);
    assert.equal(sprite._layerDesc.sheet, layerSheetV1);
    assert.equal(sprite._gpuRecordArgs.layer, sprite._layerDesc);

    // Suspend to Dashboard: releaseRenderResources must drop every pooled sheet/canvas reference.
    sprite.releaseRenderResources();
    assert.equal(sprite.spriteCanvas, null);
    assert.equal(sprite.spriteSheet, null);
    assert.equal(sprite._gpuFrameRecord, null);
    assert.equal(sprite._layerFrame, null);
    assert.equal(sprite._layerFrameObj, null);
    assert.equal(sprite._layerDesc, null);
    assert.equal(sprite._layerCell, null);
    assert.equal(sprite._gpuRecordArgs, null);
    assert.equal(sprite._frameGeometry, null);
    assert.equal(sprite._poseCell, null);
    assert.equal(sprite._groundMarks, null);
    assert.equal(sprite._lowZoomImpostor, false);
    assert.equal(overlayRenderer._liveFrameRecord, null);
    assert.equal(overlayRenderer._liveRecords, null);
    assert.equal(overlayRenderer._liveWalkStripRef, null);
    assert.equal(overlayRenderer._walkStrip, null);
    assert.equal(overlayRenderer._groundRecords, null);
    assert.deepEqual(overlayRenderer.getRecords(), []);
    assert.deepEqual(overlayRenderer.getGroundRecords(0), []);

    // Resume from Dashboard suspension: pools recreate cleanly with the restored sheet and reuse across frames.
    const sheetV2 = { width: 736, height: 920, tag: 'decoded-v2' };
    sprite.spriteCanvas = sheetV2;
    sprite.spriteSheet = { cellSize: 92, cell: (_anim, _dir, frame) => walkCell(frame) };
    sprite._groundMarks = [{ kind: 'shadow', stamp: shadowStamp, x: 40, y: 50, sunCast: false }];
    overlayRenderer.setFrameRecord({
        cell: walkCell(1),
        dx: 40,
        dy: 50,
        drawScale: 1,
        profileKey: 'p1',
        spriteId: 'agent.claude.base',
    });
    const restoredRec = sprite._gpuFrameRecord;
    const restoredList = overlayRenderer.getRecords();
    const restoredGround = overlayRenderer.getGroundRecords(1);
    assert.equal(restoredRec.source, sheetV2);
    assert.equal(restoredList.length, 1);
    assert.equal(restoredList[0], restoredRec);
    assert.equal(restoredGround.length, 1);
    assert.equal(restoredGround[0].id, 'ground:leak-1:shadow');
    assert.equal(restoredGround[0].x, 40);
    assert.ok(overlayRenderer._liveWalkStripRef?.cells?.length > 0);
    assert.equal(overlayRenderer._liveWalkStripRef.cells[0].source, sheetV2);

    // Subsequent resumed frame reuses the newly allocated live pools.
    overlayRenderer.setFrameRecord({
        cell: walkCell(2),
        dx: 48,
        dy: 54,
        drawScale: 1,
        profileKey: 'p1',
        spriteId: 'agent.claude.base',
    });
    assert.equal(sprite._gpuFrameRecord, restoredRec);
    assert.equal(overlayRenderer.getRecords(), restoredList);
    assert.equal(sprite._gpuFrameRecord.x, 48);
});
