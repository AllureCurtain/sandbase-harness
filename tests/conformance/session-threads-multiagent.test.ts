/**
 * `threads.list` after a coordinator dispatch — PR 3.3 conformance.
 *
 * The orchestration doc's `:301-320` flow, driven through the official SDK:
 * create a rostered coordinator and a member agent, open a session, and let the
 * coordinator's first turn call `send_to_agent`. Once the exchange settles,
 * `threads.list` answers two threads — the primary and the spawned child —
 * each with its own agent identity.
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK sessions.threads — multiagent', () => {
  it('lists the primary thread and a spawned child after send_to_agent', async () => {
    const stub = await startStubModelServer({
      // The coordinator's first reply issues `send_to_agent`; every later reply
      // that already holds a tool result falls through to the stub's text, so
      // the coordinator finishes and the child — which mounts no
      // `send_to_agent` — answers its errored call with text and ends its turn.
      toolCalls: [{ name: 'send_to_agent', arguments: { agent: 'reviewer', message: 'review this' } }],
    });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', authToken: null, maxRetries: 0 });
      const environments = await client.beta.environments.list();

      const worker = await client.beta.agents.create({
        name: 'reviewer',
        model: 'conformance-model',
        system: 'You are the reviewer child.',
      });
      const coordinator = await client.beta.agents.create({
        name: 'coordinator',
        model: 'conformance-model',
        system: 'You are the coordinator.',
        multiagent: {
          type: 'coordinator',
          agents: [{ type: 'agent', id: worker.id }],
        },
      });

      const session = await client.beta.sessions.create({
        agent: coordinator.id,
        environment_id: environments.data[0]!.id,
      });
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'start' }] }],
      });

      // Wait for the child to exist and the session to settle idle.
      const deadline = Date.now() + 60_000;
      let listed: Awaited<ReturnType<typeof client.beta.sessions.threads.list>> | undefined;
      while (Date.now() < deadline) {
        listed = await client.beta.sessions.threads.list(session.id);
        const settled = await client.beta.sessions.events.list(session.id, { limit: 100 });
        if (listed.data.length >= 2 && settled.data.some((e) => e.type === 'session.status_idle')) break;
        await new Promise((r) => setTimeout(r, 300));
      }

      expect(listed).toBeDefined();
      expect(listed!.data.length).toBeGreaterThanOrEqual(2);
      const primary = listed!.data.find((t) => t.parent_thread_id === null)!;
      const child = listed!.data.find((t) => t.parent_thread_id === primary.id)!;
      expect(primary.type).toBe('session_thread');
      expect(child.type).toBe('session_thread');
      expect(child.parent_thread_id).toBe(primary.id);
      expect(child.agent.type).toBe('agent');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 180_000);
});
