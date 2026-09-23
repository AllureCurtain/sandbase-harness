/**
 * Pi RPC wire facts.
 *
 * Everything in this module is derived from the vendored Pi 0.84.4
 * documentation (`docs/rpc.md`, `docs/usage.md`) and was confirmed against the
 * installed executable, not assumed. It is a leaf module on purpose: no
 * child-process, filesystem, or SDK dependency, so both the transport and the
 * policy compiler can import it without a cycle.
 *
 * It carries only what its readers use. The gate payload, the resume binding and
 * the caller-argument flag list arrive with the behaviours that read them, so no
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
 * The commands this runtime writes to a Pi RPC child.
 *
 * The session owner types its outbound commands as this union, so a command
 * name that Pi does not document fails at compile time instead of being written
 * to a child that would answer it with a parse failure. Both entries are
 * documented RPC commands: `prompt` starts a turn, `abort` cancels one.
 */
export const PI_RPC_COMMANDS = ['prompt', 'abort'] as const;

export type PiRpcCommand = (typeof PI_RPC_COMMANDS)[number];
