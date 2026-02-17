import { Position } from '../value-objects/Position.js';

export class Building {
    constructor({ type, x, y, width, height, label, icon, description }) {
        this.type = type;
        this.position = new Position(x, y);
        this.width = width || 4;
        this.height = height || 4;
        this.label = label;
        this.icon = icon;
        this.description = description;
    }

    containsPoint(tileX, tileY) {
        return tileX >= this.position.tileX &&
               tileX < this.position.tileX + this.width &&
               tileY >= this.position.tileY &&
               tileY < this.position.tileY + this.height;
    }
}
