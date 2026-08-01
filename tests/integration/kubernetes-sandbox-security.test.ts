/**
 * Kubernetes sandbox behavior that only a real cluster can confirm.
 *
 * The unit tests assert what the provider *sends* (manifest shape, argv, path
 * resolution). These assert what the cluster and the Pod actually *do* with it:
 * whether the API token is really absent, whether resource limits really land
 * on the container, and whether a path escape is really refused before it
 * touches the filesystem.
 *
 * Skipped unless `kubectl` can reach a cluster. See the sibling
 * kubernetes-sandbox test for the environment overrides.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KubernetesSandboxProvider,
  isKubernetesAvailable,
  podNameForSession,
} from '@/sandbox/kubernetes-provider.js';
import type { EnvironmentConfig, SandboxInstance } from '@/types/sandbox.js';

const NAMESPACE = process.env.MANAGED_AGENTS_TEST_K8S_NAMESPACE ?? 'default';
const IMAGE = process.env.MANAGED_AGENTS_TEST_K8S_IMAGE ?? 'busybox:stable';

const clusterTests = isKubernetesAvailable() ? describe : describe.skip;

function envConfig(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return {
    name: 'kubernetes',
    sandbox_provider: 'kubernetes',
    timeout: 120,
    image: IMAGE,
    kubernetes: { namespace: NAMESPACE },
    ...overrides,
  };
}

function podJson(sessionId: string, jsonPath: string): string {
  const result = spawnSync(
    'kubectl',
    ['get', 'pod', podNameForSession(sessionId), '-n', NAMESPACE, '-o', `jsonpath=${jsonPath}`],
    { encoding: 'utf-8', timeout: 15_000 },
  );
  return result.stdout.trim();
}

async function withSandbox(
  sessionId: string,
  config: EnvironmentConfig,
  body: (sandbox: SandboxInstance) => Promise<void>,
): Promise<void> {
  const sandbox = await new KubernetesSandboxProvider().provision(sessionId, config);
  try {
    await body(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}

clusterTests('KubernetesSandboxProvider security defaults on a live cluster', () => {
  it('creates the Pod without a mounted Kubernetes API token', async () => {
    const sessionId = `sess_k8s_notoken_${Date.now()}`;
    await withSandbox(sessionId, envConfig(), async (sandbox) => {
      expect(podJson(sessionId, '{.spec.automountServiceAccountToken}')).toBe('false');

      // The decisive check: the ServiceAccount token directory is what a
      // process inside the Pod would read to call the API server.
      const mounted = await sandbox.execute('ls /var/run/secrets/kubernetes.io/serviceaccount 2>&1; echo "exit=$?"');
      expect(mounted.stdout).toContain('exit=1');

      const restartPolicy = podJson(sessionId, '{.spec.restartPolicy}');
      expect(restartPolicy).toBe('Never');
    });
  }, 240_000);

  it('mounts a token only when an Environment names a ServiceAccount', async () => {
    const sessionId = `sess_k8s_token_${Date.now()}`;
    await withSandbox(
      sessionId,
      envConfig({ kubernetes: { namespace: NAMESPACE, service_account: 'default' } }),
      async (sandbox) => {
        expect(podJson(sessionId, '{.spec.automountServiceAccountToken}')).toBe('true');
        expect(podJson(sessionId, '{.spec.serviceAccountName}')).toBe('default');
        const token = await sandbox.execute('cat /var/run/secrets/kubernetes.io/serviceaccount/namespace');
        expect(token.exitCode).toBe(0);
        expect(token.stdout.trim()).toBe(NAMESPACE);
      },
    );
  }, 240_000);

  it('applies Environment resource limits to the container', async () => {
    const sessionId = `sess_k8s_limits_${Date.now()}`;
    await withSandbox(
      sessionId,
      envConfig({ resources: { memory: '128Mi', cpu: 0.5 } }),
      async () => {
        expect(podJson(sessionId, '{.spec.containers[0].resources.limits.memory}')).toBe('128Mi');
        expect(podJson(sessionId, '{.spec.containers[0].resources.limits.cpu}')).toBe('500m');
      },
    );
  }, 240_000);

  it('labels the Pod so leftovers can be reaped by owner', async () => {
    const sessionId = `sess_k8s_labels_${Date.now()}`;
    await withSandbox(sessionId, envConfig(), async () => {
      expect(podJson(sessionId, '{.metadata.labels.app\\.kubernetes\\.io/managed-by}')).toBe('managed-agents');
      const selected = spawnSync(
        'kubectl',
        ['get', 'pods', '-n', NAMESPACE, '-l', 'app.kubernetes.io/managed-by=managed-agents', '-o', 'name'],
        { encoding: 'utf-8', timeout: 15_000 },
      );
      expect(selected.stdout).toContain(podNameForSession(sessionId));
    });
  }, 240_000);
});

clusterTests('KubernetesSandboxProvider file tools on a live cluster', () => {
  it('confines file paths to the workspace', async () => {
    const sessionId = `sess_k8s_paths_${Date.now()}`;
    await withSandbox(sessionId, envConfig(), async (sandbox) => {
      // Rejected before any kubectl call, so nothing outside /workspace is
      // created or read even though the container would permit it.
      await expect(sandbox.writeFile('../escaped.txt', 'nope')).rejects.toThrow(/escapes sandbox workspace/);
      await expect(sandbox.readFile('/etc/hostname')).rejects.toThrow(/escapes sandbox workspace/);
      await expect(sandbox.listFiles('../..')).rejects.toThrow(/escapes sandbox workspace/);

      const outside = await sandbox.execute('ls /escaped.txt 2>&1; echo "exit=$?"');
      expect(outside.stdout).toContain('exit=1');
    });
  }, 240_000);

  it('round-trips nested paths and preserves file names with spaces', async () => {
    const sessionId = `sess_k8s_names_${Date.now()}`;
    await withSandbox(sessionId, envConfig(), async (sandbox) => {
      await sandbox.writeFile('nested/dir/report card.txt', 'grade: A');
      expect(await sandbox.readFile('nested/dir/report card.txt')).toBe('grade: A');

      // `find -print0` is what keeps a name containing a space intact; a
      // newline-split, per-line trim implementation corrupts it.
      const files = await sandbox.listFiles('.');
      expect(files).toContain('nested/dir/report card.txt');
    });
  }, 240_000);

  it('reports a non-zero exit code and stderr from a failing command', async () => {
    const sessionId = `sess_k8s_exit_${Date.now()}`;
    await withSandbox(sessionId, envConfig(), async (sandbox) => {
      const result = await sandbox.execute('echo to-stderr 1>&2; exit 42');
      expect(result.exitCode).toBe(42);
      expect(result.stderr).toContain('to-stderr');
      expect(result.timedOut).toBe(false);
    });
  }, 240_000);

  it('keeps two sessions on separate Pods and separate workspaces', async () => {
    const first = `sess_k8s_iso_a_${Date.now()}`;
    const second = `sess_k8s_iso_b_${Date.now()}`;
    await withSandbox(first, envConfig(), async (a) => {
      await withSandbox(second, envConfig(), async (b) => {
        expect(podNameForSession(first)).not.toBe(podNameForSession(second));
        await a.writeFile('only-in-a.txt', 'a');
        expect(await b.listFiles('.')).not.toContain('only-in-a.txt');
      });
    });
  }, 300_000);
});
