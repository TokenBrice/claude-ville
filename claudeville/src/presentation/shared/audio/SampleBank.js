// Runtime-baked voices (plan S8, ENG-14) and the noise buffer pool (AMB-3).
//
// SampleBank: `bake(key, { client, seconds, channels, sampleRate, render })`
// queues a recipe; each idle slice (requestIdleCallback with a timeout, the
// AssetManager pattern) builds one OfflineAudioContext graph on the main
// thread, and the render itself runs off it. Nothing ever waits on a bake:
// `has(key)` / `play(key, …)` answer "not yet" and the caller synthesises
// live. Resident bytes (length × channels × 4) are accounted per client
// against Loudness.js MEMORY_BUDGET with LRU eviction; pinned entries (the
// Island Air IRs, the noise pool) are never evicted.
//
// NoisePool: long, co-prime, stereo noise buffers that every noise lane
// reads from its own seeded offset. Each colour is stored at the rate its
// consumers need (white 32 kHz, brown 8 kHz), which is what lets both loop
// periods exceed the 20 s the repetition check looks at inside the 8 MiB
// budget. The pool is built in idle slices after unlock and finished
// synchronously if a lane asks first.

import { MEMORY_BUDGET } from './Loudness.js';

export const SLICE_BUDGET_MS = 5;
const IDLE_TIMEOUT_MS = 2000;
const BYTES_PER_SAMPLE = 4;

export function bufferBytes(length, channels) {
    return Math.max(0, Math.floor(length)) * Math.max(1, Math.floor(channels)) * BYTES_PER_SAMPLE;
}

// Pure LRU + budget accounting. Map order is recency: the first unpinned
// entry is the least recently used.
export class BankLedger {
    constructor(budget = MEMORY_BUDGET) {
        this.budget = budget;
        this._entries = new Map();
        this._byClient = new Map();
        this._total = 0;
        this.evictions = 0;
    }

    get totalBytes() {
        return this._total;
    }

    clientBytes(client) {
        return this._byClient.get(client) ?? 0;
    }

    byClient() {
        return Object.fromEntries(this._byClient);
    }

    has(key) {
        return this._entries.has(key);
    }

    touch(key) {
        const entry = this._entries.get(key);
        if (!entry) return false;
        this._entries.delete(key);
        this._entries.set(key, entry);
        return true;
    }

    // Keys to evict so `bytes` more of `client` fits both its own budget and
    // the total; null when it cannot fit even after evicting every unpinned
    // entry allowed to go. Replacing `key` counts its current bytes as free.
    plan(client, bytes, key = null) {
        const clientBudget = this.budget[client];
        if (!(clientBudget > 0)) throw new Error(`Unknown SampleBank client: ${client}`);
        const replaced = key !== null ? this._entries.get(key) : null;
        let clientUsed = this.clientBytes(client) - (replaced?.client === client ? replaced.bytes : 0);
        let total = this._total - (replaced?.bytes ?? 0);
        if (bytes > clientBudget || bytes > this.budget.totalBytes) return null;
        const evict = [];
        for (const [k, entry] of this._entries) {
            if (clientUsed + bytes <= clientBudget) break;
            if (k === key || entry.pinned || entry.client !== client) continue;
            evict.push(k);
            clientUsed -= entry.bytes;
            total -= entry.bytes;
        }
        if (clientUsed + bytes > clientBudget) return null;
        for (const [k, entry] of this._entries) {
            if (total + bytes <= this.budget.totalBytes) break;
            if (k === key || entry.pinned || evict.includes(k)) continue;
            evict.push(k);
            total -= entry.bytes;
        }
        if (total + bytes > this.budget.totalBytes) return null;
        return evict;
    }

    // Admit an entry (evicting per plan()); returns the evicted keys, or
    // null (nothing changed) when it does not fit.
    admit(key, client, bytes, { pinned = false } = {}) {
        const evict = this.plan(client, bytes, key);
        if (!evict) return null;
        for (const k of evict) {
            this.remove(k);
            this.evictions++;
        }
        this.remove(key);
        this._entries.set(key, { client, bytes, pinned });
        this._byClient.set(client, this.clientBytes(client) + bytes);
        this._total += bytes;
        return evict;
    }

    remove(key) {
        const entry = this._entries.get(key);
        if (!entry) return false;
        this._entries.delete(key);
        const left = this.clientBytes(entry.client) - entry.bytes;
        if (left > 0) this._byClient.set(entry.client, left);
        else this._byClient.delete(entry.client);
        this._total -= entry.bytes;
        return true;
    }
}

function defaultNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class SampleBank {
    // `engine` supplies the context and connectVoice for play(); `idle`,
    // `cancelIdle`, `now` and `createOffline` exist for tests.
    constructor(engine, {
        budget = MEMORY_BUDGET,
        idle = null,
        cancelIdle = null,
        now = defaultNow,
        createOffline = null,
    } = {}) {
        this.engine = engine;
        this.ledger = new BankLedger(budget);
        this._buffers = new Map();
        this._queue = [];
        this._jobs = new Map();
        this._idle = idle || (typeof requestIdleCallback === 'function'
            ? (fn) => requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS })
            : (fn) => setTimeout(() => fn({ didTimeout: true, timeRemaining: () => 0 }), 0));
        this._cancelIdle = cancelIdle || (typeof cancelIdleCallback === 'function' && !idle
            ? cancelIdleCallback
            : (handle) => clearTimeout(handle));
        this._now = now;
        this._createOffline = createOffline || ((channels, length, sampleRate) =>
            new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate }));
        this._handle = null;
        this._rendering = false;
        this._destroyed = false;
        this._stats = { bakes: 0, slices: 0, sliceMsMax: 0, failed: 0, bakeMsTotal: 0, bakeMsMax: 0 };
    }

    has(key) {
        return this._buffers.has(key);
    }

    // The baked buffer (marks it recently used), or null.
    get(key) {
        const buffer = this._buffers.get(key) ?? null;
        if (buffer) this.ledger.touch(key);
        return buffer;
    }

    // Queue a bake. Resolves true once `key` is resident, false when it
    // cannot fit, fails or the bank is destroyed. Never awaited by sound.
    bake(key, { client, seconds, channels = 1, sampleRate = 48000, render, finish = null, pinned = false } = {}) {
        if (this._buffers.has(key)) return Promise.resolve(true);
        const queued = this._jobs.get(key);
        if (queued) return queued.promise;
        if (this._destroyed || typeof render !== 'function') return Promise.resolve(false);
        const length = Math.max(1, Math.ceil(Number(seconds) * sampleRate));
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const job = { key, client, length, channels, sampleRate, render, finish, pinned, promise, resolve };
        this._jobs.set(key, job);
        this._queue.push(job);
        this._schedule();
        return promise;
    }

    // Account a buffer built elsewhere (the noise pool) under `client`.
    // Returns false (and keeps nothing) when it does not fit.
    adopt(key, client, buffer, { pinned = true } = {}) {
        if (this._destroyed || !buffer) return false;
        return this._store(key, client, buffer, pinned);
    }

    // Play a baked buffer through the engine's voice helper; null when the
    // key is not resident (the caller synthesises live instead).
    play(key, t, { gain = 1, rate = 1, pan = 0, air = 0, bus = 'cue', lowpassHz = null } = {}) {
        const ctx = this.engine?.context;
        const buffer = ctx ? this.get(key) : null;
        if (!buffer) return null;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        const level = ctx.createGain();
        level.gain.value = gain;
        source.connect(level);
        const voice = this.engine.connectVoice(level, { bus, pan, air, lowpassHz });
        source.addEventListener('ended', () => {
            try { source.disconnect(); } catch { /* already disconnected */ }
            voice.dispose();
        }, { once: true });
        source.start(Math.max(ctx.currentTime, Number(t) || 0));
        return source;
    }

    stats() {
        return {
            residentBytes: this.ledger.totalBytes,
            byClient: this.ledger.byClient(),
            budgetBytes: this.ledger.budget.totalBytes,
            evictions: this.ledger.evictions,
            bakes: this._stats.bakes,
            failed: this._stats.failed,
            slices: this._stats.slices,
            sliceMsMax: Math.round(this._stats.sliceMsMax * 100) / 100,
            // Wall time from a job's first slice to its buffer being stored.
            bakeMsTotal: Math.round(this._stats.bakeMsTotal * 10) / 10,
            bakeMsMax: Math.round(this._stats.bakeMsMax * 10) / 10,
            pending: this._jobs.size,
        };
    }

    // Run `fn` in its own idle slice (the noise pool's chunked build).
    // Returns a cancel function.
    slice(fn) {
        if (this._destroyed) return () => {};
        let handle = this._idle(() => {
            handle = null;
            if (this._destroyed) return;
            this.timed(fn);
        });
        return () => {
            if (handle !== null) this._cancelIdle(handle);
            handle = null;
        };
    }

    destroy() {
        this._destroyed = true;
        if (this._handle !== null) this._cancelIdle(this._handle);
        this._handle = null;
        for (const job of this._jobs.values()) job.resolve(false);
        this._jobs.clear();
        this._queue = [];
        this._buffers.clear();
        for (const key of [...this.ledger._entries.keys()]) this.ledger.remove(key);
    }

    // Run `fn` on the main thread and count it as a slice (stats).
    timed(fn) {
        const start = this._now();
        try {
            return fn();
        } finally {
            const ms = this._now() - start;
            this._stats.slices++;
            if (ms > this._stats.sliceMsMax) this._stats.sliceMsMax = ms;
        }
    }

    _schedule() {
        if (this._destroyed || this._handle !== null || this._rendering || !this._queue.length) return;
        this._handle = this._idle(() => {
            this._handle = null;
            this._pump();
        });
    }

    // One job per slice: plan the budget, build the offline graph, start the
    // render; the result is stored when the render resolves.
    _pump() {
        if (this._destroyed || this._rendering) return;
        const job = this._queue.shift();
        if (!job) return;
        job.startedAt = this._now();
        let rendering = null;
        this.timed(() => {
            if (!this.ledger.plan(job.client, bufferBytes(job.length, job.channels), job.key)) return;
            const offline = this._createOffline(job.channels, job.length, job.sampleRate);
            job.render(offline);
            rendering = offline.startRendering();
        });
        if (!rendering) {
            this._finishJob(job, false);
            return;
        }
        this._rendering = true;
        Promise.resolve(rendering).then((buffer) => {
            if (this._destroyed) return false;
            return this.timed(() => {
                if (job.finish) job.finish(buffer);
                return this._store(job.key, job.client, buffer, job.pinned);
            });
        }, () => false).then((ok) => {
            this._rendering = false;
            this._finishJob(job, ok);
        });
    }

    _finishJob(job, ok) {
        if (this._jobs.get(job.key) === job) this._jobs.delete(job.key);
        if (ok) {
            this._stats.bakes++;
            const ms = this._now() - job.startedAt;
            this._stats.bakeMsTotal += ms;
            if (ms > this._stats.bakeMsMax) this._stats.bakeMsMax = ms;
        } else {
            this._stats.failed++;
        }
        job.resolve(Boolean(ok) && !this._destroyed);
        this._schedule();
    }

    _store(key, client, buffer, pinned) {
        const evicted = this.ledger.admit(key, client, bufferBytes(buffer.length, buffer.numberOfChannels), { pinned });
        if (!evicted) return false;
        for (const k of evicted) this._buffers.delete(k);
        this._buffers.set(key, buffer);
        return true;
    }
}

// ----------------------------------------------------------------- noise pool

// Per colour: stored rate, prime buffer lengths (co-prime loop periods, all
// > 20 s) and level. Each continuous lane gets a buffer of its own while
// there are enough (brown: wind, rain rumble, murmur), so no two lanes of a
// texture are the same noise at a fixed lag. Levels keep today's in-band
// noise: white is uniform ±0.6 at 48 kHz in power density (±0.6·√(32/48) at
// 32 kHz); brown is today's one-pole low-pass of that white (corner
// 151.3 Hz, RMS 0.184), rebuilt at 5 kHz (its consumers sit below 1.2 kHz).
export const NOISE_POOL = Object.freeze({
    white: Object.freeze({ sampleRate: 32000, frames: Object.freeze([681607]), peak: 0.6 * Math.sqrt(32000 / 48000) }),
    brown: Object.freeze({ sampleRate: 5000, frames: Object.freeze([110251, 113051, 115853]), cornerHz: 151.28, rms: 0.184 }),
});
// Inter-channel correlation baked into every pool buffer: wide but not
// hollow (world-bed ICC 0.15–0.5; mono fold of a lane −1.6 dB).
export const NOISE_ICC = 0.35;
// Loop seam: the last 50 ms blend into the start (equal power, independent noise).
export const NOISE_SEAM_SEC = 0.05;
// Read heads on one buffer stay this far apart (buffer seconds) for as
// long as both lanes live.
export const LANE_SEPARATION_SEC = 5;
// A one-shot lane's assumed life until its stop() says otherwise.
export const ONE_SHOT_LIFE_SEC = 8;
const LANE_CANDIDATES = 16;
// An allocated, unstarted lane holds its head this long (≥ the Transport horizon).
const LANE_RESERVE_SEC = 2;
const CHUNK_FRAMES = 65536;

function xorshiftSeed(rng) {
    return (Math.floor(rng() * 4294967295) >>> 0) || 0x9e3779b9;
}

// Chunked generator for one pool buffer: fills two Float32Arrays of
// frames + seam, `step()` advances one chunk, `done` once full.
export class NoiseBuild {
    constructor(color, index, rng) {
        const spec = NOISE_POOL[color];
        if (!spec || !(index >= 0 && index < spec.frames.length)) throw new Error(`Unknown noise buffer: ${color}:${index}`);
        this.color = color;
        this.spec = spec;
        this.frames = spec.frames[index];
        this.seam = Math.round(NOISE_SEAM_SEC * spec.sampleRate);
        const total = this.frames + this.seam;
        this.left = new Float32Array(total);
        this.right = new Float32Array(total);
        this.i = 0;
        this.sA = xorshiftSeed(rng);
        this.sB = xorshiftSeed(rng);
        this.yL = 0;
        this.yR = 0;
        if (color === 'brown') {
            this.a = Math.exp(-2 * Math.PI * spec.cornerHz / spec.sampleRate);
            // Uniform ±1 has variance 1/3; a one-pole's output variance is
            // b²·σ²/(1 − a²).
            this.b = spec.rms * Math.sqrt(3 * (1 - this.a * this.a));
        }
    }

    get done() {
        return this.i >= this.left.length;
    }

    step(maxFrames = CHUNK_FRAMES) {
        const { left, right } = this;
        const end = Math.min(left.length, this.i + maxFrames);
        const mix = Math.sqrt(1 - NOISE_ICC * NOISE_ICC);
        let sA = this.sA;
        let sB = this.sB;
        const brown = this.color === 'brown';
        const peak = this.spec.peak;
        const a = this.a;
        const b = this.b;
        let yL = this.yL;
        let yR = this.yR;
        for (let i = this.i; i < end; i++) {
            sA ^= sA << 13; sA ^= sA >>> 17; sA ^= sA << 5;
            sB ^= sB << 13; sB ^= sB >>> 17; sB ^= sB << 5;
            const wA = (sA >>> 0) / 2147483648 - 1;
            const wB = (sB >>> 0) / 2147483648 - 1;
            const wR = NOISE_ICC * wA + mix * wB;
            if (brown) {
                yL = a * yL + b * wA;
                yR = a * yR + b * wR;
                left[i] = yL;
                right[i] = yR;
            } else {
                left[i] = peak * wA;
                right[i] = peak * wR;
            }
        }
        this.sA = sA;
        this.sB = sB;
        this.yL = yL;
        this.yR = yR;
        this.i = end;
        return this.done;
    }

    // Bake the loop seam: the first `seam` frames crossfade from the
    // continuation past the end (what the loop jumps from) into the start.
    // Returns the two channels, `frames` long.
    finish() {
        while (!this.done) this.step(Infinity);
        const n = this.frames;
        for (const data of [this.left, this.right]) {
            for (let i = 0; i < this.seam; i++) {
                const x = (i + 0.5) / this.seam * Math.PI / 2;
                data[i] = data[i] * Math.sin(x) + data[n + i] * Math.cos(x);
            }
        }
        return [this.left.subarray(0, n), this.right.subarray(0, n)];
    }
}

// Circular distance between two read heads on a loop of `period` seconds.
export function loopDistance(a, b, period) {
    const d = Math.abs(((a - b) % period + period) % period);
    return Math.min(d, period - d);
}

// The closest two lanes on one loop come while both live. A lane is
// { offset (buffer s), start (audio s), rate, end (audio s, Infinity while
// open) }. Heads at different rates on overlapping open-ended lives
// eventually meet (0).
export function laneMargin(a, b, period) {
    const from = Math.max(a.start, b.start);
    const to = Math.min(a.end, b.end);
    if (!(to >= from)) return Infinity;
    const gap = t => (a.offset + (t - a.start) * a.rate) - (b.offset + (t - b.start) * b.rate);
    const x0 = ((gap(from) % period) + period) % period;
    const drift = a.rate - b.rate;
    if (Math.abs(drift) < 1e-9) return Math.min(x0, period - x0);
    if (!Number.isFinite(to)) return 0;
    const x1 = x0 + drift * (to - from);
    // Crossing zero (either way round the loop) means the heads met.
    if (x1 <= 0 || x1 >= period) return 0;
    // min(x, P − x) is concave on [0, P]: its minimum sits at an endpoint.
    return Math.min(x0, period - x0, x1, period - x1);
}

// Choose { index, offset } for a new lane among `periods` (one per buffer):
// the first of LANE_CANDIDATES rng draws whose margin to every lane it must
// avoid stays ≥ LANE_SEPARATION_SEC, else the best draw. Continuous lanes
// only consider the least-used buffers and only avoid continuous lanes;
// one-shots may use any buffer and avoid every lane.
export function pickLane(rng, periods, lanes, lane) {
    const avoid = lane.oneShot ? lanes : lanes.filter(l => !l.oneShot);
    let indices = periods.map((_, i) => i);
    if (!lane.oneShot) {
        const load = indices.map(i => avoid.filter(l => l.index === i).length);
        const least = Math.min(...load);
        indices = indices.filter(i => load[i] === least);
    }
    let best = null;
    let bestMargin = -1;
    for (let k = 0; k < LANE_CANDIDATES; k++) {
        const index = indices[Math.min(indices.length - 1, Math.floor(rng() * indices.length))];
        const period = periods[index];
        const candidate = { ...lane, index, offset: rng() * period };
        let margin = Infinity;
        for (const other of avoid) {
            if (other.index === index) margin = Math.min(margin, laneMargin(candidate, other, period));
        }
        if (margin >= LANE_SEPARATION_SEC) return { index, offset: candidate.offset };
        if (margin > bestMargin) {
            best = { index, offset: candidate.offset };
            bestMargin = margin;
        }
    }
    return best;
}

export class NoisePool {
    // `rngFor(key)` → the stream that fills pool buffer `key` ('brown:1').
    constructor(bank, rngFor) {
        this.bank = bank;
        this._rngFor = rngFor;
        this._buffers = new Map();
        this._builds = new Map();
        this._cancel = null;
        this._lanes = new Map();
        this._destroyed = false;
    }

    // Build every pool buffer in idle slices (from unlock on).
    prebuild() {
        if (this._destroyed || this._cancel) return;
        const keys = Object.entries(NOISE_POOL).flatMap(([color, spec]) => spec.frames.map((_, i) => `${color}:${i}`));
        const next = () => {
            this._cancel = null;
            const key = keys.find(k => !this._buffers.has(k));
            if (!key || this._destroyed) return;
            this._cancel = this.bank.slice(() => {
                // A lane may have finished this buffer synchronously meanwhile.
                if (!this._buffers.has(key) && this._build(key).step()) this._complete(key);
                next();
            });
        };
        next();
    }

    // The colour's buffers; any a lane needs before the idle build finished
    // are finished now, timed as a slice in the bank's stats.
    buffers(color) {
        const spec = NOISE_POOL[color];
        if (!spec) throw new Error(`Unknown noise colour: ${color}`);
        const keys = spec.frames.map((_, i) => `${color}:${i}`);
        if (keys.some(k => !this._buffers.has(k))) {
            this.bank.timed(() => {
                for (const key of keys) if (!this._buffers.has(key)) this._complete(key);
            });
        }
        return keys.map(k => this._buffers.get(k) ?? null);
    }

    // An unstarted, looping source of `color`. Its buffer and start offset
    // are chosen when first needed — reading `startOffset` or calling
    // `start(t)` — so a one-shot's playbackRate (set by the caller before
    // then) is known and its head keeps ≥ 5 s from every live lane for its
    // whole life.
    source(ctx, color, { rng, oneShot = false } = {}) {
        if (typeof rng !== 'function') throw new Error('noiseSource needs an rng stream');
        const buffers = this.buffers(color);
        if (buffers.some(b => !b)) return null;
        const lanes = this._lanesOf(color);
        const src = ctx.createBufferSource();
        src.loop = true;
        let lane = null;
        const allocate = (at) => {
            if (lane) return lane;
            for (const other of lanes) {
                if (other.reservedUntil !== null && at > other.reservedUntil) lanes.delete(other);
            }
            const rate = src.playbackRate.value;
            const life = { start: at, rate, end: oneShot ? at + ONE_SHOT_LIFE_SEC / Math.max(rate, 0.1) : Infinity, oneShot };
            const { index, offset } = pickLane(rng, buffers.map(b => b.duration), [...lanes], life);
            lane = { ...life, index, offset, reservedUntil: at + LANE_RESERVE_SEC };
            lanes.add(lane);
            src.buffer = buffers[index];
            return lane;
        };
        Object.defineProperty(src, 'startOffset', { get: () => allocate(ctx.currentTime).offset });
        const nativeStart = src.start;
        const nativeStop = src.stop;
        src.start = (when = 0, startOffset, duration) => {
            const at = Math.max(ctx.currentTime, Number(when) || 0);
            const own = allocate(at);
            own.offset = startOffset ?? own.offset;
            own.start = at;
            own.rate = src.playbackRate.value;
            if (duration !== undefined) own.end = Math.min(own.end, at + Number(duration) / Math.max(own.rate, 0.1));
            own.reservedUntil = null;
            src.addEventListener('ended', () => lanes.delete(own), { once: true });
            if (duration === undefined) nativeStart.call(src, when, own.offset);
            else nativeStart.call(src, when, own.offset, duration);
        };
        src.stop = (when = 0) => {
            if (lane) lane.end = Math.min(lane.end, Math.max(ctx.currentTime, Number(when) || 0));
            nativeStop.call(src, when);
        };
        return src;
    }

    residentBytes() {
        let bytes = 0;
        for (const buffer of this._buffers.values()) bytes += bufferBytes(buffer.length, buffer.numberOfChannels);
        return bytes;
    }

    destroy() {
        this._destroyed = true;
        this._cancel?.();
        this._cancel = null;
        this._builds.clear();
        this._buffers.clear();
        this._lanes.clear();
    }

    _lanesOf(color) {
        let lanes = this._lanes.get(color);
        if (!lanes) {
            lanes = new Set();
            this._lanes.set(color, lanes);
        }
        return lanes;
    }

    _build(key) {
        let build = this._builds.get(key);
        if (!build) {
            const [color, index] = key.split(':');
            build = new NoiseBuild(color, Number(index), this._rngFor(key));
            this._builds.set(key, build);
        }
        return build;
    }

    _complete(key) {
        if (this._buffers.has(key)) return this._buffers.get(key);
        const build = this._build(key);
        const [left, right] = build.finish();
        this._builds.delete(key);
        const buffer = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate: build.spec.sampleRate });
        buffer.copyToChannel(left, 0);
        buffer.copyToChannel(right, 1);
        if (!this.bank.adopt(`noise:${key}`, 'noise', buffer, { pinned: true })) return null;
        this._buffers.set(key, buffer);
        return buffer;
    }
}
