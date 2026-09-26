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
import { drawPixelFlame, fillPixelEllipse, strokePixelEllipse } from './PixelShapes.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { BUILDING_EVENTS, eventBus } from '../../domain/events/DomainEvent.js';
import { classifyTool, toolVerbLabel } from '../../domain/services/ToolIdentity.js';
import { repoProfile } from '../shared/RepoColor.js';
import { normalizeLightSource } from './LightSourceRegistry.js';
import { normalizeLightingState, smokeWindDrift, sourceEnergyFor } from './AtmosphereState.js';
import { castLightingFor, structureCast } from './RakingLight.js';
import { PARTICLE_LAYER_AIR } from './ParticleSystem.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { buildingCenterToWorld, tileToWorld, worldToTile } from './Projection.js';
import {
    TaskboardBoardModel,
    taskboardBoardLayout,
} from './TaskboardBoardModel.js';
import {
    advanceNightOccupancyGate,
    buildingEmissiveGate,
    lightsBuildingWindows,
    nightWindowGate,
} from './NightOccupancyGate.js';
import {
    BUILDING_EMITTER_FALLBACKS,
    BUILDING_LIGHT_FALLBACKS,
    EMITTER_LIGHTS,
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
import { resolveObservation } from './ObservationCertainty.js';
import { VillagePhase } from '../../application/VillageState.js';
import { dottedCurve, ellipseArcDots, fillConvex, gradeTone, pixelLine, ringDots, snap } from './EffectStamps.js';

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
// 12-row ledger lines (harbor commits, READ verbs).
const PLAQUE_PAD = 5;
const PLAQUE_HEAD_H = 17;
const PLAQUE_ROW_H = 12;
const DISTRICT_MOTIFS = Object.freeze(Object.fromEntries(
    BUILDING_DEFS
        .map((building) => [building.type, `district-${building.type}`])
        .filter(([, motif]) => Boolean(EVENT_SHAPES[motif])),
));
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
// shaded hem]. Albedo, so they take the C2 grade on the overlay.
const HARBOR_SIGNAL_PENNANTS = Object.freeze([
    [-18, '#f2d36b', '#8f7a3e'],
    [-8, '#5bc0c9', '#356f74'],
    [2, '#c23f36', '#71251f'],
]);
// #17 — the searchlight's stepped courses: [from, to] along the beam and the
// alpha quantum each carries (C4's 1 / .66 / .33 steps, no gradient).
const SEARCHLIGHT_COURSES = Object.freeze([
    [0, 0.34, 1],
    [0.34, 0.68, 0.66],
    [0.68, 1, 0.33],
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
// #17 — Pharos searchlight: rotating distress beam pivot/length/width.
const WATCHTOWER_SEARCHLIGHT = Object.freeze(getBuildingEffectAnchor('watchtower', 'searchlight', {
    pivot: [200, 68],
    length: 320,
    width: 58,
}));
// Sweep angular velocity (rad/s) scales from calm→distressed across this range.
const SEARCHLIGHT_SPIN_CALM_RAD_PER_S = 0.45;
const SEARCHLIGHT_SPIN_DISTRESS_RAD_PER_S = 1.7;
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
// Presence tier -> (emitter chance ×, light radius ×, occupancy scalar 0..1).
// Occupancy feeds window warmth via 0.45 + 0.55 * scalar.
const PRESENCE_TIER_TABLE = Object.freeze({
    dormant:  { emitter: 0.3, radius: 0.85, occupancy: 0 },
    occupied: { emitter: 1.0, radius: 1.0, occupancy: 0.7 },
    busy:     { emitter: 1.6, radius: 1.15, occupancy: 1 },
});
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
// #53 — occupancy pennant cloth metrics (world px at zoom 1).
const PENNANT_POLE_PX = 18;
const PENNANT_FLY_PX = 18;
const PENNANT_DROP_PX = 10;
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
        // #17 — watchtower searchlight sweep angle (rad), advanced in update().
        this._watchtowerSearchlightAngle = -0.34;
        // #40 — transient beam flare (0..1) kicked when an agent newly storms the
        // Pharos (errored/rate-limited); decays in _updateWatchtowerSearchlight so
        // the beam pulses brighter as a fresh incident arrives, then settles back
        // to the steady fleet-distress level. Held flat under reduced motion.
        this._watchtowerFlare = 0;
        this._onDistress = (event) => {
            if (event?.kind === 'recovered') return;
            this._watchtowerFlare = 1;
        };
        eventBus.on('distress:watchtower', this._onDistress);
        // 4.1/4.2 — explicit building inspection. Selection is the only way in;
        // nothing here changes the default frame, the exterior sprite, the hit
        // target, or any domain position.
        this._selectedBuildingType = null;
        this._apertureModel = null;
        this._apertureProfile = null;
        // agentId -> desk index and agentId -> room index, per building type.
        // Sticky, so a session keeps its desk and a worker keeps its window
        // until it stops qualifying: leaving work must extinguish exactly one
        // room, never reshuffle the row.
        this._deskAssignments = new Map();
        this._roomAssignments = new Map();
        this._roomStateByType = new Map();
        this._onBuildingSelected = (building) => {
            const type = building?.type || null;
            if (type === this._selectedBuildingType) return;
            this._selectedBuildingType = type;
            this._deskAssignments.clear();
            this._roomAssignments.clear();
            this._roomStateByType.clear();
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
        eventBus.off('distress:watchtower', this._onDistress);
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

    _presenceTierFor(type) {
        return this._presenceByType.get(type)?.tier || 'dormant';
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

    _taskboardBoardAgent() {
        return this._taskboardBoardModel.resolve({
            candidates: this._taskboardCandidates || [],
            agentSprites: this.agentSprites,
        });
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
        this._updateInspection();
        this._updateNightLightGates(dt);
        this._emitVillagePopulation();
        this._trackObservatoryWebRituals();
        this._syncTaskboardPapers(Date.now());
        this._updateForgeGlow(dt);
        this._updateObservatoryClockSpin(dt);
        this._updateWatchtowerSearchlight(dt);
        for (const b of this.buildings) this._spawnEmittersFor(b, dt);
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
                layer: PARTICLE_LAYER_AIR,
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

    // #17 — Fleet distress barometer (0..1): share of the fleet that is errored
    // or rate-limited, with a floor while a push has failed at the harbor. Drives
    // the watchtower searchlight's sweep speed and amber→red colour shift.
    _fleetDistressRatio() {
        const sprites = this.agentSprites || [];
        let total = 0;
        let distressed = 0;
        for (const sprite of sprites) {
            const status = sprite?.agent?.status;
            if (!status) continue;
            total += 1;
            if (status === AgentStatus.ERRORED || status === AgentStatus.RATE_LIMITED) distressed += 1;
        }
        const share = total > 0 ? distressed / total : 0;
        const floor = this.harborStatus?.failedPushActive ? 0.34 : 0;
        return clamp01(Math.max(share, floor));
    }

    // Advance the searchlight sweep; angular velocity rises with fleet distress
    // so a troubled fleet visibly spins the beam faster. Held still under reduced
    // motion (the static directional wedge is drawn at the last angle instead).
    _updateWatchtowerSearchlight(dt) {
        if (!this.motionScale) return;
        const seconds = Math.max(0, Number(dt) || 0) / 1000;
        const distress = this._fleetDistressRatio();
        const rate = lerp(SEARCHLIGHT_SPIN_CALM_RAD_PER_S, SEARCHLIGHT_SPIN_DISTRESS_RAD_PER_S, distress);
        this._watchtowerSearchlightAngle = (this._watchtowerSearchlightAngle + seconds * rate) % (Math.PI * 2);
        // #40 — ease the incident flare back to rest over ~1.4s.
        if (this._watchtowerFlare > 0) {
            this._watchtowerFlare = Math.max(0, this._watchtowerFlare - seconds / 1.4);
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
    // width or the outer terrain apron.
    drawShadows(ctx) {
        // 1.5 — the same baked RakingLight cast the resident path uploads.
        const cast = castLightingFor(this.atmosphereState);
        for (const b of this.buildings) {
            const grounding = getBuildingVisual(b.type)?.grounding;
            const contact = grounding?.contact;
            const c = this._buildingScreenCenter(b);
            const isLandmark = LANDMARK_LABEL_TYPES.has(b.type);
            const isHovered = this.hovered === b;
            ctx.save();
            if (grounding?.shadow !== 'none' && contact?.width > 0 && contact?.depth > 0) {
                const baked = structureCast(b.type, grounding, contact, cast);
                if (baked) {
                    ctx.imageSmoothingEnabled = false;
                    ctx.globalAlpha = cast.alpha * (contact.opacity ?? 0.75);
                    ctx.drawImage(
                        baked.canvas,
                        Math.round(c.x + (contact.offsetX || 0) + baked.offsetX),
                        Math.round(c.y + (contact.offsetY || 0) + baked.offsetY),
                    );
                    ctx.globalAlpha = 1;
                }
            }
            this._drawBuildingActivityFootprint(ctx, b, { isLandmark, isHovered });
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
        scaleMode = 'screen-fixed',
        readMode = false,
        selectedType = null,
    } = {}) {
        const labelScale = 1 / Math.max(0.01, zoom);
        const occupied = [];
        const normalizedOccupiedBoxes = this._normalizeBoxes(occupiedBoxes);
        const harborLedgerRows = this._harborLedgerRows(harborPendingRepos);
        const plaqueCounts = this._plaqueCountsByType();
        const view = this._plaqueWorldViewport(ctx, labelScale);
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
                readRows: readMode ? this._readPlaques?.get(b.type) : null,
            });
            let chosen = null;
            for (const attempt of labelAttempts) {
                const plaque = this._measurePlaque(ctx, b, attempt, { count, zoom, isHovered, isLandmark, scaleMode });
                if (!plaque.title && !plaque.motif) continue;
                const layout = this._resolveLabelLayout({
                    candidates: this._labelLayoutCandidates(isLandmark, isHovered || isSelected).map(({ dx, dy }) => ({ dx: dx * labelScale, dy: dy * labelScale })),
                    occupied,
                    occupiedExternal: normalizedOccupiedBoxes,
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
                chosen = { plaque, layout };
                break;
            }
            if (!chosen) continue;
            // S13 — a plaque stays inside the visible world: shifted in whole
            // while its building stands in view, hidden when the building is
            // off-frame (a bare count cell at the edge would be an orphan).
            if (view && !this._placePlaqueInView(chosen, view, {
                buildingLeft: center.x - dims.w / 2,
                buildingRight: center.x + dims.w / 2,
                buildingTop: spriteTop,
                buildingBottom: center.y,
                tagW: chosen.plaque.width * labelScale,
                tagH: chosen.plaque.height * labelScale,
            })) continue;
            occupied.push(chosen.layout.box);
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
    _plaqueCountsByType() {
        const counts = this._plaqueCounts || (this._plaqueCounts = new Map());
        counts.clear();
        for (const sprite of this.agentSprites || []) {
            const agent = sprite?.agent;
            if (!agent || agent.isDeparted || sprite._archiveAnim || sprite.isArrivalPending?.()) continue;
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
        return counts;
    }

    // Plaque geometry in screen pixels (before the 1/zoom counter-scale).
    _measurePlaque(ctx, building, attempt, { count, zoom, isHovered, isLandmark, scaleMode }) {
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
        const rows = (attempt.rows || []).map(row => ({
            ...row,
            label: fitLabelText(ctx, row.label, attempt.rowMaxWidth || 180),
        }));
        const rowsWidth = rows.reduce((max, row) => Math.max(max, measureLabelText(ctx, row.label) + (row.profile ? 8 : 0)), 0);
        ctx.restore();
        const titleWidth = Math.round(title.width);
        const motifWidth = motif ? 8 + 5 : 0;
        let headWidth = PLAQUE_PAD + motifWidth + titleWidth + (titleWidth ? PLAQUE_PAD : 0);
        if (!titleWidth && motif) headWidth = PLAQUE_PAD + 8 + PLAQUE_PAD;
        const countCell = countText ? 1 + PLAQUE_PAD + countWidth + PLAQUE_PAD : 0;
        const width = Math.max(headWidth + countCell, rowsWidth + PLAQUE_PAD * 2) + 2;
        const height = PLAQUE_HEAD_H + (rows.length ? rows.length * PLAQUE_ROW_H + 3 : 0);
        return {
            motif,
            title: title.displayText,
            titleWidth,
            countText,
            headWidth,
            rows,
            width,
            height,
        };
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
        ];
    }

    _labelRenderAttempts(building, { isHovered, isLandmark, zoom, localLabelDensity = 0, harborLedgerRows = [], readRows = null }) {
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
        const attempts = [{
            text: isHarborLedger ? compactText : baseText,
            rows: isHarborLedger ? harborLedgerRows : [],
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

    _watchtowerIntensity() {
        const active = this._watchtowerActiveCount();
        const activeBoost = Math.min(1, active / 5);
        return clamp01(activeBoost + (this.harborStatus?.failedPushActive ? 0.36 : 0));
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
    getLightSources(lightingState = this.lightingState) {
        const energy = sourceEnergyFor(lightingState ?? this.atmosphereState?.lighting);
        const windowWarmth = this.atmosphereState?.reactions?.windowWarmth || 0;
        const staticSources = this._staticLightSources();
        const out = [];
        for (const source of staticSources) {
            const visitors = source.building ? this._visitorCountFor(source.building) : 0;
            let activity = visitors > 0 ? 1.12 : 1;
            let alpha = source.alpha;
            let color = source.color;
            if (source.buildingType === 'forge') {
                activity = 0.58 + this._forgeGlowIntensity() * 0.74;
            } else if (source.buildingType === 'watchtower') {
                const watchIntensity = this._watchtowerIntensity();
                activity = 1 + watchIntensity * 0.48;
                if (alpha != null) alpha *= 1 + watchIntensity * 0.65;
                if (this.harborStatus?.failedPushActive) color = '#ff755d';
            }
            const warmthBoost = source.kind === 'beam' ? 0 : windowWarmth * 0.16;
            const typeResponse = source.kind === 'beam'
                ? 1
                : 0.62 + 0.38 * getBuildingBeaconBase(source.buildingType);
            const presenceRadiusMult = source.buildingType
                ? PRESENCE_TIER_TABLE[this._presenceTierFor(source.buildingType)].radius
                : 1;
            const radius = Math.min(
                source.radius * energy.halo,
                SOURCE_HALO_RADIUS_CAP,
            ) * presenceRadiusMult;
            const emissiveGate = !source.buildingType || source.buildingType === 'watchtower'
                ? 1
                : this._emissiveGateFor(source.building);
            const intensity = (activity + warmthBoost) * typeResponse * energy.core * emissiveGate;
            if (intensity < 0.02) continue;
            if (alpha != null) alpha *= energy.core * emissiveGate;
            out.push(normalizeLightSource({
                ...source,
                color,
                intensity,
                radius,
                alpha,
                origin: source.origin || { x: source.x, y: source.y },
            }, {
                buildingType: source.buildingType,
                building: source.building,
            }));
        }
        for (const source of this._ritualLightSources(energy.core)) out.push(source);
        for (const source of this._forgeSpillLightSources(energy.core)) out.push(source);
        for (const source of this._archiveSpillLightSources(energy.core)) out.push(source);
        return out;
    }

    // Ground-spill light from the archive doorway: when reading is busy the warm
    // lamplight bleeds out the door and across the entrance steps via the
    // screen-composite light path (overlay sprite). Brightness tracks the read
    // counter (_archiveReadIntensity); flicker rides the slow building pulse and
    // holds steady under reduced motion (#12).
    _archiveSpillLightSources(coreEnergy = 1) {
        const readIntensity = this._archiveReadIntensity || 0;
        if (readIntensity <= 0.4) return [];
        const strength = clamp01((readIntensity - 0.4) / 0.6);
        const flicker = this.motionScale ? 0.9 + Math.sin(this.frame * 0.06) * 0.1 : 0.9;
        const sources = [];
        for (const building of this.buildings) {
            if (building.type !== 'archive') continue;
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
                intensity: 0.6 + strength * 0.9,
                alpha: (0.18 + strength * 0.30) * flicker * coreEnergy,
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
    // screen-composite light path. Brightness tracks _forgeGlow (#11).
    _forgeSpillLightSources(coreEnergy = 1) {
        const night = clamp01(this.atmosphereState?.reactions?.nightReflection ?? 0);
        const heat = clamp01((this._forgeGlowIntensity() - FORGE_GLOW_BASELINE) / (1 - FORGE_GLOW_BASELINE));
        const strength = night * heat;
        if (strength <= 0.05) return [];
        const flicker = this.motionScale ? 0.9 + Math.sin(this.frame * 0.07) * 0.1 : 0.9;
        const sources = [];
        for (const building of this.buildings) {
            if (building.type !== 'forge') continue;
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
                alpha: strength * 0.4 * flicker * coreEnergy,
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

    _staticLightSources() {
        if (this._lightSourcesCache) return this._lightSourcesCache;
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            const c = this._buildingScreenCenter(b);
            const seen = new Set();
            const pushSource = (source) => {
                if (!source?.at) return;
                const baseAnchor = this.assets.getAnchor(entry?.id || `building.${b.type}`);
                const [lx, ly] = source.at;
                const key = `${source.kind || 'point'}|${Math.round(lx)},${Math.round(ly)}|${source.overlay || ''}`;
                if (seen.has(key)) return;
                seen.add(key);
                const origin = {
                    x: c.x - baseAnchor[0] + lx,
                    y: c.y - baseAnchor[1] + ly,
                };
                out.push(normalizeLightSource({
                    id: source.id || `building.${b.type}.${source.kind || 'point'}.${Math.round(lx)}.${Math.round(ly)}`,
                    origin,
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
                pushSource({
                    at: b.type === 'watchtower' ? WATCHTOWER_LANTERN_FIRE.light : entry.lightSource,
                    color: entry.lightColor || 'rgba(255,210,140,0.4)',
                    radius: entry.lightRadius || 64,
                    overlay: entry.lightOverlay || 'atmosphere.light.lantern-glow',
                });
            }
            for (const source of LIGHT_SOURCE_REGISTRY[b.type] || []) {
                pushSource(source);
            }
            if (entry?.emitters) {
                for (const [name, at] of Object.entries(entry.emitters)) {
                    const baseName = name.replace(/\d+$/, '');
                    const light = EMITTER_LIGHTS[baseName] || EMITTER_LIGHTS[name];
                    if (light) pushSource({ ...light, at });
                }
            }
            const fallback = BUILDING_LIGHT_FALLBACKS[b.type];
            if (fallback) {
                pushSource(fallback);
            }
        }
        this._lightSourcesCache = out;
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
            this.sprites.drawSprite(ctx, id, d.wx, d.wy);
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
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'back', d.horizonY);
            } else {
                ctx.drawImage(img, 0, d.horizonY, dims.w, dims.h - d.horizonY,
                                   dx, dy + d.horizonY, dims.w, dims.h - d.horizonY);
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
        }
    }

    // #53 — occupancy pennant: hero buildings fly a small roofline standard
    // tinted by the dominant occupant repo (guild-territory read). Idle
    // buildings fly nothing; busy/full stream a second tail; alert tints the
    // cloth to the alert red. AMBIENT under the mark governor (banners are the
    // doc-comment example of that tier). The wave rides the slow band; reduced
    // motion flies a static pennant.
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
                : 'rgba(92, 66, 32, 1)';
        const busy = occupancy.state === 'busy' || occupancy.state === 'full' || alert;
        const seed = hashText(`${building.type}|pennant`);
        const wave = this.motionScale ? Math.sin(this.frame * 0.055 + seed * 0.01) : 0;
        const lift = this.motionScale ? Math.sin(this.frame * 0.083 + seed * 0.017) * 1.6 : 0;

        const top = py - PENNANT_POLE_PX + 2;
        const seg1 = Math.round(PENNANT_FLY_PX * 0.55);
        ctx.save();
        ctx.globalAlpha = 0.92 * gateAlpha;
        // Pole + gold finial.
        ctx.fillStyle = 'rgba(38, 26, 16, 0.9)';
        ctx.fillRect(px - 1, py - PENNANT_POLE_PX, 2, PENNANT_POLE_PX);
        ctx.fillStyle = '#e8c876';
        ctx.fillRect(px - 1, py - PENNANT_POLE_PX - 2, 2, 2);
        // Cloth: hoist segment + fly segment with a notched, shaded tip.
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(px + 1, top);
        ctx.lineTo(px + 1 + seg1, top + 1 + wave * 0.8);
        ctx.lineTo(px + 1 + seg1, top + PENNANT_DROP_PX - 1 + wave * 0.8);
        ctx.lineTo(px + 1, top + PENNANT_DROP_PX);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.moveTo(px + 1 + seg1, top + 1 + wave * 0.8);
        ctx.lineTo(px + 1 + PENNANT_FLY_PX, top + PENNANT_DROP_PX / 2 + lift);
        ctx.lineTo(px + 1 + seg1, top + PENNANT_DROP_PX - 1 + wave * 0.8);
        ctx.closePath();
        ctx.fill();
        // Busy/full: a second short streamer under the main cloth.
        if (busy) {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(px + 1, top + PENNANT_DROP_PX + 1);
            ctx.lineTo(px + 1 + seg1 - 2, top + PENNANT_DROP_PX + 2 + wave * 0.6);
            ctx.lineTo(px + 1 + seg1 - 2, top + PENNANT_DROP_PX + 5 + wave * 0.6);
            ctx.lineTo(px + 1, top + PENNANT_DROP_PX + 4);
            ctx.closePath();
            ctx.fill();
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
            // Dusk crossfades legacy presence warmth into the live night-shift
            // gate; at night only a physically present working agent lights it.
            const occupancy = PRESENCE_TIER_TABLE[this._presenceTierFor(building.type)].occupancy;
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
            // door, not a room, so it stays.
            const roomsLit = Boolean(this._roomInstrumentFor(building));
            const windowRects = getBuildingWindowRects(building.type);
            if (roomsLit) {
                // rooms carry the occupancy read for this building
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
            const w = Math.max(3, Math.round(rect.w || 6));
            const h = Math.max(3, Math.round(rect.h || 8));
            const p = localPoint(lx, ly);
            // Stepped halo: the inner course overlaps the outer, so the window
            // falls off in two hard alpha steps instead of a gradient.
            fillPixelEllipse(ctx, p.x, p.y, w * 1.7, h * 1.5, halo);
            fillPixelEllipse(ctx, p.x, p.y, w * 1.15, h * 1.05, halo);

            const left = Math.round(p.x - w / 2);
            const top = Math.round(p.y - h / 2);
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

    _drawManifestLayers(ctx, entry, wx, wy, splitPass = 'whole', horizonY = null, building = null) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        const buildingType = building?.type || '';
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base') continue;
            // 4.1 — the inspection layers are not ambient dressing: the
            // building renderer draws them, in their authored order, only
            // while this building is the explicitly selected one.
            if (isBuildingApertureLayer(buildingType, name)) continue;
            const localY = Array.isArray(layer.anchor) ? layer.anchor[1] : 0;
            if (
                splitPass !== 'whole' &&
                Number.isFinite(horizonY) &&
                (splitPass === 'back' ? localY >= horizonY : localY < horizonY)
            ) {
                continue;
            }
            const layerId = `${entry.id}.${name}`;
            const layerDims = this.assets.getDims(layerId);
            if (!layerDims) continue;
            // 0.1 — the manifest layer anchor is the base-sprite-local point the
            // layer's bottom-center lands on (the engine-wide anchor convention;
            // the manifest comments document beacon/watchfire/portalGlow anchors
            // this way). Draw with an explicit bottom-center anchor: the layer's
            // registered anchor mirrors the manifest value, and letting
            // drawSprite subtract it would cancel the placement entirely (the
            // pre-0.1 bug — every layer rendered at a dims-derived corner).
            const [ax, ay] = layer.anchor || [0, 0];
            const overlayWx = wx - baseAnchor[0] + ax;
            const overlayWy = wy - baseAnchor[1] + ay;
            // Animated pulse: fade alpha by sine of frame.
            // 0.08 rad/frame ≈ 1.27 Hz at 60fps (slow heartbeat).
            let alpha = 1;
            if (layer.animation === 'pulse') {
                alpha = 0.6 + 0.4 * Math.sin(this.frame * 0.08);
            }
            this.sprites.drawSprite(ctx, layerId, overlayWx, overlayWy, {
                alpha,
                anchor: [layerDims.w / 2, layerDims.h],
            });
        }
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

        ctx.save();
        this._clipToSplitPass(ctx, entry, wx, wy, splitPass, horizonY, null, baseAnchor);
        // 4.2 — one authored window per real working occupant, on the selected
        // building only, at night only. Draws before the per-type work so a
        // room light never sits over a ritual mark.
        const rooms = this._roomInstrumentFor(building);
        if (rooms) {
            this._drawWorkRooms(ctx, localPoint, shouldDrawLocalY, rooms, {
                // The open aperture carries the counts in its own legend.
                withCount: !this._openApertureFor(building),
            });
        }
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
            if (!shouldDrawLocalY(60)) {
                ctx.restore();
                return;
            }
            const gate = localPoint(144, 60);
            const visitors = this._visitorCountFor(building);
            const portalRitual = this._latestRitual('portal');
            // Three rings of snapped dots on the 2:1 ground ellipse, stepping
            // round one dot slot on the slow band (held under reduced motion).
            // A visiting agent turns the inner ring violet; the plaque carries
            // the exact count.
            const tick = this.motionScale ? Math.floor(this.frame * 0.05) : 0;
            const grow = portalRitual ? 2 : 0;
            for (let i = 0; i < 3; i++) {
                const count = 10 + i * 2;
                ringDots(ctx, gate.x, gate.y, 19 + i * 8 + grow, {
                    count,
                    dot: 1,
                    color: i === 0 && visitors > 0 ? '#bda7ff' : '#8feaff',
                    phase: ((tick + i) % count) * (Math.PI * 2 / count) * (i % 2 ? -1 : 1),
                });
            }
            this._drawPortalRitual(ctx, gate, portalRitual);
        } else if (building.type === 'watchtower') {
            if (shouldDrawLocalY(WATCHTOWER_LANTERN_FIRE.flame[1])) {
                const beacon = localPoint(...WATCHTOWER_LANTERN_FIRE.flame);
                const pivot = localPoint(...WATCHTOWER_SEARCHLIGHT.pivot);
                this._drawWatchtowerSearchlight(ctx, pivot, this._fleetDistressRatio());
                this._drawWatchtowerFire(ctx, beacon);
                this._drawWatchtowerRitual(ctx, beacon);
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
                const open = this._openApertureFor(building);
                // 4.1 — the sectional view replaces the wing's front wall while
                // Command is the selected building; the aggregate hall-window
                // row and the open room are the same fact, so only one of them
                // is ever on screen.
                this._drawCommandActivityDetails(ctx, localPoint, building, {
                    windows: !open && !rooms,
                });
                openAperture = open;
                this._drawCommandRitual(ctx, localPoint, building);
            }
        }
        ctx.restore();
        if (openAperture) this._drawInspectionAperture(ctx, building, entry, wx, wy, openAperture);
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
                        origin: toOrigin([144, 60]),
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
        const source = this._clockSourceCanvas(config, hourAngle, minuteAngle, `${time.hour}:${time.minute}`);
        const size = config.radius * 2;
        const left = Math.round(face.x - size / 2);
        const top = Math.round(face.y - size / 2);
        const previousSmoothing = ctx.imageSmoothingEnabled;
        // Independent web-ritual spin layered on top of the time-of-day hands
        // cached inside `source`. Rotate around the face center so the disc
        // orbits in place. Reduced motion holds at 0.
        const spin = this.motionScale ? (this._observatoryClockSpin || 0) : 0;

        ctx.imageSmoothingEnabled = false;
        if (spin) {
            ctx.save();
            ctx.translate(face.x, face.y);
            ctx.rotate(spin);
            ctx.drawImage(source, -size / 2, -size / 2, size, size);
            ctx.restore();
        } else {
            ctx.drawImage(source, left, top, size, size);
        }
        ctx.imageSmoothingEnabled = previousSmoothing;
    }

    _clockSourceCanvas(config, hourAngle, minuteAngle, cacheKey) {
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
        const tickMin = c - config.sourceRadius + 1;
        const tickMax = c + config.sourceRadius - 1;
        for (const [tx, ty] of [[c, tickMin], [c, tickMax], [tickMin, c], [tickMax, c]]) {
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
        // Slow-band lift quantized to whole texels; reduced motion holds still.
        const flagLift = this.motionScale ? Math.round(Math.sin(this.frame * 0.08) * 2) : 0;

        // 6.5 — signal pennants on the mast: a gold hoist ring, a tapering cloth
        // body with a shaded lower hem, and a shaded fly tip. One texel wide
        // columns, so every edge is a pixel step rather than an AA polygon.
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        for (const [dy, color, shade] of HARBOR_SIGNAL_PENNANTS) {
            const top = signal.y + dy;
            const cloth = gradeTone(color, lightGrade);
            const hem = gradeTone(shade, lightGrade);
            ctx.fillStyle = gradeTone('#e8c876', lightGrade);
            ctx.fillRect(signal.x + 3, top + 1, 2, 8);
            for (let i = 0; i < 20; i++) {
                const body = i < 11;
                const h = body ? 10 - Math.round(i * 4 / 11) : Math.max(1, Math.round(6 * (1 - (i - 11) / 9)));
                const y = top + ((10 - h) >> 1) + Math.round(flagLift * i / 19);
                const x = signal.x + 5 + i;
                if (body) {
                    ctx.fillStyle = cloth;
                    ctx.fillRect(x, y, 1, Math.max(1, h - 2));
                    ctx.fillStyle = hem;
                    ctx.fillRect(x, y + h - 2, 1, 2);
                } else {
                    ctx.fillStyle = hem;
                    ctx.fillRect(x, y, 1, h);
                }
            }
        }
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
    // polls, and bounded so a busy Forge cannot grow this list.
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
        const agent = this._taskboardBoardAgent();
        const view = this._taskboardViewFor(agent, 3);
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
                : row.text;
            if (row.compact && measureLabelText(ctx, rowText) > inner.w - itemIndent) rowText = row.compact;
            const text = row.kind === 'phase'
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

    // `windows: false` withdraws the aggregate hall-window row when the 4.1
    // aperture or the 4.2 rooms are carrying occupancy for this building —
    // one instrument per fact. The hall's warm light is the pool path's job
    // (the static Command sources, gated by NightOccupancyGate): this overlay
    // is ungraded, so it carries no screen-blend spill or keep rings.
    _drawCommandActivityDetails(ctx, localPoint, building, { windows = true } = {}) {
        if (!windows) return;
        const activity = this._buildingActivityInfo(building);
        const activeWorking = this._watchtowerActiveCount();
        const signal = Math.max(activity.intensity, activity.occupancy.ratio, Math.min(1, activeWorking / 6));
        if (signal <= 0.16) return;
        // Night occupancy only: 0 by day, the live working factor at night.
        // Lit panes are light, so they may sit on the ungraded overlay; an
        // unlit pane would be ungraded paint on the face, so it is not drawn.
        const nightOccupancy = this._nightWindowGate() * this._nightShiftLit(building?.type);
        if (nightOccupancy <= 0.5) return;
        // 4.2 — the aggregate row lights the keep's own authored panes (the
        // registry windowRects, pane centres), never painted-on windows.
        const panes = getBuildingWindowRects('command') || [];
        const count = Math.min(panes.length, Math.max(1, Math.ceil(signal * 5)), activeWorking);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        for (let i = 0; i < count; i++) {
            const { at, w = 4, h = 8 } = panes[i];
            const p = localPoint(at[0], at[1]);
            const left = Math.round(p.x - w / 2);
            const top = Math.round(p.y - h / 2);
            // A warm pane with a hot mullion line, one per working occupant.
            ctx.fillStyle = '#ffe59a';
            ctx.fillRect(left, top, w, h);
            ctx.fillStyle = '#fff6cf';
            ctx.fillRect(Math.round(p.x), top + 1, 1, Math.max(1, h - 2));
        }
        ctx.restore();
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

    // The Pharos work ritual: snapped dot rings on the ground ellipse around
    // the lantern, one more ring per working fifth (at most three); red on a
    // failed push. No filled discs: the lantern's light is the pool path's.
    _drawWatchtowerRitual(ctx, beacon) {
        const active = this._watchtowerActiveCount();
        const failed = this.harborStatus?.failedPushActive;
        if (active <= 0 && !failed) return;
        const intensity = this._watchtowerIntensity();
        const color = failed ? '#ff6d52' : '#ffd36a';
        const rings = failed ? 3 : Math.max(1, Math.min(3, Math.ceil(intensity * 3)));
        const tick = this.motionScale ? Math.floor(this.frame * 0.05) : 0;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        for (let i = 0; i < rings; i++) {
            const count = 12 + i * 4;
            ringDots(ctx, beacon.x, beacon.y + 2, 19 + i * 9, {
                count,
                dot: 1,
                color,
                phase: ((tick + i) % count) * (Math.PI * 2 / count),
            });
        }
        ctx.restore();
    }

    // #17 — Pharos rotating searchlight: a wedge sweeping from the lantern
    // pivot, composited `screen`, filled as snapped texel rows in three stepped
    // courses (bright near the lamp, then two alpha quanta) instead of a smooth
    // gradient. Sweep speed (driven by _updateWatchtowerSearchlight) and colour
    // both read fleet distress — amber when calm, shifting to red as
    // errored/rate-limited agents mount. The beam is clipped to the sky above
    // the pivot so it never spills onto the terrain below the tower.
    //
    // Reduced-motion fallback: no rotation (angle frozen at last value) and a
    // single static directional wedge at a steady alpha.
    _drawWatchtowerSearchlight(ctx, pivot, fleetDistressRatio = 0) {
        const distress = clamp01(fleetDistressRatio);
        const angle = this._watchtowerSearchlightAngle;
        const length = WATCHTOWER_SEARCHLIGHT.length || 320;
        const farWidth = WATCHTOWER_SEARCHLIGHT.width || 58;
        // Amber (calm) → red (distressed) for the lit core and the far courses.
        const core = mixHex('#ffe6a0', '#ff5a3c', distress);
        const haze = mixHex('#ffb347', '#ff3a2a', distress);
        // #40 — a fresh incident flares the beam brighter for ~1.4s. Held at 0
        // under reduced motion so the static wedge keeps a steady alpha.
        const flare = this.motionScale ? clamp01(this._watchtowerFlare) : 0;
        const beamAlpha = (0.16 + distress * 0.22 + flare * 0.26) * 0.9;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';

        // Clip to the sky above the pivot so the wedge never paints the ground.
        ctx.beginPath();
        ctx.rect(pivot.x - length, pivot.y - length, length * 2, length + 6);
        ctx.clip();

        const drawWedge = (theta, len, far, alpha) => {
            if (alpha <= 0) return;
            const dx = Math.cos(theta);
            const dy = Math.sin(theta);
            const px = -dy;
            const py = dx;
            const edge = (t, side) => {
                const half = 4 + (far / 2 - 4) * t;
                return [pivot.x + dx * len * t + px * half * side, pivot.y + dy * len * t + py * half * side];
            };
            for (let course = 0; course < SEARCHLIGHT_COURSES.length; course++) {
                const [from, to, share] = SEARCHLIGHT_COURSES[course];
                ctx.globalAlpha = alpha * share;
                ctx.fillStyle = course === 0 ? core : haze;
                fillConvex(ctx, [edge(from, 1), edge(from, -1), edge(to, -1), edge(to, 1)]);
            }
        };

        drawWedge(angle, length, farWidth, beamAlpha);
        // Faint trailing counter-beam, like a real twin-lamp lighthouse.
        if (this.motionScale) drawWedge(angle + Math.PI, length * 0.7, farWidth * 0.7, beamAlpha * 0.5);

        // The lamp reads as the beam's origin: three stepped pixel discs.
        const bloomAlpha = clamp01(0.5 + distress * 0.3 + flare * 0.3);
        ctx.fillStyle = core;
        const outer = Math.round(8 + distress * 3);
        for (const [radius, share] of [[outer, 0.33], [Math.round(outer * 0.62), 0.66], [2, 1]]) {
            ctx.globalAlpha = bloomAlpha * share;
            this._fillPixelCircle(ctx, pivot.x, pivot.y, radius);
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

    _drawWatchtowerFire(ctx, beacon) {
        const flicker = this.motionScale ? Math.sin(this.frame * 0.23) * 2.2 + Math.sin(this.frame * 0.41) * 1.1 : 0.8;
        const lean = this.motionScale ? Math.sin(this.frame * 0.13) * 2.6 : 1.2;
        const failed = this.harborStatus?.failedPushActive;
        const intensity = this._watchtowerIntensity();

        // The lantern's halo: three stepped pixel discs (rim, mid, core) at the
        // C4 alpha quanta instead of a radial gradient.
        ctx.globalCompositeOperation = 'screen';
        const outer = Math.round(14 + intensity * 6);
        const glowAlpha = 0.58 + intensity * 0.14;
        for (const [radius, share, color] of [
            [outer, 0.33, failed ? '#ff2f27' : '#ff5b1a'],
            [Math.round(outer * 0.6), 0.66, failed ? '#ff5d43' : '#ff8e33'],
            [Math.round(outer * 0.3), 1, failed ? '#ffdcaa' : '#ffec96'],
        ]) {
            ctx.globalAlpha = glowAlpha * share;
            ctx.fillStyle = color;
            this._fillPixelCircle(ctx, beacon.x, beacon.y, radius);
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.92;
        // Brazier bowl: a pixel pool with a rim, not an outlined vector ellipse.
        fillPixelEllipse(ctx, beacon.x, beacon.y + 7, 10, 4, '#6b351c');
        strokePixelEllipse(ctx, beacon.x, beacon.y + 7, 10, 4, '#2f1d12');

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.92;
        // The beacon is the tallest, most-looked-at flame in the village; it was
        // two quadratic curves, which read as a smooth orange leaf.
        const beaconHeight = 20 + Math.abs(flicker) * 1.6;
        drawPixelFlame(ctx, beacon.x, beacon.y + 5, beaconHeight, 6, {
            outer: failed ? '#ff5d43' : '#ff7a2f',
            inner: failed ? '#ffd08b' : '#ffe68a',
            tip: failed ? '#ffe9c8' : '#fff3c4',
            lean,
            coreRatio: 0.55,
        });
    }

    _spawnEmittersFor(b, dt = 16) {
        const entry = this.assets.getEntry(`building.${b.type}`);
        if (!this.motionScale) return;
        const center = this._buildingScreenCenter(b);
        const entryId = entry?.id || `building.${b.type}`;
        const baseAnchor = this.assets.getAnchor(entryId);
        for (const [particleType, [lx, ly]] of Object.entries(entry?.emitters || {})) {
            const normalizedType = PARTICLE_ALIASES[particleType] || particleType;
            const at = b.type === 'watchtower' ? WATCHTOWER_LANTERN_FIRE.particle : [lx, ly];
            this._spawnBuildingParticle(normalizedType, center, baseAnchor, at, 0.035, 1, dt);
        }
        const presenceMult = PRESENCE_TIER_TABLE[this._presenceTierFor(b.type)].emitter;
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
                : this._visitorCountFor(b) > 0 ? 1.6 : 1;
            if (archiveReadIntensity > 0.6 && Array.isArray(emitter.at) && emitter.at[1] >= 120) {
                chanceBoost *= 1 + (archiveReadIntensity - 0.6) * 5;
            }
            const chance = emitter.chance * chanceBoost * presenceMult * beaconMult;
            const options = this._smokeEmitterOptions(b, emitter.type, windDrift);
            this._spawnBuildingParticle(emitter.type, center, baseAnchor, emitter.at, chance, emitter.count || 1, dt, options);
        }
    }

    // #33 — per-emitter spawn options for the volumetric smoke family. Returns
    // null for non-smoke emitters (unchanged behaviour). Mine dust and the
    // harbor cookfire get the shared wind drift; wind also widens the spawn
    // spread so a leaning column smears out. (6.7 — chimney smoke, forge heat
    // included, is ChimneySmoke's.)
    _smokeEmitterOptions(building, particleType, windDrift) {
        const isMineDust = building.type === 'mine' && particleType === 'mineDust';
        const isHarborSmoke = building.type === 'harbor' && particleType === 'smoke';
        if (!isMineDust && !isHarborSmoke) return null;

        const options = {};
        if (windDrift) options.windX = windDrift;
        const lean = Math.abs(windDrift);
        if (lean) options.spread = [2.4 + lean * 2.6, 2.4 + lean * 2.6];
        return options;
    }

    _spawnBuildingParticle(type, center, baseAnchor, at, chance, count, dt = 16, options = null) {
        if (Math.random() > chanceForDt(chance, dt)) return;
        const [lx, ly] = at;
        const wx = center.x - baseAnchor[0] + lx;
        const wy = center.y - baseAnchor[1] + ly;
        // 0.1 — building emitters are open-air by construction, so they replay
        // on the resident WebGL overlay; the mine mouth's dust stays at ground
        // level and waits for GPU particle records.
        const grounded = type === 'mineDust' || type === 'mining';
        const spawnOptions = grounded ? options : { ...(options || {}), layer: PARTICLE_LAYER_AIR };
        if (spawnOptions) this.particles.spawn(type, wx, wy, count, spawnOptions);
        else this.particles.spawn(type, wx, wy, count);
    }

    _updateVisitorCounts() {
        this._visitorCountByType.clear();
        this._visitorStatusByType.clear();
        if (!this.agentSprites?.length) return;
        // Clear last frame's fold tags before re-tagging; IsometricRenderer
        // reads `_foldBuildingType` to suppress folded occupants' name pills.
        for (const sprite of this.agentSprites) sprite._foldBuildingType = null;
        if (!this.buildings.length) return;
        // #53 — per-building occupant repo tally, refilled in place each tick
        // and reduced below to the dominant repo per type.
        const repoTally = this._visitorRepoTally || (this._visitorRepoTally = new Map());
        for (const tally of repoTally.values()) tally.clear();

        for (const sprite of this.agentSprites) {
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
                    tally = { working: 0, waiting_on_user: 0, errored: 0 };
                    this._visitorStatusByType.set(building.type, tally);
                }
                const status = sprite.agent?.status;
                if (lightsBuildingWindows(sprite.agent)) tally.working++;
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
                working: lightsBuildingWindows(agent),
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
        this._roomStateByType.clear();
        if (!type) return;
        const rooms = getBuildingRoomProfile(type);
        const aperture = getBuildingApertureProfile(type);
        if (!rooms && !aperture) return;

        const sessions = this._inspectionSessions(type, Date.now());
        if (rooms) {
            const held = this._roomAssignments.get(type);
            // A stale observation freezes: it keeps the room it already holds
            // and never takes a new one.
            const workingIds = sessions
                .filter((session) => session.working && (!session.stale || held?.has(session.agentId)))
                .map((session) => session.agentId);
            const { assignment, overflow } = assignRoomSlots({
                previous: held,
                workingIds,
                rooms: rooms.slots.length,
            });
            this._roomAssignments.set(type, assignment);
            this._roomStateByType.set(type, {
                profile: rooms,
                assignment,
                working: workingIds.length,
                waiting: sessions.filter((session) => session.waiting).length,
                overflow,
            });
        }
        if (!aperture) return;
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

    // 4.2 — the per-room instrument is night-only and selection-only. Outside
    // it every building keeps the shipped aggregate occupancy gate.
    _roomInstrumentFor(building) {
        const state = this._roomStateByType.get(building?.type);
        if (!state) return null;
        return this._nightWindowGate() > 0 ? state : null;
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
        const rooms = this._roomStateByType.get(model.buildingType);
        const working = rooms ? rooms.working : this._visitorStatusByType.get(model.buildingType)?.working || 0;
        const waiting = rooms
            ? rooms.waiting
            : this._visitorStatusByType.get(model.buildingType)?.waiting_on_user || 0;
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

    // 4.2 — one authored window per real working occupant, plus the exact
    // counts. A room the art does not have is never invented: the surplus is
    // the overflow number.
    _drawWorkRooms(ctx, localPoint, shouldDrawLocalY, state, { withCount = true } = {}) {
        const gate = this._nightWindowGate();
        const slots = state.profile.slots;
        const lit = new Set(state.assignment.values());
        ctx.save();
        for (let index = 0; index < slots.length; index++) {
            const slot = slots[index];
            const [lx, ly] = slot.at || [];
            if (!Number.isFinite(lx) || !Number.isFinite(ly) || !shouldDrawLocalY(ly)) continue;
            const point = localPoint(lx, ly);
            const w = Math.max(3, Math.round(slot.w || 6));
            const h = Math.max(3, Math.round(slot.h || 8));
            const left = Math.round(point.x - w / 2);
            const top = Math.round(point.y - h / 2);
            // Every room keeps its dark frame, so an unlit room reads as a
            // room at rest rather than as missing art.
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = 'rgba(22, 15, 11, 0.9)';
            ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
            if (!lit.has(index)) {
                ctx.fillStyle = 'rgba(74, 62, 58, 0.75)';
                ctx.fillRect(left, top, w, h);
                continue;
            }
            ctx.fillStyle = `rgba(255, 214, 138, ${0.5 + gate * 0.34})`;
            ctx.fillRect(left, top, w, h);
            ctx.fillStyle = `rgba(255, 244, 206, ${0.5 + gate * 0.4})`;
            ctx.fillRect(Math.round(point.x - 1), top + 1, 2, Math.max(2, h - 2));
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = `rgba(255, 190, 96, ${0.16 + gate * 0.14})`;
            ctx.fillRect(left - 3, top - 2, w + 6, h + 4);
        }
        ctx.restore();
        if (!withCount) return;
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
            intensity = Math.max(intensity, this._watchtowerIntensity());
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

    // Canvas-only activity footprint in pixel grammar: static dotted rings
    // (no breathing — C4 keeps constant motion off the world), a one-texel
    // footprint outline, and the dais gauge. Every mark is whole-texel fills.
    _drawBuildingActivityFootprint(ctx, building, { isLandmark = false, isHovered = false } = {}) {
        const info = this._buildingActivityInfo(building);
        if (info.intensity <= 0.12 && info.occupancy.state === 'idle' && !info.alert) return;

        const visual = getBuildingVisual(building.type);
        const band = visual?.pulseBand || {};
        const accent = info.alert
            ? '#ff755d'
            : (band.color || getBuildingLabelAccent(building.type, '#d6a951'));
        const c = this._buildingScreenCenter(building);
        const tileHalfW = (building.width + building.height) * TILE_WIDTH / 4;
        const tileHalfH = (building.width + building.height) * TILE_HEIGHT / 4;
        const ringCount = info.alert || info.intensity > 0.78 ? 2 : 1;
        const baseAlpha = Math.min(
            0.54,
            0.08 + info.intensity * 0.34 + (isHovered ? 0.06 : 0) + (isLandmark ? 0.03 : 0),
        );

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < ringCount; i++) {
            const grow = (info.alert ? 0.24 : 0.16) * (0.42 + i * 0.12) + i * 0.08;
            ctx.globalAlpha = baseAlpha * (0.78 - i * 0.14);
            ellipseArcDots(
                ctx,
                Math.round(c.x),
                Math.round(c.y + 4),
                tileHalfW * (1.04 + grow),
                Math.max(12, tileHalfH * (0.74 + grow * 0.45)),
                { step: 5, dot: info.alert ? 2 : 1, color: accent },
            );
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(0.5, 0.16 + info.intensity * 0.22 + (info.alert ? 0.08 : 0));
        ctx.fillStyle = accent;
        const corners = this._buildingFootprintCorners(building);
        const thick = info.alert ? 2 : 1;
        pixelLine(ctx, corners.nw.x, corners.nw.y, corners.ne.x, corners.ne.y, thick);
        pixelLine(ctx, corners.ne.x, corners.ne.y, corners.se.x, corners.se.y, thick);
        pixelLine(ctx, corners.se.x, corners.se.y, corners.sw.x, corners.sw.y, thick);
        pixelLine(ctx, corners.sw.x, corners.sw.y, corners.nw.x, corners.nw.y, thick);
        this._drawBuildingDaisRing(ctx, building, info, accent);
        ctx.restore();
    }

    // #57 — dais ring (replaces the load-pip diamond row): the front arc of the
    // footprint ellipse is an intensity gauge — a dim dotted track plus a solid
    // pixel arc whose sweep encodes activity intensity, over a faint scanline
    // ground pool, so occupancy reads from across the map. Governor-admitted
    // (SECONDARY arc, AMBIENT pool). Static in every motion mode.
    _drawBuildingDaisRing(ctx, building, info, accent) {
        const occupancy = info.occupancy || {};
        const signal = Math.max(occupancy.ratio || 0, info.intensity, info.ritualFade || 0);
        if (signal <= 0.16 && !info.alert) return;

        const corners = this._buildingFootprintCorners(building);
        const cx = Math.round((corners.nw.x + corners.se.x) / 2);
        const cy = Math.round((corners.nw.y + corners.se.y) / 2 + 4);
        const rx = Math.max(18, Math.abs(corners.se.x - corners.nw.x) / 2 + 10);
        const ry = Math.max(10, Math.abs(corners.se.y - corners.nw.y) / 2 + 6);
        const fill = info.alert ? 1 : clamp01((signal - 0.16) / 0.84);
        // Canvas ellipse angles: 0 = east, π/2 = south (screen-down). The dais
        // spans the front (south) face; the lit arc fills east→west through it.
        const start = Math.PI * 0.08;
        const end = Math.PI * 0.92;
        const sweep = start + (end - start) * fill;

        const governor = getActiveMarkGovernor();
        const glowGate = governor?.admit(MarkTier.AMBIENT, cx, cy) || null;
        const arcGate = governor?.admit(MarkTier.SECONDARY, cx, cy) || null;

        ctx.save();
        if (!glowGate || glowGate.draw) {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = (0.13 + fill * 0.13) * (glowGate?.alpha ?? 1);
            fillPixelEllipse(ctx, cx, cy, rx * 0.94, ry * 0.9, accent);
        }
        if (!arcGate || arcGate.draw) {
            const gateAlpha = arcGate?.alpha ?? 1;
            ctx.globalCompositeOperation = 'source-over';
            // Dim dotted track, then the solid lit arc with a bright end gem.
            ctx.globalAlpha = 0.2 * gateAlpha;
            ellipseArcDots(ctx, cx, cy, rx, ry, { start, end, step: 4, dot: 2, color: accent });
            if (sweep > start) {
                ctx.globalAlpha = Math.min(0.9, 0.46 + fill * 0.38) * gateAlpha;
                ellipseArcDots(ctx, cx, cy, rx, ry, { start, end: sweep, step: 2, dot: info.alert ? 3 : 2, color: accent });
            }
            if (fill > 0.05) {
                const gemX = Math.round(cx + Math.cos(sweep) * rx);
                const gemY = Math.round(cy + Math.sin(sweep) * ry);
                ctx.globalAlpha = 0.9 * gateAlpha;
                ctx.fillStyle = '#fff3cf';
                ctx.fillRect(gemX - 1, gemY - 1, 2, 2);
            }
        }

        // Overload / full / alert chevrons (kept from the pips row).
        if (info.overload > 0 || info.alert || occupancy.state === 'full') {
            const edgeX = Math.round(lerp(corners.sw.x, corners.se.x, 0.82));
            const edgeY = Math.round(lerp(corners.sw.y, corners.se.y, 0.82) + 7);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = info.alert ? 0.95 : 0.76;
            ctx.fillStyle = info.alert ? '#ff755d' : accent;
            pixelLine(ctx, edgeX - 5, edgeY + 3, edgeX, edgeY - 2);
            pixelLine(ctx, edgeX + 1, edgeY - 1, edgeX + 5, edgeY + 3);
            pixelLine(ctx, edgeX - 5, edgeY + 8, edgeX, edgeY + 3);
            pixelLine(ctx, edgeX + 1, edgeY + 4, edgeX + 5, edgeY + 8);
        }
        ctx.restore();
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
