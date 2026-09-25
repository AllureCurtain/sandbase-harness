/**
 * Integration test: the file listing honours `scope_id`.
 *
 * The published contract publishes an agent's deliverables through the Files
 * API: whatever it writes under `/mnt/session/outputs/` is retrievable via
 * `GET /v1/files?scope_id=<session_id>`. The handler read no query parameters at
 * all, so a caller asking for one session's deliverables was handed **every**
 * file in the workspace and had no way to tell — the response is exactly what a
 * session-scoped listing containing unfamiliar files would look like.
 *
 * These cases are organised around the answers the parameter can give, because
 * the dangerous one is not a wrong filter but a missing one:
 *   - a scope returns that session's files and not another's,
 *   - an unknown scope returns an **empty page**, which is the case that fails if
 *     `scope_id` is silently ignored,
 *   - no scope keeps the previous global listing, so no existing caller changes,
 *   - and the scoping stays behind the compatibility gate rather than becoming a
 *     way to read the global listing.
 *
 * Files are created through `persistFileResource`, which is the same write path
 * the session-output collector uses, so the `session_id` under test is the one
 * the runtime really records rather than one the test arranged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { loadSkills } from '@/core/skills/loader.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { createServer } from '@/api/server.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';
import { persistFileResource } from '@/api/routes/files.js';

// Read from the contract constants rather than written out, so this fixture cannot
// drift from the string the admission layer actually requires.
const CMA_HEADERS = {
  'x-api-key': 'test-key',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

describe('File listing scope', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let deps: any;
  let tmpDir: string;

  const fileIds: Record<string, string> = {};

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-files-scope-'));
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

    const sessionManager = new SessionManager(db);
    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });

    deps = {
      db,
      sessionManager,
      agents: [],
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
    };

    // Two sessions with one deliverable each, one unscoped file (what
    // `POST /v1/files` produces), and one artifact, which this listing excludes.
    for (const [key, sessionId, role] of [
      ['a', 'ses_alpha', 'file'],
      ['b', 'ses_beta', 'file'],
      ['unscoped', undefined, 'file'],
      ['artifact', 'ses_alpha', 'artifact'],
    ] as Array<[string, string | undefined, 'file' | 'artifact']>) {
      const file = persistFileResource(deps, {
        name: `${key}.txt`,
        mediaType: 'text/plain',
        bytes: Buffer.from(`contents of ${key}`),
        metadata: { key },
        role,
        sessionId,
      });
      fileIds[key] = file.id;
    }

    app = createServer(deps);
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function list(query = '') {
    const res = await app.request(`/v1/files${query}`, { headers: CMA_HEADERS });
    return { res, body: await res.json() };
  }

  function idsOf(body: any): string[] {
    return body.data.map((file: any) => file.id);
  }

  it("returns one session's own files and not another's", async () => {
    const alpha = await list('?scope_id=ses_alpha');
    expect(alpha.res.status).toBe(200);
    expect(idsOf(alpha.body)).toContain(fileIds.a);
    expect(idsOf(alpha.body)).not.toContain(fileIds.b);

    // Both directions, so the case cannot pass by the filter always selecting the
    // same session — which is what a hardcoded or first-row-only read would do.
    const beta = await list('?scope_id=ses_beta');
    expect(idsOf(beta.body)).toContain(fileIds.b);
    expect(idsOf(beta.body)).not.toContain(fileIds.a);
  });

  it('returns an empty page for a scope that names no session', async () => {
    // This is the case that fails if `scope_id` is ignored: an ignored scope
    // answers with the global list, which is the defect this parameter exists to
    // close. An empty page is the true answer to "which files does this session
    // have".
    const { res, body } = await list('?scope_id=ses_does_not_exist');
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('excludes a file that belongs to no session from every scoped listing', async () => {
    const alpha = await list('?scope_id=ses_alpha');
    expect(idsOf(alpha.body)).not.toContain(fileIds.unscoped);
    expect(idsOf(alpha.body)).not.toContain(fileIds.artifact);
  });

  it('keeps the global listing when no scope is given', async () => {
    // No existing caller changes: the Console and the SDK both call this route
    // without a scope.
    const { res, body } = await list();
    expect(res.status).toBe(200);
    expect(idsOf(body)).toEqual(expect.arrayContaining([fileIds.a, fileIds.b, fileIds.unscoped]));
    // The artifact stays excluded, as it was before this change.
    expect(idsOf(body)).not.toContain(fileIds.artifact);
  });

  it('refuses a parameter the listing does not implement', async () => {
    const { res, body } = await list('?include_archived=true');
    expect(res.status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('"include_archived"');
    expect(body.error.message).toContain('scope_id');
  });

  it('accepts beta alongside a scope, because the published examples send it', async () => {
    const { res, body } = await list('?beta=true&scope_id=ses_alpha');
    expect(res.status).toBe(200);
    expect(idsOf(body)).toContain(fileIds.a);
    expect(idsOf(body)).not.toContain(fileIds.b);
  });

  it('keeps the scoped listing behind the compatibility gate', async () => {
    // The gate is not weakened by adding the filter. A caller presenting itself as
    // a CMA client without the beta is refused rather than answered — including
    // when it asks for a scope, so the parameter cannot become a way around it.
    const gated = await app.request('/v1/files?scope_id=ses_alpha', {
      headers: { 'x-api-key': 'test-key', 'anthropic-version': CMA_ANTHROPIC_VERSION },
    });
    expect(gated.status).toBe(400);
    const body = await gated.json();
    expect(body.error.code).toBe('missing_anthropic_beta');
    expect(body.data).toBeUndefined();
  });
});
