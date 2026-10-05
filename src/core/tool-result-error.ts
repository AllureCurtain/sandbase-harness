/**
 * A tool result that must surface as `is_error` on the emitted
 * `agent.tool_result` event while the model keeps seeing the same text.
 *
 * Tool `execute` functions in this codebase never throw policy refusals past
 * the call site — a failure is returned as an `Error: ...` string so the model
 * reads the same message it always did. That convention left the event layer
 * unable to tell a refused or failed call from a successful one, so results
 * like a read-only mount refusal were persisted without `is_error`.
 * Returning `toolError(...)` instead of the bare string carries the flag
 * through to the strategy, which unwraps it before the value reaches the
 * model: the wire text is unchanged, only the persisted event gains the flag.
 */
export class ToolResultError {
  readonly isToolResultError = true;
  constructor(readonly message: string) {}
}

export function toolError(message: string): ToolResultError {
  return new ToolResultError(message);
}

export function toolErrorText(value: unknown): string | undefined {
  return value instanceof ToolResultError ? value.message : undefined;
}
