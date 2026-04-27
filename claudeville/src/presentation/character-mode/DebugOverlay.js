import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

export class DebugOverlay {
    constructor() {
        this.enabled = false;
    }

    toggle() {
        this.enabled = !this.enabled;
    }

    draw(ctx, { walkabilityGrid, bridgeTiles, agentSprites, buildings, sceneryZones, treeProps, boulderProps }) {
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

        // Building footprints and tall-scenery sightline exclusions.
        ctx.save();
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.9;
        if (buildings) {
            ctx.strokeStyle = '#ff9800';
            for (const building of buildings.values()) {
                this._strokeTileRect(ctx, {
                    x0: building.position.tileX,
                    y0: building.position.tileY,
                    x1: building.position.tileX + building.width,
                    y1: building.position.tileY + building.height,
                });
                const rects = typeof building.walkExclusionRects === 'function'
                    ? building.walkExclusionRects()
                    : [];
                ctx.strokeStyle = 'rgba(255, 193, 7, 0.95)';
                for (const rect of rects) {
                    this._strokeTileRect(ctx, {
                        x0: rect.x0,
                        y0: rect.y0,
                        x1: rect.x1 + 1,
                        y1: rect.y1 + 1,
                    });
                }
                ctx.strokeStyle = '#ff9800';
            }
        }
        if (Array.isArray(sceneryZones)) {
            for (const zone of sceneryZones) {
                ctx.strokeStyle = 'rgba(255, 64, 129, 0.92)';
                this._strokeTileRect(ctx, zone.padded);
                if (zone.sightline) {
                    ctx.strokeStyle = 'rgba(171, 71, 188, 0.82)';
                    this._strokeTileRect(ctx, zone.sightline);
                }
            }
        }
        ctx.restore();

        // Tall prop anchors.
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#00e676';
        for (const prop of treeProps || []) this._drawAnchor(ctx, prop.tileX, prop.tileY, 2.5);
        ctx.fillStyle = '#b0bec5';
        for (const prop of boulderProps || []) this._drawAnchor(ctx, prop.tileX, prop.tileY, 2);
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

    _tileToScreen(tileX, tileY) {
        return {
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: (tileX + tileY) * TILE_HEIGHT / 2,
        };
    }

    _strokeTileRect(ctx, rect) {
        const nw = this._tileToScreen(rect.x0, rect.y0);
        const ne = this._tileToScreen(rect.x1, rect.y0);
        const se = this._tileToScreen(rect.x1, rect.y1);
        const sw = this._tileToScreen(rect.x0, rect.y1);
        ctx.beginPath();
        ctx.moveTo(nw.x, nw.y);
        ctx.lineTo(ne.x, ne.y);
        ctx.lineTo(se.x, se.y);
        ctx.lineTo(sw.x, sw.y);
        ctx.closePath();
        ctx.stroke();
    }

    _drawAnchor(ctx, tileX, tileY, radius) {
        const p = this._tileToScreen(tileX, tileY);
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}
