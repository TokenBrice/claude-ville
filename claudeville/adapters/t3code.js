/**
 * T3 Code state database, `~/.t3/userdata/statev2.sqlite`, opened read-only
 * through `node:sqlite` (unflagged from Node 22.13; without it every query
 * returns no rows). T3 Code runs each agent session as a thread: a run attempt
 * records the agent's own session id as `nativeThreadId`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { noteReadFailure } = require('./shared');

function t3UserDataDir() {
  return path.join(os.homedir(), '.t3', 'userdata');
}

let _nodeSqlite;
function loadNodeSqlite() {
  if (_nodeSqlite === undefined) {
    try {
      _nodeSqlite = require('node:sqlite');
    } catch {
      _nodeSqlite = null;
    }
  }
  return _nodeSqlite;
}

function queryT3State(sql, ...params) {
  const dbPath = path.join(t3UserDataDir(), 'statev2.sqlite');
  const sqlite = loadNodeSqlite();
  if (!sqlite?.DatabaseSync || !fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(sql).all(...params);
  } catch (error) {
    noteReadFailure(error);
    return [];
  } finally {
    try { db?.close(); } catch (error) { noteReadFailure(error); }
  }
}

// T3 Code sets a thread's `titleRenamed` when the operator renames it; titles
// it generates, delegate task titles included, leave it false.
const T3_RENAMED_SQL = `
SELECT DISTINCT lower(json_extract(a.payload_json, '$.nativeThreadId')) AS native, t.title AS title
FROM orchestration_v2_projection_run_attempts a
JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
WHERE a.provider = ?
  AND json_extract(t.payload_json, '$.titleRenamed') = 1
  AND lower(json_extract(a.payload_json, '$.nativeThreadId')) IN (SELECT value FROM json_each(?))
`;

// The current title of each renamed T3 thread a `provider` session runs,
// keyed by the lowercased session id.
function readT3RenamedTitles(provider, nativeIds) {
  const titles = new Map();
  if (nativeIds.length === 0) return titles;
  const ids = JSON.stringify(nativeIds.map(id => id.toLowerCase()));
  for (const row of queryT3State(T3_RENAMED_SQL, provider, ids)) {
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 128) : '';
    if (title) titles.set(row.native, title);
  }
  return titles;
}

module.exports = { queryT3State, readT3RenamedTitles, t3UserDataDir };
