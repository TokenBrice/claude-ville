import { snapshotAgeMs, linkStatusText } from '../../application/VillageState.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { el, replaceChildren } from './DomSafe.js';
import { getClientPerfMetrics } from './ClientPerfMetrics.js';
import {
    HUSH_DURATION_MS,
    SOUND_PRESETS,
    SOUND_PRESET_DETAILS,
    SOUND_PRESET_LABELS,
    SOUND_STEP_MAX,
    TONE_RANGE_DB,
    modeForPreset,
    readTownBandVoice,
    soundStep,
    writeCaptionSetting,
    writeCountHours,
    writeHushUntil,
    writePresetVolumeStep,
    writeQuietHours,
    writeReminderSetting,
    writeSoundBackground,
    writeSoundOutput,
    writeSoundSoften,
    writeSoundTone,
    writeStoredSoundEnabled,
    writeStoredSoundMode,
    writeTownBandVoice,
} from './SoundSettings.js';

export const REDUCED_MOTION_OVERRIDE_KEY = 'claudeville.motion.reduce';
const HOOK_LIVE_WINDOW_MS = 15_000;
const HEALTH_REFRESH_MS = 1_000;
// SOUND (7.8, UX-16): the same words as the popover. Internal ids stay in
// storage; SET shows what each choice does.
const PRESET_CHOICES = Object.freeze(SOUND_PRESETS.map(preset => [preset, SOUND_PRESET_LABELS[preset]]));
const BACKGROUND_CHOICES = Object.freeze([
    ['play', 'Keep playing'],
    ['signals', 'Signals only'],
]);
const OUTPUT_CHOICES = Object.freeze([
    ['speakers', 'Speakers'],
    ['headphones', 'Headphones'],
    ['mono', 'Mono'],
]);
const QUIET_HOURS_CHOICES = Object.freeze([
    ['off', 'Off'],
    ['22-08', '10 PM – 8 AM'],
    ['20-08', '8 PM – 8 AM'],
    ['23-07', '11 PM – 7 AM'],
]);
const SOFTEN_CHOICES = Object.freeze([
    ['auto', 'Follow Reduce motion'],
    ['on', 'On'],
    ['off', 'Off'],
]);
// Captions (3.8): Automatic follows the sound: signals while it is off,
// signals and events while it is on.
const CAPTION_CHOICES = Object.freeze([
    ['auto', 'Automatic'],
    ['signals', 'Signals only'],
    ['events', 'Signals and events'],
    ['all', 'Everything I can hear'],
]);
const REMINDER_CHOICES = Object.freeze([
    ['standard', 'Standard'],
    ['gentle', 'Gentle'],
    ['off', 'Off'],
]);
// D2: the Town band's players. The sound controller hears a change on
// `sound:town-band-voice` and the band changes voice at its next chunk.
const TOWN_BAND_VOICE_CHOICES = Object.freeze([
    ['isle', 'Isle Band'],
    ['chip', 'Chip restored'],
]);

let motionOverrideController = null;

// Level sliders: whole steps 0–10 (plan 1.2, UX-8) read as `n / 10`.
const LEVEL_SCALE = Object.freeze({
    min: 0,
    max: SOUND_STEP_MAX,
    toSlider: value => soundStep(value, SOUND_STEP_MAX),
    fromSlider: step => step,
    readout: step => `${step} / 10`,
    valueText: step => (step === 0 ? 'Off' : `${step} of 10`),
});
// Tone: Warm −4 dB … Bright +4 dB in 1 dB steps; stored as −1…+1.
const signedDb = db => (db === 0 ? '0 dB' : `${db > 0 ? '+' : '−'}${Math.abs(db)} dB`);
const TONE_SCALE = Object.freeze({
    min: -TONE_RANGE_DB,
    max: TONE_RANGE_DB,
    toSlider: value => Math.round(Math.max(-1, Math.min(1, Number(value) || 0)) * TONE_RANGE_DB) + 0,
    fromSlider: step => step / TONE_RANGE_DB,
    readout: signedDb,
    valueText: db => (db === 0 ? 'Neutral' : `${db < 0 ? 'Warm' : 'Bright'}, ${signedDb(db)}`),
});

// The sliders are 88px wide with an 8px square thumb: 80px of travel split
// into whole-pixel steps (8px for 0–10), so the gold fill always ends on a
// whole pixel at the thumb's centre.
function syncRangeFill(input) {
    const min = Number(input?.min) || 0;
    const max = Number(input?.max) || SOUND_STEP_MAX;
    const steps = Math.max(0, Math.min(max - min, (Number(input?.value) || 0) - min));
    input?.style?.setProperty?.('--fill', `${Math.round(steps * (80 / (max - min))) + 4}px`);
}

function presetOf(settings) {
    return SOUND_PRESETS.includes(settings?.soundPreset) ? settings.soundPreset : 'off';
}

function clockTime(ms) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function storageGet(storage, key) {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function storageSet(storage, key, value) {
    try { storage?.setItem(key, value); } catch { /* persistence is optional */ }
}

export function readReducedMotionOverride(storage = globalThis.window?.localStorage) {
    return storageGet(storage, REDUCED_MOTION_OVERRIDE_KEY) === '1';
}

function callMediaListener(listener, event) {
    if (typeof listener === 'function') listener(event);
    else listener?.handleEvent?.(event);
}

/**
 * Make the operator override look like the native reduced-motion query to
 * renderers created after TopBar, while leaving every other media query alone.
 */
export function installReducedMotionOverride(root = globalThis.window) {
    if (motionOverrideController || !root?.matchMedia) return motionOverrideController;
    const nativeMatchMedia = root.matchMedia.bind(root);
    let reducedMotionRecord = null;
    let forced = readReducedMotionOverride(root.localStorage);

    const applyClass = () => {
        root.document?.documentElement?.classList.toggle('cv-reduced-motion-override', forced);
    };
    const effectiveMatches = (nativeQuery) => forced || nativeQuery.matches;
    const notify = (record) => {
        const next = effectiveMatches(record.nativeQuery);
        if (next === record.lastMatches) return;
        record.lastMatches = next;
        const event = { type: 'change', media: record.media, matches: next };
        for (const listener of record.listeners) callMediaListener(listener, event);
        callMediaListener(record.proxy.onchange, event);
    };

    root.matchMedia = (query) => {
        if (String(query).trim() !== '(prefers-reduced-motion: reduce)') return nativeMatchMedia(query);
        // Every caller observes the same preference. In particular, creating
        // an AgentSprite only reads .matches and must not retain a new query.
        if (reducedMotionRecord) return reducedMotionRecord.proxy;
        const nativeQuery = nativeMatchMedia(query);
        const record = {
            media: nativeQuery.media,
            nativeQuery,
            listeners: new Set(),
            lastMatches: effectiveMatches(nativeQuery),
            proxy: null,
        };
        const onNativeChange = () => notify(record);
        const proxy = {
            media: nativeQuery.media,
            onchange: null,
            get matches() { return effectiveMatches(nativeQuery); },
            addEventListener(type, listener) {
                if (type === 'change' && listener) record.listeners.add(listener);
            },
            removeEventListener(type, listener) {
                if (type === 'change') record.listeners.delete(listener);
            },
            addListener(listener) { if (listener) record.listeners.add(listener); },
            removeListener(listener) { record.listeners.delete(listener); },
            dispatchEvent(event) {
                for (const listener of record.listeners) callMediaListener(listener, event);
                return true;
            },
        };
        record.proxy = proxy;
        reducedMotionRecord = record;
        if (nativeQuery.addEventListener) nativeQuery.addEventListener('change', onNativeChange);
        else nativeQuery.addListener?.(onNativeChange);
        return proxy;
    };

    motionOverrideController = {
        get reduced() { return forced; },
        set(reduced) {
            forced = Boolean(reduced);
            storageSet(root.localStorage, REDUCED_MOTION_OVERRIDE_KEY, forced ? '1' : '0');
            applyClass();
            if (reducedMotionRecord) notify(reducedMotionRecord);
            return forced;
        },
    };
    applyClass();
    return motionOverrideController;
}

function oneDecimal(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(1) : null;
}

function ageText(ageMs) {
    const value = Number(ageMs);
    if (!Number.isFinite(value) || value < 0) return 'not received';
    if (value < 10_000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.round(value / 1000)} s`;
}

function providerState(provider) {
    const sessions = Math.max(0, Number(provider?.sessions) || 0);
    if (provider?.health === 'unavailable') return 'not installed';
    if (provider?.health === 'degraded') return 'degraded';
    if (provider?.health === 'empty' || sessions === 0) return 'empty';
    return `ready · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`;
}

function providerClass(provider) {
    if (provider?.health === 'degraded') return 'settings-provider--degraded';
    if (provider?.health === 'unavailable') return 'settings-provider--unavailable';
    return 'settings-provider--ready';
}

export class SettingsPanel {
    constructor({
        readSettings,
        onSoundPreset,
        onSoundVolume,
        onSoundBackground,
        onSoundOutput,
        onSoundTone,
        onSoundSoften,
        onSoundQuietHours,
        onSoundHush,
        onSoundReminders,
        onSoundCountHours,
        onSoundTownBandVoice,
        onCaptions,
        onAutoCamera,
        onDesktopAlerts,
        onSidebarCollapsed,
        onReducedMotion,
        onReset,
        getVillageState,
        getChronicleStatus,
        getCurrentFps,
        getHookFreshness,
        unknownModelSeenToday,
        alertsAvailable = true,
        fetchImpl = globalThis.fetch,
        storage = globalThis.window?.localStorage,
    } = {}) {
        this.readSettings = readSettings;
        // Sound: TopBar routes each change to the sound controller, which
        // persists it and applies it live. Without one, SET only persists
        // (the controller reads the stored value when it loads).
        this.onSoundPreset = onSoundPreset || ((preset) => {
            writeStoredSoundEnabled(preset !== 'off', storage);
            if (modeForPreset(preset)) writeStoredSoundMode(modeForPreset(preset), storage);
            return preset;
        });
        this.onSoundVolume = onSoundVolume || ((preset, step) => writePresetVolumeStep(preset, step, storage));
        this.onSoundBackground = onSoundBackground || (value => writeSoundBackground(value, storage));
        this.onSoundOutput = onSoundOutput || (value => writeSoundOutput(value, storage));
        this.onSoundTone = onSoundTone || (value => writeSoundTone(value, storage));
        this.onSoundSoften = onSoundSoften || (value => writeSoundSoften(value, storage));
        this.onSoundQuietHours = onSoundQuietHours || (value => writeQuietHours(value, storage));
        this.onSoundHush = onSoundHush || (on => writeHushUntil(on ? Date.now() + HUSH_DURATION_MS : 0, storage));
        // Preferences no audio object needs to apply: SET persists them and
        // their readers take them on use.
        this.onSoundReminders = onSoundReminders || (value => writeReminderSetting(value, storage));
        this.onSoundCountHours = onSoundCountHours || (on => writeCountHours(on, storage));
        this.onSoundTownBandVoice = onSoundTownBandVoice || ((value) => {
            const voice = writeTownBandVoice(value, storage);
            eventBus.emit('sound:town-band-voice', { voice });
        });
        this._storage = storage;
        this.onCaptions = onCaptions || (value => writeCaptionSetting(value, storage));
        this.onAutoCamera = onAutoCamera;
        this.onDesktopAlerts = onDesktopAlerts;
        this.onSidebarCollapsed = onSidebarCollapsed;
        this.onReducedMotion = onReducedMotion;
        this.onReset = onReset;
        this.getVillageState = getVillageState;
        this.getChronicleStatus = getChronicleStatus;
        this.getCurrentFps = getCurrentFps;
        this.getHookFreshness = getHookFreshness;
        this.unknownModelSeenToday = unknownModelSeenToday;
        this.alertsAvailable = Boolean(alertsAvailable);
        this.fetchImpl = fetchImpl;
        this.root = null;
        this.providers = [];
        this.controls = new Map();
        this._destroyed = false;
        this._providerController = null;
        this._refreshTimer = null;
        this._metricsStartedHere = false;
        this._sound = null;
        this._offSoundState = null;
    }

    build() {
        const settings = this.readSettings?.() || {};
        this.root = el('div', { className: 'settings-panel' });
        this.root.append(
            el('p', {
                className: 'settings-panel__intro',
                text: 'Preferences, local watchtowers, storage, pricing, and live browser health.',
            }),
            this._buildSound(settings),
            this._buildControls(settings),
            this._buildWatchtowers(),
            this._buildStorage(),
            this._buildPricing(),
            this._buildHealth(),
            this._buildActions(),
        );

        const metrics = getClientPerfMetrics();
        this._metricsStartedHere = metrics?.start?.({ reset: false }) === true;
        this._refreshOperationalRows();
        this._refreshTimer = globalThis.setInterval?.(() => {
            if (!this.root?.isConnected) {
                this.destroy();
                return;
            }
            this._refreshOperationalRows();
        }, HEALTH_REFRESH_MS);
        void this._loadProviders();
        // One sound state, many views (C-UX1): a change made in the popover,
        // by `M` or by hush expiry reaches SET through the controller's
        // change-only `audio:sound-state`.
        this._offSoundState = eventBus.on('audio:sound-state', () => this._syncSound());
        return this.root;
    }

    _section(title, className, children = []) {
        return el('section', { className: `settings-section ${className}` }, [
            el('h3', { className: 'settings-section__heading', text: title }),
            ...children,
        ]);
    }

    // SOUND (7.8, UX-16): the popover's model plus the listening preferences,
    // in the order Listen to, Volume, then how and when it plays. Volume
    // follows the preset: Off hides it, and each preset keeps its own
    // volume step.
    _buildSound(settings) {
        const preset = presetOf(settings);
        const presetRow = this._select('soundPreset', 'Listen to', SOUND_PRESET_DETAILS[preset], PRESET_CHOICES, preset,
            value => this._choosePreset(value));
        const volumeRow = this._slider('soundVolume', 'Volume', '', null,
            step => this.onSoundVolume?.(this._sound.preset, step));
        const hushButton = el('button', { className: 'settings-button' });
        hushButton.type = 'button';
        hushButton.addEventListener('click', () => this._toggleHush());
        const hushRow = this._settingRow('Hush', 'Signals only for an hour.', hushButton);
        this.controls.set('soundHush', hushButton);
        this._sound = {
            preset: null,
            presetDetail: presetRow.querySelector('.settings-control__detail'),
            volumeRow,
            hushDetail: hushRow.querySelector('.settings-control__detail'),
            hushUntil: 0,
        };
        const grid = el('div', { className: 'settings-controls' }, [
            presetRow,
            volumeRow,
            this._select('soundBackground', 'In the background', 'When ClaudeVille is visible but another app has focus.',
                BACKGROUND_CHOICES, settings.soundBackground, this.onSoundBackground),
            this._select('soundOutput', 'Output', 'Headphones narrows left–right placement. Mono plays everything in both ears.',
                OUTPUT_CHOICES, settings.soundOutput, this.onSoundOutput),
            this._slider('soundTone', 'Tone', 'Warm ↔ Bright, on the town music.', settings.soundTone,
                value => this.onSoundTone?.(value), TONE_SCALE),
            this._select('soundQuietHours', 'Quiet hours', 'Signals only, a little softer.',
                QUIET_HOURS_CHOICES, settings.soundQuietHours, this.onSoundQuietHours),
            hushRow,
            this._select('captions', 'Captions', 'Short notes for what the village signals.',
                CAPTION_CHOICES, settings.captions, this.onCaptions),
            this._select('soundSoften', 'Soften sudden sounds', 'Gentler bells. Follows Reduce motion unless set.',
                SOFTEN_CHOICES, settings.soundSoften, this.onSoundSoften),
            this._select('soundReminders', 'Reminders', 'Ring again while an agent is still waiting.',
                REMINDER_CHOICES, settings.soundReminders, this.onSoundReminders),
            this._checkbox('soundCountHours', 'Count the hours', 'The tower bell strikes the hour after its phrase.',
                settings.soundCountHours, this.onSoundCountHours),
            this._select('soundTownBandVoice', 'Town band voice', 'Who plays the town music: the island\'s own band or the restored console chip.',
                TOWN_BAND_VOICE_CHOICES, settings.soundTownBandVoice ?? readTownBandVoice(this._storage), this.onSoundTownBandVoice),
        ]);
        this._renderPreset(settings);
        this._renderHush(settings.soundHushUntil);
        const section = this._section('SOUND', 'settings-section--sound', [grid]);
        section.id = 'settingsSound';
        return section;
    }

    _buildControls(settings) {
        const grid = el('div', { className: 'settings-controls' });
        grid.append(
            this._checkbox('autoCamera', 'Automatic camera', 'Frame live action while the World is idle.', settings.autoCamera, this.onAutoCamera),
            this._checkbox('desktopAlerts', 'Desktop alerts', this.alertsAvailable
                ? 'Notify when an agent needs you.'
                : 'Unavailable in this browser.', settings.desktopAlerts, this.onDesktopAlerts, !this.alertsAvailable),
            this._checkbox('sidebarCollapsed', 'Collapse sidebar', 'Keep the agent roster folded.', settings.sidebarCollapsed, this.onSidebarCollapsed),
            this._checkbox('reducedMotion', 'Reduce motion', 'Override the system preference for this browser.', settings.reducedMotion, this.onReducedMotion),
        );
        return this._section('CONTROLS', 'settings-section--controls', [grid]);
    }

    async _choosePreset(value) {
        const result = await this.onSoundPreset?.(value);
        // The stored state is the truth: a controller that could not start
        // leaves the preset where it was.
        this._syncSound();
        return result;
    }

    async _toggleHush() {
        const hushed = this._sound.hushUntil > Date.now();
        const until = await this.onSoundHush?.(!hushed);
        this._renderHush(Number.isFinite(Number(until)) ? Number(until) : this.readSettings?.()?.soundHushUntil);
    }

    _renderHush(until) {
        const sound = this._sound;
        if (!sound) return;
        const next = Number(until) > Date.now() ? Number(until) : 0;
        sound.hushUntil = next;
        const detail = next ? `Hushed until ${clockTime(next)}` : 'Signals only for an hour.';
        const text = next ? 'RESUME NOW' : 'HUSH FOR 1 HOUR';
        const button = this.controls.get('soundHush');
        if (sound.hushDetail && sound.hushDetail.textContent !== detail) sound.hushDetail.textContent = detail;
        if (button && button.textContent !== text) button.textContent = text;
    }

    // The rows that follow the preset: its detail and its own volume step.
    _renderPreset(settings) {
        const sound = this._sound;
        if (!sound) return;
        const preset = presetOf(settings);
        const mode = modeForPreset(preset);
        const detail = SOUND_PRESET_DETAILS[preset];
        if (sound.presetDetail && sound.presetDetail.textContent !== detail) sound.presetDetail.textContent = detail;
        sound.volumeRow.hidden = !mode;
        if (mode) this._syncRange('soundVolume', settings.soundVolumes?.[mode]);
        sound.preset = preset;
    }

    /** Scrolls SET to its SOUND section and focuses `Listen to` (the popover's link). */
    focusSound() {
        const select = this.controls.get('soundPreset');
        select?.closest?.('.settings-section')?.scrollIntoView?.({ block: 'start' });
        select?.focus?.({ preventScroll: true });
    }

    _settingRow(label, detail, control) {
        return el('div', { className: 'settings-control' }, [
            el('div', { className: 'settings-control__copy' }, [
                el('span', { className: 'settings-control__label', text: label }),
                detail ? el('span', { className: 'settings-control__detail', text: detail }) : null,
            ]),
            control,
        ]);
    }

    _checkbox(key, label, detail, checked, callback, disabled = false) {
        const input = el('input', { className: 'settings-switch__input', ariaLabel: label });
        input.type = 'checkbox';
        input.checked = Boolean(checked);
        input.disabled = disabled;
        input.addEventListener('change', async () => {
            input.setAttribute('aria-busy', 'true');
            try {
                const result = await callback?.(input.checked);
                if (typeof result === 'boolean') input.checked = result;
            } finally {
                input.removeAttribute('aria-busy');
            }
        });
        this.controls.set(key, input);
        return this._settingRow(label, detail, el('label', { className: 'settings-switch' }, [
            input,
            el('span', { className: 'settings-switch__track', ariaLabel: null }),
        ]));
    }

    _select(key, label, detail, choices, value, callback) {
        const select = el('select', { className: 'settings-select', ariaLabel: label });
        for (const [choice, copy] of choices) {
            const option = el('option', { text: copy });
            option.value = choice;
            option.selected = choice === value;
            select.appendChild(option);
        }
        select.addEventListener('change', async () => {
            const result = await callback?.(select.value);
            // A setter returns the value it kept (an invalid one falls back).
            if (choices.some(([choice]) => choice === result) && select.value !== result) select.value = result;
        });
        this.controls.set(key, select);
        // appearance:none drops the OS chevron; the wrap draws a pixel one.
        return this._settingRow(label, detail, el('span', { className: 'settings-select-wrap' }, [select]));
    }

    // Sound levels are stored as whole steps 0–10 (plan 1.2, UX-8) and shown
    // as `n / 10` (`aria-valuetext` `n of 10`); the callback receives the
    // stored value (`scale.fromSlider`).
    _slider(key, label, detail, value, callback, scale = LEVEL_SCALE) {
        const input = el('input', { className: 'settings-range', ariaLabel: label });
        input.type = 'range';
        input.min = String(scale.min);
        input.max = String(scale.max);
        input.step = '1';
        const output = el('output', { className: 'settings-range__value' });
        const control = { input, output, scale };
        this.controls.set(key, control);
        this._setSlider(control, scale.toSlider(value));
        input.addEventListener('input', () => {
            const step = Number(input.value);
            this._setSlider(control, step);
            callback?.(scale.fromSlider(step));
        });
        return this._settingRow(label, detail, el('div', { className: 'settings-range-wrap' }, [input, output]));
    }

    _setSlider({ input, output, scale }, step) {
        if (input.value !== String(step)) input.value = String(step);
        const readout = scale.readout(step);
        if (output.textContent !== readout) output.textContent = readout;
        input.setAttribute('aria-valuetext', scale.valueText(step));
        syncRangeFill(input);
    }

    _buildWatchtowers() {
        this.watchtowerList = el('div', {
            className: 'settings-roster',
            text: 'Reading local provider health…',
        });
        this.watchtowerList.setAttribute('aria-live', 'polite');
        return this._section('WATCHTOWERS', 'settings-section--watchtowers', [this.watchtowerList]);
    }

    async _loadProviders() {
        if (typeof this.fetchImpl !== 'function') {
            this._renderProviderError();
            return;
        }
        this._providerController?.abort?.();
        this._providerController = new AbortController();
        try {
            const response = await this.fetchImpl('/api/providers', { signal: this._providerController.signal });
            if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
            const payload = await response.json();
            const providers = Array.isArray(payload?.health)
                ? payload.health
                : (Array.isArray(payload?.providers) ? payload.providers : []);
            this.providers = providers
                .map((provider) => ({
                    id: String(provider?.id || provider?.name || 'unknown'),
                    name: String(provider?.name || provider?.id || 'Unknown'),
                    health: String(provider?.health || 'unavailable'),
                    sessions: Math.max(0, Number(provider?.sessions) || 0),
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            this._renderProviders();
        } catch (error) {
            if (error?.name !== 'AbortError') this._renderProviderError();
        }
    }

    _renderProviderError() {
        if (!this.watchtowerList) return;
        replaceChildren(this.watchtowerList, [el('p', {
            className: 'settings-empty settings-empty--degraded',
            text: 'Provider health is unavailable.',
        })]);
    }

    _renderProviders(now = Date.now()) {
        if (!this.watchtowerList) return;
        if (this.providers.length === 0) {
            replaceChildren(this.watchtowerList, [el('p', {
                className: 'settings-empty',
                text: 'No providers were reported.',
            })]);
            return;
        }
        replaceChildren(this.watchtowerList, this.providers.map((provider) => {
            const hookAge = Number(this.getHookFreshness?.(provider.id, now));
            const hook = Number.isFinite(hookAge) && hookAge >= 0 && hookAge < HOOK_LIVE_WINDOW_MS
                ? ` · hook: live · ${ageText(hookAge)}`
                : '';
            return el('div', {
                className: `settings-provider ${providerClass(provider)}`,
            }, [
                el('span', { className: 'settings-provider__name', text: provider.name }),
                el('span', { className: 'settings-provider__state', text: `${providerState(provider)}${hook}` }),
            ]);
        }));
    }

    _buildStorage() {
        this.chronicleNotice = el('p', { className: 'settings-storage__notice' });
        this.chronicleNotice.setAttribute('role', 'status');
        return this._section('STORAGE', 'settings-section--storage', [
            el('dl', { className: 'settings-ledger' }, [
                el('dt', { text: 'Preferences, names, pins' }),
                el('dd', { text: 'Browser storage · survives reload' }),
                el('dt', { text: 'Chronicle and spend ledger' }),
                el('dd', { text: 'IndexedDB · survives reload' }),
                el('dt', { text: 'Live sessions and hook detail' }),
                el('dd', { text: 'Memory only · cleared on reload' }),
            ]),
            this.chronicleNotice,
        ]);
    }

    _buildPricing() {
        this.pricingState = el('span', { className: 'settings-pricing__state' });
        return this._section('PRICING', 'settings-section--pricing', [
            el('div', { className: 'settings-fact-row' }, [
                el('span', { className: 'settings-fact-row__label', text: 'Model pricing table' }),
                el('span', { className: 'settings-fact-row__value' }, [
                    `revision ${TokenUsage.rateRevision} · `,
                    this.pricingState,
                ]),
            ]),
        ]);
    }

    _buildHealth() {
        this.healthLink = el('span', { className: 'settings-fact-row__value' });
        this.healthSnapshot = el('span', { className: 'settings-fact-row__value' });
        this.healthFrames = el('span', { className: 'settings-fact-row__value' });
        this.healthLoop = el('span', { className: 'settings-fact-row__value' });
        const row = (label, value) => el('div', { className: 'settings-fact-row' }, [
            el('span', { className: 'settings-fact-row__label', text: label }),
            value,
        ]);
        return this._section('HEALTH', 'settings-section--health', [
            row('Link', this.healthLink),
            row('Last snapshot', this.healthSnapshot),
            row('Render', this.healthFrames),
            row('Event-loop delay', this.healthLoop),
        ]);
    }

    _refreshOperationalRows() {
        const now = Date.now();
        const state = this.getVillageState?.();
        if (this.healthLink) this.healthLink.textContent = linkStatusText(state, now).toLowerCase();
        if (this.healthSnapshot) this.healthSnapshot.textContent = ageText(snapshotAgeMs(state, now));

        let frameHealth = null;
        try { frameHealth = globalThis.window?.__claudeVillePerf?.frameHealth?.() || null; } catch { /* diagnostics only */ }
        const metrics = getClientPerfMetrics()?.getSnapshot?.() || null;
        const p50 = oneDecimal(metrics?.frames?.p50Ms);
        const p95 = oneDecimal(metrics?.frames?.p95Ms ?? frameHealth?.p95FrameGapMs);
        // A suspended render loop reports null; Number(null) is 0, which would
        // read as a genuine 0 FPS stall, so only real numbers count as samples.
        const fps = this.getCurrentFps?.();
        const fpsText = typeof fps === 'number' && Number.isFinite(fps)
            ? `${Math.round(fps)} FPS`
            : 'render loop idle';
        if (this.healthFrames) {
            this.healthFrames.textContent = `${fpsText} · frame p50 ${p50 ?? 'collecting'} ms · p95 ${p95 ?? 'collecting'} ms`;
        }
        const loopDelay = oneDecimal(frameHealth?.p95HostGapMs ?? frameHealth?.emaHostGapMs);
        if (this.healthLoop) this.healthLoop.textContent = `${loopDelay ?? 'collecting'} ms`;

        const chronicleStatus = String(this.getChronicleStatus?.() || 'unknown');
        if (this.chronicleNotice) {
            this.chronicleNotice.classList.toggle('settings-storage__notice--degraded', chronicleStatus === 'degraded');
            this.chronicleNotice.textContent = chronicleStatus === 'degraded'
                ? 'Chronicle degraded: history and today’s persisted ledger may be unavailable.'
                : `Chronicle: ${chronicleStatus}`;
        }
        if (this.pricingState) {
            this.pricingState.textContent = this.unknownModelSeenToday?.()
                ? 'unknown model seen today · default rate used'
                : 'all models matched today';
            this.pricingState.classList.toggle('settings-pricing__state--unknown', Boolean(this.unknownModelSeenToday?.()));
        }
        this._renderProviders(now);
    }

    _buildActions() {
        const reset = el('button', {
            className: 'settings-actions__reset',
            text: 'RESET TO DEFAULTS',
            ariaLabel: 'Reset persisted settings to defaults',
        });
        reset.type = 'button';
        reset.addEventListener('click', async () => {
            reset.disabled = true;
            try {
                await this.onReset?.();
                this.syncControls();
            } finally {
                reset.disabled = false;
                reset.focus();
            }
        });
        return el('div', { className: 'settings-actions' }, [
            reset,
            el('span', {
                className: 'settings-actions__note',
                text: 'Session history, names, pins, and Chronicle data are kept.',
            }),
        ]);
    }

    syncControls() {
        const settings = this.readSettings?.() || {};
        for (const key of ['autoCamera', 'desktopAlerts', 'sidebarCollapsed', 'reducedMotion']) {
            const input = this.controls.get(key);
            if (input) input.checked = Boolean(settings[key]);
        }
        this._syncSound(settings);
        this._refreshOperationalRows();
    }

    // Every SOUND row from the stored state; a value already shown is not
    // written again.
    _syncSound(settings = this.readSettings?.() || {}) {
        if (this._destroyed || !this._sound) return;
        const selects = {
            soundPreset: presetOf(settings),
            soundBackground: settings.soundBackground || 'play',
            soundOutput: settings.soundOutput || 'speakers',
            soundQuietHours: settings.soundQuietHours || 'off',
            captions: settings.captions || 'auto',
            soundSoften: settings.soundSoften || 'auto',
            soundReminders: settings.soundReminders || 'standard',
            soundTownBandVoice: settings.soundTownBandVoice ?? readTownBandVoice(this._storage),
        };
        for (const [key, value] of Object.entries(selects)) {
            const select = this.controls.get(key);
            if (select && select.value !== value) select.value = value;
        }
        const countHours = this.controls.get('soundCountHours');
        if (countHours && countHours.checked !== Boolean(settings.soundCountHours)) countHours.checked = Boolean(settings.soundCountHours);
        this._syncRange('soundTone', settings.soundTone);
        this._renderPreset(settings);
        this._renderHush(settings.soundHushUntil);
    }

    _syncRange(key, value) {
        const control = this.controls.get(key);
        if (control) this._setSlider(control, control.scale.toSlider(value));
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._offSoundState?.();
        this._offSoundState = null;
        this._sound = null;
        this._providerController?.abort?.();
        this._providerController = null;
        if (this._refreshTimer) globalThis.clearInterval?.(this._refreshTimer);
        this._refreshTimer = null;
        if (this._metricsStartedHere) getClientPerfMetrics()?.stop?.();
        this._metricsStartedHere = false;
        this.root = null;
    }
}
