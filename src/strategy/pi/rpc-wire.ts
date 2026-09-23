/**
 * Pi RPC wire facts.
 *
 * Everything in this module is derived from the vendored Pi 0.84.4
 * documentation (`docs/rpc.md`, `docs/usage.md`) and was confirmed against the
 * installed executable, not assumed. It is a leaf module on purpose: no
 * child-process, filesystem, or SDK dependency, so both the transport and the
 * policy compiler can import it without a cycle.
 *
 * It carries only what its readers use. The resume binding and the
 * caller-argument flag list arrive with the behaviours that read them, so no
 * constant here is one nothing depends on.
 */

/** LF is the only record delimiter Pi accepts in RPC mode. */
export const PI_RPC_RECORD_DELIMITER = '\n';

/** Default cap on one stdout/inbound frame, matching the print-mode reader. */
export const PI_RPC_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Extension UI methods that block Pi until the client answers. */
export const PI_DIALOG_UI_METHODS = ['select', 'confirm', 'input', 'editor'] as const;

/** Extension UI methods that are fire-and-forget and must never be answered. */
export const PI_NOTIFY_UI_METHODS = [
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text',
] as const;

/**
 * True when Pi blocks on the answer to this extension UI method.
 *
 * The split is not decoration: an answer to a fire-and-forget method would put
 * an unsolicited frame on the dialog channel, and ignoring a blocking one leaves
 * the engine waiting for a dialog nobody will ever answer.
 */
export function isPiDialogUiMethod(method: string): boolean {
  return (PI_DIALOG_UI_METHODS as readonly string[]).includes(method);
}

/**
 * Stable error codes the transport can raise.
 *
 * Declared here — the leaf module the transport imports — because the same
 * literals otherwise appear in the throwing class, in the retry-classification
 * table, and in tests. A spelling drift between those copies is how a permanent
 * failure silently becomes one a client is told to retry.
 */
export const PI_RPC_PROTOCOL_ERROR_CODE = 'pi_rpc_protocol_error';
export const PI_RPC_TIMEOUT_CODE = 'pi_rpc_timeout';
export const PI_RPC_OUTCOME_UNKNOWN_CODE = 'pi_rpc_outcome_unknown';
export const PI_RPC_CLOSED_CODE = 'pi_rpc_closed';
export const PI_RPC_COMMAND_REJECTED_CODE = 'pi_rpc_command_rejected';

/**
 * The session owner's child is gone: its stdout ended or its reader failed.
 *
 * Distinct from `PI_RPC_CLOSED_CODE`, which the transport raises for a write it
 * could not place. A caller branching on retry disposition needs to tell "the
 * command never left this process" from "the engine that was serving this
 * session no longer exists".
 */
export const PI_RPC_SESSION_CLOSED_CODE = 'pi_rpc_session_closed';

/**
 * Pi blocked on an extension dialog this runtime does not answer.
 *
 * Nothing in this runtime ships or relays an extension dialog, so the only two
 * honest readings of an arriving one are "we cannot answer it" or "we invented
 * an answer". The turn fails with this code instead.
 */
export const PI_RPC_DIALOG_UNSUPPORTED_CODE = 'pi_rpc_dialog_unsupported';

/**
 * A gated tool reached execution with no gate decision attached.
 *
 * The extension's `tool_call` hook is the only thing that asks for a decision,
 * so a gated call Pi announces and finishes without a dialog is a call that ran
 * unguarded. The turn fails rather than being reported as one in which the gate
 * apparently held.
 */
export const PI_RPC_GATE_LOST_CODE = 'pi_rpc_gate_lost';

/** The managed gate extension did not load, so `always_ask` cannot be governed. */
export const PI_RPC_GATE_UNAVAILABLE_CODE = 'pi_rpc_gate_unavailable';

/**
 * A `user.tool_confirmation` named a gate this runtime was not waiting on.
 *
 * The durable pending record is the only authority for executing a gated tool,
 * so a decision that could not be recorded must not be reported as one that
 * took effect — and must not run the call.
 */
export const PI_RPC_APPROVAL_NOT_PENDING_CODE = 'pi_rpc_approval_not_pending';

/** Discriminator for the SandBase gate payload carried inside a gate dialog. */
export const PI_GATE_PAYLOAD_KIND = 'sandbase_tool_gate';

/** Version of the gate payload; a mismatch is refused rather than guessed at. */
export const PI_GATE_PAYLOAD_VERSION = 1;

/** The two decisions this runtime is willing to write back to Pi. */
export const PI_GATE_DECISION_ALLOW = 'allow';
export const PI_GATE_DECISION_DENY = 'deny';

export type PiGateDecisionValue = typeof PI_GATE_DECISION_ALLOW | typeof PI_GATE_DECISION_DENY;

/**
 * What the managed extension puts in the dialog body for one gated call.
 *
 * Declared once, here, because the extension's generated source and the runtime
 * that decodes it must agree field for field: a disagreement is how a call that
 * required a decision runs unguarded.
 */
export interface PiGatePayload {
  kind: typeof PI_GATE_PAYLOAD_KIND;
  version: number;
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

/** Prefix of the marker command the gate extension registers for one session. */
export const PI_GATE_MARKER_PREFIX = 'sandbase-gate-';

/**
 * Marker command name for a session.
 *
 * The runtime reads Pi's command list back and looks for this name, which is the
 * only way to prove from outside the child that the gate extension loaded.
 * Without that proof an `always_ask` tool could be exposed with no gate.
 */
export function piGateMarkerCommand(sessionId: string): string {
  return `${PI_GATE_MARKER_PREFIX}${sessionId}`;
}

/** Environment names the platform-owned gate extension reads. */
export const PI_GATE_ENV = {
  sessionId: 'SANDBASE_PI_SESSION_ID',
  gatedTools: 'SANDBASE_PI_GATED_TOOLS',
} as const;

/**
 * The commands this runtime writes to a Pi RPC child.
 *
 * The session owner types its outbound commands as this union, so a command
 * name that Pi does not document fails at compile time instead of being written
 * to a child that would answer it with a parse failure. `prompt` starts a turn,
 * `steer` writes an instruction into the turn already in flight, `abort` cancels
 * one, and `get_commands` is how the runtime proves the managed gate extension
 * loaded. A gate decision travels as an `extension_ui_response`, which answers a
 * Pi-issued request rather than naming a command, so it is written by the
 * transport directly and is not a member here.
 */
export const PI_RPC_COMMANDS = ['prompt', 'steer', 'abort', 'get_commands'] as const;

export type PiRpcCommand = (typeof PI_RPC_COMMANDS)[number];
