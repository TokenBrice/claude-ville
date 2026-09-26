// Note-timed duck windows for one bus (ENG-5, plan S3). Pure: no Web Audio.
//
// A window is a trapezoid in linear gain: unity until `from − attack`, a
// linear ramp to the window's depth at `from` (the first heard note), held
// to `until` (the last note + its hold), and a linear ramp back to unity
// over `release`. Overlapping windows combine deepest-wins (the per-time
// minimum), no window is deeper than DUCK_FLOOR_DB, and removing a window
// (a cancelled cue) recomputes the envelope without it.
//
// `curve(now)` returns the envelope's vertices after `now` as `{ t, gain }`
// points; the engine replays them onto the bus duck gain as linear ramps
// after holding the param at `now`. The minimum of piecewise-linear
// trapezoids is piecewise linear, so the vertices (window corners plus the
// crossings between them) describe it exactly.

export const DUCK_FLOOR_DB = -9;
export const DEFAULT_DUCK_ATTACK_SEC = 0.04;
export const DEFAULT_DUCK_RELEASE_SEC = 0.6;
// Every ramp is at least this long (S8: a gain move ≥ 60 ms never clicks).
const MIN_RELEASE_SEC = 0.06;
const MIN_ATTACK_SEC = 0.005;
const EPS = 1e-9;

export function dbToGain(db) {
    return Math.pow(10, db / 20);
}

function windowGainAt(w, t) {
    if (t <= w.start || t >= w.end) return 1;
    if (t < w.from) return 1 + (w.gain - 1) * (t - w.start) / (w.from - w.start);
    if (t <= w.until) return w.gain;
    return w.gain + (1 - w.gain) * (t - w.until) / (w.end - w.until);
}

export class DuckScheduler {
    constructor() {
        this._windows = new Map();
        this._nextId = 1;
    }

    get size() {
        return this._windows.size;
    }

    // Returns the window id, or null when the window ducks nothing.
    add({ from, until, depthDb, attack = DEFAULT_DUCK_ATTACK_SEC, release = DEFAULT_DUCK_RELEASE_SEC }) {
        const depth = Number(depthDb);
        const start = Number(from);
        if (!Number.isFinite(depth) || depth >= 0 || !Number.isFinite(start)) return null;
        const clampedDb = Math.max(DUCK_FLOOR_DB, depth);
        const a = Math.max(MIN_ATTACK_SEC, Number(attack) || 0);
        const r = Math.max(MIN_RELEASE_SEC, Number(release) || 0);
        const hold = Math.max(start, Number(until) || start);
        const id = this._nextId++;
        this._windows.set(id, {
            start: start - a,
            from: start,
            until: hold,
            end: hold + r,
            gain: dbToGain(clampedDb),
        });
        return id;
    }

    // Returns true when the window existed.
    remove(id) {
        return this._windows.delete(id);
    }

    // Is the window shaping the envelope at `t` (between its first and last corner)?
    isActive(id, t) {
        const w = this._windows.get(id);
        return Boolean(w && t > w.start && t < w.end);
    }

    // Drop windows that have fully released by `now`.
    prune(now) {
        for (const [id, w] of this._windows) {
            if (w.end <= now) this._windows.delete(id);
        }
    }

    valueAt(t) {
        let gain = 1;
        for (const w of this._windows.values()) {
            const g = windowGainAt(w, t);
            if (g < gain) gain = g;
        }
        return gain;
    }

    // Envelope vertices strictly after `now`, ending at unity; [] when no
    // window reaches past `now`.
    curve(now) {
        const windows = [...this._windows.values()].filter(w => w.end > now);
        if (!windows.length) return [];
        const corners = new Set();
        for (const w of windows) {
            for (const t of [w.start, w.from, w.until, w.end]) if (t > now) corners.add(t);
        }
        const times = [now, ...[...corners].sort((x, y) => x - y)];
        const candidates = [...times];
        // Inside one interval every window is a straight line; the envelope
        // can only bend where two of those lines cross.
        for (let i = 0; i + 1 < times.length; i++) {
            const t0 = times[i];
            const t1 = times[i + 1];
            if (t1 - t0 <= EPS) continue;
            const lines = windows.map(w => [windowGainAt(w, t0), windowGainAt(w, t1)]);
            for (let p = 0; p < lines.length; p++) {
                for (let q = p + 1; q < lines.length; q++) {
                    const d0 = lines[p][0] - lines[q][0];
                    const d1 = lines[p][1] - lines[q][1];
                    if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) {
                        candidates.push(t0 + (t1 - t0) * d0 / (d0 - d1));
                    }
                }
            }
        }
        candidates.sort((x, y) => x - y);
        const points = [];
        for (const t of candidates) {
            if (points.length && t - points.at(-1).t <= EPS) continue;
            points.push({ t, gain: this.valueAt(t) });
        }
        // Drop interior points that lie on the line through their neighbours.
        const kept = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            const prev = kept.at(-1);
            const next = points[i + 1];
            const cur = points[i];
            const expected = prev.gain + (next.gain - prev.gain) * (cur.t - prev.t) / (next.t - prev.t);
            if (Math.abs(expected - cur.gain) > 1e-7) kept.push(cur);
        }
        if (points.length > 1) kept.push(points.at(-1));
        return kept.filter(p => p.t > now);
    }
}
