// Per-frame data feed for the hybrid WebGL2 post-process stage.
// WorldFrameRenderer calls build(); PostFx.render consumes the returned object.
// WHY: keep projection/culling/envelope math out of the GL path and the 2D
// frame orchestrator so both slices share one allocation-light contract.

import { TILE_WIDTH, TILE_HEIGHT } from '../../../config/constants.js';
import { RENDERER_RESOURCE_BYTES_PER_PIXEL, canvasPixelCount, releaseCanvasBackingStore } from '../CanvasBudget.js';
import { LIGHT_ROLE_CODES, setGpuLightColor } from '../gpu/GpuWorldPolicy.js';
import { groundCourseHeight, ownerSlotFor } from '../LightSourceRegistry.js';
import { footprintFieldFor } from '../FootprintField.js';
import { GPU_LANDMARK_IDS } from '../gpu/GpuSceneBuilder.js';
import { radianceApertureSpans } from '../gpu/GroundRadiance.js';

// 2.4 — the resident light texture holds 256 records (GpuWorldPolicy
// MAX_LIGHT_RECORDS); the hybrid PostFx walks its own first 48.
const MAX_LIGHTS = 256;
const MAX_HAZE = 8;
const LIGHT_CULL_MARGIN_CSS = 120;
// WHY: water mask is 1/4 backing res — cheap to sample, coarse enough for
// flow distortion and reflection gating without a full-res alpha upload.
const WATER_MASK_SCALE = 0.25;

const HAZE_HINT = /forge|fire|torch|brazier|flame|hearth|camp|ember|kiln|smelt/;

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function timingNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

// Registry colors arrive as #rrggbb (or loose "r, g, b"); glow stamps consume 0-255 channels.
function parseLightColor(color, cache) {
    const key = String(color || '#ffffff');
    const hit = cache.get(key);
    if (hit) return hit;
    let rgb = [255, 255, 255];
    if (key.startsWith('#') && key.length === 7) {
        rgb = [
            parseInt(key.slice(1, 3), 16) || 0,
            parseInt(key.slice(3, 5), 16) || 0,
            parseInt(key.slice(5, 7), 16) || 0,
        ];
    } else {
        const match = key.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (match) rgb = [+match[1], +match[2], +match[3]];
    }
    if (cache.size >= 128) cache.clear();
    cache.set(key, rgb);
    return rgb;
}

function isHazeLight(light) {
    if (!light) return false;
    if (light.kind === 'spark') return true;
    const id = String(light.id || '');
    const type = String(light.buildingType || light.building?.type || '');
    const overlay = String(light.overlay || '');
    return HAZE_HINT.test(id) || HAZE_HINT.test(type) || /fire/.test(overlay);
}

// V5 — a light slot's world geometry beside its backing-px projection: the
// foot (world px), the emitter height, ground radius and face normal, the
// role, the owner's V9 slot (2.5) and the landmark the light is mounted on
// (2.2). `heightPx` is the hybrid pools' ground-course height in backing px
// (`groundCourseHeight`: the resident loop's 24 px band and aperture spill).
// 2.9 — `waterOnly` / `columnReach` shape the light's broken column on the
// water.
function setLightGeometry(slot, src, footX, footY, radiusWorld, scale) {
    const normal = Array.isArray(src?.normal) ? src.normal : null;
    slot.footX = footX;
    slot.footY = footY;
    slot.radiusWorld = radiusWorld;
    slot.height = Math.max(0, finite(src?.height, 0));
    slot.heightPx = groundCourseHeight(src) * scale;
    slot.nx = normal ? finite(normal[0], 0) : 0;
    slot.ng = normal ? finite(normal[1], 0) : 0;
    slot.role = LIGHT_ROLE_CODES[src?.role] ?? (src?.attention ? LIGHT_ROLE_CODES.attention : LIGHT_ROLE_CODES.point);
    slot.ownerSlot = ownerSlotFor(src?.ownerId);
    slot.landmarkId = Math.max(0, Math.round(finite(src?.landmarkId, 0)));
    slot.waterOnly = src?.waterOnly === true;
    slot.columnReach = Math.max(1, finite(src?.columnReach, 1));
}

function emptyFeed(nowMs) {
    return {
        timeMs: finite(nowMs, 0),
        motionScale: 1,
        reducedMotion: false,
        viewport: { width: 0, height: 0, dpr: 1 },
        phase: 'day',
        grade: null,
        lighting: null,
        sun: null,
        lights: [],
        water: { mask: null, flowX: 0, flowY: 0, maskRevision: 0 },
        haze: [],
        // 3.2 — accumulated surface wetness (0..1) from real precipitation
        // history, so the resident shader never re-derives rain history.
        wetness: 0,
        // 2.2 — the RG8 footprint field (FootprintField.js), resident only.
        footprint: null,
    };
}

/**
 * @returns {{ build: (args: object) => object }}
 */
export function createPostFxFeed() {
    // Reused across frames — build() must stay allocation-light.
    const feed = emptyFeed(0);
    const lightsOut = [];
    const hazeOut = [];
    const colorCache = new Map();
    const sunObj = { x: 0, y: 0, intensity: 0 };
    const viewportObj = { width: 0, height: 0, dpr: 1 };
    const waterObj = { mask: null, flowX: 0, flowY: 0, maskRevision: 0 };
    // 2.10 — the island-wide light list for the ground radiance solve
    // (GroundRadiance), never viewport-culled, with the motion clock that
    // divides the fire breath back out; resident renderer only.
    const radianceObj = { sources: null, spans: null, motionTimeMs: 0, motionScale: 1 };
    const lightSlotPool = [];
    const hazeSlotPool = [];
    const lightColorScratch = [0, 0, 0];
    const lanternColor = [255, 213, 106];
    // V5 — the prop-halo fixture template (its height is set per lantern).
    const lanternHalo = { height: 24, normal: null, role: 'fixture', ownerId: null, landmarkId: 0 };

    let maskCanvas = null;
    let maskCtx = null;
    let maskCacheKey = '';
    let maskFlowX = 0;
    let maskFlowY = 0;
    let maskHadVisible = false;
    // WHY: the mask canvas is reused across rebuilds, so identity alone cannot
    // tell the GPU consumer when pixels changed — the revision counter does.
    let maskRevision = 0;
    const diagnostics = {
        builds: 0,
        buildFailures: 0,
        maskRebuilds: 0,
        maskReuses: 0,
        maskSkips: 0,
        maskRepaintTimeMs: 0,
        maskLastRepaintMs: 0,
        maskLastReason: 'uninitialized',
        maskReasonCounts: {
            initial: 0,
            'camera-pose': 0,
            viewport: 0,
            'water-set': 0,
        },
        visibleLights: 0,
        visibleHaze: 0,
    };

    function lightSlot(index) {
        let slot = lightSlotPool[index];
        if (!slot) {
            slot = {
                id: '',
                priority: 0,
                x: 0,
                y: 0,
                radius: 0,
                r: 255,
                g: 255,
                b: 255,
                intensity: 1,
                kind: 'point',
                night: false,
            };
            lightSlotPool[index] = slot;
        }
        return slot;
    }

    function hazeSlot(index) {
        let slot = hazeSlotPool[index];
        if (!slot) {
            slot = { x: 0, y: 0, radius: 0, strength: 0 };
            hazeSlotPool[index] = slot;
        }
        return slot;
    }

    function ensureMask(width, height) {
        if (typeof document === 'undefined') return null;
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        if (!maskCanvas) {
            maskCanvas = document.createElement('canvas');
            maskCtx = null;
        }
        if (maskCanvas.width !== w || maskCanvas.height !== h) {
            maskCanvas.width = w;
            maskCanvas.height = h;
            maskCtx = null;
        }
        if (!maskCtx) {
            maskCtx = maskCanvas.getContext('2d', { alpha: true });
            if (maskCtx) {
                maskCtx.imageSmoothingEnabled = false;
            }
        }
        return maskCtx ? maskCanvas : null;
    }

    function resolveViewport(renderer) {
        const canvas = renderer?.canvas;
        const dpr = Math.max(0.25, finite(canvas?._claudeVilleDpr ?? renderer?._screenDpr?.(), 1));
        let backingW = finite(canvas?.width, 0);
        let backingH = finite(canvas?.height, 0);
        if (backingW <= 0 || backingH <= 0) {
            const cssW = finite(
                canvas?._claudeVilleCssWidth ?? renderer?._screenWidth?.() ?? canvas?.clientWidth,
                0,
            );
            const cssH = finite(
                canvas?._claudeVilleCssHeight ?? renderer?._screenHeight?.() ?? canvas?.clientHeight,
                0,
            );
            backingW = Math.max(0, Math.round(cssW * dpr));
            backingH = Math.max(0, Math.round(cssH * dpr));
        }
        viewportObj.width = backingW;
        viewportObj.height = backingH;
        viewportObj.dpr = dpr;
        // 1.2 — the hybrid light pools snap to the art-pixel grid.
        viewportObj.zoom = Math.max(0.01, finite(renderer?.camera?.zoom, 1));
        // W-F9 — where that grid starts in backing pixels (the camera's
        // snapped render offset modulo one art pixel), so per-texel effects
        // step on the texels the world was drawn on.
        const art = Math.max(1, viewportObj.zoom * dpr);
        const originX = finite(renderer?.camera?.renderOffsetX, 0) * dpr;
        const originY = finite(renderer?.camera?.renderOffsetY, 0) * dpr;
        // V5 — the render offset itself (backing px): PostFx maps the pool
        // receiver mask's world rect to the screen with it.
        viewportObj.offsetX = originX;
        viewportObj.offsetY = originY;
        viewportObj.artOriginX = ((originX % art) + art) % art;
        viewportObj.artOriginY = ((originY % art) + art) % art;
        return viewportObj;
    }

    function resolveMotion(renderer) {
        const motionScale = clamp01(
            renderer?.motionScale
            ?? (renderer?.particleSystem?.motionEnabled === false ? 0 : 1),
        );
        const reducedMotion = motionScale <= 0
            || renderer?.particleSystem?.motionEnabled === false;
        return { motionScale, reducedMotion };
    }

    function projectToBacking(camera, worldX, worldY, dpr) {
        if (!camera || typeof camera.worldToScreen !== 'function') {
            return { x: worldX * dpr, y: worldY * dpr };
        }
        const p = camera.worldToScreen(worldX, worldY);
        return {
            x: finite(p?.x, 0) * dpr,
            y: finite(p?.y, 0) * dpr,
        };
    }

    function fillLights(renderer, viewport, dpr) {
        lightsOut.length = 0;
        hazeOut.length = 0;
        const camera = renderer?.camera;
        const zoom = Math.max(1e-6, finite(camera?.zoom, 1));
        const sources = renderer?._frameLightSources?.ambient
            || renderer?._frameLightSources?.building
            || null;
        if (!sources || !sources.length) return;

        const cssW = viewport.width / dpr;
        const cssH = viewport.height / dpr;
        const margin = LIGHT_CULL_MARGIN_CSS;
        let lightCount = 0;
        let hazeCount = 0;
        // 2.9 — the Lighthouse lamp's water-only column rides after the
        // shared list: the resident loop is its only reader.
        const column = renderer?.buildingRenderer?.lighthouseColumnSource?.() || null;
        const total = sources.length + (column ? 1 : 0);

        for (let i = 0; i < total; i++) {
            const src = i < sources.length ? sources[i] : column;
            if (!src) continue;
            const wx = finite(src.x ?? src.origin?.x, NaN);
            const wy = finite(src.y ?? src.origin?.y, NaN);
            if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
            // V5 — every light is placed by its foot; the emitter's own screen
            // position only anchors the heat haze.
            const footX = finite(src.ground?.x, wx);
            const footY = finite(src.ground?.y, wy);

            // Cull in CSS/screen space (same space as worldToScreen), then
            // scale: a light stays while its emitter or its reach from its
            // foot is near (2.9: a column runs up to 1.8 radii toward the
            // camera, a wall above a low lamp takes it up to its own height;
            // the resident binning then keeps only lights that reach a tile).
            let sx;
            let sy;
            let fx;
            let fy;
            if (camera && typeof camera.worldToScreen === 'function') {
                const p = camera.worldToScreen(wx, wy);
                sx = finite(p?.x, 0);
                sy = finite(p?.y, 0);
                const f = camera.worldToScreen(footX, footY);
                fx = finite(f?.x, 0);
                fy = finite(f?.y, 0);
            } else {
                sx = wx;
                sy = wy;
                fx = footX;
                fy = footY;
            }
            const emitterOut = sx < -margin || sy < -margin || sx > cssW + margin || sy > cssH + margin;
            const footMargin = margin + (2 * Math.max(0, finite(src.radius, 64)) * Math.max(1, finite(src.columnReach, 1))
                + Math.max(0, finite(src.height, 0))) * zoom;
            const footOut = fx < -footMargin || fy < -footMargin || fx > cssW + footMargin || fy > cssH + footMargin;
            if (emitterOut && footOut) continue;

            const kind = src.kind || 'point';
            const radiusWorld = Math.max(0, finite(src.radius, 64));
            const radiusBacking = radiusWorld * zoom * dpr;
            // 2D parity: _drawLightGlowStamps scales its gradient stamp by
            // `light.intensity || 1` (the record's `alpha` is unused there)
            // and draws day and night alike.
            const intensity = Math.max(0, finite(src.intensity, 1));
            const rgb = parseLightColor(src.color, colorCache);
            lightColorScratch[0] = rgb[0];
            lightColorScratch[1] = rgb[1];
            lightColorScratch[2] = rgb[2];
            const bx = sx * dpr;
            const by = sy * dpr;

            if (lightCount < MAX_LIGHTS) {
                const slot = lightSlot(lightCount);
                slot.id = String(src.id || `${kind}:${i}`);
                slot.priority = finite(src.priority, 0);
                slot.x = fx * dpr;
                slot.y = fy * dpr;
                slot.radius = radiusBacking;
                setGpuLightColor(slot, lightColorScratch);
                slot.intensity = intensity;
                slot.night = false;
                slot.kind = kind;
                setLightGeometry(slot, src, footX, footY, radiusWorld, zoom * dpr);
                lightsOut.push(slot);
                lightCount++;
            }

            if (hazeCount < MAX_HAZE && isHazeLight(src)) {
                const slot = hazeSlot(hazeCount);
                slot.x = bx;
                slot.y = by;
                // Heat radius is tighter than the full glow falloff.
                slot.radius = radiusBacking * 0.55;
                slot.strength = clamp01(intensity * 0.85);
                hazeOut.push(slot);
                hazeCount++;
            }

            if (lightCount >= MAX_LIGHTS && hazeCount >= MAX_HAZE) break;
        }

        // Baked lantern/brazier prop halos: the 2D path draws these in a
        // separate, night-gated pass (_drawLanternGlows) from sources that are
        // NOT in the ambient list. Feed them as flagged lights so the GL pass
        // can apply the same lantern night factor per light.
        const lanternSources = renderer?._lanternGlowSources?.() || null;
        if (lanternSources && camera && typeof camera.worldToScreen === 'function') {
            const lanternRadius = Math.max(9, Math.round(14 * zoom)) * dpr;
            for (let i = 0; i < lanternSources.length && lightCount < MAX_LIGHTS; i++) {
                const src = lanternSources[i];
                if (!src) continue;
                // V5 — a prop halo is a fixture on its tile (the flame source
                // sits 10 px above it), lit from its flame height.
                const footX = finite(src.x, NaN);
                const footY = finite(src.y, NaN) + 10;
                const p = camera.worldToScreen(footX, footY);
                const sx = finite(p?.x, NaN);
                const sy = finite(p?.y, NaN);
                if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
                if (sx < -margin || sy < -margin || sx > cssW + margin || sy > cssH + margin) continue;
                const slot = lightSlot(lightCount);
                slot.id = String(src.id || `lantern:${src.fixture || i}`);
                slot.priority = finite(src.priority, 0);
                slot.x = sx * dpr;
                slot.y = sy * dpr;
                slot.radius = lanternRadius;
                // Lantern token #ffd56a — the same hue as the Canvas lantern pools.
                setGpuLightColor(slot, lanternColor);
                slot.intensity = 1;
                slot.night = true;
                slot.kind = 'point';
                lanternHalo.height = src.fixture === 'brazier' ? 16 : 24;
                setLightGeometry(slot, lanternHalo, footX, footY, lanternRadius / (zoom * dpr), zoom * dpr);
                lightsOut.push(slot);
                lightCount++;
            }
        }
    }

    function fillSun(atmosphere, viewport) {
        const phase = atmosphere?.phase;
        // WHY: god rays only read at low sun — midday/night get null so the
        // GL pass can branch cheaply without re-deriving phase warmth.
        if (phase !== 'dawn' && phase !== 'dusk') return null;
        const lighting = atmosphere?.lighting;
        const dir = lighting?.sunDirIso;
        const dirX = finite(dir?.x, phase === 'dawn' ? 0.79 : -0.75);
        const dirY = finite(dir?.y, phase === 'dawn' ? 0.61 : -0.66);
        // Iso tile-space direction → screen vector (same basis as water flow).
        const sx = (dirX - dirY) * (TILE_WIDTH * 0.5);
        const sy = (dirX + dirY) * (TILE_HEIGHT * 0.5);
        const len = Math.hypot(sx, sy) || 1;
        const ux = sx / len;
        const uy = sy / len;
        const cx = viewport.width * 0.5;
        const cy = viewport.height * 0.5;
        // Place beyond the frame so rays enter from the horizon edge.
        const extent = Math.hypot(cx, cy) * 1.15;
        const warmth = clamp01(lighting?.sunWarmth);
        const bloom = Math.max(0.5, finite(lighting?.sunBloomScale, 1));
        const intensity = clamp01(warmth * bloom * 0.85);
        if (intensity <= 0.02) return null;
        sunObj.x = cx + ux * extent;
        sunObj.y = cy + uy * extent;
        sunObj.intensity = intensity;
        return sunObj;
    }

    function fillWater(renderer, camera, viewport, dpr) {
        waterObj.mask = null;
        waterObj.flowX = 0;
        waterObj.flowY = 0;
        waterObj.maskRevision = maskRevision;

        const waterTiles = renderer?.waterTiles
            || renderer?.scenery?.getWaterTiles?.()
            || null;
        if (!waterTiles || waterTiles.size === 0) {
            diagnostics.maskSkips++;
            diagnostics.maskLastReason = 'no-water';
            return waterObj;
        }
        if (viewport.width <= 0 || viewport.height <= 0) {
            diagnostics.maskSkips++;
            diagnostics.maskLastReason = 'empty-viewport';
            return waterObj;
        }

        const zoom = Math.max(1e-6, finite(camera?.zoom, 1));
        const camX = finite(camera?.x, 0);
        const camY = finite(camera?.y, 0);
        const maskW = Math.max(1, Math.round(viewport.width * WATER_MASK_SCALE));
        const maskH = Math.max(1, Math.round(viewport.height * WATER_MASK_SCALE));
        // Pose + viewport key: mask is view-dependent; tile set is static.
        const key = [
            camX.toFixed(2),
            camY.toFixed(2),
            zoom.toFixed(4),
            viewport.width | 0,
            viewport.height | 0,
            dpr.toFixed(3),
            waterTiles.size | 0,
        ].join('|');

        // WHY: mask + flow only change with camera pose/viewport — reuse both.
        if (
            key === maskCacheKey
            && maskCanvas
            && maskCanvas.width === Math.max(1, Math.round(viewport.width * WATER_MASK_SCALE))
            && maskCanvas.height === Math.max(1, Math.round(viewport.height * WATER_MASK_SCALE))
        ) {
            diagnostics.maskReuses++;
            diagnostics.maskLastReason = 'cache-hit';
            waterObj.mask = maskHadVisible ? maskCanvas : null;
            waterObj.flowX = maskFlowX;
            waterObj.flowY = maskFlowY;
            waterObj.maskRevision = maskRevision;
            return waterObj;
        }

        const previousParts = maskCacheKey ? maskCacheKey.split('|') : [];
        const viewportChanged = !maskCanvas
            || maskCanvas.width !== maskW
            || maskCanvas.height !== maskH
            || previousParts[3] !== String(viewport.width | 0)
            || previousParts[4] !== String(viewport.height | 0)
            || previousParts[5] !== dpr.toFixed(3);
        const waterSetChanged = previousParts.length > 0
            && previousParts[6] !== String(waterTiles.size | 0);
        const rebuildReason = !maskCacheKey
            ? 'initial'
            : viewportChanged
                ? 'viewport'
                : waterSetChanged
                    ? 'water-set'
                    : 'camera-pose';
        const rebuildStartedAt = timingNow();

        const bridgeTiles = renderer?.bridgeTiles;
        const waterMeta = renderer?.waterMeta || renderer?.scenery?.getWaterMeta?.();
        const descriptors = renderer?._waterTileDescriptors;
        const useDescriptors = Array.isArray(descriptors) && descriptors.length > 0;

        const scale = WATER_MASK_SCALE;
        const hw = (TILE_WIDTH * 0.5) * zoom * dpr * scale;
        const hh = (TILE_HEIGHT * 0.5) * zoom * dpr * scale;
        const pad = Math.max(hw, hh) + 2;

        let flowX = 0;
        let flowY = 0;
        let flowN = 0;
        let visibleN = 0;

        const accumulateFlowFromMeta = (tileKey) => {
            const meta = waterMeta?.get?.(tileKey);
            let fdx = finite(meta?.flowDirX, NaN);
            let fdy = finite(meta?.flowDirY, NaN);
            if (!Number.isFinite(fdx) || !Number.isFinite(fdy)) {
                fdx = finite(meta?.flowX, 0);
                fdy = finite(meta?.flowY, 0);
            }
            if (fdx === 0 && fdy === 0) return;
            const fsx = (fdx - fdy) * (TILE_WIDTH * 0.5);
            const fsy = (fdx + fdy) * (TILE_HEIGHT * 0.5);
            const fl = Math.hypot(fsx, fsy) || 1;
            flowX += fsx / fl;
            flowY += fsy / fl;
            flowN++;
        };

        const visitTile = (worldX, worldY, onVisible) => {
            const p = projectToBacking(camera, worldX, worldY, dpr);
            const mx = p.x * scale;
            const my = p.y * scale;
            if (mx < -pad || my < -pad || mx > maskW + pad || my > maskH + pad) return null;
            visibleN++;
            if (onVisible) onVisible(mx, my);
            return { mx, my };
        };

        // Cache miss: rebuild mask diamonds and re-average visible flow.
        let drawCtx = null;
        const canvas = ensureMask(maskW, maskH);
        if (canvas && maskCtx) {
            maskCtx.setTransform(1, 0, 0, 1, 0, 0);
            maskCtx.clearRect(0, 0, maskW, maskH);
            maskCtx.fillStyle = '#ffffff';
            drawCtx = maskCtx;
        }

        const drawDiamond = drawCtx
            ? (mx, my) => {
                drawCtx.beginPath();
                drawCtx.moveTo(mx, my - hh);
                drawCtx.lineTo(mx + hw, my);
                drawCtx.lineTo(mx, my + hh);
                drawCtx.lineTo(mx - hw, my);
                drawCtx.closePath();
                drawCtx.fill();
            }
            : null;
        if (useDescriptors) {
            for (let i = 0; i < descriptors.length; i++) {
                const tile = descriptors[i];
                const worldX = finite(tile.screenX, (tile.x - tile.y) * (TILE_WIDTH * 0.5));
                const worldY = finite(tile.screenY, (tile.x + tile.y) * (TILE_HEIGHT * 0.5));
                const hit = visitTile(worldX, worldY, drawDiamond);
                if (!hit) continue;
                const fx = finite(tile.flowUnitX, 0);
                const fy = finite(tile.flowUnitY, 0);
                if (fx !== 0 || fy !== 0) {
                    flowX += fx;
                    flowY += fy;
                    flowN++;
                }
            }
        } else {
            for (const tileKey of waterTiles) {
                if (bridgeTiles?.has?.(tileKey)) continue;
                const comma = tileKey.indexOf(',');
                if (comma < 0) continue;
                const tx = Number(tileKey.slice(0, comma));
                const ty = Number(tileKey.slice(comma + 1));
                if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                const worldX = (tx - ty) * (TILE_WIDTH * 0.5);
                const worldY = (tx + ty) * (TILE_HEIGHT * 0.5);
                const hit = visitTile(worldX, worldY, drawDiamond);
                if (!hit) continue;
                accumulateFlowFromMeta(tileKey);
            }
        }

        if (flowN > 0) {
            const inv = 1 / flowN;
            let fx = flowX * inv;
            let fy = flowY * inv;
            const fl = Math.hypot(fx, fy);
            if (fl > 1e-6) {
                fx /= fl;
                fy /= fl;
            }
            waterObj.flowX = fx;
            waterObj.flowY = fy;
        }

        maskCacheKey = key;
        maskFlowX = waterObj.flowX;
        maskFlowY = waterObj.flowY;
        maskHadVisible = visibleN > 0;
        maskRevision += 1;
        waterObj.maskRevision = maskRevision;
        const repaintMs = Math.max(0, timingNow() - rebuildStartedAt);
        diagnostics.maskRebuilds++;
        diagnostics.maskRepaintTimeMs += repaintMs;
        diagnostics.maskLastRepaintMs = repaintMs;
        diagnostics.maskLastReason = rebuildReason;
        diagnostics.maskReasonCounts[rebuildReason] = (diagnostics.maskReasonCounts[rebuildReason] || 0) + 1;

        if (!maskHadVisible) {
            // Nothing on screen — drop the mask so the water pass can no-op.
            waterObj.mask = null;
            return waterObj;
        }

        waterObj.mask = drawCtx ? maskCanvas : null;
        return waterObj;
    }

    function build(args = {}) {
        try {
            diagnostics.builds++;
            const renderer = args?.renderer ?? null;
            const atmosphere = args?.atmosphere ?? renderer?._lastAtmosphere ?? null;
            const nowMs = args?.nowMs ?? (typeof performance !== 'undefined' ? performance.now() : 0);

            if (!renderer) {
                const safe = emptyFeed(nowMs);
                // Keep stable object identity for consumers that hold the feed ref.
                feed.timeMs = safe.timeMs;
                feed.motionScale = safe.motionScale;
                feed.reducedMotion = safe.reducedMotion;
                feed.viewport = viewportObj;
                viewportObj.width = 0;
                viewportObj.height = 0;
                viewportObj.dpr = 1;
                feed.phase = safe.phase;
                feed.grade = null;
                feed.lightGrade = null;
                feed.lighting = null;
                feed.sun = null;
                lightsOut.length = 0;
                hazeOut.length = 0;
                feed.lights = lightsOut;
                feed.haze = hazeOut;
                waterObj.mask = null;
                waterObj.flowX = 0;
                waterObj.flowY = 0;
                waterObj.maskRevision = maskRevision;
                feed.water = waterObj;
                feed.wetness = 0;
                feed.footprint = null;
                feed.radiance = null;
                return feed;
            }

            const viewport = resolveViewport(renderer);
            const { motionScale, reducedMotion } = resolveMotion(renderer);
            const dpr = viewport.dpr;
            const camera = renderer.camera || null;

            fillLights(renderer, viewport, dpr);
            if (args.gpuWorldActive === true) {
                waterObj.mask = null;
                waterObj.flowX = 0;
                waterObj.flowY = 0;
                waterObj.maskRevision = maskRevision;
            } else {
                fillWater(renderer, camera, viewport, dpr);
            }
            diagnostics.visibleLights = lightsOut.length;
            diagnostics.visibleHaze = hazeOut.length;

            feed.timeMs = finite(nowMs, 0);
            feed.motionScale = motionScale;
            feed.reducedMotion = reducedMotion;
            feed.viewport = viewport;
            feed.phase = atmosphere?.phase || 'day';
            // WHY: verbatim refs — PostFx grades with the same objects the 2D
            // path authored this frame; cloning would desync mid-frame tweaks.
            feed.grade = atmosphere?.grade ?? null;
            feed.lightGrade = atmosphere?.lightGrade ?? null;
            feed.lighting = atmosphere?.lighting ?? null;
            feed.sun = fillSun(atmosphere, viewport);
            feed.lights = lightsOut;
            feed.water = waterObj;
            feed.haze = hazeOut;
            feed.wetness = clamp01(renderer?._surfaceWetness);
            // 2.2 — the resident renderer's footprint field (baked once per
            // map/scenery revision); the hybrid pass has no receivers to march.
            feed.footprint = args.gpuWorldActive === true
                ? footprintFieldFor(renderer, GPU_LANDMARK_IDS)
                : null;
            if (args.gpuWorldActive === true) {
                radianceObj.sources = renderer._frameLightSources?.ambient || null;
                radianceObj.spans = radianceApertureSpans(renderer.buildingRenderer);
                radianceObj.motionTimeMs = finite(renderer.motionTimeMs, 0);
                radianceObj.motionScale = finite(renderer.motionScale, 1);
                feed.radiance = radianceObj;
            } else {
                feed.radiance = null;
            }
            return feed;
        } catch {
            diagnostics.buildFailures++;
            // Contract: never throw. Hand back the last stable feed skeleton.
            feed.timeMs = finite(args?.nowMs, feed.timeMs);
            feed.lights = lightsOut;
            feed.haze = hazeOut;
            feed.water = waterObj;
            if (!feed.viewport) feed.viewport = viewportObj;
            return feed;
        }
    }

    function getDiagnostics() {
        const maskPixels = canvasPixelCount(maskCanvas);
        return {
            ...diagnostics,
            maskReasonCounts: { ...diagnostics.maskReasonCounts },
            maskRevision,
            maskPixels,
            maskBytes: maskPixels * RENDERER_RESOURCE_BYTES_PER_PIXEL,
            maskWidth: Number(maskCanvas?.width) || 0,
            maskHeight: Number(maskCanvas?.height) || 0,
        };
    }

    function getCanvasBudget() {
        const maskPixels = canvasPixelCount(maskCanvas);
        return {
            volatilePixels: maskPixels,
            volatileBytes: maskPixels * RENDERER_RESOURCE_BYTES_PER_PIXEL,
            cacheKey: maskCacheKey,
            revision: maskRevision,
        };
    }

    function dispose() {
        releaseCanvasBackingStore(maskCanvas);
        maskCanvas = null;
        maskCtx = null;
        maskCacheKey = '';
        maskHadVisible = false;
    }

    return { build, getDiagnostics, getCanvasBudget, dispose };
}
