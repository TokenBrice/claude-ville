#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  getSessionDetailByProvider,
  isKnownSessionDetailProvider,
  normalizeDetail,
  normalizeSession,
} = require('../../claudeville/adapters');

const now = Date.now();

const rawSession = {
  sessionId: 123,
  provider: 'codex',
  project: '/tmp/claude-ville',
  model: '',
  status: '',
  lastActivity: String(now),
  tokens: { input_tokens: 10, output_tokens: 2 },
};

const normalizedSession = normalizeSession(rawSession);
assert.equal(normalizedSession.sessionId, '123');
assert.equal(normalizedSession.provider, 'codex');
assert.equal(normalizedSession.model, 'codex');
assert.equal(normalizedSession.status, 'active');
assert.equal(normalizedSession.lastActivity, now);
assert.deepEqual(normalizedSession.gitEvents, []);
assert.deepEqual(normalizedSession.tokenUsage, rawSession.tokens);

const normalizedDetail = normalizeDetail({
  sessionId: 123,
  provider: 'gemini',
  toolHistory: null,
  messages: 'not-array',
  usage: { input: 1, output: 2 },
}, { project: '/tmp/project' });
assert.equal(normalizedDetail.sessionId, '123');
assert.equal(normalizedDetail.provider, 'gemini');
assert.equal(normalizedDetail.project, '/tmp/project');
assert.deepEqual(normalizedDetail.toolHistory, []);
assert.deepEqual(normalizedDetail.messages, []);
assert.deepEqual(normalizedDetail.tokenUsage, { input: 1, output: 2 });

assert.equal(isKnownSessionDetailProvider('claude'), true);
assert.equal(isKnownSessionDetailProvider('git'), true);
assert.equal(isKnownSessionDetailProvider('unknown-provider'), false);

const gitDetail = getSessionDetailByProvider('git', 'git-repo-fixture', '/tmp/project');
assert.equal(gitDetail.provider, 'git');
assert.equal(gitDetail.sessionId, 'git-repo-fixture');
assert.equal(gitDetail.project, '/tmp/project');
assert.deepEqual(gitDetail.toolHistory, []);
assert.deepEqual(gitDetail.messages, []);
assert.equal(typeof gitDetail.reason, 'string');

console.log('adapter fixture normalization checks passed');
