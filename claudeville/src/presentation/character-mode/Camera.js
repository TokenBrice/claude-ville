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

        // Drag momentum (world px/ms, decays after release)
        this._momentum = null;
        this._dragVelX = 0;
        this._dragVelY = 0;
        this._lastDragX = 0;
        this._lastDragY = 0;
        this._lastDragTime = 0;

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
