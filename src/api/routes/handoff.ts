/**
 * Handoff bundle routes (/v1/x/handoff-bundles*)
 *
 *   POST /v1/x/sessions/:id/handoff-bundle  - build and store a bundle
 *   GET  /v1/x/handoff-bundles              - list bundles (paginated)
 *   GET  /v1/x/handoff-bundles/:id          - retrieve one bundle payload
 *
 * These live under the `/v1/x` extension namespace on purpose. A handoff bundle
 * is a SandBase capability, not a CMA spec endpoint, and `/v1/x` is what
 * `cma-admission.ts` deliberately excludes from CMA admission — so exporting a
 * bundle never requires CMA compatibility headers.
 */

import { Hono } from 'hono';
import type { ServerDeps } from '../server.js';
import { pageOf } from '../standard.js';
import {
  createHandoffBundle,
  getHandoffBundle,
  listHandoffBundles,
} from '@/core/handoff/store.js';
import type { HandoffBundleDeps } from '@/core/handoff/bundle.js';

export function handoffRoutes(deps: ServerDeps) {
  const app = new Hono();

  const bundleDeps: HandoffBundleDeps = {
    db: deps.db,
    getSession: (id) => deps.sessionManager.get(id),
    listEvents: (id) => deps.sessionManager.getEventLogger().getEvents(id),
    listCapabilities: () => deps.sessionManager.getCapabilityRegistry().list(),
    artifactStore: deps.artifactStore?.(),
  };

  /**
   * Build a bundle for one session.
   *
   * `include_message_content` and `include_file_content` are both opt-in. The
   * defaults match OTel GenAI: bodies stay out and digests go in, because a
   * bundle is meant to be handed to someone else.
   */
  app.post('/sessions/:id/handoff-bundle', async (c) => {
    const sessionId = c.req.param('id');
    if (!deps.sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }

    const body = await readOptionalJsonBody(c);
    if (!body.ok) return body.response;

    const includeMessageContent = boolField(body.value.include_message_content);
    const includeFileContent = boolField(body.value.include_file_content);
    const label = stringField(body.value.label);
    const targetHost = stringField(body.value.target_host);

    try {
      const bundle = createHandoffBundle(bundleDeps, sessionId, {
        includeMessageContent,
        includeFileContent,
        label,
        targetHost,
        runtimeVersion: deps.runtime?.version,
        dataDir: deps.workspace?.dataDir,
      });
      return c.json(bundle, 201);
    } catch (error: any) {
      return c.json(
        { error: { type: 'handoff_bundle_failed', message: String(error?.message ?? error) } },
        400,
      );
    }
  });

  app.get('/handoff-bundles', (c) => {
    const sessionId = c.req.query('session_id');
    const limit = parsePositiveInteger(c.req.query('limit'));
    const summaries = listHandoffBundles(deps.db, { sessionId, limit });
    return c.json({ ...pageOf(summaries), object: 'list', url: '/v1/x/handoff-bundles' });
  });

  app.get('/handoff-bundles/:id', (c) => {
    const bundle = getHandoffBundle(deps.db, c.req.param('id'));
    if (!bundle) return c.json({ error: { type: 'not_found', message: 'Handoff bundle not found' } }, 404);
    return c.json(bundle);
  });

  return app;
}

async function readOptionalJsonBody(c: any): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const contentType = c.req.header('content-type') ?? '';
  const raw = await c.req.text();
  if (!raw.trim()) return { ok: true, value: {} };
  if (!contentType.includes('json')) {
    return {
      ok: false,
      response: c.json({ error: { type: 'invalid_request_error', message: 'content-type must be application/json' } }, 400),
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: c.json({ error: { type: 'invalid_request_error', message: 'body must be a JSON object' } }, 400) };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: c.json({ error: { type: 'invalid_request_error', message: 'body must be valid JSON' } }, 400) };
  }
}

function boolField(value: unknown): boolean {
  return value === true;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}
