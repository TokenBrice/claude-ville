import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempRoot() {
  return process.env.CLAUDEVILLE_TEST_TMPDIR || os.tmpdir();
}

export function makeTempDir(prefix) {
  const root = tempRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, prefix));
    // Hermeticity (QA-4): the temp root may itself sit inside a git checkout,
    // and repo discovery that walks above the temp root makes fixtures resolve
    // against the host checkout. Stop discovery at the temp root, the way
    // support/harbor-ingest.mjs does. Append: a preset ceiling (the manual
    // GIT_CEILING_DIRECTORIES documented for git-probe-metadata) survives.
    const ceiling = path.dirname(dir);
    const entries = String(process.env.GIT_CEILING_DIRECTORIES || '')
      .split(path.delimiter).filter(Boolean);
    if (!entries.includes(ceiling)) {
      process.env.GIT_CEILING_DIRECTORIES = [...entries, ceiling].join(path.delimiter);
    }
    return dir;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      throw new Error(`cannot create temp dir under ${root}; set CLAUDEVILLE_TEST_TMPDIR to a writable directory`);
    }
    throw error;
  }
}
