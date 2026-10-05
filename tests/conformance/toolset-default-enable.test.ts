import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('bare agent_toolset_20260401', () => {
  it('offers the built-in tools to the model, per the published default', async () => {
    // Including the toolset enables every built-in; `configs` only reconfigure
    // or disable. An agent created with a bare toolset used to expose no tools
    // at all — the model answered in text instead of acting.
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const environments = await client.beta.environments.list();
      const agent = await client.beta.agents.create({
        name: 'bare-toolset-agent',
        model: 'conformance-model',
        tools: [{ type: 'agent_toolset_20260401' }] as never,
      });
      const session = await client.beta.sessions.create({
        agent: agent.id,
        environment_id: environments.data[0]!.id,
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Look around.' }] }],
      });

      await vi.waitFor(async () => {
        const detail = await client.beta.sessions.retrieve(session.id);
        expect(['idle', 'terminated']).toContain(detail.status);
      }, { timeout: 60_000, interval: 250 });

      const offered = new Set(
        (stub.requests[0]?.tools ?? []).map((tool) => tool.function?.name).filter(Boolean),
      );
      for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch']) {
        expect(offered, name).toContain(name);
      }
      // web_search is implicitly enabled by the toolset but has no provider:
      // accepted at admission, never offered to the model.
      expect(offered).not.toContain('web_search');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
