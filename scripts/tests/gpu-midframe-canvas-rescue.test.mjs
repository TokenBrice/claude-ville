import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorldFrame } from '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { MarkGovernor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { createMotionClock } from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { createFramePacing } from '../../claudeville/src/presentation/character-mode/FramePacing.js';

function createMockCtx(width = 320, height = 200) {
    const ops = [];
    const canvas = { width, height };
    return {
        canvas,
        ops,
        save() { ops.push('save'); },
        restore() { ops.push('restore'); },
        setTransform() {},
        scale() {},
        translate() {},
        clearRect(x, y, w, h) { ops.push(['clearRect', x, y, w, h]); },
        fillRect(x, y, w, h) { ops.push(['fillRect', x, y, w, h]); },
        strokeRect() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        arc() {},
        ellipse() {},
        rect() {},
        clip() {},
        fill() {},
        stroke() {},
        drawImage() { ops.push('drawImage'); },
        fillText() {},
        strokeText() {},
        measureText: () => ({ width: 20 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '#000',
        strokeStyle: '#000',
        font: '10px monospace',
        textAlign: 'left',
        textBaseline: 'top',
        imageSmoothingEnabled: false,
    };
}

function createRenderFixture({ mode = 'webgl', gpuWorld = null } = {}) {
    const ctx = createMockCtx();
    const overlayCtx = createMockCtx();
    const fxCanvas = { width: 320, height: 200, style: { display: 'block' }, cloneNode: () => ({ width: 320, height: 200, style: {} }) };
    const log = {
        skyGraded: [],
        horizonGraded: [],
        terrainDraws: 0,
        buildingDraws: 0,
        agentCanvasDraws: 0,
        agentGpuModes: [],
        atmosphereDraws: 0,
        wetPlans: [],
        fxVisibleHistory: [],
        markBeginFrames: 0,
    };
    const markGovernor = new MarkGovernor();
    const origBegin = markGovernor.beginFrame.bind(markGovernor);
    markGovernor.beginFrame = opts => {
        log.markBeginFrames++;
        return origBegin(opts);
    };

    const agentSprite = {
        agent: { id: 'agent-1', name: 'A1', state: 'working', provider: 'claude' },
        x: 100,
        y: 120,
        _gpuEnabled: false,
        setLightingState() {},
        setGpuWorldEnabled(enabled) {
            this._gpuEnabled = enabled;
            log.agentGpuModes.push(enabled);
        },
        draw(drawCtx) {
            // Mirrors AgentSprite.draw: when resident GPU mode is active, body
            // pixels are skipped on the lower 2D canvas and emitted as GPU records.
            if (this._gpuEnabled) return;
            log.agentCanvasDraws++;
            drawCtx.fillRect(90, 100, 16, 24);
        },
        getGpuWorldRecords() {
            return [{
                id: 'agent:agent-1:body',
                textureKey: 'agent:1',
                source: { width: 16, height: 24 },
                x: 90, y: 100, width: 16, height: 24,
                sx: 0, sy: 0, sw: 16, sh: 24,
            }];
        },
        getSortY: () => 120,
        getWorldBounds: () => ({ left: 80, top: 80, right: 120, bottom: 130 }),
    };

    const atmosphere = {
        clock: { minuteOfDay: 1320, hour: 22 },
        weather: { type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0.1, windX: 0 },
        grade: { name: 'night', ambient: 0.25 },
        lightGrade: { exposure: 1, saturation: 1, gain: [1, 1, 1], lift: [0, 0, 0], gamma: [1, 1, 1], purkinje: [0, 0, 0], shadowTint: [0, 0, 0], highlightTint: [1, 1, 1], vignetteEdge: [0, 0, 0], edgeAlpha: 0, poolGain: 1, sunBand: 0 },
        lighting: { ambientLight: 0.2, sunDirIso: { x: 0.5, y: 0.5 } },
        reactions: {},
        solar: { elevationDeg: -20 },
    };

    const r = Object.assign(Object.create(IsometricRenderer.prototype), {
        running: true,
        _disposed: false,
        _worldModeActive: true,
        _worldResourcesSuspended: false,
        _worldResourceGeneration: 0,
        _visibilityPaused: false,
        _contextLost: false,
        _frameFailureStats: {
            total: 0, consecutive: 0, lastStage: null, lastMessage: null,
            lastAt: 0, lastReportedAt: -Infinity, byStage: {}, paused: false,
        },
        _motionClock: createMotionClock(),
        motionScale: 1,
        _lastFrameTime: null,
        _lastLoopFrameTime: null,
        _framePacing: createFramePacing(),
        _idleFrameDirty: true,
        _fallbackPrep: null,
        _worldSwap: null,
        presentGeneration: 0,
        worldRendererMode: mode,
        ctx,
        canvas: ctx.canvas,
        overlayCtx,
        fxCanvas,
        gpuWorld,
        postFx: null,
        markGovernor,
        _drawables: [],
        _lastAtmosphere: atmosphere,
        atmosphereState: { update: () => atmosphere },
        camera: {
            x: 100, y: 120, zoom: 1,
            renderOffsetX: 0, renderOffsetY: 0,
            fatFlight: false,
            applyTransform() {},
            latchGpuFrame() {},
            screenToWorld: (sx, sy) => ({ x: sx, y: sy }),
            getViewportWorldBounds: () => ({ left: -200, top: -200, right: 600, bottom: 600 }),
        },
        skyRenderer: {
            draw(_ctx, opts) { log.skyGraded.push(Boolean(opts.backdropGraded)); },
            farSeaLayers: () => null,
        },
        buildingRenderer: {
            buildings: [],
            setLightingState() {},
            setAtmosphereState() {},
            syncRoofWeather() {},
            enumerateDrawables: () => [{
                kind: 'building',
                sortY: 110,
                bounds: { left: 40, top: 40, right: 90, bottom: 110 },
            }],
            drawDrawable(drawCtx) {
                log.buildingDraws++;
                drawCtx.fillRect(40, 40, 50, 70);
            },
            drawShadows() {},
            drawLabels() {},
        },
        agentSprites: new Map([['agent-1', agentSprite]]),
        _screenViewport: () => ({ width: 320, height: 200 }),
        _screenDpr: () => 1,
        _resetScreenTransform() {},
        _setPostFxCanvasVisible(visible) {
            const v = Boolean(visible);
            log.fxVisibleHistory.push(v);
            this._postFxCanvasVisible = v;
            if (this.fxCanvas) this.fxCanvas.style.display = v ? 'block' : 'none';
        },
        _computeFrameLightSources(_atmo, _now, opts) {
            log.wetPlans.push(Boolean(opts?.planWetReflections));
            return { ambient: [], wet: [] };
        },
        _drawDistantSeaHorizon(_ctx, _atmo, opts) {
            log.horizonGraded.push(Boolean(opts?.gpuGraded));
        },
        _drawTerrain(drawCtx) {
            log.terrainDraws++;
            drawCtx.fillRect(0, 0, 320, 200);
        },
        _getTerrainCache: () => ({ canvas: { width: 320, height: 200 }, bounds: { x: 0, y: 0, w: 320, h: 200 } }),
        _drawSkyCanopy() {},
        _drawAtmosphere() { log.atmosphereDraws++; },
        _snapshotSortedSprites: () => [agentSprite],
        _enumeratePropDrawables: () => [],
        _enumerateFamiliarMoteDrawables: () => [],
        _assignAgentOverlaySlots() {},
        _collectAgentLabelHitRects: () => [],
        _harborPendingReposSignature: () => '',
        _syncPropWinter() {},
        _prepareTerrainArtifactFrame: () => true,
        _updateGateDoorState() {},
        villageLampsLit: () => false,
        _agentRenderMode: () => ({ body: 'full', annotation: 'full' }),
        _admitFrameReportCairns() {},
        _drawSurfaceWetnessMarks() {},
        _drawChimneySmokeStatic() {},
        _lanternNightFactor: () => 0,
        _syncSemanticSummary() {},
        _recordIdleRenderState() { this._idleFrameDirty = false; },
        _signalFirstFrame() {},
        _recordFrameSuccess() { this._frameFailureStats.consecutive = 0; },
        _reportFrameFailure(err) { throw err; },
        _recordFrameEnvelope() {},
        _trackFps() {},
        _applyDisplayColor() {},
        _noteWorldBackend(note) { this.worldBackendReason = note; },
        _replaceFxCanvas(next) { this.fxCanvas = next; },
        _invalidateIdleFrame() { this._idleFrameDirty = true; },
        _requiresFreshGpuOutput: () => false,
        getReadMode: () => false,
    });

    return { r, ctx, overlayCtx, agentSprite, log };
}

test('WebGL2 mid-frame render() returning false performs bounded same-frame full Canvas rescue and preserves recovery', () => {
    let gpuCalls = 0;
    let healthy = true;
    const webgl = {
        backend: 'webgl',
        width: 320,
        height: 200,
        frames: 3,
        isActive: () => healthy,
        prepareFrame() {},
        render() {
            gpuCalls++;
            // Simulate mid-frame failure (sets contextHealthy false) on call 1.
            if (gpuCalls === 1) {
                healthy = false;
                return false;
            }
            this.frames++;
            return true;
        },
    };
    const { r, agentSprite, log } = createRenderFixture({ mode: 'webgl', gpuWorld: webgl });

    assert.equal(renderWorldFrame(r, 16, false), true);
    assert.equal(gpuCalls, 1, 'rescue must not re-invoke gpuWorld.render');
    assert.equal(r.fxCanvas.style.display, 'none', 'FX canvas must be hidden after false draw');
    assert.equal(log.terrainDraws, 1, 'Canvas rescue must draw terrain on lower canvas');
    assert.equal(log.buildingDraws, 1, 'Canvas rescue must draw buildings on lower canvas');
    assert.equal(log.agentCanvasDraws, 1, 'Canvas rescue must draw agents on lower canvas');
    assert.equal(agentSprite._gpuEnabled, false, 'agent sprite returns to Canvas mode during rescue');
    assert.equal(log.atmosphereDraws, 1, 'atmosphere grades the rescued Canvas world exactly once');
    assert.deepEqual(log.skyGraded, [true, false], 'first pass drew resident sky, rescue drew ungraded Canvas sky');
    assert.deepEqual(log.wetPlans, [false, true], 'rescue plans Canvas wet reflections');
    assert.equal(log.markBeginFrames, 1, 'markGovernor resets before rescue pass');
    assert.equal(r.worldRendererMode, 'webgl', 'transient/recoverable WebGL2 failure preserves webgl mode');
    assert.equal(r.gpuWorld, webgl, 'WebGL2 world stays attached for webglcontextrestored recovery');

    // Simulate webglcontextrestored: next frame resumes WebGL2 cleanly.
    healthy = true;
    assert.equal(renderWorldFrame(r, 16, false), true);
    assert.equal(gpuCalls, 2, 'restored WebGL2 resumes rendering on next frame');
    assert.equal(r.fxCanvas.style.display, 'block', 'FX canvas re-appears once WebGL2 succeeds');
    assert.equal(log.terrainDraws, 1, 'healthy WebGL2 frame skips Canvas terrain again');
});

test('transient WebGL2 render() false while isActive() stays true stays strictly bounded to one rescue pass', () => {
    let gpuCalls = 0;
    const webgl = {
        backend: 'webgl',
        width: 320,
        height: 200,
        frames: 1,
        isActive: () => true, // stays active (e.g. empty batches)
        prepareFrame() {},
        render() {
            gpuCalls++;
            return false;
        },
    };
    const { r, log } = createRenderFixture({ mode: 'webgl', gpuWorld: webgl });

    assert.equal(renderWorldFrame(r, 16, false), true);
    assert.equal(gpuCalls, 1, 'bounded rescue must call gpuWorld.render at most once per frame');
    assert.equal(log.terrainDraws, 1, 'full Canvas rescue drew terrain once');
    assert.equal(log.buildingDraws, 1, 'full Canvas rescue drew buildings once');
    assert.equal(log.agentCanvasDraws, 1, 'full Canvas rescue drew agents once');
    assert.equal(r.fxCanvas.style.display, 'none');
});

test('renderNow() rescues WebGL2 mid-frame false draw to full Canvas and presents cleanly', () => {
    let gpuCalls = 0;
    const webgl = {
        backend: 'webgl',
        width: 320,
        height: 200,
        frames: 2,
        isActive: () => true,
        prepareFrame() {},
        render() {
            gpuCalls++;
            return false;
        },
    };
    const { r, log } = createRenderFixture({ mode: 'webgl', gpuWorld: webgl });

    assert.equal(r.renderNow(), true);
    assert.equal(gpuCalls, 1);
    assert.equal(log.terrainDraws, 1, 'renderNow must draw full Canvas rescue instead of sky');
    assert.equal(log.agentCanvasDraws, 1);
    assert.equal(r.fxCanvas.style.display, 'none');
    assert.equal(r.presentGeneration, 1);
});

test('renderNow() with fatal WebGPU mid-frame failure hands off to WebGL2 without redundant Canvas draw, and rescues to Canvas if WebGL2 also fails', () => {
    // Part 1: WebGPU fails mid-frame in renderNow(), WebGL2 fallback succeeds -> 0 Canvas terrain draws!
    {
        let webglCalls = 0;
        const webglFallback = {
            backend: 'webgl',
            width: 320,
            height: 200,
            frames: 0,
            isActive: () => true,
            prepareFrame() {},
            render() {
                webglCalls++;
                this.frames++;
                return true;
            },
            dispose() {},
        };
        const webgpu = {
            backend: 'webgpu',
            width: 320,
            height: 200,
            frames: 5,
            failure: null,
            isActive() { return !this.failure; },
            prepareFrame() {},
            render() {
                this.failure = { stage: 'frame', summary: 'frame: validation' };
                return false;
            },
            dispose() {},
        };
        const { r, log } = createRenderFixture({ mode: 'webgpu', gpuWorld: webgpu });
        r._fallBackFromWebGpu = ({ inFrame } = {}) => {
            assert.equal(inFrame, true);
            r._worldSwap = { gpuWorld: webglFallback, canvas: r.fxCanvas.cloneNode(false), previous: null, fallback: 'failed in frame: frame: validation' };
        };

        assert.equal(r.renderNow(), true);
        assert.equal(webglCalls, 1, 'WebGL2 fallback rendered in the same task');
        assert.equal(log.terrainDraws, 0, 'working WebGL2 fallback avoids redundant full Canvas rescue');
        assert.equal(r.worldRendererMode, 'webgl');
        assert.equal(r.gpuWorld, webglFallback);
        assert.equal(r.fxCanvas.style.display, 'block');
    }

    // Part 2: WebGPU fails mid-frame AND WebGL2 fallback ALSO returns false -> same-frame full Canvas rescue + permanent Canvas drop!
    {
        let webglCalls = 0;
        let webglDisposed = false;
        const brokenWebgl = {
            backend: 'webgl',
            width: 320,
            height: 200,
            frames: 0,
            isActive: () => true,
            prepareFrame() {},
            render() {
                webglCalls++;
                return false;
            },
            dispose() { webglDisposed = true; },
        };
        const webgpu = {
            backend: 'webgpu',
            width: 320,
            height: 200,
            frames: 5,
            failure: null,
            isActive() { return !this.failure; },
            prepareFrame() {},
            render() {
                this.failure = { stage: 'frame', summary: 'frame: oom' };
                return false;
            },
            dispose() {},
        };
        const { r, log } = createRenderFixture({ mode: 'webgpu', gpuWorld: webgpu });
        r._fallBackFromWebGpu = () => {
            r._worldSwap = { gpuWorld: brokenWebgl, canvas: r.fxCanvas.cloneNode(false), previous: null, fallback: 'failed in frame: frame: oom' };
        };

        assert.equal(r.renderNow(), true);
        assert.equal(webglCalls, 1);
        assert.equal(log.terrainDraws, 1, 'failing WebGL2 fallback still lands a same-frame full Canvas rescue');
        assert.equal(log.agentCanvasDraws, 1);
        assert.equal(r.fxCanvas.style.display, 'none');
        assert.equal(webglDisposed, false, 'still-active WebGL2 swap stays armed or drops when inactive');
    }
});

test('recoverable WebGPU device-loss or non-failure false draw rescues to Canvas while preserving WebGPU recovery semantics', () => {
    const webgpu = {
        backend: 'webgpu',
        width: 320,
        height: 200,
        frames: 4,
        failure: null, // recoverable unknown device loss or transient false draw sets NO fatal failure
        healthy: true,
        isActive() { return this.healthy; },
        prepareFrame() {},
        render() {
            this.healthy = false;
            return false;
        },
        dispose() { throw new Error('recoverable WebGPU world must not be disposed'); },
    };
    const { r, log } = createRenderFixture({ mode: 'webgpu', gpuWorld: webgpu });

    assert.equal(r.renderNow(), true);
    assert.equal(log.terrainDraws, 1, 'non-fatal WebGPU false draw rescues same-frame to full Canvas');
    assert.equal(log.agentCanvasDraws, 1);
    assert.equal(r.fxCanvas.style.display, 'none');
    assert.equal(r.worldRendererMode, 'webgpu', 'preserves webgpu mode for _rebuildDevice()');
    assert.equal(r.gpuWorld, webgpu, 'preserves WebGPU world instance for rebuild recovery');
});

test('WebGL2-to-WebGPU upgrade swap returning false rescues current frame to Canvas and restores WebGL2 for next frame', () => {
    const prevWebgl = {
        backend: 'webgl',
        width: 320,
        height: 200,
        frames: 10,
        isActive: () => true,
        prepareFrame() {},
        render() { this.frames++; return true; },
        dispose() { throw new Error('previous WebGL2 must survive failed upgrade swap'); },
    };
    let nextDisposed = false;
    const badWebgpu = {
        backend: 'webgpu',
        width: 320,
        height: 200,
        frames: 0,
        healthy: true,
        failure: null,
        isActive() { return this.healthy && !this.failure; },
        prepareFrame() {},
        render() {
            this.healthy = false;
            this.failure = { stage: 'frame', summary: 'frame: bad swap' };
            return false;
        },
        dispose() { nextDisposed = true; },
    };
    const { r, log } = createRenderFixture({ mode: 'webgl', gpuWorld: prevWebgl });
    r._worldSwap = { gpuWorld: badWebgpu, canvas: r.fxCanvas.cloneNode(false), previous: null, fallback: null };

    const swap = r._beginWorldSwap();
    assert.ok(swap);
    assert.equal(r._renderWithFallback(16, false, swap), true);
    assert.equal(log.terrainDraws, 1, 'failed upgrade swap rescues current frame to full Canvas');
    assert.equal(log.agentCanvasDraws, 1);
    assert.equal(nextDisposed, true, 'failed WebGPU candidate is disposed');
    assert.equal(r.gpuWorld, prevWebgl, 'previous WebGL2 world is restored for subsequent frames');
    assert.equal(r.worldRendererMode, 'webgl');
});
