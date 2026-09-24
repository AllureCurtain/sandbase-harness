/**
 * Integration test: the invalid-request error type is spelled one way.
 *
 * The runtime used to answer `400` with two different `error.type` values for the
 * same category — `invalid_request` on most routes and `invalid_request_error`
 * where a route had been written later. A client branching on the type therefore
 * had to know which family it was talking to in order to compare one category,
 * which is a contract that cannot be implemented correctly by accident.
 *
 * The behavioural cases below take a rejection from each family that can answer
 * `400` and assert the canonical value. The families are chosen for their
 * *mechanism*, not their count: the shared `invalid` helper, its twin in
 * `operation-helpers.ts`, the admission middleware, and the session-resource path
 * whose value comes from a core `code` rather than a literal. That last one is the
 * reason this is not a grep-and-replace: the route used to emit
 * `type: result.code` directly, so the wire type silently followed an internal
 * vocabulary, and canonicalising the route literals alone left three paths still
 * answering with the legacy value.
 *
 * The source scan at the end is the part that keeps it fixed. The wire spelling
 * is a literal in fifteen route modules, so a route added next month is one
 * `type:` away from reintroducing the split, and no battery of per-route cases
 * would notice. A scan does — as long as it is honest about what it can see.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { loadSkills } from '@/core/skills/loader.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { createServer } from '@/api/server.js';
import { addSessionResource } from '@/core/session/session-resources.js';

const CANONICAL = 'invalid_request_error';
const LEGACY = 'invalid_request';

describe('Invalid-request error spelling', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-error-spelling-'));
    const agentsDir = join(tmpDir, 'agents');
    const skillsDir = join(tmpDir, 'skills');
    const dataDir = join(tmpDir, '.managed-agents');
    const configPath = join(dataDir, 'config.yaml');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, 'model:\n  provider: openai\n  api_key: secret-value\n');

    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_spell',
      'spelling-agent',
      JSON.stringify({ name: 'spelling-agent', model: 'model-test', system: 'You are a test agent.' }),
    );

    sessionManager = new SessionManager(db);
    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });

    app = createServer({
      db,
      sessionManager,
      agents: [{ name: 'spelling-agent', model: 'model-test', system: 'You are a test agent.' }],
      consoleRoot: null,
      workspace: { root: tmpDir, dataDir, agentsDir, skillsDir, configPath, target: 'local' },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      skills: loadSkills(skillsDir).skills,
      logger,
      logStore,
      restart: () => undefined,
      listRuntimeModels: () => [],
      registerModelProvider: () => undefined,
      setDefaultRuntimeModel: () => undefined,
      reloadAgents: () => ({ agents: [], errors: [] }),
    });

    // A real session, because the resource path needs one that exists: the case
    // is about a resource-level refusal, not about a missing session.
    sessionId = sessionManager.create({ agent: 'agent_spell' }).id;
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function typeOf(method: string, path: string, init: RequestInit = {}): Promise<string> {
    const res = await app.request(path, { method, ...init });
    expect(res.status, `${method} ${path} should be a rejection`).toBe(400);
    const body = await res.json();
    return body.error.type;
  }

  it('uses the canonical type for a route validation failure', async () => {
    expect(await typeOf('POST', '/v1/agents', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-model' }),
    })).toBe(CANONICAL);
  });

  it('uses the canonical type for an unparseable request body', async () => {
    expect(await typeOf('POST', '/v1/agents', {
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })).toBe(CANONICAL);
  });

  it('uses the canonical type for a compatibility admission refusal', async () => {
    // `x-api-key` alone marks the caller as a compatibility caller, so the
    // middleware refuses before any route logic runs.
    expect(await typeOf('GET', '/v1/agents', {
      headers: { 'x-api-key': 'sk-test' },
    })).toBe(CANONICAL);
  });

  it('uses the canonical type for a stream query-parameter refusal', async () => {
    // Rejected before the stream opens, so this is an ordinary response and the
    // request cannot hang.
    expect(await typeOf('GET', `/v1/sessions/${sessionId}/events/stream?event_deltas=bogus`)).toBe(CANONICAL);
  });

  it('uses the canonical type for an unknown-field update refusal', async () => {
    expect(await typeOf('PUT', '/v1/agents/agent_spell', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bogus_field: true }),
    })).toBe(CANONICAL);
  });

  it('uses the canonical type for an operations-family refusal', async () => {
    expect(await typeOf('POST', '/v1/webhooks', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).toBe(CANONICAL);
  });

  it('uses the canonical type for the shared resource helper', async () => {
    // `resource-utils.ts` holds the other copy of `invalid`, used by the
    // environments, files, memory-store, and vault families. The families differ
    // in why they fail and not in how they answer, which is the point of the
    // helper; this case pins that it is the same helper.
    expect(await typeOf('POST', '/v1/environments', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).toBe(CANONICAL);
  });

  it('uses the canonical type for a refusal whose value comes from a core code', async () => {
    // The session resource routes are the one place where the wire type is not a
    // literal, and the value comes from `deleteSessionResource`'s local `code`.
    //
    // Reaching that core branch needs care, and the failures on the way there are
    // worth recording. The add and patch handlers both short-circuit with their
    // own literal before calling into core, so the obvious candidate — a live
    // memory_store attach refusal — never touches the translation, and a first
    // version of this test used exactly that case and passed with the translation
    // removed, because the literal that answered it carries the same message.
    // Delete is the reachable branch, and it needs a memory_store *instance*,
    // which only comes from the core's creation-time path: session creation
    // stores `params.resources` as a JSON column and materialises no instance row
    // today, so the fixture calls the core directly rather than pretending the
    // API can produce this state.
    const storeId = 'memstore_spelling';
    db.prepare('INSERT INTO memory_stores (id, name, provider) VALUES (?, ?, ?)').run(
      storeId,
      'spelling-store',
      'sqlite',
    );
    const added = addSessionResource(
      db,
      {
        sessionId,
        type: 'memory_store',
        resource: { type: 'memory_store', memory_store_id: storeId },
      },
      { atCreation: true },
    );
    expect(added.ok, 'the creation-time path should accept a memory_store').toBe(true);
    if (!added.ok) return;

    const res = await app.request(`/v1/sessions/${sessionId}/resources/${added.instance.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe(CANONICAL);
    expect(body.error.message).toContain('cannot be removed from a running session');
  });

  it('still reports the local core code for a direct core call', async () => {
    // The opposite direction, pinned so the two vocabularies are not collapsed by
    // a later cleanup: the core's `code` is internal and deliberately unchanged.
    // Only the response is canonicalised.
    const result = addSessionResource(db, {
      sessionId,
      type: 'memory_store',
      resource: { type: 'memory_store', memory_store_id: 'memstore_y' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(LEGACY);
  });

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('has no route module emitting the legacy value as a wire type', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8');
      // Matches the wire assignment only. The local `code` vocabulary and prose
      // that discusses the alias are both fine and are not what this guards.
      if (/type:\s*'invalid_request'/.test(text)) offenders.push(file);
      if (/type:\s*\w+\.code/.test(text)) offenders.push(`${file} (passes a local code through as the wire type)`);
    }
    expect(offenders).toEqual([]);
  });
});
