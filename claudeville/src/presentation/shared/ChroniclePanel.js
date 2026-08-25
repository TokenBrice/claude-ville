import {
    ChronicleEventKind,
    chronicleDateFromKey,
    chronicleDateKey,
    chronicleDateWindow,
    summarizeDay,
} from '../../application/ChronicleLog.js';
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
};

const REASON_TEXT = {
    question: 'asked a question',
    approval: 'awaited approval',
    plan_review: 'awaited plan review',
};

export const CHRONICLE_TIMELINE_PAGE_SIZE = 100;

const CHRONICLE_EXPORT_MIME = {
    markdown: 'text/markdown;charset=utf-8',
    csv: 'text/csv;charset=utf-8',
};

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
        case ChronicleEventKind.COMMIT: return `${who} committed ${event.label || 'a change'}${where}`;
        case ChronicleEventKind.PUSH: return `${who} pushed ${event.label || ''}${where}`.trim();
        default: return `${who} ${event.kind}${where}`;
    }
}

function ledgerRow(label, value) {
    return el('div', { className: 'chronicle__stat' }, [
        el('span', { className: 'chronicle__stat-label' }, label),
        el('span', { className: 'chronicle__stat-value' }, String(value)),
    ]);
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
        .replace(/\r?\n/g, '<br>')
        .replace(/\|/g, '\\|');
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
        ['Turns done', summary.completed],
        ['Waited on you', summary.waits],
        ['Errors', summary.errors],
        ['Rate limits', summary.rateLimits],
        ['Total wait', durationOrZero(summary.totalWaitMs)],
        ['Longest wait', durationOrZero(summary.longestWaitMs)],
    ];
}

function spendRows(spend) {
    if (!spend) return [];
    return [
        ['New tokens', spend.tokens],
        ['Cache reads', spend.cacheRead],
        [spend.costLabel || 'Est. cost', spend.cost],
    ];
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

    const spending = dateKey === chronicleDateKey() ? spendRows(spend) : [];
    if (spending.length) {
        lines.push(
            '',
            '## Spend summary',
            '',
            '| Metric | Value |',
            '| --- | ---: |',
            ...spending.map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(
                label === 'New tokens' || label === 'Cache reads' ? formatNumber(value) : formatCost(value),
            )} |`),
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
    // A leading apostrophe makes Excel treat formula-like text as a literal.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe)
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
    for (const [metric, value] of (dateKey === chronicleDateKey() ? spendRows(spend) : [])) {
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
    constructor({ modal, chronicleLog, spendLedger = null, usageGetter = null }) {
        this.modal = modal;
        this.log = chronicleLog;
        this.spendLedger = spendLedger;
        this.usageGetter = usageGetter;
        this._request = null;
        this._dateReadSeq = 0;
        this._selectedDateKey = null;
        this._destroyed = false;
    }

    async open() {
        if (!this.modal || this._destroyed) return;
        const request = this.modal.beginRequest();
        if (request === null) return;
        this._request = request;
        const dateKey = chronicleDateKey();
        this._selectedDateKey = dateKey;
        const page = await this._readPage(dateKey);
        if (
            this._destroyed
            || this._request !== request
            || !this.modal.isRequestCurrent(request)
        ) return;
        if (!this.modal.open('Village Chronicle', '', { wide: true, request })) return;
        this._renderPage(page, dateKey, request);
    }

    async _readPage(dateKey) {
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
        if (!dateKey || dateKey === this._selectedDateKey) return;
        this._selectedDateKey = dateKey;
        const readSeq = ++this._dateReadSeq;
        const page = await this._readPage(dateKey);
        if (
            this._destroyed
            || this._request !== request
            || readSeq !== this._dateReadSeq
            || !this.modal.isRequestCurrent(request)
        ) return;
        this._renderPage(page, dateKey, request);
    }

    _spendForExport(dateKey) {
        if (dateKey !== chronicleDateKey()) return null;
        const today = this.spendLedger?.today;
        if (!today || typeof today !== 'object') return null;
        if (this.spendLedger.date && this.spendLedger.date !== dateKey) return null;
        const subscription = this.usageGetter?.()?.account?.subscriptionType;
        const onPlan = typeof subscription === 'string'
            && ['max', 'pro', 'team', 'enterprise'].includes(subscription.toLowerCase());
        return {
            tokens: Number(today.tokens) || 0,
            cacheRead: Number(today.cacheRead) || 0,
            cost: Number(today.cost) || 0,
            costLabel: onPlan ? 'API equivalent' : 'Est. cost',
        };
    }

    async _readExportData(dateKey) {
        const selectedDateKey = dateKey || chronicleDateKey();
        let events;
        if (typeof this.log?.readDay === 'function') {
            events = await this.log.readDay(selectedDateKey);
        } else {
            events = (await this._readPage(selectedDateKey)).events;
        }
        const dayEvents = Array.isArray(events) ? events : [];
        return {
            dateKey: selectedDateKey,
            events: dayEvents,
            summary: summarizeDay(dayEvents),
            spend: this._spendForExport(selectedDateKey),
        };
    }

    async _export(format) {
        if (this._destroyed) return;
        const dateKey = this._selectedDateKey || chronicleDateKey();
        try {
            const data = await this._readExportData(dateKey);
            // A date change during the read must never download the wrong day.
            if (this._destroyed || dateKey !== this._selectedDateKey) return;
            const isCsv = format === 'csv';
            const text = isCsv ? buildChronicleCsv(data) : buildChronicleMarkdown(data);
            const extension = isCsv ? 'csv' : 'md';
            downloadText(text, `chronicle-${dateKey}.${extension}`, CHRONICLE_EXPORT_MIME[isCsv ? 'csv' : 'markdown']);
        } catch {
            // Export is best effort; a failed local read must not disrupt the modal.
        }
    }

    _renderPage({ events, summary, totalCount }, dateKey, request) {
        const content = this.modal.contentEl;
        if (content) {
            replaceChildren(content, this._render(events, summary, {
                newestFirst: true,
                totalCount,
                dateKey,
                onDateChange: nextDate => this._showDate(nextDate, request),
            }));
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._dateReadSeq++;
        this.modal?.invalidateRequest?.(this._request);
        this._request = null;
        this.modal = null;
        this.log = null;
        this.spendLedger = null;
        this.usageGetter = null;
    }

    // The day's accounting lives here rather than in the topbar: a dollar
    // figure you are not billed for has not earned permanent space in the
    // corner of someone's eye, but it belongs in the record of the day.
    _spendNodes(isToday = true) {
        if (!isToday) return [];
        const today = this.spendLedger?.today;
        if (!today) return [];
        const subscription = this.usageGetter?.()?.account?.subscriptionType;
        const onPlan = typeof subscription === 'string'
            && ['max', 'pro', 'team', 'enterprise'].includes(subscription.toLowerCase());

        const nodes = [el('div', { className: 'chronicle__ledger' }, [
            ledgerRow('NEW TOKENS', formatNumber(today.tokens)),
            ledgerRow('CACHE READS', formatNumber(today.cacheRead)),
            ledgerRow(onPlan ? 'API EQUIVALENT' : 'EST. COST', formatCost(today.cost)),
        ])];
        nodes.push(el('p', { className: 'chronicle__note' }, onPlan
            ? `Counted while ClaudeVille was open. Your ${subscription} plan bills on quota, not on this figure — it is what today's tokens would have cost at API rates.`
            : 'Counted while ClaudeVille was open, from the growth in each session\'s token totals.'));
        return nodes;
    }

    _datePicker(dateKey, onDateChange) {
        const retentionDays = Number(this.log?.retentionDays) || 14;
        const window = chronicleDateWindow(Date.now(), retentionDays);
        const input = el('input', {
            className: 'chronicle__date-input',
            ariaLabel: 'Chronicle date',
        });
        input.type = 'date';
        input.value = dateKey;
        input.min = window.min;
        input.max = window.max;
        input.addEventListener('change', () => onDateChange?.(input.value));
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
        const selected = chronicleDateFromKey(dateKey);
        const heading = selected.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
        return el('div', { className: 'chronicle__date-controls' }, [
            el('label', { className: 'chronicle__date-label' }, [
                el('span', { className: 'chronicle__date-label-text' }, 'Day'),
                input,
            ]),
            el('span', { className: 'chronicle__date-heading' }, heading),
            el('span', { className: 'chronicle__export-actions' }, [markdownButton, csvButton]),
        ]);
    }

    _render(events, summary, {
        newestFirst = false,
        totalCount = events.length,
        dateKey = chronicleDateKey(),
        onDateChange = null,
    } = {}) {
        const isToday = dateKey === chronicleDateKey();
        const nodes = [
            this._datePicker(dateKey, onDateChange),
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

        nodes.push(...this._spendNodes(isToday));

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
        // day start".
        const ordered = newestFirst ? events : [...events].reverse();
        nodes.push(el('ul', { className: 'chronicle__timeline' }, ordered.map(event => (
            el('li', { className: `chronicle__entry chronicle__entry--${event.kind}` }, [
                el('span', { className: 'chronicle__time' }, clockTime(event.ts)),
                el('span', { className: 'chronicle__glyph' }, KIND_GLYPH[event.kind] || '·'),
                el('span', { className: 'chronicle__text' }, eventText(event)),
            ])
        ))));
        const omitted = Math.max(0, totalCount - ordered.length);
        if (omitted > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Showing the newest ${ordered.length} of ${totalCount} events.`));
        }

        return nodes;
    }
}
