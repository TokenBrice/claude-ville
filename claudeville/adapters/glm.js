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
 * with the Claude adapter's own path-based readers, by its pathname — but the
 * pathname is validated on every use (the exact expected path under the
 * resolved state root, a regular file, no symlink anywhere on the chain) and
 * every single read is bracketed by a dev/ino check that fails closed and
 * purges the shared caches. Nothing a jailed agent plants in the thread home
 * — the one directory it may write — can steer a read anywhere else, except
 * by winning a double swap around one read: a known, accepted risk (display
 * only, local, and it must beat both checks of that one bracket).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { claudeTranscript } = require('./claude');
const { deriveTurnState, toEpochMs } = require('./turnState');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { normalizeToolResults, toolResultId, toolResultLocation } = require('./toolResults');
const {
  dedupeGitEvents,
  extractGitEventsFromCommandSource,
  normalizeProjectPath,
} = require('./gitEvents');
const {
  cleanT3UserPrompt,
  projectT3Todos,
  readT3AcpGlmSessionDetail,
  readT3AcpGlmSessions,
  readT3ActiveDelegates,
  t3StateDbExists,
} = require('./t3code');
const {
  createDetailResponse,
  recentMcpJobs,
  mcpJobOwnerAlive,
  noteReadFailure,
  readByteRangeText,
  readHeadText,
  readJsonLines,
  statCacheKey,
  stateFileStat,
  sameStateVersion,
  stripShellLocationPrefix,
  summarizeToolInput,
  deleteTailState,
  trimCache,
} = require('./shared');
const { contextWindowForModel } = require('../src/config/models.generated.cjs');

const STATE_DIR = process.env.CLAUDEVILLE_GLM_STATE_DIR
  || process.env.GLM_CC_STATE_DIR
  || path.join(os.homedir(), '.local', 'state', 'glm-cc-mcp');
const JOURNAL_FILE = path.join(STATE_DIR, 'journal.jsonl');
const JOBS_DIR = path.join(STATE_DIR, 'jobs');
const THREADS_DIR = path.join(STATE_DIR, 'threads');
const ACP_JSON_MAX_BYTES = 16 * 1024 * 1024;
const ACP_EXIT_CODE_RE = /(?:^|\n)Exit code:\s*(\d+)\b/i;

function acpGlmSessionDir() {
  return process.env.CLAUDEVILLE_GLM_ACP_SESSION_DIR
    || path.join(os.homedir(), '.local', 'state', 'glm-acp-agent', 'sessions');
}

const ACP_GLM_SESSION_DIR = acpGlmSessionDir();

// Ids the server mints (`<prefix>_<base36 ms>_<8 hex>`); anything else in the
// journal never becomes a path.
const JOB_ID = /^glm_[a-z0-9]+_[0-9a-f]{8}$/;
const THREAD_ID = /^glmth_[a-z0-9]+_[0-9a-f]{8}$/;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every other journal line is blank, so this is ~4000 jobs.
const JOURNAL_TAIL_LINES = 8000;
const JOURNAL_TAIL_BYTES = 4 * 1024 * 1024;
// A fold consumes journal appends through a byte-offset cursor so terminal
// records reach retained jobs even when the tail window has already rolled
// past them; a burst larger than this is consumed over successive folds.
const JOURNAL_APPEND_MAX_BYTES = 4 * 1024 * 1024;
const JOURNAL_GUARD_BYTES = 256;
// Seeking the journal's last complete newline must see past any one record,
// so the search window is far larger than the guard it returns.
const JOURNAL_SEEK_BYTES = 64 * 1024;
const MISSION_HEAD_BYTES = 4096;
// A thread file names a session id and a cwd — a few hundred bytes. 64 KiB is
// two orders of headroom, and anything larger is rejected unread instead of
// stalling the scan.
const METADATA_MAX_BYTES = 64 * 1024;
const CACHE_MAX = 256;
// A job the journal window no longer reaches stays retained until it is past
// any active window the server asks for (server.js: 2 minutes).
const RETAINED_COMPLETED_MS = 10 * 60 * 1000;
const END_EVENTS = new Set(['finished', 'cancelled']);
const FAILED_STATUSES = new Set(['failed', 'timeout', 'crashed']);

let _journal = { key: null, threads: new Map(), jobs: new Map(), cursor: null };
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

// Applying a journal record is idempotent — every field is a plain assignment
// from the record's own payload — so the append cursor and the tail window can
// both fold the same record without double counting.
function applyJournalRecord(jobs, record) {
  const jobId = record?.job_id;
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return;
  let job = jobs.get(jobId);
  if (!job) {
    job = { jobId, threadId: null, model: null, effort: null, cwd: null, workspace: null, label: null };
    jobs.set(jobId, job);
  }
  // `started` and the end record name the thread as `session_id`; a
  // `continue` names it as `thread_id` already when queued.
  const threadId = record.session_id || record.thread_id;
  if (typeof threadId === 'string' && THREAD_ID.test(threadId)) job.threadId = threadId;
  if (record.kind === 'ask' || record.kind === 'continue') job.kind = record.kind;
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

// The records appended since the cursor, read from the guarded byte offset.
// Rotation (a different inode), truncation (a shorter file) or a rewritten
// prefix (a guard mismatch) returns null: the caller can trust no byte offset
// and recovers from the journal's start. A cursor of size zero with an empty
// guard consumes from the start, so the same path serves that recovery.
// A burst larger than JOURNAL_APPEND_MAX_BYTES is consumed oldest-first over
// successive folds, so no terminal record is skipped.
function consumeJournalAppends(cursor, stat) {
  if (!cursor
    || stat.dev !== cursor.dev
    || stat.ino !== cursor.ino
    || stat.size < cursor.size) return null;
  const end = Math.min(stat.size, cursor.size + JOURNAL_APPEND_MAX_BYTES);
  const guardStart = cursor.size - cursor.guard.length;
  try {
    const window = readByteRangeText(JOURNAL_FILE, guardStart, end - guardStart);
    if (window.bytesRead !== end - guardStart) return null;
    if (!window.buffer.subarray(0, cursor.guard.length).equals(cursor.guard)) return null;
    const appended = window.buffer.subarray(cursor.size - guardStart);
    const lastNewline = appended.lastIndexOf(10);
    if (lastNewline === -1) return { records: [], cursor };
    const complete = appended.subarray(0, lastNewline + 1);
    const records = [];
    for (const line of complete.toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch { /* a torn line stays for the next fold */ }
    }
    const size = cursor.size + complete.length;
    // The window buffer is relative to guardStart, so both guard offsets are
    // absolute-minus-guardStart; the guard is a copy of the final consumed
    // bytes, so it does not pin the whole read window in memory.
    const endOffset = size - guardStart;
    return {
      records,
      cursor: {
        dev: stat.dev,
        ino: stat.ino,
        size,
        guard: Buffer.from(window.buffer.subarray(Math.max(0, endOffset - JOURNAL_GUARD_BYTES), endOffset)),
      },
    };
  } catch {
    return null;
  }
}

// The initial cursor: everything before this offset is the first fold's
// business (the tail window), only later appends are consumed incrementally.
// It parks at the last complete newline — an incompletely written final
// record stays unread, so its closing newline delivers the whole record.
function journalCursorAt(stat) {
  const start = Math.max(0, stat.size - JOURNAL_SEEK_BYTES);
  try {
    const window = readByteRangeText(JOURNAL_FILE, start, stat.size - start);
    if (window.bytesRead !== stat.size - start) return null;
    const buffer = window.buffer;
    const end = buffer.length > 0 && buffer[buffer.length - 1] === 10
      ? buffer.length
      : buffer.lastIndexOf(10) + 1;
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: start + end,
      guard: Buffer.from(buffer.subarray(Math.max(0, end - JOURNAL_GUARD_BYTES), end)),
    };
  } catch {
    return null;
  }
}

// The bounded tail (~4,000 jobs) is not the whole journal: a long-running
// thread's records fall out of it while the job still runs. A fold therefore
// starts from the jobs the previous fold retained — an unfinished one while
// its server lives (the shared liveness rule), a finished one until it is
// past any active window — folds what was appended since the last fold
// through the cursor, and folds the current window over all of it. Rotation,
// truncation or a rewritten prefix (the cursor's guard no longer matches)
// invalidate every byte offset, so recovery re-consumes the journal from its
// start through the same bounded path; records no longer in the file cannot
// be misattributed because retained state is keyed by job id and applying a
// record is idempotent.
function foldJournal(retained, cursor, stat) {
  const jobs = new Map();
  const now = Date.now();
  for (const previous of retained.values()) {
    const keep = previous.endedAt != null
      ? now - previous.endedAt <= RETAINED_COMPLETED_MS
      : mcpJobOwnerAlive(previous);
    if (keep) jobs.set(previous.jobId, { ...previous });
  }
  let consumed = cursor ? consumeJournalAppends(cursor, stat) : null;
  if (cursor && !consumed) {
    // No offset survived: consume the journal again from its start.
    consumed = consumeJournalAppends({ dev: stat.dev, ino: stat.ino, size: 0, guard: Buffer.alloc(0) }, stat);
  }
  const windowRecords = readJsonLines(JOURNAL_FILE, {
    count: JOURNAL_TAIL_LINES,
    tailMaxBytes: JOURNAL_TAIL_BYTES,
    source: 'glm',
  });
  const records = consumed ? consumed.records.concat(windowRecords) : windowRecords;
  for (const record of records) applyJournalRecord(jobs, record);

  const threads = new Map();
  for (const job of jobs.values()) {
    if (!job.threadId || !job.startedAt) continue;
    if (!threads.has(job.threadId)) threads.set(job.threadId, []);
    threads.get(job.threadId).push(job);
  }
  for (const threadJobs of threads.values()) threadJobs.sort((a, b) => a.startedAt - b.startedAt);
  return { threads, jobs, cursor: consumed ? consumed.cursor : journalCursorAt(stat) };
}

function readThreads() {
  const stat = stateFileStat(path.resolve(JOURNAL_FILE));
  if (!stat) return new Map();
  const key = statCacheKey(JOURNAL_FILE, stat);
  const cursor = _journal.cursor;
  // A fold consumes appends in bounded chunks, so after a burst larger than
  // one chunk the cursor still lags an otherwise unchanged journal: keep
  // folding while complete unread records remain, not only on stat changes.
  const behind = Boolean(cursor && cursor.dev === stat.dev && cursor.ino === stat.ino && cursor.size < stat.size);
  if (_journal.key !== key || behind) {
    const folded = foldJournal(_journal.jobs, cursor, stat);
    const after = stateFileStat(path.resolve(JOURNAL_FILE));
    if (!sameStateVersion(stat, after)) {
      deleteTailState(JOURNAL_FILE);
      return _journal.threads;
    }
    _journal = { key, ...folded };
  }
  return _journal.threads;
}

// ─── Thread transcript ──────────────────────────────────

// The state root as the kernel resolves it. Everything below it is written by
// the GLM server; the only jail-writable part of it is a thread's home.
let _stateRoot = null;
function stateRoot() {
  if (!_stateRoot) {
    try {
      _stateRoot = fs.realpathSync(STATE_DIR);
    } catch {
      return STATE_DIR;
    }
  }
  return _stateRoot;
}

// The thread file names Claude Code's session and the cwd it runs in (a
// worktree when the job asked for one), which together place the transcript.
// It is server-written, but it is still read defensively: a link or a device
// planted where it belongs is never opened, a regular file only, and never
// more than METADATA_MAX_BYTES — an oversized file is rejected unread and a
// type swap between lstat and open cannot block (O_NONBLOCK).
function readThreadMetadata(threadFile, lstat) {
  if (!lstat.isFile() || lstat.size > METADATA_MAX_BYTES) return null;
  let fd;
  try {
    fd = fs.openSync(threadFile, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, METADATA_MAX_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } catch (error) {
    if (error?.code) noteReadFailure(error);
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// ─── Transcript validation ──────────────────────────────

// The file must be, right now, exactly the expected regular file: `lstat`
// must report a regular inode where the transcript belongs (a link or a
// device planted there is never read), and the fully resolved path must
// equal the expected path, so no symlink sits anywhere on the chain — the
// thread home is jail-writable, so any link below the state root is planted.
function transcriptIdentityAt(file) {
  try {
    const lstat = fs.lstatSync(file);
    if (!lstat.isFile()) return null;
    if (fs.realpathSync(file) !== file) return null;
    return { dev: lstat.dev, ino: lstat.ino };
  } catch {
    return null;
  }
}

// A transcript becomes a validated target: the exact expected path under the
// resolved state root, checked on every use. Nothing about the target is
// cached across uses, so a transcript created or replaced since the last scan
// is discovered (or rejected) on the next one.
function transcriptTarget(threadId, thread) {
  const file = path.join(
    stateRoot(), 'threads', threadId, 'home', 'projects',
    claudeTranscript.encodeProjectDir(thread.cwd),
    `${thread.claude_session}.jsonl`,
  );
  const identity = transcriptIdentityAt(file);
  if (!identity) {
    // Rejection here never reaches readTranscript's brackets, so the purge
    // both of those branches perform happens now: a link or non-regular file
    // planted where the transcript belongs must not keep the cached data and
    // pending scans of the pathname it displaced.
    claudeTranscript.invalidate(file);
    return null;
  }
  return { file, dev: identity.dev, ino: identity.ino };
}

// Only the parsed thread metadata is cached; the transcript it names is
// validated on every use, so a file created or replaced since the last scan
// is discovered (or rejected) on the next one.
function transcriptFile(threadId) {
  const threadFile = path.join(THREADS_DIR, `${threadId}.json`);
  let lstat;
  let key;
  try {
    lstat = fs.lstatSync(threadFile);
    key = statCacheKey(threadFile, lstat);
  } catch {
    return null;
  }
  const cached = _threadFiles.get(threadId);
  let thread = cached?.key === key ? cached.thread : undefined;
  if (thread === undefined) {
    thread = readThreadMetadata(threadFile, lstat);
    _threadFiles.delete(threadId);
    _threadFiles.set(threadId, { key, thread });
    trimCache(_threadFiles, CACHE_MAX);
  }
  if (!(SESSION_UUID.test(thread?.claude_session) && typeof thread.cwd === 'string' && thread.cwd)) return null;
  return transcriptTarget(threadId, thread);
}

// The readers take the transcript's pathname, and every single read is
// bracketed: the file's dev/ino must equal the validated identity immediately
// before and after the reader runs. A mismatch means the path was swapped
// around the read, so the read never happened — its result is dropped, every
// Claude cache entry keyed by the path is purged synchronously (a pending
// async scan for it can no longer publish), and the caller sees the readers'
// own no-file behaviour. Residual risk, known and accepted: an attacker who
// swaps the transcript aside and restores the real file inside the reader's
// own open wins that one race — the outside content is displayed, and until
// the transcript next changes it may keep being served from the shared cache
// it entered. It is display-only, local (the jailed agent has no network and
// cannot read the browser), and it must beat both checks of a single bracket;
// every read the bracket rejects is purged and never published.
function readTranscript(target, read) {
  if (!target) return read(null);
  const file = target.file;
  const intact = (identity) => identity && identity.dev === target.dev && identity.ino === target.ino;
  if (!intact(transcriptIdentityAt(file))) {
    claudeTranscript.invalidate(file);
    return read(null);
  }
  let result;
  try {
    result = read(file);
  } catch {
    return read(null);
  }
  if (!intact(transcriptIdentityAt(file))) {
    claudeTranscript.invalidate(file);
    return read(null);
  }
  return result;
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
  // A completed job's last activity is its end record, so its expiry is
  // decided before the thread's metadata or transcript is ever read.
  if (job.endedAt != null && now - job.endedAt > activeThresholdMs) return null;
  const live = !job.endedAt && mcpJobOwnerAlive(job);
  const target = transcriptFile(threadId);
  const file = target ? target.file : null;
  const lastActivity = job.endedAt || Math.max(job.startedAt, file ? mtimeOf(file) : 0);
  // A live job stays however quiet it is: a long model call or build writes
  // nothing until it ends.
  if (!live && now - lastActivity > activeThresholdMs) return null;

  const sessionId = `zai-${threadId}`;
  const project = job.workspace || null;
  const summary = readTranscript(target, f => claudeTranscript.summary(f, project));
  const model = summary.model || job.model || 'glm';
  const projection = readTranscript(target, f => claudeTranscript.projection(f, project, model, 'zai'));
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
    turn = readTranscript(target, f => claudeTranscript.turnState(f, null, now));
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
    tokenUsage: target ? readTranscript(target, f => claudeTranscript.tokenUsage(f, model, 'zai')) : null,
    lastResults: readTranscript(target, f => claudeTranscript.toolResults(f, sessionId)),
    gitEvents: target ? readTranscript(target, f => claudeTranscript.gitEvents(f, { provider: 'zai', sessionId, project })) : [],
    subagentKind: 'mcp',
    parentSessionId: null,
  };
}

// ─── Standalone ACP GLM JSON sessions ──────────────────

const _acpJsonCache = new Map();

function safeJsonParse(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function canonicalAcpPath(rawPath, project) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const cleaned = rawPath.trim().replace(/^file:\/\//, '');
  const resolved = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : (project ? path.resolve(project, cleaned) : cleaned);
  if (project) {
    const normProj = path.resolve(project);
    if (resolved === normProj) return null;
    if (resolved.startsWith(`${normProj}${path.sep}`)) {
      return resolved.slice(normProj.length + 1).split(path.sep).join('/');
    }
  }
  return resolved;
}

function parseAcpToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    const parsed = safeJsonParse(rawArgs);
    return parsed && typeof parsed === 'object' ? parsed : { raw: rawArgs };
  }
  return {};
}

function readStandaloneAcpJsonFile(filePath, lstat) {
  if (!lstat?.isFile() || lstat.size <= 0 || lstat.size > ACP_JSON_MAX_BYTES) return null;
  const key = statCacheKey(filePath, lstat);
  const cached = _acpJsonCache.get(filePath);
  if (cached?.key === key) {
    _acpJsonCache.delete(filePath);
    _acpJsonCache.set(filePath, cached);
    return cached.parsed;
  }

  let data = null;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > ACP_JSON_MAX_BYTES) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    data = JSON.parse(buffer.toString('utf8', 0, offset));
  } catch (error) {
    if (error?.code && !['ENOENT', 'ENOTDIR'].includes(error.code)) noteReadFailure(error);
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  const parsed = reduceStandaloneAcpJson(filePath, data, lstat.mtimeMs);
  _acpJsonCache.delete(filePath);
  _acpJsonCache.set(filePath, { key, parsed });
  trimCache(_acpJsonCache, CACHE_MAX);
  return parsed;
}

function reduceStandaloneAcpJson(filePath, data, mtimeMs) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) return null;
  // Filter out empty ~4.9 KB T3 capability probe files that contain only
  // system messages and no user/assistant conversation turns.
  const hasConversation = data.messages.some(m => m && (m.role === 'user' || m.role === 'assistant'));
  if (!hasConversation) return null;

  const fallbackId = path.basename(filePath, '.json');
  const rawNativeId = typeof data.sessionId === 'string' && data.sessionId.trim()
    ? data.sessionId.trim()
    : fallbackId;
  if (!rawNativeId || rawNativeId.includes('/') || rawNativeId.includes('\\') || rawNativeId.includes('\0')) return null;

  const nativeId = rawNativeId;
  const sessionId = `zai-${nativeId}`;
  const model = (typeof data.model === 'string' && data.model.trim()) || 'glm';
  const rawThought = typeof data.thoughtLevel === 'string' ? data.thoughtLevel.trim().toLowerCase() : '';
  const reasoningEffort = rawThought || null;
  const rawCwd = typeof data.cwd === 'string' && data.cwd.trim() ? data.cwd.trim() : null;
  const project = rawCwd ? (normalizeProjectPath(rawCwd) || rawCwd) : null;
  const agentName = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 128) : null;
  const lastActivity = Math.max(toEpochMs(data.updatedAt) || 0, Number(mtimeMs) || 0);

  const observedSources = emptyObservedSources();
  const dialogueRaw = [];
  const workingSetRaw = [];
  const lastResults = [];
  const gitEvents = [];
  const toolHistory = [];
  const detailMessages = [];
  const callsById = new Map();
  const pendingCalls = new Map();

  let todos = [];
  let lastTool = null;
  let lastToolInput = null;
  let lastMessage = null;
  let lastPrompt = null;
  let lastNonSystemRole = null;
  let lastAssistantHadTools = false;
  let msgSeq = 0;

  for (const msg of data.messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (role === 'system') continue;
    lastNonSystemRole = role;
    const ts = toEpochMs(msg.timestamp || msg.createdAt) || lastActivity;
    msgSeq += 1;

    if (role === 'user') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
          ? msg.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
          : '');
      const cleaned = cleanT3UserPrompt(content);
      if (cleaned) {
        lastPrompt = cleaned;
        detailMessages.push({ role: 'user', text: cleaned.slice(0, 1200), ts });
      }
      pendingCalls.clear();
      continue;
    }

    if (role === 'assistant') {
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
        observedSources.thinkingPlaintext = true;
        dialogueRaw.push({
          kind: 'thinking',
          source: 'glm.reasoning',
          text: msg.reasoning_content,
          observedAt: ts,
          actionId: `msg-${msgSeq}-think`,
        });
      }
      if (typeof msg.content === 'string' && msg.content.trim()) {
        observedSources.assistantText = true;
        lastMessage = msg.content.trim().slice(0, 400);
        detailMessages.push({ role: 'assistant', text: msg.content.trim().slice(0, 1600), ts });
        dialogueRaw.push({
          kind: 'assistant',
          source: 'glm.assistant',
          text: msg.content,
          observedAt: ts,
          actionId: `msg-${msgSeq}-text`,
        });
      }

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      lastAssistantHadTools = toolCalls.length > 0;
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const toolName = String(tc?.function?.name || tc?.name || '').trim();
        if (!toolName) continue;
        const lowerTool = toolName.toLowerCase();
        const args = parseAcpToolArgs(tc?.function?.arguments ?? tc?.arguments ?? tc?.input);
        const callId = typeof tc.id === 'string' && tc.id ? tc.id : `call-${msgSeq}-${i}`;
        let summary = '';

        if (lowerTool === 'todowrite' && Array.isArray(args.todos)) {
          const projected = projectT3Todos(args.todos);
          if (projected) {
            todos = projected;
            const activeTodo = args.todos.find(t => String(t?.status || '').toLowerCase() === 'in_progress');
            const planText = activeTodo?.activeForm || activeTodo?.active_form || activeTodo?.content || activeTodo?.subject || null;
            if (typeof planText === 'string' && planText.trim()) {
              observedSources.planStep = true;
              dialogueRaw.push({
                kind: 'plan',
                source: 'glm.todowrite',
                text: planText.trim(),
                observedAt: ts,
                actionId: callId,
              });
            }
          }
          const doneCount = todos.filter(t => t.status === 'completed').length;
          const activeSubject = todos.find(t => t.status === 'in_progress')?.subject;
          summary = activeSubject
            ? `${activeSubject} (${doneCount}/${todos.length})`.slice(0, 160)
            : (todos.length ? `${doneCount}/${todos.length} todos` : '');
        } else if (lowerTool === 'run_command' || lowerTool === 'bash') {
          const cmd = typeof args.command === 'string'
            ? args.command
            : (typeof args.CommandLine === 'string' ? args.CommandLine : (typeof args.cmd === 'string' ? args.cmd : ''));
          summary = cmd ? stripShellLocationPrefix(cmd).slice(0, 200) : '';
        } else {
          const targetPath = typeof args.path === 'string'
            ? args.path
            : (typeof args.file_path === 'string' ? args.file_path : (typeof args.Path === 'string' ? args.Path : null));
          if (targetPath) {
            if (['read_file', 'read', 'view_file'].includes(lowerTool)) {
              workingSetRaw.push({ path: targetPath, op: 'read', at: ts });
            } else if (['write_file', 'edit_file', 'write', 'edit'].includes(lowerTool)) {
              workingSetRaw.push({ path: targetPath, op: 'write', at: ts });
            }
          }
          summary = summarizeToolInput(args, { maxLength: 160 }) || '';
        }

        lastTool = toolName;
        lastToolInput = summary || null;
        toolHistory.push({ tool: toolName, detail: summary, input: summary, ts });
        callsById.set(callId, { toolName, args, summary, ts });
        pendingCalls.set(callId, { toolName, ts });
      }
      continue;
    }

    if (role === 'tool') {
      const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : null;
      if (callId) pendingCalls.delete(callId);
      const call = callId ? callsById.get(callId) : null;
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (call && ['run_command', 'bash'].includes(call.toolName.toLowerCase())) {
        const exitMatch = content.match(ACP_EXIT_CODE_RE);
        const exitCode = exitMatch ? Number(exitMatch[1]) : null;
        const cmd = typeof call.args?.command === 'string'
          ? call.args.command
          : (typeof call.args?.CommandLine === 'string' ? call.args.CommandLine : (typeof call.args?.cmd === 'string' ? call.args.cmd : ''));
        if (exitCode !== null && ts) {
          lastResults.push({
            id: toolResultId({
              provider: 'zai',
              sessionId,
              callId,
              tool: call.toolName,
              detail: call.summary,
              completedAt: ts,
            }),
            tool: call.toolName,
            detail: call.summary,
            exitCode,
            exitCodeSource: 'exit',
            durationMs: null,
            completedAt: ts,
            source: 'transcript',
            location: toolResultLocation({ cwd: project, command: cmd }),
            noOutput: !content.replace(ACP_EXIT_CODE_RE, '').replace(/^(?:STDOUT|STDERR):\s*/gim, '').trim(),
          });
        }
        if (cmd) {
          const extracted = extractGitEventsFromCommandSource(
            { command: cmd, cwd: project },
            {
              sessionId,
              provider: 'zai',
              project: project || '',
              cwd: project || '',
              timestamp: ts,
              completedAt: ts,
              exitCode: exitCode ?? undefined,
              isError: exitCode !== null ? exitCode !== 0 : false,
              output: content,
            },
          );
          if (Array.isArray(extracted) && extracted.length) gitEvents.push(...extracted);
        }
      }
    }
  }

  const workingSet = [];
  const seenPaths = new Set();
  for (let i = workingSetRaw.length - 1; i >= 0 && workingSet.length < 16; i--) {
    const item = workingSetRaw[i];
    const canonical = canonicalAcpPath(item.path, project);
    if (!canonical || seenPaths.has(canonical)) continue;
    seenPaths.add(canonical);
    workingSet.push({ path: canonical, op: item.op, at: item.at || 0, source: 'transcript' });
  }

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

  let turn;
  if (pendingCalls.size > 0) {
    const firstPending = pendingCalls.values().next().value;
    turn = deriveTurnState({ pendingTool: firstPending.toolName, pendingSince: firstPending.ts });
  } else if (lastNonSystemRole === 'assistant' && !lastAssistantHadTools) {
    turn = deriveTurnState({ turnEnded: true, turnEndedAt: lastActivity });
  } else {
    turn = deriveTurnState({ turnEnded: false });
  }

  const dedupedGitEvents = gitEvents.length ? dedupeGitEvents(gitEvents) : [];
  const normalizedResults = normalizeToolResults(lastResults);

  return {
    nativeId,
    filePath,
    lastActivity,
    dialogueCandidates,
    session: {
      sessionId,
      provider: 'zai',
      agentId: nativeId,
      agentType: 'main',
      agentName,
      userNamed: false,
      headless: false,
      model,
      reasoningEffort,
      status: 'active',
      lastActivity,
      project,
      ...turn,
      turnStartedAt: null,
      lastTurnDurationMs: null,
      apiError: null,
      lastTool,
      lastToolInput,
      lastMessage,
      lastPrompt,
      dialogue: null,
      observedSources,
      workingSet,
      lastResults: normalizedResults,
      gitEvents: dedupedGitEvents,
      todos,
      tokenUsage: null,
      contextWindowMax: contextWindowForModel(model, 'zai') || 1_000_000,
      parentSessionId: null,
      subagentKind: null,
      signalSource: 'transcript',
    },
    detail: createDetailResponse({
      provider: 'zai',
      sessionId,
      project: project || '',
      agentName,
      toolHistory: toolHistory.slice(-120),
      messages: detailMessages.slice(-50),
      tokenUsage: null,
      gitEvents: dedupedGitEvents,
    }),
  };
}

function readStandaloneAcpGlmSessions(activeThresholdMs, { now = Date.now(), excludeNativeIds = new Set() } = {}) {
  const dir = acpGlmSessionDir();
  let entries;
  try {
    if (!fs.existsSync(dir)) return [];
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code && !['ENOENT', 'ENOTDIR'].includes(error.code)) noteReadFailure(error);
    return [];
  }

  const threshold = activeThresholdMs == null ? null : Math.max(0, Number(activeThresholdMs) || 0);
  const sessions = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
    const baseId = entry.name.slice(0, -'.json'.length).toLowerCase();
    if (excludeNativeIds.has(baseId)) continue;
    const filePath = path.join(dir, entry.name);
    let lstat;
    try {
      lstat = fs.lstatSync(filePath);
    } catch {
      continue;
    }
    if (!lstat.isFile()) continue;
    if (threshold != null && now - lstat.mtimeMs > threshold) continue;
    const record = readStandaloneAcpJsonFile(filePath, lstat);
    if (!record) continue;
    if (excludeNativeIds.has(record.nativeId.toLowerCase())) continue;
    if (threshold != null && now - record.lastActivity > threshold) continue;
    const dialogue = pickDialogue(record.dialogueCandidates, { now });
    sessions.push({
      ...record.session,
      dialogue: dialogue ? { ...dialogue } : null,
      observedSources: { ...record.session.observedSources },
      workingSet: record.session.workingSet.map(item => ({ ...item })),
      lastResults: record.session.lastResults.map(item => ({ ...item })),
      gitEvents: record.session.gitEvents.slice(),
      todos: record.session.todos.map(item => ({ ...item })),
    });
  }
  return sessions;
}

function readStandaloneAcpGlmDetail(nativeId, project = null) {
  const cleanId = String(nativeId || '').trim();
  if (!cleanId || cleanId.includes('/') || cleanId.includes('\\') || cleanId.includes('\0') || cleanId === '.' || cleanId === '..') {
    return null;
  }
  const dir = acpGlmSessionDir();
  const filePath = path.join(dir, `${cleanId}.json`);
  let lstat;
  try {
    lstat = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  const record = readStandaloneAcpJsonFile(filePath, lstat);
  if (!record) return null;
  return {
    ...record.detail,
    project: record.detail.project || project || '',
    toolHistory: record.detail.toolHistory.map(item => ({ ...item })),
    messages: record.detail.messages.map(item => ({ ...item })),
    gitEvents: record.detail.gitEvents.slice(),
  };
}

// ─── Adapter class ──────────────────────────────────────

class GlmAdapter {
  get name() { return 'GLM MCP'; }
  get provider() { return 'zai'; }
  get homeDir() { return STATE_DIR; }

  isAvailable() {
    return fs.existsSync(STATE_DIR)
      || fs.existsSync(acpGlmSessionDir())
      || t3StateDbExists();
  }

  getActiveSessions(activeThresholdMs) {
    const now = Date.now();
    const sessions = [];
    for (const [threadId, jobs] of readThreads()) {
      const session = buildSession(threadId, jobs, { now, activeThresholdMs });
      if (session) sessions.push(session);
    }

    const t3ActiveDelegates = readT3ActiveDelegates();
    const keepSessionIds = new Set(t3ActiveDelegates.keys());
    const t3Sessions = readT3AcpGlmSessions(activeThresholdMs, { now, keepSessionIds });
    const seenNativeIds = new Set(t3Sessions.map(s => String(s.agentId || '').toLowerCase()).filter(Boolean));

    // Backfill todos from standalone ACP JSON if T3 turn_items lacked them.
    const acpDir = acpGlmSessionDir();
    for (const session of t3Sessions) {
      if (Array.isArray(session.todos) && session.todos.length > 0) continue;
      if (!session.agentId) continue;
      const candidatePath = path.join(acpDir, `${session.agentId}.json`);
      try {
        const lstat = fs.lstatSync(candidatePath);
        const standalone = readStandaloneAcpJsonFile(candidatePath, lstat);
        if (standalone?.session?.todos?.length) {
          session.todos = standalone.session.todos.map(item => ({ ...item }));
        }
      } catch { /* optional standalone mirror */ }
    }

    const standaloneSessions = readStandaloneAcpGlmSessions(activeThresholdMs, {
      now,
      excludeNativeIds: seenNativeIds,
    });

    for (const session of [...t3Sessions, ...standaloneSessions]) {
      const delegates = t3ActiveDelegates.get(session.sessionId);
      if (delegates && delegates.count > 0) {
        session.backgroundPending = {
          count: delegates.count,
          kinds: ['agent'],
          since: delegates.since,
        };
      }
      sessions.push(session);
    }

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getMcpJobs(threadId) { return _journal.threads.get(threadId); }

  getSessionDetail(sessionId, project) {
    const threadId = threadIdOf(sessionId);
    const jobs = readThreads().get(threadId);
    if (jobs) {
      const target = transcriptFile(threadId);
      const latestJob = jobs[jobs.length - 1];
      return createDetailResponse({
        sessionId,
        project,
        jobs: recentMcpJobs(jobs),
        toolHistory: readTranscript(target, claudeTranscript.toolHistory),
        messages: readTranscript(target, claudeTranscript.recentMessages),
        tokenUsage: readTranscript(target, f => claudeTranscript.tokenUsage(f, latestJob?.model || null, 'zai')),
      });
    }
    const t3Detail = readT3AcpGlmSessionDetail(threadId, project);
    if (t3Detail) return t3Detail;
    const standaloneDetail = readStandaloneAcpGlmDetail(threadId, project);
    if (standaloneDetail) return standaloneDetail;
    return createDetailResponse({ sessionId, project, jobs: [] });
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    if (fs.existsSync(STATE_DIR)) {
      paths.push({ type: 'directory', path: STATE_DIR, filters: ['journal.jsonl'], scope: 'discovery', kind: 'discovery' });
    }
    if (fs.existsSync(JOURNAL_FILE)) {
      paths.push({ type: 'file', path: JOURNAL_FILE, scope: 'discovery', kind: 'discovery', probe: true });
    }
    const acpDir = acpGlmSessionDir();
    if (fs.existsSync(acpDir)) {
      paths.push({ type: 'directory', path: acpDir, filters: ['.json'], scope: 'discovery', kind: 'discovery' });
    }
    const threads = _journal.threads;
    for (const session of sessions) {
      const threadId = threadIdOf(session.sessionId);
      const jobs = threads.get(threadId);
      if (jobs) {
        const job = jobs[jobs.length - 1];
        if (!job || job.endedAt) continue;
        const target = transcriptFile(threadId);
        if (!target) continue;
        paths.push({
          type: 'file',
          path: target.file,
          scope: 'active',
          kind: 'transcript',
          probe: true,
          activity: session.lastActivity,
          sessionId: session.sessionId,
          project: session.project,
        });
        continue;
      }
      if (threadId && !threadId.includes('/') && !threadId.includes('\\') && fs.existsSync(acpDir)) {
        const acpFile = path.join(acpDir, `${threadId}.json`);
        if (fs.existsSync(acpFile)) {
          paths.push({
            type: 'file',
            path: acpFile,
            scope: 'active',
            kind: 'transcript',
            probe: true,
            activity: session.lastActivity,
            sessionId: session.sessionId,
            project: session.project,
          });
        }
      }
    }
    return paths;
  }
}

module.exports = { GlmAdapter, ACP_GLM_SESSION_DIR };
