// Persistent per-repo harbor summary panel.
// Reads pending repo summaries from HarborTraffic.getPendingRepoSummaries()
// and renders one row per repo with the canonical repo color swatch.

import { repoProfile } from '../shared/RepoColor.js';

const RELATIVE_TIME_THRESHOLDS = [
    [60_000, 'just now'],
    [60 * 60_000, (ms) => `${Math.floor(ms / 60_000)}m ago`],
    [24 * 60 * 60_000, (ms) => `${Math.floor(ms / (60 * 60_000))}h ago`],
    [7 * 24 * 60 * 60_000, (ms) => `${Math.floor(ms / (24 * 60 * 60_000))}d ago`],
];

function formatRelative(ts, now) {
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const ms = Math.max(0, now - ts);
    for (const [bound, fmt] of RELATIVE_TIME_THRESHOLDS) {
        if (ms < bound) return typeof fmt === 'function' ? fmt(ms) : fmt;
    }
    return `${Math.floor(ms / (7 * 24 * 60 * 60_000))}w ago`;
}

function escape(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
}

export class HarborHud {
    constructor() {
        this.root = document.createElement('div');
        this.root.className = 'content__harbor-hud harbor-hud';
        this.root.setAttribute('aria-label', 'Harbor: pending commits per repo');

        this.titleEl = document.createElement('div');
        this.titleEl.className = 'harbor-hud__title';
        this.titleEl.textContent = 'HARBOR';
        this.root.appendChild(this.titleEl);

        this.listEl = document.createElement('ul');
        this.listEl.className = 'harbor-hud__list';
        this.root.appendChild(this.listEl);

        this.emptyEl = document.createElement('div');
        this.emptyEl.className = 'harbor-hud__empty';
        this.emptyEl.textContent = 'No pending commits';
        this.root.appendChild(this.emptyEl);

        this._lastSignature = '';
    }

    attach(container) {
        if (!container) return;
        container.appendChild(this.root);
    }

    detach() {
        if (this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
        this._lastSignature = '';
    }

    update(pendingRepos = [], now = Date.now()) {
        const list = Array.isArray(pendingRepos) ? pendingRepos : [];
        // Sort: most recently active first.
        const sorted = [...list].sort((a, b) => (b.latestEventTime || 0) - (a.latestEventTime || 0));

        const signature = sorted
            .map(r => {
                const count = Number(r.pendingCommits ?? r.count) || 0;
                return `${r.project || ''}|${count}|${Math.floor((r.latestEventTime || 0) / 1000)}`;
            })
            .join('\n');
        if (signature === this._lastSignature) return;
        this._lastSignature = signature;

        if (sorted.length === 0) {
            this.listEl.innerHTML = '';
            this.listEl.style.display = 'none';
            this.emptyEl.style.display = '';
            return;
        }

        this.emptyEl.style.display = 'none';
        this.listEl.style.display = '';

        let html = '';
        for (const repo of sorted) {
            const profile = repo.profile || repoProfile(repo.project);
            const name = repo.repoName || profile.shortName || profile.name || 'unknown';
            const count = Number(repo.pendingCommits ?? repo.count) || 0;
            const rel = formatRelative(repo.latestEventTime, now);
            html += `<li class="harbor-hud__row" title="${escape(repo.project || '')}">`
                + `<span class="harbor-hud__swatch" style="background:${profile.accent};box-shadow:0 0 6px ${profile.glow}"></span>`
                + `<span class="harbor-hud__name">${escape(name)}</span>`
                + `<span class="harbor-hud__count" style="color:${profile.accent}">${count}</span>`
                + (rel ? `<span class="harbor-hud__time">${escape(rel)}</span>` : '')
                + `</li>`;
        }
        this.listEl.innerHTML = html;
    }
}
