import {
  type SandboxProvider,
  type SandboxInstance,
  type SandboxProviderType,
  type EnvironmentConfig,
} from '@/types/sandbox.js';
import type { Session } from '@/types/session.js';
import { UnknownSandboxProviderError, type SandboxProviderRegistry } from '@/sandbox/registry.js';
import type { SnapshotManager } from './snapshot-manager.js';

/** Minimal warn sink so the lifecycle can report capability gaps. */
export interface SandboxLifecycleLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface SandboxLifecycleDeps {
  sandboxProvider: SandboxProvider;
  sandboxRegistry?: SandboxProviderRegistry;
  resolveEnvironmentConfig?: (environmentId: string) => EnvironmentConfig | undefined;
  snapshots?: SnapshotManager;
  logger?: SandboxLifecycleLogger;
}

/** A provisioned sandbox plus the backend that produced it. */
interface BoundSandbox {
  sandbox: SandboxInstance;
  provider: SandboxProvider;
}

export class SandboxLifecycle {
  private readonly bound = new Map<string, BoundSandbox>();
  /**
   * Backends whose lack of isolation has already been reported.
   *
   * Keyed by provider type, not by session: "this backend does not isolate" is
   * a property of the configuration, and repeating it for every session on a
   * single-developer local runtime would be pure noise.
   */
  private readonly reportedUnisolated = new Set<string>();

  constructor(private readonly deps: SandboxLifecycleDeps) {}

  /**
   * Provision an extra sandbox for a session-scoped side task (a delegated
   * sub-agent) using the same backend the session itself resolves to.
   *
   * Not tracked in `bound`: the caller owns the returned instance and must
   * clean it up. Resolution goes through the same fail-loud path as the main
   * sandbox, so a session configured for an isolated backend cannot end up
   * running its sub-agent commands on the runtime host.
   */
  async provisionDetached(session: Session, sandboxId: string): Promise<SandboxInstance> {
    const envConfig = this.resolveEnvironmentConfig(session);
    const provider = this.resolveProvider(envConfig.sandbox_provider);
    return provider.provision(sandboxId, envConfig);
  }

  async getOrProvision(session: Session): Promise<SandboxInstance> {
    const existing = this.bound.get(session.id);
    if (existing) return existing.sandbox;

    const envConfig = this.resolveEnvironmentConfig(session);
    const provider = this.resolveProvider(envConfig.sandbox_provider);
    this.reportCapabilityGaps(session, envConfig, provider);

    const sandbox = await provider.provision(session.id, envConfig);

    if (this.snapshotsSupported(envConfig, provider) && this.deps.snapshots && sandbox.hostWorkDir) {
      try {
        this.deps.snapshots.restoreLatest(session.id, sandbox.hostWorkDir);
      } catch {
        // best-effort restore
      }
    }

    this.bound.set(session.id, { sandbox, provider });
    return sandbox;
  }

  snapshotAfterTurn(session: Session, sandbox: SandboxInstance): void {
    // Read the backend recorded at provision time rather than re-resolving:
    // the sandbox in hand already proves which provider served this session.
    const provider = this.bound.get(session.id)?.provider;
    if (!provider) return;
    const envConfig = this.resolveEnvironmentConfig(session);
    if (this.snapshotsSupported(envConfig, provider) && this.deps.snapshots && sandbox.hostWorkDir) {
      try {
        this.deps.snapshots.create(session.id, sandbox.hostWorkDir);
      } catch {
        // best-effort snapshot
      }
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const entry = this.bound.get(sessionId);
    if (!entry) return;

    this.bound.delete(sessionId);
    try {
      await entry.sandbox.cleanup();
    } catch {
      // best-effort cleanup
    }
  }

  snapshotsEnabled(envConfig: EnvironmentConfig): boolean {
    return envConfig.snapshot?.enabled === true;
  }

  /**
   * Snapshots need a host-readable workspace. Asking for them on a backend
   * without `hostFilesystem` is a configuration gap, not something to satisfy
   * silently — {@link reportCapabilityGaps} surfaces it once per session.
   */
  private snapshotsSupported(envConfig: EnvironmentConfig, provider: SandboxProvider): boolean {
    return this.snapshotsEnabled(envConfig) && provider.capabilities.hostFilesystem;
  }

  /**
   * Report anything the Environment asked for that the selected backend cannot
   * deliver. Previously these requests were dropped with no signal at all: a
   * snapshot-enabled docker session simply never produced a snapshot, and
   * `resources` limits on the local provider were ignored.
   *
   * Called once per session, from the provision path that caches its result.
   * Config-driven gaps are logged per session because they come from that
   * session's Environment; the isolation notice is deduplicated per backend
   * because it describes the backend itself.
   */
  private reportCapabilityGaps(
    session: Session,
    envConfig: EnvironmentConfig,
    provider: SandboxProvider,
  ): void {
    const logger = this.deps.logger;
    if (!logger) return;

    if (this.snapshotsEnabled(envConfig) && !provider.capabilities.hostFilesystem) {
      logger.warn('sandbox: workspace snapshots requested but backend has no host filesystem', {
        session_id: session.id,
        sandbox_provider: provider.type,
        capability: 'hostFilesystem',
      });
    }

    const wantsLimits = Boolean(envConfig.resources?.memory || envConfig.resources?.cpu);
    if (wantsLimits && !provider.capabilities.resourceLimits) {
      logger.warn('sandbox: resource limits requested but backend does not enforce them', {
        session_id: session.id,
        sandbox_provider: provider.type,
        capability: 'resourceLimits',
      });
    }

    if (!provider.capabilities.isolatedExecution && !this.reportedUnisolated.has(provider.type)) {
      this.reportedUnisolated.add(provider.type);
      logger.warn('sandbox: commands run without isolation from the runtime host', {
        sandbox_provider: provider.type,
        capability: 'isolatedExecution',
      });
    }
  }

  private resolveEnvironmentConfig(session: Session): EnvironmentConfig {
    return this.deps.resolveEnvironmentConfig?.(session.environmentId) ?? {
      name: session.environmentId || 'local',
      sandbox_provider: 'local',
      timeout: 300,
    };
  }

  /**
   * Resolve the backend named by the Environment.
   *
   * An unresolvable type is an error. The previous behavior — falling back to
   * the default (local, unsandboxed) provider — meant a session configured for
   * an isolated backend would silently execute on the runtime host instead,
   * which is a security regression disguised as a fallback.
   */
  private resolveProvider(type: SandboxProviderType): SandboxProvider {
    const registry = this.deps.sandboxRegistry;
    if (registry) return registry.get(type);
    // No registry wired (embedded / test usage): the single configured
    // provider is the only backend that can serve the request.
    if (type === this.deps.sandboxProvider.type) return this.deps.sandboxProvider;
    throw new UnknownSandboxProviderError(type, [this.deps.sandboxProvider.type]);
  }
}
