import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import type { MemoryEntry, MemoryProvider } from './memory-provider.js';
import { SqliteMemoryMountAdapter } from './mount-adapter.js';
import { memoryContentHash } from './semantics.js';

interface MemoryRecordRow {
  id: string;
  path: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export class SqliteMemoryRecordsProvider implements MemoryProvider {
  readonly name = 'sqlite-memory-records';

  private readonly mountAdapter: SqliteMemoryMountAdapter;

  constructor(private readonly db: Database) {
    this.mountAdapter = new SqliteMemoryMountAdapter(db);
  }

  async add(storeId: string, content: string, metadata?: Record<string, unknown>): Promise<string> {
    return this.addForSession(storeId, content, metadata, 'memory-extraction');
  }

  async addForSession(
    storeId: string,
    content: string,
    metadata: Record<string, unknown> | undefined,
    sessionId: string,
  ): Promise<string> {
    const id = `/runtime/${nanoid(18)}`;
    const result = this.mountAdapter.create(storeId, id, content, { metadata, sessionId });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.id;
  }

  async search(storeId: string, query: string, limit = 5): Promise<MemoryEntry[]> {
    const rows = this.db.prepare(
      `SELECT r.id, r.path, r.content, r.metadata, r.created_at
       FROM memory_records r
       JOIN memory_stores s ON s.id = r.store_id
       WHERE r.store_id = ? AND r.archived_at IS NULL AND s.archived_at IS NULL
       ORDER BY r.updated_at DESC`,
    ).all(storeId) as unknown as MemoryRecordRow[];
    const terms = tokenize(query);
    const scored = rows.map((row, index) => ({ row, index, score: relevance(terms, tokenize(row.content)) }));
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.slice(0, Math.max(0, limit))
      .filter((item) => !query.trim() || item.score > 0)
      .map(({ row, score }) => ({
        id: row.id,
        content: row.content,
        relevance: score,
        metadata: { ...parseMetadata(row.metadata), path: row.path },
        createdAt: new Date(row.created_at),
      }));
  }

  async update(memoryId: string, content: string): Promise<void> {
    const existing = this.db.prepare('SELECT store_id, path, content FROM memory_records WHERE id = ? AND archived_at IS NULL').get(memoryId) as { store_id: string; path: string; content: string } | undefined;
    if (!existing) return;
    const result = this.mountAdapter.update(existing.store_id, existing.path, content, { preconditionSha256: memoryContentHash(existing.content), sessionId: 'memory-extraction' });
    if (!result.ok) throw new Error(result.error.message);
  }

  async delete(memoryId: string): Promise<void> {
    const existing = this.db.prepare('SELECT store_id, path FROM memory_records WHERE id = ? AND archived_at IS NULL').get(memoryId) as { store_id: string; path: string } | undefined;
    if (!existing) return;
    const result = this.mountAdapter.delete(existing.store_id, existing.path, { sessionId: 'memory-extraction' });
    if (!result.ok) throw new Error(result.error.message);
  }
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((term) => term.length > 2));
}

function relevance(query: Set<string>, document: Set<string>): number {
  if (query.size === 0) return 0;
  let overlap = 0;
  for (const term of query) if (document.has(term)) overlap += 1;
  return overlap / query.size;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
