import { ChronicleEventKind, summarizeDay } from '../../application/ChronicleLog.js';
import { el, replaceChildren } from './DomSafe.js';

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

function openingLine(summary) {
    if (!summary.agents.length) {
        return 'A quiet day. Nothing has passed through the village yet.';
    }
    const since = summary.firstTs ? `Since ${clockTime(summary.firstTs)}` : 'Today';
    const agents = `${summary.agents.length} ${summary.agents.length === 1 ? 'agent' : 'agents'}`;
    const projects = summary.projects.length
        ? ` across ${summary.projects.length} ${summary.projects.length === 1 ? 'project' : 'projects'}`
        : '';
    return `${since}: ${agents}${projects}.`;
}

export class ChroniclePanel {
    constructor({ modal, chronicleLog }) {
        this.modal = modal;
        this.log = chronicleLog;
    }

    async open() {
        if (!this.modal) return;
        const events = await this.log.readDay();
        const summary = summarizeDay(events);
        this.modal.open('Village Chronicle', '', { wide: true });
        const content = this.modal.contentEl;
        if (content) replaceChildren(content, this._render(events, summary));
    }

    _render(events, summary) {
        const nodes = [el('p', { className: 'chronicle__opening' }, openingLine(summary))];

        nodes.push(el('div', { className: 'chronicle__ledger' }, [
            ledgerRow('COMMITS', summary.commits),
            ledgerRow('PUSHES', summary.pushes),
            ledgerRow('TURNS DONE', summary.completed),
            ledgerRow('WAITED ON YOU', summary.waits),
            ledgerRow('ERRORS', summary.errors),
            ledgerRow('RATE LIMITS', summary.rateLimits),
        ]));

        if (summary.longestWaitMs > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Longest wait for you: ${duration(summary.longestWaitMs)}.`));
        }

        if (!events.length) {
            nodes.push(el('p', { className: 'chronicle__note' },
                'The day book fills as agents work — it records only what happens while ClaudeVille is open.'));
            return nodes;
        }

        // Newest first: the recap answers "what did I miss" before "how did the
        // day start".
        const ordered = [...events].reverse();
        nodes.push(el('ul', { className: 'chronicle__timeline' }, ordered.map(event => (
            el('li', { className: `chronicle__entry chronicle__entry--${event.kind}` }, [
                el('span', { className: 'chronicle__time' }, clockTime(event.ts)),
                el('span', { className: 'chronicle__glyph' }, KIND_GLYPH[event.kind] || '·'),
                el('span', { className: 'chronicle__text' }, eventText(event)),
            ])
        ))));

        return nodes;
    }
}
