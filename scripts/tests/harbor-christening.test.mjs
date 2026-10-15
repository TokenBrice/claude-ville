import test from 'node:test';
import assert from 'node:assert/strict';

import { ChronicleMonuments } from '../../claudeville/src/presentation/character-mode/ChronicleMonuments.js';

// S-L2: a repo is christened once, ever. The christened set lives in the
// Chronicle store, so a reload (a fresh ChronicleMonuments over the same
// store) raises no second maiden banner.

function memoryStore() {
    const meta = new Map();
    return {
        meta,
        async getMeta(key, fallback = null) { return meta.has(key) ? structuredClone(meta.get(key)) : fallback; },
        async setMeta(key, value) { meta.set(key, structuredClone(value)); },
    };
}

function bus() {
    const handlers = new Map();
    const banners = [];
    return {
        banners,
        on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
        emit(name, payload) {
            if (name === 'chronicle:milestone-banner') banners.push(payload);
            handlers.get(name)?.(payload);
        },
    };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const christen = { project: '/w/alpha', repoName: 'alpha', tileX: 30, tileY: 10, ts: 1 };

test('a christened repo stays christened across a reload', async () => {
    const store = memoryStore();
    const first = bus();
    const before = new ChronicleMonuments({ store, eventTarget: first });
    first.emit('harbor:repo-christened', christen);
    await settle();
    assert.equal(first.banners.length, 1, 'first sighting raises the maiden banner');
    first.emit('harbor:repo-christened', christen);
    await settle();
    assert.equal(first.banners.length, 1, 'a duplicate emit is a no-op');
    before.dispose();

    const second = bus();
    const after = new ChronicleMonuments({ store, eventTarget: second });
    second.emit('harbor:repo-christened', christen);
    await settle();
    assert.equal(second.banners.length, 0, 'the reloaded page does not christen it again');
    second.emit('harbor:repo-christened', { ...christen, project: '/w/beta', repoName: 'beta' });
    await settle();
    assert.equal(second.banners.length, 1, 'a new repo is still christened');
    after.dispose();
});
