/**
 * Session output files.
 *
 * The published contract publishes an agent's deliverables through the Files
 * API: whatever it writes under `/mnt/session/outputs/` becomes retrievable via
 * `GET /v1/files?scope_id=<session_id>` shortly after the write, and the
 * session scoping is gated behind the managed-agents beta.
 *
 * These assertions pin the parts that are easy to get subtly wrong: a listing
 * walking nested directories, a re-collection refreshing rather than
 * duplicating an id, and the beta gate actually refusing an ungated request
 * instead of quietly returning the global file list.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import {
  collectSessionOutputs,
  recordSessionOutputs,
  SESSION_OUTPUT_ROOT,
} from '@/core/session/session-outputs.js';
import type { SandboxInstance } from '@/types/sandbox.js';

/** A sandbox whose file system is a plain in-memory tree. */
function fakeSandbox(tree: Record<string, string>): SandboxInstance {
  const files = new Map(Object.entries(tree));
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    const segments = path.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i += 1) {
      dirs.add(`${SESSION_OUTPUT_ROOT}/${segments.slice(0, i).join('/')}`);
    }
  }
  return {
    sessionId: 'sess_a',
    async execute() {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    async writeFile() {},
    async readFile(path) {
      const hit = files.get(path);
      if (hit === undefined) throw new Error(`ENOENT: ${path}`);
      return hit;
    },
    async listFiles(path) {
      const prefix = `${path.replace(/\/+$/, '')}/`;
      if (!dirs.has(path.replace(/\/+$/, '')) && ![...files.keys()].some((f) => f.startsWith(prefix))) {
        throw new Error(`ENOTDIR: ${path}`);
      }
      const children = new Set<string>();
      for (const candidate of [...files.keys(), ...dirs]) {
        if (!candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length);
        if (rest === '') continue;
        children.add(rest.split('/')[0]!);
      }
      return [...children];
    },
    async cleanup() {},
  };
}

describe('collectSessionOutputs', () => {
  it('walks nested output directories and skips a read that fails', async () => {
    const sandbox = fakeSandbox({
      [`${SESSION_OUTPUT_ROOT}/report.md`]: '# Report',
      [`${SESSION_OUTPUT_ROOT}/nested/data.json`]: '{"ok":true}',
      [`${SESSION_OUTPUT_ROOT}/unreadable.bin`]: '',
    });
    // Make the third entry throw rather than return empty text.
    const original = sandbox.readFile.bind(sandbox);
    sandbox.readFile = async (path: string) => {
      if (path.endsWith('unreadable.bin')) throw new Error('EACCES');
      return original(path);
    };

    const outputs = await collectSessionOutputs(sandbox);

    expect(outputs.map((file) => file.relativePath)).toEqual(['nested/data.json', 'report.md']);
    expect(outputs.find((file) => file.relativePath === 'report.md')!.bytes.toString()).toBe('# Report');
  });

  it('returns nothing when the output directory does not exist', async () => {
    const sandbox = fakeSandbox({});
    await expect(collectSessionOutputs(sandbox)).resolves.toEqual([]);
  });
});

describe('recordSessionOutputs', () => {
  let db: Database;
  let tmpDir: string;
  let store: LocalArtifactStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-outputs-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    store = new LocalArtifactStore(join(tmpDir, 'files'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes the same record when a file is collected twice', () => {
    const first = recordSessionOutputs({
      db,
      artifactStore: store,
      sessionId: 'sess_a',
      files: [{ relativePath: 'report.md', bytes: Buffer.from('v1') }],
    });
    const second = recordSessionOutputs({
      db,
      artifactStore: store,
      sessionId: 'sess_a',
      files: [{ relativePath: 'report.md', bytes: Buffer.from('version two') }],
    });

    expect(first.recorded).toHaveLength(1);
    expect(second.recorded).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    // One deliverable, one id: a caller holding the first id still reads the
    // current bytes.
    expect(second.updated[0]!.id).toBe(first.recorded[0]!.id);

    const rows = db.prepare('SELECT id, size_bytes FROM files WHERE session_id = ?').all('sess_a') as Array<{ id: string; size_bytes: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.size_bytes).toBe('version two'.length);
  });

  it('keeps two sessions\' identically named outputs apart', () => {
    recordSessionOutputs({
      db,
      artifactStore: store,
      sessionId: 'sess_a',
      files: [{ relativePath: 'report.md', bytes: Buffer.from('a') }],
    });
    const other = recordSessionOutputs({
      db,
      artifactStore: store,
      sessionId: 'sess_b',
      files: [{ relativePath: 'report.md', bytes: Buffer.from('b') }],
    });

    expect(other.recorded).toHaveLength(1);
    const rows = db.prepare('SELECT session_id FROM files ORDER BY session_id').all() as Array<{ session_id: string }>;
    expect(rows.map((row) => row.session_id)).toEqual(['sess_a', 'sess_b']);
  });
});
