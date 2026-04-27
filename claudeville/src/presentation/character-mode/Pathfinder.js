import { MAP_SIZE } from '../../config/constants.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

export class Pathfinder {
    constructor(grid) {
        this.grid = grid;
        this.walkableTiles = this._buildWalkableList(grid);
    }

    _buildWalkableList(grid) {
        const tiles = [];
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                if (grid[y * MAP_SIZE + x] === 1) tiles.push({ tileX: x, tileY: y });
            }
        }
        return tiles;
    }

    sampleWalkable(rng) {
        return this.walkableTiles[Math.min(this.walkableTiles.length - 1, Math.floor(rng * this.walkableTiles.length))];
    }

    setGrid(grid) {
        this.grid = grid;
        this.walkableTiles = this._buildWalkableList(grid);
    }

    isWalkable(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return false;
        return this.grid[tileY * MAP_SIZE + tileX] === 1;
    }

    // Returns an array of {tileX, tileY} waypoints from `from` exclusive to `to` inclusive.
    // Empty array if unreachable. If straight-line works (no obstacles between centers
    // sampled at tile granularity), returns the single waypoint [to].
    findPath(from, to, bridgeTiles) {
        const fx = Math.round(from.tileX);
        const fy = Math.round(from.tileY);

        // Guard: if the start tile is unwalkable (e.g., agent currently
        // straddling a shore tile due to floating-point drift), search the
        // 4 cardinal neighbors for a walkable foothold and recurse from
        // there. Prevents agents from getting permanently stuck.
        if (!this.isWalkable(fx, fy)) {
            for (const [dx, dy] of DIRS) {
                const nx = fx + dx;
                const ny = fy + dy;
                if (!this.isWalkable(nx, ny)) continue;
                const sub = this.findPath({ tileX: nx, tileY: ny }, to, bridgeTiles);
                if (sub.length > 0) return [{ tileX: nx, tileY: ny }, ...sub];
            }
            console.warn('[Pathfinder] stuck: no walkable cardinal neighbor at', fx, fy);
            return [];
        }

        const targetCandidates = this._walkableCandidates(Math.round(to.tileX), Math.round(to.tileY));
        if (targetCandidates.length === 0) return [];

        // Fast path: if a tile-step line from `from` to `to` never crosses a blocked tile,
        // skip BFS entirely.
        for (const target of targetCandidates) {
            if (this._lineWalkable(fx, fy, target.tileX, target.tileY)) {
                return [{ tileX: target.tileX, tileY: target.tileY }];
            }
        }

        // BFS — index-pointer queue (O(n)) and integer target set (no string allocation).
        const N = MAP_SIZE;
        const visited = new Uint8Array(N * N);
        const parent = new Int32Array(N * N).fill(-1);
        const targetSet = new Set(targetCandidates.map(({ tileX, tileY }) => tileY * N + tileX));
        const queue = [fy * N + fx];
        let head = 0;
        visited[fy * N + fx] = 1;
        let foundIdx = -1;
        while (head < queue.length) {
            const cur = queue[head++];
            if (targetSet.has(cur)) {
                foundIdx = cur;
                break;
            }
            const cx = cur % N;
            const cy = (cur - cx) / N;
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                // Corner-cut guard: diagonal step requires both axis-aligned neighbors walkable.
                if (dx !== 0 && dy !== 0 && (!this.isWalkable(cx + dx, cy) || !this.isWalkable(cx, cy + dy))) continue;
                const idx = ny * N + nx;
                if (visited[idx]) continue;
                if (!this.isWalkable(nx, ny)) continue;
                visited[idx] = 1;
                parent[idx] = cur;
                queue.push(idx);
            }
        }
        if (foundIdx === -1) {
            console.warn('[Pathfinder] no path from', fx, fy, 'to nearest of', targetCandidates.length, 'candidates; closest:', JSON.stringify(targetCandidates[0]));
            return [];
        }

        // Reconstruct path from to -> from.
        const tiles = [];
        let cur = foundIdx;
        while (cur !== -1 && cur !== fy * N + fx) {
            tiles.push({ tileX: cur % N, tileY: (cur - (cur % N)) / N });
            cur = parent[cur];
        }
        tiles.reverse();
        return this._lookahead(this._simplify(tiles, bridgeTiles), bridgeTiles);
    }

    _walkableCandidates(tileX, tileY) {
        const candidates = [];
        if (this.isWalkable(tileX, tileY)) candidates.push({ tileX, tileY });

        for (let radius = 1; radius <= 5; radius++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                    const nx = tileX + dx;
                    const ny = tileY + dy;
                    if (this.isWalkable(nx, ny)) candidates.push({ tileX: nx, tileY: ny });
                }
            }
        }
        return candidates;
    }

    _lineWalkable(x0, y0, x1, y1) {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        let cx = x0;
        let cy = y0;
        while (true) {
            if (!this.isWalkable(cx, cy)) return false;
            if (cx === x1 && cy === y1) return true;
            const e2 = 2 * err;
            if (e2 > -dy && e2 < dx) {
                // Diagonal step — check both corner tiles to prevent corner-cutting.
                if (!this.isWalkable(cx + sx, cy) || !this.isWalkable(cx, cy + sy)) return false;
                err -= dy; cx += sx;
                err += dx; cy += sy;
            } else {
                if (e2 > -dy) { err -= dy; cx += sx; }
                if (e2 < dx) { err += dx; cy += sy; }
            }
        }
    }

    _simplify(tiles, bridgeTiles) {
        if (tiles.length <= 1) return tiles;
        const out = [];
        let prevDir = null;
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            const next = tiles[i + 1];
            const onBridge = bridgeTiles?.has(`${t.tileX},${t.tileY}`);
            if (!next) {
                out.push(t); // always include final destination
                break;
            }
            const dir = `${Math.sign(next.tileX - t.tileX)},${Math.sign(next.tileY - t.tileY)}`;
            if (onBridge || dir !== prevDir) {
                out.push(t);
            }
            prevDir = dir;
        }
        return out;
    }

    _lookahead(tiles, bridgeTiles) {
        if (tiles.length <= 2) return tiles;
        const out = [tiles[0]];
        let i = 0;
        while (i < tiles.length - 1) {
            // Find the furthest waypoint reachable via a clear straight line from tiles[i].
            let j = tiles.length - 1;
            while (j > i + 1) {
                // Never skip over bridge tiles — they must remain explicit waypoints.
                const hasBridge = tiles.slice(i + 1, j).some(
                    t => bridgeTiles?.has(`${t.tileX},${t.tileY}`)
                );
                if (!hasBridge && this._lineWalkable(
                    tiles[i].tileX, tiles[i].tileY,
                    tiles[j].tileX, tiles[j].tileY,
                )) break;
                j--;
            }
            out.push(tiles[j]);
            i = j;
        }
        return out;
    }
}
