/**
 * DeepSeek agent adapter (deepseek-cc-mcp)
 * Data source: ~/.local/state/deepseek-cc-mcp/ (DEEPSEEK_CC_STATE_DIR)
 *
 * DeepSeek's API is only a model, with no agent CLI of its own. The
 * deepseek-cc-mcp server runs every agent as an async loop inside its own
 * process, so nothing reaches a CLI session store; its state directory is
 * the only record:
 *
 *   journal.jsonl                   job events (queued / started / finished),
 *                                   framed `\n{…}\n`, shared by every server
 *   jobs/<job_id>/mission.txt       the prompt the caller sent
 *   jobs/<job_id>/transcript.jsonl  one record per model call and per finished
 *                                   tool call, appended live
 *   jobs/<job_id>/msg.txt           the final message, once finished
 *   threads/<thread_id>.json        the whole conversation, rewritten after
 *                                   every turn
 *
 * One thread is one villager: `continue` runs another job on the same thread.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MODEL_REVISION } = require('../src/config/models.generated.cjs');
const { deriveTurnState } = require('./turnState');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const {
  createDetailResponse,
  noteReadFailure,
  readByteRangeText,
  readHeadText,
  readJsonLines,
  statCacheKey,
  summarizeToolInput,
  trimCache,
} = require('./shared');

const STATE_DIR = process.env.CLAUDEVILLE_DEEPSEEK_STATE_DIR
  || process.env.DEEPSEEK_CC_STATE_DIR
  || path.join(os.homedir(), '.local', 'state', 'deepseek-cc-mcp');
const JOURNAL_FILE = path.join(STATE_DIR, 'journal.jsonl');
const JOBS_DIR = path.join(STATE_DIR, 'jobs');
const THREADS_DIR = path.join(STATE_DIR, 'threads');

// Ids the server mints (`<prefix>_<base36 ms>_<8 hex>`); anything else in the
// journal never becomes a path.
const JOB_ID = /^ds_[a-z0-9]+_[0-9a-f]{8}$/;
const THREAD_ID = /^dsth_[a-z0-9]+_[0-9a-f]{8}$/;

// Every other journal line is blank, so this is ~4000 jobs.
const JOURNAL_TAIL_LINES = 8000;
const JOURNAL_TAIL_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_TAIL_LINES = 2000;
const THREAD_TAIL_BYTES = 512 * 1024;
const MISSION_HEAD_BYTES = 4096;
const CACHE_MAX = 256;
const DETAIL_TOOL_LIMIT = 15;
const DETAIL_MESSAGE_LIMIT = 5;
const FAILED_STATUSES = new Set(['failed', 'timeout']);

// The server's tools copy Claude Code's names; its transcript keeps only the
// one argument `brief()` picked, so the tool name says which field it was.
const TOOL_ARG_FIELDS = Object.freeze({
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
  WebSearch: 'query',
  WebFetch: 'url',
});

let _journal = { key: null, threads: new Map() };
const _threadTails = new Map();
const _missions = new Map();

function jobFile(jobId, name) {
  return path.join(JOBS_DIR, jobId, name);
}

function mtimeOf(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// ─── Journal ────────────────────────────────────────────

function foldJournal() {
  const jobs = new Map();
  const records = readJsonLines(JOURNAL_FILE, {
    count: JOURNAL_TAIL_LINES,
    tailMaxBytes: JOURNAL_TAIL_BYTES,
    source: 'deepseek',
  });
  for (const record of records) {
    const jobId = record?.job_id;
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) continue;
    let job = jobs.get(jobId);
    if (!job) {
      job = { jobId, threadId: null, model: null, effort: null, cwd: null, workspace: null, label: null };
      jobs.set(jobId, job);
    }
    // `started` and `finished` name the thread as `session_id`; a `continue`
    // names it as `thread_id` already when queued.
    const threadId = record.session_id || record.thread_id;
    if (typeof threadId === 'string' && THREAD_ID.test(threadId)) job.threadId = threadId;
    if (record.model) job.model = String(record.model);
    if (record.effort) job.effort = String(record.effort);
    if (record.cwd) job.cwd = String(record.cwd);
    if (record.label) job.label = String(record.label);
    if (record.event === 'started') {
      job.startedAt = finiteOrNull(record.ts);
      job.ownerPid = finiteOrNull(record.owner_pid);
      job.ownerStart = typeof record.owner_start === 'string' ? record.owner_start : null;
      job.workspace = record.worktree ? String(record.worktree) : job.cwd;
    } else if (record.event === 'finished') {
      job.finishedAt = finiteOrNull(record.ts);
      job.status = String(record.status || '');
      job.errorKind = record.error_kind ? String(record.error_kind) : null;
      job.durationMs = record.duration_s == null ? null : finiteOrNull(record.duration_s * 1000);
      job.usage = record.usage && typeof record.usage === 'object' ? record.usage : null;
    }
  }

  const threads = new Map();
  for (const job of jobs.values()) {
    if (!job.threadId || !job.startedAt) continue;
    if (!threads.has(job.threadId)) threads.set(job.threadId, []);
    threads.get(job.threadId).push(job);
  }
  for (const threadJobs of threads.values()) threadJobs.sort((a, b) => a.startedAt - b.startedAt);
  return threads;
}

function readThreads() {
  let key;
  try {
    key = statCacheKey(JOURNAL_FILE, fs.statSync(JOURNAL_FILE));
  } catch {
    return new Map();
  }
  if (_journal.key !== key) _journal = { key, threads: foldJournal() };
  return _journal.threads;
}

// ─── Liveness ───────────────────────────────────────────

// The server's own rule (jobs.ts `pidAlive`): a job without a `finished`
// record runs only while its server does, and a pid is that server only when
// its Linux start time (field 22 of /proc/<pid>/stat) still matches.
function pidStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function ownerAlive(job) {
  if (!Number.isInteger(job.ownerPid) || job.ownerPid <= 0) return false;
  try {
    process.kill(job.ownerPid, 0);
  } catch {
    // ESRCH: gone. EPERM: another user's process, so not the server.
    return false;
  }
  if (!job.ownerStart) return true;
  const start = pidStartTime(job.ownerPid);
  return start === null || start === job.ownerStart;
}

// ─── Job transcript ─────────────────────────────────────

function readTranscript(job) {
  const records = readJsonLines(jobFile(job.jobId, 'transcript.jsonl'), {
    count: TRANSCRIPT_TAIL_LINES,
    source: 'deepseek',
  });
  const fold = {
    tools: [],
    pendingTool: null,
    pendingSince: null,
    usage: { input: 0, cacheRead: 0, output: 0, reasoning: 0, turns: 0, costUsd: null },
    contextTokens: 0,
  };
  let open = null;
  let lastAt = job.startedAt;
  for (const record of records) {
    // `t_ms` counts from the agent loop's start, a few ms after `started`.
    const at = job.startedAt + (Number(record?.t_ms) || 0);
    if (record?.type === 'model') {
      const prompt = Number(record.prompt_tokens) || 0;
      const hit = Number(record.cache_hit) || 0;
      fold.usage.input += Math.max(0, prompt - hit);
      fold.usage.cacheRead += hit;
      fold.usage.output += Number(record.output_tokens) || 0;
      fold.usage.reasoning += Number(record.reasoning_tokens) || 0;
      fold.usage.turns += 1;
      // The job's running total, not this call's.
      fold.usage.costUsd = finiteOrNull(record.cost_usd);
      fold.contextTokens = prompt;
      open = Array.isArray(record.tools) && record.tools.length ? { tools: record.tools, done: 0 } : null;
      lastAt = at;
    } else if (record?.type === 'tool' && record.name) {
      fold.tools.push({ tool: String(record.name), args: typeof record.args === 'string' ? record.args : '', at });
      if (open) open.done += 1;
      lastAt = at;
    }
  }
  // A turn's calls run one after another and each is logged when it ends, so
  // the first unlogged one is running now.
  if (open && open.done < open.tools.length) {
    fold.pendingTool = String(open.tools[open.done]);
    fold.pendingSince = lastAt;
  }
  return fold;
}

function toolInput(job, tool, args) {
  const field = TOOL_ARG_FIELDS[tool];
  if (!field) return args;
  let value = args;
  if (field === 'file_path' && job.workspace && value.startsWith(`${job.workspace}/`)) {
    value = value.slice(job.workspace.length + 1);
  }
  return { [field]: value };
}

function toolSummary(job, tool, args, options) {
  return summarizeToolInput(toolInput(job, tool, args), { compactWhitespace: true, ...options });
}

// ─── Thread tail ────────────────────────────────────────

// The thread is one JSON object whose last key is `messages`, often megabytes
// long. Inside a JSON string every quote is escaped, so these bytes only ever
// open a message: the last assistant message parses out of the file's tail.
const ASSISTANT_START = '{"role":"assistant"';
const MESSAGE_START = '{"role":"';

function readThreadTail(threadId) {
  const filePath = path.join(THREADS_DIR, `${threadId}.json`);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const key = statCacheKey(filePath, stat);
  const cached = _threadTails.get(threadId);
  if (cached?.key === key) return cached.tail;

  let tail = null;
  try {
    const start = Math.max(0, stat.size - THREAD_TAIL_BYTES);
    const { text } = readByteRangeText(filePath, start, stat.size - start);
    const open = text.lastIndexOf(ASSISTANT_START);
    if (open !== -1) {
      const next = text.indexOf(MESSAGE_START, open + 1);
      // Messages are joined by a bare comma; the last one closes the array.
      const close = next === -1 ? text.lastIndexOf(']') : next - 1;
      const message = JSON.parse(text.slice(open, close));
      tail = {
        at: stat.mtimeMs,
        content: typeof message.content === 'string' ? message.content.trim() : '',
        reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '',
      };
    }
  } catch (error) {
    if (error?.code) noteReadFailure(error);
  }
  _threadTails.delete(threadId);
  _threadTails.set(threadId, { key, tail });
  trimCache(_threadTails, CACHE_MAX);
  return tail;
}

function readMission(jobId) {
  if (_missions.has(jobId)) return _missions.get(jobId);
  const text = readHeadText(jobFile(jobId, 'mission.txt'), MISSION_HEAD_BYTES).trim();
  const mission = text ? text.slice(0, 200) : null;
  _missions.set(jobId, mission);
  trimCache(_missions, CACHE_MAX);
  return mission;
}

// ─── Session assembly ───────────────────────────────────

function threadUsage(jobs, latest, latestFold) {
  const usage = {
    availability: 'observed',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalInput: 0,
    totalOutput: 0,
    // DeepSeek's completion_tokens already include reasoning tokens.
    reasoningTokens: 0,
    reasoningInOutput: true,
    contextWindow: latestFold.contextTokens,
    turnCount: 0,
  };
  let costUsd = 0;
  for (const job of jobs) {
    if (job.usage) {
      usage.input += Number(job.usage.input_cache_miss_tokens) || 0;
      usage.cacheRead += Number(job.usage.input_cache_hit_tokens) || 0;
      usage.output += Number(job.usage.output_tokens) || 0;
      usage.reasoningTokens += Number(job.usage.reasoning_tokens) || 0;
      usage.turnCount += Number(job.usage.model_calls) || 0;
      costUsd += Number(job.usage.cost_usd) || 0;
      continue;
    }
    // Unfinished: the journal has no totals yet, the transcript does.
    const fold = job === latest ? latestFold : readTranscript(job);
    usage.input += fold.usage.input;
    usage.cacheRead += fold.usage.cacheRead;
    usage.output += fold.usage.output;
    usage.reasoningTokens += fold.usage.reasoning;
    usage.turnCount += fold.usage.turns;
    costUsd += fold.usage.costUsd || 0;
  }
  usage.totalInput = usage.input;
  usage.totalOutput = usage.output;
  return { usage, costUsd };
}

function buildSession(threadId, jobs, { now, activeThresholdMs }) {
  const job = jobs[jobs.length - 1];
  const live = !job.finishedAt && ownerAlive(job);
  const lastActivity = job.finishedAt || Math.max(job.startedAt, mtimeOf(jobFile(job.jobId, 'transcript.jsonl')));
  // A live job stays however quiet it is: a non-streaming model call or a
  // long build writes nothing until it ends.
  if (!live && now - lastActivity > activeThresholdMs) return null;

  const fold = readTranscript(job);
  const sessionId = `deepseek-${threadId}`;
  const project = job.cwd || null;
  const failed = FAILED_STATUSES.has(job.status);
  const turn = job.finishedAt
    ? deriveTurnState({ turnEnded: true, turnEndedAt: job.finishedAt })
    // No `finished` record and no server: it stopped, and nothing says how.
    : live ? deriveTurnState({ pendingTool: fold.pendingTool, pendingSince: fold.pendingSince })
      : deriveTurnState({ known: false });
  const lastCall = fold.tools[fold.tools.length - 1] || null;
  const pending = turn.pendingTool;
  const { usage, costUsd } = threadUsage(jobs, job, fold);

  const observedSources = emptyObservedSources();
  const candidates = [];
  const tail = readThreadTail(threadId);
  if (tail?.reasoning) {
    observedSources.thinkingPlaintext = true;
    candidates.push(makeDialogue({ text: tail.reasoning, kind: 'thinking', source: 'deepseek.reasoning', observedAt: tail.at, project }));
  }
  if (tail?.content) {
    observedSources.assistantText = true;
    candidates.push(makeDialogue({ text: tail.content, kind: 'assistant', source: 'deepseek.content', observedAt: tail.at, project }));
  }

  return {
    sessionId,
    provider: 'deepseek',
    agentId: threadId,
    agentType: 'main',
    agentName: [...jobs].reverse().find(item => item.label)?.label || null,
    model: job.model || 'deepseek',
    reasoningEffort: job.effort,
    status: 'active',
    lastActivity,
    project,
    // The pending call is the current one; its argument is logged only when it ends.
    lastTool: pending || lastCall?.tool || null,
    lastToolInput: pending ? null : (lastCall ? toolSummary(job, lastCall.tool, lastCall.args, { maxLength: 60 }) : null),
    lastMessage: tail?.content ? tail.content.slice(0, 80) : null,
    lastPrompt: readMission(job.jobId),
    ...turn,
    turnStartedAt: job.startedAt,
    lastTurnDurationMs: job.durationMs ?? null,
    // The server's own failure record: the turn is over, in error.
    apiError: failed ? { kind: job.errorKind || job.status, status: null, at: job.finishedAt } : null,
    dialogue: pickDialogue(candidates.filter(Boolean), { now }),
    observedSources,
    tokenUsage: usage,
    cost: {
      usd: costUsd,
      availability: 'observed',
      source: 'provider',
      rateMatch: null,
      rateRevision: MODEL_REVISION,
      unknownModel: false,
    },
    parentSessionId: null,
  };
}

// ─── Adapter class ──────────────────────────────────────

class DeepSeekAdapter {
  get name() { return 'DeepSeek MCP'; }
  get provider() { return 'deepseek'; }
  get homeDir() { return STATE_DIR; }

  isAvailable() {
    return fs.existsSync(STATE_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const now = Date.now();
    const sessions = [];
    for (const [threadId, jobs] of readThreads()) {
      const session = buildSession(threadId, jobs, { now, activeThresholdMs });
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    const threadId = String(sessionId || '').replace(/^deepseek-/, '');
    const jobs = readThreads().get(threadId);
    if (!jobs) return createDetailResponse({ sessionId, project });

    const toolHistory = [];
    for (const job of [...jobs].reverse()) {
      const calls = readTranscript(job).tools.map(call => ({
        tool: call.tool,
        detail: toolSummary(job, call.tool, call.args, { maxLength: 80, basenameFields: [], missingValue: '' }),
        ts: call.at,
      }));
      toolHistory.unshift(...calls);
      if (toolHistory.length >= DETAIL_TOOL_LIMIT) break;
    }

    const messages = [];
    for (const job of jobs) {
      const mission = readMission(job.jobId);
      if (mission) messages.push({ role: 'user', text: mission, ts: job.startedAt });
      const final = job.finishedAt ? readHeadText(jobFile(job.jobId, 'msg.txt'), MISSION_HEAD_BYTES).trim() : '';
      if (final) messages.push({ role: 'assistant', text: final.slice(0, 200), ts: job.finishedAt });
    }

    const latest = jobs[jobs.length - 1];
    return createDetailResponse({
      sessionId,
      project,
      toolHistory: toolHistory.slice(-DETAIL_TOOL_LIMIT),
      messages: messages.slice(-DETAIL_MESSAGE_LIMIT),
      tokenUsage: threadUsage(jobs, latest, readTranscript(latest)).usage,
    });
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    if (fs.existsSync(STATE_DIR)) {
      paths.push({ type: 'directory', path: STATE_DIR, filters: ['journal.jsonl'], scope: 'discovery', kind: 'discovery' });
    }
    if (fs.existsSync(JOURNAL_FILE)) {
      paths.push({ type: 'file', path: JOURNAL_FILE, scope: 'discovery', kind: 'discovery', probe: true });
    }
    const threads = _journal.threads;
    for (const session of sessions) {
      const jobs = threads.get(String(session.sessionId || '').replace(/^deepseek-/, ''));
      const job = jobs?.[jobs.length - 1];
      if (!job || job.finishedAt) continue;
      const transcript = jobFile(job.jobId, 'transcript.jsonl');
      if (!fs.existsSync(transcript)) continue;
      paths.push({
        type: 'file',
        path: transcript,
        scope: 'active',
        kind: 'transcript',
        probe: true,
        activity: session.lastActivity,
        sessionId: session.sessionId,
        project: session.project,
      });
    }
    return paths;
  }
}

module.exports = { DeepSeekAdapter };
