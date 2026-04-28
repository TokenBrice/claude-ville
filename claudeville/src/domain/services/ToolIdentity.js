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

const TOOL_ICONS = Object.freeze({
    Read: '📖',
    Edit: '✏️',
    Write: '📝',
    Grep: '🔍',
    Glob: '📁',
    Bash: '⚡',
    Task: '📋',
    TaskCreate: '📋',
    TaskUpdate: '📋',
    TaskList: '📋',
    TodoWrite: '📋',
    WebSearch: '🌐',
    WebFetch: '🌐',
    SendMessage: '💬',
    TeamCreate: '👥',
    NotebookEdit: '📓',
    EnterPlanMode: '📐',
    ExitPlanMode: '📐',
    AskUserQuestion: '❓',
});

const TOOL_CATEGORIES = Object.freeze({
    Read: 'read',
    Grep: 'search',
    Glob: 'search',
    WebSearch: 'search',
    WebFetch: 'search',
    Edit: 'write',
    MultiEdit: 'write',
    Write: 'write',
    NotebookEdit: 'write',
    Bash: 'exec',
    Task: 'task',
    TaskCreate: 'task',
    TaskUpdate: 'task',
    TaskList: 'task',
    TodoWrite: 'task',
    SendMessage: 'task',
    TeamCreate: 'task',
});

const TOOL_ACTION_LABELS = Object.freeze({
    Read: 'Reading',
    Edit: 'Editing',
    Write: 'Writing',
    Bash: 'Running',
    Grep: 'Searching',
    Glob: 'Finding',
    Task: 'Delegating',
    TaskCreate: 'Planning',
    WebSearch: 'Researching',
    WebFetch: 'Fetching',
    SendMessage: 'Messaging',
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

export function normalizeToolInput(input) {
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

export function compactToolLabel(value, fallback = '', maxChars = 18) {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? text.slice(lastSlash + 1) : text).split(/\s+/)[0] || text;
    return base.length > maxChars ? `${base.slice(0, Math.max(1, maxChars - 3))}...` : base;
}

export function compactToolInput(input, maxChars = 18) {
    if (input == null) return '';
    const raw = String(input).trim();
    if (!raw) return '';
    const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw).split(/\s+/)[0] || '';
    if (base.length > 8 && /^[a-z0-9-]+$/i.test(base) && !/[aeiou]/i.test(base)) return '';
    return compactToolLabel(base, '', maxChars);
}

export function isDocumentationToolInput(input) {
    const text = normalizeToolInput(input);
    return /\b(agents|docs|doc|documentation|readme|changelog|handover|plan|spec|adr)\b|(?:^|[\/\s"'=])(?:agents|claude|readme|changelog|contributing|license)(?:\.md)?\b|\.mdx?\b/.test(text);
}

export function isCodeToolInput(input) {
    const text = normalizeToolInput(input);
    return /\b(src|server\.js|adapters|services|widget|claudeville\/src|claudeville\/server\.js)\b|\.([cm]?js|ts|tsx|jsx|css|html|json|yaml|yml)\b/.test(text)
        && !isDocumentationToolInput(input);
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

export function extractToolCalls(input) {
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

    const text = normalizeToolInput(input);
    const found = [...text.matchAll(/(?:recipient_name|tool|name)["']?\s*[:=]\s*["']([^"']+)["']/g)]
        .map((match) => ({ tool: match[1], input: text }));
    return found.length ? found : [{ tool: null, input: text }];
}

export function classifyShellInput(input) {
    const text = normalizeToolInput(input);
    if (!text) return null;

    if (/\b(git\s+(status|diff|show|log|branch|rev-list|fetch|pull|merge|rebase|commit|push|tag)|gh\s+(pr\s+create|release|workflow|run|repo)|wrangler\s+deploy|vercel\s+deploy|npm\s+run\s+deploy)\b/.test(text)) {
        return { building: 'harbor', reason: 'git-flow', confidence: 0.9, label: compactToolLabel(text, 'git') };
    }
    if (/\b(npm\s+(test|run\s+(test|check|lint|build|sprites:validate|sprites:visual-diff))|node\s+--check|xargs\s+-0\s+-n1\s+node\s+--check|pytest|vitest|playwright\s+test)\b/.test(text)) {
        return { building: 'taskboard', reason: 'verify', confidence: 0.94, label: compactToolLabel(text, 'check') };
    }
    if (/\b(npm\s+run\s+dev|node\s+claudeville\/server\.js|playwright|browser|chrome|chromium|firefox|screenshot|localhost|127\.0\.0\.1)\b/.test(text)) {
        return { building: 'portal', reason: 'browser-preview', confidence: 0.86, label: compactToolLabel(text, 'browser') };
    }
    if (/\b(curl|wget|web|fetch|search_query|open\s+https?:\/\/)\b/.test(text)) {
        return { building: 'observatory', reason: 'external-research', confidence: 0.86, label: compactToolLabel(text, 'web') };
    }
    if (/\b(apply_patch|patch|edit|write|create|update|delete|mv|cp|perl\s+-pi)\b/.test(text)) {
        return isDocumentationToolInput(input)
            ? { building: 'archive', reason: 'edit-docs', confidence: 0.78, label: compactToolLabel(text, 'docs') }
            : { building: 'forge', reason: 'modify-files', confidence: 0.9, label: compactToolLabel(text, 'edit') };
    }
    if (/\b(rg|grep|find|fd|ls|cat|sed|head|tail|nl|wc|jq)\b/.test(text)) {
        if (/\b(test|check|lint|build|vitest|pytest|playwright\s+test|node\s+--check|sprites:validate)\b/.test(text)) {
            return { building: 'taskboard', reason: 'inspect-validation', confidence: 0.84, label: compactToolLabel(text, 'check') };
        }
        if (isCodeToolInput(input)) {
            return { building: 'forge', reason: 'inspect-code', confidence: 0.78, label: compactToolLabel(text, 'code') };
        }
        return { building: 'archive', reason: isDocumentationToolInput(input) ? 'read-docs' : 'search-local', confidence: 0.74, label: compactToolLabel(text, 'read') };
    }

    return null;
}

export function classifyTool(toolName, input) {
    const tool = String(toolName || '');
    if (!tool) return null;

    if (MULTI_TOOL_NAMES.has(tool)) {
        const calls = extractToolCalls(input);
        const weights = new Map();
        const examples = new Map();
        for (const call of calls) {
            const classified = classifyTool(call.tool, call.input) || classifyShellInput(call.input);
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
                confidence: Math.min(0.96, Math.max(0.65, weights.get(building) / Math.max(1, calls.length))),
                label: example?.label || compactToolLabel(tool, 'tools'),
            };
        }
        return classifyShellInput(input);
    }

    if (COMMAND_AGENT_TOOLS.has(tool)) {
        return { ...DIRECT_TOOL_CLASSIFICATIONS[tool], label: compactToolLabel(tool, 'agent') };
    }

    if (FILE_MUTATION_TOOLS.has(tool) && isDocumentationToolInput(input)) {
        return { building: 'archive', reason: 'edit-docs', confidence: 0.82, label: compactToolLabel(input, 'docs') };
    }

    if (DIRECT_TOOL_CLASSIFICATIONS[tool]) {
        const base = DIRECT_TOOL_CLASSIFICATIONS[tool];
        if (['Grep', 'Glob', 'LS', 'Read'].includes(tool)) {
            const split = classifyShellInput(input);
            if (split && ['forge', 'taskboard', 'harbor'].includes(split.building)) return split;
            if (isCodeToolInput(input)) {
                return { building: 'forge', reason: 'inspect-code', confidence: 0.78, label: compactToolLabel(input || tool, 'code') };
            }
        }
        return { ...base, label: compactToolLabel(input || tool, tool) };
    }

    if (SHELL_TOOL_NAMES.has(tool)) {
        return classifyShellInput(input);
    }

    const lowerTool = tool.toLowerCase();
    if (lowerTool.includes('spawn_agent') || lowerTool.includes('send_input') || lowerTool.includes('wait_agent') || lowerTool.includes('resume_agent') || lowerTool.includes('close_agent')) {
        return { building: 'command', reason: 'agent-orchestration', confidence: 0.9, label: compactToolLabel(tool, 'agent') };
    }
    if (lowerTool.includes('playwright') || lowerTool.includes('browser') || lowerTool.includes('chrome')) {
        return { building: 'portal', reason: 'browser-preview', confidence: 0.84, label: compactToolLabel(tool, 'browser') };
    }
    if (lowerTool.includes('github') || lowerTool.includes('pull_request') || lowerTool.includes(' pr_')) {
        return { building: 'harbor', reason: 'github-flow', confidence: 0.84, label: compactToolLabel(tool, 'git') };
    }
    if (lowerTool.includes('web') || lowerTool.includes('fetch')) {
        return { building: 'observatory', reason: 'external-research', confidence: 0.82, label: compactToolLabel(tool, 'web') };
    }
    if (lowerTool.includes('apply_patch') || lowerTool.includes('edit') || lowerTool.includes('write') || lowerTool.includes('update_file') || lowerTool.includes('create_file') || lowerTool.includes('delete_file')) {
        return isDocumentationToolInput(input)
            ? { building: 'archive', reason: 'edit-docs', confidence: 0.78, label: compactToolLabel(input, 'docs') }
            : { building: 'forge', reason: 'modify-files', confidence: 0.84, label: compactToolLabel(input || tool, 'edit') };
    }
    if (lowerTool.includes('team') || lowerTool.includes('parallel')) {
        return { building: 'command', reason: 'coordinate-team', confidence: 0.8, label: compactToolLabel(tool, 'team') };
    }
    if (lowerTool.includes('task') || lowerTool.includes('todo') || lowerTool.includes('plan')) {
        return { building: 'taskboard', reason: 'plan-work', confidence: 0.8, label: compactToolLabel(tool, 'task') };
    }
    if (lowerTool.includes('read') || lowerTool.includes('grep') || lowerTool.includes('glob') || lowerTool.includes('find') || lowerTool.includes('search')) {
        const split = classifyShellInput(input);
        if (split) return split;
        return { building: isCodeToolInput(input) ? 'forge' : 'archive', reason: isCodeToolInput(input) ? 'inspect-code' : 'search-local', confidence: 0.68, label: compactToolLabel(input || tool, 'read') };
    }

    return classifyShellInput(input);
}

export function buildingForTool(toolName, input) {
    return classifyTool(toolName, input)?.building || null;
}

export function toolIcon(tool) {
    if (!tool) return '❓';
    const name = String(tool);
    if (name.startsWith('mcp__playwright__')) return '🎭';
    if (name.startsWith('mcp__')) return '🔌';
    return TOOL_ICONS[name] || '🔧';
}

export function toolCategory(tool) {
    if (!tool) return 'other';
    const name = String(tool);
    if (name.startsWith('mcp__')) return 'exec';
    return TOOL_CATEGORIES[name] || 'other';
}

export function shortToolName(name) {
    if (!name) return '';
    return String(name).replace('mcp__playwright__', 'pw:').replace('mcp__', '');
}

export function toolActionLabel(tool) {
    return TOOL_ACTION_LABELS[tool] || tool || '';
}

export function isTaskCommandInput(input) {
    const text = normalizeToolInput(input);
    return /\b(test|check|lint|build|vitest|pytest|playwright\s+test|node\s+--check|sprites:validate)\b/.test(text);
}

export function isCommandToolName(toolName) {
    const tool = String(toolName || '').toLowerCase();
    return tool.includes('spawn_agent') ||
        tool.includes('send_input') ||
        tool.includes('resume_agent') ||
        tool.includes('close_agent') ||
        tool.includes('team') ||
        tool.includes('parallel') ||
        tool === 'task' ||
        tool === 'multi_tool_use';
}
