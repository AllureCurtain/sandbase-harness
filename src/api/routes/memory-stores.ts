import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { cursorPageOf } from '../standard.js';
import {
  COLLECTION_LISTING_QUERY_PARAMS,
  INCLUDE_ARCHIVED_PARAM,
  parseCollectionWindow,
  parseIncludeArchived,
  rejectUnexpectedQueryParams,
} from './query-params.js';
import {
  applyMemoryListScope,
  checkMemorySize,
  checkStoreCapacity,
  memoryContentBytes,
  memoryContentHash,
  evaluateContentPrecondition,
  validateMemoryListScope,
} from '@/core/memory/semantics.js';
import {
  archiveResource,
  conflict,
  invalid,
  notFound,
  objectField,
  parseObject,
  readObjectBody,
  stringField,
  stringRecordField,
} from './resource-utils.js';

type ResourceKind = 'memory_store';

/**
 * The memory-store listing's ordering, as the token a page cursor carries.
 *
 * It names the collection as well as the sort, so a cursor issued by the vault
 * listing is refused here rather than counted against a different collection.
 */
const MEMORY_STORE_LIST_ORDER = 'memory_stores.created_at DESC, rowid DESC';

export function memoryStoreRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/memory_stores', (c) => {
    // Admission first, through the same list the vault listing passes: both read the
    // same three parameters, so a parameter one of them refused and the other ignored
    // would be the drift the shared readings exist to prevent.
    const rejected = rejectUnexpectedQueryParams(c, COLLECTION_LISTING_QUERY_PARAMS);
    if (rejected) return rejected;
    // The published contract makes the archived half of the collection opt-in:
    // "默认排除已归档的存储；传递 `include_archived: true` 可将其包含在内"
    // (`管理智能体上下文/记忆存储.md:1206`), and its worked example is
    // `?include_archived=true` (`:1210`). The exclusion used to be hardcoded here, so a
    // caller who passed the documented parameter was handed a page that omitted exactly
    // the rows they asked for, with nothing saying the filter had been ignored.
    // `toMemoryStore` already labels an archived store, so only the `WHERE` was missing.
    // The parameter is read by the same helper the vault listing uses, so the two
    // collections cannot come to accept different values for it.
    const includeArchived = parseIncludeArchived(c);
    if (!includeArchived.ok) return includeArchived.response;

    // The published pagination rule applies here too, read by the same helper as the
    // vault listing so the two collections cannot come to accept different values for
    // `limit`/`page` either. The cursor carries this collection's ordering and the
    // archived filter that produced the page.
    const window = parseCollectionWindow(c, {
      order: MEMORY_STORE_LIST_ORDER,
      filter: includeArchived.value ? { [INCLUDE_ARCHIVED_PARAM]: 'true' } : {},
    });
    if (!window.ok) return window.response;

    const where = includeArchived.value ? '' : 'WHERE m.archived_at IS NULL';
    // The same tie-break as the vault listing, for the same reason: `created_at` is
    // `datetime('now')`, so stores created in one second share a timestamp and the
    // order within that group has to be decided by something.
    const rows = deps.db.prepare(`${memoryStoreSelect(where)} ORDER BY m.created_at DESC, m.rowid DESC`).all() as unknown as MemoryStoreRow[];
    return c.json(window.value.slice(rows.map((row) => toMemoryStore(row, deps))));
  });

  app.post('/memory_stores', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    if (!name) return invalid(c, 'name is required');
    const id = `memstore_${nanoid(18)}`;
    try {
      deps.db.prepare(
        'INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        name,
        stringField(body.value.description) ?? '',
        stringField(body.value.provider) ?? 'sqlite',
        JSON.stringify(objectField(body.value.config)),
        JSON.stringify(stringRecordField(body.value.metadata)),
      );
      const row = deps.db.prepare(memoryStoreSelect('WHERE m.id = ? AND m.archived_at IS NULL')).get(id) as unknown as MemoryStoreRow;
      return c.json(toMemoryStore(row, deps), 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, 'Memory store id already exists');
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.get('/memory_stores/:id', (c) => {
    const row = deps.db.prepare(memoryStoreSelect('WHERE m.id = ? AND m.archived_at IS NULL')).get(c.req.param('id')) as MemoryStoreRow | undefined;
    return row ? c.json(toMemoryStore(row, deps)) : notFound(c, 'Memory store not found');
  });

  app.get('/memory_stores/:id/memories', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['path_prefix', 'depth']);
    if (rejected) return rejected;
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!store) return notFound(c, 'Memory store not found');
    // `path_prefix` must be an absolute path ending in `/`, and `depth` must be
    // 0 or 1. Matching is segment-based and depth 1 lists only direct children.
    const scope = validateMemoryListScope(
      c.req.query('path_prefix'),
      c.req.query('depth') === undefined ? undefined : Number(c.req.query('depth')),
    );
    if (!scope.ok) return invalid(c, scope.message!);
    const memories = applyMemoryListScope(listMemories(deps, c.req.param('id')), {
      prefix: scope.prefix,
      depth: scope.depth,
    });
    return c.json(cursorPageOf(memories, {}));
  });

  app.post('/memory_stores/:id/memories', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const storeId = c.req.param('id');
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId);
    if (!store) return notFound(c, 'Memory store not found');
    const path = memoryPath(body.value.path);
    if (!path) return invalid(c, 'path is required and must start with /');
    const content = typeof body.value.content === 'string' ? body.value.content : '';
    // The published caps are enforced here rather than left to the caller, so a
    // store cannot be filled past its capacity or its per-memory size budget by
    // a client that ignores them.
    const size = checkMemorySize(content);
    if (!size.ok) return invalid(c, size.message!, size.code);
    const capacity = checkStoreCapacity(
      (deps.db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE store_id = ? AND archived_at IS NULL').get(storeId) as { count: number }).count,
    );
    if (!capacity.ok) return conflict(c, capacity.message!, capacity.code);
    const id = `mem_${nanoid(18)}`;
    const now = new Date().toISOString();
    try {
      deps.db.prepare(
        `INSERT INTO memory_records (id, store_id, path, content, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, storeId, path, content, JSON.stringify(stringRecordField(body.value.metadata)), now, now);
      deps.db.prepare('UPDATE memory_stores SET updated_at = datetime(\'now\') WHERE id = ?').run(storeId);
      recordMemoryVersion(deps, storeId, id, path, content, 'created', now);
      const row = deps.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as unknown as MemoryRecordRow;
      return c.json(toMemory(row), 201);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, `Memory already exists at path: ${path}`);
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.put('/memory_stores/:id/memories/:memoryId', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const storeId = c.req.param('id');
    const memoryId = c.req.param('memoryId');
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId);
    if (!store) return notFound(c, 'Memory store not found');
    const existing = deps.db.prepare('SELECT * FROM memory_records WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(memoryId, storeId) as MemoryRecordRow | undefined;
    if (!existing) return notFound(c, 'Memory not found');
    const path = body.value.path === undefined ? existing.path : memoryPath(body.value.path);
    if (!path) return invalid(c, 'path must start with /');
    const content = typeof body.value.content === 'string' ? body.value.content : existing.content;
    const size = checkMemorySize(content);
    if (!size.ok) return invalid(c, size.message!, size.code);
    // A precondition refuses a write whose content moved underneath the caller.
    // The refusal reports the current hash so the caller can retry without a
    // separate re-read.
    const precondition = evaluateContentPrecondition(body.value.precondition, existing.content);
    if (!precondition.ok) {
      // The current hash is surfaced as its own field as well as inside the
      // message, so a caller can retry without parsing prose.
      const currentHash = memoryContentHash(existing.content);
      return c.json(
        {
          error: {
            type: 'conflict',
            code: precondition.code,
            message: precondition.message,
            current_content_sha256: currentHash,
          },
        },
        409,
      );
    }
    try {
      deps.db.prepare(
        'UPDATE memory_records SET path = ?, content = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ? AND store_id = ?',
      ).run(
        path,
        content,
        JSON.stringify(body.value.metadata === undefined ? parseObject(existing.metadata) : stringRecordField(body.value.metadata)),
        memoryId,
        storeId,
      );
      deps.db.prepare('UPDATE memory_stores SET updated_at = datetime(\'now\') WHERE id = ?').run(storeId);
      recordMemoryVersion(deps, storeId, memoryId, path, content, 'updated', new Date().toISOString());
      const row = deps.db.prepare('SELECT * FROM memory_records WHERE id = ? AND store_id = ?').get(memoryId, storeId) as unknown as MemoryRecordRow;
      return c.json(toMemory(row));
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) return conflict(c, `Memory already exists at path: ${path}`);
      return c.json({ error: { type: 'internal_error', message: err.message } }, 500);
    }
  });

  app.delete('/memory_stores/:id/memories/:memoryId', (c) => {
    const storeId = c.req.param('id');
    const memoryId = c.req.param('memoryId');
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId);
    if (!store) return notFound(c, 'Memory store not found');
    const existing = deps.db.prepare('SELECT * FROM memory_records WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(memoryId, storeId) as MemoryRecordRow | undefined;
    if (!existing) return notFound(c, 'Memory not found');
    deps.db.prepare('UPDATE memory_records SET archived_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ? AND store_id = ?').run(memoryId, storeId);
    deps.db.prepare('UPDATE memory_stores SET updated_at = datetime(\'now\') WHERE id = ?').run(storeId);
    recordMemoryVersion(deps, storeId, memoryId, existing.path, existing.content, 'deleted', new Date().toISOString());
    return c.json({ deleted: true, id: memoryId });
  });

  app.post('/memory_stores/:id/archive', (c) => archiveResource(c, deps, 'memory_stores', (row) => toMemoryStore(row, deps)));

  // Every write records a version, so the history of a memory is reconstructable
  // without diffing snapshots of the store.
  app.get('/memory_stores/:id/memory_versions', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['memory_id']);
    if (rejected) return rejected;
    const storeId = c.req.param('id');
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId);
    if (!store) return notFound(c, 'Memory store not found');
    const memoryId = c.req.query('memory_id');
    const rows = (memoryId
      ? deps.db.prepare(
        'SELECT * FROM memory_versions WHERE store_id = ? AND memory_id = ? ORDER BY version DESC',
      ).all(storeId, memoryId)
      : deps.db.prepare(
        'SELECT * FROM memory_versions WHERE store_id = ? ORDER BY created_at DESC',
      ).all(storeId)) as unknown as MemoryVersionRow[];
    return c.json(cursorPageOf(rows.map(toMemoryVersion), {}));
  });

  app.get('/memory_stores/:id/memory_versions/:versionId', (c) => {
    const storeId = c.req.param('id');
    const store = deps.db.prepare('SELECT id FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId);
    if (!store) return notFound(c, 'Memory store not found');
    const row = deps.db.prepare(
      'SELECT * FROM memory_versions WHERE id = ? AND store_id = ?',
    ).get(c.req.param('versionId'), storeId) as unknown as MemoryVersionRow | undefined;
    return row ? c.json(toMemoryVersion(row)) : notFound(c, 'Memory version not found');
  });

  return app;
}

/**
 * Append a memory version.
 *
 * `content` is captured as it was written, so a later redaction can replace the
 * stored text without losing the fact that a version existed. Numbering is per
 * memory and monotonic, and the unique index refuses a second writer claiming a
 * version that already exists rather than letting it overwrite the first.
 */
function recordMemoryVersion(
  deps: ServerDeps,
  storeId: string,
  memoryId: string,
  path: string,
  content: string,
  change: 'created' | 'updated' | 'deleted',
  now: string,
  sessionId?: string,
): void {
  const next = deps.db.prepare(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM memory_versions WHERE store_id = ? AND memory_id = ?',
  ).get(storeId, memoryId) as unknown as { version: number } | undefined;
  deps.db.prepare(
    `INSERT INTO memory_versions
       (id, store_id, memory_id, version, path, content, content_sha256, content_size_bytes, change, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `memver_${nanoid(18)}`,
    storeId,
    memoryId,
    next?.version ?? 1,
    path,
    content,
    memoryContentHash(content),
    memoryContentBytes(content),
    change,
    sessionId ?? null,
    now,
  );
}

function toMemoryVersion(row: MemoryVersionRow) {
  return {
    id: row.id,
    type: 'memory_version',
    store_id: row.store_id,
    memory_id: row.memory_id,
    version: row.version,
    path: row.path,
    content_sha256: row.content_sha256,
    content_size_bytes: row.content_size_bytes,
    change: row.change,
    session_id: row.session_id,
    created_at: row.created_at,
  };
}

function memoryStoreSelect(where = '') {
  return `
    SELECT m.*,
      (
        SELECT COUNT(*)
        FROM memory_records mr
        WHERE mr.store_id = m.id AND mr.archived_at IS NULL
      ) AS memory_count
    FROM memory_stores m
    ${where}
  `;
}

function toMemoryStore(row: MemoryStoreRow, deps?: ServerDeps) {
  return {
    id: row.id,
    type: 'memory_store' as ResourceKind,
    name: row.name,
    description: row.description ?? '',
    provider: row.provider,
    status: row.archived_at ? 'archived' : row.status,
    memory_count: Number(row.memory_count ?? 0),
    memories: deps ? listMemories(deps, row.id) : [],
    config: parseObject(row.config),
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

function listMemories(deps: ServerDeps, storeId: string) {
  const rows = deps.db.prepare(
    `SELECT *
     FROM memory_records
     WHERE store_id = ? AND archived_at IS NULL
     ORDER BY path ASC`,
  ).all(storeId) as unknown as MemoryRecordRow[];
  return rows.map(toMemory);
}

function toMemory(row: MemoryRecordRow) {
  const content = row.content ?? '';
  return {
    id: row.id,
    type: 'memory',
    store_id: row.store_id,
    path: row.path,
    content,
    content_size_bytes: Buffer.byteLength(content, 'utf8'),
    content_hash: createHash('sha256').update(content, 'utf8').digest('hex'),
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

function memoryPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const normalized = trimmed.replace(/\/+/g, '/');
  if (normalized === '/' || normalized.endsWith('/')) return undefined;
  return normalized;
}

interface MemoryStoreRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  status: string;
  config: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  memory_count?: number;
}

interface MemoryVersionRow {
  id: string;
  store_id: string;
  memory_id: string;
  version: number;
  path: string;
  content: string;
  content_sha256: string;
  content_size_bytes: number;
  change: string;
  session_id: string | null;
  created_at: string;
}

interface MemoryRecordRow {
  id: string;
  store_id: string;
  path: string;
  content: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
