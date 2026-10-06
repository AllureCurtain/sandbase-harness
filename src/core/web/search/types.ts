/**
 * Provider-neutral web search contract.
 *
 * `web_search` is a server tool: the request leaves from the runtime process,
 * not from the sandbox, so the execution interface is a plain function rather
 * than a sandbox capability. The request vocabulary is the shape
 * `web-tool-policy.ts` already validates for the agent-facing configuration —
 * `allowed_domains`/`blocked_domains` map to `include_domains`/
 * `exclude_domains`, and `user_location` maps to `user_location`. An adapter
 * translates what its vendor supports and applies the rest client-side, so an
 * agent's declared domain policy means the same thing on every provider.
 */

/** Recency vocabulary shared by the tool surface and the adapters. */
export type WebSearchRecency = 'day' | 'week' | 'month' | 'year';

export interface WebSearchRequest {
  query: string;
  /** Result cap, 1–20. */
  num_results?: number;
  recency?: WebSearchRecency;
  include_domains?: string[];
  exclude_domains?: string[];
  /** `user_location` the agent config declared; only `country` is mapped today. */
  user_location?: { country?: string };
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  /** Provider snippet or extracted content; empty when the provider has none. */
  content: string;
}

/**
 * Structured failure the tool turns into a tool result instead of throwing:
 * a model-facing `ok:false` keeps the session alive and tells the model which
 * class of failure it hit.
 */
export type WebSearchErrorCode =
  | 'web_search_unconfigured'
  | 'web_search_rate_limited'
  | 'web_search_provider_failed';

export type WebSearchOutcome =
  | { ok: true; provider: string; results: WebSearchResultItem[] }
  | { ok: false; code: WebSearchErrorCode; message: string };

export interface SearchProvider {
  /** Adapter id — the value `web_search.provider` holds in settings. */
  readonly id: string;
  /**
   * Endpoint base URL requests leave for. The environment network policy is
   * enforced against it, so the adapter reports the URL it actually posts to
   * rather than a constant.
   */
  readonly endpointUrl: string;
  search(request: WebSearchRequest): Promise<WebSearchOutcome>;
}
