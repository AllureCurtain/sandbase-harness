/**
 * Session Executor
 *
 * Wires together the full execution pipeline:
 * SessionManager.sendEvent → load agent → create model → provision sandbox →
 * build messages (eventsToMessages) → execute Strategy → broadcast events
 *
 * Sandbox lifecycle: one Sandbox instance is provisioned per Session on the
 * first turn and REUSED across subsequent turns (1:1 Session↔Sandbox binding,
 * R9.3). It is only destroyed via cleanupSession() when the Session reaches a
 * terminal state (stop/delete/failed).
 */

import { dirname, resolve, sep } from 'node:path';
import type { SessionExecutor, ExecuteOptions } from './session-manager.js';
import type { Session, SessionEvent, SessionLoopEngine } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { SandboxInstance, SandboxProvider, EnvironmentConfig } from '@/types/sandbox.js';
import type { SandboxProviderRegistry } from '@/sandbox/registry.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import type { McpServerStatus } from '@/core/mcp/mcp-manager.js';
import { EventLogger } from './event-logger.js';
import { ContextCompactor } from './context-compactor.js';
import type { Skill } from '@/core/skills/loader.js';
import type { MemoryProvider } from '@/core/memory/memory-provider.js';
import type { SnapshotManager } from './snapshot-manager.js';
import { collectSessionOutputs, type SessionOutputFile } from './session-outputs.js';
import { SandboxLifecycle, type SandboxLifecycleLogger } from './sandbox-lifecycle.js';
import { ContextBuilder } from './context-builder.js';
import { DelegationService } from './delegation-service.js';
import { ToolResolver } from './tool-resolver.js';
import { getToolsRequiringConfirmation } from '@/core/agent/standard.js';
import {
  assertPiAgentCanExecute,
  assertPiEnvironmentCanExecute,
  assertPiUserEventCanExecute,
} from './pi-policy.js';

export interface ExecutorDeps {
  agents: AgentDefinition[];
  modelRegistry: ModelRegistry;
  /** Default sandbox provider (used when no registry/env resolution applies). */
  sandboxProvider: SandboxProvider;
  /** Optional registry to select a provider by Environment sandbox_provider. */
  sandboxRegistry?: SandboxProviderRegistry;
  /** Resolve a session environment id to its runtime configuration. */
  resolveEnvironmentConfig?: (environmentId: string) => EnvironmentConfig | undefined;
  /** Resolve an agent id from durable storage. */
  resolveAgent?: (agentId: string) => AgentDefinition | undefined;
  strategy: AgentStrategy;
  /** Resolve a strategy for the engine frozen on a persisted session. */
  resolveStrategy?: (loopEngine: SessionLoopEngine) => AgentStrategy;
  eventLogger: EventLogger;
  /** Optional context compactor. If provided, long histories are summarized. */
  compactor?: ContextCompactor;
  /** Loaded skills, injected into agent system prompts by name (R4). */
  skills?: Skill[];
  /** Root directory containing explicit skill packages for Pi --skill flags. */
  skillsDir?: string;
  /** Optional long-term memory provider, scoped by context_id (R9.16–18). */
  memory?: MemoryProvider;
  /** Optional workspace snapshot manager (R9.11). */
  snapshots?: SnapshotManager;
  /** Workspace fallback when an agent does not set max_turns. */
  defaultMaxSteps?: number;
  /** Optional sink for sandbox capability-gap warnings. */
  logger?: SandboxLifecycleLogger;
  /**
   * Publish the files an agent wrote under the session output directory.
   *
   * Optional because an embedder with no Files API has nowhere to put them.
   * Called after every turn, with whatever the sandbox currently holds.
   */
  sessionOutputSink?: (sessionId: string, files: SessionOutputFile[]) => void | Promise<void>;
}

export class DefaultSessionExecutor implements SessionExecutor {
  private readonly sandboxLifecycle: SandboxLifecycle;
  private readonly contextBuilder: ContextBuilder;
  private readonly delegationService: DelegationService;
  private readonly toolResolver: ToolResolver;

  constructor(private readonly deps: ExecutorDeps) {
    this.sandboxLifecycle = new SandboxLifecycle(deps);
    this.contextBuilder = new ContextBuilder({
      eventLogger: deps.eventLogger,
      compactor: deps.compactor,
      skills: deps.skills,
      memory: deps.memory,
    });
    this.delegationService = new DelegationService({
      agents: deps.agents,
      modelRegistry: deps.modelRegistry,
      strategy: deps.strategy,
      resolveStrategy: deps.resolveStrategy,
      // Route sub-agent sandboxes through the lifecycle so they resolve to the
      // parent session's backend instead of always landing on local.
      provisionSandbox: (session, sandboxId) => this.sandboxLifecycle.provisionDetached(session, sandboxId),
      composeSystemPrompt: (agent) => this.contextBuilder.composeSystemPrompt(agent),
      buildSandboxTools: (agent, sandbox) => this.toolResolver.buildSandboxTools(agent, sandbox),
      resolveSkillDirs: (agent) => this.skillDirsFor(agent),
    });
    this.toolResolver = new ToolResolver({ delegationService: this.delegationService });
  }

  async *execute(
    session: Session,
    event: UserEvent,
    options?: ExecuteOptions,
  ): AsyncIterable<SessionEvent> {
    const { agents, modelRegistry, eventLogger } = this.deps;
    const strategy = this.deps.resolveStrategy?.(session.loopEngine ?? 'builtin') ?? this.deps.strategy;

    // 1. Load agent definition
    const agent = session.agentDefinition
      ?? this.deps.resolveAgent?.(session.agentId)
      ?? agents.find((a) => a.name === session.agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }
    if (session.loopEngine === 'pi') {
      // A direct executor caller must fail closed before any model construction,
      // sandbox provisioning, confirmation handling, event persistence, or child launch.
      assertPiAgentCanExecute(agent);
      const environment = this.deps.resolveEnvironmentConfig?.(session.environmentId);
      assertPiEnvironmentCanExecute(environment?.sandbox_provider ?? this.deps.sandboxProvider.type);
      assertPiUserEventCanExecute(event);
    }

    // Pi owns model transport, but it still receives the selected concrete
    // model configuration. Builtin strategies retain AI SDK construction and
    // do not need registry resolution before their existing model factory.
    const modelConfig = strategy.requiresModel === false
      ? modelRegistry.resolveModelConfig(agent.model)
      : undefined;
    const model = strategy.requiresModel === false ? undefined : modelRegistry.createModel(agent.model);

    // 3. Provision sandbox (or reuse the one bound to this session)
    const sandbox = await this.sandboxLifecycle.getOrProvision(session);

    // 3a. Handle a tool confirmation (A5): run or deny the pending tool, append
    // its result so the model turn below continues with a paired sequence.
    // A stale confirmation (the referenced call already resolved — e.g. a
    // double-click or a queued click on an older card) must not start a model
    // turn: the log may hold other unpaired tool calls awaiting their own
    // confirmation, and the request would carry an unpaired tool call that
    // providers reject with "Tool result is missing".
    if (event.type === 'user.tool_confirmation') {
      const resolution = await this.toolResolver.handleToolConfirmation(
        session,
        agent,
        sandbox,
        event,
        eventLogger,
        options?.broadcast ?? (() => {}),
      );
      if (!resolution.handled) return;
      if (!resolution.groupComplete) {
        options?.onRequiresAction?.();
        return;
      }
    }

    const broadcast = options?.broadcast ?? (() => {});

    // 4. Build context: compaction, Event_Log projection, skills, and memory.
    const { systemPrompt, messages } = await this.contextBuilder.build(
      session,
      agent,
      event,
      model,
      broadcast,
    );

    // 5. Build tools: built-in sandbox tools, MCP tools, delegation tools, and
    // confirm-required stripping.
    const tools = await this.toolResolver.resolveTools(session, agent, sandbox);
    const confirmTools = getToolsRequiringConfirmation(agent);

    // 6. Execute strategy
    const context: StrategyContext = {
      session: { ...session, agentDefinition: agent },
      userEvent: event,
      systemPrompt,
      messages: messages as any,
      modelConfig,
      model,
      ...(this.deps.skillsDir ? { skillDirs: this.skillDirsFor(agent) } : {}),
      tools,
      sandbox,
      eventLog: eventLogger,
      broadcast, // real SSE broadcast wired from SessionManager
      config: {
        maxSteps: agent.max_turns ?? this.deps.defaultMaxSteps ?? 25,
        temperature: agent.temperature ?? 0.7,
        confirmTools,
        onRequiresAction: options?.onRequiresAction,
      },
      abortSignal: options?.abortSignal,
    };

    for await (const evt of strategy.execute(context)) {
      yield evt;
    }

    // 7. Extract key facts into long-term memory (R9.18), scoped by context_id.
    await this.contextBuilder.extractMemory(session, event).catch(() => {});

    // 8. Snapshot the workspace after the turn if enabled (R9.11).
    this.sandboxLifecycle.snapshotAfterTurn(session, sandbox);

    // 9. Publish the files the agent wrote under the session output root.
    await this.publishSessionOutputs(session, sandbox);
    // NOTE: no sandbox/MCP cleanup here — they persist for the session
    // lifetime and are destroyed via cleanupSession() on terminal states.
  }

  /**
   * Publish the files an agent wrote under `/mnt/session/outputs`.
   *
   * Only meaningful when a sink is wired: an embedder with no Files API has
   * nowhere to put them. Failures are swallowed because the turn itself has
   * already completed — a collection error must not turn a successful agent run
   * into a failed session, and the next turn re-reads the same directory.
   */
  private async publishSessionOutputs(session: Session, sandbox: SandboxInstance): Promise<void> {
    const sink = this.deps.sessionOutputSink;
    if (!sink) return;
    try {
      const outputs = await collectSessionOutputs(sandbox);
      if (outputs.length === 0) return;
      await sink(session.id, outputs);
    } catch {
      // best-effort: the output directory is re-read on the next turn
    }
  }

  private skillDirsFor(agent: AgentDefinition): string[] {
    const root = this.deps.skillsDir;
    if (!root) return [];
    const resolvedRoot = resolve(root);
    const byId = new Map((this.deps.skills ?? []).map((skill) => [skill.id, skill]));
    return (agent.skills ?? []).flatMap((reference) => {
      const skill = byId.get(reference.skill_id);
      if (!skill?.file) return [];
      const file = resolve(resolvedRoot, skill.file);
      if (file !== resolvedRoot && !file.startsWith(`${resolvedRoot}${sep}`)) return [];
      return [dirname(file)];
    });
  }

  /**
   * Destroy the sandbox + MCP connections bound to a session. Called by
   * SessionManager when the session reaches a terminal state.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    await this.sandboxLifecycle.cleanup(sessionId);
    await this.toolResolver.cleanupSession(sessionId);
  }

  /** MCP connection status for a session (for /v1/x/mcp/status). */
  getMcpStatus(sessionId: string): McpServerStatus[] {
    return this.toolResolver.getMcpStatus(sessionId);
  }
}
