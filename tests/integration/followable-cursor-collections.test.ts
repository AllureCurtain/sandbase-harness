/**
 * The cursor collections whose page can be followed.
 *
 * `contracts/anthropic-cma/pagination.md` §4 recorded two cases that could not take
 * the null-cursor step the complete-set collections took: `/v1/skills` returned the
 * local `has_more` / `first_id` / `last_id` fields **and** a `next_page` cursor in
 * one body — so two clients could paginate by two different rules from the same
 * response — and the credential audit listings truncated by `limit` with nothing to
 * continue from, so a cut page looked exactly like a complete one.
 *
 * Both now carry a real cursor: an offset bound to the filter (the `source` for
 * skills, the vault/credential scope for the audit trail) that produced it, so a
 * caller can walk forward, walk back, and is refused when the cursor belongs to
 * another query.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { loadSkills } from '@/core/skills/loader.js';

describe('collections with followable cursors', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer>;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function setupApp(): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-followable-'));
    const skillsDir = join(tmpDir, 'skills');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      skills: loadSkills(skillsDir).skills,
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir,
        target: 'local',
      },
    });
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  async function post(path: string, body?: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, body: await res.json() as any };
  }

  function expectCursorEnvelope(body: any, label: string) {
    expect(Object.keys(body).sort(), label).toEqual(['data', 'next_page', 'prev_page']);
  }

  it('serves /v1/skills with a cursor that walks forward and back', async () => {
    setupApp();

    const first = await get('/v1/skills?limit=1');
    expect(first.res.status).toBe(200);
    expectCursorEnvelope(first.body, 'skills page 1');
    expect(first.body.data).toHaveLength(1);
    expect(first.body.prev_page).toBeNull();
    expect(first.body.next_page).not.toBeNull();

    const second = await get(`/v1/skills?limit=1&page=${encodeURIComponent(first.body.next_page)}`);
    expect(second.res.status).toBe(200);
    expectCursorEnvelope(second.body, 'skills page 2');
    expect(second.body.data).toHaveLength(1);
    // A repeated row would mean the cursor was not honoured.
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.prev_page).not.toBeNull();

    const back = await get(`/v1/skills?limit=1&page=${encodeURIComponent(second.body.prev_page)}`);
    expect(back.res.status).toBe(200);
    expect(back.body.data[0].id).toBe(first.body.data[0].id);

    // The old body carried these too, which is what let two clients disagree.
    expect(first.body).not.toHaveProperty('has_more');
    expect(first.body).not.toHaveProperty('first_id');
    expect(first.body).not.toHaveProperty('last_id');
  });

  it('refuses a skills page that is not a cursor or was issued for another source', async () => {
    setupApp();

    const malformed = await get('/v1/skills?limit=1&page=not-a-cursor');
    expect(malformed.res.status).toBe(400);
    expect(malformed.body.error.type).toBe('invalid_request');

    const anthropic = await get('/v1/skills?source=anthropic&limit=1');
    expect(anthropic.res.status).toBe(200);
    expect(anthropic.body.next_page).not.toBeNull();

    const mismatch = await get(`/v1/skills?source=custom&limit=1&page=${encodeURIComponent(anthropic.body.next_page)}`);
    expect(mismatch.res.status).toBe(400);
    expect(mismatch.body.error.message).toContain('different filter');

    // The same filter still accepts it, so the refusal is about the query rather than
    // about the cursor being unusable.
    const sameFilter = await get(`/v1/skills?source=anthropic&limit=1&page=${encodeURIComponent(anthropic.body.next_page)}`);
    expect(sameFilter.res.status).toBe(200);
  });

  it('serves the credential audit listings with a cursor that reaches older events', async () => {
    setupApp();

    const vault = await post('/v1/credential-vaults', { name: 'Vault' });
    expect(vault.res.status).toBe(201);
    const credential = await post(`/v1/credential-vaults/${vault.body.id}/credentials`, {
      name: 'token',
      auth_type: 'environment_variable',
      variable_name: 'TOKEN',
      value: 'secret-value',
      network: { type: 'unrestricted' },
    });
    expect(credential.res.status).toBe(201);
    const credentialScope = `/v1/credential-vaults/${vault.body.id}/credentials/${credential.body.id}/audit`;
    await post(`/v1/credential-vaults/${vault.body.id}/credentials/${credential.body.id}/mark-used`);
    await post(`/v1/credential-vaults/${vault.body.id}/credentials/${credential.body.id}/mark-used`);

    const first = await get(`${credentialScope}?limit=1`);
    expect(first.res.status).toBe(200);
    expectCursorEnvelope(first.body, 'audit page 1');
    expect(first.body.data).toHaveLength(1);
    expect(first.body.next_page).not.toBeNull();

    const second = await get(`${credentialScope}?limit=1&page=${encodeURIComponent(first.body.next_page)}`);
    expect(second.res.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    // Two events, one page each: the second page is the end of the trail.
    expect(second.body.next_page).toBeNull();

    const back = await get(`${credentialScope}?limit=1&page=${encodeURIComponent(second.body.prev_page)}`);
    expect(back.res.status).toBe(200);
    expect(back.body.data[0].id).toBe(first.body.data[0].id);

    // An uncut page reports no continuation, so `next_page: null` now means what it
    // says instead of "the limit was reached".
    const whole = await get(credentialScope);
    expect(whole.body.data).toHaveLength(2);
    expect(whole.body.next_page).toBeNull();
  });

  it('refuses an audit page issued for another scope', async () => {
    setupApp();

    const vault = await post('/v1/credential-vaults', { name: 'Vault' });
    const credential = await post(`/v1/credential-vaults/${vault.body.id}/credentials`, {
      name: 'token',
      auth_type: 'environment_variable',
      variable_name: 'TOKEN',
      value: 'secret-value',
      network: { type: 'unrestricted' },
    });
    const credentialsPath = `/v1/credential-vaults/${vault.body.id}/credentials/${credential.body.id}/audit`;
    await post(`/v1/credential-vaults/${vault.body.id}/credentials/${credential.body.id}/mark-used`);
    await post(`/v1/credential-vaults/${vault.body.id}/credentials/${credential.body.id}/mark-used`);

    // The vault-level page names `credential_id: null`, so replaying it on the
    // credential listing is a different filter rather than a page of that listing.
    const vaultPage = await get(`/v1/credential-vaults/${vault.body.id}/audit?limit=1`);
    expect(vaultPage.body.next_page).not.toBeNull();
    const mismatch = await get(`${credentialsPath}?limit=1&page=${encodeURIComponent(vaultPage.body.next_page)}`);
    expect(mismatch.res.status).toBe(400);
    expect(mismatch.body.error.message).toContain('different filter');

    const malformed = await get(`/v1/credential-vaults/${vault.body.id}/audit?page=not-a-cursor`);
    expect(malformed.res.status).toBe(400);
    expect(malformed.body.error.type).toBe('invalid_request');

    // The scope's own cursor is still accepted.
    const own = await get(`${credentialsPath}?limit=1`);
    const ownNext = await get(`${credentialsPath}?limit=1&page=${encodeURIComponent(own.body.next_page)}`);
    expect(ownNext.res.status).toBe(200);
  });
});
