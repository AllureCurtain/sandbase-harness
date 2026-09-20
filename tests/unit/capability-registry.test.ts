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
      {
        id: 'web_fetch',
        kind: 'tool',
        status: 'unavailable',
        reason: 'No safe executable implementation is available in this runtime.',
      },
      {
        id: 'web_search',
        kind: 'tool',
        status: 'unavailable',
        reason: 'No safe executable implementation is available in this runtime.',
      },
    ]);
  });

  it('identifies and rejects enabled unavailable web tools with their reasons', () => {
    const registry = new RuntimeCapabilityRegistry();

    expect(registry.getUnavailableCapabilities(unavailableWebAgent)).toMatchObject([
      { id: 'web_fetch', reason: 'No safe executable implementation is available in this runtime.' },
      { id: 'web_search', reason: 'No safe executable implementation is available in this runtime.' },
    ]);
    expect(() => registry.assertAgentSupported(unavailableWebAgent)).toThrow(UnsupportedCapabilityError);
    expect(() => registry.assertAgentSupported(unavailableWebAgent)).toThrow(
      'Agent requests unavailable runtime capabilities: web_fetch, web_search',
    );
  });

  it('does not reject unavailable tools that are disabled or never allowed', () => {
    const registry = new RuntimeCapabilityRegistry();
    const agent = {
      ...unavailableWebAgent,
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [
          { name: 'web_fetch', enabled: false },
          { name: 'web_search', permission_policy: { type: 'never_allow' } },
        ],
      }],
    } satisfies AgentDefinition;

    expect(registry.getUnavailableCapabilities(agent)).toEqual([]);
    expect(() => registry.assertAgentSupported(agent)).not.toThrow();
  });
});
