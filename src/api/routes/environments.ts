import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { pageOf } from '../standard.js';
import {
  archiveResource,
  conflict,
  invalid,
  notFound,
  objectField,
  parseObject,
  readObjectBody,
  stringField,
  stringRecordField,
} from './resource-utils.js';
import { SHIPPED_SANDBOX_PROVIDER_TYPES } from '@/types/sandbox.js';
import {
  createEnvironmentWorkerKey,
  listEnvironmentWorkerKeys,
  revokeEnvironmentWorkerKey,
} from '@/core/auth/environment-worker-keys.js';

type ResourceKind = 'environment';

export function environmentRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/environments', (c) => {
    const rows = deps.db.prepare('SELECT * FROM environments WHERE archived_at IS NULL ORDER BY created_at DESC').all() as unknown as EnvironmentRow[];
    return c.json(pageOf(rows.map(toEnvironment)));
  });

  app.post('/environments', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    const config = normalizeEnvironmentConfig(body.value);
    const providerError = sandboxProviderError(config);
    if (providerError) return invalid(c, providerError);
    const id = `env_${nanoid(18)}`;
    try {
      deps.db.prepare(
        'INSERT INTO environments (id, name, description, config, metadata, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
      ).run(
        id,
        name,
        stringField(body.value.description) ?? '',
        JSON.stringify(config),
        JSON.stringify(stringRecordField(body.value.metadata)),
      );
      const row = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(id) as unknown as EnvironmentRow;
      return c.json(toEnvironment(row), 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, 'Environment id already exists');
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/environments/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as EnvironmentRow | undefined;
    return row ? c.json(toEnvironment(row)) : notFound(c, 'Environment not found');
  });

  app.put('/environments/:id', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(id) as EnvironmentRow | undefined;
    if (!existing) return notFound(c, 'Environment not found');

    const name = stringField(body.value.name) ?? existing.name;
    const config = normalizeEnvironmentConfig(body.value, parseObject(existing.config));
    const providerError = sandboxProviderError(config);
    if (providerError) return invalid(c, providerError);
    deps.db.prepare(
      'UPDATE environments SET name = ?, description = ?, config = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(
      name,
      stringField(body.value.description) ?? existing.description ?? '',
      JSON.stringify(config),
      JSON.stringify(body.value.metadata === undefined ? parseObject(existing.metadata) : stringRecordField(body.value.metadata)),
      id,
    );
    const row = deps.db.prepare('SELECT * FROM environments WHERE id = ? AND archived_at IS NULL').get(id) as unknown as EnvironmentRow;
    return c.json(toEnvironment(row));
  });

  app.post('/environments/:id/archive', (c) => archiveResource(c, deps, 'environments', toEnvironment));

  // --- Self-hosted worker keys (R9.14) -------------------------------------
  //
  // The issuing side of the worker-key contract whose consuming side is
  // `POST /v1/x/worker/claim`. Only the SHA-256 hash of a key is stored, so
  // `secret_key` is present in the creation response and can never be read
  // back; list and revoke responses carry `key_prefix` instead. Both routes are
  // published in `docs/api.md` and `docs/api-matrix.md`.

  app.get('/environments/:id/worker-keys', (c) => {
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    return c.json(pageOf(listEnvironmentWorkerKeys(deps.db, environmentId)));
  });

  app.post('/environments/:id/worker-keys', async (c) => {
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    if (name.length > 80) return invalid(c, 'name must be 80 characters or fewer');
    const expiresAt = stringField(body.value.expires_at);
    if (body.value.expires_at !== undefined && body.value.expires_at !== null && !expiresAt) {
      return invalid(c, 'expires_at must be an ISO 8601 timestamp');
    }
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      return invalid(c, 'expires_at must be an ISO 8601 timestamp');
    }
    const created = createEnvironmentWorkerKey(deps.db, environmentId, {
      name,
      expires_at: expiresAt ?? null,
      metadata: stringRecordField(body.value.metadata),
    });
    return c.json(created, 201);
  });

  app.post('/environments/:id/worker-keys/:keyId/revoke', (c) => {
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    const revoked = revokeEnvironmentWorkerKey(deps.db, environmentId, c.req.param('keyId'));
    if (!revoked) return notFound(c, 'Worker key not found');
    return c.json(revoked);
  });

  // --- Self-hosted work queue (R9.14) --------------------------------------
  //
  // The inspecting side of the same protocol whose consuming side is
  // `POST /v1/x/worker/claim`, and published in `docs/api.md` and
  // `docs/api-matrix.md`. `WorkQueue.list`/`stats` already answer the question
  // for one environment. Without a configured queue the route refuses instead of
  // answering an empty page, because "this runtime has no queue" and "this queue
  // has no work" must not read the same.

  app.get('/environments/:id/work-items', (c) => {
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    const queue = deps.workQueue;
    if (!queue) {
      return c.json({
        error: {
          type: 'work_queue_unavailable',
          message: 'This runtime has no self-hosted work queue configured.',
        },
      }, 503);
    }
    return c.json({
      ...pageOf(queue.list({ environmentId, limit: parseLimit(c.req.query('limit')) })),
      counts: queue.stats({ environmentId }),
    });
  });

  return app;
}

/**
 * A usable positive `limit` query value.
 *
 * An unusable value falls back to the queue's own default rather than being
 * refused, which is how the extension routes in `runtime.ts` already treat a
 * malformed pagination hint.
 */
function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

/** The environment id when it names a live (non-archived) environment. */
function activeEnvironmentId(c: any, deps: ServerDeps): string | undefined {
  const id = c.req.param('id');
  const row = deps.db.prepare('SELECT id FROM environments WHERE id = ? AND archived_at IS NULL').get(id);
  return row ? id : undefined;
}

function toEnvironment(row: EnvironmentRow) {
  const config = parseObject(row.config);
  return {
    id: row.id,
    type: 'environment' as ResourceKind,
    name: row.name,
    description: row.description ?? '',
    hosting_type: environmentHostingType(config),
    sandbox_provider: typeof config.sandbox_provider === 'string' ? config.sandbox_provider : null,
    network: objectField(config.network),
    packages: Array.isArray(config.packages) ? config.packages : [],
    status: row.archived_at ? 'archived' : 'active',
    config,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    archived_at: row.archived_at ?? null,
  };
}

function normalizeEnvironmentConfig(
  body: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const config = {
    ...existing,
    ...objectField(body.config),
  };
  for (const key of ['hosting_type', 'sandbox_provider', 'network', 'packages'] as const) {
    if (body[key] !== undefined) config[key] = body[key];
  }
  return config;
}

/**
 * Reject `sandbox_provider` values that no registered backend can serve.
 *
 * Without this the environment is accepted at write time and only fails much
 * later, when a session tries to boot a sandbox that does not exist.
 */
function sandboxProviderError(config: Record<string, unknown>): string | undefined {
  const provider = stringField(config.sandbox_provider);
  if (!provider) return undefined;
  if ((SHIPPED_SANDBOX_PROVIDER_TYPES as readonly string[]).includes(provider)) return undefined;
  return `sandbox_provider "${provider}" is not a known sandbox backend `
    + `(expected one of: ${SHIPPED_SANDBOX_PROVIDER_TYPES.join(', ')})`;
}

function environmentHostingType(config: Record<string, unknown>): 'cloud' | 'local' | 'docker' | 'self_hosted' {
  if (config.hosting_type === 'self_hosted') return 'self_hosted';
  if (config.hosting_type === 'docker') return 'docker';
  if (config.hosting_type === 'local') return 'local';
  if (config.hosting_type === 'cloud') return 'cloud';
  if (config.sandbox_provider === 'self_hosted') return 'self_hosted';
  if (config.sandbox_provider === 'docker') return 'docker';
  if (config.sandbox_provider === 'local') return 'local';
  return 'cloud';
}

interface EnvironmentRow {
  id: string;
  name: string;
  description: string;
  config: string;
  metadata: string;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
