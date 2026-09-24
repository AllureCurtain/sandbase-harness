/**
 * `event_deltas[]` at the route boundary.
 *
 * `tests/unit/event-deltas.test.ts` proves the parser and the projector behave.
 * It cannot prove the route rejects a bad request *before* the stream opens: a
 * 400 delivered on an established event stream is an error frame a client has to
 * already be listening for, which is not what the contract promises. These tests
 * call the route directly and assert on the response itself.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { streamRoutes } from '@/api/routes/stream.js';
import type { ServerDeps } from '@/api/server.js';
import type { SessionEvent } from '@/types/session.js';

const SESSION_ID = 'sess_stream';

/**
 * Minimal deps for the stream route: it reads the session, subscribes, and
 * backfills from the event logger. Nothing else on the server is involved.
 */
function streamApp(events: SessionEvent[] = []) {
  const sessionManager = {
    get: (id: string) => (id === SESSION_ID ? { id, status: 'idle' } : undefined),
    subscribe: () => () => {},
    getEventLogger: () => ({ getEvents: () => events }),
  };
  const app = new Hono();
  app.route('/v1/sessions', streamRoutes({ sessionManager } as unknown as ServerDeps));
  return app;
}

/** Read a completed response body and release the stream. */
async function read(response: Response) {
  const body = await response.text().catch(() => '');
  await response.body?.cancel().catch(() => {});
  return { status: response.status, contentType: response.headers.get('content-type'), body };
}

/**
 * Inspect a response that is expected to stay open.
 *
 * An event-stream body never ends, so reading it would hang the test. Only the
 * status line and headers are observed, and the body is released immediately.
 */
async function headers(response: Response) {
  const result = {
    status: response.status,
    contentType: response.headers.get('content-type'),
  };
  await response.body?.cancel().catch(() => {});
  return result;
}

describe('event_deltas[] route boundary', () => {
  it('rejects an unsupported value with a 400 JSON body before opening a stream', async () => {
    const response = await streamApp().request(
      `/v1/sessions/${SESSION_ID}/events/stream?event_deltas[]=agent.tool_use`,
    );
    const result = await read(response);

    expect(result.status).toBe(400);
    expect(result.contentType).toContain('application/json');
    expect(JSON.parse(result.body).error.type).toBe('invalid_request_error');
  });

  it('rejects an empty value rather than treating it as no previews', async () => {
    const response = await streamApp().request(
      `/v1/sessions/${SESSION_ID}/events/stream?event_deltas[]=`,
    );
    expect((await read(response)).status).toBe(400);
  });

  it('rejects a request over the published cap', async () => {
    const over = Array.from({ length: 101 }, () => 'event_deltas[]=agent.message').join('&');
    const response = await streamApp().request(`/v1/sessions/${SESSION_ID}/events/stream?${over}`);
    expect((await read(response)).status).toBe(400);
  });

  it('opens an event stream for exactly the published cap', async () => {
    const atCap = Array.from({ length: 100 }, () => 'event_deltas[]=agent.message').join('&');
    const response = await streamApp().request(`/v1/sessions/${SESSION_ID}/events/stream?${atCap}`);
    const result = await headers(response);

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/event-stream');
  });

  it('opens an event stream when no preview is requested', async () => {
    const response = await streamApp().request(`/v1/sessions/${SESSION_ID}/events/stream`);
    const result = await headers(response);

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/event-stream');
  });
});
