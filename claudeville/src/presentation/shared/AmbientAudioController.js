// Facade between the top-bar sound controls and the audio system. Owns the
// opt-in lifecycle — off by default, user-gesture unlock, background policy,
// hidden-tab wakes, localStorage persistence (through SoundSettings) — and
// delegates all sound to AudioEngine (mix chain, group faders, per-director
// crossfade gains) and the two directors in ./audio/, which share the one
// cue arbiter this controller creates per engine. TopBar builds it at boot
// idle without an AudioContext, so the signal route and captions exist
// before any click.

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
import {
    AUDIO_MIXER_DEFAULTS,
    SOUND_RECALIBRATED_MESSAGE,
    SOUND_STEP_MAX,
    readStoredTrimSteps,
    readStoredVolumeStep,
    recalibrateStoredSound,
    soundStep,
    writeStoredTrimSteps,
    writeStoredVolumeStep,
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
// What a visible but unfocused window plays (D3, Wave 0): the full mix, or
// the hidden-tab signals-only route.
const BACKGROUNDS = ['play', 'signals'];
// A hidden-tab wake holds until the urgent cue has rung out (S8): its last
// note, plus the longest urgent bell decay in CueKit (distress, 3 s), plus the
// 80 ms margin before the fade closes.
const URGENT_TAIL_SEC = 3;
const WAKE_RELEASE_MARGIN_SEC = 0.08;
// A cue with no published score (an anonymous agent the score cannot key)
// still gets the summons' two-note span.
const UNSCORED_LAST_NOTE_SEC = 0.4;
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
    // director is running. Anything less is armed or off.
    isRunning() {
        return this.engine.context?.state === 'running' && this.director.running === true;
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
        this.engine.setGroupLevel(name, trimStepGain(this.layerSteps[name]));
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
    _applyGroupLevels() {
        for (const [name, step] of Object.entries(this.layerSteps)) {
            this.engine.setGroupLevel(name, trimStepGain(step));
        }
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
        // A crossfade interrupted by a disable or a hidden tab may have left
        // this director's gain part-way; a fresh start plays at full level.
        if (!this.director.running) this.engine.fadeDirector(this.mode, 1, { duration: 0 });
        this.director.start();
        this._syncSignalRouting();
        this._removeUnlockListeners();
        this._renderControls();
    }

    _deactivate({ forceSuspend = false, visibilityGeneration = this._visibilityGeneration } = {}) {
        this._activationGeneration++;
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
    // background setting. Hidden (or blurred with "Signals only") stops the
    // village and routes urgent cues through the wake; returning rebuilds it.
    _syncPresence() {
        if (this._destroyed) return;
        const inactive = this._pageInactive();
        if (inactive === this._inactive) return;
        this._inactive = inactive;
        const visibilityGeneration = ++this._visibilityGeneration;
        if (inactive) {
            this.directors.ambient.setHidden(true);
            this._deactivate({ forceSuspend: true, visibilityGeneration });
            return;
        }
        this.directors.ambient.setHidden(false);
        if (this.enabled && this.userActivated) void this._activate();
        else this.directors.ambient.setSignalRouting(true);
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
            userActivated: this.userActivated,
            soundState: this._soundState(),
            background: this.background,
            blurred: this._windowBlurred,
            wakeCount: this._wakeCount,
            setVolumeStep: (step) => this.setVolumeStep(step),
            setLayerStep: (name, step) => this.setLayerStep(name, step),
            setMode: (m) => this.setMode(m),
            setBackground: (b) => this.setBackground(b),
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
