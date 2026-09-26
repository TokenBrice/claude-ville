// Wave-5 stand-ins for what the World renderer gives the audio director
// (the virtual-clock page has no renderer): a ritual conductor that starts a
// ritual on every observed tool start, as the real RitualConductor does on
// `tool:invoked`, and a scripted camera. Both are read by the shipped
// director through its seams (`window.__claudeVilleApp.renderer
// .ritualConductor`, `director.setCameraSource`), and both report what the
// renderer would have drawn, so the probe can judge the heard against it.
import { eventBus } from '/src/domain/events/DomainEvent.js';
import { classifyTool } from '/src/domain/services/ToolIdentity.js';
import {
    DOWNBEAT_MOMENT, MAX_CONCURRENT_RITUALS, RITUAL_GESTURE_PERIOD_MS, RITUAL_POSE_BY_BUILDING,
} from '/src/presentation/character-mode/RitualConductor.js';

// RitualConductor's RITUAL_META durations and its pending → playing step.
const RITUAL_DURATION_MS = { forge: 1500, archive: 1800, mine: 1500, observatory: 1900, portal: 2600, taskboard: 2600, command: 2600, harbor: 30000 };
const PENDING_MS = 180;
const FADING_MS = 280;
const STRIDE = 3;

const toolKey = agent => (agent?.status === 'working' && agent.currentTool
    ? `${agent.currentTool}|${JSON.stringify(agent.currentToolInput ?? null)}`
    : null);

// A conductor whose rituals follow the scene's tool starts. Every ritual's
// drawn downbeats (the cream frame at beat·period, every third beat from its
// origin, while it lives) are what `ritualDownbeat` would draw.
export function installRitualConductor() {
    const rituals = [];
    const keys = new Map();
    const observe = (agent) => {
        if (!agent?.id) return;
        const key = toolKey(agent);
        const prev = keys.get(agent.id);
        keys.set(agent.id, key);
        if (!key || key === prev) return;
        const building = classifyTool(agent.currentTool, agent.currentToolInput)?.building;
        const pose = RITUAL_POSE_BY_BUILDING[building];
        if (!RITUAL_GESTURE_PERIOD_MS[pose] || !RITUAL_DURATION_MS[building]) return;
        const now = Date.now();
        const live = rituals.filter(r => r.endMs > now && r.evictedMs == null);
        if (live.length >= MAX_CONCURRENT_RITUALS) {
            live.sort((a, b) => a.createdAt - b.createdAt);
            live[0].evictedMs = now;
        }
        const period = RITUAL_GESTURE_PERIOD_MS[pose];
        const playAt = now + PENDING_MS;
        rituals.push({
            agentId: agent.id, building, pose, createdAt: now, playAt, endMs: now + RITUAL_DURATION_MS[building], evictedMs: null,
            beatOrigin: Math.floor((playAt + DOWNBEAT_MOMENT.anticipation) / period) + 1, period, motionEnabled: true,
        });
    };
    const offs = [eventBus.on('agent:updated', observe), eventBus.on('agent:added', observe)];
    const view = (r, now) => {
        const phase = now < r.playAt ? 'pending' : r.endMs - now <= FADING_MS ? 'fading' : 'playing';
        return {
            agentId: r.agentId, building: r.building, pose: r.pose, phase, motionEnabled: true, remainingMs: r.endMs - now,
            beatOrigin: phase === 'pending' ? null : r.beatOrigin,
        };
    };
    const conductor = {
        rituals,
        getActiveRitualsForBuilding(type) {
            const now = Date.now();
            return rituals.filter(r => r.building === type && r.endMs > now && r.evictedMs == null).map(r => view(r, now));
        },
        // The downbeats the renderer drew (Date.now ms), in time order.
        drawn() {
            const out = [];
            for (const r of rituals) {
                const end = Math.min(r.endMs, r.evictedMs ?? Infinity);
                for (let beat = r.beatOrigin; beat * r.period < end; beat += STRIDE) {
                    if (beat * r.period >= r.playAt) out.push({ building: r.building, agentId: r.agentId, atMs: beat * r.period });
                }
            }
            return out.sort((a, b) => a.atMs - b.atMs);
        },
        dispose() { for (const off of offs) off?.(); },
    };
    window.__claudeVilleApp = { renderer: { ritualConductor: conductor } };
    return conductor;
}

// A scripted camera: `path` [{ at (scene s), cx, cy }] of the view centre in
// world px, linear between points and held after the last. Returns the
// Camera-shaped snapshot the director reads (centre cx = w/(2·zoom) − x).
export function scriptedCamera({ viewportW = 1280, viewportH = 720, zoom = 1, path }, sceneSec) {
    const pts = path.slice().sort((a, b) => a.at - b.at);
    return () => {
        const t = sceneSec();
        let p = pts[0];
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            if (t >= b.at) { p = b; continue; }
            if (t > a.at) {
                const f = (t - a.at) / (b.at - a.at);
                p = { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
            }
            break;
        }
        return { x: viewportW / (2 * zoom) - p.cx, y: viewportH / (2 * zoom) - p.cy, zoom, viewportW, viewportH };
    };
}
