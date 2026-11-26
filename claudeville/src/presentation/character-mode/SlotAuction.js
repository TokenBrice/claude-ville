// W5-C — Exact Min-Cost Visit Slot Assignment & Shared-Grid Overlay Label Auction (spec §3.2).
//
// Provides two allocation-free combinatorial solvers for Wave 5:
//   1. Visit Slot Assignment (`solveSlotAssignment` + `buildVisitSlotCost`):
//      - Exact O(n^3) Hungarian / Jonker-Volgenant solver when max(m, n) <= 12.
//      - Deterministic Bertsekas epsilon-auction (epsilon = 0.5) when > 12.
//      - 15% hysteresis discount (`-0.15 * bestAltCost`) eliminating slot thrash.
//   2. Shared-Grid Overlay Label Auction (`OverlayOccupancyGrid`,
//      `clusterAttentionBeacons`, `solveLabelAuction`):
//      - Shared 96 px flat typed-array spatial occupancy grid with reserve order:
//        (1) static building plaques / Carved Motifs,
//        (2) AttentionPlates (precomputed width table + X sweep-line union-find
//            clustering within GROUP_RADIUS = 96 px),
//        (3) ThoughtColumn (<= 24 speakers x <= 30 candidates solved via
//            deterministic epsilon-auction, epsilon = 1, <= 40 iterations,
//            sticky prior -2 bonus, boundsViolation * 1000).
//
// Steady-state per-frame solves reuse module-level typed arrays (ZERO GC).

import {
    THOUGHT_CANDIDATE_COUNT,
    THOUGHT_CANDIDATE_LATERAL,
    THOUGHT_CANDIDATE_SLOT,
    THOUGHT_CHAR_ADVANCE,
    THOUGHT_DISPLAY_ADVANCE,
    THOUGHT_STACK_STEP,
} from './ThoughtColumn.js';

export const SLOT_HUNGARIAN_MAX = 12;
export const SLOT_AUCTION_EPSILON = 0.5;
export const SLOT_AUCTION_MAX_ITERS = 4096;
export const SLOT_FLOW_WEIGHT = 4.0;
export const SLOT_OVERFLOW_PENALTY = 35;
export const SLOT_HYSTERESIS_FACTOR = 0.15;

export const OVERLAY_GRID_CELL = 96;
export const OVERLAY_LAYER_PLAQUE = 1;
export const OVERLAY_LAYER_ATTENTION = 2;
export const OVERLAY_LAYER_THOUGHT = 3;

export const ATTENTION_GROUP_RADIUS = 96;
export const ATTENTION_PLATE_HEIGHT = 17;
export const ATTENTION_NOTCH_ROWS = 3;
export const ATTENTION_STACK_STEP = 20;
const ATTENTION_WORD_PAD = 4;
const ATTENTION_TEXT_PAD = 5;
const ATTENTION_AGE_NOTCH_W = 3;
const ATTENTION_AGE_NOTCH_GAP = 3;
const ATTENTION_NAME_MAX_CHARS = 18;

export const LABEL_MAX_SPEAKERS = 24;
export const LABEL_MAX_CANDIDATES = THOUGHT_CANDIDATE_COUNT; // 30
export const LABEL_AUCTION_EPSILON = 1;
export const LABEL_AUCTION_MAX_ITERS = 40;
export const LABEL_STICKY_BONUS = -2;
export const LABEL_BOUNDS_PENALTY = 1000;

const BIG_COST = 1e12;
const LABEL_MAX_BID_STEP = 200;
const LABEL_UNASSIGNABLE_COST = 50000;

// ---------------------------------------------------------------------------
// 1. Visit Slot Cost & Min-Cost Assignment (Hungarian <= 12, ε-Auction > 12)
// ---------------------------------------------------------------------------

/**
 * Exact §3.2 visit slot cost formula with 15% hysteresis discount.
 */
export function buildVisitSlotCost({
    flowCost = 0,
    overflow = false,
    relatedClusterBonus = 0,
    facingMatchBonus = 0,
    isCurrentSlot = false,
    bestAltCost = 0,
} = {}) {
    return (Number(flowCost) || 0) * SLOT_FLOW_WEIGHT
        + (overflow ? SLOT_OVERFLOW_PENALTY : 0)
        - (Number(relatedClusterBonus) || 0)
        - (Number(facingMatchBonus) || 0)
        - (isCurrentSlot ? SLOT_HYSTERESIS_FACTOR * (Number(bestAltCost) || 0) : 0);
}

// Reusable pre-allocated typed arrays for exact Hungarian solver (<= 12 x 12).
const HUNGARIAN_CAP = SLOT_HUNGARIAN_MAX + 2;
const hungarianScratch = {
    u: new Float64Array(HUNGARIAN_CAP),
    v: new Float64Array(HUNGARIAN_CAP),
    minv: new Float64Array(HUNGARIAN_CAP),
    p: new Int32Array(HUNGARIAN_CAP),
    way: new Int32Array(HUNGARIAN_CAP),
    used: new Uint8Array(HUNGARIAN_CAP),
};

// Reusable pre-allocated typed arrays for > 12 deterministic ε-auction.
const INITIAL_AUCTION_CAP = 256;
const auctionScratch = {
    cap: INITIAL_AUCTION_CAP,
    price: new Float64Array(INITIAL_AUCTION_CAP),
    objOwner: new Int32Array(INITIAL_AUCTION_CAP),
    bidderObj: new Int32Array(INITIAL_AUCTION_CAP),
    queue: new Int32Array(INITIAL_AUCTION_CAP * 2),
    outDefault: new Int32Array(INITIAL_AUCTION_CAP),
};

function ensureAuctionCapacity(maxDim) {
    if (maxDim <= auctionScratch.cap) return;
    let nextCap = auctionScratch.cap;
    while (nextCap < maxDim) nextCap *= 2;
    auctionScratch.cap = nextCap;
    auctionScratch.price = new Float64Array(nextCap);
    auctionScratch.objOwner = new Int32Array(nextCap);
    auctionScratch.bidderObj = new Int32Array(nextCap);
    auctionScratch.queue = new Int32Array(nextCap * 2);
    auctionScratch.outDefault = new Int32Array(nextCap);
}

function readCost(costMatrix, is2D, numSlots, agentIdx, slotIdx) {
    const raw = is2D
        ? costMatrix[agentIdx][slotIdx]
        : costMatrix[agentIdx * numSlots + slotIdx];
    return Number.isFinite(raw) ? raw : BIG_COST;
}

function solveHungarian(costMatrix, is2D, numAgents, numSlots, outAssignment) {
    const transposed = numAgents > numSlots;
    const rows = transposed ? numSlots : numAgents;
    const cols = transposed ? numAgents : numSlots;

    const u = hungarianScratch.u;
    const v = hungarianScratch.v;
    const minv = hungarianScratch.minv;
    const p = hungarianScratch.p;
    const way = hungarianScratch.way;
    const used = hungarianScratch.used;

    for (let i = 0; i <= rows; i++) u[i] = 0;
    for (let j = 0; j <= cols; j++) {
        v[j] = 0;
        p[j] = 0;
        way[j] = 0;
    }

    for (let i = 1; i <= rows; i++) {
        p[0] = i;
        let j0 = 0;
        for (let j = 0; j <= cols; j++) {
            minv[j] = Infinity;
            used[j] = 0;
        }

        do {
            used[j0] = 1;
            const i0 = p[j0];
            let delta = Infinity;
            let j1 = 0;

            for (let j = 1; j <= cols; j++) {
                if (used[j]) continue;
                const c = transposed
                    ? readCost(costMatrix, is2D, numSlots, j - 1, i0 - 1)
                    : readCost(costMatrix, is2D, numSlots, i0 - 1, j - 1);
                const cur = c - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }

            if (j1 === 0) break;

            for (let j = 0; j <= cols; j++) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
        } while (p[j0] !== 0);

        while (j0 !== 0) {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        }
    }

    for (let i = 0; i < numAgents; i++) outAssignment[i] = -1;
    for (let j = 1; j <= cols; j++) {
        const row = p[j];
        if (row <= 0) continue;
        const agentIdx = transposed ? (j - 1) : (row - 1);
        const slotIdx = transposed ? (row - 1) : (j - 1);
        const raw = is2D
            ? costMatrix[agentIdx][slotIdx]
            : costMatrix[agentIdx * numSlots + slotIdx];
        outAssignment[agentIdx] = Number.isFinite(raw) ? slotIdx : -1;
    }
    return outAssignment;
}

function solveEpsilonAuction(costMatrix, is2D, numAgents, numSlots, outAssignment, epsilon, maxIters) {
    const transposed = numAgents > numSlots;
    const bidders = transposed ? numSlots : numAgents;
    const objects = transposed ? numAgents : numSlots;
    ensureAuctionCapacity(objects);

    const price = auctionScratch.price;
    const objOwner = auctionScratch.objOwner;
    const bidderObj = auctionScratch.bidderObj;
    const queue = auctionScratch.queue;
    const qCap = queue.length;

    // Single-phase Bertsekas forward auction at exact `epsilon`:
    // Maintains the asymmetric complementary-slackness invariant that every
    // unassigned object retains price === 0, guaranteeing totalCost <= opt + bidders * eps.
    for (let j = 0; j < objects; j++) {
        price[j] = 0;
        objOwner[j] = -1;
    }
    let qHead = 0;
    let qTail = 0;
    for (let i = 0; i < bidders; i++) {
        bidderObj[i] = -1;
        queue[qTail] = i;
        qTail = (qTail + 1) % qCap;
    }

    let totalBids = 0;
    const bidLimit = Math.max(maxIters, bidders * objects * 32);

    while (qHead !== qTail && totalBids < bidLimit) {
        const bidder = queue[qHead];
        qHead = (qHead + 1) % qCap;
        totalBids++;

        let bestObj = -1;
        let bestNet = Infinity;
        let secondNet = Infinity;

        for (let j = 0; j < objects; j++) {
            const c = transposed
                ? readCost(costMatrix, is2D, numSlots, j, bidder)
                : readCost(costMatrix, is2D, numSlots, bidder, j);
            const net = c + price[j];
            if (net < bestNet) {
                secondNet = bestNet;
                bestNet = net;
                bestObj = j;
            } else if (net < secondNet) {
                secondNet = net;
            }
        }

        if (bestObj < 0) continue;
        const bidInc = objects > 1 && Number.isFinite(secondNet)
            ? (secondNet - bestNet) + epsilon
            : epsilon;
        price[bestObj] += bidInc;

        const prevOwner = objOwner[bestObj];
        if (prevOwner !== -1) {
            bidderObj[prevOwner] = -1;
            queue[qTail] = prevOwner;
            qTail = (qTail + 1) % qCap;
        }
        objOwner[bestObj] = bidder;
        bidderObj[bidder] = bestObj;
    }

    // Safety completion: if a pathological input hits bidLimit, assign any
    // remaining unassigned bidders greedily to lowest-cost free objects.
    for (let i = 0; i < bidders; i++) {
        if (bidderObj[i] !== -1) continue;
        let bestObj = -1;
        let bestCost = Infinity;
        for (let j = 0; j < objects; j++) {
            if (objOwner[j] !== -1) continue;
            const c = transposed
                ? readCost(costMatrix, is2D, numSlots, j, i)
                : readCost(costMatrix, is2D, numSlots, i, j);
            if (c < bestCost) {
                bestCost = c;
                bestObj = j;
            }
        }
        if (bestObj !== -1) {
            objOwner[bestObj] = i;
            bidderObj[i] = bestObj;
        }
    }

    for (let i = 0; i < numAgents; i++) outAssignment[i] = -1;
    for (let i = 0; i < bidders; i++) {
        const j = bidderObj[i];
        if (j < 0) continue;
        const agentIdx = transposed ? j : i;
        const slotIdx = transposed ? i : j;
        const raw = is2D
            ? costMatrix[agentIdx][slotIdx]
            : costMatrix[agentIdx * numSlots + slotIdx];
        outAssignment[agentIdx] = Number.isFinite(raw) ? slotIdx : -1;
    }
    return outAssignment;
}

/**
 * Min-cost slot assignment solver.
 *
 * Uses exact O(n^3) Hungarian / Jonker-Volgenant when `max(numAgents, numSlots) <= 12`
 * and deterministic Bertsekas ε-auction (`ε = 0.5`) when `> 12`.
 *
 * `costMatrix` may be a flat row-major TypedArray/Array of length `numAgents * numSlots`
 * or a 2D array `costMatrix[agent][slot]`.
 * Writes assigned slot indices (`0..numSlots-1`, or `-1` if unassigned) into
 * `outAssignment` and returns it.
 */
export function solveSlotAssignment(
    costMatrix,
    numAgents,
    numSlots,
    outAssignment = null,
    options = null,
) {
    const m = Math.max(0, numAgents | 0);
    const n = Math.max(0, numSlots | 0);
    ensureAuctionCapacity(Math.max(m, n, 1));
    const out = outAssignment || auctionScratch.outDefault;

    for (let i = 0; i < m; i++) out[i] = -1;
    if (m === 0 || n === 0 || !costMatrix) return out;

    const is2D = Array.isArray(costMatrix[0]) || ArrayBuffer.isView(costMatrix[0]);
    const maxDim = m > n ? m : n;
    const forceAuction = Boolean(options && options.forceAuction);

    if (!forceAuction && maxDim <= SLOT_HUNGARIAN_MAX) {
        return solveHungarian(costMatrix, is2D, m, n, out);
    }

    const epsilon = options && Number.isFinite(options.epsilon) && options.epsilon > 0
        ? options.epsilon
        : SLOT_AUCTION_EPSILON;
    const maxIters = options && Number.isInteger(options.maxIters) && options.maxIters > 0
        ? options.maxIters
        : SLOT_AUCTION_MAX_ITERS;

    return solveEpsilonAuction(costMatrix, is2D, m, n, out, epsilon, maxIters);
}

/**
 * Computes total assigned cost for a slot assignment vector.
 */
export function computeAssignmentCost(costMatrix, numAgents, numSlots, assignment) {
    const is2D = Array.isArray(costMatrix[0]) || ArrayBuffer.isView(costMatrix[0]);
    let sum = 0;
    for (let i = 0; i < numAgents; i++) {
        const j = assignment[i];
        if (j < 0 || j >= numSlots) continue;
        sum += is2D ? costMatrix[i][j] : costMatrix[i * numSlots + j];
    }
    return sum;
}

// ---------------------------------------------------------------------------
// 2. Shared 96 px Flat Typed-Array Spatial Occupancy Grid
// ---------------------------------------------------------------------------

const GRID_TABLE_SIZE = 1024;
const GRID_TABLE_MASK = GRID_TABLE_SIZE - 1;

function hashOverlayCell(cx, cy) {
    return ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0) & GRID_TABLE_MASK;
}

function rectsOverlapCoords(l1, t1, r1, b1, l2, t2, r2, b2, pad = 0) {
    return l1 < r2 + pad && r1 + pad > l2 && t1 < b2 + pad && b1 + pad > t2;
}

function rectIntersectionCoords(l1, t1, r1, b1, l2, t2, r2, b2) {
    const ox = Math.min(r1, r2) - Math.max(l1, l2);
    if (ox <= 0) return 0;
    const oy = Math.min(b1, b2) - Math.max(t1, t2);
    return oy > 0 ? ox * oy : 0;
}

/**
 * Shared 96 px overlay occupancy grid backed solely by pre-allocated flat typed
 * arrays. Supports O(1) frame resets and zero-allocation overlap / area queries
 * across all three priority layers (1: plaques, 2: attention plates, 3: thoughts).
 */
export class OverlayOccupancyGrid {
    constructor({
        cellSize = OVERLAY_GRID_CELL,
        maxRects = 512,
        maxNodes = 4096,
    } = {}) {
        this.cellSize = Math.max(16, Number(cellSize) || OVERLAY_GRID_CELL);
        this._invCell = 1 / this.cellSize;
        this._rectCap = Math.max(32, maxRects | 0);
        this._nodeCap = Math.max(128, maxNodes | 0);

        this._rectLeft = new Float64Array(this._rectCap);
        this._rectTop = new Float64Array(this._rectCap);
        this._rectRight = new Float64Array(this._rectCap);
        this._rectBottom = new Float64Array(this._rectCap);
        this._rectLayer = new Uint8Array(this._rectCap);
        this._rectTag = new Int32Array(this._rectCap);
        this._rectSeenGen = new Int32Array(this._rectCap);

        this._bucketGen = new Int32Array(GRID_TABLE_SIZE);
        this._bucketHead = new Int32Array(GRID_TABLE_SIZE);

        this._nodeRect = new Int32Array(this._nodeCap);
        this._nodeCellX = new Int32Array(this._nodeCap);
        this._nodeCellY = new Int32Array(this._nodeCap);
        this._nodeNext = new Int32Array(this._nodeCap);

        this._generation = 0;
        this._queryGen = 0;
        this._rectCount = 0;
        this._nodeCount = 0;
    }

    get count() {
        return this._rectCount;
    }

    beginFrame() {
        this._rectCount = 0;
        this._nodeCount = 0;
        let gen = this._generation + 1;
        if (gen >= 0x7fffffff) {
            this._bucketGen.fill(0);
            gen = 1;
        }
        this._generation = gen;
    }

    clear() {
        this.beginFrame();
    }

    _growRects() {
        const nextCap = this._rectCap * 2;
        const growF64 = (src) => {
            const dst = new Float64Array(nextCap);
            dst.set(src);
            return dst;
        };
        const growI32 = (src) => {
            const dst = new Int32Array(nextCap);
            dst.set(src);
            return dst;
        };
        const nextLayer = new Uint8Array(nextCap);
        nextLayer.set(this._rectLayer);

        this._rectLeft = growF64(this._rectLeft);
        this._rectTop = growF64(this._rectTop);
        this._rectRight = growF64(this._rectRight);
        this._rectBottom = growF64(this._rectBottom);
        this._rectLayer = nextLayer;
        this._rectTag = growI32(this._rectTag);
        this._rectSeenGen = growI32(this._rectSeenGen);
        this._rectCap = nextCap;
    }

    _growNodes() {
        const nextCap = this._nodeCap * 2;
        const growI32 = (src) => {
            const dst = new Int32Array(nextCap);
            dst.set(src);
            return dst;
        };
        this._nodeRect = growI32(this._nodeRect);
        this._nodeCellX = growI32(this._nodeCellX);
        this._nodeCellY = growI32(this._nodeCellY);
        this._nodeNext = growI32(this._nodeNext);
        this._nodeCap = nextCap;
    }

    reserve(left, top, right, bottom, layer = OVERLAY_LAYER_PLAQUE, tag = 0) {
        if (this._rectCount >= this._rectCap) this._growRects();
        const rectIdx = this._rectCount++;
        this._rectLeft[rectIdx] = left;
        this._rectTop[rectIdx] = top;
        this._rectRight[rectIdx] = right;
        this._rectBottom[rectIdx] = bottom;
        this._rectLayer[rectIdx] = layer;
        this._rectTag[rectIdx] = tag;

        const inv = this._invCell;
        const x0 = Math.floor(left * inv);
        const x1 = Math.floor(right * inv);
        const y0 = Math.floor(top * inv);
        const y1 = Math.floor(bottom * inv);
        const gen = this._generation;
        const bucketGen = this._bucketGen;
        const bucketHead = this._bucketHead;

        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                if (this._nodeCount >= this._nodeCap) this._growNodes();
                const nodeIdx = this._nodeCount++;
                const h = hashOverlayCell(cx, cy);
                this._nodeRect[nodeIdx] = rectIdx;
                this._nodeCellX[nodeIdx] = cx;
                this._nodeCellY[nodeIdx] = cy;
                if (bucketGen[h] !== gen) {
                    bucketGen[h] = gen;
                    bucketHead[h] = nodeIdx;
                    this._nodeNext[nodeIdx] = -1;
                } else {
                    this._nodeNext[nodeIdx] = bucketHead[h];
                    bucketHead[h] = nodeIdx;
                }
            }
        }
        return rectIdx;
    }

    reserveRect(rect, layer = OVERLAY_LAYER_PLAQUE, tag = 0) {
        if (!rect) return -1;
        const left = rect.left !== undefined ? rect.left : rect.x;
        const top = rect.top !== undefined ? rect.top : rect.y;
        const right = rect.right !== undefined ? rect.right : (left + rect.w);
        const bottom = rect.bottom !== undefined ? rect.bottom : (top + rect.h);
        return this.reserve(left, top, right, bottom, layer, tag);
    }

    overlaps(left, top, right, bottom, pad = 0) {
        if (this._rectCount === 0) return false;
        const inv = this._invCell;
        const x0 = Math.floor((left - pad) * inv);
        const x1 = Math.floor((right + pad) * inv);
        const y0 = Math.floor((top - pad) * inv);
        const y1 = Math.floor((bottom + pad) * inv);
        const gen = this._generation;
        const bucketGen = this._bucketGen;
        const bucketHead = this._bucketHead;
        const nodeRect = this._nodeRect;
        const nodeCellX = this._nodeCellX;
        const nodeCellY = this._nodeCellY;
        const nodeNext = this._nodeNext;
        const rL = this._rectLeft;
        const rT = this._rectTop;
        const rR = this._rectRight;
        const rB = this._rectBottom;

        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const h = hashOverlayCell(cx, cy);
                if (bucketGen[h] !== gen) continue;
                let node = bucketHead[h];
                while (node !== -1) {
                    if (nodeCellX[node] === cx && nodeCellY[node] === cy) {
                        const idx = nodeRect[node];
                        if (rectsOverlapCoords(left, top, right, bottom, rL[idx], rT[idx], rR[idx], rB[idx], pad)) {
                            return true;
                        }
                    }
                    node = nodeNext[node];
                }
            }
        }
        return false;
    }

    overlapsRect(rect, pad = 0) {
        if (!rect) return false;
        const left = rect.left !== undefined ? rect.left : rect.x;
        const top = rect.top !== undefined ? rect.top : rect.y;
        const right = rect.right !== undefined ? rect.right : (left + rect.w);
        const bottom = rect.bottom !== undefined ? rect.bottom : (top + rect.h);
        return this.overlaps(left, top, right, bottom, pad);
    }

    overlapArea(left, top, right, bottom, pad = 0) {
        if (this._rectCount === 0) return 0;
        let qGen = this._queryGen + 1;
        if (qGen >= 0x7fffffff) {
            this._rectSeenGen.fill(0);
            qGen = 1;
        }
        this._queryGen = qGen;

        const inv = this._invCell;
        const x0 = Math.floor((left - pad) * inv);
        const x1 = Math.floor((right + pad) * inv);
        const y0 = Math.floor((top - pad) * inv);
        const y1 = Math.floor((bottom + pad) * inv);
        const gen = this._generation;
        const bucketGen = this._bucketGen;
        const bucketHead = this._bucketHead;
        const nodeRect = this._nodeRect;
        const nodeCellX = this._nodeCellX;
        const nodeCellY = this._nodeCellY;
        const nodeNext = this._nodeNext;
        const rL = this._rectLeft;
        const rT = this._rectTop;
        const rR = this._rectRight;
        const rB = this._rectBottom;
        const seen = this._rectSeenGen;

        let area = 0;
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const h = hashOverlayCell(cx, cy);
                if (bucketGen[h] !== gen) continue;
                let node = bucketHead[h];
                while (node !== -1) {
                    if (nodeCellX[node] === cx && nodeCellY[node] === cy) {
                        const idx = nodeRect[node];
                        if (seen[idx] !== qGen) {
                            seen[idx] = qGen;
                            area += rectIntersectionCoords(
                                left - pad,
                                top - pad,
                                right + pad,
                                bottom + pad,
                                rL[idx],
                                rT[idx],
                                rR[idx],
                                rB[idx],
                            );
                        }
                    }
                    node = nodeNext[node];
                }
            }
        }
        return area;
    }

    getRect(index, out) {
        out.left = this._rectLeft[index];
        out.top = this._rectTop[index];
        out.right = this._rectRight[index];
        out.bottom = this._rectBottom[index];
        out.layer = this._rectLayer[index];
        out.tag = this._rectTag[index];
        return out;
    }
}

// ---------------------------------------------------------------------------
// 3. AttentionPlates Precomputed Width Table & Sweep-Line Union-Find Clustering
// ---------------------------------------------------------------------------

function precomputeWordCellWidths(word) {
    const base = word.length * THOUGHT_DISPLAY_ADVANCE + ATTENTION_WORD_PAD * 2;
    const notch = ATTENTION_AGE_NOTCH_GAP + ATTENTION_AGE_NOTCH_W;
    return new Int32Array([base, base + notch, base + notch, base + notch]);
}

// Precomputed width table per (statusWord, ageTier 0..3) — zero per-frame measureText!
export const ATTENTION_WORD_WIDTHS = Object.freeze({
    'NEEDS YOU': precomputeWordCellWidths('NEEDS YOU'),
    ERROR: precomputeWordCellWidths('ERROR'),
    LIMIT: precomputeWordCellWidths('LIMIT'),
    waiting_on_user: precomputeWordCellWidths('NEEDS YOU'),
    errored: precomputeWordCellWidths('ERROR'),
    rate_limited: precomputeWordCellWidths('LIMIT'),
});

/**
 * O(1) precomputed width of an AttentionPlate status word cell (no measureText).
 */
export function getAttentionWordWidth(word, ageTier = 0) {
    const tier = ageTier > 0 ? Math.min(3, ageTier | 0) : 0;
    const table = ATTENTION_WORD_WIDTHS[word];
    if (table) return table[tier];
    const str = String(word || '');
    const notch = tier > 0 ? (ATTENTION_AGE_NOTCH_GAP + ATTENTION_AGE_NOTCH_W) : 0;
    return str.length * THOUGHT_DISPLAY_ADVANCE + ATTENTION_WORD_PAD * 2 + notch;
}

/**
 * O(1) total pixel width of an AttentionPlate (zero measureText, zero allocations).
 */
export function computeAttentionPlateWidth(word, text, ageTier = 0) {
    const wordCell = getAttentionWordWidth(word, ageTier);
    const len = typeof text === 'number'
        ? Math.max(0, text | 0)
        : Math.min(ATTENTION_NAME_MAX_CHARS + 8, String(text || '').length);
    const textCell = len * THOUGHT_CHAR_ADVANCE + ATTENTION_TEXT_PAD * 2;
    return 1 + wordCell + textCell + 1;
}

// Pre-allocated union-find & sweep-line scratch pools.
const INITIAL_UF_CAP = 256;
const ufScratch = {
    cap: INITIAL_UF_CAP,
    parent: new Int32Array(INITIAL_UF_CAP),
    rank: new Uint8Array(INITIAL_UF_CAP),
    order: new Int32Array(INITIAL_UF_CAP),
    rootToCluster: new Int32Array(INITIAL_UF_CAP),
    outDefault: new Int32Array(INITIAL_UF_CAP),
};

function ensureUfCapacity(count) {
    if (count <= ufScratch.cap) return;
    let nextCap = ufScratch.cap;
    while (nextCap < count) nextCap *= 2;
    ufScratch.cap = nextCap;
    ufScratch.parent = new Int32Array(nextCap);
    ufScratch.rank = new Uint8Array(nextCap);
    ufScratch.order = new Int32Array(nextCap);
    ufScratch.rootToCluster = new Int32Array(nextCap);
    ufScratch.outDefault = new Int32Array(nextCap);
}

function ufFind(parent, x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cur = x;
    while (cur !== root) {
        const next = parent[cur];
        parent[cur] = root;
        cur = next;
    }
    return root;
}

function ufUnion(parent, rank, a, b) {
    const ra = ufFind(parent, a);
    const rb = ufFind(parent, b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
        parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
        parent[rb] = ra;
    } else {
        parent[rb] = ra;
        rank[ra]++;
    }
}

/**
 * Allocation-free sweep-line + union-find clustering of attention beacons by X
 * within `radius` (default `ATTENTION_GROUP_RADIUS = 96 px`).
 *
 * Same-kind beacons within Euclidean distance `radius` (or overlapping natural
 * rects, or both `queued === true`) are unioned into one deterministic cluster.
 * Writes contiguous cluster IDs `0..clusterCount-1` into `outClusterIds` and
 * returns `clusterCount`.
 */
export function clusterAttentionBeacons(
    beacons,
    count = beacons ? beacons.length : 0,
    outClusterIds = null,
    radius = ATTENTION_GROUP_RADIUS,
) {
    const n = Math.max(0, count | 0);
    if (n === 0) return 0;
    ensureUfCapacity(n);

    const parent = ufScratch.parent;
    const rank = ufScratch.rank;
    const order = ufScratch.order;
    const rootToCluster = ufScratch.rootToCluster;
    const out = outClusterIds || ufScratch.outDefault;

    for (let i = 0; i < n; i++) {
        parent[i] = i;
        rank[i] = 0;
        order[i] = i;
        rootToCluster[i] = -1;
    }

    // In-place insertion sort of `order` by beacon.x ascending (tie-break: y, index).
    for (let i = 1; i < n; i++) {
        const key = order[i];
        const kx = beacons[key].x;
        const ky = beacons[key].y;
        let j = i - 1;
        while (j >= 0) {
            const idx = order[j];
            const bx = beacons[idx].x;
            const by = beacons[idx].y;
            if (bx < kx || (bx === kx && (by < ky || (by === ky && idx < key)))) break;
            order[j + 1] = idx;
            j--;
        }
        order[j + 1] = key;
    }

    const rSq = radius * radius;

    // Sweep-line by X with early break when dx > radius.
    for (let a = 0; a < n; a++) {
        const i = order[a];
        const bi = beacons[i];
        const xi = bi.x;
        const yi = bi.y;
        const kindI = bi.kind;

        for (let b = a + 1; b < n; b++) {
            const j = order[b];
            const bj = beacons[j];
            const dx = bj.x - xi;
            if (dx > radius) break;
            if (kindI !== bj.kind) continue;
            const dy = bj.y - yi;
            if (dx * dx + dy * dy <= rSq) {
                ufUnion(parent, rank, i, j);
            } else if (
                bi.natural && bj.natural
                && rectsOverlapCoords(
                    bi.natural.left, bi.natural.top, bi.natural.right, bi.natural.bottom,
                    bj.natural.left, bj.natural.top, bj.natural.right, bj.natural.bottom,
                    2,
                )
            ) {
                ufUnion(parent, rank, i, j);
            }
        }
    }

    // Command-queue petitioners of the same kind always form one knot.
    for (let i = 0; i < n; i++) {
        const bi = beacons[i];
        if (!bi.queued) continue;
        for (let j = i + 1; j < n; j++) {
            const bj = beacons[j];
            if (bj.queued && bi.kind === bj.kind) {
                ufUnion(parent, rank, i, j);
                break;
            }
        }
    }

    // Assign deterministic contiguous cluster IDs in input order.
    let clusterCount = 0;
    for (let i = 0; i < n; i++) {
        const root = ufFind(parent, i);
        let cid = rootToCluster[root];
        if (cid === -1) {
            cid = clusterCount++;
            rootToCluster[root] = cid;
        }
        out[i] = cid;
    }
    return clusterCount;
}

// Candidate offsets for AttentionPlate placement (matching AttentionPlates.js).
const PLATE_CAND_DX = Object.freeze([0, 0, -1, 1, 0, -1, 1, 0, -2, 2, -1, 1, 0]);
const PLATE_CAND_DY = Object.freeze([
    0,
    -ATTENTION_STACK_STEP,
    0,
    0,
    -ATTENTION_STACK_STEP * 2,
    -ATTENTION_STACK_STEP,
    -ATTENTION_STACK_STEP,
    -ATTENTION_STACK_STEP * 3,
    0,
    0,
    -ATTENTION_STACK_STEP * 2,
    -ATTENTION_STACK_STEP * 2,
    -ATTENTION_STACK_STEP * 4,
]);

/**
 * Reserves Layer 2 AttentionPlates in the shared 96 px occupancy grid without
 * overlapping Layer 1 static plaques or earlier AttentionPlates.
 * Writes `[left, top, right, bottom]` per plate into optional `outRects` (Float64Array).
 * Returns number of collision-free plates placed.
 */
export function reserveAttentionPlates(grid, plates, viewport = null, outRects = null, pad = 2) {
    if (!grid || !plates || plates.length === 0) return 0;
    const edgeMargin = 8;
    const vLeft = viewport ? (viewport.left ?? edgeMargin) : -Infinity;
    const vTop = viewport ? (viewport.top ?? edgeMargin) : -Infinity;
    const vRight = viewport ? (viewport.right ?? ((viewport.width ?? Infinity) - edgeMargin)) : Infinity;
    const vBottom = viewport
        ? (viewport.bottom ?? ((viewport.height ?? Infinity) - edgeMargin - ATTENTION_NOTCH_ROWS))
        : Infinity;

    let placed = 0;
    for (let i = 0; i < plates.length; i++) {
        const plate = plates[i];
        if (!plate) continue;
        const width = Number.isFinite(plate.width)
            ? plate.width
            : computeAttentionPlateWidth(plate.word || 'NEEDS YOU', plate.text || '', plate.tier || 0);
        const height = Number.isFinite(plate.height) ? plate.height : ATTENTION_PLATE_HEIGHT;
        const anchorX = Number(plate.anchorX ?? plate.x) || 0;
        const tipY = Number(plate.tip ?? plate.y) || 0;
        const halfShift = Math.round(width * 0.5) + 4;

        let bestL = 0;
        let bestT = 0;
        let bestR = 0;
        let bestB = 0;
        let bestArea = Infinity;

        for (let c = 0; c < PLATE_CAND_DX.length; c++) {
            const cx = anchorX + PLATE_CAND_DX[c] * halfShift;
            const bottomBase = tipY + PLATE_CAND_DY[c] - ATTENTION_NOTCH_ROWS;
            let left = Math.round(cx - width * 0.5);
            let top = bottomBase - height;
            if (Number.isFinite(vLeft) && Number.isFinite(vRight) && vRight - vLeft >= width) {
                if (left < vLeft) left = vLeft;
                else if (left + width > vRight) left = vRight - width;
            }
            if (Number.isFinite(vTop) && Number.isFinite(vBottom) && vBottom - vTop >= height) {
                if (top < vTop) top = vTop;
                else if (top + height > vBottom) top = vBottom - height;
            }
            const right = left + width;
            const bottom = top + height;

            if (!grid.overlaps(left, top, right, bottom, pad)) {
                bestL = left;
                bestT = top;
                bestR = right;
                bestB = bottom;
                bestArea = 0;
                break;
            }
            const area = grid.overlapArea(left, top, right, bottom, pad);
            if (area < bestArea) {
                bestArea = area;
                bestL = left;
                bestT = top;
                bestR = right;
                bestB = bottom;
            }
        }

        grid.reserve(bestL, bestT, bestR, bestB, OVERLAY_LAYER_ATTENTION, i);
        if (outRects) {
            const off = i * 4;
            outRects[off] = bestL;
            outRects[off + 1] = bestT;
            outRects[off + 2] = bestR;
            outRects[off + 3] = bestB;
        }
        if (bestArea === 0) placed++;
    }
    return placed;
}

// ---------------------------------------------------------------------------
// 4. ThoughtColumn Shared-Grid Deterministic ε-Auction (<= 24 x <= 30)
// ---------------------------------------------------------------------------

const LABEL_TOTAL_CANDS = LABEL_MAX_SPEAKERS * LABEL_MAX_CANDIDATES;
const labelScratch = {
    candLeft: new Float64Array(LABEL_TOTAL_CANDS),
    candTop: new Float64Array(LABEL_TOTAL_CANDS),
    candRight: new Float64Array(LABEL_TOTAL_CANDS),
    candBottom: new Float64Array(LABEL_TOTAL_CANDS),
    candBaseCost: new Float64Array(LABEL_TOTAL_CANDS),
    candEligible: new Uint8Array(LABEL_TOTAL_CANDS),
    candCount: new Int32Array(LABEL_MAX_SPEAKERS),
    speakerOrder: new Int32Array(LABEL_MAX_SPEAKERS),
    assignedCand: new Int32Array(LABEL_MAX_SPEAKERS),
    assignedPrice: new Float64Array(LABEL_MAX_SPEAKERS),
    evictList: new Int32Array(LABEL_MAX_SPEAKERS),
    outDefault: new Int32Array(LABEL_MAX_SPEAKERS),
};

function candidateBoundsViolation(left, top, right, bottom, hasView, vLeft, vTop, vRight, vBottom, reservedRects) {
    let violation = 0;
    if (hasView) {
        const w = right - left;
        const h = bottom - top;
        const total = w > 0 && h > 0 ? w * h : 0;
        const inside = rectIntersectionCoords(left, top, right, bottom, vLeft, vTop, vRight, vBottom);
        if (inside < total) violation += total - inside;
    }
    if (reservedRects && reservedRects.length > 0) {
        for (let r = 0; r < reservedRects.length; r++) {
            const cr = reservedRects[r];
            if (!cr) continue;
            const cl = cr.left !== undefined ? cr.left : cr.x;
            const ct = cr.top !== undefined ? cr.top : cr.y;
            const crR = cr.right !== undefined ? cr.right : (cl + cr.w);
            const crB = cr.bottom !== undefined ? cr.bottom : (ct + cr.h);
            violation += rectIntersectionCoords(left, top, right, bottom, cl, ct, crR, crB);
        }
    }
    return violation;
}

/**
 * Solves Layer 3 ThoughtColumn placement over the shared 96 px `grid`
 * (after Layer 1 plaques and Layer 2 attention plates are reserved) via a
 * deterministic conflict-graph ε-auction (`ε = 1`, `<= 40` iterations,
 * sticky prior `-2` bonus, `boundsViolation * 1000`).
 *
 * Zero per-frame heap allocations! Every placed label is guaranteed to have
 * zero overlap with all static plaques, attention plates, and other placed
 * speaker labels.
 *
 * Each speaker entry supports either:
 *   - explicit `candidates`: array of up to 30 rects `{ left, top, right, bottom, cost? }`
 *     (or `{ x, y, w, h, cost? }`), OR
 *   - ThoughtColumn anchor geometry: `{ anchorX, baseY, width, height, side?, scale? }`,
 *     which generates all 30 `ThoughtColumn` candidate boxes inline.
 *
 * Signature supports:
 *   - `solveLabelAuction(grid, speakers, outAssignments, options)`
 *   - `solveLabelAuction(grid, speakers, options)`
 *
 * Writes chosen candidate index (`0..29`, or `-1` if filtered/unassignable) into
 * `outAssignments` and reserves all winning boxes in `grid` at `OVERLAY_LAYER_THOUGHT`.
 * Returns number of speakers placed.
 */
export function solveLabelAuction(grid, speakers, outAssignmentsOrOptions = null, maybeOptions = null) {
    let outAssignments = null;
    let options = null;
    if (
        outAssignmentsOrOptions
        && (ArrayBuffer.isView(outAssignmentsOrOptions) || Array.isArray(outAssignmentsOrOptions))
    ) {
        outAssignments = outAssignmentsOrOptions;
        options = maybeOptions;
    } else {
        options = outAssignmentsOrOptions || maybeOptions;
        outAssignments = options ? options.outAssignments || null : null;
    }

    const totalInput = speakers ? speakers.length : 0;
    const count = totalInput > LABEL_MAX_SPEAKERS ? LABEL_MAX_SPEAKERS : totalInput;
    const out = outAssignments || labelScratch.outDefault;
    for (let i = 0; i < totalInput; i++) out[i] = -1;
    if (count === 0) return 0;

    const pad = options && Number.isFinite(options.pad) ? options.pad : 2;
    const epsilon = options && Number.isFinite(options.epsilon) && options.epsilon > 0
        ? options.epsilon
        : LABEL_AUCTION_EPSILON;
    const maxIters = options && Number.isInteger(options.maxIters) && options.maxIters > 0
        ? Math.min(options.maxIters, LABEL_AUCTION_MAX_ITERS)
        : LABEL_AUCTION_MAX_ITERS;
    const reserveInGrid = !options || options.reserveInGrid !== false;
    const outRects = options ? options.outRects || null : null;
    const outStats = options ? options.outStats || null : null;
    const reservedRects = options ? options.reservedRects || null : null;

    const vp = options ? options.viewport || null : null;
    const hasView = Boolean(vp && (Number.isFinite(vp.width) || Number.isFinite(vp.right)));
    const margin = options && Number.isFinite(options.edgeMargin) ? options.edgeMargin : 0;
    const vLeft = hasView ? (Number.isFinite(vp.left) ? vp.left : margin) : -Infinity;
    const vTop = hasView ? (Number.isFinite(vp.top) ? vp.top : margin) : -Infinity;
    const vRight = hasView ? (Number.isFinite(vp.right) ? vp.right : (vp.width - margin)) : Infinity;
    const vBottom = hasView ? (Number.isFinite(vp.bottom) ? vp.bottom : (vp.height - margin)) : Infinity;

    const candLeft = labelScratch.candLeft;
    const candTop = labelScratch.candTop;
    const candRight = labelScratch.candRight;
    const candBottom = labelScratch.candBottom;
    const candBaseCost = labelScratch.candBaseCost;
    const candEligible = labelScratch.candEligible;
    const candCount = labelScratch.candCount;
    const speakerOrder = labelScratch.speakerOrder;
    const assignedCand = labelScratch.assignedCand;
    const assignedPrice = labelScratch.assignedPrice;
    const evictList = labelScratch.evictList;

    // 1. Deterministic speaker ordering (priority desc, then stable id / index asc).
    for (let i = 0; i < count; i++) {
        speakerOrder[i] = i;
        assignedCand[i] = -1;
        assignedPrice[i] = 0;
    }
    for (let i = 1; i < count; i++) {
        const key = speakerOrder[i];
        const sk = speakers[key];
        const pk = Number(sk?.priority) || 0;
        const idK = sk?.id !== undefined ? sk.id : key;
        let j = i - 1;
        while (j >= 0) {
            const idx = speakerOrder[j];
            const sj = speakers[idx];
            const pj = Number(sj?.priority) || 0;
            const idJ = sj?.id !== undefined ? sj.id : idx;
            if (pj > pk || (pj === pk && idJ <= idK)) break;
            speakerOrder[j + 1] = idx;
            j--;
        }
        speakerOrder[j + 1] = key;
    }

    // 2. Materialize candidate boxes & base costs into flat typed arrays.
    for (let i = 0; i < count; i++) {
        const sp = speakers[i];
        const base = i * LABEL_MAX_CANDIDATES;
        if (!sp) {
            candCount[i] = 0;
            continue;
        }
        const prior = Number.isInteger(sp.priorCandidate) ? sp.priorCandidate : -1;
        const explicit = sp.candidates;

        if (explicit && explicit.length > 0) {
            const cNum = explicit.length > LABEL_MAX_CANDIDATES ? LABEL_MAX_CANDIDATES : explicit.length;
            candCount[i] = cNum;
            for (let c = 0; c < cNum; c++) {
                const box = explicit[c];
                const idx = base + c;
                if (!box) {
                    candEligible[idx] = 0;
                    continue;
                }
                const l = box.left !== undefined ? box.left : box.x;
                const t = box.top !== undefined ? box.top : box.y;
                const r = box.right !== undefined ? box.right : (l + box.w);
                const b = box.bottom !== undefined ? box.bottom : (t + box.h);
                candLeft[idx] = l;
                candTop[idx] = t;
                candRight[idx] = r;
                candBottom[idx] = b;

                if (grid && grid.overlaps(l, t, r, b, pad)) {
                    candEligible[idx] = 0;
                    candBaseCost[idx] = Infinity;
                    continue;
                }
                candEligible[idx] = 1;
                let cost = Number.isFinite(box.cost) ? box.cost : (c * 2.0);
                if (c === prior) cost += LABEL_STICKY_BONUS;
                const viol = candidateBoundsViolation(l, t, r, b, hasView, vLeft, vTop, vRight, vBottom, reservedRects);
                if (viol > 0) cost += viol * LABEL_BOUNDS_PENALTY;
                candBaseCost[idx] = cost;
            }
        } else {
            // Generate all 30 ThoughtColumn candidate boxes directly (zero allocations).
            const anchorX = Number(sp.anchorX ?? sp.x) || 0;
            const baseY = Number(sp.baseY ?? sp.y) || 0;
            const width = Math.max(8, Number(sp.width) || 96);
            const height = Math.max(8, Number(sp.height) || 28);
            const scale = Number.isFinite(sp.scale) && sp.scale > 0 ? sp.scale : 1;
            const side = sp.side === -1 ? -1 : 1;
            const halfStep = Math.ceil(width * 0.5);
            const halfW = width * 0.5;
            candCount[i] = LABEL_MAX_CANDIDATES;

            for (let c = 0; c < LABEL_MAX_CANDIDATES; c++) {
                const idx = base + c;
                const slot = THOUGHT_CANDIDATE_SLOT[c];
                const lateral = THOUGHT_CANDIDATE_LATERAL[c] * side;
                const shiftX = lateral * halfStep;
                const slotShift = -slot * THOUGHT_STACK_STEP;

                const l = anchorX + (shiftX - halfW) * scale;
                const r = anchorX + (shiftX + halfW) * scale;
                const b = baseY + slotShift * scale;
                const t = b - height * scale;

                candLeft[idx] = l;
                candTop[idx] = t;
                candRight[idx] = r;
                candBottom[idx] = b;

                if (grid && grid.overlaps(l, t, r, b, pad)) {
                    candEligible[idx] = 0;
                    candBaseCost[idx] = Infinity;
                    continue;
                }
                candEligible[idx] = 1;
                let cost = slot * 4.0 + Math.abs(lateral) * 3.0 + c * 0.05;
                if (c === prior) cost += LABEL_STICKY_BONUS;
                const viol = candidateBoundsViolation(l, t, r, b, hasView, vLeft, vTop, vRight, vBottom, reservedRects);
                if (viol > 0) cost += viol * LABEL_BOUNDS_PENALTY;
                candBaseCost[idx] = cost;
            }
        }
    }

    // 3. Deterministic conflict-graph ε-auction (ε = 1, <= 40 iterations).
    // Invariant: at every point in the loop, the set of assigned speakers is
    // pairwise overlap-free and clear of every Layer 1/2 rect in `grid`.
    let iterations = 0;
    for (let iter = 0; iter < maxIters; iter++) {
        iterations = iter + 1;
        let anyAssigned = false;

        for (let oi = 0; oi < count; oi++) {
            const spIdx = speakerOrder[oi];
            if (assignedCand[spIdx] !== -1) continue;
            const cNum = candCount[spIdx];
            if (cNum === 0) continue;

            const base = spIdx * LABEL_MAX_CANDIDATES;
            let bestC = -1;
            let bestEff = Infinity;
            let bestBase = Infinity;
            let bestOverlapPrice = 0;
            let secondEff = Infinity;

            for (let c = 0; c < cNum; c++) {
                const idx = base + c;
                if (!candEligible[idx]) continue;
                const bCost = candBaseCost[idx];
                const l = candLeft[idx];
                const t = candTop[idx];
                const r = candRight[idx];
                const b = candBottom[idx];

                let overlapPrice = 0;
                for (let k = 0; k < count; k++) {
                    const kc = assignedCand[k];
                    if (kc === -1) continue;
                    const kIdx = k * LABEL_MAX_CANDIDATES + kc;
                    if (rectsOverlapCoords(
                        l, t, r, b,
                        candLeft[kIdx], candTop[kIdx], candRight[kIdx], candBottom[kIdx],
                        pad,
                    )) {
                        overlapPrice += assignedPrice[k];
                    }
                }

                const eff = bCost + overlapPrice;
                if (eff < bestEff) {
                    secondEff = bestEff;
                    bestEff = eff;
                    bestC = c;
                    bestBase = bCost;
                    bestOverlapPrice = overlapPrice;
                } else if (eff < secondEff) {
                    secondEff = eff;
                }
            }

            if (bestC === -1 || bestEff >= LABEL_UNASSIGNABLE_COST) continue;

            // Compute bid increment and evict any conflicting assigned speakers.
            const rawInc = Number.isFinite(secondEff)
                ? (secondEff - bestEff) + epsilon
                : LABEL_MAX_BID_STEP;
            const bidInc = rawInc > LABEL_MAX_BID_STEP ? LABEL_MAX_BID_STEP : (rawInc < epsilon ? epsilon : rawInc);
            const newPrice = bestOverlapPrice + bidInc;

            const winIdx = base + bestC;
            const wl = candLeft[winIdx];
            const wt = candTop[winIdx];
            const wr = candRight[winIdx];
            const wb = candBottom[winIdx];

            let evictCount = 0;
            for (let k = 0; k < count; k++) {
                const kc = assignedCand[k];
                if (kc === -1) continue;
                const kIdx = k * LABEL_MAX_CANDIDATES + kc;
                if (rectsOverlapCoords(
                    wl, wt, wr, wb,
                    candLeft[kIdx], candTop[kIdx], candRight[kIdx], candBottom[kIdx],
                    pad,
                )) {
                    evictList[evictCount++] = k;
                }
            }

            // Do not allow an out-of-bounds candidate to evict an in-bounds holder.
            if (evictCount > 0 && bestBase >= LABEL_BOUNDS_PENALTY) {
                let anyInBoundsHolder = false;
                for (let e = 0; e < evictCount; e++) {
                    const k = evictList[e];
                    if (candBaseCost[k * LABEL_MAX_CANDIDATES + assignedCand[k]] < LABEL_BOUNDS_PENALTY) {
                        anyInBoundsHolder = true;
                        break;
                    }
                }
                if (anyInBoundsHolder) continue;
            }

            for (let e = 0; e < evictCount; e++) {
                const k = evictList[e];
                assignedCand[k] = -1;
                assignedPrice[k] = 0;
            }

            assignedCand[spIdx] = bestC;
            assignedPrice[spIdx] = newPrice;
            anyAssigned = true;
        }

        if (!anyAssigned) break;
    }

    // 4. Final deterministic non-overlapping placement pass for any speaker
    // evicted on the final iteration that still has an open collision-free slot.
    for (let oi = 0; oi < count; oi++) {
        const spIdx = speakerOrder[oi];
        if (assignedCand[spIdx] !== -1) continue;
        const cNum = candCount[spIdx];
        const base = spIdx * LABEL_MAX_CANDIDATES;
        let bestC = -1;
        let bestCost = Infinity;

        for (let c = 0; c < cNum; c++) {
            const idx = base + c;
            if (!candEligible[idx]) continue;
            const cost = candBaseCost[idx];
            if (cost >= bestCost || cost >= LABEL_UNASSIGNABLE_COST) continue;
            const l = candLeft[idx];
            const t = candTop[idx];
            const r = candRight[idx];
            const b = candBottom[idx];

            let collides = false;
            for (let k = 0; k < count; k++) {
                const kc = assignedCand[k];
                if (kc === -1) continue;
                const kIdx = k * LABEL_MAX_CANDIDATES + kc;
                if (rectsOverlapCoords(
                    l, t, r, b,
                    candLeft[kIdx], candTop[kIdx], candRight[kIdx], candBottom[kIdx],
                    pad,
                )) {
                    collides = true;
                    break;
                }
            }
            if (!collides) {
                bestCost = cost;
                bestC = c;
            }
        }
        if (bestC !== -1) assignedCand[spIdx] = bestC;
    }

    // 5. Commit placements into outAssignments, optional outRects, and Layer 3 of `grid`.
    let placed = 0;
    for (let i = 0; i < count; i++) {
        const c = assignedCand[i];
        out[i] = c;
        if (c === -1) {
            if (outRects) {
                const off = i * 4;
                outRects[off] = NaN;
                outRects[off + 1] = NaN;
                outRects[off + 2] = NaN;
                outRects[off + 3] = NaN;
            }
            continue;
        }
        placed++;
        const idx = i * LABEL_MAX_CANDIDATES + c;
        const l = candLeft[idx];
        const t = candTop[idx];
        const r = candRight[idx];
        const b = candBottom[idx];
        if (reserveInGrid && grid) {
            grid.reserve(l, t, r, b, OVERLAY_LAYER_THOUGHT, i);
        }
        if (outRects) {
            const off = i * 4;
            outRects[off] = l;
            outRects[off + 1] = t;
            outRects[off + 2] = r;
            outRects[off + 3] = b;
        }
    }

    if (outStats) {
        outStats.iterations = iterations;
        outStats.placed = placed;
        outStats.filtered = count - placed;
    }
    return placed;
}
