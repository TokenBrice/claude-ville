import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { WORLD_BODY_FONT } from '../../config/theme.js';

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
        const record = host._gpuFrameRecord;
        if (!host.gpuWorldEnabled || !record || !ctx) return;
        host._zoom = zoom;
        const contentTopY = Number.isFinite(record.contentTopY)
            ? record.contentTopY
            : host.y - 48;
        const status = host.agent?.status;
        const primary = host.selected || status === AgentStatus.WAITING_ON_USER
            || status === AgentStatus.ERRORED || status === AgentStatus.RATE_LIMITED;

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
            host._drawStatusEmote(ctx, contentTopY);
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
        const materialSource = host.assets?.getSidecar?.(spriteId, 'material')
            || host.assets?.getMaterialSidecar?.(spriteId, 'material')
            || null;
        host._gpuFrameRecord = {
            id: `agent:${host.agent?.id || profileKey}`,
            stableKey: host.agent?.id || profileKey,
            textureKey: `agent-sheet:${profileKey}`,
            sidecarKey: materialSource ? `${spriteId}:material` : '',
            source,
            materialSource,
            sourceWidth: source.width,
            sourceHeight: source.height,
            sx: cell.sx,
            sy: cell.sy,
            sw: cell.sw,
            sh: cell.sh,
            x: dx,
            y: dy,
            width: cell.sw * drawScale,
            height: cell.sh * drawScale,
            alpha: host.agent?.isDeparted ? alpha * 0.58 : alpha,
            material: host.agent?.provider === 'codex' ? 'metal' : 'fabric',
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
            textureRevision: profileKey,
            sidecarRevision: host.assets?.assetVersion || null,
            contentTopY,
            frameGeometry,
        };
    }
}
