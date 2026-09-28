// Director for BGM mode: continuous town music instead of the reactive
// ambience. Music-first by design — no wind/rain/wildlife layers — with
// village event cues ringing over the score like game jingles (each cue ducks
// the band on its own notes, in the Town band depths). Time of day picks the playlist;
// the phase comes from the renderer's atmosphere broadcast, with a pure
// local-clock fallback when the World loop is stopped.
//
// The village's real working count picks a working band (MUSL-3: each band
// adds a player), applied at the band's next four-bar boundary; music never
// replaces the visible counts, and a real wait is never hidden behind a busy
// band. The band is the one music Sequencer, Town band preset, in the voice
// the operator chose (D2: the Isle Band by default, Chip restored on request).
//
// Wave 6 (D4) — the band carries the village without adding a layer: the
// workshop model's per-building densities drive the band's percussion (6.9),
// weather, season and the grade keyframe pick its arrangement (MUS-16,
// MUSL-8), and while anyone waits each phrase ends on a deceptive cadence
// that lands home after the answer (MUS-9). A verified release rings its
// fanfare inside the tune after the gold peal (6.8). The work stratum itself
// stays out of Town band.
//
// Wave 3 — while the band owns the signals it rings the same outcomes as
// the signal route (the routing is shared: ActionableRouting,
// OutcomeSignals) and the hour chime. In Town band a wait is carried by the
// band's own cadence (D4). The feed's link cues and the return digest stay
// with the signals director, alive from boot.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import { bucketCounts } from '../../../domain/services/SignalLedger.js';
import {
    OUTCOME_AGGREGATE_MS,
    OutcomeRouter,
    OutcomeTracker,
    failedPushFacts,
    isAggregatedOutcome,
    toolFailedFact,
    verifiedOutcomeFact,
} from '../../../application/OutcomeSignals.js';
import { expectCueScore } from './CueScore.js';
import { createAtmosphereSnapshot } from '../../character-mode/AtmosphereState.js';
import { seasonTokenForAtmosphere } from '../../character-mode/SeasonalAmbience.js';
import { readCountHours, readTownBandVoice } from '../SoundSettings.js';
import {
    ActionableCueRouter,
    attentionStatus,
    familyCuePayload,
    hourChimeFor,
} from './ActionableRouting.js';
import { audibleAgents, isAudibleAgent } from './AudibleWorld.js';
import { arrangementKeyframeAt } from './DayArc.js';
import { Sequencer } from './music/Sequencer.js';
import { arrangementWeatherFor } from './music/Voicings.js';
import { resolveCueSpot } from './SpatialField.js';
import { ACCENT_CAP_PER_MIN, BUILDING_IDS, buildWorkshopState, createWorkshopMemory } from './WorkshopModel.js';

const TICK_MS = 1000;
const ATMO_FRESH_MS = 3000;
// Pause in place (2.1): the band closes over 80 ms and reopens over 250 ms.
const PAUSE_CLOSE_SEC = 0.08;
const RESUME_OPEN_SEC = 0.25;

// Four working bands (MUS-8). The KPIs in the top bar state the exact
// counts, so the bands never have to.
const SECTION_BANDS = Object.freeze([
    Object.freeze({ section: 'rest', maxWorking: 0 }),
    Object.freeze({ section: 'light', maxWorking: 3 }),
    Object.freeze({ section: 'steady', maxWorking: 11 }),
    Object.freeze({ section: 'full', maxWorking: Infinity }),
]);
const SECTION_NAMES = Object.freeze(SECTION_BANDS.map(entry => entry.section));
// A building's percussion density (6.9): a working building plays a sparse
// floor, and its tool-start accent rate fills the groove up to 1.
const PERCUSSION_FLOOR = 0.3;
// The release fanfare waits for the gold peal (a Major outcome, ≤ 2.5 s).
const RELEASE_AFTER_PEAL_SEC = 2.5;
// Entering the resting section takes a 30s quiet hold; every other change
// takes 4s, so a poll-to-poll flutter can never rewrite the arrangement.
const SECTION_ENTER_REST_MS = 30000;
const SECTION_CHANGE_MS = 4000;
const BGM_LEVEL = 0.9;
// The engine's music attention stage while a person has to act (S3): the band
// leans back and stays there, composing with the per-cue ducks. Shallow
// enough that a wait-heavy stretch and an ordinary hour both sit in S2's
// −31 ± 1 (the waiting cadence, not the level, carries the wait).
const ATTENTION_DB = -2;

/**
 * The counts the working section is made of, from the same ledger the
 * signal route reads. `waiting` counts every agent that is waiting
 * (on a person or on work); `actionable` is the subset a person has to act
 * on, which is what leans the band back (the attention stage).
 */
export function workingSectionCounts(world) {
    const counts = bucketCounts(world);
    return {
        working: Number(counts.working) || 0,
        waiting: (Number(counts.needsYou) || 0) + (Number(counts.watchlist) || 0),
        needsYou: Number(counts.needsYou) || 0,
        watchlist: Number(counts.watchlist) || 0,
        actionable: Number(counts.actionable) || 0,
    };
}

/** The working band (0 rest … 3 full) for an audible working count. */
export function bandForWorking(working = 0) {
    const n = Math.max(0, Number(working) || 0);
    return SECTION_BANDS.findIndex(entry => n <= entry.maxWorking);
}

/**
 * Per-building percussion densities (0..1) from the workshop model: zero for
 * an idle building, `PERCUSSION_FLOOR` for a working one, rising with its
 * accent rate. Pure.
 */
export function percussionDensities(state) {
    const out = {};
    for (const id of BUILDING_IDS) {
        const building = state?.buildings?.[id];
        if (!(building?.working > 0)) continue;
        const rate = Math.max(0, Math.min(1, (Number(building.accentRate) || 0) / ACCENT_CAP_PER_MIN));
        out[id] = PERCUSSION_FLOOR + (1 - PERCUSSION_FLOOR) * rate;
    }
    return out;
}

export function sectionForCounts({ working = 0, actionable = 0 } = {}) {
    const band = SECTION_NAMES[bandForWorking(working)];
    // A real wait never hides behind a triumphant busy section.
    if (actionable > 0 && (band === 'steady' || band === 'full')) return 'light';
    return band;
}

/**
 * Pure section hysteresis: the applied section plus the one the counts want
 * next, never a fictional current state.
 */
export function updateWorkingSection(state = {}, { counts = null, now = 0 } = {}) {
    const applied = state.applied || 'steady';
    const wanted = sectionForCounts(counts || {});
    if (wanted === applied) return { applied, pending: null, pendingSince: 0 };
    const pendingSince = state.pending === wanted ? (state.pendingSince ?? now) : now;
    const holdMs = wanted === 'rest' ? SECTION_ENTER_REST_MS : SECTION_CHANGE_MS;
    if (now - pendingSince >= holdMs) return { applied: wanted, pending: null, pendingSince: 0 };
    return { applied, pending: wanted, pendingSince };
}

function cuePayload(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const agent = source.agent && typeof source.agent === 'object' ? source.agent : {};
    return {
        // Keep the original event fields (position, urgency, provider-specific
        // context, and any future additions) intact for CueKit consumers.
        ...source,
        agentId: source.agentId ?? agent.id ?? source.id ?? null,
        label: agent.name || agent.displayName || agent.agentName
            || source.agentName || source.displayName || source.name || source.label || null,
        provider: source.provider || agent.provider || null,
    };
}

export class BgmDirector {
    // `cues` is the engine-wide arbiter ({ kit, governor }) the controller owns;
    // a preset switch keeps its cooldowns, so this director never builds or
    // destroys it.
    constructor({ engine, world = null, cues = null } = {}) {
        this.engine = engine;
        this.world = world;
        this.player = null;
        this.cueKit = cues?.kit ?? null;
        this.governor = cues?.governor ?? null;
        this.running = false;
        this.paused = false;
        this._interval = null;
        this._unsubscribes = [];
        this._atmosphere = null;
        this._atmosphereAt = 0;
        this._atmosphereSource = 'none';
        this._phase = 'day';
        this._lastBellHour = null;
        this._actionable = new ActionableCueRouter();
        this._section = { applied: 'steady', pending: null, pendingSince: 0 };
        this._counts = workingSectionCounts(null);
        this._attentionDb = 0;
        this._operatorLooking = null;
        // Outcomes (3.4) while this band owns the signals: built on start.
        this._outcomeTracker = null;
        this._outcomes = null;
        this._harborFailures = null;
        this._voice = readTownBandVoice();
        this._workshopMemory = createWorkshopMemory();
        this._densities = {};
        // The sky is followed from construction (boot), so a band that starts
        // at night opens in its night arrangement, not the fallback clock's.
        this._atmosphereOff = eventBus.on('atmosphere:updated', (snapshot) => {
            if (!snapshot) return;
            this._atmosphere = snapshot;
            this._atmosphereAt = Date.now();
            this._atmosphereSource = 'world';
        });
    }

    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;
        this.paused = false;
        // A rebuild after a long absence starts on a paused Transport.
        this.engine.transport.resume();

        this._workshopMemory = createWorkshopMemory();
        this.player = new Sequencer(this.engine, { preset: 'townBand', director: 'bgm', voice: this._voice });
        // Everything the first chunk reads is in place before the band starts:
        // the sky, and the band the counts want now (the hysteresis is for
        // changes, not for the start).
        this._applyAtmosphere(this._currentAtmosphere());
        const counts = workingSectionCounts(audibleAgents(this.world, Date.now()));
        this._section = { applied: sectionForCounts(counts), pending: null, pendingSince: 0 };
        this._applyWorkingSection();
        this.player.start();
        this.player.setLevel(BGM_LEVEL, 0.5);

        // The agents already here are history, not outcomes.
        this._outcomeTracker = new OutcomeTracker({
            hasAgent: id => Boolean(this.world?.agents?.has?.(id)),
            isAudible: agent => isAudibleAgent(agent, Date.now()),
        });
        this._outcomeTracker.prime(this.world?.agents?.values?.() ?? []);
        this._outcomes = new OutcomeRouter({ emit: outcome => this._playOutcome(outcome) });
        this._harborFailures = null;

        this._subscribe();
        this._startTicking();
    }

    _startTicking() {
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    // Pause in place (2.1): the band holds its place in the tune; the
    // director's group closes over 80 ms and the Transport stops waking.
    // Returns the audio time at which the band is silent (the controller
    // suspends the context after it).
    pause() {
        if (!this.running || this.paused) return this.engine.now();
        this.paused = true;
        clearInterval(this._interval);
        this._interval = null;
        this.engine.transport.pause();
        return this.engine.fadeDirector('bgm', 0, { duration: PAUSE_CLOSE_SEC });
    }

    // Resume from the current audio time (no catch-up), fading in over 250 ms.
    resume() {
        if (!this.running || !this.paused) return;
        this.paused = false;
        this.engine.fadeDirector('bgm', 1, { duration: RESUME_OPEN_SEC });
        this.engine.transport.resume();
        this._startTicking();
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        this.paused = false;
        if (this._interval) clearInterval(this._interval);
        this._interval = null;
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
        this.player?.stop();
        this.player = null;
        this._setAttention(0);
        this._actionable.clear();
        this._outcomes?.destroy();
        this._outcomes = null;
        this._outcomeTracker = null;
    }

    destroy() {
        this.stop();
        this._atmosphereOff?.();
        this._atmosphereOff = null;
    }

    // D2: the Town band voice ('isle' | 'chip'); kept across rebuilds, and
    // a live band switches at its next four-bar boundary.
    setVoice(voice) {
        this._voice = voice === 'chip' ? 'chip' : 'isle';
        this.player?.setVoice(this._voice);
    }

    // S7: an entry summons while the operator is looking plays the L2 voice.
    setOperatorLooking(fn) {
        this._operatorLooking = typeof fn === 'function' ? fn : null;
    }

    /** A ladder reminder (3.3) in its wait's family voice, while the band plays. */
    playReminder(reminder = {}) {
        if (!this._ownsSignals()) return false;
        return this.cue('reminder', {
            ...familyCuePayload(reminder),
            agentId: reminder?.agentId ?? null,
            label: reminder?.label
                ?? this.world?.agents?.get?.(reminder?.agentId)?.name
                ?? null,
        });
    }

    // Paused (a hidden page), the signals director's route carries
    // every signal; the band speaks only while it is heard.
    _ownsSignals() {
        return this.running && !this.paused;
    }

    _subscribe() {
        const on = (event, handler) => {
            this._unsubscribes.push(eventBus.on(event, handler));
        };
        on('village:scene', (scene) => {
            if (scene?.kind === 'arrival') {
                const details = cuePayload(scene);
                this.cue('arrival', {
                    ...details,
                    teamName: scene?.agent?.teamName
                        || this.world?.agents?.get?.(details.agentId)?.teamName
                        || null,
                });
            } else if (scene?.kind === 'departure') this.cue('departure', cuePayload(scene));
        });
        on('distress:watchtower', (payload) => {
            const kind = payload?.kind;
            if (kind === 'errored' || kind === 'rate_limited') {
                this._playActionable(cuePayload(payload), kind);
            } else if (kind === 'recovered') {
                const details = cuePayload(payload);
                this._actionable.forget(details.agentId);
                this.cue('recovery', details);
            }
        });
        // A gathering supersedes its members' arrival aggregate (SCN-6).
        on('team:gather', (payload) => this.cue('council', {
            ...cuePayload(payload),
            teamName: payload?.teamName ?? null,
            teamSize: Array.isArray(payload?.members)
                ? payload.members.length
                : payload?.teamSize ?? payload?.size,
            supersedes: Array.isArray(payload?.members) ? payload.members : [],
        }));
        // A release's aurora is the release itself, which rings its own peal
        // from `outcome:verified` (3.4): one sound per fact.
        on('chronicle:aurora', (payload) => {
            if (payload?.reason !== 'release') this.cue('aurora', cuePayload(payload));
        });
        // The one cue that is about the listener rather than the world.
        on('attention:raised', (payload) => {
            this._playActionable(cuePayload(payload), attentionStatus(payload, this.world));
        });

        // Outcomes (3.4), the same sources and policy as the signal route.
        const track = facts => this._submitOutcomes(facts);
        on('agent:added', agent => track(this._outcomeTracker?.added(agent) ?? []));
        on('agent:updated', agent => track(this._outcomeTracker?.updated(agent) ?? []));
        on('agent:removed', agent => track(this._outcomeTracker?.removed(agent) ?? []));
        on('subagent:dispatched', event => track(this._outcomeTracker?.dispatched(event ?? {}) ?? []));
        on('subagent:completed', event => track(this._outcomeTracker?.completed(event ?? {}) ?? []));
        on('outcome:verified', (outcome) => {
            const fact = verifiedOutcomeFact(outcome);
            if (fact) track([fact]);
        });
        // World only (AgentEventStream runs only in World mode).
        on('tool:result', (event) => {
            const fact = toolFailedFact(event);
            if (fact) track([fact]);
        });
        // World only (the renderer's harbor summary); the first is a baseline.
        on('harbor:updated', (repos) => {
            const { facts, state } = failedPushFacts(this._harborFailures, repos);
            this._harborFailures = state;
            track(facts);
        });
    }

    _submitOutcomes(facts) {
        if (!this._ownsSignals() || !this._outcomes) return;
        for (const fact of facts) {
            // 8.3 — while the band sounds, the moment that carries an
            // aggregated fact (dispatch, return) waits for its note instead of
            // peaking before the aggregation window closes; 600 ms covers
            // CueKit's lead and the band's grid wait. An outcome emitted at
            // once (release, failed push) publishes its score inside `submit`,
            // so it needs no expectation — one registered after it would hold
            // its moment to the cap.
            const admitted = this._outcomes.submit(fact);
            if (admitted && isAggregatedOutcome(fact.kind) && this.engine?.started) {
                expectCueScore(fact.kind, fact.agentId ?? null, OUTCOME_AGGREGATE_MS + 600);
            }
        }
    }

    _playOutcome(outcome) {
        const agentId = outcome.agentId ?? null;
        // 6.8: the band's release fanfare follows the gold peal, at a bar.
        if (outcome.kind === 'release' && this._ownsSignals()) {
            this.player?.playOccasion('release', { reason: 'release', at: this.engine.now() + RELEASE_AFTER_PEAL_SEC });
        }
        return this.cue(outcome.kind, {
            agentId,
            label: agentId != null ? this.world?.agents?.get?.(agentId)?.name ?? null : null,
            count: outcome.count,
            repo: outcome.repo,
            version: outcome.version,
            ...(outcome.building ? { building: outcome.building } : {}),
        });
    }

    // The same bucket routing and per-agent dedupe as the signals director,
    // so an error never wears the needs-you voice in Town band either; a
    // stale observation raises nothing (S6).
    _playActionable(payload, status) {
        const agent = this.world?.agents?.get?.(payload.agentId) ?? payload.agent ?? null;
        if (agent && !isAudibleAgent(agent, Date.now())) return false;
        return this._actionable.route(
            { agentId: payload.agentId, status },
            (kind, family) => this.cue(kind, {
                ...payload,
                status,
                family,
                ...(kind === 'summons' ? { level: this._operatorLooking?.() ? 2 : 1 } : {}),
            }),
        );
    }

    cue(kind, extra = {}) {
        if (!this.running || !this.cueKit) return false;
        const payload = { phase: this._phase, preset: 'townBand', ...extra };
        payload.spot ??= resolveCueSpot(payload, {
            agentId: payload.agentId ?? payload.agent?.id ?? null,
            world: this.world,
        });
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
        const atmosphere = this._currentAtmosphere();
        this._applyAtmosphere(atmosphere);
        this._applyWorkingSection();

        // The hour chime (D7): the phrase by day, a soft chime at 21:00.
        const chime = hourChimeFor(atmosphere.clock);
        if (chime && this._lastBellHour !== chime.hour) {
            const count = !chime.soft && readCountHours();
            if (this.cue('hourBell', { hour: chime.hour, soft: chime.soft, count })) {
                this._lastBellHour = chime.hour;
            }
        }
    }

    // The arrangement follows the counts, not the poll: the density change is
    // handed to the band, which applies it at its next four-bar boundary. The
    // one immediate move is the attention stage an actionable agent earns.
    // Only audible (non-stale) agents move the band (S6).
    _applyWorkingSection(now = Date.now()) {
        this._counts = workingSectionCounts(audibleAgents(this.world, now));
        this._section = updateWorkingSection(this._section, { counts: this._counts, now });
        this.player?.setBand(SECTION_NAMES.indexOf(this._section.applied));
        this.player?.setWaiting(this._counts.actionable > 0);
        this._densities = percussionDensities(buildWorkshopState({
            agents: this.world?.agents ?? [],
            now,
            memory: this._workshopMemory,
        }));
        this.player?.setWorkshopDensity(this._densities);
        this._setAttention(this._counts.actionable > 0 ? ATTENTION_DB : 0);
    }

    _applyAtmosphere(atmosphere) {
        this._phase = atmosphere.phase || 'day';
        this.player.setPhase(this._phase);
        // The band's lead and counter ring in the Island Air of the hour.
        this.engine.setAirPhase?.(this._phase);
        this._applyArrangement(atmosphere);
    }

    // MUS-16 / MUSL-8: weather, season and the grade keyframe pick the
    // arrangement; the band applies a change at its next chunk.
    _applyArrangement(atmosphere) {
        const season = seasonTokenForAtmosphere(atmosphere) || 'summer';
        const minute = Number(atmosphere.clock?.minuteOfDay);
        this.player?.setArrangement({
            weather: arrangementWeatherFor(atmosphere.weather, season),
            season,
            keyframe: arrangementKeyframeAt({ minuteOfDay: Number.isFinite(minute) ? minute : 12 * 60, season }),
        });
    }

    _setAttention(db) {
        if (db === this._attentionDb) return;
        this._attentionDb = db;
        this.engine.setAttention(db);
    }

    countsSnapshot() {
        return { ...this._counts };
    }

    snapshot() {
        return {
            running: this.running,
            phase: this._phase,
            atmosphereSource: this._atmosphereSource,
            levels: { bgm: this.player?.level ?? 0 },
            lastCue: this.cueKit?.lastCue || null,
            nowPlaying: this.player?.nowPlaying || null,
            music: this.player?.snapshot() ?? null,
            voice: this._voice,
            percussion: { ...this._densities },
            ceremonies: this.governor?.snapshot().ceremonies ?? null,
            // The band actually playing plus the one the counts want next.
            section: {
                applied: this.player ? SECTION_NAMES[this.player.band] : this._section.applied,
                requested: this._section.applied,
                pending: this.player?.pendingBand != null ? SECTION_NAMES[this.player.pendingBand] : this._section.pending,
                counts: { ...this._counts },
            },
        };
    }
}
