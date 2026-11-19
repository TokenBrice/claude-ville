import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import { Compositor, HEAD_APEX_COLUMNS } from '../../claudeville/src/presentation/character-mode/Compositor.js';

const CELL = 92;
const ANCHOR_X = 46;
const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

function sheet(id) {
    return PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/characters/${id}/sheet.png`, import.meta.url)));
}

// The effort crest anchors to the head apex. Mythos holds its ouroboros staff
// head level with the hood, so an unrestricted scan centres the crest on the
// ring (from the back: right of the hood, toward the staff).
test('the Mythos crest apex stays on the hood in every walk and idle cell', () => {
    const png = sheet('agent.claude.mythos');
    const comp = Object.create(Compositor.prototype);
    const columns = HEAD_APEX_COLUMNS['agent.claude.mythos'];
    let drifted = 0;
    for (let row = 0; row < 10; row++) {
        DIRECTIONS.forEach((dir, col) => {
            const cellX = col * CELL;
            const cellY = row * CELL;
            const apex = comp._cellHeadApex(png.data, png.width, cellX, cellY, CELL, columns);
            assert.ok(apex.found, `${dir} row ${row}`);
            const dx = apex.centroidX - cellX - ANCHOR_X;
            assert.ok(Math.abs(dx) <= 3, `${dir} row ${row}: crest ${dx.toFixed(1)} px off the hood`);
            const unrestricted = comp._cellHeadApex(png.data, png.width, cellX, cellY, CELL);
            if (Math.abs(unrestricted.centroidX - cellX - ANCHOR_X) > 5) drifted++;
        });
    }
    // The restriction must be doing work: most cells drift without it.
    assert.ok(drifted >= 40, `only ${drifted} cells drift unrestricted`);
});

test('the apex column window is reserved for bodies whose staff rises to the hood', () => {
    assert.deepEqual(Object.keys(HEAD_APEX_COLUMNS), ['agent.claude.mythos']);
});
