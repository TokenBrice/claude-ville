import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The two standalone harbor scripts run under test:unit so they cannot rot
// unnoticed again (they once died in a data-URL import shim).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const script of ['scripts/harbor/git-event-scenario.mjs', 'scripts/smoke/harbor-traffic-bounds.mjs']) {
    test(`${script} passes`, () => {
        const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script], {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 60_000,
        });
        assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
    });
}
