import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

export class DebugOverlay {
    constructor() {
        this.enabled = false;
    }

    toggle() {
        this.enabled = !this.enabled;
    }

    draw(ctx, { walkabilityGrid, bridgeTiles, agentSprites, buildings, sceneryZones, treeProps, boulderProps, visitIntents, visitReservations }) {
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

        // Visit target markers.
        const reservations = Array.isArray(visitReservations?.reservations) ? visitReservations.reservations : [];
        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.font = '10px monospace';
        ctx.textBaseline = 'bottom';
        for (const reservation of reservations) {
            const point = this._tileToScreen(reservation.tileX, reservation.tileY);
            ctx.strokeStyle = reservation.overflow ? '#ffeb3b' : '#00e5ff';
            ctx.fillStyle = 'rgba(23, 32, 42, 0.82)';
            ctx.beginPath();
            ctx.arc(point.x, point.y - 4, 6, 0, Math.PI * 2);
            ctx.stroke();
            const label = `${reservation.buildingType || '?'}:${reservation.agentId || '?'}`.slice(0, 24);
            const width = ctx.measureText(label).width + 6;
            ctx.fillRect(point.x + 7, point.y - 21, width, 13);
            ctx.fillStyle = reservation.overflow ? '#fff59d' : '#80deea';
            ctx.fillText(label, point.x + 10, point.y - 10);
        }
        ctx.restore();
    }

    drawScreen(ctx, { visitIntents, visitReservations, agentSprites, viewport, panelY = 12 } = {}) {
        if (!this.enabled) return;
        const intents = Array.isArray(visitIntents?.intents) ? visitIntents.intents : [];
        const reservations = Array.isArray(visitReservations?.reservations) ? visitReservations.reservations : [];
        const buildingStats = visitReservations?.buildings || {};
        const rows = [
            `agents: ${agentSprites?.size || 0}`,
            `intents: ${intents.length}`,
            `reservations: ${reservations.length}`,
            ...Object.entries(buildingStats)
                .filter(([, stat]) => (stat.occupied || stat.reserved) > 0)
                .slice(0, 12)
                .map(([type, stat]) => `${type}: occ ${stat.occupied} res ${stat.reserved}/${stat.capacity}`),
            ...intents.slice(0, 6).map((intent) => {
                const label = intent.label ? ` ${intent.label}` : '';
                return `${intent.agentId}: ${intent.building}/${intent.reason}${label}`;
            }),
            ...Array.from(agentSprites?.values?.() || [])
                .slice(0, 4)
                .map((sprite) => {
                    const snap = sprite.getBehaviorDebugSnapshot?.();
                    return snap ? `${snap.name || snap.agentId}: ${snap.behaviorState}/${snap.building || '?'}` : null;
                })
                .filter(Boolean),
        ];
        const padding = 8;
        const lineHeight = 14;
        ctx.save();
        ctx.font = '11px monospace';
        const width = Math.min(
            420,
            Math.max(210, ...rows.map((row) => ctx.measureText(row).width + padding * 2)),
        );
        const height = rows.length * lineHeight + padding * 2;
        const x = 12;
        const y = panelY;

        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(20, 24, 31, 0.86)';
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.72)';
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, width, height);
        ctx.strokeRect(x + 0.5, y + 0.5, width, height);
        ctx.fillStyle = '#f5e6a8';
        rows.forEach((row, index) => {
            const maxWidth = (viewport?.width || width) - x - padding * 2;
            ctx.fillText(row, x + padding, y + padding + index * lineHeight, Math.max(120, Math.min(width - padding * 2, maxWidth)));
        });
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
