const DEFAULT_TTLS = Object.freeze({
    chat: { priority: 100, ttlMs: 30000, stickyMs: 30000 },
    alert: { priority: 90, ttlMs: 45000, stickyMs: 10000 },
    git: { priority: 85, ttlMs: 90000, stickyMs: 20000 },
    tool: { priority: 80, ttlMs: 30000, stickyMs: 8000 },
    token: { priority: 65, ttlMs: 25000, stickyMs: 8000 },
    team: { priority: 60, ttlMs: 45000, stickyMs: 12000 },
    subagent: { priority: 60, ttlMs: 45000, stickyMs: 12000 },
    quota: { priority: 50, ttlMs: 60000, stickyMs: 10000 },
    ambient: { priority: 10, ttlMs: 20000, stickyMs: 0 },
});

const DIRECT_TOOL_CLASSIFICATIONS = Object.freeze({
    Read: { building: 'archive', reason: 'read-local', confidence: 0.72 },
    Grep: { building: 'archive', reason: 'search-local', confidence: 0.7 },
    Glob: { building: 'archive', reason: 'find-local', confidence: 0.68 },
    LS: { building: 'archive', reason: 'list-local', confidence: 0.64 },

    WebSearch: { building: 'observatory', reason: 'web-search', confidence: 0.95 },
    WebFetch: { building: 'observatory', reason: 'web-fetch', confidence: 0.95 },
    'web.run': { building: 'observatory', reason: 'web-tool', confidence: 0.95 },

    Edit: { building: 'forge', reason: 'edit-file', confidence: 0.96 },
    MultiEdit: { building: 'forge', reason: 'edit-file', confidence: 0.96 },
    Write: { building: 'forge', reason: 'write-file', confidence: 0.96 },
    apply_patch: { building: 'forge', reason: 'patch-file', confidence: 0.98 },
    'functions.apply_patch': { building: 'forge', reason: 'patch-file', confidence: 0.98 },
    NotebookEdit: { building: 'forge', reason: 'edit-notebook', confidence: 0.86 },
    'image_gen.imagegen': { building: 'forge', reason: 'generate-asset', confidence: 0.82 },

    Task: { building: 'command', reason: 'delegate-task', confidence: 0.82 },
    TeamCreate: { building: 'command', reason: 'form-team', confidence: 0.96 },
    SendMessage: { building: 'command', reason: 'message-agent', confidence: 0.98 },
    'functions.spawn_agent': { building: 'command', reason: 'spawn-agent', confidence: 0.98 },
    'functions.send_input': { building: 'command', reason: 'send-agent-input', confidence: 0.98 },
    'functions.wait_agent': { building: 'command', reason: 'wait-agent', confidence: 0.98 },
    'functions.close_agent': { building: 'command', reason: 'close-agent', confidence: 0.98 },
    'functions.resume_agent': { building: 'command', reason: 'resume-agent', confidence: 0.98 },

    TaskCreate: { building: 'taskboard', reason: 'plan-task', confidence: 0.92 },
    TaskUpdate: { building: 'taskboard', reason: 'update-task', confidence: 0.92 },
    TaskList: { building: 'taskboard', reason: 'review-tasks', confidence: 0.88 },
    TodoWrite: { building: 'taskboard', reason: 'plan-work', confidence: 0.95 },
    'functions.update_plan': { building: 'taskboard', reason: 'plan-work', confidence: 0.95 },
    'functions.request_user_input': { building: 'taskboard', reason: 'ask-decision', confidence: 0.86 },
});

const COMMAND_AGENT_TOOLS = new Set([
    'functions.spawn_agent',
    'functions.send_input',
    'functions.wait_agent',
    'functions.close_agent',
    'functions.resume_agent',
]);

const FILE_MUTATION_TOOLS = new Set([
    'Edit',
    'MultiEdit',
    'Write',
    'apply_patch',
    'functions.apply_patch',
]);

const MULTI_TOOL_NAMES = new Set([
    'multi_tool_use',
    'multi_tool_use.parallel',
]);

const SHELL_TOOL_NAMES = new Set([
    'Bash',
    'shell',
    'exec_command',
    'functions.exec_command',
    'functions.write_stdin',
    'command_execution',
]);

const MULTI_TOOL_PRIORITY = ['harbor', 'taskboard', 'command', 'forge', 'archive', 'portal', 'observatory', 'mine'];
const TOKEN_DELTA_THRESHOLD = 128;
const CONTEXT_PRESSURE_THRESHOLD = 0.82;
const MAX_SEEN_GIT_EVENTS = 600;

function timeNow() {
    return Date.now();
}

function agentListFrom(input, world = null) {
    const source = input || world?.agents || [];
    if (source?.values) return Array.from(source.values());
    if (Array.isArray(source)) return source;
    if (source && typeof source[Symbol.iterator] === 'function') return Array.from(source);
    return [];
}

function normalizeText(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input.toLowerCase();
    if (typeof input === 'object') {
        const fields = [
            'cmd',
            'command',
            'script',
            'args',
            'arguments',
            'url',
            'path',
            'file_path',
            'cwd',
            'pattern',
            'query',
            'prompt',
            'description',
            'recipient_name',
        ];
        const parts = [];
        for (const field of fields) {
            if (input[field] == null) continue;
            parts.push(typeof input[field] === 'object' ? JSON.stringify(input[field]) : String(input[field]));
        }
        if (parts.length) return parts.join(' ').toLowerCase();
    }
    return String(input).toLowerCase();
}

function tryParseToolInput(input) {
    if (!input || typeof input !== 'string') return input;
    const text = input.trim();
    if (!text || !/^[\[{]/.test(text)) return input;
    try {
        return JSON.parse(text);
    } catch {
        return input;
    }
}

function extractToolCalls(input) {
    const parsed = tryParseToolInput(input);
    const calls = [];
    const collect = (value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }

        const tool = value.recipient_name || value.tool || value.name || value.function || value.type;
        const parameters = value.parameters || value.arguments || value.input || value.args || value;
        if (tool && !MULTI_TOOL_NAMES.has(tool)) {
            calls.push({ tool, input: parameters });
        }

        if (Array.isArray(value.tool_uses)) value.tool_uses.forEach(collect);
        if (Array.isArray(value.calls)) value.calls.forEach(collect);
        if (Array.isArray(value.tools)) value.tools.forEach(collect);
    };

    collect(parsed);
    if (calls.length) return calls;

    const text = normalizeText(input);
    const found = [...text.matchAll(/(?:recipient_name|tool|name)["']?\s*[:=]\s*["']([^"']+)["']/g)]
        .map((match) => ({ tool: match[1], input: text }));
    return found.length ? found : [{ tool: null, input: text }];
}

function compactLabel(value, fallback = '') {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? text.slice(lastSlash + 1) : text).split(/\s+/)[0] || text;
    return base.length > 18 ? `${base.slice(0, 15)}...` : base;
}

function isDocsInput(input) {
    const text = normalizeText(input);
    return /\b(agents|docs|doc|documentation|readme|changelog|handover|plan|spec|adr)\b|(?:^|[\/\s"'=])(?:agents|claude|readme|changelog|contributing|license)(?:\.md)?\b|\.mdx?\b/.test(text);
}

function isCodePathInput(input) {
    const text = normalizeText(input);
    return /\b(src|server\.js|adapters|services|widget|claudeville\/src|claudeville\/server\.js)\b|\.([cm]?js|ts|tsx|jsx|css|html|json|yaml|yml)\b/.test(text)
        && !isDocsInput(input);
}

function shellClassification(input) {
    const text = normalizeText(input);
    if (!text) return null;

    if (/\b(git\s+(status|diff|show|log|branch|rev-list|fetch|pull|merge|rebase|commit|push|tag)|gh\s+(pr\s+create|release|workflow|run|repo)|wrangler\s+deploy|vercel\s+deploy|npm\s+run\s+deploy)\b/.test(text)) {
        return { building: 'harbor', reason: 'git-flow', confidence: 0.9, label: compactLabel(text, 'git') };
    }
    if (/\b(npm\s+(test|run\s+(test|check|lint|build|sprites:validate|sprites:visual-diff))|node\s+--check|xargs\s+-0\s+-n1\s+node\s+--check|pytest|vitest|playwright\s+test)\b/.test(text)) {
        return { building: 'taskboard', reason: 'verify', confidence: 0.94, label: compactLabel(text, 'check') };
    }
    if (/\b(npm\s+run\s+dev|node\s+claudeville\/server\.js|playwright|browser|chrome|chromium|firefox|screenshot|localhost|127\.0\.0\.1)\b/.test(text)) {
        return { building: 'portal', reason: 'browser-preview', confidence: 0.86, label: compactLabel(text, 'browser') };
    }
    if (/\b(curl|wget|web|fetch|search_query|open\s+https?:\/\/)\b/.test(text)) {
        return { building: 'observatory', reason: 'external-research', confidence: 0.86, label: compactLabel(text, 'web') };
    }
    if (/\b(apply_patch|patch|edit|write|create|update|delete|mv|cp|perl\s+-pi)\b/.test(text)) {
        return isDocsInput(input)
            ? { building: 'archive', reason: 'edit-docs', confidence: 0.78, label: compactLabel(text, 'docs') }
            : { building: 'forge', reason: 'modify-files', confidence: 0.9, label: compactLabel(text, 'edit') };
    }
    if (/\b(rg|grep|find|fd|ls|cat|sed|head|tail|nl|wc|jq)\b/.test(text)) {
        if (/\b(test|check|lint|build|vitest|pytest|playwright\s+test|node\s+--check|sprites:validate)\b/.test(text)) {
            return { building: 'taskboard', reason: 'inspect-validation', confidence: 0.84, label: compactLabel(text, 'check') };
        }
        if (isCodePathInput(input)) {
            return { building: 'forge', reason: 'inspect-code', confidence: 0.78, label: compactLabel(text, 'code') };
        }
        return { building: 'archive', reason: isDocsInput(input) ? 'read-docs' : 'search-local', confidence: 0.74, label: compactLabel(text, 'read') };
    }

    return null;
}

function classifyTool(toolName, input) {
    const tool = String(toolName || '');
    if (!tool) return null;

    if (MULTI_TOOL_NAMES.has(tool)) {
        const weights = new Map();
        const examples = new Map();
        for (const call of extractToolCalls(input)) {
            const classified = classifyTool(call.tool, call.input) || shellClassification(call.input);
            if (!classified?.building) continue;
            weights.set(classified.building, (weights.get(classified.building) || 0) + classified.confidence);
            if (!examples.has(classified.building)) examples.set(classified.building, classified);
        }
        if (weights.size) {
            const building = MULTI_TOOL_PRIORITY
                .filter((candidate) => weights.has(candidate))
                .sort((a, b) => {
                    const delta = weights.get(b) - weights.get(a);
                    if (delta !== 0) return delta;
                    return MULTI_TOOL_PRIORITY.indexOf(a) - MULTI_TOOL_PRIORITY.indexOf(b);
                })[0];
            const example = examples.get(building);
            return {
                building,
                reason: example?.reason || 'multi-tool',
                confidence: Math.min(0.96, Math.max(0.65, weights.get(building) / Math.max(1, extractToolCalls(input).length))),
                label: example?.label || compactLabel(tool, 'tools'),
            };
        }
        return shellClassification(input);
    }

    if (COMMAND_AGENT_TOOLS.has(tool)) {
        return { ...DIRECT_TOOL_CLASSIFICATIONS[tool], label: compactLabel(tool, 'agent') };
    }

    if (FILE_MUTATION_TOOLS.has(tool) && isDocsInput(input)) {
        return { building: 'archive', reason: 'edit-docs', confidence: 0.82, label: compactLabel(input, 'docs') };
    }

    if (DIRECT_TOOL_CLASSIFICATIONS[tool]) {
        const base = DIRECT_TOOL_CLASSIFICATIONS[tool];
        if (['Grep', 'Glob', 'LS', 'Read'].includes(tool)) {
            const split = shellClassification(input);
            if (split && ['forge', 'taskboard', 'harbor'].includes(split.building)) return split;
            if (isCodePathInput(input)) {
                return { building: 'forge', reason: 'inspect-code', confidence: 0.78, label: compactLabel(input || tool, 'code') };
            }
        }
        return { ...base, label: compactLabel(input || tool, tool) };
    }

    if (SHELL_TOOL_NAMES.has(tool)) {
        return shellClassification(input);
    }

    const lowerTool = tool.toLowerCase();
    if (lowerTool.includes('spawn_agent') || lowerTool.includes('send_input') || lowerTool.includes('wait_agent') || lowerTool.includes('resume_agent') || lowerTool.includes('close_agent')) {
        return { building: 'command', reason: 'agent-orchestration', confidence: 0.9, label: compactLabel(tool, 'agent') };
    }
    if (lowerTool.includes('playwright') || lowerTool.includes('browser') || lowerTool.includes('chrome')) {
        return { building: 'portal', reason: 'browser-preview', confidence: 0.84, label: compactLabel(tool, 'browser') };
    }
    if (lowerTool.includes('github') || lowerTool.includes('pull_request') || lowerTool.includes(' pr_')) {
        return { building: 'harbor', reason: 'github-flow', confidence: 0.84, label: compactLabel(tool, 'git') };
    }
    if (lowerTool.includes('web') || lowerTool.includes('fetch')) {
        return { building: 'observatory', reason: 'external-research', confidence: 0.82, label: compactLabel(tool, 'web') };
    }
    if (lowerTool.includes('apply_patch') || lowerTool.includes('edit') || lowerTool.includes('write') || lowerTool.includes('update_file') || lowerTool.includes('create_file') || lowerTool.includes('delete_file')) {
        return isDocsInput(input)
            ? { building: 'archive', reason: 'edit-docs', confidence: 0.78, label: compactLabel(input, 'docs') }
            : { building: 'forge', reason: 'modify-files', confidence: 0.84, label: compactLabel(input || tool, 'edit') };
    }
    if (lowerTool.includes('team') || lowerTool.includes('parallel')) {
        return { building: 'command', reason: 'coordinate-team', confidence: 0.8, label: compactLabel(tool, 'team') };
    }
    if (lowerTool.includes('task') || lowerTool.includes('todo') || lowerTool.includes('plan')) {
        return { building: 'taskboard', reason: 'plan-work', confidence: 0.8, label: compactLabel(tool, 'task') };
    }
    if (lowerTool.includes('read') || lowerTool.includes('grep') || lowerTool.includes('glob') || lowerTool.includes('find') || lowerTool.includes('search')) {
        const split = shellClassification(input);
        if (split) return split;
        return { building: isCodePathInput(input) ? 'forge' : 'archive', reason: isCodePathInput(input) ? 'inspect-code' : 'search-local', confidence: 0.68, label: compactLabel(input || tool, 'read') };
    }

    return shellClassification(input);
}

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    const input = Number(tokens.input ?? tokens.totalInput ?? 0) || 0;
    const output = Number(tokens.output ?? tokens.totalOutput ?? 0) || 0;
    const cacheRead = Number(tokens.cacheRead ?? 0) || 0;
    const cacheCreate = Number(tokens.cacheCreate ?? tokens.cacheWrite ?? 0) || 0;
    return input + output + cacheRead + cacheCreate;
}

function contextRatio(agent) {
    const tokens = agent?.tokens || {};
    const current = Number(tokens.contextWindow ?? 0) || 0;
    const max = Number(tokens.contextWindowMax ?? 0) || 0;
    if (current <= 0 || max <= 0) return 0;
    return Math.max(0, Math.min(1, current / max));
}

function parseTime(value, fallback = 0) {
    if (Number.isFinite(Number(value))) return Number(value);
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function gitEventKind(event) {
    const raw = String(event?.type || event?.kind || event?.action || event?.event || event?.name || '').toLowerCase();
    if (raw.includes('push')) return 'push';
    if (raw.includes('commit')) return 'commit';
    if (event?.pushed === true || Array.isArray(event?.commits)) return 'push';
    if (event?.sha || event?.commit || event?.hash) return 'commit';
    return null;
}

function normalizePushStatus(event) {
    if (!event || typeof event !== 'object') return 'unknown';
    if (typeof event.success === 'boolean') return event.success ? 'success' : 'failed';
    const exitCode = event.exitCode ?? event.exit_code ?? event.code ?? event.returnCode ?? event.return_code;
    if (Number.isFinite(Number(exitCode))) return Number(exitCode) === 0 ? 'success' : 'failed';
    const text = String(event.status ?? event.outcome ?? event.conclusion ?? event.result ?? event.state ?? event.lifecycle ?? '').toLowerCase();
    if (['success', 'succeeded', 'ok', 'passed', 'pass', 'complete', 'completed', 'landed'].includes(text)) return 'success';
    if (['failed', 'failure', 'fail', 'error', 'errored', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(text)) return 'failed';
    return 'unknown';
}

function normalizeGitEventForIntent(event, agent = {}, index = 0, now = timeNow()) {
    if (!event || typeof event !== 'object') return null;
    const type = gitEventKind(event);
    if (!type) return null;
    const project = event.project || event.projectPath || event.repository || event.repo || event.workspace || agent.projectPath || agent.teamName || 'unknown';
    const sha = event.sha || event.commit || event.hash || event.commitSha || event.revision || '';
    const timestamp = parseTime(
        event.timestamp || event.time || event.ts || event.date || event.createdAt || event.created_at,
        parseTime(agent.lastSessionActivity, now)
    );
    const id = String(event.id || event.eventId || event.uuid || event.key || `${type}:${project}:${sha}:${timestamp}:${index}`);
    const label = event.label || event.message || event.subject || event.title || (sha ? String(sha).slice(0, 10) : type);
    return {
        id,
        type,
        project: String(project),
        sha: sha ? String(sha) : '',
        timestamp,
        label: compactLabel(label, type),
        targetRef: event.targetRef || event.ref || event.branch || '',
        status: type === 'push' ? normalizePushStatus(event) : null,
        agentId: agent.id || agent.agentId || '',
        sessionId: event.sessionId || event.session_id || agent.sessionId || agent.agentId || agent.id || '',
        provider: event.provider || agent.provider || '',
    };
}

function intentSort(a, b, now) {
    const aSticky = a.stickyUntil > now ? 1 : 0;
    const bSticky = b.stickyUntil > now ? 1 : 0;
    if (aSticky !== bSticky) return bSticky - aSticky;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return b.createdAt - a.createdAt;
}

export class VisitIntentManager {
    constructor({ world = null, now = null } = {}) {
        this.world = world;
        this.now = typeof now === 'function' ? now : timeNow;
        this.intentsByAgent = new Map();
        this.tokenSnapshots = new Map();
        this.seenGitEventIds = new Set();
    }

    update(agents = null, now = this.now()) {
        const currentNow = Number.isFinite(Number(now)) ? Number(now) : this.now();
        const activeAgents = agentListFrom(agents, this.world);
        const activeIds = new Set();

        for (const agent of activeAgents) {
            if (!agent?.id) continue;
            activeIds.add(agent.id);
            this._deriveAgentIntents(agent, currentNow);
        }

        for (const agentId of Array.from(this.intentsByAgent.keys())) {
            if (!activeIds.has(agentId)) this.intentsByAgent.delete(agentId);
        }
        for (const agentId of Array.from(this.tokenSnapshots.keys())) {
            if (!activeIds.has(agentId)) this.tokenSnapshots.delete(agentId);
        }

        this._trimSeenGitEvents();
        this._expireIntents(currentNow);
        return this.snapshot(currentNow);
    }

    getIntentForAgent(agentId, now = this.now()) {
        const intents = [...(this.intentsByAgent.get(agentId)?.values() || [])]
            .filter((intent) => intent.expiresAt > now);
        if (!intents.length) return null;
        return intents.sort((a, b) => intentSort(a, b, now))[0] || null;
    }

    snapshot(now = this.now()) {
        const intents = [];
        for (const map of this.intentsByAgent.values()) {
            for (const intent of map.values()) {
                if (intent.expiresAt <= now) continue;
                intents.push({ ...intent, msRemaining: Math.max(0, intent.expiresAt - now) });
            }
        }
        intents.sort((a, b) => (a.agentId || '').localeCompare(b.agentId || '') || intentSort(a, b, now));
        return {
            now,
            agents: this.intentsByAgent.size,
            intents,
            tokenSnapshots: [...this.tokenSnapshots.entries()].map(([agentId, total]) => ({ agentId, total })),
            seenGitEvents: this.seenGitEventIds.size,
        };
    }

    debug(now = this.now()) {
        return this.snapshot(now);
    }

    debugSnapshot(now = this.now()) {
        return this.snapshot(now);
    }

    dispose() {
        this.intentsByAgent.clear();
        this.tokenSnapshots.clear();
        this.seenGitEventIds.clear();
    }

    _deriveAgentIntents(agent, now) {
        this._deriveToolIntent(agent, now);
        this._deriveTokenIntents(agent, now);
        this._deriveGitIntents(agent, now);
        this._deriveRelationshipIntents(agent, now);
    }

    _deriveToolIntent(agent, now) {
        const tool = agent.currentTool || null;
        if (!tool) return;
        const classified = classifyTool(tool, agent.currentToolInput ?? agent.lastToolInput);
        if (!classified?.building) return;

        this._upsertIntent(agent.id, {
            source: 'tool',
            sourceKey: [
                tool,
                JSON.stringify(agent.currentToolInput ?? ''),
                agent.lastSessionActivity || '',
            ].join('|'),
            building: classified.building,
            reason: classified.reason,
            confidence: classified.confidence,
            label: classified.label || compactLabel(tool, 'tool'),
            payload: {
                tool,
                input: agent.currentToolInput ?? null,
                sessionId: agent.sessionId || agent.agentId || agent.id,
            },
        }, now);
    }

    _deriveTokenIntents(agent, now) {
        const current = tokenTotal(agent);
        const previous = this.tokenSnapshots.get(agent.id);
        this.tokenSnapshots.set(agent.id, current);

        if (previous != null && current > previous) {
            const delta = current - previous;
            if (delta >= TOKEN_DELTA_THRESHOLD) {
                this._upsertIntent(agent.id, {
                    source: 'token',
                    sourceKey: `${Math.floor(current / TOKEN_DELTA_THRESHOLD)}:${delta}`,
                    building: 'mine',
                    reason: 'token-delta',
                    confidence: Math.min(0.95, 0.55 + delta / 3000),
                    label: `+${delta}`,
                    payload: { delta, total: current, ratio: contextRatio(agent) },
                }, now);
            }
        }

        const ratio = contextRatio(agent);
        if (ratio >= CONTEXT_PRESSURE_THRESHOLD) {
            this._upsertIntent(agent.id, {
                source: 'quota',
                sourceKey: `context:${Math.floor(ratio * 100)}`,
                building: 'mine',
                reason: 'context-pressure',
                confidence: Math.min(0.95, ratio),
                label: `${Math.round(ratio * 100)}%`,
                payload: { ratio, total: current },
            }, now);
        }
    }

    _deriveGitIntents(agent, now) {
        const sources = [agent.gitEvents, agent.git?.events, agent.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            source.forEach((event, index) => {
                const normalized = normalizeGitEventForIntent(event, agent, index, now);
                if (!normalized) return;
                const sourceKey = `${normalized.sessionId}:${normalized.id}`;
                const ageMs = Math.max(0, now - normalized.timestamp);
                const isFresh = ageMs < DEFAULT_TTLS.git.ttlMs && !this.seenGitEventIds.has(sourceKey);
                if (!isFresh) return;
                this.seenGitEventIds.add(sourceKey);

                this._upsertIntent(agent.id, {
                    source: 'git',
                    sourceKey,
                    building: 'harbor',
                    reason: normalized.type === 'push' ? 'push' : 'commit',
                    confidence: normalized.type === 'push' ? 0.94 : 0.86,
                    label: normalized.label,
                    payload: normalized,
                    createdAt: normalized.timestamp || now,
                }, now);

                if (normalized.type === 'push' && normalized.status === 'failed') {
                    this._upsertIntent(agent.id, {
                        source: 'alert',
                        sourceKey: `failed-push:${sourceKey}`,
                        building: 'watchtower',
                        reason: 'failed-push-watch',
                        confidence: 0.94,
                        label: normalized.label || 'push failed',
                        payload: normalized,
                        createdAt: normalized.timestamp || now,
                    }, now);
                }
            });
        }
    }

    _deriveRelationshipIntents(agent, now) {
        if (agent.parentSessionId) {
            this._upsertIntent(agent.id, {
                source: 'subagent',
                sourceKey: String(agent.parentSessionId),
                building: 'command',
                reason: 'join-parent',
                confidence: 0.72,
                label: 'subagent',
                payload: { parentId: agent.parentSessionId },
            }, now);
        }
        if (agent.teamName) {
            this._upsertIntent(agent.id, {
                source: 'team',
                sourceKey: String(agent.teamName),
                building: 'command',
                reason: 'join-team',
                confidence: 0.68,
                label: compactLabel(agent.teamName, 'team'),
                payload: { teamName: agent.teamName },
            }, now);
        }
    }

    _trimSeenGitEvents() {
        if (this.seenGitEventIds.size <= MAX_SEEN_GIT_EVENTS) return;
        this.seenGitEventIds = new Set([...this.seenGitEventIds].slice(-Math.floor(MAX_SEEN_GIT_EVENTS * 0.75)));
    }

    _upsertIntent(agentId, draft, now) {
        if (!agentId || !draft?.building || !draft?.source) return null;
        const meta = DEFAULT_TTLS[draft.source] || DEFAULT_TTLS.ambient;
        const createdAt = Number.isFinite(Number(draft.createdAt)) ? Number(draft.createdAt) : now;
        const sourceKey = String(draft.sourceKey || draft.reason || draft.building);
        const id = `${agentId}:${draft.source}:${sourceKey}`;
        const map = this._agentIntentMap(agentId);
        const previous = map.get(id);
        const intent = {
            id,
            agentId,
            building: draft.building,
            source: draft.source,
            reason: draft.reason || draft.source,
            priority: Number.isFinite(Number(draft.priority)) ? Number(draft.priority) : meta.priority,
            confidence: Math.max(0, Math.min(1, Number(draft.confidence ?? 0.5))),
            label: draft.label || '',
            createdAt: previous?.createdAt || createdAt,
            updatedAt: now,
            expiresAt: Math.max(previous?.expiresAt || 0, now + meta.ttlMs),
            stickyUntil: Math.max(previous?.stickyUntil || 0, now + meta.stickyMs),
            targetTile: draft.targetTile || previous?.targetTile || null,
            payload: draft.payload || {},
        };
        map.set(id, intent);
        return intent;
    }

    _agentIntentMap(agentId) {
        let map = this.intentsByAgent.get(agentId);
        if (!map) {
            map = new Map();
            this.intentsByAgent.set(agentId, map);
        }
        return map;
    }

    _expireIntents(now) {
        for (const [agentId, map] of this.intentsByAgent.entries()) {
            for (const [id, intent] of map.entries()) {
                if (intent.expiresAt <= now) map.delete(id);
            }
            if (!map.size) this.intentsByAgent.delete(agentId);
        }
    }
}

export { classifyTool };
