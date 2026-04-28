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

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);

        this.centerOnMap();
    }

    centerOnMap() {
        // Frame the village core while keeping the Pharos lighthouse and harbor in the first view.
        const tx = 27, ty = 21;
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
        this.followTarget = sprite;
    }

    stopFollow() {
        this.followTarget = null;
    }

    setReducedMotion(enabled) {
        this._reducedMotion = Boolean(enabled);
        if (this._reducedMotion) this._zoomAnimation = null;
    }

    updateFollow() {
        if (!this.followTarget) return;
        const targetX = -this.followTarget.x + this._viewportWidth() / (2 * this.zoom);
        const targetY = -this.followTarget.y + this._viewportHeight() / (2 * this.zoom);
        this.x += (targetX - this.x) * this.followSmoothing;
        this.y += (targetY - this.y) * this.followSmoothing;
        this._clampToBounds();
    }

    update(dt = 16) {
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
        this._clampToBounds();
    }

    _onMouseUp() {
        this.dragging = false;
        this.canvas.style.cursor = 'grab';
    }

    _onWheel(e) {
        e.preventDefault();
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
}
