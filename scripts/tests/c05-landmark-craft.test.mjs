import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as artPalette from '../../claudeville/src/config/artPalette.js';
import { WeatherRenderer } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { WINTER_PROPS } from '../../claudeville/src/presentation/character-mode/PropWinter.js';
import { IsleLandmarks } from '../../claudeville/src/presentation/character-mode/IsleLandmarks.js';
import { RAMP_LANDMARKS } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { collectSpriteEntries, loadSpriteManifest } from '../sprites/manifest-utils.mjs';
import { bakeSurfaceChannel, SURFACE_SPECS } from '../sprites/bake-surface-channel.mjs';

function makeRecorderCtx() {
    const rectsByStyle = new Map();
    let currentStyle = '';
    let currentAlpha = 1;
    let pending = [];
    return {
        rectsByStyle,
        save() {},
        restore() {},
        set fillStyle(v) { currentStyle = String(v).toLowerCase(); },
        get fillStyle() { return currentStyle; },
        set globalAlpha(v) { currentAlpha = v; },
        get globalAlpha() { return currentAlpha; },
        beginPath() { pending = []; },
        rect(x, y, w, h) { pending.push({ x, y, w, h, alpha: currentAlpha }); },
        fill() {
            const list = rectsByStyle.get(currentStyle) || [];
            list.push(...pending);
            rectsByStyle.set(currentStyle, list);
            pending = [];
        },
        fillRect(x, y, w, h) {
            const list = rectsByStyle.get(currentStyle) || [];
            list.push({ x, y, w, h, alpha: currentAlpha });
            rectsByStyle.set(currentStyle, list);
        },
    };
}

function makeWorldCamera(width, height, zoom = 1, centerX = 0, centerY = 500) {
    return {
        zoom,
        _viewportWidth: () => width,
        _viewportHeight: () => height,
        worldToScreen(wx, wy) {
            return { x: (wx - centerX) * zoom + width / 2, y: (wy - centerY) * zoom + height / 2 };
        },
        screenToWorld(sx, sy) {
            return { x: (sx - width / 2) / zoom + centerX, y: (sy - height / 2) / zoom + centerY };
        },
    };
}

test('C-05 snow: 5120x1440 storm fills all five vertical bands within 24..420 cap using C1 palette shadow', () => {
    assert.ok(artPalette.WEATHER_SNOW_COLORS?.shadow, 'artPalette must export WEATHER_SNOW_COLORS.shadow');
    assert.ok(artPalette.WEATHER_SNOW_COLORS?.body, 'artPalette must export WEATHER_SNOW_COLORS.body');

    const wr = new WeatherRenderer();
    const width = 4880;
    const height = 1392;
    wr.sceneContext = { camera: makeWorldCamera(width, height, 1, 0, 500) };
    const ctx = makeRecorderCtx();
    const weather = { type: 'storm', intensity: 0.9, precipitation: 0.9, windX: -0.6, seed: 4242 };
    wr._drawSnow(ctx, { width, height }, weather, 1234, 4242, true);

    const bodyKey = artPalette.WEATHER_SNOW_COLORS.body.toLowerCase();
    const shadowKey = artPalette.WEATHER_SNOW_COLORS.shadow.toLowerCase();
    const bodies = ctx.rectsByStyle.get(bodyKey) || [];
    const shadows = ctx.rectsByStyle.get(shadowKey) || [];

    assert.ok(bodies.length >= 24 && bodies.length <= 420,
        `expected 24..420 flake bodies at 5120x1440 storm, got ${bodies.length}`);
    assert.ok(shadows.length > 0, 'expected 2x1 underside shadows under 2x2 flakes');

    // Verify all 5 horizontal bands across the full 1392px height get flakes (no bottom-2/5 starvation).
    const bands = [0, 0, 0, 0, 0];
    for (const r of bodies) {
        const idx = Math.max(0, Math.min(4, Math.floor((r.y / height) * 5)));
        bands[idx]++;
    }
    for (let b = 0; b < 5; b++) {
        assert.ok(bands[b] >= Math.floor(bodies.length * 0.1),
            `vertical band ${b}/5 got only ${bands[b]}/${bodies.length} flakes (${bands.join(',')})`);
    }

    // Reduced motion freezes flake coordinates across time.
    const ctxR0 = makeRecorderCtx();
    const ctxR1 = makeRecorderCtx();
    wr._drawSnow(ctxR0, { width: 1680, height: 1032 }, weather, 0, 4242, false);
    wr._drawSnow(ctxR1, { width: 1680, height: 1032 }, weather, 9500, 4242, false);
    assert.deepEqual(ctxR0.rectsByStyle.get(bodyKey), ctxR1.rectsByStyle.get(bodyKey),
        'reduced-motion snow field must stay frozen across phaseMs');
});

test('C-05 snow: world-anchored flakes hold their world coordinates across zoom changes', () => {
    const wr = new WeatherRenderer();
    const weather = { type: 'rain', intensity: 0.78, precipitation: 0.85, windX: -0.45, seed: 4242 };
    const bodyKey = (artPalette.WEATHER_SNOW_COLORS?.body || '#eef6ff').toLowerCase();

    const cam1 = makeWorldCamera(1680, 1032, 1, 0, 500);
    wr.sceneContext = { camera: cam1 };
    const ctx1 = makeRecorderCtx();
    wr._drawSnow(ctx1, { width: 1680, height: 1032 }, weather, 2500, 4242, true);
    const worldPts1 = (ctx1.rectsByStyle.get(bodyKey) || []).map(r => cam1.screenToWorld(r.x, r.y));

    const cam2 = makeWorldCamera(1680, 1032, 2, 0, 500);
    wr.sceneContext = { camera: cam2 };
    const ctx2 = makeRecorderCtx();
    wr._drawSnow(ctx2, { width: 1680, height: 1032 }, weather, 2500, 4242, true);
    const worldPts2 = (ctx2.rectsByStyle.get(bodyKey) || []).map(r => cam2.screenToWorld(r.x, r.y));

    // A zoom-in keeps the screen density (it adds flakes, never moves one):
    // every z1 flake still inside the z2 view is drawn at the same world spot.
    assert.ok(worldPts2.length >= worldPts1.length * 0.8,
        `screen density must hold across zoom: z1 ${worldPts1.length}, z2 ${worldPts2.length}`);
    const z2View = { left: cam2.screenToWorld(16, 16), right: cam2.screenToWorld(1680 - 16, 1032 - 16) };
    const inside = worldPts1.filter(p => p.x >= z2View.left.x && p.x <= z2View.right.x && p.y >= z2View.left.y && p.y <= z2View.right.y);
    assert.ok(inside.length > 10, `expected z1 flakes inside the z2 view, got ${inside.length}`);
    let kept = 0;
    for (const p1 of inside) {
        if (worldPts2.some(p2 => Math.abs(p1.x - p2.x) <= 2 && Math.abs(p1.y - p2.y) <= 2)) kept++;
    }
    assert.ok(kept >= Math.floor(inside.length * 0.9),
        `z1 flakes inside the z2 view must hold their world spot, got ${kept}/${inside.length}`);
});

test('C-05 landmarks: Belfry snow invalidates in-place without GPU texture-key churn; Windmill & Rustic Bridge in WINTER_PROPS', t => {
    assert.ok(WINTER_PROPS['prop.windmill'], 'prop.windmill must be in WINTER_PROPS');
    assert.ok(WINTER_PROPS['prop.hourglassBelfry'], 'prop.hourglassBelfry must be in WINTER_PROPS');
    assert.ok(WINTER_PROPS['bridge.landmark.rustic.ns'], 'bridge.landmark.rustic.ns must be in WINTER_PROPS');

    globalThis.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
                imageSmoothingEnabled: false,
                translate() {},
                drawImage() {},
                save() {},
                restore() {},
            }),
        }),
    };
    t.after(() => { delete globalThis.document; });

    const winterImagesUsed = [];
    const host = {
        motionScale: 1,
        motionTimeMs: 0,
        propWinter: {
            key: 'winter:0',
            image: (id) => (host.propWinter.key === 'winter:4' ? { id, snow: true } : null),
        },
        assets: {
            get: () => ({ width: 128, height: 128 }),
            getAnchor: () => [64, 100],
            getEntry: () => ({ width: 128, height: 128, anchor: [64, 100] }),
        },
        sprites: {
            drawSprite(_ctx, id, _x, _y, opts) { winterImagesUsed.push({ id, snow: Boolean(opts?.image?.snow) }); },
        },
    };
    const landmarks = new IsleLandmarks(host);
    const sprites = landmarks.buildSprites();
    const belfry = sprites.find(s => s.id === 'prop.hourglassBelfry');
    const windmill = sprites.find(s => s.id === 'prop.windmill');
    assert.ok(belfry && windmill, 'expected Belfry and Windmill sprites');

    // Step Belfry across stream phases and snow buckets: _gpuCacheRevision bumps, textureKey never churns.
    belfry.setGlasses({ claude: { state: 'level', level: 3, used: 0.4 }, codex: { state: 'level', level: 3, used: 0.4 } });
    belfry.setDrain({ claude: { used: 0.4, roseAt: Date.now() }, codex: { used: 0.4, roseAt: Date.now() } });
    const c0 = belfry._getCachedCanvas(1);
    const rev0 = belfry._gpuCacheRevision;
    assert.equal(c0.textureKey, undefined, 'Belfry must use stable StaticPropSprite key, not a per-step textureKey');

    host.motionTimeMs = 500;
    const c1 = belfry._getCachedCanvas(1);
    assert.ok(belfry._gpuCacheRevision > rev0, 'Belfry must bump _gpuCacheRevision on stream step');
    assert.equal(c1.textureKey, undefined, 'Belfry textureKey must not churn on stream step');

    const revBeforeSnow = belfry._gpuCacheRevision;
    host.propWinter.key = 'winter:4';
    const c2 = belfry._getCachedCanvas(1);
    assert.ok(belfry._gpuCacheRevision > revBeforeSnow, 'Belfry must invalidate cache when propWinter.key changes');
    assert.equal(c2.textureKey, undefined, 'Belfry textureKey must remain stable on snow change');
    assert.ok(winterImagesUsed.some(e => e.id === 'prop.hourglassBelfry' && e.snow), 'Belfry must draw winter image');

    // Windmill invalidates sail frames and bumps revision on snow bucket change without leaking keys.
    host.propWinter.key = 'winter:0';
    const w0 = windmill._getCachedCanvas(1);
    const wRev0 = windmill._gpuCacheRevision;
    host.propWinter.key = 'winter:4';
    const w1 = windmill._getCachedCanvas(1);
    assert.ok(windmill._gpuCacheRevision > wRev0, 'Windmill must bump _gpuCacheRevision when propWinter.key changes');
    assert.equal(w0.textureKey, w1.textureKey, 'Windmill sail slot textureKey must stay stable across snow updates');
});

test('C-05 assets: Harbor & Watchtower material sidecars, Command surface channel exact match, Harbor off RAMP_LANDMARKS', () => {
    assert.equal(RAMP_LANDMARKS.has('harbor'), false, 'Harbor must stay off RAMP_LANDMARKS per operator decision #3');

    for (const type of ['harbor', 'watchtower']) {
        const matPath = new URL(`../../claudeville/assets/sprites/buildings/building.${type}/base.material.png`, import.meta.url);
        assert.ok(existsSync(matPath), `building.${type}/base.material.png must exist`);
        const png = PNG.sync.read(readFileSync(matPath));
        const classes = new Set();
        for (let i = 0; i < png.data.length; i += 4) if (png.data[i + 3]) classes.add(png.data[i]);
        assert.ok(classes.has(1) && classes.has(2) && classes.has(3),
            `building.${type} material sidecar must contain stone(1), timber(2), metal(3); got ${[...classes].join(',')}`);
    }

    const manifest = loadSpriteManifest();
    const entries = new Map(collectSpriteEntries(manifest).map(e => [e.id, e]));
    const cmdDef = BUILDING_DEFS.find(d => d.type === 'command');
    const cmdDir = new URL('../../claudeville/assets/sprites/buildings/building.command/', import.meta.url);
    const albedo = PNG.sync.read(readFileSync(new URL('base.png', cmdDir)));
    const emissive = PNG.sync.read(readFileSync(new URL('base.emissive.png', cmdDir)));
    const existing = PNG.sync.read(readFileSync(new URL('base.occluder.png', cmdDir)));
    const { png: baked } = bakeSurfaceChannel({
        def: cmdDef,
        entry: entries.get('building.command'),
        albedo,
        emissive,
        spec: SURFACE_SPECS.command,
    });
    assert.equal(Buffer.compare(baked.data, existing.data), 0,
        'bakeSurfaceChannel(command) must match building.command/base.occluder.png byte-for-byte');
});
