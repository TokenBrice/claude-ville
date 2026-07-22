import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { drawCouncilRings, drawFamilyTethers, drawAllyTethers, drawTalkArcs, admitTalkArcMarks } from './CouncilRing.js';
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
    drawPrimaryPillRestamp,
    drawOffscreenCueEdges,
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
    // #28 integration — fire the child sprite's one-shot handoff ack-bob once the
    // director's baton reaches it (progress near terminus), deduped per scene id.
    if (villageSnapshot?.handoffs?.length) {
        const acked = (renderer._handoffAcked ||= new Set());
        const live = new Set();
        for (const h of villageSnapshot.handoffs) {
            if (h?.kind !== 'handoff' || !h?.to?.id) continue;
            live.add(h.id);
            if ((h.progress ?? 0) >= 0.9 && !acked.has(h.id)) {
                acked.add(h.id);
                renderer.agentSprites.get(h.to.id)?.setHandoffAck?.(true);
            }
        }
        for (const id of acked) if (!live.has(id)) acked.delete(id);
    }
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
    // #24 — cloud-shadow parallax: feathered shadows slide across the baked
    // terrain on the wind, giving the flat iso plane depth under the live sky.
    drawCloudShadows(renderer, ctx, atmosphere, perfNow);
    // 6.4 — ground fog at dawn / over water, on the ground plane ahead of the
    // village so agents and buildings stand up out of the mist.
    drawGroundFog(renderer, ctx, atmosphere, perfNow);
    // [0.6] Draw-order: the canopy pass now also carries the hero sky rewards
    // (aurora, shooting stars, sky-flare, sun glints, push grade) so they
    // composite over terrain instead of behind the village. The rewards live
    // in SkyRenderer.drawCanopy — this call site is the whole draw-order change.
    renderer._drawSkyCanopy(ctx, atmosphere, dt, renderer.motionScale);
    renderer.camera.applyTransform(ctx);
    renderer._drawFishSchools(ctx);
    renderer._drawWaterfowl(ctx);
    renderer._drawTropicalWaterfalls(ctx);
    renderer._drawOpenSeaGulls(ctx);
    renderer._drawLandBirds(ctx);
    renderer.trailRenderer?.draw?.(ctx, renderer.camera, viewport, renderNow);
    // 3.10 — teams with a live council ring skip the director aura wash.
    drawVillageDirectorGround(ctx, villageSnapshot, renderNow, atmosphere?.grade, {
        councilTeamNames: collectCouncilTeamNames(renderer, villageSnapshot),
    });

    drawBuildingLightReflections(renderer, ctx, atmosphere);
    markFrameTiming(frameTimer, 'terrain');

    renderer.buildingRenderer?.drawShadows(ctx);
    // 3.9 — priority-ordered admission: talk arcs draw last (above sprites) but
    // are the highest-value SECONDARY marks, so they are admitted into the mark
    // governor up front and the ring/tether passes cull ahead of them.
    admitTalkArcMarks({
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
    });
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
    drawVillageDirectorOverlays(ctx, villageSnapshot, perfNow, atmosphere?.grade, {
        getBuildingDims: buildingDimsLookup(renderer),
    });

    drawSelectedAgentXray(renderer, ctx, buildingDrawables);

    renderer.particleSystem.draw(ctx, { excludeLayer: 'screen' });
    renderer._drawEmptyStateWorldCue(ctx);
    renderer.harborTraffic?.drawFinaleEffects(ctx, renderNow);

    renderer._resetScreenTransform(ctx);
    renderer._drawAtmosphere(ctx, atmosphere, dt, renderer._frameLightSources?.ambient || null);
    renderer.camera.applyTransform(ctx);
    // 0.7 — re-stamp the PRIMARY mark set (waiting beacons, selection rings,
    // incident pills) AFTER the atmosphere multiply so the action-demanding
    // reads survive the night grade at the same strength the plaques enjoy.
    drawPrimaryMarksPostAtmosphere(renderer, ctx, villageSnapshot, atmosphere);
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
    // 5.7 — offscreen-event edge indicators (incl. cues the CameraDirector
    // dropped): small screen-edge markers, click to glide there.
    drawOffscreenCueEdges(ctx, renderer, viewport, renderNow);
    // #21 — director glide grade pass: a momentary vignette + worldTint wash that
    // fades in and out with the cinematic move. Reduced motion yields no grade
    // (the camera cut leaves nothing to fade), so this is a no-op there.
    drawDirectorGlideGrade(ctx, renderer.camera?.getDirectorGlideGrade?.(), viewport);
    // 5.7 — cinematic letterbox bars while a release/incident cue glide owns
    // the frame. Never fires under reduced motion (no cue glides happen).
    drawCueLetterbox(ctx, renderer.camera, viewport);
    drawDebugOverlay(renderer, ctx, atmosphere, viewport);
    renderer._lastRenderStats = {
        ...renderer._lastRenderStats,
        timings: finishFrameTiming(renderer, frameTimer),
    };
}

function hexToRgb(hex) {
    const value = String(hex || '').replace('#', '');
    if (value.length !== 6) return null;
    const n = Number.parseInt(value, 16);
    if (!Number.isFinite(n)) return null;
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// #21 — screen-space cinematic grade for an active director glide. A radial
// vignette pulls focus to the framed subject and a faint worldTint wash colours
// the moment (red for incidents, gold for a parade, teal for an arrival). Both
// scale with the glide's bell-curve weight so they never linger after the move.
//
// 5.8 — the vignette gradient is cached per (viewport, quantized-strength)
// bucket instead of allocated every frame of the glide; strength is quantized
// to 0.05 steps so the bell-curve ramp reuses a handful of buckets.
const _glideVignetteCache = new Map();
const GLIDE_VIGNETTE_CACHE_LIMIT = 24;

function glideVignetteGradient(ctx, w, h, vignette) {
    const quantized = Math.round(vignette * 20) / 20;
    const key = `${w}x${h}:${quantized}`;
    const cached = _glideVignetteCache.get(key);
    if (cached) return cached;
    const cx = w / 2;
    const cy = h / 2;
    const inner = Math.min(w, h) * 0.32;
    const outer = Math.hypot(w, h) / 2;
    const gradient = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, `rgba(0, 0, 0, ${quantized})`);
    if (_glideVignetteCache.size >= GLIDE_VIGNETTE_CACHE_LIMIT) _glideVignetteCache.clear();
    _glideVignetteCache.set(key, gradient);
    return gradient;
}

function drawDirectorGlideGrade(ctx, grade, viewport) {
    if (!grade || !(grade.weight > 0.01) || !viewport?.width || !viewport?.height) return;
    const w = viewport.width;
    const h = viewport.height;
    const weight = Math.max(0, Math.min(1, grade.weight));
    const tint = hexToRgb(grade.worldTint);

    ctx.save();
    if (tint) {
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.5 * weight;
        ctx.fillStyle = `rgb(${tint.r}, ${tint.g}, ${tint.b})`;
        ctx.fillRect(0, 0, w, h);
    }
    const vignette = Math.max(0, Math.min(1, Number(grade.vignette) || 0)) * weight;
    if (vignette > 0.01) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = glideVignetteGradient(ctx, w, h, vignette);
        ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
}

// 5.7 — cinematic letterbox bars while a release/incident camera cue glide
// owns the frame. Bar height rides the glide's bell-curve weight so the bars
// slide in and out with the move; a 1px ember line on the inner edge (tinted
// by the cue grade) keeps them reading as cinema chrome, not a render
// artifact. Reduced motion: cue glides are suppressed and Camera cuts instead,
// so no bars ever appear.
function drawCueLetterbox(ctx, camera, viewport) {
    if (!camera?.isDirectorGliding?.() || !viewport?.width || !viewport?.height) return;
    const owner = String(camera._cameraOwner || '');
    if (owner !== 'cue:release' && owner !== 'cue:incident') return;
    const grade = camera.getDirectorGlideGrade?.();
    const weight = Math.max(0, Math.min(1, Number(grade?.weight) || 0));
    if (weight <= 0.02) return;
    const barH = Math.round(Math.min(72, viewport.height * 0.08) * weight);
    if (barH < 2) return;
    ctx.save();
    ctx.fillStyle = 'rgba(12, 9, 7, 0.94)';
    ctx.fillRect(0, 0, viewport.width, barH);
    ctx.fillRect(0, viewport.height - barH, viewport.width, barH);
    const tint = hexToRgb(grade?.worldTint) || { r: 214, g: 169, b: 81 };
    ctx.fillStyle = `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${0.5 * weight})`;
    ctx.fillRect(0, barH, viewport.width, 1);
    ctx.fillRect(0, viewport.height - barH - 1, viewport.width, 1);
    ctx.restore();
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

// 3.10 — names of teams that currently have a live council ring (2+ gathered,
// non-arriving members). The director aura wash skips these so the triple team
// mark (aura + ring + orbit light) dedupes to ring + light. Only computed when
// the snapshot actually has team clusters to filter.
function collectCouncilTeamNames(renderer, villageSnapshot) {
    if (!villageSnapshot?.teams?.length) return null;
    const relationship = renderer.relationshipState;
    const snapshot = typeof relationship?.getSnapshot === 'function' ? relationship.getSnapshot() : relationship;
    const teams = snapshot?.teamToMembers;
    if (!teams?.entries || !renderer.agentSprites) return null;
    const names = new Set();
    for (const [teamName, memberIds] of teams.entries()) {
        let live = 0;
        for (const id of memberIds) {
            const sprite = renderer.agentSprites.get(id);
            if (sprite && !sprite.isArrivalPending?.()) live++;
            if (live >= 2) {
                names.add(teamName);
                break;
            }
        }
    }
    return names;
}

// 5.8 — stable dims accessor handed to the director overlay so pills can stack
// above the building plaque zone. Cached on the renderer: no per-frame closure.
function buildingDimsLookup(renderer) {
    if (!renderer._buildingDimsLookup) {
        renderer._buildingDimsLookup = (type) => renderer.assets?.getDims?.(`building.${type}`) || null;
    }
    return renderer._buildingDimsLookup;
}

// 0.7 — PRIMARY marks survive night. Everything drawn before _drawAtmosphere
// is dimmed by the multiply grade (~50% at night) while plaques/glows drawn
// after stay bright — the legibility hierarchy inverts exactly when the scene
// is darkest. Re-stamp the PRIMARY set here, post-atmosphere, scaled by the
// same beacon night factor the lantern glows use (drawSelectedAgentXray is the
// pass-shape precedent). Daylight (factor ~0) draws nothing, so marks are
// never double-stamped at full strength. Reduced motion: identical — the
// re-stamp carries no motion of its own.
function drawPrimaryMarksPostAtmosphere(renderer, ctx, villageSnapshot, atmosphere) {
    const nightFactor = primaryRestampNightFactor(renderer, atmosphere);
    if (nightFactor <= 0.06) return;

    for (const sprite of renderer.agentSprites?.values?.() || []) {
        if (!sprite) continue;
        // Waiting-on-user beacon pillar. The outer alpha scales the gradient
        // body; the method's own save/restore keeps state clean (its tiny `!`
        // pennant sets its own alpha — acceptable, it is the top-priority read).
        if (sprite.agent?.status === AgentStatus.WAITING_ON_USER
            && typeof sprite._drawWaitingOnUserBeacon === 'function') {
            ctx.save();
            ctx.globalAlpha = 0.55 * nightFactor;
            sprite._drawWaitingOnUserBeacon(ctx, null);
            ctx.restore();
        }
        // Selection ring: a soft additive echo of the asset ring at the feet,
        // in the provider accent so it still reads identity at a glance.
        if (sprite.selected) {
            const accent = hexToRgb(sprite._providerAccentColor?.() || '#f2d36b') || { r: 242, g: 211, b: 107 };
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.beginPath();
            ctx.ellipse(sprite.x, sprite.y - 2, 24, 9, 0, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${0.10 * nightFactor})`;
            ctx.fill();
            ctx.strokeStyle = `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${0.5 * nightFactor})`;
            ctx.lineWidth = 1.4;
            ctx.stroke();
            ctx.restore();
        }
    }

    drawPrimaryPillRestamp(ctx, villageSnapshot, nightFactor, buildingDimsLookup(renderer));
}

function primaryRestampNightFactor(renderer, atmosphere) {
    const fromRenderer = renderer._lanternNightFactor?.(atmosphere);
    if (Number.isFinite(fromRenderer)) return fromRenderer;
    const lighting = atmosphere?.lighting || null;
    if (!lighting) return 0;
    const beacon = Number(lighting.beaconIntensity);
    if (Number.isFinite(beacon)) return Math.max(0, Math.min(1, beacon));
    const ambient = Number(lighting.ambientLight);
    return Number.isFinite(ambient) ? Math.max(0, Math.min(1, 1 - ambient)) : 0;
}

// ---------------------------------------------------------------------------
// 6.4 — ground fog at dawn / over water. Budget story: placement is computed
// ONCE (lazily, cached on the renderer) by bucketing the scenery water-tile
// set into a handful of anchor points plus two lowland spots on the village
// diamond; the wisp visual is the manifest's baked `atmosphere.fog.wisp.low`
// sprite with a one-off baked gradient stamp as the no-asset fallback. The
// per-frame cost is therefore capped at FOG_SPOT_LIMIT drawImage calls, and
// only while the dawn envelope (or weather fog) is active — zero cost the
// rest of the day. Drift rides a ~52s slow band; reduced motion freezes the
// drift and keeps the static wisps (fixed alpha from the dawn envelope).
const FOG_SPOT_LIMIT = 10;
const FOG_WATER_ANCHOR_LIMIT = 6;
const FOG_DRIFT_PERIOD_MS = 52000;
const FOG_DRIFT_PX = 14;
const FOG_WISP_SPRITE_ID = 'atmosphere.fog.wisp.low';
let _fogStamp = null;

function fogStampCanvas() {
    if (_fogStamp) return _fogStamp;
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 48;
    const stampCtx = canvas.getContext('2d');
    const gradient = stampCtx.createRadialGradient(48, 24, 0, 48, 24, 48);
    gradient.addColorStop(0, 'rgba(214, 228, 236, 0.55)');
    gradient.addColorStop(0.6, 'rgba(214, 228, 236, 0.22)');
    gradient.addColorStop(1, 'rgba(214, 228, 236, 0)');
    stampCtx.fillStyle = gradient;
    stampCtx.save();
    stampCtx.translate(48, 24);
    stampCtx.scale(1, 0.5);
    stampCtx.translate(-48, -48);
    stampCtx.fillRect(0, -24, 96, 96);
    stampCtx.restore();
    _fogStamp = canvas;
    return canvas;
}

function groundFogSpots(renderer) {
    if (renderer._groundFogSpots) return renderer._groundFogSpots;
    const spots = [];
    // Water anchors: bucket the water-tile set into coarse cells and keep the
    // largest bodies (lagoon, river, harbor sea lanes).
    const buckets = new Map();
    for (const key of renderer.waterTiles || []) {
        const [tileX, tileY] = String(key).split(',').map(Number);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
        const bucketKey = `${Math.floor(tileX / 9)},${Math.floor(tileY / 9)}`;
        const bucket = buckets.get(bucketKey) || { n: 0, sx: 0, sy: 0 };
        bucket.n += 1;
        bucket.sx += tileX;
        bucket.sy += tileY;
        buckets.set(bucketKey, bucket);
    }
    const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, FOG_WATER_ANCHOR_LIMIT);
    for (const bucket of ranked) {
        const tileX = bucket.sx / bucket.n;
        const tileY = bucket.sy / bucket.n;
        spots.push({
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: (tileX + tileY) * TILE_HEIGHT / 2,
            seed: (bucket.n % 7) / 7,
        });
    }
    // Lowland anchors: two spots on the lower flanks of the village diamond.
    const points = renderer._worldDiamondPoints?.();
    if (Array.isArray(points) && points.length >= 4) {
        const bottom = points[2];
        const left = points[3];
        const right = points[1];
        spots.push({ x: (bottom.x + left.x) / 2, y: (bottom.y + left.y) / 2, seed: 0.31 });
        spots.push({ x: (bottom.x + right.x) / 2, y: (bottom.y + right.y) / 2, seed: 0.67 });
    }
    renderer._groundFogSpots = spots.slice(0, FOG_SPOT_LIMIT);
    return renderer._groundFogSpots;
}

function groundFogStrength(renderer, atmosphere) {
    let strength = 0;
    if (atmosphere?.phase === 'dawn') {
        const progress = Math.max(0, Math.min(1, Number(atmosphere.phaseProgress) || 0));
        // Fade in and back out across the dawn phase rather than popping.
        strength = Math.sin(progress * Math.PI);
    }
    const weatherFog = Number(renderer._waterWeather?.fog) || 0;
    return Math.max(strength, weatherFog * 0.7);
}

function drawGroundFog(renderer, ctx, atmosphere, perfNow) {
    const strength = groundFogStrength(renderer, atmosphere);
    if (strength <= 0.04) return;
    const spots = groundFogSpots(renderer);
    if (!spots.length) return;
    const drifting = (renderer.motionScale ?? 1) > 0;
    const driftPhase = drifting ? (perfNow / FOG_DRIFT_PERIOD_MS) * Math.PI * 2 : 0;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < spots.length; i++) {
        const spot = spots[i];
        const dx = Math.sin(driftPhase + spot.seed * Math.PI * 2 + i) * FOG_DRIFT_PX;
        const alpha = Math.min(0.26, (0.15 + spot.seed * 0.08) * strength);
        const drew = renderer._drawAtmosphereEffectSprite?.(ctx, FOG_WISP_SPRITE_ID, {
            x: spot.x + dx,
            y: spot.y,
            alpha,
            scaleX: 1.7 + spot.seed * 0.9,
            scaleY: 0.55 + spot.seed * 0.25,
            rotation: -0.1 + spot.seed * 0.2,
            flipX: spot.seed > 0.5,
        });
        if (drew) continue;
        // No-asset fallback: the baked gradient stamp, same soft-wisp shape.
        const stamp = fogStampCanvas();
        ctx.globalAlpha = alpha;
        ctx.drawImage(stamp, Math.round(spot.x + dx - 80), Math.round(spot.y - 26), 160, 64);
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}

// #24 — slow band. 2–3 feathered dark ellipses drift across the baked terrain
// at a fractional parallax of the wind, so cloud shadows visibly slide over the
// village. Clipped to the iso diamond so shadows only fall on land/water, and
// folded under a `multiply` composite at ~12% alpha. Reduced motion (motionScale
// === 0) freezes the drift to static positions rather than dropping the layer.
const CLOUD_SHADOW_MAX = 3;
const CLOUD_SHADOW_DRIFT_RATE = 0.012; // world-px per ms at parallax 1, windX 1
const CLOUD_SHADOW_ALPHA = 0.12;

function drawCloudShadows(renderer, ctx, atmosphere, perfNow) {
    const layers = atmosphere?.sky?.cloudLayers;
    if (!Array.isArray(layers) || !layers.length) return;
    const cloudCover = Math.max(0, Math.min(1, Number(atmosphere?.weather?.cloudCover) || 0));
    if (cloudCover <= 0.04) return; // a clear sky casts no shadows
    const points = renderer._worldDiamondPoints?.();
    if (!points || points.length < 4) return;

    const top = points[0];
    const right = points[1];
    const bottom = points[2];
    const left = points[3];
    const boundsW = right.x - left.x;
    const boundsH = bottom.y - top.y;
    if (!(boundsW > 0) || !(boundsH > 0)) return;

    // The widest, lowest layers read best as ground shadows — take the largest.
    const ranked = [...layers].sort((a, b) => (b.scale || 0) - (a.scale || 0));
    const count = Math.min(CLOUD_SHADOW_MAX, ranked.length);
    const windX = Number(atmosphere?.motion?.windX) || 1;
    const drifting = renderer.motionScale > 0;
    // A generous span so shadows wrap fully off either edge before reappearing.
    const span = boundsW + boundsH;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';

    for (let i = 0; i < count; i++) {
        const layer = ranked[i];
        const parallax = Number(layer.parallax) || 0.5;
        const drift = drifting
            ? windX * perfNow * CLOUD_SHADOW_DRIFT_RATE * parallax
            : 0;
        // Wrap the layer's seeded fraction + drift across the bounding span.
        const baseX = left.x + (((Number(layer.xFrac) || 0) * span + drift) % span + span) % span;
        const cy = top.y + (Number(layer.yFrac) || 0.3) * boundsH;
        const rx = Math.max(48, (Number(layer.scale) || 1) * boundsW * 0.22);
        const ry = rx * 0.5;
        const alpha = CLOUD_SHADOW_ALPHA * cloudCover * (0.6 + (Number(layer.alpha) || 0.3));

        // Draw at the wrapped position and one span to the left so a shadow
        // crossing the seam is never clipped to a hard edge.
        for (const cx of [baseX - span, baseX]) {
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
            grad.addColorStop(0, `rgba(28, 32, 46, ${alpha.toFixed(3)})`);
            grad.addColorStop(0.7, `rgba(28, 32, 46, ${(alpha * 0.5).toFixed(3)})`);
            grad.addColorStop(1, 'rgba(28, 32, 46, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
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
        buildingRenderer: renderer.buildingRenderer,
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
        // Integrator follow-up (plan 1.9): light inline camera snapshot — zoom
        // plus glide owner/state. DPR/backing pixels are derived by the overlay
        // from the viewport itself; no getCanvasBudget() call per frame.
        cameraState: cameraDebugState(renderer),
    });
}

function cameraDebugState(renderer) {
    const camera = renderer?.camera;
    if (!camera) return null;
    return {
        zoom: camera.zoom,
        owner: camera._cameraOwner || null,
        gliding: Boolean(camera.isDirectorGliding?.()),
    };
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
    if (!renderer?.debugOverlay?.enabled && !renderer?._performanceSamples) return null;
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
