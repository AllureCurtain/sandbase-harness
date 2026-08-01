/**
 * Kubernetes Sandbox Provider
 *
 * Runs agent commands inside a Pod in a Kubernetes cluster (one Pod per
 * session, 1:1 with the Session lifecycle). Same shape as the Docker provider,
 * one level up: `provision()` creates a long-lived Pod (`sleep infinity`),
 * `execute()` uses `kubectl exec`, files move with `kubectl cp`, and
 * `cleanup()` deletes the Pod.
 *
 * Transport: the `kubectl` CLI, not a Kubernetes client library. This mirrors
 * the Docker provider's use of the `docker` CLI, adds no npm dependency (so
 * there is no optional-dependency loading path to get wrong), and lets
 * `kubectl cp` handle tar streaming instead of reimplementing it. The cost is
 * that `kubectl` must be on PATH — the same class of assumption the Docker
 * provider already makes about `docker`.
 *
 * Container image requirements: `/bin/sh`, `find` (for listFiles), and `tar`
 * (for `kubectl cp`). The default image satisfies all three.
 *
 * Security defaults: the Pod is created with
 * `automountServiceAccountToken: false` unless an explicit ServiceAccount is
 * configured, so agent-authored commands cannot reach the Kubernetes API with
 * the namespace's default token. `restartPolicy: Never` keeps a crashed
 * session from silently restarting with a fresh filesystem.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import {
  sandboxCapabilities,
  type SandboxProvider,
  type SandboxInstance,
  type EnvironmentConfig,
  type KubernetesEnvironmentConfig,
  type ExecOptions,
  type ExecResult,
} from '@/types/sandbox.js';

const DEFAULT_IMAGE = 'node:22-slim';
const DEFAULT_NAMESPACE = 'default';
const WORKDIR = '/workspace';
/** Longest a Pod may take to reach Ready before provision fails. */
const READY_TIMEOUT_SECONDS = 120;
/** RFC 1123 label: lowercase alphanumerics and '-', max 63 chars. */
const RFC1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Kubernetes label keys: optional DNS-subdomain prefix plus a name segment. */
const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

/** Warn sink for cluster-side failures that would otherwise be invisible. */
export interface KubernetesProviderLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * True if `kubectl` is on PATH and an API server is reachable.
 *
 * Deliberately checks the cluster, not just the client: registering the
 * provider on the strength of a `kubectl` binary alone would let a session be
 * accepted and then fail at provision time. Mirrors `isDockerAvailable()`,
 * which also requires a reachable server rather than only the CLI.
 */
export function isKubernetesAvailable(kubeconfig?: string, context?: string): boolean {
  try {
    const r = spawnSync('kubectl', [...connectionArgs({ kubeconfig, context }), 'version', '-o', 'json'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Asynchronous counterpart to {@link isKubernetesAvailable}.
 *
 * The sync form exists for startup, which runs before the server accepts
 * traffic. Anything reachable from a request — the Settings connectivity check —
 * must not block the event loop while waiting on an API server.
 */
export async function probeKubernetesCluster(
  settings: Pick<KubernetesEnvironmentConfig, 'kubeconfig' | 'context'> = {},
): Promise<{ ok: boolean; message: string }> {
  const result = await runKubectl([...connectionArgs(settings), 'version', '-o', 'json'], { timeout: 5000 });
  if (result.exitCode === 0) {
    return { ok: true, message: 'kubectl reached the cluster API server.' };
  }
  if (result.timedOut) {
    return { ok: false, message: 'kubectl did not reach the cluster API server within 5 seconds.' };
  }
  return { ok: false, message: `kubectl could not reach a cluster: ${errorText(result)}` };
}

// ============================================================
// kubectl invocation
// ============================================================

interface KubectlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run `kubectl` without blocking the event loop.
 *
 * Every cluster call is asynchronous on purpose. `spawnSync` would stall the
 * whole runtime — HTTP routes, SSE broadcasts, and every other session's turn —
 * for as long as the call takes, and cluster calls are slow: waiting for a Pod
 * that has to pull an image routinely takes tens of seconds. The only
 * synchronous call left in this module is the startup availability probe, which
 * runs once before the server accepts traffic.
 */
function runKubectl(
  args: string[],
  options: { timeout: number; input?: string } = { timeout: 30_000 },
): Promise<KubectlResult> {
  return new Promise<KubectlResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const proc = spawn('kubectl', args, {
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, options.timeout);

    const finish = (result: KubectlResult) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on('close', (code) => finish({ exitCode: code ?? 1, stdout, stderr, timedOut }));
    proc.on('error', (err) => finish({ exitCode: 1, stdout, stderr: err.message, timedOut: false }));

    if (options.input !== undefined) {
      proc.stdin?.on('error', () => {
        // A closed stdin surfaces through the exit code; nothing to add here.
      });
      proc.stdin?.end(options.input);
    }
  });
}

export class KubernetesSandboxProvider implements SandboxProvider {
  readonly type = 'kubernetes';

  readonly capabilities = sandboxCapabilities({
    // The Pod's container is a real boundary against the runtime host, which
    // is typically not even the same machine.
    isolatedExecution: true,
    // The workspace lives in the Pod; files move via `kubectl cp`, so there is
    // no host path for the snapshot manager to read.
    hostFilesystem: false,
    // Enforced through the container's resources.limits.
    resourceLimits: true,
  });

  constructor(private readonly logger?: KubernetesProviderLogger) {}

  async provision(sessionId: string, config: EnvironmentConfig): Promise<SandboxInstance> {
    const settings = config.kubernetes ?? {};
    const namespace = resolveKubernetesNamespace(settings.namespace);
    const podName = podNameForSession(sessionId);
    const connection = connectionArgs(settings);
    const manifest = buildPodManifest({ podName, namespace, sessionId, config, settings });

    const create = await runKubectl(
      [...connection, 'create', '-n', namespace, '-f', '-', '-o', 'name'],
      { timeout: 30_000, input: JSON.stringify(manifest) },
    );
    if (create.exitCode !== 0) {
      // A Pod name is derived from the session id, so a leftover Pod from a
      // previous run of the same session (delete denied by RBAC, runtime killed
      // before cleanup) would otherwise wedge that session permanently behind
      // an AlreadyExists error. Say so, and say how to clear it.
      if (/already exists/i.test(errorText(create))) {
        throw new Error(
          `pod ${podName} already exists in namespace ${namespace}. A previous run of this session did not clean up. `
          + `Remove it with: kubectl delete pod ${podName} -n ${namespace}`,
        );
      }
      throw new Error(`kubectl create pod failed: ${errorText(create)}`);
    }

    const ready = await waitForPodReady({ connection, namespace, podName });
    if (!ready.ok) {
      // Leaving a Pending/ImagePullBackOff Pod behind would leak cluster
      // resources for a session that never started.
      await deletePod({ connection, namespace, podName, logger: this.logger, reason: 'readiness_failed' });
      throw new Error(`pod ${podName} did not become ready: ${ready.reason}`);
    }

    return new KubernetesSandboxInstance(sessionId, podName, namespace, connection, this.logger);
  }
}

class KubernetesSandboxInstance implements SandboxInstance {
  constructor(
    readonly sessionId: string,
    private readonly podName: string,
    private readonly namespace: string,
    private readonly connection: string[],
    private readonly logger?: KubernetesProviderLogger,
  ) {}

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    const timeout = options?.timeout ?? 300_000;
    const args = buildExecArgv({
      connection: this.connection,
      namespace: this.namespace,
      podName: this.podName,
      command,
      options,
    });

    return new Promise<ExecResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let done = false;

      const proc = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeout);

      proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          resolve({ exitCode: 1, stdout, stderr: err.message, timedOut: false });
        }
      });
    });
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const staging = mkdtempSync(join(tmpdir(), 'ma-kcp-'));
    try {
      const localFile = join(staging, 'file');
      writeFileSync(localFile, content);
      const target = resolveWorkspacePath(path);
      const mkdir = await this.execute(`mkdir -p ${shellQuote(parentDir(target))}`);
      if (mkdir.exitCode !== 0) {
        throw new Error(`could not create parent directory for ${path}: ${mkdir.stderr}`);
      }
      const cp = await runKubectl(
        [...this.connection, 'cp', localFile, `${this.namespace}/${this.podName}:${target}`],
        { timeout: 30_000 },
      );
      if (cp.exitCode !== 0) throw new Error(`kubectl cp failed: ${errorText(cp)}`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async readFile(path: string): Promise<string> {
    const staging = mkdtempSync(join(tmpdir(), 'ma-kcp-'));
    try {
      const localFile = join(staging, 'file');
      const cp = await runKubectl(
        [...this.connection, 'cp', `${this.namespace}/${this.podName}:${resolveWorkspacePath(path)}`, localFile],
        { timeout: 30_000 },
      );
      if (cp.exitCode !== 0) throw new Error(`kubectl cp failed: ${errorText(cp)}`);
      return readFileSync(localFile, 'utf-8');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async listFiles(path: string): Promise<string[]> {
    const target = resolveWorkspacePath(path);
    // NUL-delimited so file names containing whitespace or newlines survive;
    // splitting on newline would corrupt them.
    const r = await this.execute(`find ${shellQuote(target)} -type f -print0`);
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry.startsWith(`${WORKDIR}/`) ? entry.slice(WORKDIR.length + 1) : entry));
  }

  async cleanup(): Promise<void> {
    await deletePod({
      connection: this.connection,
      namespace: this.namespace,
      podName: this.podName,
      logger: this.logger,
      reason: 'session_cleanup',
    });
  }
}

/**
 * Container `waiting` reasons that will not resolve on their own.
 *
 * A missing image, an unparseable image reference, or a bad container config
 * keeps the kubelet retrying until something changes outside the cluster. There
 * is no point holding the session for the full readiness timeout.
 */
const TERMINAL_WAITING_REASONS = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'ImageInspectError',
  'RegistryUnavailable',
  'CreateContainerConfigError',
  'CreateContainerError',
  'CrashLoopBackOff',
]);

interface PodStatusSnapshot {
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }>;
  };
}

/**
 * Wait until the session Pod is Ready, failing early on conditions that cannot
 * recover.
 *
 * `kubectl wait --for=condition=Ready` would be shorter, but it cannot
 * distinguish "still starting" from "will never start": a mistyped image made
 * every provision hold for the full readiness timeout before reporting, so a
 * typo cost two minutes per attempt. Polling lets a terminal image or config
 * error surface in about a second with the kubelet's own reason attached.
 */
async function waitForPodReady({
  connection,
  namespace,
  podName,
  timeoutSeconds = READY_TIMEOUT_SECONDS,
  pollMs = 1000,
}: {
  connection: string[];
  namespace: string;
  podName: string;
  timeoutSeconds?: number;
  pollMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastReason = 'timed out waiting for the Ready condition';

  for (;;) {
    const result = await runKubectl(
      [...connection, 'get', 'pod', podName, '-n', namespace, '-o', 'json'],
      { timeout: 15_000 },
    );
    if (result.exitCode === 0) {
      let snapshot: PodStatusSnapshot | undefined;
      try {
        snapshot = JSON.parse(result.stdout) as PodStatusSnapshot;
      } catch {
        snapshot = undefined;
      }
      const status = snapshot?.status;
      if (status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')) {
        return { ok: true };
      }
      if (status?.phase === 'Failed') {
        return { ok: false, reason: `pod phase Failed${podFailureDetail(status)}` };
      }
      for (const container of status?.containerStatuses ?? []) {
        const waiting = container.state?.waiting;
        if (waiting?.reason && TERMINAL_WAITING_REASONS.has(waiting.reason)) {
          return {
            ok: false,
            reason: `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`,
          };
        }
        if (waiting?.reason) lastReason = `still waiting: ${waiting.reason}`;
      }
    } else {
      lastReason = errorText(result);
    }

    if (Date.now() + pollMs >= deadline) return { ok: false, reason: lastReason };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function podFailureDetail(status: NonNullable<PodStatusSnapshot['status']>): string {
  const condition = status.conditions?.find((c) => c.message || c.reason);
  if (!condition) return '';
  return ` (${condition.reason ?? 'unknown'}${condition.message ? `: ${condition.message}` : ''})`;
}

/**
 * Delete a session Pod, reporting failures.
 *
 * `SandboxLifecycle.cleanup` treats teardown as best-effort and swallows
 * errors, so a delete that never lands (RBAC denial, namespace already gone,
 * unreachable API server) would otherwise leave a Pod holding cluster
 * resources with nothing in the logs to explain it. Idempotency comes from
 * `--ignore-not-found`.
 */
async function deletePod({
  connection,
  namespace,
  podName,
  logger,
  reason,
}: {
  connection: string[];
  namespace: string;
  podName: string;
  logger?: KubernetesProviderLogger;
  reason: string;
}): Promise<void> {
  const result = await runKubectl(
    [
      ...connection,
      'delete',
      'pod',
      podName,
      '-n',
      namespace,
      '--force',
      '--grace-period=0',
      '--ignore-not-found',
      '--wait=false',
    ],
    { timeout: 30_000 },
  );
  if (result.exitCode !== 0) {
    logger?.warn('kubernetes sandbox: pod delete failed; it may still be consuming cluster resources', {
      pod: podName,
      namespace,
      reason,
      timed_out: result.timedOut,
      error: errorText(result),
    });
  }
}

// ============================================================
// Command construction
// ============================================================

/**
 * Build the full `kubectl exec` argv for a sandbox command.
 *
 * Exported and pure because this is the part most easily got wrong and the
 * hardest to check on a live cluster: flag order, the `--` separator that stops
 * kubectl from parsing the agent's command as its own flags, and the
 * in-container `cd` (kubectl exec has no working-directory flag, unlike
 * `docker exec -w`).
 *
 * Only the trailing shell string is interpreted by a shell — inside the
 * container. kubectl's own arguments are argv elements, never concatenated into
 * a host shell command.
 */
export function buildExecArgv({
  connection,
  namespace,
  podName,
  command,
  options,
}: {
  connection: string[];
  namespace: string;
  podName: string;
  command: string;
  options?: ExecOptions;
}): string[] {
  const workdir = options?.cwd ? resolveExecCwd(options.cwd) : WORKDIR;
  const envPrefix = options?.env
    ? Object.entries(options.env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}; `)
      .join('')
    : '';
  return [
    ...connection,
    'exec',
    '-n',
    namespace,
    podName,
    '--',
    '/bin/sh',
    '-c',
    `${envPrefix}cd ${shellQuote(workdir)} && ${command}`,
  ];
}

/** kubeconfig / context flags for a set of Kubernetes environment settings. */
export function buildConnectionArgs(
  settings: Pick<KubernetesEnvironmentConfig, 'kubeconfig' | 'context'>,
): string[] {
  return connectionArgs(settings);
}

// ============================================================
// Manifest & naming
// ============================================================

/**
 * Build the session Pod manifest.
 *
 * Exported so the exact object sent to the API server can be asserted in tests
 * and inspected by operators, rather than only being observable by watching a
 * live cluster.
 */
export function buildPodManifest({
  podName,
  namespace,
  sessionId,
  config,
  settings,
}: {
  podName: string;
  namespace: string;
  sessionId: string;
  config: EnvironmentConfig;
  settings: KubernetesEnvironmentConfig;
}): Record<string, unknown> {
  const limits: Record<string, string> = {};
  if (config.resources?.memory) limits.memory = config.resources.memory;
  if (config.resources?.cpu) limits.cpu = String(config.resources.cpu);

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace,
      labels: {
        ...sanitizeLabels(settings.labels),
        'app.kubernetes.io/managed-by': 'managed-agents',
        'managed-agents/session-id': labelValue(sessionId),
      },
    },
    spec: {
      restartPolicy: 'Never',
      // Without this, agent-authored commands can read the default
      // ServiceAccount token and call the Kubernetes API from inside the
      // sandbox. Only mount a token when an operator asked for one.
      automountServiceAccountToken: Boolean(settings.service_account),
      ...(settings.service_account ? { serviceAccountName: settings.service_account } : {}),
      containers: [
        {
          name: 'sandbox',
          image: config.image ?? DEFAULT_IMAGE,
          // Override the image entrypoint so the Pod is a plain command host
          // regardless of what the image declares.
          command: ['sleep'],
          args: ['infinity'],
          workingDir: WORKDIR,
          ...(Object.keys(limits).length > 0 ? { resources: { limits } } : {}),
        },
      ],
    },
  };
}

/**
 * Derive an RFC 1123 Pod name from a session id.
 *
 * Session ids contain characters Kubernetes rejects in object names (nanoid
 * emits `_`, `-`, and mixed case). Sanitizing alone could map two distinct
 * sessions onto one Pod name, so a short digest of the original id is appended
 * to keep the mapping injective.
 */
export function podNameForSession(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  const slug = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const name = slug ? `ma-${slug}-${digest}` : `ma-${digest}`;
  return name;
}

/**
 * Validate a configured namespace.
 *
 * A namespace reaches `kubectl` as an argv element, so it cannot inject a
 * shell command, but an invalid value would otherwise surface as an opaque
 * API-server rejection at provision time. Failing here names the constraint.
 */
export function resolveKubernetesNamespace(value: string | undefined): string {
  const namespace = value?.trim() || DEFAULT_NAMESPACE;
  if (!RFC1123_LABEL.test(namespace) || namespace.length > 63) {
    throw new Error(
      `Invalid Kubernetes namespace "${namespace}": expected a lowercase RFC 1123 label (a-z, 0-9, '-').`,
    );
  }
  return namespace;
}

/**
 * kubeconfig / context selection, shared by the availability probe and every
 * per-instance command so a session cannot silently drift to another cluster.
 */
function connectionArgs(settings: Pick<KubernetesEnvironmentConfig, 'kubeconfig' | 'context'>): string[] {
  const args: string[] = [];
  if (settings.kubeconfig?.trim()) args.push(`--kubeconfig=${settings.kubeconfig.trim()}`);
  if (settings.context?.trim()) args.push(`--context=${settings.context.trim()}`);
  return args;
}

/**
 * Keep only label entries Kubernetes will accept.
 *
 * An invalid key cannot be repaired without inventing a different label, so it
 * is dropped rather than passed through to fail as an opaque API-server
 * rejection at provision time. Values are coerced, since their character set is
 * narrower than the information they usually carry.
 */
function sanitizeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  if (!labels) return {};
  return Object.fromEntries(
    Object.entries(labels)
      .map(([key, value]) => [key.trim(), value] as const)
      .filter(([key]) => key.length > 0 && key.length <= 316 && LABEL_KEY.test(key))
      .map(([key, value]) => [key, labelValue(value)]),
  );
}

/** Label values allow alphanumerics, '-', '_', '.' and cap at 63 characters. */
function labelValue(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63);
}

// ============================================================
// Path & shell helpers
// ============================================================

/**
 * Resolve an agent-supplied file path to its absolute in-Pod location, confined
 * to the workspace.
 *
 * File tools take their path straight from model output, so `..` segments and
 * absolute paths must not reach outside `/workspace`. The container is the real
 * security boundary here, but the local provider enforces the same confinement
 * and the file tools should not mean three different things on three backends.
 */
export function resolveWorkspacePath(path: string): string {
  const resolved = posix.resolve(WORKDIR, path);
  if (resolved !== WORKDIR && !resolved.startsWith(`${WORKDIR}/`)) {
    throw new Error(`Path escapes sandbox workspace: ${path}`);
  }
  return resolved;
}

/**
 * Resolve a runtime-supplied working directory for `kubectl exec`.
 *
 * Unlike file-tool paths this is not agent input — it comes from the runtime's
 * own tool layer — so an absolute path outside the workspace is honored rather
 * than rejected.
 */
function resolveExecCwd(path: string): string {
  return posix.resolve(WORKDIR, path);
}

function parentDir(absolutePath: string): string {
  const index = absolutePath.lastIndexOf('/');
  return index <= 0 ? '/' : absolutePath.slice(0, index);
}

/**
 * Single-quote a value for the in-Pod `/bin/sh -c` string.
 *
 * Paths and env values reach the container through a shell command, so they
 * are quoted rather than interpolated raw. kubectl's own arguments never go
 * through a shell (spawn is called with an argv array), so they need no
 * quoting.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorText(result: { stderr?: string | null; stdout?: string | null }): string {
  return result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
}
