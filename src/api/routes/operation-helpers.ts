import type { ServerDeps } from '../server.js';

/**
 * Helpers shared by the routers that were split out of `operations.ts`.
 *
 * These were private to `operations.ts` until the deployment routes moved into
 * their own module so they could be mounted at two prefixes. Moving them here
 * rather than duplicating them is what keeps one definition of the wire shape:
 * a second copy of `invalid`/`notFound` is exactly how two resources come to
 * answer with different error envelopes.
 *
 * They are deliberately byte-for-byte the previous implementations. In
 * particular the error type strings are the local `invalid_request` /
 * `not_found` spellings, not the canonical `invalid_request_error` /
 * `not_found_error` ones: migrating the spelling is its own change across the
 * whole API surface, and smuggling it into a routing change would alter the body
 * of every existing deployment response.
 */

export type JsonObject = Record<string, unknown>;

/**
 * Which envelope a mount serves.
 *
 * The same router is mounted twice, and the contract makes the two prefixes
 * different on purpose: canonical `/v1` collections carry `{data, prev_page,
 * next_page}` while `/v1/x` is the local surface with existing consumers and keeps
 * `{data, has_more, first_id, last_id}`. Choosing it per mount rather than per
 * handler is what stops one response from carrying both spellings.
 */
export interface OperationMountOptions {
  pageShape?: 'canonical' | 'legacy';
}

export function archiveById<T>(
  c: any,
  deps: ServerDeps,
  table: string,
  map: (row: any) => T,
  missingMessage: string,
) {
  const id = c.req.param('id');
  const existing = deps.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND archived_at IS NULL`).get(id);
  if (!existing) return notFound(c, missingMessage);
  deps.db.prepare(`UPDATE ${table} SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?`).run('archived', now(), now(), id);
  const row = deps.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  return c.json(map(row));
}

export async function readObjectBody(c: any): Promise<{ ok: true; value: JsonObject } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: invalid(c, 'Request body must be JSON') };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, response: invalid(c, 'Request body must be a JSON object') };
  }
  return { ok: true, value: body as JsonObject };
}

export function invalid(c: any, message: string) {
  return c.json({ error: { type: 'invalid_request', message } }, 400);
}

export function notFound(c: any, message: string) {
  return c.json({ error: { type: 'not_found', message } }, 404);
}

export function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function objectField(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function parseObject(value: string | null): JsonObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return objectField(parsed);
  } catch {
    return {};
  }
}

export function now() {
  return new Date().toISOString();
}
