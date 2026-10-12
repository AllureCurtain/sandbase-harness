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
    seen.add(id);
    resolved.push({ type: 'agent', id, version: member.version ?? row.version });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, roster: { type: 'coordinator', agents: resolved } };
}
