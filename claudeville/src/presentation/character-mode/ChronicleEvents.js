// Git commit event helpers used by Chronicle subsystems.
// Extracted from the former ChronicleManifests module so the visual
// "manifest" rendering could be removed without losing event collection.

const MAX_LABEL_CHARS = 34;

export function commitMessageFromCommand(command) {
    const text = String(command || '');
    const match = text.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    return String(match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function shortText(value, maxChars = MAX_LABEL_CHARS) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}...`;
}

function eventTimestamp(event, fallback = Date.now()) {
    const raw = event?.ts ?? event?.timestamp ?? event?.time ?? event?.createdAt ?? event?.completedAt;
    if (Number.isFinite(Number(raw))) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function projectName(project) {
    const parts = String(project || 'unknown').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

function normalizeGitEvent(event, agent = {}, index = 0) {
    if (!event || typeof event !== 'object') return null;
    const type = String(event.type || event.kind || '').toLowerCase();
    if (type !== 'commit') return null;
    const project = event.project || event.projectPath || event.repository || event.repo || agent.project || 'unknown';
    const ts = eventTimestamp(event, eventTimestamp(agent, Date.now()));
    const label = event.label || event.subject || event.message || commitMessageFromCommand(event.command) || event.sha || 'commit';
    const id = String(event.id || event.eventId || `${type}:${project}:${event.sha || event.commandHash || label}:${ts}:${index}`);
    return {
        id,
        type,
        project: String(project),
        repoName: projectName(project),
        sha: String(event.sha || event.commit || event.hash || ''),
        command: String(event.command || ''),
        label: shortText(label),
        provider: event.provider || agent.provider || '',
        sessionId: event.sessionId || agent.sessionId || agent.id || '',
        sourceId: event.sourceId || '',
        ts,
        success: typeof event.success === 'boolean' ? event.success : null,
        exitCode: Number.isFinite(Number(event.exitCode)) ? Number(event.exitCode) : null,
    };
}

export function collectCommitEvents(agents) {
    const events = [];
    for (const agent of agents || []) {
        const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            source.forEach((event, index) => {
                const normalized = normalizeGitEvent(event, agent, index);
                if (normalized) events.push(normalized);
            });
        }
    }
    events.sort((a, b) => (a.ts - b.ts) || a.id.localeCompare(b.id));
    return events;
}
