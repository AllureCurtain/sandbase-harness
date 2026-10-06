/**
 * Unit tests for the model-facing `web_search` tool.
 *
 * The provider seam is a stub `SearchProvider`, so the cases cover the parts
 * the tool owns: input validation, agent domain policy (including path-suffix
 * entries a vendor API cannot express), the Environment egress check against
 * the provider endpoint, structured failure propagation, and redaction.
 */

import { describe, expect, it } from 'vitest';
import { createWebSearchTool, filterByDomainPolicy } from '@/core/web/web-search-tool.js';
import type { SearchProvider, WebSearchRequest, WebSearchResultItem } from '@/core/web/search/types.js';
import type { WebToolPolicy } from '@/core/agent/web-tool-policy.js';
import { normalizeEnvironmentNetwork } from '@/core/config/environment-network.js';
import { toolErrorText } from '@/core/tool-result-error.js';

const RESULTS: WebSearchResultItem[] = [
  { title: 'Alpha', url: 'https://a.example/docs/1', content: 'alpha snippet' },
  { title: 'Beta', url: 'https://b.example/x', content: 'beta snippet' },
];

function providerStub(outcome: Awaited<ReturnType<SearchProvider['search']>>, requests: WebSearchRequest[] = []): SearchProvider {
  return {
    id: 'stub',
    endpointUrl: 'https://search.test',
    async search(request) {
      requests.push(request);
      return outcome;
    },
  };
}

async function run(tool: ReturnType<typeof createWebSearchTool>, input: Record<string, unknown>): Promise<string> {
  const result = await (tool.execute as (input: Record<string, unknown>) => Promise<unknown>)(input);
  return toolErrorText(result) ?? String(result);
}

describe('createWebSearchTool', () => {
  it('renders ranked results for the model', async () => {
    const requests: WebSearchRequest[] = [];
    const tool = createWebSearchTool({ provider: providerStub({ ok: true, provider: 'stub', results: RESULTS }, requests) });

    const text = await run(tool, { query: 'managed agents' });

    expect(text).toContain('Search results for "managed agents"');
    expect(text).toContain('1. Alpha');
    expect(text).toContain('URL: https://a.example/docs/1');
    expect(text).toContain('2. Beta');
    expect(requests).toHaveLength(1);
    expect(requests[0].query).toBe('managed agents');
    expect(requests[0].num_results).toBe(5);
  });

  it('rejects malformed input before any provider call', async () => {
    const requests: WebSearchRequest[] = [];
    const tool = createWebSearchTool({ provider: providerStub({ ok: true, provider: 'stub', results: [] }, requests) });

    expect(await run(tool, { query: '  ' })).toContain('non-empty query');
    expect(await run(tool, { query: 'x', num_results: 0 })).toContain('num_results');
    expect(await run(tool, { query: 'x', num_results: 21 })).toContain('num_results');
    expect(await run(tool, { query: 'x', recency: 'hour' })).toContain('recency');
    expect(requests).toHaveLength(0);
  });

  it('passes recency and num_results through to the provider', async () => {
    const requests: WebSearchRequest[] = [];
    const tool = createWebSearchTool({ provider: providerStub({ ok: true, provider: 'stub', results: [] }, requests) });

    await run(tool, { query: 'x', num_results: 12, recency: 'month' });

    expect(requests[0].num_results).toBe(12);
    expect(requests[0].recency).toBe('month');
  });

  it('maps an allowed_domains policy to include_domains and filters path entries client-side', async () => {
    const requests: WebSearchRequest[] = [];
    const policy: WebToolPolicy = { mode: 'allowed', domains: ['a.example/docs', 'c.example'] };
    const tool = createWebSearchTool({
      provider: providerStub({ ok: true, provider: 'stub', results: RESULTS }, requests),
      policy,
    });

    const text = await run(tool, { query: 'x' });

    // The provider sees hostnames only; the path suffix is enforced locally.
    expect(requests[0].include_domains).toEqual(['a.example', 'c.example']);
    expect(text).toContain('a.example/docs/1');
    expect(text).not.toContain('b.example');
  });

  it('maps a blocked_domains policy to host-level exclude_domains', async () => {
    const requests: WebSearchRequest[] = [];
    const policy: WebToolPolicy = { mode: 'blocked', domains: ['b.example', 'a.example/docs'] };
    const tool = createWebSearchTool({
      provider: providerStub({
        ok: true,
        provider: 'stub',
        results: [...RESULTS, { title: 'Gamma', url: 'https://a.example/other', content: 'gamma' }],
      }, requests),
      policy,
    });

    const text = await run(tool, { query: 'x' });

    // The path-suffixed entry stays client-side: sending it upstream as a
    // bare host would block more of a.example than the list declared.
    expect(requests[0].exclude_domains).toEqual(['b.example']);
    expect(text).not.toContain('b.example');
    expect(text).not.toContain('a.example/docs/1');
    expect(text).toContain('a.example/other');
  });

  it('forwards the declared user_location to the provider', async () => {
    const requests: WebSearchRequest[] = [];
    const policy: WebToolPolicy = { domains: [], userLocation: { type: 'approximate', country: 'US' } };
    const tool = createWebSearchTool({
      provider: providerStub({ ok: true, provider: 'stub', results: [] }, requests),
      policy,
    });

    await run(tool, { query: 'x' });

    expect(requests[0].user_location).toEqual({ country: 'US' });
  });

  it('refuses when the Environment network policy does not cover the provider endpoint', async () => {
    const requests: WebSearchRequest[] = [];
    const tool = createWebSearchTool({
      provider: providerStub({ ok: true, provider: 'stub', results: RESULTS }, requests),
      environmentPolicy: normalizeEnvironmentNetwork({ type: 'limited', allowed_hosts: ['elsewhere.test'] }),
    });

    const text = await run(tool, { query: 'x' });

    expect(text).toContain('allowed_hosts');
    expect(requests).toHaveLength(0);
  });

  it('runs when the Environment network policy covers the provider endpoint', async () => {
    const requests: WebSearchRequest[] = [];
    const tool = createWebSearchTool({
      provider: providerStub({ ok: true, provider: 'stub', results: RESULTS }, requests),
      environmentPolicy: normalizeEnvironmentNetwork({ type: 'limited', allowed_hosts: ['search.test'] }),
    });

    expect(await run(tool, { query: 'x' })).toContain('Alpha');
    expect(requests).toHaveLength(1);
  });

  it('turns provider failures into structured tool errors that name the code', async () => {
    const cases: Array<[Awaited<ReturnType<SearchProvider['search']>>, string]> = [
      [{ ok: false, code: 'web_search_rate_limited', message: 'rate limit reached' }, 'web_search_rate_limited'],
      [{ ok: false, code: 'web_search_provider_failed', message: 'HTTP 502' }, 'web_search_provider_failed'],
      [{ ok: false, code: 'web_search_unconfigured', message: 'no provider' }, 'web_search_unconfigured'],
    ];
    for (const [outcome, code] of cases) {
      const tool = createWebSearchTool({ provider: providerStub(outcome) });
      const text = await run(tool, { query: 'x' });
      expect(text).toContain(`Error: web_search_${code.replace('web_search_', '')}`);
      expect(text).toContain(code);
    }
  });

  it('surfaces an unexpected provider throw as a tool error, not a session failure', async () => {
    const provider: SearchProvider = {
      id: 'stub',
      endpointUrl: 'https://search.test',
      async search() { throw new Error('kaboom'); },
    };
    const tool = createWebSearchTool({ provider });

    expect(await run(tool, { query: 'x' })).toContain('kaboom');
  });

  it('redacts credential material the provider happened to echo', async () => {
    const tool = createWebSearchTool({
      provider: providerStub({
        ok: true,
        provider: 'stub',
        results: [{ title: 'Leak', url: 'https://a.example/', content: 'token sk-live-123 visible' }],
      }),
      redact: (value) => String(value).replaceAll('sk-live-123', '[redacted]'),
    });

    const text = await run(tool, { query: 'x' });
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('sk-live-123');
  });

  it('reports an empty page plainly', async () => {
    const tool = createWebSearchTool({ provider: providerStub({ ok: true, provider: 'stub', results: [] }) });
    expect(await run(tool, { query: 'nothing' })).toBe('No results for "nothing".');
  });
});

describe('filterByDomainPolicy', () => {
  it('matches subdomains and enforces a path-suffix entry against the URL path', () => {
    const results: WebSearchResultItem[] = [
      { title: '', url: 'https://sub.a.example/docs/x', content: '' },
      { title: '', url: 'https://sub.a.example/blog/y', content: '' },
      { title: '', url: 'https://a.example.evil.test/docs/x', content: '' },
    ];
    const filtered = filterByDomainPolicy(results, { mode: 'allowed', domains: ['a.example/docs'] });
    expect(filtered.map((item) => item.url)).toEqual(['https://sub.a.example/docs/x']);
  });

  it('returns the input when no domain policy is declared', () => {
    expect(filterByDomainPolicy(RESULTS, undefined)).toEqual(RESULTS);
    expect(filterByDomainPolicy(RESULTS, { domains: [] })).toEqual(RESULTS);
  });
});
