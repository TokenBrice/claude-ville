// Seeded random streams for everything audio (S6, SOTA-16 step 1). Each
// consumer draws from its own named stream — a world layer never shares one
// with work or cue code, so how many agents are working cannot change the
// weather's dice. A stream is mulberry32 seeded from (seed, name): the same
// seed and name always yield the same sequence, and every rngStream() call
// starts that sequence afresh. The seed defaults to the local calendar day,
// so a day's island is reproducible and tomorrow's is different; tests and
// the probe pin it with setRngSeed().

let pinnedSeed = null;
let override = null;

// The local calendar day as YYYYMMDD.
export function daySeed(date = new Date()) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

// Pin the seed for streams created from now on; null returns to the day seed.
export function setRngSeed(seed) {
    pinnedSeed = seed == null ? null : String(seed);
}

export function rngSeed() {
    return pinnedSeed ?? String(daySeed());
}

// Probe only: while set, every stream (existing and new) returns `fn()`
// instead of its own draw, so renders can be compared with a fixed value.
export function setRngOverride(fn) {
    override = typeof fn === 'function' ? fn : null;
}

// FNV-1a over the UTF-16 code units, finished with murmur3's fmix32 so
// neighbouring names land far apart.
function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

// `() => number` in [0, 1).
export function rngStream(name) {
    if (typeof name !== 'string' || !name) throw new Error('rngStream needs a stream name');
    let state = hash32(`${rngSeed()}\u0000${name}`);
    return function next() {
        if (override) return override();
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
