import { resolveObservation } from './ObservationCertainty.js';
import { drawEventShape, clearEventShapeCache } from '../shared/EventShapes.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { modelBehaviorProfile, moodBehaviorMultiplier } from '../../domain/value-objects/AgentMood.js';
import { BUILDING_DEFS, normalizeBuildingType } from '../../config/buildings.js';
import { THEME, STATUS_VISUALS, PROVIDER_HUES, WORLD_BODY_FONT_11, WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { agentSignature, drawAgentSignature, clearAgentSignatureCache, getModelVisualIdentity, providerPaletteKey } from '../shared/ModelVisualIdentity.js';
import { getTeamColor } from '../shared/TeamColor.js';
import { SpriteSheet, dirFromVelocity, resolveActionFrame, WALK_FRAMES, IDLE_FRAMES, DIRECTIONS, DEFAULT_CELL } from './SpriteSheet.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { RITUAL_GESTURE_PERIOD_MS, SCENIC_POINT_POSTURE } from './RitualConductor.js';
import { drawWorkDownbeat } from './WorkDownbeats.js';
import { pulseAlpha, pulseBand01Frame } from './PulsePolicy.js';
import { drawToolGlyphBadge, toolGlyphKey } from './ToolGlyphBadge.js';
import { isAttentionStatus } from './AttentionPlates.js';
import {
    IDENTITY_LABEL,
    LABEL_INK,
    WALNUT,
    drawOutlinedMotif,
    fitLabelText,
    identityLabelTop,
    measureLabelText,
    paintOutlinedText,
    snapScreenOrigin,
} from './WorldLabelKit.js';
import { Compositor, bakeSpriteOutline } from './Compositor.js';
import { fillPixelEllipse } from './PixelShapes.js';
import {
    drawGroundMarks,
    drawSelectionChevron,
    groundMarkDepth,
    resolveGroundMarks,
    selectionChevronClearance,
} from './AgentGroundMarks.js';
import { AgentBehaviorState } from './AgentBehaviorState.js';
import { classifyTool } from '../../domain/services/ToolIdentity.js';
import { dialogueSourceLabel } from '../../config/dialogue.js';
import { tileToWorld, worldToTile } from './Projection.js';
import { resolveUpdateRouteBuilding } from './MovementRouting.js';
import {
    RESOURCE_OWNERSHIP,
    registerRendererResourceEstimateProvider,
    releaseCanvasBackingStore,
    releaseCanvasMap,
    shouldEvictAtHighWater,
    unpinnedCacheKeys,
} from './CanvasBudget.js';
import { AgentAction, resolveAgentAction } from './ActionVocabulary.js';
import { AgentGpuOverlayRenderer, departedTableau } from './AgentGpuOverlayRenderer.js';
import { codexWeaponPose, drawCodexGauntlet } from './CodexWeaponPose.js';
import { clearDetachedCodexWrench } from './CodexEngineerGrips.js';
import { REF_DT_MS, SPEED_RUNGS, snapBodyPx, speedRungIndex } from './MotionClock.js';
import { gradeTone } from './EffectStamps.js';

// Plan 2.1 (C3): villagers draw at exactly one world texel per authored pixel,
// the same density as buildings, trees and tiles. Hit bounds come from the
// body actually drawn (`_bodyBox`); these are only the pre-first-draw default,
// sized to a median 1:1 body (~56 px tall, ~34 px wide).
const DEFAULT_BODY_BOX = Object.freeze({ left: -17, right: 17, top: -58, bottom: 3 });
const HIT_PAD = 3;
// S12 — the model signature clasp is a detail mark (z >= 3 or selected).
const SIGNATURE_MIN_ZOOM = 3;
// Plan 2.7 — crowd-pressure bodies use the baked 0.5x LOD sheet at world scale 1.
const CROWD_LOD_SCALE = 0.5;
// Impostor token (plan 2.1/2.7 retune): a whole-pixel provider diamond sized
// against the 1:1 body (48–75 world px) — about a third of its height, as the
// old kite was of the 82–120 px bodies. Half-widths per row from the apex
// (y = -16) to the toe (y = 2); the feet anchor is y = 0.
const IMPOSTOR_TOP = -16;
const IMPOSTOR_HALF_WIDTHS = Object.freeze([1, 2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 6, 6, 5, 4, 3, 3, 2, 1]);
const IMPOSTOR_OUTLINE = '#070a0c';
// Stamp box (feet-relative) covering shadow, outline and the apex status cell.
const IMPOSTOR_BOX = Object.freeze({ left: -9, top: -22, width: 18, height: 28 });
const WALK_PIXELS_PER_FRAME = 4.5;
// V7 — the distance-driven stride turns its frame a quarter refresh ahead of
// each whole-refresh boundary, so rAF timing jitter never splits a steady hold
// of 3 refreshes into 2 + 4; a quarter also clears both 120 Hz refreshes.
const STRIDE_PHASE_REFRESHES = 0.25;
// V7 — a route step shorter than this (world px) may not move a body a whole
// backing pixel at k >= 2 (a 0-px step on screen): corner and stop slivers
// fold into a neighbouring step instead.
const STEP_SLIVER_PX = 0.5;
// ±45° travel changes must persist this long before the body turns, so a
// one-tile zig-zag in an 8-connected path does not twitch the facing.
const DIRECTION_HOLD_MS = 70;
// V7 — one facing writer: the body turns one 45° column per TURN_STEP_MS.
const TURN_STEP_MS = 55;
// V7 — gait beats. On arrival the body holds its nearest contact frame (feet
// planted) before settling into idle; leaving rest it holds the push-off
// frame before the first step. Neither beat moves the body.
const STOP_BEAT_MS = 80;
const START_BEAT_MS = 60;
const PUSH_OFF_FRAME = 1;
// Camera-facing rank per direction (S, SE, E, NE, N, NW, W, SW): S/SE/SW show
// the face, E/W the profile, NE/N/NW the back. An exact reversal turns through
// the side with the higher rank, so the operator sees a face, never a back.
const FACING_FRONT_RANK = Object.freeze([2, 2, 1, 0, 0, 0, 1, 2]);
const DIR_E = 2;
const DIR_NE = 3;
const DIR_N = 4;
const DIR_NW = 5;
const DIR_W = 6;
// V7 — per-direction foot anchors share the bounds cache under these keys.
const FOOT_ANCHOR_KEYS = Object.freeze(DIRECTIONS.map((_, direction) => `anchor:${direction}`));
// V7 — travel speed rung per state (indices into SPEED_RUNGS): WORKING keeps
// the top rung (M27), WAITING and the other awake states walk at 1.125, IDLE
// at 0.75, and a scenic stroll at 0.5625.
const RUNG_STROLL = 0;
const RUNG_IDLE = 1;
const RUNG_WAITING = 3;
const RUNG_WORKING = 4;
const IDLE_FRAME_TICK_MS = 500;
const FIDGET_COOLDOWN_MIN_MS = 4000;
const FIDGET_COOLDOWN_RANGE_MS = 5000;
const THINK_PULSE_FRAME_SCALE = 20;
const THINK_DOT_PHASE_FRAMES = 60;
const FOOTFALL_FRAMES = new Set([0, Math.floor(WALK_FRAMES / 2)]);
// Status visuals, mood tones, and model-tier crests now live in theme.js (#1
// House Palette) so World and Dashboard share one color authority.
// 2.5 — how long the parent holds its static receive mark after a child's
// return lands. Bounded to the lifecycle cue window; no pulse is allocated, so
// reduced motion shows the identical held mark.
const RECEIVE_BEAT_MS = 1400;
// 2.2 — the authored read group's optional two-frame beat. `medium` band
// (~600 ms): it replaces the working pulse on the same body, never stacks with
// it, and reduced motion holds the group's declared static frame instead.
const ACTION_BEAT_MS = 600;
// 2.3 — how long the resolved command slip shows its wax seal. Static mark,
// bounded to the lifecycle event that earned it.
const SEALED_SLIP_MS = 1800;

// Opaque content bounds of one cell inside a composed character sheet. Shared
// by the per-sprite bounds cache and by miniature snapshots of foreign sheets.
function measureCellContentBounds(source, cell) {
    const scratch = document.createElement('canvas');
    scratch.width = cell.sw;
    scratch.height = cell.sh;
    const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
    scratchCtx.imageSmoothingEnabled = false;
    scratchCtx.drawImage(source, cell.sx, cell.sy, cell.sw, cell.sh, 0, 0, cell.sw, cell.sh);
    const data = scratchCtx.getImageData(0, 0, cell.sw, cell.sh).data;
    let minX = cell.sw;
    let minY = cell.sh;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < cell.sh; y++) {
        for (let x = 0; x < cell.sw; x++) {
            if (data[(y * cell.sw + x) * 4 + 3] < 16) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    return maxX > minX && maxY > minY
        ? { minX, minY, maxX, maxY }
        : { minX: 24, minY: 12, maxX: cell.sw - 24, maxY: cell.sh - 18 };
}

function easeOutCubic(t) {
    const c = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - c, 3);
}

// V7 — a body rides the backing-pixel grid only while it is on the move; a
// stop-and-look pause is a stop, so the body rests on a whole texel through it.
function bodyPlacementMoving(sprite) {
    return Boolean(sprite.moving) && !(sprite._stopLookActiveMs > 0);
}

// Smallest angle (radians) between a direction column and a screen-space
// bearing in atan2 space (y down), matching SpriteSheet.dirFromVelocity.
function angleOffDirection(direction, bearing) {
    const turn = Math.PI * 2;
    const delta = (2 - direction) * (Math.PI / 4) - bearing;
    return Math.abs((((delta + Math.PI) % turn) + turn) % turn - Math.PI);
}

// 0.5 — a building's footprint centre in tile units. The domain Building
// keeps its origin in `position` (tileX, tileY); plain layout objects carry
// `x`/`y`. Null when neither is finite.
function buildingCentreTile(building) {
    const bx = Number(building?.position?.tileX ?? building?.x);
    const by = Number(building?.position?.tileY ?? building?.y);
    if (!Number.isFinite(bx) || !Number.isFinite(by)) return null;
    return {
        tileX: bx + (Number(building.width) || 1) / 2,
        tileY: by + (Number(building.height) || 1) / 2,
    };
}

// The contact frame (feet planted: walk frames 0 and 3) nearest a walk frame.
function nearestContactFrame(frame) {
    const half = WALK_FRAMES / 2;
    const f = ((frame % WALK_FRAMES) + WALK_FRAMES) % WALK_FRAMES;
    return Math.abs(f - half) < Math.min(f, WALK_FRAMES - f) ? half : 0;
}

// True when a change of course from heading a to heading b turns three or
// more 45° columns (135° or more): the walker plants and pivots there.
function sharpCourseChange(ax, ay, bx, by) {
    const from = dirFromVelocity(ax, ay);
    const to = dirFromVelocity(bx, by);
    if (from == null || to == null) return false;
    const columns = (to - from + 8) % 8;
    return Math.min(columns, 8 - columns) >= 3;
}

// 3.13 — congestion treatment: the gait drops whole speed rungs when the
// destination/current building is over visit capacity (0.6× from the top rung
// lands two rungs down).
const CONGESTION_GAIT_SCALE = 0.6;
const PROVIDER_TRIM = Object.freeze(Object.fromEntries(
    Object.entries(PROVIDER_HUES).map(([key, hue]) => [key, hue.trim]),
));
const PROVIDER_BADGE_COLORS = Object.freeze(Object.fromEntries(
    Object.entries(PROVIDER_HUES).map(([key, hue]) => [key, hue.badge]),
));
// Context-window pressure ring thresholds, highest first. No ring below 0.75.
const CONTEXT_PRESSURE_LEVELS = Object.freeze([
    { threshold: 0.95, color: THEME.error, glow: 'rgba(239, 68, 68, 0.30)', pulseRate: 3.4 },
    { threshold: 0.85, color: THEME.waiting, glow: 'rgba(223, 140, 63, 0.24)', pulseRate: 2.4 },
    { threshold: 0.75, color: '#f2d36b', glow: 'rgba(242, 211, 107, 0.20)', pulseRate: 1.6 },
]);
const MAX_VISIBLE_FAMILIAR_MOTES = 3;
const AMBIENT_BUILDING_SEQUENCE = [
    'command',
    'taskboard',
    'forge',
    'mine',
    'portal',
    'observatory',
    'harbor',
    'archive',
    'watchtower',
];
const PROVIDER_HOME_BUILDINGS = {
    claude: 'command',
    codex: 'forge',
    gemini: 'observatory',
    kimi: 'portal',
    omp: 'taskboard',
    opencode: 'portal',
    deepseek: 'observatory',
    zai: 'archive',
};
const ACTION_TRAIL_LIMIT = 2;
const ACTIVITY_BUBBLE_TTL_MS = 12000;
const ACTION_TRAIL_TTL_MS = ACTIVITY_BUBBLE_TTL_MS;
const STATUS_BUBBLE_MAIN_MAX_WIDTH = Object.freeze({
    anchored: 232,
    floating: 360,
});
const STATUS_BUBBLE_HISTORY_MAX_WIDTH = Object.freeze({
    anchored: 216,
    floating: 320,
});
// Trail entries are capped upstream: adapters bound dialogue text and the
// renderer truncates by measured pixel width, so there is no character cap
// here. A second cap would silently re-introduce the mid-word truncation this
// rework removed.
// Provenance badge hues, keyed by dialogue kind. Only model-authored text gets
// a badge; harness status labels stay unbadged so the absence of a dot is
// itself information. Long-form reasoning ('thinking') is deliberately muted
// because it renders as a chip, not a quote.
const DIALOGUE_BADGE_COLORS = Object.freeze({
    intent: '#8ce99a',
    plan: '#8cd9ff',
    thinking: '#b3a6d9',
    assistant: '#ffd87a',
});
const TOOL_CONFIDENCE_THRESHOLD = 0.72;
const TOOL_CLASSIFICATION_CACHE_LIMIT = 160;
const TOOL_CLASSIFICATION_CACHE = new Map();
const PROCESSED_SPRITE_CACHE = new Map();
const PROCESSED_SPRITE_CACHE_ENTRY_LIMIT = 24;
const PROCESSED_SPRITE_CACHE_PIXEL_LIMIT = 12_500_000;
let processedSpriteCachePixels = 0;
const CODEX_EQUIPMENT_CACHE = new Map();
const CODEX_EQUIPMENT_CACHE_ENTRY_LIMIT = 96;
const CODEX_EQUIPMENT_CACHE_PIXEL_LIMIT = 2_000_000;
const CODEX_EQUIPMENT_SCALE_STABLE_MS = 120;
let codexEquipmentCachePixels = 0;
let codexEquipmentRasterScale = 0;
let codexEquipmentRasterScaleSince = 0;
// Padding per cell side in the GPU equipped sheet: covers the tallest baked
// weapon overhang (polearm/dawnblade tips reach ~50px past the pose anchor).
const GPU_EQUIP_SHEET_PAD = 24;
// Padded equipped sheets shared by every sprite of one profile (albedo +
// padded sidecars + layout). ~48M px ≈ eight distinct armed profiles.
const GPU_EQUIPPED_SHEET_CACHE = new Map();
const GPU_EQUIPPED_SHEET_CACHE_ENTRY_LIMIT = 12;
const GPU_EQUIPPED_SHEET_CACHE_PIXEL_LIMIT = 48_000_000;
let gpuEquippedSheetCachePixels = 0;
const SHARED_DERIVED_HIGH_WATER_ESTIMATE_BYTES = 192 * 1024 * 1024;
const ACTIVE_PROFILE_REFS = new Map();
const PRIVATE_DERIVED_CACHE_ESTIMATES = new Map();
const GPU_AGENT_CHANNEL_ATLAS_RECORDS = new Map();

function gpuEquippedSheetEntryPixels(entry) {
    let pixels = 0;
    for (const canvas of [entry?.albedo, entry?.material, entry?.emissive, entry?.occluder]) {
        pixels += (canvas?.width || 0) * (canvas?.height || 0);
    }
    return pixels;
}

function canvasEstimateBytes(canvas) {
    return Math.max(0, Number(canvas?.width) || 0) * Math.max(0, Number(canvas?.height) || 0) * 4;
}

function entryProfileKey(entry) {
    return entry?.profileKey || entry?.__cvProfileKey || '';
}

function entryIsPinned(entry, profiles) {
    if (profiles.has(entryProfileKey(entry))) return true;
    for (const key of entry?.__cvProfileKeys || []) {
        if (profiles.has(key)) return true;
    }
    return false;
}

function activeProfilePins() {
    return new Set(ACTIVE_PROFILE_REFS.keys());
}

function releaseSharedEntry(entry) {
    for (const canvas of [entry?.canvas, entry?.albedo, entry?.material, entry?.emissive, entry?.occluder, entry]) {
        if (typeof canvas?.getContext === 'function') releaseCanvasBackingStore(canvas);
    }
}

function oldestUnpinnedCacheKey(map) {
    const profiles = activeProfilePins();
    for (const [key, entry] of map) {
        if (!entryIsPinned(entry, profiles)) return key;
    }
    return null;
}

function sharedResourceEstimateLeaves() {
    const stats = AgentSprite.sharedCacheStats();
    return {
        cpuDerived: [{
            key: 'agent-sprite:shared-and-private-derived',
            estimateBytes: stats.cpuDerivedEstimateBytes,
        }],
    };
}

registerRendererResourceEstimateProvider(sharedResourceEstimateLeaves);
// Vertical step per stacked bubble slot, in screen pixels. Must match
// IsometricRenderer AGENT_BUBBLE_STACK_STEP so the crowd de-collision slot the
// renderer assigns lines up with the offset drawn here.
const STATUS_BUBBLE_STACK_STEP = 24;
const CODEX_EQUIPMENT_BY_CLASS = Object.freeze({
    codex: 'engineerWrench',
    spark: 'multitool',
    gpt54: 'engineerWrench',
    gpt55: 'runeblade',
    gpt56sol: 'dawnblade',
    gpt56terra: 'earthbreaker',
    gpt56luna: 'crescentSaber',
    gpt6astra: 'worldsplitter',
});
// Exported so the layering invariant is testable: a weapon whose sprite is
// authored empty-handed must not be forced behind the body, or the villager
// grips air while the blade hides in its own silhouette.
export const CODEX_WEAPON_ASSETS = Object.freeze({
    worldsplitter: {
        id: 'equipment.codex.worldsplitter',
        fallback: 'polearm',
        pose: 'polearmUpright',
        anchor: [36, 68],
        scale: 0.78,
        hands: 'single',
    },
    runeblade: {
        id: 'equipment.codex.runeblade',
        fallback: 'runeblade',
        pose: 'rightHand',
        anchor: [31, 70],
        scale: 0.62,
        hands: 'single',
    },
    greatsword: {
        id: 'equipment.codex.greatsword',
        fallback: 'greatsword',
        pose: 'greatswordShoulder',
        backLayer: 'always',
        anchor: [36, 82],
        scale: 0.56,
        hands: 'single',
    },
    polearm: {
        id: 'equipment.codex.polearm',
        fallback: 'polearm',
        pose: 'polearmUpright',
        anchor: [44, 74],
        scale: 0.70,
        hands: 'double',
        handSpacing: 13,
        handVector: [-7, 12],
    },
    engineerWrench: {
        id: 'equipment.codex.engineerWrench',
        fallback: 'wrench',
        pose: 'shoulderRest',
        backPose: 'backCarry',
        anchor: [34, 70],
        scale: 0.62,
        hands: 'single',
    },
    dawnblade: {
        id: 'equipment.codex.dawnblade',
        fallback: 'greatsword',
        pose: 'greatswordShoulder',
        // No `backLayer: 'always'` here, unlike `greatsword`. That entry pairs
        // with procedural heavy armour drawn on the front layer, so its blade
        // has to sit behind the body. Sol's armour is baked into the sprite and
        // its hands are authored empty to grip a runtime greatblade, so forcing
        // the blade behind the body hid ~62% of it and left the grip holding
        // air. Falling through to the default rule keeps the blade in hand and
        // moves it behind the body only when the villager faces away.
        anchor: [36, 82],
        scale: 0.56,
        hands: 'single',
    },
    earthbreaker: {
        id: 'equipment.codex.earthbreaker',
        fallback: 'wrench',
        pose: 'shoulderRest',
        backPose: 'backCarry',
        anchor: [34, 70],
        scale: 0.62,
        hands: 'single',
    },
    crescentSaber: {
        id: 'equipment.codex.crescentSaber',
        fallback: 'runeblade',
        pose: 'rightHand',
        anchor: [31, 70],
        scale: 0.5,
        hands: 'single',
    },
});
const INTENT_SOURCE_MOTION = Object.freeze({
    chat: { dwell: 1.0, speed: 1.2, stableMs: 3000 },
    alert: { dwell: 1.15, speed: 1.18, stableMs: 9000 },
    git: { dwell: 0.9, speed: 1.14, stableMs: 8000 },
    handoff: { dwell: 1.0, speed: 1.04, stableMs: 6500 },
    tool: { dwell: 1.0, speed: 1.0, stableMs: 5500 },
    token: { dwell: 0.95, speed: 1.02, stableMs: 5000 },
    team: { dwell: 1.18, speed: 0.96, stableMs: 7000 },
    subagent: { dwell: 1.12, speed: 0.98, stableMs: 7000 },
    quota: { dwell: 1.25, speed: 0.9, stableMs: 9000 },
    ambient: { dwell: 1.0, speed: 0.9, stableMs: 0 },
});
const PHASE_MOTION = Object.freeze({
    reading: { dwell: 1.12, speed: 0.96 },
    editing: { dwell: 0.95, speed: 1.05 },
    testing: { dwell: 0.92, speed: 1.06 },
    researching: { dwell: 1.18, speed: 0.94 },
    coordinating: { dwell: 1.08, speed: 1.0 },
    git: { dwell: 0.88, speed: 1.1 },
    'quota/resource': { dwell: 1.22, speed: 0.9 },
    waiting: { dwell: 1.35, speed: 0.84 },
});
const MIN_INTENT_STABLE_MS = 2200;
const MAX_INTENT_STABLE_MS = 12000;
const SAME_INTENT_BUILDING_PRIORITY_DELTA = 10;
const LOCAL_DIRECT_PATH_TILE_DISTANCE = 4.5;

function toolInputCacheKey(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    try {
        return JSON.stringify(input);
    } catch {
        return String(input);
    }
}

function memoizedToolClassification(tool, input) {
    const key = `${String(tool || '')}\u0000${toolInputCacheKey(input)}`;
    if (TOOL_CLASSIFICATION_CACHE.has(key)) return TOOL_CLASSIFICATION_CACHE.get(key);
    let classified = null;
    try {
        classified = classifyTool(tool, input) || null;
    } catch {
        classified = null;
    }
    TOOL_CLASSIFICATION_CACHE.set(key, classified);
    if (TOOL_CLASSIFICATION_CACHE.size > TOOL_CLASSIFICATION_CACHE_LIMIT) {
        TOOL_CLASSIFICATION_CACHE.delete(TOOL_CLASSIFICATION_CACHE.keys().next().value);
    }
    return classified;
}

export class AgentSprite {
    static sharedCacheStats() {
        // Canvas implementations do not expose allocation sizes. All byte
        // values below estimate RGBA backing from dimensions; cache entries
        // are counted once here regardless of how many sprites reference them.
        let gpuEquippedAlbedoPixels = 0;
        let gpuEquippedMaterialPixels = 0;
        let gpuEquippedEmissivePixels = 0;
        let gpuEquippedOccluderPixels = 0;
        for (const entry of GPU_EQUIPPED_SHEET_CACHE.values()) {
            gpuEquippedAlbedoPixels += (entry.albedo?.width || 0) * (entry.albedo?.height || 0);
            gpuEquippedMaterialPixels += (entry.material?.width || 0) * (entry.material?.height || 0);
            gpuEquippedOccluderPixels += (entry.occluder?.width || 0) * (entry.occluder?.height || 0);
            gpuEquippedEmissivePixels += (entry.emissive?.width || 0) * (entry.emissive?.height || 0);
        }
        const privateDerivedEstimateBytes = [...PRIVATE_DERIVED_CACHE_ESTIMATES.values()]
            .reduce((sum, bytes) => sum + bytes, 0);
        const activeSpriteCount = [...ACTIVE_PROFILE_REFS.values()]
            .reduce((sum, refs) => sum + refs.owners.size, 0);
        let gpuAgentChannelCellSize = 1;
        let hasGpuAgentMaterialAtlas = false;
        let hasGpuAgentEmissiveAtlas = false;
        let hasGpuAgentOccluderAtlas = false;
        for (const record of GPU_AGENT_CHANNEL_ATLAS_RECORDS.values()) {
            const cell = Math.max(1, Math.ceil(Math.max(record.sw || 1, record.sh || 1)));
            gpuAgentChannelCellSize = Math.max(gpuAgentChannelCellSize, cell);
            hasGpuAgentMaterialAtlas ||= record.material;
            hasGpuAgentEmissiveAtlas ||= record.emissive;
            hasGpuAgentOccluderAtlas ||= record.occluder;
        }
        const gpuAgentAtlasCapacity = Math.max(activeSpriteCount, GPU_AGENT_CHANNEL_ATLAS_RECORDS.size, 1);
        const gpuAgentAtlasColumns = Math.max(1, Math.ceil(Math.sqrt(gpuAgentAtlasCapacity)));
        const gpuAgentAtlasRows = Math.max(1, Math.ceil(gpuAgentAtlasCapacity / gpuAgentAtlasColumns));
        const gpuAgentChannelAtlasEstimateBytes = gpuAgentAtlasColumns
            * gpuAgentChannelCellSize
            * gpuAgentAtlasRows
            * gpuAgentChannelCellSize
            * 4;
        const gpuAgentMaterialAtlasEstimateBytes = hasGpuAgentMaterialAtlas
            ? gpuAgentChannelAtlasEstimateBytes
            : 0;
        const gpuAgentEmissiveAtlasEstimateBytes = hasGpuAgentEmissiveAtlas
            ? gpuAgentChannelAtlasEstimateBytes
            : 0;
        const gpuAgentOccluderAtlasEstimateBytes = hasGpuAgentOccluderAtlas ? gpuAgentChannelAtlasEstimateBytes : 0;
        const compositorCanvases = new Set(Compositor.shared()?.cache?.values?.() || []);
        for (const refs of ACTIVE_PROFILE_REFS.values()) {
            if (refs.baseCanvas) compositorCanvases.add(refs.baseCanvas);
        }
        const processedSpriteEstimateBytes = processedSpriteCachePixels * 4;
        const compositorEstimateBytes = [...compositorCanvases]
            .reduce((sum, canvas) => sum + canvasEstimateBytes(canvas), 0);
        const codexEquipmentEstimateBytes = codexEquipmentCachePixels * 4;
        // Despite the cache name, these are Canvas source backings. Their GL
        // uploads remain separate GPU-owned leaves in the renderer ledger.
        const gpuEquippedSheetEstimateBytes = gpuEquippedSheetCachePixels * 4;
        const cpuDerivedEstimateBytes = compositorEstimateBytes
            + processedSpriteEstimateBytes
            + codexEquipmentEstimateBytes
            + gpuEquippedSheetEstimateBytes
            + privateDerivedEstimateBytes
            + gpuAgentMaterialAtlasEstimateBytes
            + gpuAgentEmissiveAtlasEstimateBytes
            + gpuAgentOccluderAtlasEstimateBytes;
        return {
            processedSpriteSheets: PROCESSED_SPRITE_CACHE.size,
            processedSpritePixels: processedSpriteCachePixels,
            processedSpriteEntryLimit: PROCESSED_SPRITE_CACHE_ENTRY_LIMIT,
            processedSpritePixelLimit: PROCESSED_SPRITE_CACHE_PIXEL_LIMIT,
            codexEquipmentAssets: CODEX_EQUIPMENT_CACHE.size,
            codexEquipmentPixels: codexEquipmentCachePixels,
            codexEquipmentEstimateBytes,
            gpuEquippedSheets: GPU_EQUIPPED_SHEET_CACHE.size,
            gpuEquippedSheetPixels: gpuEquippedSheetCachePixels,
            gpuEquippedSheetEstimateBytes,
            gpuEquippedAlbedoEstimateBytes: gpuEquippedAlbedoPixels * 4,
            gpuEquippedMaterialEstimateBytes: gpuEquippedMaterialPixels * 4,
            gpuEquippedEmissiveEstimateBytes: gpuEquippedEmissivePixels * 4,
            gpuEquippedOccluderEstimateBytes: gpuEquippedOccluderPixels * 4,
            gpuEquippedSheetPixelLimit: GPU_EQUIPPED_SHEET_CACHE_PIXEL_LIMIT,
            processedSpriteEstimateBytes,
            compositorEstimateBytes,
            privateDerivedEstimateBytes,
            gpuAgentMaterialAtlasEstimateBytes,
            gpuAgentEmissiveAtlasEstimateBytes,
            gpuAgentOccluderAtlasEstimateBytes,
            cpuDerivedEstimateBytes,
            ownership: {
                compositorSpriteSheets: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: compositorEstimateBytes,
                },
                processedSpriteSheets: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: processedSpriteEstimateBytes,
                },
                codexEquipmentCanvases: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: codexEquipmentEstimateBytes,
                },
                gpuEquippedAlbedoSheets: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: gpuEquippedAlbedoPixels * 4,
                },
                gpuEquippedMaterialSheets: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: gpuEquippedMaterialPixels * 4,
                },
                gpuEquippedOccluderSheets: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: gpuEquippedOccluderPixels * 4,
                },
                gpuEquippedEmissiveSheets: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: gpuEquippedEmissivePixels * 4,
                },
                perSpriteEffectCells: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: privateDerivedEstimateBytes,
                },
                gpuAgentMaterialAtlas: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: gpuAgentMaterialAtlasEstimateBytes,
                },
                gpuAgentOccluderAtlas: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: gpuAgentOccluderAtlasEstimateBytes,
                },
                gpuAgentEmissiveAtlas: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: gpuAgentEmissiveAtlasEstimateBytes,
                },
            },
            activeProfileKeys: [...ACTIVE_PROFILE_REFS.keys()].sort(),
            selectedProfilePins: [...ACTIVE_PROFILE_REFS]
                .filter(([, refs]) => refs.selectedOwners.size > 0)
                .map(([key]) => key)
                .sort(),
            primaryProfilePins: [...ACTIVE_PROFILE_REFS]
                .filter(([, refs]) => refs.primaryOwners.size > 0)
                .map(([key]) => key)
                .sort(),
            sharedDerivedHighWaterEstimateBytes: SHARED_DERIVED_HIGH_WATER_ESTIMATE_BYTES,
            toolClassifications: TOOL_CLASSIFICATION_CACHE.size,
        };
    }

    static evictUnpinnedSharedCaches({
        highWaterEstimateBytes = SHARED_DERIVED_HIGH_WATER_ESTIMATE_BYTES,
    } = {}) {
        const candidates = [];
        const compositor = Compositor.shared();
        for (const [key, canvas] of compositor?.cache || []) {
            candidates.push({ key: `compositor:${key}`, cacheKey: key, cache: compositor.cache, entry: canvas, estimateBytes: canvasEstimateBytes(canvas) });
        }
        for (const [key, canvas] of PROCESSED_SPRITE_CACHE) {
            candidates.push({ key: `processed:${key}`, cacheKey: key, cache: PROCESSED_SPRITE_CACHE, entry: canvas, estimateBytes: canvasEstimateBytes(canvas) });
        }
        for (const [key, entry] of CODEX_EQUIPMENT_CACHE) {
            candidates.push({ key: `equipment:${key}`, cacheKey: key, cache: CODEX_EQUIPMENT_CACHE, entry, estimateBytes: canvasEstimateBytes(entry.canvas) });
        }
        for (const [key, entry] of GPU_EQUIPPED_SHEET_CACHE) {
            candidates.push({ key: `gpu-equipped:${key}`, cacheKey: key, cache: GPU_EQUIPPED_SHEET_CACHE, entry, estimateBytes: gpuEquippedSheetEntryPixels(entry) * 4 });
        }
        let residentEstimateBytes = candidates.reduce((sum, entry) => sum + entry.estimateBytes, 0);
        if (!shouldEvictAtHighWater(residentEstimateBytes, highWaterEstimateBytes)) {
            return { evicted: [], residentEstimateBytes };
        }
        const profiles = activeProfilePins();
        const pinnedKeys = new Set(candidates
            .filter((candidate) => entryIsPinned(candidate.entry, profiles))
            .map((candidate) => candidate.key));
        const evictable = new Set(unpinnedCacheKeys(candidates, pinnedKeys));
        const evicted = [];
        for (const candidate of candidates) {
            if (!evictable.has(candidate.key)) continue;
            candidate.cache.delete(candidate.cacheKey);
            releaseSharedEntry(candidate.entry);
            evicted.push(candidate.key);
            residentEstimateBytes -= candidate.estimateBytes;
            if (!shouldEvictAtHighWater(residentEstimateBytes, highWaterEstimateBytes)) break;
        }
        AgentSprite._recountSharedCachePixels();
        if (compositor) {
            compositor.cachePixels = [...compositor.cache.values()]
                .reduce((sum, canvas) => sum + canvasEstimateBytes(canvas) / 4, 0);
        }
        return { evicted, residentEstimateBytes: Math.max(0, residentEstimateBytes) };
    }

    static _recountSharedCachePixels() {
        processedSpriteCachePixels = [...PROCESSED_SPRITE_CACHE.values()]
            .reduce((sum, canvas) => sum + canvasEstimateBytes(canvas) / 4, 0);
        codexEquipmentCachePixels = [...CODEX_EQUIPMENT_CACHE.values()]
            .reduce((sum, entry) => sum + canvasEstimateBytes(entry.canvas) / 4, 0);
        gpuEquippedSheetCachePixels = [...GPU_EQUIPPED_SHEET_CACHE.values()]
            .reduce((sum, entry) => sum + gpuEquippedSheetEntryPixels(entry), 0);
    }

    static releaseSharedCaches() {
        // Drop cache ownership without mutating backing stores. A renderer
        // replacement can overlap briefly with the previous renderer, and the
        // incoming sprites may already reference one of these shared canvases.
        PROCESSED_SPRITE_CACHE.clear();
        CODEX_EQUIPMENT_CACHE.clear();
        GPU_EQUIPPED_SHEET_CACHE.clear();
        TOOL_CLASSIFICATION_CACHE.clear();
        AgentSprite.clearOverlayStampCache();
        clearAgentSignatureCache();
        clearEventShapeCache();
        processedSpriteCachePixels = 0;
        codexEquipmentCachePixels = 0;
        gpuEquippedSheetCachePixels = 0;
        codexEquipmentRasterScale = 0;
        codexEquipmentRasterScaleSince = 0;
    }

    constructor(agent, {
        pathfinder = null,
        bridgeTiles = null,
        assets = null,
        compositor = null,
        getIntentForAgent = null,
        getBuilding = null,
        getBridgeLift = null,
        allocateVisitTile = null,
        releaseVisitReservation = null,
        renewVisitReservation = null,
        getAmbientDestination = null,
        getRoadTiles = null,
        getTileType = null,
        motionClock = null,
    } = {}) {
        this.agent = agent;
        this.observation = resolveObservation(agent, Date.now());
        this.x = 0;
        this.y = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.moving = false;
        this.walkFrame = 0;
        this.waitTimer = 0;
        this.selected = false;
        this._resourceOwnerKey = Symbol(String(agent?.id || 'agent'));
        this._ownedProfileKey = '';
        // 3.7 — hover affordance. The renderer's mousemove pass sets this via
        // setHovered(); draw() then shows a static trim ring + the name pill.
        this.hovered = false;
        // 3.1 — per-agent animation phase seeded from the agent id, so a crowd
        // no longer breathes, bobs, and pulses as one organism. Offsets are
        // deterministic; under reduced motion the frame pins to 0 as before.
        const animSeed = Math.abs(this._hash(`${agent?.id ?? ''}:anim`));
        this._idlePhaseFrames = animSeed % IDLE_FRAMES;
        this._idlePhaseTimerMs = (animSeed >>> 2) % IDLE_FRAME_TICK_MS;
        this.statusAnim = ((animSeed >>> 3) % 628) / 100;
        // 2.4 — the fidget stream is seeded from the same id hash, so an
        // agent's small idle nudges repeat run to run instead of drawing from
        // Math.random(). No bit from this stream ever becomes mood or rank.
        this._fidgetSeed = (animSeed ^ 0x9e3779b9) >>> 0 || 1;
        // 2.4 — bounded personal signature, resolved with the draw profile.
        this._signature = null;
        this._signatureFamily = '';
        // 2.2 — the body cell drawn last frame, published read-only for
        // consumers that mirror this body elsewhere (building aperture).
        this._poseCell = null;
        this._sealedSlipUntil = 0;
        this._lastWaitReason = null;
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        // R2-06 — immutable profile resolved only when agent telemetry changes;
        // update/draw hot paths read scalars and never allocate tier state.
        this._modelBehavior = modelBehaviorProfile(agent?.model, agent?.effort);
        this.lightingState = null;
        // The GPU-resident World path consumes a stable base-sprite record
        // after the Canvas draw has resolved identity, frame, bounds and pixel
        // snapping. Canvas remains authoritative for hit testing and fallback.
        this.gpuWorldEnabled = false;
        this._gpuFrameRecord = null;
        this._gpuEquippedSheetKey = '';
        this._gpuEquippedSheetLayout = null;
        this._gpuEquippedMaterialSheet = null;
        this._gpuEquippedEmissiveSheet = null;
        this._gpuEquippedOccluderSheet = null;
        this.gpuOverlayRenderer = new AgentGpuOverlayRenderer(this);
        this._lastBuildingType = null;
        this._lastIntentId = null;
        this._lastTargetTile = null;
        this._lastReservationId = null;
        this._lastVisitSlotId = null;
        this._lastVisitFacingPoint = null;
        this._lastVisitMeta = null;
        this._lastIntentSnapshot = null;
        this._intentStableUntil = 0;
        this._blockedIntentId = null;
        this._blockedIntentRetryAfter = 0;
        this._lastReservationRenewedAt = 0;
        this._targetReachable = true;
        this._lastBlockedRecovery = null;
        this.behavior = new AgentBehaviorState();
        this._targetCycle = 0;
        this.nameTagSlot = 0;
        // Crowd bubble de-collision slot + suppression, assigned per frame by
        // IsometricRenderer._assignAgentBubbleSlots. slot 0 = normal position;
        // higher slots stack the bubble upward; suppressed collapses it to a dot.
        this.bubbleSlot = 0;
        this.bubbleSuppressed = false;
        // 3.8 — identical-bubble merge (renderer groups cluster-mates sharing
        // the same head text): the representative carries bubbleMergedCount>1
        // and draws a ×N chip; members point at it via bubbleMergedInto and
        // skip their own bubble. Defaults: unmerged.
        this.bubbleMergedCount = 1;
        this.bubbleMergedInto = null;
        // #14 — set true by IsometricRenderer when this agent's name pill is
        // folded into its building's status-tally chip at low zoom.
        this.foldedIntoBuilding = false;
        // 4.8 — earned biography nickname ("the Shipwright"), pushed by the
        // renderer from AgentBiographyService; rendered as a name-tag suffix.
        this.nickname = null;
        this.labelAlpha = 1;
        this.plateOffFrame = false;
        this.gpuActionOverlay = false;
        this.bumpFlash = 0;
        // #28 — handoff acknowledgement bob. A child agent gives a short upward
        // dip when a parent's handoff baton lands on it. Timestamp of the most
        // recent ack; 0 means inactive. Reduced motion never sets it.
        this._handoffAckStart = 0;
        this.teamPlazaPreference = false;
        this._arrivalState = 'visible';

        // Chat system
        this.chatPartner = null;     // Chat partner AgentSprite
        this.chatting = false;       // chatting flag
        this.chatTimer = 0;          // chat animation timer
        this.chatBubbleAnim = 0;     // speech bubble animation

        // Active pose-bearing tool ritual record from RitualConductor (per
        // building work gesture: hammer / page / pick / scroll / …), synced by
        // the renderer per frame. Its 6.6 work beat is a pure function of the
        // ritual and the clock (WorkDownbeats), so no per-sprite beat state.
        this._toolRitual = null;
        // #13 — last mood-mote cadence cycle a fret/sparkle was emitted on, so
        // each distressed/proud beat fires a single mote (never under reduced
        // motion, never while moving — the static posture carries the cue then).
        this._moodMoteBeat = -1;
        // #36 — last cadence cycle a context-strain sweat bead was emitted on, so
        // each beat fires a single drop above 0.85 pressure (never under reduced
        // motion / while moving — the static arc + chip carry the cue then).
        this._strainSweatBeat = -1;
        // #34 — token-flow motes. While WORKING, tiny archive/beacon motes rise
        // off the villager and drift toward its bound building, density set by
        // recent token burn (the same total LandmarkActivity._observeTokens
        // tracks). `_tokenFlowTotal` is the last observed token total, `_tokenFlowBurn`
        // a decaying burn accumulator, and `_tokenFlowBeat` the last cadence cycle
        // a mote fired. Reduced motion never emits — token life stays invisible.
        this._tokenFlowTotal = null;
        this._tokenFlowBurn = 0;
        this._tokenFlowBeat = -1;

        this._lastStatus = agent?.status || null;
        this._completedAtMs = 0;
        this._departedResting = false;
        // #40 — error-distress story. While ERRORED/RATE_LIMITED the villager
        // storms the Pharos with a head-down distressed gait; on recovery it
        // straightens and sheds one relief spark. `_stormingLast` tracks the
        // prior storm state so the recovery beat fires exactly once.
        this._stormingLast = this._isStorming();
        this._reliefSparkAt = 0;

        const screen = tileToWorld(agent.position);
        this.x = screen.x;
        this.y = screen.y;

        this.pathfinder = pathfinder;
        this.bridgeTiles = bridgeTiles;
        this.getIntentForAgent = typeof getIntentForAgent === 'function' ? getIntentForAgent : null;
        this.getBuilding = typeof getBuilding === 'function' ? getBuilding : null;
        this.getBridgeLift = typeof getBridgeLift === 'function' ? getBridgeLift : null;
        this.allocateVisitTile = typeof allocateVisitTile === 'function' ? allocateVisitTile : null;
        this.releaseVisitReservation = typeof releaseVisitReservation === 'function' ? releaseVisitReservation : null;
        this.renewVisitReservation = typeof renewVisitReservation === 'function' ? renewVisitReservation : null;
        this.getAmbientDestination = typeof getAmbientDestination === 'function' ? getAmbientDestination : null;
        this.getRoadTiles = typeof getRoadTiles === 'function' ? getRoadTiles : null;
        // #42 — renderer-supplied tile-class lookup (dirt/cobble/grass/shallow/
        // deep) used to key terrain-aware footfall particles to the ground under
        // each stride.
        this.getTileType = typeof getTileType === 'function' ? getTileType : null;
        // V7 — the renderer's one motion clock: travel reads its display-
        // latched stride dt (`strideDtMs`) so host jitter never splits a hold.
        this._motionClock = motionClock && typeof motionClock === 'object' ? motionClock : null;
        this.waypoints = [];
        this._lastPathTileKey = null;
        this._pathAgeFrames = 0;

        // Guard: agents spawn from a broad random band that can overlap rivers.
        // Snap to dry walkable ground before the first target is assigned.
        this._snapToNearestWalkable();

        // Sprite rendering fields
        this.assets = assets;
        this.compositor = compositor;
        this.direction = 0;          // 0..7 index into DIRECTIONS
        this.animState = 'idle';
        // 3.1 — idle breathing starts on the agent's seeded phase, not frame 0.
        this.frame = this._idlePhaseFrames;
        this.frameTimer = this._idlePhaseTimerMs;
        this._strideDistance = 0;
        // V7 — gait state: the rung this update walked at, the stride phase
        // (and whether a new rung or short step needs it re-taken), whether
        // the legs are mid-stride (false after any stop, so leaving rest plays
        // the start beat), and the two beat timers.
        this._gaitSpeed = 0;
        this._stridePhase = 0;
        this._stridePhaseStale = true;
        this._strideShortStep = 0;
        this._strideActive = false;
        // V7 — where this refresh's step began (NaN when the body did not
        // step) and how far it went: renderer steering keeps that length
        // (`steeredPosition`), so every walk frame covers 4.5 px of travel.
        this._stepStartX = NaN;
        this._stepStartY = NaN;
        this._stepLength = 0;
        this._startBeatMs = 0;
        this._stopBeatMs = 0;
        this._candidateDirection = null;
        this._candidateDirectionMs = 0;
        // V7 — one facing writer: the goal the stepper turns toward (null when
        // settled), which way it turns, the time banked toward the next
        // column, and whether a turn of 135° or more has planted the stride.
        this._facingGoal = null;
        this._facingTurnSign = 1;
        this._facingTurnMs = 0;
        this._facingPivot = false;
        // 0.5 — the screen bearing (radians) to the building last faced, so a
        // fidget glance never turns past that building's half-plane.
        this._workBearing = null;
        // V7 — the partner tile a chat approach last routed to; the approach
        // re-routes only when the partner changes tile.
        this._chatPartnerTileX = NaN;
        this._chatPartnerTileY = NaN;
        // V7 — the one placement value of the last draw (snapBodyPx) and the
        // backing DPR it was taken at; every per-agent layer reads it.
        this._placeX = this.x;
        this._placeY = this.y;
        this._placeDpr = 1;
        this.spriteCanvas = null;
        this.spriteSheet = null;     // cached SpriteSheet wrapper, set on first draw
        this._spriteProfileKey = '';
        // Plan 2.1 — the body actually laid out this frame, relative to the
        // feet anchor, in world texels. Drives hit-testing, head-anchored
        // particles and the resident overlay's label clearance.
        this._bodyBox = null;
        this._groundMarks = null;
        this._frozenTintCellCache = new Map();
        this._cellBoundsCache = new Map();
        // Accessory hysteresis state (D2). `undefined` means no accessory has
        // been committed yet, so the first one applies immediately.
        this._committedAccessory = undefined;
        this._accessoryCandidate = null;
        this._accessoryCandidateSince = 0;
        this._bubbleLayoutCacheKey = '';
        this._bubbleLayoutCache = null;
        this._activityTrail = [];
        this._activitySnapshot = this._captureActivitySnapshot(agent);

        this._pickTarget();
    }

    releaseRenderResources() {
        // Sprite sheets are shared with the compositor and Dashboard avatars, so
        // drop our references without zeroing their backing stores. Cell effects
        // are private to this AgentSprite and can be released immediately.
        releaseCanvasMap(this._frozenTintCellCache);
        this._cellBoundsCache.clear();
        this.spriteCanvas = null;
        this.spriteSheet = null;
        this._spriteProfileKey = '';
        this._gpuFrameRecord = null;
        this._gpuBaseSpriteCanvas = null;
        this._gpuEquippedSheetKey = '';
        this._gpuEquippedSheetLayout = null;
        this._gpuEquippedMaterialSheet = null;
        this._gpuEquippedEmissiveSheet = null;
        this._gpuEquippedOccluderSheet = null;
        this._bubbleLayoutCacheKey = '';
        this._bubbleLayoutCache = null;
        this._releaseProfileOwnership();
        PRIVATE_DERIVED_CACHE_ESTIMATES.delete(this._resourceOwnerKey);
        GPU_AGENT_CHANNEL_ATLAS_RECORDS.delete(this._resourceOwnerKey);
    }

    _syncProfileOwnership(profileKey, assetIds) {
        if (this._ownedProfileKey && this._ownedProfileKey !== profileKey) {
            this._releaseProfileOwnership();
        }
        let refs = ACTIVE_PROFILE_REFS.get(profileKey);
        if (!refs) {
            refs = {
                owners: new Map(),
                selectedOwners: new Set(),
                primaryOwners: new Set(),
                assetIds: new Set(),
                assets: this.assets,
                baseCanvas: null,
            };
            ACTIVE_PROFILE_REFS.set(profileKey, refs);
        }
        const primary = this.selected
            || this.agent?.status === AgentStatus.ERRORED
            || this.agent?.status === AgentStatus.WAITING_ON_USER;
        refs.owners.set(this._resourceOwnerKey, { selected: this.selected, primary });
        if (this.selected) refs.selectedOwners.add(this._resourceOwnerKey);
        else refs.selectedOwners.delete(this._resourceOwnerKey);
        if (primary) refs.primaryOwners.add(this._resourceOwnerKey);
        else refs.primaryOwners.delete(this._resourceOwnerKey);
        for (const id of assetIds) {
            if (id) refs.assetIds.add(id);
        }
        refs.assets?.retainProfileAssets?.(profileKey, [...refs.assetIds], {
            selected: refs.selectedOwners.size > 0,
            primary: refs.primaryOwners.size > 0,
        });
        this._ownedProfileKey = profileKey;
    }

    _releaseProfileOwnership() {
        const profileKey = this._ownedProfileKey;
        if (!profileKey) return;
        const refs = ACTIVE_PROFILE_REFS.get(profileKey);
        if (refs) {
            refs.owners.delete(this._resourceOwnerKey);
            refs.selectedOwners.delete(this._resourceOwnerKey);
            refs.primaryOwners.delete(this._resourceOwnerKey);
            if (refs.owners.size === 0) {
                refs.assets?.releaseProfileAssets?.(profileKey);
                ACTIVE_PROFILE_REFS.delete(profileKey);
            } else {
                refs.assets?.retainProfileAssets?.(profileKey, [...refs.assetIds], {
                    selected: refs.selectedOwners.size > 0,
                    primary: refs.primaryOwners.size > 0,
                });
            }
        }
        this._ownedProfileKey = '';
    }

    _updatePrivateDerivedEstimate() {
        let pixels = 0;
        for (const canvas of this._frozenTintCellCache.values()) {
            pixels += (canvas?.width || 0) * (canvas?.height || 0);
        }
        if (pixels > 0) PRIVATE_DERIVED_CACHE_ESTIMATES.set(this._resourceOwnerKey, pixels * 4);
        else PRIVATE_DERIVED_CACHE_ESTIMATES.delete(this._resourceOwnerKey);
    }

    // V7 — route beside the chat partner and remember the partner's tile: the
    // approach re-routes only when the partner reaches another tile, never
    // per frame, so its target and path hold still while it walks.
    _routeToChatPartner() {
        const partner = this.chatPartner;
        const partnerTile = worldToTile(partner.x, partner.y);
        this._chatPartnerTileX = Math.round(partnerTile.tileX);
        this._chatPartnerTileY = Math.round(partnerTile.tileY);
        const offsetX = this.x < partner.x ? -25 : 25;
        const chatTargetX = partner.x + offsetX;
        const chatTargetY = partner.y;
        const targetTile = this._screenToTile(chatTargetX, chatTargetY);
        this._assignTarget(chatTargetX, chatTargetY, targetTile.tileX, targetTile.tileY);
    }

    _pickTarget() {
        // Move to the partner position when there is a chat partner
        if (this.chatPartner) {
            this._releaseVisitReservation();
            this.behavior.transition('chat-approach', 'chat');
            this._lastPathTileKey = null; // force fresh path on every chat entry
            this._routeToChatPartner();
            this.moving = true;
            this.waitTimer = 0;
            return;
        }

        const intent = this._activeVisitIntent();
        let buildingType = intent?.building || this._targetBuildingTypeForState();
        let building = this._ambientDestination(intent);

        if (!building && buildingType) {
            building = this._buildingForType(buildingType);
        }

        if (!building) {
            building = this._fallbackBuildingForState();
        }

        const seed = Math.abs(this._hash(`${this.agent.id}:${building.type}:${this._targetCycle++}`));
        const visitTarget = this._visitTileForBuilding(building, seed, intent);
        if (this._routeToVisitTarget(building, intent, visitTarget)) return;
        if (this._recoverBlockedTarget({ building, intent, seed, failedTarget: visitTarget })) return;

        this.behavior.transition('blocked', 'no-route');
        this.waitTimer = 90;
    }

    _routeToVisitTarget(building, intent, visitTarget, {
        reason = null,
        state = null,
        blockedReason = 'no-route',
        recovery = null,
        viaWaypoints = undefined,
    } = {}) {
        if (!building || !visitTarget) return false;
        const targetTileX = Number(visitTarget.tileX);
        const targetTileY = Number(visitTarget.tileY);
        if (!Number.isFinite(targetTileX) || !Number.isFinite(targetTileY)) return false;

        const screen = tileToWorld(targetTileX, targetTileY);
        this._lastBuildingType = building.type;
        this._lastIntentId = intent?.id || null;
        this._lastTargetTile = { tileX: targetTileX, tileY: targetTileY };
        this._lastVisitSlotId = visitTarget.slotId || null;
        this._lastVisitFacingPoint = visitTarget.facingPoint ? { ...visitTarget.facingPoint } : null;
        this._lastVisitMeta = visitTarget.meta ? { ...visitTarget.meta } : null;

        const routeReason = reason || this._routeReasonFor(building, intent);
        this.behavior.setRoute({
            state: state || this._routeStateFor(building, intent),
            intent,
            building: building.type,
            reason: routeReason,
            targetTile: this._lastTargetTile,
            phase: intent?.phase || this._phaseForAgentState(building?.type),
            interruptible: intent?.interruptible,
        });
        this._rememberRouteIntent(intent);

        const waypoints = viaWaypoints === undefined
            ? this._waypointsForVisitTarget(building, targetTileX, targetTileY)
            : viaWaypoints;
        this._assignTarget(screen.x, screen.y, targetTileX, targetTileY, waypoints);
        this.moving = this._targetReachable;
        if (!this._targetReachable) {
            this.behavior.recordBlocked({
                reason: blockedReason,
                building: building.type,
                intent,
                targetTile: this._lastTargetTile,
                recovery,
                fromTile: this._screenToTile(this.x, this.y),
            });
            return false;
        }
        if (intent?.id && this._blockedIntentId === intent.id) {
            this._blockedIntentId = null;
            this._blockedIntentRetryAfter = 0;
        }
        this.waitTimer = 0;
        return true;
    }

    _routeStateFor(building, intent) {
        if (intent) return 'traveling';
        return building.type?.startsWith('ambient:') ? 'wandering' : 'roaming';
    }

    _routeReasonFor(building, intent) {
        if (intent?.reason) return intent.reason;
        if (building.type?.startsWith('ambient:')) return 'scenic';
        return this.agent.status === AgentStatus.IDLE ? 'ambient' : 'status';
    }

    _phaseForAgentState(buildingType = this._lastBuildingType) {
        if (this.agent.status === AgentStatus.WAITING) return 'waiting';
        const type = String(buildingType || '').toLowerCase();
        if (type === 'harbor') return 'git';
        if (type === 'mine') return 'quota/resource';
        if (type === 'forge') return 'editing';
        if (type === 'taskboard') return 'testing';
        if (type === 'archive') return 'reading';
        if (type === 'observatory' || type === 'portal') return 'researching';
        return 'coordinating';
    }

    _waypointsForVisitTarget(building, targetTileX, targetTileY) {
        if (building.routeViaRoads) return this._roadWaypointsForScenic(targetTileX, targetTileY);
        if (this.agent?.status !== AgentStatus.IDLE || !this.getRoadTiles) return null;
        const fromTile = this._screenToTile(this.x, this.y);
        const tileDist = Math.hypot(
            Number(targetTileX) - Number(fromTile.tileX),
            Number(targetTileY) - Number(fromTile.tileY),
        );
        return Number.isFinite(tileDist) && tileDist > 6
            ? this._roadWaypointsForScenic(targetTileX, targetTileY)
            : null;
    }

    _recoverBlockedTarget({ building, intent, seed, failedTarget }) {
        const baseReason = this._routeReasonFor(building, intent);
        const alternateCandidates = this._alternateVisitCandidates(building, failedTarget);
        if (alternateCandidates.length > 0) {
            const alternateTarget = this._visitTileForBuilding(building, seed + 101, intent, alternateCandidates);
            if (this._routeToVisitTarget(building, intent, alternateTarget, {
                reason: `${baseReason}:alternate-slot`,
                blockedReason: 'alternate-slot-unreachable',
                recovery: 'alternate-slot',
            })) {
                this._recordBlockedRecovery('alternate-slot', building, alternateTarget);
                return true;
            }
        }

        const roadTarget = this._nearestRoadOrWalkableFallback(failedTarget, building);
        if (roadTarget && this._routeToVisitTarget(building, intent, roadTarget, {
            reason: `${baseReason}:nearest-road`,
            blockedReason: 'nearest-road-unreachable',
            recovery: 'nearest-road',
            viaWaypoints: null,
        })) {
            this._recordBlockedRecovery(roadTarget.recoverySource || 'nearest-road', building, roadTarget);
            return true;
        }

        const scenicBuilding = this._scenicRecoveryBuilding(building);
        if (scenicBuilding) {
            const scenicTarget = this._visitTileForBuilding(scenicBuilding, seed + 211, null);
            if (this._routeToVisitTarget(scenicBuilding, null, scenicTarget, {
                reason: 'blocked:scenic-fallback',
                blockedReason: 'scenic-fallback-unreachable',
                recovery: 'scenic-fallback',
            })) {
                this._deferBlockedIntent(intent);
                this._recordBlockedRecovery('scenic-fallback', scenicBuilding, scenicTarget);
                return true;
            }
        }

        const fallbackBuilding = this._blockedFallbackBuilding(building);
        if (fallbackBuilding) {
            const fallbackTarget = this._visitTileForBuilding(fallbackBuilding, seed + 307, null);
            if (this._routeToVisitTarget(fallbackBuilding, null, fallbackTarget, {
                reason: 'blocked:fallback-building',
                blockedReason: 'fallback-building-unreachable',
                recovery: 'fallback-building',
            })) {
                this._deferBlockedIntent(intent);
                this._recordBlockedRecovery('fallback-building', fallbackBuilding, fallbackTarget);
                return true;
            }
        }

        this._recordBlockedRecovery('failed', building, failedTarget);
        this._deferBlockedIntent(intent, 3500);
        return false;
    }

    _deferBlockedIntent(intent, retryDelayMs = 5500) {
        if (!intent?.id) return;
        this._blockedIntentId = intent.id;
        this._blockedIntentRetryAfter = Date.now() + retryDelayMs;
    }

    _alternateVisitCandidates(building, failedTarget) {
        if (!building || !Array.isArray(building.visitTiles) || building.visitTiles.length <= 1) return [];
        const failedX = Math.round(Number(failedTarget?.tileX));
        const failedY = Math.round(Number(failedTarget?.tileY));
        return building.visitTiles.filter((tile) => {
            const tileX = Math.round(Number(tile?.tileX ?? tile?.x));
            const tileY = Math.round(Number(tile?.tileY ?? tile?.y));
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return false;
            return tileX !== failedX || tileY !== failedY;
        });
    }

    _nearestRoadOrWalkableFallback(failedTarget, building) {
        const origin = {
            tileX: Number(failedTarget?.tileX),
            tileY: Number(failedTarget?.tileY),
        };
        if (!Number.isFinite(origin.tileX) || !Number.isFinite(origin.tileY)) return null;

        const road = this._nearestTileInSet(this.getRoadTiles?.(), origin, 9);
        if (road) {
            return {
                ...road,
                facingPoint: failedTarget?.facingPoint || this._buildingFacingPoint(building),
                recoverySource: 'nearest-road',
                meta: { recovery: 'nearest-road' },
            };
        }

        if (this.pathfinder?.nearestWalkable) {
            const nearest = this.pathfinder.nearestWalkable(Math.round(origin.tileX), Math.round(origin.tileY), 7);
            if (nearest) {
                return {
                    tileX: nearest.tileX,
                    tileY: nearest.tileY,
                    facingPoint: failedTarget?.facingPoint || this._buildingFacingPoint(building),
                    recoverySource: 'nearest-walkable',
                    meta: { recovery: 'nearest-walkable' },
                };
            }
        }
        return null;
    }

    _nearestTileInSet(tileSet, origin, maxRadius = 9) {
        if (!tileSet || !tileSet.size) return null;
        let best = null;
        let bestDist = Infinity;
        for (const key of tileSet) {
            const comma = String(key).indexOf(',');
            if (comma < 0) continue;
            const tileX = Number(String(key).slice(0, comma));
            const tileY = Number(String(key).slice(comma + 1));
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const dist = Math.hypot(tileX - origin.tileX, tileY - origin.tileY);
            if (dist > maxRadius || dist >= bestDist) continue;
            bestDist = dist;
            best = { tileX, tileY };
        }
        return best;
    }

    _scenicRecoveryBuilding(blockedBuilding) {
        if (!this.getAmbientDestination) return null;
        const scenic = this.getAmbientDestination({
            agent: this.agent,
            sprite: this,
            recentBuildings: this.behavior.recentBuildings,
            cycle: this._targetCycle + 17,
            blockedBuilding: blockedBuilding?.type || null,
        });
        if (!scenic || scenic.type === blockedBuilding?.type) return null;
        return scenic;
    }

    _blockedFallbackBuilding(blockedBuilding) {
        const candidates = [
            this._fallbackBuildingForState(),
            this._buildingForType('command'),
            this._buildingForType('taskboard'),
            BUILDING_DEFS[0],
        ].filter(Boolean);
        const seen = new Set();
        for (const candidate of candidates) {
            if (!candidate?.type || seen.has(candidate.type)) continue;
            seen.add(candidate.type);
            if (candidate.type !== blockedBuilding?.type) return candidate;
        }
        return candidates[0] || null;
    }

    _buildingFacingPoint(building) {
        const finite = (value) => Number.isFinite(Number(value));
        const raw = building?.facingPoint;
        if (raw && finite(raw.x ?? raw.tileX) && finite(raw.y ?? raw.tileY)) {
            return { x: Number(raw.x ?? raw.tileX), y: Number(raw.y ?? raw.tileY) };
        }
        const centre = buildingCentreTile(building);
        return centre ? { x: centre.tileX, y: centre.tileY } : null;
    }

    _recordBlockedRecovery(reason, building, target) {
        this._lastBlockedRecovery = {
            reason,
            building: building?.type || null,
            targetTile: target ? { tileX: target.tileX, tileY: target.tileY } : null,
            at: Date.now(),
        };
    }

    _roadWaypointsForScenic(targetTileX, targetTileY) {
        if (!this.getRoadTiles) return null;
        const fromTile = this._screenToTile(this.x, this.y);
        const toTile = { tileX: targetTileX, tileY: targetTileY };
        const entry = this._findNearestRoadTile(fromTile, toTile);
        const exit = this._findNearestRoadTile(toTile, fromTile);
        const waypoints = [];
        const fx = Math.round(fromTile.tileX);
        const fy = Math.round(fromTile.tileY);
        const tx = Math.round(targetTileX);
        const ty = Math.round(targetTileY);
        if (entry && (Math.round(entry.tileX) !== fx || Math.round(entry.tileY) !== fy)) {
            waypoints.push(entry);
        }
        if (exit && (Math.round(exit.tileX) !== tx || Math.round(exit.tileY) !== ty)) {
            const last = waypoints[waypoints.length - 1];
            if (!last || Math.round(last.tileX) !== Math.round(exit.tileX) || Math.round(last.tileY) !== Math.round(exit.tileY)) {
                waypoints.push(exit);
            }
        }
        return waypoints.length > 0 ? waypoints : null;
    }

    _fallbackBuildingForState() {
        const preferred = this._ambientBuildingTypeForState();
        return this._buildingForType(preferred) || BUILDING_DEFS[0];
    }

    _ambientBuildingTypeForState() {
        const seed = Math.abs(this._hash(`${this.agent.id}:ambient:${this._targetCycle}`));
        const lastKnown = this.agent.lastKnownBuildingType || null;

        if (this.agent.status === AgentStatus.WORKING) {
            return lastKnown || 'command';
        }
        if (this.agent.status === AgentStatus.WAITING) {
            return lastKnown || 'taskboard';
        }
        if (this.agent.status === AgentStatus.ERRORED) {
            return 'watchtower';
        }
        if (this.agent.status === AgentStatus.RATE_LIMITED) {
            return 'watchtower';
        }
        if (this.agent.status === AgentStatus.WAITING_ON_USER) {
            return 'command';
        }

        if (lastKnown && (seed % 100) < this._lastKnownRevisitWeight()) return lastKnown;
        if (this.teamPlazaPreference && this.agent.teamName && (seed % 6) < 4) return 'command';
        if (this.agent.isSubagent && (seed % 6) < 2) return 'command';
        const totalTokens = (this.agent.tokens?.input || 0) + (this.agent.tokens?.output || 0);
        if (totalTokens > 0 && seed % 8 === 0 && this._recentBuildingCount('mine') < 2) return 'mine';

        const providerHome = PROVIDER_HOME_BUILDINGS[this._providerKey()];
        if (providerHome && seed % 11 === 0 && this._recentBuildingCount(providerHome) < 2) return providerHome;

        return this._ambientSequenceChoice(seed);
    }

    _lastKnownRevisitWeight() {
        const age = Number(this.agent.activityAgeMs);
        if (!Number.isFinite(age)) return 5;
        if (age <= 30000) return 35;
        if (age <= 90000) return 15;
        return 5;
    }

    _ambientSequenceChoice(seed) {
        for (let offset = 0; offset < AMBIENT_BUILDING_SEQUENCE.length; offset++) {
            const candidate = AMBIENT_BUILDING_SEQUENCE[(seed + offset) % AMBIENT_BUILDING_SEQUENCE.length];
            if (this._recentBuildingCount(candidate) < 2) return candidate;
        }
        return AMBIENT_BUILDING_SEQUENCE[seed % AMBIENT_BUILDING_SEQUENCE.length];
    }

    _recentBuildingCount(type) {
        return this.behavior.recentCount(type);
    }

    _ambientDestination(intent = null) {
        if (intent || this.agent.status !== AgentStatus.IDLE || !this.getAmbientDestination) return null;
        if ((this._targetCycle % 3) !== 1) return null;
        return this.getAmbientDestination({
            agent: this.agent,
            sprite: this,
            recentBuildings: this.behavior.recentBuildings,
            cycle: this._targetCycle,
        });
    }

    _visitTileForBuilding(building, seed, intent = null, candidatesOverride = null) {
        const allocated = this.allocateVisitTile?.({
            agent: this.agent,
            sprite: this,
            building,
            intent,
            candidates: candidatesOverride,
        });
        if (allocated && Number.isFinite(Number(allocated.tileX)) && Number.isFinite(Number(allocated.tileY))) {
            this._lastReservationId = allocated.reservationId || null;
            this._lastReservationRenewedAt = Date.now();
            this._lastVisitSlotId = allocated.slotId || null;
            this._lastVisitFacingPoint = allocated.facingPoint ? { ...allocated.facingPoint } : null;
            this._lastVisitMeta = {
                reservationId: allocated.reservationId || null,
                slotId: allocated.slotId || null,
                slotIndex: allocated.slotIndex ?? null,
                buildingType: allocated.buildingType || building?.type || null,
                queueGroup: allocated.queueGroup || null,
                queueIndex: Number.isInteger(allocated.queueIndex) ? allocated.queueIndex : null,
                queueDepth: Number.isInteger(allocated.queueDepth) ? allocated.queueDepth : null,
                queueOverflow: !!allocated.queueOverflow,
                overflow: !!allocated.overflow,
                scenic: !!allocated.scenic,
                relatedCluster: !!allocated.relatedCluster,
                score: Number.isFinite(Number(allocated.score)) ? Number(allocated.score) : null,
            };
            return {
                tileX: Number(allocated.tileX),
                tileY: Number(allocated.tileY),
                slotId: allocated.slotId || null,
                facingPoint: allocated.facingPoint ? { ...allocated.facingPoint } : null,
                meta: this._lastVisitMeta,
            };
        }
        this._lastReservationId = null;
        this._lastVisitMeta = null;
        const candidates = Array.isArray(candidatesOverride) && candidatesOverride.length
            ? candidatesOverride
            : Array.isArray(building.visitTiles) && building.visitTiles.length
            ? building.visitTiles
            : building.entrance
                ? [building.entrance]
                : [{
                    tileX: (building.x ?? building.position?.tileX ?? 0) + Math.floor((building.width || 1) / 2),
                    tileY: (building.y ?? building.position?.tileY ?? 0) + (building.height || 1),
                }];
        const chosen = candidates[seed % candidates.length];
        const jitterScale = this.agent.status === AgentStatus.WORKING ? 0.64 : 0.78;
        const jitterX = (this._noise(seed, 11) - 0.5) * jitterScale;
        const jitterY = (this._noise(seed, 17) - 0.5) * jitterScale;
        const facingPoint = chosen?.facingPoint
            ? { ...chosen.facingPoint }
            : this._buildingFacingPoint(building);
        this._lastVisitSlotId = chosen?.slotId || null;
        this._lastVisitFacingPoint = facingPoint;
        return {
            tileX: Number(chosen.tileX) + jitterX,
            tileY: Number(chosen.tileY) + jitterY,
            slotId: chosen?.slotId || null,
            facingPoint,
            meta: {
                reservationId: null,
                slotId: chosen?.slotId || null,
                slotIndex: null,
                buildingType: building?.type || null,
                fallback: true,
            },
        };
    }

    _buildingForType(type) {
        const normalized = normalizeBuildingType(type);
        if (!normalized) return null;
        return this.getBuilding?.(normalized)
            || BUILDING_DEFS.find((b) => b.type === normalized)
            || null;
    }

    _activeVisitIntent() {
        const intent = this.getIntentForAgent?.(this.agent?.id);
        if (
            intent?.id &&
            this._blockedIntentId === intent.id &&
            Date.now() < this._blockedIntentRetryAfter
        ) {
            return null;
        }
        return intent?.building ? intent : null;
    }

    _rememberRouteIntent(intent) {
        if (!intent) {
            this._lastIntentSnapshot = null;
            this._intentStableUntil = 0;
            return;
        }
        const now = Date.now();
        const sourceProfile = INTENT_SOURCE_MOTION[intent.source] || INTENT_SOURCE_MOTION.tool;
        const ttlRemaining = Number.isFinite(Number(intent.expiresAt))
            ? Math.max(0, Number(intent.expiresAt) - now)
            : sourceProfile.stableMs;
        const priority = Number(intent.priority);
        const priorityBonus = Number.isFinite(priority) ? Math.max(0, priority - 70) * 45 : 0;
        const stableMs = Math.max(
            MIN_INTENT_STABLE_MS,
            Math.min(MAX_INTENT_STABLE_MS, sourceProfile.stableMs + priorityBonus, ttlRemaining || sourceProfile.stableMs),
        );
        this._intentStableUntil = now + stableMs;
        this._lastIntentSnapshot = {
            id: intent.id || null,
            source: intent.source || null,
            building: intent.building || null,
            reason: intent.reason || null,
            phase: intent.phase || null,
            goal: intent.goal || null,
            itinerary: this._cloneIntentItinerary(intent.itinerary),
            priority: Number.isFinite(priority) ? priority : null,
            expiresAt: Number.isFinite(Number(intent.expiresAt)) ? Number(intent.expiresAt) : null,
            interruptible: intent.interruptible !== false,
            stableUntil: this._intentStableUntil,
        };
    }

    _cloneIntentItinerary(itinerary) {
        if (!itinerary) return null;
        return {
            ...itinerary,
            route: Array.isArray(itinerary.route) ? [...itinerary.route] : [],
        };
    }

    _adoptIntentWithoutRetarget(intent) {
        if (!intent?.id) return;
        this._lastIntentId = intent.id;
        this._rememberRouteIntent(intent);
        this.behavior.acceptIntent?.(intent, {
            building: this._lastBuildingType,
            reason: intent.reason || 'same-building-intent',
            targetTile: this._lastTargetTile,
            phase: intent.phase,
            interruptible: intent.interruptible,
        });
    }

    _shouldRetargetForIntent(intent, nextBuildingType, nextIntentId) {
        const buildingChanged = nextBuildingType !== this._lastBuildingType;
        if (!nextIntentId) return buildingChanged;
        if (!this._lastIntentSnapshot || !this._lastIntentSnapshot.id) return true;
        if (nextIntentId === this._lastIntentSnapshot.id) return buildingChanged;

        const now = Date.now();
        const nextPriority = Number(intent?.priority);
        const currentPriority = Number(this._lastIntentSnapshot.priority);
        const priorityDelta = Number.isFinite(nextPriority) && Number.isFinite(currentPriority)
            ? nextPriority - currentPriority
            : 0;
        if (priorityDelta >= SAME_INTENT_BUILDING_PRIORITY_DELTA) return true;
        if (!buildingChanged) return false;
        if (now >= this._intentStableUntil && this.behavior?.interruptible !== false) return true;
        return false;
    }

    _releaseVisitReservation() {
        if (!this._lastReservationId && !this.agent?.id) return;
        this.releaseVisitReservation?.(this.agent?.id, this._lastReservationId);
        this._lastReservationId = null;
        this._lastVisitSlotId = null;
        this._lastVisitFacingPoint = null;
        this._lastVisitMeta = null;
        this._lastReservationRenewedAt = 0;
    }

    _renewVisitReservation() {
        if (!this._lastReservationId || !this.agent?.id || !this.renewVisitReservation) return;
        const now = Date.now();
        if (now - this._lastReservationRenewedAt < 5000) return;
        if (this.renewVisitReservation(this.agent.id)) {
            this._lastReservationRenewedAt = now;
        }
    }

    _assignTarget(targetScreenX, targetScreenY, targetTileX, targetTileY, viaWaypoints = null) {
        this._targetReachable = true;
        if (!this.pathfinder) {
            this.targetX = targetScreenX;
            this.targetY = targetScreenY;
            this.waypoints = [];
            return;
        }
        this._snapToNearestWalkable();
        const fromTile = this._screenToTile(this.x, this.y);
        const viaKey = viaWaypoints?.length
            ? '|' + viaWaypoints.map((w) => `${Math.round(w.tileX)},${Math.round(w.tileY)}`).join('|')
            : '';
        const tileKey = `${Math.round(targetTileX)},${Math.round(targetTileY)}${viaKey}`;
        if (tileKey === this._lastPathTileKey && this.waypoints.length > 0 && this._pathAgeFrames < 30) {
            this._pathAgeFrames++;
            return;
        }
        this._pathAgeFrames = 0;
        this._lastPathTileKey = tileKey;
        const finalTarget = { tileX: targetTileX, tileY: targetTileY };
        let tilePath = this._findStitchedPath(fromTile, finalTarget, viaWaypoints);
        const finalTile = tilePath[tilePath.length - 1];
        const targetTile = {
            tileX: Math.round(targetTileX),
            tileY: Math.round(targetTileY),
        };
        if (
            !finalTile
            || Math.max(
                Math.abs(finalTile.tileX - targetTile.tileX),
                Math.abs(finalTile.tileY - targetTile.tileY),
            ) > 1
        ) {
            this._targetReachable = false;
            this._releaseVisitReservation();
            this.waypoints = [];
            this.targetX = this.x;
            this.targetY = this.y;
            return;
        }
        this.waypoints = tilePath.map((t) => ({
            ...tileToWorld(t),
        }));
        if (
            this._isScreenPointWalkable(targetScreenX, targetScreenY)
        ) {
            this.waypoints[this.waypoints.length - 1] = { x: targetScreenX, y: targetScreenY };
        }
        const head = this.waypoints[0];
        this.targetX = head.x;
        this.targetY = head.y;
    }

    _findStitchedPath(fromTile, toTile, viaWaypoints) {
        if (!viaWaypoints || viaWaypoints.length === 0) {
            return this.pathfinder.findPath(fromTile, toTile, this.bridgeTiles, this._pathOptions(fromTile, toTile));
        }
        const stitched = [];
        let leg = fromTile;
        const legs = [...viaWaypoints, toTile];
        for (const next of legs) {
            if (Math.round(leg.tileX) === Math.round(next.tileX) && Math.round(leg.tileY) === Math.round(next.tileY)) {
                continue;
            }
            const segment = this.pathfinder.findPath(leg, next, this.bridgeTiles, this._pathOptions(leg, next));
            if (segment.length === 0) {
                return this.pathfinder.findPath(fromTile, toTile, this.bridgeTiles, this._pathOptions(fromTile, toTile));
            }
            if (stitched.length > 0) segment.shift();
            stitched.push(...segment);
            leg = next;
        }
        if (stitched.length === 0) {
            return this.pathfinder.findPath(fromTile, toTile, this.bridgeTiles, this._pathOptions(fromTile, toTile));
        }
        return stitched;
    }

    _pathOptions(fromTile, toTile) {
        const roadTiles = this.getRoadTiles?.();
        const bridgeTiles = this.bridgeTiles;
        const hasRoads = !!roadTiles?.size;
        const hasBridges = !!bridgeTiles?.size;
        if (!hasRoads && !hasBridges) return null;

        const distance = Math.hypot(
            Number(toTile?.tileX) - Number(fromTile?.tileX),
            Number(toTile?.tileY) - Number(fromTile?.tileY),
        );
        if (Number.isFinite(distance) && distance <= LOCAL_DIRECT_PATH_TILE_DISTANCE) return null;

        return {
            preferRoads: true,
            roadTiles,
            preferredTiles: roadTiles,
            dockTiles: roadTiles,
            bridgeTiles,
            cacheKey: `roads:${roadTiles?.size || 0}:bridges:${bridgeTiles?.size || 0}`,
        };
    }

    _findNearestRoadTile(fromTile, towardTile, maxRadius = 6) {
        const roads = this.getRoadTiles?.();
        if (!roads || !roads.size) return null;
        const fx = Number(fromTile?.tileX);
        const fy = Number(fromTile?.tileY);
        const tx = Number(towardTile?.tileX);
        const ty = Number(towardTile?.tileY);
        if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
        const dirX = Number.isFinite(tx) ? tx - fx : 0;
        const dirY = Number.isFinite(ty) ? ty - fy : 0;
        const hasDir = (dirX !== 0 || dirY !== 0);
        let best = null;
        let bestDist = Infinity;
        for (const key of roads) {
            const comma = key.indexOf(',');
            if (comma < 0) continue;
            const rx = Number(key.slice(0, comma));
            const ry = Number(key.slice(comma + 1));
            if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue;
            const dx = rx - fx;
            const dy = ry - fy;
            const dist = Math.hypot(dx, dy);
            if (dist > maxRadius) continue;
            if (hasDir && (dirX * dx + dirY * dy) < 0) continue;
            if (dist < bestDist) {
                bestDist = dist;
                best = { tileX: rx, tileY: ry };
            }
        }
        return best;
    }

    _isScreenPointWalkable(x, y) {
        if (!this.pathfinder) return true;
        const tile = this._screenToTile(x, y);
        return this.pathfinder.isWalkable(Math.round(tile.tileX), Math.round(tile.tileY));
    }

    _screenToTile(x, y) {
        return worldToTile(x, y);
    }

    _snapToNearestWalkable(maxRadius = 8) {
        if (!this.pathfinder || typeof this.pathfinder.nearestWalkable !== 'function') return false;
        const tile = this._screenToTile(this.x, this.y);
        const tileX = Math.round(tile.tileX);
        const tileY = Math.round(tile.tileY);
        if (this.pathfinder.isWalkable(tileX, tileY)) return false;

        const nearest = this.pathfinder.nearestWalkable(tileX, tileY, maxRadius);
        if (!nearest) return false;

        const screen = tileToWorld(nearest);
        this.x = screen.x;
        this.y = screen.y;
        this.targetX = screen.x;
        this.targetY = screen.y;
        this.waypoints = [];
        this._lastPathTileKey = null;
        return true;
    }

    _targetBuildingTypeForState() {
        if (this.agent.status === AgentStatus.WORKING) {
            return this.agent.targetBuildingType || this.agent.lastKnownBuildingType || 'command';
        }
        if (this.agent.status === AgentStatus.WAITING) return this.agent.targetBuildingType || this.agent.lastKnownBuildingType || 'taskboard';
        if (this.agent.status === AgentStatus.IDLE) return this._ambientBuildingTypeForState();
        return null;
    }

    _waitDurationForState() {
        const intent = this._currentMotionIntent();
        let base = 90;
        if (this.agent.status === AgentStatus.WORKING) base = 95;
        if (this.agent.status === AgentStatus.WAITING) base = 180;
        if (this.agent.status === AgentStatus.IDLE) base = 310;

        const priority = Number(intent?.priority);
        const priorityBonus = Number.isFinite(priority) ? (priority - 60) * 0.9 : 0;
        const ttlMs = Number.isFinite(Number(intent?.expiresAt))
            ? Math.max(0, Number(intent.expiresAt) - Date.now())
            : 0;
        const ttlBonus = ttlMs > 0 ? Math.min(85, ttlMs / 900) : 0;
        const seed = Math.abs(this._hash(`${this.agent.id}:${intent?.id || this._lastBuildingType || 'ambient'}:${this._lastVisitSlotId || ''}`));
        const jitter = Math.floor((this._noise(seed, 29) - 0.5) * 44);
        const dwell = (base + priorityBonus + ttlBonus + jitter) * this._intentDwellMultiplier(intent);
        return Math.round(this._clamp(dwell, 45, 480));
    }

    // V7 — travel speed is always a whole rung (px per 16.67 ms), so the
    // distance-driven legs hold each walk frame for the same whole number of
    // refreshes. The state picks the rung; intent, model temperament and mood
    // move it at most one rung, and only WORKING may walk the top rung, so the
    // gait still ranks urgency (WORKING > WAITING > IDLE). Congestion drops
    // whole rungs. A chat approach walks the top rung; it never sprints.
    _speedForState() {
        const top = SPEED_RUNGS.length - 1;
        if (this.chatPartner) return SPEED_RUNGS[top];
        const status = this.agent.status;
        let base = RUNG_WAITING;
        if (status === AgentStatus.WORKING) base = RUNG_WORKING;
        else if (status === AgentStatus.IDLE) {
            const type = this._lastBuildingType;
            base = typeof type === 'string' && type.startsWith('ambient:') ? RUNG_STROLL : RUNG_IDLE;
        }
        const temperament = this._intentSpeedMultiplier(this._currentMotionIntent())
            * this._modelBehavior.walkPace
            * this._moodGaitMultiplier();
        const ceiling = base === RUNG_WORKING ? RUNG_WORKING : RUNG_WORKING - 1;
        let rung = this._clamp(
            speedRungIndex(SPEED_RUNGS[base] * temperament),
            Math.max(0, base - 1),
            Math.min(base + 1, ceiling),
        );
        if (this._congestedBuilding()) rung = Math.min(rung, speedRungIndex(SPEED_RUNGS[rung] * CONGESTION_GAIT_SCALE));
        return SPEED_RUNGS[rung];
    }

    /** Mood remains primary: tired/distressed drag, anxious/proud quicken. */
    _moodGaitMultiplier() {
        return moodBehaviorMultiplier(this.agent?.mood, 'walkPace');
    }

    // #13 — mood body language. `staticDy` is the resting head offset (also the
    // reduced-motion fallback: +down = hunch/slump, -up = proud lift), `bobScale`
    // scales the idle bob, and `idleFrame` (when set) pins a held idle frame so
    // the slump/hunch reads as a posture, not a mid-cycle pose. Distressed hunch
    // and tired slump both drop the head; proud lifts it.
    _moodPostureCue() {
        const mood = this.agent?.mood;
        const intensity = this._clamp(Number(mood?.intensity) || 0, 0, 1);
        if (!mood || intensity <= 0) return { bobScale: 1, staticDy: 0, idleFrame: null };
        if (mood.type === 'distressed') {
            // Head-down hunch with a tighter, faster fret in the bob.
            return { bobScale: 1 - 0.35 * intensity, staticDy: Math.round(2 * intensity) || 1, idleFrame: null };
        }
        if (mood.type === 'tired') {
            // Deeper slump; at strong fatigue hold the eye-shut idle frame.
            return {
                bobScale: 1 - 0.5 * intensity,
                staticDy: Math.round(3 * intensity) || 1,
                idleFrame: intensity >= 0.5 ? (IDLE_FRAMES - 1) : null,
            };
        }
        if (mood.type === 'anxious') {
            // Slight forward set remains visible as a static pose under reduced
            // motion; animated breathing tightens without overpowering alerts.
            return { bobScale: 1 + 0.15 * intensity, staticDy: 1, idleFrame: null };
        }
        if (mood.type === 'proud') return { bobScale: 1 + 0.25 * intensity, staticDy: -Math.round(2 * intensity) || -1, idleFrame: null };
        return { bobScale: 1, staticDy: 0, idleFrame: null };
    }

    // #41 — place-specific idle posture for a villager parked at a scenic loiter
    // point (leaning on the harbor rail, reading in the archive alcove, resting
    // on the forest stone). Applies only while standing still at an `ambient:<id>`
    // destination; layered on top of the mood cue. Static-only — the offsets are
    // the same under reduced motion (held frame / lean), so there is nothing to
    // disable. Returns null when not parked at a known scenic point.
    _scenicPostureCue() {
        if (this.moving) return null;
        const type = this._lastBuildingType;
        if (typeof type !== 'string' || !type.startsWith('ambient:')) return null;
        return SCENIC_POINT_POSTURE[type.slice('ambient:'.length)] || null;
    }

    // #40 — true when the agent is in an error/limit incident and storming the
    // Pharos. Errored/rate-limited agents already route to the watchtower (see
    // `_ambientBuildingTypeForState`); this drives the distinct distressed gait
    // and the recovery relief beat.
    _isStorming() {
        const status = this.agent?.status;
        return status === AgentStatus.ERRORED || status === AgentStatus.RATE_LIMITED;
    }

    // #40 — extra head-down drop (px) layered on the resting posture while
    // storming, so a distressed villager reads as hunched even apart from mood.
    // Errored hunches deepest. Used as both the animated bob bias and, under
    // reduced motion, the static head offset — the standing distress tableau.
    _distressPostureDrop() {
        if (!this._isStorming()) return 0;
        return this.agent?.status === AgentStatus.ERRORED ? 3 : 2;
    }

    /** Destination/current building when over visit capacity, else null. */
    _congestedBuilding() {
        const type = this._lastBuildingType
            || this.agent?.targetBuildingType
            || this.agent?.lastKnownBuildingType
            || null;
        if (!type) return null;
        const building = this._buildingForType(type);
        return building?.isCongested?.() ? building : null;
    }

    _currentMotionIntent() {
        const activeIntent = this._activeVisitIntent();
        if (activeIntent?.id && activeIntent.id === this._lastIntentId) return activeIntent;
        return this._lastIntentSnapshot;
    }

    _intentDwellMultiplier(intent) {
        if (!intent) return 1;
        const sourceProfile = INTENT_SOURCE_MOTION[intent.source] || INTENT_SOURCE_MOTION.tool;
        const phaseProfile = PHASE_MOTION[intent.phase] || null;
        return (sourceProfile.dwell || 1) * (phaseProfile?.dwell || 1);
    }

    _intentSpeedMultiplier(intent) {
        if (!intent) return 1;
        const sourceProfile = INTENT_SOURCE_MOTION[intent.source] || INTENT_SOURCE_MOTION.tool;
        const phaseProfile = PHASE_MOTION[intent.phase] || null;
        const priority = Number(intent.priority);
        const priorityFactor = Number.isFinite(priority)
            ? this._clamp(1 + ((priority - 70) / 260), 0.86, 1.16)
            : 1;
        const expiresAt = Number(intent.expiresAt);
        const ttlFactor = Number.isFinite(expiresAt) && expiresAt - Date.now() < 6000 ? 1.06 : 1;
        return (sourceProfile.speed || 1) * (phaseProfile?.speed || 1) * priorityFactor * ttlFactor;
    }

    _clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    setMotionScale(scale) {
        this.motionScale = scale;
        // Arming guards (setHandoffAck) reject reduced motion, but they only run
        // once. An effect already in flight kept reading wall-clock time, so
        // switching reduced motion ON mid-animation did not stop it. Cancel
        // in-flight one-shots here so the gate holds in both directions.
        if (!(scale > 0)) {
            this._handoffAckStart = 0;
            // V7 — reduced motion snaps: a turn in progress lands on its goal
            // and the gait beats end, so the static frame is the settled one.
            if (this._facingGoal != null) this.direction = this._facingGoal;
            this._facingGoal = null;
            this._facingPivot = false;
            this._startBeatMs = 0;
            this._stopBeatMs = 0;
        }
    }

    // 3.7 — hover affordance. Driven by the renderer's mousemove hit-test
    // (rAF-throttled, same geometry as the click hit-test). Static marks only.
    setHovered(flag) {
        this.hovered = !!flag;
    }

    setNickname(nickname) {
        const value = String(nickname || '').trim();
        this.nickname = value || null;
    }

    // #28 — acknowledge a landed handoff baton. The renderer calls this on the
    // child sprite when the director's handoff arc terminates, producing a short
    // 180ms upward bob applied in draw(). Reduced motion (motionScale 0) shows no
    // bob, matching the static-arc fallback in the overlay.
    setHandoffAck(active) {
        if (!active || this.motionScale <= 0) return;
        this._handoffAckStart = Date.now();
    }

    setLightingState(lighting) {
        this.lightingState = lighting || null;
    }

    setArrivalState(state) {
        this._arrivalState = state === 'pending' ? 'pending' : 'visible';
        if (this._arrivalState === 'pending') {
            this._releaseVisitReservation();
            this.behavior.transition('departing', 'arrival-state');
            this.moving = false;
            this.waitTimer = 0;
            this.waypoints = [];
            this._lastPathTileKey = null;
        }
    }

    isArrivalPending() {
        return this._arrivalState === 'pending';
    }

    setTeamPlazaPreference(enabled) {
        this.teamPlazaPreference = !!enabled;
    }

    setFamilyPlazaPreference(tileX, tileY) {
        // route to AgentBehaviorState (30 s TTL).
        this.behavior?.setFamilyPlazaPreference?.(tileX, tileY);
    }

    setTilePosition(tileX, tileY) {
        const screen = tileToWorld(tileX, tileY);
        this.x = screen.x;
        this.y = screen.y;
        this.targetX = screen.x;
        this.targetY = screen.y;
        this.moving = false;
        this.waitTimer = 0;
        this.waypoints = [];
        this._lastPathTileKey = null;
        this._resetWalkCycle();
    }

    walkToTile(tileX, tileY) {
        const screen = tileToWorld(tileX, tileY);
        this._releaseVisitReservation();
        this.chatPartner = null;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this.setArrivalState('visible');
        this._lastPathTileKey = null;
        this._assignTarget(screen.x, screen.y, tileX, tileY);
        this.moving = this._targetReachable;
        this.waitTimer = 0;
    }

    retargetVisit() {
        if (this.chatting || this.chatPartner || this.isArrivalPending()) return false;
        this._releaseVisitReservation();
        this._lastPathTileKey = null;
        this.waitTimer = 0;
        this._pickTarget();
        return true;
    }

    hasReachedTarget(tolerance = 6) {
        return Math.hypot(this.targetX - this.x, this.targetY - this.y) <= tolerance;
    }

    applyAgentUpdate(agent) {
        if (!agent) return;
        const now = Date.now();
        this._pruneActivityTrail(now);
        const previous = this._activitySnapshot || this._captureActivitySnapshot(this.agent, now);
        this.agent = agent;
        this.observation = resolveObservation(agent, now);
        if (this.observation.state === 'stale' && this._turnFrozenAt == null) this._turnFrozenAt = this.observation.observedAt ?? now;
        if (this.observation.state !== 'stale') this._turnFrozenAt = null;
        // Each newly started turn re-arms the completed-turn disclosure; a
        // repeated identical duration is a new fact, not a stale one.
        if (agent.turnStartedAt !== this._observedTurnStartedAt) {
            this._observedTurnStartedAt = agent.turnStartedAt;
            this._lastTurnShownAt = null;
        }
        this._turnSandSecond = null;
        this._modelBehavior = modelBehaviorProfile(agent.model, agent.effort);
        const current = this._captureActivitySnapshot(agent, now);
        if (previous?.key && current?.key && previous.key !== current.key) {
            this._rememberActivitySnapshot(previous, now);
        }
        this._activitySnapshot = current;
        // Feed tool transitions into behavior state for plan-mode tracking
        // and per-agent retry detection (no AgentEventStream edits).
        this._observeToolForBehavior(agent, previous, current);
    }

    _observeToolForBehavior(agent, previous, current) {
        if (!this.behavior?.observeToolTransition) return;
        const tool = String(agent?.currentTool || '').trim();
        if (!tool) return;
        if (previous?.key && current?.key && previous.key === current.key) return;
        const reason = this._classifyToolReason(tool, agent?.currentToolInput);
        this.behavior.observeToolTransition({
            agentId: agent.id || null,
            tool,
            input: agent?.currentToolInput || null,
            reason,
        });
    }

    _classifyToolReason(tool, input) {
        try {
            const classified = classifyTool(tool, input);
            return classified?.reason || null;
        } catch {
            return null;
        }
    }

    update(particleSystem, dt = 16) {
        // V7 — no step yet this refresh: steering never moves a held body.
        this._stepStartX = NaN;
        this._stepLength = 0;
        if (this.isArrivalPending()) {
            this._advanceIdleAnimation(dt);
            return;
        }
        // Lingering departures are a static finished tableau, not an active
        // participant. Clear stale travel/chat state once, then allocate no
        // cadence, particles, paths, or animation work on subsequent frames.
        if (departedTableau(this)) {
            if (!this._departedResting) {
                this._departedResting = true;
                this.moving = false;
                this.chatting = false;
                this.chatPartner = null;
                this.waypoints = [];
                this.targetX = this.x;
                this.targetY = this.y;
                this.animState = 'idle';
                this.frame = 0;
                this._resetWalkCycle();
            }
            return;
        }
        this._departedResting = false;
        const frameScale = Math.max(0, Math.min(3, dt / 16));
        this.statusAnim += 0.05 * this.motionScale * frameScale;
        this.bumpFlash = Math.max(0, this.bumpFlash - 0.08 * frameScale);
        this._advanceMoodPostureMotes(particleSystem);
        this._advanceContextStrainSweat(particleSystem);
        this._advanceDistressRecovery(particleSystem);
        this._advanceTokenFlowMotes(particleSystem, frameScale);
        // V7 — the one facing writer turns one column toward its goal.
        this._advanceFacing(dt);

        // Handle chatting state
        if (this.chatting) {
            this._faceChatPartner();
            this.chatBubbleAnim += 0.06 * this.motionScale * frameScale;
            this._advanceIdleAnimation(dt);
            return; // Do not move while chatting
        }

        // Moving toward the chat partner; start chatting when close. The
        // approach faces its own path; both turn to each other once it stops.
        if (this.chatPartner) {
            const partner = this.chatPartner;
            const cpDx = partner.x - this.x;
            const cpDy = partner.y - this.y;
            const cpDist = Math.sqrt(cpDx * cpDx + cpDy * cpDy);
            if (cpDist < 35) {
                this.chatting = true;
                this.behavior.transition('chatting', 'chat');
                this.chatBubbleAnim = 0;
                this.moving = false;
                this._beginStopBeat();
                this._setFacingGoal(dirFromVelocity(cpDx, cpDy));
                // Put the partner in chat state too
                if (!partner.chatting) {
                    partner.chatPartner = this;
                    partner.chatting = true;
                    partner.behavior?.transition?.('chatting', 'chat');
                    partner.chatBubbleAnim = 0;
                    partner.moving = false;
                    partner._beginStopBeat();
                    // Partner turns back to face us.
                    partner._setFacingGoal(dirFromVelocity(-cpDx, -cpDy));
                }
                return;
            }
            const partnerTile = worldToTile(partner.x, partner.y);
            if (Math.round(partnerTile.tileX) !== this._chatPartnerTileX
                || Math.round(partnerTile.tileY) !== this._chatPartnerTileY) {
                this._routeToChatPartner();
            }
        }

        // Reroute immediately when status or fresh tool changes the intended building.
        if (!this.chatPartner) {
            const activeIntent = this._activeVisitIntent();
            let curBuilding = resolveUpdateRouteBuilding({
                activeIntentBuilding: activeIntent?.building,
                status: this.agent.status,
                currentBuilding: this._lastBuildingType,
                targetBuilding: this.agent.targetBuildingType,
                lastKnownBuilding: this.agent.lastKnownBuildingType,
            });
            if (!activeIntent && this._blockedIntentId && Date.now() < this._blockedIntentRetryAfter) {
                curBuilding = this._lastBuildingType;
            }
            const curIntentId = activeIntent?.id || null;
            const buildingChanged = curBuilding !== this._lastBuildingType;
            const intentChanged = curIntentId && curIntentId !== this._lastIntentId;
            if ((buildingChanged || intentChanged) && this._shouldRetargetForIntent(activeIntent, curBuilding, curIntentId)) {
                this._lastBuildingType = curBuilding;
                this._pickTarget();
            } else if (intentChanged && !buildingChanged) {
                this._adoptIntentWithoutRetarget(activeIntent);
            }
        }

        if (this.waitTimer > 0) {
            if (!this.moving) {
                this._snapToNearestWalkable();
                this._restWorkFacing();
            }
            this._renewVisitReservation();
            this._advanceFidget(dt);
            this.waitTimer -= frameScale;
            if (this.waitTimer <= 0) {
                if (this.behavior.cooldownUntil > Date.now()) {
                    this.behavior.transition('cooldown', this.behavior.reason);
                    this.waitTimer = Math.max(10, Math.ceil((this.behavior.cooldownUntil - Date.now()) / 16));
                    this._advanceIdleAnimation(dt);
                    return;
                }
                this.behavior.finishVisit();
                this._pickTarget();
            }
            this._advanceIdleAnimation(dt);
            return;
        }

        if (!this.moving) {
            this._snapToNearestWalkable();
            this._restWorkFacing();
            this._advanceIdleAnimation(dt);
            this._renewVisitReservation();
            this._pickTarget();
            return;
        }

        this._renewVisitReservation();

        // IDLE strollers stop-and-look at landmarks 1-2 s every 18-30 s.
        if (this._advanceIdleStopAndLook(dt)) {
            this._advanceIdleAnimation(dt);
            return;
        }

        // V7 — the start beat and a planted pivot hold the body on its feet.
        if (this._holdGait(dt)) return;

        // V7 — travel is a whole speed rung per 16.67 ms and carries through
        // waypoints, so neither the pace nor the stride phase breaks at a
        // corner. A new rung re-phases the stride (see _advanceWalkAnimation);
        // the first step after a sharp corner is the part of the step the
        // corner cut short, which puts the stride back on its lattice. The
        // step reads the motion clock's display-latched dt, so every refresh
        // of a steady walk steps the same distance whatever the host jitter.
        const speed = this._speedForState();
        if (speed !== this._gaitSpeed) this._stridePhaseStale = true;
        this._gaitSpeed = speed;
        const strideDt = this._motionClock ? this._motionClock.strideDtMs : dt;
        let remaining = speed * Math.max(0, Math.min(3, strideDt / REF_DT_MS));
        if (this._strideShortStep > 0) {
            // The part of the step a sharp corner cut short. A sliver of it
            // (under STEP_SLIVER_PX) rides on this full step instead, so no
            // refresh translates by less than a backing pixel (a 0-px step).
            remaining = this._strideShortStep >= STEP_SLIVER_PX
                ? Math.min(remaining, this._strideShortStep)
                : remaining + this._strideShortStep;
            this._strideShortStep = 0;
        }
        this._stepStartX = this.x;
        this._stepStartY = this.y;
        let travelled = 0;
        let headingX = this.targetX - this.x;
        let headingY = this.targetY - this.y;
        while (remaining > 0) {
            const dx = this.targetX - this.x;
            const dy = this.targetY - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // V7 — a stop or a sharp corner a sliver beyond this step is
            // reached now: the body plants there instead of creeping onto it
            // by a step that would not move it a backing pixel.
            const sliverToStop = dist > remaining && dist - remaining < STEP_SLIVER_PX
                && this._stopsAtTarget(dx, dy);
            if (dist > remaining && !sliverToStop) {
                this.x += (dx / dist) * remaining;
                this.y += (dy / dist) * remaining;
                travelled += remaining;
                headingX = dx;
                headingY = dy;
                break;
            }
            this.x = this.targetX;
            this.y = this.targetY;
            travelled += dist;
            remaining -= dist;
            if (dist > 0) {
                headingX = dx;
                headingY = dy;
            }
            if (this.waypoints && this.waypoints.length > 0) {
                this.waypoints.shift();
                if (this.waypoints.length > 0) {
                    this.targetX = this.waypoints[0].x;
                    this.targetY = this.waypoints[0].y;
                    // A sharp corner (135° or more) ends the step on the corner
                    // and the next update pivots before the body walks on, so
                    // it never steps backward on its old facing.
                    if (sharpCourseChange(headingX, headingY, this.targetX - this.x, this.targetY - this.y)) {
                        this._strideShortStep = remaining;
                        break;
                    }
                    continue;
                }
            }
            this._advanceWalkAnimation(travelled, headingX, headingY, dt, particleSystem);
            this._stepStartX = NaN;
            this.moving = false;
            this.behavior.arrive({
                state: this._lastIntentId ? 'performing' : 'lingering',
                cooldownMs: this._lastIntentId ? 2000 : 0,
                phase: this._lastIntentSnapshot?.phase || this._phaseForAgentState(),
                interruptible: this._lastIntentSnapshot?.interruptible,
            });
            if (!this.chatPartner) this._faceBuilding(this._buildingForType(this._lastBuildingType), this._lastVisitFacingPoint);
            this.waitTimer = this.chatPartner ? 10 : this._waitDurationForState();
            this._beginStopBeat();
            return;
        }
        this._advanceWalkAnimation(travelled, headingX, headingY, dt, particleSystem);
    }

    // True when the body plants at its current target: the route's last
    // point, or a sharp corner (see sharpCourseChange). `dx`, `dy` is the
    // course onto the target.
    _stopsAtTarget(dx, dy) {
        const next = this.waypoints?.[1];
        if (!next) return true;
        return sharpCourseChange(dx, dy, next.x - this.targetX, next.y - this.targetY);
    }

    // V7 — where renderer steering (lane discipline, local avoidance) may put
    // this body, asked with the position it proposes. A body that stepped
    // this refresh keeps its step's length about the step's start and takes
    // only the steering's change of course: the stride stays on its lattice,
    // so every walk frame covers 4.5 px of the body's real travel, and a
    // crowd nudge never speeds a walker up, stalls it or pushes it past its
    // route progress. Null when the body did not step this refresh (a start
    // beat, a planted pivot, a stop, reduced motion): it never skates.
    steeredPosition(x, y) {
        if (!Number.isFinite(this._stepStartX) || !(this._stepLength > 0)) return null;
        const dx = x - this._stepStartX;
        const dy = y - this._stepStartY;
        const length = Math.hypot(dx, dy);
        if (!(length > 1e-6)) return null;
        const scale = this._stepLength / length;
        return { x: this._stepStartX + dx * scale, y: this._stepStartY + dy * scale };
    }

    // #42 — resolve the terrain class under the sprite's current world position
    // and map it to the matching footfall particle preset. No callback (or an
    // unwalkable deep-water class) yields the default dirt-dust 'footstep'.
    _footfallPresetForSurface() {
        if (!this.getTileType) return 'footstep';
        const { tileX, tileY } = worldToTile(this.x, this.y);
        const surface = this.getTileType(tileX, tileY);
        switch (surface) {
            case 'cobble': return 'cobbleScuff';
            case 'grass': return 'grassMote';
            case 'shallow': return 'shallowSplash';
            default: return 'footstep';
        }
    }

    _advanceWalkAnimation(distance, dx, dy, dt, particleSystem) {
        this.animState = this.motionScale > 0 ? 'walk' : 'idle';
        this._updateFacingDirection(dx, dy, dt);

        if (this.motionScale <= 0) {
            this.frame = 0;
            this.frameTimer = 0;
            this.walkFrame = 0;
            return;
        }

        // Distance-driven stride: one walk frame per 4.5 px of travel, so the
        // feet never slide. V7 — every rung divides 4.5 px, so at a steady pace
        // the stride lands on the same lattice each refresh, and the phase
        // keeps every frame boundary a quarter step off that lattice: half a
        // 120 Hz refresh from the nearest refresh at 60 or 120 Hz, so timing
        // jitter never splits a steady hold. A hold, a new rung or a short
        // corner step moves the lattice, so the phase is re-taken: of the two
        // phases half a step apart, the one nearest the old, so a boundary
        // moves by at most a quarter step.
        const previousFrame = this.frame % WALK_FRAMES;
        const speed = this._gaitSpeed;
        // V7 — the stride counts the body's net travel this refresh; renderer
        // steering keeps that length (`steeredPosition`), so a frame change
        // always covers 4.5 px of real travel.
        this._stepLength = Number.isFinite(this._stepStartX)
            ? Math.hypot(this.x - this._stepStartX, this.y - this._stepStartY)
            : Math.max(0, distance);
        this._strideDistance += this._stepLength;
        this.frame = Math.floor((this._strideDistance + this._stridePhase) / WALK_PIXELS_PER_FRAME) % WALK_FRAMES;
        this.walkFrame = this.frame;
        this.frameTimer = 0;
        if (this._stridePhaseStale && speed > 0) {
            const half = speed / 2;
            const target = (((speed * STRIDE_PHASE_REFRESHES - (this._strideDistance % half)) % half) + half) % half;
            this._stridePhase = target + Math.round((this._stridePhase - target) / half) * half;
            this._stridePhaseStale = false;
        }

        if (
            particleSystem &&
            this.agent.status === AgentStatus.WORKING &&
            previousFrame !== this.frame &&
            FOOTFALL_FRAMES.has(this.frame)
        ) {
            const footSide = this.frame === 0 ? -3 : 3;
            particleSystem.spawn(this._footfallPresetForSurface(), this.x + footSide, this._visualAnchorY() + 3, 1, {
                sortY: this._depthSortY ?? this.y,
            });
        }
    }

    // V7 — gait beats that keep the feet planted. Leaving rest, the body holds
    // its push-off frame for START_BEAT_MS while it turns toward its path; a
    // turn of 135° or more pivots in place until the facing arrives. The body
    // never translates on a held frame, so nothing skates.
    _holdGait(dt) {
        if (this.motionScale <= 0) return false;
        const courseX = this.targetX - this.x;
        const courseY = this.targetY - this.y;
        if (!this._strideActive) {
            this._strideActive = true;
            this._startBeatMs = START_BEAT_MS;
            this._stopBeatMs = 0;
            this._strideDistance = PUSH_OFF_FRAME * WALK_PIXELS_PER_FRAME;
            this._stridePhase = 0;
            this._stridePhaseStale = true;
            this.frame = PUSH_OFF_FRAME;
            this.walkFrame = PUSH_OFF_FRAME;
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
            this._setFacingGoal(dirFromVelocity(courseX, courseY));
        } else if (!this._facingPivot) {
            // A sharp change of course (a corner or a new target behind the
            // walker) turns before the first step, never after it.
            const heading = this._facingGoal ?? this.direction;
            const course = dirFromVelocity(courseX, courseY);
            if (course != null) {
                const columns = (course - heading + 8) % 8;
                if (Math.min(columns, 8 - columns) >= 3) this._setFacingGoal(course);
            }
        }
        if (this._startBeatMs > 0) this._startBeatMs -= dt;
        else if (!this._facingPivot) return false;
        // Time passes on a held frame while the stride does not, so the first
        // step after the hold re-takes the stride phase.
        this._stridePhaseStale = true;
        this.animState = 'walk';
        return true;
    }

    _advanceIdleAnimation(dt) {
        // V7 — the stop beat holds its contact frame, then idle takes over.
        if (this._stopBeatMs > 0) {
            this._stopBeatMs -= dt;
            if (this._stopBeatMs > 0 && this.motionScale > 0) return;
            this._settleIdle();
            return;
        }
        this.animState = 'idle';
        if (this.motionScale <= 0) {
            this.frame = 0;
            this.frameTimer = 0;
            return;
        }
        this.frameTimer += dt;
        const tick = IDLE_FRAME_TICK_MS;
        while (this.frameTimer > tick) {
            this.frame = (this.frame + 1) % IDLE_FRAMES;
            this.frameTimer -= tick;
        }
    }

    // Travel facing: the path's heading becomes the facing goal. A ±45°
    // change must persist DIRECTION_HOLD_MS first (one-tile zig-zags); a
    // larger one is a real change of course and starts turning at once.
    // Reduced motion debounces every change, then snaps.
    _updateFacingDirection(dx, dy, dt) {
        const dir = dirFromVelocity(dx, dy);
        const heading = this._facingGoal ?? this.direction;
        if (dir == null || dir === heading) {
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
            return;
        }
        const columns = (dir - heading + 8) % 8;
        if (this.motionScale > 0 && columns !== 1 && columns !== 7) {
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
            this._setFacingGoal(dir);
            return;
        }
        if (this._candidateDirection !== dir) {
            this._candidateDirection = dir;
            this._candidateDirectionMs = 0;
        }
        this._candidateDirectionMs += dt;
        if (this._candidateDirectionMs >= DIRECTION_HOLD_MS) {
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
            this._setFacingGoal(dir);
        }
    }

    // V7 — the one facing writer. Every source (travel, chat, building,
    // fidget, landmark look) names a goal here; only _advanceFacing and the
    // reduced-motion snap write `direction`, one 45° column per TURN_STEP_MS.
    // An exact reversal turns through the camera-facing side (a face, never a
    // back); a turn of 135° or more plants the stride so the body pivots.
    _setFacingGoal(dir) {
        if (dir == null) return;
        if (this.motionScale <= 0) {
            this.direction = dir;
            this._facingGoal = null;
            this._facingPivot = false;
            return;
        }
        if (dir === this._facingGoal) return;
        if (dir === this.direction) {
            this._facingGoal = null;
            this._facingPivot = false;
            return;
        }
        const from = this.direction;
        const columns = (dir - from + 8) % 8;
        let sign = columns < 4 ? 1 : -1;
        if (columns === 4) {
            const viaPlus = FACING_FRONT_RANK[(from + 2) % 8] * 4 + FACING_FRONT_RANK[(from + 1) % 8];
            const viaMinus = FACING_FRONT_RANK[(from + 6) % 8] * 4 + FACING_FRONT_RANK[(from + 7) % 8];
            sign = viaMinus > viaPlus ? -1 : 1;
        }
        const turning = this._facingGoal != null;
        // A fresh turn takes its first column on the next update.
        if (!turning) this._facingTurnMs = TURN_STEP_MS;
        this._facingPivot = (turning && this._facingPivot) || Math.min(columns, 8 - columns) >= 3;
        this._facingGoal = dir;
        this._facingTurnSign = sign;
    }

    _advanceFacing(dt) {
        const goal = this._facingGoal;
        if (goal == null) return;
        if (this.motionScale <= 0 || goal === this.direction) {
            this.direction = goal;
            this._facingGoal = null;
            this._facingPivot = false;
            return;
        }
        this._facingTurnMs += dt;
        if (this._facingTurnMs < TURN_STEP_MS) return;
        // One column per update at most: no refresh ever turns more than 45°.
        this._facingTurnMs = Math.min(this._facingTurnMs - TURN_STEP_MS, TURN_STEP_MS);
        this.direction = (this.direction + this._facingTurnSign + 8) % 8;
        if (this.direction === goal) {
            this._facingGoal = null;
            this._facingPivot = false;
        }
    }

    // Chat facing is literal: partners face each other along the true
    // bearing (work facing never applies).
    _faceChatPartner() {
        if (!this.chatPartner) return;
        this._setFacingGoal(dirFromVelocity(this.chatPartner.x - this.x, this.chatPartner.y - this.y));
    }

    _faceBuilding(building, facingPoint = null) {
        if (!building && !facingPoint) return;
        const point = this._resolveBuildingFacingPoint(building, facingPoint);
        if (!point) return;
        let center = tileToWorld({ tileX: point.tileX, tileY: point.tileY });
        // A slot whose facing point is its own tile gives no bearing; the
        // body then addresses the building's centre instead.
        if (building && Math.abs(center.x - this.x) < 1 && Math.abs(center.y - this.y) < 1) {
            const centre = buildingCentreTile(building);
            if (centre) center = tileToWorld(centre);
        }
        const bearingX = center.x - this.x;
        const bearingY = center.y - this.y;
        const trueDir = dirFromVelocity(bearingX, bearingY);
        if (trueDir == null) return;
        this._workBearing = Math.atan2(bearingY, bearingX);
        this._setFacingGoal(this._workFacing(trueDir, bearingX));
    }

    // 0.5 / V7 — work facing (M20). A villager at its building stands
    // side-on instead of showing the operator its back: a north bearing turns
    // to NE or NW, toward the door's side (`doorDx`, world px from the body to
    // the facing point), NE turns to E and NW to W. Each result stays within
    // 67.5° of the true bearing, so the body still addresses its building.
    _workFacing(trueDir, doorDx = 0) {
        if (trueDir === DIR_NE) return DIR_E;
        if (trueDir === DIR_NW) return DIR_W;
        if (trueDir !== DIR_N) return trueDir;
        if (doorDx > 0) return DIR_NE;
        if (doorDx < 0) return DIR_NW;
        // Dead under the door: a stable per-agent side from the seeded phase.
        return this._idlePhaseFrames & 1 ? DIR_NE : DIR_NW;
    }

    // 0.5 — a villager at rest never settles with its back to the operator.
    // A back-facing heading left by travel (an aborted start, a blocked or
    // re-picked route) turns to its work facing; NE/NW stays only when the
    // bearing to its building is north. Chat facing is exempt.
    _restWorkFacing() {
        if (this.chatting || this.chatPartner) return;
        const heading = this._facingGoal ?? this.direction;
        if (FACING_FRONT_RANK[heading] !== 0) return;
        const bearing = this._workBearing;
        const doorDx = bearing == null ? 0 : Math.cos(bearing);
        if (heading !== DIR_N && bearing != null && dirFromVelocity(doorDx, Math.sin(bearing)) === DIR_N) return;
        this._setFacingGoal(this._workFacing(heading, doorDx));
    }

    // 0.5 — a fidget glances one column aside from the work facing, never into
    // a back-facing column (NE, N, NW) and never past the half-plane facing
    // its building. With neither side open the villager holds still.
    _fidgetGlance(sign) {
        const from = this._facingGoal ?? this.direction;
        const first = (from + sign + 8) % 8;
        if (this._glanceAllowed(first)) return first;
        const second = (from - sign + 8) % 8;
        return this._glanceAllowed(second) ? second : null;
    }

    _glanceAllowed(dir) {
        if (FACING_FRONT_RANK[dir] === 0) return false;
        const bearing = this._workBearing;
        return bearing == null || angleOffDirection(dir, bearing) <= Math.PI / 2 + 1e-9;
    }

    _resolveBuildingFacingPoint(building, explicitFacingPoint = null) {
        const finite = (value) => Number.isFinite(Number(value));
        const wrap = (raw) => {
            if (!raw) return null;
            const fx = Number(raw.x ?? raw.tileX);
            const fy = Number(raw.y ?? raw.tileY);
            if (!finite(fx) || !finite(fy)) return null;
            return { tileX: fx, tileY: fy };
        };
        const fromExplicit = wrap(explicitFacingPoint);
        if (fromExplicit) return fromExplicit;
        const fromLastVisit = wrap(this._lastVisitFacingPoint);
        if (fromLastVisit) return fromLastVisit;
        const visitFacing = wrap(this._currentVisitTileEntry(building)?.facingPoint);
        if (visitFacing) return visitFacing;
        const fromBuilding = wrap(building?.facingPoint);
        if (fromBuilding) return fromBuilding;
        return buildingCentreTile(building);
    }

    _currentVisitTileEntry(building) {
        if (!building || !Array.isArray(building.visitTiles) || !this._lastTargetTile) return null;
        const tx = Math.round(this._lastTargetTile.tileX);
        const ty = Math.round(this._lastTargetTile.tileY);
        for (const entry of building.visitTiles) {
            if (!entry) continue;
            if (Math.round(Number(entry.tileX)) === tx && Math.round(Number(entry.tileY)) === ty) return entry;
        }
        return null;
    }

    _advanceFidget(dt) {
        if (this.motionScale <= 0 || this.chatting || this.chatPartner) return;
        if (this._fidgetActiveMs > 0) {
            this._fidgetActiveMs -= dt;
            if (this._fidgetActiveMs <= 0) {
                this._fidgetActiveMs = 0;
                this._faceBuilding(this._buildingForType(this._lastBuildingType), this._lastVisitFacingPoint);
            }
            return;
        }
        if (this._fidgetCooldownMs == null) {
            this._fidgetCooldownMs = this._nextFidgetCooldownMs();
        }
        // Re-anchor 4-9 s nudges back to building facingPoint when dwelling.
        if (this._anchorReinforceMs == null) {
            this._anchorReinforceMs = 4000 + this._fidgetRandom() * 5000;
        }
        this._anchorReinforceMs -= dt;
        if (this._anchorReinforceMs <= 0) {
            const building = this._buildingForType(this._lastBuildingType);
            if (building) this._faceBuilding(building, this._lastVisitFacingPoint);
            this._anchorReinforceMs = 4000 + this._fidgetRandom() * 5000;
        }
        this._fidgetCooldownMs -= dt;
        if (this._fidgetCooldownMs <= 0) {
            const glance = this._fidgetGlance(this._fidgetRandom() > 0.5 ? 1 : -1);
            if (glance != null) this._setFacingGoal(glance);
            this._fidgetActiveMs = 600 + this._fidgetRandom() * 400;
            this._fidgetCooldownMs = this._nextFidgetCooldownMs();
        }
    }

    // 2.4 — seeded fidget stream (xorshift on the id-derived seed). Repeatable
    // per agent, allocation-free, and never consulted for mood or rank.
    _fidgetRandom() {
        let seed = this._fidgetSeed;
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        this._fidgetSeed = seed || 1;
        return this._fidgetSeed / 4294967296;
    }

    // Pulse band: `intrinsic` (slow). The band only detunes when a discrete
    // fidget may recur; reduced motion exits before allocating cadence state.
    _nextFidgetCooldownMs() {
        const bandScale = pulseAlpha('intrinsic', this.statusAnim, this.motionScale, 0.9, 1.1);
        const moodScale = moodBehaviorMultiplier(this.agent?.mood, 'fidgetInterval');
        const base = FIDGET_COOLDOWN_MIN_MS + this._fidgetRandom() * FIDGET_COOLDOWN_RANGE_MS;
        return base * this._modelBehavior.fidgetInterval * moodScale * bandScale;
    }

    _advanceIdleStopAndLook(dt) {
        // Every 18-30 s, IDLE agents pause 1-2 s and face a landmark.
        if (this.motionScale <= 0 || this.chatPartner || this.chatting) return false;
        if (this.agent?.status !== AgentStatus.IDLE) return false;
        if (this._stopLookActiveMs > 0) {
            this._stopLookActiveMs -= dt;
            if (this._stopLookActiveMs <= 0) {
                this._stopLookActiveMs = 0;
            }
            return true;
        }
        if (this._stopLookCooldownMs == null) {
            this._stopLookCooldownMs = 18000 + Math.random() * 12000;
        }
        this._stopLookCooldownMs -= dt;
        if (this._stopLookCooldownMs <= 0) {
            // V7 — the stroller stops on a contact frame before it looks.
            this._beginStopBeat();
            const nearest = this._nearestLandmarkBuilding();
            if (nearest) this._faceBuilding(nearest);
            this._stopLookActiveMs = 1000 + Math.random() * 1000;
            this._stopLookCooldownMs = 18000 + Math.random() * 12000;
            return true;
        }
        return false;
    }

    _nearestLandmarkBuilding() {
        let best = null;
        let bestDist = Infinity;
        for (const def of BUILDING_DEFS) {
            if (!def || typeof def.x !== 'number' || typeof def.y !== 'number') continue;
            const cx = def.x + (Number(def.width) || 1) / 2;
            const cy = def.y + (Number(def.height) || 1) / 2;
            const center = tileToWorld({ tileX: cx, tileY: cy });
            const dist = Math.hypot(center.x - this.x, center.y - this.y);
            if (dist < bestDist) {
                bestDist = dist;
                best = def;
            }
        }
        return best;
    }

    // Settle at rest at once: the stride and travel-facing debounce clear and
    // the body takes its seeded idle phase. Every stop goes through here.
    _resetWalkCycle() {
        this._strideActive = false;
        this._startBeatMs = 0;
        this._strideDistance = 0;
        this._strideShortStep = 0;
        this._candidateDirection = null;
        this._candidateDirectionMs = 0;
        this._settleIdle();
    }

    _settleIdle() {
        this._stopBeatMs = 0;
        this.walkFrame = 0;
        // 3.1 — resume idle on the agent's seeded phase so agents arriving
        // together do not re-synchronize their breathing.
        this.frameTimer = this._idlePhaseTimerMs;
        this.frame = this._idlePhaseFrames;
        this.animState = 'idle';
    }

    // V7 — the stop beat: a walker lands on its nearest contact frame (feet
    // planted) and holds it for STOP_BEAT_MS before its idle phase takes over.
    // Reduced motion, or a body already at rest, settles at once.
    _beginStopBeat() {
        const walking = this.motionScale > 0 && this.animState === 'walk';
        const frame = this.frame;
        this._resetWalkCycle();
        if (!walking) return;
        this.frame = nearestContactFrame(frame);
        this.walkFrame = this.frame;
        this.animState = 'walk';
        this._stopBeatMs = STOP_BEAT_MS;
    }

    /** Start chat (called from IsometricRenderer) */
    startChat(partnerSprite) {
        this._releaseVisitReservation();
        this.behavior.transition('chat-approach', 'chat');
        this.chatPartner = partnerSprite;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this._pickTarget(); // start moving toward the partner
    }

    /** End chat */
    // Renderer-synced tool ritual pose (see RitualConductor.getAgentPoses).
    setToolRitualPose(ritual) {
        const next = ritual && ritual.pose ? ritual : null;
        this._toolRitual = next;
    }

    endChat() {
        this._releaseVisitReservation();
        this.chatPartner = null;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this.behavior.finishVisit();
        this.behavior.transition('cooldown', 'chat-ended');
        this._pickTarget(); // resume normal behavior
    }

    getBehaviorDebugSnapshot() {
        const tile = this._screenToTile(this.x, this.y);
        const behavior = this.behavior.snapshot();
        return {
            agentId: this.agent?.id || null,
            name: this.agent?.displayName || this.agent?.name || null,
            status: this.agent?.status || null,
            building: this._lastBuildingType,
            intentId: this._lastIntentId,
            reservationId: this._lastReservationId,
            visitSlotId: this._lastVisitSlotId,
            visitFacingPoint: this._lastVisitFacingPoint ? { ...this._lastVisitFacingPoint } : null,
            visitMeta: this._lastVisitMeta ? { ...this._lastVisitMeta } : null,
            routeIntent: this._lastIntentSnapshot ? { ...this._lastIntentSnapshot } : null,
            intentStableUntil: this._intentStableUntil,
            blockedIntentId: this._blockedIntentId,
            blockedIntentRetryAfter: this._blockedIntentRetryAfter,
            lastBlockedRecovery: this._lastBlockedRecovery ? { ...this._lastBlockedRecovery } : null,
            behaviorState: behavior.state,
            behaviorReason: behavior.reason,
            goal: behavior.currentGoal || this._lastIntentSnapshot?.goal || null,
            itinerary: behavior.currentItinerary
                ? this._cloneIntentItinerary(behavior.currentItinerary)
                : this._cloneIntentItinerary(this._lastIntentSnapshot?.itinerary),
            recentBuildings: behavior.recentBuildings,
            behavior,
            targetTile: this._lastTargetTile ? { ...this._lastTargetTile } : null,
            tile,
            moving: this.moving,
            chatting: this.chatting,
            waypointCount: this.waypoints?.length || 0,
        };
    }

    _currentBridgeLift() {
        if (!this.getBridgeLift) return 0;
        const tile = worldToTile(this.x, this.y);
        const lift = Number(this.getBridgeLift(tile.tileX, tile.tileY)) || 0;
        return Math.max(0, lift);
    }

    _visualAnchorY() {
        return this.y - this._currentBridgeLift();
    }

    withBridgeLift(callback) {
        if (typeof callback !== 'function') return undefined;
        const lift = this._currentBridgeLift();
        if (lift <= 0) return callback();
        // Rendering reads this.y throughout the anchored effect stack. Shift it
        // only for the synchronous draw, then restore the base Y so painter
        // sorting, movement, routing, and relationship geometry stay unchanged.
        const baseY = this.y;
        this.y = baseY - lift;
        try {
            return callback();
        } finally {
            this.y = baseY;
        }
    }

    draw(ctx, zoom = 1, renderMode = 'full') {
        return this.withBridgeLift(() => this._drawAtScreenPosition(ctx, zoom, renderMode));
    }

    _drawAtScreenPosition(ctx, zoom = 1, renderMode = 'full') {
        this._zoom = zoom;

        if (this.isArrivalPending()) return;

        // V7 — the one placement value of this frame (snapBodyPx). The body
        // (Canvas and GPU record), crowd LOD, impostors, ground marks, x-ray,
        // body box, hit test and every head or name anchor read it, so no
        // per-agent layer detaches by a sub-texel from the body.
        const placeDpr = Number(ctx?.canvas?._claudeVilleDpr) || 1;
        const placeMoving = bodyPlacementMoving(this);
        this._placeDpr = placeDpr;
        this._placeX = snapBodyPx(this.x, placeMoving, zoom, placeDpr);
        this._placeY = snapBodyPx(this.y, placeMoving, zoom, placeDpr);

        // Archive fade. The renderer sets `_archiveAnim = { startedAt }` on
        // agent:removed and disposes the sprite when progress >= 1; our job is
        // the visual fade + sparkle flash + pinned FINAL bubble. We wrap the
        // remaining draw body in save/restore so alpha unwinds cleanly.
        const archiveProgress = this._archiveFadeProgress();
        if (archiveProgress >= 1) return;
        let archivePushed = false;
        if (archiveProgress > 0) {
            ctx.save();
            // Reduced-motion (motionScale === 0): hard cut, no ramp.
            const fadeAlpha = this.motionScale > 0 ? Math.max(0, 1 - archiveProgress) : 0;
            ctx.globalAlpha *= fadeAlpha;
            // #32 — departure dissolves upward: lift the whole sprite a few
            // pixels as it fades so it reads as rising away, not vanishing in
            // place. Eased so the drift accelerates with the fade. Reduced
            // motion already hard-cuts (fadeAlpha 0), so the shift is unseen.
            if (this.motionScale > 0) {
                ctx.translate(0, -easeOutCubic(archiveProgress) * 9);
            }
            archivePushed = true;
        }

        const currentStatus = this.agent?.status || null;
        if (currentStatus !== this._lastStatus) {
            if (currentStatus === AgentStatus.COMPLETED) this._completedAtMs = Date.now();
            // 2.3 — the command slip is sealed only here, on the observed
            // lifecycle transition out of the wait. A pending approval, however
            // old, never earns the seal.
            if (this._lastStatus === AgentStatus.WAITING_ON_USER && this._lastWaitReason === 'approval') {
                this._sealedSlipUntil = Date.now() + SEALED_SLIP_MS;
            }
            this._lastStatus = currentStatus;
        }
        if (currentStatus === AgentStatus.WAITING_ON_USER) this._lastWaitReason = this.agent?.waitReason || null;

        const budgetMode = renderMode !== 'full' && !this.selected && !this.hovered
            && ![AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(this.agent?.status);
        if (budgetMode && !this.gpuWorldEnabled) {
            this._drawBudgetImpostor(ctx);
            if (departedTableau(this)) this.gpuOverlayRenderer.drawDepartedTreatment(ctx);
            this._drawNameTag(ctx);
            if (archivePushed) ctx.restore();
            return;
        }

        if (!this.compositor) {
            if (archivePushed) ctx.restore();
            return;
        }

        const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
        const provider = this._providerKey();
        const variant = this._hashVariant();
        const spriteId = identity.spriteId || `agent.${provider}.base`;
        // 2.4 — the signature belongs to (agent id, canonical sprite family).
        this.signature(spriteId);
        const paletteKey = identity.paletteKey || provider;
        const accessory = this._runtimeHeadAccessory(identity, this.agent);
        const equipmentKey = this._runtimeCodexEquipment(identity) || '_';
        const cleanupKey = this._shouldScrubBakedCodexWeapon(identity)
            ? `clean:${String(identity.modelClass || 'codex').toLowerCase()}`
            : 'raw';
        // Team-colored sash trim. teamTrim is null when the agent has no
        // teamName, so spriteFor falls back to the variant-derived trim color
        // and cache hits remain identical to the pre-team behavior.
        const teamTrim = this._teamTrimAccent();
        const teamHash = teamTrim || '_';
        const profileKey = `${spriteId}|${paletteKey}|${variant}|${accessory || '_'}|${equipmentKey}|${cleanupKey}|${teamHash}`;
        const equipmentAssetId = CODEX_WEAPON_ASSETS[equipmentKey]?.id || null;
        const accessoryAssetId = accessory
            ? accessory.startsWith('overlay.') ? accessory : `overlay.accessory.${accessory}`
            : null;
        this._syncProfileOwnership(profileKey, [spriteId, equipmentAssetId, accessoryAssetId]);

        if (!this.spriteCanvas || this._spriteProfileKey !== profileKey) {
            const profileRefs = ACTIVE_PROFILE_REFS.get(profileKey);
            // Plan 2.4 — the shared rim is baked into the sheet both backends
            // sample. Sheets that get their baked weapon scrubbed take the rim
            // after the scrub (_prepareSpriteCanvas), so no ghost outline is
            // left where the weapon was.
            const baseCanvas = profileRefs?.baseCanvas
                || this.compositor.spriteFor(spriteId, paletteKey, variant, accessory, teamTrim, {
                    outline: !this._shouldScrubBakedCodexWeapon(identity),
                });
            if (baseCanvas) {
                baseCanvas.__cvProfileKeys ||= new Set();
                baseCanvas.__cvProfileKeys.add(profileKey);
                if (profileRefs) profileRefs.baseCanvas = baseCanvas;
            }
            // GPU animation samples this sheet as a texture. Start from the
            // untouched generated sheet — the scrubbed Canvas sheet alone
            // shows missing limbs during movement — and let
            // _syncGpuEquippedSheet replace it with an equipment-baked copy
            // for codex classes, or WebGL villagers render empty-handed.
            this._gpuBaseSpriteCanvas = baseCanvas;
            this.spriteCanvas = this._prepareSpriteCanvas(baseCanvas, identity, profileKey);
            if (this.spriteCanvas) {
                this.spriteSheet = new SpriteSheet(this.spriteCanvas);
                this._spriteProfileKey = profileKey;
                releaseCanvasMap(this._frozenTintCellCache);
                this._updatePrivateDerivedEstimate();
                this._cellBoundsCache.clear();
            }
        }

        if (!this.spriteCanvas || !this.spriteSheet) {
            if (archivePushed) ctx.restore();
            return;
        }

        this._syncGpuEquippedSheet(identity, profileKey);

        // The update loop owns the body's pose (walk, stop beat, idle);
        // lingering departures and reduced motion hold a resting idle frame
        // even if stale movement state remains on the projected agent.
        if (departedTableau(this) || this.motionScale <= 0) this.animState = 'idle';

        // Plan 2.7 — crowd-pressure GPU bodies sample the baked 0.5x LOD sheet
        // at world scale 1, so they stay on the world's texel grid instead of
        // a fractional nearest minification. Selected, hovered and
        // action-needed agents never take this branch and stay 1:1. V7 — the
        // LOD cell stands on the same per-direction foot anchor as the 1:1
        // body; its own bounds only size the body box.
        if (budgetMode) {
            const cell = this.spriteSheet.cell(this.animState, this.direction, this.frame);
            const bounds = this._getCellContentBounds(cell);
            const anchor = this._stableFootAnchor(this.direction);
            const drawX = this._placeX;
            const drawY = this._placeY;
            const dx = drawX - Math.round(anchor.cx2 * CROWD_LOD_SCALE / 2);
            const dy = drawY + 2 - Math.floor(anchor.maxY * CROWD_LOD_SCALE);
            const contentTopY = dy + Math.floor(bounds.minY * CROWD_LOD_SCALE);
            this._setBodyBox(
                drawX,
                drawY,
                dx + Math.floor(bounds.minX * CROWD_LOD_SCALE),
                contentTopY,
                dx + Math.ceil((bounds.maxX + 1) * CROWD_LOD_SCALE),
                drawY + 3,
            );
            this._layoutGroundMarks(this._stableContentWidth() * CROWD_LOD_SCALE);
            const frameGeometry = {
                cell,
                dx,
                dy,
                bounds,
                drawScale: CROWD_LOD_SCALE,
                cacheEquipment: true,
                lod: true,
            };
            this._setGpuFrameRecord({
                cell,
                dx,
                dy,
                drawScale: CROWD_LOD_SCALE,
                profileKey,
                spriteId,
                alpha: 1,
                contentTopY,
                identity,
                frameGeometry,
                lod: true,
            });
            this._drawBudgetImpostor(ctx);
            this._drawNameTag(ctx);
            if (archivePushed) ctx.restore();
            return;
        }

        if (!this.selected && zoom < 1) {
            // Plan 2.3 — the overview keeps the same single contact shadow.
            this._layoutGroundMarks(this._stableContentWidth());
            if (!this.gpuWorldEnabled) drawGroundMarks(ctx, this._groundMarks);

            this._drawLowZoomImpostor(ctx, zoom);
            if (departedTableau(this) && !this.gpuWorldEnabled) {
                this.gpuOverlayRenderer.drawDepartedTreatment(ctx);
            }
            // T1 — waiting, errored and rate-limited agents are marked by the
            // overlay's attention beacon and plate (AttentionPlates.js), which
            // hold at every zoom, including this overview.
            this._drawToolGlyphBadge(ctx);
            if (archivePushed) ctx.restore();
            return;
        }

        // #13 — tired villagers hold an eye-shut idle frame; the posture cue
        // supplies the override so the slump reads as a held rest, not motion.
        const posture = this._moodPostureCue();
        // #41 — when there is no active mood override, a villager parked at a
        // scenic loiter point adopts a place-specific resting stance (lean,
        // read, gaze). Mood always wins; scenic posture only fills the neutral
        // idle case. Purely static (no pulse), so reduced motion shows the same.
        if (posture.staticDy === 0 && posture.bobScale === 1 && posture.idleFrame == null) {
            const scenic = this._scenicPostureCue();
            if (scenic) {
                if (Number.isFinite(scenic.staticDy)) posture.staticDy = scenic.staticDy;
                if (Number.isFinite(scenic.bobScale)) posture.bobScale = scenic.bobScale;
                if (scenic.idleFrame != null) posture.idleFrame = scenic.idleFrame;
            }
        }
        const renderFrame = (this.animState === 'idle' && posture.idleFrame != null)
            ? posture.idleFrame
            : this.frame;
        const cell = this.spriteSheet.cell(this.animState, this.direction, renderFrame);
        // 2.2 — an authored action pose replaces the idle body for this frame.
        // Geometry stays the base cell's (same 92 px cell, same feet anchor), so
        // only the source image and source rect change and the body never jumps.
        const pose = this._actionStripPose(identity, spriteId);
        const bodyCell = pose ? pose.cell : cell;
        const bodySource = pose ? pose.source : this.spriteCanvas;
        const poseSource = pose ? pose.source : null;
        this._poseCell = {
            sx: bodyCell.sx,
            sy: bodyCell.sy,
            sw: bodyCell.sw,
            sh: bodyCell.sh,
            source: pose ? 'strip' : 'sheet',
            group: pose ? pose.group : null,
            canvas: bodySource,
            // Where this cell was laid out (world texels); the x-ray re-blits it.
            dx: 0,
            dy: 0,
        };
        const cellSize = this.spriteSheet?.cellSize || 92;
        const bounds = this._getCellContentBounds(cell);
        // Subtle ±0.6px sinusoidal bob while idle so the eye can find still agents.
        // IDLE-status agents bob slower and shallower to read as "resting".
        const isIdleStatus = this.agent?.status === AgentStatus.IDLE;
        // #40 — distressed villagers carry a head-down drop while storming the
        // Pharos, layered on the idle bob (animated) or the static posture
        // offset (reduced motion). Walking keeps the drop so the gait reads
        // hunched all the way to the watchtower.
        const distressDrop = this._distressPostureDrop();
        const bobY = departedTableau(this)
            ? 2
            : this.animState === 'idle'
            ? this.motionScale > 0
                ? Math.round(
                    (
                        isIdleStatus
                            ? Math.sin(this.frame * 0.25) * 0.4
                            : Math.sin(this.frame * 0.4) * 0.6
                    ) * posture.bobScale,
                ) + distressDrop
                : posture.staticDy + distressDrop
            : distressDrop;
        // #28 — handoff acknowledgement: a single 180ms upward dip-and-settle so
        // the baton landing reads as the child nodding back. Half-sine envelope;
        // never fires under reduced motion (setHandoffAck guards motionScale 0).
        let ackBobY = 0;
        if (this._handoffAckStart && this.motionScale > 0) {
            const ackAge = Date.now() - this._handoffAckStart;
            if (ackAge >= 0 && ackAge < 180) {
                ackBobY = -Math.round(Math.sin((ackAge / 180) * Math.PI) * 2.4);
            } else {
                this._handoffAckStart = 0;
            }
        }
        // V7 — every cell of this facing (walk, idle, action strip, GPU
        // record) stands on one foot anchor at the frame's placement, so arm
        // swing or a lifted foot never shifts the whole body. The per-frame
        // bounds only size the body box, labels and hit test.
        const anchor = this._stableFootAnchor(this.direction);
        const drawX = this._placeX;
        const drawY = this._placeY;
        // #36 — context-strain tremble: a tiny ±1px horizontal shiver once the
        // context window is nearly full (ratio >= 0.85), so the body language
        // reads as strain. Reduced motion (motionScale 0) skips the shiver.
        const trembleX = this._contextStrainTremble();
        const dx = drawX - Math.round(anchor.cx2 / 2) + trembleX;
        const dy = drawY - anchor.maxY + 2 + bobY + ackBobY;
        this._poseCell.dx = dx;
        this._poseCell.dy = dy;
        const contentTopY = dy + bounds.minY;
        this._setBodyBox(drawX, drawY, dx + bounds.minX, contentTopY, dx + bounds.maxX + 1, dy + bounds.maxY + 1);
        // Plan 2.3 — one contact shadow, plus a ring only when it means
        // something. Painted before the body so the body covers the back arc.
        this._layoutGroundMarks(this._stableContentWidth());
        if (!this.gpuWorldEnabled) drawGroundMarks(ctx, this._groundMarks);
        const frameGeometry = {
            cell,
            dx,
            dy,
            bounds,
            cellSize,
            drawScale: 1,
            cacheEquipment: archiveProgress <= 0,
        };
        this._setGpuFrameRecord({
            cell,
            dx,
            dy,
            drawScale: 1,
            profileKey,
            spriteId,
            alpha: archiveProgress > 0 ? Math.max(0, 1 - archiveProgress) : 1,
            contentTopY,
            identity,
            frameGeometry,
            // 2.2 — the resident renderer samples the same authored cell the
            // Canvas body blits, so both backends show one pose.
            pose,
        });
        // Agent records are submitted independently of terrain coverage, even
        // beyond the island. Only the resident backend owns their body paint.
        const canvasBody = !this.gpuWorldEnabled;
        const departedBody = departedTableau(this) && !this.gpuWorldEnabled;
        if (departedBody) {
            ctx.save();
            ctx.filter = 'grayscale(0.9) saturate(0.25) brightness(0.72)';
            ctx.globalAlpha *= 0.72;
        }
        // An authored pose owns its own hands: a strip that declares a sheathed
        // grip parks the runtime weapon instead of painting it over the prop.
        const sheathed = Boolean(pose && pose.strip?.meta?.grip?.sheathe);
        if (canvasBody) {
            if (!sheathed) this._drawCodexEquipment(ctx, identity, frameGeometry, 'back');
            // Plan 2.4 — the rim is baked into the sheet, identical to the
            // resident atlas; no per-frame halo pass.
            ctx.drawImage(
                bodySource,
                bodyCell.sx, bodyCell.sy, bodyCell.sw, bodyCell.sh,
                dx, dy, bodyCell.sw, bodyCell.sh
            );
        }
        // Frozen/darkened body tint while rate-limited — static overlay, so it
        // reads identically under reduced motion. No GPU channel owns this tint.
        if (this.agent?.status === AgentStatus.RATE_LIMITED) {
            this._drawFrozenTint(ctx, bodyCell, dx, dy, poseSource);
        }
        if (canvasBody && !sheathed) this._drawCodexEquipment(ctx, identity, frameGeometry, 'front');
        if (departedBody) ctx.restore();
        // These five marks belong to the body frame and have exactly one owner
        // per backend: this Canvas pass, or the resident renderer's ungraded
        // overlay (AgentGpuOverlayRenderer.draw), which replays the identical
        // geometry from the frame record. Running both would strike every mark
        // twice on the GPU path — compounded alpha on any frame where the
        // Canvas layer shows through, and double the annotation work always.
        if (!departedTableau(this) && !this.gpuWorldEnabled) {
            this._drawSignatureMark(ctx, frameGeometry);
            this._drawReceiveBeat(ctx, frameGeometry);
            this._drawStanceOverlay(ctx, frameGeometry);
            this._drawActionPoseOverlay(ctx, frameGeometry);
            this._drawToolRitualOverlay(ctx, frameGeometry);
        }
        if (departedTableau(this) && !this.gpuWorldEnabled) {
            this.gpuOverlayRenderer.drawDepartedTreatment(ctx);
        }

        // Plan 2.5 — selection frames the character, never veils it: the pixel
        // ring is on the ground (above) and a small chevron floats over the
        // head. The resident renderer draws the chevron on its ungraded overlay.
        if (this.selected && !this.gpuWorldEnabled) this._drawSelectionChevron(ctx, contentTopY);

        // Everything anchored over the head clears the chevron, so no label
        // ever crosses the body. On the resident backend the ungraded overlay
        // (AgentGpuOverlayRenderer.draw) is the one owner of the chat bubble,
        // status chip, emote, plan and retry glyphs and name plate; striking
        // them here too drew each twice per frame.
        if (!this.gpuWorldEnabled) {
            const labelTopY = this._labelTopY(contentTopY);
            if (this.chatting && !departedTableau(this)) {
                this._drawChatEffect(ctx, labelTopY);
            } else if (!departedTableau(this)) {
                this._drawStatus(ctx, labelTopY);
            }
            if (!departedTableau(this)) this._drawStatusEmote(ctx, labelTopY);
            // Plan-mode and retry glyphs sit above the silhouette. The status
            // emote (kind != null) wins the slot; otherwise plan-mode glyph
            // renders slightly higher. Retry glyph renders to the right.
            if (!departedTableau(this)) {
                this._drawPlanModeGlyph(ctx, labelTopY);
                this._drawRetryGlyph(ctx, labelTopY);
            }
            this._drawNameTag(ctx);
        }

        // Sparkle flash during the first 200 ms of the archive fade.
        // Reduced-motion skips entirely; otherwise we draw a brief radial puff
        // around the sprite head using the status color (no ParticleSystem
        // access from inside draw — keep it procedural and self-contained).
        if (archiveProgress > 0 && this.motionScale > 0) {
            this._drawArchiveSparkle(ctx, contentTopY, archiveProgress);
        }
        if (archivePushed) ctx.restore();
    }

    _prepareSpriteCanvas(baseCanvas, identity, cacheKey) {
        if (!baseCanvas || !this._shouldScrubBakedCodexWeapon(identity)) return baseCanvas;
        if (PROCESSED_SPRITE_CACHE.has(cacheKey)) {
            const cached = PROCESSED_SPRITE_CACHE.get(cacheKey);
            PROCESSED_SPRITE_CACHE.delete(cacheKey);
            PROCESSED_SPRITE_CACHE.set(cacheKey, cached);
            return cached;
        }

        const canvas = document.createElement('canvas');
        canvas.width = baseCanvas.width;
        canvas.height = baseCanvas.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(baseCanvas, 0, 0);
        this._clearBakedCodexSidearmPixels(ctx, canvas.width, canvas.height, identity.modelClass);
        // Plan 2.4 — the rim follows the scrub so it traces only what remains.
        bakeSpriteOutline(ctx, canvas.width, canvas.height, Math.round(canvas.width / DIRECTIONS.length) || DEFAULT_CELL);
        PROCESSED_SPRITE_CACHE.set(cacheKey, canvas);
        canvas.__cvProfileKey = cacheKey;
        processedSpriteCachePixels += canvas.width * canvas.height;
        while (
            PROCESSED_SPRITE_CACHE.size > PROCESSED_SPRITE_CACHE_ENTRY_LIMIT
            || processedSpriteCachePixels > PROCESSED_SPRITE_CACHE_PIXEL_LIMIT
        ) {
            const oldestKey = oldestUnpinnedCacheKey(PROCESSED_SPRITE_CACHE);
            if (oldestKey == null) break;
            const oldest = PROCESSED_SPRITE_CACHE.get(oldestKey);
            PROCESSED_SPRITE_CACHE.delete(oldestKey);
            processedSpriteCachePixels -= (oldest?.width || 0) * (oldest?.height || 0);
            releaseSharedEntry(oldest);
        }
        processedSpriteCachePixels = Math.max(0, processedSpriteCachePixels);
        return canvas;
    }

    _shouldScrubBakedCodexWeapon(identity) {
        if (!identity) return false;
        // These sheets are empty-handed (GPT-5.4 is cleaned by Compositor
        // before placing crests). Color-key scrubbing eats their real wrists.
        if (['agent.codex.base', 'agent.codex.gpt53spark', 'agent.codex.gpt54', 'agent.codex.gpt55',
            'agent.codex.gpt55.high', 'agent.codex.gpt55.xhigh'].includes(identity.spriteId)) return false;
        // Explicit opt-out (GPT-5.6 triad): armor colors overlap the scrub
        // selectors, and the base sprites are generated empty-handed.
        if (identity.suppressBakedWeapon === false) return false;
        if (identity.suppressBakedWeapon) return true;
        const modelClass = String(identity.modelClass || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(CODEX_EQUIPMENT_BY_CLASS, modelClass);
    }

    _clearBakedCodexSidearmPixels(ctx, width, height, modelClass = 'codex') {
        const cellSize = Math.round(width / DIRECTIONS.length) || 92;
        const rows = Math.floor(height / cellSize);
        if (!Number.isFinite(cellSize) || cellSize <= 0 || rows <= 0) return;

        if (this._normalizedBakedWeaponClass(modelClass) === 'gpt54') {
            clearDetachedCodexWrench(ctx, width, height);
            return;
        }

        const image = ctx.getImageData(0, 0, width, height);
        const data = image.data;
        const marks = new Uint8Array(width * height);
        const selectors = this._bakedWeaponSelectorsForClass(modelClass);
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < DIRECTIONS.length; col++) {
                const zones = this._bakedWeaponMaskZonesForClass(modelClass, DIRECTIONS[col], cellSize);
                for (const zone of zones) {
                    this._markBakedWeaponPixels(data, marks, width, col * cellSize, row * cellSize, zone, selectors);
                }
            }
        }

        const expanded = new Uint8Array(marks.length);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                if (!marks[idx]) continue;
                for (let oy = -1; oy <= 1; oy++) {
                    for (let ox = -1; ox <= 1; ox++) expanded[(y + oy) * width + x + ox] = 1;
                }
            }
        }
        for (let i = 0; i < expanded.length; i++) {
            if (!expanded[i]) continue;
            data[i * 4 + 3] = 0;
        }
        ctx.putImageData(image, 0, 0);
    }

    _bakedWeaponSelectorsForClass(modelClass) {
        const normalizedClass = this._normalizedBakedWeaponClass(modelClass);
        return {
            brightBlade: (r, g, b) => r > 168 && g > 168 && b > 152,
            cyanBlade: normalizedClass === 'spark'
                ? (r, g, b) => g > 180 && b > 150 && Math.abs(g - b) < 56 && r < 170
                : (r, g, b) => g > 150 && b > 150 && Math.abs(g - b) < 56 && r < 170,
            greyMetal: (r, g, b) => r > 78 && g > 78 && b > 78 && Math.max(r, g, b) - Math.min(r, g, b) < 42,
            goldHilt: normalizedClass === 'gpt54'
                ? (r, g, b) => r > 150 && g > 95 && g < 170 && b < 95
                : normalizedClass === 'spark'
                    ? (r, g, b) => r > 165 && g > 95 && g < 190 && b < 95
                    : (r, g, b) => r > 150 && g > 95 && g < 190 && b < 95,
        };
    }

    _bakedWeaponMaskZonesForClass(modelClass, directionKey, cellSize) {
        const z = (x1, y1, x2, y2) => ({
            x1: Math.round(x1 * cellSize),
            y1: Math.round(y1 * cellSize),
            x2: Math.round(x2 * cellSize),
            y2: Math.round(y2 * cellSize),
        });
        const zones = {
            s: [z(0.08, 0.46, 0.40, 0.98), z(0.62, 0.46, 0.92, 0.98)],
            se: [z(0.42, 0.43, 0.96, 0.96)],
            e: [z(0.46, 0.40, 0.98, 0.90)],
            ne: [z(0.46, 0.36, 0.98, 0.88)],
            n: [z(0.08, 0.46, 0.38, 0.96), z(0.62, 0.46, 0.92, 0.96)],
            nw: [z(0.02, 0.36, 0.54, 0.88)],
            w: [z(0.02, 0.40, 0.54, 0.90)],
            sw: [z(0.04, 0.43, 0.58, 0.96)],
        };
        const normalizedClass = this._normalizedBakedWeaponClass(modelClass);
        if (normalizedClass === 'spark') {
            return {
                ...zones,
                s: [z(0.09, 0.50, 0.34, 0.96), z(0.66, 0.50, 0.88, 0.96)],
                se: [z(0.48, 0.46, 0.94, 0.94)],
            }[directionKey] || [];
        }
        if (normalizedClass === 'gpt54') {
            return {
                ...zones,
                nw: [z(0.00, 0.35, 0.58, 0.90)],
                w: [z(0.00, 0.39, 0.58, 0.92)],
            }[directionKey] || [];
        }
        return zones[directionKey] || [];
    }

    _normalizedBakedWeaponClass(modelClass) {
        const normalizedClass = String(modelClass || '').toLowerCase();
        return normalizedClass === 'codex' ? 'gpt54' : normalizedClass;
    }

    _markBakedWeaponPixels(data, marks, width, originX, originY, zone, selectors) {
        const x1 = Math.max(0, originX + zone.x1);
        const y1 = Math.max(0, originY + zone.y1);
        const x2 = Math.min(width - 1, originX + zone.x2);
        const y2 = Math.min(Math.floor(data.length / 4 / width) - 1, originY + zone.y2);
        for (let y = y1; y <= y2; y++) {
            for (let x = x1; x <= x2; x++) {
                const p = (y * width + x) * 4;
                const a = data[p + 3];
                if (a < 16) continue;
                const r = data[p];
                const g = data[p + 1];
                const b = data[p + 2];
                if (
                    selectors.brightBlade(r, g, b) ||
                    selectors.cyanBlade(r, g, b) ||
                    selectors.greyMetal(r, g, b) ||
                    selectors.goldHilt(r, g, b)
                ) {
                    marks[y * width + x] = 1;
                }
            }
        }
    }

    // Context-window pressure: mirrors contextRatio() in LandmarkActivity.js /
    // VisitIntentManager.js. Returns the matching CONTEXT_PRESSURE_LEVELS entry
    // or null when fullness is unknown or below the lowest threshold.
    _contextPressureLevel() {
        const tokens = this.agent?.tokens || {};
        const current = Number(tokens.contextWindow ?? 0) || 0;
        const max = Number(tokens.contextWindowMax ?? 0) || 0;
        if (current <= 0 || max <= 0) return null;
        const ratio = Math.max(0, Math.min(1, current / max));
        for (const level of CONTEXT_PRESSURE_LEVELS) {
            if (ratio >= level.threshold) return { ...level, ratio };
        }
        return null;
    }

    // #36 — strain body language: once context pressure crosses 0.85 the body
    // gains a tiny ±1px horizontal shiver, deepening slightly toward 1.0. Driven
    // by `statusAnim` so it freezes (returns 0) under reduced motion (motionScale
    // 0), where the held posture and the panel's context gauge carry the cue.
    _contextStrainTremble() {
        if (this.motionScale <= 0) return 0;
        const level = this._contextPressureLevel();
        if (!level || level.ratio < 0.85) return 0;
        const intensity = this._clamp((level.ratio - 0.85) / 0.15, 0.3, 1);
        return Math.round(Math.sin(this.statusAnim * 9) * intensity);
    }

    // #36 — sweat-drop emission at context-pressure ratio >= 0.85: a single cool
    // bead beads off the brow on a slow stagger, faster as fullness rises. Runs in
    // update() (pool live). Reduced motion (motionScale 0) emits nothing — the
    // held posture is the strain cue then.
    _advanceContextStrainSweat(particleSystem) {
        if (!particleSystem || this.motionScale <= 0) return;
        if (this.moving || this.chatting) return;
        const level = this._contextPressureLevel();
        if (!level || level.ratio < 0.85) return;
        // Cadence shortens as pressure rises (~1800 ms at 0.85 → ~900 ms near 1.0);
        // stagger per agent so a strained crowd does not bead in unison.
        const intensity = this._clamp((level.ratio - 0.85) / 0.15, 0, 1);
        const period = Math.round(1800 - intensity * 900);
        const offset = Math.abs(this._hash(`${this.agent?.id || ''}:strain-sweat`)) % period;
        const beat = Math.floor((Date.now() + offset) / period);
        if (beat === this._strainSweatBeat) return;
        this._strainSweatBeat = beat;
        // Bead off the temple (slightly off-centre, just under the head top).
        particleSystem.spawn('sweatDrop', this.x + 4, this._headTopY() + 8, 1, {
            spread: 1.5,
            sortY: this._depthSortY ?? this.y,
        });
    }

    // Plan 2.1 — records the body laid out this frame, relative to the feet
    // anchor, so hit-testing and head-anchored marks follow the real 1:1 body.
    _setBodyBox(anchorX, anchorY, left, top, right, bottom) {
        const box = this._bodyBox || (this._bodyBox = { left: 0, right: 0, top: 0, bottom: 0 });
        box.left = left - anchorX;
        box.right = right - anchorX;
        box.top = top - anchorY;
        box.bottom = bottom - anchorY;
    }

    // Top of the head in world texels (bridge lift included), from the last
    // laid-out body; the median 1:1 body before the first draw.
    _headTopY() {
        return this._visualAnchorY() + (this._bodyBox || DEFAULT_BODY_BOX).top;
    }

    // Contact-shadow width follows the body's idle silhouette for its current
    // facing, so the shadow does not shimmer with swinging arms mid-stride.
    _stableContentWidth() {
        if (!this.spriteSheet) return DEFAULT_BODY_BOX.right - DEFAULT_BODY_BOX.left;
        const bounds = this._getCellContentBounds(this.spriteSheet.cell('idle', this.direction, 0));
        return bounds.maxX - bounds.minX + 1;
    }

    // Plan 2.3 — the ground mark set both backends paint: one contact shadow,
    // a status ring only for waiting-on-you / errored / rate-limited, and the
    // selection or hover ring. Working and idle villagers get the shadow alone.
    // V7 — laid out at the body's own placement, so they never part from it.
    _layoutGroundMarks(contentWidth) {
        this._groundMarks = resolveGroundMarks({
            x: this._placeX,
            y: this._placeY,
            contentWidth,
            status: departedTableau(this) ? null : this.agent?.status,
            selected: this.selected,
            hovered: this.hovered,
            accent: this._providerAccentColor(),
            trim: this._providerTrimColor(),
        });
        return this._groundMarks;
    }

    // Plan 2.5 — the selected agent's chevron over the head. It lifts one
    // texel on the `selection` pulse band (the claimant the old ring used) and
    // holds still under reduced motion.
    _drawSelectionChevron(ctx, contentTopY) {
        const lift = pulseBand01Frame('selection', this.statusAnim * 20, this.motionScale) > 0.5 ? 1 : 0;
        drawSelectionChevron(ctx, this._placeX, contentTopY, this._zoom || 1, this.motionScale > 0 ? lift : 0);
    }

    // Top edge for head-anchored labels (bubbles, emotes, glyphs). The
    // selected agent's labels clear its chevron so nothing crosses the body.
    _labelTopY(contentTopY) {
        return this.selected ? contentTopY - selectionChevronClearance(this._zoom || 1) - 1 : contentTopY;
    }

    // X-ray pass: re-blits the body cell exactly as this frame laid it out
    // (same pose, same V7 placement) with alpha, so a selected agent stays
    // visible behind a building's front-half. Avoids the full-sprite-sheet
    // blit that drawing via SpriteRenderer.drawSilhouette would produce
    // against multi-direction agent sheets.
    drawXraySilhouette(ctx) {
        return this.withBridgeLift(() => this._drawXraySilhouetteAtScreenPosition(ctx));
    }

    _drawXraySilhouetteAtScreenPosition(ctx) {
        const body = this._poseCell;
        if (!this.spriteCanvas || !body?.canvas) return;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 0.65;
        ctx.drawImage(
            body.canvas,
            body.sx, body.sy, body.sw, body.sh,
            body.dx, body.dy, body.sw, body.sh
        );
        ctx.restore();
    }

    setGpuWorldEnabled(enabled) {
        // Force an equipped-sheet rebuild when GPU mode actually flips: the
        // composed sheet key survives a disable/enable cycle, but
        // _gpuBaseSpriteCanvas may have been reset to the untouched base sheet
        // in the meantime. This setter runs every frame, so an unconditional
        // reset would recompose the 80-cell sheet each frame.
        if (Boolean(enabled) !== this.gpuWorldEnabled) this._gpuEquippedSheetKey = '';
        this.gpuOverlayRenderer.setEnabled(enabled);
    }

    getGpuWorldRecords() {
        return this.gpuOverlayRenderer.getRecords();
    }

    // Plan 2.3 — ground marks (contact shadow + meaningful rings) for the
    // resident depth pass; painted just before this body's record.
    getGpuGroundRecords(sequence = 0) {
        return this.gpuOverlayRenderer.getGroundRecords(sequence);
    }

    drawGpuWorldOverlay(ctx, zoom = 1, annotationMode = 'full') {
        // Compatibility entry point: callers may invoke it on duck-typed hosts
        // that only own a gpuOverlayRenderer, so the lift wrapper is optional.
        const draw = () => this.gpuOverlayRenderer.draw(ctx, zoom, annotationMode);
        return typeof this.withBridgeLift === 'function' ? this.withBridgeLift(draw) : draw();
    }

    _setGpuFrameRecord(record) {
        this.gpuOverlayRenderer.setFrameRecord(record);
        const frame = this._gpuFrameRecord;
        if (frame?.materialSource || frame?.emissiveSource || frame?.occluderSource) {
            GPU_AGENT_CHANNEL_ATLAS_RECORDS.set(this._resourceOwnerKey, {
                sw: frame.sw,
                sh: frame.sh,
                material: Boolean(frame.materialSource),
                emissive: Boolean(frame.emissiveSource),
                occluder: Boolean(frame.occluderSource),
            });
        } else {
            GPU_AGENT_CHANNEL_ATLAS_RECORDS.delete(this._resourceOwnerKey);
        }
    }

    // GPU-world bodies are sampled from a packed sheet texture, so the runtime
    // codex equipment (composited per-frame around the Canvas body blit) must
    // be baked into every cell of that sheet or WebGL villagers render
    // empty-handed. Geometry is derived purely from cell bounds + direction,
    // so baking at drawScale 1 reproduces the Canvas result exactly; the GPU
    // then scales the whole cell. Each cell gets GPU_EQUIP_SHEET_PAD px of
    // padding on every side — an upright blade tip extends well past the 92px
    // body cell (dawnblade: ~46px above the shoulder anchor) and clipping it
    // at the cell edge truncates the weapon on screen. Cells are still clipped
    // to their own padded rect so a tip can never bleed into a neighbour.
    _composeGpuEquippedSheet(identity) {
        const sheet = this.spriteCanvas;
        if (!sheet?.width || !sheet?.height) return null;
        const cellSize = this.spriteSheet?.cellSize || 92;
        const pad = GPU_EQUIP_SHEET_PAD;
        const padded = cellSize + pad * 2;
        const cols = Math.floor(sheet.width / cellSize);
        const rows = Math.floor(sheet.height / cellSize);
        const canvas = document.createElement('canvas');
        canvas.width = cols * padded;
        canvas.height = rows * padded;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = false;
        for (let col = 0; col < cols; col++) {
            const directionKey = DIRECTIONS[col] || 's';
            for (let row = 0; row < rows; row++) {
                const cell = { sx: col * cellSize, sy: row * cellSize, sw: cellSize, sh: cellSize };
                const bounds = this._getCellContentBounds(cell);
                if (!bounds) continue;
                const frameGeometry = { cell, dx: 0, dy: 0, bounds, drawScale: 1, cacheEquipment: false };
                ctx.save();
                ctx.beginPath();
                ctx.rect(col * padded, row * padded, padded, padded);
                ctx.clip();
                ctx.translate(col * padded + pad, row * padded + pad);
                this._drawCodexEquipment(ctx, identity, frameGeometry, 'back', directionKey);
                ctx.drawImage(sheet, cell.sx, cell.sy, cellSize, cellSize, 0, 0, cellSize, cellSize);
                this._drawCodexEquipment(ctx, identity, frameGeometry, 'front', directionKey);
                ctx.restore();
            }
        }
        return canvas;
    }

    // Re-lays an unpadded sheet-layout sidecar (material/emissive companion)
    // into the padded cell grid so its UVs stay aligned with the equipped
    // albedo sheet. Weapon pixels carry no channel data and fall back to the
    // default material, matching the Canvas renderer.
    _padSidecarSheet(source, cellSize, pad, cols, rows) {
        if (!source?.width || !source?.height) return null;
        const padded = cellSize + pad * 2;
        const canvas = document.createElement('canvas');
        canvas.width = cols * padded;
        canvas.height = rows * padded;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = false;
        for (let col = 0; col < cols; col++) {
            for (let row = 0; row < rows; row++) {
                ctx.drawImage(
                    source,
                    col * cellSize, row * cellSize, cellSize, cellSize,
                    col * padded + pad, row * padded + pad, cellSize, cellSize,
                );
            }
        }
        return canvas;
    }

    // Keeps _gpuBaseSpriteCanvas in sync with the current profile and asset
    // version. Asset version participates so a weapon sprite arriving after a
    // fallback-vector compose triggers a rebuild (and, via the key doubling as
    // the record's textureRevision, a texture re-upload). Composed sheets are
    // shared across sprites via a module-level cache — a padded sheet is
    // ~6 MB, and audit swarms routinely field 20+ villagers of one profile.
    _syncGpuEquippedSheet(identity, profileKey) {
        if (!this.gpuWorldEnabled) return;
        const equipment = this._normalizedCodexEquipment(this._runtimeCodexEquipment(identity));
        const key = `${profileKey}|${equipment || '_'}|${this.assets?.assetVersion || 0}`;
        if (this._gpuEquippedSheetKey === key) return;
        this._gpuEquippedSheetKey = key;
        this._gpuEquippedSheetLayout = null;
        this._gpuEquippedMaterialSheet = null;
        this._gpuEquippedEmissiveSheet = null;
        this._gpuEquippedOccluderSheet = null;
        if (!equipment) return;
        let entry = GPU_EQUIPPED_SHEET_CACHE.get(key);
        if (entry) {
            // LRU refresh.
            GPU_EQUIPPED_SHEET_CACHE.delete(key);
            GPU_EQUIPPED_SHEET_CACHE.set(key, entry);
        } else {
            const composed = this._composeGpuEquippedSheet(identity);
            if (!composed) return;
            const cellSize = this.spriteSheet?.cellSize || 92;
            const cols = Math.floor(this.spriteCanvas.width / cellSize);
            const rows = Math.floor(this.spriteCanvas.height / cellSize);
            const spriteId = identity?.spriteId || '';
            const material = this.assets?.getSidecar?.(spriteId, 'material')
                || this.assets?.getMaterialSidecar?.(spriteId, 'material') || null;
            const emissive = this.assets?.getSidecar?.(spriteId, 'emissive')
                || this.assets?.getMaterialSidecar?.(spriteId, 'emissive') || null;
            const occluder = this.assets?.getSidecar?.(spriteId, 'occluder') || null;
            entry = {
                albedo: composed,
                occluder: occluder ? this._padSidecarSheet(occluder, cellSize, GPU_EQUIP_SHEET_PAD, cols, rows) : null,
                material: material ? this._padSidecarSheet(material, cellSize, GPU_EQUIP_SHEET_PAD, cols, rows) : null,
                emissive: emissive ? this._padSidecarSheet(emissive, cellSize, GPU_EQUIP_SHEET_PAD, cols, rows) : null,
                layout: { pad: GPU_EQUIP_SHEET_PAD, cellSize },
                profileKey,
            };
            GPU_EQUIPPED_SHEET_CACHE.set(key, entry);
            gpuEquippedSheetCachePixels += gpuEquippedSheetEntryPixels(entry);
            while (
                GPU_EQUIPPED_SHEET_CACHE.size > GPU_EQUIPPED_SHEET_CACHE_ENTRY_LIMIT
                || gpuEquippedSheetCachePixels > GPU_EQUIPPED_SHEET_CACHE_PIXEL_LIMIT
            ) {
                const oldestKey = oldestUnpinnedCacheKey(GPU_EQUIPPED_SHEET_CACHE);
                if (oldestKey == null) break;
                const oldest = GPU_EQUIPPED_SHEET_CACHE.get(oldestKey);
                GPU_EQUIPPED_SHEET_CACHE.delete(oldestKey);
                gpuEquippedSheetCachePixels -= gpuEquippedSheetEntryPixels(oldest);
                releaseSharedEntry(oldest);
            }
            gpuEquippedSheetCachePixels = Math.max(0, gpuEquippedSheetCachePixels);
        }
        this._gpuBaseSpriteCanvas = entry.albedo;
        this._gpuEquippedSheetLayout = entry.layout;
        this._gpuEquippedMaterialSheet = entry.material;
        this._gpuEquippedEmissiveSheet = entry.emissive;
        this._gpuEquippedOccluderSheet = entry.occluder;
    }

    _drawFrozenTint(ctx, cell, dx, dy, source = null) {
        const tinted = this._getFrozenTintCell(cell, source);
        if (!tinted) return;
        ctx.save();
        ctx.globalAlpha *= 0.38;
        ctx.drawImage(tinted, dx, dy, cell.sw, cell.sh);
        ctx.restore();
    }

    _getFrozenTintCell(cell, source = null) {
        const sheet = source || this.spriteCanvas;
        if (!sheet) return null;
        const key = `${source ? 'strip' : 'base'}:${cell.sx},${cell.sy},${cell.sw},${cell.sh}`;
        const cached = this._frozenTintCellCache.get(key);
        if (cached) return cached;

        const canvas = document.createElement('canvas');
        canvas.width = cell.sw;
        canvas.height = cell.sh;
        const tintCtx = canvas.getContext('2d');
        tintCtx.imageSmoothingEnabled = false;
        tintCtx.drawImage(sheet, cell.sx, cell.sy, cell.sw, cell.sh, 0, 0, cell.sw, cell.sh);
        tintCtx.globalCompositeOperation = 'source-in';
        tintCtx.fillStyle = '#2e4258';   // cold slate; drawn at low alpha over the body
        tintCtx.fillRect(0, 0, canvas.width, canvas.height);
        this._frozenTintCellCache.set(key, canvas);
        this._updatePrivateDerivedEstimate();
        return canvas;
    }

    _getCellContentBounds(cell) {
        const key = `${cell.sx},${cell.sy},${cell.sw},${cell.sh}`;
        const cached = this._cellBoundsCache.get(key);
        if (cached) return cached;
        const bounds = measureCellContentBounds(this.spriteCanvas, cell);
        this._cellBoundsCache.set(key, bounds);
        return bounds;
    }

    // V7 — the foot anchor of one facing: `cx2` (minX + maxX) of idle row 6
    // and `maxY`, the lowest opaque row over all ten rows of that column. Every
    // cell of the facing is placed by it, so the body shows the sway the
    // artist drew and no more. Cached with the bounds (cleared per profile).
    _stableFootAnchor(direction) {
        const key = FOOT_ANCHOR_KEYS[direction] ?? `anchor:${direction}`;
        const cached = this._cellBoundsCache.get(key);
        if (cached) return cached;
        const sheet = this.spriteSheet;
        const idle = this._getCellContentBounds(sheet.cell('idle', direction, 0));
        let maxY = idle.maxY;
        for (let frame = 0; frame < WALK_FRAMES; frame++) {
            maxY = Math.max(maxY, this._getCellContentBounds(sheet.cell('walk', direction, frame)).maxY);
        }
        for (let frame = 1; frame < IDLE_FRAMES; frame++) {
            maxY = Math.max(maxY, this._getCellContentBounds(sheet.cell('idle', direction, frame)).maxY);
        }
        const anchor = { cx2: idle.minX + idle.maxX, maxY };
        this._cellBoundsCache.set(key, anchor);
        return anchor;
    }

    _statusVisual() {
        return this._statusVisualFor(this.agent);
    }

    _statusVisualFor(agent = this.agent) {
        // Sprite-level chatting flag overrides domain status because chat lifecycle
        // is driven by IsometricRenderer, not the adapter feed.
        if (agent === this.agent && this.chatting) return STATUS_VISUALS.chatting;
        const rawStatus = agent?.status;
        const status = typeof rawStatus === 'string' ? rawStatus : (rawStatus?.value || AgentStatus.IDLE);
        return STATUS_VISUALS[status] || STATUS_VISUALS[AgentStatus.IDLE];
    }

    _drawCodexEquipment(ctx, identity, frameGeometry, layer = 'front', directionOverride = null) {
        const equipment = this._normalizedCodexEquipment(this._runtimeCodexEquipment(identity));
        if (!equipment) return;

        const directionKey = directionOverride || DIRECTIONS[this.direction] || 's';
        const geometry = this._codexWeaponGeometry(frameGeometry, directionKey);
        if (this.assets?.has?.(identity?.spriteId)) {
            geometry.authoredGrip = codexWeaponPose(identity.spriteId, frameGeometry, directionKey, equipment);
        }
        const useCache = frameGeometry.cacheEquipment !== false;
        const heavyGearBaked = identity?.codexHeavyGearBaked && this.assets?.has?.(identity.spriteId);
        const heavyArmor = !heavyGearBaked && (equipment === 'greatsword' || equipment === 'polearm');
        const warlord = equipment === 'polearm';
        const assetDef = CODEX_WEAPON_ASSETS[equipment] || null;
        const assetDrawsBehindBody = geometry.authoredGrip
            ? geometry.authoredGrip.backLayer
            : assetDef && this._assetWeaponBackLayer(assetDef, directionKey);

        if (equipment === 'multitool' && geometry.authoredGrip) {
            if (layer === (assetDrawsBehindBody ? 'back' : 'front')) {
                this._drawWeaponAt(ctx, geometry.authoredGrip, geometry.drawScale, () => this._drawCodexMultitool(ctx));
            }
            if (layer === (geometry.authoredGrip.behindBody ? 'back' : 'front')) {
                drawCodexGauntlet(ctx, geometry.authoredGrip, geometry.drawScale);
            }
            return;
        }

        if (layer === 'back') {
            if (heavyArmor) {
                this._drawGearAt(ctx, geometry.torso, geometry.drawScale, () => {
                    this._drawCodexCape(ctx, warlord, directionKey);
                });
            }

            if (assetDef && assetDrawsBehindBody) {
                this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'asset', useCache);
                if (geometry.authoredGrip?.behindBody) {
                    this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'hands', useCache);
                }
            } else if (!geometry.authoredGrip && equipment === 'engineerWrench' && this._weaponBackCarryDirection(directionKey)) {
                this._drawWeaponAt(ctx, geometry.backCarry, geometry.drawScale, () => this._drawCodexBackWrench(ctx));
            }
            return;
        }

        if (layer !== 'front') return;

        if (heavyArmor) {
            this._drawGearAt(ctx, geometry.torso, geometry.drawScale, () => this._drawCodexHeavyArmor(ctx, warlord, directionKey));
            this._drawGearAt(ctx, geometry.head, geometry.drawScale, () => this._drawCodexHeavyHelmet(ctx, warlord, directionKey));
        }

        if (assetDef) {
            if (!assetDrawsBehindBody) this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'asset', useCache);
            if (!geometry.authoredGrip?.behindBody) this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'hands', useCache);
            return;
        }

        if (equipment === 'multitool') {
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexMultitool(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (equipment === 'runeblade') {
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexRuneblade(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (equipment === 'swordShield') {
            this._drawWeaponAt(ctx, geometry.shield, geometry.drawScale, () => this._drawCodexShield(ctx, geometry.shieldSlim));
            this._drawWeaponAt(ctx, geometry.rightHand, geometry.drawScale, () => {
                this._drawCodexRuneblade(ctx);
                this._drawWeaponGripHand(ctx);
            });
        } else if (equipment === 'greatsword') {
            this._drawWeaponAt(ctx, geometry.twoHanded, geometry.drawScale, () => {
                this._drawCodexGreatsword(ctx);
                this._drawWeaponGripHands(ctx);
            });
        } else if (equipment === 'polearm') {
            this._drawWeaponAt(ctx, geometry.polearm, geometry.drawScale, () => {
                this._drawCodexPolearm(ctx);
                this._drawWeaponGripHands(ctx);
            });
        } else if (equipment === 'engineerWrench') {
            this._drawWeaponAt(ctx, geometry.shoulderRest, geometry.drawScale, () => {
                this._drawCodexShoulderWrench(ctx);
                this._drawWeaponGripHand(ctx);
            });
        }
    }

    _runtimeHeadAccessory(identity, agent = this.agent) {
        // Only effort-tier crests composite at runtime — plan 0.12 removed the
        // unreachable, broken role-hat overlays and their matcher. Permanent —
        // apply immediately (D2).
        if (identity?.allowRuntimeEffortAccessory !== false && identity?.effortAccessory) {
            return this._commitAccessoryImmediate(identity.effortAccessory);
        }
        return this._commitAccessoryImmediate(null);
    }

    _commitAccessoryImmediate(id) {
        this._committedAccessory = id;
        this._accessoryCandidate = id;
        this._accessoryCandidateSince = Date.now();
        return id;
    }

    _runtimeCodexEquipment(identity) {
        if (identity?.allowRuntimeEffortWeapon === false) return null;
        const explicitEquipment = identity?.equipment ?? identity?.codexEquipment ?? null;
        if (explicitEquipment) return explicitEquipment;
        const modelClass = String(identity?.modelClass || '').toLowerCase();
        const classEquipment = CODEX_EQUIPMENT_BY_CLASS[modelClass];
        if (classEquipment) return classEquipment;
        return identity?.effortWeapon ?? null;
    }

    _normalizedCodexEquipment(equipment) {
        const normalized = String(equipment || '').trim();
        if (!normalized) return null;
        if (normalized === 'sword') return 'runeblade';
        if (normalized === 'wrench') return 'engineerWrench';
        if (normalized === 'warlord') return 'polearm';
        return normalized;
    }

    _drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, part = 'asset', useCache = true) {
        const poseName = this._weaponPoseName(assetDef, directionKey);
        const pose = geometry.authoredGrip || geometry[poseName] || geometry.rightHand;
        if (!pose) return;

        if (part === 'asset') {
            const rasterScale = useCache ? this._stableCodexEquipmentRasterScale(ctx) : null;
            const cached = rasterScale
                ? this._cachedCodexEquipmentAsset(assetDef, pose, geometry.drawScale, rasterScale)
                : null;
            if (cached) {
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(
                    cached.canvas,
                    0,
                    0,
                    cached.canvas.width,
                    cached.canvas.height,
                    Math.round(pose.x) + cached.offsetX / rasterScale,
                    Math.round(pose.y) + cached.offsetY / rasterScale,
                    cached.canvas.width / rasterScale,
                    cached.canvas.height / rasterScale,
                );
                return;
            }
            this._drawWeaponAt(ctx, {
                ...pose,
                scale: (pose.scale || 1) * (assetDef.scale || 1),
            }, geometry.drawScale, () => this._drawCodexWeaponAssetImage(ctx, assetDef));
            return;
        }

        if (geometry.authoredGrip) {
            drawCodexGauntlet(ctx, pose, geometry.drawScale);
            return;
        }
        this._drawWeaponAt(ctx, pose, geometry.drawScale, () => {
            if (assetDef.hands === 'double') this._drawWeaponGripHands(ctx, assetDef.handSpacing || 11, assetDef.handVector);
            else this._drawWeaponGripHand(ctx);
        });
    }

    _stableCodexEquipmentRasterScale(ctx) {
        const transform = ctx.getTransform?.();
        const scale = Math.abs(transform?.a || 0);
        if (!scale || transform.b !== 0 || transform.c !== 0 || Math.abs(Math.abs(transform.d) - scale) > 1e-9) {
            return null;
        }
        const now = performance.now();
        if (scale !== codexEquipmentRasterScale) {
            codexEquipmentRasterScale = scale;
            codexEquipmentRasterScaleSince = now;
            return null;
        }
        return now - codexEquipmentRasterScaleSince >= CODEX_EQUIPMENT_SCALE_STABLE_MS ? scale : null;
    }

    _cachedCodexEquipmentAsset(assetDef, pose, drawScale, rasterScale) {
        const poseScale = pose.scale || 1;
        const scale = drawScale * poseScale * (assetDef.scale || 1) * rasterScale;
        const angle = pose.angle || 0;
        const flipX = Boolean(pose.flipX);
        const cacheKey = [
            this.assets?.assetVersion || '_',
            assetDef.id,
            this.assets?.has?.(assetDef.id) ? 'asset' : `fallback:${assetDef.fallback || '_'}`,
            flipX ? 1 : 0,
            rasterScale,
            scale,
            angle,
        ].join('|');
        const existing = CODEX_EQUIPMENT_CACHE.get(cacheKey);
        if (existing) return existing;

        const dims = this.assets?.getDims?.(assetDef.id) || { w: 112, h: 112 };
        const [anchorX, anchorY] = this._codexWeaponAssetAnchor(assetDef);
        const sourceBounds = {
            minX: -anchorX,
            minY: -anchorY,
            maxX: dims.w - anchorX,
            maxY: dims.h - anchorY,
        };
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const points = [
            [sourceBounds.minX, sourceBounds.minY],
            [sourceBounds.maxX, sourceBounds.minY],
            [sourceBounds.maxX, sourceBounds.maxY],
            [sourceBounds.minX, sourceBounds.maxY],
        ].map(([x, y]) => {
            const rotatedX = (cos * x - sin * y) * scale;
            return [flipX ? -rotatedX : rotatedX, (sin * x + cos * y) * scale];
        });
        const margin = 2;
        const minX = Math.floor(Math.min(...points.map(point => point[0]))) - margin;
        const minY = Math.floor(Math.min(...points.map(point => point[1]))) - margin;
        const maxX = Math.ceil(Math.max(...points.map(point => point[0]))) + margin;
        const maxY = Math.ceil(Math.max(...points.map(point => point[1]))) + margin;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, maxX - minX);
        canvas.height = Math.max(1, maxY - minY);
        const cacheCtx = canvas.getContext('2d');
        cacheCtx.imageSmoothingEnabled = false;
        cacheCtx.translate(-minX, -minY);
        cacheCtx.scale(flipX ? -1 : 1, 1);
        cacheCtx.scale(scale, scale);
        cacheCtx.rotate(angle);
        this._drawCodexWeaponAssetImage(cacheCtx, assetDef);

        const cached = { canvas, offsetX: minX, offsetY: minY, profileKey: this._spriteProfileKey };
        CODEX_EQUIPMENT_CACHE.set(cacheKey, cached);
        codexEquipmentCachePixels += canvas.width * canvas.height;
        while (
            CODEX_EQUIPMENT_CACHE.size > CODEX_EQUIPMENT_CACHE_ENTRY_LIMIT
            || codexEquipmentCachePixels > CODEX_EQUIPMENT_CACHE_PIXEL_LIMIT
        ) {
            const oldestKey = oldestUnpinnedCacheKey(CODEX_EQUIPMENT_CACHE);
            if (oldestKey == null) break;
            const oldest = CODEX_EQUIPMENT_CACHE.get(oldestKey);
            CODEX_EQUIPMENT_CACHE.delete(oldestKey);
            codexEquipmentCachePixels -= (oldest?.canvas?.width || 0) * (oldest?.canvas?.height || 0);
            releaseSharedEntry(oldest);
        }
        codexEquipmentCachePixels = Math.max(0, codexEquipmentCachePixels);
        return CODEX_EQUIPMENT_CACHE.get(cacheKey) || null;
    }

    _drawCodexWeaponAssetImage(ctx, assetDef) {
        const img = this.assets?.has?.(assetDef.id) ? this.assets.get(assetDef.id) : null;
        if (img) {
            const dims = this.assets.getDims(assetDef.id) || { w: img.width, h: img.height };
            const [ax, ay] = this._codexWeaponAssetAnchor(assetDef);
            ctx.drawImage(img, Math.round(-ax), Math.round(-ay), dims.w, dims.h);
            return;
        }
        this._drawCodexWeaponFallback(ctx, assetDef.fallback);
    }

    _codexWeaponAssetAnchor(assetDef) {
        const entryAnchor = this.assets?.getEntry?.(assetDef.id)?.anchor;
        if (Array.isArray(entryAnchor) && entryAnchor.length >= 2) return entryAnchor;
        return assetDef.anchor || [0, 0];
    }

    _drawCodexWeaponFallback(ctx, fallback) {
        if (fallback === 'runeblade') this._drawCodexRuneblade(ctx);
        else if (fallback === 'greatsword') this._drawCodexGreatsword(ctx);
        else if (fallback === 'polearm') this._drawCodexPolearm(ctx);
        else if (fallback === 'wrench') this._drawCodexShoulderWrench(ctx);
    }

    _weaponPoseName(assetDef, directionKey) {
        if (assetDef.backPose && this._weaponBackCarryDirection(directionKey)) return assetDef.backPose;
        return assetDef.pose || 'rightHand';
    }

    _assetWeaponBackLayer(assetDef, directionKey) {
        if (assetDef.backLayer === 'always') return true;
        if (Array.isArray(assetDef.backLayerDirections)) return assetDef.backLayerDirections.includes(directionKey);
        if (assetDef.backPose) return this._weaponBackCarryDirection(directionKey);
        return directionKey === 'n' || directionKey === 'ne' || directionKey === 'nw';
    }

    _codexWeaponGeometry({ dx, dy, bounds, drawScale = 1 }, directionKey) {
        const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
        const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
        const centerX = dx + (bounds.minX + bounds.maxX) * drawScale / 2;
        const headY = dy + (bounds.minY + contentHeight * 0.19) * drawScale;
        const shoulderY = dy + (bounds.minY + contentHeight * 0.36) * drawScale;
        const torsoY = dy + (bounds.minY + contentHeight * 0.56) * drawScale;
        const bodyWidth = Math.max(22, Math.min(42, contentWidth));
        const sideSign = ['sw', 'w', 'nw', 'n'].includes(directionKey) ? -1 : 1;
        const handYOffset = {
            s: 4, se: 1, e: -2, ne: -7,
            n: -8, nw: -7, w: -2, sw: 1,
        }[directionKey] ?? 0;
        const rightHand = {
            x: centerX + sideSign * bodyWidth * 0.32 * drawScale,
            y: torsoY + handYOffset * drawScale,
            flipX: sideSign < 0,
            angle: this._heldWeaponLeanForDirection(directionKey),
            scale: 0.96,
        };
        const twoHanded = {
            x: centerX + sideSign * bodyWidth * 0.13 * drawScale,
            y: torsoY + (handYOffset - 2) * drawScale,
            flipX: sideSign < 0,
            angle: this._greatswordLeanForDirection(directionKey),
            scale: 1.06,
        };
        const greatswordShoulder = {
            x: centerX + sideSign * bodyWidth * 0.24 * drawScale,
            y: shoulderY + 7 * drawScale,
            flipX: sideSign < 0,
            angle: this._greatswordLeanForDirection(directionKey),
            scale: 1.00,
        };
        const polearmUpright = {
            x: centerX + sideSign * bodyWidth * 0.40 * drawScale,
            y: torsoY + (handYOffset + 4) * drawScale,
            flipX: sideSign < 0,
            angle: this._polearmLeanForDirection(directionKey),
            scale: 1.00,
        };
        const shoulderRest = {
            x: centerX + sideSign * bodyWidth * 0.30 * drawScale,
            y: shoulderY,
            flipX: sideSign < 0,
            angle: this._wrenchShoulderLeanForDirection(directionKey),
            scale: 0.94,
        };
        const shieldYOffset = {
            s: -8, se: -10, e: -11, ne: -14,
            n: -14, nw: -14, w: -11, sw: -10,
        }[directionKey] ?? -8;
        const shieldOutset = (directionKey === 'e' || directionKey === 'w')
            ? 0.56
            : ['ne', 'nw', 'se', 'sw'].includes(directionKey)
                ? 0.58
                : 0.62;
        const shield = {
            x: centerX - sideSign * bodyWidth * shieldOutset * drawScale,
            y: torsoY + shieldYOffset * drawScale,
            flipX: sideSign < 0,
            angle: sideSign * (directionKey === 'e' || directionKey === 'w' ? -0.16 : -0.06),
            scale: directionKey === 'e' || directionKey === 'w' ? 0.80 : 0.88,
        };
        const backCarry = {
            x: centerX + sideSign * bodyWidth * 0.10 * drawScale,
            y: shoulderY + 3 * drawScale,
            flipX: sideSign < 0,
            angle: directionKey === 'n' ? -0.06 : 0.04,
            scale: 0.96,
        };
        const torso = {
            x: centerX,
            y: shoulderY + 2 * drawScale,
            flipX: false,
            angle: 0,
            scale: 1,
        };
        const head = {
            x: centerX,
            y: headY,
            flipX: false,
            angle: 0,
            scale: 1,
        };
        return {
            drawScale,
            head,
            torso,
            rightHand,
            twoHanded,
            polearm: polearmUpright,
            greatswordShoulder,
            polearmUpright,
            shoulderRest,
            shield,
            backCarry,
            shieldSlim: ['e', 'w', 'ne', 'nw'].includes(directionKey),
        };
    }

    _drawWeaponAt(ctx, pose, drawScale, drawFn) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(Math.round(pose.x), Math.round(pose.y));
        ctx.scale(pose.flipX ? -1 : 1, 1);
        ctx.scale(drawScale * (pose.scale || 1), drawScale * (pose.scale || 1));
        ctx.rotate(pose.angle || 0);
        drawFn();
        ctx.restore();
    }

    _drawGearAt(ctx, pose, drawScale, drawFn) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(Math.round(pose.x), Math.round(pose.y));
        ctx.scale(pose.flipX ? -1 : 1, 1);
        ctx.scale(drawScale * (pose.scale || 1), drawScale * (pose.scale || 1));
        ctx.rotate(pose.angle || 0);
        drawFn();
        ctx.restore();
    }

    _weaponBackCarryDirection(directionKey) {
        return directionKey === 'n' || directionKey === 'ne' || directionKey === 'nw';
    }

    _heldWeaponLeanForDirection(directionKey) {
        // Kept shallow so a hand-held blade reads as gripped upright; the old
        // -0.34/-0.38 leans tilted long sabers diagonally across the head.
        if (directionKey === 'e' || directionKey === 'w') return -0.14;
        if (directionKey === 'ne' || directionKey === 'nw') return -0.18;
        if (directionKey === 'n') return -0.20;
        if (directionKey === 'se' || directionKey === 'sw') return -0.04;
        return 0.08;
    }

    _wrenchShoulderLeanForDirection(directionKey) {
        if (directionKey === 'e' || directionKey === 'w') return -0.45;
        if (directionKey === 'se' || directionKey === 'sw') return -0.20;
        if (directionKey === 's') return -0.05;
        return -0.30;
    }

    _greatswordLeanForDirection(directionKey) {
        if (directionKey === 'e' || directionKey === 'w') return -0.50;
        if (directionKey === 'ne' || directionKey === 'nw') return -0.54;
        if (directionKey === 'n') return -0.55;
        if (directionKey === 'se' || directionKey === 'sw') return -0.48;
        return -0.46;
    }

    _polearmLeanForDirection(directionKey) {
        if (directionKey === 'ne' || directionKey === 'nw' || directionKey === 'n') return -0.58;
        if (directionKey === 'e' || directionKey === 'w') return -0.56;
        return -0.54;
    }

    _drawCodexMultitool(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 5, [[-6, 5], [6, -3]]);
        this._drawWeaponStroke(ctx, '#7f8f9b', 3, [[-6, 5], [6, -3]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(3, -8, 9, 6);
        ctx.fillStyle = '#dce8ec';
        ctx.fillRect(5, -7, 5, 2);
        ctx.fillRect(9, -6, 3, 4);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(9, -4, 4, 2);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-5, 3, 8, 5);
        ctx.fillStyle = '#b47a35';
        ctx.fillRect(-4, 4, 6, 3);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-1, 4, 2, 2);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-3, 5, 1, 1);
    }

    _drawCodexRuneblade(ctx) {
        this._drawTaperedBlade(ctx, 0, -2, 10, -29, 4.0, 0.7);
        ctx.strokeStyle = '#7be3d7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(2, -7);
        ctx.lineTo(8, -24);
        ctx.stroke();
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(4, -17, 2, 2);
        this._drawWeaponStroke(ctx, '#0b2430', 5, [[-8, 4], [8, 7]]);
        this._drawWeaponStroke(ctx, '#f8c45f', 3, [[-8, 4], [8, 7]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-2, 5, 5, 11);
        ctx.fillStyle = '#b47a35';
        ctx.fillRect(-1, 6, 3, 9);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-4, 15, 8, 3);
    }

    _drawCodexGreatsword(ctx, ornate = false) {
        this._drawTaperedBlade(ctx, 0, 2, 14, ornate ? -54 : -48, ornate ? 6.6 : 5.7, 0.9);
        ctx.strokeStyle = ornate ? '#bff7ee' : '#7be3d7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(2, -4);
        ctx.lineTo(12, ornate ? -43 : -38);
        ctx.stroke();
        if (ornate) {
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(7, -34, 3, 3);
            ctx.fillRect(10, -24, 2, 2);
        }
        this._drawWeaponStroke(ctx, '#0b2430', 6, [[-11, 7], [11, 10]]);
        this._drawWeaponStroke(ctx, '#f8c45f', 4, [[-11, 7], [11, 10]]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-3, 8, 7, 19);
        ctx.fillStyle = '#8a5a2a';
        ctx.fillRect(-2, 9, 5, 17);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-5, 25, 11, 4);
        if (ornate) {
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(-1, 11, 3, 12);
        }
    }

    _drawCodexPolearm(ctx) {
        this._drawWeaponStroke(ctx, '#071015', 5, [[-11, 23], [15, -38]]);
        this._drawWeaponStroke(ctx, '#2f2321', 3, [[-11, 23], [15, -38]]);
        this._drawWeaponStroke(ctx, '#d7a456', 1, [[-7, 15], [12, -31]]);
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, [[9, -42], [23, -52], [17, -31], [10, -25], [13, -37]]);
        ctx.fillStyle = '#dce8ec';
        this._fillWeaponPolygon(ctx, [[12, -40], [21, -48], [16, -33], [12, -28], [14, -37]]);
        ctx.fillStyle = '#55c7f0';
        this._fillWeaponPolygon(ctx, [[13, -38], [18, -43], [15, -35], [13, -32]]);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(8, -31, 10, 4);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(10, -30, 3, 3);
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, [[0, -36], [10, -47], [9, -34], [2, -29]]);
        ctx.fillStyle = '#a6b2b8';
        this._fillWeaponPolygon(ctx, [[2, -35], [8, -42], [8, -35], [3, -31]]);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-16, 24, 9, 4);
    }

    _drawCodexShield(ctx, slim = false, ornate = false) {
        const outline = slim
            ? [[-7, -15], [9, -11], [8, 8], [1, 18], [-7, 9]]
            : [[-13, -17], [12, -12], [10, 9], [0, 19], [-11, 9]];
        const face = slim
            ? [[-5, -13], [7, -9], [6, 7], [1, 15], [-5, 7]]
            : [[-10, -14], [9, -10], [8, 7], [0, 16], [-9, 7]];
        ctx.fillStyle = '#0b2430';
        this._fillWeaponPolygon(ctx, outline);
        ctx.fillStyle = ornate ? '#a6b2b8' : '#7f8f9b';
        this._fillWeaponPolygon(ctx, face);
        ctx.fillStyle = ornate ? '#2e5360' : '#214b5a';
        this._fillWeaponPolygon(ctx, face.map(([x, y]) => [x + (slim ? 1 : 2), y + 2]));
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(slim ? 0 : -1, -7, 3, 12);
        ctx.fillRect(slim ? -3 : -5, -2, slim ? 9 : 12, 3);
        if (ornate) {
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(slim ? 1 : 0, -11, 2, 4);
            ctx.fillRect(slim ? 1 : 0, 7, 2, 3);
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(slim ? -4 : -6, -1, slim ? 11 : 14, 1);
        }
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(slim ? 3 : 5, -5, slim ? 5 : 6, 9);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(slim ? 4 : 6, -4, slim ? 3 : 4, 7);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(slim ? 3 : 5, -1, slim ? 6 : 8, 2);
        ctx.fillStyle = 'rgba(223, 252, 255, 0.75)';
        ctx.fillRect(slim ? -3 : -7, -10, slim ? 3 : 4, 2);
    }

    _drawCodexCape(ctx, majestic = false, directionKey = 's') {
        const sideBias = ['e', 'ne', 'se'].includes(directionKey)
            ? -3
            : ['w', 'nw', 'sw'].includes(directionKey)
                ? 3
                : 0;
        const topHalf = majestic ? 22 : 17;
        const bottomHalf = majestic ? 25 : 19;
        const length = majestic ? 56 : 46;
        const lift = directionKey === 'n' ? -4 : 0;
        const cape = [
            [-topHalf + sideBias, -3 + lift],
            [topHalf + sideBias, -3 + lift],
            [bottomHalf + sideBias + 5, length],
            [0 + sideBias, length + (majestic ? 8 : 4)],
            [-bottomHalf + sideBias - 5, length],
        ];
        ctx.fillStyle = '#0b1118';
        this._fillWeaponPolygon(ctx, cape.map(([x, y]) => [x, y + 2]));
        ctx.fillStyle = majestic ? '#3e183f' : '#26364c';
        this._fillWeaponPolygon(ctx, cape);
        ctx.fillStyle = majestic ? '#64305f' : '#38536b';
        this._fillWeaponPolygon(ctx, [
            [-7 + sideBias, 0 + lift],
            [topHalf - 2 + sideBias, 0 + lift],
            [bottomHalf - 5 + sideBias, length - 2],
            [1 + sideBias, length + (majestic ? 5 : 2)],
        ]);
        ctx.strokeStyle = majestic ? '#f8c45f' : '#7be3d7';
        ctx.lineWidth = majestic ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(-topHalf + sideBias, -1 + lift);
        ctx.lineTo(-bottomHalf + sideBias - 3, length - 1);
        ctx.moveTo(topHalf + sideBias, -1 + lift);
        ctx.lineTo(bottomHalf + sideBias + 3, length - 1);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 241, 184, 0.62)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sideBias, 4 + lift);
        ctx.lineTo(sideBias - 4, length - 6);
        ctx.moveTo(sideBias + 10, 7 + lift);
        ctx.lineTo(sideBias + 7, length - 13);
        ctx.stroke();
    }

    _drawCodexHeavyArmor(ctx, warlord = false, directionKey = 's') {
        const sideView = directionKey === 'e' || directionKey === 'w';
        const torsoW = sideView ? 14 : (warlord ? 22 : 18);
        const armorTop = -4;
        ctx.fillStyle = '#081218';
        ctx.fillRect(-torsoW / 2 - 3, armorTop - 1, torsoW + 6, 32);
        ctx.fillStyle = warlord ? '#233340' : '#263a43';
        this._fillWeaponPolygon(ctx, [
            [-torsoW / 2, armorTop],
            [torsoW / 2, armorTop],
            [torsoW / 2 - 3, 26],
            [0, 32],
            [-torsoW / 2 + 3, 26],
        ]);
        ctx.fillStyle = warlord ? '#526878' : '#415862';
        this._fillWeaponPolygon(ctx, [
            [-torsoW / 2 + 3, 1],
            [torsoW / 2 - 2, 0],
            [torsoW / 2 - 5, 13],
            [0, 18],
            [-torsoW / 2 + 4, 13],
        ]);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-torsoW / 2 - 2, 15, torsoW + 4, 3);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-torsoW / 2 + 1, 16, torsoW - 2, 1);
        ctx.fillRect(-2, 1, 4, 16);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-2, 7, 4, 4);

        const pauldronY = warlord ? -3 : 0;
        const shoulderReach = warlord ? 7 : 5;
        const shoulderDrop = warlord ? 6 : 5;
        const leftPauldron = [
            [-torsoW / 2, pauldronY],
            [-torsoW / 2 - shoulderReach, pauldronY + 2],
            [-torsoW / 2 - shoulderReach + 2, pauldronY + shoulderDrop],
            [-torsoW / 2 - 1, pauldronY + shoulderDrop + 1],
        ];
        const rightPauldron = leftPauldron.map(([x, y]) => [-x, y]);
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, leftPauldron);
        this._fillWeaponPolygon(ctx, rightPauldron);
        ctx.fillStyle = warlord ? '#657682' : '#4d626b';
        this._fillWeaponPolygon(ctx, leftPauldron.map(([x, y], index) => [
            x + 1,
            y + (index === 0 ? 1 : 0),
        ]));
        this._fillWeaponPolygon(ctx, rightPauldron.map(([x, y], index) => [
            x - 1,
            y + (index === 0 ? 1 : 0),
        ]));
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(Math.round(-torsoW / 2 - shoulderReach + 3), pauldronY + 2, shoulderReach - 2, 1);
        ctx.fillRect(Math.round(torsoW / 2 + 1), pauldronY + 2, shoulderReach - 2, 1);
        if (warlord) {
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(-torsoW / 2 - 5, pauldronY + 1, 3, 1);
            ctx.fillRect(torsoW / 2 + 2, pauldronY + 1, 3, 1);
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(-torsoW / 2 - 3, 7, 1, 2);
            ctx.fillRect(torsoW / 2 + 2, 7, 1, 2);
        }
    }

    _drawCodexHeavyHelmet(ctx, warlord = false, directionKey = 's') {
        const visorHidden = directionKey === 'n' || directionKey === 'nw' || directionKey === 'ne';
        ctx.fillStyle = '#071015';
        this._fillWeaponPolygon(ctx, [
            [-12, -7],
            [-9, -14],
            [0, -18],
            [9, -14],
            [12, -7],
            [9, 7],
            [-9, 7],
        ]);
        ctx.fillStyle = warlord ? '#61717b' : '#4b6068';
        this._fillWeaponPolygon(ctx, [
            [-9, -7],
            [-7, -12],
            [0, -15],
            [7, -12],
            [9, -7],
            [7, 5],
            [-7, 5],
        ]);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-8, -7, 16, 2);
        ctx.fillRect(-1, -14, 3, 20);
        if (!visorHidden) {
            ctx.fillStyle = '#091015';
            ctx.fillRect(-6, -4, 12, 4);
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(-5, -3, 10, 1);
        }
        ctx.fillStyle = '#26343c';
        ctx.fillRect(-10, -2, 3, 10);
        ctx.fillRect(7, -2, 3, 10);
        if (warlord) {
            ctx.fillStyle = '#0b1118';
            this._fillWeaponPolygon(ctx, [[-5, -15], [0, -26], [5, -15]]);
            ctx.fillStyle = '#f8c45f';
            this._fillWeaponPolygon(ctx, [[-3, -14], [0, -22], [3, -14]]);
            ctx.fillStyle = '#7be3d7';
            ctx.fillRect(-1, -19, 3, 4);
            ctx.fillStyle = '#fff1b8';
            ctx.fillRect(-12, -10, 4, 2);
            ctx.fillRect(8, -10, 4, 2);
        }
    }

    _drawCodexBackArsenal(ctx, directionKey = 's') {
        const lean = directionKey === 'e' || directionKey === 'ne' || directionKey === 'se' ? 2
            : directionKey === 'w' || directionKey === 'nw' || directionKey === 'sw' ? -2
                : 0;
        this._drawWeaponStroke(ctx, '#081015', 5, [[-22 + lean, 36], [-5 + lean, -18]]);
        this._drawWeaponStroke(ctx, '#7f8f9b', 2, [[-22 + lean, 36], [-5 + lean, -18]]);
        this._drawTaperedBlade(ctx, -5 + lean, -16, -2 + lean, -33, 3.2, 0.6);
        this._drawWeaponStroke(ctx, '#081015', 5, [[23 + lean, 37], [6 + lean, -15]]);
        this._drawWeaponStroke(ctx, '#8a5a2a', 2, [[23 + lean, 37], [6 + lean, -15]]);
        ctx.fillStyle = '#081015';
        ctx.fillRect(2 + lean, -24, 12, 8);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(4 + lean, -22, 8, 4);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(7 + lean, -21, 2, 2);
    }

    _drawCodexShoulderWrench(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 6, [[-5, 16], [9, -13]]);
        this._drawWeaponStroke(ctx, '#8a5a2a', 3, [[-5, 16], [9, -13]]);
        this._drawWeaponStroke(ctx, '#d7a456', 1, [[-3, 10], [8, -11]]);
        this._drawCodexWrenchHead(ctx, 9, -17);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(3, -2, 2, 2);
    }

    _drawCodexBackWrench(ctx) {
        this._drawWeaponStroke(ctx, '#0b2430', 6, [[-10, 23], [13, -20]]);
        this._drawWeaponStroke(ctx, '#8a5a2a', 3, [[-10, 23], [13, -20]]);
        this._drawWeaponStroke(ctx, '#d7a456', 1, [[-7, 16], [12, -18]]);
        this._drawCodexWrenchHead(ctx, 13, -24);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(2, 0, 2, 2);
    }

    _drawCodexWrenchHead(ctx, x, y) {
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(x - 8, y - 4, 17, 10);
        ctx.fillStyle = '#7f8f9b';
        ctx.fillRect(x - 6, y - 2, 13, 6);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(x - 5, y - 1, 9, 3);
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(x + 3, y - 5, 7, 4);
        ctx.fillRect(x + 4, y + 4, 6, 4);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(x - 2, y, 2, 2);
    }

    _drawWeaponGripHand(ctx) {
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-4, -2, 8, 7);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-3, -1, 6, 5);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-1, 0, 3, 3);
    }

    _drawWeaponGripHands(ctx, spacing = 11, vector = null) {
        const secondX = Array.isArray(vector) ? vector[0] : 0;
        const secondY = Array.isArray(vector) ? vector[1] : spacing;
        ctx.fillStyle = '#0b2430';
        ctx.fillRect(-5, -2, 10, 6);
        ctx.fillRect(secondX - 5, secondY - 2, 10, 6);
        ctx.fillStyle = '#7be3d7';
        ctx.fillRect(-4, -1, 8, 4);
        ctx.fillRect(secondX - 4, secondY - 1, 8, 4);
        ctx.fillStyle = '#f8c45f';
        ctx.fillRect(-1, 0, 3, 3);
        ctx.fillRect(secondX - 1, secondY, 3, 3);
    }

    _drawWeaponStroke(ctx, color, width, points) {
        if (!points.length) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        ctx.beginPath();
        ctx.moveTo(Math.round(points[0][0]), Math.round(points[0][1]));
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(Math.round(points[i][0]), Math.round(points[i][1]));
        }
        ctx.stroke();
    }

    _drawTaperedBlade(ctx, x0, y0, x1, y1, baseHalfWidth, tipHalfWidth) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.hypot(dx, dy) || 1;
        const px = -dy / length;
        const py = dx / length;
        const outline = this._bladePolygon(x0, y0, x1, y1, baseHalfWidth + 1.8, tipHalfWidth + 1.2, px, py);
        const blade = this._bladePolygon(x0, y0, x1, y1, baseHalfWidth, tipHalfWidth, px, py);

        ctx.fillStyle = '#0b2430';
        this._fillWeaponPolygon(ctx, outline);
        ctx.fillStyle = '#dce8ec';
        this._fillWeaponPolygon(ctx, blade);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x0 + px * baseHalfWidth * 0.35), Math.round(y0 + py * baseHalfWidth * 0.35));
        ctx.lineTo(Math.round(x1 - dx * 0.12), Math.round(y1 - dy * 0.12));
        ctx.stroke();
        ctx.strokeStyle = '#55c7f0';
        ctx.beginPath();
        ctx.moveTo(Math.round(x0 - px * baseHalfWidth * 0.55), Math.round(y0 - py * baseHalfWidth * 0.55));
        ctx.lineTo(Math.round(x1 - dx * 0.22), Math.round(y1 - dy * 0.22));
        ctx.stroke();
    }

    _bladePolygon(x0, y0, x1, y1, baseHalfWidth, tipHalfWidth, px, py) {
        return [
            [x0 + px * baseHalfWidth, y0 + py * baseHalfWidth],
            [x1 + px * tipHalfWidth, y1 + py * tipHalfWidth],
            [x1, y1],
            [x1 - px * tipHalfWidth, y1 - py * tipHalfWidth],
            [x0 - px * baseHalfWidth, y0 - py * baseHalfWidth],
        ];
    }

    _fillWeaponPolygon(ctx, points) {
        if (!points.length) return;
        ctx.beginPath();
        ctx.moveTo(Math.round(points[0][0]), Math.round(points[0][1]));
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(Math.round(points[i][0]), Math.round(points[i][1]));
        }
        ctx.closePath();
        ctx.fill();
    }

    // --- Variant and accessory helpers (used by draw to select sprite) ---

    /** Returns the historical 0..3 variant so existing agents keep their colors. */
    _hashVariant() {
        const hash = Math.abs(this._hash(`${this.agent.id}:${this.agent.model || ''}:${this._providerKey()}`));
        return hash % 4;
    }

    // --- C2 action strips (plan 2.2 / 2.3) ---

    // Resolves the authored pose for this frame, or null when the character has
    // no strip, is travelling, or is doing something the strip does not author.
    // Null is the contract's fallback: the procedural overlay stays in charge.
    _actionStripPose(identity, spriteId) {
        if (this.moving || this.chatting || departedTableau(this) || this.animState !== 'idle') return null;
        const group = this.actionStripGroup();
        if (!group) return null;
        const strip = this.assets?.getActionStrip?.(spriteId);
        if (!strip?.image || !strip.meta) return null;
        const cell = resolveActionFrame(strip.meta, group, this.direction, this._actionStripFrame(strip.meta, group));
        if (!cell) return null;
        const cellSize = Number(strip.meta.cell) || DEFAULT_CELL;
        const source = this.compositor?.stripFor(`${spriteId}|${strip.path || 'actions'}`, strip.image, {
            baseSpriteId: spriteId,
            paletteKey: identity?.paletteKey || this._providerKey(),
            paletteVariant: this._hashVariant(),
            runtimeAccessory: this._runtimeHeadAccessory(identity, this.agent),
            teamTrim: this._teamTrimAccent(),
            cellSize,
            outline: true,
        }) || strip.image;
        return { group, cell, source, strip };
    }

    // Which authored group the current truth asks for. The held wait row wins
    // over the generic work/think vocabulary (2.3); reading is the only other
    // authored group today. Never derived from elapsed time.
    actionStripGroup() {
        if (this.agent?.status === AgentStatus.WAITING_ON_USER) return 'wait';
        return resolveAgentAction(this.agent, { chatting: this.chatting }) === AgentAction.READ ? 'read' : null;
    }

    _actionStripFrame(meta, group) {
        // Static band for the held wait row, for a stale observation (C1), and
        // for reduced motion. Otherwise one two-frame medium-band beat, which
        // replaces the working pulse instead of stacking on it.
        if (group === 'wait' || this.motionScale <= 0 || this.observation?.state === 'stale') return 'hold';
        const rows = meta?.groups?.[group]?.rows;
        const first = Number(rows?.[0]);
        const span = Number(rows?.[1]) - first + 1;
        if (!Number.isInteger(first) || !(span > 1)) return 'hold';
        const hold = Number(meta.groups[group].hold);
        const holdIndex = Number.isInteger(hold) ? Math.max(0, hold - first) : span - 1;
        return (Math.floor(Date.now() / ACTION_BEAT_MS) % 2)
            ? (holdIndex - 1 + span) % span
            : holdIndex;
    }

    /**
     * The body cell this sprite last drew: the authored strip cell when a pose
     * resolved, otherwise the base sheet cell. `canvas` is the bitmap the cell
     * belongs to. Null before the first draw.
     */
    currentPoseCell() {
        return this._poseCell;
    }

    // 2.4 — the bounded personal signature. `family` is the canonical sprite
    // family, so the mark stays subordinate to the model silhouette: the same
    // index under a different body is a different signature. Resolved once per
    // family change; the identity hash and the four palette variants above are
    // untouched.
    signature(family = null) {
        // Impostor paths draw before the hero path has pinned a family, so the
        // fallback resolves the same canonical sprite family rather than a
        // provider default: one agent keeps one mark through every LOD.
        const key = family ? String(family) : (this._signatureFamily || this._canonicalSpriteFamily());
        if (!this._signature || this._signatureFamily !== key) {
            this._signatureFamily = key;
            this._signature = agentSignature(this.agent?.id, key);
        }
        return this._signature;
    }

    _canonicalSpriteFamily() {
        const identity = getModelVisualIdentity(this.agent?.model, this.agent?.effort, this.agent?.provider);
        return identity.spriteId || `agent.${this._providerKey()}.base`;
    }

    /** Accent tone for the signature clasp: team trim first, then provider trim. */
    signatureAccent() {
        return this._teamTrimAccent() || this._providerTrimColor();
    }

    // 2.4 — one stamp for every distance. Screen-fixed cell size (1 px at
    // overview, 2 px from zoom 2). Static band: no pulse, no timer, identical
    // under reduced motion. Plan 2.5 / S12 — the clasp is a detail mark: only
    // at z >= 3 or on the selected body, so clustered bodies never stack
    // 3–4 chips; on the ungraded resident overlay it takes the C2 grade.
    _drawSignatureMark(ctx, frameGeometry) {
        const { dx, dy, bounds, drawScale } = frameGeometry || {};
        if (!bounds || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const zoom = this._zoom || 1;
        if (zoom < SIGNATURE_MIN_ZOOM && !this.selected) return;
        const width = Math.max(1, bounds.maxX - bounds.minX);
        const height = Math.max(1, bounds.maxY - bounds.minY);
        const grade = this.gpuWorldEnabled ? this.overlayLightGrade : null;
        ctx.save();
        ctx.translate(
            Math.round(dx + (bounds.minX + width * 0.3) * drawScale),
            Math.round(dy + (bounds.minY + height * 0.46) * drawScale),
        );
        ctx.scale(1 / zoom, 1 / zoom);
        drawAgentSignature(ctx, this.signature(), {
            x: 0,
            y: 0,
            pixel: zoom >= 2 ? 2 : 1,
            ink: gradeTone('#150f0c', grade),
            accent: gradeTone(this.signatureAccent(), grade),
        });
        ctx.restore();
    }

    // 2.5 — a snapshot miniature for lifecycle cues: the child's own idle row
    // cropped to content and copied as pixels, so a dispatch or a return never
    // holds a live reference to a sprite the renderer may dispose. Returns null
    // until the character sheet is loaded; callers retry.
    captureMiniature(size = 14) {
        const source = this.spriteCanvas || this._composeBaseSheet();
        if (!source) return null;
        const sheet = source === this.spriteCanvas && this.spriteSheet ? this.spriteSheet : new SpriteSheet(source);
        const cell = sheet.cell('idle', 0, 0);
        const bounds = this._cellContentBoundsOf(source, cell);
        const cropW = Math.max(1, bounds.maxX - bounds.minX + 1);
        const cropH = Math.max(1, bounds.maxY - bounds.minY + 1);
        const scale = Math.max(1, Math.round(size)) / cropH;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(cropW * scale));
        canvas.height = Math.max(1, Math.round(cropH * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, cell.sx + bounds.minX, cell.sy + bounds.minY, cropW, cropH, 0, 0, canvas.width, canvas.height);
        return {
            agentId: this.agent?.id || null,
            canvas,
            signature: this.signature(),
            accent: this.signatureAccent(),
        };
    }

    // The composed base sheet for this agent's profile, resolved through the
    // shared Compositor cache. A child dispatched before its first draw has no
    // spriteCanvas yet, and it must still leave as itself.
    _composeBaseSheet() {
        if (!this.compositor) return null;
        const identity = getModelVisualIdentity(this.agent?.model, this.agent?.effort, this.agent?.provider);
        const provider = this._providerKey();
        return this.compositor.spriteFor(
            identity.spriteId || `agent.${provider}.base`,
            identity.paletteKey || provider,
            this._hashVariant(),
            this._runtimeHeadAccessory(identity, this.agent),
            this._teamTrimAccent(),
            { outline: !this._shouldScrubBakedCodexWeapon(identity) },
        );
    }

    // 2.5 — one static receive beat while a child's return lands here. Static
    // band: a held mark for a bounded window, identical under reduced motion,
    // and neutral — a child returned, which is not a claim that it succeeded.
    setReceiveBeat(now = Date.now(), duration = RECEIVE_BEAT_MS) {
        this._receiveBeatUntil = now + Math.max(0, duration);
    }

    _drawReceiveBeat(ctx, frameGeometry) {
        if (!(this._receiveBeatUntil > Date.now())) return;
        const { dx, dy, bounds, drawScale } = frameGeometry || {};
        if (!bounds || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const width = Math.max(1, bounds.maxX - bounds.minX);
        const height = Math.max(1, bounds.maxY - bounds.minY);
        const zoom = this._zoom || 1;
        ctx.save();
        ctx.translate(
            Math.round(dx + (bounds.minX + width * 0.5) * drawScale),
            Math.round(dy + (bounds.minY + height * 0.34) * drawScale),
        );
        ctx.scale(1 / zoom, 1 / zoom);
        drawEventShape(ctx, 'child-return', -8, -8, 1, '#e7d3a0');
        ctx.restore();
    }

    // Content bounds of one cell inside an arbitrary composed sheet. The
    // per-cell cache is keyed on the sprite's own sheet, so foreign sources
    // (miniature snapshots) scan without polluting it.
    _cellContentBoundsOf(source, cell) {
        if (source === this.spriteCanvas) return this._getCellContentBounds(cell);
        return measureCellContentBounds(source, cell);
    }

    // --- Provider / model helpers ---

    _providerKey(agent = this.agent) {
        return providerPaletteKey(agent);
    }

    // --- Utility helpers ---

    _hash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    _noise(seed, salt) {
        const n = Math.sin((seed + salt) * 12.9898) * 43758.5453;
        return n - Math.floor(n);
    }

    // --- Status / UI overlay drawing ---

    _drawStatus(ctx, contentTopY = null) {
        if (this.decisionFocusMuted) return;
        // T1 — an action-needed head carries its beacon and attention plate;
        // the Activity Panel carries its words.
        if (isAttentionStatus(this.agent?.status)) return;
        const visual = this._statusVisual();
        const thread = this._activityThread();
        // The long-wait clock is a glyph, not speech: it reports how long this
        // agent has been blocked and stays available even when the agent has
        // said nothing we can attribute.
        const useClock = this._shouldUseLongWaitClock();
        if (!useClock && !thread.length) return;
        // 3.8 — this agent's bubble merged into a cluster-mate's identical
        // bubble: the representative draws one bubble with a ×N chip instead.
        if (this.bubbleMergedInto && !this.selected) return;
        // Crowd de-collision (IsometricRenderer._assignAgentBubbleSlots): beyond
        // the slot cap the bubble collapses to a small ellipsis dot so dense
        // clusters stay readable. Selected agents always keep their full bubble.
        if (this.bubbleSuppressed && !this.selected) {
            this._drawBubbleDotMarker(ctx, visual.color, contentTopY);
            return;
        }
        const stackShift = this.bubbleSlot > 0 ? -this.bubbleSlot * STATUS_BUBBLE_STACK_STEP : 0;
        const head = thread[0] || null;
        if (useClock) {
            this._drawLongWaitClockBubble(ctx, head?.accent || visual.color, contentTopY, stackShift);
        } else {
            this._drawBubble(ctx, head.text, head.accent || visual.color, contentTopY, head.confidence, stackShift, {
                // Tailless for anything that is not the model's own quotable
                // words: long-form reasoning excerpts must never wear speech
                // styling, because an excerpt of a thought is not a quote.
                tail: head.shape !== 'chip',
                badge: head.badge || null,
            });
        }
        if (thread.length > 1) {
            this._drawHistoryBubbles(ctx, thread.slice(1), contentTopY, stackShift);
        }
    }

    // Static ellipsis marker shown when the renderer suppresses this agent's
    // bubble in a crowded slot cluster. Pure layout, no motion — reads the same
    // under reduced motion.
    _drawBubbleDotMarker(ctx, accentColor, contentTopY = null) {
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this._placeX, Number.isFinite(contentTopY) ? contentTopY : this._placeY);
        ctx.scale(s, s);
        const anchored = Number.isFinite(contentTopY);
        ctx.translate(0, anchored ? -18 : -50);
        ctx.globalAlpha *= 0.82;
        ctx.fillStyle = accentColor;
        for (let i = -1; i <= 1; i++) {
            ctx.beginPath();
            ctx.arc(i * 4, 0, 1.1, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // Derived from the agent, not from an activity entry: a blocked agent that
    // is saying nothing still needs its wait to be visible.
    _shouldUseLongWaitClock() {
        if (this.agent?.status !== AgentStatus.WAITING) return false;
        const age = Number(this.agent?.activityAgeMs);
        return Number.isFinite(age) && age > 60_000;
    }

    _drawLongWaitClockBubble(ctx, accentColor, contentTopY = null, stackShift = 0) {
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this._placeX, Number.isFinite(contentTopY) ? contentTopY : this._placeY);
        ctx.scale(s, s);
        const anchored = Number.isFinite(contentTopY);
        const bubbleW = anchored ? 22 : 28;
        const bubbleH = anchored ? 20 : 26;
        const radius = anchored ? 5 : 6;
        ctx.translate(0, (anchored ? -18 : -50) + stackShift);
        const halfW = bubbleW / 2;
        ctx.fillStyle = 'rgba(34, 24, 19, 0.94)';
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-halfW + radius, -bubbleH / 2);
        ctx.lineTo(halfW - radius, -bubbleH / 2);
        ctx.quadraticCurveTo(halfW, -bubbleH / 2, halfW, -bubbleH / 2 + radius);
        ctx.lineTo(halfW, bubbleH / 2 - radius);
        ctx.quadraticCurveTo(halfW, bubbleH / 2, halfW - radius, bubbleH / 2);
        ctx.lineTo(4, bubbleH / 2);
        ctx.lineTo(0, bubbleH / 2 + (anchored ? 6 : 7));
        ctx.lineTo(-4, bubbleH / 2);
        ctx.lineTo(-halfW + radius, bubbleH / 2);
        ctx.quadraticCurveTo(-halfW, bubbleH / 2, -halfW, bubbleH / 2 - radius);
        ctx.lineTo(-halfW, -bubbleH / 2 + radius);
        ctx.quadraticCurveTo(-halfW, -bubbleH / 2, -halfW + radius, -bubbleH / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 6-line clock glyph: outer ring + two hands.
        const cx = 0;
        const cy = 0;
        const r = anchored ? 5 : 6;
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy - r + 1);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + r - 2, cy);
        ctx.stroke();
        ctx.restore();
    }

    _drawBubble(ctx, text, accentColor, contentTopY = null, confidence = null, stackShift = 0, { tail = true, badge = null } = {}) {
        ctx.save();
        const s = 1 / (this._zoom || 1); // inverse zoom correction

        ctx.translate(this._placeX, Number.isFinite(contentTopY) ? contentTopY : this._placeY);
        ctx.scale(s, s); // fixed size in screen space

        // Measure text size and auto-truncate
        const anchored = Number.isFinite(contentTopY);
        ctx.font = WORLD_BODY_FONT_11;
        const maxWidth = anchored ? STATUS_BUBBLE_MAIN_MAX_WIDTH.anchored : STATUS_BUBBLE_MAIN_MAX_WIDTH.floating;
        const confidenceValue = Number(confidence);
        const lowConfidence = Number.isFinite(confidenceValue) && confidenceValue < TOOL_CONFIDENCE_THRESHOLD;
        // Append the low-confidence '?' only to plain text — skip when the label
        // already ends in punctuation so we never produce 'uncovered!?'.
        const trimmedText = String(text ?? '').trimEnd();
        const bubbleText = lowConfidence && trimmedText && !/[.!?…]$/.test(trimmedText) ? `${text}?` : text;
        const layout = this._bubbleLayout(ctx, bubbleText, maxWidth, anchored);
        const displayText = layout.displayText;
        const textWidth = layout.textWidth;
        const bubbleW = textWidth + (anchored ? 18 : 24);
        const bubbleH = anchored ? 20 : 26;
        const radius = anchored ? 5 : 6;

        ctx.translate(0, (anchored ? -18 : -50) + stackShift);

        // Speech bubble background
        const halfW = bubbleW / 2;
        ctx.fillStyle = 'rgba(34, 24, 19, 0.94)';
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-halfW + radius, -bubbleH / 2);
        ctx.lineTo(halfW - radius, -bubbleH / 2);
        ctx.quadraticCurveTo(halfW, -bubbleH / 2, halfW, -bubbleH / 2 + radius);
        ctx.lineTo(halfW, bubbleH / 2 - radius);
        ctx.quadraticCurveTo(halfW, bubbleH / 2, halfW - radius, bubbleH / 2);
        if (tail) {
            ctx.lineTo(4, bubbleH / 2);
            ctx.lineTo(0, bubbleH / 2 + (anchored ? 6 : 7));
            ctx.lineTo(-4, bubbleH / 2);
        }
        ctx.lineTo(-halfW + radius, bubbleH / 2);
        ctx.quadraticCurveTo(-halfW, bubbleH / 2, -halfW, bubbleH / 2 - radius);
        ctx.lineTo(-halfW, -bubbleH / 2 + radius);
        ctx.quadraticCurveTo(-halfW, -bubbleH / 2, -halfW + radius, -bubbleH / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.fillStyle = '#f3e2bd';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        this._applyReadableTextShadow(ctx);
        ctx.fillText(displayText, 0, 0, maxWidth);

        // Provenance badge: a 2px dot on the leading edge, colored by where the
        // line came from. Present only for model-authored text, so an unbadged
        // bubble is by definition not a quote. The dot is deliberately mute —
        // the full origin string lives in the selected-agent narration panel,
        // which is the only surface that can render readable attribution.
        if (badge) {
            ctx.beginPath();
            ctx.fillStyle = badge;
            ctx.arc(-halfW + (anchored ? 4 : 5), -bubbleH / 2 + (anchored ? 4 : 5), anchored ? 1.6 : 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // 3.8 — ×N chip: this bubble speaks for N cluster-mates sharing the
        // identical line (merged by the renderer's bubble-slot pass). Static
        // mark, no motion claim.
        const mergedCount = this.bubbleMergedCount || 1;
        if (mergedCount > 1) {
            const label = `x${mergedCount}`;
            ctx.font = WORLD_DISPLAY_FONT_8;
            const chipW = 6 + label.length * 8;
            const chipX = halfW + 2;
            const chipY = -bubbleH / 2 - 2;
            ctx.fillStyle = 'rgba(20, 14, 10, 0.92)';
            ctx.strokeStyle = accentColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(chipX - chipW / 2, chipY - 5, chipW, 10, 3);
            } else {
                ctx.rect(chipX - chipW / 2, chipY - 5, chipW, 10);
            }
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#f8ead1';
            ctx.fillText(label, chipX, chipY + 0.5);
        }

        ctx.restore();
    }

    _bubblePath(ctx, width) {
        const hw = width / 2;
        const r = 5;
        ctx.beginPath();
        ctx.moveTo(-hw, -10);
        ctx.lineTo(hw, -10);
        ctx.quadraticCurveTo(hw + r, -10, hw + r, -10 + r);
        ctx.lineTo(hw + r, 4);
        ctx.quadraticCurveTo(hw + r, 8, hw, 8);
        ctx.lineTo(3, 8);
        ctx.lineTo(0, 14);
        ctx.lineTo(-3, 8);
        ctx.lineTo(-hw, 8);
        ctx.quadraticCurveTo(-hw - r, 8, -hw - r, 4);
        ctx.lineTo(-hw - r, -10 + r);
        ctx.quadraticCurveTo(-hw - r, -10, -hw, -10);
        ctx.closePath();
    }

    _drawHistoryBubbles(ctx, entries = [], contentTopY = null, stackShift = 0) {
        if (!entries.length) return;
        ctx.save();
        const s = 1 / (this._zoom || 1);
        const anchored = Number.isFinite(contentTopY);
        const maxWidth = anchored ? STATUS_BUBBLE_HISTORY_MAX_WIDTH.anchored : STATUS_BUBBLE_HISTORY_MAX_WIDTH.floating;
        ctx.translate(this._placeX, Number.isFinite(contentTopY) ? contentTopY : this._placeY);
        ctx.scale(s, s);
        ctx.font = WORLD_BODY_FONT_11;

        let offsetY = (anchored ? -32 : -66) + stackShift;
        const shown = entries.slice(0, ACTION_TRAIL_LIMIT);
        for (let i = 0; i < shown.length; i++) {
            const entry = shown[i];
            const fade = i === 0 ? 0.74 : 0.56;
            const layout = this._bubbleLayout(ctx, entry.text, maxWidth, anchored);
            const text = layout.displayText;
            const textWidth = layout.textWidth;
            const bubbleW = textWidth + (anchored ? 14 : 18);
            const bubbleH = anchored ? 14 : 18;
            const radius = anchored ? 3 : 4;

            ctx.save();
            ctx.globalAlpha *= fade;
            ctx.translate(0, offsetY);
            ctx.fillStyle = 'rgba(24, 18, 14, 0.88)';
            ctx.strokeStyle = entry.accent || this._providerTrimColor();
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(-bubbleW / 2, -bubbleH / 2, bubbleW, bubbleH, radius);
            } else {
                ctx.rect(-bubbleW / 2, -bubbleH / 2, bubbleW, bubbleH);
            }
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#d9cbb0';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            this._applyReadableTextShadow(ctx);
            ctx.fillText(text, 0, 0, maxWidth);
            ctx.restore();

            offsetY -= bubbleH + 4;
        }
        ctx.restore();
    }

    static _overlayStampCache = new Map();
    static _overlayStampPixels = 0;
    static _overlayStampFontsReady = false;

    static clearOverlayStampCache() {
        for (const stamp of AgentSprite._overlayStampCache.values()) {
            stamp.canvas.width = 0;
            stamp.canvas.height = 0;
        }
        AgentSprite._overlayStampCache.clear();
        AgentSprite._overlayStampPixels = 0;
    }

    _drawOverlayStamp(ctx, identity, left, top, width, height, paint) {
        // A flattened stamp composites translucent overlaps differently from
        // the original source-over sequence; fading plaques keep vector paint.
        if (ctx.globalAlpha !== 1) {
            paint(ctx);
            return;
        }
        if (!AgentSprite._overlayStampFontsReady && document.fonts) {
            AgentSprite._overlayStampFontsReady = true;
            document.fonts.ready.then(() => AgentSprite.clearOverlayStampCache());
        }
        const transform = ctx.getTransform();
        // Plaques cancel camera zoom before this call: retain the resulting
        // device scale, not a coarse zoom bucket that would blur their text.
        const scaleX = Math.round(transform.a * 1e6) / 1e6;
        const scaleY = Math.round(transform.d * 1e6) / 1e6;
        const pixelLeft = Math.floor(left * scaleX);
        const pixelTop = Math.floor(top * scaleY);
        const pixelWidth = Math.ceil((left + width) * scaleX) - pixelLeft;
        const pixelHeight = Math.ceil((top + height) * scaleY) - pixelTop;
        const key = `${identity}|${scaleX}|${scaleY}|${ctx.font}`;
        const cache = AgentSprite._overlayStampCache;
        let stamp = cache.get(key);
        if (stamp) {
            cache.delete(key);
            cache.set(key, stamp);
        } else {
            const canvas = document.createElement('canvas');
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
            const stampCtx = canvas.getContext('2d');
            stampCtx.setTransform(scaleX, 0, 0, scaleY, -pixelLeft, -pixelTop);
            stampCtx.globalAlpha = 1;
            stampCtx.font = ctx.font;
            stampCtx.direction = ctx.direction;
            stampCtx.shadowColor = ctx.shadowColor;
            stampCtx.shadowBlur = ctx.shadowBlur;
            stampCtx.shadowOffsetX = ctx.shadowOffsetX;
            stampCtx.shadowOffsetY = ctx.shadowOffsetY;
            paint(stampCtx);
            stamp = { canvas, pixels: pixelWidth * pixelHeight };
            if (stamp.pixels <= 4 * 1024 * 1024) {
                while (cache.size && (cache.size >= 240 ||
                    AgentSprite._overlayStampPixels + stamp.pixels > 4 * 1024 * 1024)) {
                    const oldestKey = cache.keys().next().value;
                    const oldest = cache.get(oldestKey);
                    AgentSprite._overlayStampPixels -= oldest.pixels;
                    oldest.canvas.width = 0;
                    oldest.canvas.height = 0;
                    cache.delete(oldestKey);
                }
                cache.set(key, stamp);
                AgentSprite._overlayStampPixels += stamp.pixels;
            }
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.drawImage(stamp.canvas, Math.round(transform.e) + pixelLeft, Math.round(transform.f) + pixelTop);
        ctx.restore();
        if (stamp.pixels > 4 * 1024 * 1024) {
            stamp.canvas.width = 0;
            stamp.canvas.height = 0;
        }
    }

    // Anchored over the head (plan 2.5: never across the body). `labelTopY`
    // is the head top, already raised past the selection chevron.
    _drawChatEffect(ctx, labelTopY = null) {
        if (this.decisionFocusMuted) return;
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this._placeX, Number.isFinite(labelTopY) ? labelTopY : this._headTopY());
        ctx.scale(s, s);

        // A conversation is always a message, not a tool invocation.
        const visual = this._statusVisual();
        const accent = visual?.color || '#72d071';
        const bubbleY = -20;
        const w = 30;
        const h = 24;
        const r = 5;
        this._drawOverlayStamp(ctx, `chat|${accent}`, -18, bubbleY - 15, 36, 36, (ctx) => {

            // Parchment backplate (rounded scroll), with a small downward tail.
            ctx.fillStyle = 'rgba(34, 24, 19, 0.94)';
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(-w / 2, bubbleY - h / 2, w, h, r);
            } else {
                ctx.rect(-w / 2, bubbleY - h / 2, w, h);
            }
            ctx.fill();
            ctx.stroke();

            // Tail
            ctx.fillStyle = 'rgba(34, 24, 19, 0.94)';
            ctx.beginPath();
            ctx.moveTo(-3, bubbleY + h / 2 - 1);
            ctx.lineTo(0, bubbleY + h / 2 + 6);
            ctx.lineTo(3, bubbleY + h / 2 - 1);
            ctx.fill();

            drawEventShape(ctx, 'message-scroll', -8, bubbleY - 8, 1, accent);
        });

        ctx.restore();
    }

    // C5 identity (plan 5.2; maintainer decision D2). One entry point for both
    // backends:
    //   T2 plate — selected or renderer-marked (hovered / camera focus);
    //   T4 name  — text only, and only when the renderer admitted it
    //              (overlaySlot): the top-N most recent actors per screen
    //              region at zoom >= 1.6, or every verb while READ is held;
    //   nothing  — otherwise.
    // This replaces the old rule that identity never disappears at overview
    // LOD: below 1.6 a routine name hid the body it named. Identity stays one
    // hover away and in the Sidebar, and an agent that needs the operator is
    // always named by its T1 attention plate (AttentionPlates.js).
    _drawNameTag(ctx) {
        if (this.decisionFocusRoutine || this.isArrivalPending()) return;
        const plate = this.selected || this.labelPlate === true;
        if (plate) {
            // S13 — `plateOffFrame`: the body is outside the visible canvas,
            // so no plate floats at the edge (the T1 edge plate or the panel
            // carries its identity).
            if (!this.plateOffFrame) this._drawNamePlate(ctx);
            return;
        }
        if (isAttentionStatus(this.agent?.status)) return;
        if (this.overlaySlot == null || !((this.labelAlpha ?? 1) > 0)) return;
        this._drawRoutineName(ctx);
    }

    // Screen px from the feet to the T2/T4 label top: below this body's own
    // ground marks (shadow, status ring, selection/hover ring) plus a 2 px gap,
    // so a label never sits on the robe hem or the ring (plan 2.5).
    identityLabelTopPx(zoom = this._zoom || 1) {
        return identityLabelTop(zoom, groundMarkDepth({
            contentWidth: this._stableContentWidth(),
            status: departedTableau(this) ? null : this.agent?.status,
            selected: this.selected,
            hovered: this.hovered,
        }));
    }

    // T2 — square plate: parchment Departure Mono on dark walnut, 1 px
    // outline, 2 px bar and 1 px top in gold (selected) or brass (hover).
    // `labelShiftX/Y` (screen px, set by the renderer's label pass) keep the
    // plate inside the visible canvas when the body stands at its edge.
    _drawNamePlate(ctx) {
        const baseName = String(this.agent?.name || this.agent?.displayName || '').trim() || 'Agent';
        // 4.8 — an earned nickname renders as a title suffix on the plate.
        const text = this.nickname ? `${baseName} ${this.nickname}` : baseName;
        const zoom = this._zoom || 1;
        const trim = this.selected ? LABEL_INK.gold : LABEL_INK.brass;
        ctx.save();
        ctx.translate(this._placeX, this._placeY);
        ctx.scale(1 / zoom, 1 / zoom);
        ctx.shadowColor = 'transparent';
        ctx.font = WORLD_BODY_FONT_11;
        const shown = fitLabelText(ctx, text, IDENTITY_LABEL.maxTextWidth);
        const width = measureLabelText(ctx, shown) + IDENTITY_LABEL.platePadLeft + IDENTITY_LABEL.platePadRight;
        const height = IDENTITY_LABEL.plateHeight;
        const left = -Math.round(width / 2) + Math.round(this.labelShiftX || 0);
        const top = this.identityLabelTopPx(zoom) + Math.round(this.labelShiftY || 0);
        this._drawOverlayStamp(ctx, `plate|${shown}|${trim}`, left, top, width, height, (c) => {
            c.fillStyle = LABEL_INK.plateOutline;
            c.fillRect(left, top, width, height);
            c.fillStyle = LABEL_INK.plate;
            c.fillRect(left + 1, top + 1, width - 2, height - 2);
            c.fillStyle = trim;
            c.fillRect(left + 1, top + 1, width - 2, 1);
            c.fillRect(left + 1, top + 1, 2, height - 2);
            c.font = WORLD_BODY_FONT_11;
            c.textAlign = 'left';
            c.textBaseline = 'alphabetic';
            c.fillStyle = LABEL_INK.text;
            c.fillText(shown, left + IDENTITY_LABEL.platePadLeft, top + IDENTITY_LABEL.plateBaseline);
        });
        ctx.restore();
    }

    // T4 — text only: no panel, border or glyph specks; an 8-tap one-pixel
    // outline keeps it legible on any ground. READ verbs wear plaque gold.
    _drawRoutineName(ctx) {
        const baseName = String(this.agent?.name || this.agent?.displayName || '').trim() || 'Agent';
        const text = this.readVerb || baseName;
        const color = this.readVerb ? WALNUT.text : LABEL_INK.text;
        const zoom = this._zoom || 1;
        ctx.save();
        ctx.translate(this._placeX, this._placeY);
        ctx.scale(1 / zoom, 1 / zoom);
        ctx.shadowColor = 'transparent';
        ctx.font = WORLD_BODY_FONT_11;
        const shown = fitLabelText(ctx, text, IDENTITY_LABEL.maxTextWidth);
        const width = measureLabelText(ctx, shown) + 2;
        const height = IDENTITY_LABEL.textHeight;
        const left = -Math.round(width / 2);
        const top = this.identityLabelTopPx(zoom) + (this.overlaySlot || 0) * IDENTITY_LABEL.slotStep;
        this._drawOverlayStamp(ctx, `name|${shown}|${color}`, left, top, width, height, (c) => {
            c.font = WORLD_BODY_FONT_11;
            c.textAlign = 'left';
            c.textBaseline = 'alphabetic';
            paintOutlinedText(c, shown, left + 1, top + IDENTITY_LABEL.textBaseline, color);
        });
        ctx.restore();
    }

    // 5.6 — the overview trade glyph: the authored 8×8 EventShapes motif of
    // the current tool, in the status colour with a one-pixel dark outline,
    // just under the feet. Quiet agents (no tool) carry nothing. Static.
    _drawToolGlyphBadge(ctx) {
        const tool = String(this.agent?.currentTool || '').trim();
        if (!tool) return;
        // Reuse the live tool classification so the glyph picks the same building
        // the agent is routing toward (web -> globe, mine -> pick, etc.).
        const building = memoizedToolClassification(tool, this.agent?.currentToolInput)?.building || null;
        const zoom = this._zoom || 1;
        ctx.save();
        ctx.translate(this._placeX, this._placeY);
        ctx.scale(1 / zoom, 1 / zoom);
        drawToolGlyphBadge(ctx, {
            glyph: toolGlyphKey(tool, building),
            color: this._statusVisual()?.color || LABEL_INK.text,
            x: -4,
            y: this.identityLabelTopPx(zoom),
        });
        ctx.restore();
    }

    /** Repo color profile for the home-color ground ring, cached per projectPath. */
    // Returns the team accent (#rrggbb) used as the secondary trim/sash swap
    // target, or null when the agent is not part of any team (skip swap).
    _teamTrimAccent() {
        const name = this.agent?.teamName;
        if (!name) return null;
        const accent = getTeamColor(name)?.accent;
        if (!accent || typeof accent !== 'string') return null;
        // Only return well-formed hex; getTeamColor falls back to a neutral grey
        // when teamName is empty, which we already filter above by truthiness.
        return /^#?[0-9a-fA-F]{6}$/.test(accent.trim()) ? accent.trim() : null;
    }

    // Archive fade progress in [0, 1]. IsometricRenderer sets
    // `_archiveAnim = { startedAt }` on agent:removed; we read it here.
    // Returns 0 (no fade) when the field is missing or malformed.
    _archiveFadeProgress(now = Date.now()) {
        const startedAt = Number(this._archiveAnim?.startedAt);
        if (!Number.isFinite(startedAt) || startedAt <= 0) return 0;
        const elapsed = now - startedAt;
        if (elapsed <= 0) return 0;
        return Math.max(0, Math.min(1, elapsed / 800));
    }

    // Brief radial sparkle puff during the first 200 ms of the fade.
    // Procedural — does not poke the shared ParticleSystem from inside draw.
    _drawArchiveSparkle(ctx, contentTopY, progress) {
        const t = Math.min(1, progress / 0.25); // first 200ms of the 800ms fade
        if (t >= 1) return;
        const visual = this._statusVisual();
        const color = visual?.color || '#f2d36b';
        const headY = Number.isFinite(contentTopY) ? contentTopY + 12 : this._placeY - 36;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha *= (1 - t) * 0.85;
        ctx.fillStyle = color;
        // ~5 sparkle dots radiating outward from the head.
        const baseRadius = 6 + t * 22;
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2 + t * 0.6;
            const r = baseRadius + ((i * 13) % 7);
            const sx = this._placeX + Math.cos(angle) * r;
            const sy = headY + Math.sin(angle) * r * 0.55;
            const size = 1.6 + (1 - t) * 1.2;
            ctx.beginPath();
            ctx.arc(sx, sy, size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _activityThread() {
        const now = Date.now();
        // When archiving, pin a synthetic FINAL entry at the head of the
        // thread for the duration of the fade (~800 ms). The remaining slots
        // still show the agent's most recent real activity so the player can
        // read "what they did last" while they fade out.
        const archiveProgress = this._archiveFadeProgress(now);
        if (archiveProgress > 0 && archiveProgress < 1) {
            this._pruneActivityTrail(now);
            const previous = this._captureActivitySnapshot(this.agent, now);
            const visual = this._statusVisual();
            const finalEntry = {
                kind: 'final',
                key: 'archive:final',
                text: 'FINAL',
                accent: visual?.color || '#f2d36b',
                timestamp: now,
            };
            const trail = [previous, ...this._activityTrail]
                .filter((entry) => entry && entry.text);
            const deduped = [];
            const seen = new Set();
            for (const entry of [finalEntry, ...trail]) {
                const dedupeKey = entry.key || entry.text;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                deduped.push({ ...entry, count: 1 });
                if (deduped.length >= ACTION_TRAIL_LIMIT + 1) break;
            }
            return deduped;
        }
        this._pruneActivityTrail(now);
        const current = this._captureActivitySnapshot(this.agent, now);
        this._activitySnapshot = current;
        const all = [current, ...this._activityTrail];
        const deduped = [];
        const seen = new Set();
        for (const entry of all) {
            if (!entry?.text) continue;
            const dedupeKey = entry.key || entry.text;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            // Collapse consecutive same-category tool entries into the most
            // recent label suffixed with ×N.
            const last = deduped[deduped.length - 1];
            if (
                last
                && last.kind === 'tool'
                && entry.kind === 'tool'
                && last.category
                && entry.category
                && last.category === entry.category
            ) {
                last.count = (last.count || 1) + 1;
                last.text = `${this._stripRunCount(last.text)} ×${last.count}`;
                continue;
            }
            deduped.push({ ...entry, count: 1 });
            if (deduped.length >= ACTION_TRAIL_LIMIT + 1) break;
        }
        return deduped;
    }

    _stripRunCount(text) {
        return String(text || '').replace(/\s×\d+$/, '');
    }

    // Hover text for this villager's current line: the full untrimmed wording
    // when the bubble had to shorten it, plus the exact origin. Reads the
    // snapshot the sprite already computed, so hovering costs no extra work.
    dialogueTooltip() {
        const entry = this._activitySnapshot;
        if (!entry?.text || !entry.source) return '';
        const body = entry.full || entry.text;
        return `${body}\n${dialogueSourceLabel(entry)}`;
    }

    // Null when the agent has nothing attributable to say. `_activityThread`
    // already skips textless entries, so silence propagates naturally: no
    // bubble, no chip, no fabricated 'IDLE' line.
    _captureActivitySnapshot(agent = this.agent, timestamp = Date.now()) {
        return this._activityEntryForAgent(agent, timestamp);
    }

    _activityEntryForAgent(agent = this.agent, timestamp = Date.now()) {
        if (!agent) return null;
        // Agent.speech() is the only source of villager words. It returns the
        // model's own text with provenance, or null — there is no preset pool
        // and no tool label dressed as speech. A line only outlives its normal
        // window when the agent is blocked on the operator, and it says so.
        const speech = typeof agent.speech === 'function' ? agent.speech(timestamp) : null;
        if (speech?.text) {
            const currentTool = String(agent.currentTool || '').trim();
            const classified = currentTool
                ? memoizedToolClassification(currentTool, agent.currentToolInput)
                : null;
            return {
                kind: speech.kind,
                shape: speech.shape,
                key: `speech:${speech.actionId || speech.source}:${speech.text}`,
                text: speech.text,
                full: speech.full,
                source: speech.source,
                fidelity: speech.fidelity,
                redacted: speech.redacted,
                held: speech.held === true,
                badge: DIALOGUE_BADGE_COLORS[speech.kind] || null,
                accent: this._providerTrimColor(agent),
                tool: currentTool || null,
                category: classified?.category || null,
                confidence: null,
                // The moment the model wrote it, not when we polled.
                timestamp: speech.observedAt,
            };
        }
        // Nothing attributable to say: silence. Status stays legible through
        // the existing non-text affordances — the selection ring, status
        // overlays, the tool glyph, and the long-wait clock in `_drawStatus` —
        // so an agent that is merely thinking no longer emits a word.
        return null;
    }

    _rememberActivitySnapshot(entry, timestamp = Date.now()) {
        if (!entry?.text || !entry?.key) return;
        // Status is harness state, not work the agent narrated.
        if (entry.kind === 'status') return;
        this._pruneActivityTrail(timestamp);
        const latest = this._activityTrail[0];
        if (latest?.key === entry.key) {
            latest.timestamp = Number.isFinite(Number(entry.timestamp)) ? Number(entry.timestamp) : timestamp;
            latest.confidence = Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : null;
            return;
        }
        this._activityTrail.unshift({
            kind: entry.kind || 'tool',
            // Provenance travels with the trail entry so a historical line can
            // never be redrawn with more authority than it was captured with.
            shape: entry.shape || 'bubble',
            badge: entry.badge || null,
            source: entry.source || null,
            fidelity: entry.fidelity || null,
            redacted: entry.redacted === true,
            held: entry.held === true,
            full: entry.full || null,
            key: entry.key,
            text: entry.text,
            accent: entry.accent || this._providerTrimColor(),
            tool: entry.tool || null,
            category: entry.category || null,
            confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : null,
            timestamp: Number.isFinite(Number(entry.timestamp)) ? Number(entry.timestamp) : timestamp,
        });
        if (this._activityTrail.length > ACTION_TRAIL_LIMIT) {
            this._activityTrail.length = ACTION_TRAIL_LIMIT;
        }
    }

    _pruneActivityTrail(now = Date.now()) {
        if (!this._activityTrail.length) return;
        this._activityTrail = this._activityTrail.filter((entry) => {
            const timestamp = Number(entry?.timestamp);
            return Number.isFinite(timestamp) && now - timestamp <= ACTION_TRAIL_TTL_MS;
        });
    }

    _bubbleLayout(ctx, text, maxWidth, anchored) {
        const source = String(text || '');
        const fontStatus = typeof document !== 'undefined' ? document.fonts?.status || 'unknown' : 'unknown';
        const key = `${source}|${maxWidth}|${ctx.font}|${anchored ? 1 : 0}|${fontStatus}`;
        if (this._bubbleLayoutCacheKey === key && this._bubbleLayoutCache) return this._bubbleLayoutCache;
        let displayText = source;
        if (source && ctx.measureText(source).width > maxWidth) {
            // Binary search the longest prefix that fits with its ellipsis, then
            // retreat to the last word boundary. The previous implementation
            // shrank one character at a time (up to 80 measureText calls) and
            // cut mid-word, which is what produced unreadable fragments like
            // 'Reclassifying supplemen…'.
            let lo = 0;
            let hi = source.length;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (ctx.measureText(`${source.slice(0, mid)}…`).width <= maxWidth) lo = mid;
                else hi = mid - 1;
            }
            let cut = lo;
            const boundary = source.lastIndexOf(' ', cut);
            // Only honour a boundary that keeps most of the affordable width;
            // otherwise a long unbroken token (a path, a command) would collapse.
            if (boundary > cut * 0.5) cut = boundary;
            // Never split a surrogate pair: that emits replacement junk.
            const code = source.charCodeAt(cut - 1);
            if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
            const body = source.slice(0, Math.max(1, cut)).replace(/[\s,;:.\-]+$/, '');
            displayText = `${body}…`;
        }
        const layout = {
            displayText,
            textWidth: ctx.measureText(displayText).width,
        };
        this._bubbleLayoutCacheKey = key;
        this._bubbleLayoutCache = layout;
        return layout;
    }

    _applyReadableTextShadow(ctx) {
        ctx.shadowColor = 'rgba(8, 5, 4, 0.86)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    }

    // Head emotes for the quiet states only. Waiting-on-user, errored and
    // rate-limited heads belong to the T1 beacon and attention plate
    // (AttentionPlates.js), so those states return null here.
    _statusEmoteKind() {
        const status = this.agent?.status;
        if (isAttentionStatus(status)) return null;
        if (status === AgentStatus.COMPLETED && this._completedAtMs > 0 && Date.now() - this._completedAtMs < 4000) {
            return 'completed';
        }
        if (this.agent?.isToolFresh && !this.chatting && status === AgentStatus.WORKING) {
            return 'thinking';
        }
        return null;
    }

    _drawStatusEmote(ctx, contentTopY) {
        if (!Number.isFinite(contentTopY)) return;
        const kind = this._statusEmoteKind();
        if (!kind) return;
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this._placeX, contentTopY);
        ctx.scale(s, s);
        ctx.translate(0, -14);
        snapScreenOrigin(ctx);
        if (kind === 'completed') {
            // 0.4 — the small-victory check wears the completed status's own
            // soft gold (STATUS_VISUALS.completed), not a foreign green.
            drawOutlinedMotif(ctx, 'check', -4, -4, { color: STATUS_VISUALS.completed?.color || '#ffd873' });
        } else if (kind === 'thinking') {
            this._drawThinkingDotsGlyph(ctx, '#cfd6df');
        }
        ctx.restore();
    }

    _drawPlanModeGlyph(ctx, contentTopY) {
        // Hide when a status emote or the T1 beacon owns the slot.
        if (!Number.isFinite(contentTopY)) return;
        if (!this.behavior?.planMode) return;
        if (this._statusEmoteKind() || isAttentionStatus(this.agent?.status)) return;
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this._placeX, contentTopY);
        ctx.scale(s, s);
        ctx.translate(0, -22);
        const box = 8;
        const half = box / 2;
        ctx.strokeStyle = '#8fc4ff';
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-half, half);
        ctx.lineTo(half, half);
        ctx.lineTo(-half, -half);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = '#cfe2ff';
        ctx.fillRect(-half - 1, half - 1, 2, 2);
        ctx.restore();
    }

    _drawRetryGlyph(ctx, contentTopY) {
        if (!Number.isFinite(contentTopY)) return;
        if (!this.behavior?.isRetryGlyphActive?.()) return;
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this._placeX, contentTopY);
        ctx.scale(s, s);
        // Offset right so it doesn't collide with the emote stack.
        ctx.translate(12, -14);
        const box = 8;
        const r = box / 2;
        ctx.strokeStyle = '#f6cf60';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(0, 0, r, Math.PI * 0.25, Math.PI * 1.85);
        ctx.stroke();
        ctx.fillStyle = '#f6cf60';
        const ax = Math.cos(Math.PI * 1.85) * r;
        const ay = Math.sin(Math.PI * 1.85) * r;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - 2, ay - 2);
        ctx.lineTo(ax + 1, ay - 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // Three 2 px pixel dots on the snapped screen grid (no arcs).
    _drawThinkingDotsGlyph(ctx, color) {
        const animated = this.motionScale > 0;
        const moodScale = moodBehaviorMultiplier(this.agent?.mood, 'thinkDuration');
        const duration = this._modelBehavior.thinkDuration * moodScale;
        ctx.fillStyle = color;
        for (let i = 0; i < 3; i++) {
            // Pulse band: `intrinsic` (slow). Heavy models hold each thought
            // beat longer; reduced motion keeps the complete three-dot glyph.
            ctx.globalAlpha = animated
                ? pulseAlpha(
                    'intrinsic',
                    this.statusAnim * THINK_PULSE_FRAME_SCALE / duration + i * THINK_DOT_PHASE_FRAMES,
                    this.motionScale,
                    0.42,
                    1,
                )
                : 1;
            ctx.fillRect(-5 + i * 4, -1, 2, 2);
        }
        ctx.globalAlpha = 1;
    }

    _drawStanceOverlay(ctx, frameGeometry) {
        const status = this.agent?.status;
        if (status === AgentStatus.IDLE && !this.chatting) return;
        const { dx, dy, bounds, drawScale } = frameGeometry || {};
        if (!bounds || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
        const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
        const centerX = dx + (bounds.minX + bounds.maxX) * drawScale / 2;
        const handY = dy + (bounds.minY + contentHeight * 0.62) * drawScale;
        const directionKey = DIRECTIONS[this.direction] || 's';
        const sideSign = ['sw', 'w', 'nw', 'n'].includes(directionKey) ? -1 : 1;
        const handX = centerX + sideSign * contentWidth * 0.30 * drawScale;
        // Pixel grammar: snapped texel stamps, no AA arcs or strokes.
        const px = Math.round(handX);
        const py = Math.round(handY);

        if (this.chatting) {
            const wavePhase = this.motionScale > 0 ? Math.floor(Date.now() / 600) % 2 : 0;
            const waveX = centerX + (wavePhase ? sideSign : -sideSign) * contentWidth * 0.34 * drawScale;
            ctx.save();
            ctx.fillStyle = '#f2d36b';
            ctx.fillRect(Math.round(waveX) - 1, Math.round(handY) - 1, 2, 2);
            ctx.restore();
            return;
        }

        if (status === AgentStatus.WORKING && this.agent?.isToolFresh) {
            // Static 2×2 work dot in the status hue, no blink.
            ctx.save();
            ctx.fillStyle = this._statusVisual()?.color || '#7be39a';
            ctx.fillRect(px - 1, py - 1, 2, 2);
            ctx.restore();
            return;
        }

        if (status === AgentStatus.WAITING && !this._statusEmoteKind()) {
            // A 7-texel stepped chevron above the head.
            ctx.save();
            ctx.fillStyle = this._statusVisual()?.color || '#df8c3f';
            const baseX = Math.round(centerX);
            const baseY = Math.round(dy + (bounds.minY - 4) * drawScale);
            for (let i = -3; i <= 3; i++) ctx.fillRect(baseX + i, baseY + (3 - Math.abs(i)), 1, 1);
            ctx.restore();
            return;
        }
    }

    // #13 — mood body-language motes on a slow cadence: distressed sheds a
    // sinking fret speck near the head, proud lets a sparkle rise above it. One
    // mote per beat (a single medium pulse per agent) and never while a tool
    // ritual is mid-gesture, so it does not stack on the working glow. Reduced
    // motion (motionScale 0) or movement fires nothing — the static head-drop /
    // lift posture is the standing cue in that case.
    _advanceMoodPostureMotes(particleSystem) {
        if (!particleSystem || this.motionScale <= 0 || this.moving || this.chatting) return;
        // Defer to the building work-gesture so only one mote source is active.
        if (this._toolRitual?.pose && this._toolRitual.phase !== 'fading') return;
        const mood = this.agent?.mood;
        const intensity = this._clamp(Number(mood?.intensity) || 0, 0, 1);
        if (!mood || intensity <= 0) return;

        let preset = null;
        let period = 0;
        // Offsets from the top of the 1:1 head (plan 2.1), not the feet.
        let dy = 10;
        if (mood.type === 'distressed') { preset = 'fretMote'; period = 2200; dy = 4; }
        else if (mood.type === 'proud') { preset = 'sparkle'; period = 3400; dy = -4; }
        else return;

        // Stagger beats per agent so a crowd does not pulse in unison.
        const offset = Math.abs(this._hash(`${this.agent?.id || ''}:mood-mote`)) % period;
        const beat = Math.floor((Date.now() + offset) / period);
        if (beat === this._moodMoteBeat) return;
        this._moodMoteBeat = beat;
        particleSystem.spawn(preset, this.x, this._headTopY() + dy, 1, { sortY: this._depthSortY ?? this.y });
    }

    // #34 — token-flow motes. While the villager is WORKING and parked, recent
    // token burn (delta of the same total LandmarkActivity._observeTokens reads)
    // becomes ambient visible life: tiny motes rise off the chest and drift
    // toward the bound building's centre, denser when the burn is hot. The
    // building palette picks the mote — beacon-gold for command/observatory/
    // portal/watchtower, parchment-green archive motes elsewhere. Pulse band:
    // these claim the `medium` particle-emission budget alongside the mood/ritual
    // motes (mutually exclusive sources, gated below). Reduced motion (motionScale
    // 0) or any in-motion/chat/ritual state emits nothing.
    _advanceTokenFlowMotes(particleSystem, frameScale = 1) {
        // Decay the burn accumulator every frame so a burst fades over ~3 s.
        this._tokenFlowBurn *= Math.pow(0.985, Math.max(0, frameScale));
        if (this._tokenFlowBurn < 0.01) this._tokenFlowBurn = 0;

        // Fold this frame's token delta into the accumulator regardless of draw
        // gating, so the burn rate reflects real work even mid-walk.
        const total = this._tokenFlowTotalNow();
        if (this._tokenFlowTotal != null && total > this._tokenFlowTotal) {
            this._tokenFlowBurn = Math.min(1, this._tokenFlowBurn + (total - this._tokenFlowTotal) / 6000);
        }
        this._tokenFlowTotal = total;

        if (!particleSystem || this.motionScale <= 0) return;
        if (this.agent?.status !== AgentStatus.WORKING || this.moving || this.chatting) return;
        // Defer to the building work-gesture / mood beats so one mote source
        // leads; token motes fill the quiet stretches between gestures.
        if (this._toolRitual?.pose && this._toolRitual.phase !== 'fading') return;
        if (this._tokenFlowBurn <= 0.04) return;

        // Cadence shortens as burn rises (~620 ms hot → ~1500 ms cool); stagger
        // per agent so a busy crowd does not pulse in unison.
        const period = 1500 - Math.round(this._clamp(this._tokenFlowBurn, 0, 1) * 880);
        const offset = Math.abs(this._hash(`${this.agent?.id || ''}:token-flow`)) % period;
        const beat = Math.floor((Date.now() + offset) / period);
        if (beat === this._tokenFlowBeat) return;
        this._tokenFlowBeat = beat;

        const type = String(this._lastBuildingType || '').toLowerCase();
        const beacon = type === 'command' || type === 'observatory' || type === 'portal' || type === 'watchtower';
        const preset = beacon ? 'beaconMote' : 'archiveMote';

        // Drift toward the bound building centre (world space). The mote rises
        // off the chest, so bias velocity along the chest→building vector.
        const originX = this.x;
        const originY = this._headTopY() + 18;
        let driftX = 0;
        let driftY = -0.18; // gentle default rise when the building is unknown
        const center = this._tokenFlowBuildingCenter();
        if (center) {
            const dvx = center.x - originX;
            const dvy = center.y - originY;
            const mag = Math.hypot(dvx, dvy);
            if (mag > 1) {
                driftX = (dvx / mag) * 0.28;
                driftY = (dvy / mag) * 0.28;
            }
        }

        const count = this._tokenFlowBurn > 0.5 ? 2 : 1;
        particleSystem.spawn(preset, originX, originY, count, {
            spread: 4,
            windX: driftX,
            driftY,
            sortY: this._depthSortY ?? this.y,
        });
    }

    _tokenFlowTotalNow() {
        const tokens = this.agent?.tokens || {};
        const input = Number(tokens.input ?? tokens.totalInput ?? 0) || 0;
        const output = Number(tokens.output ?? tokens.totalOutput ?? 0) || 0;
        const cacheRead = Number(tokens.cacheRead ?? 0) || 0;
        const cacheCreate = Number(tokens.cacheCreate ?? tokens.cacheWrite ?? 0) || 0;
        return input + output + cacheRead + cacheCreate;
    }

    _tokenFlowBuildingCenter() {
        const building = this._buildingForType(this._lastBuildingType);
        const point = this._buildingFacingPoint(building);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        const world = tileToWorld(point.x, point.y);
        return Number.isFinite(world?.x) && Number.isFinite(world?.y) ? world : null;
    }

    // #40 — fire one relief spark when the villager leaves the storm state
    // (ERRORED/RATE_LIMITED → recovered). The straighten is carried by the bob
    // (distress drop releases as the status changes); this adds a single rising
    // green-gold burst at the head. Reduced motion (motionScale 0) spawns
    // nothing — the upright static posture is the recovery cue on its own.
    _advanceDistressRecovery(particleSystem) {
        const storming = this._isStorming();
        if (this._stormingLast && !storming && this.motionScale > 0 && particleSystem) {
            this._reliefSparkAt = Date.now();
            particleSystem.spawn('distressRelief', this.x, this._headTopY() + 8, 7, { sortY: this._depthSortY ?? this.y });
        }
        this._stormingLast = storming;
    }

    // Tool ritual pose overlay driven by RitualConductor: a small procedural
    // work gesture at hand/tool height — hammer-tick at the forge, page-turn at
    // the archive, pick-swing at the mine, scroll-unfurl at the taskboard, plus
    // a gaze (observatory), conjure (portal), signal (command), haul (harbor),
    // and scan (watchtower). No new image assets; reduced motion renders each
    // gesture as a single static frame (no swing offset, no work beat).
    _drawToolRitualOverlay(ctx, frameGeometry) {
        const ritual = this._toolRitual;
        if (this.observation?.state === 'stale' || !ritual?.pose || this.chatting || this.moving) return;
        const { dx, dy, bounds, drawScale } = frameGeometry || {};
        if (!bounds || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
        const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
        const centerX = dx + (bounds.minX + bounds.maxX) * drawScale / 2;
        const handY = dy + (bounds.minY + contentHeight * 0.62) * drawScale;
        const headY = dy + (bounds.minY + contentHeight * 0.18) * drawScale;
        const directionKey = DIRECTIONS[this.direction] || 's';
        const sideSign = ['sw', 'w', 'nw', 'n'].includes(directionKey) ? -1 : 1;
        const animated = this.motionScale > 0 && ritual.motionEnabled !== false;
        const period = RITUAL_GESTURE_PERIOD_MS[ritual.pose] || 700;
        // Triangle 0..1..0 over the gesture cycle drives the swing/lift amount;
        // static variant pins the gesture at its rest (0).
        const phase = animated ? (Date.now() % period) / period : 0;
        const swing = animated ? (phase < 0.5 ? phase * 2 : (1 - phase) * 2) : 0;
        // 3.3 — the gesture marks are procedural 2-6px props; scale the whole
        // gesture group by the body's drawScale so the mark keeps its
        // proportion to the villager instead of vanishing next to it. Static
        // poses (reduced motion) scale identically.
        const gestureScale = Math.max(1, Number(drawScale) || 1);
        ctx.save();
        if (ritual.phase === 'fading') ctx.globalAlpha *= 0.5;
        switch (ritual.pose) {
            case 'hammer':
                this._drawGestureScaled(ctx, centerX, handY, gestureScale, () => this._drawHammerGesture(ctx, 0, 0, sideSign, swing));
                break;
            case 'page':
                this._drawGestureScaled(ctx, centerX, handY, gestureScale, () => this._drawPageGesture(ctx, 0, 0, animated, phase));
                break;
            case 'pick':
                this._drawGestureScaled(ctx, centerX, handY, gestureScale, () => this._drawPickGesture(ctx, 0, 0, sideSign, swing));
                break;
            case 'scroll':
                this._drawGestureScaled(ctx, centerX, handY, gestureScale, () => this._drawScrollGesture(ctx, 0, 0, swing));
                break;
            case 'gaze':
                this._drawGestureScaled(ctx, centerX, headY, gestureScale, () => this._drawGazeGesture(ctx, 0, 0, sideSign, swing));
                break;
            case 'conjure':
                this._drawGestureScaled(ctx, centerX, handY, gestureScale, () => this._drawConjureGesture(ctx, 0, 0, swing));
                break;
            case 'signal':
                this._drawGestureScaled(ctx, centerX, headY, gestureScale, () => this._drawSignalGesture(ctx, 0, 0, sideSign, swing));
                break;
            case 'haul':
                this._drawGestureScaled(ctx, centerX, handY, gestureScale, () => this._drawHaulGesture(ctx, 0, 0, swing));
                break;
            case 'scan':
                this._drawGestureScaled(ctx, centerX, headY, gestureScale, () => this._drawScanGesture(ctx, 0, 0, sideSign, swing));
                break;
        }
        // 6.6 — the Minor-tier work beat lands on the gesture's strike (every
        // third one); the static pose under reduced motion strikes nothing.
        if (animated) {
            const atHead = ritual.pose === 'gaze' || ritual.pose === 'signal' || ritual.pose === 'scan';
            drawWorkDownbeat(ctx, ritual, Math.round(centerX), Math.round(atHead ? headY : handY), {
                side: sideSign,
                scale: gestureScale,
            });
        }
        ctx.restore();
    }

    // Static secondary evidence; execution status and primary marks are untouched.
    _drawObservationSeal(ctx) {
        if (this.observation?.state !== 'stale' || this.staleGrouped) return;
        const emphasized = this.selected || this.hovered;
        const gate = getActiveMarkGovernor()?.admit(emphasized ? MarkTier.PRIMARY : MarkTier.SECONDARY, this.x, this.y);
        if (gate && !gate.draw) return;
        ctx.save();
        const box = this._bodyBox || DEFAULT_BODY_BOX;
        ctx.translate(this._placeX + box.right + 6, this._placeY + box.top + 12);
        ctx.scale(1 / (this._zoom || 1), 1 / (this._zoom || 1));
        ctx.globalAlpha *= gate?.alpha ?? 1;
        drawEventShape(ctx, 'stale-seal', -8, -8, 1, '#d4c9ae');
        if (emphasized) {
            const second = Math.floor(Date.now() / 1000);
            if (this._observationSecond !== second) {
                this._observationSecond = second;
                const at = this.observation.observedAt;
                this._observationLabel = at === null ? 'Last observed time unknown' : `Last observed ${Math.max(0, second - Math.floor(at / 1000))}s ago`;
            }
            ctx.font = WORLD_BODY_FONT_11;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(this._observationLabel, 12, 0);
        }
        ctx.restore();
    }

    // Static elapsed evidence on the common Canvas/GPU overlay; epoch-second
    // bucketing shares the UI cadence without allocating a per-agent timer.
    _drawTurnSand(ctx) {
        const now = Date.now();
        const second = Math.floor(now / 1000);
        if (this._turnSandSecond !== second) {
            this._turnSandSecond = second;
            const start = this.agent?.turnStartedAt;
            const stale = this.observation?.state === 'stale';
            if (stale && this._turnFrozenAt == null) this._turnFrozenAt = this.observation.observedAt ?? now;
            const observedNow = stale ? this._turnFrozenAt : now;
            const completed = this.agent?.turnState === 'completed' || this.agent?.status === AgentStatus.COMPLETED;
            this._turnSandAge = Number.isFinite(start) && !completed ? Math.max(0, observedNow - start) : null;
            const duration = this.agent?.lastTurnDurationMs;
            if (completed && Number.isFinite(duration) && duration >= 0 && this._lastTurnShownAt == null) this._lastTurnShownAt = now;
            const last = completed && Number.isFinite(duration) && duration >= 0 && now - this._lastTurnShownAt < 10000;
            const elapsed = last ? duration : this._turnSandAge;
            const seconds = Math.floor((elapsed ?? 0) / 1000);
            this._turnSandText = elapsed === null ? null : `${last ? 'Last turn ' : ''}${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ''}${seconds % 60}s`;
        }
        if (!this._turnSandText) return;
        const emphasized = this.selected || this.hovered;
        const LONG_TURN_MS = 5 * 60 * 1000;
        if (!emphasized && !(this._turnSandAge >= LONG_TURN_MS)) return;
        const gate = getActiveMarkGovernor()?.admit(emphasized ? MarkTier.PRIMARY : MarkTier.SECONDARY, this.x, this.y);
        if (gate && !gate.draw) return;
        ctx.save();
        const box = this._bodyBox || DEFAULT_BODY_BOX;
        ctx.translate(this._placeX + box.right + 8, this._placeY + box.bottom - 14);
        ctx.scale(1 / (this._zoom || 1), 1 / (this._zoom || 1));
        ctx.fillStyle = '#e7d3a0';
        if (emphasized) {
            drawEventShape(ctx, 'turn-sand', -8, -8, 1, '#e7d3a0');
            ctx.font = WORLD_BODY_FONT_11;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(this._turnSandText, 10, 0);
        } else ctx.fillRect(-2, -3, 2, 6);
        ctx.restore();
    }

    // Shared medium-distance action vocabulary for the Claude and Codex hero
    // families. Static geometry carries the meaning; the optional two-frame
    // lift uses the medium pulse band and freezes under reduced motion.
    _drawActionPoseOverlay(ctx, frameGeometry) {
        this._drawObservationSeal(ctx);
        this._drawTurnSand(ctx);
        const poseGroup = this._poseCell?.source === 'strip' ? this._poseCell.group : null;
        // 2.3 — the authored palm holds the wait subtype; nothing else may
        // occupy the prop slot while the village is waiting for its operator.
        if (poseGroup === 'wait' || this._sealedSlipUntil > Date.now()) {
            this._drawWaitReasonProp(ctx, frameGeometry);
            return;
        }
        const provider = this._providerKey();
        if (!['claude', 'codex'].includes(provider) || this.moving) return;
        const action = resolveAgentAction(this.agent, { chatting: this.chatting });
        if (!action) return;
        // SM-7 — one chip per body: a chatting body already wears the message
        // bubble over its head, so the TALK scroll prop would be a second one.
        // A muted chatter (decision focus elsewhere) shows the prop instead,
        // unless its partner, standing against it, still wears the bubble:
        // the overlapping pair would read as one body with two chips. When
        // both are muted, only the lower id of the pair keeps the prop.
        if (action === AgentAction.TALK && this.chatting) {
            if (!this.decisionFocusMuted) return;
            const partner = this.chatPartner;
            if (partner?.chatting && !partner.decisionFocusMuted) return;
            if (partner?.chatting && String(partner.agent?.id) < String(this.agent?.id)) return;
        }
        // 2.2 — the authored body already holds the book: one instrument per
        // fact, so the procedural read prop is removed for strip characters.
        if (poseGroup === 'read' && action === AgentAction.READ) return;
        const { dx, dy, bounds, drawScale } = frameGeometry || {};
        if (!bounds || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const width = Math.max(1, bounds.maxX - bounds.minX);
        const height = Math.max(1, bounds.maxY - bounds.minY);
        const x = dx + (bounds.minX + width * .72) * drawScale;
        const y = dy + (bounds.minY + height * .42) * drawScale;
        const scale = Math.max(1, Number(drawScale) || 1);
        const animated = this.motionScale > 0 && this.observation?.state !== 'stale';
        const beat = animated ? Math.floor(Date.now() / 320) % 2 : 0;
        const trim = this._providerTrimColor();
        ctx.save();
        ctx.translate(Math.round(x), Math.round(y - beat));
        ctx.scale(scale, scale);
        ctx.fillStyle = trim;
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1;
        if (action === AgentAction.READ) {
            ctx.fillStyle = '#f0e6c8'; ctx.fillRect(-5, -2, 4, 5); ctx.fillRect(1, -2, 4, 5);
            ctx.fillStyle = trim; ctx.fillRect(0, -2, 1, 5); ctx.fillRect(-4, -1, 2, 1); ctx.fillRect(2, -1, 2, 1);
        } else if (action === AgentAction.WORK) {
            ctx.fillRect(-4, -1, 8, 2); ctx.fillRect(2, -4, 2, 8); ctx.fillStyle = THEME.text; ctx.fillRect(-5, -3, 2, 2);
        } else if (action === AgentAction.THINK) {
            ctx.fillRect(-3, 2, 2, 2); ctx.fillRect(0, -1, 3, 3); ctx.fillRect(3, -5, 4, 4);
        } else if (action === AgentAction.TALK) {
            drawEventShape(ctx, 'message-scroll', -8, -8, 1, trim);
        } else if (action === AgentAction.CELEBRATE) {
            drawEventShape(ctx, 'release-crown', -8, -8, 1, THEME.text);
        }
        ctx.restore();
    }

    // 2.3 — what the held palm is holding, from `agent.waitReason` alone:
    // an open letter (question), a closed command slip still awaiting its seal
    // (approval), or an unrolled plan (plan_review). Never inferred from
    // elapsed time, and an unknown reason draws nothing so the generic
    // needs-you mark stays the only claim. Static band throughout.
    _drawWaitReasonProp(ctx, frameGeometry) {
        const sealed = this._sealedSlipUntil > Date.now();
        const reason = sealed ? 'approval' : this.agent?.waitReason;
        if (!['question', 'approval', 'plan_review'].includes(reason)) return;
        const { dx, dy, bounds, drawScale } = frameGeometry || {};
        if (!bounds || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const width = Math.max(1, bounds.maxX - bounds.minX);
        const height = Math.max(1, bounds.maxY - bounds.minY);
        const scale = Math.max(1, Number(drawScale) || 1);
        ctx.save();
        ctx.translate(
            Math.round(dx + (bounds.minX + width * 0.74) * drawScale),
            Math.round(dy + (bounds.minY + height * 0.5) * drawScale),
        );
        ctx.scale(scale, scale);
        if (reason === 'question') {
            // Open letter: an unfolded sheet, its fold still creased.
            ctx.fillStyle = '#f4ead0'; ctx.fillRect(-5, -4, 10, 8);
            ctx.fillStyle = '#3a2c1c'; ctx.fillRect(-5, -4, 10, 1);
            ctx.fillRect(-4, -3, 3, 1); ctx.fillRect(1, -3, 3, 1);
            ctx.fillRect(-3, 0, 6, 1); ctx.fillRect(-3, 2, 4, 1);
        } else if (reason === 'approval') {
            // Closed command slip. The wax ring stays open until a resolving
            // lifecycle event is observed; a pending wait is never sealed.
            ctx.fillStyle = '#e6d7ae'; ctx.fillRect(-5, -3, 10, 6);
            ctx.fillStyle = '#3a2c1c'; ctx.fillRect(-5, -3, 10, 1); ctx.fillRect(-5, 2, 10, 1);
            ctx.fillStyle = sealed ? '#c2413a' : '#8a5a52';
            if (sealed) {
                ctx.fillRect(1, -2, 4, 4);
            } else {
                ctx.fillRect(1, -2, 4, 1); ctx.fillRect(1, 1, 4, 1);
                ctx.fillRect(1, -1, 1, 2); ctx.fillRect(4, -1, 1, 2);
            }
        } else {
            // Unrolled plan: a wide sheet with ruled lines and curled ends.
            ctx.fillStyle = '#f0e6c8'; ctx.fillRect(-7, -4, 14, 8);
            ctx.fillStyle = '#6b4a2a'; ctx.fillRect(-8, -4, 1, 8); ctx.fillRect(7, -4, 1, 8);
            ctx.fillStyle = '#3a2c1c';
            ctx.fillRect(-5, -2, 10, 1); ctx.fillRect(-5, 0, 8, 1); ctx.fillRect(-5, 2, 6, 1);
        }
        ctx.restore();
    }

    // 3.3 — pixel-snapped origin + uniform scale around one gesture mark.
    _drawGestureScaled(ctx, x, y, scale, drawFn) {
        ctx.save();
        ctx.translate(Math.round(x), Math.round(y));
        ctx.scale(scale, scale);
        drawFn();
        ctx.restore();
    }

    // Forge: a hammer head that lifts and strikes down on the downbeat.
    _drawHammerGesture(ctx, x, y, sideSign, swing) {
        const bx = Math.round(x + sideSign * 3);
        const lift = Math.round(swing * 5);
        ctx.fillStyle = '#6b4a2a';
        ctx.fillRect(bx - 1, y - 6 - lift, 2, 6);
        ctx.fillStyle = '#9aa3ad';
        ctx.fillRect(bx + sideSign * 1 - 2, y - 8 - lift, 4, 3);
        if (swing > 0.9) {
            ctx.fillStyle = '#fff3a3';
            ctx.fillRect(bx + sideSign * 1 - 1, y - 5, 2, 2);
        }
    }

    // Archive: two pages with a turning leaf sweeping across the open book.
    _drawPageGesture(ctx, x, y, animated, phase) {
        const bx = Math.round(x);
        const by = Math.round(y);
        ctx.fillStyle = '#3a2c1c';
        ctx.fillRect(bx - 4, by - 3, 8, 4);
        ctx.fillStyle = '#f0e6c8';
        ctx.fillRect(bx - 3, by - 3, 3, 3);
        ctx.fillRect(bx + 1, by - 3, 3, 3);
        // Turning leaf slides from right page to left across the cycle.
        const leafX = animated ? Math.round(bx + 3 - phase * 6) : bx - 2;
        ctx.fillStyle = '#fffbe9';
        ctx.fillRect(leafX, by - 3, 1, 3);
    }

    // Mine: a pickaxe arcing up then chipping down on the downbeat.
    _drawPickGesture(ctx, x, y, sideSign, swing) {
        const bx = Math.round(x + sideSign * 2);
        const lift = Math.round(swing * 4);
        ctx.fillStyle = '#5a4326';
        ctx.fillRect(bx - 1, y - 6 - lift, 2, 6);
        ctx.fillStyle = '#8a8f96';
        ctx.fillRect(bx - 3, y - 7 - lift, 6, 1);
        if (swing > 0.9) {
            ctx.fillStyle = '#ffec99';
            ctx.fillRect(bx - 1, y - 1, 2, 1);
        }
    }

    // Taskboard: a scroll that unfurls (grows) toward the downbeat.
    _drawScrollGesture(ctx, x, y, swing) {
        const bx = Math.round(x);
        const by = Math.round(y);
        const open = 2 + Math.round(swing * 4);
        ctx.fillStyle = '#caa54a';
        ctx.fillRect(bx - 4, by - 2, 1, 4);
        ctx.fillRect(bx + 3, by - 2, 1, 4);
        ctx.fillStyle = '#f0e6c8';
        ctx.fillRect(bx - 3, by - open / 2, 6, open);
    }

    // Observatory: a spyglass held to the eye, lens glinting on the downbeat.
    _drawGazeGesture(ctx, x, y, sideSign, swing) {
        const bx = Math.round(x + sideSign * 2);
        const by = Math.round(y + 2);
        ctx.fillStyle = '#2b2030';
        ctx.fillRect(bx, by, sideSign * 6, 2);
        ctx.fillStyle = swing > 0.85 ? '#fff1a8' : '#8feaff';
        ctx.fillRect(bx + sideSign * 6 - (sideSign < 0 ? 1 : 0), by, 1, 2);
    }

    // Portal: a rune ring conjured, brightening on the downbeat.
    _drawConjureGesture(ctx, x, y, swing) {
        const bx = Math.round(x);
        const by = Math.round(y - 2);
        const r = 2 + swing * 2;
        ctx.globalAlpha *= 0.4 + swing * 0.6;
        ctx.strokeStyle = '#9feaff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Command: a small banner waving side to side.
    _drawSignalGesture(ctx, x, y, sideSign, swing) {
        const bx = Math.round(x + sideSign * 2);
        const by = Math.round(y);
        ctx.fillStyle = '#6b4a2a';
        ctx.fillRect(bx, by - 5, 1, 6);
        ctx.fillStyle = '#f2d36b';
        const wave = Math.round((swing - 0.5) * 2 * sideSign);
        ctx.fillRect(bx + sideSign, by - 5, sideSign * 4 + wave, 3);
    }

    // Harbor: a crate lifted on the downbeat, set down between beats.
    _drawHaulGesture(ctx, x, y, swing) {
        const bx = Math.round(x);
        const lift = Math.round(swing * 4);
        ctx.fillStyle = '#7a5a32';
        ctx.fillRect(bx - 3, y - 4 - lift, 6, 5);
        ctx.fillStyle = '#5a4326';
        ctx.fillRect(bx - 3, y - 2 - lift, 6, 1);
    }

    // Watchtower: a hand raised to shade the eyes, scanning the horizon.
    _drawScanGesture(ctx, x, y, sideSign, swing) {
        const bx = Math.round(x + sideSign * 1);
        const by = Math.round(y + 1);
        ctx.fillStyle = '#f2d36b';
        ctx.fillRect(bx, by - 1, sideSign * 4, 2);
        if (swing > 0.85) {
            ctx.fillStyle = '#fff2a3';
            ctx.fillRect(bx + sideSign * 4, by - 2, 1, 1);
        }
    }

    // One pixel stamp for both impostors: a snapped contact shadow, the
    // provider diamond with a 1 px dark outline, the agent signature, and the
    // status cell on the apex as the topmost mark. fillRect only — no arcs,
    // no strokes, nothing anti-aliased.
    _paintImpostorStamp(ctx, { provider, statusColor, signature, accent }) {
        fillPixelEllipse(ctx, 0, 3, 7, 2, 'rgba(7, 10, 12, 0.5)');
        ctx.fillStyle = IMPOSTOR_OUTLINE;
        ctx.fillRect(-1, IMPOSTOR_TOP - 1, 2, 1);
        IMPOSTOR_HALF_WIDTHS.forEach((half, index) => {
            ctx.fillRect(-half - 1, IMPOSTOR_TOP + index, (half + 1) * 2, 1);
        });
        ctx.fillRect(-1, IMPOSTOR_TOP + IMPOSTOR_HALF_WIDTHS.length, 2, 1);
        ctx.fillStyle = provider;
        IMPOSTOR_HALF_WIDTHS.forEach((half, index) => {
            ctx.fillRect(-half, IMPOSTOR_TOP + index, half * 2, 1);
        });
        drawAgentSignature(ctx, signature, { x: 0, y: -7, pixel: 1, accent });
        ctx.fillStyle = IMPOSTOR_OUTLINE;
        ctx.fillRect(-3, IMPOSTOR_TOP - 5, 6, 6);
        ctx.fillStyle = statusColor;
        ctx.fillRect(-2, IMPOSTOR_TOP - 4, 4, 4);
    }

    _impostorStampArgs() {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        return {
            trim,
            provider: this._providerAccentColor(),
            statusColor: visual?.color || trim,
            signature: this.signature(),
            accent: this.signatureAccent(),
        };
    }

    // Overview (zoom < 1): no body is drawn and world texels are smaller than
    // screen pixels, so the token is stamped screen-fixed in whole screen
    // pixels at the feet — minifying it would blur every edge.
    _drawLowZoomImpostor(ctx, zoom = 1) {
        const args = this._impostorStampArgs();
        const z = zoom > 0 ? zoom : 1;
        ctx.save();
        ctx.translate(this._placeX, this._placeY);
        ctx.scale(1 / z, 1 / z);
        snapScreenOrigin(ctx);
        const paint = (target) => this._paintImpostorStamp(target, args);
        if (this.gpuWorldEnabled) {
            const key = `impostor-low-zoom|${args.provider}|${args.trim}|${args.signature.key}|${args.accent}|${args.statusColor}`;
            this._drawOverlayStamp(ctx, key, IMPOSTOR_BOX.left, IMPOSTOR_BOX.top, IMPOSTOR_BOX.width, IMPOSTOR_BOX.height, paint);
        } else {
            paint(ctx);
        }
        ctx.restore();
    }

    // Crowd pressure (budget mode): world-scaled on the texel grid beside
    // the 0.5× LOD bodies, so integer zoom tiers land it on whole pixels.
    _drawBudgetImpostor(ctx) {
        const args = this._impostorStampArgs();
        ctx.save();
        ctx.translate(this._placeX, this._placeY);
        const paint = (target) => this._paintImpostorStamp(target, args);
        if (this.gpuWorldEnabled) {
            const key = `impostor-budget|${args.provider}|${args.trim}|${args.signature.key}|${args.accent}|${args.statusColor}`;
            this._drawOverlayStamp(ctx, key, IMPOSTOR_BOX.left, IMPOSTOR_BOX.top, IMPOSTOR_BOX.width, IMPOSTOR_BOX.height, paint);
        } else {
            paint(ctx);
        }
        ctx.restore();
    }

    _providerTrimColor(agent = this.agent) {
        const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
        return identity.trim?.[0] || PROVIDER_TRIM[this._providerKey(agent)] || PROVIDER_TRIM.default;
    }

    _providerAccentColor(agent = this.agent) {
        return PROVIDER_BADGE_COLORS[this._providerKey(agent)] || PROVIDER_BADGE_COLORS.default;
    }

    _rgba(color, alpha) {
        if (color.startsWith('#') && color.length === 7) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        return color;
    }

    // Plan 2.1 — the hit box is the 1:1 body actually drawn (plus a small
    // pad and the contact shadow under the feet), so a click lands on the
    // villager, not on the air where the old 1.65x giant used to stand.
    hitTest(screenX, screenY) {
        if (this.isArrivalPending()) return false;
        const box = this._bodyBox || DEFAULT_BODY_BOX;
        // V7 — test against the placement the body is drawn at (bridge lift
        // included), recomputed from the current position.
        const moving = bodyPlacementMoving(this);
        const zoom = this._zoom || 1;
        const dx = screenX - snapBodyPx(this.x, moving, zoom, this._placeDpr || 1);
        const dy = screenY - snapBodyPx(this.y - this._currentBridgeLift(), moving, zoom, this._placeDpr || 1);
        return dx > box.left - HIT_PAD && dx < box.right + HIT_PAD
            && dy > box.top - HIT_PAD && dy < Math.max(box.bottom, 4) + HIT_PAD;
    }
}

function providerMoteColor(agent) {
    const provider = String(agent?.provider || '').toLowerCase();
    const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
    if (identity.trim?.[0]) return identity.trim[0];
    return PROVIDER_TRIM[provider] || PROVIDER_TRIM.default;
}

// 6.3 — familiar motes wear their provider family's shape (mage rune, engineer
// chip, oracle orb, lunar crescent, ranger arrow, cosmic star, monk hex) so a
// parent's orbiting children read as little familiars, not identical dots.
const FAMILIAR_MOTE_SHAPES = Object.freeze({
    claude: 'rune',
    codex: 'chip',
    gemini: 'orb',
    kimi: 'crescent',
    deepseek: 'arrow',
    grok: 'star',
    zai: 'hex',
});

function providerMoteShape(agent) {
    const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
    if (identity.family && FAMILIAR_MOTE_SHAPES[identity.family]) {
        return FAMILIAR_MOTE_SHAPES[identity.family];
    }
    return FAMILIAR_MOTE_SHAPES[String(agent?.provider || '').toLowerCase()] || 'dot';
}

// One provider-family mote glyph. All shapes are static geometry; the orbit
// itself already freezes under reduced motion.
function drawFamiliarMoteShape(ctx, shape, x, y, r) {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const rr = Math.max(2, Math.round(r));
    ctx.beginPath();
    switch (shape) {
        case 'rune':
            ctx.moveTo(cx, cy - rr);
            ctx.lineTo(cx + Math.round(rr * 0.7), cy);
            ctx.lineTo(cx, cy + rr);
            ctx.lineTo(cx - Math.round(rr * 0.7), cy);
            ctx.closePath();
            ctx.fill();
            return;
        case 'chip':
            ctx.fillRect(cx - Math.round(rr * 0.8), cy - Math.round(rr * 0.8), Math.round(rr * 1.6), Math.round(rr * 1.6));
            return;
        case 'orb':
            ctx.strokeStyle = ctx.fillStyle;
            ctx.lineWidth = 1.2;
            ctx.arc(cx, cy, Math.max(1.5, rr - 1), 0, Math.PI * 2);
            ctx.stroke();
            return;
        case 'crescent':
            ctx.arc(cx, cy, rr, Math.PI * 0.25, Math.PI * 1.75);
            ctx.arc(cx + Math.round(rr * 0.4), cy, Math.max(1, Math.round(rr * 0.75)), Math.PI * 1.75, Math.PI * 0.25, true);
            ctx.closePath();
            ctx.fill();
            return;
        case 'arrow':
            ctx.moveTo(cx, cy - rr);
            ctx.lineTo(cx + Math.round(rr * 0.8), cy + Math.round(rr * 0.7));
            ctx.lineTo(cx - Math.round(rr * 0.8), cy + Math.round(rr * 0.7));
            ctx.closePath();
            ctx.fill();
            return;
        case 'star':
            ctx.fillRect(cx - 1, cy - rr, 2, rr * 2);
            ctx.fillRect(cx - rr, cy - 1, rr * 2, 2);
            return;
        case 'hex':
            ctx.moveTo(cx, cy - rr);
            ctx.lineTo(cx - Math.round(rr * 0.87), cy - Math.round(rr * 0.5));
            ctx.lineTo(cx - Math.round(rr * 0.87), cy + Math.round(rr * 0.5));
            ctx.lineTo(cx, cy + rr);
            ctx.lineTo(cx + Math.round(rr * 0.87), cy + Math.round(rr * 0.5));
            ctx.lineTo(cx + Math.round(rr * 0.87), cy - Math.round(rr * 0.5));
            ctx.closePath();
            ctx.fill();
            return;
        default:
            ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            ctx.fill();
    }
}

function hashPhase(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return (hash >>> 0) / 4294967295;
}

function familiarMoteEntries({
    parentSprite,
    childSprites = [],
    childAgents = [],
    now = performance.now(),
    motionScale = 1,
    maxVisible = MAX_VISIBLE_FAMILIAR_MOTES,
} = {}) {
    if (!parentSprite) return { entries: [], hiddenCount: 0 };
    const children = [...childSprites, ...childAgents]
        .filter(Boolean)
        .slice(0, Math.max(0, maxVisible));
    const hiddenCount = Math.max(0, childSprites.length + childAgents.length - children.length);
    const motion = motionScale === 0 ? 0 : 1;
    const entries = children.map((child, i) => {
        const agent = child.agent || child;
        const base = hashPhase(agent?.id || i);
        // 6.3 — persona-shaped orbit: each familiar keeps its own altitude,
        // eccentricity, pace, and size, all seeded from its id (the motion
        // claim is unchanged: one shared medium orbit, frozen under RM).
        const persona = hashPhase(`${agent?.id || i}:persona`);
        const orbitRx = 15 + persona * 6;
        const orbitRy = 5.5 + hashPhase(`${agent?.id || i}:bob`) * 3;
        const baseY = -46 - hashPhase(`${agent?.id || i}:alt`) * 8;
        const pace = 0.75 + persona * 0.5;
        const staticAngle = (Math.PI * 2 * i) / Math.max(1, children.length);
        const angle = motion
            ? staticAngle + base * Math.PI * 2 + (now / 900) * pace * (i % 2 ? -1 : 1)
            : staticAngle;
        const orbitX = Math.cos(angle) * orbitRx;
        const orbitY = baseY + Math.sin(angle) * orbitRy;
        return {
            agent,
            index: i,
            x: parentSprite.x + orbitX,
            y: parentSprite.y + orbitY,
            orbitX,
            orbitY,
            radius: 3.6 + persona * 1.6,
            color: providerMoteColor(agent),
            shape: providerMoteShape(agent),
        };
    });
    return { entries, hiddenCount };
}

export function familiarMoteLightSources({
    parentSprite,
    childSprites = [],
    childAgents = [],
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    maxVisible = MAX_VISIBLE_FAMILIAR_MOTES,
} = {}) {
    const { entries } = familiarMoteEntries({
        parentSprite,
        childSprites,
        childAgents,
        now,
        motionScale,
        maxVisible,
    });
    const boost = lighting?.lightBoost ?? 1;
    return entries.map(entry => ({
        id: `familiar:${parentSprite?.agent?.id || 'parent'}:${entry.agent?.id || entry.index}`,
        kind: 'spark',
        x: entry.x,
        y: entry.y,
        color: entry.color,
        radius: 24,
        alpha: 0.18,
        intensity: 0.18 * boost,
    }));
}

export function drawFamiliarMotes(ctx, {
    parentSprite,
    childSprites = [],
    childAgents = [],
    zoom = 1,
    now = performance.now(),
    motionScale = 1,
    lighting = null,
    maxVisible = MAX_VISIBLE_FAMILIAR_MOTES,
} = {}) {
    if (!ctx || !parentSprite) return;
    const { entries, hiddenCount } = familiarMoteEntries({
        parentSprite,
        childSprites,
        childAgents,
        now,
        motionScale,
        maxVisible,
    });
    if (!entries.length && hiddenCount <= 0) return;

    const lightBoost = lighting?.lightBoost ?? 1;
    const selectedBoost = parentSprite.selected ? 1.4 : 1;
    const scale = 1 / (zoom || 1);

    ctx.save();
    ctx.translate(parentSprite.x, parentSprite.y);
    ctx.scale(scale, scale);

    for (const entry of entries) {
        const { orbitX, orbitY, radius, color, shape } = entry;
        const alpha = Math.min(1, 0.58 * lightBoost * selectedBoost);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = parentSprite._rgba?.(color, 0.30) || color;
        ctx.beginPath();
        ctx.arc(orbitX, orbitY, radius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, alpha + 0.18);
        ctx.fillStyle = color;
        // 6.3 — provider-family glyph replaces the identical-dot core.
        drawFamiliarMoteShape(ctx, shape, orbitX, orbitY, radius);
        ctx.globalAlpha = Math.min(1, alpha + 0.30);
        ctx.fillStyle = '#fff3bf';
        ctx.fillRect(Math.round(orbitX - 1), Math.round(orbitY - radius + 1), 2, 2);
    }

    if (hiddenCount > 0) {
        ctx.globalAlpha = parentSprite.selected ? 0.98 : 0.82;
        ctx.fillStyle = 'rgba(20, 14, 10, 0.88)';
        ctx.strokeStyle = '#f6cf60';
        ctx.lineWidth = 1;
        const x = 18;
        const y = -38;
        const w = 6 + String(hiddenCount).length * 8 + 8;
        ctx.fillRect(x - w / 2, y - 7, w, 13);
        ctx.strokeRect(x - w / 2 + 0.5, y - 6.5, w - 1, 12);
        ctx.fillStyle = '#f8ead1';
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${hiddenCount}`, x, y);
    }

    ctx.restore();
}
