import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calendarDayKey,
    calendarDressingAt,
    calendarOccasionsAt,
    nextLocalMidnight,
    VillageCalendar,
} from '../../claudeville/src/presentation/character-mode/VillageCalendar.js';
import {
    CHRONICLE_DRESSING_ANCHORS,
    VILLAGE_CALENDAR_DRESSINGS,
} from '../../claudeville/src/config/villageCalendar.js';
import { VILLAGE_GATE, VILLAGE_GATE_GEOMETRY } from '../../claudeville/src/config/townPlan.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0);
const ids = (date) => calendarDressingAt(date).map((row) => row.id).sort();

test('winter solstice week: lantern garland, decorated pine, door wreaths', () => {
    const date = at(2026, 12, 21);
    assert.deepEqual(calendarOccasionsAt(date), ['winter-solstice', 'late-december']);
    assert.deepEqual(ids(date), ['archive-wreath', 'command-wreath', 'gate-garland-lights', 'plaza-pine']);
    // The week's edges are inclusive, the day either side is not.
    assert.ok(calendarOccasionsAt(at(2026, 12, 18)).includes('winter-solstice'));
    assert.ok(calendarOccasionsAt(at(2026, 12, 24)).includes('winter-solstice'));
    assert.ok(!calendarOccasionsAt(at(2026, 12, 25)).includes('winter-solstice'));
    assert.deepEqual(ids(at(2026, 12, 28)), ['archive-wreath', 'command-wreath']);
    assert.deepEqual(ids(at(2026, 12, 10)), []);
});

test('spring equinox week carries the blossom swag on the same anchor', () => {
    assert.deepEqual(ids(at(2026, 3, 20)), ['gate-garland-blossom']);
    assert.deepEqual(ids(at(2026, 3, 16)), []);
});

test('midsummer lays the bonfire; Jun 21 2026 is also a Sunday', () => {
    assert.deepEqual(calendarOccasionsAt(at(2026, 6, 21)), ['midsummer', 'weekend']);
    assert.deepEqual(ids(at(2026, 6, 21)), ['midsummer-bonfire', 'weekend-awning']);
    assert.deepEqual(ids(at(2026, 6, 25)), []); // a Thursday after the week
});

test('harvest dresses October; the weekend runs the side awning out', () => {
    assert.deepEqual(ids(at(2026, 10, 15)), ['harvest-pumpkins-avenue', 'harvest-pumpkins-civic', 'harvest-stook']);
    assert.deepEqual(ids(at(2026, 10, 10)), ['harvest-pumpkins-avenue', 'harvest-pumpkins-civic', 'harvest-stook', 'weekend-awning']);
    assert.deepEqual(ids(at(2026, 11, 7)), ['weekend-awning']);
    assert.deepEqual(ids(at(2026, 11, 9)), []);
});

test('windows are deterministic and never claim a Chronicle anchor', () => {
    const owned = new Set(CHRONICLE_DRESSING_ANCHORS);
    for (const row of VILLAGE_CALENDAR_DRESSINGS) assert.ok(!owned.has(row.anchor), row.id);
    for (let day = 0; day < 366; day++) {
        const date = new Date(2026, 0, 1 + day, 9);
        assert.deepEqual(ids(date), ids(new Date(date.getTime())));
        const anchors = calendarDressingAt(date).map((row) => row.anchor);
        assert.equal(new Set(anchors).size, anchors.length);
    }
});

test('the calendar rebakes at most once a local midnight and holds through a reveal', () => {
    const calendar = new VillageCalendar();
    const eve = at(2026, 12, 17, 23).getTime() + 50 * 60000; // 23:50
    assert.equal(calendar.update(eve), true); // first resolve: the late-December wreaths are up
    assert.equal(calendar.dayKey, '2026-12-17');
    assert.equal(calendar.update(eve + 60000), false);
    const midnight = nextLocalMidnight(eve);
    assert.equal(calendarDayKey(midnight), '2026-12-18');
    // A live release reveal holds the turn; it lands once the crown ends.
    assert.equal(calendar.update(midnight + 1000, { revealLive: true }), false);
    assert.equal(calendar.isActive('plaza-pine'), false);
    assert.equal(calendar.update(midnight + 2000), true);
    assert.equal(calendar.isActive('plaza-pine'), true);
    assert.equal(calendar.revision, 2);
    assert.equal(calendar.update(midnight + 3 * 3600000), false);
    assert.deepEqual(calendar.partStampsFor('command').map((row) => row.id), ['command-wreath']);
});

test('only the midsummer bonfire lights, and only on the lamps gate', () => {
    const calendar = new VillageCalendar();
    const noon = at(2026, 6, 21).getTime();
    calendar.update(noon, { lampsLit: false });
    assert.deepEqual(calendar.lightFixtures(), []);
    calendar.update(noon + 10 * 3600000, { lampsLit: true });
    const fires = calendar.lightFixtures();
    assert.equal(fires.length, 1);
    assert.equal(fires[0].id, 'calendar.midsummer-bonfire');
    const winter = new VillageCalendar();
    winter.update(at(2026, 12, 21, 22).getTime(), { lampsLit: true });
    assert.deepEqual(winter.lightFixtures(), []);
});

function recordingCtx() {
    const rects = [];
    return {
        rects,
        fillStyle: '',
        globalAlpha: 1,
        fillRect(x, y, w, h) { rects.push({ x, y, w, h, color: this.fillStyle, alpha: this.globalAlpha }); },
    };
}

test('prop dressings sit on whole world px, so their baked texels stay opaque', () => {
    // StaticPropSprite bakes with the origin's fraction in the translation: a
    // fractional origin smeared every fillRect texel to a faint ghost.
    const sprites = new VillageCalendar().buildPropSprites();
    assert.ok(sprites.length > 0);
    for (const sprite of sprites) {
        assert.ok(Math.abs(sprite.x - Math.round(sprite.x)) < 1e-6, `${sprite.id} x ${sprite.x}`);
        assert.ok(Math.abs(sprite.y - Math.round(sprite.y)) < 1e-6, `${sprite.id} y ${sprite.y}`);
    }
});

test('the gate garland swags lantern to lantern in front of the gatehouse columns', () => {
    const calendar = new VillageCalendar();
    calendar.update(at(2026, 12, 21, 13).getTime(), { lampsLit: false });
    const garland = calendar.buildPropSprites().find((s) => s.id === 'calendar.gate-garland-lights');
    const ctx = recordingCtx();
    garland.drawFn(ctx, garland.x, garland.y);
    const cord = ctx.rects.filter((r) => r.color === '#3a2a1e');
    assert.ok(cord.length > 60, 'the cord paints');
    const { left, right, top, bottom } = garland.bounds;
    const xs = new Set();
    for (const r of ctx.rects) {
        assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y), 'whole texels');
        assert.ok(r.x >= garland.x + left && r.x + r.w <= garland.x + right, 'inside the bounds (x)');
        assert.ok(r.y >= garland.y + top && r.y + r.h <= garland.y + bottom, 'inside the bounds (y)');
    }
    for (const r of cord) xs.add(r.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    assert.equal(xs.size, maxX - minX + 1, 'one unbroken cord');
    // Each end rests on a gate lantern's bracket arm (tip 5 px out of the
    // face at lanternX, 34 px up).
    const gate = tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY);
    const arm = (dx) => tileToWorld(VILLAGE_GATE.tileX + dx, VILLAGE_GATE.tileY + VILLAGE_GATE_GEOMETRY.blockHalfDepth);
    const [west, east] = VILLAGE_GATE_GEOMETRY.lanternX.map(arm);
    assert.ok(Math.abs(minX - (Math.round(west.x) - 3)) <= 1, `west end ${minX}`);
    assert.ok(Math.abs(maxX - (Math.round(east.x) - 3)) <= 1, `east end ${maxX}`);
    // Every slice sorts after the gatehouse slice on its centre line (slope
    // 1/2 from the gate origin) wherever the two overlap on screen.
    assert.ok(garland.occlusionColumns?.length > 1);
    for (const column of garland.occlusionColumns) {
        const x0 = garland.x + Math.max(column.left, left);
        const x1 = garland.x + Math.min(column.right, right);
        for (const x of [x0, x1]) {
            assert.ok(column.sortY > gate.y + (x - gate.x) / 2, `slice ${column.index} in front of the gate at x ${x}`);
        }
    }
});

test('the solstice garland bulbs burn on the lamps gate without a fixture light', () => {
    const calendar = new VillageCalendar();
    const garland = calendar.buildPropSprites().find((s) => s.id === 'calendar.gate-garland-lights');
    const day = at(2026, 12, 21, 13).getTime();
    calendar.update(day, { lampsLit: false });
    const dark = recordingCtx();
    garland.channels.emissive(dark, garland.x, garland.y);
    assert.equal(dark.rects.length, 0);
    const revision = garland._gpuCacheRevision;
    calendar.update(day + 9 * 3600000, { lampsLit: true });
    assert.ok(garland._gpuCacheRevision > revision, 'lighting the lamps rebakes the bulbs');
    const lit = recordingCtx();
    garland.channels.emissive(lit, garland.x, garland.y);
    assert.ok(lit.rects.length > 10);
    assert.ok(lit.rects.every((r) => r.color !== '#3a2a1e' && r.alpha < 1), 'glass only, at the lantern emissive share');
    assert.deepEqual(calendar.lightFixtures(), []);
});
