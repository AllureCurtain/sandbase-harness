import { getExplicitlyEnabledToolNames } from '@/core/agent/standard.js';
import { BUILTIN_TOOL_NAMES, type AgentDefinition, type BuiltinToolName } from '@/types/agent.js';

export { BUILTIN_TOOL_NAMES, type BuiltinToolName };
export type RuntimeCapabilityStatus = 'available' | 'unavailable';

export interface RuntimeCapability {
  id: BuiltinToolName;
  kind: 'tool';
  status: RuntimeCapabilityStatus;
  reason?: string;
}

/**
 * Kept distinct from a generic "unsafe" reason: web_search is not missing a safe
 * implementation, it is missing a provider. Conflating the two would tell an
 * operator the same thing about two different gaps — and the reason names the
 * remedy, since the gap closes through Settings, not a code change.
 */
const WEB_SEARCH_NO_PROVIDER_REASON =
  'No search provider is configured: set web_search.provider and its api_key under Settings to enable web_search.';

const DEFAULT_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  { id: 'bash', kind: 'tool', status: 'available' },
  { id: 'edit', kind: 'tool', status: 'available' },
  { id: 'read', kind: 'tool', status: 'available' },
  { id: 'write', kind: 'tool', status: 'available' },
  { id: 'glob', kind: 'tool', status: 'available' },
  { id: 'grep', kind: 'tool', status: 'available' },
  // web_fetch executes behind the address guard in core/web/web-fetch.ts.
  { id: 'web_fetch', kind: 'tool', status: 'available' },
  { id: 'web_search', kind: 'tool', status: 'unavailable', reason: WEB_SEARCH_NO_PROVIDER_REASON },
];

/**
 * The capability inventory for a runtime that resolved a search provider.
 * Identical to {@link DEFAULT_RUNTIME_CAPABILITIES} except `web_search` is
 * executable, so admission accepts an agent that names it and the tool mounts.
 */
const WEB_SEARCH_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = DEFAULT_RUNTIME_CAPABILITIES.map(
  (capability) => (capability.id === 'web_search' ? { id: 'web_search', kind: 'tool', status: 'available' } : capability),
);

export class UnsupportedCapabilityError extends Error {
  readonly type = 'unsupported_capability';
  /**
   * Stable identifier published alongside `type`, so the generic code reader
   * used by `session.error` sees it without special-casing this class.
   */
  readonly code = 'unsupported_capability';

  constructor(readonly capabilities: readonly RuntimeCapability[]) {
    super(`Agent requests unavailable runtime capabilities: ${capabilities.map((capability) => capability.id).join(', ')}`);
    this.name = 'UnsupportedCapabilityError';
  }
}

/**
 * Canonical inventory for runtime-executable built-in capabilities.
 *
 * The registry deliberately distinguishes an accepted configuration name from
 * a capability the local runtime can safely execute. Consumers can use the
 * inventory for discovery, and admission paths use the same inventory before
 * a session is persisted or execution begins.
 */
export class RuntimeCapabilityRegistry {
  private readonly capabilitiesById: ReadonlyMap<BuiltinToolName, RuntimeCapability>;

  constructor(private readonly capabilities: readonly RuntimeCapability[] = DEFAULT_RUNTIME_CAPABILITIES) {
    this.capabilitiesById = new Map(capabilities.map((capability) => [capability.id, capability]));
  }

  list(): RuntimeCapability[] {
    return this.capabilities.map((capability) => ({ ...capability }));
  }

  getUnavailableCapabilities(agent: AgentDefinition): RuntimeCapability[] {
    // Refusal applies to tools the caller named: the published semantic for a
    // bare toolset is "every tool enabled", and treating an implicit enable as
    // a request for an unavailable capability would make the simplest official
    // toolset shape un-creatable. An implicitly enabled tool the runtime
    // cannot execute (web_search) simply never reaches the model — no tool
    // implementation is registered for it.
    return getExplicitlyEnabledToolNames(agent).flatMap((name) => {
      const capability = this.capabilitiesById.get(name as BuiltinToolName);
      return capability?.status === 'unavailable' ? [{ ...capability }] : [];
    });
  }

  assertAgentSupported(agent: AgentDefinition): void {
    const unavailable = this.getUnavailableCapabilities(agent);
    if (unavailable.length > 0) {
      throw new UnsupportedCapabilityError(unavailable);
    }
  }
}

/** Shared default registry used by the local runtime and direct unit/API composition. */
export const runtimeCapabilityRegistry = new RuntimeCapabilityRegistry();

/**
 * Registry for the runtime's actual search-provider state.
 *
 * `web_search` admission follows configuration rather than code: a runtime
 * whose settings resolved a provider admits the tool; one without keeps the
 * published refusal, so an agent can never be admitted into a capability the
 * executor could not have satisfied.
 */
export function runtimeCapabilityRegistryFor(options: { webSearchConfigured: boolean }): RuntimeCapabilityRegistry {
  return options.webSearchConfigured
    ? new RuntimeCapabilityRegistry(WEB_SEARCH_RUNTIME_CAPABILITIES)
    : new RuntimeCapabilityRegistry(DEFAULT_RUNTIME_CAPABILITIES);
}
