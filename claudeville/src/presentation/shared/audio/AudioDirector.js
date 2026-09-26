// The soundscape brain. Once per second it reads the world — atmosphere
// snapshot (time-of-day phase, weather, season) and agent stats — and steers
// each ambience layer's intensity with slow slews, the world bus's weather
// ceiling and the circadian tilt. Discrete village moments arrive over the
// event bus and become one-shot cues through the engine-owned cue arbiter
// (`cues = { kit, governor }`, injected; never built or destroyed here).
//
// Honest silence (plan 3.7): every continuous mapping follows only audible
// (non-stale) agents, and a lost feed fades the work stratum and the held
// note and says so once. The feed's link cues and the return digest are
// this director's in both presets — it is the one alive from boot — and play
// in the Town band's context while that band owns the signals.
//
// Atmosphere source: the World renderer broadcasts its per-frame snapshot as
// `atmosphere:updated` (so debug overrides and village weather influence are
// heard, not just seen). When that stream goes quiet — Dashboard mode stops
// the render loop — the director computes its own snapshot; AtmosphereState
// is pure local-clock, so ambience keeps tracking time and weather anywhere.

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
import { seasonTokenForAtmosphere } from '../../character-mode/SeasonalAmbience.js';
import { readCountHours } from '../SoundSettings.js';
import { clamp01 } from './AudioEngine.js';
import { rngStream } from './Rng.js';
import { cueLifecycleDecision, updateQuietFloor } from './CueGovernor.js';
import { cuePlacementKind, laneForCueKind } from './cues/CueKit.js';
import { buildingOf, explicitSpot, resolveCueSpot } from './SpatialField.js';
import {
    ActionableCueRouter,
    attentionStatus,
    familyCuePayload,
    hourChimeFor,
} from './ActionableRouting.js';
import { LinkHealth, audibleCounts, digestNotes, isAudibleAgent, waitState } from './AudibleWorld.js';
import { cricketLevel, cricketTemperature, dayArcAt, weatherBirdRates } from './DayArc.js';
import { SeaLayer } from './layers/SeaLayer.js';
import { WindLayer } from './layers/WindLayer.js';
import { RainLayer } from './layers/RainLayer.js';
import { BirdsLayer } from './layers/BirdsLayer.js';
import { CricketsLayer } from './layers/CricketsLayer.js';
import { VillageHumLayer } from './layers/VillageHumLayer.js';
import { HeldNote } from './layers/HeldNote.js';
import { Sequencer } from './music/Sequencer.js';

const TICK_MS = 1000;
const DIRECTOR_ID = 'ambient';
// Pause in place (2.1): the groups close over 80 ms and reopen over 250 ms.
const PAUSE_CLOSE_SEC = 0.08;
const RESUME_OPEN_SEC = 0.25;
const ATMO_FRESH_MS = 3000;
const QUIET_ENTER_MS = 30000;
const QUIET_LEAVE_MS = 4000;

// Weather and resting budgets (plan 1.4; MIX-3, SCN-5).
// The world bus yields up to WEATHER_CEILING_DB as rain or a storm builds,
// reaching it at WEATHER_FULL (a steady rain already counts as full), so
// weather swells without taking the urgent bell's headroom. Measured with
// `node scripts/audio/probe.mjs --only scenes` on the Wave-4 bed
// (PROGRAM_TRIM_DB 26.7, standard step, A = −38.0): rain A + 0.2, storm
// A + 5.2 with its thunder (ST max −29.2), urgent-cue GR ≤ 2.7 dB over both.
export const WEATHER_CEILING_DB = -8;
const WEATHER_FULL = 0.7;
// The fair-weather wind law: strength at calm and its rise per unit of
// weather intensity (a clear day's 0.18 reads 0.136, overcast's 0.68 0.18):
// cloud is not wind, so fair weather moves the breeze ≈ 2.5 dB. A storm
// adds its gale on top, up to the rain cap below.
const WIND_CALM = 0.12;
const WIND_PER_INTENSITY = 0.09;
const WIND_PER_STORM = 0.3;
// Rain-day wind at 0.4 sat 9 dB over calm; while it rains, wind stays under this.
export const RAIN_WIND_CAP = 0.3;
// Precipitation above this counts as audible rain (winter snow is hushed upstream).
const RAIN_AUDIBLE = 0.05;
// Resting keeps the world at the S2 pilot light (A − 10 ± 3 LU): the sea
// at 0.42 of its waking level (−7.5 dB) carries it, weather reads through at 0.3 of its
// waking level, and nothing else of the world sings.
export const RESTING_SEA_SCALE = 0.42;
const RESTING_WEATHER_SCALE = 0.3;
// A storm (its sea, rain, rumble and thunder) reads through a resting
// village at a smaller share: with its rain and strikes at 0.3 the resting
// storm sat at A − 6.7 (S2 wants A − 10 ± 3).
const RESTING_STORM_SCALE = 0.1;
// The Village composer's level, re-measured on the Wave-4 bed: at 0.375 the
// continuous composer carried the busy session to A + 7.2 (music the loudest
// stem, 3.3 dB under the program's energy); 0.25 puts it at bed level.
// The occasion clock (6.6) replaces this constant.
const VILLAGE_MUSIC_LEVEL = 0.25;
// Slew (s) of the first tick after start(): layers reach their targets under
// the director crossfade instead of trailing it by their slow time constants.
const PRIME_TIME_CONSTANT = 0.05;
// A lost feed fades the work stratum over ~3 s (SIG-9): τ 1 s is 95 % there.
const LINK_FADE_TIME_CONSTANT = 1;

// Thunder trails the drawn flash by its distance (AMB-6): a near strike
// (intensity 1) 0.4 s after it, a far one (intensity 0) 4.9 s.
export function thunderLeadMs(intensity) {
    return (0.4 + 4.5 * (1 - clamp01(intensity))) * 1000;
}

/**
 * Weather and resting budgets on one tick's layer levels (0..1), in place.
 * `precipitation` is the heard rain amount (winter snow already hushed) and
 * `storm` the storm intensity. Wind is capped while it rains, and the
 * Village music rests through rain and storm (S7: no melodic duty there);
 * resting keeps only the world stratum, at the pilot light: the sea, with
 * the weather (rain and the storm the sea and rain play) scaled down. The sea's own weather physics live in SeaLayer.
 * Returns the world bus's weather ceiling in dB (≤ 0), scaled by how much
 * weather there is.
 */
export function applyWorldBudgets(levels, { precipitation = 0, storm = 0, resting = false } = {}) {
    const rain = clamp01(precipitation);
    if (rain > RAIN_AUDIBLE) levels.wind = Math.min(levels.wind, RAIN_WIND_CAP);
    if (rain > RAIN_AUDIBLE || storm > 0) levels.music = 0;
    if (resting) {
        levels.sea *= RESTING_SEA_SCALE;
        levels.wind *= RESTING_WEATHER_SCALE;
        levels.rain *= levels.storm > 0 ? RESTING_STORM_SCALE : RESTING_WEATHER_SCALE;
        levels.storm *= RESTING_STORM_SCALE;
        levels.birds = 0;
        levels.crickets = 0;
        levels.hum = 0;
        levels.music = 0;
    }
    const weather = clamp01(Math.max(rain, clamp01(storm)) / WEATHER_FULL);
    return weather > 0 ? WEATHER_CEILING_DB * weather : 0;
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

export class AudioDirector {
    // `cues = { kit, governor }` is the engine-wide cue arbiter (one CueKit and
    // one CueGovernor per engine, owned by the controller): budgets and
    // cooldowns survive a preset switch. Without it the director stays mute.
    constructor({ engine, world = null, cues = null } = {}) {
        this.engine = engine;
        this.world = world;
        this.layers = {};
        this.cueKit = cues?.kit ?? null;
        this.governor = cues?.governor ?? null;
        this._weatherBed = false;
        this._primed = false;
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
        this._arcKey = null;
        this._levels = {};
        this._overrides = new Map();
        this._lastBellHour = null;
        // Thunder is weather: its own stream, never shared with work or cues.
        this._rng = rngStream('weather.thunder');
        this._actionable = new ActionableCueRouter();
        this._agentAudioContext = new Map();
        this._mode = 'character';
        this._quietFloor = { mode: 'active', calmSince: null, activeSince: null };
        this._framePressureLevel = 0;
        // The held note (3.3) exists only while the Village plays.
        this._heldNote = null;
        // Audible actionable agents (3.3): the wait the held note carries and
        // whose last answer resolves it; the family of the oldest one.
        this._waiting = 0;
        this._waitFamily = null;
        this._waitCheckQueued = false;
        this._waitAnswered = false;
        this._audible = { agents: 0, working: 0, stale: 0 };
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

    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;
        this.paused = false;
        this._primed = false;
        // A rebuild after a long absence starts on a paused Transport.
        this.engine.transport.resume();
        // Layers feed this director's own group inputs, so a preset switch
        // can crossfade the whole director (plan 1.6).
        const options = { director: DIRECTOR_ID };
        this.layers = {
            sea: new SeaLayer(this.engine, options),
            wind: new WindLayer(this.engine, options),
            rain: new RainLayer(this.engine, options),
            birds: new BirdsLayer(this.engine, options),
            crickets: new CricketsLayer(this.engine, options),
            hum: new VillageHumLayer(this.engine, options),
            music: new Sequencer(this.engine, { ...options, preset: 'village' }),
        };
        for (const layer of Object.values(this.layers)) layer.start();
        this._heldNote = new HeldNote(this.engine, options);
        this._heldNote.start();

        this._subscribeRuntime();
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
        for (const layer of Object.values(this.layers)) layer.stop();
        this.layers = {};
        this._heldNote?.stop();
        this._heldNote = null;
    }

    // Pause in place (2.1, ENG-2): stop waking the Transport and the 1 Hz
    // mapping and close this director's groups over 80 ms. What is already
    // committed stays on the audio clock, which the controller then freezes
    // with `suspend()`, so a resume continues the same piece mid-phrase.
    // Returns the audio time at which the groups are silent.
    pause() {
        if (!this.running || this.paused) return this.engine.now();
        this.paused = true;
        clearInterval(this._interval);
        this._interval = null;
        this.engine.transport.pause();
        return this.engine.fadeDirector(DIRECTOR_ID, 0, { duration: PAUSE_CLOSE_SEC });
    }

    // Reopen over 250 ms and re-arm every process from the current audio
    // time: nothing missed while away is caught up.
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
        this._signalRouting = Boolean(enabled);
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
        // in Dashboard too (turn ends, dispatches, returns) and the wait the
        // held note follows; the tracker observes even while another director
        // owns the signals, so it always knows each agent's previous state.
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

        // Thunder trails the visible lightning by its distance (4.2): the
        // lag lives on the audio clock (the cue's lead), never a timer. A
        // resting village hears it as the rest of its weather, scaled down.
        on('weather:storm-flash', (payload) => {
            if (!this._signalRouting) return;
            const intensity = clamp01(payload?.intensity, 0.6);
            this.cue('thunder', { intensity: this._heardThunder(intensity), leadMs: thunderLeadMs(intensity) });
        });
    }

    _subscribeRuntime() {
        const on = (event, handler) => {
            this._unsubscribes.push(eventBus.on(event, handler));
        };

        on('atmosphere:updated', (snapshot) => {
            if (!snapshot) return;
            this._atmosphere = snapshot;
            this._atmosphereAt = Date.now();
            this._atmosphereSource = 'world';
        });
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

    // The last answer ends the wait audibly (S6): the Village resolves its
    // held note; the signals-only route rings the `answered` strike. A wait
    // that only went stale was not answered: it fades without resolving.
    _applyWaiting({ waiting = 0, unheard = 0, family = null } = {}) {
        const was = this._waiting;
        this._waiting = waiting;
        if (family) this._waitFamily = family;
        if (was === waiting) return;
        this._waitAnswered = waiting === 0 && unheard === 0;
        if (was > 0 && this._waitAnswered && this.hidden && this._signalRouting) {
            this._signalCue('answered', familyCuePayload({ family: this._waitFamily }));
        }
        this._syncHeldNote();
    }

    // Open while an audible agent waits, no music plays, the feed is live
    // and the Village is heard; the reason it closes tells the note whether
    // to resolve (answered) or only fade.
    _syncHeldNote() {
        if (!this._heldNote) return;
        const music = Boolean(this.engine.musicClock?.playing?.(this.engine.now()));
        const open = this._waiting > 0 && !music && !this._link.lost && !this.paused;
        let reason = null;
        if (!open) {
            if (this._link.lost) reason = 'link';
            else if (this._waiting === 0) reason = this._waitAnswered ? 'answered' : 'stale';
            else if (music) reason = 'music';
            else reason = 'paused';
        }
        this._heldNote.setState({ open, reason, phase: this._phase });
    }

    _observeLink(event, payload = {}) {
        const change = this._link.observe(event, payload, Date.now());
        if (change === 'restored') this._linkChanged('linkRestored');
        this._armLinkTimer();
    }

    // A timer only decides that the loss is due; the cue is placed on the
    // audio clock like any other (S4).
    _armLinkTimer() {
        clearTimeout(this._linkTimer);
        this._linkTimer = null;
        const due = this._link.dueAt();
        if (due == null) return;
        this._linkTimer = setTimeout(() => {
            this._linkTimer = null;
            if (this._link.check(Date.now()) === 'lost') this._linkChanged('linkLost');
            else this._armLinkTimer();
        }, Math.max(0, due - Date.now()));
    }

    // The work stratum and the held note follow the feed at once (the wind
    // stays), and the change is said once.
    _linkChanged(kind) {
        this._syncHeldNote();
        if (kind === 'linkLost') this.layers.hum?.setLevel(0, LINK_FADE_TIME_CONSTANT);
        this._signalCue(kind, this._presetDetails());
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
        // The S2 window the bed-aware trim aims at: over weather, over the
        // composer's music, or the plain village bed.
        payload.bed ??= this._bedContext();
        return this.cueKit.play(kind, payload);
    }

    _bedContext() {
        if (this._weatherBed) return 'weather';
        return this.layers.music?.nowPlaying ? 'music' : 'village';
    }

    // QA hook: pin a layer's level for `holdMs`, overriding the tick mapping.
    forceLayer(name, level, holdMs = 15000) {
        if (!this.layers[name]) return false;
        this._overrides.set(name, { level: clamp01(level), until: Date.now() + holdMs });
        this.layers[name].setLevel(clamp01(level), 0.3);
        return true;
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
        const atmosphere = this._currentAtmosphere();
        const weather = atmosphere.weather || {};
        const phase = atmosphere.phase || 'day';
        const phaseProgress = clamp01(atmosphere.phaseProgress);
        const season = seasonTokenForAtmosphere(atmosphere) || 'summer';
        // Only audible (non-stale) agents feed a continuous mapping (S6).
        const now = Date.now();
        const counts = audibleCounts(this.world, now);
        const working = Number(counts.working) || 0;
        this._audible = { agents: counts.audible.length, working, stale: counts.stale };
        const calm = counts.actionable === 0
            && working === 0
            && Number(counts.watchlist) === 0;
        this._quietFloor = updateQuietFloor(this._quietFloor, {
            calm,
            now,
            enterAfterMs: QUIET_ENTER_MS,
            leaveAfterMs: QUIET_LEAVE_MS,
        });

        this._phase = phase;
        const intensity = clamp01(weather.intensity);
        const winter = season === 'winter';
        // Winter precipitation falls as snow on screen: hush the rain layer
        // and let the wind carry the scene instead.
        const precipitation = winter
            ? clamp01(weather.precipitation) * 0.12
            : clamp01(weather.precipitation);
        const storm = weather.type === 'storm' ? intensity : 0;
        const windX = Math.abs(Number(weather.windX) || 0);
        // Place and time (4.5): the grade's two keys around the local minute,
        // eased like the picture, with the season applied. Weather and sea
        // read the atmosphere only; agents never reach them (S6).
        const minute = Number(atmosphere.clock?.minuteOfDay);
        const arc = dayArcAt({ minuteOfDay: Number.isFinite(minute) ? minute : 12 * 60, season });
        this._arcKey = arc.key;
        // A storm keeps its wind at night: the diurnal stillness is for fair weather.
        const diurnalWind = arc.wind + (1 - arc.wind) * storm;

        const levels = {
            sea: arc.sea,
            wind: clamp01((WIND_CALM + intensity * WIND_PER_INTENSITY + storm * WIND_PER_STORM) * diurnalWind
                + arc.windFloor
                + (winter && weather.precipitation > 0.1 ? 0.1 : 0)),
            rain: precipitation,
            // The storm the sea and the rain's rumble play (the world bus
            // ceiling below follows the real one).
            storm,
            birds: arc.birds,
            crickets: cricketLevel(arc.crickets, { precipitation, storm }),
            // The murmur's gate (4.7: its level follows W inside the layer):
            // silent while the feed is lost (SIG-9).
            hum: this._link.lost ? 0 : 1,
            music: VILLAGE_MUSIC_LEVEL * (phase === 'night' ? 0.7 : 1),
        };

        // Diagnostics only: GPU load never changes what the village sounds
        // like — a busy frame is not a quieter world.
        this._framePressureLevel = this._readFramePressure();

        const resting = this._quietFloor.mode === 'resting';
        // Snow is hushed rain, not weather the wind must yield to.
        const heardRain = winter ? 0 : levels.rain;
        const ceilingDb = applyWorldBudgets(levels, { precipitation: heardRain, storm, resting });
        this._weatherBed = heardRain > RAIN_AUDIBLE || storm > 0;

        for (const [name, override] of this._overrides) {
            if (Date.now() > override.until) this._overrides.delete(name);
            else levels[name] = override.level;
        }

        // The first tick after start() sets every layer at its target at once:
        // the director's own crossfade gain carries the fade-in (plan 1.6),
        // so slow slews here would leave a hole under the switch.
        const prime = this._primed ? null : PRIME_TIME_CONSTANT;
        this._primed = true;
        this.engine.setWeatherCeiling(ceilingDb, prime ?? 4);
        this.engine.setTilt(phase);
        // Island Air follows the phase (a 6 s crossfade between the day and
        // night rooms) and lets rain and fog colour its return (S5).
        this.engine.setAirPhase(phase);
        this.engine.setAirWeather({ rain: precipitation, fog: clamp01(weather.fog) });
        this.layers.sea.setWeather({ wind: windX, precipitation, storm: levels.storm }, prime);
        this.layers.sea.setPhase(phase, phaseProgress);
        this.layers.sea.setLevel(levels.sea, prime ?? 3);
        this.layers.wind.setWind({
            strength: levels.wind,
            wind: windX,
            windX: Number(weather.windX) || 0,
            fog: clamp01(weather.fog),
            winter,
        }, prime);
        this.layers.rain.setPrecipitation(levels.rain, prime ?? 4);
        this.layers.rain.setStorm(levels.storm, prime ?? 6);
        this.layers.birds.setLevel(levels.birds, prime ?? 3);
        // A silenced bird layer (resting, a forced 0) sings no phrases either.
        this.layers.birds.setCast(levels.birds > 0
            ? weatherBirdRates(arc.rates, { precipitation, storm })
            : weatherBirdRates(null), prime);
        this.layers.crickets.setLevel(levels.crickets, prime ?? 3);
        this.layers.crickets.setTemperature(cricketTemperature(season, phase === 'night' ? phaseProgress : 0));
        // The murmur follows the audible working count on the work bus and
        // darkens with the night without losing level (4.7, SIG-8).
        this.layers.hum.setMurmur({ working, dark: arc.dark }, prime ?? 3);
        this.layers.hum.setLevel(levels.hum, prime ?? (this._link.lost ? LINK_FADE_TIME_CONSTANT : 3));
        this.layers.music.setLevel(levels.music, prime ?? 3);
        this.layers.music.setPhase(phase);
        this.layers.music.setRestScale(1 - clamp01(working / 8) * 0.35);
        this._levels = levels;
        this._applyWaiting(waitState(this.world, now));
        this._syncHeldNote();

        // The hour chime (D7): the phrase by day, a soft chime at 21:00; the
        // count only when the operator asked for it.
        const chime = hourChimeFor(atmosphere.clock);
        if (chime && this._lastBellHour !== chime.hour) {
            const count = !chime.soft && readCountHours();
            if (this.cue('hourBell', { hour: chime.hour, soft: chime.soft, count })) {
                this._lastBellHour = chime.hour;
            }
        }

        // Storm thunder fallback when the World loop (and its flash events)
        // is not running — Poisson-ish, roughly one strike per 15–25 ticks,
        // at the same distance lag as a drawn flash.
        if (storm > 0 && this._atmosphereSource === 'local' && this._rng() < 0.03 + storm * 0.04) {
            this.cue('thunder', { intensity: this._heardThunder(storm), leadMs: thunderLeadMs(storm) });
        }
    }

    // The strike's level: its own intensity, or the resting share of it.
    _heardThunder(intensity) {
        return this._quietFloor.mode === 'resting' ? intensity * RESTING_STORM_SCALE : intensity;
    }

    snapshot() {
        return {
            running: this.running,
            state: this.hidden
                ? 'hidden'
                : (this.running ? this._quietFloor.mode : 'stopped'),
            resting: this.running && this._quietFloor.mode === 'resting',
            phase: this._phase,
            dayArc: this._arcKey,
            framePressureLevel: this._framePressureLevel,
            atmosphereSource: this._atmosphereSource,
            levels: { ...this._levels },
            lastCue: this.cueKit?.lastCue || null,
            nowPlaying: this.layers.music?.nowPlaying || null,
            ceremonies: this.governor?.snapshot().ceremonies ?? null,
            // Honest silence (3.7): what the continuous strata may follow.
            audible: { ...this._audible, waiting: this._waiting },
            link: this._link.snapshot(Date.now()),
            heldNote: this._heldNote?.snapshot?.() ?? null,
            outcomes: this._outcomes.pending(),
        };
    }

    _readFramePressure() {
        try {
            const snapshot = globalThis.window?.__claudeVillePerf?.frameHealth?.();
            const level = Number(snapshot?.level);
            return Number.isFinite(level) ? Math.max(0, Math.min(3, Math.round(level))) : 0;
        } catch {
            return 0;
        }
    }
}
