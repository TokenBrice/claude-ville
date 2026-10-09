// 0.2 — live ground cues as native GPU records.
//
// The resident WebGL path used to paint every ground cue (rings, tethers,
// halos, trails, the selection ellipse) into one viewport-sized canvas and
// re-upload it whole whenever any cue-bearing agent moved: 2.5 MB per frame at
// dense-24. The cues that follow agents now draw through this recorder
// instead. It speaks the small Canvas2D subset the existing cue painters use,
// rasterizes each path onto the world art-pixel grid (1 record pixel = 1 world
// unit, so every mark is an integer multiple of the texel, C3), and emits GPU
// records that sample one shared cue atlas. The atlas holds, per colour, a
// swatch texel and the 66 one-pixel line stamps a 16-pixel chord can take, so
// a hairline costs one record per 16 pixels and fills cost one record per row.
// B.3 — texel dots (`dottedCurve`, `ellipseArcDots`, trails: every council
// ring and tether) arrive as a stream of tiny `fillRect`s, one record each.
// Consecutive dots of one paint and size now join a run record (up to
// CUE_RUN_DOTS dots, their integer steps packed into loc1), and the scene
// vertex stage expands a run back into one quad per dot, in call order. The
// quads, their rasterization and their blending are the per-dot records'
// own, so the pixels are too (dots, stepped alpha, marching phase).
// The atlas uploads only when a new colour first appears: a moving agent
// moves records, never texels.
//
// Canvas semantics kept: path points take the transform current at call time,
// line width and dash lengths take the transform current at stroke time,
// `screen`/`lighter` compositing maps to additive records, alpha comes from the
// colour and `globalAlpha`. Not kept on purpose: anti-aliasing, joins, caps and
// sub-pixel widths (a stroke is at least one art pixel wide), and colours are
// snapped to 5 bits a channel so graded tints cannot churn the atlas. Text,
// images and gradients are not ground-cue vocabulary; they are counted as
// unsupported and skipped, and any cue that needs them stays in the retained
// cue texture.

import { GPU_RECORD_FLAGS } from './gpu/GpuWorldPolicy.js';
import { isOffshoreRecordId } from './OffshoreScenery.js';

// One chord of a hairline: 16 art pixels along its major axis.
const STAMP_SPAN = 16;
const STAMP_VARIANTS = STAMP_SPAN * 2 + 1;
// Per-colour band: shallow stamps (x-major) in the top row, steep stamps
// (y-major) below, the colour's swatch texel after the stamp columns.
export const BAND_HEIGHT = STAMP_SPAN * 2;
export const SWATCH_X = STAMP_SPAN * STAMP_VARIANTS;
const ATLAS_WIDTH = SWATCH_X + 4;
const ATLAS_START_BANDS = 16;
const ATLAS_MAX_BANDS = 64;
const COLOR_CACHE_LIMIT = 1024;
const MIN_RECORD_ALPHA = 0.004;
// A safety ceiling, not a budget: dropping cues would hide truth, so it sits
// far above any observed frame (dense-100 at the overview stays under 3k).
export const GROUND_CUE_RECORD_LIMIT = 32768;
export const GROUND_CUE_TEXTURE_KEY = 'ground:cue-atlas';

// B.3 — dot runs. A run holds up to CUE_RUN_DOTS dots of one paint and one
// size (at most CUE_RUN_MAX_DOT texels a side). Its rect is the dots'
// bounding box; loc1 carries four 24-bit integer words (exact in float32):
//   w0  band (6 bits) | dot w-1 (2) | dot h-1 (2) | count-1 (4)
//       | base step x + 8 (4) | base step y + 8 (4)
//   w1  first dot x (8) | first dot y (8), both from the rect origin
//       | steps 0-1 (4 bits each)
//   w2  steps 2-7    w3  steps 8-13
// Step j moves dot j to dot j+1 by (base x + bits 0-1, base y + bits 2-3), so
// every step of a run lies within 3 texels of the run's smallest one per
// axis; a step outside that window, or outside -8..10, starts a new run.
export const CUE_RUN_DOTS = 15;
const CUE_RUN_MAX_DOT = 4;
export const CUE_RUN_STEP_MIN = -8;
const CUE_RUN_STEP_MAX = 10;
const CUE_RUN_BASE_MAX = 7;
// Six vertices per dot: the two triangles of the per-dot strip, in its order.
export const CUE_RUN_VERTICES = CUE_RUN_DOTS * 6;

// The vertex-stage half of B.3 (GpuWorldRenderer's record vertex shader).
// With `u_cueRuns` set (a ground-cue batch holding runs, drawn with
// CUE_RUN_VERTICES vertices per instance) it picks this vertex's dot and
// strip corner and rewrites the record's rect and uv rect to that dot's own
// rect on its colour's swatch texel, exactly the record the dot used to be.
// A plain cue record in such a batch keeps its rect as dot 0; every vertex
// past a record's last dot collapses to a point.
export const CUE_RUN_GLSL = `
uniform bool u_cueRuns;
void cueRunVertex(int vertexId, uint flags, inout int corner, inout vec4 rect, inout vec4 uvRect) {
    int index = vertexId / 6;
    int tri = vertexId - index * 6;
    // A strip's triangles are (0, 1, 2) then (2, 1, 3).
    corner = tri < 3 ? tri : (tri == 3 ? 2 : (tri == 4 ? 1 : 3));
    if ((flags & ${GPU_RECORD_FLAGS.cueRun}u) == 0u) {
        if (index > 0) rect.zw = vec2(0.0);
        return;
    }
    // Exact integers below 2^24: no +0.5 (at 2^23 and up it rounds to even).
    uvec4 words = uvec4(uvRect);
    uint head = words.x;
    if (index > int((head >> 10u) & 15u)) {
        rect.zw = vec2(0.0);
        return;
    }
    ivec2 base = ivec2(int((head >> 14u) & 15u), int((head >> 18u) & 15u)) + ${CUE_RUN_STEP_MIN};
    ivec2 at = ivec2(int(words.y & 255u), int((words.y >> 8u) & 255u));
    for (int j = 0; j < ${CUE_RUN_DOTS - 1}; j++) {
        if (j >= index) break;
        uint word = j < 2 ? words.y : (j < 8 ? words.z : words.w);
        uint shift = uint(j < 2 ? 16 + 4 * j : 4 * (j < 8 ? j - 2 : j - 8));
        uint bits = (word >> shift) & 15u;
        at += base + ivec2(int(bits & 3u), int(bits >> 2u));
    }
    rect = vec4(rect.xy + vec2(at), float(((head >> 6u) & 3u) + 1u), float(((head >> 8u) & 3u) + 1u));
    vec2 atlas = vec2(textureSize(u_albedo, 0));
    vec2 swatch = vec2(${SWATCH_X}.25, float(head & 63u) * ${BAND_HEIGHT}.0 + 0.25);
    uvRect = vec4(swatch / atlas, (swatch + 0.5) / atlas);
}`;

const COORD_BIAS = 32768;
const COORD_SPAN = 65536;
const TAU = Math.PI * 2;

function identity() {
    return [1, 0, 0, 1, 0, 0];
}

function parseColor(text) {
    if (typeof text !== 'string') return null;
    const value = text.trim();
    if (value[0] === '#') {
        const hex = value.slice(1);
        if (hex.length === 3 || hex.length === 4) {
            const n = Number.parseInt(hex.slice(0, 3), 16);
            if (!Number.isFinite(n)) return null;
            return {
                rgb: ((((n >> 8) & 0xf) * 17) << 16) | ((((n >> 4) & 0xf) * 17) << 8) | ((n & 0xf) * 17),
                a: hex.length === 4 ? Number.parseInt(hex[3], 16) / 15 : 1,
            };
        }
        if (hex.length === 6 || hex.length === 8) {
            const n = Number.parseInt(hex.slice(0, 6), 16);
            if (!Number.isFinite(n)) return null;
            return { rgb: n, a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1 };
        }
        return null;
    }
    const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
    if (!match) return null;
    const channel = (part) => Math.max(0, Math.min(255, Math.round(Number(part))));
    const alpha = match[4] == null ? 1 : Math.max(0, Math.min(1, Number(match[4])));
    return {
        rgb: (channel(match[1]) << 16) | (channel(match[2]) << 8) | channel(match[3]),
        a: Number.isFinite(alpha) ? alpha : 1,
    };
}

function quantizeRgb(rgb) {
    // 5 bits a channel, re-expanded so the snapped colour is exact on screen.
    const q = (channel) => {
        const five = channel >> 3;
        return (five << 3) | (five >> 2);
    };
    return (q((rgb >> 16) & 0xff) << 16) | (q((rgb >> 8) & 0xff) << 8) | q(rgb & 0xff);
}

// The pixel rows of a one-pixel line from (0,0) toward (STAMP_SPAN, minor),
// covering steps 0..STAMP_SPAN-1 (the far end belongs to the next chord).
function stampOffset(minor, step) {
    return Math.round(minor * step / STAMP_SPAN);
}

function stampExtent(minor) {
    const last = stampOffset(minor, STAMP_SPAN - 1);
    return { min: Math.min(0, last), size: Math.abs(last) + 1 };
}

class CueAtlas {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.bands = new Map();
        this.colors = [];
        this.capacity = 0;
        this.revision = 0;
    }

    band(rgb) {
        let band = this.bands.get(rgb);
        if (band !== undefined) return band;
        if (!this.canvas) {
            if (typeof document === 'undefined') return -1;
            this.canvas = document.createElement('canvas');
            this._resize(ATLAS_START_BANDS);
        }
        if (this.colors.length >= this.capacity) {
            if (this.capacity < ATLAS_MAX_BANDS) {
                this._resize(this.capacity * 2);
            } else {
                // A full atlas restarts once; the live palette re-registers
                // over the next frame. Snapped cue colours make this rare.
                this.bands.clear();
                this.colors.length = 0;
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }
        }
        band = this.colors.length;
        this.colors.push(rgb);
        this.bands.set(rgb, band);
        this._paintBand(band, rgb);
        this.revision++;
        return band;
    }

    _resize(bands) {
        this.capacity = bands;
        this.canvas.width = ATLAS_WIDTH;
        this.canvas.height = bands * BAND_HEIGHT;
        this.ctx = this.canvas.getContext('2d');
        for (let i = 0; i < this.colors.length; i++) this._paintBand(i, this.colors[i]);
    }

    _paintBand(band, rgb) {
        const ctx = this.ctx;
        const top = band * BAND_HEIGHT;
        ctx.fillStyle = `#${rgb.toString(16).padStart(6, '0')}`;
        ctx.fillRect(SWATCH_X, top, 1, 1);
        for (let minor = -STAMP_SPAN; minor <= STAMP_SPAN; minor++) {
            const cell = (minor + STAMP_SPAN) * STAMP_SPAN;
            const { min } = stampExtent(minor);
            // Shallow (x-major): runs along x, one row per minor offset.
            let runStart = 0;
            for (let step = 1; step <= STAMP_SPAN; step++) {
                if (step < STAMP_SPAN && stampOffset(minor, step) === stampOffset(minor, runStart)) continue;
                ctx.fillRect(cell + runStart, top + stampOffset(minor, runStart) - min, step - runStart, 1);
                runStart = step;
            }
            // Steep (y-major): runs along y.
            runStart = 0;
            for (let step = 1; step <= STAMP_SPAN; step++) {
                if (step < STAMP_SPAN && stampOffset(minor, step) === stampOffset(minor, runStart)) continue;
                ctx.fillRect(cell + stampOffset(minor, runStart) - min, top + STAMP_SPAN + runStart, 1, step - runStart);
                runStart = step;
            }
        }
    }
}

export class GroundCueRecorder {
    constructor() {
        this.atlas = new CueAtlas();
        this.records = [];
        this._pool = [];
        this._colors = new Map();
        this._pixels = new Float64Array(4096);
        this._pixelCount = 0;
        this._stack = [];
        this._subpaths = [];
        this._current = null;
        this.bounds = null;
        this.unsupported = 0;
        this.dropped = 0;
        // B.3 — the open dot run (see _emitDot).
        this._run = {
            count: 0,
            xs: new Int32Array(CUE_RUN_DOTS),
            ys: new Int32Array(CUE_RUN_DOTS),
            w: 0,
            h: 0,
            paint: null,
            minDx: 0, maxDx: 0, minDy: 0, maxDy: 0,
        };
        this._resetState();
    }

    _resetState() {
        this._t = identity();
        this.fillStyle = '#000000';
        this.strokeStyle = '#000000';
        this.globalAlpha = 1;
        this.globalCompositeOperation = 'source-over';
        this.lineWidth = 1;
        this.lineDashOffset = 0;
        this._dash = [];
        this.lineCap = 'butt';
        this.lineJoin = 'miter';
        this.font = '10px sans-serif';
        this.textAlign = 'start';
        this.textBaseline = 'alphabetic';
        this.filter = 'none';
        this.imageSmoothingEnabled = false;
        this.shadowBlur = 0;
        this.shadowColor = 'rgba(0, 0, 0, 0)';
        this.shadowOffsetX = 0;
        this.shadowOffsetY = 0;
    }

    /** Start a frame. `bounds` is the visible world rect; pixels outside it are culled. */
    begin(bounds = null) {
        this.records.length = 0;
        this._stack.length = 0;
        this._subpaths.length = 0;
        this._current = null;
        this.bounds = bounds;
        this.unsupported = 0;
        this.dropped = 0;
        this._run.count = 0;
        this._resetState();
        return this;
    }

    end() {
        this._flushRun();
        // A colour first seen late in the frame bumps the atlas revision; every
        // record must carry the final one or the batch would skip the upload.
        const revision = this.atlas.revision;
        const atlasWidth = this.atlas.canvas?.width || 1;
        const atlasHeight = this.atlas.canvas?.height || 1;
        const records = this.records;
        const runFlag = GPU_RECORD_FLAGS.cueRun;
        // One batch per blend mode: the GPU renderer starts a new draw call at
        // every blend change, and interleaved screen halos and normal strokes
        // would split hundreds of runs into hundreds of draws. Normal cues keep
        // their order; additive (screen) cues accumulate on top, and addition
        // is order-free among themselves.
        const additive = this._additiveScratch || (this._additiveScratch = []);
        additive.length = 0;
        let write = 0;
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            record.textureRevision = revision;
            // The atlas may have grown mid-frame; UVs follow its final size.
            // A dot run's loc1 is its payload (unit source size); the vertex
            // stage reads the atlas size itself.
            if (!(record.flags & runFlag)) {
                record.sourceWidth = atlasWidth;
                record.sourceHeight = atlasHeight;
            }
            if (record.blend === 'add') additive.push(record);
            else records[write++] = record;
        }
        for (let i = 0; i < additive.length; i++) records[write++] = additive[i];
        additive.length = 0;
        return records;
    }

    // --- state ---------------------------------------------------------
    save() {
        this._stack.push({
            t: this._t.slice(),
            fillStyle: this.fillStyle,
            strokeStyle: this.strokeStyle,
            globalAlpha: this.globalAlpha,
            globalCompositeOperation: this.globalCompositeOperation,
            lineWidth: this.lineWidth,
            lineDashOffset: this.lineDashOffset,
            dash: this._dash,
            lineCap: this.lineCap,
            lineJoin: this.lineJoin,
            font: this.font,
            textAlign: this.textAlign,
            textBaseline: this.textBaseline,
            filter: this.filter,
        });
    }

    restore() {
        const state = this._stack.pop();
        if (!state) return;
        this._t = state.t;
        this.fillStyle = state.fillStyle;
        this.strokeStyle = state.strokeStyle;
        this.globalAlpha = state.globalAlpha;
        this.globalCompositeOperation = state.globalCompositeOperation;
        this.lineWidth = state.lineWidth;
        this.lineDashOffset = state.lineDashOffset;
        this._dash = state.dash;
        this.lineCap = state.lineCap;
        this.lineJoin = state.lineJoin;
        this.font = state.font;
        this.textAlign = state.textAlign;
        this.textBaseline = state.textBaseline;
        this.filter = state.filter;
    }

    setLineDash(segments) {
        this._dash = Array.isArray(segments) ? segments.filter(v => Number.isFinite(v) && v >= 0) : [];
        if (this._dash.length % 2) this._dash = this._dash.concat(this._dash);
    }

    getLineDash() {
        return this._dash.slice();
    }

    // --- transform -----------------------------------------------------
    setTransform(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
        if (typeof a === 'object' && a) {
            this._t = [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0];
            return;
        }
        this._t = [a, b, c, d, e, f];
    }

    resetTransform() {
        this._t = identity();
    }

    transform(a, b, c, d, e, f) {
        const [ta, tb, tc, td, te, tf] = this._t;
        this._t = [
            ta * a + tc * b, tb * a + td * b,
            ta * c + tc * d, tb * c + td * d,
            ta * e + tc * f + te, tb * e + td * f + tf,
        ];
    }

    translate(x, y) {
        this.transform(1, 0, 0, 1, x, y);
    }

    scale(x, y = x) {
        this.transform(x, 0, 0, y, 0, 0);
    }

    rotate(angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        this.transform(cos, sin, -sin, cos, 0, 0);
    }

    _tx(x, y) {
        const t = this._t;
        return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
    }

    _linearScale() {
        const t = this._t;
        return Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1;
    }

    // --- path ----------------------------------------------------------
    beginPath() {
        this._subpaths.length = 0;
        this._current = null;
    }

    moveTo(x, y) {
        const t = this._t;
        this._current = { points: [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]], closed: false };
        this._subpaths.push(this._current);
    }

    lineTo(x, y) {
        if (!this._current) {
            this.moveTo(x, y);
            return;
        }
        const t = this._t;
        this._current.points.push(t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]);
    }

    _lastUserPoint() {
        // Curves need the previous point in device space; the recorder keeps
        // device-space points only, so curve control points are transformed and
        // the curve is flattened in device space (affine maps preserve Béziers).
        const points = this._current?.points;
        return points ? [points[points.length - 2], points[points.length - 1]] : null;
    }

    quadraticCurveTo(cx, cy, x, y) {
        const start = this._lastUserPoint();
        if (!start) {
            this.moveTo(cx, cy);
            this.lineTo(x, y);
            return;
        }
        const [qx, qy] = this._tx(cx, cy);
        const [ex, ey] = this._tx(x, y);
        const length = Math.hypot(qx - start[0], qy - start[1]) + Math.hypot(ex - qx, ey - qy);
        const steps = Math.max(2, Math.min(96, Math.ceil(length / 3)));
        const points = this._current.points;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const inv = 1 - t;
            points.push(
                inv * inv * start[0] + 2 * inv * t * qx + t * t * ex,
                inv * inv * start[1] + 2 * inv * t * qy + t * t * ey,
            );
        }
    }

    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
        const start = this._lastUserPoint();
        if (!start) {
            this.moveTo(c1x, c1y);
            this.lineTo(x, y);
            return;
        }
        const [ax, ay] = this._tx(c1x, c1y);
        const [bx, by] = this._tx(c2x, c2y);
        const [ex, ey] = this._tx(x, y);
        const length = Math.hypot(ax - start[0], ay - start[1]) + Math.hypot(bx - ax, by - ay) + Math.hypot(ex - bx, ey - by);
        const steps = Math.max(2, Math.min(128, Math.ceil(length / 3)));
        const points = this._current.points;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const inv = 1 - t;
            points.push(
                inv * inv * inv * start[0] + 3 * inv * inv * t * ax + 3 * inv * t * t * bx + t * t * t * ex,
                inv * inv * inv * start[1] + 3 * inv * inv * t * ay + 3 * inv * t * t * by + t * t * t * ey,
            );
        }
    }

    ellipse(x, y, rx, ry, rotation = 0, start = 0, end = TAU, counterclockwise = false) {
        if (!(rx >= 0) || !(ry >= 0)) return;
        let sweep = end - start;
        if (!counterclockwise) {
            if (sweep >= TAU) sweep = TAU;
            else sweep = ((sweep % TAU) + TAU) % TAU;
        } else if (-sweep >= TAU) {
            sweep = -TAU;
        } else {
            sweep = -((((start - end) % TAU) + TAU) % TAU);
        }
        const scale = this._linearScale();
        // 4-unit flattening chords: the sagitta on a 60-unit ring is 0.03 px.
        const steps = Math.max(12, Math.min(256, Math.ceil(Math.abs(sweep) * Math.max(rx, ry) * scale / 4)));
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        // Rotate the unit vector by a fixed step (one complex multiply per
        // point) instead of two trig calls per point.
        const stepAngle = sweep / steps;
        const stepCos = Math.cos(stepAngle);
        const stepSin = Math.sin(stepAngle);
        let unitCos = Math.cos(start);
        let unitSin = Math.sin(start);
        // Like Canvas: a fresh path starts at the arc; an open one draws a
        // line to the arc's start point first.
        const startX = x + unitCos * rx * cos - unitSin * ry * sin;
        const startY = y + unitCos * rx * sin + unitSin * ry * cos;
        if (!this._current) this.moveTo(startX, startY);
        else this.lineTo(startX, startY);
        const t = this._t;
        const points = this._current.points;
        for (let i = 1; i <= steps; i++) {
            const nextCos = unitCos * stepCos - unitSin * stepSin;
            unitSin = unitSin * stepCos + unitCos * stepSin;
            unitCos = nextCos;
            const ex = unitCos * rx;
            const ey = unitSin * ry;
            const px = x + ex * cos - ey * sin;
            const py = y + ex * sin + ey * cos;
            points.push(t[0] * px + t[2] * py + t[4], t[1] * px + t[3] * py + t[5]);
        }
    }

    arc(x, y, radius, start = 0, end = TAU, counterclockwise = false) {
        this.ellipse(x, y, radius, radius, 0, start, end, counterclockwise);
    }

    rect(x, y, w, h) {
        this.moveTo(x, y);
        this.lineTo(x + w, y);
        this.lineTo(x + w, y + h);
        this.lineTo(x, y + h);
        this.closePath();
    }

    roundRect(x, y, w, h) {
        this.rect(x, y, w, h);
    }

    closePath() {
        if (!this._current) return;
        this._current.closed = true;
        const points = this._current.points;
        this._current = { points: [points[0], points[1]], closed: false };
        this._subpaths.push(this._current);
    }

    // --- paint ---------------------------------------------------------
    _paint(style) {
        const parsed = this._color(style);
        if (!parsed) return null;
        const alpha = parsed.a * Math.max(0, Math.min(1, Number(this.globalAlpha) || 0));
        if (alpha < MIN_RECORD_ALPHA) return null;
        const band = this.atlas.band(quantizeRgb(parsed.rgb));
        if (band < 0) return null;
        const op = this.globalCompositeOperation;
        return { top: band * BAND_HEIGHT, alpha, add: op === 'screen' || op === 'lighter' || op === 'plus-lighter' };
    }

    _color(style) {
        if (typeof style !== 'string') {
            this.unsupported++;
            return null;
        }
        let parsed = this._colors.get(style);
        if (parsed === undefined) {
            parsed = parseColor(style);
            if (this._colors.size >= COLOR_CACHE_LIMIT) this._colors.clear();
            this._colors.set(style, parsed);
        }
        return parsed;
    }

    // Without a source rect the record samples the colour's swatch texel (its
    // interior, so NEAREST never bleeds a neighbour); with one it is a stamp.
    _emit(x, y, width, height, paint, sx = -1, sy = 0, sw = 0, sh = 0) {
        if (this.records.length >= GROUND_CUE_RECORD_LIMIT) {
            this.dropped++;
            return null;
        }
        const index = this.records.length;
        let record = this._pool[index];
        if (!record) {
            record = {
                // Every field normalizeGpuRecord writes, already valid: the
                // batcher takes these records as-is (see buildStableGpuBatches).
                // V9: a ground cue never writes painter depth (key 0, the far
                // plane) and is its own receiver (footY -1).
                prenormalized: true,
                id: 'ground:cue',
                stableKey: 'ground:cue',
                textureKey: GROUND_CUE_TEXTURE_KEY,
                sidecarKey: '',
                source: null,
                materialSource: null,
                emissiveSource: null,
                occluderSource: null,
                sourceWidth: 1,
                sourceHeight: 1,
                sx: 0, sy: 0, sw: 1, sh: 1,
                x: 0, y: 0, width: 1, height: 1,
                alpha: 1,
                blend: 'normal',
                material: 0,
                elevation: 0,
                occluder: 0,
                emissive: 0,
                emissiveGate: 1,
                paletteRamp: false,
                depthSortY: null,
                depthKey: 0,
                writesDepth: false,
                flags: 0,
                footY: -1,
                frontCornerX: 0,
                frontCornerY: -1,
                ownerSlot: 0,
                landmarkId: 0,
                sequence: 0,
                textureRevision: 0,
                sidecarRevision: null,
                textureUpdates: null,
                materialTextureUpdates: null,
                emissiveTextureUpdates: null,
                occluderTextureUpdates: null,
            };
            this._pool[index] = record;
        }
        const canvas = this.atlas.canvas;
        record.source = canvas;
        record.sourceWidth = canvas.width;
        record.sourceHeight = canvas.height;
        if (sx < 0) {
            record.sx = SWATCH_X + 0.25;
            record.sy = paint.top + 0.25;
            record.sw = 0.5;
            record.sh = 0.5;
        } else {
            record.sx = sx;
            record.sy = sy;
            record.sw = sw;
            record.sh = sh;
        }
        record.x = x;
        record.y = y;
        record.width = width;
        record.height = height;
        record.alpha = paint.alpha;
        record.blend = paint.add ? 'add' : 'normal';
        record.flags = 0;
        record.textureRevision = this.atlas.revision;
        this.records.push(record);
        return record;
    }

    // B.3 — one texel dot (a small `fillRect`, already on the art grid and
    // culled). It joins the open run when paint, size and step allow, else
    // the run is flushed and a new one starts here. Anything else that emits
    // (`stroke`, `fill`, `end`) flushes first, so records keep call order.
    _emitDot(x, y, width, height, paint) {
        const run = this._run;
        if (width > CUE_RUN_MAX_DOT || height > CUE_RUN_MAX_DOT) {
            this._flushRun();
            this._emit(x, y, width, height, paint);
            return;
        }
        const count = run.count;
        if (count) {
            const last = run.paint;
            if (count < CUE_RUN_DOTS && width === run.w && height === run.h
                && paint.top === last.top && paint.alpha === last.alpha && paint.add === last.add) {
                const dx = x - run.xs[count - 1];
                const dy = y - run.ys[count - 1];
                const minDx = count > 1 ? Math.min(run.minDx, dx) : dx;
                const maxDx = count > 1 ? Math.max(run.maxDx, dx) : dx;
                const minDy = count > 1 ? Math.min(run.minDy, dy) : dy;
                const maxDy = count > 1 ? Math.max(run.maxDy, dy) : dy;
                if (maxDx - minDx <= 3 && minDx >= CUE_RUN_STEP_MIN && maxDx <= CUE_RUN_STEP_MAX
                    && maxDy - minDy <= 3 && minDy >= CUE_RUN_STEP_MIN && maxDy <= CUE_RUN_STEP_MAX) {
                    run.minDx = minDx;
                    run.maxDx = maxDx;
                    run.minDy = minDy;
                    run.maxDy = maxDy;
                    run.xs[count] = x;
                    run.ys[count] = y;
                    run.count = count + 1;
                    return;
                }
            }
            this._flushRun();
        }
        run.paint = paint;
        run.w = width;
        run.h = height;
        run.xs[0] = x;
        run.ys[0] = y;
        run.count = 1;
    }

    _flushRun() {
        const run = this._run;
        const count = run.count;
        if (!count) return;
        run.count = 0;
        const paint = run.paint;
        const xs = run.xs;
        const ys = run.ys;
        if (count === 1) {
            this._emit(xs[0], ys[0], run.w, run.h, paint);
            return;
        }
        let minX = xs[0];
        let maxX = minX;
        let minY = ys[0];
        let maxY = minY;
        for (let i = 1; i < count; i++) {
            if (xs[i] < minX) minX = xs[i];
            else if (xs[i] > maxX) maxX = xs[i];
            if (ys[i] < minY) minY = ys[i];
            else if (ys[i] > maxY) maxY = ys[i];
        }
        const baseX = Math.min(run.minDx, CUE_RUN_BASE_MAX);
        const baseY = Math.min(run.minDy, CUE_RUN_BASE_MAX);
        const w0 = (paint.top / BAND_HEIGHT)
            | ((run.w - 1) << 6) | ((run.h - 1) << 8) | ((count - 1) << 10)
            | ((baseX - CUE_RUN_STEP_MIN) << 14) | ((baseY - CUE_RUN_STEP_MIN) << 18);
        let w1 = (xs[0] - minX) | ((ys[0] - minY) << 8);
        let w2 = 0;
        let w3 = 0;
        for (let j = 0; j + 1 < count; j++) {
            const bits = (xs[j + 1] - xs[j] - baseX) | ((ys[j + 1] - ys[j] - baseY) << 2);
            if (j < 2) w1 |= bits << (16 + 4 * j);
            else if (j < 8) w2 |= bits << (4 * (j - 2));
            else w3 |= bits << (4 * (j - 8));
        }
        const record = this._emit(minX, minY, maxX - minX + run.w, maxY - minY + run.h, paint);
        if (!record) return;
        // loc1 stages sx, sy, sx + sw, sy + sh over a unit source: the words.
        record.flags = GPU_RECORD_FLAGS.cueRun;
        record.sourceWidth = 1;
        record.sourceHeight = 1;
        record.sx = w0;
        record.sy = w1;
        record.sw = w2 - w0;
        record.sh = w3 - w1;
    }

    _emitChord(minX, minY, minor, xMajor, paint) {
        const { min, size } = stampExtent(minor);
        const cell = (minor + STAMP_SPAN) * STAMP_SPAN;
        const x = xMajor ? minX : minX + min;
        const y = xMajor ? minY + min : minY;
        const width = xMajor ? STAMP_SPAN : size;
        const height = xMajor ? size : STAMP_SPAN;
        const b = this.bounds;
        if (b && (x + width < b.left || x > b.right || y + height < b.top || y > b.bottom)) return;
        this._emit(x, y, width, height, paint, cell, paint.top + (xMajor ? 0 : STAMP_SPAN), width, height);
    }

    // A one-pixel stroke as a chain of 16-pixel chords. Each chord covers its
    // min-end pixel and not its far end, so a monotone chain covers every
    // pixel once; turning points left uncovered are plotted explicitly, and
    // the short tail chord is rasterized pixel by pixel.
    _strokeHairline(points, closed, paint, width = 1) {
        // Wider strokes repeat the chord chain across the minor axis.
        const lo = -Math.floor((width - 1) / 2);
        const hi = lo + width;
        const n = points.length / 2;
        const segments = closed ? n : n - 1;
        if (n < 1) return;
        const chain = this._chain || (this._chain = []);
        chain.length = 0;
        let qx = Math.floor(points[0]);
        let qy = Math.floor(points[1]);
        chain.push(qx, qy);
        for (let s = 0; s < segments; s++) {
            const e = (s + 1) % n;
            const ax = points[s * 2];
            const ay = points[s * 2 + 1];
            const dx = points[e * 2] - ax;
            const dy = points[e * 2 + 1] - ay;
            let t = 0;
            for (;;) {
                const cx = qx + 0.5;
                const cy = qy + 0.5;
                let hit = Infinity;
                let hitX = false;
                // Along a segment x and y move monotonically, so only the box
                // face ahead of the travel direction can be crossed.
                if (dx !== 0) {
                    const tc = (cx + (dx > 0 ? STAMP_SPAN : -STAMP_SPAN) - ax) / dx;
                    if (tc > t + 1e-9 && tc <= 1 && tc < hit) { hit = tc; hitX = true; }
                }
                if (dy !== 0) {
                    const tc = (cy + (dy > 0 ? STAMP_SPAN : -STAMP_SPAN) - ay) / dy;
                    if (tc > t + 1e-9 && tc <= 1 && tc < hit) { hit = tc; hitX = false; }
                }
                if (hit === Infinity) break;
                const px = ax + dx * hit;
                const py = ay + dy * hit;
                if (hitX) {
                    qx += px > cx ? STAMP_SPAN : -STAMP_SPAN;
                    qy = Math.max(qy - STAMP_SPAN, Math.min(qy + STAMP_SPAN, Math.floor(py)));
                } else {
                    qy += py > cy ? STAMP_SPAN : -STAMP_SPAN;
                    qx = Math.max(qx - STAMP_SPAN, Math.min(qx + STAMP_SPAN, Math.floor(px)));
                }
                chain.push(qx, qy);
                t = hit;
            }
        }
        const endIndex = closed ? 0 : n - 1;
        const fx = Math.floor(points[endIndex * 2]);
        const fy = Math.floor(points[endIndex * 2 + 1]);
        if (fx !== qx || fy !== qy) chain.push(fx, fy);
        const count = chain.length / 2;
        const covered = this._covered || (this._covered = []);
        covered.length = count;
        covered.fill(0);
        for (let i = 0; i + 1 < count; i++) {
            const x0 = chain[i * 2];
            const y0 = chain[i * 2 + 1];
            const x1 = chain[i * 2 + 2];
            const y1 = chain[i * 2 + 3];
            const dx = x1 - x0;
            const dy = y1 - y0;
            if (dx === 0 && dy === 0) continue;
            const xMajor = Math.abs(dx) >= Math.abs(dy);
            const startIsMin = xMajor ? dx > 0 : dy > 0;
            covered[startIsMin ? i : i + 1]++;
            const mx = startIsMin ? x0 : x1;
            const my = startIsMin ? y0 : y1;
            const minor = xMajor ? (startIsMin ? dy : -dy) : (startIsMin ? dx : -dx);
            const length = Math.max(Math.abs(dx), Math.abs(dy));
            if (length === STAMP_SPAN) {
                for (let o = lo; o < hi; o++) {
                    this._emitChord(xMajor ? mx : mx + o, xMajor ? my + o : my, minor, xMajor, paint);
                }
                continue;
            }
            for (let k = 0; k < length; k++) {
                const offset = Math.round(minor * k / length);
                for (let o = lo; o < hi; o++) {
                    if (xMajor) this._pushPixel(mx + k, my + offset + o);
                    else this._pushPixel(mx + offset + o, my + k);
                }
            }
        }
        // A closed chain ends where it began: one point, two chords.
        const last = count - 1;
        const shared = closed && count > 1 && chain[last * 2] === chain[0] && chain[last * 2 + 1] === chain[1];
        if (shared) covered[0] += covered[last];
        for (let i = 0; i < (shared ? last : count); i++) {
            if (covered[i]) continue;
            for (let oy = lo; oy < hi; oy++) {
                for (let ox = lo; ox < hi; ox++) this._pushPixel(chain[i * 2] + ox, chain[i * 2 + 1] + oy);
            }
        }
    }

    _pushPixel(px, py) {
        const b = this.bounds;
        if (b && (px < b.left || px > b.right || py < b.top || py > b.bottom)) return;
        if (this._pixelCount >= this._pixels.length) {
            const grown = new Float64Array(this._pixels.length * 2);
            grown.set(this._pixels);
            this._pixels = grown;
        }
        this._pixels[this._pixelCount++] = (py + COORD_BIAS) * COORD_SPAN + (px + COORD_BIAS);
    }

    _flushPixels(paint) {
        const count = this._pixelCount;
        this._pixelCount = 0;
        if (!count) return;
        const keys = this._pixels.subarray(0, count).sort();
        let runX = 0;
        let runY = 0;
        let runW = 0;
        let previous = -1;
        for (let i = 0; i < count; i++) {
            const key = keys[i];
            if (key === previous) continue;
            previous = key;
            const py = Math.floor(key / COORD_SPAN) - COORD_BIAS;
            const px = (key % COORD_SPAN) - COORD_BIAS;
            if (runW && py === runY && px === runX + runW) {
                runW++;
                continue;
            }
            if (runW) this._emit(runX, runY, runW, 1, paint);
            runX = px;
            runY = py;
            runW = 1;
        }
        if (runW) this._emit(runX, runY, runW, 1, paint);
    }

    stroke() {
        const paint = this._paint(this.strokeStyle);
        if (!paint) return;
        this._flushRun();
        const scale = this._linearScale();
        const width = Math.max(1, Math.round((Number(this.lineWidth) || 1) * scale));
        const half = (width - 1) / 2;
        const dash = this._dash.length ? this._dash.map(v => Math.max(1, v * scale)) : null;
        const dashTotal = dash ? dash.reduce((sum, v) => sum + v, 0) : 0;
        if (width <= 3 && !dash) {
            for (const subpath of this._subpaths) {
                if (subpath.points.length < 4 && !subpath.closed) continue;
                this._strokeHairline(subpath.points, subpath.closed, paint, width);
            }
            this._flushPixels(paint);
            return;
        }
        for (const subpath of this._subpaths) {
            const points = subpath.points;
            if (points.length < 4 && !subpath.closed) continue;
            // Canvas restarts the dash pattern for every subpath.
            let travelled = dash ? (((Number(this.lineDashOffset) || 0) * scale) % dashTotal + dashTotal) % dashTotal : 0;
            const count = points.length / 2 + (subpath.closed ? 1 : 0);
            for (let i = 1; i < count; i++) {
                const j = i % (points.length / 2);
                const x0 = points[(i - 1) * 2];
                const y0 = points[(i - 1) * 2 + 1];
                const x1 = points[j * 2];
                const y1 = points[j * 2 + 1];
                const dx = x1 - x0;
                const dy = y1 - y0;
                const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
                const stepLength = Math.hypot(dx, dy) / steps;
                for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
                    if (dash && s > 0) travelled += stepLength;
                    if (dash && !dashOn(dash, travelled % dashTotal)) continue;
                    const x = x0 + dx * (s / steps);
                    const y = y0 + dy * (s / steps);
                    const left = Math.floor(x - half);
                    const top = Math.floor(y - half);
                    for (let oy = 0; oy < width; oy++) {
                        for (let ox = 0; ox < width; ox++) this._pushPixel(left + ox, top + oy);
                    }
                }
            }
        }
        this._flushPixels(paint);
    }

    fill() {
        const paint = this._paint(this.fillStyle);
        if (!paint) return;
        this._flushRun();
        // Edges are stored top-down ([xTop, yTop, xBottom, yBottom]) and
        // walked with an active-edge list, so each row touches only the edges
        // that span it instead of the whole outline.
        const edges = this._edges || (this._edges = []);
        edges.length = 0;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const subpath of this._subpaths) {
            const points = subpath.points;
            const n = points.length / 2;
            if (n < 3) continue;
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                const x0 = points[i * 2];
                const y0 = points[i * 2 + 1];
                const x1 = points[j * 2];
                const y1 = points[j * 2 + 1];
                if (y0 === y1) continue;
                if (y0 < y1) edges.push(x0, y0, x1, y1);
                else edges.push(x1, y1, x0, y0);
                if (y0 < minY) minY = y0;
                if (y1 < minY) minY = y1;
                if (y0 > maxY) maxY = y0;
                if (y1 > maxY) maxY = y1;
            }
        }
        if (!edges.length) return;
        const edgeCount = edges.length / 4;
        // Bucket edges by the first row whose centre they reach: O(edges +
        // rows), no sort. `head`/`next` form per-row singly linked lists.
        const b = this.bounds;
        const firstRow = Math.max(Math.floor(minY), b ? Math.floor(b.top) : -Infinity);
        const lastRow = Math.min(Math.ceil(maxY), b ? Math.ceil(b.bottom) : Infinity);
        if (lastRow < firstRow) return;
        const rowCount = lastRow - firstRow + 1;
        let head = this._rowHead;
        if (!head || head.length < rowCount) head = this._rowHead = new Int32Array(Math.max(rowCount, 256));
        head.fill(-1, 0, rowCount);
        let next = this._edgeNext;
        if (!next || next.length < edgeCount) next = this._edgeNext = new Int32Array(Math.max(edgeCount, 256));
        let active = this._activeEdges;
        if (!active || active.length < edgeCount) active = this._activeEdges = new Int32Array(Math.max(edgeCount, 256));
        let activeCount = 0;
        for (let i = 0; i < edgeCount; i++) {
            const top = edges[i * 4 + 1];
            // First row r with r + 0.5 >= top.
            let row = Math.ceil(top - 0.5) - firstRow;
            if (row >= rowCount) continue;
            if (edges[i * 4 + 3] <= firstRow + 0.5) continue;
            if (row < 0) row = 0;
            next[i] = head[row];
            head[row] = i;
        }
        const emittedBefore = this.records.length;
        let crossings = this._crossings;
        if (!crossings || crossings.length < edgeCount) crossings = this._crossings = new Float64Array(Math.max(edgeCount, 64));
        const clipLeft = b ? Math.floor(b.left) : -Infinity;
        const clipRight = b ? Math.ceil(b.right) : Infinity;
        // A row with one span whose extent repeats the row above extends that
        // record downward instead of adding one: flat iso ellipses repeat
        // widths near the waist.
        let spanLeft = 0;
        let spanRight = -1;
        let spanRecord = null;
        for (let r = 0; r < rowCount; r++) {
            const row = firstRow + r;
            const y = row + 0.5;
            for (let e = head[r]; e >= 0; e = next[e]) active[activeCount++] = e;
            let count = 0;
            let keep = 0;
            for (let a = 0; a < activeCount; a++) {
                const e = active[a] * 4;
                const y1 = edges[e + 3];
                if (y1 <= y) continue;
                active[keep++] = active[a];
                const x0 = edges[e];
                const y0 = edges[e + 1];
                crossings[count++] = x0 + (y - y0) * (edges[e + 2] - x0) / (y1 - y0);
            }
            activeCount = keep;
            if (count < 2) {
                spanRecord = null;
                continue;
            }
            if (count === 2) {
                if (crossings[0] > crossings[1]) {
                    const swap = crossings[0];
                    crossings[0] = crossings[1];
                    crossings[1] = swap;
                }
            } else {
                crossings.subarray(0, count).sort();
            }
            const single = count === 2;
            for (let k = 0; k + 1 < count; k += 2) {
                let left = Math.ceil(crossings[k] - 0.5);
                let right = Math.floor(crossings[k + 1] - 0.5);
                if (left < clipLeft) left = clipLeft;
                if (right > clipRight) right = clipRight;
                if (right < left) continue;
                if (single && spanRecord && left === spanLeft && right === spanRight
                    && spanRecord.y + spanRecord.height === row) {
                    spanRecord.height++;
                    continue;
                }
                const before = this.records.length;
                this._emit(left, row, right - left + 1, 1, paint);
                spanRecord = single && this.records.length > before ? this.records[before] : null;
                spanLeft = left;
                spanRight = right;
            }
            if (!single) spanRecord = null;
        }
        if (this.records.length === emittedBefore && maxY - minY < 3) {
            // A sub-pixel dot (a counsel mote, a 1.6-unit bead) still marks one
            // art pixel, as its anti-aliased Canvas twin would.
            let sumX = 0;
            for (let e = 0; e < edges.length; e += 4) sumX += edges[e];
            const px = Math.floor(sumX / (edges.length / 4));
            const py = Math.floor((minY + maxY) / 2);
            if (!b || (px >= b.left && px <= b.right && py >= b.top && py <= b.bottom)) this._emit(px, py, 1, 1, paint);
        }
    }

    fillRect(x, y, w, h) {
        const t = this._t;
        if (t[1] !== 0 || t[2] !== 0) {
            const saved = this._subpaths;
            const current = this._current;
            this._subpaths = [];
            this._current = null;
            this.rect(x, y, w, h);
            this.fill();
            this._subpaths = saved;
            this._current = current;
            return;
        }
        const paint = this._paint(this.fillStyle);
        if (!paint) return;
        const [ax, ay] = this._tx(x, y);
        const [bx, by] = this._tx(x + w, y + h);
        let left = Math.round(Math.min(ax, bx));
        let top = Math.round(Math.min(ay, by));
        let right = Math.round(Math.max(ax, bx));
        let bottom = Math.round(Math.max(ay, by));
        // A sub-pixel rect still paints one art pixel, like the Canvas cue it replaces.
        if (right === left) right = left + 1;
        if (bottom === top) bottom = top + 1;
        const b = this.bounds;
        if (b) {
            if (right < b.left || left > b.right || bottom < b.top || top > b.bottom) return;
        }
        this._emitDot(left, top, right - left, bottom - top, paint);
    }

    strokeRect(x, y, w, h) {
        const saved = this._subpaths;
        const current = this._current;
        this._subpaths = [];
        this._current = null;
        this.rect(x, y, w, h);
        this.stroke();
        this._subpaths = saved;
        this._current = current;
    }

    clearRect() {}

    fillText() {
        this.unsupported++;
    }

    strokeText() {
        this.unsupported++;
    }

    drawImage() {
        this.unsupported++;
    }

    measureText(text) {
        return { width: String(text ?? '').length * 6 };
    }

    createLinearGradient() {
        return { addColorStop() {} };
    }

    createRadialGradient() {
        return { addColorStop() {} };
    }

    createPattern() {
        return null;
    }
}

function dashOn(dash, position) {
    let cursor = 0;
    for (let i = 0; i < dash.length; i++) {
        cursor += dash[i];
        if (position < cursor) return i % 2 === 0;
    }
    return true;
}

/**
 * Splice the frame's ground-cue records into an ordered GPU record list, right
 * after the terrain and retained cue texture and ahead of every other ground
 * record (agent contact shadows), so buildings and bodies occlude them exactly
 * as they occluded the retained texture.
 */
export function insertGroundCueRecords(ordered, cueRecords) {
    if (!Array.isArray(ordered) || !cueRecords?.length) return ordered;
    let at = 0;
    while (at < ordered.length) {
        const id = ordered[at]?.id;
        if (id === 'terrain:static' || id === 'ground:semantics' || isOffshoreRecordId(id)) at++;
        else break;
    }
    const tail = ordered.length - at;
    const count = cueRecords.length;
    ordered.length += count;
    for (let i = tail - 1; i >= 0; i--) ordered[at + count + i] = ordered[at + i];
    for (let i = 0; i < count; i++) ordered[at + i] = cueRecords[i];
    return ordered;
}
