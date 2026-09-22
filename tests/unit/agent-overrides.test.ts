/**
 * `agent_with_overrides` parsing and resolution.
 *
 * `contracts/anthropic-cma/sessions.md` §2 documents the tri-state rule, the
 * overridable field list, and the four refusals. This file pins the rule itself:
 * an override that cannot be honoured is refused with its own code and leaves
 * the base definition untouched, so the durable agent and every other session
 * keep their configuration.
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_OVERRIDE_ERROR_CODES,
  applyAgentOverrides,
  parseAgentOverrides,
} from '@/core/agent/overrides.js';
import type { AgentDefinition } from '@/types/agent.js';

/** An agent with one value in every overridable field. */
function baseAgent(): AgentDefinition {
  return {
    name: 'base-agent',
    model: 'gpt-4o',
    system: 'base prompt',
    tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'read' }] }],
    mcp_servers: [{ type: 'url', name: 'docs', url: 'https://mcp.example.test/docs' }],
    skills: [{ type: 'custom', skill_id: 'skill_writer' }],
  };
}

function refused(value: Record<string, unknown>) {
  const parsed = parseAgentOverrides(value);
  expect(parsed.ok).toBe(false);
  return parsed as { ok: false; code: string; message: string };
}

describe('parseAgentOverrides', () => {
  it('accepts the reference keys plus the overridable fields', () => {
    const parsed = parseAgentOverrides({
      type: 'agent_with_overrides',
      id: 'agent_base-agent',
      version: 2,
      system: 'override',
      tools: [],
      mcp_servers: null,
      skills: [{ type: 'anthropic', skill_id: 'skill_pdf' }],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.overrides).toEqual({
      system: 'override',
      tools: [],
      mcp_servers: null,
      skills: [{ type: 'anthropic', skill_id: 'skill_pdf' }],
    });
  });

  it('refuses a field the contract does not let a session override', () => {
    const parsed = refused({ type: 'agent_with_overrides', id: 'agent_x', max_turns: 5 });
    expect(parsed.code).toBe(AGENT_OVERRIDE_ERROR_CODES.invalidOverrides);
    expect(parsed.message).toContain('max_turns');
  });

  it('parses a model string and a model object, and refuses a malformed one', () => {
    expect(parseAgentOverrides({ id: 'agent_x', model: 'gpt-4o-mini' })).toEqual({
      ok: true,
      overrides: { model: { id: 'gpt-4o-mini' } },
    });
    expect(parseAgentOverrides({ id: 'agent_x', model: { id: 'claude-sonnet-4', speed: 'fast' } })).toEqual({
      ok: true,
      overrides: { model: { id: 'claude-sonnet-4', speed: 'fast' } },
    });
    const invalid = refused({ id: 'agent_x', model: { id: 'claude-sonnet-4', speed: 'turbo' } });
    expect(invalid.code).toBe('invalid_model_speed');
  });

  it('refuses the model fields this runtime cannot honour instead of dropping them', () => {
    const effort = refused({ id: 'agent_x', model: { id: 'claude-sonnet-4', effort: 'high' } });
    expect(effort.code).toBe(AGENT_OVERRIDE_ERROR_CODES.invalidField);
    expect(effort.message).toContain('model.effort');

    const geo = refused({ id: 'agent_x', model: { id: 'claude-sonnet-4', inference_geo: 'us' } });
    expect(geo.code).toBe('unsupported_model_field');
    expect(geo.message).toContain('inference_geo');
  });

  it('refuses a malformed list field by name', () => {
    const parsed = refused({ id: 'agent_x', tools: 'read' });
    expect(parsed.code).toBe(AGENT_OVERRIDE_ERROR_CODES.invalidField);
    expect(parsed.message).toContain('agent.tools');
  });

  it('refuses two MCP servers with the same name', () => {
    const parsed = refused({
      id: 'agent_x',
      mcp_servers: [
        { type: 'url', name: 'docs', url: 'https://mcp.example.test/a' },
        { type: 'url', name: 'docs', url: 'https://mcp.example.test/b' },
      ],
    });
    expect(parsed.code).toBe(AGENT_OVERRIDE_ERROR_CODES.invalidField);
    expect(parsed.message).toContain('duplicate MCP server name');
  });
});

describe('applyAgentOverrides', () => {
  it('inherits an omitted field and replaces a supplied one wholesale', () => {
    const base = baseAgent();
    const resolved = applyAgentOverrides(base, { model: { id: 'claude-sonnet-4' } });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The replaced field is reported so a caller can tell which fields changed.
    expect(resolved.changed).toEqual(['model']);
    expect(resolved.definition.model).toBe('claude-sonnet-4');
    expect(resolved.definition.model_config).toEqual({ id: 'claude-sonnet-4', speed: 'standard' });
    // Everything omitted is inherited, not defaulted.
    expect(resolved.definition.system).toBe('base prompt');
    expect(resolved.definition.tools).toEqual(base.tools);
    expect(resolved.definition.skills).toEqual(base.skills);
  });

  it('never mutates the base definition', () => {
    const base = baseAgent();
    applyAgentOverrides(base, { system: 'replaced', skills: null, mcp_servers: null });
    expect(base).toEqual(baseAgent());
  });

  it('clears a field the override sets to null', () => {
    const resolved = applyAgentOverrides(baseAgent(), { system: null, mcp_servers: null });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.definition.system).toBe('');
    expect(resolved.definition.mcp_servers).toEqual([]);
    expect(resolved.changed).toEqual(['system', 'mcp_servers']);
  });

  it('treats an empty list as a clear, and refuses to clear tools under skills', () => {
    const refusedTools = applyAgentOverrides(baseAgent(), { tools: [] });
    expect(refusedTools).toEqual({
      ok: false,
      code: AGENT_OVERRIDE_ERROR_CODES.toolsClearedWithSkills,
      message: expect.stringContaining('agent.tools cannot be cleared'),
    });

    // Clearing skills in the same request is the documented way through.
    const resolved = applyAgentOverrides(baseAgent(), { skills: [], tools: [] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.definition.tools).toEqual([]);
    expect(resolved.definition.skills).toEqual([]);
  });

  it('never clears model', () => {
    expect(applyAgentOverrides(baseAgent(), { model: null })).toEqual({
      ok: false,
      code: AGENT_OVERRIDE_ERROR_CODES.modelRequired,
      message: expect.stringContaining('cannot be cleared'),
    });
  });

  it('refuses a resolved definition that references an undeclared MCP server', () => {
    // Clearing the servers while the effective tools still bind one is the
    // conflict the contract spells out.
    const bound: AgentDefinition = {
      ...baseAgent(),
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] }],
    };
    expect(applyAgentOverrides(bound, { mcp_servers: null })).toEqual({
      ok: false,
      code: AGENT_OVERRIDE_ERROR_CODES.unknownMcpServer,
      message: expect.stringContaining('docs'),
    });

    // Introducing the binding through a `tools` override is the same defect and
    // must not slip through the other field.
    expect(applyAgentOverrides(baseAgent(), {
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'missing', configs: [] }],
    })).toEqual({
      ok: false,
      code: AGENT_OVERRIDE_ERROR_CODES.unknownMcpServer,
      message: expect.stringContaining('missing'),
    });
  });

  it('accepts a replacement that declares the server it binds', () => {
    const resolved = applyAgentOverrides(baseAgent(), {
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] }],
      mcp_servers: [{ type: 'url', name: 'docs', url: 'https://mcp.example.test/v2' }],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.definition.tools).toEqual([{ type: 'mcp_toolset', mcp_server_name: 'docs', configs: [] }]);
    expect(resolved.definition.mcp_servers?.[0]).toMatchObject({ name: 'docs', url: 'https://mcp.example.test/v2' });
  });
});
