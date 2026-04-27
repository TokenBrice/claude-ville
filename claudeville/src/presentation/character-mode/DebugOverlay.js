import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

export class DebugOverlay {
    constructor() {
        this.enabled = false;
    }

    toggle() {
        this.enabled = !this.enabled;
    }

    draw(ctx, { walkabilityGrid, bridgeTiles, agentSprites }) {
        if (!this.enabled) return;

        // Walkability tint: green = walkable, red = blocked, yellow = bridge.
        ctx.save();
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const wx = (x - y) * TILE_WIDTH / 2;
                const wy = (x + y) * TILE_HEIGHT / 2;
                const walkable = walkabilityGrid[y * MAP_SIZE + x] === 1;
                const isBridge = bridgeTiles?.has(`${x},${y}`);
                ctx.globalAlpha = 0.28;
                ctx.fillStyle = isBridge ? '#f2d36b' : walkable ? '#4caf50' : '#f44336';
                ctx.fillRect(wx - TILE_WIDTH / 4, wy - TILE_HEIGHT / 4, TILE_WIDTH / 2, TILE_HEIGHT / 2);
            }
        }
        ctx.restore();

        // Per-agent waypoint polylines.
        ctx.save();
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.75;
        for (const sprite of agentSprites.values()) {
            if (!sprite.waypoints?.length) continue;
            ctx.beginPath();
            ctx.moveTo(sprite.x, sprite.y);
            for (const wp of sprite.waypoints) ctx.lineTo(wp.x, wp.y);
            ctx.stroke();
        }
        ctx.restore();
    }
}
