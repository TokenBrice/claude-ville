/**
 * AgentBiography — persistent, cross-session memory for a villager.
 *
 * Records are stored in the ChronicleStore `biographies` object store
 * (keyPath `identityKey`) and carry a `schemaVersion` so later work
 * (mood arcs, relationship affinity) can extend the shape. New fields
 * belonging to those systems should live under `extensions` keyed by
 * feature (e.g. `extensions.mood`, `extensions.affinity`).
 */

export const BIOGRAPHY_SCHEMA_VERSION = 3;

const RECENT_PUSH_KEY_LIMIT = 96;

const FIRST_SEEN_MILESTONE = { id: 'first-seen', label: 'Settled in the village' };
const FOUNDER_MILESTONE = { id: 'village-founder', label: 'Founded the village', nickname: 'the Founder' };

const MILESTONE_TRACKS = [
    {
        stat: 'sessionsCompleted',
        thresholds: [1, 10, 50, 100, 500],
        label: (n) => (n === 1 ? 'First session completed' : `${n} sessions completed`),
    },
    {
        stat: 'commitsPushed',
        thresholds: [1, 10, 50, 100, 500],
        label: (n) => (n === 1 ? 'First push to the harbor' : `${n} pushes to the harbor`),
    },
    {
        stat: 'lifetimeTokens',
        thresholds: [1e6, 1e7, 1e8, 1e9],
        label: (n) => `${formatTokenCount(n)} lifetime tokens`,
    },
    {
        stat: 'errorsRecovered',
        thresholds: [1, 10, 50, 100],
        label: (n) => (n === 1 ? 'First error overcome' : `${n} errors overcome`),
    },
];

// Earned nicknames: when a stat crosses its threshold, a nickname-bearing
// milestone is recorded. The latest-earned nickname is the current one.
const NICKNAME_TRACKS = [
    { stat: 'errorsRecovered', threshold: 10, nickname: 'the Debugger' },
    { stat: 'commitsPushed', threshold: 25, nickname: 'the Shipwright' },
    { stat: 'sessionsCompleted', threshold: 25, nickname: 'the Veteran' },
    { stat: 'lifetimeTokens', threshold: 1e8, nickname: 'the Tokensmith' },
];

function formatTokenCount(n) {
    if (n >= 1e9) return `${n / 1e9}B`;
    return `${n / 1e6}M`;
}

function nonNegativeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function slug(value) {
    const out = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return out || 'unknown';
}

function compactEventKey(value) {
    const key = String(value || '').trim();
    if (key.length <= 180) return key;
    let hash = 2166136261;
    for (let index = 0; index < key.length; index++) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${key.slice(0, 120)}:${(hash >>> 0).toString(36)}`;
}

function normalizeMilestones(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
        const id = String(entry?.id || '').trim();
        if (!id) continue;
        const milestone = {
            id,
            at: nonNegativeNumber(entry?.at),
            label: String(entry?.label || id),
        };
        const nickname = String(entry?.nickname || '').trim();
        if (nickname) milestone.nickname = nickname;
        out.push(milestone);
    }
    return out;
}

function normalizePushMemory(raw) {
    const recentPushKeys = [];
    const seen = new Set();
    for (const value of Array.isArray(raw?.recentPushKeys) ? raw.recentPushKeys : []) {
        const key = compactEventKey(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        recentPushKeys.push(key);
    }
    return {
        pushWatermarkAt: nonNegativeNumber(raw?.pushWatermarkAt),
        recentPushKeys: recentPushKeys.slice(-RECENT_PUSH_KEY_LIMIT),
    };
}

export class AgentBiography {
    constructor({
        identityKey,
        schemaVersion,
        firstSeenAt,
        lastSeenAt,
        sessionsCompleted,
        commitsPushed,
        lifetimeTokens,
        errorsRecovered,
        milestones,
        extensions,
    } = {}) {
        this.identityKey = String(identityKey || '');
        this.schemaVersion = Number(schemaVersion) || BIOGRAPHY_SCHEMA_VERSION;
        this.firstSeenAt = nonNegativeNumber(firstSeenAt);
        this.lastSeenAt = nonNegativeNumber(lastSeenAt) || this.firstSeenAt;
        this.sessionsCompleted = nonNegativeNumber(sessionsCompleted);
        this.commitsPushed = nonNegativeNumber(commitsPushed);
        this.lifetimeTokens = nonNegativeNumber(lifetimeTokens);
        this.errorsRecovered = nonNegativeNumber(errorsRecovered);
        this.milestones = normalizeMilestones(milestones);
        const rawExtensions = (extensions && typeof extensions === 'object') ? extensions : {};
        this.extensions = {
            ...rawExtensions,
            biographyEvents: normalizePushMemory(rawExtensions.biographyEvents),
        };
    }

    /**
     * Resolve the stable identity that biography state accumulates under.
     *
     * Precedence:
     * 1. Team/custom-named agents keep their given name across sessions
     *    (`named:<provider>:<name>`).
     * 2. Anonymous sessions map to a recurring villager: the generated
     *    name is deterministic from the session-id hash, so the same
     *    villager character accrues history across sessions
     *    (`villager:<provider>:<generated-name>`).
     */
    static identityKeyFor(agent) {
        if (!agent) return null;
        const provider = slug(agent.provider || 'unknown');
        const givenName = agent.agentName || (agent._customName ? agent.name : null);
        if (givenName) return `named:${provider}:${slug(givenName)}`;
        const villagerName = agent.name || agent.displayName || agent.id;
        return `villager:${provider}:${slug(villagerName)}`;
    }

    static create(identityKey, now = Date.now()) {
        const biography = new AgentBiography({ identityKey, firstSeenAt: now, lastSeenAt: now });
        biography.milestones.push({ ...FIRST_SEEN_MILESTONE, at: now });
        return biography;
    }

    /** Rehydrate from a persisted record; returns null when unusable. */
    static fromRecord(record) {
        if (!record || typeof record !== 'object' || !record.identityKey) return null;
        // v1 → v2 added error/nickname fields; v3 adds bounded event memory
        // under extensions. All additions default safely for existing records.
        return new AgentBiography(record);
    }

    toRecord() {
        return {
            identityKey: this.identityKey,
            schemaVersion: BIOGRAPHY_SCHEMA_VERSION,
            firstSeenAt: this.firstSeenAt,
            lastSeenAt: this.lastSeenAt,
            sessionsCompleted: this.sessionsCompleted,
            commitsPushed: this.commitsPushed,
            lifetimeTokens: this.lifetimeTokens,
            errorsRecovered: this.errorsRecovered,
            milestones: this.milestones.map(m => ({ ...m })),
            extensions: {
                ...this.extensions,
                biographyEvents: {
                    ...this.extensions.biographyEvents,
                    recentPushKeys: [...this.extensions.biographyEvents.recentPushKeys],
                },
            },
        };
    }

    /**
     * Remember a push identity without retaining the full event history.
     * Returns true only when the identity was not already present.
     */
    rememberPushEvent(key, at = 0) {
        const normalizedKey = compactEventKey(key);
        if (!normalizedKey) return false;
        const memory = this.extensions.biographyEvents;
        if (memory.recentPushKeys.includes(normalizedKey)) return false;
        const timestamp = nonNegativeNumber(at);
        // Once a newer timestamp is persisted, an older identity that fell
        // out of the bounded key ring is still history, not a new push.
        if (timestamp && timestamp < memory.pushWatermarkAt) return false;
        memory.recentPushKeys.push(normalizedKey);
        if (memory.recentPushKeys.length > RECENT_PUSH_KEY_LIMIT) {
            memory.recentPushKeys.splice(0, memory.recentPushKeys.length - RECENT_PUSH_KEY_LIMIT);
        }
        if (timestamp > memory.pushWatermarkAt) memory.pushWatermarkAt = timestamp;
        return true;
    }

    hasMilestone(id) {
        return this.milestones.some(m => m.id === id);
    }

    /** Latest-earned nickname, or null when none has been earned yet. */
    get nickname() {
        let latest = null;
        for (const milestone of this.milestones) {
            if (!milestone.nickname) continue;
            if (!latest || milestone.at >= latest.at) latest = milestone;
        }
        return latest ? latest.nickname : null;
    }

    noteSeen(now = Date.now()) {
        if (!this.firstSeenAt) this.firstSeenAt = now;
        if (now > this.lastSeenAt) this.lastSeenAt = now;
    }

    /** Returns newly earned milestones (possibly empty). */
    addLifetimeTokens(delta, now = Date.now()) {
        const amount = nonNegativeNumber(delta);
        if (!amount) return [];
        this.lifetimeTokens += amount;
        return this._collectNewMilestones(now);
    }

    /** Returns newly earned milestones (possibly empty). */
    recordPush(now = Date.now()) {
        this.commitsPushed += 1;
        return this._collectNewMilestones(now);
    }

    /** Returns newly earned milestones (possibly empty). */
    recordSessionCompleted(now = Date.now()) {
        this.sessionsCompleted += 1;
        return this._collectNewMilestones(now);
    }

    /** Returns newly earned milestones (possibly empty). */
    recordErrorRecovery(now = Date.now()) {
        this.errorsRecovered += 1;
        return this._collectNewMilestones(now);
    }

    /**
     * Mark this villager as the village founder (first-ever agent).
     * Idempotent; returns the founder milestone when newly added.
     */
    markFounder(now = Date.now()) {
        if (this.hasMilestone(FOUNDER_MILESTONE.id)) return [];
        const milestone = { ...FOUNDER_MILESTONE, at: nonNegativeNumber(now) || Date.now() };
        this.milestones.push(milestone);
        return [milestone];
    }

    _collectNewMilestones(now) {
        const earned = [];
        for (const track of MILESTONE_TRACKS) {
            const value = this[track.stat];
            for (const threshold of track.thresholds) {
                if (value < threshold) break;
                const id = `${track.stat}-${threshold}`;
                if (this.hasMilestone(id)) continue;
                const milestone = { id, at: now, label: track.label(threshold) };
                this.milestones.push(milestone);
                earned.push(milestone);
            }
        }
        for (const track of NICKNAME_TRACKS) {
            if (this[track.stat] < track.threshold) continue;
            const id = `nickname-${track.stat}-${track.threshold}`;
            if (this.hasMilestone(id)) continue;
            const milestone = {
                id,
                at: now,
                label: `Earned the nickname "${track.nickname}"`,
                nickname: track.nickname,
            };
            this.milestones.push(milestone);
            earned.push(milestone);
        }
        return earned;
    }
}
