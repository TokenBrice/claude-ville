import { MonumentPlanter, MonumentRules } from '../../application/MonumentRules.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { RepoStones } from './RepoStones.js';
import { collectCommitEvents } from './ChronicleEvents.js';
import { tileToWorld } from './Projection.js';
import {
    ALPHA_QUANTA,
    GOLD,
    GOLD_RAMP,
    PEAK,
    claimMajorMoment,
    createCueGate,
    CROWN_OVERHANG,
    crown,
    crownSeal,
    cueGatedAge,
    defineMoment,
    drawMomentThread,
    momentPhase,
    quantStep,
    queueMomentEdgePlate,
    releaseMajorMoment,
    resolveMomentAnchor,
    successGrammarDeferred,
} from './EffectStamps.js';
import { scheduleAccent } from '../shared/audio/CueScore.js';
import { WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { LABEL_INK, measureLabelText, snapScreenOrigin } from './WorldLabelKit.js';
import { materialClassId } from './MaterialRegistry.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const KIND_COLORS = {
    release: '#80e8ff',
    feature: '#f2bc5e',
    fix: '#8fd48e',
    performance: '#d5a6ff',
    verified: '#f7f0a3',
    docs: '#a9c4e6',
    test: '#c6dc86',
    upkeep: '#b49f80',
    merge: '#e8dcb8',
};

// Every Chronicle stone grades and takes light as masonry on the resident path.
const STONE_MATERIAL = materialClassId('stone');
// A reused record per stone; past this many ids the map starts over.
const MAX_GPU_RECORDS = 128;

// 6.4 / 8.2 — the release crown: one Major moment over the release's own
// sloop, only for a planted release record (MonumentRules plants only
// verified releases). The sloop (HarborTraffic) hoists a gold pennant in
// three held steps through the anticipation and takes the one cream frame on
// its sail outline at the peak (with a cream crown just above the pennant
// staff); 8 gold spokes grow in three held steps as it casts off, the core
// opens and the figure dissolves on a Bayer order in the falloff, then a
// small static seal rides out over the masthead for 6 s. One at a time;
// further releases fold into its count. A verified failure on screen defers
// it.
const RELEASE_CROWN = defineMoment('major', { anticipation: 200, peak: 80, follow: 1200, residue: 6000 });
const CROWN_GROW_MS = 300;
const CROWN_RADIUS = 12;
const CROWN_DEFER_MAX_MS = 30000;
const CROWN_MAJOR_ID = 'release-crown';
// V8 — the largest frame around its seat, in world texels: the grown crown's
// jewels and ink (CROWN_RADIUS + CROWN_OVERHANG), the residue seal (±7); the
// frame's bottom stands CROWN_MAST_GAP texels above the top of the sloop's
// pennant staff, so the crown sits on the masthead with no stem.
const CROWN_REACH = CROWN_RADIUS + CROWN_OVERHANG;
const CROWN_EXTENT = Object.freeze({ left: -CROWN_REACH, top: -CROWN_REACH, right: CROWN_REACH, bottom: CROWN_REACH });
const SEAL_EXTENT = Object.freeze({ left: -7, top: -7, right: 7, bottom: 7 });
const CROWN_MAST_GAP = 2;
// 8.3 — the peal's first note is declared this long after the predicted
// cream frame (one 60 Hz frame), so the gate holds the peak onto it.
const CROWN_ACCENT_LATE_MS = 17;
// The crown's 1-texel ink rim (the world labels' plate ink).
const CROWN_INK = LABEL_INK.plateOutline;
// M16 — the day pennant's answer is re-derived at most this often.
const DAY_PENNANT_REFRESH_MS = 500;
// Mirrored from HarborTraffic.js HARBOR_SQUAD_ANCHORAGES[1] "Inner Quay Basin"
// — kept here so this module stays self-contained without exporting harbor
// internals.
const INNER_QUAY_BASIN_TILE = { tileX: 35.15, tileY: 22.55 };

const MAX_PLANTER_SEEN = 4096;
const MAX_COMMIT_SEEN = 4096;
const MAX_CHRISTENED_REPOS = 512;
const CHRISTENED_REPOS_META_KEY = 'harbor.christenedRepos';

const MILESTONE_DURATIONS_MS = {
    maiden: 6000,
    ribbon: 8000,
    flagship: 12000,
    aurora: 10000,
};

function toWorld(tileX, tileY) {
    return tileToWorld(tileX, tileY);
}

function projectName(project) {
    const parts = String(project || 'unknown').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

function commitIdentity(event) {
    return String(
        event?.sha
        || event?.sourceId
        || event?.commandHash
        || event?.id
        || `${event?.project || 'unknown'}:${event?.timestamp || event?.ts || ''}`,
    );
}

function commitTimestamp(event, fallback) {
    const raw = event?.timestamp ?? event?.ts ?? event?.time ?? event?.completedAt;
    if (Number.isFinite(Number(raw))) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function reducedMotionPreferred() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
        return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
        return false;
    }
}

export class ChronicleMonuments {
    constructor({
        store = null,
        rules = new MonumentRules(),
        eventTarget = eventBus,
        chronicleStore = null,
        auroraGate = null,
        assets = null,
        harbor = null,
    } = {}) {
        this.store = store;
        this.rules = rules;
        this.eventBus = eventTarget;
        this.records = new Map();
        this.planter = new MonumentPlanter({ store, rules, eventTarget });
        this._loaded = false;
        this._pendingHydrate = null;
        // Optional AssetManager for the repo stones, wired by the renderer.
        this.assets = assets;
        // 8.2 — the HarborTraffic whose release sloop the crown rides (wired by
        // the renderer); without it no crown is staged.
        this.harbor = harbor;
        this._dayPennant = { at: -Infinity, up: false };
        // ChronicleStore is used for lifetime commit-count milestones. It may
        // be the same instance as `store`, but kept as a separate slot so tests
        // can inject a stub.
        this.chronicleStore = chronicleStore || store;
        // AuroraGate is optional. When passed, the 1000th-commit milestone calls
        // `forceTrigger('milestone-1000')` to bypass the daily cap. When absent
        // (current IsometricRenderer wiring), the aurora is omitted but the
        // banner still appears.
        this.auroraGate = auroraGate;
        this._seenCommitIds = new Set();
        // 6.4 — the one release crown (queued, playing, or holding its residue).
        this._crown = null;
        this._activeBanners = [];
        this._pendingMilestones = [];
        // #18 — christening: HarborTraffic fires `harbor:repo-christened` the
        // first time a repo earns a Home-Waters anchorage. Raise a maiden banner
        // over its buoy. Christened repos persist in the Chronicle store (S-L2),
        // so a reload never christens a repo twice; emits that arrive before
        // that set loads wait for it.
        this._christenedRepos = new Set();
        this._christeningsLoaded = !store?.getMeta;
        this._pendingChristenings = [];
        this._onRepoChristened = (event) => this._christenRepo(event);
        this._unsubscribeRepoChristened = this.eventBus?.on?.('harbor:repo-christened', this._onRepoChristened) || null;
        this._disposed = false;
        this._lifecycleGeneration = 0;
        // W7.7 — repo standing stones on the Harbor quay slots.
        this.repoStones = new RepoStones({ assets });
        // Repo stones on the resident GPU path: the drawables carry
        // `buildGpuRecord` (the DrawablePass seam), answered from the same
        // baked images the Canvas draw blits; one reused record per stone.
        this._gpuRecords = new Map();
        this._buildGpuRecord = (context, drawable) => this._gpuRecordFor(drawable, context);
    }

    async hydrate(now = Date.now()) {
        if (this._disposed || !this.store || this._loaded) return;
        if (this._pendingHydrate) return this._pendingHydrate;
        const generation = this._lifecycleGeneration;
        this._loadChristenings(generation);
        this._pendingHydrate = this.store.queryRange('monuments', 'plantedAt', now - MONTH_MS, now + MONTH_MS)
            .then((records) => {
                if (this._disposed || generation !== this._lifecycleGeneration) return;
                for (const record of records || []) this.records.set(record.id, record);
                this._loaded = true;
            })
            .catch(() => {
                if (this._disposed || generation !== this._lifecycleGeneration) return;
                this._loaded = true;
            });
        return this._pendingHydrate;
    }

    async update(agents, context = {}, now = Date.now()) {
        if (this._disposed) return [];
        const generation = this._lifecycleGeneration;
        await this.hydrate(now);
        if (this._disposed || generation !== this._lifecycleGeneration) return [];
        const gitEvents = collectCommitEvents(agents);
        const pushEvents = this._collectPushEvents(agents);
        const sourceEvents = [...gitEvents, ...pushEvents].slice(-MAX_PLANTER_SEEN);
        // 8.2 / M16 — a planted release's bunting pennant waits for its crown
        // (`_endReleaseCrown` reveals it), like the day pennant. The crown is
        // scheduled at the plant itself, in the task that emits the milestone
        // its peal answers (8.3: the cream frame declares its time first).
        const planted = await this.planter.processEvents(sourceEvents, {
            ...context,
            now,
            monuments: [...this.records.values()],
            holdReleases: true,
            isActive: () => !this._disposed && generation === this._lifecycleGeneration,
            onPlanted: (record, event) => {
                // The releasing agent, for the residue thread (V8).
                if (record.kind === 'release') this._scheduleReleaseCrown(record, Date.now(), event?.agentId ?? null);
            },
        });
        if (this._disposed || generation !== this._lifecycleGeneration) return [];
        if (this.planter?.seen?.size > MAX_PLANTER_SEEN) {
            this.planter.seen = new Set([...this.planter.seen].slice(-MAX_PLANTER_SEEN));
        }
        for (const record of planted) this.records.set(record.id, record);
        await this._processCommitMilestones(gitEvents, now, generation);
        if (this._disposed || generation !== this._lifecycleGeneration) return [];
        await this.repoStones?.refresh(this.harbor, this.chronicleStore, now);
        if (this._disposed || generation !== this._lifecycleGeneration) return [];
        this._dropExpired(now);
        this._dropExpiredOverlays(now);
        return planted;
    }

    getDiagnostics() {
        return {
            records: this.records.size,
            seenCommitIds: this._seenCommitIds.size,
            planterSeen: this.planter?.seen?.size || 0,
            christenedRepos: this._christenedRepos.size,
            releaseCrown: this._crown
                ? { count: this._crown.count, started: this._crown.startedAt != null, phase: this._crown.stage?.phase ?? null }
                : null,
            activeBanners: this._activeBanners.length,
            disposed: this._disposed,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._lifecycleGeneration++;
        if (typeof this._unsubscribeRepoChristened === 'function') {
            this._unsubscribeRepoChristened();
        } else {
            this.eventBus?.off?.('harbor:repo-christened', this._onRepoChristened);
        }
        this._unsubscribeRepoChristened = null;
        this._onRepoChristened = null;
        this.records.clear();
        this._seenCommitIds.clear();
        this.planter?.seen?.clear?.();
        this.planter?.dressing?.reveal?.();
        this._christenedRepos.clear();
        this._pendingChristenings.length = 0;
        if (this._crown?.startedAt != null) releaseMajorMoment(CROWN_MAJOR_ID);
        this._crown = null;
        this.harbor = null;
        this._activeBanners.length = 0;
        this._pendingMilestones.length = 0;
        this.store = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.assets = null;
        this.repoStones?.dispose();
    }

    enumerateDrawables(_now = Date.now(), camera = null) {
        const drawables = [];
        // Append overlays (milestone banners) — drawn at a sortY above their
        // anchor so they paint on top of nearby stones. The release crown
        // is not a depth drawable: it draws on the upper overlay (drawMoments).
        for (const banner of this._activeBanners) {
            const world = toWorld(banner.tileX, banner.tileY);
            drawables.push({
                kind: 'chronicle-banner',
                sortY: world.y + 1e6,
                payload: { ...banner, worldX: world.x, worldY: world.y },
            });
        }
        if (this.repoStones) {
            for (const drawable of this.repoStones.drawables(camera)) {
                drawable.buildGpuRecord = this._buildGpuRecord;
                drawables.push(drawable);
            }
        }
        return drawables;
    }

    draw(ctx, drawable, zoom = 1, now = Date.now()) {
        const record = drawable?.payload || drawable;
        if (!record) return;
        if (record.kind === 'repo-stone') {
            // The renderer may wire `assets` after construction.
            if (this.repoStones) {
                this.repoStones.assets = this.assets;
                this.repoStones.draw(ctx, record);
            }
            return;
        }
        if (drawable?.kind === 'chronicle-banner' || record.kind === 'chronicle-banner') {
            this._drawBanner(ctx, record, zoom, now);
        }
    }

    // The resident twin of `draw` for the repo stones: one V9 record over the
    // very image the Canvas draw blits, at the same world rect, graded and lit
    // as stone, depth-keyed by GpuSceneBuilder from the drawable's sortY.
    // Milestone banners animate, carry no builder and stay on the Canvas path.
    _gpuRecordFor(drawable, context = {}) {
        const record = drawable?.payload;
        if (record?.kind !== 'repo-stone' || !this.repoStones) return null;
        this.repoStones.assets = this.assets;
        const image = this.repoStones.image(record);
        return image
            ? this._stoneRecord(`chronicle:repo:${record.slot}`, image,
                Math.round(record.worldX - image.ax), Math.round(record.worldY - image.ay),
                record.worldY, 1, context?.sequence ?? 0)
            : null;
    }

    _stoneRecord(id, image, x, y, groundY, alpha, sequence) {
        let record = this._gpuRecords.get(id);
        if (!record) {
            if (this._gpuRecords.size >= MAX_GPU_RECORDS) this._gpuRecords.clear();
            record = { id, stableKey: id, sx: 0, sy: 0, material: STONE_MATERIAL, emissive: 0, sourceKind: 'individual' };
            this._gpuRecords.set(id, record);
        }
        const width = image.canvas.width;
        const height = image.canvas.height;
        record.textureKey = `chronicle:${image.key}`;
        record.source = image.canvas;
        record.textureRevision = image.revision;
        // Stone faces carry no emissive channel.
        record.emissiveSource = null;
        record.sidecarKey = '';
        record.sidecarRevision = null;
        record.sourceWidth = width;
        record.sourceHeight = height;
        record.sw = width;
        record.sh = height;
        record.x = x;
        record.y = y;
        record.width = width;
        record.height = height;
        // V5 — a stone receives light at its own ground line.
        record.footY = Math.round(groundY);
        record.alpha = alpha;
        record.elevation = height > 70 ? 0.58 : 0.34;
        record.occluder = height > 36 ? 0.58 : 0.2;
        // Opaque faces write painter depth (an aged, faded monument cannot:
        // assignGpuRecordV9Fields gates it on alpha 1); stamped per frame.
        record.writesDepth = true;
        record.depthSortY = null;
        record.sequence = sequence;
        return record;
    }

    _scheduleReleaseCrown(record, now, actorId = null) {
        const color = KIND_COLORS[record.kind] || KIND_COLORS.release;
        this.eventBus?.emit?.('harbor:release-burst', {
            project: record.project,
            label: record.label,
            ts: now,
            color,
        });
        // Max one crown: a release landing while one is up folds into it.
        if (this._crown) {
            this._crown.count += 1;
            this._crown.recordIds.push(record.id);
            return;
        }
        this._crown = {
            key: record.id,
            recordIds: [record.id],
            queuedAt: now,
            startedAt: null,
            reduced: false,
            count: 1,
            project: record.project || null,
            label: record.label || null,
            actorId,
            cue: null,
            stage: null,
        };
        this._dayPennant.at = -Infinity;
        // 8.2 — the release's sloop reveals at the Harbor's release slip,
        // bare-masted, and reads the crown's clock before the overlay draws.
        const key = record.id;
        const arrivesInMs = this.harbor?.launchReleaseSail?.({
            key,
            project: record.project,
            label: record.label,
            clock: at => this._sailClock(key, at),
            now,
        });
        // 8.3 — the crown's cream frame is a body-led accent: declared now,
        // in the task that emits the milestone, so the peal's first note is
        // scheduled onto it (the sloop's arrival, then the anticipation; one
        // frame late, so the gate holds the peak rather than chasing a note
        // already struck). Keyed as the peal is (AgentManager voices it from
        // the record's agent). Reduced motion never gates.
        if (Number.isFinite(arrivesInMs) && !reducedMotionPreferred() && !successGrammarDeferred()) {
            scheduleAccent(record.agentId == null ? null : String(record.agentId), performance.now() + arrivesInMs + RELEASE_CROWN.anticipation + CROWN_ACCENT_LATE_MS, 'release');
        }
    }

    // The crown is over (or dropped before it could start): the sloop sails
    // on (bare-masted if it never hoisted), the day pennant may fly and the
    // bunting strings its pennants.
    _endReleaseCrown(now) {
        const state = this._crown;
        if (!state) return;
        this.harbor?.endReleaseSail?.(state.key, now);
        this.planter?.dressing?.reveal?.(state.recordIds);
        this._crown = null;
        this._dayPennant.at = -Infinity;
    }

    // 6.4 / 8.2 — drawn on the upper overlay (both backends) in world space,
    // over the release's own sloop: above its pennant staff, kept in the safe
    // area, off chrome and plaques and clear of any building in front of the
    // ship by V8's resolveMomentAnchor (else up the ship's own column, else an
    // edge plate). Seated just above the masthead's pennant staff (no stem),
    // the cream frame and the gold spokes carry a 1-texel ink rim, so the
    // crown reads as the sloop's own over the Harbor's timber behind it. The
    // crown waits while a verified failure holds success grammar, for the
    // single Major slot and for its sloop to reveal at the slip; a crown that
    // cannot start within 30 s is dropped (the monument and the parade plate
    // still record the release, and the sloop sails bare-masted).
    drawMoments(ctx, _zoom = 1, now = Date.now()) {
        if (!ctx) return;
        const phase = this._crownClock(now);
        const state = this._crown;
        if (!phase || !state) return;
        const mast = this.harbor?.stageReleaseSail?.(state.key, {
            phase: phase.phase,
            step: phase.step,
            reduced: state.reduced,
            now,
        });
        if (!mast) return;
        const residue = phase.phase === 'residue';
        const extent = residue ? SEAL_EXTENT : CROWN_EXTENT;
        // The crown's centre is a texel corner: its middle 2×2 takes the
        // staff's column and the one east of it.
        const anchor = resolveMomentAnchor({ x: mast.x + 1, y: mast.flagTop - CROWN_MAST_GAP - extent.bottom }, {
            actorId: state.actorId,
            depthY: mast.depthY,
            extent,
            id: CROWN_MAJOR_ID,
            kind: 'release',
            tier: 'major',
            phase: phase.phase,
        });
        state.stage = { phase: phase.phase, step: phase.step, mode: anchor.mode, screen: anchor.screen, world: anchor.rect, depthY: anchor.depthY, tiedUp: mast.tiedUp };
        if (anchor.mode === 'edge') {
            // 10.2 — a verified release: its cream peak cell is a role-2 mark.
            queueMomentEdgePlate(anchor, { word: 'RELEASE', color: GOLD, peak: phase.phase === 'peak', peakMark: true, ctx });
            return;
        }
        // The anticipation is the pennant climbing the sloop's mast.
        if (phase.phase === 'anticipation') return;
        const x = Math.round(anchor.x);
        const y = Math.round(anchor.y);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        switch (phase.phase) {
        case 'peak':
            // The one cream frame (with the sloop's sail outline). 10.2 — a
            // verified success: on the resident path its cream is a role-2
            // GPU mark at the mark gain for this frame only.
            crown(ctx, x, y, { radius: 9, ramp: [PEAK, PEAK, PEAK], jewel: PEAK, core: PEAK, outline: CROWN_INK, peakMark: true });
            break;
        case 'follow': {
            const ms = phase.t * RELEASE_CROWN.follow;
            if (ms < CROWN_GROW_MS) {
                const step = quantStep(ms / CROWN_GROW_MS, 3);
                crown(ctx, x, y, { radius: [8, 10, CROWN_RADIUS][step], ramp: GOLD_RAMP, core: PEAK, outline: CROWN_INK });
            } else {
                // Falloff: full strength for its first step, then the core
                // opens and the spokes retreat outward as the figure drops
                // whole texels on a Bayer order.
                const u = (ms - CROWN_GROW_MS) / Math.max(1, RELEASE_CROWN.follow - CROWN_GROW_MS);
                const step = quantStep(u, 3);
                crown(ctx, x, y, {
                    radius: CROWN_RADIUS,
                    inner: [0, 4, 8][step],
                    ramp: GOLD_RAMP,
                    core: step === 0 ? PEAK : null,
                    outline: CROWN_INK,
                    fade: ALPHA_QUANTA[step],
                });
            }
            break;
        }
        case 'residue':
            crownSeal(ctx, x, y, { radius: 5, ramp: GOLD_RAMP });
            // The releasing agent → the seal, while both are in view.
            drawMomentThread(ctx, anchor, { color: GOLD_RAMP[1], targetLift: -7 });
            break;
        default:
            break;
        }
        ctx.restore();
    }

    // The crown's moment clock at `now`, idempotent within a frame (like
    // cueGatedAge): starts a queued crown once success grammar is free, its
    // sloop has faded in at the slip and the Major slot is its, drops one that
    // waited 30 s, ends a finished one. The release sloop (HarborTraffic,
    // before the overlay draws) and the overlay both read it. Returns the
    // momentPhase, or null.
    _crownClock(now) {
        const state = this._crown;
        if (!state) return null;
        if (state.startedAt == null) {
            if (successGrammarDeferred()) {
                if (now - state.queuedAt > CROWN_DEFER_MAX_MS) this._endReleaseCrown(now);
                return null;
            }
            const reduced = reducedMotionPreferred();
            if (this.harbor?.releaseSailArrived?.(state.key, now, { reduced }) === false) return null;
            if (!reduced && !claimMajorMoment(CROWN_MAJOR_ID, RELEASE_CROWN.active)) {
                if (now - state.queuedAt > CROWN_DEFER_MAX_MS) this._endReleaseCrown(now);
                return null;
            }
            state.startedAt = now;
            state.reduced = reduced;
            // 8.3 — the cream frame waits for the peal's first note; the seal
            // for its closing chord.
            state.cue = reduced ? null : createCueGate('release', null);
        }
        // Callers' clocks may trail the start by a millisecond within a frame.
        const age = cueGatedAge(state.cue, Math.max(0, now - state.startedAt), RELEASE_CROWN.anticipation,
            RELEASE_CROWN.anticipation + RELEASE_CROWN.peak + RELEASE_CROWN.follow, { reduced: state.reduced });
        const phase = momentPhase(age, RELEASE_CROWN, { reduced: state.reduced });
        if (phase.phase === 'done') {
            releaseMajorMoment(CROWN_MAJOR_ID);
            this._endReleaseCrown(now);
            return null;
        }
        return phase;
    }

    // The release sloop's view of the crown clock (HarborTraffic).
    _sailClock(key, now) {
        const phase = this._crownClock(now);
        const state = this._crown;
        return phase && state?.key === key ? { phase: phase.phase, step: phase.step, reduced: state.reduced } : null;
    }

    // 8.2 / M16 — a verified release flies one gold pennant on the Harbor for
    // the local day: once its crown is over (the sloop has carried its own
    // pennant out; at once for a release planted earlier today) until local
    // midnight. A static fact from the Chronicle store, never motion;
    // MonumentRules plants release records only for verified releases, so an
    // unverified or failed release flies nothing.
    dayPennantUp(now = Date.now()) {
        const cache = this._dayPennant;
        if (now - cache.at < DAY_PENNANT_REFRESH_MS && now >= cache.at) return cache.up;
        const midnight = new Date(now);
        midnight.setHours(0, 0, 0, 0);
        const since = midnight.getTime();
        const pending = this._crown?.recordIds ?? null;
        let up = false;
        for (const record of this.records.values()) {
            if (record.kind !== 'release' || pending?.includes(record.id)) continue;
            if (Number(record.plantedAt || record.ts || 0) >= since) {
                up = true;
                break;
            }
        }
        cache.at = now;
        cache.up = up;
        return up;
    }

    async _processCommitMilestones(gitEvents, now, generation = this._lifecycleGeneration) {
        if (
            !this.chronicleStore
            || (
                typeof this.chronicleStore.recordCommit !== 'function'
                && typeof this.chronicleStore.recordCommitEvents !== 'function'
            )
        ) return;
        // Group fresh commits by project so a burst of N commits from one repo
        // increments lifetimeCounts N times in order.
        const fresh = [];
        const sourceEvents = (gitEvents || [])
            .filter(event => event?.type === 'commit');
        for (const event of sourceEvents) {
            if (this._disposed || generation !== this._lifecycleGeneration) return;
            const id = commitIdentity(event);
            if (this._seenCommitIds.has(id)) continue;
            this._seenCommitIds.add(id);
            fresh.push(event);
        }
        if (this._seenCommitIds.size > MAX_COMMIT_SEEN) {
            this._seenCommitIds = new Set([...this._seenCommitIds].slice(-MAX_COMMIT_SEEN));
        }
        if (typeof this.chronicleStore.recordCommitEvents === 'function' && fresh.length) {
            const results = await this.chronicleStore.recordCommitEvents(fresh.map(event => ({
                projectId: event.project,
                commitId: commitIdentity(event),
                observedAt: commitTimestamp(event, now),
            })));
            if (this._disposed || generation !== this._lifecycleGeneration) return;
            for (let index = 0; index < fresh.length; index++) {
                const result = results[index];
                if (!result?.recorded) continue;
                const tier = this.rules?.classifyMilestone?.(result.count) ?? null;
                if (tier) this._spawnMilestone(tier, fresh[index], result.count, now);
            }
            return;
        }

        for (const event of fresh) {
            if (this._disposed || generation !== this._lifecycleGeneration) return;
            try {
                const store = this.chronicleStore;
                if (!store) return;
                const result = typeof store.recordCommitEvent === 'function'
                    ? await store.recordCommitEvent(event.project, commitIdentity(event), commitTimestamp(event, now))
                    : { count: await store.recordCommit(event.project, now), recorded: true };
                if (this._disposed || generation !== this._lifecycleGeneration) return;
                if (!result.recorded) continue;
                const tier = this.rules?.classifyMilestone?.(result.count) ?? null;
                if (tier) this._spawnMilestone(tier, event, result.count, now);
            } catch { /* lifetime persistence is best-effort */ }
        }
    }

    _spawnMilestone(tier, event, count, now) {
        const project = String(event.project || 'unknown');
        const repo = projectName(project);
        const duration = MILESTONE_DURATIONS_MS[tier] || 6000;
        const banner = {
            tier,
            project,
            repo,
            count,
            startedAt: now,
            expiresAt: now + duration,
            tileX: INNER_QUAY_BASIN_TILE.tileX,
            tileY: INNER_QUAY_BASIN_TILE.tileY,
            text: this._milestoneText(tier, repo, count),
        };
        if (tier === 'aurora') {
            // 1000th commit: force aurora regardless of daily cap.
            this.auroraGate?.forceTrigger?.('milestone-1000', now);
        }
        this._activeBanners.push(banner);
        // Cap banners to keep overdraw bounded.
        if (this._activeBanners.length > 6) {
            this._activeBanners.splice(0, this._activeBanners.length - 6);
        }
        this.eventBus?.emit?.('chronicle:milestone-banner', banner);
    }

    // #18 — first-sighting christening. Raises a maiden banner over the repo's
    // own buoy (the event carries its anchorage tile), distinct from the
    // commit-count maiden milestone which sits at the inner quay basin.
    _loadChristenings(generation) {
        if (this._christeningsLoaded || this._christeningsLoad) return;
        this._christeningsLoad = Promise.resolve()
            .then(() => this.store.getMeta(CHRISTENED_REPOS_META_KEY, []))
            .catch(() => [])
            .then((saved) => {
                if (this._disposed || generation !== this._lifecycleGeneration) return;
                for (const project of Array.isArray(saved) ? saved : []) this._christenedRepos.add(String(project));
                this._christeningsLoaded = true;
                const pending = this._pendingChristenings.splice(0);
                for (const event of pending) this._christenRepo(event);
            });
    }

    _christenRepo(event = {}) {
        if (this._disposed) return;
        if (!this._christeningsLoaded) {
            if (this._pendingChristenings.length < MAX_CHRISTENED_REPOS) this._pendingChristenings.push(event);
            if (this.store?.getMeta) this._loadChristenings(this._lifecycleGeneration);
            return;
        }
        const project = String(event.project || 'unknown');
        if (this._christenedRepos.has(project)) return;
        this._christenedRepos.add(project);
        if (this._christenedRepos.size > MAX_CHRISTENED_REPOS) {
            this._christenedRepos.delete(this._christenedRepos.values().next().value);
        }
        this.store?.setMeta?.(CHRISTENED_REPOS_META_KEY, [...this._christenedRepos])?.catch?.(() => {});
        const repo = event.repoName || projectName(project);
        const now = Number(event.ts) || Date.now();
        const duration = MILESTONE_DURATIONS_MS.maiden || 6000;
        const tileX = Number.isFinite(Number(event.tileX)) ? Number(event.tileX) : INNER_QUAY_BASIN_TILE.tileX;
        const tileY = Number.isFinite(Number(event.tileY)) ? Number(event.tileY) : INNER_QUAY_BASIN_TILE.tileY;
        const banner = {
            tier: 'maiden',
            project,
            repo,
            startedAt: now,
            expiresAt: now + duration,
            tileX,
            tileY,
            text: `Maiden Voyage - ${repo}`,
        };
        this._activeBanners.push(banner);
        if (this._activeBanners.length > 6) {
            this._activeBanners.splice(0, this._activeBanners.length - 6);
        }
        this.eventBus?.emit?.('chronicle:milestone-banner', banner);
    }

    _milestoneText(tier, repo, count) {
        switch (tier) {
            case 'maiden': return `Maiden Voyage - ${repo}`;
            case 'ribbon': return `${repo} - 10 commits`;
            case 'flagship': return `${repo} - 100 commits`;
            case 'aurora': return `${repo} - 1000 commits`;
            default: return `${repo} - ${count} commits`;
        }
    }

    _drawBanner(ctx, payload, zoom, now) {
        const reduced = reducedMotionPreferred();
        const elapsed = Math.max(0, now - Number(payload.startedAt || now));
        const duration = Math.max(1, Number(payload.expiresAt || now) - Number(payload.startedAt || now));
        const t = Math.min(1, elapsed / duration);
        const fade = reduced ? 1 : Math.min(1, t < 0.15 ? t / 0.15 : (1 - t) / 0.2);
        if (fade <= 0) return;
        const text = payload.text || '';
        const tier = payload.tier || 'maiden';
        const accent = tier === 'aurora'
            ? '#bff0ff'
            : tier === 'flagship'
                ? '#ffd27a'
                : tier === 'ribbon'
                    ? '#ffea9b'
                    : '#e8f6c8';
        // Screen-fixed square plate, 8 px Press Start 2P (5.4): 1 px accent
        // rim, integer geometry, no stroke or blur.
        const z = zoom > 0 ? zoom : 1;
        ctx.save();
        ctx.translate(payload.worldX, payload.worldY);
        ctx.scale(1 / z, 1 / z);
        snapScreenOrigin(ctx);
        ctx.globalAlpha = fade;
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const lift = tier === 'flagship' ? -84 : tier === 'ribbon' ? -56 : -48;
        const bgW = measureLabelText(ctx, text) + 16;
        const bgH = 18;
        const x = -Math.round(bgW / 2);
        const y = lift - bgH;
        ctx.fillStyle = LABEL_INK.plateOutline;
        ctx.fillRect(x - 1, y - 1, bgW + 2, bgH + 2);
        ctx.fillStyle = accent;
        ctx.fillRect(x, y, bgW, bgH);
        ctx.fillStyle = '#100c18';
        ctx.fillRect(x + 1, y + 1, bgW - 2, bgH - 2);
        ctx.fillStyle = accent;
        ctx.fillText(text, x + 8, y + 13);
        if (!reduced && tier === 'ribbon') {
            // Small stepped pennant off the plate's right edge.
            for (let col = 0; col < 12; col++) {
                const half = Math.max(0, 6 - Math.floor(col / 2));
                if (half) ctx.fillRect(x + bgW + col, y + bgH / 2 - half, 1, half * 2);
            }
        }
        ctx.restore();
    }

    _collectPushEvents(agents) {
        const events = [];
        for (const agent of agents || []) {
            const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
            for (const source of sources) {
                for (const event of source) {
                    const type = String(event?.type || event?.kind || '').toLowerCase();
                    // W7.9 — a `gh pr merge` is a pr-merge stone candidate.
                    const prMerge = type === 'pr' && String(event?.action || '').toLowerCase() === 'merge';
                    if (type === 'push' || type === 'tag' || prMerge) {
                        events.push({
                            ...event,
                            ...(prMerge ? { type: 'pr-merge' } : null),
                            project: event.project || agent.project,
                            provider: event.provider || agent.provider,
                            agentId: event.agentId ?? agent.id ?? null,
                        });
                    }
                }
            }
        }
        return events;
    }

    _dropExpired(now) {
        for (const [id, record] of this.records) {
            if (now - Number(record.plantedAt || record.ts || 0) > MONTH_MS) {
                this.records.delete(id);
            }
        }
    }

    _dropExpiredOverlays(now) {
        if (this._activeBanners.length) {
            this._activeBanners = this._activeBanners.filter(b => Number(b.expiresAt || 0) > now);
        }
    }

    /** True while a release crown is queued or playing (the calendar holds its turn). */
    releaseRevealLive() {
        return Boolean(this._crown);
    }
}
