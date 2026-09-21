/**
 * Session Resource Routes
 *
 * GET    /v1/sessions/:id/resources             - list resource instances
 * POST   /v1/sessions/:id/resources             - attach a resource
 * GET    /v1/sessions/:id/resources/:rid        - get one resource instance
 * PATCH  /v1/sessions/:id/resources/:rid        - rotate a GitHub token
 * DELETE /v1/sessions/:id/resources/:rid        - detach a resource
 *
 * Two behaviours here are contract, not convenience:
 *
 * - A `memory_store` may only be attached while the session is being created.
 *   Attaching one later would bind memory the session was never admitted
 *   against, so the live add path refuses it.
 * - A GitHub resource's repository URL, checkout, and mount path are fixed for
 *   the session. Only `authorization_token` may be replaced. The PATCH handler
 *   rejects any other field instead of quietly ignoring it, because a caller
 *   who believes they repointed a mount would be wrong in a way that silently
 *   changes which code the agent trusts.
 */

import { Hono } from 'hono';
import type { ServerDeps } from '../server.js';
import { cursorPageOf } from '../standard.js';
import { encryptSecret } from '@/core/security/secrets.js';
import {
  addSessionResource,
  deleteSessionResource,
  getSessionResource,
  listSessionResources,
  rotateGithubAuthorizationToken,
  toApiSessionResourceInstance,
  type SessionResourceType,
} from '@/core/session/session-resources.js';
import {
  normalizeFileResource,
  normalizeGithubRepositoryResource,
} from './session-normalizers.js';
import { isTerminal } from '@/core/session/state-machine.js';

/** PATCH accepts exactly one mutating field. */
const GITHUB_ROTATION_FIELDS = ['authorization_token'] as const;

export function sessionResourceRoutes(deps: ServerDeps) {
  const app = new Hono();

  const requireSession = (sessionId: string) => deps.sessionManager.get(sessionId);

  app.get('/:id/resources', (c) => {
    const sessionId = c.req.param('id')!;
    if (!requireSession(sessionId)) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }
    const instances = listSessionResources(deps.db, sessionId).map(toApiSessionResourceInstance);
    return c.json(cursorPageOf(instances, {}));
  });

  app.post('/:id/resources', async (c) => {
    const sessionId = c.req.param('id')!;
    if (!requireSession(sessionId)) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be an object' } }, 400);
    }

    const resource = body as Record<string, unknown>;
    const type = resource.type;
    if (type !== 'file' && type !== 'github_repository' && type !== 'memory_store') {
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: 'type must be file, github_repository, or memory_store',
        },
      }, 400);
    }

    if (type === 'memory_store') {
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: 'memory_store resources can only be attached when the session is created',
        },
      }, 400);
    }

    const normalized = normalizeResourceForLiveAdd(deps, type, resource);
    if (!normalized.ok) {
      return c.json({ error: { type: 'invalid_request_error', message: normalized.message } }, 400);
    }

    const result = addSessionResource(deps.db, {
      sessionId,
      type,
      resource: normalized.value,
      ...(typeof normalized.value.mount_path === 'string' ? { mountPath: normalized.value.mount_path } : {}),
    });
    if (!result.ok) {
      return c.json({ error: { type: result.code, message: result.message } }, 400);
    }
    return c.json(toApiSessionResourceInstance(result.instance), 201);
  });

  app.get('/:id/resources/:resourceId', (c) => {
    const sessionId = c.req.param('id')!;
    const resourceId = c.req.param('resourceId')!;
    if (!requireSession(sessionId)) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }
    const instance = getSessionResource(deps.db, sessionId, resourceId);
    if (!instance) {
      return c.json({ error: { type: 'not_found', message: `Resource not found: ${resourceId}` } }, 404);
    }
    return c.json(toApiSessionResourceInstance(instance));
  });

  app.patch('/:id/resources/:resourceId', async (c) => {
    const sessionId = c.req.param('id')!;
    const resourceId = c.req.param('resourceId')!;
    const session = requireSession(sessionId);
    if (!session) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Request body must be an object' } }, 400);
    }

    const instance = getSessionResource(deps.db, sessionId, resourceId);
    if (!instance) {
      return c.json({ error: { type: 'not_found', message: `Resource not found: ${resourceId}` } }, 404);
    }
    if (instance.type !== 'github_repository') {
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: `Resource ${resourceId} is a ${instance.type} resource; only github_repository resources support updates`,
        },
      }, 400);
    }
    if (isTerminal(session.status)) {
      return c.json({
        error: { type: 'conflict', message: `Session ${sessionId} is in terminal state: ${session.status}` },
      }, 409);
    }

    const patch = body as Record<string, unknown>;
    const unsupported = Object.keys(patch).filter(
      (key) => !(GITHUB_ROTATION_FIELDS as readonly string[]).includes(key),
    );
    if (unsupported.length > 0) {
      // Naming the offending fields keeps a caller from believing they changed
      // a mount identity the runtime cannot change mid-session.
      return c.json({
        error: {
          type: 'invalid_request_error',
          message: `Only authorization_token can be updated on a github_repository resource; unsupported fields: ${unsupported.join(', ')}. Create a new session to change the repository, checkout, or mount path.`,
        },
      }, 400);
    }

    const token = patch.authorization_token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      return c.json({
        error: { type: 'invalid_request_error', message: 'authorization_token is required and must be a non-empty string' },
      }, 400);
    }

    const result = rotateGithubAuthorizationToken(deps.db, sessionId, resourceId, {
      type: 'encrypted_secret',
      ...encryptSecret(token.trim(), deps.workspace?.dataDir),
    });
    if (!result.ok) {
      return c.json({ error: { type: result.code, message: result.message } }, 400);
    }
    return c.json(toApiSessionResourceInstance(result.instance));
  });

  app.delete('/:id/resources/:resourceId', (c) => {
    const sessionId = c.req.param('id')!;
    const resourceId = c.req.param('resourceId')!;
    if (!requireSession(sessionId)) {
      return c.json({ error: { type: 'not_found', message: `Session not found: ${sessionId}` } }, 404);
    }
    const result = deleteSessionResource(deps.db, sessionId, resourceId);
    if (!result.ok) {
      return c.json({ error: { type: result.code, message: result.message } }, result.code === 'not_found' ? 404 : 400);
    }
    return c.json(toApiSessionResourceInstance(result.instance));
  });

  return app;
}

/** Normalize a resource supplied on the live add path. */
function normalizeResourceForLiveAdd(
  deps: ServerDeps,
  type: SessionResourceType,
  resource: Record<string, unknown>,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  const index = 0;
  const result = type === 'file'
    ? normalizeFileResource(deps, resource, index)
    : normalizeGithubRepositoryResource(deps, resource, index);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, value: result.value };
}
