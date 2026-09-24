/**
 * Unit test: the two vault prefixes stay the same route set.
 *
 * Vaults are served by one router mounted at both `/v1/credential-vaults` and
 * `/v1/vaults`, which is what makes the published spelling a mount rather than a
 * second, hand-maintained route list. That property is worth a test of its own
 * because it is invisible in a diff: nothing stops someone from later adding a
 * vault route directly to `resources.ts` at one prefix only, and the symptom
 * would be a route that answers for one caller and 404s for another on the same
 * resource.
 *
 * The table read here is the same one the Console's API-reference guard uses
 * (`tests/unit/support/route-table.ts`), which expands the real mount graph from
 * `src/api/server.ts`, so this compares what is actually mounted rather than what
 * the source appears to say.
 */

import { describe, it, expect } from 'vitest';
import { mountedRoutes, routeKey } from './support/route-table';

const CANONICAL = '/v1/credential-vaults';
const PUBLISHED = '/v1/vaults';

/** The shape of a route below its prefix: method plus the suffix, e.g. `POST /:id/archive`. */
function suffixShape(method: string, path: string, prefix: string): string {
  return `${method} ${path.slice(prefix.length)}`;
}

describe('vault path parity', () => {
  const routes = mountedRoutes();
  const under = (prefix: string) => routes.filter(
    (route) => route.path === prefix || route.path.startsWith(`${prefix}/`),
  );
  const canonical = under(CANONICAL);
  const published = under(PUBLISHED);

  it('serves the published vault paths the contract addresses', () => {
    // Anchors, so this file cannot pass by finding nothing: if the vault router
    // stops being mounted at the published prefix, these fail even though the two
    // sets would still be "equal" for the wrong reason.
    const keys = new Set(published.map((route) => routeKey(route.method, route.path)));
    expect(keys).toContain('GET /v1/vaults');
    expect(keys).toContain('POST /v1/vaults');
    expect(keys).toContain('GET /v1/vaults/{}');
    expect(keys).toContain('GET /v1/vaults/{}/credentials');
    expect(keys).toContain('POST /v1/vaults/{}/credentials');
    expect(keys).toContain('POST /v1/vaults/{}/archive');
    // No path rewriting in front of it: the published prefix is the real mount.
    expect(keys.has('GET /v1/credential-vaults')).toBe(false);
  });

  it('still serves the local spelling unchanged', () => {
    const keys = new Set(canonical.map((route) => routeKey(route.method, route.path)));
    expect(keys).toContain('GET /v1/credential-vaults');
    expect(keys).toContain('POST /v1/credential-vaults');
    expect(keys).toContain('GET /v1/credential-vaults/{}');
    expect(keys).toContain('POST /v1/credential-vaults/{}/archive');
  });

  it('gives every canonical route a published twin and the other way round', () => {
    expect(canonical.length).toBeGreaterThan(0);
    expect(canonical.length).toBe(published.length);

    const canonicalShapes = new Set(canonical.map(
      (route) => suffixShape(route.method, route.path, CANONICAL),
    ));
    const publishedShapes = new Set(published.map(
      (route) => suffixShape(route.method, route.path, PUBLISHED),
    ));

    // Equal in both directions: a route added under one prefix alone fails here,
    // whichever prefix it was added to.
    expect([...publishedShapes].sort()).toEqual([...canonicalShapes].sort());
    // ...and the sizes are compared too, so a duplicated registration cannot make
    // two different route sets look equal as sets.
    expect(publishedShapes.size).toBe(canonical.length);
  });
});
