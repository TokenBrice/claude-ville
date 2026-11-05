/**
 * GLM agent adapter (glm-cc-mcp)
 * Data source: ~/.local/state/glm-cc-mcp/ (GLM_CC_STATE_DIR)
 *
 * The glm-cc-mcp server runs every GLM agent as a headless Claude Code
 * (`claude -p` against z.AI's Anthropic-compatible endpoint) in a jail whose
 * CLAUDE_CONFIG_DIR is private to the thread, so no transcript reaches
 * ~/.claude. Its state directory is the only record:
 *
 *   journal.jsonl                    job events (queued / started / finished /
 *                                    cancelled), framed `\n{…}\n`, shared by
 *                                    every server
 *   jobs/<job_id>/mission.txt        the prompt the caller sent
 *   threads/<thread_id>.json         the thread: Claude Code's session id and
 *                                    the cwd it runs in
 *   threads/<thread_id>/home/projects/<cwd slug>/<session>.jsonl
 *                                    Claude Code's own transcript, appended live
 *
 * One thread is one villager: `continue` resumes the same Claude Code session.
 * The journal says whether a job runs, ended or failed; the transcript is read
 * with the Claude adapter's own path-based readers.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { claudeTranscript } = require('./claude');
const { deriveTurnState } = require('./turnState');
const {
  createDetailResponse,
  mcpJobOwnerAlive,
  noteReadFailure,
  readHeadText,
  readJsonLines,
  statCacheKey,
  trimCache,
} = require('./shared');

const STATE_DIR = process.env.CLAUDEVILLE_GLM_STATE_DIR
  || process.env.GLM_CC_STATE_DIR
  || path.join(os.homedir(), '.local', 'state', 'glm-cc-mcp');
const JOURNAL_FILE = path.join(STATE_DIR, 'journal.jsonl');
const JOBS_DIR = path.join(STATE_DIR, 'jobs');
const THREADS_DIR = path.join(STATE_DIR, 'threads');

// Ids the server mints (`<prefix>_<base36 ms>_<8 hex>`); anything else in the
// journal never becomes a path.
const JOB_ID = /^glm_[a-z0-9]+_[0-9a-f]{8}$/;
const THREAD_ID = /^glmth_[a-z0-9]+_[0-9a-f]{8}$/;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every other journal line is blank, so this is ~4000 jobs.
const JOURNAL_TAIL_LINES = 8000;
const JOURNAL_TAIL_BYTES = 4 * 1024 * 1024;
const MISSION_HEAD_BYTES = 4096;
const CACHE_MAX = 256;
const END_EVENTS = new Set(['finished', 'cancelled']);
const FAILED_STATUSES = new Set(['failed', 'timeout']);

let _journal = { key: null, threads: new Map() };
const _threadFiles = new Map();
const _missions = new Map();

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

function threadIdOf(sessionId) {
  return String(sessionId || '').replace(/^zai-/, '');
}

// ─── Journal ────────────────────────────────────────────

function foldJournal() {
  const jobs = new Map();
  const records = readJsonLines(JOURNAL_FILE, {
    count: JOURNAL_TAIL_LINES,
    tailMaxBytes: JOURNAL_TAIL_BYTES,
    source: 'glm',
  });
  for (const record of records) {
    const jobId = record?.job_id;
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) continue;
    let job = jobs.get(jobId);
    if (!job) {
      job = { jobId, threadId: null, model: null, effort: null, cwd: null, workspace: null, label: null };
      jobs.set(jobId, job);
    }
    // `started` and the end record name the thread as `session_id`; a
    // `continue` names it as `thread_id` already when queued.
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
    } else if (END_EVENTS.has(record.event)) {
      job.endedAt = finiteOrNull(record.ts);
      job.status = String(record.status || record.event);
      job.errorKind = record.error_kind ? String(record.error_kind) : null;
      job.durationMs = record.duration_s == null ? null : finiteOrNull(record.duration_s * 1000);
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

// ─── Thread transcript ──────────────────────────────────

// The thread file names Claude Code's session and the cwd it runs in (a
// worktree when the job asked for one), which together place the transcript.
function transcriptFile(threadId) {
  const threadFile = path.join(THREADS_DIR, `${threadId}.json`);
  let key;
  try {
    key = statCacheKey(threadFile, fs.statSync(threadFile));
  } catch {
    return null;
  }
  const cached = _threadFiles.get(threadId);
  let file = cached?.key === key ? cached.file : undefined;
  if (file === undefined) {
    file = null;
    try {
      const thread = JSON.parse(fs.readFileSync(threadFile, 'utf8'));
      if (SESSION_UUID.test(thread?.claude_session) && typeof thread.cwd === 'string' && thread.cwd) {
        file = path.join(
          THREADS_DIR, threadId, 'home', 'projects',
          claudeTranscript.encodeProjectDir(thread.cwd),
          `${thread.claude_session}.jsonl`,
        );
      }
    } catch (error) {
      if (error?.code) noteReadFailure(error);
    }
    _threadFiles.delete(threadId);
    _threadFiles.set(threadId, { key, file });
    trimCache(_threadFiles, CACHE_MAX);
  }
  // The thread home is the one place a jailed agent may write: read only a
  // regular file there, never a link it planted.
  try {
    return file && fs.lstatSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function readMission(jobId) {
  if (_missions.has(jobId)) return _missions.get(jobId);
  const text = readHeadText(path.join(JOBS_DIR, jobId, 'mission.txt'), MISSION_HEAD_BYTES).trim();
  const mission = text ? text.slice(0, 200) : null;
  _missions.set(jobId, mission);
  trimCache(_missions, CACHE_MAX);
  return mission;
}

// ─── Session assembly ───────────────────────────────────

function buildSession(threadId, jobs, { now, activeThresholdMs }) {
  const job = jobs[jobs.length - 1];
  const live = !job.endedAt && mcpJobOwnerAlive(job);
  const file = transcriptFile(threadId);
  const lastActivity = job.endedAt || Math.max(job.startedAt, file ? mtimeOf(file) : 0);
  // A live job stays however quiet it is: a long model call or build writes
  // nothing until it ends.
  if (!live && now - lastActivity > activeThresholdMs) return null;

  const sessionId = `zai-${threadId}`;
  const project = job.workspace || null;
  const summary = claudeTranscript.summary(file, project);
  const model = summary.model || job.model || 'glm';
  const projection = claudeTranscript.projection(file, project, model);
  // Claude Code prices a GLM model it does not know; the registry's z.AI rate
  // estimates the cost instead.
  delete projection.cost;
  delete projection.estimatedCost;
  let turn;
  if (job.endedAt) {
    turn = { ...deriveTurnState({ turnEnded: true, turnEndedAt: job.endedAt }), turnStartedAt: job.startedAt };
  } else if (!live) {
    // No end record and no server: it stopped, and nothing says how.
    turn = { ...deriveTurnState({ known: false }), turnStartedAt: job.startedAt };
  } else {
    turn = claudeTranscript.turnState(file, null, now);
    // The server says the job runs; before Claude Code's first answer the
    // transcript cannot.
    if (turn.turnState === 'unknown') turn = { ...deriveTurnState({}), turnStartedAt: job.startedAt };
  }
  const failed = FAILED_STATUSES.has(job.status);

  return {
    ...projection,
    ...turn,
    sessionId,
    provider: 'zai',
    agentId: threadId,
    agentType: 'main',
    agentName: [...jobs].reverse().find(item => item.label)?.label || null,
    headless: true,
    model,
    reasoningEffort: job.effort,
    status: 'active',
    lastActivity,
    project,
    lastTool: summary.lastTool,
    lastToolInput: summary.lastToolInput,
    lastMessage: summary.lastMessage,
    lastPrompt: projection.lastPrompt || readMission(job.jobId),
    turnStartedAt: turn.turnStartedAt || job.startedAt,
    lastTurnDurationMs: job.durationMs ?? projection.lastTurnDurationMs ?? null,
    // The server's own failure record closes the turn in error.
    apiError: failed
      ? { kind: job.errorKind || job.status, status: null, at: job.endedAt }
      : (job.endedAt ? null : turn.apiError || null),
    dialogue: summary.dialogue,
    observedSources: summary.observedSources,
    tokenUsage: file ? claudeTranscript.tokenUsage(file, model) : null,
    lastResults: claudeTranscript.toolResults(file, sessionId),
    gitEvents: file ? claudeTranscript.gitEvents(file, { provider: 'zai', sessionId, project }) : [],
    parentSessionId: null,
  };
}

// ─── Adapter class ──────────────────────────────────────

class GlmAdapter {
  get name() { return 'GLM MCP'; }
  get provider() { return 'zai'; }
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
    const threadId = threadIdOf(sessionId);
    const file = readThreads().has(threadId) ? transcriptFile(threadId) : null;
    if (!file) return createDetailResponse({ sessionId, project });
    return createDetailResponse({
      sessionId,
      project,
      toolHistory: claudeTranscript.toolHistory(file),
      messages: claudeTranscript.recentMessages(file),
      tokenUsage: claudeTranscript.tokenUsage(file),
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
      const threadId = threadIdOf(session.sessionId);
      const jobs = threads.get(threadId);
      const job = jobs?.[jobs.length - 1];
      if (!job || job.endedAt) continue;
      const file = transcriptFile(threadId);
      if (!file) continue;
      paths.push({
        type: 'file',
        path: file,
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

module.exports = { GlmAdapter };
