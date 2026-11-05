// SM-5: vocabulary holes the current Claude/Codex fleet actually hits.
//
// Each row pins one mapping that rituals, chits and Mine assays read, so a
// regression in the classifier shows up as a named case, not a drift in the
// village's distribution.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyTool,
    toolActionLabel,
    toolCategory,
    toolVerbLabel,
} from '../../claudeville/src/domain/services/ToolIdentity.js';

const CASES = [
    // Claude's subagent launcher is delegation, like the `Task` it replaced.
    ['Agent', 'Night and lighting lane', 'command', 'delegate-task', 'delegate'],
    // Waiting on a condition is a lookout's job.
    ['Monitor', 'until curl -s localhost:4000; do sleep 2; done', 'watchtower', 'watch-condition', 'watch'],
    // v0.61.2 — every wait keeps watch at the Lighthouse, as the fleet runs it.
    ['Bash', 'until grep -q "^exit" /tmp/run.log; do sleep 5; done', 'watchtower', 'watch-condition', 'watch'],
    ['Bash', 'until curl -s localhost:4000; do sleep 2; done', 'watchtower', 'watch-condition', 'watch'],
    ['Bash', 'timeout 100 tail -f /dev/null; echo "wait done"', 'watchtower', 'watch-condition', 'watch'],
    ['Bash', 'sleep 240; cat /tmp/out.txt', 'watchtower', 'watch-condition', 'watch'],
    ['Bash', 'cd /work/repo && sleep 30 && ls', 'watchtower', 'watch-condition', 'watch'],
    ['Bash', 'while true; do curl -s localhost:4000 && break; sleep 1; done', 'watchtower', 'watch-condition', 'watch'],
    ['Bash', 'journalctl --user -u app -f', 'watchtower', 'watch-condition', 'watch'],
    ['exec_command', '{"cmd":"until test -f out.png; do sleep 1; done"}', 'watchtower', 'watch-condition', 'watch'],
    ['sleep', '{"duration_ms":20000}', 'watchtower', 'watch-condition', 'watch'],
    ['ScheduleWakeup', 'watching CI run', 'watchtower', 'watch-condition', 'watch'],
    // CI runs and checks are the pushed branch's ships at sea.
    ['Bash', 'gh run watch 41727392797 --exit-status --interval 20', 'watchtower', 'watch-ci', 'watch checks'],
    ['Bash', 'gh pr checks 1854 --repo owner/repo', 'watchtower', 'watch-ci', 'watch checks'],
    ['Bash', 'sleep 20; gh run list --branch main --limit 6', 'watchtower', 'watch-ci', 'watch checks'],
    ['exec', 'const r = await tools.exec_command({cmd:"gh run view 41375551646 --json status"})', 'watchtower', 'watch-ci', 'watch checks'],
    // The Harbor keeps sending ships; a loop over input stays a read.
    ['Bash', 'git push origin main', 'harbor', 'git-flow', 'git'],
    ['Bash', 'gh workflow run ci.yml', 'harbor', 'git-flow', 'git'],
    ['Bash', 'gh pr create --fill', 'harbor', 'git-flow', 'git'],
    ['Bash', 'git commit -m "fix the sleep 5 timer"', 'harbor', 'git-flow', 'git'],
    ['Bash', 'while read f; do wc -l "$f"; done < files.txt', 'archive', 'search-local', 'search'],
    // This repo's own gates are verification.
    ['Bash', 'node --test scripts/tests/a.test.mjs', 'taskboard', 'verify', 'verify'],
    ['Bash', 'npm run validate:quick', 'taskboard', 'verify', 'verify'],
    ['Bash', 'npm run verify:render', 'taskboard', 'verify', 'verify'],
    ['Bash', 'npm run gate:release', 'taskboard', 'verify', 'verify'],
    ['Bash', 'node --check claudeville/server.js', 'taskboard', 'verify', 'verify'],
    // Reading docs has a verb of its own, not the tool name.
    ['Bash', 'sed -n 1,80p docs/motion-budget.md', 'archive', 'read-docs', 'read'],
    ['exec', 'cat docs/README.md', 'archive', 'read-docs', 'read'],
    // `claude` in a path is a repository or scratch directory, not a document.
    ['Edit', '/work/claude-ville/claudeville/src/a.js', 'forge', 'edit-file', 'edit'],
    ['Write', '/home/u/.claude/worktrees/x/claudeville/src/b.js', 'forge', 'write-file', 'write'],
    ['Bash', 'cat /work/claude-ville/claudeville/src/a.js', 'forge', 'inspect-code', 'inspect'],
    // Real docs still go to the Archive.
    ['Edit', '/work/claude-ville/CLAUDE.md', 'archive', 'edit-docs', 'edit docs'],
    ['Edit', 'docs/README.md', 'archive', 'edit-docs', 'edit docs'],
    ['Write', '/work/claude-ville/agents/plans/x.md', 'archive', 'edit-docs', 'edit docs'],
];

for (const [tool, input, building, reason, verb] of CASES) {
    test(`${tool} ${input} -> ${building} ${reason} "${verb}"`, () => {
        const actual = classifyTool(tool, input);
        assert.equal(actual?.building, building);
        assert.equal(actual?.reason, reason);
        assert.equal(toolVerbLabel(tool, input), verb);
    });
}

test('Agent and Monitor carry task metadata like their neighbours', () => {
    assert.equal(toolCategory('Agent'), 'task');
    assert.equal(toolActionLabel('Agent'), 'Delegating');
    assert.equal(toolCategory('Monitor'), 'task');
    assert.equal(toolActionLabel('Monitor'), 'Watching');
});
