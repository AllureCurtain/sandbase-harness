/**
 * Grader-facing transcript of a session's agent output.
 *
 * Only what the agent produced is graded: its messages, its tool calls and their
 * results. The grader's context is deliberately not the agent's context — the
 * system prompt, the session's lifecycle events, the outcome instruction itself
 * and the grader's own earlier verdicts are all excluded. The last of those
 * matters most: including a previous verdict would anchor the next evaluation to
 * it, and a grader that agrees with itself is not measuring the deliverable.
 */

import type { SessionEvent } from '@/types/session.js';

export function outcomeTranscript(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'agent.message':
        lines.push(`assistant: ${textOf(event.content)}`);
        break;
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use': {
        const block = event.content?.find((item) => item.type === 'tool_use') as
          | { type: 'tool_use'; name: string; input: unknown }
          | undefined;
        if (block) lines.push(`tool_call: ${block.name} ${JSON.stringify(block.input)}`);
        break;
      }
      case 'agent.tool_result':
      case 'agent.mcp_tool_result': {
        const block = event.content?.find((item) => item.type === 'tool_result') as
          | { type: 'tool_result'; content: unknown }
          | undefined;
        if (block) {
          const value = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          lines.push(`tool_result: ${value}`);
        }
        break;
      }
      case 'user.custom_tool_result':
        lines.push(`tool_result: ${textOf(event.content)}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

function textOf(content: SessionEvent['content']): string {
  if (!content) return '';
  return content
    .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('\n');
}
