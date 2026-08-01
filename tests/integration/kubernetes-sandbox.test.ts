/**
 * KubernetesSandboxProvider against a real cluster.
 *
 * Skipped unless `kubectl` can reach a cluster, mirroring how the Docker
 * provider's live tests skip without a daemon. Cluster runs create and delete a
 * Pod in the target namespace, so they are opt-in by environment rather than
 * part of the default local run.
 *
 * Namespace override: MANAGED_AGENTS_TEST_K8S_NAMESPACE (default: `default`).
 * Image override: MANAGED_AGENTS_TEST_K8S_IMAGE (default: busybox, which has
 * /bin/sh, find, and tar — the three things the provider needs).
 */

import { describe, it, expect } from 'vitest';
import {
  KubernetesSandboxProvider,
  isKubernetesAvailable,
  podNameForSession,
} from '@/sandbox/kubernetes-provider.js';
import { spawnSync } from 'node:child_process';

const NAMESPACE = process.env.MANAGED_AGENTS_TEST_K8S_NAMESPACE ?? 'default';
const IMAGE = process.env.MANAGED_AGENTS_TEST_K8S_IMAGE ?? 'busybox:stable';

const clusterTests = isKubernetesAvailable() ? describe : describe.skip;

clusterTests('KubernetesSandboxProvider with a reachable cluster', () => {
  it('provisions a Pod, executes, moves files, and deletes it', async () => {
    const sessionId = `sess_k8s_${Date.now()}`;
    const provider = new KubernetesSandboxProvider();
    const sandbox = await provider.provision(sessionId, {
      name: 'kubernetes',
      sandbox_provider: 'kubernetes',
      timeout: 120,
      image: IMAGE,
      kubernetes: { namespace: NAMESPACE },
    });

    try {
      const run = await sandbox.execute('echo hello-kubernetes');
      expect(run.exitCode).toBe(0);
      expect(run.stdout.trim()).toBe('hello-kubernetes');

      // Commands land in the workspace, not the container's default cwd.
      const pwd = await sandbox.execute('pwd');
      expect(pwd.stdout.trim()).toBe('/workspace');

      await sandbox.writeFile('nested/test.txt', 'in pod');
      expect(await sandbox.readFile('nested/test.txt')).toBe('in pod');

      const files = await sandbox.listFiles('.');
      expect(files).toContain('nested/test.txt');

      const failing = await sandbox.execute('exit 3');
      expect(failing.exitCode).toBe(3);
    } finally {
      await sandbox.cleanup();
    }

    // cleanup() is best-effort and asynchronous on the cluster side; assert the
    // delete was accepted rather than that the object is already gone.
    const remaining = spawnSync(
      'kubectl',
      ['get', 'pod', podNameForSession(sessionId), '-n', NAMESPACE, '-o', 'jsonpath={.metadata.deletionTimestamp}'],
      { encoding: 'utf-8', timeout: 15_000 },
    );
    const deleted = remaining.status !== 0 || remaining.stdout.trim().length > 0;
    expect(deleted).toBe(true);
  }, 240_000);

  it('reports a command timeout instead of hanging', async () => {
    const sessionId = `sess_k8s_timeout_${Date.now()}`;
    const provider = new KubernetesSandboxProvider();
    const sandbox = await provider.provision(sessionId, {
      name: 'kubernetes',
      sandbox_provider: 'kubernetes',
      timeout: 120,
      image: IMAGE,
      kubernetes: { namespace: NAMESPACE },
    });

    try {
      const result = await sandbox.execute('sleep 30', { timeout: 2_000 });
      expect(result.timedOut).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  }, 240_000);
});

describe('KubernetesSandboxProvider availability probe', () => {
  it('reports unavailable for an unreachable kubeconfig', () => {
    // A kubeconfig path that does not exist must read as unavailable rather
    // than throwing, so bootstrap can simply not register the backend.
    expect(isKubernetesAvailable('/nonexistent/kubeconfig-for-tests')).toBe(false);
  });
});
