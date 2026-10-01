#!/usr/bin/env node

// `agents/` is local agent scratch (plans, research, handovers): gitignored and
// never committed. This check fails when the ignore rule is gone or when any
// file under `agents/` is tracked (for example after `git add -f`).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

try {
  git(['rev-parse', '--is-inside-work-tree']);
} catch {
  console.log('Not a git checkout; agent scratch check skipped.');
  process.exit(0);
}

const problems = [];
try {
  git(['check-ignore', '-q', '--no-index', 'agents/scratch.md']);
} catch {
  problems.push('.gitignore: add `/agents/` so agent scratch stays out of the repository.');
}

const tracked = git(['ls-files', '-z', '--', 'agents']).split('\0').filter(Boolean);
for (const file of tracked) problems.push(`${file}: agent scratch is tracked; remove it from the index (git rm --cached).`);

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log('Agent scratch is untracked and ignored (agents/).');
}
