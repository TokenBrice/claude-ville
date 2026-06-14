const TAU = Math.PI * 2;

const BUILDING_COLORS = Object.freeze({
    command: '244, 196, 93',
    taskboard: '125, 211, 252',
    archive: '192, 132, 252',
    mine: '251, 146, 60',
    forge: '248, 113, 113',
    harbor: '94, 234, 212',
    watchtower: '250, 204, 21',
    observatory: '129, 140, 248',
});

const INCIDENT_COLORS = Object.freeze({
    quota: '251, 146, 60',
    'failed-push': '248, 113, 113',
    rate_limited: '250, 204, 21',
    waiting_on_user: '250, 204, 21',
    errored: '248, 113, 113',
});

function clamp(value, min = 0, max = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function rgba(rgb, alpha) {
    return `rgba(${rgb}, ${clamp(alpha)})`;
}

function signalColor(type) {
    return BUILDING_COLORS[type] || '226, 232, 240';
}

function incidentColor(kind) {
    return INCIDENT_COLORS[kind] || '250, 204, 21';
}

function motionPulse(now, scale, phase = 0, speed = 620) {
    if (!scale) return 0.5;
    return 0.5 + Math.sin(now / speed + phase) * 0.5;
}

function textWidth(ctx, text) {
    return Math.ceil(ctx.measureText(String(text || '')).width);
}

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function agentTrailColor(point = {}) {
    if (point.status === 'errored') return '248, 113, 113';
    if (point.status === 'waiting_on_user' || point.status === 'rate_limited') return '250, 204, 21';
    if (point.status === 'waiting') return '251, 146, 60';
    const palette = [
        '125, 211, 252',
        '134, 239, 172',
        '216, 180, 254',
        '94, 234, 212',
        '244, 196, 93',
    ];
    return palette[hashText(point.teamName || point.provider || point.id) % palette.length];
}

function drawWorldPill(ctx, x, y, text, rgb = '226, 232, 240', alpha = 1) {
    const label = String(text || '').trim();
    if (!label) return;
    ctx.save();
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const width = Math.max(30, textWidth(ctx, label) + 12);
    const height = 14;
    const left = Math.round(x - width / 2);
    const top = Math.round(y - height / 2);
    ctx.globalAlpha = clamp(alpha);
    ctx.fillStyle = 'rgba(21, 18, 15, 0.78)';
    ctx.strokeStyle = rgba(rgb, 0.72);
    ctx.lineWidth = 1;
    ctx.fillRect(left, top, width, height);
    ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
    ctx.fillStyle = '#fff4cf';
    ctx.fillText(label.toUpperCase(), Math.round(x), Math.round(y + 0.5));
    ctx.restore();
}

function drawIsoRing(ctx, x, y, radius, rgb, alpha, lineWidth = 2, skew = 0.45) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    ctx.save();
    ctx.strokeStyle = rgba(rgb, alpha);
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.ellipse(x, y, radius, radius * skew, -0.04, 0, TAU);
    ctx.stroke();
    ctx.restore();
}

function drawSignalHalo(ctx, signal, now, motionScale) {
    if (!signal?.center) return;
    const rgb = signalColor(signal.type);
    const heat = clamp(signal.heat ?? 0.35);
    const pulse = motionPulse(now, motionScale, heat * 3.1);
    const radius = 28 + heat * 26 + pulse * 5;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = rgba(rgb, 0.055 + heat * 0.07);
    ctx.beginPath();
    ctx.ellipse(signal.center.x, signal.center.y + 4, radius, radius * 0.42, -0.04, 0, TAU);
    ctx.fill();
    drawIsoRing(ctx, signal.center.x, signal.center.y + 4, radius, rgb, 0.22 + heat * 0.18, 1.4 + heat * 1.6);
    if (heat > 0.48 || signal.selected) {
        drawIsoRing(ctx, signal.center.x, signal.center.y + 4, radius + 10, rgb, 0.08 + heat * 0.12, 1);
    }
    ctx.restore();
}

function drawReplay(ctx, samples, now, selectedAgentId = null) {
    if (!samples?.length) return;
    const byAgent = new Map();
    for (const sample of samples) {
        const age = now - sample.ts;
        if (age < 0 || age > 60_000) continue;
        for (const point of sample.points || []) {
            if (!point?.id) continue;
            let list = byAgent.get(point.id);
            if (!list) {
                list = [];
                byAgent.set(point.id, list);
            }
            list.push({ ...point, ts: sample.ts });
        }
    }

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const points of byAgent.values()) {
        if (points.length < 2) continue;
        const latest = points.at(-1);
        const rgb = agentTrailColor(latest);
        const selected = latest?.id && latest.id === selectedAgentId;
        ctx.lineWidth = selected ? 2.6 : 1.25;
        ctx.strokeStyle = rgba(rgb, selected ? 0.62 : 0.30);
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        const tickEvery = selected ? 2 : 4;
        ctx.fillStyle = rgba(rgb, selected ? 0.52 : 0.24);
        for (let i = Math.max(0, points.length - 16); i < points.length; i += tickEvery) {
            const p = points[i];
            const age = clamp((now - p.ts) / 60_000);
            const size = selected ? 2.6 : 1.7;
            ctx.globalAlpha = selected ? 0.8 * (1 - age * 0.45) : 0.42 * (1 - age * 0.55);
            ctx.beginPath();
            ctx.ellipse(p.x, p.y - 2, size, size * 0.7, 0, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        const tail = points.at(-1);
        const age = clamp((now - tail.ts) / 60_000);
        ctx.fillStyle = rgba(rgb, 0.35 * (1 - age) + 0.12);
        ctx.beginPath();
        ctx.ellipse(tail.x, tail.y - 2, selected ? 5 : 3.5, selected ? 3.2 : 2.2, 0, 0, TAU);
        ctx.fill();
    }
    ctx.restore();
}

function drawSignalRoutes(ctx, selected, { alphaScale = 1, dash = [6, 7], lineWidth = 1.2 } = {}) {
    if (!selected?.routes?.length) return;
    const rgb = signalColor(selected.type);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    for (const route of selected.routes) {
        if (!route?.from || !route?.to) continue;
        ctx.strokeStyle = rgba(rgb, (route.status === 'working' ? 0.40 : 0.24) * alphaScale);
        ctx.beginPath();
        const midX = (route.from.x + route.to.x) / 2;
        const midY = Math.min(route.from.y, route.to.y) - 26;
        ctx.moveTo(route.from.x, route.from.y - 4);
        ctx.quadraticCurveTo(midX, midY, route.to.x, route.to.y + 6);
        ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
}

function drawTeams(ctx, teams, now, motionScale) {
    if (!teams?.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const team of teams) {
        const pulse = motionPulse(now, motionScale, team.members?.length || 1, 760);
        const radius = (team.radius || 36) + pulse * 4;
        ctx.fillStyle = rgba('125, 211, 252', 0.055);
        ctx.beginPath();
        ctx.ellipse(team.x, team.y + 4, radius, radius * 0.46, -0.03, 0, TAU);
        ctx.fill();
        drawIsoRing(ctx, team.x, team.y + 4, radius, '125, 211, 252', 0.16 + pulse * 0.08, 1.2);
    }
    ctx.restore();
}

function drawIncidents(ctx, incidents, now, motionScale) {
    if (!incidents?.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const incident of incidents) {
        const center = incident.agent || incident.center;
        if (!center) continue;
        const rgb = incidentColor(incident.kind);
        const intensity = clamp(incident.intensity ?? 0.7, 0.2, 1);
        const fade = 1 - clamp(incident.progress ?? 0);
        const pulse = motionPulse(now, motionScale, intensity * 8, 420);
        const radius = 24 + intensity * 32 + pulse * 7;
        ctx.fillStyle = rgba(rgb, (0.08 + intensity * 0.06) * fade);
        ctx.beginPath();
        ctx.ellipse(center.x, center.y - 6, radius, radius * 0.44, -0.08, 0, TAU);
        ctx.fill();
        drawIsoRing(ctx, center.x, center.y - 6, radius, rgb, (0.24 + intensity * 0.22) * fade, 2.2);
    }
    ctx.restore();
}

function drawHandoffs(ctx, handoffs, now, motionScale) {
    if (!handoffs?.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const handoff of handoffs) {
        const from = handoff.from;
        const to = handoff.to;
        if (!from || !to) continue;
        const fade = 1 - clamp(handoff.progress ?? 0);
        const pulse = motionPulse(now, motionScale, handoff.startedAt || 0, 520);
        ctx.strokeStyle = rgba('244, 196, 93', 0.38 * fade);
        ctx.lineWidth = 1.2 + pulse * 0.8;
        ctx.setLineDash([4, 5]);
        const midX = (from.x + to.x) / 2;
        const midY = Math.min(from.y, to.y) - 38;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y - 16);
        ctx.quadraticCurveTo(midX, midY, to.x, to.y - 16);
        ctx.stroke();
        ctx.setLineDash([]);
        const t = motionScale ? clamp((now - (handoff.startedAt || now)) / 1100) : 1;
        const inv = 1 - t;
        const x = inv * inv * from.x + 2 * inv * t * midX + t * t * to.x;
        const y = inv * inv * (from.y - 16) + 2 * inv * t * midY + t * t * (to.y - 16);
        ctx.fillStyle = rgba('244, 196, 93', 0.55 * fade);
        ctx.beginPath();
        ctx.ellipse(x, y, 4.5, 2.5, -0.2, 0, TAU);
        ctx.fill();
    }
    ctx.restore();
}

function drawLifecycle(ctx, lifecycle, now, motionScale) {
    if (!lifecycle?.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const scene of lifecycle) {
        const center = scene.center;
        if (!center) continue;
        const fade = 1 - clamp(scene.progress ?? 0);
        const rgb = scene.kind === 'arrival' ? '134, 239, 172' : '216, 180, 254';
        const pulse = motionPulse(now, motionScale, scene.startedAt || 0, 520);
        drawIsoRing(ctx, center.x, center.y - 4, 16 + pulse * 9, rgb, 0.25 * fade, 1.4);
        ctx.fillStyle = rgba(rgb, 0.18 * fade);
        ctx.beginPath();
        ctx.ellipse(center.x, center.y - 4, 6 + pulse * 2, 3.5, 0, 0, TAU);
        ctx.fill();
    }
    ctx.restore();
}

function drawReleaseParade(ctx, parade, now, motionScale) {
    if (!parade?.center) return;
    const fadeIn = clamp((parade.progress || 0) / 0.18);
    const fadeOut = 1 - clamp(((parade.progress || 0) - 0.78) / 0.22);
    const alpha = clamp(Math.min(fadeIn, fadeOut));
    if (alpha <= 0.02) return;
    const pulse = motionPulse(now, motionScale, 2.7, 500);
    const x = parade.center.x;
    const y = parade.center.y - 60;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = rgba('94, 234, 212', 0.32 * alpha);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 92, y + 38);
    ctx.quadraticCurveTo(x - 18, y - 14 - pulse * 8, x + 92, y + 28);
    ctx.stroke();
    ctx.strokeStyle = rgba('244, 196, 93', 0.28 * alpha);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 78, y + 50);
    ctx.quadraticCurveTo(x + 8, y + 4 + pulse * 6, x + 108, y + 44);
    ctx.stroke();
    ctx.restore();
}

export function drawVillageDirectorGround(ctx, snapshot, now = Date.now()) {
    if (!ctx || !snapshot) return;
    drawReplay(ctx, snapshot.replaySamples, now, snapshot.selectedAgentId);
    for (const signal of snapshot.buildingSignals || []) drawSignalHalo(ctx, signal, now, snapshot.motionScale);
    if (snapshot.hoverBuildingSignal) {
        drawSignalHalo(ctx, snapshot.hoverBuildingSignal, now, snapshot.motionScale);
        drawSignalRoutes(ctx, snapshot.hoverBuildingSignal, { alphaScale: 0.52, dash: [3, 9], lineWidth: 1 });
    }
    if (snapshot.selectedBuildingSignal) {
        drawSignalHalo(ctx, { ...snapshot.selectedBuildingSignal, heat: Math.max(0.52, snapshot.selectedBuildingSignal.heat || 0) }, now, snapshot.motionScale);
        drawSignalRoutes(ctx, snapshot.selectedBuildingSignal);
    }
    drawTeams(ctx, snapshot.teams, snapshot.perfNow || now, snapshot.motionScale);
    drawIncidents(ctx, snapshot.incidents, snapshot.perfNow || now, snapshot.motionScale);
    drawReleaseParade(ctx, snapshot.releaseParade, snapshot.perfNow || now, snapshot.motionScale);
}

export function drawVillageDirectorOverlays(ctx, snapshot, now = Date.now()) {
    if (!ctx || !snapshot) return;
    drawHandoffs(ctx, snapshot.handoffs, now, snapshot.motionScale);
    drawLifecycle(ctx, snapshot.lifecycle, now, snapshot.motionScale);

    const selected = snapshot.selectedBuildingSignal;
    if (selected?.center) {
        const rgb = signalColor(selected.type);
        drawWorldPill(ctx, selected.center.x, selected.center.y - 56, selected.label || selected.type, rgb, 0.92);
    }
    const hover = snapshot.hoverBuildingSignal;
    if (hover?.center) {
        const rgb = signalColor(hover.type);
        drawWorldPill(ctx, hover.center.x, hover.center.y - 48, hover.label || hover.type, rgb, 0.58);
    }

    for (const incident of snapshot.incidents || []) {
        const center = incident.agent || incident.center;
        if (!center || !incident.label) continue;
        const rgb = incidentColor(incident.kind);
        drawWorldPill(ctx, center.x, center.y - 62, incident.label, rgb, 0.88 * (1 - clamp(incident.progress ?? 0)));
    }

    const parade = snapshot.releaseParade;
    if (parade?.center) {
        drawWorldPill(ctx, parade.center.x, parade.center.y - 92, `Parade ${parade.label || ''}`, '94, 234, 212', 0.92);
    }
}

export function drawVillageDirectorScreen(ctx, snapshot, viewport) {
    if (!ctx || !snapshot?.replayActive || !viewport) return;
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const text = `REPLAY 60S · ${snapshot.replayAgentCount || 0} AGENTS`;
    const width = Math.ceil(ctx.measureText(text).width) + 18;
    const x = 18;
    const y = Math.max(76, Math.round(viewport.height - 34));
    ctx.fillStyle = 'rgba(18, 24, 28, 0.78)';
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.58)';
    ctx.fillRect(x, y - 12, width, 22);
    ctx.strokeRect(x + 0.5, y - 11.5, width - 1, 21);
    ctx.fillStyle = '#dff7ff';
    ctx.fillText(text, x + 9, y);
    ctx.restore();
}
