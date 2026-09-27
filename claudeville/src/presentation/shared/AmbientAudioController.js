// The one sound state (C-UX1) between the top bar, SET and the audio system.
// Owns the opt-in lifecycle — off by default, user-gesture unlock, background
// policy, pause in place while away, hidden-tab wakes — and the listener's
// choices, persisted through SoundSettings: the preset (Off · Signals ·
// Village · Town band), a volume step per preset, the mix trims, output,
// tone, soften, hush and quiet hours. It is DOM-free: the chip, the SOUND
// popover and SET render `soundView()`, which it emits as `audio:sound-state`
// only when it changes. All sound is delegated to AudioEngine (mix chain,
// group faders, per-director crossfade gains, the Transport) and the two
// directors in ./audio/, which share the one cue arbiter this controller
// creates per engine. TopBar builds it at boot idle without an AudioContext,
// so the signal route and captions exist before any click. The signal route
// also carries the urgency ladder (plan 3.3): a 1 Hz timer, alive from boot
// whether or not sound is on, reminds an unanswered wait — as a caption with
// sound off, through the wake on a hidden page. The same tick re-reads hush
// and quiet hours and the popover's line; nothing here runs per frame.

import { AudioEngine } from './audio/AudioEngine.js';
import { AudioDirector } from './audio/AudioDirector.js';
import { BgmDirector } from './audio/BgmDirector.js';
import { FRAGMENTS } from './audio/bgm/BgmSongbook.js';
import { CueGovernor } from './audio/CueGovernor.js';
import { CueKit } from './audio/cues/CueKit.js';
import { cueNoteCount, cueNoteTime } from './audio/CueScore.js';
import { trimStepGain } from './audio/Loudness.js';
import { audibleAgents } from './audio/AudibleWorld.js';
import {
    LOOKING_L1_IDLE_MS,
    REMINDER_CAPS,
    isOperatorLooking,
    next as nextReminder,
} from './audio/UrgencyLadder.js';
import {
    AUDIO_MIXER_DEFAULTS,
    HUSH_DURATION_MS,
    SOUND_BACKGROUNDS,
    SOUND_PRESETS,
    SOUND_PRESET_LABELS,
    SOUND_RECALIBRATED_MESSAGE,
    hushActive,
    inQuietHours,
    migratePresetVolumes,
    modeForPreset,
    presetForMode,
    quietHoursEndsAt,
    readHushUntil,
    readPresetVolumeStep,
    readQuietHours,
    readReminderSetting,
    readSoundBackground,
    readSoundOutput,
    readSoundSoften,
    readSoundTone,
    readStoredSoundEnabled,
    readStoredSoundMode,
    readStoredTrimSteps,
    readTownBandVoice,
    recalibrateStoredSound,
    softenActive,
    soundStep,
    writeHushUntil,
    writePresetVolumeStep,
    writeQuietHours,
    writeSoundBackground,
    writeSoundOutput,
    writeSoundSoften,
    writeSoundTone,
    writeStoredSoundEnabled,
    writeStoredSoundMode,
    writeStoredTrimSteps,
    writeTownBandVoice,
} from './SoundSettings.js';
import { eventBus } from '../../domain/events/DomainEvent.js';

// Two directors: the ambient one plays the Village or, in its `signals`
// profile, Signals; the bgm one plays the Town band. A mode id is what
// storage keeps (`signals | ambient | bgm`); the UI names presets.
const DIRECTOR_IDS = Object.freeze(['ambient', 'bgm']);
function directorFor(mode) {
    return mode === 'bgm' ? 'bgm' : 'ambient';
}
// Village ↔ Town band is a walk from the square into the tavern (1.6,
// ENG-15): both directors play through an equal-power crossfade of their
// director gains, and the outgoing one stops only once its gain has reached
// zero. Into or out of Signals the island fades over 800 ms (UX-3).
const MODE_CROSSFADE_SEC = 2.5;
const SIGNALS_FADE_SEC = 0.8;
const CROSSFADE_STOP_MARGIN_MS = 50;
// D3's quiet mix (5.6): with "Keep playing", a blurred window's mixer faders
// take these factors on top of their trims, per mode. The Village drops its
// music and halves its world and work (the workshops keep their accents
// only; AudioDirector.setQuietMix); the Town band plays on at −3 dB; Signals
// has no bed. The cue bus and the held note (signalBed) have no fader here,
// and the engine's bed compensation (BLUR_BED_DB below) keeps their
// bed-aware levels: signals are unchanged.
export const BLUR_MIX = Object.freeze({
    ambient: Object.freeze({ wind: 0.5, rain: 0.5, wildlife: 0.5, hum: 0.5, workshops: 0.5, music: 0 }),
    bgm: Object.freeze({ music: 10 ** (-3 / 20) }),
});
// The bed each quiet mix leaves, in dB under the full one: the Village's
// world and work at half, the Town band at −3 dB. The engine adds it back to
// its bed reading, so cue trims and the held note level against the full bed.
const BLUR_BED_DB = Object.freeze({ ambient: 20 * Math.log10(2), bgm: 3 });
// Quiet hours (UX-11): Signals, a little softer.
const QUIET_HOURS_CUE_DB = -6;
// 7.4: the first real urgent cue after an enable names its family, once.
export const FAMILY_LINES = Object.freeze({
    summons: 'That call means an agent needs you.',
    distress: 'That call means an agent hit an error.',
    limit: 'That call means an agent hit a limit.',
});
const TEST_CALL_KINDS = new Set(Object.keys(FAMILY_LINES));
// A hidden-tab wake holds until the urgent cue has rung out (S8): its last
// note, plus the longest urgent bell decay in CueKit (distress, 3 s), plus the
// 80 ms margin before the fade closes.
const URGENT_TAIL_SEC = 3;
const WAKE_RELEASE_MARGIN_SEC = 0.08;
// A cue with no published score (an anonymous agent the score cannot key)
// still gets the summons' two-note span.
const UNSCORED_LAST_NOTE_SEC = 0.4;
// Pause in place (2.1, ENG-2): an absence longer than this, or one across a
// phase-family change (day ↔ night), rebuilds the village on return instead
// of resuming the piece where it stopped.
const RESUME_RESTART_MS = 10 * 60 * 1000;
// The context suspends once the groups' 80 ms close has certainly finished.
const PAUSE_SUSPEND_MARGIN_MS = 20;
// The signal route's ladder clock. A hidden tab's timers are throttled to
// about once a minute, which bounds a hidden reminder's lateness (≤ 60 s).
const SIGNAL_TICK_MS = 1000;
// Input that marks the operator as looking (reminders defer; L1 speaks softly).
const PRESENCE_INPUT_EVENTS = Object.freeze(['pointerdown', 'keydown', 'wheel']);
// An entry cue's trim is the wait's held trim when it was placed this recently.
const ENTRY_TRIM_WINDOW_SEC = 1;
const ENTRY_CUE_KINDS = new Set(['summons', 'distress', 'limit']);

function phaseFamily(phase) {
    return phase === 'night' ? 'night' : 'day';
}

// `paintedIsle` → `Painted Isle`; a fragment reads as the tune it is from.
const FRAGMENT_SOURCES = new Map(FRAGMENTS.map(fragment => [fragment.id, fragment.source]));
export function pieceTitle(piece) {
    const name = FRAGMENT_SOURCES.get(piece) ?? piece;
    if (!name) return '';
    return String(name)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function clockTime(ms) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function clockHour(date) {
    const hour = date.getHours();
    return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

export class AmbientAudioController {
    // `ownsGesture(target)` tells the unlock listener that a click belongs to
    // the sound control itself (the chip or its popover), which decides on
    // its own; `reducedMotion()` is the effective Reduce motion, which
    // *Soften sudden sounds* follows on `auto`.
    constructor({ world, ownsGesture, reducedMotion } = {}) {
        this.world = world || null;
        this._ownsGesture = typeof ownsGesture === 'function' ? ownsGesture : null;
        this._reducedMotion = typeof reducedMotion === 'function' ? reducedMotion : null;
        this.available = this._hasAudioSupport();
        this.enabled = readStoredSoundEnabled();
        // D5 (1.2): a profile from before the calibrated master is reset once
        // to the standard level; the caption follows once the route exists.
        // Then each preset's volume slot is seeded once from the old step.
        this._recalibrated = recalibrateStoredSound();
        migratePresetVolumes();
        this.mode = readStoredSoundMode();
        this.background = readSoundBackground();
        this.layerSteps = readStoredTrimSteps();
        this.output = readSoundOutput();
        this.tone = readSoundTone();
        this.soften = readSoundSoften();
        this.quietHours = readQuietHours();
        this.hushedUntil = readHushUntil();
        this._gestureSeen = false;
        this.unlockArmed = false;
        this._activationGeneration = 0;
        this._visibilityGeneration = 0;
        this._suspendTimer = null;
        // Set while the village is paused in place: `{ at, family }`.
        this._paused = null;
        this._hiddenSummonsPending = new Set();
        // Hidden-tab wakes: the newest token owns the release, which holds
        // until the latest scheduled urgent note has rung out.
        this._wakeToken = 0;
        this._wakeHoldUntil = 0;
        this._wakeCount = 0;
        // Mode crossfades: the outgoing director's stop, per director id,
        // pending until its gain has faded to zero; the Village's teardown
        // after its fade into Signals.
        this._crossfadeStops = new Map();
        this._profileTimer = null;
        // The mode the directors are set up for (null until sound first plays).
        this._playingMode = null;
        this._activation = null;
        this._destroyPromise = null;
        this._destroyed = false;
        this._windowBlurred = false;
        // D3 (5.6): the quiet mix a blurred "Keep playing" window hears.
        this._quietMix = { active: false, preset: null, factors: {} };
        // 7.4: the awakening plays once per page session; the family line is
        // armed by every enable (a stored-on profile's first start counts).
        this._awakening = { count: 0, at: null, perfAt: null };
        this._enablePending = this.enabled;
        // The urgency ladder's inputs: acknowledgements (agentId → ms), the
        // reminders spent this wait, the wait's held cue trim, presence.
        this._acks = new Map();
        this._ladderHistory = [];
        this._ladderWait = null;
        this._ladder = null;
        this._lastInputAt = 0;
        this._bellRings = null;
        this._viewKey = null;
        this._view = null;

        this.engine = new AudioEngine();
        this._quietActive = this._quietHoursNow();
        this.volumeStep = readPresetVolumeStep(this._effectiveMode());
        this.engine.setVolumeStep(this.volumeStep);
        this.engine.setOutput(this.output);
        this.engine.setTone(this.tone);
        this.engine.setCueTrim(this._quietActive ? QUIET_HOURS_CUE_DB : 0);
        this._applySoften();
        this._applyGroupLevels();
        // One cue arbiter per engine (1.6): both directors submit through the
        // same governor and kit, so a mode switch never resets a cooldown and
        // an agent summoned just before a switch is not summoned again after
        // it. The controller owns their lifetime; directors never build or
        // destroy them.
        const governor = new CueGovernor();
        this.cues = { kit: new CueKit(this.engine, governor), governor };
        this.directors = {
            ambient: new AudioDirector({
                engine: this.engine,
                world: this.world,
                cues: this.cues,
                profile: this._effectiveMode() === 'signals' ? 'signals' : 'village',
            }),
            bgm: new BgmDirector({ engine: this.engine, world: this.world, cues: this.cues }),
        };
        this.directors.ambient.setHiddenSummonsHandler?.((payload) => {
            this._handleHiddenSummons(payload);
        });
        // S7: an entry cue while the operator is looking plays the L2 voice.
        const looking = () => this._operatorLooking(LOOKING_L1_IDLE_MS);
        for (const director of Object.values(this.directors)) director.setOperatorLooking?.(looking);
        this._inactive = this._pageInactive();
        this.directors.ambient.setHidden(this._inactive);
        this.directors.ambient.setSignalRouting(true);

        this._onUnlockGesture = (event) => this._handleUnlockGesture(event);
        this._onVisibility = () => this._syncPresence();
        this._onWindowBlur = () => this._handleWindowBlur();
        this._onWindowFocus = () => this._handleWindowFocus();
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('blur', this._onWindowBlur);
            window.addEventListener('focus', this._onWindowFocus);
        }
        this._onPresenceInput = () => { this._lastInputAt = Date.now(); };
        if (typeof document !== 'undefined') {
            for (const type of PRESENCE_INPUT_EVENTS) {
                document.addEventListener(type, this._onPresenceInput, { capture: true, passive: true });
            }
        }
        this._onAcknowledged = (payload) => {
            if (payload?.agentId != null) this._acks.set(payload.agentId, Date.now());
        };
        eventBus.on('attention:acknowledged', this._onAcknowledged);
        // The wait opens here; its entry call may be placed by a director
        // subscribed after this one, so the capture runs again once the
        // event has reached every subscriber.
        this._onAttentionRaised = () => {
            this._openLadderWait();
            queueMicrotask(() => this._captureEntryTrim());
        };
        eventBus.on('attention:raised', this._onAttentionRaised);
        // D2: SET's Town band voice lands at the band's next chunk.
        this._onTownBandVoice = () => this.directors.bgm?.setVoice?.(readTownBandVoice());
        eventBus.on('sound:town-band-voice', this._onTownBandVoice);
        // The popover's line follows a piece change at once (7.3).
        this._onNowPlaying = () => this._publishView();
        eventBus.on('audio:now-playing', this._onNowPlaying);
        this._signalTimer = setInterval(() => this._signalTick(), SIGNAL_TICK_MS);

        if (this.enabled) {
            this._armUnlockListeners();
            // A returning user who already clicked before the idle build
            // (sticky activation) starts the village without a second click.
            if (this.userActivated) this._startActivation();
        }

        if (typeof window !== 'undefined') {
            this._debugHelper = () => this._debugSnapshot();
            window.__claudevilleAudio = this._debugHelper;
        }
        if (this._recalibrated) eventBus.emit('audio:recalibrated', { message: SOUND_RECALIBRATED_MESSAGE });
        this._emitBellState();
        this._publishView();
    }

    // Chrome's sticky activation makes `context.resume()` legal after any
    // earlier gesture on the page, not only one this controller observed.
    get userActivated() {
        return this._gestureSeen
            || globalThis.navigator?.userActivation?.hasBeenActive === true;
    }

    /** The preset the listener chose: `off | signals | village | townBand`. */
    get preset() {
        return this.enabled ? presetForMode(this.mode) : 'off';
    }

    /** The last preset that is not Off: the chip turns it back on. */
    get lastPreset() {
        return presetForMode(this.mode);
    }

    get hushed() {
        return this.enabled && (hushActive(this.hushedUntil, Date.now()) || this._quietActive);
    }

    // The chip, or `M`: Off ↔ the last preset. A control that is on but not
    // yet playing (armed) starts sound when clicked; only a sounding control
    // turns it off. Every call is a user activation.
    toggleFromUser() {
        if (!this.available || this._destroyed) return this.preset;
        this._gestureSeen = true;
        if (this.enabled && !this.isRunning() && !this._pageInactive()) {
            this._startActivation();
            return this.preset;
        }
        return this.setPreset(this.enabled ? 'off' : this.lastPreset, { fromUser: true });
    }

    /**
     * Choose how to listen (7.2). `fromUser` marks the call as a user
     * activation (the popover, SET, the invite), which may start the
     * context. Returns the preset now chosen.
     */
    setPreset(preset, { fromUser = false } = {}) {
        if (!this.available || this._destroyed || !SOUND_PRESETS.includes(preset)) return this.preset;
        if (fromUser) this._gestureSeen = true;
        if (preset === 'off') {
            if (this.enabled) {
                this.enabled = false;
                writeStoredSoundEnabled(false);
                this._enablePending = false;
                this.cues.kit.armFamilyLine(null);
                this._removeUnlockListeners();
                this._deactivate();
            }
            this._emitBellState();
            this._publishView();
            return this.preset;
        }
        const mode = modeForPreset(preset);
        if (mode !== this.mode) {
            this.mode = writeStoredSoundMode(mode);
            this._applyVolume();
        }
        if (!this.enabled) {
            this.enabled = true;
            writeStoredSoundEnabled(true);
            // 7.4: the first real urgent cue after this enable names its family.
            this._enablePending = true;
            this._armUnlockListeners();
            this._startActivation();
        } else if (this.isRunning()) {
            this._applyEffectiveMode();
        } else if (fromUser) {
            this._startActivation();
        }
        this._emitBellState();
        this._publishView();
        return this.preset;
    }

    // Playing, as the listener would hear it: the context runs and the active
    // director is running and not paused. Anything less is armed or off.
    isRunning() {
        return this.engine.context?.state === 'running'
            && this.director.running === true
            && !this.director.paused;
    }

    // Master volume as a whole step 0–10 (1.2) for the preset now heard
    // (7.8: each keeps its own); the engine applies the step law after the
    // ceiling.
    setVolumeStep(step) {
        if (this._destroyed) return this.volumeStep;
        this.volumeStep = writePresetVolumeStep(this._effectiveMode(), soundStep(step, this.volumeStep));
        this.engine.setVolumeStep(this.volumeStep);
        this._publishView();
        return this.volumeStep;
    }

    // A mixer trim as a whole step 0–10: 2.4 dB per step, 10 = unity.
    setLayerStep(name, step) {
        if (this._destroyed || !Object.hasOwn(AUDIO_MIXER_DEFAULTS, name)) return false;
        this.layerSteps[name] = soundStep(step, this.layerSteps[name]);
        writeStoredTrimSteps(this.layerSteps);
        this._applyGroupLevel(name);
        this._publishView();
        return true;
    }

    setBackground(background) {
        if (this._destroyed || !SOUND_BACKGROUNDS.includes(background)) return this.background;
        this.background = writeSoundBackground(background);
        this._syncPresence();
        this._publishView();
        return this.background;
    }

    // 7.7: Speakers · Headphones · Mono, Warm ↔ Bright, Soften sudden sounds.
    setOutput(output) {
        if (this._destroyed) return this.output;
        this.output = writeSoundOutput(output);
        this.engine.setOutput(this.output);
        this._publishView();
        return this.output;
    }

    setTone(tone) {
        if (this._destroyed) return this.tone;
        this.tone = writeSoundTone(tone);
        this.engine.setTone(this.tone);
        this._publishView();
        return this.tone;
    }

    setSoften(setting) {
        if (this._destroyed) return this.soften;
        this.soften = writeSoundSoften(setting);
        this._applySoften();
        this._publishView();
        return this.soften;
    }

    /** Reduce motion changed: `auto` soften follows it. */
    syncReducedMotion() {
        if (this._destroyed) return;
        this._applySoften();
        this._publishView();
    }

    _applySoften() {
        this.engine.setSoften(softenActive(this.soften, this._reducedMotion?.() ?? false));
    }

    // Hush and quiet hours (7.7, UX-11) drop to Signals; the summons still
    // sounds. Expiry crossfades back to the chosen preset, with no bells.
    hush(ms = HUSH_DURATION_MS) {
        if (this._destroyed) return this.hushedUntil;
        const duration = Math.max(0, Number(ms) || 0);
        this.hushedUntil = writeHushUntil(duration > 0 ? Date.now() + duration : 0);
        this._applyEffectiveMode();
        this._publishView();
        return this.hushedUntil;
    }

    resumeFromHush() {
        return this.hush(0);
    }

    setQuietHours(setting) {
        if (this._destroyed) return this.quietHours;
        this.quietHours = writeQuietHours(setting);
        this._syncQuietHours();
        this._publishView();
        return this.quietHours;
    }

    _quietHoursNow() {
        return inQuietHours(this.quietHours, new Date());
    }

    _syncQuietHours() {
        const active = this._quietHoursNow();
        if (active === this._quietActive) return;
        this._quietActive = active;
        this.engine.setCueTrim(active ? QUIET_HOURS_CUE_DB : 0);
        this._applyEffectiveMode();
    }

    /**
     * A sample of a call at the current volume (7.5's invite plays the
     * bucket that triggered it; the popover's preview is the summons). Not
     * a fact: no caption, no governor. Waits for an enable in flight;
     * resolves false when sound is not playing.
     */
    async testCall(kind = 'summons') {
        if (this._destroyed || !TEST_CALL_KINDS.has(kind)) return false;
        if (this._activation) await this._activation;
        if (this._destroyed || !this.engine.started || this.engine.context?.state !== 'running') return false;
        return this.cues.kit.play(kind, { test: true, phase: this.directors.ambient.currentPhase() });
    }

    playPreviewBell() {
        return this.testCall('summons');
    }

    /**
     * A hand on the sound control (hover, focus): build the context, its
     * worklets and graph ahead of the click, silent and suspended, so the
     * click's awakening does not wait for them (7.4). Never on its own: a
     * context exists only once the listener reaches for sound.
     */
    prewarm() {
        if (!this.available || this._destroyed || this.isRunning()) return;
        this.engine.prewarm?.();
    }

    // Signals while hushed or in quiet hours; the chosen mode otherwise.
    _effectiveMode() {
        if (this.enabled && (hushActive(this.hushedUntil, Date.now()) || this._quietActive)) return 'signals';
        return this.mode;
    }

    get director() {
        return this.directors[directorFor(this._playingMode ?? this._effectiveMode())];
    }

    _applyVolume() {
        const step = readPresetVolumeStep(this._effectiveMode());
        if (step === this.volumeStep) return;
        this.volumeStep = step;
        this.engine.setVolumeStep(step);
    }

    // Carry a playing village to the mode it should now be heard in: a
    // preset change, a hush or its end, quiet hours starting or ending. A
    // village that is not playing only records it; the next start uses it.
    _applyEffectiveMode() {
        this._applyVolume();
        const next = this._effectiveMode();
        const previous = this._playingMode;
        if (previous === null || next === previous) return;
        if (!this.enabled || this._pageInactive() || !this.isRunning()) {
            // Paused or stopping: the next start builds `next` from scratch.
            if (!this._paused) this._playingMode = null;
            return;
        }
        this._playingMode = next;
        const fromId = directorFor(previous);
        const toId = directorFor(next);
        if (fromId !== toId) {
            if (toId === 'ambient') this._setAmbientProfile(next);
            const seconds = previous === 'signals' || next === 'signals' ? SIGNALS_FADE_SEC : MODE_CROSSFADE_SEC;
            this._crossfade(fromId, toId, seconds);
        } else {
            this._fadeAmbientProfile(next);
        }
        this._syncQuietMix();
        this._syncSignalRouting();
    }

    _setAmbientProfile(mode) {
        this._cancelProfileTimer();
        this.directors.ambient.setProfile(mode === 'signals' ? 'signals' : 'village');
    }

    // Village ↔ Signals inside the one director: the island fades out
    // before its layers go, or is built silent and fades in.
    _fadeAmbientProfile(mode) {
        const ambient = this.directors.ambient;
        this._cancelProfileTimer();
        if (mode === 'signals') {
            const end = this.engine.fadeDirector('ambient', 0, { duration: SIGNALS_FADE_SEC });
            const fadeEnd = Number.isFinite(end) ? end : this.engine.now() + SIGNALS_FADE_SEC;
            const delayMs = Math.max(0, (fadeEnd - this.engine.now()) * 1000) + CROSSFADE_STOP_MARGIN_MS;
            this._profileTimer = setTimeout(() => {
                this._profileTimer = null;
                if (this._destroyed || this._playingMode !== 'signals') return;
                ambient.setProfile('signals');
                this.engine.fadeDirector('ambient', 1, { duration: 0 });
            }, delayMs);
            return;
        }
        // Back to the Village: still built mid-fade, it turns around.
        if (ambient.profile !== 'village') {
            this.engine.fadeDirector('ambient', 0, { duration: 0 });
            ambient.setProfile('village');
        }
        this.engine.fadeDirector('ambient', 1, { duration: SIGNALS_FADE_SEC });
    }

    _cancelProfileTimer() {
        if (this._profileTimer == null) return;
        clearTimeout(this._profileTimer);
        this._profileTimer = null;
    }

    // Equal-power crossfade of the two director gains (engine.fadeDirector).
    // The incoming director starts silent unless it is still fading out from
    // a switch moments ago, in which case it turns around from where it is.
    _crossfade(outgoingId, incomingId, seconds = MODE_CROSSFADE_SEC) {
        const incoming = this.directors[incomingId];
        this._cancelCrossfadeStop(incomingId);
        if (!incoming.running) {
            this.engine.fadeDirector(incomingId, 0, { duration: 0 });
            this.directors.ambient.setSignalRouting(incomingId !== 'bgm');
            incoming.start();
        }
        this.engine.fadeDirector(incomingId, 1, { duration: seconds });
        const end = this.engine.fadeDirector(outgoingId, 0, { duration: seconds });
        const fadeEnd = Number.isFinite(end) ? end : this.engine.now() + seconds;
        const delayMs = Math.max(0, (fadeEnd - this.engine.now()) * 1000) + CROSSFADE_STOP_MARGIN_MS;
        // The timer only wakes the stop; the fade itself lives on the audio
        // clock, and the director's own stop ramp declicks what is left.
        this._crossfadeStops.set(outgoingId, setTimeout(() => {
            this._crossfadeStops.delete(outgoingId);
            if (this._destroyed || directorFor(this._playingMode) === outgoingId) return;
            this.directors[outgoingId].stop();
            this._syncSignalRouting();
        }, delayMs));
        this._syncSignalRouting();
    }

    _cancelCrossfadeStop(id) {
        const timer = this._crossfadeStops.get(id);
        if (timer == null) return;
        clearTimeout(timer);
        this._crossfadeStops.delete(id);
    }

    _stopDirector(id) {
        this._cancelCrossfadeStop(id);
        this.directors[id].stop();
    }

    _stopDirectors() {
        this._cancelProfileTimer();
        for (const id of DIRECTOR_IDS) this._stopDirector(id);
        this._playingMode = null;
    }

    // The stored trims drive the engine's group faders; the engine keeps them
    // across context rebuilds, so layers keep their own world-driven levels.
    // The quiet mix (D3) scales a fader without touching its stored step.
    _applyGroupLevels() {
        for (const name of Object.keys(this.layerSteps)) this._applyGroupLevel(name);
    }

    _applyGroupLevel(name) {
        const factor = this._quietMix.factors[name] ?? 1;
        this.engine.setGroupLevel(name, trimStepGain(this.layerSteps[name]) * factor);
    }

    // D3 (5.6): a visible window without focus and with "Keep playing"
    // hears the quiet mix of the mode it plays; focus restores the trims at
    // the faders' 50 ms glide. "Signals only" pauses instead (hidden).
    _syncQuietMix() {
        const active = this._windowBlurred
            && this.background === 'play'
            && !(typeof document !== 'undefined' && document.hidden);
        const preset = active ? this._effectiveMode() : null;
        if (active === this._quietMix.active && preset === this._quietMix.preset) return;
        this._quietMix = { active, preset, factors: active ? (BLUR_MIX[preset] ?? {}) : {} };
        this._applyGroupLevels();
        this.engine.setBedCompensation(active ? (BLUR_BED_DB[preset] ?? 0) : 0);
        this.directors.ambient.setQuietMix(active && preset === 'ambient');
    }

    // One activation at a time; `testCall` waits for it.
    _startActivation() {
        const activation = this._activate().finally(() => {
            if (this._activation === activation) this._activation = null;
            this._emitBellState();
            this._publishView();
        });
        this._activation = activation;
        return activation;
    }

    async _activate() {
        if (!this.enabled || !this.available || this._destroyed || this._pageInactive()) return;
        if (this._suspendTimer) {
            clearTimeout(this._suspendTimer);
            this._suspendTimer = null;
        }
        // A pending hidden-tab wake no longer owns the release.
        this._wakeToken++;
        this._wakeHoldUntil = 0;
        this.directors.ambient.setHidden(false);
        this.directors.ambient.setSignalRouting(this._effectiveMode() !== 'bgm');
        const activationGeneration = ++this._activationGeneration;
        const visibilityGeneration = this._visibilityGeneration;
        let ready = false;
        try {
            ready = await this.engine.ensureContext();
        } catch {
            return;
        }
        if (
            !ready
            || !this.enabled
            || this._destroyed
            || this._pageInactive()
            || activationGeneration !== this._activationGeneration
            || visibilityGeneration !== this._visibilityGeneration
        ) {
            if (this._pageInactive()) await this.engine.suspend();
            return;
        }

        this.engine.start();
        // The latch goes first, before any director builds (7.4).
        const awakening = this._awaken();
        // Back from an absence: continue the piece where it stopped, unless
        // the absence was long or crossed day ↔ night, which rebuilds.
        const away = this._paused;
        this._paused = null;
        if (away && !this._resumable(away)) this._stopDirectors();
        for (const director of Object.values(this.directors)) {
            if (director.paused) director.resume();
        }
        const mode = this._effectiveMode();
        if (this._playingMode !== null && this._playingMode !== mode) {
            // A hush that began or ended while away.
            this._applyEffectiveMode();
        } else {
            this._playingMode = mode;
            const id = directorFor(mode);
            const director = this.directors[id];
            // Only the mode's own director plays after a fresh start.
            for (const other of DIRECTOR_IDS) if (other !== id && this.directors[other].running) this._stopDirector(other);
            if (id === 'ambient') this._setAmbientProfile(mode);
            // A crossfade interrupted by a disable, or a rebuild, may have
            // left this director's gain part-way; a fresh start plays at
            // full level.
            if (!director.running) this.engine.fadeDirector(id, 1, { duration: 0 });
            director.start({ bloom: awakening });
        }
        if (this._enablePending) {
            this._enablePending = false;
            this.cues.kit.armFamilyLine(FAMILY_LINES);
        }
        this._syncQuietMix();
        this._syncSignalRouting();
        this._removeUnlockListeners();
    }

    // 7.4: the first time sound starts in a page session, a latch and two
    // small bells within 150 ms; the island then opens world first (the
    // director's bloom). Never again in this session (later enables only
    // fade). Returns true when it played.
    _awaken() {
        if (this._awakening.count > 0) return false;
        const played = this.cues.kit.playAwaken?.({ phase: this.directors.ambient.currentPhase() });
        if (!played) return false;
        const contextTime = this.engine.now();
        const perfAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._awakening = { count: 1, at: contextTime, perfAt };
        eventBus.emit('audio:awakened', { contextTime, perfAt, preset: this.preset });
        return true;
    }

    _deactivate({ forceSuspend = false, visibilityGeneration = this._visibilityGeneration } = {}) {
        this._activationGeneration++;
        this._paused = null;
        this._stopDirectors();
        // Pending routine cues describe a moment the listener has left.
        this.cues.governor.clearRoutine();
        this.directors.ambient.setSignalRouting(true);
        this.engine.stop();
        if (this._suspendTimer) clearTimeout(this._suspendTimer);
        this._suspendTimer = setTimeout(() => {
            this._suspendTimer = null;
            if (this._destroyed) return;
            const hiddenGenerationMatches = (
                forceSuspend
                && this._pageInactive()
                && visibilityGeneration === this._visibilityGeneration
            );
            if (!this.enabled || hiddenGenerationMatches) void this.engine.suspend();
        }, 800);
        this._publishView();
    }

    _handleUnlockGesture(event) {
        if (!this.enabled || this.isRunning()) return;
        // The sound control's own click decides through toggleFromUser.
        if (event?.target && this._ownsGesture?.(event.target)) return;

        this._gestureSeen = true;
        this._startActivation();
    }

    // One presence transition for tab visibility, window focus and the
    // background setting. Hidden (or blurred with "Signals only") pauses a
    // playing village in place and routes urgent cues through the wake;
    // returning resumes it. Blurred with "Keep playing" is the quiet mix.
    _syncPresence() {
        if (this._destroyed) return;
        this._syncQuietMix();
        const inactive = this._pageInactive();
        if (inactive === this._inactive) return;
        this._inactive = inactive;
        const visibilityGeneration = ++this._visibilityGeneration;
        if (inactive) {
            this.directors.ambient.setHidden(true);
            if (DIRECTOR_IDS.some((id) => this.directors[id].running)) this._pause(visibilityGeneration);
            else this._deactivate({ forceSuspend: true, visibilityGeneration });
            return;
        }
        this.directors.ambient.setHidden(false);
        if (this.enabled && this.userActivated) this._startActivation();
        else this.directors.ambient.setSignalRouting(true);
        this._publishView();
    }

    // Pause in place: every running director stops its scheduling and closes
    // its groups (80 ms); once they are silent the context suspends, which
    // freezes the audio clock with the committed notes still on it.
    _pause(visibilityGeneration) {
        this._activationGeneration++;
        // Pending routine cues describe a moment the listener has left.
        this.cues.governor.clearRoutine();
        let silentAt = this.engine.now();
        for (const id of DIRECTOR_IDS) {
            const director = this.directors[id];
            if (director.running) silentAt = Math.max(silentAt, director.pause());
        }
        this._paused ??= {
            at: Date.now(),
            family: phaseFamily(this.directors.ambient.currentPhase()),
        };
        this._syncSignalRouting();
        clearTimeout(this._suspendTimer);
        const waitMs = Math.max(0, (silentAt - this.engine.now()) * 1000) + PAUSE_SUSPEND_MARGIN_MS;
        this._suspendTimer = setTimeout(() => {
            this._suspendTimer = null;
            if (this._destroyed || visibilityGeneration !== this._visibilityGeneration) return;
            if (this._pageInactive()) void this.engine.suspend();
        }, waitMs);
        this._publishView();
    }

    _resumable(away) {
        return Date.now() - away.at <= RESUME_RESTART_MS
            && phaseFamily(this.directors.ambient.currentPhase()) === away.family;
    }

    _handleWindowBlur() {
        if (this._destroyed || this._windowBlurred) return;
        this._windowBlurred = true;
        // Re-read on every blur so a change made in another tab applies.
        this.background = readSoundBackground();
        this._syncPresence();
    }

    _handleWindowFocus() {
        if (this._destroyed || !this._windowBlurred) return;
        this._windowBlurred = false;
        this._syncPresence();
    }

    _pageInactive() {
        return (typeof document !== 'undefined' && document.hidden)
            || (this._windowBlurred && this.background === 'signals');
    }

    _syncSignalRouting() {
        const hidden = this._pageInactive();
        const bgmOwnsSignals = this.enabled && !hidden
            && directorFor(this._playingMode) === 'bgm' && this.directors.bgm.running;
        this.directors.ambient.setSignalRouting(!bgmOwnsSignals);
    }

    // An urgent cue while the village is away: wake the cue path at full
    // level (the bed and music stay closed), play the cue, hold until it has
    // rung out, then suspend. Without sound it is still captioned.
    _handleHiddenSummons(payload) {
        if (this._destroyed) return;
        const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
        const pendingKey = agentId ?? '__anonymous__';
        if (this._hiddenSummonsPending.has(pendingKey)) return;
        this._hiddenSummonsPending.add(pendingKey);

        const generation = this._visibilityGeneration;
        const finish = () => this._hiddenSummonsPending.delete(pendingKey);
        if (!this.enabled || !this.available || !this.userActivated) {
            this._playHiddenUrgent(payload);
            finish();
            return;
        }

        // The wake owns suspension from here.
        if (this._suspendTimer) {
            clearTimeout(this._suspendTimer);
            this._suspendTimer = null;
        }

        void (async () => {
            let woke = false;
            try {
                woke = await this.engine.wake();
            } catch {
                woke = false;
            }
            if (this._destroyed) {
                finish();
                return;
            }
            // If the user returned while resume was in flight, the cue still
            // plays through whichever path now owns the audio, for its caption.
            const kind = this._urgentKind(payload);
            this._playHiddenUrgent(payload);
            finish();
            if (!woke || generation !== this._visibilityGeneration) return;

            this._wakeCount++;
            this._wakeHoldUntil = Math.max(this._wakeHoldUntil, this._urgentReleaseTime(kind, agentId));
            const token = ++this._wakeToken;
            // Let every wake that resumed in the same turn play first, so the
            // release is scheduled once, after the latest note.
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (this._destroyed || token !== this._wakeToken) return;
            const owns = await this.engine.endWake(this._wakeHoldUntil);
            if (
                !owns
                || this._destroyed
                || token !== this._wakeToken
                || generation !== this._visibilityGeneration
                || !this._pageInactive()
            ) return;
            this._wakeHoldUntil = 0;
            await this.engine.suspend();
        })();
    }

    _urgentKind(payload) {
        return payload?.audioCueKind || 'summons';
    }

    _playHiddenUrgent(payload) {
        return this.directors.ambient.cue(this._urgentKind(payload), payload);
    }

    // Audio time at which the wake may start closing: the cue's last
    // published note (CueScore, heard time) plus the urgent tail and margin.
    _urgentReleaseTime(kind, agentId) {
        const now = this.engine.now();
        const count = cueNoteCount(kind, agentId);
        const lastMs = count > 0 ? cueNoteTime(kind, agentId, count - 1) : null;
        const lastNote = Number.isFinite(lastMs)
            ? now + Math.max(0, (lastMs - performance.now()) / 1000)
            : now + UNSCORED_LAST_NOTE_SEC;
        return lastNote + URGENT_TAIL_SEC + WAKE_RELEASE_MARGIN_SEC;
    }

    // ─── The urgency ladder (plan 3.3) ────────────────────────────────────

    _presence() {
        const doc = typeof document !== 'undefined' ? document : null;
        return {
            visible: doc ? !doc.hidden : false,
            focused: typeof doc?.hasFocus === 'function' ? doc.hasFocus() : !this._windowBlurred,
            lastInputAt: this._lastInputAt,
        };
    }

    _operatorLooking(idleMs) {
        return isOperatorLooking(this._presence(), Date.now(), idleMs);
    }

    // A wait begins with its entry cue; that cue's bed-aware trim is held
    // for every reminder of the wait (S2), so L2 stays under L1 however the
    // bed swells. Without a heard entry the first reminder's trim is held.
    _openLadderWait() {
        if (this._destroyed || this._ladderWait) return;
        this._ladderWait = { heldTrimDb: null, openedAt: this.engine.now() };
        this._captureEntryTrim();
    }

    // The entry call is taken whenever its director places it: in Village
    // before this controller hears `attention:raised`, in the Town band
    // after (BgmDirector subscribes later), so the capture is retried once
    // the event has reached every subscriber and on the next ladder ticks,
    // until a trim is held. Only an entry voice scheduled within
    // ENTRY_TRIM_WINDOW_SEC of the opening counts.
    _captureEntryTrim() {
        const wait = this._ladderWait;
        if (!wait || wait.heldTrimDb != null) return;
        const level = this.cues.kit.lastLevel;
        if (level
            && ENTRY_CUE_KINDS.has(level.kind)
            && Number.isFinite(level.trimDb)
            && Math.abs(level.at - wait.openedAt) <= ENTRY_TRIM_WINDOW_SEC) {
            wait.heldTrimDb = level.trimDb;
        }
    }

    _closeLadderWait() {
        this._ladderWait = null;
        this._ladderHistory = [];
        this._acks.clear();
    }

    // The ladder, once a second, sound or no sound: never from stale data,
    // never while the feed is lost (SIG-9), never for a wait nobody is in.
    _ladderTick() {
        if (this._destroyed) return;
        const now = Date.now();
        if (this.directors.ambient.linkLost) return;
        const agents = audibleAgents(this.world, now);
        const ladder = nextReminder(now, agents, this._acks, {
            reminders: readReminderSetting(),
            presence: this._presence(),
        }, this._ladderHistory);
        this._ladder = ladder;
        if (!ladder.count) {
            if (this._ladderWait) this._closeLadderWait();
            return;
        }
        this._openLadderWait();
        this._captureEntryTrim();
        const present = new Set(agents.map(agent => agent.id));
        for (const agentId of this._acks.keys()) if (!present.has(agentId)) this._acks.delete(agentId);
        this._ladderHistory = this._ladderHistory.filter((entry, index, all) => (
            index === all.length - 1 || now - entry.at < REMINDER_CAPS.windowMs
        ));
        if (ladder.level > 0 && ladder.due <= now) this._playReminder(ladder, agents, now);
    }

    // The director that owns the signal route plays it (a hidden page hands
    // it to the wake). A reminder refused inside an urgent guard is spent,
    // not queued: it covers its step without counting toward the caps.
    _playReminder(ladder, agents, now) {
        const agent = agents.find(candidate => candidate.id === ladder.agentId);
        const reminder = {
            level: ladder.level,
            family: ladder.family,
            count: ladder.count,
            oldestMs: ladder.oldestMs,
            agentId: ladder.agentId,
            label: agent?.name || agent?.agentName || null,
            heldTrimDb: this._ladderWait?.heldTrimDb ?? null,
        };
        const played = Boolean(
            this.directors.ambient.playReminder?.(reminder)
            || this.directors.bgm.playReminder?.(reminder),
        );
        this._ladderHistory.push({ at: now, level: ladder.level, dropped: !played });
        const level = this.cues.kit.lastLevel;
        if (played && this._ladderWait?.heldTrimDb == null && level?.kind === 'reminder'
            && Number.isFinite(level.trimDb) && Math.abs(level.at - this.engine.now()) <= ENTRY_TRIM_WINDOW_SEC) {
            this._ladderWait.heldTrimDb = level.trimDb;
        }
    }

    // Whether a hidden page's urgent cue will be heard from the village
    // itself; desktop alerts go silent when it will (UX-13).
    _emitBellState() {
        const rings = Boolean(this.available && this.enabled && this.userActivated);
        if (rings === this._bellRings) return;
        this._bellRings = rings;
        eventBus.emit('audio:bell-state', { rings });
    }

    _armUnlockListeners() {
        if (!this.enabled || this.unlockArmed || !this.available || typeof document === 'undefined') return;
        document.addEventListener('pointerdown', this._onUnlockGesture, true);
        document.addEventListener('keydown', this._onUnlockGesture, true);
        this.unlockArmed = true;
    }

    _removeUnlockListeners() {
        if (!this.unlockArmed) return;
        document.removeEventListener('pointerdown', this._onUnlockGesture, true);
        document.removeEventListener('keydown', this._onUnlockGesture, true);
        this.unlockArmed = false;
    }

    // Once a second, sound or no sound: an expired hush or a quiet-hours
    // edge crossfades the village to its mode; the ladder ticks; the view
    // is re-read and emitted only when it changed.
    _signalTick() {
        if (this._destroyed) return;
        if (this.hushedUntil && !hushActive(this.hushedUntil, Date.now())) {
            this.hushedUntil = writeHushUntil(0);
            this._applyEffectiveMode();
        }
        this._syncQuietHours();
        this._ladderTick();
        this._publishView();
    }

    // ─── The one sound state (C-UX1, 7.3) ─────────────────────────────────

    // off | armed | playing | resting | hushed. Armed is on but not yet
    // heard: the browser is waiting for a click, or the page is away. The
    // chip never claims playing before the context runs.
    _soundState() {
        if (!this.available || !this.enabled) return 'off';
        if (!this.isRunning()) return 'armed';
        if (this.hushed) return 'hushed';
        const mode = this._playingMode ?? this._effectiveMode();
        if (mode === 'ambient' && this.directors.ambient.resting) return 'resting';
        return 'playing';
    }

    _nowLine(state) {
        if (state === 'off') return '';
        if (state === 'armed') return 'Waiting for a click — browsers start sound on your first click';
        if (state === 'hushed') {
            if (hushActive(this.hushedUntil, Date.now())) return `Hushed until ${clockTime(this.hushedUntil)}`;
            const ends = quietHoursEndsAt(this.quietHours, new Date());
            return ends ? `Quiet hours until ${clockHour(ends)}` : 'Listening for agents that need you';
        }
        if (state === 'resting') return 'Resting · sound returns when work starts';
        const mode = this._playingMode ?? this._effectiveMode();
        if (mode === 'signals') return 'Listening for agents that need you';
        if (mode === 'bgm') {
            const playing = this.directors.bgm.player?.nowPlaying ?? null;
            if (!playing?.piece) return 'Now · between tunes';
            const loop = playing.of > 1 ? `, loop ${playing.loop} of ${playing.of}` : '';
            return `Now · ${pieceTitle(playing.piece)}${loop}`;
        }
        const music = this.directors.ambient.musicStatus(Date.now());
        if (music.piece) return `Now · ${pieceTitle(music.piece)}`;
        if (music.held === 'rain') return 'Next · a tune after the rain';
        if (!Number.isFinite(music.nextAt)) return 'Now · the island and the village at work';
        const minutes = Math.ceil((music.nextAt - Date.now()) / 60000);
        return minutes <= 1 ? 'Next · a tune soon' : `Next · a tune in about ${minutes} min`;
    }

    _chipTitle(state) {
        if (!this.available) return 'Sound unavailable in this browser';
        const label = SOUND_PRESET_LABELS[this.lastPreset];
        switch (state) {
            case 'off': return `Sound off — click to turn on ${label}`;
            case 'armed': return 'Sound on — click anywhere to start it';
            case 'resting': return 'Sound on · Village is resting — nothing is working or waiting';
            case 'hushed': {
                if (hushActive(this.hushedUntil, Date.now())) return `Hushed until ${clockTime(this.hushedUntil)} — signals only`;
                const ends = quietHoursEndsAt(this.quietHours, new Date());
                return ends ? `Quiet hours until ${clockHour(ends)} — signals only` : 'Hushed — signals only';
            }
            default: return `Sound on · ${SOUND_PRESET_LABELS[presetForMode(this._playingMode ?? this.mode)]} — click to turn off`;
        }
    }

    /** Everything the chip, the popover and SET render. */
    soundView() {
        const soundState = this._soundState();
        const hushedUntil = this.enabled && hushActive(this.hushedUntil, Date.now()) ? this.hushedUntil : null;
        return {
            available: this.available,
            preset: this.preset,
            lastPreset: this.lastPreset,
            soundState,
            volumeStep: this.volumeStep,
            trims: { ...this.layerSteps },
            nowLine: this._nowLine(soundState),
            chipTitle: this._chipTitle(soundState),
            hushedUntil,
            quietHours: this.quietHours,
            quietActive: this.enabled && this._quietActive && hushedUntil === null,
            background: this.background,
            output: this.output,
            tone: this.tone,
            soften: this.soften,
            recalibrated: this._recalibrated,
        };
    }

    // `audio:sound-state` carries the view, on change only.
    _publishView() {
        if (this._destroyed) return;
        const view = this.soundView();
        const key = JSON.stringify(view);
        if (key === this._viewKey) return;
        this._viewKey = key;
        this._view = view;
        eventBus.emit('audio:sound-state', view);
    }

    _hasAudioSupport() {
        return typeof window !== 'undefined' && Boolean(window.AudioContext || window.webkitAudioContext);
    }

    // Loudness meters exist only while enabled (0.8a): `{ enable: true }`
    // builds them once a context exists and resolves to the first reading,
    // `{ enable: false }` tears them down, and a bare call reads them.
    _meters({ enable } = {}) {
        if (enable === false) {
            this.engine.disableMeters();
            return null;
        }
        if (enable === true) return this.engine.enableMeters().then(() => this.engine.readMeters());
        return this.engine.readMeters();
    }

    // Debug/QA surface: state readout plus handles to choose presets, force
    // layer levels, fire cues, and set volume from the console or a headless
    // browser.
    _debugSnapshot() {
        const view = this.soundView();
        return {
            enabled: this.enabled,
            available: this.available,
            contextState: this.engine.context?.state || null,
            running: this.director.running,
            volumeStep: this.volumeStep,
            layerSteps: { ...this.layerSteps },
            rms: this.engine.rms(),
            ...this.director.snapshot(),
            preset: view.preset,
            mode: this._effectiveMode(),
            storedMode: this.mode,
            soundState: view.soundState,
            nowLine: view.nowLine,
            chipTitle: view.chipTitle,
            hushedUntil: view.hushedUntil,
            quietHours: this.quietHours,
            quietActive: view.quietActive,
            output: this.output,
            tone: this.tone,
            soften: this.soften,
            softened: this.engine.softened ?? null,
            outputStage: this.engine.outputSnapshot?.() ?? null,
            awakening: { ...this._awakening },
            musicClock: this.engine.musicClock?.snapshot(this.engine.now()) ?? null,
            paused: this._paused !== null,
            transport: this.engine.transport?.diagnostics() ?? null,
            userActivated: this.userActivated,
            background: this.background,
            townBandVoice: readTownBandVoice(),
            blurred: this._windowBlurred,
            // D3 (5.6): the faders' quiet mix, `{ active, preset, factors }`.
            quietMix: { ...this._quietMix, factors: { ...this._quietMix.factors } },
            wakeCount: this._wakeCount,
            ladder: this._ladder ? {
                ...this._ladder,
                heldTrimDb: this._ladderWait?.heldTrimDb ?? null,
                fired: this._ladderHistory.map(entry => ({ ...entry })),
                acknowledged: [...this._acks.keys()],
            } : null,
            setPreset: (preset) => this.setPreset(preset, { fromUser: true }),
            toggle: () => this.toggleFromUser(),
            setVolumeStep: (step) => this.setVolumeStep(step),
            setLayerStep: (name, step) => this.setLayerStep(name, step),
            setBackground: (b) => this.setBackground(b),
            setOutput: (o) => this.setOutput(o),
            setTone: (t) => this.setTone(t),
            setSoften: (s) => this.setSoften(s),
            setQuietHours: (q) => this.setQuietHours(q),
            hush: (ms) => this.hush(ms),
            resumeFromHush: () => this.resumeFromHush(),
            testCall: (kind) => this.testCall(kind),
            playPreviewBell: () => this.playPreviewBell(),
            prewarm: () => this.prewarm(),
            // D2, the same path as SET's row: stored, then heard at the next chunk.
            setTownBandVoice: (voice) => {
                const stored = writeTownBandVoice(voice);
                eventBus.emit('sound:town-band-voice', { voice: stored });
                return stored;
            },
            setLayer: (name, level, holdMs) => this.director.forceLayer?.(name, level, holdMs) ?? false,
            cue: (kind) => this.director.cue(kind),
            meters: (opts) => this._meters(opts),
        };
    }

    destroy() {
        if (this._destroyPromise) return this._destroyPromise;
        this._destroyed = true;
        this._activationGeneration++;
        this._visibilityGeneration++;
        this._wakeToken++;
        this._removeUnlockListeners();
        this._stopDirectors();
        if (this._suspendTimer) {
            clearTimeout(this._suspendTimer);
            this._suspendTimer = null;
        }
        this._hiddenSummonsPending.clear();
        clearInterval(this._signalTimer);
        this._signalTimer = null;
        eventBus.off('attention:acknowledged', this._onAcknowledged);
        eventBus.off('attention:raised', this._onAttentionRaised);
        eventBus.off('sound:town-band-voice', this._onTownBandVoice);
        eventBus.off('audio:now-playing', this._onNowPlaying);
        this._closeLadderWait();
        for (const director of Object.values(this.directors)) director.destroy?.();
        // The controller owns the shared cue arbiter; directors never destroy it.
        this.cues.governor.destroy();

        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
            for (const type of PRESENCE_INPUT_EVENTS) {
                document.removeEventListener(type, this._onPresenceInput, { capture: true });
            }
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('blur', this._onWindowBlur);
            window.removeEventListener('focus', this._onWindowFocus);
        }

        if (typeof window !== 'undefined' && window.__claudevilleAudio === this._debugHelper) {
            delete window.__claudevilleAudio;
        }
        this._destroyPromise = Promise.resolve(this.engine.dispose());
        return this._destroyPromise;
    }
}
