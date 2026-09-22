import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { Database } from '@/core/db/database.js';
import { SqliteMemoryMountAdapter } from '@/core/memory/mount-adapter.js';
import { SqliteMemoryRecordsProvider } from '@/core/memory/sqlite-memory-records-provider.js';
import { memoryContentHash, defaultMemoryMountPath } from '@/core/memory/semantics.js';
import { resolveMemoryBindings } from '@/core/memory/bindings.js';
import { ToolResolver } from '@/core/session/tool-resolver.js';
import { ContextBuilder } from '@/core/session/context-builder.js';
import { normalizeResources } from '@/api/routes/session-normalizers.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import type { Session } from '@/types/session.js';
import type { MemoryEntry, MemoryProvider } from '@/core/memory/memory-provider.js';

const RW = '/mnt/memory/rw';
const RO = '/mnt/memory/ro';
let db: Database;
let dbDir: string;
let workspace: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'ma-memory-mount-db-'));
  workspace = mkdtempSync(join(tmpdir(), 'ma-memory-mount-work-'));
  db = new Database(join(dbDir, 'test.db'));
  db.runMigrations();
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function store(name: string): string {
  const id = `memstore_${nanoid(12)}`;
  db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, '', 'sqlite', '{}', '{}');
  return id;
}

function agentWithTools(names: string[]): AgentDefinition {
  return { name: 'mount-agent', model: 'm', system: 'base', tools: [{ type: 'agent_toolset_20260401', configs: names.map((name) => ({ name, enabled: true })) }] } as unknown as AgentDefinition;
}

function session(resources: Array<Record<string, unknown>>): Session {
  return { id: 'sess_test', agentId: 'a', agentName: 'mount-agent', environmentId: 'env_default', status: 'running', resources, createdAt: new Date(), updatedAt: new Date() } as unknown as Session;
}

function sandbox(): SandboxInstance & { writes: Array<{ path: string; content: string }>; commands: string[]; listPaths: string[] } {
  const writes: Array<{ path: string; content: string }> = [];
  const commands: string[] = [];
  const listPaths: string[] = [];
  return {
    writes,
    commands,
    listPaths,
    hostWorkDir: workspace,
    async writeFile(path: string, content: string) { writes.push({ path, content }); },
    async readFile() { return 'workspace file'; },
    async listFiles(path = '.') { listPaths.push(path); return ['src/app.ts']; },
    async execute(command: string) { commands.push(command); return { exitCode: 0, stdout: 'workspace-ok', stderr: '' }; },
    async cleanup() {},
  } as unknown as SandboxInstance & { writes: typeof writes; commands: typeof commands; listPaths: typeof listPaths };
}

function tools(resources: Array<Record<string, unknown>>, names: string[], sessionId = 'sess_test') {
  const adapter = new SqliteMemoryMountAdapter(db);
  const resolver = new ToolResolver({ delegationService: { buildDelegationTools: () => ({}) } as never, memoryMount: adapter });
  const sb = sandbox();
  const bindings = resolveMemoryBindings(resources);
  return { adapter, sandbox: sb, tools: resolver.buildSandboxTools(agentWithTools(names), sb, bindings, { adapter, sessionId }) };
}

describe('path-addressed memory mounts', () => {
  it('normalizes the default path from the store name and rejects traversal', () => {
    const id = store('Demo Memory');
    const normalized = normalizeResources({ db } as never, [{ type: 'memory_store', memory_store_id: id }]);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(normalized.value[0]).toMatchObject({ mount_path: '/mnt/memory/demo-memory' });
    expect(normalizeResources({ db } as never, [{ type: 'memory_store', memory_store_id: id, mount_path: `${RW}/../escape` }]).ok).toBe(false);
  });

  it('rejects an update to an existing mounted record without a precondition', () => {
    const id = store('CAS required');
    const adapter = new SqliteMemoryMountAdapter(db);
    expect(adapter.create(id, '/race.md', 'first').ok).toBe(true);
    const result = adapter.upsert(id, '/race.md', 'second');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('precondition_failed');
    const current = adapter.read(id, '/race.md');
    expect(current.ok && current.value.content).toBe('first');
  });

  it('fails closed for archive and shell indirection', async () => {
    const id = store('Archived');
    const h = tools([{ type: 'memory_store', memory_store_id: id, mount_path: RW }], ['read', 'bash']);
    await h.tools.write?.({ path: `${RW}/x.md`, content: 'x' });
    db.prepare("UPDATE memory_stores SET archived_at = datetime('now') WHERE id = ?").run(id);
    expect(await h.tools.read.execute({ path: `${RW}/x.md` })).toContain('unavailable');
    expect(await h.tools.bash.execute({ command: 'echo x > "$MEMORY_ROOT/notes.md"' })).toContain('shell access is disabled');
  });

  it('routes the legacy missing mount path through the store-name fallback', () => {
    const bindings = resolveMemoryBindings([{ type: 'memory_store', memory_store_id: 'memstore_old' }], () => 'Demo Memory');
    expect(bindings[0]?.mountPath).toBe('/mnt/memory/demo-memory');
  });

  it('routes read/write/edit/glob/grep to memory_records and not sandbox', async () => {
    const id = store('Demo Memory');
    const h = tools([{ type: 'memory_store', memory_store_id: id, mount_path: RW }], ['read', 'write', 'edit', 'glob', 'grep']);
    expect(await h.tools.write.execute({ path: `${RW}/a.md`, content: 'alpha needle' })).toContain('version 1');
    await h.tools.write.execute({ path: `${RW}/dir/b.md`, content: 'beta needle' });
    expect(await h.tools.read.execute({ path: `${RW}/a.md` })).toBe('alpha needle');
    expect(await h.tools.edit.execute({ path: `${RW}/a.md`, old_string: 'alpha', new_string: 'changed' })).toContain('version 2');
    expect(await h.tools.glob.execute({ pattern: '.md', path: RW })).toContain(`${RW}/dir/b.md`);
    expect(await h.tools.grep.execute({ query: 'needle', path: RW })).toContain(`${RW}/dir/b.md:1: beta needle`);
    expect(h.sandbox.writes).toHaveLength(0);
    expect(existsSync(join(workspace, 'mnt'))).toBe(false);
    expect(h.adapter.read(id, '/a.md').ok).toBe(true);
    expect(defaultMemoryMountPath('Demo Memory')).toBe('/mnt/memory/demo-memory');
  });

  it('supports multiple stores, longest nested mount, cross-session readback, and lookalike workspace paths', async () => {
    const parent = store('Parent');
    const child = store('Child');
    const first = tools([
      { type: 'memory_store', memory_store_id: child, mount_path: `${RW}/team` },
      { type: 'memory_store', memory_store_id: parent, mount_path: RW },
    ], ['write', 'read']);
    await first.tools.write.execute({ path: `${RW}/team/inner.md`, content: 'child' });
    await first.tools.write.execute({ path: `${RW}/outer.md`, content: 'parent' });
    expect(first.adapter.read(child, '/inner.md').ok).toBe(true);
    expect(first.adapter.read(parent, '/team/inner.md').ok).toBe(false);
    expect(await first.tools.read.execute({ path: `${RW}/outer.md` })).toBe('parent');

    const second = tools([{ type: 'memory_store', memory_store_id: parent, mount_path: RW }], ['read', 'write', 'glob']);
    expect(await second.tools.read.execute({ path: `${RW}/outer.md` })).toBe('parent');
    const ordinary = await second.tools.write.execute({ path: 'mnt/memory/rw/lookalike.md', content: 'workspace' });
    expect(ordinary).toContain('Written');
    expect(second.sandbox.writes).toHaveLength(1);
    await second.tools.glob.execute({ pattern: '.ts', path: 'src' });
    expect(second.sandbox.listPaths).toContain('src');
  });

  it('fails closed for read_only, bash, unavailable providers, and traversal paths', async () => {
    const id = store('Read Only');
    const h = tools([{ type: 'memory_store', memory_store_id: id, mount_path: RO, access: 'read_only' }], ['read', 'write', 'edit', 'bash']);
    expect(await h.tools.write.execute({ path: `${RO}/x.md`, content: 'x' })).toContain('read-only');
    expect(await h.tools.edit.execute({ path: `${RO}/x.md`, old_string: 'a', new_string: 'b' })).toContain('read-only');
    expect(await h.tools.bash.execute({ command: `echo x > ${RO}/x.md` })).toContain('read-only');
    expect(await h.tools.bash.execute({ command: 'echo x > //mnt/memory/ro/x.md' })).toContain('read-only');
    expect(h.sandbox.commands).toHaveLength(0);
    expect(await h.tools.write.execute({ path: `${RO}/../escape.md`, content: 'x' })).toContain('invalid');
    expect(h.sandbox.writes).toHaveLength(0);

    const noProvider = new ToolResolver({ delegationService: { buildDelegationTools: () => ({}) } as never });
    const sb = sandbox();
    const noProviderTools = noProvider.buildSandboxTools(agentWithTools(['write']), sb, resolveMemoryBindings([{ type: 'memory_store', memory_store_id: id, mount_path: RW } as any]));
    expect(await noProviderTools.write.execute({ path: `${RW}/x.md`, content: 'x' })).toContain('no memory store provider');
    expect(sb.writes).toHaveLength(0);
  });

  it('rejects a stale content precondition without overwriting or adding a version', () => {
    const id = store('CAS');
    const adapter = new SqliteMemoryMountAdapter(db);
    const created = adapter.create(id, '/race.md', 'first', { sessionId: 'sess_a' });
    expect(created.ok).toBe(true);
    const firstHash = memoryContentHash('first');
    expect(adapter.update(id, '/race.md', 'second', { preconditionSha256: firstHash }).ok).toBe(true);
    const conflict = adapter.update(id, '/race.md', 'third', { preconditionSha256: firstHash });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('precondition_failed');
    const current = adapter.read(id, '/race.md');
    expect(current.ok && current.value.content).toBe('second');
    expect(current.ok && current.value.version).toBe(2);
  });
});

describe('mounted memory context', () => {
  function provider(): MemoryProvider & { searches: string[]; adds: string[] } {
    const searches: string[] = [];
    const adds: string[] = [];
    return {
      name: 'test-records', searches, adds,
      async add(storeId, content) { adds.push(`${storeId}:${content}`); return 'mem_test'; },
      async search(storeId): Promise<MemoryEntry[]> { searches.push(storeId); return [{ id: storeId, content: `fact from ${storeId}`, relevance: 1, createdAt: new Date() }]; },
      async update() {}, async delete() {},
    };
  }

  it('retrieves every bound store and extracts only to writable mounts', async () => {
    const records = provider();
    const builder = new ContextBuilder({ eventLogger: { getEvents: () => [] } as never, memoryRecords: records });
    const s = session([
      { type: 'memory_store', memory_store_id: 'memstore_rw', mount_path: RW, access: 'read_write' },
      { type: 'memory_store', memory_store_id: 'memstore_ro', mount_path: RO, access: 'read_only' },
    ]);
    const built = await builder.build(s, agentWithTools([]), { type: 'user.message', content: [{ type: 'text', text: 'remember' }] } as never, undefined, () => {});
    expect(records.searches).toEqual(['memstore_rw', 'memstore_ro']);
    expect(built.systemPrompt).toContain(RW);
    expect(built.systemPrompt).toContain(RO);
    await builder.extractMemory(s, { type: 'user.message', content: [{ type: 'text', text: 'remember this' }] } as never);
    expect(records.adds).toEqual(['memstore_rw:remember this']);
  });

  it('attributes mounted extraction versions to the active session', async () => {
    const id = store('Versioned');
    const records = new SqliteMemoryRecordsProvider(db);
    const builder = new ContextBuilder({ eventLogger: { getEvents: () => [] } as never, memoryRecords: records });
    await builder.extractMemory(
      session([{ type: 'memory_store', memory_store_id: id, mount_path: RW }]),
      { type: 'user.message', content: [{ type: 'text', text: 'session-owned fact' }] } as never,
    );
    const version = db.prepare('SELECT session_id FROM memory_versions WHERE store_id = ?').get(id) as { session_id: string };
    expect(version.session_id).toBe('sess_test');
  });
});
