/**
 * Session workflow helpers — the create → message → stream → inspect loop every
 * client rewrites, built on `client.sessions` primitives.
 *
 * Each helper takes the sessions resource rather than the whole client, so a
 * caller (or a test) only needs the routes the helper actually touches.
 */

import type { ManagedAgentsClient, SessionSummary, StreamedEvent } from './client.js';

/** The sessions surface the helpers consume (`client.sessions` satisfies it). */
export type SessionsApi = ManagedAgentsClient['sessions'];

export type CreateSessionInput = Parameters<SessionsApi['create']>[0];

export type CollectedReply = {
  /** Concatenated `agent.message_chunk` deltas — the reply a terminal prints. */
  text: string;
  /** Every event the streamed turn produced, in stream order. */
  events: StreamedEvent[];
};

/**
 * Send a message and collect the streamed turn. Returns when the turn ends
 * (idle or terminated) with the reply text and the full event list.
 */
export async function collectReply(
  sessions: SessionsApi,
  sessionId: string,
  text: string,
): Promise<CollectedReply> {
  const events: StreamedEvent[] = [];
  let reply = '';
  for await (const event of sessions.chat(sessionId, text)) {
    events.push(event);
    if (event.type === 'agent.message_chunk' && event.delta) reply += event.delta;
  }
  return { text: reply, events };
}

/**
 * The whole recorded event log, paginated through `next_page` until the server
 * says there is no more. `pageSize` is the per-request limit, not a cap on the
 * result.
 */
export async function sessionHistory(
  sessions: SessionsApi,
  sessionId: string,
  opts?: { pageSize?: number },
): Promise<StreamedEvent[]> {
  const events: StreamedEvent[] = [];
  let page: string | undefined;
  do {
    const result = await sessions.events(sessionId, { limit: opts?.pageSize ?? 1000, page });
    events.push(...result.data);
    page = result.next_page ?? undefined;
  } while (page !== undefined);
  return events;
}

/**
 * Follow a session: yield the recorded log first, then the live stream resumed
 * after the last recorded `seq` — nothing missed, nothing yielded twice. A
 * stream opened without a cursor carries live events only, which is why the log
 * is read first; pass `lastEventId` to skip that read when the caller already
 * knows where to resume.
 */
export async function* followSession(
  sessions: SessionsApi,
  sessionId: string,
  opts?: { pageSize?: number; lastEventId?: string },
): AsyncIterable<StreamedEvent> {
  let resumeFrom = opts?.lastEventId;
  if (resumeFrom === undefined) {
    let lastSeq = 0;
    for (const event of await sessionHistory(sessions, sessionId, opts)) {
      if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq;
      yield event;
    }
    resumeFrom = String(lastSeq);
  }
  yield* sessions.tail(sessionId, { lastEventId: resumeFrom });
}

/** A session digest: the summary plus its full recorded log. */
export async function inspectSession(
  sessions: SessionsApi,
  sessionId: string,
): Promise<{ session: SessionSummary; events: StreamedEvent[] }> {
  const [session, events] = await Promise.all([
    sessions.get(sessionId),
    sessionHistory(sessions, sessionId),
  ]);
  return { session, events };
}

/**
 * Create a session, send it one message, and collect the streamed reply — the
 * whole loop in one call for the callers that want exactly that.
 */
export async function converse(
  sessions: SessionsApi,
  input: CreateSessionInput,
  text: string,
): Promise<{ session: SessionSummary; reply: CollectedReply }> {
  const session = await sessions.create(input);
  const reply = await collectReply(sessions, session.id, text);
  return { session, reply };
}
