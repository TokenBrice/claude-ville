// SD-1 (the Sundial) — the world-locked shade field.
//
// One field on the island's ground plane holds what a directional sweep
// leaves in shade. The sun is the first user (`RakingLight.castLightingFor`
// gives the sweep); the same build serves any other vector (rain shelter,
// snow drift) by passing another `sweep`.
//
// Grid. The 2.2 footprint rect (`FootprintField.footprintFieldRect`: the map
// diamond plus 128 world px of margin), in cells of SHADE_CELL_W x
// SHADE_CELL_H = 2 x 1 world px: the ground's own 2x1 texel grid, square in
// ground metric (world x, world y doubled). 1408 x 1536 cells on this map.
//
// Encoding. `field.data` is a Uint8Array of two bytes per cell, row-major from
// the rect's top-left (an RG8 texture as it stands, `shadeFieldTexture`):
//
//   R  ceiling   in steps of SHADE_CEILING_STEP = 2 world px (0-510 px: the
//                Lighthouse stands 320). A point `h` px above this ground
//                cell is in shade when `ceiling > h + bias`: the maximum over
//                the opaque, grounded masses (landmark massing, the curtain
//                wall, the gatehouse) of the height of their shadow volume
//                here. Under a mass it is the mass's own top. 0 = open to the
//                sweep. `shadeCeilingAt` answers in world px.
//   G  coverage  0-255, what the GROUND takes: 255 inside a mass's shadow,
//                ramping to 0 over the shadow's last SHADE_TIP_SHARE (its
//                tip), and the thinned share of a porous caster (a bare
//                crown). The ground rule is one ordered dither on the cell
//                grid: shaded when `coverage > bayer(cell) * 255`
//                (`shadeGroundAt`), so a tip dissolves and a bare tree casts
//                a broken shade, never a translucent one.
//
// Both channels take the maximum over casters, so overlapping shadows never
// darken twice. Trees and props write coverage only (their own sprite pixels
// must not read as shaded by themselves in the receiver test).
//
// SD-2 (receivers take shade). A field built with `texels` also carries
// `field.texels`, four bytes per cell (an RGBA8 texture as it stands): R and
// G as above, and
//
//   B  canopy    the ground coverage of the trees' canopies alone (their
//                slabs from SHADE_CANOPY_MIN up). A body tests it where the
//                sun's ray through each of its texels meets the ground, so
//                everything in it stands over the body: the shade comes down
//                over a figure walking in under a crown, and no tree or prop
//                (they do not read it) shades itself.
//   A  surface   about the DRAWN position, not the ground point: what the
//                massing's view planes (`createShadeViewBuild`) show there
//                and how the sun finds it, SHADE_SURFACE x
//                SHADE_SURFACE_STEP. A wall or a top (a roof pitch, a dome
//                ring, a cap, a deck) is lit, in another mass's cast shade,
//                or turned from the sweep (it takes no step: the verdict
//                keeps it out of the cast test). The cast test runs here,
//                with the massing's own heights and normals: a top at its
//                true height (a sprite's surface channel stands roof texels
//                on the front wall plane) against the ceiling over its own
//                ground point, a sunward wall against the ceiling just
//                outside its foot.
//
// Casters.
//   facets   a convex plan polygon under a planar top (`facet`), from the
//            landmark massing (`massingFacets` over
//            config/landmarkMassing.js), the wall runs and the gatehouse.
//            Exact: for a sweep S (world px of shadow per px of height) the
//            ceiling at p is max over t of top(p - t S) - t, taken at an end
//            of the ray's span over the plan polygon. A standing prop with a
//            mass of its own casts the same way (PROP_MASSING: the windmill),
//            and a solid may stand off the ground (`base`: a board on posts
//            shades only the ground its shadow reaches).
//   lathes   a sprite silhouette turned round its axis (`latheProfile`): per
//            2-px slab a disc as wide as the row's opaque span, its coverage
//            the span's fill, so a leafy crown is solid, a bare one thin and
//            a trunk a line. Swept discs are rasterized once per shape and
//            sweep (`latheStamp`) and stamped per instance.
//
// Build. `createShadeFieldBuild(...)` returns a job; `job.step(budgetMs)`
// advances it and returns true when `job.field` is complete, so a caller can
// spread a build over idle slices. `buildShadeField(...)` runs it to the end.
// `shadeFieldFor(renderer, shade)` is the renderer's field for the frame's
// sun: every build (the first, the sun moving a bucket, the scenery or the
// season changing) runs in idle slices off the frame, while the previous
// field stays up.
//
// Accessors (pure, world px in): `shadeCeilingAt`, `shadeCoverageAt`,
// `shadeGroundAt` (the ground rule), `shadePointAt` (the receiver test),
// `shadeLitShareAt` (the sunlit share of an air column, for mist),
// `shadeFieldTexture` (the RG8 upload and its rect), `paintShadeCells` (the
// ground rule as RGBA cells, what slice 1 draws).
//
// Pure apart from `shadeFieldFor` and its helpers (they need a document):
// everything else imports and runs in Node.

import { MAP_SIZE } from '../../config/constants.js';
import { LANDMARK_MASSING, PROP_MASSING } from '../../config/landmarkMassing.js';
import { VILLAGE_GATE, VILLAGE_GATE_GEOMETRY, VILLAGE_WALL_ROUTES } from '../../config/townPlan.js';
import { footprintFieldRect } from './FootprintField.js';
import { buildingCenterToWorld, tileToWorld } from './Projection.js';

export const SHADE_CELL_W = 2;
export const SHADE_CELL_H = 1;
// World px of height per unit of the ceiling byte.
export const SHADE_CEILING_STEP = 2;
// The share of a mass's height whose shadow (the tip) dissolves, and the
// least tip in world px of height.
export const SHADE_TIP_SHARE = 0.25;
export const SHADE_TIP_MIN_PX = 4;
// A receiver must stand this far under the ceiling to count as shaded.
export const SHADE_POINT_BIAS = 2;
// Sides of a round solid's plan polygon, and rings of a dome.
const ROUND_SIDES = 12;
const DOME_RINGS = 4;
// Lathe slabs are this many sprite rows; a span filled this far is solid.
const LATHE_SLAB_ROWS = 2;
const LATHE_SOLID_FILL = 0.75;
const LATHE_MIN_RADIUS = 1.6;
const LATHE_ALPHA_MIN = 128;
// SD-2 — a wall counts as turned from the sun by the sweep's ground angle
// held inside this (rad): the authored sun never passes behind the plane of
// a street wall (the fan's ends graze it), so no wall flips at dawn or dusk.
export const SHADE_FACING_MAX = 0.7;
// SD-2 receivers. A point must stand this far (world px) under the ceiling to
// be in shade; a sunward wall is tested this far outside its foot (ground
// px), so its own mass never counts; an upright's foot moves this far toward
// the sun before the read (world px), so a figure against a sunlit wall is
// not under that wall.
export const SHADE_RECEIVER_BIAS = 3;
export const SHADE_WALL_CLEAR = 5;
export const SHADE_FOOT_CLEAR = 3;
// A sunward wall the sun only grazes (the cosine of its incidence under
// this) takes no cast shade: along it another mass's shadow is a streak
// whose edge no fit can place, so the wall keeps the art's lit face.
export const SHADE_GRAZE = 0.2;
// A tree's slabs from this height up (world px) are its canopy: the part
// that can stand over a body (texel B).
export const SHADE_CANOPY_MIN = 40;
// Texel A: what the massing shows at a drawn position and how the sun finds
// it (the code times SHADE_SURFACE_STEP).
// `wallTurned` is a round wall past its terminator, `flatTurned` a flat one:
// a sprite's own left face never takes the second (its corner line is the
// art's, not the massing's).
export const SHADE_SURFACE = Object.freeze({ none: 0, wallLit: 1, wallCast: 2, wallTurned: 3, topLit: 4, topCast: 5, topTurned: 6, flatTurned: 7 });
export const SHADE_SURFACE_STEP = 32;
// The view plane's surface code (Uint16): the facet (index + 1) in the low
// bits, and for a wall the plan edge it stands on (index + 1) above them.
// ponytail: 2047 facets and 31 edges; past that codes alias (a wall or top
// may take a neighbour's facing). Widen the plane if a scene ever needs more.
const VIEW_FACET_MASK = 2047;
const VIEW_EDGE_SHIFT = 11;
const VIEW_EDGE_MAX = 31;

// A short stamp of the massing config: what is baked from a field (the frost)
// keys on it, so a refitted landmark retires the persisted bake.
export const SHADE_MASSING_REVISION = (() => {
    let hash = 0;
    for (const char of JSON.stringify([LANDMARK_MASSING, PROP_MASSING])) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
    return (hash >>> 0).toString(36);
})();

const BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

/** The ordered-dither threshold (0-1, exclusive) of a field cell. */
export function shadeBayer(col, row) {
    return (BAYER4[((row & 3) << 2) | (col & 3)] + 0.5) / 16;
}

/** The field's grid over the map: world origin, cell size and cell counts. */
export function shadeFieldRect(mapSize = MAP_SIZE) {
    const rect = footprintFieldRect(mapSize);
    return {
        originX: rect.originX,
        originY: rect.originY,
        cellW: SHADE_CELL_W,
        cellH: SHADE_CELL_H,
        cols: Math.ceil(rect.width * rect.cell / SHADE_CELL_W),
        rows: Math.ceil(rect.height * rect.cell / SHADE_CELL_H),
    };
}

// ---------------------------------------------------------------- facets

/**
 * A facet from its corners `[[x, y, z], ...]` (world px, z the top's height
 * there): a convex plan polygon under one plane. `height` is the whole
 * solid's height (its tip is measured on it); `ceiling: false` keeps it out
 * of the receiver channel. `base` (world px) lifts the solid's underside off
 * the ground (a board on posts): the sun then passes under it, and it shades
 * only the ground its shadow reaches.
 */
export function facet(points, { height = null, ceiling = true, coverage = 1, base = 0 } = {}) {
    const n = points.length;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    let top = 0;
    let area = 0;
    for (let i = 0; i < n; i++) {
        x[i] = points[i][0];
        y[i] = points[i][1];
        z[i] = points[i][2];
        top = Math.max(top, z[i]);
        const next = points[(i + 1) % n];
        area += points[i][0] * next[1] - next[0] * points[i][1];
    }
    // The top's plane through the first corner: z = z0 + gx dx + gy dy, from
    // the widest corner triple (a flat top has gx = gy = 0).
    let gx = 0;
    let gy = 0;
    let best = 0;
    for (let i = 1; i < n - 1; i++) {
        const ux = x[i] - x[0];
        const uy = y[i] - y[0];
        const vx = x[i + 1] - x[0];
        const vy = y[i + 1] - y[0];
        const det = ux * vy - uy * vx;
        if (Math.abs(det) <= Math.abs(best)) continue;
        best = det;
        const uz = z[i] - z[0];
        const vz = z[i + 1] - z[0];
        gx = (uz * vy - uy * vz) / det;
        gy = (ux * vz - uz * vx) / det;
    }
    return { n, x, y, z, top, sign: area >= 0 ? 1 : -1, gx, gy, height: height ?? top, ceiling, coverage, base: Math.max(0, base) };
}

// A round plan as a polygon with corners on the two screen axes (tile
// diagonals), so its drawn width and depth are the circle's own.
function ring(cx, cy, radius, sides = ROUND_SIDES) {
    const out = [];
    for (let i = 0; i < sides; i++) {
        const a = ((i + 0.5) / sides) * Math.PI * 2;
        out.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
    }
    return out;
}

/**
 * One massing solid (config/landmarkMassing.js: tiles and world px of
 * height) as facets. `toWorld(tileX, tileY)` returns `[x, y]` world px. Every
 * solid stands on the ground and is convex, so each facet is the top of a
 * column down to the ground.
 */
export function solidFacets(solid, toWorld) {
    const at = solid.at || [0, 0, 0, 0];
    const [x0, y0, x1, y1] = at;
    const p = (tx, ty, z) => [...toWorld(tx, ty), z];
    const out = [];
    const add = (points, height) => out.push(facet(points, { height, base: solid.base }));
    // SD-2 — a round top's facets carry the solid's axis (world px), so the
    // side turned from the sun is told about it smoothly, not gore by gore.
    const round = (from, centre) => {
        const axis = toWorld(centre[0], centre[1]);
        for (let i = from; i < out.length; i++) out[i].axis = axis;
    };
    switch (solid.kind) {
        case 'box':
            add([p(x0, y0, solid.top), p(x1, y0, solid.top), p(x1, y1, solid.top), p(x0, y1, solid.top)], solid.top);
            break;
        case 'gable': {
            const { eave, ridge } = solid;
            if (solid.axis === 'y') {
                const xm = (x0 + x1) / 2;
                add([p(x0, y0, eave), p(xm, y0, ridge), p(xm, y1, ridge), p(x0, y1, eave)], ridge);
                add([p(xm, y0, ridge), p(x1, y0, eave), p(x1, y1, eave), p(xm, y1, ridge)], ridge);
            } else {
                const ym = (y0 + y1) / 2;
                add([p(x0, y0, eave), p(x1, y0, eave), p(x1, ym, ridge), p(x0, ym, ridge)], ridge);
                add([p(x0, ym, ridge), p(x1, ym, ridge), p(x1, y1, eave), p(x0, y1, eave)], ridge);
            }
            break;
        }
        case 'hip': {
            // The ridge runs along `axis`, drawn in by half the roof's span at
            // each end (`inset` tiles overrides it).
            const { eave, ridge } = solid;
            if (solid.axis === 'y') {
                const xm = (x0 + x1) / 2;
                const inset = Math.min(solid.inset ?? (x1 - x0) / 2, (y1 - y0) / 2);
                const ya = y0 + inset;
                const yb = y1 - inset;
                add([p(x0, y0, eave), p(xm, ya, ridge), p(xm, yb, ridge), p(x0, y1, eave)], ridge);
                add([p(xm, ya, ridge), p(x1, y0, eave), p(x1, y1, eave), p(xm, yb, ridge)], ridge);
                add([p(x0, y0, eave), p(x1, y0, eave), p(xm, ya, ridge)], ridge);
                add([p(xm, yb, ridge), p(x1, y1, eave), p(x0, y1, eave)], ridge);
            } else {
                const ym = (y0 + y1) / 2;
                const inset = Math.min(solid.inset ?? (y1 - y0) / 2, (x1 - x0) / 2);
                const xa = x0 + inset;
                const xb = x1 - inset;
                add([p(x0, y0, eave), p(x1, y0, eave), p(xb, ym, ridge), p(xa, ym, ridge)], ridge);
                add([p(xa, ym, ridge), p(xb, ym, ridge), p(x1, y1, eave), p(x0, y1, eave)], ridge);
                add([p(x0, y0, eave), p(xa, ym, ridge), p(x0, y1, eave)], ridge);
                add([p(x1, y0, eave), p(x1, y1, eave), p(xb, ym, ridge)], ridge);
            }
            break;
        }
        case 'pyramid': {
            const { eave, apex } = solid;
            const xm = (x0 + x1) / 2;
            const ym = (y0 + y1) / 2;
            add([p(x0, y0, eave), p(x1, y0, eave), p(xm, ym, apex)], apex);
            add([p(x1, y0, eave), p(x1, y1, eave), p(xm, ym, apex)], apex);
            add([p(x1, y1, eave), p(x0, y1, eave), p(xm, ym, apex)], apex);
            add([p(x0, y1, eave), p(x0, y0, eave), p(xm, ym, apex)], apex);
            break;
        }
        case 'cylinder': {
            const [cx, cy] = solid.centre;
            add(ring(cx, cy, solid.radius).map(([tx, ty]) => p(tx, ty, solid.top)), solid.top);
            round(0, solid.centre);
            break;
        }
        case 'cone': {
            const [cx, cy] = solid.centre;
            const rim = ring(cx, cy, solid.radius);
            for (let i = 0; i < rim.length; i++) {
                const a = rim[i];
                const b = rim[(i + 1) % rim.length];
                add([p(a[0], a[1], solid.eave), p(b[0], b[1], solid.eave), p(cx, cy, solid.apex)], solid.apex);
            }
            round(0, solid.centre);
            break;
        }
        case 'dome': {
            // A hemisphere-like cap in DOME_RINGS frusta and a flat crown.
            const [cx, cy] = solid.centre;
            const rise = solid.apex - solid.eave;
            let lower = ring(cx, cy, solid.radius);
            let lowerZ = solid.eave;
            for (let k = 1; k <= DOME_RINGS; k++) {
                const phi = (k / (DOME_RINGS + 1)) * (Math.PI / 2);
                const upper = ring(cx, cy, solid.radius * Math.cos(phi));
                const upperZ = solid.eave + rise * Math.sin(phi);
                for (let i = 0; i < lower.length; i++) {
                    const j = (i + 1) % lower.length;
                    add([p(lower[i][0], lower[i][1], lowerZ), p(lower[j][0], lower[j][1], lowerZ),
                        p(upper[j][0], upper[j][1], upperZ), p(upper[i][0], upper[i][1], upperZ)], solid.apex);
                }
                lower = upper;
                lowerZ = upperZ;
            }
            round(0, solid.centre);
            add(lower.map(([tx, ty]) => p(tx, ty, solid.apex)), solid.apex);
            break;
        }
        default:
            throw new RangeError(`unknown massing solid: ${solid.kind}`);
    }
    return out;
}

/**
 * A landmark's massing (`{ solids }`, tiles from its footprint origin) as
 * facets in world px round `centre` (the footprint centre's world point;
 * `{ x: 0, y: 0 }` gives sprite-anchor-relative px, as the tooling wants).
 */
export function massingFacets(massing, { width, height }, centre = { x: 0, y: 0 }) {
    const toWorld = (tx, ty) => {
        const local = tileToWorld(tx - width / 2, ty - height / 2);
        return [centre.x + local.x, centre.y + local.y];
    };
    const out = [];
    for (const solid of massing?.solids || []) out.push(...solidFacets(solid, toWorld));
    return out;
}

const absoluteTile = (tx, ty) => {
    const world = tileToWorld(tx, ty);
    return [world.x, world.y];
};

// The curtain wall and the gatehouse as massing solids in absolute tiles,
// from the constants the art itself is baked from (config/townPlan.js,
// VillageWall WALL_SPEC: the walk at 50 px under 10-px merlons, the curtain
// 0.1875 tile either side of its line). Heights are the mean crenel line.
const WALL_HALF_DEPTH = 0.1875;
const WALL_TOP = 56;

/** The village's masonry (wall runs `[{ from, to }]` in tiles, and the gate) as facets. */
export function masonryFacets({ runs = [], gate = true } = {}) {
    const solids = [];
    // ponytail: a run is a box along tile x (both routes are); a run on any
    // other bearing needs an oriented box here.
    for (const run of runs) {
        const x0 = Math.min(run.from.tileX, run.to.tileX);
        const x1 = Math.max(run.from.tileX, run.to.tileX);
        const y = run.from.tileY;
        solids.push({ kind: 'box', at: [x0, y - WALL_HALF_DEPTH, x1, y + WALL_HALF_DEPTH], top: WALL_TOP });
    }
    if (gate) {
        const G = VILLAGE_GATE_GEOMETRY;
        const gx = VILLAGE_GATE.tileX;
        const gy = VILLAGE_GATE.tileY;
        const half = VILLAGE_GATE.widthTiles / 2;
        const [west, east] = G.towerX;
        // The stubs that join the runs, the arch block and the two drums
        // under their cones.
        solids.push({ kind: 'box', at: [gx - half, gy - WALL_HALF_DEPTH, gx + west, gy + WALL_HALF_DEPTH], top: WALL_TOP });
        solids.push({ kind: 'box', at: [gx + east, gy - WALL_HALF_DEPTH, gx + half, gy + WALL_HALF_DEPTH], top: WALL_TOP });
        solids.push({ kind: 'box', at: [gx + west, gy - G.blockHalfDepth, gx + east, gy + G.blockHalfDepth], top: G.blockTop + G.merlon.height / 2 });
        for (const tx of G.towerX) {
            solids.push({ kind: 'cylinder', centre: [gx + tx, gy], radius: G.towerR, top: G.ringTop });
            solids.push({ kind: 'cone', centre: [gx + tx, gy], radius: G.towerR + G.eaveOut, eave: G.ringTop, apex: G.roofApex });
        }
    }
    const out = [];
    for (const solid of solids) out.push(...solidFacets(solid, absoluteTile));
    return out;
}

// ---------------------------------------------------------------- lathes

/**
 * The lathe profile of a sprite: `alpha` (one byte per texel, `width` x
 * `height`), `footRow` the row its foot stands on, `axis` the column every
 * slab is centred on (null: each slab on its own span's centre; a tree's
 * lean frames keep one profile with its trunk axis). Returns `{ slabs,
 * height }`: each slab `{ z0, z1, r, cx, cov }` in px above the foot, the
 * disc's radius and centre offset from the foot column in world px, and its
 * coverage 0-1.
 */
export function latheProfile(alpha, width, height, footRow, { axis = null, footCol = null } = {}) {
    const slabs = [];
    const foot = Math.min(height - 1, Math.max(0, Math.round(footRow)));
    const column = footCol ?? axis ?? width / 2;
    let top = 0;
    for (let row = foot; row >= 0; row -= LATHE_SLAB_ROWS) {
        let min = width;
        let max = -1;
        let filled = 0;
        let rows = 0;
        for (let r = row; r > row - LATHE_SLAB_ROWS && r >= 0; r--) {
            rows++;
            const base = r * width;
            for (let c = 0; c < width; c++) {
                if (alpha[base + c] < LATHE_ALPHA_MIN) continue;
                filled++;
                if (c < min) min = c;
                if (c > max) max = c;
            }
        }
        if (max < min) continue;
        const span = max - min + 1;
        const fill = filled / (span * rows);
        const z0 = foot - row;
        const z1 = z0 + rows;
        slabs.push({
            z0,
            z1,
            r: Math.max(LATHE_MIN_RADIUS, span / 2),
            cx: axis == null ? (min + max + 1) / 2 - column : axis - column,
            cov: Math.min(1, fill / LATHE_SOLID_FILL),
        });
        top = Math.max(top, z1);
    }
    return { slabs, height: top };
}

/**
 * A lathe profile swept along `sweep` (`{ sx, sy }`, world px per px of
 * height) as a coverage stamp on the field's cell grid: `{ cols, rows, ox,
 * oy, cov }`, `ox`/`oy` the stamp's top-left cell relative to the caster's
 * foot cell. Each slab is the capsule its disc sweeps between its two
 * heights (a circle in ground metric, where a cell is square). SD-2 —
 * `canopyMin` (world px) also returns `canopy`: the coverage of the slabs
 * from that height up alone, or null when there is none.
 */
export function latheStamp(profile, sweep, tipShare = SHADE_TIP_SHARE, canopyMin = Infinity) {
    const { slabs, height } = profile;
    if (!slabs.length) return null;
    const sx = sweep.sx / SHADE_CELL_W;
    const sy = sweep.sy / SHADE_CELL_H;
    const tip = Math.max(SHADE_TIP_MIN_PX, tipShare * height);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const capsules = slabs.map((slab) => {
        const rad = slab.r / SHADE_CELL_W;
        const ax = slab.cx / SHADE_CELL_W + slab.z0 * sx;
        const ay = slab.z0 * sy;
        const bx = slab.cx / SHADE_CELL_W + slab.z1 * sx;
        const by = slab.z1 * sy;
        minX = Math.min(minX, ax - rad, bx - rad);
        maxX = Math.max(maxX, ax + rad, bx + rad);
        minY = Math.min(minY, ay - rad, by - rad);
        maxY = Math.max(maxY, ay + rad, by + rad);
        const fade = Math.min(1, Math.max(0, (height - slab.z0) / tip));
        return { ax, ay, bx, by, rad, cov: Math.round(255 * slab.cov * fade), high: slab.z0 >= canopyMin };
    });
    const ox = Math.floor(minX);
    const oy = Math.floor(minY);
    const cols = Math.ceil(maxX) - ox + 1;
    const rows = Math.ceil(maxY) - oy + 1;
    const cov = new Uint8Array(cols * rows);
    const canopy = capsules.some(capsule => capsule.high && capsule.cov > 0) ? new Uint8Array(cols * rows) : null;
    for (const capsule of capsules) {
        if (capsule.cov <= 0) continue;
        const { ax, ay, bx, by, rad } = capsule;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - rad) - ox);
        const c1 = Math.min(cols - 1, Math.ceil(Math.max(ax, bx) + rad) - ox);
        const r0 = Math.max(0, Math.floor(Math.min(ay, by) - rad) - oy);
        const r1 = Math.min(rows - 1, Math.ceil(Math.max(ay, by) + rad) - oy);
        const rad2 = rad * rad;
        for (let row = r0; row <= r1; row++) {
            const py = oy + row + 0.5 - ay;
            for (let col = c0; col <= c1; col++) {
                const px = ox + col + 0.5 - ax;
                const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
                const ex = px - t * dx;
                const ey = py - t * dy;
                if (ex * ex + ey * ey > rad2) continue;
                const index = row * cols + col;
                if (cov[index] < capsule.cov) cov[index] = capsule.cov;
                if (capsule.high && canopy[index] < capsule.cov) canopy[index] = capsule.cov;
            }
        }
    }
    return { cols, rows, ox, oy, cov, canopy };
}

// ----------------------------------------------------------------- build

/** The convex hull of `[[x, y], ...]`, counter-clockwise in a y-up frame (monotone chain). */
export function convexHull(points) {
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (sorted.length < 3) return sorted;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (const p of sorted.reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function sweepKey(sweep) {
    return `${sweep.sx.toFixed(4)},${sweep.sy.toFixed(4)}`;
}

/**
 * A sliced build of one field. `sweep` = `{ sx, sy }`, the shadow's offset in
 * world px per px of height; `facets` from `facet` / `massingFacets`;
 * `lathes` = `[{ x, y, profile, key }]` (world foot, `latheProfile`, `key`
 * naming the shape so equal shapes share one stamp); `data` an optional
 * buffer of the rect's size to reuse. `job.step(budgetMs)` returns true once
 * `job.field` is complete.
 *
 * SD-2 — `texels` (a Uint8Array of four bytes per cell) asks for the
 * receivers' texture as well (`field.texels`, see the header), with `view`
 * the finished view planes of the same facets (`createShadeViewBuild`).
 * `seen` turns the job into that view build: it fills `seen.height` and
 * `seen.facet` instead and ends with `job.view`.
 */
export function createShadeFieldBuild({ rect = shadeFieldRect(), sweep, facets = [], lathes = [], data = null, tipShare = SHADE_TIP_SHARE, texels = null, view = null, seen = null } = {}) {
    const { originX, originY, cellW, cellH, cols, rows } = rect;
    const size = cols * rows * 2;
    const out = seen ? null : data && data.length === size ? data.fill(0) : new Uint8Array(size);
    // The view build sweeps along the eye: a point `z` px up draws `z` px up.
    const sx = seen ? 0 : Number(sweep?.sx) || 0;
    const sy = seen ? -1 : Number(sweep?.sy) || 0;
    if (seen) {
        seen.height.fill(0);
        seen.facet.fill(0);
        lathes = [];
    }
    let texelRow = 0;
    let yieldedAt = -1;
    let turned = null;
    let wallTurned = null;
    let wallGrazed = null;
    let wallOut = null;
    let started = false;
    const bounds = { c0: cols, r0: rows, c1: -1, r1: -1 };
    const touch = (col, row) => {
        if (col < bounds.c0) bounds.c0 = col;
        if (col > bounds.c1) bounds.c1 = col;
        if (row < bounds.r0) bounds.r0 = row;
        if (row > bounds.r1) bounds.r1 = row;
    };
    const stamps = new Map();
    let facetIndex = 0;
    let facetRow = -1;
    let facetPlan = null;
    let latheIndex = 0;
    const job = { field: null, done: false, cells: 0, backing: [out, seen?.height, seen?.facet] };

    const planFacet = (f) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const reach = [];
        for (let i = 0; i < f.n; i++) {
            for (const z of [0, f.z[i]]) {
                const px = f.x[i] + z * sx;
                const py = f.y[i] + z * sy;
                reach.push([px, py]);
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }
        }
        const b = new Float64Array(f.n);
        const ex = new Float64Array(f.n);
        const ey = new Float64Array(f.n);
        for (let i = 0; i < f.n; i++) {
            const j = (i + 1) % f.n;
            ex[i] = f.x[j] - f.x[i];
            ey[i] = f.y[j] - f.y[i];
            b[i] = f.sign * (ex[i] * sy - ey[i] * sx);
        }
        return {
            c0: Math.max(0, Math.floor((minX - originX) / cellW)),
            c1: Math.min(cols - 1, Math.ceil((maxX - originX) / cellW)),
            r0: Math.max(0, Math.floor((minY - originY) / cellH)),
            r1: Math.min(rows - 1, Math.ceil((maxY - originY) / cellH)),
            // Everything the facet can shade lies inside the hull of its plan
            // and its plan swept to the ground: a row visits only that span.
            hull: convexHull(reach),
            ex,
            ey,
            b,
            // How fast the ceiling falls along the ray: the top's own slope
            // along the sweep plus the ray's climb.
            k: f.gx * sx + f.gy * sy + 1,
            tip: Math.max(SHADE_TIP_MIN_PX, tipShare * f.height),
            cov: Math.max(0, Math.min(1, f.coverage)),
        };
    };

    const facetRowPass = (f, plan, row) => {
        const py = originY + (row + 0.5) * cellH;
        const { ex, ey, b, k, tip, hull } = plan;
        let c0 = plan.c0;
        let c1 = plan.c1;
        if (hull.length >= 3) {
            let x0 = Infinity;
            let x1 = -Infinity;
            for (let i = 0; i < hull.length; i++) {
                const p = hull[i];
                const q = hull[(i + 1) % hull.length];
                if ((p[1] <= py) === (q[1] <= py)) continue;
                const x = p[0] + (py - p[1]) * (q[0] - p[0]) / (q[1] - p[1]);
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
            }
            if (x1 < x0) return;
            c0 = Math.max(c0, Math.floor((x0 - originX) / cellW) - 1);
            c1 = Math.min(c1, Math.floor((x1 - originX) / cellW) + 1);
        }
        for (let col = c0; col <= c1; col++) {
            const px = originX + (col + 0.5) * cellW;
            let t0 = 0;
            let t1 = Infinity;
            // The plan edge the ray leaves by (the view build's wall).
            let e1 = 0;
            let inside = true;
            for (let i = 0; i < f.n; i++) {
                const a = f.sign * (ex[i] * (py - f.y[i]) - ey[i] * (px - f.x[i]));
                const bi = b[i];
                if (bi > 1e-9) {
                    const t = a / bi;
                    if (t < t1) {
                        t1 = t;
                        e1 = i;
                    }
                } else if (bi < -1e-9) {
                    const t = a / bi;
                    if (t > t0) t0 = t;
                } else if (a < 0) {
                    inside = false;
                    break;
                }
                if (t0 > t1) {
                    inside = false;
                    break;
                }
            }
            if (!inside) continue;
            // A raised solid: a ray that leaves the plan under its underside
            // met nothing (the ground here is lit; the eye sees past it).
            if (f.base > 0 && t1 < f.base) continue;
            const zp = f.z[0] + f.gx * (px - f.x[0]) + f.gy * (py - f.y[0]);
            if (seen) {
                // What the eye meets at this drawn position: the nearest (the
                // highest) point of the ray still under the top. Leaving by
                // the plan's edge is a wall; under the top itself, the top.
                let height;
                let top = false;
                if (t1 !== Infinity && zp - t1 * k >= 0) height = t1;
                else if (k > 0 && zp - t0 * k >= 0) {
                    height = zp / k;
                    top = true;
                } else continue;
                const byte = Math.min(255, Math.round(height / SHADE_CEILING_STEP));
                const cell = row * cols + col;
                // Nearest wins; level, a top wins over a wall (two facets of
                // one roof meet over the wall between their plans).
                if (byte < 1 || byte < seen.height[cell] || (byte === seen.height[cell] && !top)) continue;
                seen.height[cell] = byte;
                seen.facet[cell] = facetIndex % VIEW_FACET_MASK + 1 + (top ? 0 : Math.min(VIEW_EDGE_MAX, e1 + 1) << VIEW_EDGE_SHIFT);
                touch(col, row);
                continue;
            }
            const at = k >= 0 || t1 === Infinity ? t0 : t1;
            const c = zp - at * k;
            if (c < 0.5) continue;
            const index = (row * cols + col) * 2;
            if (f.ceiling) {
                const ceiling = Math.min(255, Math.round(c / SHADE_CEILING_STEP));
                if (ceiling > out[index]) out[index] = ceiling;
            }
            const cover = Math.max(1, Math.round(255 * plan.cov * (c >= tip ? 1 : c / tip)));
            if (cover > out[index + 1]) out[index + 1] = cover;
            touch(col, row);
            job.cells++;
        }
    };

    const stampLathe = (lathe) => {
        const key = `${lathe.key}`;
        let stamp = stamps.get(key);
        if (stamp === undefined) {
            stamp = latheStamp(lathe.profile, { sx, sy }, tipShare, texels && lathe.canopy ? SHADE_CANOPY_MIN : Infinity);
            stamps.set(key, stamp);
        }
        if (!stamp) return;
        const col0 = Math.floor((lathe.x - originX) / cellW) + stamp.ox;
        const row0 = Math.floor((lathe.y - originY) / cellH) + stamp.oy;
        for (let r = 0; r < stamp.rows; r++) {
            const row = row0 + r;
            if (row < 0 || row >= rows) continue;
            for (let c = 0; c < stamp.cols; c++) {
                const cover = stamp.cov[r * stamp.cols + c];
                if (!cover) continue;
                const col = col0 + c;
                if (col < 0 || col >= cols) continue;
                const index = (row * cols + col) * 2 + 1;
                if (cover > out[index]) out[index] = cover;
                if (stamp.canopy) {
                    // Texel B, written here; the texel pass fills the rest.
                    const over = stamp.canopy[r * stamp.cols + c];
                    if (over > texels[index * 2]) texels[index * 2] = over;
                }
                touch(col, row);
            }
        }
    };

    job.step = (budgetMs = Infinity) => {
        if (job.done) return true;
        const limited = Number.isFinite(budgetMs);
        const deadline = limited ? performance.now() + budgetMs : 0;
        if (!started) {
            started = true;
            if (texels) texels.fill(0);
        }
        while (facetIndex < facets.length) {
            const f = facets[facetIndex];
            if (!facetPlan) {
                facetPlan = planFacet(f);
                facetRow = facetPlan.r0;
            }
            while (facetRow <= facetPlan.r1) {
                facetRowPass(f, facetPlan, facetRow++);
                if (limited && (facetRow & 7) === 0 && performance.now() >= deadline) return false;
            }
            facetPlan = null;
            facetIndex++;
        }
        while (latheIndex < lathes.length) {
            stampLathe(lathes[latheIndex++]);
            if (limited && (latheIndex & 3) === 0 && performance.now() >= deadline) return false;
        }
        if (seen) {
            job.view = { height: seen.height, facet: seen.facet, bounds: bounds.c1 >= bounds.c0 ? { ...bounds } : null };
            job.done = true;
            return true;
        }
        if (texels) {
            // The receivers' texture, row by row: the two field bytes (the
            // lathes wrote the canopy byte) and the verdict on what the eye
            // sees there. A surface turns from this sweep by its own slope
            // (a top) or its plan edge (a wall); one that does not is tested
            // against the finished ceiling.
            if (!turned) {
                turned = facets.map(f => f.gx * sx + f.gy * sy + 1 <= 0);
                const angle = Math.max(-SHADE_FACING_MAX, Math.min(SHADE_FACING_MAX, Math.atan2(sy * 2, sx)));
                const fx = Math.cos(angle);
                const fy = Math.sin(angle) * 0.5;
                wallTurned = [];
                wallGrazed = [];
                wallOut = [];
                for (const f of facets) {
                    let mask = 0;
                    let grazed = 0;
                    // Per edge: its outward step (SHADE_WALL_CLEAR ground
                    // px), then its foot line y = slope * x + intercept.
                    const lines = new Float64Array(f.n * 4);
                    for (let i = 0; i < f.n; i++) {
                        const j = (i + 1) % f.n;
                        const ex = f.x[j] - f.x[i];
                        const ey = f.y[j] - f.y[i];
                        const length = Math.hypot(2 * ey, ex) || 1;
                        // The wall's outward normal along the sweep (ground
                        // metric): above 0 it is turned, just under 0 grazed.
                        const along = -2 * f.sign * (ex * fy - ey * fx) / length;
                        if (i < VIEW_EDGE_MAX && along > 0) mask |= 1 << i;
                        if (i < VIEW_EDGE_MAX && along <= 0 && along > -SHADE_GRAZE) grazed |= 1 << i;
                        lines[i * 4] = f.sign * 2 * ey * SHADE_WALL_CLEAR / length;
                        lines[i * 4 + 1] = -f.sign * ex * SHADE_WALL_CLEAR / (2 * length);
                        // An edge seen as a wall is never edge-on to the eye.
                        lines[i * 4 + 2] = ex ? ey / ex : 0;
                        lines[i * 4 + 3] = f.y[i] - f.x[i] * lines[i * 4 + 2];
                    }
                    wallTurned.push(mask);
                    wallGrazed.push(grazed);
                    wallOut.push(lines);
                }
            }
            const ceilingOver = (x, y) => {
                const col = Math.floor((x - originX) / cellW);
                const row = Math.floor((y - originY) / cellH);
                return col < 0 || row < 0 || col >= cols || row >= rows ? 0 : out[(row * cols + col) * 2] * SHADE_CEILING_STEP;
            };
            for (; texelRow < rows; texelRow++) {
                if (limited && texelRow > 0 && (texelRow & 31) === 0 && performance.now() >= deadline) {
                    // Resume on the next row: this one is checked only once.
                    if (yieldedAt !== texelRow) {
                        yieldedAt = texelRow;
                        return false;
                    }
                }
                let from = (texelRow >= bounds.r0 && texelRow <= bounds.r1) ? bounds.c0 : cols;
                let to = (texelRow >= bounds.r0 && texelRow <= bounds.r1) ? bounds.c1 : -1;
                const seenBounds = view?.bounds;
                if (seenBounds && texelRow >= seenBounds.r0 && texelRow <= seenBounds.r1) {
                    from = Math.min(from, seenBounds.c0);
                    to = Math.max(to, seenBounds.c1);
                }
                for (let col = from; col <= to; col++) {
                    const cell = texelRow * cols + col;
                    const o = cell * 4;
                    texels[o] = out[cell * 2];
                    texels[o + 1] = out[cell * 2 + 1];
                    if (!view) continue;
                    const code = view.facet[cell];
                    if (!code) continue;
                    const index = (code & VIEW_FACET_MASK) - 1;
                    const edge = code >> VIEW_EDGE_SHIFT;
                    // The surface's own geometry, exact (the view plane's
                    // height only chose it): a wall's foot on its plan edge,
                    // a top's height from its plane; the ground point under
                    // it; the test at that height.
                    const x = originX + (col + 0.5) * cellW;
                    const y = originY + (texelRow + 0.5) * cellH;
                    let surface;
                    if (edge) {
                        if ((wallTurned[index] >> (edge - 1)) & 1) surface = facets[index].axis ? SHADE_SURFACE.wallTurned : SHADE_SURFACE.flatTurned;
                        else if ((wallGrazed[index] >> (edge - 1)) & 1) surface = SHADE_SURFACE.wallLit;
                        else {
                            const line = wallOut[index];
                            const at = (edge - 1) * 4;
                            const foot = line[at + 2] * x + line[at + 3];
                            const lit = ceilingOver(x + line[at], foot + line[at + 1]) <= foot - y + SHADE_RECEIVER_BIAS;
                            surface = lit ? SHADE_SURFACE.wallLit : SHADE_SURFACE.wallCast;
                        }
                    } else {
                        const f = facets[index];
                        const h = (f.z[0] + f.gx * (x - f.x[0]) + f.gy * (y - f.y[0])) / (1 - f.gy);
                        let away = turned[index];
                        const test = !away;
                        if (f.axis) {
                            // A round top turns about its axis: the facet's
                            // own slope along the true radial direction (in
                            // ground metric, y doubled). A cell that rule
                            // lights on a facet turned as a plane is under
                            // that facet's own ceiling: lit, untested.
                            const ux = x - f.axis[0];
                            const uy = (y + h - f.axis[1]) * 2;
                            const reach = Math.hypot(ux, uy) || 1;
                            away = Math.hypot(f.gx, f.gy / 2) * (ux * sx + 2 * uy * sy) / reach >= 1;
                        }
                        if (away) surface = SHADE_SURFACE.topTurned;
                        else if (!test || ceilingOver(x, y + h) <= h + SHADE_RECEIVER_BIAS) surface = SHADE_SURFACE.topLit;
                        else surface = SHADE_SURFACE.topCast;
                    }
                    texels[o + 3] = surface * SHADE_SURFACE_STEP;
                }
            }
        }
        job.field = {
            originX, originY, cellW, cellH, cols, rows,
            data: out,
            texels,
            sweep: { sx, sy },
            key: sweepKey({ sx, sy }),
            // The cells the build touched (inclusive), or null for an empty field.
            bounds: bounds.c1 >= bounds.c0 ? { ...bounds } : null,
        };
        job.done = true;
        return true;
    };
    return job;
}

/**
 * SD-2 — the view planes of a set of facets, sliced like a field build: per
 * cell, the height (in SHADE_CEILING_STEP px, as the ceiling) of the
 * massing's surface the eye meets at that DRAWN position, and which surface
 * it is (0 = nothing; else the facet, and for a wall its plan edge: the VIEW_
 * code above). A field build turns them into texel A: whether that surface
 * turns from the sun, and whether another mass shades it at its true height
 * (which a sprite's own surface channel, standing roof texels on the front
 * wall plane, does not hold). They hold until the casters change. `height`
 * and `facet` are the planes to fill (a Uint8Array and a Uint16Array of one
 * entry per cell); `job.view` is the result.
 */
export function createShadeViewBuild({ rect = shadeFieldRect(), facets = [], height = null, facet = null } = {}) {
    const cells = rect.cols * rect.rows;
    return createShadeFieldBuild({
        rect,
        facets,
        seen: {
            height: height && height.length === cells ? height : new Uint8Array(cells),
            facet: facet && facet.length === cells ? facet : new Uint16Array(cells),
        },
    });
}

/** One field, built to the end (tests, tooling, the first build of a page). */
export function buildShadeField(options) {
    const job = createShadeFieldBuild(options);
    job.step();
    return job.field;
}

// -------------------------------------------------------------- accessors

function cellIndex(field, x, y) {
    if (!field) return -1;
    const col = Math.floor((x - field.originX) / field.cellW);
    const row = Math.floor((y - field.originY) / field.cellH);
    if (col < 0 || row < 0 || col >= field.cols || row >= field.rows) return -1;
    return row * field.cols + col;
}

/** The shade ceiling over a ground point, world px of height (0 = open). */
export function shadeCeilingAt(field, x, y) {
    const index = cellIndex(field, x, y);
    return index < 0 ? 0 : field.data[index * 2] * SHADE_CEILING_STEP;
}

/** What the ground takes at a point, 0-1 (before the dither). */
export function shadeCoverageAt(field, x, y) {
    const index = cellIndex(field, x, y);
    return index < 0 ? 0 : field.data[index * 2 + 1] / 255;
}

/** The ground rule: is this ground cell drawn shaded? */
export function shadeGroundAt(field, x, y) {
    const index = cellIndex(field, x, y);
    if (index < 0) return false;
    const col = index % field.cols;
    const row = (index - col) / field.cols;
    return field.data[index * 2 + 1] > shadeBayer(col, row) * 255;
}

/** The receiver test: is a point `h` px above this ground point in shade? */
export function shadePointAt(field, x, y, h = 0, bias = SHADE_POINT_BIAS) {
    return shadeCeilingAt(field, x, y) > h + bias;
}

/** The sunlit share (0-1) of the air column from the ground to `top` px here. */
export function shadeLitShareAt(field, x, y, top) {
    if (!(top > 0)) return 1;
    return 1 - Math.min(1, shadeCeilingAt(field, x, y) / top);
}

/**
 * The field as a typed-texture upload (`uploadTypedTexture`: RG8, R ceiling,
 * G coverage) with the uniforms a shader needs to address it: a world point
 * maps to cell `floor((world - origin) / cell)`, and a ceiling byte is
 * `ceilingStep` world px of height.
 */
export function shadeFieldTexture(field) {
    if (!field) return null;
    return {
        width: field.cols,
        height: field.rows,
        // SD-2 — a field built for receivers uploads its four-byte texels.
        format: field.texels ? 'rgba8' : 'rg8',
        data: field.texels || field.data,
        revision: field.revision ?? null,
        origin: [field.originX, field.originY],
        cell: [field.cellW, field.cellH],
        ceilingStep: SHADE_CEILING_STEP,
    };
}

/**
 * The ground rule as RGBA cells: rows `[row0, row1)` of the field into `out`
 * (RGBA bytes, `field.cols` wide, row `row0` first): `rgb` at alpha 255 where
 * the ground is shaded, clear elsewhere. `water` (optional, Canvas only:
 * `{ fields, waterBit, coveredBit, share }`, the coast bake's resident fields
 * and its flag bits) holds a shaded cell over painted open water to `share`
 * of its alpha and drops every third row: the 2.9 rule at tick 0, which the
 * resident shader applies live through the `groundCast` record flag.
 */
export function paintShadeCells(field, out, rgb, row0 = 0, row1 = field.rows, water = null) {
    const { cols, data } = field;
    const lattice = water?.fields?.coastField ? water.fields : null;
    const waterAlpha = Math.round(255 * (water?.share ?? 1));
    for (let row = row0; row < row1; row++) {
        const wy = field.originY + row * field.cellH;
        const waterRow = lattice ? Math.floor((wy - lattice.y) / 2) : -1;
        const dropped = ((wy % 3) + 3) % 3 === 2;
        let o = (row - row0) * cols * 4;
        for (let col = 0; col < cols; col++, o += 4) {
            if (!(data[(row * cols + col) * 2 + 1] > shadeBayer(col, row) * 255)) {
                out[o + 3] = 0;
                continue;
            }
            let alpha = 255;
            if (waterRow >= 0 && waterRow < lattice.rows) {
                const waterCol = Math.floor((field.originX + col * field.cellW - lattice.x) / 2);
                if (waterCol >= 0 && waterCol < lattice.cols) {
                    const flags = lattice.coastField[(waterRow * lattice.cols + waterCol) * 2 + 1];
                    if ((flags & water.waterBit) && !(flags & water.coveredBit)) alpha = dropped ? 0 : waterAlpha;
                }
            }
            out[o] = rgb[0];
            out[o + 1] = rgb[1];
            out[o + 2] = rgb[2];
            out[o + 3] = alpha;
        }
    }
}

// ---------------------------------------------------------------- runtime

// Props the lathe leaves alone: the masonry is facets, bridge pieces are
// decks, seats and reeds are low or bow with the wind, and the Tavern's
// arcade is the Tavern's own front. (A prop in PROP_MASSING casts from its
// solids instead: the windmill, whose cache carries its turning sails.)
const LATHE_SKIP = /^(?:village\.wall\.|prop\.villageGate|bridge\.|calendar\.gate-garland|rest-seat\.|veg\.(?:cattail|reed)|tavern-arcade$)/;

/**
 * SD-2 — a prop that stands inside a mass of its own (PROP_MASSING): as a
 * receiver its foot is under its own solids, so it takes no shade from the
 * field (its record carries the V9 flag `sunSelf`).
 */
export function shadeSelfProp(id) {
    return Boolean(PROP_MASSING[id]);
}
const LATHE_MIN_HEIGHT = 24;
const PROFILE_CACHE_MAX = 512;
// The casters are re-read this often; a build runs in idle slices this long
// (an idle callback is forced after IDLE_TIMEOUT_MS on a busy page); the
// canvas is painted in bands of PAINT_ROWS; a field nobody asked for is
// dropped after RELEASE_AFTER_MS.
const SCENE_CHECK_MS = 500;
const IDLE_SLICE_MS = 4;
const IDLE_TIMEOUT_MS = 250;
const PAINT_ROWS = 128;
const RELEASE_AFTER_MS = 60_000;

const profiles = new Map();

function readAlpha(canvas) {
    const width = canvas?.width || 0;
    const height = canvas?.height || 0;
    if (!width || !height || typeof document === 'undefined') return null;
    let data;
    try {
        const probe = document.createElement('canvas');
        probe.width = width;
        probe.height = height;
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0);
        data = ctx.getImageData(0, 0, width, height).data;
        probe.width = 0;
        probe.height = 0;
    } catch {
        return null;
    }
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    return { alpha, width, height };
}

function profileFor(key, frame, sprite, tree) {
    let profile = profiles.get(key);
    if (profile !== undefined) return profile;
    const read = readAlpha(frame.canvas);
    const footCol = Math.round(sprite.x) - frame.x;
    profile = read
        ? latheProfile(read.alpha, read.width, read.height, Math.round(sprite.y) - frame.y, { axis: tree ? footCol : null, footCol })
        : null;
    if (profiles.size >= PROFILE_CACHE_MAX) profiles.clear();
    profiles.set(key, profile);
    return profile;
}

// Everything that casts, gathered from the renderer: landmark and masonry
// facets, and a lathe per tree and standing prop. `key` moves when a caster
// or its image does.
function gatherCasters(renderer) {
    const facets = [];
    const lathes = [];
    let key = `${renderer?.assets?.assetVersion ?? ''}`;
    for (const building of renderer?.buildingRenderer?.buildings || []) {
        const massing = LANDMARK_MASSING[building?.type];
        if (!massing?.solids?.length) continue;
        const position = building.position || building;
        key += `|${building.type}:${position.tileX ?? position.x},${position.tileY ?? position.y}`;
        facets.push(...massingFacets(massing, building, buildingCenterToWorld(building)));
    }
    const sprites = renderer?._staticPropSprites || [];
    const hasWall = sprites.some(sprite => sprite?.id?.startsWith?.('village.wall.'));
    const hasGate = sprites.some(sprite => sprite?.id === VILLAGE_GATE.id);
    if (hasWall || hasGate) {
        const runs = [];
        if (hasWall) {
            for (const route of VILLAGE_WALL_ROUTES) {
                for (let i = 0; i < route.points.length - 1; i++) {
                    const from = route.points[i];
                    const to = renderer._villageWallVisualEndTile?.(route, from, route.points[i + 1]) || route.points[i + 1];
                    runs.push({ from, to });
                    key += `|wall:${to.tileX.toFixed(2)}`;
                }
            }
        }
        key += `|gate:${hasGate}`;
        facets.push(...masonryFacets({ runs, gate: hasGate }));
    }
    const zoom = renderer?.camera?.zoom || 1;
    for (const sprite of sprites) {
        const id = sprite?.id || '';
        // A prop with a mass of its own (config PROP_MASSING: the windmill)
        // casts from its solids, in tiles from its foot.
        const massing = PROP_MASSING[id];
        if (massing) {
            const foot = { x: Math.round(sprite.x), y: Math.round(sprite.y) };
            key += `|${id}:${foot.x},${foot.y}`;
            facets.push(...massingFacets(massing, { width: 0, height: 0 }, foot));
            continue;
        }
        if (LATHE_SKIP.test(id) || !(-(sprite.bounds?.top || 0) >= LATHE_MIN_HEIGHT)) continue;
        const frame = sprite._getCachedCanvas?.(zoom);
        if (!frame?.canvas?.width) continue;
        const tree = id === 'fantasy.tree';
        // A tree's lean frames share one profile (the frame is the key's
        // tail); its season, stage and snow are in the key. A prop keeps the
        // profile it was first seen with: a repaint (the belfry's glass, a
        // dusting of snow) leaves its outline alone.
        const shape = tree && frame.textureKey
            ? frame.textureKey.slice(0, frame.textureKey.lastIndexOf('|'))
            : `${id}|${frame.canvas.width}x${frame.canvas.height}|${Math.round(sprite.x) - frame.x},${Math.round(sprite.y) - frame.y}`;
        const profile = profileFor(shape, frame, sprite, tree);
        if (!profile?.slabs.length) continue;
        const x = Math.round(sprite.x);
        const y = Math.round(sprite.y);
        lathes.push({ x, y, profile, key: shape, canopy: tree });
        key += `|${shape}@${x},${y}`;
    }
    return { facets, lathes, key };
}

function idle(callback) {
    if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
        return () => globalThis.cancelIdleCallback?.(handle);
    }
    const handle = setTimeout(() => callback(null), 32);
    return () => clearTimeout(handle);
}

function stateFor(renderer) {
    return renderer._shadeFieldState || (renderer._shadeFieldState = {
        // What the frame last asked for: `{ shade, water, waterRevision }`.
        want: null,
        unwantedAt: null,
        casters: null,
        castersAt: -Infinity,
        // What is up: `{ key, fieldKey, field, canvas, revision }`.
        ready: null,
        job: null,
        cancelIdle: null,
        // SD-2 — the view plane (`{ key, facet, bounds }`, good while the
        // casters hold) and the receivers' texels.
        view: null,
        texels: null,
        canvas: null,
        ctx: null,
        image: null,
        revision: 0,
    });
}

// The one canvas the ground rule is painted into (one RGBA texel per cell),
// and the ImageData the painter fills: a band on the resident backends (they
// read the canvas only at its new revision); the whole image on Canvas, which
// draws the canvas itself and so takes it in one put, never part-painted.
function ensureCanvas(state, field, atomic) {
    if (!state.canvas || state.canvas.width !== field.cols || state.canvas.height !== field.rows) {
        state.canvas = document.createElement('canvas');
        state.canvas.width = field.cols;
        state.canvas.height = field.rows;
        state.ctx = state.canvas.getContext('2d', { willReadFrequently: true });
        state.image = null;
    }
    const imageRows = atomic ? field.rows : PAINT_ROWS;
    if (state.image?.height !== imageRows) state.image = state.ctx.createImageData(field.cols, imageRows);
}

// What the frame last asked for against what is up: start the build that
// closes the gap, or only a repaint when the colour or the water moved.
function planJob(state, renderer) {
    const now = performance.now();
    if (!state.casters || now - state.castersAt >= SCENE_CHECK_MS) {
        state.casters = gatherCasters(renderer);
        state.castersAt = now;
    }
    const { shade, water, waterRevision, atomic, receivers } = state.want;
    const fieldKey = `${state.casters.key}#${shade.key}${receivers ? '#r' : ''}`;
    const key = `${fieldKey}#${shade.color.join(',')}#${waterRevision ?? ''}${atomic ? '#a' : ''}`;
    if (state.ready?.key === key || state.job?.key === key) return;
    const job = { key, fieldKey, rgb: shade.color, water, atomic, viewBuild: null, build: null, field: null, paintRow: -1 };
    if (state.ready?.fieldKey === fieldKey) {
        job.field = state.ready.field;
        job.paintRow = 0;
    } else {
        const rect = shadeFieldRect();
        const cells = rect.cols * rect.rows;
        // The build allocates its own field buffer (the one in use stays up
        // meanwhile), so no spare is held between rebuilds.
        const options = { rect, sweep: shade, facets: state.casters.facets, lathes: state.casters.lathes };
        if (receivers) {
            // The view plane holds while the casters do; the texels are
            // written in place (the GPU keeps its copy until the new revision).
            if (state.view?.key !== state.casters.key) {
                job.viewBuild = createShadeViewBuild({ rect, facets: state.casters.facets, facet: state.view?.facet });
                job.viewKey = state.casters.key;
                state.view = null;
            }
            if (!state.texels || state.texels.length !== cells * 4) state.texels = new Uint8Array(cells * 4);
            options.texels = state.texels;
        } else {
            state.view = null;
            state.texels = null;
        }
        job.options = options;
    }
    // A job the frame no longer wants is dropped where it stands.
    state.job = job;
}

// Advance the pending job by at most `budgetMs`: the view planes when the
// casters moved, the field, then its canvas band by band; the finished set
// replaces `state.ready` in one step.
function runJob(state, budgetMs) {
    const job = state.job;
    if (!job) return;
    const deadline = performance.now() + budgetMs;
    if (job.paintRow < 0) {
        if (job.viewBuild) {
            if (!job.viewBuild.step(budgetMs)) return;
            // The height plane only chose each cell's surface: it is let go.
            const { facet, bounds } = job.viewBuild.view;
            state.view = { key: job.viewKey, facet, bounds };
            job.viewBuild = null;
            if (performance.now() >= deadline) return;
        }
        if (!job.build) job.build = createShadeFieldBuild({ ...job.options, view: job.options.texels ? state.view : null });
        if (!job.build.step(Math.max(0, deadline - performance.now()))) return;
        job.field = job.build.field;
        job.paintRow = 0;
    }
    const field = job.field;
    ensureCanvas(state, field, job.atomic);
    while (job.paintRow < field.rows) {
        if (performance.now() >= deadline) return;
        const row1 = Math.min(field.rows, job.paintRow + PAINT_ROWS);
        if (job.atomic) {
            paintShadeCells(field, state.image.data.subarray(job.paintRow * field.cols * 4), job.rgb, job.paintRow, row1, job.water);
        } else {
            paintShadeCells(field, state.image.data, job.rgb, job.paintRow, row1, job.water);
            state.ctx.putImageData(state.image, 0, job.paintRow, 0, 0, field.cols, row1 - job.paintRow);
        }
        job.paintRow = row1;
    }
    if (job.atomic) state.ctx.putImageData(state.image, 0, 0);
    // The painter's ImageData is not kept between builds (the whole layer's
    // size on Canvas).
    state.image = null;
    state.revision++;
    if (job.build) field.revision = state.revision;
    state.ready = { key: job.key, fieldKey: job.fieldKey, field, canvas: state.canvas, revision: state.revision };
    state.job = null;
}

function schedule(state, renderer) {
    if (state.cancelIdle) return;
    state.cancelIdle = idle((deadline) => {
        state.cancelIdle = null;
        if (renderer._shadeFieldState !== state || !state.want) return;
        if (renderer._visibilityPaused || renderer._worldModeActive === false) {
            state.want = null;
            return;
        }
        const room = deadline && !deadline.didTimeout ? Math.min(IDLE_SLICE_MS, Math.max(1, deadline.timeRemaining() - 1)) : IDLE_SLICE_MS;
        planJob(state, renderer);
        runJob(state, room);
        if (state.job) schedule(state, renderer);
    });
}

function sameRgb(a, b) {
    return a === b || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
}

/**
 * The renderer's shade field for this frame's directional light, or null.
 * Call it once a frame. `shade` = `{ sx, sy, key, color }`
 * (`castLightingFor(...).shade`): the sweep, its bucket key and the cast
 * colour `[r, g, b]`; null when nothing throws shade (the field is dropped
 * after a minute of that). `water` (Canvas only, see `paintShadeCells`) bakes
 * the over-water rule into the canvas; `atomic` (the Canvas backend, which
 * draws the canvas itself) swaps the canvas in one put; `receivers` (SD-2)
 * also builds `field.texels`, the receivers' texture.
 *
 * Returns `{ field, canvas, revision }` or null: the field for the receiver
 * accessors, and the ground rule painted in the cast colour (one RGBA texel
 * per cell) with the revision an upload keys on. Nothing is built on the
 * caller's frame: a new sweep, a changed scene (checked twice a second) or a
 * new colour is built in idle slices of at most IDLE_SLICE_MS while the
 * previous field stays up, so the answer is null until the first build lands
 * and may trail the sun by a bucket for a moment (`_shadeFieldState.job` on
 * the renderer is the build in flight).
 */
export function shadeFieldFor(renderer, shade, { water = null, atomic = false, receivers = false } = {}) {
    if (!renderer || typeof document === 'undefined') return null;
    const now = performance.now();
    if (!shade) {
        const idleState = renderer._shadeFieldState;
        if (idleState) {
            idleState.want = null;
            if (idleState.unwantedAt == null) idleState.unwantedAt = now;
            else if (now - idleState.unwantedAt >= RELEASE_AFTER_MS) releaseShadeField(renderer);
        }
        return null;
    }
    const state = stateFor(renderer);
    state.unwantedAt = null;
    const want = state.want;
    const waterRevision = water?.fields ? water.fields.revision : null;
    if (!want || want.shade.key !== shade.key || !sameRgb(want.shade.color, shade.color) || want.waterRevision !== waterRevision
        || want.atomic !== atomic || want.receivers !== receivers
        || now - state.castersAt >= SCENE_CHECK_MS) {
        state.want = { shade, water, waterRevision, atomic, receivers };
        schedule(state, renderer);
    }
    return state.ready;
}

/**
 * One whole field for `shade`'s sweep from the renderer's casters, built at
 * once: a bake's shade (the frost), not a frame's. Null without a document.
 */
export function buildShadeFieldFor(renderer, shade) {
    if (!renderer || !shade || typeof document === 'undefined') return null;
    const casters = gatherCasters(renderer);
    return buildShadeField({ sweep: shade, facets: casters.facets, lathes: casters.lathes });
}

/** Drop the renderer's field, its buffers and its canvas. */
export function releaseShadeField(renderer) {
    const state = renderer?._shadeFieldState;
    if (!state) return;
    renderer._shadeFieldState = null;
    state.cancelIdle?.();
    if (state.canvas) {
        state.canvas.width = 0;
        state.canvas.height = 0;
    }
    // Both resident backends cache the uploaded array alongside the GPU texture.
    const world = renderer.gpuWorld;
    const receiver = world?._textureEntries?.get('field:shade');
    if (receiver) receiver.source = null;
    if (world?._sunShade) world._sunShade.texture = null;
}

export function shadeFieldBufferBytes(renderer) {
    const state = renderer._shadeFieldState;
    if (!state) return 0;
    const field = state.ready?.field;
    const planes = [field?.data, field?.texels, state.texels, state.view?.facet, state.image?.data,
        ...(state.job?.build?.backing || []), ...(state.job?.viewBuild?.backing || [])];
    const buffers = new Set(planes.map(plane => plane?.buffer).filter(Boolean));
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    return bytes;
}
