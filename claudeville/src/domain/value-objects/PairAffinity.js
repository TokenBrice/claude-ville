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

export const AFFINITY_SCHEMA_VERSION = 1;

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
        // Schema v1 is current. When AFFINITY_SCHEMA_VERSION grows, migrate
        // older records here before constructing.
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
    recordInteraction(kind, now = Date.now()) {
        const weight = INTERACTION_WEIGHTS[kind];
        if (!weight) return false;
        if (kind === 'meeting') this.meetings += 1;
        else if (kind === 'chat') this.chats += 1;
        else this.sharedCommits += 1;
        if (!this.firstMetAt) this.firstMetAt = now;
        this.score = this.decayedScore(now) + weight;
        this.scoreUpdatedAt = now;
        if (now > this.lastInteractionAt) this.lastInteractionAt = now;
        return true;
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
