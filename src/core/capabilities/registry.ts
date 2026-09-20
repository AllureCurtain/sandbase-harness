import { getEnabledToolNames } from '@/core/agent/standard.js';
import type { AgentDefinition } from '@/types/agent.js';

/** Built-in tool identifiers accepted by the CMA agent schema. */
export const BUILTIN_TOOL_NAMES = [
  'bash',
  'edit',
  'read',
  'write',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];
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
 * operator the same thing about two different gaps.
 */
const WEB_SEARCH_NO_PROVIDER_REASON = 'No search provider is bundled or configured in this runtime; web_search declarations are accepted but not executable.';

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
    return getEnabledToolNames(agent).flatMap((name) => {
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
