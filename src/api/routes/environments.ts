import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { cursorPageOf, pageOf } from '../standard.js';
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
import { rejectUnexpectedQueryParams } from './query-params.js';
import { SHIPPED_SANDBOX_PROVIDER_TYPES } from '@/types/sandbox.js';
import {
  environmentHostingProjection,
  hostingTypeError,
  isEnvironmentConfigError,
  parseEnvironmentConfig,
  UNREADABLE_HOSTING_TYPE,
} from '@/sandbox/provider-names.js';
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
    return c.json(cursorPageOf(rows.map(toEnvironment), {}));
  });

  app.post('/environments', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    const normalized = normalizeEnvironmentConfig(body.value);
    if (!normalized.ok) return invalid(c, normalized.message);
    const config = normalized.config;
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
    // The stored config is the merge base, so an unreadable one is refused
    // rather than silently replaced by `{}` — which would rewrite a damaged
    // Environment into an Environment that declares nothing and therefore runs
    // locally. A request that carries a complete `config` is the repair path.
    let storedConfig: Record<string, unknown>;
    try {
      storedConfig = parseEnvironmentConfig(existing.config, `Environment ${id}`);
    } catch (err) {
      if (isEnvironmentConfigError(err) && isPlainObject(body.value.config)) {
        storedConfig = {};
      } else {
        return invalid(c, err instanceof Error ? err.message : String(err), isEnvironmentConfigError(err) ? err.code : undefined);
      }
    }
    const normalized = normalizeEnvironmentConfig(body.value, storedConfig);
    if (!normalized.ok) return invalid(c, normalized.message);
    const config = normalized.config;
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
    // Admission first, in the same order as the work-items listing below: this listing
    // reads no query parameter, and the published contract documents none for it — the
    // route is a local self-hosted extension with no counterpart in the published CMA
    // surface, so there is no documented parameter to honour and no ambiguity to resolve.
    // An empty accept list is therefore the honest one, and a parameter used to be
    // ignored, so `?limit=5` answered a page as if the request had been understood. Every
    // local caller passes no query string (`src/sdk/client.ts`, the CLI), and the Console
    // carries API-reference metadata for the route rather than a request.
    const rejected = rejectUnexpectedQueryParams(c, []);
    if (rejected) return rejected;
    const environmentId = activeEnvironmentId(c, deps);
    if (!environmentId) return notFound(c, 'Environment not found');
    return c.json(cursorPageOf(listEnvironmentWorkerKeys(deps.db, environmentId), {}));
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
    const rejected = rejectUnexpectedQueryParams(c, ['limit']);
    if (rejected) return rejected;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The environment id when it names a live (non-archived) environment. */
function activeEnvironmentId(c: any, deps: ServerDeps): string | undefined {
  const id = c.req.param('id');
  const row = deps.db.prepare('SELECT id FROM environments WHERE id = ? AND archived_at IS NULL').get(id);
  return row ? id : undefined;
}

function toEnvironment(row: EnvironmentRow) {
  let config: Record<string, unknown>;
  let unreadable = false;
  try {
    config = parseEnvironmentConfig(row.config, `Environment ${row.id}`);
  } catch {
    // A row this build cannot read is reported as unreadable rather than as the
    // backend an empty config would resolve to: showing `local` is what let an
    // operator open the damaged Environment, save the form, and thereby store a
    // local one. `unknown` is unservable, so that save is refused instead.
    config = {};
    unreadable = true;
  }
  return {
    id: row.id,
    type: 'environment' as ResourceKind,
    name: row.name,
    description: row.description ?? '',
    hosting_type: unreadable ? UNREADABLE_HOSTING_TYPE : environmentHostingType(config),
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

/**
 * Merge the request's declared hosting fields over the stored config.
 *
 * A `config` that is not an object is refused rather than dropped: ignoring it
 * would leave the Environment resolving to a backend the caller did not ask
 * for. Individual field shapes are validated on the merged config by
 * {@link sandboxProviderError}.
 */
function normalizeEnvironmentConfig(
  body: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): { ok: true; config: Record<string, unknown> } | { ok: false; message: string } {
  if (body.config !== undefined && (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))) {
    return { ok: false, message: 'config must be an object' };
  }
  const config = {
    ...existing,
    ...objectField(body.config),
  };
  for (const key of ['hosting_type', 'sandbox_provider', 'network', 'packages'] as const) {
    if (body[key] !== undefined) config[key] = body[key];
  }
  return { ok: true, config };
}

/**
 * Reject an Environment whose declared backend or hosting type this runtime
 * cannot execute.
 *
 * Without this the environment is accepted at write time and then either fails
 * much later, when a session tries to boot a sandbox that does not exist, or —
 * for `hosting_type` — silently ran on the local backend instead.
 */
function sandboxProviderError(config: Record<string, unknown>): string | undefined {
  const malformed = hostingFieldError(config);
  if (malformed) return malformed;
  // `hosting_type` is checked first so the message names the field the caller
  // most likely wrote: the Console derives the backend from it, so a hosting
  // value this runtime cannot serve would otherwise be reported as a backend
  // name the operator never typed.
  const hostingType = stringField(config.hosting_type);
  const hostingError = hostingType ? hostingTypeError(hostingType) : undefined;
  if (hostingError) return hostingError;
  const provider = stringField(config.sandbox_provider);
  if (provider && !(SHIPPED_SANDBOX_PROVIDER_TYPES as readonly string[]).includes(provider)) {
    return `sandbox_provider "${provider}" is not a known sandbox backend `
      + `(expected one of: ${SHIPPED_SANDBOX_PROVIDER_TYPES.join(', ')})`;
  }
  return undefined;
}

/**
 * Refuse a hosting field that is present but cannot name a backend.
 *
 * A non-string (`7`, `{ type: "cloud" }`) is refused rather than dropped:
 * dropping it would leave the Environment resolving to the default local
 * backend while the caller believed it had declared something. `null` and an
 * empty string mean "not declared" — how a client clears a field — and are left
 * to the resolver's documented default.
 */
function hostingFieldError(config: Record<string, unknown>): string | undefined {
  for (const key of ['hosting_type', 'sandbox_provider'] as const) {
    const value = config[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${key} must be a string`;
  }
  return undefined;
}

/**
 * The public `hosting_type` an Environment reports.
 *
 * Shared with the runtime so a backend the runtime can execute is never
 * described as hosting it does not have: a `kubernetes` Environment used to be
 * reported as `cloud`, and a config that declared only a backend used to fall
 * through to `cloud` as well. A declared value that this runtime does not
 * recognize is echoed verbatim rather than replaced, and a config that declares
 * nothing reports the backend it resolves to.
 */
function environmentHostingType(config: Record<string, unknown>): string {
  return environmentHostingProjection(config);
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
