import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import type { EnvironmentConfig, SandboxInstance } from '@/types/sandbox.js';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

function scriptedCustomModel(): LanguageModel {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-custom-tool',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (turn === 1) {
              const args = JSON.stringify({ customer_id: 'cust_42' });
              controller.enqueue({ type: 'tool-input-start', id: 'custom_call_1', toolName: 'lookup_customer' });
              controller.enqueue({ type: 'tool-input-delta', id: 'custom_call_1', delta: args });
              controller.enqueue({ type: 'tool-input-end', id: 'custom_call_1' });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'custom_call_1',
                toolName: 'lookup_customer',
                input: args,
              });
              controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text_1' });
              controller.enqueue({ type: 'text-delta', id: 'text_1', delta: 'Customer lookup completed.' });
              controller.enqueue({ type: 'text-end', id: 'text_1' });
              controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            }
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for custom tool turn'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe('DefaultSessionExecutor custom tool closure', () => {
  let db: Database | undefined;
  let workspace: string | undefined;

  afterEach(async () => {
    db?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('pauses for an external result and resumes the model with the paired tool result', async () => {
    workspace = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'ma-custom-exec-'));
    db = new Database(join(workspace, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_custom', 'custom-agent', '{}')");

    const manager = new SessionManager(db);
    const registry = new ModelRegistry();
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    const model = scriptedCustomModel();
    (registry as any).createModel = () => model;
    const provider = new LocalSandboxProvider(workspace);
    const agent = {
      name: 'custom-agent',
      model: 'scripted',
      system: 'Use the customer lookup tool when needed.',
      tools: [{
        type: 'custom_toolset' as const,
        configs: [{
          name: 'lookup_customer',
          description: 'Look up a customer in the host application.',
          parameters: {
            type: 'object',
            properties: { customer_id: { type: 'string' } },
            required: ['customer_id'],
          },
        }],
      }],
    };
    const executor = new DefaultSessionExecutor({
      agents: [agent],
      modelRegistry: registry,
      sandboxProvider: provider,
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);

    const session = manager.create({ agent: 'agent_custom' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });

    await waitFor(() => manager.get(session.id)?.status === 'requires_action');
    const firstEvents = manager.getEventLogger().getEvents(session.id);
    expect(firstEvents.some((event) => event.type === 'agent.custom_tool_use')).toBe(true);
    expect(firstEvents.some((event) => event.type === 'agent.tool_use')).toBe(false);

    await manager.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: 'custom_call_1',
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    });

    await waitFor(() => manager.get(session.id)?.status === 'paused');
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events.filter((event) => event.type === 'agent.custom_tool_use')).toHaveLength(1);
    expect(events.some((event) => event.type === 'agent.message' && JSON.stringify(event.content).includes('Customer lookup completed.'))).toBe(true);
    await executor.cleanupSession(session.id);
  });
});
