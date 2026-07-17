import { MAP_SIZE } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
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
const TOUR_GLIDE_MS = 9000;
const TOUR_DWELL_MS = 7000;
const TOUR_GRADE_RAMP_MS = 3200;
const TOUR_VIGNETTE = 0.34;
const TOUR_WORLD_TINT = '#241d33';
const TOUR_STOP_ORDER = Object.freeze([
    'command', 'archive', 'observatory', 'watchtower', 'harbor',
    'portal', 'mine', 'forge', 'taskboard',
]);

// Resting steps for wheel/keyboard zoom. The 150ms tween may pass through
// fractional values mid-gesture, but the camera must SETTLE on integers so the
// nearest-neighbor canvas upscale stays pixel-uniform (plan 1.9). Fractional
// half-steps were a deliberate addition (commit 8e343a3) — restore
// [1, 1.5, 2, 2.5, 3] here if mid-range framing ever needs re-tuning.
const ZOOM_STEPS = Object.freeze([1, 2, 3]);

export class Camera {
    constructor(canvas) {
        this.canvas = canvas;
        this.x = 0;
        this.y = 0;
        this.zoom = 1;
        this.minZoom = 1;
        this.maxZoom = 3;
        this.zoomSteps = ZOOM_STEPS;
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
        this.followSmoothing = 0.08;   // lerp factor (lower is smoother)
        this._followEase = null;       // timed ease-out glide when follow starts
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
        this.zoom = 1;
        if (!this.canvas) return;
        this.x = -screen.x + this._viewportWidth() / (2 * this.zoom);
        this.y = -screen.y + this._viewportHeight() / (2 * this.zoom);
        this._clampToBounds();
    }

    onViewportResize() {
        this._clampToBounds();
    }

    // Frame an axis-aligned world box so it fits the viewport, centered on the
    // box, at the largest *integer* zoom (pixel-perfect) up to `maxZoom`. Used
    // for the initial "overview of my active agents" framing.
    fitToWorldBox(box, { paddingPx = 96, maxZoom = 2, owner = 'system', composition = null } = {}) {
        const pose = this._poseForWorldBox(box, { paddingPx, maxZoom, composition });
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

    // #21 — solve the largest integer zoom (pixel-perfect) that fits a world box,
    // shared by fitToWorldBox and the director glide so framing stays consistent.
    _zoomForWorldBox(box, paddingPx = 96, maxZoom = 2) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !box) return this.minZoom;
        const boxW = Math.max(1, box.maxX - box.minX);
        const boxH = Math.max(1, box.maxY - box.minY);
        const hi = Math.min(Math.floor(maxZoom), this.maxZoom);
        for (let z = hi; z >= this.minZoom; z--) {
            if (boxW * z + paddingPx * 2 <= w && boxH * z + paddingPx * 2 <= h) return z;
        }
        return this.minZoom;
    }

    // #21 — start a director glide to frame `box`. Reduced motion (or a missing
    // viewport) cuts directly. The move releases `_userAdjusted` only while it
    // runs, then re-frames cleanly. `grade` is a {vignette, worldTint} hint the
    // frame renderer fades in/out with the glide.
    glideToWorld(box, {
        duration = 1400,
        paddingPx = 96,
        maxZoom = 2,
        grade = null,
        holdMs = 0,
        owner = 'director',
        userAdjustedOnComplete = false,
        composition = null,
        preferPan = false,
        zoomHysteresis = 0.85,
        allowZoomIn = true,
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
        // Anything but the tour's own stops ends the tour (cues, attract moves).
        if (owner !== 'village-tour') this._endVillageTour({ restore: false });

        this.stopFollow();
        this._momentum = null;
        this._zoomAnimation = null;
        this._snapZoom = null;

        if (this._reducedMotion) {
            // Reduced-motion: cut directly to the framed view, no glide, no grade.
            this.zoom = pose.zoom;
            this.x = pose.x;
            this.y = pose.y;
            this._directorGlide = null;
            this._cameraOwner = owner;
            this._userAdjusted = Boolean(userAdjustedOnComplete);
            this._clampToBounds();
            return true;
        }

        this._cameraOwner = owner;
        this._userAdjusted = false;
        this._directorGlide = {
            fromX: this.x,
            fromY: this.y,
            fromZoom: this.zoom,
            toX: pose.x,
            toY: pose.y,
            toZoom: pose.zoom,
            elapsed: 0,
            duration: Math.max(1, Number(duration) || 1400),
            owner,
            userAdjustedOnComplete: Boolean(userAdjustedOnComplete),
            // #45 — optional hold (the establishing shot lingers on the wide frame
            // before the glide begins). Counts down before `elapsed` advances.
            hold: Math.max(0, Number(holdMs) || 0),
            grade: grade || null,
        };
        return true;
    }

    // #45 — opening establishing shot on first World paint. Snap to the wide
    // full-island frame, hold it ~1.2s, then cubic-ease glide+zoom in to settle
    // on the active cluster over ~2.8s. Reduced motion (or a missing viewport)
    // cuts directly to the target frame, matching the prior instant behavior.
    establishingShot(wideBox, targetBox, { holdMs = 1200, glideMs = 2800, maxZoom = 2 } = {}) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !targetBox) return false;
        if (this._reducedMotion) {
            this.fitToWorldBox(targetBox, { maxZoom, owner: 'system' });
            this._userAdjusted = false;
            return true;
        }
        // Snap to the island-wide overview so the glide departs from it.
        this.fitToWorldBox(wideBox || targetBox, { maxZoom: 1, owner: 'system' });
        return this.glideToWorld(targetBox, { duration: glideMs, maxZoom, holdMs, owner: 'system' });
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

    // #attract — record genuine operator input and report how long since the last.
    // Used by the CameraDirector's idle-attract mode for engage/yield decisions.
    noteUserInput() {
        const now = performance.now();
        this._lastInputAt = now;
        this._lastUserInputAt = now;
        // #54 — operator input yields the dusk tour instantly, right where it stands.
        this._endVillageTour({ restore: false });
        this._cameraOwner = 'user';
        this._userAdjusted = true;
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
        this._endVillageTour({ restore: false });
        this._directorGlide = null;
        this._cameraOwner = 'follow';
        this.followTarget = sprite;
        this._momentum = null;
        const farZoomedOut = this.zoom < 1.5;
        if (this._reducedMotion) {
            if (farZoomedOut) this._setZoomAboutCenter(2);
            return;
        }
        this._followEase = { fromX: this.x, fromY: this.y, elapsed: 0, duration: 650 };
        if (farZoomedOut) {
            this._zoomAnimation = null;
            this._snapZoom = { fromZoom: this.zoom, toZoom: 2, elapsed: 0, duration: 380 };
        }
    }

    stopFollow() {
        this.followTarget = null;
        this._followEase = null;
        this._snapZoom = null;
        this._momentum = null;
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

    updateFollow(dt = 16) {
        if (!this.followTarget) return;
        const focus = this._followFocusPoint(dt);
        const targetX = -focus.x + this._viewportWidth() / (2 * this.zoom);
        const targetY = -focus.y + this._viewportHeight() / (2 * this.zoom);
        if (this._reducedMotion) {
            this.x = targetX;
            this.y = targetY;
            this._clampToBounds();
            return;
        }
        if (this._followEase) {
            // Timed glide: covers the initial distance in a fixed duration
            // with cubic ease-out, then hands off to the steady lerp.
            const ease = this._followEase;
            ease.elapsed += dt;
            const t = Math.min(1, ease.elapsed / ease.duration);
            const eased = 1 - Math.pow(1 - t, 3);
            this.x = ease.fromX + (targetX - ease.fromX) * eased;
            this.y = ease.fromY + (targetY - ease.fromY) * eased;
            if (t >= 1) this._followEase = null;
            this._clampToBounds();
            return;
        }
        this.x += (targetX - this.x) * this.followSmoothing;
        this.y += (targetY - this.y) * this.followSmoothing;
        this._clampToBounds();
    }

    update(dt = 16, renderNow = performance.now()) {
        this._updateVillageTour(dt, renderNow);
        if (this._updateDirectorGlide(dt)) return;
        this._updateMomentum(dt);
        this._updateSnapZoom(dt);
        this._updateIdleDrift(dt, renderNow);
        if (!this._zoomAnimation) return;
        const anim = this._zoomAnimation;
        anim.elapsed += dt;
        const t = Math.min(1, anim.elapsed / anim.duration);
        const eased = 1 - Math.pow(1 - t, 3);
        this.zoom = anim.fromZoom + (anim.toZoom - anim.fromZoom) * eased;
        this.x = (anim.mouseX / this.zoom) - anim.worldBeforeX;
        this.y = (anim.mouseY / this.zoom) - anim.worldBeforeY;
        if (t >= 1) {
            this.zoom = anim.toZoom;
            this.x = (anim.mouseX / this.zoom) - anim.worldBeforeX;
            this.y = (anim.mouseY / this.zoom) - anim.worldBeforeY;
            this._zoomAnimation = null;
        }
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
            duration: 150,
        };
    }

    worldToScreen(worldX, worldY) {
        return {
            x: (worldX + this.x) * this.zoom,
            y: (worldY + this.y) * this.zoom,
        };
    }

    screenToWorld(screenX, screenY) {
        return {
            x: screenX / this.zoom - this.x,
            y: screenY / this.zoom - this.y,
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
        this._snapZoom = null;
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
        if (screenDistance <= deadzonePx && Math.abs(pose.zoom - this.zoom) < 0.01) return false;

        const eased = 1 - Math.exp(-frameDt / Math.max(1, stiffnessMs));
        const maxWorldStep = Math.max(1, maxSpeedPxPerMs * frameDt / Math.max(0.1, this.zoom || 1));
        const worldDistance = Math.hypot(dx, dy);
        const step = worldDistance > 0 ? Math.min(worldDistance * eased, maxWorldStep) / worldDistance : 0;
        this.x += dx * step;
        this.y += dy * step;

        // Zoom drifts even more slowly than pan, and only when hysteresis decided
        // that a zoom change is genuinely needed.
        if (Math.abs(pose.zoom - this.zoom) >= 0.01) {
            const zoomStep = Math.min(0.006 * frameDt, Math.abs(pose.zoom - this.zoom));
            this.zoom += Math.sign(pose.zoom - this.zoom) * zoomStep;
        }
        this._clampToBounds();
        return true;
    }

    applyTransform(ctx) {
        const dpr = this._dpr();
        ctx.setTransform(
            this.zoom * dpr,
            0,
            0,
            this.zoom * dpr,
            Math.round(this.x * this.zoom * dpr),
            Math.round(this.y * this.zoom * dpr)
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
        let zoom = this._zoomForWorldBox(box, paddingPx, maxZoom);
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
        const current = Math.max(this.minZoom, Math.min(this.zoom || this.minZoom, Math.min(maxZoom, this.maxZoom)));
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
        const worldCorners = mapWorldCorners(MAP_SIZE);
        const padX = Math.max(220, w / (this.zoom * 2.2));
        const padY = Math.max(160, h / (this.zoom * 2.2));
        const minX = Math.min(...worldCorners.map(p => p.x)) - padX;
        const maxX = Math.max(...worldCorners.map(p => p.x)) + padX;
        const minY = Math.min(...worldCorners.map(p => p.y)) - padY;
        const maxY = Math.max(...worldCorners.map(p => p.y)) + padY;
        const centerWorldX = w / (2 * this.zoom) - this.x;
        const centerWorldY = h / (2 * this.zoom) - this.y;
        const clampedX = Math.max(minX, Math.min(maxX, centerWorldX));
        const clampedY = Math.max(minY, Math.min(maxY, centerWorldY));
        this.x = w / (2 * this.zoom) - clampedX;
        this.y = h / (2 * this.zoom) - clampedY;
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
        if (this.dragging || this._momentum || this._directorGlide
            || this.followTarget || this._zoomAnimation || this._snapZoom
            || this._villageTour) {
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
            duration: TOUR_GLIDE_MS,
            maxZoom: stop.maxZoom,
            paddingPx: 170,
            owner: 'village-tour',
            composition: { x: 0.5, y: 0.55 },
            grade: { vignette: TOUR_VIGNETTE, worldTint: TOUR_WORLD_TINT },
        });
        tour.dwellUntil = renderNow + (started ? TOUR_GLIDE_MS + TOUR_DWELL_MS : 1500);
    }

    // Landmark circuit: one stop per building, ordered as a scenic loop around
    // the map. Hero tiers hold the wide frame (zoom 1), majors lean in (zoom 2).
    _villageTourStops() {
        if (this._tourStopsCache) return this._tourStopsCache;
        const byType = new Map(BUILDING_DEFS.map((def) => [def.type, def]));
        const ordered = TOUR_STOP_ORDER.map((type) => byType.get(type)).filter(Boolean);
        for (const def of BUILDING_DEFS) if (!ordered.includes(def)) ordered.push(def);
        this._tourStopsCache = ordered.map((def) => {
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
        const t = Math.min(1, glide.elapsed / glide.duration);
        const eased = 1 - Math.pow(1 - t, 3);
        this.zoom = glide.fromZoom + (glide.toZoom - glide.fromZoom) * eased;
        this.x = glide.fromX + (glide.toX - glide.fromX) * eased;
        this.y = glide.fromY + (glide.toY - glide.fromY) * eased;
        this._userAdjusted = false;
        this._clampToBounds();
        if (t >= 1) {
            this.zoom = glide.toZoom;
            this.x = glide.toX;
            this.y = glide.toY;
            this._clampToBounds();
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
        const eased = 1 - Math.pow(1 - t, 3);
        this._setZoomAboutCenter(anim.fromZoom + (anim.toZoom - anim.fromZoom) * eased);
        if (t >= 1) {
            this._setZoomAboutCenter(anim.toZoom);
            this._snapZoom = null;
        }
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

    _followFocusPoint(dt = 16) {
        const sprite = this.followTarget;
        const current = {
            x: Number(sprite?.x) || 0,
            y: Number(sprite?.y) || 0,
        };
        if (!sprite?.moving) return current;

        const next = Array.isArray(sprite.waypoints) && sprite.waypoints.length
            ? sprite.waypoints[0]
            : { x: sprite.targetX, y: sprite.targetY };
        if (!Number.isFinite(Number(next?.x)) || !Number.isFinite(Number(next?.y))) return current;

        const dx = Number(next.x) - current.x;
        const dy = Number(next.y) - current.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= 1) return current;

        const frameScale = Math.max(0.5, Math.min(2, (Number(dt) || 16) / 16));
        const leadPx = Math.min(180 / Math.max(1, this.zoom), 42 * frameScale + distance * 0.22);
        return {
            x: current.x + dx / distance * leadPx,
            y: current.y + dy / distance * leadPx,
        };
    }
}
