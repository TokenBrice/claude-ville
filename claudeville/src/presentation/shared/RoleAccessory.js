// Maps an agent's role string (or current tool name) onto one of the six
// existing head-accessory overlays. Effort-tier accessories (xhigh/max) still
// win; this function is the fallback when no effort overlay is present.

const ROLE_PATTERNS = [
    { id: 'mageHood', re: /mage|sorcer|magic|wizard/ },
    { id: 'scholarCap', re: /research|scholar|analy/ },
    { id: 'oracleVeil', re: /web|browser|frontend|qa|test/ },
    { id: 'toolBand', re: /engineer|build|dev|code|backend/ },
    { id: 'goggles', re: /forge|smith|craft/ },
    { id: 'starCrown', re: /lead|coordinator|manager|team/ },
];

const TOOL_PATTERNS = [
    { id: 'oracleVeil', re: /^(WebFetch|WebSearch|web\.run)$|playwright|browser|chrome|mcp__plugin_playwright|mcp__claude-in-chrome/i },
    { id: 'toolBand', re: /^(Edit|MultiEdit|Write|apply_patch|NotebookEdit)$|functions\.apply_patch/ },
    { id: 'goggles', re: /^(Bash|shell|exec_command|command_execution)$|functions\.(exec_command|write_stdin)/ },
    { id: 'starCrown', re: /^(Task|TeamCreate|TodoWrite)$|spawn_agent|send_input|wait_agent|resume_agent|close_agent/ },
    { id: 'scholarCap', re: /^(Read|Grep|Glob|LS)$/ },
];

// Resolves the accessory plus its source. `role` accessories are permanent
// (an agent's role does not change mid-session) while `tool` accessories flip
// with currentTool — callers debounce the latter to stop hats teleporting.
export function resolveRoleAccessory(agent) {
    if (!agent) return null;
    const role = String(agent.role || '').toLowerCase();
    if (role) {
        for (const { id, re } of ROLE_PATTERNS) {
            if (re.test(role)) return { id, source: 'role' };
        }
    }
    const tool = String(agent.currentTool || '');
    if (tool) {
        for (const { id, re } of TOOL_PATTERNS) {
            if (re.test(tool)) return { id, source: 'tool' };
        }
    }
    return null;
}

export function runtimeRoleAccessory(agent) {
    const resolved = resolveRoleAccessory(agent);
    return resolved ? resolved.id : null;
}
