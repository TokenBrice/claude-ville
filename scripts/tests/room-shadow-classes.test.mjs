// W3.1 — shadow-theatre windows (spec 04 §1.2 and §1.5). Pins the measured
// class of every one of the 42 real room panes, the thirteen code-drawn
// stamps and their budgets on every stamp pane, the five truth gates, the
// Forge rhythm dip, patch / litPatch ink agreement and the rebuild cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
    RoomGlass,
    SHADOW_INK_MAX_SHARE,
    buildGlassMap,
    glassRects,
    shadowClassFor,
    shadowInkFor,
    windowEmissiveKind,
} from '../../claudeville/src/presentation/character-mode/RoomGlass.js';
import {
    ROOM_SHADOW_STAMPS,
    SHADOW_BUST_MAX_SHARE,
    SHADOW_STAMP_MAX_H,
    SHADOW_STAMP_MAX_W,
    allShadowStamps,
    shadowFamilyForPose,
    shadowFrameCount,
    stampForShadow,
    stampInk,
} from '../../claudeville/src/presentation/character-mode/RoomShadowStamps.js';
import {
    BuildingSprite,
    ROOM_RHYTHM_DIP,
    ROOM_SHADOW_QUANTUM_MS,
    onStrikeContact,
    poseStripFrame,
    roomShadowDescriptor,
} from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { KEEPER_ROOM_GATE, ROUTING_ROOM_GATE } from '../../claudeville/src/presentation/character-mode/NightOccupancyGate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDINGS = path.join(ROOT, 'claudeville/assets/sprites/buildings');
const readPng = (type, name) => PNG.sync.read(readFileSync(path.join(BUILDINGS, `building.${type}`, name)));

// Spec 04 §1.2, room by room: [class, clean(4), clean(5), texels].
const PANE_TABLE = Object.freeze({
    command: [
        ['S4', 10, 2, 52], ['S5', 10, 10, 57], [null, 0, 0, 33], [null, 4, 0, 25], [null, 5, 0, 22],
        [null, 6, 0, 26], [null, 1, 0, 26], [null, 0, 0, 14], [null, 0, 0, 11], [null, 0, 0, 14], [null, 0, 0, 13],
    ],
    archive: [
        ['S5', 23, 21, 117], ['S5', 24, 22, 124], ['S5', 23, 21, 119], ['S5', 19, 17, 123], ['S5', 7, 7, 92],
        ['S4', 12, 0, 59], ['S5', 14, 12, 79], ['S4', 12, 0, 63], ['S4', 12, 6, 79], ['S5', 13, 11, 77],
    ],
    harbor: [
        ['S4', 10, 0, 42], [null, 0, 0, 29], ['S4', 10, 4, 88], ['S4', 7, 0, 39],
        [null, 2, 0, 33], ['S4', 7, 1, 37], ['S5', 8, 7, 43], [null, 6, 0, 27],
    ],
    tavern: [['S6', 8, 8, 88], ['S6', 12, 12, 126], ['S6', 10, 10, 107], [null, 3, 0, 48], [null, 3, 0, 22]],
    watchtower: [[null, 0, 0, 31], [null, 0, 0, 30], ['S6', 9, 8, 59]],
    forge: [['R', 5, 4, 65], ['R', 5, 4, 64]],
    taskboard: [[null, 3, 0, 67], [null, 4, 2, 79]],
    mine: [[null, 39, 31, 1002]],
});

const maps = new Map();
function realMap(type, { pixels = false } = {}) {
    let map = maps.get(type);
    if (!map) {
        const emissive = readPng(type, 'base.emissive.png');
        const rooms = readPng(type, 'base.rooms.png');
        map = buildGlassMap({
            width: emissive.width,
            height: emissive.height,
            emissive: emissive.data,
            rooms: rooms.data,
            rects: glassRects(type),
            kind: windowEmissiveKind(type),
            type,
        });
        map.emissive = emissive.data;
        map.spriteWidth = emissive.width;
        map.channels = { material: null, occluder: null };
        maps.set(type, map);
    }
    if (pixels && !map.albedo) {
        const albedo = readPng(type, 'base.png');
        assert.equal(albedo.width, map.spriteWidth, `${type} albedo matches its sidecars`);
        map.albedo = albedo.data;
    }
    return map;
}

function stampPanes() {
    const out = [];
    for (const type of Object.keys(PANE_TABLE)) {
        const map = realMap(type);
        for (let group = 1; group <= map.rooms; group++) {
            const room = map.roomShadows[group];
            if (room?.cls?.startsWith('S')) out.push({ type, group, map, room });
        }
    }
    return out;
}

function withFakeDocument(run) {
    const prev = globalThis.document;
    globalThis.document = {
        createElement: () => {
            const canvas = { width: 0, height: 0, last: null };
            canvas.getContext = () => ({
                createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                putImageData: (image) => { canvas.last = new Uint8ClampedArray(image.data); },
                getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            });
            return canvas;
        },
    };
    try {
        return run();
    } finally {
        globalThis.document = prev;
    }
}

test('§1.2: all 42 real room panes keep their measured shadow class (21 S, 2 R, 19 none)', () => {
    const tally = { S: 0, R: 0, none: 0 };
    const byBuilding = {};
    for (const [type, rows] of Object.entries(PANE_TABLE)) {
        const map = realMap(type);
        assert.equal(map.rooms, rows.length, `${type} room count`);
        rows.forEach(([cls, w4, w5, texels], index) => {
            const room = map.roomShadows[index + 1];
            const label = `${type} room ${index + 1}`;
            assert.equal(room.cls, cls, `${label} class`);
            assert.equal(room.clean[4], w4, `${label} clean(4)`);
            assert.equal(room.clean[5], w5, `${label} clean(5)`);
            assert.equal(room.texels, texels, `${label} texels`);
            if (cls?.startsWith('S')) {
                const width = Number(cls.slice(1));
                assert.equal(room.rect.w, width, `${label} rect width`);
                assert.equal(room.rect.h, room.clean[width], `${label} rect is the tallest clean rectangle`);
                assert.ok(room.rect.h >= 7, `${label} minH`);
                // Every rect texel is this room's glass (sprite-local -> map-local).
                for (let y = 0; y < room.rect.h; y++) {
                    for (let x = 0; x < room.rect.w; x++) {
                        const i = (room.rect.y - map.top + y) * map.w + room.rect.x - map.left + x;
                        assert.equal(map.group[i], index + 1, `${label} rect texel ${x},${y}`);
                    }
                }
            } else {
                assert.equal(room.rect, null, `${label} carries no stamp rectangle`);
            }
            const bucket = cls === 'R' ? 'R' : cls ? 'S' : 'none';
            tally[bucket]++;
            byBuilding[type] = (byBuilding[type] || 0) + (bucket === 'S' ? 1 : 0);
        });
        assert.equal(map.shadowRooms, rows.filter(([cls]) => cls).length, `${type} shadowRooms`);
    }
    assert.deepEqual(tally, { S: 21, R: 2, none: 19 });
    assert.equal(tally.S + tally.R + tally.none, 42);
    assert.deepEqual(byBuilding, { command: 2, archive: 10, harbor: 5, tavern: 3, watchtower: 1, forge: 0, taskboard: 0, mine: 0 });
});

test('§1.5: shadowClassFor reads the emissive kind before any size', () => {
    assert.equal(windowEmissiveKind('archive'), 'windows');
    assert.equal(windowEmissiveKind('forge'), 'fire');
    assert.equal(windowEmissiveKind('mine'), 'fire');
    assert.equal(windowEmissiveKind('taskboard'), 'lantern');
    assert.equal(windowEmissiveKind('portal'), null);
    const roomy = { 4: 40, 5: 40, 6: 40 };
    assert.equal(shadowClassFor(roomy, 'windows', 'tavern'), 'S6');
    assert.equal(shadowClassFor({ 4: 9, 5: 7, 6: 6 }, 'windows', 'archive'), 'S5');
    assert.equal(shadowClassFor({ 4: 7, 5: 6, 6: 0 }, 'windows', 'harbor'), 'S4');
    assert.equal(shadowClassFor({ 4: 6, 5: 0, 6: 0 }, 'windows', 'harbor'), null, 'one row short');
    assert.equal(shadowClassFor((k) => (k === 4 ? 7 : 0), 'windows', 'command'), 'S4', 'function form');
    assert.equal(shadowClassFor(roomy, 'fire', 'forge'), 'R');
    assert.equal(shadowClassFor(roomy, 'fire', 'mine'), null, 'an opening, not glass');
    assert.equal(shadowClassFor(roomy, 'lantern', 'taskboard'), null, 'a lamp, not a room');
    assert.equal(shadowClassFor(roomy, null, 'portal'), null);
});

test('§1.5: thirteen stamps, none larger than 6 x 10, families mapped from the live pose', () => {
    const stamps = allShadowStamps();
    assert.equal(stamps.length, 13);
    for (const { family, size, frame, rows } of stamps) {
        const label = `${family} ${size} frame ${frame}`;
        assert.ok(rows.length <= SHADOW_STAMP_MAX_H && rows.length > 0, `${label} height`);
        const width = Number(size.slice(1));
        assert.ok(width <= SHADOW_STAMP_MAX_W);
        for (const row of rows) {
            assert.equal(row.length, width, `${label} rows span the pane jamb to jamb`);
            assert.match(row, /^[#.]+$/, `${label} uses ink and glass only`);
        }
        assert.ok(rows[rows.length - 1].startsWith('#') && rows[rows.length - 1].endsWith('#'), `${label} stands on the sill`);
    }
    assert.deepEqual(Object.keys(ROOM_SHADOW_STAMPS.upright), ['S4', 'S5', 'S6']);
    assert.deepEqual(Object.keys(ROOM_SHADOW_STAMPS.bowed), ['S4', 'S5']);
    assert.deepEqual(Object.keys(ROOM_SHADOW_STAMPS.arm), ['S4', 'S5']);
    assert.deepEqual(Object.keys(ROOM_SHADOW_STAMPS.seated), ['S6']);
    assert.equal(shadowFrameCount('upright', 'S5'), 1);
    assert.equal(shadowFrameCount('bowed', 'S4'), 2);
    assert.equal(shadowFrameCount('seated', 'S6'), 2);
    assert.equal(shadowFrameCount('upright', 'R'), 0);

    // The spec's worked examples (upright S5, bowed S5 frame 1).
    assert.deepEqual([...ROOM_SHADOW_STAMPS.upright.S5[0]], ['.###.', '.###.', '.###.', '#####', '#####', '#####', '#####']);
    assert.deepEqual([...ROOM_SHADOW_STAMPS.bowed.S5[0]], ['.....', '..###', '..###', '.####', '#####', '#####', '#####']);
    // Frame 2 of `bowed` lights one texel at the book; `arm` adds a 1 x 2 column
    // beside the head; `seated` lifts one texel to the head row.
    assert.equal(stampInk(ROOM_SHADOW_STAMPS.bowed.S5[0]) - stampInk(ROOM_SHADOW_STAMPS.bowed.S5[1]), 1);
    assert.equal(stampInk(ROOM_SHADOW_STAMPS.arm.S5[1]) - stampInk(ROOM_SHADOW_STAMPS.arm.S5[0]), 2);
    assert.deepEqual(ROOM_SHADOW_STAMPS.arm.S4[0], ROOM_SHADOW_STAMPS.upright.S4[0], 'arm frame 1 is upright');
    assert.equal(stampInk(ROOM_SHADOW_STAMPS.seated.S6[0]), stampInk(ROOM_SHADOW_STAMPS.seated.S6[1]), 'the sip moves ink, never adds it');

    assert.equal(shadowFamilyForPose('read'), 'bowed');
    assert.equal(shadowFamilyForPose('gaze'), 'bowed');
    assert.equal(shadowFamilyForPose('tinker'), 'arm');
    assert.equal(shadowFamilyForPose('strike'), 'arm');
    assert.equal(shadowFamilyForPose('sit'), 'seated');
    assert.equal(shadowFamilyForPose('drink'), 'seated');
    for (const group of ['think', 'scan', 'wait', null, undefined, 'celebrate']) {
        assert.equal(shadowFamilyForPose(group), 'upright', String(group));
    }

    // A family without the pane's size stands upright; an unknown class has none.
    assert.equal(stampForShadow('seated', 'S4', 0, 20).family, 'upright');
    assert.equal(stampForShadow('bowed', 'S6', 1, 20).family, 'upright');
    assert.equal(stampForShadow('upright', 'R', 0, 20), null);
    assert.equal(stampForShadow('upright', null, 0, 20), null);
    // Bust height <= 60 % of the clean height, else the four-row cut.
    const full = stampForShadow('upright', 'S5', 0, 12);
    assert.equal(full.cut, false);
    assert.ok(full.height <= SHADOW_BUST_MAX_SHARE * 12);
    const cut = stampForShadow('upright', 'S5', 0, 10);
    assert.equal(cut.cut, true);
    assert.deepEqual([...cut.rows], ['.###.', '.###.', '.###.', '#####']);
    assert.equal(stampForShadow('bowed', 'S5', 1, 7).rows.length, 4);
    assert.ok(stampForShadow('bowed', 'S5', 1, 7).rows[0].includes('#'), 'the cut starts at the head');
    // The ink cap picks the cut for both frames of a family, then nothing.
    assert.equal(stampForShadow('arm', 'S4', 0, 10, 21).cut, true, 'frame 2 (22 ink) breaks 21, so frame 1 cuts too');
    assert.equal(stampForShadow('arm', 'S4', 1, 10, 21).cut, true);
    assert.equal(stampForShadow('upright', 'S4', 0, 10, 11), null);
    assert.equal(stampForShadow('upright', 'S4', 0, 6), null, 'clean height 6 cannot hold even the cut');
});

test('§1.5: every stamp on all 21 S panes keeps the 45 % ink budget, the 60 % bust cap and the room mask', () => {
    const panes = stampPanes();
    assert.equal(panes.length, 21);
    for (const { type, group, map, room } of panes) {
        const families = ['upright', 'bowed', 'arm', 'seated'];
        for (const family of families) {
            for (const frame of [0, 1]) {
                for (const dx of [-1, 0, 1]) {
                    const label = `${type} room ${group} ${family}/${frame}/${dx}`;
                    const stamp = stampForShadow(family, room.cls, frame, room.rect.h, SHADOW_INK_MAX_SHARE * room.texels);
                    assert.ok(stamp, `${label} has a stamp`);
                    assert.ok(stamp.height <= SHADOW_BUST_MAX_SHARE * room.rect.h + 1e-9, `${label} bust <= 60 % clean height`);
                    const mask = shadowInkFor(map, (g) => (g === group ? { family, frame, dx } : null));
                    assert.ok(mask, `${label} inks`);
                    let ink = 0;
                    let bottom = -1;
                    for (let i = 0; i < mask.length; i++) {
                        if (!mask[i]) continue;
                        ink++;
                        assert.equal(map.group[i], group, `${label} ink stays on its own room's glass`);
                        bottom = Math.max(bottom, Math.floor(i / map.w));
                    }
                    assert.ok(ink > 0 && ink <= SHADOW_INK_MAX_SHARE * room.texels, `${label} ink ${ink} of ${room.texels}`);
                    if (dx === 0) {
                        assert.equal(ink, stamp.ink, `${label} unshifted stamp sits wholly in the clean rectangle`);
                        assert.equal(bottom + map.top, room.rect.y + room.rect.h - 1, `${label} stands on the sill row`);
                    }
                }
            }
        }
    }
});

test('§1.5: a came or curtain crossing the clean glass still occludes the ink', () => {
    const real = realMap('archive');
    const group = 1;
    const room = real.roomShadows[group];
    // A one-texel horizontal came across the stamp's shoulders.
    const came = room.rect.y + room.rect.h - 3 - real.top;
    const groupCopy = new Int8Array(real.group);
    for (let x = 0; x < real.w; x++) {
        if (groupCopy[came * real.w + x] === group) groupCopy[came * real.w + x] = -1;
    }
    const map = { ...real, group: groupCopy };
    const desc = { family: 'upright', frame: 0, dx: 0 };
    const clear = shadowInkFor(real, (g) => (g === group ? desc : null));
    const crossed = shadowInkFor(map, (g) => (g === group ? desc : null));
    let lost = 0;
    for (let i = 0; i < clear.length; i++) {
        if (crossed[i]) assert.equal(map.group[i], group);
        if (clear[i] && !crossed[i]) {
            lost++;
            assert.equal(Math.floor(i / real.w), came, 'only the came row loses ink');
        }
    }
    assert.equal(lost, room.rect.w, 'the came hides one full shoulder row');
});

test('§1.6: patch writes ink as full-alpha unlit albedo, makes a patch when fully lit, and litPatch agrees', () => {
    withFakeDocument(() => {
        const map = realMap('archive', { pixels: true });
        const rg = new RoomGlass(null);
        rg._maps.set('archive', map);
        const lit = (g) => (g === 1 ? 1 : 0);
        const allLit = () => 1;
        const shadow = (g) => (g === 1 ? { family: 'upright', frame: 0, dx: 0 } : null);

        // A fully lit landmark has no patch, until a room carries a stamp.
        assert.equal(rg.patch('archive', allLit, allLit), null);
        const fullyLit = rg.patch('archive', allLit, allLit, shadow);
        assert.ok(fullyLit, 'a shadow makes `any` true');
        assert.match(fullyLit.key, /\|1SuprightS500/);

        const ink = shadowInkFor(map, shadow);
        const inked = [];
        for (let i = 0; i < ink.length; i++) if (ink[i]) inked.push(i);
        assert.ok(inked.length > 0);

        // Gate up: ink is the room's unlit albedo at full alpha; the rest of the
        // worked room passes the lit glass through.
        const up = rg.patch('archive', lit, lit, shadow);
        const upPixels = up.canvas.last;
        // Gate down: an all-unlit base patch, then the lit part on top.
        const base = rg.patch('archive', () => 0, () => 0).canvas.last;
        const part = rg.litPatch('archive', lit, shadow);
        assert.ok(part);
        assert.match(part.key, /\|1SuprightS500/, 'litPatch keys the same stamp');
        const partAlbedo = part.canvas.last;
        const partEmissive = part.emissiveCanvas.last;

        let emitting = 0;
        for (let y = 0; y < map.h; y++) {
            for (let x = 0; x < map.w; x++) {
                const local = y * map.w + x;
                if (map.group[local] !== 1) continue;
                const s = ((y + map.top) * map.spriteWidth + x + map.left) * 4;
                const o = local * 4;
                const srcA = map.albedo[s + 3];
                const emA = map.emissive[s + 3];
                if (ink[local]) {
                    assert.equal(upPixels[o + 3], srcA, 'ink alpha is the albedo alpha (step 1)');
                    assert.deepEqual([...upPixels.slice(o, o + 3)], [...map.albedo.slice(s, s + 3)], 'ink is unlit albedo');
                    assert.equal(partAlbedo[o + 3], 0, 'litPatch leaves ink empty (no albedo)');
                    assert.equal(partEmissive[o + 3], 0, 'litPatch leaves ink empty (no emissive)');
                    assert.equal(base[o + 3], srcA, 'the all-unlit base patch shows the ink');
                    continue;
                }
                // Both paths emit on exactly the same non-ink texels.
                const upEmits = upPixels[o + 3] === 0 && emA > 0;
                const downEmits = partAlbedo[o + 3] > 0 && partEmissive[o + 3] > 0;
                assert.equal(downEmits, upEmits && srcA > 0, `texel ${x},${y} emits on both paths`);
                if (upEmits) emitting++;
            }
        }
        assert.ok(emitting > 0, 'the worked room still glows around its shadow');

        // Same descriptors: the cached canvas is reused, no rebuild.
        const rev = rg.patch('archive', lit, lit, shadow).revision;
        assert.equal(rg.patch('archive', lit, lit, shadow).revision, rev, 'unchanged key, unchanged canvas');
        const moved = rg.patch('archive', lit, lit, (g) => (g === 1 ? { family: 'upright', frame: 0, dx: 1 } : null));
        assert.equal(moved.revision, rev + 1, 'a pacing slide rebuilds');
        assert.match(moved.key, /\|1SuprightS501/);
    });
});

// ─── BuildingSprite truth gates ─────────────────────────────────────────────

const READ_META = Object.freeze({ cell: 92, groups: { read: { rows: [17, 20] }, strike: { rows: [5, 10], contactFrame: 3 } } });
function body(id, { group = 'read', frame = 0, stale = false, moving = false, direction = 0 } = {}) {
    return {
        agent: { id },
        observation: { state: stale ? 'stale' : 'live' },
        moving,
        direction,
        currentPoseCell: () => ({ source: 'strip', group, sy: (READ_META.groups[group].rows[0] + frame) * 92, meta: READ_META }),
    };
}

function shadowFixture(type, {
    minute = 23 * 60,
    zoom = 2,
    motionScale = 1,
    assignment = [['w1', 0]],
    routing = [],
    lit = null,
    sprites = [body('w1')],
} = {}) {
    const map = realMap(type);
    const litRooms = new Float32Array(map.rooms);
    for (const [, room] of assignment) litRooms[room] = 1;
    for (const [, room] of routing) litRooms[room] = ROUTING_ROOM_GATE;
    if (lit) lit(litRooms);
    const slots = {
        rooms: map.rooms,
        assignment: new Map(assignment),
        routingAssignment: new Map(routing),
        allAssignment: new Map([...assignment, ...routing]),
    };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: [{ type }],
        agentSprites: sprites,
        atmosphereState: { clock: { minuteOfDay: minute } },
        motionScale,
        roomGlass: { map: (t) => (t === type ? map : null), roomCount: (t) => (t === type ? map.rooms : 0) },
        _roomSlotsByType: new Map([[type, slots]]),
        _roomLitByType: new Map([[type, litRooms]]),
        _apertureModel: null,
        _apertureProfile: null,
    });
    renderer.setZoom(zoom);
    return renderer;
}

test('§1.5 gate 1: only an arrived worker in slots.assignment casts a shadow (never routing, never the keeper pane)', () => {
    const worked = shadowFixture('archive');
    assert.equal(worked._advanceRoomShadows(1000), 'archive');
    assert.deepEqual(worked.shadowFor('archive', 1), { family: 'bowed', frame: 0, dx: 0 });
    for (let group = 2; group <= 10; group++) assert.equal(worked.shadowFor('archive', group), null);

    const routed = shadowFixture('archive', { assignment: [], routing: [['w1', 0]] });
    assert.ok(routed.roomGate('archive', 0) > 0.5, 'the routed room is lit at 0.6');
    assert.equal(routed._advanceRoomShadows(1000), null);
    assert.equal(routed.shadowFor('archive', 1), null, 'routingAssignment (0.6) carries no stamp');

    const keeper = shadowFixture('archive', { assignment: [], lit: (rooms) => { rooms[0] = KEEPER_ROOM_GATE; } });
    assert.equal(keeper._advanceRoomShadows(1000), null);
    assert.equal(keeper.shadowFor('archive', 1), null, 'the keeper pane (0.40) carries no stamp');
});

test('§1.5 gate 2: the stepped night share must reach 0.5', () => {
    const noon = shadowFixture('archive', { minute: 12 * 60 });
    assert.equal(noon._advanceRoomShadows(1000), null);
    assert.equal(noon.shadowFor('archive', 1), null);
    const rising = shadowFixture('archive', { lit: (rooms) => { rooms[0] = 0.44; } });
    assert.equal(rising._advanceRoomShadows(1000), null, 'a room still rising past 0.4 waits');
    const risen = shadowFixture('archive', { lit: (rooms) => { rooms[0] = 0.5; } });
    assert.equal(risen._advanceRoomShadows(1000), 'archive');
});

test('§1.5 gate 3: the camera rest-tier target must be >= 2', () => {
    assert.equal(shadowFixture('archive', { zoom: 1.5 })._advanceRoomShadows(1000), null);
    assert.equal(shadowFixture('archive', { zoom: 1 })._advanceRoomShadows(1000), null);
    assert.equal(shadowFixture('archive', { zoom: 3 })._advanceRoomShadows(1000), 'archive');
    // Mid-glide the rest-tier target decides, never the instantaneous zoom.
    const gliding = shadowFixture('archive');
    gliding.setZoom(1.7, 2);
    assert.equal(gliding._advanceRoomShadows(1000), 'archive', 'gliding in to tier 2');
    gliding.setZoom(1.9, 1);
    assert.equal(gliding._advanceRoomShadows(1000 + ROOM_SHADOW_QUANTUM_MS), 'archive');
    assert.equal(gliding.shadowFor('archive', 1), null, 'gliding out to tier 1');
    const withCamera = shadowFixture('archive', { zoom: 1 });
    withCamera.camera = { targetZoom: 2, zoom: 1.2 };
    assert.equal(withCamera._advanceRoomShadows(1000), 'archive', 'camera.targetZoom wins');
});

test('§1.5 gates 4 and 5: no stamp under an open aperture cut or on a postcard frame', () => {
    const open = shadowFixture('archive');
    open._roomUnderOpenAperture = (type, room) => room === 0;
    assert.equal(open._advanceRoomShadows(1000), null);
    assert.equal(open.shadowFor('archive', 1), null);

    const live = shadowFixture('archive');
    assert.equal(live._advanceRoomShadows(1000), 'archive');
    assert.ok(live.shadowFor('archive', 1));
    const { result } = withPostcardFrame(() => ({
        shadow: live.shadowFor('archive', 1),
        advanced: live._advanceRoomShadows(5000),
        desired: live._desiredRoomShadows('archive', 5000, () => new Map()).key,
    }));
    assert.deepEqual(result, { shadow: null, advanced: null, desired: '' });
    assert.ok(live.shadowFor('archive', 1), 'the live frame keeps its stamp');
});

test('§1.5: frame parity, pacing, stale freeze and reduced motion', () => {
    const odd = shadowFixture('archive', { sprites: [body('w1', { frame: 3 })] });
    odd._advanceRoomShadows(1000);
    assert.deepEqual(odd.shadowFor('archive', 1), { family: 'bowed', frame: 1, dx: 0 });

    const reduced = shadowFixture('archive', { motionScale: 0, sprites: [body('w1', { frame: 3 })] });
    reduced._advanceRoomShadows(1000);
    assert.deepEqual(reduced.shadowFor('archive', 1), { family: 'bowed', frame: 0, dx: 0 }, 'reduced motion: frame 0');

    const pacing = { agent: { id: 'w1' }, observation: { state: 'live' }, moving: true, direction: 6, currentPoseCell: () => null };
    assert.deepEqual(roomShadowDescriptor(pacing), { family: 'upright', frame: 0, dx: -1 });
    assert.deepEqual(roomShadowDescriptor({ ...pacing, direction: 2 }), { family: 'upright', frame: 0, dx: 1 });
    assert.deepEqual(roomShadowDescriptor(pacing, { motion: false }), { family: 'upright', frame: 0, dx: 0 }, 'reduced motion: dx 0');
    assert.deepEqual(roomShadowDescriptor({ ...pacing, moving: false }), { family: 'upright', frame: 0, dx: 0 });

    const prev = { family: 'bowed', frame: 1, dx: 0 };
    assert.equal(roomShadowDescriptor(body('w1', { frame: 2, stale: true }), { prev }), prev, 'a stale observation freezes the stamp');

    const sipper = {
        agent: { id: 'patron' },
        observation: { state: 'live' },
        currentPoseCell: () => ({ source: 'strip', group: 'drink', sy: 0, meta: { cell: 92, groups: { drink: { rows: [0, 4] } } } }),
    };
    const frames = new Set();
    for (let t = 0; t < 60000; t += 50) frames.add(roomShadowDescriptor(sipper, { nowMs: t }).frame);
    assert.deepEqual([...frames].sort(), [0, 1], 'the seated stamp lifts on the real seeded sip');
    assert.equal(roomShadowDescriptor(sipper, { motion: false, nowMs: 1234 }).frame, 0);

    assert.equal(poseStripFrame(body('w1', { frame: 2 }).currentPoseCell()), 2);
    assert.equal(poseStripFrame({ source: 'sheet' }), 0);
});

test('§1.5: the Forge rhythm pane dips 1.0 -> 0.75 for one quantum on the strike contact, holds 1.0 under reduced motion', () => {
    assert.equal(ROOM_RHYTHM_DIP, 0.75);
    const smith = (frame) => body('smith', { group: 'strike', frame });
    assert.equal(onStrikeContact(smith(3)), true);
    assert.equal(onStrikeContact(smith(2)), false);
    assert.equal(onStrikeContact(body('smith', { group: 'strike', frame: 3, stale: true })), false);

    const sprites = [smith(3)];
    const forge = shadowFixture('forge', { assignment: [['smith', 0]], sprites });
    assert.equal(forge.roomGlassGate('forge', 0), 1);
    assert.equal(forge._advanceRoomShadows(1000), 'forge');
    assert.equal(forge.roomGlassGate('forge', 0), 0.75, 'the contact dims the shop window one rung');
    assert.equal(forge.roomGate('forge', 0), 1, 'roomGate (pools, water columns, bloom) never flickers');
    assert.equal(forge.shadowFor('forge', 1), null, 'a rhythm pane carries no ink');
    sprites[0] = smith(4);
    assert.equal(forge._advanceRoomShadows(1000 + ROOM_SHADOW_QUANTUM_MS - 1), null, 'the dip holds its quantum');
    assert.equal(forge.roomGlassGate('forge', 0), 0.75);
    assert.equal(forge._advanceRoomShadows(1000 + ROOM_SHADOW_QUANTUM_MS), 'forge');
    assert.equal(forge.roomGlassGate('forge', 0), 1, 'and lifts after exactly one quantum');

    const reduced = shadowFixture('forge', { assignment: [['smith', 0]], sprites: [smith(3)], motionScale: 0 });
    for (let t = 0; t < 3000; t += 16) {
        reduced._advanceRoomShadows(t);
        assert.equal(reduced.roomGlassGate('forge', 0), 1);
    }
    reduced.motionScale = 1;
    reduced._advanceRoomShadows(10000);
    assert.equal(reduced.roomGlassGate('forge', 0), 0.75);
    reduced.motionScale = 0;
    assert.equal(reduced.roomGlassGate('forge', 0), 1, 'reduced motion drops a pending dip at once');
});

test('§1.6: at most one building rebuilds per frame, each at most once per 320 ms quantum', () => {
    const renderer = shadowFixture('archive', { sprites: [body('w1'), body('h1')] });
    const harbor = realMap('harbor');
    const archive = realMap('archive');
    renderer.buildings = [{ type: 'archive' }, { type: 'harbor' }];
    renderer.roomGlass = { map: (t) => (t === 'archive' ? archive : t === 'harbor' ? harbor : null) };
    const harborLit = new Float32Array(harbor.rooms);
    harborLit[0] = 1;
    renderer._roomLitByType.set('harbor', harborLit);
    renderer._roomSlotsByType.set('harbor', { rooms: harbor.rooms, assignment: new Map([['h1', 0]]), routingAssignment: new Map() });

    assert.equal(renderer._advanceRoomShadows(1000), 'archive');
    assert.equal(renderer.shadowFor('harbor', 1), null, 'the harbor waits its turn');
    assert.equal(renderer._advanceRoomShadows(1016), 'harbor');
    assert.equal(renderer._advanceRoomShadows(1032), null);

    // Animate both every frame for 10 s: per building <= 3.125 changes/s, never two in one frame.
    const changes = { archive: [], harbor: [] };
    let frame = 0;
    for (let t = 2000; t < 12000; t += 16, frame++) {
        renderer.agentSprites = [body('w1', { frame: frame % 4 }), body('h1', { frame: (frame >> 1) % 4 })];
        const changed = renderer._advanceRoomShadows(t);
        if (changed) changes[changed].push(t);
    }
    for (const [type, times] of Object.entries(changes)) {
        assert.ok(times.length > 0, `${type} animates`);
        for (let i = 1; i < times.length; i++) {
            assert.ok(times[i] - times[i - 1] >= ROOM_SHADOW_QUANTUM_MS, `${type} changes at most once per quantum`);
        }
        assert.ok(times.length / 10 <= 1000 / ROOM_SHADOW_QUANTUM_MS, `${type} <= 3.1 Hz`);
    }
});

// One simulated second of the worst case: every S-class room of the five
// stamp buildings and both Forge rhythm panes held and animating every frame.
// A frame's cost is `_advanceRoomShadows` plus the one glass patch it changed
// (the gate-up rebuild and its gate-down twin, litPatch).
function simulatedSecond() {
    const types = ['archive', 'harbor', 'tavern', 'command', 'watchtower', 'forge'];
    const rg = new RoomGlass(null);
    const slotsByType = new Map();
    const litByType = new Map();
    for (const type of types) {
        const map = realMap(type, { pixels: true });
        rg._maps.set(type, map);
        const held = [];
        for (let group = 1; group <= map.rooms; group++) if (map.roomShadows[group]?.cls) held.push([`${type}-${group}`, group - 1]);
        slotsByType.set(type, { rooms: map.rooms, assignment: new Map(held), routingAssignment: new Map() });
        const lit = new Float32Array(map.rooms);
        for (const [, room] of held) lit[room] = 1;
        litByType.set(type, lit);
    }
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: types.map((type) => ({ type })),
        agentSprites: [],
        atmosphereState: { clock: { minuteOfDay: 23 * 60 } },
        motionScale: 1,
        roomGlass: rg,
        _roomSlotsByType: slotsByType,
        _roomLitByType: litByType,
        _apertureModel: null,
        _apertureProfile: null,
    });
    renderer.setZoom(2);
    const frames = [];
    for (let frame = 0; frame < 60; frame++) {
        const now = 10000 + frame * 16;
        renderer.agentSprites = [];
        for (const type of types) {
            for (const [id] of slotsByType.get(type).assignment) {
                // Smiths alternate onto the strike contact (frame 3); readers turn pages.
                const pose = type === 'forge' ? { group: 'strike', frame: frame % 2 ? 3 : 4 } : { group: 'read', frame: frame % 4 };
                renderer.agentSprites.push(body(id, pose));
            }
        }
        const start = process.hrtime.bigint();
        const changed = renderer._advanceRoomShadows(now);
        if (changed) {
            rg.patch(changed, (g) => renderer._glassGroupGate(changed, g), (g) => renderer._nightGlassGroupGate(changed, g), (g) => renderer.shadowFor(changed, g));
            rg.litPatch(changed, (g) => renderer._nightGlassGroupGate(changed, g), (g) => renderer.shadowFor(changed, g));
        }
        frames.push({ ms: Number(process.hrtime.bigint() - start) / 1e6, changed });
    }
    return frames;
}

test('§1.6: shadow rebuilds cost <= 0.1 ms per frame averaged over a second and <= 0.4 ms in the worst frame', () => {
    withFakeDocument(() => {
        for (let i = 0; i < 4; i++) simulatedSecond();
        // The same deterministic second replayed; each frame keeps its fastest
        // replay, so a host GC or scheduler stall is not charged to the code.
        const replays = Array.from({ length: 7 }, () => simulatedSecond());
        const frames = replays[0].map((frame, index) => ({
            changed: frame.changed,
            ms: Math.min(...replays.map((replay) => replay[index].ms)),
        }));
        for (const replay of replays) assert.deepEqual(replay.map((f) => f.changed), frames.map((f) => f.changed), 'replays are deterministic');
        const rebuilds = frames.filter((f) => f.changed).length;
        assert.ok(rebuilds > 0 && rebuilds <= 60, `${rebuilds} rebuilds, at most one per frame`);
        const perType = {};
        for (const f of frames) if (f.changed) perType[f.changed] = (perType[f.changed] || 0) + 1;
        for (const [type, count] of Object.entries(perType)) assert.ok(count <= Math.ceil(1000 / ROOM_SHADOW_QUANTUM_MS), `${type} ${count}/s`);
        const mean = frames.reduce((sum, f) => sum + f.ms, 0) / frames.length;
        const worst = Math.max(...frames.map((f) => f.ms));
        assert.ok(mean <= 0.1, `average frame ${mean.toFixed(4)} ms`);
        assert.ok(worst <= 0.4, `worst frame ${worst.toFixed(4)} ms`);
    });
});
