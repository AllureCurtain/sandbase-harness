import { describe, expect, it } from 'vitest';
import {
  RuntimeCapabilityRegistry,
  UnsupportedCapabilityError,
} from '@/core/capabilities/registry.js';
import type { AgentDefinition } from '@/types/agent.js';

const unavailableWebAgent = {
  name: 'web-agent',
  model: 'gpt-4o',
  system: 'Use the configured tools.',
  tools: [{
    type: 'agent_toolset_20260401',
    configs: [
      { name: 'read' },
      { name: 'web_fetch' },
      { name: 'web_search' },
    ],
  }],
} satisfies AgentDefinition;

describe('RuntimeCapabilityRegistry', () => {
  it('publishes the complete executable capability inventory in stable order', () => {
    const registry = new RuntimeCapabilityRegistry();

    expect(registry.list()).toEqual([
      { id: 'bash', kind: 'tool', status: 'available' },
      { id: 'edit', kind: 'tool', status: 'available' },
      { id: 'read', kind: 'tool', status: 'available' },
      { id: 'write', kind: 'tool', status: 'available' },
      { id: 'glob', kind: 'tool', status: 'available' },
      { id: 'grep', kind: 'tool', status: 'available' },
      // web_fetch executes behind the address guard in core/web/web-fetch.ts.
      { id: 'web_fetch', kind: 'tool', status: 'available' },
      {
        id: 'web_search',
        kind: 'tool',
        status: 'unavailable',
        reason: 'No search provider is bundled or configured in this runtime; web_search declarations are accepted but not executable.',
      },
    ]);
  });

  it('identifies and rejects enabled unavailable web tools with their reasons', () => {
    const registry = new RuntimeCapabilityRegistry();

    // web_fetch is executable, so only web_search is refused, and with the
    // provider reason rather than a generic "unsafe" one.
    expect(registry.getUnavailableCapabilities(unavailableWebAgent)).toMatchObject([
      { id: 'web_search', reason: 'No search provider is bundled or configured in this runtime; web_search declarations are accepted but not executable.' },
    ]);
    expect(() => registry.assertAgentSupported(unavailableWebAgent)).toThrow(UnsupportedCapabilityError);
    expect(() => registry.assertAgentSupported(unavailableWebAgent)).toThrow(
      'Agent requests unavailable runtime capabilities: web_search',
    );
  });

  it('does not reject unavailable tools that are disabled or never allowed', () => {
    const registry = new RuntimeCapabilityRegistry();
    const agent = {
      ...unavailableWebAgent,
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [
          { name: 'web_search', enabled: false },
          { name: 'web_fetch', permission_policy: { type: 'never_allow' } },
        ],
      }],
    } satisfies AgentDefinition;

    expect(registry.getUnavailableCapabilities(agent)).toEqual([]);
    expect(() => registry.assertAgentSupported(agent)).not.toThrow();
  });
});
