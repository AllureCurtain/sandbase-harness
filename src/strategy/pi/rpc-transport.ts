/**
 * Pi RPC transport.
 *
 * One stdout reader, one serialized stdin writer, and a demultiplexer that
 * separates the three things Pi interleaves on stdout:
 *
 * 1. `response` frames — the settlement of a command this runtime wrote;
 * 2. `extension_ui_request` frames — a blocking question from an extension;
 * 3. agent events — everything else.
 *
 * Design constraints this file exists to hold:
 *
 * - **Framing is bytes.** Pi splits UTF-8 across chunks and forbids treating
 *   Unicode separators as newlines, so the reader reuses the print-mode JSONL
 *   reader instead of `readline`.
 * - **No frame grants authority before it is validated.** A frame that is not a
 *   JSON object with a string `type` is a protocol error, not an event.
 * - **A response is inert unless it settles a pending request.** Pi emits
 *   id-less responses for parse failures; those are diagnostics. An unmatched
 *   response never resolves a pending command, so it can never turn a timed-out
 *   write into an apparent success.
 * - **Unknown outcomes are terminal.** A command whose response never arrives
 *   resolved to `outcome_unknown`; the caller must not replay it, because the
 *   engine may already have acted on it.
 */

import type { Writable } from 'node:stream';
import { readPiJsonl } from './jsonl-reader.js';
import {
  PI_RPC_CLOSED_CODE,
  PI_RPC_COMMAND_REJECTED_CODE,
  PI_RPC_MAX_FRAME_BYTES,
  PI_RPC_OUTCOME_UNKNOWN_CODE,
  PI_RPC_PROTOCOL_ERROR_CODE,
  PI_RPC_RECORD_DELIMITER,
  PI_RPC_TIMEOUT_CODE,
  isPiDialogUiMethod,
} from './rpc-wire.js';

export class PiRpcError extends Error {
  readonly code: string;

  constructor(name: string, code: string, message: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

/** A frame could not be trusted as a documented Pi frame. */
export class PiRpcProtocolError extends PiRpcError {
  constructor(message: string) {
    super('PiRpcProtocolError', PI_RPC_PROTOCOL_ERROR_CODE, message);
  }
}

/** A command was written but its response did not arrive in time. */
export class PiRpcTimeoutError extends PiRpcError {
  /** The write already left this process, so the engine may have acted on it. */
  readonly outcomeUnknown = true;

  constructor(readonly command: string, readonly timeoutMs: number) {
    super(
      'PiRpcTimeoutError',
      PI_RPC_TIMEOUT_CODE,
      `Pi RPC command "${command}" did not respond within ${timeoutMs}ms`,
    );
  }
}

/** A command was written and the transport could not confirm its outcome. */
export class PiRpcOutcomeUnknownError extends PiRpcError {
  readonly outcomeUnknown = true;

  constructor(readonly command: string, detail: string) {
    super(
      'PiRpcOutcomeUnknownError',
      PI_RPC_OUTCOME_UNKNOWN_CODE,
      `Pi RPC command "${command}" outcome is unknown: ${detail}`,
    );
  }
}

/** The transport is closed, or closed before the command could be written. */
export class PiRpcClosedError extends PiRpcError {
  constructor(detail: string) {
    super('PiRpcClosedError', PI_RPC_CLOSED_CODE, `Pi RPC transport is closed: ${detail}`);
  }
}

/** Pi answered `success: false`. The outcome is known: the command was refused. */
export class PiRpcCommandRejectedError extends PiRpcError {
  constructor(readonly command: string, readonly detail: string) {
    super('PiRpcCommandRejectedError', PI_RPC_COMMAND_REJECTED_CODE, `Pi RPC command "${command}" was rejected: ${detail}`);
  }
}

export interface PiExtensionUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  /** `editor` carries its prefilled body here rather than in `message`. */
  prefill?: string;
  options?: string[];
  /** True for methods Pi blocks on until a response arrives. */
  blocking: boolean;
  raw: Record<string, unknown>;
}

export type PiRpcCloseReason =
  | { kind: 'reader-ended' }
  | { kind: 'reader-error'; error: Error }
  | { kind: 'closed-by-runtime' };

export interface PiRpcTransportOptions {
  stdin: Writable;
  stdout: AsyncIterable<Uint8Array | string>;
  /** Engine events, excluding responses and extension UI requests. */
  onEvent: (frame: Record<string, unknown>) => void | Promise<void>;
  /**
   * A blocking or fire-and-forget extension UI request. A blocking request must
   * always be answered — by a decision or by a cancellation — or Pi stops.
   */
  onExtensionUiRequest: (request: PiExtensionUiRequest) => void | Promise<void>;
  onClosed: (reason: PiRpcCloseReason) => void;
  maxFrameBytes?: number;
  /** Default per-command response deadline. */
  requestTimeoutMs?: number;
}

interface PendingCommand {
  command: string;
  resolve: (frame: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export const PI_RPC_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class PiRpcTransport {
  private readonly stdin: Writable;
  private readonly stdout: AsyncIterable<Uint8Array | string>;
  private readonly options: PiRpcTransportOptions;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly maxFrameBytes: number;
  private requestCounter = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private readerPromise: Promise<void> | undefined;
  private closeReason: PiRpcCloseReason | undefined;
  private frameCount = 0;

  constructor(options: PiRpcTransportOptions) {
    if (!options.stdin) throw new PiRpcProtocolError('Pi RPC transport requires a writable stdin');
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.options = options;
    this.maxFrameBytes = options.maxFrameBytes ?? PI_RPC_MAX_FRAME_BYTES;
  }

  get closed(): boolean {
    return this.closeReason !== undefined;
  }

  get framesRead(): number {
    return this.frameCount;
  }

  /** Begin consuming stdout. Idempotent. */
  start(): void {
    if (this.readerPromise) return;
    this.readerPromise = this.readLoop().catch(() => {
      // `readLoop` reports every failure through onClosed; this catch only
      // stops the rejection from becoming an unhandled promise rejection.
    });
  }

  /** Resolves once the reader has stopped, for deterministic test teardown. */
  async waitForReader(): Promise<void> {
    await this.readerPromise;
  }

  /**
   * Write one command and await its correlated response.
   *
   * The rejection type is part of the contract: `PiRpcTimeoutError` and
   * `PiRpcOutcomeUnknownError` both carry `outcomeUnknown`, meaning the command
   * must not be retried blindly.
   */
  async send(
    command: string,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    if (this.closeReason) throw new PiRpcClosedError(this.describeClose());
    const id = `sb-${++this.requestCounter}`;
    const frame = { ...payload, id, type: command };
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? PI_RPC_DEFAULT_REQUEST_TIMEOUT_MS;

    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new PiRpcTimeoutError(command, timeoutMs));
        }, timeoutMs)
        : undefined;
      if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.pending.set(id, { command, resolve, reject, timer });
    });

    try {
      await this.write(`${JSON.stringify(frame)}${PI_RPC_RECORD_DELIMITER}`);
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
      }
      // The bytes may or may not have reached the engine: this is unknown, not
      // a clean failure, and the caller must not retry the command.
      throw new PiRpcOutcomeUnknownError(command, error instanceof Error ? error.message : String(error));
    }

    const settled = await response;
    if (settled.success === false) {
      throw new PiRpcCommandRejectedError(command, extractErrorText(settled));
    }
    return settled;
  }

  /**
   * Answer one extension UI request.
   *
   * This is deliberately *not* `send()`. An `extension_ui_response` is a reply
   * on the dialog sub-protocol, not a command: Pi documents that it resolves the
   * open dialog and emits no `response` frame for it. Routing it through
   * `send()` would therefore make every answer wait out the full response
   * deadline and then report a timeout for a dialog that was in fact answered.
   *
   * Pi correlates a dialog reply by the *request* id, so the frame carries
   * `id: requestId` and never a fresh command id — a new id would leave the
   * engine waiting on a dialog nobody ever answers.
   *
   * The caller is responsible for having validated the decision. This method
   * guarantees exactly one write per call and a truthful rejection type.
   */
  async respond(requestId: string, body: Record<string, unknown>): Promise<void> {
    if (this.closeReason) throw new PiRpcClosedError(this.describeClose());
    await this.write(`${JSON.stringify({ id: requestId, type: 'extension_ui_response', ...body })}${PI_RPC_RECORD_DELIMITER}`);
  }

  /** Stop reading and settle every pending command. Safe to call repeatedly. */
  async close(reason: PiRpcCloseReason = { kind: 'closed-by-runtime' }): Promise<void> {
    if (this.closeReason) return;
    this.closeReason = reason;
    const pending = [...this.pending.values()];
    this.pending.clear();
    const closeError = reason.kind === 'reader-error'
      ? reason.error
      : undefined;
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(closeError ?? new PiRpcClosedError(`${entry.command}: transport closed before its response arrived`));
    }
    this.options.onClosed(reason);
    await this.writeChain.catch(() => {});
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of readPiJsonl(this.stdout, this.maxFrameBytes)) {
        if (this.closeReason) return;
        const trimmed = line.trim();
        // A non-JSON diagnostic line cannot carry authority, so it is dropped;
        // a malformed JSON object is a different thing and fails closed below.
        if (!trimmed.startsWith('{')) continue;
        this.frameCount += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new PiRpcProtocolError(`Pi RPC frame ${this.frameCount} is not valid JSON`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new PiRpcProtocolError(`Pi RPC frame ${this.frameCount} must be a JSON object`);
        }
        const frame = parsed as Record<string, unknown>;
        if (typeof frame.type !== 'string' || frame.type.length === 0) {
          throw new PiRpcProtocolError(`Pi RPC frame ${this.frameCount} is missing a string type`);
        }
        await this.dispatch(frame);
      }
      await this.close({ kind: 'reader-ended' });
    } catch (error) {
      const failure = error instanceof PiRpcError
        ? error
        : new PiRpcProtocolError(error instanceof Error ? error.message : String(error));
      await this.close({ kind: 'reader-error', error: failure });
    }
  }

  private async dispatch(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'response') {
      this.settleResponse(frame);
      return;
    }
    if (frame.type === 'extension_ui_request') {
      const request = normalizeUiRequest(frame);
      if (!request) {
        // An unparseable blocking request would otherwise hang Pi forever. The
        // caller owns Pi's fate, so report a protocol error instead of dropping it.
        throw new PiRpcProtocolError(`Pi RPC frame ${this.frameCount} has an invalid extension_ui_request`);
      }
      await this.options.onExtensionUiRequest(request);
      return;
    }
    await this.options.onEvent(frame);
  }

  private settleResponse(frame: Record<string, unknown>): void {
    const id = typeof frame.id === 'string' && frame.id.length > 0 ? frame.id : undefined;
    if (!id) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(frame);
  }

  private write(line: string): Promise<void> {
    const next = this.writeChain.then(() => new Promise<void>((resolve, reject) => {
      try {
        this.stdin.write(line, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    }));
    // Keep the chain alive after a failed write so later writes still serialize.
    this.writeChain = next.catch(() => {});
    return next;
  }

  private describeClose(): string {
    const reason = this.closeReason;
    if (!reason) return 'not closed';
    if (reason.kind === 'reader-error') return `reader failed: ${reason.error.message}`;
    if (reason.kind === 'reader-ended') return 'stdout ended';
    return 'closed by runtime';
  }
}

function normalizeUiRequest(frame: Record<string, unknown>): PiExtensionUiRequest | undefined {
  const id = typeof frame.id === 'string' && frame.id.length > 0 ? frame.id : undefined;
  const method = typeof frame.method === 'string' && frame.method.length > 0 ? frame.method : undefined;
  if (!id || !method) return undefined;
  const options = Array.isArray(frame.options)
    ? frame.options.filter((value): value is string => typeof value === 'string')
    : undefined;
  return {
    id,
    method,
    ...(typeof frame.title === 'string' ? { title: frame.title } : {}),
    ...(typeof frame.message === 'string' ? { message: frame.message } : {}),
    // `editor` carries its prefilled body here rather than in `message`, and
    // that body is where the managed gate puts its structured payload. Dropping
    // it would make every gated call look like an unparseable request, which
    // this runtime answers with a denial — so the gate would appear to work
    // while refusing everything.
    ...(typeof frame.prefill === 'string' ? { prefill: frame.prefill } : {}),
    ...(options ? { options } : {}),
    blocking: isPiDialogUiMethod(method),
    raw: frame,
  };
}

function extractErrorText(frame: Record<string, unknown>): string {
  if (typeof frame.error === 'string' && frame.error.length > 0) return frame.error;
  if (frame.error && typeof frame.error === 'object') {
    const record = frame.error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    return JSON.stringify(frame.error);
  }
  return `command "${String(frame.command ?? 'unknown')}" failed without a message`;
}
