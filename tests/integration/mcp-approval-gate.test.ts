/**
 * Integration test: an approval-gated MCP tool cannot run without confirmation.
 *
 * The gap this pins: admission filtering decided *visibility* while the
 * confirmation list was built from *declarations*. An MCP server publishes its
 * tool list only at connect time, so a tool the agent never named appears in no
 * `configs` entry. It was therefore admitted (correct), kept its `execute`, and
 * — because the strategy matches `confirmTools` against the model-visible name
 * — never reached the user for approval, even though `mcp_toolset` defaults to
 * `always_ask`.
 *
 * These tests drive the real `ToolResolver` against a real stdio MCP server, so
 * the discovered tool name is produced by the same code path production uses.
 * Asserting on `resolveToolsRequiringConfirmation` alone would only prove the
 * helper works in isolation, which was never the broken part.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { ToolResolver } from '@/core/session/tool-resolver.js';
import { resolveToolsRequiringConfirmation } from '@/core/agent/standard.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { Session } from '@/types/session.js';
import type { SandboxInstance } from '@/types/sandbox.js';

const MOCK_SERVER = join(import.meta.dirname, '../fixtures/mock-mcp-server.mjs');

/** Runtime name the mock server's single tool carries once namespaced. */
const DISCOVERED_TOOL = 'mcp_mock_echo';

const session: Session = {
  id: 'sess_mcp_gate',
  agentId: 'agent_x',
  agentName: 'x',
  environmentId: 'env_default',
  status: 'running',
  loopEngine: 'builtin',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Session;

function mcpAgent(toolset: Record<string, unknown>): AgentDefinition {
  return {
    name: 'x',
    model: 'gpt-4o-mini',
    system: 'gate MCP tools',
    mcp_servers: [{ name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] }],
    // Note the absence of `configs`: the server's tool is discovered, not
    // declared, which is exactly the case a declaration-based list misses.
    tools: [toolset],
  } as unknown as AgentDefinition;
}

function fakeSandbox(): SandboxInstance {
  return {
    async writeFile() {},
    async readFile() {
      return '';
    },
    async listFiles() {
      return [];
    },
    async execute() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async destroy() {},
  } as unknown as SandboxInstance;
}

/** Resolve the tool map the way a real turn does, then tear the server down. */
async function resolveFor(agent: AgentDefinition) {
  const resolver = new ToolResolver({
    delegationService: { buildDelegationTools: () => ({}) } as never,
  });
  const tools = await resolver.resolveTools(session, agent, fakeSandbox());
  return { tools, resolver };
}

describe('MCP approval gate for discovered tools', () => {
  const resolvers: ToolResolver[] = [];

  afterEach(async () => {
    for (const resolver of resolvers.splice(0)) await resolver.cleanupSession(session.id);
  });

  it('gates a discovered tool that the toolset default marks always_ask', async () => {
    // No `default_config` at all: the effective policy is still `always_ask`
    // because that is the default for the `mcp_toolset` kind.
    const agent = mcpAgent({ type: 'mcp_toolset', mcp_server_name: 'mock' });
    const { tools, resolver } = await resolveFor(agent);
    resolvers.push(resolver);

    // The tool is visible — the admission filter is not what gates it.
    expect(tools[DISCOVERED_TOOL]).toBeDefined();
    // …and it must not be able to run before the user approves it.
    expect((tools[DISCOVERED_TOOL] as { execute?: unknown }).execute).toBeUndefined();
  });

  it('lists the discovered tool so the strategy reaches requires_action', async () => {
    const agent = mcpAgent({ type: 'mcp_toolset', mcp_server_name: 'mock' });
    const { tools, resolver } = await resolveFor(agent);
    resolvers.push(resolver);

    // The strategy matches this list against the model-visible name. If the
    // discovered name is missing here, `awaitsConfirmation` is false and the
    // tool executes — the confirmation list and the tool map must agree.
    expect(resolveToolsRequiringConfirmation(agent, Object.keys(tools))).toContain(DISCOVERED_TOOL);
  });

  it('lets an explicit always_allow opt out for the whole toolset', async () => {
    const agent = mcpAgent({
      type: 'mcp_toolset',
      mcp_server_name: 'mock',
      default_config: { permission_policy: { type: 'always_allow' } },
    });
    const { tools, resolver } = await resolveFor(agent);
    resolvers.push(resolver);

    expect((tools[DISCOVERED_TOOL] as { execute?: unknown }).execute).toBeTypeOf('function');
    expect(resolveToolsRequiringConfirmation(agent, Object.keys(tools))).not.toContain(DISCOVERED_TOOL);
  });

  it('does not admit a tool the operator denied', async () => {
    const agent = mcpAgent({
      type: 'mcp_toolset',
      mcp_server_name: 'mock',
      default_config: { permission_policy: { type: 'never_allow' } },
    });
    const { tools, resolver } = await resolveFor(agent);
    resolvers.push(resolver);

    // A denied tool must not reach the model at all: shipping it and relying on
    // a later gate invites the model to call something the operator forbade.
    expect(tools[DISCOVERED_TOOL]).toBeUndefined();
  });
});
