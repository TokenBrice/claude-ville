// Shared GPU texture cache policy, ref-counted source sharing, and per-family
// diagnostics for both WebGL2 (`GpuWorldRenderer`) and WebGPU
// (`GpuWorldRendererWebGPU`). Pure JS with zero DOM/GL/WGPU dependencies so
// Node tests exercise the exact runtime eviction and sharing logic.

const CHANNEL_PREFIX_RE = /^(?:material|emissive|occluder):/;
const EVICTABLE_AGENT_SHEET_RE = /^(?:(?:material|occluder|emissive):)?(?:agentLayer:|agent-(?:model|sheet(?:-lod)?|strip):|agent\.)/;
const AGENT_LAYER_PREFIX_RE = /^(?:agent-(?:ground|frost|snow|shadow):|(?:hat|weaponFront|weaponBack|seatBack|seatFront|candle|lantern|tankard|cairn|artifact|ribbon|frost|snow)\|)/;

// Non-cell entries unused for at least this many frames are reclaimed before
// live model sheets are demoted to cells.
export const STALE_COLD_FRAMES = 30;
// Cap the history of previously-evicted keys so repeat-eviction tracking stays
// O(1) and bounded over multi-hour sessions.
const MAX_EVICTED_KEY_HISTORY = 2048;

export function stripChannelPrefix(key) {
    return typeof key === 'string' ? key.replace(CHANNEL_PREFIX_RE, '') : '';
}

export function isAgentModelCellKey(key) {
    if (typeof key !== 'string' || !key.includes('|cell:')) return false;
    const base = stripChannelPrefix(key);
    return base.startsWith('agent-model:') || base.startsWith('agent.');
}

// Full agent model sheets and legacy strips can be evicted post-submit even
// while live because `preferAgentModelCells` switches subsequent frames to
// 92x92 pose cells (~80x smaller). Live `|cell:` entries have no smaller
// fallback and must not be self-evicted on the frame they are drawn; cold cells
// (`lastUsedFrame < protectedFrame`) remain normally LRU-evictable.
export function isEvictableAgentTexture(key) {
    if (typeof key !== 'string' || isAgentModelCellKey(key)) return false;
    return EVICTABLE_AGENT_SHEET_RE.test(key);
}

// Canonical group identity for full agent model sheets across albedo and
// companion sidecars (`agent-model:`, `material:`, `emissive:`, `occluder:`).
export function agentModelSheetGroupKey(key) {
    if (typeof key !== 'string' || key.includes('|cell:')) return null;
    const stripped = stripChannelPrefix(key).replace(/^agent-model:/, '');
    return stripped.startsWith('agent.') && stripped.includes('|') ? stripped : null;
}

export function textureCacheFamily(key) {
    if (typeof key !== 'string' || !key) return 'other';
    if (key === 'albedo-page') return 'albedo-page';
    const base = stripChannelPrefix(key);
    if (base.startsWith('world-pilot')) return 'world-pilot';
    if (base.startsWith('terrain:') || base.startsWith('ground:')
        || base.startsWith('ground-') || base.startsWith('tide-')) return 'terrain';
    if (base.startsWith('agent-model:') || base.startsWith('agent.')) {
        return base.includes('|cell:') ? 'agent-model-cell' : 'agent-model-sheet';
    }
    if (base.startsWith('agent-frame-atlas')) return 'agent-frame-atlas';
    if (base.startsWith('agent-sheet:') || base.startsWith('agent-sheet-lod:')
        || base.startsWith('agent-strip:') || base.startsWith('agentLayer:')) {
        return 'agent-legacy-sheet';
    }
    if (AGENT_LAYER_PREFIX_RE.test(base)) return 'agent-layer';
    if (base.startsWith('building.') || base.startsWith('proc:building.')
        || base.startsWith('building-ground-shadow:') || base.startsWith('building-ground-cast:')
        || base.startsWith('proc:wreath:')) return 'building';
    if (base.startsWith('prop-cache:') || base.startsWith('prop.')
        || base.startsWith('tree:') || base.startsWith('tree-ground-cast:')
        || base.startsWith('foliage:') || base.startsWith('offshore:')
        || base.startsWith('harbor-collar:') || base.startsWith('harbor:')
        || base.startsWith('flora.') || base.startsWith('lamp.')
        || base.startsWith('wildlife:')) {
        return 'prop';
    }
    if (base.startsWith('frontier:')) return 'frontier';
    if (base.startsWith('field:') || base.startsWith('sea:') || base.startsWith('puddle:')
        || base.startsWith('rain:') || base.startsWith('particle:')) {
        return 'field';
    }
    if (base.startsWith('light:')) return 'light';
    if (base.startsWith('lut:')) return 'lut';
    if (base.startsWith('mark:')) return 'mark';
    return 'other';
}

export function isImageSourceUnloaded(source) {
    if (!source || typeof source !== 'object') return true;
    const isImg = (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement)
        || source.tagName === 'IMG';
    if (!isImg) return false;
    return source.complete === false || (typeof source.naturalWidth === 'number' && source.naturalWidth === 0);
}

// Identical immutable sources can share one GPU texture backing across keys
// without risking cross-key mutation: decoded images (`HTMLImageElement` with
// matching `currentSrc || src`, `ImageBitmap`) and never-mutated baked canvases
// explicitly marked `__cvImmutable = true`.
export function isImmutableTextureSource(source) {
    if (!source || typeof source !== 'object') return false;
    if (source.__cvImmutable === true) return true;
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return true;
    const isImg = (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement)
        || source.tagName === 'IMG';
    if (isImg) return !isImageSourceUnloaded(source);
    return false;
}

export function immutableSourceSignature(source) {
    if (!source || typeof source !== 'object') return '';
    const isImg = (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement)
        || source.tagName === 'IMG';
    if (!isImg) return '';
    return String(source.currentSrc || source.src || '');
}

function emptyFamilyStats() {
    return {
        uploads: 0,
        uploadBytes: 0,
        uploadMs: 0,
        evictions: 0,
        evictedBytes: 0,
        liveEvictions: 0,
        repeatEvictions: 0,
        sameFrameReuploads: 0,
        sourceReuses: 0,
        residentCount: 0,
        residentBytes: 0,
    };
}

function finiteFrame(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : -Infinity;
}

// Tiered eviction order:
//   0 — stale cold entries (`lastUsedFrame < protectedFrame - STALE_COLD_FRAMES`), oldest first
//   1 — full evictable agent sheets (cold or live) when over byte cap, oldest then largest first
//   2 — recent cold non-cell entries, oldest then largest first
//   3 — warm cold agent-model-cell entries, oldest first
// Live non-sheet entries (including live `|cell:` entries) are excluded.
export function selectEvictionCandidates(entries, {
    protectedFrame,
    overBytes = true,
    skipKey = null,
} = {}) {
    const staleCutoff = protectedFrame - STALE_COLD_FRAMES;
    const candidates = [];
    for (const [key, entry] of entries) {
        if (skipKey && skipKey(key)) continue;
        const lastUsed = finiteFrame(entry.lastUsedFrame);
        const isLive = lastUsed >= protectedFrame;
        const evictableSheet = isEvictableAgentTexture(key);
        if (isLive && !evictableSheet) continue;
        let tier;
        if (!isLive && lastUsed < staleCutoff) {
            tier = 0;
        } else if (overBytes && evictableSheet) {
            tier = 1;
        } else if (!isLive && !isAgentModelCellKey(key)) {
            tier = 2;
        } else if (!isLive) {
            tier = 3;
        } else {
            // Entry-count pressure only (`!overBytes`): keep live sheets last so
            // cold entries always absorb count-only trims first.
            tier = 4;
        }
        candidates.push({ key, entry, tier, lastUsed, bytes: entry.bytes || 0, isLive, evictableSheet });
    }
    candidates.sort((a, b) => (
        (a.tier - b.tier)
        || (a.lastUsed - b.lastUsed)
        || (b.bytes - a.bytes)
    ));
    return candidates;
}

/**
 * Per-renderer texture cache bookkeeping:
 * - ref-counted texture backings shared by identical immutable (or same-revision
 *   mutable) sources across keys, charging bytes once per unique GPU texture;
 * - O(1) per-family upload/eviction/reuse/same-frame-reupload diagnostics;
 * - bounded history of previously-evicted keys for repeat-eviction tracking.
 */
export class GpuTextureCacheState {
    constructor() {
        this.families = new Map();
        this.immutableBackings = new WeakMap();
        this.versionedBackings = new WeakMap();
        this.backings = new Set();
        this.uniqueBackings = 0;
        this.aliasedKeys = 0;
        this.savedAliasBytes = 0;
        this.sourceReuses = 0;
        this.sameFrameReuploads = 0;
        this.repeatEvictions = 0;
        this.liveEvictions = 0;
        this._evictedKeys = new Set();
        this._uploadFrame = -1;
        this._uploadedThisFrame = new Set();
    }

    _family(family) {
        let stats = this.families.get(family);
        if (!stats) {
            stats = emptyFamilyStats();
            this.families.set(family, stats);
        }
        return stats;
    }

    _beginUploadFrame(frameIndex) {
        if (frameIndex !== this._uploadFrame) {
            this._uploadFrame = frameIndex;
            this._uploadedThisFrame.clear();
        }
    }

    _recordEvictedKey(key) {
        const repeat = this._evictedKeys.has(key);
        if (repeat) {
            // Refresh LRU recency.
            this._evictedKeys.delete(key);
        } else if (this._evictedKeys.size >= MAX_EVICTED_KEY_HISTORY) {
            const oldest = this._evictedKeys.values().next().value;
            this._evictedKeys.delete(oldest);
        }
        this._evictedKeys.add(key);
        return repeat;
    }

    /**
     * Find an existing live backing for an identical immutable source (or
     * identical `(source, revision)` mutable source when `revision != null`).
     */
    findReusableBacking(source, { width, height, format = 'rgba8', revision = null, src = '' } = {}) {
        if (!source || typeof source !== 'object' || format !== 'rgba8') return null;
        if (isImmutableTextureSource(source)) {
            const backing = this.immutableBackings.get(source);
            if (backing && backing.refCount > 0 && !backing.invalidated
                && backing.format === format && backing.width === width && backing.height === height
                && backing.src === src) {
                return backing;
            }
            return null;
        }
        if (revision != null) {
            const backing = this.versionedBackings.get(source);
            if (backing && backing.refCount > 0 && !backing.invalidated
                && backing.format === format && backing.width === width && backing.height === height
                && backing.revision === revision) {
                return backing;
            }
        }
        return null;
    }

    /**
     * Create and register a new GPU texture backing owned initially by `key`.
     * Returns the backing; caller adds `backing.bytes` to `_cachedTextureBytes`.
     */
    createBacking({
        key, texture, view = null, width, height, format = 'rgba8', bytes,
        source = null, src = '', revision = null,
    }) {
        const family = textureCacheFamily(key);
        const immutable = isImmutableTextureSource(source);
        const backing = {
            texture,
            view,
            width,
            height,
            format,
            bytes,
            source,
            src,
            revision,
            immutable,
            invalidated: false,
            refCount: 0,
            lastUsedFrame: -1,
            ownerFamily: family,
            keys: new Set(),
        };
        this.backings.add(backing);
        this.uniqueBackings++;
        this._family(family).residentBytes += bytes;
        this._indexBacking(backing);
        return backing;
    }

    markUsed(entry, frameIndex) {
        if (!entry) return;
        entry.lastUsedFrame = frameIndex;
        if (entry.backing && frameIndex > entry.backing.lastUsedFrame) {
            entry.backing.lastUsedFrame = frameIndex;
        }
    }

    isBackingUsedInFrame(entry, frameIndex) {
        if (!entry) return false;
        return entry.lastUsedFrame === frameIndex || entry.backing?.lastUsedFrame === frameIndex;
    }

    _indexBacking(backing) {
        if (!backing || backing.invalidated || backing.format !== 'rgba8' || !backing.source || typeof backing.source !== 'object') {
            return;
        }
        if (backing.immutable) {
            this.immutableBackings.set(backing.source, backing);
        } else if (backing.revision != null) {
            this.versionedBackings.set(backing.source, backing);
        }
    }

    _unindexBacking(backing) {
        if (!backing || !backing.source || typeof backing.source !== 'object') return;
        if (this.immutableBackings.get(backing.source) === backing) {
            this.immutableBackings.delete(backing.source);
        }
        if (this.versionedBackings.get(backing.source) === backing) {
            this.versionedBackings.delete(backing.source);
        }
    }

    /**
     * Attach `entry` (stored under `key`) to `backing`. Increments refCount,
     * resident key count (if new), alias savings, and optionally records a
     * source reuse hit.
     */
    attachEntry(key, entry, backing, { reused = false } = {}) {
        const family = textureCacheFamily(key);
        const fStats = this._family(family);
        if (!entry._trackedFamily) {
            entry._trackedFamily = family;
            fStats.residentCount++;
        }
        if (entry.backing === backing) return;
        const wasAliased = backing.refCount > 0;
        backing.refCount++;
        backing.keys.add(key);
        entry.backing = backing;
        entry.texture = backing.texture;
        if ('view' in backing) entry.view = backing.view;
        entry.width = backing.width;
        entry.height = backing.height;
        entry.format = backing.format;
        entry.bytes = backing.bytes;
        if (wasAliased) {
            this.aliasedKeys++;
            this.savedAliasBytes += backing.bytes;
        }
        if (reused) {
            this.sourceReuses++;
            fStats.sourceReuses++;
        }
    }

    /**
     * Update an exclusively-owned backing (`refCount === 1`) in place after a
     * resize/re-upload/source change. Returns the delta in cached backing bytes.
     */
    updateExclusiveBacking(backing, {
        texture = backing.texture,
        view = backing.view,
        width = backing.width,
        height = backing.height,
        format = backing.format,
        bytes = backing.bytes,
        source = backing.source,
        src = backing.src,
        revision = backing.revision,
    }) {
        this._unindexBacking(backing);
        const delta = bytes - (backing.bytes || 0);
        if (delta !== 0) this._family(backing.ownerFamily).residentBytes += delta;
        backing.texture = texture;
        backing.view = view;
        backing.width = width;
        backing.height = height;
        backing.format = format;
        backing.bytes = bytes;
        backing.source = source;
        backing.src = src;
        backing.revision = revision;
        backing.immutable = isImmutableTextureSource(source);
        backing.invalidated = false;
        this._indexBacking(backing);
        return delta;
    }

    /**
     * Detach `entry` from its backing. If `removeEntry` is true, also decrements
     * the family's resident key count. Returns `{ freedBytes, destroyedTexture }`
     * where `freedBytes > 0` iff this detach dropped `refCount` to 0.
     */
    detachEntry(key, entry, { removeEntry = false, invalidateBacking = false } = {}) {
        const family = entry?._trackedFamily || textureCacheFamily(key);
        if (removeEntry && entry?._trackedFamily) {
            const fStats = this._family(family);
            fStats.residentCount = Math.max(0, fStats.residentCount - 1);
            entry._trackedFamily = null;
        }
        const backing = entry?.backing || null;
        if (!backing) {
            // Bare-prototype test entries have no backing wrapper.
            return { freedBytes: removeEntry ? (entry?.bytes || 0) : 0, destroyedTexture: removeEntry ? (entry?.texture || null) : null };
        }
        if (invalidateBacking) {
            backing.invalidated = true;
            this._unindexBacking(backing);
        }
        backing.keys.delete(key);
        entry.backing = null;
        const wasAliased = backing.refCount > 1;
        backing.refCount = Math.max(0, backing.refCount - 1);
        if (wasAliased) {
            this.aliasedKeys = Math.max(0, this.aliasedKeys - 1);
            this.savedAliasBytes = Math.max(0, this.savedAliasBytes - backing.bytes);
            // If the owner family no longer holds any key on this backing, transfer
            // residentBytes attribution to a remaining key's family.
            if (backing.ownerFamily === family && backing.keys.size > 0) {
                let ownerStillPresent = false;
                for (const otherKey of backing.keys) {
                    if (textureCacheFamily(otherKey) === backing.ownerFamily) {
                        ownerStillPresent = true;
                        break;
                    }
                }
                if (!ownerStillPresent) {
                    const nextKey = backing.keys.values().next().value;
                    const nextFamily = textureCacheFamily(nextKey);
                    const oldOwner = this._family(backing.ownerFamily);
                    oldOwner.residentBytes = Math.max(0, oldOwner.residentBytes - backing.bytes);
                    backing.ownerFamily = nextFamily;
                    this._family(nextFamily).residentBytes += backing.bytes;
                }
            }
            return { freedBytes: 0, destroyedTexture: null };
        }
        this._unindexBacking(backing);
        this.backings.delete(backing);
        this.uniqueBackings = Math.max(0, this.uniqueBackings - 1);
        const owner = this._family(backing.ownerFamily);
        owner.residentBytes = Math.max(0, owner.residentBytes - backing.bytes);
        return { freedBytes: backing.bytes, destroyedTexture: backing.texture };
    }

    /**
     * Mark a mutable entry's backing non-reusable (e.g. occluder gate reopen
     * where an unversioned canvas may have changed while skipped).
     */
    invalidateEntrySource(entry) {
        if (!entry) return;
        entry.source = null;
        entry.src = '';
        if (entry.backing && !entry.backing.immutable) {
            entry.backing.invalidated = true;
            this._unindexBacking(entry.backing);
        }
    }

    recordUpload(key, bytes, ms, frameIndex) {
        this._beginUploadFrame(frameIndex);
        const family = textureCacheFamily(key);
        const fStats = this._family(family);
        fStats.uploads++;
        fStats.uploadBytes += bytes;
        fStats.uploadMs += ms;
        const sameFrame = this._uploadedThisFrame.has(key);
        if (sameFrame) {
            fStats.sameFrameReuploads++;
            this.sameFrameReuploads++;
        } else {
            this._uploadedThisFrame.add(key);
        }
        return sameFrame;
    }

    recordPageFlush(uploadCount, bytes, ms, sameFrameReuploads = 0) {
        if (!uploadCount && !bytes) return;
        const fStats = this._family('albedo-page');
        fStats.uploads += uploadCount;
        fStats.uploadBytes += bytes;
        fStats.uploadMs += ms;
        if (sameFrameReuploads > 0) {
            fStats.sameFrameReuploads += sameFrameReuploads;
            this.sameFrameReuploads += sameFrameReuploads;
        }
    }

    recordEviction(key, freedBytes, { isLive = false } = {}) {
        const family = textureCacheFamily(key);
        const fStats = this._family(family);
        fStats.evictions++;
        fStats.evictedBytes += freedBytes;
        if (isLive) {
            fStats.liveEvictions++;
            this.liveEvictions++;
        }
        if (this._recordEvictedKey(key)) {
            fStats.repeatEvictions++;
            this.repeatEvictions++;
        }
    }

    clearResident() {
        this.immutableBackings = new WeakMap();
        this.versionedBackings = new WeakMap();
        this.backings.clear();
        this.uniqueBackings = 0;
        this.aliasedKeys = 0;
        this.savedAliasBytes = 0;
        this._uploadedThisFrame.clear();
        for (const stats of this.families.values()) {
            stats.residentCount = 0;
            stats.residentBytes = 0;
        }
    }

    getDiagnostics({ cachedKeys = 0, cachedBytes = 0, pageDiagnostics = null } = {}) {
        const families = {};
        const topEvictedFamilies = [];
        for (const [name, stats] of this.families) {
            const entry = {
                uploads: stats.uploads,
                uploadBytes: stats.uploadBytes,
                uploadMs: Number(stats.uploadMs.toFixed(2)),
                evictions: stats.evictions,
                evictedBytes: stats.evictedBytes,
                liveEvictions: stats.liveEvictions,
                repeatEvictions: stats.repeatEvictions,
                sameFrameReuploads: stats.sameFrameReuploads,
                sourceReuses: stats.sourceReuses,
                residentCount: stats.residentCount,
                residentBytes: stats.residentBytes,
            };
            families[name] = entry;
            if (stats.evictions > 0 || stats.repeatEvictions > 0) {
                topEvictedFamilies.push({
                    family: name,
                    evictions: stats.evictions,
                    repeatEvictions: stats.repeatEvictions,
                    liveEvictions: stats.liveEvictions,
                    evictedBytes: stats.evictedBytes,
                });
            }
        }
        topEvictedFamilies.sort((a, b) => (
            (b.repeatEvictions - a.repeatEvictions)
            || (b.evictions - a.evictions)
            || (b.evictedBytes - a.evictedBytes)
        ));
        return {
            cachedKeys,
            uniqueBackings: this.uniqueBackings,
            aliasedKeys: this.aliasedKeys,
            cachedBytes,
            savedAliasBytes: this.savedAliasBytes,
            sourceReuses: this.sourceReuses,
            sameFrameReuploads: this.sameFrameReuploads,
            repeatEvictions: this.repeatEvictions,
            liveEvictions: this.liveEvictions,
            topEvictedFamilies,
            families,
            pageOccupancy: pageDiagnostics ? {
                layers: pageDiagnostics.layers,
                bytes: pageDiagnostics.bytes,
                entries: pageDiagnostics.entries,
                liveEntries: pageDiagnostics.liveEntries,
                staleEntries: pageDiagnostics.staleEntries ?? Math.max(0, (pageDiagnostics.entries || 0) - (pageDiagnostics.liveEntries || 0)),
                fill: pageDiagnostics.fill,
                occupancy: pageDiagnostics.occupancy ?? pageDiagnostics.fill,
                staleShare: pageDiagnostics.staleShare ?? 0,
                usedArea: pageDiagnostics.usedArea ?? 0,
                liveArea: pageDiagnostics.liveArea ?? 0,
                staleArea: pageDiagnostics.staleArea ?? 0,
                capacityArea: pageDiagnostics.capacityArea ?? 0,
                overflowRecords: pageDiagnostics.overflowRecords,
                overflowUniqueKeys: pageDiagnostics.overflowUniqueKeys ?? 0,
                overflowArea: pageDiagnostics.overflowArea ?? 0,
                recycledSlots: pageDiagnostics.recycledSlots ?? 0,
                repacks: pageDiagnostics.repacks,
                sameFrameReuploads: pageDiagnostics.sameFrameReuploads ?? 0,
                uploads: pageDiagnostics.uploads,
                uploadBytes: pageDiagnostics.uploadBytes,
                uploadMs: pageDiagnostics.uploadMs ?? 0,
            } : null,
        };
    }
}
