import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validateAgentDefinition } from '@/core/agent/schema.js';
import { ToolResolver } from '@/core/session/tool-resolver.js';
import { eventsToMessages } from '@/core/session/events-to-messages.js';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import type { ContentBlock, CMAEventType } from '@/types/cma-protocol.js';
import type { SessionEvent } from '@/types/session.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { SandboxInstance } from '@/types/sandbox.js';

const baseAgent = {
  name: 'custom-demo',
  model: 'demo-model',
  system: 'Use external tools when available.',
};

const customTool = {
  type: 'custom_toolset' as const,
  configs: [{
    name: 'lookup_customer',
    description: 'Look up a customer in the host application.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string' } },
      required: ['customer_id'],
    },
    permission_policy: { type: 'always_allow' as const },
  }],
};

function event(type: CMAEventType, content?: ContentBlock[], metadata?: Record<string, unknown>): SessionEvent {
  return {
    id: `sevt_${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess_custom',
    seq: 1,
    type,
    content,
    metadata,
    createdAt: new Date(),
  };
}

function sandbox(): SandboxInstance {
  return {
    sessionId: 'sess_custom',
    async execute() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
    async writeFile() {},
    async readFile() { return ''; },
    async listFiles() { return []; },
    async cleanup() {},
  };
}

describe('custom tool CMA loop', () => {
  it('exposes custom tools to the model without a local execute function', async () => {
    const resolver = new ToolResolver({
      delegationService: { buildDelegationTools: () => ({}) } as any,
    });
    const agent = validateAgentDefinition({ ...baseAgent, tools: [customTool] }).data as AgentDefinition;
    const tools = await resolver.resolveTools({
      id: 'sess_custom', agentId: 'agent_custom', agentName: agent.name,
      environmentId: 'env_default', status: 'running', createdAt: new Date(), updatedAt: new Date(),
    }, agent, sandbox());

    expect(tools.lookup_customer).toMatchObject({ description: customTool.configs[0].description, parameters: customTool.configs[0].input_schema });
    expect(tools.lookup_customer.execute).toBeUndefined();
  });

  it('maps a custom call and inbound result to paired model messages', () => {
    const callId = 'call_custom_1';
    const messages = eventsToMessages([
      event('agent.custom_tool_use', [{ type: 'tool_use', id: callId, name: 'lookup_customer', input: { customer_id: 'c1' } }]),
      event('user.custom_tool_result', [{ type: 'text', text: '{"name":"Ada"}' }], { custom_tool_use_id: callId }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: 'lookup_customer' }] });
    expect(messages[1]).toMatchObject({ role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'lookup_customer', output: { type: 'text', value: '{"name":"Ada"}' } }] });
  });

  describe('pending result validation', () => {
    let db: Database;
    let manager: SessionManager;
    let temp: string;

    beforeEach(() => {
      temp = mkdtempSync(join(tmpdir(), 'custom-tool-test-'));
      db = new Database(join(temp, 'test.db'));
      db.runMigrations();
      db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
      db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_custom', 'custom-demo', '{}')");
      manager = new SessionManager(db);
    });

    afterEach(() => {
      db.close();
      rmSync(temp, { recursive: true, force: true });
    });

    it('rejects stale and duplicate custom results before append', async () => {
      const session = manager.create({ agent: 'agent_custom' });
      manager.getEventLogger().append(session.id, {
        type: 'agent.custom_tool_use',
        content: [{ type: 'tool_use', id: 'call_pending', name: 'lookup_customer', input: { customer_id: 'c1' } }],
      });

      await expect(manager.sendEvent(session.id, {
        type: 'user.custom_tool_result',
        custom_tool_use_id: 'unknown',
        content: [{ type: 'text', text: 'nope' }],
      })).rejects.toThrow('does not reference a pending custom tool call');

      await expect(manager.sendEvent(session.id, {
        type: 'user.custom_tool_result',
        custom_tool_use_id: 'call_pending',
        content: [{ type: 'text', text: 'ok' }],
      })).resolves.toEqual({ accepted: true });

      await expect(manager.sendEvent(session.id, {
        type: 'user.custom_tool_result',
        custom_tool_use_id: 'call_pending',
        content: [{ type: 'text', text: 'duplicate' }],
      })).rejects.toThrow('is not pending');
    });
  });
});
