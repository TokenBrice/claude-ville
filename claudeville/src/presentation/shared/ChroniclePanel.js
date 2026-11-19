import {
    ChronicleEventKind,
    chronicleDateFromKey,
    chronicleDateKey,
    chronicleDateWindow,
    summarizeDay,
} from '../../application/ChronicleLog.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { Appearance } from '../../domain/value-objects/Appearance.js';
import { AvatarCanvas } from '../dashboard-mode/AvatarCanvas.js';
import { buildBookOfLivesViewModel } from './ActivityPanel.js';
import { providerPresentation } from './AgentPresentation.js';
import { el, replaceChildren } from './DomSafe.js';
import { formatCost, formatNumber } from './Formatters.js';

// The day's recap, told the way the village would tell it. Reads the
// ChronicleLog day book and renders a short ledger plus a timeline, so looking
// away for an hour no longer costs you the whole hour.

const KIND_GLYPH = {
    [ChronicleEventKind.ARRIVED]: '→',
    [ChronicleEventKind.DEPARTED]: '←',
    [ChronicleEventKind.COMPLETED]: '✦',
    [ChronicleEventKind.WAITING]: '?',
    [ChronicleEventKind.RESOLVED]: '✓',
    [ChronicleEventKind.ERRORED]: '!',
    [ChronicleEventKind.RATE_LIMITED]: '~',
    [ChronicleEventKind.COMMIT]: '◆',
    [ChronicleEventKind.PUSH]: '▲',
    [ChronicleEventKind.MENDED]: '◇',
};

const REASON_TEXT = {
    question: 'asked a question',
    approval: 'awaited approval',
    plan_review: 'awaited plan review',
};

const TIMELINE_LABELS = Object.freeze({
    arrived: 'arrival',
    departed: 'departure',
    completed: 'completed turn',
    waiting: 'wait',
    resolved: 'resolution',
    errored: 'error',
    'rate limited': 'rate limit',
    commit: 'commit',
    push: 'push',
    mended: 'mend',
});

function humanizeTimelineKind(kind) {
    const normalized = String(kind ?? 'event')
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
    if (/^[a-z]{2}$/i.test(normalized)) return normalized.toUpperCase();
    return normalized || 'event';
}

function pluralizeTimelineLabel(value) {
    const words = value.split(' ');
    const last = words.pop() || 'event';
    let plural = last;
    if (/(s|x|z|ch|sh)$/i.test(last)) {
        plural = `${last}es`;
    } else if (/[^aeiou]y$/i.test(last)) {
        plural = `${last.slice(0, -1)}ies`;
    } else {
        plural = `${last}s`;
    }
    return [...words, plural].join(' ');
}

export const CHRONICLE_TIMELINE_PAGE_SIZE = 100;
export const HALL_OF_LIVES_CHAPTER_LIMIT = 3;

/** XP-2 — the separate window that replays one recorded day. */
export function retoldVillageHref(pathname, dateKey) {
    return `${pathname || '/'}?retold=${encodeURIComponent(dateKey)}`;
}

// A lineage is a durable identity: a named villager or a project lead
// (provider x repo). Session-scoped rows are not lineages.
function hallLineage(identityKey) {
    const match = /^(named|project):([a-z0-9-]+):(.+)$/.exec(identityKey);
    if (!match) return null;
    const [, scope, provider, slugName] = match;
    const name = scope === 'named'
        ? slugName.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
        : slugName;
    return { scope, provider, name };
}

/**
 * XP-8 — the Hall of Lives: every remembered lineage, most recently seen
 * first. A memory, not a leaderboard: rows carry no stats, totals or ranks,
 * and the order is last seen only.
 */
export function buildHallOfLives(records = [], { now = Date.now() } = {}) {
    return (Array.isArray(records) ? records : [])
        .map(record => {
            const identityKey = String(record?.identityKey || '');
            const lineage = hallLineage(identityKey);
            const biography = lineage ? AgentBiography.fromRecord(record) : null;
            if (!biography) return null;
            const book = buildBookOfLivesViewModel(record, { now });
            const providerLabel = providerPresentation(lineage.provider).badge.label;
            return {
                identityKey,
                ...lineage,
                role: lineage.scope === 'named' ? `${providerLabel} villager` : `${providerLabel} project lead`,
                nickname: biography.nickname || '',
                lastSeenAt: book.lastSeenAt,
                firstSeenLabel: book.firstSeenLabel,
                lastSeenLabel: book.lastReturnedLabel,
                chapters: book.visibleChapters.slice(-HALL_OF_LIVES_CHAPTER_LIMIT).reverse(),
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.identityKey.localeCompare(b.identityKey));
}

const CHRONICLE_EXPORT_MIME = {
    markdown: 'text/markdown;charset=utf-8',
    csv: 'text/csv;charset=utf-8',
};

const CHRONICLE_READ_FAILURE_EVENT = 'chronicle:read-failed';
const CHRONICLE_EXPORT_FAILURE_EVENT = 'chronicle:export-failed';

function clockTime(ts) {
    const date = new Date(ts);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function duration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function eventText(event) {
    const who = event.agentName || 'someone';
    const where = event.project ? ` · ${event.project}` : '';
    const detailLabel = event.count !== undefined ? event.eventLabel : event.label;
    switch (event.kind) {
        case ChronicleEventKind.ARRIVED: return `${who} arrived${where}`;
        case ChronicleEventKind.DEPARTED: return `${who} left${where}`;
        case ChronicleEventKind.COMPLETED: return `${who} finished a turn${where}`;
        case ChronicleEventKind.WAITING: {
            const reason = REASON_TEXT[event.reason];
            const tool = event.tool ? ` (${event.tool})` : '';
            return `${who} ${reason || 'waited for you'}${tool}${where}`;
        }
        case ChronicleEventKind.RESOLVED:
            return `${who} was answered after ${duration(event.waitedMs || 0)}${where}`;
        case ChronicleEventKind.ERRORED: return `${who} hit an error${where}`;
        case ChronicleEventKind.RATE_LIMITED: return `${who} hit the rate limit${where}`;
        case ChronicleEventKind.COMMIT: return `${who} committed ${detailLabel || 'a change'}${where}`;
        case ChronicleEventKind.PUSH: {
            if (!event.outcome) return `${who} pushed ${detailLabel || ''}${where}`.trim();
            const what = event.outcome === 'rejected' ? 'was rejected' : event.outcome === 'cancelled' ? 'was cancelled' : 'failed';
            return `${who}'s push ${what}${detailLabel ? ` (${detailLabel})` : ''}${where}`;
        }
        case ChronicleEventKind.MENDED: {
            const was = Number.isFinite(Number(event.failedExit)) && event.failedExit !== null ? ` (was exit ${event.failedExit})` : '';
            return `${who} mended ${detailLabel || 'a failing command'}${was}${where}`;
        }
        default: return `${who} ${event.kind}${where}`;
    }
}

function timelineKind(event) {
    const value = event?.kind ?? event?.type;
    return String(value ?? 'event').trim() || 'event';
}

function timelineKindLabel(kind, count = 1) {
    const normalized = humanizeTimelineKind(kind);
    const singular = TIMELINE_LABELS[normalized.toLowerCase()] || normalized;
    return Number(count) > 1 ? pluralizeTimelineLabel(singular) : singular;
}

function timelineMinute(ts) {
    const value = Number(ts);
    return Number.isFinite(value) ? Math.floor(value / 60_000) : null;
}

/** Fold same-kind events within each minute into deterministic chronological rows. */
export function foldTimeline(events = []) {
    const rows = [];
    // Folding is per minute and kind across the whole minute, not just over
    // adjacent rows: a burst stays one row per kind even when another kind is
    // interleaved. Each folded row keeps the position of its first member, so
    // the timeline order stays chronological and deterministic.
    const folded = new Map();
    for (const event of orderedEvents(events)) {
        if (!event || typeof event !== 'object') continue;
        const kind = timelineKind(event);
        const minute = timelineMinute(event.ts);
        const foldKey = minute === null ? null : `${minute}\u0000${kind}`;
        const previous = foldKey === null ? undefined : folded.get(foldKey);
        if (previous) {
            previous.count++;
            previous.label = timelineKindLabel(kind, previous.count);
            if (previous.project !== event.project) previous.project = null;
            continue;
        }
        const row = {
            ...event,
            kind,
            count: 1,
            label: timelineKindLabel(kind),
        };
        if (event.label !== undefined) row.eventLabel = event.label;
        rows.push(row);
        if (foldKey !== null) folded.set(foldKey, row);
    }
    return rows;
}

// `raw` is the number behind a formatted value; zeros recede to --ink-4.
function ledgerRow(label, value, raw = value) {
    const zero = Number(raw) === 0;
    return el('div', { className: zero ? ['chronicle__stat', 'chronicle__stat--zero'] : 'chronicle__stat' }, [
        el('span', { className: 'chronicle__stat-label' }, label),
        el('span', { className: 'chronicle__stat-value' }, String(value)),
    ]);
}

// One line, fixed shape: `Fri 25 Sep 2026`.
function chronicleDayHeading(date) {
    const part = options => date.toLocaleDateString('en-US', options);
    return `${part({ weekday: 'short' })} ${date.getDate()} ${part({ month: 'short' })} ${date.getFullYear()}`;
}

function openingLine(summary, isToday = true) {
    if (!summary.agents.length) {
        return isToday
            ? 'A quiet day. Nothing has passed through the village yet.'
            : 'No Chronicle entries were recorded on this day.';
    }
    const since = summary.firstTs ? `From ${clockTime(summary.firstTs)}` : (isToday ? 'Today' : 'That day');
    const agents = `${summary.agents.length} ${summary.agents.length === 1 ? 'agent' : 'agents'}`;
    const projects = summary.projects.length
        ? ` across ${summary.projects.length} ${summary.projects.length === 1 ? 'project' : 'projects'}`
        : '';
    return `${since}: ${agents}${projects}.`;
}

function orderedEvents(events) {
    return (Array.isArray(events) ? events : [])
        .map((event, index) => ({ event, index }))
        .sort((a, b) => (Number(a.event?.ts) || 0) - (Number(b.event?.ts) || 0) || a.index - b.index)
        .map(({ event }) => event);
}

function markdownCell(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\t/g, ' ')
        // Encode HTML before escaping Markdown punctuation. Entities render as
        // readable prose but cannot become tags in a permissive previewer.
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\|/g, '\\|')
        // Escaping the whole link/image delimiter prevents both inline and
        // reference-style Markdown destinations from becoming active.
        .replace(/!/g, '\\!')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

function durationOrZero(ms) {
    return Number(ms) > 0 ? duration(ms) : '0m';
}

function summaryRows(summary) {
    return [
        ['Events', summary.totalEvents],
        ['Agents', summary.agents.length],
        ['Projects', summary.projects.length],
        ['Commits', summary.commits],
        ['Pushes', summary.pushes],
        ['Mended', summary.mends || 0],
        ['Turns done', summary.completed],
        ['Waited on you', summary.waits],
        ['Errors', summary.errors],
        ['Rate limits', summary.rateLimits],
        ['Total wait', durationOrZero(summary.totalWaitMs)],
        ['Longest wait', durationOrZero(summary.longestWaitMs)],
    ];
}

function projectKey(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    return String(value.name ?? value.key ?? value.project ?? '').trim();
}

function projectSubtotals(summary, events) {
    const projects = Array.isArray(summary?.projects) ? summary.projects : [];
    const names = [];
    const counts = new Map();
    for (const project of projects) {
        const name = projectKey(project);
        if (!name || counts.has(name)) continue;
        names.push(name);
        counts.set(name, 0);
    }
    for (const event of Array.isArray(events) ? events : []) {
        const name = projectKey(event?.project);
        if (name && counts.has(name)) counts.set(name, counts.get(name) + 1);
    }
    return names.map(name => ({ name, count: counts.get(name) || 0 }));
}

function projectSubtotalNodes(summary, events) {
    const rows = projectSubtotals(summary, events);
    if (!rows.length) return [];
    return [
        el('div', { className: 'chronicle__project-subtotals' }, [
            el('div', { className: 'chronicle__project-heading' }, 'PROJECT SUBTOTALS'),
            ...rows.map(({ name, count }) => el('div', { className: 'chronicle__project-row' }, [
                el('span', { className: 'chronicle__project-name' }, name),
                el('span', { className: 'chronicle__project-count' }, `${formatNumber(count)} ${count === 1 ? 'event' : 'events'}`),
            ])),
        ]),
    ];
}

function spendRows(spend, dateKey) {
    if (spend?.readFailed) return [['Spend ledger', 'Could not read the spend ledger for this day.']];
    if (!spend) return dateKey === chronicleDateKey() ? [] : [
        ['Spend ledger', 'No spend record was saved for this day.'],
    ];
    const rows = [
        ['New tokens', spend.tokens, formatNumber(spend.tokens)],
        ['Cache reads', spend.cacheRead, formatNumber(spend.cacheRead)],
        [spend.costLabel || 'Est. cost', spend.cost, formatCost(spend.cost)],
    ];
    if (spend.largest) rows.push([`Largest ${spend.largest.kind} by new tokens`, spend.largest.key]);
    if (spend.coverageSince) rows.push(['Coverage began', spend.coverageSince, clockTime(spend.coverageSince)]);
    rows.push(['Coverage', 'Activity ClaudeVille observed while open in this browser.']);
    if (spend.historical) {
        rows.push(['Cost basis', 'Recorded cost can include provider-reported costs and API estimates.']);
        rows.push(['Model detail', 'Per-model totals are unavailable for past days.']);
    } else if (spend.subscription) {
        rows.push(['Cost basis', `Your ${spend.subscription} plan bills on quota. API equivalent shows what the observed tokens would cost at API rates.`]);
    }
    return rows;
}

/** Build paste-ready prose and tables for one retained Chronicle day. */
export function buildChronicleMarkdown({
    dateKey = chronicleDateKey(),
    events = [],
    summary = summarizeDay(events),
    spend = null,
} = {}) {
    const daySummary = summary || summarizeDay(events);
    const dayEvents = orderedEvents(events);
    const isToday = dateKey === chronicleDateKey();
    const lines = [
        `# Chronicle — ${markdownCell(dateKey)}`,
        '',
        markdownCell(openingLine(daySummary, isToday)),
        '',
        '## Summary',
        '',
        '| Metric | Value |',
        '| --- | ---: |',
        ...summaryRows(daySummary).map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`),
    ];

    const spending = spendRows(spend, dateKey);
    if (spending.length) {
        lines.push(
            '',
            '## Spend summary',
            '',
            '| Metric | Value |',
            '| --- | ---: |',
            ...spending.map(([label, value, display = value]) => `| ${markdownCell(label)} | ${markdownCell(display)} |`),
        );
    }

    lines.push('', '## Timeline', '', '| Time | Glyph | Event |', '| --- | :---: | --- |');
    if (dayEvents.length) {
        lines.push(...dayEvents.map(event => (
            `| ${markdownCell(clockTime(event.ts))} | ${markdownCell(KIND_GLYPH[event.kind] || '·')} | ${markdownCell(eventText(event))} |`
        )));
    } else {
        lines.push('| — | — | No Chronicle entries were recorded on this day. |');
    }

    return `${lines.join('\n')}\n`;
}

/** Escape one CSV cell, including Excel formula-injection protection. */
export function csvEscapeCell(value) {
    const text = value == null ? '' : String(value);
    // Spreadsheet applications may trim tabs, newlines, and other leading
    // controls before deciding whether a cell is a formula. Detect the first
    // visible character after that prefix, while preserving the original text
    // inside the CSV cell.
    const normalized = text.replace(/^[\s\p{C}]*/u, '');
    // A leading apostrophe makes Excel treat formula-like text as a literal.
    const safe = /^[=+\-@]/.test(normalized) ? `'${text}` : text;
    return /[",\r\n\t]/.test(safe)
        ? `"${safe.replace(/"/g, '""')}"`
        : safe;
}

/** Build a spreadsheet-friendly CSV with summary and event rows. */
export function buildChronicleCsv({
    dateKey = chronicleDateKey(),
    events = [],
    summary = summarizeDay(events),
    spend = null,
} = {}) {
    const daySummary = summary || summarizeDay(events);
    const dayEvents = orderedEvents(events);
    const rows = [[
        'row_type', 'date', 'time', 'glyph', 'event', 'kind', 'agent', 'provider',
        'project', 'reason', 'tool', 'waited_ms', 'metric', 'value',
    ]];

    for (const [metric, value] of summaryRows(daySummary)) {
        rows.push(['summary', dateKey, '', '', '', '', '', '', '', '', '', '', metric, value]);
    }
    for (const [metric, value] of spendRows(spend, dateKey)) {
        rows.push(['spend', dateKey, '', '', '', '', '', '', '', '', '', '', metric, value]);
    }
    for (const event of dayEvents) {
        rows.push([
            'event',
            dateKey,
            clockTime(event.ts),
            KIND_GLYPH[event.kind] || '·',
            eventText(event),
            event.kind,
            event.agentName,
            event.provider,
            event.project,
            event.reason,
            event.tool,
            event.waitedMs,
            '',
            '',
        ]);
    }

    return `${rows.map(row => row.map(csvEscapeCell).join(',')).join('\r\n')}\r\n`;
}

function downloadText(text, filename, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    let link = null;
    try {
        link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.append(link);
        link.click();
    } finally {
        link?.remove();
        URL.revokeObjectURL(url);
    }
}

export class ChroniclePanel {
    constructor({ modal, chronicleLog, spendLedger = null, usageGetter = null, toast = null }) {
        this.modal = modal;
        this.log = chronicleLog;
        this.spendLedger = spendLedger;
        this.usageGetter = usageGetter;
        this.toast = toast;
        this._request = null;
        this._dateReadSeq = 0;
        this._selectedDateKey = null;
        this._selectedSpend = null;
        this._selectedPage = null;
        this._avatars = [];
        this._destroyed = false;
    }

    async open() {
        if (!this.modal || this._destroyed) return;
        const request = this.modal.beginRequest();
        if (request === null) return;
        this._request = request;
        const dateKey = chronicleDateKey();
        let page;
        try {
            page = await this._readPage(dateKey);
        } catch (error) {
            if (
                !this._destroyed
                && this._request === request
                && this.modal.isRequestCurrent(request)
            ) {
                this._reportFailure(
                    CHRONICLE_READ_FAILURE_EVENT,
                    'Could not load today\'s Chronicle.',
                    { dateKey, error },
                );
            }
            return;
        }
        if (
            this._destroyed
            || this._request !== request
            || !this.modal.isRequestCurrent(request)
        ) return;
        if (!this.modal.open('Village Chronicle', '', { wide: true, request })) return;
        this._selectedDateKey = dateKey;
        this._selectedSpend = page.spend;
        this._renderPage(page, dateKey, request);
    }

    async _readPage(dateKey) {
        const [page, spend, replayable] = await Promise.all([
            this._readTimelinePage(dateKey),
            this._readSpend(dateKey),
            // XP-2 — only a day with trail samples can be retold.
            Promise.resolve(this.log.hasTrailSamples?.(dateKey)).then(Boolean, () => false),
        ]);
        return { ...page, spend, replayable };
    }

    async _readTimelinePage(dateKey) {
        if (typeof this.log.readDayPage === 'function') {
            return this.log.readDayPage(dateKey, { limit: CHRONICLE_TIMELINE_PAGE_SIZE });
        }
        const all = await this.log.readDay(dateKey);
        return {
            events: all.slice(-CHRONICLE_TIMELINE_PAGE_SIZE).reverse(),
            summary: summarizeDay(all),
            totalCount: all.length,
        };
    }

    async _showDate(dateKey, request) {
        if (!dateKey || request !== this._request) return;
        const readSeq = ++this._dateReadSeq;
        if (dateKey === this._selectedDateKey) return;
        let page;
        try {
            page = await this._readPage(dateKey);
        } catch (error) {
            if (
                !this._destroyed
                && this._request === request
                && readSeq === this._dateReadSeq
                && this.modal.isRequestCurrent(request)
            ) {
                this._reportFailure(
                    CHRONICLE_READ_FAILURE_EVENT,
                    'Could not load that Chronicle day.',
                    { dateKey, error },
                );
            }
            return;
        }
        if (
            this._destroyed
            || this._request !== request
            || readSeq !== this._dateReadSeq
            || !this.modal.isRequestCurrent(request)
        ) return;
        // Commit only after the read has succeeded and is still the current
        // request. The rendered controls then receive the same committed key.
        this._selectedDateKey = dateKey;
        this._selectedSpend = page.spend;
        this._renderPage(page, dateKey, request);
    }

    _reportFailure(eventName, message, details = {}) {
        if (this.toast?.show) {
            this.toast.show(message, 'warning');
            return;
        }
        eventBus.emit(eventName, { message, ...details });
    }

    async _readSpend(dateKey) {
        const historical = dateKey !== chronicleDateKey();
        let record;
        try {
            record = await this.spendLedger?.readDay(dateKey);
        } catch {
            return { readFailed: true };
        }
        if (!record) return null;
        const subscription = historical ? null : this.usageGetter?.()?.account?.subscriptionType;
        const onPlan = typeof subscription === 'string'
            && ['max', 'pro', 'team', 'enterprise'].includes(subscription.toLowerCase());
        return {
            ...record,
            historical,
            subscription: onPlan ? subscription : null,
            costLabel: historical ? 'Recorded cost' : onPlan ? 'API equivalent' : 'Est. cost',
        };
    }

    async _readExportData(dateKey) {
        const selectedDateKey = dateKey || chronicleDateKey();
        const [events, spend] = await Promise.all([
            typeof this.log.readDay === 'function' ? this.log.readDay(selectedDateKey)
                : this._readTimelinePage(selectedDateKey).then(page => page.events),
            selectedDateKey === this._selectedDateKey ? this._selectedSpend : this._readSpend(selectedDateKey),
        ]);
        const dayEvents = Array.isArray(events) ? events : [];
        return {
            dateKey: selectedDateKey,
            events: dayEvents,
            summary: summarizeDay(dayEvents),
            spend,
        };
    }

    async _export(format) {
        if (this._destroyed) return;
        const dateKey = this._selectedDateKey || chronicleDateKey();
        const request = this._request;
        const readSeq = this._dateReadSeq;
        try {
            const data = await this._readExportData(dateKey);
            // A date change during the read must never download the wrong day.
            if (this._destroyed || request !== this._request || readSeq !== this._dateReadSeq
                || dateKey !== this._selectedDateKey || !this.modal.isRequestCurrent(request)) return;
            const isCsv = format === 'csv';
            const text = isCsv ? buildChronicleCsv(data) : buildChronicleMarkdown(data);
            const extension = isCsv ? 'csv' : 'md';
            downloadText(text, `chronicle-${dateKey}.${extension}`, CHRONICLE_EXPORT_MIME[isCsv ? 'csv' : 'markdown']);
        } catch (error) {
            const formatLabel = format === 'csv' ? 'CSV' : 'Markdown';
            this._reportFailure(
                CHRONICLE_EXPORT_FAILURE_EVENT,
                `Could not export the Chronicle as ${formatLabel}.`,
                { format, dateKey, error },
            );
        }
    }

    _renderPage(page, dateKey, request) {
        const { events, summary, totalCount, spend, replayable } = page;
        this._selectedPage = page;
        const content = this.modal.contentEl;
        if (content) {
            this._releaseAvatars();
            replaceChildren(content, [this._tabs('day', request), ...this._render(events, summary, {
                newestFirst: true,
                totalCount,
                dateKey,
                spend,
                replayable,
                onDateChange: nextDate => this._showDate(nextDate, request),
            })]);
        }
    }

    // XP-8 — two tabs: the selected day, and the lineages the village remembers.
    _tabs(active, request) {
        const tab = (key, text) => {
            const button = el('button', {
                className: ['chronicle__tab', ...(key === active ? ['chronicle__tab--active'] : [])],
                text,
            });
            button.type = 'button';
            button.setAttribute('aria-pressed', String(key === active));
            if (key !== active) {
                button.addEventListener('click', () => (key === 'hall'
                    ? this._showHall(request)
                    : this._selectedPage && this.modal?.isRequestCurrent(request)
                        && this._renderPage(this._selectedPage, this._selectedDateKey, request)));
            }
            return button;
        };
        return el('div', { className: 'chronicle__tabs', ariaLabel: 'Chronicle view' }, [
            tab('day', 'Day book'),
            tab('hall', 'Hall of Lives'),
        ]);
    }

    async _showHall(request) {
        if (this._destroyed || request !== this._request) return;
        let records;
        try {
            records = typeof this.log.readBiographies === 'function' ? await this.log.readBiographies() : [];
        } catch (error) {
            if (!this._destroyed && request === this._request && this.modal.isRequestCurrent(request)) {
                this._reportFailure(CHRONICLE_READ_FAILURE_EVENT, 'Could not load the Hall of Lives.', { error });
            }
            return;
        }
        if (this._destroyed || request !== this._request || !this.modal.isRequestCurrent(request)) return;
        const content = this.modal.contentEl;
        if (!content) return;
        this._releaseAvatars();
        replaceChildren(content, [this._tabs('hall', request), ...this._renderHall(buildHallOfLives(records))]);
    }

    _renderHall(lives) {
        const nodes = [el('p', { className: 'chronicle__opening' }, lives.length
            ? 'The lineages the village remembers, most recently seen first.'
            : 'The village remembers no lineages yet.')];
        if (lives.length) {
            nodes.push(el('ul', { className: 'chronicle__lives' }, lives.map(life => this._lifeNode(life))));
        }
        nodes.push(el('p', { className: 'chronicle__note' },
            'A lineage is a named villager or a project lead, one per provider and repository. '
            + 'The village forgets a lineage 180 days after it was last seen.'));
        return nodes;
    }

    _lifeNode(life) {
        const avatar = new AvatarCanvas({
            id: life.identityKey,
            provider: life.provider,
            model: null,
            effort: null,
            appearance: Appearance.fromIdentityKey(life.identityKey),
        }, 'niche');
        this._avatars.push(avatar);
        const chapters = life.chapters.length
            ? el('ul', { className: 'chronicle__life-chapters' }, life.chapters.map(chapter => (
                el('li', { className: 'chronicle__life-chapter' }, [
                    el('span', { className: 'chronicle__life-chapter-copy' }, chapter.copy),
                    el('span', { className: 'chronicle__life-chapter-date' }, chapter.dateLabel),
                ])
            )))
            : el('p', { className: 'chronicle__life-empty' }, 'No chapters recorded yet.');
        return el('li', { className: 'chronicle__life' }, [
            el('div', { className: 'chronicle__life-bust' }, [avatar.canvas]),
            el('div', { className: 'chronicle__life-body' }, [
                el('div', { className: 'chronicle__life-heading' }, [
                    el('span', { className: 'chronicle__life-name' }, life.name),
                    ...(life.nickname ? [el('span', { className: 'chronicle__life-nickname' }, life.nickname)] : []),
                ]),
                el('div', { className: 'chronicle__life-meta' },
                    `${life.role} · first seen ${life.firstSeenLabel} · last seen ${life.lastSeenLabel}`),
                chapters,
            ]),
        ]);
    }

    _releaseAvatars() {
        for (const avatar of this._avatars) avatar.destroy();
        this._avatars = [];
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._dateReadSeq++;
        this.modal?.invalidateRequest?.(this._request);
        this._request = null;
        this._selectedSpend = null;
        this._selectedPage = null;
        this._releaseAvatars();
        this.modal = null;
        this.log = null;
        this.spendLedger = null;
        this.usageGetter = null;
        this.toast = null;
    }

    _spendNodes(spend, dateKey) {
        const rows = spendRows(spend, dateKey);
        const stats = spend && !spend.readFailed ? rows.splice(0, 3) : [];
        const nodes = stats.length ? [el('div', { className: 'chronicle__ledger' }, stats.map(
            ([label, value, display]) => ledgerRow(label.toUpperCase(), display, value),
        ))] : [];
        for (const [label, value, display = value] of rows) {
            nodes.push(el('p', { className: 'chronicle__note' }, `${label} · ${display}`));
        }
        return nodes;
    }

    _datePicker(dateKey, onDateChange, replayable = false) {
        const retentionDays = Number(this.log?.retentionDays) || 14;
        const window = chronicleDateWindow(Date.now(), retentionDays);
        const shiftDate = offset => {
            const shifted = chronicleDateFromKey(dateKey);
            shifted.setDate(shifted.getDate() + offset);
            return chronicleDateKey(shifted);
        };
        const previousKey = shiftDate(-1);
        const nextKey = shiftDate(1);
        // 7.6 — one line of text controls: PREVIOUS · the day · NEXT · TODAY.
        // No native date field: the retention window is a couple of weeks,
        // and the stepped buttons walk all of it.
        const previousButton = el('button', {
            className: 'chronicle__date-button',
            text: 'Previous',
            title: 'Show the previous retained Chronicle day',
            ariaLabel: 'Show previous Chronicle day',
        });
        previousButton.type = 'button';
        previousButton.disabled = dateKey <= window.min;
        previousButton.addEventListener('click', () => onDateChange?.(previousKey));

        const nextButton = el('button', {
            className: 'chronicle__date-button',
            text: 'Next',
            title: 'Show the next Chronicle day',
            ariaLabel: 'Show next Chronicle day',
        });
        nextButton.type = 'button';
        nextButton.disabled = dateKey >= window.max;
        nextButton.addEventListener('click', () => onDateChange?.(nextKey));

        const todayButton = el('button', {
            className: ['chronicle__date-button', 'chronicle__today-button'],
            text: 'Today',
            title: 'Return to today\'s Chronicle',
            ariaLabel: 'Show today\'s Chronicle',
        });
        todayButton.type = 'button';
        todayButton.addEventListener('click', () => onDateChange?.(window.max));

        const markdownButton = el('button', {
            className: 'chronicle__export-button',
            text: 'Markdown',
            title: 'Download the selected day as Markdown',
            ariaLabel: 'Download selected Chronicle day as Markdown',
        });
        markdownButton.type = 'button';
        markdownButton.addEventListener('click', () => this._export('markdown'));
        const csvButton = el('button', {
            className: 'chronicle__export-button',
            text: 'CSV',
            title: 'Download the selected day as CSV',
            ariaLabel: 'Download selected Chronicle day as CSV',
        });
        csvButton.type = 'button';
        csvButton.addEventListener('click', () => this._export('csv'));
        const actions = [markdownButton, csvButton];
        if (replayable) {
            // XP-2 — the recorded day plays in its own window, chipped RETOLD.
            const watchButton = el('button', {
                className: ['chronicle__export-button', 'chronicle__watch-button'],
                text: 'Watch this day',
                title: 'Replay this recorded day in a separate window',
                ariaLabel: 'Watch this Chronicle day in a separate window',
            });
            watchButton.type = 'button';
            watchButton.addEventListener('click', () => {
                window.open(retoldVillageHref(location.pathname, dateKey), '_blank', 'noopener');
            });
            actions.unshift(watchButton);
        }
        const heading = chronicleDayHeading(chronicleDateFromKey(dateKey));
        return el('div', { className: 'chronicle__date-controls' }, [
            el('div', { className: 'chronicle__date-navigation' }, [
                previousButton,
                el('span', { className: 'chronicle__date-heading' }, heading),
                nextButton,
                todayButton,
            ]),
            el('span', { className: 'chronicle__export-actions' }, actions),
        ]);
    }

    _render(events, summary, {
        newestFirst = false,
        totalCount = events.length,
        dateKey = chronicleDateKey(),
        onDateChange = null,
        spend = null,
        replayable = false,
    } = {}) {
        const isToday = dateKey === chronicleDateKey();
        const nodes = [
            this._datePicker(dateKey, onDateChange, replayable),
            el('p', { className: 'chronicle__opening' }, openingLine(summary, isToday)),
        ];

        nodes.push(el('div', { className: 'chronicle__ledger' }, [
            ledgerRow('COMMITS', summary.commits),
            ledgerRow('PUSHES', summary.pushes),
            ledgerRow('TURNS DONE', summary.completed),
            ledgerRow('WAITED ON YOU', summary.waits),
            ledgerRow('ERRORS', summary.errors),
            ledgerRow('RATE LIMITS', summary.rateLimits),
        ]));
        nodes.push(...projectSubtotalNodes(summary, events));

        nodes.push(...this._spendNodes(spend, dateKey));

        if (summary.longestWaitMs > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Longest wait for you: ${duration(summary.longestWaitMs)}.`));
        }

        if (!events.length) {
            nodes.push(el('p', { className: 'chronicle__note' },
                isToday
                    ? 'The day book fills as agents work — it records only what happens while ClaudeVille is open.'
                    : 'Choose another date to continue browsing the retained Chronicle.'));
            return nodes;
        }

        // Newest first: the recap answers "what did I miss" before "how did the
        // day start", while same-minute bursts stay on one intelligible row.
        const timeline = foldTimeline(events);
        const ordered = newestFirst ? [...timeline].reverse() : timeline;
        nodes.push(el('ul', { className: 'chronicle__timeline' }, ordered.map(row => {
            const text = row.count > 1
                ? `${row.label} ×${row.count}${row.project ? ` · ${row.project}` : ''}`
                : eventText(row);
            return el('li', { className: `chronicle__entry chronicle__entry--${row.kind}` }, [
                el('span', { className: 'chronicle__time' }, clockTime(row.ts)),
                el('span', { className: 'chronicle__glyph' }, KIND_GLYPH[row.kind] || '·'),
                el('span', { className: 'chronicle__text' }, text),
            ]);
        })));
        const omitted = Math.max(0, totalCount - events.length);
        if (omitted > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Showing the newest ${events.length} of ${totalCount} events.`));
        }

        return nodes;
    }
}
