// The one audio scheduler (S4, ENG-8). A single 250 ms interval wakes every
// registered process and hands it a window of audio time to fill: sounds are
// placed on `AudioContext.currentTime` only, the timer merely wakes the
// scheduler. Music and environment look 1.5 s ahead (≥ 13× the measured p99
// timer lateness); a process may shorten its own horizon (work strikes stay
// ≤ 0.35 s ahead and cancellable). A window that opens late never smears its
// events onto now: the process drops what fell behind `from` and reports the
// count. Pause stops the waking; resume re-arms every process from the
// current audio time with no catch-up.
//
// A process is `{ name, schedule(from, to), horizon?, rearm?(now) }`:
// `schedule` places every event in [from, to) and may return how many events
// it dropped as late; `rearm(now)` moves an internal cursor that fell behind
// `now` (called on register and on resume).

export const TRANSPORT_INTERVAL_MS = 250;
export const TRANSPORT_HORIZON_SEC = 1.5;
// The work stratum's window (S4): strikes stay cancellable.
export const WORK_HORIZON_SEC = 0.35;
// Ticks kept for the p95 statistics: one minute at 4 Hz.
const STATS_WINDOW = 240;
// A renewal gap below this is treated as this (no runaway loops).
const MIN_RENEWAL_GAP_SEC = 0.005;

function percentile95(ring, count) {
    if (!count) return 0;
    const values = Array.from(ring.subarray(0, count)).sort((a, b) => a - b);
    return values[Math.min(count - 1, Math.ceil(count * 0.95) - 1)];
}

function monotonicMs() {
    return globalThis.performance?.now?.() ?? Date.now();
}

export class Transport {
    // `engine` is read lazily (`engine.context` may not exist yet). `timers`
    // and `clock` exist for tests; the app uses the globals.
    constructor(engine, {
        intervalMs = TRANSPORT_INTERVAL_MS,
        horizonSec = TRANSPORT_HORIZON_SEC,
        timers = globalThis,
        clock = monotonicMs,
    } = {}) {
        this.engine = engine;
        this.intervalMs = intervalMs;
        this.horizonSec = horizonSec;
        this._timers = timers;
        this._clock = clock;
        this._entries = new Map();
        this._interval = null;
        this.paused = false;
        this._destroyed = false;
        this._lastTickAt = null;
        this._ticks = 0;
        this._latency = new Float64Array(STATS_WINDOW);
        this._cost = new Float64Array(STATS_WINDOW);
        this._statsHead = 0;
        this._statsCount = 0;
        this._maxStallMs = 0;
        this._underruns = 0;
        this._lateDropped = 0;
        this._onTick = () => this._tick();
    }

    register(proc) {
        if (this._destroyed || !proc || typeof proc.schedule !== 'function') return proc;
        if (this._entries.has(proc)) return proc;
        const entry = {
            proc,
            name: String(proc.name || `process-${this._entries.size + 1}`),
            cursor: null,
            maxAheadSec: 0,
            dropped: 0,
        };
        this._entries.set(proc, entry);
        const now = this._now();
        if (now !== null) proc.rearm?.(now);
        // A process starts sounding at once, not up to one interval later.
        if (!this.paused && now !== null) this._run(entry, now);
        this._syncInterval();
        return proc;
    }

    unregister(proc) {
        if (!this._entries.delete(proc)) return;
        this._syncInterval();
    }

    // Stop waking processes. What is already committed stays on the audio
    // clock (a suspended context freezes it; the caller closes the groups).
    pause() {
        if (this.paused || this._destroyed) return;
        this.paused = true;
        this._lastTickAt = null;
        this._syncInterval();
    }

    // Re-arm every process from the current audio time: a window that ended
    // while paused is skipped, not caught up, and does not count as an
    // underrun.
    resume() {
        if (!this.paused || this._destroyed) return;
        this.paused = false;
        this._lastTickAt = null;
        const now = this._now();
        if (now !== null) {
            for (const entry of this._entries.values()) {
                if (entry.cursor !== null && entry.cursor < now) entry.cursor = now;
                entry.proc.rearm?.(now);
                this._run(entry, now);
            }
        }
        this._syncInterval();
    }

    destroy() {
        this._destroyed = true;
        this._entries.clear();
        this._syncInterval();
    }

    diagnostics() {
        const now = this._now() ?? 0;
        let aheadSec = 0;
        const processes = [];
        for (const entry of this._entries.values()) {
            const ahead = entry.cursor === null ? 0 : Math.max(0, entry.cursor - now);
            aheadSec = Math.max(aheadSec, ahead);
            processes.push({
                name: entry.name,
                horizon: this._horizon(entry.proc),
                aheadSec: ahead,
                maxAheadSec: entry.maxAheadSec,
                dropped: entry.dropped,
            });
        }
        return {
            running: this._interval !== null,
            paused: this.paused,
            ticks: this._ticks,
            tickLatenessP95: percentile95(this._latency, this._statsCount),
            tickMsP95: percentile95(this._cost, this._statsCount),
            maxStallMs: this._maxStallMs,
            underruns: this._underruns,
            lateDropped: this._lateDropped,
            aheadSec,
            processes,
        };
    }

    _now() {
        const t = this.engine?.context?.currentTime;
        return Number.isFinite(t) ? t : null;
    }

    _horizon(proc) {
        const own = Number(proc.horizon);
        return own > 0 ? Math.min(own, this.horizonSec) : this.horizonSec;
    }

    _syncInterval() {
        const wanted = !this._destroyed && !this.paused && this._entries.size > 0;
        if (wanted && this._interval === null) {
            this._lastTickAt = null;
            this._interval = this._timers.setInterval(this._onTick, this.intervalMs);
        } else if (!wanted && this._interval !== null) {
            this._timers.clearInterval(this._interval);
            this._interval = null;
        }
    }

    _tick() {
        const startedAt = this._clock();
        const lateness = this._lastTickAt === null
            ? 0
            : Math.max(0, startedAt - this._lastTickAt - this.intervalMs);
        this._lastTickAt = startedAt;
        const now = this._now();
        if (now === null || this.paused) return;
        this._ticks++;
        for (const entry of this._entries.values()) this._run(entry, now);
        const cost = this._clock() - startedAt;
        this._latency[this._statsHead] = lateness;
        this._cost[this._statsHead] = cost;
        this._statsHead = (this._statsHead + 1) % STATS_WINDOW;
        this._statsCount = Math.min(STATS_WINDOW, this._statsCount + 1);
        this._maxStallMs = Math.max(this._maxStallMs, lateness);
    }

    // One window for one process. A committed window that ran out before
    // this tick is an underrun: the next window opens at now and the process
    // drops (and reports) whatever fell into the gap.
    _run(entry, now) {
        let from = entry.cursor ?? now;
        if (from < now) {
            this._underruns++;
            from = now;
        }
        const to = now + this._horizon(entry.proc);
        if (to <= from) return;
        let dropped = 0;
        try {
            dropped = Number(entry.proc.schedule(from, to)) || 0;
        } catch (error) {
            console.error(`[audio] transport process ${entry.name} failed`, error);
        }
        entry.cursor = to;
        entry.maxAheadSec = Math.max(entry.maxAheadSec, to - now);
        if (dropped > 0) {
            entry.dropped += dropped;
            this._lateDropped += dropped;
        }
    }
}

// A renewal process on the audio clock: events at t₀, t₀ + gap(), … (a
// bird phrase, a cricket chirrup, a rain droplet). Each window emits the
// events inside it; an event already behind `from` (the window opened late)
// is dropped and counted, never moved to now. `first(now)` draws the wait
// before the first event after a (re)arm; `gap(t)` the wait after an event at
// audio time `t`; `emit(t)` places the sound.
export function renewalProcess({ name, horizon, first, gap, emit }) {
    let next = null;
    const wait = (fn, t) => Math.max(MIN_RENEWAL_GAP_SEC, Number(fn(t)) || 0);
    return {
        name,
        horizon,
        rearm(now) {
            if (next === null || next < now) next = now + wait(first, now);
        },
        schedule(from, to) {
            if (next === null) next = from + wait(first, from);
            let dropped = 0;
            while (next < to) {
                if (next >= from) emit(next);
                else dropped++;
                next += wait(gap, next);
            }
            return dropped;
        },
    };
}
