import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { checkMemorySize, checkStoreCapacity, memoryContentBytes, memoryContentHash } from './semantics.js';

export interface MemoryMountFile {
  id: string; storeId: string; path: string; content: string; contentSha256: string;
  contentSizeBytes: number; version: number; metadata: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}
export type MemoryMountErrorCode = 'store_unavailable' | 'invalid_path' | 'memory_too_large' | 'store_full' | 'not_found' | 'already_exists' | 'precondition_failed';
export interface MemoryMountFailure { code: MemoryMountErrorCode; message: string; currentSha256?: string }
export type MemoryMountResult<T> = { ok: true; value: T } | { ok: false; error: MemoryMountFailure };
export interface MemoryWriteOptions { sessionId?: string; metadata?: Record<string, unknown>; preconditionSha256?: string }
export interface MemoryListOptions { pathPrefix?: string }
export interface MemoryMountAdapter {
  read(storeId: string, path: string): MemoryMountResult<MemoryMountFile>;
  list(storeId: string, options?: MemoryListOptions): MemoryMountResult<MemoryMountFile[]>;
  create(storeId: string, path: string, content: string, options?: MemoryWriteOptions): MemoryMountResult<MemoryMountFile>;
  update(storeId: string, path: string, content: string, options?: MemoryWriteOptions): MemoryMountResult<MemoryMountFile>;
  upsert(storeId: string, path: string, content: string, options?: MemoryWriteOptions): MemoryMountResult<MemoryMountFile>;
  delete(storeId: string, path: string, options?: MemoryWriteOptions): MemoryMountResult<MemoryMountFile>;
}

interface RecordRow { id: string; store_id: string; path: string; content: string; metadata: string | null; created_at: string; updated_at: string; }
interface VersionedRow extends RecordRow { version: number; }
const SELECT = `SELECT r.id, r.store_id, r.path, r.content, r.metadata, r.created_at, r.updated_at,
 (SELECT COALESCE(MAX(v.version), 0) FROM memory_versions v WHERE v.store_id = r.store_id AND v.memory_id = r.id) AS version
 FROM memory_records r`;

export class SqliteMemoryMountAdapter implements MemoryMountAdapter {
  constructor(private readonly db: Database) {}

  read(storeId: string, path: string): MemoryMountResult<MemoryMountFile> {
    const normalized = normalizeMemoryRecordPath(path);
    if (!normalized.ok) return normalized;
    if (!this.storeIsAvailable(storeId)) return storeUnavailable(storeId);
    const row = this.db.prepare(`${SELECT} WHERE r.store_id = ? AND r.path = ? AND r.archived_at IS NULL`).get(storeId, normalized.value) as VersionedRow | undefined;
    return row ? { ok: true, value: toMountFile(row) } : notFound(storeId, normalized.value);
  }

  list(storeId: string, options: MemoryListOptions = {}): MemoryMountResult<MemoryMountFile[]> {
    if (!this.storeIsAvailable(storeId)) return storeUnavailable(storeId);
    let prefix = options.pathPrefix;
    if (prefix !== undefined) {
      const checked = normalizeMemoryListPrefix(prefix);
      if (!checked.ok) return checked;
      prefix = checked.value;
    }
    const rows = this.db.prepare(`${SELECT} WHERE r.store_id = ? AND r.archived_at IS NULL ORDER BY r.path ASC`).all(storeId) as unknown as VersionedRow[];
    return { ok: true, value: rows.filter((row) => prefix === undefined || row.path.startsWith(prefix)).map(toMountFile) };
  }

  create(storeId: string, path: string, content: string, options: MemoryWriteOptions = {}): MemoryMountResult<MemoryMountFile> {
    const normalized = normalizeMemoryRecordPath(path);
    if (!normalized.ok) return normalized;
    const guard = this.validateWrite(storeId, normalized.value, content);
    if (guard) return { ok: false, error: guard };
    const id = `mem_${nanoid(18)}`;
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO memory_records (id, store_id, path, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, storeId, normalized.value, content, JSON.stringify(options.metadata ?? {}), now, now);
        this.touchStore(storeId);
        this.recordVersion(storeId, id, normalized.value, content, 'created', options.sessionId, now);
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, error: { code: 'already_exists', message: `a memory already exists at ${normalized.value} in store ${storeId}` } };
      throw err;
    }
    return this.read(storeId, normalized.value);
  }

  update(storeId: string, path: string, content: string, options: MemoryWriteOptions = {}): MemoryMountResult<MemoryMountFile> {
    const normalized = normalizeMemoryRecordPath(path);
    if (!normalized.ok) return normalized;
    return this.applyUpdate(storeId, normalized.value, content, options);
  }

  upsert(storeId: string, path: string, content: string, options: MemoryWriteOptions = {}): MemoryMountResult<MemoryMountFile> {
    const normalized = normalizeMemoryRecordPath(path);
    if (!normalized.ok) return normalized;
    if (!this.storeIsAvailable(storeId)) return storeUnavailable(storeId);
    const existing = this.findActive(storeId, normalized.value);
    if (existing && options.preconditionSha256 === undefined) {
      return preconditionFailure(storeId, normalized.value, memoryContentHash(existing.content));
    }
    if (!existing && options.preconditionSha256 !== undefined) {
      return preconditionFailure(storeId, normalized.value, undefined, options.preconditionSha256);
    }
    return existing
      ? this.applyUpdate(storeId, normalized.value, content, options)
      : this.create(storeId, normalized.value, content, options);
  }

  delete(storeId: string, path: string, options: MemoryWriteOptions = {}): MemoryMountResult<MemoryMountFile> {
    const normalized = normalizeMemoryRecordPath(path);
    if (!normalized.ok) return normalized;
    if (!this.storeIsAvailable(storeId)) return storeUnavailable(storeId);
    const existing = this.findActive(storeId, normalized.value);
    if (!existing) return notFound(storeId, normalized.value);
    const currentHash = memoryContentHash(existing.content);
    if (options.preconditionSha256 !== undefined && options.preconditionSha256 !== currentHash) {
      return preconditionFailure(storeId, normalized.value, currentHash, options.preconditionSha256);
    }
    const now = new Date().toISOString();
    const written = this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE memory_records SET archived_at = ?, updated_at = ? WHERE id = ? AND store_id = ? AND archived_at IS NULL AND content = ?`)
        .run(now, now, existing.id, storeId, existing.content);
      if (result.changes === 0) return false;
      this.touchStore(storeId);
      this.recordVersion(storeId, existing.id, existing.path, existing.content, 'deleted', options.sessionId, now);
      return true;
    });
    if (!written) return preconditionFailure(storeId, normalized.value, undefined, options.preconditionSha256);
    const archived = this.db.prepare(`${SELECT} WHERE r.id = ?`).get(existing.id) as VersionedRow | undefined;
    return archived ? { ok: true, value: toMountFile(archived) } : { ok: true, value: { ...toMountFile({ ...existing, version: 0 }), updatedAt: now } };
  }

  private applyUpdate(storeId: string, path: string, content: string, options: MemoryWriteOptions): MemoryMountResult<MemoryMountFile> {
    const guard = this.validateWrite(storeId, path, content);
    if (guard) return { ok: false, error: guard };
    const existing = this.findActive(storeId, path);
    if (!existing) return notFound(storeId, path);
    const expected = options.preconditionSha256;
    const currentHash = memoryContentHash(existing.content);
    if (expected === undefined) return preconditionFailure(storeId, path, currentHash);
    if (expected !== currentHash) return preconditionFailure(storeId, path, currentHash, expected);
    const now = new Date().toISOString();
    const written = this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE memory_records SET content = ?, metadata = ?, updated_at = ? WHERE id = ? AND store_id = ? AND archived_at IS NULL AND content = ?`)
        .run(content, JSON.stringify(options.metadata ?? parseMetadata(existing.metadata)), now, existing.id, storeId, existing.content);
      if (result.changes === 0) return false;
      this.touchStore(storeId);
      this.recordVersion(storeId, existing.id, path, content, 'updated', options.sessionId, now);
      return true;
    });
    if (!written) return preconditionFailure(storeId, path, undefined, expected);
    return this.read(storeId, path);
  }

  private validateWrite(storeId: string, path: string, content: string): MemoryMountFailure | undefined {
    if (!this.storeIsAvailable(storeId)) return storeUnavailable(storeId).error;
    const size = checkMemorySize(content);
    if (!size.ok) return { code: 'memory_too_large', message: size.message! };
    if (!this.findActive(storeId, path)) {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE store_id = ? AND archived_at IS NULL').get(storeId) as { count: number } | undefined;
      const capacity = checkStoreCapacity(count?.count ?? 0);
      if (!capacity.ok) return { code: 'store_full', message: capacity.message! };
    }
    return undefined;
  }

  private findActive(storeId: string, path: string): RecordRow | undefined {
    return this.db.prepare('SELECT id, store_id, path, content, metadata, created_at, updated_at FROM memory_records WHERE store_id = ? AND path = ? AND archived_at IS NULL').get(storeId, path) as RecordRow | undefined;
  }
  private storeIsAvailable(storeId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM memory_stores WHERE id = ? AND archived_at IS NULL').get(storeId)); }
  private touchStore(storeId: string): void { this.db.prepare("UPDATE memory_stores SET updated_at = datetime('now') WHERE id = ?").run(storeId); }
  private recordVersion(storeId: string, memoryId: string, path: string, content: string, change: string, sessionId: string | undefined, now: string): void {
    const next = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM memory_versions WHERE store_id = ? AND memory_id = ?').get(storeId, memoryId) as { version: number } | undefined;
    this.db.prepare(`INSERT INTO memory_versions (id, store_id, memory_id, version, path, content, content_sha256, content_size_bytes, change, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`memver_${nanoid(18)}`, storeId, memoryId, next?.version ?? 1, path, content, memoryContentHash(content), memoryContentBytes(content), change, sessionId ?? null, now);
  }
}

export function storeUnavailable(storeId: string): { ok: false; error: MemoryMountFailure } {
  return { ok: false, error: { code: 'store_unavailable', message: `memory store ${storeId} is unavailable or archived` } };
}

function notFound(storeId: string, path: string): { ok: false; error: MemoryMountFailure } {
  return { ok: false, error: { code: 'not_found', message: `no memory at ${path} in store ${storeId}` } };
}
function preconditionFailure(storeId: string, path: string, current?: string, expected?: string): { ok: false; error: MemoryMountFailure } {
  return { ok: false, error: { code: 'precondition_failed', message: `precondition failed: another writer changed ${path} in store ${storeId}; re-read the memory and retry`, ...(current ? { currentSha256: current } : {}), ...(expected ? { } : {}) } };
}

export function normalizeMemoryRecordPath(path: string): { ok: true; value: string } | { ok: false; error: MemoryMountFailure } {
  const raw = (path ?? '').trim().replace(/\\/g, '/');
  if (!raw.startsWith('/')) return invalidPath('memory path must start with /');
  const normalized = raw.replace(/\/+/g, '/');
  if (normalized === '/' || normalized.endsWith('/') || normalized.includes('\0')) return invalidPath('memory path must name a file');
  if (normalized.slice(1).split('/').some((segment) => segment === '.' || segment === '..')) return invalidPath('memory path must not contain . or .. segments');
  return { ok: true, value: normalized };
}
function normalizeMemoryListPrefix(prefix: string): { ok: true; value: string | undefined } | { ok: false; error: MemoryMountFailure } {
  const normalized = prefix.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized.startsWith('/')) return invalidPath('memory list prefix must start with /');
  if (normalized === '/') return { ok: true, value: undefined };
  if (!normalized.endsWith('/') || normalized.includes('\0') || normalized.split('/').some((segment) => segment === '.' || segment === '..')) return invalidPath('memory list prefix is invalid');
  return { ok: true, value: normalized };
}
function invalidPath(message: string): { ok: false; error: MemoryMountFailure } { return { ok: false, error: { code: 'invalid_path', message: `invalid path: ${message}` } }; }
function toMountFile(row: VersionedRow): MemoryMountFile { return { id: row.id, storeId: row.store_id, path: row.path, content: row.content, contentSha256: memoryContentHash(row.content), contentSizeBytes: memoryContentBytes(row.content), version: Number(row.version ?? 0), metadata: parseMetadata(row.metadata), createdAt: row.created_at, updatedAt: row.updated_at }; }
function parseMetadata(value: string | null): Record<string, unknown> { if (!value) return {}; try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function isUniqueViolation(err: unknown): boolean { return String(err instanceof Error ? err.message : err).includes('UNIQUE'); }
