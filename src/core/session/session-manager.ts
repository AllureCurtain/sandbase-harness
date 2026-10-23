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
import type { ArtifactStore } from '@/core/storage/artifact-store.js';
import { parseSessionVaultIds } from '@/core/credentials/injection.js';
import { EventLogger } from './event-logger.js';
import { eventTypeForStatus, isAbortError, STATUS_PROJECTION, threadEventTypeForStatus } from './session-lifecycle.js';
import { findOrphanedToolUses, INTERRUPTED_TOOL_OUTCOME_MESSAGE } from './session-recovery.js';
import { parkedCalls, type ParkedCall } from './parked-calls.js';
import { expiredParkedWait, PARKED_WAIT_TIMEOUT_CODE } from './parked-wait.js';
import { rowToSession, type SessionRow } from './session-records.js';
import { SessionThreadStore, type SessionThread } from './session-threads.js';
import {
  buildCoordinatorTools,
  MAX_ACTIVE_CHILD_THREADS,
  type CoordinatorToolsHost,
} from './coordinator-tools.js';
import { attachSessionResources } from './session-resources.js';
import { officialErrorType, retryStatus } from './session-error.js';
import { isRetriesExhausted } from '@/model/registry.js';
import type { RetryObserver } from '@/types/model.js';
import { buildSessionUsageSnapshot, serverToolUseFromEvents, type SessionUsagePayload } from './session-usage.js';
import type { SnapshotManager } from './snapshot-manager.js';
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
  ResumeAfterBudgetTrigger,
  SessionAgentUpdate,
  TurnTrigger,
  UpdateSessionParams,
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
import { assertResourcesMountable as assertResourcesMountableOn } from '@/core/resources/resource-mountability.js';
import type { AgentDefinition, AgentOverrides } from '@/types/agent.js';
import type { LoopEngineSteerReceipt } from '@/strategy/loop-engine/adapter.js';
import { agentOverrideError, applyAgentOverrides } from '@/core/agent/overrides.js';
import { validateAgentDefinition, type ValidationError } from '@/core/agent/schema.js';
import { agentDefinitionsEqual } from '@/core/agent/update.js';
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
import {
  PI_RPC_APPROVAL_NOT_PENDING_CODE,
  PI_RPC_GATE_LOST_CODE,
  PI_RPC_GATE_UNAVAILABLE_CODE,
  PI_RPC_OUTCOME_UNKNOWN_CODE,
  PI_RPC_PROTOCOL_ERROR_CODE,
  PI_RPC_TIMEOUT_CODE,
} from '@/strategy/pi/rpc-wire.js';
import {
  parseEnvironmentConfig,
  sandboxProviderForEnvironmentConfig,
} from '@/sandbox/provider-names.js';
import {
  WORK_LEASE_LOST_CODE,
  WORK_OUTCOME_UNKNOWN_CODE,
  WORK_QUEUE_TIMEOUT_CODE,
} from '@/sandbox/self-hosted-provider.js';
import {
  MODEL_AUTH_FAILED_CODE,
  MODEL_CONFIG_INVALID_CODE,
  MODEL_NOT_FOUND_CODE,
  MODEL_PROVIDER_NOT_CONFIGURED_CODE,
  RESUMABLE_MODEL_FAILURE_CODES,
} from '@/model/errors.js';

/**
 * The published error text a thread's parked calls are closed with when the
 * thread is interrupted while waiting on a client answer (`ManagedAgents参考`
 * :930 — written verbatim: any other wording would be a local message where
 * the contract fixes one).
 */
const INTERRUPTED_PARKED_CALL_MESSAGE = 'Tool execution was interrupted before completion. Please retry.';

/** Shared empty set so `archivedThreadIds` allocates nothing in the common case. */
const EMPTY_THREAD_SET: ReadonlySet<string> = new Set();

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
  /**
   * Read after each model step so a turn stops at the session's spending
   * ceiling instead of only discovering it when the next event is refused.
   */
  budgetExhausted?: () => boolean;
  /**
   * Per-turn view into the model wrapper's retry decisions — the manager maps
   * a scheduled retry onto `session.status_rescheduled` and a recovered one
   * back onto `session.status_running`.
   */
  retryObserver?: RetryObserver;
  /**
   * The thread this turn runs on. Omitted means the primary thread — every
   * caller that predates threads is by definition running the primary — and a
   * child turn names the thread row it is executing, so the turn's agent,
   * context, and event writes all scope to it.
   */
  thread?: import('./session-threads.js').SessionThread;
  /**
   * The coordinator host a rostered thread's `list_agents`/`send_to_agent`
   * tools dispatch through. Supplied by the session manager, which owns the
   * thread store and the execution chains the dispatch enqueues on; absent
   * means no coordinator tools are mounted (a session whose agent declares no
   * roster builds none anyway, so this is the common case).
   */
  coordinatorHost?: import('./coordinator-tools.js').CoordinatorToolsHost;
}

/** The one internal trigger this runtime re-enters a turn on. See `TurnTrigger`. */
export const RESUME_AFTER_BUDGET: ResumeAfterBudgetTrigger = { type: 'internal.resume_after_budget' };

export interface SessionExecutor {
  /** Called when a user event is received — runs the engine loop */
  execute(session: Session, event: TurnTrigger, options?: ExecuteOptions): AsyncIterable<SessionEvent>;
  /** Destroy resources (sandbox) bound to a session on terminal state */
  cleanupSession?(sessionId: string): Promise<void>;
  /**
   * Deliver a live steer without scheduling a turn.
   *
   * `undefined` means no live engine session owns steering for this session. The
   * Session Manager reports that as a refusal, never as a delivery and never as
   * a turn to run later.
   */
  steer?(
    session: Session,
    event: Extract<UserEvent, { type: 'user.steer' }>,
  ): Promise<LoopEngineSteerReceipt | undefined>;
  /**
   * Reconnect a session's MCP servers after the credential they authenticate with
   * changed, so the next tool call uses the new value. Optional: an executor with no
   * MCP support, or one whose session never connected a server, has nothing to do.
   */
  refreshSessionMcpCredentials?(sessionId: string): Promise<void>;
  /**
   * Drop a session's MCP connections so the next turn reconnects against the
   * session's current agent definition.
   *
   * Called after a session update replaces `agent.tools`/`agent.mcp_servers`:
   * a credential refresh would keep the previous server topology and the
   * previous tool-admission set, so the session's cached MCP state is torn down
   * entirely. The sandbox itself is untouched.
   */
  resetSessionMcpConnections?(sessionId: string): Promise<void>;
}

type Subscriber = (event: SessionEvent) => void;
type EnvironmentSandboxProviderResolver = (environmentId: string) => string | undefined;

export interface SessionStorage {
  artifactStore?: ArtifactStore;
  snapshots?: SnapshotManager;
}

// ============================================================
// Session Manager
// ============================================================

export class SessionManager {
  private readonly eventLogger: EventLogger;
  private readonly threadStore: SessionThreadStore;
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
  private sessionStorage: SessionStorage = {};
  /**
   * Per-thread execution chains — serialize the turns of one thread so they
   * never overlap, while letting different threads run concurrently (§4.4, D5).
   * Keyed by thread id, not session id: a session's primary thread and its
   * children each serialize on their own key, which is the whole reason a
   * `send_to_agent` child can run while the coordinator is parked.
   */
  private executionChains = new Map<string, Promise<void>>();
  /** Per-thread abort controller for the currently running turn. */
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
    this.threadStore = new SessionThreadStore(db);
    this.eventLogger = new EventLogger(db, this.threadStore);
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
   * End a session whose parked wait has expired, if it has.
   *
   * Returns the calls that were still unanswered when it was ended, or
   * `undefined` when nothing was done — which is every case except a genuinely
   * expired bound on a genuinely parked session. `parked-wait.ts` owns the
   * decision; this method owns the exchange, so the status, the event, and the
   * broadcast cannot be produced by different callers in different orders.
   *
   * The parked calls are deliberately **not** answered. The session stops
   * waiting; it does not decide on the caller's behalf what the tool returned.
   * A fabricated result would put an answer in the append-only log that nobody
   * gave, and the log is the record of what actually happened.
   *
   * The ceiling is passed in from this manager's own predicate rather than
   * recomputed, so the bound and the budget refusal cannot disagree about
   * whether a session is out of budget — the same reason the parked set has one
   * definition (frozen decision D23).
   */
  expireParkedWait(
    sessionId: string,
    timeoutSeconds: number | undefined,
    now: Date = new Date(),
  ): ParkedCall[] | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;

    const expired = expiredParkedWait({
      status: session.status,
      budgetExhausted: this.budgetExhaustedFor(session),
      events: this.eventLogger.getEvents(sessionId),
      timeoutSeconds,
      now,
    });
    if (!expired) return undefined;

    const message = `Session ${sessionId} waited ${Math.round(expired.parkedForMs / 1000)}s `
      + `for an answer to ${expired.calls.length} parked tool call(s) and the configured `
      + `${timeoutSeconds}s bound passed. The calls were not answered; the session was ended.`;
    const errorEvent = this.eventLogger.append(sessionId, {
      type: 'session.error',
      content: [{ type: 'text', text: message }],
      metadata: sessionErrorMetadata(new Error(message), PARKED_WAIT_TIMEOUT_CODE),
    });
    this.broadcast(sessionId, errorEvent);
    // Unconditional, and safe to be: the decision above only returns for a
    // session in `requires_action`, and that transition is the one this feature
    // added. `updateStatus` validates anyway and no-ops on a status it cannot
    // reach, so this cannot move a terminal session.
    this.updateStatus(sessionId, 'timed_out');
    return expired.calls;
  }

  /**
   * Build the documented `session.usage` payload for a session.
   *
   * `list_cost` is omitted when any model the session used has no list price: a
   * lower bound reported as the total would understate spend to a client that is
   * choosing a new cap. `budget` is always present — `null` when the session has
   * none — because the runtime holds that answer.
   */
  buildUsagePayload(sessionId: string): SessionUsagePayload {
    return this.usagePayloadFor(sessionId, this.eventLogger.getEvents(sessionId));
  }

  /** Shared with the snapshot the status transition already loaded the log for. */
  private usagePayloadFor(sessionId: string, events: SessionEvent[]): SessionUsagePayload {
    const session = this.get(sessionId);
    const snapshot = buildSessionUsageSnapshot(events, {
      tokensIn: session?.usage?.tokensIn,
      tokensOut: session?.usage?.tokensOut,
    });
    const spend = sessionSpend(this.db, sessionId, this.costProfile, events);

    return {
      ...snapshot,
      cache_read_input_tokens: session?.usage?.cacheReadTokens ?? 0,
      // Every cache write this runtime can record uses the five-minute TTL —
      // it is the only TTL it requests — so the one-hour bucket is genuinely
      // zero rather than uncounted.
      cache_creation: { ephemeral_5m_input_tokens: session?.usage?.cacheWriteTokens ?? 0, ephemeral_1h_input_tokens: 0 },
      ...(spend.meterable ? { list_cost: { amount: String(spend.cents), currency: 'USD' as const } } : {}),
      budget: session?.budget ?? null,
      // Counted from the log like every other usage figure: a `web_search` or
      // `web_fetch` tool_use block is one upstream request, so a session that
      // never called either genuinely reports zero.
      server_tool_use: serverToolUseFromEvents(events),
    };
  }

  /**
   * Move or remove a session's budget.
   *
   * The move rules themselves live in {@link resolveBudgetUpdate}, which
   * {@link updateSession} calls so a budget can move in the same request — and
   * the same transaction — as the other updatable fields. This convenience
   * wrapper is a budget-only spelling of that call.
   */
  updateBudget(sessionId: string, params: { budget?: SessionBudget | null }): Promise<Session> {
    return this.updateSession(sessionId, { budget: params.budget });
  }

  /**
   * Evaluate a `budget` update against the move rules and return the value to
   * persist — the new cap, or `null` when it is being removed. `undefined`
   * means the request reproduces the stored cap exactly, which counts as no
   * change like every other field.
   *
   * A budget is attachable at creation only, so "never had one" is a refusal
   * rather than a default. Removing one is final for the same reason: the
   * contract refuses to re-attach after a removal, which is why the removal is
   * recorded in the column as `null` rather than by clearing it.
   */
  private resolveBudgetUpdate(session: Session, budget: SessionBudget | null): SessionBudget | null | undefined {
    if (session.budget === undefined) {
      throw budgetError(
        BUDGET_ERROR_CODES.createOnly,
        `Session ${session.id} has no budget: a budget can only be attached when the session is created`,
      );
    }
    if (session.budget === null) {
      throw budgetError(
        BUDGET_ERROR_CODES.createOnly,
        `Session ${session.id} had its budget removed: a budget cannot be re-added`,
      );
    }
    if (budget === null) return null;
    if (agentDefinitionsEqual(session.budget, budget)) return undefined;

    const spend = this.getSessionSpend(session.id);
    if (!spend.meterable) {
      throw budgetError(
        BUDGET_ERROR_CODES.modelNotBudgetable,
        `Session ${session.id} consumed ${spend.unpricedModels.join(', ')}, which has no list price, so its budget cannot be changed`,
      );
    }
    // Strictly greater: a cap equal to what was consumed would leave the session
    // paused forever, because the next request could never be admitted.
    if (spend.microcents >= budgetCapMicrocents(budget)) {
      throw budgetError(
        BUDGET_ERROR_CODES.notRaised,
        `budget.max_list_cost must be greater than the session's consumed list cost`,
      );
    }
    return budget;
  }

  /**
   * Patch a session in place: swap its agent snapshot's tool surface, merge
   * its metadata, and rename it.
   *
   * `agent` admits only `tools` and `mcp_servers`, which replace wholesale
   * rather than merge; every other definition field belongs to the agent
   * update route and is refused by name. `metadata` is a merge patch — `null`
   * per key removes it, and `null` for the whole field is no change. `title`
   * is a plain replace where `null` clears. `budget` moves the ceiling under
   * {@link resolveBudgetUpdate}'s rules. `vault_ids` replaces the session's
   * credential vault bindings wholesale — an empty array detaches every
   * vault.
   *
   * An agent change additionally needs the session externally idle: a running
   * turn resolved its tool surface at start, so a swap underneath it would
   * only take effect mid-turn — interrupt first. Title, metadata, budget, and
   * vault bindings are durable row state and stay updatable while a turn
   * runs: a budget move only changes what the next model request may spend,
   * and a vault move only changes which credentials the next credential
   * resolution may reach.
   *
   * Everything a caller changed is written in one transaction together with
   * the `session.updated` event that reports it, so a rejected update leaves
   * the row, and the log, exactly as the request found them. The event carries
   * only the fields that actually changed — `agent` as the full materialized
   * snapshot, `metadata` as the whole post-update bag — and a request that
   * changes nothing is answered with the session and no event.
   */
  async updateSession(sessionId: string, params: UpdateSessionParams): Promise<Session> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.archivedAt || isTerminal(session.status)) {
      throw sessionOperationError('session_terminated', `Session ${sessionId} is in terminal state: ${session.status}`);
    }

    const agentChange = params.agent === undefined
      ? undefined
      : this.resolveAgentUpdate(session, params.agent);
    const budgetChange = params.budget === undefined
      ? undefined
      : this.resolveBudgetUpdate(session, params.budget);
    const metadataChange = this.resolveMetadataUpdate(session, params.metadata);
    const titleChange = params.title !== undefined && (params.title ?? undefined) !== session.title
      ? params.title ?? null
      : undefined;
    // Vault bindings compare as a set: ordering carries no meaning, and the
    // route-level normalizer has already deduplicated the request's ids.
    const vaultIdsChange = params.vault_ids === undefined
      ? undefined
      : (() => {
        const next = [...new Set(params.vault_ids)];
        const same = next.length === (session.vaultIds ?? []).length
          && next.every((id) => (session.vaultIds ?? []).includes(id));
        return same ? undefined : next;
      })();
    if (agentChange === undefined && budgetChange === undefined && metadataChange === undefined && titleChange === undefined && vaultIdsChange === undefined) {
      return session;
    }

    const eventPayload: Record<string, unknown> = {};
    if (agentChange !== undefined) {
      eventPayload.agent = agentChange;
      eventPayload.agent_id = session.agentId;
      eventPayload.agent_version = session.agentVersion;
    }
    if (budgetChange !== undefined) {
      eventPayload.budget = budgetChange;
    }
    // An emptied bag is reported by omission: the field is the post-update
    // metadata, and a cleared one has none to carry.
    if (metadataChange !== undefined && Object.keys(metadataChange).length > 0) {
      eventPayload.metadata = metadataChange;
    }
    if (titleChange !== undefined) {
      eventPayload.title = titleChange;
    }
    if (vaultIdsChange !== undefined) {
      eventPayload.vault_ids = vaultIdsChange;
    }

    const updated = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE sessions
         SET agent_definition = ?, title = ?, metadata = ?, vault_ids = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        agentChange !== undefined
          ? JSON.stringify(agentChange)
          : session.agentDefinition ? JSON.stringify(session.agentDefinition) : null,
        titleChange !== undefined ? titleChange : session.title ?? null,
        metadataChange !== undefined
          ? JSON.stringify(metadataChange)
          : session.metadata ? JSON.stringify(session.metadata) : null,
        JSON.stringify(vaultIdsChange ?? session.vaultIds ?? []),
        sessionId,
      );
      if (budgetChange !== undefined) {
        this.persistBudget(sessionId, budgetChange);
      }
      const event = this.eventLogger.append(sessionId, {
        type: 'session.updated',
        metadata: { session_updated: eventPayload },
      });
      return { session: this.get(sessionId)!, event };
    });
    this.broadcast(sessionId, updated.event);

    // The snapshot is durable before the MCP teardown runs: a reset failure
    // leaves the session's declared tools ahead of its connected servers, which
    // the next turn's lazy connect repairs — the reverse order could not.
    // Vault rebinds ride the same teardown: a live transport keeps the headers
    // it was built with, so a detached vault's credentials would otherwise
    // stay reachable until the connection happened to drop.
    if (agentChange !== undefined || vaultIdsChange !== undefined) {
      await this.executor?.resetSessionMcpConnections?.(sessionId);
    }
    if (budgetChange !== undefined) {
      this.resumeAfterBudget(sessionId);
    }
    return updated.session;
  }

  /**
   * Re-enter the turn loop for a session parked on `budget_reached` once an
   * accepted update lifts its ceiling.
   *
   * An accepted change is always enough headroom to resume — `resolveBudgetUpdate`
   * refuses a cap below the spend already committed, and `null` removes the
   * ceiling entirely — so this checks *why* the session is waiting, not whether
   * the new budget admits work. The trigger stays internal: the resume's
   * context is rebuilt from the event log, and no `user.message` is appended
   * for an update the model was never told about.
   *
   * Pi sessions report the same idle reason but are not re-entered: a Pi turn
   * needs a `user.message` or `user.tool_confirmation` carrier the resume
   * deliberately is not, so a Pi session waits for the client's next event.
   */
  private resumeAfterBudget(sessionId: string): void {
    if (!this.executor) return;
    const session = this.get(sessionId);
    if (!session || session.loopEngine === 'pi') return;
    // Resume every thread the ceiling parked, not just the primary: a budget
    // update lifts the session's shared cap, and §4.6 gives each thread that
    // stopped on `budget_reached` its own re-entry. A thread parked on a
    // confirmation (`requires_action`) is not resumed — its wait is for a
    // client's answer, not for headroom — and neither is one that idled on
    // `end_turn` or `retries_exhausted`, which named a different reason.
    for (const thread of this.threadStore.listBySession(sessionId)) {
      if (thread.archivedAt) continue;
      if (!this.lastIdleStopReasonIs(sessionId, 'budget_reached', thread.id)) continue;
      this.enqueueThreadTurn(sessionId, thread.id, RESUME_AFTER_BUDGET);
    }
  }

  /**
   * Read the `stop_reason` of the most recent idle event on one stream, so a
   * resume decision names the same projection a client saw.
   *
   * With a thread id the question is scoped to that thread's own
   * `session.thread_status_idle` events — two threads can idle on different
   * reasons at once, and the session's aggregate answers for neither. Without
   * one the session-level `session.status_idle` is read, the pre-thread
   * behaviour every caller that predates threads relied on.
   */
  private lastIdleStopReasonIs(sessionId: string, reason: string, threadId?: string): boolean {
    const events = threadId === undefined
      ? this.eventLogger.getEvents(sessionId)
      : this.eventLogger.getThreadEvents(sessionId, threadId);
    const idleType = threadId === undefined ? 'session.status_idle' : 'session.thread_status_idle';
    const lastIdle = [...events].reverse().find((event) => event.type === idleType);
    const stopReason = (lastIdle?.metadata as { stop_reason?: { type?: string } } | undefined)?.stop_reason;
    return stopReason?.type === reason;
  }

  /**
   * Merge an `agent` patch onto the session's current definition and return
   * the materialized snapshot — or `undefined` when the patch carries no
   * tools/MCP fields, or leaves the definition unchanged, so a rewrite to the
   * same tools stays a no-op end to end.
   *
   * The session's own snapshot is the base when it has one; an unpinned
   * session starts from the current durable definition it follows, and the
   * merged result is what gets materialized into `agent_definition`. The agent
   * row itself is never touched.
   */
  private resolveAgentUpdate(session: Session, patch: SessionAgentUpdate): AgentDefinition | undefined {
    for (const field of Object.keys(patch)) {
      if (!SESSION_UPDATE_AGENT_FIELDS.has(field)) {
        throw sessionOperationError('agent_field_not_updatable', `Unknown agent parameter: 'agent.${field}'.`);
      }
    }
    if (patch.tools === undefined && patch.mcp_servers === undefined) return undefined;
    if (STATUS_PROJECTION[session.status].wire !== 'idle') {
      throw sessionOperationError(
        'session_not_idle',
        `Session ${session.id} must be idle to update its agent; send user.interrupt and wait for it to settle first`,
      );
    }

    const current = session.agentDefinition ?? this.resolveAgentSnapshot(session.agentId)?.definition;
    if (!current) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }
    const merged = {
      ...current,
      ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
      ...(patch.mcp_servers !== undefined ? { mcp_servers: patch.mcp_servers } : {}),
    };
    const result = validateAgentDefinition(merged);
    if (!result.valid || !result.data) {
      throw sessionOperationError(
        'invalid_agent_definition',
        `Invalid agent definition: ${(result.errors ?? []).map((error) => `${error.path}: ${error.message}`).join('; ')}`,
      );
    }
    // The comparison runs on the validated form: a patch that only reorders
    // keys or repeats the stored definition validates to the same value, and
    // equality is what keeps it from materializing a snapshot and an event.
    if (agentDefinitionsEqual(current, result.data)) return undefined;

    this.assertAgentCapabilities(result.data);
    if (session.loopEngine === 'pi') {
      assertPiAgentCanExecute(result.data);
    }
    return result.data;
  }

  /**
   * Merge a `metadata` patch onto the session's bag and return the resulting
   * bag — or `undefined` when the field was absent, `null` (no change), or
   * merged to the bag the session already has.
   */
  private resolveMetadataUpdate(
    session: Session,
    patch: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | undefined {
    if (patch === undefined || patch === null) return undefined;
    const merged = { ...(session.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return agentDefinitionsEqual(session.metadata ?? {}, merged) ? undefined : merged;
  }

  async archive(sessionId: string): Promise<Session> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.archivedAt) return session;
    if (session.status === 'running' || session.status === 'retrying') {
      throw sessionOperationError(
        'session_running',
        `Session ${sessionId} is running; interrupt it and wait for idle before archiving`,
      );
    }

    this.db.prepare(
      `UPDATE sessions SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(sessionId);

    if (!isTerminal(session.status)) {
      this.updateStatus(sessionId, 'archived');
      await this.releaseSandbox(sessionId);
    }

    return this.get(sessionId)!;
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

  setSessionStorage(storage: SessionStorage): void {
    this.sessionStorage = storage;
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

    const agentSnapshot = params.agentSnapshot ?? this.resolveAgentSnapshot(params.agent, params.agentVersion);
    if (!agentSnapshot) {
      throw new Error(`Agent not found: ${params.agent}`);
    }

    // Overrides produce the session's own agent snapshot. Capability admission
    // and the persisted definition both read the resolved one, so a session
    // cannot pass a gate on the base agent and then execute with a different
    // tool or model set than the one that was checked.
    const effectiveDefinition = this.resolveSessionAgentDefinition(agentSnapshot.definition, params.agentOverrides);
    this.assertAgentCapabilities(effectiveDefinition);
    // Resolved for every engine, not only Pi: an Environment the runtime cannot
    // resolve must be refused before the row exists, so a session is never
    // created that can only fail once it tries to provision a sandbox.
    const environmentProvider = this.resolveEnvironmentSandboxProvider(params.environmentId ?? 'env_default');
    // A mounted resource is written to a canonical absolute in-sandbox path, so a
    // backend that refuses that path has to be refused here, on the same
    // before-the-row reasoning: accepting it would promise a mount that only
    // fails once provisioning reaches the sandbox.
    this.assertResourcesMountable(params.environmentId ?? 'env_default', params.resources, environmentProvider);
    if (loopEngine === 'pi') {
      assertPiAgentCanExecute(effectiveDefinition);
      assertPiEnvironmentCanExecute(environmentProvider);
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
          BUDGET_ERROR_CODES.modelNotBudgetable,
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
    const frozenDefinition = params.agentVersion !== undefined || params.agentOverrides !== undefined || params.agentSnapshot !== undefined
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

    // The primary thread row is written in the same insert: the session's
    // first-class stream is the thread's, and the two exist together or not
    // at all. A session that skipped this would be one the thread listing
    // could not answer for.
    this.threadStore.ensurePrimaryThread({
      id,
      agentId: agentSnapshot.id,
      agentName: agentSnapshot.name,
      agentVersion: agentSnapshot.version,
      // The primary thread runs the session's effective definition — the same
      // resolved snapshot the turn resolves — not the possibly-absent frozen
      // copy. An unpinned session stores no `agent_definition` on its row, but
      // the thread's own snapshot must still carry the roster the executor
      // reads to mount coordinator tools.
      agentDefinition: effectiveDefinition,
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
    });

    // A session created with resources records them as durable instances in the same call, so
    // `GET /v1/sessions/{id}/resources` reports them and a token rotation or detach has an ID
    // to address. The `resources` column alone is not enough: it is the declaration the sandbox
    // mounts, while the resource API addresses instances, and a session that reported none
    // would be claiming a resource it does not hold. Attaching here rather than in each route
    // is what keeps every creation path — including the ones that cannot use
    // `createWithInitialEvents` because they stream the reply — from being able to forget, and
    // it puts the instances inside the caller's transaction when there is one.
    if (params.attachResources) params.attachResources(id);
    else attachSessionResources(this.db, id, params.resources ?? []);

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
   *
   * A config this build cannot read, or a declaration this build cannot serve,
   * is refused rather than reported as "nothing declared": the fallback that
   * used to answer a damaged record with the local backend turned it into
   * unsandboxed local execution, and a bare `hosting_type: "docker"` row into
   * the same.
   */
  private declaredEnvironmentSandboxProvider(environmentId: string): string | undefined {
    // The workspace default is overlaid from active Settings V2 at runtime and
    // validated there. Only named Environments are explicit session overrides.
    if (environmentId === 'env_default') return undefined;
    const row = this.db.prepare(
      'SELECT config FROM environments WHERE id = ? AND archived_at IS NULL',
    ).get(environmentId) as { config: string } | undefined;
    if (!row) return undefined;
    const context = `Environment ${environmentId}`;
    return sandboxProviderForEnvironmentConfig(parseEnvironmentConfig(row.config, context), context);
  }

  /**
   * The backend sessions on an Environment actually provision, as resolved by
   * the runtime's effective Settings — Settings-backed in the composed
   * runtime, declared-only in embedded use. Exposed for read-model
   * projections such as the Environment API's `effective_sandbox_provider`.
   */
  environmentSandboxProvider(environmentId: string): string | undefined {
    return this.resolveEnvironmentSandboxProvider(environmentId);
  }

  /**
   * Refuse a session whose Environment cannot resolve to an execution backend.
   *
   * Runs at creation and at event admission, so an unsupported hosting type, a
   * damaged config, or a backend this process does not have is reported to the
   * caller before any model request, tool call, confirmation, event append, or
   * sandbox provision can happen — rather than mid-stream as a session error.
   */
  private assertEnvironmentProviderResolvable(session: Session): void {
    this.resolveEnvironmentSandboxProvider(session.environmentId);
  }

  /**
   * Refuse a resource the session's backend cannot serve.
   *
   * A `file` or `github_repository` resource is materialized at a canonical
   * absolute in-sandbox path, so a backend that refuses that path can never serve
   * it. The refusal is raised before anything is stored — no session row, no
   * resource instance, no event — because the alternative this replaces is a
   * session that is accepted and then fails at provisioning, which tells the
   * caller nothing about the environment they chose.
   *
   * Called from creation for both entry points (`POST /v1/sessions` and
   * `POST /v1/runs`, which creates through the same method) and from the route
   * that attaches a resource to an existing session.
   *
   * The backend is the one the session's Environment resolves to, which is the
   * same authority creation uses. A session whose sandbox is already bound is not
   * consulted, so an Environment edited after binding can make this refusal
   * stricter than the sandbox in hand: that direction is deliberate, because the
   * alternative is accepting a mount the named backend cannot serve.
   */
  assertResourcesMountable(
    environmentId: string | undefined,
    resources: ReadonlyArray<Record<string, unknown>> | undefined,
    /** Backend already resolved by the caller, when it has resolved one. */
    sandboxProvider?: string,
  ): void {
    const provider = sandboxProvider ?? this.resolveEnvironmentSandboxProvider(environmentId ?? 'env_default');
    assertResourcesMountableOn(resources, provider);
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
    if (session.archivedAt) {
      throw sessionOperationError('session_archived', `Session ${sessionId} is archived`);
    }
    if (isTerminal(session.status)) {
      throw new Error(`Session ${sessionId} is in terminal state: ${session.status}`);
    }
    // Existing Pi rows can predate the creation guard. Reject them before
    // repair/persistence or queuing so a resumed turn cannot bypass policy.
    this.assertPiSessionCanExecute(session, event);
    // Runs for every engine: a session whose Environment stopped resolving (a
    // later edit wrote an unsupported hosting type, or the stored config was
    // damaged) is refused here, before the append-only log or any execution.
    this.assertEnvironmentProviderResolvable(session);
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
   *
   * A `user.steer` is the one event that answers with more than acceptance: it is
   * offered to the live engine session straight away and the reply carries the
   * receipt the caller has to act on, since "already delivered", "reused id" and
   * "never heard it" are three different things to do next.
   */
  async sendEvent(
    sessionId: string,
    event: UserEvent,
  ): Promise<{ accepted: boolean; steer?: LoopEngineSteerReceipt }> {
    if (!event || typeof (event as any).type !== 'string' || (event as any).type.length === 0) {
      throw new Error('Invalid event: missing required string "type" field');
    }

    const session = this.assertSessionCanAcceptEvent(sessionId, event);

    // Revalidate the snapshot-first/current-durable effective definition before
    // mutating the append-only log or queuing any model, sandbox, or tool work.
    this.assertSessionCapabilities(session);

    // Steering is not a turn. It has to reach the engine while the turn it
    // influences is still running, so it bypasses the execution chain entirely: a
    // queued steer would arrive after that turn had ended, and would be reported
    // as delivered while changing nothing.
    if (event.type === 'user.steer') {
      return this.deliverSteer(session, event);
    }

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
    // A declared outcome's `outc_` id is assigned at admission so the
    // declaration itself carries it: the metadata carrier persists it for the
    // event projection and `outcome_evaluations`, and the loop's spans
    // reference the same value rather than minting their own.
    if (event.type === 'user.define_outcome') {
      event = withOutcomeId(event);
    }
    const defineOutcomeMetadata = event.type === 'user.define_outcome'
      ? defineOutcomeMetadataFor(event)
      : undefined;

    // Sending a fresh message while a tool call is
    // still awaiting approval: the log may hold an agent.tool_use with no
    // paired result. Inject placeholder results before the new user event so
    // the next eventsToMessages projection has a valid, paired sequence
    // (mirrors reconcileOrphans). Legit user.tool_confirmation events are
    // exempt — the executor pairs their referenced call itself.
    if (event.type === 'user.message') {
      this.resolveOrphanedToolUses(sessionId, this.threadStore.primaryThreadId(sessionId));
    }

    // The thread an answer belongs to is the thread that parked the call it
    // resolves — the same routing `threadIdForEvent` applies to the turn. The
    // row is stamped with it so the child's own stream carries the answer its
    // resume gate and projection pair against, and cross-posted so the primary
    // stream still shows the complete request→response pair (§4.5). A scoped
    // `user.interrupt` is stamped the same way: the event is addressed to one
    // thread, so that thread's stream records it and the primary stream sees
    // it cross-posted.
    let interruptTarget: SessionThread | undefined;
    if (event.type === 'user.interrupt' && event.session_thread_id !== undefined) {
      const named = this.threadStore.get(event.session_thread_id);
      if (!named || named.sessionId !== sessionId) {
        throw new Error('Invalid interrupt: session_thread_id does not name a thread of this session');
      }
      interruptTarget = named;
    }
    const answerThreadId = event.type === 'user.tool_confirmation' || event.type === 'user.custom_tool_result'
      ? this.threadIdForEvent(sessionId, event)
      : event.type === 'user.interrupt' && interruptTarget !== undefined
        ? interruptTarget.id
        : undefined;
    const primaryThreadId = answerThreadId !== undefined
      ? this.threadStore.primaryThreadId(sessionId)
      : undefined;

    // Append the user event to the log
    const logged = this.eventLogger.append(sessionId, {
      type: event.type,
      content: 'content' in event ? (event as any).content : undefined,
      metadata: confirmationMetadata ?? customToolResultMetadata ?? defineOutcomeMetadata,
      threadId: answerThreadId,
      crossPosted: answerThreadId !== undefined && answerThreadId !== primaryThreadId,
    });
    this.broadcast(sessionId, logged);

    // user.interrupt jumps the queue and aborts the running turn — it does
    // NOT enqueue a new turn (there's no new work, just a stop signal).
    if (event.type === 'user.interrupt') {
      this.interruptThreads(sessionId, interruptTarget);
      return { accepted: true };
    }

    // A confirmation addressed by the event id is answered with the call's block
    // id from here on. `getConfirmationMetadata` already resolved and validated
    // it, and the executor addresses the pending call by block id — the built-in
    // resolver directly, and the Pi loop engine through its own interaction
    // record, which is keyed by the same value. Handing the raw reference across
    // would let a decision pass validation and then find no gate to consume,
    // which is a refusal the caller cannot tell from a wrong id.
    const turnEvent = event.type === 'user.tool_confirmation'
      && typeof confirmationMetadata?.tool_use_id === 'string'
      && confirmationMetadata.tool_use_id !== event.tool_use_id
      ? { ...event, tool_use_id: confirmationMetadata.tool_use_id }
      : event;

    // Execute asynchronously, serialized per thread so turns never overlap on
    // one thread while different threads run concurrently. Most `user.*` input
    // is the primary thread's — a client cannot address a child directly — but
    // a confirmation or custom-tool result names a parked call, and the call's
    // own thread is the one that must resume. The user event is already durably
    // in the log; the chained turn will read the full log (including this
    // event) when it runs.
    if (this.executor) {
      this.enqueueThreadTurn(sessionId, this.threadIdForEvent(sessionId, turnEvent), turnEvent);
    }

    return { accepted: true };
  }

  /**
   * The thread a turn trigger belongs to.
   *
   * A `user.message`, `user.interrupt`, or `user.define_outcome` is always the
   * primary thread's input — the client addresses the session, and the session's
   * primary thread is the stream that answers. A `user.tool_confirmation` or
   * `user.custom_tool_result` names a parked call, and the thread that produced
   * the call is the thread that must resume: routing it to the primary would
   * resume the wrong conversation and leave the child's call still parked. The
   * thread id is read off the referenced `tool_use` event's `thread_id`, which
   * is the same durable fact `parkedCalls` resolved the call from; a call the
   * lookup cannot place falls back to the primary thread, matching the
   * single-thread behaviour the routing replaced.
   */
  private threadIdForEvent(sessionId: string, event: TurnTrigger): string {
    const primaryId = this.threadStore.primaryThreadId(sessionId);
    if (event.type === 'user.tool_confirmation') {
      return this.threadIdOfToolUse(sessionId, event.tool_use_id) ?? primaryId;
    }
    if (event.type === 'user.custom_tool_result') {
      return this.threadIdOfCustomToolUse(sessionId, event.custom_tool_use_id) ?? primaryId;
    }
    return primaryId;
  }

  /** The thread that produced the referenced `tool_use`/`mcp_tool_use` call. */
  private threadIdOfToolUse(sessionId: string, reference: string): string | undefined {
    for (const event of this.eventLogger.getEvents(sessionId)) {
      if (event.type !== 'agent.tool_use' && event.type !== 'agent.mcp_tool_use') continue;
      const block = event.content?.find((item) => item.type === 'tool_use') as
        | { type: 'tool_use'; id: string } | undefined;
      if (event.id === reference || block?.id === reference) return event.threadId;
    }
    return undefined;
  }

  /** The thread that produced the referenced `custom_tool_use` call. */
  private threadIdOfCustomToolUse(sessionId: string, reference: string): string | undefined {
    for (const event of this.eventLogger.getEvents(sessionId)) {
      if (event.type !== 'agent.custom_tool_use') continue;
      const block = event.content?.find((item) => item.type === 'tool_use') as
        | { type: 'tool_use'; id: string } | undefined;
      if (event.id === reference || block?.id === reference) return event.threadId;
    }
    return undefined;
  }

  /**
   * Enqueue one turn on a thread's own execution chain.
   *
   * This is the single place a turn is scheduled, so the chain's invariants
   * hold for every entry point — the client's `sendEvent`, the initial-events
   * path, a `send_to_agent` dispatch, and a child thread's reply alike. The
   * chain serializes only within the thread: a child turn never waits on the
   * coordinator's, which is what lets a `send_to_agent` return while its child
   * is already running.
   */
  private enqueueThreadTurn(sessionId: string, threadId: string, event: TurnTrigger): void {
    if (!this.executor) return;
    const prev = this.executionChains.get(threadId) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // isolate failures so one bad turn doesn't wedge the chain
      .then(() => this.runTurn(sessionId, event, threadId))
      .catch(() => {}); // never let a turn (even its prelude) reject the chain
    this.executionChains.set(threadId, next);
    // Clean up the map entry once this is the last queued turn (L1 leak fix).
    void next.finally(() => {
      if (this.executionChains.get(threadId) === next) {
        this.executionChains.delete(threadId);
      }
    });
  }

  /**
   * Validate one steer, offer it to the live engine session, then record it.
   *
   * The order is deliberate: the engine is asked *before* the event is appended,
   * so a steer that never reached a live session leaves a durable record saying
   * so rather than one implying delivery. The receipt is written into the event's
   * metadata, which is the only place a client reading the log back can learn
   * whether the engine acknowledged the instruction, already had it, or never
   * received it.
   *
   * A steer carries text and nothing else, so this path can append an event and
   * call the steering side channel — it can never enter the execution chain, build
   * a tool set, or start a turn.
   */
  private async deliverSteer(
    session: Session,
    event: Extract<UserEvent, { type: 'user.steer' }>,
  ): Promise<{ accepted: boolean; steer: LoopEngineSteerReceipt }> {
    const inputId = event.input_id;
    if (typeof inputId !== 'string' || inputId.length === 0) {
      throw new Error('Invalid steer: input_id must be a non-empty string');
    }
    if (typeof event.text !== 'string' || event.text.length === 0) {
      throw new Error('Invalid steer: text must be a non-empty string');
    }
    if (event.expected_turn_id !== undefined && typeof event.expected_turn_id !== 'string') {
      throw new Error('Invalid steer: expected_turn_id must be a string');
    }

    const receipt = await this.executor?.steer?.(session, event)
      ?? {
        inputId,
        state: 'rejected' as const,
        detail: 'no live engine session is accepting steering for this session',
      };

    const logged = this.eventLogger.append(session.id, {
      type: event.type,
      content: [{ type: 'text', text: event.text }],
      metadata: {
        input_id: inputId,
        steer_state: receipt.state,
        ...(receipt.turnId ? { turn_id: receipt.turnId } : {}),
        ...(receipt.detail ? { detail: receipt.detail } : {}),
      },
    });
    this.broadcast(session.id, logged);

    // `outcome_unknown` counts as accepted: the write may have reached the engine,
    // so telling the caller it failed would invite exactly the replay the steer
    // contract forbids. Only a refusal the engine actually performed — a rejected
    // steer, or an `input_id` already spent on other text — answers `false`.
    const accepted = receipt.state !== 'rejected' && receipt.state !== 'conflict';
    return { accepted, steer: receipt };
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
   * rejected batch never leaves a session or a partial history behind — and the
   * same transaction covers the resource instances `create` attaches, so a
   * refused batch does not leave a session holding resources either.
   */
  createWithInitialEvents(
    params: CreateSessionParams,
    events: Array<UserEvent | { type: 'system.message'; content?: ContentBlock[] }>,
  ): Session {
    // Admission assigns each declared outcome its `outc_` id once, so the
    // persisted event and the queued turn share it — `sendEvent` does the same
    // for live declarations.
    const admitted = events.map((event) =>
      event.type === 'user.define_outcome' ? withOutcomeId(event) : event,
    );
    const session = this.db.transaction(() => {
      const created = this.create(params);

      // Validate against the real row, not a synthetic id: admission checks
      // read the durable session and its log, so they only mean anything once
      // the row exists. Inside the transaction a throw discards the row and
      // every event appended before it, which is the property that matters.
      for (const event of admitted) {
        this.assertSessionCanAcceptEvent(created.id, event as UserEvent);
      }
      for (const event of admitted) {
        this.appendUserEventInTransaction(created.id, event as UserEvent);
      }
      return created;
    });

    // Post-commit: the log is durable, so the turn can now be queued. A
    // `system.message` is context for the turns the user events start — it is
    // appended like every other event but never starts a turn itself, so a
    // batch of only system messages creates an idle session rather than a
    // turn with nothing to answer.
    const turnEvents = admitted.filter((event) => event.type !== 'system.message');
    if (turnEvents.length > 0 && this.executor) {
      this.updateStatus(session.id, 'running');
    }
    for (const event of turnEvents) {
      this.enqueueTurnForEvent(session.id, event as TurnTrigger);
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

  /** Queue the turn for one initial event, serialized per thread. */
  private enqueueTurnForEvent(sessionId: string, event: TurnTrigger): void {
    this.enqueueThreadTurn(sessionId, this.threadIdForEvent(sessionId, event), event);
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

    if (params.statuses !== undefined) {
      conditions.push(params.statuses.length > 0 ? `status IN (${params.statuses.map(() => '?').join(', ')})` : '0');
      queryParams.push(...params.statuses);
    }
    if (params.agentId) {
      conditions.push('agent_id = ?');
      queryParams.push(params.agentId);
      if (params.agentVersion !== undefined) {
        conditions.push('agent_version = ?');
        queryParams.push(params.agentVersion);
      }
    }
    if (params.includeArchived !== true) {
      conditions.push('archived_at IS NULL');
    }
    if (params.memoryStoreId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM session_resource_instances sri
        WHERE sri.session_id = sessions.id
          AND sri.resource_type = 'memory_store'
          AND json_extract(sri.config, '$.memory_store_id') = ?
      )`);
      queryParams.push(params.memoryStoreId);
    }
    if (params.deploymentId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM scheduled_deployment_runs sdr
        WHERE sdr.session_id = sessions.id AND sdr.schedule_id = ?
      )`);
      queryParams.push(params.deploymentId);
    }
    // `datetime()` on both sides normalizes the two stored spellings — the
    // column default emits `YYYY-MM-DD HH:MM:SS` while fixtures and older rows
    // may hold RFC 3339 — and normalizes caller offsets the same way, so the
    // comparison is chronological rather than lexical.
    const createdBounds: Array<[string, string | undefined]> = [
      ['>', params.createdAt?.gt],
      ['>=', params.createdAt?.gte],
      ['<', params.createdAt?.lt],
      ['<=', params.createdAt?.lte],
    ];
    for (const [op, bound] of createdBounds) {
      if (bound === undefined) continue;
      conditions.push(`datetime(created_at) ${op} datetime(?)`);
      queryParams.push(bound);
    }

    if (conditions.length > 0) {
      const where = ` WHERE ${conditions.join(' AND ')}`;
      countSql += where;
      querySql += where;
    }

    // `id` is the tiebreaker because `created_at` carries second precision: an
    // unstable secondary order would let a row drift between adjacent pages.
    const direction = params.order === 'asc' ? 'ASC' : 'DESC';
    querySql += ` ORDER BY datetime(created_at) ${direction}, id ${direction} LIMIT ? OFFSET ?`;

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
   * Interrupt the current turn and retain the session and its sandbox.
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (isTerminal(session.status)) {
      throw new Error(`Session ${sessionId} is in terminal state: ${session.status}`);
    }
    // Every thread's turn stops: chains are keyed by thread id, and a session
    // can run several — the primary plus dispatched children. A thread parked
    // on requires_action is closed out the same way an unscoped user.interrupt
    // closes it.
    this.interruptThreads(sessionId);
    await this.drainChain(sessionId);
  }

  /**
   * Permanently delete a session and its session-owned state.
   *
   * Running sessions must be interrupted first so deletion cannot race an
   * active turn. The deletion marker is broadcast before the rows disappear,
   * allowing attached event streams to close with a durable final event.
   */
  async delete(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === 'running' || session.status === 'retrying') {
      throw sessionOperationError(
        'session_running',
        `Session ${sessionId} is running; interrupt it and wait for idle before deleting`,
      );
    }

    await this.executor?.cleanupSession?.(sessionId);
    const generatedFileIds = this.removeSessionFiles(sessionId);
    this.sessionStorage.snapshots?.removeFiles(sessionId);

    const deletedEvent = this.eventLogger.append(sessionId, { type: 'session.deleted' });
    this.broadcast(sessionId, deletedEvent);

    this.db.transaction(() => {
      for (const table of sessionOwnedTables(this.db)) {
        if (table === 'files') {
          for (const fileId of generatedFileIds) {
            this.db.prepare(`DELETE FROM "${table}" WHERE id = ? AND session_id = ?`).run(fileId, sessionId);
          }
          this.db.prepare(`UPDATE "${table}" SET session_id = NULL WHERE session_id = ?`).run(sessionId);
          continue;
        }
        if (table === 'memory_versions' || table === 'scheduled_deployment_runs') {
          this.db.prepare(`UPDATE "${table}" SET session_id = NULL WHERE session_id = ?`).run(sessionId);
          continue;
        }
        this.db.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(sessionId);
      }
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
  }

  private removeSessionFiles(sessionId: string): string[] {
    const store = this.sessionStorage.artifactStore;
    const rows = this.db.prepare(
      `SELECT id, storage_path, role, metadata
       FROM files
       WHERE session_id = ?`,
    ).all(sessionId) as Array<{ id: string; storage_path: string; role: string; metadata: string | null }>;
    const generatedFileIds: string[] = [];
    for (const row of rows) {
      const generated = row.role === 'artifact' || hasSessionOutputMetadata(row.metadata);
      if (!generated) continue;
      generatedFileIds.push(row.id);
      store?.remove(row.storage_path);
    }
    return generatedFileIds;
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

  /**
   * Archive a thread: the terminal lifecycle write.
   *
   * `archived_at` is set first so the row is archived even if the status
   * transition is refused by the single-thread table — a `requires_action`
   * thread archivable by the contract but unreachable through
   * `SESSION_TRANSITIONS` stays archived rather than resurrecting. Then the
   * status transitions to `archived`, which emits the cross-posted
   * `session.thread_status_terminated` and recomputes the session aggregate
   * (§4.3 excludes archived rows, so the session's published status no longer
   * counts the thread). The concurrency slot frees on the same write —
   * `activeChildCount` excludes `archived_at`.
   */
  archiveThread(sessionId: string, threadId: string): void {
    const thread = this.threadStore.get(threadId);
    if (!thread || thread.sessionId !== sessionId || thread.archivedAt) return;
    this.threadStore.archiveThread(threadId);
    if (thread.status !== 'archived') {
      if (canTransition(thread.status, 'archived')) {
        this.updateThreadStatus(sessionId, threadId, 'archived');
      } else {
        // A status the single-thread table cannot take — the row is archived
        // anyway, so the aggregate is recomputed without emitting a thread
        // event whose `archived` status the table refused.
        this.recomputeSessionStatus(sessionId);
      }
    }
  }

  /**
   * Apply a `user.interrupt` to one thread — or to the whole session when no
   * `session_thread_id` scoped it.
   *
   * §4.5: a running or retrying thread's turn is aborted and settles `paused`
   * through the ordinary abort path; a thread parked on `requires_action` is
   * not running, so there is nothing to abort — instead each parked call is
   * closed with the published error result ("Tool execution was interrupted
   * before completion. Please retry.") and the thread goes straight to
   * `paused` (`end_turn`) without touching the model; an already-idle thread
   * is a no-op. An unscoped interrupt applies both rules to every unarchived
   * thread: the primary's running turn and a parked child are stopped by the
   * same client action.
   */
  private interruptThreads(sessionId: string, target?: SessionThread): void {
    const threads = (target !== undefined ? [target] : this.threadStore.listBySession(sessionId))
      .filter((t) => !t.archivedAt);
    for (const thread of threads) {
      if (thread.status === 'running' || thread.status === 'retrying') {
        this.abortControllers.get(thread.id)?.abort();
      } else if (thread.status === 'requires_action') {
        this.resolveInterruptedParkedCalls(sessionId, thread.id);
        this.updateThreadStatus(sessionId, thread.id, 'paused');
        // No `postReplyToParent`: an interrupt is a control action, not a turn
        // the model ended — the child produced no reply to report, and
        // re-entering the parent here would start a turn on a session the
        // caller just asked to stop.
      }
      // queued and paused threads have nothing to stop: a parked-less queued
      // row's enqueued first turn runs itself out, and an idle thread is the
      // documented no-op.
    }
  }

  /**
   * Close every parked call on one thread with the interrupt's error result.
   *
   * The parked `agent.tool_use` / `agent.mcp_tool_use` gets an error
   * `agent.tool_result`/`agent.mcp_tool_result`; a parked `agent.custom_tool_use`
   * gets an error `user.custom_tool_result` — the same result type a client
   * answer would carry, because the custom projection pairs on that event, not
   * on a `tool_result` row. All of them stay on the thread's own stream.
   */
  private resolveInterruptedParkedCalls(sessionId: string, threadId: string): void {
    const events = this.eventLogger.getThreadEvents(sessionId, threadId);
    for (const call of parkedCalls(events)) {
      const use = events.find((event) => event.id === call.eventId);
      if (use?.type === 'agent.custom_tool_use') {
        const result = this.eventLogger.append(sessionId, {
          type: 'user.custom_tool_result',
          threadId,
          content: [{ type: 'text', text: INTERRUPTED_PARKED_CALL_MESSAGE }],
          metadata: { custom_tool_use_id: call.blockId, is_error: true, interrupted: true },
        });
        this.broadcast(sessionId, result);
      } else {
        const result = this.eventLogger.append(sessionId, {
          type: use?.type === 'agent.mcp_tool_use' ? 'agent.mcp_tool_result' : 'agent.tool_result',
          threadId,
          content: [{
            type: 'tool_result',
            tool_use_id: call.blockId,
            content: INTERRUPTED_PARKED_CALL_MESSAGE,
            is_error: true,
          }],
        });
        this.broadcast(sessionId, result);
      }
    }
  }

  /** Await every execution chain a session's threads are running, swallowing errors. */
  private async drainChain(sessionId: string): Promise<void> {
    for (const threadId of this.threadIdsForSession(sessionId)) {
      const chain = this.executionChains.get(threadId);
      if (chain) {
        await chain.catch(() => {});
      }
    }
  }

  /** Every thread id this session owns — the primary plus its children. */
  private threadIdsForSession(sessionId: string): string[] {
    const rows = this.threadStore.listBySession(sessionId).map((thread) => thread.id);
    const primaryId = this.threadStore.primaryThreadId(sessionId);
    if (rows.includes(primaryId)) return rows;
    return [primaryId, ...rows];
  }

  /**
   * The session's archived thread ids — the threads whose parked calls can
   * never be answered, so the session-level `requires_action` union skips them.
   * Empty when nothing is archived (the ordinary case), kept as a Set so the
   * metadata filter is an O(1) membership test.
   */
  private archivedThreadIds(sessionId: string): ReadonlySet<string> {
    const archived = this.threadStore.listBySession(sessionId)
      .filter((t) => t.archivedAt)
      .map((t) => t.id);
    return archived.length === 0 ? EMPTY_THREAD_SET : new Set(archived);
  }

  /**
   * Get the Event Logger (exposed for Strategy/tests).
   */
  getEventLogger(): EventLogger {
    return this.eventLogger;
  }

  /**
   * Get the thread store (exposed for routes/tests).
   */
  getThreadStore(): SessionThreadStore {
    return this.threadStore;
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
      .prepare("SELECT id FROM sessions WHERE status IN ('running', 'retrying')")
      .all() as Array<{ id: string }>;

    for (const { id: sessionId } of running) {
      // Inject placeholder results for orphaned tool_use calls
      this.resolveOrphanedToolUses(sessionId);

      // Settle the primary (creating its row when an older workspace lacks
      // one), then every child the crash left active. Settling only the
      // primary leaves a child `running` in its row, and the aggregate
      // recomputes right back to `running` with no turn left to end it.
      this.updateStatus(sessionId, 'paused');
      for (const thread of this.threadStore.listBySession(sessionId)) {
        if (thread.status === 'running' || thread.status === 'retrying') {
          this.updateThreadStatus(sessionId, thread.id, 'paused');
        }
      }
      this.recomputeSessionStatus(sessionId);
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

  /**
   * Transition the session's primary thread — the only thread a single-agent
   * session has — and let the aggregate follow it. Callers that predate
   * threads keep this signature; the status they name is the primary
   * thread's, which `recomputeSessionStatus` then publishes as the session's.
   */
  private updateStatus(sessionId: string, newStatus: SessionStatus, idleStopReason?: IdleStopReason): void {
    // A session the migration could not have back-filled — one created by a
    // build between "the table exists" and "create writes the row" — gets its
    // primary here rather than silently dropping every later transition.
    const session = this.get(sessionId);
    if (session) this.threadStore.ensurePrimaryThread(session);
    this.updateThreadStatus(sessionId, this.threadStore.primaryThreadId(sessionId), newStatus, idleStopReason);
  }

  private updateSessionStatus(sessionId: string, newStatus: SessionStatus, idleStopReason?: IdleStopReason, derived = false): void {
    // Validate the transition against the state machine. If the current status
    // already equals the target, this is a no-op. Invalid transitions are
    // skipped (defense — should not happen given callers guard with isTerminal).
    // A recomputed aggregate is exempt: the session's published status is a
    // function of its threads, and §4.3's rules — not the single-thread
    // transition table — define which value it may take. A paused primary with
    // a requires_action child is `requires_action`, a transition the row alone
    // could never declare.
    const current = this.get(sessionId);
    if (current) {
      if (current.status === newStatus) return;
      if (!derived && !canTransition(current.status, newStatus)) {
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
        // The union counts only threads that can still be answered: a parked
        // call on an archived thread is unanswerable by definition, so it
        // leaves the published pending set when its thread is archived.
        metadata: lifecycleMetadataFor(newStatus, events, idleStopReason, undefined, this.archivedThreadIds(sessionId)),
      });
      this.broadcast(sessionId, statusEvent);
    }
  }

  /**
   * The derived id of the session's primary thread. Pure — the store never
   * scans for it, which is why callers can pass it without a round-trip.
   */
  primaryThreadId(sessionId: string): string {
    return this.threadStore.primaryThreadId(sessionId);
  }

  /**
   * Transition one thread and re-aggregate the session's status.
   *
   * This is the thread-level replacement for the session-level `updateStatus`
   * that every caller below still invokes through that name: in this change
   * the only thread that can transition is the primary one, so the session's
   * aggregate follows it mechanically. The thread's own
   * `session.thread_status_*` event is appended first (the row's thread id
   * rides the event log's `thread_id`), then `recomputeSessionStatus` decides
   * whether the session's published status changed — the ordering the contract
   * fixes: the thread event precedes the session event it caused.
   */
  private updateThreadStatus(
    sessionId: string,
    threadId: string,
    newStatus: SessionStatus,
    idleStopReason?: IdleStopReason,
  ): void {
    const thread = this.threadStore.get(threadId);
    if (!thread) {
      // A transition aimed at a thread that does not exist cannot be recorded
      // on it — but a missing *primary* row must not swallow the session's
      // lifecycle with it, so the aggregate is updated directly as it was
      // before threads existed.
      if (threadId === this.threadStore.primaryThreadId(sessionId)) {
        this.updateSessionStatus(sessionId, newStatus, idleStopReason);
      }
      return;
    }
    if (thread.status === newStatus) return;
    if (!canTransition(thread.status, newStatus)) {
      // A transition the thread row cannot take. For a child thread that is a
      // real refusal — but when the *primary* thread's stored status has
      // drifted from the session row (a crash left `sessions.status` ahead of
      // a thread row nothing ran), blocking here would deadlock the recovery
      // path that raw-wrote the session. Re-sync the primary's row to the
      // target — the session row is the source of truth for the drift — then
      // reconcile the aggregate so `sessions.status` reaches it too.
      if (threadId === this.threadStore.primaryThreadId(sessionId)) {
        this.threadStore.updateStatus(threadId, newStatus);
        this.updateSessionStatus(sessionId, newStatus, idleStopReason);
      }
      return;
    }

    this.threadStore.updateStatus(threadId, newStatus);

    // A child thread that just parked lifts the calls it is waiting on onto the
    // primary stream (§4.2 row 3): the block that needs a client's answer is
    // the one event of the child's own stream a primary-stream reader must
    // also see. The row keeps its own `thread_id`; `session_thread_id` on the
    // wire is what attributes it. The primary thread's own parked calls are on
    // the primary stream already, so only a child's rows need the flag.
    if (newStatus === 'requires_action' && threadId !== this.threadStore.primaryThreadId(sessionId)) {
      const parked = parkedCalls(this.eventLogger.getThreadEvents(sessionId, threadId));
      this.eventLogger.markCrossPosted(parked.map((call) => call.eventId));
    }

    const threadEventType = threadEventTypeForStatus(newStatus);
    if (threadEventType) {
      const events = this.eventLogger.getEvents(sessionId);
      // A child's `session.thread_status_*` is cross-posted so the primary
      // stream reports the whole session's lifecycle (§4.2 row 2), not only the
      // primary thread's. The primary thread's own transition needs no flag —
      // it is already on the primary stream by `thread_id` — but setting it is
      // harmless and keeps the write unconditional.
      const isPrimary = threadId === this.threadStore.primaryThreadId(sessionId);
      const threadEvent = this.eventLogger.append(sessionId, {
        type: threadEventType,
        threadId,
        crossPosted: !isPrimary,
        metadata: {
          session_thread_id: threadId,
          agent_name: thread.agentName,
          ...lifecycleMetadataFor(newStatus, events, idleStopReason, threadId),
        },
      });
      this.broadcast(sessionId, threadEvent);
    }

    this.recomputeSessionStatus(sessionId, idleStopReason);
  }

  /**
   * Recompute the session's published status from its threads and emit the
   * session-level event only when the aggregate actually changed.
   *
   * §4.3: any running thread → running (retrying when every active thread is
   * retrying); else any requires_action → requires_action; else all
   * unarchived paused → paused (reason = primary's, with budget_reached
   * bubbling up); primary terminal → session terminal. With a single primary
   * thread the recomputation is the identity map, which is what keeps the
   * pre-thread event sequence byte-for-byte stable.
   */
  private recomputeSessionStatus(sessionId: string, idleStopReason?: IdleStopReason): void {
    const threads = this.threadStore.listBySession(sessionId);
    const primaryId = this.threadStore.primaryThreadId(sessionId);
    const primary = threads.find((t) => t.id === primaryId);
    if (!primary) return;

    const unarchived = threads.filter((t) => !t.archivedAt);
    const active = unarchived.filter((t) => !isTerminal(t.status));

    let next: SessionStatus;
    if (isTerminal(primary.status)) {
      next = primary.status;
    } else if (active.length > 0 && active.every((t) => t.status === 'retrying')) {
      next = 'retrying';
    } else if (unarchived.some((t) => t.status === 'running' || t.status === 'retrying')) {
      next = 'running';
    } else if (unarchived.some((t) => t.status === 'requires_action')) {
      next = 'requires_action';
    } else if (unarchived.length > 0 && unarchived.every((t) => t.status === 'paused')) {
      next = 'paused';
    } else {
      // Nothing decided (e.g. queued primary before first turn): keep the row.
      return;
    }

    this.updateSessionStatus(sessionId, next, idleStopReason, true);
  }

  /**
   * Append and broadcast the `session.usage` snapshot for the session's current
   * aggregate — the same documented payload {@link buildUsagePayload} answers:
   * token counters, activity time, `list_cost` when it can be priced in full,
   * the budget echo, and the server-tool counters.
   */
  private appendUsageSnapshot(sessionId: string, events: SessionEvent[]): void {
    const usageEvent = this.eventLogger.append(sessionId, {
      type: 'session.usage',
      metadata: { usage: this.usagePayloadFor(sessionId, events) },
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
   * An outcome that stops without a verdict — the caller interrupted it, a turn
   * left the session waiting on a tool confirmation, or the session spent its
   * declared ceiling — closes with the reason it stopped rather than with a
   * verdict about a deliverable nobody finished. The ceiling is read here as well
   * as at admission because the iterations are internal to one admitted event and
   * no admission gate would see their model requests.
   */
  private async runDeclaredOutcomeLoop(
    sessionId: string,
    event: Extract<UserEvent, { type: 'user.define_outcome' }>,
    abortController: AbortController,
    turnState: { requiresAction: boolean; retriesExhausted: boolean },
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
      // The id assigned at admission — spans and the session object's
      // `outcome_evaluations` entry join on it. The fallback only covers a
      // caller that bypassed admission entirely.
      outcomeId: event.outcome_id ?? `outc_${nanoid(16)}`,
      request: {
        description: event.description,
        maxIterations: event.max_iterations ?? DEFAULT_OUTCOME_MAX_ITERATIONS,
      },
      rubric,
      // The grader scores with the same model reference the deliverable was
      // produced with: provider configurations carry no model id, so the
      // session's effective agent definition is the only concrete reference
      // that resolves. A non-frozen session resolves its agent live, the same
      // lookup the turn itself makes.
      model: (() => {
        const session = this.get(sessionId);
        return (session?.agentDefinition ?? (session ? this.resolveAgentSnapshot(session.agentId)?.definition : undefined))?.model;
      })(),
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
        recordModelUsage: (usage) => {
          // The grade's `input_tokens` is already the uncached share, so the
          // detail map re-splits it back to itself; the helper stays the
          // single place that decides what counts as uncached input.
          const logged = this.eventLogger.recordAuxiliaryModelUsage(sessionId, {
            inputTokens: usage.input_tokens,
            inputTokenDetails: {
              noCacheTokens: usage.input_tokens,
              cacheReadTokens: usage.cache_read_input_tokens,
              cacheWriteTokens: usage.cache_creation_input_tokens,
            },
            outputTokens: usage.output_tokens,
          }, { purpose: 'outcome_evaluation' });
          this.broadcast(sessionId, logged);
        },
      },
      appendRevision: (text) => {
        revision = text;
        return this.appendOutcomeRevision(sessionId, text);
      },
      runTurn: () => this.runOutcomeTurn(sessionId, abortController, revision, turnState),
      readTranscript: () => outcomeTranscript(this.eventLogger.getEvents(sessionId)),
      isAborted: () => abortController.signal.aborted || turnState.requiresAction,
      // The session's own ceiling, which admission enforces for events and the
      // loop enforces for the turns no event goes through.
      isExhausted: () => this.isBudgetExhausted(sessionId),
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
    turnState: { requiresAction: boolean; retriesExhausted: boolean },
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
      budgetExhausted: () => this.isBudgetExhausted(sessionId),
      retryObserver: this.retryObserverFor(sessionId, turnState),
      onRequiresAction: () => {
        turnState.requiresAction = true;
      },
    })) {
      this.broadcast(sessionId, evt);
    }
  }

  /**
   * Turn-level view onto the model wrapper's retry decisions, so a transient
   * provider failure shows up on the wire instead of only waiting silently.
   *
   * The first scheduled retry moves the session to `retrying` — projecting as
   * `rescheduling` with a `session.status_rescheduled` — after the
   * `session.error` that explains it; later retries in the same wait cycle
   * only add their own error event. A request that succeeds after a retry
   * moves the session back to `running`, and the exhausted case never reaches
   * here: the final error surfaces through `runTurn`'s catch instead.
   */
  private retryObserverFor(sessionId: string, turnState: { retriesExhausted: boolean }, threadId?: string): RetryObserver {
    // The observer belongs to one turn on one thread. Defaulting to the primary
    // keeps the outcome loop (which only runs there) on the same path while a
    // child's retry stays attributed to the child.
    const resolvedThreadId = threadId ?? this.threadStore.primaryThreadId(sessionId);
    return {
      onRetryScheduled: ({ error }) => {
        const code = errorCodeOf(error);
        const errorEvent = this.eventLogger.append(sessionId, {
          type: 'session.error',
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          metadata: sessionErrorMetadata(error, code, { type: 'retrying' }),
          threadId: resolvedThreadId,
        });
        this.broadcast(sessionId, errorEvent);
        if (this.threadStore.get(resolvedThreadId)?.status === 'running') {
          this.updateThreadStatus(sessionId, resolvedThreadId, 'retrying');
        }
      },
      onRetryRecovered: () => {
        if (this.threadStore.get(resolvedThreadId)?.status === 'retrying') {
          this.updateThreadStatus(sessionId, resolvedThreadId, 'running');
        }
      },
      onRetryExhausted: () => {
        turnState.retriesExhausted = true;
      },
    };
  }

  /**
   * Give a transient preview frame the thread that produced it.
   *
   * `seq === 0` frames are built by the strategy, which knows only the
   * session; the persisted writer stamps its own thread. Without this stamp a
   * child's token previews carry no `threadId`, so the primary stream's
   * "pre-thread orphan" admission claims them and the child's own stream
   * filters them out — the opposite of the contract's per-thread scope.
   * Persisted events are untouched: their writer already stamped them.
   */
  private withTransientThread(event: SessionEvent, threadId: string): SessionEvent {
    return event.seq === 0 && event.threadId === undefined ? { ...event, threadId } : event;
  }

  /**
   * Run a single turn on one thread. Serialized via that thread's
   * executionChains entry so its turns never overlap, while a sibling thread's
   * chain runs concurrently.
   *
   * `threadId` defaults to the session's primary thread: every caller that
   * predates threads (and every client event, which can only address the
   * session) is by definition running the primary. A `send_to_agent` child names
   * its own thread, and the turn's status transitions, context projection, and
   * event writes all scope to that thread — the session's aggregate follows the
   * thread's through `recomputeSessionStatus`.
   */
  private async runTurn(sessionId: string, event: TurnTrigger, threadId?: string): Promise<void> {
    if (!this.executor) return;

    const session = this.get(sessionId);
    // Session may have been stopped/deleted between enqueue and execution.
    if (!session || isTerminal(session.status)) return;

    const resolvedThreadId = threadId ?? this.threadStore.primaryThreadId(sessionId);
    const thread = this.threadStore.get(resolvedThreadId)
      ?? (resolvedThreadId === this.threadStore.primaryThreadId(sessionId)
        ? this.threadStore.ensurePrimaryThread(session)
        : undefined);
    // A child thread row that is gone — archived or deleted between dispatch and
    // execution — has nothing to run; the turn is simply dropped. An archived
    // thread's turns are dropped the same way: archive is the terminal
    // lifecycle write, so nothing may run on the thread after it.
    if (!thread || thread.archivedAt) return;

    // Two resume requests can legitimately queue behind one idle — the check at
    // enqueue is a fast path only, so the trigger re-reads the log when its turn
    // comes. A first resume that already ran ends the session on `end_turn`,
    // and anything else that idled it since is a reason a duplicate must not
    // re-enter over. The reason is read off *this* thread's stream: a sibling
    // thread idling on `end_turn` while this one still waits on the ceiling
    // must not cancel a resume that belongs to it (§4.6).
    if (event.type === 'internal.resume_after_budget' && !this.lastIdleStopReasonIs(sessionId, 'budget_reached', resolvedThreadId)) {
      return;
    }
    // An `internal.thread_message` trigger re-enters only when its thread is
    // actually waiting: a reply for an idle (paused) coordinator starts a turn,
    // but one for a thread that has since gone terminal or moved on is stale.
    if (event.type === 'internal.thread_message' && !this.threadAcceptsMessage(thread)) {
      return;
    }

    // Transition the thread to running for this turn; the session's aggregate
    // follows through the recompute below.
    if (thread.status !== 'running') {
      this.updateThreadStatus(sessionId, resolvedThreadId, 'running');
    }

    const abortController = new AbortController();
    this.abortControllers.set(resolvedThreadId, abortController);
    // Shared with the outcome loop: a revision turn that stops for a tool
    // confirmation ends the outcome (it cannot drive another turn while the
    // session waits), and the status below still says `requires_action`.
    const turnState = { requiresAction: false, retriesExhausted: false };

    try {
      const running = this.get(sessionId)!;
      // The thread's own view of the session: a child runs its roster member's
      // pinned definition rather than the coordinator's, and the sandbox,
      // resources, and environment are the session's, shared across threads.
      const threadSession = this.sessionForThread(running, thread);
      for await (const evt of this.executor.execute(threadSession, event, {
        abortSignal: abortController.signal,
        broadcast: (e) => this.broadcast(sessionId, this.withTransientThread(e, resolvedThreadId)),
        budgetExhausted: () => this.isBudgetExhausted(sessionId),
        retryObserver: this.retryObserverFor(sessionId, turnState, resolvedThreadId),
        thread,
        // A rostered thread gets the coordinator tools bound to its own
        // dispatch host; a thread with no roster builds none, so the host is
        // still constructed but unused.
        coordinatorHost: this.coordinatorHost(sessionId, thread),
        onRequiresAction: () => {
          turnState.requiresAction = true;
        },
      })) {
        this.broadcast(sessionId, this.withTransientThread(evt, resolvedThreadId));
      }

      // A declared outcome is driven once the turn it instructed has finished.
      // Outcomes are a primary-thread concern — the loop measures the session's
      // deliverable and re-enters the executor on the primary thread — so a
      // child thread's turn never reaches this branch: it cannot carry a
      // `user.define_outcome`, which is the only trigger that runs one.
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
      // a turn that stopped at the spending ceiling idles on `budget_reached`
      // — the ceiling outranks only `end_turn`, never a parked call waiting on
      // its answer. Anything else goes idle (paused), awaiting next input.
      const settledThread = this.threadStore.get(resolvedThreadId);
      if (settledThread && (settledThread.status === 'running' || settledThread.status === 'retrying')) {
        if (turnState.requiresAction) {
          this.updateThreadStatus(sessionId, resolvedThreadId, 'requires_action');
        } else if (this.isBudgetExhausted(sessionId)) {
          this.resolveOrphanedToolUses(sessionId, resolvedThreadId);
          this.updateThreadStatus(sessionId, resolvedThreadId, 'paused', 'budget_reached');
          // A budget-parked child does not report back: its turn is suspended,
          // not finished, so there is no reply for the parent to fold in. When
          // the ceiling lifts and the thread resumes, the turn that then ends
          // `end_turn` posts the reply like any other.
        } else {
          this.updateThreadStatus(sessionId, resolvedThreadId, 'paused');
          // A child that ended its turn reports back to its parent: the last
          // assistant text becomes the parent's `thread_message_received`,
          // which is what re-enters the parent's chain for the reply.
          this.postReplyToParent(sessionId, thread);
        }
      }
    } catch (err) {
      const errorCode = errorCodeOf(err);
      if (errorCode === PI_CLEANUP_PENDING_CODE) {
        const errorEvent = this.eventLogger.append(sessionId, {
          type: 'session.error',
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          metadata: sessionErrorMetadata(err, errorCode),
          threadId: resolvedThreadId,
        });
        this.broadcast(sessionId, errorEvent);
        if (this.threadStore.get(resolvedThreadId)?.status === 'running') {
          this.updateThreadStatus(sessionId, resolvedThreadId, 'cleanup_pending');
        }
      } else if (abortController.signal.aborted || isAbortError(err)) {
        const current = this.threadStore.get(resolvedThreadId);
        if (current && (current.status === 'running' || current.status === 'retrying')) {
          this.updateThreadStatus(sessionId, resolvedThreadId, 'paused');
        }
      } else if (turnState.retriesExhausted || isRetriesExhausted(err)) {
        const errorEvent = this.eventLogger.append(sessionId, {
          type: 'session.error',
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          metadata: sessionErrorMetadata(err, errorCode, { type: 'exhausted' }),
          threadId: resolvedThreadId,
        });
        this.broadcast(sessionId, errorEvent);
        const current = this.threadStore.get(resolvedThreadId);
        if (current && (current.status === 'running' || current.status === 'retrying')) {
          this.updateThreadStatus(sessionId, resolvedThreadId, 'paused', 'retries_exhausted');
        }
      } else {
        const errorEvent = this.eventLogger.append(sessionId, {
          type: 'session.error',
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          metadata: sessionErrorMetadata(err, errorCode),
          threadId: resolvedThreadId,
        });
        this.broadcast(sessionId, errorEvent);
        const current = this.threadStore.get(resolvedThreadId);
        if (current && !isTerminal(current.status)) {
          if (errorCode === PI_CLEANUP_PENDING_CODE) this.updateThreadStatus(sessionId, resolvedThreadId, 'cleanup_pending');
          else if (errorCode === PI_TIMED_OUT_CODE) this.updateThreadStatus(sessionId, resolvedThreadId, 'timed_out');
          else if (errorCode === PI_SESSION_BUSY_CODE) this.updateThreadStatus(sessionId, resolvedThreadId, 'paused');
          else if (RESUMABLE_MODEL_FAILURE_CODES.has(errorCode ?? '')) this.updateThreadStatus(sessionId, resolvedThreadId, 'paused');
          else this.updateThreadStatus(sessionId, resolvedThreadId, 'failed');
        }
        // The sandbox is bound to the session, not the thread. A child's
        // failure must not tear it down under a primary or sibling turn that is
        // still running; the primary's own failure keeps the original
        // teardown, and a later terminal transition releases it as before.
        if (errorCode !== PI_CLEANUP_PENDING_CODE
          && resolvedThreadId === this.threadStore.primaryThreadId(sessionId)) {
          await this.releaseSandbox(sessionId);
        }
      }
    } finally {
      this.abortControllers.delete(resolvedThreadId);
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

  // ============================================================
  // Thread execution — the `send_to_agent` dispatch and reply path
  // ============================================================

  /**
   * The session a thread's turn executes against.
   *
   * A child thread shares the session's sandbox, resources, environment, and
   * vault — the contract is one workspace per session, not one per thread — but
   * runs its own roster member's definition: the agent the coordinator pinned,
   * with the coordinator's session-level overrides applied to a `self` replica.
   * The primary thread runs the session's own effective definition, so the view
   * is a pass-through there and a substitution only for a child.
   */
  private sessionForThread(session: Session, thread: SessionThread): Session {
    if (thread.parentThreadId === null) return session;
    return {
      ...session,
      agentId: thread.agentId ?? session.agentId,
      agentName: thread.agentName,
      agentVersion: thread.agentVersion ?? session.agentVersion,
      // The thread row carries the resolved definition snapshot — the roster
      // member's pinned version for a named agent, or the coordinator's
      // effective definition for a `self` replica — so the turn runs exactly
      // the configuration the dispatch captured.
      agentDefinition: thread.agentDefinition,
    };
  }

  /**
   * Whether a thread is in a state where a sibling's reply can start a turn.
   *
   * A reply re-enters only an idle thread: one already running picks the
   * message up on its next turn's context rebuild, and a terminal or
   * requires_action thread is left alone — the message stays durable in its
   * log either way.
   */
  private threadAcceptsMessage(thread: SessionThread): boolean {
    // A freshly dispatched child is 'queued': its row exists but no turn has
    // run yet, so the trigger that starts it must be admitted rather than
    // dropped as a message on a non-idle thread. An archived thread is closed
    // for input entirely — archive is the terminal lifecycle write.
    return !thread.archivedAt && (thread.status === 'paused' || thread.status === 'queued');
  }

  /**
   * Hand a finished child turn's reply back to its parent thread.
   *
   * Runs once per child turn that ends `end_turn` (paused) rather than
   * `requires_action`: a parked call is the child waiting on its own client
   * work, so the reply only goes out when the turn genuinely closes. The
   * child's last assistant text becomes the parent's
   * `agent.thread_message_received` — cross-posted so it also surfaces on the
   * primary stream when the parent is not itself the primary thread — and the
   * parent's own `agent.thread_message_sent` closes the pair on the child's
   * side. The parent's chain is then re-entered with `internal.thread_message`,
   * which the runTurn fast-path accepts only if the parent is still idle.
   */
  private postReplyToParent(sessionId: string, child: SessionThread): void {
    if (child.parentThreadId === null) return; // the primary thread has no parent to answer
    const parent = this.threadStore.get(child.parentThreadId);
    if (!parent) return;

    // The reply is the last assistant text the child produced this turn — the
    // event the model meant as its answer — read off the child's own stream so
    // a concurrent sibling's events cannot interleave into it.
    const childEvents = this.eventLogger.getThreadEvents(sessionId, child.id);
    const lastMessage = [...childEvents].reverse().find((event) => event.type === 'agent.message');
    const replyText = (lastMessage?.content ?? [])
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    // `agent.thread_message_sent` on the child's stream closes the pair: on a
    // child it is the reply going out, just as on the parent it is the task
    // going in. Cross-posted so the parent's stream shows the full exchange.
    const sent = this.eventLogger.append(sessionId, {
      type: 'agent.thread_message_sent',
      threadId: child.id,
      crossPosted: true,
      content: [{ type: 'text', text: replyText }],
      metadata: {
        to_session_thread_id: parent.id,
        to_agent_name: parent.agentName,
        from_session_thread_id: child.id,
        from_agent_name: child.agentName,
      },
    });
    this.broadcast(sessionId, sent);

    const received = this.eventLogger.append(sessionId, {
      type: 'agent.thread_message_received',
      threadId: parent.id,
      crossPosted: true,
      content: [{ type: 'text', text: replyText }],
      metadata: {
        from_session_thread_id: child.id,
        from_agent_name: child.agentName,
      },
    });
    this.broadcast(sessionId, received);

    // Re-enter the parent's chain only when it is parked — a running parent
    // folds the message into its next context rebuild instead. The trigger is
    // internal: the reply is already durable, so a `user.message` carrier would
    // fabricate an utterance the model never saw arrive.
    this.enqueueThreadTurn(sessionId, parent.id, { type: 'internal.thread_message', threadId: parent.id });
  }

  /**
   * The `CoordinatorToolsHost` the executor's coordinator tools run against.
   *
   * Bound to one coordinator thread for the lifetime of its turn: the host
   * reads the session's live thread set, enforces the concurrency cap, and
   * performs the dispatch — inserting the child row, recording the
   * `session.thread_created` and the sent/received event pair on the right
   * streams, and enqueueing the child's turn on its own chain. The tool layer
   * turns a failed dispatch into a tool error rather than a thrown exception,
   * so a bad `agent`/`thread_id` argument is a result the model can read and
   * recover from.
   */
  private coordinatorHost(sessionId: string, parentThread: SessionThread): CoordinatorToolsHost {
    return {
      sessionId,
      parentThread,
      listThreads: () => this.threadStore.listBySession(sessionId),
      activeChildCount: () => this.threadStore.activeChildCount(sessionId),
      agentNameFor: (agentId) => this.resolveAgentSnapshot(agentId)?.name,
      agentDescriptionFor: (agentId) => this.resolveAgentSnapshot(agentId)?.definition.description,
      dispatchToAgent: ({ member, message, threadId }) => {
        // Resolve the target thread: an existing one for a follow-up, or a new
        // child row for a first dispatch.
        let target: SessionThread | undefined;
        let created = false;
        if (threadId !== undefined) {
          const existing = this.threadStore.get(threadId);
          if (!existing || existing.sessionId !== sessionId) {
            return { ok: false, reason: `Thread "${threadId}" does not exist in this session.` };
          }
          if (existing.archivedAt) {
            return { ok: false, reason: `Thread "${threadId}" is archived; start a new thread instead.` };
          }
          if (existing.agentName !== this.agentNameForMember(member)) {
            return {
              ok: false,
              reason: `Thread "${threadId}" runs "${existing.agentName}", not "${this.agentNameForMember(member)}".`,
            };
          }
          target = existing;
        } else {
          if (this.threadStore.activeChildCount(sessionId) >= MAX_ACTIVE_CHILD_THREADS) {
            return {
              ok: false,
              reason: `Concurrency limit reached: ${MAX_ACTIVE_CHILD_THREADS} active child threads. Archive a finished thread before dispatching another.`,
            };
          }
          const memberName = this.agentNameForMember(member);
          const memberDefinition = this.definitionForMember(member, sessionId, parentThread);
          if (!memberDefinition) {
            return {
              ok: false,
              reason: `Roster member "${memberName}" version ${member.version} is no longer available; delegation refuses to run a different definition.`,
            };
          }
          target = this.threadStore.insertThread({
            sessionId,
            parentThreadId: parentThread.id,
            agentName: memberName,
            agentDefinition: memberDefinition,
            agentId: member.id,
            agentVersion: member.version,
            status: 'queued',
          });
          created = true;

          // `session.thread_created` is produced on the parent (the coordinator
          // dispatched it) and cross-posted so the child's own stream records it
          // too — the thread's first event, before any turn runs.
          const createdEvent = this.eventLogger.append(sessionId, {
            type: 'session.thread_created',
            threadId: parentThread.id,
            crossPosted: true,
            metadata: {
              session_thread_id: target.id,
              agent_name: target.agentName,
              parent_thread_id: parentThread.id,
              workflow_run_id: target.workflowRunId,
            },
          });
          this.broadcast(sessionId, createdEvent);
        }

        // The sent/received pair: `agent.thread_message_sent` on the parent's
        // stream (cross-posted so the primary sees the dispatch), and
        // `agent.thread_message_received` on the child's, which is the input
        // its turn reads.
        this.dispatchChildMessage(sessionId, parentThread, target, message);
        return { ok: true, thread: target, created };
      },
      dispatchInlineAgent: ({ definition, message }) => {
        if (this.threadStore.activeChildCount(sessionId) >= MAX_ACTIVE_CHILD_THREADS) {
          return {
            ok: false,
            reason: `Concurrency limit reached: ${MAX_ACTIVE_CHILD_THREADS} active child threads. Archive a finished thread before dispatching another.`,
          };
        }
        const parentDefinition = parentThread.agentDefinition;
        // Inline agents inherit the coordinator's model, tools, MCP servers,
        // and skills; they may override only the thread-scoped identity and
        // prompt. Clearing `multiagent` and the local delegation extension is
        // what keeps an inline child at one level.
        const inlineDefinition: AgentDefinition = {
          ...parentDefinition,
          name: definition.name,
          description: definition.description ?? '',
          ...(definition.system !== undefined ? { system: definition.system } : {}),
          multiagent: null,
        };
        delete inlineDefinition.delegations;
        delete inlineDefinition.enable_general_subagent;

        const target = this.threadStore.insertThread({
          sessionId,
          parentThreadId: parentThread.id,
          agentName: definition.name,
          agentDefinition: inlineDefinition,
          agentId: null,
          agentVersion: null,
          status: 'queued',
          agentKind: 'inline',
        });
        const createdEvent = this.eventLogger.append(sessionId, {
          type: 'session.thread_created',
          threadId: parentThread.id,
          crossPosted: true,
          metadata: {
            session_thread_id: target.id,
            agent_name: target.agentName,
            parent_thread_id: parentThread.id,
            workflow_run_id: target.workflowRunId,
          },
        });
        this.broadcast(sessionId, createdEvent);
        this.dispatchChildMessage(sessionId, parentThread, target, message);
        return { ok: true, thread: target, created: true };
      },
      consultAdvisor: ({ message }) => {
        const multiagent = parentThread.agentDefinition.multiagent;
        if (multiagent?.type !== 'multiagent_20261001' || multiagent.advisor.type !== 'enabled') {
          return { ok: false, reason: 'This session has no enabled advisor.' };
        }
        // One platform advisor thread per session; a new consultation re-enters
        // the same thread so its prior advice is part of the context.
        let target = this.threadStore.listBySession(sessionId)
          .find((thread) => thread.kind === 'advisor' && !thread.archivedAt);
        let created = false;
        if (!target) {
          const advisorDefinition: AgentDefinition = {
            name: 'anthropic.advisor',
            description: 'Session advisor',
            model: multiagent.advisor.model,
            system:
              'You are the session advisor. Give focused, concrete advice in response to the question. ' +
              'You have no tools and do not perform work yourself; the coordinator applies your advice.',
            tools: [],
            mcp_servers: [],
            skills: [],
            multiagent: null,
          };
          target = this.threadStore.insertThread({
            sessionId,
            parentThreadId: parentThread.id,
            agentName: 'anthropic.advisor',
            agentDefinition: advisorDefinition,
            agentId: null,
            agentVersion: null,
            status: 'queued',
            kind: 'advisor',
            agentKind: 'advisor',
          });
          created = true;
          const createdEvent = this.eventLogger.append(sessionId, {
            type: 'session.thread_created',
            threadId: parentThread.id,
            crossPosted: true,
            metadata: {
              session_thread_id: target.id,
              agent_name: target.agentName,
              parent_thread_id: parentThread.id,
              workflow_run_id: target.workflowRunId,
            },
          });
          this.broadcast(sessionId, createdEvent);
        }
        this.dispatchChildMessage(sessionId, parentThread, target, message);
        return { ok: true, thread: target, created };
      },
    };
  }

  /** Record a dispatch on both streams and enqueue the child's turn. */
  private dispatchChildMessage(
    sessionId: string,
    parentThread: SessionThread,
    target: SessionThread,
    message: string,
  ): void {
    const sentEvent = this.eventLogger.append(sessionId, {
      type: 'agent.thread_message_sent',
      threadId: parentThread.id,
      crossPosted: true,
      content: [{ type: 'text', text: message }],
      metadata: {
        to_session_thread_id: target.id,
        to_agent_name: target.agentName,
      },
    });
    this.broadcast(sessionId, sentEvent);

    const receivedEvent = this.eventLogger.append(sessionId, {
      type: 'agent.thread_message_received',
      threadId: target.id,
      content: [{ type: 'text', text: message }],
      metadata: {
        from_session_thread_id: parentThread.id,
        from_agent_name: parentThread.agentName,
      },
    });
    this.broadcast(sessionId, receivedEvent);

    // Queue the child's turn on its own chain — independent of the parent's,
    // so the dispatch returns while the child is already running.
    this.enqueueThreadTurn(sessionId, target.id, { type: 'internal.thread_message', threadId: target.id });
  }

  /** The display name a roster member carries on the wire (its agent's `name`). */
  private agentNameForMember(member: { type: 'agent'; id: string; version: number }): string {
    return this.resolveAgentSnapshot(member.id)?.name ?? member.id;
  }

  /**
   * The definition snapshot a child thread runs.
   *
   * A `self` replica runs the coordinator's *effective* definition — the same
   * resolved configuration the coordinator's own thread runs, session-level
   * overrides included — because the contract says a `self` member is a copy of
   * the coordinator, not a fresh resolution of its durable row. A named member
   * runs its pinned version's definition, which the roster captured at write
   * time; a pin the store can no longer resolve is refused by the caller rather
   * than silently substituted with another definition.
   */
  private definitionForMember(
    member: { type: 'agent'; id: string; version: number },
    sessionId: string,
    parentThread: SessionThread,
  ): AgentDefinition | undefined {
    const coordinator = parentThread.agentDefinition;
    // A `self` member's pinned id is the coordinator's own agent id, so the
    // replica reuses the coordinator's running definition wholesale — the
    // roster entry resolved to "this same agent", and the snapshot must match.
    if (member.id === parentThread.agentId) {
      return coordinator;
    }
    return this.resolveAgentSnapshot(member.id, member.version)?.definition;
  }

  /**
   * Append a placeholder tool_result for every orphaned tool_use on one
   * thread — or across the session when no thread is named. Called on crash
   * recovery (all threads) and on a fresh user message or budget pause (the
   * thread the action belongs to) so the next `eventsToMessages` projection
   * yields a valid, paired message sequence instead of an unpaired tool-call
   * the model rejects.
   *
   * The message is fixed rather than a parameter: both callers describe the same
   * epistemic situation — a call was dispatched and its result was never recorded —
   * and they used to pass two different sentences, one of which told the model to
   * retry. See {@link INTERRUPTED_TOOL_OUTCOME_MESSAGE}. Taking it from a caller
   * would let the two paths drift apart again, and the drift is what produced the
   * misleading sentence in the first place.
   */
  private resolveOrphanedToolUses(sessionId: string, threadId?: string): void {
    // A turn may only settle its own thread's calls. The unscoped form is the
    // crash-recovery pass, which runs before any thread is executing and must
    // pair every stream; a live user message or a budget pause is scoped to the
    // thread it belongs to, so it cannot answer a sibling's parked call or
    // inject a placeholder into a sibling's in-flight turn.
    const events = threadId !== undefined
      ? this.eventLogger.getThreadEvents(sessionId, threadId)
      : this.eventLogger.getEvents(sessionId);
    for (const toolUse of findOrphanedToolUses(events)) {
      this.eventLogger.append(sessionId, {
        type: toolUse.resultType,
        // The placeholder lands on the thread that produced the orphaned call,
        // so that thread's projection pairs it — a child's crash must not leave
        // an unpaired call on its own stream while the placeholder sits on the
        // primary's.
        threadId: toolUse.threadId ?? threadId,
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: INTERRUPTED_TOOL_OUTCOME_MESSAGE,
          is_error: true,
        }],
      });
    }
  }
}

/**
 * Resolve the caller's `tool_use_id` to the pending call it names.
 *
 * The published contract puts the `tool_use` **event** id in circulation: the
 * client is told the blocking events' ids are in `stop_reason.event_ids`
 * (`会话事件流.md:1876`) and passes each entry straight back here
 * (`权限策略.md:669`, "在 `tool_use_id` 参数中传递事件 ID"). Local callers and
 * this runtime's own tests answer with the `tool_use` **block** id instead, so
 * both spellings select the call. Widening *which* identifier selects it does
 * not widen authority: the pending check, the one-shot resolution below, and the
 * tool-result pairing all still decide whether anything may run.
 *
 * The block id is what every downstream step needs — the tool result that pairs
 * this call back to its `tool_use` block is written with it, and the
 * model-facing message projection keys tool results by tool-call id — so the
 * resolved block id is returned and persisted, whichever spelling arrived.
 */
function resolveConfirmedToolUse(
  reference: string,
  events: SessionEvent[],
): { blockId: string; confirmationGroupId?: string } | undefined {
  for (const loggedEvent of events) {
    if (loggedEvent.type !== 'agent.tool_use' && loggedEvent.type !== 'agent.mcp_tool_use') continue;
    // The event id is matched first, so an id that somehow answers to both
    // spellings still resolves deterministically.
    if (loggedEvent.id !== reference) {
      const candidate = loggedEvent.content?.find((item) => item.type === 'tool_use') as
        | { type: 'tool_use'; id: string }
        | undefined;
      if (candidate?.id !== reference) continue;
    }
    const block = loggedEvent.content?.find((item) => item.type === 'tool_use') as
      | { type: 'tool_use'; id: string; requires_confirmation?: boolean; confirmation_group_id?: string }
      | undefined;
    if (!block?.requires_confirmation) continue;
    const groupId = block.confirmation_group_id
      ?? (typeof loggedEvent.metadata?.confirmation_group_id === 'string'
        ? loggedEvent.metadata.confirmation_group_id
        : undefined);
    return { blockId: block.id, ...(groupId ? { confirmationGroupId: groupId } : {}) };
  }
  return undefined;
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

  const target = resolveConfirmedToolUse(event.tool_use_id, events);
  if (!target) {
    throw new Error('Invalid tool confirmation: the tool call is not awaiting approval');
  }

  // Resolution and the duplicate check are both keyed on the canonical block id,
  // so answering with the other spelling is not a way to decide one call twice.
  for (const loggedEvent of events) {
    if (loggedEvent.type === 'user.tool_confirmation'
      && loggedEvent.metadata?.tool_use_id === target.blockId) {
      throw new Error('Invalid tool confirmation: the tool call is not awaiting approval');
    }
    if (loggedEvent.type === 'agent.tool_result' || loggedEvent.type === 'agent.mcp_tool_result') {
      const block = loggedEvent.content?.find((item) => item.type === 'tool_result') as
        | { type: 'tool_result'; tool_use_id: string }
        | undefined;
      if (block?.tool_use_id === target.blockId) {
        throw new Error('Invalid tool confirmation: the tool call is not awaiting approval');
      }
    }
  }

  return {
    tool_use_id: target.blockId,
    result: event.result,
    ...(event.deny_message !== undefined ? { deny_message: event.deny_message } : {}),
    ...(target.confirmationGroupId ? { confirmation_group_id: target.confirmationGroupId } : {}),
  };
}

type IdleStopReason = 'budget_reached' | 'retries_exhausted';

function lifecycleMetadataFor(status: SessionStatus, events: SessionEvent[], idleStopReason?: IdleStopReason, threadId?: string, excludeThreadIds?: ReadonlySet<string>): Record<string, unknown> | undefined {
  if (status === 'paused') return { stop_reason: { type: idleStopReason ?? 'end_turn' } };
  if (status !== 'requires_action') return undefined;

  // The parked set comes from `parkedCalls`, which the resume gate in the
  // executor reads too. One definition, because a client is told which ids to
  // answer by this projection while that gate decides whether a turn may start:
  // two derivations is how they drift into disagreeing about whether the session
  // is still waiting. `parked-calls.ts` records what parks a session and why
  // resolution is tracked by block id while the event id is what is reported.
  //
  // `action_type` is deliberately not written: it is absent from the published
  // contract and nothing reads it, and with both families able to be parked at
  // once no single value of it would be true. What remains is exactly the
  // published shape, `{ type, event_ids }`.
  return {
    stop_reason: {
      type: 'requires_action',
      // A thread event's event_ids name only that thread's parked calls; the
      // session-level status event is the union across threads (§4.3 rule 2),
      // which is what passing no scope yields.
      event_ids: parkedCalls(
        events.filter((event) =>
          (threadId === undefined || event.threadId === threadId)
            && !(excludeThreadIds?.has(event.threadId ?? '') ?? false)),
      ).map((call) => call.eventId),
    },
  };
}

function sessionOperationError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * The definition fields `updateSession` admits under `agent`. One set because
 * the allow-list, the refusal message, and the contract all name the same
 * pair: `tools` and `mcp_servers` are the tool surface a session owns, and
 * everything else belongs to the agent's own update route.
 */
const SESSION_UPDATE_AGENT_FIELDS = new Set(['tools', 'mcp_servers']);

function sessionOwnedTables(db: Database): string[] {
  const tables = db.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>;

  return tables
    .filter(({ name }) => {
      const identifier = name.replace(/"/g, '""');
      const columns = db.prepare(`PRAGMA table_info("${identifier}")`).all() as Array<{ name: string }>;
      return columns.some((column) => column.name === 'session_id');
    })
    .map(({ name }) => name);
}

function hasSessionOutputMetadata(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.session_output_path === 'string';
  } catch {
    return false;
  }
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
 *
 * The published `error.type` is the official classification, never the local
 * code: `officialErrorType` maps a provider 401 and a missing model id to
 * `model_request_failed_error` alike, while the code the failure was raised
 * with is preserved under `error.code`.
 */
function sessionErrorMetadata(
  error: unknown,
  code: string | undefined,
  retryStatusOverride?: SessionErrorRetryStatus,
): Record<string, unknown> {
  return {
    error: {
      type: officialErrorType(code, error),
      message: error instanceof Error ? error.message : String(error),
      retry_status: retryStatusOverride ?? retryStatusFor(code),
      // A codeless failure still records `internal_error` — the same fallback
      // it previously published as `type`, now in the extension field.
      code: code ?? INTERNAL_ERROR_CODE,
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
    // A work item nobody claimed is that same kind of condition in the self-hosted queue:
    // the bounded wait expired because no worker was there yet, nothing ran, and the
    // intent is safe to submit again. It is the one way that wait can end with no
    // possible side effect, which is exactly what makes the reason worth reporting.
    case WORK_QUEUE_TIMEOUT_CODE:
      return retryStatus('retryable');
    case PI_CLEANUP_PENDING_CODE:
    case PI_TIMED_OUT_CODE:
    // The parked-wait bound is not a condition a retry fixes either: the runtime
    // decided to stop waiting, and re-running the request it was waiting on would
    // ask the same unanswered question again.
    case PARKED_WAIT_TIMEOUT_CODE:
    case PI_ALWAYS_ASK_UNSUPPORTED_CODE:
    // The gate codes are permanent for the same reason: a gate extension that did
    // not load, a gated call that ran with no decision, and a decision naming a
    // gate nobody is waiting on are not conditions a retry fixes.
    case PI_RPC_GATE_UNAVAILABLE_CODE:
    case PI_RPC_GATE_LOST_CODE:
    case PI_RPC_APPROVAL_NOT_PENDING_CODE:
    // A frame that could not be trusted is not retryable either. It is raised
    // while reading, so the command may already have reached the engine: the
    // transport says of the same situation that the bytes "may or may not have
    // reached the engine" and "the caller must not retry the command". The one
    // case where nothing was written is a transport built without a writable
    // stdin, which a retry cannot fix either.
    case PI_RPC_PROTOCOL_ERROR_CODE:
    // The transport names these two itself, and names them as unretryable: they
    // "both carry `outcomeUnknown`, meaning the command must not be retried
    // blindly". A client told `unknown` is invited to retry exactly the failures
    // the transport forbids retrying, so the disposition is stated rather than
    // left to fall through.
    case PI_RPC_TIMEOUT_CODE:
    case PI_RPC_OUTCOME_UNKNOWN_CODE:
    // The two remaining ways a bounded self-hosted wait can end without a result belong
    // here for the reason just stated, not by analogy: one reports that an executor held
    // the item and never answered, so the effect may already have happened on the
    // operator's machine, and the other reports that the session ended and stopped the
    // work, so no result is wanted at all. Reporting `unknown` for either invites a
    // client to replay precisely what must not be replayed.
    case WORK_OUTCOME_UNKNOWN_CODE:
    case WORK_LEASE_LOST_CODE:
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
    // A model-resolution failure is a configuration fact: the same request
    // cannot succeed until the provider or the agent's model id is corrected,
    // so telling a client to retry it would be wrong in the other direction.
    case MODEL_NOT_FOUND_CODE:
    case MODEL_PROVIDER_NOT_CONFIGURED_CODE:
    case MODEL_CONFIG_INVALID_CODE:
    case MODEL_AUTH_FAILED_CODE:
      return retryStatus('not_retryable');
    // Two transport codes are deliberately absent, and their absence is the
    // decision rather than an omission: `pi_rpc_closed` and
    // `pi_rpc_command_rejected` each cover sub-cases with opposite dispositions,
    // so any value stated here would be wrong for one of them.
    //
    // `pi_rpc_closed` covers both a command refused because the session was
    // already shutting down — which `isBenignCloseError` documents as meaning the
    // session was closing, "not that a command failed" — and a transport that
    // died mid-command, where the outcome may be unknown. The first is resumable
    // in another session, so `not_retryable` would tell a client to abandon work
    // that can still be done; the second may already have run, so `retryable`
    // would invite a duplicate. `pi_rpc_command_rejected` likewise covers a
    // transient refusal and a permanent one: the engine answered and nothing ran,
    // so a resend is always safe, but a refusal the engine will repeat forever
    // makes `retryable` an over-promise.
    //
    // This is the documented meaning of `unknown`, not a fall-through that was
    // never examined: the field exists so a client is not told to give up on work
    // that might succeed (see the doc above), and for a code whose sub-cases
    // disagree the honest answer is that the runtime cannot say. Making these two
    // precise would mean splitting each code so a client can tell a transient
    // refusal from a permanent one, which changes the published error taxonomy
    // and is a product decision rather than a classification one.
    default:
      return retryStatus('unknown');
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
    outcome_id: event.outcome_id,
    description: event.description,
    rubric: event.rubric,
    max_iterations: event.max_iterations,
  };
}

/**
 * Admission-time `outc_` assignment. The published input shape does not accept
 * an id — the server generates it — so a caller's field is replaced rather
 * than honoured: a supplied id would let a client point spans at an outcome
 * the runtime never declared.
 */
function withOutcomeId(
  event: Extract<UserEvent, { type: 'user.define_outcome' }>,
): Extract<UserEvent, { type: 'user.define_outcome' }> {
  return { ...event, outcome_id: `outc_${nanoid(16)}` };
}

/**
 * Resolve the caller's `custom_tool_use_id` to the pending custom tool call it names.
 *
 * The same two-spelling rule as `resolveConfirmedToolUse`, for the other event
 * family: the published contract emits `agent.custom_tool_use`, pauses with the
 * blocking event ids in `stop_reason.event_ids`, and has the client answer with
 * `user.custom_tool_result` passing the **event** id in `custom_tool_use_id`
 * (`会话事件流.md:1876`-`:1877`, `权限策略.md:669`). Local callers and this
 * runtime's own tests answer with the `tool_use` **block** id instead, so both
 * select the call.
 *
 * A custom tool call is not approval-gated — it is parked because the runtime has
 * no executor for it — so there is no `requires_confirmation` to check here. The
 * block id is again what is returned and persisted: `metadata.custom_tool_use_id`
 * is what the model-facing projection pairs this result against, and that
 * projection keys tool results by tool-call id.
 */
function resolveCustomToolUse(
  reference: string,
  events: SessionEvent[],
): { blockId: string } | undefined {
  for (const loggedEvent of events) {
    if (loggedEvent.type !== 'agent.custom_tool_use') continue;
    const block = loggedEvent.content?.find((item) => item.type === 'tool_use') as
      | { type: 'tool_use'; id: string }
      | undefined;
    if (!block) continue;
    // The event id is matched first, so an id that somehow answers to both
    // spellings still resolves deterministically.
    if (loggedEvent.id !== reference && block.id !== reference) continue;
    return { blockId: block.id };
  }
  return undefined;
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

  const target = resolveCustomToolUse(event.custom_tool_use_id, events);

  // The duplicate check is keyed on the canonical block id, so answering the
  // same call twice — including once with each spelling — is refused. It runs
  // before the not-found check so an already-answered call keeps reporting that
  // reason rather than "does not reference a pending custom tool call".
  if (target) {
    for (const loggedEvent of events) {
      if (loggedEvent.type === 'user.custom_tool_result'
        && loggedEvent.metadata?.custom_tool_use_id === target.blockId) {
        throw new Error('Invalid custom tool result: the custom tool call is not pending');
      }
    }
  }

  if (!target) {
    throw new Error('Invalid custom tool result: custom_tool_use_id does not reference a pending custom tool call');
  }

  return {
    custom_tool_use_id: target.blockId,
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
