/**
 * web_fetch — runtime wiring.
 *
 * `web-fetch.test.ts` proves the tool and its guard behave, and
 * `address-policy.test.ts` proves the classifier. Neither can prove the runtime
 * actually registers the tool or actually admits an agent that enables it: an
 * executor that never called `createWebFetchTool` would leave both green. These
 * tests pin the wiring.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeCapabilityRegistry } from '@/core/capabilities/registry.js';
import { resolveWebToolExecutionPolicy } from '@/core/agent/web-tool-policy.js';
import type { AgentDefinition } from '@/types/agent.js';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

describe('web_fetch capability admission', () => {
  it('admits an agent that enables web_fetch', () => {
    const agent = {
      name: 'browser',
      model: 'gpt-4o',
      system: 'Browse.',
      tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch' }] }],
    } as unknown as AgentDefinition;

    expect(runtimeCapabilityRegistry.getUnavailableCapabilities(agent)).toEqual([]);
  });

  it('still refuses an agent that enables web_search', () => {
    // The two tools no longer share one reason: web_fetch has a safe
    // implementation and web_search has no provider.
    const agent = {
      name: 'searcher',
      model: 'gpt-4o',
      system: 'Search.',
      tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_search' }] }],
    } as unknown as AgentDefinition;

    const unavailable = runtimeCapabilityRegistry.getUnavailableCapabilities(agent);
    expect(unavailable.map((entry) => entry.id)).toEqual(['web_search']);
    expect(unavailable[0]?.reason).toContain('search provider');
  });
});

describe('web_fetch execution policy resolution', () => {
  it('carries the declared list into the execution policy', () => {
    const policy = resolveWebToolExecutionPolicy(
      {
        tools: [{
          type: 'agent_toolset_20260401',
          configs: [{
            name: 'web_fetch',
            allowed_domains: ['Docs.Example.com', 'arxiv.org/'],
            max_content_tokens: 512,
          }],
        }],
      },
      'web_fetch',
    );

    expect(policy).toEqual({
      mode: 'allowed',
      domains: ['docs.example.com', 'arxiv.org'],
      maxContentTokens: 512,
    });
  });

  it('reports no restriction when neither list is declared', () => {
    // The address guard still applies; this is only the domain half.
    const policy = resolveWebToolExecutionPolicy(
      { tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch' }] }] },
      'web_fetch',
    );
    expect(policy?.mode).toBeUndefined();
    expect(policy?.domains).toEqual([]);
  });
});

describe('web_fetch registration', () => {
  it('registers the tool from the resolver, not from the strategy', () => {
    const source = read('src/core/session/tool-resolver.ts');
    expect(source).toContain('createWebFetchTool({');
    expect(source).toContain("resolveWebToolExecutionPolicy(agent, 'web_fetch')");
    // No search executor is registered, because no provider is bundled.
    expect(source).not.toContain('createWebSearchTool');
  });

  it('threads the override surface from the executor, constructor-level only', () => {
    const resolver = read('src/core/session/tool-resolver.ts');
    const executor = read('src/core/session/executor.ts');
    expect(resolver).toContain('webFetch?: WebFetchOverrides');
    expect(executor).toContain('webFetch?: WebFetchOverrides');
    expect(executor).toContain('webFetch: deps.webFetch');
  });
});
