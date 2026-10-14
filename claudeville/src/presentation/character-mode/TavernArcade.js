// The Tavern's open front: its posts, arches and beam drawn a second time,
// over the patrons on its floor. The landmark draws as one sprite split once
// across (a back and a front half), and its open floor lies inside that
// sprite: a patron seated at the bar must paint over the floor and the bar
// behind it, yet under the front beam and posts. So the arcade's own texels
// (ARCADE_ROWS, base.png px, authored from the art: the beam, posts and arch
// spandrels between the beam's top and the floor's front edge, never the
// floor seen through an arch) are cut from the building's own albedo and
// surface channel and painted as a column-sliced prop along the post line
// (lineOcclusionColumns): a body behind the line at a column paints first,
// one in front of it after. Nothing behind the arcade, the art is unchanged.

import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { buildingCenterToWorld, tileToWorld } from './Projection.js';
import { lineOcclusionColumns, StaticPropSprite } from './StaticPropDrawables.js';
import { SpriteRenderer } from './SpriteRenderer.js';

const SPRITE_ID = 'building.tavern';
// The post line, a quarter tile inside the footprint's front edge.
const POST_LINE_INSET = 0.25;
const COLUMN_PX = 8;

// "y:x+len,x+len;" runs of arcade texels per base.png row.
const ARCADE_ROWS = [
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

function arcadeRuns() {
    const runs = [];
    for (const row of ARCADE_ROWS.split(';')) {
        if (!row) continue;
        const [y, spans] = row.split(':');
        for (const span of spans.split(',')) {
            const [x, length] = span.split('+').map(Number);
            runs.push([Number(y), x, length]);
        }
    }
    return runs;
}

// The arcade's texels of `image` (base.png or one of its sidecars) on a
// canvas of the image's size, or null before the image loads.
function maskedCanvas(image, runs) {
    if (!image || typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    SpriteRenderer.disableSmoothing(ctx);
    for (const [y, x, length] of runs) ctx.drawImage(image, x, y, length, 1, x, y, length, 1);
    return canvas;
}

export function buildTavernArcadeSprites({ building, assets }) {
    if (!building || !assets?.get?.(SPRITE_ID)) return [];
    const runs = arcadeRuns();
    const [anchorX, anchorY] = assets.getAnchor(SPRITE_ID);
    const front = { tileX: building.position.tileX + building.width, tileY: building.position.tileY + building.height - POST_LINE_INSET };
    const origin = tileToWorld(front.tileX, front.tileY);
    const centre = buildingCenterToWorld(building);
    // base.png's top-left, relative to the prop origin.
    const left = Math.round(centre.x - anchorX - origin.x);
    const top = Math.round(centre.y - anchorY - origin.y);
    const xs = runs.flatMap(([, x, length]) => [x, x + length]);
    const ys = runs.map(([y]) => y);
    const bounds = {
        left: left + Math.min(...xs),
        right: left + Math.max(...xs),
        top: top + Math.min(...ys),
        bottom: top + Math.max(...ys) + 1,
        splitY: 0,
    };
    const layers = {};
    const paint = (channel) => (ctx, x, y) => {
        if (!layers[channel]) {
            const image = channel === 'albedo' ? assets.get(SPRITE_ID) : assets.getCompanion?.(SPRITE_ID, channel);
            layers[channel] = maskedCanvas(image, runs);
        }
        if (layers[channel]) ctx.drawImage(layers[channel], Math.round(x) + left, Math.round(y) + top);
    };
    return [new StaticPropSprite({
        tileX: front.tileX,
        tileY: front.tileY,
        id: 'tavern-arcade',
        bounds,
        // The post line runs along +tileX: TILE_HEIGHT / TILE_WIDTH world Y per
        // screen px, like the village gatehouse's wall line.
        occlusionColumns: lineOcclusionColumns({
            left: bounds.left,
            right: bounds.right,
            width: COLUMN_PX,
            originY: origin.y,
            slope: TILE_HEIGHT / TILE_WIDTH,
        }),
        materialClass: assets.getEntry?.(SPRITE_ID)?.materialClass || null,
        drawFn: paint('albedo'),
        channels: { occluder: paint('occluder') },
    })];
}
