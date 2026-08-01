/**
 * Sandbox Provider Registry
 *
 * Maps a sandbox provider type (`local`, `docker`, `kubernetes`, ...) to its
 * implementation. The executor resolves a provider by an Environment's
 * `sandbox_provider` type (R12.3), so an agent can switch execution backends
 * without code changes.
 *
 * The registry is the single authority on which backends exist in this process.
 * A requested type that is not registered is an error naming the missing
 * dependency (R12.4) — never a silent downgrade to a weaker backend, because
 * "asked for an isolated sandbox, got an unsandboxed local subprocess" is a
 * security regression rather than a degraded experience.
 */

import type { SandboxCapabilities, SandboxProvider, SandboxProviderType } from '@/types/sandbox.js';

export class UnknownSandboxProviderError extends Error {
  constructor(
    readonly requested: string,
    readonly registered: string[],
  ) {
    super(
      `Sandbox provider "${requested}" is not available (registered: ${registered.join(', ') || 'none'}). `
      + hintForProvider(requested),
    );
    this.name = 'UnknownSandboxProviderError';
  }
}

export class SandboxProviderRegistry {
  private providers = new Map<string, SandboxProvider>();

  register(provider: SandboxProvider): void {
    this.providers.set(provider.type, provider);
  }

  has(type: string): boolean {
    return this.providers.has(type);
  }

  /**
   * Get a provider by type. Throws {@link UnknownSandboxProviderError} with an
   * install hint if not registered.
   */
  get(type: string): SandboxProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new UnknownSandboxProviderError(type, this.listTypes());
    }
    return provider;
  }

  /** Capabilities of a registered provider, or undefined when not registered. */
  capabilitiesOf(type: string): SandboxCapabilities | undefined {
    return this.providers.get(type)?.capabilities;
  }

  listTypes(): SandboxProviderType[] {
    return Array.from(this.providers.keys());
  }

  /** Registered types paired with their capabilities, for runtime summaries. */
  describe(): Array<{ type: SandboxProviderType; capabilities: SandboxCapabilities }> {
    return Array.from(this.providers.values()).map((provider) => ({
      type: provider.type,
      capabilities: provider.capabilities,
    }));
  }
}

function hintForProvider(type: string): string {
  switch (type) {
    // Retired backend names. They were selectable before any adapter existed,
    // so a workspace created then can still hold them in environments.config.
    // Resolution now fails rather than quietly running unsandboxed on the host,
    // which is the correct outcome but needs to say what to change.
    case 'e2b':
    case 'daytona':
      return `The "${type}" backend was never implemented and has been removed. `
        + 'Update this Environment to a shipped backend (local, docker, kubernetes, or self_hosted).';
    case 'docker':
      return 'Install Docker and ensure the `docker` CLI is on PATH.';
    case 'kubernetes':
      return 'Install the `kubectl` CLI and ensure it can reach a cluster (`kubectl version -o json`).';
    case 'local':
      return 'The local provider is always registered; this usually means runtime bootstrap did not complete.';
    case 'self_hosted':
      return 'Run a self-hosted worker and ensure the work queue is initialized.';
    default:
      return 'Check your Environment sandbox_provider configuration.';
  }
}
