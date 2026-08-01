import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { bootstrapRuntimeSandboxes } from '@/core/runtime/sandbox-bootstrap.js';

describe('runtime sandbox bootstrap', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function makeRuntime() {
    const directory = mkdtempSync(join(tmpdir(), 'ma-sandbox-bootstrap-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    return { db, dataDir: directory };
  }

  // Both external transports are stubbed in every case: leaving a probe to the
  // real environment would make the registered provider list depend on whether
  // the machine running the tests happens to have Docker or a cluster.
  it('always registers local and self-hosted sandbox providers', () => {
    const { db, dataDir } = makeRuntime();

    const result = bootstrapRuntimeSandboxes({
      db,
      dataDir,
      dockerAvailable: () => false,
      kubernetesAvailable: () => false,
    });

    expect(result.dockerAvailable).toBe(false);
    expect(result.kubernetesAvailable).toBe(false);
    expect(result.sandboxProvider.type).toBe('local');
    expect(result.sandboxRegistry.listTypes()).toEqual(['local', 'self_hosted']);
    expect(result.sandboxRegistry.get('local')).toBe(result.sandboxProvider);
    expect(result.sandboxRegistry.has('self_hosted')).toBe(true);
    db.close();
  });

  it('registers docker when the docker CLI is available', () => {
    const { db, dataDir } = makeRuntime();

    const result = bootstrapRuntimeSandboxes({
      db,
      dataDir,
      dockerAvailable: () => true,
      kubernetesAvailable: () => false,
    });

    expect(result.dockerAvailable).toBe(true);
    expect(result.sandboxRegistry.listTypes()).toEqual(['local', 'docker', 'self_hosted']);
    expect(result.sandboxRegistry.has('docker')).toBe(true);
    db.close();
  });

  it('registers kubernetes when a cluster is reachable', () => {
    const { db, dataDir } = makeRuntime();

    const result = bootstrapRuntimeSandboxes({
      db,
      dataDir,
      dockerAvailable: () => false,
      kubernetesAvailable: () => true,
    });

    expect(result.kubernetesAvailable).toBe(true);
    expect(result.sandboxRegistry.listTypes()).toEqual(['local', 'kubernetes', 'self_hosted']);
    expect(result.sandboxRegistry.capabilitiesOf('kubernetes')).toMatchObject({
      isolatedExecution: true,
      hostFilesystem: false,
      resourceLimits: true,
    });
    db.close();
  });

  it('does not register a backend whose transport is unavailable', () => {
    const { db, dataDir } = makeRuntime();

    const result = bootstrapRuntimeSandboxes({
      db,
      dataDir,
      dockerAvailable: () => false,
      kubernetesAvailable: () => false,
    });

    expect(result.sandboxRegistry.has('kubernetes')).toBe(false);
    expect(() => result.sandboxRegistry.get('kubernetes')).toThrow(/not available \(registered: local, self_hosted\)/);
    expect(() => result.sandboxRegistry.get('kubernetes')).toThrow(/kubectl/);
    db.close();
  });

  it('reports capabilities for every registered backend', () => {
    const { db, dataDir } = makeRuntime();

    const result = bootstrapRuntimeSandboxes({
      db,
      dataDir,
      dockerAvailable: () => true,
      kubernetesAvailable: () => true,
    });

    const described = Object.fromEntries(
      result.sandboxRegistry.describe().map((entry) => [entry.type, entry.capabilities]),
    );
    // Local is the only backend that exposes a host workspace, and the only
    // one that runs without isolation from the runtime host.
    expect(described.local).toMatchObject({ isolatedExecution: false, hostFilesystem: true });
    expect(described.docker).toMatchObject({ isolatedExecution: true, hostFilesystem: false });
    expect(described.kubernetes).toMatchObject({ isolatedExecution: true, hostFilesystem: false });
    expect(described.self_hosted).toMatchObject({ isolatedExecution: true, hostFilesystem: false });
    db.close();
  });
});
