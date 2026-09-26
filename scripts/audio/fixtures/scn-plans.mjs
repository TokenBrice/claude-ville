// SCN scenario fixtures (ported from the SCN notes, scn-snippets/plans.mjs):
// what the village does during each long real-app capture — the probe's
// `--soak` plays `scn-session-ambient-10min` and `scn-session-bgm-10min`.
// Times are seconds after the sound toggle click (t = 0 is the first enable).
// Every action goes through public/dev surfaces of the real app:
//   step   → app.agentSimulator._applyStep(step)   (the ?sim=1 fixture driver)
//   add    → app.agentSimulator._addAgent(spec)
//   remove → app.agentSimulator._removeAgent(id)
//   hour / weather → window.__claudeVilleAtmosphere
//   scenario → agentSimulator.stop(); agentSimulator.start(id)  (replay a QA fixture with sound on)
//   mode   → a real click on #topbarSoundMode
//   blur / focus → the controller's own window handlers (init.js swallows real blur events)
//   hide / show  → document.hidden override + a real visibilitychange event

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TOOLS = [
    ['Read', 'file_path=/src/world/forge.js'],
    ['Grep', 'pattern=AudioDirector'],
    ['Edit', 'file_path=/src/audio/CueKit.js'],
    ['Bash', 'command=npm test'],
    ['Read', 'file_path=/docs/design-decisions.md'],
    ['WebFetch', 'url=https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API'],
    ['TodoWrite', 'todos=3'],
    ['Edit', 'file_path=/src/presentation/App.js'],
    ['Glob', 'pattern=**/*.js'],
    ['Task', 'description=review the mixer'],
    ['Bash', 'command=git status'],
    ['Write', 'file_path=/src/audio/Transport.js'],
];

const W = 'working', WU = 'waiting_on_user', ER = 'errored', RL = 'rate_limited', ID = 'idle', CO = 'completed';

// A believable 10-minute stretch of a workday: six sessions already running
// (the mixed-tools cast), arrivals and departures, one question left
// unanswered for four minutes, one answered in 18 s, an error that recovers,
// a push, a failed push, a lull where everything goes quiet, then work
// resumes and a rate limit lands.
export function busySessionActions(seconds = 600, seed = 0x5c4e) {
    const rnd = mulberry32(seed);
    const acts = [];
    // Episodes that take an agent out of the tool rotation: [id, from, to].
    const busyUntil = new Map();
    const episodes = [];
    const ep = (t, id, status, extra = {}) => { episodes.push({ t, id, status, extra }); };

    const cast = ['sim1', 'sim2', 'codex-sim3', 'sim4', 'sim5', 'codex-sim6'];
    const joiners = [
        { t: 45, spec: { id: 'scn-wren', name: 'Wren', status: W, currentTool: 'Read', currentToolInput: 'file_path=/README.md', position: { tileX: 18, tileY: 24 } } },
        { t: 120, spec: { id: 'scn-quill', name: 'Quill', provider: 'codex', model: 'gpt-5', status: W, currentTool: 'Grep', currentToolInput: 'pattern=TODO', position: { tileX: 22, tileY: 27 } } },
        { t: 330, spec: { id: 'scn-moss', name: 'Moss', status: W, currentTool: 'Edit', currentToolInput: 'file_path=/src/a.js', position: { tileX: 12, tileY: 20 } } },
        { t: 528, spec: { id: 'scn-fern', name: 'Fern', status: W, currentTool: 'Read', currentToolInput: 'file_path=/src/b.js', position: { tileX: 20, tileY: 22 } } },
    ];
    const leavers = [{ t: 230, id: 'scn-quill' }, { t: 400, id: 'sim4' }];

    for (const j of joiners) acts.push({ t: j.t, add: j.spec, label: `arrive ${j.spec.name}` });
    for (const l of leavers) acts.push({ t: l.t, remove: l.id, label: `leave ${l.id}` });

    // Status episodes.
    ep(20, 'sim2', WU, { tool: 'AskUserQuestion', input: 'question=Which mixer law?', lastMessage: 'Which mixer law should I use?' });
    ep(260, 'sim2', W);                     // operator answers after 4 min
    ep(150, 'codex-sim6', ER, { lastMessage: 'Command failed with exit code 1' });
    ep(195, 'codex-sim6', W);               // recovers
    ep(300, 'sim5', WU, { tool: 'AskUserQuestion', input: 'question=Push to main?', lastMessage: 'OK to push?' });
    ep(318, 'sim5', W);                     // answered in 18 s
    // The lull: everyone finishes.
    const lull = [['sim1', 440], ['sim2', 446], ['codex-sim3', 452], ['sim5', 458], ['codex-sim6', 464], ['scn-wren', 468], ['scn-moss', 472]];
    for (const [id, t] of lull) ep(t, id, CO);
    // Work resumes.
    ep(560, 'sim1', W); ep(565, 'sim2', W); ep(570, 'scn-moss', W);
    ep(575, 'codex-sim3', RL, { lastMessage: 'Rate limit reached' });

    for (const e of episodes) {
        acts.push({ t: e.t, step: { agentId: e.id, status: e.status, tool: e.extra.tool ?? (e.status === W ? 'Read' : null), input: e.extra.input ?? null, lastMessage: e.extra.lastMessage }, label: `${e.id} → ${e.status}` });
    }

    // Git outcomes (silent in the shipped audio; visible in the World).
    acts.push({ t: 282, step: { agentId: 'sim5', status: W, tool: 'Bash', input: 'command=git push origin main', gitEvent: { id: 'scn-push-1', type: 'push', command: 'git push origin main', targetRef: 'main', branch: 'main', success: true, exitCode: 0, project: '/sim/repos/claude-ville' } }, label: 'push ok (sim5)' });
    acts.push({ t: 362, step: { agentId: 'sim1', status: W, tool: 'Bash', input: 'command=git push origin main', gitEvent: { id: 'scn-push-2', type: 'push', command: 'git push origin main', targetRef: 'main', branch: 'main', success: false, exitCode: 1, stderr: 'rejected (non-fast-forward)', project: '/sim/repos/claude-ville' } }, label: 'push FAILED (sim1)' });

    // Tool rotation for working agents: a new tool every 6–25 s.
    const statusAt = (id, t) => {
        let s = cast.includes(id) ? W : null;
        const j = joiners.find(x => x.spec.id === id);
        if (j) s = t >= j.t ? W : null;
        const l = leavers.find(x => x.id === id);
        if (l && t >= l.t) return null;
        for (const e of episodes.filter(x => x.id === id && x.t <= t).sort((a, b) => a.t - b.t)) s = e.status;
        return s;
    };
    for (const id of [...cast, ...joiners.map(j => j.spec.id)]) {
        let t = 3 + rnd() * 10;
        while (t < seconds) {
            if (statusAt(id, t) === W) {
                const [tool, input] = TOOLS[Math.floor(rnd() * TOOLS.length)];
                acts.push({ t: Number(t.toFixed(2)), step: { agentId: id, status: W, tool, input }, quiet: true });
            }
            t += 6 + rnd() * 19;
        }
    }
    return acts.sort((a, b) => a.t - b.t);
}

export const PLANS = {
    // Two 10-minute sessions over the identical village script.
    'scn-session-ambient-10min': {
        scenario: 'mixed-tools', hour: 10.4, weather: 'clear', mode: 'ambient', seconds: 600,
        actions: () => busySessionActions(600),
    },
    'scn-session-bgm-10min': {
        scenario: 'mixed-tools', hour: 10.4, weather: 'clear', mode: 'bgm', seconds: 600,
        actions: () => busySessionActions(600),
    },
    // A compressed day: the same busy village, one clock hour every 16 s.
    'scn-dayarc-ambient-5min': {
        scenario: 'mixed-tools', hour: 5.0, weather: 'clear', mode: 'ambient', seconds: 312,
        actions: () => {
            const acts = busySessionActions(312, 0xda7).filter(a => a.quiet || a.add);
            for (let i = 0; i < 20; i++) acts.push({ t: 4 + i * 16, hour: 5 + i, label: `${5 + i}:00` });
            acts.push({ t: 196, weather: 'rain', label: 'rain' });
            acts.push({ t: 244, weather: 'clear', label: 'clear' });
            return acts.sort((a, b) => a.t - b.t);
        },
    },
    // Scenario moments: enable sound over an empty island, then replay the fixture live.
    'scn-moment-team-gather': { scenario: 'no-agents', hour: 11.3, weather: 'clear', mode: 'ambient', seconds: 60, actions: () => [{ t: 6, scenario: 'team-gather', label: 'team-gather starts' }] },
    'scn-moment-release-parade': { scenario: 'no-agents', hour: 14.3, weather: 'clear', mode: 'ambient', seconds: 60, actions: () => [{ t: 6, scenario: 'release-parade', label: 'release-parade starts' }] },
    'scn-moment-failed-push': { scenario: 'no-agents', hour: 16.3, weather: 'clear', mode: 'ambient', seconds: 60, actions: () => [{ t: 6, scenario: 'failed-push', label: 'failed-push starts' }] },
    'scn-moment-storm-night': { scenario: 'no-agents', hour: 23.2, weather: 'storm', mode: 'ambient', seconds: 60, actions: () => [{ t: 6, scenario: 'storm-night-reduced-motion', label: 'storm-night starts' }] },
    'scn-moment-waiting-ambient': { scenario: 'no-agents', hour: 10.4, weather: 'clear', mode: 'ambient', seconds: 75, actions: () => [{ t: 6, scenario: 'waiting-on-user', label: 'waiting-on-user starts' }] },
    'scn-moment-waiting-bgm': { scenario: 'no-agents', hour: 10.4, weather: 'clear', mode: 'bgm', seconds: 75, actions: () => [{ t: 6, scenario: 'waiting-on-user', label: 'waiting-on-user starts' }] },
    // Lived UX: first enable, mode switch both ways, blur/return, hidden-tab summons, return.
    'scn-ux-journey': {
        scenario: 'mixed-tools', hour: 10.4, weather: 'clear', mode: 'ambient', seconds: 170,
        actions: () => {
            const acts = busySessionActions(170, 0x0e).filter(a => a.quiet);
            acts.push({ t: 35, mode: 'bgm', label: 'click → BGM' });
            acts.push({ t: 70, mode: 'ambient', label: 'click → AMBIENT' });
            acts.push({ t: 95, blur: true, label: 'window blur (terminal)' });
            acts.push({ t: 105, step: { agentId: 'sim2', status: WU, tool: 'AskUserQuestion', input: 'question=Proceed?', lastMessage: 'Proceed?' }, label: 'sim2 needs you (blurred)' });
            acts.push({ t: 120, focus: true, label: 'window focus (return)' });
            acts.push({ t: 130, hide: true, label: 'tab hidden' });
            acts.push({ t: 140, step: { agentId: 'sim5', status: WU, tool: 'AskUserQuestion', input: 'question=Merge?', lastMessage: 'Merge?' }, label: 'sim5 needs you (hidden)' });
            acts.push({ t: 155, show: true, label: 'tab visible (return)' });
            return acts.sort((a, b) => a.t - b.t);
        },
    },
};
