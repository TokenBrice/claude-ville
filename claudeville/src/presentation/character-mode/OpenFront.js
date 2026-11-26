// Wave 5-B — Generalized open-front occlusion & depth-splitting engine.
//
// Generalizes `TavernArcade.js`'s open-front pier/lintel depth splitting into
// a reusable profile-driven engine for any open-front building (`tavern`,
// `forge`, future open bays).
//
// An open-front building's ground floor lies inside its sprite: an agent
// standing in the open bay must render IN FRONT of the rear interior (bar,
// hearth, anvil) yet BEHIND the front arch lintel and piers, while an agent
// outside in the yard renders IN FRONT of the front arch.
//
// Each profile in `OPEN_FRONT_PROFILES` declares:
//   - `frontArchRows`: compact `"y:x+len,x+len;"` mask runs of front arch
//     lintel, spandrels and piers in base.png sprite pixels.
//   - `interiorFloorBounds`: building-local open floor tile rects + sprite bounds.
//   - `lintelDepthBias`: world-Y bias applied along the front post line.
//   - `bays[]`: `{ id, at?, tile, pose, facing, anchorOffset }` authored bay
//     slots (`at`: the feet in base.png sprite px, when measured on the art).
//
// The Forge's profile (`FORGE_OPEN_FRONT_PROFILE`) is generated from its
// arcade art by scripts/sprites/bake-forge-openfront.mjs and is the only
// Forge profile; the Tavern's runs are TavernArcade's, preserved below.

import { BUILDING_DEFS } from '../../config/buildings.js';
import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { buildingCenterToWorld, tileToWorld, worldToTile } from './Projection.js';
import { lineOcclusionColumns, StaticPropSprite } from './StaticPropDrawables.js';
import { SpriteRenderer } from './SpriteRenderer.js';

export const DEFAULT_POST_LINE_INSET = 0.25;
export const DEFAULT_COLUMN_PX = 8;

// Exact Tavern open-front arcade runs (preserved from TavernArcade.js).
export const TAVERN_ARCH_ROWS = [
    '142:40+1;143:38+3;144:36+5;145:34+7;146:32+9;147:30+11;148:28+13;149:27+14;150:27+14;151:27+14;',
    '152:27+14;153:27+14;154:28+13;155:28+13;156:28+15;157:28+17;158:28+19;159:28+22;160:28+24;',
    '161:28+13,42+12;162:26+15,43+13;163:24+34;164:22+38;165:20+42;166:18+47;167:16+9,27+40;',
    '168:16+9,28+41;169:16+5,22+3,28+17,50+21;170:16+3,22+5,28+16,53+20;171:16+1,20+23,55+20;',
    '172:19+23,56+21;173:17+25,58+22;174:16+26,59+23;175:16+25,60+24;176:16+25,61+25;177:16+25,61+27;',
    '178:16+25,62+28;179:16+25,63+29;180:16+25,63+32;181:16+25,64+33;182:16+25,64+35;183:16+25,65+36;',
    '184:16+25,65+38;185:16+25,65+19,89+16;186:16+25,65+17,91+16;187:16+25,65+16,93+17;',
    '188:16+25,65+16,95+17;189:16+11,28+13,65+16,86+6,96+18;190:16+9,28+13,65+16,84+10,99+17;',
    '191:16+7,28+13,64+2,67+14,85+11,100+18;192:16+5,28+13,62+2,67+14,84+14,102+18;',
    '193:16+3,28+13,60+2,68+14,83+1,86+14,104+18;194:16+1,28+13,58+2,68+13,83+2,89+12,107+18;',
    '195:28+13,56+2,68+13,82+1,91+11,109+18;196:28+13,54+2,69+12,82+1,93+9,110+19;',
    '197:28+13,52+2,69+12,82+1,94+9,112+19;198:28+13,50+2,69+12,94+10,112+21;',
    '199:28+13,48+2,69+13,87+1,93+12,112+23;200:28+13,46+2,69+13,94+11,112+25;',
    '201:28+13,44+2,69+13,96+10,112+28;202:28+13,42+2,69+14,98+8,112+30;203:28+14,69+13,100+7,112+32;',
    '204:27+15,69+13,101+6,112+13,126+20;205:26+16,69+13,103+5,112+13,127+21;',
    '206:26+16,69+13,107+1,112+14,130+20,172+1;207:26+16,69+13,108+1,112+13,132+20,170+3;',
    '208:26+16,69+14,108+1,112+13,134+21,167+6;209:26+17,69+13,109+1,112+13,136+21,165+8;',
    '210:26+16,69+13,109+1,112+13,129+4,138+21,162+11;',
    '211:26+14,69+13,109+1,112+13,127+2,133+2,140+33;212:26+13,69+13,109+1,112+13,126+2,135+2,142+31;',
    '213:26+14,69+13,109+2,112+13,126+1,137+2,144+29;214:26+13,40+1,69+13,110+1,112+14,139+1,146+27;',
    '215:27+12,42+1,69+13,110+1,112+14,140+1,147+26;216:29+11,44+1,69+13,110+1,112+13,142+1,149+24;',
    '217:31+7,40+2,45+2,69+13,111+14,143+1,151+22;218:33+3,42+2,48+1,69+13,112+13,144+1,153+20;',
    '219:44+2,49+2,69+13,112+13,144+1,153+20;220:45+2,51+2,69+13,112+13,145+1,153+20;',
    '221:47+2,53+3,69+13,112+13,145+2,153+20;222:49+2,56+1,69+13,112+13,146+1,153+20;',
    '223:51+2,58+1,69+13,112+13,147+1,153+20;224:53+3,59+2,69+13,88+1,112+13,147+1,153+20;',
    '225:56+2,61+3,69+14,111+14,148+1,153+20;226:58+1,63+2,68+16,112+13,148+1,153+20;',
    '227:59+2,65+2,68+16,112+13,149+1,153+20;228:61+2,67+17,112+13,149+1,153+20;',
    '229:63+2,68+16,92+1,112+13,150+1,153+20;230:65+2,68+16,112+13,150+1,153+20;',
    '231:67+17,100+1,112+13,150+1,153+20;232:68+14,112+13,150+1,153+20;233:68+13,112+13,151+1,153+20;',
    '234:68+13,112+13,151+1,153+20;235:68+15,112+13,151+1,153+20;236:68+17,112+13,151+1,153+20;',
    '237:70+17,112+13,151+1,153+20;238:72+8,81+8,112+13,152+21;239:74+5,83+8,112+13,153+20;',
    '240:75+2,85+8,112+13,153+20;241:87+8,112+13,153+20;242:89+8,112+13,153+20;',
    '243:91+8,102+1,112+13,153+20;244:93+8,112+13,151+22;245:95+8,112+13,153+20;',
    '246:97+8,111+14,153+20;247:99+8,110+16,153+20;248:101+8,110+16,153+20;249:103+23,153+20;',
    '250:105+21,127+1,152+21;251:107+20,153+20;252:109+17,153+20;253:110+15,153+20;254:110+15,153+20;',
    '255:110+15,153+20;256:110+15,128+2,153+20;257:110+16,153+20;258:111+17,153+20;',
    '259:113+9,123+7,153+20;260:115+6,124+8,153+20;261:117+2,126+8,153+20;262:128+8,153+20;',
    '263:130+8,140+1,153+20;264:133+7,153+20;265:135+7,153+20;266:137+7,153+20;267:138+8,151+22;',
    '268:140+8,150+23;269:142+31;270:144+29;271:146+26;272:148+22;273:150+18;274:151+16;275:151+16;',
    '276:151+16;277:151+16;278:151+16;279:152+14;280:154+10;281:156+6;282:158+2;',
].join('');

function freezeBay(bay) {
    return Object.freeze({
        id: bay.id,
        ...(Array.isArray(bay.at) ? { at: Object.freeze([bay.at[0], bay.at[1]]) } : {}),
        tile: Object.freeze({ tileX: bay.tile.tileX, tileY: bay.tile.tileY }),
        relTile: Object.freeze({ dx: bay.relTile.dx, dy: bay.relTile.dy }),
        pose: bay.pose,
        facing: bay.facing,
        anchorOffset: Object.freeze([bay.anchorOffset[0], bay.anchorOffset[1]]),
    });
}

function freezeRect(rect) {
    return Object.freeze({ dx: rect.dx, dy: rect.dy, width: rect.width, height: rect.height });
}

// W5 Fix-B (D6, Fable P0-5) — the Forge's two-arch smithy arcade. This block
// is the one Forge open-front profile: there is no geometric twin and no
// registry override (BuildingVisualRegistry's `forge.openFront` only names
// it). scripts/sprites/bake-forge-openfront.mjs paints the arcade into
// building.forge/base.png and measures this profile on it.
// <forge-open-front> — generated by scripts/sprites/bake-forge-openfront.mjs; do not hand-edit.
// The one authoritative Forge open-front profile, measured on the two-arch
// smithy arcade of building.forge/base.png: `frontArchRows` is every opaque
// texel of the arch window outside the arcade's interior (piers, knee braces,
// tie beam and gable, sill, trough and yard anvil); the bays are the two work
// tiles on row 29 (buildings.js `openFloor`), 4 texels behind the front plane.
export const FORGE_OPEN_FRONT_PROFILE = Object.freeze({
    id: 'forge',
    spriteId: 'building.forge',
    propId: 'forge-open-front',
    nativeSize: Object.freeze({ width: 256, height: 232 }),
    anchor: Object.freeze([128, 169]),
    footprint: Object.freeze({ width: 4, height: 3 }),
    source: Object.freeze({ base: '5c682c01aca4', hearth: '904eefa91b76', banked: '5a84e9b2e366' }),
    archWindow: Object.freeze({ left: 10, right: 112, top: 90, bottom: 231 }),
    postLineInset: -0.25,
    postLineSlope: TILE_HEIGHT / TILE_WIDTH,
    columnPx: DEFAULT_COLUMN_PX,
    lintelDepthBias: 0,
    rearWallInset: 2.5,
    interiorFloorBounds: Object.freeze({
        tileRects: Object.freeze([freezeRect({ dx: 0.5, dy: 2.5, width: 2, height: 0.75 })]),
        spriteBounds: Object.freeze({ left: 38, right: 90, top: 114, bottom: 196 }),
    }),
    bays: Object.freeze([
        freezeBay({
            id: 'forge-hearth',
            at: [80, 193],
            tile: { tileX: 28, tileY: 29 },
            relTile: { dx: 2, dy: 3 },
            pose: 'tinker',
            facing: 'north-east',
            anchorOffset: [0, 0],
        }),
        freezeBay({
            id: 'forge-anvil',
            at: [48, 177],
            tile: { tileX: 27, tileY: 29 },
            relTile: { dx: 1, dy: 3 },
            pose: 'hammer',
            facing: 'north-east',
            anchorOffset: [0, 0],
        }),
    ]),
    frontArchRows: [
        '90:35+78;91:34+79;92:33+80;',
        '93:32+81;94:31+82;95:30+83;',
        '96:29+84;97:28+85;98:27+86;',
        '99:26+87;100:25+88;101:24+89;',
        '102:23+90;103:22+91;104:21+92;',
        '105:20+93;106:19+94;107:18+95;',
        '108:18+95;109:17+96;110:18+95;',
        '111:19+94;112:20+93;113:21+92;',
        '114:26+17,44+1,48+65;115:26+15,44+1,48+65;116:26+13,52+61;',
        '117:26+13,52+61;118:26+12,53+60;119:26+12,53+60;',
        '120:26+12,55+58;121:26+12,57+12,72+1,74+39;122:26+12,57+12,74+39;',
        '123:26+12,58+11,73+1,78+35;124:26+12,58+11,71+2,74+2,78+35;125:26+12,58+11,78+35;',
        '126:27+11,59+10,70+1,80+33;127:26+12,59+10,84+29;128:26+12,60+10,84+29;',
        '129:26+12,60+9,84+29;130:23+15,60+9,84+29;131:22+16,60+9,86+27;',
        '132:21+1,23+15,60+9,86+27;133:20+18,60+9,86+27;134:21+17,60+9,88+25;',
        '135:21+17,60+9,88+25;136:19+1,21+17,60+9,88+25;137:18+20,60+9,89+24;',
        '138:14+3,18+20,60+9,89+24;139:13+25,60+9,90+23;140:12+26,60+9,90+23;',
        '141:12+26,60+9,90+23;142:12+26,60+9,90+23;143:12+26,60+9,90+23;',
        '144:13+25,60+9,91+22;145:14+24,60+9,91+22;146:14+24,60+9,91+22;',
        '147:14+24,60+9,91+22;148:14+24,60+9,91+22;149:14+24,60+9,91+22;',
        '150:14+24,60+9,91+22;151:14+24,60+9,91+22;152:14+24,60+9,91+22;',
        '153:14+24,60+9,91+22;154:14+24,60+9,91+22;155:12+26,60+9,91+22;',
        '156:11+27,60+9,91+22;157:12+26,60+9,91+22;158:12+26,60+9,91+22;',
        '159:12+26,60+9,91+22;160:12+26,60+9,91+22;161:11+27,60+9,91+22;',
        '162:10+28,60+9,91+22;163:10+28,60+9,91+22;164:10+28,60+9,91+22;',
        '165:10+28,60+9,91+22;166:10+28,60+9,91+22;167:13+25,60+9,91+22;',
        '168:14+24,60+9,91+22;169:15+23,60+9,91+22;170:14+24,60+9,91+22;',
        '171:15+23,60+9,91+22;172:14+24,60+9,91+22;173:13+35,60+9,91+22;',
        '174:12+36,60+9,91+22;175:11+37,60+9,91+22;176:11+37,60+9,91+22;',
        '177:11+37,60+9,91+22;178:11+37,60+9,91+22;179:11+37,60+9,91+22;',
        '180:11+39,60+9,91+22;181:11+41,60+9,91+22;182:11+43,60+9,91+22;',
        '183:11+45,60+9,91+22;184:11+47,60+9,91+22;185:11+58,91+22;',
        '186:11+58,91+22;187:11+58,91+22;188:11+58,91+22;',
        '189:11+58,91+22;190:12+58,91+22;191:13+59,91+22;',
        '192:14+45,69+5,91+22;193:16+43,69+7,86+27;194:17+41,73+5,84+29;',
        '195:20+25,49+7,73+7,84+29;196:21+23,50+5,77+5,84+29;197:24+17,77+36;',
        '198:25+15,80+33;199:28+9,80+33;200:29+7,84+29;',
        '201:84+29;202:84+29;203:84+29;',
        '204:84+29;205:84+29;206:84+29;',
        '207:84+29;208:84+29;209:86+27;',
        '210:86+27;211:84+29;212:84+29;',
        '213:82+31;214:82+31;215:81+32;',
        '216:81+32;217:81+32;218:81+32;',
        '219:81+32;220:81+32;221:81+32;',
        '222:81+32;223:81+32;224:82+31;',
        '225:84+29;226:85+28;227:88+25;',
        '228:89+23;229:92+18;230:93+15;',
        '231:94+13;',
    ].join(''),
});
// </forge-open-front>

// The Forge's front arch runs (kept as a named export for the bakers/tests).
export const FORGE_ARCH_ROWS = FORGE_OPEN_FRONT_PROFILE?.frontArchRows || '';

export const OPEN_FRONT_PROFILES = Object.freeze({
    tavern: Object.freeze({
        id: 'tavern',
        spriteId: 'building.tavern',
        propId: 'tavern-arcade',
        nativeSize: Object.freeze({ width: 296, height: 288 }),
        anchor: Object.freeze([158, 218]),
        footprint: Object.freeze({ width: 4, height: 4 }),
        postLineInset: DEFAULT_POST_LINE_INSET,
        postLineSlope: TILE_HEIGHT / TILE_WIDTH,
        columnPx: DEFAULT_COLUMN_PX,
        lintelDepthBias: 0,
        rearWallInset: 1.75,
        frontArchRows: TAVERN_ARCH_ROWS,
        interiorFloorBounds: Object.freeze({
            tileRects: Object.freeze([freezeRect({ dx: 0, dy: 2, width: 3, height: 1.75 })]),
            spriteBounds: Object.freeze({ left: 26, right: 172, top: 184, bottom: 268 }),
        }),
        bays: Object.freeze([
            freezeBay({ id: 'tavern-bar-w', tile: { tileX: 21, tileY: 16 }, relTile: { dx: 0, dy: 2 }, pose: 'sit', facing: 'south-west', anchorOffset: [0, 0] }),
            freezeBay({ id: 'tavern-bar-mid', tile: { tileX: 22, tileY: 16 }, relTile: { dx: 1, dy: 2 }, pose: 'sit', facing: 'south-west', anchorOffset: [0, 0] }),
            freezeBay({ id: 'tavern-bar-e', tile: { tileX: 23, tileY: 16 }, relTile: { dx: 2, dy: 2 }, pose: 'sit', facing: 'south-west', anchorOffset: [0, 0] }),
            freezeBay({ id: 'tavern-stand-w', tile: { tileX: 21, tileY: 17 }, relTile: { dx: 0, dy: 3 }, pose: 'drink', facing: 'north-east', anchorOffset: [0, 0] }),
        ]),
    }),
    forge: FORGE_OPEN_FRONT_PROFILE,
});

export function getOpenFrontProfile(buildingId) {
    const key = String(buildingId || '').replace(/^building\./, '').trim();
    return OPEN_FRONT_PROFILES[key] || null;
}

/**
 * Parse `"y:x+len,x+len;"` row runs (or an array of strings / `[y, x, len]`
 * tuples) into normalized, bounds-clamped integer `[y, x, len]` runs.
 */
export function parseArchRows(archRows, width = Infinity, height = Infinity) {
    const runs = [];
    if (!archRows) return runs;
    const pushClamped = (y, x, length) => {
        const iy = Math.trunc(y);
        const ix = Math.trunc(x);
        const ilen = Math.trunc(length);
        if (!Number.isFinite(iy) || !Number.isFinite(ix) || !Number.isFinite(ilen)) return;
        if (iy < 0 || iy >= height || ilen <= 0) return;
        const x0 = Math.max(0, ix);
        const x1 = Math.min(width, ix + ilen);
        if (x1 > x0) runs.push([iy, x0, x1 - x0]);
    };

    if (Array.isArray(archRows)) {
        if (archRows.length && typeof archRows[0] === 'string') {
            return parseArchRows(archRows.join(''), width, height);
        }
        for (const tuple of archRows) {
            if (!Array.isArray(tuple) || tuple.length < 3) continue;
            pushClamped(Number(tuple[0]), Number(tuple[1]), Number(tuple[2]));
        }
        return runs;
    }

    for (const row of String(archRows).split(';')) {
        if (!row) continue;
        const colon = row.indexOf(':');
        if (colon < 0) continue;
        const y = Number(row.slice(0, colon));
        const spans = row.slice(colon + 1);
        for (const span of spans.split(',')) {
            if (!span) continue;
            const plus = span.indexOf('+');
            if (plus < 0) continue;
            const x = Number(span.slice(0, plus));
            const length = Number(span.slice(plus + 1));
            pushClamped(y, x, length);
        }
    }
    return runs;
}

/**
 * Pure mask-splitting helper separating a sprite (`width × height`) along
 * `archRows` into disjoint `rearInterior` (drawn behind agents inside the bay)
 * and `frontArch` (drawn in front of agents inside the bay).
 *
 * When `sourceRgba` (`width * height * 4` bytes) is supplied, also splits the
 * raw RGBA buffer with exact zero-loss byte preservation: every pixel belongs
 * exclusively to either `frontArchRgba` or `rearInteriorRgba`, never both.
 */
export function splitOpenFrontMask(width, height, archRows, sourceRgba = null) {
    const w = Math.trunc(Number(width));
    const h = Math.trunc(Number(height));
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
        throw new RangeError(`splitOpenFrontMask requires positive integer dimensions, got ${width}x${height}`);
    }
    const pixelCount = w * h;
    if (sourceRgba && sourceRgba.length !== pixelCount * 4) {
        throw new RangeError(`sourceRgba length ${sourceRgba.length} does not match ${w}x${h}x4 (${pixelCount * 4})`);
    }

    const runs = parseArchRows(archRows, w, h);
    const frontArchMask = new Uint8Array(pixelCount);
    const rearInteriorMask = new Uint8Array(pixelCount);
    rearInteriorMask.fill(1);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let frontArchCount = 0;

    for (const [y, x, length] of runs) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x + length - 1 > maxX) maxX = x + length - 1;
        const rowOffset = y * w;
        for (let col = x; col < x + length; col++) {
            const idx = rowOffset + col;
            if (frontArchMask[idx] === 0) {
                frontArchMask[idx] = 1;
                rearInteriorMask[idx] = 0;
                frontArchCount++;
            }
        }
    }

    let frontArchRgba = null;
    let rearInteriorRgba = null;
    if (sourceRgba) {
        frontArchRgba = new Uint8ClampedArray(pixelCount * 4);
        rearInteriorRgba = new Uint8ClampedArray(pixelCount * 4);
        for (let p = 0; p < pixelCount; p++) {
            const o = p * 4;
            const target = frontArchMask[p] === 1 ? frontArchRgba : rearInteriorRgba;
            target[o] = sourceRgba[o];
            target[o + 1] = sourceRgba[o + 1];
            target[o + 2] = sourceRgba[o + 2];
            target[o + 3] = sourceRgba[o + 3];
        }
    }

    const frontArchBounds = frontArchCount > 0
        ? { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
        : null;

    return {
        width: w,
        height: h,
        runs,
        frontArchMask,
        rearInteriorMask,
        frontArchRgba,
        rearInteriorRgba,
        frontArch: frontArchRgba || frontArchMask,
        rearInterior: rearInteriorRgba || rearInteriorMask,
        frontArchCount,
        rearInteriorCount: pixelCount - frontArchCount,
        frontArchBounds,
    };
}

function resolveBuildingWorldCenter(profile, buildingAnchor) {
    if (buildingAnchor && typeof buildingAnchor === 'object') {
        if (buildingAnchor.position || Number.isFinite(buildingAnchor.tileX)) {
            return buildingCenterToWorld(buildingAnchor);
        }
        if (Array.isArray(buildingAnchor) && buildingAnchor.length >= 2) {
            return { x: Number(buildingAnchor[0]), y: Number(buildingAnchor[1]) };
        }
        if (Number.isFinite(buildingAnchor.x) && Number.isFinite(buildingAnchor.y)) {
            return { x: Number(buildingAnchor.x), y: Number(buildingAnchor.y) };
        }
    }
    const def = BUILDING_DEFS.find((candidate) => candidate.type === profile.id);
    if (!def) return { x: 0, y: 0 };
    return buildingCenterToWorld({
        position: { tileX: def.x, tileY: def.y },
        width: def.width,
        height: def.height,
    });
}

function resolveWorldPoint(worldPos) {
    if (!worldPos) return null;
    if (Array.isArray(worldPos) && worldPos.length >= 2) {
        return { x: Number(worldPos[0]), y: Number(worldPos[1]) };
    }
    if (Number.isFinite(worldPos.x) && Number.isFinite(worldPos.y)) {
        return { x: Number(worldPos.x), y: Number(worldPos.y) };
    }
    if (Number.isFinite(worldPos.tileX) && Number.isFinite(worldPos.tileY)) {
        return tileToWorld(worldPos.tileX, worldPos.tileY);
    }
    return null;
}

function worldToBuildingRelTile(profile, worldPoint, buildingAnchor) {
    const center = resolveBuildingWorldCenter(profile, buildingAnchor);
    const delta = worldToTile(worldPoint.x - center.x, worldPoint.y - center.y);
    return {
        dx: delta.tileX + profile.footprint.width / 2,
        dy: delta.tileY + profile.footprint.height / 2,
        center,
    };
}

/**
 * Returns true iff `worldPos` lies inside the open-front bay floor of
 * `buildingId` anchored at `buildingAnchor` (world center `{ x, y }`, a
 * `Building` instance, or omitted to use the canonical `BUILDING_DEFS` center).
 */
export function isPointInsideOpenBay(buildingId, worldPos, buildingAnchor = null) {
    const profile = getOpenFrontProfile(buildingId);
    const point = resolveWorldPoint(worldPos);
    if (!profile || !point) return false;
    const { dx, dy } = worldToBuildingRelTile(profile, point, buildingAnchor);
    const eps = 1e-6;
    return profile.interiorFloorBounds.tileRects.some((rect) => (
        dx >= rect.dx - eps &&
        dx < rect.dx + rect.width - eps &&
        dy >= rect.dy - eps &&
        dy < rect.dy + rect.height - eps
    ));
}

/**
 * World-Y sort depth of the building's front arch lintel/pier post line at
 * screen-aligned `worldX`. Agents with `worldY < frontArchSortY` render BEHIND
 * the front arch; agents with `worldY > frontArchSortY` render IN FRONT of it.
 */
export function openFrontArchSortY(buildingId, worldX, buildingAnchor = null) {
    const profile = getOpenFrontProfile(buildingId);
    if (!profile) return NaN;
    const center = resolveBuildingWorldCenter(profile, buildingAnchor);
    const originDelta = tileToWorld(
        profile.footprint.width / 2,
        profile.footprint.height / 2 - profile.postLineInset,
    );
    const originX = center.x + originDelta.x;
    const originY = center.y + originDelta.y;
    return originY + profile.postLineSlope * (worldX - originX) + (profile.lintelDepthBias || 0);
}

/**
 * World-Y sort depth of the rear interior wall/anvil/hearth behind the open
 * bay at `worldX`. Agents standing inside the bay render IN FRONT of this line.
 */
export function openFrontRearSortY(buildingId, worldX, buildingAnchor = null) {
    const profile = getOpenFrontProfile(buildingId);
    if (!profile) return NaN;
    const center = resolveBuildingWorldCenter(profile, buildingAnchor);
    const rearDelta = tileToWorld(
        profile.footprint.width / 2,
        profile.rearWallInset - profile.footprint.height / 2,
    );
    const originX = center.x + rearDelta.x;
    const originY = center.y + rearDelta.y;
    return originY + profile.postLineSlope * (worldX - originX);
}

/**
 * Resolve deterministic back-to-front draw order between the building's
 * `rearInterior`, an `agent` at `agentWorldPos`, and the `frontArch` lintel.
 *
 * Inside the bay: `['rearInterior', 'agent', 'frontArch']` with
 * `rearInteriorSortY < agentSortY < frontArchSortY`.
 */
export function resolveOpenFrontDrawOrder(buildingId, agentWorldPos, buildingAnchor = null) {
    const profile = getOpenFrontProfile(buildingId);
    const point = resolveWorldPoint(agentWorldPos);
    if (!profile || !point) return null;

    const insideBay = isPointInsideOpenBay(profile.id, point, buildingAnchor);
    const rearInteriorSortY = openFrontRearSortY(profile.id, point.x, buildingAnchor);
    const frontArchSortY = openFrontArchSortY(profile.id, point.x, buildingAnchor);
    const agentSortY = point.y;

    const entries = [
        { role: 'rearInterior', sortY: rearInteriorSortY, tie: 0 },
        { role: 'agent', sortY: agentSortY, tie: 1 },
        { role: 'frontArch', sortY: frontArchSortY, tie: 2 },
    ];
    entries.sort((a, b) => (a.sortY - b.sortY) || (a.tie - b.tie));

    return {
        buildingId: profile.id,
        insideBay,
        rearInteriorSortY,
        agentSortY,
        frontArchSortY,
        order: entries.map((entry) => entry.role),
    };
}

function maskedCanvas(image, runs) {
    if (!image || typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    SpriteRenderer.disableSmoothing(ctx);
    for (const [y, x, length] of runs) {
        ctx.drawImage(image, x, y, length, 1, x, y, length, 1);
    }
    return canvas;
}

/**
 * Build column-sliced `StaticPropSprite` drawables for any open-front building
 * profile, generalizing `TavernArcade.buildTavernArcadeSprites`.
 */
export function buildOpenFrontSprites({ buildingId, building, assets, profile = null } = {}) {
    const resolvedProfile = profile || getOpenFrontProfile(buildingId || building?.type);
    if (!resolvedProfile || !building || !assets?.get?.(resolvedProfile.spriteId)) return [];

    const runs = parseArchRows(
        resolvedProfile.frontArchRows,
        resolvedProfile.nativeSize.width,
        resolvedProfile.nativeSize.height,
    );
    if (!runs.length) return [];

    const [anchorX, anchorY] = assets.getAnchor?.(resolvedProfile.spriteId) || resolvedProfile.anchor;
    const width = building.width ?? resolvedProfile.footprint.width;
    const height = building.height ?? resolvedProfile.footprint.height;
    const tileX = (building.position?.tileX ?? building.x ?? 0) + width;
    const tileY = (building.position?.tileY ?? building.y ?? 0) + height - resolvedProfile.postLineInset;
    const origin = tileToWorld(tileX, tileY);
    const centre = buildingCenterToWorld(building);
    const left = Math.round(centre.x - anchorX - origin.x);
    const top = Math.round(centre.y - anchorY - origin.y);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [y, x, length] of runs) {
        if (x < minX) minX = x;
        if (x + length > maxX) maxX = x + length;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const bounds = {
        left: left + minX,
        right: left + maxX,
        top: top + minY,
        bottom: top + maxY + 1,
        splitY: 0,
    };

    const layers = {};
    const paint = (channel) => (ctx, x, y) => {
        if (!layers[channel]) {
            const image = channel === 'albedo'
                ? assets.get(resolvedProfile.spriteId)
                : assets.getCompanion?.(resolvedProfile.spriteId, channel);
            layers[channel] = maskedCanvas(image, runs);
        }
        if (layers[channel]) {
            ctx.drawImage(layers[channel], Math.round(x) + left, Math.round(y) + top);
        }
    };

    const columnPx = resolvedProfile.columnPx || DEFAULT_COLUMN_PX;
    // Each slice also carries its base.png crop (`sx`, `sw`, sprite px), the
    // source rect a surface-aware consumer (GpuSceneBuilder) samples.
    const columns = lineOcclusionColumns({
        left: bounds.left,
        right: bounds.right,
        width: columnPx,
        originY: origin.y + (resolvedProfile.lintelDepthBias || 0),
        slope: resolvedProfile.postLineSlope,
    }).map((column) => {
        const sx = minX + column.index * columnPx;
        return { ...column, sx, sw: Math.max(0, Math.min(columnPx, maxX - sx)) };
    });

    return [new StaticPropSprite({
        tileX,
        tileY,
        id: resolvedProfile.propId,
        bounds,
        occlusionColumns: columns,
        materialClass: assets.getEntry?.(resolvedProfile.spriteId)?.materialClass || null,
        drawFn: paint('albedo'),
        channels: { occluder: paint('occluder') },
    })];
}
