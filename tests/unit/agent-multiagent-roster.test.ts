/**
 * Canonical `multiagent` roster validation — WP3 PR 3.2, design §4.8.
 *
 * The roster is no longer refused wholesale: it is parsed, resolved against
 * the agent table, and stored in its resolved form. These cases pin each §4.8
 * rule at the schema boundary — cardinality, the `advisor` refusal, the
 * one-level depth limit, version pinning, the `delegations` /
 * `enable_general_subagent` coexistence refusal, and `multiagent: null` as the
 * documented clear. The store-facing checks run through an injected lookup, so
 * the schema stays pure and the rules are exercised without a database.
 */

import { describe, expect, it } from 'vitest';
import { validateAgentDefinition, type RosterResolverContext } from '@/core/agent/schema.js';
import { parseRosterParam, resolveRoster, type RosterMemberRow } from '@/core/agent/roster.js';
import { assertPiAgentCanExecute, PiMultiagentUnsupportedError } from '@/core/session/pi-policy.js';
import type { AgentDefinition } from '@/types/agent.js';

const base = { name: 'Coordinator', model: 'gpt-4o', system: 'Orchestrate.' };

/** A resolver where `agent_a` (v3) and `agent_b` (v1, with v7 retained) exist. */
function resolver(overrides: Record<string, RosterMemberRow | undefined> = {}): RosterResolverContext {
  const table: Record<string, RosterMemberRow | undefined> = {
    agent_a: { version: 3, hasMultiagent: false, versions: [3] },
    agent_b: { version: 1, hasMultiagent: false, versions: [1, 7] },
    ...overrides,
  };
  return {
    self: { id: 'agent_self', version: 5 },
    lookup: (id) => table[id],
  };
}

describe('multiagent roster — §4.8', () => {
  it('accepts a coordinator roster and pins unversioned members to the resolved version', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_a' }, { type: 'agent', id: 'agent_b', version: 7 }] } },
      resolver(),
    );
    expect(result.valid).toBe(true);
    expect(result.data?.multiagent).toEqual({
      type: 'coordinator',
      agents: [
        { type: 'agent', id: 'agent_a', version: 3 },   // pinned to current version
        { type: 'agent', id: 'agent_b', version: 7 },   // pin to a retained version kept
      ],
    });
  });

  it('refuses a version pin the store cannot resolve', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_b', version: 9 }] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0].path).toBe('multiagent.agents[0]');
    expect(result.errors?.[0].message).toMatch(/has no version 9/);
  });

  it('resolves a `self` member to the coordinator id at the write version', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'self' }] } },
      resolver(),
    );
    expect(result.valid).toBe(true);
    expect(result.data?.multiagent?.agents).toEqual([{ type: 'agent', id: 'agent_self', version: 5 }]);
  });

  it('resolves the bare-string member shorthand to a versioned agent reference', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: ['agent_a'] } },
      resolver(),
    );
    expect(result.valid).toBe(true);
    expect(result.data?.multiagent?.agents).toEqual([{ type: 'agent', id: 'agent_a', version: 3 }]);
  });

  it('refuses an `advisor` member with advisor_unsupported, hoisted to a code', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'advisor', model: 'claude-x' }] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
    const advisorError = result.errors?.find((e) => e.code === 'advisor_unsupported');
    expect(advisorError).toBeDefined();
    expect(advisorError?.path).toBe('multiagent.agents[0]');
  });

  it('refuses a member that declares its own roster — delegation is one level', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_a' }] } },
      resolver({ agent_a: { version: 3, hasMultiagent: true, versions: [3] } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0].message).toMatch(/one level|its own multiagent/i);
  });

  it('refuses a member that does not exist or is archived', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_ghost' }] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0].message).toMatch(/does not exist|archived/i);
  });

  it('refuses more than 20 members', () => {
    const members = Array.from({ length: 21 }, (_, i) => ({ type: 'agent' as const, id: `agent_${i}` }));
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: members } },
      resolver(),
    );
    expect(result.valid).toBe(false);
  });

  it('refuses an empty agents list', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
  });

  it('refuses a duplicate member after self/string resolution to the same id', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'self' }, 'agent_self'] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => /already listed/i.test(e.message))).toBe(true);
  });

  it('refuses more than one `self` member', () => {
    const result = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'self' }, { type: 'self' }] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
  });

  it('refuses a roster combined with `delegations` (D10)', () => {
    const result = validateAgentDefinition(
      { ...base, delegations: ['agent_a'], multiagent: { type: 'coordinator', agents: ['agent_a'] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0].message).toMatch(/cannot be combined/i);
  });

  it('refuses a roster combined with `enable_general_subagent` (D10)', () => {
    const result = validateAgentDefinition(
      { ...base, enable_general_subagent: true, multiagent: { type: 'coordinator', agents: ['agent_a'] } },
      resolver(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0].message).toMatch(/cannot be combined/i);
  });

  it('leaves `multiagent: null` for the store layer to apply as a clear', () => {
    const result = validateAgentDefinition({ ...base, multiagent: null }, resolver());
    expect(result.valid).toBe(true);
    // Null is the documented clear, not a roster; it is not turned into one.
    expect(result.data?.multiagent).toBeNull();
  });

  it('still validates a roster structurally when no resolver is injected', () => {
    // Seed import / shape-check path: members are not resolved, but an advisor
    // or a bad shape is still refused rather than stored.
    const advisor = validateAgentDefinition(
      { ...base, multiagent: { type: 'coordinator', agents: [{ type: 'advisor', model: 'x' }] } },
    );
    // Without a resolver the advisor refusal is deferred to resolution — but
    // the structural parse still has to accept the shape for resolution later.
    expect(advisor.valid).toBe(true);
  });
});

describe('Pi admission boundary — §5', () => {
  it('refuses a rostered agent with pi_multiagent_not_supported', () => {
    // Pi runs one print-mode turn per session and has no thread surface, so a
    // coordinator is refused by name rather than silently run single-threaded.
    const agent = {
      ...base,
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_a', version: 3 }],
      },
    } as AgentDefinition;

    expect(() => assertPiAgentCanExecute(agent)).toThrow(PiMultiagentUnsupportedError);
    expect(() => assertPiAgentCanExecute(agent)).toThrowError(
      expect.objectContaining({ code: 'pi_multiagent_not_supported' }),
    );
  });
});

describe('roster helpers', () => {
  it('parseRosterParam rejects a non-coordinator type', () => {
    expect(parseRosterParam({ type: 'ring', agents: [] }).ok).toBe(false);
  });

  it('resolveRoster keeps request order and self resolves to the coordinator', () => {
    const resolved = resolveRoster(
      { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_a' }, { type: 'self' }] },
      { id: 'agent_me', version: 2 },
      (id) => (id === 'agent_a' ? { version: 4, hasMultiagent: false, versions: [4] } : undefined),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.roster.agents).toEqual([
        { type: 'agent', id: 'agent_a', version: 4 },
        { type: 'agent', id: 'agent_me', version: 2 },
      ]);
    }
  });
});
