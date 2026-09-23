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
import type { PiInteractionStore } from './interaction-store.js';
import { PiRpcSession, PiRpcSessionClosedError, type PiRpcSessionOptions } from './rpc-session.js';

export interface PiAdapterOptions {
  launcher: PiRpcLauncher;
  /**
   * Durable pending-interaction store, shared with the Harness database.
   *
   * Optional only because an embedder can compose the adapter without a
   * database; a session started without one cannot gate anything, so a launch
   * that declares a gated tool is refused rather than run ungated.
   */
  interactions?: PiInteractionStore;
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
   * promise. The gated names travel with them, so the launch loads the managed
   * gate extension for exactly the tools whose calls need a decision.
   *
   * The gate is verified before returning, not after the first tool call: a
   * session that advertises an `always_ask` tool must be one where the gate
   * provably loaded, otherwise the tool would run with no decision attached and
   * the approval card a client saw would be theatre.
   *
   * On any failure the child is torn down before the error escapes, so a failed
   * start cannot leave an orphan Pi process holding the session work directory.
   */
  async startSession(request: LoopEngineStartRequest): Promise<LoopEngineSession> {
    const gateTools = request.toolPlan.gate ?? [];
    if (gateTools.length > 0 && !this.options.interactions) {
      throw new PiRpcSessionClosedError(
        'a session that gates a tool call requires a durable pending-interaction store',
      );
    }
    const launchRequest: PiRpcLaunchRequest = {
      sessionId: request.sessionId,
      workDir: request.workDir,
      systemPrompt: request.systemPrompt,
      model: request.model,
      toolArgs: request.toolPlan.flags,
      ...(gateTools.length ? { gateTools } : {}),
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
      ...(gateTools.length ? { gateTools } : {}),
      stdin,
      stdout: handle.stdout,
      stderrTail: () => stderr.text(),
      requestInterrupt: () => handle.interrupt(),
      sink: request.sink,
      // A session that gates nothing never opens a gate, so it can be composed
      // without the store; a launch that declares a gated tool is refused in the
      // adapter before it gets here, and a gate that cannot be recorded is denied.
      ...(this.options.interactions ? { interactions: this.options.interactions } : {}),
      ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      ...(this.options.turnTimeoutMs ? { turnTimeoutMs: this.options.turnTimeoutMs } : {}),
    };

    const session = new PiRpcSession(sessionOptions);
    session.start();
    try {
      await session.verifyGateExtension();
    } catch (error) {
      // A child without the gate must not be handed back as a usable session:
      // the tool it would run unguarded is exactly the one the caller declared
      // as always_ask.
      await session.close().catch(() => {});
      throw error;
    }
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
