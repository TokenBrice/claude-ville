// Central rate limiter for one-shot cues — the structural fix for v0.12's
// wall-of-beeps. Every cue passes three gates: a per-kind cooldown, a global
// minimum spacing, and a sliding per-minute budget. Excess cues are dropped,
// never queued: a moment that has passed should not chime later.

export class CueGovernor {
    constructor({ maxPerMinute = 6, minSpacingMs = 4000 } = {}) {
        this.maxPerMinute = maxPerMinute;
        this.minSpacingMs = minSpacingMs;
        this._lastByKind = new Map();
        this._recent = [];
    }

    // `budget: false` exempts a cue from the global gates (weather/clock cues
    // like thunder and the hour bell are scenery, not village chatter).
    allow(kind, cooldownMs = 15000, { budget = true } = {}) {
        const now = Date.now();
        const last = this._lastByKind.get(kind) || 0;
        if (now - last < cooldownMs) return false;

        if (budget) {
            this._recent = this._recent.filter(t => now - t < 60000);
            if (this._recent.length >= this.maxPerMinute) return false;
            const newest = this._recent[this._recent.length - 1];
            if (newest && now - newest < this.minSpacingMs) return false;
            this._recent.push(now);
        }

        this._lastByKind.set(kind, now);
        return true;
    }
}
