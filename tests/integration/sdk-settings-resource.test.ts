/**
 * Integration test: the SDK's canonical runtime settings helpers against the **real** routes.
 *
 * Three defects are pinned here, all measured before the fix:
 *
 * 1. `settings.patch()` sent `PATCH /v1/x/settings`, which is not a mounted verb — the route
 *    is `PUT` — so it answered `404 No route matches this request` on every call.
 * 2. `settings.get()` was typed as a document with `model_provider`, `loop_engine.implemented`,
 *    `storage.metadata.type` and `validation.checks`. No route returns that; it is the
 *    runtime's internal registry report. Every field a reader could reach for was `undefined`
 *    at runtime while type-checking.
 * 3. `settings.validate()` was typed as `{status, checks}` — the shape of `POST /test`, a
 *    **different** route — so reading `result.checks` threw.
 *
 * The client drives a real HTTP listener over real HTTP, so the verb on the wire is the verb
 * asserted, and a recording `fetch` observes the requests without replacing them: every
 * assertion below is about a request that was actually served.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { ManagedAgentsClient, RuntimeSettingsValidationError } from '@/sdk/client.js';

type RealServer = { close: (cb?: () => void) => void; closeAllConnections?: () => void };
type Observed = { method: string; path: string; body?: Record<string, unknown> };

describe('SDK runtime settings resource', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: RealServer | undefined;
  let observed: Observed[] = [];

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    observed = [];
    vi.restoreAllMocks();
  });

  /**
   * A real runtime plus a client whose `fetch` records the request and then makes it for real.
   * Recording and delegating, rather than stubbing, is what makes the method assertions
   * evidence: a stubbed fetch would only prove the client is self-consistent.
   */
  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-sdk-settings-'));
    tmpDir = dir;
    const dataDir = join(dir, '.managed-agents');
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dir, 'test.db'));
    db.runMigrations();

    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      workspace: {
        root: dir,
        dataDir,
        agentsDir: join(dir, 'agents'),
        skillsDir: join(dir, 'skills'),
        configPath: join(dir, 'managed-agents.config.yaml'),
        target: 'local',
      },
    });

    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as RealServer;
        resolve(info.port);
      });
    });

    const client = new ManagedAgentsClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        observed.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
        });
        return fetch(url, init);
      }) as typeof fetch,
    });

    return { client, app };
  }

  it('get() reads the document the route returns, not the registry report', async () => {
    const { client } = await startRuntime();

    const settings = await client.settings.get();

    expect(observed).toEqual([{ method: 'GET', path: '/v1/x/settings' }]);
    // The routes' own fields. These are the assertions that fail against the old type, where
    // every one of them was `undefined` at runtime.
    expect(typeof settings.revision).toBe('number');
    expect(settings.saved_config.model.vendor).toBe('openai');
    expect(settings.saved_config.loop_engine.provider).toBe('builtin');
    expect(settings.saved_config.storage.metadata.provider).toBe('sqlite');
    expect(settings.saved_config.sandbox.provider).toBe('local');
    expect(settings.diagnostics.metadata.health).toBe('ok');
    expect(settings.secret_states.model!.api_key).toBe('not_set');
    // `adapters` is on GET and, deliberately, not on PUT.
    expect(Object.keys(settings.adapters ?? {})).toContain('model');
    // The field the old type promised and the route has never sent.
    expect(settings).not.toHaveProperty('model_provider');
    expect(settings.saved_config).not.toHaveProperty('schema_version', undefined);
  });

  it('validate() returns the route\'s own result and reports why a fresh workspace is invalid', async () => {
    const { client } = await startRuntime();
    const current = await client.settings.get();

    const result = await client.settings.validate(current.saved_config);

    expect(observed.at(-1)).toMatchObject({ method: 'POST', path: '/v1/x/settings/validate' });
    expect(result.valid).toBe(false);
    expect(result.warnings).toEqual([]);
    // The precise reason, which the CLI needs and the old `{status, checks}` type could not
    // carry: a fresh workspace has no model API key, and the routes require one.
    expect(result.errors).toContainEqual({
      path: 'model.api_key',
      code: 'required',
      message: 'A model API key is required',
    });
    // `checks` belongs to `POST /test`, a different route. Reading it used to throw.
    expect(result).not.toHaveProperty('checks');
  });

  it('patch() writes with PUT, and the saved document leads the effective one', async () => {
    const { client } = await startRuntime();
    const before = await client.settings.get();

    const written = await client.settings.patch({
      model: { vendor: 'anthropic', api_key: 'sk-cma-literal-test-key' },
    });

    // The verb is the fix: this used to be `PATCH`, which the runtime answers with a 404, so
    // nothing below could have happened at all. `patch()` reads first, so the write is found
    // by its method rather than by its position.
    const put = observed.find((entry) => entry.method === 'PUT')!;
    expect(put).toBeDefined();
    expect(put.path).toBe('/v1/x/settings');
    expect(put.body!.revision).toBe(before.revision);
    expect(put.body!.config).toMatchObject({ model: { vendor: 'anthropic' } });
    expect(written.revision).toBe(before.revision + 1);

    const after = await client.settings.get();
    expect(after.saved_config.model.vendor).toBe('anthropic');
    // The new model is not in use yet: `effective_config` still describes the running
    // process, and the runtime says so. A reader that showed only one of the two would make
    // a restart requirement look like an applied change.
    expect(after.effective_config.model.vendor).toBe('openai');
    expect(after.restart_required).toBe(true);
    expect(after.effective_revision).toBeLessThan(after.revision);
  });

  it('patch() merges over the stored document instead of replacing it', async () => {
    const { client } = await startRuntime();
    await client.settings.patch({ model: { vendor: 'openai', api_key: 'sk-cma-literal-test-key' } });
    const stored = await client.settings.get();

    // One option inside one area. A patch that sent only this would be refused, because the
    // routes require the whole document to be valid.
    await client.settings.patch({ sandbox: { options: { timeout_seconds: 42 } } });

    const after = await client.settings.get();
    expect(after.saved_config.sandbox.options.timeout_seconds).toBe(42);
    // Every omitted area survives, including the ones a whole-document replace would drop.
    expect(after.saved_config.model.vendor).toBe('openai');
    expect(after.saved_config.loop_engine).toEqual(stored.saved_config.loop_engine);
    expect(after.saved_config.storage).toEqual(stored.saved_config.storage);
    expect(after.saved_config.memory).toEqual(stored.saved_config.memory);
  });

  it('patch() cannot overwrite a stored secret with the mask it was shown', async () => {
    const { client } = await startRuntime();
    await client.settings.patch({ model: { vendor: 'openai', api_key: 'sk-cma-literal-test-key' } });

    const masked = await client.settings.get();
    expect(masked.saved_config.model.api_key).toBe('********');
    expect(masked.secret_states.model!.api_key).toBe('configured');

    // A patch of an unrelated area carries the masked document back to the runtime. The
    // store treats `********` as "keep the stored value", so the real key must still be
    // there — if a round-trip wrote the mask literally, this is where it would show.
    await client.settings.patch({ sandbox: { options: { timeout_seconds: 99 } } });

    const after = await client.settings.get();
    expect(after.saved_config.model.api_key).toBe('********');
    expect(after.secret_states.model!.api_key).toBe('configured');
    expect(after.saved_config.sandbox.options.timeout_seconds).toBe(99);
  });

  it('patch() names the environment variable an unresolved reference needs', async () => {
    const { client } = await startRuntime();
    const variable = 'CMA_PROBE_SETTINGS_UNSET';
    const original = process.env[variable];
    delete process.env[variable];

    try {
      const failure = await client.settings
        .patch({ model: { vendor: 'openai', api_key: `\${${variable}}` } })
        .then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(RuntimeSettingsValidationError);
      const error = failure as RuntimeSettingsValidationError;
      // A `${VAR}` reference is resolved in the *runtime's* environment, not the client's, so
      // the failing variable is only knowable from the runtime's answer.
      expect(error.errors).toContainEqual({
        path: 'model.api_key',
        code: 'missing_env',
        message: `${variable} is not set`,
      });
      expect(error.message).toContain(variable);

      // Nothing was written: the revision did not move.
      const after = await client.settings.get();
      expect(after.saved_config.model.api_key).toBeUndefined();
      expect(after.revision).toBe(1);
    } finally {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    }
  });

  it('patch() refuses an unrelated change while the stored document is invalid', async () => {
    const { client } = await startRuntime();

    // A fresh workspace has no model key, and the routes validate the whole document on
    // write. `patch` cannot rescue an incomplete document by touching one other area, and it
    // says which field is missing rather than reporting a bare 422.
    const failure = await client.settings
      .patch({ sandbox: { options: { timeout_seconds: 7 } } })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeSettingsValidationError);
    expect((failure as RuntimeSettingsValidationError).errors[0]!.path).toBe('model.api_key');
    // No write was attempted, so the revision is untouched.
    expect(observed.some((entry) => entry.method === 'PUT')).toBe(false);
  });
});
