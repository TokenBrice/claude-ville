// Facade between the top-bar sound controls and the audio system. Owns the
// opt-in lifecycle — off by default, user-gesture unlock, tab-hidden suspend,
// localStorage persistence — and delegates all sound to AudioEngine (mix
// chain) and AudioDirector (world-reactive layers and cues) in ./audio/.

import { AudioEngine, clamp01 } from './audio/AudioEngine.js';
import { AudioDirector } from './audio/AudioDirector.js';

const STORAGE_KEY = 'claudeville.sound.enabled';
const VOLUME_KEY = 'claudeville.sound.volume';
const DEFAULT_VOLUME = 0.5;

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

function readStoredVolume() {
    try {
        const raw = window.localStorage?.getItem(VOLUME_KEY);
        if (raw == null) return DEFAULT_VOLUME;
        return clamp01(Number(raw), DEFAULT_VOLUME);
    } catch {
        return DEFAULT_VOLUME;
    }
}

function writeStoredVolume(volume) {
    try {
        window.localStorage?.setItem(VOLUME_KEY, String(volume));
    } catch {
        // Preference persistence is optional.
    }
}

export class AmbientAudioController {
    constructor({ button, volumeSlider, world } = {}) {
        this.button = button || null;
        this.volumeSlider = volumeSlider || null;
        this.world = world || null;
        this.available = this._hasAudioSupport();
        this.enabled = readStoredPreference();
        this.volume = readStoredVolume();
        this.userActivated = false;
        this.unlockArmed = false;

        this.engine = new AudioEngine();
        this.engine.setVolume(this.volume);
        this.director = new AudioDirector({ engine: this.engine, world: this.world });

        this._onButtonClick = () => this._handleToggle();
        this._onUnlockGesture = (event) => this._handleUnlockGesture(event);
        this._onVisibility = () => this._handleVisibility();
        this._onVolumeInput = (event) => {
            this.setVolume(Number(event?.target?.value) / 100);
        };

        if (this.button) this.button.addEventListener('click', this._onButtonClick);
        if (this.volumeSlider) this.volumeSlider.addEventListener('input', this._onVolumeInput);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }

        this._renderControls();
        if (this.enabled) this._armUnlockListeners();

        if (typeof window !== 'undefined') {
            window.__claudevilleAudio = () => this._debugSnapshot();
        }
    }

    _handleToggle() {
        this.userActivated = true;
        this.setEnabled(!this.enabled);
    }

    setEnabled(enabled) {
        if (!this.available) return;

        this.enabled = Boolean(enabled);
        writeStoredPreference(this.enabled);
        this._renderControls();
        this._removeUnlockListeners();

        if (this.enabled) void this._activate();
        else this._deactivate();
    }

    setVolume(value) {
        this.volume = clamp01(value, DEFAULT_VOLUME);
        writeStoredVolume(this.volume);
        this.engine.setVolume(this.volume);
        if (this.volumeSlider) this.volumeSlider.value = String(Math.round(this.volume * 100));
    }

    async _activate() {
        if (!this.enabled || !this.available) return;
        const ready = await this.engine.ensureContext();
        if (!ready || !this.enabled) return;

        this.engine.start();
        this.director.start();
    }

    _deactivate() {
        this.director.stop();
        this.engine.stop();
        setTimeout(() => {
            if (!this.enabled) void this.engine.suspend();
        }, 800);
    }

    _handleUnlockGesture(event) {
        if (!this.enabled || this.userActivated) return;
        if (this.button && event?.target && this.button.contains(event.target)) return;

        this.userActivated = true;
        this._removeUnlockListeners();
        void this._activate();
    }

    _handleVisibility() {
        if (typeof document === 'undefined') return;
        if (document.hidden) {
            if (this.enabled) this._deactivate();
        } else if (this.enabled && this.userActivated) {
            void this._activate();
        }
    }

    _armUnlockListeners() {
        if (!this.enabled || this.userActivated || this.unlockArmed || !this.available) return;
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

    _renderControls() {
        if (this.button) {
            this.button.disabled = !this.available;
            this.button.textContent = this.available
                ? (this.enabled ? 'SOUND ON' : 'SOUND OFF')
                : 'SOUND N/A';
            this.button.title = this.available
                ? (this.enabled ? 'Disable sound' : 'Enable sound')
                : 'Sound unavailable';
            this.button.setAttribute('aria-pressed', this.enabled && this.available ? 'true' : 'false');
            this.button.classList.toggle('topbar__sound-btn--on', this.enabled && this.available);
        }
        if (this.volumeSlider) {
            this.volumeSlider.hidden = !(this.enabled && this.available);
            this.volumeSlider.value = String(Math.round(this.volume * 100));
        }
    }

    _hasAudioSupport() {
        return Boolean(window.AudioContext || window.webkitAudioContext);
    }

    // Debug/QA surface: state readout plus handles to force layer levels,
    // fire cues, and set volume from the console or a headless browser.
    _debugSnapshot() {
        return {
            enabled: this.enabled,
            userActivated: this.userActivated,
            available: this.available,
            contextState: this.engine.context?.state || null,
            running: this.director.running,
            volume: this.volume,
            rms: this.engine.rms(),
            mode: 'reactive-ambient',
            ...this.director.snapshot(),
            setVolume: (v) => this.setVolume(v),
            setLayer: (name, level, holdMs) => this.director.forceLayer(name, level, holdMs),
            cue: (kind) => this.director.cue(kind),
        };
    }

    destroy() {
        this._removeUnlockListeners();
        this.director.stop();

        if (this.button) this.button.removeEventListener('click', this._onButtonClick);
        if (this.volumeSlider) this.volumeSlider.removeEventListener('input', this._onVolumeInput);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }

        void this.engine.dispose();
        if (typeof window !== 'undefined') delete window.__claudevilleAudio;
    }
}
