import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    SECTION_HEALTH_ORDER,
    nonZeroSectionHealthBuckets,
    sectionHealthCounts,
    shouldFlashForStatus,
} from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';

const rendererUrl = new URL('../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js', import.meta.url);
const dashboardCssUrl = new URL('../../claudeville/css/dashboard.css', import.meta.url);

test('section health keeps all six SignalLedger buckets distinct', () => {
    const agents = [
        { id: 'error', status: 'errored' },
        { id: 'blocked', status: 'waiting_on_user' },
        { id: 'quota', status: 'rate_limited' },
        { id: 'working', status: 'working' },
        { id: 'waiting', status: 'waiting' },
        { id: 'completed', status: 'completed' },
    ];

    const counts = sectionHealthCounts(agents);

    assert.deepEqual(counts, {
        errors: 1,
        needsYou: 1,
        quota: 1,
        working: 1,
        watchlist: 1,
        idle: 1,
    });
    assert.equal(counts.errors, 1, 'blocked and quota agents must not increment errors');
});

test('section edge flash is reserved for genuine errors', () => {
    assert.equal(shouldFlashForStatus('errored'), true);
    assert.equal(shouldFlashForStatus('waiting_on_user'), false);
    assert.equal(shouldFlashForStatus('rate_limited'), false);
});

test('health buckets retain stable order and omit zero counts', () => {
    assert.deepEqual(SECTION_HEALTH_ORDER, [
        'errors',
        'needsYou',
        'quota',
        'working',
        'watchlist',
        'idle',
    ]);
    assert.deepEqual(nonZeroSectionHealthBuckets({
        errors: 1,
        needsYou: 0,
        quota: 2,
        working: 0,
        watchlist: 3,
        idle: 0,
    }), ['errors', 'quota', 'watchlist']);
});

test('dashboard CSS covers every emitted health-strip class without width media queries', async () => {
    const [rendererSource, dashboardCss] = await Promise.all([
        readFile(rendererUrl, 'utf8'),
        readFile(dashboardCssUrl, 'utf8'),
    ]);
    const presentationSource = rendererSource.match(
        /const SECTION_HEALTH_PRESENTATION = Object\.freeze\(\{([\s\S]*?)\n\}\);/,
    )?.[1];

    assert.ok(presentationSource, 'health presentation map must remain discoverable');
    const suffixes = [...presentationSource.matchAll(/className: '([^']+)'/g)]
        .map(match => match[1]);
    assert.equal(suffixes.length, SECTION_HEALTH_ORDER.length);

    const emittedClasses = [
        'dashboard__section-health',
        'dashboard__section-healthbar',
        'dashboard__section--errored-flash',
        'dashboard__health-stat',
        'dashboard__healthbar-seg',
        ...suffixes.flatMap(suffix => [
            `dashboard__health-stat--${suffix}`,
            `dashboard__healthbar-seg--${suffix}`,
        ]),
    ];
    for (const className of emittedClasses) {
        assert.match(
            dashboardCss,
            new RegExp(`\\.${className.replaceAll('-', '\\-')}(?![\\w-])`),
            `missing dashboard CSS for .${className}`,
        );
    }

    assert.doesNotMatch(dashboardCss, /@media[^\{]*(?:min|max)-width\s*:/i);
});
