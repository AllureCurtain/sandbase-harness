/**
 * WebSearch execution (CMA `web_search` built-in tool).
 *
 * The runtime half of the configuration `web-tool-policy.ts` validates: an
 * agent that enables `web_search` gets a real search when — and only when —
 * Settings names a provider, in this precedence:
 *
 * 1. Provider presence — the tool is only mounted when the runtime resolved a
 *    configured provider, so an agent can never reach a search that has no
 *    credentials behind it.
 * 2. Environment network policy — the request leaves the runtime process for
 *    the provider's endpoint, so a `limited` Environment's `allowed_hosts`
 *    must cover it, exactly the check `web_fetch` runs against its target.
 * 3. Agent domain policy — `allowed_domains` becomes the provider's include
 *    list, `blocked_domains` the exclude list. A domain entry carrying a path
 *    suffix (`web_search`'s grammar permits one) is enforced client-side on
 *    every result URL, because vendor APIs take hostnames only.
 * 4. Result shape — provider items render as title/URL/snippet lines; failures
 *    return a structured `Error: web_search_<code>` tool result rather than
 *    throwing, so a rate limit or provider outage is a tool error the model
 *    reads, not a session failure.
 */

import type { WebToolPolicy } from '@/core/agent/web-tool-policy.js';
import type { EnvironmentNetworkPolicy } from '@/core/config/environment-network.js';
import { toolError } from '@/core/tool-result-error.js';
import { domainMatchesList, environmentPolicyRefusal } from './web-fetch.js';
import type { SearchProvider, WebSearchRecency, WebSearchRequest, WebSearchResultItem } from './search/types.js';

export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 20;
/** Per-result snippet cap, so one verbose provider item cannot flood context. */
export const WEB_SEARCH_SNIPPET_CHARS = 600;

export interface WebSearchToolOptions {
  provider: SearchProvider;
  /** Resolved `allowed_domains` / `blocked_domains` / `user_location` policy. */
  policy?: WebToolPolicy;
  /** The session Environment's network policy, checked against the endpoint. */
  environmentPolicy?: EnvironmentNetworkPolicy;
  /** The session's credential redactor; applied to the final result text. */
  redact?: (value: unknown) => unknown;
}

export function createWebSearchTool(options: WebSearchToolOptions) {
  return {
    description: 'Search the web for current information and return ranked results with titles, URLs, and snippets. Subject to the agent domain policy.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        num_results: { type: 'integer', minimum: 1, maximum: WEB_SEARCH_MAX_RESULTS, description: `Maximum number of results (1-${WEB_SEARCH_MAX_RESULTS})` },
        recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only return results updated within this window' },
      },
      required: ['query'],
    },
    execute: async (input: { query?: unknown; num_results?: unknown; recency?: unknown }) => {
      const redact = options.redact ?? ((value: unknown) => value);
      try {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query) return toolError('Error: web_search requires a non-empty query argument');
        if (input.num_results !== undefined && (!Number.isInteger(input.num_results) || (input.num_results as number) < 1 || (input.num_results as number) > WEB_SEARCH_MAX_RESULTS)) {
          return toolError(`Error: web_search num_results must be an integer between 1 and ${WEB_SEARCH_MAX_RESULTS}`);
        }
        if (input.recency !== undefined && !['day', 'week', 'month', 'year'].includes(String(input.recency))) {
          return toolError('Error: web_search recency must be one of day, week, month, year');
        }

        // The provider endpoint is the egress target: a limited Environment
        // that does not cover it refuses the search, same boundary web_fetch
        // answers to for its fetch targets.
        const endpointProblem = environmentPolicyRefusal(safeUrl(options.provider.endpointUrl), options.environmentPolicy);
        if (endpointProblem) return toolError(`Error: web_search ${endpointProblem}`);

        const outcome = await options.provider.search(providerRequest(input, query, options.policy));
        if (!outcome.ok) {
          return toolError(`Error: web_search_${outcome.code === 'web_search_unconfigured' ? 'unconfigured' : outcome.code === 'web_search_rate_limited' ? 'rate_limited' : 'provider_failed'}: ${outcome.message}`);
        }
        const filtered = filterByDomainPolicy(outcome.results, options.policy);
        return String(redact(renderResults(query, filtered)));
      } catch (err) {
        return toolError(String(redact(`Error: web_search unexpected failure: ${err instanceof Error ? err.message : String(err)}`)));
      }
    },
  };
}

/** endpointUrl is operator-trusted config; a malformed one refuses instead of throwing inside URL(). */
function safeUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    // A stored base_url always passed validation; this fallback keeps the
    // policy check honest (denied) rather than skipping it on a bad parse.
    return new URL('https://invalid.invalid');
  }
}

function providerRequest(
  input: { num_results?: unknown; recency?: unknown },
  query: string,
  policy: WebToolPolicy | undefined,
): WebSearchRequest {
  const request: WebSearchRequest = {
    query,
    num_results: typeof input.num_results === 'number' ? input.num_results : WEB_SEARCH_DEFAULT_RESULTS,
    recency: input.recency as WebSearchRecency | undefined,
    user_location: policy?.userLocation?.country ? { country: policy.userLocation.country } : undefined,
  };
  if (policy?.mode === 'allowed') {
    // The provider takes hostnames; a `host/path` entry's suffix is applied
    // client-side in filterByDomainPolicy.
    request.include_domains = policy.domains.map(domainPart);
  } else if (policy?.mode === 'blocked') {
    // Only host-level entries go upstream: excluding the whole host when the
    // entry carried a path suffix would over-block beyond the declared list.
    request.exclude_domains = policy.domains.filter((entry) => !entry.includes('/')).map(domainPart);
  }
  return request;
}

/** Host part of a domain entry that may carry a `web_search` path suffix. */
function domainPart(entry: string): string {
  return entry.split('/', 1)[0];
}

/**
 * Enforce the agent's domain policy on result URLs, including the path suffix
 * a `web_search` list entry may carry — vendor include/exclude parameters are
 * host-level, so `example.com/docs` needs a client check on top.
 */
export function filterByDomainPolicy(
  results: readonly WebSearchResultItem[],
  policy: WebToolPolicy | undefined,
): WebSearchResultItem[] {
  if (!policy?.mode || policy.domains.length === 0) return [...results];
  return results.filter((item) => {
    const url = safeUrl(item.url);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const matches = policy.domains.some((entry) => entryMatches(entry, host, url));
    return policy.mode === 'allowed' ? matches : !matches;
  });
}

function entryMatches(entry: string, host: string, url: URL): boolean {
  const slash = entry.indexOf('/');
  const hostPart = slash === -1 ? entry : entry.slice(0, slash);
  if (!domainMatchesList(host, [hostPart])) return false;
  if (slash === -1) return true;
  const pathPrefix = entry.slice(slash);
  return `${url.pathname}${url.search}`.startsWith(pathPrefix);
}

function renderResults(query: string, results: readonly WebSearchResultItem[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = results.flatMap((item, index) => {
    const snippet = item.content.length > WEB_SEARCH_SNIPPET_CHARS
      ? `${item.content.slice(0, WEB_SEARCH_SNIPPET_CHARS)}…`
      : item.content;
    return [
      `${index + 1}. ${item.title || '(untitled)'}`,
      `   URL: ${item.url}`,
      ...(snippet ? [`   ${snippet}`] : []),
    ];
  });
  return `Search results for "${query}":\n\n${lines.join('\n')}`;
}
