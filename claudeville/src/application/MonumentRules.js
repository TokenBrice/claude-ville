// Chronicle monuments classify repository milestones only. Quota, token,
// usage, and rollover events are deliberately excluded; the Token Mine owns
// token-cap visuals and this module must not create quota stones.

const DISTRICT_BY_TYPE = {
    feat: 'forge',
    fix: 'forge',
    docs: 'archive',
    test: 'taskboard',
    chore: 'taskboard',
    refactor: 'forge',
    perf: 'observatory',
    build: 'taskboard',
    ci: 'taskboard',
    release: 'harbor',
};

function textOf(value) {
    return String(value || '').trim();
}

function conventionalType(message) {
    const match = textOf(message).match(/^([a-z]+)(?:\([^)]+\))?!?:\s+(.+)$/i);
    if (!match) return null;
    return { type: match[1].toLowerCase(), subject: match[2] };
}

function isTokenEvent(event) {
    const type = textOf(event?.type).toLowerCase();
    const kind = textOf(event?.kind).toLowerCase();
    const source = textOf(event?.source).toLowerCase();
    return /token|quota|usage|rollover/.test(`${type} ${kind} ${source}`);
}

export class MonumentRules {
    constructor({ enableVerifiedStones = false } = {}) {
        this.enableVerifiedStones = enableVerifiedStones;
    }

    classify(event) {
        if (!event || isTokenEvent(event)) return null;
        const type = textOf(event.type).toLowerCase();
        if (!['commit', 'push', 'tag', 'pr-merge', 'test-summary'].includes(type)) return null;

        if (type === 'tag' || (type === 'push' && textOf(event.targetRef).includes('/tags/'))) {
            return this._releaseStone(event);
        }
        if (type === 'test-summary') {
            return this.enableVerifiedStones ? this._verifiedStone(event) : null;
        }
        if (type === 'commit' || type === 'pr-merge') {
            return this._featureStone(event);
        }
        return null;
    }

    _releaseStone(event) {
        const ref = textOf(event.targetRef || event.ref || event.tag || 'release');
        return {
            kind: 'release',
            district: 'harbor',
            weight: 3,
            label: ref.replace(/^refs\/tags\//, '') || 'release',
            dedupKey: `release:${ref || event.id || event.commandHash || event.ts}`,
        };
    }

    _featureStone(event) {
        const parsed = conventionalType(event.subject || event.message || event.command || event.label);
        if (!parsed || !DISTRICT_BY_TYPE[parsed.type]) return null;
        return {
            kind: parsed.type === 'fix' ? 'fix' : 'feature',
            district: DISTRICT_BY_TYPE[parsed.type],
            weight: parsed.type === 'feat' ? 2 : 1,
            label: parsed.subject || parsed.type,
            dedupKey: `commit:${event.id || event.commandHash || parsed.type}:${textOf(parsed.subject).slice(0, 80)}`,
        };
    }

    _verifiedStone(event) {
        if (!event.commitId && !event.commitHash && !event.sourceId) return null;
        return {
            kind: 'verified',
            district: 'taskboard',
            weight: 2,
            label: textOf(event.label || event.name || 'verified'),
            dedupKey: `verified:${event.commitId || event.commitHash || event.sourceId}`,
        };
    }

    static foundingLayerReached(monumentsForDistrict = []) {
        return Array.isArray(monumentsForDistrict) && monumentsForDistrict.length >= 7;
    }

    static applyDistrictCap(monumentsForDistrict = [], cap = 6) {
        const list = Array.isArray(monumentsForDistrict) ? [...monumentsForDistrict] : [];
        list.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
        return {
            visible: list.slice(0, cap),
            foundingLayer: list.length > cap,
        };
    }
}
