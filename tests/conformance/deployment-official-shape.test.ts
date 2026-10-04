import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK deployments over HTTP', () => {
  it('creates a deployment, runs it by hand, and the session executes its initial events', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();

      const deployment = await client.beta.deployments.create({
        name: 'conformance-nightly',
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        initial_events: [
          { type: 'user.message', content: [{ type: 'text', text: 'Say hello from the deployment.' }] },
        ],
      });
      expect(deployment.type).toBe('deployment');
      expect(deployment.id).toMatch(/^depl_/);
      expect(deployment.agent.id).toBe(agents.data[0]!.id);
      expect(deployment.status).toBe('active');
      expect(deployment.schedule).toBeNull();

      const run = await client.beta.deployments.run(deployment.id);
      expect(run.type).toBe('deployment_run');
      expect(run.id).toMatch(/^drun_/);
      expect(run.deployment_id).toBe(deployment.id);
      expect(run.trigger_context.type).toBe('manual');
      expect(run.error).toBeNull();
      expect(run.session_id).toBeTruthy();

      // The run's session is a real session: the initial event starts the turn
      // and the agent answers, which is what separates a deployment that runs
      // from one that merely files an idle session.
      const session = await client.beta.sessions.retrieve(run.session_id!);
      await vi.waitFor(async () => {
        const events = await client.beta.sessions.events.list(session.id);
        const types = events.data.map((event) => event.type);
        expect(types).toContain('user.message');
        expect(types).toContain('agent.message');
        expect((await client.beta.sessions.retrieve(session.id)).status).toBe('idle');
      }, { timeout: 30_000, interval: 100 });

      const listed = await client.beta.deploymentRuns.list({ deployment_id: deployment.id });
      expect(listed.data.map((entry) => entry.id)).toEqual([run.id]);
      expect((await client.beta.deploymentRuns.retrieve(run.id)).session_id).toBe(session.id);

      // A manual run answers at the published path for the update verb too.
      const renamed = await client.beta.deployments.update(deployment.id, { name: 'conformance-renamed' });
      expect(renamed.name).toBe('conformance-renamed');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
