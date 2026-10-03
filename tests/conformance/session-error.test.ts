/**
 * The `session.error` shape the official SDK decodes: a refused model request
 * must arrive as `model_request_failed_error` with an object `retry_status`,
 * not as the runtime's local code spelled into `type`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness, type RunningRuntime } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK session.error shape over HTTP', () => {
  it('reports a refused model request as model_request_failed_error with a terminal retry_status', async () => {
    const stub = await startStubModelServer({ failRequests: [1], failStatus: 401 });
    let runtime: RunningRuntime | undefined;
    try {
      runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
      });
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'Hello.' }] }],
      });

      let failure: Awaited<ReturnType<typeof client.beta.sessions.events.list>>['data'][number] | undefined;
      await vi.waitFor(async () => {
        failure = (await client.beta.sessions.events.list(session.id)).data
          .find((event) => event.type === 'session.error');
        expect(failure).toBeDefined();
      }, { timeout: 30_000, interval: 50 });

      expect(failure!.type).toBe('session.error');
      if (failure!.type !== 'session.error') throw new Error('unreachable');
      expect(failure!.error.type).toBe('model_request_failed_error');
      expect(failure!.error.retry_status.type).toBe('terminal');
      // A refused credential is a fixable configuration mistake, not a dead
      // session: the turn is terminal, the session is not.
      expect((await client.beta.sessions.retrieve(session.id)).status).toBe('idle');
      expect(stub.requests).toHaveLength(1);
    } finally {
      await runtime?.stop();
      await stub.close();
    }
  }, 300_000);
});
