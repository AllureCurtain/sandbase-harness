/**
 * Unit test: the two deployment prefixes stay the same route set.
 *
 * Deployments are served by one router mounted at both
 * `/v1/scheduled-deployments` and `/v1/deployments`, which is what makes the
 * published spelling a mount rather than a second, hand-maintained route list.
 * That property is worth a test of its own because it is invisible in a diff:
 * nothing stops someone from later adding a deployment route directly to
 * `operations.ts` at one prefix only, and the symptom would be a route that
 * answers for one caller and 404s for another on the same resource.
 *
 * This file also pins the *shape* of the extraction. `operations.ts` serves four
 * resource families from one router, so the deployments had to be moved into
 * their own module rather than aliased in place — and the cost of that move is
 * that a future edit could put a deployment route back in `operations.ts`, or
 * mount the wrong factory. Both are checked here, and the "Registered by" column
 * of `contracts/anthropic-cma/routes.md` is checked against the module that
 * actually registers each route.
 *
 * The table read here is the same one the Console's API-reference guard uses
 * (`tests/unit/support/route-table.ts`), which expands the real mount graph from
 * `src/api/server.ts`, so this compares what is actually mounted rather than what
 * the source appears to say.
 */

import { describe, it, expect } from 'vitest';
import { mountedRoutes, routeKey } from './support/route-table';

const CANONICAL = '/v1/scheduled-deployments';
const PUBLISHED = '/v1/deployments';
const DEPLOYMENTS_MODULE = 'src/api/routes/deployments.ts';

/** The shape of a route below its prefix: method plus the suffix, e.g. `POST /:id/run`. */
function suffixShape(method: string, path: string, prefix: string): string {
  return `${method} ${path.slice(prefix.length)}`;
}

describe('deployment path parity', () => {
  const routes = mountedRoutes();
  const under = (prefix: string) => routes.filter(
    (route) => route.path === prefix || route.path.startsWith(`${prefix}/`),
  );
  const canonical = under(CANONICAL);
  const published = under(PUBLISHED);

  it('serves the published deployment paths the contract addresses', () => {
    // Anchors, so this file cannot pass by finding nothing: if the deployments
    // router stops being mounted at the published prefix, these fail even though
    // the two sets would still be "equal" for the wrong reason.
    const keys = new Set(published.map((route) => routeKey(route.method, route.path)));
    expect(keys).toContain('GET /v1/deployments');
    expect(keys).toContain('POST /v1/deployments');
    expect(keys).toContain('GET /v1/deployments/{}');
    expect(keys).toContain('PUT /v1/deployments/{}');
    expect(keys).toContain('POST /v1/deployments/{}/archive');
    expect(keys).toContain('POST /v1/deployments/{}/run');
    expect(keys).toContain('GET /v1/deployments/{}/runs');
    // No path rewriting in front of it: the published prefix is the real mount.
    expect(keys.has('GET /v1/scheduled-deployments/deployments')).toBe(false);
  });

  it('still serves the local spelling unchanged', () => {
    const keys = new Set(canonical.map((route) => routeKey(route.method, route.path)));
    expect(keys).toContain('GET /v1/scheduled-deployments');
    expect(keys).toContain('PUT /v1/scheduled-deployments/{}');
    expect(keys).toContain('POST /v1/scheduled-deployments/{}/run');
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
    // whichever prefix it was added to. `/run-due` is included on purpose — it is
    // a local convenience route with no published equivalent, and it is aliased
    // rather than curated out because the alias is a mount.
    expect([...publishedShapes].sort()).toEqual([...canonicalShapes].sort());
    // ...and the sizes are compared too, so a duplicated registration cannot make
    // two different route sets look equal as sets.
    expect(publishedShapes.size).toBe(canonical.length);
    expect(canonicalShapes).toContain('POST /run-due');
  });

  it('keeps the routes in the module that owns them', () => {
    // The extraction is load-bearing: the parser only follows a mount whose
    // factory is an imported identifier, so a deployments router defined inside
    // `operations.ts` would silently drop every one of these routes from the
    // table — and from both the Console guard and `contract-honesty` — while the
    // routes kept working. Asserting the source module is how that stays true.
    for (const route of [...canonical, ...published]) {
      expect(route.source, routeKey(route.method, route.path)).toBe(DEPLOYMENTS_MODULE);
    }
  });

  it('does not put any other resource family under either prefix', () => {
    // `operations.ts` also serves webhooks, outcomes and session outcomes. Only
    // the deployment family may appear below these two prefixes; the others are
    // checked by their own canonical paths elsewhere.
    const foreign = [...canonical, ...published].filter((route) => {
      const suffix = route.path.slice(
        (route.path.startsWith(CANONICAL) ? CANONICAL : PUBLISHED).length,
      );
      return suffix.includes('webhook') || suffix.includes('outcome');
    });
    expect(foreign.map((route) => routeKey(route.method, route.path))).toEqual([]);
  });
});
