import type { AgentDefinition } from '@/types/agent.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import {
  assertPiAgentToolPolicyCanExecute,
  PiToolPolicyUnsupportedError,
  PI_TOOL_POLICY_UNSUPPORTED_CODE,
  PI_TOOL_POLICY_UNSUPPORTED_MESSAGE,
  type PiNativeToolPlan,
} from './pi-native-tools.js';

export {
  PiToolPolicyUnsupportedError,
  PI_TOOL_POLICY_UNSUPPORTED_CODE,
  PI_TOOL_POLICY_UNSUPPORTED_MESSAGE,
};
export type { PiNativeToolPlan };

/** Stable public error code for the currently unsupported Pi confirmation mode. */
export const PI_ALWAYS_ASK_UNSUPPORTED_CODE = 'pi_always_ask_not_supported';
export const PI_ALWAYS_ASK_UNSUPPORTED_MESSAGE =
  'Pi loop engine does not support agents requesting always_ask tool confirmation.';

export class PiAlwaysAskUnsupportedError extends Error {
  readonly code = PI_ALWAYS_ASK_UNSUPPORTED_CODE;

  constructor() {
    super(PI_ALWAYS_ASK_UNSUPPORTED_MESSAGE);
    this.name = 'PiAlwaysAskUnsupportedError';
  }
}

/** Stable public error code for Pi sessions that cannot use the selected sandbox. */
export const PI_SANDBOX_UNSUPPORTED_CODE = 'pi_sandbox_provider_not_supported';
export const PI_SANDBOX_UNSUPPORTED_MESSAGE =
  'Pi loop engine requires the local sandbox provider because it needs a host-accessible work directory.';

export class PiSandboxProviderUnsupportedError extends Error {
  readonly code = PI_SANDBOX_UNSUPPORTED_CODE;

  constructor(readonly sandboxProvider: string) {
    super(PI_SANDBOX_UNSUPPORTED_MESSAGE);
    this.name = 'PiSandboxProviderUnsupportedError';
  }
}

/** Pi print mode can only operate against a host-accessible local workspace. */
export function assertPiEnvironmentCanExecute(sandboxProvider: string | undefined): void {
  if (sandboxProvider && sandboxProvider !== 'local') {
    throw new PiSandboxProviderUnsupportedError(sandboxProvider);
  }
}

/** Stable public error code for user events Pi print mode cannot execute. */
export const PI_USER_EVENT_UNSUPPORTED_CODE = 'pi_user_event_not_supported';
export const PI_USER_EVENT_UNSUPPORTED_MESSAGE =
  'Pi loop engine supports only user.message and user.interrupt events.';

export class PiUserEventUnsupportedError extends Error {
  readonly code = PI_USER_EVENT_UNSUPPORTED_CODE;

  constructor(readonly eventType: string) {
    super(PI_USER_EVENT_UNSUPPORTED_MESSAGE);
    this.name = 'PiUserEventUnsupportedError';
  }
}

/** Stable public error code for user.message content Pi print mode cannot execute. */
export const PI_MESSAGE_CONTENT_UNSUPPORTED_CODE = 'pi_message_content_not_supported';
export const PI_MESSAGE_CONTENT_UNSUPPORTED_MESSAGE =
  'Pi loop engine foundation supports text user messages only.';

export class PiMessageContentUnsupportedError extends Error {
  readonly code = PI_MESSAGE_CONTENT_UNSUPPORTED_CODE;

  constructor() {
    super(PI_MESSAGE_CONTENT_UNSUPPORTED_MESSAGE);
    this.name = 'PiMessageContentUnsupportedError';
  }
}

/**
 * Pi print-mode turns are limited to text messages. user.interrupt remains a
 * SessionManager control-plane event, so it is admitted but never sent to Pi.
 */
export function assertPiUserEventCanExecute(event: UserEvent): void {
  if (event.type === 'user.interrupt') return;
  if (event.type === 'user.message') {
    if (Array.isArray(event.content) && event.content.every((block) => block.type === 'text')) return;
    throw new PiMessageContentUnsupportedError();
  }
  throw new PiUserEventUnsupportedError(event.type);
}

export type PiSessionAdmissionError =
  | PiAlwaysAskUnsupportedError
  | PiToolPolicyUnsupportedError
  | PiSandboxProviderUnsupportedError
  | PiUserEventUnsupportedError
  | PiMessageContentUnsupportedError;

/** Maps all Pi admission failures to the stable API error shape. */
export function isPiSessionAdmissionError(error: unknown): error is PiSessionAdmissionError {
  return error instanceof PiAlwaysAskUnsupportedError
    || error instanceof PiToolPolicyUnsupportedError
    || error instanceof PiSandboxProviderUnsupportedError
    || error instanceof PiUserEventUnsupportedError
    || error instanceof PiMessageContentUnsupportedError;
}

/**
 * Assert an agent's tool policy can run on Pi, and return the plan expressing it.
 *
 * Pi's native tools are not Harness tools, so the declared policy is compiled
 * into Pi's own flags (see `pi-native-tools.ts`) rather than merely inspected: a
 * denied tool is excluded from the allowlist instead of the whole agent being
 * refused, and anything Pi cannot honour is refused with
 * `pi_tool_policy_not_supported` rather than silently dropped.
 *
 * A tool declared `always_ask` is different: the plan reports it in `gate`, and
 * the pre-execution gate that would ask is its own change. Until that ships, an
 * agent declaring one is refused, because launching it would run a tool nobody
 * would be asked about — the approval policy this runtime must not weaken.
 */
export function assertPiAgentCanExecute(agent: AgentDefinition): PiNativeToolPlan {
  const plan = assertPiAgentToolPolicyCanExecute(agent);
  if (plan.gate.length > 0) throw new PiAlwaysAskUnsupportedError();
  return plan;
}