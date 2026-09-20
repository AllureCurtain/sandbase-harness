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
import { EventLogger } from './event-logger.js';
import { eventTypeForStatus, isAbortError } from './session-lifecycle.js';
import { findOrphanedToolUses } from './session-recovery.js';
import { rowToSession, type SessionRow } from './session-records.js';
import { buildSessionUsageSnapshot } from './session-usage.js';
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
import type { UserEvent } from '@/types/cma-protocol.js';
import type { AgentDefinition } from '@/types/agent.js';
import {
  runtimeCapabilityRegistry,
  type RuntimeCapabilityRegistry,
} from '@/core/capabilities/registry.js';
import {
  assertPiAgentCanExecute,
  assertPiEnvironmentCanExecute,
  assertPiUserEventCanExecute,
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
  private executor?: SessionExecutor;
  /** Per-session execution chain — serializes turns so they never overlap. */
  private executionChains = new Map<string, Promise<void>>();
  /** Per-session abort controller for the currently running turn. */
  private abortControllers = new Map<string, AbortController>();

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
    this.assertAgentCapabilities(agentSnapshot.definition);
    if (loopEngine === 'pi') {
      assertPiAgentCanExecute(agentSnapshot.definition);
      assertPiEnvironmentCanExecute(this.resolveEnvironmentSandboxProvider(params.environmentId ?? 'env_default'));
    }

    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, agent_id, agent_name, agent_version, agent_definition, loop_engine,
        environment_id, status, title, context_id, resources, vault_ids, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      agentSnapshot.id,
      agentSnapshot.name,
      agentSnapshot.version,
      params.agentVersion !== undefined ? JSON.stringify(agentSnapshot.definition) : null,
      loopEngine,
      params.environmentId ?? 'env_default',
      params.title ?? null,
      params.contextId ?? null,
      JSON.stringify(params.resources ?? []),
      JSON.stringify(params.vaultIds ?? []),
      params.metadata ? JSON.stringify(params.metadata) : null,
    );

    return {
      id,
      agentId: agentSnapshot.id,
      agentName: agentSnapshot.name,
      agentVersion: agentSnapshot.version,
      agentDefinition: params.agentVersion !== undefined ? agentSnapshot.definition : undefined,
      loopEngine,
      environmentId: params.environmentId ?? 'env_default',
      status: 'queued',
      title: params.title,
      contextId: params.contextId,
      resources: params.resources,
      vaultIds: params.vaultIds,
      metadata: params.metadata,
      createdAt: now,
      updatedAt: now,
    };
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
      metadata: confirmationMetadata,
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
    let requiresAction = false;

    try {
      const running = this.get(sessionId)!;
      for await (const evt of this.executor.execute(running, event, {
        abortSignal: abortController.signal,
        broadcast: (e) => this.broadcast(sessionId, e),
        onRequiresAction: () => {
          requiresAction = true;
        },
      })) {
        this.broadcast(sessionId, evt);
      }
      // Turn finished. If a tool needs confirmation → requires_action;
      // otherwise go idle (paused), awaiting next input.
      const current = this.get(sessionId);
      if (current && current.status === 'running') {
        this.updateStatus(sessionId, requiresAction ? 'requires_action' : 'paused');
      }
    } catch (err) {
      const errorCode = errorCodeOf(err);
      if (errorCode === 'pi_cleanup_pending') {
        const errorEvent = this.eventLogger.append(sessionId, {
          type: 'session.error',
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
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
        });
        this.broadcast(sessionId, errorEvent);
        const current = this.get(sessionId);
        if (current && !isTerminal(current.status)) {
          if (errorCode === 'pi_cleanup_pending') this.updateStatus(sessionId, 'cleanup_pending');
          else if (errorCode === 'pi_timed_out') this.updateStatus(sessionId, 'timed_out');
          else if (errorCode === 'pi_session_busy') this.updateStatus(sessionId, 'paused');
          else this.updateStatus(sessionId, 'failed');
        }
        // A cleanup_pending child may still own the workspace. Never release it
        // based on parent close or a failed taskkill result.
        if (errorCode !== 'pi_cleanup_pending') await this.releaseSandbox(sessionId);
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

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
