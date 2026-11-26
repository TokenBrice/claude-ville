// v0.69 E2 — 4-Provider Quota Ledger Card (Runic Tide-Terrace World popover).
//
// Modeled directly on HarborFleetCard.js: clicking any Runic Tide-Terrace
// quota pillar in World mode opens a pinned `cv-frame--bg2` DOM card beside
// that pillar showing all configured providers (Claude, Codex, GLM,
// Antigravity) with 12-segment weekly bars, exact `% left` / `% used`, live
// 1 Hz reset countdowns, 5-hour / 3P Shared sub-rows, and freshness/error
// status. Pure DOM overlay (zero canvas text, so Postcard mode stays clean);
// renders as a bottom sheet on `/m/` (mobile.css).

import { QUOTA_TERRACE_PROVIDERS } from '../../config/scenery.js';
import {
    formatCreditChange,
    formatNumber,
    formatQuotaErrorStatus,
    formatWaitAge,
    subscribeElapsedText,
} from './Formatters.js';
import {
    QUOTA_PROVIDER_META,
    formatQuotaCountdown,
    quotaPillarReading,
    quotaProviderLabel,
    quotaProviderWeeklyTitle,
} from '../character-mode/QuotaTerrace.js';

export const QUOTA_LEDGER_SEGMENTS = 12;
export const QUOTA_LEDGER_CARD_SELECTOR = '.quota-ledger-card';

export function isInQuotaLedgerCard(element) {
    return Boolean(element?.closest?.(QUOTA_LEDGER_CARD_SELECTOR));
}

function segmentsForLeft(leftPercent) {
    if (leftPercent === null || leftPercent === undefined || !Number.isFinite(leftPercent)) return 0;
    return Math.min(QUOTA_LEDGER_SEGMENTS, Math.max(0, Math.round((leftPercent / 100) * QUOTA_LEDGER_SEGMENTS)));
}

function sourceLabel(source) {
    if (source === 't3-cache') return 'T3 cache';
    if (source === 'oauth-api') return 'OAuth API';
    return source || '';
}

function buildProviderRow(provider, usage, { now, activeProvider }) {
    const r = quotaPillarReading(provider, usage, now);
    const meta = QUOTA_PROVIDER_META[provider] || {
        id: provider,
        label: quotaProviderLabel(provider),
        weeklyTitle: quotaProviderWeeklyTitle(provider),
        accent: '#977bb5',
    };
    const unknown = r.state === 'unknown';
    const limited = r.state === 'limit';
    const lit = unknown || limited ? 0 : segmentsForLeft(r.leftPercent);
    const resetText = r.resetsAt ? `Resets in ${formatQuotaCountdown(r.resetsAt, now)}` : '';
    const subRows = [];

    if (provider === 'claude') {
        if (r.fiveHourPercent !== null) {
            const fiveReset = r.fiveHourResetsAt ? ` · resets in ${formatQuotaCountdown(r.fiveHourResetsAt, now)}` : '';
            subRows.push({
                kind: 'window',
                label: '5-hour',
                text: `${r.fiveHourPercent}% used${fiveReset}`,
                resetsAt: r.fiveHourResetsAt,
                prefix: `${r.fiveHourPercent}% used · resets in `,
            });
        }
        if (r.highestActiveLimit) {
            const hl = r.highestActiveLimit;
            const sev = hl.warn ? ` (${hl.severity})` : '';
            subRows.push({
                kind: hl.warn ? 'warn' : 'meta',
                label: 'Active limit',
                text: `${hl.label} ${hl.usedText} used${sev}`,
                resetsAt: null,
            });
        }
    } else if (provider === 'codex') {
        if (r.credits?.unlimited) {
            subRows.push({ kind: 'meta', label: 'Credits', text: 'Unlimited', resetsAt: null });
        } else if (Number.isFinite(r.credits?.balance)) {
            const change = formatCreditChange(r.creditChange, { short: true });
            subRows.push({
                kind: 'meta',
                label: 'Credits',
                text: `${formatNumber(Math.round(r.credits.balance))} left${change ? ` · ${change}` : ''}`,
                resetsAt: null,
            });
        } else {
            const change = formatCreditChange(r.creditChange, { short: true });
            if (change) subRows.push({ kind: 'meta', label: 'Balance', text: change, resetsAt: null });
        }
    } else if (provider === 'glm') {
        if (r.fiveHourPercent !== null) {
            const fiveReset = r.fiveHourResetsAt ? ` · resets in ${formatQuotaCountdown(r.fiveHourResetsAt, now)}` : '';
            subRows.push({
                kind: 'window',
                label: '5-hour',
                text: `${r.fiveHourPercent}% used${fiveReset}`,
                resetsAt: r.fiveHourResetsAt,
                prefix: `${r.fiveHourPercent}% used · resets in `,
            });
        }
        if (r.plan) {
            subRows.push({ kind: 'meta', label: 'Plan', text: r.plan, resetsAt: null });
        }
        if (Number.isFinite(r.usedCredits) && Number.isFinite(r.limitCredits)) {
            subRows.push({
                kind: 'meta',
                label: 'Allowance',
                text: `${formatNumber(Math.round(r.usedCredits))} / ${formatNumber(Math.round(r.limitCredits))}`,
                resetsAt: null,
            });
        }
    } else if (provider === 'antigravity') {
        if (r.sharedWeeklyLeftPercent !== null) {
            const shReset = r.sharedWeeklyResetsAt ? ` · resets in ${formatQuotaCountdown(r.sharedWeeklyResetsAt, now)}` : '';
            subRows.push({
                kind: 'window',
                label: '3P Shared',
                text: `${r.sharedWeeklyLeftPercent}% left (${r.sharedWeeklyUsedPercent}% used)${shReset}`,
                resetsAt: r.sharedWeeklyResetsAt,
                prefix: `${r.sharedWeeklyLeftPercent}% left (${r.sharedWeeklyUsedPercent}% used) · resets in `,
            });
        }
        const fiveParts = [];
        if (r.geminiFiveHourPercent !== null) fiveParts.push(`Gemini ${r.geminiFiveHourPercent}%`);
        if (r.sharedFiveHourPercent !== null) fiveParts.push(`3P ${r.sharedFiveHourPercent}%`);
        if (fiveParts.length) {
            subRows.push({ kind: 'window', label: '5-hour used', text: fiveParts.join(' · '), resetsAt: null });
        }
        if (r.source) {
            subRows.push({ kind: 'meta', label: 'Source', text: sourceLabel(r.source), resetsAt: null });
        }
    }

    const errorText = formatQuotaErrorStatus(r.errorStatus);
    let freshnessText = '';
    let freshnessKind = 'muted';
    if (errorText) {
        freshnessText = errorText;
        freshnessKind = 'error';
    } else if (unknown) {
        freshnessText = provider === 'codex' && r.windowReset
            ? 'Window reset · awaiting next reading'
            : 'No local quota observed yet';
    } else if (r.observedAt) {
        freshnessText = `Observed ${formatWaitAge(Math.max(0, now - r.observedAt))} ago`;
    }

    return {
        provider,
        label: meta.label,
        weeklyTitle: meta.weeklyTitle,
        accent: meta.accent,
        selected: provider === activeProvider,
        state: r.state,
        unknown,
        limited,
        usedPercent: r.usedPercent,
        leftPercent: r.leftPercent,
        leftText: unknown ? 'Unavailable' : (limited ? '0% left' : `${r.leftPercent}% left`),
        usedText: unknown ? '—' : `${r.usedPercent}% used`,
        badgeWord: limited ? 'LIMIT' : '',
        lit,
        segments: QUOTA_LEDGER_SEGMENTS,
        resetsAt: r.resetsAt,
        resetText,
        observedAt: r.observedAt,
        errorStatus: r.errorStatus,
        freshnessText,
        freshnessKind,
        subRows,
    };
}

/** Pure model builder for the 4-Provider Quota Ledger card (Node-testable). */
export function buildQuotaLedgerModel(usage = null, {
    now = Date.now(),
    activeProvider = null,
    providers = QUOTA_TERRACE_PROVIDERS,
} = {}) {
    const rows = providers.map((provider) => buildProviderRow(provider, usage, { now, activeProvider }));
    const availableCount = rows.filter((row) => !row.unknown).length;
    return {
        title: 'Runic Tide-Terrace',
        subtitle: `${availableCount} of ${rows.length} weekly readings active`,
        activeProvider: activeProvider || null,
        rows,
    };
}

// ─── DOM ────────────────────────────────────────────────────────────────────

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
}

export class QuotaLedgerCard {
    constructor({ host, onClose = () => {} } = {}) {
        this.host = host;
        this.onClose = onClose;
        this.el = null;
        this.model = null;
        this.activeProvider = null;
        this._returnFocus = null;
        this._elapsedUnsubs = [];
        this._onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            event.preventDefault?.();
            this.close({ restoreFocus: true });
        };
    }

    get isOpen() {
        return Boolean(this.el);
    }

    open(model, { activeProvider = null, focus = false } = {}) {
        if (!model || !this.host) return;
        const alreadyOpen = Boolean(this.el);
        this.model = model;
        this.activeProvider = activeProvider ?? model.activeProvider ?? null;
        if (!this.el) {
            this.el = node('section', 'quota-ledger-card cv-frame cv-frame--bg2');
            this.el.setAttribute('role', 'dialog');
            this.el.setAttribute('aria-modal', 'false');
            this.el.setAttribute('aria-label', 'Runic Tide-Terrace weekly quota ledger');
            this.el.tabIndex = -1;
            this.el.addEventListener('keydown', this._onKeyDown);
            // Clicks inside the card never pass through to the World canvas.
            this.el.addEventListener('pointerdown', (event) => event.stopPropagation());
            this.el.addEventListener('click', (event) => event.stopPropagation());
            this.host.append(this.el);
        }
        this._render(model);
        if (focus && !alreadyOpen) {
            this._returnFocus = typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            this.el.focus?.({ preventScroll: true });
        }
    }

    refresh(model) {
        if (!this.el || !model) return;
        this.model = model;
        this._render(model);
    }

    close({ restoreFocus = false } = {}) {
        this._clearElapsed();
        if (!this.el) return;
        const hadFocus = Boolean(typeof document !== 'undefined' && this.el.contains?.(document.activeElement));
        this.el.removeEventListener('keydown', this._onKeyDown);
        this.el.remove();
        this.el = null;
        this.model = null;
        this.activeProvider = null;
        if ((restoreFocus || hadFocus) && this._returnFocus?.isConnected) {
            this._returnFocus.focus?.({ preventScroll: true });
        }
        this._returnFocus = null;
        this.onClose();
    }

    position(point, reserved = []) {
        if (!this.el || !point) return;
        if (document.documentElement?.dataset?.cvProfile === 'mobile') {
            this.el.style.left = '';
            this.el.style.top = '';
            return;
        }
        const hostRect = this.host.getBoundingClientRect();
        const width = this.el.offsetWidth || 340;
        const height = this.el.offsetHeight || 280;
        let x = point.x + 28;
        if (x + width > hostRect.width - 12) x = point.x - width - 28;
        x = Math.max(12, Math.min(hostRect.width - width - 12, x));
        let y = Math.max(12, Math.min(hostRect.height - height - 12, point.y - height / 2));
        for (const { left, right, top, bottom } of reserved) {
            if (x < right && x + width > left && y < bottom && y + height > top) {
                y = top - height - 8 >= 12 ? top - height - 8 : Math.min(hostRect.height - height - 12, bottom + 8);
            }
        }
        this.el.style.left = `${Math.round(x)}px`;
        this.el.style.top = `${Math.round(y)}px`;
    }

    _clearElapsed() {
        for (const unsub of this._elapsedUnsubs) {
            try { unsub(); } catch {}
        }
        this._elapsedUnsubs.length = 0;
    }

    _subscribe(el, textFn) {
        const unsub = subscribeElapsedText(el, textFn);
        this._elapsedUnsubs.push(unsub);
    }

    _render(model) {
        this._clearElapsed();
        const el = this.el;
        if (!el) return;

        const head = node('header', 'quota-ledger-card__head');
        const titleRow = node('div', 'quota-ledger-card__title-row');
        titleRow.append(node('h2', 'quota-ledger-card__title', model.title));
        const closeBtn = node('button', 'quota-ledger-card__close', '×');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close quota ledger');
        closeBtn.addEventListener('click', () => this.close({ restoreFocus: true }));
        titleRow.append(closeBtn);
        head.append(titleRow);
        head.append(node('div', 'quota-ledger-card__subtitle', model.subtitle));

        const list = node('ol', 'quota-ledger-card__list');
        list.setAttribute('aria-label', 'Weekly provider quotas');

        for (const row of model.rows) {
            const cls = [
                'quota-ledger-card__row',
                `quota-ledger-card__row--${row.provider}`,
                row.selected ? 'quota-ledger-card__row--active' : '',
                row.limited ? 'quota-ledger-card__row--limit' : '',
                row.unknown ? 'quota-ledger-card__row--unknown' : '',
            ].filter(Boolean).join(' ');
            const item = node('li', cls);
            item.dataset.provider = row.provider;
            item.style.setProperty('--quota-accent', row.accent);

            const top = node('div', 'quota-ledger-card__row-head');
            top.append(node('span', 'quota-ledger-card__provider', row.weeklyTitle));
            if (row.badgeWord) {
                top.append(node('span', 'quota-ledger-card__badge', row.badgeWord));
            }
            const pct = node('span', 'quota-ledger-card__pct', row.leftText);
            top.append(pct);
            if (!row.unknown) {
                top.append(node('span', 'quota-ledger-card__used', row.usedText));
            }
            item.append(top);

            const barRow = node('div', 'quota-ledger-card__bar-row');
            const gauge = node('span', 'quota-ledger-card__gauge');
            gauge.setAttribute('role', 'meter');
            gauge.setAttribute('aria-label', `${row.weeklyTitle} remaining`);
            gauge.setAttribute('aria-valuemin', '0');
            gauge.setAttribute('aria-valuemax', '100');
            if (row.leftPercent !== null) gauge.setAttribute('aria-valuenow', String(row.leftPercent));
            for (let i = 0; i < row.segments; i++) {
                gauge.append(node('span', i < row.lit ? 'on' : ''));
            }
            barRow.append(gauge);

            if (row.resetsAt) {
                const countdown = node('span', 'quota-ledger-card__reset', row.resetText);
                this._subscribe(countdown, (now) => {
                    const text = formatQuotaCountdown(row.resetsAt, now);
                    return text ? `Resets in ${text}` : '';
                });
                barRow.append(countdown);
            }
            item.append(barRow);

            if (row.subRows.length > 0 || row.freshnessText) {
                const sub = node('div', 'quota-ledger-card__subs');
                for (const sr of row.subRows) {
                    const subEl = node('div', `quota-ledger-card__sub quota-ledger-card__sub--${sr.kind}`);
                    subEl.append(node('span', 'quota-ledger-card__sub-label', `${sr.label}: `));
                    const valEl = node('span', 'quota-ledger-card__sub-val', sr.text);
                    if (sr.resetsAt && sr.prefix) {
                        this._subscribe(valEl, (now) => {
                            const text = formatQuotaCountdown(sr.resetsAt, now);
                            return text ? `${sr.prefix}${text}` : sr.text;
                        });
                    }
                    subEl.append(valEl);
                    sub.append(subEl);
                }
                if (row.freshnessText) {
                    const fresh = node('div', `quota-ledger-card__fresh quota-ledger-card__fresh--${row.freshnessKind}`, row.freshnessText);
                    if (row.observedAt && row.freshnessKind !== 'error' && !row.unknown) {
                        this._subscribe(fresh, (now) => `Observed ${formatWaitAge(Math.max(0, now - row.observedAt))} ago`);
                    }
                    sub.append(fresh);
                }
                item.append(sub);
            }

            list.append(item);
        }

        el.replaceChildren(head, list);
    }
}
