import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import {
    MOOD_TUNING,
    deriveAgentMood,
    deriveWeatherInfluence,
    normalizeMood,
} from '../domain/value-objects/AgentMood.js';

// Token spend rate is measured over this rolling sample window.
const TOKEN_RATE_WINDOW_MS = 2 * 60_000;
// Mood updates are re-emitted only when the intensity moves at least this much.
const INTENSITY_EMIT_STEP = 0.15;
// Village event arrays are pruned past the widest influence window.
const VILLAGE_EVENT_RETENTION_MS = 20 * 60_000;
const STREAK_EVENT_TYPES = new Set(['commit', 'push']);

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    return (Number(tokens.input) || 0) + (Number(tokens.output) || 0);
}

function isCountableStreakEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (!STREAK_EVENT_TYPES.has(String(event.type || '').toLowerCase())) return false;
    if (event.dryRun === true) return false;
    if (event.success === false) return false;
    const status = String(event.status || '').toLowerCase();
    if (status === 'failed' || status === 'rejected') return false;
    return true;
}

function streakEventKey(event) {
    return String(event.id || `${event.type}:${event.ts || 0}:${event.commandHash || event.command || ''}`);
}

function prune(timestamps, cutoff) {
    while (timestamps.length && timestamps[0] < cutoff) timestamps.shift();
}

/**
 * Tracks per-agent telemetry over time (token spend rate, error episodes,
 * commit/push streaks), keeps each `Agent.mood` current, and aggregates a
 * village-level weather influence.
 *
 * Emits `mood:changed` with `{ agent, mood, previous }` when an agent's
 * mood type changes or its intensity shifts noticeably.
 *
 * Weather consumers (AtmosphereState lives in presentation) read
 * `getWeatherInfluence()` — a pure snapshot, safe to call every frame.
 */
export class MoodService {
    constructor() {
        this._records = new Map(); // agent.id -> tracking record
        this._villageErrorTimestamps = [];
        this._villagePushTimestamps = [];
        this._unsubscribers = [];
    }

    start() {
        if (this._unsubscribers.length) return this;
        const seen = (agent) => this._handleAgentSeen(agent);
        this._unsubscribers.push(eventBus.on('agent:added', seen));
        this._unsubscribers.push(eventBus.on('agent:updated', seen));
        this._unsubscribers.push(eventBus.on('agent:removed', (agent) => {
            if (agent?.id) this._records.delete(agent.id);
        }));
        return this;
    }

    stop() {
        for (const unsubscribe of this._unsubscribers) unsubscribe();
        this._unsubscribers = [];
        this._records.clear();
    }

    /** Village-level event influence for weather; see deriveWeatherInfluence. */
    getWeatherInfluence(now = Date.now()) {
        const cutoff = now - VILLAGE_EVENT_RETENTION_MS;
        prune(this._villageErrorTimestamps, cutoff);
        prune(this._villagePushTimestamps, cutoff);
        const moods = [];
        for (const record of this._records.values()) moods.push(record.mood);
        return deriveWeatherInfluence({
            errorTimestamps: this._villageErrorTimestamps,
            pushTimestamps: this._villagePushTimestamps,
            moods,
        }, now);
    }

    getMood(agentId) {
        return this._records.get(agentId)?.mood || normalizeMood(null);
    }

    _handleAgentSeen(agent) {
        if (!agent?.id) return;
        const now = Date.now();
        let record = this._records.get(agent.id);
        if (!record) {
            record = {
                tokenSamples: [{ at: now, total: tokenTotal(agent) }],
                wasErrored: false,
                lastErrorAt: 0,
                countedStreakKeys: new Set(),
                pushTimestamps: [],
                mood: normalizeMood(null),
            };
            this._records.set(agent.id, record);
        }

        // Token spend rate over the rolling sample window.
        const total = tokenTotal(agent);
        record.tokenSamples.push({ at: now, total });
        while (record.tokenSamples.length > 1 && record.tokenSamples[0].at < now - TOKEN_RATE_WINDOW_MS) {
            record.tokenSamples.shift();
        }
        const oldest = record.tokenSamples[0];
        const elapsedMinutes = (now - oldest.at) / 60_000;
        const tokensPerMinute = elapsedMinutes > 0
            ? Math.max(0, total - oldest.total) / elapsedMinutes
            : 0;

        // Error episodes: count the transition into ERRORED, not every poll.
        const isErrored = agent.status === AgentStatus.ERRORED;
        if (isErrored && !record.wasErrored) {
            record.lastErrorAt = now;
            this._villageErrorTimestamps.push(now);
        }
        record.wasErrored = isErrored;

        // Commit/push streak from git events (deduped by event identity).
        for (const event of agent.gitEvents || []) {
            if (!isCountableStreakEvent(event)) continue;
            const key = streakEventKey(event);
            if (record.countedStreakKeys.has(key)) continue;
            record.countedStreakKeys.add(key);
            record.pushTimestamps.push(now);
            this._villagePushTimestamps.push(now);
        }
        prune(record.pushTimestamps, now - MOOD_TUNING.streakWindowMs);

        const mood = deriveAgentMood({
            isErrored,
            lastErrorAt: record.lastErrorAt,
            pushStreak: record.pushTimestamps.length,
            lastPushAt: record.pushTimestamps[record.pushTimestamps.length - 1] || 0,
            tokensPerMinute,
            sessionTokens: total,
        }, now);

        const previous = record.mood;
        record.mood = mood;
        agent.mood = mood;
        if (mood.type !== previous.type
            || Math.abs(mood.intensity - previous.intensity) >= INTENSITY_EMIT_STEP) {
            eventBus.emit('mood:changed', { agent, mood, previous });
        }
    }
}
