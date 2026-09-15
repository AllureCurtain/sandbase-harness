/**
 * CMA compatibility request admission.
 *
 * CMA clients identify themselves with x-api-key or Anthropic compatibility
 * headers. Those requests must supply the current API version and the beta
 * required by the resource family before a CMA handler can run. Legacy bearer
 * callers without compatibility headers retain the local API contract.
 */

import type { Context, MiddlewareHandler } from 'hono';

export const CMA_ANTHROPIC_VERSION = '2023-06-01';
export const CMA_MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
export const CMA_AGENT_MEMORY_BETA = 'agent-memory-2026-07-22';

export function createCmaRequestAdmissionMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!isCmaResourcePath(c.req.path) || !hasCmaCompatibilityHeaders(c)) {
      return next();
    }

    const version = c.req.header('anthropic-version')?.trim();
    if (!version) {
      return invalidRequest(c, 'Missing required header: anthropic-version.');
    }
    if (version !== CMA_ANTHROPIC_VERSION) {
      return invalidRequest(c, `Unsupported anthropic-version. Expected "${CMA_ANTHROPIC_VERSION}".`);
    }

    const betaHeader = c.req.header('anthropic-beta')?.trim();
    if (!betaHeader) {
      return invalidRequest(c, 'Missing required header: anthropic-beta.');
    }

    const betas = parseBetaHeader(betaHeader);
    if (!betas) {
      return invalidRequest(c, 'Malformed anthropic-beta header. Provide comma-separated beta identifiers.');
    }

    const memoryStorePath = isMemoryStorePath(c.req.path);
    const hasManagedAgentsBeta = betas.includes(CMA_MANAGED_AGENTS_BETA);
    const hasAgentMemoryBeta = betas.includes(CMA_AGENT_MEMORY_BETA);
    // The CMA memory contract explicitly prohibits combining these resource
    // betas. Reject it before the request can mutate a memory store.
    if (memoryStorePath && hasManagedAgentsBeta && hasAgentMemoryBeta) {
      return invalidRequest(c, 'Do not combine managed-agents and agent-memory beta headers for memory-store requests.');
    }

    // CMA defines this read-only listing as equivalent under either beta. It is
    // the sole memory-store exception; all other memory routes require the
    // agent-memory beta and every other CMA resource requires managed-agents.
    if (isMemoryListPath(c.req.method, c.req.path)) {
      if (hasManagedAgentsBeta || hasAgentMemoryBeta) return next();
      return invalidRequest(
        c,
        `Unsupported anthropic-beta. Expected "${CMA_MANAGED_AGENTS_BETA}" or "${CMA_AGENT_MEMORY_BETA}".`,
      );
    }

    const requiredBeta = memoryStorePath ? CMA_AGENT_MEMORY_BETA : CMA_MANAGED_AGENTS_BETA;
    if (!betas.includes(requiredBeta)) {
      return invalidRequest(c, `Unsupported anthropic-beta. Expected "${requiredBeta}".`);
    }

    return next();
  };
}

function isCmaResourcePath(path: string): boolean {
  return path.startsWith('/v1/') && !path.startsWith('/v1/x/');
}

function hasCmaCompatibilityHeaders(c: Context): boolean {
  return c.req.header('x-api-key') !== undefined
    || c.req.header('anthropic-version') !== undefined
    || c.req.header('anthropic-beta') !== undefined;
}

function isMemoryStorePath(path: string): boolean {
  return path === '/v1/memory_stores' || path.startsWith('/v1/memory_stores/');
}

function isMemoryListPath(method: string, path: string): boolean {
  return method === 'GET' && /^\/v1\/memory_stores\/[^/]+\/memories\/?$/.test(path);
}

function parseBetaHeader(value: string): string[] | null {
  const betas = value.split(',').map((beta) => beta.trim());
  return betas.every(Boolean) ? betas : null;
}

function invalidRequest(c: Context, message: string): Response {
  return c.json({ error: { type: 'invalid_request', message } }, 400);
}
