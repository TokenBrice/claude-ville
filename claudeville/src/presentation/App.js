import { World } from '../domain/entities/World.js';
import { Building } from '../domain/entities/Building.js';
import { BUILDING_DEFS } from '../config/buildings.js';
import { BUILDING_EVENTS, eventBus } from '../domain/events/DomainEvent.js';
import { i18n } from '../config/i18n.js';
import { STATUS_VISUALS, STATUS_CSS_VARS } from '../config/theme.js';

import { ClaudeDataSource } from '../infrastructure/ClaudeDataSource.js';
import { WebSocketClient } from '../infrastructure/WebSocketClient.js';
import { ChronicleStore } from '../infrastructure/ChronicleStore.js';

import {
    VillagePhase,
    LinkState,
    ProviderHealth,
    initialVillageState,
    reduceVillageState,
    bootStatusText,
    isRetryable,
} from '../application/VillageState.js';
import { AgentManager } from '../application/AgentManager.js';
import { ModeManager } from '../application/ModeManager.js';
import { SessionWatcher } from '../application/SessionWatcher.js';
import { NotificationService } from '../application/NotificationService.js';
import { AttentionService } from '../application/AttentionService.js';
import { ChronicleLog, chronicleDateKey } from '../application/ChronicleLog.js';
import { SpendLedger } from '../application/SpendLedger.js';
import { AuroraGate } from '../application/AuroraGate.js';
import { AgentBiographyService } from '../application/AgentBiographyService.js';
import { MoodService } from '../application/MoodService.js';
import { RelationshipAffinityService } from '../application/RelationshipAffinityService.js';

import { TopBar, villageDoorHref } from './shared/TopBar.js';
import { Sidebar } from './shared/Sidebar.js';
import { Toast } from './shared/Toast.js';
import { Modal } from './shared/Modal.js';
import { shortcutBlocked } from './shared/ShortcutGuard.js';
import { el } from './shared/DomSafe.js';
import { emitAgentSelected, emitAgentDeselected, resetAgentSelection } from './shared/AgentSelection.js';
import { installRepoColors, uninstallRepoColors } from './shared/RepoColor.js';
import { installVerifiedOutcomeMemory, uninstallVerifiedOutcomeMemory } from './character-mode/ActionVocabulary.js';
import { HARBOR_FOCUS_FLEET_EVENT } from './shared/HarborLedger.js';
import { sessionDetailsService } from './shared/SessionDetailsService.js';
import { ClientPerfMetrics } from './shared/ClientPerfMetrics.js';
import { getModelVisualIdentity, providerPaletteKey } from './shared/ModelVisualIdentity.js';
import { installChromeTooltip } from './shared/ChromeTooltip.js';
import { publishReservedBox, publishReservedRect } from './shared/ReservedRects.js';
import { overlayContextAttributes } from './shared/DisplaySettings.js';
import { isKeyboardEditTarget } from './dashboard-mode/DashboardKeyboardNavigation.js';

import { AssetManager } from './character-mode/AssetManager.js';
import {
    Compositor,
    agentPaletteVariant,
    parseTrimColor,
    resolveHeadAccessory,
    shiftRobeColor,
    sourceGeneration,
    sourceList,
    trimIndex,
} from './character-mode/Compositor.js';
import { avatarIdleCell } from './character-mode/AgentLayerRecords.js';
import { DIRECTIONS, WALK_FRAMES } from './character-mode/SpriteSheet.js';
import { precipitationIsFrozen } from './character-mode/GroundState.js';
import { setRestSeatVisualBeat } from './character-mode/RestSeats.js';
import { createLiveAtmosphereSnapshot } from './character-mode/AtmosphereState.js';
import { effectiveCanvasDpr } from './character-mode/CanvasBudget.js';
import { paintRevealBands } from './character-mode/RevealBands.js';
import { withPostcardFrame } from './character-mode/Postcard.js';
import {
    LOOM_GRID,
    LOOM_PANEL_HEIGHT,
    LOOM_PANEL_WIDTH,
    drawLoomToCanvas,
    renderLoomPanel,
    selectArchiveLoomPanel,
    weaveDay,
} from './shared/ChronicleLoom.js';

/**
 * Build the Tapestry cast list strictly from the selected Chronicle day's
 * recorded agents so today's live villagers never leak into a past day.
 */
export function buildTapestryCast({
    dateKey = null,
    todayKey = chronicleDateKey(),
    events = [],
    summary = null,
    agentSprites = null,
} = {}) {
    const isToday = !dateKey || dateKey === todayKey;
    const spriteList = agentSprites
        ? (typeof agentSprites.values === 'function' ? [...agentSprites.values()] : [...agentSprites])
        : [];
    const spriteById = new Map();
    const spriteByName = new Map();
    for (const sprite of spriteList) {
        const cell = sprite?._poseCell;
        if (!cell?.canvas) continue;
        const id = sprite?.agent?.id != null ? String(sprite.agent.id).trim() : '';
        const name = sprite?.agent?.name != null ? String(sprite.agent.name).trim() : '';
        if (id && !spriteById.has(id)) spriteById.set(id, cell);
        if (name && !spriteByName.has(name)) spriteByName.set(name, cell);
    }

    const recorded = [];
    const seenKeys = new Set();
    const seenNames = new Set();
    for (const ev of Array.isArray(events) ? events : []) {
        if (!ev || typeof ev !== 'object') continue;
        const id = ev.agentId != null ? String(ev.agentId).trim() : '';
        const name = ev.agentName != null ? String(ev.agentName).trim() : '';
        if (!id && !name) continue;
        const key = id ? `id:${id}` : `name:${name}`;
        if (seenKeys.has(key) || (!id && seenNames.has(name))) continue;
        seenKeys.add(key);
        if (name) seenNames.add(name);
        recorded.push({
            id,
            name,
            provider: ev.provider || '',
            model: ev.model || null,
            effort: ev.effort || null,
        });
    }
    if (Array.isArray(summary?.agents)) {
        for (const rawName of summary.agents) {
            const name = typeof rawName === 'string' ? rawName.trim() : '';
            if (!name || seenNames.has(name)) continue;
            seenNames.add(name);
            recorded.push({ id: '', name, provider: '', model: null, effort: null });
        }
    }

    if (recorded.length > 0) {
        return recorded.map((entry) => {
            const matchedCell = (entry.id && spriteById.get(entry.id))
                || ((isToday || !entry.id) && entry.name ? spriteByName.get(entry.name) : null)
                || null;
            if (matchedCell) return matchedCell;
            const visual = (entry.model || entry.provider)
                ? getModelVisualIdentity(entry.model, entry.effort, entry.provider, entry.id || null)
                : null;
            const trimColor = visual?.trim || visual?.accent || visual?.minimapColor || null;
            return trimColor ? { trimColor } : {};
        });
    }

    if (!isToday) return [];
    if (summary?.villagers === 0 || summary?.agentCount === 0) return [];
    return spriteList.map(sprite => sprite?._poseCell).filter(cell => cell?.canvas);
}

export function chronicleSkyCode(snap) {
    const wx = snap?.weather;
    if (!wx) return null;
    return {
        cloud: Math.round(Math.max(0, Math.min(1, Number(wx.cloudCover) || 0)) * 3),
        rain: wx.type === 'rain' || wx.type === 'storm' ? (wx.type === 'storm' ? 2 : 1) : 0,
        snow: precipitationIsFrozen(snap.effectiveDate?.getMonth(), wx) ? 1 : 0,
        moon: Math.round(Math.max(0, Math.min(1, Number(snap.sky?.moon?.phase?.illumination ?? snap.sky?.moon?.illumination ?? 0))) * 3),
    };
}

const LOOM_MINIATURE_CACHE_LIMIT = 256;
const LOOM_PALETTE_TOL = 12;

function parseHexRgb6(hex) {
    const clean = String(hex || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
    const v = Number.parseInt(clean, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function applyMiniaturePaletteSwap(rgba, { paletteSource = null, trimRamp = null, paletteVariant = 0, teamTrim = null } = {}) {
    const sourceRobeHex = sourceList(paletteSource?.robe);
    const sourceTrimHex = sourceList(paletteSource?.trim);
    const trimOverride = parseTrimColor(teamTrim);
    const ramp = Array.isArray(trimRamp) ? trimRamp : [];
    const targetTrimRgb = trimOverride
        || (ramp.length ? parseHexRgb6(ramp[trimIndex(paletteVariant, ramp.length)]) : null);
    const robe = sourceRobeHex.map(parseHexRgb6).filter(Boolean);
    const trimSwap = targetTrimRgb
        ? sourceTrimHex.map(parseHexRgb6).filter(Boolean).map(src => [src, targetTrimRgb])
        : [];
    if (!robe.length && !trimSwap.length) return;

    const shifted = new Map();
    const near = (r, g, b, src) => (
        Math.abs(r - src[0]) <= LOOM_PALETTE_TOL
        && Math.abs(g - src[1]) <= LOOM_PALETTE_TOL
        && Math.abs(b - src[2]) <= LOOM_PALETTE_TOL
    );
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 16) continue;
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        let done = false;
        for (let k = 0; k < robe.length; k++) {
            if (!near(r, g, b, robe[k])) continue;
            const key = (r << 16) | (g << 8) | b;
            let out = shifted.get(key);
            if (!out) {
                out = shiftRobeColor([r, g, b], paletteVariant, robe[k]);
                shifted.set(key, out);
            }
            rgba[i] = out[0];
            rgba[i + 1] = out[1];
            rgba[i + 2] = out[2];
            done = true;
            break;
        }
        if (done) continue;
        for (let k = 0; k < trimSwap.length; k++) {
            const [src, dst] = trimSwap[k];
            if (!near(r, g, b, src)) continue;
            rgba[i] = Math.max(0, Math.min(255, dst[0] + (r - src[0])));
            rgba[i + 1] = Math.max(0, Math.min(255, dst[1] + (g - src[1])));
            rgba[i + 2] = Math.max(0, Math.min(255, dst[2] + (b - src[2])));
            break;
        }
    }
}

function readIdleSouthCellRgba(source, { alreadyComposited = false, documentRef = globalThis.document } = {}) {
    const srcW = Math.floor(Number(source?.naturalWidth || source?.width) || 0);
    const srcH = Math.floor(Number(source?.naturalHeight || source?.height) || 0);
    if (!(srcW > 0 && srcH > 0)) return null;

    let cellX = 0;
    let cellY = 0;
    let cellW = srcW;
    let cellH = srcH;
    if (!alreadyComposited && srcW !== srcH) {
        const cellSize = Math.floor(srcW / DIRECTIONS.length);
        if (!(cellSize > 0)) return null;
        cellX = 0;
        cellY = srcH >= (WALK_FRAMES + 1) * cellSize ? WALK_FRAMES * cellSize : 0;
        cellW = cellSize;
        cellH = Math.min(cellSize, srcH - cellY);
    }

    if (source?.data && source.data.length >= srcW * srcH * 4) {
        const out = new Uint8ClampedArray(cellW * cellH * 4);
        for (let y = 0; y < cellH; y++) {
            const srcRow = ((cellY + y) * srcW + cellX) * 4;
            out.set(source.data.subarray(srcRow, srcRow + cellW * 4), y * cellW * 4);
        }
        return { width: cellW, height: cellH, data: out };
    }

    if (typeof source?.getContext === 'function') {
        try {
            const ctx = source.getContext('2d', { willReadFrequently: true }) || source.getContext('2d');
            if (typeof ctx?.getImageData === 'function') {
                const img = ctx.getImageData(cellX, cellY, cellW, cellH);
                if (img?.data?.length >= cellW * cellH * 4) {
                    return { width: cellW, height: cellH, data: new Uint8ClampedArray(img.data) };
                }
            }
        } catch { /* fall through to scratch canvas */ }
    }

    let scratch = null;
    if (documentRef && typeof documentRef.createElement === 'function') {
        scratch = documentRef.createElement('canvas');
        scratch.width = cellW;
        scratch.height = cellH;
    } else if (typeof globalThis.OffscreenCanvas === 'function') {
        scratch = new globalThis.OffscreenCanvas(cellW, cellH);
    }
    const sctx = scratch?.getContext?.('2d', { willReadFrequently: true }) || scratch?.getContext?.('2d');
    if (!sctx || typeof sctx.drawImage !== 'function' || typeof sctx.getImageData !== 'function') return null;
    try {
        sctx.imageSmoothingEnabled = false;
        sctx.drawImage(source, cellX, cellY, cellW, cellH, 0, 0, cellW, cellH);
        const img = sctx.getImageData(0, 0, cellW, cellH);
        if (!img?.data || img.data.length < cellW * cellH * 4) return null;
        return { width: cellW, height: cellH, data: new Uint8ClampedArray(img.data) };
    } catch {
        return null;
    }
}

/**
 * Extract a crisp `14x16` RGBA Loom miniature from an idle south-facing model
 * sheet or composited cell (zero smoothing, tight opaque crop, bottom-aligned
 * majority-mode pixel sampling that preserves exact palette colors).
 */
export function extractLoomMiniatureRgba(source, {
    width = LOOM_GRID.actorWidth,
    height = LOOM_GRID.actorHeight,
    paletteSource = null,
    trimRamp = null,
    paletteVariant = 0,
    teamTrim = null,
    alreadyComposited = false,
    documentRef = globalThis.document,
} = {}) {
    const cell = readIdleSouthCellRgba(source, { alreadyComposited, documentRef });
    if (!cell) return null;

    if (!alreadyComposited) {
        applyMiniaturePaletteSwap(cell.data, { paletteSource, trimRamp, paletteVariant, teamTrim });
    }

    const { width: cw, height: ch, data } = cell;
    let minX = cw;
    let minY = ch;
    let maxX = -1;
    let maxY = -1;
    for (let threshold of [128, 16]) {
        for (let y = 0; y < ch; y++) {
            const rowBase = y * cw * 4;
            for (let x = 0; x < cw; x++) {
                if (data[rowBase + x * 4 + 3] < threshold) continue;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (maxX >= minX) break;
    }
    if (maxX < minX || maxY < minY) return null;

    const dstW = Math.max(1, Math.trunc(Number(width) || LOOM_GRID.actorWidth));
    const dstH = Math.max(1, Math.trunc(Number(height) || LOOM_GRID.actorHeight));
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const scale = Math.min(dstW / bw, dstH / bh);
    const drawW = Math.max(1, Math.min(dstW, Math.round(bw * scale)));
    const drawH = Math.max(1, Math.min(dstH, Math.round(bh * scale)));
    const padX = Math.floor((dstW - drawW) / 2);
    const padY = dstH - drawH;
    const out = new Uint8ClampedArray(dstW * dstH * 4);
    const votes = new Map();

    for (let dy = 0; dy < drawH; dy++) {
        const sy0 = minY + Math.floor((dy * bh) / drawH);
        const sy1 = Math.max(sy0 + 1, Math.min(maxY + 1, minY + Math.floor(((dy + 1) * bh) / drawH)));
        for (let dx = 0; dx < drawW; dx++) {
            const sx0 = minX + Math.floor((dx * bw) / drawW);
            const sx1 = Math.max(sx0 + 1, Math.min(maxX + 1, minX + Math.floor(((dx + 1) * bw) / drawW)));
            votes.clear();
            let opaque = 0;
            let bestNonInkKey = -1;
            let bestNonInkCount = 0;
            let bestAnyKey = -1;
            let bestAnyCount = 0;
            const area = (sx1 - sx0) * (sy1 - sy0);

            for (let sy = sy0; sy < sy1; sy++) {
                const rowBase = sy * cw * 4;
                for (let sx = sx0; sx < sx1; sx++) {
                    const o = rowBase + sx * 4;
                    if (data[o + 3] < 128) continue;
                    opaque += 1;
                    const r = data[o];
                    const g = data[o + 1];
                    const b = data[o + 2];
                    const key = (r << 16) | (g << 8) | b;
                    const count = (votes.get(key) || 0) + 1;
                    votes.set(key, count);
                    if (count > bestAnyCount) {
                        bestAnyCount = count;
                        bestAnyKey = key;
                    }
                    const luma = r * 299 + g * 587 + b * 114;
                    if (luma >= 32000 && count > bestNonInkCount) {
                        bestNonInkCount = count;
                        bestNonInkKey = key;
                    }
                }
            }
            if (opaque === 0 || (area >= 4 && opaque * 4 < area)) continue;
            const chosen = bestNonInkKey >= 0 ? bestNonInkKey : bestAnyKey;
            const doff = ((padY + dy) * dstW + (padX + dx)) * 4;
            out[doff] = (chosen >> 16) & 255;
            out[doff + 1] = (chosen >> 8) & 255;
            out[doff + 2] = chosen & 255;
            out[doff + 3] = 255;
        }
    }

    return Object.freeze({ width: dstW, height: dstH, data: out });
}

/**
 * Create ONE cached `14x16` RGBA model miniature resolver backed by
 * `AssetManager` model sheets and `Compositor` identity palette swaps.
 * Returns `null` ONLY when no model sheet is resident/loadable so
 * `ChronicleLoom` falls back to the plain slate pawn per Spec §5.4.
 */
export function createLoomMiniatureResolver({
    getAssets = () => null,
    getCompositor = () => Compositor.shared(),
    getWorld = () => null,
    onAssetLoaded = null,
    documentRef = globalThis.document,
    maxEntries = LOOM_MINIATURE_CACHE_LIMIT,
} = {}) {
    const cache = new Map();
    const pendingLoads = new Set();

    function resolve(actor, dims = {}) {
        const assets = getAssets?.();
        if (!assets) return null;

        const worldAgent = actor?.agentId ? getWorld?.()?.agents?.get?.(actor.agentId) : null;
        const provider = actor?.provider || worldAgent?.provider || '';
        const model = actor?.model || worldAgent?.model || null;
        const effort = actor?.effort || worldAgent?.effort || null;
        const agentId = actor?.agentId || worldAgent?.id || null;

        const identity = getModelVisualIdentity(model, effort, provider, agentId);
        const providerKey = providerPaletteKey({ provider, model });
        const paletteKey = actor?.paletteKey
            || identity?.paletteKey
            || (providerKey !== 'default' ? providerKey : 'claude');
        const primarySpriteId = actor?.spriteId || identity?.spriteId || null;
        const fallbackBaseId = providerKey && providerKey !== 'default'
            ? `agent.${providerKey}.base`
            : null;

        const readSheet = (id) => {
            if (!id || typeof assets.get !== 'function') return null;
            if (assets.missing?.has?.(id)) return null;
            return assets.get(id, { request: false }) || null;
        };

        let spriteId = primarySpriteId;
        let sheet = readSheet(spriteId);
        if (!sheet && primarySpriteId?.startsWith('agent.') && typeof assets.requestCharacterAssets === 'function') {
            if (!pendingLoads.has(primarySpriteId)) {
                pendingLoads.add(primarySpriteId);
                Promise.resolve(assets.requestCharacterAssets(primarySpriteId))
                    .then((loaded) => {
                        pendingLoads.delete(primarySpriteId);
                        if (loaded) onAssetLoaded?.(primarySpriteId);
                    })
                    .catch(() => {
                        pendingLoads.delete(primarySpriteId);
                    });
            }
        }
        if (!sheet && fallbackBaseId && fallbackBaseId !== primarySpriteId) {
            sheet = readSheet(fallbackBaseId);
            if (sheet) spriteId = fallbackBaseId;
        }
        if (!sheet) return null;

        const variant = agentPaletteVariant(agentId || actor?.identityKey || '', model || '', paletteKey);
        const teamTrim = parseTrimColor(actor?.trim) ? String(actor.trim).toLowerCase() : null;
        const entry = assets.getEntry?.(spriteId) || null;
        const accessory = resolveHeadAccessory({
            effortAccessory: identity?.effortAccessory || null,
            allowEffort: identity?.allowRuntimeEffortAccessory !== false,
            agentId,
            headCovered: entry?.headCovered === true,
            headBare: entry?.headBare === true,
        });

        const width = Math.max(1, Math.trunc(Number(dims?.width) || LOOM_GRID.actorWidth));
        const height = Math.max(1, Math.trunc(Number(dims?.height) || LOOM_GRID.actorHeight));
        const compositor = getCompositor?.() || null;
        const useCompositor = Boolean(
            compositor
            && typeof compositor.assets?.get === 'function'
            && !sheet.data
            && (documentRef?.createElement || typeof globalThis.OffscreenCanvas === 'function'),
        );
        const cacheKey = [
            spriteId,
            sourceGeneration(sheet),
            paletteKey,
            variant,
            teamTrim || '_',
            accessory || '_',
            useCompositor ? 'c' : 'r',
            `${width}x${height}`,
        ].join('|');

        if (cache.has(cacheKey)) {
            const hit = cache.get(cacheKey);
            cache.delete(cacheKey);
            cache.set(cacheKey, hit);
            return hit;
        }

        let miniature = null;
        if (useCompositor) {
            try {
                const idleCell = avatarIdleCell(compositor, spriteId, paletteKey, variant, accessory, teamTrim);
                if (idleCell) {
                    miniature = extractLoomMiniatureRgba(idleCell, {
                        width,
                        height,
                        alreadyComposited: true,
                        documentRef,
                    });
                }
            } catch {
                miniature = null;
            }
        }
        if (!miniature) {
            miniature = extractLoomMiniatureRgba(sheet, {
                width,
                height,
                paletteSource: entry?.paletteSource || null,
                trimRamp: assets.palettes?.[paletteKey]?.trim || null,
                paletteVariant: variant,
                teamTrim,
                alreadyComposited: false,
                documentRef,
            });
        }
        if (!miniature) return null;

        while (cache.size >= maxEntries) {
            cache.delete(cache.keys().next().value);
        }
        cache.set(cacheKey, miniature);
        return miniature;
    }

    resolve.clearCache = () => {
        cache.clear();
        pendingLoads.clear();
    };
    resolve.cacheSize = () => cache.size;
    return resolve;
}

/**
 * Weave and rasterize today's latest active (or covered) 96x72 Loom of Days
 * panel for the Archive cutaway's rear-wall frame (§5.2 / §5.4). Returns
 * `canvas: null` when the day has neither observed coverage nor recorded events
 * so the rear wall stays bare instead of drawing a placeholder.
 */
export function buildArchiveLoomPanelCanvas({
    events = [],
    coverage = null,
    sky = null,
    dateKey = chronicleDateKey(),
    hour = null,
    closed = false,
    endTs = null,
    resolveMiniature = null,
    documentRef = globalThis.document,
} = {}) {
    const dayModel = weaveDay(Array.isArray(events) ? events : [], coverage ?? null, sky ?? null, {
        dateKey,
        ...(endTs != null ? { endTs } : {}),
    });
    const panel = selectArchiveLoomPanel(dayModel, { hour });
    if (!panel) {
        return {
            canvas: null,
            panel: null,
            dayModel,
            rgba: null,
            hour: null,
            dateKey,
            closed: Boolean(closed),
            textCalls: 0,
        };
    }

    const { result, textCalls } = withPostcardFrame(() => {
        const rgba = renderLoomPanel(panel, {
            closed: Boolean(closed),
            ...(typeof resolveMiniature === 'function' ? { resolveMiniature } : {}),
        });
        let canvas = null;
        if (documentRef && typeof documentRef.createElement === 'function') {
            canvas = documentRef.createElement('canvas');
            canvas.width = LOOM_PANEL_WIDTH;
            canvas.height = LOOM_PANEL_HEIGHT;
        } else if (typeof globalThis.OffscreenCanvas === 'function') {
            canvas = new globalThis.OffscreenCanvas(LOOM_PANEL_WIDTH, LOOM_PANEL_HEIGHT);
        }
        const ctx = typeof canvas?.getContext === 'function' ? canvas.getContext('2d') : null;
        if (ctx && typeof ctx.fillRect === 'function') {
            drawLoomToCanvas(ctx, rgba, { layout: 'single-panel' });
            canvas._loomRgba = rgba;
        } else {
            canvas = null;
        }
        return { rgba, canvas };
    }, { trace: true });

    if (textCalls !== 0) {
        throw new Error(`Archive Loom panel violated zero-text guard (${textCalls} text call(s))`);
    }

    return {
        canvas: result.canvas,
        panel,
        dayModel,
        rgba: result.rgba,
        hour: panel.hour,
        dateKey,
        closed: Boolean(closed),
        textCalls,
    };
}

const LIFECYCLE_DRAIN_TIMEOUT_MS = 2000;
const INITIAL_WEBSOCKET_TIMEOUT_MS = 2500;
const FIRST_RUN_HINT_STORAGE_KEY = 'claudeville.firstRunHint.worldControls.v1';
// FREE | AUTO | AMBIENT (9.1 / 4.4): the Auto-camera preference (shared with
// SET and the renderer) and Ambient's standing choice.
const AUTO_CAMERA_STORAGE_KEY = 'cv-auto-camera';
const AMBIENT_STANDING_STORAGE_KEY = 'cv-ambient-standing';
const FEATURE_STYLES = Object.freeze({
    activity: 'css/activity-panel.css',
    dashboard: 'css/dashboard.css',
    modal: 'css/modal.css',
});

const USABLE_VILLAGE_PHASES = new Set([
    VillagePhase.READY_LIVE,
    VillagePhase.READY_EMPTY,
    VillagePhase.READY_NO_PROVIDERS,
    VillagePhase.DEGRADED,
]);

const EMPTY_SURFACE_COPY = Object.freeze({
    [VillagePhase.STARTING]: Object.freeze({
        title: 'OPENING THE VILLAGE',
        copy: 'Preparing the local watchtowers.',
        next: 'The first snapshot has not arrived yet.',
    }),
    [VillagePhase.SYNCING]: Object.freeze({
        title: 'LISTENING FOR LOCAL SESSIONS',
        copy: 'Still syncing with this machine.',
        next: 'Wait here — agents appear when a session is read.',
    }),
    [VillagePhase.READY_NO_PROVIDERS]: Object.freeze({
        title: 'NO PROVIDERS FOUND',
        copy: 'No supported coding CLI is installed on this machine.',
        next: 'Install Claude, Codex, Antigravity, Gemini, OpenCode, or Kimi, then try again.',
    }),
    [VillagePhase.READY_EMPTY]: Object.freeze({
        title: 'PROVIDERS FOUND / NOTHING ACTIVE',
        copy: 'A watchtower is ready, but no coding session is running.',
        next: 'Start a coding CLI session to see agents here.',
        legend: Object.freeze([
            Object.freeze({ label: 'Forge', value: 'Code work' }),
            Object.freeze({ label: 'Archive', value: 'Reading and search' }),
            Object.freeze({ label: 'Harbor', value: 'Commit ships' }),
            Object.freeze({ label: 'Mine', value: 'Token usage' }),
        ]),
    }),
    [VillagePhase.NO_RECORDED_SAMPLES]: Object.freeze({
        title: 'NO RECORDED TRAIL SAMPLES',
        copy: 'The village kept no trails for this day, so there is nothing to retell.',
        next: 'Trails are kept for 24 hours, and only while ClaudeVille is open.',
    }),
    [VillagePhase.DEGRADED]: Object.freeze({
        title: 'A WATCHTOWER IS UNREADABLE',
        copy: 'The village cannot read one or more local session sources.',
        next: 'Try again to re-read local sessions.',
    }),
    [VillagePhase.FAILED]: Object.freeze({
        title: 'THE VILLAGE DID NOT OPEN',
        copy: 'The village shell is still here. A step failed while opening.',
        next: 'Try again to re-run the failed step.',
    }),
});

// XP-6 — the door each empty card offers: a newcomer with no provider can
// visit the simulated village; a recorded day with no trails goes back home.
const EMPTY_SURFACE_DOORS = Object.freeze({
    [VillagePhase.READY_NO_PROVIDERS]: Object.freeze({ text: 'VISIT A SIMULATED VILLAGE', simulated: true }),
    [VillagePhase.NO_RECORDED_SAMPLES]: Object.freeze({ text: 'RETURN TO YOUR VILLAGE', simulated: false }),
});

const BOOT_FAILURE_COPY = Object.freeze({
    'network-failed': 'Could not reach the local village server.',
    'server-error': 'The village server returned an error.',
    'request-failed': 'The village server refused a request.',
    'session-read-failed': 'Could not read local sessions.',
    'providers-failed': 'Could not read installed providers.',
    'assets-failed': 'Village art failed to load.',
    'retold-date-invalid': 'Choose a valid Chronicle date in YYYY-MM-DD format.',
    'retold-read-failed': 'The recorded village history could not be read.',
    'renderer-failed': 'The world renderer failed to open.',
    'aborted': 'Opening the village was interrupted.',
    'boot-failed': 'The village did not finish opening.',
});

// GPU-process crash recovery (`_bindGraphicsRecovery`): the last crash reload,
// per tab; a second crash inside the window rebuilds in place instead.
const GPU_CRASH_RELOAD_STORAGE_KEY = 'cv-gpu-crash-reload-at';
const GPU_CRASH_RELOAD_WINDOW_MS = 2 * 60 * 1000;

// Whether this crash may reload the page (and records it when it may).
function claimGpuCrashReload(now = Date.now()) {
    try {
        const last = Number(window.sessionStorage.getItem(GPU_CRASH_RELOAD_STORAGE_KEY));
        if (Number.isFinite(last) && last > 0 && now - last < GPU_CRASH_RELOAD_WINDOW_MS) return false;
        window.sessionStorage.setItem(GPU_CRASH_RELOAD_STORAGE_KEY, String(now));
        return true;
    } catch {
        // No session storage: never risk a reload loop.
        return false;
    }
}

export class App {
    constructor() {
        this.world = null;
        this.dataSource = null;
        this.wsClient = null;
        this.agentManager = null;
        this.modeManager = null;
        this.sessionWatcher = null;
        this.notificationService = null;
        this.attentionService = null;
        this.chronicleLog = null;
        this.chroniclePanel = null;
        this.spendLedger = null;
        this.topBar = null;
        this.sidebar = null;
        this.toast = null;
        this.modal = null;
        this.renderer = null;
        this.dashboardRenderer = null;
        this.activityPanel = null;
        this.assets = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.biographyService = null;
        this.moodService = null;
        this.affinityService = null;
        this.agentSimulator = null;
        this.simMode = false;
        this.latestUsage = null;
        this._chroniclePruneInterval = null;
        this._chroniclePruneState = { promise: null };
        this._chronicleTasks = new Set();
        this._archiveLoomRefreshTimer = null;
        this._archiveLoomSeq = 0;
        this._archiveLoomClosedDate = null;
        this._archiveLoomPanelState = null;
        this._loomMiniatureResolver = null;
        this._resizeWorldCanvas = null;
        this._resizeObserver = null;
        this._resizeHandle = null;
        this._loadRendererRetryHandle = null;
        this._loadRendererRetryScheduled = false;
        this._centerCameraHandle = null;
        this._worldRevealRoot = null;
        this._worldReturnPose = null;
        this._revealHoldPainted = false;
        this._worldFrameRecoveryBound = false;
        this._worldFrameFailureNotified = false;
        this._worldFrameFailureToast = null;
        this._onWindowResize = null;
        this._watchDevicePixelRatio = null;
        this._onDevicePixelRatioChange = null;
        this._dprQuery = null;
        this._perfDebugCanvasBudget = null;
        this._perfDebugStartProfile = null;
        this._perfDebugStopProfile = null;
        this._perfDebugFrameProfile = null;
        this._cameraSetHelper = null;
        this._onWorldContextLost = null;
        this._onWorldContextRestored = null;
        this._onVisibilityChange = null;
        this._worldCanvas = null;
        this._eventUnsubscribers = [];
        this._onPageHide = null;
        this._onFirstRunHintDismiss = null;
        this._bootPromise = null;
        this._bootController = null;
        this._destroyPromise = null;
        this._cleanupPromise = null;
        this._bootState = 'idle';
        this._destroyed = false;
        this._chronicleSignalsBound = false;
        this._agentFollowBound = false;
        this._deepLinkBound = false;
        this.villageState = initialVillageState();
        this._villageBound = false;
        this._foundationReady = false;
        this._surfacesBound = false;
        this._usageRequested = false;
        this._bootStatusWrap = null;
        this._bootStatusEl = null;
        this._bootAnnouncementEl = null;
        this._bootFailureEl = null;
        this._bootActionEl = null;
        this._onBootRetry = null;
        this._retryPromise = null;
        this._firstRunHintRevealed = false;
        this._rendererModulePromise = null;
        this._yamlParserPromise = null;
        this._dashboardLoadPromise = null;
        this._activityPanelLoadPromise = null;
        this._chroniclePanelLoadPromise = null;
        this._stylesheetPromises = new Map();
        this._onDashboardIntent = null;
        this._onDeferredModalIntent = null;
        this._onGlobalKeydown = null;
        this._deferredActivityBound = false;
        this._characterAssetsBound = false;
    }

    boot() {
        if (this._bootPromise) return this._bootPromise;
        if (this._bootState !== 'idle') return Promise.resolve(null);
        this._destroyed = false;
        this._bootState = 'booting';
        this._bootController = new AbortController();
        this._bindPageExit();
        // The module-level registries live as long as a booted app; an
        // earlier app's teardown uninstalled them.
        installRepoColors();
        installVerifiedOutcomeMemory();
        this._ownsModuleRegistries = true;
        this._bootPromise = this._bootOnce();
        return this._bootPromise;
    }

    async _bootOnce() {
        try {
            console.log('[App] ClaudeVille boot started...');

            // 0. Stamp --cv-status-* from STATUS_VISUALS so CSS and canvas can
            // never fork (plan 1.1); reset.css holds identical fallbacks.
            this._stampStatusCssVars();
            this._ensureBootStatus();
            this._renderVillageSurfaces();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (this._destroyed) return null;

            const params = new URLSearchParams(location.search);
            const retold = params.has('retold');
            this._dispatchVillage({ type: 'sync-start', retold });
            this._advanceFromStarting();

            const simMode = retold || params.get('sim') === '1';
            this.simMode = simMode;
            this._bootFoundation();
            this._bindVillageObservations();
            if (simMode && !this.agentSimulator) {
                const mod = await import('./character-mode/__simfixture__/AgentSimulator.js');
                if (this._destroyed) return null;
                const recordedDay = retold
                    ? await (await import('../application/ChronicleScenario.js')).loadChronicleScenario(params.get('retold'))
                    : null;
                if (this._destroyed) return null;
                if (retold && !recordedDay) {
                    this._dispatchVillage({ type: 'no-recorded-samples' });
                    this._bootState = 'ready';
                    return this;
                }
                this.retoldDay = recordedDay;
                this.agentSimulator = new mod.default({
                    world: this.world, agentManager: this.agentManager, eventBus,
                    recordedDay, timelapse: params.get('timelapse') === '1',
                });
                this.agentSimulator.start();
            }

            const signal = this._bootController?.signal;

            // 5. Start the independent boot work together. Character image
            // loading joins only after the initial snapshot tells us which
            // profiles are actually resident; parser/module/network discovery
            // does not need to wait for that data dependency.
            if (!this.assets) this.assets = new AssetManager();
            const assetMetadataPromise = this._prepareAssetMetadata({ signal });
            const rendererModulePromise = this._getRendererModule();
            // Fetch the most-recent terrain candidate while sprite assets load;
            // the first frame validates its key against settled season/snow.
            this._terrainArtifactBoot ||= import('./character-mode/TerrainArtifactStore.js').then(({ TerrainArtifactStore }) => {
                const store = new TerrainArtifactStore();
                return { store, prefetched: store.prefetchLatest() };
            }).catch(() => null);
            // Stage B — the default WebGPU world (adapter, device, pipelines)
            // resolves beside the asset fetch; `_loadRenderer` takes it over.
            rendererModulePromise
                .then(module => module.IsometricRenderer?.prewarmBackend?.(window.location.search))
                .catch(() => {});
            // Dashboard is fetched concurrently with the renderer module rather
            // than lazily on click: a mode switch must paint immediately, and a
            // click can land the instant boot reports ready. Concurrent here, so
            // it costs no serial round trip; it is joined before ready below.
            const dashboardReadyPromise = this._loadDashboard();
            const renderParams = new URLSearchParams(location.search);
            const materialWorldRequested = renderParams.get('renderer') !== 'canvas'
                && renderParams.get('postfx') !== '0';
            let assetsReady = null;
            const beginResidentAssets = (snapshotResult) => {
                if (assetsReady || this._destroyed || signal?.aborted) return;
                if (snapshotResult?.source === 'websocket' && !simMode && !this.sessionWatcher) {
                    this.sessionWatcher = new SessionWatcher(
                        this.agentManager, this.wsClient, this.dataSource
                    );
                    this.sessionWatcher.start();
                }
                const snapshotKnown = snapshotResult?.ok === true;
                assetsReady = assetMetadataPromise.then(() => {
                    const characterIds = snapshotKnown
                        ? this._residentCharacterIds()
                        : null;
                    const albedo = this.assets.load({ signal, characterIds });
                    // From this point onward the manager has either a known
                    // narrowed set or the legacy all-character policy.
                    this._bindCharacterAssetRequests();
                    const materials = materialWorldRequested
                        ? this.assets.loadMaterialAssets({ signal, characterIds })
                        : Promise.resolve(true);
                    return Promise.all([albedo, materials]);
                });
            };
            const sourceResult = await this._syncVillageSources({
                signal,
                onSnapshot: beginResidentAssets,
            });
            if (!assetsReady) beginResidentAssets({ ok: sourceResult?.snapshotKnown === true });
            if (this._destroyed) return null;

            // A normal WebSocket init already includes usage. REST usage is a
            // fallback only, so the same payload is not transferred and parsed
            // twice during a healthy boot.
            if (!simMode && sourceResult?.source !== 'websocket' && !this._usageRequested && this.dataSource) {
                this._usageRequested = true;
                this.dataSource.getUsage({ signal }).then(usage => {
                    if (this._destroyed) return;
                    if (usage) {
                        this.latestUsage = usage;
                        eventBus.emit('usage:updated', usage);
                    }
                });
            }

            // 6. Start session watching (skipped in sim mode)
            if (!simMode && !this.sessionWatcher) {
                this.sessionWatcher = new SessionWatcher(
                    this.agentManager, this.wsClient, this.dataSource
                );
                this.sessionWatcher.start();
            }

            // 7. Handle canvas resizing (run before the renderer so the canvas size is set)
            if (!this._resizeWorldCanvas) this._bindResize();

            // 8. Join the asset and renderer-module branches only when both are
            // ready to mount the World surface.
            const [, rendererModule] = await Promise.all([
                assetsReady,
                rendererModulePromise,
            ]);
            if (this._destroyed) return null;
            console.log('[App] sprite assets loaded');
            if (!this.renderer) await this._loadRenderer(rendererModule);
            if (this._destroyed) return null;

            // 9. Selection plumbing is critical; the panel itself is not. Its
            // module and stylesheet load together on the first selection.
            this._bindAgentFollow();
            this._bindDeepLink();
            if (this.renderer?.selectedAgent) {
                emitAgentSelected(this.renderer.selectedAgent);
            }
            this._applyDeepLink();

            // 10. Apply initial i18n
            this._applyI18n();
            this._renderVillageSurfaces();

            if (this._destroyed) return null;
            // Join the concurrent Dashboard fetch before reporting ready, so a
            // mode switch immediately after boot renders on the next frame
            // instead of waiting on a network round trip. A failure here is not
            // fatal to World mode; the click path retries.
            await dashboardReadyPromise.catch(() => {});
            if (this._destroyed) return null;
            this._bootState = 'ready';
            console.log('[App] ClaudeVille boot complete!');
            return this;
        } catch (err) {
            if (this._destroyed) {
                await this._cleanupOwned();
                return null;
            }
            this._handleBootFailure(err);
            return null;
        }
    }

    _stampStatusCssVars() {
        const rootStyle = document.documentElement?.style;
        if (!rootStyle) return;
        for (const [status, varName] of Object.entries(STATUS_CSS_VARS)) {
            const color = STATUS_VISUALS[status]?.color;
            if (color) rootStyle.setProperty(varName, color);
        }
    }

    _currentChronicleSkyCode() {
        const snap = this.renderer?._lastAtmosphere
            || this.renderer?.atmosphereState?.snapshot?.()
            || createLiveAtmosphereSnapshot();
        return chronicleSkyCode(snap);
    }

    _readDashboardAtmosphere() {
        if (this.modeManager?.getCurrentMode() !== 'dashboard') return null;
        return this.renderer?.atmosphereState?.snapshot() ?? createLiveAtmosphereSnapshot();
    }

    _bootFoundation() {
        if (this._foundationReady) return;

        // 1. Initialize domain
        if (!this.world) {
            this.world = new World();
            for (const def of BUILDING_DEFS) {
                this.world.addBuilding(new Building(def));
            }
        }

        // 2. Initialize infrastructure
        if (!this.dataSource) this.dataSource = new ClaudeDataSource();
        if (!this.clientPerfMetrics) this.clientPerfMetrics = new ClientPerfMetrics();
        if (!this.wsClient) {
            this.wsClient = new WebSocketClient({
                performanceMetrics: this.clientPerfMetrics,
            });
        }
        if (!this.chronicleStore) {
            this.chronicleStore = new ChronicleStore(this.simMode
                ? { dbName: 'claudeville-chronicle-simulation' }
                : {});
            this._bindVillageObservations();
            const initialStore = this.chronicleStore;
            this._trackChronicleTask(this._runChroniclePrune().then(() => {
                if (!initialStore._closed) window.__chronicle = initialStore;
            }).catch((err) => {
                console.warn('[App] ChronicleStore unavailable:', err.message);
            }));
            this.biographyService = new AgentBiographyService({ store: this.chronicleStore }).start();
            this.affinityService = new RelationshipAffinityService({ store: this.chronicleStore }).start();
            this.auroraGate = new AuroraGate({ store: this.chronicleStore });
            this._chroniclePruneInterval = window.setInterval(() => {
                this._runChroniclePrune().catch((err) => {
                    console.warn('[App] ChronicleStore prune failed:', err.message);
                });
                if (this.renderer?.buildingRenderer) {
                    this._trackChronicleTask(this.refreshArchiveLoomPanel().catch(() => {}));
                }
            }, 5 * 60 * 1000);
        } else {
            this._bindVillageObservations();
        }

        // 3. Initialize UI components
        if (!this.toast) this.toast = new Toast();
        if (!this.modal) this.modal = new Modal();
        if (!this.attentionService) {
            this.attentionService = new AttentionService(this.world, { toast: this.toast });
        }
        if (!this.chronicleLog) {
            this.chronicleLog = new ChronicleLog({ store: this.chronicleStore }).start();
            this.chronicleLog.startMetaSampling?.({
                skyProvider: () => this._currentChronicleSkyCode(),
            });
            if (this.chronicleLog._metaSample) {
                this._trackChronicleTask(Promise.resolve(this.chronicleLog._metaSample).then(() => {
                    if (!this._destroyed && this.renderer?.buildingRenderer) {
                        return this.refreshArchiveLoomPanel();
                    }
                    return null;
                }).catch(() => {}));
            }
        }
        if (!this.spendLedger) {
            this.spendLedger = new SpendLedger(this.world, { store: this.chronicleStore });
            this._trackChronicleTask(this.spendLedger.start().catch((err) => {
                console.warn('[App] SpendLedger unavailable:', err.message);
            }));
        }
        if (!this.chroniclePanel) {
            this.chroniclePanel = {
                open: () => this._openChroniclePanel(),
            };
        }
        if (!this.topBar) {
            let previousBeat;
            const onVisualBeatChange = beat => {
                if (beat === previousBeat) return;
                previousBeat = beat;
                setRestSeatVisualBeat(beat);
                this.renderer?.setVisualBeat?.(beat);
            };
            this._eventUnsubscribers.push(eventBus.on('audio:visual-beat', ({ beat }) => onVisualBeatChange(beat)));
            this.topBar = new TopBar(this.world, {
                modal: this.modal,
                attention: this.attentionService,
                chronicle: this.chroniclePanel,
                spendLedger: this.spendLedger,
                readDashboardAtmosphere: () => this._readDashboardAtmosphere(),
                simulation: this.simMode,
                refreshAtmosphere: snapshot => {
                    const next = this.renderer?.atmosphereState?.update({ now: snapshot?.effectiveDate });
                    this.renderer?._invalidateIdleFrame?.();
                    return next;
                },
                onVisualBeatChange,
                onAudioReady: audio => {
                    onVisualBeatChange(audio?.getVisualBeat?.() ?? null);
                    audio?.directors?.bgm?.setDayEventsProvider?.(async ({ day } = {}) => {
                        if (!this.chronicleLog) return [];
                        await Promise.resolve(this.chronicleLog.flush?.()).catch(() => {});
                        return (await this.chronicleLog.readDay?.(day)) ?? [];
                    });
                },
                frameAttention: () => {
                    if (this.modeManager?.getCurrentMode() === 'dashboard') return false;
                    if (this.renderer?.theatreMode || this.renderer?.stripProfile) {
                        return this.renderer.frameWorldAgent(this.attentionService.list()[0]?.id);
                    }
                    this.renderer?.cameraDirector?.frameAttention(this.renderer.agentSprites);
                    return true;
                },
            });
        }
        if (!this.sidebar) this.sidebar = new Sidebar(this.world);
        this._bindGlobalKeyboardNavigation();
        this._bindWorldEmptyState();
        this._initFirstRunHint();
        this._initReadControl();
        this._initCameraModeControl();
        this._initWorldDock();
        this._initWorldReveal();
        this._initWorldFrameRecovery();

        // 4. Initialize application services
        if (!this.agentManager) {
            this.agentManager = new AgentManager(this.world, this.dataSource);
            this.agentManager.setUsageGetter(() => this.latestUsage);
            this.agentManager.startDepartureSweep();
        }
        if (!this.modeManager) this.modeManager = new ModeManager();
        if (!this.notificationService) this.notificationService = new NotificationService(this.toast);
        if (!this.moodService) this.moodService = new MoodService().start();
        this._bindDeferredDashboard();
        this._bindDeferredActivityPanel();
        this._bindDeferredModalCss();
        this._bindChronicleSignals();

        this._foundationReady = true;
    }

    _dispatchVillage(action, { render = true } = {}) {
        this.villageState = reduceVillageState(this.villageState || initialVillageState(), action);
        if (render) {
            eventBus.emit('village:state', this.villageState);
            this._renderVillageSurfaces();
        }
        return this.villageState;
    }

    _advanceFromStarting() {
        // The reducer latches STARTING until a non-STARTING phase is stored,
        // so boot must advance the latch once loading begins.
        if (this.villageState?.phase !== VillagePhase.STARTING) return;
        this.villageState = { ...this.villageState, phase: VillagePhase.SYNCING };
        eventBus.emit('village:state', this.villageState);
        this._renderVillageSurfaces();
    }

    _bindVillageObservations() {
        if (this._villageBound) return;
        this._villageBound = true;

        const onWsState = (payload = {}) => {
            this._dispatchVillage({
                type: 'link',
                state: payload.state,
                attempts: payload.attempts,
                nextRetryAt: payload.nextRetryAt,
                lastErrorCode: payload.lastErrorCode,
                // EN-2 — link liveness: staleness keys on the last message.
                lastMessageAt: payload.lastMessageAt,
                stale: payload.stale,
            });
        };
        const onWatcherState = (payload = {}) => {
            if (payload?.ok === true) {
                this._dispatchVillage({
                    type: 'snapshot',
                    source: 'polling',
                    agentCount: this.world?.agents?.size || 0,
                    at: payload.at || Date.now(),
                });
                return;
            }
            if (payload?.ok === false) {
                this._dispatchVillage({
                    type: 'source-failed',
                    code: payload.code || 'session-poll-failed',
                });
                return;
            }
            if (payload?.state === 'polling') {
                this._dispatchVillage({ type: 'link', state: LinkState.POLLING });
            }
        };
        const onWsSnapshot = (data) => {
            const count = Array.isArray(data?.sessions)
                ? data.sessions.length
                : (this.world?.agents?.size || 0);
            this._dispatchVillage({
                type: 'snapshot',
                source: 'websocket',
                agentCount: count,
                at: Date.now(),
            });
        };
        const onChronicleStatus = (payload = {}) => {
            this._dispatchVillage({
                type: 'storage',
                chronicle: payload.status || 'unknown',
            });
        };

        this._eventUnsubscribers.push(eventBus.on('ws:state', onWsState));
        this._eventUnsubscribers.push(eventBus.on('watcher:state', onWatcherState));
        this._eventUnsubscribers.push(eventBus.on('ws:init', onWsSnapshot));
        this._eventUnsubscribers.push(eventBus.on('ws:update', onWsSnapshot));
        this._eventUnsubscribers.push(eventBus.on('chronicle:status', onChronicleStatus));
    }

    async _syncVillageSources({ signal = null, onSnapshot = null } = {}) {
        if (this._destroyed) return;
        if (this.simMode) {
            this.latestUsage = null;
            this._dispatchVillage({
                type: 'providers',
                providers: [{
                    id: 'sim',
                    name: 'Simulator',
                    health: ProviderHealth.HEALTHY,
                    sessions: this.world?.agents?.size || 0,
                }],
            });
            this._dispatchVillage({
                type: 'snapshot',
                source: 'simulator',
                agentCount: this.world?.agents?.size || 0,
                at: Date.now(),
            });
            const result = { ok: true, source: 'simulator', snapshotKnown: true };
            onSnapshot?.(result);
            return result;
        }

        const providersPromise = this._readProviders({ signal });
        const sessionsResult = await this._readInitialSnapshot({ signal });
        onSnapshot?.(sessionsResult);
        const providersResult = await providersPromise;
        if (this._destroyed || signal?.aborted) {
            return { source: 'aborted', snapshotKnown: false };
        }
        if (providersResult?.failed && sessionsResult?.ok) {
            this._dispatchVillage({
                type: 'source-failed',
                code: providersResult.code || 'providers-failed',
            });
        }
        return {
            source: sessionsResult?.source || 'rest',
            snapshotKnown: sessionsResult?.ok === true,
        };
    }

    async _readInitialSnapshot({ signal = null } = {}) {
        const websocket = await this._waitForInitialWebSocketSnapshot({ signal });
        if (websocket?.ok || this._destroyed || signal?.aborted) return websocket;
        const rest = await this._readInitialSessions({ signal });
        return { ...rest, source: 'rest' };
    }

    _waitForInitialWebSocketSnapshot({ signal = null } = {}) {
        if (!this.wsClient || !this.agentManager || this._destroyed || signal?.aborted) {
            return Promise.resolve({ ok: false, failed: false, source: 'websocket' });
        }
        const wsClient = this.wsClient;

        return new Promise((resolve) => {
            let settled = false;
            let timeoutHandle = null;
            const unsubscribers = [];
            const finish = (result) => {
                if (settled) return;
                settled = true;
                if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
                for (const unsubscribe of unsubscribers) unsubscribe?.();
                signal?.removeEventListener?.('abort', onAbort);
                resolve(result);
            };
            const onInit = (data) => {
                if (!Array.isArray(data?.sessions)) return;
                this.agentManager.handleWebSocketMessage(data);
                finish({
                    ok: true,
                    failed: false,
                    source: 'websocket',
                    count: data.sessions.length,
                });
            };
            const onDisconnected = () => finish({
                ok: false,
                failed: true,
                source: 'websocket',
            });
            const onAbort = () => {
                finish({
                    ok: false,
                    failed: false,
                    source: 'websocket',
                });
                if (this._destroyed) wsClient.disconnect();
            };

            unsubscribers.push(eventBus.on('ws:init', onInit));
            unsubscribers.push(eventBus.on('ws:disconnected', onDisconnected));
            signal?.addEventListener?.('abort', onAbort, { once: true });
            timeoutHandle = window.setTimeout(() => finish({
                ok: false,
                failed: true,
                source: 'websocket',
            }), INITIAL_WEBSOCKET_TIMEOUT_MS);
            wsClient.connect();
        });
    }

    async _readProviders({ signal = null } = {}) {
        if (!this.dataSource) {
            this._dispatchVillage({ type: 'source-failed', code: 'source-unavailable' });
            this._dispatchVillage({ type: 'providers', providers: [] });
            return { failed: true, code: 'source-unavailable' };
        }
        try {
            const providers = await this.dataSource.getProviders({ signal, rejectOnError: true });
            if (this._destroyed || signal?.aborted) return { failed: false };
            this._dispatchVillage({ type: 'providers', providers });
            return { failed: false };
        } catch (err) {
            if (this._destroyed || signal?.aborted || err?.name === 'AbortError') return { failed: false };
            console.error('[App] Failed to read providers:', err);
            const code = this._failureCode(err, 'providers-failed');
            this._dispatchVillage({ type: 'source-failed', code });
            this._dispatchVillage({ type: 'providers', providers: [] });
            return { failed: true, code };
        }
    }

    async _readInitialSessions({ signal = null } = {}) {
        const dataSource = this.dataSource;
        if (!dataSource) {
            this._dispatchVillage({ type: 'source-failed', code: 'source-unavailable' });
            return { ok: false, failed: true };
        }

        const originalGetSessions = dataSource.getSessions;
        const read = { seen: false, ok: false, code: null, count: 0 };
        dataSource.getSessions = async (...args) => {
            try {
                const sessions = await originalGetSessions.apply(dataSource, args);
                read.seen = true;
                read.ok = true;
                read.code = null;
                read.count = Array.isArray(sessions) ? sessions.length : 0;
                return sessions;
            } catch (err) {
                read.seen = true;
                read.ok = false;
                read.code = this._failureCode(err, 'session-read-failed');
                read.count = 0;
                throw err;
            }
        };

        try {
            if (this.agentManager && !this.sessionWatcher) {
                await this.agentManager.loadInitialData({ signal });
            } else {
                try {
                    const sessions = await dataSource.getSessions({ signal });
                    if (this.agentManager && Array.isArray(sessions)) {
                        this.agentManager.handleWebSocketMessage({ sessions });
                    }
                } catch (err) {
                    if (signal?.aborted || err?.name === 'AbortError') return;
                }
            }
        } finally {
            dataSource.getSessions = originalGetSessions;
        }

        if (this._destroyed || signal?.aborted) return { ok: false, failed: false };
        if (read.ok) {
            this._dispatchVillage({
                type: 'snapshot',
                agentCount: this.world?.agents?.size || read.count,
                at: Date.now(),
            });
            return { ok: true, failed: false };
        }
        if (read.seen) {
            // Snapshot then fail in one turn: DEGRADED is unreachable until
            // providersKnown and lastSnapshotAt are both set, and a lone
            // source-failed would leave the operator stuck on SYNCING without retry.
            this._dispatchVillage({
                type: 'snapshot',
                agentCount: this.world?.agents?.size || 0,
                at: Date.now(),
            }, { render: false });
            this._dispatchVillage({
                type: 'source-failed',
                code: read.code || 'session-read-failed',
            }, { render: false });
            this._dispatchVillage({ type: 'link', state: LinkState.SYNCING });
            return { ok: false, failed: true };
        }
        return { ok: false, failed: false };
    }

    _failureCode(err, fallback = 'boot-failed') {
        if (!err) return fallback;
        if (Object.hasOwn(BOOT_FAILURE_COPY, err.code)) return err.code;
        if (err.name === 'AbortError') return 'aborted';
        const message = String(err.message || '');
        if (/failed to fetch|networkerror|net::/i.test(message)) return 'network-failed';
        if (/HTTP 5\d\d/.test(message)) return 'server-error';
        if (/HTTP 4\d\d/.test(message)) return 'request-failed';
        if (/asset|sprite|yaml/i.test(message)) return 'assets-failed';
        if (/renderer/i.test(message)) return 'renderer-failed';
        return fallback;
    }

    _failureCopy(code) {
        return BOOT_FAILURE_COPY[code] || BOOT_FAILURE_COPY['boot-failed'];
    }

    _handleBootFailure(err) {
        console.error('[App] boot failed:', err);
        this._bootState = 'failed';
        this._dispatchVillage({ type: 'boot-failed', code: this._failureCode(err, 'boot-failed') });
    }

    async _retryVillage() {
        if (this._destroyed) return null;
        if (this._retryPromise) return this._retryPromise;
        this._retryPromise = this._retryVillageOnce();
        try {
            return await this._retryPromise;
        } finally {
            this._retryPromise = null;
        }
    }

    async _retryVillageOnce() {
        const failed = this.villageState?.phase === VillagePhase.FAILED || this._bootState === 'failed';
        this._dispatchVillage({ type: 'retry' });
        if (this._bootActionEl) this._bootActionEl.disabled = true;
        try {
            if (failed) {
                this._bootPromise = null;
                this._bootState = 'idle';
                return await this.boot();
            }
            await this._syncVillageSources({ signal: this._bootController?.signal });
            if (!this.renderer) await this._loadRenderer();
            this._renderVillageSurfaces();
            return this;
        } catch (err) {
            this._handleBootFailure(err);
            return null;
        } finally {
            if (this._bootActionEl) this._bootActionEl.disabled = false;
        }
    }

    _ensureBootStatus() {
        if (this._bootStatusEl?.isConnected) return;
        // The banner speaks only while no empty-state card does, and it is
        // centred on the world area (the content column), not the viewport.
        const host = document.querySelector('.main__body > .content');
        const wrap = el('div', {
            className: 'boot-status-wrap',
            style: {
                position: host ? 'absolute' : 'fixed',
                top: host ? '16px' : '64px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: '90',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px',
                pointerEvents: 'none',
                maxWidth: '520px',
                textAlign: 'center',
            },
        });
        wrap.id = 'bootStatusWrap';

        const status = el('div', {
            className: 'boot-status',
            text: bootStatusText(this.villageState),
        });
        status.id = 'bootStatus';
        status.setAttribute('aria-hidden', 'true');

        const announcement = el('div', {
            className: 'visually-hidden',
            text: bootStatusText(this.villageState),
        });
        announcement.id = 'bootStatusAnnouncement';
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.setAttribute('aria-atomic', 'true');

        const failure = el('div', {
            className: 'boot-failure',
        });
        failure.id = 'bootFailureCopy';

        const action = document.createElement('button');
        action.id = 'bootAction';
        action.type = 'button';
        action.className = 'boot-action';
        action.textContent = 'TRY AGAIN';
        action.setAttribute('aria-label', 'Try again');
        Object.assign(action.style, {
            pointerEvents: 'auto',
            cursor: 'pointer',
            display: 'none',
        });
        this._onBootRetry = () => { void this._retryVillage(); };
        action.addEventListener('click', this._onBootRetry);

        wrap.append(status, failure, action);
        (host || document.body).append(wrap);
        document.body.append(announcement);
        // The visible card depends on the mode, so the failure detail and the
        // retry button follow a mode switch.
        this._eventUnsubscribers.push(eventBus.on('mode:changed', () => this._renderVillageSurfaces()));
        // U-P3 — a Harbor ledger row shows its fleet in the World.
        this._eventUnsubscribers.push(eventBus.on(HARBOR_FOCUS_FLEET_EVENT, () => this.modeManager?.switchMode('character')));
        this._bootStatusWrap = wrap;
        this._bootStatusEl = status;
        this._bootAnnouncementEl = announcement;
        this._bootFailureEl = failure;
        this._bootActionEl = action;
    }

    _renderVillageSurfaces() {
        if (this._destroyed) return;
        this._ensureBootStatus();
        const state = this.villageState || initialVillageState();
        const phase = state.phase;
        let status = bootStatusText(state);
        if (state.storage?.chronicle === 'degraded') {
            status = `${status} · CHRONICLE HISTORY UNAVAILABLE`;
        }
        this._setTextIfChanged(this._bootStatusEl, status);
        this._setTextIfChanged(this._bootAnnouncementEl, status);

        const retryable = isRetryable(state);
        const failureCode = state.failureCode || (phase === VillagePhase.DEGRADED ? state.link?.lastErrorCode : null);
        if (this._bootFailureEl) {
            if (phase === VillagePhase.FAILED) {
                this._setTextIfChanged(this._bootFailureEl, this._failureCopy(failureCode));
                this._bootFailureEl.style.display = '';
            } else {
                this._bootFailureEl.style.display = 'none';
            }
        }
        if (this._bootActionEl) {
            this._bootActionEl.style.display = retryable ? '' : 'none';
            this._bootActionEl.disabled = Boolean(this._retryPromise);
        }

        const copy = EMPTY_SURFACE_COPY[phase] || EMPTY_SURFACE_COPY[VillagePhase.SYNCING];
        const occupied = (state.agentCount || 0) > 0 || (this.world?.agents?.size || 0) > 0;
        const playingDay = state.retold && phase === VillagePhase.READY_EMPTY;
        const showEmpty = !playingDay && phase !== VillagePhase.READY_LIVE && !occupied;
        // One voice: while an empty-state card is up it carries the words, the
        // failure detail and the retry button; the banner only speaks when no
        // card does (a degraded source behind a populated village, or a
        // degraded chronicle). The live region announces either way.
        const settled = phase === VillagePhase.READY_LIVE
            || phase === VillagePhase.READY_EMPTY
            || phase === VillagePhase.READY_NO_PROVIDERS;
        const card = showEmpty
            ? document.getElementById(this.modeManager?.getCurrentMode() === 'dashboard' ? 'dashboardEmpty' : 'worldEmpty')
            : null;
        const tailHost = card || this._bootStatusWrap;
        if (tailHost) {
            for (const node of [this._bootFailureEl, this._bootActionEl]) {
                if (node && node.parentElement !== tailHost) tailHost.append(node);
            }
        }
        if (this._bootStatusWrap) {
            this._bootStatusWrap.hidden = Boolean(card) || (settled && state.storage?.chronicle !== 'degraded');
        }
        this._paintEmptySurface(document.getElementById('worldEmpty'), {
            titleSel: '.world-empty__title',
            copySel: '.world-empty__copy',
            nextClass: 'world-empty__next',
            legendSel: '.world-empty__legend',
            copy,
            show: showEmpty,
            useHidden: true,
        });
        this._paintEmptySurface(document.getElementById('dashboardEmpty'), {
            titleSel: '.dashboard__empty-text',
            copySel: '.dashboard__empty-sub',
            nextClass: 'dashboard__empty-next',
            copy,
            show: showEmpty,
            visibleClass: 'dashboard__empty--visible',
        });

        this._syncFirstRunHint();
    }

    _paintEmptySurface(root, { titleSel, copySel, nextClass, legendSel, copy, show, useHidden, visibleClass }) {
        if (!root) return;
        root.dataset.phase = this.villageState?.phase || VillagePhase.SYNCING;
        const quietWorld = root.id === 'worldEmpty' && copy === EMPTY_SURFACE_COPY[VillagePhase.READY_EMPTY];
        const title = root.querySelector(titleSel);
        const body = root.querySelector(copySel);
        let next = root.querySelector(`.${nextClass}`);
        if (!next) {
            next = el('span', {
                className: nextClass,
            });
            root.appendChild(next);
        }
        this._setTextIfChanged(title, quietWorld ? 'VILLAGE READY' : copy.title);
        this._setTextIfChanged(body, quietWorld ? 'Start a coding CLI session to see agents here.' : copy.copy);
        this._setTextIfChanged(next, copy.next);
        const legend = legendSel ? root.querySelector(legendSel) : null;
        if (legend) {
            const rows = copy.legend || [];
            legend.replaceChildren(...rows.flatMap(({ label, value }) => {
                const term = document.createElement('dt');
                const description = document.createElement('dd');
                term.textContent = label;
                description.textContent = value;
                return [term, description];
            }));
            legend.hidden = rows.length === 0;
        }
        if (useHidden) root.hidden = !show;
        if (visibleClass) root.classList.toggle(visibleClass, show);
        const hints = root.querySelector('.dashboard__empty-hints');
        if (hints) hints.hidden = copy !== EMPTY_SURFACE_COPY[VillagePhase.READY_EMPTY];
        const doorSpec = EMPTY_SURFACE_DOORS[this.villageState?.phase] || null;
        let door = root.querySelector('.empty-door');
        if (!door && doorSpec) {
            door = el('a', { className: 'empty-door' });
            root.appendChild(door);
        }
        if (door) {
            if (doorSpec) {
                this._setTextIfChanged(door, doorSpec.text);
                const href = villageDoorHref(location.pathname, { simulated: doorSpec.simulated });
                if (door.getAttribute('href') !== href) door.setAttribute('href', href);
                // After TRY AGAIN, which the card adopts once it shows.
                if (root.lastElementChild !== door) root.appendChild(door);
            }
            door.hidden = !doorSpec;
        }
    }

    _setTextIfChanged(node, text) {
        if (!node) return;
        const next = text == null ? '' : String(text);
        if (node.textContent !== next) node.textContent = next;
    }

    _bindWorldEmptyState() {
        if (this._surfacesBound) return;
        this._surfacesBound = true;
        const sync = () => {
            if (this.agentSimulator?.recorded && this.villageState.source === 'simulator') {
                this._dispatchVillage({ type: 'snapshot', agentCount: this.world.agents.size });
            } else {
                this._renderVillageSurfaces();
            }
        };
        this._eventUnsubscribers.push(eventBus.on('agent:added', sync));
        this._eventUnsubscribers.push(eventBus.on('agent:removed', sync));
        sync();
        this._eventUnsubscribers.push(eventBus.on('mode:changed', mode => {
            if (mode !== 'dashboard') return;
            const hint = document.getElementById('firstRunHint');
            if (hint && !hint.hidden) this._onFirstRunHintDismiss?.();
        }));
    }

    _initReadControl() {
        const button = document.getElementById('worldRead');
        if (!button || this._readControlCleanup) return;
        let pressed = false;
        const set = on => {
            if (pressed === on) return;
            pressed = on;
            this.renderer?.setReadMode(on);
            button.setAttribute('aria-pressed', String(on));
        };
        const down = event => {
            if (event.type === 'keydown' && ![' ', 'Enter'].includes(event.key)) return;
            if (event.type === 'pointerdown' && event.button !== 0) return;
            event.preventDefault();
            set(true);
        };
        const up = () => set(false);
        const bindings = [
            [button, 'pointerdown', down], [button, 'keydown', down],
            [button, 'keyup', up], [button, 'pointerup', up],
            [button, 'pointerleave', up], [button, 'pointercancel', up],
            [button, 'blur', up], [window, 'pointerup', up], [window, 'blur', up],
        ];
        for (const [target, name, handler] of bindings) target.addEventListener(name, handler);
        this._eventUnsubscribers.push(eventBus.on('mode:changed', up));
        this._readControlCleanup = () => {
            up();
            for (const [target, name, handler] of bindings) target.removeEventListener(name, handler);
            this._readControlCleanup = null;
        };
    }

    // 9.1 / 4.4 (M14, M8) — FREE | AUTO | AMBIENT: one segmented control for
    // who moves the World camera, exactly one segment pressed. FREE and AUTO
    // are the persisted Auto-camera preference (`cv-auto-camera`, also in
    // SET); AMBIENT is the explicit broadcast claim (C6), the only way into
    // Ambient. Choosing it is a standing choice (`cv-ambient-standing`): it is
    // reclaimed once the boot opening glide has settled and on every return
    // from Dashboard, and only picking FREE or AUTO clears it. A genuine input
    // still revokes the claim at once; AMBIENT then wears the resume pip and
    // waits to be asked again (a reload or a Dashboard trip asks again for the
    // operator, because the choice stands). Nothing here runs on a timer.
    _initCameraModeControl() {
        const group = document.querySelector('.world-dock__camera');
        const ambientButton = document.getElementById('worldAmbient');
        if (!group || !ambientButton || this._cameraModeCleanup) return;
        const segments = [...group.querySelectorAll('[data-camera-mode]')];
        const ambientTip = ambientButton.dataset.tip;
        const storage = () => { try { return window.localStorage || null; } catch { return null; } };
        const readAuto = () => storage()?.getItem(AUTO_CAMERA_STORAGE_KEY) !== '0';
        const standing = () => storage()?.getItem(AMBIENT_STANDING_STORAGE_KEY) === '1';
        const setStanding = on => {
            try { storage()?.setItem(AMBIENT_STANDING_STORAGE_KEY, on ? '1' : '0'); } catch { /* persistence is optional */ }
        };
        const state = { auto: readAuto(), ambient: false, resume: false };
        let settleHandle = null;
        const render = () => {
            const mode = state.ambient ? 'ambient' : state.auto ? 'auto' : 'free';
            for (const segment of segments) {
                segment.setAttribute('aria-pressed', String(segment.dataset.cameraMode === mode));
            }
            ambientButton.dataset.state = state.ambient ? 'on' : state.resume ? 'resume' : 'off';
            if (state.resume) {
                ambientButton.setAttribute('aria-label', 'Resume Ambient camera');
                ambientButton.dataset.tip = 'Ambient handed the frame back to you · click to resume the broadcast';
            } else {
                ambientButton.removeAttribute('aria-label');
                ambientButton.dataset.tip = ambientTip;
            }
        };
        const claim = () => {
            const director = this.renderer?.cameraDirector;
            if (!director?.setAmbient) return false;
            // `camera:owner` renders the claim; a refused claim changes nothing.
            return director.setAmbient(true);
        };
        const cancelSettle = () => {
            if (settleHandle !== null) cancelAnimationFrame(settleHandle);
            settleHandle = null;
        };
        // Boot: the opening glide is the establishing shot, never cut short.
        // Once it has settled the standing choice claims the frame, unless
        // the operator already took the camera, which is a revocation.
        const claimAfterOpening = () => {
            cancelSettle();
            const camera = this.renderer?.camera;
            const epoch = camera?.inputEpoch;
            const poll = () => {
                settleHandle = null;
                if (this.renderer?.camera !== camera || !standing() || state.ambient) return;
                if (camera?.isDirectorGliding?.()) {
                    settleHandle = requestAnimationFrame(poll);
                    return;
                }
                if (camera?.inputEpoch !== epoch) {
                    state.resume = true;
                    render();
                    return;
                }
                claim();
            };
            settleHandle = requestAnimationFrame(poll);
        };
        const onClick = event => {
            const mode = event.target.closest('[data-camera-mode]')?.dataset.cameraMode;
            if (!mode) return;
            if (mode === 'ambient') {
                if (!state.ambient && claim()) setStanding(true);
                return;
            }
            // FREE or AUTO is the operator saying "not Ambient": it ends a
            // broadcast and clears the standing choice and its resume pip.
            cancelSettle();
            setStanding(false);
            state.resume = false;
            if (state.ambient) this.renderer?.cameraDirector?.setAmbient?.(false);
            const auto = mode === 'auto';
            if (auto !== state.auto) {
                try { storage()?.setItem(AUTO_CAMERA_STORAGE_KEY, auto ? '1' : '0'); } catch { /* persistence is optional */ }
                eventBus.emit('camera:auto-camera', { enabled: auto });
            }
            render();
        };
        group.addEventListener('click', onClick);
        const unsubscribers = [
            eventBus.on('camera:owner', payload => {
                if (payload?.owner === 'ambient') {
                    state.ambient = true;
                    state.resume = false;
                } else if (payload?.previous === 'ambient') {
                    state.ambient = false;
                    state.resume = payload.reason !== 'release';
                } else {
                    return;
                }
                render();
            }),
            eventBus.on('camera:auto-camera', payload => {
                state.auto = payload?.enabled !== false;
                render();
            }),
            eventBus.on('mode:changed', mode => {
                if (mode !== 'dashboard') return;
                // The World stops while Dashboard is up; a broadcast cannot run
                // behind a hidden canvas, so the claim is dropped, not parked.
                // The standing choice survives and reclaims on the way back.
                cancelSettle();
                this.renderer?.cameraDirector?.setAmbient?.(false);
                state.ambient = false;
                state.resume = false;
                render();
            }),
            eventBus.on('world:first-frame', (payload = {}) => {
                if (!standing() || state.ambient) return;
                if (payload.reason === 'return') claim();
                else if (payload.reason === 'boot') claimAfterOpening();
            }),
        ];
        this._eventUnsubscribers.push(...unsubscribers);
        this._cameraModeCleanup = () => {
            cancelSettle();
            group.removeEventListener('click', onClick);
            this._cameraModeCleanup = null;
        };
        render();
    }

    // 9.1 / 9.4 — the World dock publishes its screen rect for plates,
    // moments and director framing (V8), and the chrome's `[data-tip]`
    // controls share the one pixel tooltip.
    _initWorldDock() {
        if (this._worldDockCleanup) return;
        const dock = document.getElementById('worldDock');
        const unpublish = dock
            ? publishReservedRect('world-dock', dock, { frame: document.getElementById('characterMode') })
            : () => {};
        const uninstallTooltip = installChromeTooltip(document);
        this._worldDockCleanup = () => {
            unpublish();
            uninstallTooltip();
            this._worldDockCleanup = null;
        };
    }

    // 0.5/0.3 — the World surface never shows a black, stale-pose or pale
    // frame. The world canvases stay transparent over `#characterMode` until
    // the renderer reports a presented frame (`world:first-frame`), then fade
    // in with a compositor-only CSS transition: 360 ms on boot, 220 ms on the
    // way back from Dashboard (none under reduced motion). The container
    // underneath holds the frame's own colour: before any renderer, the
    // opening frame as index.html predicts it (local-clock sky down to the
    // opening's horizon, its sea and the island's grass core; character.css);
    // from the boot frame on, four stepped bands of that frame's materials,
    // seamed on the sea horizon; across a Dashboard trip, eight bands of the
    // last World frame (RevealBands). A
    // Dashboard trip keeps the camera pose it left with.
    _initWorldReveal() {
        const root = document.getElementById('characterMode');
        if (!root || this._worldRevealRoot) return;
        this._worldRevealRoot = root;
        this._worldRevealActive = true;
        this._eventUnsubscribers.push(eventBus.on('world:first-frame', (payload = {}) => {
            // The bounded readback can finish after a Dashboard trip. Never
            // re-open hidden World canvases with that obsolete activation.
            if (!this._worldRevealActive) return;
            this._worldReturnPose = null;
            // A Dashboard hold is this frame's own colour already; anything
            // else (the boot sky, a trip the World never drew for) repaints.
            if (!this._revealHoldPainted) this._paintRevealBands(payload);
            this._revealHoldPainted = false;
            root.dataset.worldReady = payload.reason === 'return' ? 'return' : 'boot';
        }));
        this._eventUnsubscribers.push(eventBus.on('mode:changed', mode => {
            const renderer = this.renderer;
            this._worldRevealActive = mode !== 'dashboard';
            if (mode === 'dashboard') {
                this._worldReturnPose = renderer?.camera?.capturePose?.() || null;
                // Measured before the renderer suspends its surfaces (its own
                // listener registers after this one). If it cannot draw, the
                // container keeps the bands it already shows.
                const hold = renderer?.captureFrameBands?.(8) || null;
                renderer?.camera?.setPresented?.(false);
                delete root.dataset.worldReady;
                if (hold) this._revealHoldPainted = this._paintRevealBands(hold);
                return;
            }
            if (!renderer) return;
            renderer.setVisualBeat?.(this.topBar?.audio?.getVisualBeat?.() ?? null);
            renderer.armFirstFrameSignal?.('return');
        }));
    }

    _initWorldFrameRecovery() {
        if (this._worldFrameRecoveryBound) return;
        this._worldFrameRecoveryBound = true;
        this._eventUnsubscribers.push(eventBus.on('world:frame-error', (detail = {}) => {
            if (!detail.paused || !detail.retrying || this._worldFrameFailureNotified) return;
            this._worldFrameFailureNotified = true;
            this._worldFrameFailureToast = this.toast?.show(
                `World ${detail.stage || 'render'} failed: ${detail.message || 'unknown error'}. Retrying automatically.`,
                'warning',
                { dismissMs: null },
            ) || null;
        }));
        this._eventUnsubscribers.push(eventBus.on('world:frame-recovered', () => {
            this._worldFrameFailureNotified = false;
            if (this._worldFrameFailureToast) this.toast?._remove?.(this._worldFrameFailureToast);
            this._worldFrameFailureToast = null;
        }));
    }

    _paintRevealBands({ bands = null, cell = 1 } = {}) {
        const root = this._worldRevealRoot;
        return paintRevealBands(root, bands, {
            heightPx: this._worldCanvas?._claudeVilleCssHeight || root?.clientHeight || 0,
            cell,
        });
    }

    _initFirstRunHint() {
        const hint = document.getElementById('firstRunHint');
        const dismiss = document.getElementById('firstRunHintDismiss');
        if (!hint || !dismiss) return;
        if (this._onFirstRunHintDismiss) return;

        this._onFirstRunHintDismiss = () => {
            hint.hidden = true;
            this._unpublishFirstRunHint?.();
            this._unpublishFirstRunHint = null;
            dismiss.removeEventListener('click', this._onFirstRunHintDismiss);
            this._onFirstRunHintDismiss = null;
            this._markFirstRunHintSeen();
        };
        dismiss.addEventListener('click', this._onFirstRunHintDismiss);
        // Opening the compass is what the hint asks for: once the controls are
        // open it has done its job. (While a modal, the controls or an agent
        // panel is open, character.css keeps it folded away.)
        const grammar = document.getElementById('worldGrammar');
        if (grammar) {
            const onGrammarToggle = (event) => {
                if (event.newState === 'open' && !hint.hidden) this._onFirstRunHintDismiss?.();
            };
            grammar.addEventListener('toggle', onGrammarToggle);
            this._eventUnsubscribers.push(() => grammar.removeEventListener('toggle', onGrammarToggle));
        }
    }

    _syncFirstRunHint() {
        const hint = document.getElementById('firstRunHint');
        if (!hint || this._firstRunHintRevealed) return;
        if (this.modeManager?.getCurrentMode() === 'dashboard') return;
        if (!USABLE_VILLAGE_PHASES.has(this.villageState?.phase)) return;
        if (this._hasFirstRunHintBeenSeen()) return;
        hint.hidden = false;
        this._firstRunHintRevealed = true;
        this._markFirstRunHintSeen();
        this._unpublishFirstRunHint?.();
        this._unpublishFirstRunHint = publishReservedRect('first-run-hint', hint, {
            frame: document.getElementById('characterMode'),
        });
    }

    _hasFirstRunHintBeenSeen() {
        try {
            return window.localStorage?.getItem(FIRST_RUN_HINT_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    }

    _markFirstRunHintSeen() {
        try {
            window.localStorage?.setItem(FIRST_RUN_HINT_STORAGE_KEY, '1');
        } catch {
            // Storage may be disabled; the hint remains dismissible for this page.
        }
    }

    _bindPageExit() {
        if (this._onPageHide) return;
        this._onPageHide = (event) => {
            if (!event.persisted) void this.destroy();
        };
        window.addEventListener('pagehide', this._onPageHide);
    }

    _runChroniclePrune() {
        if (!this.chronicleStore) return Promise.resolve(null);
        const state = this._chroniclePruneState;
        if (state.promise) return state.promise;
        const store = this.chronicleStore;
        const prunePromise = store.open()
            .then(() => store.prune())
            .finally(() => {
                if (state.promise === prunePromise) state.promise = null;
            });
        state.promise = prunePromise;
        return prunePromise;
    }

    _prepareAssetMetadata({ signal = null } = {}) {
        const warm = (url) => fetch(url, { signal }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            return response.text();
        });
        const warmMetadata = Promise.allSettled([
            warm('assets/sprites/manifest.yaml'),
            warm('assets/sprites/palettes.yaml'),
        ]);
        return Promise.all([
            this._loadYamlParser(),
            warmMetadata,
        ]);
    }

    _loadYamlParser() {
        if (globalThis.jsyaml?.load) return Promise.resolve(globalThis.jsyaml);
        if (!this._yamlParserPromise) {
            this._yamlParserPromise = import('../../vendor/js-yaml.min.js').then(() => {
                if (!globalThis.jsyaml?.load) {
                    throw new Error('js-yaml did not expose its parser');
                }
                return globalThis.jsyaml;
            });
        }
        return this._yamlParserPromise;
    }

    _residentCharacterIds() {
        const agents = this.world?.agents;
        if (!agents || typeof agents.values !== 'function') return null;
        const ids = new Set();
        for (const agent of agents.values()) {
            const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider, agent?.id);
            if (identity?.spriteId?.startsWith('agent.')) ids.add(identity.spriteId);
        }
        return [...ids];
    }

    _bindCharacterAssetRequests() {
        if (this._characterAssetsBound) return;
        this._characterAssetsBound = true;
        const request = (agent) => {
            const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider, agent?.id);
            const id = identity?.spriteId;
            if (!id?.startsWith('agent.')) return;
            void this._loadYamlParser().then(() => (
                this.assets?.requestCharacterAssets?.(id, {
                    signal: this._bootController?.signal,
                })
            )).then((loaded) => {
                if (loaded && !this._destroyed && this.renderer?.buildingRenderer) {
                    this._scheduleArchiveLoomRefresh();
                }
            }).catch((error) => {
                if (!this._destroyed) {
                    console.warn('[App] Character assets failed to load:', error.message);
                }
            });
        };
        this._eventUnsubscribers.push(eventBus.on('agent:added', request));
        this._eventUnsubscribers.push(eventBus.on('agent:updated', request));
    }

    _getRendererModule() {
        if (!this._rendererModulePromise) {
            this._rendererModulePromise = import('./character-mode/IsometricRenderer.js');
        }
        return this._rendererModulePromise;
    }

    _ensureStylesheet(feature) {
        const href = FEATURE_STYLES[feature];
        if (!href) return Promise.reject(new Error(`Unknown feature stylesheet: ${feature}`));
        if (this._stylesheetPromises.has(feature)) return this._stylesheetPromises.get(feature);

        const existing = document.querySelector(`link[data-cv-feature-style="${feature}"]`);
        const promise = new Promise((resolve, reject) => {
            const link = existing || document.createElement('link');
            const onLoad = () => {
                link.dataset.cvLoaded = 'true';
                resolve(link);
            };
            const onError = () => {
                link.remove();
                reject(new Error(`Failed to load ${href}`));
            };
            if (link.dataset.cvLoaded === 'true' || link.sheet) {
                resolve(link);
                return;
            }
            link.addEventListener('load', onLoad, { once: true });
            link.addEventListener('error', onError, { once: true });
            if (!existing) {
                link.rel = 'stylesheet';
                link.href = href;
                link.dataset.cvFeatureStyle = feature;
                document.head.append(link);
            }
        }).catch((error) => {
            this._stylesheetPromises.delete(feature);
            throw error;
        });
        this._stylesheetPromises.set(feature, promise);
        return promise;
    }

    _stylesheetLoaded(feature) {
        const link = document.querySelector(`link[data-cv-feature-style="${feature}"]`);
        return Boolean(link && (link.dataset.cvLoaded === 'true' || link.sheet));
    }

    _bindDeferredDashboard() {
        if (this._onDashboardIntent) return;
        const button = document.getElementById('btnModeDashboard');
        if (!button) return;
        this._onDashboardIntent = (event) => {
            if (this.dashboardRenderer || this._destroyed) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            void this._loadDashboard().then((loaded) => {
                if (loaded && !this._destroyed) this.modeManager?.switchMode('dashboard');
            }).finally(() => {
                if (!button.isConnected) return;
                button.disabled = false;
                button.removeAttribute('aria-busy');
            });
        };
        button.addEventListener('click', this._onDashboardIntent, true);
    }

    _bindGlobalKeyboardNavigation() {
        if (this._onGlobalKeydown) return;
        this._onGlobalKeydown = (event) => {
            if (event.defaultPrevented) return;
            if (event.key === 'Escape' && this.sidebar?.clearFilter()) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (isKeyboardEditTarget(event.target)) return;
            const searchShortcut = (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey)
                || (event.key.toLowerCase() === 'k'
                    && (event.ctrlKey || event.metaKey)
                    && !event.altKey);
            if (searchShortcut) {
                // UI-11: never behind the modal or a popover (focusing search
                // would un-collapse the sidebar under it), never on a repeat.
                if (shortcutBlocked(event)) return;
                event.preventDefault();
                this.sidebar?.focusSearch();
                return;
            }
            const renderer = this.renderer;
            if (event.key === 'Escape' && (renderer?.postcardStudio?.isOpen() || renderer?.focusedSquadIds || renderer?._readLocked)) {
                renderer._handleWorldKeyboardCommand(event);
                if (event.defaultPrevented) event.stopImmediatePropagation();
            }
        };
        window.addEventListener('keydown', this._onGlobalKeydown, true);
    }

    _bindDeferredActivityPanel() {
        if (this._deferredActivityBound) return;
        this._deferredActivityBound = true;
        this._deferredSelectionIntent = null;
        this._onDeferredInteractionClick = (event) => {
            this._deferredSelectionIntent = {
                origin: event.detail === 0 ? 'keyboard' : 'pointer',
                trigger: event.target,
            };
            queueMicrotask(() => { this._deferredSelectionIntent = null; });
        };
        this._onDeferredInteractionKeydown = (event) => {
            this._deferredSelectionIntent = { origin: 'keyboard', trigger: event.target };
            queueMicrotask(() => { this._deferredSelectionIntent = null; });
        };
        document.addEventListener('click', this._onDeferredInteractionClick, true);
        document.addEventListener('keydown', this._onDeferredInteractionKeydown, true);

        const queueSelection = (target, kind) => {
            if (!target) return;
            const selection = { target, kind, intent: this._deferredSelectionIntent };
            this._pendingActivitySelection = this.activityPanel ? null : selection;
            if (this.activityPanel) return;
            void this._loadActivityPanel().then((panel) => {
                if (this._pendingActivitySelection !== selection) return;
                this._pendingActivitySelection = null;
                if (!panel || this._destroyed) return;
                if (selection.intent) panel._selectionIntent = selection.intent;
                if (kind === 'agent') panel.show(target);
                else panel.showBuilding(target);
            });
        };
        this._eventUnsubscribers.push(eventBus.on('agent:selected', agent => queueSelection(agent, 'agent')));
        this._eventUnsubscribers.push(eventBus.on(BUILDING_EVENTS.SELECTED, building => queueSelection(building, 'building')));
        this._eventUnsubscribers.push(eventBus.on('agent:deselected', () => {
            if (this._pendingActivitySelection?.kind === 'agent') this._pendingActivitySelection = null;
        }));
        this._eventUnsubscribers.push(eventBus.on('agent:removed', (agent) => {
            const pending = this._pendingActivitySelection;
            if (pending?.kind === 'agent' && pending.target.id === agent?.id) this._pendingActivitySelection = null;
        }));
        this._eventUnsubscribers.push(eventBus.on(BUILDING_EVENTS.DESELECTED, () => {
            if (this._pendingActivitySelection?.kind === 'building') this._pendingActivitySelection = null;
        }));
    }

    _loadActivityPanel() {
        if (this.activityPanel) return Promise.resolve(this.activityPanel);
        if (this._activityPanelLoadPromise) return this._activityPanelLoadPromise;
        this._activityPanelLoadPromise = Promise.all([
            this._ensureStylesheet('activity'),
            import('./shared/ActivityPanel.js'),
        ]).then(([, module]) => {
            if (this._destroyed || !module.ActivityPanel) return null;
            this.activityPanel = new module.ActivityPanel({
                world: () => this.world,
                renderer: () => this.renderer,
                harborTraffic: () => this.renderer?.harborTraffic || null,
                biographyService: () => this.biographyService,
                affinityService: () => this.affinityService,
                toast: this.toast,
            });
            return this.activityPanel;
        }).catch((error) => {
            console.warn('[App] ActivityPanel failed to load:', error.message);
            this._activityPanelLoadPromise = null;
            return null;
        });
        return this._activityPanelLoadPromise;
    }

    _bindDeferredModalCss() {
        if (this._onDeferredModalIntent) return;
        this._onDeferredModalIntent = (event) => {
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
            // Every way into a modal: the version, the gear, and the SOUND
            // popover's MORE IN SETTINGS.
            const target = event.target?.closest?.(
                '.topbar__version, [aria-label="Open settings"], #soundMore',
            );
            if (!target || this._stylesheetLoaded('modal')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            target.setAttribute('aria-busy', 'true');
            void this._ensureStylesheet('modal').then(() => {
                if (!this._destroyed && target.isConnected) target.click();
            }).catch((error) => {
                console.warn('[App] Modal stylesheet failed to load:', error.message);
            }).finally(() => target.removeAttribute('aria-busy'));
        };
        document.addEventListener('click', this._onDeferredModalIntent, true);
        document.addEventListener('keydown', this._onDeferredModalIntent, true);
    }

    _getLoomMiniatureResolver() {
        if (!this._loomMiniatureResolver) {
            this._loomMiniatureResolver = createLoomMiniatureResolver({
                getAssets: () => this.assets || this.renderer?.assets || null,
                getCompositor: () => this.renderer?.compositor || Compositor.shared(),
                getWorld: () => this.world,
                onAssetLoaded: () => {
                    if (!this._destroyed && this.chronicleLog) {
                        this._scheduleArchiveLoomRefresh();
                    }
                },
            });
        }
        return this._loomMiniatureResolver;
    }

    _resolveLoomMiniature(actor, dims) {
        return this._getLoomMiniatureResolver()(actor, dims);
    }

    async _openChroniclePanel() {
        if (!this._chroniclePanelLoadPromise) {
            this._chroniclePanelLoadPromise = Promise.all([
                this._ensureStylesheet('modal'),
                import('./shared/ChroniclePanel.js'),
            ]).then(([, module]) => {
                if (this._destroyed || !module.ChroniclePanel) return null;
                const panel = new module.ChroniclePanel({
                    modal: this.modal,
                    chronicleLog: this.chronicleLog,
                    spendLedger: this.spendLedger,
                    usageGetter: () => this.latestUsage,
                    toast: this.toast,
                    liveHistory: !this.simMode,
                    loomMiniatureResolver: this._getLoomMiniatureResolver(),
                    onExportTapestry: data => this._exportTapestry(data),
                });
                this.chroniclePanel = panel;
                return panel;
            }).catch((error) => {
                this._chroniclePanelLoadPromise = null;
                throw error;
            });
        }
        const panel = await this._chroniclePanelLoadPromise;
        return panel?.open?.();
    }

    async _exportTapestry(inputData) {
        const isToday = !inputData?.dateKey || inputData.dateKey === chronicleDateKey();
        const data = {
            ...inputData,
            resolveMiniature: inputData?.resolveMiniature || this._getLoomMiniatureResolver(),
            ...(isToday ? { loomOptions: { ...(inputData?.loomOptions || {}), endTs: Date.now() } } : {}),
        };
        const { renderChronicleTapestry, tapestryFileName } = await import('./shared/ChronicleTapestry.js');
        const fromDashboard = this.modeManager.getCurrentMode() === 'dashboard';
        if (fromDashboard) this.modeManager.switchMode('character');
        let diorama, cast;
        try {
            if (fromDashboard) {
                await this.renderer?._worldResumePromise;
                this._resizeWorldCanvas?.();
            }
            const card = await this.renderer?.strikePostcard({ save: false, crop: '16:9' });
            if (!card?.ok) throw new Error('The World could not draw the tapestry diorama');
            // The postcard's caption is outside the cropped scene.
            diorama = document.createElement('canvas');
            diorama.width = card.canvas.width;
            diorama.height = Math.round(diorama.width * 9 / 16);
            diorama.getContext('2d').drawImage(card.canvas, 0, 0);
            cast = buildTapestryCast({
                dateKey: data?.dateKey,
                events: data?.events,
                summary: data?.summary,
                agentSprites: this.renderer?.agentSprites,
            });
        } finally {
            if (fromDashboard && !this._destroyed) this.modeManager.switchMode('dashboard');
        }
        const { canvas } = renderChronicleTapestry({ ...data, diorama, cast });
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Tapestry PNG encoding failed');
        const url = URL.createObjectURL(blob);
        try {
            const link = document.createElement('a');
            link.download = tapestryFileName(data.dateKey);
            link.href = url;
            link.click();
        } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    async _mountWorldTools(renderer) {
        const frame = document.getElementById('characterMode');
        let studioLoad;
        renderer.togglePostcardStudio = () => {
            if (renderer.postcardStudio) return renderer.postcardStudio.toggle();
            studioLoad ??= Promise.all([import('./shared/PostcardStudio.js'), this._ensureStylesheet('modal')])
                .then(([{ PostcardStudio }]) => {
                    if (this.renderer !== renderer || !renderer._worldModeActive || this._destroyed) return;
                    renderer.postcardStudio = new PostcardStudio({
                        container: frame, getRenderer: () => renderer,
                        hasActionNeeded: () => Boolean(this.world.getStats().attention),
                    });
                    renderer.postcardStudio.open();
                }).catch(() => this.toast?.show('Postcard Studio could not open.', 'error'))
                .finally(() => { studioLoad = null; });
            return studioLoad;
        };
        if (renderer._worldModeActive && new URLSearchParams(location.search).get('theatre') === '1') {
            renderer.setTheatreMode(true);
        }
        const day = this.retoldDay;
        if (!day) return;
        const [{ RetoldScrubber }, { RETOLD_SCRUBBER_RESERVED_NAME }] = await Promise.all([
            import('./shared/RetoldScrubber.js'), import('./character-mode/CouncilRibbon.js'), this._ensureStylesheet('modal'),
        ]);
        if (this.renderer !== renderer || this._destroyed) return;
        const replay = this.agentSimulator;
        const clock = replay.replayClock;
        renderer.retoldScrubber = new RetoldScrubber({
            container: frame, dateKey: day.dateKey, lower: day.lower, upper: day.upper,
            chapters: day.chapters, pins: day.pins, theatreMode: renderer.theatreMode,
            isShortcutBlocked: event => shortcutBlocked(event) || !renderer._worldModeActive
                || (document.activeElement !== document.body && document.activeElement !== renderer.canvas),
            onSeek: ({ progress }) => {
                const elapsed = progress * clock.duration;
                if (elapsed < clock.elapsed) {
                    replay.stop();
                    replay.start();
                }
                replay.advanceReplay(elapsed - clock.elapsed, false);
                renderer._invalidateIdleFrame();
            },
            onReserveRect: rect => publishReservedBox(RETOLD_SCRUBBER_RESERVED_NAME, rect),
        });
    }

    async _loadRenderer(rendererModule = null) {
        let candidate = null;
        try {
            if (this._destroyed) return;
            const module = rendererModule || await this._getRendererModule();
            if (this._destroyed) return;
            const canvas = document.getElementById('worldCanvas');

            if (!module.IsometricRenderer) {
                throw new Error('IsometricRenderer module missing export');
            }

            if (!canvas) {
                if (!this._loadRendererRetryScheduled) {
                    this._loadRendererRetryScheduled = true;
                    this._loadRendererRetryHandle = requestAnimationFrame(() => {
                        this._loadRendererRetryHandle = null;
                        this._loadRendererRetryScheduled = false;
                        if (this._destroyed) return;
                        void this._loadRenderer().catch(error => this._handleBootFailure(error));
                    });
                }
                console.warn('[App] worldCanvas not found yet (retrying render mount)');
                return;
            }

            candidate = new module.IsometricRenderer(this.world, {
                replay: this.agentSimulator?.replayClock ? this.agentSimulator : null,
                assets: this.assets,
                terrainArtifactBoot: this._terrainArtifactBoot,
                chronicleStore: this.chronicleStore,
                modal: this.modal,
                moodService: this.moodService,
                biographyService: this.biographyService,
                affinityService: this.affinityService,
            });
            this._terrainArtifactBoot = null;
            // Wave 10 — the WebGPU world (`?renderer=webgpu`, and Stage B's
            // Chromium default) is resolved before the synchronous mount, so
            // no frame is presented before the backend is known. The default
            // never waits: one still compiling mounts WebGL2 and switches.
            await candidate.resolveBackend?.(window.location.search);
            if (this._destroyed) {
                candidate.releaseResolvedBackend?.();
                return;
            }
            if (candidate.show(canvas) === false) {
                throw new Error('IsometricRenderer failed to mount');
            }
            candidate.setWorldModeActive?.(
                this.modeManager?.getCurrentMode?.() !== 'dashboard',
            );
            if (this.latestUsage) candidate.setQuotaState?.(this.latestUsage);

            candidate.onAgentSelect = (agent) => {
                if (agent) emitAgentSelected(agent);
                else emitAgentDeselected();
            };

            const scenarioMetadata = this.agentSimulator?.recorded ? null : this.agentSimulator?.getScenario?.()?.metadata || null;
            const scenarioApplied = candidate.applyScenarioMetadata?.(scenarioMetadata) || false;
            if (this._destroyed) {
                candidate.hide?.();
                return;
            }
            const previous = this.renderer;
            this.renderer = candidate;
            candidate.setVisualBeat?.(this.topBar?.audio?.getVisualBeat?.() ?? null);
            if (this._archiveLoomPanelState?.canvas) {
                candidate.buildingRenderer?.setArchiveLoomPanel?.(this._archiveLoomPanelState.canvas);
            }
            this._trackChronicleTask(this.refreshArchiveLoomPanel().catch(() => {}));
            previous?.hide?.();
            await this._mountWorldTools(candidate);
            if (this._destroyed || this.renderer !== candidate) return;
            this._installPerfDebugHelper();
            // Framing waits one frame so the first update has placed the agent
            // sprites the content box is built from. That frame never reveals:
            // the boot signal stays 'boot-pending' until `_openWorld` has applied
            // the opening pose (0.3), so the first frame shown is the opening.
            this._centerCameraHandle = requestAnimationFrame(() => {
                this._centerCameraHandle = null;
                if (this._destroyed || this.renderer !== candidate || !candidate.camera) return;
                try {
                    this._openWorld(candidate, scenarioApplied ? scenarioMetadata : null);
                } catch (error) {
                    console.error('[App] World opening failed:', error);
                } finally {
                    candidate.armFirstFrameSignal?.('boot');
                }
            });

            console.log('[App] IsometricRenderer loaded');
        } catch (err) {
            candidate?.hide?.();
            if (this.renderer === candidate) this.renderer = null;
            throw err;
        }
    }

    // 8.3 — the opening shot. A scenario that authors a camera pose opens on
    // the island and settles on that pose (metadata `camera.opening: false`
    // keeps a deterministic first frame); otherwise it settles on live work.
    // 0.3 — only then may a presented frame report `world:first-frame`.
    _openWorld(renderer, scenarioMetadata = null) {
        if (renderer.stripProfile) {
            renderer.cameraDirector.setAmbient(true);
            return;
        }
        const cameraMeta = scenarioMetadata?.camera || null;
        if (cameraMeta) {
            if (cameraMeta.opening !== false) {
                renderer.playOpeningShot?.({ targetPose: renderer.camera.capturePose() });
            }
        } else if (typeof renderer.frameContent === 'function') {
            renderer.frameContent();
        } else {
            renderer.camera.centerOnMap();
        }
    }

    async _loadDashboard() {
        if (this.dashboardRenderer) return true;
        if (this._dashboardLoadPromise) return this._dashboardLoadPromise;
        this._dashboardLoadPromise = this._loadDashboardOnce();
        return this._dashboardLoadPromise;
    }

    async _loadDashboardOnce() {
        let candidate = null;
        try {
            if (this._destroyed) return;
            const [, module] = await Promise.all([
                this._ensureStylesheet('dashboard'),
                import('./dashboard-mode/DashboardRenderer.js'),
            ]);
            if (this._destroyed) return;
            if (module.DashboardRenderer) {
                const locate = agent => {
                    if (!agent?.id || this._destroyed) return;
                    this.modeManager.switchMode('character');
                    // The button both emits and calls back. Frame once after the canvas has resized.
                    cancelAnimationFrame(this._locateFrame);
                    this._locateFrame = requestAnimationFrame(async () => {
                        this._locateFrame = null;
                        const renderer = this.renderer;
                        await renderer?._worldResumePromise;
                        if (!this._destroyed && renderer?._worldModeActive) renderer.frameWorldAgent(agent.id);
                    });
                };
                candidate = new module.DashboardRenderer(this.world, { toast: this.toast, onLocateInWorld: locate });
                this._eventUnsubscribers.push(eventBus.on(module.DASHBOARD_LOCATE_IN_WORLD_EVENT,
                    ({ agentId }) => locate(this.world.agents.get(agentId))));
                if (this._destroyed) {
                    candidate.destroy?.();
                    return;
                }
                this.dashboardRenderer?.destroy?.();
                this.dashboardRenderer = candidate;
                console.log('[App] DashboardRenderer loaded');
                return true;
            }
        } catch (err) {
            candidate?.destroy?.();
            if (this.dashboardRenderer === candidate) this.dashboardRenderer = null;
            this._dashboardLoadPromise = null;
            console.warn('[App] DashboardRenderer failed to load:', err.message);
            return false;
        }
        return false;
    }

    _bindAgentFollow() {
        if (this._agentFollowBound) return;
        this._agentFollowBound = true;
        // Follow the camera when an agent is selected
        this._eventUnsubscribers.push(eventBus.on('agent:selected', (agent) => {
            if (agent && this.renderer) {
                this.renderer.selectAgentById(agent.id);
            }
        }));
        this._eventUnsubscribers.push(eventBus.on('agents:pins-changed', (detail = {}) => {
            this.renderer?.setPinnedAgentIds?.(detail.pinnedAgentIds || []);
        }));


        // Stop following when the panel closes
        this._eventUnsubscribers.push(eventBus.on('agent:deselected', () => {
            if (this.renderer) {
                this.renderer.selectAgentById(null);
            }
        }));
    }

    _bindDeepLink() {
        if (this._deepLinkBound) return;
        this._deepLinkBound = true;
        // Mirror the current agent selection into the URL fragment so links
        // like /#agent=<id> can be shared.
        this._eventUnsubscribers.push(eventBus.on('agent:selected', (agent) => {
            if (!agent?.id) return;
            // Absolute path + search: index.html's `<base href="/">` would
            // otherwise resolve a bare `#agent=` to `/`, dropping `/m/` and the query.
            history.replaceState(null, '', `${location.pathname}${location.search}#agent=${encodeURIComponent(agent.id)}`);
        }));
        this._eventUnsubscribers.push(eventBus.on('agent:deselected', () => {
            if (location.hash.startsWith('#agent=')) {
                history.replaceState(null, '', location.pathname + location.search);
            }
        }));
    }

    _applyDeepLink() {
        const match = /^#agent=(.+)$/.exec(location.hash);
        if (!match) return;
        let agentId;
        try {
            agentId = decodeURIComponent(match[1]);
        } catch {
            return;
        }
        const agent = this.world?.agents?.get?.(agentId);
        if (agent) emitAgentSelected(agent);
    }

    _bindChronicleSignals() {
        if (this._chronicleSignalsBound) return;
        this._chronicleSignalsBound = true;
        this._eventUnsubscribers.push(eventBus.on('chronicle:milestone', (monument) => {
            this.auroraGate?.recordMilestone(monument);
            this._trackChronicleTask(this.auroraGate?.evaluate(Date.now(), {
                release: monument?.kind === 'release',
                majorVerified: monument?.kind === 'verified' && monument?.weight === 'major',
            }).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: monument?.kind || 'milestone' });
                }
            }).catch(() => {}));
        }));

        this._eventUnsubscribers.push(eventBus.on('usage:updated', (usage) => {
            this.latestUsage = usage;
            this.renderer?.setQuotaState?.(usage);
            const fiveHour = Number(usage?.quota?.fiveHour);
            if (Number.isFinite(fiveHour) && fiveHour > 0.85) {
                eventBus.emit('quota:throttled', { fiveHour, ts: Date.now() });
            }
            this._trackChronicleTask(this.auroraGate?.handleUsageUpdate(usage).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: 'quota-rollover' });
                }
            }).catch(() => {}));
        }));
        // `chronicle:aurora` is the audio cue's (BgmDirector, SignalDirector):
        // the sky never answers to the Chronicle or any agent event (V3).

        // W6-B (Spec 04 §5.2/§5.4/§5.5) — keep the Archive rear-wall Loom panel
        // woven from live Chronicle records, and close today's last panel cleanly
        // when Evensong sounds at 21:00.
        this._eventUnsubscribers.push(eventBus.on('chronicle:recorded', (record) => {
            if (this._destroyed) return;
            const recordDate = typeof record?.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.localDate)
                ? record.localDate
                : chronicleDateKey(Number(record?.ts) || Date.now());
            if (this._archiveLoomClosedDate && this._archiveLoomClosedDate !== recordDate) {
                this._archiveLoomClosedDate = null;
            }
            this._scheduleArchiveLoomRefresh();
        }));

        this._eventUnsubscribers.push(eventBus.on('audio:evensong', (payload = {}) => {
            if (this._destroyed || payload?.active !== true) return;
            const ts = Number.isFinite(Number(payload?.ts)) ? Number(payload.ts) : Date.now();
            const rawDateKey = payload?.day || payload?.dateKey;
            const targetDateKey = typeof rawDateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDateKey.trim())
                ? rawDateKey.trim()
                : chronicleDateKey(ts);
            const targetHour = Number.isInteger(payload?.hour) ? payload.hour : null;
            this._archiveLoomClosedDate = targetDateKey;
            if (this._archiveLoomRefreshTimer !== null) {
                clearTimeout(this._archiveLoomRefreshTimer);
                this._archiveLoomRefreshTimer = null;
            }
            this._trackChronicleTask(
                Promise.allSettled([
                    this.chronicleLog?.flush?.(),
                    this.chronicleLog?.recordCoverageQuarter?.(ts),
                    (() => {
                        const code = this._currentChronicleSkyCode();
                        return code ? this.chronicleLog?.recordSkyHour?.(code, ts) : null;
                    })(),
                ])
                    .then(() => this.refreshArchiveLoomPanel({
                        closed: true,
                        dateKey: targetDateKey,
                        hour: targetHour,
                        endTs: ts,
                    }))
                    .catch(() => {}),
            );
        }));
    }

    _scheduleArchiveLoomRefresh(delayMs = 250) {
        if (this._destroyed || !this.chronicleLog) return;
        if (this._archiveLoomRefreshTimer !== null) return;
        this._archiveLoomRefreshTimer = setTimeout(() => {
            this._archiveLoomRefreshTimer = null;
            if (this._destroyed) return;
            this._trackChronicleTask(this.refreshArchiveLoomPanel().catch(() => {}));
        }, delayMs);
        this._archiveLoomRefreshTimer?.unref?.();
    }

    async refreshArchiveLoomPanel({
        closed = null,
        dateKey = null,
        hour = null,
        endTs = null,
        documentRef = globalThis.document,
    } = {}) {
        if (this._destroyed || !this.chronicleLog) return null;
        const todayKey = chronicleDateKey();
        const targetDateKey = typeof dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
            ? dateKey
            : todayKey;
        const isClosed = closed !== null ? Boolean(closed) : (this._archiveLoomClosedDate === targetDateKey);
        const seq = ++this._archiveLoomSeq;

        await this.chronicleLog.flush?.().catch(() => {});
        const [events, coverage, sky] = await Promise.all([
            typeof this.chronicleLog.readDay === 'function'
                ? this.chronicleLog.readDay(targetDateKey).catch(() => [])
                : Promise.resolve([]),
            typeof this.chronicleLog.readDayCoverage === 'function'
                ? this.chronicleLog.readDayCoverage(targetDateKey).catch(() => null)
                : this.chronicleStore?.getDayCoverage?.(targetDateKey).catch(() => null) ?? Promise.resolve(null),
            typeof this.chronicleLog.readDaySky === 'function'
                ? this.chronicleLog.readDaySky(targetDateKey).catch(() => null)
                : this.chronicleStore?.getDaySky?.(targetDateKey).catch(() => null) ?? Promise.resolve(null),
        ]);
        if (this._destroyed || seq !== this._archiveLoomSeq) return null;

        const effectiveEndTs = endTs !== null && Number.isFinite(Number(endTs))
            ? Number(endTs)
            : (targetDateKey === todayKey ? Date.now() : null);
        const built = buildArchiveLoomPanelCanvas({
            events,
            coverage,
            sky,
            dateKey: targetDateKey,
            hour,
            closed: isClosed,
            endTs: effectiveEndTs,
            resolveMiniature: this._getLoomMiniatureResolver(),
            documentRef,
        });
        const panelSurface = built.canvas || built.rgba || null;
        this._archiveLoomPanelState = {
            dateKey: targetDateKey,
            hour: built.hour,
            closed: built.closed,
            canvas: panelSurface,
            dayModel: built.dayModel,
        };
        this.renderer?.buildingRenderer?.setArchiveLoomPanel?.(panelSurface);
        return this._archiveLoomPanelState;
    }

    _trackChronicleTask(task) {
        if (!task || typeof task.finally !== 'function') return task;
        const tasks = this._chronicleTasks;
        tasks.add(task);
        task.then(
            () => tasks.delete(task),
            () => tasks.delete(task),
        );
        return task;
    }

    _bindResize() {
        const canvas = document.getElementById('worldCanvas');
        const container = canvas?.parentElement;
        if (!canvas || !container) return;
        // Resolved on every resize: the renderer replaces #worldFxCanvas (the
        // live WebGL2→WebGPU switch, a WebGPU start failure, a GPU-failure
        // fallback), and a surface captured once would leave the new one at
        // its old CSS box while its backing follows the viewport.
        const canvasSurfaces = () => [
            canvas,
            container.querySelector('#worldFxCanvas'),
            container.querySelector('#worldOverlayCanvas'),
        ].filter(Boolean);
        this._worldCanvas = canvas;
        if (this._resizeHandle) {
            cancelAnimationFrame(this._resizeHandle);
            this._resizeHandle = null;
        }

        const resize = ({ force = false } = {}) => {
            const w = container.clientWidth;
            const h = container.clientHeight;

            if (w === 0 || h === 0) {
                if (!this._resizeHandle && this.modeManager?.getCurrentMode() !== 'dashboard') {
                    this._resizeHandle = requestAnimationFrame(() => {
                        this._resizeHandle = null;
                        if (this._destroyed) return;
                        resize();
                    });
                }
                return;
            }

            this._resizeHandle = null;

            const cssWidth = Math.round(w);
            const cssHeight = Math.round(h);
            const dpr = effectiveCanvasDpr(cssWidth, cssHeight, window.devicePixelRatio || 1);
            const newW = Math.round(cssWidth * dpr);
            const newH = Math.round(cssHeight * dpr);
            const surfaces = canvasSurfaces();
            if (
                !force &&
                surfaces.every(surface => (
                    surface.width === newW &&
                    surface.height === newH &&
                    surface._claudeVilleDpr === dpr &&
                    surface._claudeVilleCssWidth === cssWidth &&
                    surface._claudeVilleCssHeight === cssHeight
                ))
            ) return;
            // 0.3 — the screen-centre world point before the canvases change
            // (the camera still reads the old viewport here). Opening or
            // closing the activity panel must not jump the world sideways.
            const heldCenter = this.renderer?.camera && canvas._claudeVilleCssWidth > 0
                ? this.renderer.camera.currentCenterWorld()
                : null;
            for (const surface of surfaces) {
                surface.width = newW;
                surface.height = newH;
                surface._claudeVilleDpr = dpr;
                surface._claudeVilleCssWidth = cssWidth;
                surface._claudeVilleCssHeight = cssHeight;
                surface.style.width = `${cssWidth}px`;
                surface.style.height = `${cssHeight}px`;
            }
            // alpha:false — the sky pass paints the full viewport opaquely
            // every frame, so an opaque backing store lets the compositor
            // skip per-frame alpha blending of the whole canvas layer.
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.imageSmoothingEnabled = false;
            ctx.mozImageSmoothingEnabled = false;
            ctx.webkitImageSmoothingEnabled = false;
            // 10.3 — display-p3 on a P3 screen; the renderer passes the same.
            const overlayCanvas = surfaces.find(surface => surface.id === 'worldOverlayCanvas');
            const overlayCtx = overlayCanvas?.getContext?.('2d', overlayContextAttributes());
            if (overlayCtx) {
                overlayCtx.imageSmoothingEnabled = false;
                overlayCtx.mozImageSmoothingEnabled = false;
                overlayCtx.webkitImageSmoothingEnabled = false;
            }
            this.renderer?.postFx?.resize?.(newW, newH);
            this.renderer?.gpuWorld?.resize?.(newW, newH);
            if (this.renderer?.invalidateViewportCaches) {
                this.renderer.invalidateViewportCaches();
            }
            if (this.renderer && this.renderer.camera) {
                const cam = this.renderer.camera;
                cam.onViewportResize();
                if (heldCenter) cam.holdCenter(heldCenter);
                // 0.5 — the relayout a Dashboard→World switch causes restores
                // the pose the World was left in; it is not a reason to re-frame.
                const returnPose = this._worldReturnPose;
                this._worldReturnPose = null;
                if (returnPose) {
                    cam.resumeViewPose(returnPose);
                } else if (!cam._userAdjusted && !cam.followTarget && typeof this.renderer.frameContent === 'function') {
                    // Re-frame to the live village on relayout, unless the user has
                    // taken manual control of the camera or is following an agent.
                    this.renderer.frameContent();
                }
            }
            // 0.3 — reallocating the canvases cleared them. Draw the frame now,
            // inside the ResizeObserver callback (after layout, before paint), so
            // a cleared backing store never reaches the screen. A World that is
            // suspended, hidden or not yet drawn skips this.
            this.renderer?.renderNow?.();
        };

        // Use ResizeObserver to detect container size changes (including footer open/close)
        this._resizeObserver = new ResizeObserver(() => resize());
        this._resizeObserver.observe(container);

        this._onWindowResize = () => resize();
        window.addEventListener('resize', this._onWindowResize);

        // A DPR change without a layout change never fires `resize` — dragging
        // the window from a Retina laptop panel to a 1x external display is the
        // common case. Without this the backing store keeps the old ratio and
        // the browser rescales it by a fraction, which shreds pixel text.
        this._watchDevicePixelRatio = () => {
            this._dprQuery?.removeEventListener?.('change', this._onDevicePixelRatioChange);
            this._dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null;
            this._dprQuery?.addEventListener?.('change', this._onDevicePixelRatioChange);
        };
        this._onDevicePixelRatioChange = () => {
            this._watchDevicePixelRatio();
            resize();
        };
        this._watchDevicePixelRatio();
        this._resizeWorldCanvas = resize;
        this._bindGraphicsRecovery(canvas, resize);
        resize();
    }

    _bindGraphicsRecovery(canvas, resize) {
        if (this._onWorldContextLost) {
            canvas.removeEventListener('contextlost', this._onWorldContextLost);
            canvas.removeEventListener('contextrestored', this._onWorldContextRestored);
        }
        // A real 2D context loss (a GPU-process crash) blanks every
        // accelerated canvas in the page, including the module-level sprite,
        // bake and avatar caches no World path rebuilds; the state is
        // server-driven, so the complete recovery is a reload. A second crash
        // within GPU_CRASH_RELOAD_WINDOW_MS does not reload again (no reload
        // loop): the World rebuilds in place on the Canvas world and the
        // Shift-D backend row says so. A synthetic or GPU-world-only loss
        // keeps the in-place resume. Never cancel the 2D `contextlost`: for a
        // 2D canvas that tells the browser NOT to restore the context.
        let canvasFallback = false;
        this._onWorldContextLost = () => {
            canvasFallback = false;
            if (this.renderer?.ctx?.isContextLost?.() === true) {
                if (claimGpuCrashReload()) {
                    window.location.reload();
                    return;
                }
                canvasFallback = true;
            }
            this.renderer?.handleContextLost?.();
        };
        this._onWorldContextRestored = () => {
            resize({ force: true });
            this.renderer?.handleContextRestored?.({ canvasFallback });
            canvasFallback = false;
        };
        canvas.addEventListener('contextlost', this._onWorldContextLost, false);
        canvas.addEventListener('contextrestored', this._onWorldContextRestored, false);

        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
        this._onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                this.renderer?.pauseForVisibility?.();
                return;
            }
            resize({ force: true });
            const worldVisible = this.modeManager?.getCurrentMode?.() !== 'dashboard';
            this.renderer?.resumeFromVisibility?.({ active: worldVisible });
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    _installPerfDebugHelper() {
        if (typeof window === 'undefined') return;
        const existing = window.__claudeVillePerf || {};
        this._perfDebugCanvasBudget = () => this.renderer?.getCanvasBudget?.() || null;
        this._perfDebugStartProfile = () => this.renderer?.startPerformanceProfile?.() || false;
        this._perfDebugStopProfile = () => this.renderer?.stopPerformanceProfile?.() || null;
        this._perfDebugFrameProfile = () => this.renderer?.getPerformanceProfile?.() || null;
        this._perfDebugBehavior = () => this.renderer?.behaviorTelemetry?.metrics || null;
        this._perfDebugAmbient = () => this.renderer?.ambientDiagnostics?.() || null;
        this._cameraSetHelper = (pose = {}) => this.renderer?.setCameraPose?.(pose) || false;
        this._clientPerfHelpers = this.clientPerfMetrics?.getDebugHelpers?.() || {};
        window.__claudeVillePerf = {
            ...existing,
            ...this._clientPerfHelpers,
            canvasBudget: this._perfDebugCanvasBudget,
            startFrameProfile: this._perfDebugStartProfile,
            stopFrameProfile: this._perfDebugStopProfile,
            frameProfile: this._perfDebugFrameProfile,
            behavior: this._perfDebugBehavior,
            ambient: this._perfDebugAmbient,
        };
        window.cameraSet = this._cameraSetHelper;
    }

    _applyI18n() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            const val = i18n.t(key);
            if (typeof val === 'string') {
                el.textContent = val;
            }
        });
    }

    _showBootError(err) {
        this._handleBootFailure(err);
    }

    destroy() {
        if (this._destroyPromise) return this._destroyPromise;
        this._destroyed = true;
        if (this._locateFrame != null) cancelAnimationFrame(this._locateFrame);
        this._destroyPromise = (async () => {
            await this._cleanupOwned();
            if (this._bootState !== 'failed') this._bootState = 'destroyed';
        })();
        return this._destroyPromise;
    }

    _cleanupOwned() {
        if (this._cleanupPromise) return this._cleanupPromise;
        this._cleanupPromise = this._cleanupOwnedOnce();
        return this._cleanupPromise;
    }

    async _cleanupOwnedOnce() {
        const renderer = this.renderer;
        const store = this.chronicleStore;
        const worldCanvas = this._worldCanvas || document.getElementById('worldCanvas');
        const worldFxCanvas = document.getElementById('worldFxCanvas');
        const worldOverlayCanvas = document.getElementById('worldOverlayCanvas');

        this._bootController?.abort?.();

        if (this._chroniclePruneInterval) {
            window.clearInterval(this._chroniclePruneInterval);
            this._chroniclePruneInterval = null;
        }
        if (this._archiveLoomRefreshTimer !== null) {
            clearTimeout(this._archiveLoomRefreshTimer);
            this._archiveLoomRefreshTimer = null;
        }
        this._archiveLoomSeq++;
        this._archiveLoomClosedDate = null;
        this._archiveLoomPanelState = null;
        this._loomMiniatureResolver?.clearCache?.();
        this._loomMiniatureResolver = null;
        if (this._resizeHandle) {
            cancelAnimationFrame(this._resizeHandle);
            this._resizeHandle = null;
        }
        if (this._loadRendererRetryHandle) {
            cancelAnimationFrame(this._loadRendererRetryHandle);
            this._loadRendererRetryHandle = null;
        }
        this._loadRendererRetryScheduled = false;
        if (this._centerCameraHandle) {
            cancelAnimationFrame(this._centerCameraHandle);
            this._centerCameraHandle = null;
        }

        for (const unsubscribe of this._eventUnsubscribers.splice(0)) {
            unsubscribe?.();
        }
        if (this._onGlobalKeydown) {
            window.removeEventListener('keydown', this._onGlobalKeydown, true);
            this._onGlobalKeydown = null;
        }
        if (this._onDashboardIntent) {
            document.getElementById('btnModeDashboard')?.removeEventListener(
                'click',
                this._onDashboardIntent,
                true,
            );
            this._onDashboardIntent = null;
        }
        if (this._onDeferredModalIntent) {
            document.removeEventListener('click', this._onDeferredModalIntent, true);
            document.removeEventListener('keydown', this._onDeferredModalIntent, true);
            this._onDeferredModalIntent = null;
        }
        if (this._onDeferredInteractionClick) {
            document.removeEventListener('click', this._onDeferredInteractionClick, true);
            this._onDeferredInteractionClick = null;
        }
        if (this._onDeferredInteractionKeydown) {
            document.removeEventListener('keydown', this._onDeferredInteractionKeydown, true);
            this._onDeferredInteractionKeydown = null;
        }
        this._deferredSelectionIntent = null;
        this._pendingActivitySelection = null;
        this._readControlCleanup?.();
        this._cameraModeCleanup?.();
        this._worldDockCleanup?.();
        if (this._onFirstRunHintDismiss) {
            document.getElementById('firstRunHintDismiss')?.removeEventListener(
                'click',
                this._onFirstRunHintDismiss,
            );
            this._onFirstRunHintDismiss = null;
        }
        if (this._onBootRetry && this._bootActionEl) {
            this._bootActionEl.removeEventListener('click', this._onBootRetry);
        }
        this._bootStatusWrap?.remove?.();
        this._bootAnnouncementEl?.remove?.();
        this._bootStatusWrap = null;
        this._bootStatusEl = null;
        this._bootAnnouncementEl = null;
        this._bootFailureEl = null;
        this._bootActionEl = null;
        this._onBootRetry = null;
        this._villageBound = false;
        this._foundationReady = false;
        this._surfacesBound = false;
        this._worldFrameRecoveryBound = false;
        this._worldFrameFailureNotified = false;
        this._worldFrameFailureToast = null;
        this._deferredActivityBound = false;
        this._characterAssetsBound = false;
        this._chronicleSignalsBound = false;
        this._agentFollowBound = false;
        this._deepLinkBound = false;
        this._usageRequested = false;
        this._firstRunHintRevealed = false;
        this.villageState = initialVillageState();
        resetAgentSelection();
        // Only an app that booted owns them: a never-booted instance's
        // teardown leaves a live app's registries alone.
        if (this._ownsModuleRegistries) {
            this._ownsModuleRegistries = false;
            uninstallRepoColors();
            uninstallVerifiedOutcomeMemory();
        }

        if (this._onWindowResize) {
            window.removeEventListener('resize', this._onWindowResize);
            this._onWindowResize = null;
        }
        if (this._dprQuery && this._onDevicePixelRatioChange) {
            this._dprQuery.removeEventListener?.('change', this._onDevicePixelRatioChange);
        }
        this._dprQuery = null;
        this._onDevicePixelRatioChange = null;
        this._watchDevicePixelRatio = null;
        this._resizeObserver?.disconnect?.();
        this._resizeObserver = null;

        if (this._worldCanvas && this._onWorldContextLost) {
            this._worldCanvas.removeEventListener('contextlost', this._onWorldContextLost);
            this._worldCanvas.removeEventListener('contextrestored', this._onWorldContextRestored);
        }
        this._onWorldContextLost = null;
        this._onWorldContextRestored = null;
        this._worldCanvas = null;

        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = null;
        }

        if (this._onPageHide) {
            window.removeEventListener('pagehide', this._onPageHide);
            this._onPageHide = null;
        }

        this._callLifecycle('SessionWatcher.stop', () => this.sessionWatcher?.stop?.());
        this._callLifecycle('WebSocketClient.disconnect', () => this.wsClient?.disconnect?.());
        this._callLifecycle('AgentManager.stop', () => this.agentManager?.stop?.());
        this._callLifecycle('AgentSimulator.stop', () => this.agentSimulator?.stop?.());
        this._callLifecycle('NotificationService.destroy', () => this.notificationService?.destroy?.());
        this._callLifecycle('AttentionService.destroy', () => this.attentionService?.destroy?.());
        const chronicleStop = this._callLifecycle(
            'ChronicleLog.stop',
            () => this.chronicleLog?.stop?.(),
        );
        const spendStop = this._callLifecycle(
            'SpendLedger.stop',
            () => this.spendLedger?.stop?.(),
        );
        this._callLifecycle('ActivityPanel.destroy', () => this.activityPanel?.destroy?.());
        this._callLifecycle('DashboardRenderer.destroy', () => this.dashboardRenderer?.destroy?.());
        this._callLifecycle('ChroniclePanel.destroy', () => this.chroniclePanel?.destroy?.());
        this._callLifecycle('SessionDetailsService.clear', () => sessionDetailsService.clear());
        this._callLifecycle('ModeManager.destroy', () => this.modeManager?.destroy?.());
        this._callLifecycle('Sidebar.destroy', () => this.sidebar?.destroy?.());
        const topBarStop = this._callLifecycle('TopBar.destroy', () => this.topBar?.destroy?.());
        this._callLifecycle('Modal.destroy', () => this.modal?.destroy?.());
        this._unpublishFirstRunHint?.();
        this._unpublishFirstRunHint = null;
        this._callLifecycle('Toast.destroy', () => this.toast?.destroy?.());
        this._callLifecycle('MoodService.stop', () => this.moodService?.stop?.());

        const biographyStop = this._callLifecycle(
            'AgentBiographyService.stop',
            () => this.biographyService?.stop?.(),
        );
        const affinityStop = this._callLifecycle(
            'RelationshipAffinityService.stop',
            () => this.affinityService?.stop?.(),
        );
        const prune = this._chroniclePruneState.promise;
        const chronicleTasks = [...this._chronicleTasks];

        this._callLifecycle('IsometricRenderer.pauseForVisibility', () => renderer?.pauseForVisibility?.());
        const chronicleDrain = this._callLifecycle(
            'IsometricRenderer.drainChronicleUpdates',
            () => renderer?.drainChronicleUpdates?.(),
        );
        const trail = renderer?.trailRenderer || null;
        const trailDrain = this._callLifecycle('TrailRenderer.dispose', () => {
            if (typeof trail?.dispose === 'function') return trail.dispose();
            if (typeof trail?.drain === 'function') return trail.drain();
            return trail?.flush?.();
        });
        await this._settleLifecycleTasks([chronicleDrain, trailDrain]);
        this._callLifecycle('IsometricRenderer.hide', () => renderer?.hide?.());
        for (const canvas of [worldCanvas, worldFxCanvas, worldOverlayCanvas]) {
            if (!canvas) continue;
            canvas.width = 0;
            canvas.height = 0;
        }
        const assetsDispose = this._callLifecycle('AssetManager.dispose', () => this.assets?.dispose?.());

        const storeTasks = [
            biographyStop,
            affinityStop,
            prune,
            ...chronicleTasks,
        ].filter(task => task && typeof task.then === 'function');
        // These two tails own writes that are not represented in
        // _chronicleTasks. They must finish before IndexedDB closes.
        await Promise.allSettled(
            [chronicleStop, spendStop].filter(task => task && typeof task.then === 'function'),
        );
        await this._settleLifecycleTasks(storeTasks);
        await this._settleLifecycleTasks([topBarStop, assetsDispose]);
        this._callLifecycle('ChronicleStore.close', () => store?.close?.());

        if (typeof window !== 'undefined') {
            if (window.__chronicle === store) delete window.__chronicle;
            if (window.__claudeVilleApp === this) delete window.__claudeVilleApp;
            if (window.cameraSet === this._cameraSetHelper) delete window.cameraSet;
            // Stop before unpublishing: the collector owns a PerformanceObserver and
            // a pending-delta ring that must not outlive the app instance.
            this.clientPerfMetrics?.stop?.();
            for (const [name, fn] of Object.entries(this._clientPerfHelpers || {})) {
                if (window.__claudeVillePerf?.[name] === fn) delete window.__claudeVillePerf[name];
            }
            if (window.__claudeVillePerf?.canvasBudget === this._perfDebugCanvasBudget) {
                delete window.__claudeVillePerf.canvasBudget;
            }
            if (window.__claudeVillePerf?.startFrameProfile === this._perfDebugStartProfile) {
                delete window.__claudeVillePerf.startFrameProfile;
            }
            if (window.__claudeVillePerf?.stopFrameProfile === this._perfDebugStopProfile) {
                delete window.__claudeVillePerf.stopFrameProfile;
            }
            if (window.__claudeVillePerf?.frameProfile === this._perfDebugFrameProfile) {
                delete window.__claudeVillePerf.frameProfile;
            }
            if (window.__claudeVillePerf?.behavior === this._perfDebugBehavior) {
                delete window.__claudeVillePerf.behavior;
            }
            if (window.__claudeVillePerf?.ambient === this._perfDebugAmbient) {
                delete window.__claudeVillePerf.ambient;
            }
        }

        this.renderer = null;
        this.dashboardRenderer = null;
        this.activityPanel = null;
        this.assets = null;
        this.sessionWatcher = null;
        this.agentSimulator = null;
        this.notificationService = null;
        this.attentionService = null;
        this.chronicleLog = null;
        this.chroniclePanel = null;
        this.spendLedger = null;
        this.modeManager = null;
        this.sidebar = null;
        this.topBar = null;
        this.modal = null;
        this.toast = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.biographyService = null;
        this.moodService = null;
        this.affinityService = null;
        this.agentManager = null;
        this.wsClient = null;
        this.dataSource = null;
        this.world = null;
        this.latestUsage = null;
        this._chroniclePruneState.promise = null;
        this._chronicleTasks.clear();
        this._perfDebugCanvasBudget = null;
        this._perfDebugStartProfile = null;
        this._perfDebugStopProfile = null;
        this._perfDebugFrameProfile = null;
        this._cameraSetHelper = null;
        this._resizeWorldCanvas = null;
        this._bootController = null;
        this._rendererModulePromise = null;
        this._dashboardLoadPromise = null;
        this._activityPanelLoadPromise = null;
        this._chroniclePanelLoadPromise = null;
        this._stylesheetPromises.clear();
    }

    _callLifecycle(label, callback) {
        try {
            return callback();
        } catch (err) {
            console.warn(`[App] ${label} failed:`, err?.message || err);
            return null;
        }
    }

    async _settleLifecycleTasks(tasks, timeoutMs = LIFECYCLE_DRAIN_TIMEOUT_MS) {
        const pending = tasks.filter(task => task && typeof task.then === 'function');
        if (!pending.length) return;
        let timeoutHandle = null;
        await Promise.race([
            Promise.allSettled(pending),
            new Promise(resolve => {
                timeoutHandle = window.setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    }
}

// Boot
window.addEventListener('load', () => {
    const app = new App();
    window.__claudeVilleApp = app;
    app.boot();
});
