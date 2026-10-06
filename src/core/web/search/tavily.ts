/**
 * Tavily adapter for the provider-neutral search contract.
 *
 * One POST to `{baseUrl}/search`; the key rides in the `Authorization` header
 * — Tavily accepts it there, and a header keeps the key out of URLs and any
 * request-body logging. Response items map `content` → the snippet field; a
 * `429` becomes `web_search_rate_limited`, every other transport or HTTP
 * failure `web_search_provider_failed`, so the tool never throws.
 */

import type { SearchProvider, WebSearchOutcome, WebSearchRequest, WebSearchResultItem } from './types.js';

export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com';
export const TAVILY_TIMEOUT_MS = 30_000;
export const TAVILY_MAX_RESPONSE_BYTES = 1_000_000;

export interface TavilyProviderOptions {
  apiKey: string;
  /** Defaults to the vendor endpoint; overridable for a relay or tests. */
  baseUrl?: string;
  /** Injectable fetch seam for tests; the override changes nothing else. */
  fetchImpl?: typeof fetch;
  /** Injectable timeout for tests; production callers get the default. */
  timeoutMs?: number;
}

export function createTavilyProvider(options: TavilyProviderOptions): SearchProvider {
  const baseUrl = (options.baseUrl ?? TAVILY_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TAVILY_TIMEOUT_MS;

  return {
    id: 'tavily',
    endpointUrl: baseUrl,
    async search(request: WebSearchRequest): Promise<WebSearchOutcome> {
      const body: Record<string, unknown> = {
        query: request.query,
        max_results: request.num_results ?? 5,
        // Snippets only: raw page content is what web_fetch is for, and
        // answer-generation credits are spend the operator did not ask for.
        include_raw_content: false,
        include_answer: false,
      };
      if (request.recency) body.time_range = request.recency;
      if (request.include_domains?.length) body.include_domains = request.include_domains;
      if (request.exclude_domains?.length) body.exclude_domains = request.exclude_domains;
      if (request.user_location?.country) body.country = request.user_location.country;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/search`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            'user-agent': 'sandbase-harness-websearch/1.0',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        return {
          ok: false,
          code: 'web_search_provider_failed',
          message: error instanceof Error && error.name === 'AbortError'
            ? `Tavily request timed out after ${timeoutMs}ms`
            : `Tavily request failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        return { ok: false, code: 'web_search_rate_limited', message: 'Tavily rate limit reached' };
      }
      if (!response.ok) {
        return { ok: false, code: 'web_search_provider_failed', message: `Tavily returned HTTP ${response.status}` };
      }

      let text: string;
      try {
        text = await boundedText(response, TAVILY_MAX_RESPONSE_BYTES);
      } catch (error) {
        return { ok: false, code: 'web_search_provider_failed', message: error instanceof Error ? error.message : String(error) };
      }
      let payload: { results?: unknown };
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, code: 'web_search_provider_failed', message: 'Tavily returned a non-JSON response' };
      }
      const results = Array.isArray(payload.results)
        ? payload.results.flatMap((item): WebSearchResultItem[] => {
          if (!item || typeof item !== 'object') return [];
          const record = item as Record<string, unknown>;
          return typeof record.url === 'string' && record.url
            ? [{
              title: typeof record.title === 'string' ? record.title : '',
              url: record.url,
              content: typeof record.content === 'string' ? record.content : '',
            }]
            : [];
        })
        : [];
      return { ok: true, provider: 'tavily', results };
    },
  };
}

/** Read a response body with a byte cap; fetch has no built-in limit. */
async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Tavily response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}
