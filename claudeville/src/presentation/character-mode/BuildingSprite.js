// BuildingSprite replaces BuildingRenderer. Draws buildings from sprites,
// exposes emitter points for particles, supports occlusion split for hero
// buildings. Reimplements the full BuildingRenderer external surface
// (setBuildings, setAgentSprites, setMotionScale, update, drawShadows,
// drawLabels, getLightSources, hitTest, hoveredBuilding-as-setHovered).
//
// Roof-fade behaviour is intentionally dropped per spec §3.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { STATUS_VISUALS, WORLD_BODY_FONT_11, WORLD_BODY_FONT_22, WORLD_DISPLAY_FONT_8, WORLD_DISPLAY_FONT_16 } from '../../config/theme.js';
import { EVENT_SHAPES } from '../shared/EventShapes.js';
import {
    LABEL_INK,
    WALNUT,
    drawOutlinedMotif,
    fitLabelText,
    measureLabelText,
    paintWalnutBoard,
    snapScreenOrigin,
} from './WorldLabelKit.js';
import { fillPixelEllipse } from './PixelShapes.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { ACTIONABLE_BUCKETS, bucketForStatus, isActionableBucket } from '../../domain/services/SignalLedger.js';
import { BUILDING_EVENTS, eventBus } from '../../domain/events/DomainEvent.js';
import { classifyTool, toolVerbLabel } from '../../domain/services/ToolIdentity.js';
import { repoProfile } from '../shared/RepoColor.js';
import { squadMusterLines } from './RelationshipState.js';
import { getReservedRects } from '../shared/ReservedRects.js';
import { fireBreath, normalizeLightSource } from './LightSourceRegistry.js';
import { normalizeLightingState, seasonShiftFor, smokeWindDrift, sourceEnergyFor } from './AtmosphereState.js';
import { lampCourseAt } from './GradeEvaluator.js';
import { seasonTokenForAtmosphere } from './SeasonalAmbience.js';
import { isWorkingVisitor, NON_WORKING_VISIT_ROLES } from './VisitIntentManager.js';
import { attentionBannerState, BuildingPartGates } from './BuildingPartGates.js';
import { dayPartBeatsAt } from './AmbientEvents.js';
import { paintWreath } from './VillageCalendar.js';
import { bakeEmitterCycle, emitterCyclePhase } from './EmitterCycle.js';
import { ART_RAMPS } from '../../config/artPalette.js';
import { castLightingFor, castOverWater, structureCast } from './RakingLight.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { buildingCenterToWorld, tileToWorld, worldToTile } from './Projection.js';
import { frontEdgeFoot, landmarkFootprint } from './FootprintField.js';
import { GPU_LANDMARK_IDS } from './gpu/GpuSceneBuilder.js';
import { BEAM_NEAR_HALF_WIDTH } from './gpu/GpuFrameState.js';
import {
    TaskboardBoardModel,
    taskboardBoardLayout,
} from './TaskboardBoardModel.js';
import {
    advanceNightOccupancyGate,
    buildingEmissiveGate,
    nightWindowGate,
} from './NightOccupancyGate.js';
import {
    BUILDING_EMITTER_FALLBACKS,
    BUILDING_LIGHT_FALLBACKS,
    EMITTER_LIGHTS,
    getBuildingAttentionBanner,
    getBuildingBeaconBase,
    getBuildingDoorSpillDescriptor,
    getBuildingEffectAnchor,
    getBuildingLabelAccent,
    getBuildingLabelPriority,
    getBuildingOccupancyState,
    getBuildingPennantAnchor,
    getBuildingVisual,
    getBuildingWindowColor,
    getBuildingWindowRects,
    LIGHT_SOURCE_REGISTRY,
    windowRectBounds,
} from './BuildingVisualRegistry.js';
import {
    getBuildingApertureProfile,
    getBuildingAssayProfile,
    getBuildingPlanTabProfile,
    getBuildingRestLayer,
    getBuildingRoomProfile,
    getBuildingWorkloadProfile,
    isBuildingApertureLayer,
} from './BuildingVisualRegistry.js';
import { APERTURE_MIN_ZOOM, assignRoomSlots, buildApertureModel } from './BuildingApertureModel.js';
import { RoomGlass, readPixels } from './RoomGlass.js';
import { mirrorRowOf, waterlineProfile } from './CoastBake.js';
import { ApertureLights, APERTURE_GLASS_SNAP, APERTURE_REGISTRY_CLEARANCE, apertureIntensity, apertureOverRoof, apertureRadius } from './ApertureLights.js';
import { RoofWeather } from './RoofWeather.js';
import { drawPennant, pennantFrame, pennantWind } from './PixelPennant.js';
import { resolveObservation } from './ObservationCertainty.js';
import { VillagePhase } from '../../application/VillageState.js';
import { GOLD, GOLD_RAMP, dottedCurve, fillConvex, gradeTone, pixelLine, ringDots, snap } from './EffectStamps.js';

// READ translates canonical classifier reasons, never tool names or input text.
const READ_VERBS = Object.freeze({
    'edit-file': 'WRITING', 'write-file': 'WRITING', 'patch-file': 'WRITING',
    'edit-notebook': 'WRITING', 'generate-asset': 'WRITING', 'edit-docs': 'WRITING',
    'modify-files': 'WRITING',
    'read-local': 'READING', 'search-local': 'READING', 'find-local': 'READING',
    'list-local': 'READING', 'read-docs': 'READING', 'inspect-code': 'READING',
    'inspect-validation': 'READING', 'web-search': 'READING', 'web-fetch': 'READING',
    'web-tool': 'READING', 'external-research': 'READING',
    'plan-task': 'PLANNING', 'update-task': 'PLANNING', 'review-tasks': 'PLANNING',
    'plan-work': 'PLANNING', 'plan-mode-enter': 'PLANNING', 'plan-mode-exit': 'PLANNING',
});
const LANDMARK_LABEL_TYPES = new Set(
    BUILDING_DEFS
        .filter((b) => b.labelPriority === 'landmark')
        .map((b) => b.type),
);
const LABEL_VISIBLE_ZOOM = 1;
const LABEL_DETAIL_ZOOM = 3;
// T3 plaque geometry (screen pixels): 5 px pads, a 17-row head band holding
// the motif, 8 px Press Start 2P name and 11 px Departure Mono count, and
// 12-row ledger lines (harbor commits, READ verbs, Command muster lines).
const PLAQUE_PAD = 5;
const PLAQUE_HEAD_H = 17;
const PLAQUE_ROW_H = 12;
// W7.5 — the muster line's carved ▸ (3 px, a space either side) and its row
// budget: up to three squads, else two and one exact `+N squads` line.
const PLAQUE_MUSTER_ARROW_W = 3;
const PLAQUE_MUSTER_MAX_ROWS = 3;
const DISTRICT_MOTIFS = Object.freeze(Object.fromEntries(
    BUILDING_DEFS
        .map((building) => [building.type, `district-${building.type}`])
        .filter(([, motif]) => Boolean(EVENT_SHAPES[motif])),
));
// W5.5a — the Command plaque's attention cell takes the lead actionable
// bucket (SignalLedger precedence: needs-you, error, limit) in the T1 plate's
// status hue and motif, so it reads as the same mark the plates carry.
const PLAQUE_ATTENTION = Object.freeze({
    needsYou: Object.freeze({ motif: 'needs-you', color: STATUS_VISUALS.waiting_on_user.color }),
    errors: Object.freeze({ motif: 'alert', color: STATUS_VISUALS.errored.color }),
    quota: Object.freeze({ motif: 'limit-gate', color: STATUS_VISUALS.rate_limited.color }),
});
const PLAQUE_ATTENTION_GAP = 4;
const LABEL_OVERLAP_TOLERANCE = 0.45;
const LABEL_COMPACT_OVERLAP_TOLERANCE = 0.62;
const MAX_TASKBOARD_PAPERS = 4;
const FORGE_GLOW_BASELINE = 0.22;
const FORGE_GLOW_DECAY_PER_SECOND = 0.32;
// 4.6 — the banked hearth of a confirmed-empty village: an ember behind the
// mouth, well under the ordinary idle baseline, never fully out.
const FORGE_BANKED_GLOW = 0.07;
// 4.6 — architecture that stays lit through a sleeping town: the Pharos and
// the harbour lantern are safety lights, not work signals.
const REST_SAFETY_LIGHT_TYPES = new Set(['watchtower', 'harbor']);
// 6.5 — the Harbor mast pennants: [y offset from the signal anchor, cloth,
// shaded hem]. Albedo, so they take the C2 grade on the overlay. The top
// hoist flies white: gold is verified success only.
const HARBOR_SIGNAL_PENNANTS = Object.freeze([
    [-18, '#d2dcd8', '#7a929c'],
    [-8, '#5bc0c9', '#356f74'],
    [2, '#c23f36', '#71251f'],
]);
// 8.2 (M16) — on the local day of a verified release the top hoist flies the
// release's gold pennant (the sloop's and the 6.7 bunting's pennant family)
// in place of the white: the same flag slot, no added flag.
const HARBOR_RELEASE_PENNANT = Object.freeze([GOLD, GOLD_RAMP[0]]);
// Warm glints admitted only on existing swell/crest texels, thinning outward.
const SEARCHLIGHT_COURSES = Object.freeze([
    [0, 0.3, 0.9],
    [0.3, 0.65, 0.48],
    [0.65, 1, 0.24],
]);
// 4.4 — the result shelf. Only records that say how a call *ended* land here
// (`tool:result`, from the adapters' bounded last-result summary); invocation
// puts nothing on the shelf and a tool disappearing removes nothing from it.
// The newest few keep their own tile, everything older is coalesced into an
// exact count so a busy Forge never rains stamps.
const RESULT_SHELF_RETAINED = 24;
const RESULT_TILE_SETTLE_MS = 260;
const LABEL_SHORT_TEXT = Object.fromEntries(
    BUILDING_DEFS
        .filter((building) => typeof building.shortLabel === 'string' && building.shortLabel.trim())
        .map((building) => [building.type, building.shortLabel.trim().toUpperCase()]),
);
const WATCHTOWER_LANTERN_FIRE = Object.freeze(getBuildingEffectAnchor('watchtower', 'lanternFire', {
    flame: [200, 68],
    light: [200, 66],
    particle: [200, 66],
}));
// One warm mirror shaft descends from the glass to a sea landing; its
// remaining cone lights swell texels only. Clock-only, never agent state.
const WATCHTOWER_SEARCHLIGHT = Object.freeze(getBuildingEffectAnchor('watchtower', 'searchlight', {
    pivot: [200, 68],
    length: 520,
    width: 96,
}));
const SEARCHLIGHT_LENGTH = WATCHTOWER_SEARCHLIGHT.length || 320;
const SEARCHLIGHT_FAR_WIDTH = WATCHTOWER_SEARCHLIGHT.width || 58;
const SEARCHLIGHT_SWEEP_RAD_PER_S = 0.2;
const SEARCHLIGHT_REST_ANGLE = 0.18;
const SEARCHLIGHT_SHEEN_STEP_MS = 200;
const SEARCHLIGHT_LANDING_SHARE = 0.35;
// Water reflection is the same subdued warm cream as the beam receivers.
const LIGHTHOUSE_COLUMN_COLOR = ART_RAMPS.beaconFire[0];
const LIGHTHOUSE_COLUMN_GAIN = 1.4;
const LIGHTHOUSE_COLUMN_REACH = 1.2;
// The lens angle (ground-plane radians, 0 = +x) at `ms` on the motion clock.
function searchlightAngleAt(ms) {
    const t = Math.floor(Math.max(0, Number(ms) || 0) / 140) * 0.14;
    return (SEARCHLIGHT_REST_ANGLE + t * SEARCHLIGHT_SWEEP_RAD_PER_S) % (Math.PI * 2);
}
// AD-6 — no beam by day. The Lighthouse beam draws only once the lamp course
// reaches `settling` (GradeEvaluator.lampCourseAt), the same minutes at which
// the grade keys hand the island to its lamps. Weather never promotes it (a
// stormy noon is still day) and neither does distress: action-needed agents
// live on T1 plates and the top bar (V3).
const LAMP_COURSE_SETTLING = 1;
// 2.7 — the beam waits for full lamplight (course 2): none through the dusk
// settling course and none at dawn once the lamps start dropping.
const LAMP_COURSE_LAMPLIGHT = 2;

function lampCourseFor(atmosphere) {
    const minute = Number(atmosphere?.clock?.minuteOfDay);
    if (!Number.isFinite(minute)) return 0;
    return lampCourseAt(minute, seasonShiftFor(seasonTokenForAtmosphere(atmosphere)));
}

export function lampsLitAt(atmosphere) {
    return lampCourseFor(atmosphere) >= LAMP_COURSE_SETTLING;
}
const PARTICLE_ALIASES = {
    sparkle2: 'sparkle',
    sparkle3: 'sparkle',
    torch2: 'torch',
    torch3: 'torch',
    torch4: 'torch',
};
const OBSERVATORY_CLOCK_FACE = Object.freeze(getBuildingEffectAnchor('observatory', 'clockFace', {
    // Calibrated against the generated 256x288 single-image clock observatory base.
    // Composite reference is asserted at first draw so a regenerated sprite
    // with different dimensions logs a visible warning instead of silently
    // misplacing the clock hands.
    compositeRef: Object.freeze({ w: 256, h: 288 }),
    center: [80, 155],
    radius: 13,
    sourceSize: 40,
    sourceCenter: 20,
    sourceRadius: 18,
    hourHandLength: 10,
    minuteHandLength: 15,
}));
const MINE_SEAM_COLORS = ['#ffc15a', '#ff8a33', '#ff4528'];
const MINE_CARGO_CRYSTAL_COLORS = ['#bfe9ff', '#8fd0f4', '#e6f8ff'];
const MINE_CARGO_ORE_COLORS = ['#5c554b', '#3f3a33', '#7e6a50'];
// Work tier (V8, `_workTierFor`) -> (emitter chance ×, light radius ×,
// occupancy scalar 0..1). Occupancy feeds window warmth via 0.45 + 0.55 * scalar.
const PRESENCE_TIER_TABLE = Object.freeze({
    dormant:  { emitter: 0.3, radius: 0.85, occupancy: 0 },
    occupied: { emitter: 1.0, radius: 1.0, occupancy: 0.7 },
    busy:     { emitter: 1.6, radius: 1.15, occupancy: 1 },
});
// (V8: the tier reads working visitors only. Observed-tool recency still
// drives the activity plate/text via `_buildingActivityInfo`, never light.)
// 3.1 — halo area is capped by authored source geometry, not by how dark the
// sky is. The widest authored lamps (Pharos 108 px, Harbor/Lighthouse 96 px)
// used to reach ~140 px of soft halo at night and rivalled the work they lit;
// the cap keeps every ambient halo inside one reviewed ceiling while the
// emissive core and near-receiver spill keep their full energy (D4).
export const SOURCE_HALO_RADIUS_CAP = 76;
// Observatory clock spin while a WebFetch/WebSearch/web.run ritual is active.
// Spin speed is in rad/s; ease back to 0 over OBSERVATORY_SPIN_EASE_MS.
const OBSERVATORY_WEB_RITUAL_TOOLS = new Set(['WebFetch', 'WebSearch', 'web.run']);
const OBSERVATORY_SPIN_RATE_RAD_PER_S = 0.9;
// 3.8 (PT-6) — the spin shows as one of 16 stepped frames, never a rotate.
const OBSERVATORY_SPIN_FRAMES = 16;
const OBSERVATORY_SPIN_EASE_MS = 1500;
// #52 — dome aperture (registry-anchored): opens with the night beacon, and a
// brief star burst pays off a completed web ritual. 6.5 — the same aperture
// carries a slow idle glint sweep when nothing is happening.
const OBSERVATORY_APERTURE = Object.freeze(getBuildingEffectAnchor('observatory', 'domeAperture', {
    slit: [149, 107],
    star: [149, 101],
    glintArc: { center: [149, 104], radius: 12, from: -2.4, to: -0.7 },
}));
const OBSERVATORY_BURST_MS = 1600;
const OBSERVATORY_GLINT_PERIOD_FRAMES = 540; // ≈9s at 60fps
const BUILDING_ACTIVITY_STATE_WEIGHT = Object.freeze({
    idle: 0,
    occupied: 0.42,
    busy: 0.72,
    full: 0.9,
    alert: 1,
});
const BUILDING_DRAWABLE_SORT_BAND = Object.freeze({
    'building-back': 10,
    'building-front': 90,
    building: 95,
});
const FOUNDATION_MATERIALS = Object.freeze({
    'civic-cobble': Object.freeze({
        base: '#727064', stone: '#aaa58f', dark: '#514f47', wear: '#b8a57d', accent: '#6c7650',
    }),
    'knowledge-terrace': Object.freeze({
        base: '#64656a', stone: '#929397', dark: '#494a51', wear: '#aca17e', accent: '#667154',
    }),
    'workshop-yard': Object.freeze({
        base: '#655b50', stone: '#8c8172', dark: '#413d39', wear: '#8b674a', accent: '#403a36',
    }),
    'mine-yard': Object.freeze({
        base: '#5c554b', stone: '#77756f', dark: '#393c3f', wear: '#7e6a50', accent: '#405c61',
    }),
    'arcane-court': Object.freeze({
        base: '#4d485a', stone: '#757080', dark: '#35313e', wear: '#8b7d72', accent: '#76619a',
    }),
});

const TASKBOARD_PHASE_MARKERS = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']);
// 4.5 — the re-authored board's slate, measured on base.png: `x`/`y` is the
// top-left texel of the leftmost slate column, `w`/`h` the flat chalk area,
// and `shear` the whole-pixel drop per column of the 2:1 plane (the slate
// descends to the right, facing the lower-left entrance).
const TASKBOARD_SLATE = Object.freeze({ x: 82, y: 59, w: 86, h: 57, shear: 0.5 });

// A raster surface for offscreen chalk, or null outside a DOM.
function createRasterCanvas(width, height) {
    if (globalThis.document?.createElement) {
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }
    if (typeof globalThis.OffscreenCanvas === 'function') return new globalThis.OffscreenCanvas(width, height);
    return null;
}

function taskboardPhaseMarker(index) {
    return TASKBOARD_PHASE_MARKERS[index] || String(index + 1);
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function compareBuildingDrawableDepth(a, b) {
    return (a.sortY - b.sortY)
        || (BUILDING_DRAWABLE_SORT_BAND[a.kind] - BUILDING_DRAWABLE_SORT_BAND[b.kind]);
}

function shadowAngleForLighting(lighting) {
    if (Number.isFinite(lighting?.shadowAngleRad)) return lighting.shadowAngleRad;
    const sunX = Number(lighting?.sunDirIso?.x);
    const sunY = Number(lighting?.sunDirIso?.y);
    if (Number.isFinite(sunX) && Number.isFinite(sunY) && Math.hypot(sunX, sunY) > 0) {
        return Math.atan2(-sunY, -sunX);
    }
    return 0.28;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function hexToRgb(hex) {
    const text = String(hex || '').replace('#', '');
    const normalized = text.length === 3
        ? text.split('').map(char => char + char).join('')
        : text.padEnd(6, '0').slice(0, 6);
    const value = parseInt(normalized, 16);
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

function mixHex(a, b, t) {
    const from = hexToRgb(a);
    const to = hexToRgb(b);
    return `rgb(${Math.round(lerp(from.r, to.r, t))}, ${Math.round(lerp(from.g, to.g, t))}, ${Math.round(lerp(from.b, to.b, t))})`;
}


// Chit text never breaks a word: past `maxChars` it keeps whole words only,
// and a single over-long word stays whole (the plate grows) rather than print
// a half-word. S14.
function wordFitLabel(value, maxChars = 12) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) return text;
    const cut = text.lastIndexOf(' ', maxChars);
    return cut > 0 ? text.slice(0, cut) : text.split(' ')[0];
}
// S14 — a taskboard paper chit carries the shared human verb (`update tasks`,
// `plan`) for its tool, never the raw tool id, and never a mid-word cut.
function paperLabel(ritual, fallback) {
    const verb = ritual?.tool ? toolVerbLabel(ritual.tool, ritual.input) : '';
    return wordFitLabel(verb || ritual?.label || fallback, 12).toUpperCase() || fallback;
}
// 4.1 — the aperture's tool label: the shared humanised verb (`message`,
// `spawn agent`), never the raw tool id; the exact invocation stays in the
// panel.
function compactToolLabel(tool) {
    return wordFitLabel(toolVerbLabel(tool), 13);
}

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

function chanceForDt(chancePerFrame, dt = 16) {
    const frameScale = Math.max(0, Math.min(3, dt / 16));
    return 1 - Math.pow(1 - clamp01(chancePerFrame), frameScale);
}

export class BuildingSprite {
    constructor(assets, spriteRenderer, particleSystem) {
        this.assets = assets;
        this.sprites = spriteRenderer;
        this.particles = particleSystem;
        this.buildings = [];
        this.agentSprites = [];
        this.hovered = null;
        this.frame = 0;
        this._drawablesCache = null;
        this._lightSourcesCache = null;
        this._labelMetricsCache = new Map();
        this._visitorCountByType = new Map();
        this._visitorStatusByType = new Map();
        this._clockCanvas = null;
        this._clockCanvasKey = '';
        this.clockState = null;
        this.lightingState = null;
        this.atmosphereState = null;
        this.ritualConductor = null;
        this.quotaState = null;
        this.harborStatus = { failedPushActive: false, activeWorkingCount: null };
        this._taskboardPapers = [];
        this._taskboardBoardModel = new TaskboardBoardModel();
        this._taskboardLayoutCache = new Map();
        this._seenTaskboardRituals = new Set();
        this._forgeGlow = FORGE_GLOW_BASELINE;
        // 6.1 / 6.2 — frame-strip parts, doors and emitter cycles: gated by
        // the isWorkingVisitor sets, stepped on the one motion clock
        // (`motionClock`, handed over by IsometricRenderer).
        this.partGates = new BuildingPartGates();
        this.motionClock = null;
        this._cycleCache = new Map();
        this._partChannelCache = new Map();
        this._partDrawScratch = [];
        this._presenceByType = new Map();
        this._litGateByType = new Map();
        this._onPresence = (map) => {
            this._presenceByType.clear();
            for (const [type, entry] of Object.entries(map || {})) {
                if (entry) this._presenceByType.set(type, entry);
            }
        };
        eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, this._onPresence);
        // Archive read intensity (0..1) sourced from LandmarkActivity.
        this._archiveReadIntensity = 0;
        this._onReadIntensity = (map) => {
            const next = Number(map?.archive);
            this._archiveReadIntensity = Number.isFinite(next) ? clamp01(next) : 0;
        };
        eventBus.on('building:read-intensity', this._onReadIntensity);
        // Observatory clock extra rotation while a web ritual is active.
        this._observatoryClockSpin = 0;
        // #52 — dome aperture result burst: ids of web rituals seen last tick;
        // a vanished id means the search completed and the dome star fires.
        this._observatoryWebRitualIds = new Set();
        this._observatoryBurstAt = -Infinity;
        // #53 — dominant occupant repo per building type (for pennant tint).
        this._visitorRepoByType = new Map();
        // #54 — last emitted village population; the empty-village tour in
        // Camera.js subscribes to the 'village:population' event we emit on
        // change. -1 forces an initial emit on the first update tick.
        this._lastAgentCount = -1;
        // 4.1/4.2 — explicit building inspection. Selection is the only way in;
        // nothing here changes the default frame, the exterior sprite, the hit
        // target, or any domain position.
        this._selectedBuildingType = null;
        this._apertureModel = null;
        this._apertureProfile = null;
        // agentId -> desk index per building type. Sticky, so a session keeps
        // its desk until it stops qualifying.
        this._deskAssignments = new Map();
        // 6.3 — every building's room slots (`_updateRoomSlots`), each room's
        // stepped lit share, and the glass the rooms light (RoomGlass). A
        // worker keeps its window while it works: leaving work extinguishes
        // exactly one room, never reshuffles the row.
        this._roomSlotsByType = new Map();
        this._roomLitByType = new Map();
        this.roomGlass = new RoomGlass(this.assets);
        // 2.4 — emitter-blob templates from each landmark's emissive sidecar.
        this.apertureLights = new ApertureLights(this.assets);
        this._apertureSourcesCache = null;
        this._apertureSourcesKey = null;
        this._apertureSourcesStatics = null;
        // 5.2 roofs / 6.6 — snow, wet slate and eave drips on the roofs
        // (RoofWeather), from the village's own weather only.
        this.roofWeather = new RoofWeather(this.assets);
        this._onBuildingSelected = (building) => {
            const type = building?.type || null;
            if (type === this._selectedBuildingType) return;
            this._selectedBuildingType = type;
            this._deskAssignments.clear();
            this._apertureModel = null;
            this._apertureProfile = null;
        };
        this._onBuildingDeselected = () => this._onBuildingSelected(null);
        eventBus.on(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.on(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        // 4.6 — the canonical readiness phase. READY_EMPTY is the only phase
        // that earns the rest state; DEGRADED and READY_NO_PROVIDERS keep the
        // shipped treatment, because silence and blindness are opposite facts.
        this._villagePhase = null;
        this._onVillageState = (state) => { this._villagePhase = state?.phase || null; };
        eventBus.on('village:state', this._onVillageState);
        // 4.3 / 4.4 — the two work ledgers LandmarkActivity measures. This
        // renderer only draws them; it never derives a count of its own.
        this._mineAssay = null;
        this._onMineAssay = (assay) => { this._mineAssay = assay || null; };
        eventBus.on('building:mine-assay', this._onMineAssay);
        this._forgeWorkload = null;
        this._onForgeWorkload = (workload) => { this._forgeWorkload = workload || null; };
        eventBus.on('building:forge-workload', this._onForgeWorkload);
        // 4.4 — the result shelf: bounded, newest first, deduplicated on the
        // adapters' stable result id. A stamp is placed only by a record that
        // reports how a call ended.
        this._resultShelf = [];
        this._resultShelfIds = new Set();
        this._onToolResult = (event) => this._observeToolResult(event);
        eventBus.on('tool:result', this._onToolResult);
        // Selectable world instruments (result tiles, plan tabs): world-space
        // rects recorded by the draw pass and cleared once per frame, so the
        // hit target is always exactly what was last drawn.
        this._instrumentHits = [];
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        this._motionMq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this._onMotionChange = (e) => this.setMotionScale(e.matches ? 0 : 1);
        this._motionMq?.addEventListener?.('change', this._onMotionChange);
    }

    dispose() {
        this._motionMq?.removeEventListener?.('change', this._onMotionChange);
        eventBus.off(BUILDING_EVENTS.ACTIVE_AGENTS, this._onPresence);
        eventBus.off('building:read-intensity', this._onReadIntensity);
        eventBus.off(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.off(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.off('village:state', this._onVillageState);
        eventBus.off('building:mine-assay', this._onMineAssay);
        eventBus.off('building:forge-workload', this._onForgeWorkload);
        eventBus.off('tool:result', this._onToolResult);
        this._resultShelf = [];
        this._resultShelfIds.clear();
        this._instrumentHits = [];
        this._litGateByType.clear();
    }

    _nightShiftLit(type) {
        return this._litGateByType.get(type)?.value || 0;
    }

    _nightWindowGate() {
        return nightWindowGate(
            this.atmosphereState?.phase,
            this.atmosphereState?.phaseProgress,
        );
    }

    _emissiveGateFor(building) {
        return buildingEmissiveGate(
            this.atmosphereState?.phase,
            this.atmosphereState?.phaseProgress,
            this._nightShiftLit(building?.type),
        );
    }

    _buildingAlertFor(building) {
        return Boolean(this.harborStatus?.failedPushActive
            && (building?.type === 'watchtower' || building?.type === 'harbor'));
    }

    _quotaFiveHourRatio() {
        return clamp01(this.quotaState?.fiveHour ?? this.quotaState?.fiveHourRatio ?? 0);
    }

    setMotionScale(s) { this.motionScale = s; }

    setLightingState(state) {
        this.lightingState = state ? normalizeLightingState(state) : null;
    }

    setClockState(clock) {
        this.clockState = clock || null;
    }

    setAtmosphereState(atmosphere) {
        this.atmosphereState = atmosphere || null;
    }

    setRitualConductor(conductor) {
        this.ritualConductor = conductor || null;
    }

    setQuotaState(state) {
        this.quotaState = state || null;
    }

    setHarborStatus(status = {}) {
        const count = Number(status.activeWorkingCount);
        this.harborStatus = {
            failedPushActive: Boolean(status.failedPushActive),
            activeWorkingCount: Number.isFinite(count) ? Math.max(0, count) : null,
        };
    }

    setBuildings(map) {
        // Accepts a Map (preferred — matches world.buildings) or an Array.
        this.buildings = map instanceof Map ? Array.from(map.values()) : Array.from(map);
        this._drawablesCache = null;
        this._lightSourcesCache = null;
        this._labelMetricsCache.clear();
    }

    setAgentSprites(sprites) {
        this.agentSprites = sprites;
        this._taskboardBoardModel.updateAgentSprites(sprites);
        const cache = this._readAgentCache || (this._readAgentCache = new Map());
        let changed = cache.size !== sprites.length;
        const generation = this._readGeneration = (this._readGeneration || 0) + 1;
        for (const sprite of sprites) {
            const agent = sprite.agent;
            if (!agent) continue;
            const tool = agent.currentTool;
            const input = agent.currentToolInput;
            const prior = cache.get(agent.id);
            if (prior && prior.tool === tool && prior.input === input
                && prior.status === agent.status && prior.departed === agent.isDeparted) {
                sprite.readToolVerb = prior.verb;
                prior.generation = generation;
                continue;
            }
            const classified = classifyTool(tool, input);
            const entry = {
                generation,
                tool, input, status: agent.status, departed: agent.isDeparted,
                building: classified?.building || 'command',
                verb: READ_VERBS[classified?.reason] || 'OTHER',
            };
            sprite.readToolVerb = entry.verb;
            cache.set(agent.id, entry);
            changed = true;
        }
        for (const [id, entry] of cache) {
            if (entry.generation !== generation) {
                cache.delete(id);
                changed = true;
            }
        }
        if (changed) {
            const counts = this._readCounts || (this._readCounts = new Map());
            counts.clear();
            for (const entry of cache.values()) {
                if (entry.status !== AgentStatus.WORKING || entry.departed) continue;
                let verbs = counts.get(entry.building);
                if (!verbs) counts.set(entry.building, verbs = new Map());
                verbs.set(entry.verb, (verbs.get(entry.verb) || 0) + 1);
            }
            this._readPlaques = new Map(Array.from(counts, ([type, verbs]) => [
                type, Array.from(verbs, ([verb, count]) => `${verb} · ${count}`),
            ]));
        }
    }

    setTaskboardCandidates(ids) {
        this._taskboardCandidates = Array.isArray(ids)
            ? ids.filter((id) => typeof id === 'string' && id)
            : [];
    }

    setZoom(value) {
        const zoom = Number(value);
        this._zoom = Number.isFinite(zoom) ? zoom : 0;
    }

    // W7.10a — selection wins; else two or more live plans make the slate a
    // fleet rollup (`board.fleet`), which has no single board agent.
    _taskboardBoard() {
        return this._taskboardBoardModel.board({
            candidates: this._taskboardCandidates || [],
            agentSprites: this.agentSprites,
        });
    }

    _taskboardBoardAgent() {
        return this._taskboardBoard()?.agent || null;
    }

    // The fleet rollup as a chalk view: `Plans · N` over one row per plan,
    // a finished plan in dim struck chalk. Rebuilt only when a row changes.
    _taskboardFleetView(fleet) {
        const signature = fleet.map((plan) => `${plan.agentId}|${plan.text}|${plan.done}/${plan.total}`).join('\n');
        if (this._taskboardFleetCache?.signature === signature) return this._taskboardFleetCache.view;
        const view = {
            layout: {
                rows: fleet.map((plan) => ({
                    kind: 'plan',
                    text: plan.text,
                    done: plan.done,
                    total: plan.total,
                    status: plan.total > 0 && plan.done === plan.total ? 'completed' : '',
                })),
            },
            header: `Plans · ${fleet.length}`,
        };
        this._taskboardFleetCache = { signature, view };
        return view;
    }

    _taskboardViewFor(agent, maxItemRows) {
        if (!agent) return null;
        const signature = this._taskboardBoardModel.signatureFor(agent.id);
        const name = String(agent.displayName || agent.name || '').trim();
        const cached = this._taskboardLayoutCache.get(maxItemRows);
        if (cached?.agentId === agent.id && cached.signature === signature && cached.name === name) return cached.view;
        const layout = taskboardBoardLayout(agent.todos, { maxItemRows });
        if (!layout) return null;
        const phaseRows = layout.rows.filter((row) => row.kind === 'phase');
        const activePhase = phaseRows.find((row) => row.active) || null;
        let activeItems = layout.rows.filter((row) => row.kind === 'item');
        if (activePhase) {
            const start = layout.rows.indexOf(activePhase) + 1;
            activeItems = [];
            for (let index = start; index < layout.rows.length; index++) {
                const row = layout.rows[index];
                if (row.kind === 'phase') break;
                if (row.kind === 'item') activeItems.push(row);
            }
        }
        const currentItem = activeItems.find((row) => row.status === 'in_progress')
            || activeItems.find((row) => row.status === 'pending')
            || null;
        const currentItemText = currentItem?.text || '';
        const view = {
            layout,
            header: `${name} · ${layout.done}/${layout.total}`,
            activePhase: activePhase
                ? `${taskboardPhaseMarker(phaseRows.indexOf(activePhase))}. ${activePhase.text} · ${activePhase.done}/${activePhase.total}`
                : '',
            currentItem: currentItemText.length > 28
                ? `${currentItemText.slice(0, 27).trimEnd()}…`
                : currentItemText,
        };
        this._taskboardLayoutCache.set(maxItemRows, { agentId: agent.id, signature, name, view });
        return view;
    }

    drawGpuFunctionalOverlays(ctx) {
        const drawables = this.enumerateDrawables();
        // This pass lands on the ungraded overlay: albedo marks take C2 here
        // (`_overlayLightGrade`); the Canvas depth pass is graded afterwards.
        this._ungradedOverlay = true;
        for (let index = 0; index < drawables.length; index++) {
            const drawable = drawables[index];
            const splitPass = drawable.kind === 'building-back'
                ? 'back'
                : drawable.kind === 'building-front'
                    ? 'front'
                    : 'whole';
            this._drawFunctionalOverlay(
                ctx,
                drawable.building,
                drawable.entry,
                drawable.wx,
                drawable.wy,
                splitPass,
                drawable.horizonY ?? null,
            );
            this._drawOccupancyPennant(
                ctx,
                drawable.building,
                drawable.entry,
                drawable.wx,
                drawable.wy,
                splitPass,
                drawable.horizonY ?? null,
            );
            this._drawAttentionBannerBoard(
                ctx,
                drawable.building,
                drawable.entry,
                drawable.wx,
                drawable.wy,
                splitPass,
                drawable.horizonY ?? null,
            );
        }
        this._ungradedOverlay = false;
    }

    // The C2 grade albedo overlay marks must apply themselves, or null where
    // the whole frame is graded after the draw (Canvas depth pass).
    _overlayLightGrade() {
        return this._ungradedOverlay ? this.atmosphereState?.lightGrade || null : null;
    }

    // Hover state does NOT invalidate _drawablesCache — drawDrawable reads
    // this.hovered live at draw time, so a fresh enumerate isn't required.
    setHovered(b) { this.hovered = b; }

    update(dt) {
        this.frame += (dt / 16) * (this.motionScale || 0);
        // Selectable instruments are re-registered by this frame's draw pass.
        this._instrumentHits.length = 0;
        this._updateVisitorCounts();
        this.attentionBanner = attentionBannerState(this._attentionBannerAgents(), Date.now());
        this.partGates.update({
            workingIdsByType: this._workingIdsByType,
            roomSlotsByType: this._roomSlotsByType,
            timeMs: this._partClockMs(),
            motion: (this.motionScale || 0) > 0,
            attention: this.attentionBanner,
            clockBeats: this._clockBeatSet(),
        });
        this._updateInspection();
        this._updateNightLightGates(dt);
        this._emitVillagePopulation();
        this._trackObservatoryWebRituals();
        this._syncTaskboardPapers(Date.now());
        this._updateForgeGlow(dt);
        this._updateObservatoryClockSpin(dt);
        for (const b of this.buildings) this._spawnEmittersFor(b, dt);
    }

    // W5.3 — the live bodies the attention banner reads: the same population
    // as the plaque's attention cell (departed, archiving and not-yet-arrived
    // bodies excluded). Reuses one scratch array per frame.
    _attentionBannerAgents() {
        const out = this._attentionScratch || (this._attentionScratch = []);
        out.length = 0;
        for (const sprite of this.agentSprites || []) {
            const agent = sprite?.agent;
            if (!agent || agent.isDeparted || sprite._archiveAnim || sprite.isArrivalPending?.()) continue;
            out.push(agent);
        }
        return out;
    }

    // #54 — publish the live village population whenever it changes so the
    // Camera's empty-village tour can engage/yield without a renderer reference.
    // Initial tick always emits (last count starts at -1).
    _emitVillagePopulation() {
        const count = this.agentSprites?.length || 0;
        if (count === this._lastAgentCount) return;
        this._lastAgentCount = count;
        eventBus.emit('village:population', { count, empty: count === 0 });
    }

    // #52 — diff the observatory's web-ritual set tick over tick; a ritual that
    // vanished since last tick completed, so fire the dome result burst then.
    _trackObservatoryWebRituals() {
        const current = new Set();
        for (const ritual of this._ritualsFor('observatory')) {
            if (OBSERVATORY_WEB_RITUAL_TOOLS.has(ritual?.tool)) current.add(ritual);
        }
        for (const ritual of this._observatoryWebRitualIds) {
            if (!current.has(ritual)) {
                this._observatoryBurstAt = Date.now();
                this._spawnObservatoryBurstParticles();
                break;
            }
        }
        this._observatoryWebRitualIds = current;
    }

    _spawnObservatoryBurstParticles() {
        if (!this.motionScale || !this.particles) return;
        const observatory = this.buildings.find((b) => b.type === 'observatory');
        if (!observatory) return;
        const center = this._buildingScreenCenter(observatory);
        const anchor = this.assets.getAnchor('building.observatory');
        const star = OBSERVATORY_APERTURE.star;
        this.particles.spawn('sparkle',
            center.x - anchor[0] + star[0],
            center.y - anchor[1] + star[1],
            {
                count: 7,
                colors: ['#fff1a8', '#d9c7ff', '#ffffff'],
                size: [1, 2.4],
                life: [26, 48],
                speed: [0.25, 0.7],
                spread: [4, 8],
                sortY: this.particleSortY(observatory, star[1]),
            });
    }

    // Tick the extra clock spin while a web ritual is active at the
    // Observatory; ease back to 0 within OBSERVATORY_SPIN_EASE_MS once it ends.
    // Held at 0 under reduced motion so the time-of-day hands stay still.
    _updateObservatoryClockSpin(dt) {
        if (!this.motionScale) {
            this._observatoryClockSpin = 0;
            return;
        }
        const seconds = Math.max(0, Number(dt) || 0) / 1000;
        if (this._hasObservatoryWebRitual()) {
            this._observatoryClockSpin = (this._observatoryClockSpin + seconds * OBSERVATORY_SPIN_RATE_RAD_PER_S) % (Math.PI * 2);
            return;
        }
        if (this._observatoryClockSpin <= 0) return;
        const easePerSecond = (Math.PI * 2) / (OBSERVATORY_SPIN_EASE_MS / 1000);
        this._observatoryClockSpin = Math.max(0, this._observatoryClockSpin - seconds * easePerSecond);
    }

    _hasObservatoryWebRitual() {
        const rituals = this._ritualsFor('observatory');
        for (const ritual of rituals) {
            if (OBSERVATORY_WEB_RITUAL_TOOLS.has(ritual?.tool)) return true;
        }
        return false;
    }

    // One stepped, clock-only mirror beam. `foot` is the sea landing, not
    // the tower base: the air shaft and water glints share that exact origin.
    lighthouseBeam(motionTimeMs = 0) {
        if (lampCourseFor(this.atmosphereState) < LAMP_COURSE_LAMPLIGHT) return null;
        const building = this.buildings.find(b => b.type === 'watchtower');
        if (!building) return null;
        const entry = this.assets.getEntry(`building.${building.type}`);
        const center = this._buildingScreenCenter(building);
        const [anchorX, anchorY] = this.assets.getAnchor(entry?.id || `building.${building.type}`);
        const [footX, footY] = WATCHTOWER_LANTERN_FIRE.foot || WATCHTOWER_SEARCHLIGHT.pivot;
        const ms = Math.max(0, Number(motionTimeMs) || 0);
        const beam = this._lighthouseBeamState || (this._lighthouseBeamState = {
            foot: { x: 0, y: 0 },
            angle: 0,
            length: SEARCHLIGHT_LENGTH * (1 - SEARCHLIGHT_LANDING_SHARE),
            farWidth: SEARCHLIGHT_FAR_WIDTH,
            courses: SEARCHLIGHT_COURSES,
            sheenStep: 0,
        });
        beam.angle = searchlightAngleAt(ms);
        const landing = SEARCHLIGHT_LENGTH * SEARCHLIGHT_LANDING_SHARE;
        beam.foot.x = Math.round(center.x - anchorX + footX + Math.cos(beam.angle) * landing);
        beam.foot.y = Math.round(center.y - anchorY + footY + Math.sin(beam.angle) * landing * 0.5);
        beam.sheenStep = Math.floor(ms / SEARCHLIGHT_SHEEN_STEP_MS) % 3;
        return beam;
    }

    // Shared ungraded warm halo and descending shaft on Canvas/GPU overlay.
    drawLanternLight(ctx) {
        for (const building of this.buildings) {
            if (building.type !== 'watchtower') continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const [anchorX, anchorY] = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            const [flameX, flameY] = WATCHTOWER_LANTERN_FIRE.flame;
            this._drawWatchtowerFire(ctx, {
                x: Math.round(center.x - anchorX + flameX),
                y: Math.round(center.y - anchorY + flameY),
            });
        }
    }

    // Static site materials are baked with terrain. They deliberately retain
    // the underlying tile texture and never draw a complete perimeter or lip.
    drawGroundFoundations(ctx) {
        for (const building of this.buildings) {
            const grounding = getBuildingVisual(building.type)?.grounding;
            if (!grounding?.foundation?.enabled) continue;
            const material = FOUNDATION_MATERIALS[grounding.material];
            if (!material) continue;
            this._drawGroundFoundation(ctx, building, grounding, material);
        }
    }

    _drawGroundFoundation(ctx, building, grounding, material) {
        const corners = this._buildingFootprintCorners(building);
        const foundation = grounding.foundation;
        const seed = hashText(`foundation:${building.type}:${building.position.tileX}:${building.position.tileY}`);
        const minX = Math.floor(Math.min(corners.nw.x, corners.ne.x, corners.se.x, corners.sw.x));
        const maxX = Math.ceil(Math.max(corners.nw.x, corners.ne.x, corners.se.x, corners.sw.x));
        const minY = Math.floor(Math.min(corners.nw.y, corners.ne.y, corners.se.y, corners.sw.y));
        const maxY = Math.ceil(Math.max(corners.nw.y, corners.ne.y, corners.se.y, corners.sw.y));
        const opacity = clamp01(foundation.opacity ?? 0.5);
        const density = clamp01(foundation.density ?? 0.45);

        ctx.save();
        this._traceFootprint(ctx, corners);
        ctx.clip();
        ctx.globalAlpha = opacity * 0.1;
        ctx.fillStyle = material.base;
        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

        for (let y = minY + 2; y < maxY; y += 5) {
            for (let x = minX + ((y + seed) % 7); x < maxX; x += 7) {
                const noise = this._groundingNoise(x, y, seed);
                if (noise > density) continue;
                const variant = this._groundingNoise(y, x, seed ^ 0x45d9f3b);
                ctx.globalAlpha = opacity * (0.3 + variant * 0.42);
                ctx.fillStyle = variant > 0.76
                    ? material.accent
                    : variant > 0.42 ? material.stone : material.dark;
                const width = variant > 0.7 ? 5 : variant > 0.35 ? 3 : 2;
                ctx.fillRect(Math.round(x), Math.round(y), width, variant > 0.62 ? 2 : 1);
            }
        }
        this._drawFoundationThreshold(ctx, building, grounding, material, opacity);
        ctx.restore();
    }

    _drawFoundationThreshold(ctx, building, grounding, material, opacity) {
        const entrance = building.entrance;
        if (!Number.isFinite(entrance?.tileX) || !Number.isFinite(entrance?.tileY)) return;
        const from = this._tileToScreen(entrance.tileX, entrance.tileY);
        const center = this._buildingScreenCenter(building);
        const reach = clamp01(grounding.foundation?.thresholdReach ?? 0.55);
        const to = {
            x: from.x + (center.x - from.x) * reach,
            y: from.y + (center.y - from.y) * reach,
        };
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const steps = Math.max(4, Math.round(length / 9));
        const ux = dx / length;
        const uy = dy / length;

        if (grounding.material === 'mine-yard') {
            const nx = -uy * 5;
            const ny = ux * 5;
            ctx.globalAlpha = opacity * 0.88;
            ctx.strokeStyle = material.dark;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(from.x + nx, from.y + ny);
            ctx.lineTo(to.x + nx, to.y + ny);
            ctx.moveTo(from.x - nx, from.y - ny);
            ctx.lineTo(to.x - nx, to.y - ny);
            ctx.stroke();
            ctx.fillStyle = material.wear;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = Math.round(from.x + dx * t);
                const y = Math.round(from.y + dy * t);
                ctx.fillRect(x - 7, y - 1, 14, 2);
            }
            return;
        }

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(from.x + dx * t);
            const y = Math.round(from.y + dy * t);
            ctx.globalAlpha = opacity * (0.48 + (i % 3) * 0.12);
            ctx.fillStyle = i % 4 === 0 ? material.wear : material.stone;
            ctx.beginPath();
            ctx.moveTo(x, y - 3);
            ctx.lineTo(x + 7, y);
            ctx.lineTo(x, y + 3);
            ctx.lineTo(x - 7, y);
            ctx.closePath();
            ctx.fill();
        }
    }

    _groundingNoise(x, y, seed) {
        let value = Math.imul((Math.round(x) ^ seed) >>> 0, 0x45d9f3b);
        value = Math.imul((value ^ (value >>> 16) ^ Math.round(y)) >>> 0, 0x45d9f3b);
        value ^= value >>> 16;
        return (value >>> 0) / 4294967295;
    }

    // Physical shadows follow declared structural contact, never sprite canvas
    // width or the outer terrain apron. 2.9 — `waterFields` (the coast bake's
    // resident fields) break a cast's texels over painted water.
    drawShadows(ctx, waterFields = null) {
        // 1.5 — the same baked RakingLight cast the resident path uploads.
        const cast = castLightingFor(this.atmosphereState);
        for (const b of this.buildings) {
            const grounding = getBuildingVisual(b.type)?.grounding;
            const contact = grounding?.contact;
            const c = this._buildingScreenCenter(b);
            const isHovered = this.hovered === b;
            ctx.save();
            if (grounding?.shadow !== 'none' && contact?.width > 0 && contact?.depth > 0) {
                const baked = structureCast(b.type, grounding, contact, cast);
                if (baked) {
                    ctx.imageSmoothingEnabled = false;
                    ctx.globalAlpha = cast.alpha * (contact.opacity ?? 0.75);
                    const x = Math.round(c.x + (contact.offsetX || 0) + baked.offsetX);
                    const y = Math.round(c.y + (contact.offsetY || 0) + baked.offsetY);
                    ctx.drawImage(castOverWater(baked, x, y, waterFields), x, y);
                    ctx.globalAlpha = 1;
                }
            }
            if (isHovered) this._drawBuildingHoverFootprint(ctx, b);
            ctx.restore();
        }
    }

    _drawBuildingHoverFootprint(ctx, building) {
        ctx.globalAlpha = 0.82;
        ctx.strokeStyle = 'rgba(255, 232, 166, 0.82)';
        ctx.lineWidth = 2;
        this._traceFootprint(ctx, this._buildingFootprintCorners(building));
        ctx.stroke();
    }

    // T3 — carved district plaques (plan 5.3, contract C5). One square walnut
    // board per building: a lit top row, a shaded bottom row, a 1 px outline
    // and nail heads; the authored EventShapes district motif; the name in
    // 8 px Press Start 2P; and, when anyone is there, the exact occupant count
    // in 11 px Departure Mono behind a 1 px divider (`FORGE │ 8`). A 1 px post
    // runs into the roof. Screen-fixed and snapped to whole pixels; drawn on
    // the overlay after the depth pass so plaques stay readable over roofs.
    // Hover and selection are the plaque's own lit/gold states (5.5): there is
    // no second pill above it. If the name does not fit, the plaque falls back
    // to a shorter name, then to the motif alone — never to a smaller font.
    drawLabels(ctx, {
        zoom = 1,
        occupiedBoxes = [],
        harborPendingRepos = [],
        squads = [],
        scaleMode = 'screen-fixed',
        readMode = false,
        selectedType = null,
        reserved = getReservedRects(),
    } = {}) {
        const labelScale = 1 / Math.max(0.01, zoom);
        const occupied = [];
        // 8.1 — the painted plaque boards (world rects), read by the next
        // frame's moment stage: a moment never stands under a plaque.
        const plaqueRects = [];
        this.plaqueWorldRects = plaqueRects;
        const normalizedOccupiedBoxes = this._normalizeBoxes(occupiedBoxes);
        const harborLedgerRows = this._harborLedgerRows(harborPendingRepos);
        const musterRows = this._musterRows(squads);
        const plaqueCounts = this._plaqueCountsByType();
        const view = this._plaqueWorldViewport(ctx, labelScale);
        // SM-7 — a plaque never covers a drawn identity label (T4 name or T2
        // plate) or a T1 plate: the renderer's label pass hands those rects
        // over as `identityWorldRects` just before this call. Names never
        // move; a plaque that cannot clear them in any candidate or fallback
        // is not drawn this frame.
        const nameBoxes = this._normalizeBoxes(this.identityWorldRects || []);
        // V8 — chrome over the world (the World dock) is occluded screen: a
        // plaque whose board or post would land under it flips below it (or
        // steps left of it), else that candidate is dropped.
        const chromeBoxes = this._reservedWorldBoxes(ctx, reserved);
        const buildingList = [...this.buildings].sort((a, b) => {
            const ac = this._buildingScreenCenter(a);
            const bc = this._buildingScreenCenter(b);
            return ac.y - bc.y;
        });

        for (const b of buildingList) {
            const rawLabel = this._resolveBuildingLabelText(b);
            if (!rawLabel) continue;
            const center = this._buildingScreenCenter(b);
            const dims = this.assets.getDims(`building.${b.type}`);
            if (!dims) continue;
            const isHovered = this.hovered === b;
            const isSelected = Boolean(selectedType) && b.type === selectedType;
            const registryLabelPriority = getBuildingLabelPriority(b.type, b.labelPriority);
            const isLandmark = registryLabelPriority === 'landmark' || b.labelPriority === 'landmark' || LANDMARK_LABEL_TYPES.has(b.type);
            const localLabelDensity = this._estimateLocalLabelDensity(occupied, center.x, center.y);
            const failedPushAlert = b.type === 'watchtower' && this.harborStatus?.failedPushActive;
            // S2 — the plaque number is exactly the distinct live agents whose
            // district this is: folded inside, queued on the apron, or routed
            // here. Bodies merely crossing the footprint on the way elsewhere
            // are not this district's (they count at their destination).
            const count = plaqueCounts.get(b.type) || 0;
            const anchorY = this.assets.getAnchor(`building.${b.type}`)?.[1] ?? dims.h;
            const firstOpaque = this.assets.getMask?.(`building.${b.type}`)?.indexOf(1) ?? 0;
            const spriteTop = Math.round(center.y - anchorY) + Math.floor(Math.max(0, firstOpaque) / dims.w);
            const baseY = spriteTop - (isHovered || isSelected ? 30 : 24) * labelScale;
            const baseX = center.x;

            const labelAttempts = this._labelRenderAttempts(b, {
                isHovered: isHovered || isSelected,
                isLandmark,
                zoom,
                localLabelDensity,
                harborLedgerRows,
                musterRows,
                readRows: readMode ? this._readPlaques?.get(b.type) : null,
            });
            let chosen = null;
            for (const attempt of labelAttempts) {
                const plaque = this._measurePlaque(ctx, b, attempt, {
                    count, zoom, isHovered, isLandmark, scaleMode,
                    attention: b.type === 'command' ? this.plaqueAttention : null,
                });
                if (!plaque.title && !plaque.motif) continue;
                const layout = this._resolveLabelLayout({
                    candidates: this._labelLayoutCandidates(isLandmark, isHovered || isSelected).map(({ dx, dy }) => ({ dx: dx * labelScale, dy: dy * labelScale })),
                    occupied,
                    occupiedExternal: normalizedOccupiedBoxes,
                    hardBoxes: nameBoxes,
                    hardPad: labelScale,
                    centerX: baseX,
                    centerY: baseY,
                    tagW: plaque.width * labelScale,
                    tagH: plaque.height * labelScale,
                    maxOverlap: attempt.overlapTolerance,
                    localLabelDensity,
                });
                if (!layout) continue;
                const labelOverlap = layout.overlap != null ? layout.overlap : this._boxesOverlapRatio(layout.box, occupied);
                if (labelOverlap > attempt.overlapTolerance) continue;
                if (attempt.blockAgents && this._boxesOverlapRatio(layout.box, normalizedOccupiedBoxes) > attempt.overlapTolerance) continue;
                const candidate = { plaque, layout };
                // S13 — a plaque stays inside the visible world: shifted in
                // whole while its building stands in view, hidden when the
                // building is off-frame (a bare count cell at the edge would be
                // an orphan). The shift must not land it on a name either.
                if (view && !this._placePlaqueInView(candidate, view, {
                    buildingLeft: center.x - dims.w / 2,
                    buildingRight: center.x + dims.w / 2,
                    buildingTop: spriteTop,
                    buildingBottom: center.y,
                    tagW: plaque.width * labelScale,
                    tagH: plaque.height * labelScale,
                })) break;
                const tagW = plaque.width * labelScale;
                const tagH = plaque.height * labelScale;
                const poleBottom = spriteTop + 2 * labelScale;
                if (chromeBoxes.length && !this._clearPlaqueOfChrome(layout, {
                    tagW, tagH, pad: 2 * labelScale, poleBottom, chromeBoxes, view,
                })) continue;
                // The post counts as much as the board: a walker's name
                // crossing the post reads as a plaque drawn over the name.
                if (this._plaqueHitsBoxes(layout.x, layout.y, tagW, tagH, labelScale, nameBoxes, poleBottom, labelScale)) continue;
                chosen = candidate;
                break;
            }
            if (!chosen) continue;
            occupied.push(chosen.layout.box);
            const boardW = chosen.plaque.width * labelScale;
            const boardH = chosen.plaque.height * labelScale;
            plaqueRects.push({
                left: chosen.layout.x - boardW / 2,
                top: chosen.layout.y - boardH / 2,
                right: chosen.layout.x + boardW / 2,
                bottom: chosen.layout.y + boardH / 2,
            });
            this._paintPlaque(ctx, chosen.plaque, {
                x: chosen.layout.x,
                y: chosen.layout.y,
                labelScale,
                poleBottom: spriteTop + 2 * labelScale,
                isHovered,
                isSelected,
                isLandmark,
                alert: failedPushAlert,
                accent: getBuildingLabelAccent(b.type, WALNUT.text),
            });
        }
    }

    // World rect of the visible canvas (inset by a screen margin), read from
    // the overlay transform; null when the context cannot say (tests).
    _plaqueWorldViewport(ctx, labelScale) {
        if (typeof ctx?.getTransform !== 'function' || !ctx.canvas?.width) return null;
        const matrix = ctx.getTransform();
        if (!matrix || typeof matrix.inverse !== 'function' || !matrix.a || !matrix.d) return null;
        const inverse = matrix.inverse();
        const map = (x, y) => ({ x: inverse.a * x + inverse.c * y + inverse.e, y: inverse.b * x + inverse.d * y + inverse.f });
        const topLeft = map(0, 0);
        const bottomRight = map(ctx.canvas.width, ctx.canvas.height);
        const margin = 4 * labelScale;
        return {
            left: topLeft.x + margin,
            top: topLeft.y + margin,
            right: bottomRight.x - margin,
            bottom: bottomRight.y - margin,
        };
    }

    // True when a plaque board centred on (x, y) — plus `pad` for the selected
    // gold rim — or, when `poleBottom` is given, its post (3 screen px wide,
    // `px` world px per screen px, from the board's foot down to
    // `poleBottom`) crosses any box.
    _plaqueHitsBoxes(x, y, tagW, tagH, pad, boxes, poleBottom = null, px = 1) {
        const left = x - tagW / 2 - pad;
        const right = x + tagW / 2 + pad;
        const top = y - tagH / 2 - pad;
        const bottom = y + tagH / 2 + pad;
        const poleTop = y + tagH / 2;
        const hasPole = Number.isFinite(poleBottom) && poleBottom > poleTop;
        const poleLeft = x - 1.5 * px;
        const poleRight = x + 2.5 * px;
        for (const box of boxes) {
            if (left < box.right && right > box.left && top < box.bottom && bottom > box.top) return true;
            if (hasPole && poleLeft < box.right && poleRight > box.left && poleTop < box.bottom && poleBottom > box.top) return true;
        }
        return false;
    }

    // V8 reserved rects (integer CSS px over the world canvas) as world boxes
    // under the overlay transform; empty when the context cannot say.
    _reservedWorldBoxes(ctx, reserved) {
        const out = this._chromeWorldBoxes || (this._chromeWorldBoxes = []);
        out.length = 0;
        if (!reserved?.length || typeof ctx?.getTransform !== 'function') return out;
        const matrix = ctx.getTransform();
        if (!matrix || typeof matrix.inverse !== 'function' || !matrix.a || !matrix.d) return out;
        const inverse = matrix.inverse();
        const cssWidth = ctx.canvas?.clientWidth || 0;
        const dpr = cssWidth > 0 ? ctx.canvas.width / cssWidth : (globalThis.devicePixelRatio || 1);
        for (const rect of reserved) {
            const x0 = rect.left * dpr;
            const y0 = rect.top * dpr;
            const x1 = rect.right * dpr;
            const y1 = rect.bottom * dpr;
            const ax = inverse.a * x0 + inverse.c * y0 + inverse.e;
            const ay = inverse.b * x0 + inverse.d * y0 + inverse.f;
            const bx = inverse.a * x1 + inverse.c * y1 + inverse.e;
            const by = inverse.b * x1 + inverse.d * y1 + inverse.f;
            out.push({ left: Math.min(ax, bx), right: Math.max(ax, bx), top: Math.min(ay, by), bottom: Math.max(ay, by) });
        }
        return out;
    }

    // Keeps a plaque (board and post) off reserved chrome: flipped just below
    // the chrome it touches, else stepped left of it, staying inside `view`.
    // Returns false (layout restored) when neither clears every chrome box.
    _clearPlaqueOfChrome(layout, { tagW, tagH, pad, poleBottom, chromeBoxes, view }) {
        const px = pad / 2;
        const hits = () => this._plaqueHitsBoxes(layout.x, layout.y, tagW, tagH, pad, chromeBoxes, poleBottom, px);
        if (!hits()) return true;
        const startX = layout.x;
        const startY = layout.y;
        const move = (x, y) => {
            const dx = x - layout.x;
            const dy = y - layout.y;
            layout.x = x;
            layout.y = y;
            layout.box = {
                left: layout.box.left + dx,
                right: layout.box.right + dx,
                top: layout.box.top + dy,
                bottom: layout.box.bottom + dy,
            };
        };
        const inView = () => !view || (layout.x - tagW / 2 >= view.left && layout.x + tagW / 2 <= view.right
            && layout.y - tagH / 2 >= view.top && layout.y + tagH / 2 <= view.bottom);
        for (const chrome of chromeBoxes) {
            if (!this._plaqueHitsBoxes(startX, startY, tagW, tagH, pad, [chrome], poleBottom, px)) continue;
            move(startX, chrome.bottom + pad + tagH / 2);
            if (inView() && !hits()) return true;
            move(chrome.left - pad - tagW / 2, startY);
            if (inView() && !hits()) return true;
        }
        move(startX, startY);
        return false;
    }

    // Moves a chosen plaque layout wholly inside `view`, or returns false when
    // its building is out of view (then the plaque is not drawn at all).
    _placePlaqueInView(chosen, view, { buildingLeft, buildingRight, buildingTop, buildingBottom, tagW, tagH }) {
        const { layout } = chosen;
        const left = layout.x - tagW / 2;
        const top = layout.y - tagH / 2;
        if (left >= view.left && top >= view.top && left + tagW <= view.right && top + tagH <= view.bottom) return true;
        const buildingInView = buildingRight > view.left && buildingLeft < view.right
            && buildingBottom > view.top && buildingTop < view.bottom
            && layout.x >= view.left && layout.x <= view.right;
        if (!buildingInView || tagW > view.right - view.left || tagH > view.bottom - view.top) return false;
        const dx = Math.min(Math.max(left, view.left), view.right - tagW) - left;
        const dy = Math.min(Math.max(top, view.top), view.bottom - tagH) - top;
        layout.x += dx;
        layout.y += dy;
        layout.box = {
            left: layout.box.left + dx,
            right: layout.box.right + dx,
            top: layout.box.top + dy,
            bottom: layout.box.bottom + dy,
        };
        return true;
    }

    // T3 plaque count per district: each live body counted once, at the
    // district it belongs to — the building it stands folded into, else the
    // building its walk is routed to (walking there or queued on the apron),
    // else its session's assigned building. A body only crossing another
    // district's footprint on its walk counts at its destination. One pass
    // over the sprites per label frame.
    // W5.5a — the same pass counts every live body that needs action
    // (SignalLedger's actionable buckets, the T1 beacon population) into
    // `plaqueAttention`: null at zero, else the exact count and the lead
    // bucket's hue and motif for the Command plaque's attention cell.
    _plaqueCountsByType() {
        const counts = this._plaqueCounts || (this._plaqueCounts = new Map());
        counts.clear();
        const actionable = this._plaqueActionable || (this._plaqueActionable = Object.fromEntries(ACTIONABLE_BUCKETS.map(name => [name, 0])));
        for (const name of ACTIONABLE_BUCKETS) actionable[name] = 0;
        let actionableTotal = 0;
        for (const sprite of this.agentSprites || []) {
            const agent = sprite?.agent;
            if (!agent || agent.isDeparted || sprite._archiveAnim || sprite.isArrivalPending?.()) continue;
            const bucket = bucketForStatus(agent.status);
            if (isActionableBucket(bucket)) {
                actionable[bucket]++;
                actionableTotal++;
            }
            // V8 (M12) — a plaque number means work: a resting body (7.1 seat)
            // counts nowhere, and a petitioner in the Command queue (7.2)
            // counts at its own district, never at Command.
            if (sprite.visitRole === 'rest') continue;
            if (sprite.visitRole === 'queue') {
                const own = String(agent.targetBuildingType || agent.lastKnownBuildingType || '').trim();
                if (own && own !== 'command') counts.set(own, (counts.get(own) || 0) + 1);
                continue;
            }
            const fold = sprite._foldBuildingType || null;
            const route = sprite._lastBuildingType || null;
            const passing = Boolean(sprite.moving && fold && route && route !== fold);
            const type = (passing ? route : fold)
                || route
                || String(agent.targetBuildingType || '').trim()
                || null;
            if (!type) continue;
            counts.set(type, (counts.get(type) || 0) + 1);
        }
        const lead = actionableTotal ? ACTIONABLE_BUCKETS.find(name => actionable[name] > 0) : null;
        this.plaqueAttention = lead ? { count: actionableTotal, bucket: lead, ...PLAQUE_ATTENTION[lead] } : null;
        return counts;
    }

    // Plaque geometry in screen pixels (before the 1/zoom counter-scale).
    _measurePlaque(ctx, building, attempt, { count, zoom, isHovered, isLandmark, scaleMode, attention = null }) {
        const motif = attempt.motif ? DISTRICT_MOTIFS[building.type] || null : null;
        ctx.save();
        ctx.font = WORLD_DISPLAY_FONT_8;
        const title = attempt.text
            ? this._labelMetrics(ctx, building, {
                text: attempt.text,
                labelFont: WORLD_DISPLAY_FONT_8,
                maxTextWidth: attempt.maxTextWidth,
                zoom,
                isHovered,
                isLandmark,
                scaleMode,
            })
            : { displayText: '', width: 0 };
        ctx.font = WORLD_BODY_FONT_11;
        const countText = count > 0 ? String(count) : '';
        const countWidth = countText ? measureLabelText(ctx, countText) : 0;
        // W7.5 — a muster row keeps its exact `· out ▸ returned` tail whole
        // and shortens only the parent's name to make room.
        const rowMaxWidth = attempt.rowMaxWidth || 180;
        const rows = (attempt.rows || []).map(row => {
            if (!row.muster) return { ...row, label: fitLabelText(ctx, row.label, rowMaxWidth) };
            const musterLeft = ` · ${row.muster.out} `;
            const musterRight = ` ${row.muster.returned}`;
            const leftWidth = Math.round(measureLabelText(ctx, musterLeft));
            const tailWidth = leftWidth + PLAQUE_MUSTER_ARROW_W + Math.round(measureLabelText(ctx, musterRight));
            const label = fitLabelText(ctx, row.label, Math.max(0, rowMaxWidth - (row.profile ? 8 : 0) - tailWidth));
            return { ...row, label, musterLeft, musterRight, leftWidth, tailWidth };
        });
        const rowsWidth = rows.reduce((max, row) => Math.max(max, Math.round(measureLabelText(ctx, row.label)) + (row.profile ? 8 : 0) + (row.tailWidth || 0)), 0);
        const attentionText = attention?.count > 0 ? String(attention.count) : '';
        const attentionWidth = attentionText ? measureLabelText(ctx, attentionText) : 0;
        ctx.restore();
        const titleWidth = Math.round(title.width);
        const motifWidth = motif ? 8 + 5 : 0;
        let headWidth = PLAQUE_PAD + motifWidth + titleWidth + (titleWidth ? PLAQUE_PAD : 0);
        if (!titleWidth && motif) headWidth = PLAQUE_PAD + 8 + PLAQUE_PAD;
        const countCell = countText ? 1 + PLAQUE_PAD + countWidth + PLAQUE_PAD : 0;
        // W5.5a — `COMMAND │ 7 │ ⟡3`: a status-hue cell at the head band's
        // right end, the lead bucket's motif and the exact actionable count in
        // plate ink. Absent at zero, so the plaque is then unchanged.
        const attentionCell = attentionText ? PLAQUE_PAD + 8 + PLAQUE_ATTENTION_GAP + attentionWidth + PLAQUE_PAD : 0;
        const width = Math.max(headWidth + countCell + attentionCell, rowsWidth + PLAQUE_PAD * 2) + 2;
        const height = PLAQUE_HEAD_H + (rows.length ? rows.length * PLAQUE_ROW_H + 3 : 0);
        const plaque = {
            motif,
            title: title.displayText,
            titleWidth,
            countText,
            headWidth,
            rows,
            width,
            height,
        };
        if (attentionText) {
            plaque.attention = attention;
            plaque.attentionText = attentionText;
            plaque.attentionCell = attentionCell;
        }
        return plaque;
    }

    _paintPlaque(ctx, plaque, { x, y, labelScale, poleBottom, isHovered, isSelected, isLandmark, alert, accent }) {
        const { width, height } = plaque;
        const lit = isHovered || isSelected;
        // The post: one screen pixel from the board's foot into the roof.
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(labelScale, labelScale);
        snapScreenOrigin(ctx);
        const left = -Math.round(width / 2);
        const top = -Math.round(height / 2);
        const postTop = top + height;
        const postBottom = Math.round((poleBottom - y) / labelScale);
        if (postBottom > postTop) {
            ctx.fillStyle = WALNUT.outline;
            ctx.fillRect(-1, postTop, 3, postBottom - postTop);
            ctx.fillStyle = WALNUT.bevel;
            ctx.fillRect(0, postTop, 1, postBottom - postTop);
        }
        if (isSelected) {
            ctx.fillStyle = LABEL_INK.gold;
            ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
        }
        paintWalnutBoard(ctx, left, top, width, height, { nails: isLandmark || lit, lit });
        // A verified failed push on the watchtower carries a red left rail;
        // nothing else on a plaque claims an outcome.
        if (alert) {
            ctx.fillStyle = '#e06c5b';
            ctx.fillRect(left + 1, top + 1, 2, height - 2);
        }
        let cursor = left + 1 + PLAQUE_PAD;
        if (plaque.motif) {
            drawOutlinedMotif(ctx, plaque.motif, cursor, top + 4, {
                color: lit ? '#ffe7a3' : accent,
                outline: WALNUT.outline,
            });
            cursor += 8 + 5;
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (plaque.title) {
            ctx.font = WORLD_DISPLAY_FONT_8;
            ctx.fillStyle = lit ? '#ffe7a3' : WALNUT.text;
            ctx.fillText(plaque.title, cursor, top + 13);
        }
        if (plaque.countText) {
            const dividerX = left + 1 + plaque.headWidth;
            ctx.fillStyle = WALNUT.divider;
            ctx.fillRect(dividerX, top + 2, 1, PLAQUE_HEAD_H - 4);
            ctx.font = WORLD_BODY_FONT_11;
            ctx.fillStyle = WALNUT.count;
            ctx.fillText(plaque.countText, dividerX + 1 + PLAQUE_PAD, top + 12);
        }
        if (plaque.attention) {
            // Right-aligned inside the outline, over the head band's bevel
            // and shade rows like the T1 plate's status cell.
            const cellLeft = left + width - 1 - plaque.attentionCell;
            ctx.fillStyle = plaque.attention.color;
            ctx.fillRect(cellLeft, top + 1, plaque.attentionCell, PLAQUE_HEAD_H - 2);
            drawOutlinedMotif(ctx, plaque.attention.motif, cellLeft + PLAQUE_PAD, top + 4, {
                color: LABEL_INK.plate,
                outline: 'transparent',
            });
            ctx.font = WORLD_BODY_FONT_11;
            ctx.fillStyle = LABEL_INK.plate;
            ctx.fillText(plaque.attentionText, cellLeft + PLAQUE_PAD + 8 + PLAQUE_ATTENTION_GAP, top + 12);
        }
        if (plaque.rows.length) {
            ctx.fillStyle = WALNUT.shade;
            ctx.fillRect(left + 2, top + PLAQUE_HEAD_H - 1, width - 4, 1);
            ctx.font = WORLD_BODY_FONT_11;
            plaque.rows.forEach((row, index) => {
                const baseline = top + PLAQUE_HEAD_H + 1 + index * PLAQUE_ROW_H + 9;
                let rowX = left + 1 + PLAQUE_PAD;
                if (row.profile) {
                    // Repo swatch: a 3×3 pixel diamond in the repo accent.
                    ctx.fillStyle = row.profile.accent || WALNUT.text;
                    ctx.fillRect(rowX + 1, baseline - 6, 1, 3);
                    ctx.fillRect(rowX, baseline - 5, 3, 1);
                    rowX += 8;
                }
                ctx.fillStyle = row.color || WALNUT.count;
                ctx.fillText(row.label, rowX, baseline);
                if (row.musterLeft) {
                    // `· 6 ▸ 2` in count ink; the ▸ is a 3×5 carved
                    // triangle (Departure Mono has no U+25B8).
                    let tailX = rowX + Math.round(measureLabelText(ctx, row.label));
                    ctx.fillStyle = WALNUT.count;
                    ctx.fillText(row.musterLeft, tailX, baseline);
                    tailX += row.leftWidth;
                    ctx.fillRect(tailX, baseline - 6, 1, 5);
                    ctx.fillRect(tailX + 1, baseline - 5, 1, 3);
                    ctx.fillRect(tailX + 2, baseline - 4, 1, 1);
                    ctx.fillText(row.musterRight, tailX + PLAQUE_MUSTER_ARROW_W, baseline);
                }
            });
        }
        ctx.restore();
    }

    _labelLayoutCandidates(isLandmark, isHovered) {
        const major = isLandmark || isHovered;
        const drift = major ? 9 : 7;
        return [
            { dx: 0, dy: 0 },
            { dx: -drift, dy: -9 },
            { dx: drift, dy: -9 },
            { dx: -drift, dy: 9 },
            { dx: drift, dy: 9 },
            { dx: major ? 0 : -4, dy: -14 },
            { dx: major ? 0 : 4, dy: -14 },
            { dx: 0, dy: major ? 18 : 14 },
            { dx: -drift, dy: major ? 18 : 14 },
            { dx: drift, dy: major ? 18 : 14 },
            { dx: major ? 0 : -6, dy: major ? 26 : 19 },
            { dx: major ? 0 : 6, dy: major ? 26 : 19 },
            { dx: -drift, dy: -18 },
            { dx: drift, dy: -18 },
            // Escape rows for a roof crowded with names: step the board
            // further up rather than onto a label.
            { dx: 0, dy: -30 },
            { dx: -drift * 2, dy: -30 },
            { dx: drift * 2, dy: -30 },
            { dx: 0, dy: -42 },
        ];
    }

    _labelRenderAttempts(building, { isHovered, isLandmark, zoom, localLabelDensity = 0, harborLedgerRows = [], musterRows = [], readRows = null }) {
        if (readRows?.length) {
            return [{
                text: readRows[0],
                rows: readRows.slice(1).map(label => ({ label })),
                motif: true,
                maxTextWidth: 180,
                rowMaxWidth: 180,
                overlapTolerance: 1,
                blockAgents: false,
            }];
        }
        const major = isHovered || isLandmark;
        const overlapScale = localLabelDensity >= 2 ? 1.2 : 1;
        const baseText = this._labelTextFor(building, zoom, isHovered);
        const compactText = this._labelTextFor(building, LABEL_VISIBLE_ZOOM, false);
        const isHarborLedger = building.type === 'harbor' && harborLedgerRows.length > 0;
        // W7.5 — the Command plaque's muster rows ride the compact name like
        // the harbor ledger; the fallbacks below drop them, as they do there.
        const isMuster = building.type === 'command' && musterRows.length > 0;
        const attempts = [{
            text: isHarborLedger || isMuster ? compactText : baseText,
            rows: isHarborLedger ? harborLedgerRows : isMuster ? musterRows : [],
            rowMaxWidth: isHovered ? 214 : 184,
            motif: true,
            maxTextWidth: isHovered ? 190 : isLandmark ? 132 : 96,
            overlapTolerance: major ? Math.min(0.92, LABEL_OVERLAP_TOLERANCE * overlapScale) : 0.3,
            blockAgents: true,
        }];
        if (compactText && compactText !== baseText) {
            attempts.push({
                text: compactText,
                motif: true,
                maxTextWidth: isLandmark ? 92 : 76,
                overlapTolerance: major ? Math.min(0.95, LABEL_COMPACT_OVERLAP_TOLERANCE * overlapScale) : 0.38,
                blockAgents: true,
            });
        }
        // Last resort: the district motif alone (plus the exact count). The
        // name never falls back to a smaller, off-grid font.
        attempts.push({
            text: '',
            motif: true,
            maxTextWidth: 0,
            overlapTolerance: major ? 1 : 0.9,
            blockAgents: false,
        });
        return attempts;
    }

    _resolveLabelLayout({
        candidates,
        occupied,
        occupiedExternal = [],
        hardBoxes = [],
        hardPad = 0,
        centerX,
        centerY,
        tagW,
        tagH,
        maxOverlap = LABEL_OVERLAP_TOLERANCE,
        localLabelDensity = 0,
    }) {
        let best = null;
        let bestOverlap = Number.POSITIVE_INFINITY;
        const boxPad = localLabelDensity >= 2 ? 2 : 4;
        const bottomPad = Math.max(6, Math.round(tagH * 0.55) + (localLabelDensity >= 2 ? 4 : 6));

        for (const { dx, dy } of candidates) {
            const labelX = centerX + dx;
            const labelY = centerY + dy;
            if (hardBoxes.length && this._plaqueHitsBoxes(labelX, labelY, tagW, tagH, hardPad, hardBoxes)) continue;
            const tagLeft = labelX - tagW / 2;
            const tagTop = labelY - tagH / 2;
            const box = {
                left: tagLeft - boxPad,
                top: tagTop - (boxPad - 1),
                right: tagLeft + tagW + boxPad,
                bottom: tagTop + tagH + bottomPad,
            };
            const blocked = [...occupied, ...occupiedExternal];
            const overlap = this._boxesMaxOverlapRatio(box, blocked);
            if (overlap === 0) {
                return { x: labelX, y: labelY, box };
            }
            if (overlap < bestOverlap) {
                bestOverlap = overlap;
                best = { x: labelX, y: labelY, box, overlap };
            }
        }
        if (bestOverlap > maxOverlap) return null;
        return best;
    }

    _normalizeBoxes(boxes = []) {
        return boxes.map((box) => {
            if (box && 'left' in box && 'right' in box && 'top' in box && 'bottom' in box) return box;
            if (!box || !('w' in box) || !('h' in box)) return null;
            return {
                left: box.x,
                right: box.x + box.w,
                top: box.y,
                bottom: box.y + box.h,
            };
        }).filter(Boolean);
    }

    _spriteTilePosition(sprite) {
        if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) return null;
        return worldToTile(sprite.x, sprite.y);
    }

    _forgeGlowIntensity() {
        return clamp01(this._forgeGlow);
    }

    // Global beacon intensity (0..1): emitters/window-warmth/light glow all
    // breathe with it as night deepens or a storm rolls in. Slow band, driven by
    // AtmosphereState's time-of-day/weather lighting. Reduced motion holds a
    // static mid value so the village stays lit without per-frame change.
    _beaconIntensity(lightingState = this.lightingState) {
        if (!this.motionScale) return 0.5;
        const value = lightingState?.beaconIntensity
            ?? this.atmosphereState?.lighting?.beaconIntensity;
        return Number.isFinite(value) ? clamp01(value) : 0.5;
    }

    // Per-building beacon multiplier (0..1) blending the global intensity with a
    // per-type base so strong emitters react fully and quiet ones hold back.
    _beaconScaleFor(buildingType, lightingState = this.lightingState) {
        if (!buildingType) return 1;
        return this._beaconIntensity(lightingState) * getBuildingBeaconBase(buildingType);
    }

    _watchtowerActiveCount() {
        const wiredCount = this.harborStatus?.activeWorkingCount;
        if (Number.isFinite(wiredCount)) return Math.max(0, wiredCount);
        return this.agentSprites.filter(sprite => sprite?.agent?.status === 'WORKING').length;
    }

    // Water-only reflection of the lantern fire, clock-gated independently
    // of working occupants. The beam/column share subdued warm cream.
    lighthouseColumnSource(lightingState = this.lightingState) {
        if (lampCourseFor(this.atmosphereState) < LAMP_COURSE_LAMPLIGHT) return null;
        const energy = sourceEnergyFor(lightingState ?? this.atmosphereState?.lighting);
        if (!(energy.core > 0.02)) return null;
        const source = this._staticLightSources().find(light => light.buildingType === 'watchtower');
        const drop = this._lighthouseMirrorDrop();
        if (!source || drop == null) return null;
        return normalizeLightSource({
            ...source,
            id: `${source.id}:column`,
            color: LIGHTHOUSE_COLUMN_COLOR,
            intensity: energy.core * LIGHTHOUSE_COLUMN_GAIN,
            radius: Math.min(source.radius * energy.halo, SOURCE_HALO_RADIUS_CAP),
            height: drop,
            waterOnly: true,
            columnReach: LIGHTHOUSE_COLUMN_REACH,
            origin: source.origin || { x: source.x, y: source.y },
        }, {
            buildingType: source.buildingType,
            building: source.building,
        });
    }

    // 2.9 — where the lamp sits in its tower's mirror, in world px below the
    // lamp's foot: CoastBake mirrors each sprite column about its own
    // waterline (`waterlineProfile`), a tall tower squashed so the whole
    // shaft and lantern fit its reach (`mirrorRowOf`), so the lamp's column
    // starts under the mirrored lantern, never a full tower height below the
    // waterline. Read once from the tower sprite (null until it has loaded).
    _lighthouseMirrorDrop() {
        if (this._lighthouseMirrorDropValue != null) return this._lighthouseMirrorDropValue;
        const entry = this.assets.getEntry('building.watchtower');
        const image = this.assets.get(entry?.id || 'building.watchtower');
        const w = image?.naturalWidth || image?.width || 0;
        const h = image?.naturalHeight || image?.height || 0;
        const data = w && h ? readPixels(image, w, h) : null;
        const foot = WATCHTOWER_LANTERN_FIRE.foot;
        if (!data || !foot) return null;
        const [lampX, lampY] = WATCHTOWER_LANTERN_FIRE.light;
        const axis = waterlineProfile({ w, h, data }, 0).axis[Math.round(lampX)];
        if (axis == null) return null;
        this._lighthouseMirrorDropValue = Math.max(0, axis + mirrorRowOf(h, axis - lampY) - foot[1]);
        return this._lighthouseMirrorDropValue;
    }

    // Light sources for water/wall additive light passes (Phase 2.5.5).
    // `overlay` is the atmosphere sprite id used for the additive reflection.
    //
    // 3.1 — every source reads the shared exposure envelope instead of the old
    // stack of continuous boosts (`lightBoost` x window warmth x beacon x
    // presence). Occupancy still decides *whether* and *how strongly* a place
    // is lit; the envelope decides how much energy that light may spend, and
    // `SOURCE_HALO_RADIUS_CAP` caps halo area by authored source geometry, so
    // the wide Lighthouse and Harbor lamps stop out-glowing the work (D4).
    // 2.4 — plus every lit window, lantern and opening of the landmarks'
    // emissive art (`_apertureSources`), each gated by its own room.
    getLightSources(lightingState = this.lightingState) {
        const energy = sourceEnergyFor(lightingState ?? this.atmosphereState?.lighting);
        const windowWarmth = this.atmosphereState?.reactions?.windowWarmth || 0;
        const staticSources = this._staticLightSources();
        const apertures = this._apertureSources();
        const standIns = this._apertureStandIns;
        const nightGate = this._nightWindowGate();
        const out = [];
        for (const source of staticSources) {
            // The Lighthouse fire lights no ground, apron, steps or masonry.
            // Its own light is the warm halo and descending mirror shaft
            // (_drawWatchtowerFire) and the beam on the sea (lighthouseBeam);
            // 2.9 adds its column on the water through
            // `lighthouseColumnSource`, fed to the resident loop only (no
            // pool, cast or wet reflection reads it).
            if (source.buildingType === 'watchtower') continue;
            // V8 — only real work (isWorkingVisitor) warms a building's light;
            // seated, queued or passing bodies leave it exactly as empty.
            const working = source.building ? this._workingVisitorCountFor(source.building) : 0;
            let activity = working > 0 ? 1.12 : 1;
            let alpha = source.alpha;
            if (source.buildingType === 'forge') {
                activity = 0.58 + this._forgeGlowIntensity() * 0.74;
            }
            const warmthBoost = source.kind === 'beam' ? 0 : windowWarmth * 0.16;
            const typeResponse = source.kind === 'beam'
                ? 1
                : 0.62 + 0.38 * getBuildingBeaconBase(source.buildingType);
            const presenceRadiusMult = source.building
                ? PRESENCE_TIER_TABLE[this._workTierFor(source.building)].radius
                : 1;
            const radius = Math.min(source.radius * energy.halo, SOURCE_HALO_RADIUS_CAP) * presenceRadiusMult;
            // A registry point standing on a room's glass (`_apertureSources`)
            // is that room's light: it takes the room's gate, never the
            // building's, so a lit room lights and a dark room stays dark.
            const standIn = standIns?.get(source) || 0;
            const emissiveGate = standIn > 0
                ? 1 - nightGate + this.roomGate(source.buildingType, standIn - 1)
                : source.buildingType ? this._emissiveGateFor(source.building) : 1;
            const intensity = (activity + warmthBoost) * typeResponse * energy.core * emissiveGate;
            if (intensity < 0.02) continue;
            if (alpha != null) alpha *= energy.core * emissiveGate;
            out.push(normalizeLightSource({
                ...source,
                intensity,
                radius,
                alpha,
                origin: source.origin || { x: source.x, y: source.y },
            }, {
                buildingType: source.buildingType,
                building: source.building,
            }));
        }
        for (const source of this._ritualLightSources(energy.core)) out.push(this._withLightFoot(source, 'point'));
        for (const source of this._forgeSpillLightSources(energy.core)) out.push(this._withLightFoot(source, 'aperture'));
        for (const source of this._archiveSpillLightSources(energy.core)) out.push(this._withLightFoot(source, 'aperture'));
        // 2.4 — the lit panes and openings of each landmark's emissive art:
        // a room's glass by that room's gate (roomGate: a dark room lights
        // nothing), a lantern or opening by the building's night shift (a
        // real worker inside, V8), each on its own wall base facing its face.
        for (const aperture of apertures) {
            const type = aperture.building.type;
            const template = aperture.template;
            const gate = template.group > 0
                ? this.roomGate(type, template.group - 1)
                : this._nightShiftLit(type) * nightGate;
            if (!(gate > 0)) continue;
            const intensity = apertureIntensity(template.area, energy.core, gate);
            if (intensity < 0.02) continue;
            out.push(normalizeLightSource({
                ...aperture.source,
                intensity,
                radius: apertureRadius(template.area),
            }, {
                buildingType: type,
                building: aperture.building,
            }));
        }
        return out;
    }

    // Ground-spill light from the archive doorway: when reading is busy the warm
    // lamplight bleeds out the door and across the entrance steps via the
    // screen-composite light path (overlay sprite). Brightness tracks the read
    // counter (_archiveReadIntensity). Lamplight, not fire: it never flickers
    // (2.6). V8 — the read counter is village-wide; the spill stands on the
    // Archive's own night shift (a real worker inside), so a dark Archive
    // lights no step whatever is read elsewhere.
    _archiveSpillLightSources(coreEnergy = 1) {
        const readIntensity = this._archiveReadIntensity || 0;
        if (readIntensity <= 0.4) return [];
        const strength = clamp01((readIntensity - 0.4) / 0.6);
        const sources = [];
        for (const building of this.buildings) {
            if (building.type !== 'archive') continue;
            const gate = this._emissiveGateFor(building);
            if (!(gate > 0)) continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            const [stepX, stepY] = getBuildingEffectAnchor('archive', 'step', [168, 142]);
            sources.push(normalizeLightSource({
                id: `archive:${building.position?.tileX ?? 0}.${building.position?.tileY ?? 0}:spill`,
                kind: 'spark',
                origin: {
                    x: center.x - baseAnchor[0] + stepX,
                    y: center.y - baseAnchor[1] + stepY,
                },
                color: '#ffd98a',
                radius: 40 + strength * 16,
                // WorldFrameRenderer's reflection pass scales overlay alpha by
                // `intensity`; drive it from the read counter so the spill
                // brightens with reading. `alpha` is kept for any alpha-aware path.
                intensity: (0.6 + strength * 0.9) * gate,
                alpha: (0.18 + strength * 0.30) * 0.9 * coreEnergy * gate,
                overlay: 'atmosphere.light.lantern-glow',
                buildingType: building.type,
                building,
            }, {
                buildingType: building.type,
                building,
            }));
        }
        return sources;
    }

    // Ground-spill light from the forge molten pool: when the smithy is hot and
    // the world is dark, the apron glow bleeds onto adjacent tiles/water via the
    // screen-composite light path. Brightness tracks _forgeGlow (#11); as a
    // fire source it breathes in the stepped quanta of 2.6 (`fire: true`,
    // applied once per frame by the renderer), never a continuous sine. V8 —
    // it stands on the Forge's own night shift, like its registry hearth.
    _forgeSpillLightSources(coreEnergy = 1) {
        const night = clamp01(this.atmosphereState?.reactions?.nightReflection ?? 0);
        const heat = clamp01((this._forgeGlowIntensity() - FORGE_GLOW_BASELINE) / (1 - FORGE_GLOW_BASELINE));
        const sources = [];
        for (const building of this.buildings) {
            if (building.type !== 'forge') continue;
            const strength = night * heat * this._emissiveGateFor(building);
            if (strength <= 0.05) continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            sources.push(normalizeLightSource({
                id: `forge:${building.position?.tileX ?? 0}.${building.position?.tileY ?? 0}:spill`,
                kind: 'spark',
                origin: {
                    x: center.x - baseAnchor[0] + getBuildingEffectAnchor('forge', 'spill', [77, 138])[0],
                    y: center.y - baseAnchor[1] + getBuildingEffectAnchor('forge', 'spill', [77, 138])[1],
                },
                color: '#ff9a4d',
                radius: 52 + strength * 18,
                alpha: strength * 0.4 * 0.9 * coreEnergy,
                fire: true,
                overlay: 'atmosphere.light.fire-glow',
                buildingType: building.type,
                building,
            }, {
                buildingType: building.type,
                building,
            }));
        }
        return sources;
    }

    // V5 / 2.1 — a building light's foot, height and facing. An authored
    // `foot` (sprite px, the space of `at`) stands a free fixture on its own
    // base (the Lighthouse lamp on its tower); otherwise the source is a
    // facade aperture whose foot lies straight below it, facing the face it
    // is on, so it lights the street in front of that face and never its own
    // wall. On a 2.3 surface-coded landmark the occluder sidecar at the
    // source pixel says how high above the ground it is (R) and which face it
    // is on (B): a window's foot is its wall's base, a lamp on steps or a
    // deck stands on them. Otherwise the foot is the footprint's front edge
    // (BUILDING_DEFS through tileToWorld), and a source already at or in
    // front of that edge (a doorstep, an apron spill) stands on its own point.
    _lightFootFor(building, origin, source = null, toWorld = null) {
        const landmarkId = GPU_LANDMARK_IDS[building?.type] || 0;
        if (Array.isArray(source?.foot) && toWorld) {
            const ground = toWorld(source.foot);
            return { ground, height: Math.max(0, ground.y - origin.y), normal: null, role: source.role || 'fixture', landmarkId };
        }
        const surface = Array.isArray(source?.at) ? this._surfaceCodeAt(building?.type, source.at) : null;
        if (surface) {
            const wall = surface.face === 1 || surface.face === 2;
            const role = source?.role && (wall || source.role !== 'aperture') ? source.role : wall ? 'aperture' : 'fixture';
            return {
                ground: { x: origin.x, y: origin.y + surface.height },
                height: surface.height,
                normal: wall ? [surface.face === 1 ? -Math.SQRT1_2 : Math.SQRT1_2, Math.SQRT1_2] : null,
                role,
                landmarkId,
            };
        }
        const foot = frontEdgeFoot(landmarkFootprint(building), origin.x);
        if (origin.y >= foot.y - 1) {
            // On or in front of the edge there is no face to emit from: an
            // aperture there (a doorstep spill) lights all round like a fixture.
            const role = source?.role && source.role !== 'aperture' ? source.role : 'fixture';
            return { ground: { x: origin.x, y: origin.y }, height: 0, normal: null, role, landmarkId };
        }
        return {
            ground: { x: foot.x, y: foot.y },
            height: foot.y - origin.y,
            normal: foot.normal,
            role: source?.role || 'aperture',
            landmarkId,
        };
    }

    // 2.3 — the surface code under one sprite px of a surface-coded landmark:
    // `{ height, face }` (R = true height above ground, B >> 6 = face class,
    // docs/material-channel-contract.md), or null (not coded, transparent
    // there, or no pixel access). While the occluder is still loading, marks
    // the static light cache pending so it is rebuilt once the pixels land.
    // Canvas mode loads no material companions: the occluder sidecar is then
    // fetched once beside the versioned albedo (as EmitterCuts and RoofWeather
    // do), so both backends stand a light on the same foot.
    _surfaceCodeAt(type, at) {
        const id = `building.${type}`;
        const entry = this.assets?.getEntry?.(id);
        if (entry?.surfaceCode !== true) return null;
        const lx = Math.round(at[0]);
        const ly = Math.round(at[1]);
        const key = `${this.assets.assetVersion ?? ''}|${id}|${lx},${ly}`;
        const cache = this._surfaceCodeCache || (this._surfaceCodeCache = new Map());
        if (cache.has(key)) return cache.get(key);
        let image = this.assets.getCompanion?.(id, 'occluder') || null;
        let ox = 0;
        let oy = 0;
        if (!image) {
            const frame = this.assets.getAtlasFrame?.(id);
            image = frame ? this.assets.getAtlas?.(frame.atlas, 'occluder') : null;
            ox = frame?.rect?.x ?? 0;
            oy = frame?.rect?.y ?? 0;
        }
        let loading = false;
        if (!image) {
            const sidecar = this._occluderSidecar(id, entry);
            loading = sidecar === undefined;
            image = sidecar || null;
            ox = 0;
            oy = 0;
        }
        const scratch = this._surfaceCodeCanvas || (this._surfaceCodeCanvas = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(1, 1)
            : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 1, height: 1 }) : null);
        if (!image || !(image.width > 0) || !scratch) {
            if (scratch && loading) this._lightFootPending = true;
            return null;
        }
        const ctx = scratch.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, 1, 1);
        ctx.drawImage(image, ox + lx, oy + ly, 1, 1, 0, 0, 1, 1);
        const [r, , b, a] = ctx.getImageData(0, 0, 1, 1).data;
        const code = a > 0 ? { height: r, face: b >> 6 } : null;
        cache.set(key, code);
        return code;
    }

    // The `.occluder.png` sidecar of `id` fetched beside its albedo: the
    // image, null (no sidecar, failed or no albedo url) or undefined while
    // it loads.
    _occluderSidecar(id, entry) {
        const key = `${this.assets.assetVersion ?? ''}|${id}`;
        const sidecars = this._occluderSidecars || (this._occluderSidecars = new Map());
        const cached = sidecars.get(key);
        if (cached !== undefined) return cached === 'loading' ? undefined : cached;
        const src = typeof this.assets.get?.(id)?.src === 'string' ? this.assets.get(id).src : '';
        if (entry?.occluderSidecar !== true || !src || typeof Image === 'undefined') {
            sidecars.set(key, null);
            return null;
        }
        const image = new Image();
        sidecars.set(key, 'loading');
        image.onload = () => sidecars.set(key, image);
        image.onerror = () => sidecars.set(key, null);
        image.src = src.replace(/\.png(?=([?#]|$))/, '.occluder.png');
        return undefined;
    }

    // The per-frame building sources (rituals, spills) stand on the same feet.
    _withLightFoot(source, role) {
        if (!source?.building || !Number.isFinite(source.x) || !Number.isFinite(source.y)) return source;
        return Object.assign(source, this._lightFootFor(source.building, source, { role }));
    }

    _staticLightSources() {
        if (this._lightSourcesCache) return this._lightSourcesCache;
        this._lightFootPending = false;
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            const c = this._buildingScreenCenter(b);
            const seen = new Set();
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${b.type}`);
            const toWorld = ([lx, ly]) => ({ x: c.x - baseAnchor[0] + lx, y: c.y - baseAnchor[1] + ly });
            const pushSource = (source) => {
                if (!source?.at) return;
                const [lx, ly] = source.at;
                const key = `${source.kind || 'point'}|${Math.round(lx)},${Math.round(ly)}|${source.overlay || ''}`;
                if (seen.has(key)) return;
                seen.add(key);
                const origin = toWorld(source.at);
                out.push(normalizeLightSource({
                    id: source.id || `building.${b.type}.${source.kind || 'point'}.${Math.round(lx)}.${Math.round(ly)}`,
                    origin,
                    ...this._lightFootFor(b, origin, source, toWorld),
                    fire: source.fire === true,
                    color: source.color || entry?.lightColor || '#ffcc66',
                    radius: source.radius || entry?.lightRadius || 64,
                    overlay: source.overlay || entry?.lightOverlay || 'atmosphere.light.lantern-glow',
                    buildingType: b.type,
                    kind: source.kind || 'point',
                    building: b,
                    length: source.length,
                    width: source.width,
                    alpha: source.alpha,
                    ttl: source.ttl,
                    createdAt: source.createdAt,
                    endpoints: source.endpoints,
                    controlPoint: source.controlPoint,
                    parent: source.parent,
                }, {
                    buildingType: b.type,
                    building: b,
                }));
            };

            if (Array.isArray(entry?.lightSources)) {
                for (const source of entry.lightSources) pushSource(source);
            }
            if (entry?.lightSource) {
                const watchtower = b.type === 'watchtower';
                pushSource({
                    at: watchtower ? WATCHTOWER_LANTERN_FIRE.light : entry.lightSource,
                    foot: watchtower ? WATCHTOWER_LANTERN_FIRE.foot : undefined,
                    color: entry.lightColor || 'rgba(255,210,140,0.4)',
                    radius: entry.lightRadius || 64,
                    overlay: entry.lightOverlay || 'atmosphere.light.lantern-glow',
                    // 2.6 — the Forge hearth light shares its fallback's point
                    // and wins the dedupe, so it carries the fallback's flag.
                    fire: BUILDING_LIGHT_FALLBACKS[b.type]?.fire === true,
                });
            }
            for (const source of LIGHT_SOURCE_REGISTRY[b.type] || []) {
                pushSource(source);
            }
            if (entry?.emitters) {
                // 2.6 — an emitter breathes when its light is a flame kind or
                // the manifest declares a `kind: fire` emissive on its geometry.
                const fireGeometry = new Set((entry.emissive?.sources || [])
                    .filter(source => source?.kind === 'fire')
                    .map(source => source.geometry));
                for (const [name, at] of Object.entries(entry.emitters)) {
                    const baseName = name.replace(/\d+$/, '');
                    const light = EMITTER_LIGHTS[baseName] || EMITTER_LIGHTS[name];
                    if (!light) continue;
                    const fire = light.fire === true || fireGeometry.has(`emitters.${baseName}`);
                    pushSource({ ...light, at, fire });
                }
            }
            const fallback = BUILDING_LIGHT_FALLBACKS[b.type];
            if (fallback) {
                pushSource(fallback);
            }
        }
        // A landmark whose surface code has not loaded yet keeps its analytic
        // foot for this frame only.
        if (!this._lightFootPending) this._lightSourcesCache = out;
        return out;
    }

    // 2.4 — every landmark's aperture templates (ApertureLights) placed in the
    // world: `{ building, template, source }` where `source` is the static
    // part of the light record (V5 foot, height, face normal and role from
    // `_lightFootFor` at the template's centroid, its own emissive colour).
    // A registry point standing on a room's glass (inside the room's glass
    // box grown by APERTURE_GLASS_SNAP px) stands in for that room: the room
    // template is skipped and `_apertureStandIns` maps the point to the room's
    // glass group, so `getLightSources` gates the point by that room (its
    // authored radius, height and normal kept). Any other room's glass lays
    // its own aperture however near a registry point stands; an off-glass
    // template within APERTURE_REGISTRY_CLEARANCE px of a building-gated
    // registry point is skipped: that point already lights it on the same
    // gate. Rebuilt when a template list lands or the static sources rebuild.
    _apertureSources() {
        const statics = this._staticLightSources();
        const key = this.apertureLights.revision;
        if (this._apertureSourcesCache && this._apertureSourcesKey === key
            && this._apertureSourcesStatics === statics && this._lightSourcesCache === statics) {
            return this._apertureSourcesCache;
        }
        const pendingBefore = this._lightFootPending;
        this._lightFootPending = false;
        const out = [];
        const standIns = new Map();
        let loading = false;
        for (const b of this.buildings) {
            const templates = this.apertureLights.templates(b.type);
            if (templates === null) {
                loading = true;
                continue;
            }
            if (!templates.length) continue;
            const entry = this.assets.getEntry(`building.${b.type}`);
            const c = this._buildingScreenCenter(b);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${b.type}`);
            const toWorld = ([lx, ly]) => ({ x: c.x - baseAnchor[0] + lx, y: c.y - baseAnchor[1] + ly });
            const registry = statics.filter(source => source.building === b);
            const stoodIn = new Set();
            for (const source of registry) {
                const room = templates.find(template => {
                    if (!(template.group > 0)) return false;
                    const a = toWorld([template.x0 - APERTURE_GLASS_SNAP, template.y0 - APERTURE_GLASS_SNAP]);
                    const z = toWorld([template.x1 + 1 + APERTURE_GLASS_SNAP, template.y1 + 1 + APERTURE_GLASS_SNAP]);
                    return source.x >= a.x && source.x <= z.x && source.y >= a.y && source.y <= z.y;
                });
                if (!room) continue;
                standIns.set(source, room.group);
                stoodIn.add(room.group);
            }
            const clearing = registry.filter(source => !standIns.has(source));
            for (const template of templates) {
                const origin = toWorld([template.cx, template.cy]);
                if (template.group > 0
                    ? stoodIn.has(template.group)
                    : clearing.some(source => Math.hypot(source.x - origin.x, source.y - origin.y) < APERTURE_REGISTRY_CLEARANCE)) continue;
                // A window over its own roofs stands on the footprint's front
                // edge below it (the analytic foot, facing that edge): its
                // light reaches the street in front of its own face.
                const at = apertureOverRoof(b.type, template) ? null : [template.cx, template.cy];
                out.push({
                    building: b,
                    template,
                    source: {
                        id: `aperture:${b.type}:${template.key}`,
                        kind: 'point',
                        origin,
                        x: origin.x,
                        y: origin.y,
                        ...this._lightFootFor(b, origin, { at, role: 'aperture' }, toWorld),
                        color: template.color,
                        overlay: 'atmosphere.light.lantern-glow',
                        buildingType: b.type,
                        building: b,
                    },
                });
            }
        }
        const pending = this._lightFootPending;
        this._lightFootPending = pendingBefore || pending;
        if (!loading && !pending && this._lightSourcesCache === statics) {
            this._apertureSourcesCache = out;
            this._apertureSourcesKey = key;
            this._apertureSourcesStatics = statics;
        }
        this._apertureStandIns = standIns;
        return out;
    }

    // Per-pixel hit test across all buildings (front halves only).
    hitTest(worldX, worldY) {
        const drawables = this.enumerateDrawables();
        for (let i = drawables.length - 1; i >= 0; i--) {
            const d = drawables[i];
            if (d.kind === 'building-back') continue;
            const id = d.entry.id;
            const [ax, ay] = this.assets.getAnchor(id);
            if (this.sprites.hitTest(id, worldX, worldY, d.wx - ax, d.wy - ay)) {
                return d.building;
            }
        }
        return null;
    }

    // 4.4 / 4.7 — the selectable world instruments this renderer draws (result
    // tiles, plan tabs). World-space rects, newest first, so the front-most
    // instrument wins exactly like the sprite hit test.
    _registerInstrumentHit(entry) {
        if (!entry?.agentId) return;
        this._instrumentHits.push(entry);
    }

    hitTestInstrument(worldX, worldY) {
        for (let index = this._instrumentHits.length - 1; index >= 0; index--) {
            const hit = this._instrumentHits[index];
            if (worldX >= hit.left && worldX <= hit.right && worldY >= hit.top && worldY <= hit.bottom) {
                return hit;
            }
        }
        return null;
    }

    // 5.6 — building-face chits and ground ledgers are for the building you
    // are looking at: shown on selection or hover, or once the camera is close
    // enough (zoom >= 3) for them to be part of the scene rather than grain.
    _chitsVisible(type) {
        if (!type) return true;
        return (this._zoom || 0) >= 3 || this._selectedBuildingType === type || this.hovered?.type === type;
    }

    // One small dark plate with one factual line on it, screen-fixed 11 px
    // Departure Mono at a world anchor (5.4: never world-scaled). Used by the
    // building instruments so counts read identically wherever they appear.
    // S4 — a ledger never prints inside a T1 attention plate's footprint:
    // the plate is the loudest thing there and the ledger steps aside.
    // Returns true when drawn.
    _drawInstrumentPlate(ctx, x, y, text, { color = '#e8e2d6', align = 'center', type = null, border = null } = {}) {
        const line = String(text || '');
        if (!line || !this._chitsVisible(type)) return false;
        const zoom = this._zoom > 0 ? this._zoom : 1;
        ctx.save();
        ctx.font = WORLD_BODY_FONT_11;
        const width = measureLabelText(ctx, line) + 8;
        const left = align === 'center' ? -Math.round(width / 2) : 0;
        const rect = { x: x + (left - 1) / zoom, y: y - 8 / zoom, w: (width + 2) / zoom, h: 16 / zoom };
        if (this._rectHitsAttention(rect)) {
            ctx.restore();
            return false;
        }
        ctx.translate(x, y);
        ctx.scale(1 / zoom, 1 / zoom);
        snapScreenOrigin(ctx);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = LABEL_INK.plateOutline;
        ctx.fillRect(left - 1, -8, width + 2, 16);
        ctx.fillStyle = LABEL_INK.plate;
        ctx.fillRect(left, -7, width, 14);
        if (border) {
            ctx.fillStyle = border;
            ctx.fillRect(left, -7, width, 1);
        }
        ctx.fillStyle = color;
        ctx.fillText(line, left + 4, 4);
        ctx.restore();
        return true;
    }

    // World rects ({x, y, w, h}) of this frame's T1 plates and beacons, handed
    // over by the renderer's label pass.
    _rectHitsAttention(rect) {
        for (const other of this.attentionWorldRects || []) {
            if (rect.x < other.x + other.w && rect.x + rect.w > other.x
                && rect.y < other.y + other.h && rect.y + rect.h > other.y) return true;
        }
        return false;
    }

    // True when a world rect crosses a T1 plate/beacon, a drawn identity
    // label (T2 plate or T4 name; last label pass) or any drawn body.
    _rectHitsSignalOrBody(rect) {
        if (this._rectHitsAttention(rect)) return true;
        for (const other of this.identityWorldRects || []) {
            if (rect.x < other.x + other.w && rect.x + rect.w > other.x
                && rect.y < other.y + other.h && rect.y + rect.h > other.y) return true;
        }
        for (const sprite of this.agentSprites || []) {
            const box = sprite?._bodyBox;
            if (!box || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
            if (rect.x < sprite.x + box.right && rect.x + rect.w > sprite.x + box.left
                && rect.y < sprite.y + box.bottom && rect.y + rect.h > sprite.y + box.top) return true;
        }
        return false;
    }

    // Returns drawable payloads (one per building, or two if splitForOcclusion).
    // Cached until the building list changes; hover and animation state are read
    // live by drawDrawable().
    enumerateDrawables() {
        if (this._drawablesCache) return this._drawablesCache;
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            if (!entry) continue;
            const center = this._buildingScreenCenter(b);
            const wx = center.x;
            const wy = center.y;
            if (entry.splitForOcclusion) {
                const dims = this.assets.getDims(entry.id);
                // Clamp manifest horizonY to a valid sub-rect inside the sprite so
                // the front half (`drawImage(... , h - horizonY, ...)`) never receives
                // a negative or zero source-rect height when manifest values drift.
                const rawHorizon = entry.horizonY ?? Math.floor(dims.h / 2);
                const horizonY = Math.max(1, Math.min(rawHorizon, dims.h - 1));
                out.push({ kind: 'building-back', building: b, entry, wx, wy, horizonY, sortY: wy - dims.h / 2 });
                out.push({ kind: 'building-front', building: b, entry, wx, wy, horizonY, sortY: this._buildingFrontSortY(b, wy) });
            } else {
                out.push({ kind: 'building', building: b, entry, wx, wy, sortY: this._buildingWholeSortY(b, wy) });
            }
        }
        out.sort(compareBuildingDrawableDepth);
        this._drawablesCache = out;
        return out;
    }

    drawDrawable(ctx, d) {
        const id = d.entry.id;
        if (d.kind === 'building') {
            const placed = this.sprites.drawSprite(ctx, id, d.wx, d.wy);
            if (placed) this._drawRoofWeather(ctx, d, placed.dx, placed.dy);
            this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'whole');
        } else {
            const dims = this.assets.getDims(id);
            const [ax, ay] = this.assets.getAnchor(id);
            const dx = Math.round(d.wx - ax);
            const dy = Math.round(d.wy - ay);
            const img = this.assets.get(id);
            if (!img) return;
            if (d.kind === 'building-back') {
                ctx.drawImage(img, 0, 0, dims.w, d.horizonY, dx, dy, dims.w, d.horizonY);
                this._drawRoofWeather(ctx, d, dx, dy);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'back', d.horizonY);
            } else {
                ctx.drawImage(img, 0, d.horizonY, dims.w, dims.h - d.horizonY,
                                   dx, dy + d.horizonY, dims.w, dims.h - d.horizonY);
                this._drawRoofWeather(ctx, d, dx, dy);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'front', d.horizonY);
            }
        }
        if (this.hovered === d.building) this.sprites.drawOutline(ctx, id, d.wx, d.wy);
    }

    _drawAnimatedOverlays(ctx, entry, wx, wy, building = null, splitPass = 'whole', horizonY = null) {
        if (entry.layers) {
            this._drawManifestLayers(ctx, entry, wx, wy, splitPass, horizonY, building);
        }
        if (building) {
            this._drawFunctionalOverlay(ctx, building, entry, wx, wy, splitPass, horizonY);
            this._drawAtmosphereBuildingReactions(ctx, building, entry, wx, wy, splitPass, horizonY);
            this._drawOccupancyPennant(ctx, building, entry, wx, wy, splitPass, horizonY);
            this._drawAttentionBannerBoard(ctx, building, entry, wx, wy, splitPass, horizonY);
        }
    }

    // W5.3 — the attention banner's walnut count board: the exact actionable
    // count, screen-fixed (zoom cancelled, whole pixels) under the tip of the
    // cloth the status part (`status.<bucket>`) hangs. Static: it moves only
    // when the drop steps, and is absent when no one needs action.
    _drawAttentionBannerBoard(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const state = this.attentionBanner;
        if (!state?.count) return;
        const banner = getBuildingAttentionBanner(building.type);
        if (!banner) return;
        const drop = banner.drops[Math.max(0, Math.min(banner.drops.length - 1, state.tier | 0))];
        const [lx, clothTop] = banner.at;
        const ly = clothTop + drop + (banner.boardGap ?? 2);
        if (
            splitPass !== 'whole'
            && Number.isFinite(horizonY)
            && (splitPass === 'back' ? ly >= horizonY : ly < horizonY)
        ) return;
        const baseAnchor = this.assets.getAnchor(entry.id);
        if (!baseAnchor) return;
        const zoom = this._zoom > 0 ? this._zoom : 1;
        const text = String(state.count);
        ctx.save();
        ctx.translate(Math.round(wx - baseAnchor[0] + lx), Math.round(wy - baseAnchor[1] + ly));
        ctx.scale(1 / zoom, 1 / zoom);
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        const width = Math.round(measureLabelText(ctx, text)) + PLAQUE_PAD * 2 + 2;
        const height = 15;
        const left = -Math.round(width / 2);
        paintWalnutBoard(ctx, left, 0, width, height, { nails: false, lit: false });
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = WALNUT.count;
        ctx.fillText(text, left + 1 + PLAQUE_PAD, 11);
        ctx.restore();
    }

    // #53 / 6.5 — occupancy pennant: hero buildings fly a small roofline
    // standard tinted by the dominant occupant repo (guild-territory read).
    // Idle buildings fly nothing; busy/full fly a second cloth under the
    // first; alert tints the cloth to the alert red. AMBIENT under the mark
    // governor. The cloth is the shared pixel pennant strip (PixelPennant),
    // stepped at 4 fps downwind; calm air and reduced motion hold frame 1.
    _drawOccupancyPennant(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const pennant = getBuildingPennantAnchor(building.type);
        if (!pennant) return;
        const [lx, ly] = pennant.at;
        if (
            splitPass !== 'whole'
            && Number.isFinite(horizonY)
            && (splitPass === 'back' ? ly >= horizonY : ly < horizonY)
        ) return;
        const occupancy = this._buildingOccupancyInfo(building);
        const dominant = this._visitorRepoByType.get(building.type);
        // Idle by count AND no semantic occupants routed here: fly nothing.
        if (occupancy.state === 'idle' && !dominant) return;

        const baseAnchor = this.assets.getAnchor(entry.id);
        const px = Math.round(wx - baseAnchor[0] + lx);
        const py = Math.round(wy - baseAnchor[1] + ly);
        const gate = getActiveMarkGovernor()?.admit(MarkTier.AMBIENT, px, py);
        if (gate && !gate.draw) return;
        const gateAlpha = gate?.alpha ?? 1;

        const profile = dominant?.profile || null;
        const alert = occupancy.state === 'alert';
        const accent = alert
            ? '#ff755d'
            : profile?.accent || getBuildingLabelAccent(building.type, '#d6a951');
        const shade = alert
            ? '#a83a2c'
            : profile
                ? `hsl(${Math.round(profile.hue)}, ${Math.round(profile.saturation)}%, ${Math.max(22, Math.round(profile.lightness) - 24)}%)`
                : null;
        const busy = occupancy.state === 'busy' || occupancy.state === 'full' || alert;
        const seed = hashText(`${building.type}|pennant`);
        const windX = pennantWind(this.atmosphereState?.weather);
        const tMs = this.frame * 16;
        const lightGrade = alert ? null : this._overlayLightGrade();
        const grade = lightGrade ? (tone) => gradeTone(tone, lightGrade) : null;
        ctx.save();
        ctx.globalAlpha = gateAlpha;
        const frame = pennantFrame(tMs, windX, { motion: this.motionScale > 0, phase: seed % 4 });
        drawPennant(ctx, px, py, { accent, shade, grade, frame, windX });
        if (busy) {
            drawPennant(ctx, px, py + 6, {
                accent,
                shade,
                grade,
                frame: pennantFrame(tMs, windX, { motion: this.motionScale > 0, phase: seed % 4 + 2 }),
                windX,
                withPole: false,
            });
        }
        ctx.restore();
    }

    _drawAtmosphereBuildingReactions(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const reactions = this.atmosphereState?.reactions || {};
        const windowWarmth = reactions.windowWarmth || 0;
        const roofGlint = reactions.roofGlintAlpha || 0;
        const warmGlint = reactions.warmGlint || 0;
        if (windowWarmth <= 0.035 && roofGlint <= 0.025) return;
        const baseAnchor = this.assets.getAnchor(entry.id);
        const dims = this.assets.getDims(entry.id);
        if (!dims) return;
        const localPoint = (lx, ly) => ({ x: Math.round(wx - baseAnchor[0] + lx), y: Math.round(wy - baseAnchor[1] + ly) });
        const shouldDrawLocalY = (localY) => (
            splitPass === 'whole'
            || !Number.isFinite(horizonY)
            || (splitPass === 'back' ? localY < horizonY : localY >= horizonY)
        );
        const seed = hashText(`${building.type}|${building.position?.tileX ?? 0}|${building.position?.tileY ?? 0}`);
        const pulse = this.motionScale ? (Math.sin(this.frame * 0.045 + seed * 0.011) + 1) / 2 : 0.56;

        ctx.save();
        this._clipToSplitPass(ctx, entry, wx, wy, splitPass, horizonY, dims, baseAnchor);
        ctx.globalCompositeOperation = 'screen';
        if (windowWarmth > 0.035) {
            // Dusk crossfades the work-tier warmth into the live night-shift
            // gate; at night only a physically present working agent (V8)
            // lights it.
            const occupancy = PRESENCE_TIER_TABLE[this._workTierFor(building)].occupancy;
            const lit = this._nightShiftLit(building.type);
            const nightGate = this._nightWindowGate();
            // 4.6 — at canonical rest the work buildings go dark and only the
            // safety architecture (Pharos, harbour lantern) keeps its warmth:
            // an empty village should read as between shifts, not as a lit
            // workplace with nobody in it.
            const restDark = this._villageAtRest() && !REST_SAFETY_LIGHT_TYPES.has(building.type);
            const buildingWarmth = restDark
                ? windowWarmth * 0.12
                : windowWarmth * lerp(0.45 + 0.55 * occupancy, lit, nightGate);
            // Window warmth breathes with the building beacon so lit windows
            // brighten together as night deepens (static floor under reduced motion).
            const beaconWarm = 0.82 + this._beaconScaleFor(building.type) * 0.4;
            const warmthAlpha = Math.min(0.3, buildingWarmth * (0.12 + pulse * 0.05) * beaconWarm);
            // 6.2 — buildings with calibrated windowRects get crisp lit windows
            // instead of the generic mid-wall warmth blobs. 4.2 — while the
            // selected building assigns a room per working occupant, the
            // aggregate warmth stands down entirely: two answers to "who is in
            // there" must never be lit at once. The doorstep spill below is a
            // door, not a room, so it stays. 0.8 / 6.3 — a building with an
            // authored emissive sidecar is lit by its art-shaped glass texels
            // instead, room by room (RoomGlass; the Canvas emitter cut,
            // `drawCanvasEmitterCuts`, as the scene pass does on WebGL): amber
            // panes with the muntins left dark, so no flat rect is stamped
            // over them here.
            const windowRects = getBuildingWindowRects(building.type);
            const sidecarLit = this.assets.getEntry?.(entry.id)?.emissiveSidecar === true;
            if (sidecarLit) {
                // the authored glass carries the window read, room by room
            } else if (windowRects) {
                this._drawWarmthWindows(
                    ctx,
                    windowRects,
                    localPoint,
                    shouldDrawLocalY,
                    warmthAlpha,
                    getBuildingWindowColor(building.type),
                );
            } else {
                // Pixel grammar: two stepped scanline courses (outer haze,
                // inner warm core) instead of a radial-gradient AA ellipse.
                const lightPoints = this._buildingReactionLightPoints(building, entry, dims);
                for (const point of lightPoints) {
                    if (!shouldDrawLocalY(point.y)) continue;
                    const p = localPoint(point.x, point.y);
                    const r = point.r || 18;
                    fillPixelEllipse(ctx, p.x, p.y, r, r * 0.48, `rgba(255, 162, 78, ${warmthAlpha * 0.34})`);
                    fillPixelEllipse(ctx, p.x, p.y, r * 0.58, r * 0.58 * 0.48, `rgba(255, 206, 116, ${warmthAlpha * 0.66})`);
                }
            }

            const doorSpill = getBuildingDoorSpillDescriptor(building.type, {
                occupancy: lerp(occupancy, lit, nightGate),
                beaconIntensity: this._beaconScaleFor(building.type),
                weatherWetness: this.atmosphereState?.weather?.precipitation || 0,
                atmosphereWarmth: windowWarmth,
            });
            if (doorSpill?.alpha > 0) {
                this._drawDoorSpill(ctx, doorSpill, localPoint, shouldDrawLocalY);
            }
        }

        if (roofGlint > 0.025) {
            // Golden hour lays a warm rim-light along the ridgeline; a wet roof
            // adds a brighter rain sheen. `warmGlint` (dawn/dusk) tilts the hue
            // from cool wet silver toward gold and lengthens the highlight.
            // Its orientation mirrors the canonical solar vector, matching
            // the opposite cast-shadow direction without another light model.
            const goldTilt = Math.min(1, warmGlint * 1.4);
            const rimColor = goldTilt > 0.2
                ? `rgba(255, 214, 138, ${Math.min(0.30, roofGlint * (0.5 + goldTilt * 0.4 + pulse * 0.24))})`
                : `rgba(255, 231, 166, ${Math.min(0.22, roofGlint * (0.48 + pulse * 0.34))})`;
            const count = roofGlint > 0.16 || goldTilt > 0.4 ? 2 : 1;
            const span = 7 + goldTilt * 6;
            const sunDir = this.lightingState?.sunDirIso;
            const hasSunDir = Number.isFinite(sunDir?.x) && Number.isFinite(sunDir?.y);
            const shadowAngle = shadowAngleForLighting(this.lightingState);
            const glintDx = hasSunDir ? -sunDir.x * span : Math.cos(shadowAngle) * span;
            const glintDy = hasSunDir ? sunDir.y * span : -Math.sin(shadowAngle) * span;
            // A one-texel stepped glint run (no AA stroke or round cap).
            ctx.fillStyle = rimColor;
            const thick = goldTilt > 0.4 ? 2 : 1;
            for (let i = 0; i < count; i++) {
                const lx = dims.w * (0.28 + ((seed >> (i * 5)) % 42) / 100);
                const ly = dims.h * (0.22 + ((seed >> (i * 7 + 3)) % 18) / 100);
                if (!shouldDrawLocalY(ly)) continue;
                const p = localPoint(lx, ly);
                pixelLine(ctx, p.x - glintDx, p.y - glintDy, p.x + glintDx, p.y + glintDy, thick);
            }
        }
        ctx.restore();
    }

    _buildingReactionLightPoints(building, entry, dims) {
        const points = [];
        const push = (at, radius = 18) => {
            if (!Array.isArray(at) || !Number.isFinite(Number(at[0])) || !Number.isFinite(Number(at[1]))) return;
            points.push({ x: Number(at[0]), y: Number(at[1]), r: radius });
        };
        if (building.type === 'watchtower') {
            push(WATCHTOWER_LANTERN_FIRE.light, 20);
            return points;
        }
        if (Array.isArray(entry?.lightSources)) {
            for (const source of entry.lightSources.slice(0, 3)) push(source.at, Math.min(28, Math.max(14, (source.radius || 42) * 0.28)));
        }
        if (entry?.lightSource) push(entry.lightSource, 20);
        if (entry?.emitters) {
            for (const at of Object.values(entry.emitters).slice(0, 3)) push(at, 16);
        }
        const fallback = BUILDING_LIGHT_FALLBACKS[building.type];
        if (fallback) push(fallback.at, 20);
        if (!points.length) {
            points.push({ x: dims.w * 0.48, y: dims.h * 0.58, r: 18 });
        }
        return points.slice(0, 4);
    }

    // 6.2 — crisp lit-window stamps for buildings with calibrated windowRects.
    // Each window is a stepped two-course pixel halo + a pixel-snapped warm
    // core (rect or scanline ellipse) + a hot center line, so the sprite reads
    // as *lit windows* at zoom 2/3 rather than a mid-wall blob. Caller already
    // set the 'screen' composite; alpha derives from the shared warmthAlpha math.
    _drawWarmthWindows(ctx, rects, localPoint, shouldDrawLocalY, warmthAlpha, color = null) {
        // Crisp cores punch much harder than the legacy blobs: the point is
        // windows that stay visibly lit through the night atmosphere multiply
        // (~50% at deep night), so the core carries an explicit night
        // compensation (the same beacon night factor the PRIMARY re-stamps
        // scale by). Only fires when windowWarmth is active (dusk/night), so
        // the strong core never shows in daylight; the occupancy factor in
        // warmthAlpha still keeps empty buildings dim.
        const night = clamp01(this.lightingState?.beaconIntensity
            ?? this.atmosphereState?.lighting?.beaconIntensity ?? 0);
        const coreAlpha = Math.min(0.85, warmthAlpha * 7 * (1 + night * 1.5));
        const glowAlpha = warmthAlpha * 1.6 * (1 + night);
        const coreRgb = color ? hexToRgb(color) : { r: 255, g: 205, b: 112 };
        const glowRgb = color ? coreRgb : { r: 255, g: 190, b: 96 };
        const hot = color ? {
            r: Math.round(lerp(coreRgb.r, 255, 0.58)),
            g: Math.round(lerp(coreRgb.g, 244, 0.58)),
            b: Math.round(lerp(coreRgb.b, 208, 0.58)),
        } : {
            r: 255,
            g: 236,
            b: 176,
        };
        const halo = `rgba(${glowRgb.r}, ${glowRgb.g}, ${glowRgb.b}, ${glowAlpha * 0.33})`;
        const coreFill = `rgba(${coreRgb.r}, ${coreRgb.g}, ${coreRgb.b}, ${coreAlpha})`;
        const hotFill = `rgba(${hot.r}, ${hot.g}, ${hot.b}, ${Math.min(0.8, coreAlpha * 1.35)})`;
        for (const rect of rects) {
            const [lx, ly] = rect.at || [];
            if (!Number.isFinite(lx) || !Number.isFinite(ly) || !shouldDrawLocalY(ly)) continue;
            const p = localPoint(lx, ly);
            const { left, top, w, h } = windowRectBounds(rect, p.x, p.y);
            // Stepped halo: the inner course overlaps the outer, so the window
            // falls off in two hard alpha steps instead of a gradient.
            fillPixelEllipse(ctx, p.x, p.y, w * 1.7, h * 1.5, halo);
            fillPixelEllipse(ctx, p.x, p.y, w * 1.15, h * 1.05, halo);

            if (rect.shape === 'ellipse') {
                fillPixelEllipse(ctx, p.x, p.y, w / 2, h / 2, coreFill);
            } else {
                ctx.fillStyle = coreFill;
                ctx.fillRect(left, top, w, h);
            }
            ctx.fillStyle = hotFill;
            ctx.fillRect(Math.round(p.x - 1), Math.round(p.y - h / 2 + 1), 2, Math.max(2, Math.round(h * 0.45)));
        }
    }

    _drawDoorSpill(ctx, descriptor, localPoint, shouldDrawLocalY) {
        const [lx, ly] = descriptor.at;
        const { r, g, b } = hexToRgb(descriptor.color);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${descriptor.alpha})`;
        for (const step of descriptor.steps) {
            const offsetX = Number(step.offset?.[0]) || 0;
            const offsetY = Number(step.offset?.[1]) || 0;
            const localY = ly + offsetY;
            if (!shouldDrawLocalY(localY)) continue;
            const p = localPoint(lx + offsetX, localY);
            ctx.fillRect(p.x, p.y, Math.max(1, step.w || 1), Math.max(1, step.h || 1));
        }
    }

    _clipToSplitPass(ctx, entry, wx, wy, splitPass = 'whole', horizonY = null, dims = null, baseAnchor = null) {
        if (splitPass === 'whole' || !Number.isFinite(horizonY)) return;
        const resolvedDims = dims || this.assets.getDims(entry.id);
        if (!resolvedDims) return;
        const anchor = baseAnchor || this.assets.getAnchor(entry.id);
        const dx = Math.round(wx - anchor[0]);
        const dy = Math.round(wy - anchor[1]);
        ctx.beginPath();
        if (splitPass === 'back') {
            ctx.rect(dx - 2, dy - 2, resolvedDims.w + 4, horizonY + 4);
        } else {
            ctx.rect(dx - 2, dy + horizonY - 2, resolvedDims.w + 4, resolvedDims.h - horizonY + 4);
        }
        ctx.clip();
    }

    // Every drawn manifest layer (static overlays such as the Pharos lamp and
    // the Portal's vortex, frame-strip parts, doors, emitter cycles)
    // comes from `partDrawsFor`, the descriptor list the GPU part records
    // read too, so both backends draw the same layers at the same depth.
    _drawManifestLayers(ctx, entry, wx, wy, splitPass = 'whole', horizonY = null, building = null) {
        const draws = this.partDrawsFor(entry, building, wx, wy, splitPass, horizonY, this._partDrawScratch);
        for (let index = 0; index < draws.length; index++) {
            const d = draws[index];
            ctx.drawImage(d.image, d.sx, d.sy, d.sw, d.sh, d.x, d.y, d.sw, d.sh);
        }
    }

    // 6.1 — the one motion clock (MotionClock elapsed ms; frozen under
    // reduced motion). Before IsometricRenderer hands the clock over, the
    // renderer's own virtual-frame count stands in.
    _partClockMs() {
        const elapsed = this.motionClock?.elapsedMs;
        return Number.isFinite(elapsed) ? elapsed : this.frame * 16;
    }

    // 6.1 / 6.2 — every manifest layer one building pass shows now, as blit
    // descriptors in world px shared by the Canvas pass and the GPU part
    // records, so both backends always pick the same frame.
    // A plain layer with art and an `anchor` (the Pharos lamp, the Portal's
    // vortex) is a static overlay, bottom-centre anchored in base-local
    // px; aperture and rest layers (4.1, 4.6) are drawn elsewhere.
    // A part is a manifest layer with `frames` (strip of `frames × frameW`,
    // bottom-centre `anchor` in base-local px). Its frame comes from
    // BuildingPartGates (the isWorkingVisitor truth); a `restIsBase` part at
    // frame 0 draws nothing, so an empty building is its base.png exactly. A
    // `dressing: true` layer (6.7) shows the static frame
    // `chronicleDressingFrame` returns, or nothing. A layer with `cycle`
    // is an emitter mask: while its gate is open the baked cycle phase is
    // blitted over the authored pixels (V4) — the base's, or with
    // `cycle.art` the named overlay layer's; banked, gated off or reduced
    // motion, nothing is drawn and the authored art shows.
    // Split halves take the rows on their side of the horizon, like the base.
    partDrawsFor(entry, building, wx, wy, splitPass = 'whole', horizonY = null, out = []) {
        out.length = 0;
        if (!entry?.layers) return out;
        const type = building?.type || '';
        const baseAnchor = this.assets.getAnchor(entry.id);
        if (!baseAnchor) return out;
        const originX = Math.round(wx - baseAnchor[0]);
        const originY = Math.round(wy - baseAnchor[1]);
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (!layer || name === 'base') continue;
            const id = `${entry.id}.${name}`;
            let image;
            let frame;
            let frameW;
            let frameH;
            let left;
            let top;
            let textureKey;
            if (layer.cycle) {
                if (!this._emitterCycleActive(type, layer.cycle)) continue;
                const cycle = this._emitterCycleFor(entry, name, layer);
                if (!cycle) continue;
                let artLeft = 0;
                let artTop = 0;
                if (layer.cycle.art) {
                    const art = entry.layers[layer.cycle.art];
                    const artImage = this.assets.get(`${entry.id}.${layer.cycle.art}`);
                    if (!artImage || !Array.isArray(art?.anchor)) continue;
                    artLeft = Math.round(art.anchor[0] - artImage.width / 2);
                    artTop = Math.round(art.anchor[1] - artImage.height);
                }
                image = cycle.canvas;
                frame = emitterCyclePhase(this._partClockMs(), cycle.frames, layer.cycle.hz || 8);
                frameW = cycle.frameW;
                frameH = cycle.frameH;
                left = artLeft + cycle.offsetX;
                top = artTop + cycle.offsetY;
                textureKey = `cycle:${id}:${cycle.version}`;
            } else if (layer.frames !== undefined) {
                if (layer.dressing === true) {
                    frame = this.chronicleDressingFrame?.(type, name, layer);
                    if (!Number.isInteger(frame)) continue;
                } else {
                    frame = this.partGates.frameFor(type, name, layer);
                    if (layer.restIsBase === true && frame === 0) continue;
                }
                image = this.assets.get(id);
                if (!image || !Array.isArray(layer.anchor)) continue;
                frameW = layer.frameW;
                frameH = layer.frameH;
                left = Math.round(layer.anchor[0] - frameW / 2);
                top = Math.round(layer.anchor[1] - frameH);
                textureKey = `part:${id}:${this.assets.assetVersion || ''}`;
            } else {
                if (isBuildingApertureLayer(type, name) || !Array.isArray(layer.anchor)) continue;
                image = this.assets.get(id);
                if (!image) continue;
                frame = 0;
                frameW = image.width;
                frameH = image.height;
                left = Math.round(layer.anchor[0] - frameW / 2);
                top = Math.round(layer.anchor[1] - frameH);
                textureKey = `layer:${id}:${this.assets.assetVersion || ''}`;
            }
            let sy = 0;
            let sh = frameH;
            if (splitPass !== 'whole' && Number.isFinite(horizonY)) {
                const cut = Math.max(0, Math.min(frameH, horizonY - top));
                if (splitPass === 'back') sh = cut;
                else {
                    sy = cut;
                    sh = frameH - cut;
                }
                if (sh <= 0) continue;
            }
            out.push({
                id,
                name,
                layer,
                image,
                textureKey,
                frame,
                sx: frame * frameW,
                sy,
                sw: frameW,
                sh,
                x: originX + left,
                y: originY + top + sy,
                localLeft: left,
                localTop: top,
                frameW,
                frameH,
                // GPU: the layer's material class (a cycle over an overlay
                // takes its art layer's), and `fixture: true` layers (the
                // Pharos lamp and lens) emit through no occupancy gate.
                materialClass: (layer.cycle?.art ? entry.layers[layer.cycle.art]?.materialClass : layer.materialClass) || null,
                fixture: layer.fixture === true,
            });
        }
        this._fixturePartDraws(entry, type, originX, originY, splitPass, horizonY, out);
        return out;
    }

    // W6.8 / W6.10 — procedural fixture parts in the same part records (both
    // backends read them): the Archive bell louvre, a clock fixture on
    // `clock.noon-bell` (BuildingPartGates; frames 1-2-1 once at noon, then
    // the bell hangs still at frame 0, also under reduced motion), and the
    // calendar's door wreaths (static). Neither is a work part: no gate here
    // reads occupancy, and neither emits light.
    _fixturePartDraws(entry, type, originX, originY, splitPass, horizonY, out) {
        if (typeof document === 'undefined') return;
        const parts = [];
        if (type === 'archive') parts.push(this._bellLouvrePart());
        for (const row of this.villageCalendar?.partStampsFor?.(type) || []) parts.push(this._wreathPart(row));
        for (const part of parts) {
            if (!part) continue;
            const frame = part.layer.gate ? this.partGates.frameFor(type, part.name, part.layer) : 0;
            let sy = 0;
            let sh = part.frameH;
            if (splitPass !== 'whole' && Number.isFinite(horizonY)) {
                const cut = Math.max(0, Math.min(part.frameH, horizonY - part.top));
                if (splitPass === 'back') sh = cut;
                else {
                    sy = cut;
                    sh = part.frameH - cut;
                }
                if (sh <= 0) continue;
            }
            out.push({
                id: `${entry.id}.${part.name}`,
                name: part.name,
                layer: part.layer,
                image: part.image,
                textureKey: part.textureKey,
                frame,
                sx: frame * part.frameW,
                sy,
                sw: part.frameW,
                sh,
                x: originX + part.left,
                y: originY + part.top + sy,
                localLeft: part.left,
                localTop: part.top,
                frameW: part.frameW,
                frameH: part.frameH,
                materialClass: part.layer.materialClass,
                fixture: false,
            });
        }
    }

    _procPart(key, build) {
        const cache = (this._procParts ||= new Map());
        if (!cache.has(key)) cache.set(key, build());
        return cache.get(key);
    }

    // The bell in each of the Archive tower's two louvre openings (base
    // texels: dark interiors x 52-56 and 72-76 below the sky-lit arch heads,
    // centred on x 54 / 74, from y 64). Each hangs centred from a headstock
    // beam (which also closes the base art's see-through texels at y 64-65):
    // a 3-texel waist over a 5-texel flared lip and a clapper. Frame 0 hangs
    // plumb; frames 1 and 2 swing the flare and lip one texel west / east
    // about the headstock while the clapper hangs plumb, so the mouth reads
    // as swinging past it.
    _bellLouvrePart() {
        return this._procPart('archive.bellLouvre', () => {
            const frameW = 27;
            const frameH = 6;
            const canvas = document.createElement('canvas');
            canvas.width = frameW * 3;
            canvas.height = frameH;
            const ctx = canvas.getContext('2d');
            const [beam, dark, shade, mid, light] = ['#2e1f12', '#5a3a1a', '#87591f', '#a8732a', '#e0b05a'];
            const put = (color, x, y, w = 1) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, 1); };
            for (let f = 0; f < 3; f++) {
                const tilt = f === 1 ? -1 : f === 2 ? 1 : 0;
                for (const centre of [3, 23]) {
                    const cx = f * frameW + centre;
                    put(beam, cx - 1, 0, 3);
                    for (const y of [1, 2]) {
                        put(mid, cx - 1, y, 3);
                        put(light, cx - 1, y);
                        put(shade, cx + 1, y);
                    }
                    put(mid, cx - 2 + tilt, 3, 5);
                    put(light, cx - 1 + tilt, 3);
                    put(dark, cx + 2 + tilt, 3);
                    put(dark, cx - 2 + tilt, 4, 5);
                    put(dark, cx, 5);
                }
            }
            return {
                name: 'bellLouvre',
                image: canvas,
                textureKey: 'proc:building.archive.bellLouvre:2',
                frameW,
                frameH,
                left: 51,
                top: 64,
                layer: Object.freeze({ frames: 3, staticFrame: 0, gate: 'clock.noon-bell', sequence: Object.freeze([1, 2, 1]), stepMs: 320, materialClass: 'metal' }),
            };
        });
    }

    _wreathPart(row) {
        return this._procPart(`wreath:${row.id}`, () => {
            const canvas = document.createElement('canvas');
            canvas.width = 7;
            canvas.height = 9;
            paintWreath(canvas.getContext('2d'), 3, 3);
            return {
                name: `wreath.${row.id}`,
                image: canvas,
                textureKey: `proc:wreath:${row.id}:1`,
                frameW: 7,
                frameH: 9,
                left: row.at[0] - 3,
                top: row.at[1] - 3,
                layer: Object.freeze({ frames: 1, materialClass: 'timber' }),
            };
        });
    }

    // W6.8 — the live day-part beats on the atmosphere clock, for the
    // `clock.<beat>` fixture gates (never agent state).
    _clockBeatSet() {
        const minute = Number(this.atmosphereState?.clock?.minuteOfDay);
        const beats = Number.isFinite(minute) ? dayPartBeatsAt(minute) : [];
        const key = beats.join(',');
        if (key !== this._clockBeatKey || !this._clockBeats) {
            this._clockBeatKey = key;
            this._clockBeats = new Set(beats);
        }
        return this._clockBeats;
    }

    // V4 — a work-coupled cycle runs only while its gate reads real work; the
    // Forge also needs heat above the banked ember and a hearth that is not
    // banked (the banked mask is the rest art). `lamps` cycles (the Pharos
    // lens and the Command braziers, fixtures) run only while the village
    // lamps are lit and never read agent state. Reduced motion: the
    // authored frame.
    _emitterCycleActive(type, cycle) {
        if (!(this.motionScale > 0)) return false;
        const gate = cycle?.gate;
        if (gate === 'lamps') return lampsLitAt(this.atmosphereState);
        if (!this.partGates.isOpen(gate)) return false;
        if (type === 'forge') {
            return this._forgeGlow > FORGE_BANKED_GLOW
                && !this._villageAtRest()
                && !this._forgeWorkload?.banked;
        }
        return true;
    }

    // The baked cycle strip of one mask layer (EmitterCycle, once per asset
    // version): { canvas, frames, frameW, frameH, offsetX, offsetY, version }.
    // The art is base.png, or the overlay layer `cycle.art` names.
    _emitterCycleFor(entry, name, layer) {
        const id = `${entry.id}.${name}`;
        const version = this.assets.assetVersion || '';
        const cached = this._cycleCache.get(id);
        if (cached && cached.version === version) return cached.cycle;
        const base = this.assets.get(layer.cycle?.art ? `${entry.id}.${layer.cycle.art}` : entry.id);
        const mask = this.assets.get(id);
        if (!base || !mask || typeof document === 'undefined') return null;
        const pixels = (img) => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(img, 0, 0);
            return context.getImageData(0, 0, img.width, img.height);
        };
        const baked = bakeEmitterCycle(pixels(base), pixels(mask), layer.cycle);
        let cycle = null;
        if (baked) {
            const canvas = document.createElement('canvas');
            canvas.width = baked.width;
            canvas.height = baked.height;
            canvas.getContext('2d').putImageData(new ImageData(baked.data, baked.width, baked.height), 0, 0);
            cycle = { ...baked, data: null, canvas, version };
        }
        this._cycleCache.set(id, { version, cycle });
        return cycle;
    }

    // GPU — channel strips shaped like a part's strip, so the part record
    // samples the same material, emissive and occluder texels the base record
    // has under it: each frame is the base sidecar crop at the part rect. A
    // door frame's warm floor (texels on the C1 emissive ramp that differ
    // from the closed frame) takes its own colour as emission, so an open,
    // working hall glows through the occupancy gate at night. An overlay that
    // declares `authored-albedo` emission (the Pharos lamp, the Portal's rune
    // brazier), or a cycle over one, emits its own colours at that strength.
    partChannelsFor(entry, draw) {
        const key = `${draw.textureKey}`;
        const cached = this._partChannelCache.get(key);
        if (cached) return cached;
        if (typeof document === 'undefined') return null;
        const frames = Math.max(1, Math.round(draw.image.width / draw.frameW));
        const out = { material: null, emissive: null, occluder: null, key };
        // An added object (not restIsBase, not a cycle over the base) owns no
        // base texels: it takes its layer's material class (the record's) and
        // emits only what its manifest `emissive` declares.
        const overBase = draw.layer?.restIsBase === true || Boolean(draw.layer?.cycle && !draw.layer.cycle.art);
        let complete = true;
        for (const channel of overBase ? ['material', 'emissive', 'occluder'] : []) {
            const sidecar = this.assets.getCompanion?.(entry.id, channel);
            if (!sidecar) {
                if (entry[`${channel}Sidecar`] === true) complete = false;
                continue;
            }
            const canvas = document.createElement('canvas');
            canvas.width = draw.frameW * frames;
            canvas.height = draw.frameH;
            const context = canvas.getContext('2d', { willReadFrequently: channel === 'emissive' });
            for (let f = 0; f < frames; f++) {
                context.drawImage(sidecar, draw.localLeft, draw.localTop, draw.frameW, draw.frameH,
                    f * draw.frameW, 0, draw.frameW, draw.frameH);
            }
            out[channel] = canvas;
        }
        const emission = overBase ? 0 : this._albedoEmission(entry, draw.layer);
        if (emission > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = draw.image.width;
            canvas.height = draw.image.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(draw.image, 0, 0);
            const px = context.getImageData(0, 0, canvas.width, canvas.height);
            const alpha = Math.round(Math.min(1, emission) * 128);
            for (let i = 3; i < px.data.length; i += 4) {
                if (px.data[i] > 0) px.data[i] = alpha;
            }
            context.putImageData(px, 0, 0);
            out.emissive = canvas;
        }
        if (draw.layer?.oneShot && frames > 1) {
            const albedo = document.createElement('canvas');
            albedo.width = draw.image.width;
            albedo.height = draw.image.height;
            const actx = albedo.getContext('2d', { willReadFrequently: true });
            actx.drawImage(draw.image, 0, 0);
            const px = actx.getImageData(0, 0, albedo.width, albedo.height);
            if (!out.emissive) {
                out.emissive = document.createElement('canvas');
                out.emissive.width = albedo.width;
                out.emissive.height = albedo.height;
            }
            const ectx = out.emissive.getContext('2d', { willReadFrequently: true });
            const em = ectx.getImageData(0, 0, albedo.width, albedo.height);
            const floor = new Set(ART_RAMPS.emissive.map((hex) => hex.toLowerCase()));
            const hexAt = (i) => `#${[px.data[i], px.data[i + 1], px.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
            for (let y = 0; y < draw.frameH; y++) {
                for (let x = draw.frameW; x < albedo.width; x++) {
                    const i = (y * albedo.width + x) * 4;
                    const i0 = (y * albedo.width + (x % draw.frameW)) * 4;
                    const same = px.data[i] === px.data[i0] && px.data[i + 1] === px.data[i0 + 1] && px.data[i + 2] === px.data[i0 + 2];
                    if (same || !floor.has(hexAt(i))) continue;
                    em.data[i] = px.data[i];
                    em.data[i + 1] = px.data[i + 1];
                    em.data[i + 2] = px.data[i + 2];
                    em.data[i + 3] = 128;
                }
            }
            ectx.putImageData(em, 0, 0);
        }
        if (complete) this._partChannelCache.set(key, out);
        return out;
    }

    // The `authored-albedo` emission strength a layer's manifest declares
    // (a cycle over an overlay reads its art layer's), 0 when none.
    _albedoEmission(entry, layer) {
        const source = layer?.cycle?.art ? entry?.layers?.[layer.cycle.art] : layer;
        let strength = 0;
        for (const item of source?.emissive?.sources || []) {
            if (item?.geometry === 'authored-albedo') strength = Math.max(strength, Number(item.strength) || 0);
        }
        const scale = Number(source?.emissive?.strength);
        return strength * (Number.isFinite(scale) ? scale : 1);
    }

    _drawFunctionalOverlay(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        const localPoint = (lx, ly) => ({ x: Math.round(wx - baseAnchor[0] + lx), y: Math.round(wy - baseAnchor[1] + ly) });
        const shouldDrawLocalY = (localY) => (
            splitPass === 'whole'
            || !Number.isFinite(horizonY)
            || (splitPass === 'back' ? localY < horizonY : localY >= horizonY)
        );
        // 4.1 — the aperture spans the occlusion horizon (a wall cut is not a
        // roof and not a foreground prop), so it is drawn after the split clip
        // is released, once, on the front pass only.
        let openAperture = null;
        // The descending mirror shaft reaches past the tower box; draw once
        // after its split clip is released. Its rear arc is suppressed.
        let lanternBeacon = null;

        ctx.save();
        this._clipToSplitPass(ctx, entry, wx, wy, splitPass, horizonY, null, baseAnchor);
        // 4.2 / 6.3 — the selected building's exact room counts at night. The
        // rooms themselves light as art-shaped glass on every building
        // (RoomGlass), selected or not.
        const rooms = this._roomInstrumentFor(building);
        if (rooms && !this._openApertureFor(building)) this._drawRoomCount(ctx, localPoint, shouldDrawLocalY, rooms);
        if (building.type === 'observatory') {
            this._assertObservatoryClockDims(entry);
            // #52 — the dome dormer aperture sits above the clock on the roof;
            // drawn whenever its slice of the sprite is in this pass.
            if (shouldDrawLocalY(OBSERVATORY_APERTURE.slit[1])) {
                this._drawObservatoryAperture(ctx, localPoint);
            }
            if (shouldDrawLocalY(OBSERVATORY_CLOCK_FACE.center[1])) {
                this._drawObservatoryClock(ctx, localPoint);
                this._drawObservatoryRitual(ctx, localPoint, building);
            }
            ctx.restore();
            return;
        }
        if (building.type === 'forge') {
            // 4.6 — at canonical rest the hearth is banked: the authored orange
            // mouth is masked back to a stepped ember and the work marks,
            // molten spill and heat bloom stand down. Any other phase keeps the
            // shipped treatment. 4.4 — a Forge we have watched fall quiet for
            // ten minutes banks the same way: the mask is the same, the reason
            // is a measured idle rather than a canonical empty village.
            const forgeSelected = this._selectedBuildingType === 'forge';
            if (this._villageAtRest() || this._forgeWorkload?.banked) {
                this._drawForgeBankedMouth(ctx, entry, wx, wy);
            } else {
                if (shouldDrawLocalY(getBuildingEffectAnchor('forge', 'hearth', [75, 118])[1])) this._drawForgeEnhancement(ctx, localPoint, building);
            }
            // The workload billets and the result shelf are physical objects in
            // the yard: they stay after the heat fades and through rest.
            if (splitPass !== 'back') {
                this._drawForgeWorkload(ctx, localPoint, forgeSelected);
                this._drawForgeResultShelf(ctx, localPoint, forgeSelected);
            }
        } else if (building.type === 'mine') {
            // 4.5 — art-coupled points come from the registry; the fallbacks
            // are the pre-4.5 sprite's literals.
            const [mouthX, mouthY] = getBuildingEffectAnchor('mine', 'mouth', [128, 158]);
            if (!shouldDrawLocalY(mouthY)) {
                ctx.restore();
                return;
            }
            const mouth = localPoint(mouthX, mouthY);
            const rail = this._mineRailSpan(localPoint);
            const mineRitual = this._latestRitual('mine');
            // The cave mouth's ore light is the pool path's (the Mine ritual
            // sources) and the reserve pile below; no screen disc on the face.
            // 6.5 — cart rails redrawn sprite-quality: wooden sleepers under
            // two steel rails with a pale top edge, following the yard path
            // away from the cave mouth. Static decoration (no motion claim).
            // 4.5 — art that bakes its own track sets `railsBaked`.
            if (!getBuildingEffectAnchor('mine', 'railsBaked', false)) {
                ctx.globalAlpha = 0.85;
                const { railA, railB, railLen, ux, uy, nx, ny } = rail;
                ctx.strokeStyle = '#4a3524';
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (let d = 2; d < railLen - 2; d += 7) {
                    const sx = railA.x + ux * d;
                    const sy = railA.y + uy * d;
                    ctx.moveTo(sx - nx * 5, sy - ny * 5);
                    ctx.lineTo(sx + nx * 5, sy + ny * 5);
                }
                ctx.stroke();
                for (const offset of [-2.6, 2.6]) {
                    ctx.strokeStyle = '#3a3230';
                    ctx.lineWidth = 1.4;
                    ctx.beginPath();
                    ctx.moveTo(railA.x + nx * offset, railA.y + ny * offset);
                    ctx.lineTo(railB.x + nx * offset, railB.y + ny * offset);
                    ctx.stroke();
                    ctx.strokeStyle = '#7a6a55';
                    ctx.lineWidth = 0.7;
                    ctx.beginPath();
                    ctx.moveTo(railA.x + nx * offset, railA.y + ny * offset - 0.7);
                    ctx.lineTo(railB.x + nx * offset, railB.y + ny * offset - 0.7);
                    ctx.stroke();
                }
            }
            this._drawMineRitual(ctx, mouth, rail, mineRitual);
            this._drawMineReserve(ctx, localPoint(...getBuildingEffectAnchor('mine', 'reserve', [128, 158])));
            // #33 — reduced-motion fallback: a single static dust wisp at the
            // cave mouth, standing in for the live dust plume.
            if (!this.motionScale) {
                this._drawStaticSmokeWisp(ctx, mouth, { dust: true });
            }
            // 4.3 — the assay bench opens on explicit Mine selection only; the
            // default frame keeps the yard as it ships.
            if (this._selectedBuildingType === 'mine') {
                this._drawMineAssayBench(ctx, localPoint);
            }
        } else if (building.type === 'portal') {
            // The status rings orbit the vortex's heart in the air (registry
            // `vortex`), each inside the vortex's own width; the ritual rings,
            // curve and plaque stand on the threshold in front of it on the
            // dais floor (registry `gate`). Each draws in the split pass that
            // holds its row.
            const [vortexX, vortexY] = getBuildingEffectAnchor('portal', 'vortex', [156, 128]);
            const [gateX, gateY] = getBuildingEffectAnchor('portal', 'gate', [150, 186]);
            const portalRitual = this._latestRitual('portal');
            if (shouldDrawLocalY(vortexY)) {
                const heart = localPoint(vortexX, vortexY);
                const working = this._workingVisitorCountFor(building);
                // Three rings of snapped dots on 2:1 ellipses, stepping round
                // one dot slot on the slow band (held under reduced motion). A
                // working visitor (V8) turns the inner ring violet; the plaque
                // carries the exact count.
                const tick = this.motionScale ? Math.floor(this.frame * 0.05) : 0;
                const grow = portalRitual ? 2 : 0;
                for (let i = 0; i < 3; i++) {
                    const count = 10 + i * 2;
                    ringDots(ctx, heart.x, heart.y, 14 + i * 7 + grow, {
                        count,
                        dot: 1,
                        color: i === 0 && working > 0 ? '#bda7ff' : '#8feaff',
                        phase: ((tick + i) % count) * (Math.PI * 2 / count) * (i % 2 ? -1 : 1),
                    });
                }
            }
            if (shouldDrawLocalY(gateY)) this._drawPortalRitual(ctx, localPoint(gateX, gateY), portalRitual);
        } else if (building.type === 'watchtower') {
            // Warm halo and one descending shaft, ungraded on the shared
            // overlay; sea glints use lighthouseBeam in the water backends.
            if (this._ungradedOverlay && shouldDrawLocalY(WATCHTOWER_LANTERN_FIRE.flame[1])) {
                lanternBeacon = localPoint(...WATCHTOWER_LANTERN_FIRE.flame);
            }
        } else if (building.type === 'harbor') {
            // Harbor effects span the roofline and foreground quay. Draw in both
            // split passes and let the active occlusion clip partition them.
            this._drawHarborMasterOffice(ctx, localPoint, building);
            // #33 — reduced-motion fallback: a single static chimney wisp in
            // place of the live steam/smoke column.
            if (!this.motionScale) {
                this._drawStaticSmokeWisp(ctx, localPoint(127, 29), { heat: 0.2 });
            }
        } else if (building.type === 'archive') {
            if (splitPass !== 'back') this._drawArchiveEnhancement(ctx, localPoint);
        } else if (building.type === 'taskboard') {
            if (splitPass !== 'front') {
                if (this._villageAtRest()) this._drawTaskboardEmptyRack(ctx, localPoint);
                else if (!this._drawTaskboardBoard(ctx, localPoint)) {
                    this._drawTaskboardRitual(ctx, localPoint, building);
                }
                // 4.7 — the frame tabs name every other concurrent plan owner,
                // so a hidden plan is one click away instead of invisible.
                if (!this._villageAtRest()) this._drawTaskboardPlanTabs(ctx, localPoint);
            }
        } else if (building.type === 'command') {
            if (splitPass !== 'back') {
                // 4.1 — the sectional view replaces the wing's front wall while
                // Command is the selected building. 6.3 — the hall's panes light
                // room by room as authored glass (RoomGlass), so no pane is
                // stamped here.
                openAperture = this._openApertureFor(building);
                this._drawCommandRitual(ctx, localPoint, building);
            }
        }
        ctx.restore();
        if (openAperture) this._drawInspectionAperture(ctx, building, entry, wx, wy, openAperture);
        if (lanternBeacon) this._drawWatchtowerFire(ctx, lanternBeacon);
    }

    _ritualsFor(type) {
        return this.ritualConductor?.getActiveRitualsForBuilding?.(type) || [];
    }

    _latestRitual(type, predicate = null) {
        const rituals = this._ritualsFor(type)
            .filter((ritual) => !predicate || predicate(ritual))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return rituals[0] || null;
    }

    _ritualProgress(ritual) {
        if (!ritual) return 0;
        return clamp01((ritual.elapsedMs || 0) / Math.max(1, ritual.durationMs || 1));
    }

    _ritualFade(ritual) {
        if (!ritual) return 0;
        const duration = Math.max(1, ritual.durationMs || 1);
        const age = Math.max(0, ritual.elapsedMs || 0);
        const inAlpha = ritual.motionEnabled === false ? 1 : Math.min(1, age / 180);
        const outAlpha = Math.min(1, Math.max(0, (duration - age) / 420));
        return clamp01(inAlpha * outAlpha);
    }

    _updateForgeGlow(dt = 16) {
        const rituals = this._ritualsFor('forge');
        // 4.6 — a confirmed-empty village banks the hearth below its ordinary
        // idle baseline. Every downstream reader (light sources, emitter
        // density, smoke warmth) sees the banked value, so the whole forge
        // cools together instead of one cue going quiet.
        const floor = this._villageAtRest() ? FORGE_BANKED_GLOW : FORGE_GLOW_BASELINE;
        let target = floor;
        for (const ritual of rituals) {
            const fade = this._ritualFade(ritual);
            if (fade <= 0.03) continue;
            target = Math.max(target, 0.62 + fade * 0.34);
        }

        if (target > this._forgeGlow) {
            this._forgeGlow = target;
            return;
        }

        const decay = (Math.max(0, Number(dt) || 0) / 1000) * FORGE_GLOW_DECAY_PER_SECOND;
        this._forgeGlow = Math.max(floor, this._forgeGlow - decay);
    }

    _syncTaskboardPapers(now) {
        const rituals = this._ritualsFor('taskboard')
            .slice()
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        for (const ritual of rituals) {
            if (!ritual?.id || this._seenTaskboardRituals.has(ritual.id)) continue;
            this._seenTaskboardRituals.add(ritual.id);
            if (ritual.action === 'complete') {
                this._completeTaskboardPaper(ritual, now);
            } else {
                this._pinTaskboardPaper(ritual, now);
            }
        }
        if (this._seenTaskboardRituals.size > 240) {
            this._seenTaskboardRituals = new Set([...this._seenTaskboardRituals].slice(-160));
        }
        this._capTaskboardPapers();
    }

    _taskboardPaperKey(ritual) {
        if (ritual.taskKey) return `${ritual.agentId || 'unknown'}|task:${ritual.taskKey}`;
        let input = '';
        if (typeof ritual.input === 'string') {
            input = ritual.input;
        } else {
            try {
                input = JSON.stringify(ritual.input || '');
            } catch {
                input = String(ritual.input || '');
            }
        }
        const label = String(ritual.tool || ritual.label || 'TASK').toUpperCase();
        const source = input || ritual.tool || label;
        return `${ritual.agentId || 'unknown'}|${label}|${hashText(source)}`;
    }

    _pinTaskboardPaper(ritual, now) {
        const matchKey = this._taskboardPaperKey(ritual);
        const existing = this._taskboardPapers.find(paper => paper.matchKey === matchKey);
        if (existing) {
            existing.status = 'pinned';
            existing.label = paperLabel(ritual, 'TASK');
            existing.taskKey = ritual.taskKey || existing.taskKey || null;
            existing.updatedAt = now;
            existing.completedAt = 0;
            return;
        }

        this._taskboardPapers.push({
            id: `paper:${matchKey}:${ritual.createdAt || now}`,
            matchKey,
            taskKey: ritual.taskKey || null,
            agentId: ritual.agentId || '',
            label: paperLabel(ritual, 'TASK'),
            status: 'pinned',
            createdAt: now,
            updatedAt: now,
            completedAt: 0,
            slotSeed: hashText(`${matchKey}:${this._taskboardPapers.length}`),
        });
    }

    _completeTaskboardPaper(ritual, now) {
        const matchKey = this._taskboardPaperKey(ritual);
        const exact = this._taskboardPapers.find(paper => paper.matchKey === matchKey && paper.status !== 'completed');
        const sameAgent = this._taskboardPapers
            .filter(paper => paper.agentId === ritual.agentId && paper.status !== 'completed')
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        const oldestOpen = this._taskboardPapers
            .filter(paper => paper.status !== 'completed')
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        const paper = exact || sameAgent || oldestOpen;

        if (paper) {
            paper.status = 'completed';
            paper.completedAt = now;
            paper.updatedAt = now;
            paper.label = paperLabel(ritual, paper.label);
            return;
        }

        this._taskboardPapers.push({
            id: `paper:${matchKey}:${ritual.createdAt || now}`,
            matchKey,
            taskKey: ritual.taskKey || null,
            agentId: ritual.agentId || '',
            label: paperLabel(ritual, 'DONE'),
            status: 'completed',
            createdAt: now,
            updatedAt: now,
            completedAt: now,
            slotSeed: hashText(`${matchKey}:complete`),
        });
    }

    _capTaskboardPapers() {
        while (this._taskboardPapers.length > MAX_TASKBOARD_PAPERS) {
            const completed = this._taskboardPapers
                .filter(paper => paper.status === 'completed')
                .sort((a, b) => a.completedAt - b.completedAt)[0];
            const oldest = completed || this._taskboardPapers
                .slice()
                .sort((a, b) => a.createdAt - b.createdAt)[0];
            this._taskboardPapers = this._taskboardPapers.filter(paper => paper !== oldest);
        }
    }

    _ritualLightSources(lightBoost = 1) {
        const sources = [];
        for (const building of this.buildings) {
            const rituals = this._ritualsFor(building.type);
            if (!rituals.length) continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            const toOrigin = ([lx, ly]) => ({
                x: center.x - baseAnchor[0] + lx,
                y: center.y - baseAnchor[1] + ly,
            });
            for (const ritual of rituals) {
                const fade = this._ritualFade(ritual);
                if (fade <= 0.03) continue;
                if (building.type === 'forge') {
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:spark`,
                        kind: 'spark',
                        origin: toOrigin(getBuildingEffectAnchor('forge', 'anvil', [195, 150])),
                        color: '#ffcf6a',
                        radius: 24 + this._ritualProgress(ritual) * 34,
                        alpha: fade * 0.5 * lightBoost,
                        overlay: 'atmosphere.light.fire-glow',
                        buildingType: building.type,
                        building,
                    }));
                } else if (building.type === 'mine') {
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:ore`,
                        kind: 'spark',
                        origin: toOrigin(getBuildingEffectAnchor('mine', 'mouth', [128, 158])),
                        color: ritual.cargo
                            ? mixHex(this._mineSeamColor(), '#9fd8f0', this._mineCargoMix(ritual.cargo).bucket)
                            : this._mineSeamColor(),
                        radius: 44 + fade * 24,
                        alpha: fade * 0.3 * lightBoost,
                        overlay: 'atmosphere.light.lantern-glow',
                        buildingType: building.type,
                        building,
                    }));
                } else if (building.type === 'portal') {
                    const color = ritual.action === 'dismiss'
                        ? '#f08a8a'
                        : ritual.action === 'familiar-wait'
                            ? '#f2d36b'
                            : ritual.action === 'familiar-return'
                                ? '#bda7ff'
                                : '#8feaff';
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:portal`,
                        kind: 'orbit',
                        origin: toOrigin(getBuildingEffectAnchor('portal', 'vortex', [156, 128])),
                        color,
                        radius: 58,
                        alpha: fade * 0.26 * lightBoost,
                        overlay: 'atmosphere.light.lantern-glow',
                        buildingType: building.type,
                        building,
                    }));
                }
            }
        }
        return sources;
    }

    _assertObservatoryClockDims(entry) {
        // Warn once per session if the observatory sprite drifts away from the
        // composite size that OBSERVATORY_CLOCK_FACE.center / .radius were
        // calibrated against. Silent drift would misplace the clock hands.
        if (this._observatoryDimsChecked) return;
        this._observatoryDimsChecked = true;
        const dims = entry?.id ? this.assets?.getDims?.(entry.id) : null;
        if (!dims) return;
        const ref = OBSERVATORY_CLOCK_FACE.compositeRef;
        if (dims.w !== ref.w || dims.h !== ref.h) {
            console.warn(
                `[BuildingSprite] observatory sprite is ${dims.w}x${dims.h}; clock-face calibration assumes ${ref.w}x${ref.h}. Hand placement may be off — recalibrate OBSERVATORY_CLOCK_FACE.center / .radius.`
            );
        }
    }

    _drawObservatoryClock(ctx, localPoint) {
        const config = OBSERVATORY_CLOCK_FACE;
        const [cx, cy] = config.center;
        const face = localPoint(cx, cy);
        const time = this._clockTime();
        const hourAngle = (((time.hour % 12) + time.minute / 60) / 12) * Math.PI * 2 - Math.PI / 2;
        const minuteAngle = (time.minute / 60) * Math.PI * 2 - Math.PI / 2;
        // Independent web-ritual spin layered on top of the time-of-day hands.
        // 3.8 (PT-6) — the spin is stepped, never a runtime rotate: it snaps
        // to one of 16 baked frames (22.5° apart) in which the hands and the
        // four tick marks are re-rasterized on the pixel grid. Reduced motion
        // holds frame 0.
        const spin = this.motionScale ? (this._observatoryClockSpin || 0) : 0;
        const spinStep = Math.round(spin / (Math.PI * 2) * OBSERVATORY_SPIN_FRAMES) % OBSERVATORY_SPIN_FRAMES;
        const spinAngle = spinStep * (Math.PI * 2) / OBSERVATORY_SPIN_FRAMES;
        const source = this._clockSourceCanvas(
            config,
            hourAngle + spinAngle,
            minuteAngle + spinAngle,
            `${time.hour}:${time.minute}:${spinStep}`,
            spinAngle,
        );
        const size = config.radius * 2;
        const left = Math.round(face.x - size / 2);
        const top = Math.round(face.y - size / 2);
        const previousSmoothing = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, left, top, size, size);
        ctx.imageSmoothingEnabled = previousSmoothing;
    }

    _clockSourceCanvas(config, hourAngle, minuteAngle, cacheKey, spinAngle = 0) {
        if (!this._clockCanvas) {
            this._clockCanvas = document.createElement('canvas');
        }
        const canvas = this._clockCanvas;
        if (canvas.width !== config.sourceSize || canvas.height !== config.sourceSize) {
            canvas.width = config.sourceSize;
            canvas.height = config.sourceSize;
            this._clockCanvasKey = '';
        }
        if (this._clockCanvasKey === cacheKey) return canvas;

        const ctx = canvas.getContext('2d');
        const c = config.sourceCenter;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;

        ctx.fillStyle = 'rgba(19, 21, 30, 0.56)';
        this._fillPixelCircle(ctx, c, c, config.sourceRadius);
        ctx.fillStyle = 'rgba(229, 218, 170, 0.72)';
        this._strokePixelCircle(ctx, c, c, config.sourceRadius);
        ctx.fillStyle = 'rgba(255, 241, 190, 0.88)';
        // The four tick marks sit on the rim, turned with the ritual spin.
        const tickRadius = config.sourceRadius - 1;
        for (let quarter = 0; quarter < 4; quarter++) {
            const angle = spinAngle + quarter * Math.PI / 2;
            const tx = Math.round(c + Math.cos(angle) * tickRadius);
            const ty = Math.round(c + Math.sin(angle) * tickRadius);
            ctx.fillRect(tx - 1, ty - 1, 2, 2);
        }

        this._drawClockHand(ctx, c, c, hourAngle, config.hourHandLength, 3, '#1a1712');
        this._drawClockHand(ctx, c, c, minuteAngle, config.minuteHandLength, 2, '#f7de91');
        ctx.fillStyle = '#21170f';
        ctx.fillRect(c - 1, c - 1, 3, 3);
        ctx.fillStyle = '#ffe6a0';
        ctx.fillRect(c, c, 1, 1);

        this._clockCanvasKey = cacheKey;
        return canvas;
    }

    _clockTime() {
        const hour = Number(this.clockState?.hours);
        const minute = Number(this.clockState?.minutes);
        if (Number.isFinite(hour) && Number.isFinite(minute)) {
            return { hour, minute };
        }
        const now = new Date();
        return { hour: now.getHours(), minute: now.getMinutes() };
    }

    _drawClockHand(ctx, cx, cy, angle, length, width, color) {
        const x1 = Math.round(cx + Math.cos(angle) * length);
        const y1 = Math.round(cy + Math.sin(angle) * length);
        this._drawBlockLine(ctx, cx, cy, x1, y1, width, color);
    }

    _drawBlockLine(ctx, x0, y0, x1, y1, width, color) {
        let dx = Math.abs(x1 - x0);
        let dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        const half = Math.floor(width / 2);

        ctx.fillStyle = color;
        while (true) {
            ctx.fillRect(x0 - half, y0 - half, width, width);
            if (x0 === x1 && y0 === y1) break;
            const e2 = err * 2;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }
    }

    _fillPixelCircle(ctx, cx, cy, radius) {
        for (let y = -radius; y <= radius; y++) {
            const halfWidth = Math.floor(Math.sqrt(radius * radius - y * y));
            ctx.fillRect(cx - halfWidth, cy + y, halfWidth * 2 + 1, 1);
        }
    }

    _strokePixelCircle(ctx, cx, cy, radius) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) {
            const x = Math.round(cx + Math.cos(angle) * radius);
            const y = Math.round(cy + Math.sin(angle) * radius);
            ctx.fillRect(x, y, 1, 1);
        }
    }

    // The Harbor's light is the pool path's (its static lamp sources) and the
    // emissive sidecar's; this ungraded overlay draws no screen-blend discs or
    // wake arcs. What remains is cloth and cargo, snapped to the art grid and
    // taken through the frame's C2 grade so it sits in the island's light.
    _drawHarborMasterOffice(ctx, localPoint, building = null) {
        const signal = localPoint(208, 38);
        const pier = localPoint(112, 187);
        const lightGrade = this._overlayLightGrade();
        const grade = lightGrade ? (tone) => gradeTone(tone, lightGrade) : null;
        const windX = pennantWind(this.atmosphereState?.weather);
        const tMs = this.frame * 16;

        // 6.5 — signal pennants on the mast: three cloths of the shared pixel
        // pennant strip (PixelPennant), hoisted on the mast's own line, flying
        // downwind at 4 fps and hanging on the rest frame in calm air.
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        const releaseDay = this.releaseDay?.dayPennantUp?.(Date.now()) === true;
        HARBOR_SIGNAL_PENNANTS.forEach(([dy, color, shade], index) => {
            const release = index === 0 && releaseDay;
            drawPennant(ctx, signal.x + 3, signal.y + dy + 14, {
                accent: release ? HARBOR_RELEASE_PENNANT[0] : color,
                shade: release ? HARBOR_RELEASE_PENNANT[1] : shade,
                grade,
                frame: pennantFrame(tMs, windX, { motion: this.motionScale > 0, phase: index }),
                windX,
                withPole: false,
            });
        });
        ctx.restore();
        this._drawHarborActivityMarkers(ctx, pier, building, lightGrade);
    }

    // Quay cargo, one crate per activity quarter. The failure itself is the
    // HarborTraffic broken bracket on the jetty (C4); a failed push only turns
    // the crate tags to the reserved failure red here.
    _drawHarborActivityMarkers(ctx, pier, building, lightGrade = null) {
        const activity = building ? this._buildingActivityInfo(building) : { intensity: 0, occupancy: { ratio: 0 }, alert: false };
        const activeWorking = this._watchtowerActiveCount();
        const failed = this.harborStatus?.failedPushActive;
        const signal = Math.max(activity.intensity, activity.occupancy.ratio, Math.min(1, activeWorking / 6));
        if (signal <= 0.16 && !failed) return;

        const cargoCount = Math.max(1, Math.min(4, Math.ceil(signal * 4)));
        // The failure tag is a reserved status colour and stays ungraded; the
        // ordinary gold tag is cloth and takes the grade.
        const tagColor = failed ? '#ff755d' : gradeTone('#ffd37a', lightGrade);
        const rim = gradeTone('#1f140c', lightGrade);
        const bob = this.motionScale ? Math.round(Math.sin(this.frame * 0.11) * 0.6) : 0;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        for (let i = 0; i < cargoCount; i++) {
            const x = pier.x - 28 + i * 16;
            const y = pier.y - 15 + (i % 2) * 5 + bob;
            // Crate: a 1-texel dark rim around the lid-lit body.
            ctx.fillStyle = rim;
            ctx.fillRect(x - 5, y - 5, 10, 8);
            ctx.fillStyle = gradeTone(i < activeWorking ? '#8a5a32' : '#5e4228', lightGrade);
            ctx.fillRect(x - 4, y - 4, 8, 6);
            ctx.fillStyle = tagColor;
            ctx.fillRect(x - 3, y - 7, 6, 2);
        }
        ctx.restore();
    }

    // The re-authored hall carries its lanterns and rose window in authored
    // art and the emissive sidecar, and busy reading already lights the steps
    // through the pool path (`_archiveSpillLightSources`) and drifts
    // `archiveMote` dust through the door (`_spawnEmittersFor`). This ungraded
    // overlay adds no screen-blend window, door or lamp discs over the face.
    _drawArchiveEnhancement(ctx, localPoint) {
        const doorway = localPoint(...getBuildingEffectAnchor('archive', 'doorway', [168, 130]));
        // Reduced motion: ParticleSystem is muted so the high-intensity
        // doorway archiveMote burst would be invisible. Stamp a small fixed
        // dot cluster so the read signal still reads at the door.
        if (!this.motionScale && (this._archiveReadIntensity || 0) > 0.6) {
            this._drawArchiveStaticDoorBurst(ctx, doorway);
        }
        this._drawArchiveRitual(ctx, doorway, this._latestRitual('archive'));
    }

    _drawArchiveStaticDoorBurst(ctx, doorway) {
        const dots = [
            [0, -8], [-7, -2], [7, -2], [-3, 6], [3, 6],
        ];
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff1bd';
        for (const [dx, dy] of dots) {
            ctx.fillRect(doorway.x + dx, doorway.y + dy, 2, 2);
        }
        ctx.restore();
    }

    // The hearth's light is the pool path's (the Forge static sources scaled by
    // `_forgeGlow`, plus `_forgeSpillLightSources` on the apron at night) and
    // the emissive sidecar's. This ungraded overlay draws no heat bloom, no
    // chimney or anvil discs and no molten smear across the wall: only the
    // anvil sparks that say work is being struck.
    _drawForgeEnhancement(ctx, localPoint, building = null) {
        const anvil = localPoint(...getBuildingEffectAnchor('forge', 'anvil', [195, 150]));
        const activity = building ? this._buildingActivityInfo(building) : { intensity: 0, occupancy: { ratio: 0 } };
        this._drawForgeActivityMarks(ctx, anvil, activity);
    }

    // Up to four sparks off the anvil, one per activity quarter: each a 3-texel
    // staircase with a hot head. Sparks are emission, so they stay ungraded.
    // The head hops one texel on the slow band; reduced motion holds it.
    _drawForgeActivityMarks(ctx, anvil, activity) {
        const signal = Math.max(activity?.intensity || 0, activity?.occupancy?.ratio || 0);
        if (signal <= 0.14) return;
        const count = Math.max(1, Math.min(4, Math.ceil(signal * 4)));
        const hop = this.motionScale ? (Math.sin(this.frame * 0.18) > 0 ? 1 : 0) : 0;
        const body = activity?.alert ? '#ff755d' : '#ffb347';
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        for (let i = 0; i < count; i++) {
            const x = anvil.x - 18 + i * 10;
            const y = anvil.y + 14 - i * 2 - hop;
            ctx.fillStyle = body;
            ctx.fillRect(x - 2, y + 1, 1, 1);
            ctx.fillRect(x - 1, y, 1, 1);
            ctx.fillStyle = '#fff3c4';
            ctx.fillRect(x, y - 1, 1, 1);
        }
        ctx.restore();
    }

    // 4.4 — the workload. Three stepped billets by the anvil, one per observed
    // count tier, and the exact `12 edit calls · last 60s` on inspection.
    // These are *calls the classifier routed here*, never successful edits.
    _drawForgeWorkload(ctx, localPoint, selected) {
        const profile = getBuildingWorkloadProfile('forge');
        const workload = this._forgeWorkload;
        if (!profile || !workload) return;
        const tier = Math.max(0, Math.min(3, Number(workload.tier) || 0));
        if (tier > 0) {
            const [ax, ay] = profile.billets.at;
            const [stepX, stepY] = profile.billets.step || [10, -5];
            const w = Math.max(4, Math.round(profile.billets.w || 8));
            const h = Math.max(3, Math.round(profile.billets.h || 4));
            ctx.save();
            for (let index = 0; index < tier; index++) {
                const at = localPoint(ax + index * stepX, ay + index * stepY);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
                ctx.fillStyle = '#2b1d13';
                ctx.fillRect(at.x - 1, at.y - 1, w + 2, h + 2);
                ctx.fillStyle = index === 2 ? '#ffd36a' : index === 1 ? '#f08a4b' : '#c2601f';
                ctx.fillRect(at.x, at.y, w, h);
                ctx.globalCompositeOperation = 'screen';
                ctx.globalAlpha = 0.5;
                ctx.fillStyle = '#ffb347';
                ctx.fillRect(at.x, at.y, w, 1);
            }
            ctx.restore();
        }
        if (selected && Array.isArray(profile.countAt)) {
            const at = localPoint(profile.countAt[0], profile.countAt[1]);
            this._drawInstrumentPlate(ctx, at.x, at.y, workload.label, { color: '#ffd36a', type: 'forge' });
        }
    }

    // 4.4 — a record that says how a call ended. Deduplicated on the adapters'
    // stable result id, so the same finished command never stamps twice across
    // polls, and bounded so a busy Forge cannot grow this list. W7.2 — every
    // building's outcomes (the Forge's included) land as apron chits through
    // `LandmarkActivity._observeToolResult`; this shelf stays the Forge's own
    // longer, selectable memory of its last results, so it keeps Forge calls.
    _observeToolResult(event) {
        if (event?.building !== 'forge') return;
        const id = typeof event.id === 'string' ? event.id : '';
        if (!id || this._resultShelfIds.has(id)) return;
        this._resultShelfIds.add(id);
        const exitCode = Number.isFinite(Number(event.exitCode)) && event.exitCode !== null
            ? Number(event.exitCode)
            : null;
        this._resultShelf.unshift({
            id,
            agentId: typeof event.agentId === 'string' ? event.agentId : null,
            tool: event.tool || null,
            exitCode,
            completedAt: Number(event.completedAt) || Date.now(),
            placedAt: Date.now(),
        });
        while (this._resultShelf.length > RESULT_SHELF_RETAINED) {
            const dropped = this._resultShelf.pop();
            if (dropped) this._resultShelfIds.delete(dropped.id);
        }
    }

    // The shelf itself: the newest few finished commands keep their own
    // stamped tile — intact for `exit 0`, cracked for a non-zero exit, blank
    // while the exit is unknown — and everything older is coalesced into an
    // exact `xN`. Selecting a tile opens that session's detail record.
    _drawForgeResultShelf(ctx, localPoint, selected) {
        const profile = getBuildingWorkloadProfile('forge');
        if (!profile?.shelf || !this._resultShelf.length) return;
        const shelf = profile.shelf;
        const max = Math.max(1, Math.round(shelf.max || 4));
        const w = Math.max(5, Math.round(shelf.w || 9));
        const h = Math.max(4, Math.round(shelf.h || 8));
        const step = Math.max(w + 1, Math.round(shelf.step || 11));
        const shown = this._resultShelf.slice(0, max);
        const now = Date.now();
        const origin = localPoint(shelf.at[0], shelf.at[1]);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        // The shelf plank: one course of stone under the tiles.
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(38, 32, 30, 0.9)';
        ctx.fillRect(origin.x - 2, origin.y + h, step * shown.length + 2, 2);
        shown.forEach((entry, index) => {
            const x = origin.x + index * step;
            const y = origin.y;
            const settle = this.motionScale
                ? Math.min(1, Math.max(0, (now - entry.placedAt) / RESULT_TILE_SETTLE_MS))
                : 1;
            ctx.globalAlpha = 0.25 + settle * 0.75;
            this._drawResultTile(ctx, x, y, w, h, entry.exitCode);
            this._registerInstrumentHit({
                kind: 'result-tile',
                agentId: entry.agentId,
                left: x - 1,
                top: y - 1,
                right: x + w + 1,
                bottom: y + h + 1,
            });
        });
        ctx.globalAlpha = 1;
        const coalesced = this._resultShelf.length - shown.length;
        if (coalesced > 0 && selected) {
            this._drawInstrumentPlate(ctx, origin.x + shown.length * step, origin.y + h / 2, `x${coalesced}`, {
                align: 'left',
            });
        }
        ctx.restore();
    }

    _drawResultTile(ctx, x, y, w, h, exitCode) {
        ctx.fillStyle = 'rgba(26, 22, 20, 0.94)';
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
        if (exitCode === null) {
            // Blank while the outcome is unknown: a tile with no stamp on it.
            ctx.fillStyle = 'rgba(120, 114, 108, 0.85)';
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = 'rgba(58, 54, 50, 0.9)';
            ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
            return;
        }
        const failed = exitCode !== 0;
        ctx.fillStyle = failed ? '#8c4a3a' : '#c9b183';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = failed ? '#5a2c22' : '#8d7a52';
        ctx.fillRect(x, y + h - 2, w, 2);
        if (failed) {
            // Cracked stamp: one stepped fracture across the tile.
            ctx.fillStyle = '#28100c';
            for (let index = 0; index < h; index++) {
                ctx.fillRect(x + Math.round((index * (w - 1)) / Math.max(1, h - 1)), y + index, 1, 1);
            }
            return;
        }
        // Intact stamp: a struck seal, centred.
        ctx.fillStyle = '#f2e2b6';
        ctx.fillRect(x + Math.round(w / 2) - 2, y + Math.round(h / 2) - 2, 4, 3);
        ctx.fillStyle = '#6a5a3a';
        ctx.fillRect(x + Math.round(w / 2) - 1, y + Math.round(h / 2) - 1, 2, 1);
    }

    _drawStaticSmokeWisp(ctx, point, { heat = 0, dust = false } = {}) {
        if (!point) return;
        const baseColor = dust
            ? '#b79b70'
            : mixHex('#8a8076', '#a8806b', clamp01(heat) * 0.7);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        const puffs = [
            { dy: 0, rx: 6, ry: 4, alpha: 0.30 },
            { dy: -9, rx: 8, ry: 5, alpha: 0.22 },
            { dy: -19, rx: 9, ry: 6, alpha: 0.14 },
        ];
        for (const puff of puffs) {
            ctx.globalAlpha = puff.alpha;
            fillPixelEllipse(ctx, point.x, point.y + puff.dy, puff.rx, puff.ry, baseColor);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    _drawArchiveRitual(ctx, doorway, ritual) {
        if (!ritual) return;
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const flip = ritual.motionEnabled === false
            ? 0.5
            : Math.abs(Math.sin(Math.min(1, progress / 0.42) * Math.PI));
        const pageWidth = 18 * (1 - flip * 0.72);
        const left = Math.round(doorway.x - 19);
        const top = Math.round(doorway.y - 22);
        const page = Math.max(2, Math.round(pageWidth));
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#2f1d12';
        ctx.fillRect(left - 1, top - 1, 40, 26);
        ctx.fillStyle = '#5e3c25';
        ctx.fillRect(left, top, 38, 24);
        ctx.fillStyle = '#e9d7a7';
        ctx.fillRect(left + 3, top + 3, 15, 18);
        ctx.fillStyle = '#f6e8bd';
        ctx.fillRect(left + 21, top + 3, page, 18);
        ctx.fillStyle = '#8a6a48';
        for (let i = 0; i < 3; i++) {
            const row = top + 7 + i * 5;
            ctx.fillRect(left + 7, row, 9, 1);
            if (page > 7) ctx.fillRect(left + 24, row, page - 7, 1);
        }
        if (ritual.label) this._drawRitualLabel(ctx, doorway.x, doorway.y - 38, ritual.label, '#b3d68c', fade, ritual.building || 'forge');
        ctx.restore();
    }

    // The ore-cart track, from the tunnel threshold (`railA`) out to the last
    // sleeper (`railB`); the ritual cart rolls along it in that direction.
    _mineRailSpan(localPoint) {
        const railA = localPoint(...getBuildingEffectAnchor('mine', 'railFrom', [102, 181]));
        const railB = localPoint(...getBuildingEffectAnchor('mine', 'railTo', [158, 172]));
        const rdx = railB.x - railA.x;
        const rdy = railB.y - railA.y;
        const railLen = Math.hypot(rdx, rdy) || 1;
        const ux = rdx / railLen;
        const uy = rdy / railLen;
        return { railA, railB, railLen, ux, uy, nx: -uy, ny: ux };
    }

    _mineCargoMix(cargo) {
        if (!cargo || !Number.isFinite(Number(cargo.ratio))) {
            return { ratio: 0, bucket: 0, crystalSlots: 0 };
        }
        const ratio = clamp01(cargo.ratio);
        const bucket = Math.round(ratio * 8) / 8;
        return { ratio, bucket, crystalSlots: Math.round(6 * bucket) };
    }

    _drawMineCargoHeap(ctx, x, y, cargo, alpha = 1) {
        const mix = this._mineCargoMix(cargo);
        for (let i = 0; i < 6; i++) {
            const row = i < 3 ? 0 : 1;
            const col = i % 3;
            const px = x + (col - 1) * 7 + row * 3;
            const py = y - 13 - row * 6;
            const crystal = i < mix.crystalSlots;
            const palette = crystal ? MINE_CARGO_CRYSTAL_COLORS : MINE_CARGO_ORE_COLORS;
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = alpha;
            ctx.fillStyle = palette[i % palette.length];
            ctx.strokeStyle = crystal ? '#e6f8ff' : '#7e6a50';
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (crystal) {
                ctx.moveTo(px, py - 4);
                ctx.lineTo(px + 4, py);
                ctx.lineTo(px, py + 4);
                ctx.lineTo(px - 4, py);
            } else {
                ctx.moveTo(px - 4, py + 2);
                ctx.lineTo(px - 2, py - 3);
                ctx.lineTo(px + 3, py - 4);
                ctx.lineTo(px + 5, py + 2);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            if (crystal) {
                ctx.globalCompositeOperation = 'screen';
                ctx.globalAlpha = alpha * 0.72;
                ctx.fillStyle = '#e6f8ff';
                ctx.fillRect(Math.round(px - 1), Math.round(py - 3), 1, 2);
            }
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    _drawMineRitual(ctx, mouth, rail, ritual) {
        if (!ritual) return;
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const swing = ritual.motionEnabled === false
            ? -0.45
            : -0.95 + Math.sin(Math.min(1, progress / 0.62) * Math.PI * 2) * 0.9;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(mouth.x - 4, mouth.y + 2);
        ctx.rotate(swing);
        ctx.strokeStyle = '#3a2819';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, -21);
        ctx.lineTo(0, 5);
        ctx.stroke();
        ctx.strokeStyle = '#d7a45c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-10, -23);
        ctx.lineTo(12, -18);
        ctx.stroke();
        ctx.restore();

        const rollProgress = ritual.motionEnabled === false
            ? 0.6
            : 1 - Math.pow(1 - clamp01(progress), 3);
        const cartX = rail.railA.x + rail.ux * rail.railLen * rollProgress;
        const cartY = rail.railA.y + rail.uy * rail.railLen * rollProgress;
        ctx.save();
        ctx.globalAlpha = fade;
        if (this.assets?.get?.('prop.oreCart')) {
            this.sprites.drawSprite(ctx, 'prop.oreCart', cartX, cartY);
        } else {
            ctx.fillStyle = '#5a3927';
            ctx.fillRect(Math.round(cartX - 15), Math.round(cartY - 10), 30, 14);
            ctx.strokeStyle = '#2f2119';
            ctx.strokeRect(Math.round(cartX - 15) + 0.5, Math.round(cartY - 10) + 0.5, 29, 13);
        }
        if (ritual.cargo && (ritual.motionEnabled === false || this._zoom >= 1)) {
            this._drawMineCargoHeap(ctx, cartX, cartY, ritual.cargo, fade);
        }
        ctx.restore();

        const oreProgress = ritual.motionEnabled === false ? 0.5 : clamp01((progress - 0.18) / 0.58);
        if (oreProgress > 0 && oreProgress < 1) {
            const mix = this._mineCargoMix(ritual.cargo);
            const shardCount = ritual.cargo ? 2 : 1;
            for (let i = 0; i < shardCount; i++) {
                const shardProgress = clamp01(oreProgress - i * 0.08);
                // Ore arcs out of the tunnel and lands where the cart stops.
                const ox = mouth.x + (rail.railB.x - mouth.x) * shardProgress;
                const oy = mouth.y + (rail.railB.y - 12 - mouth.y) * shardProgress
                    - Math.sin(shardProgress * Math.PI) * (28 - i * 5);
                const crystal = ritual.cargo && i < Math.round(2 * mix.bucket);
                ctx.save();
                ctx.globalAlpha = fade;
                ctx.fillStyle = crystal
                    ? MINE_CARGO_CRYSTAL_COLORS[i % MINE_CARGO_CRYSTAL_COLORS.length]
                    : (ritual.cargo ? MINE_CARGO_ORE_COLORS[i % MINE_CARGO_ORE_COLORS.length] : this._mineSeamColor());
                ctx.strokeStyle = crystal ? '#e6f8ff' : '#4a2f1c';
                ctx.beginPath();
                ctx.moveTo(ox - 5, oy);
                ctx.lineTo(ox + 1, oy - 5);
                ctx.lineTo(ox + 7, oy - 1);
                ctx.lineTo(ox + 3, oy + 5);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        }
        if (ritual.label) this._drawRitualLabel(ctx, mouth.x, mouth.y - 40, ritual.label, this._mineSeamColor(), fade, 'mine');
        // No percentage on the Mine (4.3): the cart's crystal/ore mix carries
        // the class split and the selected bench carries the exact counts.
    }

    // Mine reserves = remaining 5-hour quota, rendered as a stockpile of glowing
    // ore crystals (count = reserve tier 0..4) above a five-segment reserve
    // gauge. The higher the remaining limit, the richer the mine. A depleted
    // reserve raises a pulsing red warning; without quota data the mine makes no
    // reserve claim at all.
    // `pile` is the registry `reserve` anchor on the rubble by the mouth.
    _drawMineReserve(ctx, pile) {
        if (!this._hasMineQuota()) return;

        const reserve = this._mineReserveRatio();
        const tier = this._mineReserveTier();   // 0 depleted .. 4 brimming
        const depleted = tier === 0;
        const seamColor = this._mineSeamColor(); // gold (rich) -> red (depleted)

        const barWidth = 40;
        const barX = Math.round(pile.x - barWidth / 2);
        const barY = Math.round(pile.y + 33);
        const fillWidth = Math.round(barWidth * reserve);

        ctx.save();

        // Ore stockpile: one crystal per filled tier, piled by the tunnel.
        for (let i = 0; i < tier; i++) {
            const col = i % 3;
            const row = i < 3 ? 0 : 1;
            const x = pile.x - 15 + col * 15 + row * 7;
            const y = pile.y + 17 - row * 7;
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.8;
            this._drawActivityDiamond(ctx, x, y, 4.6, '#3a2819', 'rgba(255, 210, 128, 0.34)');
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.5 + reserve * 0.3;
            this._drawActivityDiamond(ctx, x, y - 1, 3.1, seamColor);
        }

        // Reserve gauge: dark track, four tier ticks, reserve fill.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.74;
        ctx.fillStyle = 'rgba(34, 24, 15, 0.82)';
        ctx.fillRect(barX, barY, barWidth, 4);
        ctx.strokeStyle = 'rgba(244, 214, 139, 0.38)';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX + 0.5, barY + 0.5, barWidth - 1, 3);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = 'rgba(20, 13, 7, 0.85)';
        for (let i = 1; i < 5; i++) {
            ctx.fillRect(barX + Math.round((barWidth / 5) * i), barY, 1, 4);
        }

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.58 + reserve * 0.3;
        ctx.fillStyle = seamColor;
        ctx.fillRect(barX + 1, barY + 1, Math.max(0, fillWidth - 2), 2);

        // Depleted reserves: pulsing red warning chevrons at the gauge ends.
        if (depleted) {
            ctx.globalCompositeOperation = 'source-over';
            const warn = this.motionScale ? 0.55 + Math.sin(this.frame * 0.18) * 0.27 : 0.6;
            ctx.globalAlpha = warn;
            ctx.strokeStyle = '#ff755d';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(barX - 5, barY - 2);
            ctx.lineTo(barX - 1, barY + 6);
            ctx.moveTo(barX + barWidth + 5, barY - 2);
            ctx.lineTo(barX + barWidth + 1, barY + 6);
            ctx.stroke();
        }
        ctx.restore();
    }

    // 4.3 — the assay bench. Two shallow trays retain the last 60 s of
    // observed fresh-input ore and cache-read crystal, an assay rack states
    // provenance one coin stamp at a time (solid = provider-reported cost,
    // hollow = estimate), and the ledger carries exact counts. A class the
    // provider does not report reads `unknown`; nothing here is a percentage.
    // S5 — an empty tray or rack is not drawn (the ledger already says `0`);
    // furniture gives way to T1 plates and bodies; the ledger rows stack on
    // one column with no overlap, inside the visible canvas, and step off any
    // plate or body.
    _drawMineAssayBench(ctx, localPoint) {
        const profile = getBuildingAssayProfile('mine');
        const assay = this._mineAssay;
        if (!profile || !assay) return;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        for (const tray of profile.trays) {
            const at = localPoint(tray.at[0], tray.at[1]);
            const value = tray.kind === 'cacheRead' ? assay.tokens.cacheRead : assay.tokens.input;
            if (value !== null && value !== undefined && !(value > 0)) continue;
            const w = Math.max(10, Math.round(tray.w || 26));
            const h = Math.max(6, Math.round(tray.h || 10));
            if (this._rectHitsSignalOrBody({ x: at.x, y: at.y, w, h })) continue;
            this._drawAssayTray(ctx, at, tray, value);
        }
        const rackAt = localPoint(profile.rack.at[0], profile.rack.at[1]);
        const stamps = Array.isArray(assay.cost?.stamps) ? assay.cost.stamps.length : 0;
        const rackRect = {
            x: rackAt.x,
            y: rackAt.y,
            w: Math.max(12, Math.round(profile.rack.w || 30)),
            h: Math.max(8, Math.round(profile.rack.h || 12)),
        };
        if ((stamps > 0 || assay.cost?.stampOverflow > 0) && !this._rectHitsSignalOrBody(rackRect)) {
            this._drawAssayRack(ctx, rackAt, profile.rack, assay.cost);
        }
        const rows = [];
        if (Array.isArray(profile.countAt)) {
            rows.push({ text: assay.tokens.label, color: MINE_CARGO_CRYSTAL_COLORS[0] });
        }
        if (Array.isArray(profile.costAt)) {
            const note = assay.cost.note ? ` · ${assay.cost.note}` : '';
            rows.push({ text: `${assay.cost.label}${note}`, color: assay.cost.coverage === 'ok' ? '#f6d384' : '#c9c2b4' });
        }
        const anchor = profile.countAt || profile.costAt;
        if (rows.length && anchor && this._chitsVisible('mine')) {
            this._drawAssayLedger(ctx, localPoint(anchor[0], anchor[1]), rows);
        }
        ctx.restore();
    }

    // The assay ledger: one centred column of instrument plates, 17 screen px
    // apart (16 px plate + 1 px gap), placed at the first candidate slot that
    // is inside the canvas and clear of T1 plates and bodies.
    _drawAssayLedger(ctx, at, rows) {
        const zoom = this._zoom > 0 ? this._zoom : 1;
        const pitch = 17;
        ctx.save();
        ctx.font = WORLD_BODY_FONT_11;
        let width = 0;
        for (const row of rows) width = Math.max(width, measureLabelText(ctx, String(row.text || '')) + 10);
        ctx.restore();
        const height = rows.length * pitch;
        const view = this._plaqueWorldViewport(ctx, 1 / zoom);
        const blockAt = (dx, dy) => ({
            x: at.x + (dx - width / 2) / zoom,
            y: at.y + (dy - 8) / zoom,
            w: width / zoom,
            h: height / zoom,
        });
        const inView = rect => !view || (rect.x >= view.left && rect.y >= view.top
            && rect.x + rect.w <= view.right && rect.y + rect.h <= view.bottom);
        const candidates = [[0, 0], [0, 24], [0, -height - 8], [width / 2 + 24, 0], [-width / 2 - 24, 0], [0, 48], [0, -height - 32]];
        let chosen = null;
        for (const [dx, dy] of candidates) {
            const rect = blockAt(dx, dy);
            if (inView(rect) && !this._rectHitsSignalOrBody(rect)) {
                chosen = rect;
                break;
            }
        }
        if (!chosen) {
            // Nowhere clear: keep the home slot, clamped into view; any row
            // that would still cover a T1 plate is dropped by the plate itself.
            chosen = blockAt(0, 0);
            if (view) {
                chosen.x = Math.min(Math.max(chosen.x, view.left), view.right - chosen.w);
                chosen.y = Math.min(Math.max(chosen.y, view.top), view.bottom - chosen.h);
            }
        }
        const centerX = chosen.x + chosen.w / 2;
        rows.forEach((row, index) => {
            this._drawInstrumentPlate(ctx, centerX, chosen.y + (8 + index * pitch) / zoom, row.text, {
                color: row.color,
                type: 'mine',
            });
        });
    }

    // Quantized fill only: six nugget slots on a documented log ladder, so a
    // tray reads as more or less at a glance while the exact number stays on
    // the slate. `null` is an explicitly unknown class, not an empty tray.
    _drawAssayTray(ctx, at, tray, value) {
        const w = Math.max(10, Math.round(tray.w || 26));
        const h = Math.max(6, Math.round(tray.h || 10));
        const left = Math.round(at.x);
        const top = Math.round(at.y);
        ctx.fillStyle = 'rgba(36, 28, 20, 0.92)';
        ctx.fillRect(left, top, w, h);
        ctx.fillStyle = 'rgba(126, 106, 80, 0.9)';
        ctx.fillRect(left, top, w, 1);
        ctx.fillRect(left, top + h - 1, w, 1);
        ctx.fillRect(left, top, 1, h);
        ctx.fillRect(left + w - 1, top, 1, h);
        if (value === null || value === undefined) {
            this._drawInstrumentPlate(ctx, left + w / 2, top + h / 2, 'unknown', { color: '#c6beb2', type: 'mine' });
            return;
        }
        const nuggets = value <= 0 ? 0 : Math.max(1, Math.min(6, 1 + Math.floor(Math.log2(value / 100))));
        const crystal = tray.kind === 'cacheRead';
        const palette = crystal ? MINE_CARGO_CRYSTAL_COLORS : MINE_CARGO_ORE_COLORS;
        for (let index = 0; index < nuggets; index++) {
            const col = index % 3;
            const row = index < 3 ? 0 : 1;
            const x = left + 5 + col * 8;
            const y = top + h - 3 - row * 4;
            ctx.fillStyle = palette[index % palette.length];
            if (crystal) {
                ctx.beginPath();
                ctx.moveTo(x, y - 3);
                ctx.lineTo(x + 3, y);
                ctx.lineTo(x, y + 2);
                ctx.lineTo(x - 3, y);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.fillRect(x - 3, y - 2, 6, 4);
            }
        }
    }

    // One coin stamp per covered session: struck solid for a provider-reported
    // cost, left hollow for an estimate. The rack never states an amount — the
    // measured window does that once, on the slate.
    _drawAssayRack(ctx, at, rack, cost) {
        const w = Math.max(12, Math.round(rack.w || 30));
        const h = Math.max(8, Math.round(rack.h || 12));
        const left = Math.round(at.x);
        const top = Math.round(at.y);
        ctx.fillStyle = 'rgba(30, 24, 18, 0.9)';
        ctx.fillRect(left, top, w, h);
        ctx.fillStyle = 'rgba(126, 106, 80, 0.85)';
        ctx.fillRect(left, top + h - 1, w, 1);
        const stamps = Array.isArray(cost?.stamps) ? cost.stamps : [];
        stamps.forEach((source, index) => {
            const cx = left + 4 + index * 5;
            const cy = top + Math.round(h / 2);
            ctx.fillStyle = source === 'provider' ? '#f6d384' : 'rgba(246, 211, 132, 0.42)';
            if (source === 'provider') {
                ctx.fillRect(cx - 2, cy - 2, 4, 4);
            } else {
                ctx.fillRect(cx - 2, cy - 2, 4, 1);
                ctx.fillRect(cx - 2, cy + 1, 4, 1);
                ctx.fillRect(cx - 2, cy - 1, 1, 2);
                ctx.fillRect(cx + 1, cy - 1, 1, 2);
            }
        });
        if (cost?.stampOverflow > 0) {
            this._drawInstrumentPlate(ctx, left + 4 + stamps.length * 5, top + h / 2, `+${cost.stampOverflow}`, {
                align: 'left',
                type: 'mine',
            });
        }
    }

    // #52 — dome aperture: the round opening nearest the telescope opens with
    // the night beacon (state-driven, so the reduced-motion pose is simply the
    // same static open amount) revealing a warm slit + star point; a completed
    // web ritual pays off as a brief star burst. 6.5 — when nothing is going
    // on, a slow glint (slow band, shared with the observatory sweep — never
    // concurrent, the glint idles only while no ritual runs) crosses the dormer.
    _drawObservatoryAperture(ctx, localPoint) {
        const night = clamp01(this.lightingState?.beaconIntensity
            ?? this.atmosphereState?.lighting?.beaconIntensity ?? 0);
        // Closed by day, fully open in deep night.
        const open = clamp01((night - 0.3) / 0.5);
        const burstAge = Date.now() - this._observatoryBurstAt;
        const bursting = burstAge >= 0 && burstAge < OBSERVATORY_BURST_MS;
        // Motion fades the burst envelope out; reduced motion holds a fixed
        // alpha for the window instead (static one-shot flash).
        const burst = bursting
            ? (this.motionScale ? 1 - burstAge / OBSERVATORY_BURST_MS : 0.85)
            : 0;
        const ritualActive = this._observatoryWebRitualIds.size > 0;

        if (open > 0.02 || burst > 0) {
            const slit = localPoint(...OBSERVATORY_APERTURE.slit);
            const star = localPoint(...OBSERVATORY_APERTURE.star);
            const slitH = 1 + Math.round(open * 4);
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            // Two stepped courses of warm light on the dormer, not a gradient.
            const glowAlpha = Math.min(0.5, 0.10 + open * 0.2 + burst * 0.3);
            const rx = Math.round(15 + burst * 8);
            const ry = Math.round(10 + burst * 6);
            ctx.globalAlpha = glowAlpha * 0.5;
            fillPixelEllipse(ctx, slit.x, slit.y, rx, ry, '#ffa24e');
            ctx.globalAlpha = glowAlpha;
            fillPixelEllipse(ctx, slit.x, slit.y, Math.round(rx * 0.55), Math.round(ry * 0.55), '#ffd68a');
            ctx.restore();

            ctx.save();
            // Dark frame + warm core so the slit reads as an opening, not a glow smear.
            ctx.fillStyle = 'rgba(22, 17, 26, 0.88)';
            ctx.fillRect(slit.x - 4, slit.y - Math.ceil(slitH / 2) - 1, 9, slitH + 2);
            ctx.fillStyle = `rgba(255, 216, 142, ${0.32 + open * 0.45})`;
            ctx.fillRect(slit.x - 3, slit.y - Math.floor(slitH / 2), 7, slitH);
            // Star point inside the aperture; gentle twinkle on the slow band.
            const twinkle = this.motionScale ? 0.5 + Math.sin(this.frame * 0.05) * 0.18 : 0.58;
            ctx.fillStyle = `rgba(255, 244, 196, ${Math.min(1, twinkle + burst * 0.4)})`;
            ctx.fillRect(star.x - 1, star.y - 1, 2, 2);
            if (burst > 0) {
                // 4-point result-burst star over the dormer, in texel runs.
                ctx.fillStyle = `rgba(255, 241, 168, ${Math.min(1, 0.45 + burst * 0.55)})`;
                const arm = 3 + Math.round(burst * 5);
                ctx.fillRect(star.x - arm, star.y, arm * 2 + 1, 1);
                ctx.fillRect(star.x, star.y - arm, 1, arm * 2 + 1);
            }
            ctx.restore();
        }

        this._drawObservatoryIdleGlint(ctx, localPoint, ritualActive);
    }

    // 6.5 — idle glint: a slow bright point sweeping the dormer glass on a ~9s
    // sawtooth while the observatory has no live web ritual. Reduced motion: a
    // fixed faint glint at the arc's rest angle (no sweep, no allocations).
    _drawObservatoryIdleGlint(ctx, localPoint, ritualActive) {
        if (ritualActive) return;
        const arc = OBSERVATORY_APERTURE.glintArc || { center: [149, 104], radius: 12, from: -2.4, to: -0.7 };
        const center = localPoint(...arc.center);
        let angle;
        let alpha;
        if (this.motionScale) {
            const t = (this.frame % OBSERVATORY_GLINT_PERIOD_FRAMES) / OBSERVATORY_GLINT_PERIOD_FRAMES;
            // Sweep across the arc for the first 22% of the period, dark the rest.
            if (t > 0.22) return;
            const sweep = t / 0.22;
            angle = arc.from + (arc.to - arc.from) * sweep;
            alpha = Math.sin(sweep * Math.PI) * 0.55;
        } else {
            angle = arc.from + (arc.to - arc.from) * 0.5;
            alpha = 0.22;
        }
        const gx = Math.round(center.x + Math.cos(angle) * arc.radius);
        const gy = Math.round(center.y + Math.sin(angle) * arc.radius * 0.6);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#e8f2ff';
        ctx.fillRect(gx - 1, gy - 1, 2, 2);
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillRect(gx - 2, gy, 4, 1);
        ctx.restore();
    }

    _drawObservatoryRitual(ctx, localPoint, building) {
        const ritual = this._latestRitual('observatory');
        if (!ritual) return;
        const dome = localPoint(157, 86);
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const target = ritual.angle || -0.7;
        const angle = ritual.motionEnabled === false ? target : lerp(-1.2, target, Math.min(1, progress / 0.5));
        // The telescope swings as a stepped block line, never a rotated rect.
        const reach = 28;
        const tipX = Math.round(dome.x + Math.cos(angle) * reach);
        const tipY = Math.round(dome.y + Math.sin(angle) * reach);
        ctx.save();
        ctx.globalAlpha = fade;
        this._drawBlockLine(ctx, dome.x, dome.y, tipX, tipY, 8, '#252532');
        this._drawBlockLine(ctx, dome.x, dome.y, tipX, tipY, 6, '#6e7585');
        ctx.fillStyle = '#bda7ff';
        ctx.fillRect(tipX - 3, tipY - 3, 5, 6);
        ctx.restore();

        if (ritual.motionEnabled !== false && progress > 0.48 && progress < 0.86) {
            ctx.save();
            ctx.globalAlpha = fade * 0.72;
            ctx.fillStyle = '#fff1a8';
            for (let i = 0; i < 6; i++) {
                const a = -1.2 + (angle + 1.2) * (i / 5);
                ctx.fillRect(Math.round(dome.x + Math.cos(a) * 34), Math.round(dome.y + Math.sin(a) * 34), 2, 2);
            }
            ctx.restore();
        }
        if (ritual.label) this._drawRitualLabel(ctx, dome.x, dome.y + 54, ritual.label, '#bda7ff', fade, 'observatory');
    }

    _drawPortalRitual(ctx, gate, ritual) {
        if (!ritual) return;
        const fade = this._ritualFade(ritual);
        const action = ritual.action || 'portal';
        const progress = ritual.motionEnabled === false ? 1 : this._ritualProgress(ritual);
        // Distinguish browser-preview vs Playwright-active by re-classifying
        // the ritual's source tool. `action === 'summon'` (and other lifecycle
        // actions) keep the full-stack rings unchanged.
        const reason = action === 'portal' ? this._portalReasonFor(ritual) : null;
        const color = action === 'dismiss'
            ? '#f08a8a'
            : action === 'familiar-wait'
                ? '#f2d36b'
                : action === 'familiar-return'
                    ? '#bda7ff'
                    : reason === 'portal-preview'
                        ? '#7dd3ff'
                        : '#8feaff';

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = fade;
        // Ceremony rings as snapped dots that step outward (inward on dismiss)
        // across the ritual in four frames; reduced motion holds mid-ring.
        const ringPhase = ritual.motionEnabled === false ? 0.5 : Math.min(1, Math.floor(progress * 4) / 3);
        // portal-preview = single inner ring (cool blue); other states keep the
        // 3-ring stack so summon/dismiss/familiar/active read as full ceremony.
        const ringCount = reason === 'portal-preview' ? 1 : 3;
        for (let i = 0; i < ringCount; i++) {
            const offset = action === 'dismiss' ? (1 - ringPhase) * 13 : ringPhase * 12;
            ringDots(ctx, gate.x, gate.y + 2, Math.round(23 + i * 8 + offset), {
                count: 12 + i * 2,
                dot: 1,
                color,
                phase: i * 0.7,
            });
        }

        const targetSprite = this._targetSpriteForRitual(ritual);
        if (targetSprite && action !== 'summon') {
            const target = { x: targetSprite.x, y: targetSprite.y - 42 };
            const control = {
                x: (gate.x + target.x) / 2,
                y: Math.min(gate.y, target.y) - 46,
            };
            const travel = action === 'dismiss' || action === 'familiar-return'
                ? 1 - progress
                : progress;
            const inv = 1 - travel;
            const pulseX = inv * inv * gate.x + 2 * inv * travel * control.x + travel * travel * target.x;
            const pulseY = inv * inv * gate.y + 2 * inv * travel * control.y + travel * travel * target.y;
            ctx.globalAlpha = fade * 0.5;
            dottedCurve(ctx, gate.x, gate.y, control.x, control.y, target.x, target.y, { step: 5, color });
            ctx.globalAlpha = fade;
            ctx.fillStyle = color;
            ctx.fillRect(snap(pulseX) - 1, snap(pulseY) - 2, 3, 5);
            ctx.fillRect(snap(pulseX) - 2, snap(pulseY) - 1, 5, 3);
        }

        ctx.globalCompositeOperation = 'source-over';
        // Procedural 16x12 floating screen for portal-active. Drawn before the
        // label so the parchment tag sits above it.
        if (reason === 'portal-active') {
            this._drawPortalActiveScreen(ctx, gate, fade);
        }
        ctx.globalAlpha = fade;
        this._drawInstrumentPlate(ctx, gate.x, gate.y - 46, this._portalRitualLabel(ritual), {
            color: '#d9fbff',
            border: color,
            type: 'portal',
        });
        ctx.restore();
    }

    // Re-classify the ritual's source tool/input to recover the
    // browser-preview vs Playwright-active reason. The conductor currently
    // does not forward `event.reason`, so derive it here from the same
    // ToolIdentity helper that produced the original event.
    _portalReasonFor(ritual) {
        if (!ritual?.tool) return null;
        try {
            const classified = classifyTool(ritual.tool, ritual.input || '');
            const reason = classified?.reason;
            if (reason === 'portal-active' || reason === 'portal-preview') return reason;
        } catch {
            return null;
        }
        return null;
    }

    // Canvas-drawn 16x12 rounded screen hovering above the gate.
    // Scanline drift uses `frame` so it pauses under reduced motion. No PixelLab.
    _drawPortalActiveScreen(ctx, gate, fade) {
        const w = 16;
        const h = 12;
        const x = Math.round(gate.x - w / 2);
        const y = Math.round(gate.y - 34);
        ctx.save();
        ctx.globalAlpha = fade * 0.9;
        // A 1-texel cyan bezel around the dark screen, corners notched.
        ctx.fillStyle = '#8feaff';
        ctx.fillRect(x + 1, y, w - 2, h);
        ctx.fillRect(x, y + 1, w, h - 2);
        ctx.fillStyle = '#121c2a';
        ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
        // Faint scanline that drifts top-to-bottom; static at row 5 when motion is off.
        const drift = this.motionScale ? Math.floor((this.frame * 0.18) % (h - 2)) : 5;
        ctx.globalAlpha = fade * 0.45;
        ctx.fillStyle = '#bff2ff';
        ctx.fillRect(x + 1, y + 1 + drift, w - 2, 1);
        ctx.restore();
    }

    _portalRitualLabel(ritual) {
        const lifecycle = ritual?.commandLifecycle;
        const fallback = lifecycle?.kind === 'spawn'
            ? 'SUMMON'
            : lifecycle?.kind === 'close'
                ? 'DISMISS'
                : lifecycle?.kind === 'wait'
                    ? 'ATTUNE'
                    : lifecycle?.kind === 'resume'
                        ? 'RECALL'
                        : lifecycle?.kind === 'send_input'
                            ? 'TETHER'
                            : 'PORTAL';
        return wordFitLabel(ritual?.label || fallback, 12).toUpperCase();
    }

    _drawTaskboardBoard(ctx, localPoint) {
        const board = this._taskboardBoard();
        const view = board?.fleet
            ? this._taskboardFleetView(board.fleet)
            : this._taskboardViewFor(board?.agent || null, 3);
        if (!view) return false;
        const zoom = this._zoom > 0 ? this._zoom : 1;
        this._drawOnTaskboardSlate(ctx, localPoint, `board|${zoom}|${JSON.stringify(view)}`, (slateCtx, slateTopLeft) => (
            this._paintTaskboardChalk(slateCtx, slateTopLeft, view, zoom)
        ), { stepped: true });
        return true;
    }

    // The chalk layout in flat slate space, written onto the angled board.
    // Chalk is type on the C5 grid (5.4): the frame cancels camera zoom so the
    // header is 8 px Press Start 2P and the rows 11 px Departure Mono at every
    // zoom. S11 — every glyph stays upright and whole on the pixel grid: a
    // line follows the slate's slope by stepping each glyph (and each rule
    // segment) down by whole screen pixels, never by shearing glyph pixels.
    // A row on the 2:1 slope falls several pitches across the slate, so rows
    // sit on a wide pitch (18 px; 30 px for the doubled z3 type) with a faint ruled line
    // in the gap beneath each: the eye follows one row's rule, never a
    // neighbour's glyphs. The slate's size in screen pixels decides how many
    // rows fit; rows that do not fit fold into one exact `+N more` line of
    // their own, never a bare ellipsis.
    _paintTaskboardChalk(ctx, slateTopLeft, view, zoom = 1) {
        const chalk = 'rgba(231, 234, 216, 0.94)';
        const dimChalk = 'rgba(211, 218, 201, 0.5)';
        const accent = '#8bd7ff';
        const unit = zoom > 0 ? zoom : 1;
        const shear = TASKBOARD_SLATE.shear;
        const inset = 3;
        const k = unit >= 3 ? 2 : 1;
        const lineHeight = k === 2 ? 30 : 18;
        const ruleColor = 'rgba(211, 218, 201, 0.16)';
        const drop = x => Math.round(x * shear);
        // One upright glyph at a time, each dropped to the slope at its left edge.
        const steppedText = (text, x, baseline, strike = null) => {
            let cursor = x;
            for (const glyph of String(text)) {
                const advance = measureLabelText(ctx, glyph);
                const y = baseline + drop(cursor);
                ctx.fillText(glyph, cursor, y);
                if (strike && glyph.trim()) {
                    const fill = ctx.fillStyle;
                    ctx.fillStyle = strike;
                    ctx.fillRect(cursor, y - 4 * k, Math.ceil(advance), k);
                    ctx.fillStyle = fill;
                }
                cursor += advance;
            }
        };
        // A horizontal slate rule, stepped down the slope one whole pixel at a time.
        const steppedRule = (x, y, width, thickness) => {
            const step = Math.max(1, Math.round(1 / Math.max(0.01, shear)));
            for (let px = 0; px < width; px += step) {
                ctx.fillRect(x + px, y + drop(x + px), Math.min(step, width - px), thickness);
            }
        };
        ctx.save();
        ctx.translate(slateTopLeft.x, slateTopLeft.y);
        ctx.scale(1 / unit, 1 / unit);
        snapScreenOrigin(ctx);
        // Chalk never leaves the slate: clip to the art's 2:1 slate quad
        // (measured on building.taskboard/base.png: x82–167, top y59 at the
        // left stile, falling one pixel per two across).
        const slateW = Math.floor(TASKBOARD_SLATE.w * unit);
        const slateH = Math.floor(TASKBOARD_SLATE.h * unit);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(slateW, drop(slateW));
        ctx.lineTo(slateW, drop(slateW) + slateH);
        ctx.lineTo(0, slateH);
        ctx.closePath();
        ctx.clip();
        // The top inset clears the slope under a glyph's width, so upright
        // header glyphs stay whole below the slate's falling top edge.
        const inner = {
            x: inset,
            y: inset + 2 * k,
            w: slateW - inset * 2,
            h: slateH - inset * 2 - 2 * k,
        };
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = k === 2 ? WORLD_DISPLAY_FONT_16 : WORLD_DISPLAY_FONT_8;
        ctx.fillStyle = chalk;
        // A line that ends in an exact count (` · 3/24`) shortens its words,
        // never the count.
        const fitKeepingCount = (text, maxWidth) => {
            if (measureLabelText(ctx, text) <= maxWidth) return text;
            const cut = text.lastIndexOf(' · ');
            if (cut < 0) return fitLabelText(ctx, text, maxWidth);
            const tail = text.slice(cut);
            const room = maxWidth - measureLabelText(ctx, tail);
            if (room < measureLabelText(ctx, 'Ab…')) return fitLabelText(ctx, text.slice(cut + 3), maxWidth);
            return fitLabelText(ctx, text.slice(0, cut), room).replace(/\s+…$/, '…') + tail;
        };
        steppedText(fitKeepingCount(view.header, inner.w), inner.x, inner.y + 8 * k);
        ctx.fillStyle = 'rgba(139, 215, 255, 0.42)';
        steppedRule(inner.x, inner.y + 10 * k, inner.w, k);
        const contentTop = inner.y + 13 * k;
        const capacity = Math.max(0, Math.floor((inner.h - 13 * k) / lineHeight));
        const requestedRows = view.layout.rows;
        let rows = requestedRows;
        if (requestedRows.length > capacity) {
            const kept = capacity > 0 ? requestedRows.slice(0, capacity - 1) : [];
            const hidden = requestedRows.slice(kept.length);
            let items = 0;
            let phases = 0;
            for (const row of hidden) {
                if (row.kind === 'item') items += 1;
                else if (row.kind === 'phase') phases += 1;
                else if (row.kind === 'plan') items += 1;
                else if (row.kind === 'more') items += Number(row.count) || 0;
            }
            const parts = [];
            if (items > 0) parts.push(`+${items} more`);
            if (phases > 0) parts.push(`+${phases} phase${phases === 1 ? '' : 's'}`);
            // When both counts do not fit one row, the row still states an
            // exact number: every hidden row, items and phases together.
            rows = capacity > 0 ? [...kept, { kind: 'more', text: parts.join(' · '), compact: `+${items + phases} more` }] : [];
        }
        ctx.font = k === 2 ? WORLD_BODY_FONT_22 : WORLD_BODY_FONT_11;
        let phaseIndex = 0;
        rows.forEach((row, index) => {
            const itemIndent = row.kind === 'item' || row.kind === 'more' ? 6 : 0;
            const x = inner.x + itemIndent;
            const baseline = contentTop + 9 * k + index * lineHeight;
            let rowText = row.kind === 'phase'
                ? `${taskboardPhaseMarker(phaseIndex++)}. ${row.text} · ${row.done}/${row.total}`
                : row.kind === 'plan'
                    ? `${row.text} · ${row.done}/${row.total}`
                    : row.text;
            if (row.compact && measureLabelText(ctx, rowText) > inner.w - itemIndent) rowText = row.compact;
            const text = row.kind === 'phase' || row.kind === 'plan'
                ? fitKeepingCount(rowText, inner.w - itemIndent)
                : fitLabelText(ctx, rowText, inner.w - itemIndent);
            if ((row.kind === 'phase' && row.active) || row.status === 'in_progress') {
                ctx.fillStyle = accent;
                const markX = x - (itemIndent ? 5 : 3);
                ctx.fillRect(markX, baseline - 6 * k + drop(markX), 2, 4 * k);
            }
            ctx.fillStyle = row.status === 'completed'
                ? dimChalk
                : row.status === 'in_progress'
                    ? accent
                    : chalk;
            steppedText(text, x, baseline, row.status === 'completed' ? dimChalk : null);
            ctx.fillStyle = ruleColor;
            steppedRule(inner.x, baseline + 3 * k + 1, inner.w, k);
        });
        ctx.restore();
    }

    // 4.5 — the re-authored slate is a true 2:1 plane descending to the
    // right (it faces the lower-left entrance). Content is laid out flat on a
    // raster at the current device scale, so glyphs stay exactly as crisp as
    // on the old flat board. Flat content (paper, racks) is then laid onto
    // the plane one world-pixel column at a time, each column dropped by a
    // whole world pixel every `1 / shear` columns. `stepped` content (chalk
    // type) already follows the slope glyph by glyph on a raster tall enough
    // for the whole plane, and is blitted once, unsheared, on whole device
    // pixels. `signature` caches the raster while the content and scale hold;
    // `null` repaints every frame (animated paper). Without a raster surface
    // (no DOM) the content is painted in place.
    _drawOnTaskboardSlate(ctx, localPoint, signature, paint, { stepped = false } = {}) {
        const slate = TASKBOARD_SLATE;
        const origin = localPoint(slate.x, slate.y);
        const transform = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
        const scale = Math.max(0.25, Math.abs(Number(transform?.a) || 1));
        const worldH = stepped ? slate.h + Math.ceil(slate.w * slate.shear) : slate.h;
        const pw = Math.max(1, Math.ceil(slate.w * scale));
        const ph = Math.max(1, Math.ceil(worldH * scale));
        const cache = this._taskboardSlateRaster || (this._taskboardSlateRaster = { canvas: null, key: null });
        if (!cache.canvas) cache.canvas = createRasterCanvas(pw, ph);
        const canvas = cache.canvas;
        if (!canvas) {
            paint(ctx, origin);
            return;
        }
        // A web font landing after the first paint must repaint the raster.
        const fonts = globalThis.document?.fonts?.status || '';
        const key = signature === null ? null : `${signature}|${scale}|${fonts}|${stepped ? 's' : 'c'}`;
        if (key === null || cache.key !== key) {
            if (canvas.width !== pw) canvas.width = pw;
            if (canvas.height !== ph) canvas.height = ph;
            const slateCtx = canvas.getContext('2d');
            slateCtx.setTransform(1, 0, 0, 1, 0, 0);
            slateCtx.clearRect(0, 0, pw, ph);
            slateCtx.setTransform(scale, 0, 0, scale, 0, 0);
            slateCtx.imageSmoothingEnabled = false;
            paint(slateCtx, { x: 0, y: 0 });
            cache.key = key;
        }
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        if (stepped && transform) {
            // One blit, raster pixel = device pixel.
            const deviceX = Math.round(transform.a * origin.x + transform.c * origin.y + transform.e);
            const deviceY = Math.round(transform.b * origin.x + transform.d * origin.y + transform.f);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(canvas, 0, 0, pw, ph, deviceX, deviceY, pw, ph);
            ctx.restore();
            return;
        }
        const columnH = ph / scale;
        for (let column = 0; column < slate.w; column++) {
            const drop = Math.floor(column * slate.shear);
            ctx.drawImage(canvas, column * scale, 0, scale, ph, origin.x + column, origin.y + drop, 1, columnH);
        }
        ctx.restore();
    }

    // 4.7 — the slate's frame tabs: one project-coloured tab per concurrent
    // plan owner, each carrying its repo crest and its own `done/total`, with
    // an exact `+N plans` under them. The slate itself still shows exactly one
    // owner's phase plan — selecting a tab is what changes whose. Tabs are
    // screen-fixed type (5.4) hung off the slate's left edge: each tab's
    // right edge is flush to the slate, so it reads as part of the board and
    // never overhangs the chalk at any zoom.
    _drawTaskboardPlanTabs(ctx, localPoint) {
        const profile = getBuildingPlanTabProfile('taskboard');
        if (!profile || !this._chitsVisible('taskboard')) return;
        const summaries = this._taskboardBoardModel.summaries({
            candidates: this._taskboardCandidates || [],
            agentSprites: this.agentSprites,
        });
        if (summaries.length < 2) return;
        const shown = summaries.slice(0, Math.max(1, profile.max || 3));
        const boardId = this._taskboardBoardAgent()?.id || null;
        const zoom = this._zoom > 0 ? this._zoom : 1;
        const s = 1 / zoom;
        const gap = Math.max(1, Math.round(profile.gap || 2));
        const tabH = 12;
        const edge = localPoint(profile.at[0], profile.at[1]);
        ctx.save();
        ctx.translate(edge.x, edge.y);
        ctx.scale(s, s);
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const rows = shown.map(summary => ({ summary, text: `${summary.done}/${summary.total}` }));
        const overflow = summaries.length - shown.length;
        const overflowText = overflow > 0 ? `+${overflow} plans` : '';
        rows.forEach(({ summary, text }, index) => {
            const accent = this._repoProfileFor(summary.project)?.accent || '#8bd7ff';
            const active = summary.agentId === boardId;
            const tabW = 2 + 2 + 4 + 3 + Math.ceil(measureLabelText(ctx, text)) + 4;
            const left = -tabW;
            const top = index * (tabH + gap);
            ctx.fillStyle = LABEL_INK.plateOutline;
            ctx.fillRect(left - 1, top - 1, tabW + 1, tabH + 2);
            ctx.fillStyle = LABEL_INK.plate;
            ctx.fillRect(left, top, tabW, tabH);
            ctx.fillStyle = active ? accent : 'rgba(120, 128, 124, 0.75)';
            ctx.fillRect(left, top, 2, tabH);
            // Owner token: the same repo crest colour the villager's tag uses.
            ctx.fillStyle = accent;
            ctx.fillRect(left + 4, top + tabH / 2 - 2, 4, 4);
            ctx.fillStyle = active ? '#f2f6ee' : '#c8cfc4';
            ctx.fillText(text, left + 11, top + 9);
            this._registerInstrumentHit({
                kind: 'plan-tab',
                agentId: summary.agentId,
                left: edge.x + (left - 1) * s,
                top: edge.y + (top - 1) * s,
                right: edge.x,
                bottom: edge.y + (top + tabH + 1) * s,
            });
        });
        if (overflowText) {
            const width = Math.ceil(measureLabelText(ctx, overflowText)) + 8;
            const top = rows.length * (tabH + gap);
            ctx.fillStyle = LABEL_INK.plateOutline;
            ctx.fillRect(-width - 1, top - 1, width + 1, tabH + 2);
            ctx.fillStyle = LABEL_INK.plate;
            ctx.fillRect(-width, top, width, tabH);
            ctx.fillStyle = '#e2e8de';
            ctx.fillText(overflowText, -width + 4, top + 9);
        }
        ctx.restore();
    }

    _drawTaskboardRitual(ctx, localPoint) {
        const papers = this._taskboardPapers
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-MAX_TASKBOARD_PAPERS);
        if (!papers.length) return;
        const now = Date.now();
        const pinned = papers.map((paper) => {
            const completed = paper.status === 'completed';
            const completeAge = completed ? Math.max(0, now - paper.completedAt) : 0;
            const flutter = completed && this.motionScale
                ? Math.max(0, 1 - completeAge / 2200)
                : 0;
            return { paper, completed, flutter };
        });
        // A fluttering paper repaints every frame; a still board is cached.
        const signature = pinned.some(item => item.flutter > 0)
            ? null
            : `papers|${pinned.map(({ paper, completed }) => `${paper.slotSeed}:${completed ? 1 : 0}`).join(',')}`;
        this._drawOnTaskboardSlate(ctx, localPoint, signature, (slateCtx, origin) => {
            pinned.forEach(({ paper, completed, flutter }, index) => {
                const col = index % 2;
                const row = Math.floor(index / 2);
                const drift = flutter ? Math.sin(this.frame * 0.42 + paper.slotSeed) * 3 : 0;
                const angle = flutter ? Math.sin(this.frame * 0.18 + paper.slotSeed) * 0.08 : 0;
                const x = origin.x + 16 + col * 34;
                const y = origin.y + 6 + row * 22 + drift;
                slateCtx.save();
                slateCtx.translate(Math.round(x + 10), Math.round(y + 7));
                slateCtx.rotate(angle);
                slateCtx.globalAlpha = completed ? 0.88 : 1;
                slateCtx.fillStyle = completed ? '#d7c088' : '#e8cf91';
                slateCtx.strokeStyle = completed ? '#3f4e38' : '#4a3420';
                slateCtx.lineWidth = 1;
                slateCtx.fillRect(-10, -7, 20, 15);
                slateCtx.strokeRect(-9.5, -6.5, 19, 14);
                slateCtx.fillStyle = completed ? '#2d6b47' : '#9e4a35';
                slateCtx.fillRect(-1, -9, 3, 4);

                slateCtx.strokeStyle = completed ? 'rgba(50, 72, 45, 0.62)' : 'rgba(68, 44, 24, 0.55)';
                slateCtx.lineWidth = 1;
                for (let i = 0; i < 3; i++) {
                    slateCtx.beginPath();
                    slateCtx.moveTo(-6, -2 + i * 4);
                    slateCtx.lineTo(6, -2 + i * 4);
                    slateCtx.stroke();
                }

                if (completed) {
                    slateCtx.strokeStyle = '#2d6b47';
                    slateCtx.lineWidth = 2;
                    slateCtx.beginPath();
                    slateCtx.moveTo(-7, 1);
                    slateCtx.lineTo(7, -2);
                    slateCtx.stroke();
                    slateCtx.strokeStyle = 'rgba(58, 41, 26, 0.82)';
                    slateCtx.lineWidth = 1;
                    slateCtx.beginPath();
                    slateCtx.moveTo(-8, 5);
                    slateCtx.lineTo(8, 2);
                    slateCtx.stroke();
                }
                slateCtx.restore();
            });
        });
    }

    _drawCommandRitual(ctx, localPoint) {
        const rituals = this._ritualsFor('command');
        if (!rituals.length) return;
        const keep = localPoint(...getBuildingEffectAnchor('command', 'keep', [174, 24]));
        const standard = localPoint(...getBuildingEffectAnchor('command', 'standard', [174, 4]));
        for (const ritual of rituals) {
            const fade = this._ritualFade(ritual);
            if (ritual.action === 'message') {
                this._drawCarrierBird(ctx, keep, ritual, fade);
                continue;
            }
            ctx.save();
            ctx.globalAlpha = fade;
            const sx = Math.round(standard.x);
            const sy = Math.round(standard.y);
            ctx.fillStyle = '#201814';
            ctx.fillRect(sx, sy - 38, 2, 34);
            // The standard: a dark-rimmed gold pennant, filled row by row.
            ctx.fillStyle = '#3a2614';
            fillConvex(ctx, [[sx + 2, sy - 39], [sx + 30, sy - 31], [sx + 2, sy - 23]]);
            ctx.fillStyle = '#f2d36b';
            fillConvex(ctx, [[sx + 2, sy - 38], [sx + 27, sy - 31], [sx + 2, sy - 24]]);
            ctx.restore();
        }
    }

    _drawCarrierBird(ctx, source, ritual, fade) {
        const target = this._chatTargetForRitual(ritual) || { x: source.x + 52, y: source.y + 2 };
        const progress = ritual.motionEnabled === false ? 1 : clamp01(this._ritualProgress(ritual) / 0.72);
        const control = { x: (source.x + target.x) / 2, y: Math.min(source.y, target.y) - 70 };
        const inv = 1 - progress;
        const x = inv * inv * source.x + 2 * inv * progress * control.x + progress * progress * target.x;
        const y = inv * inv * (source.y - 24) + 2 * inv * progress * control.y + progress * progress * (target.y - 42);
        if (ritual.motionEnabled === false) {
            this._drawRitualLabel(ctx, source.x, source.y - 54, 'MSG', '#f2d36b', fade, ritual.building || 'command');
            return;
        }
        // A pixel gull-post: a 5×3 body with a dark rim and two stepped wings
        // that beat between two poses on the slow band.
        const bx = snap(x);
        const by = snap(y);
        const up = Math.sin(this.frame * 0.3) > 0 ? 1 : 0;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#45311c';
        ctx.fillRect(bx - 3, by - 2, 7, 5);
        ctx.fillStyle = '#f1ead0';
        ctx.fillRect(bx - 2, by - 1, 5, 3);
        ctx.fillStyle = '#f2d36b';
        for (let i = 1; i <= 4; i++) {
            const lift = up ? Math.min(i, 3) : Math.max(0, 2 - i);
            ctx.fillRect(bx - 3 - i * 2, by - 1 - lift, 2, 1);
            ctx.fillRect(bx + 2 + i * 2, by - 1 - lift, 2, 1);
        }
        ctx.restore();
    }

    // Building-face chit (`VISITING`, `MSG`): screen-fixed, and only for the
    // building in view (5.6) — otherwise the plaque count already says it.
    _drawRitualLabel(ctx, x, y, label, color, alpha = 1, type = null) {
        const text = wordFitLabel(label, 12).toUpperCase();
        if (!text || !this._chitsVisible(type)) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        this._drawInstrumentPlate(ctx, x, y, text, { color: '#fff0c4', border: color });
        ctx.restore();
    }

    _chatTargetForRitual(ritual) {
        const explicitTarget = this._targetSpriteForRitual(ritual);
        if (explicitTarget) return explicitTarget;
        const source = this.agentSprites.find(sprite => sprite?.agent?.id === ritual.agentId);
        return source?.chatPartner || null;
    }

    _targetSpriteForRitual(ritual) {
        const lifecycle = ritual?.commandLifecycle || null;
        const targetId = lifecycle?.targetAgentId || null;
        if (targetId) {
            const exact = this.agentSprites.find(sprite => sprite?.agent?.id === targetId);
            if (exact) return exact;
        }
        const targetRef = lifecycle?.targetRef || null;
        if (!targetRef) return null;
        const ref = String(targetRef).toLowerCase();
        return this.agentSprites.find((sprite) => {
            const agent = sprite?.agent;
            if (!agent) return false;
            return String(agent.id || '').toLowerCase() === ref
                || String(agent.agentId || '').toLowerCase() === ref
                || String(agent.agentName || '').toLowerCase() === ref
                || String(agent.name || '').toLowerCase() === ref;
        }) || null;
    }

    _mineSeamColor() {
        const ratio = this._quotaFiveHourRatio();
        if (ratio <= 0.5) return MINE_SEAM_COLORS[0];
        if (ratio <= 0.8) return mixHex(MINE_SEAM_COLORS[0], MINE_SEAM_COLORS[1], (ratio - 0.5) / 0.3);
        return mixHex(MINE_SEAM_COLORS[1], MINE_SEAM_COLORS[2], (ratio - 0.8) / 0.2);
    }

    _hasMineQuota() {
        return Number.isFinite(Number(this.quotaState?.fiveHour ?? this.quotaState?.fiveHourRatio));
    }

    // Remaining 5-hour limit as a 0..1 reserve (inverse of usage). Higher means
    // more "ore" left in the mine.
    _mineReserveRatio() {
        return clamp01(1 - this._quotaFiveHourRatio());
    }

    // Discrete reserve tier 0..4 (depleted / low / medium / high / brimming).
    // The 0.2 depleted floor mirrors the top-bar danger threshold (usage >= 0.8).
    _mineReserveTier() {
        const reserve = this._mineReserveRatio();
        if (reserve < 0.2) return 0;
        if (reserve < 0.4) return 1;
        if (reserve < 0.6) return 2;
        if (reserve < 0.8) return 3;
        return 4;
    }

    // Authored flame/lens art stays intact. Only the clock drives its warm
    // halo and one descending mirror shaft; the rear arc is suppressed so
    // the upper overlay can never paint through the tower's split.
    _drawWatchtowerFire(ctx, beacon) {
        if (lampCourseFor(this.atmosphereState) < LAMP_COURSE_LAMPLIGHT) return;
        const ms = this._partClockMs();
        const angle = searchlightAngleAt(ms);
        const breath = fireBreath(ms, 'fire:watchtower', this.motionScale);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        if (Math.sin(angle) >= -0.2) this._fillBeaconShaft(ctx, beacon, angle);
        const [, , , rim, mid, hot, core] = ART_RAMPS.beaconFire;
        const facing = Math.sin(angle) > 0.25 ? 1 : 0;
        const course = (breath < 0.9 ? -1 : breath < 0.98 ? 0 : 1) + facing;
        const halo = [[28 + course, 0.12, rim], [18 + course, 0.2, mid], [10 + course, 0.32, hot], [5, 0.5, core]];
        for (const [radius, alpha, color] of halo) {
            ctx.globalAlpha = alpha + facing * 0.04;
            ctx.fillStyle = color;
            this._fillPixelCircle(ctx, beacon.x, beacon.y, radius);
        }
        ctx.restore();
    }

    // Scan-convert the shaft between the glass and the exact sea landing,
    // in world texels. Ordered coverage breaks both edges and the tail;
    // alpha and colour hold in three courses, never a smooth gradient.
    _fillBeaconShaft(ctx, beacon, angle) {
        const distance = SEARCHLIGHT_LENGTH * SEARCHLIGHT_LANDING_SHARE;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const foot = WATCHTOWER_LANTERN_FIRE.foot || WATCHTOWER_SEARCHLIGHT.pivot;
        const height = foot[1] - WATCHTOWER_LANTERN_FIRE.flame[1];
        const dx = Math.round(foot[0] - WATCHTOWER_LANTERN_FIRE.flame[0] + c * distance);
        const dy = Math.round(height + s * distance * 0.5);
        const length = Math.hypot(dx, dy);
        // Cross-sections use the sea cone's 2:1 ground-plane perpendicular,
        // so its landing edges and the shaft's edges have the same geometry.
        const nx = -s;
        const ny = c * 0.5;
        const determinant = dx * ny - dy * nx;
        if (Math.abs(determinant) < 1) return;
        const spreadX = Math.abs(nx) * BEAM_NEAR_HALF_WIDTH + 2;
        const spreadY = Math.abs(ny) * BEAM_NEAR_HALF_WIDTH + 2;
        const minX = Math.floor(Math.min(0, dx) - spreadX);
        const maxX = Math.ceil(Math.max(0, dx) + spreadX);
        const minY = Math.floor(Math.min(0, dy) - spreadY);
        const maxY = Math.ceil(Math.max(0, dy) + spreadY);
        const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        const ox = Math.round(beacon.x);
        const oy = Math.round(beacon.y);
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5;
                const py = y + 0.5;
                const t = (px * ny - py * nx) / determinant;
                if (t < 6 / length || t >= 1) continue;
                const width = 4 + (BEAM_NEAR_HALF_WIDTH - 4) * t;
                const across = Math.abs((dx * py - dy * px) / determinant);
                const coverage = Math.max(0, Math.min(1, (width - across) / 3))
                    * (t < 0.78 ? 1 : t < 0.87 ? 0.75 : t < 0.94 ? 0.5 : 0.25);
                const order = (bayer[((oy + y) & 3) * 4 + ((ox + x) & 3)] + 0.5) / 16;
                if (coverage <= order) continue;
                const course = t < 0.3 ? 0 : t < 0.65 ? 1 : 2;
                ctx.globalAlpha = course === 0 ? 0.4 : course === 1 ? 0.27 : 0.16;
                ctx.fillStyle = ART_RAMPS.beaconFire[course === 0 ? 5 : 4];
                ctx.fillRect(ox + x, oy + y, 1, 1);
            }
        }
    }

    _spawnEmittersFor(b, dt = 16) {
        const entry = this.assets.getEntry(`building.${b.type}`);
        if (!this.motionScale) return;
        const center = this._buildingScreenCenter(b);
        const entryId = entry?.id || `building.${b.type}`;
        const baseAnchor = this.assets.getAnchor(entryId);
        // The safety fire has one low-rate, clock-only ember source. It
        // bypasses occupancy/beacon-density multipliers; ParticleSystem owns
        // ornament admission, pressure shedding and the shared hard cap.
        if (b.type === 'watchtower') {
            if (lampCourseFor(this.atmosphereState) >= LAMP_COURSE_LAMPLIGHT) {
                const emitter = BUILDING_EMITTER_FALLBACKS.watchtower[0];
                const tick = Math.floor(this._partClockMs() / emitter.stepMs);
                if (tick === this._watchtowerEmberTick) return;
                this._watchtowerEmberTick = tick;
                this._spawnBuildingParticle(b, emitter.type, center, baseAnchor, emitter.at, 1, 1, 16, {
                    colors: ART_RAMPS.beaconFire.slice(4, 6),
                    life: [45, 70],
                    size: [1, 1],
                    speed: [0.4, 0.7],
                    spread: [3, 1],
                });
            }
            return;
        }
        for (const [particleType, [lx, ly]] of Object.entries(entry?.emitters || {})) {
            const normalizedType = PARTICLE_ALIASES[particleType] || particleType;
            const at = [lx, ly];
            this._spawnBuildingParticle(b, normalizedType, center, baseAnchor, at, 0.035, 1, dt);
        }
        const presenceMult = PRESENCE_TIER_TABLE[this._workTierFor(b)].emitter;
        // Beacon breathing: emitter density rises with the global beacon
        // intensity so every building's fire/spark/mote flow quickens together as
        // night deepens. Held at the static-0.5 floor under reduced motion.
        const beaconMult = 0.72 + this._beaconScaleFor(b.type) * 0.5;
        // Door-region archiveMote emitters (at y≈128) burst more when read
        // intensity passes 0.6. Crest emitter (y≈82) is unaffected.
        const archiveReadIntensity = b.type === 'archive' ? (this._archiveReadIntensity || 0) : 0;
        // #33 — signed wind drift shared by the smoke-family emitters so the
        // forge chimney column, mine dust, and harbor steam all lean downwind
        // by the same amount.
        const windDrift = smokeWindDrift(this.atmosphereState);
        // 4.6 — at canonical rest the activity-only emitters (hearth embers,
        // forge and harbor smoke, mine dust, quest pings, archive motes) stop;
        // the architectural fires keep burning — the castle torches and gate
        // lantern in `entry.emitters` above, and the Pharos beacon, which is a
        // safety light and not a work signal.
        const restQuiet = this._villageAtRest() && b.type !== 'watchtower';
        for (const emitter of restQuiet ? [] : BUILDING_EMITTER_FALLBACKS[b.type] || []) {
            let chanceBoost = b.type === 'forge'
                ? 0.7 + this._forgeGlowIntensity() * 1.1
                : this._workingVisitorCountFor(b) > 0 ? 1.6 : 1;
            if (archiveReadIntensity > 0.6 && Array.isArray(emitter.at) && emitter.at[1] >= 120) {
                chanceBoost *= 1 + (archiveReadIntensity - 0.6) * 5;
            }
            const chance = emitter.chance * chanceBoost * presenceMult * beaconMult;
            const options = this._smokeEmitterOptions(b, emitter.type, windDrift);
            this._spawnBuildingParticle(b, emitter.type, center, baseAnchor, emitter.at, chance, emitter.count || 1, dt, options);
        }
    }

    // #33 — per-emitter spawn options for the volumetric dust family. Returns
    // null for other emitters (unchanged behaviour). Mine dust gets the shared
    // wind drift; wind also widens the spawn spread so a leaning plume smears
    // out. (6.4 — every chimney column, the Harbor's two stacks included, is
    // ChimneySmoke's, gated by working visitors.)
    _smokeEmitterOptions(building, particleType, windDrift) {
        if (building.type !== 'mine' || particleType !== 'mineDust') return null;

        const options = {};
        if (windDrift) options.windX = windDrift;
        const lean = Math.abs(windDrift);
        if (lean) options.spread = [2.4 + lean * 2.6, 2.4 + lean * 2.6];
        return options;
    }

    _spawnBuildingParticle(building, type, center, baseAnchor, at, chance, count, dt = 16, options = null) {
        if (Math.random() > chanceForDt(chance, dt)) return;
        const [lx, ly] = at;
        const wx = center.x - baseAnchor[0] + lx;
        const wy = center.y - baseAnchor[1] + ly;
        // 0.6 — every building emitter (torches, embers, motes, pings, mine
        // dust) sorts just in front of the half of its own sprite it sits on.
        this.particles.spawn(type, wx, wy, count, { ...(options || {}), sortY: this.particleSortY(building, ly) });
    }

    // 0.6 — the painter sortY for a particle emitted at sprite row `localY` of
    // `building`: the owning drawable (the back half above the horizon, the
    // front half below it, the whole sprite when unsplit) + 1, so an ember or
    // a puff never hides behind its own roof yet stays behind anything nearer.
    // Null when the building has no drawable (the spawn's ground line stands).
    particleSortY(building, localY) {
        for (const drawable of this.enumerateDrawables()) {
            if (drawable.building !== building) continue;
            if (drawable.kind === 'building'
                || (drawable.kind === 'building-front') === (Number(localY) >= drawable.horizonY)) {
                return drawable.sortY + 1;
            }
        }
        return null;
    }

    _updateVisitorCounts() {
        this._visitorCountByType.clear();
        this._visitorStatusByType.clear();
        // V8 — the agent ids behind each building's `working` count (6.1 part
        // gates, 6.2 doors and 6.3 room slots all read this one set).
        const workingIds = this._workingIdsByType || (this._workingIdsByType = new Map());
        for (const ids of workingIds.values()) ids.clear();
        if (!this.agentSprites?.length || !this.buildings.length) {
            if (this.agentSprites?.length) for (const sprite of this.agentSprites) sprite._foldBuildingType = null;
            this._updateRoomSlots();
            return;
        }
        // Clear last frame's fold tags before re-tagging; IsometricRenderer
        // reads `_foldBuildingType` to suppress folded occupants' name pills.
        for (const sprite of this.agentSprites) sprite._foldBuildingType = null;
        // #53 — per-building occupant repo tally, refilled in place each tick
        // and reduced below to the dominant repo per type.
        const repoTally = this._visitorRepoTally || (this._visitorRepoTally = new Map());
        for (const tally of repoTally.values()) tally.clear();

        for (const sprite of this.agentSprites) {
            // V8 — rest-seat (7.1) and queue (7.2) occupants are never visitors:
            // no count, no working tally, no fold (their names stay up).
            if (NON_WORKING_VISIT_ROLES.includes(sprite.visitRole)) continue;
            const position = this._spriteTilePosition(sprite);
            if (!position) continue;
            const agentAtPosition = { ...sprite.agent, position };
            for (const building of this.buildings) {
                const isVisiting = typeof building.isAgentVisiting === 'function'
                    ? building.isAgentVisiting(agentAtPosition)
                    : building.containsPoint(position.tileX, position.tileY);
                if (!isVisiting) continue;
                this._visitorCountByType.set(building.type, (this._visitorCountByType.get(building.type) || 0) + 1);
                let tally = this._visitorStatusByType.get(building.type);
                if (!tally) {
                    tally = { working: 0, waiting: 0, waiting_on_user: 0, errored: 0 };
                    this._visitorStatusByType.set(building.type, tally);
                }
                const status = sprite.agent?.status;
                // V8 — `working` is the one working-visitor count every light,
                // emitter and window gate reads. The sprite's route intent and
                // occupancy role (7.1 seat / 7.2 queue) ride along.
                if (isWorkingVisitor(sprite.agent, {
                    building: building.type,
                    intent: sprite._lastIntentSnapshot,
                    role: sprite.visitRole,
                })) {
                    tally.working++;
                    if (sprite.agent?.id) {
                        let ids = workingIds.get(building.type);
                        if (!ids) workingIds.set(building.type, ids = new Set());
                        ids.add(sprite.agent.id);
                    }
                }
                if (status === AgentStatus.WAITING_ON_USER || status === AgentStatus.WAITING) tally.waiting++;
                if (status === AgentStatus.WAITING_ON_USER) tally.waiting_on_user++;
                else if (status === AgentStatus.ERRORED) tally.errored++;
                const project = this._repoProjectKey(sprite.agent);
                if (project) {
                    let repos = repoTally.get(building.type);
                    if (!repos) {
                        repos = new Map();
                        repoTally.set(building.type, repos);
                    }
                    repos.set(project, (repos.get(project) || 0) + 1);
                }
                sprite._foldBuildingType = building.type;
            }
        }

        // Semantic occupants: agents routed to a building by the visit system
        // count toward its pennant even while they still walk there — physical
        // standers alone would leave the standards furled almost always.
        for (const sprite of this.agentSprites) {
            const targetType = String(sprite?.agent?.targetBuildingType || '').trim();
            if (!targetType) continue;
            const project = this._repoProjectKey(sprite.agent);
            if (!project) continue;
            let repos = repoTally.get(targetType);
            if (!repos) {
                repos = new Map();
                repoTally.set(targetType, repos);
            }
            repos.set(project, (repos.get(project) || 0) + 1);
        }

        this._visitorRepoByType.clear();
        for (const [type, repos] of repoTally) {
            let dominant = null;
            for (const [project, count] of repos) {
                if (!dominant || count > dominant.count) dominant = { project, count };
            }
            if (dominant) {
                this._visitorRepoByType.set(type, {
                    ...dominant,
                    profile: this._repoProfileFor(dominant.project),
                });
            }
        }
        this._updateRoomSlots();
    }

    // 6.3 — stable room slots for every building: each working visitor
    // (isWorkingVisitor) keeps its own room while it works here; waiting
    // occupants are counted and never lit; whoever does not fit is an exact
    // overflow count. Rooms come from the landmark's `base.rooms.png`.
    _updateRoomSlots() {
        const workingIds = this._workingIdsByType;
        for (const building of this.buildings) {
            const type = building.type;
            const rooms = this.roomGlass.roomCount(type);
            const ids = workingIds?.get(type);
            const held = this._roomSlotsByType.get(type)?.assignment;
            // Sorted so a newcomer's room never depends on sprite order.
            const working = ids?.size ? [...ids].sort() : [];
            const { assignment, overflow } = assignRoomSlots({ previous: held, workingIds: working, rooms });
            const tally = this._visitorStatusByType.get(type);
            this._roomSlotsByType.set(type, {
                rooms,
                assignment,
                overflow,
                working: working.length,
                waiting: tally?.waiting || 0,
            });
        }
    }

    // 6.3 — the per-room gate other light surfaces read (2.4 aperture lights,
    // 2.9 water columns): 0..1, night × this room's stepped occupancy. A room
    // index is 0-based (mask R = index + 1); unknown rooms are dark.
    roomGate(type, roomIndex) {
        const lit = this._roomLitByType.get(type);
        const value = lit ? lit[roomIndex] || 0 : 0;
        return value > 0 ? value * this._nightWindowGate() : 0;
    }

    roomCount(type) {
        return this.roomGlass.roomCount(type);
    }

    // 6.3 — `{ rooms, assignment: Map<agentId, roomIndex>, overflow, working,
    // waiting }` for `type`, or null before the first update.
    roomOccupancy(type) {
        return this._roomSlotsByType.get(type) || null;
    }

    // 6.3 — lit share of a glass group: k ≥ 1 is room k - 1. Group 0 (glass
    // under a window/glass rect that no room mask claims: the Command's tower
    // panes, the Archive's hall lancets and clerestory) is never lit: only a
    // room a worker holds glows, so N workers light exactly min(N, rooms)
    // glass shapes. By day every pane is unlit glass (M15).
    _glassGroupGate(type, group) {
        return group > 0 ? this.roomGate(type, group - 1) : 0;
    }

    // 6.3 — the unlit-glass patch for `building` (RoomGlass.patch), shared by
    // the resident patch record and the Canvas emitter-cut carve.
    glassPatchFor(building) {
        const type = building?.type;
        if (!type) return null;
        return this.roomGlass.patch(type, (group) => this._glassGroupGate(type, group));
    }

    // 5.2 roofs / 6.6 — steps the roof weather once a frame from the C-W2
    // ground state and the live precipitation (WorldFrameRenderer).
    syncRoofWeather(atmosphere, ground, motionScale = this.motionScale, motionTimeMs = 0) {
        this.roofWeather.sync(atmosphere, ground, motionScale, motionTimeMs);
    }

    // The roof snow / wet-course patch of `building` (RoofWeather.patch),
    // shared by the resident patch record and the Canvas building pass; null
    // in clear, dry weather.
    roofPatchFor(building) {
        const type = building?.type;
        return type ? this.roofWeather.patch(type) : null;
    }

    // The eave-drip strip of `building` at the current drip frame, while it
    // rains and motion is on (RoofWeather.drip); null otherwise.
    roofDripFor(building) {
        const type = building?.type;
        return type ? this.roofWeather.drip(type) : null;
    }

    // Canvas twin of the resident roof records: the patch and the drip frame
    // on the landmark's own texels, cut at the split horizon like the base.
    _drawRoofWeather(ctx, d, dx, dy) {
        const layers = [this.roofPatchFor(d.building), this.roofDripFor(d.building)];
        for (const layer of layers) {
            if (!layer) continue;
            let top = layer.top;
            let bottom = layer.top + layer.h;
            if (d.kind === 'building-back') bottom = Math.min(bottom, d.horizonY);
            else if (d.kind === 'building-front') top = Math.max(top, d.horizonY);
            if (bottom <= top) continue;
            ctx.drawImage(layer.canvas, layer.sx || 0, top - layer.top, layer.w, bottom - top,
                dx + layer.left, dy + top, layer.w, bottom - top);
        }
    }

    // 6.7 — the static frame of a `dressing: true` layer (partDrawsFor, both
    // backends): what the Chronicle ledger (`chronicleDressing`, the
    // MonumentPlanter's lifetime counters, wired by IsometricRenderer) has
    // earned for this building, or null. Never gated by work, weather or
    // motion; an added object, so it takes no emissive channel and casts no
    // light.
    chronicleDressingFrame(type, name, layer) {
        return this.chronicleDressing?.frameFor(type, name, layer?.frames) ?? null;
    }

    _updateNightLightGates(dt) {
        const types = new Set([
            ...this._visitorStatusByType.keys(),
            ...this._litGateByType.keys(),
        ]);
        for (const type of types) {
            const target = (this._visitorStatusByType.get(type)?.working || 0) > 0 ? 1 : 0;
            const current = this._litGateByType.get(type)?.value || 0;
            const value = advanceNightOccupancyGate(current, target, dt, this.motionScale);
            this._litGateByType.set(type, { value, target });
        }
        // 6.3 — each room rises and falls on the same 400 / 1600 ms gate.
        for (const [type, slots] of this._roomSlotsByType) {
            let lit = this._roomLitByType.get(type);
            if (!lit || lit.length !== slots.rooms) {
                const next = new Float32Array(slots.rooms);
                if (lit) next.set(lit.subarray(0, Math.min(lit.length, next.length)));
                this._roomLitByType.set(type, lit = next);
            }
            const held = new Set(slots.assignment.values());
            for (let room = 0; room < lit.length; room++) {
                lit[room] = advanceNightOccupancyGate(lit[room], held.has(room) ? 1 : 0, dt, this.motionScale);
            }
        }
    }

    _repoProjectKey(agent) {
        // Same fallback chain AgentSprite's repo tags use.
        return String(agent?.projectPath || agent?.project || agent?.teamName || agent?.provider || '').trim();
    }

    // Resolved live: RepoColor's visible-repo registry may move a repo's
    // pennant, so a cached profile would go stale when a repo leaves and returns.
    _repoProfileFor(project) {
        return repoProfile(project);
    }

    _visitorCountFor(building) {
        return this._visitorCountByType.get(building?.type) || 0;
    }

    // V8 — the bodies at this building that pass `isWorkingVisitor`.
    _workingVisitorCountFor(building) {
        return this._visitorStatusByType.get(building?.type)?.working || 0;
    }

    // V8 — the presence tier a building's own light, emitters, window warmth
    // and chimney smoke read: busy at work capacity, occupied while anyone
    // works there, else dormant. Counting only working visitors (no observed-
    // tool recency tail), so the tier drops the update after the last worker
    // leaves, and seated, queued, waiting or passing bodies never brighten it.
    _workTierFor(building) {
        const working = this._workingVisitorCountFor(building);
        if (working <= 0) return 'dormant';
        const capacity = Number(building?.capacity?.work);
        return capacity > 0 && working >= capacity ? 'busy' : 'occupied';
    }

    // V8 — Map<type, { count, tier }> of working presence, the occupancy gate
    // ChimneySmoke reads. Entries are reused frame to frame.
    getWorkingPresence() {
        const out = this._workingPresence || (this._workingPresence = new Map());
        for (const building of this.buildings) {
            let entry = out.get(building.type);
            if (!entry) {
                entry = { count: 0, tier: 'dormant' };
                out.set(building.type, entry);
            }
            entry.count = this._workingVisitorCountFor(building);
            entry.tier = this._workTierFor(building);
        }
        return out;
    }

    _buildingCapacityForLabel(building) {
        const explicit = Number(building?.visitCapacity);
        if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.floor(explicit));
        const capacity = building?.capacity;
        if (capacity && typeof capacity === 'object') {
            const work = Number(capacity.work);
            if (Number.isFinite(work) && work > 0) return Math.max(1, Math.floor(work));
        }
        return Array.isArray(building?.visitTiles)
            ? Math.max(1, Math.min(6, building.visitTiles.filter((tile) => !tile.overflow || tile.role === 'work').length))
            : 0;
    }

    _buildingOccupancyInfo(building, { alert = false } = {}) {
        const presence = this._presenceByType.get(building?.type) || {};
        const count = Math.max(this._visitorCountFor(building), Number(presence.count) || 0);
        const capacity = this._buildingCapacityForLabel(building);
        const state = getBuildingOccupancyState(building?.type, { count, capacity, alert });
        return {
            count,
            capacity,
            state,
            ratio: capacity > 0 ? clamp01(count / capacity) : 0,
        };
    }
    // ── 4.1 / 4.2 — explicit building inspection ────────────────────────────

    // The sessions a selected building can present: everything the building
    // panel counts as assigned here, plus everyone physically inside it. This
    // is the same set the 1.8 instrument reads, so the aperture header and the
    // panel can never disagree.
    _inspectionSessions(type, now) {
        const sessions = [];
        const seen = new Set();
        for (const sprite of this.agentSprites || []) {
            const agent = sprite?.agent;
            if (!agent?.id || seen.has(agent.id) || agent.isDeparted) continue;
            const assigned = String(
                agent.targetBuildingType || agent.lastKnownBuildingType || agent.buildingType || agent.building || '',
            ).trim() === type;
            const visiting = sprite._foldBuildingType === type;
            if (!assigned && !visiting) continue;
            seen.add(agent.id);
            const observation = sprite.observation || resolveObservation(agent, now);
            sessions.push({
                agentId: agent.id,
                name: agent.displayName || agent.name || agent.id,
                tool: compactToolLabel(agent.currentTool),
                status: agent.status,
                observation,
                visiting,
                // A waiting session is not a failed bulb, and a stale one is
                // not a finished one: both keep their identity, neither claims
                // new work (C1).
                working: isWorkingVisitor(agent, {
                    building: type,
                    intent: sprite._lastIntentSnapshot,
                    role: sprite.visitRole,
                }),
                stale: observation?.state === 'stale',
                waiting: agent.status === AgentStatus.WAITING_ON_USER || agent.status === AgentStatus.WAITING,
            });
        }
        return sessions.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
    }

    _updateInspection() {
        const type = this._selectedBuildingType;
        this._apertureModel = null;
        this._apertureProfile = null;
        if (!type) return;

        const aperture = getBuildingApertureProfile(type);
        if (!aperture) return;
        const sessions = this._inspectionSessions(type, Date.now());

        const minZoom = Number.isFinite(aperture.minZoom) ? aperture.minZoom : APERTURE_MIN_ZOOM;
        if ((this._zoom || 0) < minZoom) return;
        const capacity = aperture.slots.length;
        const { assignment } = assignRoomSlots({
            previous: this._deskAssignments.get(type),
            workingIds: sessions.map((session) => session.agentId),
            rooms: capacity,
        });
        this._deskAssignments.set(type, assignment);
        const seated = sessions
            .filter((session) => assignment.has(session.agentId))
            .sort((a, b) => assignment.get(a.agentId) - assignment.get(b.agentId));
        const standing = sessions.filter((session) => !assignment.has(session.agentId));
        this._apertureProfile = aperture;
        this._apertureModel = buildApertureModel({
            buildingType: type,
            capacity,
            sessions: [...seated, ...standing],
        });
    }

    // C4 — the aperture record other surfaces may read. Null whenever the
    // aperture is closed.
    getApertureModel() {
        return this._apertureModel;
    }

    _openApertureFor(building) {
        if (!this._apertureModel || !this._apertureProfile) return null;
        if (building?.type !== this._apertureModel.buildingType) return null;
        return { model: this._apertureModel, profile: this._apertureProfile };
    }

    // 4.2 / 6.3 — the room-count instrument is night-only and selection-only;
    // it reads the same room slots that light the glass.
    _roomInstrumentFor(building) {
        const type = building?.type;
        if (!type || type !== this._selectedBuildingType) return null;
        const profile = getBuildingRoomProfile(type);
        const state = this._roomSlotsByType.get(type);
        if (!profile || !state) return null;
        return this._nightWindowGate() > 0 ? { ...state, profile } : null;
    }

    _spriteForAgent(agentId) {
        for (const sprite of this.agentSprites || []) {
            if (sprite?.agent?.id === agentId) return sprite;
        }
        return null;
    }

    // The authored sectional view. Fixed order, identical in Canvas and in the
    // resident renderer (both reach this through the shared functional-overlay
    // pass): cut and room shell, the presented occupants, the desks that
    // occlude their legs, their marks, then the near frame.
    _drawInspectionAperture(ctx, building, entry, wx, wy, open) {
        const { model, profile } = open;
        const [baseAx, baseAy] = this.assets.getAnchor(entry.id);
        const localPoint = (lx, ly) => ({ x: Math.round(wx - baseAx + lx), y: Math.round(wy - baseAy + ly) });
        const layer = (name) => {
            const id = `${entry.id}.${name}`;
            if (!this.assets.get(id)) return;
            this.sprites.drawSprite(ctx, id, wx, wy, { anchor: [baseAx, baseAy] });
        };
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        layer(profile.layers[0]);
        const occupantHeight = Math.max(8, Math.round(profile.occupant?.h || 26));
        model.slots.forEach((slot, index) => {
            const anchor = profile.slots[index]?.at;
            if (!anchor) return;
            this._drawApertureOccupant(ctx, localPoint(anchor[0], anchor[1]), slot, occupantHeight);
        });
        layer(profile.layers[1]);
        model.slots.forEach((slot, index) => {
            const anchor = profile.slots[index]?.at;
            if (!anchor) return;
            this._drawApertureSlotMark(ctx, localPoint(anchor[0], anchor[1]), slot);
        });
        layer(profile.layers[2]);
        this._drawApertureLegend(ctx, localPoint, building, model, profile);
        ctx.restore();
    }

    // The occupant is drawn from its own composited sheet, so it is the same
    // body the operator sees outside — a presentation crop at the desk, never a
    // second sprite with a position of its own. `height` is the authored body
    // height for this room (4.1): the room is a full storey and a person in it
    // fills about two thirds of it, which is what makes the occupants readable
    // at zoom 2 instead of a row of specks.
    _drawApertureOccupant(ctx, point, slot, height = 26) {
        const sprite = this._spriteForAgent(slot.agentId);
        const cell = sprite?.currentPoseCell?.() || sprite?.spriteSheet?.cell?.('idle', 0, 0) || null;
        const canvas = cell?.canvas || sprite?.spriteCanvas || null;
        if (!cell || !canvas) {
            // No sheet resident yet: a plain slate figure, never an invented
            // identity.
            ctx.fillStyle = 'rgba(158, 150, 164, 0.9)';
            ctx.fillRect(point.x - Math.round(height / 5), point.y - height, Math.max(4, Math.round(height / 2.5)), height);
            return;
        }
        const sx = cell.sx + Math.round(cell.sw * 0.28);
        const sy = cell.sy + Math.round(cell.sh * 0.16);
        const sw = Math.round(cell.sw * 0.44);
        const sh = Math.round(cell.sh * 0.74);
        const dh = Math.max(10, height);
        const dw = Math.max(6, Math.round((sw * dh) / Math.max(1, sh)));
        ctx.globalAlpha = slot.observation?.state === 'stale' ? 0.72 : 1;
        ctx.drawImage(canvas, sx, sy, sw, sh, point.x - Math.round(dw / 2), point.y - dh, dw, dh);
        ctx.globalAlpha = 1;
    }

    // One status pip per desk and, for an unfresh observation, the 1.1 seal.
    // No outcome is claimed here: the pip is the reported status, nothing more.
    _drawApertureSlotMark(ctx, point, slot) {
        const visual = STATUS_VISUALS[slot.status] || null;
        ctx.fillStyle = 'rgba(16, 12, 18, 0.85)';
        ctx.fillRect(point.x - 4, point.y + 1, 8, 3);
        ctx.fillStyle = visual?.color || '#c9c2cf';
        ctx.fillRect(point.x - 3, point.y + 2, 6, 1);
        if (slot.observation?.state === 'fresh') return;
        // Cut-corner slate seal (C5): the observation is old, the desk is not.
        const sealX = point.x + 4;
        const sealY = point.y - 16;
        ctx.fillStyle = 'rgba(206, 202, 214, 0.92)';
        ctx.fillRect(sealX, sealY + 1, 4, 4);
        ctx.fillStyle = 'rgba(38, 32, 42, 0.92)';
        ctx.fillRect(sealX + 3, sealY + 1, 1, 1);
    }

    // The legend names what the room shows: the same working/waiting counts
    // the 4.2 rooms use, one row per presented session with its current tool,
    // and an exact `+N more`. Counts, never percentages.
    _drawApertureLegend(ctx, localPoint, building, model, profile) {
        const legend = profile.legend;
        if (!legend?.at) return;
        const rooms = this._roomSlotsByType.get(model.buildingType);
        const working = rooms ? rooms.working : 0;
        const waiting = rooms ? rooms.waiting : 0;
        const rows = [`${working} working · ${waiting} waiting`];
        for (const slot of model.slots) {
            rows.push(slot.tool ? `${slot.name} · ${slot.tool}` : slot.name);
        }
        if (model.overflow > 0) rows.push(`+${model.overflow} more`);
        if (!model.slots.length) rows.push('No assigned sessions');
        // 5.4 — screen-fixed 11 px rows from the authored anchor, so the
        // legend reads at every zoom without world-scaled text.
        const origin = localPoint(legend.at[0], legend.at[1]);
        const zoom = this._zoom > 0 ? this._zoom : 1;
        ctx.save();
        ctx.translate(origin.x, origin.y);
        ctx.scale(1 / zoom, 1 / zoom);
        snapScreenOrigin(ctx);
        ctx.font = WORLD_BODY_FONT_11;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const width = rows.reduce((max, text) => Math.max(max, measureLabelText(ctx, text)), 0) + 8;
        const height = rows.length * 12 + 4;
        ctx.fillStyle = LABEL_INK.plateOutline;
        ctx.fillRect(-1, -1, width + 2, height + 2);
        ctx.fillStyle = LABEL_INK.plate;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = LABEL_INK.brass;
        ctx.fillRect(0, 0, width, 1);
        rows.forEach((text, index) => {
            ctx.fillStyle = index === 0 ? '#f6c85f' : LABEL_INK.text;
            ctx.fillText(text, 4, 11 + index * 12);
        });
        ctx.restore();
    }

    // 4.2 / 6.3 — the exact counts beside the rooms. A room the art does not
    // have is never invented: the surplus is the overflow number, and waiting
    // occupants are counted, never lit.
    _drawRoomCount(ctx, localPoint, shouldDrawLocalY, state) {
        const at = state.profile.countAt;
        if (!Array.isArray(at) || !shouldDrawLocalY(at[1])) return;
        const point = localPoint(at[0], at[1]);
        const overflow = state.overflow > 0 ? ` · +${state.overflow} more` : '';
        const text = `${state.working} working · ${state.waiting} waiting${overflow}`;
        this._drawInstrumentPlate(ctx, point.x, point.y, text, { color: '#e8e4ec' });
    }

    // 4.6 — the canonical sleeping town. Only READY_EMPTY earns it, and only
    // while the village really is empty of sprites.
    _villageAtRest() {
        // The reducer emits `village:state` on each dispatch, and the first
        // dispatch can land before this renderer exists, so until an event
        // arrives the shell's own current phase is read directly. Either way
        // the phase is the canonical one from VillageState, never a guess from
        // an empty sprite list — and the sprite list still has to agree.
        const phase = this._villagePhase
            ?? (typeof window !== 'undefined' ? window.__claudeVilleApp?.villageState?.phase : null)
            ?? null;
        return phase === VillagePhase.READY_EMPTY && !(this.agentSprites?.length);
    }

    // 4.6 — the banked mouth. The hearth fire is painted into base.png, so rest
    // lays the authored `banked.png` mask over exactly those pixels: stepped
    // charcoal over one ember course. A workshop between shifts, not a dead one.
    _drawForgeBankedMouth(ctx, entry, wx, wy) {
        const name = getBuildingRestLayer('forge');
        if (!name) return;
        const id = `${entry.id}.${name}`;
        if (!this.assets.get(id)) return;
        const anchor = this.assets.getAnchor(entry.id);
        this.sprites.drawSprite(ctx, id, wx, wy, { anchor });
    }

    // 4.6 — the slate between shifts: the authored rack with nothing pinned to
    // it, instead of the last run's papers left hanging as phantom work.
    _drawTaskboardEmptyRack(ctx, localPoint) {
        this._drawOnTaskboardSlate(ctx, localPoint, 'empty-rack', (slateCtx, origin) => {
            const { w, h } = TASKBOARD_SLATE;
            const railY = origin.y + Math.round(h * 0.34);
            slateCtx.save();
            slateCtx.globalCompositeOperation = 'source-over';
            slateCtx.fillStyle = 'rgba(24, 28, 26, 0.55)';
            slateCtx.fillRect(origin.x + 4, origin.y + 4, w - 8, h - 8);
            slateCtx.fillStyle = 'rgba(120, 104, 74, 0.85)';
            slateCtx.fillRect(origin.x + 8, railY, w - 16, 1);
            slateCtx.fillStyle = 'rgba(196, 178, 132, 0.9)';
            for (let i = 0; i < 3; i++) {
                const x = origin.x + 14 + i * Math.round((w - 28) / 2);
                slateCtx.fillRect(x, railY - 2, 2, 3);
            }
            slateCtx.restore();
        });
    }

    _buildingActivityInfo(building, { alert = this._buildingAlertFor(building) } = {}) {
        const type = building?.type || '';
        const occupancy = this._buildingOccupancyInfo(building, { alert });
        const presence = this._presenceByType.get(type) || {};
        const recency = clamp01(presence.recencyScore || 0);
        let ritualFade = 0;
        for (const ritual of this._ritualsFor(type)) {
            ritualFade = Math.max(ritualFade, this._ritualFade(ritual));
        }

        const stateWeight = BUILDING_ACTIVITY_STATE_WEIGHT[occupancy.state] || 0;
        let intensity = Math.max(stateWeight, recency * 0.48, ritualFade * 0.9);

        if (type === 'forge') {
            const forgeHeat = clamp01((this._forgeGlowIntensity() - FORGE_GLOW_BASELINE) / (1 - FORGE_GLOW_BASELINE));
            intensity = Math.max(intensity, forgeHeat * 0.85);
        } else if (type === 'mine') {
            const quotaPressure = this._quotaFiveHourRatio();
            const pressureBoost = quotaPressure > 0.42 ? 0.22 + (quotaPressure - 0.42) * 1.05 : 0;
            intensity = Math.max(intensity, pressureBoost);
        } else if (type === 'archive') {
            intensity = Math.max(intensity, (this._archiveReadIntensity || 0) * 0.82);
        } else if (type === 'command') {
            intensity = Math.max(intensity, Math.min(0.82, this._watchtowerActiveCount() / 6 * 0.72));
        } else if (type === 'harbor') {
            const harborWork = Math.min(0.74, this._watchtowerActiveCount() / 6 * 0.56);
            intensity = Math.max(intensity, harborWork + (alert ? 0.24 : 0));
        } else if (type === 'watchtower') {
            const watchWork = Math.min(1, this._watchtowerActiveCount() / 5);
            intensity = Math.max(intensity, watchWork + (this.harborStatus?.failedPushActive ? 0.36 : 0));
        }

        return {
            alert,
            intensity: clamp01(intensity),
            occupancy,
            overload: occupancy.capacity > 0 ? Math.max(0, occupancy.count - occupancy.capacity) : 0,
            presence,
            recency,
            ritualFade,
        };
    }

    _drawActivityDiamond(ctx, x, y, radius, fillStyle, strokeStyle = null) {
        ctx.fillStyle = fillStyle;
        if (strokeStyle) ctx.strokeStyle = strokeStyle;
        ctx.beginPath();
        ctx.moveTo(x, y - radius);
        ctx.lineTo(x + radius, y);
        ctx.lineTo(x, y + radius);
        ctx.lineTo(x - radius, y);
        ctx.closePath();
        ctx.fill();
        if (strokeStyle) ctx.stroke();
    }

    groundingDiagnostics() {
        return this.buildings.map((building) => {
            const id = `building.${building.type}`;
            const entry = this.assets.getEntry(id);
            const dims = this.assets.getDims(id);
            const anchor = this.assets.getAnchor(id);
            const center = this._buildingScreenCenter(building);
            const grounding = getBuildingVisual(building.type)?.grounding || null;
            const left = dims ? center.x - anchor[0] : center.x;
            const top = dims ? center.y - anchor[1] : center.y;
            return {
                type: building.type,
                mode: grounding?.mode || null,
                center: { ...center },
                footprint: this._buildingFootprintCorners(building),
                entrance: building.entrance ? this._tileToScreen(building.entrance.tileX, building.entrance.tileY) : null,
                sprite: dims ? { left, top, width: dims.w, height: dims.h } : null,
                anchor: { x: center.x, y: center.y, localX: anchor[0], localY: anchor[1] },
                horizonY: Number.isFinite(entry?.horizonY) ? top + entry.horizonY : null,
                contact: grounding?.contact ? {
                    x: center.x + (grounding.contact.offsetX || 0),
                    y: center.y + (grounding.contact.offsetY || 0),
                    width: grounding.contact.width || 0,
                    depth: grounding.contact.depth || 0,
                } : null,
            };
        });
    }

    drawGroundingDebug(ctx) {
        ctx.save();
        ctx.font = WORLD_BODY_FONT_11;
        ctx.textBaseline = 'bottom';
        for (const item of this.groundingDiagnostics()) {
            const { center, footprint, entrance, sprite, contact } = item;
            ctx.globalAlpha = 0.94;
            ctx.strokeStyle = '#00e5ff';
            ctx.lineWidth = 1.4;
            this._traceFootprint(ctx, footprint);
            ctx.stroke();

            if (sprite) {
                ctx.globalAlpha = 0.72;
                ctx.strokeStyle = '#ec6cff';
                ctx.lineWidth = 1;
                ctx.strokeRect(sprite.left + 0.5, sprite.top + 0.5, sprite.width - 1, sprite.height - 1);
            }
            if (Number.isFinite(item.horizonY) && sprite) {
                ctx.strokeStyle = '#ffe066';
                ctx.beginPath();
                ctx.moveTo(sprite.left, item.horizonY + 0.5);
                ctx.lineTo(sprite.left + sprite.width, item.horizonY + 0.5);
                ctx.stroke();
            }
            if (contact?.width > 0 && contact?.depth > 0) {
                ctx.strokeStyle = '#ff6e5f';
                ctx.beginPath();
                ctx.ellipse(contact.x, contact.y, contact.width / 2, contact.depth / 2, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(Math.round(center.x) - 3, Math.round(center.y), 7, 1);
            ctx.fillRect(Math.round(center.x), Math.round(center.y) - 3, 1, 7);
            if (entrance) {
                ctx.fillStyle = '#7cff6b';
                ctx.fillRect(Math.round(entrance.x) - 3, Math.round(entrance.y) - 3, 6, 6);
                ctx.strokeStyle = 'rgba(124, 255, 107, 0.72)';
                ctx.beginPath();
                ctx.moveTo(entrance.x, entrance.y);
                ctx.lineTo(center.x, center.y);
                ctx.stroke();
            }
            const labelX = sprite?.left ?? center.x;
            const labelY = sprite?.top ?? center.y;
            const label = `${item.type} · ${item.mode || 'missing'}`;
            const width = ctx.measureText(label).width + 6;
            ctx.fillStyle = 'rgba(18, 22, 29, 0.88)';
            ctx.fillRect(labelX, labelY - 14, width, 13);
            ctx.fillStyle = '#d8f7ff';
            ctx.fillText(label, labelX + 3, labelY - 3);
        }
        ctx.restore();
    }

    _buildingFootprintCorners(building) {
        const x0 = building.position.tileX;
        const y0 = building.position.tileY;
        const x1 = x0 + building.width;
        const y1 = y0 + building.height;
        return {
            nw: this._tileToScreen(x0, y0),
            ne: this._tileToScreen(x1, y0),
            se: this._tileToScreen(x1, y1),
            sw: this._tileToScreen(x0, y1),
        };
    }

    _traceFootprint(ctx, corners) {
        ctx.beginPath();
        ctx.moveTo(corners.nw.x, corners.nw.y);
        ctx.lineTo(corners.ne.x, corners.ne.y);
        ctx.lineTo(corners.se.x, corners.se.y);
        ctx.lineTo(corners.sw.x, corners.sw.y);
        ctx.closePath();
    }

    _buildingFrontSortY(building, fallbackY) {
        const anchorY = this._anchorSortY(building);
        return Number.isFinite(anchorY) ? Math.max(fallbackY, anchorY - 0.5) : fallbackY;
    }

    _buildingWholeSortY(building, fallbackY) {
        const anchorY = this._anchorSortY(building);
        return Number.isFinite(anchorY) ? anchorY - 0.5 : fallbackY;
    }

    // Depth anchor for building drawables. The minimum visit-tile screen-y
    // ensures every declared visit tile draws in front; clamping by the
    // southeast footprint corner restores standard isometric occlusion when
    // visit tiles sit south of the corner (mine, taskboard, portal, etc.) so
    // characters at the SE edge are no longer covered by the building.
    _anchorSortY(building) {
        const tiles = Array.isArray(building?.visitTiles) ? building.visitTiles : [];
        let minY = Infinity;
        for (const tile of tiles) {
            if (!Number.isFinite(tile?.tileX) || !Number.isFinite(tile?.tileY)) continue;
            const y = this._tileToScreen(tile.tileX, tile.tileY).y;
            if (y < minY) minY = y;
        }
        if (!Number.isFinite(minY) && building?.entrance) {
            const { tileX, tileY } = building.entrance;
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) {
                minY = this._tileToScreen(tileX, tileY).y;
            }
        }
        if (!Number.isFinite(minY)) return null;
        const pos = building?.position;
        if (pos
            && Number.isFinite(pos.tileX)
            && Number.isFinite(pos.tileY)
            && Number.isFinite(building.width)
            && Number.isFinite(building.height)) {
            const seX = pos.tileX + building.width - 1;
            const seY = pos.tileY + building.height - 1;
            return Math.min(minY, this._tileToScreen(seX, seY).y);
        }
        return minY;
    }

    _tileToScreen(tileX, tileY) {
        return tileToWorld(tileX, tileY);
    }

    _buildingScreenCenter(b) {
        return buildingCenterToWorld(b);
    }

    _harborLedgerRows(repos = []) {
        const active = (Array.isArray(repos) ? repos : [])
            .filter((repo) => Number(repo?.pendingCommits) > 0)
            .sort((a, b) => (Number(b.pendingCommits) - Number(a.pendingCommits))
                || String(a.repoName || a.shortName || '').localeCompare(String(b.repoName || b.shortName || '')));
        if (!active.length) return [];
        const visible = active.slice(0, 3).map((repo) => {
            const name = String(repo.shortName || repo.repoName || repo.project || 'Repo')
                .replace(/[-_]+/g, ' ')
                .replace(/\b\w/g, (char) => char.toUpperCase());
            return {
                label: `${name} (${Number(repo.pendingCommits)})`,
                color: repo.profile?.labelText || repo.profile?.accent || '#f6d384',
                profile: repo.profile || null,
            };
        });
        const remaining = active.length - visible.length;
        if (remaining > 0 && visible.length) {
            visible[visible.length - 1] = {
                ...visible[visible.length - 1],
                label: `${visible[visible.length - 1].label} +${remaining}`,
            };
        }
        return visible;
    }

    // W7.5 — muster rows for the Command plaque: the parent's name in its
    // repo ink behind the repo swatch, then the exact `· out ▸ returned`.
    _musterRows(squads = []) {
        return squadMusterLines(squads, { maxRows: PLAQUE_MUSTER_MAX_ROWS }).map((line) => {
            if (line.kind === 'more') return { label: line.text, color: WALNUT.text };
            const profile = line.project ? repoProfile(line.project) : null;
            return {
                label: line.name,
                color: profile?.labelText || profile?.accent || WALNUT.count,
                profile,
                muster: { out: line.out, returned: line.returned },
            };
        });
    }

    _labelTextFor(building, zoom, isHovered) {
        const label = this._resolveBuildingLabelText(building);
        if (zoom >= LABEL_DETAIL_ZOOM) return label;
        const short = LABEL_SHORT_TEXT[building.type];
        if (short) return short;
        const words = label.split(/\s+/).filter(Boolean);
        if (words.length === 1) return label;
        if (words.length === 2) return words.join(' ');
        return `${words[0]} ${words[1]}`;
    }

    _resolveBuildingLabelText(building) {
        const explicit = String(building.label || '').trim();
        if (explicit) return explicit.toUpperCase();
        const short = LABEL_SHORT_TEXT[building.type];
        if (short) return short.toUpperCase();
        if (!building.type) return '';
        const tokenized = String(building.type).replace(/[_-]/g, ' ');
        return tokenized
            .split(/\s+/)
            .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    _labelMetrics(ctx, building, {
        text,
        labelFont,
        maxTextWidth,
        zoom,
        isHovered,
        isLandmark,
        scaleMode = 'screen-fixed',
    }) {
        const zoomBucket = zoom >= LABEL_DETAIL_ZOOM ? 'detail' : zoom >= LABEL_VISIBLE_ZOOM ? 'mid' : 'far';
        const key = `${building.type}|${text}|${labelFont}|${maxTextWidth}|${zoomBucket}|${scaleMode}|${isHovered ? 1 : 0}|${isLandmark ? 1 : 0}`;
        const cached = this._labelMetricsCache.get(key);
        if (cached) return cached;

        let displayText = text;
        if (ctx.measureText(displayText).width > maxTextWidth) {
            while (displayText.length > 1 && ctx.measureText(`${displayText}…`).width > maxTextWidth) {
                displayText = displayText.slice(0, -1);
            }
            if (displayText.length < text.length) {
                displayText = `${displayText}…`;
            }
        }
        const metrics = {
            displayText,
            width: ctx.measureText(displayText).width,
        };
        this._labelMetricsCache.set(key, metrics);
        return metrics;
    }

    _boxesOverlap(a, b) {
        return a.left < b.right
            && a.right > b.left
            && a.top < b.bottom
            && a.bottom > b.top;
    }

    _boxesOverlapRatio(box, boxes) {
        if (!boxes || boxes.length === 0) return 0;
        const boxArea = Math.max(0, (box.right - box.left) * (box.bottom - box.top));
        if (boxArea === 0) return 0;

        let overlapArea = 0;
        for (const other of boxes) {
            const overlapLeft = Math.max(box.left, other.left);
            const overlapTop = Math.max(box.top, other.top);
            const overlapRight = Math.min(box.right, other.right);
            const overlapBottom = Math.min(box.bottom, other.bottom);
            const overlapWidth = overlapRight - overlapLeft;
            const overlapHeight = overlapBottom - overlapTop;
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            overlapArea += overlapWidth * overlapHeight;
        }

        return Math.min(1, overlapArea / boxArea);
    }

    _boxesMaxOverlapRatio(box, boxes) {
        if (!boxes || boxes.length === 0) return 0;
        const boxArea = Math.max(0, (box.right - box.left) * (box.bottom - box.top));
        if (boxArea === 0) return 0;

        let maxOverlap = 0;
        for (const other of boxes) {
            const overlapLeft = Math.max(box.left, other.left);
            const overlapTop = Math.max(box.top, other.top);
            const overlapRight = Math.min(box.right, other.right);
            const overlapBottom = Math.min(box.bottom, other.bottom);
            const overlapWidth = overlapRight - overlapLeft;
            const overlapHeight = overlapBottom - overlapTop;
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            maxOverlap = Math.max(maxOverlap, (overlapWidth * overlapHeight) / boxArea);
        }

        return Math.min(1, maxOverlap);
    }

    _estimateLocalLabelDensity(occupiedBoxes, centerX, centerY) {
        if (!occupiedBoxes.length) return 0;
        const radius = 95;
        const radiusSq = radius * radius;
        let nearby = 0;

        for (const box of occupiedBoxes) {
            const cx = (box.left + box.right) / 2;
            const cy = (box.top + box.bottom) / 2;
            const dx = cx - centerX;
            const dy = cy - centerY;
            if (dx * dx + dy * dy <= radiusSq) {
                nearby++;
            }
        }

        return nearby;
    }
}
