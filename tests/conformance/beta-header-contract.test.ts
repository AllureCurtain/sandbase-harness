/**
 * CMA beta-header contract — the resource family is decided by the path.
 *
 * This is the first suite under `tests/conformance/` and the first slice of the
 * official-SDK conformance work: it is deliberately **provider-free** and needs
 * no dependency, because the shape layer is the part of the contract that can be
 * decided today by executing real requests (see
 * `local-notes/work/06-official-sdk-conformance.md`).
 *
 * The reason this belongs in a conformance suite rather than in a unit test of
 * the middleware is the point the plan makes about it: the resource-family rule
 * and its single exception **cannot be confirmed by reading the code**. Reading
 * `isMemoryListPath` tells you what the regex is; only a request tells you that
 * `GET /v1/memory_stores/:id/memories` really is admitted under either beta while
 * every other memory route is not.
 *
 * Not covered here, and named so the gap is visible rather than implied: the
 * official `@anthropic-ai/sdk` is still not a dependency, no OpenAPI baseline
 * exists, and the semantic layer (a real turn, `stop_reason`, the custom-tool
 * loop) needs a model provider. Those are the next slices.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { disposeConformanceContexts, makeConformanceApp, type ConformanceContext } from './support/app.js';

const VERSION = '2023-06-01';
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
const AGENT_MEMORY_BETA = 'agent-memory-2026-07-22';

type TestContext = ConformanceContext;
const contexts: TestContext[] = [];

function app() {
  const ctx = makeConformanceApp('ma-conformance-beta-');
  contexts.push(ctx);
  return ctx.app;
}

function request(path: string, beta: string, method = 'GET') {
  return app().request(path, {
    method,
    headers: { 'anthropic-version': VERSION, 'anthropic-beta': beta },
  });
}

async function errorOf(res: Response): Promise<{ type?: string; code?: string; message?: string }> {
  const body = (await res.json()) as { error?: { type?: string; code?: string; message?: string } };
  return body.error ?? {};
}

describe('CMA beta-header contract', () => {
  afterEach(() => {
    disposeConformanceContexts(contexts);
  });

  it('admits the documented combination for a canonical resource', async () => {
    const res = await request('/v1/agents', MANAGED_AGENTS_BETA);

    expect(res.status).toBe(200);
  });

  it('refuses the canonical beta on a memory-store route and names the one it wants', async () => {
    const res = await request('/v1/memory_stores', MANAGED_AGENTS_BETA);

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.type).toBe('invalid_request_error');
    expect(error.code).toBe('unsupported_anthropic_beta');
    // The message is part of the contract for a human reading a failed call: it
    // has to name the beta this path actually requires.
    expect(error.message).toContain(AGENT_MEMORY_BETA);
  });

  it('refuses the memory beta on a canonical resource and names the one it wants', async () => {
    const res = await request('/v1/agents', AGENT_MEMORY_BETA);

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('unsupported_anthropic_beta');
    expect(error.message).toContain(MANAGED_AGENTS_BETA);
  });

  it('refuses a memory-store request that combines both betas', async () => {
    const res = await request('/v1/memory_stores', `${MANAGED_AGENTS_BETA}, ${AGENT_MEMORY_BETA}`);

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    // A distinct code, not the generic unsupported-beta one: this request can
    // never be valid for the path, which is a different fault from a caller who
    // used the wrong resource family.
    expect(error.code).toBe('conflicting_memory_store_beta');
  });

  it('admits the documented memory-listing exception under either beta', async () => {
    // The one route CMA defines as equivalent under both betas. The store does not
    // exist, so the status is not the assertion; what is asserted is that the beta
    // check did not refuse the request, which is the exception itself.
    for (const beta of [MANAGED_AGENTS_BETA, AGENT_MEMORY_BETA]) {
      const res = await request('/v1/memory_stores/ms_absent/memories', beta);
      const error = await errorOf(res);
      expect(error.code, `${beta} should be admitted on the memory listing`).not.toBe(
        'unsupported_anthropic_beta',
      );
    }
  });
});
