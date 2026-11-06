// SM-5: vocabulary holes the current Claude/Codex fleet actually hits.
//
// Each row pins one mapping that rituals, chits and Mine assays read, so a
// regression in the classifier shows up as a named case, not a drift in the
// village's distribution.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyTool,
    placedBuildingForTool,
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
    // A trailing CI watch keeps the watch even behind a git-flow segment.
    ['Bash', 'git push origin main && gh run watch 41727392797 --exit-status', 'watchtower', 'watch-ci', 'watch checks'],
    // WL-2 — a mid-command wait alone never captures: real work wins.
    ['Bash', 'pytest && sleep 2 && pytest -k other', 'taskboard', 'verify', 'verify'],
    ['Bash', 'sleep 1 && git push', 'harbor', 'git-flow', 'git'],
    // VT-fix-4 — a file mutation or a build segment is work, not a wait.
    ['Bash', 'sleep 1 && cp source.js destination.js', 'forge', 'modify-files', 'edit'],
    ['Bash', 'sleep 1 && cargo build', 'command', 'run-shell', 'run'],
    // r3 — an executable `rm` is file-mutation work in every command position
    // a shell can put it in, so cleanup never watches.
    ['Bash', 'sleep 1 && rm source.js', 'forge', 'modify-files', 'edit'],
    ['Bash', 'until rm -f /tmp/lock; do sleep 1; done', 'forge', 'modify-files', 'edit'],
    // r3 — mutation words in arguments stay web work: URLs, HTTP methods and
    // JSON payloads classify exactly as they did before the watch precedence.
    ['Bash', 'curl https://example.com/docs/create', 'portal', 'external-research', 'research'],
    ['Bash', 'curl -o /tmp/update.json https://example.com/api/items', 'portal', 'external-research', 'research'],
    ['Bash', 'curl -X PATCH https://example.com/api/items/1', 'portal', 'external-research', 'research'],
    ['Bash', 'curl -X DELETE https://example.com/api/items/1', 'portal', 'external-research', 'research'],
    ['Bash', 'curl -d \'{"action":"delete"}\' https://example.com/api/items', 'portal', 'external-research', 'research'],
    // VT-fix-2 — a pure wait keeps the watch inside every wrapper: a Codex
    // exec payload, and past chdir segments joined by `;` as by `&&`.
    ['exec', 'const r = await tools.exec_command({cmd:"sleep 30"})', 'watchtower', 'watch-condition', 'watch'],
    ['Bash', 'cd /work; sleep 30', 'watchtower', 'watch-condition', 'watch'],
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
    // WL-4 — other languages' test runners are validation too.
    ['Bash', 'cargo test', 'taskboard', 'verify', 'verify'],
    ['Bash', 'go test ./...', 'taskboard', 'verify', 'verify'],
    ['Bash', 'make test', 'taskboard', 'verify', 'verify'],
    ['Bash', 'rake test', 'taskboard', 'verify', 'verify'],
    // WL-4 — an MCP tool places by its verb when the building is unambiguous,
    // but only after the name-specific rules (VT-fix-1): a browser MCP page
    // listing stays a Portal preview and a GitHub MCP commit listing stays
    // Harbor work even though both verbs ("list") map to the Archive.
    ['mcp__chrome-devtools__list_pages', '{}', 'portal', 'browser-preview', 'preview'],
    ['mcp__github__list_commits', '{"owner":"o","repo":"r"}', 'harbor', 'github-flow', 'github'],
    ['mcp__pixellab__generate_sprite', '{"prompt":"a knight"}', 'forge', 'generate-asset', 'generate'],
    ['mcp__serena__searchForPattern', '{"pattern":"TODO"}', 'archive', 'search-local', 'search'],
    ['mcp__serena__read_file', '{"path":"src/a.js"}', 'archive', 'read-local', 'read'],
    ['mcp__fetch__fetch_url', '{"url":"https://example.com"}', 'portal', 'external-research', 'research'],
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

// WL-4 — a delegation-style MCP call (a chat with another agent) and an
// unknown verb keep the honest null: no building is named, so the body falls
// back to its last-known place and then its home district.
test('MCP delegation and unknown verbs name no building', () => {
    for (const tool of [
        'mcp__deepseek__chat',
        'mcp__glm__ask',
        'mcp__codex__ask',
        'mcp__claude_ai_ask',
        'mcp__deepseek__start',
        'mcp__deepseek__wait',
        'mcp__glm-cc-mcp__review',
    ]) {
        assert.equal(placedBuildingForTool(tool, '{"prompt":"x"}'), null, tool);
    }
    // The browser MCPs keep their Portal placement.
    assert.equal(placedBuildingForTool('mcp__playwright__browser_navigate', '{"url":"http://x"}'), 'portal');
});
