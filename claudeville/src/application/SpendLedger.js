import { eventBus } from '../domain/events/DomainEvent.js';
import { TokenUsage } from '../domain/value-objects/TokenUsage.js';

// What the topbar used to show was the sum of every resident session's
// lifetime cost. It lurched whenever a session appeared or aged out, it was
// not "today", and for a subscription account the dollar figure is a fiction:
// the currency that actually runs out is quota, not money.
//
// SpendLedger answers the question the product claims to answer — "am I
// burning tokens?" — with three honest numbers: what today has cost so far,
// how fast it is going right now, and how much quota is left.
//
// It works from deltas. Session token counts only ever grow, so the increase
// between two observations is spend that happened while we were watching. That
// makes "today" mean "today, as observed by this page" — stated plainly in the
// UI rather than dressed up as a complete account.

const RATE_WINDOW_MS = 5 * 60 * 1000;
// Extrapolating a ten-second burst to an hour produces nonsense. Say nothing
// until the window is wide enough for the number to mean something.
const RATE_MIN_WINDOW_MS = 2 * 60 * 1000;
const LEDGER_KEY_PREFIX = 'usageLedger:';

// Cache reads are the same prompt being re-read every turn, so they dominate
// any raw token count — a busy hour can "spend" hundreds of millions of them
// without new work happening. The headline counts tokens that are genuinely
// new; cache reads are tracked separately and priced into cost, where they
// belong.
function newTokens(usage) {
    const normalized = TokenUsage.normalize(usage);
    return normalized.totalInput + normalized.totalOutput + normalized.cacheCreate;
}

function cacheReadTokens(usage) {
    return TokenUsage.normalize(usage).cacheRead;
}

function localDateKey(ts = Date.now()) {
    const date = new Date(ts);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export class SpendLedger {
    constructor(world, { store = null } = {}) {
        this.world = world;
        this.store = store;
        this.running = false;
        this.date = localDateKey();
        this.today = { tokens: 0, cacheRead: 0, cost: 0 };
        this._lastSeen = new Map();   // agentId → { tokens, cost }
        this._samples = [];           // { ts, tokens, cost } inside the rate window
        this._loaded = false;
        this._writeTail = Promise.resolve();
    }

    async start() {
        if (this.running) return this;
        this.running = true;
        await this._load();
        this._onChange = () => this.sample();
        eventBus.on('agent:added', this._onChange);
        eventBus.on('agent:updated', this._onChange);
        // A removed agent's last observation stays banked; only the baseline goes.
        this._onRemoved = (agent) => this._lastSeen.delete(agent.id);
        eventBus.on('agent:removed', this._onRemoved);
        this.sample();
        return this;
    }

    stop() {
        if (!this.running) return this;
        this.running = false;
        eventBus.off('agent:added', this._onChange);
        eventBus.off('agent:updated', this._onChange);
        eventBus.off('agent:removed', this._onRemoved);
        return this;
    }

    /**
     * Fold the world's current token counts into today's total.
     *
     * A session first seen mid-flight contributes nothing retroactively — its
     * running total becomes the baseline, and only growth from there counts.
     * Anything else would let a long-running session dump hours of history into
     * "today" the moment the page opened.
     */
    sample(now = Date.now()) {
        const date = localDateKey(now);
        if (date !== this.date) this._rollOver(date);

        let tokenDelta = 0;
        let cacheDelta = 0;
        let costDelta = 0;

        for (const agent of this.world?.agents?.values?.() || []) {
            const tokens = newTokens(agent.tokens);
            const cacheRead = cacheReadTokens(agent.tokens);
            const cost = Number(agent.cost) || 0;
            const previous = this._lastSeen.get(agent.id);
            this._lastSeen.set(agent.id, { tokens, cacheRead, cost });
            if (!previous) continue;
            // Counters only grow; a decrease means the session was replaced or
            // recounted, so re-baseline instead of banking a negative.
            if (tokens > previous.tokens) tokenDelta += tokens - previous.tokens;
            if (cacheRead > previous.cacheRead) cacheDelta += cacheRead - previous.cacheRead;
            if (cost > previous.cost) costDelta += cost - previous.cost;
        }

        if (tokenDelta > 0 || cacheDelta > 0 || costDelta > 0) {
            this.today.tokens += tokenDelta;
            this.today.cacheRead += cacheDelta;
            this.today.cost += costDelta;
            this._samples.push({ ts: now, tokens: tokenDelta, cost: costDelta });
            this._persist();
        }

        const cutoff = now - RATE_WINDOW_MS;
        while (this._samples.length && this._samples[0].ts < cutoff) this._samples.shift();
        return this.today;
    }

    /**
     * Spend rate over the trailing window, extrapolated to an hour. Null until
     * there is enough of a window to say anything honest.
     */
    burnRate(now = Date.now()) {
        if (this._samples.length < 2) return null;
        const span = now - this._samples[0].ts;
        if (span < RATE_MIN_WINDOW_MS) return null;
        const hours = span / 3_600_000;
        const tokens = this._samples.reduce((sum, s) => sum + s.tokens, 0);
        const cost = this._samples.reduce((sum, s) => sum + s.cost, 0);
        return { tokensPerHour: tokens / hours, costPerHour: cost / hours };
    }

    _rollOver(date) {
        this.date = date;
        this.today = { tokens: 0, cacheRead: 0, cost: 0 };
        this._samples = [];
        // Baselines survive the rollover: a session running across midnight
        // should contribute its post-midnight growth to the new day, not all of
        // its lifetime.
    }

    async _load() {
        if (!this.store || this._loaded) return;
        this._loaded = true;
        try {
            const record = await this.store.get('meta', `${LEDGER_KEY_PREFIX}${this.date}`);
            if (record?.value) {
                this.today = {
                    tokens: Number(record.value.tokens) || 0,
                    cacheRead: Number(record.value.cacheRead) || 0,
                    cost: Number(record.value.cost) || 0,
                };
            }
        } catch { /* a missing ledger just starts the day at zero */ }
    }

    _persist() {
        if (!this.store) return;
        const key = `${LEDGER_KEY_PREFIX}${this.date}`;
        const value = { ...this.today };
        this._writeTail = this._writeTail
            .then(() => this.store.put('meta', { key, value }))
            .catch(() => { /* the ledger is best effort */ });
    }

    flush() {
        return this._writeTail;
    }
}
