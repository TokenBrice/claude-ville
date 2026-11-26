// W5-C — Allocation-Free 2D ORCA Crowd Solver & Context Steering (spec §3.2).
//
// Zero-allocation per-frame crowd avoidance combining:
//   1. 8-direction Context Steering (`computePreferredVelocity`) with a +0.03
//      starboard (right-hand) tie-break bias to resolve dead-on symmetry cleanly.
//   2. Isometric ellipse scaling (`ORCA_Y_SCALE = 0.64`) with Wave 6 E2
//      elevation-tier isolation (`surfaceTier`), asymmetric responsibility
//      (0.5 vs moving walkers, 1.0 vs planted villagers / active `strike`
//      swing arcs / static fixtures & wildlife), and fixed-buffer nearest-8
//      neighbor selection by TTC / scaled distance.
//   3. Exact 2D Simplex LP (`linearProgram1`, `linearProgram2`, `linearProgram3`,
//      van den Berg et al. 2011) over <= 16 half-planes + speed disc, with
//      infeasible minimax fallback.
//
// All per-solve working memory lives in pre-allocated module-level typed arrays.

export const ORCA_MAX_NEIGHBORS = 8;
export const ORCA_MAX_LINES = 16;
export const ORCA_TAU = 0.8;
export const ORCA_TAU_OBST = 0.45;
export const ORCA_Y_SCALE = 0.64;
export const ORCA_INV_Y_SCALE = 1 / ORCA_Y_SCALE;
export const ORCA_AGENT_RADIUS = 11.5;
export const ORCA_SWING_RADIUS = 10.0;

const ORCA_MAX_STATIC_DISCS = 6;
const ORCA_MAX_COAST_LINES = 2;
const ORCA_EPSILON = 1e-5;
const CONTEXT_LOOKAHEAD = 0.5;
const CONTEXT_STARBOARD_BIAS = 0.03;
const CONTEXT_COAST_MARGIN = 28.0;
const FIXTURE_BODY_HALF_PX = 16.0;
const DEFAULT_SWING_OFFSET_PX = 12.0;

// 8 compass unit directions (E, SE, S, SW, W, NW, N, NE) in screen/world space
// (+X east, +Y south).
const SQRT1_2 = Math.SQRT1_2;
export const DIR_X = new Float64Array([1, SQRT1_2, 0, -SQRT1_2, -1, -SQRT1_2, 0, SQRT1_2]);
export const DIR_Y = new Float64Array([0, SQRT1_2, 1, SQRT1_2, 0, -SQRT1_2, -1, -SQRT1_2]);

// Facing string -> unit world vector for default strike contact offsets.
const DIRECTION_VECTORS = Object.freeze({
    east: [1, 0],
    'south-east': [SQRT1_2, SQRT1_2],
    south: [0, 1],
    'south-west': [-SQRT1_2, SQRT1_2],
    west: [-1, 0],
    'north-west': [-SQRT1_2, -SQRT1_2],
    north: [0, -1],
    'north-east': [SQRT1_2, -SQRT1_2],
    e: [1, 0],
    se: [SQRT1_2, SQRT1_2],
    s: [0, 1],
    sw: [-SQRT1_2, SQRT1_2],
    w: [-1, 0],
    nw: [-SQRT1_2, -SQRT1_2],
    n: [0, -1],
    ne: [SQRT1_2, -SQRT1_2],
});

// Reusable module-level typed-array scratch (ZERO allocations per frame!).
const scratch = {
    // Context Steering 8-slot interest/danger map:
    interest: new Float64Array(8),
    danger: new Float64Array(8),
    prefVel: new Float64Array(2),
    // Nearest-8 neighbor selection arrays (scaled ellipse space):
    nbScore: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbDistSq: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbPosX: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbPosY: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbVelX: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbVelY: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbRad: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbResp: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbTau: new Float64Array(ORCA_MAX_NEIGHBORS),
    nbTieSign: new Float64Array(ORCA_MAX_NEIGHBORS),
    // Nearest-6 static obstacle / wildlife / swing-arc discs (scaled ellipse space):
    obsScore: new Float64Array(ORCA_MAX_STATIC_DISCS),
    obsDistSq: new Float64Array(ORCA_MAX_STATIC_DISCS),
    obsPosX: new Float64Array(ORCA_MAX_STATIC_DISCS),
    obsPosY: new Float64Array(ORCA_MAX_STATIC_DISCS),
    obsVelX: new Float64Array(ORCA_MAX_STATIC_DISCS),
    obsVelY: new Float64Array(ORCA_MAX_STATIC_DISCS),
    obsRad: new Float64Array(ORCA_MAX_STATIC_DISCS),
    obsTau: new Float64Array(ORCA_MAX_STATIC_DISCS),
    // ORCA half-planes (point px,py + unit direction dx,dy; feasible region is LEFT of dir):
    linePx: new Float64Array(ORCA_MAX_LINES),
    linePy: new Float64Array(ORCA_MAX_LINES),
    lineDx: new Float64Array(ORCA_MAX_LINES),
    lineDy: new Float64Array(ORCA_MAX_LINES),
    // Projected lines for infeasible linearProgram3 fallback:
    projPx: new Float64Array(ORCA_MAX_LINES),
    projPy: new Float64Array(ORCA_MAX_LINES),
    projDx: new Float64Array(ORCA_MAX_LINES),
    projDy: new Float64Array(ORCA_MAX_LINES),
    lpResult: new Float64Array(2),
    outVel: new Float64Array(2),
    swingPoint: new Float64Array(3), // [worldX, worldY, radius]
};

// Allocation-free spatial hash grid & velocity buffer for `stepCrowdOrca`.
const GRID_BUCKET_COUNT = 1024;
const GRID_BUCKET_MASK = GRID_BUCKET_COUNT - 1;
const GRID_CELL_SIZE = 96;
const INITIAL_STEP_CAP = 256;

const stepPool = {
    cap: INITIAL_STEP_CAP,
    generation: 0,
    bucketGen: new Int32Array(GRID_BUCKET_COUNT),
    bucketHead: new Int32Array(GRID_BUCKET_COUNT),
    agentNext: new Int32Array(INITIAL_STEP_CAP),
    agentCellX: new Int32Array(INITIAL_STEP_CAP),
    agentCellY: new Int32Array(INITIAL_STEP_CAP),
    velX: new Float64Array(INITIAL_STEP_CAP),
    velY: new Float64Array(INITIAL_STEP_CAP),
    nearby: new Array(INITIAL_STEP_CAP),
    nearbyCount: 0,
};

function ensureStepCapacity(count) {
    if (count <= stepPool.cap) return;
    let nextCap = stepPool.cap;
    while (nextCap < count) nextCap *= 2;
    stepPool.cap = nextCap;
    stepPool.agentNext = new Int32Array(nextCap);
    stepPool.agentCellX = new Int32Array(nextCap);
    stepPool.agentCellY = new Int32Array(nextCap);
    stepPool.velX = new Float64Array(nextCap);
    stepPool.velY = new Float64Array(nextCap);
    stepPool.nearby = new Array(nextCap);
}

function hashCell(cx, cy) {
    return ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0) & GRID_BUCKET_MASK;
}

/**
 * True when an agent is stationary/planted and must not yield or drift.
 * Accepts explicit `planted`, `AgentSprite.moving === false`, or `_stopLookActiveMs > 0`.
 */
export function isAgentPlanted(agent) {
    if (!agent) return false;
    if (agent.planted !== undefined) return Boolean(agent.planted);
    if (agent.moving === false) return true;
    if (agent._stopLookActiveMs > 0) return true;
    return false;
}

/**
 * True when an agent is executing an active `strike` weapon swing frame.
 */
export function isStrikeSwingActive(agent) {
    if (!agent) return false;
    if (agent.swingActive === true) return true;
    if (agent.swingActive === false) return false;
    if (agent.activePose === 'strike' && Number.isFinite(agent.poseFrame) && Number.isFinite(agent.contactFrame)) {
        return Math.abs(agent.poseFrame - agent.contactFrame) <= 1;
    }
    return false;
}

function resolveStrikeDisc(agent, out) {
    const r = Number.isFinite(agent.swingRadius) && agent.swingRadius > 0
        ? agent.swingRadius
        : ORCA_SWING_RADIUS;
    if (Number.isFinite(agent.swingX) && Number.isFinite(agent.swingY)) {
        out[0] = agent.swingX;
        out[1] = agent.swingY;
        out[2] = r;
        return;
    }
    const contact = agent.swingContact;
    if (contact && Number.isFinite(contact.x) && Number.isFinite(contact.y)) {
        out[0] = contact.x;
        out[1] = contact.y;
        out[2] = r;
        return;
    }
    if (Number.isFinite(agent.swingOffsetX) || Number.isFinite(agent.swingOffsetY)) {
        out[0] = agent.x + (Number.isFinite(agent.swingOffsetX) ? agent.swingOffsetX : 0);
        out[1] = agent.y + (Number.isFinite(agent.swingOffsetY) ? agent.swingOffsetY : 0);
        out[2] = r;
        return;
    }
    if (Number.isFinite(agent.facingX) && Number.isFinite(agent.facingY)) {
        const flen = Math.hypot(agent.facingX, agent.facingY);
        if (flen > 1e-6) {
            out[0] = agent.x + (agent.facingX / flen) * DEFAULT_SWING_OFFSET_PX;
            out[1] = agent.y + (agent.facingY / flen) * DEFAULT_SWING_OFFSET_PX;
            out[2] = r;
            return;
        }
    }
    if (typeof agent.direction === 'string') {
        const vec = DIRECTION_VECTORS[agent.direction];
        if (vec) {
            out[0] = agent.x + vec[0] * DEFAULT_SWING_OFFSET_PX;
            out[1] = agent.y + vec[1] * DEFAULT_SWING_OFFSET_PX;
            out[2] = r;
            return;
        }
    } else if (Number.isInteger(agent.direction) && agent.direction >= 0 && agent.direction < 8) {
        out[0] = agent.x + DIR_X[agent.direction] * DEFAULT_SWING_OFFSET_PX;
        out[1] = agent.y + DIR_Y[agent.direction] * DEFAULT_SWING_OFFSET_PX;
        out[2] = r;
        return;
    }
    // No explicit offset or facing: expand around body center by swing radius.
    out[0] = agent.x;
    out[1] = agent.y;
    out[2] = (Number.isFinite(agent.radius) ? agent.radius : ORCA_AGENT_RADIUS) + r;
}

function resolveObstacleRadius(obs) {
    if (Number.isFinite(obs.radius) && obs.radius > 0) return obs.radius;
    if (Number.isFinite(obs.r) && obs.r > 0) return obs.r;
    if (Number.isFinite(obs.xPx) && obs.xPx > 0) {
        // FIXTURE_FEET entries carry `xPx = half + FIXTURE_BODY.halfPx (16)`.
        return Math.max(4, obs.xPx - FIXTURE_BODY_HALF_PX);
    }
    return ORCA_SWING_RADIUS;
}

function stableTieSign(a, b) {
    const idA = a.id ?? a.agent?.id;
    const idB = b.id ?? b.agent?.id;
    if (idA !== undefined && idB !== undefined && idA !== idB) {
        return idA < idB ? -1 : 1;
    }
    if (a.x !== b.x) return a.x < b.x ? -1 : 1;
    if (a.y !== b.y) return a.y < b.y ? -1 : 1;
    return -1;
}

function accumulateDiscDanger(danger, ax, ay, aRadius, gaitSpeed, ox, oy, ovx, ovy, oRadius, weight) {
    const clearance = aRadius + oRadius;
    const step = gaitSpeed * CONTEXT_LOOKAHEAD;
    const predOx = ox + ovx * CONTEXT_LOOKAHEAD;
    const predOy = oy + ovy * CONTEXT_LOOKAHEAD;
    const baseDx = predOx - ax;
    const baseDy = predOy - ay;
    const maxReach = clearance + step;
    const scaledBaseDy = baseDy * ORCA_Y_SCALE;
    if (baseDx * baseDx + scaledBaseDy * scaledBaseDy >= maxReach * maxReach) return;

    const clearSq = clearance * clearance;
    const invClear = weight / clearance;

    for (let d = 0; d < 8; d++) {
        const dx = baseDx - DIR_X[d] * step;
        const dy = (baseDy - DIR_Y[d] * step) * ORCA_Y_SCALE;
        const distSq = dx * dx + dy * dy;
        if (distSq < clearSq) {
            const pen = (clearance - Math.sqrt(distSq)) * invClear;
            if (pen > danger[d]) danger[d] = pen;
        }
    }
}

/**
 * Step 1 — 8-direction Context Steering preferred velocity (allocation-free).
 *
 * Populates `interest[8]` (cosine alignment + 0.03 starboard tie-break bias)
 * and `danger[8]` (predicted neighbor overlap at t+0.5s, active strike
 * swing discs, static obstacle discs, and optional coast wall gradient).
 * Writes world `(vx, vy)` at `gaitSpeed` into `outVel` and returns `outVel`.
 */
export function computePreferredVelocity(
    agent,
    desiredVx,
    desiredVy,
    gaitSpeed,
    neighbors = null,
    obstacles = null,
    outVel = scratch.prefVel,
    options = null,
) {
    if (!agent || isAgentPlanted(agent) || !(gaitSpeed > 0)) {
        outVel[0] = 0;
        outVel[1] = 0;
        return outVel;
    }

    let dvx = Number(desiredVx) || 0;
    let dvy = Number(desiredVy) || 0;
    if (options) {
        if (options.laneBiasX !== undefined) dvx += options.laneBiasX;
        if (options.laneBiasY !== undefined) dvy += options.laneBiasY;
        if (options.squadBiasX !== undefined) dvx += options.squadBiasX;
        if (options.squadBiasY !== undefined) dvy += options.squadBiasY;
    }

    const desLenSq = dvx * dvx + dvy * dvy;
    if (!(desLenSq > 1e-12)) {
        outVel[0] = 0;
        outVel[1] = 0;
        return outVel;
    }

    const invDesLen = 1 / Math.sqrt(desLenSq);
    const ux = dvx * invDesLen;
    const uy = dvy * invDesLen;
    // Starboard (right-hand side of walker in +X east, +Y south world space).
    const rx = -uy;
    const ry = ux;

    const interest = scratch.interest;
    const danger = scratch.danger;
    for (let d = 0; d < 8; d++) {
        const align = DIR_X[d] * ux + DIR_Y[d] * uy;
        if (align > 1e-6) {
            const starboard = DIR_X[d] * rx + DIR_Y[d] * ry;
            interest[d] = align + (starboard > 0 ? CONTEXT_STARBOARD_BIAS : 0);
        } else {
            interest[d] = 0;
        }
        danger[d] = 0;
    }

    const ax = agent.x;
    const ay = agent.y;
    const aTier = agent.surfaceTier ?? 0;
    const aRadius = agent.radius > 0 ? agent.radius : ORCA_AGENT_RADIUS;
    const neighborLimit = options && options.neighborCount !== undefined
        ? options.neighborCount
        : (neighbors ? neighbors.length : 0);

    if (neighbors && neighborLimit > 0) {
        for (let i = 0; i < neighborLimit; i++) {
            const b = neighbors[i];
            if (!b || b === agent) continue;
            if ((b.surfaceTier ?? 0) !== aTier) continue;
            const bRadius = b.radius > 0 ? b.radius : ORCA_AGENT_RADIUS;
            const bPlanted = isAgentPlanted(b);
            const bvx = bPlanted ? 0 : (b.vx || 0);
            const bvy = bPlanted ? 0 : (b.vy || 0);
            accumulateDiscDanger(danger, ax, ay, aRadius, gaitSpeed, b.x, b.y, bvx, bvy, bRadius, bPlanted ? 1.0 : 0.65);

            if (isStrikeSwingActive(b)) {
                resolveStrikeDisc(b, scratch.swingPoint);
                accumulateDiscDanger(
                    danger,
                    ax,
                    ay,
                    aRadius,
                    gaitSpeed,
                    scratch.swingPoint[0],
                    scratch.swingPoint[1],
                    0,
                    0,
                    scratch.swingPoint[2],
                    1.0,
                );
            }
        }
    }

    if (obstacles && obstacles.length > 0) {
        for (let i = 0; i < obstacles.length; i++) {
            const obs = obstacles[i];
            if (!obs || obs.kind === 'boundary') continue;
            if (!obs.allTiers && (obs.surfaceTier ?? 0) !== aTier) continue;
            const oRadius = resolveObstacleRadius(obs);
            const ovx = obs.vx || 0;
            const ovy = obs.vy || 0;
            accumulateDiscDanger(danger, ax, ay, aRadius, gaitSpeed, obs.x, obs.y, ovx, ovy, oRadius, 1.0);
        }
    }

    // Optional coast signed-distance wall gradient (normal points inland/safe).
    if (options && options.coastDist !== undefined && options.coastDist < CONTEXT_COAST_MARGIN) {
        const cnx = options.coastNormalX || 0;
        const cny = options.coastNormalY || 0;
        const cnLenSq = cnx * cnx + cny * cny;
        if (cnLenSq > 1e-12) {
            const invCn = 1 / Math.sqrt(cnLenSq);
            const inx = cnx * invCn;
            const iny = cny * invCn;
            const proximity = Math.max(0, Math.min(1, (CONTEXT_COAST_MARGIN - options.coastDist) / CONTEXT_COAST_MARGIN));
            for (let d = 0; d < 8; d++) {
                const intoCoast = -(DIR_X[d] * inx + DIR_Y[d] * iny);
                if (intoCoast > 0) {
                    const pen = intoCoast * proximity;
                    if (pen > danger[d]) danger[d] = pen;
                }
            }
        }
    }

    let vx = 0;
    let vy = 0;
    for (let d = 0; d < 8; d++) {
        const w = interest[d] - danger[d];
        if (w > 0) {
            vx += DIR_X[d] * w;
            vy += DIR_Y[d] * w;
        }
    }

    const lenSq = vx * vx + vy * vy;
    if (lenSq > 1e-12) {
        const scale = gaitSpeed / Math.sqrt(lenSq);
        outVel[0] = vx * scale;
        outVel[1] = vy * scale;
    } else {
        // Surrounded in high danger: preserve desired heading with starboard
        // bias so ORCA LP solves the tightest legal slip without freezing.
        const fx = ux + rx * CONTEXT_STARBOARD_BIAS;
        const fy = uy + ry * CONTEXT_STARBOARD_BIAS;
        const scale = gaitSpeed / Math.sqrt(fx * fx + fy * fy);
        outVel[0] = fx * scale;
        outVel[1] = fy * scale;
    }
    return outVel;
}

/**
 * Step 3a — 1D Linear Program along ORCA line `lineNo` clipped to speed disc
 * `||v|| <= radius` and previous half-planes `0..lineNo-1` (van den Berg et al. 2011).
 * Feasible half-plane is LEFT of direction: `det(dir, v - point) >= 0`.
 */
export function linearProgram1(
    linePx,
    linePy,
    lineDx,
    lineDy,
    lineNo,
    radius,
    optVx,
    optVy,
    directionOpt,
    result,
) {
    const px = linePx[lineNo];
    const py = linePy[lineNo];
    const dx = lineDx[lineNo];
    const dy = lineDy[lineNo];

    const dotProduct = px * dx + py * dy;
    const discriminant = dotProduct * dotProduct + radius * radius - (px * px + py * py);
    if (discriminant < 0) return false;

    const sqrtDisc = Math.sqrt(discriminant);
    let tLeft = -dotProduct - sqrtDisc;
    let tRight = -dotProduct + sqrtDisc;

    for (let i = 0; i < lineNo; i++) {
        const idx = lineDx[i];
        const idy = lineDy[i];
        const denominator = dx * idy - dy * idx;
        const rx = px - linePx[i];
        const ry = py - linePy[i];
        const numerator = idx * ry - idy * rx;

        if (Math.abs(denominator) <= ORCA_EPSILON) {
            if (numerator < 0) return false;
            continue;
        }

        const t = numerator / denominator;
        if (denominator >= 0) {
            if (t < tRight) tRight = t;
        } else {
            if (t > tLeft) tLeft = t;
        }

        if (tLeft > tRight) return false;
    }

    let t;
    if (directionOpt) {
        t = (optVx * dx + optVy * dy) > 0 ? tRight : tLeft;
    } else {
        t = dx * (optVx - px) + dy * (optVy - py);
        if (t < tLeft) t = tLeft;
        else if (t > tRight) t = tRight;
    }

    result[0] = px + t * dx;
    result[1] = py + t * dy;
    return true;
}

/**
 * Step 3b — Incremental 2D Linear Program over `lineCount` half-planes and speed
 * disc `||v|| <= radius`. Returns `lineCount` when feasible, or the index of
 * the first violated line when infeasible.
 */
export function linearProgram2(
    linePx,
    linePy,
    lineDx,
    lineDy,
    lineCount,
    radius,
    optVx,
    optVy,
    directionOpt,
    result,
) {
    if (directionOpt) {
        result[0] = optVx * radius;
        result[1] = optVy * radius;
    } else {
        const optSq = optVx * optVx + optVy * optVy;
        if (optSq > radius * radius) {
            const scale = radius / Math.sqrt(optSq);
            result[0] = optVx * scale;
            result[1] = optVy * scale;
        } else {
            result[0] = optVx;
            result[1] = optVy;
        }
    }

    for (let i = 0; i < lineCount; i++) {
        const dx = lineDx[i];
        const dy = lineDy[i];
        const rx = result[0] - linePx[i];
        const ry = result[1] - linePy[i];
        // Feasible iff det(d_i, result - p_i) >= 0.
        if (dx * ry - dy * rx < 0) {
            const tempX = result[0];
            const tempY = result[1];
            if (!linearProgram1(linePx, linePy, lineDx, lineDy, i, radius, optVx, optVy, directionOpt, result)) {
                result[0] = tempX;
                result[1] = tempY;
                return i;
            }
        }
    }
    return lineCount;
}

/**
 * Step 3c — Infeasible LP fallback minimizing maximum half-plane penetration
 * while preserving static obstacle half-planes `0..numObstLines-1`.
 */
export function linearProgram3(
    linePx,
    linePy,
    lineDx,
    lineDy,
    lineCount,
    numObstLines,
    beginLine,
    radius,
    result,
) {
    const projPx = scratch.projPx;
    const projPy = scratch.projPy;
    const projDx = scratch.projDx;
    const projDy = scratch.projDy;
    let distance = 0;

    for (let i = beginLine; i < lineCount; i++) {
        const idx = lineDx[i];
        const idy = lineDy[i];
        const ipx = linePx[i];
        const ipy = linePy[i];
        // Penetration = det(d_i, p_i - result) = -det(d_i, result - p_i).
        const violation = idx * (ipy - result[1]) - idy * (ipx - result[0]);
        if (violation > distance) {
            let projCount = 0;
            for (let k = 0; k < numObstLines; k++) {
                projPx[projCount] = linePx[k];
                projPy[projCount] = linePy[k];
                projDx[projCount] = lineDx[k];
                projDy[projCount] = lineDy[k];
                projCount++;
            }

            for (let j = numObstLines; j < i; j++) {
                const jdx = lineDx[j];
                const jdy = lineDy[j];
                const jpx = linePx[j];
                const jpy = linePy[j];
                const determinant = idx * jdy - idy * jdx;

                let ppx;
                let ppy;
                if (Math.abs(determinant) <= ORCA_EPSILON) {
                    if (idx * jdx + idy * jdy > 0) continue;
                    ppx = 0.5 * (ipx + jpx);
                    ppy = 0.5 * (ipy + jpy);
                } else {
                    const t = (jdx * (ipy - jpy) - jdy * (ipx - jpx)) / determinant;
                    ppx = ipx + t * idx;
                    ppy = ipy + t * idy;
                }

                const ddx = jdx - idx;
                const ddy = jdy - idy;
                const dLen = Math.sqrt(ddx * ddx + ddy * ddy);
                if (dLen <= ORCA_EPSILON) continue;

                projPx[projCount] = ppx;
                projPy[projCount] = ppy;
                projDx[projCount] = ddx / dLen;
                projDy[projCount] = ddy / dLen;
                projCount++;
            }

            const tempX = result[0];
            const tempY = result[1];
            // Optimize along inward normal of line i: (-idy, idx).
            if (linearProgram2(projPx, projPy, projDx, projDy, projCount, radius, -idy, idx, true, result) < projCount) {
                result[0] = tempX;
                result[1] = tempY;
            }
            distance = idx * (ipy - result[1]) - idy * (ipx - result[0]);
        }
    }
}

function computeUrgencyScore(relX, relY, distSq, rvx, rvy, combinedRadius, tau) {
    const combinedSq = combinedRadius * combinedRadius;
    if (distSq <= combinedSq) {
        return distSq * 1e-6;
    }
    const a = rvx * rvx + rvy * rvy;
    const b = relX * rvx + relY * rvy;
    if (b > 0 && a > 1e-9) {
        const c = distSq - combinedSq;
        const disc = b * b - a * c;
        if (disc >= 0) {
            const ttc = (b - Math.sqrt(disc)) / a;
            if (ttc >= 0 && ttc <= tau * 2.5) return ttc;
        }
    }
    // Strictly monotonic with scaled distance without paying a sqrt per candidate.
    return 10.0 + distSq;
}

function insertStaticDisc(count, score, distSq, relX, relY, ovx, ovy, combinedRadius, tau) {
    let pos = count;
    if (pos === ORCA_MAX_STATIC_DISCS) {
        if (score >= scratch.obsScore[ORCA_MAX_STATIC_DISCS - 1]) return count;
        pos = ORCA_MAX_STATIC_DISCS - 1;
    } else {
        count++;
    }
    while (pos > 0 && score < scratch.obsScore[pos - 1]) {
        scratch.obsScore[pos] = scratch.obsScore[pos - 1];
        scratch.obsDistSq[pos] = scratch.obsDistSq[pos - 1];
        scratch.obsPosX[pos] = scratch.obsPosX[pos - 1];
        scratch.obsPosY[pos] = scratch.obsPosY[pos - 1];
        scratch.obsVelX[pos] = scratch.obsVelX[pos - 1];
        scratch.obsVelY[pos] = scratch.obsVelY[pos - 1];
        scratch.obsRad[pos] = scratch.obsRad[pos - 1];
        scratch.obsTau[pos] = scratch.obsTau[pos - 1];
        pos--;
    }
    scratch.obsScore[pos] = score;
    scratch.obsDistSq[pos] = distSq;
    scratch.obsPosX[pos] = relX;
    scratch.obsPosY[pos] = relY;
    scratch.obsVelX[pos] = ovx;
    scratch.obsVelY[pos] = ovy;
    scratch.obsRad[pos] = combinedRadius;
    scratch.obsTau[pos] = tau;
    return count;
}

function insertNeighbor(count, score, distSq, relX, relY, bvx, bvy, combinedRadius, resp, tau, tieSign) {
    let pos = count;
    if (pos === ORCA_MAX_NEIGHBORS) {
        if (score >= scratch.nbScore[ORCA_MAX_NEIGHBORS - 1]) return count;
        pos = ORCA_MAX_NEIGHBORS - 1;
    } else {
        count++;
    }
    while (pos > 0 && score < scratch.nbScore[pos - 1]) {
        scratch.nbScore[pos] = scratch.nbScore[pos - 1];
        scratch.nbDistSq[pos] = scratch.nbDistSq[pos - 1];
        scratch.nbPosX[pos] = scratch.nbPosX[pos - 1];
        scratch.nbPosY[pos] = scratch.nbPosY[pos - 1];
        scratch.nbVelX[pos] = scratch.nbVelX[pos - 1];
        scratch.nbVelY[pos] = scratch.nbVelY[pos - 1];
        scratch.nbRad[pos] = scratch.nbRad[pos - 1];
        scratch.nbResp[pos] = scratch.nbResp[pos - 1];
        scratch.nbTau[pos] = scratch.nbTau[pos - 1];
        scratch.nbTieSign[pos] = scratch.nbTieSign[pos - 1];
        pos--;
    }
    scratch.nbScore[pos] = score;
    scratch.nbDistSq[pos] = distSq;
    scratch.nbPosX[pos] = relX;
    scratch.nbPosY[pos] = relY;
    scratch.nbVelX[pos] = bvx;
    scratch.nbVelY[pos] = bvy;
    scratch.nbRad[pos] = combinedRadius;
    scratch.nbResp[pos] = resp;
    scratch.nbTau[pos] = tau;
    scratch.nbTieSign[pos] = tieSign;
    return count;
}

function appendOrcaHalfPlane(
    lineCount,
    vAx,
    vAy,
    relX,
    relY,
    distSq,
    vBx,
    vBy,
    combinedRadius,
    resp,
    tau,
    invTimeStep,
    tieSign,
) {
    if (lineCount >= ORCA_MAX_LINES) return lineCount;

    const rvx = vAx - vBx;
    const rvy = vAy - vBy;
    const combinedRadiusSq = combinedRadius * combinedRadius;

    let dirX;
    let dirY;
    let ux;
    let uy;

    if (distSq > combinedRadiusSq) {
        const invTau = 1 / tau;
        const wx = rvx - invTau * relX;
        const wy = rvy - invTau * relY;
        const wLengthSq = wx * wx + wy * wy;
        const dotProduct1 = wx * relX + wy * relY;

        if (dotProduct1 < 0 && dotProduct1 * dotProduct1 > combinedRadiusSq * wLengthSq) {
            // Project onto cut-off circle.
            const wLength = Math.sqrt(wLengthSq);
            let unitWx;
            let unitWy;
            if (wLength > 1e-9) {
                unitWx = wx / wLength;
                unitWy = wy / wLength;
            } else {
                const dist = Math.sqrt(distSq);
                unitWx = -relX / dist;
                unitWy = -relY / dist;
            }
            dirX = unitWy;
            dirY = -unitWx;
            const scale = combinedRadius * invTau - wLength;
            ux = scale * unitWx;
            uy = scale * unitWy;
        } else {
            // Project onto cone legs. Inclusive `>= 0` breaks exact dead-on
            // symmetry to the starboard (right-hand) side in +X east / +Y south.
            const leg = Math.sqrt(distSq - combinedRadiusSq);
            const detVal = relX * wy - relY * wx;
            if (detVal >= 0) {
                dirX = (relX * leg - relY * combinedRadius) / distSq;
                dirY = (relX * combinedRadius + relY * leg) / distSq;
            } else {
                dirX = -(relX * leg + relY * combinedRadius) / distSq;
                dirY = -(-relX * combinedRadius + relY * leg) / distSq;
            }
            const dotProduct2 = rvx * dirX + rvy * dirY;
            ux = dotProduct2 * dirX - rvx;
            uy = dotProduct2 * dirY - rvy;
        }
    } else {
        // Already overlapping: separate within one timeStep.
        const wx = rvx - invTimeStep * relX;
        const wy = rvy - invTimeStep * relY;
        const wLength = Math.sqrt(wx * wx + wy * wy);
        let unitWx;
        let unitWy;
        if (wLength > 1e-9) {
            unitWx = wx / wLength;
            unitWy = wy / wLength;
        } else if (distSq > 1e-12) {
            const dist = Math.sqrt(distSq);
            unitWx = -relX / dist;
            unitWy = -relY / dist;
        } else {
            // Exact stacked bodies with zero relative velocity: deterministic separation.
            unitWx = tieSign;
            unitWy = 0;
        }
        dirX = unitWy;
        dirY = -unitWx;
        const scale = combinedRadius * invTimeStep - wLength;
        ux = scale * unitWx;
        uy = scale * unitWy;
    }

    scratch.linePx[lineCount] = vAx + resp * ux;
    scratch.linePy[lineCount] = vAy + resp * uy;
    scratch.lineDx[lineCount] = dirX;
    scratch.lineDy[lineCount] = dirY;
    return lineCount + 1;
}

/**
 * Steps 2 & 3 — Allocation-free 2D ORCA velocity solver.
 *
 * Transforms relative positions & velocities by `(dx, dy * ORCA_Y_SCALE)`,
 * enforces Wave 6 E2 `surfaceTier` isolation and asymmetric responsibility
 * (`0.5` vs moving walkers, `1.0` vs planted bodies / active strike swing
 * arcs / static fixtures & wildlife), builds up to `ORCA_MAX_LINES = 16`
 * half-planes, solves the 2D Simplex LP, and scales `outVel[1] *= ORCA_INV_Y_SCALE`.
 *
 * Writes `[vx, vy]` in world px/s into `outVel` and returns `lineCount`.
 */
export function solveOrcaVelocity(
    agent,
    preferredVx,
    preferredVy,
    neighbors = null,
    obstacles = null,
    outVel = scratch.outVel,
    options = null,
) {
    if (!agent || isAgentPlanted(agent)) {
        outVel[0] = 0;
        outVel[1] = 0;
        return 0;
    }

    const prefVx = Number(preferredVx) || 0;
    const prefVy = Number(preferredVy) || 0;
    const maxSpeed = options && Number.isFinite(options.maxSpeed)
        ? options.maxSpeed
        : Number.isFinite(agent.maxSpeed)
            ? agent.maxSpeed
            : Number.isFinite(agent.gaitSpeed)
                ? agent.gaitSpeed
                : Number.isFinite(agent._gaitSpeed) && agent._gaitSpeed > 0
                    ? agent._gaitSpeed
                    : Math.hypot(prefVx, prefVy);

    if (!(maxSpeed > 0)) {
        outVel[0] = 0;
        outVel[1] = 0;
        return 0;
    }

    const ax = agent.x;
    const ay = agent.y;
    const aTier = agent.surfaceTier ?? 0;
    const aRadius = Number.isFinite(agent.radius) && agent.radius > 0 ? agent.radius : ORCA_AGENT_RADIUS;
    const dt = Math.max(1 / 60, (options && Number.isFinite(options.dt) ? options.dt : Number(agent.dt) || 0.05));
    const invTimeStep = 1 / dt;

    // Scaled isometric ellipse space: (x, y * ORCA_Y_SCALE).
    const vAx = Number(agent.vx) || 0;
    const vAy = (Number(agent.vy) || 0) * ORCA_Y_SCALE;
    const prefSx = prefVx;
    const prefSy = prefVy * ORCA_Y_SCALE;
    const refVx = (vAx * vAx + vAy * vAy) > 1e-6 ? vAx : prefSx;
    const refVy = (vAx * vAx + vAy * vAy) > 1e-6 ? vAy : prefSy;

    let obsCount = 0;
    let nbCount = 0;
    let coastCount = 0;
    let lineCount = 0;

    // 1. Optional coast boundary planes (at most 2, strict obstacle priority).
    if (options && Number.isFinite(options.coastDist) && options.coastDist < CONTEXT_COAST_MARGIN) {
        const cnx = Number(options.coastNormalX) || 0;
        const cny = (Number(options.coastNormalY) || 0) * ORCA_INV_Y_SCALE;
        const cnLen = Math.hypot(cnx, cny);
        if (cnLen > 1e-6 && coastCount < ORCA_MAX_COAST_LINES) {
            const inx = cnx / cnLen;
            const iny = cny / cnLen;
            const push = (aRadius - options.coastDist) / ORCA_TAU_OBST;
            scratch.linePx[lineCount] = inx * push;
            scratch.linePy[lineCount] = iny * push;
            // Inward normal is (-dy, dx) = (inx, iny) => dx = iny, dy = -inx.
            scratch.lineDx[lineCount] = iny;
            scratch.lineDy[lineCount] = -inx;
            lineCount++;
            coastCount++;
        }
    }

    // 2. Static obstacles (wildlife, FIXTURE_FEET, boundary planes).
    if (obstacles && obstacles.length > 0) {
        for (let i = 0; i < obstacles.length; i++) {
            const obs = obstacles[i];
            if (!obs) continue;
            if (!obs.allTiers && (obs.surfaceTier ?? 0) !== aTier) continue;
            if (obs.kind === 'boundary') {
                if (coastCount >= ORCA_MAX_COAST_LINES || lineCount >= ORCA_MAX_LINES) continue;
                const nx = Number(obs.nx) || 0;
                const ny = (Number(obs.ny) || 0) * ORCA_INV_Y_SCALE;
                const nLen = Math.hypot(nx, ny);
                if (nLen <= 1e-6) continue;
                const inx = nx / nLen;
                const iny = ny / nLen;
                const dist = Number.isFinite(obs.dist) ? obs.dist : ((ax - obs.x) * (obs.nx || 0) + (ay - obs.y) * (obs.ny || 0));
                if (dist > aRadius + maxSpeed * ORCA_TAU_OBST) continue;
                const minSpeed = (aRadius - dist) / ORCA_TAU_OBST;
                scratch.linePx[lineCount] = inx * minSpeed;
                scratch.linePy[lineCount] = iny * minSpeed;
                scratch.lineDx[lineCount] = iny;
                scratch.lineDy[lineCount] = -inx;
                lineCount++;
                coastCount++;
                continue;
            }
            const oRadius = resolveObstacleRadius(obs);
            const combinedRadius = aRadius + oRadius;
            const tau = Number.isFinite(obs.tau) && obs.tau > 0 ? obs.tau : ORCA_TAU_OBST;
            const relX = obs.x - ax;
            const relY = (obs.y - ay) * ORCA_Y_SCALE;
            const distSq = relX * relX + relY * relY;
            const ovx = Number(obs.vx) || 0;
            const ovy = (Number(obs.vy) || 0) * ORCA_Y_SCALE;
            const maxRange = combinedRadius + (maxSpeed + Math.hypot(ovx, ovy)) * tau + 16.0;
            if (distSq > maxRange * maxRange) continue;
            const score = computeUrgencyScore(relX, relY, distSq, refVx - ovx, refVy - ovy, combinedRadius, tau);
            obsCount = insertStaticDisc(obsCount, score, distSq, relX, relY, ovx, ovy, combinedRadius, tau);
        }
    }

    // 3. Neighbor agents + active `strike` swing arcs.
    const neighborLimit = options && options.neighborCount !== undefined
        ? options.neighborCount
        : (neighbors ? neighbors.length : 0);

    if (neighbors && neighborLimit > 0) {
        const defaultMaxRange = aRadius + ORCA_AGENT_RADIUS + maxSpeed * 2.0 * ORCA_TAU + 12.0;
        const defaultMaxRangeSq = defaultMaxRange * defaultMaxRange;
        for (let i = 0; i < neighborLimit; i++) {
            const b = neighbors[i];
            if (!b || b === agent) continue;
            if ((b.surfaceTier ?? 0) !== aTier) continue;

            const relX = b.x - ax;
            const relY = (b.y - ay) * ORCA_Y_SCALE;
            const distSq = relX * relX + relY * relY;
            const bRadius = b.radius > 0 ? b.radius : ORCA_AGENT_RADIUS;
            const combinedRadius = aRadius + bRadius;
            let inRange = distSq <= defaultMaxRangeSq;
            if (!inRange && bRadius > ORCA_AGENT_RADIUS) {
                const customRange = combinedRadius + maxSpeed * 2.0 * ORCA_TAU + 12.0;
                inRange = distSq <= customRange * customRange;
            }
            if (inRange) {
                const bPlanted = isAgentPlanted(b);
                const bvx = bPlanted ? 0 : (b.vx || 0);
                const bvy = bPlanted ? 0 : (b.vy || 0) * ORCA_Y_SCALE;
                const tau = bPlanted ? ORCA_TAU_OBST : ORCA_TAU;
                const resp = bPlanted ? 1.0 : 0.5;
                const score = computeUrgencyScore(relX, relY, distSq, refVx - bvx, refVy - bvy, combinedRadius, tau);
                if (nbCount < ORCA_MAX_NEIGHBORS || score < scratch.nbScore[ORCA_MAX_NEIGHBORS - 1]) {
                    nbCount = insertNeighbor(
                        nbCount,
                        score,
                        distSq,
                        relX,
                        relY,
                        bvx,
                        bvy,
                        combinedRadius,
                        resp,
                        tau,
                        stableTieSign(agent, b),
                    );
                }
            }

            if (isStrikeSwingActive(b)) {
                resolveStrikeDisc(b, scratch.swingPoint);
                const sRelX = scratch.swingPoint[0] - ax;
                const sRelY = (scratch.swingPoint[1] - ay) * ORCA_Y_SCALE;
                const sDistSq = sRelX * sRelX + sRelY * sRelY;
                const sCombined = aRadius + scratch.swingPoint[2];
                const sRange = sCombined + maxSpeed * ORCA_TAU_OBST + 16.0;
                if (sDistSq <= sRange * sRange) {
                    const sScore = computeUrgencyScore(sRelX, sRelY, sDistSq, refVx, refVy, sCombined, ORCA_TAU_OBST);
                    obsCount = insertStaticDisc(obsCount, sScore, sDistSq, sRelX, sRelY, 0, 0, sCombined, ORCA_TAU_OBST);
                }
            }
        }
    }

    // Emit static obstacle / swing-arc half-planes FIRST (`numObstLines`),
    // followed by neighbor half-planes, keeping total <= ORCA_MAX_LINES (16).
    for (let i = 0; i < obsCount; i++) {
        lineCount = appendOrcaHalfPlane(
            lineCount,
            vAx,
            vAy,
            scratch.obsPosX[i],
            scratch.obsPosY[i],
            scratch.obsDistSq[i],
            scratch.obsVelX[i],
            scratch.obsVelY[i],
            scratch.obsRad[i],
            1.0,
            scratch.obsTau[i],
            invTimeStep,
            1.0,
        );
    }
    const numObstLines = lineCount;

    for (let i = 0; i < nbCount; i++) {
        lineCount = appendOrcaHalfPlane(
            lineCount,
            vAx,
            vAy,
            scratch.nbPosX[i],
            scratch.nbPosY[i],
            scratch.nbDistSq[i],
            scratch.nbVelX[i],
            scratch.nbVelY[i],
            scratch.nbRad[i],
            scratch.nbResp[i],
            scratch.nbTau[i],
            invTimeStep,
            scratch.nbTieSign[i],
        );
    }

    // Solve 2D Simplex LP in scaled ellipse space.
    const lpResult = scratch.lpResult;
    const lineFail = linearProgram2(
        scratch.linePx,
        scratch.linePy,
        scratch.lineDx,
        scratch.lineDy,
        lineCount,
        maxSpeed,
        prefSx,
        prefSy,
        false,
        lpResult,
    );

    if (lineFail < lineCount) {
        // When static obstacle lines themselves conflict, relax from 0 so the
        // agent finds the minimum-penetration escape instead of stalling.
        const fixedObst = lineFail < numObstLines ? 0 : numObstLines;
        linearProgram3(
            scratch.linePx,
            scratch.linePy,
            scratch.lineDx,
            scratch.lineDy,
            lineCount,
            fixedObst,
            lineFail,
            maxSpeed,
            lpResult,
        );
    }

    // Scale Y velocity back into world space and cap final world speed.
    let worldVx = lpResult[0];
    let worldVy = lpResult[1] * ORCA_INV_Y_SCALE;
    const worldSpeedSq = worldVx * worldVx + worldVy * worldVy;
    if (worldSpeedSq > maxSpeed * maxSpeed) {
        const clamp = maxSpeed / Math.sqrt(worldSpeedSq);
        worldVx *= clamp;
        worldVy *= clamp;
    }

    outVel[0] = worldVx;
    outVel[1] = worldVy;
    return lineCount;
}

const stepSolveOptions = {
    dt: 0.05,
    maxSpeed: 0,
    neighborCount: 0,
};

/**
 * Allocation-free multi-agent simulation step over an array of agents using a
 * flat typed-array spatial hash grid (48 px cells) + Context Steering + ORCA LP.
 *
 * Updates velocities synchronously (Jacobi) and optionally integrates positions
 * (`options.integrate !== false`), keeping planted bodies strictly stationary.
 * Returns total ORCA half-plane count solved across the frame.
 */
export function stepCrowdOrca(agents, dt = 1 / 30, obstacles = null, options = null) {
    const count = agents ? agents.length : 0;
    if (count === 0) return 0;
    ensureStepCapacity(count);

    const stepDt = Math.max(1e-4, Number(dt) || (1 / 30));
    const integrate = !options || options.integrate !== false;
    const useContextSteering = !options || options.contextSteering !== false;
    const arrivalRadius = options && Number.isFinite(options.arrivalRadius) ? options.arrivalRadius : 1.5;
    const queryCells = options && Number.isInteger(options.queryCells) ? options.queryCells : 1;
    const strideSteer = options && typeof options.strideSteer === 'function' ? options.strideSteer : null;
    const isWalkable = options && typeof options.isWalkable === 'function' ? options.isWalkable : null;

    // 1. Insert all agents into flat O(1)-reset spatial hash grid.
    let gen = stepPool.generation + 1;
    if (gen >= 0x7fffffff) {
        stepPool.bucketGen.fill(0);
        gen = 1;
    }
    stepPool.generation = gen;
    const bucketGen = stepPool.bucketGen;
    const bucketHead = stepPool.bucketHead;
    const agentNext = stepPool.agentNext;
    const agentCellX = stepPool.agentCellX;
    const agentCellY = stepPool.agentCellY;

    for (let i = 0; i < count; i++) {
        const a = agents[i];
        if (!a) continue;
        const cx = Math.floor(a.x / GRID_CELL_SIZE);
        const cy = Math.floor(a.y / GRID_CELL_SIZE);
        agentCellX[i] = cx;
        agentCellY[i] = cy;
        const h = hashCell(cx, cy);
        if (bucketGen[h] !== gen) {
            bucketGen[h] = gen;
            bucketHead[h] = i;
            agentNext[i] = -1;
        } else {
            agentNext[i] = bucketHead[h];
            bucketHead[h] = i;
        }
    }

    // 2. Solve all velocities synchronously from the start-of-step snapshot.
    const nearby = stepPool.nearby;
    const velX = stepPool.velX;
    const velY = stepPool.velY;
    let totalLines = 0;
    stepSolveOptions.dt = stepDt;

    for (let i = 0; i < count; i++) {
        const a = agents[i];
        if (!a || isAgentPlanted(a)) {
            velX[i] = 0;
            velY[i] = 0;
            continue;
        }

        const gaitSpeed = Number.isFinite(a.gaitSpeed)
            ? a.gaitSpeed
            : Number.isFinite(a._gaitSpeed) && a._gaitSpeed > 0
                ? a._gaitSpeed
                : Number.isFinite(a.maxSpeed)
                    ? a.maxSpeed
                    : 45;

        let desVx = 0;
        let desVy = 0;
        let desiredSpeed = gaitSpeed;
        if (Number.isFinite(a.targetX) && Number.isFinite(a.targetY)) {
            const dx = a.targetX - a.x;
            const dy = a.targetY - a.y;
            const distSq = dx * dx + dy * dy;
            if (distSq > arrivalRadius * arrivalRadius) {
                const dist = Math.sqrt(distSq);
                const maxStepSpeed = dist / stepDt;
                desiredSpeed = gaitSpeed < maxStepSpeed ? gaitSpeed : maxStepSpeed;
                const scale = desiredSpeed / dist;
                desVx = dx * scale;
                desVy = dy * scale;
            }
        } else if (Number.isFinite(a.preferredVx) && Number.isFinite(a.preferredVy)) {
            desVx = a.preferredVx;
            desVy = a.preferredVy;
            const pSpd = Math.sqrt(desVx * desVx + desVy * desVy);
            desiredSpeed = gaitSpeed < pSpd ? gaitSpeed : pSpd;
        }

        // Gather candidate neighbors from nearby grid cells into scratch buffer.
        const cx = agentCellX[i];
        const cy = agentCellY[i];
        let nearbyCount = 0;
        for (let oy = -queryCells; oy <= queryCells; oy++) {
            const ny = cy + oy;
            for (let ox = -queryCells; ox <= queryCells; ox++) {
                const nx = cx + ox;
                const h = hashCell(nx, ny);
                if (bucketGen[h] !== gen) continue;
                let idx = bucketHead[h];
                while (idx !== -1) {
                    if (idx !== i && agentCellX[idx] === nx && agentCellY[idx] === ny) {
                        nearby[nearbyCount++] = agents[idx];
                    }
                    idx = agentNext[idx];
                }
            }
        }

        stepSolveOptions.neighborCount = nearbyCount;
        stepSolveOptions.maxSpeed = gaitSpeed;

        let pvx = desVx;
        let pvy = desVy;
        if (useContextSteering && desiredSpeed > 1e-6) {
            computePreferredVelocity(a, desVx, desVy, desiredSpeed, nearby, obstacles, scratch.prefVel, stepSolveOptions);
            pvx = scratch.prefVel[0];
            pvy = scratch.prefVel[1];
        }

        totalLines += solveOrcaVelocity(a, pvx, pvy, nearby, obstacles, scratch.outVel, stepSolveOptions);
        velX[i] = scratch.outVel[0];
        velY[i] = scratch.outVel[1];
    }

    // 3. Apply solved velocities and optional stride-lock / walkability integration.
    for (let i = 0; i < count; i++) {
        const a = agents[i];
        if (!a) continue;
        if (isAgentPlanted(a)) {
            a.vx = 0;
            a.vy = 0;
            continue;
        }
        const vx = velX[i];
        const vy = velY[i];
        a.vx = vx;
        a.vy = vy;
        if (!integrate) continue;

        let nextX = a.x + vx * stepDt;
        let nextY = a.y + vy * stepDt;
        if (strideSteer) {
            const steered = strideSteer(a, nextX, nextY);
            if (!steered) continue;
            nextX = steered.x;
            nextY = steered.y;
        }
        if (isWalkable && !isWalkable(a, nextX, nextY)) {
            if (isWalkable(a, nextX, a.y)) {
                nextY = a.y;
            } else if (isWalkable(a, a.x, nextY)) {
                nextX = a.x;
            } else {
                continue;
            }
        }
        a.x = nextX;
        a.y = nextY;
    }

    return totalLines;
}
