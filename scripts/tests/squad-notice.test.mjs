// D7 — heads turn: seated or waiting same-repo villagers face a celebrating
// squadmate for its 5 s window, then turn back.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { SQUAD_NOTICE_CAP, bindSquadNotice, squadWatchers } from '../../claudeville/src/presentation/character-mode/SquadNotice.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { dirFromVelocity } from '../../claudeville/src/presentation/character-mode/SpriteSheet.js';

function stub(id, tileX, tileY, { repo = '/work/r', holding = true, departedAt = null } = {}) {
    const world = tileToWorld(tileX, tileY);
    return {
        agent: { id, projectPath: repo, departedAt },
        x: world.x,
        y: world.y,
        _holdsRestPlace: () => holding,
        noticed: null,
        noticeSquadmate(point, until) { this.noticed = { point, until }; },
    };
}

test('only same-repo bodies holding a seat or queue place nearby turn, nearest first and capped', () => {
    const celebrant = stub('hero', 20, 20);
    const sprites = [
        celebrant,
        stub('near', 21, 20),
        stub('other-repo', 21, 21, { repo: '/work/other' }),
        stub('walking', 20, 22, { holding: false }),
        stub('far', 29, 29),
        stub('gone', 20, 21, { departedAt: 1 }),
        ...Array.from({ length: 8 }, (_, i) => stub(`seat-${i}`, 22 + (i % 3), 19 + Math.floor(i / 3))),
    ];
    const watchers = squadWatchers(celebrant, sprites).map(sprite => sprite.agent.id);
    assert.equal(watchers.length, SQUAD_NOTICE_CAP);
    assert.equal(watchers[0], 'near');
    for (const id of ['hero', 'other-repo', 'walking', 'far', 'gone']) assert.ok(!watchers.includes(id), id);
});

test('a verified win turns the watchers until the celebration ends; a turn ending never does', (t) => {
    const handlers = [];
    const bus = { on: (_name, handler) => { handlers.push(handler); return () => {}; } };
    const celebrant = stub('hero', 20, 20);
    const watcher = stub('mate', 21, 20);
    const sprites = new Map([['hero', celebrant], ['mate', watcher]]);
    bindSquadNotice(() => sprites, { eventTarget: bus });
    const now = Date.now();
    handlers[0]({ kind: 'milestone', agentId: 'hero', at: now });
    handlers[0]({ kind: 'turnDone', agentId: 'hero', at: now });
    assert.equal(watcher.noticed, null);
    handlers[0]({ kind: 'mended', agentId: 'hero', at: now });
    assert.deepEqual(watcher.noticed.point, { x: celebrant.x, y: celebrant.y });
    assert.equal(watcher.noticed.until, now + 5000);
});

test('the sprite faces the point for the window and then turns back', () => {
    const sprite = new AgentSprite({ id: 'sitter', status: 'idle', provider: 'claude', model: 'claude-opus-5-5' }, {});
    sprite.motionScale = 0;
    sprite.x = 0;
    sprite.y = 0;
    sprite.direction = 2;
    const now = 1_000;
    sprite.noticeSquadmate({ x: -40, y: 20 }, now + 5000);
    const toward = sprite._squadGlanceFacing(now);
    assert.equal(toward, dirFromVelocity(-40, 20));
    sprite._setFacingGoal(toward);
    assert.equal(sprite.direction, toward, 'reduced motion snaps');
    assert.equal(sprite._squadGlanceFacing(now + 5000), null);
    assert.equal(sprite.direction, 2, 'turns back to the facing it had');
    sprite.dispose?.();
});
