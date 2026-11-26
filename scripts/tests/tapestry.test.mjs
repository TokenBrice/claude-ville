import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TAPESTRY_ALLOWED_LABELS,
    TAPESTRY_BANDS,
    TAPESTRY_DATE_RE,
    TAPESTRY_HEIGHT,
    TAPESTRY_INT_RE,
    TAPESTRY_MASTHEAD_RE,
    TAPESTRY_WIDTH,
    extractTapestryStats,
    formatTapestryDate,
    formatTapestryInt,
    formatTapestryMasthead,
    isAllowedTapestryText,
    renderChronicleTapestry,
    tapestryFileName,
    tapestryText,
} from '../../claudeville/src/presentation/shared/ChronicleTapestry.js';

function createRecordingCanvas(width = TAPESTRY_WIDTH, height = TAPESTRY_HEIGHT) {
    const fillTextCalls = [];
    const strokeTextCalls = [];
    const ops = [];

    const ctx = {
        font: '',
        fillStyle: '',
        strokeStyle: '',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        imageSmoothingEnabled: true,
        globalAlpha: 1,
        save() { ops.push(['save']); },
        restore() { ops.push(['restore']); },
        fillRect(x, y, w, h) { ops.push(['fillRect', x, y, w, h, this.fillStyle]); },
        clearRect(x, y, w, h) { ops.push(['clearRect', x, y, w, h]); },
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
            ops.push(['drawImage', img?.tag || 'surface', sx, sy, sw, sh, dx, dy, dw, dh, this.imageSmoothingEnabled]);
        },
        fillText(text, x, y) {
            const call = { text, x, y, font: this.font, fillStyle: this.fillStyle };
            fillTextCalls.push(call);
            ops.push(['fillText', text, x, y]);
        },
        strokeText(text, x, y) {
            const call = { text, x, y, font: this.font, strokeStyle: this.strokeStyle };
            strokeTextCalls.push(call);
            ops.push(['strokeText', text, x, y]);
        },
    };

    const canvas = {
        width,
        height,
        getContext(kind) {
            assert.equal(kind, '2d');
            return ctx;
        },
    };

    return { canvas, ctx, fillTextCalls, strokeTextCalls, ops };
}

test('tapestry layout constants match Spec 04 §4.11 exact 1200x1600 bands', () => {
    assert.equal(TAPESTRY_WIDTH, 1200);
    assert.equal(TAPESTRY_HEIGHT, 1600);
    assert.equal(TAPESTRY_BANDS.border.inset, 24);
    assert.deepEqual({ y: TAPESTRY_BANDS.masthead.y, end: TAPESTRY_BANDS.masthead.y + TAPESTRY_BANDS.masthead.height }, { y: 48, end: 128 });
    assert.deepEqual({ y: TAPESTRY_BANDS.diorama.y, end: TAPESTRY_BANDS.diorama.y + TAPESTRY_BANDS.diorama.height, w: TAPESTRY_BANDS.diorama.width, h: TAPESTRY_BANDS.diorama.height }, { y: 152, end: 800, w: 1152, h: 648 });
    assert.deepEqual({ y: TAPESTRY_BANDS.sunArc.y, end: TAPESTRY_BANDS.sunArc.y + TAPESTRY_BANDS.sunArc.height }, { y: 824, end: 896 });
    assert.deepEqual({ y: TAPESTRY_BANDS.ledger.y, end: TAPESTRY_BANDS.ledger.y + TAPESTRY_BANDS.ledger.height }, { y: 920, end: 1100 });
    assert.deepEqual({ y: TAPESTRY_BANDS.loom.y, end: TAPESTRY_BANDS.loom.y + TAPESTRY_BANDS.loom.height }, { y: 1124, end: 1340 });
    assert.deepEqual({ y: TAPESTRY_BANDS.cast.y, end: TAPESTRY_BANDS.cast.y + TAPESTRY_BANDS.cast.height }, { y: 1364, end: 1552 });
});

test('tapestryText strictly enforces the zero-PII allowlist (labels, dates, integers only)', () => {
    const { ctx, fillTextCalls } = createRecordingCanvas();

    // Allowed values pass and reach ctx.fillText.
    const allowed = [
        'CLAUDEVILLE CHRONICLE',
        'CLAUDEVILLE CHRONICLE · THU 19 NOV 2026',
        'THU 19 NOV 2026',
        'COMMITS',
        'PUSHES',
        'MENDS',
        'TURNS',
        'HOURS',
        'VILLAGERS',
        '0',
        '42',
        '1,234',
        99,
    ];
    for (const item of allowed) {
        tapestryText(ctx, item, 100, 100);
    }
    assert.equal(fillTextCalls.length, allowed.length);
    assert.equal(fillTextCalls.at(-1).text, '99');

    // Every PII or unapproved string MUST throw synchronously before ctx.fillText.
    const rejected = [
        'Moss',
        'Alice',
        'claude-opus-4-7',
        'acme/private-repo',
        'claude-ville',
        'feat/billing-secret',
        '/home/ahirice/.env',
        'src/auth/password.js',
        'Fix the production JWT key',
        'COMMITS: 5',
        '5 commits',
        'COMMITS\nAlice',
        'THU 32 NOV 2026',
        'THU 0 NOV 2026',
        '-5',
        '12.5',
        '',
        '   ',
        null,
        undefined,
    ];
    const before = fillTextCalls.length;
    for (const bad of rejected) {
        assert.equal(isAllowedTapestryText(bad), false, `expected rejected: ${JSON.stringify(bad)}`);
        assert.throws(() => tapestryText(ctx, bad, 100, 100), /zero-PII guard rejected/);
    }
    assert.equal(fillTextCalls.length, before, 'no rejected text may ever reach ctx.fillText');
});

test('renderChronicleTapestry leaks ZERO PII even when fed rich PII-laden inputs', () => {
    const piiTokens = [
        'SecretAgentAlice',
        'BillingBotBob',
        'Moss',
        'acme/private-ledger',
        'corp/payroll',
        'feature/stripe-keys',
        'AWS_SECRET_ACCESS_KEY',
        '/etc/shadow',
        '/Users/alice/corp/secrets.ts',
        'Deploy private billing fix',
        'claude-opus-4-7',
        'super secret prompt',
        'my-branch',
    ];

    const richPiiInput = {
        dateKey: '2026-11-19',
        summary: {
            commits: 14,
            pushes: 3,
            mends: 2,
            completed: 1205,
            hours: 7,
            agents: ['SecretAgentAlice', 'BillingBotBob', 'Moss'],
            projects: ['acme/private-ledger', 'corp/payroll'],
            repoName: 'acme/private-ledger',
            branch: 'feature/stripe-keys',
            prompt: 'Deploy private billing fix',
        },
        events: [
            {
                kind: 'commit',
                ts: new Date(2026, 10, 19, 9, 15).getTime(),
                agentId: 'agent-alice',
                agentName: 'SecretAgentAlice',
                project: 'acme/private-ledger',
                branch: 'feature/stripe-keys',
                label: 'rotate AWS_SECRET_ACCESS_KEY',
                command: 'cat /etc/shadow',
                filePath: '/Users/alice/corp/secrets.ts',
            },
            {
                kind: 'push',
                ts: new Date(2026, 10, 19, 14, 40).getTime(),
                agentId: 'agent-bob',
                agentName: 'BillingBotBob',
                project: 'corp/payroll',
                branch: 'my-branch',
                label: 'push origin my-branch',
            },
            {
                kind: 'waiting',
                ts: new Date(2026, 10, 19, 16, 10).getTime(),
                agentId: 'agent-moss',
                agentName: 'Moss',
                tool: 'Bash',
                prompt: 'Deploy private billing fix',
            },
            {
                kind: 'mended',
                ts: new Date(2026, 10, 19, 16, 30).getTime(),
                agentId: 'agent-alice',
                agentName: 'SecretAgentAlice',
                label: 'npm test',
            },
        ],
        cast: [
            {
                name: 'SecretAgentAlice',
                agentName: 'SecretAgentAlice',
                model: 'claude-opus-4-7',
                repo: 'acme/private-ledger',
                branch: 'feature/stripe-keys',
                path: '/Users/alice/corp/secrets.ts',
                prompt: 'super secret prompt',
                trimColor: '#79d975',
                canvas: { width: 64, height: 64, tag: 'bust-alice' },
            },
            {
                name: 'BillingBotBob',
                agentName: 'BillingBotBob',
                model: 'gpt-5-codex',
                repo: 'corp/payroll',
                trimColor: '#5ba49c',
            },
        ],
        repoColors: ['#b3647e', '#489877', 'not-a-color-acme/private-ledger'],
        diorama: { width: 1152, height: 648, tag: 'label-free-diorama' },
    };

    const { canvas, fillTextCalls, strokeTextCalls } = createRecordingCanvas();
    const result = renderChronicleTapestry({ ...richPiiInput, canvas });

    assert.equal(result.width, 1200);
    assert.equal(result.height, 1600);
    assert.equal(result.dateLabel, 'THU 19 NOV 2026');
    assert.equal(result.masthead, 'CLAUDEVILLE CHRONICLE · THU 19 NOV 2026');
    assert.equal(result.fileName, 'claudeville-chronicle-2026-11-19.png');
    assert.equal(strokeTextCalls.length, 0, 'Tapestry must never call strokeText');

    // Exact expected text calls: 1 masthead + 6 stat numbers + 6 stat labels = 13.
    assert.equal(fillTextCalls.length, 13);

    for (const call of fillTextCalls) {
        const s = String(call.text);
        const matchesAllowlist = TAPESTRY_ALLOWED_LABELS.has(s)
            || TAPESTRY_DATE_RE.test(s)
            || TAPESTRY_MASTHEAD_RE.test(s)
            || TAPESTRY_INT_RE.test(s);
        assert.ok(matchesAllowlist, `fillText value failed zero-PII allowlist: ${JSON.stringify(s)}`);

        const lower = s.toLowerCase();
        for (const token of piiTokens) {
            assert.equal(lower.includes(token.toLowerCase()), false, `PII token ${token} leaked in ${JSON.stringify(s)}`);
        }

        // Cast band (1364..1552), Diorama (152..800), Sun-arc (824..896), Loom (1124..1340) must have ZERO captions.
        assert.equal(call.y >= TAPESTRY_BANDS.cast.y && call.y <= TAPESTRY_BANDS.cast.y + TAPESTRY_BANDS.cast.height, false, 'cast band must have zero captions');
        assert.equal(call.y >= TAPESTRY_BANDS.diorama.y && call.y <= TAPESTRY_BANDS.diorama.y + TAPESTRY_BANDS.diorama.height, false, 'diorama band must have zero text');
        assert.equal(call.y >= TAPESTRY_BANDS.loom.y && call.y <= TAPESTRY_BANDS.loom.y + TAPESTRY_BANDS.loom.height, false, 'loom band must have zero text');
    }

    assert.deepEqual(
        fillTextCalls.map((c) => c.text),
        [
            'CLAUDEVILLE CHRONICLE · THU 19 NOV 2026',
            '14', 'COMMITS',
            '3', 'PUSHES',
            '2', 'MENDS',
            '1,205', 'TURNS',
            '7', 'HOURS',
            '3', 'VILLAGERS',
        ],
    );
});

test('renderChronicleTapestry is deterministic and handles empty Loom warp gracefully', () => {
    const input = {
        date: new Date(2026, 10, 19),
        events: [
            { kind: 'commit', ts: new Date(2026, 10, 19, 10, 0).getTime(), agentId: 'a1' },
            { kind: 'completed', ts: new Date(2026, 10, 19, 11, 0).getTime(), agentId: 'a2' },
        ],
        cast: [{ trimColor: '#79d975' }],
    };

    const run1 = createRecordingCanvas();
    const run2 = createRecordingCanvas();
    renderChronicleTapestry({ ...input, canvas: run1.canvas });
    renderChronicleTapestry({ ...input, canvas: run2.canvas });

    assert.deepEqual(run1.ops, run2.ops, 'identical inputs must produce identical draw operations');
    assert.equal(formatTapestryDate('2026-11-19'), 'THU 19 NOV 2026');
    assert.equal(formatTapestryMasthead('2026-11-19'), 'CLAUDEVILLE CHRONICLE · THU 19 NOV 2026');
    assert.equal(formatTapestryInt(1234567), '1,234,567');
    assert.equal(tapestryFileName('2026-11-19'), 'claudeville-chronicle-2026-11-19.png');

    const stats = extractTapestryStats({ events: input.events, cast: input.cast });
    assert.deepEqual(stats, { commits: 1, pushes: 0, mends: 0, turns: 1, hours: 2, villagers: 2 });
});
