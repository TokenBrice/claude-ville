import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    DashboardRenderer,
    SECTION_HEALTH_ORDER,
    nonZeroSectionHealthBuckets,
    sectionHealthCounts,
    shouldFlashForStatus,
} from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { ActivityPanel } from '../../claudeville/src/presentation/shared/ActivityPanel.js';
import { AgentSearchIndex } from '../../claudeville/src/presentation/shared/SearchIndex.js';
import workingSets from '../../claudeville/services/workingSet.js';

const rendererUrl = new URL('../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js', import.meta.url);
const dashboardCssUrl = new URL('../../claudeville/css/dashboard.css', import.meta.url);

function dashboardRows(t, agents) {
    class StubElement {
        children = [];
        dataset = {};
        style = { getPropertyValue() {}, setProperty() {}, removeProperty() {} };
        classList = { contains: () => false, toggle() {}, add() {}, remove() {} };
        setAttribute() {}
        appendChild(child) { this.children.push(child); }
        append(child) { this.appendChild(child); }
        replaceChildren(...children) { this.children = children; }
        contains(child) { return this.children.includes(child); }
    }
    const node = () => new StubElement();
    globalThis.Node = StubElement;
    globalThis.window = new EventTarget();
    globalThis.document = Object.assign(new EventTarget(), {
        getElementById: () => null,
        createElement: node,
        createElementNS: node,
        createTextNode: textContent => ({ textContent }),
    });
    const dash = new DashboardRenderer({ agents: new Map(agents.map(agent => [agent.id, agent])) });
    t.after(() => {
        dash.cards.clear();
        dash.destroy();
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.Node;
    });
    const section = {
        _sectionRefs: { name: node(), count: node(), path: node(), lift: node() },
        style: node().style,
        classList: { toggle: (name, visible) => section.classes.set(name, visible) },
        classes: new Map(),
    };
    dash._updateSectionHealth = () => {};
    dash._rememberStableOrder(agents);
    const render = t.mock.method(dash, 'render', () => {
        const ordered = dash._sortAgentsExceptionFirst(dash._filteredAgents(agents));
        dash._updateSectionHeader(section, '/fixture', ordered);
        for (const agent of ordered) dash._updateCard(dash.cards.get(agent.id), agent);
        section.order = ordered.map(agent => agent.id);
    });
    const fields = ['select', 'name', 'model', 'branch', 'workflowBadge', 'role', 'teamBadge',
        'providerBadge', 'signalSource', 'detailStatus', 'currentTool', 'toolIcon', 'toolName',
        'toolDetail', 'now', 'nowIcon', 'phase', 'phaseDetail', 'searchContext', 'message',
        'workingSet', 'workSummary'];
    for (const agent of agents) dash.cards.set(agent.id, Object.assign(node(), {
        _elements: Object.fromEntries(fields.map(name => [name, node()])),
    }));
    dash.active = true;
    dash.render();
    render.mock.resetCalls();
    return { dash, section, render };
}

for (const startsWithWork of [false, true]) {
    test(`write collisions update one project layout per batch (existing work: ${startsWithWork})`, async (t) => {
        const now = Date.now();
        const agents = Array.from({ length: 25 }, (_, index) => {
            const id = String(index).padStart(2, '0');
            return {
                id, sessionId: id, name: id, project: '/fixture', projectPath: '/fixture', status: 'working',
                workingSet: startsWithWork ? [{ path: `${id}.js`, op: 'read', at: now }] : [],
            };
        });
        const { dash, section, render } = dashboardRows(t, agents);
        const hasWork = () => section.classes.get('dashboard__section--has-work');
        assert.equal(hasWork(), startsWithWork);
        assert.deepEqual(section.order.slice(0, 3), ['00', '01', '02']);
        for (const agent of agents.slice(1, 3)) {
            agent.workingSet = [{ path: 'fixture.js', op: 'write', at: now }, ...agent.workingSet];
        }
        const [collision] = workingSets.detectCollisions(agents, now);
        assert.equal(collision.kind, 'write-write');
        for (const agent of agents) {
            agent.collisions = collision.agents.includes(agent.id) ? [collision] : [];
            eventBus.emit('agent:updated', agent);
        }
        await Promise.resolve();
        eventBus.emit('dashboard:filter-changed', { query: '', matches: agents.map(agent => ({ agentId: agent.id })) });
        await Promise.resolve();
        assert.equal(render.mock.callCount(), 1);
        assert.equal(hasWork(), true);
        assert.deepEqual(section.order.slice(0, 3), ['01', '02', '00']);
        assert.equal(dash.cards.get('01')._elements.workSummary.textContent, '1 overlap · fixture.js');

        render.mock.resetCalls();
        for (const agent of agents) {
            agent.workingSet = [];
            agent.collisions = [];
            eventBus.emit('agent:updated', agent);
        }
        await Promise.resolve();
        assert.equal(render.mock.callCount(), 1);
        assert.equal(hasWork(), false);
        assert.deepEqual(section.order.slice(0, 3), ['00', '01', '02']);

        render.mock.resetCalls();
        agents[0].workingSet = [{ path: 'solo.js', op: 'read', at: now }];
        eventBus.emit('agent:updated', agents[0]);
        await Promise.resolve();
        assert.equal(render.mock.callCount(), 1);
        assert.equal(hasWork(), true);
    });
}

test('checkout and file-search text refresh on the same Dashboard row', async (t) => {
    const agent = {
        id: 'a', name: 'Fixture', status: 'working', provider: 'codex', projectPath: '/fixture',
        gitBranch: 'main', currentToolInput: { path: 'fixture.js' },
    };
    const { dash } = dashboardRows(t, [agent]);
    const index = new AgentSearchIndex();
    index.upsert(agent);
    const row = dash.cards.get(agent.id);
    const { branch, searchContext, select } = row._elements;
    globalThis.document.activeElement = select;
    assert.equal(branch.textContent, 'on main');
    agent.gitBranch = 'fix-light';
    agent.worktree = { name: 'one', path: '/fixture/one', isMain: false };
    eventBus.emit('agent:updated', agent);
    assert.equal(branch.textContent, 'on fix-light · wt one');
    assert.equal(branch.title, 'branch fix-light - worktree /fixture/one');
    eventBus.emit('dashboard:filter-changed', { query: 'fixture.js', matches: index.search('fixture.js', [agent.id]) });
    await Promise.resolve();
    assert.equal(searchContext.textContent, 'File · fixture.js');
    assert.equal(searchContext.style.display, '');

    agent.worktree = { name: 'main', path: '/fixture', isMain: true };
    eventBus.emit('agent:updated', agent);
    eventBus.emit('dashboard:filter-changed', { query: '', matches: index.search('', [agent.id]) });
    await Promise.resolve();
    assert.equal(branch.textContent, 'on fix-light');
    assert.equal(branch.title, 'branch fix-light - worktree /fixture');
    assert.equal(searchContext.textContent, '');
    assert.equal(searchContext.style.display, 'none');
    assert.equal(dash.cards.get(agent.id), row);
    assert.equal(globalThis.document.activeElement, select);
});

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

test('dashboard CSS covers every emitted health-strip class and never shrinks by width', async () => {
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

    // Desktop-only: the one width query widens the layout for ultrawide
    // windows (0.9); nothing shrinks for narrow ones.
    assert.doesNotMatch(dashboardCss, /@media[^\{]*max-width\s*:/i);
    const minWidths = [...dashboardCss.matchAll(/@media[^\{]*min-width\s*:\s*(\d+)px/gi)].map(match => Number(match[1]));
    assert.ok(minWidths.every(width => width >= 2400), `width queries below the ultrawide breakpoint: ${minWidths}`);
});


test('avatar fit preserves wide and tall silhouettes within native niche bounds', async () => {
    const { fitAvatarFrame } = await import('../../claudeville/src/presentation/dashboard-mode/AvatarCanvas.js');
    for (const [width, height] of [[92, 30], [20, 92], [60, 60], [180, 110]]) {
        for (const [maxWidth, maxHeight, integer] of [[40, 46, false], [88, 82, true]]) {
            const fit = fitAvatarFrame(width, height, maxWidth, maxHeight, integer);
            assert.ok(fit.width <= maxWidth && fit.height <= maxHeight);
            assert.ok(Math.abs(fit.width / fit.height - width / height) <= (1 + width / height) / fit.height);
        }
    }
});

test('unknown CLI badges and stale detail never claim another provider or fresh data', async () => {
    const { providerPresentation, detailFreshnessLabel, signalProvenance } = await import('../../claudeville/src/presentation/shared/AgentPresentation.js');
    assert.equal(providerPresentation('new-cli').badge.label, 'new-cli');
    assert.equal(providerPresentation().badge.label, 'Unknown');
    const now = 100000;
    assert.equal(detailFreshnessLabel({}, { hasEntry: true, isFresh: false, entry: { at: now - 12000 } }, now), 'Cached · updated 12s ago');
    assert.equal(detailFreshnessLabel({}, { hasEntry: true, isFresh: true, value: { freshness: { state: 'stale', observedAt: now - 30000 } } }, now), 'Cached · updated 30s ago');
    assert.equal(detailFreshnessLabel({}, { hasEntry: true, isFresh: true }, now), '');
    assert.equal(signalProvenance({ signalSource: 'hook', signalCertainty: 'observed', signalStale: true }), 'HOOK · observed · stale');
    assert.equal(signalProvenance({ signalSource: 'registry' }), 'REGISTRY · observed');
    assert.equal(signalProvenance({ signalSource: 'future-source' }), 'TRANSCRIPT · inferred');
});

test('dashboard cost keeps unavailable billing distinct from observed zero', async () => {
    const { DashboardRenderer } = await import('../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js');
    const footer = agent => DashboardRenderer.prototype._usageFooterFor.call({}, agent, null);
    assert.equal(footer({ tokens: { availability: 'unavailable', contextWindow: 2000 }, provider: 'grok' }).cost, 'Cost unavailable');
    assert.match(footer({ tokens: { availability: 'observed', input: 0, output: 0 }, provider: 'codex' }).cost, /0/);
});

test('Dashboard keeps the live mixed total even when detail supplies newer token counts', () => {
    const agent = { provider: 'claude', model: 'claude-opus-5-5', cost: { usd: 3.22, source: 'mixed' } };
    const detailUsage = { input: 1, output: 1 };
    const footer = DashboardRenderer.prototype._usageFooterFor(agent, detailUsage);
    assert.equal(footer.costShort, '≈$3.22');
    assert.equal(footer.source, 'mixed');
    assert.match(footer.costTitle, /Provider total \+ estimated usage/);
    agent.cost.usd = 4.61;
    assert.equal(DashboardRenderer.prototype._usageFooterFor(agent, detailUsage).costShort, '≈$4.61');
});

test('the Activity Panel labels the combined total in the sheet and pinned cost', t => {
    dashboardRows(t, []);
    const dom = {
        panelEstCost: document.createElement('span'),
        panelCostRow: document.createElement('div'),
        panelCostLabel: document.createElement('span'),
    };
    const agent = { id: 'lead', name: 'Lead', cost: { usd: 3.22, source: 'mixed', availability: 'partial' } };
    const panel = Object.assign(Object.create(ActivityPanel.prototype), { currentAgent: agent, dom });
    const cost = panel._costForUsage({ input: 1, output: 1 });
    panel._renderCost(cost);
    assert.equal(dom.panelEstCost.textContent, '~$3.22');
    assert.equal(dom.panelCostLabel.children[0].textContent, 'mixed · partial');
    assert.match(dom.panelEstCost.title, /Provider total \+ estimated usage/);
    const pinCost = panel._pinCell({ agent, cost }).children[3];
    assert.match(pinCost.title, /Provider total \+ estimated usage/);
    assert.equal(pinCost.children[0].textContent, '~$3.22 · partial');
});

test('seven-provider fixture retains hosted identity, stale certainty and unavailable versus zero usage', async () => {
    const { default: AgentSimulator } = await import('../../claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js');
    const agents = new Map();
    const world = { addAgent: agent => agents.set(agent.id, agent), removeAgent: id => agents.delete(id) };
    const simulator = new AgentSimulator({ world, scenarioId: 'multi-provider-showcase' });
    simulator.start();
    try {
        assert.equal(new Set([...agents.values()].map(agent => agent.provider)).size, 7);
        assert.equal(agents.get('showcase-omp').underlyingProvider, 'zai');
        assert.equal(agents.get('showcase-opencode').underlyingProvider, 'openai');
        assert.equal(agents.get('showcase-grok').cost.usd, null);
        assert.equal(agents.get('showcase-grok').freshness.state, 'stale');
        assert.equal(agents.get('showcase-codex').tokens.availability, 'observed');
        assert.equal(agents.get('showcase-codex').cost.usd, 0);
        assert.equal(agents.get('showcase-codex').signalCertainty, 'observed');
        assert.equal(agents.get('showcase-codex').signalStale, true);
        assert.equal(agents.get('showcase-gemini').tokens.availability, 'partial');
    } finally {
        simulator.stop();
    }
});
