/**
 * Integration test: the published error envelope's `type` and `code` reach the SDK caller.
 *
 * `ManagedAgentsApiError` exposed only `status` and a message built from `error.message`, so
 * the runtime's error taxonomy was unreachable from the SDK: a caller wanting to tell a wrong
 * agent reference from a malformed body had to substring-match English prose that is not a
 * stable interface. The envelope is structural —
 * `{"error":{"type":"invalid_request_error","code":"invalid_agent_ref","message":"..."}}` —
 * and `src/api/routes/sessions.ts:766` builds it in one place.
 *
 * Every assertion here is against a **real listener over real SQLite**: the codes are produced
 * by the routes themselves, so a test that agreed with a wrong SDK would fail. The message is
 * also pinned byte-for-byte, because adding fields must not change the sentence existing
 * callers already log.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { ManagedAgentsApiError, ManagedAgentsClient } from '@/sdk/client.js';

type RealServer = { close: (cb?: () => void) => void; closeAllConnections?: () => void };

describe('SDK error envelope', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: RealServer | undefined;

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
  });

  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-sdk-error-'));
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

    return { client: new ManagedAgentsClient({ baseUrl: `http://127.0.0.1:${port}` }), app };
  }

  /** Run a call whose refusal is the point, and return the error it threw. */
  async function captureError(run: () => Promise<unknown>): Promise<ManagedAgentsApiError> {
    const failure = await run().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ManagedAgentsApiError);
    return failure as ManagedAgentsApiError;
  }

  it('carries the canonical type and the specific code of a real 400', async () => {
    const { client } = await startRuntime();

    const error = await captureError(() => client.sessions.create({ agent: 'not-an-agent-id' }));

    expect(error.status).toBe(400);
    // The whole point: a caller can branch on this instead of matching prose.
    expect(error.type).toBe('invalid_request_error');
    expect(error.code).toBe('invalid_agent_ref');
    // `code`/`type` are additive: the sentence existing callers log is unchanged, so this is
    // not a breaking change for anyone already matching on it.
    expect(error.message).toBe('API error 400: agent must be a standard agent id');
  });

  it('carries a different code from the same route, so the field is read not guessed', async () => {
    const { client } = await startRuntime();

    // A second code from a second failure on the same path: if the SDK were reporting a
    // constant, or reading the wrong field, one of these two would disagree.
    const error = await captureError(() => client.sessions.create({} as never));

    expect(error.status).toBe(400);
    expect(error.type).toBe('invalid_request_error');
    expect(error.code).toBe('agent_required');
    expect(error.message).toBe('API error 400: agent field is required');
  });

  it('reports a type with no code when the refusal names no specific cause', async () => {
    const { client } = await startRuntime();

    const error = await captureError(() => client.sessions.get('sess_does_not_exist'));

    expect(error.status).toBe(404);
    // `not_found` is deliberately its own type, not a code under `invalid_request_error`
    // (D11) — and this refusal carries no code.
    expect(error.type).toBe('not_found');
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('API error 404: Session not found');
  });

  it('carries the envelope on the text-response path too', async () => {
    const { client } = await startRuntime();

    // `requestText` backs artifact and file content plus metrics. It built its error from the
    // raw body, so a JSON envelope was reported as raw JSON with no fields readable.
    const error = await captureError(() => client.sessions.artifactText('sess_missing', 'art_missing'));

    expect(error.status).toBe(404);
    expect(error.type).toBe('not_found');
    // The prose, not the `{"error":{...}}` body that the raw-text path used to report.
    expect(error.message).not.toContain('{');
    expect(error.message).toContain('not found');
  });

  it('is an Error, so existing catch blocks and rethrows keep working', async () => {
    const { client } = await startRuntime();

    const error = await captureError(() => client.sessions.get('sess_does_not_exist'));

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ManagedAgentsApiError');
    expect(typeof error.stack).toBe('string');
  });
});
