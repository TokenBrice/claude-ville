// The village curtain wall and its lanterns (Waking Isle, WallArt).
//
// One coursed-stone family for the wall runs, the gatehouse and the sea
// tower: the landmarks' own masonry (`ART_RAMPS.ashlar`, sampled from the
// Command and Archive), a 1-px landmark ink silhouette, the upper-left sun key
// (the wall's face looks south-west, into the light: lit blocks; the end
// faces look south-east: shade; top planes brightest), stepped tones and
// ordered dither only, one texel per world px.
//
// `paintWallRun` rasterizes a run texel by texel on the 2:1 iso lattice: a
// screen column c and a point `d` px in front of (negative) or behind the
// base line at height `h` land on row `yb(c) - d - h`. Every face is a box
// face on that lattice, so courses, merlons, piers and the walk stay whole
// texels at every zoom. It returns the albedo and the 2.3 surface channel
// (R = height above the base line, B = face·64 + min(63, h/4): 0 up, 1 the
// SW face, 2 the SE face) of the same texels, so the resident light loop
// lands lamp pools on the face by its own base line (docs/material-channel-
// contract.md, occluder channel).
//
// Pure apart from `document.createElement('canvas')` in `paintWallRun`: the
// constants and the lantern record helper import in Node.
import { ART_RAMPS } from '../../config/artPalette.js';
import { normalizeLightSource } from './LightSourceRegistry.js';
import { wallWalkSnow } from './PropWinter.js';

// World px (= texels). Heights above the base line; `d` depths in iso px
// along the wall's normal (12 = 0.375 tile).
export const WALL_SPEC = Object.freeze({
    plinthTop: 10,         // battered footing: two 5-px courses, 2 px proud, a 2-row lit ledge
    plinthProject: 2,
    courseH: 6,            // body courses from h 10: joint row at each course's foot
    bodyFrom: 10,
    stringBottom: 42,      // string course h 42-46, 2 px proud, its lit lip rows above
    stringTop: 46,
    walk: 50,              // walk top = crenel sill
    depth: 12,             // wall thickness: the walk shows 12 rows
    merlonH: 10,
    merlonW: 11,           // ±1 per merlon
    crenelW: 7,
    merlonDepth: 4,
    pier: Object.freeze({ width: 14, project: 6, top: 36 }),
    // The corner turret a run may start at: 24 px along the wall, 8 px
    // proud of the face and 4 behind the walk, its platform at h 58 under
    // 8-px merlons on its front and SE edges.
    turret: Object.freeze({ width: 24, project: 8, back: 4, top: 58, merlonH: 8 }),
    lanternArmH: 34,       // a wall lantern's bracket arm, above the ground
    lanternReach: 5,       // the arm's reach out of the face (iso px)
    blockLen: Object.freeze([9, 17]),
});

const A = ART_RAMPS.ashlar;
const INK = 0, CREV = 1, DEEP = 2, SHADE = 3, SLIT = 4, MID = 5, LIT = 6, LITP = 7, HI = 8;
const GR = 9;              // grass ramp, 5 stops
const FO = GR + 5;         // foliage ramp, 5 stops
const SN = FO + 5;         // snow ramp, 5 stops
const CONTACT = SN + 5;    // the ground contact band (the props' contact-shadow colour)
const COLORS = [
    ...A, ...ART_RAMPS.grass, ...ART_RAMPS.foliage, ...ART_RAMPS.snow,
].map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
});
COLORS.push([16, 20, 12, 84]);

// Parts: which box a texel belongs to (outline and contour rules).
const P_BODY = 1, P_WALK = 2, P_MERLON = 3, P_PIER = 4, P_TRIM = 5, P_GREEN = 6, P_CONTACT = 7;
const FACE_UP = 0, FACE_SW = 1, FACE_SE = 2;
const EMPTY = 255;

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16;

function hash(a, b = 0, c = 0) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Smooth 1-D value noise along the wall (lattice `cell` px), 0..1.
function noise1(u, cell, salt) {
    const i = Math.floor(u / cell);
    const f = u / cell - i;
    const t = f * f * (3 - 2 * f);
    return hash(i, salt, 7) * (1 - t) + hash(i + 1, salt, 7) * t;
}

class Raster {
    constructor(x0, y0, w, h) {
        this.x0 = x0;
        this.y0 = y0;
        this.w = w;
        this.h = h;
        this.col = new Uint8Array(w * h).fill(EMPTY);
        this.hgt = new Uint8Array(w * h);
        this.face = new Uint8Array(w * h);
        this.part = new Uint8Array(w * h);
    }
    index(x, y) {
        const i = x - this.x0;
        const j = y - this.y0;
        return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
    }
    set(x, y, c, h, face, part) {
        const k = this.index(x, y);
        if (k < 0) return;
        this.col[k] = c;
        this.hgt[k] = Math.max(0, Math.min(255, Math.round(h)));
        this.face[k] = face;
        this.part[k] = part;
    }
    partAt(x, y) {
        const k = this.index(x, y);
        return k < 0 || this.col[k] === EMPTY ? 0 : this.part[k];
    }
    recolor(x, y, c) {
        const k = this.index(x, y);
        if (k >= 0 && this.col[k] !== EMPTY) this.col[k] = c;
    }
    colorAt(x, y) {
        const k = this.index(x, y);
        return k < 0 ? EMPTY : this.col[k];
    }
}

const clampA = (c) => Math.max(INK, Math.min(HI, c));

// Joint positions of one course (block lengths within WALL_SPEC.blockLen),
// as a per-column table over [from, to): -1 on a joint, else the block's
// index (>= 0; world columns run negative, so never the column itself).
// `salt` keys the course so neighbours stagger.
function courseBlocks(from, to, salt, [minLen, maxLen]) {
    const out = new Int32Array(to - from);
    let u = from - Math.floor(hash(salt, 3, 1) * maxLen);
    let block = 0;
    while (u < to) {
        const len = minLen + Math.floor(hash(salt, u, 2) * (maxLen - minLen + 1));
        for (let k = 0; k < len; k++) {
            const x = u + k;
            if (x >= from && x < to) out[x - from] = k === 0 ? -1 : block;
        }
        u += len;
        block++;
    }
    return out;
}

// One box on the lattice: u in [u0, u1), d in [d0, d1), h in [h0, h1).
// Faces are painted top, then the SE face at u1, then the SW face at d0;
// `shade(face, u, d, h, c, y)` returns [colour, part] or null (leave).
function paintBox(R, yb, box, shade) {
    const { u0, u1, d0, d1, h0, h1 } = box;
    if (box.top !== false) {
        for (let c = u0 + d0; c <= u1 + d1 - 1; c++) {
            const dLo = Math.max(d0, c - u1);
            const dHi = Math.min(d1 - 1, c - u0);
            for (let d = dLo; d <= dHi; d++) {
                const y = yb(c) - d - h1;
                const out = shade(FACE_UP, c - d, d, h1, c, y);
                if (out) R.set(c, y, out[0], h1, FACE_UP, out[1]);
            }
        }
    }
    if (box.right !== false) {
        for (let d = d0; d < d1; d++) {
            const c = u1 + d;
            for (let h = h0; h < h1; h++) {
                const y = yb(c) - d - h;
                const out = shade(FACE_SE, u1, d, h, c, y);
                if (out) R.set(c, y, out[0], h, FACE_SE, out[1]);
            }
        }
    }
    if (box.front !== false) {
        for (let u = u0; u < u1; u++) {
            const c = u + d0;
            for (let h = h0; h < h1; h++) {
                const y = yb(c) - d0 - h;
                const out = shade(FACE_SW, u, d0, h, c, y);
                if (out) R.set(c, y, out[0], h, FACE_SW, out[1]);
            }
        }
    }
}

/**
 * The run's layout: merlons, piers (with their lantern flags), arrow loops,
 * scuppers, ivy curtains and weather streaks, all hash-seeded by `seed`, so
 * the same run always paints the same wall and the lantern props can stand
 * on the same piers. `startTurret`: the run begins at a square corner
 * turret (the west run on the island's tip), `WALL_SPEC.turret` wide.
 */
export function wallRunLayout({ x1, x2, seed = 0, piers = false, ivy = false, startTurret = false }) {
    const S = WALL_SPEC;
    const length = x2 - x1;
    const layout = { merlons: [], piers: [], loops: [], scuppers: [], ivy: [], streaks: new Map(), turret: null };
    if (startTurret) layout.turret = { u0: x1, u1: x1 + S.turret.width };
    const from = layout.turret ? layout.turret.u1 : x1;
    // Piers: irregular 92-150 px apart, never within 34 px of an end.
    if (piers && length >= 60) {
        let p = from + 34 + Math.floor(hash(seed, 21) * 36);
        let n = 0;
        while (p + S.pier.width < x2 - 34) {
            layout.piers.push({ u0: p, u1: p + S.pier.width, n, lantern: false });
            p += 92 + Math.floor(hash(seed, n, 22) * 58);
            n++;
        }
        // Lanterns on some piers: one in two or three, never neighbours
        // closer than 170 px, always at least one on a long run.
        let last = -Infinity;
        for (const pier of layout.piers) {
            if (pier.u0 - last < 170) continue;
            if (hash(seed, pier.n, 23) < 0.62 || pier.u0 - last > 320) {
                pier.lantern = true;
                last = pier.u0;
            }
        }
        if (!layout.piers.some((pier) => pier.lantern) && layout.piers.length) layout.piers[layout.piers.length >> 1].lantern = true;
    }
    // Merlons: 11 ± 1 wide, 7 apart, flush with both ends; over each pier
    // the parapet rises into one crown block 3 px taller (the pier's
    // lookout), so the crest reads in phrases, not a metronome.
    let u = layout.turret ? from + S.crenelW : x1;
    let k = 0;
    let nextPier = 0;
    while (u < x2 - 4) {
        const pier = layout.piers[nextPier];
        const w = S.merlonW + (hash(seed, k, 11) < 0.25 ? -1 : hash(seed, k, 12) < 0.2 ? 1 : 0);
        if (pier && u + w + S.crenelW > pier.u0 - 3) {
            layout.merlons.push({ u0: pier.u0 - 3, u1: pier.u1 + 3, top: S.walk + S.merlonH + 3, chip: false, crown: true, k });
            u = pier.u1 + 3 + S.crenelW;
            nextPier++;
            k++;
            continue;
        }
        const m1 = Math.min(x2, u + w);
        const wear = hash(seed, k, 13);
        layout.merlons.push({ u0: u, u1: m1, top: S.walk + S.merlonH - (wear < 0.12 ? 2 : wear < 0.3 ? 1 : 0), chip: wear > 0.86, crown: false, k });
        u = m1 + S.crenelW;
        k++;
    }
    if (length < 60) return layout;
    const clearOfPiers = (a, b, pad) => a > from + pad && layout.piers.every((pier) => b < pier.u0 - pad || a > pier.u1 + pad + 8);
    // Arrow loops: one every ~150 px, skipped where a pier stands.
    for (let a = from + 48 + Math.floor(hash(seed, 31) * 40); a < x2 - 30; a += 120 + Math.floor(hash(seed, a, 32) * 90)) {
        if (clearOfPiers(a - 2, a + 3, 10)) layout.loops.push(a);
    }
    // Scuppers through the string course, each with its long stain.
    for (let a = from + 70 + Math.floor(hash(seed, 41) * 60); a < x2 - 30; a += 170 + Math.floor(hash(seed, a, 42) * 110)) {
        if (clearOfPiers(a - 2, a + 3, 6) && layout.loops.every((l) => Math.abs(l - a) > 14)) layout.scuppers.push(a);
    }
    // Ivy: one or two curtains on a long run, clear of piers and loops.
    if (ivy) {
        const count = length > 300 ? 2 : 1;
        for (let i = 0; i < count; i++) {
            const w = 22 + Math.floor(hash(seed, i, 51) * 18);
            let a = x1 + Math.floor((i + 0.25 + hash(seed, i, 52) * 0.5) / count * (length - w));
            for (let tries = 0; tries < 6 && !clearOfPiers(a, a + w, 4); tries++) a += 23;
            if (clearOfPiers(a, a + w, 4)) layout.ivy.push({ u0: a, u1: a + w, len: 22 + Math.floor(hash(seed, i, 53) * 14), salt: seed * 7 + i });
        }
    }
    // Rain stains under about half the crenels (the walk drains there).
    for (let i = 0; i < layout.merlons.length - 1; i++) {
        const gap = layout.merlons[i].u1 + Math.floor(S.crenelW / 2);
        if (hash(seed, i, 61) < 0.5) layout.streaks.set(gap, 6 + Math.floor(hash(seed, i, 62) * 18));
    }
    for (const a of layout.scuppers) {
        layout.streaks.set(a, 30);
        layout.streaks.set(a + 1, 22);
    }
    return layout;
}

/**
 * Rasterize one wall run from (x1, y1) to (x2, y2) (world px, the base
 * line; the run climbs the lattice at the line's slope). Options: `seed`,
 * `piers`/`ivy` (full runs; the gatehouse stubs take neither), `endFace`
 * (paint the SE end face), `snowBucket` (C-W2 bucket 0-4, PropWinter),
 * `openStart`/`openEnd`: the run continues in a neighbouring sprite there
 * (a gatehouse stub), so it paints on past that end and is cut on the
 * vertical through it: no end face, no ink, and the two images meet on one
 * column with their courses on the same lattice rows.
 * Returns `{ width, height, left, top, albedo, surface, layout }`: RGBA
 * bytes of the albedo and the 2.3 surface channel, in world px at
 * (left, top). Pure (runs in Node).
 */
export function rasterWallRun({ x1, y1, x2, y2, seed = 0, piers = false, ivy = false, endFace = true, snowBucket = 0, openStart = false, openEnd = false, startTurret = false }) {
    if (x2 < x1) [x1, y1, x2, y2] = [x2, y2, x1, y1];
    x1 = Math.round(x1); y1 = Math.round(y1); x2 = Math.round(x2); y2 = Math.round(y2);
    const S = WALL_SPEC;
    const slope = (y2 - y1) / Math.max(1, x2 - x1);
    const yb = (c) => y1 + Math.floor((c - x1) * slope + 0.5);
    const layout = wallRunLayout({ x1, x2, seed, piers, ivy, startTurret });
    const snow = Math.max(0, Math.min(4, snowBucket | 0));
    const EXT = 24;
    const px1 = openStart ? x1 - EXT : x1;
    const px2 = openEnd ? x2 + EXT : x2;
    const showEnd = endFace && !openEnd;
    const left = px1 - 14;
    const right = px2 + S.depth + 6;
    const rise = startTurret ? S.turret.top + S.turret.merlonH + S.depth + S.turret.back : S.walk + S.merlonH + 3 + S.depth;
    const top = Math.min(yb(left), yb(right)) - rise - 6;
    const bottom = Math.max(yb(left), yb(right)) + 14;
    const R = new Raster(left, top, right - left, bottom - top);

    const tableFrom = x1 - 40;
    const tableTo = x2 + 40;
    const bodyCourses = [];
    for (let k = 0; k * S.courseH + S.bodyFrom < S.walk; k++) {
        bodyCourses.push(courseBlocks(tableFrom, tableTo, seed * 131 + k, S.blockLen));
    }
    const plinthCourses = [0, 1].map((k) => courseBlocks(tableFrom, tableTo, seed * 197 + k + 50, [16, 26]));
    const stringBlocks = courseBlocks(tableFrom, tableTo, seed * 17 + 90, [18, 30]);
    const walkSlabs = courseBlocks(tableFrom, tableTo, seed * 23 + 91, [12, 20]);
    const blockAt = (table, u) => table[Math.max(0, Math.min(table.length - 1, u - tableFrom))];
    const pierShadow = (u) => {
        for (const pier of layout.piers) {
            const off = u - pier.u1;
            if (off >= 0 && off < S.pier.project + 1) return off;
        }
        return -1;
    };
    const tone = (base, delta) => clampA(base + delta);

    // --- the curtain: SW face, walk top, SE end face -------------------
    paintBox(R, yb, { u0: px1, u1: px2, d0: 0, d1: S.depth, h0: 0, h1: S.walk, right: showEnd }, (face, u, d, h, c, y) => {
        if (face === FACE_UP) {
            // The walk: paving slabs, a joint across at d 6, merlon shadow
            // falling along +u on its front half, snow from the lip back.
            const walkSnow = wallWalkSnow(snow);
            if (walkSnow && d < Math.round(S.depth * walkSnow.share)) {
                const lip = d === 0;
                return [SN + (lip ? 4 : bayer(c, y) < 0.25 ? 4 : 3), P_WALK];
            }
            const slab = blockAt(walkSlabs, u);
            if (slab < 0 || d === 6) return [MID, P_WALK];
            let t = hash(seed, slab, d < 6 ? 71 : 72) < 0.3 ? LIT : LITP;
            for (const m of layout.merlons) {
                const off = u - m.u1;
                if (off >= 0 && off < 6 && d < 4 + (off < 3 ? 1 : 0)) { t = MID; break; }
            }
            if (d === S.depth - 1) t = HI;
            return [t, P_WALK];
        }
        if (face === FACE_SE) {
            // SE faces: the shade side, one stop under the landmarks' shade
            // since the curtain's lit face sits a stop under theirs.
            if (h >= S.walk - 1) return [SHADE, P_BODY];
            const rel = h - S.bodyFrom;
            if (h < S.bodyFrom) return [(h % 5 === 0) ? CREV : DEEP, P_BODY];
            return [rel % S.courseH === 0 ? CREV : (hash(seed, d >> 2, (rel / S.courseH) | 0) < 0.3 ? SHADE : DEEP), P_BODY];
        }
        // SW face: the lit face. Value structure top to bottom: the parapet
        // band, the string course's shadow band, sunlit courses, a damp
        // lower course over the dark plinth.
        if (h < S.bodyFrom) return [SLIT, P_BODY];
        if (h >= S.walk - 2) return [h === S.walk - 1 ? LIT : MID, P_BODY];
        const rel = h - S.bodyFrom;
        const k = Math.floor(rel / S.courseH);
        const row = rel % S.courseH;
        const table = bodyCourses[Math.min(bodyCourses.length - 1, k)];
        const block = blockAt(table, u);
        const shadowOff = pierShadow(u);
        const inPierShadow = shadowOff >= 0 && h < S.pier.top + 2 - (shadowOff >> 1);
        let t;
        if (h >= S.stringBottom - 4 && h <= S.stringBottom - 3) {
            // The 2-px proud string course throws a 2-row band.
            t = h === S.stringBottom - 3 ? DEEP : SHADE;
        } else if (row === 0 || block < 0) {
            t = SHADE;
        } else {
            // Weathered ashlar: mostly the mid stop, lit and dark stones
            // scattered, so the face sits under the landmarks' lit walls
            // and the island's content keeps the eye.
            const r = hash(seed * 3 + k, block, 5);
            // Along the run, stretches of older, darker stone and of newer,
            // paler repair (a noise over ~70 px), so a long wall never
            // reads as one tile repeated.
            const age = noise1(u, 70, seed + 11);
            const dark = age > 0.68 ? 0.34 : 0.16;
            const light = age < 0.3 ? 0.62 : 0.78;
            t = r < dark ? SLIT : r > light ? LIT : MID;
            // Upper-left bevel: half the blocks catch light on their top row.
            if (row === S.courseH - 1 && blockAt(table, u + 1) >= 0 && hash(block, k, seed + 6) < 0.55) t += 1;
            // Damp foot: the lowest course a stop down.
            if (k === 0) t -= 1;
            // Weather: stains under the crenels and scuppers, rare pits.
            const streak = layout.streaks.get(u);
            if (streak && h >= S.stringBottom - 4 - streak) t -= 1;
            if (hash(u, h, seed + 9) < 0.006) t -= 2;
        }
        // A pier's cast shadow on the face to its right, hard-edged.
        if (inPierShadow) t -= 2;
        return [tone(t, 0), P_BODY];
    });

    // --- piers: quoined buttresses with a stepped weathering cap ---------
    for (const pier of layout.piers) {
        const { u0, u1 } = pier;
        const pd = -S.pier.project;
        paintBox(R, yb, { u0, u1, d0: pd, d1: 0, h0: 0, h1: S.pier.top }, (face, u, d, h) => {
            const row = (h + 2) % S.courseH;
            const k = Math.floor((h + 2) / S.courseH);
            if (face === FACE_SE) return [row === 0 ? CREV : (d === -1 ? CREV : DEEP), P_PIER];
            if (face === FACE_UP) return [LITP, P_PIER];
            // Quoins: long and short stones alternate, the pier a touch
            // brighter than the curtain it stands proud of.
            const split = u0 + (k % 2 ? 5 : 9);
            if (row === 0 || u === split) return [SHADE, P_PIER];
            let t = hash(seed, pier.n * 17 + k, u < split ? 81 : 82) < 0.4 ? MID : LIT;
            if (row === S.courseH - 1 || u === u0) t += 1;
            if (h < 8) t -= 1;
            return [tone(t, 0), P_PIER];
        });
        const capFace = (hTop) => (face, u, d, h) => {
            if (face === FACE_UP) return [snow ? SN + (bayer(u, d) < 0.3 ? 4 : 3) : HI, P_PIER];
            if (face === FACE_SE) return [SHADE, P_PIER];
            return [h === hTop - 1 ? HI : LITP, P_PIER];
        };
        paintBox(R, yb, { u0, u1, d0: pd + 1, d1: 0, h0: S.pier.top, h1: S.pier.top + 3 }, capFace(S.pier.top + 3));
        paintBox(R, yb, { u0, u1, d0: pd + 3, d1: 0, h0: S.pier.top + 3, h1: S.stringBottom }, capFace(S.stringBottom));
    }

    // --- string course: a proud band with a lit lip under the walk ------
    paintBox(R, yb, { u0: px1, u1: px2, d0: -2, d1: 0, h0: S.stringBottom, h1: S.stringTop, right: showEnd }, (face, u, d, h, c, y) => {
        if (face === FACE_UP) {
            if (snow >= 2) return [SN + (d === -2 ? 4 : 3), P_TRIM];
            return [d === -2 ? HI : LITP, P_TRIM];
        }
        if (face === FACE_SE) return [DEEP, P_TRIM];
        if (layout.scuppers.includes(u) || layout.scuppers.includes(u - 1)) return [h === S.stringBottom ? CREV : DEEP, P_TRIM];
        if (blockAt(stringBlocks, u) < 0) return [SLIT, P_TRIM];
        if (h === S.stringTop - 1) return [HI, P_TRIM];
        if (h === S.stringBottom) return [MID, P_TRIM];
        return [hash(u >> 3, seed, 93) < 0.25 ? MID : LIT, P_TRIM];
    });

    // --- merlons ---------------------------------------------------------
    for (const m of layout.merlons) {
        paintBox(R, yb, { u0: m.u0, u1: m.u1, d0: 0, d1: S.merlonDepth, h0: S.walk, h1: m.top }, (face, u, d, h, c, y) => {
            if (face === FACE_UP) {
                if (m.chip && u === m.u0 && d >= S.merlonDepth - 2) return null;
                if (snow) return [SN + (d === 0 || bayer(c, y) < 0.3 ? 4 : 3), P_MERLON];
                return [d === 0 ? HI : LITP, P_MERLON];
            }
            if (face === FACE_SE) return [h === m.top - 1 ? SHADE : h === S.walk ? CREV : (d === S.merlonDepth - 1 ? CREV : DEEP), P_MERLON];
            if (m.chip && u === m.u0 && h >= m.top - 2) return null;
            if (h === S.walk) return [SHADE, P_MERLON];
            const mid = m.u0 + Math.floor((m.u1 - m.u0) / 2) + (m.k % 2 ? -1 : 1);
            if ((h === S.walk + 5 || (m.crown && h === S.walk + 10)) && u !== m.u0) return [SHADE, P_MERLON];
            if (h < S.walk + 5 && u === mid) return [SHADE, P_MERLON];
            if (m.crown && h > S.walk + 5 && h < S.walk + 10 && (u === m.u0 + 5 || u === m.u1 - 6)) return [SHADE, P_MERLON];
            if (snow >= 3 && h === m.top - 1 && bayer(c, y) < 0.5) return [SN + 2, P_MERLON];
            let t = hash(seed, m.k, h < S.walk + 5 ? 101 : 102) < 0.3 ? LIT : MID;
            if (h === m.top - 1 || h === S.walk + 4) t += 1;
            if (u === m.u1 - 1) t -= 1;
            return [tone(t, 0), P_MERLON];
        });
    }

    // --- battered plinth -------------------------------------------------
    // The footing reads a stop darker than the sunlit face (damp, in the
    // grass's bounce), its ledge lit, moss spilling over the ledge in beds.
    const moss = (u) => noise1(u, 9, seed + 3);
    paintBox(R, yb, { u0: px1, u1: px2, d0: -S.plinthProject, d1: 0, h0: 0, h1: S.plinthTop, right: showEnd }, (face, u, d, h) => {
        const m = moss(u);
        if (face === FACE_UP) {
            if (snow >= 2) return [SN + (d === -2 ? 4 : 3), P_TRIM];
            if (m > 0.6) return [d === -2 ? GR + 2 : GR + 1, P_GREEN];
            return [d === -2 ? HI : LITP, P_TRIM];
        }
        if (face === FACE_SE) return [h === 5 ? CREV : DEEP, P_TRIM];
        const k = h < 5 ? 0 : 1;
        const row = h % 5;
        if (h === 0) return [DEEP, P_TRIM];
        // Moss over the ledge's edge, a row or three down the face.
        if (m > 0.64 && k === 1 && row >= 4 - Math.floor((m - 0.64) * 12)) return [row === 4 ? GR + 1 : FO + 2, P_GREEN];
        const block = blockAt(plinthCourses[k], u);
        if (row === 0 || block < 0) return [DEEP, P_TRIM];
        let t = hash(seed, block, 111 + k) < 0.35 ? SHADE : SLIT;
        if (row === 4) t += 1;
        if (k === 0) t -= 1;
        return [tone(t, 0), P_TRIM];
    });

    // Pier feet: a proud block at each pier's base, its ledge lit.
    for (const pier of layout.piers) {
        paintBox(R, yb, { u0: pier.u0 - 1, u1: pier.u1 + 1, d0: -S.pier.project - 2, d1: -S.plinthProject, h0: 0, h1: 7 }, (face, u, d, h) => {
            if (face === FACE_UP) return [snow >= 2 ? SN + 3 : (moss(u + 5) > 0.55 ? GR + 1 : HI), snow >= 2 ? P_TRIM : P_PIER];
            if (face === FACE_SE) return [h === 0 ? CREV : DEEP, P_PIER];
            if (h === 0) return [DEEP, P_PIER];
            if (h === 3 && u !== pier.u0 - 1) return [SHADE, P_PIER];
            return [h === 6 ? LIT : h > 3 ? MID : SLIT, P_PIER];
        });
    }

    // --- the corner turret: a square tower the run starts from, 8 px
    // proud, its platform crenellated on the front and SE edges. Its SE
    // face shows only where it stands clear of the curtain (in front of the
    // face, or above the walk).
    if (layout.turret) {
        const T = S.turret;
        const u0 = layout.turret.u0;
        const u1 = layout.turret.u1;
        const d0 = -T.project;
        const d1 = S.depth + T.back;
        const hidden = (d, h, plane) => d >= plane && h < S.walk;
        paintBox(R, yb, { u0, u1, d0: d0 - 2, d1, h0: 0, h1: S.plinthTop }, (face, u, d, h) => {
            if (face === FACE_UP) return d < d0 ? [snow >= 2 ? SN + 3 : HI, P_TRIM] : null;
            if (face === FACE_SE) return hidden(d, h, -2) ? null : [h === 5 ? CREV : DEEP, P_TRIM];
            if (h === 0) return [DEEP, P_TRIM];
            return [h % 5 === 0 || (u - u0 + (h < 5 ? 0 : 7)) % 13 === 0 ? DEEP : h % 5 === 4 ? SLIT : SHADE, P_TRIM];
        });
        paintBox(R, yb, { u0, u1, d0, d1, h0: 0, h1: T.top }, (face, u, d, h) => {
            const k = Math.floor((h - S.bodyFrom) / S.courseH);
            const row = (h - S.bodyFrom) % S.courseH;
            if (face === FACE_UP) {
                if (u >= u0 + 8 && u < u0 + 13 && d >= 5 && d < 9) return [CREV, P_PIER];
                return [snow ? SN + 3 : (d === d0 ? HI : LITP), P_PIER];
            }
            if (face === FACE_SE) {
                if (hidden(d, h, 0)) return null;
                if (h === T.top - 1) return [SHADE, P_PIER];
                return [row === 0 ? CREV : (d >= d1 - 2 ? CREV : DEEP), P_PIER];
            }
            if (row === 0) return [SHADE, P_PIER];
            const splits = k % 2 ? [4, 12, 20] : [8, 16];
            const rel = u - u0;
            if (splits.includes(rel)) return [SHADE, P_PIER];
            const r = hash(seed, k * 5 + splits.filter((s) => s < rel).length, 121);
            let t = r < 0.2 ? SLIT : r > 0.7 ? LIT : MID;
            if (row === S.courseH - 1 && hash(k, rel >> 2, seed + 122) < 0.6) t += 1;
            if (rel === 0) t += 1;
            if (h >= S.stringBottom - 4 && h <= S.stringBottom - 3) t = h === S.stringBottom - 3 ? DEEP : SHADE;
            return [tone(t, 0), P_PIER];
        });
        paintBox(R, yb, { u0, u1: u1 + 2, d0: d0 - 2, d1, h0: S.stringBottom, h1: S.stringTop }, (face, u, d, h) => {
            if (face === FACE_UP) return (d < d0 || (u >= u1 && d < -2)) ? [snow >= 2 ? SN + 3 : (d === d0 - 2 ? HI : LITP), P_TRIM] : null;
            if (face === FACE_SE) return hidden(d, h, -2) ? null : [DEEP, P_TRIM];
            return [h === S.stringTop - 1 ? HI : h === S.stringBottom ? MID : LIT, P_TRIM];
        });
        const merlon = (box) => paintBox(R, yb, box, (face, u, d, h) => {
            if (face === FACE_UP) return [snow ? SN + (d === box.d0 ? 4 : 3) : (d === box.d0 ? HI : LITP), P_MERLON];
            if (face === FACE_SE) return [h === box.h1 - 1 ? SHADE : DEEP, P_MERLON];
            if (h === box.h0) return [SHADE, P_MERLON];
            return [h === box.h1 - 1 ? LITP : (u === box.u0 ? LIT : MID), P_MERLON];
        });
        const top = T.top;
        for (const [a, b] of [[d0 + 15, d1], [d0 + 7, d0 + 12]]) merlon({ u0: u1 - 4, u1, d0: a, d1: b, h0: top, h1: top + T.merlonH });
        for (const [a, b] of [[0, 6], [9, 15], [18, 24]]) merlon({ u0: u0 + a, u1: u0 + b, d0, d1: d0 + 4, h0: top, h1: top + T.merlonH });
        // A cross loop on its face.
        const lc = u0 + 11 + d0;
        for (let h = 24; h <= 36; h++) {
            R.recolor(lc, yb(lc) - d0 - h, CREV);
            R.recolor(lc + 1, yb(lc + 1) - d0 - h, h > 34 ? CREV : DEEP);
        }
        for (const du of [-2, -1, 2, 3]) R.recolor(lc + du, yb(lc + du) - d0 - 31, du < 0 ? CREV : DEEP);
        for (let du = -1; du <= 2; du++) R.recolor(lc + du, yb(lc + du) - d0 - 23, HI);
    }

    // --- details on the face ----------------------------------------------
    const faceY = (u, h) => yb(u) - h;
    // Arrow loops: a 2-px slit with a lit sill and a lintel.
    for (const a of layout.loops) {
        for (let h = 23; h <= 31; h++) {
            R.recolor(a, faceY(a, h), CREV);
            R.recolor(a + 1, faceY(a + 1, h), h > 29 ? CREV : DEEP);
        }
        for (let u = a - 1; u <= a + 2; u++) {
            R.recolor(u, faceY(u, 22), HI);
            R.recolor(u, faceY(u, 32), MID);
        }
    }
    // Scupper spouts: a stone lip proud of the string course.
    for (const a of layout.scuppers) {
        const y = faceY(a, S.stringBottom) + 2;
        R.set(a - 1, y, HI, S.stringBottom, FACE_SW, P_TRIM);
        R.set(a, y, LITP, S.stringBottom, FACE_SW, P_TRIM);
        R.set(a - 1, y + 1, DEEP, S.stringBottom - 1, FACE_SW, P_TRIM);
        R.set(a, y + 1, CREV, S.stringBottom - 1, FACE_SW, P_TRIM);
    }
    // Soot above each lantern: the bracket's lamp has burned there for years.
    for (const pier of layout.piers) {
        if (!pier.lantern) continue;
        const cu = pier.u0 + Math.floor(S.pier.width / 2);
        for (let h = S.lanternArmH + 1; h <= S.pier.top - 1; h++) {
            for (let du = -2; du <= 2; du++) {
                const u = cu + du;
                const x = u - S.pier.project;
                const y = yb(x) + S.pier.project - h;
                const w = 1 - Math.abs(du) / 3 - (h - S.lanternArmH) / 5;
                if (bayer(x, y) < w) R.recolor(x, y, clampA(R.colorAt(x, y) - 1));
            }
        }
    }

    // Moss beds along the foot: continuous, 1-3 rows, a lit crown.
    for (let u = px1; u < px2; u++) {
        const m = noise1(u, 7, seed + 5);
        if (m < 0.55) continue;
        const c = u - S.plinthProject;
        const tall = Math.min(3, 1 + Math.floor((m - 0.55) * 8));
        for (let h = 0; h < tall; h++) {
            const y = yb(c) + S.plinthProject - h;
            const crown = h === tall - 1;
            R.set(c, y, crown ? (noise1(u, 3, seed + 6) > 0.5 ? GR + 2 : GR + 1) : FO + 1, h, FACE_SW, P_GREEN);
        }
        if (hash(u, seed, 29) < 0.14) {
            const y = yb(c) + S.plinthProject - tall;
            R.set(c, y, GR + 3, tall, FACE_SW, P_GREEN);
        }
    }

    // Ivy curtains draping from the parapet: one leaf mass per curtain, its
    // lower edge ragged (a per-column length on noise), its body 2x2 leaves
    // in three foliage stops, each leaf lit on its top-left texel, holes
    // opening toward the fringe, a few bare stems below; every leaf throws
    // a 1-texel shadow down-right onto the stone behind it.
    for (const curtain of layout.ivy) {
        const span = curtain.u1 - curtain.u0;
        const leaves = new Map();
        for (let u = curtain.u0; u < curtain.u1; u++) {
            const f = (u - curtain.u0 + 0.5) / span * 2 - 1;
            const len = Math.round(curtain.len * Math.sqrt(Math.max(0, 1 - f * f)) * (0.55 + 0.45 * noise1(u, 3, curtain.salt)));
            for (let k = 0; k < len; k++) {
                const h = S.walk - 2 - k;
                if (h < S.plinthTop + 2) break;
                const cx = Math.floor(u / 2);
                const cy = Math.floor(h / 2);
                const fringe = k / Math.max(1, len);
                if (hash(cx, cy, curtain.salt) < 0.06 + 0.35 * fringe * fringe + 0.25 * f * f) continue;
                const r = hash(cx, cy, curtain.salt + 1);
                let t = r < 0.28 ? FO + 3 : r < 0.74 ? FO + 2 : FO + 1;
                const lu = u - cx * 2;
                const lh = h - cy * 2;
                if (lu === 0 && lh === 1) t += 1;
                else if (lu === 1 && lh === 0) t -= 1;
                leaves.set(`${u},${h}`, Math.max(FO, Math.min(FO + 4, t)));
            }
            if (hash(u, curtain.salt, 5) < 0.2) {
                const run = 2 + Math.floor(hash(u, 7, curtain.salt) * 5);
                for (let k = len; k < len + run; k++) leaves.set(`${u},${S.walk - 2 - k}`, k === len + run - 1 && run > 3 ? FO + 2 : FO);
            }
        }
        const list = [...leaves].map(([key, t]) => { const [u, h] = key.split(',').map(Number); return [u, h, t]; });
        for (const [u, h] of list) {
            if (leaves.has(`${u + 1},${h - 1}`)) continue;
            const x = u + 1;
            const y = faceY(u, h) + 1;
            const behind = R.partAt(x, y);
            if (behind === P_BODY || behind === P_TRIM) R.recolor(x, y, clampA(Math.min(SHADE, R.colorAt(x, y) - 2)));
        }
        for (const [u, h, t] of list) {
            if (h > S.walk - 1 || h < S.plinthTop + 1) continue;
            R.set(u, faceY(u, h), t, h, FACE_SW, P_GREEN);
        }
    }

    // --- contours: a dark seam where a nearer mass stands before a farther
    // one (merlons over the walk, piers over the face), then the landmark
    // ink round the silhouette, then the contact band on the ground.
    const W = R.w;
    const H = R.h;
    const seams = [];
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const k = j * W + i;
            if (R.col[k] === EMPTY) continue;
            const p = R.part[k];
            const x = i + R.x0;
            const y = j + R.y0;
            const right = R.partAt(x + 1, y);
            const below = R.partAt(x, y + 1);
            if (p === P_WALK && (right === P_MERLON || below === P_MERLON)) seams.push([x, y, DEEP]);
            else if (p === P_BODY && (right === P_PIER || below === P_PIER)) seams.push([x, y, SHADE]);
        }
    }
    for (const [x, y, c] of seams) R.recolor(x, y, c);

    const ink = [];
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const k = j * W + i;
            if (R.col[k] !== EMPTY) continue;
            const x = i + R.x0;
            const y = j + R.y0;
            const solid = (xx, yy) => { const p = R.partAt(xx, yy); return p !== 0 && p !== P_CONTACT; };
            if (solid(x, y + 1) || solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1)) ink.push([x, y]);
        }
    }
    for (const [x, y] of ink) {
        // The ink texel stands on the surface it rims: the texel under it,
        // else the one above it (the base line), one px up or down.
        const below = R.index(x, y + 1);
        const above = R.index(x, y - 1);
        const h = below >= 0 && R.col[below] !== EMPTY ? R.hgt[below] + 1 : above >= 0 && R.col[above] !== EMPTY ? Math.max(0, R.hgt[above] - 1) : 0;
        R.set(x, y, INK, h, FACE_SW, P_TRIM);
    }

    // Contact band: the base's ground contact, two rows, the second dithered.
    for (let c = px1 - S.plinthProject - 1; c < px2 + 2; c++) {
        let y = yb(c) + S.plinthProject + 1;
        while (R.partAt(c, y) !== 0 && y < R.y0 + H) y++;
        for (let r = 0; r < 2; r++) {
            if (r === 1 && bayer(c, y + r) >= 0.5) continue;
            if (R.colorAt(c, y + r) === EMPTY) R.set(c, y + r, CONTACT, 0, FACE_UP, P_CONTACT);
        }
    }

    // Open ends: cut on the vertical through the end point, so the
    // neighbouring image carries on from the next column.
    if (openStart || openEnd) {
        for (let i = 0; i < W; i++) {
            const x = i + R.x0;
            if ((openStart && x < x1) || (openEnd && x >= x2)) {
                for (let j = 0; j < H; j++) R.col[j * W + i] = EMPTY;
            }
        }
    }

    // --- pack: albedo + surface channel -----------------------------------
    const albedo = new Uint8ClampedArray(W * H * 4);
    const surface = new Uint8ClampedArray(W * H * 4);
    for (let k = 0; k < W * H; k++) {
        const c = R.col[k];
        if (c === EMPTY) continue;
        const rgba = COLORS[c];
        const o = k * 4;
        albedo[o] = rgba[0];
        albedo[o + 1] = rgba[1];
        albedo[o + 2] = rgba[2];
        albedo[o + 3] = rgba[3];
        const h = R.hgt[k];
        surface[o] = h;
        surface[o + 1] = 148;
        surface[o + 2] = R.face[k] * 64 + Math.min(63, Math.round(h / 4));
        surface[o + 3] = 255;
    }
    return { width: W, height: H, left, top, albedo, surface, layout };
}

/**
 * `rasterWallRun` into two canvases: `{ albedo, surface, left, top, layout }`
 * (world px at (left, top)), or null outside a DOM.
 */
export function paintWallRun(options) {
    if (typeof document === 'undefined') return null;
    const raster = rasterWallRun(options);
    const toCanvas = (data) => {
        const canvas = document.createElement('canvas');
        canvas.width = raster.width;
        canvas.height = raster.height;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(raster.width, raster.height);
        image.data.set(data);
        ctx.putImageData(image, 0, 0);
        return canvas;
    };
    return { albedo: toCanvas(raster.albedo), surface: toCanvas(raster.surface), left: raster.left, top: raster.top, layout: raster.layout };
}

// ---------------------------------------------------------------------------
// The shared lantern: a wrought-iron bracket lantern (wall, gate, sea tower).
// Iron on the slate ramp with the landmark ink, glass 2 panes about a bar.
// Unlit by day (slate glass with an upper-left glint); lit only while the
// village's own lamplight is up (`lanternLit`), on the `emissive` ramp.

const SL = ART_RAMPS.slate;
const EM = ART_RAMPS.emissive;
const LANTERN_LIGHT_COLOR = '#ffc95e';
export const WALL_LANTERN = Object.freeze({
    width: 7,
    height: 12,           // cap top to drip, below the arm
    radius: 46,
    color: LANTERN_LIGHT_COLOR,
});

// Rows of the lantern body, 7 wide: i ink, d iron dark, m iron mid, l iron
// lit, g glass (lit/unlit by column), c glass core, b glass bottom, . none.
const LANTERN_ROWS = [
    '...i...',
    '..idi..',
    '.ilmdi.',
    'iiiiiii',
    'igcigci',
    'igcigci',
    'iggiggi',
    'ibbibbi',
    'iiiiiii',
    '.idmdi.',
    '..idi..',
    '...i...',
];

/** Whether the village's lamps are lit: its own lamplight, never agent state. */
export function lanternLit(lighting) {
    const beacon = Number(lighting?.beaconIntensity);
    return Number.isFinite(beacon) && beacon > 0.05;
}

/**
 * Paint the bracket lantern with its arm tip at world (ax, ay): the lantern
 * hangs below the tip, the arm runs back to the wall. `wall`: 'sw' (the arm
 * climbs up-right into a SW-facing face), 'se' (up-left into a SE-facing
 * face) or 'none' (a hanging lantern, no arm). `emissive`: paint only the
 * lit glass (the emissive channel), nothing else.
 */
export function drawWallLantern(ctx, ax, ay, { lit = false, wall = 'sw', reach = WALL_SPEC.lanternReach, emissive = false } = {}) {
    const x0 = Math.round(ax) - 3;
    const y0 = Math.round(ay) + 1;
    // The emissive channel carries the glass at the lantern sidecar's
    // contribution (prop.lantern.emissive.png: A 144).
    const alpha = emissive ? 144 / 255 : 1;
    const px = (x, y, color) => { ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fillRect(x, y, 1, 1); ctx.globalAlpha = 1; };
    if (!emissive) {
        // Arm: a 2:1 bar from the tip back to the face, a brace under it
        // and a wall plate where it meets the stone.
        if (wall !== 'none') {
            const dir = wall === 'se' ? -1 : 1;
            const tx = Math.round(ax);
            const ty = Math.round(ay);
            // With reach r the arm spans r columns and r/2 rows (2:1).
            for (let k = 0; k <= reach; k++) {
                const x = tx + dir * k;
                const y = ty - Math.floor(k / 2);
                px(x, y, A[INK]);
                if (k > 0 && k < reach && k % 2 === 1) px(x, y - 1, SL[2]);
            }
            const wx = tx + dir * reach;
            const wy = ty - Math.floor(reach / 2);
            px(wx - dir, wy + 2, A[INK]);
            px(wx - dir * 2, wy + 2, A[INK]);
            px(wx - dir * 3, wy + 1, A[INK]);
            for (let k = -1; k <= 3; k++) px(wx, wy + k, k === -1 ? SL[2] : A[INK]);
        } else {
            px(Math.round(ax), Math.round(ay) - 1, A[INK]);
            px(Math.round(ax), Math.round(ay), A[INK]);
        }
    }
    for (let r = 0; r < LANTERN_ROWS.length; r++) {
        const row = LANTERN_ROWS[r];
        for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            if (ch === '.') continue;
            const glass = ch === 'g' || ch === 'c' || ch === 'b';
            if (emissive && !(glass && lit)) continue;
            let color;
            if (ch === 'i') color = A[INK];
            else if (ch === 'd') color = SL[0];
            else if (ch === 'm') color = SL[1];
            else if (ch === 'l') color = SL[3];
            else if (lit) color = ch === 'c' ? EM[2] : ch === 'b' ? EM[0] : EM[1];
            else color = r === 4 && (i === 1 || i === 4) ? SL[3] : ch === 'b' ? SL[0] : SL[1];
            px(x0 + i, y0 + r, color);
        }
    }
}

/**
 * The V5 fixture record of a lantern whose glass centre is `height` world px
 * above its ground foot (fx, fy); none while unlit. Energy follows the
 * envelope's core like every village lantern (`sourceEnergyFor`), a candle
 * lantern's share of it: a warm course on the stone round the bracket and a
 * small pool at its foot, never the brazier's flood.
 */
export function wallLanternLight({ id, fx, fy, height, lighting, core = 1 }) {
    if (!lanternLit(lighting)) return null;
    return normalizeLightSource({
        id,
        kind: 'point',
        role: 'fixture',
        x: fx,
        y: fy - height,
        ground: { x: fx, y: fy },
        height,
        color: LANTERN_LIGHT_COLOR,
        radius: WALL_LANTERN.radius,
        intensity: 0.6 * core,
    });
}
