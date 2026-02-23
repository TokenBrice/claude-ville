import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';

export class Camera {
    constructor(canvas) {
        this.canvas = canvas;
        this.x = 0;
        this.y = 0;
        this.zoom = 1.2;
        this.minZoom = 0.5;
        this.maxZoom = 3;
        this.dragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.camStartX = 0;
        this.camStartY = 0;

        // Follow 메커니즘
        this.followTarget = null;      // AgentSprite 참조
        this.followSmoothing = 0.08;   // lerp 계수 (낮을수록 부드러움)

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);

        this.centerOnMap();
    }

    centerOnMap() {
        const centerTile = MAP_SIZE / 2;
        const screenCenter = {
            x: (centerTile - centerTile) * TILE_WIDTH / 2,
            y: (centerTile + centerTile) * TILE_HEIGHT / 2,
        };
        this.x = -screenCenter.x + this.canvas.width / (2 * this.zoom);
        this.y = -screenCenter.y + this.canvas.height / (2 * this.zoom);
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
        const targetX = -this.followTarget.x + this.canvas.width / (2 * this.zoom);
        const targetY = -this.followTarget.y + this.canvas.height / (2 * this.zoom);
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
        // 드래그 시작하면 팔로우 해제
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

        // deltaMode 정규화 (0=px, 1=line, 2=page)
        let rawDelta = e.deltaY;
        if (e.deltaMode === 1) rawDelta *= 16;
        if (e.deltaMode === 2) rawDelta *= 100;

        // 클램핑: 맥 트랙패드(작은값 다수) / 윈도우 휠(큰값 소수) 둘 다 대응
        const clamped = Math.max(-60, Math.min(60, rawDelta));
        const zoomSpeed = 0.003;
        const factor = 1 - clamped * zoomSpeed;

        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));

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
        ctx.setTransform(this.zoom, 0, 0, this.zoom, this.x * this.zoom, this.y * this.zoom);
    }
}
