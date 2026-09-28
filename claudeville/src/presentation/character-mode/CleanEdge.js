// torcado's cleanEdge (MIT, 2022), ported from the GLSL in the
// PixelTechnique prototype (SLOPE + CLEANUP, similarity threshold 0, line
// width 1): a pixel-art-aware resampler. ClaudeVille uses it only at bake or
// cache time (3.8 / PT-6: hull roll frames, the Codex weapon angle cache),
// never as a live sampler. `src` is any { data, width, height } RGBA8 image
// (ImageData, a pngjs PNG).

function texel(src, x, y) {
    if (x < 0 || y < 0 || x >= src.width || y >= src.height) return [0, 0, 0, 0];
    const i = (src.width * y + x) << 2;
    const d = src.data;
    return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255];
}


const HIGHEST = [1, 1, 1];
const MIN_W = 0.45; const MAX_W = 1.142;
const LINE_W = Math.max(MIN_W, Math.min(MAX_W, 1.0));
function dist4(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]); }
function similar(a, b) { return (a[3] === 0 && b[3] === 0) || dist4(a, b) <= 0; }
function similar3(a, b, c) { return similar(a, b) && similar(b, c); }
function similar4(a, b, c, d) { return similar(a, b) && similar(b, c) && similar(c, d); }
function higher(t, o) {
    if (similar(t, o)) return false;
    if (t[3] === o[3]) return Math.hypot(t[0] - HIGHEST[0], t[1] - HIGHEST[1], t[2] - HIGHEST[2]) < Math.hypot(o[0] - HIGHEST[0], o[1] - HIGHEST[1], o[2] - HIGHEST[2]);
    return t[3] > o[3];
}
const cd = dist4;
function distToLine(p, p1, p2, dir) {
    const lx = p2[0] - p1[0]; const ly = p2[1] - p1[1];
    const perp = [ly, -lx];
    const toP1 = [p1[0] - p[0], p1[1] - p[1]];
    const len = Math.hypot(perp[0], perp[1]) || 1;
    const sign = (perp[0] * dir[0] + perp[1] * dir[1]) > 0 ? 1 : -1;
    return sign * ((perp[0] / len) * toP1[0] + (perp[1] / len) * toP1[1]);
}
const NONE = null;
function c2(center, v, pd) { return [center[0] + v[0] * pd[0], center[1] + v[1] * pd[1]]; }
function sliceDist(point, mainDir, pd, ub, u, uf, uff, b, c, f, ff, db, d, df, dff, ddb, dd, ddf) {
    point = [mainDir[0] * (point[0] - 0.5) + 0.5, mainDir[1] * (point[1] - 0.5) + 0.5];
    const distAgainst = 4 * cd(f, d) + cd(uf, c) + cd(c, db) + cd(ff, df) + cd(df, dd);
    const distTowards = 4 * cd(c, df) + cd(u, f) + cd(f, dff) + cd(b, d) + cd(d, ddf);
    let shouldSlice = (distAgainst < distTowards) || ((distAgainst < distTowards + 0.001) && !higher(c, f));
    if (similar4(f, d, b, u) && similar4(uf, df, db, ub) && !similar(c, f)) shouldSlice = false;
    if (!shouldSlice) return NONE;
    let dist = 1; let flip = false; const ctr = [0.5, 0.5];
    const npd = [-pd[0], -pd[1]];
    if (similar3(f, d, db) && !similar3(f, d, b) && !similar(uf, db)) {
        if (!(similar(c, df) && higher(c, f))) { if (higher(c, f)) flip = true; if (similar(u, f) && !similar(c, df) && !higher(c, u)) flip = true; }
        if (flip) dist = LINE_W - distToLine(point, c2(ctr, [1.5, -1.0], pd), c2(ctr, [-0.5, 0.0], pd), npd);
        else dist = distToLine(point, c2(ctr, [1.5, 0.0], pd), c2(ctr, [-0.5, 1.0], pd), pd);
        if (!flip && similar(c, uf) && !(similar3(c, uf, uff) && !similar3(c, uf, ff) && !similar(d, uff))) {
            dist = Math.min(dist, distToLine(point, c2(ctr, [2.0, -1.0], pd), c2(ctr, [0.0, 1.0], pd), pd));
        }
        dist -= LINE_W / 2;
        return dist <= 0 ? (cd(c, f) <= cd(c, d) ? f : d) : NONE;
    } else if (similar3(uf, f, d) && !similar3(u, f, d) && !similar(uf, db)) {
        if (!(similar(c, df) && higher(c, d))) { if (higher(c, d)) flip = true; if (similar(b, d) && !similar(c, df) && !higher(c, d)) flip = true; }
        if (flip) dist = LINE_W - distToLine(point, c2(ctr, [0.0, -0.5], pd), c2(ctr, [-1.0, 1.5], pd), npd);
        else dist = distToLine(point, c2(ctr, [1.0, -0.5], pd), c2(ctr, [0.0, 1.5], pd), pd);
        if (!flip && similar(c, db) && !(similar3(c, db, ddb) && !similar3(c, db, dd) && !similar(f, ddb))) {
            dist = Math.min(dist, distToLine(point, c2(ctr, [1.0, 0.0], pd), c2(ctr, [-1.0, 2.0], pd), pd));
        }
        dist -= LINE_W / 2;
        return dist <= 0 ? (cd(c, f) <= cd(c, d) ? f : d) : NONE;
    } else if (similar(f, d)) {
        if (similar(c, df) && higher(c, f)) { if (!similar(c, dd) && !similar(c, ff)) flip = true; }
        else { if (higher(c, f)) flip = true; if (!similar(c, b) && similar4(b, f, d, u)) flip = true; }
        if (((similar(f, db) && similar3(u, f, df)) || (similar(uf, d) && similar3(b, d, df))) && !similar(c, df)) flip = true;
        if (flip) dist = LINE_W - distToLine(point, c2(ctr, [1.0, -1.0], pd), c2(ctr, [-1.0, 1.0], pd), npd);
        else dist = distToLine(point, c2(ctr, [1.0, 0.0], pd), c2(ctr, [0.0, 1.0], pd), pd);
        if (!flip && similar3(c, uf, uff) && !similar3(c, uf, ff) && !similar(d, uff)) {
            dist = Math.max(dist, distToLine(point, c2(ctr, [1.5, 0.0], pd), c2(ctr, [-0.5, 1.0], pd), pd));
        }
        if (!flip && similar3(ddb, db, c) && !similar3(dd, db, c) && !similar(ddb, f)) {
            dist = Math.max(dist, distToLine(point, c2(ctr, [1.0, -0.5], pd), c2(ctr, [0.0, 1.5], pd), pd));
        }
        dist -= LINE_W / 2;
        return dist <= 0 ? (cd(c, f) <= cd(c, d) ? f : d) : NONE;
    } else if (similar3(ff, df, d) && !similar3(ff, df, c) && !similar(uff, d)) {
        if (!(similar(f, dff) && higher(f, ff))) { if (higher(f, ff)) flip = true; if (similar(uf, ff) && !similar(f, dff) && !higher(f, uf)) flip = true; }
        if (flip) dist = LINE_W - distToLine(point, c2(ctr, [2.5, -1.0], pd), c2(ctr, [0.5, 0.0], pd), npd);
        else dist = distToLine(point, c2(ctr, [2.5, 0.0], pd), c2(ctr, [0.5, 1.0], pd), pd);
        dist -= LINE_W / 2;
        return dist <= 0 ? (cd(f, ff) <= cd(f, df) ? ff : df) : NONE;
    } else if (similar3(f, df, dd) && !similar3(c, df, dd) && !similar(f, ddb)) {
        if (!(similar(d, ddf) && higher(d, dd))) { if (higher(d, dd)) flip = true; if (similar(db, dd) && !similar(d, ddf) && !higher(d, dd)) flip = true; }
        if (flip) dist = LINE_W - distToLine(point, c2(ctr, [0.0, 0.5], pd), c2(ctr, [-1.0, 2.5], pd), npd);
        else dist = distToLine(point, c2(ctr, [1.0, 0.5], pd), c2(ctr, [0.0, 2.5], pd), pd);
        dist -= LINE_W / 2;
        return dist <= 0 ? (cd(d, df) <= cd(d, dd) ? df : dd) : NONE;
    }
    return NONE;
}
export function cleanEdgeSample(src, sx, sy) {
    const T = (x, y) => texel(src, Math.floor(x), Math.floor(y));
    const local = [sx - Math.floor(sx), sy - Math.floor(sy)];
    const cx = Math.floor(sx) + 0.5; const cy = Math.floor(sy) + 0.5;
    const pd = [Math.round(local[0]) * 2 - 1, Math.round(local[1]) * 2 - 1];
    const at = (ox, oy) => T(cx + ox * pd[0], cy + oy * pd[1]);
    const uub = at(-1, -2); const uu = at(0, -2); const uuf = at(1, -2);
    const ubb = at(-2, -2); const ub = at(-1, -1); const u = at(0, -1); const uf = at(1, -1); const uff = at(2, -1);
    const bb = at(-2, 0); const b = at(-1, 0); const c = at(0, 0); const f = at(1, 0); const ff = at(2, 0);
    const dbb = at(-2, 1); const db = at(-1, 1); const d = at(0, 1); const df = at(1, 1); const dff = at(2, 1);
    const ddb = at(-1, 2); const dd = at(0, 2); const ddf = at(1, 2);
    let col = c;
    const cCol = sliceDist(local, [1, 1], pd, ub, u, uf, uff, b, c, f, ff, db, d, df, dff, ddb, dd, ddf);
    const bCol = sliceDist(local, [-1, 1], pd, uf, u, ub, ubb, f, c, b, bb, df, d, db, dbb, ddf, dd, ddb);
    const uCol = sliceDist(local, [1, -1], pd, db, d, df, dff, b, c, f, ff, ub, u, uf, uff, uub, uu, uuf);
    if (cCol) col = cCol;
    if (bCol) col = bCol;
    if (uCol) col = uCol;
    return col;
}

// Every tap cleanEdgeSample reads lies within 2 texels of the centre texel.
function clearWindow(src, cx, cy) {
    const d = src.data;
    for (let y = cy - 2; y <= cy + 2; y++) {
        if (y < 0 || y >= src.height) continue;
        for (let x = cx - 2; x <= cx + 2; x++) {
            if (x < 0 || x >= src.width) continue;
            if (d[((src.width * y + x) << 2) + 3] !== 0) return false;
        }
    }
    return true;
}

// Resample `src` into a `width` x `height` RGBA8 buffer: `inverse(x, y)`
// maps an output pixel centre to a continuous source coordinate (texels).
// Output alpha is binary, like the art.
export function resampleCleanEdge(src, width, height, inverse, out = new Uint8ClampedArray(width * height * 4)) {
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [sx, sy] = inverse(x + 0.5, y + 0.5);
            const i = (y * width + x) << 2;
            if (clearWindow(src, Math.floor(sx), Math.floor(sy))) { out[i + 3] = 0; continue; }
            const c = cleanEdgeSample(src, sx, sy);
            if (c[3] < 0.5) { out[i + 3] = 0; continue; }
            out[i] = Math.round(c[0] * 255);
            out[i + 1] = Math.round(c[1] * 255);
            out[i + 2] = Math.round(c[2] * 255);
            out[i + 3] = 255;
        }
    }
    return out;
}
