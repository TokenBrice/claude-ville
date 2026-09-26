import test from 'node:test';
import assert from 'node:assert/strict';

import { Toast, formatCueCaption } from '../../claudeville/src/presentation/shared/Toast.js';

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
    }

    add(value) {
        const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
        names.add(value);
        this.owner.className = [...names].join(' ');
    }
}

class FakeElement {
    constructor() {
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.attributes = new Map();
        this.textContent = '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }
}

class MemoryStorage {
    constructor(entries = {}) {
        this.values = new Map(Object.entries(entries));
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }
}

// Sound on and `Everything I can hear` unless a test says otherwise, so the
// copy and stacking tests see every stratum.
const HEAR_EVERYTHING = Object.freeze({
    'claudeville.sound.enabled': 'true',
    'claudeville.captions': 'all',
});

function harness(storage = new MemoryStorage(HEAR_EVERYTHING)) {
    const container = new FakeElement();
    const listeners = new Map();
    const eventTarget = {
        on(name, listener) {
            listeners.set(name, listener);
            return () => listeners.delete(name);
        },
        emit(name, payload) {
            listeners.get(name)?.(payload);
        },
    };
    const documentRef = {
        getElementById(id) { return id === 'toastContainer' ? container : null; },
        createElement() { return new FakeElement(); },
    };
    const toast = new Toast({ eventTarget, documentRef, storage });
    return {
        container,
        eventTarget,
        toast,
        cleanup() {
            toast.destroy();
        },
    };
}

test('cue copy names agents and translates internal cue kinds', () => {
    assert.equal(formatCueCaption({ kind: 'summons', agentId: 'a-1', label: 'Aurora' }), 'Aurora needs you');
    assert.equal(formatCueCaption({ kind: 'arrival', agentId: 'a-1', label: 'Aurora' }), 'Aurora arrived');
    assert.equal(formatCueCaption({ kind: 'distress', agentId: 'a-1', label: 'Aurora' }), 'Aurora hit an error');
    assert.equal(formatCueCaption({ kind: 'limit', agentId: 'a-1', label: 'Aurora' }), 'Aurora is rate limited');
    assert.equal(formatCueCaption({ kind: 'limit', agentId: null, label: 'is rate limited' }), 'An agent is rate limited');
    assert.equal(formatCueCaption({ kind: 'distress', agentId: 'a-1', label: 'hit an error' }, 'Aurora'), 'Aurora hit an error');
    assert.equal(formatCueCaption({ kind: 'hourBell', agentId: null, label: '' }), 'Hour bell');
    assert.equal(formatCueCaption({ kind: 'summons', label: 'Aurora needs you' }), 'Aurora needs you');
    assert.equal(formatCueCaption({ kind: 'summons', label: 'is waiting for approval' }), 'An agent is waiting for approval');
    assert.equal(
        formatCueCaption({ kind: 'summons', agentId: 'a-1', label: 'is waiting for approval' }, 'Aurora'),
        'Aurora is waiting for approval',
    );
    assert.equal(formatCueCaption(null), '');
});

test('fact captions state the exact fact for every Wave-3 kind', () => {
    const cases = [
        [{ kind: 'reminder', agentId: 'a-1', label: 'Aurora', count: 2, family: 'needsYou', oldestMs: 6 * 60_000 }, '2 waiting · oldest 6 min'],
        [{ kind: 'reminder', agentId: 'a-1', label: 'Aurora', count: 1, family: 'needsYou', oldestMs: 2 * 60_000 }, 'Aurora still needs you · 2 min'],
        [{ kind: 'reminder', agentId: 'a-1', label: 'Aurora', count: 3, family: 'errors', oldestMs: 15 * 60_000 }, '3 with errors · oldest 15 min'],
        [{ kind: 'reminder', agentId: 'a-1', label: 'Aurora', count: 1, family: 'quota', oldestMs: 2 * 60_000 }, 'Aurora is still rate limited · 2 min'],
        [{ kind: 'answered', agentId: 'a-1', label: 'Aurora' }, 'Aurora was answered'],
        [{ kind: 'turnDone', agentId: null, label: 'turnDone', count: 4 }, '4 turns finished'],
        [{ kind: 'turnDone', agentId: 'a-1', label: 'Aurora', count: 1 }, 'Aurora finished a turn'],
        [{ kind: 'subagentReturn', agentId: 'a-1', label: 'Aurora' }, 'A sub-agent returned to Aurora'],
        [{ kind: 'subagentReturn', agentId: null, label: 'subagentReturn', count: 3 }, '3 sub-agents returned'],
        [{ kind: 'toolFailed', agentId: 'a-1', label: 'Aurora' }, 'Aurora: a command failed'],
        [{ kind: 'commit', agentId: 'a-1', label: 'Aurora', repo: 'claude-ville' }, 'Aurora committed to claude-ville'],
        [{ kind: 'push', agentId: 'a-1', label: 'Aurora', repo: 'claude-ville' }, 'Aurora pushed claude-ville'],
        [{ kind: 'release', agentId: 'a-1', label: 'Aurora', version: 'v0.47.0' }, 'v0.47.0 released'],
        [{ kind: 'pushFailed', agentId: 'a-1', label: 'Aurora' }, 'Aurora: git push failed'],
        [{ kind: 'dispatch', agentId: 'a-1', label: 'Aurora', count: 3 }, 'Aurora dispatched 3 sub-agents'],
        [{ kind: 'council', agentId: null, label: 'Council gathering', teamName: 'Harbor', teamSize: 5 }, 'Harbor gathered (5)'],
        [{ kind: 'hourBell', agentId: null, label: 'Hour bell', hour: 15 }, "Hour bell · 3 o'clock"],
        [{ kind: 'hourBell', agentId: null, label: 'Hour bell', hour: 0 }, "Hour bell · 12 o'clock"],
        [{ kind: 'aurora', agentId: null, label: 'Chronicle milestone' }, 'Village milestone reached'],
        [{ kind: 'thunder', agentId: null, label: 'Thunder' }, 'Thunder'],
        [{ kind: 'linkLost', agentId: null, label: '' }, 'Live feed lost'],
        [{ kind: 'linkRestored', agentId: null, label: '' }, 'Live feed restored'],
    ];
    for (const [payload, expected] of cases) assert.equal(formatCueCaption(payload), expected, payload.kind);
    assert.equal(
        formatCueCaption({ kind: 'push', agentId: 'a-1', label: 'is busy', repo: 'claude-ville' }, 'Aurora'),
        'Aurora pushed claude-ville',
        'the observed name wins over the producer label',
    );
});

test('audio cues render independently of audio state and duplicate cues coalesce', () => {
    const view = harness();
    try {
        view.eventTarget.emit('agent:added', { id: 'a-1', name: 'Aurora' });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'summons',
            agentId: 'a-1',
            label: 'is waiting for approval',
            at: Date.now(),
        });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'summons',
            agentId: 'a-1',
            label: 'is waiting for approval',
            at: Date.now(),
        });

        assert.equal(view.container.children.length, 1);
        assert.equal(view.container.children[0].textContent, 'Aurora is waiting for approval ×2');
        assert.equal(view.container.children[0].attributes.get('role'), 'alert');
        assert.equal(view.container.children[0].dataset.cueKind, 'summons');
    } finally {
        view.cleanup();
    }
});

test('caption bursts stay bounded while primary cues displace routine cues first', () => {
    const view = harness();
    try {
        view.eventTarget.emit('audio:cue-played', { kind: 'arrival', agentId: 'a', label: 'Aurora' });
        view.eventTarget.emit('audio:cue-played', { kind: 'departure', agentId: 'b', label: 'Bramble' });
        view.eventTarget.emit('audio:cue-played', { kind: 'thunder', agentId: null, label: '' });
        view.eventTarget.emit('audio:cue-played', { kind: 'summons', agentId: 'c', label: 'Cinder' });

        assert.equal(view.container.children.length, 3);
        assert.deepEqual(
            view.container.children.map(child => child.textContent),
            ['Bramble departed', 'Thunder', 'Cinder needs you'],
        );
    } finally {
        view.cleanup();
    }
});

test('nullable lifecycle cue ids use synchronous village context to retain the agent name', () => {
    const view = harness();
    try {
        view.eventTarget.emit('village:scene', { kind: 'arrival', agentId: 'a-1', label: 'Aurora' });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'arrival',
            agentId: null,
            label: 'Agent arrived',
        });

        assert.equal(view.container.children[0].textContent, 'Aurora arrived');
    } finally {
        view.cleanup();
    }
});

test('a ceremony replaces the caption of the aggregate it absorbed and keeps its count', () => {
    const view = harness();
    try {
        view.eventTarget.emit('audio:cue-played', {
            kind: 'aggregate',
            agentId: null,
            label: 'Routine activity: 5 arrivals',
        });
        view.eventTarget.emit('audio:cue-played', { kind: 'thunder', agentId: null, label: '' });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'council',
            agentId: null,
            label: 'Council gathering',
            replaces: {
                kind: 'aggregate',
                agentId: null,
                label: 'Routine activity: 5 arrivals',
                count: 5,
                parts: '5 arrivals',
            },
        });

        assert.deepEqual(
            view.container.children.map(child => child.textContent),
            ['Thunder', 'A team gathered · 5 arrivals'],
        );
    } finally {
        view.cleanup();
    }
});

test('a newer village reminder restates the wait instead of counting the old one', () => {
    const view = harness();
    try {
        view.eventTarget.emit('audio:cue-played', { kind: 'reminder', agentId: 'a', label: 'Aurora', count: 2, oldestMs: 120_000 });
        view.eventTarget.emit('audio:cue-played', { kind: 'reminder', agentId: 'a', label: 'Aurora', count: 2, oldestMs: 360_000 });
        assert.deepEqual(view.container.children.map(child => child.textContent), ['2 waiting · oldest 6 min']);
        assert.equal(view.container.children[0].attributes.get('role'), 'alert');
    } finally {
        view.cleanup();
    }
});

test('a sound-off user with default settings sees signals but no outcome or scenery captions', () => {
    const view = harness(new MemoryStorage());
    try {
        for (const kind of ['turnDone', 'push', 'release', 'arrival', 'council', 'hourBell', 'thunder', 'aurora', 'linkLost']) {
            view.eventTarget.emit('audio:cue-played', { kind, agentId: null, label: '', count: 2 });
        }
        assert.equal(view.container.children.length, 0);
        view.eventTarget.emit('audio:cue-played', { kind: 'distress', agentId: 'a', label: 'Aurora' });
        assert.deepEqual(view.container.children.map(child => child.textContent), ['Aurora hit an error']);
        view.eventTarget.emit('audio:cue-played', { kind: 'digest', agentId: null, label: 'Digest', soundOnly: true });
        assert.equal(view.container.children.length, 1, 'the digest cue is sound-only');
    } finally {
        view.cleanup();
    }
});

test('missing cue events and partial payloads are harmless', () => {
    const view = harness();
    try {
        assert.equal(view.container.children.length, 0);
        view.eventTarget.emit('audio:cue-played', undefined);
        view.eventTarget.emit('audio:cue-played', {});
        assert.equal(view.container.children.length, 0);
    } finally {
        view.cleanup();
    }
});
