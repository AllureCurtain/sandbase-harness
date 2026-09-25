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
 * These are byte-for-byte the previous implementations apart from the error type
 * string, which was canonicalised across the whole API surface in its own
 * change. `not_found` was left alone: there is no canonical counterpart for it in
 * the published contract, so renaming it would have been invention rather than
 * alignment. The comment that stood here claimed `not_found_error` was the
 * canonical spelling — that value appears nowhere in the published material, and
 * the claim is the kind of unverified confidence this file exists to avoid.
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
  return c.json({ error: { type: 'invalid_request_error', message } }, 400);
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

/**
 * Every field the write routes in this family store as a JSON object string.
 *
 * They are named together because they share one property: the stored value is a
 * serialization, so two objects that are equal to a caller are not necessarily
 * equal as text. A comparison written against the string reports a change when a
 * caller re-sends the same content with its keys in a different order — and a
 * caller has no way to know which order the server wrote. Anything comparing
 * these fields has to compare the parsed values; naming them here is what makes
 * that a decision rather than a coincidence of which helper a call site reached
 * for.
 */
export function equalJsonObject(
  stored: string | null | undefined,
  incoming: JsonObject | undefined,
): boolean {
  // Absent means "leave it alone", which the update routes express by
  // re-serializing the stored value — so an absent field is not a change.
  if (incoming === undefined) return true;
  return equalJsonValue(parseObject(stored ?? null), incoming);
}

/**
 * Structural equality that does not depend on key order.
 *
 * `JSON.stringify` is not usable here: it preserves insertion order, so
 * `{"a":1,"b":2}` and `{"b":2,"a":1}` stringify differently while being the same
 * object to every caller. Sorting keys at each level makes the comparison
 * independent of the order either side happened to use.
 */
export function equalJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => equalJsonValue(item, right[index]));
  }
  const leftKeys = Object.keys(left as JsonObject).sort();
  const rightKeys = Object.keys(right as JsonObject).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => (
    key === rightKeys[index]
    && equalJsonValue((left as JsonObject)[key], (right as JsonObject)[key])
  ));
}
