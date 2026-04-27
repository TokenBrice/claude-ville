import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

const WAYPOINTS = [
    { tileX: 8, tileY: 17 },
    { tileX: 12, tileY: 21 },
    { tileX: 16, tileY: 21 },
    { tileX: 12, tileY: 20 },
];
const SPEED_TILES_PER_FRAME = 0.018;
const PAUSE_MS = 6000;
const SPRITE_ID = 'character.chronicler';

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

export class Chronicler {
    constructor({ assets = null, sprites = null, motionScale = 1 } = {}) {
        this.assets = assets;
        this.sprites = sprites;
        this.motionScale = motionScale;
        this.tileX = WAYPOINTS[0].tileX;
        this.tileY = WAYPOINTS[0].tileY;
        this.targetIndex = 1;
        this.pauseUntil = 0;
        this.frame = 0;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    update(dt = 16, now = Date.now()) {
        if (this.motionScale === 0) return;
        if (now < this.pauseUntil) return;
        const target = WAYPOINTS[this.targetIndex % WAYPOINTS.length];
        const dx = target.tileX - this.tileX;
        const dy = target.tileY - this.tileY;
        const distance = Math.hypot(dx, dy);
        if (distance < 0.04) {
            this.tileX = target.tileX;
            this.tileY = target.tileY;
            this.targetIndex = (this.targetIndex + 1) % WAYPOINTS.length;
            this.pauseUntil = now + PAUSE_MS;
            return;
        }
        const step = SPEED_TILES_PER_FRAME * (dt / 16);
        this.tileX += dx / distance * Math.min(step, distance);
        this.tileY += dy / distance * Math.min(step, distance);
        this.frame += dt / 120;
    }

    enumerateDrawables() {
        const world = toWorld(this.tileX, this.tileY);
        return [{
            kind: 'chronicler',
            sortY: world.y,
            payload: { ...world, tileX: this.tileX, tileY: this.tileY },
        }];
    }

    draw(ctx, drawable, zoom = 1) {
        const payload = drawable?.payload || drawable || {};
        const x = Math.round(payload.x || 0);
        const y = Math.round(payload.y || 0);
        if (this.assets?.has?.(SPRITE_ID)) {
            const img = this.assets.get(SPRITE_ID);
            const dims = this.assets.getDims(SPRITE_ID) || { w: 92, h: 92 };
            ctx.drawImage(img, Math.round(x - dims.w / 2), Math.round(y - dims.h + 10));
            return;
        }
        this._drawProcedural(ctx, x, y, zoom);
    }

    _drawProcedural(ctx, x, y, zoom) {
        const bob = this.motionScale ? Math.sin(this.frame) * 1.2 : 0;
        ctx.save();
        ctx.translate(x, y + bob);
        ctx.fillStyle = 'rgba(20, 16, 12, 0.28)';
        ctx.beginPath();
        ctx.ellipse(0, 6, 10, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#5b4a68';
        ctx.strokeStyle = '#2f2638';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.beginPath();
        ctx.moveTo(0, -28);
        ctx.lineTo(10, -7);
        ctx.lineTo(5, 5);
        ctx.lineTo(-6, 5);
        ctx.lineTo(-10, -7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#d7b979';
        ctx.fillRect(3, -9, 9, 6);
        ctx.fillStyle = '#f2d9a0';
        ctx.beginPath();
        ctx.arc(0, -20, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}
