/**
 * The Pi native tool policy compiler.
 *
 * `docs/pi-loop-engine.md` says a Pi session's declared tool policy is expressed
 * in Pi's own vocabulary, because Pi's native tools are not Harness tools. That
 * claim is only worth anything if the compiled flags are exactly what the child
 * receives, so these tests pin the mapping (allow, deny, no tools), the
 * fail-closed refusals, and the one place the runtime refuses to launch without
 * a policy at all.
 *
 * The flag meanings asserted here are Pi 0.84.4's own, read from its `--help`:
 * `--tools` is a comma-separated allowlist, `--exclude-tools` a denylist, and
 * `--no-builtin-tools` disables the built-in tools while leaving extension and
 * custom tools enabled.
 */

import { describe, it, expect } from 'vitest';
import { compilePiNativeToolPolicy, PiToolPolicyUnsupportedError } from '@/core/session/pi-native-tools.js';
import { assertPiAgentCanExecute, PiAlwaysAskUnsupportedError } from '@/core/session/pi-policy.js';
import { PI_TOOL_ARGS_WHEN_UNSTATED, piToolArgsFor } from '@/strategy/pi-launcher.js';
import { PI_NATIVE_TOOLS, isPiNativeTool } from '@/strategy/pi/native-tools.js';
import type { AgentDefinition } from '@/types/agent.js';

function agentWithTools(tools: unknown[]): AgentDefinition {
  return { name: 'pi-agent', model: 'gpt-4o', system: 'x', tools } as AgentDefinition;
}

describe('Pi native tool vocabulary', () => {
  it('is the set Pi 0.84.4 ships, and nothing else', () => {
    expect(PI_NATIVE_TOOLS).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'powershell']);
    expect(isPiNativeTool('read')).toBe(true);
    // A Harness tool Pi does not have must not be mistaken for a native one.
    expect(isPiNativeTool('web_fetch')).toBe(false);
  });
});

describe('compilePiNativeToolPolicy', () => {
  it('allows exactly the enabled tools and claims no exclusion it did not send', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'read' }, { name: 'grep' }] },
    ]));

    expect(plan.allow).toEqual(['read', 'grep']);
    expect(plan.argv).toEqual(['--tools', 'read,grep']);
    // A tool the definition never mentions is enforced by `--tools` being an
    // allowlist, so naming it in `--exclude-tools` would misdescribe the argv.
    expect(plan.denied).toEqual([]);
    expect(plan.exposeNoTools).toBe(false);
  });

  it('moves a denied or disabled tool out of the allowlist and into --exclude-tools', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [
          { name: 'read' },
          { name: 'bash', permission_policy: { type: 'never_allow' } },
          { name: 'write', enabled: false },
        ],
      },
    ]));

    expect(plan.allow).toEqual(['read']);
    expect(plan.denied).toEqual(['bash', 'write']);
    expect(plan.argv).toEqual(['--tools', 'read', '--exclude-tools', 'bash,write']);
  });

  it('honours a toolset-level default, not only per-tool entries', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: false },
        configs: [{ name: 'read', enabled: true }],
      },
    ]));

    // `write` is never mentioned and `bash` inherits the disabled default: the
    // allowlist is what the agent's effective policy says, not a default set.
    expect(plan.allow).toEqual(['read']);
    expect(plan.argv).toEqual(['--tools', 'read']);
  });

  it('asks Pi for no built-in tools at all when the policy enables none', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'bash', permission_policy: { type: 'never_allow' } }] },
    ]));

    expect(plan.exposeNoTools).toBe(true);
    expect(plan.allow).toEqual([]);
    expect(plan.argv).toEqual(['--no-builtin-tools']);
  });
});

describe('fail-closed refusals', () => {
  it('refuses a tool Pi 0.84.4 does not have instead of dropping it', () => {
    const definition = agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch' }] },
    ]);

    expect(() => compilePiNativeToolPolicy(definition)).toThrow(PiToolPolicyUnsupportedError);
    // The message names the declaration: "this agent cannot run on Pi" is only
    // actionable once the operator knows which entry caused it.
    expect(() => compilePiNativeToolPolicy(definition)).toThrow(/web_fetch/);
  });

  it('refuses an MCP toolset the agent could actually use', () => {
    expect(() => compilePiNativeToolPolicy(agentWithTools([
      { type: 'mcp_toolset', mcp_server_name: 'filesystem' },
    ]))).toThrow(/no MCP transport/);
  });

  it('accepts a fully disabled MCP toolset, because nothing is expected to run through it', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      { type: 'mcp_toolset', mcp_server_name: 'filesystem', default_config: { enabled: false } },
      { type: 'agent_toolset_20260401', configs: [{ name: 'read' }] },
    ]));

    expect(plan.allow).toEqual(['read']);
  });

  it('reports a gated tool as gated, and still refuses the agent until the gate exists', () => {
    const definition = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [{ name: 'read' }, { name: 'bash', permission_policy: { type: 'always_ask' } }],
      },
    ]);

    // The plan is honest about what would need asking...
    expect(compilePiNativeToolPolicy(definition).gate).toEqual(['bash']);
    // ...and admission refuses it, because a launch without the gate would run a
    // tool nobody would be asked about.
    expect(() => assertPiAgentCanExecute(definition)).toThrow(PiAlwaysAskUnsupportedError);
  });

  it('returns the plan from admission for an agent that needs no gate', () => {
    const plan = assertPiAgentCanExecute(agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'grep' }] },
    ]));

    expect(plan.argv).toEqual(['--tools', 'grep']);
  });
});

describe('the tool policy one launch uses', () => {
  it('uses the compiled plan when the request states one', () => {
    expect(piToolArgsFor({ toolArgs: ['--tools', 'read'] })).toEqual(['--tools', 'read']);
  });

  it('exposes no built-in tool when the request states no policy at all', () => {
    // Omitted is not "unrestricted": it is the strict end of Pi's own surface, so
    // a launch that cannot state its policy cannot widen the agent's.
    expect(piToolArgsFor({})).toEqual(PI_TOOL_ARGS_WHEN_UNSTATED);
    expect(PI_TOOL_ARGS_WHEN_UNSTATED).toEqual(['--no-builtin-tools']);
  });
});
