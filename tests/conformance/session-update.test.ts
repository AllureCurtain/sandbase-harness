import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK session update', () => {
  it('updates the tool list, metadata, and title through the published sessions resource', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        metadata: { origin: 'conformance' },
      });

      const updated = await client.beta.sessions.update(session.id, {
        title: 'Conformance session',
        metadata: { origin: null, purpose: 'sdk-update' },
        agent: {
          tools: [{
            type: 'agent_toolset_20260401',
            configs: [
              { name: 'glob', enabled: true },
              { name: 'read', enabled: true },
            ],
          }],
        },
      });

      expect(updated.id).toBe(session.id);
      expect(updated.title).toBe('Conformance session');
      expect(updated.metadata).toEqual({ purpose: 'sdk-update' });
      const toolset = updated.agent.tools.find((entry) => entry.type === 'agent_toolset_20260401');
      expect(toolset?.type === 'agent_toolset_20260401'
        ? toolset.configs.map((config) => config.name)
        : []).toEqual(['glob', 'read']);

      const events = await client.beta.sessions.events.list(session.id);
      const updateEvent = events.data.find((event) => event.type === 'session.updated');
      expect(updateEvent).toMatchObject({
        type: 'session.updated',
        title: 'Conformance session',
        metadata: { purpose: 'sdk-update' },
      });
      const updateAgent = updateEvent && 'agent' in updateEvent ? updateEvent.agent : undefined;
      expect(updateAgent && 'tools' in updateAgent ? updateAgent.tools : []).toHaveLength(1);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
