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
const { deriveTurnState } = require('./turnState');
const {
  createDetailResponse,
  mcpJobOwnerAlive,
  noteReadFailure,
  readByteRangeText,
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
const FAILED_STATUSES = new Set(['failed', 'timeout']);

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
  let stat;
  try {
    stat = fs.statSync(JOURNAL_FILE);
  } catch {
    return new Map();
  }
  const key = statCacheKey(JOURNAL_FILE, stat);
  const cursor = _journal.cursor;
  // A fold consumes appends in bounded chunks, so after a burst larger than
  // one chunk the cursor still lags an otherwise unchanged journal: keep
  // folding while complete unread records remain, not only on stat changes.
  const behind = Boolean(cursor && cursor.dev === stat.dev && cursor.ino === stat.ino && cursor.size < stat.size);
  if (_journal.key !== key || behind) {
    _journal = { key, ...foldJournal(_journal.jobs, cursor, stat) };
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
  const projection = readTranscript(target, f => claudeTranscript.projection(f, project, model));
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
    tokenUsage: target ? readTranscript(target, f => claudeTranscript.tokenUsage(f, model)) : null,
    lastResults: readTranscript(target, f => claudeTranscript.toolResults(f, sessionId)),
    gitEvents: target ? readTranscript(target, f => claudeTranscript.gitEvents(f, { provider: 'zai', sessionId, project })) : [],
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
    const target = readThreads().has(threadId) ? transcriptFile(threadId) : null;
    if (!target) return createDetailResponse({ sessionId, project });
    return createDetailResponse({
      sessionId,
      project,
      toolHistory: readTranscript(target, claudeTranscript.toolHistory),
      messages: readTranscript(target, claudeTranscript.recentMessages),
      tokenUsage: readTranscript(target, claudeTranscript.tokenUsage),
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
    }
    return paths;
  }
}

module.exports = { GlmAdapter };
