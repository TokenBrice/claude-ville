import { ART_RAMPS } from '../../config/artPalette.js';
import { WORLD_BODY_FONT_11, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { pulseValue, pulseAlpha } from './PulsePolicy.js';
import { BUOY_TORCH_COLORS } from './ParticleSystem.js';
import { fitLabelText, measureLabelText, snapScreenOrigin } from './WorldLabelKit.js';
import { branchPennonKind, normalizeRepoBranch, repoBranchProfile, repoDisplayName, repoProfile } from '../shared/RepoColor.js';
import { assignMonograms, ledgerBuoyLabel, middleTruncate } from '../shared/HarborLedger.js';
import { buildFleetCardModel } from '../shared/HarborFleetCard.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { buildingCenterToWorld } from './Projection.js';
import {
    gitEventKind,
    normalizeGitEvent,
    parseEventTime,
    shortGitLabel,
} from '../shared/GitEventIdentity.js';
import { WILDLIFE_SCENE_CATEGORY } from './WildlifeRenderer.js';
import {
    FAILURE,
    FAILURE_OUTLINE,
    GOLD,
    GOLD_RAMP,
    PEAK,
    bracket,
    defineMoment,
    diamond,
    ellipseArcDots,
    fillConvex,
    createCueGate,
    cueGatedAge,
    drawMomentThread,
    holdSuccessGrammar,
    momentPhase,
    quantStep,
    queueMomentEdgePlate,
    peakMarkSink,
    releaseSuccessGrammar,
    pixelLine,
    resolveMomentAnchor,
    snap,
    wakeV,
} from './EffectStamps.js';
import { drawPixelFlame, fillPixelEllipse } from './PixelShapes.js';
import { PENNANT_REST_FRAME, currentPennantTime, currentPennantWind, drawBranchPennon, drawPennant, pennantFrame } from './PixelPennant.js';

import { anchorLampStrip, drawHullFallback, drawHullLamps, hullGeometry, hullHeadingDirection, hullLampPoints, hullLampStrip, hullMasthead, hullRecords, hullStrip, liveryStrip, rollFrameIndex } from './HarborHulls.js';
import { normalizeLightSource } from './LightSourceRegistry.js';

import {
    BERTHS,
    HARBOR_PIER_DECKS,
    COAST_ANCHORAGE_SLOTS,
    HARBOR_GROUND_PX_PER_TILE,
    MAX_HARBOR_SHIP_PACK_SIZE,
    QUAY_GROUPS,
    buildDockLayoutFresh,
    buildDockSquadLayout,
    clamp,
    composeStorageTransferTiles,
    composeWaterPath,
    composeWaterRouteTiles,
    harborHullClearance,
    harborSailDistance,
    harborShipCollisionRadius,
    harborShipTier,
    isCommitLagoonZone,
    harborWaterField,
    repoAnchorageSlot,
    routeGraphMetadata,
    routeSeaLength,
    routeSeaTile,
    setHarborWaterMask,
    stableHash,
    toTile,
    toWorld,
} from './HarborLayout.js';
import {
    BOOMERANG_IN_MS,
    BOOMERANG_OUT_MS,
    CANCEL_RETURN_MS,
    DEPARTURE_MS,
    EXIT_FADE_MS,
    FINALE_EFFECT_MS,
    FORCE_DEPARTURE_MS,
    HARBOR_CLEAN_LABEL_CACHE_LIMIT,
    INBOUND_DURATION_MS,
    MAX_HARBOR_BATCHES,
    MAX_HARBOR_COMMIT_REPLAY_FLOORS,
    MAX_HARBOR_EVENT_TOMBSTONES,
    MAX_HARBOR_OVERFLOW_DOCK_COUNTS,
    MAX_HARBOR_PUSH_EVENTS,
    MAX_HARBOR_REPO_QUAYS,
    MAX_HARBOR_SEEN_EVENT_IDS,
    MAX_HARBOR_SHIPS,
    RELEASE_CONVOY_MIN_SHIPS,
    SCREEN_SUMMARY_MS,
    SCUTTLE_MS,
    assignedQuayIndex,
    cachedCleanCommitSubject,
    cleanCommitLabelCacheSize,
    cloneState,
    gitEventStatusLabel,
    harborOverflowDockCount,
    harborStateHasTimedLifecycle,
    pullRequestShipLabel,
    reduceHarborTrafficState,
} from './HarborState.js';

export { normalizeGitEvent } from '../shared/GitEventIdentity.js';
export { reduceHarborTrafficState, snapshotHarborTrafficState } from './HarborState.js';
export { COMMIT_LAGOON_SQUAD_ANCHORAGES, clearOfWorldTreeIslet, composeWaterRouteTiles } from './HarborLayout.js';

const STORAGE_TRANSFER_MS = 9000;
const STORAGE_TRANSFER_MAX_MS = 40000;
// A docked fleet holds its formation this long after a ship casts off.
const FLEET_HOLD_MS = 5000;
const STORAGE_TRANSFER_STAGGER_MS = 220;

// 3.6 / 6.5 — the untethered broken-rope chevron: two polylines in texels
// from the flag pole's top (x toward the cloth side), a gap between them.
const UNTETHERED_CHEVRON = Object.freeze([
    Object.freeze([[-4, 4], [1, 0], [3, 2]]),
    Object.freeze([[6, 5], [9, 1], [13, 4]]),
]);

// 4.17 / 6.5 — the heraldry shield silhouette as whole-texel row runs
// `[y, x0, x1)` about a centre column: straight sides to the shoulder at
// 72 % of the height, then a stepped taper to a 2-texel point.
const shieldRunCache = new Map();

function shieldRuns(w, h) {
    const key = `${w}x${h}`;
    let runs = shieldRunCache.get(key);
    if (runs) return runs;
    const left = -Math.round(w / 2);
    const right = left + w;
    const shoulder = Math.round(h * 0.72);
    runs = [];
    for (let y = 0; y < h; y++) {
        if (y < shoulder) {
            runs.push([y, left, right]);
            continue;
        }
        const k = (y - shoulder + 1) / (h - shoulder + 1);
        const x0 = Math.min(-1, Math.round(left * (1 - k)));
        const x1 = Math.max(1, Math.round(right * (1 - k)));
        runs.push([y, x0, x1]);
    }
    if (shieldRunCache.size > 32) shieldRunCache.clear();
    shieldRunCache.set(key, runs = Object.freeze(runs.map((run) => Object.freeze(run))));
    return runs;
}

const MAX_REPO_FIRST_SEEN = 512;
const HARBOR_MAINTENANCE_INTERVAL_MS = 10000;
const HARBOR_CRATE_TTL_MS = 30000;
const MAX_LABEL_CHARS = 30;
const HARBOR_FINALE_TILE = { tileX: 38.2, tileY: 6.6 };

// 6.5 — failed-push bracket: a 120 ms convergence, one cream flash frame, a
// three-step shake of the stamp only, then a static red broken bracket for as
// long as the failure stands. Replays older than the window arrive static.
// V8 — the residue is the thread's window (actor → slip, while both are in
// view); the bracket itself draws the same static frame through it and after.
const FAILURE_BRACKET = defineMoment('medium', { anticipation: 120, peak: 80, follow: 180, residue: 6000 });
const FAILURE_BRACKET_FRESH_MS = 15000;
const FAILURE_BRACKET_MAX = 4;
const FAILURE_SHAKE = Object.freeze([2, -2, 1]);
const HARBOR_SUMMARY_TILE = { tileX: 35.2, tileY: 21.5 };
const CAST_OFF_MS = 1500;
const MIST_FADE_MS = 800;
const INBOUND_SHIP_CLASS_KEY = 'cutter';
const PR_PENNANT_CLOTH = '#e8dcb8';
const PR_PENNANT_RIM = '#3a2c1a';
const NO_SINK = Object.freeze({ progress: 0, px: 0, alphaScale: 1, force: false });

// The repo flag's staff foot laps this many texels down the mast top.
const FLAG_MAST_OVERLAP = 3;

// 8.2 — a verified release sails from the pier (SM-3). The release's own
// sloop (the existing sloop hull: one more ship record) appears at the
// Harbor's release slip on a 4×4 Bayer order in four steps (whole texels of
// the hull and its reflection, never translucent; bare-masted; the crown
// waits for it), then follows the release crown's moment clock
// (ChronicleMonuments): a gold pennant of the 6.5 family climbs the mast in
// three held steps through the anticipation, the sail outline takes the one
// cream peak frame, the sloop casts off bow-first (screen-right, the way
// every hull frame faces) along the channel route through the follow with
// two wake chevrons astern (its V wake starts once they are spent), and sails
// on past the buoys to open water, dissolving on the same order over its last
// stretch. Reduced motion ties it up at the slip at once for the static crown
// and clears it when the moment ends.
// Pennant cloth texels below its flown position per hoist step (3 = flown).
const RELEASE_SAIL_HOIST_DROP = Object.freeze([24, 16, 8, 0]);

// World px per ms at cruise, reached over the crown's 1200 ms follow.
const RELEASE_SAIL_CRUISE = 0.036;
const RELEASE_SAIL_ACCEL_MS = 1200;
const RELEASE_SAIL_FADE_PX = 160;

// The arrival: 1/4, 2/4, 3/4 and all of the hull's texels, each held this
// long.
const RELEASE_SAIL_ARRIVE_STEP_MS = 150;
const RELEASE_SAIL_LIMIT = 2;
const RELEASE_SAIL_BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

// The release slip: open water just outside the Harbor's South pier, and
// the one leg out of it along the pier (bow-first, about 27° below
// screen-right, the SE view) where the sloop joins the channel route every
// departure takes.
const RELEASE_SAIL_SLIP = Object.freeze({ tileX: 32.3, tileY: 21.95 });
const RELEASE_SAIL_OUT = Object.freeze({ tileX: 34.9, tileY: 21.95 });

// The chevrons: 7-step V arms two texels thick (they must read over the sea
// glitter), the first 3 texels astern of the stern, the
// second a further 8 back; foam and crest are the hull wake's tones.
const RELEASE_SAIL_CHEVRON_LENGTH = 7;
const RELEASE_SAIL_CHEVRON_GAP = 8;
const RELEASE_SAIL_FOAM = ART_RAMPS.shallowWater[2];
const RELEASE_SAIL_CREST = '#b5cabf';

// The rejected caution beat: one 2 Hz step of four is the lit tone (V4).
const CAUTION_BEAT_STEP_MS = 500;
const UNTETHERED_MIN_COMMITS = 2;
const UNTETHERED_HOLD_MS = 5 * 60 * 1000;
const HARBOR_BEACON_BUOY_TILE = { tileX: 26.0, tileY: 6.0 };
const REPO_DOCK_SHIP_SORT_OFFSET = 8;

// 3.8 — hulls draw at scale 1 from their roll strips (HarborHulls.js). The
// label lift is the hull's height above its waterline (world px; the strip
// anchor overrides it once loaded) and the flag offsets sit the repo flag at
// the mast head of the scale-1 hull.
const HARBOR_SHIP_CLASSES = Object.freeze([
    { key: 'flagship', spriteId: 'prop.harborShip.flagship', minCommits: 10, wakeScale: 2.38, cargoRows: 7, mastCount: 5, labelLift: 84, flagOffsetX: 8, flagOffsetY: 50, badge: '10+' },
    { key: 'dreadnought', spriteId: 'prop.harborShip.dreadnought', minCommits: 8, wakeScale: 2.12, cargoRows: 7, mastCount: 5, labelLift: 74, flagOffsetX: 8, flagOffsetY: 42, badge: '8+' },
    { key: 'galleon', spriteId: 'prop.harborShip.galleon', minCommits: 6, wakeScale: 1.86, cargoRows: 6, mastCount: 4, labelLift: 62, flagOffsetX: 6, flagOffsetY: 30, badge: '6+' },
    { key: 'brigantine', spriteId: 'prop.harborShip.brigantine', minCommits: 4, wakeScale: 1.56, cargoRows: 5, mastCount: 3, labelLift: 63, flagOffsetX: 6, flagOffsetY: 30, badge: '4+' },
    { key: 'sloop', spriteId: 'prop.harborShip.sloop', minCommits: 3, wakeScale: 1.32, cargoRows: 3, mastCount: 2, labelLift: 59, flagOffsetX: 4, flagOffsetY: 26, badge: '3+' },
    { key: 'cutter', spriteId: 'prop.harborShip.cutter', minCommits: 2, wakeScale: 1.15, cargoRows: 1, mastCount: 1, labelLift: 45, flagOffsetX: 2, flagOffsetY: 12, badge: '2+' },
    { key: 'skiff', spriteId: 'prop.harborShip.skiff', minCommits: 1, wakeScale: 0.88, cargoRows: 0, mastCount: 1, labelLift: 38, flagOffsetX: 0, flagOffsetY: 6, badge: '' },
]);

const RELEASE_SAIL_CLASS = Object.freeze({
    ...HARBOR_SHIP_CLASSES.find(item => item.key === 'sloop'),
    packSize: 1,
    trim: 0,
});

// Stack hull per titan tier, chosen by the pack's exact commit count.
const HARBOR_SHIP_STACK_CLASSES = Object.freeze([
    { key: 'stack50', spriteId: 'prop.harborShip.stack50', minCommits: 50, wakeScale: 2.80, cargoRows: 10, mastCount: 7, labelLift: 154, flagOffsetX: 40, flagOffsetY: 118 },
    { key: 'stack40', spriteId: 'prop.harborShip.stack40', minCommits: 40, wakeScale: 2.60, cargoRows: 9, mastCount: 6, labelLift: 145, flagOffsetX: 30, flagOffsetY: 110 },
    { key: 'stack30', spriteId: 'prop.harborShip.stack30', minCommits: 30, wakeScale: 2.38, cargoRows: 8, mastCount: 6, labelLift: 119, flagOffsetX: 28, flagOffsetY: 86 },
    { key: 'stack20', spriteId: 'prop.harborShip.stack20', minCommits: 20, wakeScale: 2.12, cargoRows: 7, mastCount: 5, labelLift: 106, flagOffsetX: 24, flagOffsetY: 74 },
    { key: 'stack10', spriteId: 'prop.harborShip.stack10', minCommits: 10, wakeScale: 1.72, cargoRows: 5, mastCount: 4, labelLift: 80, flagOffsetX: 18, flagOffsetY: 48 },
    { key: 'stack5', spriteId: 'prop.harborShip.stack5', minCommits: 1, wakeScale: 1.30, cargoRows: 3, mastCount: 3, labelLift: 65, flagOffsetX: 14, flagOffsetY: 34 },
]);

// S9 — the Harbor jetty's tie-up posts (the timber deck south of the master's
// office), one per quay group, where a failed push with no docked ship is
// bracketed.
const HARBOR_JETTY_SLIPS = Object.freeze([
    Object.freeze({ tileX: 32.4, tileY: 20.0 }),
    Object.freeze({ tileX: 31.7, tileY: 20.3 }),
    Object.freeze({ tileX: 32.9, tileY: 19.6 }),
    Object.freeze({ tileX: 31.1, tileY: 20.6 }),
]);

const REPO_ANCHORAGE_OVERFLOW_TILE = Object.freeze({ tileX: 17.2, tileY: 11.4 });

// The quay apron under the Harbor crane, where its one cargo pile stands.
const HARBOR_CRATE_QUAY = Object.freeze({ tileX: 30.4, tileY: 20.4 });

// An agent's repo stays "home" (a lit anchorage) this long after its last update.
const REPO_ANCHORAGE_ACTIVE_MS = 5 * 60 * 1000;

// Harbor marks (flags, plates, buoys, labels) and wildlife stay overlay-safe:
// their routes stay in open water and they are marks, not matter. Wildlife
// and waterfalls share the same resolved category so the existing registry
// can replay every water/air detail above the direct GPU island.
const OVERLAY_SAFE_SCENE_ITEMS = [];

// 3.8 / M23 — the hulls themselves are matter: on the resident path they are
// V9 records (painter depth, grade, lamp light, footprint occlusion) with a
// `reflect` twin and a V-wake stamp in the ground band; elsewhere the Canvas
// fallback draws the same whole-texel frames (graded on the overlay).
export const HARBOR_HULL_SCENE_CATEGORY = Object.freeze({
    id: 'harbor-hulls',
    sortBand: 40,
    // A hull behind the Harbor (a split building on its piers) sorts before
    // the back half, so the whole building hides it.
    behindSplitBuildings: true,
    enumerate({ renderer } = {}) {
        return renderer?.harborTraffic?.enumerateHullDrawables?.() ?? [];
    },
    emitSceneCommands(item) {
        return item?.records?.length ? item.records : null;
    },
    canvasFallback(ctx, item, zoom, context = {}) {
        if (!item?.pose) return;
        const renderer = context.renderer;
        drawHullFallback(ctx, item.pose, {
            ungradedOverlay: context.ungradedOverlay === true,
            lightGrade: renderer?._lastAtmosphere?.lightGrade || null,
        });
    },
    unsupported: 'overlay-safe',
    overlayBand: 39,
});

export const HARBOR_TRAFFIC_SCENE_CATEGORY = Object.freeze({
    id: 'harbor-traffic',
    sortBand: 40,
    enumerate({ renderer } = {}) {
        const items = OVERLAY_SAFE_SCENE_ITEMS;
        items.length = 0;
        const wildlifeItems = WILDLIFE_SCENE_CATEGORY.enumerate({ renderer });
        for (let index = 0; index < wildlifeItems.length; index++) items.push(wildlifeItems[index]);
        const harborItems = renderer?.harborTraffic?.enumerateDrawables?.() ?? [];
        for (let index = 0; index < harborItems.length; index++) items.push(harborItems[index]);
        renderer?.harborTraffic?.beginPlateFrame?.(renderer?.camera?.zoom);
        return items;
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        if (drawable?.sourceCategory === WILDLIFE_SCENE_CATEGORY.id) {
            WILDLIFE_SCENE_CATEGORY.canvasFallback(ctx, drawable, zoom, context);
            return;
        }
        const harborTraffic = context.renderer?.harborTraffic || context.harborTraffic;
        harborTraffic?.draw?.(ctx, drawable, zoom);
    },
    unsupported: 'overlay-safe',
    overlayBand: 40,
});

const PUSH_STATUS_STYLE = {
    success: {
        label: 'Push landed',
        shortLabel: 'landed',
        accent: '#6cdb94',
        panel: 'rgba(22, 54, 43, 0.92)',
        glow: 'rgba(108, 219, 148, 0.58)',
    },
    failed: {
        label: 'Push failed',
        shortLabel: 'failed',
        accent: '#f07668',
        panel: 'rgba(62, 31, 34, 0.93)',
        glow: 'rgba(240, 87, 76, 0.55)',
    },
    rejected: {
        label: 'Push rejected',
        shortLabel: 'rejected',
        accent: '#ffd34a',
        panel: 'rgba(60, 50, 22, 0.93)',
        glow: 'rgba(255, 211, 74, 0.55)',
        panelBorder: '#ff755d',
    },
    // 5.11 — cancelled is distinct from failed: muted grey, no red effects.
    cancelled: {
        label: 'Push cancelled',
        shortLabel: 'cancelled',
        accent: '#6c757d',
        panel: 'rgba(40, 44, 48, 0.92)',
        glow: 'rgba(108, 117, 125, 0.45)',
    },
    unknown: {
        label: 'Push sent',
        shortLabel: 'sent',
        accent: '#f6cf60',
        panel: 'rgba(58, 48, 27, 0.92)',
        glow: 'rgba(246, 207, 96, 0.52)',
    },
};

function isHarborCrateTool(agent) {
    const text = `${agent?.currentTool || ''} ${agent?.currentToolInput || ''} ${agent?.lastToolInput || ''}`.toLowerCase();
    return /\bgit\s+(status|diff|show)\b/.test(text);
}

function parseColorRgba(value) {
    const text = String(value || '').trim();
    const hex = text.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    const match = text.match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.length < 3) return null;
    return {
        r: clamp(parts[0] || 0, 0, 255),
        g: clamp(parts[1] || 0, 0, 255),
        b: clamp(parts[2] || 0, 0, 255),
        a: Number.isFinite(parts[3]) ? clamp(parts[3], 0, 1) : 1,
    };
}

// #3 — Grade authority. Lerp a color string (hex or rgba) toward the active
// `grade.worldTint`, preserving the source alpha, so harbor anchorage glows
// pick up the time-of-day cast. Pure color transform with no time component —
// identical under reduced motion. Returns the input unchanged when it can't
// parse, or when no grade is supplied.
function gradeColorString(value, grade) {
    const base = parseColorRgba(value);
    const tint = parseColorRgba(grade?.worldTint);
    if (!base || !tint) return value;
    const w = clamp(tint.a, 0, 1);
    if (w <= 0) return value;
    const r = Math.round(base.r + (tint.r - base.r) * w);
    const g = Math.round(base.g + (tint.g - base.g) * w);
    const b = Math.round(base.b + (tint.b - base.b) * w);
    return `rgba(${r}, ${g}, ${b}, ${base.a})`;
}

// Repo profiles resolve live: RepoColor's visible-repo registry can move a
// repo's pennant when the on-screen set changes, so a private cache would
// keep a stale slot after a repo leaves and returns.
function trafficProfile(project, branch = '') {
    return repoBranchProfile(project, normalizeRepoBranch(branch));
}

function trafficShortName(project, branch = '') {
    return trafficProfile(project, branch).shortName;
}

function trafficLabel(project, branch = '', maxChars = 26) {
    const normalizedBranch = normalizeRepoBranch(branch);
    const repo = shortGitLabel(repoDisplayName(project), maxChars, '…');
    if (!normalizedBranch) return repo;
    return `${repo}/${shortGitLabel(normalizedBranch, 14, '…')}`;
}

// 8.2 — the release sloop's partial reveal (arrival and last stretch): a copy
// of its hull strip keeping only the texels whose 4×4 Bayer order is under
// `level` (1/4, 2/4, 3/4), so the hull and its reflection come and go in
// whole palette texels at full strength instead of a translucent ghost.
// Cached per strip image and level; `liveryKey` gives each its own texture.
const _revealStrips = new WeakMap();

function releaseRevealStrip(strip, level) {
    let levels = _revealStrips.get(strip.image);
    if (!levels) {
        levels = new Map();
        _revealStrips.set(strip.image, levels);
    }
    const keep = Math.round(level * 16);
    if (levels.has(keep)) return levels.get(keep);
    let revealed = strip;
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = strip.image.width;
        canvas.height = strip.image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(strip.image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px = data.data;
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                if (RELEASE_SAIL_BAYER4[((y & 3) << 2) | (x & 3)] >= keep) px[(y * canvas.width + x) * 4 + 3] = 0;
            }
        }
        ctx.putImageData(data, 0, 0);
        revealed = { ...strip, image: canvas, liveryKey: `${strip.liveryKey || strip.key || strip.spriteId}|reveal${keep}` };
    }
    levels.set(keep, revealed);
    return revealed;
}

// 8.2 — the release sloop's one cream peak frame: a 1-texel rim around its
// sails (every texel above the deck that is not cloth but touches the pale,
// unsaturated cloth), per roll frame of the hull strip, in the peak cream.
// The cloth is cream already, so the rim sits outside it. Cached per strip
// image and frame as `{ canvas, runs }`: the rim stamp, and the same texels
// as row runs `[x, y, width, ...]` (10.2 hands them to the GPU mark pass).
const _sailOutlines = new WeakMap();

function releaseSailOutline(strip, frame) {
    let frames = _sailOutlines.get(strip.image);
    if (!frames) {
        frames = new Map();
        _sailOutlines.set(strip.image, frames);
    }
    if (frames.has(frame)) return frames.get(frame);
    let outline = null;
    if (typeof document !== 'undefined') {
        const w = strip.frameWidth;
        const h = strip.frameHeight;
        const source = document.createElement('canvas');
        source.width = w;
        source.height = h;
        const sctx = source.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(strip.image, ((strip.frameOffset || 0) + frame) * w, 0, w, h, 0, 0, w, h);
        const data = sctx.getImageData(0, 0, w, h).data;
        const cloth = new Uint8Array(w * h);
        // The deck and waterline rows (the lip is pale too) stay out.
        const lastRow = Math.max(0, strip.anchorY - 3);
        for (let y = 0; y < lastRow; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (data[i + 3] < 128) continue;
                const lo = Math.min(data[i], data[i + 1], data[i + 2]);
                const hi = Math.max(data[i], data[i + 1], data[i + 2]);
                if (lo >= 0x80 && hi - lo <= 70) cloth[y * w + x] = 1;
            }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = PEAK;
        const runs = [];
        const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && cloth[y * w + x] === 1;
        for (let y = 0; y < lastRow; y++) {
            for (let x = 0; x < w; x++) {
                if (cloth[y * w + x]) continue;
                if (!at(x - 1, y) && !at(x + 1, y) && !at(x, y - 1) && !at(x, y + 1)) continue;
                ctx.fillRect(x, y, 1, 1);
                const last = runs.length - 3;
                if (last >= 0 && runs[last + 1] === y && runs[last] + runs[last + 2] === x) runs[last + 2]++;
                else runs.push(x, y, 1);
            }
        }
        outline = { canvas, runs };
    }
    frames.set(frame, outline);
    return outline;
}

function pointAlongPath(points, progress) {
    if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return points[0];

    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        lengths.push(length);
        total += length;
    }
    if (total <= 0) return points[points.length - 1];

    let remaining = Math.max(0, Math.min(1, progress)) * total;
    for (let i = 1; i < points.length; i++) {
        const length = lengths[i - 1];
        if (remaining <= length || i === points.length - 1) {
            const a = points[i - 1];
            const b = points[i];
            const t = length <= 0 ? 1 : remaining / length;
            return {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
        }
        remaining -= length;
    }

    return points[points.length - 1];
}

// ─── Sailing paths (Phase 3) ─────────────────────────────────────────────────
//
// A lane-graph tile path (HarborLayout.composeWaterPath: cached and frozen,
// so its identity keys these caches) as a world polyline with cumulative
// ground length in tiles, so speeds read true on the ground whatever the
// leg's screen slope.
const SAIL_TAIL_TILES = 0.4;
// The last stretch of a departure (tiles) over which the hull sinks below
// the horizon; an arrival rises over the same stretch.
const HORIZON_SINK_TILES = 3.6;
const FORCE_SAIL_TILES_PER_S = 0.8;
const CONVOY_ECHELON_TILES = 0.32;
const BOOMERANG_REACH_TILES = 6;
const CANCEL_REACH_TILES = 2.6;
const _sailPaths = new WeakMap();
const _reversedTiles = new WeakMap();

function sailPath(tiles) {
    let path = _sailPaths.get(tiles);
    if (path) return path;
    const points = tiles.map(point => toWorld(point.tileX, point.tileY));
    const cum = [0];
    for (let i = 1; i < tiles.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(tiles[i].tileX - tiles[i - 1].tileX, tiles[i].tileY - tiles[i - 1].tileY));
    }
    path = { tiles, points, cum, length: cum[cum.length - 1] || 0, seaLength: routeSeaLength(tiles) };
    if (Object.isFrozen(tiles)) _sailPaths.set(tiles, path);
    return path;
}

function sailPathSegment(path, distance) {
    const { cum } = path;
    const d = clamp(distance, 0, path.length);
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= d) lo = mid;
        else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    return { lo, hi, t: span > 0 ? (d - cum[lo]) / span : 0 };
}

// World point `distance` ground tiles along a sail path (clamped to it).
function sampleSailPath(path, distance) {
    if (path.points.length < 2) return path.points[0] || { x: 0, y: 0 };
    const { lo, hi, t } = sailPathSegment(path, distance);
    const a = path.points[lo];
    const b = path.points[hi];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function sailPathTile(path, distance) {
    if (path.tiles.length < 2) return path.tiles[0];
    const { lo, hi, t } = sailPathSegment(path, distance);
    const a = path.tiles[lo];
    const b = path.tiles[hi];
    return { tileX: a.tileX + (b.tileX - a.tileX) * t, tileY: a.tileY + (b.tileY - a.tileY) * t };
}

// Render motion (Phase 3.1). A target jump faster than MOTION_JUMP_SPEED
// (no hull sails that fast) becomes an offset that springs home, critically
// damped at MOTION_OMEGA and capped at MOTION_MAX_SPEED (about 5 px a frame
// at 30 fps); a jump past MOTION_SNAP_PX, or a gap past MOTION_RESYNC_S (a
// hidden tab), lands at once.
const MOTION_OMEGA = 2.4;
const MOTION_MAX_SPEED = 150;
const MOTION_JUMP_PX = 3;
const MOTION_JUMP_SPEED = 160;
const MOTION_SNAP_PX = 520;
const MOTION_RESYNC_S = 1.5;
const MOTION_FORGET_MS = 4000;
const HEADING_SMOOTH_S = 0.25;
// A moored hull whose slot moves farther than this (tiles) sails there by
// water (a relocation) instead of gliding straight over whatever lies
// between, at RELOCATE_TILES_PER_S; a sortie that starts this far from where
// the hull is drawn starts from where it is drawn.
const RELOCATE_TILES = 1.25;
const RELOCATE_TILES_PER_S = 1.1;
// A moored hull gliding faster than this faces its glide; one still for
// WEATHERVANE_MS (plus up to WEATHERVANE_STAGGER_MS by hash, so a fleet
// swings one hull at a time) lies bow into the wind.
const MOORED_HEADING_SPEED = 14;
const WEATHERVANE_MS = 2500;
const WEATHERVANE_STAGGER_MS = 4000;
// Phase 3.7 — a new commit slides off the nearest slipway: the last
// LAUNCH_RUN_TILES of the water path from it, fading in over LAUNCH_FADE_MS.
const LAUNCH_WINDOW_MS = 6000;
const LAUNCH_RUN_TILES = 2.4;
const LAUNCH_SPEED = 120;
const LAUNCH_FADE_MS = 700;
const PACK_GHOST_MS = 1500;
// 5.3 — ship lamp light: warm C1 lantern core, a small pool, dimmer than
// a building window, for at most this many hulls (leads, then the largest).
const HARBOR_LAMP_LIGHT_CAP = 12;
const HARBOR_LAMP_COLOR = '#ffcf7a';
const HARBOR_LAMP_RADIUS = 18;
const HARBOR_LAMP_INTENSITY = 0.9;
const HARBOR_LAMP_HALO = Object.freeze([3, 5]);
const LAMP_SHIMMER_STEP_MS = 250;
const LAMP_BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
// World px a Harbor pier deck stands above the water (Track C's surface
// channel), where a pier berth's marker post stands.
const PIER_DECK_LIFT_PX = 12;
const MARKER_FADE_MS = 600;
const PACK_GHOST_REACH_PX = 110;
const HARBOR_SLIPWAY = Object.freeze({ tileX: 33.8, tileY: 22.0 });
const LAGOON_SLIPWAY = Object.freeze({ tileX: 17.2, tileY: 10.7 });
const LAGOON_EAST_TILE_X = 23;
// Swing at anchor: ±2 px across, ±1 px along, periods by hash.
const SWING_X_PX = 2;
const SWING_Y_PX = 1;

function tileDistance(a, b) {
    return Math.hypot(a.tileX - b.tileX, a.tileY - b.tileY);
}

// Opacity on the horizon stretch: full until 60 % of the way under, then out.
function horizonAlpha(progress) {
    const p = Number(progress) || 0;
    return p <= 0.6 ? 1 : clamp(1 - (p - 0.6) / 0.4, 0, 1);
}

function springOffset(m, dt) {
    let left = dt;
    const k = MOTION_OMEGA * MOTION_OMEGA;
    const c = 2 * MOTION_OMEGA;
    while (left > 1e-6) {
        const h = Math.min(left, 1 / 60);
        left -= h;
        m.ovx += (-k * m.ox - c * m.ovx) * h;
        m.ovy += (-k * m.oy - c * m.ovy) * h;
        const speed = Math.hypot(m.ovx, m.ovy);
        if (speed > MOTION_MAX_SPEED) {
            m.ovx *= MOTION_MAX_SPEED / speed;
            m.ovy *= MOTION_MAX_SPEED / speed;
        }
        m.ox += m.ovx * h;
        m.oy += m.ovy * h;
    }
    if (Math.hypot(m.ox, m.oy) < 0.05 && Math.hypot(m.ovx, m.ovy) < 0.5) {
        m.ox = 0;
        m.oy = 0;
        m.ovx = 0;
        m.ovy = 0;
    }
}

function reversedTiles(tiles) {
    let reversed = _reversedTiles.get(tiles);
    if (!reversed) {
        reversed = Object.freeze([...tiles].reverse());
        if (Object.isFrozen(tiles)) _reversedTiles.set(tiles, reversed);
    }
    return reversed;
}

function commitIdFragment(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    const hash = text.match(/\b[0-9a-f]{7,40}\b/i);
    if (hash) return hash[0].slice(0, 7).toLowerCase();
    const compact = text.replace(/^commit[:\s-]*/i, '').replace(/\s+/g, '');
    return compact && compact.length <= 16 ? compact : '';
}

function commitPennantLabel(ship = {}) {
    // PR cutters carry pull identity, never a commit hash or source event ID.
    if (ship.prShip) return pullRequestShipLabel(ship);
    const visualPackSize = Number(ship.visualPackSize);
    if (Number.isFinite(visualPackSize) && visualPackSize > 1) {
        return `${Math.round(visualPackSize)}x`;
    }
    const eventIds = Array.isArray(ship.eventIds) ? ship.eventIds : [];
    const candidates = [
        ship.sha,
        ship.commit,
        ship.hash,
        ship.commitSha,
        ship.revision,
        ship.commandHash,
        ...eventIds,
        ship.sourceId,
        ship.id,
    ];

    for (const candidate of candidates) {
        const label = commitIdFragment(candidate);
        if (label) return label;
    }

    return 'commit';
}

// One row per repo with docked commits or a failed push. A failed push with
// nothing docked (no batch) still makes a row, so `harbor:updated` reports it;
// `agentId` is the agent whose failure the Harbor's bracket marks (its docked
// failed ship first, else its latest failed push), the key its cue is scored by.
// The row's standing failure is its newest one: when, which word
// (failed / rejected) and the first stderr line the server kept.
function noteFailure(row, at, status, reason) {
    if (!(at > 0) || at < row.latestFailureAt) return;
    row.latestFailureAt = at;
    row.failureStatus = status === 'rejected' ? 'rejected' : 'failed';
    row.failureReason = reason ? String(reason) : row.failureReason || '';
}

export function pendingRepoSummariesFromDockSummaries(summaries, pushEvents = []) {
    const byRepo = new Map();
    const rowFor = (project, branch, profile) => byRepo.get(profile.key) || {
        project,
        branch: branch || '',
        repoName: trafficLabel(project, branch),
        shortName: profile.shortName || trafficLabel(project, branch, 18),
        profile,
        pendingCommits: 0,
        failedPushes: 0,
        agentId: null,
        latestFailureAt: 0,
        failureStatus: '',
        failureReason: '',
        worktree: null,
        latestEventTime: 0,
        oldestCommitTime: 0,
        waitingZone: 'harbor',
        storageCommits: 0,
    };
    for (const summary of summaries?.values?.() || []) {
        const count = Number(summary.count) || 0;
        if (count <= 0) continue;
        const profile = summary.profile || trafficProfile(summary.project, summary.branch);
        const existing = rowFor(summary.project, summary.branch, profile);
        existing.pendingCommits += count;
        existing.failedPushes += Number(summary.failedCount) || 0;
        existing.agentId ??= summary.failedAgentId ?? null;
        noteFailure(existing, Number(summary.failedAt) || 0, summary.failureStatus, summary.failureReason);
        existing.worktree ||= summary.worktree || null;
        existing.latestEventTime = Math.max(existing.latestEventTime, Number(summary.latestEventTime) || 0);
        const earliestEventTime = Number(summary.earliestEventTime) || 0;
        if (earliestEventTime > 0) {
            existing.oldestCommitTime = existing.oldestCommitTime > 0
                ? Math.min(existing.oldestCommitTime, earliestEventTime)
                : earliestEventTime;
        }
        if (isCommitLagoonZone(summary.waitingZone)) {
            existing.waitingZone = 'commit-lagoon';
            existing.storageCommits += count;
        }
        byRepo.set(profile.key, existing);
    }
    // U-P5 — a failure stands until the lane's next successful push.
    const landedAt = new Map();
    const pushList = [...(pushEvents || [])];
    for (const push of pushList) {
        if ((push?.status || 'unknown') !== 'success' || !push.project) continue;
        const lane = `${push.project}\x1f${normalizeRepoBranch(push.branch)}`;
        landedAt.set(lane, Math.max(landedAt.get(lane) || 0, Number(push.eventTime) || 0));
    }
    const pushAgent = new Map();
    for (const push of pushList) {
        const status = push?.status || 'unknown';
        if ((status !== 'failed' && status !== 'rejected') || push.batchId || !push.project) continue;
        const branch = push.branch || '';
        const eventTime = Number(push.eventTime) || 0;
        if ((landedAt.get(`${push.project}\x1f${normalizeRepoBranch(branch)}`) || 0) > eventTime) continue;
        const profile = trafficProfile(push.project, branch);
        const existing = rowFor(push.project, branch, profile);
        existing.failedPushes += 1;
        noteFailure(existing, eventTime, status, push.reason);
        existing.latestEventTime = Math.max(existing.latestEventTime, eventTime);
        const latest = pushAgent.get(profile.key);
        if (push.agentId && (!latest || eventTime >= latest.eventTime)) {
            pushAgent.set(profile.key, { agentId: push.agentId, eventTime });
        }
        byRepo.set(profile.key, existing);
    }
    for (const [key, { agentId }] of pushAgent) {
        const row = byRepo.get(key);
        row.agentId ??= agentId;
    }
    return [...byRepo.values()]
        .sort((a, b) => (b.failedPushes - a.failedPushes)
            || (b.pendingCommits - a.pendingCommits)
            || (b.latestEventTime - a.latestEventTime)
            || a.repoName.localeCompare(b.repoName));
}

function harborShipStackClass(packSize) {
    const count = Math.max(1, Math.min(MAX_HARBOR_SHIP_PACK_SIZE, Math.round(Number(packSize) || 1)));
    const variant = HARBOR_SHIP_STACK_CLASSES.find(item => count >= item.minCommits);
    if (!variant) return null;
    return {
        ...variant,
        packSize: count,
        trim: 0,
        badge: `${count}x`,
    };
}

function harborShipClass(ship = {}) {
    // 8.2 — the release sloop is always the one sloop hull.
    if (ship.releaseSail) return RELEASE_SAIL_CLASS;
    // 3.2 — inbound ships use a small fixed class so the inbound ramp is visually consistent.
    if (ship.isInbound) {
        const variant = inboundShipClass();
        return {
            ...variant,
            packSize: 1,
            trim: 0,
            scale: variant.scale,
            // W7.9 — a PR cutter carries no commit count: no `2+` badge.
            ...(ship.prShip ? { badge: '' } : null),
        };
    }
    // Stack sprites are reserved for true visual packs — one drawable standing
    // in for hidden overflow ships. A fleet lead whose flock is individually
    // visible keeps a commit-count class hull instead, so the harbor never
    // double-counts (e.g. 12 skiffs plus a "12x" stack). HarborLayout picks
    // the tier, so formations and hulls always agree.
    const tier = harborShipTier(ship);
    if (tier.stack) return harborShipStackClass(tier.packSize);
    const packSize = tier.packSize;
    const variant = HARBOR_SHIP_CLASSES.find(item => item.key === tier.key)
        || HARBOR_SHIP_CLASSES[HARBOR_SHIP_CLASSES.length - 1];
    const trim = stableHash(`${ship.project || ''}:${ship.branch || ''}:${ship.id || ''}:harbor-ship-trim`) % 4;
    const skiffScale = [0.88, 0.94, 0.90, 0.86][trim] || variant.scale;
    return {
        ...variant,
        packSize,
        trim,
        scale: variant.key === 'skiff' ? skiffScale : variant.scale,
    };
}

// 3.2 — inbound ship class lookup
function inboundShipClass() {
    return HARBOR_SHIP_CLASSES.find(item => item.key === INBOUND_SHIP_CLASS_KEY)
        || HARBOR_SHIP_CLASSES[HARBOR_SHIP_CLASSES.length - 1];
}

function easedDeparture(progress) {
    const t = Math.max(0, Math.min(1, progress));
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function rawGitEventProject(event, agent) {
    return String(event?.project
        || event?.projectPath
        || event?.repository
        || event?.repo
        || event?.workspace
        || agent?.projectPath
        || agent?.teamName
        || agent?.project
        || 'unknown');
}

function canonicalRawGitEventKey(event, agent) {
    const type = gitEventKind(event);
    if (!type) return '';
    const project = rawGitEventProject(event, agent);
    const sha = String(event.sha || event.commit || event.hash || event.commitSha || event.revision || '').trim().toLowerCase();
    const explicitId = event.id || event.eventId || event.uuid || event.key || event.sourceId || '';
    if (explicitId) {
        const discriminator = sha
            || event.commandHash
            || `${event.timestamp || event.time || event.ts || event.completedAt || ''}\x1f${event.branch || event.targetRef || event.ref || ''}`;
        return `${type}\x1f${project}\x1f${String(explicitId)}\x1f${String(discriminator || '')}`;
    }
    if (type === 'commit' && sha) return `${type}\x1f${project}\x1f${sha}`;
    return '';
}

function rawGitEventTime(event) {
    const value = event?.completedAt || event?.completed_at || event?.timestamp || event?.time || event?.ts || 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function rawGitEventCompletionScore(event) {
    if (typeof event?.success === 'boolean') return 2;
    if (Number.isFinite(Number(event?.exitCode ?? event?.exit_code))) return 2;
    if (event?.status != null || event?.outcome != null || event?.conclusion != null) return 1;
    return 0;
}

// VB-11 — >0 when `a` is the newer scan of one event: a higher `scanSeq`,
// else (an older server) a later `scannedAt`. 0 when neither orders them.
function rawGitEventScanOrder(a, b) {
    const scanSeq = (event) => (event?.scanSeq == null || event.scanSeq === '' ? NaN : Number(event.scanSeq));
    const scannedAt = (event) => Number(event?.scannedAt) || 0;
    const left = scanSeq(a);
    const right = scanSeq(b);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return scannedAt(a) && scannedAt(b) ? scannedAt(a) - scannedAt(b) : 0;
}

function preferCanonicalRawGitEvent(previous, candidate) {
    // A departed agent keeps its frozen copy for 90 s: the newer scan of the
    // same event wins, whichever agent the harbor meets first.
    const scanOrder = rawGitEventScanOrder(candidate.event, previous.event);
    if (scanOrder !== 0) return scanOrder > 0;
    const type = gitEventKind(candidate.event);
    const previousTime = rawGitEventTime(previous.event);
    const candidateTime = rawGitEventTime(candidate.event);
    if (type === 'commit') {
        if (!previousTime) return candidateTime > 0;
        return candidateTime > 0 && candidateTime < previousTime;
    }
    if (candidateTime !== previousTime) return candidateTime > previousTime;
    return rawGitEventCompletionScore(candidate.event) > rawGitEventCompletionScore(previous.event);
}

// W7.9 — `gh pr create|merge` events (the adapter's forge `pr` type) in the
// harbor's normalized shape. The shared git normalizer has no PR kind.
function normalizeHarborPullRequestEvent(event, agent = {}, index = 0) {
    if (String(event?.type || '').toLowerCase() !== 'pr' || event.dryRun === true) return null;
    const action = String(event.action || '').toLowerCase();
    if (action !== 'create' && action !== 'merge') return null;
    const project = String(event.project || event.repository || event.repo || agent.projectPath || agent.project || 'unknown');
    const timestamp = parseEventTime(
        event.timestamp || event.time || event.ts || event.completedAt,
        parseEventTime(agent.lastSessionActivity, 0),
    );
    return {
        id: String(event.id || `pr:${project}:${action}:${timestamp}:${index}`),
        type: 'pr',
        action,
        project,
        timestamp,
        ts: timestamp,
        url: String(event.url || ''),
        title: String(event.title || ''),
        status: gitEventStatusLabel(event),
        // VB-3 — the command's own result: no outcome yet is no PR yet.
        success: typeof event.success === 'boolean' ? event.success : null,
        exitCode: Number.isFinite(Number(event.exitCode ?? event.exit_code)) ? Number(event.exitCode ?? event.exit_code) : null,
        completedAt: parseEventTime(event.completedAt || event.completed_at, 0),
        label: action === 'merge' ? 'PR merged' : 'PR opened',
        command: event.command ? String(event.command) : '',
        sha: '',
        branch: String(event.branch || ''),
        targetRef: '',
        inferred: true,
        observed: false,
        provider: event.provider || agent.provider || '',
        sessionId: event.sessionId || agent.sessionId || null,
    };
}

// One commit reported by two sessions (a detached-worktree scan and the
// named-branch scan) collapses to its newest scan, else the earliest report,
// which still adopts the other's branch unless that copy is an older scan: a
// shared commit never stays branch-less, and a reset branch stays gone.
function withAdoptedBranch(kept, dropped) {
    if (gitEventKind(kept) !== 'commit' || kept.branch || !dropped?.branch) return kept;
    return { ...kept, branch: dropped.branch, targetRef: kept.targetRef || dropped.targetRef || dropped.branch, detached: false };
}

function collectHarborGitEvents(agents, options = {}, stats = null) {
    const candidates = [];
    const canonicalCandidates = new Map();
    const normalizedKeys = new Set();
    const seenSourceArrays = new Set();
    let rawCount = 0;
    for (const agent of agents || []) {
        const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            if (seenSourceArrays.has(source)) continue;
            seenSourceArrays.add(source);
            source.forEach((event, index) => {
                rawCount++;
                const canonicalKey = canonicalRawGitEventKey(event, agent);
                const candidate = { event, agent, index, order: candidates.length };
                if (!canonicalKey) {
                    candidates.push(candidate);
                    return;
                }
                const previous = canonicalCandidates.get(canonicalKey);
                if (!previous) {
                    canonicalCandidates.set(canonicalKey, candidate);
                    candidates.push(candidate);
                    return;
                }
                const [kept, dropped] = preferCanonicalRawGitEvent(previous, candidate)
                    ? [candidate, previous]
                    : [previous, candidate];
                kept.order = previous.order;
                // An older scan's branch never overrides a newer scan's membership.
                if (rawGitEventScanOrder(dropped.event, kept.event) >= 0) kept.event = withAdoptedBranch(kept.event, dropped.event);
                canonicalCandidates.set(canonicalKey, kept);
                candidates[previous.order] = kept;
            });
        }
    }
    const events = [];
    for (const candidate of candidates) {
        const normalized = normalizeGitEvent(candidate.event, candidate.agent, candidate.index, options)
            || normalizeHarborPullRequestEvent(candidate.event, candidate.agent, candidate.index);
        if (!normalized || (options.type && normalized.type !== options.type)) continue;
        const normalizedKey = `${normalized.type}\x1f${normalized.project}\x1f${normalized.id}`;
        if (normalizedKeys.has(normalizedKey)) continue;
        normalizedKeys.add(normalizedKey);
        events.push(normalized);
    }
    events.sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    if (stats) {
        stats.rawCount = rawCount;
        stats.normalizedCount = events.length;
    }
    return events;
}

function rawGitEventEdgeVersion(event) {
    if (!event) return '';
    return [
        event.id || event.eventId || event.uuid || event.key || '',
        event.type || event.kind || event.action || '',
        event.status || event.outcome || event.conclusion || '',
        event.success,
        event.exitCode ?? event.exit_code ?? '',
        event.timestamp || event.time || event.ts || '',
        event.completedAt || event.completed_at || '',
        event.sha || event.commit || event.hash || '',
        event.branch || event.targetRef || event.ref || '',
        event.repoRoot || '',
        Array.isArray(event.landedShas) ? event.landedShas.join(',') : '',
        event.reason || '',
        event.author?.name || '',
        Array.isArray(event.coAuthors) ? event.coAuthors.join(',') : '',
        event.worktree?.path || '',
        Array.isArray(event.branches) ? event.branches.join(',') : '',
        Array.isArray(event.oldIds) ? event.oldIds.join(',') : '',
        event.unresolved === true ? 'unresolved' : '',
        event.scanSeq ?? '',
        event.branchesComplete ?? '',
    ].join('\x1f');
}

function harborEventSourceSnapshot(agents) {
    const snapshot = [];
    for (const agent of agents || []) {
        const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            snapshot.push({
                agent,
                source,
                length: source.length,
                first: source[0] || null,
                last: source[source.length - 1] || null,
                firstVersion: rawGitEventEdgeVersion(source[0]),
                lastVersion: rawGitEventEdgeVersion(source[source.length - 1]),
                project: agent?.projectPath || agent?.project || '',
                sessionId: agent?.sessionId || agent?.agentId || agent?.id || '',
                provider: agent?.provider || '',
            });
        }
    }
    return snapshot;
}

function harborEventSourcesEqual(previous, next) {
    if (!Array.isArray(previous) || previous.length !== next.length) return false;
    for (let index = 0; index < next.length; index++) {
        const left = previous[index];
        const right = next[index];
        if (left.agent !== right.agent
            || left.source !== right.source
            || left.length !== right.length
            || left.first !== right.first
            || left.last !== right.last
            || left.firstVersion !== right.firstVersion
            || left.lastVersion !== right.lastVersion
            || left.project !== right.project
            || left.sessionId !== right.sessionId
            || left.provider !== right.provider) return false;
    }
    return true;
}

function harborEventsVersion(events) {
    let first = 2166136261;
    let second = 0x9e3779b9;
    const mix = (value) => {
        const text = String(value ?? '');
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            first = Math.imul(first ^ code, 16777619) >>> 0;
            second = (Math.imul(second ^ code, 2246822519) + 3266489917) >>> 0;
        }
        first = Math.imul(first ^ 31, 16777619) >>> 0;
        second = Math.imul(second ^ 131, 2246822519) >>> 0;
    };
    for (const event of events || []) {
        mix(event.id);
        mix(event.type);
        mix(event.project);
        mix(event.branch);
        mix(event.targetRef);
        mix(event.timestamp);
        mix(event.completedAt);
        mix(event.status);
        mix(event.sha);
        mix(event.label);
        mix(event.force);
        mix(event.success);
        mix(event.exitCode);
        mix(event.remote);
        mix(event.ref);
        mix(event.repoRoot);
        mix(event.checkout);
        mix(event.deleted);
        mix(event.tagsOnly);
        // #6 — every field the reducer consumes, array contents included, so
        // a re-report that only enriches an event still reaches it.
        mix(event.tag);
        mix(event.url);
        mix(event.reason);
        mix(event.stderr);
        mix(event.detached);
        mix(event.synthetic);
        mix(event.attribution);
        mix(event.author?.name);
        mix(event.author?.email);
        mix(event.worktree ? `${event.worktree.name}\x1e${event.worktree.path}\x1e${event.worktree.isMain}` : '');
        mix(event.coAuthors?.join('\x1e'));
        mix(event.landedShas?.join('\x1e'));
        mix(event.oldShas?.join('\x1e'));
        mix(event.oldIds?.join('\x1e'));
        mix(event.branches?.join('\x1e'));
        mix(event.unresolved);
        mix(event.scanSeq);
        mix(event.scannedAt);
        mix(event.branchesComplete);
        if (Array.isArray(event.refs)) for (const ref of event.refs) mix(`${ref?.src}\x1e${ref?.dst}\x1e${ref?.status}\x1e${ref?.tag}\x1e${ref?.deleted}\x1e${ref?.sha}`);
        if (Array.isArray(event.replacements)) for (const entry of event.replacements) mix(`${entry?.oldSha}\x1e${entry?.newSha}`);
    }
    return `${events?.length || 0}:${first.toString(36)}:${second.toString(36)}`;
}

// Bunting runs only between neighbours of one branch squad moored in the
// same channel, never more than about two tiles apart and never over a pier
// deck (at the pier berths a line between channels read as a scribble).
function buntingSpan(meta, next) {
    if (!meta || !next) return false;
    if (meta.squadKey !== next.squadKey || meta.anchorageName !== next.anchorageName) return false;
    const ax = Number(meta.tileX);
    const ay = Number(meta.tileY);
    const bx = Number(next.tileX);
    const by = Number(next.tileY);
    if (![ax, ay, bx, by].every(Number.isFinite)) return false;
    if (Math.hypot(bx - ax, by - ay) > 2.2) return false;
    for (let step = 0; step <= 8; step++) {
        const x = ax + (bx - ax) * step / 8;
        const y = ay + (by - ay) * step / 8;
        if (HARBOR_PIER_DECKS.some(deck => x >= deck.x0 - 0.1 && x <= deck.x1 + 0.1 && y >= deck.y0 - 0.1 && y <= deck.y1 + 0.1)) return false;
    }
    return true;
}

export class HarborTraffic {
    constructor({ sprites } = {}) {
        this.sprites = sprites || null;
        this.state = cloneState();
        this._pendingRepoSummaries = [];
        this.harborCrates = new Map();
        this.storageTransfers = new Map();
        this._lastDockLayoutByShipId = new Map();
        // Phase 3 — per-ship render motion (eased offsets, heading, launch)
        // and the slot each inbound or returning ship will moor in.
        this._motion = new Map();
        this._dockTargets = new Map();
        this._motionPrimed = false;
        this._previousDockPositions = new Map();
        this._markerFades = new Map();
        // 3.6 — hover lore: per-frame ship positions for hit testing + hovered ship id.
        this.hoveredShipId = null;
        this._shipHitEntries = [];
        this.motionScale = 1;
        this.frame = 0;
        this.waterRouteData = null;
        // #3 — active atmosphere grade; anchorage glows lerp toward worldTint.
        this._grade = null;
        // 6.5 — first sighting of each repo's failure bracket: { firstSeen, fresh }.
        this._failureBrackets = new Map();
        // #18 — repos seen at least once, so a brand-new repo's first anchorage
        // can fire a one-time christening (maiden banner) and skip it thereafter.
        this._repoFirstSeen = new Map();
        this._activeRepoAnchorages = new Map();
        this._activeProjectsKey = '';
        this._lastEventsVersion = '';
        this._nextMaintenanceAt = 0;
        this._stateVersion = 0;
        this._stateReductions = 0;
        this._unchangedReconciliations = 0;
        this._eventSourceSnapshot = null;
        this._sourceNormalizations = 0;
        this._sourceCacheHits = 0;
        this._advanceCalls = 0;
        this._reconcileCalls = 0;
        this._lastRawEventCount = 0;
        this._lastNormalizedEventCount = 0;
        this._hasTimedLifecycle = false;
        this._dockLayout = buildDockSquadLayout(this.state);
        this._repoDockSummaryCache = new Map();
        // The semantic state retains replay history, but frames only need the
        // pack representatives chosen by the titan packing policy plus
        // currently animated ships. Rebuild this window when state changes
        // instead of walking the complete retained history every frame.
        this._packedDockedEntries = [];
        this._activeRenderShips = [];
        // U-P6 — this frame's placed plate boxes (world rects) and the lane
        // lead plates' reserved slots (see _reservePlates).
        this._fleetLeadByRepo = new Map();
        this._repoLaneCount = new Map();
        this._plateBoxes = [];
        this._plateFrame = -1;
        this._leadPlateLift = new Map();
        this._repoAnchorageDrawableCache = [];
        this._drawableBuffer = [];
        this._hullItems = [];
        this._hullItemPool = new Map();
        this._departingBuffer = [];
        this._convoyGroups = new Map();
        // 8.2 — release sloops by crown key (see launchReleaseSail).
        this._releaseSails = new Map();
        this._enumeratedFrame = -1;
        this._previousDebugHarbor = null;
        this._disposed = false;
        if (typeof window !== 'undefined' && window.localStorage?.getItem('claudeVilleDebug') === '1') {
            this._previousDebugHarbor = window.__harbor || null;
            window.__harbor = this;
        }
    }

    _applyReadableTextShadow(ctx) {
        ctx.shadowColor = 'rgba(8, 5, 4, 0.88)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    }

    _fillReadableText(ctx, text, x, y, maxWidth) {
        ctx.save();
        this._applyReadableTextShadow(ctx);
        if (maxWidth != null) ctx.fillText(text, x, y, maxWidth);
        else ctx.fillText(text, x, y);
        ctx.restore();
    }

    _drawRepoLabelIcon(ctx, x, y, size, profile = null) {
        const r = size / 2;
        ctx.save();
        this._applyReadableTextShadow(ctx);
        ctx.fillStyle = profile?.accent || '#f6d384';
        ctx.strokeStyle = 'rgba(255, 240, 184, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    setWaterRouteData(routeData) {
        this.waterRouteData = routeData || null;
        this._enumeratedFrame = -1;
    }

    // Phase 3.2 — the live water mask (scenery water minus bridge spans):
    // when it differs from the baked one, every fleet is re-laid on it.
    setWaterMask(waterTiles, bridgeTiles = null) {
        if (!setHarborWaterMask(waterTiles, bridgeTiles)) return false;
        this._dockLayout = buildDockSquadLayout(this.state);
        this._repoDockSummaryCache = this._repoDockSummaries(this._dockLayout);
        this._observeDockTargets();
        this._refreshRenderWindow();
        return true;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
        if (this.motionScale <= 0) this.storageTransfers.clear();
        this._enumeratedFrame = -1;
    }

    setGradeState(grade) {
        this._grade = grade || null;
    }

    // 5.3 — the village lamp clock (dusk to dawn; IsometricRenderer
    // villageLampsLit): every hull's lamps are lit fixtures, never
    // occupancy (M05-5: a moored hull shows only its anchor light).
    setLampsLit(lit) {
        this._lampsLit = lit === true;
    }

    // 5.3 — the lamps' own light: a small warm fixture per lit hull (a soft
    // halo on the hull and the water round it, and, as every fixture does,
    // a broken lamp column on the water below it on both backends; 2.9).
    // Budgeted: the fleet leads first, then the largest hulls, at most
    // HARBOR_LAMP_LIGHT_CAP, each far dimmer than a window, so a moored
    // fleet glimmers without outshining the Harbor or the Lighthouse.
    // `core` is the frame's source-energy core.
    lampLightSources(core = 1) {
        if (!this._lampsLit || !(core > 0.02)) return [];
        const lit = this._litLampItems();
        const out = [];
        for (const item of lit) {
            const pose = item.pose;
            const lamp = hullLampPoints(pose)[0] || { x: pose.x, y: pose.y - 10 };
            const foot = { x: Math.round(pose.x), y: Math.round(pose.y) };
            out.push(normalizeLightSource({
                id: `harbor-lamp:${item.id}`,
                kind: 'point',
                role: 'fixture',
                x: lamp.x,
                y: lamp.y,
                ground: foot,
                height: Math.max(2, foot.y - lamp.y),
                color: HARBOR_LAMP_COLOR,
                radius: HARBOR_LAMP_RADIUS,
                intensity: HARBOR_LAMP_INTENSITY * core * pose.alpha * pose.lamps.strength,
            }));
        }
        return out;
    }

    // The lit hulls whose lamps get light and halo, budget-capped: fleet
    // leads first, then the largest hulls (a calm harbor lights them all).
    _litLampItems() {
        const lit = [];
        for (const item of this._hullItems || []) {
            const pose = item.pose;
            if (!pose?.lamps || item.behindBuilding || !(pose.alpha >= 0.5)) continue;
            lit.push(item);
        }
        lit.sort((a, b) => (Number(b.fleetLead) - Number(a.fleetLead))
            || (b.pose.strip.frameWidth - a.pose.strip.frameWidth)
            || String(a.id).localeCompare(String(b.id)));
        if (lit.length > HARBOR_LAMP_LIGHT_CAP) lit.length = HARBOR_LAMP_LIGHT_CAP;
        return lit;
    }

    // 5.3 — the lamp glow both backends draw on the ungraded overlay:
    // - every lit lamp's core as a 2x2-texel lamp at z >= 2 (a single texel
    //   reads as a speck there);
    // - for the budgeted hulls (HARBOR_LAMP_LIGHT_CAP, leads first), a small
    //   halo of Bayer-dithered lamp texels round each lamp (half the texels
    //   within 3, a quarter within 5: glow in the pixel grid, never a wash);
    // - under each of those hulls, the lamp's reflection: 2-4 broken warm
    //   runs on the water below its waterline, shimmering on the 4 Hz water
    //   step (the lamp columns' tick; held under reduced motion).
    // A hull the Harbor hides shows none; a sinking hull's lamps sink with it.
    drawLampGlow(ctx, zoom = 1, core = 1) {
        if (!this._lampsLit || !(core > 0.02)) return;
        const haloed = new Set(this._litLampItems());
        const tick = this.motionScale > 0 ? Math.floor(this.frame * 16 / LAMP_SHIMMER_STEP_MS) : 0;
        ctx.save();
        for (const item of this._hullItems || []) {
            const pose = item.pose;
            if (!pose?.lamps || item.behindBuilding || !(pose.alpha > 0.02)) continue;
            const points = hullLampPoints(pose);
            if (!points.length) continue;
            const alpha = Math.min(1, pose.alpha * core);
            if (haloed.has(item)) {
                for (const point of points) this._drawLampHalo(ctx, Math.floor(point.x), Math.floor(point.y), alpha);
                this._drawLampReflection(ctx, pose, points[0], alpha, tick, item.id);
            }
            if ((zoom || 1) >= 2) {
                ctx.globalAlpha = alpha;
                ctx.fillStyle = HARBOR_LAMP_COLOR;
                for (const point of points) ctx.fillRect(Math.floor(point.x), Math.floor(point.y) - 1, 2, 2);
            }
        }
        ctx.restore();
    }

    _drawLampHalo(ctx, cx, cy, alpha) {
        ctx.globalAlpha = 0.7 * alpha;
        ctx.fillStyle = HARBOR_LAMP_COLOR;
        const outer = HARBOR_LAMP_HALO[1];
        for (let dy = -outer; dy <= outer; dy++) {
            for (let dx = -outer; dx <= outer; dx++) {
                const d = Math.hypot(dx, dy);
                if (d < 1 || d > outer) continue;
                const x = cx + dx;
                const y = cy + dy;
                const threshold = LAMP_BAYER4[((y & 3) << 2) | (x & 3)];
                // Half the texels inside the inner ring, a quarter outside.
                if (threshold >= (d <= HARBOR_LAMP_HALO[0] ? 8 : 4)) continue;
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }

    _drawLampReflection(ctx, pose, lamp, alpha, tick, id) {
        const waterline = Math.round(pose.y) + (pose.sink | 0) + 2;
        const reach = Math.max(3, Math.min(14, Math.round(pose.y - lamp.y) >> 1));
        const seed = stableHash(`${id}:lamp-shimmer`);
        const x = Math.floor(lamp.x);
        ctx.fillStyle = HARBOR_LAMP_COLOR;
        const runs = 2 + ((seed + tick) % 3);
        for (let i = 0; i < runs; i++) {
            const t = (i + 0.5) / runs;
            const y = waterline + Math.round(t * reach);
            const wobble = ((seed >> (i * 3)) + tick * (i + 1)) % 3 - 1;
            const width = Math.max(1, 3 - i);
            ctx.globalAlpha = alpha * (0.62 - 0.4 * t);
            ctx.fillRect(x + wobble - (width >> 1), y, width, 1);
        }
    }

    // Canvas (and hybrid PostFx) path: lit lamps as emitter cuts on the
    // ungraded overlay, and on the bloom source when there is one. `core` is
    // the frame's source-energy core (EmitterCuts). A hull the Harbor hides
    // takes its lamps with it.
    drawLampCuts(ctx, core = 1, bloomCtx = null) {
        if (!this._lampsLit) return;
        for (const item of this._hullItems || []) {
            const pose = item.pose;
            if (!pose?.lamps || item.behindBuilding) continue;
            const alpha = pose.alpha * core;
            drawHullLamps(ctx, pose, alpha);
            if (bloomCtx) drawHullLamps(bloomCtx, pose, alpha);
        }
    }

    update(agents, dt = 16, now = Date.now()) {
        if (this._disposed) return;
        this.advance(dt);
        this.reconcile(agents, now);
    }

    advance(dt = 16) {
        if (this._disposed) return;
        this._advanceCalls++;
        this.frame += (dt / 16) * this.motionScale;
    }

    reconcile(agents, now = Date.now(), { force = false } = {}) {
        if (this._disposed) return this;
        this._reconcileCalls++;
        const sourceSnapshot = harborEventSourceSnapshot(agents);
        const sourceChanged = !harborEventSourcesEqual(this._eventSourceSnapshot, sourceSnapshot);
        let events = [];
        let eventsVersion = this._lastEventsVersion;
        if (sourceChanged || force) {
            const stats = {};
            events = collectHarborGitEvents(agents, {
                maxLabelChars: MAX_LABEL_CHARS,
                ellipsis: '…',
            }, stats);
            eventsVersion = harborEventsVersion(events);
            if (sourceChanged) this._eventSourceSnapshot = sourceSnapshot;
            this._sourceNormalizations++;
            this._lastRawEventCount = stats.rawCount || 0;
            this._lastNormalizedEventCount = stats.normalizedCount || 0;
        } else {
            this._sourceCacheHits++;
        }
        const eventsChanged = sourceChanged && eventsVersion !== this._lastEventsVersion;
        // Home Waters: live-agent repos claim coastal anchorages through the
        // reducer, so a change in the live set is a reduction trigger too.
        this._observeRepoAnchorages(agents, now);
        const activeProjects = [...this._activeRepoAnchorages.values()].map(entry => entry.project);
        const activeProjectsKey = [...activeProjects].sort().join('\x1f');
        const activeChanged = activeProjectsKey !== this._activeProjectsKey;
        const shouldReduce = force
            || eventsChanged
            || activeChanged
            || this._hasTimedLifecycle
            || now >= this._nextMaintenanceAt;
        if (shouldReduce) {
            const complete = force || eventsChanged;
            this.state = reduceHarborTrafficState(this.state, complete ? events : [], {
                now,
                motionScale: this.motionScale,
                activeProjects,
                repoDisplayName: trafficShortName,
                complete,
            });
            this._lastEventsVersion = eventsVersion;
            this._activeProjectsKey = activeProjectsKey;
            this._nextMaintenanceAt = now + HARBOR_MAINTENANCE_INTERVAL_MS;
            this._hasTimedLifecycle = harborStateHasTimedLifecycle(this.state);
            this._stateVersion++;
            this._stateReductions++;
            this._dockLayout = buildDockSquadLayout(this.state);
            this._repoDockSummaryCache = this._repoDockSummaries(this._dockLayout);
            this._pendingRepoSummaries = pendingRepoSummariesFromDockSummaries(this._repoDockSummaryCache, this.state.pushEvents.values());
            this._observeStorageTransfers(this._dockLayout, now);
            this._observeDockTargets(now);
            this._refreshRenderWindow(now);
        } else {
            this._unchangedReconciliations++;
        }
        this._observeHarborCrates(agents, sourceChanged || force ? events : [], now);
        this._repoAnchorageDrawableCache = this._repoAnchorageDrawables(this._repoDockSummaryCache, now);
        this._observePeakDensity(now);
        this._enumeratedFrame = -1;
        return this;
    }

    getDiagnostics() {
        return {
            stateVersion: this._stateVersion,
            stateReductions: this._stateReductions,
            unchangedReconciliations: this._unchangedReconciliations,
            sourceNormalizations: this._sourceNormalizations,
            sourceCacheHits: this._sourceCacheHits,
            animationAdvances: this._advanceCalls,
            semanticReconciliations: this._reconcileCalls,
            rawEventCount: this._lastRawEventCount,
            normalizedEventCount: this._lastNormalizedEventCount,
            seenEventIds: this.state.seenEventIds.size,
            maxSeenEventIds: MAX_HARBOR_SEEN_EVENT_IDS,
            pushEvents: this.state.pushEvents.size,
            maxPushEvents: MAX_HARBOR_PUSH_EVENTS,
            ships: this.state.ships.size,
            maxShips: MAX_HARBOR_SHIPS,
            batches: this.state.batches.size,
            maxBatches: MAX_HARBOR_BATCHES,
            repoQuays: this.state.repoQuays.size,
            maxRepoQuays: MAX_HARBOR_REPO_QUAYS,
            eventTombstones: this.state.eventTombstones.size,
            maxEventTombstones: MAX_HARBOR_EVENT_TOMBSTONES,
            commitReplayFloors: this.state.commitReplayFloors.size,
            maxCommitReplayFloors: MAX_HARBOR_COMMIT_REPLAY_FLOORS,
            overflowDockCounts: this.state.overflowDockCounts.size,
            maxOverflowDockCounts: MAX_HARBOR_OVERFLOW_DOCK_COUNTS,
            overflowDockedCommits: harborOverflowDockCount(this.state),
            harborCrates: this.harborCrates.size,
            storageTransfers: this.storageTransfers.size,
            activeRepoAnchorages: this._activeRepoAnchorages?.size || 0,
            repoFirstSeen: this._repoFirstSeen.size,
            maxRepoFirstSeen: MAX_REPO_FIRST_SEEN,
            cleanLabelCache: cleanCommitLabelCacheSize(),
            cleanLabelCacheLimit: HARBOR_CLEAN_LABEL_CACHE_LIMIT,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        if (typeof window !== 'undefined' && window.__harbor === this) {
            if (this._previousDebugHarbor && !this._previousDebugHarbor._disposed) window.__harbor = this._previousDebugHarbor;
            else delete window.__harbor;
        }
        this._previousDebugHarbor = null;
        this.state = cloneState();
        this._pendingRepoSummaries = [];
        this.harborCrates.clear();
        this.storageTransfers.clear();
        this._releaseSails.clear();
        this._lastDockLayoutByShipId.clear();
        this._shipHitEntries = [];
        this.hoveredShipId = null;
        this._activeRepoAnchorages.clear();
        this._activeProjectsKey = '';
        this._repoFirstSeen.clear();
        this._eventSourceSnapshot = null;
        this._lastRawEventCount = 0;
        this._lastNormalizedEventCount = 0;
        this._hasTimedLifecycle = false;
        this._dockLayout = null;
        this._repoDockSummaryCache?.clear?.();
        this._packedDockedEntries.length = 0;
        this._activeRenderShips.length = 0;
        this._fleetLeadByRepo.clear();
        this._repoLaneCount.clear();
        this._plateBoxes.length = 0;
        this._leadPlateLift.clear();
        this._repoAnchorageDrawableCache.length = 0;
        this._drawableBuffer.length = 0;
        this._hullItems.length = 0;
        this._hullItemPool.clear();
        this._departingBuffer.length = 0;
        this._convoyGroups.clear();
        this._enumeratedFrame = -1;
        this.waterRouteData = null;
        this._grade = null;
        this._failureBrackets.clear();
        releaseSuccessGrammar(this);
        this.sprites = null;
    }

    /**
     * Track which repos are currently "home" — those with a live agent. The
     * set is merged with docked-ship repos at draw time so a repo that just
     * shipped a commit keeps its anchorage even after its agent departs.
     */
    _observeRepoAnchorages(agents, now = Date.now()) {
        const active = this._activeRepoAnchorages;
        for (const agent of agents || []) {
            const project = agent?.repoRoot || agent?.projectPath || agent?.project;
            if (!project) continue;
            const profile = repoProfile(project);
            if (!profile?.key) continue;
            active.set(profile.key, { project, profile, lastActive: now });
        }
        for (const [key, entry] of active) {
            if (now - (entry.lastActive || 0) > REPO_ANCHORAGE_ACTIVE_MS) active.delete(key);
        }
    }

    getPendingRepoSummaries() {
        return this._pendingRepoSummaries || [];
    }

    getFailedPushState(now = Date.now()) {
        const repos = new Map();
        let latest = null;
        for (const batch of this.state.batches.values()) {
            if ((batch.status || 'unknown') !== 'failed') continue;
            const age = this._batchSummaryAge(batch, now);
            if (age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS) continue;
            const profile = trafficProfile(batch.project, batch.branch);
            const current = repos.get(profile.key) || {
                project: batch.project,
                branch: batch.branch || '',
                repoName: trafficLabel(batch.project, batch.branch),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, batch.eventTime || batch.startedAt || 0);
            repos.set(profile.key, current);
            if (!latest || current.latestEventTime > (latest.eventTime || 0)) {
                latest = {
                    id: batch.id,
                    project: batch.project,
                    branch: batch.branch || '',
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: batch.targetRef || '',
                    label: batch.label || '',
                    eventTime: current.latestEventTime,
                };
            }
        }
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked' || ship.pushStatus !== 'failed') continue;
            const profile = trafficProfile(ship.project, ship.branch);
            const eventTime = Math.max(ship.eventTime || 0, ship.failedAt || 0);
            const current = repos.get(profile.key) || {
                project: ship.project,
                branch: ship.branch || '',
                repoName: trafficLabel(ship.project, ship.branch),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, eventTime);
            repos.set(profile.key, current);
            if (!latest || eventTime > (latest.eventTime || 0)) {
                latest = {
                    id: ship.pushEventId || ship.id,
                    project: ship.project,
                    branch: ship.branch || '',
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: '',
                    label: ship.label || '',
                    eventTime,
                };
            }
        }
        for (const push of this.state.pushEvents.values()) {
            if ((push.status || 'unknown') !== 'failed' || push.batchId || !push.project) continue;
            const profile = trafficProfile(push.project, push.branch);
            const current = repos.get(profile.key) || {
                project: push.project,
                branch: push.branch || '',
                repoName: trafficLabel(push.project, push.branch),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, push.eventTime || 0);
            repos.set(profile.key, current);
            if (!latest || (push.eventTime || 0) > (latest.eventTime || 0)) {
                latest = {
                    id: push.id,
                    project: push.project,
                    branch: push.branch || '',
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: '',
                    label: '',
                    eventTime: push.eventTime || 0,
                };
            }
        }
        const list = [...repos.values()]
            .sort((a, b) => (b.latestEventTime - a.latestEventTime) || a.repoName.localeCompare(b.repoName));
        return {
            hasFailedPush: list.length > 0,
            status: list.length > 0 ? 'failed' : 'ok',
            accent: PUSH_STATUS_STYLE.failed.accent,
            glow: PUSH_STATUS_STYLE.failed.glow,
            intensity: Math.min(1, list.reduce((sum, repo) => sum + repo.failedPushes, 0) / 4),
            latest,
            repos: list,
        };
    }

    // 3.6 — detect projects without upstream tracking. A project is "untethered" if either:
    //   (a) any ship has an explicit hasUpstreamHint === false, OR
    //   (b) it has >= UNTETHERED_MIN_COMMITS docked commits and no push event has ever landed
    //       (the lagoon has held the commits without progress).
    _computeUntetheredProjects(now = Date.now()) {
        const untethered = new Set();
        const dockedByProject = new Map();
        const pushedProjects = new Set();
        for (const push of this.state.pushEvents.values()) {
            if (push?.project) pushedProjects.add(String(push.project));
        }
        // S-M6 — a landed push outlives the pruned push records.
        for (const project of this.state.lastLandedPushAt?.keys?.() || []) pushedProjects.add(String(project));
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            const projectKey = String(ship.project || 'unknown');
            const entry = dockedByProject.get(projectKey) || { count: 0, oldest: now };
            entry.count += 1;
            entry.oldest = Math.min(entry.oldest, ship.createdAt || now);
            dockedByProject.set(projectKey, entry);
            if (ship.hasUpstreamHint === false) {
                untethered.add(projectKey);
            }
        }
        for (const [project, entry] of dockedByProject) {
            if (pushedProjects.has(project)) continue;
            if (entry.count >= UNTETHERED_MIN_COMMITS && (now - entry.oldest) >= UNTETHERED_HOLD_MS) {
                untethered.add(project);
            }
        }
        return untethered;
    }

    _observePeakDensity(now) {
        if (!this._peakWindow) this._peakWindow = { peak: 0, since: now };
        if (this.state.ships.size > this._peakWindow.peak) {
            this._peakWindow.peak = this.state.ships.size;
        }
        if (now - this._peakWindow.since > 60000) {
            if (this._peakWindow.peak >= 8
                && typeof window !== 'undefined'
                && window.localStorage?.getItem('claudeVilleDebug') === '1') {
                console.info(`[harbor] peak ships in last minute: ${this._peakWindow.peak}`);
            }
            this._peakWindow = { peak: this.state.ships.size, since: now };
        }
    }

    _observeStorageTransfers(dockLayout, now = Date.now()) {
        const next = new Map();
        for (const [id, meta] of dockLayout?.byShipId?.entries?.() || []) {
            next.set(id, {
                x: meta.x,
                y: meta.y,
                tileX: meta.tileX,
                tileY: meta.tileY,
                waitingZone: meta.waitingZone || 'harbor',
            });
        }

        if (this.motionScale <= 0) {
            this.storageTransfers.clear();
            this._lastDockLayoutByShipId = next;
            return;
        }

        // Where each docked ship lay in the layout before this one (a pack
        // member: its lead's mooring), for unpack glides.
        this._previousDockPositions = this._lastDockLayoutByShipId;
        if (!this._lastDockLayoutByShipId.size) {
            this._lastDockLayoutByShipId = next;
            return;
        }

        let transferIndex = 0;
        for (const [id, current] of next) {
            const previous = this._lastDockLayoutByShipId.get(id);
            if (!previous) continue;
            const ship = this.state.ships.get(id);
            if (!ship || ship.status !== 'docked') continue;
            const enteringStorage = !isCommitLagoonZone(previous.waitingZone)
                && isCommitLagoonZone(current.waitingZone);
            if (!enteringStorage || this.storageTransfers.has(id)) continue;

            const fromTile = {
                tileX: Number(previous.tileX),
                tileY: Number(previous.tileY),
            };
            const toTile = {
                tileX: Number(current.tileX),
                tileY: Number(current.tileY),
            };
            // Lane-graph passage at about a tile a second (P-D7).
            const route = sailPath(composeStorageTransferTiles(fromTile, toTile));
            this.storageTransfers.set(id, {
                id,
                startedAt: now + transferIndex * STORAGE_TRANSFER_STAGGER_MS,
                duration: clamp(route.length * 1000, STORAGE_TRANSFER_MS, STORAGE_TRANSFER_MAX_MS),
                routeMetadata: routeGraphMetadata('storage.lagoon-transfer'),
                route,
                fromZone: previous.waitingZone || 'harbor',
                toZone: current.waitingZone || 'commit-lagoon',
            });
            transferIndex += 1;
        }

        for (const [id, transfer] of this.storageTransfers) {
            const current = next.get(id);
            if (!current || !isCommitLagoonZone(current.waitingZone)) {
                this.storageTransfers.delete(id);
                continue;
            }
            if (now - (transfer.startedAt || now) > (transfer.duration || STORAGE_TRANSFER_MS) + 250) {
                this.storageTransfers.delete(id);
            }
        }

        this._lastDockLayoutByShipId = next;
    }

    // P-D1 — the moorings as they will be: the dock layout with every
    // inbound pull and every returning rejected or cancelled ship already
    // docked (with the push status it redocks with), and a ship that has
    // just cast off still holding its place until it has cleared the fleet.
    // Returning ships sail to their slot in it, and docked ships hold their
    // slot in it, so a sortie never shuffles the fleet twice. Rebuilt per
    // state; empty when nothing is out.
    _observeDockTargets(now = Date.now()) {
        this._dockTargets.clear();
        let ships = null;
        for (const [id, ship] of this.state.ships) {
            const pull = ship.status === 'arriving' && !['fetch', 'pr', 'pr-merge'].includes(ship.arrivingKind);
            const clearing = ship.status === 'departing' && now - (Number(ship.departStartedAt) || 0) < CAST_OFF_MS + FLEET_HOLD_MS;
            if (!pull && !clearing && ship.status !== 'rejecting' && ship.status !== 'cancelling') continue;
            ships ||= new Map(this.state.ships);
            ships.set(id, {
                ...ship,
                status: 'docked',
                pushStatus: ship.status === 'rejecting' ? 'rejected' : ship.status === 'cancelling' ? 'cancelled' : ship.pushStatus,
            });
        }
        if (!ships) return;
        const layout = buildDockLayoutFresh({ ...this.state, ships });
        for (const [id, meta] of layout.byShipId) this._dockTargets.set(id, { tileX: meta.tileX, tileY: meta.tileY, x: meta.x, y: meta.y });
    }

    // Phase 3.1 — the render position: the drawable's target (its layout
    // slot or route sample) plus an offset that springs to zero, so any jump
    // in the target (a relayout, a redock, a sortie from a slot the layout
    // has since moved) is a glide, never a teleport. Also the hull's heading
    // (3.5: the route tangent under way, the glide while moored, bow into
    // the wind at rest), 3.7's slipway launch and swing at anchor.
    _settleShipMotion(payload, now) {
        const id = payload.id;
        if (!id || payload.releaseSail) return;
        const tx = payload.x;
        const ty = payload.y;
        const moored = (payload.status === 'docked' || payload.status === 'anchored' || payload.status === 'scuttling') && !payload.storageTransfer;
        let m = this._motion.get(id);
        if (!m) {
            m = { x: tx, y: ty, tx, ty, ox: 0, oy: 0, ovx: 0, ovy: 0, vx: 0, vy: 0, at: now, heading: null, stillSince: now, launchAt: 0 };
            this._motion.set(id, m);
            const recent = (time) => Number.isFinite(Number(time)) && now - Number(time) < LAUNCH_WINDOW_MS;
            if (this._motionPrimed && moored && payload.status === 'docked' && this.motionScale > 0
                && recent(payload.createdAt) && recent(payload.eventTime)) this._launchShip(m, payload, now);
            else if (this._motionPrimed && moored && this.motionScale > 0) this._unpackShip(m, payload, now);
        } else {
            const dt = (now - m.at) / 1000;
            if (dt > MOTION_RESYNC_S || this.motionScale <= 0) {
                m.ox = 0;
                m.oy = 0;
                m.ovx = 0;
                m.ovy = 0;
                m.relocation = null;
            } else if (dt > 0) {
                const goal = toTile(tx, ty);
                if (moored && (m.relocation
                    ? Math.hypot(goal.tileX - m.relocation.goal.tileX, goal.tileY - m.relocation.goal.tileY) > 0.05
                    : Math.hypot(tx - m.tx, ty - m.ty) > RELOCATE_TILES * HARBOR_GROUND_PX_PER_TILE * 0.8
                        && tileDistance(toTile(m.x, m.y), goal) > RELOCATE_TILES)) {
                    // P-D2 — the slot moved across the water: sail there.
                    const path = sailPath(composeWaterPath(toTile(m.x, m.y), goal));
                    m.relocation = { path, goal, startedAt: now, duration: clamp(path.length / RELOCATE_TILES_PER_S * 1000, 1500, 30000) };
                    m.ox = 0;
                    m.oy = 0;
                    m.ovx = 0;
                    m.ovy = 0;
                } else if (!moored) {
                    m.relocation = null;
                }
                if (!m.relocation && Math.hypot(tx - m.tx, ty - m.ty) > Math.max(MOTION_JUMP_PX, MOTION_JUMP_SPEED * dt)) {
                    m.ox = m.x - tx;
                    m.oy = m.y - ty;
                    if (Math.hypot(m.ox, m.oy) > MOTION_SNAP_PX) {
                        m.ox = 0;
                        m.oy = 0;
                        m.ovx = 0;
                        m.ovy = 0;
                    }
                }
                springOffset(m, dt);
            }
        }
        // Leaving the mooring, the swing at anchor eases out with the offset.
        if (!moored && m.swingX !== undefined) {
            m.ox += m.swingX;
            m.oy += m.swingY;
            m.swingX = undefined;
            m.swingY = undefined;
        }
        let x = tx + m.ox;
        let y = ty + m.oy;
        let relocating = false;
        if (m.relocation) {
            const r = m.relocation;
            const progress = clamp((now - r.startedAt) / r.duration, 0, 1);
            if (progress >= 1) {
                m.relocation = null;
            } else {
                const distance = easedDeparture(progress) * r.path.length;
                const pos = sampleSailPath(r.path, distance);
                const tail = sampleSailPath(r.path, distance - SAIL_TAIL_TILES);
                x = pos.x;
                y = pos.y;
                payload.tailX = tail.x;
                payload.tailY = tail.y;
                relocating = true;
            }
        }
        const dt = (now - m.at) / 1000;
        if (dt > 0 && dt <= MOTION_RESYNC_S) {
            const k = 1 - Math.exp(-dt / HEADING_SMOOTH_S);
            m.vx += ((x - m.x) / dt - m.vx) * k;
            m.vy += ((y - m.y) / dt - m.vy) * k;
        } else if (dt > MOTION_RESYNC_S) {
            m.vx = 0;
            m.vy = 0;
        }
        m.x = x;
        m.y = y;
        m.tx = tx;
        m.ty = ty;
        m.at = now;

        const speed = Math.hypot(m.vx, m.vy);
        m.status = payload.status;
        if (moored) m.sortieFrom = undefined;
        if (!moored || relocating) {
            const hx = (relocating ? x : tx) - (Number.isFinite(payload.tailX) ? payload.tailX : tx);
            const hy = (relocating ? y : ty) - (Number.isFinite(payload.tailY) ? payload.tailY : ty);
            if (Math.hypot(hx, hy) > 0.5) m.heading = hullHeadingDirection(hx, hy, m.heading);
            m.stillSince = now;
        } else if (speed > MOORED_HEADING_SPEED) {
            m.heading = hullHeadingDirection(m.vx, m.vy, m.heading);
            m.stillSince = now;
        } else {
            // Bow into the wind, or bow in to the quay at a pier berth.
            const windHeading = payload.moorHeading || (currentPennantWind() >= 0 ? 'sw' : 'se');
            const settle = WEATHERVANE_MS + (stableHash(`${id}:weathervane`) % WEATHERVANE_STAGGER_MS);
            if (!m.heading || (m.heading !== windHeading && now - m.stillSince > settle)) m.heading = windHeading;
        }

        payload.x = x;
        payload.y = y;
        if (!relocating && Number.isFinite(payload.tailX)) payload.tailX += m.ox;
        if (!relocating && Number.isFinite(payload.tailY)) payload.tailY += m.oy;
        payload.relocating = relocating;
        payload.heading = m.heading;
        m.payload = payload;
        payload.launchAlpha = m.launchAt ? clamp((now - m.launchAt) / LAUNCH_FADE_MS, 0, 1) : 1;
        if (moored && !relocating && this.motionScale > 0) {
            const t = this.frame * 16 / 1000;
            const hash = stableHash(`${id}:swing`);
            const phase = (hash % 1000) / 1000 * Math.PI * 2;
            m.swingX = Math.sin(t * Math.PI * 2 / (9 + (hash % 5)) + phase) * SWING_X_PX;
            m.swingY = Math.sin(t * Math.PI * 2 / (12 + (hash % 7)) + phase * 1.7) * SWING_Y_PX;
            payload.x += m.swingX;
            payload.y += m.swingY;
        }
    }

    // P-D9 — a sortie (departure, boomerang, cancel) starts from where the
    // hull is drawn, not from the tile the reducer laid it at (its fleet may
    // since have moved, or be holding formation for a returning ship).
    _observeSortieStart(ship) {
        const m = this._motion.get(ship.id);
        if (!m) return;
        // #3 — a publication that supersedes a return turns the hull back
        // out to sea from where it is drawn, on a fresh course.
        if (ship.status === 'departing' && (m.status === 'rejecting' || m.status === 'cancelling')) {
            const drawn = toTile(m.x, m.y);
            m.sortieFrom = harborWaterField().nearestClear({ tileX: Math.round(drawn.tileX * 100) / 100, tileY: Math.round(drawn.tileY * 100) / 100 }, 0.3);
            return;
        }
        if (m.sortieFrom !== undefined) return;
        const sortie = ship.status === 'departing' || ship.status === 'rejecting' || ship.status === 'cancelling';
        if (!sortie) return;
        if (m.status !== 'docked' && m.status !== 'anchored') {
            m.sortieFrom = null;
            return;
        }
        const drawn = toTile(m.x, m.y);
        m.sortieFrom = harborWaterField().nearestClear({ tileX: Math.round(drawn.tileX * 100) / 100, tileY: Math.round(drawn.tileY * 100) / 100 }, 0.3);
    }

    // Phase 3.1 — pack consolidation: a moored hull folded into a titan
    // pack (still docked, no longer drawn) glides into its pack lead and
    // fades over PACK_GHOST_MS instead of vanishing.
    _observePackGhosts(visible, now) {
        const layout = this._dockLayout;
        for (const [id, m] of this._motion) {
            if (m.at >= now) {
                m.ghost = null;
                continue;
            }
            if (!m.ghost) {
                if (!m.payload || m.status !== 'docked') continue;
                const ship = this.state.ships.get(id);
                const leadId = layout?.byShipId?.get(id)?.visualLeadId;
                if (!ship || ship.status !== 'docked' || !leadId || leadId === id || this.motionScale <= 0) continue;
                // Into a lead close by (bow toward it); one across the water
                // fades where it lay.
                const lead = this._motion.get(leadId) || layout.byShipId.get(leadId);
                const near = lead && Math.hypot(lead.x - m.x, lead.y - m.y) < PACK_GHOST_REACH_PX
                    && harborWaterField().segmentClearance(toTile(m.x, m.y), toTile(lead.x, lead.y)) > 0.25;
                const payload = { ...m.payload };
                if (near && Math.hypot(lead.x - m.x, lead.y - m.y) > 4) payload.heading = hullHeadingDirection(lead.x - m.x, lead.y - m.y, payload.heading);
                m.ghost = { startedAt: now, fromX: m.x, fromY: m.y, toX: near ? lead.x : m.x, toY: near ? lead.y : m.y, payload };
            }
            const t = clamp((now - m.ghost.startedAt) / PACK_GHOST_MS, 0, 1);
            if (t >= 1) continue;
            const { toX, toY } = m.ghost;
            const eased = easedDeparture(t);
            const x = m.ghost.fromX + (toX - m.ghost.fromX) * eased;
            const y = m.ghost.fromY + (toY - m.ghost.fromY) * eased;
            m.at = now - MOTION_FORGET_MS / 2;
            visible.push({
                kind: 'harbor-traffic',
                sortY: y + REPO_DOCK_SHIP_SORT_OFFSET,
                payload: { ...m.ghost.payload, x, y, ghost: true, launchAlpha: 1 - t },
            });
        }
    }

    // Phase 3.1 — a ship stepping out of a titan pack (the hull budget eased)
    // glides out of its old lead's mooring and fades in, never pops.
    _unpackShip(m, payload, now) {
        const from = this._previousDockPositions?.get?.(payload.id);
        if (!from || Math.hypot(from.x - payload.x, from.y - payload.y) < 3) return;
        if (Math.hypot(from.x - payload.x, from.y - payload.y) > PACK_GHOST_REACH_PX * 2) return;
        m.ox = from.x - payload.x;
        m.oy = from.y - payload.y;
        m.x = from.x;
        m.y = from.y;
        m.launchAt = now;
    }

    // The marker fade per repo: toward 1 while it has ships, 0 without, over
    // MARKER_FADE_MS on the render clock (immediate under reduced motion).
    _markerFade(project, present) {
        const key = repoProfile(project).key;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const entry = this._markerFades.get(key) || { value: present ? 1 : 0, at: now };
        const step = this.motionScale > 0 ? (now - entry.at) / MARKER_FADE_MS : 1;
        entry.value = present ? Math.min(1, entry.value + step) : Math.max(0, entry.value - step);
        entry.at = now;
        this._markerFades.set(key, entry);
        return Math.round(entry.value * 4) / 4;
    }

    _launchShip(m, payload, now) {
        const target = toTile(payload.x, payload.y);
        const slipway = target.tileX < LAGOON_EAST_TILE_X ? LAGOON_SLIPWAY : HARBOR_SLIPWAY;
        const path = sailPath(composeWaterPath(slipway, target));
        const run = Math.min(LAUNCH_RUN_TILES, path.length);
        if (run < 0.3) return;
        const from = sampleSailPath(path, path.length - run);
        m.ox = from.x - payload.x;
        m.oy = from.y - payload.y;
        m.x = from.x;
        m.y = from.y;
        const len = Math.hypot(m.ox, m.oy) || 1;
        m.ovx = -m.ox / len * LAUNCH_SPEED;
        m.ovy = -m.oy / len * LAUNCH_SPEED;
        m.vx = m.ovx;
        m.vy = m.ovy;
        m.launchAt = now;
    }

    _storageTransferPosition(shipId, fallback, now = Date.now()) {
        const transfer = this.storageTransfers.get(shipId);
        if (!transfer || this.motionScale <= 0) return null;
        const duration = Math.max(1, Number(transfer.duration) || STORAGE_TRANSFER_MS);
        const rawProgress = Math.max(0, Math.min(1, (now - (transfer.startedAt || now)) / duration));
        const distance = easedDeparture(rawProgress) * transfer.route.length;
        const pos = sampleSailPath(transfer.route, distance);
        const tail = sampleSailPath(transfer.route, distance - SAIL_TAIL_TILES);
        if (rawProgress >= 1) {
            this.storageTransfers.delete(shipId);
            return {
                x: fallback.x,
                y: fallback.y,
                tailX: tail.x,
                tailY: tail.y,
                progress: 1,
            };
        }
        return {
            x: pos.x,
            y: pos.y,
            tailX: tail.x,
            tailY: tail.y,
            progress: rawProgress,
        };
    }

    _refreshRenderWindow(now = Date.now()) {
        const dockLayout = this._dockLayout || buildDockSquadLayout(this.state);
        const visualPackByShipId = dockLayout.visualPackByShipId || new Map();
        const untetheredProjects = this._computeUntetheredProjects(now);
        const packed = this._packedDockedEntries;
        const active = this._activeRenderShips;
        packed.length = 0;
        active.length = 0;

        // Squads contain every retained docked ship, while the pack map only
        // contains representatives that can produce a drawable. Materialize
        // that sparse join once per semantic state version.
        // U-P6 — one shield per repo fleet: the first visible lane lead of
        // each repo (the default branch's when it has one), wearing a
        // collision-checked monogram. The fleet lead's position also anchors
        // the repo's buoy label (its leading edge, U-P7).
        const fleetLeads = new Map();
        const monogramRepos = new Map();
        for (const squad of dockLayout.squads || []) {
            const visibleSquad = [];
            for (const ship of squad.ships || []) {
                const pack = visualPackByShipId.get(ship.id);
                const meta = pack ? dockLayout.byShipId.get(ship.id) : null;
                if (!pack || !meta) continue;
                visibleSquad.push({ ship, pack, meta, crateKey: repoProfile(ship.project).key, nextMeta: null, drawable: null });
            }
            for (let index = 0; index < visibleSquad.length; index++) {
                const entry = visibleSquad[index];
                entry.nextMeta = visibleSquad[index + 1]?.meta || null;
                const drawable = this._shipDrawable(entry.ship, now);
                if (!drawable) continue;
                const { meta, pack } = entry;
                const payload = drawable.payload;
                payload.x = meta.x;
                payload.y = meta.y;
                payload.repoDockIndex = meta.repoDockIndex;
                payload.repoDockCount = meta.repoDockCount;
                payload.repoTotalDockCount = meta.repoTotalDockCount;
                payload.repoDockVisibleCount = pack.visibleCount || meta.repoDockVisibleCount;
                payload.squadKey = meta.squadKey;
                payload.squadIndex = meta.squadIndex;
                payload.squadCount = meta.squadCount;
                payload.squadShipIndex = Number.isFinite(Number(pack.visualIndex))
                    ? Number(pack.visualIndex)
                    : meta.squadShipIndex;
                payload.squadShipCount = pack.visibleCount || meta.squadShipCount;
                payload.squadDensity = meta.squadDensity;
                payload.compactCommitLabel = meta.compactCommitLabel || pack.visualPackSize > 1;
                payload.showCommitLabel = pack.visualPackSize > 1 ? false : meta.showCommitLabel;
                payload.waitingZone = meta.waitingZone;
                payload.zoneSquadIndex = meta.zoneSquadIndex;
                payload.anchorageName = meta.anchorageName;
                payload.moorHeading = meta.moorHeading || '';
                payload.anchorageIndex = meta.anchorageIndex;
                payload.formationColumn = meta.column;
                payload.formationRow = meta.row;
                payload.visualPackSize = pack.visualPackSize;
                payload.visualPackStartIndex = pack.visualPackStartIndex;
                payload.visualPackEndIndex = pack.visualPackEndIndex;
                payload.visualPackHiddenCount = pack.visualPackHiddenCount;
                payload.buntingNext = buntingSpan(meta, entry.nextMeta)
                    ? { x: entry.nextMeta.x, y: entry.nextMeta.y }
                    : null;
                payload.untetheredFlag = meta.squadShipIndex === 0
                    && untetheredProjects.has(String(payload.project || 'unknown'));
                payload.pennonKind = branchPennonKind(payload.branch, payload.worktree);
                payload.laneLead = meta.squadShipIndex === 0 && !payload.prShip && !payload.isInbound;
                payload.repoFleetLead = false;
                if (payload.laneLead) {
                    const lead = fleetLeads.get(entry.crateKey);
                    if (!lead || (lead.payload.pennonKind !== 'default' && payload.pennonKind === 'default')) {
                        fleetLeads.set(entry.crateKey, { payload, meta });
                    }
                    monogramRepos.set(entry.crateKey, { key: entry.crateKey, name: repoDisplayName(payload.project) });
                }
                drawable.sortY = payload.y + REPO_DOCK_SHIP_SORT_OFFSET;
                entry.drawable = drawable;
                packed.push(entry);
            }
        }
        const monograms = assignMonograms([...monogramRepos.values()]);
        this._repoLaneCount.clear();
        for (const entry of packed) {
            if (entry.drawable.payload.laneLead) this._repoLaneCount.set(entry.crateKey, (this._repoLaneCount.get(entry.crateKey) || 0) + 1);
        }
        for (const [key, { payload }] of fleetLeads) payload.repoLaneCount = this._repoLaneCount.get(key) || 1;
        this._fleetLeadByRepo.clear();
        // z1 — the fleet lead's plate is the repo's whole cargo.
        const repoTotals = new Map();
        for (const row of this._pendingRepoSummaries || []) {
            const key = repoProfile(row.project).key;
            repoTotals.set(key, (repoTotals.get(key) || 0) + (Number(row.pendingCommits) || 0));
        }
        for (const [key, { payload, meta }] of fleetLeads) {
            payload.repoFleetLead = true;
            payload.monogram = monograms.get(key) || '';
            payload.repoTotal = repoTotals.get(key) || 0;
            this._fleetLeadByRepo.set(key, { x: meta.x, y: meta.y, id: payload.id });
        }

        for (const ship of this.state.ships.values()) {
            if (ship.status === 'docked') continue;
            // Pack members sailing behind their titan lead never draw themselves.
            if (ship.visualPackLeadId && ship.visualPackLeadId !== ship.id) continue;
            active.push(ship);
        }
        this._enumeratedFrame = -1;
    }

    enumerateDrawables(now = Date.now()) {
        if (this._enumeratedFrame === this.frame) return this._drawableBuffer;
        if (!this._packedDockedEntries.length && this.state.ships.size) {
            this._refreshRenderWindow(now);
        }
        const departing = this._departingBuffer;
        departing.length = 0;
        for (const ship of this._activeRenderShips) {
            this._observeSortieStart(ship);
            const drawable = this._shipDrawable(ship, now);
            if (!drawable) continue;
            this._settleShipMotion(drawable.payload, now);
            drawable.sortY = drawable.payload.y;
            departing.push(drawable);
        }

        const visible = this._drawableBuffer;
        visible.length = 0;
        for (const entry of this._packedDockedEntries) {
            const { drawable, meta, ship } = entry;
            const payload = drawable.payload;
            const held = this._dockTargets.get(ship.id) || meta;
            payload.x = held.x;
            payload.y = held.y;
            payload.tailX = ship.tailX;
            payload.tailY = ship.tailY;
            payload.storageTransferProgress = null;
            payload.storageTransfer = false;
            const transfer = this._storageTransferPosition(ship.id, meta, now);
            if (transfer) {
                payload.x = transfer.x;
                payload.y = transfer.y;
                payload.tailX = transfer.tailX;
                payload.tailY = transfer.tailY;
                payload.storageTransferProgress = transfer.progress;
                payload.storageTransfer = transfer.progress < 1;
            }
            // A repo's git-status crate stands on the deck or quay beside its
            // fleet (_harborCrateDrawables), never stamped on a hull: on the
            // flotilla art it covered the sails and read out of scale.
            payload.harborCrate = null;
            this._settleShipMotion(payload, now);
            drawable.sortY = payload.y + REPO_DOCK_SHIP_SORT_OFFSET;
            visible.push(drawable);
        }
        this._observePackGhosts(visible, now);
        for (const [id, motion] of this._motion) {
            if (now - motion.at > MOTION_FORGET_MS) this._motion.delete(id);
        }
        this._motionPrimed = true;

        departing.sort((a, b) => ((a.payload.departStartedAt || 0) - (b.payload.departStartedAt || 0))
            || ((a.payload.departSquadIndex || 0) - (b.payload.departSquadIndex || 0))
            || ((a.payload.eventTime || 0) - (b.payload.eventTime || 0))
            || a.payload.id.localeCompare(b.payload.id));
        const convoyGroups = this._convoyGroups;
        convoyGroups.clear();
        for (const drawable of departing) {
            const convoy = drawable.payload?.convoy;
            if (!convoy?.id || (drawable.payload?.pushStatus || '') !== 'success') continue;
            const list = convoyGroups.get(convoy.id) || [];
            list.push(drawable);
            convoyGroups.set(convoy.id, list);
        }
        for (const list of convoyGroups.values()) {
            if (list.length < RELEASE_CONVOY_MIN_SHIPS) continue;
            list.sort((a, b) => ((Number.isFinite(Number(a.payload.convoy?.index)) ? Number(a.payload.convoy.index) : 0)
                - (Number.isFinite(Number(b.payload.convoy?.index)) ? Number(b.payload.convoy.index) : 0))
                || ((a.payload.departStartedAt || 0) - (b.payload.departStartedAt || 0))
                || a.payload.id.localeCompare(b.payload.id));
            list.forEach((drawable, index) => {
                drawable.payload.convoy = {
                    ...drawable.payload.convoy,
                    visibleCount: list.length,
                    visibleIndex: index,
                };
                if (index === 0) drawable.payload.convoyLeader = true;
                const next = list[index + 1]?.payload;
                if (next) drawable.payload.convoyNext = { x: next.x, y: next.y };
            });
        }
        for (const drawable of departing) {
            visible.push(drawable);
        }
        for (const sail of this._releaseSails.values()) {
            const drawable = this._releaseSailDrawable(sail, now);
            if (drawable) visible.push(drawable);
        }
        for (const drawable of this._harborCrateDrawables()) {
            visible.push(drawable);
        }
        // 3.7 — single lagoon channel buoy at the Commit Lagoon → Harbor seam.
        const buoyDrawable = this._lagoonChannelBuoyDrawable(now);
        if (buoyDrawable) visible.push(buoyDrawable);

        // Home Waters — persistent per-repo anchorages.
        for (const drawable of this._repoAnchorageDrawableCache) {
            visible.push(drawable);
        }

        visible.sort((a, b) => a.sortY - b.sortY);
        // 3.6 — hover lore: snapshot ship positions in draw order for hit testing.
        this._shipHitEntries.length = 0;
        for (const drawable of visible) {
            if (drawable.payload?.type === 'ship' && !drawable.payload.ghost) this._shipHitEntries.push(drawable.payload);
        }
        this._enumeratedFrame = this.frame;
        return visible;
    }

    // 3.6 — hover lore: topmost-drawn ship under a world-space point, or null.
    hitTestShip(worldX, worldY) {
        const entries = this._shipHitEntries || [];
        for (let i = entries.length - 1; i >= 0; i--) {
            const ship = entries[i];
            const radius = harborShipCollisionRadius(ship) * 0.8;
            const dx = worldX - ship.x;
            // Hull sprites sit slightly above the anchor point; bias the hit center up.
            const dy = (worldY - (ship.y - 8)) * 1.5;
            if ((dx * dx + dy * dy) <= radius * radius) return ship;
        }
        return null;
    }

    setHoveredShip(shipId) {
        this.hoveredShipId = shipId || null;
    }

    // 3.6 — hover lore: native-tooltip text for a hovered ship (repo + commit subject).
    shipTooltip(ship = {}) {
        const branch = normalizeRepoBranch(ship.branch);
        const repo = `${repoDisplayName(ship.project)}${branch ? ` · ${branch}` : ''}`;
        if (ship.prShip) return `${repo} - ${pullRequestShipLabel(ship)}`;
        const visualPackSize = Number(ship.visualPackSize);
        if (Number.isFinite(visualPackSize) && visualPackSize > 1) {
            const start = Number.isFinite(Number(ship.visualPackStartIndex))
                ? Number(ship.visualPackStartIndex) + 1
                : 1;
            const end = Number.isFinite(Number(ship.visualPackEndIndex))
                ? Number(ship.visualPackEndIndex) + 1
                : start + visualPackSize - 1;
            return `${repo} - ${Math.round(visualPackSize)} pending commits (${start}-${end})`;
        }
        const subject = cachedCleanCommitSubject(ship.label || '');
        const cargo = subject || `commit ${commitPennantLabel(ship)}`;
        return `${repo} - ${cargo}`;
    }

    // U-P3 — the fleet card's data for `{ project, branch, shipId }`
    // (`branch` null = the whole repo); see HarborFleetCard.
    fleetCardModel(query = {}, { agentName = () => '', now = Date.now() } = {}) {
        return buildFleetCardModel({
            ships: this.state.ships.values(),
            pushEvents: [...this.state.pushEvents.values()],
            overflow: [...this.state.overflowDockCounts.values()],
        }, query, { agentName, now });
    }

    // Where a fleet card anchors (world px): the clicked hull while it is
    // drawn, else the lane's lead, else the repo fleet's lead; null when the
    // fleet has nothing docked.
    fleetAnchor(query = {}) {
        const project = String(query.project || '');
        if (!project) return null;
        if (query.shipId) {
            const hit = this._shipHitEntries.find(entry => entry.id === query.shipId);
            if (hit) return { x: hit.x, y: hit.y };
        }
        const branch = query.branch == null ? null : normalizeRepoBranch(query.branch);
        let fallback = null;
        for (const entry of this._packedDockedEntries) {
            const payload = entry.drawable?.payload;
            if (!payload || payload.project !== project) continue;
            if (branch != null && normalizeRepoBranch(payload.branch) !== branch) continue;
            if (payload.repoFleetLead || (branch != null && payload.laneLead)) return { x: payload.x, y: payload.y };
            fallback ||= { x: payload.x, y: payload.y };
        }
        return fallback;
    }

    // 3.7 — lagoon channel buoy: pulses in the repo accent of whichever ship is mid-storage-transfer.
    _lagoonChannelBuoyDrawable(now = Date.now()) {
        const pos = toWorld(HARBOR_BEACON_BUOY_TILE.tileX, HARBOR_BEACON_BUOY_TILE.tileY);
        let activeProfile = null;
        let activeCount = 0;
        let activeProject = '';
        // Find an active storage transfer (Commit Lagoon ↔ Harbor) to colour the buoy.
        for (const [shipId] of this.storageTransfers) {
            const ship = this.state.ships.get(shipId);
            if (!ship) continue;
            const profile = trafficProfile(ship.project, ship.branch);
            activeProfile = profile;
            activeProject = trafficLabel(ship.project, ship.branch);
            // Dock summaries already include retained and overflow history.
            for (const summary of this._repoDockSummaryCache.values()) {
                if (summary.project === ship.project) activeCount += Number(summary.count) || 0;
            }
            break;
        }
        // v0.23 A5 — flock cast-off pulse: when a multi-ship push has just cast
        // off, the beacon flares in that push's repo accent and fades over ~3s.
        let castOff = 0;
        let castOffProfile = null;
        const castOffWindow = CAST_OFF_MS + 1400;
        for (const ship of this._activeRenderShips) {
            if (ship.status !== 'departing') continue;
            if (Math.max(1, Number(ship.departSquadCount || 1)) < 2) continue;
            const elapsed = now - (Number(ship.departStartedAt) || now);
            if (elapsed < 0 || elapsed > castOffWindow) continue;
            const intensity = 1 - elapsed / castOffWindow;
            if (intensity > castOff) {
                castOff = intensity;
                castOffProfile = trafficProfile(ship.project, ship.branch);
            }
        }
        return {
            kind: 'harbor-traffic',
            sortY: pos.y + 12,
            payload: {
                type: 'lagoon-channel-buoy',
                x: pos.x,
                y: pos.y,
                profile: activeProfile,
                activeProject,
                activeCount,
                castOff,
                castOffAccent: castOffProfile?.accent || null,
                ts: now,
            },
        };
    }

    // The Harbor's one cargo pile: while any agent reads git status at the
    // Harbor, the authored `prop.harborCrates` stands once on the quay apron
    // under the crane (never on a pier deck, never a crate per agent). The
    // number of repos it stands for rides along as `count` for the tooltip.
    _harborCrateDrawables() {
        if (!this.harborCrates.size) return [];
        const crates = [...this.harborCrates.values()]
            .sort((a, b) => ((b.createdAt || 0) - (a.createdAt || 0)) || String(a.project).localeCompare(String(b.project)));
        const pos = toWorld(HARBOR_CRATE_QUAY.tileX, HARBOR_CRATE_QUAY.tileY);
        return [{
            kind: 'harbor-traffic',
            sortY: pos.y + REPO_DOCK_SHIP_SORT_OFFSET,
            payload: {
                type: 'crate',
                project: crates[0].project,
                profile: crates[0].profile,
                harborCrate: crates[0],
                count: crates.length,
                x: pos.x,
                y: pos.y,
            },
        }];
    }

    _observeHarborCrates(agents, events, now) {
        for (const event of events || []) {
            if (event?.type !== 'push') continue;
            const key = repoProfile(event.repoRoot || event.project).key;
            this.harborCrates.delete(key);
        }

        for (const agent of agents || []) {
            if (!agent?.projectPath && !agent?.project) continue;
            if (!isHarborCrateTool(agent)) continue;
            if (agent.targetBuildingType !== 'harbor' && agent.lastKnownBuildingType !== 'harbor') continue;
            const project = agent.repoRoot || agent.projectPath || agent.project || agent.teamName || 'unknown';
            const profile = repoProfile(project);
            this.harborCrates.set(profile.key, {
                project,
                profile,
                agentId: agent.id,
                label: /git\s+diff\b/i.test(`${agent.currentToolInput || ''} ${agent.lastToolInput || ''}`) ? 'DIFF' : 'STAT',
                createdAt: now,
                expiresAt: now + HARBOR_CRATE_TTL_MS,
            });
        }

        for (const [key, crate] of this.harborCrates) {
            if ((crate.expiresAt || 0) <= now) this.harborCrates.delete(key);
        }
    }

    _repoDockSummaries(dockLayout = null) {
        if (!dockLayout && this._repoDockSummaryCache) return this._repoDockSummaryCache;
        const layout = dockLayout || buildDockSquadLayout(this.state);
        const summaries = new Map();
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            const profile = trafficProfile(ship.project, ship.branch);
            const dockMeta = layout.byShipId.get(ship.id);
            const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
            const pos = dockMeta
                ? { x: dockMeta.x, y: dockMeta.y }
                : toWorld(berth.tileX, berth.tileY);
            const waitingZone = dockMeta?.waitingZone
                || ship.waitingZone
                || 'harbor';
            const summaryKey = `${profile.key}\x1f${waitingZone}`;
            const summary = summaries.get(summaryKey) || {
                project: ship.project,
                branch: ship.branch || '',
                profile,
                summaryKey,
                quayIndex: Number.isFinite(Number(ship.quayIndex)) ? Number(ship.quayIndex) : assignedQuayIndex(this.state, ship.project),
                waitingZone,
                count: 0,
                failedCount: 0,
                x: 0,
                y: 0,
                latestEventTime: 0,
                earliestEventTime: 0,
            };
            summary.count += 1;
            if (!summary.worktree && ship.worktree?.isMain === false) summary.worktree = ship.worktree;
            if (ship.pushStatus === 'failed' || ship.pushStatus === 'rejected') {
                summary.failedCount += 1;
                summary.failedAgentId ??= ship.agentId || null;
                const push = this.state.pushEvents.get(ship.pushEventId);
                const failedAt = Number(push?.eventTime || ship.failedAt || ship.rejectedAt || ship.eventTime) || 0;
                if (failedAt >= (Number(summary.failedAt) || 0)) {
                    summary.failedAt = failedAt;
                    summary.failureStatus = ship.pushStatus;
                    summary.failureReason = push?.reason || summary.failureReason || '';
                }
            }
            summary.x += pos.x;
            summary.y += pos.y;
            summary.latestEventTime = Math.max(summary.latestEventTime, ship.eventTime || 0);
            const isCommitShip = ship.isInbound !== true && (ship.gitKind || 'commit') === 'commit';
            const eventTime = Number(ship.eventTime) || 0;
            if (isCommitShip && eventTime > 0) {
                summary.earliestEventTime = summary.earliestEventTime > 0
                    ? Math.min(summary.earliestEventTime, eventTime)
                    : eventTime;
            }
            summary.waitingZone = waitingZone;
            summaries.set(summaryKey, summary);
        }
        for (const overflow of this.state.overflowDockCounts.values()) {
            const count = Math.max(0, Number(overflow.count || 0));
            if (count <= 0) continue;
            const profile = trafficProfile(overflow.project, overflow.branch);
            const waitingZone = overflow.waitingZone || 'harbor';
            const summaryKey = `${profile.key}\x1f${waitingZone}`;
            const summary = summaries.get(summaryKey) || {
                project: overflow.project,
                branch: overflow.branch || '',
                profile,
                summaryKey,
                quayIndex: Number.isFinite(Number(overflow.quayIndex)) ? Number(overflow.quayIndex) : 0,
                waitingZone,
                count: 0,
                failedCount: 0,
                x: 0,
                y: 0,
                latestEventTime: 0,
                earliestEventTime: 0,
            };
            summary.count += count;
            summary.failedCount += Math.max(0, Number(overflow.failedCount || 0));
            summary.latestEventTime = Math.max(summary.latestEventTime, Number(overflow.latestEventTime || 0));
            const overflowEarliestEventTime = Number(overflow.earliestEventTime) || 0;
            if (overflowEarliestEventTime > 0) {
                summary.earliestEventTime = summary.earliestEventTime > 0
                    ? Math.min(summary.earliestEventTime, overflowEarliestEventTime)
                    : overflowEarliestEventTime;
            }
            summary.overflowCount = Math.max(0, Number(summary.overflowCount || 0)) + count;
            summaries.set(summaryKey, summary);
        }
        return summaries;
    }

    /**
     * Home Waters anchorages: one persistent buoy per active repo on the
     * coastal slot the reducer allocated (`state.repoAnchorages`), so the buoy
     * and that repo's docked fleet always share a position. Repos without a
     * slot (pool exhausted) fold into an overflow chip beside the Commit Lagoon.
     */
    _repoAnchorageDrawables(repoSummaries = new Map(), now = Date.now()) {
        const active = this._activeRepoAnchorages;
        const repos = new Map();
        for (const [key, entry] of active) {
            repos.set(key, {
                key,
                project: entry.project,
                profile: entry.profile,
                docked: 0,
                failed: 0,
                lastActive: entry.lastActive || 0,
                live: true,
            });
        }
        for (const summary of repoSummaries.values()) {
            const profile = repoProfile(summary.project);
            const key = profile.key;
            const existing = repos.get(key) || {
                key,
                project: summary.project,
                profile,
                docked: 0,
                failed: 0,
                lastActive: 0,
                live: false,
            };
            existing.docked += Number(summary.count) || 0;
            existing.failed += Number(summary.failedCount) || 0;
            existing.lastActive = Math.max(existing.lastActive, summary.latestEventTime || 0);
            repos.set(key, existing);
        }
        if (!repos.size) return [];

        const shown = [];
        let overflow = 0;
        const seenSlots = new Set();
        for (const repo of repos.values()) {
            const slot = repoAnchorageSlot(this.state, repo.project);
            if (slot == null || seenSlots.has(slot)) {
                overflow += 1;
                continue;
            }
            seenSlots.add(slot);
            repo.slot = slot;
            shown.push(repo);
        }
        shown.sort((a, b) => a.slot - b.slot);

        // A repo with no ship moored or under way keeps its berth (state) but
        // shows no marker or label: they fade out with its last ship and back
        // in with its next (`_markerFade`).
        const projects = new Set();
        for (const ship of this.state.ships.values()) projects.add(ship.project);
        const afloat = new Set();
        for (const project of projects) afloat.add(repoProfile(project).key);
        const drawables = [];
        for (const repo of shown) {
            const slotTile = COAST_ANCHORAGE_SLOTS[repo.slot];
            if (!slotTile) continue;
            // D2 — a pier berth's marker is a post on the pier deck beside
            // its channel, with its fleet, not a buoy on open water.
            const onPier = Number.isFinite(slotTile.markerTileX);
            const tile = onPier ? { tileX: slotTile.markerTileX, tileY: slotTile.markerTileY } : slotTile;
            const pos = toWorld(tile.tileX, tile.tileY);
            const lively = repo.docked > 0 || (now - repo.lastActive) < REPO_ANCHORAGE_ACTIVE_MS;
            // #18 — christening: the first time a repo ever earns an anchorage,
            // emit a one-shot event so ChronicleMonuments raises a maiden banner.
            if (!this._repoFirstSeen.has(repo.key)) {
                this._repoFirstSeen.set(repo.key, now);
                if (this._repoFirstSeen.size > MAX_REPO_FIRST_SEEN) {
                    this._repoFirstSeen.delete(this._repoFirstSeen.keys().next().value);
                }
                eventBus?.emit?.('harbor:repo-christened', {
                    project: repo.project,
                    repoName: repo.profile.shortName,
                    tileX: tile.tileX,
                    tileY: tile.tileY,
                    ts: now,
                });
            }
            drawables.push({
                kind: 'harbor-traffic',
                sortY: pos.y - 2,
                payload: {
                    type: 'repo-anchorage',
                    project: repo.project,
                    profile: repo.profile,
                    repoName: repoDisplayName(repo.project),
                    labelAt: this._fleetLeadByRepo.get(repo.key) || null,
                    laneCount: this._repoLaneCount.get(repo.key) || 0,
                    docked: repo.docked,
                    failed: repo.failed,
                    live: repo.live,
                    lively,
                    slot: repo.slot,
                    present: repo.docked > 0 || afloat.has(repo.key),
                    deckLift: onPier ? PIER_DECK_LIFT_PX : 0,
                    x: pos.x,
                    y: pos.y,
                },
            });
        }
        if (overflow > 0) {
            const pos = toWorld(REPO_ANCHORAGE_OVERFLOW_TILE.tileX, REPO_ANCHORAGE_OVERFLOW_TILE.tileY);
            drawables.push({
                kind: 'harbor-traffic',
                sortY: pos.y - 2,
                payload: {
                    type: 'repo-anchorage',
                    overflowMore: overflow,
                    repoName: `+${overflow}`,
                    x: pos.x,
                    y: pos.y,
                },
            });
        }
        return drawables;
    }

    activeFinaleEffects(now = Date.now()) {
        const effects = [];
        for (const batch of this.state.batches.values()) {
            const startedAt = this._batchClockStart(batch, now);
            const age = now - startedAt;
            if (age < 0) continue;
            const status = batch.status || 'unknown';
            const finaleDelay = this._batchFinaleDelay(batch);
            const effectAge = age - finaleDelay;
            if (effectAge < 0 || effectAge > FINALE_EFFECT_MS) continue;
            const origin = this._batchOrigin(batch);
            effects.push({
                ...batch,
                status,
                x: origin.x,
                y: origin.y,
                effectAge,
                progress: Math.max(0, Math.min(1, effectAge / FINALE_EFFECT_MS)),
            });
        }
        return effects.sort((a, b) => (a.startedAt - b.startedAt) || a.id.localeCompare(b.id));
    }

    latestScreenSummary(now = Date.now()) {
        let latest = null;
        for (const batch of this.state.batches.values()) {
            const age = this._batchSummaryAge(batch, now);
            if (age < 0 || age > SCREEN_SUMMARY_MS) continue;
            if (!latest || (batch.startedAt || 0) > (latest.startedAt || 0)) latest = batch;
        }
        return latest;
    }

    _batchFinaleDelay(batch) {
        const status = batch?.status || 'unknown';
        if (status === 'failed' || status === 'rejected' || status === 'cancelled' || this.motionScale === 0) return 0;
        // 3.1 — force-push uses a shorter departure window, so fire the whirlpool earlier.
        const baseDeparture = batch?.force === true ? FORCE_DEPARTURE_MS : DEPARTURE_MS;
        return baseDeparture * 0.96;
    }

    _batchClockStart(batch, now = Date.now()) {
        if ((batch?.status || 'unknown') === 'failed') {
            return batch.statusUpdatedAt || batch.startedAt || now;
        }
        return batch?.startedAt || now;
    }

    _batchSummaryAge(batch, now = Date.now()) {
        return now - this._batchClockStart(batch, now) - this._batchFinaleDelay(batch);
    }

    _batchOrigin(batch) {
        const points = [];
        for (const shipId of batch.shipIds || []) {
            const ship = this.state.ships.get(shipId);
            if (!ship) continue;
            if ((batch.status || 'unknown') === 'failed') {
                const tile = this._shipStartTile(ship);
                points.push(toWorld(tile.tileX, tile.tileY));
                continue;
            }
            // The route's last point on the map (its horizon leg is off it).
            const endpoint = routeSeaTile(this._shipRouteTiles(ship));
            if (endpoint) points.push(toWorld(endpoint.tileX, endpoint.tileY));
        }
        for (const sealed of batch.sealedOriginPoints || []) {
            points.push({ x: sealed.x, y: sealed.y });
        }
        if (points.length === 0) return toWorld(HARBOR_FINALE_TILE.tileX, HARBOR_FINALE_TILE.tileY);
        const sum = points.reduce((acc, point) => ({
            x: acc.x + point.x,
            y: acc.y + point.y,
        }), { x: 0, y: 0 });
        return {
            x: sum.x / points.length,
            y: sum.y / points.length,
        };
    }

    _shipStartTile(ship) {
        const sortieFrom = this._motion?.get(ship?.id)?.sortieFrom;
        if (sortieFrom && ship.status !== 'docked') return sortieFrom;
        if (Number.isFinite(Number(ship?.departFromTile?.tileX)) && Number.isFinite(Number(ship?.departFromTile?.tileY))) {
            return {
                tileX: Number(ship.departFromTile.tileX),
                tileY: Number(ship.departFromTile.tileY),
            };
        }
        const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
        return { tileX: berth.tileX, tileY: berth.tileY };
    }

    _shipRouteTiles(ship) {
        return composeWaterRouteTiles(this._shipStartTile(ship), ship, this.waterRouteData);
    }

    draw(ctx, drawable, zoom = 1) {
        if (!drawable?.payload) return;
        if (drawable.payload.type === 'repo-anchorage') {
            this._drawRepoAnchorage(ctx, drawable.payload, zoom);
            return;
        }
        if (drawable.payload.type === 'crate') {
            const payload = drawable.payload;
            const profile = payload.profile || repoProfile(payload.project);
            this._drawHarborCrate(ctx, payload, zoom, 1, profile);
            return;
        }
        if (drawable.payload.type === 'lagoon-channel-buoy') {
            this._drawLagoonChannelBuoy(ctx, drawable.payload, zoom);
            return;
        }
        this._drawShip(ctx, drawable.payload, zoom);
    }

    drawFinaleEffects(ctx, now = Date.now()) {
        for (const effect of this.activeFinaleEffects(now)) {
            // 6.5 — failure is marked by the static bracket (drawMoments).
            if (effect.status === 'failed' || effect.status === 'rejected') continue;
            this._drawFinaleEffect(ctx, effect);
        }
    }

    // 6.5 — a verified failed (or remote-rejected) push is marked where it
    // happened: a static red broken bracket over the repo's slip, preceded by
    // one cream flash and a three-step shake of the stamp only — never the
    // camera. Drawn on the upper overlay for both backends. While any bracket
    // stands, success grammar (the release crown) is deferred.
    drawMoments(ctx, zoom = 1, now = Date.now()) {
        if (!ctx) return;
        const marks = this._failureBracketMarks(now);
        if (!marks.length) {
            releaseSuccessGrammar(this);
            return;
        }
        holdSuccessGrammar(this, 400);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        // Off-screen failures fold into one edge plate (the newest mark's
        // anchor, the count in its word), never a stack of identical chips.
        const edges = [];
        for (const mark of marks) {
            const edge = this._drawFailureBracket(ctx, mark, now);
            if (edge) edges.push(edge);
        }
        if (edges.length) {
            edges.sort((a, b) => (b.mark.eventTime || 0) - (a.mark.eventTime || 0));
            const lead = edges[0];
            const word = edges.length > 1
                ? `${edges.length} PUSHES FAILED`
                : (lead.mark.status === 'rejected' ? 'PUSH REJECTED' : 'PUSH FAILED');
            queueMomentEdgePlate(lead.anchor, { word, color: FAILURE, peak: edges.some(edge => edge.peak), ctx });
        }
        ctx.restore();
    }

    // One mark per repo: the docked failed/rejected ship's slip when commits
    // are waiting, else the repo's quay for a failed push with nothing docked.
    // Only verified outcomes (success:false or a non-zero exit) reach here.
    _failureBracketMarks(now = Date.now()) {
        const marks = new Map();
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            if (ship.pushStatus !== 'failed' && ship.pushStatus !== 'rejected') continue;
            const key = String(ship.project || 'unknown');
            if (marks.has(key)) continue;
            marks.set(key, {
                key,
                tile: this._shipStartTile(ship),
                onShip: true,
                status: ship.pushStatus,
                agentId: ship.agentId || null,
                eventTime: Number(ship.failedAt || ship.rejectedAt || 0),
            });
        }
        for (const push of this.state.pushEvents.values()) {
            const status = push.status || 'unknown';
            if ((status !== 'failed' && status !== 'rejected') || push.batchId || !push.project) continue;
            const key = String(push.project);
            if (marks.has(key)) continue;
            marks.set(key, {
                key,
                tile: this._repoSlipTile(push.project),
                onShip: false,
                status,
                agentId: push.agentId || null,
                eventTime: Number(push.eventTime || 0),
            });
        }
        for (const key of this._failureBrackets.keys()) {
            if (!marks.has(key)) this._failureBrackets.delete(key);
        }
        const list = [];
        for (const mark of marks.values()) {
            if (list.length >= FAILURE_BRACKET_MAX) break;
            let seen = this._failureBrackets.get(mark.key);
            if (!seen) {
                seen = {
                    firstSeen: now,
                    fresh: mark.eventTime > 0 && now - mark.eventTime < FAILURE_BRACKET_FRESH_MS,
                    // 8.3 — the cream frame lands on the failed push's note.
                    cue: createCueGate('pushFailed', mark.agentId),
                };
                this._failureBrackets.set(mark.key, seen);
            }
            mark.firstSeen = seen.firstSeen;
            mark.fresh = seen.fresh;
            mark.cue = seen.cue;
            list.push(mark);
        }
        return list;
    }

    // A failure with nothing docked is marked on the Harbor's own jetty, where
    // a repo's ships tie up — never out on open water. Each quay group has its
    // own post along the jetty so up to four failing repos do not stack.
    _repoSlipTile(project) {
        const key = String(project || 'unknown');
        const assigned = this.state.repoQuays?.get?.(key);
        const index = Number.isFinite(assigned) ? assigned : stableHash(key) % QUAY_GROUPS.length;
        return HARBOR_JETTY_SLIPS[index % HARBOR_JETTY_SLIPS.length];
    }

    // ─── 8.2 — a verified release sails from the pier ────────────────────────
    // ChronicleMonuments drives the sloop from the release crown's moment
    // clock: `launchReleaseSail` reveals it at the release slip (bare mast)
    // with `clock(now)` → { phase, step, reduced } | null, read before the
    // drawables of each frame so the hoist, the peak rim and the chevrons land
    // on the crown's own frames; `releaseSailArrived` holds the crown until the
    // sloop is fully in; `stageReleaseSail` re-reads the phase at overlay time
    // and returns the masthead the crown blooms over; `endReleaseSail` hands
    // the sloop to open water (under reduced motion: clears it). Only a
    // planted, verified release record ever launches one. Returns the ms
    // until it has arrived (what the crown waits), or null when none launched.
    launchReleaseSail({ key, project = null, label = null, clock = null, now = Date.now() } = {}) {
        if (!key || this._releaseSails.has(key)) return null;
        while (this._releaseSails.size >= RELEASE_SAIL_LIMIT) {
            this._releaseSails.delete(this._releaseSails.keys().next().value);
        }
        const id = `release-sail:${key}`;
        const route = [RELEASE_SAIL_SLIP, ...this._shipRouteTiles({ id, departFromTile: RELEASE_SAIL_OUT, laneIndex: 0 })]
            .map(point => toWorld(point.tileX, point.tileY));
        let length = 0;
        for (let i = 1; i < route.length; i++) length += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
        // The first leg's unit heading, for the stern while still at the slip.
        const next = route[1] || route[0];
        const leadLength = Math.hypot(next.x - route[0].x, next.y - route[0].y) || 1;
        const lead = { x: (next.x - route[0].x) / leadLength, y: (next.y - route[0].y) / leadLength };
        this._releaseSails.set(key, {
            key,
            id,
            project,
            label,
            route,
            length,
            lead,
            launchedAt: now,
            castOffAt: null,
            ended: false,
            still: false,
            hoist: -1,
            peak: false,
            chevrons: -1,
            drawn: null,
            clock: typeof clock === 'function' ? clock : null,
        });
        this._enumeratedFrame = -1;
        return this.motionScale > 0 ? RELEASE_SAIL_ARRIVE_STEP_MS * 4 : 0;
    }

    // Whether the release sloop has revealed at its slip and sat whole for
    // one step (so no frame hoists on a part-revealed hull); at once under
    // reduced motion, and a sloop that is gone never holds the crown.
    releaseSailArrived(key, now = Date.now(), { reduced = false } = {}) {
        const sail = this._releaseSails.get(key);
        if (!sail || reduced || sail.still || this.motionScale <= 0) return true;
        return now - sail.launchedAt >= RELEASE_SAIL_ARRIVE_STEP_MS * 4;
    }

    // The arrival's reveal level (the share of hull texels up): 1/4 → 4/4,
    // one step per RELEASE_SAIL_ARRIVE_STEP_MS; 1 when motion is off.
    _releaseSailArrivalAlpha(sail, now, reduced = false) {
        if (reduced || sail.still || this.motionScale <= 0) return 1;
        const step = Math.floor(Math.max(0, now - sail.launchedAt) / RELEASE_SAIL_ARRIVE_STEP_MS);
        return Math.min(4, step + 1) / 4;
    }

    // `phase`/`step`: the crown's momentPhase this frame. Returns the world
    // masthead { x, y, flagTop, depthY, tiedUp } of the pose drawn this frame
    // (the slip while the hull strip loads), or null for an unknown key.
    stageReleaseSail(key, { phase = null, step = 0, reduced = false, now = Date.now() } = {}) {
        const sail = this._releaseSails.get(key);
        if (!sail) return null;
        this._stageReleaseSail(sail, phase, step, reduced, now);
        return this._releaseSailMast(sail);
    }

    // `phase`/`step`: the crown's momentPhase this frame.
    _stageReleaseSail(sail, phase, step, reduced, now) {
        const still = reduced || this.motionScale <= 0;
        const hoist = phase === 'anticipation' ? Math.min(2, step) : 3;
        const peak = phase === 'peak';
        const chevrons = !still && phase === 'follow' ? step : -1;
        if (!still && sail.castOffAt == null && (phase === 'follow' || phase === 'residue')) sail.castOffAt = now;
        if (still !== sail.still || hoist !== sail.hoist || peak !== sail.peak || chevrons !== sail.chevrons) {
            sail.still = still;
            sail.hoist = hoist;
            sail.peak = peak;
            sail.chevrons = chevrons;
            this._enumeratedFrame = -1;
        }
    }

    // The crown's moment is over (or was never staged): a sloop still at its
    // slip casts off now, bare-masted if it never hoisted; under reduced
    // motion it is cleared with the static crown.
    endReleaseSail(key, now = Date.now()) {
        const sail = this._releaseSails.get(key);
        if (!sail) return;
        sail.ended = true;
        sail.peak = false;
        sail.chevrons = -1;
        if (sail.still || this.motionScale <= 0) this._releaseSails.delete(key);
        else if (sail.castOffAt == null) sail.castOffAt = now;
        this._enumeratedFrame = -1;
    }

    _releaseSailMast(sail) {
        const ship = sail.drawn;
        const start = sail.route[0];
        if (!ship) return { x: Math.round(start.x), y: Math.round(start.y) - 40, flagTop: Math.round(start.y) - 40, depthY: start.y, tiedUp: true };
        const pose = this._hullPose(ship);
        const mast = pose ? hullMasthead(pose) : { x: Math.round(ship.x), y: Math.round(ship.y) - 40 };
        const flag = this._flagAnchor(ship, RELEASE_SAIL_CLASS);
        return {
            x: mast.x,
            y: mast.y,
            flagTop: Math.min(mast.y, flag.y),
            depthY: ship.y,
            tiedUp: ship.status === 'docked',
        };
    }

    // Distance sailed `ms` after cast-off: an even acceleration over the
    // follow to cruise, then cruise.
    _releaseSailDistance(ms) {
        const t = Math.max(0, ms);
        if (t < RELEASE_SAIL_ACCEL_MS) return RELEASE_SAIL_CRUISE * t * t / (2 * RELEASE_SAIL_ACCEL_MS);
        return RELEASE_SAIL_CRUISE * (t - RELEASE_SAIL_ACCEL_MS / 2);
    }

    _releaseSailDrawable(sail, now) {
        if (!sail.ended && sail.clock) {
            const clock = sail.clock(now);
            // The clock may end the crown (and with it, under reduced motion,
            // this sloop).
            if (!this._releaseSails.has(sail.key)) return null;
            if (clock) this._stageReleaseSail(sail, clock.phase, clock.step, clock.reduced, now);
        }
        const route = sail.route;
        const start = route[0];
        let x = start.x;
        let y = start.y;
        let tailX = x;
        let tailY = y;
        // Fading in at the slip until it has arrived (the crown waits).
        let alpha = this._releaseSailArrivalAlpha(sail, now);
        let progress = 0;
        const sailing = sail.castOffAt != null && !sail.still;
        if (sailing) {
            const d = this._releaseSailDistance(now - sail.castOffAt);
            if (!(sail.length > 0) || d >= sail.length) {
                this._releaseSails.delete(sail.key);
                return null;
            }
            progress = d / sail.length;
            const pos = pointAlongPath(route, progress);
            // The heading: a point 12 px back along the route (along the first
            // leg while fewer than 12 px out).
            const back = d >= 12
                ? pointAlongPath(route, (d - 12) / sail.length)
                : { x: pos.x - sail.lead.x * 12, y: pos.y - sail.lead.y * 12 };
            x = pos.x;
            y = pos.y;
            tailX = back.x;
            tailY = back.y;
            const left = sail.length - d;
            if (left < RELEASE_SAIL_FADE_PX) alpha = Math.ceil(left / RELEASE_SAIL_FADE_PX * 4) / 4;
        }
        const payload = sail.drawn || (sail.drawn = { type: 'ship', releaseSail: true });
        payload.id = sail.id;
        payload.project = sail.project;
        payload.branch = null;
        payload.label = sail.label;
        payload.status = sailing ? 'departing' : 'docked';
        payload.x = x;
        payload.y = y;
        payload.tailX = tailX;
        payload.tailY = tailY;
        // Phase 3.5 — bow along its run out of the slip.
        payload.heading = hullHeadingDirection(sail.lead.x, sail.lead.y, payload.heading);
        payload.progress = progress;
        payload.releaseAlpha = alpha;
        // The V wake waits until the cast-off chevrons are spent.
        payload.releaseWake = sailing && sail.chevrons < 0 && progress > 0;
        payload.hoist = sail.hoist;
        payload.peak = sail.peak;
        payload.chevrons = sail.chevrons;
        return { kind: 'harbor-traffic', sortY: y, payload };
    }

    // The sloop's marks (its hull, reflection and wake are the harbor-hulls
    // records): the sail outline on the one cream frame, the gold pennant on
    // its hoist, the two cast-off chevrons astern. No repo flag, plate or
    // badge: the release pennant is this ship's one flag. Marks are drawn at
    // full strength (never translucent) while at least 3/4 of the hull's
    // texels are up.
    _drawReleaseSailMarks(ctx, ship) {
        const alpha = ship.releaseAlpha ?? 1;
        if (alpha < 0.75) return;
        ctx.save();
        const strip = hullStrip(this.sprites?.assets, RELEASE_SAIL_CLASS.spriteId, ship.heading || 'sw');
        const pose = strip ? this._hullPose(ship) : null;
        if (ship.peak && pose) {
            const outline = releaseSailOutline(strip, pose.frame);
            if (outline) {
                const g = hullGeometry(pose);
                // 10.2 — a verified release's peak frame: on the resident
                // path its cream rim is a role-2 GPU mark (peakMarkSink).
                const sink = peakMarkSink(ctx);
                if (sink) {
                    ctx.fillStyle = PEAK;
                    const { runs } = outline;
                    for (let index = 0; index < runs.length; index += 3) sink(g.x + runs[index], g.y + runs[index + 1], runs[index + 2], 1);
                } else {
                    ctx.drawImage(outline.canvas, g.x, g.y);
                }
            }
        }
        if (ship.hoist >= 0) {
            const { x, y } = this._flagAnchor(ship, RELEASE_SAIL_CLASS);
            const flown = ship.hoist >= 3;
            const windX = currentPennantWind();
            drawPennant(ctx, x, y + 16 + RELEASE_SAIL_HOIST_DROP[Math.min(3, ship.hoist)], {
                accent: GOLD,
                shade: GOLD_RAMP[0],
                frame: flown ? pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 1 }) : PENNANT_REST_FRAME,
                windX,
                withPole: flown,
            });
        }
        if (ship.chevrons >= 0) {
            // Every hull frame faces screen-right, so the waterline stern
            // sits left of the pivot: the chevrons open astern of it on the
            // water (never over the hull), trailing back along the route's
            // heading (the first leg runs bow-first, down and to the right),
            // the pair stepping back 2 texels on the follow's last step.
            const sternX = Math.round(ship.x) - (strip ? Math.round(strip.frameWidth * 0.3) : 16);
            const waterY = Math.round(ship.y);
            let hx = ship.x - ship.tailX;
            let hy = ship.y - ship.tailY;
            const heading = Math.hypot(hx, hy);
            if (heading > 1e-3) {
                hx /= heading;
                hy /= heading;
            } else {
                hx = 1;
                hy = 0;
            }
            const count = ship.chevrons === 0 ? 1 : 2;
            for (let i = 0; i < count; i++) {
                const back = 3 + i * RELEASE_SAIL_CHEVRON_GAP + (ship.chevrons === 2 ? 2 : 0);
                wakeV(ctx, Math.round(sternX - hx * back), Math.round(waterY - hy * back), hx, hy, {
                    length: RELEASE_SAIL_CHEVRON_LENGTH,
                    halfAngle: 0.7,
                    thick: 2,
                    color: RELEASE_SAIL_FOAM,
                    crest: RELEASE_SAIL_CREST,
                });
            }
        }
        ctx.restore();
    }

    _drawFailureBracket(ctx, mark, now) {
        if (!mark.tile) return;
        const point = toWorld(mark.tile.tileX, mark.tile.tileY);
        const size = mark.onShip ? { width: 30, height: 20, lift: 12 } : { width: 22, height: 14, lift: 6 };
        const animated = mark.fresh && this.motionScale > 0;
        // 8.3 — the cream frame waits for the failed push's first note.
        const age = animated
            ? cueGatedAge(mark.cue, now - mark.firstSeen, FAILURE_BRACKET.anticipation, FAILURE_BRACKET.active)
            : 0;
        const phase = animated ? momentPhase(age, FAILURE_BRACKET) : null;
        // 8.1 — V8: at the slip when that spot is clear and in the safe area;
        // else along the Harbor's own column; else an edge plate.
        const halfW = size.width / 2 + 7;
        const anchor = resolveMomentAnchor(point, {
            building: 'harbor',
            actorId: mark.agentId,
            depthY: point.y,
            extent: { left: -halfW, top: -(size.lift + size.height / 2 + 6), right: halfW, bottom: size.height / 2 + 2 - size.lift },
            id: `failed-push:${mark.key}`,
            kind: 'pushFailed',
            tier: 'medium',
            phase: phase?.phase ?? 'residue',
        });
        if (anchor.mode === 'edge') return { anchor, mark, peak: phase?.phase === 'peak' };
        const x = anchor.x;
        const y = anchor.y - size.lift;
        // The actor → the slip, for the residue window only.
        if (phase?.phase === 'residue') drawMomentThread(ctx, anchor, { color: FAILURE, targetLift: size.lift });
        const options = { width: size.width, height: size.height, broken: true, color: FAILURE, outline: FAILURE_OUTLINE };
        switch (phase?.phase) {
        case 'anticipation':
            // The two halves close in from either side in two held steps.
            ctx.globalAlpha = 0.66;
            bracket(ctx, x, y, { ...options, splitX: [4, 2][quantStep(phase.t, 2)] });
            ctx.globalAlpha = 1;
            break;
        case 'peak':
            bracket(ctx, x, y, { ...options, color: PEAK });
            break;
        case 'follow':
            bracket(ctx, x + FAILURE_SHAKE[phase.step], y, options);
            break;
        default:
            bracket(ctx, x, y, options);
            break;
        }
    }

    drawScreenSummary(ctx, canvas, camera, now = Date.now()) {
        const summary = this.latestScreenSummary(now);
        if (!summary || !canvas) return;
        const style = PUSH_STATUS_STYLE[summary.status] || PUSH_STATUS_STYLE.unknown;
        const profile = trafficProfile(summary.project, summary.branch);
        const age = this._batchSummaryAge(summary, now);
        const fade = this.motionScale === 0
            ? 1
            : Math.min(1, Math.max(0, (SCREEN_SUMMARY_MS - age) / 1600));
        if (fade <= 0) return;

        const branch = normalizeRepoBranch(summary.branch);
        const project = `${middleTruncate(repoDisplayName(summary.project), 22)}${branch ? ` · ${middleTruncate(branch, 24)}` : ''}`;
        const count = Number(summary.shipCount || 0);
        const commitLabel = count === 1 ? '1 commit' : `${count} commits`;
        const push = this._batchPush(summary);
        const title = this._screenSummaryTitle(summary.status, commitLabel);
        const target = summary.targetRef && normalizeRepoBranch(summary.targetRef) !== branch
            ? ` → ${summary.targetRef}`
            : '';
        const detail = `${project}${target}`;
        const titleLine = shortGitLabel(title, 56, '…');
        const detailLine = shortGitLabel(detail, 60, '…');
        const who = push?.agentName ? `by ${push.agentName}` : '';
        const statusLine = [
            (PUSH_STATUS_STYLE[summary.status] || PUSH_STATUS_STYLE.unknown).shortLabel.toUpperCase(),
            who,
            push?.reason ? middleTruncate(push.reason, 44) : '',
        ].filter(Boolean).join(' · ');
        ctx.save();
        ctx.font = WORLD_DISPLAY_FONT_8;
        const titleWidth = measureLabelText(ctx, titleLine);
        ctx.font = WORLD_BODY_FONT_11;
        const detailWidth = measureLabelText(ctx, detailLine);
        ctx.restore();
        const width = Math.min(500, Math.max(344, Math.max(titleWidth, detailWidth) + 76));
        const height = 82;
        const origin = this._batchOrigin(summary);
        const screen = camera?.worldToScreen
            ? camera.worldToScreen(origin.x, origin.y)
            : { x: canvas.width - width - 18, y: 72 };
        const maxX = canvas.width - width - 14;
        const maxY = canvas.height - height - 14;
        let x = Math.round(Math.max(14, Math.min(maxX, screen.x - width / 2)));
        let y = Math.round(Math.max(14, Math.min(maxY, screen.y - height - 26)));

        ctx.save();
        ctx.globalAlpha = fade;
        // C5 — hard 2 px offset block replaces the blurred drop shadow.
        ctx.fillStyle = 'rgba(14, 8, 5, 0.46)';
        ctx.fillRect(x + 2, y + 2, width, height);
        ctx.fillStyle = style.panel;
        ctx.fillRect(x, y, width, height);
        // C5 — integer fillRect rims replace the 0.5-offset lineWidth-2 strokes.
        ctx.fillStyle = 'rgba(255, 224, 150, 0.34)';
        ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
        ctx.fillStyle = style.panelBorder || style.accent;
        ctx.fillRect(x, y, width, 1);
        ctx.fillRect(x, y + height - 1, width, 1);
        ctx.fillRect(x, y + 1, 1, height - 2);
        ctx.fillRect(x + width - 1, y + 1, 1, height - 2);
        ctx.fillStyle = style.accent;
        ctx.fillRect(x, y, 7, height);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x + 9, y + 5, 4, height - 10);
        ctx.fillStyle = 'rgba(255, 239, 185, 0.13)';
        ctx.fillRect(x + 15, y + 6, width - 22, 1);
        ctx.fillRect(x + 15, y + height - 7, width - 22, 1);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.fillStyle = '#fff0b8';
        this._fillReadableText(ctx, titleLine, x + 26, y + 20);
        this._drawRepoLabelIcon(ctx, x + 27, y + 44, 8, profile);
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.font = WORLD_BODY_FONT_11;
        this._fillReadableText(ctx, detailLine, x + 38, y + 48);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.62)';
        ctx.font = WORLD_BODY_FONT_11;
        this._fillReadableText(ctx, fitLabelText(ctx, statusLine, width - 40), x + 26, y + 68);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.22)';
        ctx.fillRect(x + 26, y + 56, Math.max(34, width - 46), 1);
        ctx.restore();
    }

    // U-P5 — the card says what happened: rejected and cancelled pushes
    // bring their commits back, they never "sent them to sea".
    _screenSummaryTitle(status, commitLabel) {
        if (status === 'success') return `${commitLabel} pushed`;
        if (status === 'failed') return `Push failed · ${commitLabel} still docked`;
        if (status === 'rejected') return `Push rejected · ${commitLabel} returned`;
        if (status === 'cancelled') return `Push cancelled · ${commitLabel} stay docked`;
        return `${commitLabel} sent to sea`;
    }

    // The push record behind a batch (its reason and agent).
    _batchPush(batch) {
        if (!batch?.id) return null;
        const direct = this.state.pushEvents.get(batch.id);
        if (direct?.batchId === batch.id || direct) return direct;
        for (const push of this.state.pushEvents.values()) {
            if (push.batchId === batch.id) return push;
        }
        return null;
    }

    // Phase 3 — every sailing position is a pure function of `now`: the
    // distance along a lane-graph path (HarborLayout.composeWaterPath) at
    // the hull's speed profile. Departures accelerate from rest and hold
    // cruise to the horizon, where the hull sinks below it; arrivals rise
    // over the horizon and slow into the slot they will moor in; a rejected
    // or cancelled push sails out, stops, turns and comes back to its slot.
    // `_settleShipMotion` then eases any jump between these (P-D1/P-D2/P-D9).
    _shipDrawable(ship, now) {
        const startTile = this._shipStartTile(ship);
        const start = toWorld(startTile.tileX, startTile.tileY);
        let x = start.x;
        let y = start.y;
        let progress = 0;
        let castOff = 0;
        let castingOff = false;
        let inboundProgress = 0;
        let horizonProgress = 0;
        let extra = null;
        // The hull at `distance` along `path`, its tail a little astern (on
        // the start, mirrored ahead of it so the heading is the first leg's).
        const place = (path, distance) => {
            const pos = sampleSailPath(path, distance);
            const tail = sampleSailPath(path, distance - SAIL_TAIL_TILES);
            x = pos.x;
            y = pos.y;
            ship.tailX = tail.x;
            ship.tailY = tail.y;
            if (distance < SAIL_TAIL_TILES) {
                const ahead = sampleSailPath(path, SAIL_TAIL_TILES);
                ship.tailX = 2 * pos.x - ahead.x;
                ship.tailY = 2 * pos.y - ahead.y;
            }
            return pos;
        };

        if (ship.status === 'departing') {
            const path = sailPath(this._shipRouteTiles(ship));
            const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
            const startedAt = ship.departStartedAt || now;
            const elapsed = Math.max(0, now - startedAt);
            const forced = ship.pushForce === true;
            // A force-pushed hull sails its short fixed run at cruise and
            // founders at sea (the sink); every other one sails to the horizon.
            const runLength = forced ? Math.min(path.length, departMs / 1000 * FORCE_SAIL_TILES_PER_S) : path.length;
            if (this.motionScale > 0 && elapsed < CAST_OFF_MS && !ship.turnedFromReturn) {
                // Cast-off: the mooring lines come in; the hull holds on its
                // mooring, bow already on its first leg.
                castingOff = true;
                ship.phase = 'casting-off';
                castOff = elapsed / CAST_OFF_MS;
                place(path, 0);
            } else {
                if (ship.phase === 'casting-off') ship.phase = 'departing';
                // A hull turned from its return is already under way: no cast-off.
                const effectiveElapsed = Math.max(0, elapsed - (ship.turnedFromReturn ? 0 : CAST_OFF_MS));
                progress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, effectiveElapsed / departMs));
                const distance = this.motionScale === 0 ? runLength : harborSailDistance(effectiveElapsed, runLength, departMs);
                const pos = place(path, distance);
                if (!forced) horizonProgress = clamp(1 - (path.length - distance) / HORIZON_SINK_TILES, 0, 1);
                // v0.23 A5 — a slow serpentine weave across the heading, by
                // distance sailed, so a convoy never moves dead-straight; and
                // P-D6 — an echelon: odd and even convoy members stand a third
                // of a tile to either side of the lead's track where the water
                // is wide enough.
                if (this.motionScale > 0) {
                    const hdx = pos.x - ship.tailX;
                    const hdy = pos.y - ship.tailY;
                    const len = Math.hypot(hdx, hdy) || 1;
                    const swayPhase = (stableHash(`${ship.id || ''}:sway`) % 1000) / 1000 * Math.PI * 2;
                    const sway = Math.sin(distance * 1.4 + swayPhase) * 3 * Math.min(1, distance / 2);
                    const index = Math.max(0, Number(ship.convoy?.index ?? ship.departSquadIndex) || 0);
                    const side = index === 0 ? 0 : (index % 2 ? 1 : -1);
                    let echelon = 0;
                    if (side) {
                        const tile = toTile(pos.x, pos.y);
                        const room = harborWaterField().clearance(tile.tileX, tile.tileY) - harborHullClearance(ship);
                        echelon = side * clamp(room, 0, CONVOY_ECHELON_TILES) * Math.min(1, distance / 3) * HARBOR_GROUND_PX_PER_TILE;
                    }
                    // The tail shifts with the hull: the weave never turns it.
                    const lateralX = (-hdy / len) * (sway + echelon);
                    const lateralY = (hdx / len) * (sway + echelon);
                    x += lateralX;
                    y += lateralY;
                    ship.tailX += lateralX;
                    ship.tailY += lateralY;
                }
                if (progress >= 1 && this.motionScale === 0) return null;
            }
        } else if (ship.status === 'rejecting' || ship.status === 'cancelling') {
            // Boomerang (rejected): out about half the way to open water over
            // BOOMERANG_OUT_MS, then back to its slot over BOOMERANG_IN_MS.
            // 5.11 — a cancelled push only stands off a short way and turns,
            // half each of CANCEL_RETURN_MS. Both legs start and end at rest.
            const rejecting = ship.status === 'rejecting';
            const path = sailPath(this._shipRouteTiles(ship));
            const startedAt = (rejecting ? ship.boomerangStartedAt : ship.cancelReturnStartedAt) || now;
            const elapsed = Math.max(0, now - startedAt);
            const outMs = rejecting ? BOOMERANG_OUT_MS : CANCEL_RETURN_MS / 2;
            const inMs = rejecting ? BOOMERANG_IN_MS : CANCEL_RETURN_MS / 2;
            const reach = rejecting ? BOOMERANG_REACH_TILES : CANCEL_REACH_TILES;
            const apex = Math.min(path.seaLength * (rejecting ? 0.5 : 0.3), reach);
            let phaseProgress;
            let outbound = true;
            if (elapsed < outMs) {
                phaseProgress = elapsed / outMs;
                place(path, apex * easedDeparture(phaseProgress));
                progress = (apex * easedDeparture(phaseProgress)) / Math.max(0.001, path.length);
            } else {
                outbound = false;
                phaseProgress = Math.min(1, (elapsed - outMs) / inMs);
                // Home to its slot in the fleet as it will be, unless that
                // lies across the water: then to where it left (a relocation
                // sails the rest once it has redocked).
                const target = this._dockTargets.get(ship.id);
                const home = target && tileDistance(target, startTile) < RELOCATE_TILES * 1.6 ? target : startTile;
                const back = sailPath(composeWaterPath(sailPathTile(path, apex), home));
                place(back, back.length * easedDeparture(phaseProgress));
                progress = (apex * (1 - easedDeparture(phaseProgress))) / Math.max(0.001, path.length);
            }
            extra = rejecting
                ? { boomerangOutbound: outbound, boomerangPhaseProgress: phaseProgress }
                : { cancelPhaseProgress: Math.min(1, elapsed / CANCEL_RETURN_MS) };
        } else if (ship.status === 'arriving' || ship.status === 'anchored') {
            // 3.2 — inbound: a pull sails to the slot it will moor in (the
            // tentative layout, `_dockTargets`), a fetch or an opened PR to
            // its roadstead mooring, from the horizon; W7.9 — a merged PR
            // from its mooring to a quay berth.
            const moorsOut = ship.arrivingKind === 'fetch' || ship.arrivingKind === 'pr';
            const field = harborWaterField();
            const dockTile = moorsOut
                ? field.nearestClear(ship.inboundRoadsteadTile || { tileX: 38.05, tileY: 13.15 }, harborHullClearance(ship))
                : (this._dockTargets.get(ship.id) || field.nearestClear(startTile, harborHullClearance(ship)));
            let path;
            if (ship.arrivingKind === 'pr-merge' && ship.prFromTile) {
                path = sailPath(composeWaterPath(ship.prFromTile, dockTile));
            } else {
                path = sailPath(reversedTiles(composeWaterRouteTiles(dockTile, { ...ship, departFromTile: dockTile }, this.waterRouteData)));
            }
            const startedAt = ship.arrivingStartedAt || now;
            const duration = Math.max(1, Number(ship.arrivingDuration) || INBOUND_DURATION_MS);
            const elapsed = Math.max(0, now - startedAt);
            inboundProgress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, elapsed / duration));
            // Slows into its mooring: the departure profile run backwards.
            const distance = this.motionScale === 0 || inboundProgress >= 1
                ? path.length
                : path.length - harborSailDistance(duration - elapsed, path.length, duration);
            place(path, distance);
            if (ship.arrivingKind !== 'pr-merge') horizonProgress = clamp(1 - distance / HORIZON_SINK_TILES, 0, 1);
        }

        return {
            kind: 'harbor-traffic',
            sortY: y,
            payload: {
                ...ship,
                type: 'ship',
                x,
                y,
                tailX: ship.tailX,
                tailY: ship.tailY,
                progress,
                castingOff,
                castOffProgress: castOff,
                inboundProgress,
                horizonProgress,
                elapsed: Math.max(0, now - (ship.departStartedAt || ship.arrivingStartedAt || ship.boomerangStartedAt || ship.cancelReturnStartedAt || now)),
                scuttleElapsed: ship.status === 'scuttling' ? Math.max(0, now - (ship.scuttleStartedAt || now)) : 0,
                ...extra,
            },
        };
    }

    // DrawablePass sorts a hull behind a split building by depth
    // (`behindBuilding`, with the building drawable that sorts over it); the
    // marks drop only where that building's silhouette covers the hull on
    // screen: its masthead (where the flag flies) or most of a 3 x 3 grid
    // over the frame. A hull passing behind the Lighthouse footprint beside
    // the slim tower stays in view, and so do its flag and plate.
    _marksHiddenBehindBuilding(ship) {
        const item = this._hullItemPool?.get(ship.id);
        if (!item?.behindBuilding) return false;
        const building = item.behindBuildingDrawable;
        const sprites = this.sprites;
        const pose = item.pose;
        if (!building?.entry?.id || typeof sprites?.hitTest !== 'function' || !pose?.strip) return true;
        const id = building.entry.id;
        const [ax, ay] = sprites.assets?.getAnchor?.(id) || [0, 0];
        const dx = Math.round(building.wx - ax);
        const dy = Math.round(building.wy - ay);
        const mast = hullMasthead(pose);
        if (sprites.hitTest(id, mast.x, mast.y, dx, dy)) return true;
        const g = hullGeometry(pose);
        let covered = 0;
        for (let j = 1; j <= 3; j++) {
            for (let i = 1; i <= 3; i++) {
                if (sprites.hitTest(id, g.x + g.width * i / 4, g.y + g.height * j / 4, dx, dy)) covered++;
            }
        }
        return covered >= 5;
    }

    _drawShip(ctx, ship, zoom) {
        // A pack ghost (Phase 3.1) is hull only.
        if (ship.ghost) return;
        const alpha = this._shipAlpha(ship);
        if (alpha <= 0.02) return;
        // A hull the Harbor hides takes its flags and plates with it, as a
        // body behind a building drops its name.
        if (this._marksHiddenBehindBuilding(ship)) return;
        if (ship.releaseSail) {
            this._drawReleaseSailMarks(ctx, ship);
            return;
        }
        const profile = trafficProfile(ship.project, ship.branch);
        const shipClass = harborShipClass(ship);

        // 3.8 — the hull, its reflection and its V wake are the harbor-hulls
        // scene category (records on the resident path). This pass draws the
        // ship's marks: flags, badges, plates and moorings, which ride the
        // hull's whole-texel sink so a sinking ship takes its flag down.
        ctx.save();
        // 3.6 — amended commit flash hull in repo accent for 400ms.
        const amendFlashAt = Number(ship.amendFlashAt) || 0;
        const amendFlashElapsed = amendFlashAt ? Math.max(0, Date.now() - amendFlashAt) : Infinity;
        const flashing = amendFlashElapsed < 400;
        // 3.1 — force-push: the hull takes its hardest roll frame and sinks
        // in whole texels over the last 4 s of departure (no rotate).
        const sink = this._shipSink(ship);
        const forceSinkAlpha = alpha * sink.alphaScale;
        if (sink.px) ctx.translate(0, sink.px);
        if (flashing && this.motionScale > 0) {
            ctx.save();
            ctx.globalAlpha = 0.42 * (1 - amendFlashElapsed / 400);
            ctx.globalCompositeOperation = 'lighter';
            fillPixelEllipse(ctx, ship.x, ship.y - 2, 26, 14, profile.accent);
            ctx.restore();
        }
        if (!hullStrip(this.sprites?.assets, shipClass.spriteId)) {
            this._drawFallbackBoat(ctx, ship.x, ship.y, forceSinkAlpha, shipClass, profile);
        }
        this._drawShipClassOverlay(ctx, ship, forceSinkAlpha, profile, shipClass, zoom);
        this._drawRepoFlag(ctx, ship, zoom, forceSinkAlpha, profile, shipClass);
        // U-P6 — one small heraldry shield per repo fleet, on its lead.
        if (ship.repoFleetLead && ship.status === 'docked') {
            this._drawRepoShield(ctx, ship, zoom, forceSinkAlpha, profile, shipClass);
        }
        // 4.17 / V-R4: bunting to the next docked sibling of the same branch
        // squad, only from z2 up (at z1 it read as scribbles across hulls).
        if (ship.buntingNext && ship.status === 'docked' && zoom >= 2) {
            this._drawSquadBunting(ctx, ship, ship.buntingNext, zoom, forceSinkAlpha, profile);
        }
        ctx.restore();

        if (ship.status === 'departing' && ship.convoy) {
            if (ship.convoyNext) {
                this._drawReleaseConvoyLine(ctx, ship, ship.convoyNext, zoom, forceSinkAlpha, profile);
            }
            this._drawReleaseConvoyCue(ctx, ship, zoom, forceSinkAlpha, profile, shipClass);
        }

        // 3.1 — red spray particles puff at the keel during sinking (force-push).
        if (this.motionScale > 0 && ship.status === 'departing' && ship.pushForce === true) {
            const departMs = Math.max(1, Number(ship.departMsOverride) || FORCE_DEPARTURE_MS);
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            const sinkWindow = Math.min(4000, departMs * 0.5);
            const sinkProgress = Math.max(0, Math.min(1, (elapsed - (departMs - sinkWindow)) / sinkWindow));
            if (sinkProgress > 0) {
                this._drawRedSprayParticles(ctx, ship, sinkProgress);
            }
        }

        // Mist fade through the last 800ms of the approach to open water.
        if (this.motionScale > 0 && ship.status === 'departing') {
            const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            const mistStart = CAST_OFF_MS + departMs - MIST_FADE_MS;
            if (elapsed >= mistStart) {
                const t = Math.max(0, Math.min(1, (elapsed - mistStart) / MIST_FADE_MS));
                this._drawMistFade(ctx, ship.x, ship.y, t);
            }
        }

        if (ship.status === 'docked' || ship.status === 'anchored') {
            this._drawMooringTick(ctx, ship, zoom, profile, shipClass);
            // Cast-off phase: shrinking mooring tick + puff handled via _drawMooringTick variant.
        }
        if (ship.status === 'departing' && this.motionScale > 0 && Number(ship.elapsed || 0) < CAST_OFF_MS) {
            // mooring tick shrinks as the cast-off animates.
            this._drawMooringTick(ctx, ship, zoom, profile, shipClass, {
                shrink: 1 - Math.min(1, Number(ship.elapsed || 0) / CAST_OFF_MS),
                puff: true,
            });
        }
        // Rejected ships docked back with caution flag overlay.
        if (ship.status === 'docked' && ship.pushStatus === 'rejected') {
            this._drawRejectedCautionFlag(ctx, ship, zoom, shipClass);
        }
        if (ship.prShip) this._drawPullRequestPennant(ctx, ship, zoom, shipClass);
        // Boomerang collision flare at apex (~50% of phase 1).
        if (ship.status === 'rejecting' && ship.boomerangOutbound && Number(ship.boomerangPhaseProgress || 0) > 0.92) {
            this._drawCollisionFlare(ctx, ship.x, ship.y, Math.min(1, (Number(ship.boomerangPhaseProgress) - 0.92) / 0.08));
        }
        // 3.1 — force flag heraldic decorations (only on flagship/dreadnought).
        if (ship.pushForce === 'lease' && (shipClass.key === 'flagship' || shipClass.key === 'dreadnought')) {
            this._drawForceLeaseBanner(ctx, ship, zoom, shipClass);
        } else if (ship.pushForce === 'includes') {
            this._drawForceIncludesUnderline(ctx, ship, zoom, shipClass);
        }
        // Flagship/dreadnought hoist a secondary pennon at cast-off end.
        if ((shipClass.key === 'flagship' || shipClass.key === 'dreadnought')
            && ship.status === 'departing'
            && Number(ship.elapsed || 0) >= CAST_OFF_MS
            && Number(ship.elapsed || 0) < CAST_OFF_MS + 1200) {
            this._drawSecondaryPennon(ctx, ship, zoom, profile, shipClass);
        }
        // 3.6 — untethered (no remote) flagship gets a broken-rope chevron.
        if (ship.untetheredFlag) {
            this._drawUntetheredFlag(ctx, ship, zoom, profile, shipClass);
        }
        // 3.6 — detached HEAD ships get a checkered band on the flag.
        if (ship.detachedHead && !ship.branch) {
            this._drawDetachedHeadBand(ctx, ship, zoom, shipClass);
        }
        // 3.6 — amended commits show a superscript on the flag.
        if (Number(ship.amendCount || 0) > 0) {
            this._drawAmendSuperscript(ctx, ship, zoom, shipClass);
        }
        // 3.2 — inbound pull/fetch ships carry crates per incoming-commit count.
        if (ship.isInbound && Number(ship.inboundCargoCount || 0) > 0) {
            this._drawInboundCrates(ctx, ship, zoom, profile, shipClass);
        }
        this._drawCommitPennant(ctx, ship, zoom, alpha, profile, shipClass);
        if ((zoom || 1) < 2 && !ship.repoFleetLead) this._drawCompactGlyph(ctx, ship, zoom, alpha, shipClass);
        // 3.6 — hover lore: hovered ship surfaces its commit subject as a cargo label.
        if (ship.id && ship.id === this.hoveredShipId) {
            this._drawHoverCargoLabel(ctx, ship, zoom, alpha, profile, shipClass);
        }
    }

    // v0.23 A3 / 3.8 — per-ship vertical bob in whole texels (positive = up),
    // phase-seeded off the ship id so a docked flock heaves out of sync.
    // Departing hulls heave harder. Zero under reduced motion.
    _shipBob(ship = {}) {
        if (this.motionScale <= 0) return 0;
        const phase = (stableHash(ship.id || '') % 1000) / 1000 * Math.PI * 2;
        const heave = ship.status === 'departing' ? 1.7 : 1;
        return Math.round(Math.sin(this.frame * 0.08 + phase) * 1.2 * heave);
    }

    // v0.23 A3 / 3.8 — hull roll in degrees (~±1.5°, ~±2.9° departing), a
    // slower off-phase sine so roll and bob never lock. It only selects one of
    // the five baked roll frames (rollFrameIndex); nothing rotates at draw
    // time. Upright under reduced motion.
    _shipRoll(ship = {}) {
        if (this.motionScale <= 0) return 0;
        const phase = (stableHash(ship.id || '') % 1000) / 1000 * Math.PI * 2;
        const heave = ship.status === 'departing' ? 1.9 : 1;
        return Math.sin(this.frame * 0.065 + phase + 0.7) * 1.5 * heave;
    }

    // Phase 3.6 — departing ships sink below the horizon on their last leg
    // and arrivals rise over it (_shipSink), fading through its far end; a
    // new commit fades in as it slides off its slipway.
    _shipAlpha(ship = {}) {
        if (ship.releaseSail) return ship.releaseAlpha ?? 1;
        if (ship.status === 'scuttling') return Math.max(0, 1 - Math.max(0, Number(ship.scuttleElapsed) || 0) / SCUTTLE_MS);
        if (ship.status === 'departing') return this._departureAlpha(ship);
        // A merged PR cutter is already in view at its mooring.
        if (ship.arrivingKind === 'pr-merge') return 1;
        if (ship.status === 'arriving') return horizonAlpha(ship.horizonProgress);
        return ship.launchAlpha ?? 1;
    }

    // 3.1 / 3.8 — a force-pushed hull sinks 16 texels over the last 4 s of
    // its departure, in whole texels, fading to 45 %, on its hardest roll.
    // Phase 3.6 — any other hull on the horizon stretch of its route sinks
    // whole texels below the waterline, hull first and masthead last.
    _shipSink(ship = {}) {
        if (!(this.motionScale > 0)) return NO_SINK;
        if (ship.status === 'departing' && ship.pushForce === true) {
            const departMs = Math.max(1, Number(ship.departMsOverride) || FORCE_DEPARTURE_MS);
            const sinkWindow = Math.min(4000, departMs * 0.5);
            const elapsed = Math.max(0, Number(ship.elapsed) || 0);
            const progress = Math.max(0, Math.min(1, (elapsed - (departMs - sinkWindow)) / sinkWindow));
            if (!(progress > 0)) return NO_SINK;
            return { progress, px: Math.round(16 * progress), alphaScale: 1 - progress * 0.55, force: true };
        }
        const horizon = Number(ship.horizonProgress) || 0;
        if (!(horizon > 0) || (ship.status !== 'departing' && ship.status !== 'arriving')) return NO_SINK;
        return { progress: horizon, px: Math.round(horizon * (this._hullLift(ship) + 1)), alphaScale: 1, force: false };
    }

    // 3.8 — the whole-texel hull pose the harbor-hulls category draws: roll
    // frame, bob, sink, a 4-step alpha, the V wake while under way, and the
    // repo-accent livery stripe on skiffs (baked into a cached strip copy).
    _hullPose(ship) {
        const shipClass = harborShipClass(ship);
        let strip = this._hullStripFor(ship, shipClass);
        if (!strip) return null;
        const sink = this._shipSink(ship);
        let alpha = Math.round(this._shipAlpha(ship) * sink.alphaScale * 4) / 4;
        if (alpha <= 0) return null;
        if (shipClass.key === 'skiff') {
            const accent = trafficProfile(ship.project, ship.branch).accent;
            strip = liveryStrip(strip, accent, 4 + (stableHash(`${ship.id || ''}:skiff`) % 4));
        }
        // 8.2 — the release sloop comes and goes in whole texels.
        if (ship.releaseSail && alpha < 1) {
            strip = releaseRevealStrip(strip, alpha);
            alpha = 1;
        }
        const frame = sink.force ? 4 : rollFrameIndex(this._shipRoll(ship));
        // 5.3 — lamps from dusk to dawn (a pack ghost's fade out included).
        // M05-5 riding lights: moored, one anchor light (the masthead); under
        // way, every lamp, lit in one held step as the ship casts off. Keyed
        // on the ship's own motion, never on agents.
        const allLamps = this._lampsLit ? hullLampStrip(this.sprites?.assets, strip) : null;
        const lamps = allLamps && !this._shipUnderWay(ship) ? anchorLampStrip(allLamps, strip) : allLamps;
        return {
            id: ship.id || `${ship.x},${ship.y}`,
            strip,
            lamps,
            direction: strip.direction,
            bowX: strip.bowX,
            frame,
            x: ship.x,
            y: ship.y,
            bob: this._shipBob(ship),
            sink: sink.px,
            alpha,
            // Past the horizon's near edge the V wake is lost with the hull.
            wake: this._shipUnderWay(ship) && !(sink.progress > 0.3 && !sink.force) ? this._wakeHeading(ship, shipClass) : null,
        };
    }

    // Heading from the route sample `_shipDrawable` stored: the tail point
    // lies astern on every course.
    _wakeHeading(ship, shipClass) {
        const dirX = ship.x - ship.tailX;
        const dirY = ship.y - ship.tailY;
        // The V runs from the bow: fresh (under the hull) to the stern, then a
        // class-scaled open-water tail that ages out in its 4 steps.
        const strip = this._hullStripFor(ship, shipClass);
        const hold = strip ? Math.round(strip.frameWidth * 0.8) : 20;
        return { dirX, dirY, hold, length: hold + 24 + Math.round(shipClass.wakeScale * 12) };
    }

    // A hull is under way (throws a V wake) while it sails a route: departing
    // past cast-off, rejecting, cancelling, arriving, or mid storage transfer.
    _shipUnderWay(ship = {}) {
        if (ship.releaseSail) return ship.releaseWake === true;
        if (!Number.isFinite(ship.tailX) || !Number.isFinite(ship.tailY)) return false;
        if (Math.abs(ship.x - ship.tailX) + Math.abs(ship.y - ship.tailY) < 0.5) return false;
        if (ship.storageTransfer) return true;
        if (ship.status === 'departing') return !ship.castingOff && ship.progress > 0.002 && ship.progress < 0.97;
        return ship.status === 'rejecting' || ship.status === 'cancelling' || ship.status === 'arriving';
    }

    // 3.8 — one harbor-hulls item per drawn ship, at the ship drawable's
    // painter sortY, carrying its pose and (for the resident path) its
    // records. Items are pooled per ship id.
    enumerateHullDrawables(now = Date.now()) {
        const drawables = this.enumerateDrawables(now);
        const items = this._hullItems;
        items.length = 0;
        const pool = this._hullItemPool;
        for (const drawable of drawables) {
            const ship = drawable.payload;
            if (ship?.type !== 'ship') continue;
            const pose = this._hullPose(ship);
            if (!pose) continue;
            let item = pool.get(pose.id);
            if (!item) {
                item = { kind: 'harbor-hulls', id: pose.id, sortY: 0, x: 0, y: 0, pose: null, records: [] };
                pool.set(pose.id, item);
            }
            item.sortY = drawable.sortY;
            item.x = ship.x;
            item.y = ship.y;
            item.pose = pose;
            item.fleetLead = ship.repoFleetLead === true;
            hullRecords(pose, item.records);
            items.push(item);
        }
        if (pool.size > items.length * 2 + 32) {
            const live = new Set(items.map(item => item.id));
            for (const id of pool.keys()) if (!live.has(id)) pool.delete(id);
        }
        return items;
    }

    _drawShipClassOverlay(ctx, ship, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship), zoom = 1) {
        if (hullStrip(this.sprites?.assets, shipClass.spriteId)) {
            this._drawShipTierBadge(ctx, ship, alpha, profile, shipClass, zoom);
            return;
        }

        // No hull art (asset missing or no sprite system): a procedural
        // stand-in at scale 1.
        const scale = 1;
        const cargoRows = Math.max(0, Number(shipClass.cargoRows || 0));
        const mastCount = Math.max(1, Number(shipClass.mastCount || 1));
        const bob = this._shipBob(ship);
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        ctx.lineWidth = Math.max(1, Math.round(1.2 * scale));

        if (scale > 1.02) {
            const deckY = ship.y - (13 + bob) * scale;
            ctx.fillStyle = 'rgba(27, 38, 42, 0.82)';
            ctx.strokeStyle = 'rgba(245, 217, 139, 0.62)';
            ctx.beginPath();
            ctx.moveTo(ship.x - 24 * scale, deckY + 11 * scale);
            ctx.lineTo(ship.x + 24 * scale, deckY - 1 * scale);
            ctx.lineTo(ship.x + 30 * scale, deckY + 7 * scale);
            ctx.lineTo(ship.x - 18 * scale, deckY + 19 * scale);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = profile.accent;
            ctx.fillRect(Math.round(ship.x - 18 * scale), Math.round(deckY + 6 * scale), Math.max(2, Math.round(36 * scale)), Math.max(1, Math.round(2 * scale)));
        } else {
            const trim = Number(shipClass.trim || 0);
            const deckY = ship.y - (8 + bob) * scale;
            ctx.fillStyle = trim % 2 === 0 ? profile.accent : 'rgba(245, 217, 139, 0.86)';
            ctx.fillRect(Math.round(ship.x - 15 * scale), Math.round(deckY + 7 * scale), Math.max(8, Math.round(24 * scale)), Math.max(1, Math.round(2 * scale)));
            if (trim >= 2) {
                ctx.fillStyle = '#8a5530';
                ctx.strokeStyle = 'rgba(32, 20, 14, 0.78)';
                const crateX = Math.round(ship.x - 7 * scale);
                const crateY = Math.round(ship.y - (16 + bob) * scale);
                ctx.fillRect(crateX, crateY, Math.max(5, Math.round(7 * scale)), Math.max(4, Math.round(6 * scale)));
                ctx.strokeRect(crateX + 0.5, crateY + 0.5, Math.max(5, Math.round(7 * scale)) - 1, Math.max(4, Math.round(6 * scale)) - 1);
            }
        }

        for (let i = 0; i < cargoRows; i++) {
            const row = Math.floor(i / 2);
            const side = i % 2 === 0 ? -1 : 1;
            const w = (8 + row * 2) * scale;
            const h = (7 + row) * scale;
            const x = Math.round(ship.x + side * (5 + row * 4) * scale - w / 2);
            const y = Math.round(ship.y - (19 + row * 7 + bob) * scale);
            ctx.fillStyle = i === 0 ? '#8a5530' : '#6f472d';
            ctx.strokeStyle = 'rgba(32, 20, 14, 0.86)';
            ctx.fillRect(x, y, Math.round(w), Math.round(h));
            ctx.strokeRect(x + 0.5, y + 0.5, Math.round(w) - 1, Math.round(h) - 1);
            ctx.fillStyle = profile.accent;
            ctx.fillRect(x + Math.round(2 * scale), y + Math.round(3 * scale), Math.max(2, Math.round(w - 4 * scale)), Math.max(1, Math.round(scale)));
        }

        if (shipClass.key !== 'skiff') for (let i = 0; i < mastCount; i++) {
            const mastX = ship.x + (i === 0 ? 2 : -13) * scale;
            const mastTop = ship.y - (39 + i * 5 + bob) * scale;
            const mastBase = ship.y - (13 + bob) * scale;
            ctx.strokeStyle = 'rgba(30, 22, 16, 0.92)';
            ctx.lineWidth = Math.max(1, Math.round(2 * scale));
            ctx.beginPath();
            ctx.moveTo(Math.round(mastX), Math.round(mastBase));
            ctx.lineTo(Math.round(mastX), Math.round(mastTop));
            ctx.stroke();
            ctx.fillStyle = i === 0 ? 'rgba(238, 230, 189, 0.94)' : 'rgba(177, 209, 214, 0.90)';
            ctx.strokeStyle = 'rgba(53, 69, 70, 0.78)';
            ctx.beginPath();
            ctx.moveTo(mastX + 1 * scale, mastTop + 4 * scale);
            ctx.lineTo(mastX + (15 - i * 3) * scale, mastTop + (15 + i * 2) * scale);
            ctx.lineTo(mastX + 1 * scale, mastTop + (22 + i * 3) * scale);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = profile.accent;
            ctx.fillRect(Math.round(mastX + 3 * scale), Math.round(mastTop + (12 + i * 2) * scale), Math.max(5, Math.round(11 * scale)), Math.max(1, Math.round(2 * scale)));
        }

        this._drawShipTierBadge(ctx, ship, alpha, profile, shipClass, zoom);

        if (shipClass.key === 'galleon' || shipClass.key === 'dreadnought' || shipClass.key === 'flagship') {
            const railY = ship.y - (3 + bob) * scale;
            ctx.strokeStyle = 'rgba(244, 220, 151, 0.72)';
            ctx.lineWidth = Math.max(1, Math.round(1.4 * scale));
            ctx.beginPath();
            ctx.moveTo(ship.x - 28 * scale, railY + 11 * scale);
            ctx.lineTo(ship.x + 33 * scale, railY - 3 * scale);
            ctx.stroke();
            ctx.fillStyle = profile.accent;
            const lanternCount = shipClass.key === 'flagship' ? 5 : 3;
            for (let i = 0; i < lanternCount; i++) {
                const t = lanternCount === 1 ? 0 : i / (lanternCount - 1);
                const lx = ship.x + (-23 + t * 48) * scale;
                const ly = railY + (8 - t * 11) * scale;
                ctx.fillRect(Math.round(lx), Math.round(ly), Math.max(2, Math.round(3 * scale)), Math.max(2, Math.round(3 * scale)));
            }
        }

        ctx.restore();
    }

    // Phase 3.5 — the hull strip in the view the ship faces (`heading`, set
    // by _settleShipMotion; SW until it has one).
    _hullStripFor(ship, shipClass = harborShipClass(ship)) {
        return hullStrip(this.sprites?.assets, shipClass.spriteId, ship.heading || 'sw');
    }

    // 3.8 — the hull's height above its waterline in world px (the strip's
    // waterline anchor), falling back to the class table.
    _hullLift(ship, shipClass = harborShipClass(ship)) {
        const strip = this._hullStripFor(ship, shipClass);
        return strip ? strip.anchorY : Math.max(0, Number(shipClass.labelLift || 0));
    }

    // 3.8 — plates sit above the hull and its masthead flag at every zoom:
    // screen px (relative to the waterline anchor, zoom cancelled) of the
    // flag's top (the hull's top edge while the strip loads), 4 px up.
    _plateBase(ship, shipClass, zoom) {
        const strip = this._hullStripFor(ship, shipClass);
        const flagTop = strip?.mastheads ? strip.mastheads[2][1] + FLAG_MAST_OVERLAP - 16 : 0;
        const lift = this._hullLift(ship, shipClass) - Math.min(0, flagTop);
        return -Math.round((lift + this._shipBob(ship)) * (zoom || 1)) - 4;
    }

    // At z1 only the repo fleet's lead keeps its pack badge.
    _hasShipBadge(ship, shipClass, zoom = 2) {
        if (ship.prShip) return false;
        if (zoom < 2 && !ship.repoFleetLead) return false;
        return Number(ship.visualPackSize) > 1 && Boolean(shipClass.badge);
    }

    // A titan pack's exact `Nx` count (it stands in for hidden hulls). Class
    // badges (`4+`) and the old `N⚓` fleet banner are retired (V-R4): the
    // lane lead's plate carries the lane's count.
    _drawShipTierBadge(ctx, ship, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship), zoom = 1) {
        if (!this._hasShipBadge(ship, shipClass, zoom)) return;
        const badge = shipClass.badge;
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        // C5 — screen-fixed plate: zoom cancelled, integer screen-pixel layout.
        ctx.translate(ship.x, ship.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_DISPLAY_FONT_8;
        const width = Math.max(18, measureLabelText(ctx, badge) + 8);
        const height = 14;
        const left = -Math.round(width / 2);
        const top = this._plateBase(ship, shipClass, zoom) - height;
        // A pack badge over the Harbor house or a pier deck stays hidden (the
        // lane lead's plate still carries the count); else it claims its box.
        const z = zoom || 1;
        const box = { x0: ship.x + (left - 1) / z, x1: ship.x + (left + width + 1) / z, y0: ship.y + (top - 1) / z, y1: ship.y + (top + height + 1) / z };
        if (this._plateOverScenery(box)) {
            ctx.restore();
            return;
        }
        this._plateBoxes.push(box);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = 'rgba(24, 33, 36, 0.92)';
        ctx.fillRect(left, top, width, height);
        ctx.fillStyle = '#f4df9f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(badge, 0, top + 11);
        ctx.restore();
    }

    _drawHarborCrate(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const bob = this._shipBob(ship);
        const shipLift = Math.max(0, Number(shipClass.labelLift || 0)) * 0.35;
        const x = Math.round(ship.x - (18 + shipLift * 0.35) * s);
        const y = Math.round(ship.y - (19 + bob + shipLift) * s);
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        if (this.sprites) {
            this.sprites.drawSprite(ctx, 'prop.harborCrates', x, y + 11 * s, { alpha: 0.96 * alpha });
        } else {
            ctx.fillStyle = '#8a5530';
            ctx.strokeStyle = '#2d1c12';
            ctx.lineWidth = Math.max(1, Math.round(1.5 * s));
            ctx.fillRect(x - 9 * s, y - 7 * s, 18 * s, 14 * s);
            ctx.strokeRect(x - 9 * s + 0.5, y - 7 * s + 0.5, 18 * s - 1, 14 * s - 1);
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(Math.round(x - 7 * s), Math.round(y - 1 * s), Math.max(1, Math.round(14 * s)), Math.max(1, Math.round(2 * s)));
        ctx.restore();
    }

    _departureAlpha(ship) {
        if (ship.pushForce !== true && Number.isFinite(Number(ship.horizonProgress))) return horizonAlpha(ship.horizonProgress);
        const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
        const elapsed = Number.isFinite(Number(ship.elapsed))
            ? Number(ship.elapsed)
            : CAST_OFF_MS + Math.max(0, Number(ship.progress) || 0) * departMs;
        const arrivalAt = CAST_OFF_MS + departMs;
        const fadeStart = Math.max(CAST_OFF_MS, arrivalAt - EXIT_FADE_MS);
        if (elapsed <= fadeStart) return 1;
        const fadeDuration = Math.max(1, arrivalAt - fadeStart);
        return Math.max(0, Math.min(1, 1 - (elapsed - fadeStart) / fadeDuration));
    }

    _drawMooringTick(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship), options = {}) {
        const s = 1 / Math.max(1, zoom || 1);
        const style = PUSH_STATUS_STYLE[ship.pushStatus] || PUSH_STATUS_STYLE.success;
        const offsetX = Math.max(0, Number(shipClass.flagOffsetX || 0));
        const offsetY = Math.max(0, Number(shipClass.flagOffsetY || 0)) * 0.45;
        const shrink = Math.max(0, Math.min(1, Number(options.shrink ?? 1)));
        if (shrink <= 0.02 && !options.puff) return;
        ctx.save();
        ctx.fillStyle = ship.pushStatus ? style.accent : profile.accent;
        const fullHeight = Math.max(1, Math.round(5 * s));
        const height = Math.max(1, Math.round(fullHeight * shrink));
        const baseY = Math.round(ship.y - (23 + offsetY) * s) + (fullHeight - height);
        ctx.fillRect(Math.round(ship.x + (17 + offsetX) * s), baseY, Math.max(1, Math.round(2 * s)), height);
        // Small puff when cast-off begins shrinking the mooring tick.
        if (options.puff && this.motionScale > 0) {
            ctx.globalAlpha = 0.45 * (1 - (1 - shrink));
            ctx.fillStyle = 'rgba(225, 225, 225, 0.65)';
            const px = Math.round(ship.x + (17 + offsetX) * s);
            for (let i = 0; i < 4; i++) {
                const dx = ((i % 2 === 0) ? -1 : 1) * (1 + i) * s;
                const dy = -i * 1.5 * s;
                ctx.fillRect(px + dx, baseY + dy, Math.max(1, Math.round(1.5 * s)), Math.max(1, Math.round(1.5 * s)));
            }
        }
        ctx.restore();
    }

    // 3.1 / 6.5 — a yellow pennant hoisted above the flagship's flag for
    // --force-with-lease (the shared pixel strip, flying downwind).
    _drawForceLeaseBanner(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 14;
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y + 14, {
            accent: '#ffd34a',
            rim: '#281c08',
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 1 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // W7.9 — the PR cutter's one mark: a parchment pennant hoisted above its
    // repo flag (the shared pixel strip, flying downwind; the rest frame in
    // calm air and under reduced motion), so a PR reads apart from a
    // pull/fetch cutter on the same hull.
    _drawPullRequestPennant(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x, y } = this._flagAnchor(ship, shipClass);
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y, {
            accent: PR_PENNANT_CLOTH,
            rim: PR_PENNANT_RIM,
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 2 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // 3.1 — thin yellow underline beneath the flag for --force-if-includes.
    _drawForceIncludesUnderline(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        // One texel under the repo flag's cloth (cloth rows 2-10 of the strip).
        const { x, y } = this._flagAnchor(ship, shipClass);
        ctx.save();
        ctx.fillStyle = '#ffd34a';
        ctx.fillRect(x + 3, y + 11, 11, 1);
        ctx.restore();
    }

    // 3.1 — red spray particles puff at the keel during a force-push sink.
    _drawRedSprayParticles(ctx, ship, sinkProgress) {
        ctx.save();
        ctx.globalAlpha = Math.max(0.4, 0.85 * sinkProgress);
        ctx.fillStyle = '#ff4a39';
        for (let i = 0; i < 5; i++) {
            const seed = stableHash(`${ship.id || ''}:spray:${i}`);
            const angle = ((seed % 628) / 100) + this.frame * 0.02 * (i % 2 === 0 ? 1 : -1);
            const distance = 4 + ((seed >> 2) % 12) * sinkProgress;
            const sx = ship.x + Math.cos(angle) * distance;
            const sy = ship.y + 2 + Math.sin(angle) * distance * 0.4;
            ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
        }
        ctx.restore();
    }

    // Sea-mist fade at the ship's last position: three stepped scanline
    // courses (outer haze to dense core) instead of a radial gradient.
    _drawMistFade(ctx, x, y, t) {
        const radius = 38 + t * 18;
        ctx.save();
        ctx.globalAlpha = 0.16 * t;
        fillPixelEllipse(ctx, x, y, radius, radius * 0.55, 'rgb(214, 222, 228)');
        ctx.globalAlpha = 0.2 * t;
        fillPixelEllipse(ctx, x, y, radius * 0.6, radius * 0.6 * 0.55, 'rgb(214, 222, 228)');
        ctx.globalAlpha = 0.26 * t;
        fillPixelEllipse(ctx, x, y, radius * 0.3, radius * 0.3 * 0.55, 'rgb(220, 224, 230)');
        ctx.restore();
    }

    // Secondary pennon hoisted on flagship/dreadnought at cast-off end (6.5:
    // the shared pixel strip, flying downwind).
    _drawSecondaryPennon(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 21;
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y + 14, {
            accent: profile.accent,
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 2 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // Caution pennant on a rejected ship (6.5: the shared pixel strip in the
    // rejected status colour). The caution beat is a V4 palette step, not a
    // fade: every 2 s the cloth swaps to its rim tone for one 0.5 s step on
    // the pennant clock; reduced motion holds the rest tones.
    _drawRejectedCautionFlag(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 7;
        const style = PUSH_STATUS_STYLE.rejected;
        const rim = style.panelBorder || '#ff755d';
        const step = Math.floor(currentPennantTime() / CAUTION_BEAT_STEP_MS) + (Number(ship.berthIndex) || 0);
        const lit = this.motionScale > 0 && ((step % 4) + 4) % 4 === 3;
        const windX = currentPennantWind();
        ctx.save();
        drawPennant(ctx, x, y + 14, {
            accent: lit ? rim : style.accent,
            rim: lit ? style.accent : rim,
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase: 3 }),
            windX,
            withPole: false,
        });
        ctx.restore();
    }

    // Red collision flare burst at the boomerang turn point.
    _drawCollisionFlare(ctx, x, y, t) {
        ctx.save();
        ctx.globalAlpha = Math.max(0.4, 0.95 * (1 - t));
        ellipseArcDots(ctx, x, y - 12, 8 + t * 12, 8 + t * 12, { step: 3, dot: 2, color: '#ff5a3c' });
        ctx.fillStyle = '#ff7a55';
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            const r = 10 + t * 14;
            ctx.fillRect(Math.round(x + Math.cos(angle) * r), Math.round(y - 12 + Math.sin(angle) * r * 0.5), 2, 2);
        }
        ctx.restore();
    }

    // 3.6 / 6.5 — broken-rope chevron above the repo flag for untethered (no
    // remote): two whole-texel polylines on the art grid, riding the flag's
    // pole and bob and mirrored with the wind like the cloth.
    _drawUntetheredFlag(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const { x, y: top } = this._flagAnchor(ship, shipClass);
        const y = top - 16;
        const dir = currentPennantWind() < 0 ? -1 : 1;
        ctx.save();
        ctx.fillStyle = '#d6dadf';
        for (const run of UNTETHERED_CHEVRON) {
            for (let i = 1; i < run.length; i++) {
                pixelLine(ctx, x + dir * run[i - 1][0], y + run[i - 1][1], x + dir * run[i][0], y + run[i][1]);
            }
        }
        ctx.restore();
    }

    // 3.6 / 6.5 — checkered black-and-white band across the flag's hoist for
    // detached HEAD: five 2×2-texel cells on the cloth side of the pole.
    _drawDetachedHeadBand(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const { x: pole, y: top } = this._flagAnchor(ship, shipClass);
        const y = top + 4;
        const mirror = currentPennantWind() < 0;
        ctx.save();
        for (let i = 0; i < 5; i++) {
            ctx.fillStyle = i % 2 === 0 ? '#1a1a1a' : '#f4f0e6';
            ctx.fillRect(mirror ? pole - 2 - i * 2 : pole + 2 + i * 2, y, 2, 2);
        }
        ctx.restore();
    }

    // 3.6 — small superscript on the flag indicating amend count (²).
    _drawAmendSuperscript(ctx, ship, zoom, shipClass = harborShipClass(ship)) {
        const count = Math.max(1, Number(ship.amendCount || 0));
        if (count <= 0) return;
        const labels = ['', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
        const text = count > 1 ? (labels[count] || `^${count}`) : '¹';
        // C5 — screen-fixed glyphs at the repo flag's fly end (world anchor).
        const { x, y } = this._flagAnchor(ship, shipClass);
        ctx.save();
        ctx.translate(x + 21, y + 2);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.fillStyle = '#f6cf60';
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, text, 0, 7);
        ctx.restore();
    }

    // 3.2 — small crates ride along inbound ships proportional to incoming commit count.
    _drawInboundCrates(ctx, ship, zoom, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const count = Math.min(4, Math.max(1, Number(ship.inboundCargoCount || 0)));
        const baseY = Math.round(ship.y - Math.max(8, this._hullLift(ship, shipClass) * 0.4) - this._shipBob(ship));
        ctx.save();
        ctx.fillStyle = '#8a5530';
        ctx.strokeStyle = '#2d1c12';
        ctx.lineWidth = Math.max(1, Math.round(1 * s));
        for (let i = 0; i < count; i++) {
            const cx = Math.round(ship.x - 8 * s + i * 5 * s);
            const cy = baseY - i * 2 * s;
            ctx.fillRect(cx, cy, Math.round(4 * s), Math.round(4 * s));
            ctx.strokeRect(cx + 0.5, cy + 0.5, Math.round(4 * s) - 1, Math.round(4 * s) - 1);
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(Math.round(ship.x - 8 * s), Math.round(baseY + 5 * s), Math.max(2, Math.round(count * 5 * s)), 1);
        ctx.restore();
    }

    // 3.7 — single channel buoy pulsing in the active storage-transfer repo accent.
    _drawLagoonChannelBuoy(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const profile = payload.profile;
        const muted = !profile;
        const accent = muted ? '#8c95a0' : profile.accent;
        // 3.9 — lantern pulse snapped onto the shared 'harbor' band; muted or
        // reduced-motion buoys hold the legacy static alpha.
        const pulse = (!muted && this.motionScale > 0)
            ? pulseAlpha('harbor', this.frame, this.motionScale, 0.55, 0.95)
            : 0.65;
        const x = Math.round(payload.x);
        const y = Math.round(payload.y);
        ctx.save();
        // Base — pylon shape rooted into the water.
        ctx.fillStyle = 'rgba(38, 50, 58, 0.95)';
        ctx.strokeStyle = 'rgba(15, 22, 28, 0.92)';
        ctx.lineWidth = Math.max(1, Math.round(1 * s));
        ctx.fillRect(x - 4 * s, y - 2 * s, 8 * s, 6 * s);
        ctx.strokeRect(x - 4 * s + 0.5, y - 2 * s + 0.5, 8 * s - 1, 6 * s - 1);
        // Lantern — pulses in the active repo accent (or muted when idle).
        ctx.globalAlpha = pulse;
        ctx.fillStyle = accent;
        ctx.fillRect(x - 3 * s, y - 10 * s, 6 * s, 7 * s);
        ctx.globalAlpha = Math.min(1, pulse * 1.2);
        ctx.fillStyle = muted ? 'rgba(140, 149, 160, 0.6)' : 'rgba(255, 246, 200, 0.9)';
        ctx.fillRect(x - 2 * s, y - 9 * s, 4 * s, 5 * s);
        // Glow halo when active: two stepped pixel discs, additive.
        if (!muted) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.13 * pulse;
            fillPixelEllipse(ctx, x, y - 7 * s, 22 * s, 22 * s, accent);
            ctx.globalAlpha = 0.19 * pulse;
            fillPixelEllipse(ctx, x, y - 7 * s, 11 * s, 11 * s, accent);
            ctx.globalCompositeOperation = 'source-over';
        }
        // v0.23 A5 — cast-off flare: an additive stepped disc in the departing
        // push's accent, even when the buoy is otherwise idle. Reduced motion
        // leaves castOff at 0 so nothing is drawn.
        const castOff = Math.max(0, Number(payload.castOff) || 0);
        if (castOff > 0) {
            const ringAccent = payload.castOffAccent || accent;
            const r = (16 + 18 * castOff) * s;
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.2 * castOff;
            fillPixelEllipse(ctx, x, y - 7 * s, r, r, ringAccent);
            ctx.globalAlpha = 0.3 * castOff;
            fillPixelEllipse(ctx, x, y - 7 * s, r * 0.5, r * 0.5, ringAccent);
            ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
    }

    // 6.5 / 3.8 — the flag hoist: the repo flag's pole stands on the hull's
    // masthead (the manifest `masthead` of the strip, turned with the roll
    // frame it draws, riding its bob), its foot FLAG_MAST_OVERLAP texels down
    // the mast so staff and mast read as one spar. Returns the pennant box
    // top-left x at the pole and its top row (the pole foot is y + 16); every
    // other mark on the flag hangs off this. A hull still loading its strip
    // falls back to the class offsets.
    _flagAnchor(ship, shipClass = harborShipClass(ship)) {
        const bob = this._shipBob(ship);
        const strip = this._hullStripFor(ship, shipClass);
        if (!strip?.mastheads) {
            return {
                x: Math.round(ship.x + 13 + (shipClass.flagOffsetX || 0)),
                y: Math.round(ship.y - 31 - (shipClass.flagOffsetY || 0) - bob),
            };
        }
        const frame = this._shipSink(ship).force ? 4 : rollFrameIndex(this._shipRoll(ship));
        const [mx, my] = strip.mastheads[frame];
        return {
            x: Math.round(ship.x) - strip.anchorX + mx,
            y: Math.round(ship.y) - strip.anchorY - bob + my + FLAG_MAST_OVERLAP - 16,
        };
    }

    // U-P1 — the masthead pennon: its cloth is the repo colour (the hue every
    // surface gives the repo) and its SHAPE is the branch: swallowtail for
    // the default branch, burgee for a feature branch, notched triangle for a
    // branch checked out in a linked worktree. Stepped at 4 fps downwind with
    // the one wind; the rest frame in calm air and under reduced motion.
    _drawRepoFlag(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const { x, y } = this._flagAnchor(ship, shipClass);
        const windX = currentPennantWind();
        const phase = stableHash(ship.id || '') % 4;
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        drawBranchPennon(ctx, x, y + 16, {
            accent: profile.accent,
            kind: ship.pennonKind || branchPennonKind(ship.branch, ship.worktree),
            frame: pennantFrame(currentPennantTime(), windX, { motion: this.motionScale > 0, phase }),
            windX,
        });
        ctx.restore();
    }

    // U-P6 / V-R4 — the repo's heraldry: one small shield (16 texels tall)
    // per fleet, on its lead, beside the hull at deck height so it never
    // covers the sails. Whole-texel row runs (no path): a dark field, a chief
    // and rim in the repo colour, and the collision-checked monogram (`CV`,
    // `CV2`) as a screen-fixed C5 glyph run.
    _drawRepoShield(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const label = String(ship.monogram || '').slice(0, 3);
        const h = 16;
        ctx.save();
        ctx.font = WORLD_BODY_FONT_11;
        const z = Math.max(1, zoom || 1);
        const w = Math.max(12, Math.min(20, Math.ceil((label ? measureLabelText(ctx, label) : 0) / z) + 4));
        const radius = harborShipCollisionRadius(ship);
        const cx = Math.round(ship.x - radius * 0.72 - w / 2);
        const top = Math.round(ship.y) - h - 6 - this._shipBob(ship);
        const runs = shieldRuns(w, h);
        ctx.globalAlpha = Math.max(0, alpha) * 0.96;
        ctx.fillStyle = 'rgba(8, 12, 16, 0.55)';
        for (const [y, x0, x1] of runs) ctx.fillRect(cx + x0 + 1, top + y + 1, x1 - x0, 1);
        ctx.fillStyle = profile.accent || '#f6d384';
        ctx.fillRect(cx + runs[0][1] - 1, top - 1, runs[0][2] - runs[0][1] + 2, 1);
        for (const [y, x0, x1] of runs) ctx.fillRect(cx + x0 - 1, top + y, x1 - x0 + 2, 1);
        ctx.fillRect(cx - 1, top + h, 2, 1);
        ctx.fillStyle = profile.panel || 'rgba(24, 33, 36, 0.94)';
        for (const [y, x0, x1] of runs) if (y >= 3) ctx.fillRect(cx + x0, top + y, x1 - x0, 1);
        ctx.fillStyle = profile.accent || '#f6d384';
        for (const [y, x0, x1] of runs) if (y < 3) ctx.fillRect(cx + x0, top + y, x1 - x0, 1);
        ctx.restore();
        if (!label) return;
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.96;
        ctx.translate(cx, top + Math.round(h * 0.62));
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        ctx.fillStyle = profile.labelText || '#f4df9f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        this._applyReadableTextShadow(ctx);
        ctx.fillText(label, 0, 4);
        ctx.restore();
    }

    // 4.17 / 6.5: static bunting line between two adjacent docked ships in
    // the same squad, on the art grid: a sagging line of whole texels (each
    // step joined by pixelLine, no stroke) with a hanging pixel pennant at
    // its lowest point. No animation — reduced motion shows the same line.
    _drawSquadBunting(ctx, ship, neighbor, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch)) {
        if (!neighbor || !Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) return;
        const lift = 28; // anchor lift above each ship's deck, texels
        const ax = Math.round(ship.x);
        const ay = Math.round(ship.y - lift);
        const bx = Math.round(neighbor.x);
        const by = Math.round(neighbor.y - lift);
        const sag = Math.round(Math.min(14, Math.hypot(bx - ax, by - ay) * 0.18));
        const steps = Math.max(1, Math.abs(bx - ax), Math.abs(by - ay));
        const at = (t) => [Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t + 4 * sag * t * (1 - t))];
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.82;
        ctx.fillStyle = profile.accent || '#f6d384';
        let [px0, py0] = at(0);
        for (let i = 1; i <= steps; i++) {
            const [px1, py1] = at(i / steps);
            if (px1 !== px0 || py1 !== py0) pixelLine(ctx, px0, py0, px1, py1);
            px0 = px1;
            py0 = py1;
        }
        // Small pennant at the lowest point for a flag-line feel: a hanging
        // triangle, rows filled on whole texels.
        const [px, py] = at(0.5);
        fillConvex(ctx, [[px - 3, py + 1], [px + 3, py + 1], [px, py + 6]]);
        ctx.restore();
    }

    _drawReleaseConvoyLine(ctx, ship, neighbor, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch)) {
        if (!neighbor || !Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) return;
        const s = 1 / Math.max(1, zoom || 1);
        const ax = ship.x;
        const ay = ship.y - 18 * s;
        const bx = neighbor.x;
        const by = neighbor.y - 18 * s;
        const distance = Math.hypot(bx - ax, by - ay);
        if (distance < 8) return;
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.50;
        ctx.strokeStyle = profile.accent || '#f6d384';
        ctx.lineWidth = Math.max(1, Math.round(1.2 * s));
        ctx.setLineDash([Math.max(4, 6 * s), Math.max(3, 5 * s)]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.restore();
    }

    _drawReleaseConvoyCue(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const s = 1 / Math.max(1, zoom || 1);
        const lift = Math.max(0, Number(shipClass.labelLift || 0));
        const x = Math.round(ship.x - 15 * s);
        const y = Math.round(ship.y - (49 + lift * 0.55) * s);
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha) * 0.88;
        ctx.fillStyle = profile.accent || '#f6d384';
        for (let i = 0; i < 2; i++) {
            const dx = i * 9 * s;
            ctx.beginPath();
            ctx.moveTo(x + dx, y);
            ctx.lineTo(x + dx + 7 * s, y + 4 * s);
            ctx.lineTo(x + dx, y + 8 * s);
            ctx.closePath();
            ctx.fill();
        }
        if (ship.convoyLeader) {
            const count = Math.max(RELEASE_CONVOY_MIN_SHIPS, Number(ship.convoy?.visibleCount || ship.convoy?.count || 0));
            const label = `CVY ${count}`;
            // C5 — screen-fixed plate at the ship anchor, whole screen px.
            ctx.save();
            ctx.translate(ship.x, ship.y);
            ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
            snapScreenOrigin(ctx);
            ctx.font = WORLD_DISPLAY_FONT_8;
            const width = Math.max(36, measureLabelText(ctx, label) + 12);
            const height = 14;
            const left = -Math.round(width / 2);
            const top = -Math.round(49 + lift * 0.55) - 17;
            ctx.fillStyle = profile.accent || '#f6d384';
            ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
            ctx.fillStyle = 'rgba(24, 42, 39, 0.88)';
            ctx.fillRect(left, top, width, height);
            ctx.fillStyle = profile.labelText || '#fff0b8';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            this._fillReadableText(ctx, label, 0, top + 11);
            ctx.restore();
        }
        ctx.restore();
    }

    // U-P6 / V-R4 — plates carry meaning, not hashes. A repo fleet's lead
    // flies `repo · branch` and its lane count; from z2 the other lane leads
    // fly `branch` and their count, and the other hulls their short SHA. A
    // failed or rejected hull always shows its plate in the failure ink. No
    // plate overlaps another: lead plates reserve theirs first
    // (beginPlateFrame), the rest take the first free lift or stay hidden.
    _drawCommitPennant(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const spec = this._plateSpec(ship, zoom);
        if (!spec) return;
        const z = zoom || 1;
        const bob = this._shipBob(ship);
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        ctx.translate(ship.x, ship.y - bob);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const text = fitLabelText(ctx, spec.text, spec.lead ? 168 : spec.pinned ? 120 : 70);
        const countText = spec.lead ? String(spec.count) : '';
        const countWidth = countText ? Math.ceil(measureLabelText(ctx, countText)) + 8 : 0;
        const width = Math.ceil(measureLabelText(ctx, text)) + 12 + countWidth;
        const height = 15;
        const centred = -Math.round(width / 2);
        const base = this._plateBase(ship, shipClass, z) + Math.round(bob * z) - (this._hasShipBadge(ship, shipClass, z) ? 18 : 0) - height;
        const place = this._claimPlate(ship, centred, base, width, height, z, spec);
        if (!place) {
            ctx.restore();
            return;
        }
        const { lift } = place;
        const left = centred + place.dx;
        const top = base - lift;
        const failedAccent = spec.failed ? (PUSH_STATUS_STYLE[ship.pushStatus] || PUSH_STATUS_STYLE.failed).accent : null;
        ctx.fillStyle = failedAccent || profile.accent;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = profile.panel || 'rgba(24, 42, 39, 0.9)';
        ctx.fillRect(left, top, width, height);
        ctx.fillStyle = failedAccent || profile.accent;
        ctx.fillRect(left, top, 2, height);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = failedAccent || (spec.lead ? (profile.labelText || profile.accent) : 'rgba(244, 232, 190, 0.86)');
        this._fillReadableText(ctx, text, left + 6, top + 11);
        if (countText) {
            const cellLeft = left + width - countWidth;
            ctx.fillStyle = failedAccent || profile.accent;
            ctx.fillRect(cellLeft, top, countWidth, height);
            ctx.fillStyle = profile.panel || 'rgba(24, 42, 39, 0.9)';
            ctx.fillText(countText, cellLeft + 4, top + 11);
        }
        // A 1-px stem from the plate's foot down to the masthead (for a
        // plate set aside, from its nearer edge).
        if (lift > 0) {
            ctx.fillStyle = failedAccent || profile.accent;
            const stemX = Math.max(left + 2, Math.min(left + width - 3, 0));
            ctx.fillRect(stemX, top + height + 1, 1, lift);
        }
        ctx.restore();
    }

    // z1 — a failed or rejected hull, or a PR cutter, carries a 7 × 9
    // screen-px glyph over its masthead instead of a plate: `!` on the
    // failure (or caution) colour, a parchment tab for a pull request.
    _drawCompactGlyph(ctx, ship, zoom, alpha = 1, shipClass = harborShipClass(ship)) {
        const failed = ship.status === 'docked' && (ship.pushStatus === 'failed' || ship.pushStatus === 'rejected');
        if (!failed && !ship.prShip) return;
        const z = zoom || 1;
        ctx.save();
        ctx.globalAlpha = 0.96 * alpha;
        ctx.translate(ship.x, ship.y - this._shipBob(ship));
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        const top = this._plateBase(ship, shipClass, z) + Math.round(this._shipBob(ship) * z) - 9;
        const fill = failed ? (PUSH_STATUS_STYLE[ship.pushStatus] || PUSH_STATUS_STYLE.failed).accent : PR_PENNANT_CLOTH;
        ctx.fillStyle = failed ? 'rgba(20, 12, 10, 0.92)' : PR_PENNANT_RIM;
        ctx.fillRect(-4, top - 1, 9, 11);
        ctx.fillStyle = fill;
        ctx.fillRect(-3, top, 7, 9);
        ctx.fillStyle = failed ? 'rgba(20, 12, 10, 0.92)' : PR_PENNANT_RIM;
        if (failed) {
            ctx.fillRect(0, top + 1, 1, 5);
            ctx.fillRect(0, top + 7, 1, 1);
        } else {
            ctx.fillRect(-1, top + 2, 3, 1);
            ctx.fillRect(-1, top + 4, 3, 1);
            ctx.fillRect(-1, top + 6, 2, 1);
        }
        ctx.restore();
    }

    // What a ship's plate says, or null when it shows none at this zoom.
    _plateSpec(ship, zoom = 1) {
        // W7.9 — a PR cutter always carries its pull identity.
        // z1 shows one plate per repo; everything else waits for z2 (a
        // failed hull and a PR cutter fly a compact glyph there instead).
        if (ship.prShip) return zoom < 2 ? null : { lead: false, pinned: true, text: commitPennantLabel(ship), count: 1, failed: false };
        const failed = ship.pushStatus === 'failed' || ship.pushStatus === 'rejected';
        const docked = ship.status === 'docked';
        if (docked && ship.repoFleetLead && zoom < 2) {
            const lanes = Number(ship.repoLaneCount) || 1;
            const text = `${middleTruncate(repoDisplayName(ship.project), 16)}${lanes > 1 ? ` · ${lanes} br` : ''}`;
            return { lead: true, text, count: Math.max(1, Number(ship.repoTotal) || Number(ship.repoDockCount) || 1), failed };
        }
        if (zoom < 2) return null;
        if (docked && ship.laneLead) {
            const branch = ship.branch ? middleTruncate(ship.branch, 16) : 'detached';
            const text = ship.repoFleetLead ? `${middleTruncate(repoDisplayName(ship.project), 14)} · ${branch}` : branch;
            return { lead: true, text, count: Math.max(1, Number(ship.repoDockCount) || 1), failed };
        }
        if (!failed && ship.showCommitLabel === false) return null;
        return { lead: false, text: shortGitLabel(commitPennantLabel(ship), 10, '…'), count: 1, failed };
    }

    // Plate placement for this frame. Lead plates use the lift their
    // reservation found; other plates take the first free lift (0, 18 or 36
    // screen px up), registering their box, or return null (not drawn). The
    // hovered ship's plate always draws.
    // Plate placement for this frame, `{ lift, dx }` (screen px) or null.
    // Candidates: above the masthead at three lifts, then on the water under
    // the hull (a negative lift: the plate's top 10 px below the waterline),
    // each centred, then set aside left and right. A plate never covers
    // another plate, a pier deck or the Harbor house (D2: fleets moor in the
    // pier channels). Lead plates use the slot their reservation found; a
    // repo fleet's lead, a PR cutter and the hovered hull always draw (at
    // the first candidate when none is free), any other plate stays hidden.
    _claimPlate(ship, left, base, width, height, zoom, spec) {
        if (spec.lead && this._leadPlateLift.has(ship.id)) return this._leadPlateLift.get(ship.id);
        const z = zoom || 1;
        const force = spec.forced || spec.pinned || ship.id === this.hoveredShipId;
        const aside = Math.round(width / 2) + 12;
        const candidates = [];
        for (const dx of [0, -aside, aside, 2 * aside]) {
            for (const lift of [0, 18, 36, base - 10, base - 28]) {
                candidates.push({ lift, dx, box: {
                    x0: ship.x + (left + dx - 2) / z,
                    x1: ship.x + (left + dx + width + 2) / z,
                    y0: ship.y + (base - lift - 2) / z,
                    y1: ship.y + (base - lift + height + 2) / z,
                } });
            }
        }
        const free = candidates.find(({ box }) => !this._plateBoxesHit(box) && !this._plateOverScenery(box));
        // A plate that must draw prefers water and decks clear of scenery
        // even where it meets another plate.
        const chosen = free || (force ? candidates.find(({ box }) => !this._plateOverScenery(box)) || candidates[0] : null);
        if (!chosen) return null;
        this._plateBoxes.push(chosen.box);
        return { lift: chosen.lift, dx: chosen.dx };
    }

    _plateBoxesHit(box) {
        return this._plateBoxes.some(other => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0);
    }

    // Whether a plate box (world px) lies over a pier deck or the Harbor
    // house's drawn pixels: sampled on a 5 × 3 grid.
    _plateOverScenery(box) {
        const house = this._harborHouseHit();
        for (let j = 0; j <= 2; j++) {
            const y = box.y0 + (box.y1 - box.y0) * j / 2;
            for (let i = 0; i <= 4; i++) {
                const x = box.x0 + (box.x1 - box.x0) * i / 4;
                const tile = toTile(x, y);
                if (HARBOR_PIER_DECKS.some(deck => tile.tileX >= deck.x0 && tile.tileX <= deck.x1 && tile.tileY >= deck.y0 && tile.tileY <= deck.y1)) return true;
                if (house && house(x, y)) return true;
            }
        }
        return false;
    }

    _harborHouseHit() {
        const sprites = this.sprites;
        if (typeof sprites?.hitTest !== 'function') return null;
        if (this._houseHit !== undefined) return this._houseHit;
        const def = BUILDING_DEFS.find(item => item.type === 'harbor');
        const anchor = def && sprites.assets?.getAnchor?.('building.harbor');
        if (!def || !anchor || !sprites.assets?.getMask?.('building.harbor')) return null;
        const center = buildingCenterToWorld(def);
        const dx = Math.round(center.x - anchor[0]);
        const dy = Math.round(center.y - anchor[1]);
        this._houseHit = (x, y) => sprites.hitTest('building.harbor', x, y, dx, dy);
        return this._houseHit;
    }

    // Once per frame (the scene category's enumerate): clear the plate boxes
    // and reserve the lane-lead plates first, fleet leads and failures
    // ahead, so a SHA plate never covers a fleet's name.
    beginPlateFrame(zoom = 1) {
        const z = Number(zoom) > 0 ? Number(zoom) : 1;
        this._plateBoxes.length = 0;
        this._leadPlateLift.clear();
        const leads = [];
        for (const entry of this._packedDockedEntries) {
            const ship = entry.drawable?.payload;
            if (!ship?.laneLead) continue;
            const spec = this._plateSpec(ship, z);
            if (spec?.lead) leads.push({ ship, spec });
        }
        leads.sort((a, b) => (Number(b.ship.repoFleetLead) - Number(a.ship.repoFleetLead))
            || (Number(b.spec.failed) - Number(a.spec.failed))
            || (b.ship.y - a.ship.y));
        const charWidth = this._plateCharWidth();
        for (const { ship, spec } of leads) {
            const shipClass = harborShipClass(ship);
            const width = Math.min(168, spec.text.length * charWidth) + 12 + String(spec.count).length * charWidth + 8;
            const left = -Math.round(width / 2);
            const base = this._plateBase(ship, shipClass, z) - (this._hasShipBadge(ship, shipClass, z) ? 18 : 0) - 15;
            // A repo fleet's lead always flies its name; another lane lead
            // with no free slot stays hidden this frame (null).
            this._leadPlateLift.set(ship.id, this._claimPlate(ship, left, base, width, 15, z, { forced: ship.repoFleetLead }));
        }
    }

    _plateCharWidth() {
        if (this._plateCharWidthPx) return this._plateCharWidthPx;
        let width = 6;
        if (typeof document !== 'undefined') {
            const ctx = document.createElement('canvas').getContext('2d');
            if (ctx) {
                ctx.font = WORLD_BODY_FONT_11;
                width = measureLabelText(ctx, 'abcdefghij') / 10 || width;
            }
        }
        this._plateCharWidthPx = width;
        return width;
    }

    // 3.6 — hover lore: cargo label above the hovered ship carrying the commit subject.
    _drawHoverCargoLabel(ctx, ship, zoom, alpha = 1, profile = trafficProfile(ship.project, ship.branch), shipClass = harborShipClass(ship)) {
        const label = shortGitLabel(this._hoverCargoText(ship), 44, '…');
        if (!label) return;
        const base = this._plateBase(ship, shipClass, zoom) - (this._hasShipBadge(ship, shipClass, zoom) ? 18 : 0);
        ctx.save();
        ctx.globalAlpha = Math.min(1, 0.96 * alpha);
        // C5 — screen-fixed plate: zoom cancelled, whole screen px, width
        // measured.
        ctx.translate(ship.x, ship.y);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const width = Math.max(54, measureLabelText(ctx, label) + 26);
        const height = 16;
        const left = -Math.round(width / 2);
        const top = base - 38 - height;
        ctx.fillStyle = profile.accent;
        ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        ctx.fillStyle = profile.panel || 'rgba(24, 42, 39, 0.92)';
        ctx.fillRect(left, top, width, height);
        this._drawRepoLabelIcon(ctx, left + 9, top + height / 2, 6, profile);
        ctx.fillStyle = profile.labelText || profile.accent;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, label, left + 17, top + 12);
        // Short stem tying the cargo label to its ship.
        ctx.fillStyle = profile.accent;
        ctx.fillRect(-1, top + height, 2, 6);
        ctx.restore();
    }

    // U-P9 — a pack names its size and newest subject (`14 commits · newest:
    // Fix plates`), a single hull its short SHA and subject.
    _hoverCargoText(ship = {}) {
        if (ship.prShip) return pullRequestShipLabel(ship);
        const packSize = Number(ship.visualPackSize);
        if (Number.isFinite(packSize) && packSize > 1) {
            const members = this._packMembers(ship);
            const newest = members.reduce((best, item) => ((item.eventTime || 0) > (best?.eventTime || 0) ? item : best), null) || ship;
            const subject = cachedCleanCommitSubject(newest.label || '');
            return `${Math.round(packSize)} commits${subject ? ` · newest: ${subject}` : ''}`;
        }
        const subject = cachedCleanCommitSubject(ship.label || '');
        const sha = commitIdFragment(ship.sha || '');
        return [sha, subject].filter(Boolean).join(' · ') || `commit ${commitPennantLabel(ship)}`;
    }

    // The docked ships one titan pack stands for: its lane's ships in dock
    // order, from the pack's start index to its end index.
    _packMembers(ship = {}) {
        const lane = [];
        for (const other of this.state.ships.values()) {
            if (other.status !== 'docked' || other.project !== ship.project) continue;
            if (normalizeRepoBranch(other.branch) !== normalizeRepoBranch(ship.branch)) continue;
            lane.push(other);
        }
        lane.sort((a, b) => ((a.eventTime || 0) - (b.eventTime || 0)) || String(a.id).localeCompare(String(b.id)));
        const start = Math.max(0, Number(ship.visualPackStartIndex) || 0);
        const end = Number.isFinite(Number(ship.visualPackEndIndex)) ? Number(ship.visualPackEndIndex) : start;
        return lane.slice(start, end + 1);
    }

    _drawFinaleEffect(ctx, effect) {
        const style = PUSH_STATUS_STYLE[effect.status] || PUSH_STATUS_STYLE.unknown;
        const progress = Math.max(0, Math.min(1, effect.progress || 0));
        const alpha = this.motionScale === 0 ? 0.78 : Math.max(0, 1 - progress);
        const wave = this.motionScale === 0 ? 0.55 : Math.sin(progress * Math.PI);
        const summary = toWorld(HARBOR_SUMMARY_TILE.tileX, HARBOR_SUMMARY_TILE.tileY);
        const count = Math.max(1, Number(effect.shipCount || 1));
        const intensity = Math.max(1, Math.min(4, Math.sqrt(count)));
        const burstCount = Math.min(28, 8 + count * 2);
        // 3.1 — force-push success uses a sinking whirlpool, not expanding rings.
        const forceSink = effect.status === 'success' && effect.force === true;

        ctx.save();
        ctx.globalCompositeOperation = (effect.status === 'cancelled' || forceSink) ? 'source-over' : 'screen';
        ctx.globalAlpha = Math.max(0.18, alpha);
        ctx.fillStyle = style.glow;

        if (effect.status === 'cancelled') {
            // 5.11 — soft grey expanding ring, low alpha. Reduced-motion: a single
            //        static ring at mid radius.
            const staticMotion = this.motionScale === 0;
            const radius = staticMotion ? 22 : (16 + progress * 18);
            ctx.globalAlpha = Math.max(0.12, alpha * 0.55);
            ellipseArcDots(ctx, effect.x, effect.y - 24, radius, radius, { step: 3, dot: 2, color: style.accent });
        } else if (forceSink) {
            // 3.1 — whirlpool: inward-spiraling dotted arcs (each ring's sweep
            // start turns with its progress) with red spray.
            const spirals = this.motionScale === 0 ? 1 : 3;
            for (let i = 0; i < spirals; i++) {
                const ringProgress = Math.max(0, Math.min(1, progress - i * 0.18));
                const ring = Math.max(6, 48 - ringProgress * 36 + i * 6);
                const start = ringProgress * Math.PI * 1.2 + i * 0.9;
                ctx.globalAlpha = Math.max(0.10, alpha * (1 - i * 0.22));
                ellipseArcDots(ctx, effect.x, effect.y, ring, ring * 0.36, {
                    start, end: start + Math.PI * 1.6, step: 3, dot: 2, color: '#3a4f6a',
                });
            }
            // Red spray particles erupting from the whirlpool eye.
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = Math.max(0.22, alpha * 0.92);
            ctx.fillStyle = '#ff4a39';
            const sprayCount = Math.min(14, 5 + Math.round(count));
            for (let i = 0; i < sprayCount; i++) {
                const seed = stableHash(`${effect.id}:whirl:${i}`);
                const angle = (seed % 628) / 100;
                const distance = 6 + ((seed >> 3) % 28) * progress;
                const x = effect.x + Math.cos(angle) * distance;
                const y = effect.y + Math.sin(angle) * distance * 0.42;
                ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
            }
        } else {
            for (let i = 0; i < Math.ceil(intensity) + 1; i++) {
                const ringProgress = Math.max(0, Math.min(1, progress * 1.18 - i * 0.14));
                const ring = 24 + ringProgress * (54 + intensity * 14);
                ctx.globalAlpha = Math.max(0.08, alpha * (1 - i * 0.16));
                ellipseArcDots(ctx, effect.x, effect.y, ring, ring * 0.34, { step: 4, dot: 2, color: style.accent });
            }
            ctx.globalAlpha = Math.max(0.10, alpha * 0.55);
            ctx.fillStyle = style.glow;
            fillConvex(ctx, [
                [summary.x - 8, summary.y - 72],
                [effect.x + 72, effect.y - 18],
                [effect.x - 18, effect.y + 12],
            ]);

            ctx.globalAlpha = Math.max(0.22, alpha * 0.88);
            for (let i = 0; i < burstCount; i++) {
                const seed = stableHash(`${effect.id}:${i}`);
                const angle = (seed % 628) / 100;
                const distance = 20 + ((seed >> 3) % 52) * (0.45 + progress * 0.7) * intensity / 2;
                const size = 1 + (seed % 3);
                const x = effect.x + Math.cos(angle) * distance;
                const y = effect.y + Math.sin(angle) * distance * 0.38;
                ctx.fillRect(Math.round(x), Math.round(y), size, size);
            }
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.max(0.48, alpha);
        // C5 — screen-fixed caption: cancel the camera zoom read off the
        // active transform (drawFinaleEffects receives no zoom argument).
        ctx.save();
        const frame = ctx.getTransform();
        const dpr = ctx.canvas?._claudeVilleDpr || 1;
        const zoom = Math.abs(frame.a) > 0.01 ? Math.abs(frame.a) / dpr : 1;
        ctx.translate(effect.x, effect.y);
        ctx.scale(1 / zoom, 1 / zoom);
        snapScreenOrigin(ctx);
        ctx.fillStyle = style.accent;
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(style.shortLabel, 0, -48);
        ctx.restore();
        ctx.restore();
    }

    // #18 — small flickering flame atop an active repo buoy; colours come
    // from ParticleSystem's shared `buoyTorch` palette. 5.8 — reduced motion
    // draws a single static frame instead of suppressing the flame entirely.
    _drawBuoyTorch(ctx, x, topY, slot = 0) {
        // A 2-texel pixel flame on the shared buoyTorch palette whose height
        // steps between three frames; neighbours are phase-offset by slot so
        // the anchorage never flickers in lockstep. Reduced motion holds one.
        const moving = this.motionScale > 0;
        const phase = (moving ? this.frame * 0.32 : 0) + slot * 1.7;
        const height = 5 + Math.round(Math.sin(phase));
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        drawPixelFlame(ctx, x, topY, height, 2, {
            outer: BUOY_TORCH_COLORS[0],
            inner: BUOY_TORCH_COLORS[1] || BUOY_TORCH_COLORS[0],
            tip: BUOY_TORCH_COLORS[2] || BUOY_TORCH_COLORS[BUOY_TORCH_COLORS.length - 1],
        });
        ctx.restore();
    }

    _drawRepoAnchorage(ctx, payload, zoom) {
        const x = payload.x;
        const y = payload.y;

        // Overflow chip — repos that did not get their own anchorage slot.
        if (payload.overflowMore) {
            const text = payload.repoName || `+${payload.overflowMore}`;
            // C5 — screen-fixed chip: zoom cancelled, whole screen px.
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
            snapScreenOrigin(ctx);
            ctx.font = WORLD_BODY_FONT_11;
            const w = Math.max(30, measureLabelText(ctx, text) + 12);
            const h = 14;
            const left = -Math.round(w / 2);
            const top = -Math.round(h / 2);
            ctx.globalAlpha = 0.78;
            ctx.fillStyle = 'rgba(159, 185, 181, 0.7)';
            ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
            ctx.fillStyle = 'rgba(20, 30, 34, 0.82)';
            ctx.fillRect(left, top, w, h);
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#cdd9d6';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            this._fillReadableText(ctx, fitLabelText(ctx, text, w - 6), 0, top + 11);
            ctx.restore();
            return;
        }

        // An empty berth's marker and label fade with its fleet.
        const fade = this._markerFade(payload.project, payload.present !== false);
        if (fade <= 0.02) return;
        const profile = payload.profile || repoProfile(payload.project);
        const lively = payload.lively !== false;
        const failed = Number(payload.failed || 0) > 0;
        const moving = this.motionScale > 0;

        // #18 — phase-offset vertical bob so neighbouring buoys never bob in
        // lockstep. Slot index seeds the phase; failed repos sit low ("droop")
        // and bob with a smaller amplitude. Whole texels; reduced motion = none.
        const slot = Number(payload.slot) || 0;
        // D2 — a pier berth's marker stands on the deck: no bob, no water.
        const deckLift = Number(payload.deckLift) || 0;
        const bobBand = pulseValue('harbor', this.frame + slot * 11, this.motionScale) - 0.62;
        const bobAmp = failed ? 0.7 : 1.6;
        const bob = moving && !deckLift ? Math.round(bobBand * bobAmp) : 0;
        const droop = failed && !deckLift ? 3 : 0;
        const bx = snap(x);
        const buoyY = snap(y) - deckLift + bob + droop;

        ctx.save();
        ctx.globalAlpha = fade;
        // Tinted water patch — the repo's "sea area", one flat stepped course.
        // Failed repos lose their colour: a muted grey wash reads as a sunken,
        // troubled anchorage.
        if (!deckLift) {
            const rx = lively ? 17 : 13;
            const waterGlow = failed
                ? 'rgba(96, 104, 110, 0.30)'
                : gradeColorString(profile.glow || 'rgba(122, 200, 216, 0.32)', this._grade);
            ctx.globalAlpha = (failed ? 0.5 : (lively ? 0.85 : 0.45)) * fade;
            fillPixelEllipse(ctx, bx, snap(y), rx, Math.round(rx / 2), waterGlow);
            ctx.globalAlpha = fade;
        }

        // Mooring buoy post + pennant in the repo accent (rides the bob).
        const topY = buoyY - 13;
        ctx.fillStyle = 'rgba(24, 16, 10, 0.85)';
        ctx.fillRect(bx, topY, 1, 13);
        // Failed pennant droops — a slack triangle hanging off the post tip.
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : profile.accent;
        fillConvex(ctx, failed
            ? [[bx + 1, topY], [bx + 7, topY + 6], [bx + 1, topY + 7]]
            : [[bx + 1, topY], [bx + 10, topY + 3], [bx + 1, topY + 6]]);

        // #18 — active-repo signal flame: a small flickering torch atop the post
        // whenever the repo is lively (live agent or fresh push). Drawn inline
        // (HarborTraffic owns no particle pool) using the shared buoyTorch
        // palette. Reduced motion draws a single static flame frame instead of
        // suppressing it (5.8).
        if (lively && !failed) {
            this._drawBuoyTorch(ctx, bx, topY, slot);
        }

        // Crest float at the waterline (rides the bob): a rimmed pixel diamond.
        diamond(ctx, bx, buoyY - 2, lively ? 4 : 3, {
            color: 'rgba(255, 240, 184, 0.9)',
            fill: profile.accent || '#f6d384',
        });

        // U-P4 / U-P7 — the repo's name and its whole fleet's count in the
        // ledger grammar (`claude-ville · 7`: the name shrinks from the
        // middle, the count never does), set on the fleet's leading edge
        // (under its lead hull) so it sits with its ships, not off the slot.
        const label = ledgerBuoyLabel(payload.repoName || profile.shortName || 'repo', payload.docked);
        const at = payload.docked > 0 && payload.labelAt ? payload.labelAt : null;
        // A one-lane fleet's lead plate already reads `repo · branch N`; a
        // label that would cover a plate, a pier deck or the house is left
        // out (the lead plate and the ledgers still say it).
        // At z1 that plate carries the repo's total (`repo 18 · 3 br`).
        if (at && (payload.laneCount <= 1 || (zoom || 1) < 2)) {
            ctx.restore();
            return;
        }
        if (at) {
            const z = zoom || 1;
            const halfW = (Math.max(40, label.length * this._plateCharWidth() + 12) / 2 + 1) / z;
            const box = { x0: at.x - halfW, x1: at.x + halfW, y0: at.y + 9 / z, y1: at.y + 25 / z };
            if (this._plateBoxesHit(box) || this._plateOverScenery(box)) {
                ctx.restore();
                return;
            }
            this._plateBoxes.push(box);
        }
        // C5 screen-fixed plate: zoom cancelled, whole screen px.
        ctx.save();
        ctx.translate(at ? at.x : x, at ? at.y : y - deckLift);
        ctx.scale(1 / (zoom || 1), 1 / (zoom || 1));
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const w = Math.max(40, measureLabelText(ctx, label) + 12);
        const h = 14;
        const left = -Math.round(w / 2);
        const top = at ? 10 : 9;
        ctx.globalAlpha = (lively ? 0.95 : 0.7) * fade;
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : (profile.panelBorder || profile.accent);
        ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
        ctx.fillStyle = profile.panel || 'rgba(20, 30, 34, 0.85)';
        ctx.fillRect(left, top, w, h);
        ctx.globalAlpha = fade;
        ctx.fillStyle = lively ? (profile.labelText || profile.accent) : 'rgba(180, 196, 192, 0.78)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        this._fillReadableText(ctx, label, 0, top + 11);
        ctx.restore();
        ctx.restore();
    }

    _drawFallbackBoat(ctx, x, y, alpha, shipClass = HARBOR_SHIP_CLASSES[HARBOR_SHIP_CLASSES.length - 1], profile = { accent: '#9fb9b5' }) {
        const scale = 1;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#6a3f2a';
        ctx.beginPath();
        ctx.moveTo(x - 20 * scale, y + 5 * scale);
        ctx.lineTo(x + 17 * scale, y - 4 * scale);
        ctx.lineTo(x + 10 * scale, y + 10 * scale);
        ctx.lineTo(x - 13 * scale, y + 14 * scale);
        ctx.closePath();
        ctx.fill();
        if ((shipClass.cargoRows || 0) > 0) {
            ctx.fillStyle = '#8a5530';
            ctx.strokeStyle = '#2d1c12';
            for (let i = 0; i < Math.min(3, shipClass.cargoRows); i++) {
                const cx = x - (8 - i * 7) * scale;
                const cy = y - (9 + i * 2) * scale;
                ctx.fillRect(Math.round(cx), Math.round(cy), Math.round(7 * scale), Math.round(6 * scale));
                ctx.strokeRect(Math.round(cx) + 0.5, Math.round(cy) + 0.5, Math.round(7 * scale) - 1, Math.round(6 * scale) - 1);
            }
        }
        ctx.fillStyle = '#d9c99a';
        ctx.fillRect(Math.round(x - 3 * scale), Math.round(y - 23 * scale), Math.max(2, Math.round(3 * scale)), Math.round(22 * scale));
        ctx.fillStyle = '#9fb9b5';
        ctx.beginPath();
        ctx.moveTo(x, y - 22 * scale);
        ctx.lineTo(x + 13 * scale, y - 9 * scale);
        ctx.lineTo(x + 1 * scale, y - 7 * scale);
        ctx.closePath();
        ctx.fill();
        if (shipClass.badge) {
            ctx.fillStyle = profile.accent || '#f4df9f';
            ctx.fillRect(Math.round(x - 14 * scale), Math.round(y - 2 * scale), Math.round(24 * scale), Math.max(2, Math.round(2 * scale)));
        }
        ctx.restore();
    }
}
