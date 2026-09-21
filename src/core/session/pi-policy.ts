import type { AgentDefinition } from '@/types/agent.js';
import type { UserEvent } from '@/types/cma-protocol.js';

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

/** Stable public error for explicit tool restrictions Pi cannot faithfully enforce. */
export const PI_TOOL_POLICY_UNSUPPORTED_CODE = 'pi_tool_policy_not_supported';
export const PI_TOOL_POLICY_UNSUPPORTED_MESSAGE =
  'Pi loop engine does not support agents declaring disabled or never_allow tools.';

export class PiToolPolicyUnsupportedError extends Error {
  readonly code = PI_TOOL_POLICY_UNSUPPORTED_CODE;

  constructor() {
    super(PI_TOOL_POLICY_UNSUPPORTED_MESSAGE);
    this.name = 'PiToolPolicyUnsupportedError';
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
 * Pi print mode has no validated Harness tool-policy bridge. Reject explicit
 * constraints it cannot enforce rather than allowing its independent child
 * CLI to bypass an agent's confirmation or denial declaration.
 */
export function assertPiAgentCanExecute(agent: AgentDefinition): void {
  // A canonical custom entry carries no permission policy by design, so there is
  // nothing here for Pi to refuse; the legacy grouping still can carry one.
  const declaredConfigs = (agent.tools ?? []).flatMap((toolset) => {
    if (toolset.type === 'custom') return [];
    return [
      ...(toolset.default_config ? [toolset.default_config] : []),
      ...(toolset.configs ?? []),
    ];
  });
  if (declaredConfigs.some((config) => config.permission_policy?.type === 'always_ask')) {
    throw new PiAlwaysAskUnsupportedError();
  }
  if (declaredConfigs.some(
    (config) => config.enabled === false || config.permission_policy?.type === 'never_allow',
  )) {
    throw new PiToolPolicyUnsupportedError();
  }
}