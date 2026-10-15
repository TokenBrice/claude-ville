// U-P3 — the fleet card: click a ship (or a Harbor ledger row) and a pinned
// card opens beside that fleet. It names the lane (`repo · branch`, the
// worktree when the branch lives in one), lists its docked commits (subject,
// SHA-7, relative time, the author or "seen by" agent chip, which selects
// that agent) and says where its push stands (with the server's reason).
//
// `buildFleetCardModel` is pure (node-tested); `HarborFleetCard` is the DOM:
// the shared `cv-frame` chrome, keyboard reachable (focus moves into the
// card, Esc closes it and returns focus), and on the `/m/` profile a bottom
// sheet whose layout lives in mobile.css only.

import { normalizeRepoBranch } from './GitEventIdentity.js';
import { ledgerAge, ledgerFailureText, middleTruncate } from './HarborLedger.js';
import { branchPennonKind, repoDisplayName, repoProfile } from './RepoColor.js';

export const FLEET_CARD_COMMIT_LIMIT = 12;
export const FLEET_CARD_SELECTOR = '.harbor-fleet-card';

// #7 — the card is ordinary page chrome for the keyboard: the World's own
// keys (Tab agent cycling, arrow panning, B, Escape) never act inside it.
export function isInFleetCard(element) {
    return Boolean(element?.closest?.(FLEET_CARD_SELECTOR));
}

const KIND_LABEL = Object.freeze({
    default: 'default branch',
    feature: 'branch',
    worktree: 'worktree branch',
    detached: 'detached HEAD',
});

function shortSha(value) {
    const match = String(value || '').match(/[0-9a-f]{7,40}/i);
    return match ? match[0].slice(0, 7).toLowerCase() : '';
}

// D5 — who made a commit: its git author (and co-authors) when known; the
// agent chip says `by <agent>` when the session ran the commit, `seen by
// <agent>` when it only found the commit in a repo scan.
function commitWho(ship, agentName) {
    const agentId = ship.agentId || '';
    const name = agentId ? agentName(agentId) || ship.agentName || '' : ship.agentName || '';
    const author = ship.author?.name || '';
    const coAuthors = Array.isArray(ship.coAuthors) ? ship.coAuthors : [];
    const scanned = ship.attribution === 'scanned';
    const names = [author, ...coAuthors].filter(Boolean);
    return {
        author: names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] || ''),
        authors: names.join(', '),
        agentId: name ? agentId : '',
        agentLabel: name ? `${scanned ? 'seen by' : 'by'} ${name}` : (scanned ? 'seen in a repo scan' : ''),
    };
}

/**
 * Assembles the card for `query` = `{ project, branch, shipId }` (`branch`
 * null or undefined = the whole repo) from the harbor's ships and push
 * records. `agentName(id)` names a live agent (falsy when gone).
 */
export function buildFleetCardModel({ ships = [], pushEvents = [], overflow = [] } = {}, query = {}, {
    now = Date.now(),
    agentName = () => '',
    limit = FLEET_CARD_COMMIT_LIMIT,
    nameFor = repoDisplayName,
    profileFor = repoProfile,
} = {}) {
    const project = String(query.project || '');
    if (!project) return null;
    const wholeRepo = query.branch == null;
    const branch = wholeRepo ? null : normalizeRepoBranch(query.branch);
    const inLane = item => item?.project === project
        && (wholeRepo || normalizeRepoBranch(item.branch) === branch);
    const docked = [];
    const lanes = new Map();
    for (const ship of ships) {
        if (!ship || ship.status !== 'docked' || ship.prShip || ship.isInbound) continue;
        if (ship.project !== project) continue;
        const laneBranch = normalizeRepoBranch(ship.branch);
        const lane = lanes.get(laneBranch) || { branch: laneBranch, count: 0, worktree: null };
        lane.count += 1;
        if (!lane.worktree && ship.worktree?.isMain === false) lane.worktree = ship.worktree;
        lanes.set(laneBranch, lane);
        if (inLane(ship)) docked.push(ship);
    }
    // Commits the harbor counts but does not keep as ships (overflow).
    let overflowCount = 0;
    for (const entry of overflow) {
        if (inLane(entry)) overflowCount += Math.max(0, Number(entry.count) || 0);
    }
    docked.sort((a, b) => ((b.eventTime || 0) - (a.eventTime || 0)) || String(a.id).localeCompare(String(b.id)));
    const commits = docked.slice(0, Math.max(0, limit)).map((ship) => ({
        id: ship.id,
        sha: shortSha(ship.sha || (ship.shas || [])[0]),
        subject: String(ship.label || '').trim() || 'commit',
        branch: normalizeRepoBranch(ship.branch),
        age: ledgerAge(ship.eventTime, now),
        eventTime: Number(ship.eventTime) || 0,
        status: ship.pushStatus === 'failed' || ship.pushStatus === 'rejected' ? ship.pushStatus : 'unpushed',
        ...commitWho(ship, agentName),
    }));
    const hiddenCommits = overflowCount + Math.max(0, docked.length - commits.length);
    const total = docked.length + overflowCount;

    // The lane's standing push: its newest push record, a failure standing
    // until a later success.
    let push = null;
    for (const record of pushEvents) {
        if (!inLane(record) || record.tagsOnly || record.deleted) continue;
        if (!push || (Number(record.eventTime) || 0) >= (Number(push.eventTime) || 0)) push = record;
    }
    const pushStatus = push?.status || '';
    const failed = pushStatus === 'failed' || pushStatus === 'rejected';
    const oldest = docked.reduce((min, ship) => (ship.eventTime > 0 && (!min || ship.eventTime < min) ? ship.eventTime : min), 0);
    const pushLine = failed
        ? ledgerFailureText({ status: pushStatus, at: push.eventTime, reason: '' }, now)
        : total > 0
            ? `${total} unpushed${oldest ? ` · oldest ${ledgerAge(oldest, now)}` : ''}`
            : (pushStatus === 'success' ? `pushed ${ledgerAge(push.eventTime, now)}` : 'nothing docked');

    const laneInfo = branch != null ? lanes.get(branch) : null;
    const worktree = laneInfo?.worktree || (wholeRepo ? null : docked.find(ship => ship.worktree?.isMain === false)?.worktree) || null;
    const kind = wholeRepo ? 'default' : branchPennonKind(branch, worktree);
    const name = nameFor(project) || 'repo';
    return {
        key: `${project}\x1f${wholeRepo ? '*' : branch}`,
        project,
        repoName: name,
        accent: profileFor(project)?.accent || '',
        branch,
        kind,
        kindLabel: wholeRepo ? `${lanes.size} ${lanes.size === 1 ? 'branch' : 'branches'}` : KIND_LABEL[kind],
        title: wholeRepo ? middleTruncate(name, 28) : `${middleTruncate(name, 22)} · ${branch ? middleTruncate(branch, 26) : 'detached'}`,
        worktree: worktree ? { name: String(worktree.name || ''), path: String(worktree.path || '') } : null,
        lanes: [...lanes.values()]
            .sort((a, b) => (b.count - a.count) || a.branch.localeCompare(b.branch))
            .map(lane => ({ branch: lane.branch, count: lane.count, kind: branchPennonKind(lane.branch, lane.worktree) })),
        commits,
        hiddenCommits,
        total,
        push: {
            status: failed ? pushStatus : (total > 0 ? 'unpushed' : pushStatus || 'none'),
            text: pushLine,
            reason: failed ? String(push.reason || '') : '',
            agentLabel: failed && push.agentId ? (agentName(push.agentId) || push.agentName || '') : '',
            agentId: failed && push.agentId && agentName(push.agentId) ? push.agentId : '',
        },
    };
}

// ─── DOM ────────────────────────────────────────────────────────────────────

function cssEscape(value) {
    const text = String(value);
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(text) : text.replace(/["\\]/g, '\\$&');
}

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
}

export class HarborFleetCard {
    /**
     * `host` is the World's canvas container. `onSelectAgent(id)` selects an
     * agent; `onSelectLane({ project, branch })` re-targets the card.
     */
    constructor({ host, onSelectAgent = () => {}, onSelectLane = () => {}, onClose = () => {} } = {}) {
        this.host = host;
        this.onSelectAgent = onSelectAgent;
        this.onSelectLane = onSelectLane;
        this.onClose = onClose;
        this.el = null;
        this.model = null;
        this.query = null;
        this._returnFocus = null;
        this._onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            this.close({ restoreFocus: true });
        };
    }

    get isOpen() {
        return Boolean(this.el);
    }

    open(model, query, { focus = false } = {}) {
        if (!model || !this.host) return;
        const sameCard = this.el && this.model?.key === model.key;
        this.model = model;
        this.query = query;
        if (!this.el) {
            this.el = node('section', 'harbor-fleet-card cv-frame cv-frame--bg2');
            this.el.setAttribute('role', 'dialog');
            this.el.setAttribute('aria-modal', 'false');
            this.el.tabIndex = -1;
            this.el.addEventListener('keydown', this._onKeyDown);
            // A click inside the card never reaches the World's click handler.
            this.el.addEventListener('pointerdown', event => event.stopPropagation());
            this.el.addEventListener('click', event => event.stopPropagation());
            this.host.append(this.el);
        }
        this._render(model);
        if (focus && !sameCard) {
            this._returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            this.el.focus({ preventScroll: true });
        }
    }

    refresh(model) {
        if (!this.el || !model) return;
        this.model = model;
        this._render(model);
    }

    close({ restoreFocus = false } = {}) {
        if (!this.el) return;
        const hadFocus = this.el.contains(document.activeElement);
        this.el.removeEventListener('keydown', this._onKeyDown);
        this.el.remove();
        this.el = null;
        this.model = null;
        this.query = null;
        if ((restoreFocus || hadFocus) && this._returnFocus?.isConnected) this._returnFocus.focus({ preventScroll: true });
        this._returnFocus = null;
        this.onClose();
    }

    // Anchors the card beside a screen point (the fleet's lead), clamped
    // into the host and clear of `reserved` chrome rects.
    position(point, reserved = []) {
        if (!this.el || !point) return;
        if (document.documentElement.dataset.cvProfile === 'mobile') {
            this.el.style.left = '';
            this.el.style.top = '';
            return;
        }
        const hostRect = this.host.getBoundingClientRect();
        const width = this.el.offsetWidth;
        const height = this.el.offsetHeight;
        let x = point.x + 28;
        if (x + width > hostRect.width - 12) x = point.x - width - 28;
        x = Math.max(12, Math.min(hostRect.width - width - 12, x));
        let y = Math.max(12, Math.min(hostRect.height - height - 12, point.y - height / 2));
        // Reserved rects are in the World frame's space (the host's).
        for (const { left, right, top, bottom } of reserved) {
            if (x < right && x + width > left && y < bottom && y + height > top) {
                y = top - height - 8 >= 12 ? top - height - 8 : Math.min(hostRect.height - height - 12, bottom + 8);
            }
        }
        this.el.style.left = `${Math.round(x)}px`;
        this.el.style.top = `${Math.round(y)}px`;
    }

    _render(model) {
        const el = this.el;
        // #7 — a refresh rebuilds the card's controls; whichever one had
        // focus (by its stable focus key) gets it back, else the card does.
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        const hadFocus = Boolean(active && el.contains(active));
        const focusKey = hadFocus ? active.dataset?.focusKey || '' : '';
        el.style.setProperty('--cv-repo-color', model.accent || 'var(--ink-4)');
        el.setAttribute('aria-label', `Fleet ${model.title}`);
        const head = node('header', 'harbor-fleet-card__head');
        const titleRow = node('div', 'harbor-fleet-card__title-row');
        titleRow.append(node('span', `harbor-fleet-card__pennon harbor-fleet-card__pennon--${model.kind}`));
        const title = node('h2', 'harbor-fleet-card__title', model.title);
        title.title = model.branch ? `${model.project} (${model.branch})` : model.project;
        titleRow.append(title);
        const close = node('button', 'harbor-fleet-card__close', '×');
        close.type = 'button';
        close.dataset.focusKey = 'close';
        close.setAttribute('aria-label', 'Close fleet card');
        close.addEventListener('click', () => this.close({ restoreFocus: true }));
        titleRow.append(close);
        head.append(titleRow);
        const meta = [model.kindLabel, model.worktree ? `worktree ${middleTruncate(model.worktree.name, 24)}` : '']
            .filter(Boolean).join(' · ');
        const metaEl = node('div', 'harbor-fleet-card__meta', meta);
        if (model.worktree?.path) metaEl.title = model.worktree.path;
        head.append(metaEl);

        const push = node('div', `harbor-fleet-card__push harbor-fleet-card__push--${model.push.status}`);
        push.append(node('span', 'harbor-fleet-card__push-text', model.push.text));
        if (model.push.agentLabel) push.append(this._agentChip(model.push.agentId, `by ${model.push.agentLabel}`, 'push-agent'));
        head.append(push);
        if (model.push.reason) head.append(node('div', 'harbor-fleet-card__reason', model.push.reason));

        if (model.lanes.length > 1 || model.branch == null) {
            const lanes = node('div', 'harbor-fleet-card__lanes');
            lanes.setAttribute('role', 'group');
            lanes.setAttribute('aria-label', 'Branches in this fleet');
            const all = node('button', 'harbor-fleet-card__lane', 'all');
            all.type = 'button';
            all.dataset.focusKey = 'lane:*';
            all.setAttribute('aria-pressed', String(model.branch == null));
            all.addEventListener('click', () => this.onSelectLane({ project: model.project, branch: null }));
            lanes.append(all);
            for (const lane of model.lanes) {
                const chip = node('button', `harbor-fleet-card__lane harbor-fleet-card__lane--${lane.kind}`);
                chip.type = 'button';
                chip.append(node('span', 'harbor-fleet-card__lane-name', middleTruncate(lane.branch || 'detached', 18)), node('span', 'harbor-fleet-card__lane-count', lane.count));
                chip.title = lane.branch || 'detached HEAD';
                chip.dataset.focusKey = `lane:${lane.branch}`;
                chip.setAttribute('aria-pressed', String(model.branch === lane.branch));
                chip.addEventListener('click', () => this.onSelectLane({ project: model.project, branch: lane.branch }));
                lanes.append(chip);
            }
            head.append(lanes);
        }

        const list = node('ol', 'harbor-fleet-card__commits');
        list.setAttribute('aria-label', 'Docked commits, newest first');
        for (const commit of model.commits) {
            const item = node('li', `harbor-fleet-card__commit harbor-fleet-card__commit--${commit.status}`);
            const line = node('div', 'harbor-fleet-card__commit-line');
            line.append(node('span', 'harbor-fleet-card__subject', commit.subject));
            line.append(node('span', 'harbor-fleet-card__age', commit.age));
            item.append(line);
            const sub = node('div', 'harbor-fleet-card__commit-sub');
            if (commit.sha) sub.append(node('code', 'harbor-fleet-card__sha', commit.sha));
            if (model.branch == null && commit.branch) sub.append(node('span', 'harbor-fleet-card__branch', middleTruncate(commit.branch, 16)));
            if (commit.author) {
                const author = node('span', 'harbor-fleet-card__author', commit.author);
                author.title = commit.authors;
                sub.append(author);
            }
            if (commit.agentLabel) sub.append(this._agentChip(commit.agentId, commit.agentLabel, `agent:${commit.id}`));
            item.append(sub);
            list.append(item);
        }
        if (!model.commits.length) list.append(node('li', 'harbor-fleet-card__empty', 'No commits docked.'));
        const body = [head, list];
        if (model.hiddenCommits > 0) body.push(node('div', 'harbor-fleet-card__more', `+${model.hiddenCommits} more commits`));
        el.replaceChildren(...body);
        if (hadFocus) {
            const target = focusKey ? el.querySelector(`[data-focus-key="${cssEscape(focusKey)}"]`) : null;
            (target || el).focus({ preventScroll: true });
        }
    }

    _agentChip(agentId, label, focusKey = '') {
        if (!agentId) return node('span', 'harbor-fleet-card__agent harbor-fleet-card__agent--gone', label);
        const chip = node('button', 'harbor-fleet-card__agent', label);
        chip.type = 'button';
        if (focusKey) chip.dataset.focusKey = focusKey;
        chip.title = 'Select this agent';
        chip.addEventListener('click', () => this.onSelectAgent(agentId));
        return chip;
    }
}
