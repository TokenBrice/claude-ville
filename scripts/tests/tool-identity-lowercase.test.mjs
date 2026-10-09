import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyTool,
    toolActionLabel,
    toolCategory,
    toolVerbLabel,
} from '../../claudeville/src/domain/services/ToolIdentity.js';

// Inputs cover both raw calls and the compact string summaries adapters publish.
const LOWERCASE_CASES = [
    ['read', { path: 'docs/README.md' }, 'archive', 'read-local', 'read', 'read'],
    ['read', { path: 'src/ToolIdentity.js' }, 'forge', 'inspect-code', 'inspect', 'read'],
    ['read', 'ToolIdentity.js', 'forge', 'inspect-code', 'inspect', 'read'],
    ['grep', { pattern: 'resident', path: 'notes.txt' }, 'archive', 'search-local', 'search', 'search'],
    ['grep', { pattern: 'resident', path: 'src' }, 'forge', 'inspect-code', 'inspect', 'search'],
    ['glob', { path: '**/*.txt' }, 'archive', 'find-local', 'find', 'search'],
    ['glob', { path: '**/*.js' }, 'forge', 'inspect-code', 'inspect', 'search'],
    ['find', { path: '**/*.txt' }, 'archive', 'find-local', 'find', 'search'],
    ['find', { path: '**/*.js' }, 'forge', 'inspect-code', 'inspect', 'search'],
    ['search', { pattern: 'resident', path: 'notes.txt' }, 'archive', 'search-local', 'search', 'search'],
    ['search', { pattern: 'resident', path: 'src' }, 'forge', 'inspect-code', 'inspect', 'search'],
    ['lsp', { path: 'notes.txt' }, 'archive', 'read-local', 'read', 'read'],
    ['lsp', { path: 'src/a.js' }, 'forge', 'inspect-code', 'inspect', 'read'],
    ['ast_grep', { pattern: 'resident', path: 'notes.txt' }, 'archive', 'search-local', 'search', 'search'],
    ['ast_grep', { pattern: 'resident', path: 'src' }, 'forge', 'inspect-code', 'inspect', 'search'],
    ['edit', { path: 'src/a.js' }, 'forge', 'edit-file', 'edit', 'write'],
    ['edit', { path: 'docs/README.md' }, 'archive', 'edit-docs', 'edit docs', 'write'],
    ['edit', '*** Begin Patch\n*** Update File: docs/README.md\n*** End Patch', 'archive', 'edit-docs', 'edit docs', 'write'],
    ['write', { path: 'src/a.js' }, 'forge', 'write-file', 'write', 'write'],
    ['write', { path: 'docs/README.md' }, 'archive', 'edit-docs', 'edit docs', 'write'],
    ['ast_edit', { path: 'src/a.js' }, 'forge', 'edit-file', 'edit', 'write'],
    ['ast_edit', { path: 'docs/README.md' }, 'archive', 'edit-docs', 'edit docs', 'write'],
    ['bash', { command: 'echo ready' }, 'command', 'run-shell', 'run', 'exec'],
    ['bash', { command: 'cat notes.txt' }, 'archive', 'search-local', 'search', 'exec'],
    ['bash', { command: 'cat src/a.js' }, 'forge', 'inspect-code', 'inspect', 'exec'],
    ['bash', { command: 'npm test' }, 'taskboard', 'verify', 'verify', 'exec'],
    ['bash', { command: 'git push' }, 'harbor', 'git-flow', 'git', 'exec'],
    ['eval', { code: 'console.log("ready")' }, 'command', 'run-shell', 'run', 'exec'],
    ['eval', { code: 'await tool.bash({command: "npm test"})' }, 'taskboard', 'verify', 'verify', 'exec'],
    ['task', {}, 'command', 'delegate-task', 'delegate', 'task'],
    ['task', { tasks: [{ task: 'Read the plan' }] }, 'command', 'delegate-task', 'delegate', 'task'],
    ['todo', { op: 'list' }, 'taskboard', 'plan-work', 'plan', 'task'],
    ['yield', {}, 'taskboard', 'report-work', 'report', 'task'],
    ['wait', {}, 'command', 'wait-agent', 'wait on agent', 'task'],
    ['ask', { question: 'Which branch?' }, 'command', 'ask-decision', 'ask', 'task'],
    ['web_search', { query: 'Node documentation' }, 'observatory', 'web-search', 'search web', 'search'],
    ['browser', { url: 'http://localhost:4000/' }, 'portal', 'browser-preview', 'preview', 'exec'],
    ['github', { method: 'GET', path: '/repos/example/project' }, 'harbor', 'github-flow', 'github', 'exec'],
    ['debug', { command: 'start', program: 'app.js' }, 'command', 'debug-session', 'debug', 'exec'],
];

for (const [tool, input, building, reason, verb, category] of LOWERCASE_CASES) {
    test(`${tool} ${JSON.stringify(input)} retains its tool semantics`, () => {
        const actual = classifyTool(tool, input);
        assert.equal(actual?.building, building);
        assert.equal(actual?.reason, reason);
        assert.equal(toolVerbLabel(tool, input), verb);
        assert.equal(toolCategory(tool), category);
        assert.equal(toolCategory(`functions.${tool}`), category);
    });
}

const CAPITALIZED_CASES = [
    ['Read', { file_path: 'docs/README.md' }, 'archive'],
    ['Read', { file_path: 'src/a.js' }, 'forge'],
    ['Grep', { pattern: 'resident', path: 'notes.txt' }, 'archive'],
    ['Glob', { pattern: '**/*.txt' }, 'archive'],
    ['LS', { path: '.' }, 'archive'],
    ['Edit', { file_path: 'src/a.js' }, 'forge'],
    ['MultiEdit', { file_path: 'src/a.js' }, 'forge'],
    ['Write', { file_path: 'src/a.js' }, 'forge'],
    ['NotebookEdit', { file_path: 'notebook.ipynb' }, 'forge'],
    ['Bash', { command: 'echo ready' }, 'command'],
    ['Bash', { command: 'npm test' }, 'taskboard'],
    ['Task', {}, 'command'],
    ['TeamCreate', {}, 'command'],
    ['SendMessage', {}, 'command'],
    ['TaskCreate', {}, 'taskboard'],
    ['TaskUpdate', {}, 'taskboard'],
    ['TaskList', {}, 'taskboard'],
    ['TodoWrite', {}, 'taskboard'],
    ['EnterPlanMode', {}, 'taskboard'],
    ['ExitPlanMode', {}, 'taskboard'],
    ['AskUserQuestion', {}, 'command'],
    ['WebSearch', { query: 'Node documentation' }, 'observatory'],
    ['WebFetch', { url: 'https://example.com/' }, 'observatory'],
    ['WebFetch', { url: 'http://localhost:4000/' }, 'portal'],
];

test('existing capitalized tools keep their buildings', () => {
    for (const [tool, input, building] of CAPITALIZED_CASES) {
        assert.equal(classifyTool(tool, input)?.building, building, tool);
    }
    assert.equal(classifyTool('Read', { file_path: 'src/a.js' }).reason, 'inspect-code');
    assert.equal(toolVerbLabel('Read', { file_path: 'src/a.js' }), 'inspect');
});

test('lowercase twins reuse canonical classifications and action labels', () => {
    const twins = [
        ['read', 'Read'], ['grep', 'Grep'], ['glob', 'Glob'],
        ['find', 'Glob'], ['search', 'Grep'],
        ['edit', 'Edit'], ['write', 'Write'], ['ast_edit', 'Edit'],
        ['lsp', 'Read'], ['ast_grep', 'Grep'], ['bash', 'Bash'],
        ['eval', 'Bash'], ['task', 'Task'], ['todo', 'TodoWrite'],
        ['web_search', 'WebSearch'],
    ];
    for (const [lowercase, canonical] of twins) {
        for (const input of [{ path: 'notes.txt' }, { path: 'src/a.js' }, { path: 'docs/README.md' }, { command: 'npm test' }]) {
            assert.deepEqual(classifyTool(lowercase, input), classifyTool(canonical, input), lowercase);
        }
        const action = toolActionLabel(canonical);
        assert.equal(toolActionLabel(lowercase), action === canonical ? lowercase : action, lowercase);
    }
});
