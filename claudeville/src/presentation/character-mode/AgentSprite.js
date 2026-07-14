import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { BUILDING_DEFS, normalizeBuildingType } from '../../config/buildings.js';
import { THEME, STATUS_VISUALS, MOOD_ACCENTS, MODEL_TIER_COLORS, PROVIDER_HUES } from '../../config/theme.js';
import { getModelVisualIdentity } from '../shared/ModelVisualIdentity.js';
import { repoProfile } from '../shared/RepoColor.js';
import { getTeamColor } from '../shared/TeamColor.js';
import { resolveRoleAccessory } from '../shared/RoleAccessory.js';
import { SpriteSheet, dirFromVelocity, WALK_FRAMES, IDLE_FRAMES, DIRECTIONS } from './SpriteSheet.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { RITUAL_GESTURE_PERIOD_MS, SCENIC_POINT_POSTURE } from './RitualConductor.js';
import { pulseAlpha } from './PulsePolicy.js';
import { drawToolGlyphBadge, toolGlyphKey } from './ToolGlyphBadge.js';
import { Compositor } from './Compositor.js';
import { AgentBehaviorState } from './AgentBehaviorState.js';
import { compactToolInput, toolActionLabel, toolCategory, classifyTool } from '../../domain/services/ToolIdentity.js';
import { pickLoreLine } from '../../config/loreDialogue.js';
import { tileToWorld, worldToTile } from './Projection.js';

// Hit-test geometry (unchanged from vector version).
const SPRITE_HIT_HALF_WIDTH = 24;
const SPRITE_HIT_TOP = -72;
const SPRITE_HIT_BOTTOM = 24;
const WALK_PIXELS_PER_FRAME = 4.5;
const DIRECTION_HOLD_MS = 70;
const FOOTFALL_FRAMES = new Set([0, Math.floor(WALK_FRAMES / 2)]);
// Status visuals, mood tones, and model-tier crests now live in theme.js (#1
// House Palette) so World and Dashboard share one color authority.
const LORE_ACCENT_DEFAULT = '#d8c08a';
// #32 — arrival ceremony: a ~300ms scale-up "pop" with a portal-rune ring +
// dust-puff the instant a villager lands (the ArrivalDeparture approach
// finishes and setArrivalState flips pending → visible). Reduced motion skips
// the ceremony entirely (instant appear).
const ARRIVAL_CEREMONY_MS = 300;

function easeOutCubic(t) {
    const c = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - c, 3);
}
// #15 — one-shot particle fired on each building work-gesture downbeat. Offsets
// are relative to the agent anchor (feet at 0,0; the gesture prop sits near
// y -18). Presets are the shared ParticleSystem palette so each gesture lands a
// theme-matched mark (forge spark, archive mote, mine dust, …).
const RITUAL_GESTURE_PARTICLE = Object.freeze({
    hammer: { preset: 'forgeSpark', dx: 0, dy: -18, count: 3 },
    page: { preset: 'archiveMote', dx: 0, dy: -16, count: 2 },
    pick: { preset: 'mineDust', dx: 0, dy: -14, count: 3 },
    scroll: { preset: 'questPing', dx: 0, dy: -18, count: 2 },
    gaze: { preset: 'sparkle', dx: 0, dy: -22, count: 1 },
    conjure: { preset: 'portalRune', dx: 0, dy: -20, count: 2 },
    signal: { preset: 'beaconMote', dx: 0, dy: -24, count: 1 },
    haul: { preset: 'footstep', dx: 0, dy: -14, count: 3 },
    scan: { preset: 'beaconMote', dx: 0, dy: -24, count: 1 },
});
// 3.13 — congestion treatment: gait slowdown when the destination/current
// building is over visit capacity.
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
    opencode: 'portal',
    deepseek: 'observatory',
};
const TARGET_AGENT_CONTENT_HEIGHT = 92;
const MIN_AGENT_DRAW_SCALE = 1;
const MAX_AGENT_DRAW_SCALE = 1.25;
// A tool-driven head accessory must stay the dominant candidate this long
// before it replaces the committed one, so hats stop teleporting mid-stride.
const ACCESSORY_HYSTERESIS_MS = 20000;
const ACTION_TRAIL_LIMIT = 2;
const ACTIVITY_BUBBLE_TTL_MS = 12000;
const ACTION_TRAIL_TTL_MS = ACTIVITY_BUBBLE_TTL_MS;
// Companion/body face for mixed-case world text (names, bubbles, ledgers).
// Departure Mono stays legible far below Press Start 2P's ~10px floor and is
// narrower per glyph, so labels read cleaner AND pack tighter when dezoomed.
// Single-weight face: never request "bold" (synthetic bold smears the pixels).
const WORLD_BODY_FONT = '"Departure Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const NAME_TAG_FONT_PX = 11;
const NAME_TAG_MAX_TEXT_WIDTH = 134;
const NAME_TAG_MAX_WIDTH = 152;
const NAME_TAG_PADDING_X = 20;
const NAME_TAG_SINGLE_HEIGHT = 16;
const NAME_TAG_DOUBLE_HEIGHT = 23;
const NAME_TAG_GLYPH_SIZE = 6;
const COMPACT_NAME_FONT_PX = 11;
const COMPACT_NAME_MAX_TEXT_WIDTH = 135;
const COMPACT_NAME_MAX_WIDTH = 180;
const COMPACT_NAME_MIN_WIDTH = 54;
const COMPACT_NAME_EXTRA_WIDTH = 38;
const COMPACT_NAME_HEIGHT = 17;
const COMPACT_NAME_GLYPH_SIZE = 6;
const COMPACT_NAME_SLOT_BASE_Y = 22;
const COMPACT_NAME_SLOT_STEP_Y = 12;
// #9 — compact activity glyph badge emblem size (the ~9x9 illuminated icon
// that replaces the dark name pill when not selected and zoomed out).
const TOOL_GLYPH_BADGE_SIZE = 9;
const STATUS_BUBBLE_MAIN_MAX_WIDTH = Object.freeze({
    anchored: 232,
    floating: 360,
});
const STATUS_BUBBLE_HISTORY_MAX_WIDTH = Object.freeze({
    anchored: 216,
    floating: 320,
});
const TOOL_DETAIL_PREVIEW_CHARS = 36;
const TOOL_DETAIL_KEY_CHARS = 56;
const ACTIVITY_TEXT_CAP = 60;
const MESSAGE_TEXT_CAP = 56;
const TOOL_CONFIDENCE_THRESHOLD = 0.72;
const TOOL_CLASSIFICATION_CACHE_LIMIT = 160;
const TOOL_CLASSIFICATION_CACHE = new Map();
const PROCESSED_SPRITE_CACHE = new Map();
const PROCESSED_SPRITE_CACHE_ENTRY_LIMIT = 24;
const PROCESSED_SPRITE_CACHE_PIXEL_LIMIT = 12_500_000;
let processedSpriteCachePixels = 0;
// Selection-ring asset recolored per provider accent; keyed by accent color.
const TINTED_SELECTION_RING_CACHE = new Map();
const TINTED_SELECTION_RING_CACHE_LIMIT = 24;
const TOOL_ACTIVITY_LABEL_OVERRIDES = Object.freeze({
    'functions.spawn_agent': 'Spawning',
    'functions.send_input': 'Directing',
    'functions.wait_agent': 'Waiting On',
    'functions.resume_agent': 'Resuming',
    'functions.close_agent': 'Closing',
    'multi_tool_use.parallel': 'Coordinating',
    // Unprefixed orchestration aliases (codex multi-agent tools arrive without
    // the 'functions.' prefix) so bubbles read as words, not raw snake_case.
    send_message: 'Messaging',
    spawn_agent: 'Spawning',
    wait_agent: 'Waiting On',
    wait: 'Waiting On',
    resume_agent: 'Resuming',
    close_agent: 'Closing',
    list_agents: 'Coordinating',
});
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
});
const CODEX_WEAPON_ASSETS = Object.freeze({
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
        backLayer: 'always',
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
const EFFORT_FLOOR_RING_VISUALS = Object.freeze({
    low: { stroke: '#d7a456', highlight: '#ffe0a0', glow: 'rgba(215, 164, 86, 0.18)', bands: 1, rx: 17, ry: 5 },
    medium: { stroke: '#b8c4cc', highlight: '#eef7ff', glow: 'rgba(184, 196, 204, 0.18)', bands: 2, rx: 19, ry: 6 },
    high: { stroke: '#f2d36b', highlight: '#fff1b8', glow: 'rgba(242, 211, 107, 0.22)', bands: 3, rx: 21, ry: 7 },
});
// 4.6 — effort-tier aura around the sprite body. Tier resolves from the
// model's reasoning effort (mythic-tier models always shimmer; max folds into
// xhigh). Colors echo the floor-ring metals so both effort cues read as one
// family. Drawn before the grounding pass so the aura sits behind the sprite
// while the floor/status rings stay in front. Pulse bands per
// docs/motion-budget.md: glow breathing claims `slow`, mote orbit claims
// `medium` (permitted claimant).
const EFFORT_AURA_VISUALS = Object.freeze({
    low: { kind: 'motes', color: '#d7a456', motes: 3 },
    medium: { kind: 'glow', color: '#cfd9e4' },
    high: { kind: 'corona', color: '#f2d36b' },
    xhigh: { kind: 'field', color: '#ffe9a8' },
    ultra: { kind: 'field', color: '#fff6d8' },
    mythic: { kind: 'shimmer', colors: [MODEL_TIER_COLORS.mythic, '#ffe7a8', '#c8a3ff'], motes: 4 },
});
const EFFORT_AURA_MAX_MOTES = 6;
// Idle/waiting agents keep a dimmed (~35%) aura; full intensity while working.
const EFFORT_AURA_IDLE_INTENSITY = 0.35;
const EFFORT_AURA_CENTER_Y = -26; // body-center offset above the feet anchor
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
        let tintedSelectionRingPixels = 0;
        for (const canvas of TINTED_SELECTION_RING_CACHE.values()) {
            tintedSelectionRingPixels += (canvas?.width || 0) * (canvas?.height || 0);
        }
        return {
            processedSpriteSheets: PROCESSED_SPRITE_CACHE.size,
            processedSpritePixels: processedSpriteCachePixels,
            processedSpriteEntryLimit: PROCESSED_SPRITE_CACHE_ENTRY_LIMIT,
            processedSpritePixelLimit: PROCESSED_SPRITE_CACHE_PIXEL_LIMIT,
            tintedSelectionRings: TINTED_SELECTION_RING_CACHE.size,
            tintedSelectionRingPixels,
            toolClassifications: TOOL_CLASSIFICATION_CACHE.size,
        };
    }

    static releaseSharedCaches() {
        // Drop cache ownership without mutating backing stores. A renderer
        // replacement can overlap briefly with the previous renderer, and the
        // incoming sprites may already reference one of these shared canvases.
        PROCESSED_SPRITE_CACHE.clear();
        TINTED_SELECTION_RING_CACHE.clear();
        TOOL_CLASSIFICATION_CACHE.clear();
        processedSpriteCachePixels = 0;
    }

    constructor(agent, {
        pathfinder = null,
        bridgeTiles = null,
        assets = null,
        compositor = null,
        getIntentForAgent = null,
        getBuilding = null,
        allocateVisitTile = null,
        releaseVisitReservation = null,
        renewVisitReservation = null,
        getAmbientDestination = null,
        getRoadTiles = null,
        getTileType = null,
    } = {}) {
        this.agent = agent;
        this.x = 0;
        this.y = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.moving = false;
        this.walkFrame = 0;
        this.waitTimer = 0;
        this.selected = false;
        this.statusAnim = 0;
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        this.lightingState = null;
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
        // #14 — set true by IsometricRenderer when this agent's name pill is
        // folded into its building's status-tally chip at low zoom.
        this.foldedIntoBuilding = false;
        // 4.8 — earned biography nickname ("the Shipwright"), pushed by the
        // renderer from AgentBiographyService; rendered as a name-tag suffix.
        this.nickname = null;
        this.labelAlpha = 1;
        this.bumpFlash = 0;
        // #28 — handoff acknowledgement bob. A child agent gives a short upward
        // dip when a parent's handoff baton lands on it. Timestamp of the most
        // recent ack; 0 means inactive. Reduced motion never sets it.
        this._handoffAckStart = 0;
        this.teamPlazaPreference = false;
        this._arrivalState = 'visible';
        // #32 — arrival ceremony. `_arrivalCeremonyAt` timestamps the landing
        // (pending → visible) so draw() can play the scale-up pop + rune ring;
        // `_arrivalBurstPending` defers the one-shot dust/rune particle burst to
        // update() where the shared ParticleSystem pool is available. Both stay
        // inert under reduced motion (the transition never arms them).
        this._arrivalCeremonyAt = 0;
        this._arrivalBurstPending = false;

        // Chat system
        this.chatPartner = null;     // Chat partner AgentSprite
        this.chatting = false;       // chatting flag
        this.chatTimer = 0;          // chat animation timer
        this.chatBubbleAnim = 0;     // speech bubble animation

        // #38 — idle gossip cluster. RelationshipState groups loitering IDLE
        // villagers near a scenic point; the renderer's CouncilRing pass calls
        // enterGossip() with the knot centroid. While gossiping the sprite faces
        // the centroid, reuses the chat speech-bubble effect (chatting=true), and
        // disperses after a short timer, then enters a cooldown so it doesn't
        // immediately re-cluster. Under reduced motion it just stands and faces
        // the centroid (timer/cooldown still advance; no bubble cycling).
        this._gossiping = false;
        this._gossipCenter = null;
        this._gossipDisperseMs = 0;
        this._gossipCooldownUntil = 0;

        // Active pose-bearing tool ritual record from RitualConductor (per
        // building work gesture: hammer / page / pick / scroll / …), synced by
        // the renderer per frame. `_ritualDownbeat` is the last gesture-cycle
        // index a one-shot particle was fired on, so each downbeat fires once.
        this._toolRitual = null;
        this._ritualDownbeat = -1;
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
        this.allocateVisitTile = typeof allocateVisitTile === 'function' ? allocateVisitTile : null;
        this.releaseVisitReservation = typeof releaseVisitReservation === 'function' ? releaseVisitReservation : null;
        this.renewVisitReservation = typeof renewVisitReservation === 'function' ? renewVisitReservation : null;
        this.getAmbientDestination = typeof getAmbientDestination === 'function' ? getAmbientDestination : null;
        this.getRoadTiles = typeof getRoadTiles === 'function' ? getRoadTiles : null;
        // #42 — renderer-supplied tile-class lookup (dirt/cobble/grass/shallow/
        // deep) used to key terrain-aware footfall particles to the ground under
        // each stride.
        this.getTileType = typeof getTileType === 'function' ? getTileType : null;
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
        this.frame = 0;
        this.frameTimer = 0;
        this._strideDistance = 0;
        this._candidateDirection = null;
        this._candidateDirectionMs = 0;
        this.spriteCanvas = null;
        this.spriteSheet = null;     // cached SpriteSheet wrapper, set on first draw
        this._spriteProfileKey = '';
        this._silhouetteCellCache = new Map();
        this._frozenTintCellCache = new Map();
        this._cellBoundsCache = new Map();
        // Accessory hysteresis state (D2). `undefined` means no accessory has
        // been committed yet, so the first one applies immediately.
        this._committedAccessory = undefined;
        this._accessoryCandidate = null;
        this._accessoryCandidateSince = 0;
        this._nameTagLayoutCacheKey = '';
        this._nameTagLayoutCache = null;
        this._bubbleLayoutCacheKey = '';
        this._bubbleLayoutCache = null;
        this._compactNameStatusCacheKey = '';
        this._compactNameStatusCache = null;
        this._activityTrail = [];
        this._activitySnapshot = this._captureActivitySnapshot(agent);
        // 4.6 — pre-allocated effort-aura mote state, built lazily on the
        // first animated aura draw (never under reduced motion).
        this._auraMotes = null;

        this._pickTarget();
    }

    _pickTarget() {
        // Move to the partner position when there is a chat partner
        if (this.chatPartner) {
            this._releaseVisitReservation();
            this.behavior.transition('chat-approach', 'chat');
            const offsetX = this.x < this.chatPartner.x ? -25 : 25;
            const chatTargetX = this.chatPartner.x + offsetX;
            const chatTargetY = this.chatPartner.y;
            const targetTile = this._screenToTile(chatTargetX, chatTargetY);
            this._lastPathTileKey = null; // force fresh path on every chat entry
            this._assignTarget(chatTargetX, chatTargetY, targetTile.tileX, targetTile.tileY);
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
        const bx = Number(building?.x);
        const by = Number(building?.y);
        if (!finite(bx) || !finite(by)) return null;
        return {
            x: bx + (Number(building.width) || 1) / 2,
            y: by + (Number(building.height) || 1) / 2,
        };
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
        if (tilePath.length === 0) {
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
        const finalTile = tilePath[tilePath.length - 1];
        if (
            finalTile &&
            Math.abs(finalTile.tileX - Math.round(targetTileX)) <= 1 &&
            Math.abs(finalTile.tileY - Math.round(targetTileY)) <= 1 &&
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

    _speedForState() {
        if (this.chatPartner) return 2.5;
        let base = 1.2;
        if (this.agent.status === AgentStatus.WORKING) base = 1.5;
        if (this.agent.status === AgentStatus.WAITING) base = 1.1;
        if (this.agent.status === AgentStatus.IDLE) base = 0.8;
        const speed = this._clamp(base * this._intentSpeedMultiplier(this._currentMotionIntent()), 0.62, 2.15);
        // Mood (2.2) and congestion (3.13) gait modifiers apply after the
        // tuned clamp so they read as a real slowdown/spring in the step.
        return speed * this._moodGaitMultiplier() * this._congestionGaitMultiplier();
    }

    /** 2.2 — tired/distressed villagers drag their feet; proud ones stride. */
    _moodGaitMultiplier() {
        const mood = this.agent?.mood;
        const intensity = Number(mood?.intensity) || 0;
        if (!mood || intensity <= 0) return 1;
        if (mood.type === 'tired') return 1 - 0.30 * intensity;
        if (mood.type === 'distressed') return 1 - 0.18 * intensity;
        if (mood.type === 'proud') return 1 + 0.12 * intensity;
        return 1;
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

    _moodShadowTint() {
        if (this.motionScale <= 0 || this.agent?.status === AgentStatus.ERRORED) return null;
        const mood = this.agent?.mood;
        const intensity = this._clamp(Number(mood?.intensity) || 0, 0, 1);
        const color = MOOD_ACCENTS[mood?.type];
        if (!color || intensity <= 0) return null;
        return this._rgba(color, 0.06 * intensity);
    }

    /** 3.13 — slower gait while heading to/standing in a congested building. */
    _congestionGaitMultiplier() {
        return this._congestedBuilding() ? CONGESTION_GAIT_SCALE : 1;
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
        const wasPending = this._arrivalState === 'pending';
        this._arrivalState = state === 'pending' ? 'pending' : 'visible';
        if (this._arrivalState === 'pending') {
            this._releaseVisitReservation();
            this.behavior.transition('departing', 'arrival-state');
            this.moving = false;
            this.waitTimer = 0;
            this.waypoints = [];
            this._lastPathTileKey = null;
        } else if (wasPending && this.motionScale > 0) {
            // #32 — the approach just finished and the villager is materializing
            // at its landing tile: arm the arrival ceremony (scale-up pop + rune
            // ring in draw(), one-shot dust/rune burst on the next update()).
            this._arrivalCeremonyAt = Date.now();
            this._arrivalBurstPending = true;
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
        this._gossiping = false;
        this._gossipCenter = null;
        this._gossipDisperseMs = 0;
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
        if (this.isArrivalPending()) {
            this._advanceIdleAnimation(dt);
            return;
        }
        const frameScale = Math.max(0, Math.min(3, dt / 16));
        this.statusAnim += 0.05 * this.motionScale * frameScale;
        this.bumpFlash = Math.max(0, this.bumpFlash - 0.08 * frameScale);
        this._advanceToolRitualGesture(particleSystem);
        this._advanceMoodPostureMotes(particleSystem);
        this._advanceContextStrainSweat(particleSystem);
        this._advanceDistressRecovery(particleSystem);
        this._advanceArrivalCeremony(particleSystem);
        this._advanceTokenFlowMotes(particleSystem, frameScale);

        // #38 — gossip knot: stand, face the cluster centroid, run the speech
        // bubble, and disperse after the timer. Checked before the pairwise chat
        // branch because enterGossip sets chatting=true without a chatPartner.
        if (this._gossiping) {
            // Disperse early if the villager is no longer idle (e.g. work resumed)
            // or got pulled into a pairwise SendMessage chat.
            if (this.agent?.status !== AgentStatus.IDLE || this.chatPartner) {
                this.leaveGossip();
            } else {
                this._faceGossipCenter();
                this.chatBubbleAnim += 0.06 * this.motionScale * frameScale;
                this._gossipDisperseMs -= dt;
                if (this._gossipDisperseMs <= 0) this.leaveGossip();
                this._advanceIdleAnimation(dt);
                return; // Do not move while gossiping
            }
        }

        // Handle chatting state
        if (this.chatting) {
            this._faceChatPartner();
            this.chatBubbleAnim += 0.06 * this.motionScale * frameScale;
            this._advanceIdleAnimation(dt);
            return; // Do not move while chatting
        }

        // Moving toward the chat partner; start chatting when close
        if (this.chatPartner) {
            const cpDx = this.chatPartner.x - this.x;
            const cpDy = this.chatPartner.y - this.y;
            this._faceChatPartner();
            const cpDist = Math.sqrt(cpDx * cpDx + cpDy * cpDy);
            if (cpDist < 35) {
                this.chatting = true;
                this.behavior.transition('chatting', 'chat');
                this.chatBubbleAnim = 0;
                this.moving = false;
                this._resetWalkCycle();
                // Derive facing direction toward chat partner.
                const dir = dirFromVelocity(cpDx, cpDy);
                if (dir != null) this.direction = dir;
                // Put the partner in chat state too
                if (!this.chatPartner.chatting) {
                    this.chatPartner.chatPartner = this;
                    this.chatPartner.chatting = true;
                    this.chatPartner.behavior?.transition?.('chatting', 'chat');
                    this.chatPartner.chatBubbleAnim = 0;
                    this.chatPartner.moving = false;
                    this.chatPartner._resetWalkCycle();
                    // Partner faces back.
                    const partnerDir = dirFromVelocity(-cpDx, -cpDy);
                    if (partnerDir != null) this.chatPartner.direction = partnerDir;
                }
                return;
            }
            // Refresh target when the partner position changes — route via pathfinder.
            const offsetX = this.x < this.chatPartner.x ? -25 : 25;
            const chatTargetX = this.chatPartner.x + offsetX;
            const chatTargetY = this.chatPartner.y;
            const chatTargetTile = this._screenToTile(chatTargetX, chatTargetY);
            this._assignTarget(chatTargetX, chatTargetY, chatTargetTile.tileX, chatTargetTile.tileY);
        }

        // Reroute immediately when status or fresh tool changes the intended building.
        if (!this.chatPartner) {
            const activeIntent = this._activeVisitIntent();
            let curBuilding = activeIntent?.building || (this.agent.status === AgentStatus.IDLE
                ? this._lastBuildingType
                : this._targetBuildingTypeForState());
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
            if (!this.moving) this._snapToNearestWalkable();
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

        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const speed = this._speedForState();
        const step = speed * frameScale;

        if (dist < step) {
            this.x = this.targetX;
            this.y = this.targetY;
            this._advanceWalkAnimation(dist, dx, dy, dt, particleSystem);
            if (this.waypoints && this.waypoints.length > 0) {
                this.waypoints.shift();
                if (this.waypoints.length > 0) {
                    this.targetX = this.waypoints[0].x;
                    this.targetY = this.waypoints[0].y;
                    return;
                }
            }
            this.moving = false;
            this.behavior.arrive({
                state: this._lastIntentId ? 'performing' : 'lingering',
                cooldownMs: this._lastIntentId ? 2000 : 0,
                phase: this._lastIntentSnapshot?.phase || this._phaseForAgentState(),
                interruptible: this._lastIntentSnapshot?.interruptible,
            });
            if (!this.chatPartner) this._faceBuilding(this._buildingForType(this._lastBuildingType), this._lastVisitFacingPoint);
            this.waitTimer = this.chatPartner ? 10 : this._waitDurationForState();
            this._resetWalkCycle();
            return;
        }

        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
        this._advanceWalkAnimation(step, dx, dy, dt, particleSystem);
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

        // Deliberate stride pause for IDLE strollers: hold the frame for 6 ticks
        // out of every 12 so motion looks unhurried. Pause is skipped when
        // reduced-motion is active (motionScale 0).
        const isIdleStroll = this.agent?.status === AgentStatus.IDLE && !this.chatPartner && !this.chatting;
        if (isIdleStroll) {
            this._idleStrideTick = (this._idleStrideTick || 0) + 1;
            const phase = this._idleStrideTick % 12;
            if (phase < 6) {
                // Pause stride: skip distance accumulation, keep current frame.
                this.walkFrame = this.frame;
                return;
            }
        }

        const previousFrame = this.frame % WALK_FRAMES;
        this._strideDistance += Math.max(0, distance);
        this.frame = Math.floor(this._strideDistance / WALK_PIXELS_PER_FRAME) % WALK_FRAMES;
        this.walkFrame = this.frame;
        this.frameTimer = 0;

        if (
            particleSystem &&
            this.agent.status === AgentStatus.WORKING &&
            previousFrame !== this.frame &&
            FOOTFALL_FRAMES.has(this.frame)
        ) {
            const footSide = this.frame === 0 ? -5 : 5;
            particleSystem.spawn(this._footfallPresetForSurface(), this.x + footSide, this.y + 7, 1);
        }
    }

    _advanceIdleAnimation(dt) {
        this.animState = 'idle';
        if (this.motionScale <= 0) {
            this.frame = 0;
            this.frameTimer = 0;
            return;
        }
        this.frameTimer += dt;
        const tick = 500;
        while (this.frameTimer > tick) {
            this.frame = (this.frame + 1) % IDLE_FRAMES;
            this.frameTimer -= tick;
        }
    }

    _updateFacingDirection(dx, dy, dt) {
        const dir = dirFromVelocity(dx, dy);
        if (dir == null || dir === this.direction) {
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
            return;
        }
        if (this._candidateDirection !== dir) {
            this._candidateDirection = dir;
            this._candidateDirectionMs = 0;
        }
        this._candidateDirectionMs += dt;
        if (this._candidateDirectionMs >= DIRECTION_HOLD_MS) {
            this.direction = dir;
            this._candidateDirection = null;
            this._candidateDirectionMs = 0;
        }
    }

    _faceChatPartner() {
        if (!this.chatPartner) return;
        const dir = dirFromVelocity(this.chatPartner.x - this.x, this.chatPartner.y - this.y);
        if (dir != null) this.direction = dir;
    }

    _faceBuilding(building, facingPoint = null) {
        if (!building && !facingPoint) return;
        const point = this._resolveBuildingFacingPoint(building, facingPoint);
        if (!point) return;
        const center = tileToWorld({ tileX: point.tileX, tileY: point.tileY });
        const dir = dirFromVelocity(center.x - this.x, center.y - this.y);
        if (dir != null) this.direction = dir;
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
        if (!building) return null;
        const bx = Number(building.x);
        const by = Number(building.y);
        if (!finite(bx) || !finite(by)) return null;
        const cx = bx + (Number(building.width) || 1) / 2;
        const cy = by + (Number(building.height) || 1) / 2;
        return { tileX: cx, tileY: cy };
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
            this._fidgetCooldownMs = 3000 + Math.random() * 6000;
        }
        // Re-anchor 4-9 s nudges back to building facingPoint when dwelling.
        if (this._anchorReinforceMs == null) {
            this._anchorReinforceMs = 4000 + Math.random() * 5000;
        }
        this._anchorReinforceMs -= dt;
        if (this._anchorReinforceMs <= 0) {
            const building = this._buildingForType(this._lastBuildingType);
            if (building) this._faceBuilding(building, this._lastVisitFacingPoint);
            this._anchorReinforceMs = 4000 + Math.random() * 5000;
        }
        this._fidgetCooldownMs -= dt;
        if (this._fidgetCooldownMs <= 0) {
            const sign = Math.random() > 0.5 ? 1 : -1;
            this.direction = (this.direction + sign + 8) % 8;
            this._fidgetActiveMs = 600 + Math.random() * 400;
            this._fidgetCooldownMs = 4000 + Math.random() * 5000;
        }
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

    _resetWalkCycle() {
        this.walkFrame = 0;
        this._strideDistance = 0;
        this._candidateDirection = null;
        this._candidateDirectionMs = 0;
        this.frameTimer = 0;
        this.frame = 0;
        this.animState = 'idle';
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
        if ((next?.id || null) !== (this._toolRitual?.id || null)) this._ritualDownbeat = -1;
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

    // #38 — gossip cluster lifecycle (driven from CouncilRing.applyGossipClusters).
    isGossiping() {
        return this._gossiping;
    }

    isGossipCoolingDown() {
        return this._gossipCooldownUntil > Date.now();
    }

    /** Join a standing gossip knot centred on (centerX, centerY). */
    enterGossip(centerX, centerY) {
        if (this._gossiping) {
            this._gossipCenter = { x: centerX, y: centerY };
            this._faceGossipCenter();
            return;
        }
        if (this.chatPartner || this.chatting || this.isArrivalPending()) return;
        if (this.agent?.status !== AgentStatus.IDLE) return;
        this._releaseVisitReservation();
        this._gossiping = true;
        this.chatting = true; // reuse the speech-bubble effect in draw()
        this.chatBubbleAnim = 0;
        this.moving = false;
        this.waitTimer = 0;
        this._gossipCenter = { x: centerX, y: centerY };
        // 4-8 s standing knot, then disperse.
        this._gossipDisperseMs = 4000 + Math.random() * 4000;
        this.behavior?.transition?.('chatting', 'gossip');
        this._resetWalkCycle();
        this._faceGossipCenter();
    }

    /** Leave the gossip knot and cool down before re-clustering. */
    leaveGossip() {
        if (!this._gossiping) return;
        this._gossiping = false;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this._gossipCenter = null;
        this._gossipDisperseMs = 0;
        this._gossipCooldownUntil = Date.now() + 12000 + Math.random() * 8000;
        this.behavior?.finishVisit?.();
        this.behavior?.transition?.('cooldown', 'gossip-ended');
        this._pickTarget();
    }

    _faceGossipCenter() {
        if (!this._gossipCenter) return;
        const dir = dirFromVelocity(this._gossipCenter.x - this.x, this._gossipCenter.y - this.y);
        if (dir != null) this.direction = dir;
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

    draw(ctx, zoom = 1, renderMode = 'full') {
        this._zoom = zoom;

        if (this.isArrivalPending()) return;

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
            this._lastStatus = currentStatus;
        }

        const budgetMode = renderMode !== 'full' && !this.selected;
        if (budgetMode) {
            this._drawBudgetImpostor(ctx);
            if (renderMode === 'compact' && this.overlaySlot != null) {
                this._drawCompactAgentBadge(ctx);
            }
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

        if (!this.spriteCanvas || this._spriteProfileKey !== profileKey) {
            const baseCanvas = this.compositor.spriteFor(spriteId, paletteKey, variant, accessory, teamTrim);
            this.spriteCanvas = this._prepareSpriteCanvas(baseCanvas, identity, profileKey);
            if (this.spriteCanvas) {
                this.spriteSheet = new SpriteSheet(this.spriteCanvas);
                this._spriteProfileKey = profileKey;
                this._silhouetteCellCache.clear();
                this._frozenTintCellCache.clear();
                this._cellBoundsCache.clear();
            }
        }

        if (!this.spriteCanvas || !this.spriteSheet) {
            if (archivePushed) ctx.restore();
            return;
        }

        // Ensure animState reflects current movement (idle when not moving).
        this.animState = this.moving && this.motionScale > 0 ? 'walk' : 'idle';

        // Strong ground language keeps agents readable against dense pixel-art terrain.
        // 4.6 — effort aura first so it stays behind the sprite and rings.
        this._drawEffortAura(ctx, identity);
        this._drawGrounding(ctx);
        this._drawEffortFloorRing(ctx, identity);
        this._drawContextPressureRing(ctx);

        if (!this.selected && zoom < 1) {
            this._drawLowZoomImpostor(ctx);
            // #4 — the beacon must survive the low-zoom busy overview, the exact
            // scene where a waiting agent is otherwise lost in the cluster.
            if (this.agent?.status === AgentStatus.WAITING_ON_USER) {
                this._drawWaitingOnUserBeacon(ctx, null);
            }
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
        const cellSize = this.spriteSheet?.cellSize || 92;
        const bounds = this._getCellContentBounds(cell);
        // Scale the body from accessory-free bounds so a hat's extra height does
        // not shrink the villager (D3); positioning keeps hat-inclusive bounds.
        const drawScale = this._spriteDrawScale(this._scaleBounds(cell, bounds));
        // Subtle ±0.6px sinusoidal bob while idle so the eye can find still agents.
        // IDLE-status agents bob slower and shallower to read as "resting".
        const isIdleStatus = this.agent?.status === AgentStatus.IDLE;
        // #40 — distressed villagers carry a head-down drop while storming the
        // Pharos, layered on the idle bob (animated) or the static posture
        // offset (reduced motion). Walking keeps the drop so the gait reads
        // hunched all the way to the watchtower.
        const distressDrop = this._distressPostureDrop();
        const bobY = this.animState === 'idle'
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
        if (this._handoffAckStart) {
            const ackAge = Date.now() - this._handoffAckStart;
            if (ackAge >= 0 && ackAge < 180) {
                ackBobY = -Math.round(Math.sin((ackAge / 180) * Math.PI) * 2.4);
            } else {
                this._handoffAckStart = 0;
            }
        }
        const drawX = this._snapWorldToScreenPixel(this.x);
        const drawY = this._snapWorldToScreenPixel(this.y);
        // #36 — context-strain tremble: a tiny ±1px horizontal shiver once the
        // context window is nearly full (ratio >= 0.85), so the body language
        // reads as strain alongside the gauge arc. Reduced motion (motionScale 0)
        // skips the shiver — the static arc + chip carry the cue instead.
        const trembleX = this._contextStrainTremble();
        const contentCenterX = (bounds.minX + bounds.maxX) / 2;
        const dx = drawX - contentCenterX * drawScale + trembleX;
        const dy = drawY - bounds.maxY * drawScale + 2 + bobY + ackBobY;
        const contentTopY = dy + bounds.minY * drawScale;
        // #32 — arrival ceremony scale-up "pop": the body springs from ~0.6→1.0
        // over ~300ms, anchored at the feet so it grows up out of the landing
        // tile. Wraps only the body blit (silhouette + sprite + tints +
        // equipment) so rings/labels/beacons keep their normal scale. Reduced
        // motion never arms the ceremony, so this is a no-op then.
        const arrivalProgress = this._arrivalCeremonyProgress();
        let arrivalPushed = false;
        if (arrivalProgress > 0) {
            const popScale = 0.6 + 0.4 * easeOutCubic(arrivalProgress);
            ctx.save();
            ctx.translate(drawX, drawY);
            ctx.scale(popScale, popScale);
            ctx.translate(-drawX, -drawY);
            arrivalPushed = true;
        }
        this._drawCodexEquipment(ctx, identity, { dx, dy, bounds, cellSize, drawScale }, 'back');
        this._drawSpriteSilhouette(ctx, cell, dx, dy, drawScale);
        ctx.drawImage(
            this.spriteCanvas,
            cell.sx, cell.sy, cell.sw, cell.sh,
            dx, dy, cell.sw * drawScale, cell.sh * drawScale
        );
        // Frozen/darkened body tint while rate-limited — static overlay, so it
        // reads identically under reduced motion.
        if (this.agent?.status === AgentStatus.RATE_LIMITED) {
            this._drawFrozenTint(ctx, cell, dx, dy, drawScale);
        }
        this._drawCodexEquipment(ctx, identity, { dx, dy, bounds, cellSize, drawScale }, 'front');
        if (arrivalPushed) ctx.restore();
        if (arrivalProgress > 0) this._drawArrivalRuneRing(ctx, arrivalProgress);
        this._drawStanceOverlay(ctx, { dx, dy, bounds, drawScale });
        this._drawToolRitualOverlay(ctx, { dx, dy, bounds, drawScale });

        // #4 — waiting-on-user amber beacon pillar. PRIMARY tier (never culled):
        // the action-demanding state must be visible from across the map even
        // when buried in a cluster. Drawn before the selection focus pillar so a
        // selected, waiting agent shows both.
        if (this.agent?.status === AgentStatus.WAITING_ON_USER) {
            this._drawWaitingOnUserBeacon(ctx, contentTopY);
        }

        // Selection halo (if selected) — outer glow + pulsed ring at feet level,
        // tinted with the provider accent so selection reads identity at a glance.
        if (this.selected) {
            ctx.save();
            ctx.fillStyle = this._rgba(this._providerAccentColor(), 0.18);
            ctx.beginPath();
            ctx.ellipse(Math.round(this.x), Math.round(this.y - 2), 22, 8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            this._drawFocusPillar(ctx, contentTopY);
            this._drawSelectionRing(ctx);
        }

        // Chat bubble overlay (if chatting).
        // Per-agent floating text bubbles are deferred to Phase 4; the chat
        // ellipsis animation already handled by _drawChatEffect below.
        if (this.chatting) {
            this._drawChatEffect(ctx);
        } else {
            this._drawStatus(ctx, contentTopY);
        }
        this._drawStatusEmote(ctx, contentTopY);
        // Plan-mode and retry glyphs sit above the silhouette. The status
        // emote (kind != null) wins the slot; otherwise plan-mode glyph renders
        // slightly higher. Retry glyph renders to the right.
        this._drawPlanModeGlyph(ctx, contentTopY);
        this._drawRetryGlyph(ctx, contentTopY);
        this._drawNameTag(ctx);

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
        // Carry the compositor's accessory-free content bounds onto the scrubbed
        // canvas so body draw-scale still reads hat-free measurements (D3).
        if (baseCanvas.__cvBaseBounds) canvas.__cvBaseBounds = baseCanvas.__cvBaseBounds;
        PROCESSED_SPRITE_CACHE.set(cacheKey, canvas);
        processedSpriteCachePixels += canvas.width * canvas.height;
        while (
            PROCESSED_SPRITE_CACHE.size > PROCESSED_SPRITE_CACHE_ENTRY_LIMIT
            || processedSpriteCachePixels > PROCESSED_SPRITE_CACHE_PIXEL_LIMIT
        ) {
            const oldestKey = PROCESSED_SPRITE_CACHE.keys().next().value;
            if (oldestKey == null) break;
            const oldest = PROCESSED_SPRITE_CACHE.get(oldestKey);
            PROCESSED_SPRITE_CACHE.delete(oldestKey);
            processedSpriteCachePixels -= (oldest?.width || 0) * (oldest?.height || 0);
        }
        processedSpriteCachePixels = Math.max(0, processedSpriteCachePixels);
        return canvas;
    }

    _shouldScrubBakedCodexWeapon(identity) {
        if (!identity) return false;
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

    _drawEffortFloorRing(ctx, identity) {
        const effortRingId = this._runtimeEffortFloorRing(identity);
        if (!effortRingId) return;
        const effortRing = this.assets?.get(effortRingId);
        if (!effortRing) {
            const effortTier = this._effortFloorRingTier(identity, effortRingId);
            if (effortTier) this._drawProceduralEffortFloorRing(ctx, effortTier);
            return;
        }
        const dims = this.assets.getDims(effortRingId);
        const [ax, ay] = this.assets.getAnchor(effortRingId);
        const pulse = 0.76 + 0.24 * Math.sin(this.statusAnim * 1.8);
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
            effortRing,
            Math.round(this.x - ax),
            Math.round(this.y + 4 - ay),
            dims.w,
            dims.h
        );
        ctx.restore();
    }

    _effortFloorRingTier(identity, effortRingId) {
        const effortTier = String(identity?.effortTier || '').toLowerCase();
        if (EFFORT_FLOOR_RING_VISUALS[effortTier]) return effortTier;
        const id = String(effortRingId || '').toLowerCase();
        if (id.includes('effortlow')) return 'low';
        if (id.includes('effortmedium')) return 'medium';
        if (id.includes('efforthigh')) return 'high';
        return null;
    }

    _drawProceduralEffortFloorRing(ctx, effortTier) {
        const visual = EFFORT_FLOOR_RING_VISUALS[effortTier];
        if (!visual) return;
        const pulse = 0.72 + 0.28 * Math.sin(this.statusAnim * 1.8);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(Math.round(this.x), Math.round(this.y + 4));
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = pulse;
        ctx.fillStyle = visual.glow;
        ctx.beginPath();
        ctx.ellipse(0, 0, visual.rx + 3, visual.ry + 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        for (let band = 0; band < visual.bands; band++) {
            const inset = band * 3;
            const yOffset = (band - (visual.bands - 1) / 2) * 1.5;
            ctx.globalAlpha = (0.52 + band * 0.11) * pulse;
            ctx.strokeStyle = band === visual.bands - 1 ? visual.highlight : visual.stroke;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(0, yOffset, Math.max(8, visual.rx - inset), Math.max(3, visual.ry - band), 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 0.78 * pulse;
        ctx.fillStyle = visual.highlight;
        const ticks = effortTier === 'high'
            ? [[-14, -1], [0, -6], [14, -1], [-7, 4], [7, 4]]
            : effortTier === 'medium'
                ? [[-12, -1], [12, -1], [0, 5]]
                : [[0, -5], [0, 5]];
        for (const [x, y] of ticks) {
            ctx.fillRect(Math.round(x), Math.round(y), 2, 1);
        }
        ctx.restore();
    }

    // 4.6 — aura tier for this agent: mythic-tier models always shimmer,
    // otherwise the reasoning-effort tier picks the visual (max → xhigh).
    // Returns null when no aura applies.
    _effortAuraTier(identity) {
        if (identity?.modelTier === 'mythic') return 'mythic';
        const tier = String(identity?.effortTier || '').toLowerCase();
        const resolved = tier === 'max' ? 'xhigh' : tier;
        return EFFORT_AURA_VISUALS[resolved] ? resolved : null;
    }

    // Pre-allocated drifting-mote state: built once per mote count (rebuilds
    // only if the tier's count changes), so the per-frame path allocates
    // nothing. Reduced motion never reaches this.
    _effortAuraMotes(count) {
        const capped = Math.min(Number(count) || 0, EFFORT_AURA_MAX_MOTES);
        if (!this._auraMotes || this._auraMotes.length !== capped) {
            const seed = Math.abs(this._hash(`${this.agent.id}:aura`));
            this._auraMotes = [];
            for (let i = 0; i < capped; i++) {
                this._auraMotes.push({
                    phase: this._noise(seed, i * 7) * Math.PI * 2,
                    speed: 0.5 + this._noise(seed, i * 13) * 0.7,
                    radiusX: 13 + this._noise(seed, i * 19) * 7,
                    radiusY: 9 + this._noise(seed, i * 23) * 6,
                    size: 1 + (i % 2),
                });
            }
        }
        return this._auraMotes;
    }

    // 4.6 — effort-tier aura dispatcher. Full intensity while WORKING, dimmed
    // to ~35% otherwise. Off-screen sprites never reach draw() (the renderer
    // culls depth-sorted drawables), so the aura skips automatically outside
    // the viewport. Reduced motion (motionScale 0) renders a static tint ring
    // at fixed alpha instead of animated particles.
    _drawEffortAura(ctx, identity) {
        const tier = this._effortAuraTier(identity);
        if (!tier) return;
        const visual = EFFORT_AURA_VISUALS[tier];
        let intensity = this.agent?.status === AgentStatus.WORKING ? 1 : EFFORT_AURA_IDLE_INTENSITY;
        // #2 — the effort aura is an AMBIENT mark: it dims, then culls, first in
        // dense regions so the eye lands on PRIMARY agents (errored / waiting-on-
        // user / selected), whose auras bypass the governor and stay full.
        const isPrimary = this.selected
            || this.agent?.status === AgentStatus.ERRORED
            || this.agent?.status === AgentStatus.WAITING_ON_USER;
        if (!isPrimary) {
            const governor = getActiveMarkGovernor();
            if (governor) {
                const gate = governor.admit(MarkTier.AMBIENT, this.x, this.y);
                if (!gate.draw) return;
                intensity *= gate.alpha;
            }
        }
        ctx.save();
        ctx.translate(Math.round(this.x), Math.round(this.y + EFFORT_AURA_CENTER_Y));
        if (this.motionScale <= 0) {
            ctx.globalAlpha = 0.34 * intensity;
            ctx.strokeStyle = visual.color || visual.colors[0];
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.ellipse(0, 0, 17, 23, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
            return;
        }
        if (visual.kind === 'motes') this._drawAuraMotes(ctx, visual, intensity);
        else if (visual.kind === 'glow') this._drawAuraGlow(ctx, visual, intensity);
        else if (visual.kind === 'corona') this._drawAuraCorona(ctx, visual, intensity);
        else if (visual.kind === 'field') this._drawAuraField(ctx, visual, intensity);
        else this._drawAuraShimmer(ctx, visual, intensity);
        ctx.restore();
    }

    // low — a few dim motes drifting around the body (medium band: mote orbit).
    _drawAuraMotes(ctx, visual, intensity) {
        const motes = this._effortAuraMotes(visual.motes);
        ctx.fillStyle = visual.color;
        for (const mote of motes) {
            const t = this.statusAnim * 0.7 * mote.speed + mote.phase;
            const mx = Math.cos(t) * mote.radiusX;
            const my = Math.sin(t * 0.8) * mote.radiusY - Math.sin(t * 0.31) * 4;
            ctx.globalAlpha = (0.16 + 0.10 * Math.sin(t * 1.7)) * intensity;
            ctx.fillRect(Math.round(mx), Math.round(my), mote.size, mote.size);
        }
    }

    // medium — steady soft glow behind the body (static band: no pulse).
    _drawAuraGlow(ctx, visual, intensity) {
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.15 * intensity;
        ctx.fillStyle = visual.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, 18, 24, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    // high — brighter corona: stacked glow + rim, breathing in the slow band.
    _drawAuraCorona(ctx, visual, intensity) {
        const breath = 0.82 + 0.18 * Math.sin(this.statusAnim * 1.1);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.22 * breath * intensity;
        ctx.fillStyle = visual.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, 21, 27, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.30 * breath * intensity;
        ctx.strokeStyle = visual.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(0, 0, 18, 24, 0, 0, Math.PI * 2);
        ctx.stroke();
    }

    // xhigh — pulsing energy field (medium band): breathing glow plus an
    // expanding ring that fades as it grows.
    _drawAuraField(ctx, visual, intensity) {
        const pulse = 0.5 + 0.5 * Math.sin(this.statusAnim * 2.6);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = (0.20 + 0.14 * pulse) * intensity;
        ctx.fillStyle = visual.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, 20 + pulse * 3, 26 + pulse * 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = (0.42 - 0.30 * pulse) * intensity;
        ctx.strokeStyle = visual.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, 15 + pulse * 9, 20 + pulse * 9, 0, 0, Math.PI * 2);
        ctx.stroke();
    }

    // mythic — iridescent shimmer: glow crossfades through the tier palette
    // (slow band) with small color-cycling highlights orbiting the body
    // (medium band: mote orbit).
    _drawAuraShimmer(ctx, visual, intensity) {
        const cycle = this.statusAnim * 0.45;
        const idx = Math.floor(cycle) % visual.colors.length;
        const next = (idx + 1) % visual.colors.length;
        const fade = cycle - Math.floor(cycle);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.20 * (1 - fade) * intensity;
        ctx.fillStyle = visual.colors[idx];
        ctx.beginPath();
        ctx.ellipse(0, 0, 20, 26, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.20 * fade * intensity;
        ctx.fillStyle = visual.colors[next];
        ctx.beginPath();
        ctx.ellipse(0, 0, 20, 26, 0, 0, Math.PI * 2);
        ctx.fill();
        const motes = this._effortAuraMotes(visual.motes);
        for (let i = 0; i < motes.length; i++) {
            const mote = motes[i];
            const t = this.statusAnim * 0.8 * mote.speed + mote.phase;
            ctx.globalAlpha = (0.30 + 0.22 * Math.sin(t * 1.6)) * intensity;
            ctx.fillStyle = visual.colors[(idx + i) % visual.colors.length];
            ctx.fillRect(
                Math.round(Math.cos(t) * (mote.radiusX + 4)),
                Math.round(Math.sin(t * 0.9) * (mote.radiusY + 6)),
                mote.size + 1,
                mote.size + 1,
            );
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

    // #36 — context-window pressure as a filling gauge: a thin radial arc at the
    // agent's feet sweeping clockwise from 12 o'clock through `ratio` of the full
    // circle (0→100%), tinted amber at 0.75 → red at 0.95. A faint backing track
    // shows the unfilled remainder so the fill reads as a gauge, not a stray mark.
    // Pulse band: `alert` (pulseAlpha) — declared so the budget stays accounted.
    // Reduced motion (motionScale 0) holds the band base alpha, so the arc is a
    // static gauge with no throb. The selected agent also gets a `78%` chip.
    _drawContextPressureRing(ctx) {
        const level = this._contextPressureLevel();
        if (!level) return;
        const pulse = pulseAlpha('alert', this.frame, this.motionScale, 0.7, 1);
        const ratio = level.ratio;
        const rx = 27;
        const ry = 10;
        const start = -Math.PI / 2;            // 12 o'clock
        const sweep = Math.PI * 2 * ratio;     // clockwise fill proportional to fullness
        ctx.save();
        ctx.translate(Math.round(this.x), Math.round(this.y + 4));
        // Soft inner glow behind the filled portion so the gauge reads on busy terrain.
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.42 * pulse;
        ctx.strokeStyle = level.glow;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, start, start + sweep);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        // Unfilled remainder — a dim full track so the fill ratio is legible.
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = 'rgba(180, 188, 200, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        // Filled arc — the gauge needle made line.
        ctx.globalAlpha = 0.55 + 0.4 * pulse;
        ctx.strokeStyle = level.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, start, start + sweep);
        ctx.stroke();
        ctx.restore();

        // Percentage chip for the selected agent only, so the exact pressure is
        // legible on demand without cluttering every villager. Static (no pulse).
        if (this.selected) {
            const pct = `${Math.round(ratio * 100)}%`;
            ctx.save();
            ctx.translate(Math.round(this.x), Math.round(this.y + 4));
            ctx.font = `bold 8px ${WORLD_BODY_FONT}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const w = ctx.measureText(pct).width + 8;
            const h = 11;
            const cy = ry + 8;
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = 'rgba(12, 16, 22, 0.78)';
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(-w / 2, cy - h / 2, w, h, 3);
            } else {
                ctx.rect(-w / 2, cy - h / 2, w, h);
            }
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = level.color;
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = level.color;
            ctx.fillText(pct, 0, cy + 0.5);
            ctx.restore();
        }
    }

    // #36 — strain body language: once context pressure crosses 0.85 the body
    // gains a tiny ±1px horizontal shiver, deepening slightly toward 1.0. Driven
    // by `statusAnim` so it freezes (returns 0) under reduced motion (motionScale
    // 0), where the static arc + chip carry the cue instead.
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
    // static arc + chip + held posture are the strain cue then.
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
        // Bead off the temple (slightly off-centre, head height).
        particleSystem.spawn('sweatDrop', this.x + 5, this.y - 30, 1, { spread: 1.5 });
    }

    _drawGrounding(ctx) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        const pulse = 0.75 + 0.25 * Math.sin(this.statusAnim * 2.2);
        const walking = this.animState === 'walk' && this.motionScale > 0;
        const strideCompression = walking
            ? Math.abs(Math.sin((this.frame % WALK_FRAMES) / WALK_FRAMES * Math.PI * 2))
            : 0;
        const shadowRadiusX = 20 + strideCompression * 1.6;
        const shadowRadiusY = 7 - strideCompression * 0.9;
        ctx.save();
        ctx.translate(Math.round(this.x), Math.round(this.y));

        // #37 — Directional sun shadow from the shared atmosphere lighting
        // state: a skewed sprite-shaped parallelogram cast along the sun angle,
        // elongated and tilted at dawn/dusk, tight at noon, gone at night
        // (ambientLight 0). Reads the same shadowAngleRad/shadowLength/
        // shadowAlpha fields the building shadows use, so agents and buildings
        // agree on sun direction. The cast pools darker where villagers crowd
        // because it composites with `multiply`. No per-frame animation: the
        // angle is driven entirely by the (already eased) lighting snapshot, so
        // the reduced-motion path is the same fixed-angle skew.
        const lighting = this.lightingState;
        const sunStrength = lighting ? this._clamp(lighting.ambientLight ?? 0, 0, 1) : 0;
        if (sunStrength > 0.04) {
            const sunAngle = lighting.shadowAngleRad ?? 0.28;
            const sunLength = lighting.shadowLength ?? 1;
            const sunAlpha = Math.min(0.3, lighting.shadowAlpha ?? 0.22) * sunStrength;
            // Cast vector: foot anchor (0,6) → tip offset along the sun angle.
            const tipX = Math.cos(sunAngle) * 9 * sunLength;
            const tipY = Math.sin(sunAngle) * 3.5 * sunLength;
            // Half-width of the body footprint at the feet; the tip tapers in so
            // the cast reads as a body silhouette rather than a slab.
            const baseHalf = shadowRadiusX * 0.6;
            const tipHalf = baseHalf * 0.5;
            // Perpendicular to the cast direction, foreshortened on Y for iso.
            const perpAngle = sunAngle + Math.PI / 2;
            const px = Math.cos(perpAngle);
            const py = Math.sin(perpAngle) * 0.4;
            ctx.save();
            ctx.globalCompositeOperation = 'multiply';
            ctx.fillStyle = `rgba(15, 22, 30, ${sunAlpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(px * baseHalf, 6 + py * baseHalf);
            ctx.lineTo(-px * baseHalf, 6 - py * baseHalf);
            ctx.lineTo(tipX - px * tipHalf, 6 + tipY - py * tipHalf);
            ctx.lineTo(tipX + px * tipHalf, 6 + tipY + py * tipHalf);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        ctx.fillStyle = 'rgba(5, 8, 12, 0.56)';
        ctx.beginPath();
        ctx.ellipse(0, 6, shadowRadiusX, shadowRadiusY, 0, 0, Math.PI * 2);
        ctx.fill();
        const moodShadowTint = this._moodShadowTint();
        if (moodShadowTint) {
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = moodShadowTint;
            ctx.beginPath();
            ctx.ellipse(0, 6, shadowRadiusX, shadowRadiusY, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.fillStyle = 'rgba(246, 218, 130, 0.10)';
        ctx.beginPath();
        ctx.ellipse(0, 2, 17, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Home colors — a faint repo-tinted ring ties each villager on the
        // mainland to its offshore anchorage. Drawn below the status glow so it
        // never masks state.
        const repoProject = this.agent?.projectPath || this.agent?.project;
        if (repoProject) {
            const repo = this._repoGroundProfile(repoProject);
            ctx.save();
            ctx.globalAlpha = 0.28;
            ctx.strokeStyle = repo.accent;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.ellipse(0, 3, 19, 6, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        if (visual) {
            const isWorking = this.agent?.status === AgentStatus.WORKING;
            const isWaiting = this.agent?.status === AgentStatus.WAITING;
            const isErrored = this.agent?.status === AgentStatus.ERRORED;
            const flash = this.bumpFlash ? this.bumpFlash * 0.26 : 0;
            let workingAlpha = 0.30 + 0.22 * pulse + flash;
            if (isWorking) {
                const totalTokens = Number(this.agent?.tokens?.total) || 0;
                const burnMul = Math.max(0.6, Math.min(1.4, 0.6 + Math.log10(Math.max(1, totalTokens)) / 6));
                workingAlpha *= burnMul;
            }
            if (isErrored) {
                // Red pulsing glow at the feet so failures read at a glance.
                // `pulse` derives from statusAnim, which freezes under reduced
                // motion (motionScale 0) — the glow then holds a fixed alpha.
                ctx.globalAlpha = 0.30 + 0.34 * pulse + flash;
                ctx.fillStyle = visual.glow;
                ctx.beginPath();
                ctx.ellipse(0, 4, this.selected ? 26 : 21, this.selected ? 9 : 7, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = this.selected
                ? 0.95
                : isErrored
                    ? 0.40 + 0.30 * pulse + flash
                    : isWorking
                        ? workingAlpha
                        : isWaiting
                            ? 0.30 + flash
                            : 0.18 + flash;
            ctx.strokeStyle = visual.color;
            ctx.lineWidth = this.selected ? 2 : 1.2;
            ctx.beginPath();
            ctx.ellipse(0, 4, this.selected ? 24 : 18, this.selected ? 8 : 6, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = this.selected ? 0.85 : 0.42;
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(0, 4, this.selected ? 17 : 12, this.selected ? 5 : 4, 0, Math.PI * 0.12, Math.PI * 0.88);
        ctx.stroke();
        ctx.restore();
    }

    _drawFocusPillar(ctx, contentTopY) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        const top = contentTopY - 6;
        const gradient = ctx.createLinearGradient(this.x, top, this.x, this.y + 8);
        gradient.addColorStop(0, this._rgba(trim, 0));
        gradient.addColorStop(0.34, this._rgba(trim, 0.22));
        gradient.addColorStop(1, this._rgba(visual?.color || '#f2d36b', 0.08));
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(this.x - 13, this.y + 8);
        ctx.lineTo(this.x - 4, top);
        ctx.lineTo(this.x + 4, top);
        ctx.lineTo(this.x + 13, this.y + 8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // #4 — a tall amber light-pillar topped with a `!` pennant above any
    // WAITING_ON_USER agent, rising over the crowd so the action-demanding read
    // is never lost in a cluster. PRIMARY tier (never culled). Height and
    // brightness scale with wait duration. Pulse: 'alert' band (medium).
    // Reduced motion (motionScale 0): pulseAlpha returns the band base, so the
    // pillar holds a fixed alpha at fixed height — a static amber beacon.
    _drawWaitingOnUserBeacon(ctx, contentTopY) {
        const governor = getActiveMarkGovernor();
        // PRIMARY always admits at full alpha; consulted for contract symmetry.
        if (governor && !governor.admit(MarkTier.PRIMARY, this.x, this.y).draw) return;

        const amber = THEME.waitingOnUser || '#facc15';
        // Wait-duration ramp: a fresh wait is a modest pillar; a long wait grows
        // taller and brighter so a stale prompt visibly looms.
        const age = Number(this.agent?.activityAgeMs);
        const waitT = Number.isFinite(age) ? Math.max(0, Math.min(1, age / 120_000)) : 0;
        const headY = Number.isFinite(contentTopY) ? contentTopY : this.y - 36;
        const baseHeight = 46 + waitT * 40;
        const top = headY - 10 - baseHeight;
        const brightness = pulseAlpha('alert', this.frame, this.motionScale, 0.55, 1);
        const peakAlpha = (0.30 + waitT * 0.22) * brightness;
        const halfW = 5 + waitT * 2;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const gradient = ctx.createLinearGradient(this.x, top, this.x, headY - 6);
        gradient.addColorStop(0, this._rgba(amber, 0));
        gradient.addColorStop(0.5, this._rgba(amber, peakAlpha));
        gradient.addColorStop(1, this._rgba(amber, peakAlpha * 0.45));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(this.x - 2, headY - 6);
        ctx.lineTo(this.x - halfW, top);
        ctx.lineTo(this.x + halfW, top);
        ctx.lineTo(this.x + 2, headY - 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // `!` pennant cap at the pillar's tip — solid amber so it reads against
        // the sky regardless of the screen-blend gradient below it.
        ctx.save();
        ctx.translate(Math.round(this.x), Math.round(top));
        ctx.globalAlpha = 0.7 + 0.3 * brightness;
        ctx.fillStyle = amber;
        ctx.fillRect(-1, -7, 2, 4);
        ctx.fillRect(-1, -1, 2, 2);
        ctx.restore();
    }

    // X-ray pass: blits the current animation cell with alpha so a selected
    // agent stays visible behind a building's front-half. Avoids the full-
    // sprite-sheet blit that drawing via SpriteRenderer.drawSilhouette would
    // produce against multi-direction agent sheets.
    drawXraySilhouette(ctx) {
        if (!this.spriteCanvas || !this.spriteSheet) return;
        const cell = this.spriteSheet.cell(this.animState, this.direction, this.frame);
        const bounds = this._getCellContentBounds(cell);
        const drawScale = this._spriteDrawScale(this._scaleBounds(cell, bounds));
        const drawX = this._snapWorldToScreenPixel(this.x);
        const drawY = this._snapWorldToScreenPixel(this.y);
        const contentCenterX = (bounds.minX + bounds.maxX) / 2;
        const dx = drawX - contentCenterX * drawScale;
        const dy = drawY - bounds.maxY * drawScale + 2;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 0.4;
        ctx.drawImage(
            this.spriteCanvas,
            cell.sx, cell.sy, cell.sw, cell.sh,
            dx, dy, cell.sw * drawScale, cell.sh * drawScale
        );
        ctx.restore();
    }

    _drawSpriteSilhouette(ctx, cell, dx, dy, drawScale = 1) {
        const silhouette = this._getSilhouetteCell(cell);
        if (!silhouette) return;
        ctx.drawImage(
            silhouette,
            dx - 2 * drawScale,
            dy - 2 * drawScale,
            silhouette.width * drawScale,
            silhouette.height * drawScale
        );
    }

    _getSilhouetteCell(cell) {
        if (!this.spriteCanvas) return null;
        const key = `${cell.sx},${cell.sy},${cell.sw},${cell.sh}`;
        const cached = this._silhouetteCellCache.get(key);
        if (cached) return cached;

        const pad = 2;
        const black = document.createElement('canvas');
        black.width = cell.sw + pad * 2;
        black.height = cell.sh + pad * 2;
        const blackCtx = black.getContext('2d');
        blackCtx.imageSmoothingEnabled = false;
        blackCtx.drawImage(this.spriteCanvas, cell.sx, cell.sy, cell.sw, cell.sh, pad, pad, cell.sw, cell.sh);
        blackCtx.globalCompositeOperation = 'source-in';
        blackCtx.fillStyle = 'black';
        blackCtx.fillRect(0, 0, black.width, black.height);

        const outline = document.createElement('canvas');
        outline.width = black.width;
        outline.height = black.height;
        const outlineCtx = outline.getContext('2d');
        outlineCtx.imageSmoothingEnabled = false;
        outlineCtx.globalAlpha = 0.54;
        const offsets = [
            [-2, 0], [2, 0], [0, -2], [0, 2],
            [-1, -1], [1, -1], [-1, 1], [1, 1],
        ];
        for (const [ox, oy] of offsets) {
            outlineCtx.drawImage(black, ox, oy);
        }
        this._silhouetteCellCache.set(key, outline);
        return outline;
    }

    _drawFrozenTint(ctx, cell, dx, dy, drawScale = 1) {
        const tinted = this._getFrozenTintCell(cell);
        if (!tinted) return;
        ctx.save();
        ctx.globalAlpha *= 0.38;
        ctx.drawImage(tinted, dx, dy, cell.sw * drawScale, cell.sh * drawScale);
        ctx.restore();
    }

    _getFrozenTintCell(cell) {
        if (!this.spriteCanvas) return null;
        const key = `${cell.sx},${cell.sy},${cell.sw},${cell.sh}`;
        const cached = this._frozenTintCellCache.get(key);
        if (cached) return cached;

        const canvas = document.createElement('canvas');
        canvas.width = cell.sw;
        canvas.height = cell.sh;
        const tintCtx = canvas.getContext('2d');
        tintCtx.imageSmoothingEnabled = false;
        tintCtx.drawImage(this.spriteCanvas, cell.sx, cell.sy, cell.sw, cell.sh, 0, 0, cell.sw, cell.sh);
        tintCtx.globalCompositeOperation = 'source-in';
        tintCtx.fillStyle = '#2e4258';   // cold slate; drawn at low alpha over the body
        tintCtx.fillRect(0, 0, canvas.width, canvas.height);
        this._frozenTintCellCache.set(key, canvas);
        return canvas;
    }

    _getCellContentBounds(cell) {
        const key = `${cell.sx},${cell.sy},${cell.sw},${cell.sh}`;
        const cached = this._cellBoundsCache.get(key);
        if (cached) return cached;

        const scratch = document.createElement('canvas');
        scratch.width = cell.sw;
        scratch.height = cell.sh;
        const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
        scratchCtx.imageSmoothingEnabled = false;
        scratchCtx.drawImage(this.spriteCanvas, cell.sx, cell.sy, cell.sw, cell.sh, 0, 0, cell.sw, cell.sh);
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
        const bounds = maxX > minX && maxY > minY
            ? { minX, minY, maxX, maxY }
            : { minX: 24, minY: 12, maxX: cell.sw - 24, maxY: cell.sh - 18 };
        this._cellBoundsCache.set(key, bounds);
        return bounds;
    }

    _spriteDrawScale(bounds) {
        const height = Math.max(1, bounds.maxY - bounds.minY + 1);
        const scale = TARGET_AGENT_CONTENT_HEIGHT / height;
        return Math.max(MIN_AGENT_DRAW_SCALE, Math.min(MAX_AGENT_DRAW_SCALE, scale));
    }

    // Accessory-free content bounds for the cell, published by the compositor
    // when an accessory was baked in. Falls back to the measured (hat-inclusive)
    // bounds when none is present. Used only for body draw-scale (D3).
    _scaleBounds(cell, fallback) {
        const map = this.spriteCanvas?.__cvBaseBounds;
        if (map) {
            const b = map.get(`${cell.sx},${cell.sy},${cell.sw},${cell.sh}`);
            if (b) return b;
        }
        return fallback;
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

    _drawSelectionRing(ctx) {
        if (!this.assets) return;
        // Pulse alpha so the ring breathes (0.7 .. 1.0 sinusoidal).
        const pulseAlpha = 0.7 + 0.3 * Math.sin(this.frame * 0.15);
        const accent = this._providerAccentColor();
        const ring = this.assets.get('overlay.status.selected');
        if (ring) {
            const tinted = this._getTintedSelectionRing(ring, accent) || ring;
            const dx = Math.round(this.x - tinted.width / 2);
            const dy = Math.round(this.y - 6);     // just under feet
            ctx.save();
            ctx.globalAlpha = pulseAlpha;
            ctx.drawImage(tinted, dx, dy);
            ctx.restore();
            return;
        }
        // Fallback: draw a simple ellipse when the overlay asset is not loaded.
        ctx.save();
        ctx.globalAlpha = pulseAlpha;
        ctx.beginPath();
        ctx.ellipse(this.x, this.y + 21, 28, 10, 0, 0, Math.PI * 2);
        ctx.fillStyle = this._rgba(accent, 0.24);
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();
    }

    // Recolors the golden selection-ring asset toward the provider accent while
    // keeping its luminance/shading ('color' composite), then restores the
    // original alpha. Cached per accent color — the base asset is shared.
    _getTintedSelectionRing(ring, accent) {
        if (!ring?.width || !ring?.height) return null;
        const cached = TINTED_SELECTION_RING_CACHE.get(accent);
        if (cached) {
            TINTED_SELECTION_RING_CACHE.delete(accent);
            TINTED_SELECTION_RING_CACHE.set(accent, cached);
            return cached;
        }

        const canvas = document.createElement('canvas');
        canvas.width = ring.width;
        canvas.height = ring.height;
        const tintCtx = canvas.getContext('2d');
        tintCtx.imageSmoothingEnabled = false;
        tintCtx.drawImage(ring, 0, 0);
        tintCtx.globalCompositeOperation = 'color';
        tintCtx.fillStyle = accent;
        tintCtx.fillRect(0, 0, canvas.width, canvas.height);
        tintCtx.globalCompositeOperation = 'destination-in';
        tintCtx.drawImage(ring, 0, 0);
        TINTED_SELECTION_RING_CACHE.set(accent, canvas);
        while (TINTED_SELECTION_RING_CACHE.size > TINTED_SELECTION_RING_CACHE_LIMIT) {
            TINTED_SELECTION_RING_CACHE.delete(TINTED_SELECTION_RING_CACHE.keys().next().value);
        }
        return canvas;
    }

    _drawCodexEquipment(ctx, identity, frameGeometry, layer = 'front') {
        const equipment = this._normalizedCodexEquipment(this._runtimeCodexEquipment(identity));
        if (!equipment) return;

        const directionKey = DIRECTIONS[this.direction] || 's';
        const geometry = this._codexWeaponGeometry(frameGeometry, directionKey);
        const heavyGearBaked = identity?.codexHeavyGearBaked && this.assets?.has?.(identity.spriteId);
        const heavyArmor = !heavyGearBaked && (equipment === 'greatsword' || equipment === 'polearm');
        const warlord = equipment === 'polearm';
        const assetDef = CODEX_WEAPON_ASSETS[equipment] || null;
        const assetDrawsBehindBody = assetDef && this._assetWeaponBackLayer(assetDef, directionKey);

        if (layer === 'back') {
            if (heavyArmor) {
                this._drawGearAt(ctx, geometry.torso, geometry.drawScale, () => {
                    this._drawCodexCape(ctx, warlord, directionKey);
                });
            }

            if (assetDef && assetDrawsBehindBody) {
                this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'asset');
            } else if (equipment === 'engineerWrench' && this._weaponBackCarryDirection(directionKey)) {
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
            if (!assetDrawsBehindBody) this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'asset');
            this._drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, 'hands');
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
        // Effort-tier accessories are permanent — apply immediately (D2).
        if (identity?.allowRuntimeEffortAccessory !== false && identity?.effortAccessory) {
            return this._commitAccessoryImmediate(identity.effortAccessory);
        }
        if (identity?.allowRuntimeRoleAccessory === false) {
            return this._commitAccessoryImmediate(null);
        }
        const resolved = resolveRoleAccessory(agent);
        // Role-derived accessories are permanent too (role is stable). Only
        // tool-driven ones flip mid-session, so those go through hysteresis.
        if (resolved && resolved.source === 'role') {
            return this._commitAccessoryImmediate(resolved.id);
        }
        return this._debouncedToolAccessory(resolved ? resolved.id : null);
    }

    _commitAccessoryImmediate(id) {
        this._committedAccessory = id;
        this._accessoryCandidate = id;
        this._accessoryCandidateSince = Date.now();
        return id;
    }

    _debouncedToolAccessory(candidateId) {
        const now = Date.now();
        // First accessory an agent gets applies immediately (nothing committed
        // yet, or only the "no hat" state).
        if (!this._committedAccessory) {
            return this._commitAccessoryImmediate(candidateId);
        }
        if (candidateId === this._committedAccessory) {
            this._accessoryCandidate = candidateId;
            this._accessoryCandidateSince = now;
            return this._committedAccessory;
        }
        // A different candidate must stay dominant continuously before it wins.
        if (candidateId !== this._accessoryCandidate) {
            this._accessoryCandidate = candidateId;
            this._accessoryCandidateSince = now;
        } else if (now - this._accessoryCandidateSince >= ACCESSORY_HYSTERESIS_MS) {
            this._committedAccessory = candidateId;
        }
        return this._committedAccessory;
    }

    _runtimeEffortFloorRing(identity) {
        if (identity?.allowRuntimeEffortFloorRing === false) return null;
        return identity?.effortFloorRing ?? null;
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

    _drawCodexAssetEquipment(ctx, assetDef, geometry, directionKey, part = 'asset') {
        const poseName = this._weaponPoseName(assetDef, directionKey);
        const pose = geometry[poseName] || geometry.rightHand;
        if (!pose) return;

        if (part === 'asset') {
            this._drawWeaponAt(ctx, {
                ...pose,
                scale: (pose.scale || 1) * (assetDef.scale || 1),
            }, geometry.drawScale, () => this._drawCodexWeaponAssetImage(ctx, assetDef));
            return;
        }

        this._drawWeaponAt(ctx, pose, geometry.drawScale, () => {
            if (assetDef.hands === 'double') this._drawWeaponGripHands(ctx, assetDef.handSpacing || 11, assetDef.handVector);
            else this._drawWeaponGripHand(ctx);
        });
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
        if (directionKey === 'e' || directionKey === 'w') return -0.20;
        if (directionKey === 'ne' || directionKey === 'nw') return -0.34;
        if (directionKey === 'n') return -0.38;
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

    // --- Provider / model helpers ---

    _providerKey(agent = this.agent) {
        const provider = String(agent?.provider || '').toLowerCase();
        const model = String(agent?.model || '').toLowerCase();
        if (model.includes('deepseek')) return 'deepseek';
        if (provider.includes('opencode')) return 'opencode';
        if (provider.includes('gemini') || model.includes('gemini')) return 'gemini';
        if (provider.includes('codex') || model.includes('codex') || model.includes('gpt')) return 'codex';
        if (provider.includes('claude') || model.includes('claude')) return 'claude';
        if (provider.includes('kimi') || model.includes('kimi')) return 'kimi';
        if (provider.includes('grok') || model.includes('grok')) return 'grok';
        return 'default';
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
        const visual = this._statusVisual();
        const thread = this._activityThread();
        if (!thread.length) return;
        // Crowd de-collision (IsometricRenderer._assignAgentBubbleSlots): beyond
        // the slot cap the bubble collapses to a small ellipsis dot so dense
        // clusters stay readable. Selected agents always keep their full bubble.
        if (this.bubbleSuppressed && !this.selected) {
            this._drawBubbleDotMarker(ctx, visual.color, contentTopY);
            return;
        }
        const stackShift = this.bubbleSlot > 0 ? -this.bubbleSlot * STATUS_BUBBLE_STACK_STEP : 0;
        const head = thread[0];
        const useClock = this._shouldUseLongWaitClock(head);
        if (useClock) {
            this._drawLongWaitClockBubble(ctx, head.accent || visual.color, contentTopY, stackShift);
        } else {
            this._drawBubble(ctx, head.text, head.accent || visual.color, contentTopY, head.confidence, stackShift);
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
        ctx.translate(this.x, Number.isFinite(contentTopY) ? contentTopY : this.y);
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

    _shouldUseLongWaitClock(entry) {
        if (!entry || entry.kind !== 'status') return false;
        if (this.agent?.status !== AgentStatus.WAITING) return false;
        const age = Number(this.agent?.activityAgeMs);
        return Number.isFinite(age) && age > 60_000;
    }

    _drawLongWaitClockBubble(ctx, accentColor, contentTopY = null, stackShift = 0) {
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this.x, Number.isFinite(contentTopY) ? contentTopY : this.y);
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

    _drawBubble(ctx, text, accentColor, contentTopY = null, confidence = null, stackShift = 0) {
        ctx.save();
        const s = 1 / (this._zoom || 1); // inverse zoom correction

        ctx.translate(this.x, Number.isFinite(contentTopY) ? contentTopY : this.y);
        ctx.scale(s, s); // fixed size in screen space

        // Measure text size and auto-truncate
        const anchored = Number.isFinite(contentTopY);
        ctx.font = `${anchored ? 10 : 13}px ${WORLD_BODY_FONT}`;
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

        // Text
        ctx.fillStyle = '#f3e2bd';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        this._applyReadableTextShadow(ctx);
        ctx.fillText(displayText, 0, 0, maxWidth);

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
        const fontPx = anchored ? 9 : 11;
        ctx.translate(this.x, Number.isFinite(contentTopY) ? contentTopY : this.y);
        ctx.scale(s, s);
        ctx.font = `${fontPx}px ${WORLD_BODY_FONT}`;

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

    _drawChatEffect(ctx) {
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);

        // #27 — the bare ellipsis is replaced by a small parchment speech-scroll
        // showing what the conversation is actually about: the live tool-category
        // glyph (#9's ToolIdentity classification), tinted by status color. When
        // no tool is active it degrades to the classic animated dots.
        const visual = this._statusVisual();
        const accent = visual?.color || '#72d071';
        const bubbleY = -50;
        const w = 30;
        const h = 24;
        const r = 5;

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

        const tool = String(this.agent?.currentTool || '').trim();
        if (tool) {
            // Live tool glyph: the conversation reads as topically meaningful.
            const building = memoizedToolClassification(tool, this.agent?.currentToolInput)?.building || null;
            const glyph = toolGlyphKey(tool, building);
            ctx.save();
            ctx.translate(0, bubbleY);
            drawToolGlyphBadge(ctx, {
                glyph,
                color: accent,
                panel: 'rgba(0, 0, 0, 0)',
                border: 'rgba(0, 0, 0, 0)',
                size: 11,
                frame: this.frame,
                motionScale: this.motionScale,
            });
            ctx.restore();
        } else {
            // No active tool — fall back to the animated ellipsis (static under
            // reduced motion: holds the full ellipsis instead of cycling).
            const phase = this.motionScale === 0 ? 2 : Math.floor(this.chatBubbleAnim * 1.5) % 3;
            ctx.fillStyle = accent;
            ctx.font = 'bold 12px "Press Start 2P", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(['.', '..', '...'][phase], 0, bubbleY - 1);
        }

        ctx.restore();
    }

    _drawNameTag(ctx) {
        // #14 — when this agent is parked at a building it folds into that
        // building's status-tally chip (set in IsometricRenderer); suppress its
        // own name pill so busy buildings stay legible at low zoom.
        if (this.foldedIntoBuilding && !this.selected) return;
        // #9 — below the full-pill threshold (not selected, zoomed out, or
        // unslotted) fly the compact activity glyph badge instead of the dark
        // name pill; full pills are reserved for selected/zoom >= 1.5.
        if (!this.selected && this._zoom < 1.5) {
            this._drawToolGlyphBadge(ctx);
            return;
        }
        if (!this.selected && this.nameTagSlot == null) {
            this._drawToolGlyphBadge(ctx);
            return;
        }
        ctx.save();
        ctx.globalAlpha *= this.selected ? 1 : (this.labelAlpha ?? 1);
        const s = 1 / (this._zoom || 1); // inverse zoom correction
        ctx.translate(this.x, this.y);
        ctx.scale(s, s); // fixed size in screen space
        ctx.translate(0, 38 + this._nameTagSlotYOffset());
        const baseName = String(this.agent.name || this.agent.displayName || '').trim() || this.agent.displayName;
        // 4.8 — earned nickname renders as a title suffix on the full tag
        // (compact labels stay nickname-free to avoid clutter).
        const rawName = this.nickname ? `${baseName} ${this.nickname}` : baseName;
        ctx.font = `${NAME_TAG_FONT_PX}px ${WORLD_BODY_FONT}`;
        const layout = this._nameTagLayout(ctx, rawName);
        const lines = layout.lines;
        const contentW = layout.contentW;
        const w = Math.min(NAME_TAG_MAX_WIDTH, contentW + NAME_TAG_PADDING_X);
        const repo = this._repoNameTagProfile();
        ctx.fillStyle = repo.panel;
        const h = lines.length > 1 ? NAME_TAG_DOUBLE_HEIGHT : NAME_TAG_SINGLE_HEIGHT;
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(-w/2 + r, -h/2);
        ctx.lineTo(w/2 - r, -h/2);
        ctx.quadraticCurveTo(w/2, -h/2, w/2, -h/2 + r);
        ctx.lineTo(w/2, h/2 - r);
        ctx.quadraticCurveTo(w/2, h/2, w/2 - r, h/2);
        ctx.lineTo(-w/2 + r, h/2);
        ctx.quadraticCurveTo(-w/2, h/2, -w/2, h/2 - r);
        ctx.lineTo(-w/2, -h/2 + r);
        ctx.quadraticCurveTo(-w/2, -h/2, -w/2 + r, -h/2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = repo.panelBorder || repo.accent;
        ctx.lineWidth = this.selected ? 2 : 1.25;
        ctx.stroke();
        if (this.selected) {
            ctx.strokeStyle = repo.panelBorder || repo.accent;
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(-w / 2 + 3) + 0.5, Math.round(-h / 2 + 3) + 0.5, Math.max(1, Math.round(w - 6)), Math.max(1, Math.round(h - 6)));
        }
        this._drawRepoLabelGlyph(ctx, -w / 2 + 8, 0, NAME_TAG_GLYPH_SIZE, repo);
        ctx.fillStyle = repo.labelText || repo.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        this._applyReadableTextShadow(ctx);
        ctx.shadowOffsetX = 0; // vertical-only: avoid doubling Departure Mono's hairlines
        if (lines.length === 1) {
            ctx.fillText(lines[0], 3, 0.5);
        } else {
            ctx.fillText(lines[0], 3, -4);
            ctx.fillText(lines[1], 3, 5);
        }
        ctx.restore();
    }

    _nameTagSlotYOffset() {
        const offsets = [0, -10, 10, -18, 18, -26, 26, -34, 34];
        return offsets[Math.min(this.nameTagSlot || 0, offsets.length - 1)];
    }

    _drawCompactAgentBadge(ctx) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        const s = 1 / (this._zoom || 1);
        ctx.save();
        ctx.globalAlpha *= this.selected ? 1 : (this.labelAlpha ?? 1);
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);
        ctx.translate(0, 16 + (this.overlaySlot || 0) * 9);
        ctx.fillStyle = 'rgba(20, 14, 10, 0.78)';
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-9, -5, 18, 10, 3);
        } else {
            ctx.rect(-9, -5, 18, 10);
        }
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = visual?.color || trim;
        ctx.font = 'bold 6px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(visual?.mark || '.', 0, 0.5);
        ctx.restore();
    }

    _drawCompactNameStatus(ctx) {
        const repo = this._repoNameTagProfile();
        const rawName = String(this.agent?.name || this.agent?.displayName || '').trim() || 'Agent';
        const s = 1 / (this._zoom || 1);
        const slot = this.overlaySlot ?? this.nameTagSlot ?? 0;
        const providerKey = this._providerKey();
        const providerColor = PROVIDER_BADGE_COLORS[providerKey] || PROVIDER_BADGE_COLORS.default;
        const identity = getModelVisualIdentity(this.agent?.model, this.agent?.effort, this.agent?.provider);
        const tierColor = MODEL_TIER_COLORS[identity?.modelTier] || MODEL_TIER_COLORS.balanced;

        ctx.save();
        ctx.globalAlpha *= this.selected ? 1 : (this.labelAlpha ?? 1);
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);
        ctx.translate(0, COMPACT_NAME_SLOT_BASE_Y + slot * COMPACT_NAME_SLOT_STEP_Y);
        ctx.font = `${COMPACT_NAME_FONT_PX}px ${WORLD_BODY_FONT}`;
        const layout = this._compactNameStatusLayout(ctx, rawName);
        const text = layout.text;
        const w = layout.width;
        const h = COMPACT_NAME_HEIGHT;

        ctx.fillStyle = repo.panel;
        ctx.strokeStyle = repo.panelBorder || repo.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-w / 2, -h / 2, w, h, 4);
        } else {
            ctx.rect(-w / 2, -h / 2, w, h);
        }
        ctx.fill();
        ctx.stroke();

        const glyphLeft = -w / 2 + 5;
        this._drawProviderMarkGlyph(ctx, glyphLeft, 0, COMPACT_NAME_GLYPH_SIZE, providerColor);
        this._drawModelTierDotGlyph(ctx, glyphLeft + 7, 0, COMPACT_NAME_GLYPH_SIZE, tierColor);
        this._drawRepoLabelGlyph(ctx, glyphLeft + 14, 0, COMPACT_NAME_GLYPH_SIZE, repo);

        const textAreaLeft = glyphLeft + 18 + 3;
        const textAreaRight = w / 2 - 4;
        const textCenter = (textAreaLeft + textAreaRight) / 2;
        ctx.fillStyle = repo.labelText || repo.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        this._applyReadableTextShadow(ctx);
        ctx.shadowOffsetX = 0; // vertical-only: avoid doubling Departure Mono's hairlines
        ctx.fillText(text, Math.round(textCenter), 0.5);
        ctx.restore();
    }

    // #9 — Activity glyph badge: the compact replacement for the dark name pill.
    // A tiny illuminated tool-category emblem tinted by status, so a busy scene
    // reads as a constellation of glowing trade-icons that never overlap into
    // mush. Pills are reserved for the selected agent and zoom >= 1.5 (the full
    // tag path); this draws in the otherwise-compact case. The emblem itself is
    // SECONDARY (status color carries the read) and never overlaps text.
    // Reduced-motion: the glyph's lit glow freezes to a steady mid-intensity.
    _drawToolGlyphBadge(ctx) {
        const visual = this._statusVisual();
        const repo = this._repoNameTagProfile();
        const tool = String(this.agent?.currentTool || '').trim();
        // Reuse the live tool classification so the glyph picks the same building
        // the agent is routing toward (web -> globe, mine -> pick, etc.).
        const building = tool
            ? (memoizedToolClassification(tool, this.agent?.currentToolInput)?.building || null)
            : null;
        const glyph = toolGlyphKey(tool, building);
        const s = 1 / (this._zoom || 1);
        const slot = this.overlaySlot ?? this.nameTagSlot ?? 0;

        ctx.save();
        ctx.globalAlpha *= this.selected ? 1 : (this.labelAlpha ?? 1);
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);
        ctx.translate(0, COMPACT_NAME_SLOT_BASE_Y + slot * COMPACT_NAME_SLOT_STEP_Y);
        drawToolGlyphBadge(ctx, {
            glyph,
            color: visual?.color || repo.accent || '#f2d36b',
            panel: repo.panel,
            border: repo.panelBorder || repo.accent,
            size: TOOL_GLYPH_BADGE_SIZE,
            frame: this.frame,
            motionScale: this.motionScale,
        });
        ctx.restore();
    }

    _drawProviderMarkGlyph(ctx, x, y, size, color) {
        const r = size / 2;
        ctx.save();
        ctx.shadowColor = 'rgba(8, 5, 4, 0.7)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(255, 242, 190, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(x - r, y - r, size, size);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    _drawModelTierDotGlyph(ctx, x, y, size, color) {
        const r = size / 2;
        ctx.save();
        ctx.shadowColor = 'rgba(8, 5, 4, 0.7)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(255, 242, 190, 0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    _repoNameTagProfile() {
        const project = this.agent?.projectPath || this.agent?.project || this.agent?.teamName || this.agent?.provider || 'unknown';
        return repoProfile(project);
    }

    /** Repo color profile for the home-color ground ring, cached per projectPath. */
    _repoGroundProfile(project) {
        if (this._repoGroundProfileKey !== project) {
            this._repoGroundProfileKey = project;
            this._repoGroundProfileCache = repoProfile(project);
        }
        return this._repoGroundProfileCache;
    }

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
        const headY = Number.isFinite(contentTopY) ? contentTopY + 12 : this.y - 36;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha *= (1 - t) * 0.85;
        ctx.fillStyle = color;
        // ~5 sparkle dots radiating outward from the head.
        const baseRadius = 6 + t * 22;
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2 + t * 0.6;
            const r = baseRadius + ((i * 13) % 7);
            const sx = this.x + Math.cos(angle) * r;
            const sy = headY + Math.sin(angle) * r * 0.55;
            const size = 1.6 + (1 - t) * 1.2;
            ctx.beginPath();
            ctx.arc(sx, sy, size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // #32 — arrival rune ring. A portal-cyan ring of rune ticks expanding at the
    // feet over the ceremony window, fading as it grows. Procedural and self-
    // contained (no ParticleSystem access from draw), mirroring _drawArchiveSparkle.
    _drawArrivalRuneRing(ctx, progress) {
        const eased = easeOutCubic(progress);
        const cx = Math.round(this.x);
        const cy = Math.round(this.y - 2);
        const radius = 8 + eased * 20;
        const alpha = (1 - progress) * 0.8;
        if (alpha <= 0) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#8feaff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, cy, radius, radius * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        // Rune ticks around the ring spinning slowly as it rises.
        ctx.fillStyle = '#d7b8ff';
        const spin = progress * 1.4;
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2 + spin;
            const rx = cx + Math.cos(angle) * radius;
            const ry = cy + Math.sin(angle) * radius * 0.5;
            ctx.fillRect(rx - 1, ry - 1, 2, 2);
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

    _captureActivitySnapshot(agent = this.agent, timestamp = Date.now()) {
        const entry = this._activityEntryForAgent(agent, timestamp);
        if (entry) return entry;
        return {
            kind: 'status',
            key: `status:${AgentStatus.IDLE}`,
            text: 'IDLE',
            accent: STATUS_VISUALS[AgentStatus.IDLE]?.color || '#8fb7cf',
            timestamp,
        };
    }

    _activityEntryForAgent(agent = this.agent, timestamp = Date.now()) {
        if (!agent) return null;
        const entryTimestamp = Number(agent.lastSessionActivity) || timestamp;
        const activityAge = Number(agent.activityAgeMs);
        const hasFreshActivity = !Number.isFinite(activityAge) || activityAge <= ACTIVITY_BUBBLE_TTL_MS;

        // 4.1 — occasionally speak village lore instead of the tool label.
        // pickLoreLine is deterministic per agent + 45 s bucket, so this is
        // flicker-free when called every frame; mood (2.2) tints the tone.
        const moodType = agent.mood?.type || null;
        const loreLine = pickLoreLine({
            seedKey: agent.id,
            buildingType: this._lastBuildingType || agent.lastKnownBuildingType || null,
            mood: moodType,
        });
        if (loreLine) {
            return {
                kind: 'lore',
                key: `lore:${loreLine}`,
                text: this._truncateActivityText(loreLine, ACTIVITY_TEXT_CAP),
                accent: MOOD_ACCENTS[moodType] || LORE_ACCENT_DEFAULT,
                timestamp: entryTimestamp,
            };
        }

        const currentTool = String(agent.currentTool || '').trim();
        if (currentTool && hasFreshActivity) {
            const classified = memoizedToolClassification(currentTool, agent.currentToolInput);
            const confidence = Number(classified?.confidence);
            const toolLabel = this._toolActivityLabel(currentTool);
            const detail = compactToolInput(agent.currentToolInput, TOOL_DETAIL_PREVIEW_CHARS);
            const detailKey = compactToolInput(agent.currentToolInput, TOOL_DETAIL_KEY_CHARS);
            const text = detail ? `${toolLabel} ${detail}` : toolLabel;
            return {
                kind: 'tool',
                key: `tool:${currentTool}:${detailKey}`,
                text: this._truncateActivityText(text, ACTIVITY_TEXT_CAP),
                accent: this._providerTrimColor(agent),
                tool: currentTool,
                category: toolCategory(currentTool),
                confidence: Number.isFinite(confidence) ? confidence : null,
                timestamp: entryTimestamp,
            };
        }

        const rawMessage = String(agent.lastMessage || '').replace(/\s+/g, ' ').trim();
        if (rawMessage && hasFreshActivity) {
            const quoted = `"${this._truncateActivityText(rawMessage, MESSAGE_TEXT_CAP)}"`;
            return {
                kind: 'message',
                key: `message:${rawMessage}`,
                text: quoted,
                accent: '#8fc4ff',
                timestamp: entryTimestamp,
            };
        }

        const visual = this._statusVisualFor(agent);
        const rawStatus = agent?.status;
        const status = typeof rawStatus === 'string' ? rawStatus : (rawStatus?.value || AgentStatus.IDLE);
        return {
            kind: 'status',
            key: `status:${status}`,
            text: visual?.label || 'IDLE',
            accent: visual?.color || STATUS_VISUALS[AgentStatus.IDLE]?.color || '#8fb7cf',
            timestamp,
        };
    }

    _rememberActivitySnapshot(entry, timestamp = Date.now()) {
        if (!entry?.text || !entry?.key) return;
        // Status and lore bubbles are flavor, not work history.
        if (entry.kind === 'status' || entry.kind === 'lore') return;
        this._pruneActivityTrail(timestamp);
        const latest = this._activityTrail[0];
        if (latest?.key === entry.key) {
            latest.timestamp = Number.isFinite(Number(entry.timestamp)) ? Number(entry.timestamp) : timestamp;
            latest.confidence = Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : null;
            return;
        }
        this._activityTrail.unshift({
            kind: entry.kind || 'tool',
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

    _toolActivityLabel(toolName) {
        const tool = String(toolName || '').trim();
        if (!tool) return 'Working';
        const override = TOOL_ACTIVITY_LABEL_OVERRIDES[tool];
        if (override) return override;
        const labeled = toolActionLabel(tool);
        if (labeled) return labeled;
        const readable = tool
            .split('.')
            .pop()
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .trim();
        return readable || 'Working';
    }

    _truncateActivityText(text, cap = ACTIVITY_TEXT_CAP) {
        const source = String(text || '').replace(/\s+/g, ' ').trim();
        if (!source) return '';
        if (source.length <= cap) return source;
        return `${source.slice(0, Math.max(1, cap - 1))}…`;
    }

    _nameTagLayout(ctx, rawName) {
        const fontStatus = typeof document !== 'undefined' ? document.fonts?.status || 'unknown' : 'unknown';
        const key = `${rawName}|${ctx.font}|${fontStatus}`;
        if (this._nameTagLayoutCacheKey === key && this._nameTagLayoutCache) {
            return this._nameTagLayoutCache;
        }
        const lines = this._wrapNameTagLines(ctx, rawName);
        const contentW = Math.max(...lines.map(line => ctx.measureText(line).width));
        const layout = { lines, contentW };
        this._nameTagLayoutCacheKey = key;
        this._nameTagLayoutCache = layout;
        return layout;
    }

    _bubbleLayout(ctx, text, maxWidth, anchored) {
        const source = String(text || '');
        const fontStatus = typeof document !== 'undefined' ? document.fonts?.status || 'unknown' : 'unknown';
        const key = `${source}|${maxWidth}|${ctx.font}|${anchored ? 1 : 0}|${fontStatus}`;
        if (this._bubbleLayoutCacheKey === key && this._bubbleLayoutCache) return this._bubbleLayoutCache;
        let displayText = source;
        while (displayText.length > 0 && ctx.measureText(displayText).width > maxWidth) {
            displayText = displayText.substring(0, displayText.length - 1);
        }
        if (displayText.length < source.length) {
            displayText = displayText.substring(0, displayText.length - 1) + '…';
        }
        const layout = {
            displayText,
            textWidth: ctx.measureText(displayText).width,
        };
        this._bubbleLayoutCacheKey = key;
        this._bubbleLayoutCache = layout;
        return layout;
    }

    _compactNameStatusLayout(ctx, rawName) {
        const fontStatus = typeof document !== 'undefined' ? document.fonts?.status || 'unknown' : 'unknown';
        const key = `${rawName}|${ctx.font}|${COMPACT_NAME_MAX_TEXT_WIDTH}|${fontStatus}`;
        if (this._compactNameStatusCacheKey === key && this._compactNameStatusCache) {
            return this._compactNameStatusCache;
        }
        const text = this._fitText(ctx, rawName, COMPACT_NAME_MAX_TEXT_WIDTH);
        const width = Math.min(
            COMPACT_NAME_MAX_WIDTH,
            Math.max(COMPACT_NAME_MIN_WIDTH, ctx.measureText(text).width + COMPACT_NAME_EXTRA_WIDTH),
        );
        const layout = { text, width };
        this._compactNameStatusCacheKey = key;
        this._compactNameStatusCache = layout;
        return layout;
    }

    _applyReadableTextShadow(ctx) {
        ctx.shadowColor = 'rgba(8, 5, 4, 0.86)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    }

    _drawRepoLabelGlyph(ctx, x, y, size, repo) {
        const r = size / 2;
        ctx.save();
        ctx.shadowColor = 'rgba(8, 5, 4, 0.7)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.fillStyle = repo.accent || '#f6d384';
        ctx.strokeStyle = 'rgba(255, 242, 190, 0.88)';
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

    _statusEmoteKind() {
        const status = this.agent?.status;
        if (status === AgentStatus.RATE_LIMITED) return 'rate_limited';
        if (status === AgentStatus.ERRORED) return 'errored';
        if (status === AgentStatus.WAITING_ON_USER) return 'waiting_on_user';
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
        ctx.translate(this.x, contentTopY);
        ctx.scale(s, s);
        ctx.translate(0, -14);
        const box = 12;
        if (kind === 'rate_limited') {
            this._drawHourglassGlyph(ctx, box, '#ffa64d');
        } else if (kind === 'errored') {
            this._drawAlertCircleGlyph(ctx, box, '#ff5a5a', '!');
        } else if (kind === 'waiting_on_user') {
            this._drawAlertCircleGlyph(ctx, box, '#ffd13a', '?');
        } else if (kind === 'completed') {
            this._drawCheckGlyph(ctx, box, '#7be39a');
        } else if (kind === 'thinking') {
            this._drawThinkingDotsGlyph(ctx, box, '#cfd6df');
        }
        ctx.restore();
    }

    _drawPlanModeGlyph(ctx, contentTopY) {
        // Hide when a status emote is rendering — status emote wins the slot.
        if (!Number.isFinite(contentTopY)) return;
        if (!this.behavior?.planMode) return;
        if (this._statusEmoteKind()) return;
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this.x, contentTopY);
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
        ctx.translate(this.x, contentTopY);
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

    _drawHourglassGlyph(ctx, box, color) {
        const half = box / 2;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-half, -half);
        ctx.lineTo(half, -half);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-half, half);
        ctx.lineTo(half, half);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(8, 5, 4, 0.8)';
        ctx.beginPath();
        ctx.moveTo(-half, -half);
        ctx.lineTo(half, -half);
        ctx.moveTo(-half, half);
        ctx.lineTo(half, half);
        ctx.stroke();
    }

    _drawAlertCircleGlyph(ctx, box, color, mark) {
        const r = box / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1a1208';
        ctx.font = `bold ${Math.round(box - 2)}px "Press Start 2P", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(mark, 0, 1);
    }

    _drawCheckGlyph(ctx, box, color) {
        const half = box / 2;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(-half + 1, 0);
        ctx.lineTo(-1, half - 1);
        ctx.lineTo(half - 1, -half + 2);
        ctx.stroke();
    }

    _drawThinkingDotsGlyph(ctx, box, color) {
        const dotSize = 2;
        const gap = 3;
        const animated = this.motionScale > 0;
        const phase = animated ? Math.floor(this.frame * 0.1) % 3 : -1;
        for (let i = 0; i < 3; i++) {
            ctx.fillStyle = color;
            ctx.globalAlpha = phase === i || phase === -1 ? 1 : 0.45;
            ctx.beginPath();
            ctx.arc(-gap + i * gap, 0, dotSize / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        void box;
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
        const phase = this.motionScale > 0 ? Math.floor(this.frame * 0.1) % 2 : 0;

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
            ctx.save();
            ctx.fillStyle = this._statusVisual()?.color || '#7be39a';
            ctx.globalAlpha = 0.7 + (phase ? 0.3 : 0);
            ctx.beginPath();
            ctx.arc(handX, handY, 1.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            return;
        }

        if (status === AgentStatus.WAITING && !this._statusEmoteKind()) {
            ctx.save();
            ctx.strokeStyle = this._statusVisual()?.color || '#df8c3f';
            ctx.lineWidth = 1.2;
            ctx.globalAlpha = 0.85;
            const baseY = dy + (bounds.minY - 4) * drawScale;
            ctx.beginPath();
            ctx.moveTo(centerX - 3, baseY);
            ctx.lineTo(centerX, baseY + 3);
            ctx.lineTo(centerX + 3, baseY);
            ctx.stroke();
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
        let dy = -28;
        if (mood.type === 'distressed') { preset = 'fretMote'; period = 2200; dy = -34; }
        else if (mood.type === 'proud') { preset = 'sparkle'; period = 3400; dy = -40; }
        else return;

        // Stagger beats per agent so a crowd does not pulse in unison.
        const offset = Math.abs(this._hash(`${this.agent?.id || ''}:mood-mote`)) % period;
        const beat = Math.floor((Date.now() + offset) / period);
        if (beat === this._moodMoteBeat) return;
        this._moodMoteBeat = beat;
        particleSystem.spawn(preset, this.x, this.y + dy, 1);
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
        const originY = this.y - 24;
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
            layer: 'effects',
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
            particleSystem.spawn('distressRelief', this.x, this.y - 30, 7);
        }
        this._stormingLast = storming;
    }

    // #32 — arrival ceremony particle burst. Fires once when the villager lands
    // (setArrivalState armed `_arrivalBurstPending`): a portal-rune ring rising
    // around the feet plus a low dust puff kicked up by the materialization.
    // Runs in update() where the pool is live; reduced motion never arms it.
    _advanceArrivalCeremony(particleSystem) {
        if (!this._arrivalBurstPending) return;
        this._arrivalBurstPending = false;
        if (!particleSystem || this.motionScale <= 0) return;
        particleSystem.spawn('portalRune', this.x, this.y - 14, 6, { spread: 10 });
        particleSystem.spawn('footstep', this.x, this.y + 6, 5, { spread: 9 });
    }

    // Arrival ceremony progress in [0, 1] over ARRIVAL_CEREMONY_MS, or 0 when
    // inactive. Drives the draw() scale-up pop + rune ring.
    _arrivalCeremonyProgress(now = Date.now()) {
        if (!this._arrivalCeremonyAt) return 0;
        const elapsed = now - this._arrivalCeremonyAt;
        if (elapsed < 0) return 0;
        if (elapsed >= ARRIVAL_CEREMONY_MS) {
            this._arrivalCeremonyAt = 0;
            return 0;
        }
        return elapsed / ARRIVAL_CEREMONY_MS;
    }

    // Building work-gesture downbeat: spawn one particle per gesture cycle so
    // the swing/turn/unfurl lands a spark, page mote, dust puff, etc. on its
    // peak. Runs in update() (where the pool is available); reduced motion
    // (motionScale 0 / paused ritual) fires nothing — the draw path shows a
    // static posed frame instead.
    _advanceToolRitualGesture(particleSystem) {
        const ritual = this._toolRitual;
        if (!ritual?.pose || !particleSystem || this.chatting || this.moving) return;
        if (this.motionScale <= 0 || ritual.motionEnabled === false || ritual.phase === 'fading') return;
        const period = RITUAL_GESTURE_PERIOD_MS[ritual.pose];
        if (!period) return;
        const cycle = Math.floor(Date.now() / period);
        if (cycle === this._ritualDownbeat) return;
        this._ritualDownbeat = cycle;
        const emit = RITUAL_GESTURE_PARTICLE[ritual.pose];
        if (!emit) return;
        particleSystem.spawn(emit.preset, this.x + (emit.dx || 0), this.y + (emit.dy || 0), emit.count || 2);
    }

    // Tool ritual pose overlay driven by RitualConductor: a small procedural
    // work gesture at hand/tool height — hammer-tick at the forge, page-turn at
    // the archive, pick-swing at the mine, scroll-unfurl at the taskboard, plus
    // a gaze (observatory), conjure (portal), signal (command), haul (harbor),
    // and scan (watchtower). No new image assets; reduced motion renders each
    // gesture as a single static frame (no swing offset, no particle).
    _drawToolRitualOverlay(ctx, frameGeometry) {
        const ritual = this._toolRitual;
        if (!ritual?.pose || this.chatting || this.moving) return;
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
        ctx.save();
        if (ritual.phase === 'fading') ctx.globalAlpha *= 0.5;
        switch (ritual.pose) {
            case 'hammer':
                this._drawHammerGesture(ctx, centerX, handY, sideSign, swing);
                break;
            case 'page':
                this._drawPageGesture(ctx, centerX, handY, animated, phase);
                break;
            case 'pick':
                this._drawPickGesture(ctx, centerX, handY, sideSign, swing);
                break;
            case 'scroll':
                this._drawScrollGesture(ctx, centerX, handY, swing);
                break;
            case 'gaze':
                this._drawGazeGesture(ctx, centerX, headY, sideSign, swing);
                break;
            case 'conjure':
                this._drawConjureGesture(ctx, centerX, handY, swing);
                break;
            case 'signal':
                this._drawSignalGesture(ctx, centerX, headY, sideSign, swing);
                break;
            case 'haul':
                this._drawHaulGesture(ctx, centerX, handY, swing);
                break;
            case 'scan':
                this._drawScanGesture(ctx, centerX, headY, sideSign, swing);
                break;
        }
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

    _snapWorldToScreenPixel(value) {
        const zoom = this._zoom || 1;
        return Math.round(value * zoom) / zoom;
    }

    _drawLowZoomImpostor(ctx) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        ctx.save();
        ctx.translate(Math.round(this.x), Math.round(this.y));
        ctx.fillStyle = 'rgba(7, 10, 12, 0.84)';
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(0, -17);
        ctx.lineTo(9, 1);
        ctx.lineTo(0, 8);
        ctx.lineTo(-9, 1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = visual?.color || trim;
        ctx.beginPath();
        ctx.arc(0, -3, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawBudgetImpostor(ctx) {
        const visual = this._statusVisual();
        const trim = this._providerTrimColor();
        const provider = this._providerAccentColor();
        const x = Math.round(this.x);
        const y = Math.round(this.y);
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = 'rgba(5, 8, 12, 0.48)';
        ctx.beginPath();
        ctx.ellipse(0, 5, 13, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(7, 10, 12, 0.86)';
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, -13);
        ctx.lineTo(8, 0);
        ctx.lineTo(0, 7);
        ctx.lineTo(-8, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = provider;
        ctx.fillRect(-2, -8, 4, 3);
        ctx.fillStyle = visual?.color || trim;
        ctx.beginPath();
        ctx.arc(0, -2, 3, 0, Math.PI * 2);
        ctx.fill();
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

    _wrapNameTagLines(ctx, rawName) {
        const name = String(rawName || '').trim();
        if (!name) return ['Agent'];
        if (ctx.measureText(name).width <= NAME_TAG_MAX_TEXT_WIDTH) return [name];

        const parts = name
            .replace(/-/g, '- ')
            .split(/\s+/)
            .filter(Boolean);

        const lines = [];
        let current = '';
        for (const part of parts) {
            const joiner = current && !current.endsWith('-') ? ' ' : '';
            const candidate = `${current}${joiner}${part}`;
            if (!current || ctx.measureText(candidate).width <= NAME_TAG_MAX_TEXT_WIDTH) {
                current = candidate;
                continue;
            }
            lines.push(current.trim());
            current = part;
            if (lines.length === 1) break;
        }
        if (current && lines.length < 2) lines.push(current.trim());

        if (lines.length === 0) return [this._truncateNameTagLine(ctx, name, NAME_TAG_MAX_TEXT_WIDTH)];
        if (lines.length === 1) return [this._truncateNameTagLine(ctx, lines[0], NAME_TAG_MAX_TEXT_WIDTH)];

        const consumed = lines.join(' ').replace(/- /g, '-');
        const normalized = name.replace(/\s+/g, ' ');
        if (consumed.length < normalized.length) {
            const remaining = normalized.slice(consumed.length).trim();
            lines[1] = this._truncateNameTagLine(ctx, `${lines[1]} ${remaining}`.trim(), NAME_TAG_MAX_TEXT_WIDTH);
        } else {
            lines[1] = this._truncateNameTagLine(ctx, lines[1], NAME_TAG_MAX_TEXT_WIDTH);
        }
        return lines.slice(0, 2).map(line => line.replace(/- /g, '-'));
    }

    _truncateNameTagLine(ctx, text, maxWidth) {
        let out = String(text || '').trim().replace(/- /g, '-');
        if (ctx.measureText(out).width <= maxWidth) return out;
        while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
            out = out.slice(0, -1);
        }
        return `${out}…`;
    }

    _fitText(ctx, text, maxWidth) {
        let out = String(text || '').trim();
        if (!out) return '';
        if (ctx.measureText(out).width <= maxWidth) return out;
        while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
            out = out.slice(0, -1);
        }
        return `${out}…`;
    }

    hitTest(screenX, screenY) {
        if (this.isArrivalPending()) return false;
        const dx = screenX - this.x;
        const dy = screenY - this.y;
        return Math.abs(dx) < SPRITE_HIT_HALF_WIDTH && dy > SPRITE_HIT_TOP && dy < SPRITE_HIT_BOTTOM;
    }
}

function providerMoteColor(agent) {
    const provider = String(agent?.provider || '').toLowerCase();
    const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
    if (identity.trim?.[0]) return identity.trim[0];
    return PROVIDER_TRIM[provider] || PROVIDER_TRIM.default;
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
        const staticAngle = (Math.PI * 2 * i) / Math.max(1, children.length);
        const angle = motion
            ? staticAngle + base * Math.PI * 2 + (now / 900) * (i % 2 ? -1 : 1)
            : staticAngle;
        const orbitX = Math.cos(angle) * 18;
        const orbitY = -50 + Math.sin(angle) * 7;
        return {
            agent,
            index: i,
            x: parentSprite.x + orbitX,
            y: parentSprite.y + orbitY,
            orbitX,
            orbitY,
            radius: 4 + i * 0.6,
            color: providerMoteColor(agent),
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
        const { orbitX, orbitY, radius, color } = entry;
        const alpha = Math.min(1, 0.58 * lightBoost * selectedBoost);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = parentSprite._rgba?.(color, 0.30) || color;
        ctx.beginPath();
        ctx.arc(orbitX, orbitY, radius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, alpha + 0.18);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(orbitX, orbitY, radius, 0, Math.PI * 2);
        ctx.fill();
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
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x - 9, y - 7, 18, 12, 3);
            ctx.fill();
            ctx.stroke();
        } else {
            ctx.fillRect(x - 9, y - 7, 18, 12);
            ctx.strokeRect(x - 9, y - 7, 18, 12);
        }
        ctx.fillStyle = '#f8ead1';
        ctx.font = 'bold 6px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${hiddenCount}`, x, y);
    }

    ctx.restore();
}
