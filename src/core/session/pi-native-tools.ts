/**
 * Pi native tool policy compiler.
 *
 * Maps an effective `AgentDefinition` tool policy onto Pi 0.84.4's own tool
 * flags. The governing rule is that Pi's native tools are *not* Harness
 * `ToolResolver` tools, so the only way to make a declared policy true is to
 * express it in Pi's own vocabulary:
 *
 * | agent policy           | Pi argv                                                |
 * |------------------------|--------------------------------------------------------|
 * | `always_allow`         | in `--tools`, no gate                                   |
 * | `always_ask`           | in `--tools`, and reported in `plan.gate` for the gate  |
 * | `never_allow`          | absent from `--tools`, also listed in `--exclude-tools` |
 * | `enabled: false`       | absent from `--tools`, also listed in `--exclude-tools` |
 * | no native tools at all | `--no-builtin-tools`                                    |
 * | a tool Pi does not have| fail closed with `pi_tool_policy_not_supported`         |
 *
 * The allow list comes from the *effective* policy helpers in
 * `core/agent/standard.ts` rather than from the declared config objects, so a
 * toolset-level `default_config` cannot be missed by reading only per-tool
 * entries. Reading declared configs directly is exactly what previously let a
 * toolset-level policy go unnoticed elsewhere in this codebase.
 *
 * A gated tool is *reported*, not executed: the pre-execution gate that consumes
 * `plan.gate` is its own change, so today the caller refuses an agent that
 * declares `always_ask` rather than launching a tool nobody would be asked about.
 */

import { getEnabledToolNames, getToolsRequiringConfirmation } from '@/core/agent/standard.js';
import type { AgentDefinition } from '@/types/agent.js';
import { isPiNativeTool } from '@/strategy/pi/native-tools.js';

/** Stable public error for tool restrictions Pi cannot faithfully enforce. */
export const PI_TOOL_POLICY_UNSUPPORTED_CODE = 'pi_tool_policy_not_supported';
export const PI_TOOL_POLICY_UNSUPPORTED_MESSAGE =
  'Pi loop engine does not support agents declaring tool policies it cannot map onto Pi native tools.';

/**
 * Thrown when an agent's declared tool policy has no faithful Pi expression.
 *
 * The detail names the specific declaration, because "this agent cannot run on
 * Pi" is only actionable if the operator learns which entry caused it. The
 * stable `code` and the default message are unchanged so existing clients keep
 * branching on the same value.
 */
export class PiToolPolicyUnsupportedError extends Error {
  readonly code = PI_TOOL_POLICY_UNSUPPORTED_CODE;

  constructor(readonly detail: string = PI_TOOL_POLICY_UNSUPPORTED_MESSAGE) {
    super(detail);
    this.name = 'PiToolPolicyUnsupportedError';
  }
}

/**
 * Compile an agent's tool policy into the flags Pi is launched with.
 *
 * Sharing the compiler between admission and the launcher means the two can
 * never disagree: whatever is refused here is refused for the same reason at
 * launch time, and whatever passes here is the plan that is actually sent.
 */
export function assertPiAgentToolPolicyCanExecute(agent: AgentDefinition): PiNativeToolPlan {
  return compilePiNativeToolPolicy(agent);
}

export interface PiNativeToolPlan {
  /** Native Pi tool names the session may expose. */
  allow: string[];
  /** Subset of `allow` whose calls must pass the managed pre-execution gate. */
  gate: string[];
  /** Native tools declared but denied by policy, echoed into `--exclude-tools`. */
  denied: string[];
  /** True when the session must expose no engine-native tools at all. */
  exposeNoTools: boolean;
  /** The Pi flags that express this plan. */
  argv: string[];
}

/**
 * Compile the effective agent policy into Pi flags.
 *
 * Throws `PiToolPolicyUnsupportedError` for anything Pi cannot honour, so a
 * declaration is either enforced or refused — never silently dropped.
 */
export function compilePiNativeToolPolicy(agent: AgentDefinition): PiNativeToolPlan {
  assertNoEnabledMcpToolset(agent);

  const enabled = getEnabledToolNames(agent);
  const gated = new Set(getToolsRequiringConfirmation(agent));

  const allow: string[] = [];
  const gate: string[] = [];
  for (const name of enabled) {
    if (!isPiNativeTool(name)) {
      throw new PiToolPolicyUnsupportedError(
        `Pi 0.84.4 has no native tool "${name}"; enforcing the declared policy would require silently dropping it`,
      );
    }
    allow.push(name);
    if (gated.has(name)) gate.push(name);
  }

  const allowed = new Set(allow);
  const denied = declaredNativeToolNames(agent).filter((name) => !allowed.has(name));

  const exposeNoTools = allow.length === 0;
  const argv = exposeNoTools
    ? ['--no-builtin-tools']
    : [
      '--tools', allow.join(','),
      ...(denied.length > 0 ? ['--exclude-tools', denied.join(',')] : []),
    ];

  return { allow, gate, denied, exposeNoTools, argv };
}

/**
 * Native tool names the definition mentions, denied or not.
 *
 * Only names that appear in a declared config are reported. A builtin toolset
 * that simply omits a tool does not list it here: `--tools` is already a strict
 * allowlist, so an omission is enforced by absence rather than by an explicit
 * exclusion, and claiming otherwise would misdescribe what the runtime sent.
 */
function declaredNativeToolNames(agent: AgentDefinition): string[] {
  const names = new Set<string>();
  for (const toolset of agent.tools ?? []) {
    // A canonical custom tool carries no permission policy by design, so it has
    // no native name to deny; the legacy grouping still can.
    if (toolset.type === 'custom') continue;
    for (const config of toolset.configs ?? []) {
      if (isPiNativeTool(config.name)) names.add(config.name);
    }
  }
  return [...names];
}

/**
 * Pi has no MCP transport. An enabled `mcp_toolset` is a capability the agent
 * declares and Pi cannot provide, so it is refused rather than ignored.
 *
 * A fully disabled MCP toolset is satisfiable (nothing is expected to run) and
 * is accepted, matching how a denied native tool is accepted.
 */
function assertNoEnabledMcpToolset(agent: AgentDefinition): void {
  for (const toolset of agent.tools ?? []) {
    if (toolset.type !== 'mcp_toolset') continue;
    const configs = toolset.configs ?? [];
    const defaultEnabled = toolset.default_config?.enabled !== false;
    const defaultPolicy = toolset.default_config?.permission_policy?.type;
    const anyEnabled = configs.length === 0
      ? defaultEnabled && defaultPolicy !== 'never_allow'
      : configs.some((config) => (
        (config.enabled ?? defaultEnabled)
        && (config.permission_policy?.type ?? defaultPolicy) !== 'never_allow'
      ));
    if (!anyEnabled) continue;
    throw new PiToolPolicyUnsupportedError(
      `Pi 0.84.4 has no MCP transport; mcp_toolset "${toolset.mcp_server_name}" cannot be enforced`,
    );
  }
}
