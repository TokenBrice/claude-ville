import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TopBar, usageCoverage, connectionReasonText } from '../../claudeville/src/presentation/shared/TopBar.js';
import { SettingsPanel } from '../../claudeville/src/presentation/shared/SettingsPanel.js';
import {
    DEFAULT_STALE_AFTER_MS,
    initialVillageState,
    LinkState,
    linkStatusText,
} from '../../claudeville/src/application/VillageState.js';
test('connection reasons expose only bounded operator copy', () => {
    const codes = [
        'connection-refused',
        'socket-closed',
        'initial-sync-failed',
        'message-invalid',
        'delta-baseline-mismatch',
        'patch-failed',
        'poll-timeout',
        'session-poll-failed',
        'poll-failed',
        'watcher-unavailable',
        'unknown-normalized-code',
    ];
    for (const code of codes) {
        const copy = connectionReasonText(code);
        assert.equal(copy.includes('/'), false, `${code} produced path-like copy`);
        assert.equal(copy.includes('Error:'), false, `${code} produced stack-like copy`);
        assert.equal(copy.includes('undefined'), false, `${code} produced an undefined value`);
    }
    assert.equal(
        connectionReasonText('unknown-normalized-code'),
        'Connection interrupted; ClaudeVille will keep retrying locally.',
    );
});

test('connection labels require a snapshot and age into stale', () => {
    const now = 2_000_000;
    const syncing = initialVillageState();
    assert.equal(linkStatusText(syncing, now), 'SYNCING');

    const fresh = {
        ...syncing,
        link: {
            ...syncing.link,
            state: LinkState.LIVE,
            lastSnapshotAt: now - 1000,
        },
    };
    assert.equal(linkStatusText(fresh, now), 'LIVE');

    const stale = {
        ...fresh,
        link: {
            ...fresh.link,
            lastSnapshotAt: now - DEFAULT_STALE_AFTER_MS - 1,
        },
    };
    assert.match(linkStatusText(stale, now), /^STALE \/ last seen \d+s ago$/);
});

test('every concrete topbar class emitted by TopBar has a stylesheet rule', async () => {
    const source = await readFile(
        new URL('../../claudeville/src/presentation/shared/TopBar.js', import.meta.url),
        'utf8',
    );
    const css = await readFile(
        new URL('../../claudeville/css/topbar.css', import.meta.url),
        'utf8',
    );
    const classes = new Set(source.match(/topbar__[A-Za-z0-9_-]+/g) || []);
    classes.delete('topbar__spend-section--');
    for (const kind of ['projects', 'providers']) {
        classes.add(`topbar__spend-section--${kind}`);
    }

    const missing = [...classes]
        .filter(className => !css.includes(`.${className}`))
        .sort();
    assert.deepEqual(missing, []);
});


test('a suspended render loop reads as idle in Settings > Health while genuine zero stays 0 FPS', () => {
    const bar = { els: { fps: {} } };
    const healthText = (fps) => {
        TopBar.prototype.renderFps.call(bar, fps);
        const panel = {
            healthFrames: {},
            getCurrentFps: () => bar._lastFps,
            _renderProviders() {},
        };
        SettingsPanel.prototype._refreshOperationalRows.call(panel);
        return panel.healthFrames.textContent;
    };
    for (const suspended of [null, undefined, '', '60', NaN, Infinity, -1]) {
        assert.match(healthText(suspended), /^render loop idle · /, String(suspended));
        assert.equal(bar.els.fps.textContent, 'FPS idle');
    }
    assert.match(healthText(0), /^0 FPS · /);
    assert.equal(bar.els.fps.textContent, '0 FPS');
    assert.match(healthText(60), /^60 FPS · /);
    assert.equal(bar.els.fps.textContent, '60 FPS');
});

test('usage coverage distinguishes observed zero, partial counts and unavailable billing', () => {
    assert.deepEqual(usageCoverage([
        { tokens: { input: 0, output: 0, availability: 'observed' } },
        { tokens: { input: 20, availability: 'partial' } },
        { tokens: { contextWindow: 100, availability: 'unavailable' } },
    ]), { observed: 1, partial: 1, unavailable: 1 });
});

test('the lit slot counts needs-you, errored and rate-limited agents exactly, hides when empty, and waits for the first snapshot', () => {
    let stats = { working: 4, idle: 2, waiting: 0, needsYou: 1, errors: 0, quota: 0 };
    const part = () => ({ part: {}, num: {} });
    const bar = Object.assign(Object.create(TopBar.prototype), {
        world: { getStats: () => stats },
        els: {
            working: {}, idle: {}, waiting: {},
            attention: { dataset: {} },
            attentionParts: { needsYou: part(), errors: part(), quota: part() },
        },
        _villageState: { phase: 'ready-live', link: { lastSnapshotAt: 1 } },
        _unknownModelSeenToday() {}, _renderSpend() {}, _renderActivityRail() {},
    });
    const { attention, attentionParts } = bar.els;
    TopBar.prototype.render.call(bar);
    assert.equal(bar.els.waiting.textContent, '0');
    assert.equal(attention.hidden, false);
    assert.equal(attentionParts.needsYou.num.textContent, '1');
    assert.equal(attentionParts.errors.part.hidden, true);

    // A rate-limited or errored agent alone still lights the slot, in its own
    // bucket, never folded into generic waiting.
    stats = { ...stats, waiting: 1, needsYou: 0, quota: 1 };
    TopBar.prototype.render.call(bar);
    assert.equal(bar.els.waiting.textContent, '1');
    assert.equal(attention.hidden, false);
    assert.equal(attention.dataset.lead, 'quota');
    assert.equal(attentionParts.needsYou.part.hidden, true);
    assert.equal(attentionParts.quota.num.textContent, '1');
    stats = { ...stats, quota: 0, errors: 2 };
    TopBar.prototype.render.call(bar);
    assert.equal(attention.dataset.lead, 'errors');
    assert.equal(attentionParts.errors.num.textContent, '2');
    stats = { ...stats, errors: 0 };
    TopBar.prototype.render.call(bar);
    assert.equal(attention.hidden, true);

    // Before the first snapshot a count is unknown, not zero, and the loud
    // slot never claims an agent it has not seen.
    stats = { working: 0, idle: 0, waiting: 0, needsYou: 3, errors: 1, quota: 1 };
    bar._villageState = { phase: 'syncing', link: { lastSnapshotAt: null } };
    TopBar.prototype.render.call(bar);
    assert.equal(bar.els.working.textContent, '–');
    assert.equal(bar.els.waiting.textContent, '–');
    assert.equal(attention.hidden, true);
});

// Exercise the real sampler with deterministic frame pacing and suspension.
test('FPS counts elapsed intervals accurately and excludes suspended time', async () => {
    const { IsometricRenderer } = await import('../../claudeville/src/presentation/character-mode/IsometricRenderer.js');
    const { eventBus } = await import('../../claudeville/src/domain/events/DomainEvent.js');
    const samples = [];
    const off = eventBus.on('fps:updated', value => samples.push(value));
    const renderer = { frameId: null };
    const frame = now => IsometricRenderer.prototype._trackFps.call(renderer, now);
    try {
        for (const hz of [30, 60, 120, 144]) {
            IsometricRenderer.prototype._stopLoop.call(renderer);
            for (let i = 0; i <= hz; i++) frame(i * 1000 / hz);
            assert.equal(samples.at(-1), hz);
        }
        IsometricRenderer.prototype._stopLoop.call(renderer);
        assert.equal(samples.at(-1), null);
        frame(100000);
        assert.equal(samples.at(-1), null);
        frame(100500);
        assert.equal(samples.at(-1), 2);
        frame(101500);
        assert.equal(samples.at(-1), 1, 'a long frame must lower the sample');
    } finally {
        off();
    }
});
