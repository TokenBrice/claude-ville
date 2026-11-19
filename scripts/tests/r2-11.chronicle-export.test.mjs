import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildChronicleCsv,
    buildChronicleMarkdown,
    buildHallOfLives,
    ChroniclePanel,
    csvEscapeCell,
    HALL_OF_LIVES_CHAPTER_LIMIT,
    retoldVillageHref,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import { ChronicleEventKind, chronicleDateKey, summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';
import { SpendLedger } from '../../claudeville/src/application/SpendLedger.js';

const DAY = chronicleDateKey();

function localTimestamp(dayOffset = 0) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    date.setHours(9, 5, 0, 0);
    return date.getTime();
}

function event(overrides = {}) {
    return {
        ts: localTimestamp(),
        kind: ChronicleEventKind.COMMIT,
        agentName: 'Ada',
        provider: 'codex',
        project: 'village',
        label: 'Ship the chronicle',
        ...overrides,
    };
}

test('Markdown export is a paste-ready selected-day recap with optional spend', () => {
    const events = [event()];
    const markdown = buildChronicleMarkdown({
        dateKey: DAY,
        events,
        summary: summarizeDay(events),
        spend: { tokens: 1200, cacheRead: 300, cost: 0.12, costLabel: 'Est. cost' },
    });

    assert.ok(markdown.startsWith(`# Chronicle — ${DAY}`));
    assert.match(markdown, /## Summary/);
    assert.match(markdown, /## Spend summary/);
    assert.match(markdown, /\| Commits \| 1 \|/);
    assert.match(markdown, /\| Ada committed Ship the chronicle · village \|/);
    assert.doesNotMatch(markdown, /```|\{\s*"/);
});

test('SG-4: both historical exports disclose coverage, missing days and recorded zero', () => {
    const coverageSince = localTimestamp(-1);
    const dateKey = chronicleDateKey(coverageSince);
    const data = { dateKey, spend: {
        tokens: 0, cacheRead: 0, cost: 0, costLabel: 'Recorded cost', coverageSince, historical: true,
    } };
    const markdown = buildChronicleMarkdown(data);
    const csv = buildChronicleCsv(data);
    assert.match(markdown, /\| New tokens \| 0 \|/);
    assert.match(markdown, /\| Recorded cost \| \$0\.00 \|/);
    assert.match(markdown, /\| Coverage began \| 09:05 \|/);
    assert.match(csv, new RegExp(`spend,${dateKey},,+New tokens,0`));
    assert.match(csv, new RegExp(`spend,${dateKey},,+Coverage began,${coverageSince}`));
    for (const output of [markdown, csv]) {
        assert.match(output, /this browser/);
        assert.match(output, /Per-model totals are unavailable/);
    }
    for (const build of [buildChronicleMarkdown, buildChronicleCsv]) {
        const missing = build({ dateKey });
        assert.match(missing, /No spend record was saved for this day/);
        assert.doesNotMatch(missing, /New tokens|Recorded cost/);
    }
});

test('CSV quotes special cells and neutralizes formula-leading cells', () => {
    assert.equal(csvEscapeCell('a,b'), '"a,b"');
    assert.equal(csvEscapeCell('say "hello"'), '"say ""hello"""');
    assert.equal(csvEscapeCell('line\nbreak'), '"line\nbreak"');
    for (const formula of ['=SUM(A1)', '+cmd', '-2+3', '@mention']) {
        assert.equal(csvEscapeCell(formula), `'${formula}`);
    }

    const csv = buildChronicleCsv({
        dateKey: DAY,
        events: [event({
            kind: ChronicleEventKind.WAITING,
            agentName: '=HYPERLINK("https://unsafe.example")',
            project: 'alpha, beta',
            reason: 'line one\nline two',
            tool: '@approval',
        })],
    });
    assert.match(csv, /row_type,date,time,glyph,event/);
    assert.match(csv, /"alpha, beta"/);
    assert.match(csv, /"line one\nline two"/);
    assert.match(csv, /'=HYPERLINK\(""https:\/\/unsafe\.example""\)/);
    assert.match(csv, /'@approval/);
    assert.match(csv, /\r\n$/);
});

test('SG-4: the last selected day wins a slow spend read and its export reuses the displayed record', async () => {
    const historicalKey = chronicleDateKey(localTimestamp(-1));
    const olderKey = chronicleDateKey(localTimestamp(-2));
    const calls = [];
    const pending = new Map();
    const log = {
        async readDayPage() { return { events: [], summary: summarizeDay([]), totalCount: 0 }; },
        async readDay(dateKey) {
            calls.push(dateKey);
            return Array.from({ length: 101 }, (_, index) => event({
                ts: new Date(2026, 7, 24, 8, index).getTime(),
            }));
        },
    };
    const panel = new ChroniclePanel({
        modal: { isRequestCurrent: request => request === 1 },
        chronicleLog: log,
        spendLedger: { readDay: dateKey => new Promise(resolve => pending.set(dateKey, resolve)) },
    });
    panel._request = 1;
    panel._selectedDateKey = DAY;
    const pages = [];
    panel._renderPage = (page, dateKey) => pages.push({ page, dateKey });
    const oldRead = panel._showDate(olderKey, 1);
    const latestRead = panel._showDate(historicalKey, 1);
    pending.get(historicalKey)({ tokens: 30, cacheRead: 200, cost: 0.5, largest: { kind: 'project', key: '/repo/two/shared' } });
    await latestRead;
    pending.get(olderKey)(null);
    await oldRead;
    assert.deepEqual(pages.map(page => page.dateKey), [historicalKey]);

    const data = await panel._readExportData(historicalKey);
    assert.deepEqual(calls, [historicalKey]);
    assert.equal(data.events.length, 101);
    assert.strictEqual(data.spend, pages[0].page.spend);
    for (const build of [buildChronicleMarkdown, buildChronicleCsv]) {
        assert.match(build(data), /Largest project by new tokens.+\/repo\/two\/shared/);
    }

    const cancelledRead = panel._showDate(olderKey, 1);
    await panel._showDate(historicalKey, 1);
    pending.get(olderKey)(null);
    await cancelledRead;
    assert.equal(panel._selectedDateKey, historicalKey);
});

test('R1-1: a spend read failure leaves the selected timeline and its exports available', async t => {
    const dateKey = chronicleDateKey(localTimestamp(-1));
    const events = [event({ ts: localTimestamp(-1) })];
    const panel = new ChroniclePanel({
        modal: { isRequestCurrent: request => request === 1 },
        chronicleLog: { async readDay() { return events; } },
        spendLedger: new SpendLedger(null, {
            store: { async get() { throw new Error('IndexedDB meta read failed'); } },
        }),
    });
    panel._request = 1;
    let rendered;
    panel._renderPage = page => { rendered = page; };
    await panel._showDate(dateKey, 1);
    assert.equal(panel._selectedDateKey, dateKey);
    assert.deepEqual(rendered.events, events);

    const { document, Node } = globalThis;
    t.after(() => Object.assign(globalThis, { document, Node }));
    globalThis.Node = class {};
    globalThis.document = {
        createElement: tag => ({ tag, classList: { add() {} }, append(text) { this.textContent = text; } }),
        createTextNode: text => text,
    };
    const rows = panel._spendNodes(rendered.spend, dateKey);
    assert.deepEqual(rows.map(({ tag, textContent }) => [tag, textContent]), [
        ['p', 'Spend ledger · Could not read the spend ledger for this day.'],
    ]);

    const data = await panel._readExportData(dateKey);
    assert.strictEqual(data.spend, rendered.spend);
    for (const build of [buildChronicleMarkdown, buildChronicleCsv]) {
        const output = build(data);
        assert.match(output, /Could not read the spend ledger for this day/);
        assert.match(output, /Ada committed Ship the chronicle/);
        assert.doesNotMatch(output, /No spend record was saved|New tokens/);
    }
});

test('XP-2: only a day with trail samples offers WATCH THIS DAY, opening ?retold=<date>', async () => {
    const withSamples = chronicleDateKey(localTimestamp(-1));
    const log = {
        async readDay() { return []; },
        async hasTrailSamples(dateKey) { return dateKey === withSamples; },
    };
    const panel = new ChroniclePanel({ modal: { isRequestCurrent: request => request === 1 }, chronicleLog: log });
    assert.equal((await panel._readPage(withSamples)).replayable, true);
    assert.equal((await panel._readPage(DAY)).replayable, false);
    const failing = new ChroniclePanel({
        modal: {},
        chronicleLog: { async readDay() { return []; }, async hasTrailSamples() { throw new Error('closed'); } },
    });
    assert.equal((await failing._readPage(DAY)).replayable, false, 'an unreadable store offers nothing');
    const simulated = new ChroniclePanel({ modal: {}, chronicleLog: log, liveHistory: false });
    assert.equal((await simulated._readPage(withSamples)).replayable, false, 'simulator samples never offer the live replay');
    const legacy = new ChroniclePanel({ modal: {}, chronicleLog: { async readDay() { return []; } } });
    assert.equal((await legacy._readPage(DAY)).replayable, false);
    assert.equal(retoldVillageHref('/', '2026-11-18'), '/?retold=2026-11-18');
    assert.equal(retoldVillageHref('/m/', '2026-11-18'), '/m/?retold=2026-11-18');
});

test('XP-8: the Hall of Lives lists remembered lineages by last seen, with no stats or ranks', () => {
    const now = Date.UTC(2026, 10, 19, 12);
    const day = 86_400_000;
    const episodes = Array.from({ length: 6 }, (_, index) => ({
        id: `e${index}`, kind: index % 2 ? 'commit' : 'completed', at: now - day + index * 1000, project: 'claude-ville',
    }));
    const lives = buildHallOfLives([
        { identityKey: 'project:claude:claude-ville', firstSeenAt: now - 40 * day, lastSeenAt: now - 2 * day,
            sessionsCompleted: 900, commitsPushed: 400, milestones: [], extensions: { lifeEpisodes: episodes } },
        { identityKey: 'named:codex:r-d', displayName: 'R&D', firstSeenAt: now - 9 * day, lastSeenAt: now - day,
            sessionsCompleted: 1, milestones: [{ id: 'nickname-commitsPushed-25', kind: 'nickname', nickname: 'the Shipwright', at: now - day }] },
        { identityKey: 'anonymous:claude:session-1', firstSeenAt: now, lastSeenAt: now },
        { identityKey: '', lastSeenAt: now },
        null,
    ], { now });
    assert.deepEqual(lives.map(life => life.identityKey), ['named:codex:r-d', 'project:claude:claude-ville'],
        'session-scoped rows are not lineages; order is last seen, not stats');
    const [ada, lead] = lives;
    assert.equal(ada.name, 'R&D', 'the saved display name, as authored');
    assert.equal(ada.nickname, 'the Shipwright');
    assert.match(ada.role, /villager$/);
    assert.equal(lead.name, 'claude-ville', 'a legacy row without a saved name keeps its slug untouched');
    assert.match(lead.role, /project lead$/);
    assert.equal(lead.chapters.length, HALL_OF_LIVES_CHAPTER_LIMIT);
    assert.equal(lead.chapters[0].at, episodes.at(-1).at, 'newest chapter first');
    for (const life of lives) {
        for (const key of ['sessionsCompleted', 'commitsPushed', 'lifetimeTokens', 'errorsRecovered', 'rank', 'total']) {
            assert.equal(Object.hasOwn(life, key), false, key);
        }
    }
});

test('XP-8: the Hall keeps the name a lineage last wore, and a returned Day book is not reopened by a slow Hall read', async () => {
    const { AgentBiography } = await import('../../claudeville/src/domain/value-objects/AgentBiography.js');
    const biography = AgentBiography.fromRecord({ identityKey: 'project:claude:claude-ville', displayName: 'Wren', firstSeenAt: 1 });
    assert.equal(biography.toRecord().displayName, 'Wren');
    assert.equal(Object.hasOwn(AgentBiography.fromRecord({ identityKey: 'named:x:y', firstSeenAt: 1 }).toRecord(), 'displayName'), false);
    assert.equal(buildHallOfLives([biography.toRecord()])[0].name, 'Wren');

    let release;
    const modal = { contentEl: {}, isRequestCurrent: request => request === 1 };
    const panel = new ChroniclePanel({ modal, chronicleLog: { readBiographies: () => new Promise(resolve => { release = resolve; }) } });
    panel._request = 1;
    const rendered = [];
    panel._renderHall = lives => { rendered.push('hall'); return []; };
    panel._tabs = () => 'tabs';
    panel._renderPage = () => rendered.push('day');
    panel._selectedPage = { events: [] };
    const hall = panel._showHall(1);
    panel._showDayBook(1);
    release([]);
    await hall;
    assert.deepEqual(rendered, ['day'], 'the slower Hall read is dropped after the switch back');
});
