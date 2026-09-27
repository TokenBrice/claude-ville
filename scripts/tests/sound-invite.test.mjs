import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
    INVITE_MAX_SHOW_MS,
    INVITE_MIN_UPTIME_MS,
    SOUND_INVITE_COPY,
    SoundInvite,
    inviteEligible,
    inviteTrigger,
} from '../../claudeville/src/presentation/shared/SoundInvite.js';
import { SOUND_INVITED_KEY } from '../../claudeville/src/presentation/shared/SoundSettings.js';
import { Toast } from '../../claudeville/src/presentation/shared/Toast.js';

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

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
    }

    _names() {
        return new Set(this.owner.className.split(/\s+/).filter(Boolean));
    }

    add(value) {
        const names = this._names();
        names.add(value);
        this.owner.className = [...names].join(' ');
    }

    remove(value) {
        const names = this._names();
        names.delete(value);
        this.owner.className = [...names].join(' ');
    }

    contains(value) {
        return this._names().has(value);
    }
}

class FakeElement {
    constructor(tag = 'div') {
        this.tag = tag;
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this._text = '';
    }

    get textContent() {
        return this._text + this.children.map(child => child.textContent).join(' ');
    }

    set textContent(value) {
        this._text = String(value);
        for (const child of this.children) child.parentNode = null;
        this.children = [];
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
    }

    append(...children) {
        for (const child of children) this.appendChild(child);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
    }

    remove() {
        this.parentNode?.removeChild(this);
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    addEventListener(name, listener) {
        this.listeners.set(name, listener);
    }

    click() {
        this.listeners.get('click')?.();
    }

    buttons() {
        return this.children.flatMap(child => (child.tag === 'button' ? [child] : child.buttons()));
    }
}

const SOUND_OFF = Object.freeze({ 'claudeville.sound.enabled': 'false' });
const OPEN_FOR = INVITE_MIN_UPTIME_MS + 1000;

function harness({ storage = new MemoryStorage(SOUND_OFF), uptime = OPEN_FOR, visibilityState = 'visible' } = {}) {
    const container = new FakeElement();
    const listeners = new Map();
    const emitted = [];
    const eventTarget = {
        on(name, listener) {
            const list = listeners.get(name) || [];
            list.push(listener);
            listeners.set(name, list);
            return () => listeners.set(name, (listeners.get(name) || []).filter(l => l !== listener));
        },
        emit(name, payload) {
            emitted.push({ name, payload });
            for (const listener of listeners.get(name) || []) listener(payload);
        },
    };
    const documentRef = {
        visibilityState,
        getElementById(id) { return id === 'toastContainer' ? container : null; },
        createElement(tag) { return new FakeElement(tag); },
    };
    const clock = { uptime };
    const toast = new Toast({ eventTarget, documentRef, storage, uptimeMs: () => clock.uptime });
    return { container, eventTarget, emitted, storage, toast, clock, documentRef };
}

const raised = (agentId, status, name = agentId) => ({
    agentId,
    status,
    label: status === 'errored' ? 'hit an error' : 'asked you a question',
    agent: { id: agentId, name, status },
});

function inviteButtons(h) {
    return h.container.buttons();
}

test('eligibility needs sound off, a visible page open two minutes and no earlier invite', () => {
    const ok = { soundOn: false, visible: true, uptimeMs: INVITE_MIN_UPTIME_MS, invited: false, offered: false };
    assert.equal(inviteEligible(ok), true);
    assert.equal(inviteEligible({ ...ok, soundOn: true }), false);
    assert.equal(inviteEligible({ ...ok, visible: false }), false);
    assert.equal(inviteEligible({ ...ok, uptimeMs: INVITE_MIN_UPTIME_MS - 1 }), false);
    assert.equal(inviteEligible({ ...ok, invited: true }), false);
    assert.equal(inviteEligible({ ...ok, offered: true }), false);
});

test('the trigger names the call of the family that raised it', () => {
    assert.deepEqual(inviteTrigger(raised('a', 'waiting_on_user')), { bucket: 'summons', family: 'needsYou', agentId: 'a' });
    assert.deepEqual(inviteTrigger(raised('b', 'errored')), { bucket: 'distress', family: 'errors', agentId: 'b' });
    assert.deepEqual(inviteTrigger(raised('c', 'rate_limited')), { bucket: 'limit', family: 'quota', agentId: 'c' });
    // an older producer without a status still asks for the operator
    assert.equal(inviteTrigger({ agentId: 'd' }).bucket, 'summons');
});

test('an offer is made once per profile; an ineligible moment does not spend it', () => {
    const storage = new MemoryStorage();
    const invite = new SoundInvite({ storage });
    const eligible = { soundOn: false, visible: true, uptimeMs: OPEN_FOR };
    assert.equal(invite.offer(raised('a', 'errored'), { ...eligible, uptimeMs: 30_000 }), null);
    assert.equal(invite.offer(raised('a', 'errored'), { ...eligible, visible: false }), null);
    assert.equal(invite.offer(raised('a', 'errored'), { ...eligible, soundOn: true }), null);
    assert.equal(storage.getItem(SOUND_INVITED_KEY), null);

    assert.equal(invite.offer(raised('a', 'errored'), eligible).bucket, 'distress');
    assert.equal(storage.getItem(SOUND_INVITED_KEY), '1');
    assert.equal(invite.offer(raised('b', 'waiting_on_user'), eligible), null);
    // a new session of the same profile is never asked again
    assert.equal(new SoundInvite({ storage }).offer(raised('b', 'waiting_on_user'), eligible), null);
});

test('the notice carries the offer only with sound off, visible, after two minutes', () => {
    for (const setup of [
        { storage: new MemoryStorage({ 'claudeville.sound.enabled': 'true' }) },
        { visibilityState: 'hidden' },
        { uptime: INVITE_MIN_UPTIME_MS - 1 },
        { storage: new MemoryStorage({ ...SOUND_OFF, [SOUND_INVITED_KEY]: '1' }) },
    ]) {
        const h = harness(setup);
        h.eventTarget.emit('attention:raised', raised('a', 'waiting_on_user', 'Aurora'));
        assert.equal(h.container.children.length, 1, 'the notice itself always shows');
        assert.deepEqual(inviteButtons(h), []);
        h.toast.destroy();
    }

    const h = harness();
    h.eventTarget.emit('attention:raised', raised('a', 'waiting_on_user', 'Aurora'));
    const [notice] = h.container.children;
    assert.match(notice.textContent, /^Aurora asked you a question/);
    assert.match(notice.textContent, /Want a bell for moments like this\?/);
    assert.deepEqual(inviteButtons(h).map(b => b.textContent), [SOUND_INVITE_COPY.accept, SOUND_INVITE_COPY.decline]);
    assert.equal(h.storage.getItem(SOUND_INVITED_KEY), '1');

    // Only the first raised notice of the session asks.
    h.eventTarget.emit('attention:raised', raised('b', 'errored', 'Birch'));
    assert.equal(h.container.children.length, 2);
    assert.equal(inviteButtons(h).length, 2);
    h.toast.destroy();
});

test('the direct notice that follows the event keeps the offer', () => {
    const h = harness();
    h.eventTarget.emit('attention:raised', raised('a', 'errored', 'Aurora'));
    h.toast.show('Aurora hit an error', 'warning');
    assert.equal(h.container.children.length, 1);
    assert.equal(inviteButtons(h).length, 2);
    h.toast.destroy();
});

test('NO THANKS records the profile as invited and leaves a plain notice', () => {
    const h = harness();
    h.eventTarget.emit('attention:raised', raised('a', 'waiting_on_user', 'Aurora'));
    inviteButtons(h)[1].click();
    assert.deepEqual(inviteButtons(h), []);
    assert.equal(h.container.children[0].textContent, 'Aurora asked you a question');
    assert.equal(h.storage.getItem(SOUND_INVITED_KEY), '1');
    assert.deepEqual(h.emitted.filter(e => e.name.startsWith('sound:invite')).map(e => e.name), ['sound:invite-declined']);
    h.toast.destroy();

    // A later session of this profile is never asked again.
    const again = harness({ storage: h.storage });
    again.eventTarget.emit('attention:raised', raised('b', 'errored', 'Birch'));
    assert.deepEqual(inviteButtons(again), []);
    again.toast.destroy();
});

test('TURN ON SIGNALS sets Signals and plays the call of the triggering family, inside the click', () => {
    const h = harness();
    const calls = [];
    // TopBar's wiring (7.5): the controller turns on Signals and rings the call.
    h.eventTarget.on('sound:invite-accepted', ({ bucket }) => {
        calls.push(['setPreset', 'signals']);
        calls.push(['testCall', bucket]);
    });
    h.eventTarget.emit('attention:raised', raised('a', 'errored', 'Aurora'));
    const [accept] = inviteButtons(h);
    accept.click();
    assert.deepEqual(calls, [['setPreset', 'signals'], ['testCall', 'distress']]);
    assert.deepEqual(inviteButtons(h), []);
    accept.click();
    assert.equal(calls.length, 2, 'an answered offer cannot fire twice');
    h.toast.destroy();
});

test('an unanswered offer leaves after twenty seconds, not the notice’s usual eight', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
        const h = harness();
        h.eventTarget.emit('attention:raised', raised('a', 'waiting_on_user', 'Aurora'));
        mock.timers.tick(INVITE_MAX_SHOW_MS - 1);
        assert.equal(h.container.children.length, 1);
        mock.timers.tick(1);
        mock.timers.tick(300);
        assert.equal(h.container.children.length, 0);
        h.toast.destroy();
    } finally {
        mock.timers.reset();
    }
});

test('the one-time family line lands on the notice that carries the urgent cue, once', () => {
    const h = harness({ storage: new MemoryStorage({ 'claudeville.sound.enabled': 'true', [SOUND_INVITED_KEY]: '1' }) });
    h.eventTarget.emit('attention:raised', raised('a', 'waiting_on_user', 'Aurora'));
    const line = 'That call means an agent needs you.';
    h.eventTarget.emit('audio:cue-played', { kind: 'summons', agentId: 'a', label: 'Aurora', familyLine: line });
    assert.equal(h.container.children.length, 1, 'the summons folds into the attention notice');
    const [notice] = h.container.children;
    assert.equal(notice.textContent, `Aurora asked you a question ${line}`);
    // the direct notice rewrites the text but keeps the line
    h.toast.show('Aurora asked you a question', 'warning');
    assert.equal(notice.children.filter(child => child.className === 'toast__line').length, 1);
    h.toast.destroy();
});

test('a sound status is polite, not a cue caption, and replaces the previous one', () => {
    const h = harness();
    h.eventTarget.emit('sound:status', { message: 'Sound on · Village' });
    h.eventTarget.emit('sound:status', { message: 'Sound off' });
    assert.equal(h.container.children.length, 1);
    const [status] = h.container.children;
    assert.equal(status.textContent, 'Sound off');
    assert.equal(status.attributes.get('role'), 'status');
    assert.equal(status.dataset.cueKind, undefined);
    h.toast.destroy();
});
