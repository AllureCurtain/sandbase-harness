/**
 * Canonical pagination contract.
 *
 * Two envelopes exist in this runtime and they must never be mixed:
 *
 *   - canonical CMA collections (`/v1/...`) page with opaque `next_page` /
 *     `prev_page` cursors;
 *   - SandBase extension collections (`/v1/x/...`) keep the local
 *     `has_more` / `first_id` / `last_id` shape that preview clients parse.
 *
 * A response carrying both spellings is the failure mode these tests exist to
 * prevent: a caller could read one field while the server paginates by the
 * other, and the two would silently disagree.
 */

import { describe, expect, it } from 'vitest';
import { collectionPager, cursorPageOf, decodeCursor, encodeCursor, pageOf } from '../../src/api/standard.js';

describe('canonical cursor encoding', () => {
  it('round-trips a sort state through the opaque cursor', () => {
    const cursor = encodeCursor({ order: 'created_at_desc', page: 3 });
    const decoded = decodeCursor(cursor);

    expect(decoded.ok).toBe(true);
    expect(decoded.state).toEqual({ order: 'created_at_desc', page: 3 });
  });

  it('does not expose the state as readable text', () => {
    const cursor = encodeCursor({ order: 'created_at_desc', page: 3 });
    expect(cursor).not.toContain('created_at_desc');
    expect(cursor).not.toContain('{');
  });

  it('rejects a cursor that is not a well-formed object', () => {
    expect(decodeCursor('not-base64-at-all!!').ok).toBe(false);
    // Valid base64url, but the payload is a JSON array rather than an object.
    const arrayPayload = Buffer.from('[1,2,3]', 'utf8').toString('base64url');
    expect(decodeCursor(arrayPayload).ok).toBe(false);
  });
});

describe('canonical cursor page envelope', () => {
  it('carries cursors and no local page fields', () => {
    const page = cursorPageOf([{ id: 'a' }, { id: 'b' }], {
      prev: encodeCursor({ page: 1 }),
      next: encodeCursor({ page: 3 }),
    });

    expect(page.data.map((item) => item.id)).toEqual(['a', 'b']);
    expect(typeof page.prev_page).toBe('string');
    expect(typeof page.next_page).toBe('string');
    expect(page).not.toHaveProperty('has_more');
    expect(page).not.toHaveProperty('first_id');
    expect(page).not.toHaveProperty('last_id');
  });

  it('reports a null cursor rather than inventing one at either end', () => {
    const first = cursorPageOf([{ id: 'a' }], {});
    expect(first.prev_page).toBeNull();
    expect(first.next_page).toBeNull();

    const last = cursorPageOf([{ id: 'z' }], { prev: encodeCursor({ page: 1 }) });
    expect(last.next_page).toBeNull();
  });
});

describe('local extension page envelope', () => {
  it('keeps has_more / first_id / last_id and no cursors', () => {
    const page = pageOf([{ id: 'a' }, { id: 'b' }], true);

    expect(page.has_more).toBe(true);
    expect(page.first_id).toBe('a');
    expect(page.last_id).toBe('b');
    expect(page).not.toHaveProperty('next_page');
    expect(page).not.toHaveProperty('prev_page');
  });

  it('reports null ids for an empty page', () => {
    const page = pageOf([], false);
    expect(page.first_id).toBeNull();
    expect(page.last_id).toBeNull();
  });
});

describe('dual-surface collection pager', () => {
  const items = [{ id: 'a' }, { id: 'b' }];

  it('renders the canonical envelope under the canonical shape', () => {
    const pager = collectionPager<{ id: string }>('canonical');
    const body = pager.list(items) as unknown as Record<string, unknown>;

    expect(body.data).toEqual(items);
    expect(body).toHaveProperty('next_page');
    expect(body).toHaveProperty('prev_page');
    expect(body).not.toHaveProperty('has_more');
  });

  it('renders the local envelope under the legacy shape', () => {
    const pager = collectionPager<{ id: string }>('legacy');
    const body = pager.list(items) as unknown as Record<string, unknown>;

    expect(body.data).toEqual(items);
    expect(body).toHaveProperty('has_more');
    expect(body).toHaveProperty('first_id');
    expect(body).toHaveProperty('last_id');
    expect(body).not.toHaveProperty('next_page');
  });

  it('preserves an explicit status code on json()', () => {
    const pager = collectionPager<{ id: string }>('canonical');
    const seen: Array<{ body: unknown; status?: number }> = [];
    const ctx = {
      json(body: unknown, status?: number) {
        seen.push({ body, ...(status === undefined ? {} : { status }) });
        return new Response(null, { status: status ?? 200 });
      },
    };

    pager.json(ctx, items, 202);
    expect(seen[0]?.status).toBe(202);

    seen.length = 0;
    pager.json(ctx, items);
    expect(seen[0]?.status).toBeUndefined();
  });
});
