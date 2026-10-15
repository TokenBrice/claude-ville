import test from 'node:test';
import assert from 'node:assert/strict';

// Final review (08-codex-final-review.md) items #7–#10, Phase-4 scope.

// ─── a tiny DOM, enough for the fleet card and the Harbor Log ──────────────
class FakeNode {
    constructor(tagName = 'div') {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this._text = '';
        this.className = '';
        const style = {};
        style.setProperty = (name, value) => { style[name] = value; };
        style.removeProperty = (name) => { delete style[name]; };
        this.style = style;
        const self = this;
        this.classList = {
            add: (...names) => { self.className = [...new Set([...self.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
            remove: (...names) => { self.className = self.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
            toggle: (name, on) => { (on ?? !self.classList.contains(name)) ? self.classList.add(name) : self.classList.remove(name); },
            contains: (name) => self.className.split(/\s+/).includes(name),
        };
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); }
    append(...nodes) {
        for (const node of nodes) {
            const child = node instanceof FakeNode ? node : Object.assign(new FakeNode('#text'), { _text: String(node) });
            child.parentNode = this;
            this.children.push(child);
        }
    }
    appendChild(node) { this.append(node); return node; }
    after(node) { node.parentNode = this.parentNode; this.parentNode?.children.push(node); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
    matches(selector) {
        const focus = selector.match(/^\[data-focus-key="(.*)"\]$/);
        if (focus) return this.dataset.focusKey === focus[1];
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        return false;
    }
    querySelector(selector) { for (const node of this.walk()) if (node.matches(selector)) return node; return null; }
    closest(selector) { for (let n = this; n; n = n.parentNode) if (n.matches?.(selector)) return n; return null; }
    focus() { globalThis.document.activeElement = this; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; }
    get offsetWidth() { return 300; }
    get offsetHeight() { return 200; }
}

function installDom() {
    globalThis.Node = FakeNode;
    globalThis.HTMLElement = FakeNode;
    globalThis.document = {
        activeElement: null,
        documentElement: new FakeNode('html'),
        createElement: tag => new FakeNode(tag),
        createTextNode: text => Object.assign(new FakeNode('#text'), { _text: String(text) }),
    };
}

// ─── #7 fleet card keyboard ────────────────────────────────────────────────

test('#7: the fleet card is outside World keyboard handling, and a refresh keeps focus', async () => {
    installDom();
    const { HarborFleetCard, buildFleetCardModel, isInFleetCard } = await import('../../claudeville/src/presentation/shared/HarborFleetCard.js');
    const ships = [
        { id: 'a1', project: '/w/cv', branch: 'main', status: 'docked', sha: 'a1aaaaaa', label: 'one', eventTime: 1, agentId: 'wren' },
        { id: 'b1', project: '/w/cv', branch: 'feat', status: 'docked', sha: 'b1bbbbbb', label: 'two', eventTime: 2, agentId: 'wren' },
    ];
    const options = { now: 10, agentName: () => 'Wren', nameFor: () => 'cv', profileFor: () => ({ accent: '#123456' }) };
    const host = new FakeNode('div');
    const card = new HarborFleetCard({ host });
    card.open(buildFleetCardModel({ ships }, { project: '/w/cv', branch: 'main' }, options), {}, { focus: true });

    assert.equal(document.activeElement, card.el, 'focus moves into the card');
    assert.equal(isInFleetCard(card.el), true);
    const chip = card.el.querySelector('[data-focus-key="lane:feat"]');
    assert.ok(chip, 'lane chip present');
    assert.equal(isInFleetCard(chip), true, 'its controls belong to the card, not the World');
    assert.equal(isInFleetCard(new FakeNode('canvas')), false);

    chip.focus();
    card.refresh(buildFleetCardModel({ ships: [...ships, { ...ships[0], id: 'a2', eventTime: 3 }] }, { project: '/w/cv', branch: 'main' }, options));
    const rebuilt = card.el.querySelector('[data-focus-key="lane:feat"]');
    assert.notEqual(rebuilt, chip, 'the refresh rebuilt the control');
    assert.equal(document.activeElement, rebuilt, 'focus returns to the same control');
    card.close();
});

test('#7: World keyboard commands do nothing while focus is in the card', async () => {
    installDom();
    const { IsometricRenderer } = await import('../../claudeville/src/presentation/character-mode/IsometricRenderer.js');
    const cardEl = new FakeNode('section');
    cardEl.className = 'harbor-fleet-card';
    const button = new FakeNode('button');
    cardEl.append(button);
    document.activeElement = button;
    let cycled = 0;
    const fake = {
        _worldModeActive: true,
        camera: {},
        _isKeyboardEditTarget: () => false,
        _isModalOpen: () => false,
        _worldOwnsFocus: () => true,
        _cycleAgentSelection: () => { cycled++; return true; },
        setReadMode: () => { cycled++; },
    };
    let prevented = false;
    IsometricRenderer.prototype._handleWorldKeyboardCommand.call(fake, { code: 'Tab', preventDefault: () => { prevented = true; } });
    IsometricRenderer.prototype._handleWorldKeyboardCommand.call(fake, { code: 'KeyB', preventDefault: () => { prevented = true; } });
    assert.equal(cycled, 0);
    assert.equal(prevented, false, 'Tab moves focus inside the card as usual');
});

// ─── #8 harbor semantics while the World loop is stopped ───────────────────

test('#8: harbor reconciliation runs while the World loop is stopped and only then', async () => {
    installDom();
    document.hidden = false;
    const { IsometricRenderer } = await import('../../claudeville/src/presentation/character-mode/IsometricRenderer.js');
    const { eventBus } = await import('../../claudeville/src/domain/events/DomainEvent.js');
    let reconciled = 0;
    let rows = [{ project: '/w/cv', branch: 'main', pendingCommits: 2 }];
    const fake = {
        frameId: null,
        world: { agents: new Map([['a', { id: 'a' }]]) },
        harborTraffic: {
            reconcile: () => { reconciled++; },
            getFailedPushState: () => null,
            getPendingRepoSummaries: () => rows,
        },
        _harborPendingSignature: '',
        _harborPendingReposSignature: IsometricRenderer.prototype._harborPendingReposSignature,
    };
    const published = [];
    const off = eventBus.on('harbor:updated', repos => published.push(repos));
    try {
        const run = () => IsometricRenderer.prototype._reconcileHarborWhileWorldStopped.call(fake);
        assert.equal(run(), true);
        assert.equal(reconciled, 1);
        assert.equal(published.length, 1, 'the Dashboard chip and sidebar hear the new rows');
        run();
        assert.equal(published.length, 1, 'an unchanged ledger publishes nothing');
        rows = [{ project: '/w/cv', branch: 'main', pendingCommits: 0, failedPushes: 1 }];
        run();
        assert.equal(published.length, 2);
        fake.frameId = 7;
        assert.equal(run(), false, 'the World loop reconciles for itself: no double work');
        assert.equal(reconciled, 3);
    } finally {
        off();
    }
});

// ─── #9 Harbor Log cargo invalidation ──────────────────────────────────────

test('#9: a departing ship flips its commit from unpushed to pushed in the Harbor Log', async () => {
    installDom();
    const { ActivityPanel } = await import('../../claudeville/src/presentation/shared/ActivityPanel.js');
    const ship = { id: 'c1', eventIds: ['c1'], status: 'docked' };
    const panel = Object.create(ActivityPanel.prototype);
    Object.assign(panel, {
        _mode: 'agent',
        _renderSignatures: {},
        _harborLogSectionEl: new FakeNode('section'),
        _harborLogBodyEl: new FakeNode('div'),
        _dependencies: { harborTraffic: () => ({ state: { ships: new Map([['c1', ship]]) } }) },
    });
    const agent = {
        id: 'wren',
        name: 'Wren',
        gitEvents: [{ id: 'c1', type: 'commit', sha: 'c1c1c1c1c1', label: 'Fix plates', branch: 'main', timestamp: 1000, project: '/w/cv' }],
    };
    panel._updateHarborLog(agent);
    assert.match(panel._harborLogBodyEl.textContent, /unpushed/);
    ship.status = 'departing';
    panel._updateHarborLog(agent);
    assert.doesNotMatch(panel._harborLogBodyEl.textContent, /unpushed/);
    assert.match(panel._harborLogBodyEl.textContent, /pushed/);
});

// ─── #10 Chronicle push failures ───────────────────────────────────────────

test('#10: parser-only push failures reach the Chronicle; retries log per occurrence', async () => {
    const { ChronicleLog, ChronicleEventKind } = await import('../../claudeville/src/application/ChronicleLog.js');
    const now = Date.now();
    const recorded = [];
    const log = Object.create(ChronicleLog.prototype);
    log._seenGitEvents = new Set();
    log.record = (kind, agent, extra) => recorded.push({ kind, ...extra });
    const push = (id, extra) => ({ id, type: 'push', commandHash: 'same-command', remote: 'origin', branch: 'main', completedAt: now - 1000, ...extra });
    const agent = { id: 'k', name: 'Kestrel', gitEvents: [
        push('p1', { status: 'rejected', success: false, exitCode: 1 }),
        push('p2', { status: 'success', success: true, exitCode: 0 }),
        push('p3', {}), // still in flight: waits
    ] };
    log._noteGitEvents(agent);
    assert.deepEqual(recorded.map(row => [row.kind, row.label, row.outcome || 'landed']), [
        [ChronicleEventKind.PUSH, 'origin main', 'rejected'],
        [ChronicleEventKind.PUSH, 'origin main', 'landed'],
    ]);
    log._noteGitEvents(agent);
    assert.equal(recorded.length, 2, 'each occurrence logs once');
    agent.gitEvents[2] = push('p3', { status: 'failed', success: false });
    log._noteGitEvents(agent);
    assert.equal(recorded.length, 3);
    assert.equal(recorded[2].outcome, 'failed');
});

test('R7: two pushes in one tool call and successive synthetic pushes each log', async () => {
    const { ChronicleLog } = await import('../../claudeville/src/application/ChronicleLog.js');
    const now = Date.now();
    const recorded = [];
    const log = Object.create(ChronicleLog.prototype);
    log._seenGitEvents = new Set();
    log.record = (kind, agent, extra) => recorded.push(extra);
    const agent = { id: 'k', name: 'Kestrel', gitEvents: [
        // One tool call, two chained pushes: same sourceId, segment ids differ.
        { id: 'git-push-call7-0', sourceId: 'call7', type: 'push', remote: 'origin', branch: 'main', status: 'success', completedAt: now - 3000 },
        { id: 'git-push-call7-1', sourceId: 'call7', type: 'push', remote: 'origin', branch: 'feat', status: 'rejected', success: false, completedAt: now - 2000 },
        // Successive synthetic transition pushes share their sourceId.
        { id: 'git-push-transition-a', sourceId: 'git-upstream-transition', type: 'push', remote: 'origin', branch: 'main', status: 'success', completedAt: now - 1500 },
        { id: 'git-push-transition-b', sourceId: 'git-upstream-transition', type: 'push', remote: 'origin', branch: 'main', status: 'success', completedAt: now - 1000 },
    ] };
    log._noteGitEvents(agent);
    assert.deepEqual(recorded.map(row => `${row.label}:${row.outcome || 'landed'}`), [
        'origin main:landed', 'origin feat:rejected', 'origin main:landed', 'origin main:landed',
    ]);
    log._noteGitEvents(agent);
    assert.equal(recorded.length, 4, 'each occurrence and outcome logs once');
});
