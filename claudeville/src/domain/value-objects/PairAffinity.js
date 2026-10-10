/**
 * PairAffinity — persistent interaction memory between two villagers.
 *
 * Records are stored in the ChronicleStore `affinities` object store
 * (keyPath `pairKey`, where pairKey is the sorted pair of biography
 * identity keys joined with `|`). Counters (meetings, chats, shared
 * commits) are lifetime totals; the warmth `score` decays exponentially
 * from `lastInteractionAt`, so allies drift back toward strangers when
 * they stop working together.
 */

export const AFFINITY_SCHEMA_VERSION = 2;
const RECENT_INTERACTION_KEY_LIMIT = 192;
const RECENT_INTERACTION_KEYS_PER_CATEGORY = 64;

/** Warmth halves every 48 hours without interaction. */
export const AFFINITY_HALF_LIFE_MS = 48 * 60 * 60 * 1000;

const INTERACTION_WEIGHTS = {
    meeting: 1,
    chat: 2,
    sharedCommit: 3,
};

const ALLY_SCORE = 6;
const ACQUAINTANCE_SCORE = 1.5;

function nonNegativeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function compactInteractionKey(value) {
    const key = String(value || '').trim();
    if (key.length <= 180) return key;
    let hash = 2166136261;
    for (let index = 0; index < key.length; index++) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${key.slice(0, 120)}:${(hash >>> 0).toString(36)}`;
}

// The prefix before the first ':' names the category; read without
// allocating, since every admission and eviction asks.
function interactionCategory(key) {
    const text = String(key || '');
    if (text.startsWith('chat')) return 'chat';
    if (text === 'meeting' || text.startsWith('meeting:')) return 'meeting';
    if (text === 'git' || text.startsWith('git:')) return 'git';
    return 'other';
}

// Admits `key` to the bounded dedupe window. `keys` keeps arrival order;
// `index` (membership) and `counts` (per category) mirror it, so a repeated
// key or an admission never rescans the window. Past a bound, the oldest key
// of the newest key's category goes first, then the oldest of the largest.
function admitInteractionKey(keys, index, counts, key) {
    if (index.has(key)) return false;
    const newestCategory = interactionCategory(key);
    keys.push(key);
    index.add(key);
    counts.set(newestCategory, (counts.get(newestCategory) || 0) + 1);
    while (counts.get(newestCategory) > RECENT_INTERACTION_KEYS_PER_CATEGORY) {
        evictInteractionKey(keys, index, counts, newestCategory);
    }
    while (keys.length > RECENT_INTERACTION_KEY_LIMIT) {
        // Ties go to the category whose oldest key is oldest.
        const ordered = new Map();
        for (const existing of keys) {
            const category = interactionCategory(existing);
            ordered.set(category, (ordered.get(category) || 0) + 1);
        }
        const largestCategory = [...ordered].sort((a, b) => b[1] - a[1])[0]?.[0];
        evictInteractionKey(keys, index, counts, largestCategory);
    }
    return true;
}

function evictInteractionKey(keys, index, counts, category) {
    const at = keys.findIndex(key => interactionCategory(key) === category);
    const [removed] = keys.splice(at >= 0 ? at : 0, 1);
    index.delete(removed);
    const removedCategory = interactionCategory(removed);
    counts.set(removedCategory, counts.get(removedCategory) - 1);
}

function normalizeInteractionKeys(raw, index, counts) {
    const keys = [];
    const seen = new Set();
    for (const value of Array.isArray(raw) ? raw : []) {
        const key = compactInteractionKey(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        admitInteractionKey(keys, index, counts, key);
    }
    return keys;
}

/** Order-insensitive key for a pair of identity keys; null when degenerate. */
export function affinityPairKey(identityA, identityB) {
    const a = String(identityA || '').trim();
    const b = String(identityB || '').trim();
    if (!a || !b || a === b) return null;
    return [a, b].sort().join('|');
}

export class PairAffinity {
    constructor({
        pairKey,
        schemaVersion,
        identityA,
        identityB,
        meetings,
        chats,
        sharedCommits,
        firstMetAt,
        lastInteractionAt,
        score,
        scoreUpdatedAt,
        recentInteractionKeys,
    } = {}) {
        this.pairKey = String(pairKey || '');
        this.schemaVersion = Number(schemaVersion) || AFFINITY_SCHEMA_VERSION;
        const [a, b] = this.pairKey.split('|');
        this.identityA = String(identityA || a || '');
        this.identityB = String(identityB || b || '');
        this.meetings = nonNegativeNumber(meetings);
        this.chats = nonNegativeNumber(chats);
        this.sharedCommits = nonNegativeNumber(sharedCommits);
        this.firstMetAt = nonNegativeNumber(firstMetAt);
        this.lastInteractionAt = nonNegativeNumber(lastInteractionAt) || this.firstMetAt;
        this.score = nonNegativeNumber(score);
        this.scoreUpdatedAt = nonNegativeNumber(scoreUpdatedAt) || this.lastInteractionAt;
        this._recentKeyIndex = new Set();
        this._recentKeyCounts = new Map();
        this.recentInteractionKeys = normalizeInteractionKeys(
            recentInteractionKeys, this._recentKeyIndex, this._recentKeyCounts,
        );
    }

    static create(identityA, identityB, now = Date.now()) {
        const pairKey = affinityPairKey(identityA, identityB);
        if (!pairKey) return null;
        const [a, b] = pairKey.split('|');
        return new PairAffinity({
            pairKey,
            identityA: a,
            identityB: b,
            firstMetAt: now,
            lastInteractionAt: now,
            scoreUpdatedAt: now,
        });
    }

    /** Rehydrate from a persisted record; returns null when unusable. */
    static fromRecord(record) {
        if (!record || typeof record !== 'object' || !record.pairKey) return null;
        // v2 adds bounded interaction identities. Existing v1 records load
        // with an empty identity list and are migrated on their next write.
        return new PairAffinity(record);
    }

    toRecord() {
        return {
            pairKey: this.pairKey,
            schemaVersion: AFFINITY_SCHEMA_VERSION,
            identityA: this.identityA,
            identityB: this.identityB,
            meetings: this.meetings,
            chats: this.chats,
            sharedCommits: this.sharedCommits,
            firstMetAt: this.firstMetAt,
            lastInteractionAt: this.lastInteractionAt,
            score: this.score,
            scoreUpdatedAt: this.scoreUpdatedAt,
            recentInteractionKeys: [...this.recentInteractionKeys],
        };
    }

    involves(identityKey) {
        return identityKey === this.identityA || identityKey === this.identityB;
    }

    otherIdentity(identityKey) {
        if (identityKey === this.identityA) return this.identityB;
        if (identityKey === this.identityB) return this.identityA;
        return null;
    }

    /**
     * Apply one interaction of `kind` ('meeting' | 'chat' | 'sharedCommit'):
     * bumps the matching counter, settles decay up to `now`, and adds the
     * interaction weight to the warmth score.
     */
    recordInteraction(kind, now = Date.now(), interactionKey = null) {
        const weight = INTERACTION_WEIGHTS[kind];
        if (!weight) return false;
        if (interactionKey && !this.rememberInteraction(interactionKey)) return false;
        if (kind === 'meeting') this.meetings += 1;
        else if (kind === 'chat') this.chats += 1;
        else this.sharedCommits += 1;
        if (!this.firstMetAt) this.firstMetAt = now;
        this.score = this.decayedScore(now) + weight;
        this.scoreUpdatedAt = now;
        if (now > this.lastInteractionAt) this.lastInteractionAt = now;
        return true;
    }

    /**
     * Persist a compact interaction identity without changing lifetime totals.
     * Used to baseline telemetry that was already visible when a page loaded.
     */
    rememberInteraction(key) {
        const normalized = compactInteractionKey(key);
        if (!normalized) return false;
        return admitInteractionKey(
            this.recentInteractionKeys, this._recentKeyIndex, this._recentKeyCounts, normalized,
        );
    }

    /** Current warmth with exponential decay applied (not persisted). */
    decayedScore(now = Date.now()) {
        if (!this.score) return 0;
        const elapsed = Math.max(0, now - this.scoreUpdatedAt);
        if (!elapsed) return this.score;
        return this.score * Math.pow(0.5, elapsed / AFFINITY_HALF_LIFE_MS);
    }

    /** 'allies' | 'acquaintances' | 'strangers' based on decayed warmth. */
    tier(now = Date.now()) {
        const score = this.decayedScore(now);
        if (score >= ALLY_SCORE) return 'allies';
        if (score >= ACQUAINTANCE_SCORE) return 'acquaintances';
        return 'strangers';
    }
}
