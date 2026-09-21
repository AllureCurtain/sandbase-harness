/**
 * Console rendering of the effective tool permission policy.
 *
 * The runtime applies a per-kind default that is invisible in an agent's
 * definition: an `mcp_toolset` asks for approval even when no `default_config`
 * is written. Before this, the agent page showed an MCP server's name and
 * nothing about how its tools would be treated, so an operator could not tell a
 * gated third-party server from an ungated one — and a reader checking the
 * claim that the Console "shows Always Allow" had no UI evidence either way.
 *
 * These assertions are on rendered markup rather than on the helper, because
 * the claim is about what an operator sees.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PermissionBadge, effectiveToolsetPermission } from '../../apps/console/src/components/pages/AgentPages.js';
import type { AgentToolset } from '../../apps/console/src/types.js';

const builtin: AgentToolset = { type: 'agent_toolset_20260401' };
const mcp: AgentToolset = { type: 'mcp_toolset', mcp_server_name: 'sentry' };

describe('effectiveToolsetPermission', () => {
  it('reports the kind default for a built-in toolset with no default_config', () => {
    expect(effectiveToolsetPermission(builtin)).toBe('always_allow');
  });

  it('reports always_ask for an MCP toolset with no default_config', () => {
    // The case an operator cannot infer: third-party tools are gated by kind.
    expect(effectiveToolsetPermission(mcp)).toBe('always_ask');
  });

  it('lets an explicit toolset default override the kind default', () => {
    expect(effectiveToolsetPermission({
      type: 'mcp_toolset',
      mcp_server_name: 'sentry',
      default_config: { permission_policy: { type: 'always_allow' } },
    })).toBe('always_allow');
  });

  it('reports a denial rather than hiding it behind the default', () => {
    expect(effectiveToolsetPermission({
      type: 'mcp_toolset',
      mcp_server_name: 'sentry',
      default_config: { permission_policy: { type: 'never_allow' } },
    })).toBe('never_allow');
  });

  it('treats a missing toolset as the built-in default', () => {
    expect(effectiveToolsetPermission(undefined)).toBe('always_allow');
  });
});

describe('PermissionBadge', () => {
  const badge = (policy: 'always_allow' | 'always_ask' | 'never_allow') =>
    renderToStaticMarkup(<PermissionBadge policy={policy} />);

  it('renders a readable label for each policy', () => {
    expect(badge('always_allow')).toContain('Always allow');
    expect(badge('always_ask')).toContain('Always ask');
    expect(badge('never_allow')).toContain('Never allow');
  });

  it('carries the policy in a class so the style can distinguish it', () => {
    expect(badge('always_ask')).toContain('permission-always_ask');
    expect(badge('never_allow')).toContain('permission-never_allow');
  });
});
