/**
 * Self-hosted environment worker: the machine-side half of the work queue.
 *
 * A worker claims work items from `POST /v1/x/worker/claim`, executes them inside
 * `--workdir`, and reports each result to `POST /v1/x/worker/complete`. The server
 * never runs them — this process does.
 *
 * Two invariants this file has to hold, neither of which it held before:
 *
 * 1. `complete` carries the same `worker_id` that `claim` sent. The route requires
 *    it (`src/api/routes/worker.ts:44`) and matches the row on it
 *    (`AND claimed_by = ?`), so a completion without it is a `400`: the work item's
 *    side effect has already happened and the row stays `claimed` forever.
 * 2. Options are validated before the loop starts. `setTimeout(fn, NaN)` fires
 *    immediately, so a malformed `--interval-ms` used to become a busy loop against
 *    the server instead of an error.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** Below this, polling a queue is indistinguishable from hammering the server. */
const MIN_POLL_INTERVAL_MS = 250;

const DEFAULT_POLL_INTERVAL_MS = 1000;

export type WorkerPollOptions = {
  port: string;
  apiKey?: string;
  environmentId?: string;
  environmentKey?: string;
  workerId?: string;
  workdir: string;
  once?: boolean;
  intervalMs?: string;
};

/** `WorkerPollOptions` with every default applied and every value checked. */
export type ResolvedWorkerPollOptions = {
  port: string;
  apiKey?: string;
  environmentId?: string;
  environmentKey?: string;
  workerId: string;
  root: string;
  once: boolean;
  intervalMs: number;
};

/**
 * Validate the worker's options and resolve the defaults.
 *
 * Throws rather than coercing. A worker is a long-running process that executes
 * commands on someone's machine, so an option it cannot honour has to stop it at
 * startup, where the operator is still reading, instead of degrading into a loop
 * that runs wrong — and an unparseable interval degrades into the worst of them, a
 * loop with no delay at all.
 */
export function resolveWorkerPollOptions(opts: WorkerPollOptions): ResolvedWorkerPollOptions {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value "${opts.port}". Expected an integer between 1 and 65535.`);
  }

  const intervalMs = Number(opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `Invalid --interval-ms value "${opts.intervalMs}". Expected a number of at least ${MIN_POLL_INTERVAL_MS}.`,
    );
  }

  return {
    port: String(port),
    apiKey: opts.apiKey,
    environmentId: opts.environmentId,
    environmentKey: opts.environmentKey,
    workerId: opts.workerId ?? `worker_${process.pid}`,
    root: resolve(opts.workdir),
    once: opts.once === true,
    intervalMs,
  };
}

type WorkerItem = {
  id: string;
  sessionId?: string;
  session_id?: string;
  kind: 'exec' | 'read' | 'write' | 'list';
  payload: Record<string, unknown>;
};

export async function workerPollCommand(opts: WorkerPollOptions) {
  const config = resolveWorkerPollOptions(opts);
  console.log(`Polling self-hosted work as ${config.workerId} in ${config.root}`);
  for (;;) {
    const item = await claimWorkItem(config);
    if (item) {
      try {
        await completeWorkItem(config, item, { status: 'fulfilled', value: await executeWorkItem(item, config.root) });
      } catch (error) {
        await completeWorkItem(config, item, { status: 'rejected', reason: error });
      }
      console.log(`completed ${item.id}`);
    } else if (config.once) {
      console.log('no work');
      return;
    }
    if (config.once) return;
    await sleep(config.intervalMs);
  }
}

export async function executeWorkItem(item: WorkerItem, root: string): Promise<unknown> {
  if (item.kind === 'read') {
    return readFile(safePath(root, stringPayload(item.payload.path, 'path')), 'utf8');
  }
  if (item.kind === 'write') {
    const target = safePath(root, stringPayload(item.payload.path, 'path'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, String(item.payload.content ?? ''), 'utf8');
    return { ok: true };
  }
  if (item.kind === 'list') {
    return readdir(safePath(root, stringPayload(item.payload.path ?? '.', 'path')));
  }
  if (item.kind === 'exec') {
    return execShell(String(item.payload.command ?? ''), {
      cwd: item.payload.cwd ? safePath(root, String(item.payload.cwd)) : root,
      timeoutMs: typeof item.payload.timeout === 'number' ? item.payload.timeout : 300_000,
      env: objectOfStrings(item.payload.env),
    });
  }
  throw new Error(`Unsupported work item kind: ${item.kind}`);
}

async function claimWorkItem(opts: ResolvedWorkerPollOptions): Promise<WorkerItem | null> {
  const res = await fetch(`http://localhost:${opts.port}/v1/x/worker/claim`, {
    method: 'POST',
    headers: jsonHeaders(opts),
    body: JSON.stringify({
      worker_id: opts.workerId,
      environment_id: opts.environmentId,
      environment_key: opts.environmentKey ?? process.env.MANAGED_AGENTS_ENVIRONMENT_KEY,
    }),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`worker claim failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<WorkerItem>;
}

async function completeWorkItem(
  opts: ResolvedWorkerPollOptions,
  item: WorkerItem,
  resultOrError: PromiseSettledResult<unknown>,
) {
  // `worker_id` is required by the route and is what the row is matched on, so it
  // has to be the same identity `claim` sent. Omitting it answered
  // `400 id and worker_id are required` after the work had already been executed,
  // leaving the row `claimed` with its side effect applied.
  const body = resultOrError.status === 'fulfilled'
    ? { id: item.id, worker_id: opts.workerId, result: resultOrError.value }
    : { id: item.id, worker_id: opts.workerId, result: { message: resultOrError.reason instanceof Error ? resultOrError.reason.message : String(resultOrError.reason) }, failed: true };
  const res = await fetch(`http://localhost:${opts.port}/v1/x/worker/complete`, {
    method: 'POST',
    headers: jsonHeaders(opts),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`worker complete failed: ${res.status} ${await res.text()}`);
}

async function execShell(command: string, opts: { cwd: string; timeoutMs: number; env: Record<string, string> }) {
  if (!command.trim()) throw new Error('exec work item requires command');
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-lc', command], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      env: { ...process.env, ...opts.env },
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : 0,
        stdout,
        stderr,
        timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
      });
    });
  });
}

function safePath(root: string, value: string): string {
  const target = resolve(root, isAbsolute(value) ? `.${value}` : value);
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return target;
  throw new Error(`Path escapes worker root: ${value}`);
}

function stringPayload(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${name} is required`);
}

function objectOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
}

function jsonHeaders(opts: ResolvedWorkerPollOptions): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
