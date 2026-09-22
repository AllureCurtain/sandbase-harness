/**
 * Session Manager
 *
 * Core control-plane component managing the full Session lifecycle:
 * create → sendEvent → subscribe → stop
 *
 * Separation of concerns:
 * - SessionManager owns the control plane (status, Event_Log, routing)
 * - SandboxProvider owns the execution plane (file system, processes)
 * - AgentStrategy owns the engine loop (LLM calls, tool execution)
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { parseSessionVaultIds } from '@/core/credentials/injection.js';
import { EventLogger } from './event-logger.js';
import { eventTypeForStatus, isAbortError } from './session-lifecycle.js';
import { findOrphanedToolUses } from './session-recovery.js';
import { rowToSession, type SessionRow } from './session-records.js';
import { buildSessionUsageSnapshot } from './session-usage.js';
import {
  BUDGET_ERROR_CODES,
  BUDGET_SETTLEMENT_EVENT_LIST,
  budgetError,
  budgetReached,
  budgetCapMicrocents,
  isSettlementEvent,
  serializeBudget,
  sessionSpend,
  unpricedDeclaredModels,
  type SessionSpend,
} from './session-budget.js';
import {
  costProfileFromEnv,
  declaredModels,
  type CostProfile,
} from './cost-profile.js';
import { canTransition, isTerminal } from './state-machine.js';
import type {
  Session,
  SessionLoopEngine,
  SessionStatus,
  SessionEvent,
  CreateSessionParams,
  ListSessionsParams,
  PaginatedResult,
} from '@/types/session.js';
import type {
  ContentBlock,
  SessionBudget,
  SessionErrorRetryStatus,
  UserEvent,
} from '@/types/cma-protocol.js';
import {
  LOOP_ENGINE_INVALID_CODE,
  LOOP_ENGINE_UNSUPPORTED_CODE,
} from './loop-engine-admission.js';
import type { AgentDefinition, AgentOverrides } from '@/types/agent.js';
import { agentOverrideError, applyAgentOverrides } from '@/core/agent/overrides.js';
import { OUTCOME_EVALUATOR_UNAVAILABLE_CODE, type OutcomeGrader } from '@/core/outcomes/grader.js';
import {
  DEFAULT_OUTCOME_MAX_ITERATIONS,
  OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE,
} from '@/core/outcomes/contract.js';
import {
  OutcomeInterruptedError,
  outcomeGraderUnavailableError,
  runOutcomeLoop,
} from '@/core/outcomes/loop.js';
import { outcomeTranscript } from './outcome-transcript.js';
import {
  runtimeCapabilityRegistry,
  type RuntimeCapabilityRegistry,
} from '@/core/capabilities/registry.js';
import {
  assertPiAgentCanExecute,
  assertPiEnvironmentCanExecute,
  assertPiUserEventCanExecute,
  PI_ALWAYS_ASK_UNSUPPORTED_CODE,
  PI_MESSAGE_CONTENT_UNSUPPORTED_CODE,
  PI_SANDBOX_UNSUPPORTED_CODE,
  PI_TOOL_POLICY_UNSUPPORTED_CODE,
  PI_USER_EVENT_UNSUPPORTED_CODE,
} from './pi-policy.js';
import {
  assertLoopEngineExecutable,
  resolveRequestedLoopEngine,
} from './loop-engine-admission.js';

// ============================================================
// Types
// ============================================================

export interface ExecuteOptions {
  /** Aborts the turn when the user sends user.interrupt. */
  abortSignal?: AbortSignal;
  /** Pushes an event to live SSE subscribers (does not persist). */
  broadcast?: (event: SessionEvent) => void;
  /** Called when the turn suspends awaiting user tool confirmation (A5). */
  onRequiresAction?: () => void;
}

export interface SessionExecutor {
  /** Called when a user event is received — runs the engine loop */
  execute(session: Session, event: UserEvent, options?: ExecuteOptions): AsyncIterable<SessionEvent>;
  /** Destroy resources (sandbox) bound to a session on terminal state */
  cleanupSession?(sessionId: string): Promise<void>;
  /**
   * Reconnect a session's MCP servers after the credential they authenticate with
   * changed, so the next tool call uses the new value. Optional: an executor with no
   * MCP support, or one whose session never connected a server, has nothing to do.
   */
  refreshSessionMcpCredentials?(sessionId: string): Promise<void>;
}

type Subscriber = (event: SessionEvent) => void;
type EnvironmentSandboxProviderResolver = (environmentId: string) => string | undefined;

// ============================================================
// Session Manager
// ============================================================

export class SessionManager {
  private readonly eventLogger: EventLogger;
  private readonly resolveEnvironmentSandboxProvider: EnvironmentSandboxProviderResolver;
  private readonly isLoopEngineExecutable: (engine: SessionLoopEngine) => boolean;
  private subscribers = new Map<string, Set<Subscriber>>();
  /**
   * Process-wide listener for every event that reaches the broadcast step.
   *
   * Distinct from `subscribers`, which are per session and exist for one SSE
   * connection. A projection that answers a runtime-wide question — webhook
   * dispatch, for instance — would otherwise have to discover sessions first.
   */
  private broadcastListener?: (event: SessionEvent) => void;
  private executor?: SessionExecutor;
  /** Grader for a declared outcome; absent means the outcome is not measured. */
  private outcomeGrader?: OutcomeGrader;
  /** Reader for a `{type: "file"}` rubric; absent means a file rubric is refused. */
  private rubricFileResolver?: (fileId: string) => string | undefined;
  /** Per-session execution chain — serializes turns so they never overlap. */
  private executionChains = new Map<string, Promise<void>>();
  /** Per-session abort controller for the currently running turn. */
  private abortControllers = new Map<string, AbortController>();
  /**
   * List prices budgets are metered against. Configuration, not policy: it
   * comes from the operator (an empty profile by default, which prices nothing),
   * and a session that names an unpriced model is refused a budget rather than
   * metered against an invented rate.
   */
  private costProfile: CostProfile = costProfileFromEnv();

  constructor(
    private readonly db: Database,
    private readonly capabilityRegistry: RuntimeCapabilityRegistry = runtimeCapabilityRegistry,
    /** Captured into each newly created session; persisted sessions retain their own value. */
    private readonly defaultLoopEngine: SessionLoopEngine = 'builtin',
    environmentSandboxProviderResolver?: EnvironmentSandboxProviderResolver,
    loopEngineAvailability?: (engine: SessionLoopEngine) => boolean,
  ) {
    this.isLoopEngineExecutable = loopEngineAvailability ?? ((engine) => engine === this.defaultLoopEngine);
    this.eventLogger = new EventLogger(db);
    // Direct/embedded managers do not have runtime Settings V2 composition.
    // Retain their declared-Environment lookup, but let composed runtimes make
    // the authoritative effective-provider decision (including env_default).
    this.resolveEnvironmentSandboxProvider = environmentSandboxProviderResolver
      ?? ((environmentId) => this.declaredEnvironmentSandboxProvider(environmentId));
  }

  getCapabilityRegistry(): RuntimeCapabilityRegistry {
    return this.capabilityRegistry;
  }

  assertAgentCapabilities(agent: AgentDefinition): void {
    this.capabilityRegistry.assertAgentSupported(agent);
  }

  /**
   * Validate the definition that governs this session at event ingress.
   * Persisted version snapshots remain authoritative; unpinned legacy
   * sessions intentionally follow the current durable agent definition.
   */
  assertSessionCapabilities(session: Session): void {
    const effectiveAgent = session.agentDefinition ?? this.resolveAgentSnapshot(session.agentId)?.definition;
    if (effectiveAgent) this.assertAgentCapabilities(effectiveAgent);
  }

  /**
   * Install the list-price profile budgets are metered against.
   *
   * Replaced wholesale rather than merged: a partial merge would price some
   * models from the new rates and leave others at the old ones, which reads as
   * an intermittent budget failure rather than a misconfiguration.
   */
  setCostProfile(profile: CostProfile): void {
    this.costProfile = profile;
  }

  getCostProfile(): CostProfile {
    return this.costProfile;
  }

  /**
   * Consumed list cost for a session, derived from its durable log.
   *
   * Derived on every read instead of accumulated into a counter: this runtime
   * already records exactly one `span.model_request_end` per model request, so a
   * second running total could only disagree with it, and a cached one would not
   * survive the process that wrote it.
   */
  getSessionSpend(sessionId: string): SessionSpend {
    return sessionSpend(this.db, sessionId, this.costProfile, this.eventLogger.getEvents(sessionId));
  }

  /**
   * Whether the session has reached its declared ceiling.
   *
   * A session that never had a budget, or had one removed, is never exhausted:
   * the ceiling exists only for as long as the budget does.
   */
  isBudgetExhausted(sessionId: string): boolean {
    const session = this.get(sessionId);
    return session ? this.budgetExhaustedFor(session) : false;
  }

  private budgetExhaustedFor(session: Session): boolean {
    if (!session.budget) return false;
    return budgetReached(this.getSessionSpend(session.id), session.budget);
  }

  /**
   * Build the documented `session.usage` payload for a session.
   *
   * `list_cost` is omitted when any model the session used has no list price: a
   * lower bound reported as the total would understate spend to a client that is
   * choosing a new cap. `budget` is always present — `null` when the session has
   * none — because the runtime holds that answer.
   */
  buildUsagePayload(sessionId: string): {
    input_tokens: number;
    output_tokens: number;
    active_seconds: number;
    list_cost?: number;
    budget: SessionBudget | null;
    server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  } {
    return this.usagePayloadFor(sessionId, this.eventLogger.getEvents(sessionId));
  }

  /** Shared with the snapshot the status transition already loaded the log for. */
  private usagePayloadFor(sessionId: string, events: SessionEvent[]): {
    input_tokens: number;
    output_tokens: number;
    active_seconds: number;
    list_cost?: number;
    budget: SessionBudget | null;
    server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  } {
    const session = this.get(sessionId);
    const snapshot = buildSessionUsageSnapshot(events, {
      tokensIn: session?.usage?.tokensIn,
      tokensOut: session?.usage?.tokensOut,
    });
    const spend = sessionSpend(this.db, sessionId, this.costProfile, events);

    return {
      ...snapshot,
      ...(spend.meterable ? { list_cost: spend.cents } : {}),
      budget: session?.budget ?? null,
      // Genuinely zero, not unknown: this runtime has no built-in web tool, so
      // there is no request it could have failed to count.
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    };
  }

  /**
   * Move or remove a session's budget.
   *
   * Only the budget is updatable here; the remaining session fields (title,
   * metadata, agent) belong to the session-update behaviour. The contract's
   * rules all live in this one method because they are all one question: how a
   * ceiling may move relative to what has already been consumed.
   */
  update(sessionId: string, params: { budget?: SessionBudget | null }): Session {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (params.budget === undefined) return session;

    // A budget is attachable at creation only, so "never had one" is a refusal
    // rather than a default. Removing one is final for the same reason: the
    // contract refuses to re-attach after a removal, which is why the removal is
    // recorded in the column as `null` rather than by clearing it.
    if (session.budget === undefined) {
      throw budgetError(
        BUDGET_ERROR_CODES.notAttachable,
        `Session ${sessionId} has no budget: a budget can only be attached when the session is created`,
      );
    }
    if (session.budget === null) {
      throw budgetError(
        BUDGET_ERROR_CODES.notAttachable,
        `Session ${sessionId} had its budget removed: a budget cannot be re-added`,
      );
    }

    if (params.budget === null) {
      this.persistBudget(sessionId, null);
      return this.get(sessionId) ?? session;
    }

    const spend = this.getSessionSpend(sessionId);
    if (!spend.meterable) {
      throw budgetError(
        BUDGET_ERROR_CODES.modelWithoutListPrice,
        `Session ${sessionId} consumed ${spend.unpricedModels.join(', ')}, which has no list price, so its budget cannot be changed`,
      );
    }
    // Strictly greater: a cap equal to what was consumed would leave the session
    // paused forever, because the next request could never be admitted.
    if (spend.microcents >= budgetCapMicrocents(params.budget)) {
      throw budgetError(
        BUDGET_ERROR_CODES.belowConsumed,
        `The new budget must be greater than the session's consumed list cost (${spend.cents} cents)`,
      );
    }

    this.persistBudget(sessionId, params.budget);
    return this.get(sessionId) ?? session;
  }

  /** `null` records a removal, which is a different state from "never had one". */
  private persistBudget(sessionId: string, budget: SessionBudget | null): void {
    this.db.prepare(
      `UPDATE sessions SET budget = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(serializeBudget(budget), sessionId);
  }

  /**
   * Refuse a work-starting event once the session has spent its ceiling.
   *
   * The refusal is structured and names the events that are still accepted, so a
   * client learns what it may send instead of retrying the event that was just
   * rejected. Because only settlement events get past this point, the turn queue
   * is never given work while the session is at its cap — which is what makes
   * "the next model request does not start" true rather than merely intended.
   */
  private assertBudgetAdmitsEvent(session: Session, event?: UserEvent): void {
    if (!event || isSettlementEvent(event.type)) return;
    if (!this.budgetExhaustedFor(session)) return;
    throw budgetError(
      BUDGET_ERROR_CODES.reached,
      `Session ${session.id} has reached its budget. Only events that settle work already in flight are accepted: ${BUDGET_SETTLEMENT_EVENT_LIST}`,
    );
  }

  /**
   * Refuse a declared outcome on a runtime that composes no grader.
   *
   * The refusal is deliberately at admission rather than at the end of the first
   * iteration: acceptance would promise a measurement the runtime can never make,
   * and the session would run an outcome that has no way to end. Once a grader is
   * registered — as every runtime with a model registry does — the check admits
   * the event and the loop is the thing that grades it.
   */
  private assertOutcomeGraderAdmitsEvent(event?: UserEvent): void {
    if (event?.type !== 'user.define_outcome') return;
    if (this.outcomeGrader) return;
    throw outcomeGraderUnavailableError();
  }

  /**
   * Register the session executor (called once during server init).
   */
  setExecutor(executor: SessionExecutor): void {
    this.executor = executor;
  }

  /**
   * Create a new Session (two-step lifecycle step 1: provision).
   * Status starts as 'queued'. Execution begins on first sendEvent().
   */
  create(params: CreateSessionParams): Session {
    const id = `sess_${nanoid(16)}`;
    const now = new Date();
    const loopEngine = resolveRequestedLoopEngine(params.loopEngine) ?? this.defaultLoopEngine;
    assertLoopEngineExecutable(loopEngine, this.isLoopEngineExecutable);

    const agentSnapshot = this.resolveAgentSnapshot(params.agent, params.agentVersion);
    if (!agentSnapshot) {
      throw new Error(`Agent not found: ${params.agent}`);
    }

    // Overrides produce the session's own agent snapshot. Capability admission
    // and the persisted definition both read the resolved one, so a session
    // cannot pass a gate on the base agent and then execute with a different
    // tool or model set than the one that was checked.
    const effectiveDefinition = this.resolveSessionAgentDefinition(agentSnapshot.definition, params.agentOverrides);
    this.assertAgentCapabilities(effectiveDefinition);
    if (loopEngine === 'pi') {
      assertPiAgentCanExecute(effectiveDefinition);
      assertPiEnvironmentCanExecute(this.resolveEnvironmentSandboxProvider(params.environmentId ?? 'env_default'));
    }

    // A budget can only be metered when the model the session runs has a list
    // price. Refusing before the row is inserted is what keeps a refused budget
    // from leaving an unbudgeted session behind, which would look like the
    // ceiling had been accepted and then silently not applied.
    if (params.budget) {
      const unpriced = unpricedDeclaredModels(
        this.costProfile,
        declaredModels([effectiveDefinition.model]),
      );
      if (unpriced.length > 0) {
        throw budgetError(
          BUDGET_ERROR_CODES.modelWithoutListPrice,
          `Agent ${agentSnapshot.name} runs ${unpriced.join(', ')}, which has no list price, so the session cannot be given a budget`,
        );
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, agent_id, agent_name, agent_version, agent_definition, loop_engine,
        environment_id, status, title, context_id, resources, vault_ids, metadata, budget
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
    `);

    // The resolved definition is persisted whenever the session's configuration
    // can differ from the durable agent's: a version pin already did, and an
    // override does too. A session that pins nothing and overrides nothing keeps
    // following the current agent, which is the documented unpinned behaviour.
    const frozenDefinition = params.agentVersion !== undefined || params.agentOverrides !== undefined
      ? JSON.stringify(effectiveDefinition)
      : null;

    stmt.run(
      id,
      agentSnapshot.id,
      agentSnapshot.name,
      agentSnapshot.version,
      frozenDefinition,
      loopEngine,
      params.environmentId ?? 'env_default',
      params.title ?? null,
      params.contextId ?? null,
      JSON.stringify(params.resources ?? []),
      JSON.stringify(params.vaultIds ?? []),
      params.metadata ? JSON.stringify(params.metadata) : null,
      // A session created without a budget stores SQL NULL, not the JSON literal
      // `null`: only a removal writes that, so "never had one" and "had one
      // removed" stay distinguishable in the column.
      params.budget ? serializeBudget(params.budget) : null,
    );

    return {
      id,
      agentId: agentSnapshot.id,
      agentName: agentSnapshot.name,
      agentVersion: agentSnapshot.version,
      agentDefinition: frozenDefinition ? effectiveDefinition : undefined,
      loopEngine,
      environmentId: params.environmentId ?? 'env_default',
      status: 'queued',
      title: params.title,
      contextId: params.contextId,
      resources: params.resources,
      vaultIds: params.vaultIds,
      metadata: params.metadata,
      budget: params.budget,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Apply the session's overrides to the resolved agent version.
   *
   * The refusal is thrown rather than swallowed: a caller that sent
   * `agent_with_overrides` expects either a session running that configuration
   * or a rejection, never a session silently running the base agent.
   */
  private resolveSessionAgentDefinition(
    base: AgentDefinition,
    overrides: AgentOverrides | undefined,
  ): AgentDefinition {
    if (!overrides) return base;
    const resolved = applyAgentOverrides(base, overrides);
    if (!resolved.ok) {
      throw agentOverrideError(resolved.code, resolved.message);
    }
    return resolved.definition;
  }

  private resolveAgentSnapshot(agentId: string, version?: number): { id: string; name: string; version: number; definition: AgentDefinition } | undefined {
    if (version !== undefined) {
      const row = this.db.prepare(`
        SELECT agent_id, version, name, definition
        FROM agent_versions
        WHERE agent_id = ?
          AND version = ?
      `).get(agentId, version) as { agent_id: string; version: number; name: string; definition: string } | undefined;
      if (!row) {
        const current = this.loadCurrentAgentRow(agentId);
        if (!current || (current.version ?? 1) !== version) return undefined;
        return {
          id: current.id,
          name: current.name,
          version: current.version ?? 1,
          definition: JSON.parse(current.definition) as AgentDefinition,
        };
      }
      return {
        id: row.agent_id,
        name: row.name,
        version: row.version,
        definition: JSON.parse(row.definition) as AgentDefinition,
      };
    }

    const row = this.loadCurrentAgentRow(agentId);
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      version: row.version ?? 1,
      definition: JSON.parse(row.definition) as AgentDefinition,
    };
  }

  private loadCurrentAgentRow(agentId: string): { id: string; name: string; definition: string; version?: number } | undefined {
    return this.db.prepare(`
      SELECT id, name, definition, version
      FROM agents
      WHERE id = ?
        AND archived_at IS NULL
        AND status != 'archived'
    `).get(agentId) as { id: string; name: string; definition: string; version?: number } | undefined;
  }

  private assertPiSessionCanExecute(session: Session, event?: UserEvent): void {
    if (session.loopEngine !== 'pi') return;
    const agent = session.agentDefinition
      ?? this.resolveAgentSnapshot(session.agentId, session.agentVersion)?.definition;
    if (agent) assertPiAgentCanExecute(agent);
    assertPiEnvironmentCanExecute(this.resolveEnvironmentSandboxProvider(session.environmentId));
    if (event) assertPiUserEventCanExecute(event);
  }

  /**
   * Session admission also runs in embedded/direct manager use, where runtime
   * composition is not available. Read only the declared Environment backend
   * here; Settings V2 separately validates the workspace default backend.
   */
  private declaredEnvironmentSandboxProvider(environmentId: string): string | undefined {
    // The workspace default is overlaid from active Settings V2 at runtime and
    // validated there. Only named Environments are explicit session overrides.
    if (environmentId === 'env_default') return undefined;
    const row = this.db.prepare(
      'SELECT config FROM environments WHERE id = ? AND archived_at IS NULL',
    ).get(environmentId) as { config: string } | undefined;
    if (!row) return undefined;
    try {
      const config = JSON.parse(row.config) as Record<string, unknown>;
      if (typeof config.sandbox_provider === 'string' && config.sandbox_provider.trim()) {
        return config.sandbox_provider;
      }
      return config.hosting_type === 'self_hosted' ? 'self_hosted' : 'local';
    } catch {
      return 'local';
    }
  }

  /**
   * Validate that a session may accept a new event without mutating its log or
   * scheduling execution. HTTP streaming routes use this before committing an
   * SSE response so policy failures retain their stable client error.
   */
  assertSessionCanAcceptEvent(sessionId: string, event?: UserEvent): Session {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (isTerminal(session.status)) {
      throw new Error(`Session ${sessionId} is in terminal state: ${session.status}`);
    }
    // Existing Pi rows can predate the creation guard. Reject them before
    // repair/persistence or queuing so a resumed turn cannot bypass policy.
    this.assertPiSessionCanExecute(session, event);
    // Checked after the engine policy so an unsupported engine keeps its own
    // error code: a client that must switch engines should hear that, not a
    // budget refusal it cannot act on.
    this.assertBudgetAdmitsEvent(session, event);
    // Checked last because it is the only one of the three the runtime can never
    // satisfy later: a declared outcome is measured by a grader, and a runtime
    // that composes none would accept an event it can never evaluate.
    this.assertOutcomeGraderAdmitsEvent(event);
    return session;
  }

  /**
   * Send a user event to a session.
   * Returns synchronous acknowledgment; actual execution is async via SSE.
   */
  async sendEvent(sessionId: string, event: UserEvent): Promise<{ accepted: boolean }> {
    if (!event || typeof (event as any).type !== 'string' || (event as any).type.length === 0) {
      throw new Error('Invalid event: missing required string "type" field');
    }

    const session = this.assertSessionCanAcceptEvent(sessionId, event);

    // Revalidate the snapshot-first/current-durable effective definition before
    // mutating the append-only log or queuing any model, sandbox, or tool work.
    this.assertSessionCapabilities(session);

    const confirmationMetadata = event.type === 'user.tool_confirmation'
      ? getConfirmationMetadata(event, this.eventLogger.getEvents(sessionId))
      : undefined;
    // A custom tool result is the only thing that can answer a custom tool call,
    // so it is validated against the log before it is appended — an id naming no
    // pending call, or a second result for a call already answered, is refused
    // rather than letting a caller inject an answer into a session.
    const customToolResultMetadata = event.type === 'user.custom_tool_result'
      ? getCustomToolResultMetadata(event, this.eventLogger.getEvents(sessionId))
      : undefined;
    const defineOutcomeMetadata = event.type === 'user.define_outcome'
      ? defineOutcomeMetadataFor(event)
      : undefined;

    // Resuming after failure, or sending a fresh message while a tool call is
    // still awaiting approval: the log may hold an agent.tool_use with no
    // paired result. Inject placeholder results before the new user event so
    // the next eventsToMessages projection has a valid, paired sequence
    // (mirrors reconcileOrphans). Legit user.tool_confirmation events are
    // exempt — the executor pairs their referenced call itself.
    if (session.status === 'failed' || event.type === 'user.message') {
      this.resolveOrphanedToolUses(sessionId, '(previous turn failed before this tool returned)');
    }

    // Append the user event to the log
    const logged = this.eventLogger.append(sessionId, {
      type: event.type,
      content: 'content' in event ? (event as any).content : undefined,
      metadata: confirmationMetadata ?? customToolResultMetadata ?? defineOutcomeMetadata,
    });
    this.broadcast(sessionId, logged);

    // user.interrupt jumps the queue and aborts the running turn — it does
    // NOT enqueue a new turn (there's no new work, just a stop signal).
    if (event.type === 'user.interrupt') {
      this.abortControllers.get(sessionId)?.abort();
      return { accepted: true };
    }

    // Execute asynchronously, serialized per session so turns never overlap.
    // The user event is already durably in the log; the chained turn will
    // read the full log (including this event) when it runs.
    if (this.executor) {
      const prev = this.executionChains.get(sessionId) ?? Promise.resolve();
      const next = prev
        .catch(() => {}) // isolate failures so one bad turn doesn't wedge the chain
        .then(() => this.runTurn(sessionId, event))
        .catch(() => {}); // never let a turn (even its prelude) reject the chain
      this.executionChains.set(sessionId, next);
      // Clean up the map entry once this is the last queued turn (L1 leak fix).
      void next.finally(() => {
        if (this.executionChains.get(sessionId) === next) {
          this.executionChains.delete(sessionId);
        }
      });
    }

    return { accepted: true };
  }

  /**
   * Subscribe to real-time session events (SSE pub/sub channel).
   */
  /**
   * Register the process-wide listener, replacing any previous one.
   *
   * The event is already durable in the append-only log by the time this runs,
   * so a listener failure is contained rather than propagated: a projection must
   * never be able to fail an event the log has accepted.
   */
  setBroadcastListener(listener: (event: SessionEvent) => void): void {
    this.broadcastListener = listener;
  }

  subscribe(sessionId: string, callback: Subscriber): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const set = this.subscribers.get(sessionId);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.subscribers.delete(sessionId);
      }
    };
  }

  /**
   * Create a session and, in the same transaction, append the caller's initial
   * events.
   *
   * A non-empty list starts the session `running` once the log is durable, so
   * the client's first turn is the one it asked for instead of an idle session
   * it has to poke. Creation and the events commit together: a throw inside the
   * transaction discards the row and every event appended before it, so a
   * rejected batch never leaves a session or a partial history behind.
   */
  createWithInitialEvents(params: CreateSessionParams & {
    /** Resource instances to attach inside the same transaction. */
    attachResources?: (sessionId: string) => void;
  }, events: UserEvent[]): Session {
    const session = this.db.transaction(() => {
      const created = this.create(params);
      // Attachment runs inside the transaction so a failure discards the session
      // row and every event appended before it: a session that claims a resource
      // it does not hold is worse than no session.
      params.attachResources?.(created.id);

      // Validate against the real row, not a synthetic id: admission checks
      // read the durable session and its log, so they only mean anything once
      // the row exists. Inside the transaction a throw discards the row and
      // every event appended before it, which is the property that matters.
      for (const event of events) {
        this.assertSessionCanAcceptEvent(created.id, event);
      }
      for (const event of events) {
        this.appendUserEventInTransaction(created.id, event);
      }
      return created;
    });

    // Post-commit: the log is durable, so the turn can now be queued.
    if (events.length > 0 && this.executor) {
      this.updateStatus(session.id, 'running');
    }
    for (const event of events) {
      this.enqueueTurnForEvent(session.id, event);
    }
    return this.get(session.id) ?? session;
  }

  /**
   * Append one user event to the log and broadcast it. This is the synchronous
   * half of `sendEvent` — everything except starting the model loop.
   */
  private appendUserEventInTransaction(sessionId: string, event: UserEvent): void {
    const customToolResultMetadata = event.type === 'user.custom_tool_result'
      ? getCustomToolResultMetadata(event, this.eventLogger.getEvents(sessionId))
      : undefined;
    const defineOutcomeMetadata = event.type === 'user.define_outcome'
      ? defineOutcomeMetadataFor(event)
      : undefined;
    const logged = this.eventLogger.append(sessionId, {
      type: event.type,
      content: 'content' in event ? (event as { content?: ContentBlock[] }).content : undefined,
      metadata: customToolResultMetadata ?? defineOutcomeMetadata,
    });
    this.broadcast(sessionId, logged);
  }

  /** Queue the turn for one initial event, serialized per session. */
  private enqueueTurnForEvent(sessionId: string, event: UserEvent): void {
    if (!this.executor) return;
    const prev = this.executionChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // isolate failures so one bad turn doesn't wedge the chain
      .then(() => this.runTurn(sessionId, event))
      .catch(() => {}); // never let a turn (even its prelude) reject the chain
    this.executionChains.set(sessionId, next);
    // Clean up the map entry once this is the last queued turn (L1 leak fix).
    void next.finally(() => {
      if (this.executionChains.get(sessionId) === next) {
        this.executionChains.delete(sessionId);
      }
    });
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  /**
   * List sessions with pagination.
   */
  list(params: ListSessionsParams = {}): PaginatedResult<Session> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    let countSql = 'SELECT COUNT(*) as total FROM sessions';
    let querySql = 'SELECT * FROM sessions';
    const conditions: string[] = [];
    const queryParams: unknown[] = [];

    if (params.status) {
      conditions.push('status = ?');
      queryParams.push(params.status);
    }
    if (params.agentId) {
      conditions.push('agent_id = ?');
      queryParams.push(params.agentId);
    }

    if (conditions.length > 0) {
      const where = ` WHERE ${conditions.join(' AND ')}`;
      countSql += where;
      querySql += where;
    }

    querySql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const countRow = this.db.prepare(countSql).get(...queryParams as any[]) as { total: number };
    const total = countRow.total;

    const rows = this.db.prepare(querySql).all(...queryParams as any[], pageSize, offset) as unknown as SessionRow[];

    return {
      data: rows.map(rowToSession),
      total,
      page,
      pageSize,
      hasMore: offset + pageSize < total,
    };
  }

  /**
   * Stop a session and release its sandbox (terminal → completed).
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    // Abort any in-flight turn and wait for it to unwind before tearing down
    // the sandbox, so the strategy never calls into a destroyed sandbox (H1).
    this.abortControllers.get(sessionId)?.abort();
    await this.drainChain(sessionId);
    if (!isTerminal(this.get(sessionId)?.status ?? session.status)) {
      this.updateStatus(sessionId, 'completed');
    }
    if (this.get(sessionId)?.status !== 'cleanup_pending') {
      await this.releaseSandbox(sessionId);
    }
  }

  /**
   * Delete a session. Stops it if running, releases the sandbox, then emits
   * a session.deleted event. Per Requirement 9.8, the Event_Log and session
   * metadata are retained (queryable) — this is a logical delete.
   */
  async delete(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.abortControllers.get(sessionId)?.abort();
    await this.drainChain(sessionId);
    if (!isTerminal(this.get(sessionId)?.status ?? session.status)) {
      this.updateStatus(sessionId, 'completed');
    }
    if (this.get(sessionId)?.status !== 'cleanup_pending') {
      await this.releaseSandbox(sessionId);
    }
    const deletedEvent = this.eventLogger.append(sessionId, { type: 'session.deleted' });
    this.broadcast(sessionId, deletedEvent);
  }

  /**
   * Record a failure once against a session's durable log.
   *
   * A run or a streaming turn can be refused after the session already
   * exists. Writing the failure into the Event Log makes it replayable from
   * `GET /v1/sessions/{id}/events` exactly like one the turn loop recorded
   * itself, so a client that reconnects sees the same incident instead of a
   * gap. The guard keeps one incident from being written twice: a repeated
   * failure with the same message returns the event already on the log.
   */
  recordErrorOnce(sessionId: string, error: unknown): SessionEvent | undefined {
    const events = this.eventLogger.getEvents(sessionId);
    const tail = events[events.length - 1];
    const message = error instanceof Error ? error.message : String(error);
    if (tail?.type === 'session.error' && tail.content) {
      const recorded = (tail.content as Array<{ type?: string; text?: unknown }>)[0];
      if (recorded?.type === 'text' && recorded.text === message) {
        return tail;
      }
    }
    const code = errorCodeOf(error);
    const event = this.eventLogger.append(sessionId, {
      type: 'session.error',
      content: [{ type: 'text', text: message }],
      metadata: { ...sessionErrorMetadata(error, code), ...(code ? { code } : {}) },
    });
    this.broadcast(sessionId, event);
    return event;
  }

  /** Await the current execution chain for a session (if any), swallowing errors. */
  private async drainChain(sessionId: string): Promise<void> {
    const chain = this.executionChains.get(sessionId);
    if (chain) {
      await chain.catch(() => {});
    }
  }

  /**
   * Get the Event Logger (exposed for Strategy/tests).
   */
  getEventLogger(): EventLogger {
    return this.eventLogger;
  }

  /**
   * Crash recovery (R9.10). On process restart, any session left in 'running'
   * was interrupted mid-turn. For each, inject a placeholder tool_result for
   * every orphaned tool_use (so the next eventsToMessages projection has a
   * valid, paired message sequence), then reset the session to idle (paused)
   * so it can continue on the next user event. Sandbox state is NOT restored (Event_Log ≠ file
   * bytes) — the next turn re-provisions a fresh sandbox.
   *
   * Returns the number of sessions reconciled.
   */
  reconcileOrphans(): number {
    const running = this.db
      .prepare("SELECT id FROM sessions WHERE status = 'running'")
      .all() as Array<{ id: string }>;

    for (const { id: sessionId } of running) {
      // Inject placeholder results for orphaned tool_use calls
      this.resolveOrphanedToolUses(sessionId, '(interrupted by server restart — retry if needed)');

      // Reset to idle so the session can continue on the next user event
      this.updateStatus(sessionId, 'paused');
    }

    return running.length;
  }

  /**
   * Ask every live session that references a vault to reconnect its MCP servers.
   *
   * Called after a credential rotation is committed, so the next MCP tool call uses
   * the new secret without recreating the Session. Best-effort by design: a failure
   * is reported to the caller rather than thrown, because the rotation is already
   * committed and the MCP status is the source of truth for a degraded server.
   */
  async refreshVaultMcpCredentials(vaultId: string): Promise<{ refreshed: string[]; failed: string[] }> {
    const refreshed: string[] = [];
    const failed: string[] = [];
    if (!this.executor?.refreshSessionMcpCredentials) return { refreshed, failed };

    // The sessions this process still holds MCP connections for: a session in a
    // terminal state has already had them closed.
    const rows = this.db
      .prepare('SELECT id, vault_ids, status FROM sessions')
      .all() as Array<{ id: string; vault_ids: string; status: string }>;
    for (const row of rows) {
      if (isTerminal(row.status as Session['status'])) continue;
      if (!parseSessionVaultIds(row.vault_ids).includes(vaultId)) continue;
      try {
        await this.executor.refreshSessionMcpCredentials(row.id);
        refreshed.push(row.id);
      } catch {
        failed.push(row.id);
      }
    }
    return { refreshed, failed };
  }

  /**
   * Graceful shutdown: abort in-flight turns and release all sandboxes bound
   * to sessions that ran this process. Called on SIGINT/SIGTERM.
   */
  async shutdown(): Promise<void> {
    // Abort any running turns, then wait for them to unwind before teardown.
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    await Promise.all(
      Array.from(this.executionChains.values()).map((c) => c.catch(() => {})),
    );
    // Release sandboxes for all sessions currently 'running' or idle
    if (this.executor?.cleanupSession) {
      const rows = this.db
        .prepare("SELECT id FROM sessions WHERE status IN ('running', 'paused', 'requires_action')")
        .all() as Array<{ id: string }>;
      for (const row of rows) {
        try {
          await this.executor.cleanupSession(row.id);
        } catch {
          // best-effort
        }
      }
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private broadcast(sessionId: string, event: SessionEvent): void {
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      for (const cb of subs) {
        try {
          cb(event);
        } catch {
          // subscriber errors don't propagate
        }
      }
    }
    if (this.broadcastListener) {
      try {
        this.broadcastListener(event);
      } catch {
        // a projection failure must not fail an event that is already durable
      }
    }
  }

  private updateStatus(sessionId: string, newStatus: SessionStatus): void {
    // Validate the transition against the state machine. If the current status
    // already equals the target, this is a no-op. Invalid transitions are
    // skipped (defense — should not happen given callers guard with isTerminal).
    const current = this.get(sessionId);
    if (current) {
      if (current.status === newStatus) return;
      if (!canTransition(current.status, newStatus)) {
        return;
      }
    }

    const completedAt = new Set<SessionStatus>(['completed', 'cancelled', 'timed_out']).has(newStatus)
      ? new Date().toISOString()
      : null;
    this.db.prepare(
      `UPDATE sessions SET status = ?, updated_at = datetime('now'), completed_at = ? WHERE id = ?`,
    ).run(newStatus, completedAt, sessionId);

    // Broadcast the corresponding CMA lifecycle event
    const eventType = eventTypeForStatus(newStatus);
    if (eventType) {
      const events = this.eventLogger.getEvents(sessionId);
      // Hard ordering guarantee: `session.usage` always sits immediately before
      // `session.status_idle`, so a client can settle the finished turn from the
      // snapshot before it observes the idle transition. Terminal transitions
      // are deliberately not covered — the upstream guarantee is defined for
      // idle, and this runtime only claims what it has verified.
      if (eventType === 'session.status_idle') {
        this.appendUsageSnapshot(sessionId, events);
      }
      const statusEvent = this.eventLogger.append(sessionId, {
        type: eventType,
        metadata: lifecycleMetadataFor(newStatus, events),
      });
      this.broadcast(sessionId, statusEvent);
    }
  }

  /**
   * Append and broadcast the `session.usage` snapshot for the session's current
   * aggregate. Cost, budget, and server-tool counters are omitted rather than
   * reported as zero: this runtime has no truthful value for them, and a `0`
   * would read as "supported, currently zero".
   */
  private appendUsageSnapshot(sessionId: string, events: SessionEvent[]): void {
    const session = this.get(sessionId);
    const usage = buildSessionUsageSnapshot(events, {
      tokensIn: session?.usage?.tokensIn,
      tokensOut: session?.usage?.tokensOut,
    });
    const usageEvent = this.eventLogger.append(sessionId, {
      type: 'session.usage',
      metadata: { usage },
    });
    this.broadcast(sessionId, usageEvent);
  }

  /**
   * Register the grader a declared outcome is measured by.
   *
   * Optional: a runtime with no grader leaves a declared outcome unevaluated
   * rather than reporting a verdict it cannot produce. The sessions contract
   * records that boundary.
   */
  setOutcomeGrader(grader: OutcomeGrader): void {
    this.outcomeGrader = grader;
  }

  /**
   * Register the reader for a `{type: "file"}` rubric.
   *
   * Optional: a runtime with no file store cannot resolve a file rubric, and the
   * evaluation reports that instead of grading against an empty rubric.
   */
  setRubricFileResolver(resolve: (fileId: string) => string | undefined): void {
    this.rubricFileResolver = resolve;
  }

  /**
   * Drive a declared outcome: work, measure, revise, until it ends.
   *
   * The turn that carried the declaration has already run, so the first
   * iteration measures it. Every later iteration appends the grader's
   * explanation as a real `user.message` and re-enters the executor with it, so
   * the revision is visible in the log and the next turn re-reads its context
   * from it rather than from anything held in memory.
   *
   * The rubric is resolved before grading, and both the resolved text and the
   * transcript come from the durable log, so a resumed session drives what was
   * actually recorded. Every span triple is appended to that same log, which is
   * what makes the outcome replayable.
   *
   * An outcome that stops without a verdict — the caller interrupted it, or a
   * turn left the session waiting on a tool confirmation — closes as
   * `interrupted` rather than as a verdict about a deliverable nobody finished.
   */
  private async runDeclaredOutcomeLoop(
    sessionId: string,
    event: Extract<UserEvent, { type: 'user.define_outcome' }>,
    abortController: AbortController,
    turnState: { requiresAction: boolean },
  ): Promise<void> {
    const grader = this.outcomeGrader;
    // Admission refuses a declared outcome on a runtime with no grader, so this
    // is unreachable through the event paths. A direct caller that bypassed
    // admission gets no invented verdict.
    if (!grader) return;

    const rubric = event.rubric.type === 'text'
      ? event.rubric.content
      : this.rubricFileResolver?.(event.rubric.file_id);
    if (rubric === undefined) {
      const error = new Error(
        `Rubric file not found: ${event.rubric.type === 'file' ? event.rubric.file_id : 'unknown'}`,
      ) as Error & { code: string };
      error.code = OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE;
      throw error;
    }

    let revision: string | undefined;
    await runOutcomeLoop({
      outcomeId: `outc_${nanoid(16)}`,
      request: {
        description: event.description,
        maxIterations: event.max_iterations ?? DEFAULT_OUTCOME_MAX_ITERATIONS,
      },
      rubric,
      grader,
      logger: {
        append: (span) => {
          const logged = this.eventLogger.append(sessionId, {
            type: span.type,
            metadata: span.metadata,
          });
          this.broadcast(sessionId, logged);
          return logged;
        },
      },
      appendRevision: (text) => {
        revision = text;
        return this.appendOutcomeRevision(sessionId, text);
      },
      runTurn: () => this.runOutcomeTurn(sessionId, abortController, revision, turnState),
      readTranscript: () => outcomeTranscript(this.eventLogger.getEvents(sessionId)),
      isAborted: () => abortController.signal.aborted || turnState.requiresAction,
    });
  }

  /**
   * Append the grader's feedback as a real `user.message`.
   *
   * A revision the agent cannot read back would not be a revision: the next turn
   * projects its context from the log, so the explanation has to be an event
   * there rather than a prompt assembled in memory.
   */
  private appendOutcomeRevision(sessionId: string, text: string): SessionEvent {
    const logged = this.eventLogger.append(sessionId, {
      type: 'user.message',
      content: [{ type: 'text', text }],
    });
    this.broadcast(sessionId, logged);
    return logged;
  }

  /**
   * Run one revision turn inside an outcome.
   *
   * This re-enters the executor with the revision as the triggering event — the
   * same call the session's own first turn made — under the same abort
   * controller, so an interrupt reaches the running turn instead of only being
   * noticed between iterations. The turn is not going through the execution
   * queue, so its events are broadcast here.
   */
  private async *runOutcomeTurn(
    sessionId: string,
    abortController: AbortController,
    revision: string | undefined,
    turnState: { requiresAction: boolean },
  ): AsyncIterable<SessionEvent> {
    if (!this.executor) return;
    const running = this.get(sessionId);
    if (!running || isTerminal(running.status)) return;
    const revisionEvent: UserEvent = {
      type: 'user.message',
      content: [{ type: 'text', text: revision ?? '' }],
    };
    for await (const evt of this.executor.execute(running, revisionEvent, {
      abortSignal: abortController.signal,
      broadcast: (e) => this.broadcast(sessionId, e),
      onRequiresAction: () => {
        turnState.requiresAction = true;
      },
    })) {
      this.broadcast(sessionId, evt);
    }
  }

  /**
   * Run a single turn for a session. Serialized via executionChains so turns
   * never overlap. Transitions running on start, then paused (idle, awaiting
   * next input) on normal completion — NOT terminal, so multi-turn works.
   */
  private async runTurn(sessionId: string, event: UserEvent): Promise<void> {
    if (!this.executor) return;

    const session = this.get(sessionId);
    // Session may have been stopped/deleted between enqueue and execution.
    if (!session || isTerminal(session.status)) return;

    // Transition to running for this turn
    if (session.status !== 'running') {
      this.updateStatus(sessionId, 'running');
    }

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);
    // Shared with the outcome loop: a revision turn that stops for a tool
    // confirmation ends the outcome (it cannot drive another turn while the
    // session waits), and the status below still says `requires_action`.
    const turnState = { requiresAction: false };

    try {
      const running = this.get(sessionId)!;
      for await (const evt of this.executor.execute(running, event, {
        abortSignal: abortController.signal,
        broadcast: (e) => this.broadcast(sessionId, e),
        onRequiresAction: () => {
          turnState.requiresAction = true;
        },
      })) {
        this.broadcast(sessionId, evt);
      }

      // A declared outcome is driven once the turn it instructed has finished.
      // The turn itself already ran, so the loop measures it, appends the
      // grader's feedback as a revision whenever another iteration is owed, and
      // re-enters the executor for it. A grading pass that cannot run throws,
      // which surfaces below as this session's own error rather than as an
      // outcome silently left unjudged.
      if (event.type === 'user.define_outcome') {
        try {
          await this.runDeclaredOutcomeLoop(sessionId, event, abortController, turnState);
        } catch (err) {
          // An interrupt that stopped the outcome is not a session error: the
          // loop closed the outcome's own end span as `interrupted`, and the
          // status decision below already says where the session is. Recording
          // a `session.error` here would report a stop the caller asked for.
          if (!(err instanceof OutcomeInterruptedError)) throw err;
        }
      }

      // Turn finished. If a tool needs confirmation → requires_action;
      // otherwise go idle (paused), awaiting next input.
      const current = this.get(sessionId);
      if (current && current.status === 'running') {
        this.updateStatus(sessionId, turnState.requiresAction ? 'requires_action' : 'paused');
      }
    } catch (err) {
      const errorCode = errorCodeOf(err);
      if (errorCode === PI_CLEANUP_PENDING_CODE) {
        const errorEvent = this.eventLogger.append(sessionId, {
          type: 'session.error',
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          metadata: sessionErrorMetadata(err, errorCode),
        });
        this.broadcast(sessionId, errorEvent);
        if (this.get(sessionId)?.status === 'running') this.updateStatus(sessionId, 'cleanup_pending');
      } else if (abortController.signal.aborted || isAbortError(err)) {
        const current = this.get(sessionId);
        if (current && current.status === 'running') {
          this.updateStatus(sessionId, current.loopEngine === 'pi' ? 'cancelled' : 'paused');
        }
      } else {
        const errorEvent = this.eventLogger.append(sessionId, {
          type: 'session.error',
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          metadata: sessionErrorMetadata(err, errorCode),
        });
        this.broadcast(sessionId, errorEvent);
        const current = this.get(sessionId);
        if (current && !isTerminal(current.status)) {
          if (errorCode === PI_CLEANUP_PENDING_CODE) this.updateStatus(sessionId, 'cleanup_pending');
          else if (errorCode === PI_TIMED_OUT_CODE) this.updateStatus(sessionId, 'timed_out');
          else if (errorCode === PI_SESSION_BUSY_CODE) this.updateStatus(sessionId, 'paused');
          else this.updateStatus(sessionId, 'failed');
        }
        // A cleanup_pending child may still own the workspace. Never release it
        // based on parent close or a failed taskkill result.
        if (errorCode !== PI_CLEANUP_PENDING_CODE) await this.releaseSandbox(sessionId);
      }
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  private async releaseSandbox(sessionId: string): Promise<void> {
    if (this.executor?.cleanupSession) {
      try {
        await this.executor.cleanupSession(sessionId);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Append a placeholder tool_result for every tool_use in the session log
   * that has no paired result. Called on crash recovery and on failed-session
   * resume so the next eventsToMessages projection yields a valid, paired
   * message sequence instead of an unpaired tool-call the model rejects.
   */
  private resolveOrphanedToolUses(sessionId: string, placeholder: string): void {
    const events = this.eventLogger.getEvents(sessionId);
    for (const toolUse of findOrphanedToolUses(events)) {
      this.eventLogger.append(sessionId, {
        type: toolUse.resultType,
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: placeholder, is_error: true }],
      });
    }
  }
}

function getConfirmationMetadata(
  event: Extract<UserEvent, { type: 'user.tool_confirmation' }>,
  events: SessionEvent[],
): Record<string, unknown> {
  if (typeof event.tool_use_id !== 'string' || event.tool_use_id.length === 0) {
    throw new Error('Invalid tool confirmation: tool_use_id must be a non-empty string');
  }
  if (event.result !== 'allow' && event.result !== 'deny') {
    throw new Error('Invalid tool confirmation: result must be "allow" or "deny"');
  }
  if (event.deny_message !== undefined && typeof event.deny_message !== 'string') {
    throw new Error('Invalid tool confirmation: deny_message must be a string');
  }

  const resolved = new Set<string>();
  let confirmationGroupId: string | undefined;
  let pending = false;
  for (const loggedEvent of events) {
    if (loggedEvent.type === 'user.tool_confirmation'
      && loggedEvent.metadata?.tool_use_id === event.tool_use_id) {
      throw new Error('Invalid tool confirmation: the tool call is not awaiting approval');
    }
    if (loggedEvent.type === 'agent.tool_result' || loggedEvent.type === 'agent.mcp_tool_result') {
      const block = loggedEvent.content?.find((item) => item.type === 'tool_result') as
        | { type: 'tool_result'; tool_use_id: string }
        | undefined;
      if (block) resolved.add(block.tool_use_id);
      continue;
    }
    if (loggedEvent.type !== 'agent.tool_use' && loggedEvent.type !== 'agent.mcp_tool_use') continue;
    const block = loggedEvent.content?.find((item) => item.type === 'tool_use') as
      | { type: 'tool_use'; id: string; requires_confirmation?: boolean; confirmation_group_id?: string }
      | undefined;
    if (block?.id !== event.tool_use_id || !block.requires_confirmation) continue;
    pending = true;
    confirmationGroupId = block.confirmation_group_id
      ?? (typeof loggedEvent.metadata?.confirmation_group_id === 'string'
        ? loggedEvent.metadata.confirmation_group_id
        : undefined);
  }

  if (!pending || resolved.has(event.tool_use_id)) {
    throw new Error('Invalid tool confirmation: the tool call is not awaiting approval');
  }

  return {
    tool_use_id: event.tool_use_id,
    result: event.result,
    ...(event.deny_message !== undefined ? { deny_message: event.deny_message } : {}),
    ...(confirmationGroupId ? { confirmation_group_id: confirmationGroupId } : {}),
  };
}

function lifecycleMetadataFor(status: SessionStatus, events: SessionEvent[]): Record<string, unknown> | undefined {
  if (status === 'paused') return { stop_reason: { type: 'end_turn' } };
  if (status !== 'requires_action') return undefined;

  const resolved = new Set<string>();
  const pendingIds: string[] = [];
  for (const event of events) {
    if (event.type === 'agent.tool_result' || event.type === 'agent.mcp_tool_result') {
      const block = event.content?.find((item) => item.type === 'tool_result') as
        | { type: 'tool_result'; tool_use_id: string }
        | undefined;
      if (block) resolved.add(block.tool_use_id);
      continue;
    }
    if (event.type !== 'agent.tool_use' && event.type !== 'agent.mcp_tool_use') continue;
    const block = event.content?.find((item) => item.type === 'tool_use') as
      | { type: 'tool_use'; id: string; requires_confirmation?: boolean }
      | undefined;
    if (block?.requires_confirmation) pendingIds.push(block.id);
  }

  return {
    stop_reason: {
      type: 'requires_action',
      event_ids: pendingIds.filter((id) => !resolved.has(id)),
      action_type: 'tool_confirmation',
    },
  };
}

/**
 * Pi codes this module reports. Declared here because the same three literals
 * appear in the status transitions below, and a spelling drift between the two
 * is exactly how a failure silently loses its retry classification.
 */
const PI_SESSION_BUSY_CODE = 'pi_session_busy';
const PI_CLEANUP_PENDING_CODE = 'pi_cleanup_pending';
const PI_TIMED_OUT_CODE = 'pi_timed_out';
const INTERNAL_ERROR_CODE = 'internal_error';

/**
 * Structured payload carried by `session.error`.
 *
 * The event log has no per-type payload column, so the typed error object is
 * persisted through the generic metadata carrier and projected back to the
 * documented top-level `error` field by `toApiEvent` — the same route
 * `session.usage` already takes. `content` still carries the message as text,
 * so a client that only renders content keeps working.
 *
 * Retry disposition is derived from the error code rather than guessed from
 * the message. A code the runtime does not recognize reports `unknown`, which
 * is the honest answer: claiming `not_retryable` for an unknown failure would
 * tell a client to give up on work that might succeed on retry.
 */
function sessionErrorMetadata(error: unknown, code: string | undefined): Record<string, unknown> {
  return {
    error: {
      type: code ?? INTERNAL_ERROR_CODE,
      message: error instanceof Error ? error.message : String(error),
      retry_status: retryStatusFor(code),
    },
  };
}

/**
 * Classify a caught error code for `session.error.retry_status`.
 *
 * Keys off the exported code constants rather than retyped literals: the Pi
 * admission codes all end in `_not_supported`, and an earlier literal spelling
 * of `_unsupported` meant those failures fell through to `unknown` — telling a
 * client it might retry a request the runtime will always refuse.
 */
function retryStatusFor(code: string | undefined): SessionErrorRetryStatus {
  switch (code) {
    case PI_SESSION_BUSY_CODE:
      return 'retryable';
    case PI_CLEANUP_PENDING_CODE:
    case PI_TIMED_OUT_CODE:
    case PI_ALWAYS_ASK_UNSUPPORTED_CODE:
    case PI_TOOL_POLICY_UNSUPPORTED_CODE:
    case PI_SANDBOX_UNSUPPORTED_CODE:
    case PI_USER_EVENT_UNSUPPORTED_CODE:
    case PI_MESSAGE_CONTENT_UNSUPPORTED_CODE:
    case LOOP_ENGINE_UNSUPPORTED_CODE:
    case LOOP_ENGINE_INVALID_CODE:
    case 'unsupported_capability':
    // A grader with no provider, and a rubric file that cannot be read, are
    // configuration facts. Reporting `unknown` would invite a client to retry a
    // call that cannot succeed until the runtime is fixed.
    case OUTCOME_EVALUATOR_UNAVAILABLE_CODE:
    case OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE:
      return 'not_retryable';
    default:
      return 'unknown';
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Validate and project a caller's answer to a pending custom tool call.
 *
 * The runtime never executes a custom tool, so `user.custom_tool_result` is the
 * only thing that can answer one — which also makes it the only inbound event
 * that could inject an answer into a session the caller does not own, or answer
 * a call twice. The call id is checked against the log before the event is
 * appended: an id that names no `agent.custom_tool_use` is refused, and so is a
 * second result for a call that already has one. The id rides in `metadata`
 * because the log has no per-type payload column, and `toApiEvent` projects it
 * back to the top-level field the published contract defines.
 */
/**
 * The metadata carrier for a `user.define_outcome` payload.
 *
 * The event carries `description`, `rubric` and `max_iterations` rather than `content`
 * blocks, and the log has no per-type payload column, so the payload rides in
 * `metadata` and is projected back to top-level fields by `toApiEvent` — the same
 * route `session.usage` takes. Dropping it would leave an outcome the runtime cannot
 * replay after a restart.
 */
function defineOutcomeMetadataFor(
  event: Extract<UserEvent, { type: 'user.define_outcome' }>,
): Record<string, unknown> {
  return {
    description: event.description,
    rubric: event.rubric,
    max_iterations: event.max_iterations,
  };
}

function getCustomToolResultMetadata(
  event: Extract<UserEvent, { type: 'user.custom_tool_result' }>,
  events: SessionEvent[],
): Record<string, unknown> {
  if (typeof event.custom_tool_use_id !== 'string' || event.custom_tool_use_id.trim().length === 0) {
    throw new Error('Invalid custom tool result: custom_tool_use_id must be a non-empty string');
  }
  if (!Array.isArray(event.content) || event.content.length === 0 || event.content.some((block) => !isValidCustomResultBlock(block))) {
    throw new Error('Invalid custom tool result: content must be a non-empty array of text, image, or document blocks');
  }
  if (event.is_error !== undefined && typeof event.is_error !== 'boolean') {
    throw new Error('Invalid custom tool result: is_error must be a boolean');
  }

  let pending = false;
  for (const loggedEvent of events) {
    if (loggedEvent.type === 'agent.custom_tool_use') {
      const block = loggedEvent.content?.find((item) => item.type === 'tool_use') as
        | { type: 'tool_use'; id: string } | undefined;
      if (block?.id === event.custom_tool_use_id) pending = true;
    }
    if (loggedEvent.type === 'user.custom_tool_result'
      && loggedEvent.metadata?.custom_tool_use_id === event.custom_tool_use_id) {
      throw new Error('Invalid custom tool result: the custom tool call is not pending');
    }
  }

  if (!pending) {
    throw new Error('Invalid custom tool result: custom_tool_use_id does not reference a pending custom tool call');
  }

  return {
    custom_tool_use_id: event.custom_tool_use_id,
    ...(event.is_error !== undefined ? { is_error: event.is_error } : {}),
  };
}

function isValidCustomResultBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const record = block as Record<string, unknown>;
  if (record.type === 'text') return typeof record.text === 'string';
  if (record.type === 'image' || record.type === 'document') return Boolean(record.source && typeof record.source === 'object');
  return false;
}
