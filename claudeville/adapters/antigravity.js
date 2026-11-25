/**
 * Google Antigravity (`agy` CLI / Antigravity 2.0 / Antigravity IDE) adapter.
 *
 * Antigravity persists per-conversation step transcripts under:
 *   ~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
 * alongside workspace history in `history.jsonl`, active workspace pointers in
 * `cache/last_conversations.json`, conversation summaries/timestamps in
 * `cache/conversation_metadata.json`, and user defaults in `settings.json`.
 *
 * T3 Code runs each Antigravity thread as `agy acp` with a private data
 * directory, `~/.t3/userdata/providers/antigravity/<instance>/antigravity-acp/`,
 * which keeps the same layout and is discovered as one more surface.
 *
 * Subagents (`invoke_subagent`), workflows (`run_workflow`), and native swarms
 * (`swarm` / `send_message` / `post_message`) write their own conversation
 * transcripts under `brain/<child-id>/` and link back to their parent via the
 * parent transcript's tool-call / tool-result steps.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDetailResponse,
  deleteTailState,
  fileSignature,
  noteReadFailure,
  readHeadText,
  readJsonLines,
  stripShellLocationPrefix,
  summarizeToolInput,
  trimCache,
} = require('./shared');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { deriveTurnState } = require('./turnState');
const { normalizeToolResults, toolResultId, toolResultLocation } = require('./toolResults');
const { queryT3State, readT3RenamedTitles, t3UserDataDir } = require('./t3code');
const {
  dedupeGitEvents,
  extractGitEventsFromCommandSource,
  normalizeProjectPath,
} = require('./gitEvents');
const { contextWindowForModel } = require('../src/config/models.generated.cjs');

const SESSION_PREFIX = 'antigravity-';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Orchestrator mode alternates planner steps (`gemini-pro-orchestrator-neon`)
// with executor steps (`gemini-flash-worker-agy`) inside one conversation.
const ORCHESTRATOR_MODEL_RE = /(?:^|-)orchestrator-/;
const ORCHESTRATOR_WORKER_RE = /flash-worker/;

const HEAD_LINES = 32;
const TAIL_LINES = 2000;
const DETAIL_TAIL_LINES = 4000;
const HISTORY_TAIL_LINES = 1500;
const MAX_BRAIN_CONVERSATIONS = 2048;
const PARSED_CACHE_MAX = 256;
const REPO_ROOT_CACHE_MAX = 512;
const ANNOTATION_MAX_BYTES = 4 * 1024;
// Backstop for a background task whose end notice never arrived (a resumed
// conversation, a missed tail): count it no longer than the discovery grace.
const BACKGROUND_TASK_MAX_MS = 60 * 60 * 1000;
const BACKGROUND_TASK_START_RE = /Tool is running as a background task with task id: (\S+)/;
const BACKGROUND_TASK_END_RE = /Task id "([^"]+)" (?:finished|was canceled) with result/g;

const TOOL_SUMMARY_FIELDS = Object.freeze([
  'CommandLine',
  'command',
  'cmd',
  'Path',
  'ScriptPath',
  'file_path',
  'path',
  'query',
  'Role',
  'name',
  'title',
  'Recipient',
  'recipient',
  'Description',
  'description',
  'Prompt',
  'prompt',
  'brief',
  'Message',
  'Content',
]);

const EFFORT_SUFFIX_RE = /-(ultra|max|xhigh|extra-high|extra|high|medium|med|low|minimal|none)$/i;

// agy holds a lock on `presence/<conversation-id>.lock` while the conversation
// is open in a live process; the file itself outlives the process. Linux lists
// held locks in /proc/locks; elsewhere no conversation reads as held.
function readProcLocks() {
  if (process.platform !== 'linux') return '';
  try {
    return fs.readFileSync('/proc/locks', 'utf8');
  } catch {
    return '';
  }
}

function sessionIdFor(convId) {
  return convId ? `${SESSION_PREFIX}${convId}` : '';
}

function rawConvId(sessionId) {
  const value = String(sessionId || '').trim();
  return value.startsWith(SESSION_PREFIX) ? value.slice(SESSION_PREFIX.length) : value;
}

function parseTimestamp(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEffortToken(raw) {
  if (!raw) return null;
  const lower = String(raw).trim().toLowerCase();
  if (!lower) return null;
  if (lower === 'minimal') return 'low';
  if (lower === 'extra-high' || lower === 'extra') return 'xhigh';
  if (lower === 'med') return 'medium';
  if (['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(lower)) return lower;
  return null;
}

/**
 * Extract model id and reasoning effort from either a raw API model slug
 * (e.g. `gemini-4-carbon-high`) or an Antigravity display label
 * (e.g. `Gemini 4 Carbon (High)`).
 */
function parseAntigravityModel(rawModel, fallbackEffort = null) {
  let effort = normalizeEffortToken(fallbackEffort);
  if (!rawModel || typeof rawModel !== 'string') {
    return { model: null, effort };
  }
  let cleaned = rawModel.trim();
  if (!cleaned || cleaned.toLowerCase() === 'none') {
    return { model: null, effort };
  }

  // Display format in settings.json / <USER_SETTINGS_CHANGE>: "Gemini 4 Carbon (High)"
  const parenMatch = cleaned.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (parenMatch) {
    const parsedEffort = normalizeEffortToken(parenMatch[2]);
    if (parsedEffort) {
      effort = parsedEffort;
      cleaned = parenMatch[1].trim();
    }
  }

  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return { model: null, effort };

  const suffixMatch = slug.match(EFFORT_SUFFIX_RE);
  if (suffixMatch) {
    const suffixEffort = normalizeEffortToken(suffixMatch[1]);
    if (suffixEffort) effort = suffixEffort;
    const baseModel = slug.slice(0, slug.length - suffixMatch[0].length);
    return { model: baseModel || slug, effort };
  }

  return { model: slug, effort };
}

function inferUnderlyingProvider(model) {
  const lower = String(model || '').toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('gpt') || lower.includes('codex')) return 'codex';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('glm')) return 'zai';
  if (lower.includes('kimi')) return 'kimi';
  if (lower.includes('grok')) return 'grok';
  return 'gemini';
}

/**
 * Compact `transcript.jsonl` serializes `tool_calls[].args` leaf values as JSON
 * strings (e.g. `"\"git status\""` or `"5000"`), whereas `transcript_full.jsonl`
 * stores native JSON values. Handle both transparently.
 */
function unwrapCompactArg(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || trimmed === 'true'
    || trimmed === 'false'
    || trimmed === 'null'
    || /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeToolArgs(rawArgs) {
  if (!rawArgs) return {};
  let source = rawArgs;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return { raw: source };
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = unwrapCompactArg(value);
  }
  return out;
}

function extractUserSettingsModel(content) {
  if (typeof content !== 'string' || !content.includes('<USER_SETTINGS_CHANGE>')) return null;
  const blockMatch = content.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/i);
  if (!blockMatch) return null;
  const modelMatch = blockMatch[1].match(/`Model Selection`\s+from\s+.*?\s+to\s+([^\n]+?)(?:\.\s*$|\n|$)/i);
  if (!modelMatch) return null;
  return parseAntigravityModel(modelMatch[1].trim().replace(/\.$/, ''));
}

function cleanUserPrompt(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const reqMatches = [...content.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  let text = reqMatches.length > 0
    ? reqMatches[reqMatches.length - 1][1]
    : content
      .replace(/<(?:CONTEXT_SUMMARY|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)\b[^>]*>[\s\S]*?<\/(?:CONTEXT_SUMMARY|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>/gi, '')
      .replace(/^Error:\s*The stream was interrupted\.\s*Please continue the task you were working on\.\s*/i, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text || null;
}

function summarizeAntigravityTool(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  if (toolName === 'run_command' && typeof args.CommandLine === 'string') {
    return stripShellLocationPrefix(args.CommandLine).slice(0, 200);
  }
  if (toolName === 'ask_question' && Array.isArray(args.questions) && args.questions[0]?.question) {
    return String(args.questions[0].question).replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (toolName === 'swarm') {
    const parts = [args.action, args.name || args.title, args.brief].filter(Boolean);
    if (parts.length) return parts.join(' · ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return summarizeToolInput(args, {
    fields: TOOL_SUMMARY_FIELDS,
    basenameFields: ['Path', 'ScriptPath', 'file_path', 'path'],
    maxLength: 160,
  }) || '';
}

function canonicalWorkingSetPath(rawPath, project, readSelector = false) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const cleaned = rawPath.trim().replace(/^file:\/\//, '');
  const resolved = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : (project ? path.resolve(project, cleaned) : null);
  if (!resolved) return null;
  if (project) {
    const normProj = path.resolve(project);
    if (resolved === normProj) return readSelector ? '.' : null;
    if (resolved.startsWith(`${normProj}${path.sep}`)) {
      return resolved.slice(normProj.length + 1).split(path.sep).join('/');
    }
  }
  return resolved;
}

const _repoRootCache = new Map();
function inferProjectRootFromPath(filePath, geminiRoot) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const normalized = path.normalize(filePath);
  if (geminiRoot && (normalized === geminiRoot || normalized.startsWith(`${geminiRoot}${path.sep}`))) {
    return null;
  }
  if (normalized.startsWith('/tmp/') || normalized.startsWith('/proc/') || normalized.startsWith('/sys/')) {
    return null;
  }
  const startDir = path.extname(normalized) ? path.dirname(normalized) : normalized;
  if (_repoRootCache.has(startDir)) return _repoRootCache.get(startDir);

  let current = startDir;
  let found = null;
  for (let depth = 0; depth < 12; depth++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        found = current;
        break;
      }
    } catch {
      break;
    }
    current = parent;
  }
  trimCache(_repoRootCache, REPO_ROOT_CACHE_MAX);
  _repoRootCache.set(startDir, found);
  return found;
}

function mergeStepWindows(windows) {
  const combined = [...(windows?.head || []), ...(windows?.tail || [])];
  const seen = new Set();
  const ordered = [];
  for (const record of combined) {
    if (!record || typeof record !== 'object') continue;
    const key = Number.isInteger(record.step_index)
      ? `idx:${record.step_index}`
      : `${record.created_at || ''}:${record.type || ''}:${ordered.length}`;
    if (seen.has(key)) {
      // Tail carries the newer state of a step (e.g. RUNNING -> DONE).
      const existingPos = ordered.findIndex(item => item._dedupeKey === key);
      if (existingPos >= 0) ordered[existingPos] = { ...record, _dedupeKey: key };
      continue;
    }
    seen.add(key);
    ordered.push({ ...record, _dedupeKey: key });
  }
  ordered.sort((a, b) => {
    if (Number.isInteger(a.step_index) && Number.isInteger(b.step_index)) {
      return a.step_index - b.step_index;
    }
    return parseTimestamp(a.created_at) - parseTimestamp(b.created_at);
  });
  return ordered;
}

function readAnnotationTitle(rootDir, convId) {
  if (!rootDir || !convId) return null;
  const pbtxtPath = path.join(rootDir, 'annotations', `${convId}.pbtxt`);
  const raw = readHeadText(pbtxtPath, ANNOTATION_MAX_BYTES);
  if (!raw) return null;
  const match = raw.match(/title\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  const unescaped = match[1]
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return unescaped || null;
}

function reduceAntigravityTranscript(steps, {
  convId,
  fallbackProject = null,
  fallbackModel = null,
  fallbackEffort = null,
  fallbackPrompt = null,
  fallbackAgentName = null,
  exitedAt = 0,
  fileMtimeMs = 0,
  geminiRoot = null,
} = {}) {
  const sessionId = sessionIdFor(convId);
  const observedSources = emptyObservedSources();
  const dialogueRaw = [];
  const messages = [];
  const toolHistory = [];
  const workingSetRaw = [];
  const observedPaths = [];
  const lastResults = [];
  const commandRecords = [];
  const childLinks = [];
  const sendMessages = [];

  let model = fallbackModel || null;
  let reasoningEffort = normalizeEffortToken(fallbackEffort);
  let lastPrompt = fallbackPrompt ? String(fallbackPrompt).slice(0, 200) : null;
  let lastMessage = null;
  let lastTool = null;
  let lastToolInput = null;
  let promptDetail = null;
  let teamName = null;
  let latestActivity = Number(fileMtimeMs) || 0;
  let latestTranscriptStepTs = 0;
  let turnStartedAt = null;
  let turnEnded = false;
  let turnEndedAt = null;
  let lastTurnDurationMs = null;
  let apiError = null;
  let resultSeq = 0;

  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    turnCount: 0,
    latestContextTokens: 0,
  };

  let pendingQueue = [];
  // The newest step is a swarm_wait result: a crew member that reported and now idles.
  let parked = false;
  // Background run_command tasks (task id → start), open until a system message reports their end.
  const openTasks = new Map();

  for (const step of steps) {
    parked = false;
    const stepTs = parseTimestamp(step.created_at);
    if (stepTs > latestActivity) latestActivity = stepTs;
    if (stepTs > latestTranscriptStepTs) latestTranscriptStepTs = stepTs;

    if (step.type === 'USER_INPUT') {
      const settingsModel = extractUserSettingsModel(step.content);
      if (settingsModel?.model && !model) model = settingsModel.model;
      if (settingsModel?.effort && !reasoningEffort) reasoningEffort = settingsModel.effort;

      const cleanedPrompt = cleanUserPrompt(step.content);
      if (cleanedPrompt) {
        lastPrompt = cleanedPrompt.slice(0, 200);
        messages.push({
          role: 'user',
          text: cleanedPrompt.slice(0, 1200),
          timestamp: stepTs || null,
        });
      }
      turnStartedAt = stepTs || turnStartedAt;
      turnEnded = false;
      turnEndedAt = null;
      apiError = null;
      promptDetail = null;
      pendingQueue = [];
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      apiError = null;
      if (step.model) {
        const parsedModel = parseAntigravityModel(step.model);
        // An executor step keeps the Orchestrator's planner identity, so the
        // villager's sprite and price do not flip every few steps.
        const executorUnderPlanner = ORCHESTRATOR_WORKER_RE.test(parsedModel.model || '')
          && ORCHESTRATOR_MODEL_RE.test(model || '');
        if (parsedModel.model && !executorUnderPlanner) {
          // A different model never inherits the previous model's effort.
          if (parsedModel.model !== model) reasoningEffort = parsedModel.effort;
          else if (parsedModel.effort) reasoningEffort = parsedModel.effort;
          model = parsedModel.model;
        }
      }

      const inTok = Math.max(0, Number(step.input_tokens) || 0);
      const cacheTok = Math.max(0, Number(step.cache_read_tokens) || 0);
      const cacheCreateTok = Math.max(0, Number(step.cache_creation_tokens || step.cache_write_tokens) || 0);
      const outTok = Math.max(0, Number(step.output_tokens) || 0);
      if (inTok > 0 || cacheTok > 0 || cacheCreateTok > 0 || outTok > 0) {
        usage.input += inTok;
        usage.cacheRead += cacheTok;
        usage.cacheCreate += cacheCreateTok;
        usage.output += outTok;
        usage.turnCount += 1;
        usage.latestContextTokens = inTok + cacheTok + cacheCreateTok;
      }

      if (typeof step.thinking === 'string' && step.thinking.trim()) {
        observedSources.thinkingPlaintext = true;
        dialogueRaw.push({
          kind: 'thinking',
          source: 'antigravity.thinking',
          text: step.thinking,
          observedAt: stepTs,
          actionId: `step-${step.step_index}`,
        });
      }

      if (typeof step.content === 'string' && step.content.trim()) {
        observedSources.assistantText = true;
        lastMessage = step.content.trim().slice(0, 400);
        messages.push({
          role: 'assistant',
          text: step.content.trim().slice(0, 1600),
          timestamp: stepTs || null,
        });
        dialogueRaw.push({
          kind: 'assistant',
          source: 'antigravity.content',
          text: step.content,
          observedAt: stepTs,
          actionId: `step-${step.step_index}`,
        });
      }

      pendingQueue = [];
      promptDetail = null;
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length > 0) {
        turnEnded = false;
        turnEndedAt = null;
        for (let idx = 0; idx < calls.length; idx++) {
          const tc = calls[idx];
          if (!tc || typeof tc.name !== 'string') continue;
          const args = normalizeToolArgs(tc.args);
          const summary = summarizeAntigravityTool(tc.name, args);
          lastTool = tc.name;
          lastToolInput = summary || null;
          toolHistory.push({
            tool: tc.name,
            detail: summary || '',
            input: summary || '',
            ts: stepTs || null,
            timestamp: stepTs || null,
          });

          if (typeof args.toolSummary === 'string' && args.toolSummary.trim()) {
            observedSources.toolIntent = true;
            dialogueRaw.push({
              kind: 'intent',
              source: 'antigravity.toolSummary',
              text: args.toolSummary.trim(),
              observedAt: stepTs,
              actionId: `step-${step.step_index}-${idx}`,
            });
          }

          if (tc.name === 'read_file' && typeof args.Path === 'string') {
            observedPaths.push(args.Path);
            workingSetRaw.push({
              path: args.Path,
              op: 'read',
              at: stepTs || null,
              readSelector: args.StartLine != null || args.EndLine != null,
            });
          } else if ((tc.name === 'edit_file' || tc.name === 'write_file') && typeof args.Path === 'string') {
            observedPaths.push(args.Path);
            workingSetRaw.push({
              path: args.Path,
              op: 'write',
              at: stepTs || null,
              readSelector: false,
            });
          } else if (tc.name === 'ask_question') {
            promptDetail = summary || null;
          } else if (tc.name === 'send_message' && args.Recipient) {
            const target = rawConvId(String(args.Recipient)).trim();
            if (target) {
              sendMessages.push({
                recipient: target,
                messageType: 'message',
                summary: typeof args.Message === 'string' ? args.Message.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
                ts: stepTs || latestActivity,
              });
            }
          } else if (tc.name === 'post_message') {
            const msgText = String(args.message || args.content || args.Message || '');
            const mentions = [...msgText.matchAll(/@([a-z0-9][a-z0-9_-]{0,23})\b/gi)].map(m => m[1]);
            for (const target of mentions) {
              sendMessages.push({
                recipient: target.toLowerCase(),
                messageType: 'message',
                summary: msgText.replace(/\s+/g, ' ').trim().slice(0, 80) || null,
                ts: stepTs || latestActivity,
              });
            }
          } else if (tc.name === 'swarm') {
            if (args.action === 'title' && typeof args.title === 'string' && args.title.trim()) {
              teamName = args.title.trim().slice(0, 80);
            }
          }

          pendingQueue.push({
            name: tc.name,
            args,
            summary,
            ts: stepTs || latestActivity,
            stepIndex: step.step_index,
            callIndex: idx,
          });
        }
      } else if (step.status === 'DONE') {
        turnEnded = true;
        turnEndedAt = stepTs || latestActivity;
        if (turnStartedAt && turnEndedAt >= turnStartedAt) {
          lastTurnDurationMs = turnEndedAt - turnStartedAt;
        }
      } else if (step.status === 'ERROR' || step.status === 'CANCELED') {
        turnEnded = true;
        turnEndedAt = stepTs || latestActivity;
      }
      continue;
    }

    if (step.type === 'SYSTEM_MESSAGE') {
      for (const match of String(step.content || '').matchAll(BACKGROUND_TASK_END_RE)) openTasks.delete(match[1]);
      continue;
    }

    if (step.type === 'GENERIC') {
      const taskId = step.status === 'RUNNING' ? String(step.content || '').match(BACKGROUND_TASK_START_RE)?.[1] : null;
      if (taskId) openTasks.set(taskId, stepTs || latestActivity);
      const call = pendingQueue.shift() || null;
      if (!call) continue;
      const content = typeof step.content === 'string' ? step.content : '';

      if (call.name === 'invoke_subagent') {
        const uuids = content.match(UUID_RE) || [];
        const childId = uuids.find(id => id.toLowerCase() !== String(convId).toLowerCase());
        if (childId) {
          childLinks.push({
            childConvId: childId.toLowerCase(),
            parentConvId: String(convId).toLowerCase(),
            agentType: 'sub-agent',
            subagentKind: typeof call.args?.TypeName === 'string' ? call.args.TypeName : 'subagent',
            agentName: typeof call.args?.Role === 'string' && call.args.Role.trim()
              ? call.args.Role.trim().slice(0, 80)
              : null,
          });
        }
      } else if (call.name === 'run_workflow') {
        const uuids = [...new Set((content.match(UUID_RE) || []).map(id => id.toLowerCase()))]
          .filter(id => id !== String(convId).toLowerCase());
        const wfName = typeof call.args?.Description === 'string' && call.args.Description.trim()
          ? call.args.Description.trim().slice(0, 80)
          : (typeof call.args?.ScriptPath === 'string' ? path.basename(call.args.ScriptPath, path.extname(call.args.ScriptPath)) : 'workflow');
        for (const childId of uuids) {
          childLinks.push({
            childConvId: childId,
            parentConvId: String(convId).toLowerCase(),
            agentType: 'workflow-subagent',
            workflowName: wfName,
          });
        }
      } else if (call.name === 'swarm' && call.args?.action === 'add') {
        // `{"status":"added","name":"neon-gpu-core",...,"conversation_id":"<uuid>"}`:
        // the worker's name is the alias `post_message` @mentions address.
        const childId = content.match(/"conversation_id"\s*:\s*"([0-9a-f-]{36})"/i)?.[1]?.toLowerCase();
        const memberName = content.match(/"name"\s*:\s*"([^"\\]{1,80})"/)?.[1]
          || (typeof call.args?.name === 'string' ? call.args.name.trim().slice(0, 80) : null);
        if (childId && childId !== String(convId).toLowerCase()) {
          childLinks.push({
            childConvId: childId,
            parentConvId: String(convId).toLowerCase(),
            agentType: 'sub-agent',
            subagentKind: 'swarm',
            agentName: memberName || null,
          });
        }
      } else if (call.name === 'swarm' && call.args?.action === 'kill' && /"status"\s*:\s*"killed"/.test(content)) {
        const memberName = content.match(/"name"\s*:\s*"([^"\\]{1,80})"/)?.[1] || call.args?.name;
        const link = childLinks.findLast(item => item.subagentKind === 'swarm' && item.agentName === memberName);
        if (link) link.killed = true;
      } else if (call.name === 'swarm_wait') {
        parked = true;
      }

      if (step.status === 'DONE' || step.status === 'ERROR') {
        const exitMatch = content.match(/Command exited with code (\d+)/);
        const exitCode = exitMatch ? Number(exitMatch[1]) : (step.status === 'ERROR' ? 1 : null);
        const exitCodeSource = exitMatch ? 'exit' : (step.status === 'ERROR' ? 'flag' : null);
        const ok = exitCode !== null ? exitCode === 0 : step.status !== 'ERROR';
        const completedAt = stepTs || call.ts || latestActivity;
        if (exitCode !== null && completedAt) {
          const strippedOutput = content
            .replace(/^Created At:.*\r?\n?/gm, '')
            .replace(/^Completed At:.*\r?\n?/gm, '')
            .replace(/^Command exited with code \d+\.?\s*\r?\n?/gm, '')
            .replace(/^Command output:\s*\r?\n?/gm, '')
            .replace(/^No output from the command\.?\s*$/gim, '')
            .trim();
          lastResults.push({
            id: toolResultId({
              provider: 'antigravity',
              sessionId,
              callId: call.stepIndex != null ? `step-${call.stepIndex}-${call.callIndex}` : `${resultSeq++}`,
              tool: call.name,
              detail: call.summary || '',
              completedAt,
            }),
            tool: call.name,
            detail: call.summary || '',
            exitCode,
            exitCodeSource,
            durationMs: call.ts && completedAt >= call.ts ? completedAt - call.ts : null,
            completedAt,
            source: 'transcript',
            location: call.name === 'run_command'
              ? toolResultLocation({
                cwd: typeof call.args?.Cwd === 'string' ? call.args.Cwd : fallbackProject,
                command: call.args?.CommandLine || null,
              })
              : null,
            noOutput: call.name === 'run_command' ? strippedOutput.length === 0 : null,
          });
        }

        if (call.name === 'run_command' && typeof call.args?.CommandLine === 'string') {
          commandRecords.push({
            command: call.args.CommandLine,
            cwd: typeof call.args.Cwd === 'string' ? call.args.Cwd : null,
            timestamp: stepTs || call.ts || latestActivity,
            exitCode,
            isError: !ok,
            output: content,
          });
        }
      }
      if (pendingQueue.length === 0 && promptDetail) {
        promptDetail = null;
      }
      continue;
    }

    if (step.type === 'ERROR_MESSAGE') {
      const errorText = (typeof step.error === 'string' && step.error.trim())
        ? step.error.trim()
        : (typeof step.content === 'string' ? step.content.trim() : '');
      const statusMatch = errorText.match(/\b(429|5\d\d|4\d\d)\b/);
      const status = statusMatch ? Number(statusMatch[1]) : null;
      const kind = status === 429 || /rate.?limit|quota/i.test(errorText)
        ? 'rate_limit'
        : /interrupt|stream/i.test(errorText)
          ? 'stream_error'
          : 'api_error';
      if (pendingQueue.length === 0) {
        turnEnded = true;
        turnEndedAt = stepTs || latestActivity;
        apiError = { kind, status, at: stepTs || latestActivity };
        if (errorText) lastMessage = errorText.slice(0, 400);
      }
      continue;
    }
  }

  let project = normalizeProjectPath(fallbackProject) || null;
  if (!project) {
    for (let i = observedPaths.length - 1; i >= 0; i--) {
      const inferred = inferProjectRootFromPath(observedPaths[i], geminiRoot);
      if (inferred) {
        project = inferred;
        break;
      }
    }
  }

  const resolvedModel = model || 'gemini';
  const underlyingProvider = inferUnderlyingProvider(resolvedModel);

  const workingSet = [];
  const seenPaths = new Set();
  for (let i = workingSetRaw.length - 1; i >= 0 && workingSet.length < 16; i--) {
    const item = workingSetRaw[i];
    const canonical = canonicalWorkingSetPath(item.path, project, item.readSelector);
    if (!canonical || seenPaths.has(canonical)) continue;
    seenPaths.add(canonical);
    workingSet.push({
      path: canonical,
      op: item.op,
      at: item.at,
      source: 'transcript',
    });
  }

  const gitEvents = [];
  for (const cmd of commandRecords) {
    const extracted = extractGitEventsFromCommandSource(
      { command: cmd.command, cwd: cmd.cwd || project },
      {
        sessionId,
        provider: 'antigravity',
        project: project || '',
        cwd: cmd.cwd || project || '',
        timestamp: cmd.timestamp,
        exitCode: cmd.exitCode,
        isError: cmd.isError,
        output: cmd.output,
      },
    );
    if (Array.isArray(extracted) && extracted.length) gitEvents.push(...extracted);
  }
  const dedupedGitEvents = gitEvents.length ? dedupeGitEvents(gitEvents) : [];

  const dialogueCandidates = [];
  for (const raw of dialogueRaw.slice(-24)) {
    const candidate = makeDialogue({
      text: raw.text,
      kind: raw.kind,
      source: raw.source,
      observedAt: raw.observedAt,
      actionId: raw.actionId,
      project,
    });
    if (candidate) dialogueCandidates.push(candidate);
  }

  const tokenUsage = usage.turnCount > 0 ? {
    availability: 'observed',
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreate: usage.cacheCreate,
    cacheWrite: usage.cacheCreate,
    totalInput: usage.input,
    totalOutput: usage.output,
    reasoningTokens: 0,
    reasoningInOutput: underlyingProvider === 'gemini',
    turnCount: usage.turnCount,
    contextWindow: usage.latestContextTokens || (usage.input + usage.cacheRead + usage.cacheCreate),
    contextWindowMax: contextWindowForModel(resolvedModel, 'antigravity') ?? null,
  } : null;

  const pending = pendingQueue[0] || null;
  const resolvedApiError = pending ? null : apiError;
  const turnDescriptor = {
    known: steps.length > 0,
    pendingTool: pending?.name || null,
    pendingSince: pending?.ts || null,
    turnEnded,
    turnEndedAt,
  };
  const sessionEndedAt = exitedAt > 0 && exitedAt >= latestTranscriptStepTs ? exitedAt : null;

  return {
    convId: String(convId).toLowerCase(),
    childLinks,
    dialogueCandidates,
    turnDescriptor,
    parked,
    backgroundTasks: [...openTasks.values()],
    session: {
      sessionId,
      sourceSessionId: String(convId),
      provider: 'antigravity',
      underlyingProvider,
      agentId: String(convId),
      agentType: 'main',
      agentName: fallbackAgentName || null,
      teamName,
      project: project || '',
      model: resolvedModel,
      reasoningEffort: reasoningEffort || null,
      status: 'active',
      lastActivity: latestActivity,
      lastTool,
      lastToolInput,
      lastMessage,
      lastPrompt,
      promptDetail: pending?.name === 'ask_question' ? promptDetail : null,
      dialogue: null,
      observedSources,
      tokenUsage,
      parentSessionId: null,
      rootSessionId: null,
      subagentKind: null,
      signalSource: 'transcript',
      turnStartedAt,
      sessionEndedAt,
      apiError: resolvedApiError,
      lastTurnDurationMs,
      workingSet,
      lastResults: normalizeToolResults(lastResults),
      gitEvents: dedupedGitEvents,
      sendMessages,
    },
    detail: createDetailResponse({
      provider: 'antigravity',
      sessionId,
      project: project || '',
      toolHistory: toolHistory.slice(-120),
      messages: messages.slice(-50),
      tokenUsage,
      gitEvents: dedupedGitEvents,
      underlyingProvider,
    }),
  };
}

function presentReducedEntry(reduced, { now = Date.now(), lineage = null, backgroundPending = null, t3Title = null } = {}) {
  const tokenUsage = reduced.session.tokenUsage ? { ...reduced.session.tokenUsage } : null;
  const dialogue = pickDialogue(reduced.dialogueCandidates, { now });
  const parentConvId = lineage?.parentConvId || null;
  const parentSessionId = lineage?.parentSessionId || (parentConvId ? sessionIdFor(parentConvId) : null);
  const rootSessionId = lineage?.rootConvId ? sessionIdFor(lineage.rootConvId) : parentSessionId;
  // A T3 Code thread the operator renamed is named as T3 Code shows it.
  const agentName = t3Title || reduced.session.agentName || lineage?.agentName || null;
  const project = reduced.session.project || lineage?.parentProject || '';

  return {
    session: {
      ...reduced.session,
      project,
      agentType: lineage?.agentType || reduced.session.agentType,
      agentName,
      userNamed: Boolean(t3Title),
      subagentKind: lineage?.subagentKind || null,
      workflowName: lineage?.workflowName || undefined,
      teamName: reduced.session.teamName || lineage?.teamName || null,
      parentSessionId,
      rootSessionId,
      backgroundPending: backgroundPending || reduced.session.backgroundPending || null,
      tokenUsage,
      observedSources: { ...reduced.session.observedSources },
      workingSet: reduced.session.workingSet.map(item => ({ ...item })),
      lastResults: reduced.session.lastResults.map(item => ({ ...item })),
      gitEvents: reduced.session.gitEvents.slice(),
      sendMessages: reduced.session.sendMessages.slice(-10).map(msg => ({ ...msg })),
      dialogue: dialogue ? { ...dialogue } : null,
      ...deriveTurnState(reduced.turnDescriptor),
    },
    detail: {
      ...reduced.detail,
      project,
      agentName: agentName || undefined,
      tokenUsage,
      toolHistory: reduced.detail.toolHistory.map(item => ({ ...item })),
      messages: reduced.detail.messages.map(item => ({ ...item })),
      gitEvents: reduced.detail.gitEvents.slice(),
    },
  };
}

function t3InstancesDir() {
  return path.join(t3UserDataDir(), 'providers', 'antigravity');
}

// T3 Code starts agy as `agy acp --gemini-dir ~/.t3/userdata/providers/antigravity/<instance>
// --app-data-dir antigravity-acp`, one directory per provider instance.
function t3AcpDirs() {
  const instancesDir = t3InstancesDir();
  let entries;
  try {
    entries = fs.readdirSync(instancesDir, { withFileTypes: true });
  } catch (error) {
    noteReadFailure(error);
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(instancesDir, entry.name, 'antigravity-acp'));
}

// T3 Code's state database names the thread that started each delegate. A run
// attempt records the agent's own conversation id (`nativeThreadId`), the
// delegate thread's lineage names its parent thread, and that thread's latest
// attempt names the parent's own session. Claude and Antigravity parents map
// to a villager id; a delegate of any other parent stays on its own.
const T3_PARENT_PREFIX = { claudeAgent: '', antigravity: SESSION_PREFIX };
const T3_LINEAGE_SQL = `
WITH attempt AS (
  SELECT a.thread_id, a.provider, json_extract(a.payload_json, '$.nativeThreadId') AS native,
    ROW_NUMBER() OVER (PARTITION BY a.thread_id ORDER BY r.ordinal DESC, a.attempt_ordinal DESC) AS rank
  FROM orchestration_v2_projection_run_attempts a
  JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
  WHERE json_extract(a.payload_json, '$.nativeThreadId') IS NOT NULL
)
SELECT lower(child.native) AS conv, t.title AS title, parent.provider AS parentProvider, parent.native AS parentNative
FROM attempt child
JOIN orchestration_v2_projection_threads t ON t.thread_id = child.thread_id
JOIN attempt parent ON parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId') AND parent.rank = 1
WHERE child.provider = 'antigravity'
  AND lower(child.native) IN (SELECT value FROM json_each(?))
`;

function readT3Lineage(convIds) {
  const links = new Map();
  if (convIds.length === 0) return links;
  for (const row of queryT3State(T3_LINEAGE_SQL, JSON.stringify(convIds))) {
    const prefix = T3_PARENT_PREFIX[row.parentProvider];
    if (prefix === undefined || typeof row.parentNative !== 'string' || !row.parentNative) continue;
    links.set(row.conv, {
      parentSessionId: `${prefix}${row.parentNative}`,
      title: typeof row.title === 'string' ? row.title.trim().slice(0, 128) || null : null,
    });
  }
  return links;
}

class AntigravityAdapter {
  constructor(options = {}) {
    this.name = 'Antigravity';
    this.provider = 'antigravity';
    this._explicitRoot = Boolean(options.rootDir || process.env.CLAUDEVILLE_ANTIGRAVITY_DIR);
    this.homeDir = path.resolve(
      options.rootDir
      || process.env.CLAUDEVILLE_ANTIGRAVITY_DIR
      || path.join(os.homedir(), '.gemini', 'antigravity-cli'),
    );
    this._geminiRoot = path.dirname(this.homeDir);
    this.now = options.now || (() => Date.now());
    this.readLocks = options.readLocks || readProcLocks;
    this._parsedCache = new Map();
    this._convFileIndex = new Map();
    this._metadataCache = new Map();
    this._t3Links = new Map();
    this._perf = {
      scans: 0,
      cacheHits: 0,
      cacheMisses: 0,
      detailLookups: 0,
    };
  }

  _surfaceDirs() {
    if (this._explicitRoot) return [this.homeDir];
    const geminiDir = path.join(os.homedir(), '.gemini');
    return [...new Set([
      this.homeDir,
      path.join(geminiDir, 'antigravity'),
      path.join(geminiDir, 'antigravity-ide'),
      ...t3AcpDirs(),
    ])];
  }

  isAvailable() {
    return this._surfaceDirs().some((dir) => {
      try {
        return fs.existsSync(dir);
      } catch (error) {
        noteReadFailure(error);
        return false;
      }
    });
  }

  _readSurfaceMetadata(rootDir) {
    const historyPath = path.join(rootDir, 'history.jsonl');
    const lastConvPath = path.join(rootDir, 'cache', 'last_conversations.json');
    const convMetaPath = path.join(rootDir, 'cache', 'conversation_metadata.json');
    const settingsPath = path.join(rootDir, 'settings.json');
    const annotationsDir = path.join(rootDir, 'annotations');

    const sig = [
      fileSignature(historyPath),
      fileSignature(lastConvPath),
      fileSignature(convMetaPath),
      fileSignature(settingsPath),
      fileSignature(annotationsDir),
    ].join('|');

    const cached = this._metadataCache.get(rootDir);
    if (
      cached
      && cached.sig === sig
      && (!cached.watchedFiles || cached.watchedFiles.every(([filePath, prevSig]) => fileSignature(filePath) === prevSig))
    ) {
      return cached.data;
    }

    const byConvId = new Map();
    const ensure = (id) => {
      const originalId = String(id || '').trim();
      const key = originalId.toLowerCase();
      if (!key) return null;
      if (!byConvId.has(key)) {
        byConvId.set(key, {
          originalId,
          workspace: null,
          display: null,
          displayTs: 0,
          metaModifiedMs: 0,
          hasExplicitRename: false,
          renameFallback: null,
          renameTs: 0,
          agentName: null,
          exitedAt: 0,
        });
      }
      return byConvId.get(key);
    };

    // 1. settings.json default model/effort
    let defaultModel = null;
    let defaultEffort = null;
    const settingsText = readHeadText(settingsPath, 64 * 1024);
    if (settingsText) {
      try {
        const parsed = JSON.parse(settingsText);
        const res = parseAntigravityModel(parsed?.model, parsed?.effort);
        defaultModel = res.model;
        defaultEffort = res.effort;
      } catch {
        // Ignore malformed settings.json
      }
    }

    // 2. cache/last_conversations.json: { "<workspace>": "<convId>" }
    const lastConvText = readHeadText(lastConvPath, 256 * 1024);
    if (lastConvText) {
      try {
        const parsed = JSON.parse(lastConvText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [workspace, convId] of Object.entries(parsed)) {
            if (typeof convId !== 'string') continue;
            const rec = ensure(convId);
            if (rec && workspace) rec.workspace = workspace;
          }
        }
      } catch {
        // Ignore malformed cache file
      }
    }

    // 3. history.jsonl: { timestamp, workspace, conversationId, type, display }
    // Slash commands never advance activity timestamps; `/rename` opts the
    // conversation into reading its annotation title and `/exit` records end.
    // `/clear` keeps the same conversation id, so it is not an end.
    if (fs.existsSync(historyPath)) {
      const entries = readJsonLines(historyPath, { count: HISTORY_TAIL_LINES, source: 'antigravity' });
      for (const entry of entries) {
        if (!entry || typeof entry.conversationId !== 'string') continue;
        const rec = ensure(entry.conversationId);
        if (!rec) continue;
        const ts = parseTimestamp(entry.timestamp);
        const workspace = typeof entry.workspace === 'string' && entry.workspace.trim()
          ? entry.workspace.trim()
          : '';
        const display = typeof entry.display === 'string' ? entry.display.trim() : '';
        const isSlash = entry.type === 'slash_command' || display.startsWith('/');

        if (isSlash) {
          if (!rec.workspace && workspace) rec.workspace = workspace;
          const renameMatch = display.match(/^\/rename(?:\s+(.*))?$/i);
          if (renameMatch && ts >= rec.renameTs) {
            rec.hasExplicitRename = true;
            rec.renameTs = ts;
            rec.renameFallback = (renameMatch[1] || '').trim().slice(0, 80) || null;
          } else if (/^\/(?:exit|quit)(?:\s|$)/i.test(display) && ts > rec.exitedAt) {
            rec.exitedAt = ts;
          }
          continue;
        }

        if (ts >= rec.displayTs) {
          rec.displayTs = ts;
          if (workspace) rec.workspace = workspace;
          if (display) rec.display = display;
        } else if (!rec.workspace && workspace) {
          rec.workspace = workspace;
        }
      }
    }

    // 4. cache/conversation_metadata.json
    const convMetaText = readHeadText(convMetaPath, 512 * 1024);
    if (convMetaText) {
      try {
        const parsed = JSON.parse(convMetaText);
        const convs = parsed?.conversations;
        if (convs && typeof convs === 'object') {
          for (const [convId, meta] of Object.entries(convs)) {
            const rec = ensure(convId);
            if (!rec || !meta || typeof meta !== 'object') continue;
            const modTs = parseTimestamp(meta.last_modified_time);
            if (modTs > rec.metaModifiedMs) rec.metaModifiedMs = modTs;
          }
        }
      } catch {
        // Ignore malformed metadata cache
      }
    }

    // 5. Explicit `/rename` annotation titles (ignore auto-generated titles).
    const watchedFiles = [];
    for (const rec of byConvId.values()) {
      if (!rec.hasExplicitRename) continue;
      const pbtxtPath = path.join(annotationsDir, `${rec.originalId}.pbtxt`);
      watchedFiles.push([pbtxtPath, fileSignature(pbtxtPath)]);
      const title = readAnnotationTitle(rootDir, rec.originalId);
      rec.agentName = title || rec.renameFallback || null;
    }

    const data = { byConvId, defaultModel, defaultEffort };
    this._metadataCache.set(rootDir, { sig, watchedFiles, data });
    return data;
  }

  _heldConversations() {
    // Holders only (a `->` waiter line has no pid in that column), matched by
    // inode alone: a btrfs subvolume stats to another device than /proc/locks prints.
    const lockedInodes = new Set(
      [...this.readLocks().matchAll(/^\d+:\s+\S+\s+\S+\s+\S+\s+-?\d+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/gm)].map(m => m[1]),
    );
    const held = new Set();
    if (lockedInodes.size === 0) return held;
    for (const rootDir of this._surfaceDirs()) {
      const presenceDir = path.join(rootDir, 'presence');
      let names;
      try {
        names = fs.readdirSync(presenceDir);
      } catch (error) {
        noteReadFailure(error);
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.lock')) continue;
        try {
          if (lockedInodes.has(String(fs.statSync(path.join(presenceDir, name)).ino))) {
            held.add(name.slice(0, -'.lock'.length).toLowerCase());
          }
        } catch (error) {
          noteReadFailure(error);
        }
      }
    }
    return held;
  }

  _resolveTranscriptPath(brainDir, convId) {
    const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
    const compact = path.join(logsDir, 'transcript.jsonl');
    if (fs.existsSync(compact)) return compact;
    const full = path.join(logsDir, 'transcript_full.jsonl');
    if (fs.existsSync(full)) return full;
    return null;
  }

  _readConversation(convId, transcriptPath, meta, { detail = false } = {}) {
    let stat;
    try {
      stat = fs.statSync(transcriptPath);
    } catch (error) {
      noteReadFailure(error);
      return null;
    }
    const cacheKey = `${transcriptPath}::${detail ? 'detail' : 'summary'}`;
    const sig = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      meta?.workspace || '',
      meta?.display || '',
      meta?.agentName || '',
      meta?.exitedAt || 0,
      meta?.metaModifiedMs || 0,
      meta?.defaultModel || '',
      meta?.defaultEffort || '',
    ].join(':');

    const cached = this._parsedCache.get(cacheKey);
    if (cached && cached.sig === sig) {
      this._perf.cacheHits += 1;
      return cached.reduced;
    }
    this._perf.cacheMisses += 1;

    const head = readJsonLines(transcriptPath, {
      from: 'start',
      count: HEAD_LINES,
      source: 'antigravity',
    });
    const tail = readJsonLines(transcriptPath, {
      from: 'end',
      count: detail ? DETAIL_TAIL_LINES : TAIL_LINES,
      source: 'antigravity',
    });
    const steps = mergeStepWindows({ head, tail });
    const reduced = reduceAntigravityTranscript(steps, {
      convId,
      fallbackProject: meta?.workspace || null,
      fallbackModel: meta?.defaultModel || null,
      fallbackEffort: meta?.defaultEffort || null,
      fallbackPrompt: meta?.display || null,
      fallbackAgentName: meta?.agentName || null,
      exitedAt: meta?.exitedAt || 0,
      fileMtimeMs: Math.max(stat.mtimeMs, meta?.metaModifiedMs || 0),
      geminiRoot: this._geminiRoot,
    });

    trimCache(this._parsedCache, PARSED_CACHE_MAX);
    this._parsedCache.set(cacheKey, { sig, reduced });
    this._convFileIndex.set(String(convId).toLowerCase(), {
      transcriptPath,
      rootDir: meta?.rootDir || this.homeDir,
    });
    return reduced;
  }

  _collectReducedConversations(activeThresholdMs = null) {
    const now = this.now();
    const reducedByConvId = new Map();
    const parentGraceMs = activeThresholdMs != null
      ? Math.max(Number(activeThresholdMs) * 4, 60 * 60 * 1000)
      : null;
    const held = activeThresholdMs != null ? this._heldConversations() : new Set();
    const candidates = [];

    for (const rootDir of this._surfaceDirs()) {
      if (!fs.existsSync(rootDir)) continue;
      const surfaceMeta = this._readSurfaceMetadata(rootDir);
      const brainDir = path.join(rootDir, 'brain');
      if (!fs.existsSync(brainDir)) continue;

      let entries;
      try {
        entries = fs.readdirSync(brainDir, { withFileTypes: true });
      } catch (error) {
        noteReadFailure(error);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const convId = entry.name;
        const lowerId = convId.toLowerCase();
        // Subagent and swarm conversations are `is_internal` in agy's metadata
        // cache; they are real agents, so they stay visible.
        const convMeta = surfaceMeta.byConvId.get(lowerId) || null;

        const transcriptPath = this._resolveTranscriptPath(brainDir, convId);
        if (!transcriptPath) continue;

        let stat;
        try {
          stat = fs.statSync(transcriptPath);
        } catch (error) {
          noteReadFailure(error);
          continue;
        }

        const effectiveMtime = Math.max(stat.mtimeMs, convMeta?.metaModifiedMs || 0);
        if (parentGraceMs != null && now - effectiveMtime > parentGraceMs && !held.has(lowerId)) continue;
        candidates.push({
          rootDir,
          surfaceMeta,
          convId,
          lowerId,
          convMeta,
          transcriptPath,
          effectiveMtime,
        });
      }
    }

    candidates.sort((a, b) => b.effectiveMtime - a.effectiveMtime);
    for (const candidate of candidates.slice(0, MAX_BRAIN_CONVERSATIONS)) {
      const {
        rootDir,
        surfaceMeta,
        convId,
        lowerId,
        convMeta,
        transcriptPath,
      } = candidate;
      const reduced = this._readConversation(convId, transcriptPath, {
        rootDir,
        workspace: convMeta?.workspace || null,
        display: convMeta?.display || null,
        agentName: convMeta?.agentName || null,
        exitedAt: convMeta?.exitedAt || 0,
        metaModifiedMs: convMeta?.metaModifiedMs || 0,
        defaultModel: surfaceMeta.defaultModel,
        defaultEffort: surfaceMeta.defaultEffort,
      });
      if (reduced && reduced.session.lastActivity > 0) {
        const prev = reducedByConvId.get(lowerId);
        if (!prev || reduced.session.lastActivity >= prev.session.lastActivity) {
          reducedByConvId.set(lowerId, reduced);
        }
      }
    }

    // Build parent -> child lineage map across discovered conversations.
    const lineageByChild = new Map();
    for (const reduced of reducedByConvId.values()) {
      for (const link of reduced.childLinks) {
        lineageByChild.set(link.childConvId, {
          ...link,
          parentProject: reduced.session.project || '',
          teamName: reduced.session.teamName || null,
        });
      }
    }
    // Compute transitive rootConvId (bounded depth).
    for (const [childId, info] of lineageByChild) {
      let root = info.parentConvId;
      const visited = new Set([childId]);
      for (let d = 0; d < 8 && root && lineageByChild.has(root) && !visited.has(root); d++) {
        visited.add(root);
        root = lineageByChild.get(root).parentConvId;
      }
      info.rootConvId = root;
      const rootEntry = root ? reducedByConvId.get(root) : null;
      if (!info.parentProject && rootEntry?.session?.project) {
        info.parentProject = rootEntry.session.project;
      }
    }

    // A T3 Code delegate's parent is the T3 thread that started it, often on
    // another provider. A delegate's parent never changes, so a found link is kept.
    const t3Instances = `${t3InstancesDir()}${path.sep}`;
    const t3Ids = candidates
      .filter(c => c.rootDir.startsWith(t3Instances) && reducedByConvId.has(c.lowerId))
      .map(c => c.lowerId);
    const t3ConvIds = t3Ids.filter(id => !lineageByChild.has(id));
    for (const [id, link] of readT3Lineage(t3ConvIds.filter(id => !this._t3Links.has(id)))) {
      this._t3Links.set(id, link);
    }
    trimCache(this._t3Links, 4096);
    for (const id of t3ConvIds) {
      const link = this._t3Links.get(id);
      if (!link) continue;
      lineageByChild.set(id, {
        parentSessionId: link.parentSessionId,
        agentName: link.title,
        agentType: 'sub-agent',
        subagentKind: 'delegate',
      });
    }
    // Renames can come at any time, so they are read on every scan.
    const t3Titles = readT3RenamedTitles('antigravity', t3Ids);

    const activeIds = new Set();
    const taskStartsById = new Map();
    for (const [id, reduced] of reducedByConvId) {
      // A long think, a long command or a swarm_wait writes no step. A
      // conversation its live agy process holds stays, idle at the prompt too. A
      // crew member of one that is neither killed nor parked stays while its turn
      // is open or a background task it started still runs; the discovery grace
      // above still bounds a member.
      const lineage = lineageByChild.get(id);
      const live = held.has(id) || (held.has(lineage?.rootConvId) && !lineage.killed && !reduced.parked);
      const taskStarts = live ? reduced.backgroundTasks.filter(at => now - at < BACKGROUND_TASK_MAX_MS) : [];
      if (taskStarts.length > 0) taskStartsById.set(id, taskStarts);
      if (activeThresholdMs == null || now - reduced.session.lastActivity <= Number(activeThresholdMs)) {
        activeIds.add(id);
        continue;
      }
      const { turnState } = live ? deriveTurnState(reduced.turnDescriptor) : {};
      if (held.has(id) || turnState === 'working' || turnState === 'tool_pending' || taskStarts.length > 0) activeIds.add(id);
    }
    // Keep parent/ancestor conversations visible while any descendant is active.
    for (const id of [...activeIds]) {
      let cur = lineageByChild.get(id)?.parentConvId || null;
      for (let d = 0; d < 8 && cur; d++) {
        if (reducedByConvId.has(cur)) activeIds.add(cur);
        cur = lineageByChild.get(cur)?.parentConvId || null;
      }
    }

    const activeChildrenByParent = new Map();
    for (const childId of activeIds) {
      const lineage = lineageByChild.get(childId);
      const childReduced = reducedByConvId.get(childId);
      if (!lineage?.parentConvId || !childReduced || childReduced.session.sessionEndedAt) continue;
      const childTurnState = deriveTurnState(childReduced.turnDescriptor).turnState;
      if (childTurnState === 'awaiting_input') continue;
      if (!activeChildrenByParent.has(lineage.parentConvId)) {
        activeChildrenByParent.set(lineage.parentConvId, []);
      }
      activeChildrenByParent.get(lineage.parentConvId).push(childReduced);
    }

    const sessions = [];
    for (const id of activeIds) {
      const reduced = reducedByConvId.get(id);
      if (!reduced) continue;
      const liveChildren = activeChildrenByParent.get(id) || [];
      const taskStarts = taskStartsById.get(id) || [];
      const starts = [...liveChildren.map(c => c.session.turnStartedAt || c.session.lastActivity), ...taskStarts];
      const backgroundPending = starts.length > 0
        ? {
          count: starts.length,
          kinds: [...(liveChildren.length > 0 ? ['agent'] : []), ...(taskStarts.length > 0 ? ['bash'] : [])],
          since: Math.min(...starts),
        }
        : null;
      const presented = presentReducedEntry(reduced, {
        now,
        lineage: lineageByChild.get(id) || null,
        backgroundPending,
        t3Title: t3Titles.get(id) || null,
      });
      sessions.push(presented.session);
    }

    sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    return { sessions, reducedByConvId, lineageByChild };
  }

  getActiveSessions(activeThresholdMs = 2 * 60 * 1000) {
    this._perf.scans += 1;
    return this._collectReducedConversations(activeThresholdMs).sessions;
  }

  getAllSessions() {
    this._perf.scans += 1;
    return this._collectReducedConversations(null).sessions;
  }

  getSessionDetail(sessionId, project) {
    this._perf.detailLookups += 1;
    const convId = rawConvId(sessionId);
    const lowerId = convId.toLowerCase();
    const empty = () => createDetailResponse({
      provider: this.provider,
      sessionId,
      project: project || '',
    });
    if (!convId) return empty();

    let indexed = this._convFileIndex.get(lowerId) || null;
    if (!indexed || !fs.existsSync(indexed.transcriptPath)) {
      for (const rootDir of this._surfaceDirs()) {
        const brainDir = path.join(rootDir, 'brain');
        const transcriptPath = this._resolveTranscriptPath(brainDir, convId);
        if (transcriptPath) {
          indexed = { transcriptPath, rootDir };
          this._convFileIndex.set(lowerId, indexed);
          break;
        }
      }
    }
    if (!indexed) return empty();

    const surfaceMeta = this._readSurfaceMetadata(indexed.rootDir);
    const convMeta = surfaceMeta.byConvId.get(lowerId) || null;
    const reduced = this._readConversation(convId, indexed.transcriptPath, {
      rootDir: indexed.rootDir,
      workspace: convMeta?.workspace || project || null,
      display: convMeta?.display || null,
      agentName: convMeta?.agentName || null,
      exitedAt: convMeta?.exitedAt || 0,
      metaModifiedMs: convMeta?.metaModifiedMs || 0,
      defaultModel: surfaceMeta.defaultModel,
      defaultEffort: surfaceMeta.defaultEffort,
    }, { detail: true });

    if (!reduced) return empty();
    const presented = presentReducedEntry(reduced, { now: this.now() });
    if (project && !presented.detail.project) presented.detail.project = project;
    return presented.detail;
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    for (const rootDir of this._surfaceDirs()) {
      if (!fs.existsSync(rootDir)) continue;
      paths.push({
        type: 'directory',
        path: rootDir,
        filters: ['history.jsonl', 'settings.json'],
        scope: 'discovery',
        kind: 'discovery',
      });
      const brainDir = path.join(rootDir, 'brain');
      if (fs.existsSync(brainDir)) {
        paths.push({
          type: 'directory',
          path: brainDir,
          scope: 'discovery',
          kind: 'discovery',
        });
      }
      const cacheDir = path.join(rootDir, 'cache');
      if (fs.existsSync(cacheDir)) {
        paths.push({
          type: 'directory',
          path: cacheDir,
          filters: ['.json'],
          scope: 'discovery',
          kind: 'metadata',
        });
      }
      const annotationsDir = path.join(rootDir, 'annotations');
      if (fs.existsSync(annotationsDir)) {
        paths.push({
          type: 'directory',
          path: annotationsDir,
          filters: ['.pbtxt'],
          scope: 'discovery',
          kind: 'metadata',
        });
      }
    }

    for (const session of sessions) {
      if (session?.provider && session.provider !== this.provider) continue;
      const lowerId = rawConvId(session.sessionId).toLowerCase();
      const indexed = this._convFileIndex.get(lowerId);
      if (!indexed?.transcriptPath || !fs.existsSync(indexed.transcriptPath)) continue;
      const logsDir = path.dirname(indexed.transcriptPath);
      const dirtyTarget = { sessionId: session.sessionId, project: session.project };
      if (fs.existsSync(logsDir)) {
        paths.push({
          type: 'directory',
          path: logsDir,
          filters: ['.jsonl'],
          scope: 'active',
          kind: 'transcript',
          probe: true,
          activity: session.lastActivity,
          ...dirtyTarget,
        });
      }
      paths.push({
        type: 'file',
        path: indexed.transcriptPath,
        scope: 'active',
        kind: 'transcript',
        probe: true,
        activity: session.lastActivity,
        ...dirtyTarget,
      });
    }

    return paths;
  }

  invalidateCaches() {
    this._parsedCache.clear();
    this._metadataCache.clear();
  }

  invalidateCachesForDirty(dirty = {}) {
    if (!dirty || !dirty.path || dirty.kind === 'reconcile') {
      this.invalidateCaches();
      return;
    }
    const target = path.resolve(dirty.path);
    if (target.endsWith('.json') || target.endsWith('history.jsonl') || target.endsWith('.pbtxt')) {
      this._metadataCache.clear();
    }
    for (const key of [...this._parsedCache.keys()]) {
      const filePath = key.split('::')[0];
      if (filePath === target || filePath.startsWith(`${target}${path.sep}`)) {
        this._parsedCache.delete(key);
        deleteTailState(filePath);
      }
    }
  }

  getPerfStats() {
    return {
      ...this._perf,
      parsedEntries: this._parsedCache.size,
      indexedConversations: this._convFileIndex.size,
      metadataRoots: this._metadataCache.size,
    };
  }
}

module.exports = {
  AntigravityAdapter,
  cleanUserPrompt,
  parseAntigravityModel,
  reduceAntigravityTranscript,
};
