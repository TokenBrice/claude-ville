/**
 * C1 — the village's own readiness, freshness, and provider truth.
 *
 * Before this reducer, the shell hard-coded a connected-looking `LIVE` chip
 * before any server result, boot marked readiness only after the entire
 * asynchronous chain, a failed initial session read was caught and logged with
 * no visible distinction, and both empty states guessed from `world.agents.size`.
 * "Nothing is running" and "I cannot read your provider" rendered identically.
 *
 * This module is a pure reducer over observations. It performs no I/O, owns no
 * timers, and never formats a filesystem path, credential, or stack into
 * operator copy — callers pass normalized codes only.
 */

export const VillagePhase = Object.freeze({
    STARTING: 'starting',
    SYNCING: 'syncing',
    READY_LIVE: 'ready-live',
    READY_EMPTY: 'ready-empty',
    READY_NO_PROVIDERS: 'ready-no-providers',
    DEGRADED: 'degraded',
    FAILED: 'failed',
});

export const LinkState = Object.freeze({
    SYNCING: 'syncing',
    LIVE: 'live',
    POLLING: 'polling',
    RECONNECTING: 'reconnecting',
    STALE: 'stale',
});

export const ProviderHealth = Object.freeze({
    UNAVAILABLE: 'unavailable',
    EMPTY: 'empty',
    HEALTHY: 'healthy',
    DEGRADED: 'degraded',
});

/**
 * A snapshot older than this is presented as stale. Deliberately longer than
 * one poll interval so a single slow response does not flash the whole town.
 */
export const DEFAULT_STALE_AFTER_MS = 15000;

export function initialVillageState() {
    return {
        phase: VillagePhase.STARTING,
        link: {
            state: LinkState.SYNCING,
            attempts: 0,
            nextRetryAt: null,
            lastSnapshotAt: null,
            // EN-2 — the WebSocket client's liveness: the last message of any
            // kind (a pong included), and whether a ping went unanswered.
            lastMessageAt: null,
            stale: false,
            lastErrorCode: null,
        },
        providers: [],
        providersKnown: false,
        agentCount: 0,
        source: null,
        sourceFailed: false,
        failureCode: null,
        storage: { chronicle: 'unknown' },
    };
}

function normalizeCode(code) {
    if (!code) return null;
    // Normalized identifiers only: no paths, no stacks, no prose.
    const text = String(code).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    return text ? text.slice(0, 48) : null;
}

function normalizeProvider(provider) {
    const health = Object.values(ProviderHealth).includes(provider?.health)
        ? provider.health
        : ProviderHealth.UNAVAILABLE;
    return {
        id: String(provider?.id ?? provider?.name ?? 'unknown'),
        name: String(provider?.name ?? provider?.id ?? 'unknown'),
        health,
        sessions: Math.max(0, Number(provider?.sessions) || 0),
        lastSuccessAt: Number(provider?.lastSuccessAt) || null,
        skippedLines: Math.max(0, Number(provider?.skippedLines) || 0),
    };
}

/** Providers that are installed and readable, whether or not they are busy. */
export function usableProviders(providers = []) {
    return providers.filter(p => p.health === ProviderHealth.HEALTHY || p.health === ProviderHealth.EMPTY);
}

/** Providers we could see but failed to read. */
export function degradedProviders(providers = []) {
    return providers.filter(p => p.health === ProviderHealth.DEGRADED);
}

/**
 * The one place a phase is decided. Kept separate from the reducer so a test
 * can assert every boundary without constructing an action sequence.
 */
export function derivePhase(state) {
    if (state.failureCode) return VillagePhase.FAILED;
    if (!state.providersKnown || state.link.lastSnapshotAt === null) {
        return state.phase === VillagePhase.STARTING ? VillagePhase.STARTING : VillagePhase.SYNCING;
    }
    // A source we could not read outranks an empty village: silence and
    // blindness are opposite operational facts.
    if (state.sourceFailed || degradedProviders(state.providers).length > 0) return VillagePhase.DEGRADED;
    // Live agents are direct evidence that a provider was readable, and they
    // outrank the provider roster's own classification. Without this, a
    // mis-mapped or stale roster can make a populated village announce
    // "NO PROVIDERS FOUND" while villagers are visibly at work — observed in a
    // browser before this guard existed.
    if (state.agentCount > 0) return VillagePhase.READY_LIVE;
    if (usableProviders(state.providers).length === 0) return VillagePhase.READY_NO_PROVIDERS;
    return VillagePhase.READY_EMPTY;
}

/**
 * Reduce one observation into a new state. Never mutates its input.
 *
 * Actions:
 *   { type: 'sync-start' }
 *   { type: 'providers', providers: [...] }
 *   { type: 'snapshot', agentCount, at }        // proof of fresh data
 *   { type: 'source-failed', code }
 *   { type: 'link', state, attempts, nextRetryAt, lastErrorCode, lastMessageAt, stale }
 *   { type: 'boot-failed', code }
 *   { type: 'retry' }
 *   { type: 'storage', chronicle }
 */
export function reduceVillageState(state = initialVillageState(), action = {}) {
    const next = {
        ...state,
        link: { ...state.link },
        providers: state.providers,
        storage: { ...state.storage },
    };

    switch (action.type) {
        case 'sync-start':
            next.link.state = LinkState.SYNCING;
            break;

        case 'providers':
            next.providers = (Array.isArray(action.providers) ? action.providers : []).map(normalizeProvider);
            next.providersKnown = true;
            break;

        case 'snapshot':
            if (action.source) next.source = String(action.source);
            next.agentCount = Math.max(0, Number(action.agentCount) || 0);
            next.link.lastSnapshotAt = Number(action.at) || Date.now();
            next.link.attempts = 0;
            next.link.lastErrorCode = null;
            next.sourceFailed = false;
            // Only a fulfilled snapshot may claim freshness. A TCP open is not
            // evidence that data arrived.
            if (next.link.state === LinkState.SYNCING
                || next.link.state === LinkState.RECONNECTING
                || next.link.state === LinkState.STALE) {
                next.link.state = LinkState.LIVE;
            }
            break;

        case 'source-failed':
            next.sourceFailed = true;
            next.link.lastErrorCode = normalizeCode(action.code) || 'source-failed';
            break;

        case 'link':
            if (Object.values(LinkState).includes(action.state)) next.link.state = action.state;
            if (action.attempts !== undefined) next.link.attempts = Math.max(0, Number(action.attempts) || 0);
            if (action.nextRetryAt !== undefined) next.link.nextRetryAt = Number(action.nextRetryAt) || null;
            if (action.lastErrorCode !== undefined) next.link.lastErrorCode = normalizeCode(action.lastErrorCode);
            if (action.lastMessageAt !== undefined) next.link.lastMessageAt = Number(action.lastMessageAt) || null;
            if (action.stale !== undefined) next.link.stale = action.stale === true;
            break;

        case 'boot-failed':
            next.failureCode = normalizeCode(action.code) || 'boot-failed';
            break;

        case 'retry':
            next.failureCode = null;
            next.sourceFailed = false;
            next.link.state = LinkState.SYNCING;
            break;

        case 'storage':
            if (action.chronicle) next.storage.chronicle = String(action.chronicle);
            break;

        default:
            break;
    }

    next.phase = derivePhase(next);
    return next;
}

// When the village last heard from its source: for the WebSocket, any message
// (a pong included); otherwise the last good snapshot.
function lastHeardAt(state) {
    const link = state?.link || {};
    if (state?.source !== 'websocket') return link.lastSnapshotAt || null;
    return Math.max(Number(link.lastMessageAt) || 0, Number(link.lastSnapshotAt) || 0) || null;
}

/**
 * True when the operator should discount the scene. Returns false while still
 * syncing: unknown is not stale.
 *
 * EN-2 — a live WebSocket link is judged by liveness, not by snapshot age: a
 * quiet, healthy village gets no broadcasts, yet its pings are answered. The
 * client flags `link.stale` when one goes unanswered, and a socket that is
 * down ages from the last message it heard. Any other source (REST polling)
 * still ages its last good snapshot.
 */
export function isStale(state, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
    if (state?.source === 'simulator') return false;
    const link = state?.link || {};
    if (!link.lastSnapshotAt) return false;
    if (state.source === 'websocket') {
        if (link.stale === true) return true;
        if (link.state === LinkState.LIVE) return false;
    }
    return (now - lastHeardAt(state)) > staleAfterMs;
}

/** Age of the last good snapshot in ms, or null when none has arrived. */
export function snapshotAgeMs(state, now = Date.now()) {
    const at = state?.link?.lastSnapshotAt;
    if (!at) return null;
    return Math.max(0, now - at);
}

const PHASE_TEXT = Object.freeze({
    [VillagePhase.STARTING]: 'OPENING THE VILLAGE',
    [VillagePhase.SYNCING]: 'LISTENING FOR LOCAL SESSIONS',
    [VillagePhase.READY_NO_PROVIDERS]: 'NO PROVIDERS FOUND',
    [VillagePhase.READY_EMPTY]: 'PROVIDERS FOUND / NOTHING ACTIVE',
    [VillagePhase.DEGRADED]: 'A WATCHTOWER IS UNREADABLE',
    [VillagePhase.FAILED]: 'THE VILLAGE DID NOT OPEN',
});

/** Short operator copy for a phase. English only, no paths, no stack text. */
export function bootStatusText(state) {
    const phase = state?.phase;
    if (phase === VillagePhase.READY_LIVE) {
        const count = Math.max(0, Number(state?.agentCount) || 0);
        return count === 1 ? 'WATCHING 1 AGENT' : `WATCHING ${count} AGENTS`;
    }
    return PHASE_TEXT[phase] || PHASE_TEXT[VillagePhase.STARTING];
}

/**
 * Short operator copy for the connection chip.
 *
 * `LIVE` is gated on a fulfilled snapshot, not on the link object alone: a
 * socket that opened and said nothing is not evidence that data arrived, and
 * the shell claiming `LIVE` before the first snapshot is the exact defect this
 * contract exists to remove.
 */
export function linkStatusText(state, now = Date.now()) {
    if (state?.source === 'simulator') return 'SIMULATED';
    const link = state?.link || {};
    if (!link.lastSnapshotAt) return 'SYNCING';
    if (isStale(state, now)) {
        const age = Math.round(Math.max(0, now - (lastHeardAt(state) || now)) / 1000);
        return `STALE / last seen ${age}s ago`;
    }
    switch (link.state) {
        case LinkState.LIVE: return 'LIVE';
        case LinkState.POLLING: return 'POLLING';
        case LinkState.RECONNECTING: return `RECONNECTING ${Math.max(1, link.attempts || 1)}`;
        case LinkState.SYNCING:
        default: return 'SYNCING';
    }
}

/** True when the phase is one an operator can act on to recover. */
export function isRetryable(state) {
    return state?.phase === VillagePhase.FAILED || state?.phase === VillagePhase.DEGRADED;
}

/**
 * EN-1: the link to the server is down or silent (the socket is reconnecting,
 * or the last word from the server is stale). That is the server, not a
 * provider, so it outranks the DEGRADED phase's "a source is unreadable".
 */
export function linkDown(state, now = Date.now()) {
    if (state?.source === 'simulator') return false;
    return state?.link?.state === LinkState.RECONNECTING || isStale(state, now);
}
