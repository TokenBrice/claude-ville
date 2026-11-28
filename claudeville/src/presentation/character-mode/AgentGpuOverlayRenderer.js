import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { agentFrameKeyFromCell } from './AssetManager.js';
import { gpuMaterialNameForProvider } from './gpu/GpuSceneBuilder.js';
import { materialClassId } from './gpu/GpuWorldPolicy.js';
import { isAttentionStatus } from './AttentionPlates.js';
import { DEFAULT_CELL, WALK_FRAMES } from './SpriteSheet.js';
import { postcardFrame } from './Postcard.js';

// 4.7 — a walking body's strip descriptor (six probe records, one per walk
// frame of its facing) is rebuilt only when what it samples changes. A strip
// whose channel crops were still pending is re-probed at this cadence.
const WALK_STRIP_RETRY_MS = 250;
let walkStripRevision = 0;

// Owns the GPU-world base-sprite record and the ungraded Canvas annotation
// pass. The host remains authoritative for animation, identity, and all shared
// annotation primitives, matching the coarse host-backed renderer split used
// by WildlifeRenderer and FoliageRenderer.
// A departed villager walks out through the village gate at once; the grey
// resting tableau ("DEPARTED" plaque, dim body, frozen frame) only applies
// when the renderer has not started that exit. Plain function rather than a
// method so plain-object hosts in tests and overlays resolve it the same way.
export function departedTableau(host) {
    return Boolean(host?.agent?.isDeparted) && !host?.leaving;
}

const EMPTY_RECORDS = Object.freeze([]);

export class AgentGpuOverlayRenderer {
    constructor(host) {
        this.host = host;
        this._liveRecords = null;
        this._liveFrameRecord = null;
        this._liveWalkStripRef = null;
    }

    setEnabled(enabled) {
        const next = Boolean(enabled);
        this.host.gpuWorldEnabled = next;
        if (!next) this.host._gpuFrameRecord = null;
    }

    releaseRenderResources() {
        this._liveRecords = null;
        this._liveFrameRecord = null;
        this._liveWalkStripRef = null;
        this._walkStrip = null;
        this._groundRecords = null;
    }

    getRecords() {
        const record = this.host._gpuFrameRecord;
        if (!record) return EMPTY_RECORDS;
        const list = this._liveRecords || (this._liveRecords = [record]);
        list[0] = record;
        return list;
    }

    draw(ctx, zoom = 1, annotationMode = 'full') {
        const host = this.host;
        if (!host.gpuWorldEnabled || !ctx) return;
        host._zoom = zoom;
        // W-F16 — a body the depth pass hid behind a building keeps its marks
        // and name hidden with it; the selected one is x-rayed, so keeps both.
        // Its thought is not hidden: the thought layer lifts it above the
        // building's crown (AgentSprite.drawThought, W3.4).
        if ((host._occludedByWorld || host._behindBuilding) && !host.selected) return;
        // Action-needed agents are marked by the overlay's T1 beacon and
        // attention plate (AttentionPlates.js) at every zoom, not here.
        const primary = host.selected || isAttentionStatus(host.agent?.status);
        const overview = !host.selected && zoom < 1;

        const record = host._gpuFrameRecord;
        if (!record) return;
        const contentTopY = Number.isFinite(record.contentTopY)
            ? record.contentTopY
            : host._headTopY();

        // Plan 2.5 — the selected agent is framed, never veiled: its pixel ring
        // rides the ground records (getGroundRecords) and the chevron floats
        // over the head here, ungraded, so it holds at night. Hover is a
        // ground ring only.
        if (host.selected) host._drawSelectionChevron(ctx, contentTopY);

        // Modular action props stay in the ungraded overlay. They add to the
        // complete GPU body frame and can never punch holes in its alpha. The
        // 2.4 signature rides the same geometry, so the resident renderer shows
        // the identical mark on hero and 28 px compact bodies. The nine
        // building rituals were reachable only on the Canvas backend before
        // 2.2; the resident renderer now draws the same gesture.
        //
        // This block is the sole owner of these marks on the resident backend:
        // AgentSprite's Canvas body pass stands down while gpuWorldEnabled, so
        // the order here is the Canvas order and each mark is struck once.
        if (record.frameGeometry && !departedTableau(host)) {
            // Plan 2.7 — a half-scale crowd body keeps its identity plate and
            // evidence seals but sheds the 1:1-sized procedural gestures,
            // which would be twice its proportion and read as noise. The
            // W3-D body marks (patina, rain shoulders, breath) are 1:1 body
            // pixels too: Canvas never draws them on an LOD body, nor here.
            const fullBody = !record.frameGeometry.lod;
            if (fullBody) host._drawPatinaAndWeatherBody?.(ctx, record.frameGeometry);
            host._drawSignatureMark(ctx, record.frameGeometry);
            host._drawReceiveBeat(ctx, record.frameGeometry);
            if (fullBody) host._drawStanceOverlay(ctx, record.frameGeometry);
            host._drawActionPoseOverlay(ctx, record.frameGeometry);
            if (fullBody) host._drawToolRitualOverlay(ctx, record.frameGeometry);
        }

        // Static-band cue: departed agents never pulse or allocate animation
        // state, so reduced motion receives the complete visual treatment.
        if (departedTableau(host)) this.drawDepartedTreatment(ctx);

        // Thoughts are not drawn here: the thought layer (WorldFrameRenderer,
        // AgentSprite.drawThought) paints every leader, then every column,
        // above all per-agent marks on both backends.
        if (!departedTableau(host)) {
            // Head-anchored labels clear the chevron: nothing crosses the body.
            const labelTopY = host._labelTopY(contentTopY);
            const toolGlyphDrawn = !overview && Boolean(host._drawToolGlyphBadge?.(ctx, labelTopY));
            if (primary || host.selected || annotationMode === 'full' || host.gpuActionOverlay) {
                if (host.chatting) host._drawChatEffect(ctx, labelTopY);
                if (!overview && !toolGlyphDrawn) host._drawStatusEmote(ctx, labelTopY);
                if (!toolGlyphDrawn) host._drawPlanModeGlyph(ctx, labelTopY);
                host._drawRetryGlyph(ctx, labelTopY);
            }
        }

        // C5 identity: _drawNameTag gates the T2 plate / T4 name itself.
        host._drawNameTag(ctx);
    }

    // Lingering-departure cue. This deliberately claims the `static` motion
    // band: no pulse, timer, path, or particle is allocated, and reduced motion
    // sees the identical resting plaque. The muted body is applied at its blit
    // site; this label keeps the state explicit at every annotation LOD.
    drawDepartedTreatment(ctx) {
        // XP-5 — a postcard frame carries no plaque; the muted body stays.
        if (postcardFrame()) return;
        const centerX = Math.round(this.host.x);
        const y = Math.round(this.host.y + 10);
        const width = 74;
        const height = 14;
        const scale = 1 / (this.host._zoom || 1);
        ctx.save();
        ctx.translate(centerX, y);
        ctx.scale(scale, scale);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(18, 20, 24, 0.94)';
        ctx.strokeStyle = 'rgba(184, 191, 199, 0.92)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-width / 2, 0, width, height, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#d8dde3';
        ctx.font = WORLD_DISPLAY_FONT_8;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('DEPARTED', 0, 11);
        ctx.restore();
    }

    // Plan 2.3 — the host's ground mark set (contact shadow, action-needed
    // ring, selection/hover ring) as resident ground records: the same cached
    // pixel stamps the Canvas fallback blits, painted before the body in the
    // depth pass so bodies and buildings occlude them. Record objects are
    // reused per mark slot; only the positions move each frame.
    getGroundRecords(sequence = 0) {
        const host = this.host;
        const marks = host._groundMarks;
        if (!host.gpuWorldEnabled || !host._gpuFrameRecord || !marks?.length) return [];
        const records = this._groundRecords || (this._groundRecords = []);
        records.length = marks.length;
        const id = host.agent?.id || sequence;
        for (let index = 0; index < marks.length; index++) {
            const mark = marks[index];
            const stamp = mark.stamp;
            const record = records[index] || (records[index] = {
                material: materialClassId('default'),
                elevation: 0,
                occluder: 0,
                emissive: 0,
                alpha: 1,
                sx: 0,
                sy: 0,
            });
            record.id = `ground:${id}:${mark.kind}`;
            record.stableKey = record.id;
            record.textureKey = `agent-ground:${stamp.__cvGroundKey || `${mark.kind}:${stamp.width}x${stamp.height}`}`;
            record.source = stamp;
            record.sourceWidth = stamp.width;
            record.sourceHeight = stamp.height;
            record.sw = stamp.width;
            record.sh = stamp.height;
            record.width = stamp.width;
            record.height = stamp.height;
            record.x = mark.x;
            record.y = mark.y;
            record.sequence = sequence + index * 0.001;
            // SD-2 — a sun trail the shade field clips (V9 flag `sunSelf`).
            record.sunSelf = mark.sunCast === true;
        }
        return records;
    }

    setFrameRecord({
        cell,
        dx,
        dy,
        drawScale,
        profileKey,
        spriteId,
        alpha = 1,
        contentTopY = null,
        frameGeometry = null,
        pose = null,
        lod = false,
        stripProbe = false,
        layer = null,
    }) {
        const host = this.host;
        if (!host.gpuWorldEnabled || !host.spriteCanvas || !cell) {
            host._gpuFrameRecord = null;
            return;
        }
        const status = host.agent?.status;
        const original = pose?.cell || cell;
        const bodyCell = layer?.cell || original;
        const base = pose?.source || host._gpuBaseSpriteCanvas || host.spriteCanvas;
        const lodSheet = lod && !pose && !layer ? host.compositor?.halfScaleSheet?.(base, host.spriteSheet?.cellSize || DEFAULT_CELL) : null;
        const source = layer?.sheet.source || lodSheet || base;
        const sourceScale = lodSheet ? 0.5 : 1;
        const resolved = !layer && !pose && !lodSheet && host.assets?.resolveMaterialChannels?.(spriteId, agentFrameKeyFromCell(cell), {
            kind: 'agent', status, selected: host.selected, onScreen: true,
        });
        const resolvedReady = resolved?.ready && resolved.origin !== 'fallback';
        const channel = name => {
            if (pose) return pose.strip?.channels?.[name];
            if (lodSheet) return null;
            return (resolvedReady && resolved[name])
                || host.assets?.getSidecar?.(spriteId, name) || host.assets?.getMaterialSidecar?.(spriteId, name);
        };
        const materialSource = layer ? layer.sheet.geometry : host._packedGeometrySource?.(channel('material'), channel('occluder')) || null;
        const emissiveSource = host._authoredEmissionSource?.(layer ? layer.sheet.emission : channel('emissive')) || null;
        const rec = stripProbe ? {} : (this._liveFrameRecord || (this._liveFrameRecord = {}));
        rec.id = `agent:${host.agent?.id || profileKey}`;
        rec.stableKey = host.agent?.id || profileKey;
        rec.textureKey = layer ? 'agent-model:' + layer.sheet.key :
            pose ? `agent-strip:${profileKey}:${pose.group}` : `agent-sheet${lodSheet ? '-lod' : ''}:${profileKey}`;
        rec.sidecarKey = layer?.sheet.key || (materialSource || emissiveSource ? `${spriteId}:${pose ? 'strip' : 'channels'}` : '');
        rec.source = source;
        rec.materialSource = materialSource;
        rec.emissiveSource = emissiveSource;
        rec.packedGeometry = Boolean(materialSource);
        rec.channelRect = null;
        rec.channelRevision = resolved?.revision || host.assets?.assetVersion || null;
        rec.sourceWidth = source.width;
        rec.sourceHeight = source.height;
        rec.sx = bodyCell.sx * sourceScale;
        rec.sy = bodyCell.sy * sourceScale;
        rec.sw = bodyCell.sw * sourceScale;
        rec.sh = bodyCell.sh * sourceScale;
        rec.x = dx;
        rec.y = dy;
        rec.width = original.sw * drawScale;
        rec.height = original.sh * drawScale;
        rec.alpha = departedTableau(host) ? alpha * 0.58 : alpha;
        rec.material = gpuMaterialNameForProvider(host.agent?.provider);
        rec.elevation = 0.52;
        rec.occluder = 0.58;
        rec.emissive = departedTableau(host)
            ? 0
            : status === AgentStatus.WAITING_ON_USER
                ? 0.42
                : status === AgentStatus.COMPLETED
                    ? 0.20
                    : status === AgentStatus.WORKING
                        ? 0.08
                        : 0;
        rec.textureRevision = layer?.sheet.key || (pose ? `strip:${profileKey}:${pose.group}` : `${lodSheet ? 'lod:' : ''}${profileKey}`);
        rec.sidecarRevision = layer?.sheet.key || resolved?.revision || host.assets?.assetVersion || null;
        rec.contentTopY = contentTopY;
        rec.poseKey = `${pose ? `${pose.group}:${bodyCell.sy}` : host.animState}:${host.direction}:${host.agent?.currentTool || ''}`;
        rec.urgentPose = host.selected || host.hovered
            || status === AgentStatus.WAITING_ON_USER
            || status === AgentStatus.ERRORED
            || status === AgentStatus.RATE_LIMITED;
        // SD-2 — attention loses nothing in the sun's shade (V9 flag
        // `shadeExempt`, gpu/SunShade.js).
        rec.shadeExempt = isAttentionStatus(status) && !departedTableau(host);
        rec.frameGeometry = frameGeometry;
        rec.walkStrip = undefined;
        host._gpuFrameRecord = rec;
        if (layer) {
            rec.sharedLayer = true;
            rec.pageable = false;
            rec.paletteIdentity = layer.palette;
            rec.variant = layer.palette.variant;
            return;
        }
        rec.sharedLayer = false;
        rec.pageable = undefined;
        rec.paletteIdentity = undefined;
        rec.variant = undefined;
        if (stripProbe) return;
        const walkFrame = !pose && !lodSheet && host.animState === 'walk' && host.motionScale > 0
            ? walkFrameOfCell(host.spriteSheet, host.direction, cell)
            : -1;
        if (walkFrame < 0) return;
        const strip = this._walkStripFor(rec, {
            dx, dy, drawScale, profileKey, spriteId, alpha, contentTopY, frameGeometry,
        });
        if (strip) {
            const ws = this._liveWalkStripRef || (this._liveWalkStripRef = { key: '', cells: null, frame: 0 });
            ws.key = strip.key;
            ws.cells = strip.cells;
            ws.frame = walkFrame;
            rec.walkStrip = ws;
        }
    }

    // 4.7 — the six cells of the current facing's walk row, each resolved by
    // setFrameRecord itself in probe mode, so albedo, padding and every channel
    // source match what the body would sample on that frame. The packer copies
    // them into the body's strip lazily; the key moves whenever the sampled
    // sheet, channels, direction or tool changes.
    _walkStripFor(record, args) {
        const host = this.host;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Channel revisions are per frame (their cache key names the cell), so
        // the strip keys on the asset version; a channel source that changes
        // under the same key (a crop landing) is caught by `stale` below.
        const baseKey = [
            host.direction,
            record.textureKey,
            record.textureRevision,
            host.assets?.assetVersion ?? '',
            host.agent?.currentTool || '',
        ].join('|');
        const cached = this._walkStrip;
        const current = cached?.baseKey === baseKey
            ? cached.cells.find(cell => cell.sx === record.sx && cell.sy === record.sy)
            : null;
        const stale = !current
            || current.source !== record.source
            || current.materialSource !== record.materialSource
            || current.emissiveSource !== record.emissiveSource
            || current.occluderSource !== record.occluderSource
            || current.channelRevision !== record.channelRevision;
        const retry = cached && !cached.complete && now - cached.builtAt >= WALK_STRIP_RETRY_MS;
        if (!stale && !retry) return cached;
        const cells = [];
        let complete = true;
        for (let frame = 0; frame < WALK_FRAMES; frame++) {
            this.setFrameRecord({
                ...args,
                cell: host.spriteSheet.cell('walk', host.direction, frame),
                stripProbe: true,
            });
            const probe = host._gpuFrameRecord;
            if (!probe) {
                host._gpuFrameRecord = record;
                return null;
            }
            complete &&= Boolean(probe.materialSource) === Boolean(record.materialSource)
                && Boolean(probe.emissiveSource) === Boolean(record.emissiveSource)
                && Boolean(probe.occluderSource) === Boolean(record.occluderSource);
            cells.push(probe);
        }
        host._gpuFrameRecord = record;
        this._walkStrip = {
            baseKey,
            key: `${baseKey}|${++walkStripRevision}`,
            cells,
            complete,
            builtAt: now,
        };
        return this._walkStrip;
    }
}

function walkFrameOfCell(sheet, direction, cell) {
    if (!sheet?.cell || !cell) return -1;
    for (let frame = 0; frame < WALK_FRAMES; frame++) {
        const walk = sheet.cell('walk', direction, frame);
        if (walk.sx === cell.sx && walk.sy === cell.sy) return frame;
    }
    return -1;
}
