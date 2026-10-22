import type { Database } from '@/core/db/database.js';
import { MODEL_EFFORT_LEVELS } from './model-object.js';
import { parseMultiagentParam, resolveMultiagentParam, type RosterMemberRow } from './roster.js';
import { validateAgentDefinition } from './schema.js';
import type { AgentDefinition, AgentLoadError } from '@/types/agent.js';

type AgentRow = {
  id: string;
  name: string;
  definition: string;
  loaded_at?: string;
  updated_at?: string;
  status?: string;
  version?: number;
  archived_at?: string | null;
};

/**
 * Import seed agent files into the store.
 *
 * A roster is resolved before it is stored, against the same lookup the write
 * routes use — the already-persisted table plus the other seeds in this batch,
 * so a coordinator may name a member declared in a later file. The batch is
 * indexed by the deterministic id each seed's name produces, which is also the
 * id `self` resolves to. Members that cannot be resolved — missing, archived,
 * advisor, or themselves rostered — fail the seed with a load error rather
 * than storing a param-form roster a read would project unresolved.
 */
export function importAgentSeeds(db: Database, agents: AgentDefinition[]): AgentLoadError[] {
  const errors: AgentLoadError[] = [];

  // The batch's own rows form the lookup for members that name other seeds:
  // a coordinator may list a member declared in a later file, and `self`
  // resolves to the deterministic id the seed's own name produces. A seed that
  // fails to resolve — a member that is missing, archived, an advisor, or
  // itself rostered — is a load error, not a stored param-form roster a read
  // would project unresolved.
  const batchIndex = new Map<string, { definition: unknown; version: number }>();
  for (const agent of agents) {
    batchIndex.set(standardAgentId(agent.name), { definition: agent, version: 1 });
  }

  for (const agent of agents) {
    const id = standardAgentId(agent.name);
    const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (existing) continue;

    const lookup = (memberId: string): RosterMemberRow | undefined => {
      const row = loadAgentRowById(db, memberId);
      if (row && row.status !== 'archived' && !row.archived_at) {
        const definition = parseAgentDefinitionFromRow(row);
        return {
          version: row.version ?? 1,
          hasMultiagent: definition?.multiagent != null,
          versions: loadAgentVersions(db, memberId, row.version ?? 1),
          name: row.name,
        };
      }
      const seeded = batchIndex.get(memberId);
      if (!seeded) return undefined;
      // A member whose own seed fails validation never lands in the table, so
      // it resolves as missing rather than as a member the coordinator can pin.
      const member = validateAgentDefinition(seeded.definition);
      if (!member.valid || !member.data) return undefined;
      // A seed is written at version 1 and has no prior versions yet, so that
      // is the only pin its roster can resolve.
      const seededName = seeded.definition && typeof seeded.definition === 'object'
        && 'name' in seeded.definition
        ? String((seeded.definition as { name: unknown }).name)
        : undefined;
      return {
        version: seeded.version,
        hasMultiagent: member.data.multiagent != null,
        versions: [seeded.version],
        ...(seededName !== undefined ? { name: seededName } : {}),
      };
    };

    const result = validateAgentDefinition(agent);
    if (!result.valid || !result.data) {
      errors.push({
        file: agent.name,
        reason: 'Invalid seeded agent definition',
        field: result.errors?.[0]?.path,
      });
      continue;
    }

    // A declared roster is resolved before it is stored, so the persisted row
    // carries the pinned form the wire reports. `null` is the documented clear.
    let definition = result.data;
    if (definition.multiagent != null) {
      const parsed = parseMultiagentParam(definition.multiagent);
      const resolved = parsed.ok
        ? resolveMultiagentParam(parsed.param, { id, version: 1 }, lookup)
        : parsed;
      if (!resolved.ok) {
        errors.push({
          file: agent.name,
          reason: 'Invalid seeded agent definition',
          field: resolved.errors[0]?.path ?? 'multiagent',
        });
        continue;
      }
      definition = { ...definition, multiagent: resolved.multiagent };
    }

    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      id,
      agent.name,
      JSON.stringify(definition),
    );
  }

  return errors;
}

export function loadActiveAgentRows(db: Database): AgentRow[] {
  return db
    .prepare(`
      SELECT id, name, definition, loaded_at, updated_at, status, version, archived_at
      FROM agents
      WHERE archived_at IS NULL
        AND status != 'archived'
      ORDER BY loaded_at ASC, name ASC
    `)
    .all() as unknown as AgentRow[];
}

export function loadActiveAgentsFromDb(db: Database): AgentDefinition[] {
  const rows = loadActiveAgentRows(db);
  return rows.flatMap((row) => {
    const agent = parseAgentDefinitionFromRow(row);
    return agent ? [agent] : [];
  });
}

export function loadAgentRowById(db: Database, id: string): AgentRow | undefined {
  return db.prepare(`
    SELECT id, name, definition, loaded_at, updated_at, status, version, archived_at
    FROM agents
    WHERE id = ?
  `).get(id) as AgentRow | undefined;
}

export function loadAgentDefinitionById(db: Database, id: string): AgentDefinition | undefined {
  const row = loadAgentRowById(db, id);
  if (!row || row.status === 'archived' || row.archived_at) return undefined;
  return parseAgentDefinitionFromRow(row);
}

/**
 * Every version a roster pin may name for one agent: the current version plus
 * the retained `agent_versions` rows.
 *
 * The current version is always included, because the durable row itself is
 * resolvable even when an older workspace has no version row for it.
 */
export function loadAgentVersions(db: Database, agentId: string, currentVersion: number): number[] {
  const rows = db.prepare('SELECT version FROM agent_versions WHERE agent_id = ?').all(agentId) as Array<{ version: number }>;
  return [...new Set([currentVersion, ...rows.map((row) => row.version)])].sort((a, b) => a - b);
}

export function parseAgentDefinitionFromRow(row: Pick<AgentRow, 'definition'>): AgentDefinition | undefined {
  try {
    const parsed = JSON.parse(row.definition) as unknown;
    const result = validateAgentDefinition(foldLegacyEffort(parsed));
    return result.valid && result.data ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold an `effort` stored beside `model_config` into the profile.
 *
 * An earlier version of `normalizeAgentDefinition` wrote the canonical level as a
 * sibling of `model_config`, where nothing read it. Re-validating such a row drops
 * the key — the definition schema is not strict and strips what it does not
 * declare — so without this the caller's level would disappear the first time the
 * row is read after an upgrade. Every agent write lands inside the profile now,
 * and the update path reads through this function too, so a legacy row is repaired
 * rather than merely tolerated; this is for what is already on disk. A profile that
 * carries its own `effort` wins, because that spelling is the current one.
 *
 * Only a value the profile could hold is folded: a hand-edited row carrying
 * something else keeps its shape and is judged by the schema, instead of this
 * function deciding that an unknown string is a level.
 */
function foldLegacyEffort(definition: unknown): unknown {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return definition;
  const record = definition as Record<string, unknown>;
  const effort = record['effort'];
  const config = record['model_config'];
  if (typeof effort !== 'string' || !effort) return definition;
  if (!MODEL_EFFORT_LEVELS.includes(effort as (typeof MODEL_EFFORT_LEVELS)[number])) return definition;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return definition;
  const profile = config as Record<string, unknown>;
  if (profile['effort'] !== undefined) return definition;
  return { ...record, model_config: { ...profile, effort } };
}

export function refreshAgentsFromDb(db: Database, target: AgentDefinition[]): AgentDefinition[] {
  const agents = loadActiveAgentsFromDb(db);
  target.length = 0;
  target.push(...agents);
  return agents;
}

function standardAgentId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `agent_${slug || 'untitled'}`;
}
