/**
 * Integration test: the documented `managed-agents worker poll` works end to end.
 *
 * The self-hosted worker CLI is documented in `docs/deployment.md:234`, `docs/api.md`,
 * `docs/api-matrix.md` (twice) and the Console's environment setup step, and ticked off
 * in `docs/spec/tasks.md:84` — while `workerPollCommand` was never registered, so the
 * documented command answered `unknown command 'worker'`.
 *
 * Registering it was not sufficient. `POST /v1/x/worker/complete` requires `worker_id`
 * (`src/api/routes/worker.ts:44`) and matches the row on it, and the command never sent
 * it: the first claimed item would have been executed on the worker and then left
 * `claimed`, with the completion answering `400`. The round trip below is what makes
 * that observable, so it runs against the **real** `workerRoutes` app over a real HTTP
 * listener and the **real** `WorkQueue` — a fetch stub or a mocked route would agree
 * with whatever the command happened to send.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { resolveWorkerPollOptions, workerPollCommand } from '@/cli/worker-commands.js';

/** Run `fn` with `console.log` captured, so the poller's output stays out of the report. */
async function withCapturedLog<T>(fn: () => Promise<T>): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  try {
    await fn();
  } finally {
    log.mockRestore();
  }
  return lines;
}

describe('worker poll CLI', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: { close: (cb?: () => void) => void } | undefined;

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  /** A real runtime on a real port, with the real work queue behind the real routes. */
  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-worker-poll-'));
    tmpDir = dir;
    db = new Database(join(dir, 'test.db'));
    db.runMigrations();
    const queue = new WorkQueue(db);
    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workQueue: queue,
    });

    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as { close: (cb?: () => void) => void };
        resolve(info.port);
      });
    });

    const workdir = join(dir, 'work');
    mkdirSync(workdir, { recursive: true });
    return { queue, port, workdir };
  }

  it('claims, executes and completes a work item over the real routes', async () => {
    const { queue, port, workdir } = await startRuntime();
    writeFileSync(join(workdir, 'greeting.txt'), 'hello from the worker', 'utf8');

    const id = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });
    expect(queue.get(id)!.status).toBe('pending');

    const lines = await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));

    // The row is read back from SQLite, so this asserts the runtime accepted the
    // completion rather than that the command returned without throwing. Without
    // `worker_id` on `complete` the row stays `claimed` and the command throws.
    const item = queue.get(id)!;
    expect(item.status).toBe('done');
    expect(item.claimedBy).toBe('worker_test');
    expect(item.result).toBe('hello from the worker');
    expect(lines.join('\n')).toContain(`completed ${id}`);
  });

  it('reports a failed work item as failed instead of losing it', async () => {
    // The rejection path is the other half of the same completion call and needs
    // `worker_id` too: the item must end `failed`, not `claimed`.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'read', { path: 'does-not-exist.txt' });

    await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));

    const item = queue.get(id)!;
    expect(item.status).toBe('failed');
    expect(JSON.stringify(item.result)).toContain('does-not-exist.txt');
  });

  it('reports no work and exits when the queue is empty', async () => {
    const { port, workdir } = await startRuntime();

    const lines = await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true }));

    expect(lines.join('\n')).toContain('no work');
  });

  it('does not take work belonging to another environment', async () => {
    // `--environment-id` is passed through to the claim, so a worker pointed at an
    // environment with no pending work must leave the other environment's item alone.
    const { queue, port, workdir } = await startRuntime();
    db!.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db!.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db!.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    db!.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_b', 'agent_x', 'x', 'env_b')").run();
    const id = queue.enqueue('sess_b', 'read', { path: 'greeting.txt' });

    await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true, environmentId: 'env_a' }));

    expect(queue.get(id)!.status).toBe('pending');
  });

  it('refuses an unusable --interval-ms instead of polling with no delay', () => {
    // `Number('abc')` is NaN and `setTimeout(fn, NaN)` fires immediately, so the old
    // `Math.max(250, Number(...))` produced a busy loop against the server rather than
    // an error. It has to be rejected before the loop starts.
    for (const bad of ['abc', '', 'NaN', '-1', '0', '249']) {
      expect(() => resolveWorkerPollOptions({ port: '3000', workdir: '.', intervalMs: bad }))
        .toThrow(/interval-ms/);
    }
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', intervalMs: '1000' }).intervalMs).toBe(1000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).intervalMs).toBe(1000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', intervalMs: '250' }).intervalMs).toBe(250);
  });

  it('refuses an unusable --port', () => {
    for (const bad of ['abc', '', '0', '65536', '3000.5', '-1']) {
      expect(() => resolveWorkerPollOptions({ port: bad, workdir: '.' })).toThrow(/port/);
    }
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).port).toBe('3000');
  });
});
