/**
 * Loop Engine Adapter Boundary
 *
 * A deliberately thin internal seam between the session runtime and an engine
 * that owns its own process, transport, and tool loop. It exists so a second
 * engine can be added without the session runtime learning that engine's wire
 * protocol, and so the capability claims a client reads are produced by the
 * adapter instead of being restated at every call site.
 *
 * Rules this boundary is built to hold:
 *
 * - Engine wire types never appear here. What a turn is — a prompt, the frames
 *   the engine produces, and how the turn settles — is stated once, in terms the
 *   Harness can act on, so no strategy has to know an engine's argv or JSON.
 * - A capability profile is declarative and truthful. It records what the
 *   engine really does, including the things it does *not* do: an adapter must
 *   be able to say "these tools are not Harness tools" and "this engine has no
 *   security sandbox" rather than leaving a consumer to infer it.
 * - A session outlives a turn. `startSession` is called once per SandBase
 *   session and `prompt` as often as that session runs a turn, which is what
 *   makes one owned child per session expressible without the strategy
 *   spawning anything itself.
 * - Only implemented engines are exported from this module's consumers. There
 *   are no placeholder adapters, because an empty adapter is a claim.
 */

import type { SessionEvent } from '@/types/session.js';
import type { EventLogWriter } from '@/types/strategy.js';

/** How an engine obtains the tools its model can call. */
export type LoopEngineToolPolicy =
  /** The engine ships its own tools; Harness `ToolResolver` tools are not injected. */
  | 'native_tools_only'
  /** Harness builds and executes the tool set. */
  | 'harness_tool_resolver';

/** Where a confirmation decision for a tool call comes from. */
export type LoopEngineToolApproval =
  /** Harness confirmation, executed by the Harness strategy loop. */
  | 'harness_confirmation'
  /**
   * The engine raises a managed pre-execution gate for a tool call and relays
   * the decision to the caller. The decision is consumed once, and a decision
   * that cannot be recorded leaves the call unexecuted.
   */
  | 'rpc_gate'
  /** No approval mechanism. A caller must not claim otherwise. */
  | 'none';

/** What actually confines a tool's filesystem reach. */
export type LoopEnginePathConfinement =
  /** Nothing in the engine: isolation must come from Docker, a VM, or another external boundary. */
  | 'external_boundary'
  /** The Harness sandbox enforces paths. */
  | 'sandbox';

export interface LoopEngineCapabilityProfile {
  tool_policy: LoopEngineToolPolicy;
  tool_approval: LoopEngineToolApproval;
  path_confinement: LoopEnginePathConfinement;
  streaming: boolean;
  resume: boolean;
  /**
   * Explicit, not implied by `tool_policy`. When false, a consumer must not
   * route engine tool calls through Harness tool execution, permission policy,
   * or path checks — those do not apply.
   */
  native_tools_are_harness_tools: boolean;
  /**
   * Explicit, not implied by `path_confinement`. When false the engine provides
   * no security boundary of its own, and running it against untrusted input
   * requires an external one.
   */
  engine_security_sandbox: boolean;
}

/**
 * The tool set an engine should expose for one session.
 *
 * Carried as the flags the runtime's own policy compiler already produced, not
 * as a neutral allow/deny description an adapter would have to re-derive:
 * re-deriving it is how a launch ends up sending a policy that differs from the
 * one admission checked. The compiler is the single place that maps an agent
 * declaration onto an engine's vocabulary, so this field is that answer.
 */
export interface LoopEngineToolPlan {
  /** The declared policy, already expressed in the engine's own flags. */
  flags: readonly string[];
  /**
   * Engine-native tool names whose calls must pass the managed pre-execution
   * gate before they execute, or omitted when nothing is gated.
   *
   * Carried beside `flags` because it is part of the same compiled policy, and
   * because the gate list is what the launch must load a gate extension for: a
   * name that is allowed but not gated would execute with no decision attached.
   */
  gate?: readonly string[];
}

/** Where an adapter's durable events, usage, and oversized output go. */
export interface LoopEngineEventSink extends EventLogWriter {
  broadcast(event: SessionEvent): void;
  /** Store output too large for the transcript; resolves to the readable preview. */
  spillToolOutput(output: string): Promise<string>;
}

/**
 * Everything an engine needs to own one session for its whole life.
 */
export interface LoopEngineStartRequest {
  sessionId: string;
  /** Host work directory the engine runs in; also its child's cwd. */
  workDir: string;
  /** Already-composed system prompt, including loaded skills. */
  systemPrompt: string;
  model: {
    provider: string;
    model: string;
    api_key: string;
    base_url?: string;
  };
  /** The compiled tool policy the child must be launched with. */
  toolPlan: LoopEngineToolPlan;
  /** Explicit skill directories, for an engine that loads them by path. */
  skillDirs?: string[];
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Cancels the owned child. A session-owned engine is not stopped by
   * abandoning a turn, so the signal has to reach the process itself.
   */
  abortSignal?: AbortSignal;
  /**
   * The engine-neutral output surface for this session.
   *
   * Passed per start rather than per turn because the durable log and the live
   * broadcast belong to the SandBase session, while the sandbox an oversized
   * tool result spills into belongs to the turn.
   */
  sink: LoopEngineEventSink;
}

/**
 * One interaction a session raised that needs a decision before it proceeds.
 *
 * The input is the input the decision will be made against, together with its
 * fingerprint, so a decision cannot be replayed against different arguments.
 */
export interface LoopEnginePendingInteraction {
  /** Engine-side correlation id for the interaction. */
  requestId: string;
  /** Caller-visible tool use id the decision is recorded against. */
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Stable digest of `input`. */
  inputFingerprint: string;
  turnId: string;
}

/**
 * Resolve one pending interaction.
 *
 * Resolves to `true` only when this call consumed the pending record. Every
 * other outcome — unknown id, already decided, mismatched tool or turn,
 * malformed decision — is answered with a refusal and reported as `false`, so a
 * replayed or mismatched decision can never execute the call.
 */
export interface LoopEngineInteractionResponder {
  respondToInteraction(requestId: string, response: unknown): Promise<boolean>;
}

/**
 * One engine session: one owned child, many turns.
 *
 * The turn protocol is three methods. `prompt` starts a turn, and
 * `awaitTurnOutcome` resolves exactly once per armed turn with how it settled.
 * Everything a caller needs to react to a failure — whether the child is still
 * usable, what it wrote to stderr, which session file it owns — is readable
 * without a second round trip, so a failed turn is reported with its reason
 * instead of as an unexplained hang.
 */
export interface LoopEngineSession extends LoopEngineInteractionResponder {
  readonly sessionId: string;
  /** Active turn identifier, or `undefined` when no turn is in flight. */
  readonly turnId: string | undefined;
  /** False once the child exited or the transport died. Never flips back. */
  readonly alive: boolean;
  /** Idle, mid-turn, or closed. Reported so a stuck turn stays describable. */
  readonly phase: 'idle' | 'busy' | 'closed';
  /**
   * The engine's own durable session artifact, when the engine has one.
   *
   * Exposed because continuity proof needs it: the Harness records what the
   * engine wrote so a later turn can refuse to continue a different
   * conversation. Absent for an engine that keeps no durable session of its own.
   */
  readonly engineSessionFile?: string;
  /** Engine diagnostics for the current failure, when it produced any. */
  readonly stderrTail: string;
  /** The reason the session stopped being usable, once it is not alive. */
  readonly failureError?: Error;
  /** Start one turn. Rejects when the session is already closed or busy. */
  prompt(text: string): Promise<void>;
  /**
   * Resolves when the current turn settled or failed.
   *
   * A turn that outlives its deadline settles as `failed` rather than hanging,
   * and the owner cancels the child so the next turn cannot inherit a wedged
   * engine.
   */
  awaitTurnOutcome(): Promise<LoopEngineTurnOutcome>;
  /** Ask the engine to stop the current turn, then release the child. */
  interrupt(): Promise<void>;
  /** Release the child and its work directory. Idempotent. */
  close(): Promise<void>;
}

export type LoopEngineTurnOutcome =
  /**
   * The turn is suspended on a gate, not finished: the engine is blocked inside
   * its tool hook and the same turn continues when a decision is written back.
   * A caller must not publish a terminal marker for it.
   */
  | { kind: 'gate'; interaction: LoopEnginePendingInteraction }
  | { kind: 'settled' }
  | { kind: 'failed'; error: Error };

export interface LoopEngineAdapter {
  readonly id: string;
  readonly capabilityProfile: LoopEngineCapabilityProfile;
  /** Start the one session-owned child this SandBase session will use. */
  startSession(request: LoopEngineStartRequest): Promise<LoopEngineSession>;
}
