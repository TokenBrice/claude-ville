// SM-5: vocabulary holes the current Claude/Codex fleet actually hits.
//
// Each row pins one mapping that rituals, chits and Mine assays read, so a
// regression in the classifier shows up as a named case, not a drift in the
// village's distribution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import {
    classifyTool,
    placedBuildingForTool,
    toolActionLabel,
    toolCategory,
    toolVerbLabel,
} from '../../claudeville/src/domain/services/ToolIdentity.js';
import { AgentAction, resolveAgentAction } from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { currentToolPresentation } from '../../claudeville/src/presentation/shared/AgentPresentation.js';

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
    ['Bash', 'cat /work/claude-ville/claudeville/src/a.js', 'archive', 'inspect-code', 'inspect'],
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

test('TR-2: wrapper descriptions produce a script verb and no building', () => {
    for (const tool of ['REPL', 'Poll']) {
        for (const input of ['Edit server.js and run npm test', 'git push the branch',
            'Fetch https://example.com', { description: 'Patch server.js' }, null]) {
            assert.equal(placedBuildingForTool(tool, input), null);
            assert.equal(toolVerbLabel(tool, input), 'run a script');
            assert.equal(toolActionLabel(tool), 'Running a script');
        }
        const calls = { tool_uses: [{ tool, input: { description: 'git push the branch' } }] };
        assert.equal(placedBuildingForTool('multi_tool_use', calls), null);
        calls.tool_uses.push({ tool: 'Grep', input: { pattern: 'village' } });
        assert.equal(placedBuildingForTool('multi_tool_use', calls), 'archive');
    }
});

test('TR-2: snapshots and deltas carry the script label and retain real tool placement', t => {
    let now = Date.now();
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const visits = new VisitIntentManager({ world, now: () => now });
    t.after(() => { manager.stop(); visits.dispose(); });
    const session = {
        sessionId: 's', provider: 'claude', turnState: 'tool_pending', lastActivity: now,
        pendingTool: 'REPL', lastTool: 'Read', lastToolInput: 'README.md',
        script: { tool: 'REPL', description: 'Edit server.js and run npm test', since: now },
    };
    manager.handleWebSocketMessage({ sessions: [session] });
    const agent = world.agents.get('s');
    assert.deepEqual(agent.script, session.script);
    assert.equal(agent.currentTool, null);
    assert.equal(agent.lastKnownBuildingType, 'archive');
    assert.equal(currentToolPresentation(agent).name, 'Running a script');
    assert.equal(currentToolPresentation(agent).detail, session.script.description);
    now += 60_000;
    visits.reconcile();
    assert.equal(visits.getIntentForAgent('s')?.building, 'archive');
    assert.equal(visits.getIntentForAgent('s')?.phase, null);

    const update = (patch) => manager.handleWebSocketMessage({
        sessions: [{ ...session, ...patch }], changes: { sessionIds: ['s'], shared: false },
    });
    update({ script: { ...session.script, description: null } });
    assert.equal(currentToolPresentation(agent).name, 'Running a script');
    assert.equal(currentToolPresentation(agent).detail, '');
    update({ script: null, pendingTool: null, turnState: 'working' });
    assert.equal(agent.script, null);
    assert.equal(currentToolPresentation(agent).name, 'Read');
    assert.equal(currentToolPresentation(agent).detail, 'README.md');
    visits.reconcile();
    assert.equal(visits.getIntentForAgent('s')?.reason, 'read-local');

    update({});
    manager.handleWebSocketMessage({ sessions: [] });
    assert.equal(agent.script, null);
});

test('FK-2: a shell or monitor Poll routes like Monitor using background evidence', t => {
    const now = Date.now();
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const visits = new VisitIntentManager({ world, now: () => now });
    t.after(() => { manager.stop(); visits.dispose(); });
    for (const kinds of [['bash'], ['monitor'], ['bash', 'monitor']]) {
        const session = {
            sessionId: 'watch', provider: 'claude', turnState: 'tool_pending', lastActivity: now,
            pendingTool: 'Poll', lastTool: 'Edit', lastToolInput: 'server.js',
            backgroundPending: { count: kinds.length, kinds, since: now },
            script: { tool: 'Poll', description: 'Commit the build results', since: now },
        };
        manager.handleWebSocketMessage({ sessions: [session] });
        const watcher = world.agents.get('watch');
        assert.equal(watcher.pendingTool, 'Poll');
        assert.equal(watcher.lastTool, 'Edit');
        assert.equal(watcher.targetBuildingType, 'watchtower');
        visits.reconcile();
        const intent = visits.getIntentForAgent('watch');
        assert.equal(intent?.building, 'watchtower');
        assert.equal(intent?.phase, 'watching');
        assert.equal(intent?.payload?.tool, 'Poll');
        assert.equal(currentToolPresentation(watcher).name, 'Watching');
        assert.equal(currentToolPresentation(watcher).detail, session.script.description);
        assert.equal(toolVerbLabel('Poll', session.script.description, watcher), 'watch');
        const aperture = BuildingSprite.prototype._inspectionSessions.call({ agentSprites: [{ agent: watcher }] }, 'watchtower', now);
        assert.equal(aperture[0]?.tool, 'watch');
        assert.equal(currentToolPresentation({ ...watcher, status: 'completed' }).isIdle, true);
    }
    const crewPoll = { turnState: 'tool_pending', pendingTool: 'Poll', backgroundPending: { count: 1, kinds: ['agent', 'bash'] } };
    assert.equal(toolVerbLabel('Poll', '', crewPoll), 'wait on crew');
});

test('FK-9: the action pose uses tool categories and observed blocking', () => {
    for (const [currentTool, expected] of [
        ['Task', AgentAction.WORK], ['TaskCreate', AgentAction.WORK], ['TaskUpdate', AgentAction.WORK],
        ['mcp__glm__ask', AgentAction.WORK], ['merge', AgentAction.WORK], ['Bash', AgentAction.WORK],
        ['Read', AgentAction.READ], ['Grep', AgentAction.READ], ['rg', AgentAction.READ],
        ['ToolSearch', AgentAction.READ], ['NotebookRead', AgentAction.READ], ['TodoRead', AgentAction.READ],
        ['grep_search', AgentAction.READ], ['codebase_search', AgentAction.READ], ['file_search', AgentAction.READ],
        ['searchTools', AgentAction.READ], ['mcp__sequential-thinking__sequentialthinking', AgentAction.THINK],
        ['mcp__data__read_file', AgentAction.READ], ['EnterPlanMode', AgentAction.THINK],
        ['AskUserQuestion', AgentAction.THINK], ['SendMessage', AgentAction.TALK],
    ]) {
        assert.equal(resolveAgentAction({ currentTool, status: 'working' }), expected, currentTool);
    }
    assert.equal(resolveAgentAction({ status: 'working', turnState: 'tool_pending',
        pendingTool: 'mcp__glm__ask', currentTool: 'Edit' }), null);
});

test('FK-9: searchTools has a read pose without changing its shared category', () => {
    assert.equal(toolCategory('searchTools'), 'other');
});
