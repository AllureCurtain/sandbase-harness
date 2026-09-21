/**
 * MCP server and toolset cross-validation.
 *
 * The rule catches the "saved but unexecutable" configuration: both sides
 * persist fine and then silently do nothing at execution time. Each rejection
 * names the offending entry so the caller can see which one is wrong.
 */

import { describe, expect, it } from 'vitest';
import { validateAgentDefinition } from '@/core/agent/schema.js';

const SERVER = { type: 'url', name: 'docs', url: 'https://mcp.example.com/mcp' };

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'MCP Agent',
    model: 'claude-opus-5',
    system: 'Use the MCP server.',
    ...overrides,
  };
}

describe('MCP server and toolset agreement', () => {
  it('accepts every declared server bound by exactly one toolset', () => {
    const result = validateAgentDefinition(definition({
      mcp_servers: [SERVER],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] }],
    }));
    expect(result.valid).toBe(true);
  });

  it('accepts a definition with no MCP servers and no MCP toolsets', () => {
    expect(validateAgentDefinition(definition()).valid).toBe(true);
  });

  it('rejects a toolset naming an undeclared server', () => {
    const result = validateAgentDefinition(definition({
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: 'tools.0.mcp_server_name',
      message: expect.stringContaining('undeclared MCP server'),
    }));
  });

  it('rejects a declared server no toolset binds', () => {
    const result = validateAgentDefinition(definition({
      mcp_servers: [SERVER],
      tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'read' }] }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: 'mcp_servers.0.name',
      message: expect.stringContaining('has no mcp_toolset'),
    }));
  });

  it('rejects a duplicate server name', () => {
    const result = validateAgentDefinition(definition({
      mcp_servers: [SERVER, { ...SERVER, url: 'https://other.example.com/mcp' }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: 'mcp_servers.1.name',
      message: expect.stringContaining('Duplicate MCP server name'),
    }));
  });

  it('allows two toolsets to bind the same declared server', () => {
    // A legitimate fan-out of one transport across two tool groups.
    const result = validateAgentDefinition(definition({
      mcp_servers: [SERVER],
      tools: [
        { type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] },
        { type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] },
      ],
    }));
    expect(result.valid).toBe(true);
  });

  it('reports every offending entry in one pass', () => {
    const result = validateAgentDefinition(definition({
      mcp_servers: [SERVER, { type: 'stdio', name: 'extra', command: 'x', args: [] }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] }],
    }));
    expect(result.valid).toBe(false);
    // `docs` is bound, so only the unbound `extra` server is reported.
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.path).toBe('mcp_servers.1.name');
  });
});
