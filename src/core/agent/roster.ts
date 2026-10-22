/**
 * Multiagent roster — the canonical `multiagent` field on an agent definition.
 *
 * Two validators share this file because they answer different questions:
 *
 * - {@link parseRosterParam} reads the *request* shape — the SDK's
 *   `RosterEntryParams` union of `string | {type:'agent'} | {type:'self'} |
 *   {type:'advisor'} — and produces either a typed roster or the named refusal
 *   that replaced the old blanket `multiagent` rejection. It knows nothing
 *   about the store, so a member's existence is not its business.
 *
 * - {@link resolveRoster} takes the parsed roster and a lookup over the agent
 *   table and produces the *resolved* roster the wire reports: `self` and
 *   string forms become concrete `{type:'agent', id, version}` references with
 *   the version pinned at validation time (§1.1, D11), missing/archived/
 *   nested-roster members fail the request, and `advisor` fails closed because
 *   this runtime has no server-side advisor (D9 → `advisor_unsupported`).
 *
 * Depth is one level: a member whose own definition declares `multiagent` is
 * refused, because honouring it would let delegation recurse past the level
 * the coordinator tools are built to serve.
 */

import { z } from 'zod';
import type { ValidationError } from './schema.js';
import type {
  Multiagent20261001,
  MultiagentAgentReference,
  MultiagentConfig,
  ResolvedMultiagentAdvisor,
  ResolvedMultiagentSetting,
} from '@/types/agent.js';

/** Stable refusal for a roster member that names the unsupported advisor. */
export const ADVISOR_UNSUPPORTED_CODE = 'advisor_unsupported';

/**
 * One roster member as the wire reports it after resolution: a concrete agent
 * reference (version always present — `self` and unversioned forms are pinned
 * to the resolved version at write time).
 */
export interface ResolvedRosterAgent {
  type: 'agent';
  id: string;
  version: number;
}

/** A resolved advisor entry. Never produced today — see `advisor_unsupported`. */
export interface ResolvedRosterAdvisor {
  type: 'advisor';
  model: string;
}

export type ResolvedRosterEntry = ResolvedRosterAgent | ResolvedRosterAdvisor;

/** The resolved `multiagent` value stored on the definition and echoed on read. */
export interface ResolvedRoster {
  type: 'coordinator';
  agents: ResolvedRosterEntry[];
}

/**
 * A parsed-but-unresolved roster member, one per `RosterEntryParams` arm.
 * `agent` here covers the string and `{type:'agent'}` forms alike — both name
 * an agent id with an optional version pin.
 */
export type RosterMemberParam =
  | { type: 'agent'; id: string; version?: number }
  | { type: 'self' }
  | { type: 'advisor'; model: string };

export interface RosterParam {
  type: 'coordinator';
  agents: RosterMemberParam[];
}

/** One `RosterEntryParams` member as the SDK sends it (string shorthand included). */
export const rosterMemberParamSchema = z.union([
  // An agent id as a bare string — the SDK sends this shorthand.
  z.string().min(1).transform((id) => ({ type: 'agent' as const, id })),
  z.object({
    type: z.literal('agent'),
    id: z.string().min(1),
    version: z.number().int().min(1).optional(),
  }),
  z.object({ type: z.literal('self') }),
  z.object({ type: z.literal('advisor'), model: z.string().min(1) }),
]);

const rosterParamSchema = z.object({
  type: z.literal('coordinator'),
  agents: z.array(rosterMemberParamSchema).min(1).max(20),
});

export type RosterParseResult =
  | { ok: true; roster: RosterParam }
  | { ok: false; errors: ValidationError[] };

/**
 * Read the request's `multiagent` value into a parsed roster.
 *
 * `null` is the documented clear and is handled by the caller, not here. A
 * shape the schema cannot express as a coordinator roster is refused with
 * field-level errors; an `advisor` member parses cleanly and is refused at
 * resolution, where the `advisor_unsupported` code is attached.
 */
export function parseRosterParam(input: unknown): RosterParseResult {
  const parsed = rosterParamSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: `multiagent.${issue.path.join('.')}`.replace(/\.$/, ''),
        message: issue.message,
      })),
    };
  }
  return { ok: true, roster: parsed.data as RosterParam };
}

/**
 * The store-facing half of roster validation. `lookup` resolves one member id
 * to the agent's current version and whether its own definition declares a
 * roster — returning `undefined` when the id is missing or archived. Keeping
 * the lookup injected lets the schema stay pure while the rule still reads the
 * authoritative row.
 */
export interface RosterMemberRow {
  /** Current version, the pin an unversioned member receives. */
  version: number;
  /** Whether the member's own definition carries `multiagent` (depth limit). */
  hasMultiagent: boolean;
  /**
   * Every version this member still resolves to — the current one plus the
   * archived versions the store retains.
   *
   * A roster pin is a promise that the thread will run that exact definition.
   * A version the store cannot resolve would fall back to something else at
   * dispatch, so the pin is accepted only when it is in this set.
   */
  versions: readonly number[];
  /**
   * The member's durable display name, when the lookup has it.
   *
   * Used by the `multiagent_20261001` reserved-name rule: an enabled advisor
   * owns `anthropic.advisor`, so no predefined list may name an agent by it.
   */
  name?: string;
}

export type RosterResolveResult =
  | { ok: true; roster: ResolvedRoster }
  | { ok: false; errors: ValidationError[] };

/**
 * Resolve a parsed roster against the agent table.
 *
 * Order matches the published response: members keep request order, `self`
 * resolves to the coordinator's own id. Distinctness is judged on the resolved
 * agent id so `self` and the coordinator's own id count as the same member,
 * and at most one `self` is admitted. Advisor entries fail closed with
 * `advisor_unsupported` — the only member kind that produces a `code`, so the
 * caller can hoist it out of the details list onto the error body.
 */
export function resolveRoster(
  roster: RosterParam,
  self: { id: string; version: number },
  lookup: (id: string) => RosterMemberRow | undefined,
): RosterResolveResult {
  const selfId = self.id;
  const errors: ValidationError[] = [];
  const resolved: ResolvedRosterEntry[] = [];
  const seen = new Set<string>();
  let selfCount = 0;

  roster.agents.forEach((member, index) => {
    const path = `multiagent.agents[${index}]`;

    if (member.type === 'advisor') {
      errors.push({
        path,
        code: ADVISOR_UNSUPPORTED_CODE,
        message:
          'The advisor roster member is unavailable in this runtime (capability "multiagent-roster"): '
          + 'an advisor runs against a server-side advisor tool and a model compatibility table this '
          + 'local runtime does not have, so the entry is refused rather than accepted and ignored.',
      });
      return;
    }

    if (member.type === 'self') {
      selfCount += 1;
      if (selfCount > 1) {
        errors.push({ path, message: 'At most one `{type:"self"}` member is allowed in a roster' });
        return;
      }
      if (seen.has(selfId)) {
        errors.push({ path, message: `Roster member "${selfId}" is already listed` });
        return;
      }
      // `self` resolves to the coordinator's own id at the version this write
      // produces (1 on create, current+1 on update) — the same pin an
      // unversioned named member receives.
      resolved.push({ type: 'agent', id: selfId, version: self.version });
      seen.add(selfId);
      return;
    }

    // {type:'agent'} — existence, not-archived, and depth are all store rules.
    const id = member.id;
    if (seen.has(id)) {
      errors.push({ path, message: `Roster member "${id}" is already listed` });
      return;
    }
    const row = lookup(id);
    if (!row) {
      errors.push({ path, message: `Roster member "${id}" does not exist or is archived` });
      return;
    }
    if (row.hasMultiagent) {
      errors.push({
        path,
        message: `Roster member "${id}" declares its own multiagent roster; delegation is limited to one level`,
      });
      return;
    }
    const pinned = member.version ?? row.version;
    if (!row.versions.includes(pinned)) {
      errors.push({
        path,
        message: `Roster member "${id}" has no version ${pinned}; a roster pin must name a version the store can resolve`,
      });
      return;
    }
    seen.add(id);
    resolved.push({ type: 'agent', id, version: pinned });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, roster: { type: 'coordinator', agents: resolved } };
}

// ============================================================
// multiagent_20261001 — subagents / workflows / advisor
// ============================================================

/** One inline-agent toggle. */
export interface MultiagentInlineAgentsParam {
  type: 'enabled' | 'disabled';
}

/** One predefined list entry in the current topology. */
export type MultiagentPredefinedAgentParam =
  | string
  | { type: 'agent'; id: string; version?: number }
  | { type: 'self' };

/** One enabled/disabled `subagents` or `workflows` setting. */
export type MultiagentSettingParam =
  | { type: 'disabled' }
  | {
      type: 'enabled';
      inline_agents?: MultiagentInlineAgentsParam | null;
      predefined_agents?: MultiagentPredefinedAgentParam[] | null;
    };

/** The advisor setting: disabled, or the model consulted by the primary thread. */
export type MultiagentAdvisorParam =
  | { type: 'disabled' }
  | { type: 'enabled'; model: string };

/** The request form of the current canonical topology. */
export interface Multiagent20261001Param {
  type: 'multiagent_20261001';
  subagents?: MultiagentSettingParam | null;
  workflows?: MultiagentSettingParam | null;
  advisor?: MultiagentAdvisorParam | null;
}

/** Both accepted topologies in their request form. */
export type MultiagentParam = RosterParam | Multiagent20261001Param;

const inlineAgentsParamSchema = z.object({
  type: z.enum(['enabled', 'disabled']),
});

const predefinedAgentParamSchema = z.union([
  z.string().min(1),
  z.object({
    type: z.literal('agent'),
    id: z.string().min(1),
    version: z.number().int().min(1).optional(),
  }),
  z.object({ type: z.literal('self') }),
]);

const multiagentSettingParamSchema = z.union([
  z.object({ type: z.literal('disabled') }),
  z.object({
    type: z.literal('enabled'),
    inline_agents: inlineAgentsParamSchema.nullish(),
    predefined_agents: z.array(predefinedAgentParamSchema).max(20).nullish(),
  }),
]);

const advisorParamSchema = z.union([
  z.object({ type: z.literal('disabled') }),
  z.object({ type: z.literal('enabled'), model: z.string().min(1) }),
]);

const multiagent20261001ParamSchema = z.object({
  type: z.literal('multiagent_20261001'),
  subagents: multiagentSettingParamSchema.nullish(),
  workflows: multiagentSettingParamSchema.nullish(),
  advisor: advisorParamSchema.nullish(),
});

/** The accepted `multiagent` request shapes: legacy coordinator or current. */
export const multiagentParamSchema = z.union([rosterParamSchema, multiagent20261001ParamSchema]);

export type MultiagentParseResult =
  | { ok: true; param: MultiagentParam }
  | { ok: false; errors: ValidationError[] };

/**
 * Parse either accepted `multiagent` topology.
 *
 * The current topology keeps the request's absent/null settings intact: the
 * update path merges them level by level, and resolution supplies the defaults
 * only after the merge. `null` (the documented clear) is handled by the caller.
 */
export function parseMultiagentParam(input: unknown): MultiagentParseResult {
  const parsed = multiagentParamSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: `multiagent.${issue.path.join('.')}`.replace(/\.$/, ''),
        message: issue.message,
      })),
    };
  }
  return { ok: true, param: parsed.data as MultiagentParam };
}

export type MultiagentResolveResult =
  | { ok: true; multiagent: MultiagentConfig }
  | { ok: false; errors: ValidationError[] };

/**
 * Resolve either topology against the agent table.
 *
 * For `multiagent_20261001`, defaults are applied here: both settings are
 * enabled with inline agents enabled, both predefined lists are empty, and the
 * advisor is disabled. A disabled inline setting must leave at least one
 * predefined agent, because the setting would otherwise grant no way to
 * delegate at all.
 */
export function resolveMultiagentParam(
  param: MultiagentParam,
  self: { id: string; version: number },
  lookup: (id: string) => RosterMemberRow | undefined,
): MultiagentResolveResult {
  if (param.type === 'coordinator') {
    const resolved = resolveRoster(param, self, lookup);
    return resolved.ok
      ? { ok: true, multiagent: resolved.roster }
      : { ok: false, errors: resolved.errors };
  }

  const subagents = resolveMultiagentSetting(param.subagents, 'subagents', self, lookup);
  const workflows = resolveMultiagentSetting(param.workflows, 'workflows', self, lookup);
  const advisor = resolveMultiagentAdvisor(param.advisor);
  const errors = [...subagents.errors, ...workflows.errors, ...advisor.errors];
  if (errors.length > 0) return { ok: false, errors };

  const multiagent: Multiagent20261001 = {
    type: 'multiagent_20261001',
    subagents: subagents.setting!,
    workflows: workflows.setting!,
    advisor: advisor.advisor!,
  };
  return { ok: true, multiagent };
}

function resolveMultiagentSetting(
  param: MultiagentSettingParam | null | undefined,
  field: 'subagents' | 'workflows',
  self: { id: string; version: number },
  lookup: (id: string) => RosterMemberRow | undefined,
): { setting?: ResolvedMultiagentSetting; errors: ValidationError[] } {
  const path = `multiagent.${field}`;
  if (param === null || param === undefined) {
    return {
      setting: { type: 'enabled', inline_agents: { type: 'enabled' }, predefined_agents: [] },
      errors: [],
    };
  }
  if (param.type === 'disabled') return { setting: { type: 'disabled' }, errors: [] };

  const inline = param.inline_agents?.type ?? 'enabled';
  const refs = resolvePredefinedAgents(param.predefined_agents ?? [], path, self, lookup);
  const errors = [...refs.errors];
  if (inline === 'disabled' && refs.agents.length === 0) {
    errors.push({
      path: `${path}.inline_agents`,
      message: 'Disabling inline agents requires at least one entry in `predefined_agents`',
    });
  }
  if (errors.length > 0) return { errors };
  return {
    setting: {
      type: 'enabled',
      inline_agents: { type: inline },
      predefined_agents: refs.agents,
    },
    errors: [],
  };
}

function resolvePredefinedAgents(
  list: readonly MultiagentPredefinedAgentParam[],
  path: string,
  self: { id: string; version: number },
  lookup: (id: string) => RosterMemberRow | undefined,
): { agents: MultiagentAgentReference[]; errors: ValidationError[] } {
  const agents: MultiagentAgentReference[] = [];
  const errors: ValidationError[] = [];
  const seen = new Set<string>();

  list.forEach((member, index) => {
    const memberPath = `${path}.predefined_agents[${index}]`;
    if (typeof member === 'object' && member.type === 'self') {
      if (seen.has(self.id)) {
        errors.push({ path: memberPath, message: `Roster member "${self.id}" is already listed` });
        return;
      }
      seen.add(self.id);
      agents.push({ type: 'agent', id: self.id, version: self.version });
      return;
    }

    const id = typeof member === 'string' ? member : member.id;
    const requestedVersion = typeof member === 'string' ? undefined : member.version;
    if (seen.has(id)) {
      errors.push({ path: memberPath, message: `Roster member "${id}" is already listed` });
      return;
    }
    const row = lookup(id);
    if (!row) {
      errors.push({ path: memberPath, message: `Roster member "${id}" does not exist or is archived` });
      return;
    }
    if (row.hasMultiagent) {
      errors.push({
        path: memberPath,
        message: `Roster member "${id}" declares its own multiagent roster; delegation is limited to one level`,
      });
      return;
    }
    if (row.name === 'anthropic.advisor') {
      errors.push({
        path: memberPath,
        message: 'The name "anthropic.advisor" is reserved for an enabled advisor and cannot be listed',
      });
      return;
    }
    const pinned = requestedVersion ?? row.version;
    if (!row.versions.includes(pinned)) {
      errors.push({
        path: memberPath,
        message: `Roster member "${id}" has no version ${pinned}; a roster pin must name a version the store can resolve`,
      });
      return;
    }
    seen.add(id);
    agents.push({ type: 'agent', id, version: pinned });
  });

  return { agents, errors };
}

function resolveMultiagentAdvisor(
  param: MultiagentAdvisorParam | null | undefined,
): { advisor?: ResolvedMultiagentAdvisor; errors: ValidationError[] } {
  if (param === null || param === undefined) {
    return { advisor: { type: 'disabled' }, errors: [] };
  }
  if (param.type === 'disabled') return { advisor: { type: 'disabled' }, errors: [] };
  if (param.model.length === 0) {
    return {
      errors: [{ path: 'multiagent.advisor.model', message: 'An enabled advisor requires a model' }],
    };
  }
  return { advisor: { type: 'enabled', model: param.model }, errors: [] };
}

/**
 * Merge an update's `multiagent` into the stored resolved block.
 *
 * The current topology merges level by level: an omitted setting keeps its
 * stored value, a `null` setting resets to its default, and a sent
 * `predefined_agents` list replaces the stored list. Any other type replaces
 * the whole block. The result is still a request-form value, so the caller
 * revalidates and re-resolves it against the store.
 */
export function mergeMultiagentUpdate(
  current: MultiagentConfig,
  incoming: MultiagentParam,
): MultiagentParam {
  if (current.type !== incoming.type) return incoming;
  if (incoming.type === 'coordinator') return incoming;

  const stored = current as Multiagent20261001;
  return {
    type: 'multiagent_20261001',
    subagents: mergeMultiagentSetting(stored.subagents, incoming.subagents),
    workflows: mergeMultiagentSetting(stored.workflows, incoming.workflows),
    advisor: incoming.advisor === undefined ? stored.advisor : incoming.advisor,
  };
}

function mergeMultiagentSetting(
  current: ResolvedMultiagentSetting,
  incoming: MultiagentSettingParam | null | undefined,
): MultiagentSettingParam | null | undefined {
  if (incoming === undefined) return current;
  if (incoming === null) return null;
  if (incoming.type === 'disabled') return incoming;
  const base = current.type === 'enabled' ? current : undefined;
  return {
    type: 'enabled',
    inline_agents: incoming.inline_agents === undefined
      ? base?.inline_agents
      : incoming.inline_agents,
    predefined_agents: incoming.predefined_agents === undefined
      ? base?.predefined_agents
      : incoming.predefined_agents,
  };
}
