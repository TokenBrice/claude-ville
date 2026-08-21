import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';

export const AgentAction = Object.freeze({ READ: 'read', WORK: 'work', THINK: 'think', TALK: 'talk', CELEBRATE: 'celebrate' });

export function resolveAgentAction(agent, { chatting = false } = {}) {
    if (chatting || /sendmessage|send_message|message/i.test(String(agent?.currentTool || ''))) return AgentAction.TALK;
    if (agent?.status === AgentStatus.COMPLETED) return AgentAction.CELEBRATE;
    const tool = String(agent?.currentTool || '').toLowerCase();
    if (/read|search|grep|glob|find|rg|sed/.test(tool)) return AgentAction.READ;
    if (/plan|think|reason|ask/.test(tool) || agent?.status === AgentStatus.WAITING) return AgentAction.THINK;
    if (agent?.status === AgentStatus.WORKING || tool) return AgentAction.WORK;
    return null;
}
