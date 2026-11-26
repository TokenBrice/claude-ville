import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FROST_FALLBACK_SUN,
    FROST_MELT_ELEVATIONS,
    frostMeltQuarter,
    frostQuarterOf,
    frostRisingAt,
    frostRisingOf,
    frostSunFor,
    groundOptionsFor,
    groundStateAt,
    isFrostMonth,
} from '../../claudeville/src/presentation/character-mode/GroundState.js';
import { FROST_SHADE, frostHolds, frostShadeField } from '../../claudeville/src/presentation/character-mode/FrostMelt.js';
import { normalizeTimelineKnots } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { terrainArtifactKey } from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';

// BI-5 — frost mornings from November to February that melt by the real
// sun (the snapshot's `atmosphere.solar`), in quarters, from the sunny side.

const CLEAR = normalizeTimelineKnots([{ minute: 0, type: 'clear' }]);
const deg = Math.PI / 180;

// A real-sun stand-in for `atmosphere.solar` at 44.8° N: declination from
// the day of the year, the hour angle from solar noon (minutes of the day).
function solarAt(date, minute, noon = 700) {
    const day = Math.round((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
    const decl = -23.44 * Math.cos(2 * Math.PI * (day + 10) / 365) * deg;
    const lat = 44.8 * deg;
    const hour = (minute - noon) / 4 * deg;
    const elevationDeg = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hour)) / deg;
    const halfDay = Math.acos(-Math.tan(lat) * Math.tan(decl)) / deg * 4;
    return { sunriseMinute: noon - halfDay, solarNoonMinute: noon, sunsetMinute: noon + halfDay, elevationDeg };
}

function frostAt(date, minute, knots = CLEAR, noon = 700) {
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minute / 60), minute % 60);
    const sun = frostSunFor({ solar: solarAt(at, minute, noon) });
    return groundStateAt(at, { timelineKnots: knots, sun }).frost;
}

test('the melt clock steps down with the sun, never with fixed hours', () => {
    const sun = (elevationDeg) => ({ sunriseMinute: 420, solarNoonMinute: 700, elevationDeg });
    assert.equal(frostMeltQuarter(sun(0), 22 * 60 + 5), 1, 'the night rimes from 22:00, a quarter at a time');
    assert.equal(frostMeltQuarter(sun(0), 1 * 60), 4, 'whole from 01:00');
    assert.equal(frostMeltQuarter(sun(0), 3 * 60), 4);
    assert.equal(frostMeltQuarter(sun(-2), 419), 4, 'whole until sunrise');
    const steps = [0, ...FROST_MELT_ELEVATIONS];
    for (let i = 0; i < steps.length; i++) {
        assert.equal(frostMeltQuarter(sun(steps[i] + 0.01), 500), 4 - i, `at ${steps[i]}°`);
    }
    assert.equal(frostMeltQuarter(sun(12), 700), 0, 'gone at solar noon, however low the sun');
    assert.equal(frostMeltQuarter(sun(5), 15 * 60), 0, 'never back in the afternoon');
    // The same clock minute under a later sunrise is an earlier stage.
    assert.equal(frostMeltQuarter({ sunriseMinute: 480, solarNoonMinute: 760, elevationDeg: 0 }, 470), 4);
    assert.equal(frostMeltQuarter({ sunriseMinute: 400, solarNoonMinute: 680, elevationDeg: 6 }, 470), 2);
});

test('frost lies from November to February after a clear night, read at sunrise', () => {
    assert.deepEqual([...Array(12).keys()].filter(isFrostMonth), [0, 1, 10, 11]);
    assert.equal(frostAt(new Date(2026, 9, 20), 180), 0, 'October');
    assert.equal(frostAt(new Date(2026, 10, 3), 180), 4, '3 November');
    assert.equal(frostAt(new Date(2027, 1, 20), 180), 4, 'February');
    assert.equal(frostAt(new Date(2027, 2, 5), 180), 0, 'March');
    assert.equal(frostAt(new Date(2026, 10, 20), 21 * 60), 0, 'no rime before 22:00');
    // A cloudy night lays none; a clear night clouding over after sunrise
    // still melts by the sun; rain falling now (overcast's drizzle too)
    // melts it.
    const cloudy = normalizeTimelineKnots([{ minute: 0, type: 'overcast' }]);
    assert.equal(frostAt(new Date(2026, 11, 15), 180, cloudy), 0);
    const clouding = normalizeTimelineKnots([{ minute: 0, type: 'clear' }, { minute: 480, type: 'clear' }, { minute: 500, type: 'partly-cloudy' }]);
    assert.equal(frostAt(new Date(2026, 11, 15), 530, clouding), frostAt(new Date(2026, 11, 15), 530));
    assert.ok(frostAt(new Date(2026, 11, 15), 530, clouding) > 0);
    const shower = normalizeTimelineKnots([{ minute: 0, type: 'clear' }, { minute: 480, type: 'clear' }, { minute: 500, type: 'rain' }]);
    assert.equal(frostAt(new Date(2026, 11, 15), 530, shower), 0);
});

test('a frosty morning steps 4 → 0 once, slower under the low December sun', () => {
    const melt = (date) => {
        let last = 4;
        const steps = [];
        for (let minute = 60; minute < 13 * 60; minute += 5) {
            const q = frostAt(date, minute);
            assert.ok(q <= last, `${date.toDateString()} ${minute}: ${last} → ${q}`);
            if (q !== last) steps.push([minute, q]);
            last = q;
        }
        assert.equal(last, 0);
        assert.deepEqual(steps.map(([, q]) => q), [3, 2, 1, 0]);
        return steps;
    };
    const november = melt(new Date(2026, 10, 20));
    const december = melt(new Date(2026, 11, 21));
    // Each step comes later on the solstice: the sun rises later and lower.
    for (let i = 0; i < 4; i++) assert.ok(december[i][0] > november[i][0], `step ${i}`);
    // The rime lingers in the shade (quarter 1) for over an hour in December.
    assert.ok(december[3][0] - december[2][0] >= 60);
});

test('the snapshot carries its sun into the ground state, with a fallback day', () => {
    const solar = { sunriseMinute: 427, solarNoonMinute: 701, elevationDeg: 5.6 };
    assert.deepEqual(frostSunFor({ solar }), { sunriseMinute: 427, solarNoonMinute: 701, elevationDeg: 5.6 });
    assert.deepEqual(groundOptionsFor({ solar, timeline: null }).sun, frostSunFor({ solar }));
    const fallback = frostSunFor({ clock: { minuteOfDay: FROST_FALLBACK_SUN.solarNoonMinute } });
    assert.equal(fallback.sunriseMinute, FROST_FALLBACK_SUN.sunriseMinute);
    assert.equal(Math.round(fallback.elevationDeg), FROST_FALLBACK_SUN.noonElevationDeg);
    assert.equal(frostSunFor({ clock: { minuteOfDay: 300 } }).elevationDeg, 0);
    // The terrain keys carry the quarter.
    assert.equal(frostQuarterOf({ frost: 3 }), 3);
    assert.equal(frostQuarterOf({ frost: 9 }), 4);
    assert.equal(frostQuarterOf(null), 0);
    const inputs = { assetVersion: 'a', configHash: 'c', season: 'winter', sceneryRevision: 0, snowBucket: 0, bounds: { x: 0, y: 0, w: 1, h: 1 }, dpr: 1, phenology: 'winter' };
    for (const frost of [0, 1, 2, 3, 4]) assert.ok(terrainArtifactKey({ ...inputs, frost }), `frost ${frost}`);
    for (const frost of [5, -1, 0.5, true]) assert.equal(terrainArtifactKey({ ...inputs, frost }), null);
});

test('shade keeps the rime at every quarter and the open lawn melts in nested patches', () => {
    // Node has no canvas, so the casts are absent: the walls' AO is the shade.
    const cols = 64;
    const rows = 64;
    const aoBuf = new Uint8Array(cols * rows);
    for (let row = 20; row < 30; row++) for (let col = 10; col < 14; col++) aoBuf[row * cols + col] = 200;
    const field = frostShadeField({ world: { buildings: new Map() }, treePropSprites: [] }, { cols, rows, x0: 0, y0: 0, texelW: 2, aoBuf });
    assert.equal(field.shade[25 * cols + 12], FROST_SHADE.WALL);
    assert.equal(field.shade[5 * cols + 50], FROST_SHADE.OPEN);
    for (const quarter of [1, 2, 3]) assert.ok(frostHolds(quarter, field, 12, 25, 0.99), `wall lee at ${quarter}`);
    assert.equal(frostHolds(4, field, 50, 5, 0.99), true);
    assert.equal(frostHolds(0, field, 12, 25, 0), false);
    assert.equal(frostHolds(1, field, 60, 60, 0.01), false, 'the open lawn far from shade is clear at 1');
    for (let order = 0; order <= 1; order += 0.05) {
        for (const [col, row] of [[60, 60], [16, 25], [20, 40]]) {
            for (const quarter of [1, 2]) {
                if (frostHolds(quarter, field, col, row, order)) assert.ok(frostHolds(quarter + 1, field, col, row, order), 'nested');
            }
        }
    }
    // Beside the shade the rime outlasts the open lawn (the sunny side goes first).
    const order = 0.5;
    assert.equal(frostHolds(2, field, 60, 60, order), false);
    assert.equal(frostHolds(2, field, 15, 24, order), true);
});

test('EY-5: the rime of a clear night rises 1 → 4 from 22:00 to 01:00, at most three extra bakes', () => {
    assert.deepEqual([21 * 60 + 55, 22 * 60, 22 * 60 + 55, 23 * 60, 23 * 60 + 59, 0, 59, 60, 3 * 60].map(frostRisingAt),
        [false, true, true, true, true, true, true, false, false]);
    const evening = new Date(2026, 10, 20);
    const morning = new Date(2026, 10, 21);
    const stages = [];
    const stageAt = (date, minute) => {
        const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minute / 60), minute % 60);
        const sun = frostSunFor({ solar: solarAt(at, minute) });
        const ground = groundStateAt(at, { timelineKnots: CLEAR, sun });
        return `${frostQuarterOf(ground)}${frostRisingOf(ground) ? 'r' : ''}`;
    };
    for (let minute = 21 * 60; minute < 24 * 60; minute += 5) stages.push(stageAt(evening, minute));
    for (let minute = 0; minute < 13 * 60; minute += 5) stages.push(stageAt(morning, minute));
    const changes = stages.filter((stage, i) => i === 0 || stage !== stages[i - 1]);
    // Each stage is one terrain bake: three rising quarters ahead of the
    // whole rime, then the melt.
    assert.deepEqual(changes, ['0', '1r', '2r', '3r', '4', '3', '2', '1', '0']);
    // The rising and melting quarters key apart.
    const inputs = { assetVersion: 'a', configHash: 'c', season: 'winter', sceneryRevision: 0, snowBucket: 0, bounds: { x: 0, y: 0, w: 1, h: 1 }, dpr: 1, phenology: 'winter' };
    for (const frost of [1, 2, 3]) assert.notEqual(terrainArtifactKey({ ...inputs, frost }), terrainArtifactKey({ ...inputs, frost, frostRising: true }));
    assert.equal(terrainArtifactKey({ ...inputs, frost: 4 }), terrainArtifactKey({ ...inputs, frost: 4, frostRising: true }));
});

test('layered crest bounds, frost and settled snow exclude both kinds of baked Codex sidearm', async t => {
    const { AgentSprite } = await import('../../claudeville/src/presentation/character-mode/AgentSprite.js');
    const { clearLayerCaches, paletteIdentity } = await import('../../claudeville/src/presentation/character-mode/AgentLayerRecords.js');
    // These fixtures use the first cell and unscaled, opaque stamps. Keep
    // pixel copies and source-in coverage observable without a browser.
    function raster(width = 0, height = 0) {
        const canvas = { width, height };
        let data;
        function pixels() { return data ||= new Uint32Array(canvas.width * canvas.height); }
        const ctx = {
            canvas, save() {}, restore() {}, translate() {},
            getImageData() { return { data: new Uint8ClampedArray(pixels().slice().buffer) }; },
            putImageData(image) { pixels().set(new Uint32Array(image.data.buffer)); },
            clearRect(x, y, w, h) {
                for (let row = y; row < Math.min(y+h, canvas.height); row++) {
                    if (x < canvas.width) pixels().fill(0, row*canvas.width+x, row*canvas.width+Math.min(x+w,canvas.width));
                }
            },
            fillRect(x, y, w, h) {
                for (let row=y; row<y+h; row++) for (let col=x; col<x+w; col++) {
                    const i = row*canvas.width+col;
                    if (this.globalCompositeOperation !== 'source-in' || pixels()[i]) pixels()[i] = 0xffaaaaaa;
                }
            },
            drawImage(source, ...args) {
                const [sx,sy,w,h,x,y] = args.length === 2 ? [0,0,source.width,source.height,...args] : args;
                for (let row=0; row<h; row++) for (let col=0; col<w; col++) {
                    const value = source.pixel(sx+col, sy+row);
                    if (value >>> 24) pixels()[(row+y)*canvas.width+col+x] = value;
                }
            },
        };
        canvas.getContext = () => ctx;
        canvas.pixel = (x,y) => x >= 0 && x < canvas.width && y >= 0 && y < canvas.height ? pixels()[y*canvas.width+x] : 0;
        return canvas;
    }
    const prev = globalThis.document;
    globalThis.document = { createElement: () => raster() };
    t.after(() => { globalThis.document = prev; clearLayerCaches(); });
    for (const [modelClass, model, toolY] of [['gpt54','agent.codex.gpt54',8], ['spark','agent.codex.gpt53spark',50]]) {
        const sheet = raster(736,92);
        sheet.getContext().fillRect(35,30,20,42);
        sheet.getContext().fillRect(72,toolY,7,3);
        const hat = raster(28,8);
        hat.getContext().fillRect(0,0,28,8);
        const sprite = Object.assign(Object.create(AgentSprite.prototype), {
            assets: {}, spriteCanvas: sheet, _spriteProfileKey: model, _frozenTintCellCache: new Map(), _cellBoundsCache: new Map(),
            _layerProfile: { identity: { modelClass }, palette: paletteIdentity(model,0,null) },
            _cellHead: () => ({ source: hat, sx: 0, sy: 0, sw: 28, sh: 8, x: 30, y: 14, key: 'crest' }),
            _shouldScrubBakedCodexWeapon: () => true, _updatePrivateDerivedEstimate() {},
        });
        const cell = { sx: 0, sy: 0, sw: 92, sh: 92 };
        const bounds = sprite._getCellContentBounds(cell);
        assert.deepEqual([bounds.minY,bounds.minX,bounds.maxX], [14,30,57], model);
        const dressed = sprite._dressedCell(cell);
        const frost = sprite._getFrozenTintCell(cell,dressed);
        assert.ok(frost.pixel(30,14), model + ' frosted brim');
        assert.equal(frost.pixel(74,toolY), 0, model + ' tool stays clear');
        const snow = sprite._snowCapCell(cell,dressed);
        assert.deepEqual([snow.__cvSnowX,snow.__cvSnowY,snow.width], [30,14,28], model);
        assert.ok(snow.pixel(0,0), model + ' snow on brim');
    }
});
