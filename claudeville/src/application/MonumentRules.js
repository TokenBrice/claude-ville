// Chronicle monuments classify repository milestones only. Quota, token,
// usage, and rollover events are deliberately excluded; the Token Mine owns
// token-cap visuals and this module must not create quota stones.

import { BUILDING_DEFS } from '../config/buildings.js';
import { eventBus } from '../domain/events/DomainEvent.js';
import { verifiedOutcomeFromGitEvent } from '../domain/services/VerifiedOutcome.js';
import { commitSubject } from './ChronicleLog.js';

// W7.9 (SW-P9) — every conventional type a day's work commonly carries plants
// in a district: writing in the Archive, proving and mending at the Task
// board, upkeep (chore/build/ci) at the Harbor. `style:` stays unplanted.
const DISTRICT_BY_TYPE = {
    feat: 'forge',
    fix: 'taskboard',
    refactor: 'forge',
    perf: 'mine',
    docs: 'archive',
    test: 'taskboard',
    chore: 'harbor',
    build: 'harbor',
    ci: 'harbor',
};

const KIND_BY_TYPE = {
    fix: 'fix',
    perf: 'performance',
    docs: 'docs',
    test: 'test',
    chore: 'upkeep',
    build: 'upkeep',
    ci: 'upkeep',
};

// A merged pull request without a conventional title docks at the Harbor.
const PR_MERGE_DEFAULT_DISTRICT = 'harbor';

// D3 — a verified commit whose subject names no conventional type (`golden:`,
// `signals:`, plain prose) still leaves a minor record at the Forge, where
// file mutations are worked. `style:` stays deliberately unplanted.
const UNTYPED_COMMIT_DISTRICT = 'forge';
const UNPLANTED_TYPES = new Set(['style']);

// Upkeep and plain-commit stones stand below every other kind in a district's
// cap and stone ledger, so a run of chores or a burst of untyped commits never
// pushes a feature, a fix or a release out of the newest three.
const LOW_STANDING_KINDS = new Set(['upkeep', 'commit']);

export function monumentStanding(record) {
    return LOW_STANDING_KINDS.has(record?.kind) ? 0 : 1;
}

function recordTs(record) {
    return Number(record?.plantedAt || record?.ts || 0);
}

// Standing first, then newest first: the order of the visible cap and ledger.
export function compareMonumentStanding(a, b) {
    return (monumentStanding(b) - monumentStanding(a)) || (recordTs(b) - recordTs(a));
}

const DISTRICT_ALIASES = {
    code: 'forge',
    task: 'taskboard',
    tasks: 'taskboard',
    lore: 'archive',
    knowledge: 'archive',
    token: 'mine',
    harbor: 'harbor',
};

const DISTRICT_CAP = 6;

const MILESTONE_TIERS = Object.freeze([
    { count: 1000, tier: 'aurora' },
    { count: 100, tier: 'flagship' },
    { count: 10, tier: 'ribbon' },
    { count: 1, tier: 'maiden' },
]);

/** 6.7 — the highest lifetime tier `count` has earned (1 / 10 / 100 / 1000), or null. */
export function lifetimeTierFor(count) {
    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) return null;
    for (const { count: threshold, tier } of MILESTONE_TIERS) {
        if (value >= threshold) return tier;
    }
    return null;
}

// W7.7 — the repo standing stone's sprite for a project's lifetime commit
// count: the 1 / 10 / 100 / 1000 tiers grow cairn → stone → pillar →
// obelisk. Null below one commit (no stone). Only the frame is chosen here.
export const REPO_STONE_SPRITES = Object.freeze({
    maiden: 'prop.repoStone.cairn',
    ribbon: 'prop.repoStone.stone',
    flagship: 'prop.repoStone.pillar',
    aurora: 'prop.repoStone.obelisk',
});

export function repoStoneSpriteFor(count) {
    const tier = lifetimeTierFor(count);
    return tier ? REPO_STONE_SPRITES[tier] : null;
}

// 6.7 — Chronicle dressing (M16): one static manifest layer per building,
// earned by verified lifetime counts and never lost to retention. The Harbor
// strings one bunting pennant per verified release (max 5, the 6.5 pennant
// family); the Forge stands a billet rack from the ribbon tier of verified
// feat/fix commits (more billets at flagship and aurora); the Archive a brass
// lectern from the flagship tier of verified Chronicle records (a gilt book
// at aurora). The frame is the layer's strip frame; null draws nothing.
// D3 — the billet rack counts every verified commit (`commits`), whatever
// its subject's style; a ledger saved before the counter existed seeds it
// from its feat/fix count, so no rack loses a tier it already earned.
export const CHRONICLE_DRESSING_META_KEY = 'chronicleDressing';
export const BUNTING_MAX_PENNANTS = 5;
const DRESSING_ID_LIMIT = 512;
const DRESSING_TIER_FRAMES = Object.freeze({
    'forge.billetRack': Object.freeze({ counter: 'commits', frames: Object.freeze({ ribbon: 0, flagship: 1, aurora: 2 }) }),
    'archive.lectern': Object.freeze({ counter: 'records', frames: Object.freeze({ flagship: 0, aurora: 1 }) }),
});

/**
 * The static strip frame of dressing layer `name` on building `type` for
 * lifetime `counts` `{ release, featFix, commits, records }`, or null (nothing earned,
 * unknown layer, or a frame the strip does not have).
 */
export function chronicleDressingFrame(counts, type, name, frames = Infinity) {
    let frame = null;
    if (type === 'harbor' && name === 'bunting') {
        const releases = Math.min(BUNTING_MAX_PENNANTS, Math.floor(Number(counts?.release) || 0));
        frame = releases > 0 ? releases - 1 : null;
    } else {
        const rule = DRESSING_TIER_FRAMES[`${type}.${name}`];
        const tier = rule ? lifetimeTierFor(counts?.[rule.counter]) : null;
        frame = tier != null && rule.frames[tier] !== undefined ? rule.frames[tier] : null;
    }
    return frame != null && frame < frames ? frame : null;
}

function isFeatFixCommit(event) {
    const parsed = conventionalType(
        event?.subject || event?.message || event?.label || commitMessageFromCommand(event?.command) || event?.command
    );
    return parsed?.type === 'feat' || parsed?.type === 'fix';
}

/**
 * 6.7 — lifetime counters behind the dressing, persisted in the Chronicle
 * store's meta (which retention never prunes), so a record past retention
 * keeps the tier it earned. Only verified outcomes count (a successful push
 * of a release tag, a successful commit; `verifiedOutcomeFromGitEvent`).
 */
export class ChronicleDressingLedger {
    constructor() {
        this.counts = { release: 0, featFix: 0, commits: 0, records: 0 };
        this._ids = [];
        this._idSet = new Set();
        // 8.2 / M16 — counted releases whose crown has not played yet: the
        // bunting withholds their pennants until `reveal` (the crown's end),
        // so no gold fact lands before the crown.
        this._held = new Set();
        this._loaded = false;
        this._loading = null;
    }

    load(store) {
        if (this._loaded) return Promise.resolve();
        if (typeof store?.getMeta !== 'function') {
            this._loaded = true;
            return Promise.resolve();
        }
        if (!this._loading) {
            this._loading = store.getMeta(CHRONICLE_DRESSING_META_KEY, null)
                .then((value) => {
                    for (const key of Object.keys(this.counts)) {
                        const n = Math.floor(Number(value?.[key]));
                        if (Number.isFinite(n) && n > this.counts[key]) this.counts[key] = n;
                    }
                    if (this.counts.featFix > this.counts.commits) this.counts.commits = this.counts.featFix;
                    for (const id of Array.isArray(value?.ids) ? value.ids : []) this._remember(String(id));
                })
                .catch(() => {})
                .finally(() => { this._loaded = true; });
        }
        return this._loading;
    }

    frameFor(type, name, frames) {
        const counts = this._held.size
            ? { ...this.counts, release: Math.max(0, this.counts.release - this._held.size) }
            : this.counts;
        return chronicleDressingFrame(counts, type, name, frames);
    }

    // The crown of these release records is over (no ids: every held one).
    reveal(ids = null) {
        if (ids == null) this._held.clear();
        else for (const id of ids) this._held.delete(String(id));
    }

    _remember(id) {
        if (this._idSet.has(id)) return;
        this._idSet.add(id);
        this._ids.push(id);
        while (this._ids.length > DRESSING_ID_LIMIT) this._idSet.delete(this._ids.shift());
    }

    // Counts a freshly planted record once, if its source event is verified;
    // `hold` withholds a release from the bunting until `reveal`.
    async note(store, record, event, { hold = false } = {}) {
        if (!record?.id || this._idSet.has(record.id) || !verifiedOutcomeFromGitEvent(event)) return false;
        this._remember(record.id);
        this.counts.records += 1;
        if (record.kind === 'release') {
            this.counts.release += 1;
            if (hold) this._held.add(String(record.id));
        } else if (String(event?.type || '').toLowerCase() === 'commit') {
            this.counts.commits += 1;
            if (isFeatFixCommit(event)) this.counts.featFix += 1;
        }
        if (typeof store?.setMeta === 'function') {
            await store.setMeta(CHRONICLE_DRESSING_META_KEY, { ...this.counts, ids: [...this._ids] });
        }
        return true;
    }
}

function textOf(value) {
    return String(value || '').trim();
}

function subjectKeyOf(label) {
    return textOf(label).toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

function conventionalType(message) {
    const match = textOf(message).match(/^([a-z]+)(?:\([^)]+\))?!?:\s+(.+)$/i);
    if (!match) return null;
    return { type: match[1].toLowerCase(), subject: match[2] };
}

function commitMessageFromCommand(command) {
    const text = String(command || '');
    const match = text.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    return textOf(match?.[1] || match?.[2] || match?.[3] || '');
}

// A version-shaped name (`v1.2`, `2.0.1-rc.1`) and a strict semver name
// (`v?MAJOR.MINOR.PATCH[-pre]`).
const VERSION_NAME = /^v?\d+\.\d+/;
const STRICT_SEMVER_NAME = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// The release tag a push names, or ''. A known tag counts when it reads as a
// version: the adapter's `event.tag` (a `git tag <name>` earlier in the same
// command chain, or a refs/tags/ destination), the `git push <remote> tag
// <name>` refspec pair, or a refs/tags/ ref. Otherwise only a bare strict
// semver refspec counts (`git push origin v1.2.0`): a refspec whose source is
// another ref (`HEAD:1.2.3`), a refs/heads/ destination and an inferred
// upstream push (its target is the pushing branch) stay branch pushes, as do
// version-like branch names (`1.2-maint`, `v2.0`).
function targetReleaseRef(event) {
    const specs = Array.isArray(event.refspecs) ? event.refspecs.map(textOf) : [];
    const tagAt = specs.indexOf('tag');
    let name = tagAt >= 0 && specs[tagAt + 1] ? specs[tagAt + 1] : textOf(event.tag);
    if (!name) {
        for (const ref of [event.targetRef, event.ref, ...specs]) {
            const text = textOf(ref).replace(/^\+/, '');
            const dst = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text;
            if (dst.startsWith('refs/tags/')) {
                name = dst.slice('refs/tags/'.length);
                break;
            }
        }
    }
    if (name) return VERSION_NAME.test(name) ? name : '';
    if (event.inferred === true) return '';
    for (const ref of specs.length ? specs : [event.targetRef]) {
        const text = textOf(ref).replace(/^\+/, '');
        const colon = text.lastIndexOf(':');
        const dst = colon >= 0 ? text.slice(colon + 1) : text;
        const src = colon >= 0 ? text.slice(0, colon) : text;
        if (src === dst && STRICT_SEMVER_NAME.test(dst)) return dst;
    }
    return '';
}

function eventTs(event, fallback = Date.now()) {
    const raw = event?.ts ?? event?.timestamp ?? event?.time ?? event?.createdAt ?? event?.completedAt;
    if (Number.isFinite(Number(raw))) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function stableHash(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function projectName(project) {
    const parts = textOf(project).split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

function normalizeDistrict(district) {
    const key = textOf(district).toLowerCase();
    return DISTRICT_ALIASES[key] || key || 'archive';
}

function occupiedBuildingTiles(building) {
    const tiles = new Set();
    for (let dx = 0; dx < (building.width || 1); dx++) {
        for (let dy = 0; dy < (building.height || 1); dy++) {
            tiles.add(`${building.x + dx},${building.y + dy}`);
        }
    }
    for (const ex of building.walkExclusion || []) {
        for (let dx = 0; dx < (ex.width || 1); dx++) {
            for (let dy = 0; dy < (ex.height || 1); dy++) {
                tiles.add(`${building.x + ex.dx + dx},${building.y + ex.dy + dy}`);
            }
        }
    }
    for (const tile of building.visitTiles || []) {
        tiles.add(`${tile.tileX},${tile.tileY}`);
    }
    return tiles;
}

// Short narrative line per monument kind, for detail overlays/tooltips.
const LORE_BY_KIND = {
    feature: (label, repo) => `Raised when "${label}" came to ${repo}.`,
    fix: (label, repo) => `Marks the mending of "${label}" in ${repo}.`,
    performance: (label, repo) => `Honors the quickening of ${repo}: "${label}".`,
    release: (label, repo) => `Commemorates the launch of ${label} from the ${repo} harbor.`,
    docs: (label, repo) => `Shelved when "${label}" was written down for ${repo}.`,
    test: (label, repo) => `Marks the proving of "${label}" in ${repo}.`,
    upkeep: (label, repo) => `Notes the upkeep of ${repo}: "${label}".`,
    merge: (label, repo) => `Marks ${label} brought in to the ${repo} quay.`,
    commit: (label, repo) => `Set down when "${label}" was committed to ${repo}.`,
};

// A finished command that reported failure (an explicit false, a non-zero
// exit, a failed status) plants nothing.
function gitEventFailed(event) {
    if (event?.success === false) return true;
    const exitCode = Number(event?.exitCode ?? event?.exit_code);
    if (Number.isFinite(exitCode) && exitCode !== 0) return true;
    return /^(failed|error|rejected|cancel+ed)$/i.test(textOf(event?.status));
}

// A pull request merge stone needs evidence the merge landed: the call's own
// success (an explicit flag, exit 0, a success status) or a merged or
// verified status. A pending `gh pr merge` reports no outcome yet, and the
// absence of a result is never success, so it plants nothing.
function mergeLanded(event) {
    if (!event || event.dryRun === true || gitEventFailed(event)) return false;
    if (event.success === true) return true;
    const rawExit = event.exitCode ?? event.exit_code;
    if (rawExit !== null && rawExit !== undefined && Number.isFinite(Number(rawExit))) return Number(rawExit) === 0;
    return /^(success|succeeded|completed|landed|merged|verified)$/i.test(textOf(event.status));
}

// `PR #12` from the pull URL the adapter scraped, else a plain noun.
function pullRequestLabel(event) {
    const match = textOf(event?.url).match(/\/pull\/(\d+)\/?$/);
    return match ? `PR #${match[1]}` : 'a pull request';
}

function monumentLore(kind, label, repoName) {
    const template = LORE_BY_KIND[kind];
    return template ? template(textOf(label) || kind, repoName) : '';
}

function isTokenEvent(event) {
    const type = textOf(event?.type).toLowerCase();
    const kind = textOf(event?.kind).toLowerCase();
    const source = textOf(event?.source).toLowerCase();
    return /token|quota|usage|rollover/.test(`${type} ${kind} ${source}`);
}

export class MonumentRules {
    classify(event) {
        if (!event || isTokenEvent(event)) return null;
        const type = textOf(event.type).toLowerCase();
        if (!['commit', 'push', 'tag', 'pr-merge'].includes(type)) return null;

        // 8.2 — a release is a verified push of a release tag: gold (the crown,
        // the sloop, the day pennant, the bunting) is verified success only, so
        // a local tag, an unverified or failed push, a branch push or a tag
        // deletion plants nothing.
        if (type === 'tag' || type === 'push') {
            return type === 'push' && !event.deleted && targetReleaseRef(event) && verifiedOutcomeFromGitEvent(event)
                ? this._releaseStone(event)
                : null;
        }
        if (type === 'commit') {
            return this._featureStone(event);
        }
        if (type === 'pr-merge') {
            return mergeLanded(event) ? this._pullRequestStone(event) : null;
        }
        return null;
    }

    _releaseStone(event) {
        const ref = targetReleaseRef(event);
        const project = textOf(event.project || event.repository || event.repo || 'unknown');
        return {
            kind: 'release',
            district: 'harbor',
            weight: 'major',
            label: ref,
            dedupKey: `release:${project}:${ref}`,
        };
    }

    _featureStone(event) {
        const parsed = conventionalType(
            event.subject || event.message || event.label || commitMessageFromCommand(event.command) || event.command
        );
        const project = textOf(event.project || event.repository || event.repo || 'unknown');
        if (!parsed || !DISTRICT_BY_TYPE[parsed.type]) {
            return parsed && UNPLANTED_TYPES.has(parsed.type) ? null : this._untypedCommitStone(event, project);
        }
        return {
            kind: KIND_BY_TYPE[parsed.type] || 'feature',
            district: DISTRICT_BY_TYPE[parsed.type],
            weight: parsed.type === 'feat' ? 'medium' : 'minor',
            label: parsed.subject || parsed.type,
            dedupKey: `commit:${project}:${event.sha || event.commandHash || event.id || textOf(parsed.subject).slice(0, 80)}`,
        };
    }

    // D3 — only a verified commit: an untyped subject carries no claim of its
    // own, so the commit's observed success is the whole of its evidence.
    _untypedCommitStone(event, project) {
        if (!verifiedOutcomeFromGitEvent(event)) return null;
        const label = textOf(event.subject || event.message) || commitSubject(event) || 'a commit';
        return {
            kind: 'commit',
            district: UNTYPED_COMMIT_DISTRICT,
            weight: 'minor',
            label: label.slice(0, 100),
            dedupKey: `commit:${project}:${event.sha || event.commandHash || event.id || subjectKeyOf(label)}`,
        };
    }

    // W7.9 — a merged pull request stands in its title type's district when
    // the title is conventional, else at the Harbor quay it sailed in to.
    _pullRequestStone(event) {
        const project = textOf(event.project || event.repository || event.repo || 'unknown');
        const parsed = conventionalType(event.subject || event.title || event.label);
        const typed = parsed && DISTRICT_BY_TYPE[parsed.type] ? parsed : null;
        return {
            kind: typed ? (KIND_BY_TYPE[typed.type] || 'feature') : 'merge',
            district: typed ? DISTRICT_BY_TYPE[typed.type] : PR_MERGE_DEFAULT_DISTRICT,
            weight: 'medium',
            label: typed?.subject || pullRequestLabel(event),
            dedupKey: `pr-merge:${project}:${textOf(event.url) || event.commandHash || event.id || event.sha || ''}`,
        };
    }

    classifyMilestone(projectCommitCount) {
        const count = Number(projectCommitCount);
        if (!Number.isFinite(count) || count <= 0) return null;
        for (const { count: threshold, tier } of MILESTONE_TIERS) {
            if (count === threshold) return tier;
        }
        return null;
    }

    buildRecord(event, context = {}, seen = null) {
        const result = this.classify(event);
        if (!result) return null;
        const now = Number(context.now || Date.now());
        const project = textOf(event.project || event.repository || event.repo || context.project || 'unknown');
        const id = stableHash(result.dedupKey);
        if (seen?.has(id)) return null;
        const placement = chooseMonumentPlacement(result.district, {
            seed: result.dedupKey,
            monuments: context.monuments,
            waterTiles: context.waterTiles,
            blockedTiles: context.blockedTiles,
        });
        return {
            id,
            dedupKey: result.dedupKey,
            kind: result.kind,
            district: normalizeDistrict(result.district),
            weight: result.weight,
            label: result.label,
            lore: monumentLore(result.kind, result.label, projectName(project)),
            project,
            repoName: projectName(project),
            plantedAt: eventTs(event, now),
            ts: eventTs(event, now),
            sourceEventId: textOf(event.id || event.sourceId || event.commandHash),
            tileX: placement.tileX,
            tileY: placement.tileY,
        };
    }

    static foundingLayerReached(monumentsForDistrict = []) {
        return Array.isArray(monumentsForDistrict) && monumentsForDistrict.length >= 7;
    }

    static applyDistrictCap(monumentsForDistrict = [], cap = DISTRICT_CAP) {
        const list = Array.isArray(monumentsForDistrict) ? [...monumentsForDistrict] : [];
        list.sort(compareMonumentStanding);
        return {
            visible: list.slice(0, cap),
            foundingLayer: list.length > cap,
        };
    }
}

export function chooseMonumentPlacement(district, options = {}) {
    const normalized = normalizeDistrict(district);
    const building = BUILDING_DEFS.find(def => def.type === normalized)
        || BUILDING_DEFS.find(def => def.district === normalized)
        || BUILDING_DEFS.find(def => def.type === 'archive')
        || BUILDING_DEFS[0];
    const occupied = occupiedBuildingTiles(building);
    const waterTiles = options.waterTiles || new Set();
    const blockedTiles = options.blockedTiles || new Set();
    const monuments = Array.isArray(options.monuments) ? options.monuments : [];
    const seed = parseInt(stableHash(options.seed || normalized), 36) || 0;
    const center = building.entrance || {
        tileX: building.x + Math.floor((building.width || 1) / 2),
        tileY: building.y + (building.height || 1),
    };
    const candidates = [];

    for (let radius = 1; radius <= 7; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                const tileX = Math.max(0, Math.min(39, Math.round(center.tileX + dx)));
                const tileY = Math.max(0, Math.min(39, Math.round(center.tileY + dy)));
                const key = `${tileX},${tileY}`;
                if (occupied.has(key) || waterTiles.has(key) || blockedTiles.has(key)) continue;
                const nearOther = monuments.some(monument => (
                    Math.hypot(Number(monument.tileX) - tileX, Number(monument.tileY) - tileY) < 2
                ));
                if (!nearOther) candidates.push({ tileX, tileY });
            }
        }
        if (candidates.length) break;
    }

    if (!candidates.length) return { tileX: center.tileX, tileY: center.tileY + 1 };
    return candidates[seed % candidates.length];
}

export class MonumentPlanter {
    constructor({ store, rules = new MonumentRules(), eventTarget = eventBus } = {}) {
        this.store = store;
        this.rules = rules;
        this.eventBus = eventTarget;
        this.seen = new Set();
        // 6.7 — the lifetime counters the Chronicle dressing reads.
        this.dressing = new ChronicleDressingLedger();
    }

    async processEvents(events = [], context = {}) {
        if (!this.store) return [];
        await this.dressing.load(this.store);
        const planted = [];
        const isActive = typeof context.isActive === 'function' ? context.isActive : () => true;
        for (const event of events) {
            if (!isActive()) break;
            const record = this.rules.buildRecord(event, context, this.seen);
            if (!record || this.seen.has(record.id)) continue;
            this.seen.add(record.id);
            try {
                const existing = await this.store.get('monuments', record.id);
                if (!isActive()) break;
                if (existing) continue;
                await this.store.put('monuments', record);
                // `holdReleases` (the release crown's owner): the bunting
                // waits for the crown, which reveals the record when it ends.
                await this.dressing.note(this.store, record, event, { hold: context.holdReleases === true });
                if (!isActive()) break;
                planted.push(record);
                // `onPlanted(record, event)` runs in the same task as the
                // milestone emit, before it: a body-led accent (the release
                // crown) declares its draw time before the cue it anchors is
                // scheduled (CueScore `scheduleAccent`).
                context.onPlanted?.(record, event);
                this.eventBus?.emit?.('chronicle:milestone', record);
            } catch {
                // Chronicle writes are best-effort and must not break live rendering.
            }
        }
        return planted;
    }
}
