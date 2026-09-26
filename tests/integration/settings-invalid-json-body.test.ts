/**
 * `invalid_json` is a decision the settings validator makes, and it is the
 * validation document's answer rather than the generic error envelope.
 *
 * `src/api/routes/settings.ts:49-59` catches a body that is not JSON at all and
 * answers 400 with `{ valid: false, errors: [{ path: '', code: 'invalid_json', … }],
 * warnings: [] }`. That is a different shape from the sibling `/test` route
 * (settings.ts:75-80), which answers the same fault with
 * `{ error: { type: 'invalid_request_error', … } }`. This test **records** the
 * difference rather than endorsing it: the `/validate` response is a validation
 * document, so its fault belongs in `errors`, and both shapes are pinned here so
 * that whichever way it is resolved later, the change is deliberate.
 *
 * The code was one of the four public codes no test mentioned. It matters that
 * the assertion is on the code rather than the status: a client that only reads
 * the status cannot tell a malformed body from a schema-invalid one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';

function makeApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-settings-invalid-json-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  const app = createServer({
    db,
    sessionManager: new SessionManager(db),
    agents: [],
    reloadAgents: () => ({ agents: [], errors: [] }),
  });
  return { app, db, tmpDir };
}

type TestContext = ReturnType<typeof makeApp>;
const contexts: TestContext[] = [];

function app() {
  const ctx = makeApp();
  contexts.push(ctx);
  return ctx.app;
}

function postJson(path: string, body: string) {
  return app().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

type ValidateBody = {
  valid?: boolean;
  errors?: Array<{ path?: string; code?: string; message?: string }>;
  warnings?: unknown[];
  error?: { type?: string; code?: string };
};

describe('settings validate rejects a body that is not JSON', () => {
  afterEach(() => {
    for (const ctx of contexts.splice(0)) {
      ctx.db.close();
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it('answers the validation document with the invalid_json code', async () => {
    const res = await postJson('/v1/x/settings/validate', '{ not json');

    expect(res.status).toBe(400);
    const body = (await res.json()) as ValidateBody;
    expect(body.valid).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.code).toBe('invalid_json');
    // The path is empty because the fault is the document, not a field in it.
    expect(body.errors?.[0]?.path).toBe('');
    expect(body.errors?.[0]?.message).toBe('Request body must be valid JSON');
    // Present even on the failure path: a client that iterates `warnings` should
    // not have to branch on `valid` first.
    expect(body.warnings).toEqual([]);
  });

  it('does not report invalid_json for a parseable body that fails the schema', async () => {
    // The contrast is the assertion: both requests are 400 and `valid: false`, so
    // the code is the only thing that tells the two faults apart.
    const res = await postJson('/v1/x/settings/validate', '{}');

    const body = (await res.json()) as ValidateBody;
    expect(body.valid).toBe(false);
    const codes = (body.errors ?? []).map((issue) => issue.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).not.toContain('invalid_json');
  });

  it('records that the sibling route answers the same fault in the error envelope', async () => {
    const res = await postJson('/v1/x/settings/test', '{ not json');

    expect(res.status).toBe(400);
    const body = (await res.json()) as ValidateBody;
    expect(body.error?.type).toBe('invalid_request_error');
    // No validation document on this route, so no `errors` array and no code.
    expect(body.errors).toBeUndefined();
    expect(body.valid).toBeUndefined();
  });
});
