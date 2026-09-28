// Connected-component helpers for 92 px character cells, shared by the V7
// feet audit (fragment detection) and the pose-strip generator (speck
// cleanup). A cell mask is a Uint8Array(size²) of 1 = opaque (alpha >= 16).

// 8-connected components, largest first: [{ size, pixels: Int32Array, minX, minY, maxX, maxY }].
export function components(mask, size) {
    const label = new Int32Array(mask.length).fill(-1);
    const stack = new Int32Array(mask.length);
    const found = [];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || label[start] >= 0) continue;
        const id = found.length;
        const pixels = [];
        let top = 0;
        stack[top++] = start;
        label[start] = id;
        let minX = size, minY = size, maxX = -1, maxY = -1;
        while (top) {
            const p = stack[--top];
            pixels.push(p);
            const x = p % size, y = (p / size) | 0;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= size) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= size) continue;
                    const q = ny * size + nx;
                    if (mask[q] && label[q] < 0) {
                        label[q] = id;
                        stack[top++] = q;
                    }
                }
            }
        }
        found.push({ size: pixels.length, pixels: Int32Array.from(pixels), minX, minY, maxX, maxY });
    }
    return found.sort((a, b) => b.size - a.size);
}

// Pixels of `mask` dilated by a Chebyshev radius.
export function dilate(mask, size, radius) {
    const out = new Uint8Array(mask.length);
    for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        const x = p % size, y = (p / size) | 0;
        for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= size) continue;
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = x + dx;
                if (nx >= 0 && nx < size) out[ny * size + nx] = 1;
            }
        }
    }
    return out;
}

// Detached parts of `mask` that the reference cell does not already carry
// (an idle sparkle or a floating badge stays legal when it sits within
// `slack` px of where the reference has its own detached part). Returns the
// new islands, largest first, excluding the body (the largest component).
export function newIslands(mask, referenceMask, size, { slack = 2 } = {}) {
    const [, ...islands] = components(mask, size);
    if (!islands.length) return [];
    const [, ...referenceIslands] = components(referenceMask, size);
    const known = new Uint8Array(mask.length);
    for (const island of referenceIslands) for (const p of island.pixels) known[p] = 1;
    const knownNear = dilate(known, size, slack);
    return islands.filter((island) => !island.pixels.some((p) => knownNear[p]));
}
