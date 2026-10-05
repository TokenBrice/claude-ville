import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { WORLD_DISPLAY_FONT_8 } from '../../config/theme.js';
import { agentFrameKeyFromCell } from './AssetManager.js';
import { gpuMaterialNameForProvider } from './gpu/GpuSceneBuilder.js';
import { materialClassId } from './gpu/GpuWorldPolicy.js';
import { isAttentionStatus } from './AttentionPlates.js';
import { DEFAULT_CELL, WALK_FRAMES } from './SpriteSheet.js';

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

export class AgentGpuOverlayRenderer {
    constructor(host) {
        this.host = host;
    }

    setEnabled(enabled) {
        const next = Boolean(enabled);
        this.host.gpuWorldEnabled = next;
        if (!next) this.host._gpuFrameRecord = null;
    }

    getRecords() {
        return this.host._gpuFrameRecord ? [this.host._gpuFrameRecord] : [];
    }

    draw(ctx, zoom = 1, annotationMode = 'full') {
        const host = this.host;
        if (!host.gpuWorldEnabled || !ctx) return;
        host._zoom = zoom;
        // W-F16 — a body the depth pass hid behind a building keeps its marks
        // and name hidden with it; the selected one is x-rayed, so keeps both.
        if (host._behindBuilding && !host.selected) return;
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
            host._drawSignatureMark(ctx, record.frameGeometry);
            host._drawReceiveBeat(ctx, record.frameGeometry);
            // Plan 2.7 — a half-scale crowd body keeps its identity plate and
            // evidence seals but sheds the 1:1-sized procedural gestures,
            // which would be twice its proportion and read as noise.
            const fullBody = !record.frameGeometry.lod;
            if (fullBody) host._drawStanceOverlay(ctx, record.frameGeometry);
            host._drawActionPoseOverlay(ctx, record.frameGeometry);
            if (fullBody) host._drawToolRitualOverlay(ctx, record.frameGeometry);
        }

        // Static-band cue: departed agents never pulse or allocate animation
        // state, so reduced motion receives the complete visual treatment.
        if (departedTableau(host)) this.drawDepartedTreatment(ctx);

        // Speech has a per-villager lifetime; shared annotation pressure must
        // not switch every live thought off and back on together.
        if (!departedTableau(host) && !host.chatting) {
            host._drawStatus(ctx, host._labelTopY(contentTopY));
        }
        if (!departedTableau(host) && (primary || host.selected || annotationMode === 'full' || host.gpuActionOverlay)) {
            // Head-anchored labels clear the chevron: nothing crosses the body.
            const labelTopY = host._labelTopY(contentTopY);
            if (host.chatting) host._drawChatEffect(ctx, labelTopY);
            if (!overview) host._drawStatusEmote(ctx, labelTopY);
            host._drawPlanModeGlyph(ctx, labelTopY);
            host._drawRetryGlyph(ctx, labelTopY);
        }

        // C5 identity: _drawNameTag gates the T2 plate / T4 name itself.
        host._drawNameTag(ctx);
    }

    // Lingering-departure cue. This deliberately claims the `static` motion
    // band: no pulse, timer, path, or particle is allocated, and reduced motion
    // sees the identical resting plaque. The muted body is applied at its blit
    // site; this label keeps the state explicit at every annotation LOD.
    drawDepartedTreatment(ctx) {
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
    }) {
        const host = this.host;
        if (!host.gpuWorldEnabled || !host.spriteCanvas || !cell) {
            host._gpuFrameRecord = null;
            return;
        }
        // 2.2 — an authored C2 pose replaces both the sampled sheet and the
        // source rect, so the resident body shows the same hands the Canvas
        // body does. Equipment padding never applies: the strip owns its grip.
        let source = pose ? pose.source : (host._gpuBaseSpriteCanvas || host.spriteCanvas);
        const status = host.agent?.status;
        // Equipped codex sheets are re-laid on a padded cell grid so baked
        // blade tips survive past the 92px body cell; remap the cell UVs and
        // grow the on-screen quad by the same padding. The channel companions
        // stay unpadded: `channelRect` places their sheet cell at the pad.
        const layout = host._gpuEquippedSheetLayout;
        const pad = layout && source === host._gpuBaseSpriteCanvas ? layout.pad : 0;
        const cellSize = pad ? layout.cellSize : 0;
        const padded = pad ? cellSize + pad * 2 : 0;
        const col = pad ? Math.floor(cell.sx / cellSize) : 0;
        const row = pad ? Math.floor(cell.sy / cellSize) : 0;
        const bodyCell = pose ? pose.cell : cell;
        // 7.1 — a seated body arrives clipped at its seat line (sh < cell);
        // the padded slot keeps its top pad and drops the rows below the clip.
        const paddedRows = pad && bodyCell.sh < cellSize ? pad + bodyCell.sh : padded;
        const frameKey = agentFrameKeyFromCell(bodyCell);
        // Plan 2.7 — a crowd body samples the baked 0.5x LOD sheet at world
        // scale 1: source rects halve, and with drawScale 0.5 the quad keeps
        // one LOD texel per world texel. Authored channel sidecars describe
        // the full-resolution cells, so the LOD body uses record defaults.
        // B.2 — an equipped profile's LOD sheet outlives its released albedo.
        const lodCell = pad ? padded : (host.spriteSheet?.cellSize || DEFAULT_CELL);
        const lodSheet = lod && !pose
            ? (host._gpuLodSheet
                ? host._gpuLodSheet(source, lodCell)
                : host.compositor?.halfScaleSheet?.(source, lodCell))
            : null;
        // A released albedo's stand-in is never drawn.
        if (!lodSheet && source && source === host._gpuEquippedEntry?.stub) {
            host._gpuFrameRecord = null;
            return;
        }
        const sourceScale = lodSheet ? 0.5 : 1;
        if (lodSheet) source = lodSheet;
        const sheetCell = pad && !lodSheet;
        const sheetMaterial = sheetCell
            ? host.assets?.getSidecar?.(spriteId, 'material') || host.assets?.getMaterialSidecar?.(spriteId, 'material') || null
            : null;
        const sheetEmissive = sheetCell
            ? host.assets?.getSidecar?.(spriteId, 'emissive') || host.assets?.getMaterialSidecar?.(spriteId, 'emissive') || null
            : null;
        const resolved = (sheetMaterial || sheetEmissive || pose || lodSheet)
            ? null
            : host.assets?.resolveMaterialChannels?.(spriteId, frameKey, {
                kind: 'agent',
                status,
                selected: host.selected,
                onScreen: true,
            });
        const resolvedReady = resolved?.ready && resolved.origin !== 'fallback';
        // A strip carries its own optional material companions; it never
        // borrows the base sheet's, whose cells describe a different pose.
        const authoredMaterial = lodSheet
            ? null
            : pose
                ? pose.strip?.channels?.material || null
                : sheetMaterial
                    || (resolvedReady ? resolved.material : null)
                    || (pad ? null : host.assets?.getSidecar?.(spriteId, 'material')
                        || host.assets?.getMaterialSidecar?.(spriteId, 'material'))
                    || null;
        const authoredEmissive = lodSheet
            ? null
            : pose
                ? pose.strip?.channels?.emissive || null
                : sheetEmissive
                    || (resolvedReady ? resolved.emissive : null)
                    || (pad ? null : host.assets?.getSidecar?.(spriteId, 'emissive')
                        || host.assets?.getMaterialSidecar?.(spriteId, 'emissive'))
                    || null;
        const authoredOccluder = lodSheet
            ? null
            : pose
                ? pose.strip?.channels?.occluder || null
                : sheetCell ? host.assets?.getSidecar?.(spriteId, 'occluder') || null
                    : resolved?.occluder || host.assets?.getSidecar?.(spriteId, 'occluder') || null;
        // B.2 — material + occluder travel as one packed geometry map (V9
        // flag 32); an all-transparent emissive companion is dropped.
        const materialSource = host._packedGeometrySource?.(authoredMaterial, authoredOccluder) || null;
        const emissiveSource = host._authoredEmissionSource?.(authoredEmissive) || null;
        // Sheet-layout companions of an equipped body: the unpadded cell,
        // drawn at the pad offset inside the padded atlas slot.
        const channelRect = sheetCell && (materialSource || emissiveSource) && (sheetMaterial || sheetEmissive || authoredOccluder)
            ? { sx: col * cellSize, sy: row * cellSize, sw: cellSize, sh: cellSize, dx: pad, dy: pad }
            : null;
        host._gpuFrameRecord = {
            id: `agent:${host.agent?.id || profileKey}`,
            stableKey: host.agent?.id || profileKey,
            textureKey: pose
                ? `agent-strip:${profileKey}:${pose.group}`
                : `agent-sheet${lodSheet ? '-lod' : ''}:${profileKey}`,
            sidecarKey: materialSource || emissiveSource ? `${spriteId}:${pose ? 'strip' : 'channels'}` : '',
            source,
            materialSource,
            emissiveSource,
            packedGeometry: Boolean(materialSource),
            channelRect,
            channelRevision: resolved?.revision || host.assets?.assetVersion || null,
            sourceWidth: source.width,
            sourceHeight: source.height,
            sx: (pad ? col * padded : bodyCell.sx) * sourceScale,
            sy: (pad ? row * padded : bodyCell.sy) * sourceScale,
            sw: (pad ? padded : bodyCell.sw) * sourceScale,
            sh: (pad ? paddedRows : bodyCell.sh) * sourceScale,
            x: dx - pad * drawScale,
            y: dy - pad * drawScale,
            width: (pad ? padded : bodyCell.sw) * drawScale,
            height: (pad ? paddedRows : bodyCell.sh) * drawScale,
            alpha: departedTableau(host) ? alpha * 0.58 : alpha,
            material: gpuMaterialNameForProvider(host.agent?.provider),
            elevation: 0.52,
            occluder: 0.58,
            emissive: departedTableau(host)
                ? 0
                : status === AgentStatus.WAITING_ON_USER
                    ? 0.42
                    : status === AgentStatus.COMPLETED
                        ? 0.20
                        : status === AgentStatus.WORKING
                            ? 0.08
                            : 0,
            // The equipped-sheet key folds in the asset version, so a weapon
            // asset arriving after a fallback-vector bake re-uploads the sheet.
            textureRevision: pose
                ? `strip:${profileKey}:${pose.group}`
                : `${lodSheet ? 'lod:' : ''}${host._gpuEquippedSheetKey || profileKey}`,
            sidecarRevision: resolved?.revision || host.assets?.assetVersion || null,
            contentTopY,
            poseKey: `${pose ? `${pose.group}:${bodyCell.sy}` : host.animState}:${host.direction}:${host.agent?.currentTool || ''}`,
            urgentPose: host.selected || host.hovered
                || [AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(status),
            frameGeometry,
        };
        if (stripProbe) return;
        const walkFrame = !pose && !lodSheet && host.animState === 'walk' && host.motionScale > 0
            ? walkFrameOfCell(host.spriteSheet, host.direction, cell)
            : -1;
        if (walkFrame < 0) return;
        const strip = this._walkStripFor(host._gpuFrameRecord, {
            dx, dy, drawScale, profileKey, spriteId, alpha, contentTopY, frameGeometry,
        });
        if (strip) host._gpuFrameRecord.walkStrip = { key: strip.key, cells: strip.cells, frame: walkFrame };
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
