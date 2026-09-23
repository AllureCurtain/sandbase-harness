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
 * `awaitTurnOutcome()` exactly once per armed turn — `settled` or `failed`. A
 * turn that outlives its deadline fails rather than hanging, and cancels the
 * child rather than leaving a wedged engine holding the workspace and answering
 * the next prompt from the middle of the turn the runtime gave up on.
 */

import type { Writable } from 'node:stream';
import type {
  LoopEngineEventSink,
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
  PI_RPC_DIALOG_UNSUPPORTED_CODE,
  PI_RPC_SESSION_CLOSED_CODE,
  type PiRpcCommand,
} from './rpc-wire.js';
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
 * The runtime ships no extension and relays no question to a client, so an
 * arriving dialog means something inside the child is waiting for a decision
 * that cannot be produced. Guessing a reply would invent a decision; leaving it
 * unanswered would wedge Pi with no visible reason. The turn fails instead.
 */
export class PiRpcDialogUnsupportedError extends Error {
  readonly code = PI_RPC_DIALOG_UNSUPPORTED_CODE;

  constructor(readonly method: string) {
    super(`Pi RPC session received a "${method}" dialog this runtime does not answer; the turn was failed rather than left waiting`);
    this.name = 'PiRpcDialogUnsupportedError';
  }
}

export interface PiRpcSessionOptions {
  sessionId: string;
  workDir: string;
  model: string;
  /** The managed session file, exposed for continuity recording. */
  sessionFile?: string;
  /** The RPC channel to the owned child. */
  stdin: Writable;
  stdout: AsyncIterable<Uint8Array | string>;
  /** Child diagnostics; never authority, and never a grant. */
  stderrTail: () => string;
  /** Terminate the owned child; the launcher owns the escalation ladder. */
  requestInterrupt: () => Promise<void>;
  /** Durable events, live broadcast, usage, and overflow for this session. */
  sink: LoopEngineEventSink;
  /** Per-command response deadline. */
  requestTimeoutMs?: number;
  /** Per-turn deadline; a wedged turn is cancelled rather than left running. */
  turnTimeoutMs?: number;
}

/** How long a cancellation waits for Pi's own `abort` acknowledgement. */
const PI_RPC_ABORT_TIMEOUT_MS = 5_000;

export class PiRpcSession implements LoopEngineSession {
  private readonly options: PiRpcSessionOptions;
  private readonly translator: PiTranslator;
  private readonly transport: PiRpcTransport;
  private outcomePromise: Promise<LoopEngineTurnOutcome> | undefined;
  private resolveOutcome: ((outcome: LoopEngineTurnOutcome) => void) | undefined;
  private turnCounter = 0;
  private turnIdValue: string | undefined;
  private busy = false;
  private closeReason: PiRpcCloseReason | undefined;
  private releasePromise: Promise<void> | undefined;
  private failure: Error | undefined;
  private turnDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PiRpcSessionOptions) {
    this.options = options;
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
    this.busy = false;
    this.clearTurnDeadline();
    resolve(outcome);
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
   * an unsolicited frame on the dialog channel. A blocking dialog cannot be
   * answered at all, because this runtime ships no extension and relays no
   * question to a client, so the turn fails with the reason instead of leaving
   * Pi waiting for a decision nobody can produce.
   *
   * This runs inside the transport's stdout reader, so it must not await a
   * command response — the response would be queued behind the frame being
   * dispatched, and waiting for it would stop the reader that has to deliver it.
   * Closing the child is the strategy's job, from outside the reader.
   */
  private handleUiRequest(request: PiExtensionUiRequest): void {
    if (!request.blocking) return;
    const error = new PiRpcDialogUnsupportedError(request.method);
    this.failure = error;
    this.settle({ kind: 'failed', error });
  }

  private handleTransportClosed(reason: PiRpcCloseReason): void {
    if (this.closeReason) return;
    this.closeReason = reason;
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
