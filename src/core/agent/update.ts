/**
 * Agent update (PUT/PATCH) request contract.
 *
 * Both verbs carry the same partial-update semantics, deliberately: a `PUT`
 * that silently clears every field the body omitted is a data-loss path, and
 * the Console editor only ever shows a subset of the definition. The rules:
 *
 * - an omitted field keeps its stored value;
 * - a scalar that is present replaces its value;
 * - `tools`, `mcp_servers`, and `skills` replace wholesale when present;
 * - `metadata` merges per key, and an explicit `null` value deletes that key;
 * - `null` clears a clearable field — the same as `[]` for list fields;
 * - `system` clears to the empty string and `description` clears by removal;
 * - `name` and `model` can never be cleared;
 * - unknown fields are rejected, not silently discarded.
 */

import { z } from 'zod';
import {
  agentModelConfigSchema,
  agentModelInputSchema,
  agentNameSchema,
  agentToolsetSchema,
  mcpServerConfigSchema,
  multiagentRosterRefusal,
  skillRefSchema,
  type ValidationError,
} from './schema.js';
import type { AgentDefinition } from '@/types/agent.js';

/** Field names an update body may carry, besides `expected_version`. */
const UPDATE_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  name: agentNameSchema,
  model: agentModelInputSchema,
  system: z.union([z.string(), z.null()]),
  description: z.union([z.string(), z.null()]),
  model_config: z.union([agentModelConfigSchema, z.null()]),
  tools: z.union([z.array(agentToolsetSchema), z.null()]),
  mcp_servers: z.union([z.array(mcpServerConfigSchema), z.null()]),
  skills: z.union([z.array(skillRefSchema), z.null()]),
  metadata: z.union([z.record(z.string(), z.unknown()), z.null()]),
  max_turns: z.union([z.number().int().positive().max(1000), z.null()]),
  temperature: z.union([z.number().min(0).max(2), z.null()]),
  delegations: z.union([z.array(z.string()), z.null()]),
  // `multiagent` is deliberately absent from this table. An update carrying a
  // roster is refused above with its own capability-naming error, before the
  // table is consulted, so it never falls through to the generic unknown-field
  // message that a missing schema would otherwise produce.
  strategy: z.union([z.string(), z.null()]),
  environment: z.union([z.string(), z.null()]),
};

/**
 * Fields that reject an explicit `null` because clearing them would leave the
 * definition unresolvable: the model id selects the provider and the name is
 * the display identity. A clear attempt gets its own message rather than a
 * generic type error.
 */
const NON_CLEARABLE_FIELDS: Record<string, string> = {
  name: 'Agent name cannot be cleared; send a new name or omit the field',
  model: 'Agent model cannot be cleared; send a new model or omit the field',
};

export interface AgentUpdateRequest {
  /**
   * Present fields with their validated values. Key presence is the contract:
   * a key absent from this record was absent from (or unset in) the body.
   */
  fields: Record<string, unknown>;
  /** `undefined` only when the body omitted `expected_version`; a malformed value is a validation error. */
  expectedVersion?: number;
}

export type AgentUpdateRequestResult =
  | ({ valid: true } & AgentUpdateRequest)
  | { valid: false; errors: ValidationError[] };

/**
 * Validate an update request body against the partial-update contract.
 *
 * This validates each *present* field only; cross-field rules (MCP wiring,
 * custom tool uniqueness, roster cardinality) run against the merged
 * definition through `validateAgentDefinition`, so a request that changes one
 * side of a coupled pair is judged on the pair it produces.
 */
export function validateAgentUpdateRequest(input: unknown): AgentUpdateRequestResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: [{ path: '(root)', message: 'Agent update body must be a JSON object' }] };
  }

  const body = input as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (key === 'expected_version') continue;
    // The canonical roster gets its own refusal rather than the generic
    // unknown-field message, so this path and the create path answer a roster
    // with the same capability id and the same reason.
    if (key === 'multiagent') {
      errors.push(multiagentRosterRefusal());
      continue;
    }
    const schema = UPDATE_FIELD_SCHEMAS[key];
    if (!schema) {
      errors.push({ path: key, message: `Unknown agent update field "${key}"` });
      continue;
    }
    if (value === null && NON_CLEARABLE_FIELDS[key] !== undefined) {
      errors.push({ path: key, message: NON_CLEARABLE_FIELDS[key] });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? `${key}.${issue.path.join('.')}` : key;
        errors.push({ path, message: issue.message });
      }
      continue;
    }
    fields[key] = parsed.data;
  }

  // Absent means "no precondition". Present-but-malformed is a 400 rather
  // than a silent downgrade to an unconditional update: a client that meant
  // to guard against lost writes must not get an unguarded one from a typo.
  let expectedVersion: number | undefined;
  if ('expected_version' in body) {
    const raw = body.expected_version;
    const numeric = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
    if (Number.isInteger(numeric) && numeric > 0) expectedVersion = numeric;
    else errors.push({ path: 'expected_version', message: 'expected_version must be a positive integer' });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, fields, expectedVersion };
}

/**
 * Apply validated update fields to the stored definition and return the
 * merged raw definition for full-schema revalidation.
 */
export function applyAgentUpdatePatch(
  current: AgentDefinition,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };

  // `model_config` is derived from the canonical `model` value, so replacing
  // the model without an explicit config must not leave a stale id or speed
  // pointing at the previous model.
  if ('model' in fields && !('model_config' in fields)) delete next.model_config;

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'metadata') {
      if (value === null) {
        delete next.metadata;
        continue;
      }
      const merged: Record<string, unknown> = { ...(next.metadata as Record<string, unknown> | undefined) };
      for (const [metaKey, metaValue] of Object.entries(value as Record<string, unknown>)) {
        if (metaValue === null) delete merged[metaKey];
        else merged[metaKey] = metaValue;
      }
      next.metadata = merged;
      continue;
    }

    if (value === null) {
      // `system` is a required field on the definition, so clearing it stores
      // the empty string; every other clearable field is simply removed.
      if (key === 'system') next.system = '';
      else delete next[key];
      continue;
    }

    next[key] = value;
  }

  return next;
}

/**
 * Compare two definitions for update-relevant equality.
 *
 * Key order is normalized so a metadata merge that touches no value is a
 * no-op, while array order stays significant because tool and roster order
 * are observable in the API response.
 */
export function agentDefinitionsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}
