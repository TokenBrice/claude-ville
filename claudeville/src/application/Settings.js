const STORAGE_KEYS = {
    privacyRedaction: 'claudeville.privacyRedaction',
};

class SettingsStore {
    constructor() {
        this.listeners = new Set();
        this.values = {
            privacyRedaction: this._readBool(STORAGE_KEYS.privacyRedaction, false),
        };
    }

    get privacyRedaction() {
        return this.values.privacyRedaction;
    }

    set privacyRedaction(value) {
        this.set('privacyRedaction', value);
    }

    set(key, value) {
        if (!Object.prototype.hasOwnProperty.call(this.values, key)) return;
        const normalized = Boolean(value);
        if (this.values[key] === normalized) return;
        this.values[key] = normalized;
        this._writeBool(STORAGE_KEYS[key], normalized);
        this._emit();
    }

    subscribe(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    snapshot() {
        return { ...this.values };
    }

    _emit() {
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    _readBool(key, fallback) {
        if (typeof localStorage === 'undefined') return fallback;
        try {
            const value = localStorage.getItem(key);
            if (value == null) return fallback;
            return value === 'true';
        } catch {
            return fallback;
        }
    }

    _writeBool(key, value) {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(key, String(Boolean(value)));
        } catch { /* ignore storage failures */ }
    }
}

export const Settings = new SettingsStore();
