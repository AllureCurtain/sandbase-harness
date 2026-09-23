/**
 * Pi RPC session owner.
 *
 * One SandBase session owns one Pi child for as long as it is alive:
 *
 * ```text
 * SandBase session -> one Pi process -> many prompts
 * ```
 *
 * There is deliberately no global process pool. A pool would share one stdin
 * channel between sessions, and stdin is where prompts are written, so pooling
 * would mean sharing one conversation's channel between unrelated sessions.
 *
 * The owner is responsible for everything that must happen *exactly once*:
 *
 * - one stdout reader (in the transport) and one serialized stdin writer, so two
 *   turns cannot interleave bytes on the child's stdin;
 * - one settle transition per armed turn, so a turn cannot complete twice;
 * - one close, so the child and its work directory are released once.
 *
 * Turn model: `prompt()` starts a turn and the owner resolves
 * `awaitTurnOutcome()` exactly once per armed turn — `settled`, `gate`, or
 * `failed`. A turn that outlives its deadline fails rather than hanging, and
 * cancels the child rather than leaving a wedged engine holding the workspace
 * and answering the next prompt from the middle of the turn the runtime gave up
 * on.
 *
 * A `gate` outcome is not the end of the turn. Pi is blocked inside its tool
 * hook, and the same turn continues when `respondToInteraction` writes a
 * decision back, so the session stays busy across a gate and no new prompt can
 * race the suspended one. The gate itself belongs to the SandBase-owned
 * extension this session's launch loaded; the owner's job is to prove it loaded,
 * record what a decision would be made against, and consume that decision once.
 *
 * Who answers a gate is the platform's approval mode, read per gate: a person
 * under `interactive`, or the platform's own rule under `preauthorized_once`.
 * Both answers travel the same one-shot consume, and neither is allowed to
 * authorize a second call.
 */

import type { Writable } from 'node:stream';
import type { ContentBlock } from '@/types/cma-protocol.js';
import type {
  LoopEngineEventSink,
  LoopEnginePendingInteraction,
  LoopEngineSession,
  LoopEngineTurnOutcome,
} from '@/strategy/loop-engine/adapter.js';
import {
  PiRpcClosedError,
  PiRpcTransport,
  type PiExtensionUiRequest,
  type PiRpcCloseReason,
} from './rpc-transport.js';
import {
  parsePiGatePayload,
  validatePiGateDecision,
} from './gate-extension.js';
import {
  PI_GATE_DECISION_ALLOW,
  PI_GATE_DECISION_DENY,
  PI_RPC_DIALOG_UNSUPPORTED_CODE,
  PI_RPC_GATE_LOST_CODE,
  PI_RPC_GATE_UNAVAILABLE_CODE,
  PI_RPC_SESSION_CLOSED_CODE,
  piGateMarkerCommand,
  type PiGateDecisionValue,
  type PiGatePayload,
  type PiRpcCommand,
} from './rpc-wire.js';
import {
  fingerprintPiToolInput,
  type PiInteractionRecord,
  type PiInteractionStore,
} from './interaction-store.js';
import {
  PI_APPROVAL_MODE_DEFAULT,
  type PiApprovalMode,
  type PiPreauthorizedDecision,
  type PiPreauthorizedRule,
} from './approval-mode.js';
import {
  PI_RESUME_REFUSED_MARKER,
  PiContinuityError,
} from './session-continuity.js';
import { PiTimeoutError } from '../pi-launcher.js';
import { PiTranslator } from './translator.js';

/**
 * The owned child is gone, or the turn was written for a session that is not usable.
 */
export class PiRpcSessionClosedError extends Error {
  readonly code = PI_RPC_SESSION_CLOSED_CODE;

  constructor(detail: string) {
    super(`Pi RPC session is not usable: ${detail}`);
    this.name = 'PiRpcSessionClosedError';
  }
}

/**
 * Pi is blocked on a dialog this runtime does not answer.
 *
 * The runtime answers exactly one kind of question — the managed gate's own
 * `editor` dialog — and relays nothing to a client, so any other arriving dialog
 * means something inside the child is waiting for a decision that cannot be
 * produced. Guessing a reply would invent a decision; leaving it unanswered would
 * wedge Pi with no visible reason. The turn fails instead.
 */
export class PiRpcDialogUnsupportedError extends Error {
  readonly code = PI_RPC_DIALOG_UNSUPPORTED_CODE;

  constructor(readonly method: string) {
    super(`Pi RPC session received a "${method}" dialog this runtime does not answer; the turn was failed rather than left waiting`);
    this.name = 'PiRpcDialogUnsupportedError';
  }
}

/**
 * A gated tool reached execution without the gate ever asking for a decision,
 * meaning the tool would have run unguarded.
 *
 * The turn fails rather than reporting success, because a successful report
 * would claim a decision happened that did not.
 */
export class PiRpcGateLostError extends Error {
  readonly code = PI_RPC_GATE_LOST_CODE;

  constructor(readonly toolName: string, readonly toolCallId: string) {
    super(`Pi executed gated tool "${toolName}" (${toolCallId}) without a SandBase gate decision`);
    this.name = 'PiRpcGateLostError';
  }
}

/**
 * The managed gate extension did not load, so a gated call cannot be governed.
 *
 * The launch names the extension explicitly and the session proves it loaded by
 * reading Pi's command list back. Failing the start is the only honest outcome:
 * exposing an `always_ask` tool to a child without the gate would run it with no
 * decision attached.
 */
export class PiRpcGateUnavailableError extends Error {
  readonly code = PI_RPC_GATE_UNAVAILABLE_CODE;

  constructor(readonly marker: string) {
    super(
      `Pi did not load the managed tool gate extension (marker command "${marker}" is absent), so always_ask tools cannot be governed`,
    );
    this.name = 'PiRpcGateUnavailableError';
  }
}

export interface PiRpcSessionOptions {
  sessionId: string;
  workDir: string;
  model: string;
  /** The managed session file, exposed for continuity recording. */
  sessionFile?: string;
  /**
   * Native tool names whose calls must be decided before they execute.
   *
   * Omitted means nothing is gated, which is only safe when the agent declares
   * no `always_ask` native tool: the compiled policy and this list come from the
   * same plan, so a gated tool cannot be exposed without being listed here.
   */
  gateTools?: readonly string[];
  /** The RPC channel to the owned child. */
  stdin: Writable;
  stdout: AsyncIterable<Uint8Array | string>;
  /** Child diagnostics; never authority, and never a grant. */
  stderrTail: () => string;
  /** Terminate the owned child; the launcher owns the escalation ladder. */
  requestInterrupt: () => Promise<void>;
  /** Durable events, live broadcast, usage, and overflow for this session. */
  sink: LoopEngineEventSink;
  /**
   * Durable pending-interaction store.
   *
   * Omitted only when this session gates nothing: the gate's one-shot guarantee
   * lives in this table's conditional update, so a gate that cannot be recorded
   * here is denied rather than opened (see `handleGateRequest`).
   */
  interactions?: PiInteractionStore;
  /**
   * The platform's approval mode for the *next* gate, read when one opens.
   *
   * A function rather than a value because the mode describes how the platform
   * answers the next call, not the session it happens to arrive in: the session
   * re-reads it at every gate instead of copying it into a pending gate or the
   * compiled plan, so a resolver that stops selecting the unattended mode leaves
   * the next gate waiting for a person, and a decision already recorded keeps the
   * source it was recorded with rather than deciding anything again.
   *
   * Omitted means `interactive`, the same as the settings default: unattended
   * operation is never assumed.
   */
  approvalMode?: () => PiApprovalMode;
  /**
   * Platform-owned rule for `preauthorized_once`. Returning `undefined` is the
   * safe answer: the gate then waits for a person instead of deciding, so a
   * call the rule does not name is neither approved nor denied unattended.
   */
  preauthorizedRule?: PiPreauthorizedRule;
  /** Per-command response deadline. */
  requestTimeoutMs?: number;
  /** Per-turn deadline; a wedged turn is cancelled rather than left running. */
  turnTimeoutMs?: number;
}

/** How long a cancellation waits for Pi's own `abort` acknowledgement. */
const PI_RPC_ABORT_TIMEOUT_MS = 5_000;

/** One gate this session opened and has not consumed a decision for yet. */
interface PendingGate {
  piRequestId: string;
  payload: PiGatePayload;
  record: PiInteractionRecord;
  turnId: string;
}

export class PiRpcSession implements LoopEngineSession {
  private readonly options: PiRpcSessionOptions;
  private readonly translator: PiTranslator;
  private readonly transport: PiRpcTransport;
  private readonly interactions: PiInteractionStore | undefined;
  private readonly gateTools: Set<string>;
  private outcomePromise: Promise<LoopEngineTurnOutcome> | undefined;
  private resolveOutcome: ((outcome: LoopEngineTurnOutcome) => void) | undefined;
  private turnCounter = 0;
  private turnIdValue: string | undefined;
  private busy = false;
  private closeReason: PiRpcCloseReason | undefined;
  private releasePromise: Promise<void> | undefined;
  private failure: Error | undefined;
  private turnDeadline: ReturnType<typeof setTimeout> | undefined;
  private pendingGate: PendingGate | undefined;
  /** Gated calls Pi announced, keyed by tool call id, until a gate opens. */
  private readonly deferredGatedCalls = new Map<string, string>();
  /** Gated calls whose gate opened, so their execution is expected, not lost. */
  private readonly gateOpenedCalls = new Set<string>();
  /** Gated calls the gate denied, whose execution frames are therefore noise. */
  private readonly deniedGatedCalls = new Set<string>();

  constructor(options: PiRpcSessionOptions) {
    this.options = options;
    this.interactions = options.interactions;
    this.gateTools = new Set(options.gateTools ?? []);
    this.translator = new PiTranslator({
      sessionId: options.sessionId,
      model: options.model,
      eventLog: options.sink,
      broadcast: (event) => options.sink.broadcast(event),
      recordUsage: (sessionId, tokensIn, tokensOut) => options.sink.recordUsage(sessionId, tokensIn, tokensOut),
      spillToolOutput: (output) => options.sink.spillToolOutput(output),
    });
    this.transport = new PiRpcTransport({
      stdin: options.stdin,
      stdout: options.stdout,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      onEvent: (frame) => this.handleEvent(frame),
      onExtensionUiRequest: (request) => this.handleUiRequest(request),
      onClosed: (reason) => this.handleTransportClosed(reason),
    });
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get turnId(): string | undefined {
    return this.turnIdValue;
  }

  /** False from the moment the child or its transport is gone, for good. */
  get alive(): boolean {
    return this.closeReason === undefined && this.failure === undefined;
  }

  get phase(): 'idle' | 'busy' | 'closed' {
    // A recorded failure closes the session for business even before the child
    // is released: `prompt` refuses from that moment, so reporting `idle` here
    // would describe an engine the runtime will not write to.
    if (this.closeReason || this.failure) return 'closed';
    return this.busy ? 'busy' : 'idle';
  }

  get engineSessionFile(): string | undefined {
    return this.options.sessionFile;
  }

  get stderrTail(): string {
    return this.options.stderrTail();
  }

  /** Why this session stopped being usable, once it is not alive. */
  get failureError(): Error | undefined {
    return this.failure;
  }

  start(): void {
    this.transport.start();
  }

  /**
   * Prove the managed gate extension loaded before a gated tool is exposed.
   *
   * The runtime reads Pi's command list back and looks for the per-session
   * marker command the extension registers. This is empirical rather than
   * assumed, because "the gate is loaded" is the precondition for exposing an
   * `always_ask` tool at all: without it Pi would run that tool with no decision
   * attached, and the approval card a client would render would be theatre.
   *
   * A session that gates nothing probes nothing — there is no gate to prove, and
   * an extra round trip on every start would be a claim about a tool set this
   * session does not have.
   */
  async verifyGateExtension(): Promise<void> {
    if (this.gateTools.size === 0) return;
    const marker = piGateMarkerCommand(this.options.sessionId);
    const response = await this.send('get_commands', {});
    if (!readCommands(response).includes(marker)) throw new PiRpcGateUnavailableError(marker);
  }

  /** The gate awaiting a decision, if any. */
  get pendingGateRequestId(): string | undefined {
    return this.pendingGate?.piRequestId;
  }

  /**
   * Send one prompt and arm the turn.
   *
   * A second prompt while a turn is in flight is refused here as well as being
   * serialized by the transport: the runtime must not hand the child two turns
   * whose frames could interleave, which is what a second `prompt` would do.
   */
  async prompt(text: string): Promise<void> {
    this.assertAlive();
    if (this.busy) throw new PiRpcSessionClosedError('a turn is already in flight');
    this.turnCounter += 1;
    this.turnIdValue = `piturn_${this.turnCounter}`;
    this.busy = true;
    this.deferredGatedCalls.clear();
    this.gateOpenedCalls.clear();
    this.deniedGatedCalls.clear();
    this.armOutcome();
    this.armTurnDeadline();
    try {
      await this.send('prompt', { message: text });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // A prompt Pi refused or never acknowledged leaves the two sides
      // disagreeing about the turn, so the session is closed rather than reused.
      this.failure = failure;
      this.closeReason = this.closeReason ?? { kind: 'closed-by-runtime' };
      this.settle({ kind: 'failed', error: failure });
      throw failure;
    }
  }

  async awaitTurnOutcome(): Promise<LoopEngineTurnOutcome> {
    if (!this.outcomePromise) throw new PiRpcSessionClosedError('no turn is armed');
    return this.outcomePromise;
  }

  /**
   * Resolve the pending gate the decision names.
   *
   * `reference` is either Pi's own dialog request id or the caller-visible
   * `tool_use_id` a `user.tool_confirmation` carries. Accepting both names only
   * widens which identifier *selects* the single pending gate; the one-shot
   * durable consume below still decides whether anything may execute, so a
   * second decision for the same call is refused whichever name it uses.
   *
   * Returns `true` only when this call consumed the pending record. Every other
   * outcome — unknown id, already decided, malformed decision, arguments that
   * are not a plain object — is answered with a denial and reported as `false`,
   * so a replayed or mismatched decision can never execute the call.
   */
  async respondToInteraction(reference: string, response: unknown): Promise<boolean> {
    const interactions = this.interactions;
    if (!interactions) return false;
    const pending = this.findPendingGate(reference);
    if (!pending) return false;
    const requestId = pending.piRequestId;
    // Cleared before anything is written, so a duplicate decision arriving while
    // this one is still in flight finds no gate to consume.
    this.pendingGate = undefined;

    const decision = normalizeApprovalResponse(response);
    const gateDecision = decision && validatePiGateDecision({
      decision: decision.decision,
      ...(decision.input ? { input: decision.input } : {}),
    });
    if (!gateDecision) {
      // Retire the record as a denial: leaving it pending would let a later
      // replay run a call nobody approved, and the arguments an approval carried
      // are never handed to Pi unvalidated.
      this.retirePendingGate('deny', 'the approval response was not a usable decision', 'user', pending);
      await this.respondDecision(requestId, { decision: PI_GATE_DECISION_DENY }).catch(() => {});
      this.armContinuation();
      return false;
    }

    const consumed = interactions.consume({
      sessionId: this.options.sessionId,
      piRequestId: requestId,
      toolUseId: pending.record.toolUseId,
      expectedTurnId: pending.turnId,
      decision: gateDecision.decision,
      source: 'user',
      ...(decision?.denyMessage ? { denyMessage: decision.denyMessage } : {}),
      ...(gateDecision.input ? { decidedInput: gateDecision.input } : {}),
    });
    if (consumed.kind !== 'consumed') {
      // This call no longer owns the record, so the decision may not execute
      // anything. Pi is still blocked, so it is released with a denial and the
      // turn continues rather than hanging on a gate nobody can answer.
      await this.respondDecision(requestId, { decision: PI_GATE_DECISION_DENY }).catch(() => {});
      this.armContinuation();
      return false;
    }

    if (gateDecision.decision === PI_GATE_DECISION_DENY) {
      this.deniedGatedCalls.add(pending.record.toolUseId);
    }
    await this.respondDecision(requestId, gateDecision).catch(() => {});
    this.armContinuation();
    return true;
  }

  /** Cancel the turn in flight, then release the child. Idempotent. */
  async interrupt(): Promise<void> {
    if (!this.releasePromise) this.releasePromise = this.cancelThenRelease();
    return this.releasePromise;
  }

  /** Release the child. Idempotent, and shares one release with `interrupt`. */
  async close(): Promise<void> {
    if (!this.releasePromise) this.releasePromise = this.releaseOnly();
    return this.releasePromise;
  }

  /**
   * Ask Pi to abort the current turn, then hand off to the launcher's
   * TERM/grace/force ladder.
   *
   * The work directory is not released here: the launcher's `wait()` owns that,
   * so an ownership failure such as `pi_cleanup_pending` stays visible to the
   * caller instead of being reported as a clean stop.
   */
  private async cancelThenRelease(): Promise<void> {
    let failure: unknown;
    try {
      await this.send('abort', {}, { timeoutMs: PI_RPC_ABORT_TIMEOUT_MS });
    } catch (error) {
      // A dead transport cannot receive abort, but the launcher still owns the
      // child and must be given the chance to prove its cleanup.
      if (!isBenignCloseError(error)) failure = error;
    }
    try {
      await this.options.requestInterrupt();
    } catch (error) {
      failure = failure ?? error;
    } finally {
      await this.finishClose();
    }
    if (failure) throw failure;
  }

  private async releaseOnly(): Promise<void> {
    let failure: unknown;
    try {
      await this.options.requestInterrupt();
    } catch (error) {
      failure = error;
    } finally {
      await this.finishClose();
    }
    if (failure) throw failure;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Write one command on the RPC channel.
   *
   * Every frame this session writes goes through here, and from here through the
   * transport's single serialized writer, so no two turns can interleave bytes.
   */
  private async send(
    command: PiRpcCommand,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.transport.send(command, payload, options);
  }

  private armOutcome(): void {
    this.outcomePromise = new Promise<LoopEngineTurnOutcome>((resolvePromise) => {
      this.resolveOutcome = resolvePromise;
    });
  }

  private settle(outcome: LoopEngineTurnOutcome): void {
    const resolve = this.resolveOutcome;
    this.resolveOutcome = undefined;
    if (!resolve) return;
    // `gate` leaves the session busy: Pi is suspended inside its tool hook and
    // the same turn resumes when a decision is written back, so a new prompt
    // must still be refused and the deadline must keep running.
    if (outcome.kind !== 'gate') {
      this.busy = false;
      this.clearTurnDeadline();
    }
    resolve(outcome);
  }

  /** Arm the continuation of a turn that a gate suspended. */
  private armContinuation(): void {
    if (this.closeReason || this.failure) return;
    this.busy = true;
    this.armOutcome();
    this.armTurnDeadline();
  }

  private armTurnDeadline(): void {
    this.clearTurnDeadline();
    const timeoutMs = this.options.turnTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return;
    this.turnDeadline = setTimeout(() => {
      if (!this.busy) return;
      // The turn is reported with the launcher's own deadline error, so a turn
      // that ran past its deadline publishes the code the runtime already
      // documents for that outcome (`pi_timed_out`, session status `timed_out`).
      const error = new PiTimeoutError(timeoutMs);
      this.failure = error;
      // A deadline that passes with a gate open is an answer that never arrived:
      // the pending record is retired as a denial before the turn is reported as
      // failed, so a decision arriving afterwards cannot execute the call.
      this.retirePendingGate('deny', 'the turn deadline elapsed while the gate was pending', 'system');
      this.settle({ kind: 'failed', error });
      // Cancelling is part of the deadline, not a side effect: an engine still
      // inside a turn the runtime has given up on holds the workspace and would
      // answer the next prompt from the middle of that turn. The rejection is
      // left on the release promise, so a later `close()` reports a cleanup
      // failure rather than swallowing it.
      void this.interrupt().catch(() => {});
    }, timeoutMs);
  }

  private clearTurnDeadline(): void {
    if (this.turnDeadline) clearTimeout(this.turnDeadline);
    this.turnDeadline = undefined;
  }

  private assertAlive(): void {
    if (!this.alive) {
      throw new PiRpcSessionClosedError(this.failure?.message ?? this.describeCloseReason());
    }
  }

  /**
   * Translate one agent event and watch for the end of the turn.
   *
   * `agent_settled` is the engine's own end-of-turn marker and the only frame
   * that settles a turn as complete. A turn Pi reports an error for settles as
   * `failed` carrying that error, so a turn with a failed model request cannot
   * be reported as a successful one.
   */
  private async handleEvent(frame: Record<string, unknown>): Promise<void> {
    const toolName = typeof frame.toolName === 'string' ? frame.toolName : undefined;
    const toolCallId = typeof frame.toolCallId === 'string' ? frame.toolCallId : undefined;

    if (frame.type === 'tool_execution_start' && toolName && toolCallId && this.gateTools.has(toolName)) {
      // The gate publishes the durable `tool_use` for this call — carrying
      // `requires_confirmation` and the input a decision is made against — so the
      // raw execution frame never does. Which of the two frames Pi sends first is
      // not something this runtime can rely on, so a call is remembered here and
      // recognized as unguarded only if it ends with no gate ever opened for it.
      if (!this.gateOpenedCalls.has(toolCallId)) {
        this.deferredGatedCalls.set(toolCallId, toolName);
        this.translator.noteNativeToolCall();
      }
      return;
    }
    if (frame.type === 'tool_execution_end' && toolCallId) {
      if (this.deniedGatedCalls.delete(toolCallId)) return;
      const deferred = this.deferredGatedCalls.get(toolCallId);
      if (deferred && !this.gateOpenedCalls.has(toolCallId)) {
        const lost = new PiRpcGateLostError(deferred, toolCallId);
        this.failure = lost;
        // No durable tool_use was emitted, because the gate never opened. The
        // failure is represented by `session.error`; appending a result here
        // would create an orphaned tool_result in the replay log.
        this.settle({ kind: 'failed', error: lost });
        return;
      }
    }
    if (frame.type === 'agent_settled') {
      await this.translator.handleEvent(frame);
      const lastTurnError = this.translator.result.lastTurnError;
      this.settle(lastTurnError ? { kind: 'failed', error: new Error(lastTurnError) } : { kind: 'settled' });
      return;
    }
    await this.translator.handleEvent(frame);
  }

  /**
   * Answer a Pi extension UI request.
   *
   * Fire-and-forget notifications are ignored on purpose: answering one would put
   * an unsolicited frame on the dialog channel. A blocking dialog of any other
   * method fails the turn with the reason, because the only question this runtime
   * can answer is its own gate's: Pi's `editor` method is the gate's channel, and
   * the gate denies a payload it does not recognize rather than leaving Pi
   * blocked. Answering anything else would mean inventing a reply for an extension
   * this runtime did not load.
   *
   * This runs inside the transport's stdout reader, so it must not await a
   * command response — the response would be queued behind the frame being
   * dispatched, and waiting for it would stop the reader that has to deliver it.
   * Closing the child is the strategy's job, from outside the reader.
   */
  private handleUiRequest(request: PiExtensionUiRequest): void {
    if (!request.blocking) return;
    if (request.method !== 'editor') {
      const error = new PiRpcDialogUnsupportedError(request.method);
      this.failure = error;
      this.settle({ kind: 'failed', error });
      return;
    }
    // The reader cannot await, so the gate is opened off it: the dialog frame has
    // already been delivered, and the write that answers it is serialized behind
    // every other write on the channel.
    void this.handleGateRequest(request).catch(() => {});
  }

  /**
   * Open the gate for one gated tool call, or deny it.
   *
   * The durable record is written before the caller is told anything, so a
   * decision can only ever be made against something that survives a restart.
   * Everything that makes this call undecidable — an unrecognized payload, a
   * tool this session does not gate, no turn in flight, a second gate while one
   * is already pending — is answered with a denial, because Pi is blocked inside
   * its hook and leaving it blocked stops the engine.
   */
  private async handleGateRequest(request: PiExtensionUiRequest): Promise<void> {
    const payload = parsePiGatePayload(request.prefill);
    const turnId = this.turnIdValue;
    // No durable store means no one-shot record, and no one-shot record means a
    // decision could not be proven to be consumed exactly once. The call is
    // denied instead of opened: a gate that cannot be recorded is not a gate.
    const interactions = this.interactions;
    if (!interactions || !payload || !this.gateTools.has(payload.tool_name) || !this.busy || !turnId) {
      await this.denyGate(request.id);
      return;
    }
    // Only one gate may be pending at a time: the runtime relays one decision per
    // session, and overwriting the in-memory reference would leave Pi suspended
    // on a question no caller can address any more.
    if (this.pendingGate) {
      this.deferredGatedCalls.delete(payload.tool_call_id);
      this.deniedGatedCalls.add(payload.tool_call_id);
      await this.denyGate(request.id);
      return;
    }

    const record = interactions.open({
      sessionId: this.options.sessionId,
      turnId,
      piRequestId: request.id,
      toolUseId: payload.tool_call_id,
      toolName: payload.tool_name,
      input: payload.input,
    });
    // The gate is now what publishes this call, so the deferred marker is
    // replaced by the proof that the call is approvable.
    this.deferredGatedCalls.delete(payload.tool_call_id);
    this.gateOpenedCalls.add(payload.tool_call_id);
    this.translator.noteNativeToolCall();

    // A platform rule answers this call only when the operator selected the
    // unattended mode and the rule names it. Every other case — including a rule
    // that does not cover this tool or this input — falls through to the
    // interactive gate below, because waiting for a person is the one answer
    // that is never wrong: it neither denies what a person could still approve
    // nor approves what no rule named.
    const platformDecision = this.platformDecision(record);
    if (platformDecision) {
      await this.answerAsPlatform(request.id, payload, record, turnId, platformDecision);
      return;
    }

    this.emitGatedToolUse(payload, turnId, { source: 'user' });
    this.pendingGate = { piRequestId: request.id, payload, record, turnId };
    this.settle({
      kind: 'gate',
      interaction: {
        requestId: request.id,
        toolUseId: record.toolUseId,
        toolName: payload.tool_name,
        input: payload.input,
        inputFingerprint: fingerprintPiToolInput(payload.input),
        turnId,
      },
    });
  }

  /**
   * The platform's own answer for one gated call, when the selected mode has one.
   *
   * Returns `undefined` unless the mode is `preauthorized_once` *and* the
   * platform rule names this call, so an interactive session — and a rule that
   * abstains — leaves the decision where it has always been: with a person.
   * The mode is read here, per gate, rather than latched on the session, so
   * turning it off is honored by the very next call instead of by the next
   * session.
   */
  private platformDecision(record: PiInteractionRecord): PiPreauthorizedDecision | undefined {
    const mode: PiApprovalMode = this.options.approvalMode?.() ?? PI_APPROVAL_MODE_DEFAULT;
    if (mode !== 'preauthorized_once') return undefined;
    return this.options.preauthorizedRule?.(record);
  }

  /**
   * Answer one gated call under the platform rule.
   *
   * The platform's decision travels the same one-shot path a human decision
   * does — the conditional update on the durable record is the only thing that
   * authorizes execution — so it applies to exactly this call, is spent by being
   * applied, and authorizes nothing afterwards. It is recorded and published as
   * `platform`, never as `user`: an automatic decision must not be readable as a
   * click by a person. A decision that could not be consumed denies the call
   * instead of executing it.
   */
  private async answerAsPlatform(
    requestId: string,
    payload: PiGatePayload,
    record: PiInteractionRecord,
    turnId: string,
    decision: PiPreauthorizedDecision,
  ): Promise<void> {
    const consumed = this.interactions?.consume({
      sessionId: this.options.sessionId,
      piRequestId: requestId,
      toolUseId: record.toolUseId,
      expectedTurnId: turnId,
      decision: decision.allow ? 'allow' : 'deny',
      source: 'platform',
      ...(decision.allow ? {} : { denyMessage: decision.reason }),
    });
    if (consumed?.kind !== 'consumed') {
      // The record is no longer this gate's to decide — a replayed call, or a row
      // decided elsewhere. Nothing is published for it: the call is denied, and
      // the denial is remembered so its execution frames cannot be read as an
      // approved call that ran.
      this.deniedGatedCalls.add(record.toolUseId);
      await this.denyGate(requestId);
      return;
    }
    if (!decision.allow) this.deniedGatedCalls.add(record.toolUseId);
    this.emitGatedToolUse(payload, turnId, {
      source: 'platform',
      decision: decision.allow ? 'allow' : 'deny',
    });
    await this.respondDecision(requestId, {
      decision: decision.allow ? PI_GATE_DECISION_ALLOW : PI_GATE_DECISION_DENY,
    }).catch(() => {});
  }

  /**
   * Publish the durable tool_use a client renders as an approval card.
   *
   * `source` states who decided, and it is carried in both the content block and
   * the metadata: a platform decision is published with
   * `requires_confirmation: false` and `confirmation_source: "platform"`, so no
   * client can present it as an approval a person gave.
   */
  private emitGatedToolUse(
    payload: PiGatePayload,
    turnId: string,
    decision: { source: 'user' | 'platform'; decision?: 'allow' | 'deny' },
  ): void {
    const groupId = payload.tool_call_id;
    const event = this.options.sink.append(this.options.sessionId, {
      type: 'agent.tool_use',
      content: [{
        type: 'tool_use',
        id: payload.tool_call_id,
        name: payload.tool_name,
        input: payload.input,
        requires_confirmation: decision.source === 'user',
        confirmation_group_id: groupId,
      } as ContentBlock],
      modelUsed: this.options.model,
      metadata: {
        confirmation_group_id: groupId,
        pi_turn_id: turnId,
        input_fingerprint: fingerprintPiToolInput(payload.input),
        confirmation_source: decision.source,
        ...(decision.decision ? { confirmation_decision: decision.decision } : {}),
      },
    });
    this.options.sink.broadcast(event);
  }

  /** The single gate awaiting a decision, matched by either of its two names. */
  private findPendingGate(reference: string): PendingGate | undefined {
    const pending = this.pendingGate;
    if (!pending) return undefined;
    if (pending.piRequestId === reference || pending.record.toolUseId === reference) return pending;
    return undefined;
  }

  /**
   * Retire a gate as decided, so no later decision can consume it.
   *
   * Used for every answer the runtime reaches on its own — a malformed decision,
   * a lost transport, a turn past its deadline — because a gate left pending is a
   * gate a later replay could run a call through. `target` is passed explicitly by
   * a caller that has already cleared `pendingGate`, so a refusal that releases
   * the in-memory gate still leaves the durable row decided.
   */
  private retirePendingGate(
    decision: 'deny',
    reason: string,
    source: 'user' | 'system' = 'user',
    target: PendingGate | undefined = this.pendingGate,
  ): void {
    if (!target) return;
    if (this.pendingGate === target) this.pendingGate = undefined;
    // Retiring is only meaningful where a gate could have been opened, and that
    // requires the store: without one `open` denies, so nothing is left pending.
    this.interactions?.consume({
      sessionId: this.options.sessionId,
      piRequestId: target.piRequestId,
      toolUseId: target.record.toolUseId,
      decision,
      source,
      denyMessage: reason,
    });
  }

  /** Answer a gate with a denial: the only reply that cannot grant a call. */
  private async denyGate(requestId: string): Promise<void> {
    await this.respondDecision(requestId, { decision: PI_GATE_DECISION_DENY }).catch(() => {});
  }

  private async respondDecision(
    requestId: string,
    decision: { decision: PiGateDecisionValue; input?: Record<string, unknown> },
  ): Promise<void> {
    // The gate uses an `editor` dialog, whose response is the JSON string the
    // extension parses back.
    await this.transport.respond(requestId, { value: JSON.stringify(decision) });
  }

  private handleTransportClosed(reason: PiRpcCloseReason): void {
    if (this.closeReason) return;
    this.closeReason = reason;
    // A gate that loses its transport is fail closed: the record is retired as a
    // denial, so no later decision can execute it and the tool never runs.
    this.retirePendingGate('deny', 'the transport closed while the gate was pending', 'system');
    const error = this.failure
      ?? this.resumeRefusal()
      ?? (reason.kind === 'reader-error' ? reason.error : undefined)
      ?? new PiRpcSessionClosedError(this.describeCloseReason());
    this.failure = error;
    // The turn that was in flight fails with the reason the child gave; a later
    // turn cannot be written at all (see `assertAlive`), so a dead child is never
    // reported as a healthy session.
    this.settle({ kind: 'failed', error });
  }

  private async finishClose(): Promise<void> {
    this.handleTransportClosed({ kind: 'closed-by-runtime' });
    await this.transport.close({ kind: 'closed-by-runtime' }).catch(() => {});
  }

  private describeCloseReason(): string {
    const reason = this.closeReason;
    if (!reason) return 'no turn is armed';
    if (reason.kind === 'reader-error') return `Pi RPC reader failed: ${reason.error.message}`;
    if (reason.kind === 'reader-ended') return 'Pi RPC stdout ended';
    return 'closed by the runtime';
  }

  /**
   * A Pi resume refusal, as Pi reports it on stderr.
   *
   * Pi refuses to continue a stored session whose recorded working directory is
   * gone, and reports it as an ordinary stderr line while the child exits
   * immediately. Without this, the operator sees "stdout ended" and cannot tell a
   * refused resume from a crash, which is the case where the distinction decides
   * whether to repair the binding or to investigate a bug.
   */
  private resumeRefusal(): Error | undefined {
    const tail = this.options.stderrTail();
    if (!tail.includes(PI_RESUME_REFUSED_MARKER)) return undefined;
    return new PiContinuityError(
      'pi_resume_refused',
      `Pi refused to resume the stored session: ${tail}`,
    );
  }
}

/** Errors that mean the session was already closing, not that a command failed. */
function isBenignCloseError(error: unknown): boolean {
  return error instanceof PiRpcClosedError
    || (error instanceof Error && error.name === 'AbortError');
}

/**
 * Command names Pi reported, from a `get_commands` response.
 *
 * An absent or malformed list reads as "nothing was advertised" rather than
 * throwing: the caller's question is whether the marker command is present, and
 * a response that does not carry one answers it.
 */
function readCommands(response: Record<string, unknown>): string[] {
  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const commands = (data as Record<string, unknown>).commands;
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const name = (entry as Record<string, unknown>).name;
    return typeof name === 'string' ? [name] : [];
  });
}

/**
 * Normalize a caller's decision.
 *
 * Accepts the CMA `allow`/`deny` spelling so a caller does not have to
 * translate, and rejects anything else rather than coercing it. Replacement
 * arguments are carried through only when they are a plain object; the gate
 * reply is the last place the runtime can refuse them, because Pi re-validates
 * nothing after an extension mutates `event.input`.
 */
function normalizeApprovalResponse(response: unknown): {
  decision: 'allow' | 'deny';
  input?: Record<string, unknown>;
  denyMessage?: string;
} | undefined {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const record = response as Record<string, unknown>;
  const raw = record.decision ?? record.result;
  if (raw !== PI_GATE_DECISION_ALLOW && raw !== PI_GATE_DECISION_DENY) return undefined;
  const denyMessage = typeof record.denyMessage === 'string'
    ? record.denyMessage
    : typeof record.deny_message === 'string' ? record.deny_message : undefined;
  const candidate = record.input !== undefined ? record.input : record.updatedInput;
  if (candidate === undefined) return { decision: raw, ...(denyMessage ? { denyMessage } : {}) };
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  return {
    decision: raw,
    input: candidate as Record<string, unknown>,
    ...(denyMessage ? { denyMessage } : {}),
  };
}
