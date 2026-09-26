// Facade between the top-bar sound controls and the audio system. Owns the
// opt-in lifecycle — off by default, user-gesture unlock, background policy,
// pause in place while away, hidden-tab wakes, localStorage persistence
// (through SoundSettings) — and delegates all sound to AudioEngine (mix
// chain, group faders, per-director crossfade gains, the Transport) and the
// two directors in ./audio/, which share the one cue arbiter this controller
// creates per engine. TopBar builds it at boot idle without an AudioContext,
// so the signal route and captions exist before any click. The signal route
// also carries the urgency ladder (plan 3.3): a 1 Hz timer, alive from boot
// whether or not sound is on, reminds an unanswered wait — as a caption with
// sound off, through the wake on a hidden page.

import { AudioEngine } from './audio/AudioEngine.js';
import { AudioDirector } from './audio/AudioDirector.js';
import {
    BgmDirector,
    workingSectionCounts,
    workingSectionLabel,
} from './audio/BgmDirector.js';
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
    SOUND_RECALIBRATED_MESSAGE,
    SOUND_STEP_MAX,
    readStoredTrimSteps,
    readReminderSetting,
    readStoredVolumeStep,
    readTownBandVoice,
    recalibrateStoredSound,
    soundStep,
    writeStoredTrimSteps,
    writeStoredVolumeStep,
    writeTownBandVoice,
} from './SoundSettings.js';
import { eventBus } from '../../domain/events/DomainEvent.js';

const STORAGE_KEY = 'claudeville.sound.enabled';
const MODE_KEY = 'claudeville.sound.mode';
const BACKGROUND_KEY = 'claudeville.sound.background';
const MODES = ['ambient', 'bgm'];
// AMBIENT ↔ BGM is a walk from the square into the tavern (1.6, ENG-15): both
// directors play through an equal-power crossfade of their director gains,
// and the outgoing one stops only once its gain has reached zero.
const MODE_CROSSFADE_SEC = 2.5;
const CROSSFADE_STOP_MARGIN_MS = 50;
// What a visible but unfocused window plays (D3): the quiet mix below, or
// the hidden-tab signals-only route.
const BACKGROUNDS = ['play', 'signals'];
// D3's quiet mix (5.6): with "Keep playing", a blurred window's mixer faders
// take these factors on top of their trims, per preset. The Village drops
// its music and halves its world and work (the workshops keep their accents
// only; AudioDirector.setQuietMix); the Town band plays on at −3 dB. The cue
// bus and the held note (signalBed) have no fader here, and the engine's bed
// compensation (BLUR_BED_DB below) keeps their bed-aware levels: signals are
// unchanged.
export const BLUR_MIX = Object.freeze({
    ambient: Object.freeze({ wind: 0.5, rain: 0.5, wildlife: 0.5, hum: 0.5, workshops: 0.5, music: 0 }),
    bgm: Object.freeze({ music: 10 ** (-3 / 20) }),
});
// The bed each quiet mix leaves, in dB under the full one: the Village's
// world and work at half, the Town band at −3 dB. The engine adds it back to
// its bed reading, so cue trims and the held note level against the full bed.
const BLUR_BED_DB = Object.freeze({ ambient: 20 * Math.log10(2), bgm: 3 });
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

// Agent updates arrive in bursts; one coalesced read per burst keeps the label
// within a beat of the world, and it is written only when its counts actually
// change, so a busy poll never touches the DOM.
const SECTION_LABEL_COALESCE_MS = 150;
const SOUND_CHIP_TITLES = Object.freeze({
    off: 'Enable sound',
    armed: 'Sound on — click anywhere to start it',
    playing: 'Disable sound',
});

function readStoredPreference() {
    try {
        return window.localStorage?.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function writeStoredPreference(enabled) {
    try {
        window.localStorage?.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // Preference persistence is optional.
    }
}

function readStoredMode() {
    try {
        const raw = window.localStorage?.getItem(MODE_KEY);
        return MODES.includes(raw) ? raw : 'ambient';
    } catch {
        return 'ambient';
    }
}

function writeStoredMode(mode) {
    try {
        window.localStorage?.setItem(MODE_KEY, mode);
    } catch {
        // Preference persistence is optional.
    }
}

function readStoredBackground() {
    try {
        return window.localStorage?.getItem(BACKGROUND_KEY) === 'signals' ? 'signals' : 'play';
    } catch {
        return 'play';
    }
}

function writeStoredBackground(background) {
    try {
        window.localStorage?.setItem(BACKGROUND_KEY, background);
    } catch {
        // Preference persistence is optional.
    }
}

export class AmbientAudioController {
    constructor({
        button,
        volumeSlider,
        modeButton,
        mixerButton,
        mixerPanel,
        layerControls,
        world,
    } = {}) {
        this.button = button || null;
        this.volumeSlider = volumeSlider || null;
        this.modeButton = modeButton || null;
        this.mixerButton = mixerButton || null;
        this.mixerPanel = mixerPanel || null;
        this.layerControls = layerControls || {};
        this.world = world || null;
        this.available = this._hasAudioSupport();
        this.enabled = readStoredPreference();
        // D5 (1.2): a profile from before the calibrated master is reset once
        // to the standard level; the caption follows once the route exists.
        const recalibrated = recalibrateStoredSound();
        this.volumeStep = readStoredVolumeStep();
        this.mode = readStoredMode();
        this.background = readStoredBackground();
        this.layerSteps = readStoredTrimSteps();
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
        this._layerInputHandlers = new Map();
        // Mode crossfades: the outgoing director's stop, per director id,
        // pending until its gain has faded to zero.
        this._crossfadeStops = new Map();
        this._destroyPromise = null;
        this._destroyed = false;
        this._windowBlurred = false;
        // D3 (5.6): the quiet mix a blurred "Keep playing" window hears.
        this._quietMix = { active: false, preset: null, factors: {} };
        // The urgency ladder's inputs: acknowledgements (agentId → ms), the
        // reminders spent this wait, the wait's held cue trim, presence.
        this._acks = new Map();
        this._ladderHistory = [];
        this._ladderWait = null;
        this._ladder = null;
        this._lastInputAt = 0;
        this._bellRings = null;
        // The working-section label lives beside the music control; the topbar
        // markup owns the element, this controller owns its counts.
        this.sectionLabel = typeof document !== 'undefined'
            ? document.getElementById('topbarSoundSection')
            : null;
        this._sectionLabelText = '';
        this._sectionLabelTimer = null;

        this.engine = new AudioEngine();
        this.engine.setVolumeStep(this.volumeStep);
        this._applyGroupLevels();
        // One cue arbiter per engine (1.6): both directors submit through the
        // same governor and kit, so a mode switch never resets a cooldown and
        // an agent summoned just before a switch is not summoned again after
        // it. The controller owns their lifetime; directors never build or
        // destroy them.
        const governor = new CueGovernor();
        this.cues = { kit: new CueKit(this.engine, governor), governor };
        this.directors = {
            ambient: new AudioDirector({ engine: this.engine, world: this.world, cues: this.cues }),
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

        this._onButtonClick = () => this.activateFromUser(!this.enabled);
        this._onModeClick = () => this.setMode(this.mode === 'ambient' ? 'bgm' : 'ambient');
        this._onUnlockGesture = (event) => this._handleUnlockGesture(event);
        this._onVisibility = () => this._syncPresence();
        this._onWindowBlur = () => this._handleWindowBlur();
        this._onWindowFocus = () => this._handleWindowFocus();
        this._onVolumeInput = (event) => {
            this.setVolumeStep(Number(event?.target?.value));
        };

        if (this.button) this.button.addEventListener('click', this._onButtonClick);
        if (this.modeButton) this.modeButton.addEventListener('click', this._onModeClick);
        if (this.volumeSlider) this.volumeSlider.addEventListener('input', this._onVolumeInput);
        for (const [name, control] of Object.entries(this.layerControls)) {
            if (!Object.hasOwn(AUDIO_MIXER_DEFAULTS, name) || !control?.slider) continue;
            const handler = (event) => this.setLayerStep(name, Number(event?.target?.value));
            this._layerInputHandlers.set(name, handler);
            control.slider.addEventListener('input', handler);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('blur', this._onWindowBlur);
            window.addEventListener('focus', this._onWindowFocus);
        }
        this._onWorldCountsChanged = () => this._scheduleSectionLabel();
        for (const event of ['agent:added', 'agent:updated', 'agent:removed']) {
            eventBus.on(event, this._onWorldCountsChanged);
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
        // Subscribed after the directors, so the entry cue has been placed.
        this._onAttentionRaised = () => this._openLadderWait();
        eventBus.on('attention:raised', this._onAttentionRaised);
        // D2: SET's Town band voice lands at the band's next chunk.
        this._onTownBandVoice = () => this.directors.bgm?.setVoice?.(readTownBandVoice());
        eventBus.on('sound:town-band-voice', this._onTownBandVoice);
        this._signalTimer = setInterval(() => this._signalTick(), SIGNAL_TICK_MS);

        this._renderControls();
        if (this.enabled) {
            this._armUnlockListeners();
            // A returning user who already clicked before the idle build
            // (sticky activation) starts the village without a second click.
            if (this.userActivated) void this._activate();
        }

        if (typeof window !== 'undefined') {
            this._debugHelper = () => this._debugSnapshot();
            window.__claudevilleAudio = this._debugHelper;
        }
        if (recalibrated) eventBus.emit('audio:recalibrated', { message: SOUND_RECALIBRATED_MESSAGE });
    }

    // Chrome's sticky activation makes `context.resume()` legal after any
    // earlier gesture on the page, not only one this controller observed.
    get userActivated() {
        return this._gestureSeen
            || globalThis.navigator?.userActivation?.hasBeenActive === true;
    }

    // Every enable path — the chip, the deferred first click, the SET switch —
    // is a user activation. A control that is on but not yet playing (armed)
    // starts the village when clicked; only a playing control turns sound off.
    activateFromUser(on) {
        if (!this.available || this._destroyed) return;
        this._gestureSeen = true;
        this.setEnabled(Boolean(on) || (this.enabled && !this.isRunning()));
    }

    setEnabled(enabled) {
        if (!this.available || this._destroyed) return;

        this.enabled = Boolean(enabled);
        writeStoredPreference(this.enabled);
        this._renderControls();

        if (this.enabled) {
            this._armUnlockListeners();
            void this._activate();
        } else {
            this._removeUnlockListeners();
            this._deactivate();
        }
    }

    // Playing, as the listener would hear it: the context runs and the active
    // director is running and not paused. Anything less is armed or off.
    isRunning() {
        return this.engine.context?.state === 'running'
            && this.director.running === true
            && !this.director.paused;
    }

    // Master volume as a whole step 0–10 (1.2): the engine applies the step
    // law after the ceiling.
    setVolumeStep(step) {
        if (this._destroyed) return this.volumeStep;
        this.volumeStep = soundStep(step, this.volumeStep);
        writeStoredVolumeStep(this.volumeStep);
        this.engine.setVolumeStep(this.volumeStep);
        this._renderVolumeSlider();
        return this.volumeStep;
    }

    // A mixer trim as a whole step 0–10: 2.4 dB per step, 10 = unity.
    setLayerStep(name, step) {
        if (this._destroyed || !Object.hasOwn(AUDIO_MIXER_DEFAULTS, name)) return false;
        this.layerSteps[name] = soundStep(step, this.layerSteps[name]);
        writeStoredTrimSteps(this.layerSteps);
        this._renderLayerControl(name);
        this._applyGroupLevel(name);
        return true;
    }

    setBackground(background) {
        if (this._destroyed || !BACKGROUNDS.includes(background)) return this.background;
        this.background = background;
        writeStoredBackground(background);
        this._syncPresence();
        return this.background;
    }

    get director() {
        return this.directors[this.mode] || this.directors.ambient;
    }

    // Switch between the reactive ambience and continuous town BGM. A playing
    // village crossfades into the other director; otherwise only the stored
    // mode changes and the ambient director stays the signal route.
    setMode(mode) {
        if (this._destroyed || !MODES.includes(mode) || mode === this.mode) return;
        const outgoingMode = this.mode;
        const outgoing = this.director;
        this.mode = mode;
        writeStoredMode(mode);
        if (outgoing.running && !this._pageInactive()) {
            this._crossfade(outgoingMode, mode);
        } else {
            if (outgoing.running) this._stopDirector(outgoingMode);
            // With no active BGM director, the ambient director is the
            // signal-only route for captions and disabled-sound cues.
            this.directors.ambient.setSignalRouting(true);
        }
        this._syncQuietMix();
        this._renderControls();
    }

    // Equal-power crossfade of the two director gains (engine.fadeDirector).
    // The incoming director starts silent unless it is still fading out from
    // a switch moments ago, in which case it turns around from where it is.
    _crossfade(outgoingMode, incomingMode) {
        const incoming = this.directors[incomingMode];
        this._cancelCrossfadeStop(incomingMode);
        if (!incoming.running) {
            this.engine.fadeDirector(incomingMode, 0, { duration: 0 });
            this.directors.ambient.setSignalRouting(incomingMode !== 'bgm');
            incoming.start();
        }
        this.engine.fadeDirector(incomingMode, 1, { duration: MODE_CROSSFADE_SEC });
        const end = this.engine.fadeDirector(outgoingMode, 0, { duration: MODE_CROSSFADE_SEC });
        const fadeEnd = Number.isFinite(end) ? end : this.engine.now() + MODE_CROSSFADE_SEC;
        const delayMs = Math.max(0, (fadeEnd - this.engine.now()) * 1000) + CROSSFADE_STOP_MARGIN_MS;
        // The timer only wakes the stop; the fade itself lives on the audio
        // clock, and the director's own stop ramp declicks what is left.
        this._crossfadeStops.set(outgoingMode, setTimeout(() => {
            this._crossfadeStops.delete(outgoingMode);
            if (this._destroyed || this.mode === outgoingMode) return;
            this.directors[outgoingMode].stop();
            this._syncSignalRouting();
        }, delayMs));
        this._syncSignalRouting();
    }

    _cancelCrossfadeStop(mode) {
        const timer = this._crossfadeStops.get(mode);
        if (timer == null) return;
        clearTimeout(timer);
        this._crossfadeStops.delete(mode);
    }

    _stopDirector(mode) {
        this._cancelCrossfadeStop(mode);
        this.directors[mode].stop();
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
    // hears the quiet mix of the current preset; focus restores the trims
    // at the faders' 50 ms glide. "Signals only" pauses instead (hidden).
    _syncQuietMix() {
        const active = this._windowBlurred
            && this.background === 'play'
            && !(typeof document !== 'undefined' && document.hidden);
        const preset = active ? this.mode : null;
        if (active === this._quietMix.active && preset === this._quietMix.preset) return;
        this._quietMix = { active, preset, factors: active ? (BLUR_MIX[preset] ?? {}) : {} };
        this._applyGroupLevels();
        this.engine.setBedCompensation(active ? (BLUR_BED_DB[preset] ?? 0) : 0);
        this.directors.ambient.setQuietMix(active && preset === 'ambient');
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
        this.directors.ambient.setSignalRouting(this.mode !== 'bgm');
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
        // Back from an absence: continue the piece where it stopped, unless
        // the absence was long or crossed day ↔ night, which rebuilds.
        const away = this._paused;
        this._paused = null;
        if (away && !this._resumable(away)) {
            for (const mode of MODES) this._stopDirector(mode);
        }
        for (const director of Object.values(this.directors)) {
            if (director.paused) director.resume();
        }
        // A crossfade interrupted by a disable, or a rebuild, may have left
        // this director's gain part-way; a fresh start plays at full level.
        if (!this.director.running) this.engine.fadeDirector(this.mode, 1, { duration: 0 });
        this.director.start();
        this._syncSignalRouting();
        this._removeUnlockListeners();
        this._renderControls();
    }

    _deactivate({ forceSuspend = false, visibilityGeneration = this._visibilityGeneration } = {}) {
        this._activationGeneration++;
        this._paused = null;
        for (const mode of MODES) this._stopDirector(mode);
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
        this._renderControls();
    }

    _handleUnlockGesture(event) {
        if (!this.enabled || this.isRunning()) return;
        // The chip's own click decides through activateFromUser.
        if (this.button && event?.target && this.button.contains(event.target)) return;

        this._gestureSeen = true;
        void this._activate();
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
            if (MODES.some((mode) => this.directors[mode].running)) this._pause(visibilityGeneration);
            else this._deactivate({ forceSuspend: true, visibilityGeneration });
            return;
        }
        this.directors.ambient.setHidden(false);
        if (this.enabled && this.userActivated) void this._activate();
        else this.directors.ambient.setSignalRouting(true);
    }

    // Pause in place: every running director stops its scheduling and closes
    // its groups (80 ms); once they are silent the context suspends, which
    // freezes the audio clock with the committed notes still on it.
    _pause(visibilityGeneration) {
        this._activationGeneration++;
        // Pending routine cues describe a moment the listener has left.
        this.cues.governor.clearRoutine();
        let silentAt = this.engine.now();
        for (const mode of MODES) {
            const director = this.directors[mode];
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
        this._renderControls();
    }

    _resumable(away) {
        return Date.now() - away.at <= RESUME_RESTART_MS
            && phaseFamily(this.directors.ambient.currentPhase()) === away.family;
    }

    _handleWindowBlur() {
        if (this._destroyed || this._windowBlurred) return;
        this._windowBlurred = true;
        // Re-read on every blur so a change made in another tab applies.
        this.background = readStoredBackground();
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
        const bgmOwnsSignals = this.enabled && !hidden && this.mode === 'bgm' && this.directors.bgm.running;
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
        const level = this.cues.kit.lastLevel;
        const heard = level
            && ENTRY_CUE_KINDS.has(level.kind)
            && Number.isFinite(level.trimDb)
            && Math.abs(level.at - this.engine.now()) <= ENTRY_TRIM_WINDOW_SEC;
        this._ladderWait = { heldTrimDb: heard ? level.trimDb : null };
    }

    _closeLadderWait() {
        this._ladderWait = null;
        this._ladderHistory = [];
        this._acks.clear();
    }

    // Once a second, sound or no sound: never from stale data, never while
    // the feed is lost (SIG-9), never for a wait nobody is in.
    _signalTick() {
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

    // off | armed | playing. Armed is on but not yet heard: the browser is
    // waiting for a click, or the page is away. The chip never claims playing
    // before the context runs.
    _soundState() {
        if (!this.available || !this.enabled) return 'off';
        return this.isRunning() ? 'playing' : 'armed';
    }

    _renderControls() {
        if (this.button) {
            const state = this._soundState();
            this.button.disabled = !this.available;
            this.button.title = this.available ? SOUND_CHIP_TITLES[state] : 'Sound unavailable';
            this.button.setAttribute('data-sound-state', state);
            this.button.setAttribute('aria-pressed', this.enabled && this.available ? 'true' : 'false');
            this.button.classList.toggle('topbar__sound-btn--on', state === 'playing');
        }
        this._renderVolumeSlider();
        if (this.modeButton) {
            this.modeButton.hidden = !(this.enabled && this.available);
            const bgm = this.mode === 'bgm';
            this.modeButton.textContent = bgm ? 'BGM' : 'AMBIENT';
            this.modeButton.title = bgm
                ? 'Town music mode — click for reactive ambience'
                : 'Reactive ambience mode — click for continuous town music';
            this.modeButton.setAttribute('aria-pressed', bgm ? 'true' : 'false');
            this.modeButton.classList.toggle('topbar__sound-btn--on', bgm);
        }
        if (this.mixerButton) {
            const shown = this.enabled && this.available;
            this.mixerButton.hidden = !shown;
            this.mixerButton.disabled = !this.available;
            if (!shown && this.mixerPanel) {
                this.mixerPanel.style.display = 'none';
                this.mixerButton.setAttribute('aria-expanded', 'false');
                this.mixerButton.classList.remove('topbar__sound-btn--on');
            }
        }
        for (const name of Object.keys(AUDIO_MIXER_DEFAULTS)) this._renderLayerControl(name);
        this._renderSectionLabel();
        this._emitBellState();
    }

    _scheduleSectionLabel() {
        if (this._destroyed || this._sectionLabelTimer) return;
        this._sectionLabelTimer = setTimeout(() => {
            this._sectionLabelTimer = null;
            this._renderSectionLabel();
        }, SECTION_LABEL_COALESCE_MS);
    }

    // `Working 7 · Waiting 2` — the counts the arrangement follows, written
    // only when they change. The music is never the only place they appear.
    _renderSectionLabel() {
        const label = this.sectionLabel;
        if (!label) return;
        const shown = this.enabled && this.available;
        label.hidden = !shown;
        if (!shown) return;
        const counts = workingSectionCounts(this.world);
        const text = workingSectionLabel(counts);
        if (text === this._sectionLabelText) return;
        this._sectionLabelText = text;
        label.textContent = text;
        label.title = `${counts.working} working · ${counts.needsYou} waiting on you`
            + ` · ${counts.watchlist} waiting on work`;
    }

    // Steps read `n / 10` everywhere (1.2): the top-bar slider, the mixer and
    // SET share one scale. The slider's 0–10 range and label live in the
    // markup (index.html).
    _renderVolumeSlider() {
        const slider = this.volumeSlider;
        if (!slider) return;
        slider.hidden = !(this.enabled && this.available);
        slider.value = String(this.volumeStep);
        slider.setAttribute('aria-valuetext', `${this.volumeStep} / ${SOUND_STEP_MAX}`);
    }

    _renderLayerControl(name) {
        const control = this.layerControls[name];
        if (!control) return;
        const text = `${this.layerSteps[name]} / ${SOUND_STEP_MAX}`;
        if (control.slider) {
            control.slider.value = String(this.layerSteps[name]);
            control.slider.setAttribute('aria-valuetext', text);
        }
        if (control.value) control.value.textContent = text;
    }

    _hasAudioSupport() {
        return Boolean(window.AudioContext || window.webkitAudioContext);
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

    // Debug/QA surface: state readout plus handles to force layer levels,
    // fire cues, and set volume from the console or a headless browser.
    _debugSnapshot() {
        return {
            enabled: this.enabled,
            available: this.available,
            contextState: this.engine.context?.state || null,
            running: this.director.running,
            volumeStep: this.volumeStep,
            layerSteps: { ...this.layerSteps },
            rms: this.engine.rms(),
            mode: this.mode,
            sectionLabel: this._sectionLabelText,
            sectionCounts: workingSectionCounts(this.world),
            ...this.director.snapshot(),
            musicClock: this.engine.musicClock?.snapshot(this.engine.now()) ?? null,
            paused: this._paused !== null,
            transport: this.engine.transport?.diagnostics() ?? null,
            userActivated: this.userActivated,
            soundState: this._soundState(),
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
            setVolumeStep: (step) => this.setVolumeStep(step),
            setLayerStep: (name, step) => this.setLayerStep(name, step),
            setMode: (m) => this.setMode(m),
            setBackground: (b) => this.setBackground(b),
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
        for (const mode of MODES) this._stopDirector(mode);
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
        this._closeLadderWait();
        clearTimeout(this._sectionLabelTimer);
        this._sectionLabelTimer = null;
        for (const event of ['agent:added', 'agent:updated', 'agent:removed']) {
            eventBus.off(event, this._onWorldCountsChanged);
        }
        for (const director of Object.values(this.directors)) director.destroy?.();
        // The controller owns the shared cue arbiter; directors never destroy it.
        this.cues.governor.destroy();

        if (this.button) this.button.removeEventListener('click', this._onButtonClick);
        if (this.modeButton) this.modeButton.removeEventListener('click', this._onModeClick);
        if (this.volumeSlider) this.volumeSlider.removeEventListener('input', this._onVolumeInput);
        for (const [name, handler] of this._layerInputHandlers) {
            this.layerControls[name]?.slider?.removeEventListener('input', handler);
        }
        this._layerInputHandlers.clear();
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
