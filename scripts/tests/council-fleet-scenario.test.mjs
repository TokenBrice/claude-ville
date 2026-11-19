import test from 'node:test';
import assert from 'node:assert/strict';

import { getWorldScenario, listWorldScenarios } from '../../claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js';

// FK-8: `?sim=1&scenario=council-fleet` is the fleet repro. An unknown id
// silently falls back to the default scenario, so pin the registration and
// the crew shape the sidebar, squad marks and crew wait read.
test('council-fleet is registered with one lead and a crew of 20', () => {
    assert.ok(listWorldScenarios().some((scenario) => scenario.id === 'council-fleet'));
    const scenario = getWorldScenario('council-fleet');
    assert.equal(scenario.id, 'council-fleet');
    const leads = scenario.agents.filter((agent) => !agent.parentId);
    assert.equal(leads.length, 1);
    const [lead] = leads;
    assert.equal(lead.turnState, 'tool_pending');
    assert.equal(lead.pendingTool, 'Poll');
    assert.deepEqual(lead.backgroundPending.kinds, ['teammate']);
    assert.equal(lead.backgroundPending.count, 4);
    assert.equal(lead.script.tool, 'Poll');
    assert.ok(Number.isFinite(lead.script.since));

    const crew = scenario.agents.filter((agent) => agent.parentId === lead.id);
    assert.equal(crew.length, scenario.metadata.expectedCrewSize);
    assert.equal(crew.length, 20);

    const teammates = crew.filter((agent) => agent.agentColor);
    assert.deepEqual(teammates.map((agent) => agent.agentColor), ['blue', 'green', 'yellow', 'purple']);
    for (const mate of teammates) {
        assert.equal(mate.effort, 'xhigh');
        assert.equal(mate.teamName, `session-${lead.id}`);
    }

    const jobs = crew.filter((agent) => agent.subagentKind === 'mcp');
    assert.equal(jobs.length, 4);
    for (const job of jobs) {
        assert.equal(job.provider, 'codex');
        assert.equal(job.model, 'gpt-6.2-astra');
        assert.notEqual(job.projectPath, lead.projectPath, 'MCP jobs run in their own directory');
    }

    const workflow = crew.filter((agent) => agent.agentType === 'workflow-subagent');
    assert.equal(workflow.length, 12);
    assert.ok(workflow.every((agent) => agent.workflowId === 'wf-council-sweep'));
});
