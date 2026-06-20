import { MAP_SIZE } from '../../config/constants.js';
import { mapWorldCorners, tileToWorld, worldToTile } from './Projection.js';

export class Camera {
    constructor(canvas) {
        this.canvas = canvas;
        this.x = 0;
        this.y = 0;
        this.zoom = 1;
        this.minZoom = 1;
        this.maxZoom = 3;
        this.zoomSteps = [1, 1.5, 2, 2.5, 3];
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
    fitToWorldBox(box, { paddingPx = 96, maxZoom = 2 } = {}) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !box) return;
        const boxW = Math.max(1, box.maxX - box.minX);
        const boxH = Math.max(1, box.maxY - box.minY);
        const centerX = (box.minX + box.maxX) / 2;
        const centerY = (box.minY + box.maxY) / 2;
        const hi = Math.min(Math.floor(maxZoom), this.maxZoom);
        let zoom = this.minZoom;
        for (let z = hi; z >= this.minZoom; z--) {
            if (boxW * z + paddingPx * 2 <= w && boxH * z + paddingPx * 2 <= h) {
                zoom = z;
                break;
            }
        }
        this._zoomAnimation = null;
        this._snapZoom = null;
        this._momentum = null;
        this.zoom = zoom;
        this.x = -centerX + w / (2 * zoom);
        this.y = -centerY + h / (2 * zoom);
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
    glideToWorld(box, { duration = 1400, paddingPx = 96, maxZoom = 2, grade = null } = {}) {
        const w = this._viewportWidth();
        const h = this._viewportHeight();
        if (!w || !h || !box) return false;
        const centerX = (box.minX + box.maxX) / 2;
        const centerY = (box.minY + box.maxY) / 2;
        const toZoom = this._zoomForWorldBox(box, paddingPx, maxZoom);
        const targetX = -centerX + w / (2 * toZoom);
        const targetY = -centerY + h / (2 * toZoom);

        this.stopFollow();
        this._momentum = null;
        this._zoomAnimation = null;
        this._snapZoom = null;

        if (this._reducedMotion) {
            // Reduced-motion: cut directly to the framed view, no glide, no grade.
            this.zoom = toZoom;
            this.x = targetX;
            this.y = targetY;
            this._directorGlide = null;
            this._userAdjusted = false;
            this._clampToBounds();
            return true;
        }

        this._userAdjusted = false;
        this._directorGlide = {
            fromX: this.x,
            fromY: this.y,
            fromZoom: this.zoom,
            toX: targetX,
            toY: targetY,
            toZoom,
            elapsed: 0,
            duration: Math.max(1, Number(duration) || 1400),
            grade: grade || null,
        };
        return true;
    }

    abortDirectorGlide() {
        if (!this._directorGlide) return;
        this._directorGlide = null;
        // The user is now in control; stop auto-framing from fighting them.
        this._userAdjusted = true;
    }

    isDirectorGliding() {
        return Boolean(this._directorGlide);
    }

    // #21 — grade weight (0..1) plus the active glide's grade hint, for the
    // WorldFrameRenderer vignette/worldTint pass. Ramps up at the head of the
    // move and eases back out at the tail so it never lingers.
    getDirectorGlideGrade() {
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
    }

    detach() {
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('wheel', this._onWheel);
    }

    followAgent(sprite) {
        if (this.followTarget === sprite) return;
        this._directorGlide = null;
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

    update(dt = 16) {
        if (this._updateDirectorGlide(dt)) return;
        this._updateMomentum(dt);
        this._updateSnapZoom(dt);
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
        this.abortDirectorGlide();
        this.dragging = true;
        this._userAdjusted = true;
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
        this.abortDirectorGlide();
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
        this.x = -screen.x + this._viewportWidth() / (2 * this.zoom);
        this.y = -screen.y + this._viewportHeight() / (2 * this.zoom);
        this._clampToBounds();
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

    // #21 — advance the director glide. Returns true while it owns the camera so
    // momentum/snap-zoom stay parked. Holds `_userAdjusted` false for the move's
    // duration, then sets it true so subsequent resizes keep the framed view.
    _updateDirectorGlide(dt) {
        const glide = this._directorGlide;
        if (!glide) return false;
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
            this._userAdjusted = true;
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
