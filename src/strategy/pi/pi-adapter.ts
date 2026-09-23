/**
 * Pi loop-engine adapter.
 *
 * The only `LoopEngineAdapter` implementation in this runtime. It exists so the
 * Harness side — sessions, turns, events, cleanup — never learns Pi's wire
 * protocol, and so the capability claims a client reads come from one object
 * instead of being restated at each call site.
 *
 * What it owns: starting one session-owned Pi RPC child (`--mode rpc`) and
 * wiring that child's stdin/stdout to a `PiRpcSession`.
 *
 * What it deliberately does not own: continuity persistence, turn status, or
 * event ordering. Those are Harness concerns and live with the strategy, which
 * reads the same durable state `builtin` does.
 *
 * There are no other adapters. An empty Codex/Claude adapter would be a claim
 * that something is implemented, which is why none exists.
 */

import type {
  LoopEngineAdapter,
  LoopEngineCapabilityProfile,
  LoopEngineSession,
  LoopEngineStartRequest,
} from '@/strategy/loop-engine/adapter.js';
import type { PiRpcLaunchRequest, PiRpcLauncher } from '@/strategy/pi-launcher.js';
import { PiStderrTail } from './stderr-tail.js';
import { PI_ADAPTER_ID, PI_CAPABILITY_PROFILE } from './capability-profile.js';
import { PiRpcSession, PiRpcSessionClosedError, type PiRpcSessionOptions } from './rpc-session.js';

export interface PiAdapterOptions {
  launcher: PiRpcLauncher;
  /** Per-command response deadline. */
  requestTimeoutMs?: number;
  /** Per-turn deadline; a wedged turn is cancelled rather than left running. */
  turnTimeoutMs?: number;
}

export class PiAdapter implements LoopEngineAdapter {
  readonly id = PI_ADAPTER_ID;
  readonly capabilityProfile: LoopEngineCapabilityProfile = PI_CAPABILITY_PROFILE;

  constructor(private readonly options: PiAdapterOptions) {}

  /**
   * Start the one Pi child this SandBase session will use.
   *
   * The compiled tool flags travel unchanged from the strategy: the plan the
   * caller admitted is the argv the child receives, which is the only reason
   * `--tools`/`--exclude-tools` can be trusted as an enforcement rather than a
   * promise.
   *
   * On any failure the child is torn down before the error escapes, so a failed
   * start cannot leave an orphan Pi process holding the session work directory.
   */
  async startSession(request: LoopEngineStartRequest): Promise<LoopEngineSession> {
    const launchRequest: PiRpcLaunchRequest = {
      sessionId: request.sessionId,
      workDir: request.workDir,
      systemPrompt: request.systemPrompt,
      model: request.model,
      toolArgs: request.toolPlan.flags,
      ...(request.skillDirs?.length ? { skillDirs: request.skillDirs } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    };
    const handle = await this.options.launcher.startRpc(launchRequest);

    const stdin = handle.stdin;
    if (!stdin || !handle.stdout || !handle.stderr) {
      await handle.interrupt().catch(() => {});
      throw new PiRpcSessionClosedError('the started Pi child did not expose stdin, stdout, and stderr');
    }

    const stderr = new PiStderrTail();
    // Draining is not optional: an unread pipe fills and blocks the child, and a
    // blocked child looks exactly like a wedged turn.
    void drainStderr(handle.stderr, stderr);

    const sessionOptions: PiRpcSessionOptions = {
      sessionId: request.sessionId,
      workDir: request.workDir,
      model: request.model.model,
      ...(handle.sessionFile ? { sessionFile: handle.sessionFile } : {}),
      stdin,
      stdout: handle.stdout,
      stderrTail: () => stderr.text(),
      requestInterrupt: () => handle.interrupt(),
      sink: request.sink,
      ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      ...(this.options.turnTimeoutMs ? { turnTimeoutMs: this.options.turnTimeoutMs } : {}),
    };

    const session = new PiRpcSession(sessionOptions);
    session.start();
    return session;
  }
}

async function drainStderr(stream: AsyncIterable<Uint8Array | string>, tail: PiStderrTail): Promise<void> {
  try {
    for await (const chunk of stream) tail.append(chunk);
  } catch {
    // The tail is diagnostics, not authority; a read failure changes nothing.
  }
}
