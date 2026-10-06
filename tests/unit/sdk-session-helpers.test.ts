/**
 * The session workflow helpers compose `client.sessions` primitives, so each
 * case drives them through a real `ManagedAgentsClient` with a stubbed fetch:
 * the wire requests are asserted, not just the composition — a helper that
 * asked for the wrong page cursor or resume header would still look correct at
 * the mock boundary.
 */

import { describe, expect, it, vi } from 'vitest';
import { ManagedAgentsClient } from '@/sdk/client.js';
import {
  collectReply,
  converse,
  followSession,
  inspectSession,
  sessionHistory,
} from '@/sdk/session-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

type RecordedCall = { url: string; method: string; headers: Headers; body?: unknown };

/** Route stubbed responses by method+path suffix and record every call. */
function stubFetch(
  routes: Array<{ match: (call: RecordedCall) => boolean; respond: (call: RecordedCall) => Response }>,
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find((candidate) => candidate.match(call));
    if (!route) throw new Error(`no stub for ${call.method} ${call.url}`);
    return route.respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function clientWith(fetchImpl: typeof fetch) {
  return new ManagedAgentsClient({ baseUrl: 'http://localhost:3000', fetch: fetchImpl });
}

describe('session helpers', () => {
  it('collectReply accumulates chunk deltas into the reply text', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        match: (c) => c.method === 'POST' && c.url.endsWith('/v1/sessions/sess_1/messages'),
        respond: () =>
          sseResponse([
            { type: 'agent.message_chunk', seq: 4, delta: 'Hel' },
            { type: 'agent.message_chunk', seq: 5, delta: 'lo ' },
            { type: 'agent.message_chunk', seq: 6, delta: 'there' },
            { type: 'session.status_idle', seq: 7 },
          ]),
      },
    ]);

    const reply = await collectReply(clientWith(fetchImpl).sessions, 'sess_1', 'hi');

    expect(reply.text).toBe('Hello there');
    expect(reply.events).toHaveLength(4);
    expect(calls[0]!.body).toMatchObject({ content: 'hi', stream: true });
  });

  it('sessionHistory walks next_page until the log is exhausted', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        match: (c) => c.method === 'GET' && c.url.includes('/v1/sessions/sess_1/events?'),
        respond: (c) =>
          c.url.includes('page=cursor_1')
            ? jsonResponse({ data: [{ type: 'b', seq: 2 }], prev_page: 'cursor_1', next_page: null })
            : jsonResponse({ data: [{ type: 'a', seq: 1 }], prev_page: null, next_page: 'cursor_1' }),
      },
    ]);

    const events = await sessionHistory(clientWith(fetchImpl).sessions, 'sess_1', { pageSize: 1 });

    expect(events.map((event) => event.type)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('page=cursor_1');
  });

  it('followSession yields the log, then resumes the live stream after the last seq', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        match: (c) => c.method === 'GET' && c.url.endsWith('/v1/sessions/sess_1/events?limit=1000'),
        respond: () => jsonResponse({
          data: [{ type: 'user.message', seq: 3 }, { type: 'agent.message', seq: 5 }],
          prev_page: null,
          next_page: null,
        }),
      },
      {
        match: (c) => c.method === 'GET' && c.url.endsWith('/v1/sessions/sess_1/events/stream'),
        respond: () => sseResponse([{ type: 'agent.message_chunk', seq: 6, delta: 'live' }]),
      },
    ]);

    const events = [];
    for await (const event of followSession(clientWith(fetchImpl).sessions, 'sess_1')) {
      events.push(event);
    }

    expect(events.map((event) => event.seq)).toEqual([3, 5, 6]);
    // The resume header carries the last recorded seq — that is the whole
    // contract: nothing after it in the log is replayed, nothing before it is
    // missed.
    expect(calls[1]!.headers.get('Last-Event-ID')).toBe('5');
  });

  it('followSession skips the log read when the caller names the resume cursor', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        match: (c) => c.url.endsWith('/v1/sessions/sess_1/events/stream'),
        respond: () => sseResponse([{ type: 'agent.message_chunk', seq: 8, delta: 'x' }]),
      },
    ]);

    const events = [];
    for await (const event of followSession(
      clientWith(fetchImpl).sessions,
      'sess_1',
      { lastEventId: '7' },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('Last-Event-ID')).toBe('7');
  });

  it('inspectSession returns the session and its full recorded log', async () => {
    const { fetchImpl } = stubFetch([
      {
        match: (c) => c.method === 'GET' && c.url.endsWith('/v1/sessions/sess_1'),
        respond: () => jsonResponse({ id: 'sess_1', type: 'session', status: 'idle' }),
      },
      {
        match: (c) => c.method === 'GET' && c.url.includes('/v1/sessions/sess_1/events'),
        respond: () => jsonResponse({ data: [{ type: 'a', seq: 1 }], prev_page: null, next_page: null }),
      },
    ]);

    const { session, events } = await inspectSession(clientWith(fetchImpl).sessions, 'sess_1');

    expect(session.id).toBe('sess_1');
    expect(events).toHaveLength(1);
  });

  it('converse creates the session, sends the message, and collects the reply', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        match: (c) => c.method === 'POST' && c.url.endsWith('/v1/sessions'),
        respond: () => jsonResponse({ id: 'sess_9', type: 'session' }, 201),
      },
      {
        match: (c) => c.method === 'POST' && c.url.endsWith('/v1/sessions/sess_9/messages'),
        respond: () => sseResponse([
          { type: 'agent.message_chunk', seq: 2, delta: 'done' },
          { type: 'session.status_idle', seq: 3 },
        ]),
      },
    ]);

    const { session, reply } = await converse(
      clientWith(fetchImpl).sessions,
      { agent: 'agent_x' } as Parameters<ManagedAgentsClient['sessions']['create']>[0],
      'hello',
    );

    expect(session.id).toBe('sess_9');
    expect(reply.text).toBe('done');
    expect(calls[0]!.url).toBe('http://localhost:3000/v1/sessions');
    expect(calls[1]!.url).toBe('http://localhost:3000/v1/sessions/sess_9/messages');
  });
});
