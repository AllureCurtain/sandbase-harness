import type { Database } from '../db/database.js';
import { runtimeCapabilityRegistry } from '../capabilities/registry.js';
import { loadAgentDefinitionById } from '../agent/store.js';
import { SessionManager } from '../session/session-manager.js';
import { DefaultSessionExecutor } from '../session/executor.js';
import { ContextCompactor } from '../session/context-compactor.js';
import { recordSessionOutputs } from '@/core/session/session-outputs.js';
import { SnapshotManager } from '../session/snapshot-manager.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { Skill } from '../skills/loader.js';
import type { MemoryProvider } from '../memory/memory-provider.js';
import { SqliteMemoryRecordsProvider } from '../memory/sqlite-memory-records-provider.js';
import { SqliteMemoryMountAdapter, type MemoryMountAdapter } from '../memory/mount-adapter.js';
import type { ModelRegistry } from '../../model/registry.js';
import type { SandboxProvider } from '@/types/sandbox.js';
import type { SandboxProviderRegistry } from '@/sandbox/registry.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { AgentStrategy } from '@/types/strategy.js';
import type { SessionLoopEngine } from '@/types/session.js';
import type { SandboxLifecycleLogger } from '../session/sandbox-lifecycle.js';
import type { RuntimeComposition } from './composition.js';
import type { CredentialInjectionBundle, CredentialInjectionTarget } from '@/core/credentials/injection.js';

export interface RuntimeSessionServicesOptions {
  db: Database;
  agents: AgentDefinition[];
  modelRegistry: ModelRegistry;
  sandboxProvider: SandboxProvider;
  sandboxRegistry: SandboxProviderRegistry;
  runtimeComposition: Pick<RuntimeComposition, 'resolveEnvironmentConfig'>;
  strategy: AgentStrategy;
  /** Engine copied to each new session. Existing rows retain their own engine. */
  loopEngine?: SessionLoopEngine;
  /** Resolve the strategy matching a persisted session engine. */
  resolveStrategy?: (loopEngine: SessionLoopEngine) => AgentStrategy;
  /** Engines this process can actually dispatch for new sessions. */
  isLoopEngineAvailable?: (loopEngine: SessionLoopEngine) => boolean;
  skills: Skill[];
  skillsDir?: string;
  memory?: MemoryProvider;
  /** Optional override for API-managed memory_records; defaults to SQLite. */
  memoryRecords?: MemoryProvider;
  /** Resolves a store name for legacy resources without persisted mount_path. */
  memoryStoreName?: (storeId: string) => string | undefined;
  memoryMount?: MemoryMountAdapter;
  artifactStore: ArtifactStore;
  defaultMaxSteps: number;
  /**
   * Resolve a session's vault credentials for a turn.
   *
   * Optional: a host that embeds these services without a credential store
   * passes nothing, and a session with no vaults resolves to an empty bundle. The
   * resolver enforces the network policy before it decrypts anything, so a
   * credential the turn cannot use arrives in `denied` rather than in the
   * environment.
   */
  resolveCredentialInjections?: (sessionId: string, target?: CredentialInjectionTarget) => CredentialInjectionBundle;
  /** Optional sink for sandbox capability-gap warnings. */
  logger?: SandboxLifecycleLogger;
}

export interface RuntimeSessionServices {
  sessionManager: SessionManager;
  executor: DefaultSessionExecutor;
  snapshots: SnapshotManager;
  reconciled: number;
}

export function createRuntimeSessionServices(options: RuntimeSessionServicesOptions): RuntimeSessionServices {
  const sessionManager = new SessionManager(
    options.db,
    runtimeCapabilityRegistry,
    options.loopEngine ?? 'builtin',
    (environmentId: string) => options.runtimeComposition.resolveEnvironmentConfig(environmentId)?.sandbox_provider,
    options.isLoopEngineAvailable,
  );
  const eventLogger = sessionManager.getEventLogger();
  const snapshots = new SnapshotManager(options.db, options.artifactStore.path('snapshots'));
  const memoryRecords = options.memoryRecords ?? new SqliteMemoryRecordsProvider(options.db);

  const executor = new DefaultSessionExecutor({
    agents: options.agents,
    modelRegistry: options.modelRegistry,
    sandboxProvider: options.sandboxProvider,
    sandboxRegistry: options.sandboxRegistry,
    resolveEnvironmentConfig: options.runtimeComposition.resolveEnvironmentConfig,
    resolveAgent: (agentId) => loadAgentDefinitionById(options.db, agentId),
    strategy: options.strategy,
    resolveStrategy: options.resolveStrategy,
    eventLogger,
    compactor: new ContextCompactor(),
    skills: options.skills,
    skillsDir: options.skillsDir,
    memory: options.memory,
    memoryRecords,
    memoryStoreName: options.memoryStoreName ?? ((storeId: string) => {
      const row = options.db.prepare('SELECT name FROM memory_stores WHERE id = ?').get(storeId) as { name: string } | undefined;
      return row?.name;
    }),
    memoryMount: options.memoryMount ?? new SqliteMemoryMountAdapter(options.db),
    snapshots,
    defaultMaxSteps: options.defaultMaxSteps,
    // Passed through rather than defaulted: the executor resolves a session's
    // vault per turn only when the host that assembled these services supplied a
    // credential store, so an embedder with none keeps running sessions that hold
    // no vault.
    resolveCredentialInjections: options.resolveCredentialInjections,
    logger: options.logger,
    sessionOutputSink: (sessionId, files) => {
      recordSessionOutputs({
        db: options.db,
        artifactStore: options.artifactStore,
        sessionId,
        files,
      });
    },
  });
  sessionManager.setExecutor(executor);

  const reconciled = sessionManager.reconcileOrphans();

  return {
    sessionManager,
    executor,
    snapshots,
    reconciled,
  };
}
