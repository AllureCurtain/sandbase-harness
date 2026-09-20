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
import type { ModelRegistry } from '../../model/registry.js';
import type { SandboxProvider } from '@/types/sandbox.js';
import type { SandboxProviderRegistry } from '@/sandbox/registry.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { AgentStrategy } from '@/types/strategy.js';
import type { SessionLoopEngine } from '@/types/session.js';
import type { SandboxLifecycleLogger } from '../session/sandbox-lifecycle.js';
import type { RuntimeComposition } from './composition.js';

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
  artifactStore: ArtifactStore;
  defaultMaxSteps: number;
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
    snapshots,
    defaultMaxSteps: options.defaultMaxSteps,
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
