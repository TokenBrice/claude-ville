import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

export class Camera {
    constructor(canvas) {
        this.canvas = canvas;
        this.x = 0;
        this.y = 0;
        this.zoom = 1;
        this.minZoom = 1;
        this.maxZoom = 3;
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
        // Frame the heart of the village (slightly off-center from Command Center at 18,18)
        const tx = 20, ty = 20;
        const screenX = (tx - ty) * (TILE_WIDTH / 2);
        const screenY = (tx + ty) * (TILE_HEIGHT / 2);
        this.zoom = 1;
        if (!this.canvas) return;
        this.x = -screenX + this._viewportWidth() / (2 * this.zoom);
        this.y = -screenY + this._viewportHeight() / (2 * this.zoom);
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

    updateFollow() {
        if (!this.followTarget) return;
        const targetX = -this.followTarget.x + this._viewportWidth() / (2 * this.zoom);
        const targetY = -this.followTarget.y + this._viewportHeight() / (2 * this.zoom);
        this.x += (targetX - this.x) * this.followSmoothing;
        this.y += (targetY - this.y) * this.followSmoothing;
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
    }

    _onMouseUp() {
        this.dragging = false;
        this.canvas.style.cursor = 'grab';
    }

    _onWheel(e) {
        e.preventDefault();
        const mouseX = e.offsetX;
        const mouseY = e.offsetY;

        const worldBeforeX = (mouseX / this.zoom) - this.x;
        const worldBeforeY = (mouseY / this.zoom) - this.y;

        // Discrete zoom stepping follows the canvas contract: {1, 2, 3}.
        const direction = e.deltaY < 0 ? 1 : -1;
        const steps = [this.minZoom, 2, this.maxZoom];
        const currentIndex = steps.reduce((bestIndex, step, index) => (
            Math.abs(step - this.zoom) < Math.abs(steps[bestIndex] - this.zoom) ? index : bestIndex
        ), 0);
        const nextIndex = Math.max(0, Math.min(steps.length - 1, currentIndex + direction));
        this.zoom = steps[nextIndex];

        this.x = (mouseX / this.zoom) - worldBeforeX;
        this.y = (mouseY / this.zoom) - worldBeforeY;
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
        const tileX = (world.x / (TILE_WIDTH / 2) + world.y / (TILE_HEIGHT / 2)) / 2;
        const tileY = (world.y / (TILE_HEIGHT / 2) - world.x / (TILE_WIDTH / 2)) / 2;
        return { tileX: Math.floor(tileX), tileY: Math.floor(tileY) };
    }

    applyTransform(ctx) {
        ctx.setTransform(this.zoom, 0, 0, this.zoom, Math.round(this.x * this.zoom), Math.round(this.y * this.zoom));
    }

    _viewportWidth() {
        return this.canvas?.clientWidth || this.canvas?.width || 0;
    }

    _viewportHeight() {
        return this.canvas?.clientHeight || this.canvas?.height || 0;
    }
}
