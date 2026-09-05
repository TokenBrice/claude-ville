import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { WORLD_BODY_FONT } from '../../config/theme.js';
import { agentFrameKeyFromCell } from './AssetManager.js';
import { gpuMaterialNameForProvider } from './gpu/GpuSceneBuilder.js';
import { compactIncidentMark, drawCompactIncidentMark } from './AgentSprite.js';

// Owns the GPU-world base-sprite record and the ungraded Canvas annotation
// pass. The host remains authoritative for animation, identity, and all shared
// annotation primitives, matching the coarse host-backed renderer split used
// by WildlifeRenderer and FoliageRenderer.
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
        const status = host.agent?.status;
        const incident = compactIncidentMark(status, { motionScale: host.motionScale });
        const primary = host.selected || Boolean(incident);
        const overview = !host.selected && zoom < 1;

        // Additive overview annotation: the compact helper is PRIMARY and does
        // not need a GPU body record. needsYou is a no-op (beacon already drawn).
        if (overview && !host.agent?.isDeparted && incident) {
            drawCompactIncidentMark(ctx, incident, { x: host.x, y: host.y, zoom });
        }

        const record = host._gpuFrameRecord;
        if (!record) return;
        const contentTopY = Number.isFinite(record.contentTopY)
            ? record.contentTopY
            : host.y - 48;

        if (host.selected) {
            host._drawFocusPillar(ctx, contentTopY);
        } else if (host.hovered) {
            host._drawHoverRing(ctx);
        }

        // Modular action props stay in the ungraded overlay. They add to the
        // complete GPU body frame and can never punch holes in its alpha.
        if (record.frameGeometry && !host.agent?.isDeparted) {
            host._drawActionPoseOverlay(ctx, record.frameGeometry);
        }

        // Static-band cue: departed agents never pulse or allocate animation
        // state, so reduced motion receives the complete visual treatment.
        if (host.agent?.isDeparted) this.drawDepartedTreatment(ctx);

        const admitted = host.overlaySlot != null || host.nameTagSlot != null || primary;
        if (!host.agent?.isDeparted && (primary || host.selected || annotationMode === 'full' || host.gpuActionOverlay)) {
            if (host.chatting) host._drawChatEffect(ctx);
            else host._drawStatus(ctx, contentTopY);
            // Overview already used the compact helper; skip the close-zoom
            // emote so one incident mark occupies the slot.
            if (!overview) host._drawStatusEmote(ctx, contentTopY);
            host._drawPlanModeGlyph(ctx, contentTopY);
            host._drawRetryGlyph(ctx, contentTopY);
        }

        if (host.selected || (annotationMode === 'full' && host.nameTagSlot != null)) {
            host._drawNameTag(ctx);
        } else if (admitted) {
            host._drawCompactNameStatus(ctx);
        }
    }

    // Lingering-departure cue. This deliberately claims the `static` motion
    // band: no pulse, timer, path, or particle is allocated, and reduced motion
    // sees the identical resting plaque. The muted body is applied at its blit
    // site; this label keeps the state explicit at every annotation LOD.
    drawDepartedTreatment(ctx) {
        const centerX = Math.round(this.host.x);
        const y = Math.round(this.host.y + 10);
        const width = 58;
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
        ctx.font = `700 8px ${WORLD_BODY_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('DEPARTED', 0, height / 2 + 0.5);
        ctx.restore();
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
    }) {
        const host = this.host;
        if (!host.gpuWorldEnabled || !host.spriteCanvas || !cell) {
            host._gpuFrameRecord = null;
            return;
        }
        const source = host._gpuBaseSpriteCanvas || host.spriteCanvas;
        const status = host.agent?.status;
        // Equipped codex sheets are re-laid on a padded cell grid so baked
        // blade tips survive past the 92px body cell; remap the cell UVs and
        // grow the on-screen quad by the same padding. Sidecars are padded
        // copies built alongside the albedo so their UVs stay aligned.
        const layout = host._gpuEquippedSheetLayout;
        const pad = layout && source === host._gpuBaseSpriteCanvas ? layout.pad : 0;
        const cellSize = pad ? layout.cellSize : 0;
        const padded = pad ? cellSize + pad * 2 : 0;
        const col = pad ? Math.floor(cell.sx / cellSize) : 0;
        const row = pad ? Math.floor(cell.sy / cellSize) : 0;
        const frameKey = agentFrameKeyFromCell(cell);
        const equippedMaterial = pad ? host._gpuEquippedMaterialSheet : null;
        const equippedEmissive = pad ? host._gpuEquippedEmissiveSheet : null;
        const resolved = (equippedMaterial || equippedEmissive)
            ? null
            : host.assets?.resolveMaterialChannels?.(spriteId, frameKey, {
                kind: 'agent',
                status,
                selected: host.selected,
                onScreen: true,
            });
        const resolvedReady = resolved?.ready && resolved.origin !== 'fallback';
        const materialSource = equippedMaterial
            || (resolvedReady ? resolved.material : null)
            || (pad ? null : host.assets?.getSidecar?.(spriteId, 'material')
                || host.assets?.getMaterialSidecar?.(spriteId, 'material'))
            || null;
        const emissiveSource = equippedEmissive
            || (resolvedReady ? resolved.emissive : null)
            || (pad ? null : host.assets?.getSidecar?.(spriteId, 'emissive')
                || host.assets?.getMaterialSidecar?.(spriteId, 'emissive'))
            || null;
        host._gpuFrameRecord = {
            id: `agent:${host.agent?.id || profileKey}`,
            stableKey: host.agent?.id || profileKey,
            textureKey: `agent-sheet:${profileKey}`,
            sidecarKey: materialSource || emissiveSource ? `${spriteId}:channels` : '',
            source,
            materialSource,
            emissiveSource,
            occluderSource: pad ? host._gpuEquippedOccluderSheet : resolved?.occluder || host.assets?.getSidecar?.(spriteId, 'occluder') || null,
            channelRevision: resolved?.revision || host.assets?.assetVersion || null,
            sourceWidth: source.width,
            sourceHeight: source.height,
            sx: pad ? col * padded : cell.sx,
            sy: pad ? row * padded : cell.sy,
            sw: pad ? padded : cell.sw,
            sh: pad ? padded : cell.sh,
            x: dx - pad * drawScale,
            y: dy - pad * drawScale,
            width: (pad ? padded : cell.sw) * drawScale,
            height: (pad ? padded : cell.sh) * drawScale,
            alpha: host.agent?.isDeparted ? alpha * 0.58 : alpha,
            material: gpuMaterialNameForProvider(host.agent?.provider),
            elevation: 0.52,
            occluder: 0.58,
            emissive: host.agent?.isDeparted
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
            textureRevision: host._gpuEquippedSheetKey || profileKey,
            sidecarRevision: resolved?.revision || host.assets?.assetVersion || null,
            contentTopY,
            poseKey: `${host.animState}:${host.direction}:${host.agent?.currentTool || ''}`,
            urgentPose: host.selected || host.hovered
                || [AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(status),
            frameGeometry,
        };
    }
}
