export class Position {
    constructor(tileX, tileY) {
        this.tileX = tileX;
        this.tileY = tileY;
    }

    toScreen(tileWidth = 64, tileHeight = 32) {
        return {
            x: (this.tileX - this.tileY) * tileWidth / 2,
            y: (this.tileX + this.tileY) * tileHeight / 2,
        };
    }

    distanceTo(other) {
        const dx = this.tileX - other.tileX;
        const dy = this.tileY - other.tileY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    lerp(target, t) {
        return new Position(
            this.tileX + (target.tileX - this.tileX) * t,
            this.tileY + (target.tileY - this.tileY) * t,
        );
    }
}
