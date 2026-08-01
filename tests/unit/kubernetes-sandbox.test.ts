/**
 * KubernetesSandboxProvider — naming, namespace validation, and Pod manifest.
 *
 * These cover the parts that decide what gets sent to a cluster, so they run
 * without one. Live Pod execution is covered by
 * tests/integration/kubernetes-sandbox.test.ts, which skips when no cluster is
 * reachable.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { testRuntimeSettingsArea } from '@/core/settings/test.js';
import {
  KubernetesSandboxProvider,
  buildConnectionArgs,
  buildExecArgv,
  buildPodManifest,
  podNameForSession,
  resolveKubernetesNamespace,
  resolveWorkspacePath,
} from '@/sandbox/kubernetes-provider.js';
import type { EnvironmentConfig, KubernetesEnvironmentConfig } from '@/types/sandbox.js';

/** RFC 1123 subdomain, the constraint Kubernetes applies to Pod names. */
const RFC1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function manifestFor(
  config: Partial<EnvironmentConfig> = {},
  settings: KubernetesEnvironmentConfig = {},
  sessionId = 'sess_abc123',
) {
  return buildPodManifest({
    podName: podNameForSession(sessionId),
    namespace: resolveKubernetesNamespace(settings.namespace),
    sessionId,
    config: { name: 'k8s', sandbox_provider: 'kubernetes', ...config },
    settings,
  }) as {
    metadata: { name: string; namespace: string; labels: Record<string, string> };
    spec: {
      restartPolicy: string;
      automountServiceAccountToken: boolean;
      serviceAccountName?: string;
      containers: Array<{
        name: string;
        image: string;
        command: string[];
        args: string[];
        workingDir: string;
        resources?: { limits: Record<string, string> };
      }>;
    };
  };
}

describe('KubernetesSandboxProvider', () => {
  it('declares its type and capabilities', () => {
    const provider = new KubernetesSandboxProvider();
    expect(provider.type).toBe('kubernetes');
    expect(provider.capabilities).toMatchObject({
      isolatedExecution: true,
      // Files move via `kubectl cp`, so the snapshot manager has no host path.
      hostFilesystem: false,
      resourceLimits: true,
      streamingExec: false,
    });
  });
});

describe('podNameForSession', () => {
  it('produces an RFC 1123 name from a session id containing invalid characters', () => {
    const name = podNameForSession('sess_Abc_123');
    expect(name).toMatch(RFC1123_SUBDOMAIN);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('is deterministic for the same session', () => {
    expect(podNameForSession('sess_abc')).toBe(podNameForSession('sess_abc'));
  });

  it('keeps distinct sessions distinct after sanitization', () => {
    // Both slugify to `sess-a-b`; only the appended digest keeps them apart, so
    // two sessions can never collide onto one Pod.
    const first = podNameForSession('sess_a_b');
    const second = podNameForSession('sess-a-b');
    expect(first).not.toBe(second);
    expect(first).toMatch(RFC1123_SUBDOMAIN);
    expect(second).toMatch(RFC1123_SUBDOMAIN);
  });

  it('stays within the name limit for a very long session id', () => {
    const name = podNameForSession(`sess_${'x'.repeat(200)}`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(RFC1123_SUBDOMAIN);
  });

  it('still yields a valid name when the id sanitizes to nothing', () => {
    const name = podNameForSession('___');
    expect(name).toMatch(RFC1123_SUBDOMAIN);
  });
});

describe('resolveKubernetesNamespace', () => {
  it('defaults to the default namespace', () => {
    expect(resolveKubernetesNamespace(undefined)).toBe('default');
    expect(resolveKubernetesNamespace('   ')).toBe('default');
  });

  it('accepts a valid RFC 1123 label', () => {
    expect(resolveKubernetesNamespace('agent-sandboxes')).toBe('agent-sandboxes');
  });

  it.each([
    ['Agents', 'uppercase'],
    ['agents_1', 'underscore'],
    ['-agents', 'leading dash'],
    ['agents-', 'trailing dash'],
    ['a'.repeat(64), 'too long'],
  ])('rejects %s (%s)', (value) => {
    expect(() => resolveKubernetesNamespace(value)).toThrow(/Invalid Kubernetes namespace/);
  });
});

describe('buildPodManifest', () => {
  it('runs a plain command host that does not restart', () => {
    const manifest = manifestFor();
    const container = manifest.spec.containers[0];
    expect(manifest.spec.restartPolicy).toBe('Never');
    // The image entrypoint is overridden so the Pod stays alive for `kubectl
    // exec` regardless of what the image declares.
    expect(container.command).toEqual(['sleep']);
    expect(container.args).toEqual(['infinity']);
    expect(container.workingDir).toBe('/workspace');
    expect(container.image).toBe('node:22-slim');
  });

  it('uses the configured image', () => {
    expect(manifestFor({ image: 'python:3.12-slim' }).spec.containers[0].image).toBe('python:3.12-slim');
  });

  it('does not mount an API token unless a ServiceAccount is configured', () => {
    // Otherwise agent-authored commands could call the Kubernetes API with the
    // namespace's default token from inside the sandbox.
    const manifest = manifestFor();
    expect(manifest.spec.automountServiceAccountToken).toBe(false);
    expect(manifest.spec.serviceAccountName).toBeUndefined();
  });

  it('mounts a token only for an explicitly configured ServiceAccount', () => {
    const manifest = manifestFor({}, { service_account: 'agent-runner' });
    expect(manifest.spec.automountServiceAccountToken).toBe(true);
    expect(manifest.spec.serviceAccountName).toBe('agent-runner');
  });

  it('maps resource limits onto the container', () => {
    const manifest = manifestFor({ resources: { memory: '512Mi', cpu: 1.5 } });
    expect(manifest.spec.containers[0].resources).toEqual({ limits: { memory: '512Mi', cpu: '1.5' } });
  });

  it('omits the resources block when no limits are configured', () => {
    expect(manifestFor().spec.containers[0].resources).toBeUndefined();
  });

  it('labels the Pod with its owner and session for identification', () => {
    const manifest = manifestFor({}, {}, 'sess_abc123');
    expect(manifest.metadata.labels).toMatchObject({
      'app.kubernetes.io/managed-by': 'managed-agents',
      'managed-agents/session-id': 'sess_abc123',
    });
  });

  it('sanitizes operator-supplied label values and cannot override owner labels', () => {
    const manifest = manifestFor({}, {
      labels: { team: 'platform/core', 'app.kubernetes.io/managed-by': 'someone-else' },
    });
    expect(manifest.metadata.labels.team).toBe('platform-core');
    expect(manifest.metadata.labels['app.kubernetes.io/managed-by']).toBe('managed-agents');
  });

  it('places the Pod in the resolved namespace', () => {
    const manifest = manifestFor({}, { namespace: 'agent-sandboxes' });
    expect(manifest.metadata.namespace).toBe('agent-sandboxes');
  });
});

describe('buildConnectionArgs', () => {
  it('is empty when neither kubeconfig nor context is configured', () => {
    expect(buildConnectionArgs({})).toEqual([]);
    expect(buildConnectionArgs({ kubeconfig: '  ', context: '' })).toEqual([]);
  });

  it('pins both kubeconfig and context when configured', () => {
    expect(buildConnectionArgs({ kubeconfig: '/tmp/kubeconfig', context: 'staging' })).toEqual([
      '--kubeconfig=/tmp/kubeconfig',
      '--context=staging',
    ]);
  });
});

describe('buildExecArgv', () => {
  const base = { connection: [], namespace: 'agents', podName: 'ma-pod-abcd1234' };

  it('separates kubectl flags from the container command with --', () => {
    const argv = buildExecArgv({ ...base, command: 'echo hi' });
    const separator = argv.indexOf('--');
    expect(separator).toBeGreaterThan(-1);
    // Everything kubectl interprets comes before `--`; the shell invocation
    // comes after it, so an agent command starting with a dash cannot be read
    // as a kubectl flag.
    expect(argv.slice(0, separator)).toEqual(['exec', '-n', 'agents', 'ma-pod-abcd1234']);
    expect(argv[separator + 1]).toBe('/bin/sh');
    expect(argv[separator + 2]).toBe('-c');
  });

  it('runs the command in the workspace by default', () => {
    const argv = buildExecArgv({ ...base, command: 'echo hi' });
    expect(argv.at(-1)).toBe(`cd '/workspace' && echo hi`);
  });

  it('resolves a relative cwd under the workspace', () => {
    const argv = buildExecArgv({ ...base, command: 'ls', options: { cwd: 'src/lib' } });
    expect(argv.at(-1)).toBe(`cd '/workspace/src/lib' && ls`);
  });

  it('honors an absolute cwd as given', () => {
    const argv = buildExecArgv({ ...base, command: 'ls', options: { cwd: '/etc' } });
    expect(argv.at(-1)).toBe(`cd '/etc' && ls`);
  });

  it('exports environment variables before the command', () => {
    const argv = buildExecArgv({ ...base, command: 'printenv A', options: { env: { A: 'b c' } } });
    expect(argv.at(-1)).toBe(`export A='b c'; cd '/workspace' && printenv A`);
  });

  it('quotes an environment value that tries to close the quoting', () => {
    // A value carrying a single quote must not be able to break out of its
    // quotes and append another command to the in-container shell string.
    const argv = buildExecArgv({ ...base, command: 'true', options: { env: { A: `x'; rm -rf /; #` } } });
    const shellString = argv.at(-1)!;
    expect(shellString).toContain(`export A='x'\\''; rm -rf /; #'`);
    expect(shellString).toMatch(/&& true$/);
  });

  it('prepends connection flags ahead of the subcommand', () => {
    const argv = buildExecArgv({
      ...base,
      connection: ['--kubeconfig=/tmp/kc', '--context=staging'],
      command: 'true',
    });
    expect(argv.slice(0, 3)).toEqual(['--kubeconfig=/tmp/kc', '--context=staging', 'exec']);
  });
});

describe('buildExecArgv shell string against a real shell', () => {
  // The argv assertions above pin the string's shape; these run it through an
  // actual /bin/sh so the quoting is verified by a shell rather than by the
  // test's own expectation. The container runs the identical string.
  function runBuiltCommand(command: string, options?: { cwd?: string; env?: Record<string, string> }) {
    const argv = buildExecArgv({
      connection: [],
      namespace: 'agents',
      podName: 'ma-pod-abcd1234',
      command,
      // An absolute cwd keeps the generated `cd` valid on the host, where
      // /workspace does not exist.
      options: { cwd: '/tmp', ...options },
    });
    const shellString = argv.at(-1)!;
    return spawnSync('/bin/sh', ['-c', shellString], { encoding: 'utf-8', timeout: 10_000 });
  }

  it('produces a runnable command that lands in the requested directory', () => {
    const result = runBuiltCommand('pwd');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('delivers an environment value containing spaces and quotes intact', () => {
    const value = `x'; echo INJECTED; #`;
    const result = runBuiltCommand('printf %s "$A"', { env: { A: value } });
    expect(result.status).toBe(0);
    // The whole value arrives as data. If quoting were wrong, the embedded
    // `echo INJECTED` would have run as a separate command instead.
    expect(result.stdout).toBe(value);
    expect(result.stdout).not.toContain('INJECTED\n');
  });

  it('propagates the command exit code', () => {
    expect(runBuiltCommand('exit 7').status).toBe(7);
  });
});

describe('resolveWorkspacePath', () => {
  // File-tool paths come straight from model output, so they must stay inside
  // the workspace. The container is the real boundary, but the local provider
  // enforces the same rule and the tools should not mean three different things
  // on three backends.
  it('resolves a relative path under the workspace', () => {
    expect(resolveWorkspacePath('a/b.txt')).toBe('/workspace/a/b.txt');
    expect(resolveWorkspacePath('./a.txt')).toBe('/workspace/a.txt');
  });

  it('normalizes interior traversal that stays inside the workspace', () => {
    expect(resolveWorkspacePath('a/../b.txt')).toBe('/workspace/b.txt');
  });

  it('allows the workspace root itself', () => {
    expect(resolveWorkspacePath('.')).toBe('/workspace');
  });

  it.each([
    ['../etc/passwd'],
    ['a/../../etc/passwd'],
    ['/etc/shadow'],
    ['/workspace/../etc/passwd'],
  ])('rejects %s', (path) => {
    expect(() => resolveWorkspacePath(path)).toThrow(/escapes sandbox workspace/);
  });

  it('does not treat a sibling directory sharing the prefix as inside', () => {
    expect(() => resolveWorkspacePath('/workspace-other/x')).toThrow(/escapes sandbox workspace/);
  });
});

describe('buildPodManifest label keys', () => {
  it('drops label keys Kubernetes would reject rather than failing at provision', () => {
    const manifest = manifestFor({}, {
      labels: {
        'bad key!': 'v',
        'example.com/team': 'platform',
        '': 'empty',
      },
    });
    expect(manifest.metadata.labels['bad key!']).toBeUndefined();
    expect(manifest.metadata.labels['']).toBeUndefined();
    expect(manifest.metadata.labels['example.com/team']).toBe('platform');
  });
});

describe('kubernetes sandbox settings check', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function makeDb() {
    const directory = mkdtempSync(join(tmpdir(), 'ma-k8s-settings-test-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    return { db, directory };
  }

  const baseConfig = {
    schema_version: 1 as const,
    model: { vendor: 'openai' as const, api_key: 'k', options: {} },
    loop_engine: { provider: 'builtin' as const, options: { default_max_steps: 25 } },
    storage: {
      metadata: { provider: 'sqlite' as const, options: {} },
      artifacts: { provider: 'local' as const, options: { base_path: 'files' } },
    },
    memory: { enabled: false, provider: 'sqlite' as const, options: {} },
  };

  it('reports the namespace and the token posture, and fails on an unreachable cluster', async () => {
    // Previously this backend produced a single "not implemented" skip, so the
    // Console's Test action told an operator nothing at all about it.
    const { db, directory } = makeDb();
    try {
      const result = await testRuntimeSettingsArea({
        db,
        dataDir: directory,
        area: 'sandbox',
        config: {
          ...baseConfig,
          sandbox: {
            provider: 'kubernetes',
            options: { timeout_seconds: 300, namespace: 'agents', kubeconfig: '/nonexistent/kubeconfig' },
          },
        } as never,
      });

      expect(result.checks).toContainEqual(expect.objectContaining({
        name: 'namespace',
        status: 'ok',
      }));
      expect(result.checks).toContainEqual(expect.objectContaining({
        name: 'cluster_reachable',
        status: 'failed',
      }));
      expect(result.checks).toContainEqual(expect.objectContaining({
        name: 'service_account',
        message: expect.stringContaining('without a mounted Kubernetes API token'),
      }));
      expect(result).toMatchObject({ ok: false, area: 'sandbox', status: 'failed' });
    } finally {
      db.close();
    }
  }, 30_000);

  it('fails an invalid namespace without needing a cluster', async () => {
    const { db, directory } = makeDb();
    try {
      const result = await testRuntimeSettingsArea({
        db,
        dataDir: directory,
        area: 'sandbox',
        config: {
          ...baseConfig,
          sandbox: {
            provider: 'kubernetes',
            options: { timeout_seconds: 300, namespace: 'Not_Valid', kubeconfig: '/nonexistent/kubeconfig' },
          },
        } as never,
      });

      expect(result.checks).toContainEqual(expect.objectContaining({
        name: 'namespace',
        status: 'failed',
        message: expect.stringContaining('Invalid Kubernetes namespace'),
      }));
    } finally {
      db.close();
    }
  }, 30_000);
});
