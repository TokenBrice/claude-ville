import { eventBus } from '../../domain/events/DomainEvent.js';
import { drawCouncilRings, drawTalkArcs } from './CouncilRing.js';
import { appendDepthSortedDrawables, drawDepthSortedDrawables } from './DrawablePass.js';

// Follow-up after layer extraction: move private renderer calls used here into
// explicit layer/context methods so this module stays a frame orchestrator.
export function renderWorldFrame(renderer, dt = 16) {
    const ctx = renderer.ctx;
    const canvas = renderer.canvas;
    if (!ctx || !canvas) return;
    if (!canvas.width || !canvas.height) return;
    const renderNow = Date.now();
    const atmosphere = renderer.atmosphereState.update({
        now: new Date(renderNow),
        motionScale: renderer.motionScale,
    });
    renderer._lastAtmosphere = atmosphere;
    const wx = atmosphere?.weather;
    renderer._stormIntensity = (wx?.type === 'overcast' || wx?.type === 'rain' || wx?.type === 'storm') && wx.intensity > 0.4
        ? wx.intensity
        : 0;
    renderer._waterWeather = renderer._waterWeatherState(atmosphere);
    renderer._atmosphereReactions = atmosphere?.reactions || {};
    renderer.buildingRenderer?.setLightingState(atmosphere?.lighting);
    renderer.buildingRenderer?.setClockState?.(atmosphere?.clock);
    renderer.buildingRenderer?.setAtmosphereState?.(atmosphere);
    const perfNow = performance.now();
    renderer._frameLightSources = renderer._computeFrameLightSources(atmosphere, perfNow);
    renderer._updateGateDoorState?.(perfNow);
    const viewport = renderer._screenViewport();

    renderer._resetScreenTransform(ctx);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    renderer.skyRenderer.draw(ctx, {
        canvas: viewport,
        camera: renderer.camera,
        dt,
        atmosphere,
        motionScale: renderer.motionScale,
    });

    renderer.camera.applyTransform(ctx);
    renderer._drawTerrain(ctx);
    renderer._drawSkyCanopy(ctx, atmosphere, dt);
    renderer.camera.applyTransform(ctx);
    renderer._drawFishSchools(ctx);
    renderer._drawTropicalWaterfalls(ctx);
    renderer._drawOpenSeaGulls(ctx);
    renderer.trailRenderer?.draw?.(ctx, renderer.camera, viewport, renderNow);

    drawBuildingLightReflections(renderer, ctx, atmosphere);

    renderer.buildingRenderer?.drawShadows(ctx);
    drawCouncilRings(ctx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
    });

    const buildingDrawables = renderer.buildingRenderer?.enumerateDrawables() ?? [];
    const sortedSprites = renderer._snapshotSortedSprites();
    const propDrawables = renderer._enumeratePropDrawables();
    const harborDrawables = renderer.harborTraffic?.enumerateDrawables() ?? [];
    const harborPendingRepos = renderer.harborTraffic?.getPendingRepoSummaries?.() ?? [];
    const harborSignature = renderer._harborPendingReposSignature(harborPendingRepos);
    if (harborSignature !== renderer._harborPendingSignature) {
        renderer._harborPendingSignature = harborSignature;
        eventBus.emit('harbor:updated', harborPendingRepos);
    }
    const landmarkDrawables = renderer.landmarkActivity?.enumerateDrawables() ?? [];
    const chronicleMonumentDrawables = renderer.chronicleMonuments?.enumerateDrawables?.(renderNow, renderer.camera) ?? [];
    const chroniclerDrawables = renderer.chronicler?.enumerateDrawables?.() ?? [];
    const zoom = renderer.camera.zoom;
    renderer._assignAgentOverlaySlots(sortedSprites, zoom);

    const drawables = renderer._drawables;
    drawables.length = 0;
    appendDepthSortedDrawables(drawables, {
        buildingDrawables,
        propDrawables,
        agentSprites: sortedSprites,
        harborDrawables,
        landmarkDrawables,
        chronicleMonumentDrawables,
        chroniclerDrawables,
    });
    drawDepthSortedDrawables(ctx, drawables, {
        zoom,
        renderNow,
        buildingRenderer: renderer.buildingRenderer,
        harborTraffic: renderer.harborTraffic,
        landmarkActivity: renderer.landmarkActivity,
        chronicleMonuments: renderer.chronicleMonuments,
        chronicler: renderer.chronicler,
    });
    renderer._drawFamiliarMotesForFamilies(ctx, sortedSprites, atmosphere, renderNow);
    drawTalkArcs(ctx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
    });
    renderer.arrivalDeparture?.draw?.(ctx, {
        zoom,
        now: perfNow,
        lighting: atmosphere?.lighting,
    });

    drawSelectedAgentXray(renderer, ctx, buildingDrawables);

    renderer.particleSystem.draw(ctx);
    renderer._drawEmptyStateWorldCue(ctx);
    renderer.harborTraffic?.drawFinaleEffects(ctx, renderNow);

    renderer._resetScreenTransform(ctx);
    renderer._drawAtmosphere(ctx, atmosphere, dt, renderer._frameLightSources?.ambient || null);
    renderer.camera.applyTransform(ctx);

    renderer.buildingRenderer?.drawBubbles(ctx, renderer.world);
    renderer.buildingRenderer?.drawLabels(ctx, {
        zoom,
        occupiedBoxes: renderer._collectAgentLabelHitRects(sortedSprites),
        harborPendingRepos,
    });

    renderer._resetScreenTransform(ctx);
    renderer.harborTraffic?.drawScreenSummary(ctx, viewport, renderer.camera, renderNow);
    drawDebugOverlay(renderer, ctx, atmosphere, viewport);
    renderer.minimap.draw(renderer.world, renderer.camera, canvas, {
        pathTiles: renderer.pathTiles,
        waterTiles: renderer.waterTiles,
        bridgeTiles: renderer.bridgeTiles,
        agentSprites: renderer.agentSprites,
        selectedAgent: renderer.selectedAgent,
        chronicleMonuments: renderer.chronicleMonuments?.minimapMarkers?.() || [],
    });
}

function drawBuildingLightReflections(renderer, ctx, atmosphere) {
    if (!renderer.buildingRenderer || !renderer.assets) return;
    const lights = renderer._frameLightSources?.building || [];
    const glowScale = atmosphere?.lighting?.lightBoost ?? atmosphere?.grade?.buildingGlowScale ?? 1;
    const alphaBase = 0.10 * glowScale;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const light of lights) {
        if (light.kind === 'beam') {
            renderer._drawLighthouseBeam(ctx, light, atmosphere);
            continue;
        }
        const overlayId = light.overlay || 'atmosphere.light.lantern-glow';
        const overlayImg = renderer.assets.get(overlayId);
        if (!overlayImg) continue;
        const dims = renderer.assets.getDims(overlayId);
        if (!dims) continue;
        const alpha = alphaBase * (light.intensity || 1) * (light.buildingType === 'watchtower' ? 1.55 : 1);
        ctx.globalAlpha = alpha;
        ctx.drawImage(
            overlayImg,
            Math.round(light.x - dims.w / 2),
            Math.round(light.y - dims.h / 2)
        );
    }
    ctx.restore();
}

function drawSelectedAgentXray(renderer, ctx, buildingDrawables) {
    if (!renderer.buildingRenderer || !renderer.assets) return;
    for (const drawable of buildingDrawables) {
        if (drawable.kind !== 'building-front') continue;
        const dims = renderer.assets.getDims(drawable.entry.id);
        if (!dims) continue;
        const [ax, ay] = renderer.assets.getAnchor(drawable.entry.id);
        const left = drawable.wx - ax;
        const top = drawable.wy - ay;
        const right = left + dims.w;
        const bottom = top + dims.h;
        const backY = drawable.sortY - dims.h / 2;
        const frontY = drawable.sortY;
        for (const sprite of renderer.agentSprites.values()) {
            if (!sprite.selected) continue;
            const withinSpriteBounds = sprite.x >= left - 12
                && sprite.x <= right + 12
                && sprite.y >= top
                && sprite.y <= bottom + 12;
            if (withinSpriteBounds && sprite.y >= backY && sprite.y < frontY) {
                sprite.drawXraySilhouette(ctx);
            }
        }
    }
}

function drawDebugOverlay(renderer, ctx, atmosphere, viewport) {
    if (!renderer.debugOverlay?.enabled) return;
    const visitIntentDebug = renderer.visitIntentManager?.debugSnapshot?.() || null;
    const visitReservationDebug = renderer.visitTileAllocator?.debug?.() || null;
    renderer.camera.applyTransform(ctx);
    renderer.debugOverlay.draw(ctx, {
        walkabilityGrid: renderer.walkabilityGrid,
        bridgeTiles: renderer.bridgeTiles,
        agentSprites: renderer.agentSprites,
        buildings: renderer.world?.buildings,
        sceneryZones: renderer.scenery?.getBuildingSceneryZones?.() || [],
        treeProps: renderer.treePropSprites,
        boulderProps: renderer.boulderPropSprites,
        visitIntents: visitIntentDebug,
        visitReservations: visitReservationDebug,
    });
    renderer._resetScreenTransform(ctx);
    renderer._drawAtmosphereDebug(ctx, atmosphere);
    renderer.debugOverlay.drawScreen(ctx, {
        visitIntents: visitIntentDebug,
        visitReservations: visitReservationDebug,
        agentSprites: renderer.agentSprites,
        viewport,
        panelY: 180,
        behaviorStats: renderer._agentBehaviorStats(),
    });
}
