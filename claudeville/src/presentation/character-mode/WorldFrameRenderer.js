import { eventBus } from '../../domain/events/DomainEvent.js';
import { drawCouncilRings, drawFamilyTethers, drawAllyTethers, drawTalkArcs } from './CouncilRing.js';
import { drawCrowdClusterAuras, drawCrowdClusterBadges } from './CrowdClusterOverlay.js';
import {
    appendDepthSortedDrawables,
    cullDepthSortedDrawables,
    drawDepthSortedDrawables,
    summarizeDrawableLayers,
} from './DrawablePass.js';
import {
    drawVillageDirectorGround,
    drawVillageDirectorOverlays,
    drawVillageDirectorScreen,
} from './VillageDirectorOverlay.js';

// Follow-up after layer extraction: move private renderer calls used here into
// explicit layer/context methods so this module stays a frame orchestrator.
export function renderWorldFrame(renderer, dt = 16) {
    const ctx = renderer.ctx;
    const canvas = renderer.canvas;
    if (!ctx || !canvas) return;
    if (!canvas.width || !canvas.height) return;
    const frameTimer = beginFrameTiming(renderer);
    const renderNow = Date.now();
    const villageSnapshot = renderer.villageDirector?.getSnapshot?.() || null;
    const atmosphere = renderer.atmosphereState.update({
        now: new Date(renderNow),
        motionScale: renderer.motionScale,
        // 2.2 — village mood nudges the weather (error spikes raise
        // storminess, push streaks clear the skies). Stateless per-frame read.
        eventInfluence: combineWeatherInfluence(
            renderer.moodService?.getWeatherInfluence?.(renderNow) ?? null,
            renderer.villageDirector?.getWeatherInfluence?.(renderNow) ?? null,
        ),
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
    // #3 — grade authority: harbor anchorage glows lerp toward the time-of-day tint.
    renderer.harborTraffic?.setGradeState?.(atmosphere?.grade);
    const perfNow = performance.now();
    renderer._frameLightSources = renderer._computeFrameLightSources(atmosphere, perfNow);
    renderer._updateGateDoorState?.(perfNow);
    const viewport = renderer._screenViewport();
    markFrameTiming(frameTimer, 'setup');

    renderer._resetScreenTransform(ctx);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    renderer.skyRenderer.draw(ctx, {
        canvas: viewport,
        camera: renderer.camera,
        dt,
        atmosphere,
        motionScale: renderer.motionScale,
    });
    markFrameTiming(frameTimer, 'sky');

    renderer.camera.applyTransform(ctx);
    renderer._drawDistantSeaHorizon(ctx, atmosphere);
    renderer._drawTerrain(ctx);
    renderer._drawSkyCanopy(ctx, atmosphere, dt);
    renderer.camera.applyTransform(ctx);
    renderer._drawFishSchools(ctx);
    renderer._drawWaterfowl(ctx);
    renderer._drawTropicalWaterfalls(ctx);
    renderer._drawOpenSeaGulls(ctx);
    renderer._drawLandBirds(ctx);
    renderer.trailRenderer?.draw?.(ctx, renderer.camera, viewport, renderNow);
    drawVillageDirectorGround(ctx, villageSnapshot, renderNow, atmosphere?.grade);

    drawBuildingLightReflections(renderer, ctx, atmosphere);
    markFrameTiming(frameTimer, 'terrain');

    renderer.buildingRenderer?.drawShadows(ctx);
    drawCouncilRings(ctx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawFamilyTethers(ctx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawAllyTethers(ctx, {
        pairs: renderer._allyTetherPairs,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawCrowdClusterAuras(ctx, {
        crowdStats: renderer._crowdStats,
        zoom: renderer.camera.zoom,
        lighting: atmosphere?.lighting,
    });
    markFrameTiming(frameTimer, 'prelayers');

    const buildingDrawables = renderer.buildingRenderer?.enumerateDrawables() ?? [];
    const sortedSprites = renderer._snapshotSortedSprites();
    const agentLighting = atmosphere?.lighting || null;
    for (const sprite of sortedSprites) {
        sprite.setLightingState?.(agentLighting);
    }
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
    const familiarDrawables = renderer._enumerateFamiliarMoteDrawables?.(atmosphere) ?? [];
    const zoom = renderer.camera.zoom;
    const agentRenderMode = renderer._agentRenderMode?.(viewport, sortedSprites) || 'full';
    renderer._assignAgentOverlaySlots(sortedSprites, zoom, { agentRenderMode });
    markFrameTiming(frameTimer, 'collect');

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
        familiarDrawables,
    });
    const cullingStats = cullDepthSortedDrawables(drawables, renderer.camera, viewport, 220);
    const drawableStats = summarizeDrawableLayers(drawables, cullingStats);
    markFrameTiming(frameTimer, 'sort/cull');
    drawDepthSortedDrawables(ctx, drawables, {
        zoom,
        renderNow,
        buildingRenderer: renderer.buildingRenderer,
        harborTraffic: renderer.harborTraffic,
        landmarkActivity: renderer.landmarkActivity,
        chronicleMonuments: renderer.chronicleMonuments,
        chronicler: renderer.chronicler,
        agentRenderMode,
    });
    markFrameTiming(frameTimer, 'drawables');
    drawTalkArcs(ctx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawCrowdClusterBadges(ctx, {
        crowdStats: renderer._crowdStats,
        zoom,
    });
    renderer.arrivalDeparture?.draw?.(ctx, {
        zoom,
        now: perfNow,
        lighting: atmosphere?.lighting,
    });
    drawVillageDirectorOverlays(ctx, villageSnapshot, perfNow, atmosphere?.grade);

    drawSelectedAgentXray(renderer, ctx, buildingDrawables);

    renderer.particleSystem.draw(ctx, { excludeLayer: 'screen' });
    renderer._drawEmptyStateWorldCue(ctx);
    renderer.harborTraffic?.drawFinaleEffects(ctx, renderNow);

    renderer._resetScreenTransform(ctx);
    renderer._drawAtmosphere(ctx, atmosphere, dt, renderer._frameLightSources?.ambient || null);
    renderer.camera.applyTransform(ctx);
    markFrameTiming(frameTimer, 'effects');

    renderer.buildingRenderer?.drawBubbles(ctx, renderer.world);
    renderer.buildingRenderer?.drawLabels(ctx, {
        zoom,
        occupiedBoxes: renderer._collectAgentLabelHitRects(sortedSprites),
        harborPendingRepos,
    });
    renderer._lastRenderStats = buildRenderStats(renderer, {
        drawableStats,
        cullingStats,
        harborPendingRepos,
        inputCounts: {
            buildings: buildingDrawables.length,
            props: propDrawables.length,
            agents: sortedSprites.length,
            harbor: harborDrawables.length,
            landmarks: landmarkDrawables.length,
            monuments: chronicleMonumentDrawables.length,
            chronicler: chroniclerDrawables.length,
            familiars: familiarDrawables.length,
        },
        agentRenderMode,
    });
    markFrameTiming(frameTimer, 'labels');

    renderer._resetScreenTransform(ctx);
    renderer.particleSystem.draw(ctx, { layer: 'screen' });
    renderer.seasonalAmbience?.drawStatic?.(ctx);
    renderer.harborTraffic?.drawScreenSummary(ctx, viewport, renderer.camera, renderNow);
    drawVillageDirectorScreen(ctx, villageSnapshot, viewport);
    drawDebugOverlay(renderer, ctx, atmosphere, viewport);
    renderer._lastRenderStats = {
        ...renderer._lastRenderStats,
        timings: finishFrameTiming(renderer, frameTimer),
    };
}

function combineWeatherInfluence(a, b) {
    if (!a && !b) return null;
    return {
        storminess: Math.max(
            Number(a?.storminess) || 0,
            Number(b?.storminess) || 0,
        ),
        clearing: Math.max(
            Number(a?.clearing) || 0,
            Number(b?.clearing) || 0,
        ),
    };
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
    const overlay = renderer.debugOverlay;
    if (!overlay?.enabled && !overlay?.pathDebugEnabled) return;
    const visitIntentDebug = overlay.enabled ? (renderer.visitIntentManager?.debugSnapshot?.() || null) : null;
    const visitReservationDebug = overlay.enabled ? (renderer.visitTileAllocator?.debug?.() || null) : null;
    renderer.camera.applyTransform(ctx);
    overlay.draw(ctx, {
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
    overlay.drawPathDebug(ctx, { agentSprites: renderer.agentSprites });
    renderer._resetScreenTransform(ctx);
    if (!overlay.enabled) return;
    renderer._drawAtmosphereDebug(ctx, atmosphere);
    renderer.debugOverlay.drawScreen(ctx, {
        visitIntents: visitIntentDebug,
        visitReservations: visitReservationDebug,
        agentSprites: renderer.agentSprites,
        viewport,
        panelY: 180,
        behaviorStats: renderer._agentBehaviorStats(),
        renderStats: renderer._lastRenderStats,
    });
}

function buildRenderStats(renderer, { drawableStats, cullingStats, harborPendingRepos, inputCounts, agentRenderMode = 'full' }) {
    const pendingRepos = Array.isArray(harborPendingRepos) ? harborPendingRepos : [];
    return {
        drawables: drawableStats,
        culling: cullingStats,
        inputs: inputCounts,
        harbor: {
            pendingRepos: pendingRepos.length,
            pendingCommits: pendingRepos.reduce((sum, repo) => sum + (Number(repo.pendingCommits ?? repo.count) || 0), 0),
            failedPushes: pendingRepos.reduce((sum, repo) => sum + (Number(repo.failedPushes) || 0), 0),
        },
        canvas: {
            particles: renderer.particleSystem?.particles?.length || 0,
            lightGradients: renderer.lightGradientCache?.size || 0,
            lightSources: renderer._frameLightSources?.ambient?.length || 0,
        },
        director: renderer.villageDirector?.getStats?.() || null,
        quality: {
            agentRenderMode,
        },
        terrainCache: renderer.getTerrainCacheDiagnostics?.() || null,
        timings: renderer._lastRenderStats?.timings || null,
    };
}

function beginFrameTiming(renderer) {
    if (!renderer?.debugOverlay?.enabled) return null;
    const now = performance.now();
    return { start: now, last: now, segments: [] };
}

function markFrameTiming(timer, label) {
    if (!timer) return;
    const now = performance.now();
    timer.segments.push({ label, ms: now - timer.last });
    timer.last = now;
}

function finishFrameTiming(renderer, timer) {
    if (!timer) return renderer?._lastRenderStats?.timings || null;
    const totalMs = performance.now() - timer.start;
    const samples = renderer._frameTimingSamples || (renderer._frameTimingSamples = new Map());
    const segments = timer.segments.map((segment) => {
        const values = samples.get(segment.label) || [];
        values.push(segment.ms);
        if (values.length > 90) values.shift();
        samples.set(segment.label, values);
        return {
            ...segment,
            p50: percentile(values, 0.5),
            p95: percentile(values, 0.95),
        };
    }).sort((a, b) => b.p95 - a.p95);
    const totalValues = samples.get('total') || [];
    totalValues.push(totalMs);
    if (totalValues.length > 90) totalValues.shift();
    samples.set('total', totalValues);
    return {
        totalMs,
        totalP50: percentile(totalValues, 0.5),
        totalP95: percentile(totalValues, 0.95),
        segments,
    };
}

function percentile(values, p) {
    if (!values?.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1));
    return ordered[index];
}
