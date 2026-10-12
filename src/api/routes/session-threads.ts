/**
 * Session Thread Routes
 *
 * Mounted under `/v1/sessions`:
 *
 *   GET /:id/threads               — every thread of the session, primary first
 *   GET /:id/threads/:tid          — one thread object
 *   GET /:id/threads/:tid/events   — the thread's own event log page
 *   GET /:id/threads/:tid/stream   — the thread's SSE stream
 *
 * The session-level routes already publish the *primary* stream: this file is
 * the read surface for the threads themselves. The envelope, cursor, and SSE
 * behaviour deliberately mirror `GET /:id/events` and `GET /:id/events/stream`
 * — a client that can page one log can page the other.
 */

import { Hono } from 'hono';
import type { SessionEvent, SessionStatus } from '@/types/session.js';
import type { SessionThread } from '@/core/session/session-threads.js';
import { activeSecondsFromTicks, type ActiveStatusTick } from '@/core/session/session-usage.js';
import { cursorPageOf, cursorQueryMismatch, decodeCursor, encodeCursor, toApiEvent, toApiThread } from '../standard.js';
import type { ServerDeps } from '../server.js';
import { eventStreamHandler, threadStreamMembership } from './stream.js';
import { rejectUnexpectedQueryParams } from './query-params.js';

/** The order thread events page in — the same append order the session log uses. */
const EVENTS_LIST_ORDER = 'events.appended ASC';

/**
 * Map a thread's own `session.thread_status_*` rows onto the session-level
 * interval names `activeSecondsFromTicks` already pairs, so one derivation
 * measures a thread's running time the same way it measures a session's.
 */
function threadActiveSeconds(events: readonly SessionEvent[], now: Date = new Date()): number {
  const ticks: ActiveStatusTick[] = [];
  for (const event of events) {
    const remapped =
      event.type === 'session.thread_status_running' ? 'session.status_running'
      : event.type === 'session.thread_status_idle' ? 'session.status_idle'
      : event.type === 'session.thread_status_terminated' ? 'session.status_terminated'
      : undefined;
    if (!remapped) continue;
    ticks.push({ type: remapped, processedAt: event.processedAt, createdAt: event.createdAt });
  }
  return activeSecondsFromTicks(ticks, now);
}

/**
 * Read a thread that belongs to the session, or report the failure shape the
 * route answers with. `undefined` means the handler already wrote a response.
 */
function threadFor(
  deps: ServerDeps,
  sessionId: string,
  threadId: string,
): { thread?: SessionThread; error?: { status: 404; body: object } } {
  const thread = deps.sessionManager.getThreadStore().get(threadId);
  if (!thread || thread.sessionId !== sessionId) {
    return { error: { status: 404, body: { error: { type: 'not_found', message: 'Thread not found' } } } };
  }
  return { thread };
}

export function sessionThreadsRoutes(deps: ServerDeps) {
  const app = new Hono();
  const { sessionManager } = deps;

  const threadDerived = (thread: SessionThread) => ({
    activeSeconds: threadActiveSeconds(
      sessionManager.getEventLogger().getThreadEvents(thread.sessionId, thread.id),
    ),
  });

  // GET /:id/threads — the session's threads: primary first, children in
  // creation order, archived rows included. The list takes only pagination
  // params — there is nothing to filter a one-owner collection by.
  app.get('/:id/threads', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['limit', 'page']);
    if (rejected) return rejected;
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }

    const rawLimit = parseInt(c.req.query('limit') ?? '1000', 10) || 1000;
    const limit = Math.min(1000, Math.max(1, rawLimit));

    const cursorState = { order: 'threads.created ASC', filter: { session_id: sessionId } };
    let afterId: string | undefined;
    let fromCursor = false;
    const rawPage = c.req.query('page');
    if (rawPage !== undefined) {
      const decoded = decodeCursor(rawPage);
      if (!decoded.ok || typeof decoded.state?.after_id !== 'string') {
        return c.json({
          error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' },
        }, 400);
      }
      const mismatch = cursorQueryMismatch(decoded.state, cursorState);
      if (mismatch) {
        return c.json({ error: { type: 'invalid_request_error', message: mismatch } }, 400);
      }
      afterId = decoded.state.after_id as string;
      fromCursor = true;
    }

    const threads = sessionManager.getThreadStore().listBySession(sessionId);
    const start = afterId ? threads.findIndex((t) => t.id === afterId) + 1 : 0;
    if (fromCursor && start === 0) {
      return c.json({
        error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' },
      }, 400);
    }
    const page = threads.slice(start, start + limit);
    const last = page[page.length - 1];
    return c.json(cursorPageOf(page.map((t) => toApiThread(t, threadDerived(t))), {
      prev: null,
      next: start + page.length < threads.length && last
        ? encodeCursor({ ...cursorState, after_id: last.id })
        : null,
    }));
  });

  // GET /:id/threads/:tid — one thread object.
  app.get('/:id/threads/:tid', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, []);
    if (rejected) return rejected;
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    const { thread, error } = threadFor(deps, sessionId, c.req.param('tid'));
    if (error) return c.json(error.body, error.status);
    return c.json(toApiThread(thread!, threadDerived(thread!)));
  });

  // GET /:id/threads/:tid/events — the thread's own log page, same envelope
  // and cursor discipline as the session-level events route.
  app.get('/:id/threads/:tid/events', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['limit', 'after_id', 'page']);
    if (rejected) return rejected;
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    const { thread, error } = threadFor(deps, sessionId, c.req.param('tid'));
    if (error) return c.json(error.body, error.status);

    const rawLimit = parseInt(c.req.query('limit') ?? '1000', 10) || 1000;
    const limit = Math.min(1000, Math.max(1, rawLimit));

    const cursorState = { order: EVENTS_LIST_ORDER, filter: { session_id: sessionId, thread_id: thread!.id } };
    let afterId = c.req.query('after_id');
    let fromCursor = false;
    const rawPage = c.req.query('page');
    if (rawPage !== undefined) {
      const decoded = decodeCursor(rawPage);
      if (!decoded.ok || typeof decoded.state?.after_id !== 'string') {
        return c.json({
          error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' },
        }, 400);
      }
      const mismatch = cursorQueryMismatch(decoded.state, cursorState);
      if (mismatch) {
        return c.json({ error: { type: 'invalid_request_error', message: mismatch } }, 400);
      }
      afterId = decoded.state.after_id as string;
      fromCursor = true;
    }

    const allEvents = sessionManager.getEventLogger().getThreadEvents(sessionId, thread!.id);
    const start = afterId ? allEvents.findIndex((event) => event.id === afterId) + 1 : 0;
    if (fromCursor && start === 0) {
      return c.json({
        error: { type: 'invalid_request_error', message: 'page must be a cursor returned by this endpoint' },
      }, 400);
    }
    const events = start > 0 ? allEvents.slice(start) : allEvents;
    const limited = events.slice(0, limit);

    const last = limited[limited.length - 1];
    return c.json(cursorPageOf(limited.map((event) => toApiEvent(event, { streamThreadId: thread!.id })), {
      prev: null,
      next: events.length > limited.length && last
        ? encodeCursor({ ...cursorState, after_id: last.id })
        : null,
    }));
  });

  // GET /:id/threads/:tid/stream — the thread's own SSE. Same resume and
  // event_deltas[] contract as the session-level stream; only the membership
  // differs.
  app.get('/:id/threads/:tid/stream', (c) => {
    const sessionId = c.req.param('id');
    if (!sessionManager.get(sessionId)) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }
    const { thread, error } = threadFor(deps, sessionId, c.req.param('tid'));
    if (error) return c.json(error.body, error.status);
    return eventStreamHandler(deps, sessionId, threadStreamMembership(deps, sessionId, thread!.id))(c);
  });

  return app;
}
