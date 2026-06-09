/**
 * AgentMood — pure telemetry → emotion mapping for villagers.
 *
 * Two pure derivations live here:
 *   - `deriveAgentMood`: per-agent mood from error recency, commit/push
 *     streaks, and token spend (distress > pride > fatigue > neutral).
 *   - `deriveWeatherInfluence`: village-level event-influence input for
 *     weather (error spikes raise storminess, commit streaks clear skies).
 *
 * The temporal bookkeeping (token-rate sampling, error/push timestamps)
 * is owned by `application/MoodService.js`; this module stays stateless
 * so moods are reproducible from inputs.
 */

export const Mood = {
    NEUTRAL: 'neutral',
    DISTRESSED: 'distressed',
    PROUD: 'proud',
    TIRED: 'tired',
};

const KNOWN_MOODS = new Set(Object.values(Mood));

export const MOOD_TUNING = {
    // Distress holds at full strength while errored, then fades.
    errorDecayMs: 3 * 60_000,
    // Successful commits/pushes within this window count toward a streak.
    streakWindowMs: 30 * 60_000,
    // Streak length that starts feeling like pride.
    prideStreakMin: 2,
    // Pride fades this long after the latest streak event.
    prideDecayMs: 10 * 60_000,
    // Sustained spend rate considered heavy (tokens per minute).
    fatigueTokensPerMinute: 40_000,
    // Session lifetime spend that wears a villager down regardless of rate.
    fatigueSessionTokens: 4_000_000,
    // Candidate intensities below this floor fall through to neutral.
    minIntensity: 0.2,
};

export const INFLUENCE_TUNING = {
    // Rolling windows for village-level event counting.
    errorWindowMs: 10 * 60_000,
    pushWindowMs: 15 * 60_000,
    // Event counts that saturate the respective influence channel.
    errorsForFullStorm: 4,
    pushesForFullClearing: 5,
};

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function decay(sinceTs, windowMs, now) {
    const ts = Number(sinceTs) || 0;
    if (!ts || ts > now) return 0;
    return clamp01(1 - (now - ts) / windowMs);
}

export function normalizeMood(raw = null) {
    const type = KNOWN_MOODS.has(raw?.type) ? raw.type : Mood.NEUTRAL;
    return {
        type,
        intensity: type === Mood.NEUTRAL ? 0 : clamp01(raw?.intensity),
        since: Number(raw?.since) || 0,
    };
}

/**
 * Derive a mood from per-agent telemetry.
 *
 * @param {object} inputs
 * @param {boolean} inputs.isErrored        agent status is currently errored
 * @param {number}  inputs.lastErrorAt      ms timestamp of last error episode (0 = none)
 * @param {number}  inputs.pushStreak       successful commits/pushes inside the streak window
 * @param {number}  inputs.lastPushAt       ms timestamp of latest streak event (0 = none)
 * @param {number}  inputs.tokensPerMinute  recent token spend rate
 * @param {number}  inputs.sessionTokens    cumulative session input+output tokens
 * @param {number}  now
 * @returns {{ type: string, intensity: number, since: number }}
 */
export function deriveAgentMood(inputs = {}, now = Date.now()) {
    const {
        isErrored = false,
        lastErrorAt = 0,
        pushStreak = 0,
        lastPushAt = 0,
        tokensPerMinute = 0,
        sessionTokens = 0,
    } = inputs;

    const distress = isErrored ? 1 : decay(lastErrorAt, MOOD_TUNING.errorDecayMs, now);

    let pride = 0;
    if (pushStreak >= MOOD_TUNING.prideStreakMin) {
        const streakStrength = clamp01(0.5 + (pushStreak - MOOD_TUNING.prideStreakMin) * 0.15);
        pride = streakStrength * decay(lastPushAt, MOOD_TUNING.prideDecayMs, now);
    }

    const fatigue = clamp01(Math.max(
        (Number(tokensPerMinute) || 0) / MOOD_TUNING.fatigueTokensPerMinute,
        (Number(sessionTokens) || 0) / MOOD_TUNING.fatigueSessionTokens,
    ));

    const candidates = [
        { type: Mood.DISTRESSED, intensity: distress, since: lastErrorAt || now },
        { type: Mood.PROUD, intensity: pride, since: lastPushAt || now },
        { type: Mood.TIRED, intensity: fatigue, since: now },
    ];
    for (const candidate of candidates) {
        if (candidate.intensity >= MOOD_TUNING.minIntensity) {
            return normalizeMood(candidate);
        }
    }
    return normalizeMood(null);
}

/**
 * Derive the village-level event influence on weather.
 *
 * @param {object} inputs
 * @param {number[]} inputs.errorTimestamps  ms timestamps of recent error episodes
 * @param {number[]} inputs.pushTimestamps   ms timestamps of recent successful commits/pushes
 * @param {Array<{type: string}>} inputs.moods  current per-agent moods
 * @param {number} now
 * @returns {{
 *   storminess: number,  // 0..1, raises cloud cover / precipitation
 *   clearing: number,    // 0..1, pulls weather toward clear skies
 *   bias: number,        // clearing - storminess, -1..1
 *   signals: { recentErrors: number, recentPushes: number,
 *              distressedAgents: number, proudAgents: number, agentCount: number },
 *   updatedAt: number,
 * }}
 */
export function deriveWeatherInfluence(inputs = {}, now = Date.now()) {
    const errorTimestamps = Array.isArray(inputs.errorTimestamps) ? inputs.errorTimestamps : [];
    const pushTimestamps = Array.isArray(inputs.pushTimestamps) ? inputs.pushTimestamps : [];
    const moods = Array.isArray(inputs.moods) ? inputs.moods : [];

    const errorCutoff = now - INFLUENCE_TUNING.errorWindowMs;
    const pushCutoff = now - INFLUENCE_TUNING.pushWindowMs;
    const recentErrors = errorTimestamps.filter(ts => ts >= errorCutoff && ts <= now).length;
    const recentPushes = pushTimestamps.filter(ts => ts >= pushCutoff && ts <= now).length;

    const agentCount = moods.length;
    const distressedAgents = moods.filter(mood => mood?.type === Mood.DISTRESSED).length;
    const proudAgents = moods.filter(mood => mood?.type === Mood.PROUD).length;
    const distressedShare = agentCount ? distressedAgents / agentCount : 0;
    const proudShare = agentCount ? proudAgents / agentCount : 0;

    const storminess = clamp01(
        recentErrors / INFLUENCE_TUNING.errorsForFullStorm * 0.7 + distressedShare * 0.5,
    );
    const clearing = clamp01(
        recentPushes / INFLUENCE_TUNING.pushesForFullClearing * 0.7 + proudShare * 0.5,
    );

    return {
        storminess,
        clearing,
        bias: clearing - storminess,
        signals: { recentErrors, recentPushes, distressedAgents, proudAgents, agentCount },
        updatedAt: now,
    };
}
