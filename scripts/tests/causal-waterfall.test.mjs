import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCausalWaterfall } from '../../claudeville/src/presentation/shared/ActivityPanel.js';

const MINUTE = 60_000;
const NOW = 20 * MINUTE;

function build(session, options = {}) {
  return buildCausalWaterfall(session, { now: NOW, ...options });
}

test('orders turn, permission, tool, retry, and child rows chronologically', () => {
  const rows = build({
    turnStartedAt: NOW - 10 * MINUTE,
    lastTurnDurationMs: 30_000,
    awaitingSince: NOW - 8 * MINUTE,
    waitReason: 'approval',
    pendingTool: 'Bash',
    toolHistory: [
      { ts: NOW - 7 * MINUTE, tool: 'Bash', durationMs: 4_000 },
      { ts: NOW - 6 * MINUTE, tool: 'Bash', durationMs: 2_000, retry: true },
    ],
    children: [{ id: 'child-1', name: 'worker', turnStartedAt: NOW - 5 * MINUTE, lastTurnDurationMs: 20_000 }],
  });

  assert.ok(rows.some(row => row.kind === 'turn'));
  assert.ok(rows.some(row => row.kind === 'permission'));
  assert.ok(rows.some(row => row.kind === 'tool'));
  assert.ok(rows.some(row => row.kind === 'retry'));
  assert.ok(rows.some(row => row.kind === 'child'));
  assert.deepEqual(rows.map(row => row.at), [...rows].sort((a, b) => a.at - b.at).map(row => row.at));
});

test('drops events older than the twenty-minute window', () => {
  const rows = build({
    toolHistory: [
      { ts: NOW - 21 * MINUTE, tool: 'old-tool', durationMs: 1_000 },
      { ts: NOW - 19 * MINUTE, tool: 'recent-tool', durationMs: 1_000 },
    ],
  });

  assert.equal(rows.some(row => row.detail.includes('old-tool')), false);
  assert.equal(rows.some(row => row.detail.includes('recent-tool')), true);
  assert.ok(rows.every(row => row.at >= NOW - 20 * MINUTE));
});

test('normalizes row widths proportionally to elapsed duration', () => {
  const rows = build({
    toolHistory: [
      { ts: NOW - 30_000, tool: 'short', durationMs: 10_000 },
      { ts: NOW - 20_000, tool: 'long', durationMs: 20_000 },
    ],
  });
  const short = rows.find(row => row.detail.includes('short'));
  const long = rows.find(row => row.detail.includes('long'));

  assert.equal(short.durationMs, 10_000);
  assert.equal(long.durationMs, 20_000);
  assert.equal(short.width, 0.5);
  assert.equal(long.width, 1);
});

test('represents a long stall as the dominant waterfall row', () => {
  const rows = build({
    toolHistory: [
      { ts: NOW - 200_000, tool: 'before', durationMs: 1_000 },
      { ts: NOW - 109_000, tool: 'after', durationMs: 1_000 },
    ],
  });
  const stall = rows.find(row => row.kind === 'stall');
  const tool = rows.find(row => row.detail.includes('before'));

  assert.ok(stall);
  assert.ok(stall.durationMs >= 89_000);
  assert.ok(stall.width > tool.width);
});

test('passes through reported tool duration and exit code', () => {
  const rows = build({
    toolHistory: [{ ts: NOW - 5_000, tool: 'shell', detail: 'pwd', durationMs: 2_400, toolExitCode: 7 }],
  });
  const row = rows.find(candidate => candidate.kind === 'tool');

  assert.equal(row.durationMs, 2_400);
  assert.equal(row.toolExitCode, 7);
  assert.equal(row.provenance, 'exact');
  assert.equal(row.derived, false);
});

test('marks inferred elapsed timing separately from provider-reported timing', () => {
  const rows = build({
    turnStartedAt: NOW - 30_000,
    lastTurnDurationMs: 12_000,
    awaitingSince: NOW - 5_000,
    waitReason: 'question',
  });
  const turn = rows.find(row => row.kind === 'turn');
  const permission = rows.find(row => row.kind === 'permission');

  assert.equal(turn.provenance, 'exact');
  assert.equal(turn.derived, false);
  assert.equal(permission.provenance, 'inferred');
  assert.equal(permission.derived, true);
});

test('returns no rows when no usable timeline timestamp exists', () => {
  assert.deepEqual(build({ status: 'working', lastTurnDurationMs: 5_000 }), []);
  assert.deepEqual(build({ toolHistory: [{ tool: 'missing-ts', durationMs: 5_000 }] }), []);
  assert.deepEqual(build(null), []);
});
