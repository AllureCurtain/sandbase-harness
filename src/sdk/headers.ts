/**
 * Anthropic compatibility headers for the first-party SDK.
 *
 * The published contract requires every canonical `/v1/...` request to carry
 * `anthropic-version: 2023-06-01` plus the beta for the resource family being
 * addressed, and the runtime's admission middleware enforces exactly that once
 * it sees any compatibility header. A first-party client that relied on the
 * runtime's header-free local path would work against SandBase and fail against
 * a real CMA endpoint, so the SDK always sends the canonical pair.
 *
 * The two beta values are mutually exclusive by contract: a memory-store
 * request is not a managed-agents request, and a request carrying both is in
 * neither surface. Which one applies is decided per request path here rather
 * than by the caller, so a caller cannot send the wrong family by omission.
 *
 * `/v1/x/...` is the SandBase extension surface. Admission deliberately does
 * not gate it, and no published beta describes it, so the SDK sends no
 * compatibility header there — attaching `managed-agents-2026-04-01` to an
 * extension endpoint would claim canonical coverage the endpoint does not have.
 */

import {
  CMA_AGENT_MEMORY_BETA,
  CMA_ANTHROPIC_VERSION,
  CMA_MANAGED_AGENTS_BETA,
} from '@/core/cma/compatibility.js';

export { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA, CMA_AGENT_MEMORY_BETA };

/** True for the canonical surface the compatibility headers describe. */
export function isCanonicalPath(path: string): boolean {
  return path.startsWith('/v1/') && !path.startsWith('/v1/x/');
}

/** True for a memory-store path, whose beta differs from every other resource. */
export function isMemoryStorePath(path: string): boolean {
  const pathname = path.split('?')[0];
  return pathname === '/v1/memory_stores' || pathname.startsWith('/v1/memory_stores/');
}

/**
 * The beta a canonical path belongs to.
 *
 * Returns `undefined` for a non-canonical path, where no beta applies.
 */
export function betaForPath(path: string): string | undefined {
  if (!isCanonicalPath(path)) return undefined;
  return isMemoryStorePath(path) ? CMA_AGENT_MEMORY_BETA : CMA_MANAGED_AGENTS_BETA;
}

/**
 * Compatibility headers for one request, merged over the caller's headers.
 *
 * Only the canonical surface gets the header pair; the caller's own headers win
 * so an explicit override is still possible, and are never silently replaced.
 */
export function withCompatibilityHeaders(
  path: string,
  headers: Record<string, string>,
): Record<string, string> {
  const beta = betaForPath(path);
  if (beta === undefined) return headers;
  return {
    'anthropic-version': CMA_ANTHROPIC_VERSION,
    'anthropic-beta': beta,
    ...headers,
  };
}
