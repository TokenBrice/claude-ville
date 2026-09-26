import { MAP_SIZE } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import {
    FOLLOW_ENTRY_MS,
    WHEEL_STEP_MS,
    ZOOM_STEP_MS,
    criticalSpringStep,
    easeInOutCubic,
    easeOutCubic,
    logZoom,
    planGlide,
    sampleGlide,
} from './CameraCurves.js';
import { mapWorldCorners, tileToWorld, worldToTile } from './Projection.js';

// #50 — idle Ken-Burns drift tuning. Begins after this much input-free time,
// then breathes along a slow detuned Lissajous loop with a sub-pixel amplitude.
const IDLE_DRIFT_DELAY_MS = 45000;
const IDLE_DRIFT_AMPLITUDE_PX = 8;
const IDLE_DRIFT_PERIOD_X_MS = 38000;
const IDLE_DRIFT_PERIOD_Y_MS = 47000;

// #54 — empty-village dusk tour. Once the village has been empty for a stretch
// AND the operator idle, the camera takes a slow Ken-Burns circuit of the
// landmarks under a dusk vignette. It yields the instant an agent arrives or
// the operator touches anything. Reduced motion: no circuit — the static dusk
// vignette still settles over the empty village (the item's RM fallback).
const TOUR_EMPTY_DELAY_MS = 20000;
const TOUR_USER_IDLE_MS = 40000;
const TOUR_DWELL_MS = 7000;
const TOUR_GRADE_RAMP_MS = 3200;
const TOUR_VIGNETTE = 0.34;
const TOUR_WORLD_TINT = '#241d33';
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
// The 150ms tween may pass through fractional values; every settled pose is
// display-pixel aligned.
const NOMINAL_ZOOM_STEPS = Object.freeze([1, 2, 3]);

// 8.3 — the survey tier: the logical label for `1 / backingDpr`, one backing
// pixel per authored world pixel. It exists only where the backing store is at
// least 2× (at DPR 1 a 0.5 zoom would drop every other texel), so nothing is
// ever resampled. Wheel/keyboard can reach it; automatic framing uses it only
// where asked (the opening, the Ambient wide, the tour's island stop, `F` on a
// box spanning most of the island).
export const SURVEY_TIER = 0.5;
const SURVEY_MIN_BACKING_DPR = 2;

// 8.3 — the resting tier content re-frames, the opening shot and a follow
// settle on. D1 put villagers at 1:1; tier 3 is the crisp detail framing the
// bodies are drawn for (a box too large for it falls back to 2, then 1).
export const DEFAULT_FRAME_TIER = 3;

// 8.3 — the opening: survey hold, then one authored dolly to the content.
// Each rung of the dolly is a full ZOOM_STEP_MS step; the hold (at the
// survey tier) and the dolly together stay ≥ 75 % pixel-exact, and
// `planGlide` lengthens the dolly past this when the ladder has more rungs.
const OPENING_HOLD_MS = 1600;
const OPENING_DOLLY_MS = 2400;
// The island's centre sits 4 % below screen centre, leaving sky room above.
const OPENING_COMPOSITION = Object.freeze({ x: 0.5, y: 0.54 });
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
// supports it) below the display-pixel tiers. `tiers` are the logical labels
// callers ask for; `steps` the camera zooms they resolve to.
export function zoomTierLadder(dpr) {
    const steps = [...displayPixelZoomSteps(dpr)];
    const tiers = [...NOMINAL_ZOOM_STEPS];
    const backing = Number(dpr);
    if (Number.isFinite(backing) && backing >= SURVEY_MIN_BACKING_DPR) {
        steps.unshift(1 / backing);
        tiers.unshift(SURVEY_TIER);
    }
    return { steps: Object.freeze(steps), tiers: Object.freeze(tiers) };
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
        // ({ until, grade, owner }); cue glides keep their arrival-only bars.
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
        // `_villageTour` is non-null while the dusk tour owns the frame.
        this._villageEmpty = false;
        this._villageEmptySince = null;
        this._villageTour = null;   // { index, dwellUntil, gradeWeight }
        this._tourStopsCache = null;
        this._onVillagePopulation = (payload) => this._handleVillagePopulation(payload);
        this._populationUnsub = null;

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);

        this.centerOnMap();
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

    onViewportResize() {
        this._syncDisplayPixelZoom();
        this._clampToBounds();
    }

    _applyTierLadder({ steps, tiers }) {
        this.zoomSteps = steps;
        this.zoomTiers = tiers;
        this.minZoom = steps[0];
        this.maxZoom = steps[steps.length - 1];
        this.surveyZoom = tiers[0] === SURVEY_TIER ? steps[0] : null;
        this._displayPixelZoomScale = this.tierZoom(1);
    }

    // The camera zoom for a logical tier label (SURVEY_TIER, 1, 2, 3). A survey
    // request where no survey tier exists resolves to tier 1.
    tierZoom(tier) {
        const index = this.zoomTiers.findIndex((label) => Math.abs(label - tier) < 1e-6);
        if (index >= 0) return this.zoomSteps[index];
        return tier < 1 ? this.zoomSteps[this.zoomTiers.indexOf(1)] : this.maxZoom;
    }

    hasSurveyTier() {
        return this.surveyZoom != null;
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
        // A survey pose on a grid without a survey tier lands on tier 1.
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
                for (const segment of motion.plan.segments) {
                    if (segment.fromZoom != null) segment.fromZoom = remap(segment.fromZoom);
                    if (segment.toZoom != null) segment.toZoom = remap(segment.toZoom);
                }
            }
        }
        return true;
    }

    // Frame an axis-aligned world box so it fits the viewport, centered on the
    // box, at the largest display-pixel-aligned zoom up to `maxZoom`. Used for
    // the initial "overview of my active agents" framing.
    fitToWorldBox(box, { paddingPx = 96, maxZoom = 2, minZoom = 1, owner = 'system', composition = null } = {}) {
        const pose = this._poseForWorldBox(box, { paddingPx, maxZoom, minZoom, composition });
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

        // Tier labels (SURVEY_TIER, 1, 2, 3) are logical tiers. Other limits
        // are accepted for capture/debug callers that already hold a zoom.
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

    // The logical tier label nearest the current zoom (SURVEY_TIER, 1, 2, 3).
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
    // runs, then re-frames cleanly. `grade` is a {vignette, worldTint} hint the
    // frame renderer fades in/out with the glide.
    //
    // 8.1 — the duration is never authored per call site: CameraCurves derives
    // it from the screen distance and zoom ratio. `motion` picks the family
    // ('director' easeInOutCubic; 'ambient' easeInOutSine, slower).
    glideToWorld(box, {
        paddingPx = 96,
        maxZoom = 2,
        minZoom = 1,
        grade = null,
        holdMs = 0,
        owner = 'director',
        motion = 'director',
        userAdjustedOnComplete = false,
        composition = null,
        preferPan = false,
        zoomHysteresis = 0.85,
        allowZoomIn = true,
        // 5.2 — bars this move owns, held this long after it settles. Zero keeps
        // the shipped cue behaviour (bars ride the glide and end on arrival).
        letterbox = false,
        letterboxHoldMs = 0,
    } = {}) {
        const pose = this._poseForWorldBox(box, {
            paddingPx,
            maxZoom,
            minZoom,
            composition,
            preferPan,
            zoomHysteresis,
            allowZoomIn,
        });
        if (!pose) return false;
        // Anything but the tour's own stops ends the tour (cues, attract moves).
        if (owner !== 'village-tour') this._endVillageTour({ restore: false });
        return this._startGlide(pose, {
            owner,
            motion,
            holdMs,
            grade,
            letterbox,
            letterboxHoldMs,
            userAdjustedOnComplete,
        });
    }

    // C6 — glide back to an exact saved pose (5.2's return address). A box glide
    // would re-solve the framing; a chapter has to land on the composition the
    // operator was already reading.
    glideToPose(pose, { owner = 'director', motion = 'director', grade = null, letterbox = false, letterboxHoldMs = 0 } = {}) {
        const target = this._restingPose(pose);
        if (!target) return false;
        this._endVillageTour({ restore: false });
        // A restored composition is deliberate: a relayout must keep it
        // instead of re-framing to content behind the caller's back.
        return this._startGlide(target, {
            owner,
            motion,
            grade,
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

    // 8.1 — one glide in the shared vocabulary: the screen-centre world point
    // travels a straight line, zoom moves in log space, and a zoom change is
    // one 450 ms step per resting rung, taken at the end (zooming in) or start
    // (zooming out) of a pan held at a resting tier; the glide grows to keep
    // it ≥ 75 % pixel-exact. `durationMs` is only for the authored opening.
    _startGlide(pose, {
        owner = 'director',
        motion = 'director',
        holdMs = 0,
        durationMs = null,
        stepped = false,
        grade = null,
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
            // Reduced motion: cut directly to the framed view, no glide, no grade.
            this.zoom = pose.zoom;
            this.x = pose.x;
            this.y = pose.y;
            this._directorGlide = null;
            this._cameraOwner = owner;
            this._userAdjusted = Boolean(userAdjustedOnComplete);
            this._clampToBounds();
            return true;
        }

        const toCenter = this._clampedCenter(w / (2 * pose.zoom) - pose.x, h / (2 * pose.zoom) - pose.y, pose.zoom);
        const fromCenter = this.currentCenterWorld();
        // A hold spent at a resting tier is part of the shot's pixel-exact time.
        const fromResting = this.zoomSteps.some((step) => Math.abs(step - this.zoom) < 1e-6);
        const plan = planGlide(
            { cx: fromCenter.x, cy: fromCenter.y, zoom: this.zoom },
            { cx: toCenter.x, cy: toCenter.y, zoom: pose.zoom },
            {
                family: motion,
                duration: durationMs,
                stepped,
                tiers: this.zoomSteps,
                restingLeadMs: fromResting ? Math.max(0, Number(holdMs) || 0) : 0,
            },
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
            grade: grade || null,
            letterbox: Boolean(letterbox) || letterboxHoldMs > 0,
            letterboxHoldMs: Math.max(0, Number(letterboxHoldMs) || 0),
        };
        return true;
    }

    // 8.3 — the opening shot. The first presented frame is the whole island at
    // the survey tier (tier 1 where the backing store has no survey tier),
    // centred with sky room above; it holds 1.6 s, then one ≥ 2.4 s move settles
    // on the target: a content box, or an authored pose (scenario metadata).
    // The move is a stepped dolly (C3): the pan runs the whole move while the
    // zoom climbs the resting ladder one 450 ms step per rung (survey → 1 → 2),
    // so ≥ 75 % of hold + dolly is pixel-exact; at DPR 1 with a tier-1 target
    // it is a pure pan. Reduced motion cuts straight to the target frame.
    establishingShot(wideBox, { targetBox = null, targetPose = null, maxZoom = this.defaultFrameTier } = {}) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h) return false;
        const target = targetPose
            ? this._restingPose(targetPose)
            : this._poseForWorldBox(targetBox, { maxZoom });
        if (!target) return false;
        this._endVillageTour({ restore: false });
        if (this._reducedMotion) {
            return this._startGlide(target, { owner: 'system' });
        }
        const openTier = this.hasSurveyTier() ? SURVEY_TIER : 1;
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
            stepped: true,
        });
    }

    // 8.3 — `F`: a content box that spans most of the island widens to the
    // survey tier instead of cropping it at tier 1.
    frameTierFloorForBox(box) {
        if (!this.hasSurveyTier() || !box) return 1;
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
        // #54 — operator input yields the dusk tour instantly, right where it stands.
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

    // #21 — grade weight (0..1) plus the active glide's grade hint, for the
    // WorldFrameRenderer vignette/worldTint pass. Ramps up at the head of the
    // move and eases back out at the tail so it never lingers.
    getDirectorGlideGrade() {
        // #54 — while the empty-village tour owns the frame its dusk grade is
        // the active one: persistent (not bell-curved), ramped in over a few
        // seconds on engage, dropped instantly on yield. Reduced motion holds
        // the static vignette at full weight.
        if (this._villageTour) {
            return {
                vignette: TOUR_VIGNETTE,
                worldTint: TOUR_WORLD_TINT,
                weight: Math.max(0, Math.min(1, this._villageTour.gradeWeight ?? 0)),
            };
        }
        const glide = this._directorGlide;
        if (!glide || !glide.grade) return null;
        // Reduced motion cuts directly to the framed view; no lingering overlay.
        if (this._reducedMotion) return null;
        const t = Math.min(1, glide.elapsed / glide.duration);
        const weight = Math.sin(Math.PI * t); // 0 → 1 → 0 across the move
        return { ...glide.grade, weight: Math.max(0, weight) };
    }

    // 5.2 — the letterbox the frame renderer should draw right now: the shipped
    // cue bars while a cue glide runs, or an ambient chapter's bars held for a
    // beat after the move settles so the caption can be read at rest. The hold
    // counts down in dt inside update(), never against a wall clock: the frame
    // pass and the camera do not share one.
    getLetterboxState() {
        const hold = this._letterboxHold;
        if (hold && !this._directorGlide) {
            return { weight: 1, grade: hold.grade || null, owner: hold.owner, held: true };
        }
        const glide = this._directorGlide;
        if (!glide || this._reducedMotion) return null;
        const owner = String(this._cameraOwner || '');
        // The shipped cue bars ride a graded cue glide and nothing else; a cue
        // reframe without a grade drew no bars before and still draws none.
        const cueBars = (owner === 'cue:release' || owner === 'cue:incident') && Boolean(glide.grade);
        if (!cueBars && !glide.letterbox) return null;
        const weight = Math.max(0, Math.sin(Math.PI * Math.min(1, glide.elapsed / glide.duration)));
        return { weight, grade: glide.grade || null, owner, held: false };
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
            // #54 — a live tour keeps only its static dusk vignette under
            // reduced motion: no circuit, grade snapped to full weight.
            if (this._villageTour) this._villageTour.gradeWeight = 1;
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

    softFollowWorldBox(box, {
        dt = 16,
        paddingPx = 160,
        maxZoom = 2,
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
            composition,
            preferPan,
            zoomHysteresis,
            allowZoomIn,
        });
        if (!pose) return false;
        this._endVillageTour({ restore: false });
        this.stopFollow();
        this._momentum = null;
        this._zoomAnimation = null;
        // Its own tier step (below) survives the per-frame call; anything else's
        // zoom move yields to it.
        if (this._snapZoom?.source !== 'soft-follow') this._snapZoom = null;
        this._idleDrift = null;
        this._cameraOwner = owner;
        this._userAdjusted = false;

        if (this._reducedMotion) {
            this.zoom = pose.zoom;
            this.x = pose.x;
            this.y = pose.y;
            this._clampToBounds();
            return true;
        }

        const frameDt = Math.max(1, Math.min(80, Number(dt) || 16));
        const dx = pose.x - this.x;
        const dy = pose.y - this.y;
        const screenDistance = Math.hypot(dx, dy) * Math.max(0.1, this.zoom || 1);
        if (screenDistance <= deadzonePx && Math.abs(pose.zoom - this.zoom) < 0.01) {
            if (Math.abs(pose.zoom - this.zoom) > 1e-6) this._setZoomAboutCenter(pose.zoom);
            return false;
        }

        const eased = 1 - Math.exp(-frameDt / Math.max(1, stiffnessMs));
        const maxWorldStep = Math.max(1, maxSpeedPxPerMs * frameDt / Math.max(0.1, this.zoom || 1));
        const worldDistance = Math.hypot(dx, dy);
        const step = worldDistance > 0 ? Math.min(worldDistance * eased, maxWorldStep) / worldDistance : 0;
        this.x += dx * step;
        this.y += dy * step;

        // 8.1 — once hysteresis decides a zoom change is genuinely needed, it is
        // one 450 ms tier step, never a slow crawl through fractional zooms.
        if (Math.abs(pose.zoom - this.zoom) >= 0.01 && !this._snapZoom) {
            this._snapZoom = {
                fromZoom: this.zoom,
                toZoom: pose.zoom,
                elapsed: 0,
                duration: ZOOM_STEP_MS,
                source: 'soft-follow',
            };
        }
        this._clampToBounds();
        return true;
    }

    get renderOffsetX() { return Math.round(this.x * this.zoom * this._dpr()) / this._dpr(); }

    get renderOffsetY() { return Math.round(this.y * this.zoom * this._dpr()) / this._dpr(); }

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
        return {
            zoom,
            x: -centerX + (w * anchor.x) / zoom,
            y: -centerY + (h * anchor.y) / zoom,
            centerX,
            centerY,
        };
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

    // The screen-centre world point kept inside the island bounds for `zoom`.
    _clampedCenter(centerX, centerY, zoom = this.zoom) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !(zoom > 0)) return { x: centerX, y: centerY };
        const worldCorners = mapWorldCorners(MAP_SIZE);
        const padX = Math.max(220, w / (zoom * 2.2));
        const padY = Math.max(160, h / (zoom * 2.2));
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
        // The #54 dusk tour counts as an owner: it IS the idle motion, and the
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

    // #54 — engage/sequence/yield the empty-village dusk tour. Called first in
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
            this._villageTour = {
                index: 0,
                dwellUntil: 0,
                // Reduced motion snaps the static vignette on; motion ramps it.
                gradeWeight: this._reducedMotion ? 1 : 0,
            };
            if (!this._reducedMotion) this._startNextTourGlide(renderNow);
            return;
        }
        if (!this._reducedMotion && tour.gradeWeight < 1) {
            tour.gradeWeight = Math.min(1, tour.gradeWeight + dt / TOUR_GRADE_RAMP_MS);
        }
        // Reduced motion: the tour is the static dusk vignette only — no circuit.
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
            grade: { vignette: TOUR_VIGNETTE, worldTint: TOUR_WORLD_TINT },
        });
        const glideMs = started ? (this._directorGlide?.duration || 0) : 0;
        tour.dwellUntil = renderNow + (started ? glideMs + TOUR_DWELL_MS : 1500);
    }

    // Landmark circuit: the whole island first (8.3 — the survey tier where the
    // backing store has one), then one stop per building as a scenic loop, so
    // the circuit opens and closes on the diorama. Hero tiers hold the wide
    // frame (zoom 1), majors lean in (zoom 2).
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
                maxZoom: hero ? 1 : 2,
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
                ? {
                    remaining: glide.letterboxHoldMs,
                    grade: glide.grade || null,
                    owner: glide.owner || 'director',
                }
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
