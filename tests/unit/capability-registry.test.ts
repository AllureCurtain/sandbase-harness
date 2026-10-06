import { describe, expect, it } from 'vitest';
import {
  RuntimeCapabilityRegistry,
  runtimeCapabilityRegistryFor,
  UnsupportedCapabilityError,
} from '@/core/capabilities/registry.js';
import { getEnabledToolNames } from '@/core/agent/standard.js';
import { BUILTIN_TOOL_NAMES, type AgentDefinition } from '@/types/agent.js';

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
        reason: 'No search provider is configured: set web_search.provider and its api_key under Settings to enable web_search.',
      },
    ]);
  });

  it('identifies and rejects enabled unavailable web tools with their reasons', () => {
    const registry = new RuntimeCapabilityRegistry();

    // web_fetch is executable, so only web_search is refused, and with the
    // provider reason rather than a generic "unsafe" one.
    expect(registry.getUnavailableCapabilities(unavailableWebAgent)).toMatchObject([
      { id: 'web_search', reason: 'No search provider is configured: set web_search.provider and its api_key under Settings to enable web_search.' },
    ]);
    expect(() => registry.assertAgentSupported(unavailableWebAgent)).toThrow(UnsupportedCapabilityError);
    expect(() => registry.assertAgentSupported(unavailableWebAgent)).toThrow(
      'Agent requests unavailable runtime capabilities: web_search',
    );
  });

  it('enables every built-in for a bare toolset and still refuses only explicit declarations', () => {
    const registry = new RuntimeCapabilityRegistry();
    const bareToolset = {
      name: 'bare-toolset-agent',
      model: 'gpt-4o',
      system: 'Use the configured tools.',
      tools: [{ type: 'agent_toolset_20260401' }],
    } satisfies AgentDefinition;

    // The published semantic: including the toolset enables all tools.
    // configs entries disable or reconfigure — they are not the enable list.
    expect(getEnabledToolNames(bareToolset)).toEqual([...BUILTIN_TOOL_NAMES]);

    // An implicitly enabled unavailable tool is accepted but inert (no
    // implementation is offered to the model); only a caller who *named*
    // web_search is refused.
    expect(() => registry.assertAgentSupported(bareToolset)).not.toThrow();
  });

  it('lets a configs entry subtract from the implicit all-enabled set', () => {
    const agent = {
      name: 'no-bash-agent',
      model: 'gpt-4o',
      system: 'Use the configured tools.',
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', enabled: false }],
      }],
    } satisfies AgentDefinition;

    expect(getEnabledToolNames(agent)).toEqual(
      BUILTIN_TOOL_NAMES.filter((name) => name !== 'bash'),
    );
  });

  it('admits an explicit web_search declaration once a provider is configured', () => {
    const configured = runtimeCapabilityRegistryFor({ webSearchConfigured: true });

    // Admission follows configuration: the same declaration the default
    // registry refuses is executable on a runtime that resolved a provider.
    expect(configured.getUnavailableCapabilities(unavailableWebAgent)).toEqual([]);
    expect(() => configured.assertAgentSupported(unavailableWebAgent)).not.toThrow();
    expect(configured.list()).toContainEqual({ id: 'web_search', kind: 'tool', status: 'available' });
  });

  it('keeps the unconfigured refusal identical through the configured-registry factory', () => {
    const unconfigured = runtimeCapabilityRegistryFor({ webSearchConfigured: false });

    expect(unconfigured.getUnavailableCapabilities(unavailableWebAgent)).toMatchObject([
      { id: 'web_search', status: 'unavailable' },
    ]);
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
