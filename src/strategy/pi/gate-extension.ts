/**
 * SandBase-managed Pi tool gate extension.
 *
 * Encoder and decoder live in one file on purpose. The gate round-trips a
 * structured payload through a Pi dialog, which carries only free text. If the
 * two sides disagree about that encoding by a single field name, the gate stops
 * matching and a tool that required a decision runs unguarded — a silent failure
 * in the one place silence is most dangerous. Keeping the generator and the
 * parser adjacent is the cheapest defence against that class of bug.
 *
 * The dialog method is `editor` rather than `confirm`, because a confirmation
 * alone cannot express an edited call. Pi documents that mutations to
 * `event.input` reach the real execution, so the edited JSON a decision carries
 * is applied in place — and the runtime validates the replacement before it
 * sends it, because Pi performs no re-validation after an extension mutation.
 *
 * What the extension can and cannot do:
 *
 * - It can block a call and ask for a decision.
 * - It cannot read or change the SandBase policy, and it cannot grant itself
 *   permanent authorization: one `tool_call` yields exactly one question, and
 *   the answer applies to that call only.
 * - It is loaded through a `--extension` flag the runtime owns, pointing at an
 *   absolute path inside the session's private configuration directory, so
 *   project-local resources cannot replace it.
 *
 * The runtime verifies the extension really loaded by reading Pi's command list
 * back and looking for the per-session marker command registered below.
 * Verification is empirical rather than assumed, because "the gate is loaded"
 * is the precondition for exposing an `always_ask` tool at all.
 */

import {
  PI_GATE_DECISION_ALLOW,
  PI_GATE_DECISION_DENY,
  PI_GATE_ENV,
  PI_GATE_MARKER_PREFIX,
  PI_GATE_PAYLOAD_KIND,
  PI_GATE_PAYLOAD_VERSION,
  type PiGateDecisionValue,
  type PiGatePayload,
} from './rpc-wire.js';

export const PI_GATE_EXTENSION_FILENAME = 'gate-extension.mjs';

/** Title Pi shows for a gate question. The decoder does not depend on it. */
export const PI_GATE_CONFIRM_TITLE = 'SandBase tool approval';

/** A decision, as the runtime writes it back through the dialog. */
export interface PiGateDecision {
  decision: PiGateDecisionValue;
  /** Present only when the call should run with different arguments. */
  input?: Record<string, unknown>;
}

/**
 * Source of the per-session gate extension.
 *
 * Emitted as one readable artifact rather than composed from helpers, because
 * the generated file is the security-relevant artifact an operator may need to
 * audit after the fact — not the generator.
 */
export function piGateExtensionSource(): string {
  return `// SandBase-managed Pi tool gate. Generated per session; do not edit.
// The runtime re-verifies the marker command below before it exposes a gated tool.
export default function (pi) {
  const sessionId = process.env[${JSON.stringify(PI_GATE_ENV.sessionId)}] || "";
  let gated = [];
  try {
    const parsed = JSON.parse(process.env[${JSON.stringify(PI_GATE_ENV.gatedTools)}] || "[]");
    if (Array.isArray(parsed)) gated = parsed.filter((name) => typeof name === "string");
  } catch {
    gated = [];
  }
  const gatedSet = new Set(gated);

  const deny = (reason) => ({ block: true, reason });
  const isPlainObject = (value) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  // Registering the marker is what makes the "gate is loaded" check possible.
  pi.registerCommand(${JSON.stringify(PI_GATE_MARKER_PREFIX)} + sessionId, {
    description: "SandBase tool gate (managed)",
    handler: async () => {},
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!gatedSet.has(event.toolName)) return;
    const input = isPlainObject(event.input) ? event.input : {};
    const payload = JSON.stringify({
      kind: ${JSON.stringify(PI_GATE_PAYLOAD_KIND)},
      version: ${PI_GATE_PAYLOAD_VERSION},
      tool_call_id: typeof event.toolCallId === "string" ? event.toolCallId : "",
      tool_name: String(event.toolName),
      input,
    });

    let answer;
    try {
      answer = await ctx.ui.editor(${JSON.stringify(PI_GATE_CONFIRM_TITLE)}, payload);
    } catch {
      // A gate that cannot obtain a decision must not let the call through.
      return deny("SandBase tool gate could not obtain a decision");
    }
    if (typeof answer !== "string") return deny("Denied by SandBase tool gate");

    let decided;
    try {
      decided = JSON.parse(answer);
    } catch {
      return deny("SandBase tool gate received a malformed decision");
    }
    if (!isPlainObject(decided)) return deny("SandBase tool gate received a malformed decision");
    if (decided.decision !== ${JSON.stringify(PI_GATE_DECISION_ALLOW)}) {
      return deny("Denied by SandBase tool gate");
    }
    if (decided.input === undefined) return;
    if (!isPlainObject(decided.input)) return deny("SandBase tool gate received invalid tool arguments");
    try {
      for (const key of Object.keys(input)) delete input[key];
      Object.assign(input, decided.input);
    } catch {
      return deny("SandBase tool gate could not apply the approved tool arguments");
    }
    return;
  });
}
`;
}

/**
 * Decode the payload carried in the dialog's prefill.
 *
 * Returns `undefined` for anything that is not exactly this gate's payload at a
 * version this runtime understands. Callers must then answer with a denial:
 * leaving a blocking dialog unanswered stops the engine, and defaulting to
 * allow would turn a malformed request into authority.
 */
export function parsePiGatePayload(prefill: unknown): PiGatePayload | undefined {
  if (typeof prefill !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(prefill);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== PI_GATE_PAYLOAD_KIND) return undefined;
  if (record.version !== PI_GATE_PAYLOAD_VERSION) return undefined;
  if (typeof record.tool_call_id !== 'string' || record.tool_call_id.length === 0) return undefined;
  if (typeof record.tool_name !== 'string' || record.tool_name.length === 0) return undefined;
  if (!isPlainObject(record.input)) return undefined;
  return {
    kind: PI_GATE_PAYLOAD_KIND,
    version: PI_GATE_PAYLOAD_VERSION,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    input: record.input,
  };
}

/**
 * Validate a decision before it is written back to Pi.
 *
 * The runtime owns this check because Pi re-validates nothing after an
 * extension mutates `event.input`: an `input` that is not a plain object is
 * refused rather than coerced into the arguments of a tool that is about to
 * run.
 */
export function validatePiGateDecision(value: unknown): PiGateDecision | undefined {
  if (!isPlainObject(value)) return undefined;
  const decision = value.decision;
  if (decision !== PI_GATE_DECISION_ALLOW && decision !== PI_GATE_DECISION_DENY) return undefined;
  if (value.input === undefined) return { decision };
  if (!isPlainObject(value.input)) return undefined;
  return { decision, input: value.input as Record<string, unknown> };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
