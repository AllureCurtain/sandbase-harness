/**
 * `GET /v1/sessions/:id/threads*` end to end, through the official SDK.
 *
 * PR 3.1 scope is the primary thread: `threads.list` answers one row whose
 * `parent_thread_id` is null, `threads.retrieve` the same row, and
 * `threads.events.list`/`threads.events.stream` the same log the session-level
 * routes publish — plus the `session.thread_status_*` events the thread model
 * adds around the lifecycle events a session already emitted.
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK sessions.threads over HTTP', () => {
  it('lists, retrieves, and streams the primary thread', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      // `authToken: null` keeps a developer-shell ANTHROPIC_AUTH_TOKEN from
      // adding a second credential source — the server refuses ambiguous
      // credentials (401) even with auth disabled.
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', authToken: null, maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
      });
      // Drive one turn so the thread has run and its status events exist.
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
      });
      // Wait for the turn's closing `session.status_idle` before asserting the
      // log: a created session projects `queued` as `idle` too, so the object
      // status cannot tell "not started" from "finished".
      const deadline = Date.now() + 60_000;
      let settled = false;
      while (!settled && Date.now() < deadline) {
        const page = await client.beta.sessions.events.list(session.id, { limit: 100 });
        settled = page.data.some((event) => event.type === 'session.status_idle');
        if (!settled) await new Promise((r) => setTimeout(r, 250));
      }
      expect(settled).toBe(true);

      // `threads.list` — exactly one thread, the primary.
      const listed = await client.beta.sessions.threads.list(session.id);
      expect(listed.data).toHaveLength(1);
      const primary = listed.data[0]!;
      expect(primary.type).toBe('session_thread');
      expect(primary.session_id).toBe(session.id);
      expect(primary.parent_thread_id).toBeNull();
      expect(primary.status).toBe('idle');
      expect(primary.agent.type).toBe('agent');

      // `threads.retrieve` — the same row.
      const retrieved = await client.beta.sessions.threads.retrieve(primary.id, { session_id: session.id });
      expect(retrieved.id).toBe(primary.id);
      expect(retrieved.parent_thread_id).toBeNull();
      expect(retrieved.agent.type).toBe('agent');

      // `threads.events.list` — the thread's own log. A single-agent session's
      // primary stream is its whole log, and it contains the thread-status
      // events the lifecycle now emits.
      const events: Array<{ type: string; session_thread_id?: string | null }> = [];
      for await (const event of client.beta.sessions.threads.events.list(primary.id, { session_id: session.id })) {
        events.push(event as { type: string; session_thread_id?: string | null });
      }
      const types = events.map((e) => e.type);
      expect(types).toContain('session.thread_status_running');
      expect(types).toContain('session.thread_status_idle');
      expect(types).toContain('session.status_running');
      expect(types).toContain('session.status_idle');
      const running = events.find((e) => e.type === 'session.thread_status_running')!;
      expect(running.session_thread_id).toBe(primary.id);

      // The session-level events route and the thread's own route agree on a
      // single-thread session.
      const sessionEvents: Array<{ type: string }> = [];
      for await (const event of client.beta.sessions.events.list(session.id)) {
        sessionEvents.push(event as { type: string });
      }
      expect(types).toEqual(sessionEvents.map((e) => e.type));

      // `threads.events.stream` — a live connection on the thread's own
      // stream. Send a second message while subscribed; the turn's
      // `session.thread_status_running` arrives addressed to this thread.
      const stream = await client.beta.sessions.threads.events.stream(primary.id, { session_id: session.id });
      const received: Array<{ type: string; session_thread_id?: string | null }> = [];
      const gotRunning = (async () => {
        for await (const event of stream) {
          const e = event as { type: string; session_thread_id?: string | null };
          received.push(e);
          if (e.type === 'session.thread_status_running' && e.session_thread_id === primary.id) {
            return;
          }
        }
        throw new Error('thread stream ended before thread_status_running arrived');
      })();
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'again' }] }],
      });
      await gotRunning;
      stream.controller.abort();
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 180_000);
});
