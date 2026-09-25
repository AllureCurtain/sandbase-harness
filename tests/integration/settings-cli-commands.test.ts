/**
 * Integration test: the documented `managed-agents settings ...` group works.
 *
 * `docs/api-matrix.md:86` documents the group as covered — "Get, set model boundary, and
 * validate canonical runtime settings" — and `docs/spec/tasks.md:144` ticks the three
 * commands. The module was imported by nothing, so all three answered
 * `unknown command 'settings'`; and unlike the other orphaned CLI groups, registering them
 * was not enough. Measured against the real routes before the fix:
 *
 *   settings get        TypeError: Cannot read properties of undefined (reading 'metadata')
 *   settings validate   TypeError: result.checks is not iterable
 *   settings set-model  ManagedAgentsApiError: API error 404: No route matches this request
 *
 * The first two read a document taken from a type no route produces, and the third sent a
 * verb the route does not mount. So these tests do not check that a command runs — they check
 * that what it reads and writes is the runtime's own document, and that a refusal names the
 * field that is wrong.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import {
  settingsGetCommand,
  settingsSetModelCommand,
  settingsValidateCommand,
} from '@/cli/runtime-management-commands.js';

type RealServer = { close: (cb?: () => void) => void; closeAllConnections?: () => void };

/**
 * Read the settings document straight from the app.
 *
 * `app.request()` is typed `Response | Promise<Response>`, so it is awaited before its body is
 * read — chaining `.then()` type-checks under vitest but not under `typecheck:tests`.
 */
async function getSettings(app: { request: (path: string) => Response | Promise<Response> }) {
  const response = await app.request('/v1/x/settings');
  return (await response.json()) as any;
}

describe('settings CLI group', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: RealServer | undefined;
  let originalExitCode: typeof process.exitCode;

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
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  /** Capture stdout and stderr, and isolate `process.exitCode` for the duration of a test. */
  async function capture(fn: () => Promise<void>) {
    const log: string[] = [];
    const errors: string[] = [];
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      log.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      await fn();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    return { log, errors };
  }

  /** A real runtime on a real port; the CLI builds its own HTTP client against it. */
  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-settings-cli-'));
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

    return { app, env: { port: String(port) } };
  }

  it('get prints the document the route returns, saved alongside effective', async () => {
    const { env } = await startRuntime();

    const { log } = await capture(() => settingsGetCommand(env));

    const printed = log.join('\n');
    // A fresh workspace: revision 1, nothing saved beyond the seed, no restart pending.
    expect(printed).toContain('revision: 1');
    expect(printed).toContain('effective_revision: 1');
    expect(printed).toContain('model: openai');
    expect(printed).toContain('api_key=not_set');
    expect(printed).toContain('loop_engine: builtin');
    expect(printed).toContain('sandbox: local');
    // Both documents are shown, because they diverge as soon as anything is saved.
    expect(printed).toContain('(effective: openai)');
  });

  it('get --json prints the runtime response unchanged', async () => {
    const { app, env } = await startRuntime();

    const { log } = await capture(() => settingsGetCommand({ ...env, json: true }));

    const printed = JSON.parse(log.join('\n')) as Record<string, unknown>;
    const direct = await getSettings(app);
    // Compared against the route itself rather than against a literal, so a formatter that
    // reshaped the document would fail here.
    expect(printed).toEqual(direct);
    expect(Object.keys(printed)).toContain('saved_config');
  });

  it('validate reports an invalid document and exits non-zero', async () => {
    const { env } = await startRuntime();

    const { log } = await capture(() => settingsValidateCommand(env));

    // A fresh workspace is genuinely invalid: the routes require a model API key.
    expect(log.join('\n')).toContain('settings: invalid');
    expect(log.join('\n')).toContain('error  model.api_key: A model API key is required');
    expect(process.exitCode).toBe(1);
  });

  it('validate reports a valid document and exits zero', async () => {
    const { env } = await startRuntime();
    const variable = 'CMA_SETTINGS_VALID_KEY';
    const original = process.env[variable];
    // A `${VAR}` key is resolved by the runtime from its own environment, so the variable has
    // to be set before the write, not after it.
    process.env[variable] = 'sk-valid-key';

    try {
      await capture(() => settingsSetModelCommand({ ...env, vendor: 'openai', apiKeyEnv: variable }));

      const { log } = await capture(() => settingsValidateCommand(env));

      expect(log.join('\n')).toContain('settings: valid');
      expect(process.exitCode).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    }
  });

  it('set-model writes a ${VAR} reference and never the key itself', async () => {
    const { app, env } = await startRuntime();
    const variable = 'CMA_SETTINGS_MODEL_KEY';
    const original = process.env[variable];
    const secret = 'sk-cli-secret-value-that-must-not-be-stored';
    process.env[variable] = secret;

    try {
      const { log } = await capture(() =>
        settingsSetModelCommand({ ...env, vendor: 'anthropic', apiKeyEnv: variable }));

      const printed = log.join('\n');
      expect(printed).toContain('model: anthropic');
      // The credential state is what the operator sees; the reference itself is in the config.
      expect(printed).toContain('api_key=configured');

      const stored = await getSettings(app);
      // The reference travels; the value does not. The runtime resolves it from its own
      // environment at use time, which is what keeps the secret out of the config file.
      expect(stored.saved_config.model.api_key).toBe(`\${${variable}}`);
      expect(stored.secret_states.model.api_key).toBe('configured');
      // Nothing anywhere in the response body contains the literal secret.
      expect(JSON.stringify(stored)).not.toContain(secret);
    } finally {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    }
  });

  it('set-model names the variable when the runtime cannot resolve it', async () => {
    const { app, env } = await startRuntime();
    const variable = 'CMA_SETTINGS_UNSET_KEY';
    const original = process.env[variable];
    delete process.env[variable];

    try {
      const { log, errors } = await capture(() =>
        settingsSetModelCommand({ ...env, vendor: 'openai', apiKeyEnv: variable }));

      // The command's own output, not the SDK's prose: `API error 422: Settings configuration
      // is invalid` would name neither the field nor the variable, and the variable is the
      // one thing the operator has to fix.
      expect(log).toEqual([]);
      expect(errors.join('\n')).toContain(`Settings were not saved: Runtime settings are invalid: model.api_key: ${variable} is not set`);
      expect(errors.join('\n')).toContain('model.api_key');
      expect(process.exitCode).toBe(1);

      // Nothing was written, so a retry with the right variable starts from the same place.
      const stored = await getSettings(app);
      expect(stored.revision).toBe(1);
      expect(stored.saved_config.model.api_key).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    }
  });

  it('set-model keeps the areas it was not asked to change', async () => {
    const { app, env } = await startRuntime();
    const variable = 'CMA_SETTINGS_KEEP_KEY';
    const original = process.env[variable];
    process.env[variable] = 'sk-keep-me';

    try {
      // Seed a stored key so the document is valid, then change only the vendor.
      await capture(() => settingsSetModelCommand({ ...env, vendor: 'openai', apiKeyEnv: variable }));
      const before = await getSettings(app);

      await capture(() => settingsSetModelCommand({ ...env, vendor: 'anthropic' }));

      const after = await getSettings(app);
      expect(after.saved_config.model.vendor).toBe('anthropic');
      // The stored key survived a patch that did not mention it. An environment reference is
      // returned verbatim rather than masked — only a literal secret becomes `********` (that
      // path is covered against the real route in `tests/integration/sdk-settings-resource.test.ts`)
      // — so this asserts the reference itself came through the merge untouched.
      expect(after.saved_config.model.api_key).toBe(`\${${variable}}`);
      expect(after.secret_states.model.api_key).toBe('configured');
      expect(after.saved_config.sandbox).toEqual(before.saved_config.sandbox);
      expect(after.saved_config.storage).toEqual(before.saved_config.storage);
      expect(after.saved_config.loop_engine).toEqual(before.saved_config.loop_engine);
    } finally {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    }
  });
});
