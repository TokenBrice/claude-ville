const DB_NAME = 'claudeville-chronicle';
const DB_VERSION = 2;
const LEASE_KEY = 'claudeville.chronicle.captureLease';
const DEFAULT_LEASE_TTL_MS = 7000;

const RETENTION_MS = {
    manifests: 24 * 60 * 60 * 1000,
    pinnedManifest: 7 * 24 * 60 * 60 * 1000,
    monuments: 30 * 24 * 60 * 60 * 1000,
    trailSamples: 24 * 60 * 60 * 1000,
};

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function randomToken() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowMs() {
    return Date.now();
}

function storeConfig(name) {
    return {
        manifests: { keyPath: 'id', indexes: ['project', 'ts', 'pinned'] },
        monuments: { keyPath: 'id', indexes: ['district', 'plantedAt', 'ts', 'dedupKey'] },
        trailSamples: { keyPath: 'id', indexes: ['agentId', 'ts'] },
        auroraLog: { keyPath: 'localDate', indexes: ['ts'] },
        meta: { keyPath: 'key', indexes: [] },
    }[name];
}

export class ChronicleStore {
    constructor({ dbName = DB_NAME } = {}) {
        this.dbName = dbName;
        this.db = null;
        this.channel = typeof BroadcastChannel !== 'undefined'
            ? new BroadcastChannel('claudeville-chronicle')
            : null;
        this._leaseToken = null;
        this._lastLeaseNotice = 0;
        this.channel?.addEventListener?.('message', (event) => {
            if (event.data?.type === 'lease-acquired') {
                this._lastLeaseNotice = nowMs();
            }
        });
    }

    async open() {
        if (this.db) return this;
        if (typeof indexedDB === 'undefined') {
            throw new Error('IndexedDB is not available in this browser context');
        }
        const request = indexedDB.open(this.dbName, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const tx = request.transaction;
            for (const name of ['manifests', 'monuments', 'trailSamples', 'auroraLog', 'meta']) {
                const config = storeConfig(name);
                this._ensureStore(db, tx, name, config.keyPath, config.indexes);
            }
        };
        this.db = await requestToPromise(request);
        return this;
    }

    close() {
        this.db?.close?.();
        this.db = null;
        this.channel?.close?.();
    }

    async put(storeName, record) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        await txDone(tx);
        return record;
    }

    async bulkPut(storeName, records = []) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const record of records) store.put(record);
        await txDone(tx);
        return records.length;
    }

    async get(storeName, key) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly');
        return requestToPromise(tx.objectStore(storeName).get(key));
    }

    async deleteKey(storeName, key) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        await txDone(tx);
    }

    async queryRange(storeName, indexOrOptions = 'ts', lowerArg = null, upperArg = null, optsArg = {}) {
        const options = typeof indexOrOptions === 'object'
            ? indexOrOptions
            : { index: indexOrOptions, lower: lowerArg, upper: upperArg, ...optsArg };
        const {
            index = 'ts',
            lower = null,
            upper = null,
            limit = Infinity,
            direction = 'next',
        } = options;
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const source = index && store.indexNames.contains(index) ? store.index(index) : store;
        const range = this._range(lower, upper);
        const out = [];
        await new Promise((resolve, reject) => {
            const request = source.openCursor(range, direction);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || out.length >= limit) {
                    resolve();
                    return;
                }
                out.push(cursor.value);
                cursor.continue();
            };
        });
        return out;
    }

    async deleteRange(storeName, { index = 'ts', lower = null, upper = null } = {}) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const source = index && store.indexNames.contains(index) ? store.index(index) : store;
        const range = this._range(lower, upper);
        let deleted = 0;
        await new Promise((resolve, reject) => {
            const request = source.openCursor(range);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                cursor.delete();
                deleted++;
                cursor.continue();
            };
        });
        await txDone(tx);
        return deleted;
    }

    async count(storeName, indexName = null, range = null) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const source = indexName && store.indexNames.contains(indexName) ? store.index(indexName) : store;
        return requestToPromise(source.count(range));
    }

    async prune(now = nowMs()) {
        const manifestCutoff = now - RETENTION_MS.manifests;
        const pinnedCutoff = now - RETENTION_MS.pinnedManifest;
        const monumentCutoff = now - RETENTION_MS.monuments;
        const trailCutoff = now - RETENTION_MS.trailSamples;
        const deleted = {
            manifests: await this._deleteWhere('manifests', record => (
                Number(record.ts || 0) < (record.pinned ? pinnedCutoff : manifestCutoff)
            )),
            monuments: await this.deleteRange('monuments', { index: 'plantedAt', upper: monumentCutoff }),
            trailSamples: await this.deleteRange('trailSamples', { upper: trailCutoff }),
        };
        await this.put('meta', { key: 'lastPruneAt', value: now });
        return deleted;
    }

    async getMeta(key, fallback = null) {
        const row = await this.get('meta', key);
        return row ? row.value : fallback;
    }

    async setMeta(key, value) {
        return this.put('meta', { key, value, ts: nowMs() });
    }

    acquireCaptureLease({ ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
        const token = randomToken();
        const expiresAt = nowMs() + ttlMs;
        const current = this._readLease();
        if (current && current.expiresAt > nowMs() && current.token !== token) {
            return {
                acquired: false,
                token: current.token,
                expiresAt: current.expiresAt,
                renew: () => false,
                release: () => false,
            };
        }

        this._writeLease({ token, expiresAt });
        const confirmed = this._readLease();
        const acquired = confirmed?.token === token;
        if (acquired) {
            this._leaseToken = token;
            this.channel?.postMessage?.({ type: 'lease-acquired', token, expiresAt });
        }

        return {
            acquired,
            token,
            expiresAt,
            renew: () => this._renewLease(token, ttlMs),
            release: () => this._releaseLease(token),
        };
    }

    _ensureStore(db, tx, name, keyPath, indexes) {
        let store;
        if (db.objectStoreNames.contains(name)) {
            store = tx.objectStore(name);
            if (store.keyPath !== keyPath) {
                db.deleteObjectStore(name);
                store = db.createObjectStore(name, { keyPath });
            }
        } else {
            store = db.createObjectStore(name, { keyPath });
        }
        for (const indexName of indexes) {
            if (!store.indexNames.contains(indexName)) store.createIndex(indexName, indexName, { unique: false });
        }
    }

    _range(lower, upper) {
        if (lower != null && upper != null) return IDBKeyRange.bound(lower, upper);
        if (lower != null) return IDBKeyRange.lowerBound(lower);
        if (upper != null) return IDBKeyRange.upperBound(upper);
        return null;
    }

    async _deleteWhere(storeName, predicate) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        let deleted = 0;
        await new Promise((resolve, reject) => {
            const request = store.openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                if (predicate(cursor.value)) {
                    cursor.delete();
                    deleted++;
                }
                cursor.continue();
            };
        });
        await txDone(tx);
        return deleted;
    }

    _readLease() {
        if (typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(LEASE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    _writeLease(record) {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(LEASE_KEY, JSON.stringify(record));
        } catch { /* ignore */ }
    }

    _renewLease(token, ttlMs) {
        const current = this._readLease();
        if (!current || current.token !== token) return false;
        const expiresAt = nowMs() + ttlMs;
        this._writeLease({ token, expiresAt });
        this.channel?.postMessage?.({ type: 'lease-renewed', token, expiresAt });
        return true;
    }

    _releaseLease(token) {
        const current = this._readLease();
        if (!current || current.token !== token) return false;
        try {
            localStorage.removeItem(LEASE_KEY);
        } catch { /* ignore */ }
        this.channel?.postMessage?.({ type: 'lease-released', token });
        if (this._leaseToken === token) this._leaseToken = null;
        return true;
    }
}

export { DB_NAME, DB_VERSION, RETENTION_MS };
