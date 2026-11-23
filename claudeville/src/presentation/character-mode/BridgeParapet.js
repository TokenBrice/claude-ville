// The central bridge's camera-side parapet: its handrail, balusters/posts,
// post flames, lower timber fascia, stone arch voussoirs and SW/NE mossy
// abutments drawn a second time over villagers walking across the deck.
// Like TavernArcade, its own texels (PARAPET_ROWS, bridge.landmark.civic.ns.png
// px — never the open deck planks visible between the top rail and the lower
// fascia) are cut from the bridge's albedo (or winter snow copy) and emissive
// sidecar and painted as a column-sliced prop along the near parapet line
// (lineOcclusionColumns), so boots tuck cleanly behind the stone and posts
// while shins remain visible through the open rail bays.

import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { tileToWorld } from './Projection.js';
import { lineOcclusionColumns, StaticPropSprite } from './StaticPropDrawables.js';
import { SpriteRenderer } from './SpriteRenderer.js';

const SPRITE_ID = 'bridge.landmark.civic.ns';
const DEFAULT_ANCHOR = Object.freeze([132, 124]);
const PARAPET_OFFSET_X = 0.85;
const PARAPET_CLAMP_START_Y = 22.2;
const PARAPET_CLAMP_END_Y = 25.9;
const COLUMN_PX = 8;

// "y:x+len,x+len;" runs of camera-side parapet texels per bridge.landmark.civic.ns.png row.
const PARAPET_ROWS = [
    '42:210+1;43:209+3;44:209+3;45:210+2;46:210+3;47:209+4;48:209+5;49:209+5;50:208+6;51:207+8;',
    '52:206+9;53:206+9;54:206+9;55:207+8;56:206+10;57:205+12;58:205+12;59:205+13;60:205+14;61:205+14;',
    '62:205+14;63:205+14;64:204+15;65:202+17;66:200+19;67:198+21;68:196+23;69:194+25;70:192+27;',
    '71:179+6,190+29;72:179+6,188+31;73:178+41;74:178+41;75:177+42;76:175+44;77:173+46;78:171+49;',
    '79:169+52;80:167+56;81:165+60;82:163+65;83:161+16,178+51;84:151+5,159+16,178+51;',
    '85:151+5,157+16,178+52;86:150+21,178+52;87:150+19,178+53;88:150+17,178+54;89:149+16,178+55;',
    '90:147+16,178+56;91:146+15,178+57;92:144+15,178+57;93:143+14,178+57;94:141+16,178+57;',
    '95:140+17,177+59;96:139+18,175+61;97:137+20,173+64;98:136+13,150+7,171+66;99:134+13,150+7,169+69;',
    '100:133+13,150+7,167+71;101:131+13,150+7,165+73;102:130+13,150+7,163+75;103:128+13,150+7,161+77;',
    '104:127+13,150+7,159+79;105:121+5,127+12,150+88;106:120+17,150+90;107:120+16,150+92;',
    '108:120+14,149+94;109:119+14,147+97;110:118+13,146+98;111:95+1,116+14,145+100;',
    '112:94+2,115+13,143+102;113:94+3,114+13,142+103;114:93+5,112+15,141+104;115:91+7,111+16,139+106;',
    '116:91+8,110+17,138+107;117:91+7,108+19,136+108;118:91+7,107+12,120+7,135+109;',
    '119:92+7,106+12,120+7,134+109;120:88+13,104+12,120+7,132+110;121:88+13,103+12,120+7,131+110;',
    '122:87+15,103+11,120+7,130+109;123:86+26,120+7,128+109;124:86+25,120+115;125:86+24,120+113;',
    '126:86+22,119+112;127:86+21,118+112;128:86+20,116+112;129:86+18,115+111;130:86+17,114+110;',
    '131:86+17,113+109;132:86+17,112+108;133:86+17,110+17,128+90;134:86+17,109+76,187+29;',
    '135:86+17,108+74,188+27;136:86+17,107+74,190+22;137:86+17,105+73,192+18;138:86+17,104+72,194+13;',
    '139:86+89;140:86+86;141:86+84;142:86+82;143:86+80;144:86+78;145:86+76;146:86+74;147:86+72;',
    '148:86+70;149:86+68;150:86+66;151:85+65;152:84+64;153:83+63;154:82+62;155:82+60;156:81+59;',
    '157:80+58;158:79+57;159:78+56;160:77+55;161:76+55;162:76+55;163:75+58;164:75+60;165:73+64;',
    '166:72+66;167:71+68;168:70+69;169:70+70;170:69+71;171:68+72;172:67+73;173:66+74;174:66+73;',
    '175:66+73;176:66+72;177:66+70;178:66+69;179:66+67;180:66+65;181:66+63;182:66+62;183:66+60;',
    '184:66+58;185:66+56;186:66+54;187:66+52;188:66+51;189:66+49;190:67+46;191:69+42;192:70+39;',
    '193:72+35;194:74+31;195:76+27;196:79+21;197:81+17;',
].join('');

let _cachedRuns = null;

export function centralBridgeParapetRuns() {
    if (_cachedRuns) return _cachedRuns;
    const runs = [];
    for (const row of PARAPET_ROWS.split(';')) {
        if (!row) continue;
        const [y, spans] = row.split(':');
        for (const span of spans.split(',')) {
            const [x, length] = span.split('+').map(Number);
            runs.push([Number(y), x, length]);
        }
    }
    _cachedRuns = runs;
    return runs;
}

function maskedCanvas(image, runs) {
    if (!image || typeof document === 'undefined') return null;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!(width > 0) || !(height > 0)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    SpriteRenderer.disableSmoothing(ctx);
    for (const [y, x, length] of runs) {
        if (y >= height || x >= width) continue;
        const clipped = Math.min(length, width - x);
        if (clipped > 0) ctx.drawImage(image, x, y, clipped, 1, x, y, clipped, 1);
    }
    return canvas;
}

export function buildCentralBridgeParapetSprite({
    span,
    assets,
    propWinter = null,
    bridgeWalk = null,
    bridgeLightsLit = null,
} = {}) {
    if (!span) return null;
    const runs = centralBridgeParapetRuns();
    const anchor = assets?.getAnchor?.(SPRITE_ID) || DEFAULT_ANCHOR;
    const [anchorX, anchorY] = anchor;
    const centerTileX = span.centerTile?.x ?? 18;
    const centerTileY = span.centerTile?.y ?? 24;
    const originTileX = centerTileX + PARAPET_OFFSET_X;
    const originTileY = centerTileY;
    const origin = tileToWorld(originTileX, originTileY);
    const midX = (span.start.x + span.end.x) / 2;
    const midY = (span.start.y + span.end.y) / 2;
    // bridge.landmark.civic.ns.png's top-left, relative to the prop origin.
    const left = Math.round(midX - anchorX - origin.x);
    const top = Math.round(midY - anchorY - origin.y);
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
    const slope = -TILE_HEIGHT / TILE_WIDTH;
    const clampNorth = tileToWorld(originTileX, PARAPET_CLAMP_START_Y);
    const clampSouth = tileToWorld(originTileX, PARAPET_CLAMP_END_Y);
    const minLocalX = Math.min(clampNorth.x, clampSouth.x) - origin.x;
    const maxLocalX = Math.max(clampNorth.x, clampSouth.x) - origin.x;
    const occlusionColumns = lineOcclusionColumns({
        left: bounds.left,
        right: bounds.right,
        width: COLUMN_PX,
        originY: origin.y,
        slope,
    });
    for (const column of occlusionColumns) {
        const start = Number.isFinite(column.left) ? column.left : bounds.left;
        const end = Number.isFinite(column.right) ? column.right : bounds.right;
        const centerLocalX = Math.max(minLocalX, Math.min(maxLocalX, (start + end) / 2));
        column.sortY = origin.y + slope * centerLocalX;
    }
    const layers = {};
    const paint = (channel) => (ctx, x, y) => {
        const image = channel === 'albedo'
            ? (propWinter?.image?.(SPRITE_ID) || assets?.get?.(SPRITE_ID))
            : (assets?.getCompanion?.(SPRITE_ID, channel) || assets?.getSidecar?.(SPRITE_ID, channel));
        if (!image) return;
        const cached = layers[channel];
        if (!cached || cached.source !== image) {
            layers[channel] = { source: image, canvas: maskedCanvas(image, runs) };
        }
        if (layers[channel]?.canvas) {
            ctx.drawImage(layers[channel].canvas, Math.round(x) + left, Math.round(y) + top);
        }
    };
    const sprite = new StaticPropSprite({
        tileX: originTileX,
        tileY: originTileY,
        id: 'bridge.rail.' + span.id,
        bounds,
        occlusionColumns,
        materialClass: assets?.getEntry?.(SPRITE_ID)?.materialClass || 'stone',
        drawFn: paint('albedo'),
        channels: {
            emissive: paint('emissive'),
        },
    });
    sprite.bridgeWalk = bridgeWalk;
    sprite.parapetOrigin = { x: Math.round(origin.x) + left, y: Math.round(origin.y) + top };
    sprite.parapetRuns = runs;
    if (typeof bridgeLightsLit === 'function') {
        sprite.emitterGate = () => (bridgeLightsLit(span) ? 1 : 0);
    }
    return sprite;
}
