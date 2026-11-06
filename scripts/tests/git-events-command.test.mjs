import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Lane 04 GT-1/GT-2/GT-3: the command parser's argv-array inputs and the
// forge commands that only arm a later outcome (auto-merge, draft release).
// A command whose result never arrives stays pending — absence of a result
// is never success.

const require = createRequire(import.meta.url);
const ge = require('../../claudeville/adapters/gitEvents.js');
const { parseGitEventsFromCommand, extractCommand, extractGitEventsFromCommandSource } = ge;

const T = Date.parse('2026-11-05T12:00:00Z');
const CTX = { provider: 'codex', sessionId: 'fixture', project: '/w/repo', ts: T };

test('GT-2: argv-array tool inputs parse into commands', () => {
    // Legacy Codex function_call arguments and OpenCode `input.command`
    // arrays: `-lc`/`-ic`/`-c` carries the shell payload, else the argv joins.
    assert.equal(extractCommand({ cmd: ['bash', '-lc', 'git push origin main'] }), 'git push origin main');
    assert.equal(extractCommand({ command: ['git', 'fetch', 'origin'] }), 'git fetch origin');
    assert.equal(extractCommand(['bash', '-ic', 'git pull']), 'git pull');
    assert.equal(extractCommand(['git', 'status', '--short']), 'git status --short');
    // String fields keep working; non-string argv entries are not guessed.
    assert.equal(extractCommand({ command: 'git push' }), 'git push');
    assert.equal(extractCommand({ cmd: ['bash', '-lc', 42] }), null);

    const shapes = [
        ['{"cmd":["bash","-lc","git push origin main"]}', 'push'],
        ['{"command":["git","fetch","origin"]}', 'fetch'],
        ['{"command":["bash","-lc","cd /w/repo && git commit -m \\"x\\""]}', 'commit'],
    ];
    for (const [source, type] of shapes) {
        const events = extractGitEventsFromCommandSource(source, { ...CTX, success: true, exitCode: 0 });
        assert.equal(events.length, 1, source);
        assert.equal(events[0].type, type, source);
    }
});

test('review: argv data and non-shell -c options never become shell commands', () => {
    // Joining argv with plain spaces loses word boundaries: an argument's
    // data must stay one quoted shell word, whatever it contains.
    const none = [
        ['echo', 'hello; git push origin main'],
        ['printf', '%s\\n', '-c', 'git push origin main'],
        ['python3', '-c', '"git push origin main"'],
        ['node', '-e', 'console.log("hello")', '-c', 'git push origin main'],
        ['bash', '-c', 'echo "git push origin main"'],
    ];
    for (const argv of none) {
        assert.deepEqual(extractGitEventsFromCommandSource({ cmd: argv }, { ...CTX, success: true, exitCode: 0 }),
            [], argv.join(' '));
    }
    // A `-c` payload is taken only for a shell argv[0], bare or a path.
    assert.equal(extractCommand({ cmd: ['/bin/bash', '-c', 'git push'] }), 'git push');
    assert.equal(extractCommand({ cmd: ['printf', '-c', 'git push'] }), "printf -c 'git push'");
});

test('GT-1: enabling auto-merge is pending, not a landed merge', () => {
    const [auto] = parseGitEventsFromCommand('gh pr merge 12 --squash --auto', {
        ...CTX,
        success: true,
        exitCode: 0,
        output: '✓ Squash and merge enabled for pull request #12',
    });
    assert.equal(auto.type, 'pr');
    assert.equal(auto.action, 'merge');
    assert.equal(auto.success, undefined, 'the call\'s exit 0 is not the merge');
    assert.equal(auto.exitCode, undefined);
    assert.equal(auto.status, undefined);

    // A real squash merge still lands.
    const [landed] = parseGitEventsFromCommand('gh pr merge 12 --squash', {
        ...CTX,
        success: true,
        exitCode: 0,
        output: '✓ Squashed and merged pull request #12 (PR #12)',
    });
    assert.equal(landed.success, true);
    assert.equal(landed.exitCode, 0);
});

test('GT-3: a draft release is pending, not a published one', () => {
    const [draft] = parseGitEventsFromCommand('gh release create --draft v0.1.0', {
        ...CTX,
        success: true,
        exitCode: 0,
        output: '✓ Created draft release v0.1.0',
    });
    assert.equal(draft.type, 'release');
    assert.equal(draft.success, undefined, 'a draft is not published');

    const [published] = parseGitEventsFromCommand('gh release create v1.0.0', { ...CTX, success: true, exitCode: 0 });
    assert.equal(published.type, 'release');
    assert.equal(published.success, true);
});

test('review: deferral reads the effective option values, not token presence', () => {
    const ok = { ...CTX, success: true, exitCode: 0 };
    // `=true` and the `-d` short spelling arm the deferral too.
    for (const command of ['gh pr merge 12 --squash --auto=true', 'gh pr merge 12 --auto']) {
        const [event] = parseGitEventsFromCommand(command, ok);
        assert.equal(event.success, undefined, command);
    }
    for (const command of ['gh release create v1 --draft=true', 'gh release create v1 -d']) {
        const [event] = parseGitEventsFromCommand(command, ok);
        assert.equal(event.success, undefined, command);
    }
    // A quoted flag spelling is an option's value, never a flag; an explicit
    // `=false` opts out.
    for (const command of [
        'gh pr merge 12 --squash --subject "--auto"',
        'gh pr merge 12 --squash --auto=false',
        'gh release create v1 --title "--draft"',
        'gh release create v1 --draft=false',
    ]) {
        const [event] = parseGitEventsFromCommand(command, ok);
        assert.equal(event.success, true, command);
    }
});

test('review: cancelling auto-merge and editing release metadata emit nothing', () => {
    const ok = { ...CTX, success: true, exitCode: 0 };
    // `--disable-auto` only cancels a pending auto-merge: no merge outcome.
    assert.deepEqual(parseGitEventsFromCommand('gh pr merge 12 --disable-auto', ok), []);
    // An ordinary `gh release edit` (or re-drafting one) is not a release.
    assert.deepEqual(parseGitEventsFromCommand('gh release edit v1 --notes "typo"', ok), []);
    assert.deepEqual(parseGitEventsFromCommand('gh release edit v1 --draft', ok), []);
});

test('review: landed merge output overrides the auto-merge deferral', () => {
    const [landed] = parseGitEventsFromCommand('gh pr merge 12 --squash --auto', {
        ...CTX,
        success: true,
        exitCode: 0,
        output: '✓ Squashed and merged pull request o/r#12 (PR #12)',
    });
    assert.equal(landed.success, true, 'the merge completed in the call');

    for (const output of [
        '✓ Auto-merge enabled for pull request #12',
        '✓ Pull request #12 will be automatically merged when requirements are met',
    ]) {
        const [pending] = parseGitEventsFromCommand('gh pr merge 12 --squash --auto', {
            ...CTX, success: true, exitCode: 0, output,
        });
        assert.equal(pending.success, undefined, output);
    }
});

test('review: publishing a prior draft is a release event', () => {
    const [published] = parseGitEventsFromCommand('gh release edit v1 --draft=false', {
        ...CTX,
        success: true,
        exitCode: 0,
    });
    assert.equal(published.type, 'release');
    assert.equal(published.action, 'edit');
    assert.equal(published.success, true);
});

test('review: a shell script operand ends the shell option run', () => {
    // `bash script.sh -c '…'` hands `-c` and the string to the script as
    // data: the payload only follows a `-c`-style option before the script
    // operand (or `--`), never a script argument after it.
    const ok = { ...CTX, success: true, exitCode: 0 };
    for (const argv of [
        ['bash', 'noop.sh', '-c', 'git push origin main'],
        ['bash', '--', '-c', 'git push origin main'],
        ['bash', '-c', '-c', 'git push origin main'],
    ]) {
        assert.deepEqual(extractGitEventsFromCommandSource({ cmd: argv }, ok), [], argv.join(' '));
    }
    assert.equal(extractCommand({ cmd: ['bash', 'noop.sh', '-c', 'git push'] }),
        "bash noop.sh -c 'git push'");
    assert.equal(extractCommand({ cmd: ['bash', '-lc', 'git push origin main'] }), 'git push origin main');
});

test('review: gh booleans follow pflag order — the final value wins', () => {
    const ok = { ...CTX, success: true, exitCode: 0 };
    // Re-arming after an explicit false defers again; an `=0`/`=false`
    // spelling as the final value does not.
    assert.equal(parseGitEventsFromCommand('gh pr merge 12 --squash --auto=false --auto', ok)[0].success,
        undefined);
    assert.equal(parseGitEventsFromCommand('gh pr merge 12 --squash --auto --auto=false', ok)[0].success,
        true);
    // `--disable-auto=0` cancels nothing, so the merge itself is reported.
    assert.equal(parseGitEventsFromCommand('gh pr merge 12 --squash --disable-auto=0', ok)[0].success,
        true);
    // Re-drafting after `--draft=false` leaves nothing published; the `-d`
    // short form carries its value like the long one.
    assert.deepEqual(parseGitEventsFromCommand('gh release edit v1 --draft=false --draft', ok), []);
    assert.equal(parseGitEventsFromCommand('gh release create v1 -d=false', ok)[0].success, true);
    assert.equal(parseGitEventsFromCommand('gh release create v1 --draft=0', ok)[0].success, true);
});

test('review: a release option value is never a draft flag', () => {
    // `--tag` takes a value like `--title`/`--notes`, so a flag spelling
    // inside it stays that option's value.
    assert.deepEqual(parseGitEventsFromCommand('gh release edit v1 --tag "--draft=false"', {
        ...CTX, success: true, exitCode: 0,
    }), []);
});

test('review: one landed merge line does not land another auto-merge in the call', () => {
    const events = parseGitEventsFromCommand('gh pr merge 12 --squash && gh pr merge 13 --squash --auto', {
        ...CTX,
        success: true,
        exitCode: 0,
        output: '✓ Squashed and merged pull request o/r#12 (First)\n'
            + '✓ Pull request o/r#13 will be automatically merged when all requirements are met',
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].success, true, 'the squash merge landed');
    assert.equal(events[1].success, undefined, 'the auto-merge line reports enablement, not a landing');
});
