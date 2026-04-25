// SpriteSheet locates the right cell within a character sheet PNG.
// Sheet layout: 8 columns (directions S, SE, E, NE, N, NW, W, SW),
// 6 rows (walk-0..3 then idle-0..1). Each cell is `cellSize` px square.

export const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
export const WALK_FRAMES = 4;
export const IDLE_FRAMES = 2;

export class SpriteSheet {
    constructor(image, cellSize = 64) {
        this.image = image;
        this.cellSize = cellSize;
    }

    // animState: 'walk' | 'idle', dir: 0..7, frame: int
    cell(animState, dir, frame) {
        const col = dir;                                   // 0..7
        const baseRow = animState === 'idle' ? WALK_FRAMES : 0;
        const row = baseRow + (frame % (animState === 'idle' ? IDLE_FRAMES : WALK_FRAMES));
        return {
            sx: col * this.cellSize,
            sy: row * this.cellSize,
            sw: this.cellSize,
            sh: this.cellSize,
        };
    }
}

// Velocity → direction index. Returns 0..7 matching DIRECTIONS order.
// DIRECTIONS = ['s','se','e','ne','n','nw','w','sw'].
// In screen space: vy > 0 means moving south (down). atan2(vy, vx) is 0 at East,
// π/2 at South. We want South → 0, SE → 1, E → 2, NE → 3, N → 4, NW → 5, W → 6, SW → 7.
export function dirFromVelocity(vx, vy) {
    if (vx === 0 && vy === 0) return null;
    const angle = Math.atan2(vy, vx);                       // -π..π, 0 at East, π/2 at South
    // Map: East(0°)→2, South(90°)→0, West(180°)→6, North(270°)→4.
    // Formula: 2 - angle/(π/4), then modulo 8.
    const stepped = Math.round(2 - angle / (Math.PI / 4));
    return ((stepped % 8) + 8) % 8;
}
