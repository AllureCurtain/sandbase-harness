/**
 * Agent Routes
 *
 * GET /v1/agents      — list loaded agents
 * GET /v1/agents/:id  — get agent detail
 */

import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { cursorPageOf, toApiAgent } from '../standard.js';
import { unsupportedCapability } from '../capability-errors.js';
import { UnsupportedCapabilityError } from '@/core/capabilities/registry.js';
import { validateAgentDefinition } from '@/core/agent/schema.js';
import { parseObject } from './resource-utils.js';
import {
  agentDefinitionsEqual,
  applyAgentUpdatePatch,
  validateAgentUpdateRequest,
} from '@/core/agent/update.js';
import {
  loadActiveAgentRows,
  loadAgentRowById,
  parseAgentDefinitionFromRow,
  refreshAgentsFromDb,
} from '@/core/agent/store.js';

export function agentsRoutes(deps: ServerDeps) {
  const app = new Hono();

  // GET / — List agents
  app.get('/', (c) => {
    const agents = loadActiveAgentRows(deps.db).flatMap((row) => {
      const agent = parseAgentDefinitionFromRow(row);
      return agent ? [toApiAgent(agent, agentRowMetaFromRow(row))] : [];
    });
    return c.json(cursorPageOf(agents, {}));
  });

  // POST / — Create a standard agent definition in SQLite.
  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request', message: 'Request body must be valid JSON' } }, 400);
    }

    const result = validateAgentDefinition(body);
    if (!result.valid || !result.data) {
      return c.json({ error: { type: 'invalid_request', message: 'Invalid agent definition', details: result.errors } }, 400);
    }

    const agent = result.data;
    try {
      deps.sessionManager.assertAgentCapabilities(agent);
    } catch (error) {
      if (error instanceof UnsupportedCapabilityError) return unsupportedCapability(c, error);
      throw error;
    }
    const id = createAgentId(deps);

    deps.db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      id,
      agent.name,
      JSON.stringify(agent),
    );
    insertAgentVersion(deps, id, 1, agent.name, agent);
    refreshAgentsFromDb(deps.db, deps.agents);

    return c.json(toApiAgent(agent, agentRowMeta(deps, id)), 201);
  });

  app.get('/:id/versions', (c) => {
    const id = c.req.param('id');
    const row = activeAgentRow(deps, id);
    const agent = row ? parseAgentDefinitionFromRow(row) : undefined;
    if (!row || !agent) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }
    const versions = loadAgentVersions(deps, id);
    if (versions.length === 0) {
      return c.json(cursorPageOf([toApiAgent(agent, agentRowMetaFromRow(row))], {}));
    }
    return c.json(cursorPageOf(versions, {}));
  });

  const updateAgent = async (c: any) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: 'invalid_request', message: 'Request body must be valid JSON' } }, 400);
    }

    const id = c.req.param('id');
    const existing = activeAgentRow(deps, id);
    if (!existing) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }

    // Partial-update semantics: validate the fields the body actually carries,
    // merge them onto the stored definition, then revalidate the merged result
    // so a request that changes one side of a coupled pair is judged on the
    // pair it produces.
    const patch = validateAgentUpdateRequest(body);
    if (!patch.valid) {
      return c.json({ error: { type: 'invalid_request', message: 'Invalid agent update', details: patch.errors } }, 400);
    }
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== (existing.version ?? 1)) {
      return c.json({
        error: {
          type: 'conflict',
          message: `Agent ${id} is at version ${existing.version ?? 1}; expected version ${patch.expectedVersion}`,
        },
      }, 409);
    }

    const current = parseObject(existing.definition) as Record<string, unknown>;
    const merged = applyAgentUpdatePatch(current as never, patch.fields);
    if (agentDefinitionsEqual(current, merged)) {
      // No field actually changed, so no new immutable version is written.
      return c.json(toApiAgent(existing.definition as never, agentRowMeta(deps, id)));
    }

    const result = validateAgentDefinition(merged);
    if (!result.valid || !result.data) {
      return c.json({ error: { type: 'invalid_request', message: 'Invalid agent definition', details: result.errors } }, 400);
    }

    const agent = result.data;
    try {
      deps.sessionManager.assertAgentCapabilities(agent);
    } catch (error) {
      if (error instanceof UnsupportedCapabilityError) return unsupportedCapability(c, error);
      throw error;
    }

    deps.db.prepare(`
      UPDATE agents
      SET name = ?,
          definition = ?,
          status = 'active',
          error_message = NULL,
          archived_at = NULL,
          version = COALESCE(version, 1) + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(agent.name, JSON.stringify(agent), id);

    const nextVersion = (existing.version ?? 1) + 1;
    insertAgentVersion(deps, id, nextVersion, agent.name, agent);

    refreshAgentsFromDb(deps.db, deps.agents);

    return c.json(toApiAgent(agent, agentRowMeta(deps, id)));
  };

  // Partial-update semantics rather than a full replace: a `PUT` that silently
  // cleared every field the body omitted would be a data-loss path, and the
  // Console editor only ever shows a subset of the definition.
  app.put('/:id', updateAgent);

  app.post('/:id/archive', (c) => {
    const id = c.req.param('id');
    const existing = activeAgentRow(deps, id);
    if (!existing) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }
    const agent = parseAgentDefinitionFromRow(existing);
    deps.db.prepare(`
      UPDATE agents
      SET status = 'archived',
          archived_at = COALESCE(archived_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    refreshAgentsFromDb(deps.db, deps.agents);
    return c.json(agent ? toApiAgent(agent, agentRowMeta(deps, id)) : { id, status: 'archived' });
  });

  // GET /:id — Get agent detail
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const row = activeAgentRow(deps, id);
    const agent = row ? parseAgentDefinitionFromRow(row) : undefined;
    if (!row || !agent) {
      return c.json({ error: { type: 'not_found', message: `Agent not found: ${id}` } }, 404);
    }
    return c.json(toApiAgent(agent, agentRowMetaFromRow(row)));
  });

  return app;
}

function agentRowMeta(deps: ServerDeps, id: string) {
  const row = loadAgentRowById(deps.db, id);
  if (!row) return undefined;
  return agentRowMetaFromRow(row);
}

function agentRowMetaFromRow(row: {
  id: string;
  loaded_at?: string;
  updated_at?: string;
  status?: string;
  version?: number;
  archived_at?: string | null;
}) {
  return {
    id: row.id,
    createdAt: row.loaded_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    status: row.status === 'archived' || row.archived_at ? 'archived' as const : 'active' as const,
    version: row.version ?? 1,
  };
}

function activeAgentRow(deps: ServerDeps, id: string) {
  const row = loadAgentRowById(deps.db, id);
  if (!row || row.status === 'archived' || row.archived_at) return undefined;
  return row;
}

function loadAgentVersions(deps: ServerDeps, agentId: string) {
  const rows = deps.db.prepare(`
    SELECT id, agent_id, version, name, definition, created_at
    FROM agent_versions
    WHERE agent_id = ?
    ORDER BY version DESC
  `).all(agentId) as Array<{
    id: string;
    agent_id: string;
    version: number;
    name: string;
    definition: string;
    created_at: string;
  }>;
  return rows.flatMap((row) => {
    const agent = parseAgentDefinitionFromRow(row);
    return agent ? [toApiAgent(agent, {
      id: row.agent_id,
      createdAt: row.created_at,
      updatedAt: row.created_at,
      archivedAt: null,
      status: 'active',
      version: row.version,
    })] : [];
  });
}

function insertAgentVersion(deps: ServerDeps, agentId: string, version: number, name: string, agent: unknown) {
  deps.db.prepare(`
    INSERT OR IGNORE INTO agent_versions (id, agent_id, version, name, definition, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(`agver_${nanoid(18)}`, agentId, version, name, JSON.stringify(agent));
}

function expectedVersionFromBody(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>).expected_version;
  if (value === undefined) return undefined;
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function createAgentId(deps: ServerDeps): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `agent_${nanoid(24)}`;
    const existing = deps.db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!existing) return id;
  }
  throw new Error('Unable to allocate unique agent id');
}
