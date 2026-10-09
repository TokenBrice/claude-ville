import { MAP_SIZE } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import {
    FOLLOW_ENTRY_MS,
    WHEEL_STEP_MS,
    ZOOM_STEP_MS,
    glideDurationMs,
    criticalSpringStep,
    easeInOutCubic,
    easeOutCubic,
    logZoom,
    planGlide,
    sampleGlide,
} from './CameraCurves.js';
import { OCEAN_HORIZON_WORLD_Y } from './CoastBake.js';
import { buildingCenterToWorld, mapWorldCorners, tileToWorld, worldToTile } from './Projection.js';
import { getReservedRects } from '../shared/ReservedRects.js';

// #50 — idle Ken-Burns drift tuning. Begins after this much input-free time,
// then breathes along a slow detuned Lissajous loop with a sub-pixel amplitude.
const IDLE_DRIFT_DELAY_MS = 45000;
const IDLE_DRIFT_AMPLITUDE_PX = 8;
const IDLE_DRIFT_PERIOD_X_MS = 38000;
const IDLE_DRIFT_PERIOD_Y_MS = 47000;

// 4.6 — a GL frame is a flight frame when the pose moved more than this many
// backing px since the last GL frame (`latchGpuFrame`).
const GPU_FLIGHT_EPSILON_PX = 1e-3;

// #54 — empty-village tour. Once the village has been empty for a stretch AND
// the operator idle, the camera takes a slow Ken-Burns circuit of the
// landmarks. It yields the instant an agent arrives or the operator touches
// anything. It never grades the world (V3: the environment reads no agent
// state, and an empty village is agent state). Reduced motion: no circuit.
const TOUR_EMPTY_DELAY_MS = 20000;
const TOUR_USER_IDLE_MS = 40000;
const TOUR_DWELL_MS = 7000;
const TOUR_STOP_ORDER = Object.freeze([
    'command', 'archive', 'observatory', 'watchtower', 'harbor',
    'portal', 'mine', 'forge', 'taskboard',
]);

// Logical resting tiers for wheel/keyboard zoom. Every settled pose must place
// one authored world pixel on a whole number of BACKING pixels, otherwise
// sprite art and canvas text are resampled instead of scaled. A backing pixel
// is itself an exact integer block of device pixels (see CanvasBudget's
// divisor ladder), so an integer backing scale is an integer device scale —
// the two together are what keep pixel text readable at any display scale.
// Tweens and glides pass through fractional values (flight frames render
// fat-pixel on the GL path, 4.6); every settled pose is display-pixel aligned.
const NOMINAL_ZOOM_STEPS = Object.freeze([1, 2, 3]);

// 8.3 — the survey tier label. It names the survey SHOT (4.1): the widest
// resting step that shows ≥ 95 % of the island (`shotScaleTiers().survey`),
// wherever the viewport has one — z1 on the DPR-1 ultrawide, `1 / backingDpr`
// (one backing pixel per world texel) on a DPR-2 laptop. Where no step shows
// the island it resolves to the ladder's `1 / backingDpr` step (backing DPR
// ≥ 2 only: at DPR 1 a 0.5 zoom would drop every other texel), else tier 1.
// Wheel/keyboard can reach the ladder step; automatic framing uses the survey
// only where asked (the opening, the tour's island stop, `F` on a box
// spanning most of the island).
export const SURVEY_TIER = 0.5;
const SURVEY_MIN_BACKING_DPR = 2;

// 4.8 — at backing DPR 2 every whole backing-pixel scale k = 1..6 is a crisp
// rest (zoom k/2). The logical tiers keep their zooms (survey 0.5, then 1, 2,
// 3); k = 3 and k = 5 add the in-between rungs 1.5 and 2.5, which the wheel,
// the keyboard and `F` reach. Shot scales, glide landings and the follow tier
// stay on the logical tiers.
const HALF_RUNG_BACKING_DPR = 2;
const HALF_RUNGS = Object.freeze([1.5, 2.5]);

// 4.1 — shot scales by visible world AREA (world px²), never by tier index:
// each is the resting tier ≥ 1 whose visible area is log-nearest the target.
const SHOT_SCALE_AREA = Object.freeze({ wide: 1.4e6, medium: 0.55e6, close: 0.2e6 });
const SHOT_SCALE_NAMES = Object.freeze(['survey', 'wide', 'medium', 'close']);
// Before the viewport is laid out the shots fall back to the old labels.
const FALLBACK_SHOT_TIER = Object.freeze({ survey: null, wide: 1, medium: 2, close: 3 });
const SURVEY_ISLAND_SHARE = 0.95;

// The island diamond (tile-centre corners) as a cyclic polygon, its area and
// its centroid: the land the shot scales and 4.2's sea share are measured on.
const ISLAND_POLYGON = Object.freeze((() => {
    const [north, east, west, south] = mapWorldCorners(MAP_SIZE);
    return [north, east, south, west];
})());
const ISLAND_CENTROID = Object.freeze({
    x: ISLAND_POLYGON.reduce((sum, p) => sum + p.x, 0) / 4,
    y: ISLAND_POLYGON.reduce((sum, p) => sum + p.y, 0) / 4,
});
const ISLAND_AREA = polygonArea(ISLAND_POLYGON);

// 4.2 — automatic shots keep at most this much sea: the centre steps toward
// the island centroid in 16 world px steps, never pushing the subject's box
// into a 12 % inner margin. W5.1 (PI-P5) — 30 % is the floor of the cap, not
// the cap: a view larger than the island can fill (the DPR-1 ultrawide's
// survey, the 2560 pane's z1) shows at least `1 − island / view` sea even
// centred, so the cap there is that least share plus 5 points — a promise the
// stepping loop can keep, so it still pulls an off-centre pose home. On such a
// roomy view the sea share barely changes once the whole island is in frame,
// so the loop also keeps stepping until the island's centre lies within 10 %
// of the frame's centre on each axis: the ocean is an even margin, not one
// empty side (the subject's 12 % margin still wins).
const LAND_WEIGHT_MAX_SEA = 0.30;
const LAND_WEIGHT_SEA_SLACK = 0.05;
const LAND_WEIGHT_CENTRE_BAND = 0.10;
const LAND_WEIGHT_STEP_PX = 16;
const LAND_WEIGHT_MARGIN = 0.12;
const LAND_WEIGHT_MAX_STEPS = 256;

// W5.1 (PI-P5) — how far past the island diamond's extreme corners the screen
// centre may sit (world px). The operator keeps a generous pad (panning out
// over open sea is exploration); a pose an automatic owner composes gets a
// tight one, so the camera never parks the island in a corner of the pane on
// its own. The release cue frames the Harbor's sea slip and keeps the
// operator's pad.
const OPERATOR_PAD = Object.freeze({ x: 220, y: 160, viewDivisor: 2.2 });
const AUTOMATIC_PAD = Object.freeze({ floor: 96, viewShare: 0.12 });
const RELEASE_CUE_OWNER = 'cue:release';

// 4.2 — an automatic shot does not crop a landmark at the top: every building
// whose silhouette stands in the frame keeps its crown, and its plate (drawn
// centred 24 screen px over the crown, 17 px tall), clear of the frame's top
// edge and of any reserved chrome rect (V8, the World dock) sharing its
// columns. The pose moves on a 16 world px grid to the offset that crops
// least — crowns first, then plates, then distance — never at the subject's
// expense (see `_landmarkClearPose`) nor past the sea cap. A building wholly
// above the frame is clear.
const LANDMARK_PLATE_CLEARANCE_PX = 38;
const LANDMARK_PLATE_HALF_WIDTH_PX = 80;
const LANDMARK_EDGE_AIR_PX = 4;
const LANDMARK_SEARCH_STEPS = 24;
// A villager's body over its feet (the tallest stands 76 texels, plus its
// contact shadow): a body the frame shows whole stays whole.
const LANDMARK_BODY = Object.freeze({ side: 20, up: 76, down: 6 });

// 4.5 (AD-7) — sky room in the survey and opening wides: the sea horizon at
// 11 % of the world viewport (the canvas starts below the top bar), inside
// 10–12 %, with a ≥ 4 % margin under the island.
const SKY_ROOM_HORIZON_SHARE = 0.11;
const SKY_ROOM_HORIZON_MIN_SHARE = 0.10;
const SKY_ROOM_HORIZON_MAX_SHARE = 0.12;
const SKY_ROOM_BOTTOM_MARGIN = 0.04;
// SkyRenderer's discs: the sun's radius is max(22, 4.2 % of the short side),
// the moon's max(32, 2.6 %), and each is held 1.3 radii above the horizon;
// a whole disc needs 2.3 radii (plus a pixel of rim) between it and the top.
const SUN_DISC_RADIUS = Object.freeze({ floor: 22, share: 0.042 });
const MOON_DISC_RADIUS = Object.freeze({ floor: 32, share: 0.026 });
const DISC_HORIZON_CLEARANCE_RADII = 1.3;

// 8.3 — the resting tier content re-frames (relayout, `F`) and a follow
// settle on. D1 put villagers at 1:1; tier 3 is the crisp detail framing the
// bodies are drawn for (a box too large for it falls back to the next rung
// that fits). M21 keeps it at 3 on the DPR-2 laptop too.
export const DEFAULT_FRAME_TIER = 3;

// 8.3 — the opening: survey hold (pixel-exact, at rest), then one authored
// continuous dolly (4.6) to the content.
const OPENING_HOLD_MS = 1600;
const OPENING_DOLLY_MS = 2400;
// The island's centre sits 4 % below screen centre; 4.5's sky room replaces
// this with the horizon placement wherever the island leaves vertical slack.
const OPENING_COMPOSITION = Object.freeze({ x: 0.5, y: 0.54, skyRoom: true });
// `F` widens to the survey tier once the content box covers this share of
// the island's width or height.
const SURVEY_BOX_SHARE = 0.6;

// 8.2 — follow-cam composition window. The target walks freely inside a
// 28 % × 22 % box whose centre is the aim point; the aim sits 6 % below
// screen centre so the camera looks 6 % above the villager's feet and the
// head and bubble keep their air. Leaving the box pulls the camera back to
// the box edge on a critically damped spring; a standing target relaxes to
// the aim point on a slower one.
const FOLLOW_WINDOW_W = 0.28;
const FOLLOW_WINDOW_H = 0.22;
const FOLLOW_AIM_Y = 0.56;
const FOLLOW_OMEGA = 3.5;
const FOLLOW_RELAX_OMEGA = 1.2;

// The surface's own ratio, never re-clamped: CanvasBudget already picked a rung
// on the device grid, and a second, different floor here would align the zoom
// tiers to a DPR the canvas is not actually using.
function backingDpr(canvas) {
    const surfaceDpr = Number(canvas?._claudeVilleDpr);
    if (Number.isFinite(surfaceDpr) && surfaceDpr > 0) return surfaceDpr;
    const deviceDpr = Number(globalThis.window?.devicePixelRatio);
    return Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
}

// Tier 1 puts one authored world pixel on the nearest whole number of backing
// pixels; tiers 2 and 3 are the same [1, 2, 3] ratios on top of it, so tier
// semantics elsewhere in the renderer are unchanged. At backing DPR 1 and 2
// the tiers are exactly [1, 2, 3]; below 1 this reduces to the historical
// 1/dpr scaling; fractional ratios above 1 (125% browser zoom, 150% displays)
// shift by the rounding needed to stay on the grid.
function displayPixelZoomScale(dpr) {
    return Math.max(1, Math.round(dpr)) / dpr;
}

export function displayPixelZoomSteps(dpr) {
    const scale = displayPixelZoomScale(dpr);
    return Object.freeze(NOMINAL_ZOOM_STEPS.map((step) => step * scale));
}

// 8.3 — the full resting ladder: the survey tier (when the backing store
// supports it) below the display-pixel tiers, plus 4.8's half rungs at
// backing DPR 2. `tiers` are the logical labels callers ask for; `steps` the
// camera zooms they resolve to.
export function zoomTierLadder(dpr) {
    const steps = [...displayPixelZoomSteps(dpr)];
    const tiers = [...NOMINAL_ZOOM_STEPS];
    const backing = Number(dpr);
    if (Number.isFinite(backing) && Math.abs(backing - HALF_RUNG_BACKING_DPR) < 1e-6) {
        // displayPixelZoomScale(2) is 1, so a half rung's label is its zoom.
        for (const rung of HALF_RUNGS) {
            const index = tiers.findIndex((label) => label > rung);
            steps.splice(index, 0, rung);
            tiers.splice(index, 0, rung);
        }
    }
    if (Number.isFinite(backing) && backing >= SURVEY_MIN_BACKING_DPR) {
        steps.unshift(1 / backing);
        tiers.unshift(SURVEY_TIER);
    }
    return { steps: Object.freeze(steps), tiers: Object.freeze(tiers) };
}

// A shot rests on a logical tier (survey, 1, 2, 3); 4.8's half rungs are
// operator rests only.
function isShotTier(label) {
    return Math.abs(label - SURVEY_TIER) < 1e-6
        || NOMINAL_ZOOM_STEPS.some((tier) => Math.abs(tier - label) < 1e-6);
}

function polygonArea(points) {
    let twice = 0;
    for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        twice += a.x * b.y - b.x * a.y;
    }
    return Math.abs(twice) / 2;
}

// One Sutherland–Hodgman pass: keep the side of the axis line `value` where
// `sign · (p[axis] − value) ≥ 0`.
function clipPolygonToAxis(points, axis, value, sign) {
    const other = axis === 'x' ? 'y' : 'x';
    const out = [];
    for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const aIn = sign * (a[axis] - value) >= 0;
        const bIn = sign * (b[axis] - value) >= 0;
        if (aIn) out.push(a);
        if (aIn !== bIn) {
            const t = (value - a[axis]) / (b[axis] - a[axis]);
            out.push({ [axis]: value, [other]: a[other] + (b[other] - a[other]) * t });
        }
    }
    return out;
}

// World px² of the island diamond inside an axis-aligned world rect.
export function islandAreaInWorldRect(minX, minY, maxX, maxY) {
    let points = ISLAND_POLYGON;
    for (const [axis, value, sign] of [['x', minX, 1], ['x', maxX, -1], ['y', minY, 1], ['y', maxY, -1]]) {
        points = clipPolygonToAxis(points, axis, value, sign);
        if (points.length < 3) return 0;
    }
    return polygonArea(points);
}

// 4.1 — the resting zoom of each shot scale for a viewport (CSS px):
//   survey — the largest resting step that shows ≥ 95 % of the island
//            diamond from its centre, or null;
//   wide / medium / close — the resting step at tier ≥ 1 whose visible world
//            area is log-nearest 1.4e6 / 0.55e6 / 0.2e6 world px².
// `zoomSteps` is `zoomTierLadder(dpr)`, or a bare step list read as its own
// labels (true at backing DPR 1 and 2). 4.8's half rungs are never a shot.
export function shotScaleTiers(viewportW, viewportH, zoomSteps) {
    const width = Number(viewportW);
    const height = Number(viewportH);
    const ladder = Array.isArray(zoomSteps) ? { steps: zoomSteps, tiers: zoomSteps } : (zoomSteps || {});
    const steps = ladder.steps || [];
    const tiers = ladder.tiers || steps;
    const shots = [];
    for (let index = 0; index < steps.length; index++) {
        const zoom = Number(steps[index]);
        const tier = Number(tiers[index]);
        if (Number.isFinite(zoom) && zoom > 0 && isShotTier(tier)) shots.push({ zoom, tier });
    }
    if (!(width > 0 && height > 0) || !shots.length) {
        return Object.freeze({ survey: null, wide: null, medium: null, close: null });
    }
    let survey = null;
    for (const { zoom } of shots) {
        const halfW = width / (2 * zoom);
        const halfH = height / (2 * zoom);
        const share = islandAreaInWorldRect(
            ISLAND_CENTROID.x - halfW, ISLAND_CENTROID.y - halfH,
            ISLAND_CENTROID.x + halfW, ISLAND_CENTROID.y + halfH,
        ) / ISLAND_AREA;
        if (share >= SURVEY_ISLAND_SHARE && (survey == null || zoom > survey)) survey = zoom;
    }
    const framing = shots.filter(({ tier }) => tier >= 1 - 1e-6);
    const nearest = (target) => {
        let best = null;
        for (const { zoom } of framing) {
            const distance = Math.abs(Math.log((width / zoom) * (height / zoom) / target));
            if (!best || distance < best.distance - 1e-12) best = { zoom, distance };
        }
        return best ? best.zoom : null;
    };
    return Object.freeze({
        survey,
        wide: nearest(SHOT_SCALE_AREA.wide),
        medium: nearest(SHOT_SCALE_AREA.medium),
        close: nearest(SHOT_SCALE_AREA.close),
    });
}

// 4.2 — owners whose framing the camera composes by itself. Operator poses
// (`user`, including the `A` hold), follow and manual pan never land-weight.
function composesForLand(owner) {
    const name = String(owner || '');
    return name === 'system' || name === 'director' || name === 'idle-auto' || name === 'village-tour'
        || name.startsWith('ambient') || name.startsWith('cue:');
}

// W5.1 — the clamp pad `{ x, y }` (world px past the island's extreme corners)
// for a screen centre at `zoom` on a `viewportW × viewportH` (CSS px) canvas.
// Automatic owners (`composesForLand`) get max(96, 12 % of the view); the
// operator, follow, the resting clamp (`owner` null) and the release cue keep
// max(220 × 160, view / 2.2).
export function clampPadFor(owner, viewportW, viewportH, zoom) {
    if (composesForLand(owner) && String(owner) !== RELEASE_CUE_OWNER) {
        return {
            x: Math.max(AUTOMATIC_PAD.floor, (viewportW * AUTOMATIC_PAD.viewShare) / zoom),
            y: Math.max(AUTOMATIC_PAD.floor, (viewportH * AUTOMATIC_PAD.viewShare) / zoom),
        };
    }
    return {
        x: Math.max(OPERATOR_PAD.x, viewportW / (zoom * OPERATOR_PAD.viewDivisor)),
        y: Math.max(OPERATOR_PAD.y, viewportH / (zoom * OPERATOR_PAD.viewDivisor)),
    };
}

// W5.1 — the most sea (share of the frame) an automatic shot of a
// `viewW × viewH` world px view may keep: 30 %, or the least sea that view can
// show plus 5 points where the island cannot fill it.
export function landWeightSeaCap(viewW, viewH) {
    const area = viewW * viewH;
    if (!(area > 0)) return LAND_WEIGHT_MAX_SEA;
    return Math.max(LAND_WEIGHT_MAX_SEA, 1 - ISLAND_AREA / area + LAND_WEIGHT_SEA_SLACK);
}

// W5.1 — does the island's centre lie within the 10 % centring band of a
// view whose top-left world corner is `left, top`?
function islandCentred(left, top, viewW, viewH) {
    return Math.abs(ISLAND_CENTROID.x - (left + viewW / 2)) <= viewW * LAND_WEIGHT_CENTRE_BAND
        && Math.abs(ISLAND_CENTROID.y - (top + viewH / 2)) <= viewH * LAND_WEIGHT_CENTRE_BAND;
}

// 4.2 — would moving a view (viewW × viewH world px) from `left,top` to
// `nextLeft,nextTop` push an edge of the subject `box` into the 12 % inner
// margin (or, for an edge already in it, deeper toward the frame edge)?
// Edges already outside the frame, as on a fixed-scale wide, never hold it.
function pushesIntoMargin(box, viewW, viewH, left, top, nextLeft, nextTop) {
    const margins = [viewW * LAND_WEIGHT_MARGIN, viewW * LAND_WEIGHT_MARGIN, viewH * LAND_WEIGHT_MARGIN, viewH * LAND_WEIGHT_MARGIN];
    const gaps = (x, y) => [box.minX - x, x + viewW - box.maxX, box.minY - y, y + viewH - box.maxY];
    const before = gaps(left, top);
    const after = gaps(nextLeft, nextTop);
    return before.some((gap, side) => (
        gap >= margins[side] ? after[side] < margins[side] : gap >= 0 && after[side] < gap
    ));
}

// 4.5 — CSS px a whole sun or moon disc needs above the sea horizon.
function skyDiscClearancePx(width, height) {
    const short = Math.min(width, height);
    const radius = Math.max(
        Math.max(SUN_DISC_RADIUS.floor, short * SUN_DISC_RADIUS.share),
        Math.max(MOON_DISC_RADIUS.floor, short * MOON_DISC_RADIUS.share),
    );
    return radius * (1 + DISC_HORIZON_CLEARANCE_RADII) + 1;
}

export class Camera {
    constructor(canvas) {
        this.canvas = canvas;
        this.x = 0;
        this.y = 0;
        this._applyTierLadder(zoomTierLadder(backingDpr(canvas)));
        this.zoom = this.tierZoom(1);
        // 8.3 — the tier content re-frames and the opening settle on.
        this.defaultFrameTier = DEFAULT_FRAME_TIER;
        // 8.2 — false until the renderer reports a presented World frame (and
        // again while the World is hidden), so a follow that begins before
        // anything is on screen snaps instead of whipping into view.
        this._presented = false;
        this._followSpring = { vx: 0, vy: 0 };
        this._followTrack = null;
        this._zoomAnimation = null;
        this._reducedMotion = false;
        try {
            this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
        } catch {
            this._reducedMotion = false;
        }
        this.dragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.camStartX = 0;
        this.camStartY = 0;

        // Follow mechanism
        this.followTarget = null;      // AgentSprite reference
        this._followEase = null;       // timed entry glide when follow starts
        this._snapZoom = null;         // zoom-in animation on far-zoom selection

        // #21 — director-driven cinematic glide. A time-boxed cubic-ease move to
        // a framed world box, triggered by CameraDirector. It clears
        // `_userAdjusted` for its own duration and aborts the instant the user
        // touches the camera (drag/wheel/keyboard) so the cinema never fights.
        this._directorGlide = null;
        // 4.6 — whether flight frames render fat-pixel (the GL world is live;
        // WorldFrameRenderer sets it every frame). Without it a glide is
        // planned stepped (CameraCurves `rungs`) so the Canvas world rests on
        // integer rungs instead of crawling through fractional k.
        this.fatFlight = false;

        // Drag momentum (world px/ms, decays after release)
        this._momentum = null;
        this._dragVelX = 0;
        this._dragVelY = 0;
        this._lastDragX = 0;
        this._lastDragY = 0;
        this._lastDragTime = 0;

        // Set once the user manually pans/zooms, so auto-framing on resize
        // stops fighting their chosen view. Cleared by an explicit re-frame.
        this._userAdjusted = false;
        this._cameraOwner = 'system';

        // C6 (5.1) — frame ownership. `_cameraOwner` above names which motion
        // family moved the camera last; this names WHO is allowed to compose
        // the frame. An exclusive claim ('ambient', 'replay') is granted only
        // by an explicit operator control, is revoked by any genuine input, and
        // is never re-acquired on a timer. `auto`/`user` stay derived from the
        // fields above, so today's Auto timers are untouched.
        this._frameClaim = null;
        this._inputEpoch = 0;
        // 5.2 — letterbox bars held for a beat after an ambient chapter settles
        // ({ remaining, owner }); cue glides keep their arrival-only bars.
        this._letterboxHold = null;

        // #50 — inertial idle drift. After ~45s with no input (and nothing else
        // owning the camera) the view breathes along a tiny bounded Lissajous
        // path so a left-open ClaudeVille feels alive, not frozen. The offset is
        // applied on top of a captured base position and fully removed the
        // instant any input arrives. Reduced motion skips it entirely.
        this._lastInputAt = performance.now();
        // #attract — last GENUINE operator input (drag/zoom/keyboard nav). Distinct
        // from _lastInputAt, which the idle-drift logic bumps while a glide runs;
        // the auto-camera measures true idle time from this so its own glides don't
        // count as activity.
        this._lastUserInputAt = performance.now();
        this._idleDrift = null;       // { baseX, baseY, phase }

        // #54 — empty-village tour state. `_villageEmpty` is fed by the
        // 'village:population' event (BuildingSprite emits it on change);
        // `_villageTour` is non-null while the tour owns the frame.
        this._villageEmpty = false;
        this._villageEmptySince = null;
        this._villageTour = null;   // { index, dwellUntil }
        this._tourStopsCache = null;
        // 4.2 — sprite dims/anchor/alpha mask by asset id, set by the renderer
        // (`setSpriteMetrics`); landmark silhouettes are derived from it once.
        this._spriteMetrics = null;
        this._landmarkCache = null;
        this._onVillagePopulation = (payload) => this._handleVillagePopulation(payload);
        this._populationUnsub = null;

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);

        this.centerOnMap();
    }

    // 4.2 — `lookup(id)` → `{ dims: { w, h }, anchor: [x, y], mask }` for a
    // sprite asset, or null while it is not loaded.
    setSpriteMetrics(lookup) {
        this._spriteMetrics = typeof lookup === 'function' ? lookup : null;
        this._landmarkCache = null;
    }

    // World boxes of every building's drawn silhouette (opaque crown to sprite
    // bottom); empty until the renderer's assets resolve all of them (dims,
    // anchor and alpha mask).
    _landmarkSilhouettes() {
        if (this._landmarkCache) return this._landmarkCache;
        if (!this._spriteMetrics) return [];
        const out = [];
        for (const def of BUILDING_DEFS) {
            const metrics = this._spriteMetrics(`building.${def.type}`);
            const w = Number(metrics?.dims?.w);
            const h = Number(metrics?.dims?.h);
            const mask = metrics?.mask;
            if (!(w > 0) || !(h > 0) || typeof mask?.indexOf !== 'function' || !Array.isArray(metrics.anchor)) return [];
            const [anchorX, anchorY] = metrics.anchor;
            const firstOpaque = mask.indexOf(1);
            const center = buildingCenterToWorld(def);
            const left = Math.round(center.x - anchorX);
            const top = Math.round(center.y - anchorY);
            out.push({
                type: def.type,
                minX: left,
                maxX: left + w,
                minY: top + Math.floor(Math.max(0, firstOpaque) / w),
                maxY: top + h,
                centerX: center.x,
            });
        }
        this._landmarkCache = out;
        return out;
    }

    centerOnMap() {
        // Frame the village core while giving the right-side harbor sea lanes more room.
        const tx = 33, ty = 18;
        const screen = tileToWorld(tx, ty);
        this._idleDrift = null;
        this.zoom = this.tierZoom(1);
        if (!this.canvas) return;
        this.x = -screen.x + this._viewportWidth() / (2 * this.zoom);
        this.y = -screen.y + this._viewportHeight() / (2 * this.zoom);
        this._clampToBounds();
    }

    // 4.1 — the ladder changes only with the backing DPR (`_syncDisplayPixelZoom`
    // returns early otherwise), but the shot scales change with every size, so
    // they are recomputed here on every call.
    onViewportResize() {
        if (!this._syncDisplayPixelZoom()) this._refreshShotScales();
        this._clampToBounds();
    }

    _applyTierLadder({ steps, tiers }) {
        this.zoomSteps = steps;
        this.zoomTiers = tiers;
        this.minZoom = steps[0];
        this.maxZoom = steps[steps.length - 1];
        // A stepped (Canvas) glide rests on the logical tiers only: 4.8's half
        // rungs are operator rests, so a DPR-2 glide takes no more steps.
        this._glideRungs = Object.freeze(steps.filter((_, index) => isShotTier(tiers[index])));
        this._refreshShotScales();
        this._displayPixelZoomScale = this.tierZoom(1);
    }

    // 4.1 — cache the shot scales for the current viewport. The tour's stops
    // are solved from them, so a change drops that cache too.
    _refreshShotScales() {
        const next = shotScaleTiers(this._viewportWidth(), this._viewportHeight(), {
            steps: this.zoomSteps,
            tiers: this.zoomTiers,
        });
        const previous = this.shotScales;
        this.shotScales = next;
        if (!previous || SHOT_SCALE_NAMES.some((name) => previous[name] !== next[name])) this._tourStopsCache = null;
        return next;
    }

    // 4.1 — the resting zoom of a shot scale ('survey' | 'wide' | 'medium' |
    // 'close'), or null (no survey on this viewport, or no viewport yet).
    shotZoom(name) {
        const zoom = this.shotScales?.[name];
        return Number.isFinite(zoom) ? zoom : null;
    }

    // The logical tier label of a shot scale: the unit every `maxZoom` and
    // `minZoom` option takes. Before the viewport is laid out the scales fall
    // back to the old labels (wide 1, medium 2, close 3); a viewport with no
    // survey returns null for it.
    shotTier(name) {
        const zoom = this.shotZoom(name);
        const index = zoom == null ? -1 : this.zoomSteps.indexOf(zoom);
        return index >= 0 ? this.zoomTiers[index] : FALLBACK_SHOT_TIER[name] ?? null;
    }

    // The camera zoom for a logical tier label (SURVEY_TIER, 1, 2, 3, or a
    // 4.8 half rung). SURVEY_TIER is the survey shot wherever the viewport has
    // one (see SURVEY_TIER); a label this ladder lacks — a DPR-2 half rung
    // after the window moves to a DPR-1 screen — resolves to the rung below it.
    tierZoom(tier) {
        if (Math.abs(tier - SURVEY_TIER) < 1e-6) {
            const survey = this.shotZoom('survey');
            if (survey != null) return survey;
        }
        const index = this.zoomTiers.findIndex((label) => Math.abs(label - tier) < 1e-6);
        if (index >= 0) return this.zoomSteps[index];
        if (tier < 1) return this.zoomSteps[this.zoomTiers.indexOf(1)];
        for (let below = this.zoomTiers.length - 1; below >= 0; below--) {
            if (this.zoomTiers[below] <= tier) return this.zoomSteps[below];
        }
        return this.maxZoom;
    }

    _syncDisplayPixelZoom() {
        const next = zoomTierLadder(backingDpr(this.canvas));
        const currentSteps = this.zoomSteps;
        const currentTiers = this.zoomTiers;
        if (next.steps.length === currentSteps.length
            && next.steps.every((step, index) => Math.abs(step - currentSteps[index]) < 1e-6)) return false;

        // A pose already resting on a tier moves to the SAME tier on the new
        // grid; only mid-tween values are scaled. Scaling a resting pose by the
        // tier-1 ratio would land it between the new tiers, off the pixel grid.
        // A survey pose lands on the new grid's survey shot, or tier 1.
        const previousTierOne = this._displayPixelZoomScale || 1;
        this._applyTierLadder(next);
        const ratio = this._displayPixelZoomScale / previousTierOne;
        const remap = (value) => {
            if (!Number.isFinite(value)) return value;
            const index = currentSteps.findIndex((step) => Math.abs(step - value) < 1e-6);
            return index >= 0 ? this.tierZoom(currentTiers[index]) : value * ratio;
        };
        this.zoom = remap(this.zoom);

        // Preserve in-flight camera motion across a live browser-zoom change.
        // CSS viewport dimensions change by the inverse ratio, so the centre
        // stays put while every stored zoom endpoint needs the same remapping.
        for (const motion of [this._zoomAnimation, this._snapZoom, this._directorGlide]) {
            if (!motion) continue;
            motion.fromZoom = remap(motion.fromZoom);
            motion.toZoom = remap(motion.toZoom);
            if (motion.plan) {
                motion.plan.from.zoom = motion.fromZoom;
                motion.plan.to.zoom = motion.toZoom;
                motion.plan.ratio = motion.toZoom / motion.fromZoom;
                for (const step of motion.plan.steps || []) {
                    step.fromZoom = remap(step.fromZoom);
                    step.toZoom = remap(step.toZoom);
                }
            }
        }
        return true;
    }

    // Frame an axis-aligned world box so it fits the viewport, centered on the
    // box, at the largest display-pixel-aligned zoom up to `maxZoom`. Used for
    // the initial "overview of my active agents" framing.
    fitToWorldBox(box, { paddingPx = 96, maxZoom = 2, minZoom = 1, owner = 'system', composition = null } = {}) {
        const pose = this._poseForWorldBox(box, { paddingPx, maxZoom, minZoom, composition, owner });
        if (!pose) return;
        this._endVillageTour({ restore: false });
        this._zoomAnimation = null;
        this._snapZoom = null;
        this._momentum = null;
        this._idleDrift = null;
        this._cameraOwner = owner;
        this._userAdjusted = false;
        this.zoom = pose.zoom;
        this.x = pose.x;
        this.y = pose.y;
        this._clampToBounds();
    }

    // #21 — solve the largest resting zoom that fits a world box, shared by
    // fitToWorldBox and the director glide so framing stays consistent. The
    // search stops at `minZoom` (a tier label; tier 1 by default), so only a
    // caller that asks for it ever lands on the survey tier.
    _zoomForWorldBox(box, paddingPx = 96, maxZoom = 2, minZoom = 1) {
        const hi = this._zoomStepIndexForLimit(maxZoom);
        const lo = Math.min(hi, this._zoomStepIndexForLimit(minZoom));
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !box) return this.zoomSteps[lo];
        const boxW = Math.max(1, box.maxX - box.minX);
        const boxH = Math.max(1, box.maxY - box.minY);
        for (let index = hi; index >= lo; index--) {
            const z = this.zoomSteps[index];
            if (boxW * z + paddingPx * 2 <= w && boxH * z + paddingPx * 2 <= h) return z;
        }
        return this.zoomSteps[lo];
    }

    _zoomStepIndexForLimit(maxZoom = 2) {
        const limit = Number(maxZoom);
        if (!Number.isFinite(limit)) return this.zoomSteps.length - 1;

        // Tier labels (SURVEY_TIER, 1, 2, 3, half rungs) are logical tiers;
        // SURVEY_TIER is the survey shot where the viewport has one. Other
        // limits are accepted for capture/debug callers that already hold a zoom.
        if (Math.abs(limit - SURVEY_TIER) < 1e-6) {
            const survey = this.shotZoom('survey');
            if (survey != null) return this.zoomSteps.indexOf(survey);
        }
        const tierIndex = this.zoomTiers.findIndex((label) => Math.abs(label - limit) < 1e-6);
        if (tierIndex >= 0) return tierIndex;
        if (limit < 1) return this.zoomTiers.indexOf(1);

        for (let index = this.zoomSteps.length - 1; index >= 0; index--) {
            if (this.zoomSteps[index] <= limit + 1e-6) return index;
        }
        return 0;
    }

    _maxZoomForLimit(maxZoom = 2) {
        return this.zoomSteps[this._zoomStepIndexForLimit(maxZoom)];
    }

    resolveRestingZoom(zoom) {
        const requested = Number(zoom);
        if (!Number.isFinite(requested)) return this.tierZoom(1);

        const aligned = this.zoomSteps.find((step) => Math.abs(step - requested) < 1e-6);
        if (aligned != null) return aligned;
        const tierIndex = this.zoomTiers.findIndex((label) => Math.abs(label - requested) < 1e-6);
        if (tierIndex >= 0) return this.zoomSteps[tierIndex];
        return this.zoomSteps.reduce((nearest, step) => (
            Math.abs(step - requested) < Math.abs(nearest - requested) ? step : nearest
        ), this.minZoom);
    }

    // The tier label nearest the current zoom (SURVEY_TIER, 1, 2, 3, or a 4.8 half rung).
    currentZoomTier() {
        const currentIndex = this.zoomSteps.reduce((nearestIndex, step, index) => (
            Math.abs(step - this.zoom) < Math.abs(this.zoomSteps[nearestIndex] - this.zoom)
                ? index
                : nearestIndex
        ), 0);
        return this.zoomTiers[currentIndex];
    }

    // C6 — the frame owner an operator can reason about: 'user' while their own
    // pose stands, 'auto' for today's timed director, or the exclusive claim
    // held by Ambient (5.1/5.2) or the spatial replay (5.4).
    get owner() {
        if (this._frameClaim) return this._frameClaim;
        return this._cameraOwner === 'user' || this._userAdjusted ? 'user' : 'auto';
    }

    // Monotonic count of genuine operator inputs. A saved shot compares this
    // instead of a timestamp so "nothing happened since" is exact.
    get inputEpoch() {
        return this._inputEpoch;
    }

    // Grant an exclusive claim from an explicit control. Returns { owner, epoch }
    // or false for anything that is not a claimable owner.
    claimOwner(owner) {
        const next = owner === 'ambient' || owner === 'replay' ? owner : null;
        if (!next) return false;
        const previous = this.owner;
        this._frameClaim = next;
        // The new claimant composes from wherever the frame is now: an in-flight
        // move that belongs to someone else is dropped, never fought. (A system
        // re-frame is often still running when the operator asks for Ambient.)
        const glideOwner = String(this._directorGlide?.owner || '');
        if (this._directorGlide && glideOwner !== next && !glideOwner.startsWith(`${next}:`)) {
            this._directorGlide = null;
            this._cameraOwner = next;
        }
        if (previous !== next) this._emitOwner(previous, 'claim');
        return { owner: next, epoch: this._inputEpoch };
    }

    // Release a claim the caller still holds. A stale release is a no-op, so a
    // revoked owner can never yank the frame back from whoever took it.
    releaseOwner(owner) {
        if (!this._frameClaim || this._frameClaim !== owner) return false;
        const previous = this._frameClaim;
        this._frameClaim = null;
        this._letterboxHold = null;
        this._emitOwner(previous, 'release');
        return true;
    }

    // C6 — revoke a claim on a genuine operator action that is not a camera
    // input (a selection, an explicit frame command). The epoch advances, so a
    // saved shot's return address is correctly invalidated, but the auto
    // camera's own idle clock is untouched: Auto keeps today's timings.
    revokeClaim(reason = 'input') {
        const claim = this._frameClaim;
        if (!claim) return false;
        this._frameClaim = null;
        this._letterboxHold = null;
        this._inputEpoch += 1;
        this._emitOwner(claim, reason);
        return true;
    }


    _emitOwner(previous, reason) {
        eventBus.emit('camera:owner', {
            owner: this.owner,
            previous,
            epoch: this._inputEpoch,
            reason,
        });
    }

    // #21 — start a director glide to frame `box`. Reduced motion (or a missing
    // viewport) cuts directly. The move releases `_userAdjusted` only while it
    // runs, then re-frames cleanly. A glide never grades the world (V3); its
    // only frame treatment is the letterbox it owns.
    //
    // 8.1 — the duration is never authored per call site: CameraCurves derives
    // it from the screen distance and zoom ratio. `motion` picks the family
    // ('director' easeInOutCubic; 'ambient' easeInOutSine, slower).
    glideToWorld(box, {
        paddingPx = 96,
        maxZoom = 2,
        minZoom = 1,
        holdMs = 0,
        owner = 'director',
        motion = 'director',
        userAdjustedOnComplete = false,
        composition = null,
        preferPan = false,
        zoomHysteresis = 0.85,
        allowZoomIn = true,
        // 5.2 — bars this move owns, held this long after it settles. Zero
        // keeps the cue behaviour (bars ride the glide and end on arrival).
        letterbox = false,
        letterboxHoldMs = 0,
        // 4.2 — an establishing shot (the Ambient wide) keeps landmark tops,
        // never at the expense of a whole body in `bodies` (feet points).
        keepLandmarks = false,
        bodies = null,
    } = {}) {
        const pose = this._poseForWorldBox(box, {
            paddingPx,
            maxZoom,
            minZoom,
            composition,
            preferPan,
            zoomHysteresis,
            allowZoomIn,
            owner,
            keepLandmarks,
            bodies,
        });
        if (!pose) return false;
        // Anything but the tour's own stops ends the tour (cues, attract moves).
        if (owner !== 'village-tour') this._endVillageTour({ restore: false });
        return this._startGlide(pose, {
            owner,
            motion,
            holdMs,
            letterbox,
            letterboxHoldMs,
            userAdjustedOnComplete,
        });
    }

    // C6 — glide back to an exact saved pose (5.2's return address). A box glide
    // would re-solve the framing; a chapter has to land on the composition the
    // operator was already reading.
    glideToPose(pose, { owner = 'director', motion = 'director', letterbox = false, letterboxHoldMs = 0 } = {}) {
        const target = this._restingPose(pose);
        if (!target) return false;
        this._endVillageTour({ restore: false });
        // A restored composition is deliberate: a relayout must keep it
        // instead of re-framing to content behind the caller's back.
        return this._startGlide(target, {
            owner,
            motion,
            letterbox,
            letterboxHoldMs,
            userAdjustedOnComplete: true,
        });
    }

    // A saved pose on the current resting ladder. Poses carrying the screen
    // centre (`cx`/`cy`, see capturePose) keep that centre across a viewport
    // change; older poses fall back to their offsets.
    _restingPose(pose) {
        if (!pose || ![pose.x, pose.y, pose.zoom].every(Number.isFinite)) return null;
        const zoom = this.resolveRestingZoom(pose.zoom);
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (w && h && Number.isFinite(pose.cx) && Number.isFinite(pose.cy)) {
            return { zoom, x: w / (2 * zoom) - pose.cx, y: h / (2 * zoom) - pose.cy };
        }
        return { zoom, x: pose.x, y: pose.y };
    }

    // 8.1 / 4.6 — one glide in the shared vocabulary: a continuous dolly in
    // which the screen-centre world point and the log-zoom move together on
    // the family curve (CameraCurves.planGlide), ending on the target's
    // resting tier. Its flight frames render fat-pixel on a sub-pixel offset
    // (`renderOffsetGpuX`); the target is snapped to a whole backing pixel so
    // the landing frame is today's nearest frame with no settling nudge.
    // Without fat flight frames (`fatFlight` false: the Canvas world) the same
    // dolly is planned stepped on the logical rungs. `durationMs` is only for
    // the authored opening.
    _startGlide(pose, {
        owner = 'director',
        motion = 'director',
        holdMs = 0,
        durationMs = null,
        letterbox = false,
        letterboxHoldMs = 0,
        userAdjustedOnComplete = false,
    } = {}) {
        this.stopFollow();
        this._momentum = null;
        this._zoomAnimation = null;
        this._snapZoom = null;
        this._idleDrift = null;

        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (this._reducedMotion || !w || !h) {
            // Reduced motion: cut directly to the framed view, no glide, no bars.
            this.zoom = pose.zoom;
            this.x = pose.x;
            this.y = pose.y;
            this._directorGlide = null;
            this._cameraOwner = owner;
            this._userAdjusted = Boolean(userAdjustedOnComplete);
            this._clampToBounds();
            return true;
        }

        const clampedTo = this._clampedCenter(w / (2 * pose.zoom) - pose.x, h / (2 * pose.zoom) - pose.y, pose.zoom, owner);
        const backingScale = pose.zoom * this._dpr();
        const toCenter = {
            x: w / (2 * pose.zoom) - Math.round((w / (2 * pose.zoom) - clampedTo.x) * backingScale) / backingScale,
            y: h / (2 * pose.zoom) - Math.round((h / (2 * pose.zoom) - clampedTo.y) * backingScale) / backingScale,
        };
        const fromCenter = this.currentCenterWorld();
        const plan = planGlide(
            { cx: fromCenter.x, cy: fromCenter.y, zoom: this.zoom },
            { cx: toCenter.x, cy: toCenter.y, zoom: pose.zoom },
            { family: motion, duration: durationMs, rungs: this.fatFlight ? null : this._glideRungs },
        );
        this._cameraOwner = owner;
        this._userAdjusted = false;
        this._directorGlide = {
            plan,
            fromZoom: this.zoom,
            toZoom: pose.zoom,
            elapsed: 0,
            duration: plan.total,
            owner,
            userAdjustedOnComplete: Boolean(userAdjustedOnComplete),
            // #45 — optional hold (the opening lingers on the wide frame before
            // the move begins). Counts down before `elapsed` advances.
            hold: Math.max(0, Number(holdMs) || 0),
            letterbox: Boolean(letterbox) || letterboxHoldMs > 0,
            letterboxHoldMs: Math.max(0, Number(letterboxHoldMs) || 0),
        };
        return true;
    }

    // 8.3/4.1 — the opening shot. The first presented frame is the whole
    // island at the survey scale (the wide where the viewport has no survey),
    // with 4.5's sky room wherever the island leaves vertical slack; it holds
    // 1.6 s at rest, then one 2.4 s continuous dolly (4.6) settles on the
    // target: a content box between the wide and medium scales (a box too big
    // for the wide is land-weighted, not widened back to the survey), or an
    // authored pose (scenario metadata). Reduced motion cuts straight to the
    // target frame.
    establishingShot(wideBox, { targetBox = null, targetPose = null, maxZoom = this.shotTier('medium') } = {}) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h) return false;
        const target = targetPose
            ? this._restingPose(targetPose)
            : this._poseForWorldBox(targetBox, { maxZoom, minZoom: this.shotTier('wide'), owner: 'system', keepLandmarks: true });
        if (!target) return false;
        this._endVillageTour({ restore: false });
        if (this._reducedMotion) {
            return this._startGlide(target, { owner: 'system' });
        }
        const openTier = this.shotZoom('survey') != null ? SURVEY_TIER : this.shotTier('wide');
        const wide = this._poseForWorldBox(wideBox || targetBox, {
            paddingPx: 0,
            maxZoom: openTier,
            minZoom: openTier,
            composition: OPENING_COMPOSITION,
        });
        if (wide) {
            this.stopFollow();
            this.zoom = wide.zoom;
            this.x = wide.x;
            this.y = wide.y;
            this._clampToBounds();
        }
        return this._startGlide(target, {
            owner: 'system',
            holdMs: OPENING_HOLD_MS,
            durationMs: OPENING_DOLLY_MS,
        });
    }

    // 8.3/4.1 — `F`: a content box that spans most of the island widens to the
    // survey shot (tier 1 where the viewport has none) instead of cropping it.
    frameTierFloorForBox(box) {
        if (!box) return 1;
        const corners = mapWorldCorners(MAP_SIZE);
        const islandW = Math.max(...corners.map(p => p.x)) - Math.min(...corners.map(p => p.x));
        const islandH = Math.max(...corners.map(p => p.y)) - Math.min(...corners.map(p => p.y));
        const wide = (box.maxX - box.minX) >= islandW * SURVEY_BOX_SHARE
            || (box.maxY - box.minY) >= islandH * SURVEY_BOX_SHARE;
        return wide ? SURVEY_TIER : 1;
    }

    abortDirectorGlide() {
        if (!this._directorGlide) return;
        this._directorGlide = null;
        // The user is now in control; stop auto-framing from fighting them.
        this._cameraOwner = 'user';
        this._userAdjusted = true;
    }

    isDirectorGliding() {
        return Boolean(this._directorGlide);
    }

    // 8.2 — the renderer reports its first presented frame after boot or a
    // return from Dashboard (`world:first-frame`); the World being hidden
    // clears it. Only the follow entry reads it.
    setPresented(presented) {
        this._presented = Boolean(presented);
    }

    // #attract — record genuine operator input and report how long since the last.
    // Used by the CameraDirector's idle-attract mode for engage/yield decisions.
    //
    // C6 — this is also the revocation point: a genuine input bumps the input
    // epoch and drops any exclusive claim (Ambient, replay) on the spot. Nothing
    // re-acquires a claim on a timer; the operator has to ask again.
    noteUserInput() {
        const now = performance.now();
        this._lastInputAt = now;
        this._lastUserInputAt = now;
        this._inputEpoch += 1;
        // #54 — operator input yields the empty-village tour instantly, right where it stands.
        this._endVillageTour({ restore: false });
        const claim = this._frameClaim;
        this._frameClaim = null;
        this._letterboxHold = null;
        this._cameraOwner = 'user';
        this._userAdjusted = true;
        if (claim) this._emitOwner(claim, 'input');
    }

    // C6 — a selection is a genuine operator action: it revokes Ambient without
    // pretending the operator touched the camera, so Auto's idle clock is
    // unchanged and only the claim is handed back.
    noteSelectionInput() {
        this.revokeClaim('selection');
    }

    getUserIdleMs(now = performance.now()) {
        return now - this._lastUserInputAt;
    }

    // 5.2 — the letterbox the frame renderer should draw right now: the bars a
    // glide owns (release and incident cues, ambient chapters) while it runs,
    // or an ambient chapter's bars held for a beat after the move settles so
    // the caption can be read at rest. The hold counts down in dt inside
    // update(), never against a wall clock: the frame pass and the camera do
    // not share one.
    getLetterboxState() {
        const hold = this._letterboxHold;
        if (hold && !this._directorGlide) {
            return { weight: 1, owner: hold.owner, held: true };
        }
        const glide = this._directorGlide;
        if (!glide || this._reducedMotion || !glide.letterbox) return null;
        const weight = Math.max(0, Math.sin(Math.PI * Math.min(1, glide.elapsed / glide.duration)));
        return { weight, owner: String(this._cameraOwner || ''), held: false };
    }

    attach() {
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
        // #54 — village population feed for the empty-village tour.
        if (!this._populationUnsub) {
            this._populationUnsub = eventBus.on('village:population', this._onVillagePopulation);
        }
    }

    detach() {
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('wheel', this._onWheel);
        if (this._populationUnsub) {
            this._populationUnsub();
            this._populationUnsub = null;
        }
        this._villageTour = null;
    }

    followAgent(sprite) {
        if (this.followTarget === sprite) return;
        this.noteSelectionInput();
        this._endVillageTour({ restore: false });
        this._directorGlide = null;
        this._cameraOwner = 'follow';
        this.followTarget = sprite;
        this._momentum = null;
        this._followSpring = { vx: 0, vy: 0 };
        const detailZoom = this.tierZoom(this.defaultFrameTier);
        const farZoomedOut = this.zoom < detailZoom - 1e-6;
        if (this._reducedMotion || !this._presented) {
            // 8.2 — nothing on screen yet (or reduced motion): cut to the
            // composed frame so the first visible frames never whip-pan.
            this._followEase = null;
            this._snapZoom = null;
            this._zoomAnimation = null;
            if (farZoomedOut) this.zoom = detailZoom;
            const aim = this._followAimCenter(sprite);
            if (aim) this._setCenter(aim.x, aim.y);
            return;
        }
        const from = this.currentCenterWorld();
        this._followEase = { fromCx: from.x, fromCy: from.y, elapsed: 0, duration: FOLLOW_ENTRY_MS };
        if (farZoomedOut) {
            this._zoomAnimation = null;
            this._snapZoom = { fromZoom: this.zoom, toZoom: detailZoom, elapsed: 0, duration: 380 };
        }
    }

    stopFollow() {
        this.followTarget = null;
        this._followEase = null;
        this._snapZoom = null;
        this._momentum = null;
        this._followSpring = { vx: 0, vy: 0 };
    }

    capturePose() {
        const center = this.currentCenterWorld();
        return {
            x: this.x,
            y: this.y,
            zoom: this.zoom,
            // The screen-centre world point, so a pose survives a viewport
            // change (the Dashboard round trip, a sidebar toggle).
            cx: center.x,
            cy: center.y,
            owner: this._cameraOwner,
            userAdjusted: this._userAdjusted,
            inputAt: this._lastUserInputAt,
            // C6 — the exact "nothing happened since" test for a saved shot.
            frameOwner: this.owner,
            epoch: this._inputEpoch,
        };
    }

    restorePose(pose) {
        const target = this._restingPose(pose);
        if (!target) return false;
        this.stopFollow();
        this._zoomAnimation = null;
        this._directorGlide = null;
        this.zoom = target.zoom;
        this.x = target.x;
        this.y = target.y;
        this._cameraOwner = pose.owner || 'system';
        this._userAdjusted = false;
        this._clampToBounds();
        return true;
    }

    // 0.5 — put the World back exactly as it was before a Dashboard trip:
    // same centre, zoom, owner and manual-control flag. Follow and any
    // in-flight glide are left alone (they own the frame already).
    resumeViewPose(pose) {
        if (this.followTarget || this._directorGlide) return false;
        const target = this._restingPose(pose);
        if (!target) return false;
        this.zoom = target.zoom;
        this.x = target.x;
        this.y = target.y;
        this._cameraOwner = pose.owner || this._cameraOwner;
        this._userAdjusted = Boolean(pose.userAdjusted);
        this._clampToBounds();
        return true;
    }

    setReducedMotion(enabled) {
        this._reducedMotion = Boolean(enabled);
        if (this._reducedMotion) {
            this._zoomAnimation = null;
            this._snapZoom = null;
            this._momentum = null;
            this._followEase = null;
            this._directorGlide = null;
            this._idleDrift = null;
            // #54 — a live tour holds where it stands: no circuit.
        }
    }

    // 8.2 — the screen-centre world point that puts the follow target on the
    // aim point of the composition window.
    _followAimCenter(sprite = this.followTarget) {
        const h = this._viewportHeight();
        if (!sprite || !h || !(this.zoom > 0)) return null;
        return {
            x: Number(sprite.x) || 0,
            y: (Number(sprite.y) || 0) - ((FOLLOW_AIM_Y - 0.5) * h) / this.zoom,
        };
    }

    // 8.2 — composition window, not a leash. The villager walks freely inside
    // the window; leaving it pulls the camera back to the window edge on a
    // critically damped spring (ω 3.5/s) that also matches the villager's
    // walking speed on that axis, so a steady walk rides the window edge
    // instead of trailing 2v/ω behind it; standing still relaxes it to the
    // aim point (ω 1.2/s, ~2 s). Reduced motion keeps the hard lock.
    updateFollow(dt = 16) {
        const sprite = this.followTarget;
        if (!sprite) return;
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const aim = this._followAimCenter(sprite);
        if (!w || !h || !aim) return;
        const frameDt = Math.max(0, Math.min(50, Number(dt) || 16));
        const track = this._trackFollowVelocity(aim, frameDt);
        if (this._reducedMotion) {
            this._setCenter(aim.x, aim.y);
            return;
        }
        if (this._followEase) {
            // 500 ms entry, easeInOutCubic, onto the aim point; the spring
            // takes over from rest.
            const ease = this._followEase;
            ease.elapsed += dt;
            const t = Math.min(1, ease.elapsed / ease.duration);
            const eased = easeInOutCubic(t);
            this._setCenter(
                ease.fromCx + (aim.x - ease.fromCx) * eased,
                ease.fromCy + (aim.y - ease.fromCy) * eased,
            );
            if (t >= 1) {
                this._followEase = null;
                this._followSpring = { vx: 0, vy: 0 };
            }
            return;
        }
        const center = this.currentCenterWorld();
        let targetX = aim.x;
        let targetY = aim.y;
        let targetVx = 0;
        let targetVy = 0;
        let omega = FOLLOW_RELAX_OMEGA;
        if (sprite.moving) {
            omega = FOLLOW_OMEGA;
            const halfW = (w * FOLLOW_WINDOW_W) / (2 * this.zoom);
            const halfH = (h * FOLLOW_WINDOW_H) / (2 * this.zoom);
            const dx = aim.x - center.x;
            const dy = aim.y - center.y;
            targetX = center.x;
            targetY = center.y;
            if (Math.abs(dx) > halfW) {
                targetX += dx - Math.sign(dx) * halfW;
                targetVx = track.vx;
            }
            if (Math.abs(dy) > halfH) {
                targetY += dy - Math.sign(dy) * halfH;
                targetVy = track.vy;
            }
        }
        const spring = this._followSpring;
        const stepX = criticalSpringStep(center.x, spring.vx, targetX, omega, frameDt, targetVx);
        const stepY = criticalSpringStep(center.y, spring.vy, targetY, omega, frameDt, targetVy);
        this._setCenter(stepX.x, stepY.x);
        const settled = this.currentCenterWorld();
        // Velocity absorbed by the world bounds is dropped, not stored.
        spring.vx = Math.abs(settled.x - stepX.x) > 0.5 ? 0 : stepX.v;
        spring.vy = Math.abs(settled.y - stepY.x) > 0.5 ? 0 : stepY.v;
    }

    // Smoothed walking velocity of the follow target (world px/ms), so waypoint
    // corners do not kick the camera.
    _trackFollowVelocity(point, dt) {
        const track = this._followTrack;
        if (!track || track.target !== this.followTarget || !(dt > 0)) {
            this._followTrack = { target: this.followTarget, x: point.x, y: point.y, vx: 0, vy: 0 };
            return this._followTrack;
        }
        const alpha = 1 - Math.exp(-dt / 120);
        track.vx += ((point.x - track.x) / dt - track.vx) * alpha;
        track.vy += ((point.y - track.y) / dt - track.vy) * alpha;
        track.x = point.x;
        track.y = point.y;
        return track;
    }

    update(dt = 16, renderNow = performance.now()) {
        // 5.2 — the held chapter bars expire in frame time, so a paused World
        // never leaves them standing and no second clock is involved.
        if (this._letterboxHold) {
            this._letterboxHold.remaining -= dt;
            if (this._letterboxHold.remaining <= 0) this._letterboxHold = null;
        }
        this._updateVillageTour(dt, renderNow);
        if (this._updateDirectorGlide(dt)) return;
        this._updateMomentum(dt);
        this._updateSnapZoom(dt);
        this._updateIdleDrift(dt, renderNow);
        if (!this._zoomAnimation) return;
        // 8.1 — the wheel keeps its 150 ms easeOutCubic tier step, about the
        // cursor, with the zoom moving in log space.
        const anim = this._zoomAnimation;
        anim.elapsed += dt;
        const t = Math.min(1, anim.elapsed / anim.duration);
        this.zoom = t >= 1 ? anim.toZoom : logZoom(anim.fromZoom, anim.toZoom, easeOutCubic(t));
        this.x = (anim.mouseX / this.zoom) - anim.worldBeforeX;
        this.y = (anim.mouseY / this.zoom) - anim.worldBeforeY;
        if (t >= 1) this._zoomAnimation = null;
        this._clampToBounds();
    }

    _onMouseDown(e) {
        if (e.button !== 0) return;
        this.noteUserInput();
        this.abortDirectorGlide();
        this._endIdleDrift();
        this.dragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.camStartX = this.x;
        this.camStartY = this.y;
        this._momentum = null;
        this._snapZoom = null;
        this._dragVelX = 0;
        this._dragVelY = 0;
        this._lastDragX = e.clientX;
        this._lastDragY = e.clientY;
        this._lastDragTime = performance.now();
        this.canvas.style.cursor = 'grabbing';
        // Stop following when dragging starts
        if (this.followTarget) this.stopFollow();
    }

    _onMouseMove(e) {
        if (!this.dragging) return;
        this.noteUserInput();
        const dx = (e.clientX - this.dragStartX) / this.zoom;
        const dy = (e.clientY - this.dragStartY) / this.zoom;
        this.x = this.camStartX + dx;
        this.y = this.camStartY + dy;
        const now = performance.now();
        const elapsed = now - this._lastDragTime;
        if (elapsed > 0) {
            // Exponentially smoothed screen-space velocity (px/ms).
            const vx = (e.clientX - this._lastDragX) / elapsed;
            const vy = (e.clientY - this._lastDragY) / elapsed;
            this._dragVelX = this._dragVelX * 0.6 + vx * 0.4;
            this._dragVelY = this._dragVelY * 0.6 + vy * 0.4;
            this._lastDragX = e.clientX;
            this._lastDragY = e.clientY;
            this._lastDragTime = now;
        }
        this._clampToBounds();
    }

    _onMouseUp() {
        if (!this.dragging) return;
        this.dragging = false;
        this.canvas.style.cursor = 'grab';
        if (this._reducedMotion) return;
        // No fling if the pointer rested before release.
        if (performance.now() - this._lastDragTime > 80) return;
        const speed = Math.hypot(this._dragVelX, this._dragVelY);
        if (speed < 0.05) return;
        this._momentum = {
            vx: this._dragVelX / this.zoom,
            vy: this._dragVelY / this.zoom,
        };
    }

    _onWheel(e) {
        e.preventDefault();
        this.noteUserInput();
        this.abortDirectorGlide();
        this._endIdleDrift();
        this._momentum = null;
        this._snapZoom = null;
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const worldBeforeX = (mouseX / this.zoom) - this.x;
        const worldBeforeY = (mouseY / this.zoom) - this.y;

        const direction = e.deltaY < 0 ? 1 : -1;
        const steps = this.zoomSteps;
        const currentIndex = steps.reduce((bestIndex, step, index) => (
            Math.abs(step - this.zoom) < Math.abs(steps[bestIndex] - this.zoom) ? index : bestIndex
        ), 0);
        const nextIndex = Math.max(0, Math.min(steps.length - 1, currentIndex + direction));
        const targetZoom = steps[nextIndex];
        if (targetZoom === this.zoom) return;
        this._userAdjusted = true;

        if (this._reducedMotion) {
            this.zoom = targetZoom;
            this.x = (mouseX / this.zoom) - worldBeforeX;
            this.y = (mouseY / this.zoom) - worldBeforeY;
            this._clampToBounds();
            return;
        }

        this._zoomAnimation = {
            fromZoom: this.zoom,
            toZoom: targetZoom,
            mouseX,
            mouseY,
            worldBeforeX,
            worldBeforeY,
            elapsed: 0,
            duration: WHEEL_STEP_MS,
        };
    }

    worldToScreen(worldX, worldY) {
        return {
            x: worldX * this.zoom + this.renderOffsetX,
            y: worldY * this.zoom + this.renderOffsetY,
        };
    }

    screenToWorld(screenX, screenY) {
        return {
            x: (screenX - this.renderOffsetX) / this.zoom,
            y: (screenY - this.renderOffsetY) / this.zoom,
        };
    }

    screenToTile(screenX, screenY) {
        const world = this.screenToWorld(screenX, screenY);
        const { tileX, tileY } = worldToTile(world);
        return { tileX: Math.floor(tileX), tileY: Math.floor(tileY) };
    }

    getViewportTileBounds(margin = 0) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const corners = [
            this.screenToTile(0, 0),
            this.screenToTile(w, 0),
            this.screenToTile(w, h),
            this.screenToTile(0, h),
        ];
        const xs = corners.map(c => c.tileX);
        const ys = corners.map(c => c.tileY);
        return {
            startX: Math.max(0, Math.min(...xs) - margin),
            endX: Math.min(MAP_SIZE - 1, Math.max(...xs) + margin),
            startY: Math.max(0, Math.min(...ys) - margin),
            endY: Math.min(MAP_SIZE - 1, Math.max(...ys) + margin),
            corners,
        };
    }

    centerOnTile(tileX, tileY) {
        const screen = tileToWorld(tileX, tileY);
        this._idleDrift = null;
        this._endVillageTour({ restore: false });
        this._cameraOwner = 'system';
        this._userAdjusted = false;
        this.x = -screen.x + this._viewportWidth() / (2 * this.zoom);
        this.y = -screen.y + this._viewportHeight() / (2 * this.zoom);
        this._clampToBounds();
    }

    currentCenterWorld() {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !Number.isFinite(this.zoom) || this.zoom <= 0) return { x: 0, y: 0 };
        return {
            x: w / (2 * this.zoom) - this.x,
            y: h / (2 * this.zoom) - this.y,
        };
    }

    // 0.3 — put a screen-centre world point (captured before a viewport
    // change) back in the centre, so a canvas that shrinks or grows (the
    // activity panel, a window resize) never jumps sideways. An idle drift
    // is rebased by the same step, so its next breath does not snap back.
    holdCenter(center) {
        if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y)) return;
        const fromX = this.x;
        const fromY = this.y;
        this._setCenter(center.x, center.y);
        if (this._idleDrift) {
            this._idleDrift.baseX += this.x - fromX;
            this._idleDrift.baseY += this.y - fromY;
        }
    }

    softFollowWorldBox(box, {
        dt = 16,
        paddingPx = 160,
        maxZoom = 2,
        minZoom = 1,
        composition = null,
        owner = 'idle-auto',
        maxSpeedPxPerMs = 0.035,
        stiffnessMs = 2200,
        deadzonePx = 28,
        preferPan = true,
        zoomHysteresis = 1.1,
        allowZoomIn = false,
    } = {}) {
        const pose = this._poseForWorldBox(box, {
            paddingPx,
            maxZoom,
            minZoom,
            composition,
            preferPan,
            zoomHysteresis,
            allowZoomIn,
            owner,
        });
        if (!pose) return false;
        this._endVillageTour({ restore: false });
        // stopFollow() would also drop the zoom step below, restarting it every
        // frame into a crawl through fractional zooms; only a live follow ends.
        if (this.followTarget) this.stopFollow();
        this._momentum = null;
        this._zoomAnimation = null;
        // Its own tier step (below) survives the per-frame call; anything else's
        // zoom move yields to it.
        if (this._snapZoom?.source !== 'soft-follow') this._snapZoom = null;
        this._idleDrift = null;
        this._cameraOwner = owner;
        // An operator-owned follow (4.3's `A` hold) keeps the operator's manual
        // flag, so a relayout never re-frames it away.
        this._userAdjusted = owner === 'user';

        if (this._reducedMotion) {
            this.zoom = pose.zoom;
            this.x = pose.x;
            this.y = pose.y;
            this._clampToBounds();
            return true;
        }

        // Steer the screen-centre world point, never the raw offsets: during a
        // zoom step the offsets of two different zooms are not comparable.
        const frameDt = Math.max(1, Math.min(80, Number(dt) || 16));
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const center = this.currentCenterWorld();
        const dx = (w / (2 * pose.zoom) - pose.x) - center.x;
        const dy = (h / (2 * pose.zoom) - pose.y) - center.y;
        const screenDistance = Math.hypot(dx, dy) * Math.max(0.1, this.zoom || 1);
        if (screenDistance <= deadzonePx && Math.abs(pose.zoom - this.zoom) < 0.01) {
            if (Math.abs(pose.zoom - this.zoom) > 1e-6) this._setZoomAboutCenter(pose.zoom);
            return false;
        }

        const eased = 1 - Math.exp(-frameDt / Math.max(1, stiffnessMs));
        const maxWorldStep = Math.max(1, maxSpeedPxPerMs * frameDt / Math.max(0.1, this.zoom || 1));
        const worldDistance = Math.hypot(dx, dy);
        const step = worldDistance > 0 ? Math.min(worldDistance * eased, maxWorldStep) / worldDistance : 0;
        this._setCenter(center.x + dx * step, center.y + dy * step);

        // 8.1 — once hysteresis decides a zoom change is genuinely needed, it is
        // one log-zoom to the resting tier, never a slow crawl: on the glide
        // formula's duration where flight frames render fat-pixel (4.6), one
        // ZOOM_STEP_MS rung step where they do not (the Canvas world).
        if (Math.abs(pose.zoom - this.zoom) >= 0.01 && !this._snapZoom) {
            this._snapZoom = {
                fromZoom: this.zoom,
                toZoom: pose.zoom,
                elapsed: 0,
                duration: this.fatFlight
                    ? glideDurationMs({ fromZoom: this.zoom, toZoom: pose.zoom })
                    : ZOOM_STEP_MS,
                source: 'soft-follow',
            };
        }
        return true;
    }

    get renderOffsetX() { return Math.round(this.x * this.zoom * this._dpr()) / this._dpr(); }

    get renderOffsetY() { return Math.round(this.y * this.zoom * this._dpr()) / this._dpr(); }

    // 4.6 (PT-5) — the resident GL layer's offset (CSS px). On a flight frame
    // at k = zoom × dpr ≥ 2 (the pose moved since the last GL frame, and not
    // by a drag or the idle drift: a glide past its hold, a tour leg, a follow
    // spring or soft-follow chase, momentum, a zoom step) it is the unrounded
    // offset, so a slow move advances the GL layer every frame and renders
    // fat-pixel; on every other frame, including the first settled one, it is
    // exactly `renderOffsetX/Y`. The overlay, the 2D backdrop and Canvas keep
    // the rounded offsets. `latchGpuFrame()` runs once per frame before the GL
    // world renders (WorldFrameRenderer).
    latchGpuFrame() {
        const latch = this._gpuLatch || (this._gpuLatch = { x: NaN, y: NaN, zoom: NaN, subPixel: false });
        const k = this.zoom * this._dpr();
        const moved = Math.abs(this.x - latch.x) * k > GPU_FLIGHT_EPSILON_PX
            || Math.abs(this.y - latch.y) * k > GPU_FLIGHT_EPSILON_PX
            || Math.abs(this.zoom - latch.zoom) > 1e-9;
        latch.subPixel = moved && k >= 2 - 1e-6 && !this.dragging && !this._idleDrift;
        latch.x = this.x;
        latch.y = this.y;
        latch.zoom = this.zoom;
        return latch.subPixel;
    }

    get renderOffsetGpuX() { return this._gpuLatch?.subPixel ? this.x * this.zoom : this.renderOffsetX; }

    get renderOffsetGpuY() { return this._gpuLatch?.subPixel ? this.y * this.zoom : this.renderOffsetY; }

    applyTransform(ctx) {
        const dpr = this._dpr();
        ctx.setTransform(
            this.zoom * dpr,
            0,
            0,
            this.zoom * dpr,
            this.renderOffsetX * dpr,
            this.renderOffsetY * dpr
        );
    }

    _viewportWidth() {
        return this.canvas?._claudeVilleCssWidth || this.canvas?.clientWidth || this.canvas?.width || 0;
    }

    _viewportHeight() {
        return this.canvas?._claudeVilleCssHeight || this.canvas?.clientHeight || this.canvas?.height || 0;
    }

    _dpr() {
        return this.canvas?._claudeVilleDpr || 1;
    }

    _poseForWorldBox(box, {
        paddingPx = 96,
        maxZoom = 2,
        minZoom = 1,
        composition = null,
        preferPan = false,
        zoomHysteresis = 0.85,
        allowZoomIn = true,
        owner = null,
        keepLandmarks = false,
        bodies = null,
    } = {}) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !box) return null;
        const centerX = (box.minX + box.maxX) / 2;
        const centerY = (box.minY + box.maxY) / 2;
        let zoom = this._zoomForWorldBox(box, paddingPx, maxZoom, minZoom);
        if (preferPan) {
            zoom = this._stableZoomForWorldBox(box, {
                idealZoom: zoom,
                paddingPx,
                maxZoom,
                zoomHysteresis,
                allowZoomIn,
            });
        }
        const anchor = this._compositionAnchor(composition);
        const pose = {
            zoom,
            x: -centerX + (w * anchor.x) / zoom,
            y: -centerY + (h * anchor.y) / zoom,
            centerX,
            centerY,
        };
        // 4.5 — the survey and opening wides place the horizon (M8: only those
        // shots); everything else an automatic owner frames is land-weighted,
        // and an establishing shot (`keepLandmarks`: the opening's settle and
        // the Ambient wide) is then kept clear of cropped landmark crowns and
        // plates. W5.1 — an automatic owner composes inside its own tight pad.
        const automatic = composesForLand(owner);
        const placed = automatic ? this._clampPose(pose, owner) : pose;
        if (composition?.skyRoom) return this._skyRoomPose(placed, box) || placed;
        if (!automatic) return placed;
        const landed = this._landWeightedPose(placed, box);
        return keepLandmarks ? this._landmarkClearPose(landed, box, bodies) : landed;
    }

    // W5.1 — `pose` with its screen centre clamped to `owner`'s pad.
    _clampPose(pose, owner) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const halfW = w / (2 * pose.zoom);
        const halfH = h / (2 * pose.zoom);
        const clamped = this._clampedCenter(halfW - pose.x, halfH - pose.y, pose.zoom, owner);
        return { ...pose, x: halfW - clamped.x, y: halfH - clamped.y };
    }

    // 4.5 (AD-7) — lift the pose so the sea horizon sits at 11 % of the world
    // viewport (10–12 %, low enough for SkyRenderer's sun or moon disc to stand
    // whole above it) with ≥ 4 % under the island box. Null when the island
    // leaves no vertical slack for that (the caller keeps its composition).
    _skyRoomPose(pose, box) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const viewH = h / pose.zoom;
        const discShare = skyDiscClearancePx(w, h) / h;
        const floorShare = Math.max(SKY_ROOM_HORIZON_MIN_SHARE, discShare);
        if (floorShare > SKY_ROOM_HORIZON_MAX_SHARE) return null;
        const islandShare = (box.maxY - OCEAN_HORIZON_WORLD_Y) / viewH;
        const share = Math.min(
            Math.max(SKY_ROOM_HORIZON_SHARE, floorShare),
            1 - SKY_ROOM_BOTTOM_MARGIN - islandShare,
        );
        if (share < floorShare) return null;
        return { ...pose, y: (share * h) / pose.zoom - OCEAN_HORIZON_WORLD_Y };
    }

    // 4.2 (CC-3) — while the frame holds more sea than `landWeightSeaCap`
    // allows (30 %, or the view's least sea plus 5 points, W5.1) — or, on a
    // view the island cannot fill, while the island's centre sits outside the
    // 10 % centring band (W5.1) — step the centre
    // toward the island centroid 16 world px at a time. A step is refused when
    // it would push an edge of the subject box into the 12 % inner margin (or,
    // for an edge already in it, deeper toward the frame edge); edges already
    // outside the frame, as on a fixed-scale wide, do not hold the move back.
    // A refused diagonal step slides along whichever axis is still free, so a
    // subject that fills the frame's height can still be panned sideways.
    _landWeightedPose(pose, box) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const viewW = w / pose.zoom;
        const viewH = h / pose.zoom;
        const area = viewW * viewH;
        let left = -pose.x;
        let top = -pose.y;
        const cap = landWeightSeaCap(viewW, viewH);
        const roomy = cap > LAND_WEIGHT_MAX_SEA;
        const sea = () => 1 - islandAreaInWorldRect(left, top, left + viewW, top + viewH) / area;
        const composed = () => sea() <= cap && (!roomy || islandCentred(left, top, viewW, viewH));
        if (!(area > 0) || composed()) return pose;
        const intrudes = (nextLeft, nextTop) => pushesIntoMargin(box, viewW, viewH, left, top, nextLeft, nextTop);
        for (let step = 0; step < LAND_WEIGHT_MAX_STEPS; step++) {
            const dx = ISLAND_CENTROID.x - (left + viewW / 2);
            const dy = ISLAND_CENTROID.y - (top + viewH / 2);
            const distance = Math.hypot(dx, dy);
            if (distance < 1) break;
            const length = Math.min(LAND_WEIGHT_STEP_PX, distance);
            const moves = [
                [(dx / distance) * length, (dy / distance) * length],
                [Math.sign(dx) * Math.min(LAND_WEIGHT_STEP_PX, Math.abs(dx)), 0],
                [0, Math.sign(dy) * Math.min(LAND_WEIGHT_STEP_PX, Math.abs(dy))],
            ];
            const move = moves.find(([mx, my]) => Math.hypot(mx, my) >= 0.5 && !intrudes(left + mx, top + my));
            if (!move) break;
            left += move[0];
            top += move[1];
            if (composed()) break;
        }
        return { ...pose, x: -left, y: -top };
    }

    // 4.2 — the pose (16 world px grid, same zoom) that crops the landmarks
    // standing in the frame least: summed crown overshoot past the top edge or
    // a reserved chrome rect in its columns first, then plate overshoot, then
    // distance. Villagers never give way to landmarks: no subject edge moves
    // into the 12 % margin (or deeper into it), no body in `bodies` (feet
    // points) shown whole leaves the frame, and the sea share may not rise
    // past max(`landWeightSeaCap`, the pose's own); a roomy view whose island
    // is centred keeps it inside the 10 % band (W5.1).
    _landmarkClearPose(pose, box, bodies = null) {
        const marks = this._landmarkSilhouettes();
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const zoom = pose?.zoom;
        if (!marks.length || !w || !h || !(zoom > 0)) return pose;
        const viewW = w / zoom;
        const viewH = h / zoom;
        const area = viewW * viewH;
        const reserved = getReservedRects().filter(rect => rect.bottom <= h / 2);
        // [crown overshoot, plate overshoot] in screen px, summed over marks.
        const overshoot = (left, top) => {
            let crown = 0;
            let plate = 0;
            for (const mark of marks) {
                const x0 = (mark.minX - left) * zoom;
                const x1 = (mark.maxX - left) * zoom;
                if (x1 <= 0 || x0 >= w || (mark.maxY - top) * zoom <= 0) continue;
                const plateX = (mark.centerX - left) * zoom;
                const spanLeft = Math.min(x0, plateX - LANDMARK_PLATE_HALF_WIDTH_PX);
                const spanRight = Math.max(x1, plateX + LANDMARK_PLATE_HALF_WIDTH_PX);
                let limit = LANDMARK_EDGE_AIR_PX;
                for (const rect of reserved) {
                    if (rect.right > spanLeft && rect.left < spanRight) limit = Math.max(limit, rect.bottom + LANDMARK_EDGE_AIR_PX);
                }
                const crownY = (mark.minY - top) * zoom;
                crown += Math.max(0, limit - crownY);
                plate += Math.max(0, limit - (crownY - LANDMARK_PLATE_CLEARANCE_PX));
            }
            return [crown, plate];
        };
        const left = -pose.x;
        const top = -pose.y;
        let best = { dx: 0, dy: 0, cost: overshoot(left, top), distance: 0 };
        if (best.cost[1] <= 0) return pose;
        const bodyWhole = (body, l, t) => body.x - LANDMARK_BODY.side >= l && body.x + LANDMARK_BODY.side <= l + viewW
            && body.y - LANDMARK_BODY.up >= t && body.y + LANDMARK_BODY.down <= t + viewH;
        const shown = (Array.isArray(bodies) ? bodies : [])
            .filter(body => Number.isFinite(body?.x) && Number.isFinite(body?.y) && bodyWhole(body, left, top));
        const sea = (l, t) => 1 - islandAreaInWorldRect(l, t, l + viewW, t + viewH) / area;
        const seaCap = Math.max(landWeightSeaCap(viewW, viewH), sea(left, top));
        // W5.1 — a roomy view that starts centred stays centred.
        const holdCentre = landWeightSeaCap(viewW, viewH) > LAND_WEIGHT_MAX_SEA && islandCentred(left, top, viewW, viewH);
        for (let i = -LANDMARK_SEARCH_STEPS; i <= LANDMARK_SEARCH_STEPS; i++) {
            for (let j = -LANDMARK_SEARCH_STEPS; j <= LANDMARK_SEARCH_STEPS; j++) {
                const dx = i * LAND_WEIGHT_STEP_PX;
                const dy = j * LAND_WEIGHT_STEP_PX;
                const distance = Math.hypot(dx, dy);
                const cost = overshoot(left + dx, top + dy);
                const better = cost[0] < best.cost[0]
                    || (cost[0] === best.cost[0] && (cost[1] < best.cost[1]
                        || (cost[1] === best.cost[1] && distance < best.distance)));
                if (!better) continue;
                if (shown.some(body => !bodyWhole(body, left + dx, top + dy))) continue;
                if (pushesIntoMargin(box, viewW, viewH, left, top, left + dx, top + dy)) continue;
                if (sea(left + dx, top + dy) > seaCap) continue;
                if (holdCentre && !islandCentred(left + dx, top + dy, viewW, viewH)) continue;
                best = { dx, dy, cost, distance };
            }
        }
        return best.distance ? { ...pose, x: -(left + best.dx), y: -(top + best.dy) } : pose;
    }

    _compositionAnchor(composition = null) {
        const x = Number(composition?.x);
        const y = Number(composition?.y);
        return {
            x: Number.isFinite(x) ? Math.max(0.32, Math.min(0.68, x)) : 0.5,
            y: Number.isFinite(y) ? Math.max(0.34, Math.min(0.70, y)) : 0.5,
        };
    }

    _stableZoomForWorldBox(box, {
        idealZoom,
        paddingPx = 96,
        maxZoom = 2,
        zoomHysteresis = 0.85,
        allowZoomIn = true,
    } = {}) {
        const maxAllowedZoom = this._maxZoomForLimit(maxZoom);
        const current = Math.max(this.minZoom, Math.min(this.zoom || this.minZoom, maxAllowedZoom));
        const boxW = Math.max(1, box.maxX - box.minX);
        const boxH = Math.max(1, box.maxY - box.minY);
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const fitsCurrent = boxW * current + paddingPx * 2 <= w && boxH * current + paddingPx * 2 <= h;
        if (!fitsCurrent) return idealZoom;
        if (idealZoom > current && !allowZoomIn) return current;
        if (Math.abs(idealZoom - current) < zoomHysteresis) return current;
        return idealZoom;
    }

    _clampToBounds() {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !Number.isFinite(this.zoom) || this.zoom <= 0) return;
        const clamped = this._clampedCenter(w / (2 * this.zoom) - this.x, h / (2 * this.zoom) - this.y, this.zoom);
        this.x = w / (2 * this.zoom) - clamped.x;
        this.y = h / (2 * this.zoom) - clamped.y;
    }

    // The screen-centre world point kept inside the island bounds for `zoom`,
    // on `owner`'s pad (W5.1 `clampPadFor`; null is the operator's pad, which
    // the resting clamp keeps so a resize or a breath never shifts a frame).
    _clampedCenter(centerX, centerY, zoom = this.zoom, owner = null) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !(zoom > 0)) return { x: centerX, y: centerY };
        const worldCorners = mapWorldCorners(MAP_SIZE);
        const { x: padX, y: padY } = clampPadFor(owner, w, h, zoom);
        const minX = Math.min(...worldCorners.map(p => p.x)) - padX;
        const maxX = Math.max(...worldCorners.map(p => p.x)) + padX;
        const minY = Math.min(...worldCorners.map(p => p.y)) - padY;
        const maxY = Math.max(...worldCorners.map(p => p.y)) + padY;
        return {
            x: Math.max(minX, Math.min(maxX, centerX)),
            y: Math.max(minY, Math.min(maxY, centerY)),
        };
    }

    // Place the screen centre on a world point at the current (or given) zoom.
    _setCenter(centerX, centerY, zoom = this.zoom) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        this.zoom = zoom;
        if (!w || !h) return;
        this.x = w / (2 * zoom) - centerX;
        this.y = h / (2 * zoom) - centerY;
        this._clampToBounds();
    }

    _updateMomentum(dt) {
        if (!this._momentum || this.dragging) return;
        const momentum = this._momentum;
        this.x += momentum.vx * dt;
        this.y += momentum.vy * dt;
        const beforeX = this.x;
        const beforeY = this.y;
        this._clampToBounds();
        // Kill the velocity component absorbed by the world bounds.
        if (Math.abs(this.x - beforeX) > 0.5) momentum.vx = 0;
        if (Math.abs(this.y - beforeY) > 0.5) momentum.vy = 0;
        const decay = Math.exp(-dt / 320);
        momentum.vx *= decay;
        momentum.vy *= decay;
        if (Math.hypot(momentum.vx, momentum.vy) < 0.01) this._momentum = null;
    }

    // #50 — drift the view along a tiny bounded Lissajous path once the world
    // has sat idle ~45s. Skipped entirely under reduced motion, and yielded the
    // moment anything else (drag, momentum, follow, zoom) wants the camera. The
    // offset rides on top of a captured base position so it is fully reversible.
    _updateIdleDrift(dt, renderNow = performance.now()) {
        if (this._reducedMotion) { this._endIdleDrift(); return; }
        // Anything else owning the camera defers the drift and resets the clock.
        // The #54 empty-village tour counts as an owner: it IS the idle motion, and the
        // drift's base-restore would fight its glide sequencing.
        // C6 — an exclusive claim (Ambient, replay) is the deliberate motion
        // now; the breath would fight its holds and pollute its logged pose.
        if (this.dragging || this._momentum || this._directorGlide
            || this.followTarget || this._zoomAnimation || this._snapZoom
            || this._villageTour || this._frameClaim) {
            this._endIdleDrift();
            this._lastInputAt = renderNow;
            return;
        }
        // W5.2 (PI-P6) — the breath is a depth cue for a closer shot. At the
        // widest crisp rung (tier 1, or the survey below it) it would sway the
        // whole island, so the frame holds still there.
        if (!(this.zoom > this.tierZoom(1) + 1e-6)) {
            this._endIdleDrift();
            return;
        }
        if (renderNow - this._lastInputAt < IDLE_DRIFT_DELAY_MS) {
            this._endIdleDrift();
            return;
        }
        if (!this._idleDrift) {
            // Enter drift: capture the resting position as the path origin.
            this._idleDrift = { baseX: this.x, baseY: this.y, phase: 0 };
        }
        const drift = this._idleDrift;
        drift.phase += dt;
        // Two slightly detuned frequencies trace an open Lissajous loop; the
        // sub-pixel amplitude keeps it a breath, not a pan.
        const ax = Math.sin(drift.phase / IDLE_DRIFT_PERIOD_X_MS * (Math.PI * 2));
        const ay = Math.sin(drift.phase / IDLE_DRIFT_PERIOD_Y_MS * (Math.PI * 2));
        this.x = drift.baseX + ax * IDLE_DRIFT_AMPLITUDE_PX;
        this.y = drift.baseY + ay * IDLE_DRIFT_AMPLITUDE_PX;
        this._clampToBounds();
    }

    // Restore the captured base position and clear the drift state. No-op when
    // not drifting, so input handlers can call it unconditionally.
    _endIdleDrift() {
        if (!this._idleDrift) return;
        this.x = this._idleDrift.baseX;
        this.y = this._idleDrift.baseY;
        this._idleDrift = null;
        this._clampToBounds();
    }

    // #54 — population feed from BuildingSprite's 'village:population' event.
    // First arrival ends the tour instantly and hands the frame back to the
    // auto-camera (owner reset to 'system' so the attract logic may reframe).
    _handleVillagePopulation(payload = {}) {
        const empty = payload.empty != null ? Boolean(payload.empty) : Number(payload?.count) === 0;
        if (empty) {
            if (!this._villageEmpty) this._villageEmptySince = performance.now();
            this._villageEmpty = true;
            return;
        }
        this._villageEmpty = false;
        this._villageEmptySince = null;
        this._endVillageTour({ restore: true });
    }

    // #54 — engage/sequence/yield the empty-village tour. Called first in
    // update(): tour glides are ordinary director glides, so once one starts
    // `_updateDirectorGlide` owns the move and the rest of update() parks.
    _updateVillageTour(dt, renderNow = performance.now()) {
        const tour = this._villageTour;
        if (this._frameClaim) { this._endVillageTour({ restore: false }); return; }
        if (!tour) {
            if (!this._villageEmpty || !this._villageEmptySince) return;
            if (renderNow - this._villageEmptySince < TOUR_EMPTY_DELAY_MS) return;
            if (this.getUserIdleMs(renderNow) < TOUR_USER_IDLE_MS) return;
            if (this.dragging || this.followTarget || this._momentum
                || this._zoomAnimation || this._snapZoom || this._directorGlide) return;
            this._villageTour = { index: 0, dwellUntil: 0 };
            if (!this._reducedMotion) this._startNextTourGlide(renderNow);
            return;
        }
        // Reduced motion: no circuit; the frame stays where it is.
        if (this._reducedMotion) return;
        if (this._directorGlide) return;
        if (renderNow < tour.dwellUntil) return;
        this._startNextTourGlide(renderNow);
    }

    _startNextTourGlide(renderNow = performance.now()) {
        const tour = this._villageTour;
        if (!tour) return;
        const stops = this._villageTourStops();
        if (!stops.length) return;
        const stop = stops[tour.index % stops.length];
        tour.index += 1;
        const started = this.glideToWorld(stop.box, {
            maxZoom: stop.maxZoom,
            minZoom: stop.minZoom ?? 1,
            paddingPx: stop.paddingPx ?? 170,
            owner: 'village-tour',
            motion: 'ambient',
            composition: stop.composition || { x: 0.5, y: 0.55 },
        });
        const glideMs = started ? (this._directorGlide?.duration || 0) : 0;
        tour.dwellUntil = renderNow + (started ? glideMs + TOUR_DWELL_MS : 1500);
    }

    // Landmark circuit: the whole island first at the survey scale with 4.5's
    // sky room, then one stop per building as a scenic loop, so the circuit
    // opens and closes on the diorama. 4.1 — hero stops rest at the wide
    // scale, majors lean in to the medium (z2 / z3 at 5120 × 1440 DPR 1).
    _villageTourStops() {
        if (this._tourStopsCache) return this._tourStopsCache;
        const byType = new Map(BUILDING_DEFS.map((def) => [def.type, def]));
        const ordered = TOUR_STOP_ORDER.map((type) => byType.get(type)).filter(Boolean);
        for (const def of BUILDING_DEFS) if (!ordered.includes(def)) ordered.push(def);
        const corners = mapWorldCorners(MAP_SIZE);
        const island = {
            box: {
                minX: Math.min(...corners.map(p => p.x)),
                minY: Math.min(...corners.map(p => p.y)),
                maxX: Math.max(...corners.map(p => p.x)),
                maxY: Math.max(...corners.map(p => p.y)),
            },
            maxZoom: SURVEY_TIER,
            minZoom: SURVEY_TIER,
            paddingPx: 0,
            composition: OPENING_COMPOSITION,
        };
        const landmarks = ordered.map((def) => {
            const world = tileToWorld(def.x + def.width / 2, def.y + def.height / 2);
            const hero = def.visualTier === 'hero';
            const padX = hero ? 260 : 220;
            const padY = hero ? 130 : 110;
            return {
                box: {
                    minX: world.x - padX,
                    minY: world.y - padY,
                    maxX: world.x + padX,
                    maxY: world.y + padY,
                },
                maxZoom: hero ? this.shotTier('wide') : this.shotTier('medium'),
            };
        });
        this._tourStopsCache = [island, ...landmarks];
        return this._tourStopsCache;
    }

    // Yield the tour: drop any in-flight tour glide so motion stops now (the
    // yield contract), never mid-move later. `restore` resets the owner to
    // 'system' so the auto-camera may reframe (agent-arrival path); operator
    // input passes restore:false and keeps full manual control instead.
    _endVillageTour({ restore = false } = {}) {
        if (!this._villageTour) return;
        this._villageTour = null;
        if (this._directorGlide?.owner === 'village-tour') this._directorGlide = null;
        if (restore) {
            this._cameraOwner = 'system';
            this._userAdjusted = false;
        }
    }

    // #21 — advance the director glide. Returns true while it owns the camera so
    // momentum/snap-zoom stay parked. Holds `_userAdjusted` false for the move's
    // duration, then sets it true so subsequent resizes keep the framed view.
    _updateDirectorGlide(dt) {
        const glide = this._directorGlide;
        if (!glide) return false;
        // #45 — hold on the wide establishing frame before the glide proper begins.
        if (glide.hold > 0) {
            glide.hold -= dt;
            this._userAdjusted = false;
            return true;
        }
        glide.elapsed += dt;
        const sample = sampleGlide(glide.plan, glide.elapsed);
        this._setCenter(sample.cx, sample.cy, sample.zoom);
        this._userAdjusted = false;
        if (sample.done) {
            this._setCenter(glide.plan.to.cx, glide.plan.to.cy, glide.toZoom);
            // 5.2 — bars that belong to this move keep standing for their hold,
            // so the caption is read at rest instead of at arrival speed.
            this._letterboxHold = glide.letterboxHoldMs > 0
                ? { remaining: glide.letterboxHoldMs, owner: glide.owner || 'director' }
                : null;
            this._directorGlide = null;
            this._cameraOwner = glide.owner || 'director';
            this._userAdjusted = Boolean(glide.userAdjustedOnComplete);
        }
        return true;
    }

    _updateSnapZoom(dt) {
        if (!this._snapZoom) return;
        const anim = this._snapZoom;
        anim.elapsed += dt;
        const t = Math.min(1, anim.elapsed / anim.duration);
        const curve = anim.source === 'soft-follow' ? easeInOutCubic : easeOutCubic;
        this._setZoomAboutCenter(t >= 1 ? anim.toZoom : logZoom(anim.fromZoom, anim.toZoom, curve(t)));
        if (t >= 1) this._snapZoom = null;
    }

    _setZoomAboutCenter(zoom) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        const centerWorldX = w / (2 * this.zoom) - this.x;
        const centerWorldY = h / (2 * this.zoom) - this.y;
        this.zoom = zoom;
        this.x = w / (2 * zoom) - centerWorldX;
        this.y = h / (2 * zoom) - centerWorldY;
        this._clampToBounds();
    }
}
