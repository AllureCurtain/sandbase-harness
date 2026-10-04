import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK environment update and delete', () => {
  it('updates an environment with metadata patch semantics, then deletes it', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const created = await client.beta.environments.create({
        name: 'sdk-env',
        description: 'before',
        metadata: { keep: '1', drop: '2' },
      });

      const updated = await client.beta.environments.update(created.id, {
        name: 'sdk-env-renamed',
        description: null,
        metadata: { drop: null, added: '3' },
      });
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('sdk-env-renamed');
      expect(updated.metadata).toEqual({ keep: '1', added: '3' });

      const deleted = await client.beta.environments.delete(created.id);
      expect(deleted).toEqual({ id: created.id, type: 'environment_deleted' });
      await expect(client.beta.environments.retrieve(created.id)).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);

  it('refuses to delete the workspace default environment through the official client', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const environments = await client.beta.environments.list();

      const error = await client.beta.environments.delete(environments.data[0]!.id).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Anthropic.ConflictError);
      expect((error as { status: number }).status).toBe(409);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
