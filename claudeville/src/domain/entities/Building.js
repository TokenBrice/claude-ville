import { Position } from '../value-objects/Position.js';

export class Building {
    constructor({
        type,
        x,
        y,
        width,
        height,
        label,
        icon,
        description,
        labelPriority,
        shortLabel,
        district,
        visualTier,
        entrance,
        visitTiles,
        walkExclusion,
        scenery,
    }) {
        this.type = type;
        this.position = new Position(x, y);
        this.width = width || 4;
        this.height = height || 4;
        this.label = label;
        this.shortLabel = shortLabel || null;
        this.icon = icon;
        this.description = description;
        this.labelPriority = labelPriority || 'normal';
        this.district = district || 'village';
        this.visualTier = visualTier || 'major';
        this.entrance = entrance ? { tileX: entrance.tileX, tileY: entrance.tileY } : null;
        this.visitTiles = Array.isArray(visitTiles)
            ? visitTiles.map((tile) => ({ tileX: tile.tileX, tileY: tile.tileY }))
            : [];
        this.walkExclusion = this._normalizeWalkExclusions(walkExclusion);
        this.scenery = scenery ? {
            excludePadding: scenery.excludePadding ? { ...scenery.excludePadding } : null,
            sightline: scenery.sightline ? { ...scenery.sightline } : null,
            tallPropClearance: scenery.tallPropClearance ?? null,
        } : null;
    }

    containsPoint(tileX, tileY) {
        return tileX >= this.position.tileX &&
               tileX < this.position.tileX + this.width &&
               tileY >= this.position.tileY &&
               tileY < this.position.tileY + this.height;
    }

    containsVisitPoint(tileX, tileY) {
        const roundedX = Math.round(tileX);
        const roundedY = Math.round(tileY);
        return this.visitTiles.some((tile) => (
            Math.round(tile.tileX) === roundedX &&
            Math.round(tile.tileY) === roundedY
        ));
    }

    _normalizeWalkExclusions(walkExclusion) {
        if (!Array.isArray(walkExclusion)) return [];
        return walkExclusion.map((rect) => {
            const x0 = Number.isFinite(rect.x)
                ? rect.x
                : this.position.tileX + (rect.dx || 0);
            const y0 = Number.isFinite(rect.y)
                ? rect.y
                : this.position.tileY + (rect.dy || 0);
            const width = Math.max(1, Math.floor(rect.width || 1));
            const height = Math.max(1, Math.floor(rect.height || 1));
            return {
                x0: Math.floor(x0),
                y0: Math.floor(y0),
                x1: Math.floor(x0) + width - 1,
                y1: Math.floor(y0) + height - 1,
            };
        });
    }

    walkExclusionRects() {
        return this.walkExclusion.map((rect) => ({ ...rect }));
    }

    blocksWalkTile(tileX, tileY) {
        const x = Math.round(tileX);
        const y = Math.round(tileY);
        return this.containsPoint(x, y) || this.walkExclusion.some((rect) => (
            x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1
        ));
    }

    primaryVisitTile() {
        return this.visitTiles[0] || this.entrance || {
            tileX: this.position.tileX + Math.floor(this.width / 2),
            tileY: this.position.tileY + this.height,
        };
    }

    isAgentVisiting(agent) {
        if (!agent?.position) return false;
        return this.containsPoint(agent.position.tileX, agent.position.tileY) ||
            this.containsVisitPoint(agent.position.tileX, agent.position.tileY);
    }
}
