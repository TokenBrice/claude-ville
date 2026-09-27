// The signal route (7.2): the one director alive from boot, whether or not
// sound is on. It hears the village's facts over the event bus and turns
// them into one-shot cues through the engine-owned cue arbiter
// (`cues = { kit, governor }`, injected; never built or destroyed here), so
// captions and the urgency ladder work with sound off and on a hidden page.
//
// What it carries: the actionable calls (summons, distress, limit) routed
// once per agent entry, the ladder's reminders, the `answered` strike at
// the end of a wait, outcomes aggregated into one cue with its exact count,
// arrivals, departures, councils and milestones, the feed's link cues and
// the return digest. A hidden page hands every cue that must be heard to the
// controller's wake path instead of the suspended mix.
//
// Playing as the Signals preset it sounds only the attention voices (the
// calls, the ladder, recovery and `answered`) and captions every other kind
// through the governor without sounding it. While the Town band owns the
// signals (`setSignalRouting(false)`) the band routes the calls itself; the
// feed's link cues, the return digest and an outcome batch that closes
// after the switch stay with this director and sound in the band's context.
//
// Honest silence (plan 3.7): only audible (non-stale) agents count toward a
// wait, a stale observation raises nothing, and a lost feed says so once.
//
// Atmosphere source: the World renderer broadcasts its per-frame snapshot as
// `atmosphere:updated`; when that stream goes quiet (Dashboard stops the
// render loop) the director computes its own from the local clock, so cues
// are voiced in the phase of the hour anywhere. Playing as Signals it also
// sets the Island Air phase the cues ring in (on a change only); while the
// Town band owns the signals the band sets it, so the two never fight.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import { UNATTENDED_DIGEST_THRESHOLD_MS } from '../../../application/AttentionService.js';
import {
    OutcomeRouter,
    OutcomeTracker,
    failedPushFacts,
    toolFailedFact,
    verifiedOutcomeFact,
} from '../../../application/OutcomeSignals.js';
import { createAtmosphereSnapshot } from '../../character-mode/AtmosphereState.js';
import { cueLifecycleDecision } from './CueGovernor.js';
import { cuePlacementKind, laneForCueKind } from './cues/CueKit.js';
import { buildingOf, explicitSpot, resolveCueSpot } from './SpatialField.js';
import { ActionableCueRouter, attentionStatus, familyCuePayload } from './ActionableRouting.js';
import { LinkHealth, digestNotes, isAudibleAgent, waitState } from './AudibleWorld.js';

const TICK_MS = 1000;
const DIRECTOR_ID = 'signals';
// Pause in place (2.1): the groups close over 80 ms and reopen over 250 ms.
const PAUSE_CLOSE_SEC = 0.08;
const RESUME_OPEN_SEC = 0.25;
const ATMO_FRESH_MS = 3000;
// What Signals sounds (7.2, UX-3); every other kind only captions.
const SIGNALS_SOUNDING = new Set(['summons', 'distress', 'limit', 'reminder', 'answered', 'recovery']);
// The bed-aware trim's window (CueLevel) for a cue with no music under it.
const NO_MUSIC_BED = 'village';

// The page's app (mode manager): the one seam the audio side reads the
// renderer through, as SpatialField does for cue spots.
function worldApp() {
    return globalThis.window?.__claudeVilleApp ?? null;
}

function copyPosition(position) {
    if (!position || typeof position !== 'object') return null;
    return {
        ...(Number.isFinite(Number(position.tileX)) ? { tileX: Number(position.tileX) } : {}),
        ...(Number.isFinite(Number(position.tileY)) ? { tileY: Number(position.tileY) } : {}),
        ...(Number.isFinite(Number(position.x)) ? { x: Number(position.x) } : {}),
        ...(Number.isFinite(Number(position.y)) ? { y: Number(position.y) } : {}),
        ...(Number.isFinite(Number(position.screenX)) ? { screenX: Number(position.screenX) } : {}),
    };
}

// The payload fields a cue's place is resolved from (SpatialField.resolveCueSpot).
function spatialFields(payload) {
    return {
        agent: payload?.agent,
        screenX: payload?.screenX,
        screenY: payload?.screenY,
        normalizedScreenX: payload?.normalizedScreenX,
        normalizedScreenY: payload?.normalizedScreenY,
        viewportWidth: payload?.viewportWidth,
        viewportHeight: payload?.viewportHeight,
        screenPosition: payload?.screenPosition,
        position: payload?.position,
        lastTile: payload?.lastTile,
        worldX: payload?.worldX,
        center: payload?.center,
        building: payload?.building,
    };
}

export class SignalDirector {
    // `cues = { kit, governor }` is the engine-wide cue arbiter (one CueKit and
    // one CueGovernor per engine, owned by the controller): budgets and
    // cooldowns survive a preset switch. Without it the director stays mute.
    constructor({ engine, world = null, cues = null } = {}) {
        this.engine = engine;
        this.world = world;
        this.cueKit = cues?.kit ?? null;
        this.governor = cues?.governor ?? null;
        this.running = false;
        this.paused = false;
        this._interval = null;
        this._unsubscribes = [];
        this._signalUnsubscribes = [];
        this._signalRouting = true;
        this.hidden = false;
        this._hiddenSummonsHandler = null;
        this._atmosphere = null;
        this._atmosphereAt = 0;
        this._atmosphereSource = 'none';
        this._phase = 'day';
        // The Island Air phase this director last set; null = set it on the
        // next tick (a start, or the signals coming back from the band).
        this._airPhase = null;
        this._actionable = new ActionableCueRouter();
        this._agentAudioContext = new Map();
        this._mode = worldApp()?.modeManager?.getCurrentMode?.() === 'dashboard' ? 'dashboard' : 'character';
        // Audible actionable agents (3.3): the wait whose last answer rings
        // `answered`, and the family of the oldest one.
        this._waiting = 0;
        this._waitFamily = null;
        this._waitCheckQueued = false;
        this._operatorLooking = null;
        // Link health (3.7): one loss timer, created only while a loss is due.
        this._link = new LinkHealth();
        this._linkTimer = null;
        // Outcomes (3.4): World-model transitions become facts; the router
        // gates and aggregates them into one cue with its exact count.
        this._outcomeTracker = new OutcomeTracker({
            hasAgent: id => Boolean(this.world?.agents?.has?.(id)),
            isAudible: agent => isAudibleAgent(agent, Date.now()),
        });
        this._outcomeTracker.prime(this.world?.agents?.values?.() ?? []);
        this._outcomes = new OutcomeRouter({ emit: outcome => this._playOutcome(outcome) });
        this._harborFailures = null;

        // Cue signals stay subscribed while audio is disabled so the
        // accessibility event stream remains useful without an AudioContext.
        this._subscribeSignals();
    }

    /** True while the feed has been lost (3.7): the ladder freezes on it. */
    get linkLost() {
        return this._link.lost;
    }

    // Signals is playing: the 1 Hz tick follows the wait for the `answered`
    // strike and the phase its calls are voiced in.
    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;
        this.paused = false;
        // A rebuild after a long absence starts on a paused Transport.
        this.engine.transport.resume();
        this._subscribeRuntime();
        this._airPhase = null;
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    // The shared governor's prepared routine cue is not this director's to
    // clear: during a crossfade it may belong to the incoming director.
    stop() {
        this.running = false;
        this.paused = false;
        clearInterval(this._interval);
        this._interval = null;
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
    }

    // Pause in place (2.1, ENG-2): stop waking the Transport and the tick and
    // close this director's groups over 80 ms; the controller then freezes
    // the audio clock with `suspend()`. Returns the audio time at which the
    // groups are silent.
    pause() {
        if (!this.running || this.paused) return this.engine.now();
        this.paused = true;
        clearInterval(this._interval);
        this._interval = null;
        this.engine.transport.pause();
        return this.engine.fadeDirector(DIRECTOR_ID, 0, { duration: PAUSE_CLOSE_SEC });
    }

    // Reopen over 250 ms and re-arm the tick from the current audio time:
    // nothing missed while away is caught up.
    resume() {
        if (!this.running || !this.paused) return;
        this.paused = false;
        this.engine.fadeDirector(DIRECTOR_ID, 1, { duration: RESUME_OPEN_SEC });
        this.engine.transport.resume();
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    // The local clock's phase: the same source before and after an absence
    // (a hidden tab stops the World's broadcast), so comparing the two never
    // mistakes a stale broadcast for a change of phase.
    currentPhase() {
        return createAtmosphereSnapshot({}).phase || 'day';
    }

    destroy() {
        this.stop();
        for (const unsubscribe of this._signalUnsubscribes) unsubscribe();
        this._signalUnsubscribes = [];
        clearTimeout(this._linkTimer);
        this._linkTimer = null;
        this._outcomes.destroy();
        this._outcomeTracker.clear();
        this.cueKit = null;
        this.governor = null;
        this._actionable.clear();
        this._agentAudioContext.clear();
    }

    setSignalRouting(enabled) {
        const routing = Boolean(enabled);
        if (routing !== this._signalRouting) this._airPhase = null;
        this._signalRouting = routing;
    }

    setHidden(hidden) {
        this.hidden = Boolean(hidden);
        this.governor?.clearRoutine();
    }

    setHiddenSummonsHandler(handler) {
        this._hiddenSummonsHandler = typeof handler === 'function' ? handler : null;
    }

    // S7: an entry summons while the operator is looking plays the L2 voice.
    setOperatorLooking(fn) {
        this._operatorLooking = typeof fn === 'function' ? fn : null;
    }

    /**
     * A ladder reminder (3.3) in its wait's family voice. Only the director
     * that owns signal routing plays it; a hidden page hands it to the wake.
     */
    playReminder(reminder = {}) {
        if (!this._signalRouting) return false;
        const agentId = reminder?.agentId ?? null;
        return this._signalCue('reminder', {
            ...familyCuePayload(reminder),
            agentId,
            label: this._agentLabel(reminder, agentId),
        });
    }

    _subscribeSignals() {
        const on = (event, handler) => {
            this._signalUnsubscribes.push(eventBus.on(event, handler));
        };

        on('mode:changed', (mode) => {
            this._mode = mode === 'dashboard' ? 'dashboard' : 'character';
            this.governor?.clearRoutine();
        });
        // The World model's own transitions carry the outcomes that must work
        // in Dashboard too (turn ends, dispatches, returns) and the wait; the
        // tracker observes even while another director owns the signals, so
        // it always knows each agent's previous state.
        on('agent:added', (agent) => {
            this._rememberAgentAudioContext(agent);
            this._submitOutcomes(this._outcomeTracker.added(agent));
            this._queueWaitCheck();
        });
        on('agent:updated', (agent) => {
            this._rememberAgentAudioContext(agent);
            this._submitOutcomes(this._outcomeTracker.updated(agent));
            this._queueWaitCheck();
        });
        // Keep the last position/provider through the synchronous removal →
        // village:scene sequence so departures can retain their identity.
        on('agent:removed', (agent) => {
            this._rememberAgentAudioContext(agent);
            this._submitOutcomes(this._outcomeTracker.removed(agent));
            this._queueWaitCheck();
        });
        // The renderer's own dispatch and return events (World only); the
        // tracker hears each child once, whichever source reports it first.
        on('subagent:dispatched', (event) => {
            this._submitOutcomes(this._outcomeTracker.dispatched(event ?? {}));
        });
        on('subagent:completed', (event) => {
            this._submitOutcomes(this._outcomeTracker.completed(event ?? {}));
        });
        // Gold only from verified outcomes (S6).
        on('outcome:verified', (outcome) => {
            const fact = verifiedOutcomeFact(outcome);
            if (fact) this._submitOutcomes([fact]);
        });
        // World only: AgentEventStream (its producer) runs only in World mode,
        // so Dashboard never hears a failed command.
        on('tool:result', (event) => {
            const fact = toolFailedFact(event);
            if (fact) this._submitOutcomes([fact]);
        });
        // World only (the renderer's harbor summary): a repo whose failed
        // pushes grew is a failed push; the first summary is a baseline.
        on('harbor:updated', (repos) => {
            const { facts, state } = failedPushFacts(this._harborFailures, repos);
            this._harborFailures = state;
            this._submitOutcomes(facts);
        });

        // The feed's health (3.7), in its own vocabulary.
        on('ws:state', (payload) => this._observeLink('ws:state', payload));
        on('ws:disconnected', () => this._observeLink('ws:disconnected'));
        on('watcher:state', (payload) => this._observeLink('watcher:state', payload));
        // The return digest's phrase: sound-only, its toast is the caption.
        on('attention:digest', (payload) => this._playDigest(payload));

        on('village:scene', (scene) => {
            if (!this._signalRouting) return;
            const agentId = scene?.agentId ?? scene?.agent?.id ?? null;
            const label = scene?.agent?.name || scene?.agent?.agentName || scene?.label;
            const provider = this._agentProvider(scene, agentId);
            if (scene?.kind === 'arrival') {
                this.cue('arrival', {
                    agentId,
                    label,
                    provider,
                    teamName: this._agentTeam(scene, agentId),
                    ...spatialFields(scene),
                });
            }
            else if (scene?.kind === 'departure') {
                this.cue('departure', { agentId, label, provider, ...spatialFields(scene) });
                if (agentId != null) this._agentAudioContext.delete(agentId);
            }
        });

        on('distress:watchtower', (payload) => {
            if (!this._signalRouting) return;
            const kind = payload?.kind;
            const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
            if (kind === 'errored' || kind === 'rate_limited') {
                this._playActionable(payload, kind);
            } else if (kind === 'recovered') {
                this._actionable.forget(agentId);
                this.cue('recovery', {
                    agentId,
                    label: this._agentLabel(payload, agentId),
                    provider: this._agentProvider(payload, agentId),
                    ...spatialFields(payload),
                });
            }
        });

        // A gathering is the ceremony its members' arrivals were part of: it
        // supersedes their routine aggregate instead of losing to its spacing.
        on('team:gather', (payload) => {
            if (!this._signalRouting) return;
            const members = Array.isArray(payload?.members) ? payload.members : [];
            this.cue('council', {
                agentId: payload?.agentId ?? null,
                teamName: payload?.teamName ?? null,
                teamSize: Array.isArray(payload?.members)
                    ? members.length
                    : payload?.teamSize ?? payload?.size,
                supersedes: members,
            });
        });
        // A release's aurora is the release itself, which rings its own peal
        // from `outcome:verified` (3.4): one sound per fact.
        on('chronicle:aurora', (payload) => {
            if (!this._signalRouting || payload?.reason === 'release') return;
            this.cue('aurora', { agentId: payload?.agentId ?? null });
        });
        // The one cue that is about the listener rather than the world.
        on('attention:raised', (payload) => {
            if (this._signalRouting) this._playActionable(payload, attentionStatus(payload, this.world));
        });
    }

    // While Signals plays: the World's atmosphere broadcast, for the phase.
    _subscribeRuntime() {
        this._unsubscribes.push(eventBus.on('atmosphere:updated', (snapshot) => {
            if (!snapshot) return;
            this._atmosphere = snapshot;
            this._atmosphereAt = Date.now();
            this._atmosphereSource = 'world';
        }));
    }

    _rememberAgentAudioContext(agent) {
        const agentId = agent?.id;
        if (agentId == null) return;
        const previous = this._agentAudioContext.get(agentId) || {};
        this._agentAudioContext.set(agentId, {
            provider: agent?.provider || previous.provider || null,
            teamName: agent?.teamName || previous.teamName || null,
            position: copyPosition(agent?.position) || previous.position || null,
            spot: explicitSpot(agent) ?? previous.spot ?? null,
            building: buildingOf(agent) ?? previous.building ?? null,
            at: Date.now(),
        });
        // A removed agent can wait briefly for its departure scene. Keep this
        // cache bounded when a long-running village cycles many sessions.
        while (this._agentAudioContext.size > 128) {
            const oldest = this._agentAudioContext.keys().next().value;
            if (oldest == null) break;
            this._agentAudioContext.delete(oldest);
        }
    }

    _agentProvider(payload, agentId) {
        return payload?.provider
            || payload?.agent?.provider
            || this._agentAudioContext.get(agentId)?.provider
            || this.world?.agents?.get?.(agentId)?.provider
            || null;
    }

    _agentTeam(payload, agentId) {
        return payload?.agent?.teamName
            || this._agentAudioContext.get(agentId)?.teamName
            || this.world?.agents?.get?.(agentId)?.teamName
            || null;
    }

    // Both actionable events land here; the router picks the voice from the
    // bucket and spends one cue per agent entry. A hidden page hands the
    // routed cue to the controller's wake path instead of the suspended mix.
    // A stale observation raises nothing (S6).
    _playActionable(payload, status) {
        const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
        const agent = this.world?.agents?.get?.(agentId) ?? payload?.agent ?? null;
        if (agent && !isAudibleAgent(agent, Date.now())) return false;
        return this._actionable.route({ agentId, status }, (kind, family) => {
            const details = {
                ...spatialFields(payload),
                agentId,
                label: this._agentLabel(payload, agentId),
                provider: this._agentProvider(payload, agentId),
                status,
                family,
                waitingCount: payload?.waitingCount,
                oldestWaitMs: payload?.oldestWaitMs,
                // The ladder's L1 is the entry call; to an operator who is
                // already looking it rings as L2 (S7).
                ...(kind === 'summons' ? { level: this._operatorLooking?.() ? 2 : 1 } : {}),
            };
            if (this.hidden && this._hiddenSummonsHandler) {
                this._hiddenSummonsHandler({ ...payload, ...details, audioCueKind: kind });
                return true;
            }
            return this.cue(kind, details);
        });
    }

    _agentLabel(payload, agentId) {
        return payload?.agent?.name
            || payload?.agent?.agentName
            || this.world?.agents?.get?.(agentId)?.name
            || payload?.label
            || payload?.reason
            || null;
    }

    // A signal-route cue that must reach a hidden page (reminders, the
    // answered strike, link cues) goes through the wake; otherwise it plays.
    _signalCue(kind, details) {
        if (this.hidden && this._hiddenSummonsHandler) {
            this._hiddenSummonsHandler({ ...details, audioCueKind: kind });
            return true;
        }
        return this.cue(kind, details);
    }

    // The mix a cue this director plays on the Town band's behalf lands in:
    // the band's ducks and its bed window.
    _presetDetails() {
        return this._signalRouting ? {} : { preset: 'townBand', bed: 'music' };
    }

    _submitOutcomes(facts) {
        if (!this._signalRouting) return;
        for (const fact of facts) this._outcomes.submit(fact);
    }

    // One aggregated outcome → one cue with its exact count. A batch that
    // closes after the Town band took the signals still plays, in its mix.
    _playOutcome(outcome) {
        const agentId = outcome.agentId ?? null;
        const details = {
            agentId,
            label: agentId != null ? this._agentLabel(null, agentId) : null,
            count: outcome.count,
            repo: outcome.repo,
            version: outcome.version,
            ...(outcome.building ? { building: outcome.building } : {}),
            ...this._presetDetails(),
        };
        details.spot = this._spotFor(details, agentId);
        return this.cue(outcome.kind, details);
    }

    _spotFor(payload, agentId) {
        return resolveCueSpot(payload, {
            agentId,
            dashboard: this._mode === 'dashboard',
            world: this.world,
            remembered: this._agentAudioContext.get(agentId),
        });
    }

    // Agent events arrive a poll at a time: count the wait once per batch.
    _queueWaitCheck() {
        if (this._waitCheckQueued) return;
        this._waitCheckQueued = true;
        queueMicrotask(() => {
            this._waitCheckQueued = false;
            this._applyWaiting(waitState(this.world, Date.now()));
        });
    }

    // The last answer ends the wait audibly (S6): Signals (7.2) and the
    // hidden signals-only route ring the `answered` strike. A wait that only
    // went stale was not answered: it ends without a sound.
    _applyWaiting({ waiting = 0, unheard = 0, family = null } = {}) {
        const was = this._waiting;
        this._waiting = waiting;
        if (family) this._waitFamily = family;
        if (was === waiting) return;
        const answered = waiting === 0 && unheard === 0;
        const strikes = this.hidden || this.running;
        if (was > 0 && answered && strikes && this._signalRouting) {
            this._signalCue('answered', familyCuePayload({ family: this._waitFamily }));
        }
    }

    _observeLink(event, payload = {}) {
        const change = this._link.observe(event, payload, Date.now());
        if (change === 'restored') this._signalCue('linkRestored', this._presetDetails());
        this._armLinkTimer();
    }

    // A timer only decides that the loss is due; the cue is placed on the
    // audio clock like any other (S4). The change is said once.
    _armLinkTimer() {
        clearTimeout(this._linkTimer);
        this._linkTimer = null;
        const due = this._link.dueAt();
        if (due == null) return;
        this._linkTimer = setTimeout(() => {
            this._linkTimer = null;
            if (this._link.check(Date.now()) === 'lost') this._signalCue('linkLost', this._presetDetails());
            else this._armLinkTimer();
        }, Math.max(0, due - Date.now()));
    }

    // The return digest (SIG-15): a bounded phrase, past first and the open
    // wait last; nothing when nothing happened.
    _playDigest(payload) {
        if (!(Number(payload?.awayMs) >= UNATTENDED_DIGEST_THRESHOLD_MS)) return false;
        const notes = digestNotes(payload);
        if (!notes.length) return false;
        return this.cue('digest', { notes, soundOnly: true, ...this._presetDetails() });
    }

    cue(kind, extra = {}) {
        if (!this.cueKit) return false;
        const payload = { phase: this._phase, ...extra };
        const agentId = payload.agentId ?? payload.agent?.id ?? null;
        if (agentId != null && payload.provider == null) {
            payload.provider = this._agentProvider(payload, agentId);
        }
        // Placed once, here, when the cue is raised; CueKit turns the spot
        // into pan, distance and air at schedule time (plan S5).
        if (cuePlacementKind(kind)) payload.spot ??= this._spotFor(payload, agentId);
        payload.lane = laneForCueKind(kind);
        if (cueLifecycleDecision({ lane: payload.lane, hidden: this.hidden }) !== 'play') {
            return false;
        }
        // Signals sounds the attention voices only; the rest caption (7.2).
        // A cue raised on the Town band's behalf sounds in the band's mix.
        if (this._signalRouting && !SIGNALS_SOUNDING.has(kind)) payload.announceOnly = true;
        // The S2 window the bed-aware trim aims at: the band's music when
        // the cue plays in its mix, otherwise the no-music bed.
        payload.bed ??= NO_MUSIC_BED;
        return this.cueKit.play(kind, payload);
    }

    _currentAtmosphere() {
        if (this._atmosphere && Date.now() - this._atmosphereAt < ATMO_FRESH_MS) {
            return this._atmosphere;
        }
        this._atmosphereSource = 'local';
        return createAtmosphereSnapshot({});
    }

    _tick() {
        if (!this.running) return;
        this._phase = this._currentAtmosphere().phase || 'day';
        if (this._signalRouting && this._airPhase !== this._phase) {
            this._airPhase = this._phase;
            this.engine.setAirPhase?.(this._phase);
        }
        this._applyWaiting(waitState(this.world, Date.now()));
    }

    snapshot() {
        return {
            running: this.running,
            state: this.hidden ? 'hidden' : (this.running ? 'active' : 'stopped'),
            phase: this._phase,
            atmosphereSource: this._atmosphereSource,
            lastCue: this.cueKit?.lastCue || null,
            ceremonies: this.governor?.snapshot().ceremonies ?? null,
            // Honest silence (3.7): the audible wait and the feed's health.
            audible: { waiting: this._waiting },
            link: this._link.snapshot(Date.now()),
            outcomes: this._outcomes.pending(),
        };
    }
}
