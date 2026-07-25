// Turn state: what a session is actually doing, read from its transcript.
//
// The old model inferred everything from file mtime age, which cannot tell
// "thinking" from "blocked on you" from "finished" — the three states the
// village exists to communicate. Provider transcripts carry the real signal:
//
//   - an assistant turn that ended (`stop_reason: 'end_turn'`, Codex
//     `task_complete`) means the ball is in the user's court;
//   - a tool call with no matching result means a tool is pending, which is
//     either executing or sitting on a permission prompt;
//   - anything else is live work.
//
// This module is pure and provider-agnostic: adapters extract a small
// descriptor from their own format and hand it here. Kept CommonJS to match
// the rest of `adapters/`.

const TurnState = Object.freeze({
  WORKING: 'working',
  TOOL_PENDING: 'tool_pending',
  AWAITING_INPUT: 'awaiting_input',
  UNKNOWN: 'unknown',
});

const WaitReason = Object.freeze({
  QUESTION: 'question',
  APPROVAL: 'approval',
  PLAN_REVIEW: 'plan_review',
});

// Tools that are a request to the user by definition — pending at all means
// waiting, with no dwell time needed.
const ASK_TOOLS = new Set([
  'AskUserQuestion',
  'request_user_input',
  'functions.request_user_input',
]);

const PLAN_TOOLS = new Set([
  'ExitPlanMode',
  'EnterPlanMode',
]);

// Tools that normally complete in well under a second. Once one of these has
// been pending past INSTANT_PENDING_MS the only ordinary explanation left is a
// permission prompt.
const INSTANT_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'TodoWrite',
  'apply_patch',
  'read_file',
  'write_file',
  'edit_file',
  'list_files',
  'search',
  'shell_view',
]);

// A pending instant tool is a permission prompt this fast.
const INSTANT_PENDING_MS = 15_000;
// Variable-duration tools (Bash, agents, network) legitimately run for
// minutes. Only flag them well past the point where a person would have
// looked anyway — a false "needs you" is worse than a late one.
const VARIABLE_PENDING_MS = 240_000;

// Edit-class tools that `acceptEdits` auto-approves.
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'apply_patch',
  'edit_file',
  'write_file',
]);

function pendingThresholdMs(tool) {
  if (!tool) return VARIABLE_PENDING_MS;
  if (ASK_TOOLS.has(tool) || PLAN_TOOLS.has(tool)) return 0;
  if (INSTANT_TOOLS.has(tool)) return INSTANT_PENDING_MS;
  return VARIABLE_PENDING_MS;
}

/**
 * Decide whether a pending tool call is blocked on the user or just running.
 *
 * `permissionMode` is the Claude-only plan/act marker; when it says the tool
 * could not have prompted, dwell time is irrelevant and the call is executing.
 *
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function classifyPendingTool({ tool = null, permissionMode = null, pendingForMs = 0 } = {}) {
  const name = typeof tool === 'string' && tool ? tool : null;
  const elapsed = Number.isFinite(Number(pendingForMs)) ? Math.max(0, Number(pendingForMs)) : 0;

  if (name && ASK_TOOLS.has(name)) return { blocked: true, reason: WaitReason.QUESTION };
  if (name && PLAN_TOOLS.has(name)) return { blocked: true, reason: WaitReason.PLAN_REVIEW };

  // Nothing prompts under bypassPermissions, so a pending tool is running.
  if (permissionMode === 'bypassPermissions') return { blocked: false, reason: null };
  // acceptEdits silences the edit-class prompts but not the rest.
  if (permissionMode === 'acceptEdits' && name && EDIT_TOOLS.has(name)) {
    return { blocked: false, reason: null };
  }

  if (elapsed >= pendingThresholdMs(name)) return { blocked: true, reason: WaitReason.APPROVAL };
  return { blocked: false, reason: null };
}

/**
 * Fold a transcript descriptor into a turn state.
 *
 * @param {object} descriptor
 * @param {boolean} descriptor.turnEnded    last assistant turn closed cleanly
 * @param {number}  descriptor.turnEndedAt  ms epoch of that close
 * @param {string}  descriptor.pendingTool  name of an unanswered tool call
 * @param {number}  descriptor.pendingSince ms epoch the call was issued
 * @param {string}  descriptor.permissionMode
 * @param {number}  now
 * @returns {{ turnState: string, pendingTool: string|null, pendingSince: number|null,
 *             awaitingSince: number|null, waitReason: string|null }}
 */
function deriveTurnState(descriptor = {}, now = Date.now()) {
  const {
    turnEnded = false,
    turnEndedAt = null,
    pendingTool = null,
    pendingSince = null,
    permissionMode = null,
    known = true,
  } = descriptor;

  const empty = {
    turnState: TurnState.UNKNOWN,
    pendingTool: null,
    pendingSince: null,
    awaitingSince: null,
    waitReason: null,
  };

  if (!known) return empty;

  if (pendingTool) {
    const since = Number.isFinite(Number(pendingSince)) ? Number(pendingSince) : null;
    const pendingForMs = since ? Math.max(0, now - since) : 0;
    const { blocked, reason } = classifyPendingTool({
      tool: pendingTool,
      permissionMode,
      pendingForMs,
    });
    return {
      turnState: TurnState.TOOL_PENDING,
      pendingTool,
      pendingSince: since,
      awaitingSince: blocked ? since : null,
      waitReason: blocked ? reason : null,
    };
  }

  if (turnEnded) {
    const at = Number.isFinite(Number(turnEndedAt)) ? Number(turnEndedAt) : null;
    return {
      turnState: TurnState.AWAITING_INPUT,
      pendingTool: null,
      pendingSince: null,
      awaitingSince: at,
      waitReason: null,
    };
  }

  return {
    turnState: TurnState.WORKING,
    pendingTool: null,
    pendingSince: null,
    awaitingSince: null,
    waitReason: null,
  };
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  TurnState,
  WaitReason,
  ASK_TOOLS,
  INSTANT_PENDING_MS,
  VARIABLE_PENDING_MS,
  classifyPendingTool,
  deriveTurnState,
  pendingThresholdMs,
  toEpochMs,
};
