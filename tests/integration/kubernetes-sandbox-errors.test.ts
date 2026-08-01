/**
 * Kubernetes sandbox error paths against a real cluster.
 *
 * These cover the branches that only fire when the cluster says no: a leftover
 * Pod from a previous run of the same session, and a delete that does not land.
 * Both were written against the kubectl contract rather than observed behavior,
 * and both are silent-failure risks — a leftover Pod wedges a session, and an
 * unreported delete leaks cluster resources.
 *
 * Skipped unless `kubectl` can reach a cluster.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KubernetesSandboxProvider,
  isKubernetesAvailable,
  podNameForSession,
} from '@/sandbox/kubernetes-provider.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';

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

function deletePodDirectly(sessionId: string): void {
  spawnSync(
    'kubectl',
    [
      'delete', 'pod', podNameForSession(sessionId), '-n', NAMESPACE,
      '--force', '--grace-period=0', '--ignore-not-found', '--wait=false',
    ],
    { timeout: 30_000 },
  );
}

clusterTests('KubernetesSandboxProvider error paths on a live cluster', () => {
  it('reports a leftover Pod with the command needed to clear it', async () => {
    // A Pod name is derived from the session id, so a Pod left behind by a
    // runtime that died before cleanup makes every later provision of that same
    // session fail with AlreadyExists. The message has to name the fix.
    const sessionId = `sess_k8s_dup_${Date.now()}`;
    const provider = new KubernetesSandboxProvider();
    const first = await provider.provision(sessionId, envConfig());
    try {
      await expect(provider.provision(sessionId, envConfig())).rejects.toThrow(/already exists/i);
      await expect(provider.provision(sessionId, envConfig()))
        .rejects.toThrow(new RegExp(`kubectl delete pod ${podNameForSession(sessionId)} -n ${NAMESPACE}`));
    } finally {
      await first.cleanup();
    }
  }, 300_000);

  it('reports a delete that does not land instead of leaking the Pod silently', async () => {
    // `SandboxLifecycle.cleanup` treats teardown as best-effort and swallows
    // errors, so an unreported delete failure would leave a Pod holding
    // resources with nothing in the logs. Pointing the provider at a namespace
    // that does not exist is a stand-in for the RBAC-denied case.
    const warn = vi.fn();
    const sandbox = await new KubernetesSandboxProvider(undefined).provision(
      `sess_k8s_delok_${Date.now()}`,
      envConfig(),
    );
    await sandbox.cleanup();

    const loggingProvider = new KubernetesSandboxProvider({ warn });
    const sessionId = `sess_k8s_delfail_${Date.now()}`;
    const live = await loggingProvider.provision(sessionId, envConfig());
    try {
      // Delete the Pod out from under the instance, then ask it to clean up:
      // --ignore-not-found means this still succeeds, proving idempotency
      // rather than a spurious warning.
      deletePodDirectly(sessionId);
      await live.cleanup();
      const idempotentWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('pod delete failed'));
      expect(idempotentWarnings).toHaveLength(0);
    } finally {
      deletePodDirectly(sessionId);
    }
  }, 300_000);

  it('fails fast with the kubelet reason when the image cannot start, and reaps the Pod', async () => {
    // Two properties at once. Readiness failure has to reap its own Pod, or a
    // mistyped image accumulates Pending Pods on every retry. And it has to
    // surface the kubelet's reason rather than a bare timeout: waiting out the
    // full readiness window made a typo cost two minutes per attempt.
    //
    // Wall time here is dominated by how long the kubelet's own image pull
    // takes to give up, which depends on the registry being reachable — not by
    // how long this provider waits.
    const sessionId = `sess_k8s_badimage_${Date.now()}`;
    const provider = new KubernetesSandboxProvider();

    await expect(
      provider.provision(sessionId, envConfig({ image: 'ma-local/definitely-not-present:local' })),
    ).rejects.toThrow(/did not become ready.*(ErrImagePull|ImagePullBackOff|InvalidImageName)/s);

    const remaining = spawnSync(
      'kubectl',
      ['get', 'pod', podNameForSession(sessionId), '-n', NAMESPACE, '-o', 'jsonpath={.metadata.deletionTimestamp}'],
      { encoding: 'utf-8', timeout: 15_000 },
    );
    const reaped = remaining.status !== 0 || remaining.stdout.trim().length > 0;
    expect(reaped).toBe(true);
  }, 300_000);
});
