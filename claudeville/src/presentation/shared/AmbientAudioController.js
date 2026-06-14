import { eventBus } from '../../domain/events/DomainEvent.js';

const STORAGE_KEY = 'claudeville.sound.enabled';
const VILLAGE_OBSERVERS = Symbol.for('claudeville.audioVillageObservers');
const VILLAGE_ORIGINAL_EMIT = Symbol.for('claudeville.audioVillageOriginalEmit');
const VILLAGE_WRAPPED_EMIT = Symbol.for('claudeville.audioVillageWrappedEmit');

const EVENT_CUES = Object.freeze({
    'agent:added': 'agentAdded',
    'agent:updated': 'agentUpdated',
    'agent:removed': 'agentRemoved',
    'usage:updated': 'usageUpdated',
});

const CUE_COOLDOWNS = Object.freeze({
    agentAdded: 450,
    agentUpdated: 1600,
    agentRemoved: 650,
    usageUpdated: 2800,
    village: 900,
});

function observeVillageEvents(callback) {
    if (!eventBus[VILLAGE_OBSERVERS]) {
        eventBus[VILLAGE_OBSERVERS] = new Set();
        const originalEmit = eventBus.emit;
        eventBus[VILLAGE_ORIGINAL_EMIT] = originalEmit;

        const wrappedEmit = function(event, data) {
            originalEmit.call(this, event, data);
            if (typeof event !== 'string' || !event.startsWith('village:')) return;

            const observers = eventBus[VILLAGE_OBSERVERS] || [];
            for (const observer of observers) {
                try {
                    observer(event, data);
                } catch (error) {
                    const message = error?.message || String(error);
                    console.error(`[AmbientAudio] village event listener failed: ${message}`);
                }
            }
        };

        eventBus[VILLAGE_WRAPPED_EMIT] = wrappedEmit;
        eventBus.emit = wrappedEmit;
    }

    eventBus[VILLAGE_OBSERVERS].add(callback);

    return () => {
        const observers = eventBus[VILLAGE_OBSERVERS];
        if (!observers) return;

        observers.delete(callback);
        if (observers.size > 0) return;

        if (eventBus.emit === eventBus[VILLAGE_WRAPPED_EMIT]) {
            eventBus.emit = eventBus[VILLAGE_ORIGINAL_EMIT];
        }
        delete eventBus[VILLAGE_OBSERVERS];
        delete eventBus[VILLAGE_ORIGINAL_EMIT];
        delete eventBus[VILLAGE_WRAPPED_EMIT];
    };
}

export class AmbientAudioController {
    constructor({ button } = {}) {
        this.button = button || null;
        this.context = null;
        this.masterGain = null;
        this.userActivated = false;
        this.enabled = this._readStoredPreference();
        this.available = this._hasAudioSupport();
        this.lastCueAt = new Map();
        this.unsubscribers = [];
        this.unlockArmed = false;

        this._onButtonClick = () => this._handleToggle();
        this._onUnlockGesture = (event) => this._handleUnlockGesture(event);
        this._onEventCue = (eventName) => this._handleEvent(eventName);

        if (this.button) {
            this.button.addEventListener('click', this._onButtonClick);
        }

        this._subscribe();
        this._renderButton();
        if (this.enabled) this._armUnlockListeners();
    }

    _subscribe() {
        for (const eventName of Object.keys(EVENT_CUES)) {
            this.unsubscribers.push(eventBus.on(eventName, () => this._onEventCue(eventName)));
        }
        this.unsubscribers.push(observeVillageEvents((eventName) => this._handleVillageEvent(eventName)));
    }

    _handleToggle() {
        this.userActivated = true;
        this.setEnabled(!this.enabled);
    }

    setEnabled(enabled) {
        if (!this.available) return;

        this.enabled = Boolean(enabled);
        this._writeStoredPreference(this.enabled);
        this._renderButton();

        if (this.enabled) {
            this._removeUnlockListeners();
            void this._playCue('enabled');
        } else {
            this._removeUnlockListeners();
            void this._suspendContext();
        }
    }

    _handleUnlockGesture(event) {
        if (!this.enabled || this.userActivated) return;
        if (this.button && event?.target && this.button.contains(event.target)) return;

        this.userActivated = true;
        this._removeUnlockListeners();
        void this._playCue('enabled');
    }

    _handleEvent(eventName) {
        const cueName = EVENT_CUES[eventName];
        if (!cueName || !this._canPlayCue(cueName)) return;
        void this._playCue(cueName);
    }

    _handleVillageEvent(eventName) {
        if (!eventName || !this._canPlayCue('village')) return;
        void this._playCue('village');
    }

    _canPlayCue(cueName) {
        if (!this.enabled || !this.userActivated || !this.available) return false;

        const now = Date.now();
        const cooldown = CUE_COOLDOWNS[cueName] || 0;
        const lastPlayed = this.lastCueAt.get(cueName) || 0;
        if (now - lastPlayed < cooldown) return false;

        this.lastCueAt.set(cueName, now);
        return true;
    }

    async _playCue(cueName) {
        if (!this.enabled || !this.userActivated || !this.available) return;

        try {
            const ready = await this._ensureContext();
            if (!ready || !this.enabled) return;

            switch (cueName) {
                case 'enabled':
                    this._tone(440, 0.08, { delay: 0, volume: 0.18 });
                    this._tone(660, 0.12, { delay: 0.07, volume: 0.2 });
                    break;
                case 'agentAdded':
                    this._tone(523.25, 0.09, { delay: 0, volume: 0.16 });
                    this._tone(659.25, 0.12, { delay: 0.08, volume: 0.18 });
                    break;
                case 'agentUpdated':
                    this._tone(587.33, 0.055, { type: 'triangle', volume: 0.08 });
                    break;
                case 'agentRemoved':
                    this._tone(392, 0.09, { delay: 0, volume: 0.12 });
                    this._tone(329.63, 0.13, { delay: 0.08, volume: 0.1 });
                    break;
                case 'usageUpdated':
                    this._tone(783.99, 0.05, { type: 'triangle', volume: 0.06 });
                    this._tone(987.77, 0.06, { delay: 0.05, type: 'triangle', volume: 0.055 });
                    break;
                case 'village':
                    this._tone(440, 0.08, { type: 'sine', volume: 0.1 });
                    this._tone(554.37, 0.1, { delay: 0.09, type: 'sine', volume: 0.09 });
                    break;
                default:
                    break;
            }
        } catch (error) {
            const message = error?.message || String(error);
            console.warn(`[AmbientAudio] cue skipped: ${message}`);
        }
    }

    _tone(frequency, duration, { delay = 0, type = 'sine', volume = 0.1 } = {}) {
        if (!this.context || !this.masterGain) return;

        const start = this.context.currentTime + delay;
        const end = start + duration;
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();

        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        oscillator.connect(gain);
        gain.connect(this.masterGain);
        oscillator.start(start);
        oscillator.stop(end + 0.03);
    }

    async _ensureContext() {
        if (!this.context) {
            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) {
                this.available = false;
                this._renderButton();
                return false;
            }

            this.context = new AudioContextCtor();
            this.masterGain = this.context.createGain();
            this.masterGain.gain.value = 0.028;
            this.masterGain.connect(this.context.destination);
        }

        if (this.context.state === 'suspended') {
            await this.context.resume();
        }

        return this.context.state === 'running';
    }

    async _suspendContext() {
        if (!this.context || this.context.state !== 'running') return;
        try {
            await this.context.suspend();
        } catch {
            // Best effort only; disabling the controller still prevents future cues.
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

    _renderButton() {
        if (!this.button) return;

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

    _readStoredPreference() {
        try {
            return window.localStorage?.getItem(STORAGE_KEY) === 'true';
        } catch {
            return false;
        }
    }

    _writeStoredPreference(enabled) {
        try {
            window.localStorage?.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
        } catch {
            // Preference persistence is optional; sound still works for this session.
        }
    }

    _hasAudioSupport() {
        return Boolean(window.AudioContext || window.webkitAudioContext);
    }

    destroy() {
        this._removeUnlockListeners();
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];

        if (this.button) {
            this.button.removeEventListener('click', this._onButtonClick);
        }

        if (this.context) {
            void this.context.close().catch(() => {});
        }
    }
}
