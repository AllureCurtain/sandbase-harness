/**
 * Pi loop-engine strategy.
 *
 * This is the Harness half of the Pi boundary. It owns one Pi RPC session per
 * SandBase session:
 *
 * ```text
 * SandBase session -> one Pi child -> many prompts
 * ```
 *
 * There is no global process pool, and that is a policy decision rather than an
 * optimisation one: a pool would share one stdin channel between sessions, and
 * stdin is where prompts are written, so pooling would mean sharing one
 * conversation's channel between unrelated sessions.
 *
 * Turn model. `execute()` is called once per user event by the executor. It
 * resolves the live session — starting one only when there is none — and then:
 *
 * - `user.message` → `prompt()`, then wait for the turn outcome;
 * - `user.tool_confirmation` → settle the gate the previous turn suspended on,
 *   then wait for that same turn to continue.
 *
 * `settled` publishes the terminal `turn_complete`; `failed` propagates so the
 * Session Manager records a `session.error` carrying the engine's own reason. A
 * `gate` outcome is neither: Pi is blocked inside its tool hook, the turn
 * continues when a decision is written back, so the session is reported as
 * needing an action and no `turn_complete` is published for it.
 *
 * The child is released in exactly one place that owns it: `disposeSession`,
 * called by the executor on a terminal session state, so stop, delete, and
 * close all take the same path and none of them can leave an orphan holding the
 * session work directory.
 */

import type { ContentBlock, TextBlock } from '@/types/cma-protocol.js';
import type { Database } from '@/core/db/database.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { AgentStrategy, EventLogWriter, StrategyContext } from '@/types/strategy.js';
import type {
  LoopEngineEventSink,
  LoopEngineSession,
  LoopEngineStartRequest,
  LoopEngineSteerInput,
  LoopEngineSteerReceipt,
  LoopEngineSteering,
  LoopEngineTurnOutcome,
} from '@/strategy/loop-engine/adapter.js';
import { compilePiNativeToolPolicy, type PiNativeToolPlan } from '@/core/session/pi-native-tools.js';
import { PI_RPC_APPROVAL_NOT_PENDING_CODE } from './pi/rpc-wire.js';
import {
  getPiSessionState,
  inspectPiSessionFile,
  markPiSessionContinuityFailure,
  recordPiSessionState,
  PiContinuityError,
} from './pi/session-continuity.js';
import { spillToolOutput } from '@/core/session/tool-output-overflow.js';

/**
 * A `user.tool_confirmation` named a gate this runtime was not waiting on.
 *
 * Refusing is the only safe reading: the durable pending record is the sole
 * authority for executing a gated tool, so a decision that could not be recorded
 * must not be reported as one that took effect.
 */
export class PiApprovalNotPendingError extends Error {
  readonly code = PI_RPC_APPROVAL_NOT_PENDING_CODE;

  constructor(readonly toolUseId: string) {
    super(`No Pi gate is awaiting a decision for tool use "${toolUseId}"`);
    this.name = 'PiApprovalNotPendingError';
  }
}

/**
 * The adapter surface the strategy calls.
 *
 * Narrowed to `startSession` — the only method the strategy uses — so a test can
 * drive the whole turn loop with a scripted session and no child process.
 */
export interface PiSessionStarter {
  startSession(request: LoopEngineStartRequest): Promise<LoopEngineSession>;
}

export interface PiStrategyOptions {
  /** The adapter that owns the Pi child's protocol and its argv. */
  adapter: PiSessionStarter;
  /** Durable continuity state; an embedder without a database passes none. */
  database?: Database;
}

/**
 * Pi strategy over a session-owned RPC child.
 *
 * `requiresModel` stays false: Pi owns model transport, so the executor must not
 * construct an AI SDK model for it.
 */
export class PiStrategy implements AgentStrategy, LoopEngineSteering {
  readonly name = 'pi';
  readonly requiresModel = false;
  /** The one child each SandBase session owns, by session id. */
  private readonly sessions = new Map<string, LoopEngineSession>();

  constructor(private readonly options: PiStrategyOptions) {}

  async *execute(context: StrategyContext) {
    if (!context.sandbox.hostWorkDir) {
      throw new Error('Pi loop engine requires a sandbox with a host-accessible work directory');
    }
    const event = context.userEvent;
    // The two turns this engine can express, resolved before a child is spawned:
    // a non-text message, or an event with no Pi transport behind it, is refused
    // without starting a process the runtime would then have to tear down.
    const turn = event.type === 'user.message'
      ? { kind: 'message' as const, prompt: requireTextPrompt(event.content) }
      : event.type === 'user.tool_confirmation'
        ? {
          kind: 'confirmation' as const,
          toolUseId: event.tool_use_id,
          result: event.result,
          ...(event.deny_message !== undefined ? { denyMessage: event.deny_message } : {}),
        }
        : undefined;
    if (!turn) {
      throw new Error(`Pi loop engine cannot execute a "${event.type}" turn`);
    }
    if (!context.modelConfig) {
      throw new Error('Pi loop engine requires a selected model configuration');
    }

    const workDir = context.sandbox.hostWorkDir;
    // The same compiler admission ran, so the flags sent are the ones checked.
    const plan = compilePiNativeToolPolicy(requireAgentDefinition(context));
    const session = await this.resolveSession(context, plan, workDir);

    try {
      if (turn.kind === 'confirmation') {
        // A decision is written back to the session that is still blocked inside
        // its tool hook. `false` means this call did not consume the pending
        // record — unknown id, already decided, mismatched or malformed — so the
        // decision may not be reported as one that took effect.
        const consumed = await session.respondToInteraction(turn.toolUseId, {
          decision: turn.result,
          ...(turn.denyMessage !== undefined ? { denyMessage: turn.denyMessage } : {}),
        });
        if (!consumed) throw new PiApprovalNotPendingError(turn.toolUseId);
      } else {
        await session.prompt(turn.prompt);
      }

      const outcome = await this.turnOutcome(session, context.abortSignal);
      if (outcome.kind === 'gate') {
        // Not a finished turn: Pi is suspended inside its tool hook and this same
        // turn continues when a decision arrives. The session must say it needs
        // one — a gate nobody is told about is a gate nobody answers — and no
        // terminal marker may be published for a turn that is still open.
        context.config.onRequiresAction?.();
        return;
      }
      if (outcome.kind === 'failed') throw outcome.error;

      // Continuity is recorded before the terminal marker, never after: a
      // `turn_complete` claims the turn is finished, and a turn whose managed
      // session file does not prove continuity is not a finished turn.
      this.persistContinuity(session, workDir);

      // Order matters: refuse new steers, then let the ones already accepted
      // finish settling, and only then publish the terminal marker. A client that
      // sees `turn_complete` must never afterwards watch a steer land in the turn
      // it just saw finish.
      session.closeSteerAdmission();
      await session.settleSteerReceipts();

      // `turn_complete` is the durable adapter terminal marker. It is appended
      // after every agent event the turn produced, and never yielded separately
      // — a yielded durable event would be broadcast a second time.
      const terminal = context.eventLog.append(context.session.id, { type: 'turn_complete' });
      context.broadcast(terminal);
    } catch (error) {
      throw await this.failTurn(session, error);
    }
  }

  /**
   * Deliver one steer to the live session this strategy already owns.
   *
   * `undefined` when there is no live session for the id: the request never
   * reached an engine, so the caller reports a refusal rather than a delivery,
   * and nothing is buffered for a later turn — the turn the caller aimed at is
   * the only one the instruction means anything to. The session's own admission
   * and ledger decide everything else, including a steer for a turn that has
   * already closed admission.
   */
  async steerSession(sessionId: string, input: LoopEngineSteerInput): Promise<LoopEngineSteerReceipt | undefined> {
    const session = this.liveSession(sessionId);
    if (!session) return undefined;
    return session.steer(input);
  }

  /**
   * Close and release the engine session this SandBase session owns.
   *
   * One owner for the child does not mean one caller that could forget it:
   * `close()` is idempotent, so the executor's terminal-state cleanup, a failed
   * turn, and an explicit stop can all call this without racing each other. A
   * cleanup failure (for example `pi_cleanup_pending`) is rethrown rather than
   * swallowed, because the workspace is still held by an unconfirmed child.
   */
  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await session.close();
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  /** Test and diagnostic view of the sessions this strategy currently owns. */
  liveSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Reuse the live session for this SandBase session, or start one.
   *
   * A dead session is never reused: its child is gone, its transport is closed,
   * and a prompt into it would be written to nobody while the runtime reported a
   * healthy turn. It is also never silently replaced inside a turn — the next
   * turn starts a fresh child through the launcher, which re-proves continuity
   * for the same managed session file.
   */
  private async resolveSession(
    context: StrategyContext,
    plan: PiNativeToolPlan,
    workDir: string,
  ): Promise<LoopEngineSession> {
    const existing = this.liveSession(context.session.id);
    if (existing) return existing;

    const model = context.modelConfig;
    if (!model) throw new Error('Pi loop engine requires a selected model configuration');
    // Resolved again inside the launcher; checked here so a missing id or key
    // fails before a child is spawned rather than after a doomed launch.
    if (!model.model?.trim()) throw new Error('Pi loop engine requires a selected model id');
    if (!model.api_key?.trim()) throw new Error('Pi loop engine requires a resolved model API key');

    const thinkingLevel = thinkingLevelForSpeed(context.session.agentDefinition?.model_config?.speed);
    const request: LoopEngineStartRequest = {
      sessionId: context.session.id,
      workDir,
      systemPrompt: context.systemPrompt,
      model: {
        provider: model.provider,
        model: model.model,
        api_key: model.api_key,
        ...(model.base_url ? { base_url: model.base_url } : {}),
      },
      // The compiled plan travels as Pi's own flags, so nothing here can widen
      // or re-derive what admission checked. The gated names travel beside them
      // because they are part of the same compiled policy: the launch loads the
      // managed gate extension for exactly the tools whose calls need a decision.
      toolPlan: {
        flags: plan.argv,
        ...(plan.gate.length ? { gate: plan.gate } : {}),
      },
      ...(context.skillDirs?.length ? { skillDirs: context.skillDirs } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // The child is started once, so only the first turn's signal can reach the
      // launcher; every later turn's interrupt is delivered by `turnOutcome`.
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
      sink: this.sinkFor(context),
    };

    const session = await this.options.adapter.startSession(request);
    this.sessions.set(context.session.id, session);
    return session;
  }

  /**
   * Wait for the turn outcome, stopping the child when the turn is aborted.
   *
   * A session-owned child outlives a turn, so an interrupt has to reach the
   * process and not only the promise this strategy is waiting on: closing the
   * session is what makes `user.interrupt` a stop, instead of a turn the runtime
   * walked away from while Pi kept working on it.
   */
  private async turnOutcome(
    session: LoopEngineSession,
    abortSignal: AbortSignal | undefined,
  ): Promise<LoopEngineTurnOutcome> {
    const outcome = session.awaitTurnOutcome();
    if (!abortSignal) return outcome;
    if (abortSignal.aborted) return this.abortTurn(session);

    return new Promise<LoopEngineTurnOutcome>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        void this.abortTurn(session).then(resolvePromise, rejectPromise);
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      outcome.then(
        (settled) => {
          abortSignal.removeEventListener('abort', onAbort);
          resolvePromise(settled);
        },
        (error) => {
          abortSignal.removeEventListener('abort', onAbort);
          rejectPromise(error);
        },
      );
    });
  }

  private async abortTurn(session: LoopEngineSession): Promise<never> {
    // A cleanup failure takes precedence over the abort: the workspace is held
    // by a child whose termination was not confirmed, and reporting `cancelled`
    // there would claim a release that did not happen.
    await session.interrupt();
    throw piAbortError();
  }

  /**
   * Fail the turn, releasing the child first.
   *
   * The child is closed while the ownership handle is still registered, so a
   * wedged engine cannot be left holding the session work directory. A
   * cleanup-pending failure takes precedence over the engine error, because the
   * workspace is unsafe to reuse until the process tree is confirmed gone.
   */
  private async failTurn(session: LoopEngineSession, error: unknown): Promise<Error> {
    let cleanupError: unknown;
    try {
      await session.close();
    } catch (closeError) {
      cleanupError = closeError;
    }
    if (!cleanupError) this.sessions.delete(session.sessionId);
    if (cleanupError) return asError(cleanupError);

    const failure = asError(error);
    if (failure.name === 'AbortError') return failure;
    this.recordContinuityFailure(session, failure);
    if (failure instanceof PiContinuityError) return failure;
    return withStderr(failure, session.stderrTail);
  }

  /**
   * Record the Pi session's own identity so a later launch can prove it is the
   * same conversation before continuing it.
   *
   * A missing header after a settled turn is a real discontinuity rather than a
   * detail to skip past, and a changed identity means the durable events would
   * describe a conversation the child is no longer in.
   */
  private persistContinuity(session: LoopEngineSession, workDir: string): void {
    const database = this.options.database;
    const sessionFile = session.engineSessionFile;
    if (!database || !sessionFile) return;
    const header = inspectPiSessionFile(sessionFile);
    if (!header) {
      throw new PiContinuityError('pi_session_discontinuous', 'Pi completed without writing a session header');
    }
    const previous = getPiSessionState(database, session.sessionId);
    if (previous && (previous.piSessionId !== header.id || previous.schemaVersion !== header.schemaVersion)) {
      throw new PiContinuityError('pi_session_discontinuous', 'Pi changed its session identity or schema during the turn');
    }
    // The work directory is not part of the recorded binding: the managed
    // session file lives in the runtime data directory, so a turn on a
    // different workspace cannot silently continue a stored conversation
    // through a path this record would have to police.
    void workDir;
    recordPiSessionState(database, session.sessionId, sessionFile, header);
  }

  /**
   * Record a continuity failure so a later launch cannot silently fork.
   *
   * Only continuity errors are recorded. An ordinary model or tool failure
   * leaves the stored session perfectly valid, and marking it would refuse a
   * legitimate resume — turning a transient provider error into permanent
   * damage. A refusal has to be durable, though, because the next launch reads
   * this state, and a refusal that lives only in a log is one the operator has
   * to rediscover.
   */
  private recordContinuityFailure(session: LoopEngineSession, error: Error): void {
    const database = this.options.database;
    const sessionFile = session.engineSessionFile;
    if (!database || !sessionFile || !(error instanceof PiContinuityError)) return;
    markPiSessionContinuityFailure(database, session.sessionId, sessionFile, error.code, error.message);
  }

  /** Return a live owned session, pruning one whose child already died. */
  private liveSession(sessionId: string): LoopEngineSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.alive) return session;
    this.sessions.delete(sessionId);
    return undefined;
  }

  /**
   * The engine-neutral output surface.
   *
   * `spillToolOutput` closes over this turn's sandbox so an oversized Pi tool
   * result goes through exactly the same overflow contract the builtin strategy
   * uses, and the path the model is told about is one it can read back.
   */
  private sinkFor(context: StrategyContext): LoopEngineEventSink {
    const sessionId = context.session.id;
    const eventLog: EventLogWriter = context.eventLog;
    return {
      append: (target, event) => eventLog.append(target, event),
      getLatestSeq: (target) => eventLog.getLatestSeq(target),
      recordUsage: (target, tokensIn, tokensOut) => eventLog.recordUsage(target, tokensIn, tokensOut),
      broadcast: (event) => context.broadcast(event),
      spillToolOutput: async (output) => {
        const spill = await spillToolOutput(output, { sessionId, sandbox: context.sandbox });
        return spill.preview;
      },
    };
  }
}

/**
 * The definition whose policy the launch must express.
 *
 * A Pi session freezes its own agent definition when it is created, and that is
 * what admission compiled, so this is the definition the flags come from. There
 * is deliberately no fallback: without it the runtime cannot say which tool set
 * it is allowed to expose, and guessing would be the widening the compiler exists
 * to prevent.
 */
function requireAgentDefinition(context: StrategyContext): AgentDefinition {
  const definition = context.session.agentDefinition;
  if (!definition) {
    throw new Error('Pi loop engine requires the session agent definition to express its tool policy');
  }
  return definition;
}

/**
 * The prompt text of a `user.message` turn, or a refusal.
 *
 * Pi's RPC `prompt` carries text, so a message with any other block is refused
 * rather than flattened to whatever happens to be text.
 */
function requireTextPrompt(content: readonly ContentBlock[]): string {
  if (!content.every((block): block is TextBlock => block.type === 'text')) {
    throw new Error('Pi loop engine supports text user messages only');
  }
  return content.map((block) => block.text).join('\n');
}

function thinkingLevelForSpeed(speed: string | undefined): LoopEngineStartRequest['thinkingLevel'] {
  switch (speed) {
    case 'fast': return 'off';
    case 'extended': return 'high';
    case 'standard': return 'medium';
    default: return undefined;
  }
}

/**
 * The engine's reason, with its stderr tail attached.
 *
 * The tail is diagnostics only — it never carries authority — but without it a
 * Pi startup or resume failure is reported as a bare exit code, which is the one
 * case where the operator has nothing to act on.
 */
function withStderr(error: Error, tail: string): Error {
  if (!tail || error.message.includes(tail)) return error;
  const enriched = new Error(`${error.message}; Pi stderr: ${tail}`);
  enriched.name = error.name;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string') (enriched as Error & { code: string }).code = code;
  return enriched;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * An aborted turn, shaped like the launcher's own abort.
 *
 * `user.interrupt` is a control-plane event, and the Session Manager decides
 * between `cancelled` and `failed` from this name, so it is not decoration.
 */
function piAbortError(): Error {
  const error = new Error('Pi RPC turn aborted');
  error.name = 'AbortError';
  return error;
}
