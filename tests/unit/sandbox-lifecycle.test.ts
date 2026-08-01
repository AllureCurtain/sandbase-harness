import { describe, expect, it, vi } from 'vitest';
import { SandboxLifecycle } from '@/core/session/sandbox-lifecycle.js';
import {
  sandboxCapabilities,
  type EnvironmentConfig,
  type SandboxCapabilities,
  type SandboxInstance,
  type SandboxProvider,
} from '@/types/sandbox.js';
import { SandboxProviderRegistry, UnknownSandboxProviderError } from '@/sandbox/registry.js';
import type { Session } from '@/types/session.js';

function makeSandbox(sessionId: string, overrides: Partial<SandboxInstance> = {}): SandboxInstance {
  return {
    sessionId,
    async execute() {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    async writeFile() {},
    async readFile() {
      return '';
    },
    async listFiles() {
      return [];
    },
    async cleanup() {},
    ...overrides,
  };
}

function makeProvider(
  type: string,
  capabilities: Partial<SandboxCapabilities> = {},
  sandbox?: SandboxInstance,
): SandboxProvider {
  return {
    type,
    capabilities: sandboxCapabilities(capabilities),
    async provision(sessionId) {
      return sandbox ?? makeSandbox(sessionId);
    },
  };
}

function makeSession(id: string, environmentId: string): Session {
  return {
    id,
    agentId: 'agent_a',
    agentName: 'a',
    environmentId,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Session;
}

describe('SandboxLifecycle', () => {
  it('reuses one sandbox per session and cleans it up once', async () => {
    let provisionCount = 0;
    let cleanupCount = 0;
    const sandbox = makeSandbox('sess_1', {
      async cleanup() {
        cleanupCount += 1;
      },
    });
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities({ hostFilesystem: true }),
      async provision() {
        provisionCount += 1;
        return sandbox;
      },
    };
    const lifecycle = new SandboxLifecycle({ sandboxProvider: provider });
    const session = makeSession('sess_1', 'env_default');

    await expect(lifecycle.getOrProvision(session)).resolves.toBe(sandbox);
    await expect(lifecycle.getOrProvision(session)).resolves.toBe(sandbox);
    expect(provisionCount).toBe(1);

    await lifecycle.cleanup(session.id);
    await lifecycle.cleanup(session.id);
    expect(cleanupCount).toBe(1);
  });

  it('selects the sandbox provider from the session environment config', async () => {
    const registry = new SandboxProviderRegistry();
    const provisioned: string[] = [];
    const track = (type: string): SandboxProvider => ({
      type,
      capabilities: sandboxCapabilities({ isolatedExecution: type !== 'local' }),
      async provision(sessionId) {
        provisioned.push(type);
        return makeSandbox(sessionId);
      },
    });
    const localProvider = track('local');
    registry.register(localProvider);
    registry.register(track('self_hosted'));

    const lifecycle = new SandboxLifecycle({
      sandboxProvider: localProvider,
      sandboxRegistry: registry,
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'self_hosted',
        timeout: 300,
      }),
    });

    await lifecycle.getOrProvision(makeSession('sess_2', 'env_self_hosted'));
    expect(provisioned).toEqual(['self_hosted']);
  });

  it('fails loudly instead of downgrading to local when the backend is unavailable', async () => {
    // Regression guard: an Environment naming an isolated backend that is not
    // registered used to silently execute on the unsandboxed local provider.
    const registry = new SandboxProviderRegistry();
    const localProvider = makeProvider('local', { hostFilesystem: true });
    registry.register(localProvider);

    const lifecycle = new SandboxLifecycle({
      sandboxProvider: localProvider,
      sandboxRegistry: registry,
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'kubernetes',
        timeout: 300,
      }),
    });

    await expect(lifecycle.getOrProvision(makeSession('sess_3', 'env_k8s')))
      .rejects.toThrow(UnknownSandboxProviderError);
    await expect(lifecycle.getOrProvision(makeSession('sess_3', 'env_k8s')))
      .rejects.toThrow(/registered: local/);
  });

  it('rejects a mismatched provider even without a registry', async () => {
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local'),
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'docker',
        timeout: 300,
      }),
    });

    await expect(lifecycle.getOrProvision(makeSession('sess_4', 'env_docker')))
      .rejects.toThrow(UnknownSandboxProviderError);
  });

  it('skips snapshots on a backend without a host filesystem and reports why', async () => {
    const warn = vi.fn();
    const snapshots = { create: vi.fn(), restoreLatest: vi.fn() };
    const envConfig: EnvironmentConfig = {
      name: 'env_docker',
      sandbox_provider: 'docker',
      timeout: 300,
      snapshot: { enabled: true },
    };
    // The sandbox deliberately reports a hostWorkDir even though the backend
    // declares hostFilesystem:false. Without it the pre-existing
    // `&& sandbox.hostWorkDir` guard would skip snapshots on its own and this
    // test would pass with the capability gate deleted.
    const sandbox = makeSandbox('sess_5', { hostWorkDir: '/tmp/not-really-host' });
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('docker', { isolatedExecution: true, hostFilesystem: false }, sandbox),
      resolveEnvironmentConfig: () => envConfig,
      snapshots: snapshots as never,
      logger: { warn },
    });
    const session = makeSession('sess_5', 'env_docker');

    const provisioned = await lifecycle.getOrProvision(session);
    expect(provisioned.hostWorkDir).toBe('/tmp/not-really-host');
    lifecycle.snapshotAfterTurn(session, provisioned);

    expect(snapshots.restoreLatest).not.toHaveBeenCalled();
    expect(snapshots.create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('workspace snapshots requested'),
      expect.objectContaining({ sandbox_provider: 'docker', capability: 'hostFilesystem' }),
    );
  });

  it('snapshots when the backend exposes a host workspace', async () => {
    const snapshots = { create: vi.fn(), restoreLatest: vi.fn() };
    const sandbox = makeSandbox('sess_6', { hostWorkDir: '/tmp/ma-sess_6' });
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', { hostFilesystem: true }, sandbox),
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'local',
        timeout: 300,
        snapshot: { enabled: true },
      }),
      snapshots: snapshots as never,
    });
    const session = makeSession('sess_6', 'env_default');

    const provisioned = await lifecycle.getOrProvision(session);
    lifecycle.snapshotAfterTurn(session, provisioned);

    expect(snapshots.restoreLatest).toHaveBeenCalledWith('sess_6', '/tmp/ma-sess_6');
    expect(snapshots.create).toHaveBeenCalledWith('sess_6', '/tmp/ma-sess_6');
  });

  it('reports resource limits that the selected backend cannot enforce', async () => {
    const warn = vi.fn();
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', { hostFilesystem: true, resourceLimits: false }),
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'local',
        timeout: 300,
        resources: { memory: '512m', cpu: 1 },
      }),
      logger: { warn },
    });

    await lifecycle.getOrProvision(makeSession('sess_7', 'env_default'));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('resource limits requested'),
      expect.objectContaining({ capability: 'resourceLimits' }),
    );
  });

  it('reports missing isolation once per backend, not once per session', async () => {
    // Every local session would otherwise log the same notice, which on a
    // single-developer runtime is the normal case rather than an event.
    const warn = vi.fn();
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', { hostFilesystem: true }),
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'local',
        timeout: 300,
      }),
      logger: { warn },
    });

    await lifecycle.getOrProvision(makeSession('sess_8', 'env_default'));
    await lifecycle.getOrProvision(makeSession('sess_9', 'env_default'));
    await lifecycle.getOrProvision(makeSession('sess_10', 'env_default'));

    const isolationWarnings = warn.mock.calls.filter(([, fields]) =>
      (fields as Record<string, unknown> | undefined)?.capability === 'isolatedExecution');
    expect(isolationWarnings).toHaveLength(1);
  });

  it('reports config-driven gaps for each session that configures them', async () => {
    // Unlike the isolation notice, these come from the session's Environment,
    // so a second session asking for the same impossible thing is a separate
    // fact about a separate session.
    const warn = vi.fn();
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', { hostFilesystem: true, resourceLimits: false }),
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'local',
        timeout: 300,
        resources: { memory: '512m' },
      }),
      logger: { warn },
    });

    await lifecycle.getOrProvision(makeSession('sess_11', 'env_default'));
    await lifecycle.getOrProvision(makeSession('sess_12', 'env_default'));

    const limitWarnings = warn.mock.calls.filter(([, fields]) =>
      (fields as Record<string, unknown> | undefined)?.capability === 'resourceLimits');
    expect(limitWarnings).toHaveLength(2);
    expect(limitWarnings.map(([, fields]) => (fields as Record<string, unknown>).session_id))
      .toEqual(['sess_11', 'sess_12']);
  });
});

describe('SandboxLifecycle.provisionDetached', () => {
  it('provisions a sub-agent sandbox on the session backend, not the default one', async () => {
    // Regression guard: delegated sub-agents used to always get the local
    // provider, so a session configured for an isolated backend still ran its
    // sub-agent shell commands on the runtime host.
    const registry = new SandboxProviderRegistry();
    const provisioned: Array<{ type: string; sandboxId: string }> = [];
    const track = (type: string): SandboxProvider => ({
      type,
      capabilities: sandboxCapabilities({ isolatedExecution: type !== 'local' }),
      async provision(sandboxId) {
        provisioned.push({ type, sandboxId });
        return makeSandbox(sandboxId);
      },
    });
    const localProvider = track('local');
    registry.register(localProvider);
    registry.register(track('kubernetes'));

    const lifecycle = new SandboxLifecycle({
      sandboxProvider: localProvider,
      sandboxRegistry: registry,
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'kubernetes',
        timeout: 300,
      }),
    });
    const session = makeSession('sess_parent', 'env_k8s');

    await lifecycle.provisionDetached(session, 'subsess_child');

    expect(provisioned).toEqual([{ type: 'kubernetes', sandboxId: 'subsess_child' }]);
  });

  it('does not track the detached sandbox as the session sandbox', async () => {
    const sub = makeSandbox('subsess_child');
    const main = makeSandbox('sess_parent');
    let call = 0;
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities({ hostFilesystem: true }),
      async provision() {
        call += 1;
        return call === 1 ? sub : main;
      },
    };
    const lifecycle = new SandboxLifecycle({ sandboxProvider: provider });
    const session = makeSession('sess_parent', 'env_default');

    const detached = await lifecycle.provisionDetached(session, 'subsess_child');
    const bound = await lifecycle.getOrProvision(session);

    expect(detached).toBe(sub);
    // The session still provisions its own sandbox; the detached one is the
    // caller's to clean up.
    expect(bound).toBe(main);
  });

  it('fails loudly for a detached sandbox on an unavailable backend', async () => {
    const registry = new SandboxProviderRegistry();
    registry.register(makeProvider('local', { hostFilesystem: true }));

    const lifecycle = new SandboxLifecycle({
      sandboxProvider: makeProvider('local', { hostFilesystem: true }),
      sandboxRegistry: registry,
      resolveEnvironmentConfig: (environmentId) => ({
        name: environmentId,
        sandbox_provider: 'kubernetes',
        timeout: 300,
      }),
    });

    await expect(lifecycle.provisionDetached(makeSession('sess_p', 'env_k8s'), 'subsess_c'))
      .rejects.toThrow(UnknownSandboxProviderError);
  });
});
