// Land Wang sheets as texture sources for the ground bake (GroundBake.js),
// and the procedural paving units (W1.1) the bake lays its stone with.
//
// Each sheet is a 4×4 grid of 32×32 cells indexed by the 4-bit edge mask
// (bit 0 = N, 1 = E, 2 = S, 3 = W); cell 0 is all lower class, cell 15 all
// upper class. The bake no longer stamps cells per tile (a square top-down
// cell stretched unrotated into the 64×32 diamond put its transition art on
// the diamond's vertices). It reads a full-class cell's luminance drawing
// and samples it in true 2:1 axonometric orientation: cell (u, v) maps to
// tile coordinates (tileX − 0.5 + u/32, tileY − 0.5 + v/32), so the cell's
// NW corner sits on the tile's top vertex and one cell texel is a 2×1 rhombus
// (two of the bake's 1×1 colour texels). Since W1.1 only the soft grounds
// (dirt, trodden earth, sand and marsh) read a drawing; laid stone is built
// from the unit lattice below instead.

const TILESET_GRID_COLS = 4;
const TILESET_CELL = 32;

const cache = new WeakMap();

// True once `readTerrainCellLuma(image, cell)` is cached (a free call).
export function hasTerrainCellLuma(image, cell) {
    return cache.get(image)?.has(cell) === true;
}

// Luminance of one cell as z-scores (mean 0, unit deviation), row-major
// 32×32. Colour is discarded: the bake re-tones the drawing onto the C1
// ground ramps. Cached per image.
export function readTerrainCellLuma(image, cell) {
    let perImage = cache.get(image);
    if (!perImage) {
        perImage = new Map();
        cache.set(image, perImage);
    }
    if (perImage.has(cell)) return perImage.get(cell);
    const canvas = document.createElement('canvas');
    canvas.width = TILESET_CELL;
    canvas.height = TILESET_CELL;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(
        image,
        (cell % TILESET_GRID_COLS) * TILESET_CELL,
        Math.floor(cell / TILESET_GRID_COLS) * TILESET_CELL,
        TILESET_CELL, TILESET_CELL,
        0, 0, TILESET_CELL, TILESET_CELL,
    );
    const data = ctx.getImageData(0, 0, TILESET_CELL, TILESET_CELL).data;
    const n = TILESET_CELL * TILESET_CELL;
    const luma = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        luma[i] = l;
        sum += l;
    }
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (luma[i] - mean) ** 2;
    const sd = Math.sqrt(Math.max(1, variance / n));
    for (let i = 0; i < n; i++) luma[i] = (luma[i] - mean) / sd;
    perImage.set(cell, luma);
    return luma;
}

// ---- W1.1 paving units ------------------------------------------------------
//
// The bake lays every civic surface as individual stones on one 2:1 lattice.
// It works in ROW UNITS: 1 row = 1/32 tile = one screen row = two screen
// columns along a 2:1 edge. A texel centred at world px (sx, sy) sits at
//   U = sx / 2 + sy  (= tileX · 32)      V = sy − sx / 2  (= tileY · 32)
// so a one-row band is exactly a 2 px × 1 px iso line and lip ends land on
// single world pixels (the 1×1 grain). A lattice `{ su, sv, bondU }` is the
// stone size along U (or a road's along-axis s) and V (across, t), and the
// running-bond offset of every other course.

// Deterministic integer hash in [0, 1) (shared with GroundBake.js).
export function latticeHash(x, y, s) {
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const STONE_LATTICES = Object.freeze({
    // Command Plaza running bond: 0.5 × 0.344 tile stones.
    plaza: Object.freeze({ su: 16, sv: 11, bondU: 8 }),
    // Command forecourt flags within two tiles of the keep.
    forecourt: Object.freeze({ su: 24, sv: 16, bondU: 12 }),
    // Avenue setts, laid in the road's own (s, t) frame.
    sett: Object.freeze({ su: 8, sv: 6, bondU: 4 }),
    // District flag yards (Archive, Tavern, Portal).
    flag: Object.freeze({ su: 20, sv: 14, bondU: 7 }),
});

// How an edge of a stone meets the key light (screen up-left).
export const STONE_FACE = Object.freeze({ BODY: 0, LIT: 1, LIT_HALF: 2, SHADE: 3, SHADE_HALF: 4 });

// The key light in tile (u, v) space: screen up-left is (−3, −1)/√10, so the
// NW (−u) edges take the full key, the NE (−v) edges a glancing third of it.
const KEY_U = -3 / Math.sqrt(10);
const KEY_V = -1 / Math.sqrt(10);

/** The face an edge with outward unit normal (nu, nv) shows to the key. */
export function stoneFace(nu, nv) {
    const f = nu * KEY_U + nv * KEY_V;
    if (f > 0.6) return STONE_FACE.LIT;
    if (f > 0.2) return STONE_FACE.LIT_HALF;
    if (f < -0.6) return STONE_FACE.SHADE;
    if (f < -0.2) return STONE_FACE.SHADE_HALF;
    return STONE_FACE.BODY;
}

/**
 * The lip faces of a lattice laid along the unit tile direction (du, dv):
 * s runs along it, t across (perpendicular (−dv, du)). `lowS` is the stone
 * edge at its smallest s (outward normal −dir), and so on. `specS` / `specT`
 * name the two most-lit edges (true = the low edge), whose corner takes the
 * specular texel.
 */
export function stoneFrame(du, dv) {
    const pu = -dv;
    const pv = du;
    const lowS = stoneFace(-du, -dv);
    const highS = stoneFace(du, dv);
    const lowT = stoneFace(-pu, -pv);
    const highT = stoneFace(pu, pv);
    const lit = (face) => (face === STONE_FACE.LIT ? 2 : face === STONE_FACE.LIT_HALF ? 1 : 0);
    return Object.freeze({
        du, dv, lowS, highS, lowT, highT,
        specS: lit(lowS) >= lit(highS),
        specT: lit(lowT) >= lit(highT),
        // A specular corner only where one of its edges takes the full key.
        spec: Math.max(lit(lowS), lit(highS)) === 2 || Math.max(lit(lowT), lit(highT)) === 2,
    });
}

/** The axis-aligned frame of the plaza bond and the flag yards (s = U, t = V). */
export const AXIS_FRAME = stoneFrame(1, 0);

/**
 * The stone under row-unit point (U, V) on lattice L, written into `out`:
 * `id` (32-bit hash of the stone), `lu` / `lv` (0 .. su / sv inside it),
 * `col`, `course`. Civic paving takes no course jitter.
 */
export function stoneAt(U, V, L, salt, out) {
    const course = Math.floor(V / L.sv);
    const u = U + (course & 1) * L.bondU;
    const col = Math.floor(u / L.su);
    out.lu = u - col * L.su;
    out.lv = V - course * L.sv;
    out.col = col;
    out.course = course;
    out.id = Math.floor(latticeHash(col, course, salt) * 4294967296) >>> 0;
    return out;
}

// Texel roles inside a stone (row units):
//   lu < 1 || lv < 1       mortar (each stone owns its low-s and low-t joints)
//   lu < 2                 the low-s lip      lv < 2        the low-t lip
//   lu >= su − 1           the high-s lip     lv >= sv − 1  the high-t lip
//   else                   body
export const STONE_ROLE = Object.freeze({ MORTAR: 0, CROSS: 1, LOW_S: 2, LOW_T: 3, HIGH_S: 4, HIGH_T: 5, BODY: 6 });

export function stoneRole(lu, lv, L) {
    if (lu < 1 || lv < 1) return lu < 1 && lv < 1 ? STONE_ROLE.CROSS : STONE_ROLE.MORTAR;
    if (lu < 2) return STONE_ROLE.LOW_S;
    if (lv < 2) return STONE_ROLE.LOW_T;
    if (lu >= L.su - 1) return STONE_ROLE.HIGH_S;
    if (lv >= L.sv - 1) return STONE_ROLE.HIGH_T;
    return STONE_ROLE.BODY;
}

/**
 * The ramp-stop offset a lip texel takes from its stone's body stop: +1 on a
 * lit edge, −1 on a shaded one; the glancing edges only on half the stones
 * (`litBit` / `shadeBit` from the stone's hash).
 */
export function lipOffset(role, frame, litBit, shadeBit) {
    const face = role === STONE_ROLE.LOW_S ? frame.lowS : role === STONE_ROLE.LOW_T ? frame.lowT
        : role === STONE_ROLE.HIGH_S ? frame.highS : role === STONE_ROLE.HIGH_T ? frame.highT : STONE_FACE.BODY;
    if (face === STONE_FACE.LIT) return 1;
    if (face === STONE_FACE.SHADE) return -1;
    if (face === STONE_FACE.LIT_HALF) return litBit ? 1 : 0;
    if (face === STONE_FACE.SHADE_HALF) return shadeBit ? -1 : 0;
    return 0;
}

/** True for the specular corner texel of a stone in `frame` (row units). */
export function specularCorner(lu, lv, L, frame) {
    if (!frame.spec) return false;
    const inS = frame.specS ? lu >= 1 && lu < 2 : lu >= L.su - 1;
    const inT = frame.specT ? lv >= 1 && lv < 2 : lv >= L.sv - 1;
    return inS && inT;
}

// ---- the octagonal fountain compass medallion (Command Plaza) --------------
//
// Ring radii in rows of the regular octagon norm r = max(|du|, |dv|,
// (|du| + |dv|) / √2) on the ground plane. One-row seams fall on exact
// texels: no dither, no noise.
//
// Carved flat, never a fence: in 2:1 iso the octagon's two sides normal to
// (1, −1) stand vertical on screen (the diagonal term rules and du · dv < 0),
// and a radial joint whose run has du · dv > 0 is steeper than the 2:1
// diagonal. On those, lit and shaded lip rows and dark seams would stack into
// upright 1 px bars, so the steep sides take no lips and soften their seams
// to plaza stop 1, the outer band (B and the border) beds in stop-1 mortar,
// and band B's sixteen radial joints keep only their shallow half, softened.
export const MEDALLION_RINGS = Object.freeze({
    fountain: 28.8, // r 0.90: under the fountain sprite, flat plaza[2]
    kerb: 33.6,     // r 1.05: the basin kerb course
    bandA: 44.8,    // r 1.40: the compass band (8 sectors, mid joint at 1.22)
    bandAJoint: 39.04,
    bandBSplit: 51.2, // r 1.60
    bandB: 57.6,    // r 1.80: 16 sectors x 2 courses
    border: 60.2,   // r 1.88: dark border course + mortar
});
export const MEDALLION_RAMP = Object.freeze({ PLAZA: 0, COOL: 1 });

const TAU = Math.PI * 2;

// The arc distance (rows) from the texel to the nearest of `n` radial joints
// (the first centred on θ = −π/n + offset) at euclidean radius `re`, and the
// sector index; written into `sectorOut`.
const sectorOut = { k: 0, arc: 0 };
function sectorAt(theta, n, offset, re) {
    const a = (theta + Math.PI / n + offset) / (TAU / n);
    const k = Math.floor(a);
    const frac = a - k;
    sectorOut.k = ((k % n) + n) % n;
    sectorOut.arc = Math.min(frac, 1 - frac) * (TAU / n) * re;
    return sectorOut;
}

/** True where the octagon's ring edges run steeper than 2:1 on screen. */
export function medallionSteepSide(du, dv) {
    const adu = du < 0 ? -du : du;
    const adv = dv < 0 ? -dv : dv;
    return (adu + adv) * Math.SQRT1_2 > Math.max(adu, adv) && du * dv < 0;
}

/**
 * The medallion texel at tile offset (du, dv) from its centre: the packed
 * `(ramp << 4) | stop` (MEDALLION_RAMP, ramp stop 0..4), or −1 outside it.
 * Mortar is plaza stop 0 (stop 1 on the steep sides and in the outer band).
 */
export function medallionAt(du, dv) {
    const adu = du < 0 ? -du : du;
    const adv = dv < 0 ? -dv : dv;
    const rr = 32 * Math.max(adu, adv, (adu + adv) * Math.SQRT1_2);
    const R = MEDALLION_RINGS;
    if (rr >= R.border) return -1;
    if (rr < R.fountain) return 2;
    const steep = medallionSteepSide(du, dv);
    const MORTAR = steep ? 1 : 0;
    const SOFT_MORTAR = 1;
    const nwHalf = du + dv < 0;
    const re = 32 * Math.hypot(du, dv);
    const theta = Math.atan2(dv, du);
    // A course's lips by the radial direction: a stone on the SE half shows
    // its inner edge to the key, one on the NW half its outer edge. None on
    // a steep side.
    const lip = (cin, cout) => {
        if (steep) return 0;
        if (rr < cin + 1) return nwHalf ? -1 : 1;
        if (rr >= cout - 1) return nwHalf ? 1 : -1;
        return 0;
    };
    if (rr < R.kerb) {
        if (rr < R.fountain + 1) return MORTAR;
        if (sectorAt(theta, 16, 0, re).arc < 0.5) return MORTAR;
        if (rr >= R.kerb - 1) return steep ? 3 : nwHalf ? 4 : 1;
        return 3;
    }
    if (rr < R.bandA) {
        // Bedding joint against the kerb, the mid-course joint and the eight
        // sector joints are mortar.
        if (rr < R.kerb + 1 || Math.abs(rr - R.bandAJoint) < 0.5) return MORTAR;
        const s = sectorAt(theta, 8, 0, re);
        if (s.arc < 0.5) return MORTAR;
        const inner = rr < R.bandAJoint;
        const offset = inner ? lip(R.kerb + 1, R.bandAJoint - 0.5) : lip(R.bandAJoint + 0.5, R.bandA);
        if ((s.k & 1) === 0) return (MEDALLION_RAMP.COOL << 4) | (2 + offset); // rays along the avenues
        return 2 + ((s.k >> 1) & 1) + offset;
    }
    if (rr < R.bandB) {
        const second = rr >= R.bandBSplit;
        const cin = second ? R.bandBSplit : R.bandA;
        const cout = second ? R.bandB : R.bandBSplit;
        if (rr < cin + 1) return SOFT_MORTAR;
        const s = sectorAt(theta, 16, second ? Math.PI / 16 : 0, re);
        // A radial joint running steeper than 2:1 (du · dv > 0) is dropped,
        // the shallow ones bed in soft mortar.
        if (s.arc < 0.5 && du * dv <= 0) return SOFT_MORTAR;
        const body = latticeHash(s.k, second ? 1 : 0, 2711) < 0.55 ? 2 : 3;
        return body + lip(cin + 1, cout);
    }
    return rr < R.border - 1 ? 1 : SOFT_MORTAR;
}
